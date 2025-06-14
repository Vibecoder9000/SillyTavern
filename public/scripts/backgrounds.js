import { Fuse, localforage } from '../lib.js';
import { chat_metadata, eventSource, event_types, generateQuietPrompt, getCurrentChatId, getRequestHeaders, getThumbnailUrl, saveSettingsDebounced } from '../script.js';
import { openThirdPartyExtensionMenu, saveMetadataDebounced } from './extensions.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { createThumbnail, flashHighlight, getBase64Async, stringFormat } from './utils.js';
import { t } from './i18n.js';
import { Popup } from './popup.js';

const BG_METADATA_KEY = 'custom_background';
const LIST_METADATA_KEY = 'chat_backgrounds';
const GAP_SIZE = 3;

// A single transparent PNG pixel used as a placeholder for errored backgrounds
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_PIXEL_BLOB = new Blob([Uint8Array.from(atob(PNG_PIXEL), c => c.charCodeAt(0))], { type: 'image/png' });
const PLACEHOLDER_IMAGE = `url('data:image/png;base64,${PNG_PIXEL}')`;

/**
 * Storage for frontend-generated background thumbnails.
 * This is used to store thumbnails for backgrounds that cannot be generated on the server.
 */
const THUMBNAIL_STORAGE = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });

/**
 * Cache for thumbnail blob URLs.
 * @type {Map<string, string>}
 */
const THUMBNAIL_BLOBS = new Map();

const THUMBNAIL_CONFIG = {
    width: 160,
    height: 90,
};

/**
 * Global IntersectionObserver instance for lazy loading backgrounds
 * @type {IntersectionObserver|null}
 */
let lazyLoadObserver = null;
let justifiedGalleryInstance;

class JustifiedGallery {
    constructor(container, targetRowHeight = 200) {
        console.log('JustifiedGallery constructor called with container:', container, 'targetRowHeight:', targetRowHeight);
        this.container = container;
        this.targetRowHeight = targetRowHeight; // You might want to make this configurable later
        this.currentRow = [];
        this.currentRowWidth = 0;
        this.imagesData = []; // To store all image data for filtering
    }

    addImage(imageData) {
        console.log('JustifiedGallery.addImage called with imageData:', imageData);
        const scaledWidth = this.targetRowHeight * imageData.aspectRatio;
        this.currentRow.push({
            ...imageData,
            scaledWidth: scaledWidth
        });
        this.currentRowWidth += scaledWidth;
        console.log('Calculated scaledWidth:', scaledWidth, 'Current row:', this.currentRow, 'Current row width:', this.currentRowWidth);
        const containerWidth = this.container.offsetWidth;

        // Ensure containerWidth is positive to avoid issues
        if (containerWidth <= 0) {
            console.warn('JustifiedGallery.addImage: containerWidth is 0 or less. Skipping row completion check.');
            // If container not visible or has no width, defer completion or handle error
            // For now, let's prevent completing rows if width is unknown
            return;
        }

        const gapWidth = (this.currentRow.length - 1) * GAP_SIZE;
        console.log('JustifiedGallery.addImage: containerWidth:', containerWidth, 'gapWidth:', gapWidth);
        if (this.currentRowWidth + gapWidth >= containerWidth * 0.95) { // Trigger row completion slightly before exact width
            this.completeRow();
        }
    }

    completeRow() {
        console.log('JustifiedGallery.completeRow called. Current row length:', this.currentRow.length);
        if (this.currentRow.length === 0) return;

        const containerWidth = this.container.offsetWidth;
        // Ensure containerWidth is positive
        if (containerWidth <= 0) {
            console.warn('JustifiedGallery.completeRow: Container width is 0 or not available. Clearing current row.');
            this.currentRow = [];
            this.currentRowWidth = 0;
            return;
        }

        const gapWidth = (this.currentRow.length - 1) * GAP_SIZE;
        const availableWidth = containerWidth - gapWidth;

        const scaleFactor = availableWidth / this.currentRowWidth;
        const finalHeight = this.targetRowHeight * scaleFactor;
        console.log('JustifiedGallery.completeRow: containerWidth:', containerWidth, 'gapWidth:', gapWidth, 'availableWidth:', availableWidth, 'scaleFactor:', scaleFactor, 'finalHeight:', finalHeight);

        this.renderRow(this.currentRow, scaleFactor, finalHeight);

        this.currentRow = [];
        this.currentRowWidth = 0;
    }

