import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';
import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp, JimpMime } from '../jimp.js';
export { sync as writeFileAtomicSync } from 'write-file-atomic';
import { sync as writeFileAtomicSyncDirect } from 'write-file-atomic';

import { getConfigValue } from '../util.js';

export const currentMetadataVersion = "1.0.0";

const SKIPPED_EXTENSIONS_FOR_JIMP = ['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', '.webp'];

const thumbnailsEnabled = !!getConfigValue('thumbnails.enabled', true, 'boolean');
const quality = Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 95, 'number'))));
const pngFormat = String(getConfigValue('thumbnails.format', 'jpg')).toLowerCase().trim() === 'png';

/** @type {Record<string, number[]>} */
export const dimensions = {
    'bg': getConfigValue('thumbnails.dimensions.bg', [160, 90]),
    'avatar': getConfigValue('thumbnails.dimensions.avatar', [96, 144]),
};

export function getThumbnailFolder(directories, type) {
    let thumbnailFolder;
    switch (type) {
        case 'bg': thumbnailFolder = directories.thumbnailsBg; break;
        case 'avatar': thumbnailFolder = directories.thumbnailsAvatar; break;
    }
    return thumbnailFolder;
}

function getOriginalFolder(directories, type) {
    let originalFolder;
    switch (type) {
        case 'bg': originalFolder = directories.backgrounds; break;
        case 'avatar': originalFolder = directories.characters; break;
    }
    return originalFolder;
}

export function invalidateThumbnail(directories, type, file) {
    const folder = getThumbnailFolder(directories, type);
    if (folder === undefined) throw new Error('Invalid thumbnail type');

    const pathToThumbnail = path.join(folder, file);
    if (fs.existsSync(pathToThumbnail)) {
        try {
            fs.unlinkSync(pathToThumbnail);
        } catch (e) {
            console.error(`[invalidateThumbnail] Failed to delete thumbnail file ${pathToThumbnail}:`, e);
        }
    }

    if (type === 'bg' && directories.root) {
        const aspectRatiosJsonPath = path.join(directories.root, 'aspect_ratios.json');
        try {
            if (fs.existsSync(aspectRatiosJsonPath)) {
                let aspectRatios = JSON.parse(fs.readFileSync(aspectRatiosJsonPath, 'utf-8'));
                if (aspectRatios.hasOwnProperty(file)) {
                    delete aspectRatios[file];
                    aspectRatios._metadata_version = currentMetadataVersion;
                    writeFileAtomicSyncDirect(aspectRatiosJsonPath, JSON.stringify(aspectRatios, null, 2));
                }
            }
        } catch (e) {
            console.error(`[invalidateThumbnail] Failed to update aspect_ratios.json for deleted file ${file}:`, e);
        }
    }
}

/**
 * Generates a thumbnail for the given file.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {'bg' | 'avatar'} type Type of the thumbnail
 * @param {string} file Name of the file
 * @returns
 */
