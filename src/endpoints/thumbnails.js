import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp, JimpMime } from '../jimp.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { imageSize as sizeOf } from 'image-size';

import { getImages, getConfigValue } from '../util.js';

export const publicRouter = express.Router();
export const apiRouter = express.Router();

const CONCURRENCY_LIMIT = 8;
export const SKIPPED_EXTENSIONS_FOR_JIMP = ['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', '.webp', '.gif'];

const thumbnailResolution = getConfigValue('thumbnails.resolution', 15000);
const thumbnailsEnabled = !!getConfigValue('thumbnails.enabled', true, 'boolean');
const quality = Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 95, 'number'))));
const pngFormat = String(getConfigValue('thumbnails.format', 'jpg')).toLowerCase().trim() === 'png';

/**
 * @typedef {'bg' | 'avatar' | 'persona'} ThumbnailType
 */

/** @type {Record<string, number[]>} */
export const dimensions = {
    'bg': getConfigValue('thumbnails.dimensions.bg', [160, 90]),
    'avatar': getConfigValue('thumbnails.dimensions.avatar', [96, 144]),
    'persona': getConfigValue('thumbnails.dimensions.persona', [96, 144]),
};

/**
 * Gets a path to thumbnail folder based on the type.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Thumbnail type
 * @returns {string} Path to the thumbnails folder
 */
function getThumbnailFolder(directories, type) {
    let thumbnailFolder;
    switch (type) {
        case 'bg':
            thumbnailFolder = directories.thumbnailsBg;
            break;
        case 'avatar':
            thumbnailFolder = directories.thumbnailsAvatar;
            break;
        case 'persona':
            thumbnailFolder = directories.thumbnailsPersona;
            break;
    }
    return thumbnailFolder;
}

/**
 * Gets a path to the original images folder based on the type.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Thumbnail type
 * @returns {string} Path to the original images folder
 */
function getOriginalFolder(directories, type) {
    let originalFolder;
    switch (type) {
        case 'bg':
            originalFolder = directories.backgrounds;
            break;
        case 'avatar':
            originalFolder = directories.characters;
            break;
        case 'persona':
            originalFolder = directories.avatars;
            break;
    }
    return originalFolder;
}

/**
 * Removes the generated thumbnail from the disk.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Type of the thumbnail
 * @param {string} file Name of the file
 */
export function invalidateThumbnail(directories, type, file) {
    const folder = getThumbnailFolder(directories, type);
    if (folder === undefined) throw new Error('Invalid thumbnail type');
    const pathToThumbnail = path.join(folder, sanitize(file));
    if (fs.existsSync(pathToThumbnail)) {
        try {
            fs.unlinkSync(pathToThumbnail);
        } catch (e) {
            console.error(`[invalidateThumbnail] Failed to delete thumbnail file ${pathToThumbnail}:`, e);
        }
    }
}

/**
 * Generates or retrieves a thumbnail for a given file.
 * @param {import('../users.js').UserDirectoryList} directories - User's directory configuration.
 * @param {ThumbnailType} type - Type of thumbnail ('bg', 'avatar', 'persona').
 * @param {string} file - The filename of the image.
 * @param {boolean} [forceGenerate=false] - Whether to force generation even if a thumbnail exists.
 * @param {boolean} [checkOnly=true] - Whether to only check for existence without generating.
 * @returns {Promise<{path: string|null, aspectRatio: number|null}>} Path to thumbnail and its aspect ratio.
 */
export async function generateThumbnail(directories, type, file, forceGenerate = false, checkOnly = true) {
    const thumbnailFolder = getThumbnailFolder(directories, type);
    const originalFolder = getOriginalFolder(directories, type);
    const pathToCachedFile = path.join(thumbnailFolder, file);

    if (!forceGenerate && fs.existsSync(pathToCachedFile)) {
        try {
            const buffer = fs.readFileSync(pathToCachedFile);
            const dimensions = sizeOf(buffer);
            const ratio = (dimensions.height > 0) ? (dimensions.width / dimensions.height) : 1.0;
            return { path: pathToCachedFile, aspectRatio: ratio };
        } catch (e) {
            console.warn(`[Thumbnails] Could not read dimensions for ${file}. It might be corrupted.`, e);
        }
    }

    if (checkOnly && !forceGenerate) {
        return { path: null, aspectRatio: null, resolution: null };
    }

    const pathToOriginalFile = path.join(originalFolder, file);
    if (!fs.existsSync(pathToOriginalFile)) {
        console.error(`[generateThumbnail] Cannot generate thumbnail, original file not found: ${pathToOriginalFile}`);
        return { path: null, aspectRatio: null, resolution: null };
    }

    if (SKIPPED_EXTENSIONS_FOR_JIMP.includes(path.extname(file).toLowerCase())) {
        return { path: null, aspectRatio: null, resolution: null };
    }

    const result = await processSingleImage(file, originalFolder, thumbnailFolder);

    if (result.success) {
        return { path: pathToCachedFile, aspectRatio: result.aspectRatio, resolution: result.resolution };
    } else {
        return { path: null, aspectRatio: null, resolution: null };
    }
}