    renderRow(images, scaleFactor, finalHeight) {
        console.log('JustifiedGallery.renderRow called with images:', images, 'scaleFactor:', scaleFactor, 'finalHeight:', finalHeight);
        const rowElement = document.createElement('div');
        rowElement.className = 'gallery-row';
        // Style is applied by CSS, but flex properties are essential for layout
        rowElement.style.display = 'flex';
        rowElement.style.gap = `${GAP_SIZE}px`;
        rowElement.style.marginBottom = `${GAP_SIZE}px`; // Or use CSS

        images.forEach(imgData => {
            const width = imgData.scaledWidth * scaleFactor;

            const thumbnail = document.createElement('div');
            thumbnail.className = 'thumbnail'; // For CSS styling
            thumbnail.style.width = `${width}px`;
            thumbnail.style.height = `${finalHeight}px`;
            thumbnail.style.flexShrink = '0'; // Prevent shrinking

            // Store necessary data on the element for click handlers
            thumbnail.dataset.bgfile = imgData.fullResUrl; // Assuming fullResUrl holds the original file identifier
            thumbnail.dataset.url = imgData.url; // Thumbnail URL
            thumbnail.dataset.isCustom = imgData.isCustom || 'false'; // Store if it's a custom background

            const imgElement = document.createElement('img');
            imgElement.src = imgData.url; // This should be the thumbnail URL
            imgElement.alt = imgData.title || imgData.id; // Use a descriptive alt text
            imgElement.style.width = '100%';
            imgElement.style.height = '100%';
            imgElement.style.objectFit = 'cover';
            imgElement.loading = 'lazy'; // Native lazy loading

            console.log('RenderRow: Creating thumbnail for imgData:', imgData, 'Calculated width:', width);
            console.log('RenderRow: Image source being set:', imgElement.src);
            thumbnail.appendChild(imgElement);

            const menuElement = document.createElement('div');
            menuElement.className = 'bg_example_menu';

            const lockButton = document.createElement('div');
            lockButton.className = 'bg_example_button bg_example_lock';
            lockButton.title = t('Lock background');
            lockButton.innerHTML = '<i class="fa-solid fa-lock"></i>';
            menuElement.appendChild(lockButton);

            const unlockButton = document.createElement('div');
            unlockButton.className = 'bg_example_button bg_example_unlock';
            unlockButton.title = t('Unlock background');
            unlockButton.innerHTML = '<i class="fa-solid fa-lock-open"></i>';
            menuElement.appendChild(unlockButton);

            const editButton = document.createElement('div');
            editButton.className = 'bg_example_button bg_example_edit';
            editButton.title = t('Rename background');
            editButton.innerHTML = '<i class="fa-solid fa-pencil"></i>';
            menuElement.appendChild(editButton);

            // Copy button only for custom backgrounds, handled by CSS or further logic if needed.
            // For now, render all and rely on existing logic in onCopyToSystemBackgroundClick if it checks isCustom.
            // Or, it should only be added if imgData.isCustom is true.
            // Let's assume for now it's always rendered and the handler will deal with it or it's a system->system copy.
            // The original template didn't differentiate copy button visibility based on custom status in its structure.
            if (imgData.isCustom === 'true' || imgData.isCustom === true) { // Ensure consistent boolean check
                const copyButton = document.createElement('div');
                copyButton.className = 'bg_example_button bg_example_copy';
                copyButton.title = t('Copy to System Backgrounds');
                copyButton.innerHTML = '<i class="fa-solid fa-copy"></i>';
                menuElement.appendChild(copyButton);
            }

            const deleteButton = document.createElement('div');
            deleteButton.className = 'bg_example_button bg_example_cross';
            deleteButton.title = t('Delete background');
            deleteButton.innerHTML = '<i class="fa-solid fa-trash-can"></i>';
            menuElement.appendChild(deleteButton);

            thumbnail.appendChild(menuElement);
            rowElement.appendChild(thumbnail);
        });

        this.container.appendChild(rowElement);
        console.log('RenderRow: Appended rowElement to container. Container innerHTML length:', this.container.innerHTML.length);
    }

