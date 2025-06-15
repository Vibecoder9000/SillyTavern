// public/scripts/backgrounds.js (with JustifiedGallery)
import { Fuse, localforage } from '../lib.js';
import { chat_metadata, eventSource, event_types, generateQuietPrompt, getCurrentChatId, getRequestHeaders, getThumbnailUrl, saveSettingsDebounced } from '../script.js';
import { openThirdPartyExtensionMenu, saveMetadataDebounced } from './extensions.js';
import { SlashCommand } from './slash-commands/SlashCommand.js';
import { SlashCommandParser } from './slash-commands/SlashCommandParser.js';
import { createThumbnail, flashHighlight, getBase64Async, stringFormat } from './utils.js';
import { t } from './i18n.js';
import { Popup } from './popup.js';

function getBackgroundPath(fileUrl) {
    return `backgrounds/${encodeURIComponent(fileUrl)}`;
}

const BG_METADATA_KEY = 'custom_background';
const LIST_METADATA_KEY = 'chat_backgrounds';

const PNG_PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const PNG_PIXEL_BLOB = new Blob([Uint8Array.from(atob(PNG_PIXEL), c => c.charCodeAt(0))], { type: 'image/png' });
const PLACEHOLDER_IMAGE_CSS = `url('data:image/png;base64,${PNG_PIXEL}')`;


const THUMBNAIL_STORAGE = localforage.createInstance({ name: 'SillyTavern_Thumbnails' });
const THUMBNAIL_BLOBS = new Map();

export let background_settings = {
    name: '__transparent.png',
    url: generateUrlParameter('__transparent.png', false),
    fitting: 'classic',
    animation: false,
};

// Constants for JustifiedGallery
const GAP_SIZE = 3; // pixels
const TARGET_ROW_HEIGHT = 120; // pixels - Adjust as preferred default

class JustifiedGallery {
    constructor(container, targetRowHeight = TARGET_ROW_HEIGHT) {
        this.container = container; // This is the actual DOM element
        this.targetRowHeight = targetRowHeight;
        this.currentRow = [];
        this.currentRowAspectRatio = 0;
        if (this.container) {
            this.container.innerHTML = ''; // Clear container on init
        } else {
            console.error("JustifiedGallery: Container element is null. Cannot initialize.");
        }
    }

    addRow(item) {
        if (!this.container) return; // Don't operate if container is null
        this.currentRow.push(item);
        this.currentRowAspectRatio += item.aspectRatio;

        // Check if current row is full enough (simplified check)
        // A more robust check might consider container width vs sum of scaled widths
        if (this.currentRow.length > 0 && this.container.offsetWidth > 0) {
            const currentEstimatedWidth = this.currentRowAspectRatio * this.targetRowHeight;
            if (currentEstimatedWidth >= this.container.offsetWidth * 0.85) { // Trigger if 85% full
                 this.completeRow(false);
            }
        }
    }

    completeRow(force = false) {
        if (!this.container || this.currentRow.length === 0) return;

        const isLastRow = force;
        let rowHeight = this.targetRowHeight;
        const containerWidth = this.container.offsetWidth;

        // Calculate total aspect ratio of items in the row
        const totalAspectRatioInRow = this.currentRow.reduce((sum, img) => sum + img.aspectRatio, 0);

        if (!isLastRow && containerWidth > 0 && totalAspectRatioInRow > 0) {
            // Adjust row height to fit container width
            rowHeight = (containerWidth - (this.currentRow.length - 1) * GAP_SIZE) / totalAspectRatioInRow;
        } else if (isLastRow && this.currentRow.length > 0) {
            // For the last row, if forced, use targetRowHeight or a slightly smaller one if it would overflow significantly
            // This part can be adjusted for aesthetics of the last row.
            // For now, let's use targetRowHeight for simplicity if forced.
            rowHeight = this.targetRowHeight;
        }


        this.renderRow(this.currentRow, rowHeight, isLastRow);
        this.currentRow = [];
        this.currentRowAspectRatio = 0; // Reset for next row
    }

