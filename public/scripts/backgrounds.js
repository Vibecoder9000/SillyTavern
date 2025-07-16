
import { Fuse, localforage } from '../lib.js';
import { chat_metadata, eventSource, generateQuietPrompt, getCurrentChatId, getRequestHeaders, saveSettingsDebounced } from '../script.js';
import { openThirdPartyExtensionMenu, saveMetadataDebounced } from './extensions.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { flashHighlight, stringFormat, debounce, createThumbnail, getBase64Async } from './utils.js';
import { t, translate } from './i18n.js';
import { Popup } from './popup.js';

const PNG_PIXEL_B64 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const STARRED_BG_STORAGE = localforage.createInstance({ name: 'SillyTavern_StarredBackgrounds' });
let starredBackgrounds = new Set();
const SERVER_THUMBNAIL_CACHE = new Map();
let THUMBNAIL_CONFIG = { width: 160, height: 90 };
let backgroundSelector = null;
let hasGalleryLoaded = false;
let galleryLoadInProgress = false;
const BG_METADATA_KEY = 'custom_background';
const LIST_METADATA_KEY = 'chat_backgrounds';

/**
 * Loads the list of starred backgrounds from local storage.
 * @returns {Promise<void>}
 */
async function loadStarredBackgrounds() {
    const stored = await STARRED_BG_STORAGE.getItem('starred_list');
    starredBackgrounds = stored ? new Set(stored) : new Set();
}

/**
 * Saves the current list of starred backgrounds to local storage.
 * @returns {Promise<void>}
 */
async function saveStarredBackgrounds() {
    await STARRED_BG_STORAGE.setItem('starred_list', Array.from(starredBackgrounds));
}

/**
 * Checks if a background is starred.
 * @param {string} filename - The filename of the background.
 * @returns {boolean}
 */
function isBackgroundStarred(filename) {
    return starredBackgrounds.has(filename);
}

/**
 * Toggles the starred status of a background and updates the UI.
 * @param {string} filename - The filename of the background to toggle.
 * @returns {Promise<void>}
 */
