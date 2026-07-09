import { chat_metadata, eventSource, generateQuietPrompt, getCurrentChatId, event_types, getRequestHeaders, saveSettingsDebounced } from '../script.js';
import { openThirdPartyExtensionMenu, saveMetadataDebounced } from './extensions.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { flashHighlight, stringFormat, debounce, createThumbnail, getBase64Async } from './utils.js';
import { t, translate } from './i18n.js';
import { Popup } from './popup.js';

const PNG_PIXEL_B64 = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const FOLDER_LIMIT = 100;
const SERVER_THUMBNAIL_CACHE = new Map();
const SERVER_THUMBNAIL_PROMISES = new Map();
const LOCAL_STATIC_THUMBNAIL_CACHE = new Map();
const LOCAL_STATIC_THUMBNAIL_PROMISES = new Map();
const STATIC_THUMBNAIL_PERSIST_PROMISES = new Map();
const STATIC_THUMBNAIL_FAILURE_COOLDOWNS = new Map();
const BACKGROUND_THUMB_ROOT_MARGIN = '600px 0px';
const POPUP_THUMB_ROOT_MARGIN = '150px 0px';
const DESKTOP_MAX_CONCURRENT_THUMBNAIL_LOADS = 10;
const MOBILE_MAX_CONCURRENT_THUMBNAIL_LOADS = 4;
const MAX_CONCURRENT_STATIC_THUMBNAIL_GENERATIONS = 1;
const MAX_CONCURRENT_STATIC_THUMBNAIL_PERSISTS = 1;
const STATIC_THUMBNAIL_RETRY_LIMIT = 3;
const STATIC_THUMBNAIL_RETRY_DELAY_MS = 750;
const STATIC_THUMBNAIL_FAILURE_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
const STATIC_THUMBNAIL_FAILURE_RESET_WIDTH_DELTA = 400;
const THUMBNAIL_RENDER_BATCH_SIZE = 8;
const THUMBNAIL_ROW_GAP = 5;
const DESKTOP_VIRTUAL_OVERSCAN_PX = 1200;
const MOBILE_VIRTUAL_OVERSCAN_PX = 700;
let THUMBNAIL_CONFIG = { width: 160, height: 90 };
let backgroundSelector = null;
let hasGalleryLoaded = false;
let galleryLoadInProgress = false;
const BG_METADATA_KEY = 'custom_background';
const LIST_METADATA_KEY = 'chat_backgrounds';
let backgroundLoadPromise = null;
let backgroundNameMap = null;
const thumbnailElementsByFile = new Map();
const selectedThumbnailElements = new Set();
const lockedThumbnailElements = new Set();
const staticThumbnailGenerationQueue = [];
const staticThumbnailPersistQueue = [];
let lastStaticThumbnailFailureWidth = window.innerWidth;
let lastStaticThumbnailFailureIsMobile = window.innerWidth <= 1000;

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
export function getBackgroundPath(fileUrl) {
    return `backgrounds/${encodeURIComponent(fileUrl)}`;
}

/**
 * Checks if a given URL corresponds to a custom background in the current chat's metadata.
 * @param {string} fileUrl - The URL to check against the chat's custom backgrounds.
 * @returns {boolean} True if the URL corresponds to a custom background, false otherwise.
 */