    renderRow(items, rowHeight, isLastRow) {
        if (!this.container) return;

        const rowDiv = document.createElement('div');
        rowDiv.className = 'gallery-row';
        rowDiv.style.height = `${rowHeight}px`;
        rowDiv.style.marginBottom = `${GAP_SIZE}px`; // Add margin bottom to row itself
        rowDiv.style.gap = `${GAP_SIZE}px`;


        items.forEach(imgData => {
            const thumbnail = document.createElement('div');
            thumbnail.className = 'thumbnail';
            const width = imgData.aspectRatio * rowHeight;
            thumbnail.style.width = `${width}px`;
            thumbnail.style.height = `${rowHeight}px`;

            thumbnail.dataset.id = imgData.id;
            thumbnail.dataset.bgfile = imgData.filename;
            thumbnail.dataset.url = imgData.fullResUrl; // Used by getUrlParameter
            thumbnail.title = imgData.filename;
            // 'custom' attribute is not set here as these are system backgrounds

            const img = document.createElement('img');
            img.src = imgData.url; // Thumbnail URL
            img.alt = imgData.filename;
            img.loading = 'lazy';
            thumbnail.appendChild(img);

            const menu = document.createElement('div');
            menu.className = 'bg_example_menu';

            const lockButton = document.createElement('div');
            lockButton.className = 'bg_example_lock menu_button fa-solid fa-lock fa-fw pointer';
            lockButton.title = t('Lock Background');
            menu.appendChild(lockButton);

            const unlockButton = document.createElement('div');
            unlockButton.className = 'bg_example_unlock menu_button fa-solid fa-unlock fa-fw pointer';
            unlockButton.title = t('Unlock Background');
            menu.appendChild(unlockButton);

            const editButton = document.createElement('div');
            editButton.className = 'bg_example_edit menu_button fa-solid fa-pen-to-square fa-fw pointer';
            editButton.title = t('Rename Background');
            menu.appendChild(editButton);

            const deleteButton = document.createElement('div');
            deleteButton.className = 'bg_example_cross menu_button fa-solid fa-trash-can fa-fw pointer';
            deleteButton.title = t('Delete Background');
            menu.appendChild(deleteButton);

            thumbnail.appendChild(menu);

            const titleDiv = document.createElement('div');
            titleDiv.className = 'BGSampleTitle';
            titleDiv.textContent = imgData.filename.substring(0, imgData.filename.lastIndexOf('.')) || imgData.filename;
            thumbnail.appendChild(titleDiv);

            rowDiv.appendChild(thumbnail);
        });
        this.container.appendChild(rowDiv);
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
        }
        this.gallery = new JustifiedGallery(this.galleryContainer, targetRowHeight);
        this.images = [];
        this.filteredImages = [];
        this.currentIndex = 0;
        this.batchSize = 30;
        this.scrollHandler = this.loadBatch.bind(this);
        this.scrollerElement = document.getElementById('Backgrounds'); // The scrollable popup
    }

    setImages(imageDataList) {
        this.images = imageDataList;
        this.filteredImages = this.images;
        this.reset();
        this.loadBatch();
    }

    search(query) {
        const lowerQuery = query.toLowerCase().trim();
        if (!lowerQuery) {
            this.filteredImages = this.images;
        } else {
            this.filteredImages = this.images.filter(img =>
                (img.tags && img.tags.some(tag => tag.toLowerCase().includes(lowerQuery))) ||
                img.filename.toLowerCase().includes(lowerQuery)
            );
        }
        this.reset();
        this.loadBatch();
    }

    reset() {
        if (this.gallery && this.gallery.container) {
            this.gallery.container.innerHTML = '';
        }
        if (this.gallery) {
            this.gallery.currentRow = [];
            this.gallery.currentRowAspectRatio = 0;
        }
        this.currentIndex = 0;
    }

    loadBatch() {
        if (!this.gallery) return;
        const batch = this.filteredImages.slice(this.currentIndex, this.currentIndex + this.batchSize);
        batch.forEach(imgData => this.gallery.addRow(imgData));

        // If the gallery is not full enough to render a row automatically, but we added images,
        // we might need to force a render if it's the last batch or if the container isn't filling up.
        // This logic can be tricky. For now, completeRow is mostly called when a row is "full enough".
        // We might call it after adding a batch if few items were added but scroll space is limited.

        this.currentIndex += this.batchSize;

        if (this.currentIndex >= this.filteredImages.length) {
            this.finalizeGallery();
        }
    }

    finalizeGallery() {
        if (this.gallery) {
            this.gallery.completeRow(true);
        }
    }

    setupInfiniteScroll() {
        if(this.scrollerElement){
            // Debounce scroll handler
            let isScrolling;
            const debouncedScrollHandler = () => {
                window.clearTimeout(isScrolling);
                isScrolling = setTimeout(() => {
                    if (this.scrollerElement.scrollTop + this.scrollerElement.clientHeight >= this.scrollerElement.scrollHeight - 400) { // 400px threshold
                        if (this.currentIndex < this.filteredImages.length) {
                            this.loadBatch();
                        }
                    }
                }, 100); // 100ms debounce
            };
            this.scrollerElement.removeEventListener('scroll', debouncedScrollHandler); // Remove previous if any
            this.scrollerElement.addEventListener('scroll', debouncedScrollHandler);
        } else {
            console.error("Scroller element for infinite scroll not found (expected #Backgrounds).");
        }
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
    await getChatBackgroundsList(); // For custom backgrounds per chat
    highlightLockedBackground();
}

