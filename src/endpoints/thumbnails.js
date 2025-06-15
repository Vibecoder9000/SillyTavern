import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp } from '../jimp.js';
export { sync as writeFileAtomicSync } from 'write-file-atomic';

import { getConfigValue } from '../util.js';

export const currentMetadataVersion = "1.0.1";

const SKIPPED_EXTENSIONS_FOR_JIMP = ['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', '.webp'];

const thumbnailsEnabled = !!getConfigValue('thumbnails.enabled', true, 'boolean');
const quality = Math.min(100, Math.max(1, parseInt(getConfigValue('thumbnails.quality', 95, 'number'))));
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
        default:
            console.error(`[Thumbnails] Unknown type in getThumbnailFolder: ${type}`);
            return null;
    }
    if (!thumbnailFolder) {
        console.error(`[Thumbnails] Could not determine thumbnail folder for type: ${type}`, directories);
        return null;
    }
    return thumbnailFolder;
}

function getOriginalFolder(directories, type) {
    let originalFolder;
    switch (type) {
        case 'bg': originalFolder = directories.backgrounds; break;
        case 'avatar': originalFolder = directories.characters; break;
        default:
            console.error(`[Thumbnails] Unknown type in getOriginalFolder: ${type}`);
            return null;
    }
    if (!originalFolder) {
        console.error(`[Thumbnails] Could not determine original folder for type: ${type}`, directories);
        return null;
    }
    return originalFolder;
}

export function invalidateThumbnail(directories, type, file) {
    const sanitizedFile = sanitize(file);
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
        // For 'bg' type, aspect_ratios.json is in user's root directory as per ensureThumbnailCache logic
        const aspectRatiosJsonPath = path.join(directories.root, 'aspect_ratios.json');
        try {
            if (fs.existsSync(aspectRatiosJsonPath)) {
                let aspectRatiosData = fs.readFileSync(aspectRatiosJsonPath, 'utf-8');
                let aspectRatios = JSON.parse(aspectRatiosData);
                if (aspectRatios.hasOwnProperty(sanitizedFile)) {
                    delete aspectRatios[sanitizedFile];
                    writeFileAtomicSync(aspectRatiosJsonPath, JSON.stringify(aspectRatios, null, 2));
                    console.info(`[invalidateThumbnail] Removed entry for "${sanitizedFile}" from ${aspectRatiosJsonPath}.`);
                    // Assuming version file is also in directories.root if it's tied to this JSON
                    // const versionFilePath = path.join(directories.root, 'aspect_metadata_version.txt');
                    // fs.writeFileSync(versionFilePath, currentMetadataVersion);
                    // console.info(`[invalidateThumbnail] Updated aspect_metadata_version.txt due to removal of ${sanitizedFile}.`);
                }
            }
        } catch (e) {
            console.error(`[invalidateThumbnail] Failed to update ${aspectRatiosJsonPath} for deleted file ${sanitizedFile}:`, e);
        }
    }
}

