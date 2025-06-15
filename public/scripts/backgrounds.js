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

// const THUMBNAIL_CONFIG = { // No longer needed, aspect ratio comes from server
// width: 160,
// height: 90,
// };

/**
 * Global IntersectionObserver instance for lazy loading backgrounds - will be removed if native lazy loading is sufficient.
 * @type {IntersectionObserver|null}
 */
// let lazyLoadObserver = null; // Potentially remove if native lazy load is enough

// Constants for JustifiedGallery moved to module scope
const GAP_SIZE = 3; // pixels
const TARGET_ROW_HEIGHT = 120; // pixels

class JustifiedGallery {
    constructor(container, targetRowHeight = 120) {
        this.container = container;
        this.targetRowHeight = targetRowHeight;
        this.currentRow = [];
        this.currentRowAspectRatio = 0;
        if (this.container) { // Guard against null container
            this.container.innerHTML = ''; // Clear container on init
        } else {
            console.error('JustifiedGallery: Container element is null. Cannot initialize.');
        }
    }

    addRow(item) {
        if (!this.container) return; // Do nothing if container is not valid
        this.currentRow.push(item);
        this.currentRowAspectRatio += item.aspectRatio;
        // Check if current row is full enough
        if (this.container && this.currentRowAspectRatio * this.targetRowHeight >= this.container.offsetWidth - (this.currentRow.length * GAP_SIZE)) {
            this.completeRow();
        }
    }

    completeRow(force = false) {
        if (!this.container || this.currentRow.length === 0) return; // Do nothing if container is not valid or row is empty

        const isLastRow = force;
        let rowHeight = this.targetRowHeight;

        if (!isLastRow) {
            // Ensure container is valid before accessing offsetWidth
            if (!this.container) {
                 console.error("JustifiedGallery: Container is null, cannot calculate row height.");
                 return; // Or handle error appropriately
            }
            rowHeight = (this.container.offsetWidth - (this.currentRow.length -1) * GAP_SIZE) / this.currentRowAspectRatio;
        }

        this.renderRow(this.currentRow, rowHeight, isLastRow);
        this.currentRow = [];
        this.currentRowAspectRatio = 0;
    }

    renderRow(items, rowHeight, isLastRow) {
        const rowDiv = document.createElement('div');
        rowDiv.className = 'gallery-row';
        rowDiv.style.height = `${rowHeight}px`;

        items.forEach(imgData => {
            const thumbnail = document.createElement('div');
            thumbnail.className = 'thumbnail';
            // Calculate width based on aspect ratio and row height
            const width = imgData.aspectRatio * rowHeight;
            thumbnail.style.width = `${width}px`;
            thumbnail.style.height = `${rowHeight}px`; // flex-shrink will handle if it overflows a bit due to rounding

            thumbnail.dataset.id = imgData.id; // filename
            thumbnail.dataset.bgfile = imgData.filename; // for compatibility
            thumbnail.dataset.url = imgData.fullResUrl; // for onSelectBackgroundClick
            thumbnail.title = imgData.filename;
            // Set custom attribute if needed, though API doesn't provide this for /all endpoint
            // thumbnail.setAttribute('custom', 'false'); // Assuming these are not custom from /all

            const img = document.createElement('img');
            img.src = imgData.url; // Thumbnail URL from getThumbnailUrl
            img.alt = imgData.filename;
            img.loading = 'lazy';
            thumbnail.appendChild(img);

            // Add action buttons - structure adapted from #background_template
            const menu = document.createElement('div');
            menu.className = 'bg_example_menu';

            // Lock button (conditionally shown based on whether it's the locked background)
            // This logic might need adjustment as highlightLockedBackground updates classes externally
            const lockButton = document.createElement('div');
            lockButton.className = 'bg_example_lock menu_button fa-solid fa-lock fa-fw pointer';
            lockButton.title = t('Lock Background');
            menu.appendChild(lockButton);

            const unlockButton = document.createElement('div');
            unlockButton.className = 'bg_example_unlock menu_button fa-solid fa-unlock fa-fw pointer';
            unlockButton.title = t('Unlock Background');
            menu.appendChild(unlockButton);


            // Edit button (Rename)
            const editButton = document.createElement('div');
            editButton.className = 'bg_example_edit menu_button fa-solid fa-pen-to-square fa-fw pointer';
            editButton.title = t('Rename Background');
            menu.appendChild(editButton);

            // Delete button
            const deleteButton = document.createElement('div');
            deleteButton.className = 'bg_example_cross menu_button fa-solid fa-trash-can fa-fw pointer';
            deleteButton.title = t('Delete Background');
            menu.appendChild(deleteButton);

            // Copy Link button (this was not in the original template but is good to have)
            // const copyLinkButton = document.createElement('div');
            // copyLinkButton.className = 'bg_example_copylink menu_button fa-solid fa-link fa-fw pointer';
            // copyLinkButton.title = t('Copy Background Link');
            // menu.appendChild(copyLinkButton);


            thumbnail.appendChild(menu);

            // Add title display
            const titleDiv = document.createElement('div');
            titleDiv.className = 'BGSampleTitle';
            titleDiv.textContent = imgData.filename.substring(0, imgData.filename.lastIndexOf('.')) || imgData.filename;
            thumbnail.appendChild(titleDiv);


            rowDiv.appendChild(thumbnail);
        });
        if (this.container) { // Guard against null container
            this.container.appendChild(rowDiv);
        }
    }
}

