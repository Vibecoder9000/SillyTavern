import { Fuse } from '../lib.js';
import { chat_metadata, eventSource, generateQuietPrompt, getCurrentChatId, getRequestHeaders, saveSettingsDebounced } from '../script.js';
import { openThirdPartyExtensionMenu, saveMetadataDebounced } from './extensions.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { flashHighlight, stringFormat, debounce, createThumbnail, getBase64Async } from './utils.js';
import { t, translate } from './i18n.js';
import { Popup } from './popup.js';

const PNG_PIXEL_B64 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const SERVER_THUMBNAIL_CACHE = new Map();
let THUMBNAIL_CONFIG = { width: 160, height: 90 };
let backgroundSelector = null;
let hasGalleryLoaded = false;
let galleryLoadInProgress = false;
const BG_METADATA_KEY = 'custom_background';
const LIST_METADATA_KEY = 'chat_backgrounds';

/**
 * Creates the "Starred" folder button element, styled to look like a thumbnail placeholder.
 * @returns {HTMLElement} The created container element for the folder.
 */
function createStarredFolderElement() {
    const container = document.createElement('div');
    container.id = 'starred-folder-container';

    const button = document.createElement('div');
    button.id = 'starred-folder-button';
    button.className = 'thumbnail';
    button.title = translate('View Starred Backgrounds');

    const size = '110px';
    button.style.setProperty('--thumb-width', size);
    button.style.setProperty('--thumb-height', size);

    const clipper = document.createElement('div');
    clipper.className = 'thumbnail-clipper';

    const placeholder = document.createElement('div');
    placeholder.className = 'thumbnail-placeholder';

    const iconOverlay = document.createElement('div');
    iconOverlay.className = 'folder-icon-overlay';

    const folderIcon = document.createElement('i');
    folderIcon.className = 'fa-solid fa-folder';

    iconOverlay.appendChild(folderIcon);
    clipper.appendChild(placeholder);
    clipper.appendChild(iconOverlay);
    button.appendChild(clipper);
    container.appendChild(button);

    return container;
}

/**
 * Toggles the starred status of a background by calling the server API and then updates the UI.
 * This version avoids a full re-render of the main list for better performance.
 * @param {string} filename - The filename of the background to toggle.
 * @returns {Promise<void>}
 */
