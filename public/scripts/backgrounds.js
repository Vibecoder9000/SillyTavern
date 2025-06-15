import { Fuse, localforage } from '../lib.js';
import { chat_metadata, eventSource, event_types, generateQuietPrompt, getCurrentChatId, getRequestHeaders, getThumbnailUrl, saveSettingsDebounced } from '../script.js';
import { openThirdPartyExtensionMenu, saveMetadataDebounced } from './extensions.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { createThumbnail, flashHighlight, getBase64Async, stringFormat } from './utils.js';
import { t, translate } from './i18n.js';
import { Popup } from './popup.js';

function getBackgroundPath(fileUrl) {
    return `backgrounds/${encodeURIComponent(fileUrl)}`;
}

function generateUrlParameter(bg, isCustom) {
    return isCustom ? `url("${encodeURI(bg)}")` : `url("${getBackgroundPath(bg)}")`;
}

const BG_METADATA_KEY = 'custom_background';
const LIST_METADATA_KEY = 'chat_backgrounds';

// A single transparent PNG pixel used as a placeholder for errored backgrounds
const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_PIXEL_BLOB = new Blob([Uint8Array.from(atob(PNG_PIXEL), c => c.charCodeAt(0))], { type: 'image/png' });
const PLACEHOLDER_IMAGE = `url('data:image/png;base64,${PNG_PIXEL}')`;


const THUMBNAIL_STORAGE = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });
const THUMBNAIL_BLOBS = new Map();

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

const GAP_SIZE = 3; // pixels
const TARGET_ROW_HEIGHT = 120; // also pixels

class JustifiedGallery {
    constructor(container, targetRowHeight = TARGET_ROW_HEIGHT) {
        this.container = container;
        this.targetRowHeight = targetRowHeight;
        this.currentRow = [];
        this.currentRowWidth = 0;

        if (!this.container) {
            console.error("JustifiedGallery: Container element is null.");
        }
    }

    clearGallery() {
        if (!this.container) return;
        this.container.innerHTML = '';
        this.currentRow = [];
        this.currentRowWidth = 0;
    }

    renderRow(images, scaleFactor, finalHeight) {
        const rowElement = document.createElement('div');
        rowElement.className = 'gallery-row';

        images.forEach(imgData => {
            const width = imgData.scaledWidth * scaleFactor;

            const thumbnail = document.createElement('div');
            thumbnail.className = 'thumbnail';
            thumbnail.style.width = `${width}px`;
            thumbnail.style.height = `${finalHeight}px`;

            const lockedBgUrl = `url("${imgData.fullResUrl}")`;
            if (chat_metadata[BG_METADATA_KEY] === lockedBgUrl) {
                thumbnail.classList.add('locked');
            }

            thumbnail.dataset.id = imgData.id;
            thumbnail.dataset.bgfile = imgData.filename;
            thumbnail.dataset.url = imgData.fullResUrl;
            thumbnail.title = imgData.filename;
            if (imgData.isCustom) {
                thumbnail.setAttribute('custom', 'true');
            }

            const imgElement = document.createElement('img');
            imgElement.src = imgData.url;
            imgElement.alt = imgData.filename;
            imgElement.loading = 'lazy';
            thumbnail.appendChild(imgElement);

            const menu = document.createElement('div');
            menu.className = 'jg-menu';

            menu.innerHTML = `
                <div data-action="lock" class="jg-button jg-lock fa-solid fa-lock fa-fw pointer" title="${translate('Lock Background')}"></div>
                <div data-action="unlock" class="jg-button jg-unlock fa-solid fa-unlock fa-fw pointer" title="${translate('Unlock Background')}"></div>
                <div data-action="edit" class="jg-button fa-solid fa-pen-to-square fa-fw pointer" title="${translate('Rename Background')}"></div>
                <div data-action="delete" class="jg-button fa-solid fa-trash-can fa-fw pointer" title="${translate('Delete Background')}"></div>
                <div data-action="copy" class="jg-button jg-copy fa-solid fa-copy fa-fw pointer" title="${translate('Copy to System')}"></div>
            `;

            thumbnail.appendChild(menu);

            const titleDiv = document.createElement('div');
            titleDiv.className = 'BGSampleTitle';
            titleDiv.textContent = imgData.filename.substring(0, imgData.filename.lastIndexOf('.')) || imgData.filename;
            thumbnail.appendChild(titleDiv);

            rowElement.appendChild(thumbnail);
        });

        this.container.appendChild(rowElement);
    }

