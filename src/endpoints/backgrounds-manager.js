import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import writeFileAtomic from 'write-file-atomic';
import { getAverageColor } from 'fast-average-color-node';
import { invalidateThumbnail, generateThumbnail, SKIPPED_EXTENSIONS_FOR_JIMP, CONCURRENCY_LIMIT } from './thumbnails.js';
import { getConfigValue } from '../util.js';

/**
 * We create a promise that acts as a "lock".
 * It will only be resolved when the initial, critical sync is complete.
 * All other API endpoints that access backgrounds.json must await this promise.
 */
let resolveSync;
export const syncPromise = new Promise(resolve => {
    resolveSync = resolve;
});

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
 * @returns {Promise<object>} A metadata object. Throws an error if processing fails.
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

        // Read a small portion of the buffer to check for animation indicators efficiently.
        const headerBuffer = buffer.length > 200 ? buffer.subarray(0, 200) : buffer;

        switch (dimensions.type) {
            case 'gif':
                isAnimated = true; // GIFs are generally treated as animated.
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
            console.log(`[Backgrounds] Skipped file with excessively long name: ${path.basename(filePath)}`);
        }
        // Re-throw the error to ensure metadata generation failures are propagated.
        throw error;
    }
}

/**
 * A utility function to purge the entire thumbnail cache directory.
 * @param {string} thumbnailsBgPath - The path to the background thumbnails directory.
 */
async function purgeThumbnailCache(thumbnailsBgPath) {
    try {
        const thumbFiles = await fs.readdir(thumbnailsBgPath);
        if (thumbFiles.length > 0) {
            console.log(`[Background Sync] Purging ${thumbFiles.length} old thumbnails from cache...`);
            await Promise.all(thumbFiles.map(file => fs.unlink(path.join(thumbnailsBgPath, file))));
        }
    } catch (e) {
        if (e.code !== 'ENOENT') { // It's okay if the directory doesn't exist.
            console.error('[Background Sync] Failed to purge thumbnail cache:', e);
        }
    }
}

/**
 * Synchronizes the backgrounds.json metadata file with the files on disk.
 * It adds new files, removes deleted ones, and regenerates thumbnails if the configured resolution has changed.
 * This function performs a one-time check at startup and logs only a summary of changes made.
 * @param {import('../users.js').UserDirectoryList} userDirectories The directories for a single user.
 */