async function toggleStarredBackground(filename) {
    const isCurrentlyStarred = starredBackgrounds.has(filename);
    if (isCurrentlyStarred) {
        starredBackgrounds.delete(filename);
    } else {
        starredBackgrounds.add(filename);
    }
    await saveStarredBackgrounds();

    const isNowStarred = !isCurrentlyStarred;

    const imageInMasterList = backgroundSelector.images.find(img => img.filename === filename);
    if (imageInMasterList) {
        imageInMasterList.isStarred = isNowStarred;
    }
    const imageInFilteredList = backgroundSelector.filteredImages.find(img => img.filename === filename);
    if (imageInFilteredList) {
        imageInFilteredList.isStarred = isNowStarred;
    }

    const mainGalleryThumb = document.querySelector(`#main-backgrounds-container .thumbnail[data-bgfile="${filename}"]`);
    if (mainGalleryThumb) {
        mainGalleryThumb.dataset.isStarred = String(isNowStarred);
    }

    const starredContainer = document.getElementById('starred-backgrounds-container');

    // THE FIX: Use the authoritative width from the backgroundSelector instance.
    // This is the same value the main render() function uses, guaranteeing consistency.
    const containerWidth = backgroundSelector.containerWidth;
    const starredImages = backgroundSelector.filteredImages.filter(img => img.isStarred);
    starredImages.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));

    starredContainer.innerHTML = '';
    if (starredImages.length > 0) {
        const starredRows = calculateRowLayout(containerWidth, starredImages, true);
        starredRows.forEach(rowData => {
            const rowElement = createRowElement(rowData);
            starredContainer.appendChild(rowElement);
        });
    }

    const newThumbs = starredContainer.querySelectorAll('.thumbnail');
    newThumbs.forEach(thumb => backgroundSelector.imageObserver.observe(thumb));

    if (isNowStarred && newThumbs.length === 1) {
        backgroundSelector.loadSingleThumbnail(newThumbs[0]);
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
 * Calculates the layout for a row of images to achieve a justified gallery effect.
 * @param {number} containerWidth - The width of the container.
 * @param {Array<object>} images - An array of image data objects.
 * @returns {Array<object>} An array of row data, each containing images and calculated height.
 */
function calculateRowLayout(containerWidth, images, forceJustify = false) {
    const rows = [];
    if (!images || images.length === 0 || containerWidth <= 0) return rows;
    const rowGap = 5;
    const targetRowHeight = 110;
    let currentRow = [];
    let currentRowSummedAspectRatio = 0;

    images.forEach(image => {
        const aspectRatio = image.aspectRatio || 1.77;
        const prospectiveTotalAspectRatio = currentRowSummedAspectRatio + aspectRatio;
        const prospectiveWidth = (prospectiveTotalAspectRatio * targetRowHeight) + (currentRow.length * rowGap);

        if (currentRow.length > 0 && prospectiveWidth > containerWidth) {
            const totalGapWidth = (currentRow.length - 1) * rowGap;
            const rowHeight = (containerWidth - totalGapWidth) / currentRowSummedAspectRatio;
            rows.push({ images: currentRow, height: rowHeight });
            currentRow = [image];
            currentRowSummedAspectRatio = aspectRatio;
        } else {
            currentRow.push(image);
            currentRowSummedAspectRatio += aspectRatio;
        }
    });

    if (currentRow.length > 0) {
        if (forceJustify && currentRow.length > 5) {
            const totalGapWidth = (currentRow.length - 1) * rowGap;
            const rowHeight = (containerWidth - totalGapWidth) / currentRowSummedAspectRatio;
            rows.push({ images: currentRow, height: rowHeight });
        } else {
            rows.push({ images: currentRow, height: targetRowHeight });
        }
    }
    return rows;
}

/**
 * Calculates the dimensions of an image based on its aspect ratio and target row height.
 * @param {number} aspectRatio - The aspect ratio of the image (width / height).
 * @param {number} rowHeight - The target height for the image within a row.
 * @returns {{width: number, height: number}} The calculated width and height.
 */
function calculateImageSize(aspectRatio, rowHeight) {
    const MIN_THUMB_WIDTH = 60;

    let width = rowHeight * aspectRatio;
    const height = rowHeight; // Height is sacred and must not change for a given row.

    // If the ideal width is unreadably narrow, enforce a minimum width.
    // This will cause a slight aspect ratio distortion for that specific thumbnail,
    // which is the correct trade-off for usability.
    if (width < MIN_THUMB_WIDTH) {
        width = MIN_THUMB_WIDTH;
    }

    return {
        width: Math.round(width),
        height: Math.round(height),
    };
}

/**
 * Creates a single thumbnail DOM element.
 * @param {object} imageData - Data for the image.
 * @param {object} calculatedSize - Calculated size for the thumbnail.
 * @returns {HTMLElement} The created thumbnail element.
 */
function createThumbnailElement(imageData, calculatedSize) {
    console.log(`[CreateThumb] Creating thumbnail for "${imageData.filename}" with data:`, JSON.parse(JSON.stringify(imageData)));
    const thumbnail = document.createElement('div');
    thumbnail.className = 'thumbnail';
    thumbnail.dataset.bgfile = imageData.filename;
    thumbnail.dataset.url = imageData.fullResUrl;
    thumbnail.title = imageData.filename;
    thumbnail.dataset.isStarred = String(imageData.isStarred);
    thumbnail.dataset.isLocked = String(chat_metadata[BG_METADATA_KEY] === `url("${imageData.fullResUrl}")`);
    thumbnail.style.width = `${calculatedSize.width}px`;
    thumbnail.style.height = `${calculatedSize.height}px`;
    if (imageData.isCustom) thumbnail.setAttribute('custom', 'true');
    const placeholder = document.createElement('div');
    placeholder.className = 'thumbnail-placeholder shimmer';
    thumbnail.appendChild(placeholder);
    const imgElement = new Image();
    imgElement.style.opacity = '0';
    imgElement.style.transition = 'opacity 0.4s ease';
    imgElement.dataset.src = imageData.thumbnailUrl;
    imgElement.src = PNG_PIXEL_B64;
    thumbnail.appendChild(imgElement);
    const menu = document.createElement('div');
    menu.className = 'jg-menu';
    menu.innerHTML = `
        <div data-action="star" class="jg-button jg-star fa-fw pointer" title="${translate('Star Background')}"><i class="fa-solid fa-star"></i><i class="fa-regular fa-star"></i></div>
        <div data-action="lock" class="jg-button jg-lock fa-solid fa-lock fa-fw pointer" title="${translate('Lock Background')}"></div>
        <div data-action="unlock" class="jg-button jg-unlock fa-solid fa-unlock fa-fw pointer" title="${translate('Unlock Background')}"></div>
        <div data-action="edit" class="jg-button jg-edit fa-solid fa-pen-to-square fa-fw pointer" title="${translate('Rename Background')}"></div>
        <div data-action="delete" class="jg-button jg-delete fa-solid fa-trash-can fa-fw pointer" title="${translate('Delete Background')}"></div>
    `;
    thumbnail.appendChild(menu);
    const titleDiv = document.createElement('div');
    titleDiv.className = 'BGSampleTitle';
    titleDiv.textContent = imageData.filename.substring(0, imageData.filename.lastIndexOf('.')) || imageData.filename;
    thumbnail.appendChild(titleDiv);
    return thumbnail;
}

/**
 * Creates a row element containing multiple thumbnail elements.
 * @param {object} rowData - Data for the row, including images and height.
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
 * Creates the section for starred backgrounds.
 * @returns {HTMLElement} The created starred section element.
 */
function createStarredSection() {
    const starredSection = document.createElement('div');
    starredSection.id = 'starred-backgrounds-section';
    starredSection.className = 'starred-section';
    const starredTitle = document.createElement('h3');
    starredTitle.className = 'starred-title';
    starredTitle.textContent = translate('Starred Backgrounds');
    const starredContainer = document.createElement('div');
    starredContainer.id = 'starred-backgrounds-container';
    starredContainer.className = 'thumbnail-container';
    starredSection.appendChild(starredTitle);
    starredSection.appendChild(starredContainer);
    return starredSection;
}

/**
 * Separates a list of images into starred and regular categories.
 * @param {Array<object>} allImages - The complete list of image data.
 * @returns {{starred: Array<object>, regular: Array<object>}} An object containing separated lists.
 */
function separateStarredImages(allImages) {
    const starred = allImages.filter(img => img.isStarred);
    const regular = allImages;
    starred.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
    return { starred, regular };
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
				// Re-render if the width has changed. this.containerWidth was set in the last render.
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
        if (!this.container || this.container.clientWidth === 0) return;
        this.isInitialRender = isInitial;
        this.containerWidth = this.container.clientWidth;
        this.imageObserver.disconnect();
        this.container.innerHTML = '';
        if (this.filteredImages.length === 0) {
            this.container.innerHTML = `<p>${translate('No backgrounds found.')}</p>`;
            return;
        }
        const { starred, regular } = separateStarredImages(this.filteredImages);
        const starredSection = createStarredSection();
        const mainContainer = document.createElement('div');
        mainContainer.id = 'main-backgrounds-container';
        mainContainer.className = 'thumbnail-container';
        this.container.appendChild(starredSection);
        this.container.appendChild(mainContainer);
        if (starred.length > 0) {
            const starredContainer = starredSection.querySelector('#starred-backgrounds-container');
            // Force the starred section to always justify its rows.
            const starredRows = calculateRowLayout(this.containerWidth, starred, true);
            starredRows.forEach(rowData => {
                const rowElement = createRowElement(rowData);
                starredContainer.appendChild(rowElement);
            });
        }
        // The regular section should NOT force justification on its last row.
        const regularRows = calculateRowLayout(this.containerWidth, regular, false);
        regularRows.forEach(rowData => {
            const rowElement = createRowElement(rowData);
            mainContainer.appendChild(rowElement);
        });
        const allThumbs = this.container.querySelectorAll('.thumbnail');
        allThumbs.forEach(thumb => this.imageObserver.observe(thumb));
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
        // Defer execution slightly to prevent a race condition.
        setTimeout(() => {
            const scrollContainer = document.getElementById('bg-scrollable-content');
            const btn = document.getElementById('bg_scroll_top'); // This will find the *first* button
            const drawer = document.getElementById('Backgrounds');

            if (!scrollContainer || !btn || !drawer) {
                console.error('Scroll-to-top dependencies not found.');
                return;
            }

            // --- Event Listeners ---

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

            const uploadResponse = await fetch('/api/thumbnails/upload-generated', {
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
        id: imgData.filename,
        filename: imgData.filename,
        thumbnailUrl: getThumbnailUrl(imgData.filename),
        fullResUrl: getBackgroundPath(imgData.filename),
        isStarred: isBackgroundStarred(imgData.filename),
        aspectRatio: imgData.aspectRatio,
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
    document.querySelectorAll('.thumbnail.selected').forEach(thumb => {
        thumb.classList.remove('selected');
    });
    const selectedFilename = background_settings.name;
    if (selectedFilename) {
        const selectedThumb = document.querySelector(`.thumbnail[data-bgfile="${selectedFilename}"]`);
        if (selectedThumb) {
            selectedThumb.classList.add('selected');
        }
    }
}

/**
 * Event handler for selecting a background thumbnail.
 */
function onSelectBackgroundClick() {
    const $this = $(this);
    const bgFile = $this.data('bgfile');
    const fullResUrl = $this.data('url');
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
    const oldBg = $(thumbnailElement).data('bgfile');
    if (!oldBg) return;
    const fileExtension = oldBg.split('.').pop();
    const oldBgExtensionless = oldBg.replace(`.${fileExtension}`, '');
    const newBgExtensionless = await Popup.show.input(t`Enter new background name:`, null, oldBgExtensionless);
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
    const response = await fetch('/api/backgrounds/rename', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ old_bg: bgNames.oldBg, new_bg: bgNames.newBg }),
    });
    if (response.ok) {
        const updatedImageData = await response.json();
        if (isBackgroundStarred(bgNames.oldBg)) {
            starredBackgrounds.delete(bgNames.oldBg);
            starredBackgrounds.add(bgNames.newBg);
            await saveStarredBackgrounds();
        }

        // Find the image in our local data array and update it in place
        const imageIndex = backgroundSelector.images.findIndex(img => img.filename === bgNames.oldBg);
        if (imageIndex !== -1) {
            const imageToUpdate = backgroundSelector.images[imageIndex];
            imageToUpdate.filename = updatedImageData.filename;
            imageToUpdate.thumbnailUrl = getThumbnailUrl(updatedImageData.filename);
            imageToUpdate.fullResUrl = getBackgroundPath(updatedImageData.filename);
            imageToUpdate.aspectRatio = updatedImageData.aspectRatio;
            imageToUpdate.isStarred = isBackgroundStarred(updatedImageData.filename);
        }

        // Trigger a re-render of the gallery with the updated data
        const currentQuery = $('#bg-filter').val() || '';
        backgroundSelector.search(currentQuery);

        setTimeout(() => highlightNewBackground(bgNames.newBg), 100);
    } else {
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
    const bgToDelete = $(this).closest('.thumbnail');
    const isCustom = bgToDelete.attr('custom') === 'true';
    const bg = bgToDelete.data('bgfile');
    const confirm = await Popup.show.confirm(t`Delete the background?`, null);
    if (!confirm) return;
    if (!isCustom) {
        await delBackground(bg);
    }
    if (isBackgroundStarred(bg)) {
        starredBackgrounds.delete(bg);
        await saveStarredBackgrounds();
    }
    await getBackgrounds(true);
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
    const reply = await generateQuietPrompt(prompt, false, false);
    const fuse = new Fuse(options, { keys: ['text'], threshold: 0.4 });
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
 * Deletes a background image from the server.
 * @param {string} bg - The filename of the background to delete.
 * @returns {Promise<void>}
 */
async function delBackground(bg) {
    try {
        const response = await fetch('/api/backgrounds/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ bg }),
        });
        if (!response.ok) {
            toastr.error(translate('Failed to delete background.'));
        }
    } catch (error) {
        console.error('Error deleting background:', error);
        toastr.error(translate('Error deleting background.'));
    }
}

/**
 * Handles the selection of a file for background upload.
 * @returns {Promise<void>}
 */
async function onBackgroundUploadSelected() {
    const form = document.getElementById('form_bg_upload');
    if (!(form instanceof HTMLFormElement)) return;
    const formData = new FormData(form);
    await convertFileIfVideo(formData);
    await uploadBackground(formData);
    form.reset();
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
 * @param {string} bg - The filename of the new background.
 */
function highlightNewBackground(bg) {
    const newBg = $(`.thumbnail[data-bgfile="${bg}"]`);
    if (newBg.length) {
        newBg[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        flashHighlight(newBg);
        newBg.trigger('click');
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
 * Initializes the background gallery and sets up event listeners.
 * @returns {Promise<void>}
 */
export async function initBackgrounds() {
    await loadStarredBackgrounds();
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
    $(document).off('click', '.jg-button').on('click', '.jg-button', function (e) {
        e.stopPropagation();
        const action = $(this).data('action');
        const thumbnailContext = this.closest('.thumbnail');
        const filename = thumbnailContext.dataset.bgfile;
        switch (action) {
            case 'star': if (filename) toggleStarredBackground(filename); break;
            case 'lock': onLockBackgroundClick.call(thumbnailContext, e); break;
            case 'unlock': onUnlockBackgroundClick.call(thumbnailContext, e); break;
            case 'edit': onRenameBackgroundClick.call(thumbnailContext, e); break;
            case 'delete': onDeleteBackgroundClick.call(thumbnailContext, e); break;
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
