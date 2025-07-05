import { Fuse, localforage } from '../lib.js';
import { chat_metadata, eventSource, event_types, generateQuietPrompt, getCurrentChatId, getRequestHeaders, saveSettingsDebounced } from '../script.js';
import { openThirdPartyExtensionMenu, saveMetadataDebounced } from './extensions.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { flashHighlight, stringFormat, debounce, createThumbnail, getBase64Async } from './utils.js';
import { t, translate } from './i18n.js';
import { Popup } from './popup.js';

const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_PIXEL_BLOB = new Blob([Uint8Array.from(atob(PNG_PIXEL), c => c.charCodeAt(0))], { type: 'image/png' });

const THUMBNAIL_STORAGE = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });
const THUMBNAIL_BLOBS = new Map();
const STARRED_BG_STORAGE = localforage.createInstance({ name: 'SillyTavern_StarredBackgrounds' });
let starredBackgrounds = new Set();

let THUMBNAIL_CONFIG = {
    width: 160,
    height: 90,
};

let galleryObserver = null;
let backgroundSelector = null;
let isGalleryVisible = false;

const BG_METADATA_KEY = 'custom_background';
const LIST_METADATA_KEY = 'chat_backgrounds';

async function loadStarredBackgrounds() {
    const stored = await STARRED_BG_STORAGE.getItem('starred_list');
    if (stored) {
        starredBackgrounds = new Set(stored);
    } else {
        starredBackgrounds = new Set();
    }
}

async function saveStarredBackgrounds() {
    await STARRED_BG_STORAGE.setItem('starred_list', Array.from(starredBackgrounds));
}

function isBackgroundStarred(filename) {
    return starredBackgrounds.has(filename);
}

async function toggleStarredBackground(filename) {
    const isCurrentlyStarred = starredBackgrounds.has(filename);
    if (isCurrentlyStarred) {
        starredBackgrounds.delete(filename);
    } else {
        starredBackgrounds.add(filename);
    }
    await saveStarredBackgrounds();

    // Update the master image data
    const imgDataToUpdate = backgroundSelector.images.find(img => img.filename === filename);
    if (imgDataToUpdate) {
        imgDataToUpdate.isStarred = !isCurrentlyStarred;
    }

    // The search method will detect the starring change and clear caches automatically
    const currentFilter = $('#bg-filter').val() || '';
    backgroundSelector.search(currentFilter);
}

function getBackgroundPath(fileUrl) {
    return `backgrounds/${encodeURIComponent(fileUrl)}`;
}

function generateUrlParameter(bg, isCustom) {
    return isCustom ? `url("${encodeURI(bg)}")` : `url("${getBackgroundPath(bg)}")`;
}

function getUrlParameter(element) {
    const $this = $(element);
    const isCustom = $this.attr('custom') === 'true';
    const url = $this.data('url');
    return generateUrlParameter(url, isCustom);
}

export let background_settings = {
    name: '__transparent.png',
    url: generateUrlParameter('__transparent.png', false),
    fitting: 'classic',
    animation: false,
};

function getGalleryScrollState() {
    try {
        const savedState = sessionStorage.getItem('galleryScrollState');
        return savedState ? JSON.parse(savedState) : {
            top: 0,
            fraction: 0,
            filter: '',
        };
    } catch (e) {
        console.error('Failed to parse gallery scroll state:', e);
        return { top: 0, fraction: 0, filter: '' };
    }
}

function setGalleryScrollState(newState) {
    sessionStorage.setItem('galleryScrollState', JSON.stringify(newState));
}

// Client-side thumbnail generation function
async function getThumbnailFromStorage(bg) {
    const cachedBlobUrl = THUMBNAIL_BLOBS.get(bg);
    if (cachedBlobUrl) {
        return cachedBlobUrl;
    }

    const savedBlob = await THUMBNAIL_STORAGE.getItem(bg);
    if (savedBlob) {
        const savedBlobUrl = URL.createObjectURL(savedBlob);
        THUMBNAIL_BLOBS.set(bg, savedBlobUrl);
        return savedBlobUrl;
    }

    try {
        const response = await fetch(getBackgroundPath(bg), { cache: 'force-cache' });
        if (!response.ok) {
            throw new Error('Fetch failed with status: ' + response.status);
        }
        const imageBlob = await response.blob();
        const imageBase64 = await getBase64Async(imageBlob);
        const thumbnailBase64 = await createThumbnail(imageBase64, THUMBNAIL_CONFIG.width, THUMBNAIL_CONFIG.height);
        const thumbnailBlob = await fetch(thumbnailBase64).then(res => res.blob());
        await THUMBNAIL_STORAGE.setItem(bg, thumbnailBlob);
        const blobUrl = URL.createObjectURL(thumbnailBlob);
        THUMBNAIL_BLOBS.set(bg, blobUrl);
        return blobUrl;
    } catch (error) {
        console.error('Error fetching thumbnail, fallback image will be used:', error);
        const fallbackBlobUrl = URL.createObjectURL(PNG_PIXEL_BLOB);
        THUMBNAIL_BLOBS.set(bg, fallbackBlobUrl);
        return fallbackBlobUrl;
    }
}

class BackgroundSelector {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.images = [];
        this.filteredImages = [];
        this.currentIndex = 0;
        this.scrollerElement = document.getElementById('bg-scrollable-content');
        this.isLoading = false;
        this.columns = [];
        this.imageCounter = 0;
        this.currentColumnCount = 0;
        this.isRestoring = false;
        this._hasRestored = false;
        this.scrollBtn = null;
        this.handleScrollDebounced = null;
        this.handleResizeDebounced = null;
        this.drawerElement = document.getElementById('Backgrounds');
        this.setupDropToUpload();

