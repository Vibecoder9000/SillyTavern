import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import writeFileAtomic from 'write-file-atomic';
import { getAverageColor } from 'fast-average-color-node';

import { MEDIA_EXTENSIONS } from '../constants.js';

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
        };
    } catch (error) {
        console.error(`[Metadata Gen] Failed to process file ${path.basename(filePath)}:`, error.message);
        return null;
    }
}

/**
 * Synchronizes the backgrounds.json metadata file with the files on disk.
 * It adds new files, removes deleted ones, and generates necessary metadata.
 * @param {import('../users.js').UserDirectoryList} userDirectories The directories for a single user.
 */
export async function syncBackgroundsMetadata(userDirectories) {
    const backgroundsJsonPath = path.join(userDirectories.root, 'backgrounds.json');
    const backgroundsFolderPath = userDirectories.backgrounds;

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
        const supportedExtensions = new Set(MEDIA_EXTENSIONS);

        imageFilesOnDisk = allFilesOnDisk.filter(filename => {
            const ext = path.extname(filename).substring(1).toLowerCase();
            return supportedExtensions.has(ext);
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

    // Find and process new files
    for (const filename of imageFilesOnDisk) {
        if (!metadata.images[filename]) {
            const filePath = path.join(backgroundsFolderPath, filename);
            const newMetadata = await generateSingleFileMetadata(filePath);

            if (newMetadata) {
                metadata.images[filename] = newMetadata;
                hasChanges = true;
                newFiles++;
            }
        }
    }

    // Find and remove deleted files
    for (const filename of metadataImageKeys) {
        if (!filesOnDiskSet.has(filename)) {
            delete metadata.images[filename];
            hasChanges = true;
            deletedFiles++;
        }
    }

    // Save the updated metadata and log a summary if changes were made
    if (hasChanges) {
        console.log(`[Background Sync] Found ${newFiles} new and ${deletedFiles} deleted backgrounds. Saving changes...`);
        try {
            const jsonString = JSON.stringify(metadata, null, 4);
            await writeFileAtomic(backgroundsJsonPath, jsonString, 'utf8');
        } catch (error) {
            console.error('[Background Sync] Failed to save backgrounds.json:', error);
        }
    }
}
