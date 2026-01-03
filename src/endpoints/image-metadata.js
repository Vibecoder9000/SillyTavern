/**
 * Generic image metadata service.
 * Provides on-demand metadata generation with file mtime-based caching.
 * Can be used for backgrounds, character images, gallery items, etc.
 */

import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import writeFileAtomic from 'write-file-atomic';
import { Jimp } from '../jimp.js';
import { getConfigValue } from '../util.js';

export const METADATA_FILE = 'image-metadata.json';

/**
 * @typedef {Object} ImageMetadata
 * @property {string} hash - SHA-256 hash of the image file.
 * @property {number} aspectRatio - Aspect ratio (width / height) of the image.
 * @property {boolean} isAnimated - Whether the image is animated.
 * @property {string} dominantColor - Dominant color in hex format (e.g., '#RRGGBB').
 * @property {string[]} folderIds - Array of virtual folder IDs the image belongs to.
 * @property {number} addedTimestamp - Timestamp when the image was added.
 * @property {number} thumbnailResolution - Thumbnail resolution (width * height) for cache invalidation.
 * @property {number} [mtime] - File modification time for cache invalidation (internal use).
 */

/**
 * @typedef {Object} MetadataIndex
 * @property {number} version - Metadata version.
 * @property {Object.<string, ImageMetadata>} images - Mapping of filenames to their metadata.
 * @property {Array<{id: string, name: string, thumbnailFile: string}>} folders - Virtual folders.
 */

/**
 * Gets the configured background thumbnail resolution.
 * @returns {number} Thumbnail resolution (width * height)
 */
export function getBackgroundThumbnailResolution() {
    const dimensions = getConfigValue('thumbnails.dimensions.bg', [160, 90]);
    if (Array.isArray(dimensions) && dimensions.length >= 2) {
        return Number(dimensions[0]) * Number(dimensions[1]);
    }
    return 160 * 90;
}

/**
 * Checks if a buffer contains an animated PNG (APNG) by looking for the 'acTL' chunk.
 * @param {Buffer} buffer The file buffer.
 * @returns {boolean}
 */
function isAnimatedApng(buffer) {
    return buffer.subarray(0, 200).includes('acTL');
}

/**
 * Checks if a WebP buffer is animated by looking for 'ANIM' or 'ANMF' chunks.
 * @param {Buffer} buffer The WebP file buffer (can be full file or header)
 * @returns {boolean} True if the WebP is animated
 */
export function isAnimatedWebP(buffer) {
    const headerBuffer = buffer.length > 200 ? buffer.subarray(0, 200) : buffer;
    return headerBuffer.includes('ANIM') || headerBuffer.includes('ANMF');
}

/**
 * Calculate average color using Jimp.
 * Resizes the image to 1x1 to efficiently get the average color.
 * @param {Buffer} buffer The image buffer.
 * @returns {Promise<string>} The average color as a hex string (e.g., '#RRGGBB').
 */
async function getAverageColorWithJimp(buffer) {
    try {
        const image = await Jimp.read(buffer);
        image.resize({ w: 1, h: 1 });

        const colorInt = image.getPixelColor(0, 0);
        const r = (colorInt >> 24) & 255;
        const g = (colorInt >> 16) & 255;
        const b = (colorInt >> 8) & 255;

        const toHex = (c) => c.toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    } catch (error) {
        console.warn('[Jimp] Failed to calculate average color:', error.message);
        return '#808080';
    }
}

/**
 * Generates metadata for a single image file.
 * @param {string} filePath - The full path to the image file.
 * @returns {Promise<ImageMetadata>} A metadata object. Throws an error if processing fails.
 */
export async function generateImageMetadata(filePath) {
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
            isAnimated = true;
            break;
        case 'png':
            isAnimated = isAnimatedApng(buffer);
            break;
        case 'webp':
            isAnimated = isAnimatedWebP(buffer);
            break;
    }

    let dominantColor;
    if (isAnimated) {
        dominantColor = '#808080';
    } else {
        dominantColor = await getAverageColorWithJimp(buffer);
    }

    let addedTimestamp;
    try {
        const stats = await fs.stat(filePath);
        addedTimestamp = Math.floor(stats.birthtimeMs || stats.mtimeMs);
    } catch {
        addedTimestamp = Date.now();
    }

    return {
        hash,
        aspectRatio: parseFloat(aspectRatio.toFixed(4)),
        isAnimated,
        dominantColor,
        folderIds: [],
        addedTimestamp,
        thumbnailResolution: getBackgroundThumbnailResolution(),
    };
}