class BackgroundSelector {
    constructor(containerId, targetRowHeight = TARGET_ROW_HEIGHT) {
        if (!containerId || typeof containerId !== 'string') {
            console.error('BackgroundSelector: Invalid or empty containerId provided.');
            this.galleryContainer = null;
        } else {
            this.galleryContainer = document.getElementById(containerId);
        }

        if (!this.galleryContainer) {
            console.error(`BackgroundSelector: Container element with ID '${containerId}' not found.`);
            // this.gallery will receive null and JustifiedGallery constructor should handle it.
        }
        this.gallery = new JustifiedGallery(this.galleryContainer, targetRowHeight);
        this.images = []; // Full dataset {filename, aspectRatio, url, id, tags, fullResUrl}
        this.filteredImages = [];
        this.currentIndex = 0;
        this.batchSize = 30; // Number of images to load at a time
        this.scrollHandler = this.loadBatch.bind(this); // Bound scroll handler
    }

    setImages(imageDataList) {
        this.images = imageDataList;
        this.filteredImages = this.images; // Initially, all images are shown
        this.reset();
        this.loadBatch(); // Load initial batch
    }

    search(query) {
        const lowerQuery = query.toLowerCase().trim();
        if (!lowerQuery) {
            this.filteredImages = this.images;
        } else {
            this.filteredImages = this.images.filter(img =>
                img.tags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
                img.filename.toLowerCase().includes(lowerQuery)
            );
        }
        this.reset();
        this.loadBatch();
    }

    reset() {
        if (this.gallery && this.gallery.container) { // Ensure gallery and its container exist
            this.gallery.container.innerHTML = ''; // Clear the gallery display
        }
        if (this.gallery) {
            this.gallery.currentRow = []; // Reset gallery's current row
            this.gallery.currentRowAspectRatio = 0;
        }
        this.currentIndex = 0; // Reset batch loading index
    }

    loadBatch() {
        if (!this.gallery) return; // Do nothing if gallery isn't initialized
        const batch = this.filteredImages.slice(this.currentIndex, this.currentIndex + this.batchSize);
        batch.forEach(imgData => this.gallery.addRow(imgData));
        this.currentIndex += this.batchSize;

        if (this.currentIndex >= this.filteredImages.length) {
            // All images loaded for current filter
            this.finalizeGallery();
            // Optionally remove scroll listener if no more images
            // this.galleryContainer.removeEventListener('scroll', this.scrollHandler); // Or parent scroller
        }
    }

    finalizeGallery() {
        if (this.gallery) { // Ensure gallery exists
            this.gallery.completeRow(true); // Force completion of the last row
        }
    }