export function isCustomBackgroundUrl(fileUrl) {
    const customBackgrounds = chat_metadata[LIST_METADATA_KEY] || [];
    return customBackgrounds.some(bg => bg === fileUrl || generateUrlParameter(bg, true) === fileUrl);
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

export let background_settings = {
    name: '__transparent.png',
    url: generateUrlParameter('__transparent.png', false),
    fitting: 'classic',
    animation: true,
    sortOrder: 'alpha',
};

/**
 * Preloads a server thumbnail and caches whether the URL is usable.
 * @param {string} thumbnailUrl - The URL of the thumbnail.
 * @returns {Promise<{ src: string, hasContent: boolean }>} The thumbnail result.
 */
async function getCachedServerThumbnail(thumbnailUrl) {
    if (SERVER_THUMBNAIL_CACHE.has(thumbnailUrl)) {
        return { src: SERVER_THUMBNAIL_CACHE.get(thumbnailUrl), hasContent: true };
    }

    if (SERVER_THUMBNAIL_PROMISES.has(thumbnailUrl)) {
        return SERVER_THUMBNAIL_PROMISES.get(thumbnailUrl);
    }

    const fetchPromise = (async () => {
        try {
            await new Promise((resolve, reject) => {
                const preloadImage = new Image();
                preloadImage.decoding = 'async';
                preloadImage.onload = () => resolve();
                preloadImage.onerror = () => reject(new Error('Thumbnail failed to load'));
                preloadImage.src = thumbnailUrl;
            });

            SERVER_THUMBNAIL_CACHE.set(thumbnailUrl, thumbnailUrl);
            return { src: thumbnailUrl, hasContent: true };
        } catch (error) {
            console.warn(`Failed to load server thumbnail ${thumbnailUrl}:`, error);
            return { src: PNG_PIXEL_B64, hasContent: false };
        } finally {
            SERVER_THUMBNAIL_PROMISES.delete(thumbnailUrl);
        }
    })();

    SERVER_THUMBNAIL_PROMISES.set(thumbnailUrl, fetchPromise);
    return fetchPromise;
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
 * Builds a thumbnail request URL for the requested animation mode.
 * @param {string} baseUrl Base thumbnail URL.
 * @param {boolean} shouldAnimate Whether to allow animated media.
 * @returns {string} Request URL.
 */
function buildThumbnailRequestUrl(baseUrl, shouldAnimate) {
    return `${baseUrl}&animated=${shouldAnimate}`;
}

/**
 * Gets the appropriate thumbnail concurrency for the current viewport.
 * Desktop can keep more requests in flight so scrolling stays ahead of the user.
 * @returns {number} Maximum concurrent thumbnail loads.
 */
function getMaxConcurrentThumbnailLoads() {
    return window.innerWidth <= 1000 ? MOBILE_MAX_CONCURRENT_THUMBNAIL_LOADS : DESKTOP_MAX_CONCURRENT_THUMBNAIL_LOADS;
}

/**
 * Clears in-memory failure cooldowns when the viewport meaningfully changes.
 * This lets desktop and mobile contexts retry independently without causing
 * immediate crash/reload loops on the same constrained layout.
 * @returns {void}
 */
function refreshStaticThumbnailFailureContext() {
    const currentWidth = window.innerWidth;
    const currentIsMobile = currentWidth <= 1000;
    const hasLargeWidthChange = Math.abs(currentWidth - lastStaticThumbnailFailureWidth) >= STATIC_THUMBNAIL_FAILURE_RESET_WIDTH_DELTA;
    const hasModeChange = currentIsMobile !== lastStaticThumbnailFailureIsMobile;

    if (hasLargeWidthChange || hasModeChange) {
        STATIC_THUMBNAIL_FAILURE_COOLDOWNS.clear();
        lastStaticThumbnailFailureWidth = currentWidth;
        lastStaticThumbnailFailureIsMobile = currentIsMobile;
        return;
    }

    lastStaticThumbnailFailureWidth = currentWidth;
    lastStaticThumbnailFailureIsMobile = currentIsMobile;
}

/**
 * Checks whether a file is currently cooling down after repeated failures.
 * @param {string} filename Background filename.
 * @returns {boolean} True if generation should be skipped for now.
 */
function isStaticThumbnailCoolingDown(filename) {
    refreshStaticThumbnailFailureContext();

    const retryAfter = STATIC_THUMBNAIL_FAILURE_COOLDOWNS.get(filename);
    if (!retryAfter) {
        return false;
    }

    if (retryAfter <= Date.now()) {
        STATIC_THUMBNAIL_FAILURE_COOLDOWNS.delete(filename);
        return false;
    }

    return true;
}

/**
 * Starts a temporary cooldown after repeated failures so the same mobile
 * context does not repeatedly load large originals and crash again.
 * @param {string} filename Background filename.
 * @returns {void}
 */
function markStaticThumbnailCooldown(filename) {
    refreshStaticThumbnailFailureContext();
    STATIC_THUMBNAIL_FAILURE_COOLDOWNS.set(filename, Date.now() + STATIC_THUMBNAIL_FAILURE_COOLDOWN_MS);
}

/**
 * Waits for a short period before retrying a temporary failure.
 * @param {number} ms Delay in milliseconds.
 * @returns {Promise<void>}
 */
function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Waits until the next animation frame so long renders can yield to the UI.
 * @returns {Promise<void>}
 */
function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
}

/**
 * Removes disconnected DOM nodes from a thumbnail set.
 * @param {Set<HTMLElement>} elements Elements to prune.
 * @returns {Set<HTMLElement>} The same set after pruning.
 */
function pruneDisconnectedElements(elements) {
    if (!elements) {
        return new Set();
    }

    for (const element of elements) {
        if (!element.isConnected) {
            elements.delete(element);
            selectedThumbnailElements.delete(element);
            lockedThumbnailElements.delete(element);
        }
    }

    return elements;
}

/**
 * Gets tracked thumbnail elements for a specific file.
 * @param {string} filename Background filename.
 * @returns {Set<HTMLElement>} Tracked thumbnail elements.
 */
function getTrackedThumbnailElements(filename) {
    if (!filename) {
        return new Set();
    }

    const elements = thumbnailElementsByFile.get(filename);
    return pruneDisconnectedElements(elements);
}

/**
 * Removes a thumbnail element from the global tracking sets.
 * @param {HTMLElement} element Thumbnail element.
 * @param {string} [filename] Optional filename override.
 * @returns {void}
 */
function untrackThumbnailElement(element, filename = element?.dataset?.bgfile) {
    if (!element || !filename) {
        return;
    }

    const elements = thumbnailElementsByFile.get(filename);
    if (!elements) {
        return;
    }

    elements.delete(element);
    selectedThumbnailElements.delete(element);
    lockedThumbnailElements.delete(element);

    if (elements.size === 0) {
        thumbnailElementsByFile.delete(filename);
    }
}

/**
 * Applies the current custom-background state to one thumbnail.
 * @param {HTMLElement} thumb Thumbnail element.
 * @param {Set<string>} customBgSet Current custom background set.
 * @returns {void}
 */
function applyCustomStateToThumbnail(thumb, customBgSet) {
    const filename = thumb?.dataset?.bgfile;
    if (!filename) {
        return;
    }

    thumb.setAttribute('custom', String(customBgSet.has(filename)));
}

/**
 * Applies the current selection state to one thumbnail.
 * @param {HTMLElement} thumb Thumbnail element.
 * @param {string} selectedFilename Selected background filename.
 * @returns {void}
 */
function applySelectedStateToThumbnail(thumb, selectedFilename) {
    thumb.classList.remove('selected');
    selectedThumbnailElements.delete(thumb);

    if (selectedFilename && thumb.dataset.bgfile === selectedFilename) {
        thumb.classList.add('selected');
        selectedThumbnailElements.add(thumb);
    }
}

/**
 * Applies the current chat-lock state to one thumbnail.
 * @param {HTMLElement} thumb Thumbnail element.
 * @param {string | null} lockedFilename Locked background filename.
 * @returns {void}
 */
function applyLockedStateToThumbnail(thumb, lockedFilename) {
    thumb.dataset.isChatLocked = 'false';
    lockedThumbnailElements.delete(thumb);

    if (lockedFilename && thumb.dataset.bgfile === lockedFilename) {
        thumb.dataset.isChatLocked = 'true';
        lockedThumbnailElements.add(thumb);
    }
}

/**
 * Gets the locked background filename from chat metadata.
 * @returns {string | null} Locked filename, if any.
 */
function getLockedBackgroundFilename() {
    const lockedBackgroundUrl = chat_metadata[BG_METADATA_KEY];
    if (!lockedBackgroundUrl) {
        return null;
    }

    const match = lockedBackgroundUrl.match(/backgrounds\/(.+)"\)$/);
    if (!match || !match[1]) {
        return null;
    }

    return decodeURIComponent(match[1]);
}

/**
 * Tracks a newly created thumbnail element and applies current UI state.
 * @param {HTMLElement} thumb Thumbnail element.
 * @returns {void}
 */
function trackThumbnailElement(thumb) {
    const filename = thumb?.dataset?.bgfile;
    if (!filename) {
        return;
    }

    const elements = thumbnailElementsByFile.get(filename) ?? new Set();
    elements.add(thumb);
    thumbnailElementsByFile.set(filename, elements);

    const customBgSet = new Set(chat_metadata[LIST_METADATA_KEY] || []);
    applyCustomStateToThumbnail(thumb, customBgSet);
    applySelectedStateToThumbnail(thumb, background_settings.name);
    applyLockedStateToThumbnail(thumb, getLockedBackgroundFilename());
}

/**
 * Runs async work with a small concurrency cap so thumbnail generation does not
 * stampede memory usage when several animated items become visible together.
 * @template T
 * @param {Array<() => Promise<T>>} queue Queue storing deferred work functions.
 * @param {{ current: number }} state Mutable active-count holder.
 * @param {number} limit Maximum parallel tasks.
 * @param {() => void} pump Function that continues draining the queue.
 * @param {() => Promise<T>} task The work to schedule.
 * @returns {Promise<T>}
 */
function enqueueLimitedTask(queue, state, limit, pump, task) {
    return new Promise((resolve, reject) => {
        queue.push(async () => {
            state.current++;
            try {
                resolve(await task());
            } catch (error) {
                reject(error);
            } finally {
                state.current--;
                pump();
            }
        });

        if (state.current < limit) {
            pump();
        }
    });
}

const staticGenerationState = { current: 0 };
const staticPersistState = { current: 0 };

/**
 * Drains the local static-thumbnail generation queue.
 * @returns {void}
 */
function processStaticThumbnailGenerationQueue() {
    while (staticGenerationState.current < MAX_CONCURRENT_STATIC_THUMBNAIL_GENERATIONS && staticThumbnailGenerationQueue.length > 0) {
        const nextTask = staticThumbnailGenerationQueue.shift();
        void nextTask();
    }
}

/**
 * Drains the server-persist queue for generated static thumbnails.
 * @returns {void}
 */
function processStaticThumbnailPersistQueue() {
    while (staticPersistState.current < MAX_CONCURRENT_STATIC_THUMBNAIL_PERSISTS && staticThumbnailPersistQueue.length > 0) {
        const nextTask = staticThumbnailPersistQueue.shift();
        void nextTask();
    }
}

/**
 * Retries a thumbnail operation a few times before giving up for this session.
 * Failures are treated as temporary because missing thumbs can be caused by
 * transient browser pressure or a different user profile such as mobile mode.
 * @template T
 * @param {string} label Log label.
 * @param {() => Promise<T>} operation Async work to retry.
 * @returns {Promise<T>}
 */
async function withThumbnailRetries(label, operation) {
    let lastError;

    for (let attempt = 1; attempt <= STATIC_THUMBNAIL_RETRY_LIMIT; attempt++) {
        try {
            return await operation();
        } catch (error) {
            lastError = error;
            console.warn(`${label}: attempt ${attempt}/${STATIC_THUMBNAIL_RETRY_LIMIT} failed.`, error);

            if (attempt < STATIC_THUMBNAIL_RETRY_LIMIT) {
                await wait(STATIC_THUMBNAIL_RETRY_DELAY_MS * attempt);
            }
        }
    }

    throw lastError;
}

/**
 * Completes thumbnail rendering once a source is available.
 * @param {HTMLImageElement} img Image element to update.
 * @param {HTMLElement} thumbElement Thumbnail wrapper.
 * @param {HTMLElement | null} placeholder Placeholder element, if present.
 * @param {string} src Final image source.
 */
function applyLoadedThumbnail(img, thumbElement, placeholder, src) {
    img.onload = () => {
        thumbElement.classList.add('loaded');

        if (placeholder) {
            placeholder.addEventListener('transitionend', () => {
                placeholder.remove();
            }, { once: true });
        }
    };

    img.src = src;
}

/**
 * Generates a static thumbnail data URL for an animated background on demand.
 * This avoids loading the entire library up front while still giving visible
 * items a real preview instead of a placeholder.
 * @param {object} imageData Background metadata.
 * @returns {Promise<string | null>} A local thumbnail data URL, or null on failure.
 */
async function getLocalStaticThumbnail(imageData) {
    if (!imageData?.isAnimated || !imageData?.fullResUrl) {
        return null;
    }

    if (isStaticThumbnailCoolingDown(imageData.filename)) {
        return null;
    }

    if (LOCAL_STATIC_THUMBNAIL_CACHE.has(imageData.filename)) {
        return LOCAL_STATIC_THUMBNAIL_CACHE.get(imageData.filename);
    }

    if (LOCAL_STATIC_THUMBNAIL_PROMISES.has(imageData.filename)) {
        return LOCAL_STATIC_THUMBNAIL_PROMISES.get(imageData.filename);
    }

    const thumbnailPromise = enqueueLimitedTask(
        staticThumbnailGenerationQueue,
        staticGenerationState,
        MAX_CONCURRENT_STATIC_THUMBNAIL_GENERATIONS,
        processStaticThumbnailGenerationQueue,
        async () => withThumbnailRetries(`[ProcessThumb] ${imageData.filename}`, async () => {
            const response = await fetch(imageData.fullResUrl);
            if (!response.ok) {
                throw new Error(`Failed to fetch original file. Server responded with ${response.status} ${response.statusText}`);
            }

            const blob = await response.blob();
            const file = new File([blob], imageData.filename, { type: blob.type });
            const fileDataUrl = await getBase64Async(file);
            const thumbnailDataUrl = await createThumbnail(
                fileDataUrl,
                THUMBNAIL_CONFIG.width,
                THUMBNAIL_CONFIG.height,
                'image/jpeg',
            );

            LOCAL_STATIC_THUMBNAIL_CACHE.set(imageData.filename, thumbnailDataUrl);
            return thumbnailDataUrl;
        }),
    );

    LOCAL_STATIC_THUMBNAIL_PROMISES.set(imageData.filename, thumbnailPromise);

    try {
        const thumbnailDataUrl = await thumbnailPromise;
        STATIC_THUMBNAIL_FAILURE_COOLDOWNS.delete(imageData.filename);
        return thumbnailDataUrl;
    } catch (error) {
        markStaticThumbnailCooldown(imageData.filename);
        console.error(`[ProcessThumb] ${imageData.filename}: FAILED to generate local static thumbnail.`, error);
        return null;
    } finally {
        LOCAL_STATIC_THUMBNAIL_PROMISES.delete(imageData.filename);
    }
}

/**
 * Persists a generated static thumbnail to the server without blocking the UI.
 * Failures stay temporary so the app can retry later instead of poisoning
 * metadata for a file that may only be unavailable in the current context.
 * @param {object} imageData Background metadata.
 * @param {string} thumbnailDataUrl Locally generated static thumbnail.
 * @returns {Promise<void>}
 */
async function persistGeneratedStaticThumbnail(imageData, thumbnailDataUrl) {
    if (!imageData?.filename || !thumbnailDataUrl) {
        return;
    }

    if (STATIC_THUMBNAIL_PERSIST_PROMISES.has(imageData.filename)) {
        return STATIC_THUMBNAIL_PERSIST_PROMISES.get(imageData.filename);
    }

    const persistPromise = enqueueLimitedTask(
        staticThumbnailPersistQueue,
        staticPersistState,
        MAX_CONCURRENT_STATIC_THUMBNAIL_PERSISTS,
        processStaticThumbnailPersistQueue,
        async () => withThumbnailRetries(`[PersistThumb] ${imageData.filename}`, async () => {
            const staticThumbnailBlob = await (await fetch(thumbnailDataUrl)).blob();
            const thumbFormData = new FormData();
            thumbFormData.append('avatar', staticThumbnailBlob, imageData.filename);

            const uploadUrl = `/api/thumbnails/upload-generated?originalFilename=${encodeURIComponent(imageData.filename)}`;
            const uploadResponse = await fetch(uploadUrl, {
                method: 'POST',
                headers: getHeadersForFormData(),
                body: thumbFormData,
            });

            if (!uploadResponse.ok) {
                throw new Error(`Upload failed. Server responded with ${uploadResponse.status} ${uploadResponse.statusText}`);
            }
        }),
    ).catch(error => {
        console.warn(`[PersistThumb] ${imageData.filename}: keeping local thumbnail only for now.`, error);
    }).finally(() => {
        STATIC_THUMBNAIL_PERSIST_PROMISES.delete(imageData.filename);
    });

    STATIC_THUMBNAIL_PERSIST_PROMISES.set(imageData.filename, persistPromise);
    return persistPromise;
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
 * @param {object} [options] - Optional parameters for context-specific rendering.
 * @param {string} [options.currentFolderId] - The ID of the folder being viewed, if any.
 * @returns {HTMLElement} The created thumbnail element.
 */
function createThumbnailElement(imageData, calculatedSize, options = {}) {
    // Get the reusable menu structure from the <template> tag in the HTML.
    const menuTemplate = document.getElementById('thumbnail-menu-template');

    // Create the main container div for the thumbnail.
    const thumbnail = document.createElement('div');
    thumbnail.className = 'thumbnail';
    thumbnail.draggable = true;

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

    // The overlay for bulk selection mode
    const selectionOverlay = document.createElement('div');
    selectionOverlay.className = 'selection-overlay';
    selectionOverlay.innerHTML = '<i class="fa-solid fa-check"></i>';
    thumbnail.appendChild(selectionOverlay);

    const useAnimation = document.getElementById('background_thumbnails_animation').checked && !!imageData.isAnimated;
    const finalUrl = buildThumbnailRequestUrl(imageData.thumbnailUrl, useAnimation);
    const isCached = SERVER_THUMBNAIL_CACHE.has(finalUrl);

    // We only create a placeholder if the image is not in client-side cache.
    if (!isCached) {
        const placeholder = document.createElement('div');
        placeholder.className = 'thumbnail-placeholder';

        if (imageData.dominantColor) {
            placeholder.style.backgroundColor = imageData.dominantColor;
        }
        clipper.appendChild(placeholder);
    }

    const imgElement = new Image();
    imgElement.decoding = 'async';
    imgElement.dataset.src = imageData.thumbnailUrl;
    imgElement.src = PNG_PIXEL_B64;
    clipper.appendChild(imgElement);
    thumbnail.dataset.isAnimated = String(!!imageData.isAnimated);

    const titleDiv = document.createElement('div');
    titleDiv.className = 'BGSampleTitle';
    titleDiv.textContent = imageData.filename.substring(0, imageData.filename.lastIndexOf('.')) || imageData.filename;
    clipper.appendChild(titleDiv);

    const lockIndicator = document.createElement('div');
    lockIndicator.className = 'thumbnail-lock-indicator';
    lockIndicator.innerHTML = '<i class="fa-solid fa-lock"></i>';
    clipper.appendChild(lockIndicator); // Append inside the clipper

    const menuFragment = menuTemplate.content.cloneNode(true);
    thumbnail.appendChild(menuFragment.querySelector('.jg-menu'));

    // If we're inside a folder context, modify the "add to folder" button.
    if (options.currentFolderId) {
        const folderButton = thumbnail.querySelector('[data-action="add-to-folder"]');
        if (folderButton) {
            folderButton.dataset.action = 'remove-from-folder';
            folderButton.dataset.folderId = options.currentFolderId; // Store folderId for the click handler
            folderButton.title = translate('Remove from Folder');
            folderButton.setAttribute('data-i18n', '[title]Remove from Folder');
            folderButton.classList.remove('fa-folder-plus');
            folderButton.classList.add('fa-folder-minus');
        }
    }

    const mobileMenuToggle = document.createElement('div');
    mobileMenuToggle.className = 'mobile-only-menu-toggle';
    mobileMenuToggle.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
    thumbnail.appendChild(mobileMenuToggle);

    trackThumbnailElement(thumbnail);
    return thumbnail;
}

/**
 * Manages the background image gallery, including rendering, filtering, and lazy loading.
 */
class BackgroundSelector {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scrollContainer = document.getElementById('bg-scrollable-content');
        this.images = [];
        this.filteredImages = [];
        this.folderLists = [];
        this.containerWidth = 0;
        this.imageObserver = null;
        this.resizeObserver = null;
        this.activeThumbnailLoads = 0;
        this.thumbnailLoadQueue = [];
        this.isInitialRender = true;
        this.sortOrder = 'alpha';
        this.imageLookup = new Map();
        this.folderImageIndex = new Map();
        this.bulkSelectedFiles = new Set();
        this.virtualRows = [];
        this.virtualRowIndexByFile = new Map();
        this.totalVirtualHeight = 0;
        this.renderedRowRange = { start: -1, end: -1 };
        this.topSpacer = null;
        this.visibleRowsContainer = null;
        this.bottomSpacer = null;
        this.renderedRowElements = new Map();
        this.pendingVisibleRowsUpdate = false;
        this.forceVisibleRowsUpdate = false;
        this.pendingBackgroundAction = null;
        this.onScroll = () => this.scheduleVisibleRowsUpdate();
        this.renderVersion = 0;
        this.debouncedRender = debounce(() => this.render(false), 150);
        this.setupImageObserver();
        this.setupResizeObserver();
        this.debouncedSearch = debounce((query) => this.search(query), 250);
        this.setupVirtualScroll();
        this.setupDropToUpload();
        this.setupScrollToTop();
        window.addEventListener('resize', refreshStaticThumbnailFailureContext, { passive: true });
    }

    getScrollContainer() {
        if (!this.scrollContainer?.isConnected) {
            this.scrollContainer = document.getElementById('bg-scrollable-content');
        }

        return this.scrollContainer;
    }

    setupVirtualScroll() {
        const scrollContainer = this.getScrollContainer();
        if (!scrollContainer) {
            return;
        }

        scrollContainer.removeEventListener('scroll', this.onScroll);
        scrollContainer.addEventListener('scroll', this.onScroll, { passive: true });
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
                    this.queueThumbnailLoad(thumbElement);
                }
            });
        }, { root: this.getScrollContainer(), rootMargin: BACKGROUND_THUMB_ROOT_MARGIN, threshold: 0.01 });
    }

    setData(imageDataList) {
        this.images = imageDataList;
        this.imageLookup = new Map(imageDataList.map(image => [image.filename, image]));
        this.rebuildFolderImageIndex();
        const currentQuery = $('#bg-filter').val() || '';
        this.search(currentQuery);
    }

    rebuildFolderImageIndex() {
        this.folderImageIndex = new Map();

        for (const image of this.images) {
            if (!Array.isArray(image.folderIds)) {
                continue;
            }

            for (const folderId of image.folderIds) {
                const folderImages = this.folderImageIndex.get(folderId) ?? [];
                folderImages.push(image);
                this.folderImageIndex.set(folderId, folderImages);
            }
        }
    }

    search(query, newFilename = null) {
        const lowerQuery = query.toLowerCase().trim();
        if (lowerQuery) {
            this.filteredImages = this.images.filter(img => img.filename.toLowerCase().includes(lowerQuery));
        } else {
            this.filteredImages = [...this.images];
        }

        // Apply sorting to the filtered list before rendering
        this._sortImages(this.filteredImages);
        const scrollContainer = this.getScrollContainer();
        if (scrollContainer) {
            scrollContainer.scrollTop = 0;
        }

        this.render(true, newFilename);
    }

    /**
     * Sorts an array of image data based on the current sortOrder.
     * @param {Array<object>} images - The array of images to sort in-place.
     */
    _sortImages(images) {
        if (this.sortOrder === 'date') {
            images.sort((a, b) => {
                // Default to 0 if timestamp is missing, ensuring they go to the end
                const timeA = a.addedTimestamp || 0;
                const timeB = b.addedTimestamp || 0;

                // Sort by timestamp descending (newest first)
                if (timeB !== timeA) {
                    return timeB - timeA;
                }

                // Fallback to alphabetical for stability if timestamps are equal
                return a.filename.localeCompare(b.filename, undefined, { numeric: true });
            });
        } else { // Default to 'alpha'
            images.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true }));
        }
    }

    /**
     * Renders only the folder section of the background panel.
     */
    renderFolders() {
        const foldersContainerId = 'folders-container';
        let foldersContainer = this.container.querySelector(`#${foldersContainerId}`);

        // If the container doesn't exist, create it. This prevents a premature full render.
        if (!foldersContainer) {
            foldersContainer = document.createElement('div');
            foldersContainer.id = foldersContainerId;
            this.container.appendChild(foldersContainer);
        }

        const fragment = document.createDocumentFragment();

        fragment.appendChild(createStarredFolderElement());

        this.folderLists.forEach((folder) => {
            fragment.appendChild(createBlankFolderElement(folder));
        });

        if (this.folderLists.length < FOLDER_LIMIT) {
            fragment.appendChild(createAddFolderElement());
        }

        foldersContainer.replaceChildren(fragment);
    }

    render(isInitial = false, newFilename = null) {
        return new Promise(resolve => {
            this.isInitialRender = isInitial;
            this.containerWidth = this.container.clientWidth;
            if (this.containerWidth === 0) {
                resolve();
                return;
            }

            const mainContainer = this.container.querySelector('#main-backgrounds-container');

            const renderAndResolve = async () => {
                await this._performRender(newFilename);
                if (mainContainer) {
                    mainContainer.classList.remove('fading-out');
                }
                resolve();
            };

            if (mainContainer && mainContainer.children.length > 0 && !isInitial) {
                mainContainer.classList.add('fading-out');
                mainContainer.addEventListener('transitionend', renderAndResolve, { once: true });
            } else {
                renderAndResolve();
            }
        });
    }

    async _performRender(newFilename = null) {
        this.imageObserver.disconnect();
        this.thumbnailLoadQueue = [];
        const renderVersion = ++this.renderVersion;

        // Ensure the primary containers exist. This only runs on the very first render.
        let foldersContainer = this.container.querySelector('#folders-container');
        if (!foldersContainer) {
            foldersContainer = document.createElement('div');
            foldersContainer.id = 'folders-container';
            this.container.appendChild(foldersContainer);
            this.renderFolders(); // Populate folders only when the container is first created.
        }

        let mainContainer = this.container.querySelector('#main-backgrounds-container');
        if (!mainContainer) {
            mainContainer = document.createElement('div');
            mainContainer.id = 'main-backgrounds-container';
            this.container.appendChild(mainContainer);
        }

        // Clear only the main thumbnail container, leaving the folders untouched.
        mainContainer.replaceChildren();
        mainContainer.className = 'thumbnail-virtualized-container';
        this.topSpacer = null;
        this.visibleRowsContainer = null;
        this.bottomSpacer = null;
        this.renderedRowElements.clear();
        this.renderedRowRange = { start: -1, end: -1 };

        if (this.filteredImages.length === 0) {
            this.virtualRows = [];
            this.virtualRowIndexByFile.clear();
            this.totalVirtualHeight = 0;
            this.renderedRowElements.clear();
            mainContainer.innerHTML = `<p class="no-bgs-found-message">${translate('No backgrounds found.')}</p>`;
            return;
        }

        const isMobile = window.innerWidth <= 1000;
        const targetRowHeight = isMobile ? 80 : 110; // mobile size : desktop size
        const minThumbsPerRow = isMobile ? 2 : 1;

        try {
            const allRows = calculateRowLayout(
                this.containerWidth,
                this.filteredImages,
                false,
                targetRowHeight,
                minThumbsPerRow,
            );
            this.cacheVirtualRows(allRows);
            this.initializeVirtualizedContainers(mainContainer);
            this.updateVisibleRows(true);
        } catch (error) {
            console.error('Failed to render background layout:', error);
            toastr.error('A background has corrupted data and could not be displayed. Check console for details.');
            mainContainer.innerHTML = `<p class="no-bgs-found-message">${translate('Error displaying backgrounds. See console (F12).')}</p>`;
            return;
        }

        // If a new filename was provided, find and highlight it now.
        if (newFilename && renderVersion === this.renderVersion) {
            this.focusBackground(newFilename, { flash: true, click: true });
        }

        setTimeout(() => { this.isInitialRender = false; }, 100);
    }

    cacheVirtualRows(allRows) {
        this.virtualRows = [];
        this.virtualRowIndexByFile.clear();

        let top = 0;
        allRows.forEach((rowData, index) => {
            const row = {
                ...rowData,
                index,
                top,
                bottom: top + rowData.height,
            };
            this.virtualRows.push(row);
            row.images.forEach(image => this.virtualRowIndexByFile.set(image.filename, index));
            top = row.bottom + THUMBNAIL_ROW_GAP;
        });

        this.totalVirtualHeight = this.virtualRows.length > 0
            ? this.virtualRows[this.virtualRows.length - 1].bottom
            : 0;
    }

    initializeVirtualizedContainers(mainContainer) {
        this.topSpacer = document.createElement('div');
        this.topSpacer.className = 'thumbnail-virtualized-spacer';

        this.visibleRowsContainer = document.createElement('div');
        this.visibleRowsContainer.className = 'thumbnail-container';

        this.bottomSpacer = document.createElement('div');
        this.bottomSpacer.className = 'thumbnail-virtualized-spacer';

        mainContainer.append(this.topSpacer, this.visibleRowsContainer, this.bottomSpacer);
    }

    getVirtualOverscanPx() {
        return window.innerWidth <= 1000 ? MOBILE_VIRTUAL_OVERSCAN_PX : DESKTOP_VIRTUAL_OVERSCAN_PX;
    }

    scheduleVisibleRowsUpdate(force = false) {
        if (force) {
            this.forceVisibleRowsUpdate = true;
        }

        if (this.pendingVisibleRowsUpdate) {
            return;
        }

        this.pendingVisibleRowsUpdate = true;
        requestAnimationFrame(() => {
            const forceRender = this.forceVisibleRowsUpdate;
            this.pendingVisibleRowsUpdate = false;
            this.forceVisibleRowsUpdate = false;
            this.updateVisibleRows(forceRender);
        });
    }

    findFirstVisibleRow(offset) {
        if (this.virtualRows.length === 0) {
            return -1;
        }

        let low = 0;
        let high = this.virtualRows.length - 1;
        let result = this.virtualRows.length - 1;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (this.virtualRows[mid].bottom >= offset) {
                result = mid;
                high = mid - 1;
            } else {
                low = mid + 1;
            }
        }

        return result;
    }

    findLastVisibleRow(offset) {
        if (this.virtualRows.length === 0) {
            return -1;
        }

        let low = 0;
        let high = this.virtualRows.length - 1;
        let result = 0;

        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            if (this.virtualRows[mid].top <= offset) {
                result = mid;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }

        return result;
    }

    createVirtualRowElement(rowData) {
        const rowElement = createRowElement(rowData);
        rowElement.dataset.rowIndex = String(rowData.index);
        rowElement.querySelectorAll('.thumbnail').forEach(thumb => {
            if (this.bulkSelectedFiles.has(thumb.dataset.bgfile)) {
                thumb.classList.add('is-bulk-selected');
            }
            this.imageObserver.observe(thumb);
        });
        this.renderedRowElements.set(rowData.index, rowElement);
        return rowElement;
    }

    removeRenderedRow(rowIndex) {
        const rowElement = this.renderedRowElements.get(rowIndex);
        if (!rowElement) {
            return;
        }

        rowElement.querySelectorAll('.thumbnail').forEach(thumb => {
            this.imageObserver.unobserve(thumb);
            untrackThumbnailElement(thumb);
        });
        rowElement.remove();
        this.renderedRowElements.delete(rowIndex);
    }

    clearRenderedRows() {
        for (const rowIndex of Array.from(this.renderedRowElements.keys())) {
            this.removeRenderedRow(rowIndex);
        }
    }

    getVirtualContainerOffset() {
        const scrollContainer = this.getScrollContainer();
        const virtualContainer = this.visibleRowsContainer?.parentElement;
        if (!scrollContainer || !virtualContainer) {
            return 0;
        }

        const scrollRect = scrollContainer.getBoundingClientRect();
        const containerRect = virtualContainer.getBoundingClientRect();
        return (containerRect.top - scrollRect.top) + scrollContainer.scrollTop;
    }

    updateVisibleRows(force = false) {
        if (!this.visibleRowsContainer || this.virtualRows.length === 0) {
            return;
        }

        const scrollContainer = this.getScrollContainer();
        const scrollTop = scrollContainer?.scrollTop ?? 0;
        const viewportHeight = scrollContainer?.clientHeight ?? window.innerHeight;
        const overscan = this.getVirtualOverscanPx();
        const containerOffset = this.getVirtualContainerOffset();
        const galleryScrollTop = Math.max(0, scrollTop - containerOffset);
        const startOffset = Math.max(0, galleryScrollTop - overscan);
        const endOffset = Math.max(0, galleryScrollTop + viewportHeight + overscan);
        const start = this.findFirstVisibleRow(startOffset);
        const end = this.findLastVisibleRow(endOffset);

        if (start < 0 || end < 0) {
            return;
        }

        if (!force && start === this.renderedRowRange.start && end === this.renderedRowRange.end) {
            this.flushPendingBackgroundAction();
            return;
        }

        const nextIndexes = new Set();
        for (let i = start; i <= end; i++) {
            nextIndexes.add(i);
        }

        for (const rowIndex of Array.from(this.renderedRowElements.keys())) {
            if (!nextIndexes.has(rowIndex)) {
                this.removeRenderedRow(rowIndex);
            }
        }

        const orderedRows = [];
        for (let i = start; i <= end; i++) {
            orderedRows.push(this.renderedRowElements.get(i) ?? this.createVirtualRowElement(this.virtualRows[i]));
        }

        this.visibleRowsContainer.replaceChildren(...orderedRows);
        this.topSpacer.style.height = `${this.virtualRows[start].top}px`;
        this.bottomSpacer.style.height = `${Math.max(0, this.totalVirtualHeight - this.virtualRows[end].bottom)}px`;
        this.renderedRowRange = { start, end };
        this.flushPendingBackgroundAction();
    }

    scrollRowIntoView(rowIndex, behavior = 'smooth') {
        const row = this.virtualRows[rowIndex];
        const scrollContainer = this.getScrollContainer();
        if (!row || !scrollContainer) {
            return;
        }

        const containerOffset = this.getVirtualContainerOffset();
        const centeredTop = Math.max(
            0,
            containerOffset + row.top - Math.max(0, (scrollContainer.clientHeight - row.height) / 2),
        );
        const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
        const targetTop = Math.min(centeredTop, maxScrollTop);
        scrollContainer.scrollTo({ top: targetTop, behavior });
    }

    focusBackground(filename, options = {}) {
        if (!filename) {
            return;
        }

        const action = {
            filename,
            flash: !!options.flash,
            click: !!options.click,
        };
        const existingThumb = this.container.querySelector(`.thumbnail[data-bgfile="${filename}"]`);
        if (existingThumb) {
            this.executeBackgroundAction(existingThumb, action);
            return;
        }

        const rowIndex = this.virtualRowIndexByFile.get(filename);
        if (rowIndex === undefined) {
            return;
        }

        this.pendingBackgroundAction = action;
        this.scrollRowIntoView(rowIndex, options.behavior ?? 'smooth');
        this.scheduleVisibleRowsUpdate(true);
    }

    executeBackgroundAction(thumb, action) {
        thumb.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (action.flash) {
            flashHighlight($(thumb));
        }
        if (action.click) {
            thumb.click();
        }
    }

    flushPendingBackgroundAction() {
        if (!this.pendingBackgroundAction) {
            return;
        }

        const thumb = this.container.querySelector(`.thumbnail[data-bgfile="${this.pendingBackgroundAction.filename}"]`);
        if (!thumb) {
            return;
        }

        const action = this.pendingBackgroundAction;
        this.pendingBackgroundAction = null;
        this.executeBackgroundAction(thumb, action);
    }

    queueThumbnailLoad(thumbElement) {
        if (!thumbElement || thumbElement.dataset.thumbnailQueued === 'true') {
            return;
        }

        thumbElement.dataset.thumbnailQueued = 'true';
        this.thumbnailLoadQueue.push(thumbElement);
        this.processThumbnailQueue();
    }

    processThumbnailQueue() {
        const maxConcurrentLoads = getMaxConcurrentThumbnailLoads();

        while (this.activeThumbnailLoads < maxConcurrentLoads && this.thumbnailLoadQueue.length > 0) {
            const thumbElement = this.thumbnailLoadQueue.shift();
            if (!thumbElement || !thumbElement.isConnected) {
                continue;
            }

            this.activeThumbnailLoads++;
            void this.loadSingleThumbnail(thumbElement).finally(() => {
                this.activeThumbnailLoads--;
                this.processThumbnailQueue();
            });
        }
    }

    async loadSingleThumbnail(thumbElement) {
        const img = thumbElement.querySelector('img');
        const placeholder = thumbElement.querySelector('.thumbnail-placeholder');
        if (!img || !img.dataset.src) {
            delete thumbElement.dataset.thumbnailQueued;
            return;
        }

        const baseUrl = img.dataset.src;
        const shouldAnimate = document.getElementById('background_thumbnails_animation').checked && thumbElement.dataset.isAnimated === 'true';
        const finalUrl = buildThumbnailRequestUrl(baseUrl, shouldAnimate);

        const { src, hasContent } = await getCachedServerThumbnail(finalUrl);
        if (!hasContent) {
            if (!shouldAnimate && thumbElement.dataset.isAnimated === 'true') {
                const imageData = this.imageLookup.get(thumbElement.dataset.bgfile);
                const localStaticThumbnail = await getLocalStaticThumbnail(imageData);
                if (localStaticThumbnail) {
                    delete img.dataset.src;
                    applyLoadedThumbnail(img, thumbElement, placeholder, localStaticThumbnail);
                    void persistGeneratedStaticThumbnail(imageData, localStaticThumbnail);
                }
            }

            delete thumbElement.dataset.thumbnailQueued;
            return;
        }

        delete img.dataset.src;
        applyLoadedThumbnail(img, thumbElement, placeholder, src);
        delete thumbElement.dataset.thumbnailQueued;
    }

    setupDropToUpload() {
        const dropZone = this.container.closest('#Backgrounds');
        if (!dropZone) return;

        ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, e => { e.preventDefault(); e.stopPropagation(); });
        });

        // Show the upload overlay only for external files.
        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                if (window.isDraggingInternalThumbnail) {
                    // Indicate that a drop is not allowed here.
                    e.dataTransfer.dropEffect = 'none';
                    return;
                }
                dropZone.classList.add('drag-over');
            });
        });

        // Hide the overlay when dragging leaves or on drop.
        ['dragleave', 'drop'].forEach(eventName => {
            dropZone.addEventListener(eventName, () => dropZone.classList.remove('drag-over'));
        });

        // Handle the actual file drop.
        dropZone.addEventListener('drop', async (e) => {
            // If it's an internal thumbnail, do nothing.
            if (window.isDraggingInternalThumbnail) {
                return;
            }

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

    reapplySelectionStyles(selectedFiles) {
        this.bulkSelectedFiles = new Set(selectedFiles || []);
        this.container.querySelectorAll('.thumbnail.is-bulk-selected').forEach(thumb => {
            thumb.classList.remove('is-bulk-selected');
        });

        // If there are no selected files, we're done
        if (!selectedFiles || selectedFiles.length === 0) return;

        // Otherwise, loop through the provided filenames and apply the class
        selectedFiles.forEach(filename => {
            const thumb = this.container.querySelector(`.thumbnail[data-bgfile="${filename}"]`);
            if (thumb) {
                thumb.classList.add('is-bulk-selected');
            }
        });
    }

    destroy() {
        if (this.imageObserver) this.imageObserver.disconnect();
        if (this.resizeObserver) this.resizeObserver.disconnect();
        this.getScrollContainer()?.removeEventListener('scroll', this.onScroll);
        this.renderVersion++;
        this.imageLookup.clear();
        this.folderImageIndex.clear();
        this.bulkSelectedFiles.clear();
        this.virtualRows = [];
        this.virtualRowIndexByFile.clear();
        this.clearRenderedRows();
        this.pendingBackgroundAction = null;
        pruneDisconnectedElements(selectedThumbnailElements);
        pruneDisconnectedElements(lockedThumbnailElements);
        this.folderLists = [];
        const scrollToTopButton = document.getElementById('bg_scroll_top');
        if (scrollToTopButton) {
            scrollToTopButton.style.display = 'none';
            scrollToTopButton.style.opacity = '0';
            scrollToTopButton.style.pointerEvents = 'none';
        }
    }
}

/**
 * Helper function to create a consistent, searchable name for backgrounds.
 * @param {string} name
 * @returns {string}
 */
function normalizeBgName(name) {
    if (typeof name !== 'string') return '';
    return name
        .toLowerCase()
        .replace(/\.[^/.]+$/, '') // Remove file extension
        .replace(/[\s_()[\]-]/g, ''); // Remove spaces, underscores, parens, brackets, and hyphens
}

/**
 * Fetches background data in two stages: folders first, then images.
 * @returns {Promise<void>}
 */
export async function getBackgrounds() {
    try {
        const folderRequest = fetch('/api/backgrounds/folders', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });

        const imageRequest = fetch('/api/backgrounds/all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });

        // Stage 1: Render folders as soon as that smaller payload arrives.
        const folderResponse = await folderRequest;
        if (!folderResponse.ok) throw new Error(`Folder fetch failed: ${folderResponse.statusText}`);
        const { config, folders = [] } = await folderResponse.json();

        if (config) Object.assign(THUMBNAIL_CONFIG, config);

        if (backgroundSelector) {
            backgroundSelector.folderLists = folders;
            backgroundSelector.renderFolders();
        }

        // Stage 2: Finish the image list request that was already started in parallel.
        const imageResponse = await imageRequest;
        if (!imageResponse.ok) throw new Error(`Image fetch failed: ${imageResponse.statusText}`);
        const { images: imagesFromServer = [] } = await imageResponse.json();

        const imageDataList = imagesFromServer.map(imgData => ({
            ...imgData,
            id: imgData.filename,
            thumbnailUrl: getThumbnailUrl(imgData.filename),
            fullResUrl: getBackgroundPath(imgData.filename),
            isStarred: !!imgData.isStarred,
            isCustom: false,
        }));

        // Build the lookup map supporting multiple file types per name.
        backgroundNameMap = new Map();
        imageDataList.forEach(img => {
            const normalizedName = normalizeBgName(img.filename);
            if (!backgroundNameMap.has(normalizedName)) {
                backgroundNameMap.set(normalizedName, []);
            }
            backgroundNameMap.get(normalizedName).push(img);
        });

        if (backgroundSelector) {
            backgroundSelector.setData(imageDataList);
            const hasInvalidFolderThumbnail = backgroundSelector.folderLists.some(folder => folder.thumbnailFile && !backgroundSelector.imageLookup.has(folder.thumbnailFile));
            if (hasInvalidFolderThumbnail) {
                backgroundSelector.renderFolders();
            }
            updateStateFromChatMetadata();
            highlightSelectedBackground();
        }
    } catch (error) {
        console.error('Failed to get background data:', error);
        toastr.error('Could not load backgrounds.');
    }
}

/**
 * Finds a background by a partial name from the master list and applies it.
 * @param {string} name - The partial or full name of the background to find.
 * @returns {Promise<boolean>} - True on success, false on failure.
 */
export async function findAndSetBackgroundByName(name) {
    if (!backgroundLoadPromise) {
        backgroundLoadPromise = getBackgrounds();
    }
    await backgroundLoadPromise;

    if (!backgroundNameMap) {
        console.error('[LiveBG] Background lookup map is not available.');
        return false;
    }

    // Step 1: Parse the AI's input into a base name.
    const extensionMatch = name.match(/\.(png|jpg|jpeg|webp|gif)$/i);
    const commandExtension = extensionMatch ? extensionMatch[1].toLowerCase() : null;
    const commandBaseName = commandExtension ? name.substring(0, name.length - extensionMatch[0].length) : name;
    const normalizedSearchTerm = normalizeBgName(commandBaseName);

    let candidateKeys = [];

    // Step 2: Find all potential matches where the search term starts with a known key.
    for (const key of backgroundNameMap.keys()) {
        if (normalizedSearchTerm.startsWith(key)) {
            // "Whole word" check: ensure the match isn't just a prefix of a longer word.
            const charAfterMatch = normalizedSearchTerm[key.length];
            if (charAfterMatch === undefined || !/[a-z0-9]/.test(charAfterMatch)) {
                candidateKeys.push(key);
            }
        }
    }

    if (candidateKeys.length === 0) {
        // This is expected for incomplete commands and is not an error.
        return false;
    }

    // Step 3: Choose the most specific (longest) base name key.
    candidateKeys.sort((a, b) => b.length - a.length);
    const bestKey = candidateKeys[0];
    const candidateImages = backgroundNameMap.get(bestKey); // This is now an array of images
    let foundImage = null;

    // Step 4: Find the correct image from the candidates.
    if (commandExtension) {
        // If an extension was specified, find the exact match in the array.
        foundImage = candidateImages.find(img => {
            const fileExtension = img.filename.split('.').pop().toLowerCase();
            return fileExtension === commandExtension;
        });
    } else {
        // If no extension was specified.
        const preferredExtensions = ['webp', 'gif', 'png', 'jpg', 'jpeg'];
        for (const ext of preferredExtensions) {
            foundImage = candidateImages.find(img => img.filename.toLowerCase().endsWith(`.${ext}`));
            if (foundImage) break;
        }
        // Fallback.
        if (!foundImage && candidateImages.length > 0) {
            foundImage = candidateImages[0];
        }
    }

    if (foundImage) {
        const url = generateUrlParameter(foundImage.filename, false);
        await setBackground(foundImage.filename, url);
        return true;
    }

    // This warning will only trigger if the specific extension isn't found.
    if (commandExtension) {
        console.warn(`[LiveBG Debug] No match found for "${normalizedSearchTerm}" with extension ".${commandExtension}"`);
    }

    return false;
}

/**
 * Loads background settings from user preferences and applies them.
 * @param {object} settings - The user settings object.
 */
export function loadBackgroundSettings(settings) {
    let backgroundSettings = settings.background;
    if (!backgroundSettings || !backgroundSettings.name || !backgroundSettings.url) {
        console.log('[Backgrounds Logic] No valid background settings found, using defaults.');
        backgroundSettings = background_settings;
    }
    if (!backgroundSettings.fitting) backgroundSettings.fitting = 'classic';
    if (!Object.hasOwn(backgroundSettings, 'animation')) backgroundSettings.animation = true;
    if (!backgroundSettings.sortOrder) backgroundSettings.sortOrder = 'alpha';
    background_settings.animation = backgroundSettings.animation;
    background_settings.sortOrder = backgroundSettings.sortOrder;

    setBackground(backgroundSettings.name, backgroundSettings.url);

    setFittingClass(backgroundSettings.fitting);
    $('#background_fitting').val(backgroundSettings.fitting);
    $('#background_thumbnails_animation').prop('checked', background_settings.animation);
    $('#bg-sort-order').val(background_settings.sortOrder);
}

/**
 * Handles chat change events, updating background display based on chat metadata.
 */
async function onChatChanged() {
    const lockedUrl = chat_metadata[BG_METADATA_KEY];

    if (lockedUrl) {
        // This chat has a locked background, so apply it directly to the main view.
        $('#bg1').css('background-image', lockedUrl);
    } else {
        // This chat does not have a locked background, so apply the user's global setting.
        $('#bg1').css('background-image', background_settings.url);
    }

    // Update all UI elements to reflect the current state.
    highlightSelectedBackground();
    highlightLockedBackground();
    updateLockButtonState();
}

/**
 * Updates the top bar lock/unlock button's appearance and text
 */
function updateLockButtonState() {
    const lockButton = $('#bg_lock_button');
    const icon = lockButton.find('i');
    const text = lockButton.find('span');
    const isLocked = hasCustomBackground();

    if (isLocked) {
        icon.removeClass('fa-lock').addClass('fa-unlock');
        text.text(translate('Unlock')).attr('data-i18n', 'Unlock');
        lockButton.attr('title', translate('Unlock background for this chat'))
            .attr('data-i18n', '[title]Unlock background for this chat');
    } else {
        icon.removeClass('fa-unlock').addClass('fa-lock');
        text.text(translate('Lock')).attr('data-i18n', 'Lock');
        lockButton.attr('title', translate('Lock selected background for this chat'))
            .attr('data-i18n', '[title]Lock selected background for this chat');
    }
}

/**
 * Locks the current global background to the active chat.
 * Triggered when the top-bar button shows "Lock" and is clicked.
 */
function onLockBackgroundClick() {
    if (!getCurrentChatId()) {
        toastr.warning(translate('Select a chat to lock the background for it'));
        return;
    }

    // Take the global background's URL and save it to the chat's metadata.
    const urlToLock = background_settings.url;
    saveBackgroundMetadata(urlToLock);

    // Update UI states to reflect the new lock.
    highlightLockedBackground();
    updateLockButtonState();
    toastr.success(translate('Background locked for this chat.'));
}


/**
 * Removes the background lock from the active chat.
 * Triggered when the top-bar button shows "Unlock" and is clicked.
 */
function onUnlockBackgroundClick() {
    // Delete the lock from the chat's metadata.
    removeBackgroundMetadata();

    // Revert the view to the current global background.
    $('#bg1').css('background-image', background_settings.url);

    // Update UI states to reflect the removal of the lock.
    highlightLockedBackground();
    updateLockButtonState();
    toastr.success(translate('Background unlocked for this chat.'));
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
 * Event handler for selecting a background thumbnail.
 */
function onSelectBackgroundClick() {
    $('.thumbnail.mobile-menu-open').removeClass('mobile-menu-open');

    const $this = $(this);
    const bgFile = $this.data('bgfile');
    const fullResUrl = $this.data('url');
    if (!bgFile || !fullResUrl) return;

    const backgroundCssUrl = `url("${fullResUrl}")`;

    // Set the view and update the global background setting.
    setBackground(bgFile, backgroundCssUrl);

    // Conditionally update the lock.
    if (hasCustomBackground()) {
        saveBackgroundMetadata(backgroundCssUrl);
    }

    // Update UI highlights to reflect the changes.
    highlightLockedBackground();
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
    pruneDisconnectedElements(selectedThumbnailElements);
    pruneDisconnectedElements(lockedThumbnailElements);
    for (const elements of thumbnailElementsByFile.values()) {
        pruneDisconnectedElements(elements).forEach(thumb => applyCustomStateToThumbnail(thumb, customBgSet));
    }
    highlightLockedBackground();
}

/**
 * Highlights the background that is currently locked for the chat.
 */
function highlightLockedBackground() {
    pruneDisconnectedElements(lockedThumbnailElements).forEach(thumb => {
        thumb.dataset.isChatLocked = 'false';
    });
    lockedThumbnailElements.clear();

    const lockedFilename = getLockedBackgroundFilename();
    if (lockedFilename) {
        getTrackedThumbnailElements(lockedFilename).forEach(thumb => applyLockedStateToThumbnail(thumb, lockedFilename));
    }
}

/**
 * Creates a folder icon overlay element.
 * @param {boolean} [dark=false] Whether to use the darker folder style.
 * @returns {HTMLDivElement} Folder icon overlay.
 */
function createFolderIconOverlay(dark = false) {
    const iconOverlay = document.createElement('div');
    iconOverlay.className = dark ? 'folder-icon-overlay dark-folder-overlay' : 'folder-icon-overlay';
    const folderIcon = document.createElement('i');
    folderIcon.className = 'fa-solid fa-folder';
    iconOverlay.appendChild(folderIcon);
    return iconOverlay;
}

/**
 * Creates a blank folder element, representing a user-created background list.
 * @param {object} folder - The folder data object.
 * @param {object} [options] - Optional configuration.
 * @param {boolean} [options.withMenu=true] - Whether to include the hover/mobile menus.
 * @returns {HTMLElement} The created container element for the blank folder.
 */
function createBlankFolderElement(folder, options = { withMenu: true }) {
    const button = document.createElement('div');
    button.className = 'folder-button blank-folder-button';
    button.title = folder.name;
    button.dataset.folderId = folder.id;

    const clipper = document.createElement('div');
    clipper.className = 'thumbnail-clipper';
    const addFolderFallback = () => {
        if (!clipper.querySelector('.folder-icon-overlay')) {
            clipper.prepend(createFolderIconOverlay(true));
        }
    };

    if (folder.thumbnailFile) {
        const finalUrl = buildThumbnailRequestUrl(getThumbnailUrl(folder.thumbnailFile), false);

        const imgElement = new Image();
        imgElement.decoding = 'async';
        imgElement.src = PNG_PIXEL_B64; // Start with a placeholder
        clipper.appendChild(imgElement);

        // Asynchronously load the real thumbnail
        getCachedServerThumbnail(finalUrl).then(({ src, hasContent }) => {
            if (!hasContent) {
                imgElement.remove();
                addFolderFallback();
                return;
            }

            imgElement.src = src;
            imgElement.style.opacity = 1;
        });
        imgElement.style.objectFit = 'cover';
        imgElement.style.width = '100%';
        imgElement.style.height = '100%';
        imgElement.style.opacity = 0;
        imgElement.style.transition = 'opacity 0.4s ease';
    } else {
        addFolderFallback();
    }

    const titleDiv = document.createElement('div');
    titleDiv.className = 'BGSampleTitle';
    titleDiv.textContent = folder.name;

    clipper.appendChild(titleDiv);
    button.appendChild(clipper);

    if (options.withMenu) {
        // Create the hover menu
        const menu = document.createElement('div');
        menu.className = 'jg-menu';

        const renameButton = document.createElement('div');
        renameButton.dataset.action = 'rename-folder';
        renameButton.className = 'jg-button jg-edit fa-solid fa-pen-to-square fa-fw pointer';
        renameButton.title = 'Rename Folder';
        renameButton.setAttribute('data-i18n', '[title]Rename Folder');

        const deleteButton = document.createElement('div');
        deleteButton.dataset.action = 'delete-folder';
        deleteButton.className = 'jg-button jg-delete fa-solid fa-trash-can fa-fw pointer';
        deleteButton.title = 'Delete Folder';
        deleteButton.setAttribute('data-i18n', '[title]Delete Folder');

        menu.appendChild(deleteButton);
        menu.appendChild(renameButton);
        button.appendChild(menu);

        const mobileMenuToggle = document.createElement('div');
        mobileMenuToggle.className = 'mobile-only-menu-toggle';
        mobileMenuToggle.innerHTML = '<i class="fa-solid fa-ellipsis-vertical"></i>';
        button.appendChild(mobileMenuToggle);
    }

    return button;
}

/**
 * Creates the "Starred" folder button element.
 * @returns {HTMLElement} The created container element for the folder.
 */
function createStarredFolderElement() {
    const button = document.createElement('div');
    button.id = 'starred-folder-button';
    button.className = 'folder-button';
    button.title = translate('View Starred Backgrounds');

    const clipper = document.createElement('div');
    clipper.className = 'thumbnail-clipper';
    const iconOverlay = createFolderIconOverlay();
    clipper.appendChild(iconOverlay);
    button.appendChild(clipper);

    return button; // Return the button directly
}

/**
 * Creates the "Add" folder button element, styled to look like a thumbnail placeholder.
 * @returns {HTMLElement} The created container element for the add folder.
 */
function createAddFolderElement() {
    const button = document.createElement('div');
    button.id = 'add-folder-button';
    button.className = 'folder-button';
    button.title = translate('Add Background Folder');

    const clipper = document.createElement('div');
    clipper.className = 'thumbnail-clipper';

    const iconOverlay = document.createElement('div');
    iconOverlay.className = 'add-icon-overlay';

    const addIcon = document.createElement('i');
    addIcon.className = 'fa-solid fa-plus';

    iconOverlay.appendChild(addIcon);
    clipper.appendChild(iconOverlay);
    button.appendChild(clipper);

    return button; // Return the button directly
}

/**
 * Handles deleting a custom folder after confirmation.
 * @param {Event} e - The click event.
 * @returns {Promise<void>}
 */
async function onDeleteFolderClick(e) {
    e.stopPropagation();
    const folderButton = this.closest('.blank-folder-button');
    const folderId = folderButton.dataset.folderId;
    const folder = backgroundSelector.folderLists.find(f => f.id === folderId);

    if (!folder) return;

    const confirm = await Popup.show.confirm(translate(`Delete the folder "${folder.name}"? This cannot be undone.`));
    if (!confirm) return;

    try {
        const response = await fetch('/api/backgrounds/folders/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ folderId }),
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
        }

        // On success, update the client-side data to match
        // 1. Remove the folder from the list
        backgroundSelector.folderLists = backgroundSelector.folderLists.filter(f => f.id !== folderId);

        // 2. Remove this folder's ID from any images that have it
        backgroundSelector.images.forEach(image => {
            if (Array.isArray(image.folderIds) && image.folderIds.includes(folderId)) {
                image.folderIds = image.folderIds.filter(id => id !== folderId);
            }
        });
        backgroundSelector.rebuildFolderImageIndex();

        // 3. Re-render the folders UI
        backgroundSelector.renderFolders();
        toastr.success(`Folder "${folder.name}" deleted.`);
    } catch (error) {
        console.error('Failed to delete folder:', error);
        toastr.error('Could not delete folder.');
    }
}

/**
 * Handles renaming a custom folder.
 * @param {Event} e - The click event.
 * @returns {Promise<void>}
 */
async function onRenameFolderClick(e) {
    e.stopPropagation();
    const folderButton = this.closest('.blank-folder-button');
    const folderId = folderButton.dataset.folderId;
    const folder = backgroundSelector.folderLists.find(f => f.id === folderId);

    if (!folder) return;

    const newName = await Popup.show.input(translate('Enter new folder name:'), null, folder.name);

    if (!newName || newName.trim() === '' || newName === folder.name) {
        return; // User cancelled or entered the same/empty name
    }

    try {
        const response = await fetch('/api/backgrounds/folders/rename', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ folderId, newName }),
        });

        if (!response.ok) {
            throw new Error(`Server responded with ${response.status}`);
        }

        // On success, update the client-side data and UI
        folder.name = newName;
        backgroundSelector.renderFolders();
        toastr.success('Folder renamed.');
    } catch (error) {
        console.error('Failed to rename folder:', error);
        toastr.error('Could not rename folder.');
    }
}