        // Simple debounced search for user input
        this.debouncedSearch = debounce((query) => {
            this.search(query);
        }, 200);

        const debouncedLayout = debounce(() => {
            if (this.currentColumnCount !== this._getColumnsForWidth()) {
                this.resetAndLoad();
            }
        }, 150);
        const resizeObserver = new ResizeObserver(debouncedLayout);
        resizeObserver.observe(this.container);
    }

    _getColumnsForWidth() {
        const width = this.container.offsetWidth;

        if (width > 2400) return 10;
        if (width > 2000) return 8;
        if (width > 1600) return 7;
        if (width > 1200) return 6;
        if (width > 900) return 5;
        return 4;
    }

    setupColumns() {
        const requiredColumns = this._getColumnsForWidth();

        // Remove existing masonry container if present
        const existingContainer = this.container.querySelector('#masonry-container');
        if (existingContainer) {
            existingContainer.remove();
        }

        // Create new masonry container
        const masonryContainer = document.createElement('div');
        masonryContainer.id = 'masonry-container';
        this.container.appendChild(masonryContainer);

        this.columns = [];
        this.currentColumnCount = requiredColumns;

        for (let i = 0; i < requiredColumns; i++) {
            const column = document.createElement('div');
            column.className = 'masonry-column';
            masonryContainer.appendChild(column);
            this.columns.push(column);
        }

        this.ensureScrollTopButton();

        // Ensure ResizeObserver is working
        this.setupResizeObserver();
    }

    setupResizeObserver() {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }

        const debouncedLayout = debounce(() => {
            const currentColumns = this.currentColumnCount;
            const requiredColumns = this._getColumnsForWidth();

            if (currentColumns !== requiredColumns) {
                this.resetAndLoad();
            }
        }, 150);

        this.resizeObserver = new ResizeObserver(debouncedLayout);
        this.resizeObserver.observe(this.container);
    }

    search(query) {
        const lowerQuery = query.toLowerCase().trim();
        let sortedImages = [];

        if (lowerQuery) {
            const fuse = new Fuse(this.images, {
                keys: ['filename'],
                threshold: 0.4, // Fuzzy search threshold
                includeScore: true,
                ignoreLocation: true,
                findAllMatches: true,
            });

            const searchResults = fuse.search(lowerQuery);
            const filtered = searchResults.map(result => result.item);

            // Sort by starred status first, then by filename
            filtered.sort((a, b) => {
                const aStarred = a.isStarred;
                const bStarred = b.isStarred;
                if (aStarred && !bStarred) return -1;
                if (!aStarred && bStarred) return 1;
                return a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' });
            });
            sortedImages = filtered;
        } else {
            // No search query - show all images sorted by starred status
            const starred = this.images.filter(img => img.isStarred);
            const unstarred = this.images.filter(img => !img.isStarred);
            starred.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }));
            unstarred.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }));
            sortedImages = [...starred, ...unstarred];
        }

        this.filteredImages = sortedImages;
        this.resetAndLoad();
    }

    setupDropToUpload() {
        const dropZone = this.container.closest('#Backgrounds');
        if (!dropZone) return;

        // Prevent default drag behaviors on the entire drawer
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                e.preventDefault();
                e.stopPropagation();
            });
        });

        // Add visual feedback for drag over
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => {
                dropZone.classList.add('drag-over');
            });
        });

        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => {
                dropZone.classList.remove('drag-over');
            });
        });

        // Handle the actual drop
        dropZone.addEventListener('drop', async (e) => {
            const files = Array.from(e.dataTransfer.files);

            // Filter for image and video files
            const validFiles = files.filter(file =>
                file.type.startsWith('image/') || file.type.startsWith('video/')
            );

            if (validFiles.length === 0) {
                toastr.warning('Please drop image or video files only.');
                return;
            }

            // Process each file
            for (const file of validFiles) {
                const formData = new FormData();
                formData.append('avatar', file);

                try {
                    await convertFileIfVideo(formData);
                    await uploadBackground(formData);
                } catch (error) {
                    console.error('Error uploading file:', file.name, error);
                    toastr.error(`Failed to upload ${file.name}`);
                }
            }

            // Refresh the gallery after all uploads
            const currentFilter = $('#bg-filter').val() || '';
            await getBackgrounds();

            if (currentFilter) {
                $('#bg-filter').val(currentFilter);
                this.search(currentFilter);
            }

            // Highlight the last uploaded file if only one was uploaded
            if (validFiles.length === 1) {
                const fileName = validFiles[0].name;
                setTimeout(() => { highlightNewBackground(fileName); }, 100);
            }
        });
    }

    // Clear cached order when images change
    setImages(imageDataList, defaultQuery = '') {
        this.images = imageDataList;
        this.search(defaultQuery);
    }

    updateThumbnailStates() {
        const allThumbnails = this.container.querySelectorAll('.thumbnail');

        allThumbnails.forEach(thumbnail => {
            const filename = thumbnail.dataset.bgfile;
            const imgData = this.images.find(img => img.filename === filename);

            if (imgData) {
                // Update starred state
                if (imgData.isStarred) {
                    thumbnail.classList.add('starred');
                } else {
                    thumbnail.classList.remove('starred');
                }

                // Update locked state
                const lockedBgUrl = `url("${imgData.fullResUrl}")`;
                if (chat_metadata[BG_METADATA_KEY] === lockedBgUrl) {
                    thumbnail.classList.add('locked');
                } else {
                    thumbnail.classList.remove('locked');
                }
            }
        });
    }

    resetAndLoad() {
        if (!this.container) return;
        this._hasRestored = false;
        this.setupColumns();
        this.currentIndex = 0;
        this.imageCounter = 0;
        this.loadBatch();
    }

    loadBatch() {
        // Load everything at once
        const remainingImages = this.filteredImages.slice(this.currentIndex);

        if (remainingImages.length === 0) return;

        remainingImages.forEach(imgData => this.addImage(imgData));

        // Mark all images as loaded
        this.currentIndex = this.filteredImages.length;
    }

    async waitForImagesAndRestore() {
        const scrollState = getGalleryScrollState();
        const currentFilter = $('#bg-filter').val() || '';

        // Always enable saving at the end
        const enableSavingAtEnd = () => {
            const imageCount = this.filteredImages.length;
            const baseDelay = 50;
            const perImageDelay = 0.1;
            const maxDelay = 5000;
            const dynamicDelay = Math.min(baseDelay + (imageCount * perImageDelay), maxDelay);

            setTimeout(() => {
                this.isRestoring = false;
                this._restoreDoneAt = Date.now();
                if (typeof this.enableSaving === 'function') {
                    this.enableSaving();
                }
            }, dynamicDelay);
        };

        // If we already restored scroll for this gallery build, just enable saving and exit
        if (this._hasRestored) {
            enableSavingAtEnd();
            return;
        }

        // Check if the current filter matches the saved filter
        const savedFilter = scrollState.filter || '';
        const normalizedCurrentFilter = currentFilter || '';
        const normalizedSavedFilter = savedFilter || '';

        if (normalizedCurrentFilter !== normalizedSavedFilter) {
            this._hasRestored = true;
            enableSavingAtEnd();
            return;
        }

        // Nothing to restore if stored position is zero
        if (scrollState.top === 0) {
            this._hasRestored = true;
            enableSavingAtEnd();
            return;
        }

        const s = this.scrollerElement;
        const wantedPx = scrollState.top;

        this.isRestoring = true;

        // Wait for layout to settle, then restore position
        const imageCount = this.filteredImages.length;
        const baseDelay = 50;
        const perImageDelay = 0.1;
        const maxDelay = 5000;
        const dynamicDelay = Math.min(baseDelay + (imageCount * perImageDelay), maxDelay);

        setTimeout(() => {
            s.scrollTo({ top: wantedPx, behavior: 'auto' });
            this._hasRestored = true;
            enableSavingAtEnd();
        }, dynamicDelay);
    }

    addImage(imgData) {
        if (!this.container || this.columns.length === 0) return;

        const columnIndex = this.imageCounter % this.columns.length;
        const targetColumn = this.columns[columnIndex];
        this.imageCounter++;

        const imgElement = new Image();
        const thumbnail = document.createElement('div');
        thumbnail.className = 'thumbnail fade-in';

        // Store state data but don't apply visual classes yet
        thumbnail.dataset.id = imgData.id;
        thumbnail.dataset.bgfile = imgData.filename;
        thumbnail.dataset.url = imgData.fullResUrl;
        thumbnail.title = imgData.filename;
        thumbnail.dataset.isStarred = imgData.isStarred;
        thumbnail.dataset.isLocked = chat_metadata[BG_METADATA_KEY] === `url("${imgData.fullResUrl}")`;

        if (imgData.isCustom) {
            thumbnail.setAttribute('custom', 'true');
        }

        const titleDiv = document.createElement('div');
        titleDiv.className = 'BGSampleTitle';
        titleDiv.textContent = imgData.filename.substring(0, imgData.filename.lastIndexOf('.')) || imgData.filename;

        const menu = document.createElement('div');
        menu.className = 'jg-menu';
        menu.innerHTML = `
            <div data-action="star" class="jg-button jg-star fa-fw pointer" title="${translate('Star Background')}">
                <i class="fa-solid fa-star"></i><i class="fa-regular fa-star"></i>
            </div>
            <div data-action="lock" class="jg-button jg-lock fa-solid fa-lock fa-fw pointer" title="${translate('Lock Background')}"></div>
            <div data-action="unlock" class="jg-button jg-unlock fa-solid fa-unlock fa-fw pointer" title="${translate('Unlock Background')}"></div>
            <div data-action="edit" class="jg-button jg-edit fa-solid fa-pen-to-square fa-fw pointer" title="${translate('Rename Background')}"></div>
            <div data-action="delete" class="jg-button jg-delete fa-solid fa-trash-can fa-fw pointer" title="${translate('Delete Background')}"></div>
        `;

        thumbnail.appendChild(imgElement);
        thumbnail.appendChild(titleDiv);
        thumbnail.appendChild(menu);
        targetColumn.appendChild(thumbnail);

        // Apply visual states only after image loads
        imgElement.onload = () => {
            // Apply visual state classes after image is loaded
            if (thumbnail.dataset.isStarred === 'true') {
                thumbnail.classList.add('starred');
            }
            if (thumbnail.dataset.isLocked === 'true') {
                thumbnail.classList.add('locked');
            }

            // Trigger fade-in
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    thumbnail.classList.add('visible');
                });
            });
        };

        imgElement.src = imgData.thumbnailUrl;
    }

    setupScrollPositionSaving() {
        if (!this.scrollerElement) return;

        const self = this;
        let allowSaving = false;
        let restoreHasRun = false;
        let userHasScrolled = false;
        let lastUserScrollTime = 0;

        const SAVE_COOLDOWN = 600;

        const saveScrollState = () => {
            const s = self.scrollerElement;

            // Block until the restore cycle has completed at least once
            if (!restoreHasRun) return;

            // Block if panel hidden or saving is disabled
            if (!isGalleryVisible || !allowSaving) return;

            // Block during cool-down right after a programmatic restore
            const timeSinceRestore = Date.now() - (self._restoreDoneAt || 0);
            if (timeSinceRestore < SAVE_COOLDOWN) return;

            // Block while still restoring
            if (self.isRestoring) return;

            // Block if element is collapsed
            if (s.clientHeight === 0 || s.scrollHeight === 0) return;

            // Block if user hasn't actually scrolled recently
            const timeSinceUserScroll = Date.now() - lastUserScrollTime;
            if (!userHasScrolled || timeSinceUserScroll > 5000) return;

            // Only ignore scrollTop === 0 if it happens very soon after restoration
            if (s.scrollTop === 0 && timeSinceRestore < SAVE_COOLDOWN) return;

            // Get the current filter state
            const currentFilter = $('#bg-filter').val() || '';

            const max = Math.max(1, s.scrollHeight - s.clientHeight);
            const currentState = {
                top: s.scrollTop,
                fraction: s.scrollTop / max,
                filter: currentFilter,
            };

            setGalleryScrollState(currentState);
        };

        this.debouncedSaveScrollState = debounce(saveScrollState, 250);

        let scrollTimeout;
        const handleScroll = (e) => {
            // Only mark as user scroll if it's trusted AND not during any restoration period
            const timeSinceRestore = Date.now() - (self._restoreDoneAt || 0);
            if (e.isTrusted && !self.isRestoring && timeSinceRestore > SAVE_COOLDOWN) {
                userHasScrolled = true;
                lastUserScrollTime = Date.now();
            }

            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(saveScrollState, 150);
            this.debouncedSaveScrollState();
        };

        this.scrollerElement.addEventListener('scroll', handleScroll);

        this.container.addEventListener('click', (e) => {
            if (e.target.closest('.thumbnail')) {
                userHasScrolled = true;
                lastUserScrollTime = Date.now();
                setTimeout(saveScrollState, 50);
            }
        });

        // Public toggles used by the IntersectionObserver
        this.enableSaving = () => {
            allowSaving = true;
            restoreHasRun = true;
        };
        this.disableSaving = () => {
            allowSaving = false;
            userHasScrolled = false;
            lastUserScrollTime = 0;
        };
    }

    ensureScrollTopButton() {
        if (this.scrollBtn) return;

        // Create the button element
        this.scrollBtn = document.createElement('div');
        this.scrollBtn.id = 'bg_scroll_top';

        // Ensure button is hidden initially
        this.scrollBtn.style.opacity = '0';
        this.scrollBtn.style.pointerEvents = 'none';

        // Create the icon element properly
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-chevron-up';
        this.scrollBtn.appendChild(icon);

        document.body.appendChild(this.scrollBtn); // Append to body for fixed positioning

        // Capture-phase handler to prevent drawer from closing
        const captureScrollStop = e => {
            if (e.target === this.scrollBtn || this.scrollBtn.contains(e.target)) {
                e.preventDefault();
                this.scrollerElement.scrollTo({ top: 0, behavior: 'smooth' });
                e.stopImmediatePropagation();
            }
        };
        ['pointerdown', 'mousedown', 'touchstart', 'click'].forEach(evt =>
            window.addEventListener(evt, captureScrollStop, true),
        );

        // Add a small delay before checking scroll position on drawer open
        const delayedRefresh = () => {
            // First hide the button
            this.scrollBtn.style.opacity = '0';
            this.scrollBtn.style.pointerEvents = 'none';

            // Then check after a small delay to avoid flickering
            setTimeout(() => {
                this.refreshScrollBtn();
            }, 50);
        };

        // Observe drawer open/close state
        if (this.drawerElement) {
            const observer = new MutationObserver(delayedRefresh);
            observer.observe(this.drawerElement, { attributes: true, attributeFilter: ['class'] });
        }

        // Debounce the scroll handler for performance
        this.handleScrollDebounced = debounce(this.refreshScrollBtn.bind(this), 10);
        this.scrollerElement.addEventListener('scroll', this.handleScrollDebounced);

        // Update position on window resize
        this.handleResizeDebounced = debounce(this.refreshScrollBtn.bind(this), 100);
        window.addEventListener('resize', this.handleResizeDebounced);

        // Initial check (after a small delay)
        setTimeout(() => {
            this.refreshScrollBtn();
        }, 50);
    }

    refreshScrollBtn() {
        if (!this.scrollBtn || !this.scrollerElement || !this.drawerElement) return;

        const isDrawerOpen = !this.drawerElement.classList.contains('closedDrawer');
        const scrolledDownEnough = this.scrollerElement.scrollTop > 150;

        // Calculate position relative to drawer bounds
        const drawerRect = this.drawerElement.getBoundingClientRect();
        const padding = 15;

        let rightPos = window.innerWidth - drawerRect.right + padding;
        let bottomPos = window.innerHeight - drawerRect.bottom + padding;

        rightPos = Math.max(padding, rightPos);
        bottomPos = Math.max(padding, bottomPos);

        this.scrollBtn.style.right = `${rightPos}px`;
        this.scrollBtn.style.bottom = `${bottomPos}px`;

        // Toggle visibility with opacity for smoothness
        if (isDrawerOpen && scrolledDownEnough) {
            this.scrollBtn.style.opacity = '1';
            this.scrollBtn.style.pointerEvents = 'auto';
        } else {
            this.scrollBtn.style.opacity = '0';
            this.scrollBtn.style.pointerEvents = 'none';
        }
    }
}