export async function generateThumbnail(directories, type, file) {
    const fileExtension = path.extname(file).toLowerCase();
    if (SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension)) {
        return null;
    }

    let thumbnailFolder = getThumbnailFolder(directories, type);
    let originalFolder = getOriginalFolder(directories, type);
    if (thumbnailFolder === undefined || originalFolder === undefined) {
        throw new Error('Invalid thumbnail type');
    }

    const pathToCachedFile = path.join(thumbnailFolder, file);
    const pathToOriginalFile = path.join(originalFolder, file);

    const cachedFileExists = fs.existsSync(pathToCachedFile);
    const originalFileExists = fs.existsSync(pathToOriginalFile);
    let shouldRegenerate = false;

    if (!originalFileExists) {
        if (cachedFileExists) {
            try {
                fs.unlinkSync(pathToCachedFile);
                console.warn(`[Thumbnails] Removed stale thumbnail for deleted original: ${file}`);
            } catch (e) {
                console.error(`[Thumbnails] Error removing stale thumbnail ${pathToCachedFile}: ${e.message}`);
            }
        }
        return null;
    }

    if (cachedFileExists) {
        const originalStat = fs.statSync(pathToOriginalFile);
        const cachedStat = fs.statSync(pathToCachedFile);
        if (originalStat.mtimeMs > cachedStat.mtimeMs) {
            shouldRegenerate = true;
        }
    }

    try {
        if (cachedFileExists && !shouldRegenerate) {
            let numericalAspectRatio = 1.0;
            try {
                const imageForAspectRatio = await Jimp.read(pathToOriginalFile);
                if (imageForAspectRatio.bitmap.height === 0) {
                    console.warn(`[Thumbnails] Image ${file} has zero height (cached case). Defaulting AR to 1.0.`);
                    numericalAspectRatio = 1.0;
                } else {
                    numericalAspectRatio = imageForAspectRatio.bitmap.width / imageForAspectRatio.bitmap.height;
                }
            } catch (e) {
                console.warn(`[Thumbnails] Jimp could not read ${file} for AR (cached case): ${e.message}. Defaulting AR to 1.0.`);
            }
            return { path: pathToCachedFile, aspectRatio: numericalAspectRatio };
        }

        const image = await Jimp.read(pathToOriginalFile);

        let numericalAspectRatio = 1.0;
        if (image.bitmap.height === 0) {
            console.warn(`[Thumbnails] Image ${file} has zero height (main process). Defaulting AR to 1.0.`);
        } else {
            numericalAspectRatio = image.bitmap.width / image.bitmap.height;
        }

        let buffer;
        const thumbImage = image.clone();

        if (type === 'bg') {
            const targetPixelArea = 12500;
            let newHeight = Math.round(Math.sqrt(targetPixelArea / (numericalAspectRatio === 0 ? 1 : numericalAspectRatio)));
            let newWidth = Math.round(newHeight * numericalAspectRatio);

            if (newWidth === 0 || newHeight === 0) {
                console.warn(`[Thumbnails] Calculated new dimensions for ${file} are zero. Using fallback cover.`);
                const fallbackSize = dimensions[type];
                newWidth = !isNaN(fallbackSize?.[0]) && fallbackSize?.[0] > 0 ? fallbackSize[0] : image.bitmap.width;
                newHeight = !isNaN(fallbackSize?.[1]) && fallbackSize?.[1] > 0 ? fallbackSize[1] : image.bitmap.height;
                if (newWidth === 0) newWidth = 160;
                if (newHeight === 0) newHeight = 90;
                thumbImage.cover({ w: newWidth, h: newHeight });
            } else {
                thumbImage.scaleToFit({ w: newWidth, h: newHeight, mode: Jimp.RESIZE_BILINEAR });
            }
        } else {
            const size = dimensions[type];
            const width = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
            const height = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
            thumbImage.cover({ w: width, h: height });
        }
        
        if (pngFormat) {
            buffer = await thumbImage.getBuffer(JimpMime.png);
        } else {
            buffer = await thumbImage.getBuffer(JimpMime.jpeg, { quality: quality, jpegColorSpace: 'ycbcr' });
        }
        
        writeFileAtomicSyncDirect(pathToCachedFile, buffer);
        return { path: pathToCachedFile, aspectRatio: numericalAspectRatio };

    } catch (error) {
        console.error(`[Thumbnails] CRITICAL ERROR processing ${file}:`, error);
        if (shouldRegenerate && cachedFileExists) {
            try {
                fs.unlinkSync(pathToCachedFile);
                console.warn(`[Thumbnails] Removed potentially outdated/corrupt thumbnail for ${file} due to regeneration failure.`);
            } catch (e) {
                console.error(`[Thumbnails] Error removing thumbnail for ${file} after regeneration failure: ${e.message}`);
            }
        }
        return null; 
    }
}