/**
 * Highlights the currently selected background thumbnail in the gallery.
 */
function highlightSelectedBackground() {
    pruneDisconnectedElements(selectedThumbnailElements).forEach(thumb => {
        thumb.classList.remove('selected');
    });
    selectedThumbnailElements.clear();

    const selectedFilename = background_settings.name;
    if (selectedFilename) {
        getTrackedThumbnailElements(selectedFilename).forEach(thumb => applySelectedStateToThumbnail(thumb, selectedFilename));
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

    const newBgExtensionless = await Popup.show.input(t`Enter new background name:`, null, oldBgExtensionless, { maxLength: 100 });

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

        // Find the image object in the single source of truth: the master list.
        const imageToUpdate = backgroundSelector.imageLookup.get(bgNames.oldBg);

        // If found, update it in-place.
        if (imageToUpdate) {
            Object.assign(imageToUpdate, {
                ...updatedImageData,
                id: updatedImageData.filename,
                thumbnailUrl: getThumbnailUrl(updatedImageData.filename),
                fullResUrl: getBackgroundPath(updatedImageData.filename),
            });
            backgroundSelector.imageLookup.delete(bgNames.oldBg);
            backgroundSelector.imageLookup.set(updatedImageData.filename, imageToUpdate);
        }
        let shouldRerenderFolders = false;
        backgroundSelector.folderLists.forEach(folder => {
            if (folder.thumbnailFile === bgNames.oldBg) {
                folder.thumbnailFile = updatedImageData.filename;
                shouldRerenderFolders = true;
            }
        });

        // Perform a targeted DOM update.
        const thumbnailElements = document.querySelectorAll(`.thumbnail[data-bgfile="${bgNames.oldBg}"]`);
        const newFilenameWithoutExt = updatedImageData.filename.substring(0, updatedImageData.filename.lastIndexOf('.')) || updatedImageData.filename;
        thumbnailElements.forEach(thumb => {
            untrackThumbnailElement(thumb, bgNames.oldBg);
            const $thumb = $(thumb);
            $thumb.attr('data-bgfile', updatedImageData.filename);
            $thumb.attr('data-url', getBackgroundPath(updatedImageData.filename));
            $thumb.attr('title', updatedImageData.filename);

            const titleDiv = thumb.querySelector('.BGSampleTitle');
            if (titleDiv) {
                titleDiv.textContent = newFilenameWithoutExt;
            }

            trackThumbnailElement(thumb);
        });

        // If the renamed item was the selected one, update global settings.
        if (wasSelected) {
            background_settings.name = updatedImageData.filename;
        }

        if (shouldRerenderFolders) {
            backgroundSelector.renderFolders();
        }

        // Display a notification to the user showing the final filename.
        toastr.success(stringFormat(translate('Renamed to "{0}"'), [updatedImageData.filename]));
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
    const bgFile = thumbnailElement?.dataset?.bgfile;
    if (!bgFile) return;

    const confirm = await Popup.show.confirm(t`Delete the background?`, null);
    if (!confirm) return;

    // 1. Find all DOM elements for this background (main gallery + any popups)
    const thumbnailElements = document.querySelectorAll(`.thumbnail[data-bgfile="${bgFile}"]`);

    // 2. Optimistically apply the 'deleting' class to start the fade-out animation.
    thumbnailElements.forEach(thumb => thumb.classList.add('deleting'));

    try {
        const response = await fetch('/api/backgrounds/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ bg: bgFile }),
        });

        if (!response.ok) {
            throw new Error(`Failed to delete background: ${await response.text()}`);
        }

        // 3. On success, wait for the animation to finish, then remove the element and sync the client-side data.
        thumbnailElements[0]?.addEventListener('transitionend', () => {
            thumbnailElements.forEach(thumb => {
                const row = thumb.parentElement;
                untrackThumbnailElement(thumb, bgFile);
                thumb.remove();
                // If the row becomes empty, remove it to prevent layout gaps.
                if (row && row.classList.contains('thumbnail-row') && row.children.length === 0) {
                    row.remove();
                }
            });

            // Sync the data arrays silently without a re-render.
            const indexToDelete = backgroundSelector.images.findIndex(img => img.filename === bgFile);
            if (indexToDelete > -1) {
                backgroundSelector.images.splice(indexToDelete, 1);
            }
            const filteredIndexToDelete = backgroundSelector.filteredImages.findIndex(img => img.filename === bgFile);
            if (filteredIndexToDelete > -1) {
                backgroundSelector.filteredImages.splice(filteredIndexToDelete, 1);
            }
            backgroundSelector.imageLookup.delete(bgFile);
            backgroundSelector.rebuildFolderImageIndex();
            let shouldRerenderFolders = false;
            backgroundSelector.folderLists.forEach(folder => {
                if (folder.thumbnailFile === bgFile) {
                    folder.thumbnailFile = null;
                    shouldRerenderFolders = true;
                }
            });
            if (shouldRerenderFolders) {
                backgroundSelector.renderFolders();
            }
        }, { once: true });
    } catch (error) {
        console.error(error);
        toastr.error('Failed to delete background.');

        // 4. On failure, revert the optimistic UI change.
        thumbnailElements.forEach(thumb => thumb.classList.remove('deleting'));
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

    if (typeof reply !== 'string' || !reply.trim()) {
        const message = translate('No match found. The AI did not provide a suggestion.');
        toastr.warning(message, null, { timeOut: 5000 });
        console.error('autoBackgroundCommand: generateQuietPrompt returned an invalid reply.', reply);
        return '';
    }

    // Find all background names that are present as substrings in the AI's reply (case-insensitive).
    const foundMatches = options.filter(option =>
        reply.toLowerCase().includes(option.text.toLowerCase()),
    );

    if (foundMatches.length === 0) {
        const message = translate('No match found.');
        toastr.warning(message, null, { timeOut: 5000 });
        return '';
    }

    // From the potential matches, choose the longest one.
    // This correctly handles cases where one name is a substring of another (e.g., "forest" vs. "dark forest").
    const bestMatch = foundMatches.sort((a, b) => b.text.length - a.text.length)[0];

    // The `options` array had the file extension removed, so we must find the full filename
    const matchedFilename = backgroundSelector.images.find(
        img => img.filename.toLowerCase().startsWith(bestMatch.text.toLowerCase()),
    )?.filename;

    if (matchedFilename) {
        backgroundSelector.focusBackground(matchedFilename, { flash: true, click: true });
    }
    return '';
}

/**
 * Sets the main background image of the application.
 * @param {string} bg - The filename of the background.
 * @param {string} url - The CSS URL string for the background.
 */
async function setBackground(bg, url) {
    $('#bg1').css('background-image', url);
    background_settings.name = bg;
    background_settings.url = url;
    saveSettingsDebounced();
    highlightSelectedBackground();
}

/**
 * Adds an uploaded background to the in-memory lists without forcing a redraw.
 * @param {object} uploadedImageData Uploaded background metadata.
 * @returns {void}
 */
function registerUploadedBackground(uploadedImageData) {
    if (!backgroundSelector || !uploadedImageData?.filename) {
        return;
    }

    const normalizedImageData = {
        ...uploadedImageData,
        id: uploadedImageData.filename,
        thumbnailUrl: uploadedImageData.thumbnailUrl ?? getThumbnailUrl(uploadedImageData.filename),
        fullResUrl: uploadedImageData.fullResUrl ?? getBackgroundPath(uploadedImageData.filename),
        isStarred: !!uploadedImageData.isStarred,
        isCustom: false,
    };

    const existingIndex = backgroundSelector.images.findIndex(img => img.filename === normalizedImageData.filename);
    if (existingIndex >= 0) {
        backgroundSelector.images.splice(existingIndex, 1, normalizedImageData);
    } else {
        backgroundSelector.images.push(normalizedImageData);
    }

    backgroundSelector.imageLookup.set(normalizedImageData.filename, normalizedImageData);

    const normalizedName = normalizeBgName(normalizedImageData.filename);
    if (!backgroundNameMap) {
        backgroundNameMap = new Map();
    }

    const candidateImages = backgroundNameMap.get(normalizedName) ?? [];
    const candidateIndex = candidateImages.findIndex(img => img.filename === normalizedImageData.filename);
    if (candidateIndex >= 0) {
        candidateImages.splice(candidateIndex, 1, normalizedImageData);
    } else {
        candidateImages.push(normalizedImageData);
    }
    backgroundNameMap.set(normalizedName, candidateImages);
}

/**
 * Returns the last uploaded filename that would be visible under the current filter.
 * @param {Array<object>} uploadedBackgrounds Uploaded background metadata.
 * @returns {string | null}
 */
function getVisibleUploadedFilename(uploadedBackgrounds) {
    const normalizedFilter = String($('#bg-filter').val() || '').toLowerCase().trim();

    for (let i = uploadedBackgrounds.length - 1; i >= 0; i--) {
        const filename = uploadedBackgrounds[i]?.filename;
        if (filename && (!normalizedFilter || filename.toLowerCase().includes(normalizedFilter))) {
            return filename;
        }
    }

    return null;
}

/**
 * Handles the selection of a file for background upload.
 * @returns {Promise<void>}
 */
async function onBackgroundUploadSelected() {
    const form = document.getElementById('form_bg_upload');
    const input = document.getElementById('add_bg_button');
    if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) return;
    const files = Array.from(input.files ?? []).filter(file => file.type.startsWith('image/') || file.type.startsWith('video/'));

    // Check if a file was actually selected
    if (files.length === 0) {
        form.reset();
        return;
    }

    try {
        const imageFiles = files.filter(file => file.type.startsWith('image/'));
        const videoFiles = files.filter(file => file.type.startsWith('video/'));

        if (imageFiles.length > 0) {
            const uploadedImages = await uploadBackgroundBatch(imageFiles);
            const focusFilename = getVisibleUploadedFilename(uploadedImages);
            if (focusFilename) {
                await refreshBackgroundLibrary({ focusFilename, click: true });
            }
        }

        if (videoFiles.length > 0) {
            if (imageFiles.length > 0) {
                toastr.info(t`Image backgrounds were added. Video backgrounds will finish processing in the background.`);
                void uploadBackgroundBatch(videoFiles)
                    .then(async (uploadedVideos) => {
                        const focusFilename = getVisibleUploadedFilename(uploadedVideos);
                        if (focusFilename) {
                            await refreshBackgroundLibrary({ focusFilename, click: false });
                        }
                    })
                    .catch(error => {
                        console.error('Error uploading video backgrounds:', error);
                        const errorToast = document.querySelector('.toast-error');
                        if (!errorToast) {
                            toastr.error('Failed to upload background.');
                        }
                    });
            } else {
                const uploadedVideos = await uploadBackgroundBatch(videoFiles);
                const focusFilename = getVisibleUploadedFilename(uploadedVideos);
                if (focusFilename) {
                    await refreshBackgroundLibrary({ focusFilename, click: true });
                }
            }
        }
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
 * Refreshes the background library and optionally focuses one uploaded item.
 * @param {{ focusFilename?: string | null, click?: boolean }} [options]
 * @returns {Promise<void>}
 */
async function refreshBackgroundLibrary(options = {}) {
    const { focusFilename = null, click = false } = options;
    await getBackgrounds();

    if (focusFilename && backgroundSelector) {
        backgroundSelector.focusBackground(focusFilename, { flash: true, click });
    }
}

/**
 * Uploads a batch of files without refreshing the UI per file.
 * @param {File[]} files Files to upload in order.
 * @returns {Promise<Array<object>>} Uploaded background metadata in upload order.
 */
async function uploadBackgroundBatch(files) {
    const uploadedBackgrounds = [];

    for (const file of files) {
        const formData = new FormData();
        formData.append('avatar', file);
        await convertFileIfVideo(formData);
        const uploadedImageData = await uploadBackground(formData);
        if (uploadedImageData) {
            uploadedBackgrounds.push(uploadedImageData);
            registerUploadedBackground(uploadedImageData);
        }
    }

    return uploadedBackgrounds;
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
 * @returns {Promise<object | null>}
 */
async function uploadBackground(formData) {
    try {
        if (!formData.has('avatar')) {
            console.log('No file provided. Background upload cancelled.');
            return null;
        }

        const response = await fetch('/api/backgrounds/upload', {
            method: 'POST',
            headers: getRequestHeaders({ omitContentType: true }),
            body: formData,
        });
        if (!response.ok) throw new Error(`Upload failed: ${await response.text()}`);

        return await response.json();
    } catch (error) {
        console.error('Error uploading background:', error);
        toastr.error(translate('Failed to upload background.'));
        throw error;
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
 * Sets the CSS fitting class for the main background image.
 * @param {string} fitting - The fitting class (e.g., 'cover', 'contain').
 */
function setFittingClass(fitting) {
    const backgrounds = $('#bg1');
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
function calculateRowLayout(containerWidth, images, forceJustify = false, targetRowHeight = 110, minThumbsPerRow = 1) {
    const rows = [];
    if (!images || images.length === 0 || containerWidth <= 0) return rows;
    const rowGap = 5;
    let currentRow = [];
    let currentRowSummedAspectRatio = 0;

    images.forEach(image => {
        const aspectRatio = image.aspectRatio;
        if (!aspectRatio || typeof aspectRatio !== 'number' || aspectRatio <= 0) {
            const err = new Error(`Invalid or missing aspectRatio for image: ${image.filename}. Check backgrounds.json.`);
            console.error(err.stack);
            throw err;
        }

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
        rows.push({ images: currentRow, height: targetRowHeight });
    }

    // Post-process the rows to merge any that have fewer than the minimum thumbnails.
    if (minThumbsPerRow > 1 && rows.length > 1) {
        // Iterate backwards to safely modify the array.
        for (let i = rows.length - 1; i > 0; i--) {
            const thisRow = rows[i];
            const prevRow = rows[i - 1];

            if (thisRow.images.length < minThumbsPerRow) {
                // This row is an orphan. Merge it with the previous one.
                const mergedImages = prevRow.images.concat(thisRow.images);
                const mergedSummedAspectRatio = mergedImages.reduce((sum, img) => sum + img.aspectRatio, 0);
                const totalGapWidth = (mergedImages.length - 1) * rowGap;
                const mergedRowHeight = Math.floor((containerWidth - totalGapWidth) / mergedSummedAspectRatio);

                // Replace the previous row with the new merged row.
                rows[i - 1] = { images: mergedImages, height: mergedRowHeight };

                // Remove the current (orphan) row from the array.
                rows.splice(i, 1);
            }
        }
    }

    // Justify the last row if needed, after all merging is done.
    if (forceJustify && rows.length > 0) {
        const lastRow = rows[rows.length - 1];
        const lastRowSummedAspectRatio = lastRow.images.reduce((sum, img) => sum + img.aspectRatio, 0);
        const totalGapWidth = (lastRow.images.length - 1) * rowGap;
        lastRow.height = Math.floor((containerWidth - totalGapWidth) / lastRowSummedAspectRatio);
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
 * @param {object} [options] - Optional parameters for context-specific rendering.
 * @returns {HTMLElement} The created row element.
 */
function createRowElement(rowData, options = {}) {
    const rowElement = document.createElement('div');
    rowElement.className = 'thumbnail-row';
    rowData.images.forEach((imageData) => {
        const aspectRatio = imageData.aspectRatio || 1.77;
        const calculatedSize = calculateImageSize(aspectRatio, rowData.height);
        const thumbnail = createThumbnailElement(imageData, calculatedSize, options);
        rowElement.appendChild(thumbnail);
    });
    return rowElement;
}

/**
 * Renders thumbnail rows in small batches so popup galleries do not block the UI.
 * @param {HTMLElement} container Target container for rendered rows.
 * @param {Array<object>} rows Row layout data.
 * @param {{ renderVersion: number, getCurrentRenderVersion: () => number, rowOptions?: object }} options Render options.
 * @returns {Promise<void>}
 */
async function renderThumbnailRowsIncrementally(container, rows, options) {
    const { renderVersion, getCurrentRenderVersion, rowOptions = {} } = options;

    for (let i = 0; i < rows.length; i += THUMBNAIL_RENDER_BATCH_SIZE) {
        if (renderVersion !== getCurrentRenderVersion()) {
            return;
        }

        const fragment = document.createDocumentFragment();
        const batchRows = rows.slice(i, i + THUMBNAIL_RENDER_BATCH_SIZE);

        batchRows.forEach(rowData => {
            fragment.appendChild(createRowElement(rowData, rowOptions));
        });

        container.appendChild(fragment);

        if (i + THUMBNAIL_RENDER_BATCH_SIZE < rows.length) {
            await nextFrame();
        }
    }
}

/**
 * Opens a modal popup gallery displaying only the starred backgrounds.
 * The layout is calculated dynamically based on the panel's width.
 */
function openStarredPopup() {
    const template = document.getElementById('starred-popup-template');
    const popupFragment = template.content.cloneNode(true);
    const popupOverlay = popupFragment.querySelector('.popup-overlay');
    const popupPanel = popupFragment.querySelector('.popup-panel');
    const contentArea = popupFragment.querySelector('.popup-content');
    let isClosing = false;
    let observer;
    let popupRenderVersion = 0;
    const SHIELD_EVENTS = ['mousedown', 'pointerdown', 'touchstart'];

    /**
    * Attaches the shield listeners.
    */
    const eventShield = (e) => { if (e.target.closest('.popup-overlay')) e.stopImmediatePropagation(); };
    const activateShield = () => {
        SHIELD_EVENTS.forEach(eventName => document.addEventListener(eventName, eventShield, true));
        document.addEventListener('keydown', handleKeyDown, true);
    };
    const deactivateShield = () => {
        SHIELD_EVENTS.forEach(eventName => document.removeEventListener(eventName, eventShield, true));
        document.removeEventListener('keydown', handleKeyDown, true);
    };

    const renderContent = async () => {
        const renderVersion = ++popupRenderVersion;
        const starredImages = backgroundSelector.images.filter(img => img.isStarred);
        contentArea.innerHTML = '';
        if (starredImages.length === 0) {
            contentArea.innerHTML = `<p style="text-align: center; padding: 20px;">${translate('You have no starred backgrounds.')}</p>`;
            return;
        }
        // Sort the popup's images according to the global sort setting
        backgroundSelector._sortImages(starredImages);
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

        const isMobile = window.innerWidth <= 1000;
        const minThumbsPerRow = isMobile ? 2 : 1;
        const rows = calculateRowLayout(usableWidth, starredImages, false, 110, minThumbsPerRow);

        await renderThumbnailRowsIncrementally(thumbnailContainer, rows, {
            renderVersion,
            getCurrentRenderVersion: () => popupRenderVersion,
        });
        contentArea.appendChild(thumbnailContainer);
        // Set up IntersectionObserver for lazy-loading thumbnails.
        if (observer) observer.disconnect();
        observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    observer.unobserve(entry.target);
                    backgroundSelector.queueThumbnailLoad(entry.target);
                }
            });
        }, { root: contentArea, rootMargin: POPUP_THUMB_ROOT_MARGIN });
        thumbnailContainer.querySelectorAll('.thumbnail').forEach(thumb => observer.observe(thumb));
        highlightLockedBackground();
    };

    /**
    * Closes the popup, performs cleanup, and removes event listeners.
    */
    const closePopup = () => {
        if (isClosing) return;
        isClosing = true;
        // Disconnect the observer immediately as it's tied to scrolling, not clicks.
        if (observer) observer.disconnect();
        // Start the closing animation.
        popupOverlay.classList.remove('open');
        // Wait for the fade-out animation to complete BEFORE cleaning up and removing the element.
        popupOverlay.addEventListener('transitionend', () => {
            // Now that the popup is invisible, it's safe to remove the shield and listeners.
            deactivateShield();
            popupOverlay.removeEventListener('click', handlePopupClick);
            // Finally, remove the element from the DOM.
            popupOverlay.remove();
        }, { once: true });
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
        if (closeButton || !e.target.closest('.popup-panel')) {
            closePopup();
            return;
        }
        if (jgButton) {
            e.stopPropagation();
            const action = jgButton.dataset.action;
            const context = jgButton.closest('.thumbnail');
            if (!context) return;
            const filename = context.dataset.bgfile;
            switch (action) {
                case 'star':
                    await toggleStarredBackground(filename);
                    renderContent(); // Re-render to show changes
                    break;
                case 'add-to-folder':
                    openFolderChooserPopup(filename);
                    break;
                case 'delete':
                    await onDeleteBackgroundClick.call(jgButton, e);
                    renderContent();
                    break;
                case 'edit':
                    await onRenameBackgroundClick.call(jgButton, e);
                    renderContent();
                    break;
            }
        } else if (thumbnail) {
            onSelectBackgroundClick.call(thumbnail);
            closePopup();
        }
    };

    /**
    * Handles the 'Escape' key to close the popup.
    * @param {KeyboardEvent} e - The keydown event.
    */
    const handleKeyDown = (e) => {
        if (e.key === 'Escape' && !window.isStCorePopupActive) {
            e.stopImmediatePropagation();
            closePopup();
        }
    };

    try {
        activateShield();
        popupOverlay.addEventListener('click', handlePopupClick);
        document.body.appendChild(popupOverlay);
        // Use requestAnimationFrame to ensure the popup is in the DOM and has layout
        requestAnimationFrame(() => {
            popupOverlay.classList.add('open');
            void renderContent();
        });
    } catch (error) {
        console.error('Error opening starred popup:', error);
        // Ensure cleanup happens even if an error occurs during initialization
        deactivateShield();
        popupOverlay.removeEventListener('click', handlePopupClick);
        if (popupOverlay.parentNode) {
            popupOverlay.remove();
        }
    }
}

/**
 * Opens a modal popup gallery displaying backgrounds from a specific custom folder.
 * @param {string} folderId - The ID of the folder to display.
 */
function openCustomFolderPopup(folderId) {
    const folder = backgroundSelector.folderLists.find(f => f.id === folderId);
    if (!folder) {
        console.error(`Folder with ID ${folderId} not found.`);
        return;
    }
    const template = document.getElementById('starred-popup-template');
    const popupFragment = template.content.cloneNode(true);
    const popupOverlay = popupFragment.querySelector('.popup-overlay');
    const popupPanel = popupFragment.querySelector('.popup-panel');
    const contentArea = popupFragment.querySelector('.popup-content');
    const headerTitle = popupFragment.querySelector('h3');
    const setThumbnailButton = popupFragment.querySelector('#folder_set_thumbnail_button');

    // State and UI management for thumbnail selection
    let isThumbnailSelectionMode = false;
    const originalHeaderText = folder.name;
    setThumbnailButton.style.display = 'block'; // Make the button visible

    const enterThumbnailSelectionMode = () => {
        isThumbnailSelectionMode = true;
        popupPanel.classList.add('is-selecting-thumbnail');
        headerTitle.textContent = translate('Select a Thumbnail');
        const icon = setThumbnailButton.querySelector('i');
        icon.classList.remove('fa-image');
        icon.classList.add('fa-xmark');
        setThumbnailButton.setAttribute('data-i18n', '[title]Cancel');
        setThumbnailButton.title = translate('Cancel');
    };

    const exitThumbnailSelectionMode = () => {
        isThumbnailSelectionMode = false;
        popupPanel.classList.remove('is-selecting-thumbnail');
        headerTitle.textContent = originalHeaderText;
        const icon = setThumbnailButton.querySelector('i');
        icon.classList.remove('fa-xmark');
        icon.classList.add('fa-image');
        setThumbnailButton.setAttribute('data-i18n', '[title]Set Folder Thumbnail');
        setThumbnailButton.title = translate('Set Folder Thumbnail');
    };

    headerTitle.textContent = folder.name;
    headerTitle.removeAttribute('data-i18n');
    let isClosing = false;
    let observer;
    let popupRenderVersion = 0;
    const SHIELD_EVENTS = ['mousedown', 'pointerdown', 'touchstart'];

    const eventShield = (e) => { if (e.target.closest('.popup-overlay')) e.stopImmediatePropagation(); };
    const activateShield = () => {
        SHIELD_EVENTS.forEach(eventName => document.addEventListener(eventName, eventShield, true));
        document.addEventListener('keydown', handleKeyDown, true);
    };
    const deactivateShield = () => {
        SHIELD_EVENTS.forEach(eventName => document.removeEventListener(eventName, eventShield, true));
        document.removeEventListener('keydown', handleKeyDown, true);
    };

    const renderContent = async () => {
        const renderVersion = ++popupRenderVersion;
        const folderImages = [...(backgroundSelector.folderImageIndex.get(folderId) ?? [])];
        contentArea.innerHTML = '';
        if (folderImages.length === 0) {
            contentArea.innerHTML = `<p style="text-align: center; padding: 20px;">${translate('This folder is empty.')}</p>`;
            return;
        }
        // Sort the popup's images according to the global sort setting
        backgroundSelector._sortImages(folderImages);
        const style = getComputedStyle(contentArea);
        const paddingX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
        const usableWidth = popupPanel.clientWidth - paddingX;
        if (usableWidth <= 0) {
            requestAnimationFrame(renderContent);
            return;
        }
        const thumbnailContainer = document.createElement('div');
        thumbnailContainer.className = 'thumbnail-container';

        const isMobile = window.innerWidth <= 1000;
        const minThumbsPerRow = isMobile ? 2 : 1;
        const rows = calculateRowLayout(usableWidth, folderImages, false, 110, minThumbsPerRow);

        await renderThumbnailRowsIncrementally(thumbnailContainer, rows, {
            renderVersion,
            getCurrentRenderVersion: () => popupRenderVersion,
            rowOptions: { currentFolderId: folderId },
        });
        contentArea.appendChild(thumbnailContainer);
        if (observer) observer.disconnect();
        observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    observer.unobserve(entry.target);
                    backgroundSelector.queueThumbnailLoad(entry.target);
                }
            });
        }, { root: contentArea, rootMargin: POPUP_THUMB_ROOT_MARGIN });
        thumbnailContainer.querySelectorAll('.thumbnail').forEach(thumb => observer.observe(thumb));
        highlightLockedBackground();
    };

    const closePopup = () => {
        if (isClosing) return;
        isClosing = true;
        // Disconnect the observer immediately.
        if (observer) observer.disconnect();
        // Start the closing animation.
        popupOverlay.classList.remove('open');
        // Wait for the animation to finish before cleaning up listeners and the shield.
        popupOverlay.addEventListener('transitionend', () => {
            deactivateShield();
            popupOverlay.removeEventListener('click', handlePopupClick);
            popupOverlay.remove();
        }, { once: true });
    };

    const handlePopupClick = async (e) => {
        const target = e.target;
        const setThumbBtn = target.closest('#folder_set_thumbnail_button');
        const closeButton = target.closest('.popup-close-button');
        const jgButton = target.closest('.jg-button');
        const thumbnail = target.closest('.thumbnail');

        if (setThumbBtn) {
            isThumbnailSelectionMode ? exitThumbnailSelectionMode() : enterThumbnailSelectionMode();
            return;
        }

        if (jgButton && !isThumbnailSelectionMode) {
            e.stopPropagation();
            const action = jgButton.dataset.action;
            const context = jgButton.closest('.thumbnail');
            if (!context) return;
            const filename = context.dataset.bgfile;
            switch (action) {
                case 'star':
                    await toggleStarredBackground(filename);
                    break;
                case 'add-to-folder':
                    openFolderChooserPopup(filename);
                    break;
                case 'remove-from-folder':
                    await onRemoveFromFolderClick(filename, folderId, renderContent);
                    break;
                case 'delete':
                    await onDeleteBackgroundClick.call(jgButton, e);
                    renderContent();
                    break;
                case 'edit':
                    await onRenameBackgroundClick.call(jgButton, e);
                    renderContent();
                    break;
            }
            return;
        }

        if (thumbnail) {
            e.stopPropagation();
            if (isThumbnailSelectionMode) {
                const filename = thumbnail.dataset.bgfile;
                const originalThumbnail = folder.thumbnailFile; // Store for rollback

                // Optimistic UI update
                folder.thumbnailFile = filename;
                backgroundSelector.renderFolders();
                closePopup(); // Close immediately for better UX

                try {
                    const response = await fetch('/api/backgrounds/folders/set-thumbnail', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({
                            folderId: folder.id,
                            filename: filename,
                        }),
                    });

                    if (!response.ok) {
                        throw new Error(`Server responded with ${response.status}`);
                    }
                    toastr.success(`Set thumbnail for "${folder.name}"`);
                } catch (error) {
                    console.error('Failed to set folder thumbnail:', error);
                    toastr.error('Could not set folder thumbnail. Reverting change.');
                    // Rollback on failure
                    folder.thumbnailFile = originalThumbnail;
                    backgroundSelector.renderFolders();
                }
            } else {
                onSelectBackgroundClick.call(thumbnail);
                closePopup();
            }
            return;
        }

        if (closeButton || !target.closest('.popup-panel')) {
            closePopup();
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Escape' && !window.isStCorePopupActive) {
            e.stopImmediatePropagation();
            closePopup();
        }
    };

    try {
        activateShield();
        popupOverlay.addEventListener('click', handlePopupClick);
        document.body.appendChild(popupOverlay);
        requestAnimationFrame(() => {
            popupOverlay.classList.add('open');
            void renderContent();
        });
    } catch (error) {
        console.error('Error opening custom folder popup:', error);
        // Ensure cleanup happens even if an error occurs during initialization
        deactivateShield();
        popupOverlay.removeEventListener('click', handlePopupClick);
        if (popupOverlay.parentNode) {
            popupOverlay.remove();
        }
    }
}