/**
 * Processes a single image to generate its thumbnail.
 * @param {string} file - The filename of the image.
 * @param {string} originalFolder - Path to the original image folder.
 * @param {string} thumbnailFolder - Path to the thumbnail output folder.
 * @returns {Promise<{success: boolean, timings?: object, filename?: string, error?: string}>} Result of the processing.
 */
async function processSingleImage(file, originalFolder, thumbnailFolder) {
    const pathToOriginalFile = path.join(originalFolder, file);
    const pathToCachedFile = path.join(thumbnailFolder, file);
    const timings = { filename: file, read: 0, resize: 0, buffer: 0, write: 0, total: 0 };
    const totalStartTime = performance.now();
    let stepStartTime;

    try {
        stepStartTime = performance.now();
        const fileBuffer = fs.readFileSync(pathToOriginalFile);
        const image = await Jimp.read(fileBuffer);
        timings.read = performance.now() - stepStartTime;

        const aspectRatio = (image.bitmap.height > 0) ? (image.bitmap.width / image.bitmap.height) : 1.0;
        stepStartTime = performance.now();
        const thumbImage = image.clone();

        const targetPixelArea = thumbnailResolution;
        const safeAspectRatio = aspectRatio > 0 ? aspectRatio : 1;

        let newHeight = Math.round(Math.sqrt(targetPixelArea / safeAspectRatio));
        let newWidth = Math.round(newHeight * safeAspectRatio);

        if (newWidth === 0 || newHeight === 0) {
            // Fallback for corrupted images with zero dimensions
            console.warn(`[Thumbnails] Image ${file} has zero width/height. Using fallback dimensions.`);
            const fallbackAspectRatio = 1; // Use a square aspect ratio as a safe default
            const h = Math.round(Math.sqrt(targetPixelArea / fallbackAspectRatio));
            const w = Math.round(h * fallbackAspectRatio);

            thumbImage.scaleToFit({ w, h, mode: Jimp.RESIZE_BILINEAR });
        } else {
            // Main processing path
            thumbImage.scaleToFit({ w: newWidth, h: newHeight, mode: Jimp.RESIZE_BILINEAR });
        }

        timings.resize = performance.now() - stepStartTime;

        stepStartTime = performance.now();
        const buffer = pngFormat
            ? await thumbImage.getBuffer(JimpMime.png)
            : await thumbImage.getBuffer(JimpMime.jpeg, { quality: quality, jpegColorSpace: 'ycbcr' });
        timings.buffer = performance.now() - stepStartTime;

        stepStartTime = performance.now();
        writeFileAtomicSync(pathToCachedFile, buffer);
        timings.write = performance.now() - stepStartTime;

        timings.total = performance.now() - totalStartTime;
        return { success: true, timings, aspectRatio, resolution: targetPixelArea };
    } catch (error) {
        console.warn(`[Thumbnails] Failed to process image ${file}:`, error.message);
        return { success: false, filename: file, error: error.message };
    }
}

/**
 * Ensures that all background images have corresponding thumbnails cached.
 * @param {Array<object>} directoriesList - List of user directory configurations.
 * @returns {Promise<void>}
 */
