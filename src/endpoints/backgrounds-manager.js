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
 * The current version of the thumbnail system.
 * Version 1: Legacy system with no resolution metadata.
 * Version 2: System using target pixel area, with 'thumbnailResolution' in metadata.
 */
const TARGET_THUMBNAIL_SYSTEM_VERSION = 2;

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
            console.log(`[Backgrounds] Skipped file with excessively long name: ${path.basename(filePath)}`);
        } else {
            console.warn(`[Backgrounds] Failed to generate metadata for ${path.basename(filePath)}:`, error);
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
    const thumbnailsBgPath = userDirectories.thumbnailsBg;
    const ALLOWED_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff']);
    const currentResolution = getConfigValue('thumbnails.resolution', 15000);

    let metadata;
    try {
        const rawData = await fs.readFile(backgroundsJsonPath, 'utf8');
        metadata = JSON.parse(rawData);
    } catch (error) {
        // If the file doesn't exist, this is a new installation.
        // Create a new metadata object that is already at the latest version.
        metadata = { version: 1, images: {}, folders: [], tags: [], thumbnailSystemVersion: TARGET_THUMBNAIL_SYSTEM_VERSION };
    }

    // This is the one-time migration check. If the data isn't at the target version, we force a full rebuild.
    if (metadata.thumbnailSystemVersion !== TARGET_THUMBNAIL_SYSTEM_VERSION) {
        console.log('[Background Sync] Outdated thumbnail system detected. Performing one-time migration. This may take a while...');

        // Step 1: Purge the entire background thumbnail cache to remove all old files.
        try {
            const thumbFiles = await fs.readdir(thumbnailsBgPath);
            await Promise.all(thumbFiles.map(file => fs.unlink(path.join(thumbnailsBgPath, file))));
            console.log(`[Background Sync] Purged ${thumbFiles.length} old thumbnails from cache.`);
        } catch (e) {
            // It's okay if the directory doesn't exist. Any other error should be reported.
            if (e.code !== 'ENOENT') {
                console.error('[Background Sync] Failed to purge thumbnail cache during migration:', e);
            }
        }

        // Step 2: Invalidate all resolution metadata to force regeneration.
        for (const key in metadata.images) {
            if (metadata.images[key].thumbnailResolution) {
                delete metadata.images[key].thumbnailResolution;
            }
        }
        console.log('[Background Sync] Invalidated all thumbnail metadata. Starting full regeneration...');
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

        // A file needs an update if its metadata is missing, a timestamp is missing,
        // it's flagged for regen, or its thumbnail resolution is missing (after migration).
        const needsUpdate = imageMeta && (
            imageMeta.addedTimestamp === undefined ||
            needsThumbRegen.has(filename) ||
            (imageMeta.thumbnailResolution === undefined && !isSkippedFormat)
        );

        if (isNew || needsUpdate) {
            filesToProcess.push(filename);
        }
    }

    const filesToDelete = metadataImageKeys.filter(filename => !filesOnDiskSet.has(filename));
    const hasChanges = filesToProcess.length > 0 || filesToDelete.length > 0 || needsThumbRegen.size > 0;

    if (!hasChanges) {
        // Before returning, ensure we still stamp the version if it was missing.
        if (metadata.thumbnailSystemVersion !== TARGET_THUMBNAIL_SYSTEM_VERSION) {
            metadata.thumbnailSystemVersion = TARGET_THUMBNAIL_SYSTEM_VERSION;
            const jsonString = JSON.stringify(metadata, null, 4);
            await writeFileAtomic(backgroundsJsonPath, jsonString, 'utf8');
            console.log('[Background Sync] System version updated.');
        }
        return; // Nothing else to do.
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

        // This is the progress bar rendering function
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
                // This async function performs all the work for a single file and returns the results
                // without directly modifying the shared `metadata` object, to prevent race conditions.
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
                    // Force thumbnail generation since we are in a processing queue.
                    const thumbResult = await generateThumbnail(userDirectories, 'bg', filename, false, false);
                    if (thumbResult.path && thumbResult.resolution) {
                        updatePayload.thumbnailResolution = thumbResult.resolution;
                    }
                }
                return { filename, ...updatePayload };
            })());

            const batchResults = await Promise.allSettled(tasks);

            // Now, apply the results of the batch sequentially to the metadata object.
            batchResults.forEach(result => {
                if (result.status === 'fulfilled' && result.value) {
                    const { filename, newMetadata, addedTimestamp, thumbnailResolution } = result.value;
                    if (newMetadata) {
                        metadata.images[filename] = newMetadata;
                    }
                    // Check if the image record exists before trying to add properties to it.
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
        process.stdout.write('\n'); // New line after the progress bar finishes.
    }

    if (filesToDelete.length > 0) {
        console.log(`[Background Sync] Removing metadata for ${filesToDelete.length} deleted images.`);
        for (const filename of filesToDelete) {
            delete metadata.images[filename];
        }
    }

    // Phase 3: Save changes.
    try {
        // Finally, stamp the metadata with the current system version before saving.
        metadata.thumbnailSystemVersion = TARGET_THUMBNAIL_SYSTEM_VERSION;
        const jsonString = JSON.stringify(metadata, null, 4);
        await writeFileAtomic(backgroundsJsonPath, jsonString, 'utf8');
        console.log('[Background Sync] Synchronization complete.');
    } catch (error) {
        console.error('[Background Sync] Failed to save backgrounds.json:', error);
    }
}
