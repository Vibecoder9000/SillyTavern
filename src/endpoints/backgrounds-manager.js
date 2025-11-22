import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import writeFileAtomic from 'write-file-atomic';
import { Jimp } from '../jimp.js';
import { invalidateThumbnail, generateThumbnail, SKIPPED_EXTENSIONS_FOR_JIMP } from './thumbnails.js';
import { getThumbnailResolution } from '../util.js';

const CONCURRENCY_LIMIT = 10;

/**
 * Checks if a buffer contains an animated PNG (APNG) by looking for the 'acTL' chunk.
 * @param {Buffer} buffer The file buffer.
 * @returns {boolean}
 */
function isAnimatedApng(buffer) {
    return buffer.subarray(0, 100).includes('acTL');
}

/**
 * Determines if a file should skip server-side thumbnail generation.
 * @param {string} filename - The filename to check.
 * @param {object} [imageMeta] - Optional metadata for the image.
 * @returns {boolean} True if thumbnail generation should be skipped.
 */
function shouldSkipServerThumbnailGeneration(filename, imageMeta) {
    const fileExtension = path.extname(filename).toLowerCase();
    return SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension) ||
           (imageMeta && imageMeta.isAnimated) ||
           ((fileExtension === '.png' || fileExtension === '.webp') && imageMeta && !imageMeta.thumbnailResolution);
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
 * @returns {Promise<object>} A metadata object. Throws an error if processing fails.
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

    // Read a small portion of the buffer to check for animation indicators efficiently.
    const headerBuffer = buffer.length > 200 ? buffer.subarray(0, 200) : buffer;

    switch (dimensions.type) {
        case 'gif':
            isAnimated = true; // GIFs are treated as animated.
            break;
        case 'png':
            isAnimated = isAnimatedApng(buffer);
            break;
        case 'webp':
            // Check for 'ANIM' or 'ANMF' chunks in the header for animated WebP.
            isAnimated = headerBuffer.includes('ANIM') || headerBuffer.includes('ANMF');
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

    return {
        hash,
        aspectRatio: parseFloat(aspectRatio.toFixed(4)),
        isAnimated,
        dominantColor: hexColor,
        tags: [],
        folderIds: [],
        addedTimestamp: Date.now(),
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
 * Synchronizes the backgrounds.json metadata file with the files on disk.
 * @param {import('../users.js').UserDirectoryList} userDirectories The directories for a single user.
 */
export async function syncBackgroundsMetadata(userDirectories) {
    try {
        const backgroundsJsonPath = path.join(userDirectories.root, 'backgrounds.json');
        const backgroundsFolderPath = userDirectories.backgrounds;
        const thumbnailsBgPath = userDirectories.thumbnailsBg;
        const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
        const currentResolution = getThumbnailResolution();

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
            const totalFiles = filesToProcess.length;

            for (let i = 0; i < totalFiles; i += CONCURRENCY_LIMIT) {
                const batchFiles = filesToProcess.slice(i, i + CONCURRENCY_LIMIT);
                const tasks = batchFiles.map(filename => (async () => {
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
                })());

                const batchResults = await Promise.allSettled(tasks);

                batchResults.forEach(result => {
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
        }


        if (filesToDelete.length > 0) {
            for (const filename of filesToDelete) {
                delete metadata.images[filename];
            }
        }

        const jsonString = JSON.stringify(metadata, null, 4);
        await writeFileAtomic(backgroundsJsonPath, jsonString, 'utf8');

    } catch (error) {
        console.error('[Background Sync] An error occurred during startup synchronization:', error);
    }
}
