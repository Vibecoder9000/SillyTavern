import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import mime from 'mime-types'; // Ensure mime is imported if used by router part
import express from 'express'; // Ensure express is imported if used by router part
import sanitize from 'sanitize-filename'; // Ensure sanitize is imported
import { Jimp } from '../jimp.js'; // JimpMime is not used with direct mime strings
export { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue } from '../util.js';

export const currentMetadataVersion = "1.0.1"; // As per user's code version

const SKIPPED_EXTENSIONS_FOR_JIMP = ['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', '.webp']; // From user's code

const thumbnailsEnabled = !!getConfigValue('thumbnails.enabled', true, 'boolean');
const quality = Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 95, 'number'))));
// Module-scoped pngFormat, from config, used by generateThumbnail
const pngFormat = String(getConfigValue('thumbnails.format', 'jpg')).toLowerCase().trim() === 'png';

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
    if (!thumbnailFolder) { // Added safety check
        console.error(`[Thumbnails] Could not determine thumbnail folder for type: ${type}`, directories);
        // throw new Error(`Could not determine thumbnail folder for type: ${type}`);
        return null; // Return null to be handled by caller
    }
    return thumbnailFolder;
}

function getOriginalFolder(directories, type) {
    let originalFolder;
    switch (type) {
        case 'bg': originalFolder = directories.backgrounds; break;
        case 'avatar': originalFolder = directories.characters; break;
    }
    if (!originalFolder) { // Added safety check
         console.error(`[Thumbnails] Could not determine original folder for type: ${type}`, directories);
        // throw new Error(`Could not determine original folder for type: ${type}`);
        return null;
    }
    return originalFolder;
}

export function invalidateThumbnail(directories, type, file) {
    const sanitizedFile = sanitize(file); // Sanitize filename
    const folder = getThumbnailFolder(directories, type);
    if (!folder) {
        console.error(`[invalidateThumbnail] Could not get thumbnail folder for type ${type}, file ${sanitizedFile}.`);
        return;
    }
    const pathToThumbnail = path.join(folder, sanitizedFile);

    if (fs.existsSync(pathToThumbnail)) {
        try {
            fs.unlinkSync(pathToThumbnail);
            console.info(`[invalidateThumbnail] Deleted thumbnail file: ${pathToThumbnail}`);
        } catch (e) {
            console.error(`[invalidateThumbnail] Failed to delete thumbnail file ${pathToThumbnail}:`, e);
        }
    }

    if (type === 'bg') {
        const aspectRatiosJsonPath = path.join(folder, 'aspect_ratios.json'); // folder is thumbnailsBg
        try {
            if (fs.existsSync(aspectRatiosJsonPath)) {
                let aspectRatiosData = fs.readFileSync(aspectRatiosJsonPath, 'utf-8');
                let aspectRatios = JSON.parse(aspectRatiosData);
                if (aspectRatios.hasOwnProperty(sanitizedFile)) {
                    delete aspectRatios[sanitizedFile];
                    writeFileAtomicSync(aspectRatiosJsonPath, JSON.stringify(aspectRatios, null, 2));
                    console.info(`[invalidateThumbnail] Removed entry for "${sanitizedFile}" from aspect_ratios.json.`);
                    const versionFilePath = path.join(folder, 'aspect_metadata_version.txt');
                    fs.writeFileSync(versionFilePath, currentMetadataVersion);
                    console.info(`[invalidateThumbnail] Updated aspect_metadata_version.txt due to removal of ${sanitizedFile}.`);
                }
            }
        } catch (e) {
            console.error(`[invalidateThumbnail] Failed to update aspect_ratios.json for deleted file ${sanitizedFile}:`, e);
        }
    }
}

