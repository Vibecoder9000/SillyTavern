import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import mime from 'mime-types';
import express from 'express';
import sanitize from 'sanitize-filename';
import { Jimp, JimpMime } from '../jimp.js';
export { sync as writeFileAtomicSync } from 'write-file-atomic'; // Re-exporting
import { sync as writeFileAtomicSyncDirect } from 'write-file-atomic';

import { getConfigValue } from '../util.js';

// This constant needs to be accessible for export
export const currentMetadataVersion = "1.0.1";

const SKIPPED_EXTENSIONS_FOR_JIMP = ['.apng', '.mp4', '.webm', '.avi', '.mkv', '.flv', '.webp'];

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
export function getThumbnailFolder(directories, type) { // Added export
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
        try {
            fs.unlinkSync(pathToThumbnail);
            console.info(`[invalidateThumbnail] Deleted thumbnail file: ${pathToThumbnail}`);
        } catch (e) {
            console.error(`[invalidateThumbnail] Failed to delete thumbnail file ${pathToThumbnail}:`, e);
            // If deletion fails, we might not want to proceed with JSON update,
            // or handle it based on desired robustness. For now, log and continue.
        }
    }

    if (type === 'bg') {
        // const thumbnailBaseDir = getThumbnailFolder(directories, 'bg'); // No longer needed for JSON path
        if (!directories.root) {
            console.error('[invalidateThumbnail] directories.root is not defined. Cannot update aspect ratio metadata.');
            return;
        }
        const aspectRatiosJsonPath = path.join(directories.root, 'aspect_ratios.json');
        // const versionFilePath = path.join(directories.root, 'aspect_metadata_version.txt'); // Removed

        try {
            if (fs.existsSync(aspectRatiosJsonPath)) {
                let aspectRatiosData = fs.readFileSync(aspectRatiosJsonPath, 'utf-8');
                let aspectRatios = JSON.parse(aspectRatiosData);

                if (aspectRatios.hasOwnProperty(file)) {
                    delete aspectRatios[file];
                    aspectRatios._metadata_version = currentMetadataVersion; // Ensure version is updated
                    writeFileAtomicSyncDirect(aspectRatiosJsonPath, JSON.stringify(aspectRatios, null, 2));
                    console.info(`[invalidateThumbnail] Removed entry for "${file}" and updated version in aspect_ratios.json at ${directories.root}.`);

                    // fs.writeFileSync(versionFilePath, currentMetadataVersion); // Removed
                    // console.info(`[invalidateThumbnail] Updated aspect_metadata_version.txt at ${directories.root} due to removal of ${file}.`); // Removed
                }
            }
            // If aspectRatiosJsonPath doesn't exist, there's nothing to remove the file from, and no version to update.
            // ensureThumbnailCache will handle consistency if it runs next.
        } catch (e) {
            console.error(`[invalidateThumbnail] Failed to update aspect_ratios.json or version for deleted file ${file}:`, e);
        }
    }
}

