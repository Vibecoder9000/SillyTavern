import { Fuse, localforage } from '../lib.js';
import { chat_metadata, eventSource, event_types, generateQuietPrompt, getCurrentChatId, getRequestHeaders, getThumbnailUrl, saveSettingsDebounced } from '../script.js';
import { openThirdPartyExtensionMenu, saveMetadataDebounced } from './extensions.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { flashHighlight, stringFormat } from './utils.js';
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
            console.error('JustifiedGallery: Container element is null.');
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
                <div data-action="edit" class="jg-button jg-edit fa-solid fa-pen-to-square fa-fw pointer" title="${translate('Rename Background')}"></div>
                <div data-action="delete" class="jg-button jg-delete fa-solid fa-trash-can fa-fw pointer" title="${translate('Delete Background')}"></div>
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
            scaledWidth: scaledWidth,
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
        this.isLoading = false;
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
                img.filename.toLowerCase().includes(lowerQuery),
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

        const hasMoreImages = this.currentIndex < this.filteredImages.length;
        const isScrollable = this.scrollerElement.scrollHeight > this.scrollerElement.clientHeight;

        if (hasMoreImages && !isScrollable) {
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
            this.currentIndex + this.batchSize,
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
            if (this.isLoading) return;

            if (this.scrollerElement.scrollTop + this.scrollerElement.clientHeight >= this.scrollerElement.scrollHeight - 500) {
                if (this.currentIndex < this.filteredImages.length) {
                    this.loadUntilScrollable();
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
        return;
    }

    const list = chat_metadata[LIST_METADATA_KEY] || [];
    const customBgSet = new Set(list);

    window.backgroundSelector.images.forEach(img => {
        img.isCustom = customBgSet.has(img.filename);
    });

    const currentFilter = $('#bg-filter').val();
    window.backgroundSelector.search(currentFilter);
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

function onSelectBackgroundClick() {
    const $this = $(this);
    const bgFile = $this.data('bgfile');
    const fullResUrl = $this.data('url');
    const isCustom = $this.attr('custom') === 'true';

    if (!bgFile || !fullResUrl) return;

    const backgroundCssUrl = `url("${fullResUrl}")`;

    // Automatically lock the background if it's custom or other background is locked
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

async function getNewBackgroundName(referenceElement) {
    const exampleBlock = $(referenceElement).closest('.thumbnail');
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

    if (!newBgExtensionless || oldBgExtensionless === newBgExtensionless) return;

    return { oldBg, newBg: `${newBgExtensionless}.${fileExtension}` };
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


    if (`url("${url}")` === chat_metadata[BG_METADATA_KEY]) {
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
        toastr.warning('No backgrounds to choose from. Please upload some images to the "Backgrounds" folder.');
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

    // Use jQuery's .trigger('click') to ensure all bound event handlers
    // (like onSelectBackgroundClick) are correctly executed.
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
            console.error(`Failed to fetch backgrounds: ${response.status}`, await response.text());
            if (window.backgroundSelector) window.backgroundSelector.gallery.clearGallery();
            return;
        }

        const data = await response.json();
        const filenames = data.images || [];
        const aspectsMap = data.aspects || {};

        const imageDataList = filenames.map(filename => {
            const numericalAR = Number(aspectsMap[filename]);
            return {
                id: filename,
                filename: filename,
                aspectRatio: (numericalAR && numericalAR > 0) ? numericalAR : 1,
                url: getThumbnailUrl('bg', filename),
                fullResUrl: getBackgroundPath(filename),
                tags: filename.replace(/_/g, ' ').split('.').slice(0, -1).join('.').split(' '),
            };
        });

        if (window.backgroundSelector) {
            window.backgroundSelector.setImages(imageDataList);
        }

        highlightLockedBackground();

    } catch (error) {
        console.error('Error in getBackgrounds:', error);
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
            throw new Error(`Upload failed: ${response.status}`);
        }

        const bg = await response.text();
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
    const newBg = $(`.thumbnail[data-bgfile="${bg}"]`);
    if (newBg.length) {
        const scroller = $('#Backgrounds');
        const offsetTop = newBg.offset().top - scroller.offset().top + scroller.scrollTop();
        scroller.animate({ scrollTop: offsetTop - 50 }, 300);
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
    // load-once trigger and gallery initialization
    let hasLoaded = false;
    $('#site_logo').on('click', () => {
        if (!hasLoaded) {
            getBackgrounds();
            hasLoaded = true;
        }
    });

    window.backgroundSelector = new BackgroundSelector('bg_menu_content');
    window.backgroundSelector.setupInfiniteScroll();

    // Event listeners
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.FORCE_SET_BACKGROUND, forceSetBackground);
    $(document).on('click', '.thumbnail', onSelectBackgroundClick);
    $(document).on('click', '.bg_example_lock', onLockBackgroundClick);
    $(document).on('click', '.bg_example_unlock', onUnlockBackgroundClick);
    $(document).on('click', '.bg_example_edit', onRenameBackgroundClick);
    $(document).on('click', '.bg_example_cross', onDeleteBackgroundClick);
    $(document).on('click', '.bg_example_copy', onCopyToSystemBackgroundClick);
    
    $('#auto_background').on('click', autoBackgroundCommand);
    $('#add_bg_button').on('change', onBackgroundUploadSelected);
    $('#bg-filter').on('input', onBackgroundFilterInput);
    
    // This click handler for the top bar button remains, as it triggers the static hidden input.
    $('#add_background_button_top').on('click', () => {
        $('#add_bg_button').click();
    });

    $('#background_fitting').on('input', function () {
        background_settings.fitting = String($(this).val());
        setFittingClass(background_settings.fitting);
        saveSettingsDebounced();
    });

    $('#background_thumbnails_animation').on('input', async function () {
        background_settings.animation = !!$(this).prop('checked');
        saveSettingsDebounced();
        await getBackgrounds();
        await onChatChanged();
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
