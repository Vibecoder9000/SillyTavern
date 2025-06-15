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
 * @param {object} currentAspectRatios Passed-in object to update with new aspect ratios
 * @returns
 */
async function generateThumbnail(directories, type, file, currentAspectRatios) {
    let buffer; // Ensure buffer is declared in the function scope

    // Determine the effective pngFormat for this specific call
    let localPngFormat = pngFormat; // Initialize with the global/module-level config
    if (type === 'bg') {
        console.log(`[Thumbnails] Forcing PNG format for type 'bg'. Original module configured format was: ${localPngFormat ? 'png' : 'jpg'}`);
        localPngFormat = true; // Force PNG for background thumbnails
    }

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
                // console.log(`[Thumbnails] Applying image.scaleToFit({ w: ${newWidth}, h: ${newHeight}, mode: Jimp.RESIZE_BILINEAR }) for ${file}`);
                // image.scaleToFit({ w: newWidth, h: newHeight, mode: Jimp.RESIZE_BILINEAR });
                // console.log(`[Thumbnails] Dimensions *after* scaleToFit for ${file}: ${image.bitmap.width}x${image.bitmap.height}`);
                console.log(`[Thumbnails] SKIPPING scaleToFit for diagnostic purposes for ${file}. Using original dimensions: ${image.bitmap.width}x${image.bitmap.height}`);

                // Update in-memory aspect ratios object
                console.log(`[Thumbnails] Updating in-memory aspect ratios for ${file} with AR: ${aspectRatio}`);
                currentAspectRatios[file] = aspectRatio;
                // Disk writing is handled by ensureThumbnailCache after all files are processed for bulk operations.
                // For single API calls, this means aspect ratio isn't saved to disk in this simplified step.
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
        console.log(`[Thumbnails] Generating buffer for ${file} using image.getBuffer(). PNG format: ${localPngFormat}`);
        buffer = await new Promise((resolve, reject) => {
            const actualMimeType = localPngFormat ? 'image/png' : 'image/jpeg'; // Use direct MIME type strings
            const cb = (err, buf) => {
                if (err) {
                    console.error(`[Thumbnails] Error in getBuffer callback for ${file} (MIME: ${actualMimeType}):`, err);
                    return reject(err);
                }
                console.log(`[Thumbnails] Successfully got buffer via callback for ${file} (MIME: ${actualMimeType})`);
                resolve(buf);
            };

            if (localPngFormat) {
                console.log(`[Thumbnails] Getting buffer for PNG ${file} (MIME: ${actualMimeType}) with empty options`); // Log updated
                image.getBuffer(actualMimeType, {}, cb);
            } else {
                console.log(`[Thumbnails] Getting buffer for JPEG ${file} (MIME: ${actualMimeType}) with quality: ${quality} and colorSpace: 'ycbcr'`);
                image.getBuffer(actualMimeType, { quality: quality, jpegColorSpace: 'ycbcr' }, cb);
            }
        });

        // If buffer generation is successful, write it.
        try {
            console.log(`[Thumbnails] Writing thumbnail buffer to disk: ${pathToCachedFile} for file ${file}. Buffer length: ${buffer?.length}`);
            writeFileAtomicSync(pathToCachedFile, buffer);
            console.log(`[Thumbnails] Successfully wrote thumbnail for: ${file}. Path: ${pathToCachedFile}`);
            return pathToCachedFile; // Resolve with path if write is successful
        } catch (writeError) {
            console.error(`[Thumbnails] Failed to write thumbnail to disk for ${file} at ${pathToCachedFile}: ${writeError.message}. Stack: ${writeError.stack}`);
            // Aspect ratio might have been calculated and added to in-memory object.
            // Return null to indicate this specific thumbnail file generation failed.
            return null;
        }

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
    for (const directories of directoriesList) { // Loop for each user directory set
        const bgDir = directories.backgrounds; // Cache for slightly cleaner logs
        console.log(`[Thumbnails Cache] Starting cache validation for directory: ${bgDir}`);

        const aspectFilePath = path.join(directories.root, 'aspect_ratios.json');
        let allAspectRatios = {};
        try {
            console.log(`[Thumbnails Cache] Reading ${aspectFilePath} before bulk processing for ${bgDir}.`);
            const data = await fsPromises.readFile(aspectFilePath, 'utf8');
            allAspectRatios = JSON.parse(data);
            console.log(`[Thumbnails Cache] Successfully read initial aspect ratios for ${bgDir}. Keys: ${Object.keys(allAspectRatios).length}`);
        } catch (err) {
            if (err.code === 'ENOENT') {
                console.log(`[Thumbnails Cache] ${aspectFilePath} not found for ${bgDir}. Starting with empty aspect ratios.`);
            } else {
                console.error(`[Thumbnails Cache] Error reading ${aspectFilePath} for ${bgDir}: ${err.message}. Starting with empty aspect ratios.`);
            }
            allAspectRatios = {}; // Ensure it's an object if read fails
        }

        let imageFileNames = [];
        try {
            const bgFiles = fs.readdirSync(bgDir); // Use bgDir here
            imageFileNames = bgFiles.filter(fileName => {
                try {
                    const filePath = path.join(bgDir, fileName); // Use bgDir here
                    return fs.statSync(filePath).isFile();
                } catch (statError) {
                    console.warn(`[Thumbnails Cache] Error stating file ${fileName} in ${bgDir}, skipping: ${statError.message}`);
                    return false;
                }
            });
            console.log(`[Thumbnails Cache] Found ${imageFileNames.length} actual image files to process in ${bgDir} (out of ${bgFiles.length} total entries).`);
        } catch (readDirError) {
            console.error(`[Thumbnails Cache] Error reading directory ${bgDir}: ${readDirError.message}. Skipping this directory.`);
            continue; // Skip to the next directory in directoriesList
        }

        if (imageFileNames.length === 0) {
            console.log(`[Thumbnails Cache] No image files to process in ${bgDir}.`);
        } else {
            console.log(`[Thumbnails Cache] About to process ${imageFileNames.length} image tasks sequentially for directory ${bgDir}.`);
            const results = [];
            let successfulThumbs = 0;
            let failedThumbs = 0;

            for (const file of imageFileNames) {
                console.log(`[Thumbnails Cache] Processing thumbnail for: ${file} in ${bgDir}`);
                try {
                    const result = await generateThumbnail(directories, 'bg', file, allAspectRatios);
                    results.push(result);
                    if (result !== null) {
                        successfulThumbs++;
                    } else {
                        failedThumbs++;
                    }
                    console.log(`[Thumbnails Cache] Finished processing for: ${file} in ${bgDir}. Result: ${result === null ? 'Failed (null)' : 'Success'}`);
                } catch (error) {
                    console.error(`[Thumbnails Cache] Unhandled error processing file ${file} sequentially in ${bgDir}:`, error);
                    results.push(null);
                    failedThumbs++;
                }
            } // End for loop

            console.log(`[Thumbnails Cache] Sequential processing completed for ${bgDir}.`);
            console.log(`[Thumbnails Cache] Breakdown for ${bgDir}: Successful thumbnails created: ${successfulThumbs}, Failed (null): ${failedThumbs}`);
        } // End else (imageFileNames.length > 0)

        let jsonStringToWrite;
        try {
            console.log(`[Thumbnails Cache] Attempting to JSON.stringify allAspectRatios for ${bgDir}. Object keys: ${Object.keys(allAspectRatios).length}`);
            jsonStringToWrite = JSON.stringify(allAspectRatios, null, 2);
            console.log(`[Thumbnails Cache] JSON.stringify successful for ${bgDir}. String length: ${jsonStringToWrite?.length ?? 0}`);
        } catch (stringifyError) {
            console.error(`[Thumbnails Cache] Error during JSON.stringify for ${bgDir}:`, stringifyError);
            continue;
        }

        try {
            console.log(`[Thumbnails Cache] Attempting to write all updated aspect ratios to ${aspectFilePath} for ${bgDir}`);
            await fsPromises.writeFile(aspectFilePath, jsonStringToWrite, 'utf8');
            console.log(`[Thumbnails Cache] Successfully wrote all aspect ratios to ${aspectFilePath} for ${bgDir}`);
        } catch (writeError) {
            console.error(`[Thumbnails Cache] Error writing all aspect ratios to ${aspectFilePath} for ${bgDir}:`, writeError.message);
        }

        console.log(`[Thumbnails Cache] Finished cache validation for ${bgDir}.`);
    } // End for...of directoriesList
} // End ensureThumbnailCache

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

        // For single GET, aspect ratio won't be saved to disk here to avoid complexity without locking.
        // Bulk generation via ensureThumbnailCache is prioritized for aspect ratio saving.
        const dummyAspectRatios = {};
        const pathToCachedFile = await generateThumbnail(request.user.directories, type, file, dummyAspectRatios);

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