/**
 * Removes a background from a specific folder.
 * @param {string} filename - The filename of the background to remove.
 * @param {string} folderId - The ID of the folder to remove from.
 * @param {Function} renderCallback - A function to call to re-render the UI on success.
 */
async function onRemoveFromFolderClick(filename, folderId, renderCallback) {
    const imageToUpdate = backgroundSelector.imageLookup.get(filename);
    if (!imageToUpdate || !Array.isArray(imageToUpdate.folderIds)) return;

    const originalFolderIds = [...imageToUpdate.folderIds];
    const newFolderIds = imageToUpdate.folderIds.filter(id => id !== folderId);

    // Optimistically update the client-side data
    imageToUpdate.folderIds = newFolderIds;
    backgroundSelector.rebuildFolderImageIndex();

    try {
        const response = await fetch('/api/backgrounds/update-folders', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                filename: imageToUpdate.filename,
                folderIds: newFolderIds,
            }),
        });

        if (!response.ok) throw new Error(`Server error: ${response.status}`);
        toastr.success(`'${filename}' removed from folder.`);
        renderCallback(); // Re-render the popup to reflect the removal
    } catch (error) {
        console.error('Failed to save folder update:', error);
        toastr.error('Failed to update folder. Reverting change.');
        // Roll back on failure
        imageToUpdate.folderIds = originalFolderIds;
        backgroundSelector.rebuildFolderImageIndex();
    }
}

