import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import multer from 'multer';
import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp, JimpMime } from '../jimp.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { imageSize as sizeOf } from 'image-size';
import { UPLOADS_DIRECTORY } from '../constants.js';

import { getImages, getConfigValue, getThumbnailResolution, invalidateFirefoxCache } from '../util.js';
import mime from 'mime-types';
const fsPromises = fs.promises;

export const publicRouter = express.Router();
export const apiRouter = express.Router();

const upload = multer({ dest: UPLOADS_DIRECTORY });

export const CONCURRENCY_LIMIT = 8;
export const SKIPPED_EXTENSIONS_FOR_JIMP = ['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', '.gif'];

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
 * @param {boolean} [checkOnly=false] - Whether to only check for existence without generating.
 * @param {boolean} [isKnownAnimated=false] - If true, skips generation assuming the caller knows the file is animated.
 * @returns {Promise<{path: string|null, aspectRatio: number|null, resolution: number|null}>} Path to thumbnail, its aspect ratio, and resolution.
 */
export async function generateThumbnail(directories, type, file, forceGenerate = false, checkOnly = false, isKnownAnimated = false) {
    // If the caller has already determined the file is animated, skip processing.
    if (isKnownAnimated) {
        return { path: null, aspectRatio: null, resolution: null };
    }

    const thumbnailFolder = getThumbnailFolder(directories, type);
    const originalFolder = getOriginalFolder(directories, type);
    const pathToCachedFile = path.join(thumbnailFolder, file);

    try {
        // Check if thumbnail already exists and return it if not forcing regeneration
        if (!forceGenerate && fs.existsSync(pathToCachedFile)) {
            try {
                const buffer = fs.readFileSync(pathToCachedFile);
                const dimensions = sizeOf(buffer);
                const ratio = (dimensions.height > 0) ? (dimensions.width / dimensions.height) : 1.0;
                // When a thumbnail exists, return the current resolution from config so the JSON can be updated.
                const resolution = getThumbnailResolution();
                return { path: pathToCachedFile, aspectRatio: ratio, resolution };
            } catch (e) {
                console.warn(`[Thumbnails] Could not read dimensions for ${file}. It might be corrupted.`, e);
                // If we can't read the existing thumbnail, we'll try to regenerate it
                forceGenerate = true;
            }
        }

        // If we're only checking and not forcing generation, return null
        if (checkOnly && !forceGenerate) {
            return { path: null, aspectRatio: null, resolution: null };
        }

        let pathToOriginalFile = path.join(originalFolder, file);
        if (!fs.existsSync(pathToOriginalFile)) {
            const charName = path.parse(file).name;
            const userImagePath = path.join(directories.userImages, charName, file);

            if (fs.existsSync(userImagePath)) {
                pathToOriginalFile = userImagePath;
            } else {
                console.warn(`[Thumbnails] Original file not found at ${pathToOriginalFile} or ${userImagePath}, skipping: ${file}`);
                return { path: null, aspectRatio: null, resolution: null };
            }
        }

        const fileExtension = path.extname(file).toLowerCase();

        // For WebP files, we must check if they are animated, as Jimp cannot process them.
        if (fileExtension === '.webp') {
            const buffer = fs.readFileSync(pathToOriginalFile);
            // Check for 'ANIM' or 'ANMF' chunks in the header, which indicate an animated WebP.
            const isAnimatedWebP = buffer.includes('ANIM') || buffer.includes('ANMF');
            if (isAnimatedWebP) {
                // Return null to indicate that the server cannot generate this thumbnail.
                // The client is expected to handle it.
                return { path: null, aspectRatio: null, resolution: null };
            }
        }

        // Skip processing for other formats that Jimp doesn't handle
        if (SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension)) {
            return { path: null, aspectRatio: null, resolution: null };
        }

        // Process the image to generate thumbnail
        const result = await processSingleImage(file, originalFolder, thumbnailFolder, type);
        if (result.success) {
            return { path: pathToCachedFile, aspectRatio: result.aspectRatio, resolution: result.resolution };
        } else {
            console.error(`[generateThumbnail] Failed to process image ${file}:`, result.error);
            return { path: null, aspectRatio: null, resolution: null };
        }
    } catch (error) {
        console.error(`[generateThumbnail] Unexpected error processing ${file}:`, error);
        return { path: null, aspectRatio: null, resolution: null };
    }
}

/**
 * Processes a single image to generate its thumbnail.
 * @param {string} file - The filename of the image.
 * @param {string} originalFolder - Path to the original image folder.
 * @param {string} thumbnailFolder - Path to the thumbnail output folder.
 * @param {ThumbnailType} type - The type of thumbnail to generate.
 * @returns {Promise<{success: boolean, timings?: object, filename?: string, error?: string, aspectRatio?: number, resolution?: number}>} Result of the processing.
 */
