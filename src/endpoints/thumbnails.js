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

            if (type === 'bg') {
                let aspectRatio;
                let newWidth;
                let newHeight;
                let aspectCalculationSuccess = false;

                try {
                    const originalWidth = image.bitmap.width;
                    const originalHeight = image.bitmap.height;

                    if (originalHeight > 0 && originalWidth > 0) {
                        aspectRatio = originalWidth / originalHeight;
                        const targetPixelArea = 12500;

                        // Corrected calculation:
                        newHeight = Math.round(Math.sqrt(targetPixelArea / aspectRatio));
                        newWidth = Math.round(newHeight * aspectRatio);

                        newWidth = Math.max(1, newWidth); // Ensure dimensions are at least 1
                        newHeight = Math.max(1, newHeight);

                        if (newWidth > 0 && newHeight > 0) {
                            aspectCalculationSuccess = true;
                        } else {
                            console.warn(`Invalid new dimensions calculated for ${file}: ${newWidth}x${newHeight}. Falling back.`);
                        }
                    } else {
                        console.warn(`Invalid original dimensions for ${file}: ${originalWidth}x${originalHeight}. Falling back.`);
                    }
                } catch (e) {
                    console.warn(`Error calculating aspect ratio or new dimensions for ${file}:`, e);
                    // aspectCalculationSuccess remains false
                }

                if (aspectCalculationSuccess) {
                    image.resize(newWidth, newHeight); // Apply new resize
                    console.log(`Resized ${file} to ${newWidth}x${newHeight} using aspect ratio ${aspectRatio}`);
                    // Save aspect ratio to JSON
                    try {
                        const aspectFilePath = path.join(directories.root, 'aspect_ratios.json');
                        let ratios = {};
                        try {
                            const data = await fsPromises.readFile(aspectFilePath, 'utf8');
                            ratios = JSON.parse(data);
                        } catch (err) {
                            if (err.code !== 'ENOENT') {
                                console.error('Error reading aspect_ratios.json:', err);
                            } else {
                                console.log('aspect_ratios.json not found, creating new one for user:', directories.root);
                            }
                        }
                        ratios[file] = aspectRatio;
                        await fsPromises.writeFile(aspectFilePath, JSON.stringify(ratios, null, 2), 'utf8');
                        console.log(`Saved aspect ratio for ${file}: ${aspectRatio} to ${aspectFilePath}`);
                    } catch (err) {
                        console.error('Error writing aspect_ratios.json:', err);
                    }
                } else {
                    // Fallback to old cover method for 'bg' if new method failed
                    const size = dimensions[type]; // [160, 90]
                    const fallbackWidth = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
                    const fallbackHeight = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
                    image.cover({ w: fallbackWidth, h: fallbackHeight });
                    console.log(`Used fallback cover method for ${file} to ${fallbackWidth}x${fallbackHeight}`);
                }
            } else if (type === 'avatar') { // Existing avatar logic
                const size = dimensions[type];
                const width = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
                const height = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
                image.cover({ w: width, h: height });
                console.log(`Processed avatar ${file} with cover method to ${width}x${height}`);
            }

            buffer = pngFormat
                ? await image.getBuffer(JimpMime.png)
                : await image.getBuffer(JimpMime.jpeg, { quality: quality, jpegColorSpace: 'ycbcr' });
        }
        catch (inner) { // This is the catch for Jimp.read or image processing issues
            console.warn(`Thumbnailer cannot process the image: ${pathToOriginalFile}. Using original size`, inner);
            buffer = fs.readFileSync(pathToOriginalFile);
        }

        writeFileAtomicSync(pathToCachedFile, buffer);
    }
    catch (outer) {
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