    setupInfiniteScroll() {
        // Assuming Backgrounds popup is the scroller. Adjust if it's bg_menu_content itself.
        const scroller = document.getElementById('Backgrounds');
        if(scroller){
            scroller.removeEventListener('scroll', this.scrollHandler); // Remove previous if any
            scroller.addEventListener('scroll', () => {
                // Check if scrolled to near bottom
                if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 300) { // 300px threshold
                    if (this.currentIndex < this.filteredImages.length) {
                        this.loadBatch();
                    }
                }
            });
        }
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
        // This part still uses the old template system for custom backgrounds.
        // It might need its own JustifiedGallery instance or a different display method
        // if we want custom backgrounds in the justified layout as well.
        // For now, let's assume this list is separate or will be handled later.
        const template = await getBackgroundFromTemplate(bg, true); // Keep old for custom for now
        $('#bg_custom_content').append(template);
    }
    // activateLazyLoader(); // Lazy loading handled by JustifiedGallery for main list
}

function getBackgroundPath(fileUrl) {
    return `backgrounds/${encodeURIComponent(fileUrl)}`;
}

function highlightLockedBackground() {
    $('.bg_example').removeClass('locked');

    const lockedBackground = chat_metadata[BG_METADATA_KEY];

    if (!lockedBackground) {
        return;
    }

    $('.bg_example').each(function () {
        const url = $(this).data('url');
        if (url === lockedBackground) {
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

function onSelectBackgroundClick() {
    const isCustom = $(this).attr('custom') === 'true';
    const relativeBgImage = getUrlParameter(this);

    // if clicked on upload button
    if (!relativeBgImage) {
        return;
    }

    // Automatically lock the background if it's custom or other background is locked
    if (hasCustomBackground() || isCustom) {
        saveBackgroundMetadata(relativeBgImage);
        setCustomBackground();
        highlightLockedBackground();
    }
    highlightLockedBackground();

    const customBg = window.getComputedStyle(document.getElementById('bg_custom')).backgroundImage;

    // Custom background is set. Do not override the layer below
    if (customBg !== 'none') {
        return;
    }

    const bgFile = $(this).attr('bgfile');
    const backgroundUrl = getBackgroundPath(bgFile);

    // Fetching to browser memory to reduce flicker
    fetch(backgroundUrl).then(() => {
        setBackground(bgFile, relativeBgImage);
    }).catch(() => {
        console.log('Background could not be set: ' + backgroundUrl);
    });
}

async function onCopyToSystemBackgroundClick(e) {
    e.stopPropagation();
    const bgNames = await getNewBackgroundName(this);

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
async function getNewBackgroundName(referenceElement) {
    const exampleBlock = $(referenceElement).closest('.bg_example');
    const isCustom = exampleBlock.attr('custom') === 'true';
    const oldBg = exampleBlock.attr('bgfile');

    if (!oldBg) {
        console.debug('no bgfile');
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

    const bgNames = await getNewBackgroundName(this);

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
    const bgToDelete = $(this).closest('.bg_example');
    const url = bgToDelete.data('url');
    const isCustom = bgToDelete.attr('custom') === 'true';
    const confirm = await Popup.show.confirm(t`Delete the background?`, null);
    const bg = bgToDelete.attr('bgfile');

    if (confirm) {
        // If it's not custom, it's a built-in background. Delete it from the server
        if (!isCustom) {
            delBackground(bg);
        } else {
            const list = chat_metadata[LIST_METADATA_KEY] || [];
            const index = list.indexOf(bg);
            list.splice(index, 1);
        }

        const siblingSelector = '.bg_example:not(#form_bg_download)';
        const nextBg = bgToDelete.next(siblingSelector);
        const prevBg = bgToDelete.prev(siblingSelector);
        const anyBg = $(siblingSelector);

        if (nextBg.length > 0) {
            nextBg.trigger('click');
        } else if (prevBg.length > 0) {
            prevBg.trigger('click');
        } else {
            $(anyBg[Math.floor(Math.random() * anyBg.length)]).trigger('click');
        }

        bgToDelete.remove();

        if (url === chat_metadata[BG_METADATA_KEY]) {
            removeBackgroundMetadata();
            unsetCustomBackground();
            highlightLockedBackground();
        }

        if (isCustom) {
            await getChatBackgroundsList();
            saveMetadataDebounced();
        }
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
    const response = await fetch('/api/backgrounds/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}), // Empty body, but POST
    });
    if (response.ok) {
        const { images } = await response.json(); // New API: [{filename, aspectRatio}]

        const imageDataList = images.map(img => ({
            filename: img.filename,
            aspectRatio: Number(img.aspectRatio) || 1.0, // Ensure aspectRatio is a number, default to 1.0
            url: getThumbnailUrl('bg', img.filename), // Path to the actual thumbnail
            id: img.filename,
            tags: img.filename.replace(/_/g, ' ').split('.').slice(0, -1).join('.').split(' '), // Basic tags from filename
            fullResUrl: getBackgroundPath(img.filename) // Path to full resolution image
        }));

        if (!window.backgroundSelector) {
            window.backgroundSelector = new BackgroundSelector('bg_menu_content');
        }
        window.backgroundSelector.setImages(imageDataList);
        window.backgroundSelector.setupInfiniteScroll();
        highlightLockedBackground(); // Re-apply locked status after new items are rendered.
    } else {
        console.error("Failed to fetch backgrounds:", response.status);
        $('#bg_menu_content').html('<p>Error loading backgrounds.</p>');
    }
}

// function activateLazyLoader() { // Replaced by native lazy loading or JustifiedGallery logic
// // Disconnect previous observer to prevent memory leaks
// if (lazyLoadObserver) {
// lazyLoadObserver.disconnect();
// lazyLoadObserver = null;
// }
//
// const lazyLoadElements = document.querySelectorAll('.lazy-load-background');
//
// const options = {
// root: null,
// rootMargin: '200px',
// threshold: 0.01,
// };
//
// lazyLoadObserver = new IntersectionObserver((entries, observer) => {
// entries.forEach(entry => {
// if (entry.target instanceof HTMLElement && entry.isIntersecting) {
// const target = entry.target;
// const bg = target.getAttribute('bgfile');
// const isCustom = target.getAttribute('custom') === 'true';
// resolveImageUrl(bg, isCustom)
// .then(url => { target.style.backgroundImage = url; })
// .catch(() => { target.style.backgroundImage = PLACEHOLDER_IMAGE; });
// target.classList.remove('lazy-load-background');
// observer.unobserve(target);
// }
// });
// }, options);
//
// lazyLoadElements.forEach(element => {
// lazyLoadObserver.observe(element);
// });
// }

/**
 * Gets the CSS URL of the background
 * @param {Element} block
 * @returns {string} URL of the background
 */
function getUrlParameter(block) {
    // Ensure it works with new .thumbnail structure or if .bg_example is still used for custom
    const closestSelectable = $(block).closest('.thumbnail, .bg_example');
    return closestSelectable.data('url');
}

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
    const fileExtension = bg.split('.').pop().toLowerCase();
    const isAnimated = ['mp4', 'webp'].includes(fileExtension);
    const thumbnailUrl = isAnimated && !background_settings.animation
        ? await getThumbnailFromStorage(bg)
        : isCustom
            ? bg
            : getThumbnailUrl('bg', bg);

    return `url('${thumbnailUrl}')`;
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
    // template.addClass('lazy-load-background'); // Not needed if JustifiedGallery handles its own images
    template.css('background-image', PLACEHOLDER_IMAGE); // Still useful as a placeholder before JS loads for custom list
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
    const newBg = $(`.bg_example[bgfile="${bg}"]`);
    const scrollOffset = newBg.offset().top - newBg.parent().offset().top;
    $('#Backgrounds').scrollTop(scrollOffset);
    flashHighlight(newBg);
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
    const filterValue = String($(this).val()); // Search logic handled by BackgroundSelector
    if (window.backgroundSelector) {
        window.backgroundSelector.search(filterValue);
    }
}

export function initBackgrounds() {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.FORCE_SET_BACKGROUND, forceSetBackground);
    // Updated selector for Justified Gallery items
    $(document).on('click', '.thumbnail, .bg_example', onSelectBackgroundClick); // bg_example for custom ones
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
