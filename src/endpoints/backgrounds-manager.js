import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import writeFileAtomic from 'write-file-atomic';
import { Jimp } from '../jimp.js';
import { invalidateThumbnail, generateThumbnail, SKIPPED_EXTENSIONS, ALLOWED_IMAGE_EXTENSIONS } from './thumbnails.js';
import { getConfigValue } from '../util.js';
import pLimit from 'p-limit';

const CONCURRENCY_LIMIT = 10;
export const BACKGROUNDS_METADATA_FILE = 'index.json';

/**
 * @typedef {Object} BackgroundImageMetadata
 * @property {string} hash - SHA-256 hash of the image file.
 * @property {number} aspectRatio - Aspect ratio (width / height) of the image.
 * @property {boolean} isAnimated - Whether the image is animated.
 * @property {string} dominantColor - Dominant color in hex format (e.g., '#RRGGBB').
 * @property {string[]} tags - Array of tags associated with the image.
 * @property {string[]} folderIds - Array of folder IDs the image belongs to.
 * @property {number} addedTimestamp - Timestamp when the image was added.
 * @property {number} [thumbnailResolution] - Optional thumbnail resolution (width * height).
 */

/**
 * @typedef {Object} BackgroundsMetadata
 * @property {number} version - Metadata version.
 * @property {Object.<string, BackgroundImageMetadata>} images - Mapping of filenames to their metadata.
 * @property {string[]} folders - Array of folder IDs.
 * @property {string[]} tags - Array of tags.
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
    return buffer.subarray(0, 100).includes('acTL');
}

/**
 * Checks if a WebP buffer is animated by looking for 'ANIM' or 'ANMF' chunks.
 * @param {Buffer} buffer The WebP file buffer (can be full file or header)
 * @returns {boolean} True if the WebP is animated
 */
export function isAnimatedWebP(buffer) {
    // Read a small portion of the buffer to check for animation indicators efficiently
    const headerBuffer = buffer.length > 200 ? buffer.subarray(0, 200) : buffer;
    return headerBuffer.includes('ANIM') || headerBuffer.includes('ANMF');
}

/**
 * Determines if a file should skip server-side thumbnail generation.
 * @param {string} filename - The filename to check.
 * @param {object} [imageMeta] - Optional metadata for the image.
 * @returns {boolean} True if thumbnail generation should be skipped.
 */
function shouldSkipServerThumbnailGeneration(filename, imageMeta) {
    const fileExtension = path.extname(filename).toLowerCase();
    return SKIPPED_EXTENSIONS.has(fileExtension) ||
           (imageMeta?.isAnimated) ||
           ((fileExtension === '.png' || fileExtension === '.webp') && !imageMeta?.thumbnailResolution);
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

        // Get the color of the single pixel as a 32-bit integer
        const colorInt = image.getPixelColor(0, 0);

        // Convert the integer to RGBA using bitwise operators.
        const r = (colorInt >> 24) & 255;
        const g = (colorInt >> 16) & 255;
        const b = (colorInt >> 8) & 255;

        // Format as a hex string
        const toHex = (c) => c.toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    } catch (error) {
        console.error('[Jimp] Failed to calculate average color:', error);
        return '#808080';
    }
}

/**
 * Generates all necessary metadata for a single background file.
 * @param {string} filePath - The full path to the background file.
 * @returns {Promise<BackgroundImageMetadata>} A metadata object. Throws an error if processing fails.
 */
export async function generateSingleFileMetadata(filePath) {
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
            isAnimated = true; // GIFs are treated as animated.
            break;
        case 'png':
            isAnimated = isAnimatedApng(buffer);
            break;
        case 'webp':
            // Check for 'ANIM' or 'ANMF' chunks in the header for animated WebP.
            isAnimated = isAnimatedWebP(buffer);
            break;
        default:
            isAnimated = false;
    }

    let hexColor;
    if (isAnimated) {
        hexColor = '#808080';
    } else {
        // Only process non-animated images to avoid decoding errors.
        hexColor = await getAverageColorWithJimp(buffer);
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
        dominantColor: hexColor,
        tags: [],
        folderIds: [],
        addedTimestamp,
    };
}

/**
 * A utility function to purge the entire thumbnail cache directory.
 * @param {string} thumbnailsBgPath - The path to the background thumbnails directory.
 */
async function purgeThumbnailCache(thumbnailsBgPath) {
    // Check if the directory exists.
    const directoryExists = await fs.stat(thumbnailsBgPath).then(stats => stats.isDirectory()).catch(() => false);

    if (!directoryExists) {
        return;
    }

    try {
        const thumbFiles = await fs.readdir(thumbnailsBgPath);
        if (thumbFiles.length > 0) {
            console.log(`[Background Sync] Purging ${thumbFiles.length} old thumbnails from cache...`);
            for (const file of thumbFiles) {
                await fs.unlink(path.join(thumbnailsBgPath, file));
            }
        }
    } catch (e) {
        console.error('[Background Sync] Failed to purge thumbnail cache:', e);
    }
}

/**
 * Synchronizes the backgrounds metadata file with the files on disk for all users.
 * @param {import('../users.js').UserDirectoryList[]} directoriesList List of user directories.
 */
