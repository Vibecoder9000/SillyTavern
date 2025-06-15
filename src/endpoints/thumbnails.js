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
    console.log(`[Thumbnails] Invalidating thumbnail for file: ${file}, Type: ${type}`);
    const folder = getThumbnailFolder(directories, type);
    if (folder === undefined) {
        console.error(`[Thumbnails Invalidate] Invalid thumbnail type: ${type} for file: ${file}`);
        throw new Error('Invalid thumbnail type');
    }

    const pathToThumbnail = path.join(folder, file);

    if (fs.existsSync(pathToThumbnail)) {
        try {
            fs.unlinkSync(pathToThumbnail);
            console.log(`[Thumbnails Invalidate] Deleted thumbnail file: ${pathToThumbnail}`);
        } catch (unlinkErr) {
            console.error(`[Thumbnails Invalidate] Error deleting thumbnail file ${pathToThumbnail}:`, unlinkErr);
        }
    } else {
        console.log(`[Thumbnails Invalidate] Thumbnail file not found, no need to delete: ${pathToThumbnail}`);
    }

    // Additionally, remove the aspect ratio entry if it's a background image
    if (type === 'bg') {
        const aspectFilePath = path.join(directories.root, 'aspect_ratios.json');
        try {
            if (fs.existsSync(aspectFilePath)) {
                console.log(`[Thumbnails Invalidate] Reading ${aspectFilePath} to remove entry for ${file}`);
                let ratios = {};
                const data = fs.readFileSync(aspectFilePath, 'utf8'); // Use sync version for simplicity here or convert to async
                ratios = JSON.parse(data);
                if (ratios.hasOwnProperty(file)) {
                    delete ratios[file];
                    fs.writeFileSync(aspectFilePath, JSON.stringify(ratios, null, 2), 'utf8'); // Use sync version
                    console.log(`[Thumbnails Invalidate] Removed aspect ratio for ${file} from ${aspectFilePath}`);
                } else {
                    console.log(`[Thumbnails Invalidate] Aspect ratio for ${file} not found in ${aspectFilePath}. No change needed.`);
                }
            } else {
                console.log(`[Thumbnails Invalidate] ${aspectFilePath} not found. No aspect ratio to remove for ${file}.`);
            }
        } catch (err) {
            console.error(`[Thumbnails Invalidate] Error processing aspect ratio file ${aspectFilePath} for ${file}:`, err);
        }
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
    let preciseAspectRatio = null; // Initialize for the return value

    // pngFormat (module-scoped const) will be used directly now.
    // The localPngFormat override has been removed.

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
        // If currentAspectRatios is provided (e.g., by ensureThumbnailCache), use it. Otherwise, null.
        const knownAspectRatio = currentAspectRatios ? currentAspectRatios[file] || null : null;
        return { path: pathToCachedFile, aspectRatio: knownAspectRatio };
    }

    if (!originalFileExists) {
        console.warn(`[Thumbnails] Original file not found for: ${file} at ${pathToOriginalFile}`);
        return null;
    }

    // preciseAspectRatio is already initialized above the try block

    try {
        // let buffer; // buffer is already declared in the outer scope of the function
        const image = await Jimp.read(pathToOriginalFile);
        console.log(`[Thumbnails] Successfully read original file: ${file} with Jimp.`);

        if (type === 'bg') {
            // preciseAspectRatio will be used for calculations
            let newWidth;
            let newHeight;
            let aspectCalculationSuccess = false;

            console.log(`[Thumbnails] Processing type 'bg' for file: ${file}`);

            try {
                const originalWidth = image.bitmap.width;
                const originalHeight = image.bitmap.height;
                console.log(`[Thumbnails] Original dimensions for ${file}: ${originalWidth}x${originalHeight}`);

                if (originalHeight > 0 && originalWidth > 0) {
                    preciseAspectRatio = originalWidth / originalHeight; // Assign to the function-scoped variable
                    const targetPixelArea = 12500;
                    newHeight = Math.round(Math.sqrt(targetPixelArea / preciseAspectRatio));
                    newWidth = Math.round(newHeight * preciseAspectRatio);
                    console.log(`[Thumbnails] Calculated for ${file}: AR=${preciseAspectRatio}, NewDims=${newWidth}x${newHeight}`);

                    if (newWidth > 0 && newHeight > 0) {
                        aspectCalculationSuccess = true;
                        console.log(`[Thumbnails] Aspect calculation SUCCESS for ${file}`);
                    } else {
                        console.warn(`[Thumbnails] Invalid new dimensions calculated for ${file}: ${newWidth}x${newHeight}. Will use fallback.`);
                        preciseAspectRatio = null; // Reset if calculation failed
                    }
                } else {
                    console.warn(`[Thumbnails] Invalid original dimensions for ${file}: ${originalWidth}x${originalHeight}. Will use fallback.`);
                    preciseAspectRatio = null; // Reset if original dims are invalid
                }
            } catch (e) {
                console.warn(`[Thumbnails] Error calculating aspect ratio or new dimensions for ${file}: ${e.message}. Will use fallback.`);
                preciseAspectRatio = null; // Reset on error
            }

            if (aspectCalculationSuccess) {
                console.log(`[Thumbnails] Applying image.scaleToFit({ w: ${newWidth}, h: ${newHeight}, mode: Jimp.RESIZE_BILINEAR }) for ${file}`);
                image.scaleToFit({ w: newWidth, h: newHeight, mode: Jimp.RESIZE_BILINEAR });
                console.log(`[Thumbnails] Dimensions *after* scaleToFit for ${file}: ${image.bitmap.width}x${image.bitmap.height}`);

                if (currentAspectRatios && preciseAspectRatio !== null) {
                    console.log(`[Thumbnails] Updating in-memory aspect ratios for ${file} with AR: ${preciseAspectRatio}`);
                    currentAspectRatios[file] = preciseAspectRatio;
                }
            } else { // Fallback for 'bg' if aspect calculation failed
                console.warn(`[Thumbnails] Using fallback 'cover' method for ${file}`);
                // Attempt to use original aspect ratio if it was calculated before failure, otherwise it's null
                if (currentAspectRatios && image.bitmap.height > 0 && image.bitmap.width > 0 && preciseAspectRatio === null) {
                    // This case means original dimensions were fine, but new dim calculation failed.
                    // So, we capture original AR here if not already set.
                    preciseAspectRatio = image.bitmap.width / image.bitmap.height;
                     console.log(`[Thumbnails] Capturing original AR for fallback for ${file}: ${preciseAspectRatio}`);
                }

                if (currentAspectRatios && preciseAspectRatio !== null) {
                     console.log(`[Thumbnails] Updating in-memory aspect ratios for ${file} with original AR: ${preciseAspectRatio} during fallback.`);
                    currentAspectRatios[file] = preciseAspectRatio;
                }
                const size = dimensions[type];
                const fallbackWidth = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
                const fallbackHeight = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
                image.cover({ w: fallbackWidth, h: fallbackHeight });
            }
        } else if (type === 'avatar') { // Avatars don't get 'preciseAspectRatio' saved in this manner currently
            console.log(`[Thumbnails] Processing type 'avatar' for ${file}`);
            const size = dimensions[type];
            const width = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
            const height = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
            image.cover({ w: width, h: height });
            preciseAspectRatio = null; // Ensure it's null for avatars for the return object
        }

        // Generate buffer only if image processing up to this point was successful
        console.log(`[Thumbnails] Generating buffer for ${file} using Promise-wrapped image.getBuffer(). PNG format: ${pngFormat}`);
        try {
            buffer = await new Promise((resolve, reject) => {
                const actualMimeType = pngFormat ? 'image/png' : 'image/jpeg';
                const cb = (err, buf) => {
                    if (err) {
                        console.error(`[Thumbnails] Error in getBuffer callback for ${file} (MIME: ${actualMimeType}):`, err);
                        return reject(err); // Reject the promise on error
                    }
                    console.log(`[Thumbnails] Successfully got buffer via callback for ${file} (MIME: ${actualMimeType}). Length: ${buf?.length}`);
                    resolve(buf); // Resolve with the buffer
                };

                if (pngFormat) {
                    console.log(`[Thumbnails] Getting buffer for PNG ${file} (MIME: ${actualMimeType}) with empty options`);
                    image.getBuffer(actualMimeType, {}, cb);
                } else {
                    console.log(`[Thumbnails] Getting buffer for JPEG ${file} (MIME: ${actualMimeType}) with quality: ${quality} and colorSpace: 'ycbcr'`);
                    image.getBuffer(actualMimeType, { quality: quality, jpegColorSpace: 'ycbcr' }, cb);
                }
            });
            console.log(`[Thumbnails] Promise for getBuffer resolved for ${file}. Buffer length: ${buffer?.length}`);
        } catch (getBufferError) {
            console.error(`[Thumbnails] Error during Promise-wrapped getBuffer for ${file}:`, getBufferError);
            // This error will be caught by the main catch (processingError) block of generateThumbnail,
            // which will then attempt the fallback to original image and return null.
            throw getBufferError; // Re-throw to be caught by the outer try-catch
        }

        // If buffer generation is successful, write it.
        try {
            console.log(`[Thumbnails] Writing thumbnail buffer to disk: ${pathToCachedFile} for file ${file}. Buffer length: ${buffer?.length}`);
            writeFileAtomicSync(pathToCachedFile, buffer);
            console.log(`[Thumbnails] Successfully wrote thumbnail for: ${file}. Path: ${pathToCachedFile}`);
            return { path: pathToCachedFile, aspectRatio: preciseAspectRatio }; // Return object
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
            // For fallback, we don't have a newly calculated AR.
            // It might be best to try and get original AR here if not already done, or return null for AR.
            // For now, returning null for AR in this specific fallback path.
            return { path: pathToCachedFile, aspectRatio: null };
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
                    // generateThumbnail now modifies allAspectRatios directly if successful for 'bg' type
                    // and returns an object { path: string|null, aspectRatio: number|null } or null for total failure
                    const thumbnailResult = await generateThumbnail(directories, 'bg', file, allAspectRatios);
                    results.push(thumbnailResult); // Store the actual result object or null

                    if (thumbnailResult && thumbnailResult.path) { // A path indicates the thumbnail file (or fallback) was written
                        successfulThumbs++;
                        // allAspectRatios is already updated by generateThumbnail for new/scaled images.
                        // For cached images, generateThumbnail now tries to return the known AR if currentAspectRatios is passed.
                        // If ensureThumbnailCache's allAspectRatios was the one passed, it's already up-to-date for cached.
                        console.log(`[Thumbnails Cache] Finished processing for: ${file} in ${bgDir}. Path: ${thumbnailResult.path}, AR: ${thumbnailResult.aspectRatio}`);
                    } else {
                        failedThumbs++;
                        console.log(`[Thumbnails Cache] Finished processing for: ${file} in ${bgDir}. Result: Failed (null or no path)`);
                    }
                } catch (error) {
                    console.error(`[Thumbnails Cache] Unhandled error processing file ${file} sequentially in ${bgDir}:`, error);
                    results.push(null); // Still count as a failure in results array
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

        // For single GET, we need to read/write the aspect_ratios.json file here.
        let currentAspectRatios = {}; // This will be passed to generateThumbnail
        const aspectFilePath = path.join(request.user.directories.root, 'aspect_ratios.json');
        let initialAspectRatiosSnapshot = {}; // To compare if currentAspectRatios changed

        if (type === 'bg') { // Only load/save for 'bg' type for this endpoint
            try {
                const data = await fsPromises.readFile(aspectFilePath, 'utf8');
                currentAspectRatios = JSON.parse(data);
                initialAspectRatiosSnapshot = JSON.parse(JSON.stringify(currentAspectRatios)); // Deep clone for comparison
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    console.error(`[Thumbnails API] Error reading ${aspectFilePath} for ${file}: ${err.message}`);
                } else {
                    console.log(`[Thumbnails API] ${aspectFilePath} not found for ${file}, will create if new AR is generated.`);
                }
                // currentAspectRatios remains {}
            }
        }

        const thumbnailResult = await generateThumbnail(request.user.directories, type, file, currentAspectRatios);

        if (type === 'bg' && thumbnailResult && thumbnailResult.aspectRatio !== null) {
            // Check if currentAspectRatios was actually modified for this file by generateThumbnail
            // This means a new aspect ratio was calculated and stored in the in-memory object.
            if (currentAspectRatios[file] === thumbnailResult.aspectRatio &&
                initialAspectRatiosSnapshot[file] !== thumbnailResult.aspectRatio) {
                try {
                    console.log(`[Thumbnails API] Attempting to write updated aspect ratios to ${aspectFilePath} for file ${file}`);
                    await fsPromises.writeFile(aspectFilePath, JSON.stringify(currentAspectRatios, null, 2), 'utf8');
                    console.log(`[Thumbnails API] Updated ${aspectFilePath} for ${file} with AR: ${thumbnailResult.aspectRatio}`);
                } catch (err) {
                    console.error(`[Thumbnails API] Error writing updated ${aspectFilePath} for ${file}: ${err.message}`);
                }
            } else if (currentAspectRatios[file] === thumbnailResult.aspectRatio) {
                 console.log(`[Thumbnails API] Aspect ratio for ${file} (${thumbnailResult.aspectRatio}) was already up-to-date or unchanged. No write needed.`);
            }
        }

        if (!thumbnailResult || !thumbnailResult.path) {
            return response.sendStatus(404);
        }

        if (!fs.existsSync(thumbnailResult.path)) {
            return response.sendStatus(404);
        }

        const contentType = mime.lookup(thumbnailResult.path) || 'image/jpeg';
        const cachedFile = await fsPromises.readFile(thumbnailResult.path);
        response.setHeader('Content-Type', contentType);
        return response.send(cachedFile);
    } catch (error) {
        console.error('[Thumbnails API] Failed getting thumbnail:', error);
        return response.sendStatus(500);
    }
});
