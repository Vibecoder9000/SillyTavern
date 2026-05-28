import { performance } from 'node:perf_hooks';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { imageSize } from 'image-size';
import writeFileAtomic from 'write-file-atomic';
import { Jimp } from '../jimp.js';
import { invalidateThumbnail, generateThumbnail, SKIPPED_EXTENSIONS_FOR_JIMP, CONCURRENCY_LIMIT } from './thumbnails.js';
import { getThumbnailResolution } from '../util.js';

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
 * Calculate average color using Jimp.
 * Resizes the image to 1x1 to efficiently get the average color.
 * @param {Buffer} buffer The image buffer.
 * @returns {Promise<string>} The average color as a hex string (e.g., '#RRGGBB').
 */
async function getAverageColorWithJimp(buffer) {
    try {
        const image = await Jimp.read(buffer);

        // Resize to 1x1 using the correct object syntax for this project's version
        image.resize({ w: 1, h: 1 });

        // Get the color of the single pixel as a 32-bit integer
        const colorInt = image.getPixelColor(0, 0);

        // Manually convert the integer to RGBA using bitwise operators.
        const r = (colorInt >> 24) & 255;
        const g = (colorInt >> 16) & 255;
        const b = (colorInt >> 8) & 255;

        // Format as a hex string
        const toHex = (c) => c.toString(16).padStart(2, '0');
        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    } catch (error) {
        console.error('[Jimp] Failed to calculate average color:', error);
        return '#808080'; // Grey
    }
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

        let hexColor;
        if (isAnimated) {
            hexColor = '#808080'; // Default grey
        } else {
            // Only process non-animated images to avoid decoding errors.
            hexColor = await getAverageColorWithJimp(buffer);
        }

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
    // Check if the directory exists.
    const directoryExists = await fs.stat(thumbnailsBgPath).then(stats => stats.isDirectory()).catch(() => false);

    if (!directoryExists) {
        return; // Nothing to purge.
    }

    try {
        const thumbFiles = await fs.readdir(thumbnailsBgPath);
        if (thumbFiles.length > 0) {
            console.log(`[Background Sync] Purging ${thumbFiles.length} old thumbnails from cache...`);
            // Sequentially delete file.
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
        const currentResolution = getThumbnailResolution();

        let metadata;
        let migrationTriggeredByFileIssues = false;
        let fileMigrationReasons = [];

        try {
            const rawData = await fs.readFile(backgroundsJsonPath, 'utf8');
            metadata = JSON.parse(rawData);

            // Data-integrity based migration check.
            // Iterate through images to find all reasons for migration.
            for (const [filename, img] of Object.entries(metadata.images)) {
                const fileExtension = path.extname(filename).toLowerCase();

                // Determine if this file should be skipped by the server's thumbnail generation.
                // This includes formats explicitly skipped by Jimp (e.g., .gif, .mp4, .apng)
                // OR any file that is identified as animated (e.g., animated WebP, APNG).
                const shouldBeSkippedByServerThumbnailer =
                    SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension) ||
                    img.isAnimated ||
                    // Explicitly skip PNGs and WebPs if thumbnailResolution is missing,
                    // as their animated status might be stale and they are handled client-side.
                    ((fileExtension === '.png' || fileExtension === '.webp') && !img.thumbnailResolution);


                // Trigger migration if thumbnailResolution is missing AND it's a file that the
                // server *should* have generated a thumbnail for (i.e., not skipped).
                if (!img.thumbnailResolution && !shouldBeSkippedByServerThumbnailer) {
                    fileMigrationReasons.push(`"${filename}" is missing thumbnail resolution data.`);
                    migrationTriggeredByFileIssues = true;
                }
            }

            if (migrationTriggeredByFileIssues) {
                console.log('[Background Sync] Incomplete or legacy metadata detected. Forcing full thumbnail migration...');
                fileMigrationReasons.forEach(reason => console.log(`  - Reason: ${reason}`));
                await purgeThumbnailCache(thumbnailsBgPath);
                // Invalidate all in-memory metadata to force regeneration.
                for (const key in metadata.images) {
                    if (metadata.images[key].thumbnailResolution) {
                        delete metadata.images[key].thumbnailResolution;
                    }
                }
            }
        } catch (error) {
            console.log('[Background Sync] backgrounds.json not found or corrupt. Forcing full thumbnail migration...');
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

            // Determine if server-side thumbnail generation should be skipped for this file.
            // This includes formats explicitly skipped by Jimp (e.g., .gif, .mp4, .apng)
            // or any file that is identified as animated (APNG, animated WebP).
            // For PNGs and WebPs, if thumbnailResolution is missing, we must assume they *might* be animated
            // and thus should be skipped by the server thumbnailer.
            const shouldSkipServerThumbnailGeneration =
                SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension) ||
                (imageMeta && imageMeta.isAnimated) ||
                ((fileExtension === '.png' || fileExtension === '.webp') && imageMeta && !imageMeta.thumbnailResolution);

            const needsUpdate = imageMeta && (
                imageMeta.addedTimestamp === undefined ||
                needsThumbRegen.has(filename) ||
                // Only consider missing thumbnailResolution as needing update
                // if server-side thumbnail generation is NOT skipped for this file.
                (imageMeta.thumbnailResolution === undefined && !shouldSkipServerThumbnailGeneration)
            );

            // Add file to filesToProcess if it's new or needs update and
            // not a file that should be skipped by server-side thumbnail generation.
            // If it's a new animated file, we still add it to filesToProcess to generate its metadata,
            // but the thumbnail generation step will then skip it.
            if (isNew || (needsUpdate && !shouldSkipServerThumbnailGeneration)) {
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
                    let currentImageMeta = metadata.images[filename]; // Get current metadata for this file

                    // Force re-generation of metadata if it's a new file, or if its animated status/thumbnailResolution is uncertain.
                    const fileExtension = path.extname(filename).toLowerCase();
                    const forceMetadataRegen =
                        !currentImageMeta ||
                        currentImageMeta.addedTimestamp === undefined ||
                        currentImageMeta.isAnimated === undefined ||
                        // Force metadata regen for PNG/WebP if thumbnailResolution is missing.
                        // This ensures 'isAnimated' is re-evaluated from the file itself.
                        ((fileExtension === '.png' || fileExtension === '.webp') && currentImageMeta.thumbnailResolution === undefined);

                    if (forceMetadataRegen) {
                        const newMetadata = await generateSingleFileMetadata(filePath);
                        if (newMetadata) {
                            updatePayload.newMetadata = newMetadata;
                            currentImageMeta = { ...currentImageMeta, ...newMetadata }; // Use updated meta for subsequent checks
                        }
                    } else if (currentImageMeta.addedTimestamp === undefined) { // Fallback for addedTimestamp if not covered above
                        try {
                            const stats = await fs.stat(filePath);
                            updatePayload.addedTimestamp = Math.floor(stats.birthtimeMs || stats.mtimeMs);
                        } catch {
                            updatePayload.addedTimestamp = Date.now();
                        }
                    }

                    // Determine if server-side thumbnail generation should be skipped for this file.
                    // This includes formats explicitly skipped by Jimp (e.g., .gif, .mp4, .apng)
                    // OR any file that is identified as animated (e.g., APNG, animated WebP).
                    const shouldSkipServerThumbnailGeneration =
                        SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension) ||
                        (currentImageMeta && currentImageMeta.isAnimated);

                    let warningMessage = null;

                    // Only attempt server-side thumbnail generation if thumbnailResolution is missing
                    // and server-side generation is not skipped for this file.
                    if (currentImageMeta && currentImageMeta.thumbnailResolution === undefined && !shouldSkipServerThumbnailGeneration) {
                        const thumbResult = await generateThumbnail(userDirectories, 'bg', filename, false, false, currentImageMeta.isAnimated);
                        if (thumbResult.path && thumbResult.resolution) {
                            updatePayload.thumbnailResolution = thumbResult.resolution;
                        }
                    } else if (currentImageMeta && currentImageMeta.thumbnailResolution === undefined && shouldSkipServerThumbnailGeneration) {
                        // If the thumbnail was expected to be skipped by the server, create the warning message.
                        warningMessage = `[Background Sync] Server cannot process "${filename}". It will be client generated.`;
                    }
                    // Return the warning message along with other data.
                    return { filename, ...updatePayload, warningMessage };
                })());


                const batchResults = await Promise.allSettled(tasks);

                // Collect all messages before printing
                const messagesToLog = [];

                batchResults.forEach(result => {
                    if (result.status === 'fulfilled' && result.value) {
                        const { filename, newMetadata, addedTimestamp, thumbnailResolution, warningMessage } = result.value;

                        // Collect the warning message if it exists
                        if (warningMessage) {
                            messagesToLog.push({ type: 'warn', text: warningMessage });
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
                        // Also collect errors to prevent them from messing up the progress bar
                        messagesToLog.push({ type: 'error', text: `[Background Sync] A task failed during batch processing: ${result.reason}` });
                    }
                });

                // Print collected messages
                if (messagesToLog.length > 0) {
                    // Clear the progress bar line before printing messages
                    process.stdout.clearLine(0);
                    process.stdout.cursorTo(0);

                    // Log each message
                    messagesToLog.forEach(msg => {
                        if (msg.type === 'warn') {
                            console.warn(msg.text);
                        } else {
                            console.error(msg.text);
                        }
                    });
                }

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

        // Save changes.
        const jsonString = JSON.stringify(metadata, null, 4);
        await writeFileAtomic(backgroundsJsonPath, jsonString, 'utf8');
        console.log('[Background Sync] Synchronization complete.');
    } catch (error) {
        console.error('[Background Sync] A critical error occurred during startup synchronization:', error);
    } finally {
        // Whether the sync succeeded or failed,
        // we resolve the promise to unlock the API for subsequent requests.
        resolveSync();
    }
}

/**
 * Sets a specific background image as the thumbnail for a folder.
 * @param {import('../users.js').UserDirectoryList} userDirectories The directories for the user.
 * @param {string} folderId The ID of the folder to update.
 * @param {string|null} filename The filename of the image to set as thumbnail, or null to clear it.
 * @returns {Promise<void>}
 */
export async function setFolderThumbnail(userDirectories, folderId, filename) {
    await syncPromise; // Ensure initial sync is done.
    const backgroundsJsonPath = path.join(userDirectories.root, 'backgrounds.json');

    try {
        const rawData = await fs.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        const folderIndex = metadata.folders.findIndex(f => f.id === folderId);

        if (folderIndex === -1) {
            throw new Error(`Folder with ID "${folderId}" not found.`);
        }

        // Set or clear the thumbnail file property
        metadata.folders[folderIndex].thumbnailFile = filename;

        const jsonString = JSON.stringify(metadata, null, 4);
        await writeFileAtomic(backgroundsJsonPath, jsonString, 'utf8');
    } catch (error) {
        console.error(`[SetFolderThumbnail] Failed to update backgrounds.json for user at ${userDirectories.root}:`, error);
        // Re-throw to be handled by the API endpoint caller
        throw error;
    }
}