export async function syncBackgroundsMetadata(directoriesList) {
    for (const userDirectories of directoriesList) {
        try {
            const backgroundsJsonPath = path.join(userDirectories.backgrounds, BACKGROUNDS_METADATA_FILE);
            const backgroundsFolderPath = userDirectories.backgrounds;
            const thumbnailsBgPath = userDirectories.thumbnailsBg;
            const currentResolution = getBackgroundThumbnailResolution();

            let metadata;
            let migrationTriggeredByFileIssues = false;

            try {
                const rawData = await fs.readFile(backgroundsJsonPath, 'utf8');
                metadata = JSON.parse(rawData);

                for (const [filename, img] of Object.entries(metadata.images)) {
                    if (!img.thumbnailResolution && !shouldSkipServerThumbnailGeneration(filename, img)) {
                        migrationTriggeredByFileIssues = true;
                        break;
                    }
                }

                if (migrationTriggeredByFileIssues) {
                    await purgeThumbnailCache(thumbnailsBgPath);
                    for (const key in metadata.images) {
                        if (metadata.images[key].thumbnailResolution) {
                            delete metadata.images[key].thumbnailResolution;
                        }
                    }
                }
            } catch (error) {
                await purgeThumbnailCache(thumbnailsBgPath);
                metadata = { version: 1, images: {}, folders: [], tags: [] };
            }

            let imageFilesOnDisk;
            try {
                const allFilesOnDisk = await fs.readdir(backgroundsFolderPath);
                imageFilesOnDisk = allFilesOnDisk.filter(filename => {
                    const ext = path.extname(filename).toLowerCase();
                    return ALLOWED_IMAGE_EXTENSIONS.has(ext);
                });
            } catch (error) {
                console.error(`Could not read backgrounds directory for user at ${userDirectories.root}. Aborting sync.`, error);
                return;
            }

            const filesOnDiskSet = new Set(imageFilesOnDisk);
            const metadataImageKeys = Object.keys(metadata.images);
            const filesToProcess = [];
            let hasResolutionChanges = false;

            // Process resolution mismatches and invalidate thumbnails in a single pass
            for (const filename of metadataImageKeys) {
                const imageMeta = metadata.images[filename];
                if (imageMeta?.thumbnailResolution && imageMeta.thumbnailResolution !== currentResolution) {
                    invalidateThumbnail(userDirectories, 'bg', filename);
                    delete metadata.images[filename].thumbnailResolution;
                    hasResolutionChanges = true;
                }
            }

            for (const filename of imageFilesOnDisk) {
                const imageMeta = metadata.images[filename];
                const isNew = !imageMeta;

                const needsUpdate = imageMeta && (
                    imageMeta.addedTimestamp === undefined ||
                (imageMeta.thumbnailResolution === undefined && !shouldSkipServerThumbnailGeneration(filename, imageMeta))
                );

                if (isNew || (needsUpdate && !shouldSkipServerThumbnailGeneration(filename, imageMeta))) {
                    filesToProcess.push(filename);
                }
            }

            const filesToDelete = metadataImageKeys.filter(filename => !filesOnDiskSet.has(filename));
            const hasChanges = filesToProcess.length > 0 || filesToDelete.length > 0 || hasResolutionChanges;

            if (!hasChanges) {
                return;
            }

            if (filesToProcess.length > 0) {
                const limit = pLimit(CONCURRENCY_LIMIT);

                const tasks = filesToProcess.map(filename => limit(async () => {
                    const filePath = path.join(backgroundsFolderPath, filename);
                    let updatePayload = {};
                    let currentImageMeta = metadata.images[filename];

                    const forceMetadataRegen =
                    !currentImageMeta ||
                    currentImageMeta.isAnimated === undefined;

                    if (forceMetadataRegen) {
                        const newMetadata = await generateSingleFileMetadata(filePath);
                        if (newMetadata) {
                            updatePayload.newMetadata = newMetadata;
                            currentImageMeta = { ...currentImageMeta, ...newMetadata };
                        }
                    } else if (currentImageMeta.addedTimestamp === undefined) {
                        try {
                            const stats = await fs.stat(filePath);
                            updatePayload.addedTimestamp = Math.floor(stats.birthtimeMs || stats.mtimeMs);
                        } catch {
                            updatePayload.addedTimestamp = Date.now();
                        }
                    }

                    if (currentImageMeta && currentImageMeta.thumbnailResolution === undefined && !shouldSkipServerThumbnailGeneration(filename, currentImageMeta)) {
                        const thumbResult = await generateThumbnail(userDirectories, 'bg', filename, false, currentImageMeta.isAnimated);
                        if (thumbResult.path && thumbResult.resolution) {
                            updatePayload.thumbnailResolution = thumbResult.resolution;
                        }
                    }
                    return { filename, ...updatePayload };
                }));

                const results = await Promise.allSettled(tasks);

                results.forEach(result => {
                    if (result.status === 'fulfilled' && result.value) {
                        const { filename, newMetadata, addedTimestamp, thumbnailResolution } = result.value;
                        if (newMetadata) {
                            metadata.images[filename] = newMetadata;
                        }
                        if (metadata.images[filename]) {
                            if (addedTimestamp) {
                                metadata.images[filename].addedTimestamp = addedTimestamp;
                            }
                            if (thumbnailResolution) {
                                metadata.images[filename].thumbnailResolution = thumbnailResolution;
                            }
                        }
                    }
                });
            }


            if (filesToDelete.length > 0) {
                for (const filename of filesToDelete) {
                    delete metadata.images[filename];
                }
            }

            const jsonString = JSON.stringify(metadata, null, 4);
            await writeFileAtomic(backgroundsJsonPath, jsonString, 'utf8');

        } catch (error) {
            console.error(`[Background Sync] An error occurred during synchronization for ${userDirectories.root}:`, error);
        }
    }
}
