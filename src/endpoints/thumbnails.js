import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';
import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp, JimpMime } from '../jimp.js';
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
 * @returns
 */
async function generateThumbnail(directories, type, file) {
    let buffer; // Ensure buffer is declared in the function scope
    let thumbnailFolder = getThumbnailFolder(directories, type);
    let originalFolder = getOriginalFolder(directories, type);
    if (thumbnailFolder === undefined || originalFolder === undefined) {
        console.error(`[Thumbnails] Invalid type or directories for file: ${file}. Type: ${type}`);
        throw new Error('Invalid thumbnail type');
    }
    const pathToCachedFile = path.join(thumbnailFolder, file);
    const pathToOriginalFile = path.join(originalFolder, file);

    console.log(`[Thumbnails] Attempting to generate thumbnail for: ${file}, Type: ${type}`);

    const cachedFileExists = fs.existsSync(pathToCachedFile);
    const originalFileExists = fs.existsSync(pathToOriginalFile);

    let shouldRegenerate = false;
    if (cachedFileExists && originalFileExists) {
        const originalStat = fs.statSync(pathToOriginalFile);
        const cachedStat = fs.statSync(pathToCachedFile);
        if (originalStat.mtimeMs > cachedStat.ctimeMs) {
            console.log(`[Thumbnails] Original file ${file} changed. Regenerating thumbnail...`);
            shouldRegenerate = true;
        }
    }

    if (cachedFileExists && !shouldRegenerate) {
        console.log(`[Thumbnails] Using cached thumbnail for: ${file}`);
        return pathToCachedFile;
    }

    if (!originalFileExists) {
        console.warn(`[Thumbnails] Original file not found for: ${file} at ${pathToOriginalFile}`);
        return null;
    }

    try {
        let buffer;
        const image = await Jimp.read(pathToOriginalFile);
        console.log(`[Thumbnails] Successfully read original file: ${file} with Jimp.`);

        if (type === 'bg') {
            let aspectRatio;
            let newWidth;
            let newHeight;
            let aspectCalculationSuccess = false;

            console.log(`[Thumbnails] Processing type 'bg' for file: ${file}`);

            try {
                const originalWidth = image.bitmap.width;
                const originalHeight = image.bitmap.height;
                console.log(`[Thumbnails] Original dimensions for ${file}: ${originalWidth}x${originalHeight}`);

                if (originalHeight > 0 && originalWidth > 0) {
                    aspectRatio = originalWidth / originalHeight;
                    const targetPixelArea = 12500;
                    newHeight = Math.round(Math.sqrt(targetPixelArea / aspectRatio));
                    newWidth = Math.round(newHeight * aspectRatio);
                    console.log(`[Thumbnails] Calculated for ${file}: AR=${aspectRatio}, NewDims=${newWidth}x${newHeight}`);

                    if (newWidth > 0 && newHeight > 0) {
                        aspectCalculationSuccess = true;
                        console.log(`[Thumbnails] Aspect calculation SUCCESS for ${file}`);
                    } else {
                        console.warn(`[Thumbnails] Invalid new dimensions calculated for ${file}: ${newWidth}x${newHeight}. Will use fallback.`);
                    }
                } else {
                    console.warn(`[Thumbnails] Invalid original dimensions for ${file}: ${originalWidth}x${originalHeight}. Will use fallback.`);
                }
            } catch (e) {
                console.warn(`[Thumbnails] Error calculating aspect ratio or new dimensions for ${file}: ${e.message}. Will use fallback.`);
            }

            if (aspectCalculationSuccess) {
                console.log(`[Thumbnails] Applying image.scaleToFit(${newWidth}, ${newHeight}) for ${file}`);
                image.scaleToFit(newWidth, newHeight, Jimp.RESIZE_BILINEAR);

                console.log(`[Thumbnails] Attempting to save aspect ratio for ${file}`);
                const aspectFilePath = path.join(directories.root, 'aspect_ratios.json');
                let ratios = {};
                try {
                    console.log(`[Thumbnails] Reading ${aspectFilePath} for ${file}`);
                    const data = await fsPromises.readFile(aspectFilePath, 'utf8');
                    ratios = JSON.parse(data);
                    console.log(`[Thumbnails] Successfully read and parsed ${aspectFilePath} for ${file}`);
                } catch (err) {
                    if (err.code === 'ENOENT') {
                        console.log(`[Thumbnails] ${aspectFilePath} not found for ${file}, creating new one.`);
                    } else {
                        console.error(`[Thumbnails] Error reading ${aspectFilePath} for ${file}: ${err.message}. Starting with empty ratios.`);
                    }
                }
                console.log(`[Thumbnails] Old ratios for ${file}:`, ratios);
                ratios[file] = aspectRatio;
                console.log(`[Thumbnails] New ratios for ${file}:`, ratios);
                try {
                    await fsPromises.writeFile(aspectFilePath, JSON.stringify(ratios, null, 2), 'utf8');
                    console.log(`[Thumbnails] Successfully wrote aspect ratio for ${file} to ${aspectFilePath}`);
                } catch (err) {
                    console.error(`[Thumbnails] Error writing aspect ratio for ${file} to ${aspectFilePath}: ${err.message}`);
                }
            } else {
                console.warn(`[Thumbnails] Using fallback 'cover' method for ${file}`);
                const size = dimensions[type]; // e.g., [160, 90]
                const fallbackWidth = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
                const fallbackHeight = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
                image.cover({ w: fallbackWidth, h: fallbackHeight });
            }
        } else if (type === 'avatar') {
            console.log(`[Thumbnails] Processing type 'avatar' for ${file}`);
            const size = dimensions[type];
            const width = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
            const height = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
            image.cover({ w: width, h: height });
        }

        // Generate buffer only if image processing up to this point was successful
        console.log(`[Thumbnails] Generating buffer for ${file}. PNG format: ${pngFormat}`);
        buffer = pngFormat
            ? await image.getBufferAsync(JimpMime.png)
            : await image.getBufferAsync(JimpMime.jpeg, { quality: quality });

        // If buffer generation is successful, write it.
        console.log(`[Thumbnails] Writing thumbnail to disk: ${pathToCachedFile}`);
        writeFileAtomicSync(pathToCachedFile, buffer);
        console.log(`[Thumbnails] Finished generating thumbnail for: ${file}. Path: ${pathToCachedFile}`);
        return pathToCachedFile;

    } catch (processingError) {
        console.error(`[Thumbnails] Critical error processing image ${file} with Jimp: ${processingError.message}. Stack: ${processingError.stack}`);
        // Fallback to original file if Jimp processing fails
        try {
            console.warn(`[Thumbnails] Using original file as fallback for ${file} due to Jimp error.`);
            const originalFileBuffer = await fsPromises.readFile(pathToOriginalFile); // read original into a new variable
            writeFileAtomicSync(pathToCachedFile, originalFileBuffer); // save original as thumbnail
            console.log(`[Thumbnails] Successfully used original file as fallback thumbnail for ${file}.`);
            return pathToCachedFile; // Return path to this "original as thumbnail"
        } catch (originalFileError) {
            console.error(`[Thumbnails] Failed to even use original file as fallback for ${file}: ${originalFileError.message}`);
            return null; // Cannot proceed
        }
    }
    // Removed redundant return pathToCachedFile here as returns are handled in try/catch blocks
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