export async function generateThumbnail(directories, type, file, currentAspectRatiosObject) {
    const sanitizedFile = sanitize(file);
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
        return null;
    }

    const pathToCachedFile = path.join(thumbnailFolder, sanitizedFile);
    const pathToOriginalFile = path.join(originalFolder, sanitizedFile);

    if (!fs.existsSync(pathToOriginalFile)) {
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
            const knownAR = (currentAspectRatiosObject && currentAspectRatiosObject.hasOwnProperty(sanitizedFile)) ? currentAspectRatiosObject[sanitizedFile] : null;
            return { path: pathToCachedFile, aspectRatio: knownAR };
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

    let preciseAspectRatio = null;
    if (image.bitmap && typeof image.bitmap.width === 'number' && typeof image.bitmap.height === 'number') { // Added type check
        preciseAspectRatio = image.bitmap.width / image.bitmap.height;
        if (!isFinite(preciseAspectRatio) || preciseAspectRatio <= 0) {
            console.error(`[Thumbnails] Invalid preciseAspectRatio (${preciseAspectRatio}) calculated for ${sanitizedFile}. Skipping.`);
            return null;
        }
    } else {
        console.error(`[Thumbnails] Could not read bitmap dimensions for ${sanitizedFile}. Skipping.`);
        return null;
    }

    console.log(`[Thumbnails] Processing type '${type}' for file: ${sanitizedFile}`);

    if (type === 'bg') {
        let aspectCalculationSuccess = false;
        let newWidth = image.bitmap.width;
        let newHeight = image.bitmap.height;

        try {
            const originalWidth = image.bitmap.width;
            const originalHeight = image.bitmap.height;
            console.log(`[Thumbnails] Original dimensions for ${sanitizedFile}: ${originalWidth}x${originalHeight}`);

            const targetPixelArea = 12500;
            newHeight = Math.round(Math.sqrt(targetPixelArea / preciseAspectRatio));
            newWidth = Math.round(newHeight * preciseAspectRatio);
            newWidth = Math.max(1, newWidth);
            newHeight = Math.max(1, newHeight);
            console.log(`[Thumbnails] Calculated for ${sanitizedFile}: AR=${preciseAspectRatio}, NewDims=${newWidth}x${newHeight}`);
            aspectCalculationSuccess = true;
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
            console.warn(`[Thumbnails] New dimension calculation invalid for ${sanitizedFile}. Using original image dimensions for buffer.`);
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
        preciseAspectRatio = null;
    }

    let bufferToSave;
    const actualMimeTypeForBuffer = pngFormat ? 'image/png' : 'image/jpeg';
    console.log(`[Thumbnails] Generating buffer for ${sanitizedFile} using image.getBufferAsync(). Target format: ${actualMimeTypeForBuffer}`);
    try {
        if (pngFormat) {
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
        if (!bgDir || !fs.existsSync(bgDir)) {
            console.warn(`[Thumbnails Cache] Backgrounds directory path is undefined or does not exist: ${bgDir}, skipping.`);
            continue;
        }
        const thumbBgDir = getThumbnailFolder(directories, 'bg');
        if (!thumbBgDir) {
             console.warn(`[Thumbnails Cache] Could not determine thumbnailsBg directory for ${bgDir}, skipping.`);
             continue;
        }
        if (!fs.existsSync(thumbBgDir)) {
            try { fs.mkdirSync(thumbBgDir, { recursive: true }); console.info(`[Thumbnails Cache] Created thumbnailsBg directory: ${thumbBgDir}`);}
            catch (e) { console.error(`[Thumbnails Cache] Failed to create thumbnailsBg directory ${thumbBgDir}: ${e.message}. Skipping.`); continue; }
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
        let totalEntriesInDir = 0; // Renamed for clarity
        try {
            const allFilesInBgDir = fs.readdirSync(bgDir); // Renamed for clarity
            totalEntriesInDir = allFilesInBgDir.length;
            imageFileNames = allFilesInBgDir.filter(fileName => {
                try {
                    const filePath = path.join(bgDir, fileName);
                    return fs.statSync(filePath).isFile();
                } catch (statError) {
                    console.warn(`[Thumbnails Cache] Error stating file ${fileName} in ${bgDir}, skipping: ${statError.message}`);
                    return false;
                }
            });
            console.log(`[Thumbnails Cache] Found ${imageFileNames.length} actual image files to process in ${bgDir} (out of ${totalEntriesInDir} total entries).`);
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
                } catch (error) { // This catch is for truly unexpected errors from generateThumbnail
                    console.error(`[Thumbnails Cache] Critical unhandled error during generateThumbnail for file ${file} in ${bgDir}:`, error);
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

export const router = express.Router();
router.get('/', async function (request, response) {
    try {
        if (!request.user || !request.user.directories) {
             console.error('[/thumbnail route] User directories not found on request object.');
             return response.status(500).send('User data not configured on request.');
        }
        if (typeof request.query.file !== 'string' || typeof request.query.type !== 'string') {
            return response.sendStatus(400);
        }
        const type = request.query.type;
        const file = sanitize(request.query.file);
        if (!type || !file) return response.sendStatus(400);
        if (!(type === 'bg' || type === 'avatar')) return response.sendStatus(400);

        if (!thumbnailsEnabled) {
            const originalFolder = getOriginalFolder(request.user.directories, type);
            if (!originalFolder) return response.status(500).send('Cannot determine original folder.');
            const pathToOriginalFile = path.join(originalFolder, file);
            if (!fs.existsSync(pathToOriginalFile)) return response.sendStatus(404);
            const contentType = mime.lookup(pathToOriginalFile) || 'image/png'; // Default to png if lookup fails
            const originalFileBuffer = await fsPromises.readFile(pathToOriginalFile);
            response.setHeader('Content-Type', contentType);
            return response.send(originalFileBuffer);
        }

        let currentAspectRatios = {};
        const aspectFilePath = path.join(request.user.directories.root, 'aspect_ratios.json');

        if (type === 'bg') {
             try {
                if(fs.existsSync(aspectFilePath)){
                    const data = await fsPromises.readFile(aspectFilePath, 'utf8');
                    currentAspectRatios = JSON.parse(data);
                }
            } catch (err) {
                if (err.code !== 'ENOENT') {
                    console.error(`[/thumbnail route] Error reading ${aspectFilePath} for ${file}: ${err.message}.`);
                }
                 currentAspectRatios = {};
            }
        }

        // Pass a clone of currentAspectRatios to avoid unintended modifications if generateThumbnail is called multiple times by API
        // However, generateThumbnail is designed to update the object by reference for ensureThumbnailCache.
        // For single API calls, we want to load, potentially update for THIS file, then save.
        // So, we load, pass to generateThumbnail, it updates our currentAspectRatios object.
        const tempAspectRatiosForThisCall = { ...currentAspectRatios }; // Use a copy for this call if needed, but generateThumbnail will update it
        const thumbnailResult = await generateThumbnail(request.user.directories, type, file, tempAspectRatiosForThisCall);

        // Check if generateThumbnail actually changed the aspect ratio for *this specific file* in tempAspectRatiosForThisCall
        // compared to what was loaded in currentAspectRatios, or if it added a new one.
        let arChangedByGenerate = false;
        if (type === 'bg' && thumbnailResult && typeof thumbnailResult.aspectRatio === 'number' && isFinite(thumbnailResult.aspectRatio)) {
            if (currentAspectRatios[file] !== thumbnailResult.aspectRatio) {
                currentAspectRatios[file] = thumbnailResult.aspectRatio; // Update the original map
                arChangedByGenerate = true;
            }
        } else if (type === 'bg' && thumbnailResult === null && currentAspectRatios.hasOwnProperty(file)) {
            // Thumbnail failed to generate, remove AR if it existed
            delete currentAspectRatios[file];
            arChangedByGenerate = true;
        }


        if (type === 'bg' && arChangedByGenerate) {
            try {
                console.log(`[/thumbnail route] Attempting to write updated aspect ratios from API for ${file}. Keys: ${Object.keys(currentAspectRatios).length}`);
                await fsPromises.writeFile(aspectFilePath, JSON.stringify(currentAspectRatios, null, 2), 'utf8');
                console.log(`[/thumbnail route] Updated ${aspectFilePath} for ${file} via API call.`);
            } catch (e) {
                console.error(`[/thumbnail route] Failed to write ${aspectFilePath} for ${file} via API call: ${e.message}`);
            }
        }

        const pathToCachedFile = thumbnailResult ? thumbnailResult.path : null;
        if (!pathToCachedFile || !fs.existsSync(pathToCachedFile)) {
            console.error(`[/thumbnail route] File NOT FOUND: ${pathToCachedFile} for type: ${type}, file: ${file}`);
            return response.sendStatus(404);
        }

        // Determine content type from actual file extension on disk, as pngFormat global might not match forced fallback
        const finalFileExtension = path.extname(pathToCachedFile).toLowerCase();
        let responseContentType = 'image/jpeg'; // Default
        if (finalFileExtension === '.png') responseContentType = 'image/png';
        else if (finalFileExtension === '.gif') responseContentType = 'image/gif'; // etc.
        responseContentType = mime.lookup(pathToCachedFile) || responseContentType; // Prefer mime lookup

        const cachedFileBuffer = await fsPromises.readFile(pathToCachedFile);
        response.setHeader('Content-Type', responseContentType);
        return response.send(cachedFileBuffer);
    } catch (error) {
        console.error('Failed getting thumbnail via API:', error);
        return response.sendStatus(500);
    }
});