function setupGalleryObserver() {
    if (galleryObserver) galleryObserver.disconnect();

    const galleryContainer = document.getElementById('bg_menu_content');
    if (!galleryContainer) {
        console.error('Critical: #bg_menu_content not found.');
        return;
    }

    let hasLoaded = false;

    galleryObserver = new IntersectionObserver(entries => {
        const entry = entries[0];

        if (entry.isIntersecting) {
            isGalleryVisible = true;
            if (!hasLoaded) {
                // Clear any stale scroll state on first load
                setGalleryScrollState({ top: 0, fraction: 0, filter: '' });
                getBackgrounds();
                hasLoaded = true;
            } else {
                // On subsequent opens, restore scroll and highlight selected background
                if (backgroundSelector) {
                    backgroundSelector.waitForImagesAndRestore();

                    const selectedBgFile = background_settings.name;
                    if (selectedBgFile) {
                        const selectedElement = document.querySelector(`.thumbnail[data-bgfile="${selectedBgFile}"]`);
                        highlightSelectedBackground(selectedElement);
                    }
                }
            }
            // Refresh button visibility when drawer opens/closes
            backgroundSelector?.refreshScrollBtn();
        } else {
            isGalleryVisible = false;
            backgroundSelector?.disableSaving();
            if (backgroundSelector) backgroundSelector._hasRestored = false;
            // Refresh button visibility when drawer opens/closes
            backgroundSelector?.refreshScrollBtn();
        }
    }, { root: null, threshold: 0.01 });

    galleryObserver.observe(galleryContainer);
}