    addImage(imageData) {
        if (!this.container) return;
        const scaledWidth = this.targetRowHeight * imageData.aspectRatio;

        this.currentRow.push({
            ...imageData,
            scaledWidth: scaledWidth
        });
        this.currentRowWidth += scaledWidth;

        const containerWidth = this.container.offsetWidth;
        const gapWidth = (this.currentRow.length - 1) * GAP_SIZE;

        if (this.currentRowWidth + gapWidth >= containerWidth * 0.90) {
            this.completeRow();
        }
    }

    completeRow(isLastRow = false) {
        if (this.currentRow.length === 0) return;

        const containerWidth = this.container.offsetWidth;
        let finalHeight = this.targetRowHeight;
        let scaleFactor = 1.0;

        if (!isLastRow && containerWidth > 0) {
            const gapWidth = (this.currentRow.length - 1) * GAP_SIZE;
            const availableWidth = containerWidth - gapWidth;
            scaleFactor = availableWidth / this.currentRowWidth;
            finalHeight = this.targetRowHeight * scaleFactor;
        }

        this.renderRow(this.currentRow, scaleFactor, finalHeight);

        this.currentRow = [];
        this.currentRowWidth = 0;
    }
}

class BackgroundSelector {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.gallery = new JustifiedGallery(this.container);
        this.images = [];
        this.filteredImages = [];
        this.currentIndex = 0;
        this.batchSize = 90;
        this.scrollerElement = document.getElementById('Backgrounds');
        this.isLoading = false; // Add a flag to prevent multiple loads at once
    }

    setImages(imageDataList) {
        this.images = imageDataList;
        this.search('');
    }

    search(query) {
        const lowerQuery = query.toLowerCase().trim();
        this.filteredImages = !lowerQuery
            ? this.images
            : this.images.filter(img =>
                (img.tags && img.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) ||
                img.filename.toLowerCase().includes(lowerQuery)
            );
        this.resetAndLoad();
    }

    resetAndLoad() {
        this.gallery.clearGallery();
        this.currentIndex = 0;
        this.loadUntilScrollable();
    }

    loadUntilScrollable() {
        if (this.isLoading) return;
        this.isLoading = true;

        this.loadBatch();

        // After loading a batch, check if we need to load more
        const hasMoreImages = this.currentIndex < this.filteredImages.length;
        const isScrollable = this.scrollerElement.scrollHeight > this.scrollerElement.clientHeight;

        if (hasMoreImages && !isScrollable) {
            // Use a timeout to allow the DOM to render before the next check
            setTimeout(() => {
                this.isLoading = false;
                this.loadUntilScrollable();
            }, 100);
        } else {
            this.isLoading = false;
        }
    }

    loadBatch() {
        if (!this.gallery) return;

        const batch = this.filteredImages.slice(
            this.currentIndex,
            this.currentIndex + this.batchSize
        );
        
        batch.forEach(img => this.gallery.addImage(img));
        this.currentIndex += this.batchSize;

        if (this.currentIndex >= this.filteredImages.length) {
            this.gallery.completeRow(true);
        }
    }

    setupInfiniteScroll() {
        if (!this.scrollerElement) return;

        const debouncedScrollHandler = () => {
            if (this.isLoading) return; // Don't load if already loading
            
            if (this.scrollerElement.scrollTop + this.scrollerElement.clientHeight >= this.scrollerElement.scrollHeight - 500) {
                if (this.currentIndex < this.filteredImages.length) {
                    this.loadUntilScrollable(); // Use the smart loader here too
                }
            }
        };
        
        this.scrollerElement.addEventListener('scroll', debouncedScrollHandler);
    }
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

    await getChatBackgroundsList();
    highlightLockedBackground();
}

async function getChatBackgroundsList() {
    $('#bg_chat_hint').hide();
    
    if (!window.backgroundSelector || !window.backgroundSelector.images) {
        return; // Guard against running before the gallery is initialized
    }

    const list = chat_metadata[LIST_METADATA_KEY] || [];
    const customBgSet = new Set(list);

    window.backgroundSelector.images.forEach(img => img.isCustom = false);

    window.backgroundSelector.images.forEach(img => {
        if (customBgSet.has(img.filename)) {
            img.isCustom = true;
        }
    });

    const currentFilter = $('#bg-filter').val();
    window.backgroundSelector.search(currentFilter);

}