export async function syncBackgroundsMetadata(userDirectories) {
    try {
        const backgroundsJsonPath = path.join(userDirectories.root, 'backgrounds.json');
        const backgroundsFolderPath = userDirectories.backgrounds;
        const thumbnailsBgPath = userDirectories.thumbnailsBg;
        const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
        const currentResolution = getConfigValue('thumbnails.resolution', 15000);

        let metadata;
        try {
            const rawData = await fs.readFile(backgroundsJsonPath, 'utf8');
            metadata = JSON.parse(rawData);

            // Data-integrity based migration check.
            const migrationTrigger = Object.entries(metadata.images).find(([filename, img]) => {
                const fileExtension = path.extname(filename).toLowerCase();
                // An animated WebP's static thumbnail is generated client-side.
                if (fileExtension === '.webp' && img.isAnimated) {
                    return false;
                }
                return !img.thumbnailResolution && !SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension);
            });

            if (migrationTrigger) {
                const [triggerFilename] = migrationTrigger;
                console.log(`[Background Sync] Incomplete or legacy metadata detected ("${triggerFilename}" is missing thumbnail data). Forcing full thumbnail migration...`);
                await purgeThumbnailCache(thumbnailsBgPath);
                // Invalidate all in-memory metadata to force regeneration.
                for (const key in metadata.images) {
                    if (metadata.images[key].thumbnailResolution) {
                        delete metadata.images[key].thumbnailResolution;
                    }
                }
            }
        } catch (error) {
            // This block now handles the "no backgrounds.json" case.
            // We MUST assume any existing thumbnails are from an old version and purge them.
            console.log('[Background Sync] backgrounds.json not found. Assuming first-time setup or reset.');
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
            return; // Can't proceed
        }

        // Phase 1: Identify all necessary work without modifying data yet.
        const filesOnDiskSet = new Set(imageFilesOnDisk);
        const metadataImageKeys = Object.keys(metadata.images);
        const filesToProcess = [];

        // Check for thumbnails that need regeneration due to a configuration change.
        const needsThumbRegen = new Set();
        for (const filename of metadataImageKeys) {
            const imageMeta = metadata.images[filename];
            if (imageMeta?.thumbnailResolution && imageMeta.thumbnailResolution !== currentResolution) {
                needsThumbRegen.add(filename);
            }
        }

        // Determine the full list of files that need processing for any reason.
        for (const filename of imageFilesOnDisk) {
            const imageMeta = metadata.images[filename];
            const isNew = !imageMeta;
            const fileExtension = path.extname(filename).toLowerCase();
            const isSkippedFormat = SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension);
            const isAnimatedWebp = imageMeta && fileExtension === '.webp' && imageMeta.isAnimated;

            const needsUpdate = imageMeta && (
                imageMeta.addedTimestamp === undefined ||
                needsThumbRegen.has(filename) ||
                (imageMeta.thumbnailResolution === undefined && !isSkippedFormat && !isAnimatedWebp)
            );

            if (isNew || needsUpdate) {
                filesToProcess.push(filename);
            }
        }

        const filesToDelete = metadataImageKeys.filter(filename => !filesOnDiskSet.has(filename));
        const hasChanges = filesToProcess.length > 0 || filesToDelete.length > 0 || needsThumbRegen.size > 0;

        if (!hasChanges) {
            return; // Nothing to do.
        }

        // Phase 2: Execute the work only if changes were identified.
        if (needsThumbRegen.size > 0) {
            console.log(`[Background Sync] Invalidating ${needsThumbRegen.size} thumbnails due to resolution change.`);
            for (const filename of needsThumbRegen) {
                invalidateThumbnail(userDirectories, 'bg', filename);
                if (metadata.images[filename]) {
                    delete metadata.images[filename].thumbnailResolution;
                }
            }
        }

        if (filesToProcess.length > 0) {
            console.log(`[Background Sync] Found ${filesToProcess.length} images needing processing.`);
            const totalFiles = filesToProcess.length;
            let processedCount = 0;
            const startTime = performance.now();

            // Server-side console progress bar for initial thumbnail generation.
            const renderProgressBar = () => {
                process.stdout.clearLine(0);
                process.stdout.cursorTo(0);
                const percentage = Math.floor((processedCount / totalFiles) * 100);
                const progress = Math.floor((percentage / 100) * 20);
                const bar = '█'.repeat(progress) + '-'.repeat(20 - progress);
                const elapsedTime = (performance.now() - startTime) / 1000;
                const imagesPerSecond = elapsedTime > 0 ? (processedCount / elapsedTime).toFixed(1) : '...';
                const eta = elapsedTime > 0 && processedCount > 0 ? Math.round(((totalFiles - processedCount) * elapsedTime) / processedCount) : 0;
                process.stdout.write(`Syncing Backgrounds: [${bar}] ${percentage}% | ${processedCount}/${totalFiles} | ${imagesPerSecond} img/s | ETA: ${eta}s`);
            };

            renderProgressBar();

            for (let i = 0; i < totalFiles; i += CONCURRENCY_LIMIT) {
                const batchFiles = filesToProcess.slice(i, i + CONCURRENCY_LIMIT);
                const tasks = batchFiles.map(filename => (async () => {
                    const filePath = path.join(backgroundsFolderPath, filename);
                    let updatePayload = {};

                    if (!metadata.images[filename]) {
                        const newMetadata = await generateSingleFileMetadata(filePath);
                        if (newMetadata) updatePayload.newMetadata = newMetadata;
                    } else if (metadata.images[filename].addedTimestamp === undefined) {
                        try {
                            const stats = await fs.stat(filePath);
                            updatePayload.addedTimestamp = Math.floor(stats.birthtimeMs || stats.mtimeMs);
                        } catch {
                            updatePayload.addedTimestamp = Date.now();
                        }
                    }

                    const fileExtension = path.extname(filename).toLowerCase();
                    const imageRecord = metadata.images[filename] || updatePayload.newMetadata;
                    if (imageRecord && imageRecord.thumbnailResolution === undefined && !SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension)) {
                        const thumbResult = await generateThumbnail(userDirectories, 'bg', filename, false, imageRecord.isAnimated);
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
                        const fileExtension = path.extname(filename).toLowerCase();
                        const isSkippedFormat = SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension);

                        // Check if a thumbnail was expected but not generated in this run.
                        const originalImageMeta = metadata.images[filename];
                        const wasNew = !originalImageMeta;
                        const neededThumb = originalImageMeta && originalImageMeta.thumbnailResolution === undefined;

                        // Get the full metadata record, whether it's new or was pre-existing.
                        const imageRecord = newMetadata || originalImageMeta;
                        const isAnimatedWebp = imageRecord && fileExtension === '.webp' && imageRecord.isAnimated;

                        // Only warn if it's not a skipped format AND it's not an animated WebP that the client handles.
                        if (!isSkippedFormat && !isAnimatedWebp && (wasNew || neededThumb) && !thumbnailResolution) {
                            console.log(`\n[Background Sync] Warning: Thumbnail for "${filename}" was not generated. The file may be corrupted or an unsupported variation.`);
                        }

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
                    } else if (result.status === 'rejected') {
                        console.error('[Background Sync] A task failed during batch processing:', result.reason);
                    }
                });

                processedCount += batchFiles.length;
                renderProgressBar();
            }
            process.stdout.write('\n');
        }

        if (filesToDelete.length > 0) {
            console.log(`[Background Sync] Removing metadata for ${filesToDelete.length} deleted images.`);
            for (const filename of filesToDelete) {
                delete metadata.images[filename];
            }
        }

        // Phase 3: Save changes.
        const jsonString = JSON.stringify(metadata, null, 4);
        await writeFileAtomic(backgroundsJsonPath, jsonString, 'utf8');
        console.log('[Background Sync] Synchronization complete.');

    } catch (error) {
        console.error('[Background Sync] A critical error occurred during startup synchronization:', error);
    } finally {
        // This is the crucial step: whether the sync succeeded or failed,
        // we resolve the promise to unlock the API for subsequent requests.
        resolveSync();
    }
}