export async function generateThumbnail(directories, type, file, currentAspectRatiosObject) {
    const sanitizedFile = sanitize(file); // Ensure we use sanitized file name internally
    console.log(`[Thumbnails] Attempting to generate thumbnail for: ${sanitizedFile}, Type: ${type}`);
    const fileExtension = path.extname(sanitizedFile).toLowerCase();
    if (SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension)) {
        console.warn(`[Thumbnails] Skipped Jimp processing for "${sanitizedFile}" due to extension: ${fileExtension}.`);
        return null;
    }

    let thumbnailFolder = getThumbnailFolder(directories, type);
    let originalFolder = getOriginalFolder(directories, type);

    if (!thumbnailFolder || !originalFolder) {
        console.error(`[Thumbnails] Invalid folder path for file: ${sanitizedFile}. Type: ${type}. ThumbnailFolder: ${thumbnailFolder}, OriginalFolder: ${originalFolder}`);
        return null; // Return null if folders are not found
    }

    const pathToCachedFile = path.join(thumbnailFolder, sanitizedFile);
    const pathToOriginalFile = path.join(originalFolder, sanitizedFile);

    const originalFileExists = fs.existsSync(pathToOriginalFile);
    if (!originalFileExists) {
        console.warn(`[Thumbnails] Original file not found: ${pathToOriginalFile}`);
        if (fs.existsSync(pathToCachedFile)) {
            try { fs.unlinkSync(pathToCachedFile); console.warn(`[Thumbnails] Removed stale thumbnail: ${pathToCachedFile}`); }
            catch (e) { console.error(`[Thumbnails] Error removing stale thumbnail ${pathToCachedFile}: ${e.message}`); }
        }
        return null;
    }

    const cachedFileExists = fs.existsSync(pathToCachedFile);
    if (cachedFileExists) {
        const originalStat = fs.statSync(pathToOriginalFile);
        const cachedStat = fs.statSync(pathToCachedFile);
        if (originalStat.mtimeMs <= cachedStat.mtimeMs) {
            console.log(`[Thumbnails] Using cached thumbnail for: ${sanitizedFile} (original not newer).`);
            const knownAR = currentAspectRatiosObject ? currentAspectRatiosObject[sanitizedFile] : null;
            return { path: pathToCachedFile, aspectRatio: knownAR || null };
        }
        console.log(`[Thumbnails] Original file ${sanitizedFile} changed. Regenerating thumbnail...`);
    }

    let image;
    try {
        image = await Jimp.read(pathToOriginalFile);
        console.log(`[Thumbnails] Successfully read original file: ${sanitizedFile} with Jimp.`);
    } catch (readError) {
        console.error(`[Thumbnails] Jimp.read failed for ${sanitizedFile}:`, readError);
        return null;
    }

    const preciseAspectRatio = image.bitmap.width / image.bitmap.height;
    if (!isFinite(preciseAspectRatio) || preciseAspectRatio <= 0) {
        console.error(`[Thumbnails] Invalid preciseAspectRatio (${preciseAspectRatio}) calculated for ${sanitizedFile}. Skipping.`);
        return null;
    }

    console.log(`[Thumbnails] Processing type '${type}' for file: ${sanitizedFile}`);
    // let processedImageForBuffer = image; // Use 'image' directly if not cloning for transformations

    if (type === 'bg') {
        let aspectCalculationSuccess = false;
        let newWidth = image.bitmap.width; // Default to original if scaling fails
        let newHeight = image.bitmap.height;

        try {
            const originalWidth = image.bitmap.width;
            const originalHeight = image.bitmap.height;
            console.log(`[Thumbnails] Original dimensions for ${sanitizedFile}: ${originalWidth}x${originalHeight}`);

            if (originalHeight > 0 && originalWidth > 0) {
                const targetPixelArea = 12500;
                newHeight = Math.round(Math.sqrt(targetPixelArea / preciseAspectRatio));
                newWidth = Math.round(newHeight * preciseAspectRatio);
                newWidth = Math.max(1, newWidth); newHeight = Math.max(1, newHeight); // Ensure at least 1x1
                console.log(`[Thumbnails] Calculated for ${sanitizedFile}: AR=${preciseAspectRatio}, NewDims=${newWidth}x${newHeight}`);
                aspectCalculationSuccess = true;
            } else {
                console.warn(`[Thumbnails] Invalid original dimensions for ${sanitizedFile}: ${originalWidth}x${originalHeight}.`);
            }
        } catch (e) {
            console.warn(`[Thumbnails] Error calculating new dimensions for ${sanitizedFile}: ${e.message}.`);
        }

        if (aspectCalculationSuccess) {
            try {
                console.log(`[Thumbnails] Applying image.scaleToFit({ w: ${newWidth}, h: ${newHeight}, mode: Jimp.RESIZE_BILINEAR }) for ${sanitizedFile}`);
                // Perform operations on 'image' directly
                image.scaleToFit({ w: newWidth, h: newHeight, mode: Jimp.RESIZE_BILINEAR });
                console.log(`[Thumbnails] Dimensions *after* scaleToFit for ${sanitizedFile}: ${image.bitmap.width}x${image.bitmap.height}`);
            } catch (scaleError) {
                console.error(`[Thumbnails] Error during scaleToFit for ${sanitizedFile}:`, scaleError);
                console.warn(`[Thumbnails] Using original image dimensions for buffer due to scaleToFit error for ${sanitizedFile}.`);
            }
        } else {
            console.warn(`[Thumbnails] Aspect calculation or new dimensions invalid for ${sanitizedFile}. Using original image dimensions for buffer.`);
        }
        if (currentAspectRatiosObject && typeof preciseAspectRatio === 'number' && isFinite(preciseAspectRatio)) {
             console.log(`[Thumbnails] Updating in-memory aspect ratios for ${sanitizedFile} with AR: ${preciseAspectRatio}`);
             currentAspectRatiosObject[sanitizedFile] = preciseAspectRatio;
        }
    } else if (type === 'avatar') {
        console.log(`[Thumbnails] Applying cover for avatar: ${sanitizedFile}`);
        const size = dimensions[type];
        const coverWidth = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
        const coverHeight = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
        image.cover({ w: coverWidth, h: coverHeight });
    }

    let bufferToSave; // Renamed to avoid conflict with outer scope if any
    const actualMimeTypeForBuffer = pngFormat ? 'image/png' : 'image/jpeg'; // Use module-scoped pngFormat
    console.log(`[Thumbnails] Generating buffer for ${sanitizedFile} using image.getBufferAsync(). Target format: ${actualMimeTypeForBuffer}`);
    try {
        if (pngFormat) { // Use module-scoped pngFormat
            console.log(`[Thumbnails] Getting async buffer for PNG ${sanitizedFile} (MIME: ${actualMimeTypeForBuffer}) with empty options`);
            bufferToSave = await image.getBufferAsync(actualMimeTypeForBuffer, {});
        } else {
            console.log(`[Thumbnails] Getting async buffer for JPEG ${sanitizedFile} (MIME: ${actualMimeTypeForBuffer}) with quality: ${quality} and colorSpace: 'ycbcr'`);
            bufferToSave = await image.getBufferAsync(actualMimeTypeForBuffer, { quality: quality, jpegColorSpace: 'ycbcr' });
        }
        console.log(`[Thumbnails] Successfully got async buffer for ${sanitizedFile}. Length: ${bufferToSave?.length}`);
    } catch (getBufferError) {
        console.error(`[Thumbnails] Error during image.getBufferAsync for ${sanitizedFile}:`, getBufferError);
        console.warn(`[Thumbnails] Attempting fallback: using original file buffer for ${sanitizedFile} due to getBufferAsync error.`);
        try {
            bufferToSave = await fsPromises.readFile(pathToOriginalFile);
            console.log(`[Thumbnails] Successfully read original file for fallback buffer for ${sanitizedFile}. Length: ${bufferToSave?.length}`);
        } catch (originalReadError) {
            console.error(`[Thumbnails] Fallback failed: Could not read original file ${pathToOriginalFile} for ${sanitizedFile}:`, originalReadError);
            return null;
        }
    }

    try {
        console.log(`[Thumbnails] Writing thumbnail buffer to disk: ${pathToCachedFile} for file ${sanitizedFile}. Buffer length: ${bufferToSave?.length}`);
        writeFileAtomicSync(pathToCachedFile, bufferToSave);
        console.log(`[Thumbnails] Successfully wrote thumbnail for: ${sanitizedFile}. Path: ${pathToCachedFile}`);
        return { path: pathToCachedFile, aspectRatio: (type === 'bg' ? preciseAspectRatio : null) };
    } catch (writeError) {
        console.error(`[Thumbnails] Failed to write thumbnail to disk for ${sanitizedFile} at ${pathToCachedFile}:`, writeError);
        return null;
    }
} // End generateThumbnail