    finalize() {
        // Complete any partial row.
        // If the row is too short, you might want to scale it to targetRowHeight instead of container width.
        // For now, this will stretch the last row to fit container width.
        if (this.currentRow.length > 0) {
             // Option 1: Stretch to fit (current completeRow behavior)
            this.completeRow();

            // Option 2: Render at target height without stretching (more complex, might leave gaps)
            // This would involve a different rendering logic for the last row if it's not to be stretched.
            // For simplicity, we'll use completeRow which stretches.
        }
    }

    reset() {
        console.log('JustifiedGallery.reset called.');
        if (this.container) {
            this.container.innerHTML = '';
        }
        this.currentRow = [];
        this.currentRowWidth = 0;
        this.imagesData = []; // Clear stored image data as well
    }

    setImages(images) { // New method to load all images data
        console.log('JustifiedGallery.setImages called with images:', images);
        if (!images || images.length === 0) {
            console.log('JustifiedGallery.setImages: images array is empty or undefined.');
        }
        this.imagesData = images;
        this.filterAndDisplayImages(''); // Display all images initially
    }

    filterAndDisplayImages(query) { // New method for filtering
        this.reset(); // Clear existing gallery content
        const normalizedQuery = query.toLowerCase();
        const filteredImages = this.imagesData.filter(img => {
            const title = img.title || img.id || '';
            // Add more fields to search if needed, e.g., tags
            return title.toLowerCase().includes(normalizedQuery);
        });

        filteredImages.forEach(img => this.addImage(img));
        this.finalize();
    }
}

export let background_settings = {
    name: '__transparent.png',
    url: generateUrlParameter('__transparent.png', false),
    fitting: 'classic',
    animation: false,
};

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
    }
    else {
        unsetCustomBackground();
    }

    await getChatBackgroundsList();
    highlightLockedBackground();
}

async function getChatBackgroundsList() {
    const list = chat_metadata[LIST_METADATA_KEY];
    const listEmpty = !Array.isArray(list) || list.length === 0;

    $('#bg_custom_content').empty();
    $('#bg_chat_hint').toggle(listEmpty);

    if (listEmpty) {
        return;
    }

    for (const bg of list) {
        const template = await getBackgroundFromTemplate(bg, true);
        $('#bg_custom_content').append(template);
    }
    activateLazyLoader();
}

function getBackgroundPath(fileUrl) {
    return `backgrounds/${encodeURIComponent(fileUrl)}`;
}