/**
 * Opens a popup to let the user choose a folder to add a background to.
 * @param {string} filename - The filename of the background being added.
 */
function openFolderChooserPopup(filename) {
    const template = document.getElementById('folder-chooser-popup-template');
    const popupFragment = template.content.cloneNode(true);
    const popupOverlay = popupFragment.querySelector('.popup-overlay');
    popupOverlay.classList.add('folder-chooser-overlay');
    const contentArea = popupFragment.querySelector('#folder-chooser-content');

    let isClosing = false;
    const SHIELD_EVENTS = ['mousedown', 'pointerdown', 'touchstart'];

    // If there are no folders to choose from, don't open the popup.
    if (backgroundSelector.folderLists.length === 0) {
        toastr.info(translate('Create a new folder first by clicking the "+" icon.'));
        return;
    }

    // The shield stops clicks from "leaking" out and being handled by other listeners.
    const eventShield = (e) => {
        if (e.target.closest('.popup-overlay')) {
            e.stopImmediatePropagation();
        }
    };

    const activateShield = () => {
        SHIELD_EVENTS.forEach(eventName => document.addEventListener(eventName, eventShield, true));
        document.addEventListener('keydown', handleKeyDown, true);
    };

    const deactivateShield = () => {
        SHIELD_EVENTS.forEach(eventName => document.removeEventListener(eventName, eventShield, true));
        document.removeEventListener('keydown', handleKeyDown, true);
    };

    const closePopup = () => {
        if (isClosing) return;
        isClosing = true;

        // Start the closing animation.
        popupOverlay.classList.remove('open');

        // Wait for the animation to finish before cleaning up listeners and the shield.
        popupOverlay.addEventListener('transitionend', () => {
            deactivateShield();
            popupOverlay.removeEventListener('click', handlePopupClick);
            popupOverlay.remove();
        }, { once: true });
    };

    const handlePopupClick = async (e) => {
        const folderChoice = e.target.closest('.blank-folder-button');
        const closeButton = e.target.closest('.popup-close-button');

        if (closeButton || !e.target.closest('.popup-panel')) {
            closePopup();
            return;
        }

        if (folderChoice) {
            e.stopPropagation();
            const folderId = folderChoice.dataset.folderId;
            const imageToUpdate = backgroundSelector.imageLookup.get(filename);

            if (imageToUpdate) {
                if (!Array.isArray(imageToUpdate.folderIds)) {
                    imageToUpdate.folderIds = [];
                }

                if (!imageToUpdate.folderIds.includes(folderId)) {
                    imageToUpdate.folderIds.push(folderId); // Optimistic update
                    backgroundSelector.rebuildFolderImageIndex();

                    try {
                        const response = await fetch('/api/backgrounds/update-folders', {
                            method: 'POST',
                            headers: getRequestHeaders(),
                            body: JSON.stringify({
                                filename: imageToUpdate.filename,
                                folderIds: imageToUpdate.folderIds,
                            }),
                        });

                        if (!response.ok) throw new Error(`Server error: ${response.status}`);
                        toastr.success(`'${filename}' added to folder.`);
                    } catch (error) {
                        console.error('Failed to save folder update:', error);
                        toastr.error('Failed to update folder. Reverting change.');
                        imageToUpdate.folderIds.pop(); // Roll back on failure
                        backgroundSelector.rebuildFolderImageIndex();
                    }
                } else {
                    toastr.info(`'${filename}' is already in that folder.`);
                }
                closePopup();
            }
        }
    };

    // Handles the Escape key properly, stopping it from closing other UI elements.
    const handleKeyDown = (e) => {
        if (e.key === 'Escape') {
            // This check prevents closing if a text input popup is open on top of this one.
            if (window.isStCorePopupActive) {
                return;
            }
            e.stopImmediatePropagation();
            closePopup();
        }
    };

    // Populate the popup with folder choices
    backgroundSelector.folderLists.forEach((folder) => {
        const folderElement = createBlankFolderElement(folder, { withMenu: false });
        contentArea.appendChild(folderElement);
    });

    activateShield();
    popupOverlay.addEventListener('click', handlePopupClick);
    document.body.appendChild(popupOverlay);
    requestAnimationFrame(() => popupOverlay.classList.add('open'));
}

