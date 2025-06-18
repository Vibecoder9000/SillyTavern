## Video Background Pipeline Documentation

This document outlines the process of uploading an MP4 video and displaying it as an animated background, including thumbnail generation and data flow.

### 1. Video Upload Process

The upload process begins on the client-side and is handled by server-side scripts to store and process the video.

1.  **File Selection (Frontend):**
    *   The user selects a video file (e.g., MP4) through an input element in the UI.
    *   The `onBackgroundUploadSelected` function in `public/scripts/backgrounds.js` is triggered when a file is selected.

2.  **Video to WebP Conversion (Frontend):**
    *   Before uploading, if the selected file is a video (identified by its MIME type, e.g., `video/mp4`), the `convertFileIfVideo` function in `public/scripts/backgrounds.js` is called.
    *   This function uses `globalThis.convertVideoToAnimatedWebp` (expected to be provided by a browser extension like 'Video Background Loader') to convert the video into an animated WebP format. This is done to ensure compatibility and optimize for web display.
    *   If the conversion is successful, the `FormData` is updated to use the new WebP file. If conversion fails or is not applicable (e.g., not a video file, or the conversion tool is not available), the original file is used.

3.  **File Submission (Frontend to Backend):**
    *   The `uploadBackground` function in `public/scripts/backgrounds.js` takes the `FormData` (which now contains either the original file or the converted WebP).
    *   It sends a POST request to the `/api/backgrounds/upload` endpoint. The `Content-Type` header is removed to let the browser set it correctly for `FormData`.

4.  **File Saving (Backend):**
    *   The Express router in `src/endpoints/backgrounds.js` handles the `/api/backgrounds/upload` request.
    *   Multer middleware (configured in the application, though not explicitly shown in `backgrounds.js` but typical for Express file uploads) processes the `FormData`. The uploaded file is temporarily stored (e.g., in `request.file.path`).
    *   The handler function then copies the uploaded file from its temporary location to the user-specific backgrounds directory: `path.join(request.user.directories.backgrounds, filename)`.
    *   The original temporary file is then unlinked (deleted).

5.  **Thumbnail Invalidation (Backend):**
    *   After successfully saving the new background file, the `invalidateThumbnail` function (imported from `src/endpoints/thumbnails.js`) is called with the type `'bg'` and the filename.
    *   This function deletes any pre-existing thumbnail for a file with the same name in the thumbnails cache directory (`request.user.directories.thumbnailsBg`). This ensures that a fresh thumbnail will be generated when next requested.
    *   The server responds with the filename if successful.

### 2. Thumbnail Generation Process

Thumbnails are generated and served on-demand to provide previews for backgrounds, especially for videos or when animations are disabled.

1.  **Thumbnail Request (Client-side):**
    *   When displaying backgrounds, the client-side script `public/scripts/backgrounds.js` needs to get a URL for each background image.
    *   The `resolveImageUrl(bg, isCustom)` function determines the appropriate URL.
    *   If the background is an animated format (`.mp4`, `.webp`) and animations are disabled (`!background_settings.animation`), it attempts to get a client-cached or newly generated thumbnail using `getThumbnailFromStorage(bg)`.
        *   `getThumbnailFromStorage` first checks an in-memory cache (`THUMBNAIL_BLOBS`).
        *   If not found, it checks `localforage` (`THUMBNAIL_STORAGE`) for a previously stored thumbnail blob.
        *   If still not found, it fetches the original background, creates a thumbnail using `createThumbnail` (which leverages a canvas element for resizing), and stores the blob in `localforage` and the in-memory cache.
    *   For other cases, or as a fallback, it uses `getThumbnailUrl('bg', filename)`, which constructs a URL pointing to the server's thumbnail endpoint: `/api/thumbnail?type=bg&file=<filename>`.