function highlightLockedBackground() {
    const lockedBgMetadata = chat_metadata[BG_METADATA_KEY];
    $('.thumbnail').each(function () {
        const $thumbnail = $(this);
        const bgFile = $thumbnail.data('bgfile');
        const isCustom = $thumbnail.data('is-custom') === true || $thumbnail.data('is-custom') === 'true';
        const currentBgUrlForComparison = generateUrlParameter(bgFile, isCustom);
        const isCurrentlyLocked = lockedBgMetadata === currentBgUrlForComparison;

        if (isCurrentlyLocked) {
            $thumbnail.addClass('locked');
            $thumbnail.find('.bg_example_lock').hide();
            $thumbnail.find('.bg_example_unlock').show();
        } else {
            $thumbnail.removeClass('locked');
            $thumbnail.find('.bg_example_lock').show();
            $thumbnail.find('.bg_example_unlock').hide();
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
    const $thumbnail = $(this).closest('.thumbnail');
    const bgFile = $thumbnail.data('bgfile');
    const isCustom = $thumbnail.data('is-custom') === true || $thumbnail.data('is-custom') === 'true';

    const chatName = getCurrentChatId();
    if (!chatName) {
        toastr.warning(t('Select a chat to lock the background for it'));
        return '';
    }

    const relativeBgImage = generateUrlParameter(bgFile, isCustom);

    saveBackgroundMetadata(relativeBgImage);
    setCustomBackground(); // Applies the one from metadata
    highlightLockedBackground(); // Updates all button states
    return '';
}

/**
 * Unlocks the background for the current chat
 * @param {Event} e Click event
 * @returns {string} Empty string
 */
function onUnlockBackgroundClick(e) {
    e?.stopPropagation();
    // const $thumbnail = $(this).closest('.thumbnail'); // Not strictly needed for this op
    removeBackgroundMetadata();
    unsetCustomBackground();
    highlightLockedBackground(); // Updates all button states
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

function onSelectBackgroundClick() {
    const $this = $(this);
    const bgFile = $this.data('bgfile');
    const isCustom = $this.data('is-custom') === true || $this.data('is-custom') === 'true';
    // The 'url' data attribute on .thumbnail stores the direct thumbnail URL.
    // For setting background, we often need the full-resolution path or a specially formatted URL string.
    // Let's reconstruct 'relativeBgImage' similar to how getBackgroundFromTemplate used to create it,
    // or how the new JustifiedGallery's renderRow stores it.
    // The JustifiedGallery stores the direct thumbnail URL in `data-url`.
    // For `setBackground` and `saveBackgroundMetadata`, we need the `url()` formatted string or the original reference.
    // `data-bgfile` (aka fullResUrl) is the original filename.

    let relativeBgImage;
    if (isCustom) {
        // For custom images, data-url might be a blob or data URL, which is fine for direct use by CSS
        // However, metadata and setBackground might expect the original reference if it was a file path.
        // For now, let's assume data-url is suitable for metadata if it's custom.
        // This part might need refinement based on exactly what `saveBackgroundMetadata` expects for custom BGs.
        // Let's assume `data-bgfile` is the persistent identifier for custom backgrounds if they are file-based.
        // If `data-url` is a blob URL, it's not persistent for metadata.
        // The original `getUrlParameter` returned the `url(...)` formatted string.
        // The `generateUrlParameter` function creates this.
        relativeBgImage = generateUrlParameter(bgFile, isCustom); // bgFile is the original identifier
    } else {
        relativeBgImage = generateUrlParameter(bgFile, false); // bgFile is filename for system BGs
    }

    // if clicked on upload button (this condition might be obsolete if upload button isn't a .thumbnail)
    if (!bgFile) { // Check bgFile as it's the core identifier
        return;
    }

    // Automatically lock the background if it's custom or other background is locked
    if (hasCustomBackground() || isCustom) {
        saveBackgroundMetadata(relativeBgImage); // save the url() formatted string
        setCustomBackground();
        highlightLockedBackground();
    }
    highlightLockedBackground();

    const customBg = window.getComputedStyle(document.getElementById('bg_custom')).backgroundImage;

    // Custom background is set. Do not override the layer below
    if (customBg !== 'none') {
        return;
    }

    // bgFile is already available from $this.data('bgfile')
    const backgroundUrl = getBackgroundPath(bgFile); // This is for fetching the full res image

    // Fetching to browser memory to reduce flicker
    fetch(backgroundUrl).then(() => {
        // setBackground expects the original filename (bgFile) and the url() formatted string (relativeBgImage)
        setBackground(bgFile, relativeBgImage);
    }).catch(() => {
        console.log('Background could not be set: ' + backgroundUrl);
    });
}

async function onCopyToSystemBackgroundClick(e) {
    e.stopPropagation();
    const $thumbnail = $(this).closest('.thumbnail');
    // Pass the .thumbnail element to getNewBackgroundName, so it can derive data from it
    const bgNames = await getNewBackgroundName($thumbnail);

    if (!bgNames) {
        return;
    }

    const bgFile = await fetch(bgNames.oldBg);

    if (!bgFile.ok) {
        toastr.warning('Failed to copy background');
        return;
    }

    const blob = await bgFile.blob();
    const file = new File([blob], bgNames.newBg);
    const formData = new FormData();
    formData.set('avatar', file);

    await uploadBackground(formData);

    const list = chat_metadata[LIST_METADATA_KEY] || [];
    const index = list.indexOf(bgNames.oldBg);
    list.splice(index, 1);
    saveMetadataDebounced();
    await getChatBackgroundsList();
}

/**
 * Gets a thumbnail for the background from storage or fetches it if not available.
 * It caches the thumbnail in local storage and returns a blob URL for the thumbnail.
 * If the thumbnail cannot be fetched, it returns a transparent PNG pixel as a fallback.
 * @param {string} bg Background URL
 * @returns {Promise<string>} Blob URL of the thumbnail
 */
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
        const fallbackBlob = PNG_PIXEL_BLOB;
        const fallbackBlobUrl = URL.createObjectURL(fallbackBlob);
        THUMBNAIL_BLOBS.set(bg, fallbackBlobUrl);
        return fallbackBlobUrl;
    }
}

/**
 * Gets the new background name from the user.
 * @param {Element} referenceElement
 * @returns {Promise<{oldBg: string, newBg: string}>}
 * */
async function getNewBackgroundName(referenceElementOrThumbnail) {
    // referenceElementOrThumbnail can be the button clicked or the thumbnail itself
    const $thumbnail = $(referenceElementOrThumbnail).closest('.thumbnail');
    const isCustom = $thumbnail.data('is-custom') === true || $thumbnail.data('is-custom') === 'true';
    const oldBg = $thumbnail.data('bgfile');

    if (!oldBg) {
        console.debug('no bgfile from thumbnail data');
        return;
    }

    const fileExtension = oldBg.split('.').pop();
    const fileNameBase = isCustom ? oldBg.split('/').pop() : oldBg;
    const oldBgExtensionless = fileNameBase.replace(`.${fileExtension}`, '');
    const newBgExtensionless = await Popup.show.input(t`Enter new background name:`, null, oldBgExtensionless);

    if (!newBgExtensionless) {
        console.debug('no new_bg_extensionless');
        return;
    }

    const newBg = `${newBgExtensionless}.${fileExtension}`;

    if (oldBgExtensionless === newBgExtensionless) {
        console.debug('new_bg === old_bg');
        return;
    }

    return { oldBg, newBg };
}

async function onRenameBackgroundClick(e) {
    e.stopPropagation();
    const $thumbnail = $(this).closest('.thumbnail');
    // Pass the .thumbnail element
    const bgNames = await getNewBackgroundName($thumbnail);

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
        await getBackgrounds();
        highlightNewBackground(bgNames.newBg);
    } else {
        toastr.warning('Failed to rename background');
    }
}

async function onDeleteBackgroundClick(e) {
    e.stopPropagation();
    const $thumbnail = $(this).closest('.thumbnail');
    const bgFile = $thumbnail.data('bgfile');
    const isCustom = $thumbnail.data('is-custom') === true || $thumbnail.data('is-custom') === 'true';
    const url = generateUrlParameter(bgFile, isCustom); // Reconstruct for comparison with metadata

    const confirm = await Popup.show.confirm(t`Delete the background?`, null);

    if (confirm) {
        if (!isCustom) {
            await delBackground(bgFile); // Make sure delBackground is async if it wasn't
        } else {
            const list = chat_metadata[LIST_METADATA_KEY] || [];
            const index = list.indexOf(bgFile); // bgFile should be the identifier for custom BGs
            if (index > -1) {
                list.splice(index, 1);
                chat_metadata[LIST_METADATA_KEY] = list;
                // No saveMetadataDebounced() here, let getChatBackgroundsList handle it if it's called
            }
        }

        // If the deleted background was the active one, unset it
        if (url === chat_metadata[BG_METADATA_KEY]) {
            removeBackgroundMetadata();
            unsetCustomBackground();
            // highlightLockedBackground will be called by getBackgrounds or getChatBackgroundsList
        }

        // Refresh the gallery to remove the item
        // This assumes custom backgrounds are not in this gallery. If they were, a more complex refresh is needed.
        if (!isCustom) {
            await getBackgrounds(); // This will re-render and also call highlightLockedBackground
        } else {
            // If custom backgrounds are managed separately, refresh their list
            await getChatBackgroundsList();
            // And ensure the main gallery's lock states are still correct
            highlightLockedBackground();
        }
        // Note: The old logic of clicking a sibling is removed as gallery re-renders.
        // $thumbnail.remove(); // Let the gallery re-render handle removal
    }
}

const autoBgPrompt = 'Ignore previous instructions and choose a location ONLY from the provided list that is the most suitable for the current scene. Do not output any other text:\n{0}';

async function autoBackgroundCommand() {
    /** @type {HTMLElement[]} */
    const bgTitles = Array.from(document.querySelectorAll('#bg_menu_content .BGSampleTitle'));
    const options = bgTitles.map(x => ({ element: x, text: x.innerText.trim() })).filter(x => x.text.length > 0);
    if (options.length == 0) {
        toastr.warning('No backgrounds to choose from. Please upload some images to the "backgrounds" folder.');
        return '';
    }

    const list = options.map(option => `- ${option.text}`).join('\n');
    const prompt = stringFormat(autoBgPrompt, list);
    const reply = await generateQuietPrompt(prompt, false, false);
    const fuse = new Fuse(options, { keys: ['text'] });
    const bestMatch = fuse.search(reply, { limit: 1 });

    if (bestMatch.length == 0) {
        for (const option of options) {
            if (String(reply).toLowerCase().includes(option.text.toLowerCase())) {
                console.debug('Fallback choosing background:', option);
                option.element.click();
                return '';
            }
        }

        toastr.warning('No match found. Please try again.');
        return '';
    }

    console.debug('Automatically choosing background:', bestMatch);
    bestMatch[0].item.element.click();
    return '';
}

export async function getBackgrounds() {
    const aspectRatiosResponse = await fetch('/api/user-data/aspect_ratios', { headers: getRequestHeaders() });
    const aspectRatiosData = aspectRatiosResponse.ok ? await aspectRatiosResponse.json() : {};
    console.log('Fetched aspectRatiosData:', aspectRatiosData);

    const response = await fetch('/api/backgrounds/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });

    if (response.ok) {
        const { images, config } = await response.json();
        console.log('Fetched images from /api/backgrounds/all:', images);
        Object.assign(THUMBNAIL_CONFIG, config); // Keep this for THUMBNAIL_CONFIG updates

        const allImagesData = [];
        for (const bg of images) {
            // Assuming 'bg' is the filename, e.g., "image.jpg"
            const aspectRatio = aspectRatiosData[bg] || 1.0; // Default to 1.0 (square) if not found
            const isCustom = false; // System backgrounds from this endpoint are not custom

            // Use the modified resolveImageUrl to get a raw URL
            const thumbnailUrl = await resolveImageUrl(bg, isCustom);
            console.log('Processing bg:', bg, 'Resolved thumbnailUrl:', thumbnailUrl, 'Calculated aspectRatio:', aspectRatio);
            const title = bg.slice(0, bg.lastIndexOf('.'));

            const imageData = {
                id: bg, // Use filename as ID
                url: thumbnailUrl, // This is now the direct URL
                aspectRatio: parseFloat(aspectRatio),
                title: title,
                fullResUrl: bg, // Original filename for selection
                isCustom: String(isCustom) // For click handler
            };
            console.log('Constructed imageData:', imageData);
            allImagesData.push(imageData);
        }

        console.log('Calling justifiedGalleryInstance.setImages with allImagesData:', allImagesData);
        if (justifiedGalleryInstance) {
            justifiedGalleryInstance.setImages(allImagesData);
            highlightLockedBackground(); // Call after images are set
        }
        // activateLazyLoader(); // Consider removing or commenting out, native lazy loading in gallery.
    }
}

function activateLazyLoader() {
    // Disconnect previous observer to prevent memory leaks
    if (lazyLoadObserver) {
        lazyLoadObserver.disconnect();
        lazyLoadObserver = null;
    }

    // This function might be obsolete if JustifiedGallery handles its own lazy loading or elements.
    // For now, keeping its structure but it might not be called by getBackgrounds anymore.
    const lazyLoadElements = document.querySelectorAll('.lazy-load-background');

    const options = {
        root: null,
        rootMargin: '200px',
        threshold: 0.01,
    };

    lazyLoadObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.target instanceof HTMLElement && entry.isIntersecting) {
                const target = entry.target;
                const bg = target.getAttribute('bgfile');
                const isCustom = target.getAttribute('custom') === 'true';
                resolveImageUrl(bg, isCustom)
                    .then(url => { target.style.backgroundImage = url; })
                    .catch(() => { target.style.backgroundImage = PLACEHOLDER_IMAGE; });
                target.classList.remove('lazy-load-background');
                observer.unobserve(target);
            }
        });
    }, options);

    lazyLoadElements.forEach(element => {
        lazyLoadObserver.observe(element);
    });
}