export async function generateThumbnail(directories, type, file) {
    console.log(`[generateThumbnail] Starting for: ${file}, type: ${type}`); // Log entry
    const fileExtension = path.extname(file).toLowerCase();
    if (SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension)) {
        console.log(`[generateThumbnail] Skipped (extension): ${file}`);
        return null;
    }

    let thumbnailFolder = getThumbnailFolder(directories, type);
    let originalFolder = getOriginalFolder(directories, type);
    if (thumbnailFolder === undefined || originalFolder === undefined) {
        console.error('[generateThumbnail] Error: Invalid thumbnail type.');
        throw new Error('Invalid thumbnail type');
    }

    const pathToCachedFile = path.join(thumbnailFolder, file);
    const pathToOriginalFile = path.join(originalFolder, file);

    // ... (keep existing file existence and shouldRegenerate logic) ...
    const cachedFileExists = fs.existsSync(pathToCachedFile);
    const originalFileExists = fs.existsSync(pathToOriginalFile);
    let shouldRegenerate = false;

    if (!originalFileExists) {
        console.log(`[generateThumbnail] Original file not found: ${pathToOriginalFile}`);
        if (cachedFileExists) {
            try {
                fs.unlinkSync(pathToCachedFile);
                console.warn(`[generateThumbnail] Removed stale thumbnail for deleted original: ${file}`);
            } catch (e) {
                console.error(`[generateThumbnail] Error removing stale thumbnail ${pathToCachedFile}: ${e.message}`);
            }
        }
        return null;
    }

    if (cachedFileExists) {
        const originalStat = fs.statSync(pathToOriginalFile);
        const cachedStat = fs.statSync(pathToCachedFile);
        if (originalStat.mtimeMs > cachedStat.mtimeMs) {
            shouldRegenerate = true;
            console.log(`[generateThumbnail] Marked for regeneration (original newer): ${file}`);
        }
    }
    // End of existing logic to keep

    try {
        if (cachedFileExists && !shouldRegenerate) {
            console.log(`[generateThumbnail] Using existing cache for: ${file}`);
            let numericalAspectRatio = 1.0;
            try {
                console.log(`[generateThumbnail] Reading original for AR (cache exists): ${pathToOriginalFile}`);
                const imageForAspectRatio = await Jimp.read(pathToOriginalFile);
                console.log(`[generateThumbnail] Read original for AR successful: ${file}`);
                if (imageForAspectRatio.bitmap.height === 0) {
                    console.warn(`[generateThumbnail] Image ${file} has zero height (cached case). Defaulting AR to 1.0.`);
                    numericalAspectRatio = 1.0;
                } else {
                    numericalAspectRatio = imageForAspectRatio.bitmap.width / imageForAspectRatio.bitmap.height;
                }
            } catch (e) {
                console.warn(`[generateThumbnail] Jimp could not read ${file} for AR (cached case): ${e.message}. Defaulting AR to 1.0.`);
            }
            return { path: pathToCachedFile, aspectRatio: numericalAspectRatio };
        }

        console.log(`[generateThumbnail] Processing (new or regen): ${file}`);
        console.log(`[generateThumbnail] Reading original: ${pathToOriginalFile}`);
        const image = await Jimp.read(pathToOriginalFile);
        console.log(`[generateThumbnail] Read original successful: ${file}. Dimensions: ${image.bitmap.width}x${image.bitmap.height}`);

        let numericalAspectRatio = 1.0;
        if (image.bitmap.height === 0) {
            console.warn(`[generateThumbnail] Image ${file} has zero height (main process). Defaulting AR to 1.0.`);
        } else {
            numericalAspectRatio = image.bitmap.width / image.bitmap.height;
        }
        console.log(`[generateThumbnail] Calculated AR for ${file}: ${numericalAspectRatio}`);

        let buffer;
        const thumbImage = image.clone();

        if (type === 'bg') {
            // (This part should already be in place from previous steps, just ensure it's there)
            const targetPixelArea = 12500;
            let newHeight = Math.round(Math.sqrt(targetPixelArea / (numericalAspectRatio === 0 ? 1 : numericalAspectRatio)));
            let newWidth = Math.round(newHeight * numericalAspectRatio);
            console.log(`[generateThumbnail] Target dimensions for ${file}: ${newWidth}x${newHeight}`);

            if (newWidth === 0 || newHeight === 0) {
                console.warn(`[generateThumbnail] Calculated new dimensions for ${file} are zero. Using fallback cover.`);
                const fallbackSize = dimensions[type];
                newWidth = !isNaN(fallbackSize?.[0]) && fallbackSize?.[0] > 0 ? fallbackSize[0] : image.bitmap.width;
                newHeight = !isNaN(fallbackSize?.[1]) && fallbackSize?.[1] > 0 ? fallbackSize[1] : image.bitmap.height;
                if (newWidth === 0) newWidth = 160;
                if (newHeight === 0) newHeight = 90;
                console.log(`[generateThumbnail] Fallback dimensions for ${file}: ${newWidth}x${newHeight}`);
                thumbImage.cover({ w: newWidth, h: newHeight });
            } else {
                thumbImage.scaleToFit({ w: newWidth, h: newHeight, mode: Jimp.RESIZE_BILINEAR });
            }
        } else {
            const size = dimensions[type];
            const width = !isNaN(size?.[0]) && size?.[0] > 0 ? size[0] : image.bitmap.width;
            const height = !isNaN(size?.[1]) && size?.[1] > 0 ? size[1] : image.bitmap.height;
            console.log(`[generateThumbnail] Using fixed dimensions for ${file} (type ${type}): ${width}x${height}`);
            thumbImage.cover({ w: width, h: height });
        }

        console.log(`[generateThumbnail] Resized ${file}. Getting buffer...`); // Existing log
        if (pngFormat) {
            console.log(`[generateThumbnail] Getting PNG buffer for ${file} using await getBuffer(JimpMime.png)`);
            buffer = await thumbImage.getBuffer(JimpMime.png); // No options object for PNG with getBuffer
        } else {
            console.log(`[generateThumbnail] Getting JPEG buffer for ${file} using await getBuffer(JimpMime.jpeg) with quality ${quality}`);
            // Added jpegColorSpace based on user's original debug log for getBuffer
            buffer = await thumbImage.getBuffer(JimpMime.jpeg, { quality: quality, jpegColorSpace: 'ycbcr' });
        }

        console.log(`[generateThumbnail] Got buffer for ${file}. Length: ${buffer?.length}. Writing to: ${pathToCachedFile}`);
        writeFileAtomicSyncDirect(pathToCachedFile, buffer);
        console.log(`[generateThumbnail] Successfully wrote thumbnail for: ${file}`);
        return { path: pathToCachedFile, aspectRatio: numericalAspectRatio };

    } catch (error) {
        console.error(`[generateThumbnail] CRITICAL ERROR processing ${file}: ${error.message}`, error.stack); // Log full stack
        if (shouldRegenerate && cachedFileExists) {
            try {
                fs.unlinkSync(pathToCachedFile);
                console.warn(`[generateThumbnail] Removed potentially outdated/corrupt thumbnail for ${file} due to regeneration failure after error.`);
            } catch (e) {
                console.error(`[generateThumbnail] Error removing thumbnail for ${file} after regeneration failure: ${e.message}`);
            }
        }
        return null;
    }
}


