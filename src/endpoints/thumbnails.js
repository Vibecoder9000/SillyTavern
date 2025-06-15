import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';
import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp } from '../jimp.js';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue } from '../util.js';

const thumbnailsEnabled = !!getConfigValue('thumbnails.enabled', true, 'boolean');
const quality = Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 95, 'number'))));
const pngFormat = String(getConfigValue('thumbnails.format', 'jpg')).toLowerCase().trim() === 'png';

/** @type {Record<string, number[]>} */
export const dimensions = {
    'bg': getConfigValue('thumbnails.dimensions.bg', [160, 90]),
    'avatar': getConfigValue('thumbnails.dimensions.avatar', [96, 144]),
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
        fs.unlinkSync(pathToThumbnail);
    }
}

/**
 * Generates a thumbnail for the given file.
 * @param {import('../users.js').UserDirectoryList} directories User directories
 * @param {'bg' | 'avatar'} type Type of the thumbnail
 * @param {string} file Name of the file
 * @param {object} currentAspectRatiosObject Aspect ratios object to update
 * @returns
 */
async function generateThumbnail(directories, type, file, currentAspectRatiosObject) {
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
            const image = await Jimp.read(pathToOriginalFile);
            const originalWidth = image.bitmap.width;
            const originalHeight = image.bitmap.height;
            const aspectRatio = originalWidth / originalHeight;

            if (type === 'bg' && currentAspectRatiosObject && file) {
                currentAspectRatiosObject[file] = aspectRatio;
            }

            if (type === 'bg') {
                const targetPixelArea = 12500;
                let newHeight = Math.round(Math.sqrt(targetPixelArea / aspectRatio));
                let newWidth = Math.round(newHeight * aspectRatio);

                if (newWidth === 0 || newHeight === 0) {
                    throw new Error('Calculated new dimensions are zero.');
                }
                image.scaleToFit({ w: newWidth, h: newHeight, mode: Jimp.RESIZE_BILINEAR });
            } else {
                const size = dimensions[type];
                const width = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
                const height = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
                image.cover({ w: width, h: height });
            }

            if (pngFormat) {
                buffer = await new Promise((resolve, reject) => {
                    image.getBuffer('image/png', {}, (err, buf) => {
                        if (err) {
                            console.error('Error getting PNG buffer:', err);
                            return reject(err);
                        }
                        resolve(buf);
                    });
                });
            } else {
                buffer = await new Promise((resolve, reject) => {
                    image.getBuffer('image/jpeg', { quality: quality, jpegColorSpace: 'ycbcr' }, (err, buf) => {
                        if (err) {
                            console.error('Error getting JPEG buffer:', err);
                            return reject(err);
                        }
                        resolve(buf);
                    });
                });
            }
        }
        catch (inner) {
            console.warn(`Thumbnailer cannot process the image: ${pathToOriginalFile}. Error: ${inner.message}`, inner);
            return null;
        }

        writeFileAtomicSync(pathToCachedFile, buffer);
    }
    catch (outer) {
        console.error(`Error in generateThumbnail for ${file}: ${outer.message}`, outer);
        return null;
    }

    return pathToCachedFile;
}

/**
 * Ensures that the thumbnail cache for backgrounds is valid.
 * @param {import('../users.js').UserDirectoryList[]} directoriesList User directories
 * @returns {Promise<void>} Promise that resolves when the cache is validated
 */
export async function ensureThumbnailCache(directoriesList) {
    for (const directories of directoriesList) {
        if (!directories.root) {
            console.warn('User root directory not defined. Skipping aspect ratio processing for this directory set.'); /* This case should ideally not happen if directories are constructed correctly */
            // Continue to generate thumbnails but without aspect ratio saving for this iteration
        }
        const aspectFilePath = directories.root ? path.join(directories.root, 'aspect_ratios.json') : null;
        let aspectRatios = {};

        if (aspectFilePath) {
            try {
                if (fs.existsSync(aspectFilePath)) {
                    const fileContent = await fsPromises.readFile(aspectFilePath, 'utf8');
                    aspectRatios = JSON.parse(fileContent);
                }
            } catch (err) {
                console.warn(`Error reading or parsing aspect_ratios.json for directory: ${directories.root}. Starting with an empty object.`, err);
                aspectRatios = {};
            }
        }

        const cacheFiles = fs.readdirSync(directories.thumbnailsBg);

        // Only generate if cache is empty. Aspect ratios will be updated if files exist and are processed.
        // The original logic was to skip if cacheFiles.length > 0.
        // We might want to re-evaluate if we should always process bgFiles to update aspect ratios,
        // but for now, let's stick to only populating an empty cache, while also saving aspect ratios.
        if (cacheFiles.length > 0) {
            // If cache is not empty, we could still iterate through bgFiles to update aspectRatios
            // and save them, without regenerating thumbnails unless necessary.
            // For now, let's keep it simple: if cache exists, assume aspect ratios are also fine
            // or will be updated on next empty cache generation.
            // This part might need further refinement based on desired behavior for existing caches.
            console.info(`Thumbnail cache for ${directories.thumbnailsBg} is not empty. Skipping initial generation. Aspect ratios will not be updated unless cache is cleared.`);
            continue;
        }

        console.info(`Generating thumbnails cache for ${directories.thumbnailsBg}. Please wait...`);

        const bgFiles = fs.readdirSync(directories.backgrounds);
        let generatedCount = 0;

        for (const file of bgFiles) {
            const filePath = path.join(directories.backgrounds, file);
            if (!fs.statSync(filePath).isFile()) {
                console.warn(`Skipping thumbnail generation for ${filePath} as it is a directory.`);
                continue; // Skip to the next item
            }
            try {
                const thumbnailPath = await generateThumbnail(directories, 'bg', file, aspectRatios);
                if (thumbnailPath) generatedCount++;
            } catch (err) {
                console.error(`Error generating thumbnail for ${file} in ensureThumbnailCache: ${err.message}`, err);
            }
        }

        if (aspectFilePath) {
            try {
                writeFileAtomicSync(aspectFilePath, JSON.stringify(aspectRatios, null, 2));
            } catch (err) {
                console.error(`Error writing aspect_ratios.json for directory: ${directories.root}.`, err);
            }
        }
        console.info(`Done! Processed: ${bgFiles.length} files, Generated/Updated: ${generatedCount} preview images for ${directories.thumbnailsBg}`);
    }
}

export const router = express.Router();

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

        // For the endpoint, we don't need to update an aspect ratio object globally,
        // so we pass an empty object.
        const pathToCachedFile = await generateThumbnail(request.user.directories, type, file, {});

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