async function processSingleImage(file, originalFolder, thumbnailFolder, type) {
    const quality = Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 95, 'number'))));
    const pngFormat = String(getConfigValue('thumbnails.format', 'jpg')).toLowerCase().trim() === 'png';
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

        // Calculate aspect ratio from original image dimensions
        const originalWidth = image.bitmap.width;
        const originalHeight = image.bitmap.height;
        const aspectRatio = (originalHeight > 0) ? (originalWidth / originalHeight) : 1.0;

        stepStartTime = performance.now();
        const thumbImage = image.clone();
        let thumbnailResolution;

        if (type === 'bg') {
            const [maxWidth, maxHeight] = dimensions[type];
            thumbImage.scaleToFit({ w: maxWidth, h: maxHeight, mode: Jimp.RESIZE_BILINEAR });
            thumbnailResolution = getThumbnailResolution();
        } else if (type === 'avatar' || type === 'persona') {
            // Crop and resize to fixed dimensions
            const [width, height] = dimensions[type];
            thumbImage.cover({ w: width, h: height });
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

        return { success: true, timings, aspectRatio, resolution: thumbnailResolution };
    } catch (error) {
        console.warn(`[Thumbnails] Failed to process image ${file}:`, error);
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

        const totalFiles = filesToProcess.length;
        let processedCount = 0;
        const startTime = performance.now();

        const renderProgressBar = () => {
            process.stdout.clearLine(0);
            process.stdout.cursorTo(0);
            const percentage = Math.floor((processedCount / totalFiles) * 100);
            const progress = Math.floor((percentage / 100) * 20);
            const bar = '█'.repeat(progress) + '-'.repeat(20 - progress);
            const elapsedTime = (performance.now() - startTime) / 1000;
            const imagesPerSecond = elapsedTime > 0 ? (processedCount / elapsedTime).toFixed(1) : '...';
            const eta = elapsedTime > 0 && processedCount > 0 ? Math.round(((totalFiles - processedCount) * elapsedTime) / processedCount) : 0;
            process.stdout.write(`Thumbnailing: [${bar}] ${percentage}% | ${processedCount}/${totalFiles} | ${imagesPerSecond} img/s | ETA: ${eta}s`);
        };

        renderProgressBar();

        const allResults = [];
        for (let i = 0; i < totalFiles; i += CONCURRENCY_LIMIT) {
            const batchFiles = filesToProcess.slice(i, i + CONCURRENCY_LIMIT);
            const tasks = batchFiles.map(file => processSingleImage(file, originalFolder, thumbnailFolder, 'bg'));
            const batchResults = await Promise.allSettled(tasks);

            processedCount += batchFiles.length;
            renderProgressBar();

            batchResults.forEach(r => {
                if (r.status === 'fulfilled') {
                    allResults.push(r.value);
                } else {
                    console.error('[Thumbnails] A promise was rejected unexpectedly:', r.reason);
                }
            });
        }

        process.stdout.write('\n');
        const duration = (performance.now() - startTime) / 1000;
        const successfulCount = allResults.filter(r => r.success).length;
        const errorCount = allResults.filter(r => !r.success).length;

        if (successfulCount > 0) {
            console.info(`[Thumbnails] Processed ${successfulCount} new images in ${duration.toFixed(2)} seconds.`);
        }
        if (errorCount > 0) {
            console.warn(`[Thumbnails] Failed to process ${errorCount} images. Check logs above for details.`);
        }
    }
}

/**
 * API endpoint for uploading client-generated thumbnails.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
apiRouter.post('/upload-generated', upload.single('avatar'), async function(request, response) {
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
        const thumbnailsEnabled = !!getConfigValue('thumbnails.enabled', true, 'boolean');
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

            invalidateFirefoxCache(pathToOriginalFile, request, response);

            return response.send(originalFile);
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

        if (!fs.existsSync(pathToCachedFile)) {
            // Note: This generateThumbnail call here will only create static thumbnails for formats Jimp supports.
            // Animated formats (like .webp, .apng, .gif) will be skipped by Jimp and handled client-side if needed.
            // Generate thumbnail if it's missing. (forceGenerate: false, checkOnly: false)
            await generateThumbnail(request.user.directories, type, file, false, false);
        }

        if (fs.existsSync(pathToCachedFile)) {
            const contentType = mime.lookup(pathToCachedFile) || 'image/jpeg';
            const cachedFile = await fsPromises.readFile(pathToCachedFile);
            response.setHeader('Content-Type', contentType);

            invalidateFirefoxCache(file, request, response);

            return response.send(cachedFile);
        }

        // Serve whole gif disregarding toggle
        if (fileExtension === '.gif') {
            const folder = getOriginalFolder(request.user.directories, type);
            const pathToOriginalFile = path.join(folder, file);

            if (fs.existsSync(pathToOriginalFile)) {
                const contentType = mime.lookup(pathToOriginalFile) || 'image/png';
                const originalFile = await fsPromises.readFile(pathToOriginalFile);
                response.setHeader('Content-Type', contentType);
                invalidateFirefoxCache(file, request, response);
                return response.send(originalFile);
            }
        }

        // Do NOT fall back to the original file. Send a 404 so the frontend can
        // display a placeholder, respecting the user's choice to not load animated files.
        return response.sendStatus(404);

    } catch (error) {
        console.error('Failed getting thumbnail', error);
        return response.sendStatus(500);
    }
});