2.  **Thumbnail Serving (Backend):**
    *   The `src/endpoints/thumbnails.js` router handles requests to `/api/thumbnail`.
    *   It expects `type` (e.g., 'bg', 'avatar') and `file` (filename) as query parameters.
    *   **If `thumbnails.enabled` is `false` (globally configured in `config.yaml`):**
        *   The server retrieves the original file from the corresponding original folder (e.g., `request.user.directories.backgrounds` for 'bg' type).
        *   It sends the original file directly with the appropriate `Content-Type`.
    *   **If `thumbnails.enabled` is `true`:**
        *   The `generateThumbnail(directories, type, file)` function is called.

3.  **`generateThumbnail` Function (Backend):**
    *   **Cache Check & Regeneration Logic:**
        *   It constructs paths to the potential cached thumbnail (`pathToCachedFile` in `directories.thumbnailsBg`) and the original file (`pathToOriginalFile` in `directories.backgrounds`).
        *   If a cached thumbnail exists and the original file hasn't been modified since the thumbnail was created (checked using `mtimeMs` of original vs `ctimeMs` of cached), the cached thumbnail path is returned.
        *   If the original file is newer, `shouldRegenerate` is set to true.
    *   **Generation:**
        *   If no valid cached thumbnail exists or regeneration is needed, and the original file exists:
            *   The `Jimp` library is used to process the image: `Jimp.read(pathToOriginalFile)`.
            *   The image is resized using `image.cover({ w: width, h: height })`. The dimensions are fetched from `dimensions[type]` (e.g., `dimensions.bg`, configured via `thumbnails.dimensions.bg` in `config.yaml`, defaulting to `[160, 90]`).
            *   The processed image is converted to a buffer, either PNG or JPEG based on `pngFormat` config (`thumbnails.format`) and `quality` (`thumbnails.quality`).
            *   If Jimp fails to process the image (e.g., unsupported video format for static thumbnailing by Jimp), it falls back to reading the original file directly into a buffer. This means for videos, the "thumbnail" might be the video itself if Jimp can't make a static image.
            *   The resulting buffer is written atomically to `pathToCachedFile`.
    *   **Return & Response:**
        *   The path to the (newly generated or existing) cached thumbnail is returned by `generateThumbnail`.
        *   If the process fails at any point (e.g., original file not found, Jimp error without fallback), `null` is returned.
        *   The main router then reads the thumbnail file from disk and sends it as the HTTP response with the correct `Content-Type`. If `pathToCachedFile` is null or the file doesn't exist, a 404 is sent.

4.  **Initial Cache Generation (`ensureThumbnailCache`):**
    *   On server startup, or potentially at other times, `ensureThumbnailCache` can be called.
    *   This function iterates through all user directories. If a user's `thumbnailsBg` directory is empty, it logs "Generating thumbnails cache..." and then asynchronously calls `generateThumbnail` for every file in their `backgrounds` directory to pre-populate the thumbnail cache.

### 3. Displaying Backgrounds

Once uploaded and (potentially) thumbnailed, backgrounds are displayed in the user interface.

1.  **Fetching Background List (Client-side):**
    *   The `getBackgrounds()` function in `public/scripts/backgrounds.js` is called to populate the background selection menu.
    *   It makes a POST request to `/api/backgrounds/all`.
    *   The backend (`src/endpoints/backgrounds.js`) responds with a JSON object containing:
        *   `images`: An array of filenames from the user's `backgrounds` directory.
        *   `config`: Thumbnail dimensions (`width`, `height`) for backgrounds.
    *   For each background filename, a template element is created using `getBackgroundFromTemplate(bg, isCustom)`. This function:
        *   Sets attributes like `bgfile`, `title`, and `custom`.
        *   Sets a placeholder `background-image` (`PLACEHOLDER_IMAGE`).
        *   Adds the `lazy-load-background` class to enable lazy loading.
    *   These elements are appended to the background menu (`#bg_menu_content`).
    *   `activateLazyLoader()` is called to initialize an `IntersectionObserver` that loads background images only when they become visible.