export function loadBackgroundSettings(settings) {
    let backgroundSettings = settings.background;
    if (!backgroundSettings || !backgroundSettings.name || !backgroundSettings.url) {
        backgroundSettings = background_settings;
    }
    if (!backgroundSettings.fitting) {
        backgroundSettings.fitting = 'classic';
    }
    if (!Object.hasOwn(backgroundSettings, 'animation')) {
        backgroundSettings.animation = false;
    }

    background_settings.animation = backgroundSettings.animation;
    setBackground(backgroundSettings.name, backgroundSettings.url);
    setFittingClass(backgroundSettings.fitting);
    $('#background_fitting').val(backgroundSettings.fitting);
    $('#background_thumbnails_animation').prop('checked', background_settings.animation);
}

/**
 * Sets the background for the current chat and adds it to the list of custom backgrounds.
 * @param {{url: string, path:string}} backgroundInfo
 */
async function forceSetBackground(backgroundInfo) {
    saveBackgroundMetadata(backgroundInfo.url);
    setCustomBackground();

    const list = chat_metadata[LIST_METADATA_KEY] || [];
    const bg = backgroundInfo.path;
    list.push(bg);
    chat_metadata[LIST_METADATA_KEY] = list;
    saveMetadataDebounced();
    await getChatBackgroundsList();
    highlightNewBackground(bg);
    highlightLockedBackground();
}