async function toggleStarredBackground(filename) {
    const imageInMasterList = backgroundSelector.images.find(img => img.filename === filename);
    if (!imageInMasterList) return;

    const isCurrentlyStarred = imageInMasterList.isStarred;
    const newStarredState = !isCurrentlyStarred;

    try {
        const response = await fetch('/api/backgrounds/star', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ filename, isStarred: newStarredState }),
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}: ${await response.text()}`);
        }

        // 1. On success, update the client-side data model.
        imageInMasterList.isStarred = newStarredState;
        const imageInFilteredList = backgroundSelector.filteredImages.find(img => img.filename === filename);
        if (imageInFilteredList) {
            imageInFilteredList.isStarred = newStarredState;
        }

        // 2. Perform a targeted DOM update instead of a full re-render.
        // This finds the thumbnail in the main gallery AND the popup if it's open.
        const thumbnailElements = document.querySelectorAll(`.thumbnail[data-bgfile="${filename}"]`);
        thumbnailElements.forEach(thumb => {
            thumb.dataset.isStarred = String(newStarredState);
            const clipper = thumb.querySelector('.thumbnail-clipper');
            if (clipper) {
                clipper.dataset.isStarred = String(newStarredState);
            }
        });

        // 3. Handle the edge case of the "Starred" folder appearing or disappearing in the main gallery.
        const hasAnyStarredInFilteredView = backgroundSelector.filteredImages.some(img => img.isStarred);
        const folderElement = document.getElementById('starred-folder-container');

        if (hasAnyStarredInFilteredView && !folderElement) {
            // If there are now starred items but the folder isn't visible, add it.
            backgroundSelector.container.prepend(createStarredFolderElement());
        } else if (!hasAnyStarredInFilteredView && folderElement) {
            // If there are no longer any starred items but the folder is visible, remove it.
            folderElement.remove();
        }

    } catch (error) {
        console.error(`Failed to toggle star for ${filename}:`, error);
        toastr.error(translate('Failed to update starred status.'));
    }
}

/**
 * Gets the relative path for a background image.
 * @param {string} fileUrl - The filename or URL of the background.
 * @returns {string}
 */
function getBackgroundPath(fileUrl) {
    return `backgrounds/${encodeURIComponent(fileUrl)}`;
}

/**
 * Generates a CSS URL parameter for a background.
 * @param {string} bg - The background filename or URL.
 * @param {boolean} isCustom - True if the background is a custom URL.
 * @returns {string}
 */
function generateUrlParameter(bg, isCustom) {
    return isCustom ? `url("${encodeURI(bg)}")` : `url("${getBackgroundPath(bg)}")`;
}

/**
 * Extracts the URL parameter from a thumbnail element.
 * @param {HTMLElement} element - The thumbnail DOM element.
 * @returns {string}
 */
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
    animation: true,
};

/**
 * Fetches and caches a thumbnail from the server.
 * @param {string} thumbnailUrl - The URL of the thumbnail.
 * @returns {Promise<string>} A Blob URL for the cached thumbnail or a placeholder.
 */
async function getCachedServerThumbnail(thumbnailUrl) {
    if (SERVER_THUMBNAIL_CACHE.has(thumbnailUrl)) {
        return SERVER_THUMBNAIL_CACHE.get(thumbnailUrl);
    }
    try {
        const response = await fetch(thumbnailUrl, { cache: 'force-cache' });
        if (!response.ok) return PNG_PIXEL_B64;
        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        SERVER_THUMBNAIL_CACHE.set(thumbnailUrl, blobUrl);
        return blobUrl;
    } catch (error) {
        console.warn(`Failed to fetch server thumbnail ${thumbnailUrl}:`, error);
        return PNG_PIXEL_B64;
    }
}

/**
 * Generates the URL for a background thumbnail.
 * @param {string} filename - The filename of the background.
 * @returns {string}
 */
function getThumbnailUrl(filename) {
    return `/thumbnail?file=${encodeURIComponent(filename)}&type=bg`;
}

/**
 * Creates a thumbnail from a video file object using a canvas.
 * @param {File} videoFile The video file.
 * @param {object} options Thumbnail dimensions.
 * @returns {Promise<Blob>} A promise that resolves with the thumbnail as a Blob.
 */
function createVideoThumbnail(videoFile, options) {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');
        const url = URL.createObjectURL(videoFile);

        video.onloadeddata = () => {
            // Seek to 1 second to get a better frame than the very first one.
            video.currentTime = 1;
        };

        video.onseeked = () => {
            // Set canvas dimensions based on video aspect ratio
            const aspectRatio = video.videoWidth / video.videoHeight;
            let width = options.maxWidth;
            let height = options.maxWidth / aspectRatio;

            if (height > options.maxHeight) {
                height = options.maxHeight;
                width = height * aspectRatio;
            }
            canvas.width = width;
            canvas.height = height;

            context.drawImage(video, 0, 0, width, height);
            canvas.toBlob(
                (blob) => {
                    URL.revokeObjectURL(url); // Clean up the object URL
                    resolve(blob);
                },
                options.format || 'image/jpeg',
                options.quality || 0.9,
            );
        };

        video.onerror = (err) => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load video for thumbnail generation.'));
        };

        video.src = url;
    });
}

/**
 * Creates a single thumbnail DOM element.
 * @param {object} imageData - Data for the image.
 * @param {object} calculatedSize - Calculated size for the thumbnail.
 * @returns {HTMLElement} The created thumbnail element.
 */
function createThumbnailElement(imageData, calculatedSize) {
    // Get the reusable menu structure from the <template> tag in the HTML.
    const menuTemplate = document.getElementById('thumbnail-menu-template');

    // Create the main container div for the thumbnail.
    const thumbnail = document.createElement('div');
    thumbnail.className = 'thumbnail';

    // Create the clipping wrapper
    const clipper = document.createElement('div');
    clipper.className = 'thumbnail-clipper';

    // Assign data attributes
    thumbnail.dataset.bgfile = imageData.filename;
    thumbnail.dataset.url = imageData.fullResUrl;
    thumbnail.dataset.isStarred = String(imageData.isStarred);
    clipper.dataset.isStarred = String(imageData.isStarred);

    // The title attribute provides the native browser tooltip on hover
    thumbnail.title = imageData.filename;

    // Set CSS Custom Properties. The CSS will use these variables
    thumbnail.style.setProperty('--thumb-width', `${calculatedSize.width}px`);
    thumbnail.style.setProperty('--thumb-height', `${calculatedSize.height}px`);

    if (imageData.isCustom) {
        thumbnail.setAttribute('custom', 'true');
    }

    thumbnail.appendChild(clipper);
    const placeholder = document.createElement('div');
    placeholder.className = 'thumbnail-placeholder shimmer';
    if (imageData.dominantColor) {
        placeholder.style.backgroundColor = imageData.dominantColor;
    }
    clipper.appendChild(placeholder);
    const imgElement = new Image();
    imgElement.dataset.src = imageData.thumbnailUrl;
    imgElement.src = PNG_PIXEL_B64;
    clipper.appendChild(imgElement);
    const titleDiv = document.createElement('div');
    titleDiv.className = 'BGSampleTitle';
    titleDiv.textContent = imageData.filename.substring(0, imageData.filename.lastIndexOf('.')) || imageData.filename;
    clipper.appendChild(titleDiv);
    const menuFragment = menuTemplate.content.cloneNode(true);
    thumbnail.appendChild(menuFragment.querySelector('.jg-menu'));
    return thumbnail;
}

/**
 * Manages the background image gallery, including rendering, filtering, and lazy loading.
 */
class BackgroundSelector {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.images = [];
        this.filteredImages = [];
        this.containerWidth = 0;
        this.imageObserver = null;
        this.resizeObserver = null;
        this.isInitialRender = true;
        this.debouncedRender = debounce(() => this.render(false), 150);
        this.setupImageObserver();
        this.setupResizeObserver();
        this.debouncedSearch = debounce((query) => this.search(query), 250);
        this.setupDropToUpload();
        this.setupScrollToTop();
    }

    setupResizeObserver() {
        if (this.resizeObserver) this.resizeObserver.disconnect();
        this.resizeObserver = new ResizeObserver(entries => {
            if (this.isInitialRender) {
                return;
            }
            const newWidth = this.container.clientWidth;
            if (newWidth > 0 && newWidth !== this.containerWidth) {
                this.debouncedRender();
            }
        });
        this.resizeObserver.observe(this.container);
    }

    setupImageObserver() {
        if (this.imageObserver) this.imageObserver.disconnect();
        this.imageObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const thumbElement = entry.target;
                    this.imageObserver.unobserve(thumbElement);
                    this.loadSingleThumbnail(thumbElement);
                }
            });
        }, { root: null, rootMargin: '500px 0px', threshold: 0.01 });
    }

    setData(imageDataList) {
        this.images = imageDataList;
        const currentQuery = $('#bg-filter').val() || '';
        this.search(currentQuery);
    }

    search(query) {
        const lowerQuery = query.toLowerCase().trim();
        if (lowerQuery) {
            this.filteredImages = this.images.filter(img => img.filename.toLowerCase().includes(lowerQuery));
        } else {
            this.filteredImages = [...this.images];
        }
        this.render(true);
    }

    render(isInitial = false) {
        this.isInitialRender = isInitial;
        this.containerWidth = this.container.clientWidth;
        if (this.containerWidth === 0) return;

        this.imageObserver.disconnect();
        this.container.innerHTML = '';

        if (this.filteredImages.length === 0) {
            this.container.innerHTML = `<p>${translate('No backgrounds found.')}</p>`;
            return;
        }

        const hasStarred = this.filteredImages.some(img => img.isStarred);
        if (hasStarred) {
            this.container.appendChild(createStarredFolderElement());
        }

        const mainContainer = document.createElement('div');
        mainContainer.id = 'main-backgrounds-container';
        mainContainer.className = 'thumbnail-container';

        const isMobile = window.innerWidth <= 1000;
        const targetRowHeight = isMobile ? 70 : 110;

        const allRows = calculateRowLayout(
            this.containerWidth,
            this.filteredImages,
            false,
            targetRowHeight, // Pass target height
        );

        allRows.forEach(rowData => {
            const rowElement = createRowElement(rowData);
            mainContainer.appendChild(rowElement);
        });

        mainContainer.querySelectorAll('.thumbnail').forEach(thumb =>
            this.imageObserver.observe(thumb),
        );

        this.container.appendChild(mainContainer);
        setTimeout(() => { this.isInitialRender = false; }, 100);
    }

    async loadSingleThumbnail(thumbElement) {
        const img = thumbElement.querySelector('img');
        const placeholder = thumbElement.querySelector('.thumbnail-placeholder');
        if (!img || !img.dataset.src) return;
        const baseUrl = img.dataset.src;
        const useAnimation = document.getElementById('background_thumbnails_animation').checked;
        const finalUrl = `${baseUrl}&animated=${useAnimation}`;
        const src = await getCachedServerThumbnail(finalUrl);
        delete img.dataset.src;
        img.onload = () => {
            img.style.opacity = '1';
            placeholder?.remove();
        };
        img.src = src;
    }

    setupDropToUpload() {
        const dropZone = this.container.closest('#Backgrounds');
        if (!dropZone) return;
        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); });
        });
        ['dragenter', 'dragover'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.add('drag-over')));
        ['dragleave', 'drop'].forEach(eventName => dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over')));
        dropZone.addEventListener('drop', async (e) => {
            const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/') || file.type.startsWith('video/'));
            if (files.length === 0) return;
            for (const file of files) {
                const formData = new FormData();
                formData.append('avatar', file);
                try {
                    await convertFileIfVideo(formData);
                    await uploadBackground(formData);
                } catch (error) { console.error('Error uploading file:', error); }
            }
            await getBackgrounds(true);
        });
    }

    setupScrollToTop() {
        // ... (this method is unchanged)
        setTimeout(() => {
            const scrollContainer = document.getElementById('bg-scrollable-content');
            const btn = document.getElementById('bg_scroll_top'); // This will find the *first* button
            const drawer = document.getElementById('Backgrounds');

            if (!scrollContainer || !btn || !drawer) {
                console.error('Scroll-to-top dependencies not found.');
                return;
            }

            // 1. Show/hide based on scroll position.
            scrollContainer.addEventListener('scroll', () => {
                if (scrollContainer.scrollTop > 300) {
                    btn.classList.add('visible');
                } else {
                    btn.classList.remove('visible');
                }
            });

            // 2. Hide the button if the drawer is closed.
            const drawerObserver = new MutationObserver(() => {
                if (!drawer.classList.contains('openDrawer')) {
                    btn.classList.remove('visible');
                }
            });
            drawerObserver.observe(drawer, { attributes: true, attributeFilter: ['class'] });

            // 3. Handle the click.
            btn.addEventListener('click', e => {
                e.preventDefault();
                e.stopPropagation();
                scrollContainer.scrollTo({ top: 0, behavior: 'smooth' });
            });

        }, 100);
    }

    destroy() {
        if (this.imageObserver) this.imageObserver.disconnect();
        if (this.resizeObserver) this.resizeObserver.disconnect();
        const scrollToTopButton = document.getElementById('bg_scroll_top');
        if (scrollToTopButton) {
            scrollToTopButton.style.display = 'none';
            scrollToTopButton.style.opacity = '0';
            scrollToTopButton.style.pointerEvents = 'none';
        }
    }
}

/**
 * Initiates the process of updating missing aspect ratios for images and uploading static thumbnails.
 * @param {Array<object>} imageDataList - The list of image data objects.
 * @returns {Promise<void>}
 */
async function updateMissingAspectRatios(imageDataList) {
    const unknownImages = imageDataList.filter(img => img.aspectRatio === null);
    if (unknownImages.length === 0) return;
    const useAnimation = document.getElementById('background_thumbnails_animation').checked;
    if (!useAnimation) {
        return;
    }
    processAndUploadStaticThumbnails(unknownImages);
}

/**
 * Orchestrates the client-side thumbnail generation for existing files and uploads them.
 * @param {Array<object>} imagesToProcess - The list of image data objects needing a static thumbnail.
 * @returns {Promise<void>}
 */
async function processAndUploadStaticThumbnails(imagesToProcess) {
    const promises = imagesToProcess.map(async (imageData) => {
        const logPrefix = `[ProcessThumb] ${imageData.filename}:`;
        try {
            const response = await fetch(`${imageData.thumbnailUrl}&animated=true`);
            if (!response.ok) {
                throw new Error(`Failed to fetch original file. Server responded with ${response.status} ${response.statusText}`);
            }
            const blob = await response.blob();
            const file = new File([blob], imageData.filename, { type: blob.type });

            // The createThumbnail utility requires a base64 data URL, not a File object.
            // First, convert the file to a data URL.
            const fileDataUrl = await getBase64Async(file);

            // Now, create the static thumbnail from the data URL.
            const thumbnailDataUrl = await createThumbnail(
                fileDataUrl,
                THUMBNAIL_CONFIG.width,
                THUMBNAIL_CONFIG.height,
                'image/jpeg',
            );

            const staticThumbnailBlob = await (await fetch(thumbnailDataUrl)).blob();
            const thumbFormData = new FormData();
            thumbFormData.append('thumbnail', staticThumbnailBlob, imageData.filename);

            const uploadUrl = `/api/thumbnails/upload-generated?originalFilename=${encodeURIComponent(imageData.filename)}`;

            const uploadResponse = await fetch(uploadUrl, {
                method: 'POST',
                headers: getHeadersForFormData(),
                body: thumbFormData,
            });

            if (!uploadResponse.ok) {
                throw new Error(`Upload failed. Server responded with ${uploadResponse.status} ${uploadResponse.statusText}`);
            }
        } catch (error) {
            console.error(`${logPrefix} FAILED.`, error);
        }
    });
    await Promise.allSettled(promises);
    await getBackgrounds(true);
}

/**
 * Gets the necessary request headers for a FormData upload.
 * @returns {HeadersInit}
 */
function getHeadersForFormData() {
    const headers = getRequestHeaders();
    delete headers['Content-Type'];
    return headers;
}

/**
 * Fetches background images from the server and updates the gallery.
 * @param {boolean} force - Whether to force a refresh of the data.
 * @returns {Promise<void>}
 */
export async function getBackgrounds(force = false) {
    const response = await fetch('/api/backgrounds/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error(`Fetch failed: ${response.statusText}`);
    const data = await response.json();
    const { images: imagesFromServer = [], config } = data;
    if (config) Object.assign(THUMBNAIL_CONFIG, config);

    let imageDataList = imagesFromServer.map(imgData => ({
        ...imgData,
        id: imgData.filename,
        thumbnailUrl: getThumbnailUrl(imgData.filename),
        fullResUrl: getBackgroundPath(imgData.filename),
        isStarred: !!imgData.isStarred,
        isCustom: false,
    }));
    if (backgroundSelector) {
        backgroundSelector.setData(imageDataList);
        updateStateFromChatMetadata();
        highlightSelectedBackground();
    }
    updateMissingAspectRatios(imageDataList);
}

/**
 * Loads background settings from user preferences and applies them.
 * @param {object} settings - The user settings object.
 */
export function loadBackgroundSettings(settings) {
    let backgroundSettings = settings.background;
    if (!backgroundSettings || !backgroundSettings.name || !backgroundSettings.url) {
        backgroundSettings = background_settings;
    }
    if (!backgroundSettings.fitting) backgroundSettings.fitting = 'classic';
    if (!Object.hasOwn(backgroundSettings, 'animation')) backgroundSettings.animation = true;
    background_settings.animation = backgroundSettings.animation;
    setBackground(backgroundSettings.name, backgroundSettings.url);
    setFittingClass(backgroundSettings.fitting);
    $('#background_fitting').val(backgroundSettings.fitting);
    $('#background_thumbnails_animation').prop('checked', background_settings.animation);
}

/**
 * Handles chat change events, updating background display based on chat metadata.
 * @returns {Promise<void>}
 */
async function onChatChanged() {
    if (hasCustomBackground()) setCustomBackground();
    else unsetCustomBackground();
    updateStateFromChatMetadata();
}

/**
 * Updates the UI state of thumbnails (e.g., custom, locked) based on chat metadata.
 */
function updateStateFromChatMetadata() {
    if (!backgroundSelector || !backgroundSelector.images) {
        return;
    }
    const list = chat_metadata[LIST_METADATA_KEY] || [];
    const customBgSet = new Set(list);
    document.querySelectorAll('#bg_menu_content .thumbnail').forEach(thumb => {
        const filename = thumb.dataset.bgfile;
        const isCustom = customBgSet.has(filename);
        thumb.setAttribute('custom', String(isCustom));
    });
    highlightLockedBackground();
}

/**
 * Highlights the background that is currently locked for the chat.
 */
function highlightLockedBackground() {
    const lockedBackground = chat_metadata[BG_METADATA_KEY];
    document.querySelectorAll('#bg_menu_content .thumbnail').forEach(thumb => {
        const url = thumb.dataset.url;
        const cssUrl = `url("${url}")`;
        thumb.dataset.isLocked = String(cssUrl === lockedBackground);
    });
}

/**
 * Event handler for locking a background to the current chat.
 * @param {Event} e - The click event.
 */
function onLockBackgroundClick(e) {
    e?.stopPropagation();
    if (!getCurrentChatId()) {
        toastr.warning(translate('Select a chat to lock the background for it'));
        return;
    }
    const relativeBgImage = getUrlParameter(this) ?? background_settings.url;
    saveBackgroundMetadata(relativeBgImage);
    setCustomBackground();
    highlightLockedBackground();
}

/**
 * Event handler for unlocking a background from the current chat.
 * @param {Event} e - The click event.
 */
function onUnlockBackgroundClick(e) {
    e?.stopPropagation();
    removeBackgroundMetadata();
    unsetCustomBackground();
    highlightLockedBackground();
}

/**
 * Checks if the current chat has a custom background locked.
 * @returns {boolean}
 */
function hasCustomBackground() {
    return chat_metadata[BG_METADATA_KEY];
}

/**
 * Saves background metadata to the current chat's metadata.
 * @param {string} file - The background file or URL.
 */
function saveBackgroundMetadata(file) {
    chat_metadata[BG_METADATA_KEY] = file;
    saveMetadataDebounced();
}

/**
 * Removes background metadata from the current chat.
 */
function removeBackgroundMetadata() {
    delete chat_metadata[BG_METADATA_KEY];
    saveMetadataDebounced();
}

/**
 * Applies the custom background image to the chat UI.
 */
function setCustomBackground() {
    const file = chat_metadata[BG_METADATA_KEY];
    if (document.getElementById('bg_custom').style.backgroundImage !== file) {
        $('#bg_custom').css('background-image', file);
    }
}

/**
 * Removes the custom background image from the chat UI.
 */
function unsetCustomBackground() {
    if (document.getElementById('bg_custom').style.backgroundImage !== 'none') {
        $('#bg_custom').css('background-image', 'none');
    }
}

/**
 * Highlights the currently selected background thumbnail in the gallery.
 */
function highlightSelectedBackground() {
    // Remove the 'selected' class from thumbnails
    document.querySelectorAll('.thumbnail.selected').forEach(thumb => {
        thumb.classList.remove('selected');
    });

    const selectedFilename = background_settings.name;
    if (selectedFilename) {
        const selectedThumbs = document.querySelectorAll(`.thumbnail[data-bgfile="${selectedFilename}"]`);

        // Apply the 'selected' class to every thumbnail
        selectedThumbs.forEach(thumb => {
            thumb.classList.add('selected');
        });
    }
}

/**
 * Event handler for selecting a background thumbnail.
 */
function onSelectBackgroundClick() {
    const $this = $(this);
    const bgFile = $this.attr('data-bgfile');
    const fullResUrl = $this.attr('data-url');
    const isCustom = $this.attr('custom') === 'true';
    if (!bgFile || !fullResUrl) return;
    background_settings.name = bgFile;
    highlightSelectedBackground();
    const backgroundCssUrl = `url("${fullResUrl}")`;
    if (hasCustomBackground() || isCustom) {
        saveBackgroundMetadata(backgroundCssUrl);
        setCustomBackground();
    }
    highlightLockedBackground();
    const customBg = window.getComputedStyle(document.getElementById('bg_custom')).backgroundImage;
    if (customBg === 'none' || isCustom) {
        setBackground(bgFile, backgroundCssUrl);
    }
}

/**
 * Prompts the user for a new background name.
 * @param {HTMLElement} thumbnailElement - The thumbnail element of the background to rename.
 * @returns {Promise<{oldBg: string, newBg: string}|null>} An object with old and new filenames, or null if cancelled/invalid.
 */
async function getNewBackgroundName(thumbnailElement) {
    const oldBg = $(thumbnailElement).attr('data-bgfile');
    if (!oldBg) return;
    const fileExtension = oldBg.split('.').pop();
    const oldBgExtensionless = oldBg.replace(`.${fileExtension}`, '');

    // Set a global flag to tell other listeners to stand down.
    window.isStCorePopupActive = true;

    const newBgExtensionless = await Popup.show.input(t`Enter new background name:`, null, oldBgExtensionless);

    // Unset the flag now that the popup is closed.
    window.isStCorePopupActive = false;

    if (!newBgExtensionless || oldBgExtensionless === newBgExtensionless) return;
    return { oldBg, newBg: `${newBgExtensionless}.${fileExtension}` };
}

/**
 * Event handler for renaming a background.
 * @param {Event} e - The click event.
 * @returns {Promise<void>}
 */
async function onRenameBackgroundClick(e) {
    e.stopPropagation();
    const thumbnail = this.closest('.thumbnail');
    const bgNames = await getNewBackgroundName(thumbnail);
    if (!bgNames) return;

    // check if the item was selected before the rename operation
    const wasSelected = background_settings.name === bgNames.oldBg;

    try {
        const response = await fetch('/api/backgrounds/rename', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ old_bg: bgNames.oldBg, new_bg: bgNames.newBg }),
        });

        if (!response.ok) {
            throw new Error(`Failed to rename: ${await response.text()}`);
        }

        const updatedImageData = await response.json();

        // Update the client-side data model in-place.
        const imageToUpdate = backgroundSelector.images.find(img => img.filename === bgNames.oldBg);
        const filteredImageToUpdate = backgroundSelector.filteredImages.find(img => img.filename === bgNames.oldBg);

        if (imageToUpdate) {
            Object.assign(imageToUpdate, {
                ...updatedImageData, // Get fresh data from server
                id: updatedImageData.filename,
                thumbnailUrl: getThumbnailUrl(updatedImageData.filename),
                fullResUrl: getBackgroundPath(updatedImageData.filename),
            });
        }
        // Also update the filtered list if the item is present there
        if (filteredImageToUpdate) {
             Object.assign(filteredImageToUpdate, {
                ...updatedImageData,
                id: updatedImageData.filename,
                thumbnailUrl: getThumbnailUrl(updatedImageData.filename),
                fullResUrl: getBackgroundPath(updatedImageData.filename),
            });
        }

        // Perform a targeted DOM update.
        const thumbnailElements = document.querySelectorAll(`.thumbnail[data-bgfile="${bgNames.oldBg}"]`);
        thumbnailElements.forEach(thumb => {
            const newFilenameWithoutExt = updatedImageData.filename.substring(0, updatedImageData.filename.lastIndexOf('.')) || updatedImageData.filename;

            const $thumb = $(thumb);
            $thumb.attr('data-bgfile', updatedImageData.filename);
            $thumb.attr('data-url', getBackgroundPath(updatedImageData.filename));
            $thumb.attr('title', updatedImageData.filename);

            const titleDiv = thumb.querySelector('.BGSampleTitle');
            if (titleDiv) {
                titleDiv.textContent = newFilenameWithoutExt;
            }
        });


        // If the renamed item was the selected one, update global settings.
        if (wasSelected) {
            background_settings.name = updatedImageData.filename;
        }

    } catch (error) {
        console.error(error);
        toastr.warning(translate('Failed to rename background'));
    }
}

/**
 * Event handler for deleting a background.
 * @param {Event} e - The click event.
 * @returns {Promise<void>}
 */
async function onDeleteBackgroundClick(e) {
    e.stopPropagation();
    const thumbnailElement = this.closest('.thumbnail');
    const bgToDelete = $(thumbnailElement);
    const bg = bgToDelete.data('bgfile');

    const confirm = await Popup.show.confirm(t`Delete the background?`, null);
    if (!confirm) return;

    try {
        const response = await fetch('/api/backgrounds/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ bg }),
        });

        if (!response.ok) {
            throw new Error(`Failed to delete background: ${await response.text()}`);
        }

        // On success, remove the image from the client-side data and re-render.
        const indexToDelete = backgroundSelector.images.findIndex(img => img.filename === bg);
        if (indexToDelete !== -1) {
            backgroundSelector.images.splice(indexToDelete, 1);
        }

        // Re-run the current search/filter to update the UI instantly.
        backgroundSelector.search($('#bg-filter').val() || '');

    } catch (error) {
        console.error(error);
        toastr.error('Failed to delete background.');
    }
}

const autoBgPrompt = 'Ignore previous instructions and choose an image ONLY from the provided list that is the most suitable for the current scene. Do not output any other text:\n{0}';

/**
 * Slash command callback to automatically select a background based on chat context.
 * @returns {Promise<string>} An empty string to clear the input.
 */
async function autoBackgroundCommand() {
    if (!backgroundSelector || backgroundSelector.images.length === 0) {
        toastr.warning(translate('No backgrounds to choose from. Please upload some images.'));
        return '';
    }
    const options = backgroundSelector.images.map(img => ({ element: null, text: img.filename.replace(/\.[^/.]+$/, '') }));
    const list = options.map(option => `- ${option.text}`).join('\n');
    const prompt = stringFormat(autoBgPrompt, list);

    const reply = await generateQuietPrompt({ quietPrompt: prompt });
    const fuse = new Fuse(options, { keys: ['text'], threshold: 0.25 });

    const bestMatch = fuse.search(reply, { limit: 1 });
    if (bestMatch.length === 0) {
        toastr.warning(translate('No match found.'));
        return '';
    }
    const matchedFilename = backgroundSelector.images.find(img => img.filename.startsWith(bestMatch[0].item.text))?.filename;
    if (matchedFilename) {
        const thumbnail = document.querySelector(`.thumbnail[data-bgfile="${matchedFilename}"]`);
        if (thumbnail) $(thumbnail).trigger('click');
    }
    return '';
}

/**
 * Sets the main background image of the application.
 * @param {string} bg - The filename of the background.
 * @param {string} url - The CSS URL string for the background.
 * @returns {Promise<void>}
 */
async function setBackground(bg, url) {
    $('#bg1').css('background-image', url);
    background_settings.name = bg;
    background_settings.url = url;
    saveSettingsDebounced();
}

/**
 * Handles the selection of a file for background upload.
 * @returns {Promise<void>}
 */
async function onBackgroundUploadSelected() {
    const form = document.getElementById('form_bg_upload');
    if (!(form instanceof HTMLFormElement)) return;
    const formData = new FormData(form);

    // Check if a file was actually selected
    if (!formData.get('avatar') || formData.get('avatar').size === 0) {
        form.reset();
        return;
    }

    try {
        const response = await fetch('/api/backgrounds/upload', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }), // Important for FormData
            body: formData,
        });

        if (!response.ok) {
            const errorText = await response.text();
            toastr.error(`Upload failed: ${errorText}`);
            throw new Error(`Upload failed: ${errorText}`);
        }

        const newImageData = await response.json();

        // Create the client-side representation of the new image
        const newImageClientData = {
            ...newImageData,
            id: newImageData.filename,
            thumbnailUrl: getThumbnailUrl(newImageData.filename),
            fullResUrl: getBackgroundPath(newImageData.filename),
            isCustom: false,
        };

        // Add the new image to the master data list and re-render
        backgroundSelector.images.push(newImageClientData);
        // Keep the master list sorted
        backgroundSelector.images.sort((a,b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
        // Re-run the current search/filter to update the displayed list
        backgroundSelector.search($('#bg-filter').val() || '');

        // Use a timeout to ensure the DOM has updated before we try to find the new element
        setTimeout(() => {
            const newThumb = document.querySelector(`.thumbnail[data-bgfile="${newImageData.filename}"]`);
            if (newThumb) {
                highlightNewBackground(newThumb);
            }
        }, 100);

    } catch (error) {
        console.error('Error uploading background:', error);
        // If an error toast wasn't already shown, show a generic one.
        const errorToast = document.querySelector('.toast-error');
        if (!errorToast) {
            toastr.error('Failed to upload background.');
        }
    } finally {
        form.reset();
    }
}

/**
 * Converts a video file to animated WebP if the extension is available,
 * and generates a static thumbnail for it.
 * @param {FormData} formData - The FormData object containing the file.
 * @returns {Promise<void>}
 */
async function convertFileIfVideo(formData) {
    const file = formData.get('avatar');
    if (!(file instanceof File) || !file.type.startsWith('video/')) return;
    if (typeof globalThis.convertVideoToAnimatedWebp !== 'function') {
        toastr.warning(t`Click here to install the Video Background Loader extension`, t`Video background uploads require an add-on`, {
            timeOut: 0, extendedTimeOut: 0,
            onclick: () => openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-VideoBackgroundLoader'),
        });
        throw new Error('Video conversion extension not available.');
    }
    let toastMessage;
    try {
        toastMessage = toastr.info(t`Preparing video for upload...`, t`Please wait`, { timeOut: 0 });

        // Convert the video to an animated WebP in memory
        const sourceBuffer = await file.arrayBuffer();
        const convertedBuffer = await globalThis.convertVideoToAnimatedWebp({ buffer: new Uint8Array(sourceBuffer), name: file.name });
        const convertedFile = new File([convertedBuffer], file.name.replace(/\.[^/.]+$/, '.webp'), { type: 'image/webp' });
        formData.set('avatar', convertedFile);

        // Generate a static thumbnail from the original video
        const staticThumbnailBlob = await createVideoThumbnail(file, {
            format: 'image/webp',
            quality: 0.9,
            maxWidth: THUMBNAIL_CONFIG.width,
            maxHeight: THUMBNAIL_CONFIG.height,
        });

        // Upload the static thumbnail and wait for it to succeed
        const thumbFormData = new FormData();
        thumbFormData.append('avatar', staticThumbnailBlob, convertedFile.name);
        const uploadUrl = `/api/thumbnails/upload-generated?originalFilename=${encodeURIComponent(convertedFile.name)}`;

        const thumbResponse = await fetch(uploadUrl, {
            method: 'POST',
            headers: getHeadersForFormData(),
            body: thumbFormData,
        });

        if (!thumbResponse.ok) {
            throw new Error(`Static thumbnail upload failed with status: ${thumbResponse.status}`);
        }

        // Only after the thumbnail is confirmed saved, upload the main animated background
        await uploadBackground(formData);

        toastMessage.remove();
    } catch (error) {
        toastMessage?.remove();
        console.error('Error during video conversion or upload process:', error);
        toastr.error(t`Error converting video to animated webp`);
        throw error;
    }
}

/**
 * Uploads a background image to the server.
 * @param {FormData} formData - The FormData object containing the image file.
 * @returns {Promise<void>}
 */
async function uploadBackground(formData) {
    try {
        if (!formData.has('avatar')) {
            console.log('No file provided. Background upload cancelled.');
            return;
        }

        const response = await fetch('/api/backgrounds/upload', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
        });
        if (!response.ok) throw new Error(`Upload failed: ${await response.text()}`);
        const bg = await response.text();
        await getBackgrounds(true);
        setTimeout(() => highlightNewBackground(bg), 100);
    } catch (error) {
        console.error('Error uploading background:', error);
        toastr.error(translate('Failed to upload background.'));
    }
}

/**
 * Scrolls to and highlights a newly added background thumbnail.
 * @param {HTMLElement} newBgElement - The DOM element of the new background thumbnail.
 */
function highlightNewBackground(newBgElement) {
    if (newBgElement) {
        newBgElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashHighlight($(newBgElement));
        // Simulate a click to select it
        newBgElement.click();
    }
}

/**
 * Sets the CSS fitting class for the background images.
 * @param {string} fitting - The fitting class (e.g., 'cover', 'contain').
 */
function setFittingClass(fitting) {
    const backgrounds = $('#bg1, #bg_custom');
    backgrounds.removeClass('cover contain stretch center').addClass(fitting);
    background_settings.fitting = fitting;
}

/**
 * Event handler for input on the background filter field.
 */
function onBackgroundFilterInput() {
    const filterValue = String($(this).val());
    if (backgroundSelector) {
        backgroundSelector.debouncedSearch(filterValue);
    }
}

/**
 * Calculates the layout for a row of images to achieve a justified gallery effect.
 * @param {number} containerWidth - The width of the container.
 * @param {Array<object>} images - An array of image data objects.
 * @param {boolean} forceJustify - If true, the last row will be stretched to fill the width.
 * @returns {Array<object>} An array of row data, each containing images and calculated height.
 */
function calculateRowLayout(containerWidth, images, forceJustify = false, targetRowHeight = 110) {
    const rows = [];
    if (!images || images.length === 0 || containerWidth <= 0) return rows;
    const rowGap = 5;
    let currentRow = [];
    let currentRowSummedAspectRatio = 0;

    images.forEach(image => {
        const aspectRatio = image.aspectRatio || 1.77;
        const prospectiveTotalAspectRatio = currentRowSummedAspectRatio + aspectRatio;
        const prospectiveWidth = (prospectiveTotalAspectRatio * targetRowHeight) + (currentRow.length * rowGap);

        if (currentRow.length > 0 && prospectiveWidth > containerWidth) {
            const totalGapWidth = (currentRow.length - 1) * rowGap;
            const rowHeight = Math.floor((containerWidth - totalGapWidth) / currentRowSummedAspectRatio);
            rows.push({ images: currentRow, height: rowHeight });
            currentRow = [image];
            currentRowSummedAspectRatio = aspectRatio;
        } else {
            currentRow.push(image);
            currentRowSummedAspectRatio += aspectRatio;
        }
    });

    if (currentRow.length > 0) {
        if (forceJustify) {
            const totalGapWidth = (currentRow.length - 1) * rowGap;
            const rowHeight = Math.floor((containerWidth - totalGapWidth) / currentRowSummedAspectRatio);
            rows.push({ images: currentRow, height: rowHeight });
        } else {
            rows.push({ images: currentRow, height: targetRowHeight });
        }
    }
    return rows;
}

/**
 * Calculates the dimensions of an image based on its aspect ratio and the calculated row height.
 * @param {number} aspectRatio - The aspect ratio of the image (width / height).
 * @param {number} rowHeight - The exact height for the image within its calculated row.
 * @returns {{width: number, height: number}} The calculated width and height.
 */
function calculateImageSize(aspectRatio, rowHeight) {
    const width = Math.round(rowHeight * aspectRatio);
    const height = Math.round(rowHeight);
    return { width, height };
}

/**
 * Creates a row element containing multiple thumbnail elements.
 * @param {object} rowData - Data for the row, including images and calculated height.
 * @returns {HTMLElement} The created row element.
 */
function createRowElement(rowData) {
    const rowElement = document.createElement('div');
    rowElement.className = 'thumbnail-row';
    rowData.images.forEach((imageData) => {
        const aspectRatio = imageData.aspectRatio || 1.77;
        const calculatedSize = calculateImageSize(aspectRatio, rowData.height);
        const thumbnail = createThumbnailElement(imageData, calculatedSize);
        rowElement.appendChild(thumbnail);
    });
    return rowElement;
}

/**
 * Opens a modal popup gallery displaying only the starred backgrounds.
 * The layout is calculated dynamically based on the panel's width.
 */
function openStarredPopup() {
    const template = document.getElementById('starred-popup-template');
    const popupFragment = template.content.cloneNode(true);
    const popupOverlay = popupFragment.querySelector('.starred-popup-overlay');
    const popupPanel = popupFragment.querySelector('.starred-popup-panel');
    const contentArea = popupFragment.querySelector('.starred-popup-content');

    let isClosing = false;
    let observer;

    // A list of all events that could possibly trigger "click-outside" logic.
    const SHIELD_EVENTS = ['mousedown', 'pointerdown', 'touchstart'];

    const eventShield = (e) => {
        // If the event started anywhere inside our popup's overlay, kill it immediately.
        if (e.target.closest('.starred-popup-overlay')) {
            e.stopImmediatePropagation();
        }
    };

    /**
     * Attaches the shield listeners.
     */
    const activateShield = () => {
        SHIELD_EVENTS.forEach(eventName => {
            document.addEventListener(eventName, eventShield, true);
        });
        document.addEventListener('keydown', handleKeyDown, true);
    };

    /**
     * Removes the shield listeners during cleanup.
     */
    const deactivateShield = () => {
        SHIELD_EVENTS.forEach(eventName => {
            document.removeEventListener(eventName, eventShield, true);
        });
        document.removeEventListener('keydown', handleKeyDown, true);
    };

    const renderContent = () => {
        const starredImages = backgroundSelector.images.filter(img => img.isStarred);
        contentArea.innerHTML = ''; // Clear previous content

        if (starredImages.length === 0) {
            closePopup();
            return;
        }

        // Measure the reliable parent panel and account for the content area's padding.
        const style = getComputedStyle(contentArea);
        const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const usableWidth = popupPanel.clientWidth - paddingX;

        // If width is not yet available, try again on the next frame.
        if (usableWidth <= 0) {
            requestAnimationFrame(renderContent);
            return;
        }

        const thumbnailContainer = document.createElement('div');
        thumbnailContainer.className = 'thumbnail-container';

        // Calculate and create the justified grid layout.
        const rows = calculateRowLayout(usableWidth, starredImages, false);
        rows.forEach(rowData => {
            const rowElement = createRowElement(rowData);
            thumbnailContainer.appendChild(rowElement);
        });

        contentArea.appendChild(thumbnailContainer);

        // Set up IntersectionObserver for lazy-loading thumbnails.
        if (observer) observer.disconnect();
        observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const thumbElement = entry.target;
                    observer.unobserve(thumbElement);
                    backgroundSelector.loadSingleThumbnail(thumbElement);
                }
            });
        }, { root: contentArea, rootMargin: '300px 0px' });

        thumbnailContainer.querySelectorAll('.thumbnail').forEach(thumb => observer.observe(thumb));
    };

    /**
     * Closes the popup, performs cleanup, and removes event listeners.
     */
    const closePopup = () => {
        if (isClosing) return;
        isClosing = true;

        deactivateShield();
        popupOverlay.removeEventListener('click', handlePopupClick)

        if (observer) observer.disconnect();

        popupOverlay.classList.remove('open');

        // Wait for the fade-out animation to complete before removing from the DOM.
        popupOverlay.addEventListener('transitionend', () => popupOverlay.remove(), { once: true });
    };

    /**
     * This function handles the logic of a click.
     * The shield has already stopped the event from propagating.
     * @param {MouseEvent} e - The click event.
     */
    const handlePopupClick = async (e) => {
        const closeButton = e.target.closest('.popup-close-button');
        const jgButton = e.target.closest('.jg-button');
        const thumbnail = e.target.closest('.thumbnail');

        if (closeButton || !e.target.closest('.starred-popup-panel')) {
            closePopup();
            return;
        }

        if (jgButton) {
            e.stopPropagation();
            const action = jgButton.dataset.action;
            const context = jgButton.closest('.thumbnail');
            if (!context) return;
            switch (action) {
                case 'star':
                    await toggleStarredBackground(context.dataset.bgfile);
                    renderContent();
                    break;
                case 'delete':
                    await onDeleteBackgroundClick.call(jgButton, e);
                    renderContent();
                    break;
                case 'edit':
                    await onRenameBackgroundClick.call(jgButton, e);
                    break;
                default:
                    const actionMap = { 'lock': onLockBackgroundClick, 'unlock': onUnlockBackgroundClick };
                    if (actionMap[action]) {
                         actionMap[action].call(context, e);
                    }
                    break;
            }
        }
        else if (thumbnail) {
            onSelectBackgroundClick.call(thumbnail);
            // Optionally close the popup after selection.
            // closePopup();
        }
    };

    /**
     * Handles the 'Escape' key to close the popup.
     * @param {KeyboardEvent} e - The keydown event.
     */
    const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
            if (window.isStCorePopupActive) {
                return;
            }

            e.stopImmediatePropagation();
            closePopup();
        }
    };

    // Activate the shield to block mousedown/pointerdown
    activateShield();

    popupOverlay.addEventListener('click', handlePopupClick);

    document.body.appendChild(popupOverlay);

    // Use requestAnimationFrame to ensure the popup is in the DOM and has layout before we try to render its content and trigger the open animation.
    requestAnimationFrame(() => {
        popupOverlay.classList.add('open');
        renderContent();
    });
}

/**
 * Initializes the background gallery and sets up event listeners.
 * @returns {Promise<void>}
 */
export async function initBackgrounds() {
    if (backgroundSelector) backgroundSelector.destroy();
    backgroundSelector = new BackgroundSelector('bg_menu_content');
    const drawerElement = document.getElementById('Backgrounds');
    if (drawerElement) {
        const checkVisibility = () => {
            const isNowOpen = drawerElement.classList.contains('openDrawer');
            if (isNowOpen && !hasGalleryLoaded && !galleryLoadInProgress) {
                galleryLoadInProgress = true;
                getBackgrounds().finally(() => {
                    hasGalleryLoaded = true;
                    galleryLoadInProgress = false;
                });
            }
        };
        new MutationObserver(checkVisibility).observe(drawerElement, { attributes: true, attributeFilter: ['class'] });
        checkVisibility();
    }

    // Use event delegation for dynamically created elements.
    $(document).off('click', '#starred-folder-button').on('click', '#starred-folder-button', openStarredPopup);

    $(document).off('click', '.jg-button').on('click', '.jg-button', function (e) {
        e.stopPropagation();
        const action = $(this).data('action');
        const thumbnailContext = this.closest('.thumbnail');
        const filename = thumbnailContext.dataset.bgfile;
        switch (action) {
            case 'star': if (filename) toggleStarredBackground(filename); break;
            case 'lock': onLockBackgroundClick.call(thumbnailContext, e); break;
            case 'unlock': onUnlockBackgroundClick.call(thumbnailContext, e); break;
            case 'edit': onRenameBackgroundClick.call(this, e); break; // Pass `this` context for closest()
            case 'delete': onDeleteBackgroundClick.call(this, e); break; // Pass `this` context for closest()
        }
    });
    $(document).off('click', '.thumbnail').on('click', '.thumbnail', onSelectBackgroundClick);
    $('#auto_background').on('click', autoBackgroundCommand);
    $('#add_bg_button').on('change', onBackgroundUploadSelected);
    $('#bg-filter').on('input', onBackgroundFilterInput);
    $('#background_fitting').on('input', function () {
        background_settings.fitting = String($(this).val());
        setFittingClass(background_settings.fitting);
        saveSettingsDebounced();
    });
    $('#background_thumbnails_animation').on('change', function () {
        const isEnabled = $(this).prop('checked');
        background_settings.animation = isEnabled;
        saveSettingsDebounced();
        if (hasGalleryLoaded) {
            hasGalleryLoaded = false;
            galleryLoadInProgress = false;
            if (document.getElementById('Backgrounds').classList.contains('openDrawer')) {
                getBackgrounds(true);
            }
        }
    });
    const commands = [
        { name: 'lockbg', callback: () => onLockBackgroundClick.call($('.thumbnail.selected')[0] || this), aliases: ['bglock'], help: 'Locks the selected background for the current chat.' },
        { name: 'unlockbg', callback: onUnlockBackgroundClick, aliases: ['bgunlock'], help: 'Unlocks the background for the current chat.' },
        { name: 'autobg', callback: autoBackgroundCommand, aliases: ['bgauto'], help: 'Automatically changes the background based on chat context.' },
    ];
    commands.forEach(cmd => SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({ name: cmd.name, callback: cmd.callback, aliases: cmd.aliases, helpString: translate(cmd.help) }),
    ));
    eventSource.on('chatChanged', onChatChanged);
    eventSource.on('characterLoaded', onChatChanged);
}