export async function ensureThumbnailCache(directoriesList) {
    for (const directories of directoriesList) {
        const bgDir = directories.backgrounds;
        if (!bgDir) { // Added check for bgDir itself
            console.warn('[Thumbnails Cache] Backgrounds directory path is undefined for a user, skipping.');
            continue;
        }
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
            allAspectRatios = {};
        }

        let imageFileNames = [];
        let totalEntries = 0;
        try {
            if (!fs.existsSync(bgDir)) { // Check if bgDir exists before reading
                console.warn(`[Thumbnails Cache] Backgrounds directory ${bgDir} does not exist. Skipping.`);
                continue;
            }
            const bgFiles = fs.readdirSync(bgDir);
            totalEntries = bgFiles.length;
            imageFileNames = bgFiles.filter(fileName => {
                try {
                    const filePath = path.join(bgDir, fileName);
                    return fs.statSync(filePath).isFile();
                } catch (statError) {
                    console.warn(`[Thumbnails Cache] Error stating file ${fileName} in ${bgDir}, skipping: ${statError.message}`);
                    return false;
                }
            });
            console.log(`[Thumbnails Cache] Found ${imageFileNames.length} actual image files to process in ${bgDir} (out of ${totalEntries} total entries).`);
        } catch (readDirError) {
            console.error(`[Thumbnails Cache] Error reading directory ${bgDir}: ${readDirError.message}. Skipping this directory.`);
            continue;
        }

        if (imageFileNames.length === 0) {
            console.log(`[Thumbnails Cache] No image files to process in ${bgDir}.`);
        } else {
            console.log(`[Thumbnails Cache] About to process ${imageFileNames.length} image tasks sequentially for directory ${bgDir}.`);
            let successfulThumbs = 0;
            let failedThumbs = 0;

            for (const file of imageFileNames) { // file here is already sanitized from readdirSync
                console.log(`[Thumbnails Cache] Processing thumbnail for: ${file} in ${bgDir}`);
                try {
                    const result = await generateThumbnail(directories, 'bg', file, allAspectRatios);
                    if (result && result.path) {
                        successfulThumbs++;
                        // Aspect ratio already updated in allAspectRatios by generateThumbnail
                        console.log(`[Thumbnails Cache] Finished processing for: ${file} in ${bgDir}. Result: Success, Path: ${result.path}, AR: ${result.aspectRatio}`);
                    } else {
                        failedThumbs++;
                         console.log(`[Thumbnails Cache] Finished processing for: ${file} in ${bgDir}. Result: Failed (null)`);
                    }
                } catch (error) {
                    console.error(`[Thumbnails Cache] Unhandled error processing file ${file} sequentially in ${bgDir}:`, error);
                    failedThumbs++;
                }
            }

            console.log(`[Thumbnails Cache] Sequential processing completed for ${bgDir}.`);
            console.log(`[Thumbnails Cache] Breakdown for ${bgDir}: Successful thumbnails: ${successfulThumbs}, Failed: ${failedThumbs}`);
        }

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

export const router = express.Router(); // From user's code
router.get('/', async function (request, response) { // From user's code, adapted slightly
    try {
        if (typeof request.query.file !== 'string' || typeof request.query.type !== 'string') {
            return response.sendStatus(400);
        }
        const type = request.query.type;
        const file = sanitize(request.query.file); // Sanitize filename from query
        if (!type || !file) return response.sendStatus(400);
        if (!(type === 'bg' || type === 'avatar')) return response.sendStatus(400);

        if (!thumbnailsEnabled) {
            const originalFolder = getOriginalFolder(request.user.directories, type);
            if (!originalFolder) return response.status(500).send('Cannot determine original folder.');
            const pathToOriginalFile = path.join(originalFolder, file); // file is already sanitized
            if (!fs.existsSync(pathToOriginalFile)) return response.sendStatus(404);
            const contentType = mime.lookup(pathToOriginalFile) || 'image/png';
            const originalFileBuffer = await fsPromises.readFile(pathToOriginalFile);
            response.setHeader('Content-Type', contentType);
            return response.send(originalFileBuffer);
        }

        // For single requests, load/save aspect_ratios.json directly.
        // This needs a locking mechanism for proper concurrent safety, but for now:
        let currentAspectRatios = {};
        const aspectFilePath = path.join(request.user.directories.root, 'aspect_ratios.json');
        if (type === 'bg') { // Only bg types affect aspect_ratios.json here
             try {
                const data = await fsPromises.readFile(aspectFilePath, 'utf8');
                currentAspectRatios = JSON.parse(data);
            } catch (err) { /* ignore if not found, start empty */ }
        }

        const thumbnailResult = await generateThumbnail(request.user.directories, type, file, currentAspectRatios);

        if (type === 'bg' && thumbnailResult && typeof thumbnailResult.aspectRatio === 'number') {
            // If generateThumbnail updated currentAspectRatios, save it
            // This is a simplified save; ideally check if currentAspectRatios[file] actually changed
            try {
                await fsPromises.writeFile(aspectFilePath, JSON.stringify(currentAspectRatios, null, 2), 'utf8');
                 console.log(`[Thumbnails API] Updated ${aspectFilePath} for ${file}`);
            } catch (e) {
                console.error(`[Thumbnails API] Failed to write ${aspectFilePath} for ${file}: ${e.message}`);
            }
        }

        const pathToCachedFile = thumbnailResult ? thumbnailResult.path : null;
        if (!pathToCachedFile || !fs.existsSync(pathToCachedFile)) {
            console.error(`[/thumbnail route] File NOT FOUND: ${pathToCachedFile} for type: ${type}, file: ${file}`);
            return response.sendStatus(404);
        }
        const contentType = mime.lookup(pathToCachedFile) || (pngFormat ? 'image/png' : 'image/jpeg');
        const cachedFileBuffer = await fsPromises.readFile(pathToCachedFile);
        response.setHeader('Content-Type', contentType);
        return response.send(cachedFileBuffer);
    } catch (error) {
        console.error('Failed getting thumbnail via API:', error);
        return response.sendStatus(500);
    }
});