/**
 * Gets the CSS URL of the background
 * @param {Element} block
 * @returns {string} URL of the background
 */
// function getUrlParameter(block) { // This function seems obsolete with .thumbnail structure
//     return $(block).closest('.thumbnail').data('url'); // If ever needed, this would be the adaptation
// }

function generateUrlParameter(bg, isCustom) {
    return isCustom ? `url("${encodeURI(bg)}")` : `url("${getBackgroundPath(bg)}")`;
}

/**
 * Resolves the image URL for the background.
 * @param {string} bg Background file name
 * @param {boolean} isCustom Is a custom background
 * @returns {Promise<string>} CSS URL of the background
 */
async function resolveImageUrl(bg, isCustom) {
    console.log('resolveImageUrl called with bg:', bg, 'isCustom:', isCustom);
    const fileExtension = bg.split('.').pop().toLowerCase();
    const isAnimated = ['mp4', 'webp'].includes(fileExtension);
    // Return raw URL directly
    const thumbnailUrl = isAnimated && !background_settings.animation
        ? await getThumbnailFromStorage(bg)
        : isCustom
            ? bg // Custom backgrounds are already URLs/base64
            : getThumbnailUrl('bg', bg);
    console.log('resolveImageUrl returning thumbnailUrl:', thumbnailUrl);
    return thumbnailUrl;
}

