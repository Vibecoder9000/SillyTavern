import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import writeFileAtomic from 'write-file-atomic';
import { getAverageColor } from 'fast-average-color-node';
import { invalidateThumbnail, generateThumbnail } from './thumbnails.js';
import { getConfigValue } from '../util.js';

/**
 * Checks if a buffer contains an animated WebP by looking for the 'ANIM' chunk.
 * @param {Buffer} buffer The file buffer.
 * @returns {boolean}
 */
function isAnimatedWebP(buffer) {
    const webpHeader = buffer.toString('ascii', 8, 12);
    if (webpHeader !== 'WEBP') return false;
    return buffer.subarray(0, 100).includes('ANIM');
}

/**
 * Checks if a buffer contains an animated PNG (APNG) by looking for the 'acTL' chunk.
 * @param {Buffer} buffer The file buffer.
 * @returns {boolean}
 */
function isAnimatedApng(buffer) {
    return buffer.subarray(0, 100).includes('acTL');
}

/**
 * Generates all necessary metadata for a single background file.
 * @param {string} filePath - The full path to the background file.
 * @returns {Promise<object|null>} A metadata object or null if processing fails.
 */
export async function generateSingleFileMetadata(filePath) {
    try {
        const buffer = await fs.readFile(filePath);

        const hash = crypto.createHash('sha256').update(buffer).digest('hex');

        const dimensions = imageSize(buffer);
        if (!dimensions || !dimensions.width || !dimensions.height) {
            throw new Error('Could not determine image dimensions.');
        }
        const aspectRatio = dimensions.width / dimensions.height;

        let isAnimated = false;
        switch (dimensions.type) {
            case 'gif':
                isAnimated = dimensions.images && dimensions.images > 1;
                break;
            case 'png':
                isAnimated = isAnimatedApng(buffer);
                break;
            case 'webp':
                isAnimated = isAnimatedWebP(buffer);
                break;
            default:
                isAnimated = false;
        }

        const color = await getAverageColor(buffer);
        const hexColor = color.hex;

        return {
            hash,
            aspectRatio: parseFloat(aspectRatio.toFixed(4)),
            isAnimated,
            dominantColor: hexColor,
            isStarred: false,
            tags: [],
            folderIds: [],
            lastUsedTimestamp: null,
            addedTimestamp: Date.now(),
        };
    } catch (error) {
        if (error.code === 'ENAMETOOLONG') {
            console.log(`Too long filename:\n${path.basename(filePath)}`);
        }
        return null;
    }
}

/**
 * Synchronizes the backgrounds.json metadata file with the files on disk.
 * It adds new files, removes deleted ones, and regenerates thumbnails if the configured resolution has changed.
 * This function performs a one-time check at startup and logs only a summary of changes made.
 * @param {import('../users.js').UserDirectoryList} userDirectories The directories for a single user.
 */
export async function syncBackgroundsMetadata(userDirectories) {
    const backgroundsJsonPath = path.join(userDirectories.root, 'backgrounds.json');
    const backgroundsFolderPath = userDirectories.backgrounds;

    const VIDEO_EXTENSIONS = ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', '3gp', 'mkv', 'mpg'];

    const currentResolution = getConfigValue('thumbnails.resolution', 15000);

    let metadata;
    try {
        const rawData = await fs.readFile(backgroundsJsonPath, 'utf8');
        metadata = JSON.parse(rawData);
    } catch (error) {
        console.warn('Processing Backgrounds...');
        metadata = { version: 1, images: {}, folders: [], tags: [] };
    }

    let imageFilesOnDisk;
    try {
        const allFilesOnDisk = await fs.readdir(backgroundsFolderPath);
        // Create a set of video extensions to easily check against
        const videoExtensions = new Set(VIDEO_EXTENSIONS);
        imageFilesOnDisk = allFilesOnDisk.filter(filename => {
            const ext = path.extname(filename).substring(1).toLowerCase();
            // Process the file only if its extension is not in the list
            return !videoExtensions.has(ext);
        });
    } catch (error) {
        console.error(`Could not read backgrounds directory for user at ${userDirectories.root}. Aborting sync.`, error);
        return;
    }

    const filesOnDiskSet = new Set(imageFilesOnDisk);
    const metadataImageKeys = Object.keys(metadata.images);
    let hasChanges = false;
    let newFiles = 0;
    let deletedFiles = 0;
    let updatedFiles = 0;
    let regeneratedThumbs = 0;

    // Invalidate and remove thumbnails with outdated resolution
    for (const filename of metadataImageKeys) {
        const imageMeta = metadata.images[filename];
        const storedResolution = imageMeta.thumbnailResolution;

        if (storedResolution && storedResolution !== currentResolution) {
            invalidateThumbnail(userDirectories, 'bg', filename);
            delete imageMeta.thumbnailResolution;
            regeneratedThumbs++;
            hasChanges = true;
        }
    }

    if (regeneratedThumbs > 0) {
        console.log(`[Background Sync] Invalidated ${regeneratedThumbs} outdated thumbnails that will be regenerated.`);
    }

    // Process new files and regenerate invalidated thumbnails
    for (const filename of imageFilesOnDisk) {
        const filePath = path.join(backgroundsFolderPath, filename);

        if (!metadata.images[filename]) {
            const newMetadata = await generateSingleFileMetadata(filePath);
            if (newMetadata) {
                metadata.images[filename] = newMetadata;
                hasChanges = true;
                newFiles++;
            }
        }
        else if (metadata.images[filename].addedTimestamp === undefined) {
            try {
                const stats = await fs.stat(filePath);
                metadata.images[filename].addedTimestamp = Math.floor(stats.birthtimeMs || stats.mtimeMs);
                hasChanges = true;
                updatedFiles++;
            } catch (err) {
                console.warn(`[Background Sync] Could not stat file ${filename} to add timestamp, assigning current time.`, err);
                metadata.images[filename].addedTimestamp = Date.now();
            }
        }

        if (metadata.images[filename] && metadata.images[filename].thumbnailResolution === undefined) {
            // Do not force thumbnail generation unless necessary
            const thumbResult = await generateThumbnail(userDirectories, 'bg', filename, false, false);
            if (thumbResult.path && thumbResult.resolution) {
                metadata.images[filename].thumbnailResolution = thumbResult.resolution;
                hasChanges = true;
            }
        }
    }

    // Find and remove files from metadata that are no longer on disk
    for (const filename of metadataImageKeys) {
        if (!filesOnDiskSet.has(filename)) {
            delete metadata.images[filename];
            hasChanges = true;
            deletedFiles++;
        }
    }

    // Save and log the final results
    if (hasChanges) {
        const logParts = [];
        if (newFiles > 0) logParts.push(`found ${newFiles} new`);
        if (deletedFiles > 0) logParts.push(`removed ${deletedFiles} deleted`);
        if (updatedFiles > 0) logParts.push(`updated ${updatedFiles} existing`);
        if (logParts.length > 0) {
            console.log(`[Background Sync] ${logParts.join(', ')}. Saving changes to backgrounds.json...`);
            try {
                const jsonString = JSON.stringify(metadata, null, 4);
                await writeFileAtomic(backgroundsJsonPath, jsonString, 'utf8');
            } catch (error) {
                console.error('[Background Sync] Failed to save backgrounds.json:', error);
            }
        }
    }
}