function highlightLockedBackground() {
    const allItems = $('.thumbnail, .bg_example');
    allItems.removeClass('locked');

    const lockedBackground = chat_metadata[BG_METADATA_KEY];
    if (!lockedBackground) return;

    allItems.each(function () {
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
    if (document.getElementById('bg_custom').style.backgroundImage == file) return;
    $('#bg_custom').css('background-image', file);
}

function unsetCustomBackground() { $('#bg_custom').css('background-image', 'none'); }

function onSelectBackgroundClick() {
    const $this = $(this);
    const bgFile = $this.data('bgfile');
    const fullResUrl = $this.data('url');
    const isCustom = $this.attr('custom') === 'true';

    // If any of the essential data is missing, do nothing.
    if (!bgFile || !fullResUrl) return;

    const backgroundCssUrl = `url("${fullResUrl}")`;

    // Logic for chat-specific (locked) backgrounds
    if (hasCustomBackground() || isCustom) {
        saveBackgroundMetadata(backgroundCssUrl);
        setCustomBackground();
    }
    highlightLockedBackground();

    // Logic for setting the main, global background
    const customBg = window.getComputedStyle(document.getElementById('bg_custom')).backgroundImage;
    if (customBg === 'none' || isCustom) {
        setBackground(bgFile, backgroundCssUrl);
    }
}

async function onCopyToSystemBackgroundClick(e) {
    e.stopPropagation();
    const bgNames = await getNewBackgroundName(this);
    if (!bgNames) return;
    const bgFile = await fetch(bgNames.oldBg);
    if (!bgFile.ok) { toastr.warning('Failed to copy background'); return; }
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
    if (cachedBlobUrl) return cachedBlobUrl;
    const savedBlob = await THUMBNAIL_STORAGE.getItem(bg);
    if (savedBlob) {
        const savedBlobUrl = URL.createObjectURL(savedBlob);
        THUMBNAIL_BLOBS.set(bg, savedBlobUrl);
        return savedBlobUrl;
    }

    try {
        const response = await fetch(getBackgroundPath(bg), { cache: 'force-cache' });
        if (!response.ok) throw new Error('Fetch failed: ' + response.status);
        const imageBlob = await response.blob();
        const imageBase64 = await getBase64Async(imageBlob);
        const thumbnailBase64 = await createThumbnail(imageBase64, 160, 90);
        const thumbnailBlob = await fetch(thumbnailBase64).then(res => res.blob());
        await THUMBNAIL_STORAGE.setItem(bg, thumbnailBlob);
        const blobUrl = URL.createObjectURL(thumbnailBlob);
        THUMBNAIL_BLOBS.set(bg, blobUrl);
        return blobUrl;
    } catch (error) {
        console.error(`[getThumbnailFromStorage] Error for bg="${bg}" (path: "${getBackgroundPath(bg)}"). Fallback will be used. Error details:`, error);
        const fallbackBlobUrl = URL.createObjectURL(PNG_PIXEL_BLOB);
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
    const exampleBlock = $(referenceElement).closest('.thumbnail, .bg_example');
    const isCustom = exampleBlock.attr('custom') === 'true';
    const oldBg = exampleBlock.data('bgfile') || exampleBlock.attr('bgfile');
    if (!oldBg) return;
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
    const bgToDelete = $(this).closest('.thumbnail, .bg_example');
    const url = bgToDelete.data('url');
    const isCustom = bgToDelete.attr('custom') === 'true';
    const confirm = await Popup.show.confirm(t`Delete the background?`, null);
    const bg = bgToDelete.data('bgfile') || bgToDelete.attr('bgfile');

    if (!confirm) return;

    if (!isCustom) {
        await delBackground(bg);
    } else {
        const list = chat_metadata[LIST_METADATA_KEY] || [];
        const index = list.indexOf(bg);
        if (index > -1) list.splice(index, 1);
    }

    const nextBg = bgToDelete.next();
    const prevBg = bgToDelete.prev();

        bgToDelete.remove();

    if (nextBg.length) {
        nextBg.trigger('click');
    } else if (prevBg.length) {
        prevBg.trigger('click');
    } else {
        $(`.thumbnail[data-bgfile="__transparent.png"]`).trigger('click');
    }

    if (url === chat_metadata[BG_METADATA_KEY]) {
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
    const bgTitles = Array.from(document.querySelectorAll('#bg_menu_content .BGSampleTitle'));
    const options = bgTitles.map(x => ({ element: $(x).closest('.thumbnail, .bg_example')[0], text: x.innerText.trim() })).filter(x => x.text.length > 0);
    if (options.length == 0) { toastr.warning('No backgrounds to choose from.'); return ''; }
    const list = options.map(option => `- ${option.text}`).join('\n');
    const prompt = stringFormat(autoBgPrompt, list);
    const reply = await generateQuietPrompt(prompt, false, false);
    const fuse = new Fuse(options, { keys: ['text'], threshold: 0.4 });
    const bestMatch = fuse.search(reply, { limit: 1 });
    if (bestMatch.length == 0) {
        for (const option of options) {
            if (String(reply).toLowerCase().includes(option.text.toLowerCase())) {
                $(option.element).trigger('click'); return '';
            }
        }
        toastr.warning('No match found.'); return '';
    }
    $(bestMatch[0].item.element).trigger('click');
    return '';
}

export async function getBackgrounds() {
    try {
        const response = await fetch('/api/backgrounds/all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });

        if (!response.ok) {
            console.error("Failed to fetch backgrounds:", response.status, await response.text());
            // Clear the container but preserve the upload form
            if (window.backgroundSelector) window.backgroundSelector.gallery.clearGallery();
            return;
        }

        const data = await response.json();
        const filenames = data.images || [];
        const aspectsMap = data.aspects || {};

        // Transform the API response into the data structure our gallery needs
        const imageDataList = filenames.map(filename => {
            const numericalAR = Number(aspectsMap[filename]);
            return {
                id: filename,
                filename: filename,
                aspectRatio: (numericalAR && numericalAR > 0) ? numericalAR : 1, // Default to 1 if video
                url: getThumbnailUrl('bg', filename), // Thumbnail for display
                fullResUrl: getBackgroundPath(filename), // Full-res for applying
                tags: filename.replace(/_/g, ' ').split('.').slice(0, -1).join('.').split(' '),
            };
        });

        if (window.backgroundSelector) {
            window.backgroundSelector.setImages(imageDataList);
        }

        highlightLockedBackground();

    } catch (error) {
        console.error("Error in getBackgrounds:", error);
        if (window.backgroundSelector) window.backgroundSelector.gallery.clearGallery();
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
    if (!(file instanceof File) || !file.type.startsWith('video/')) {
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
    } finally {
        toastMessage.remove();
        console.error('Error converting video to animated webp:', error);
        toastr.error(t`Error converting video to animated webp`);
    }
}

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

function highlightNewBackground(bg) {
    const newBg = $(`.thumbnail[data-bgfile="${bg}"], .bg_example[bgfile="${bg}"]`);

    if (newBg.length) {
        const scrollOffset = newBg.offset().top - newBg.parent().offset().top;
        $('#Backgrounds').scrollTop(scrollOffset);
        flashHighlight(newBg);
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
    if (window.backgroundSelector) {
        window.backgroundSelector.search(filterValue);
    }
}
export function initBackgrounds() {
    let hasLoaded = false;
    $('#site_logo').on('click', () => {
        if (!hasLoaded) {
            getBackgrounds();
            hasLoaded = true;
        }
    });

    window.backgroundSelector = new BackgroundSelector('bg_menu_content');
    window.backgroundSelector.setupInfiniteScroll();

    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.FORCE_SET_BACKGROUND, forceSetBackground);

    $(document).on('click', '.jg-button', function(e) {
        const action = $(this).data('action');
        const thumbnailContext = $(this).closest('.thumbnail').get(0);

        e.stopPropagation();

        switch (action) {
            case 'lock':
                onLockBackgroundClick.call(thumbnailContext, e);
                break;
            case 'unlock':
                onUnlockBackgroundClick.call(thumbnailContext, e);
                break;
            case 'edit':
                onRenameBackgroundClick.call(thumbnailContext, e);
                break;
            case 'delete':
                onDeleteBackgroundClick.call(thumbnailContext, e);
                break;
            case 'copy':
                onCopyToSystemBackgroundClick.call(thumbnailContext, e);
                break;
        }
    });
    
    $(document).on('click', '.thumbnail', onSelectBackgroundClick);

    $('#auto_background').on('click', autoBackgroundCommand);
    $(document).on('change', '#add_bg_button', onBackgroundUploadSelected);
    $('#bg-filter').on('input', onBackgroundFilterInput);
    
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

    const uploadFormHtml = `
        <form id="form_bg_download" style="display: none;" action="javascript:void(null);" method="post" enctype="multipart/form-data">
            <input type="file" id="add_bg_button" name="avatar" accept="image/*, video/*">
        </form>
    `;
    $('body').append(uploadFormHtml);
    $(document).on('click', '#add_background_button_top', () => {
        $('#add_bg_button').click();
    });

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lockbg', callback: () => onLockBackgroundClick(new CustomEvent('click')), aliases: ['bglock'], helpString: 'Locks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'unlockbg', callback: () => onUnlockBackgroundClick(new CustomEvent('click')), aliases: ['bgunlock'], helpString: 'Unlocks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'autobg', callback: autoBackgroundCommand, aliases: ['bgauto'], helpString: 'Automatically changes the background based on the chat context using the AI request prompt',
    }));
}