export async function ensureThumbnailCache(directoriesList) {
    for (const directories of directoriesList) {
        const allBgFiles = getImages(directories.backgrounds);
        if (allBgFiles.length === 0) continue;
        const thumbnailFolder = getThumbnailFolder(directories, 'bg');
        const originalFolder = getOriginalFolder(directories, 'bg');
        const filesToProcess = allBgFiles.filter(file => {
            if (SKIPPED_EXTENSIONS_FOR_JIMP.includes(path.extname(file).toLowerCase())) {
                return false;
            }
            const pathToCachedFile = path.join(thumbnailFolder, file);
            return !fs.existsSync(pathToCachedFile);
        });
        if (filesToProcess.length === 0) {
            continue;
        }
        console.info(`[Thumbnails] Found ${filesToProcess.length} new images. Starting processing in batches of ${CONCURRENCY_LIMIT}...`);
        const startTime = performance.now();
        const allResults = [];
        for (let i = 0; i < filesToProcess.length; i += CONCURRENCY_LIMIT) {
            const batchFiles = filesToProcess.slice(i, i + CONCURRENCY_LIMIT);
            const tasks = batchFiles.map(file => processSingleImage(file, originalFolder, thumbnailFolder));
            const batchResults = await Promise.allSettled(tasks);
            batchResults.forEach(r => {
                if (r.status === 'fulfilled') {
                    allResults.push(r.value);
                } else {
                    console.error('[Thumbnails] A promise was rejected unexpectedly:', r.reason);
                }
            });
        }
        const duration = (performance.now() - startTime) / 1000;
        const timings = allResults.filter(r => r.success).map(r => r.timings);
        const errors = allResults.filter(r => !r.success);
        if (timings.length > 0) {
            console.info(`[Thumbnails] Processed ${timings.length} new images in ${duration.toFixed(2)} seconds.`);
        }
        if (errors.length > 0) {
            console.warn(`[Thumbnails] Failed to process ${errors.length} images. Check logs above for details.`);
        }
    }
}

/**
 * API endpoint for uploading client-generated thumbnails.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
apiRouter.post('/upload-generated', async function(request, response) {
    const rawFilename = request.query.originalFilename;
    if (typeof rawFilename !== 'string') {
        console.error('[Thumbnails API] originalFilename query parameter is missing or not a string.');
        return response.sendStatus(400);
    }
    const sanitizedFilename = sanitize(rawFilename);
    if (!request.file || !sanitizedFilename) {
        console.error('[Thumbnails API] Request is missing file or originalFilename.');
        return response.sendStatus(400);
    }
    const tempPath = request.file.path;
    try {
        const thumbnailFolder = getThumbnailFolder(request.user.directories, 'bg');
        if (!thumbnailFolder) {
            throw new Error('Background thumbnail directory not found for user.');
        }
        const destinationPath = path.join(thumbnailFolder, sanitizedFilename);
        fs.renameSync(tempPath, destinationPath);
        return response.sendStatus(204);
    } catch (error) {
        console.error(`[Thumbnails API] Failed to save generated thumbnail for ${sanitizedFilename}:`, error);
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        return response.sendStatus(500);
    }
});

/**
 * Public endpoint for serving thumbnails.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
publicRouter.get('/', async function (request, response) {
    try {
        const { file: rawFile, type, animated } = request.query;
        if (typeof rawFile !== 'string' || typeof type !== 'string') return response.sendStatus(400);
        if (!(type === 'bg' || type === 'avatar' || type === 'persona')) {
            return response.sendStatus(400);
        }

        const file = sanitize(rawFile);
        if (file !== rawFile) return response.sendStatus(403);

        const serveOriginal = () => {
            const folder = getOriginalFolder(request.user.directories, type);
            const pathToOriginalFile = path.resolve(path.join(folder, file));
            if (!fs.existsSync(pathToOriginalFile)) return response.sendStatus(404);
            return response.sendFile(pathToOriginalFile);
        };

        if (!thumbnailsEnabled) {
            return serveOriginal();
        }

        const animatedEnabled = animated === 'true';
        const fileExtension = path.extname(file).toLowerCase();
        const isAnimatedFormat = SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension);

        // If the user wants the animated version and it's an animated format, serve the original file.
        if (animatedEnabled && isAnimatedFormat) {
            return serveOriginal();
        }

        const thumbnailFolder = getThumbnailFolder(request.user.directories, type);
        const pathToCachedFile = path.join(thumbnailFolder, file);

        // This is the critical new logic from the patch
        if (!fs.existsSync(pathToCachedFile)) {
            await generateThumbnail(request.user.directories, type, file, false, false);
        }

        if (fs.existsSync(pathToCachedFile)) {
            return response.sendFile(path.resolve(pathToCachedFile));
        }

        // Serve whole gif disregarding toggle
        if (fileExtension === '.gif') {
            return serveOriginal();
        }

        // Do NOT fall back to the original file. Send a 404 so the frontend can
        // display a placeholder, respecting the user's choice to not load animated files.
        return response.sendStatus(404);

    } catch (error)
    {
        console.error('Failed getting thumbnail', error);
        return response.sendStatus(500);
    }
});