async function getChatBackgroundsList() {
    const list = chat_metadata[LIST_METADATA_KEY];
    const listEmpty = !Array.isArray(list) || list.length === 0;
    $('#bg_custom_content').empty();
    $('#bg_chat_hint').toggle(listEmpty);
    if (listEmpty) return;

    for (const bg of list) {
        const template = await getBackgroundFromTemplate(bg, true);
        $('#bg_custom_content').append(template);
    }
    // Old lazy loader was here, not needed for this part if it uses templates not images directly
}

// getBackgroundPath has been moved to the top of the file.

function highlightLockedBackground() {
    // Adapt to new .thumbnail structure if a general background is locked
    $('.thumbnail, .bg_example').removeClass('locked');
    const lockedBackground = chat_metadata[BG_METADATA_KEY];
    if (!lockedBackground) return;

    $('.thumbnail, .bg_example').each(function () {
        const url = $(this).data('url');
        if (url === lockedBackground) {
            $(this).addClass('locked');
        }
    });
}

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

function onUnlockBackgroundClick(e) {
    e?.stopPropagation();
    removeBackgroundMetadata();
    unsetCustomBackground();
    highlightLockedBackground();
    return '';
}

function hasCustomBackground() { return chat_metadata[BG_METADATA_KEY]; }
function saveBackgroundMetadata(file) { chat_metadata[BG_METADATA_KEY] = file; saveMetadataDebounced(); }
function removeBackgroundMetadata() { delete chat_metadata[BG_METADATA_KEY]; saveMetadataDebounced(); }

function setCustomBackground() {
    const file = chat_metadata[BG_METADATA_KEY];
    if (document.getElementById('bg_custom').style.backgroundImage == file) return;
    $('#bg_custom').css('background-image', file);
}

function unsetCustomBackground() { $('#bg_custom').css('background-image', 'none'); }