async function onChatChanged() {
    if (hasCustomBackground()) {
        setCustomBackground();
    } else {
        unsetCustomBackground();
    }

    // Re-initialize the observer every time the chat changes
    setupGalleryObserver();

    await getChatBackgroundsList();
    highlightLockedBackground();
}

async function getChatBackgroundsList() {
    $('#bg_chat_hint').hide();

    if (!backgroundSelector || !backgroundSelector.images) {
        return;
    }

    const list = chat_metadata[LIST_METADATA_KEY] || [];
    const customBgSet = new Set(list);

    backgroundSelector.images.forEach(img => {
        img.isCustom = customBgSet.has(img.filename);
    });

    const currentFilter = $('#bg-filter').val();
    backgroundSelector.search(currentFilter);
}

function highlightLockedBackground() {
    $('.thumbnail').removeClass('locked');

    const lockedBackground = chat_metadata[BG_METADATA_KEY];
    if (!lockedBackground) return;

    $('.thumbnail').each(function () {
        const url = $(this).data('url');
        const cssUrl = `url("${url}")`;
        if (cssUrl === lockedBackground) {
            $(this).addClass('locked');
        }
    });
}

/**
 * Locks the background for the current chat
 * @param {Event} e Click event
 * @returns {string} Empty string
 */
function onLockBackgroundClick(e) {
    e?.stopPropagation();

    const chatName = getCurrentChatId();

    if (!chatName) {
        toastr.warning('Select a chat to lock the background for it');
        return '';
    }

    const relativeBgImage = getUrlParameter(this) ?? background_settings.url;

    saveBackgroundMetadata(relativeBgImage);
    setCustomBackground();
    highlightLockedBackground();
    return '';
}

/**
 * Locks the background for the current chat
 * @param {Event} e Click event
 * @returns {string} Empty string
 */
function onUnlockBackgroundClick(e) {
    e?.stopPropagation();
    removeBackgroundMetadata();
    unsetCustomBackground();
    highlightLockedBackground();
    return '';
}