2.  **Setting Background (Client-side):**
    *   When a user clicks on a background in the selection menu (`.bg_example`), the `onSelectBackgroundClick` event handler in `public/scripts/backgrounds.js` is triggered.
    *   **Chat-Specific Backgrounds:**
        *   If a custom background is already locked for the current chat (`hasCustomBackground()` which checks `chat_metadata[BG_METADATA_KEY]`), or if the selected background is a "custom" one (dynamically added, not from the server's default list), the selected background URL is saved to `chat_metadata[BG_METADATA_KEY]`.
        *   `setCustomBackground()` is then called, which applies the URL stored in `chat_metadata[BG_METADATA_KEY]` to the `#bg_custom` element's `background-image` style. This element acts as an overlay or specific layer for chat-locked backgrounds.
        *   If no chat-specific background is set (`customBg === 'none'`), the global background is updated.
    *   **Global Background Update:**
        *   The `setBackground(bgFile, relativeBgImage)` function is called (potentially after a fetch to reduce flicker if it's not a custom/locked scenario).
            *   `bgFile` is the filename (e.g., `myvideo.webp`).
            *   `relativeBgImage` is the CSS `url(...)` string.
        *   This function updates the `background-image` style of the `#bg1` element (the main background layer).
        *   It also saves the `name` (filename) and `url` to `background_settings` and persists this with `saveSettingsDebounced()`.

3.  **Resolving Image URL (`resolveImageUrl`):**
    *   The `resolveImageUrl(bg, isCustom)` function in `public/scripts/backgrounds.js` is crucial for determining what URL to actually use for the `background-image` style.
    *   It checks the file extension. If it's an animated format (`.mp4`, `.webp`) AND background animations are disabled globally (`!background_settings.animation`):
        *   It calls `getThumbnailFromStorage(bg)` to get a static thumbnail (either from client-side cache or newly generated by the client).
    *   Otherwise (if it's not animated, or animations are enabled):
        *   If `isCustom` is true, the URL is simply the `bg` path itself (assumed to be a blob URL or data URL).
        *   If `isCustom` is false, it constructs the server thumbnail URL using `getThumbnailUrl('bg', bg)`, which points to `/api/thumbnail?type=bg&file=<filename>`.
    *   The function returns a string formatted as `url('THE_RESOLVED_URL')`.

4.  **Lazy Loading:**
    *   The `activateLazyLoader` function sets up an `IntersectionObserver`.
    *   Backgrounds in the selection menu with the class `lazy-load-background` will initially have a placeholder image.
    *   When an element scrolls into view, the observer calls `resolveImageUrl` to get the correct thumbnail or image URL and updates its `background-image` style.

5.  **Background Fitting and Animation Toggle:**
    *   Users can choose a `fitting` style (e.g., 'cover', 'contain', 'stretch', 'center') from `#background_fitting`. This adds/removes corresponding CSS classes to `#bg1` and `#bg_custom` elements.
    *   The `background_thumbnails_animation` checkbox toggles the `background_settings.animation` boolean. This affects `resolveImageUrl`'s logic for animated formats. Changing this setting re-fetches and re-evaluates all background displays.

### 4. Relevant Functions and Their Roles

Here's a summary of the most important functions involved in the video background pipeline:

**Client-Side (`public/scripts/backgrounds.js`):**

*   **`onBackgroundUploadSelected()`**:
    *   Triggered on file input. Initiates the upload process.
    *   Prepares `FormData` for submission.
*   **`convertFileIfVideo(formData)`**:
    *   Checks if the uploaded file is a video.
    *   If it is, attempts to convert it to an animated WebP file using `globalThis.convertVideoToAnimatedWebp`.
    *   Updates `formData` with the converted file or uses the original if conversion fails/not applicable.
*   **`uploadBackground(formData)`**:
    *   Sends the `formData` (containing the image/WebP) to the `/api/backgrounds/upload` backend endpoint.
    *   Handles the server response and updates the UI.
*   **`getBackgrounds()`**:
    *   Fetches the list of available background files from `/api/backgrounds/all`.
    *   Populates the background selection UI.
*   **`setBackground(bg, url)`**:
    *   Sets the main background image style (`#bg1`) using the provided filename and CSS URL.
    *   Updates and saves `background_settings`.
*   **`resolveImageUrl(bg, isCustom)`**:
    *   Determines the correct URL to use for a background image.
    *   Considers if the image is animated, if animations are enabled, and if it's a custom (client-side) background.
    *   Returns a URL pointing to either the original file, a server-generated thumbnail, or a client-generated/cached thumbnail.
*   **`getThumbnailFromStorage(bg)`**:
    *   Manages client-side thumbnail caching for animated files when animations are off.
    *   Checks in-memory cache (`THUMBNAIL_BLOBS`) and `localforage` (`THUMBNAIL_STORAGE`).
    *   If not found, fetches the original, generates a thumbnail using a canvas (`createThumbnail`), and caches it.
*   **`createThumbnail(imageBase64, width, height)` (from `utils.js` but used by `backgrounds.js`):**
    *   Takes a base64 image, creates an image element, draws it to a canvas resized to the target dimensions, and returns the canvas content as a new base64 thumbnail.
*   **`onSelectBackgroundClick()`**:
    *   Handles clicks on background items in the menu.
    *   Manages setting global vs. chat-specific backgrounds.
*   **`setCustomBackground()` / `unsetCustomBackground()`**:
    *   Apply or remove a chat-specific background by updating the `#bg_custom` element's style based on `chat_metadata[BG_METADATA_KEY]`.
*   **`activateLazyLoader()`**:
    *   Initializes an `IntersectionObserver` to lazy-load background images in the selection menu.
*   **`initBackgrounds()`**:
    *   Sets up all event listeners and slash commands related to backgrounds.

**Server-Side (`src/endpoints/backgrounds.js`):**

*   **`router.post('/upload', ...)` (Express route handler):**
    *   Receives uploaded files (handled by Multer middleware).
    *   Saves the file to the user's `backgrounds` directory (`request.user.directories.backgrounds`).
    *   Calls `invalidateThumbnail` to remove any old thumbnail for this file.
*   **`router.post('/all', ...)` (Express route handler):**
    *   Responds with a list of all filenames in the user's `backgrounds` directory and thumbnail configuration.
*   **`router.post('/delete', ...)` / `router.post('/rename', ...)`**:
    *   Handle deletion and renaming of background files, including invalidating corresponding thumbnails.

**Server-Side (`src/endpoints/thumbnails.js`):**

*   **`router.get('/', ...)` (Express route handler for `/api/thumbnail`):**
    *   Serves thumbnail images.
    *   If `thumbnails.enabled` is false, serves the original image.
    *   Otherwise, calls `generateThumbnail` and serves the result.
*   **`generateThumbnail(directories, type, file)`**:
    *   The core thumbnail generation logic.
    *   Checks if a valid cached thumbnail exists and if the original file has been updated.
    *   If needed, uses the `Jimp` library to read the original file, resize it (cover), and save it to the thumbnail cache directory (`directories.thumbnailsBg` or `directories.thumbnailsAvatar`).
    *   Handles different output formats (PNG/JPEG) and quality settings.
    *   May fall back to serving the original file as a buffer if Jimp processing fails.
*   **`invalidateThumbnail(directories, type, file)`**:
    *   Deletes a specific thumbnail file from the cache, forcing regeneration on the next request.
*   **`ensureThumbnailCache(directoriesList)`**:
    *   Scans background directories and pre-generates thumbnails if the cache is empty for a user.

**Server-Side (`src/endpoints/files.js`):**

*   **`router.post('/upload', ...)`**:
    *   A more generic file upload endpoint. While `backgrounds.js` uses its own specific upload route for backgrounds, this endpoint exists for other file upload functionalities. It validates filenames using `validateAssetFileName`.
*   **`validateAssetFileName(fileName)` (from `src/endpoints/assets.js` but used by `files.js`):**
    *   Provides validation logic for asset filenames.

This list covers the primary functions responsible for the video background pipeline from upload to display.

### 5. Relevant Function Code Snippets

Below are the code snippets for the functions discussed in this document.

```javascript
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
```

```javascript
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
```

```javascript
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
```

```javascript
export async function getBackgrounds() {
    const response = await fetch('/api/backgrounds/all', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({}),
    });
    if (response.ok) {
        const { images, config } = await response.json();
        Object.assign(THUMBNAIL_CONFIG, config);
        $('#bg_menu_content').children('div').remove();
        for (const bg of images) {
            const template = await getBackgroundFromTemplate(bg, false);
            $('#bg_menu_content').append(template);
        }
        activateLazyLoader();
    }
}
```

```javascript
async function setBackground(bg, url) {
    $('#bg1').css('background-image', url);
    background_settings.name = bg;
    background_settings.url = url;
    saveSettingsDebounced();
}
```

```javascript
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
```

```javascript
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
```

```javascript
/**
 * Creates a thumbnail from a data URL.
 * @param {string} dataUrl The data URL encoded data of the image.
 * @param {number|null} maxWidth The maximum width of the thumbnail.
 * @param {number|null} maxHeight The maximum height of the thumbnail.
 * @param {string} [type='image/jpeg'] The type of the thumbnail.
 * @returns {Promise<string>} A promise that resolves to the thumbnail data URL.
 */
export function createThumbnail(dataUrl, maxWidth = null, maxHeight = null, type = 'image/jpeg') {
    // Someone might pass in a base64 encoded string without the data URL prefix
    if (!dataUrl.includes('data:')) {
        dataUrl = `data:image/jpeg;base64,${dataUrl}`;
    }

    return new Promise((resolve, reject) => {
        const img = new Image();
        img.src = dataUrl;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            // Calculate the thumbnail dimensions while maintaining the aspect ratio
            const aspectRatio = img.width / img.height;
            let thumbnailWidth = maxWidth;
            let thumbnailHeight = maxHeight;

            if (maxWidth === null) {
                thumbnailWidth = img.width;
                maxWidth = img.width;
            }

            if (maxHeight === null) {
                thumbnailHeight = img.height;
                maxHeight = img.height;
            }

            if (img.width > img.height) {
                thumbnailHeight = maxWidth / aspectRatio;
            } else {
                thumbnailWidth = maxHeight * aspectRatio;
            }

            // Set the canvas dimensions and draw the resized image
            canvas.width = thumbnailWidth;
            canvas.height = thumbnailHeight;
            ctx.drawImage(img, 0, 0, thumbnailWidth, thumbnailHeight);

            // Convert the canvas to a data URL and resolve the promise
            const thumbnailDataUrl = canvas.toDataURL(type);
            resolve(thumbnailDataUrl);
        };

        img.onerror = () => {
            reject(new Error('Failed to load the image.'));
        };
    });
}
```

```javascript
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
```

```javascript
function setCustomBackground() {
    const file = chat_metadata[BG_METADATA_KEY];

    // bg already set
    if (document.getElementById('bg_custom').style.backgroundImage == file) {
        return;
    }

    $('#bg_custom').css('background-image', file);
}
```

```javascript
function unsetCustomBackground() {
    $('#bg_custom').css('background-image', 'none');
}
```

```javascript
function activateLazyLoader() {
    // Disconnect previous observer to prevent memory leaks
    if (lazyLoadObserver) {
        lazyLoadObserver.disconnect();
        lazyLoadObserver = null;
    }

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
```

```javascript
export function initBackgrounds() {
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.FORCE_SET_BACKGROUND, forceSetBackground);
    $(document).on('click', '.bg_example', onSelectBackgroundClick);
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
```

```javascript
router.post('/upload', function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const img_path = path.join(request.file.destination, request.file.filename);
    const filename = request.file.originalname;

    try {
        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename));
        fs.unlinkSync(img_path);
        invalidateThumbnail(request.user.directories, 'bg', filename);
        response.send(filename);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});
```

```javascript
router.post('/all', function (request, response) {
    const images = getImages(request.user.directories.backgrounds);
    const config = { width: dimensions.bg[0], height: dimensions.bg[1] };
    response.json({ images, config });
});
```

```javascript
// Important: This route must be mounted as '/thumbnail'. It is used in the client code and saved to chat files.
router.get('/', async function (request, response) {
    try{
        if (typeof request.query.file !== 'string' || typeof request.query.type !== 'string') {
            return response.sendStatus(400);
        }

        const type = request.query.type;
        const file = sanitize(request.query.file);

        if (!type || !file) {
            return response.sendStatus(400);
        }

        if (!(type == 'bg' || type == 'avatar')) {
            return response.sendStatus(400);
        }

        if (sanitize(file) !== file) {
            console.error('Malicious filename prevented');
            return response.sendStatus(403);
        }

        if (!thumbnailsEnabled) {
            const folder = getOriginalFolder(request.user.directories, type);

            if (folder === undefined) {
                return response.sendStatus(400);
            }

            const pathToOriginalFile = path.join(folder, file);
            if (!fs.existsSync(pathToOriginalFile)) {
                return response.sendStatus(404);
            }
            const contentType = mime.lookup(pathToOriginalFile) || 'image/png';
            const originalFile = await fsPromises.readFile(pathToOriginalFile);
            response.setHeader('Content-Type', contentType);
            return response.send(originalFile);
        }

        const pathToCachedFile = await generateThumbnail(request.user.directories, type, file);

        if (!pathToCachedFile) {
            return response.sendStatus(404);
        }

        if (!fs.existsSync(pathToCachedFile)) {
            return response.sendStatus(404);
        }

        const contentType = mime.lookup(pathToCachedFile) || 'image/jpeg';
        const cachedFile = await fsPromises.readFile(pathToCachedFile);
        response.setHeader('Content-Type', contentType);
        return response.send(cachedFile);
    } catch (error) {
        console.error('Failed getting thumbnail', error);
        return response.sendStatus(500);
    }
});
```

```javascript
/**
 * Generates a thumbnail for the given file.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {'bg' | 'avatar'} type Type of the thumbnail
 * @param {string} file Name of the file
 * @returns
 */
async function generateThumbnail(directories, type, file) {
    let thumbnailFolder = getThumbnailFolder(directories, type);
    let originalFolder = getOriginalFolder(directories, type);
    if (thumbnailFolder === undefined || originalFolder === undefined) throw new Error('Invalid thumbnail type');
    const pathToCachedFile = path.join(thumbnailFolder, file);
    const pathToOriginalFile = path.join(originalFolder, file);

    const cachedFileExists = fs.existsSync(pathToCachedFile);
    const originalFileExists = fs.existsSync(pathToOriginalFile);

    // to handle cases when original image was updated after thumb creation
    let shouldRegenerate = false;

    if (cachedFileExists && originalFileExists) {
        const originalStat = fs.statSync(pathToOriginalFile);
        const cachedStat = fs.statSync(pathToCachedFile);

        if (originalStat.mtimeMs > cachedStat.ctimeMs) {
            //console.warn('Original file changed. Regenerating thumbnail...');
            shouldRegenerate = true;
        }
    }

    if (cachedFileExists && !shouldRegenerate) {
        return pathToCachedFile;
    }

    if (!originalFileExists) {
        return null;
    }

    try {
        let buffer;

        try {
            const size = dimensions[type];
            const image = await Jimp.read(pathToOriginalFile);
            const width = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
            const height = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
            image.cover({ w: width, h: height });
            buffer = pngFormat
                ? await image.getBuffer(JimpMime.png)
                : await image.getBuffer(JimpMime.jpeg, { quality: quality, jpegColorSpace: 'ycbcr' });
        }
        catch (inner) {
            console.warn(`Thumbnailer can not process the image: ${pathToOriginalFile}. Using original size`, inner);
            buffer = fs.readFileSync(pathToOriginalFile);
        }

        writeFileAtomicSync(pathToCachedFile, buffer);
    }
    catch (outer) {
        return null;
    }

    return pathToCachedFile;
}
```

```javascript
/**
 * Removes the generated thumbnail from the disk.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {'bg' | 'avatar'} type Type of the thumbnail
 * @param {string} file Name of the file
 */
export function invalidateThumbnail(directories, type, file) {
    const folder = getThumbnailFolder(directories, type);
    if (folder === undefined) throw new Error('Invalid thumbnail type');

    const pathToThumbnail = path.join(folder, file);

    if (fs.existsSync(pathToThumbnail)) {
        fs.unlinkSync(pathToThumbnail);
    }
}
```

```javascript
/**
 * Ensures that the thumbnail cache for backgrounds is valid.
 * @param {import('../users.js').UserDirectoryList[]} directoriesList User directories
 * @returns {Promise<void>} Promise that resolves when the cache is validated
 */
export async function ensureThumbnailCache(directoriesList) {
    for (const directories of directoriesList) {
        const cacheFiles = fs.readdirSync(directories.thumbnailsBg);

        // files exist, all ok
        if (cacheFiles.length) {
            continue;
        }

        console.info('Generating thumbnails cache. Please wait...');

        const bgFiles = fs.readdirSync(directories.backgrounds);
        const tasks = [];

        for (const file of bgFiles) {
            tasks.push(generateThumbnail(directories, 'bg', file));
        }

        await Promise.all(tasks);
        console.info(`Done! Generated: ${bgFiles.length} preview images`);
    }
}
```

```javascript
router.post('/upload', async (request, response) => {
    try {
        if (!request.body.name) {
            return response.status(400).send('No upload name specified');
        }

        if (!request.body.data) {
            return response.status(400).send('No upload data specified');
        }

        // Validate filename
        const validation = validateAssetFileName(request.body.name);
        if (validation.error)
            return response.status(400).send(validation.message);

        const pathToUpload = path.join(request.user.directories.files, request.body.name);
        writeFileSyncAtomic(pathToUpload, request.body.data, 'base64');
        const url = clientRelativePath(request.user.directories.root, pathToUpload);
        console.info(`Uploaded file: ${url} from ${request.user.profile.handle}`);
        return response.send({ path: url });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
```

```javascript
/**
 * Validates the input filename for the asset.
 * @param {string} inputFilename Input filename
 * @returns {{error: boolean, message?: string}} Whether validation failed, and why if so
 */
export function validateAssetFileName(inputFilename) {
    if (!/^[a-zA-Z0-9_\-.]+$/.test(inputFilename)) {
        return {
            error: true,
            message: 'Illegal character in filename; only alphanumeric, \'_\', \'-\' are accepted.',
        };
    }

    const inputExtension = path.extname(inputFilename).toLowerCase();
    if (UNSAFE_EXTENSIONS.some(ext => ext === inputExtension)) {
        return {
            error: true,
            message: 'Forbidden file extension.',
        };
    }

    if (inputFilename.startsWith('.')) {
        return {
            error: true,
            message: 'Filename cannot start with \'.\'',
        };
    }

    if (sanitize(inputFilename) !== inputFilename) {
        return {
            error: true,
            message: 'Reserved or long filename.',
        };
    }

    return { error: false };
}
```