/**
 * Instantiates a background template
 * @param {string} bg Path to background
 * @param {boolean} isCustom Whether the background is custom
 * @returns {Promise<JQuery<HTMLElement>>} Background template
 */
async function getBackgroundFromTemplate(bg, isCustom) {
    const template = $('#background_template .bg_example').clone();
    const url = generateUrlParameter(bg, isCustom);
    const title = isCustom ? bg.split('/').pop() : bg;
    const friendlyTitle = title.slice(0, title.lastIndexOf('.'));

    template.attr('title', title);
    template.attr('bgfile', bg);
    template.attr('custom', String(isCustom));
    template.data('url', url);
    template.addClass('lazy-load-background');
    template.css('background-image', PLACEHOLDER_IMAGE);
    template.find('.BGSampleTitle').text(friendlyTitle);
    return template;
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

    await THUMBNAIL_STORAGE.removeItem(bg);
    if (THUMBNAIL_BLOBS.has(bg)) {
        URL.revokeObjectURL(THUMBNAIL_BLOBS.get(bg));
        THUMBNAIL_BLOBS.delete(bg);
    }
}

async function onBackgroundUploadSelected() {
    const form = $('#form_bg_download').get(0);

    if (!(form instanceof HTMLFormElement)) {
        console.error('form_bg_download is not a form');
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
 * Uploads a background to the server
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

        const response = await fetch('/api/backgrounds/upload', {
            method: 'POST',
            headers: headers,
            body: formData,
            cache: 'no-cache',
        });

        if (!response.ok) {
            throw new Error('Failed to upload background');
        }

        const bg = await response.text();
        setBackground(bg, generateUrlParameter(bg, false));
        await getBackgrounds();
        highlightNewBackground(bg);
    } catch (error) {
        console.error('Error uploading background:', error);
    }
}