function hasCustomBackground() {
    return chat_metadata[BG_METADATA_KEY];
}

function saveBackgroundMetadata(file) {
    chat_metadata[BG_METADATA_KEY] = file;
    saveMetadataDebounced();
}

function removeBackgroundMetadata() {
    delete chat_metadata[BG_METADATA_KEY];
    saveMetadataDebounced();
}

function setCustomBackground() {
    const file = chat_metadata[BG_METADATA_KEY];

    // bg already set
    if (document.getElementById('bg_custom').style.backgroundImage == file) {
        return;
    }

    $('#bg_custom').css('background-image', file);
}

function unsetCustomBackground() {
    $('#bg_custom').css('background-image', 'none');
}

/**
 * Manages the visual 'selected' state for thumbnails.
 * @param {HTMLElement} selectedElement The thumbnail element that was clicked.
 */
function highlightSelectedBackground(selectedElement) {
    $('.thumbnail.selected').removeClass('selected');

    if (selectedElement) {
        $(selectedElement).addClass('selected');
    }
}

function onSelectBackgroundClick() {
    const $this = $(this);
    const bgFile = $this.data('bgfile');
    const fullResUrl = $this.data('url');
    const isCustom = $this.attr('custom') === 'true';

    if (!bgFile || !fullResUrl) return;

    const backgroundCssUrl = `url("${fullResUrl}")`;

    if (hasCustomBackground() || isCustom) {
        saveBackgroundMetadata(backgroundCssUrl);
        setCustomBackground();
    }

    highlightSelectedBackground(this);
    highlightLockedBackground();

    const customBg = window.getComputedStyle(document.getElementById('bg_custom')).backgroundImage;

    if (customBg === 'none' || isCustom) {
        setBackground(bgFile, backgroundCssUrl);
    }
}

/**
 * Gets the new background name from the user.
 * @param {Element} referenceElement
 * @returns {Promise<{oldBg: string, newBg: string}>}
 * */
async function getNewBackgroundName(thumbnailElement) {
    const exampleBlock = $(thumbnailElement);
    const isCustom = exampleBlock.attr('custom') === 'true';

    const oldBg = exampleBlock.data('bgfile');

    if (!oldBg) {
        console.debug('Could not find bgfile for rename operation.');
        return;
    }

    const fileExtension = oldBg.split('.').pop();
    const fileNameBase = isCustom ? oldBg.split('/').pop() : oldBg;
    const oldBgExtensionless = fileNameBase.replace(`.${fileExtension}`, '');
    const newBgExtensionless = await Popup.show.input(t`Enter new background name:`, null, oldBgExtensionless);

    if (!newBgExtensionless || oldBgExtensionless === newBgExtensionless) {
        return;
    }

    return { oldBg, newBg: `${newBgExtensionless}.${fileExtension}` };
}

async function onRenameBackgroundClick(e) {
    e.stopPropagation();

    // The 'this' context is the jg-button that was clicked.
    // We get the bgfile directly from the parent thumbnail's dataset.
    const thumbnail = this.closest('.thumbnail');
    if (!thumbnail) return;

    // Pass the thumbnail element to getNewBackgroundName
    const bgNames = await getNewBackgroundName(thumbnail);

    if (!bgNames) {
        return;
    }

    const data = { old_bg: bgNames.oldBg, new_bg: bgNames.newBg };
    const response = await fetch('/api/backgrounds/rename', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(data),
        cache: 'no-cache',
    });

    if (response.ok) {
        // If the old background was starred, update its starred status to the new name
        if (isBackgroundStarred(bgNames.oldBg)) {
            starredBackgrounds.delete(bgNames.oldBg);
            starredBackgrounds.add(bgNames.newBg);
            await saveStarredBackgrounds();
        }
        await getBackgrounds();
        highlightNewBackground(bgNames.newBg);
    } else {
        toastr.warning('Failed to rename background');
    }
}

async function onDeleteBackgroundClick(e) {
    e.stopPropagation();
    const bgToDelete = $(this).closest('.thumbnail');
    const url = bgToDelete.data('url');
    const isCustom = bgToDelete.attr('custom') === 'true';
    const confirm = await Popup.show.confirm(t`Delete the background?`, null);
    const bg = bgToDelete.data('bgfile');

    if (!confirm) return;

    if (!isCustom) {
        await delBackground(bg);
    } else {
        const list = chat_metadata[LIST_METADATA_KEY] || [];
        const index = list.indexOf(bg);
        if (index > -1) list.splice(index, 1);
    }

    // Remove from starred backgrounds if it was starred
    if (isBackgroundStarred(bg)) {
        starredBackgrounds.delete(bg);
        await saveStarredBackgrounds();
    }

    const index = backgroundSelector.images.findIndex(img => img.filename === bg);
    if (index > -1) {
        // Remove it from both the master list and the filtered list.
        backgroundSelector.images.splice(index, 1);
        const filteredIndex = backgroundSelector.filteredImages.findIndex(img => img.filename === bg);
        if (filteredIndex > -1) {
            backgroundSelector.filteredImages.splice(filteredIndex, 1);
        }
    }

    const allThumbnails = $('#bg_menu_content').find('.thumbnail');
    const currentIndex = allThumbnails.index(bgToDelete);

    bgToDelete.remove();

    const nextBg = allThumbnails.eq(currentIndex);

    if (nextBg.length) {
        nextBg.trigger('click');
    } else if (allThumbnails.length > 1) {
        allThumbnails.eq(currentIndex - 1).trigger('click');
    } else {
        $('.thumbnail[data-bgfile="__transparent.png"]').trigger('click');
    }

    // Check if this background is currently active (not locked)
    const currentBgUrl = `url("${url}")`;

    if (background_settings.url === currentBgUrl) {
        setBackground('__transparent.png', generateUrlParameter('__transparent.png', false));
    }

    // Check if this background is locked to the current chat
    if (currentBgUrl === chat_metadata[BG_METADATA_KEY]) {
        removeBackgroundMetadata();
        unsetCustomBackground();
    }

    highlightLockedBackground();
    if (isCustom) {
        await getChatBackgroundsList();
        saveMetadataDebounced();
    }
}