/**
 * Initializes the background gallery and sets up event listeners.
 * This function is idempotent and can be safely called multiple times.
 * @returns {Promise<void>}
 */
export async function initBackgrounds() {
    let isSelectionModeActive = false;
    let selectedBackgrounds = new Set();

    const updateSelectionCount = () => {
        const count = selectedBackgrounds.size;
        const message = stringFormat(translate('{0} selected'), [count]);
        $('#bg-selection-count').text(message);
    };

    const enterSelectionMode = () => {
        isSelectionModeActive = true;
        selectedBackgrounds = new Set();
        $('#Backgrounds').addClass('selection-mode-active');
        $('#bg_menu_content').addClass('selection-active');
        backgroundSelector.reapplySelectionStyles([]);
        updateSelectionCount();
    };

    const exitSelectionMode = () => {
        isSelectionModeActive = false;
        selectedBackgrounds = new Set();
        $('#Backgrounds').removeClass('selection-mode-active');
        $('#bg_menu_content').removeClass('selection-active');
        backgroundSelector.reapplySelectionStyles([]);
    };

    const handleThumbnailBulkSelect = (thumbnailElement) => {
        const bgFile = thumbnailElement.dataset.bgfile;
        if (!bgFile) return;

        const $thumb = $(thumbnailElement);
        if (!selectedBackgrounds.has(bgFile)) {
            selectedBackgrounds.add(bgFile);
            $thumb.addClass('is-bulk-selected');
        } else {
            selectedBackgrounds.delete(bgFile);
            $thumb.removeClass('is-bulk-selected');
        }
        backgroundSelector.reapplySelectionStyles(Array.from(selectedBackgrounds));
        updateSelectionCount();
    };

    const handleBulkAddToFolder = async (folderId) => {
        if (selectedBackgrounds.size === 0) {
            toastr.warning(translate('Please select at least one background.'));
            return;
        }

        const filenamesToAdd = Array.from(selectedBackgrounds).filter(filename => {
            const image = backgroundSelector.imageLookup.get(filename);
            return image && (!Array.isArray(image.folderIds) || !image.folderIds.includes(folderId));
        });

        if (filenamesToAdd.length === 0) {
            toastr.info(translate('All selected backgrounds are already in that folder.'));
            exitSelectionMode();
            return;
        }

        try {
            const response = await fetch('/api/backgrounds/folders/add-bulk', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({
                    filenames: filenamesToAdd,
                    folderId: folderId,
                }),
            });

            if (!response.ok) throw new Error(`Server error: ${response.status}`);

            filenamesToAdd.forEach(filename => {
                const image = backgroundSelector.imageLookup.get(filename);
                if (image) {
                    if (!Array.isArray(image.folderIds)) image.folderIds = [];
                    image.folderIds.push(folderId);
                }
            });
            backgroundSelector.rebuildFolderImageIndex();

            toastr.success(stringFormat(translate('{0} backgrounds added to folder.'), [filenamesToAdd.length]));
        } catch (error) {
            console.error('Failed to save bulk folder update:', error);
            toastr.error('Failed to update folder.');
        } finally {
            exitSelectionMode();
        }
    };

    if (backgroundSelector) backgroundSelector.destroy();
    backgroundSelector = new BackgroundSelector('bg_menu_content');

    // Overwrite the default debounced render to include selection style re-application
    backgroundSelector.debouncedRender = debounce(async () => {
        // Await the render promise to ensure the DOM is updated before proceeding
        await backgroundSelector.render(false);

        // After re-rendering, if we are in selection mode, re-apply the visual state
        if (isSelectionModeActive) {
            backgroundSelector.reapplySelectionStyles(Array.from(selectedBackgrounds));
        }
    }, 150);

    backgroundSelector.sortOrder = background_settings.sortOrder;
    const drawerElement = document.getElementById('Backgrounds');

    if (drawerElement) {
        const checkVisibility = () => {
            const isNowOpen = drawerElement.classList.contains('openDrawer');

            if (isNowOpen && !hasGalleryLoaded && !galleryLoadInProgress) {
                galleryLoadInProgress = true;

                // Define the check-and-load logic once
                const checkAndLoad = async () => {
                    try {
                        const response = await fetch('/api/backgrounds/status');
                        const status = await response.json();

                        if (status.ready) {
                            // Server is ready, load immediately.
                            console.log('[Backgrounds] Server is ready. Loading gallery data.');
                            await getBackgrounds(); // Await the entire process
                            hasGalleryLoaded = true;
                            galleryLoadInProgress = false;
                            return true; // Signal that loading is complete
                        }
                    } catch (error) {
                        console.error('[Backgrounds] Failed to poll server status, will retry...', error);
                    }
                    return false; // Signal that we need to poll
                };

                // Immediately try to load
                checkAndLoad().then(isReady => {
                    // If the initial check failed (server was busy), start polling as a fallback.
                    if (!isReady) {
                        const pollServerStatus = setInterval(async () => {
                            const loaded = await checkAndLoad();
                            if (loaded) {
                                clearInterval(pollServerStatus);
                            }
                        }, 1000); // Poll every second until ready
                    }
                });
            }
        };

        // This attaches the function to the browser, so it runs when the panel opens.
        new MutationObserver(checkVisibility).observe(drawerElement, { attributes: true, attributeFilter: ['class'] });
        // This runs the check once on page load, in case the panel is already open.
        checkVisibility();
    }

    $(document)
        .off('click', '#starred-folder-button').on('click', '#starred-folder-button', (e) => {
            e.stopPropagation();
            openStarredPopup();
        })
        .off('click', '#add-folder-button').on('click', '#add-folder-button', async (e) => {
            e.stopPropagation();
            if (backgroundSelector && backgroundSelector.folderLists.length < FOLDER_LIMIT) {
                const defaultName = `New Folder ${backgroundSelector.folderLists.length + 1}`;
                try {
                    const response = await fetch('/api/backgrounds/folders/create', {
                        method: 'POST',
                        headers: getRequestHeaders(),
                        body: JSON.stringify({ name: defaultName }),
                    });
                    if (!response.ok) throw new Error(`Server responded with ${response.status}`);
                    const newFolder = await response.json();
                    backgroundSelector.folderLists.push(newFolder);
                    backgroundSelector.renderFolders();
                } catch (error) {
                    console.error('Failed to create folder:', error);
                    toastr.error('Could not create folder.');
                }
            }
        })
        .off('click', '.blank-folder-button').on('click', '.blank-folder-button', function (e) {
            e.stopPropagation();
            const folderId = this.dataset.folderId;
            if (folderId) {
                if (isSelectionModeActive) {
                    handleBulkAddToFolder(folderId);
                } else {
                    openCustomFolderPopup(folderId);
                }
            }
        })
        .off('click', '.mobile-only-menu-toggle').on('click', '.mobile-only-menu-toggle', function (e) {
            e.stopPropagation();
            // we find the parent context, which can be a thumbnail or a folder button
            const $context = $(this).closest('.thumbnail, .folder-button');
            const wasOpen = $context.hasClass('mobile-menu-open');
            // we close all currently open menus (on both thumbnails and folders)
            $('.thumbnail.mobile-menu-open, .folder-button.mobile-menu-open').removeClass('mobile-menu-open');
            // we open the menu on the clicked item if it wasn't already open
            if (!wasOpen) {
                $context.addClass('mobile-menu-open');
            }
        })
        .off('click', '.jg-button').on('click', '.jg-button', function (e) {
            e.stopPropagation();
            const action = $(this).data('action');
            // we find the parent context, which can be either a thumbnail or a folder button
            const contextElement = $(this).closest('.thumbnail, .folder-button')[0];
            if (!contextElement) return;

            // we handle actions that are specific to folders first
            if (action === 'rename-folder') {
                onRenameFolderClick.call(this, e);
                return;
            }
            if (action === 'delete-folder') {
                onDeleteFolderClick.call(this, e);
                return;
            }

            const filename = contextElement.dataset.bgfile;
            if (!filename) return;

            switch (action) {
                case 'star':
                    toggleStarredBackground(filename);
                    break;
                case 'add-to-folder':
                    openFolderChooserPopup(filename);
                    break;
                case 'edit':
                    onRenameBackgroundClick.call(this, e);
                    break;
                case 'delete':
                    onDeleteBackgroundClick.call(this, e);
                    break;
            }
        })
        .off('click', '.thumbnail').on('click', '.thumbnail', function (e) {
            if (isSelectionModeActive) {
                handleThumbnailBulkSelect(this);
            } else {
                onSelectBackgroundClick.call(this, e);
            }
        })
        .off('dragstart', '.thumbnail').on('dragstart', '.thumbnail', function () {
            window.isDraggingInternalThumbnail = true;
        })
        .off('dragend', '.thumbnail').on('dragend', '.thumbnail', function () {
            window.isDraggingInternalThumbnail = false;
        });

    $('#bg_lock_button').off('click').on('click', function () {
        if (hasCustomBackground()) {
            onUnlockBackgroundClick();
        } else {
            onLockBackgroundClick();
        }
    });

    $('#bg_select_button').off('click').on('click', enterSelectionMode);
    $('#bg_select_cancel_button').off('click').on('click', exitSelectionMode);
    $('#bg_select_all_button').off('click').on('click', () => {
        const visibleFilenames = backgroundSelector.filteredImages.map(img => img.filename);
        const allVisibleSelected = visibleFilenames.length > 0 && visibleFilenames.every(file => selectedBackgrounds.has(file));

        if (allVisibleSelected) {
            visibleFilenames.forEach(file => {
                selectedBackgrounds.delete(file);
            });
        } else {
            visibleFilenames.forEach(file => {
                selectedBackgrounds.add(file);
            });
        }
        backgroundSelector.reapplySelectionStyles(Array.from(selectedBackgrounds));
        updateSelectionCount();
    });

    $('#auto_background').off('click').on('click', autoBackgroundCommand);
    $('#add_bg_button').off('change').on('change', onBackgroundUploadSelected);
    $('#bg-filter').off('input').on('input', onBackgroundFilterInput);

    $('#bg-sort-order').off('input').on('input', function () {
        const newSortOrder = $(this).val();
        background_settings.sortOrder = newSortOrder;
        saveSettingsDebounced();
        if (backgroundSelector) {
            backgroundSelector.sortOrder = newSortOrder;
            backgroundSelector.search($('#bg-filter').val() || '');
        }
    });

    $('#background_fitting').off('input').on('input', function () {
        background_settings.fitting = String($(this).val());
        setFittingClass(background_settings.fitting);
        saveSettingsDebounced();
    });

    $('#background_thumbnails_animation').off('change').on('change', function () {
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
        { name: 'lockbg', callback: onLockBackgroundClick, aliases: ['bglock'], help: 'Locks the selected background for the current chat.' },
        { name: 'unlockbg', callback: onUnlockBackgroundClick, aliases: ['bgunlock'], help: 'Unlocks the background for the current chat.' },
        { name: 'autobg', callback: autoBackgroundCommand, aliases: ['bgauto'], help: 'Automatically changes the background based on chat context.' },
    ];
    commands.forEach(cmd => SlashCommandParser.addCommandObject(
        SlashCommand.fromProps({ name: cmd.name, callback: cmd.callback, aliases: cmd.aliases, helpString: translate(cmd.help) }),
    ));

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Set the initial state of the button on load.
    updateLockButtonState();
}