/**
 * @param {string} bg
 */
function highlightNewBackground(bg) {
    // Ensure that bg is just the filename, not a path or URL
    const bgFilename = bg.includes('/') ? bg.substring(bg.lastIndexOf('/') + 1) : bg;
    const newBgThumbnail = $(`.thumbnail[data-bgfile="${bgFilename}"]`);
    if (newBgThumbnail.length > 0) {
        // Scrolling to an element within a flexbox layout can be tricky.
        // This might need adjustment depending on the actual scroll container for #bg_menu_content.
        // For now, let's assume direct parent scrolling or that #Backgrounds is the scrollable container.
        const scrollContainer = $('#Backgrounds'); // Or $('#bg_menu_content').parent() if that's the scroller
        if (newBgThumbnail.offset() && scrollContainer.offset()) {
            const scrollOffset = newBgThumbnail.offset().top - scrollContainer.offset().top + scrollContainer.scrollTop();
            scrollContainer.animate({ scrollTop: scrollOffset }, 300);
        }
        flashHighlight(newBgThumbnail);
    } else {
        console.warn(`highlightNewBackground: Could not find thumbnail for bgfile="${bgFilename}"`);
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
    const filterValue = String($(this).val()).toLowerCase();
    if (justifiedGalleryInstance) {
        justifiedGalleryInstance.filterAndDisplayImages(filterValue);
    }
}

export function initBackgrounds() {
    const galleryContainer = document.getElementById('bg_menu_content');
    if (galleryContainer) {
        justifiedGalleryInstance = new JustifiedGallery(galleryContainer, 120); // Target row height e.g. 120px
    }

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.FORCE_SET_BACKGROUND, forceSetBackground);
    $(document).on('click', '.thumbnail', onSelectBackgroundClick); // Changed from .bg_example
    $(document).on('click', '.bg_example_lock', onLockBackgroundClick);
    $(document).on('click', '.bg_example_unlock', onUnlockBackgroundClick);
    $(document).on('click', '.bg_example_edit', onRenameBackgroundClick);
    $(document).on('click', '.bg_example_cross', onDeleteBackgroundClick);
    $(document).on('click', '.bg_example_copy', onCopyToSystemBackgroundClick);
    $('#auto_background').on('click', autoBackgroundCommand);
    $('#add_bg_button').on('change', onBackgroundUploadSelected);
    $('#bg-filter').on('input', onBackgroundFilterInput);
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

    $('#background_fitting').on('input', function () {
        background_settings.fitting = String($(this).val());
        setFittingClass(background_settings.fitting);
        saveSettingsDebounced();
    });

    $('#background_thumbnails_animation').on('input', async function () {
        background_settings.animation = !!$(this).prop('checked');
        saveSettingsDebounced();

        // Refresh background thumbnails
        await getBackgrounds();
        await onChatChanged();
    });
}