const autoBgPrompt = 'Ignore previous instructions and choose a location ONLY from the provided list that is the most suitable for the current scene. Do not output any other text:\n{0}';

async function autoBackgroundCommand() {
    /** @type {HTMLElement[]} */
    const bgTitles = Array.from(document.querySelectorAll('#bg_menu_content .BGSampleTitle'));
    const options = bgTitles.map(x => ({ element: $(x).closest('.thumbnail')[0], text: x.innerText.trim() })).filter(x => x.text.length > 0);
    if (options.length === 0) {
        toastr.warning('No backgrounds to choose from. Please upload some images to the "backgrounds" folder.');
        return '';
    }

    const list = options.map(option => `- ${option.text}`).join('\n');
    const prompt = stringFormat(autoBgPrompt, list);
    const reply = await generateQuietPrompt(prompt, false, false);
    const fuse = new Fuse(options, { keys: ['text'], threshold: 0.4 });
    const bestMatch = fuse.search(reply, { limit: 1 });
    if (bestMatch.length === 0) {
        toastr.warning('No match found.');
        return '';
    }

    $(bestMatch[0].item.element).trigger('click');
    return '';
}

export async function getBackgrounds() {
    let currentSearchQuery = '';
    try {
        const currentSearchQuery = $('#bg-filter').val() || '';

        const response = await fetch('/api/backgrounds/all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            console.error(`Failed to fetch backgrounds: ${response.status}`, await response.text());
            if (backgroundSelector) {
                backgroundSelector.setImages([], currentSearchQuery);
            }
            return;
        }

        const data = await response.json();
        const { images = [], config } = data;

        // Update thumbnail config if provided
        if (config) {
            Object.assign(THUMBNAIL_CONFIG, config);
        }

        const imageDataList = await Promise.all(images.map(async filename => {
            const isWebP = filename.toLowerCase().endsWith('.webp');
            let thumbnailUrl;

            if (isWebP) {
                if (background_settings.animation) {
                    // Use full animated WebP for thumbnails when animation is enabled
                    thumbnailUrl = getBackgroundPath(filename);
                } else {
                    // Use cached thumbnail when animation is disabled
                    thumbnailUrl = await getThumbnailFromStorage(filename);
                }
            } else {
                // Regular images use server-side thumbnails
                thumbnailUrl = `/thumbnail?file=${encodeURIComponent(filename)}&type=bg&animated=${background_settings.animation}`;
            }

            return {
                id: filename,
                filename: filename,
                thumbnailUrl: thumbnailUrl,
                fullResUrl: getBackgroundPath(filename),
                isStarred: isBackgroundStarred(filename),
            };
        }));

        if (backgroundSelector) {
            backgroundSelector.setImages(imageDataList, currentSearchQuery);
        }

        setTimeout(() => {
            highlightLockedBackground();

            const selectedBgFile = background_settings.name;
            if (selectedBgFile) {
                const selectedElement = document.querySelector(`.thumbnail[data-bgfile="${selectedBgFile}"]`);
                highlightSelectedBackground(selectedElement);
            }

            if (backgroundSelector) {
                backgroundSelector.waitForImagesAndRestore();
            }

        }, 0);

    } catch (error) {
        console.error('Error in getBackgrounds:', error);
        if (backgroundSelector) {
            backgroundSelector.setImages([], currentSearchQuery);
        }
    }
}

async function setBackground(bg, url) {
    $('#bg1').css('background-image', url);
    background_settings.name = bg;
    background_settings.url = url;
    saveSettingsDebounced();
}

async function delBackground(bg) {
    await fetch('/api/backgrounds/delete', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({
            bg: bg,
        }),
    });
}

async function onBackgroundUploadSelected() {
    const form = document.getElementById('form_bg_upload');

    if (!(form instanceof HTMLFormElement)) {
        console.error('form_bg_upload is not a form');
        return;
    }

    const formData = new FormData(form);
    await convertFileIfVideo(formData);
    await uploadBackground(formData);
    form.reset();
}

/**
 * Converts a video file to an animated webp format if the file is a video.
 * @param {FormData} formData
 * @returns {Promise<void>}
 */