/**
 * Ensures that the thumbnail cache for backgrounds is valid.
 * @param {import('../users.js').UserDirectoryList[]} directoriesList User directories
 * @returns {Promise<void>} Promise that resolves when the cache is validated
 */
export async function ensureThumbnailCache(directoriesList) {
    // currentMetadataVersion is now a module constant

    for (const directories of directoriesList) {
        if (!directories.backgrounds || !directories.thumbnailsBg) {
            console.warn('[ensureThumbnailCache] Missing backgrounds or thumbnailsBg directory for a user, skipping.');
            continue;
        }
        if (!fs.existsSync(directories.backgrounds)) {
            console.warn(`[ensureThumbnailCache] Backgrounds directory ${directories.backgrounds} does not exist, skipping.`);
            continue;
        }
        if (!fs.existsSync(directories.thumbnailsBg)) {
            try {
                fs.mkdirSync(directories.thumbnailsBg, { recursive: true });
                console.info(`[ensureThumbnailCache] Created thumbnailsBg directory: ${directories.thumbnailsBg}`);
            } catch (e) {
                console.error(`[ensureThumbnailCache] Failed to create thumbnailsBg directory ${directories.thumbnailsBg}: ${e.message}. Skipping this directory.`);
                continue;
            }
        }

        // Path for metadata files is now directories.root
        const aspectRatiosJsonPath = path.join(directories.root, 'aspect_ratios.json');
        // const versionFilePath = path.join(directories.root, 'aspect_metadata_version.txt'); // Removed

        let existingAspectRatios = {};
        let detectedVersion = null;
        let needsFullRegeneration = false;
        let madeChangesToJSON = false; // Keep this flag

        if (fs.existsSync(aspectRatiosJsonPath)) {
            try {
                const fileContent = fs.readFileSync(aspectRatiosJsonPath, 'utf-8');
                const jsonData = JSON.parse(fileContent);
                detectedVersion = jsonData._metadata_version || null; // Get version from JSON
                delete jsonData._metadata_version; // Remove metadata version for aspect ratio processing
                existingAspectRatios = jsonData;
            } catch (e) {
                console.warn(`[ensureThumbnailCache] Could not parse aspect_ratios.json for ${directories.root}, triggering full regeneration. Error: ${e.message}`);
                needsFullRegeneration = true;
                existingAspectRatios = {};
            }
        } else {
            // If aspectRatiosJsonPath does not exist, it's effectively a version mismatch or first run.
            needsFullRegeneration = true;
        }

        if (!needsFullRegeneration && detectedVersion !== currentMetadataVersion) {
            console.info(`[ensureThumbnailCache] Metadata version mismatch (file: ${detectedVersion}, current: ${currentMetadataVersion}) for ${directories.root}. Triggering full regeneration.`);
            needsFullRegeneration = true;
            existingAspectRatios = {}; // Clear out old data
        }

        if (needsFullRegeneration) {
            madeChangesToJSON = true; // Will write a new JSON

            // Delete all existing image thumbnails (not metadata files)
            const filesInThumbnailsBg = fs.readdirSync(directories.thumbnailsBg);
            for (const fileInThumbnailsBg of filesInThumbnailsBg) {
                if (fileInThumbnailsBg !== 'aspect_ratios.json' && fileInThumbnailsBg !== 'aspect_metadata_version.txt') {
                    const fullPath = path.join(directories.thumbnailsBg, fileInThumbnailsBg);
                    if (fs.statSync(fullPath).isFile()) {
                        try { fs.unlinkSync(fullPath); } catch (e) { console.warn(`[ensureThumbnailCache] Could not delete old thumbnail ${fileInThumbnailsBg}:`, e); }
                    }
                }
            }
            // ... (rest of existing full regeneration logic for deleting image thumbnails) ...
            // Delete old aspect_ratios.json if it was corrupt and led here through the catch block for parsing
            if (fs.existsSync(aspectRatiosJsonPath)) {
                 try { fs.unlinkSync(aspectRatiosJsonPath); } catch (e) { console.warn('[ensureThumbnailCache] Could not delete existing aspect_ratios.json during full regen:', e); }
            }
        }
        // The logic for `else { try { existingAspectRatios = JSON.parse(...) } catch ... }` that was there before is now covered above.

        const allEntriesInBgDir = fs.readdirSync(directories.backgrounds);
        const bgFiles = []; // This will store only valid image files
        const PLAUSIBLE_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.apng', '.tiff'];

        for (const entryName of allEntriesInBgDir) {
            const fullPathToEntry = path.join(directories.backgrounds, entryName);
            try {
                if (!fs.statSync(fullPathToEntry).isFile()) {
                    continue; // Skip directories
                }
                const fileExtension = path.extname(entryName).toLowerCase();
                if (!PLAUSIBLE_IMAGE_EXTENSIONS.includes(fileExtension)) {
                    continue; // Skip non-plausible image files
                }
                bgFiles.push(entryName); // Add valid image file to the list for processing
            } catch (statError) {
                // Optional: console.error(`[ensureThumbnailCache] Error stating file or directory ${fullPathToEntry}: ${statError.message}. Skipping.`);
                continue;
            }
        }
        // Now, bgFiles contains only actual image files.

        const bgFileSet = new Set(bgFiles); // For efficient lookup of existing background files
        let currentAspectRatios = { ...existingAspectRatios };
        const tasks = [];

        // Process current background files: add new ones, update changed ones
        for (const file of bgFiles) { // Iterate over pre-filtered bgFiles
            const pathToOriginalFile = path.join(directories.backgrounds, file);
            const pathToCachedFile = path.join(directories.thumbnailsBg, file);
            let fileNeedsProcessing = false;

            if (needsFullRegeneration) {
                fileNeedsProcessing = true;
            } else {
                // Since we've filtered for files, statSync should be safe.
                // Error handling for statSync can be added if needed, but the outer try-catch for the loop might cover it.
                const originalStat = fs.statSync(pathToOriginalFile);
                if (!currentAspectRatios.hasOwnProperty(file)) {
                    fileNeedsProcessing = true;
                } else if (!fs.existsSync(pathToCachedFile)) {
                    fileNeedsProcessing = true;
                } else {
                    const cachedStat = fs.statSync(pathToCachedFile);
                    if (originalStat.mtimeMs > cachedStat.mtimeMs) {
                        fileNeedsProcessing = true;
                    }
                }
            }

            if (fileNeedsProcessing) {
                tasks.push(
                    generateThumbnail(directories, 'bg', file).then(result => {
                        if (result && result.path && result.aspectRatio !== undefined) { // Check for aspectRatio property
                            if (currentAspectRatios[file] !== result.aspectRatio) { // Compare numerical aspect ratios
                                madeChangesToJSON = true;
                            }
                            currentAspectRatios[file] = result.aspectRatio; // Assign numerical aspect ratio
                        } else { // generateThumbnail returned null or aspectRatio was missing
                            if (currentAspectRatios.hasOwnProperty(file)) {
                                delete currentAspectRatios[file];
                                madeChangesToJSON = true;
                            }
                            // If it's a new file that couldn't be processed, it's just not added.
                        }
                    })
                );
            }
            // If !fileNeedsProcessing, the entry from existingAspectRatios is kept in currentAspectRatios implicitly.
        }

        await Promise.all(tasks);

        // Process deletions: remove entries from currentAspectRatios if original file is gone
        if (!needsFullRegeneration) { // No need to check deletions if we started from scratch
            for (const existingFileInJson in currentAspectRatios) {
                if (!bgFileSet.has(existingFileInJson)) {
                    console.info(`[ensureThumbnailCache] Original file ${existingFileInJson} deleted. Removing from aspect ratios and deleting its thumbnail.`);
                    delete currentAspectRatios[existingFileInJson];
                    madeChangesToJSON = true;
                    const pathToStaleThumbnail = path.join(directories.thumbnailsBg, existingFileInJson);
                    if (fs.existsSync(pathToStaleThumbnail)) {
                        try { fs.unlinkSync(pathToStaleThumbnail); } catch (e) { console.warn(`[ensureThumbnailCache] Could not delete stale thumbnail ${pathToStaleThumbnail}: ${e.message}`); }
                    }
                }
            }
        }

        if (madeChangesToJSON) {
            try {
                const dataToWrite = { ...currentAspectRatios }; // currentAspectRatios is populated by generateThumbnail results
                dataToWrite._metadata_version = currentMetadataVersion;
                // Now write dataToWrite instead of currentAspectRatios
                writeFileAtomicSyncDirect(aspectRatiosJsonPath, JSON.stringify(dataToWrite, null, 2));
                // fs.writeFileSync(versionFilePath, currentMetadataVersion); // Removed
                console.info(`[ensureThumbnailCache] Aspect ratio data (including version ${currentMetadataVersion}) updated in aspect_ratios.json for ${directories.root}. Processed ${tasks.length} files that needed updates/generation.`);
            } catch (e) {
                console.error(`[ensureThumbnailCache] Failed to write aspect_ratios.json for ${directories.root}: ${e.message}`);
            }
        } else {
            console.info(`[ensureThumbnailCache] Aspect ratio data is up-to-date for ${directories.root}.`);
        }
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

        const thumbnailResult = await generateThumbnail(request.user.directories, type, file);
        const pathToCachedFile = thumbnailResult ? thumbnailResult.path : null;

        if (!pathToCachedFile) {
            return response.sendStatus(404);
        }

        if (!fs.existsSync(pathToCachedFile)) {
            // Keeping a minimal error log here if the file is still not found after generation attempt.
            console.error(`[/thumbnail route] File NOT FOUND at an expected cached path: ${pathToCachedFile} for type: ${type}, file: ${file}`);
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