export async function ensureThumbnailCache(directoriesList) {
    for (const directories of directoriesList) {
        if (!directories.backgrounds || !directories.thumbnailsBg || !directories.root) {
            continue;
        }
        if (!fs.existsSync(directories.backgrounds)) {
            continue;
        }
        if (!fs.existsSync(directories.thumbnailsBg)) {
            fs.mkdirSync(directories.thumbnailsBg, { recursive: true });
        }

        const aspectRatiosJsonPath = path.join(directories.root, 'aspect_ratios.json');
        let existingAspectRatios = {};
        let needsFullRegeneration = false;

        if (fs.existsSync(aspectRatiosJsonPath)) {
            try {
                const jsonData = JSON.parse(fs.readFileSync(aspectRatiosJsonPath, 'utf-8'));
                if (jsonData._metadata_version !== currentMetadataVersion) {
                    needsFullRegeneration = true;
                } else {
                    delete jsonData._metadata_version;
                    existingAspectRatios = jsonData;
                }
            } catch (e) {
                console.warn(`[ensureThumbnailCache] Could not parse aspect_ratios.json, triggering full regeneration.`);
                needsFullRegeneration = true;
            }
        } else {
            needsFullRegeneration = true;
        }
        
        if (needsFullRegeneration) {
            existingAspectRatios = {};
            if (fs.existsSync(aspectRatiosJsonPath)) fs.unlinkSync(aspectRatiosJsonPath);
            fs.readdirSync(directories.thumbnailsBg).forEach(file => {
                if (path.extname(file)) fs.unlinkSync(path.join(directories.thumbnailsBg, file));
            });
        }

        const PLAUSIBLE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.apng', '.tiff'];
        const bgFiles = fs.readdirSync(directories.backgrounds).filter(file => {
            try {
                return fs.statSync(path.join(directories.backgrounds, file)).isFile() &&
                       PLAUSIBLE_IMAGE_EXTENSIONS.includes(path.extname(file).toLowerCase());
            } catch {
                return false;
            }
        });

        const bgFileSet = new Set(bgFiles);
        let currentAspectRatios = { ...existingAspectRatios };
        let madeChangesToJSON = needsFullRegeneration;
        const tasks = [];

        for (const file of bgFiles) {
            const pathToOriginalFile = path.join(directories.backgrounds, file);
            const pathToCachedFile = path.join(directories.thumbnailsBg, file);
            let fileNeedsProcessing = false;

            if (!existingAspectRatios.hasOwnProperty(file) || !fs.existsSync(pathToCachedFile)) {
                fileNeedsProcessing = true;
            } else {
                const originalStat = fs.statSync(pathToOriginalFile);
                const cachedStat = fs.statSync(pathToCachedFile);
                if (originalStat.mtimeMs > cachedStat.mtimeMs) {
                    fileNeedsProcessing = true;
                }
            }

            if (fileNeedsProcessing) {
                // Pass the known aspect ratio if we have it, to optimize generation
                const knownAR = existingAspectRatios[file] || null;
                tasks.push(
                    generateThumbnail(directories, 'bg', file, knownAR).then(result => {
                        if (result?.aspectRatio !== undefined) {
                            if (currentAspectRatios[file] !== result.aspectRatio) {
                                madeChangesToJSON = true;
                            }
                            currentAspectRatios[file] = result.aspectRatio;
                        } else if (currentAspectRatios.hasOwnProperty(file)) {
                            delete currentAspectRatios[file];
                            madeChangesToJSON = true;
                        }
                    })
                );
            }
        }

        await Promise.all(tasks);

        for (const existingFile in currentAspectRatios) {
            if (!bgFileSet.has(existingFile)) {
                delete currentAspectRatios[existingFile];
                madeChangesToJSON = true;
                const pathToStaleThumbnail = path.join(directories.thumbnailsBg, existingFile);
                if (fs.existsSync(pathToStaleThumbnail)) {
                    try { fs.unlinkSync(pathToStaleThumbnail); } catch (e) { console.warn(`Could not delete stale thumbnail ${pathToStaleThumbnail}: ${e.message}`); }
                }
            }
        }

        if (madeChangesToJSON) {
            try {
                currentAspectRatios._metadata_version = currentMetadataVersion;
                writeFileAtomicSyncDirect(aspectRatiosJsonPath, JSON.stringify(currentAspectRatios, null, 2));
            } catch (e) {
                console.error(`[ensureThumbnailCache] Failed to write aspect_ratios.json: ${e.message}`);
            }
        }
    }
}

export const router = express.Router();

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
            const pathToOriginalFile = path.join(folder, file);
            if (!fs.existsSync(pathToOriginalFile)) return response.sendStatus(404);
            const contentType = mime.lookup(pathToOriginalFile) || 'image/png';
            const originalFile = await fsPromises.readFile(pathToOriginalFile);
            response.setHeader('Content-Type', contentType);
            return response.send(originalFile);
        };

        if (!thumbnailsEnabled) {
            return await serveOriginal();
        }

        const thumbnailResult = await generateThumbnail(request.user.directories, type, file);
        if (!thumbnailResult?.path || !fs.existsSync(thumbnailResult.path)) {
            // Fallback to original if thumbnail generation fails or file not found
            console.warn(`Thumbnail for ${file} not found or failed, serving original.`);
            return await serveOriginal();
        }

        const contentType = mime.lookup(thumbnailResult.path) || 'image/jpeg';
        const cachedFile = await fsPromises.readFile(thumbnailResult.path);
        response.setHeader('Content-Type', contentType);
        return response.send(cachedFile);

    } catch (error) {
        console.error('Failed getting thumbnail', error);
        return response.sendStatus(500);
    }
});
