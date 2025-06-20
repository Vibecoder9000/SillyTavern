import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp, JimpMime } from '../jimp.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import { ASPECT_RATIOS_FILENAME } from '../constants.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

import { getConfigValue } from '../util.js';

export const currentMetadataVersion = '1.0.0';

const SKIPPED_EXTENSIONS_FOR_JIMP = ['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', 'webp'];

const thumbnailsEnabled = !!getConfigValue('thumbnails.enabled', true, 'boolean');
const quality = Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 95, 'number'))));
const pngFormat = String(getConfigValue('thumbnails.format', 'jpg')).toLowerCase().trim() === 'png';

/** @type {Record<string, number[]>} */
export const dimensions = {
    bg: getConfigValue('thumbnails.dimensions.bg', [160, 90]),
    avatar: getConfigValue('thumbnails.dimensions.avatar', [96, 144]),
};

/**
 * Gets a path to thumbnail folder based on the type.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {'bg' | 'avatar'} type Thumbnail type
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
    }

    return thumbnailFolder;
}

/**
 * Gets a path to the original images folder based on the type.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {'bg' | 'avatar'} type Thumbnail type
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
    }

    return originalFolder;
}

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
        try { fs.unlinkSync(pathToThumbnail); } catch (e) { console.error(`[invalidateThumbnail] Failed to delete thumbnail file ${pathToThumbnail}:`, e); }
    }

    if (type === 'bg' && directories.root) {
        const aspectRatiosJsonPath = path.join(directories.root, ASPECT_RATIOS_FILENAME);
        try {
            if (fs.existsSync(aspectRatiosJsonPath)) {
                const aspectRatios = JSON.parse(fs.readFileSync(aspectRatiosJsonPath, 'utf-8'));
                if (Object.prototype.hasOwnProperty.call(aspectRatios, file)) {
                    delete aspectRatios[file];
                    aspectRatios._metadata_version = currentMetadataVersion;
                    writeFileAtomicSync(aspectRatiosJsonPath, JSON.stringify(aspectRatios, null, 2));
                }
            }
        } catch (e) {
            console.error(`[invalidateThumbnail] Failed to update aspect_ratios.json for deleted file ${file}:`, e);
        }
    }
}

export async function generateThumbnail(directories, type, file, knownAspectRatio = null) {
    if (SKIPPED_EXTENSIONS_FOR_JIMP.includes(path.extname(file).toLowerCase())) {
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
            const targetPixelArea = 25000;
            const safeAspectRatio = numericalAspectRatio > 0 ? numericalAspectRatio : 1;
            let newHeight = Math.round(Math.sqrt(targetPixelArea / safeAspectRatio));
            let newWidth = Math.round(newHeight * safeAspectRatio);

            if (newWidth === 0 || newHeight === 0) {
                const [w, h] = dimensions[type];
                thumbImage.cover({ w: w || 160, h: h || 90 });
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

router.post('/upload-generated', getFileNameValidationFunction('originalFilename'), async function(request, response) {
    // The global multer instance has already processed the file and put it in request.file.
    // The multerMonkeyPatch has already fixed the filename.
    if (!request.file || !request.body?.originalFilename) {
        console.error('[thumbnails/upload-generated] Request is missing file or originalFilename.');
        return response.sendStatus(400);
    }

    const sanitizedFilename = request.body.originalFilename;
    const tempPath = request.file.path;	// Store temp path before rename

    try {
        const thumbnailFolder = getThumbnailFolder(request.user.directories, 'bg');
        if (!thumbnailFolder) {
            throw new Error('Background thumbnail directory not found for user.');
        }

        const destinationPath = path.join(thumbnailFolder, sanitizedFilename);

        // Move the temporary file from the generic 'uploads' folder to the permanent thumbnail cache.
        fs.renameSync(tempPath, destinationPath);

        // After saving the file, calculate its aspect ratio and update server records.
        try {
            if (request.user.directories.root) {
                const image = await Jimp.read(destinationPath);
                const aspectRatio = (image.bitmap.height > 0) ? (image.bitmap.width / image.bitmap.height) : 1.0;

                const aspectRatiosJsonPath = path.join(request.user.directories.root, ASPECT_RATIOS_FILENAME);
                let aspectRatiosData = {};

                if (fs.existsSync(aspectRatiosJsonPath)) {
                    aspectRatiosData = JSON.parse(fs.readFileSync(aspectRatiosJsonPath, 'utf-8'));
                }

                aspectRatiosData[sanitizedFilename] = aspectRatio;
                aspectRatiosData._metadata_version = currentMetadataVersion; // Use variable from file scope

                writeFileAtomicSync(aspectRatiosJsonPath, JSON.stringify(aspectRatiosData, null, 2));
            }
        } catch (err) {
            // Log the error, but don't fail the entire request, as the thumbnail was still saved.
            console.error(`[thumbnails/upload-generated] Failed to update aspect ratio for ${sanitizedFilename}:`, err);
        }

        // Send a "No Content" response to indicate success without needing a body.
        return response.sendStatus(204);
    } catch (error) {
        console.error(`[thumbnails/upload-generated] Failed to save generated thumbnail for ${sanitizedFilename}:`, error);
        // If an error occurs, ensure the temporary file is cleaned up.
        if (fs.existsSync(tempPath)) {
            fs.unlinkSync(tempPath);
        }
        return response.sendStatus(500);
    }
});

// Important: This route must be mounted as '/thumbnail'. It is used in the client code and saved to chat files.
router.get('/', async function (request, response) {
    try {
        const { file: rawFile, type } = request.query;
        if (typeof rawFile !== 'string' || typeof type !== 'string') {
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

        const serveOriginal = async () => {
            const folder = getOriginalFolder(request.user.directories, type);
            if (!folder) return response.sendStatus(400);
            const pathToOriginalFile = path.resolve(path.join(folder, file));
            if (!fs.existsSync(pathToOriginalFile)) return response.sendStatus(404);
            return response.sendFile(pathToOriginalFile);
        };

        if (!thumbnailsEnabled) {
            return await serveOriginal();
        }

        // Attempt to generate a thumbnail.
        // This will return null for skipped types like .webp, triggering the fallback.
        const thumbnailResult = await generateThumbnail(request.user.directories, type, file);

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