/**
 * Reads the metadata index from a folder.
 * @param {string} folderPath - Path to the folder containing index.json
 * @returns {Promise<MetadataIndex>} The metadata index
 */
export async function readMetadataIndex(folderPath) {
    const indexPath = path.join(folderPath, METADATA_FILE);
    try {
        const rawData = await fs.readFile(indexPath, 'utf8');
        return JSON.parse(rawData);
    } catch {
        return { version: 1, images: {}, folders: [] };
    }
}

/**
 * Writes the metadata index to a folder.
 * @param {string} folderPath - Path to the folder containing index.json
 * @param {MetadataIndex} metadata - The metadata to write
 */
export async function writeMetadataIndex(folderPath, metadata) {
    const indexPath = path.join(folderPath, METADATA_FILE);
    const jsonString = JSON.stringify(metadata, null, 4);
    await writeFileAtomic(indexPath, jsonString, 'utf8');
}

/**
 * Gets metadata for an image, generating it on-demand if needed.
 * Uses file mtime for cache invalidation.
 * @param {string} folderPath - Path to the folder containing the image and index.json
 * @param {string} filename - The image filename
 * @returns {Promise<ImageMetadata|null>} The metadata, or null if file doesn't exist
 */
export async function getOrGenerateMetadata(folderPath, filename) {
    const results = await getOrGenerateMetadataBatch(folderPath, [filename]);
    return results[filename] || null;
}

/**
 * Gets metadata for multiple images, generating on-demand as needed.
 * @param {string} folderPath - Path to the folder containing images and index.json
 * @param {string[]} filenames - Array of image filenames
 * @returns {Promise<Object.<string, ImageMetadata>>} Map of filename to metadata
 */
export async function getOrGenerateMetadataBatch(folderPath, filenames) {
    const results = {};
    const index = await readMetadataIndex(folderPath);
    let indexModified = false;

    for (const filename of filenames) {
        const filePath = path.join(folderPath, filename);

        let stats;
        try {
            stats = await fs.stat(filePath);
        } catch {
            continue; // File doesn't exist, skip
        }

        const currentMtime = stats.mtimeMs;
        const cached = index.images[filename];

        // If cached and not modified, use cached
        if (cached && cached.mtime === currentMtime) {
            results[filename] = cached;
            continue;
        }

        // Generate new metadata
        try {
            const metadata = await generateImageMetadata(filePath);
            metadata.mtime = currentMtime;

            // Preserve folderIds if they existed
            if (cached?.folderIds) {
                metadata.folderIds = cached.folderIds;
            }

            index.images[filename] = metadata;
            results[filename] = metadata;
            indexModified = true;
        } catch (error) {
            console.warn(`[ImageMetadata] Failed to generate metadata for ${filename}:`, error.message);
        }
    }

    // Clean up orphaned metadata entries
    const filesOnDisk = new Set(filenames);
    for (const cachedFilename of Object.keys(index.images)) {
        if (!filesOnDisk.has(cachedFilename)) {
            delete index.images[cachedFilename];
            indexModified = true;
        }
    }

    // Write index if modified
    if (indexModified) {
        await writeMetadataIndex(folderPath, index);
    }

    return results;
}

/**
 * Removes metadata for an image from the index.
 * @param {string} folderPath - Path to the folder containing index.json
 * @param {string} filename - The image filename to remove
 */
export async function removeMetadata(folderPath, filename) {
    const index = await readMetadataIndex(folderPath);
    if (index.images[filename]) {
        delete index.images[filename];
        await writeMetadataIndex(folderPath, index);
    }
}

/**
 * Updates metadata for an image (e.g., after rename).
 * @param {string} folderPath - Path to the folder containing index.json
 * @param {string} oldFilename - The old filename
 * @param {string} newFilename - The new filename
 * @returns {Promise<ImageMetadata|null>} The updated metadata
 */
export async function renameMetadata(folderPath, oldFilename, newFilename) {
    const index = await readMetadataIndex(folderPath);
    const data = index.images[oldFilename];

    if (!data) {
        throw new Error(`Image '${oldFilename}' not found in metadata.`);
    }

    delete index.images[oldFilename];
    index.images[newFilename] = data;
    await writeMetadataIndex(folderPath, index);

    return data;
}