function onSelectBackgroundClick() {
    const $this = $(this);
    const isCustom = $this.attr('custom') === 'true'; // .bg_example specific
    const relativeBgImage = getUrlParameter(this);

    if (!relativeBgImage) return;

    if (hasCustomBackground() || isCustom) {
        saveBackgroundMetadata(relativeBgImage);
        setCustomBackground();
    }
    highlightLockedBackground(); // Always highlight after a potential lock/unlock

    const customBg = window.getComputedStyle(document.getElementById('bg_custom')).backgroundImage;
    if (customBg !== 'none' && !isCustom) { // If a custom chat background is set, don't change main unless it's another custom
        return;
    }

    const bgFile = $this.data('bgfile') || $this.attr('bgfile'); // From .thumbnail or .bg_example
    const backgroundUrl = $this.data('url') || generateUrlParameter(bgFile, isCustom); // Prefer data-url for full path

    fetch(backgroundUrl).then(() => {
        setBackground(bgFile, backgroundUrl); // Use full URL for setBackground
    }).catch(() => {
        console.log('Background could not be set: ' + backgroundUrl);
    });
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

async function getThumbnailFromStorage(bg) {
    // This function is for client-side thumbnail generation for animated types if server thumbs are off.
    // Not directly used by JustifiedGallery if server provides all thumbnails.
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
        // Original THUMBNAIL_CONFIG was fixed, this might need adjustment if called
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

async function getNewBackgroundName(referenceElement) {
    const exampleBlock = $(referenceElement).closest('.thumbnail, .bg_example');
    const isCustom = exampleBlock.attr('custom') === 'true';
    const oldBg = exampleBlock.data('bgfile') || exampleBlock.attr('bgfile');
    if (!oldBg) return;
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
    if (!bgNames) return;
    const data = { old_bg: bgNames.oldBg, new_bg: bgNames.newBg };
    const response = await fetch('/api/backgrounds/rename', {
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(data), cache: 'no-cache',
    });
    if (response.ok) { await getBackgrounds(); highlightNewBackground(bgNames.newBg); }
    else { toastr.warning('Failed to rename background'); }
}

async function onDeleteBackgroundClick(e) {
    e.stopPropagation();
    const bgToDelete = $(this).closest('.thumbnail, .bg_example');
    const url = bgToDelete.data('url');
    const isCustom = bgToDelete.attr('custom') === 'true';
    const confirm = await Popup.show.confirm(t`Delete the background?`, null);
    const bg = bgToDelete.data('bgfile') || bgToDelete.attr('bgfile');
    if (!confirm) return;

    if (!isCustom) { await delBackground(bg); }
    else {
        const list = chat_metadata[LIST_METADATA_KEY] || [];
        const index = list.indexOf(bg);
        if (index > -1) list.splice(index, 1);
    }

    // Simplified re-click logic, may need refinement for Justified Gallery
    const nextBg = bgToDelete.parent().next().find('.thumbnail, .bg_example').first();
    const prevBg = bgToDelete.parent().prev().find('.thumbnail, .bg_example').first();

    bgToDelete.remove(); // Remove the element itself

    if (nextBg.length) nextBg.trigger('click');
    else if (prevBg.length) prevBg.trigger('click');
    else $('#bg_menu_content').find('.thumbnail, .bg_example').first().trigger('click');


    if (url === chat_metadata[BG_METADATA_KEY]) {
        removeBackgroundMetadata();
        unsetCustomBackground();
    }
    highlightLockedBackground(); // Call after potential changes
    if (isCustom) { await getChatBackgroundsList(); saveMetadataDebounced(); }
}

const autoBgPrompt = `Ignore previous instructions and choose a location ONLY from the provided list that is the most suitable for the current scene. Do not output any other text:
{0}`;
async function autoBackgroundCommand() {
    const bgTitles = Array.from(document.querySelectorAll('#bg_menu_content .BGSampleTitle'));
    const options = bgTitles.map(x => ({ element: $(x).closest('.thumbnail, .bg_example')[0], text: x.innerText.trim() })).filter(x => x.text.length > 0);
    if (options.length == 0) { toastr.warning('No backgrounds to choose from.'); return ''; }
    const list = options.map(option => `- ${option.text}`).join('\n');
    const prompt = stringFormat(autoBgPrompt, list);
    const reply = await generateQuietPrompt(prompt, false, false);
    const fuse = new Fuse(options, { keys: ['text'], threshold: 0.4 }); // Adjusted threshold
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

// This is the main function to integrate with JustifiedGallery
export async function getBackgrounds() {
    try {
        const response = await fetch('/api/backgrounds/all', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({}),
        });
        if (!response.ok) {
            console.error("Failed to fetch backgrounds:", response.status, await response.text());
            $('#bg_menu_content').html('<p>Error loading backgrounds.</p>');
            return;
        }
        const data = await response.json();
        // User's API returns: { images: string[], config: object, aspects: { [filename]: number } }
        // My Justified Gallery expects: { images: {filename, aspectRatio, url, id, tags, fullResUrl}[] }

        const filenames = data.images || [];
        const aspectsMap = data.aspects || {};

        const imageDataList = filenames.map(filename => {
            const numericalAR = Number(aspectsMap[filename]);
            return {
                filename: filename,
                aspectRatio: (numericalAR && numericalAR > 0) ? numericalAR : 1.0, // Ensure valid positive AR, default to 1.0
                url: getThumbnailUrl('bg', filename),
                id: filename,
                tags: filename.replace(/_/g, ' ').split('.').slice(0, -1).join('.').split(' '),
                fullResUrl: getBackgroundPath(filename)
            };
        });

        if (!window.backgroundSelector) {
            window.backgroundSelector = new BackgroundSelector('bg_menu_content');
        }
        window.backgroundSelector.setImages(imageDataList);
        window.backgroundSelector.setupInfiniteScroll();
        highlightLockedBackground();
    } catch (error) {
        console.error("Error in getBackgrounds:", error);
        $('#bg_menu_content').html('<p>Error processing background data.</p>');
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
        method: 'POST', headers: getRequestHeaders(), body: JSON.stringify({ bg: bg }),
    });
    await THUMBNAIL_STORAGE.removeItem(bg);
    if (THUMBNAIL_BLOBS.has(bg)) { URL.revokeObjectURL(THUMBNAIL_BLOBS.get(bg)); THUMBNAIL_BLOBS.delete(bg); }
}

async function onBackgroundUploadSelected() {
    const form = $('#form_bg_download').get(0);
    if (!(form instanceof HTMLFormElement)) { console.error('form_bg_download is not a form'); return; }
    const formData = new FormData(form);
    await convertFileIfVideo(formData);
    await uploadBackground(formData);
    form.reset();
}

async function convertFileIfVideo(formData) {
    const file = formData.get('avatar');
    if (!(file instanceof File) || !file.type.startsWith('video/')) return;
    if (typeof globalThis.convertVideoToAnimatedWebp !== 'function') {
        toastr.warning(t`Click here to install the Video Background Loader extension`, t`Video background uploads require a downloadable add-on`, {
            timeOut: 0, extendedTimeOut: 0, onclick: () => openThirdPartyExtensionMenu('https://github.com/SillyTavern/Extension-VideoBackgroundLoader'),
        });
        return;
    }
    let toastMessage = jQuery();
    try {
        toastMessage = toastr.info(t`Preparing video for upload...`, t`Please wait`, { timeOut: 0, extendedTimeOut: 0 });
        const sourceBuffer = await file.arrayBuffer();
        const convertedBuffer = await globalThis.convertVideoToAnimatedWebp({ buffer: new Uint8Array(sourceBuffer), name: file.name });
        const convertedFileName = file.name.replace(/\.[^/.]+$/, '.webp');
        const convertedFile = new File([convertedBuffer], convertedFileName, { type: 'image/webp' });
        formData.set('avatar', convertedFile);
    } catch (error) {
        formData.delete('avatar'); console.error('Error converting video:', error); toastr.error(t`Error converting video`);
    } finally {
        toastMessage.remove();
    }
}

async function uploadBackground(formData) {
    if (!formData.has('avatar')) { console.log('No file for upload.'); return; }
    const headers = getRequestHeaders(); delete headers['Content-Type'];
    try {
        const response = await fetch('/api/backgrounds/upload', {
            method: 'POST', headers: headers, body: formData, cache: 'no-cache',
        });
        if (!response.ok) throw new Error('Upload failed: ' + response.status);
        const bg = await response.text();
        // setBackground(bg, generateUrlParameter(bg, false)); // This might be redundant if getBackgrounds is called
        await getBackgrounds(); // Refresh the gallery
        highlightNewBackground(bg);
    } catch (error) { console.error('Error uploading background:', error); }
}

function highlightNewBackground(bg) {
    // This needs to work with the new .thumbnail structure
    const newBg = $(`.thumbnail[data-bgfile="${bg}"], .bg_example[bgfile="${bg}"]`);
    if (newBg.length) {
        const scroller = $('#Backgrounds');
        // Calculate offset relative to the scroller if possible
        // This might need adjustment depending on how rows are structured
        const offsetTop = newBg.offset().top - scroller.offset().top + scroller.scrollTop();
        scroller.animate({ scrollTop: offsetTop - 50 }, 300); // Scroll to new item (50px buffer)
        flashHighlight(newBg);
    }
}

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
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.FORCE_SET_BACKGROUND, forceSetBackground);

    // Unified click handler for items from JustifiedGallery and old custom list
    $(document).on('click', '.thumbnail, .bg_example', onSelectBackgroundClick);

    // Action button handlers (remain delegated from document)
    $(document).on('click', '.bg_example_lock', onLockBackgroundClick);
    $(document).on('click', '.bg_example_unlock', onUnlockBackgroundClick);
    $(document).on('click', '.bg_example_edit', onRenameBackgroundClick);
    $(document).on('click', '.bg_example_cross', onDeleteBackgroundClick);
    $(document).on('click', '.bg_example_copy', onCopyToSystemBackgroundClick);

    $('#auto_background').on('click', autoBackgroundCommand);
    $('#add_bg_button').on('change', onBackgroundUploadSelected);
    $('#bg-filter').on('input', onBackgroundFilterInput);

    // Remove user's aspect ratio dropdown as Justified Gallery handles all ratios
    // $('#background_aspect_ratio_filter').parent().remove();
    // Or simply: $('#background_aspect_ratio_filter').remove(); if it's not wrapped.
    // This needs to be done carefully depending on the final HTML structure of the user's UI.
    // For now, assume it can be removed if it exists.
    const userDropdown = document.getElementById('background_aspect_ratio_filter');
    if (userDropdown && userDropdown.parentElement.id === 'background_options_wrapper') {
        userDropdown.parentElement.remove(); // Remove the wrapper if it was created
    } else if (userDropdown) {
        userDropdown.remove();
    }


    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lockbg', callback: () => onLockBackgroundClick(new CustomEvent('click')), aliases: ['bglock'], helpString: 'Locks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'unlockbg', callback: () => onUnlockBackgroundClick(new CustomEvent('click')), aliases: ['bgunlock'], helpString: 'Unlocks a background for the currently selected chat',
    }));
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'autobg', callback: autoBackgroundCommand, aliases: ['bgauto'], helpString: 'Automatically changes the background based on the chat context using the AI request prompt',
    }));

    $('#background_fitting').on('input', function () {
        background_settings.fitting = String($(this).val());
        setFittingClass(background_settings.fitting);
        saveSettingsDebounced();
    });

    $('#background_thumbnails_animation').on('input', async function () {
        background_settings.animation = !!$(this).prop('checked');
        saveSettingsDebounced();
        await getBackgrounds(); // Refresh to apply animation setting to thumbnail URLs
        await onChatChanged();
    });
}

// Ensure CSS for Justified Gallery is present (can be added to a main CSS file)
// This is a reminder; actual CSS addition is outside this script's capability.
/*
CSS (place in a .css file loaded by the page):
.gallery-row {
  display: flex;
  margin-bottom: 3px; // GAP_SIZE
  gap: 3px; // GAP_SIZE
}
.thumbnail {
  position: relative;
  overflow: hidden;
  border-radius: 4px;
  cursor: pointer;
  flex-shrink: 0;
}
.thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
  loading: lazy;
}
.thumbnail .bg_example_menu {
  position: absolute;
  top: 2px;
  right: 2px;
  background-color: rgba(0,0,0,0.6);
  border-radius: 3px;
  padding: 2px;
  display: none; // Show on hover
  gap: 3px;
  z-index: 10;
}
.thumbnail:hover .bg_example_menu {
  display: flex;
}
.thumbnail .bg_example_menu .menu_button { // Example styling for icons if they are font awesome
  color: white;
  padding: 2px;
}
.thumbnail .BGSampleTitle {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    background-color: rgba(0,0,0,0.6);
    color: white;
    font-size: 0.8em;
    padding: 2px 4px;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
*/