async function convertFileIfVideo(formData) {
    const file = formData.get('avatar');
    if (!(file instanceof File)) {
        return;
    }
    if (!file.type.startsWith('video/')) {
        return;
    }
    if (typeof globalThis.convertVideoToAnimatedWebp !== 'function') {
        toastr.warning(t`Click here to install the Video Background Loader extension`, t`Video background uploads require a downloadable add-on`, {
            timeOut: 0,
            extendedTimeOut: 0,
            onclick: () => openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-VideoBackgroundLoader'),
        });
        return;
    }

    let toastMessage = jQuery();
    try {
        toastMessage = toastr.info(t`Preparing video for upload. This may take several minutes.`, t`Please wait`, { timeOut: 0, extendedTimeOut: 0 });
        const sourceBuffer = await file.arrayBuffer();
        const convertedBuffer = await globalThis.convertVideoToAnimatedWebp({ buffer: new Uint8Array(sourceBuffer), name: file.name });
        const convertedFileName = file.name.replace(/\.[^/.]+$/, '.webp');
        const convertedFile = new File([convertedBuffer], convertedFileName, { type: 'image/webp' });
        formData.set('avatar', convertedFile);
        toastMessage.remove();
    } catch (error) {
        formData.delete('avatar');
        toastMessage.remove();
        console.error('Error converting video to animated webp:', error);
        toastr.error(t`Error converting video to animated webp`);
    }
}

/**
 * Uploads a background to the server and updates the UI.
 * @param {FormData} formData
 */
async function uploadBackground(formData) {
    try {
        if (!formData.has('avatar')) {
            console.log('No file provided. Background upload cancelled.');
            return;
        }

        const headers = getRequestHeaders();
        delete headers['Content-Type'];

        const currentFilter = $('#bg-filter').val() || '';

        const response = await fetch('/api/backgrounds/upload', {
            method: 'POST',
            headers: headers,
            body: formData,
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error(`Upload failed: ${response.status}`);
        }

        const bg = await response.text();

        await getBackgrounds();

        if (currentFilter) {
            $('#bg-filter').val(currentFilter);
            backgroundSelector.search(currentFilter);
        }

        setTimeout(() => { highlightNewBackground(bg); }, 100);

    } catch (error) {
        console.error('Error uploading background:', error);
    }
}

/**
 * Scrolls to, highlights, and selects a newly added background.
 * @param {string} bg
 */
function highlightNewBackground(bg) {
    const currentFilter = $('#bg-filter').val() || '';
    if (currentFilter) {
        return;
    }

    const newBg = $(`.thumbnail[data-bgfile="${bg}"]`);
    if (newBg.length) {
        const scroller = $('#bg-scrollable-content');
        const offsetTop = newBg.offset().top - scroller.offset().top + scroller.scrollTop();
        scroller.animate({ scrollTop: offsetTop - 50 }, 500, function() {
            flashHighlight(newBg);
            newBg.trigger('click');
        });
    }
}

/**
 * Sets the fitting class for the background element
 * @param {string} fitting Fitting type
 */
function setFittingClass(fitting) {
    const backgrounds = $('#bg1, #bg_custom');
    for (const option of ['cover', 'contain', 'stretch', 'center']) {
        backgrounds.toggleClass(option, option === fitting);
    }
    background_settings.fitting = fitting;
}

function onBackgroundFilterInput() {
    const filterValue = String($(this).val());
    if (backgroundSelector) {
        backgroundSelector.debouncedSearch(filterValue);
    }
}

export async function initBackgrounds() {
    await loadStarredBackgrounds();

    backgroundSelector = new BackgroundSelector('bg_menu_content');
    backgroundSelector.setupScrollPositionSaving();

    // Call the setup function on initial load
    setupGalleryObserver();

    // The rest of the event listeners are for elements that are not rebuilt.
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.FORCE_SET_BACKGROUND, forceSetBackground);

    $(document).on('click', '.jg-button', function(e) {
        e.stopPropagation();
        const action = $(this).data('action');
        const thumbnailContext = $(this).closest('.thumbnail').get(0);
        const filename = $(thumbnailContext).data('bgfile'); // Get filename for star action

        switch (action) {
            case 'star':
                if (filename) {
                    toggleStarredBackground(filename);
                }
                break;
            case 'lock': onLockBackgroundClick.call(thumbnailContext, e); break;
            case 'unlock': onUnlockBackgroundClick.call(thumbnailContext, e); break;
            case 'edit': onRenameBackgroundClick.call(thumbnailContext, e); break;
            case 'delete': onDeleteBackgroundClick.call(thumbnailContext, e); break;
        }
    });

    $(document).on('click', '.thumbnail', onSelectBackgroundClick);

    $('#auto_background').on('click', autoBackgroundCommand);
    $('#add_bg_button').on('change', onBackgroundUploadSelected);
    $('#bg-filter').on('input', onBackgroundFilterInput);

    $('#background_fitting').on('input', function () {
        background_settings.fitting = String($(this).val());
        setFittingClass(background_settings.fitting);
        saveSettingsDebounced();
    });

    $('#background_thumbnails_animation').on('change', function() {
        background_settings.animation = $(this).prop('checked');
        saveSettingsDebounced();
        if (backgroundSelector) {
            // Preserve the current search term
            const currentFilter = $('#bg-filter').val() || '';

            // Clear the saved scroll state since image heights will change
            setGalleryScrollState({ top: 0, fraction: 0, filter: currentFilter });

            getBackgrounds();
        }
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lockbg',
        callback: () => onLockBackgroundClick(new CustomEvent('click')),
        aliases: ['bglock'],
        helpString: 'Locks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'unlockbg',
        callback: () => onUnlockBackgroundClick(new CustomEvent('click')),
        aliases: ['bgunlock'],
        helpString: 'Unlocks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'autobg',
        callback: autoBackgroundCommand,
        aliases: ['bgauto'],
        helpString: 'Automatically changes the background based on the chat context using the AI request prompt',
    }));
}
