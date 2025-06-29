import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp, JimpMime } from '../jimp.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

import { getConfigValue } from '../util.js';

export const publicRouter = express.Router();
export const apiRouter = express.Router();

const SKIPPED_EXTENSIONS_FOR_JIMP = ['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', '.webp'];

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
 * Generates a thumbnail for the given file.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {ThumbnailType} type Type of the thumbnail
 * @param {string} file Name of the file
 * @param {number|null} knownAspectRatio Optional known aspect ratio
 * @param {boolean} forceGenerate Whether to force thumbnail generation for normally skipped file types
 * @returns {Promise<{path: string, aspectRatio: number}|null>}
 */
export async function generateThumbnail(directories, type, file, knownAspectRatio = null, forceGenerate = false) {
    const fileExtension = path.extname(file).toLowerCase();

    // Skip thumbnail generation for these extensions, unless forceGenerate is true
    if (!forceGenerate && SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension)) {
        return null;
    }

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

        if (originalStat.mtimeMs <= cachedStat.mtimeMs) {
            return { path: pathToCachedFile, aspectRatio: knownAspectRatio ?? 1.0 };
        }
        shouldRegenerate = true;
    }

    // Skip thumbnail generation for these extensions, unless forceGenerate is true
    if (!forceGenerate && SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension)) {
        return null;
    }

    const thumbnailFolder = getThumbnailFolder(directories, type);
    const originalFolder = getOriginalFolder(directories, type);
    if (!thumbnailFolder || !originalFolder) {
        throw new Error('Invalid thumbnail type');
    }

    const pathToCachedFile = path.join(thumbnailFolder, file);
    const pathToOriginalFile = path.join(originalFolder, file);

    try {
        if (!fs.existsSync(pathToOriginalFile)) {
            if (fs.existsSync(pathToCachedFile)) {
                try { fs.unlinkSync(pathToCachedFile); } catch (e) { /* ignore */ }
            }
            return null;
        }

        if (fs.existsSync(pathToCachedFile)) {
            const originalStat = fs.statSync(pathToOriginalFile);
            const cachedStat = fs.statSync(pathToCachedFile);
            if (originalStat.mtimeMs <= cachedStat.mtimeMs) {
                return { path: pathToCachedFile, aspectRatio: knownAspectRatio ?? 1.0 };
            }
        }

        const image = await Jimp.read(pathToOriginalFile);
        const numericalAspectRatio = (image.bitmap.height > 0) ? (image.bitmap.width / image.bitmap.height) : 1.0;
        const thumbImage = image.clone();

        if (type === 'bg') {
            const targetPixelArea = thumbnailResolution;
            const safeAspectRatio = numericalAspectRatio > 0 ? numericalAspectRatio : 1;
            let newHeight = Math.round(Math.sqrt(targetPixelArea / safeAspectRatio));
            let newWidth = Math.round(newHeight * safeAspectRatio);

            if (newWidth === 0 || newHeight === 0) {
                const fallbackAspectRatio = 1;
                const h = Math.round(Math.sqrt(targetPixelArea / fallbackAspectRatio));
                const w = Math.round(h * fallbackAspectRatio);
                thumbImage.cover({ w, h });
            } else {
                thumbImage.scaleToFit({ w: newWidth, h: newHeight, mode: Jimp.RESIZE_BILINEAR });
            }
        } else {
            const [w, h] = dimensions[type];
            thumbImage.cover({ w: w || 96, h: h || 144 });
        }

        const buffer = pngFormat
            ? await thumbImage.getBuffer(JimpMime.png)
            : await thumbImage.getBuffer(JimpMime.jpeg, { quality: quality, jpegColorSpace: 'ycbcr' });

        writeFileAtomicSync(pathToCachedFile, buffer);
        return { path: pathToCachedFile, aspectRatio: numericalAspectRatio };

    } catch (error) {
        console.error(`[Thumbnails] Error processing ${file}:`, error);
        return null;
    }
}

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

export const router = express.Router();

apiRouter.post('/upload-generated', getFileNameValidationFunction('originalFilename'), async function(request, response) {
    if (!request.file || !request.body?.originalFilename) {
        console.error('[thumbnails/upload-generated] Request is missing file or originalFilename.');
        return response.sendStatus(400);
    }

    const sanitizedFilename = request.body.originalFilename;
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
        console.error(`[thumbnails/upload-generated] Failed to save generated thumbnail for ${sanitizedFilename}:`, error);
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        return response.sendStatus(500);
    }
});

// Important: This route must be mounted as '/thumbnail'. It is used in the client code and saved to chat files.
publicRouter.get('/', async function (request, response) {
    try {
        const { file: rawFile, type, animated } = request.query;
        if (typeof rawFile !== 'string' || typeof type !== 'string') {
            return response.sendStatus(400);
        }

        if (!(type === 'bg' || type === 'avatar' || type === 'persona')) {
            return response.sendStatus(400);
        }

        const file = sanitize(rawFile);
        if (file !== rawFile) {
            console.error('Malicious filename prevented');
            return response.sendStatus(403);
        }

        if (type !== 'bg' && type !== 'avatar') {
            return response.sendStatus(400);
        }

        const animatedEnabled = animated === 'true';
        const isWebP = file.toLowerCase().endsWith('.webp');

        const serveOriginal = async () => {
            const folder = getOriginalFolder(request.user.directories, type);
            if (!folder) return response.sendStatus(400);
            const pathToOriginalFile = path.resolve(path.join(folder, file));
            if (!fs.existsSync(pathToOriginalFile)) return response.sendStatus(404);
            return response.sendFile(pathToOriginalFile);
        };

        // If animations are enabled and this is a WebP, serve the original
        if (animatedEnabled && isWebP) {
            return await serveOriginal();
        }

        if (!thumbnailsEnabled) {
            return await serveOriginal();
        }

        // For WebP files with animations disabled, force thumbnail generation
        const forceGenerate = isWebP && !animatedEnabled;
        const thumbnailResult = await generateThumbnail(request.user.directories, type, file, null, forceGenerate);

        // If thumbnail generation failed or was skipped, serve the original file.
        // This is the correct path for animated WebP files.
        if (!thumbnailResult?.path || !fs.existsSync(thumbnailResult.path)) {
            return await serveOriginal();
        }

        // If we successfully generated a thumbnail (for .jpg, .png, etc.), serve it.
        return response.sendFile(path.resolve(thumbnailResult.path));

    } catch (error) {
        console.error('Failed getting thumbnail', error);
        return response.sendStatus(500);
    }
});
