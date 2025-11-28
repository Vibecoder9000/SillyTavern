import fsp from 'node:fs/promises';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import writeFileAtomic from 'write-file-atomic';
import { invalidateThumbnail, dimensions, generateThumbnail, SKIPPED_EXTENSIONS } from './thumbnails.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { generateSingleFileMetadata, BACKGROUNDS_METADATA_FILE } from './backgrounds-manager.js';
import { getUniqueName } from '../util.js';

/**
 * Manages locked, atomic operations on the backgrounds metadata file.
 */
class BackgroundsMetadataManager {
    /**
     * @param {object} userDirectories The user's directory paths.
     */
    constructor(userDirectories) {
        this.jsonPath = path.join(userDirectories.backgrounds, BACKGROUNDS_METADATA_FILE);
    }

    /**
     * Safely reads the metadata file with a lock.
     * @returns {Promise<object>} The parsed metadata.
     */
    async read() {
        try {
            const rawData = await fsp.readFile(this.jsonPath, 'utf8');
            return JSON.parse(rawData);
        } catch (error) {
            return { version: 1, images: {}, folders: [], tags: [] };
        }
    }

    /**
     * Safely updates the metadata file by applying a transformation function.
     * This method handles locking, reading, executing the update, and writing the result.
     * @param {function(object): (any | Promise<any>)} updateFn A function that receives the metadata,
     *   modifies it, and can optionally return a value.
     * @returns {Promise<any>} The return value of the updateFn.
     */
    async update(updateFn) {
        const metadata = await this.read();
        const result = await updateFn(metadata);
        const jsonString = JSON.stringify(metadata, null, 4);
        await writeFileAtomic(this.jsonPath, jsonString, 'utf8');
        return result;
    }
}

export const router = express.Router();

router.post('/all', async function (request, response) {
    try {
        const manager = new BackgroundsMetadataManager(request.user.directories);
        const metadata = await manager.read();

        // The frontend expects an array of filenames.
        const allImages = Object.keys(metadata.images);
        const config = { width: dimensions.bg[0], height: dimensions.bg[1] };

        response.json({ images: allImages, config });

    } catch (error) {
        console.error('Failed to read or parse backgrounds metadata:', error);
        response.json({ images: [] });
    }
});

router.post('/delete', getFileNameValidationFunction('bg'), async function (request, response) {
    if (!request.body || !request.body.bg) {
        return response.status(400).send('Background filename not provided.');
    }

    try {
        const filename = request.body.bg;
        const filePath = path.join(request.user.directories.backgrounds, filename);

        if (!(await fileExists(filePath))) {
            console.error('BG file not found');
            return response.sendStatus(400);
        }

        await fsp.unlink(filePath);
        invalidateThumbnail(request.user.directories, 'bg', filename);

        const manager = new BackgroundsMetadataManager(request.user.directories);
        await manager.update(metadata => {
            if (metadata.images[filename]) {
                delete metadata.images[filename];
            }
        });

        return response.send('ok');

    } catch (error) {
        console.error(`Failed to process delete request for ${request.body.bg}:`, error);
        return response.status(500).send('Failed to delete background.');
    }
});

router.post('/rename', async function (request, response) {
    if (!request.body || !request.body.old_bg || !request.body.new_bg) {
        return response.status(400).send('Old and new filenames are required.');
    }

    try {
        const oldFilename = sanitize(request.body.old_bg);
        // The original desired name from the user
        const desiredNewFilename = sanitize(request.body.new_bg);
        const backgroundsFolderPath = request.user.directories.backgrounds;
        const manager = new BackgroundsMetadataManager(request.user.directories);

        if (oldFilename === desiredNewFilename) {
            const metadata = await manager.read();
            return response.json({ filename: oldFilename, ...metadata.images[oldFilename] });
        }

        const finalNewFilename = await getUniqueFilename(backgroundsFolderPath, desiredNewFilename);

        // 1. Rename the main background file using the final unique name.
        const oldFilePath = path.join(backgroundsFolderPath, oldFilename);
        const newFilePath = path.join(backgroundsFolderPath, finalNewFilename);
        await fsp.rename(oldFilePath, newFilePath);

        // 2. Rename the corresponding thumbnail file using the final unique name.
        const thumbnailsFolderPath = request.user.directories.thumbnailsBg;
        const oldThumbPath = path.join(thumbnailsFolderPath, oldFilename);
        const newThumbPath = path.join(thumbnailsFolderPath, finalNewFilename);

        if (await fileExists(oldThumbPath)) {
            await fsp.rename(oldThumbPath, newThumbPath);
        }

        // 3. Update the metadata object using the manager
        const oldMetadata = await manager.update(metadata => {
            const data = metadata.images[oldFilename];
            if (!data) {
                throw new Error(`Background '${oldFilename}' not found in metadata.`);
            }
            delete metadata.images[oldFilename];
            metadata.images[finalNewFilename] = data;
            return data;
        });

        // 4. Respond with the final unique name and its metadata.
        response.json({ filename: finalNewFilename, ...oldMetadata });

    } catch (error) {
        // The startup sync process will correct any inconsistencies on the next launch.
        console.error(`Failed to rename background from ${request.body.old_bg} to ${request.body.new_bg}:`, error);
        return response.status(500).send(error.message || 'Failed to rename background.');
    }
});

/**
 * Checks if a file exists.
 * @param {string} filePath - The full path to the file.
 * @returns {Promise<boolean>} True if the file exists, false otherwise.
 */
async function fileExists(filePath) {
    try {
        await fsp.access(filePath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Generates a unique filename by appending (1), (2), etc. if a conflict is found.
 * @param {string} directory - The directory where the file will be saved.
 * @param {string} originalFilename - The original desired filename.
 * @returns {Promise<string>} A unique filename.
 */
async function getUniqueFilename(directory, originalFilename) {
    const fileExtension = path.extname(originalFilename);
    const baseName = path.basename(originalFilename, fileExtension);

    // Create a set of existing filenames to check synchronously
    const dirContent = await fsp.readdir(directory);
    const existingFiles = new Set(dirContent);

    // Use the getUniqueName utility function with a synchronous existence check
    const uniqueBaseName = getUniqueName(baseName, (name) => {
        return existingFiles.has(`${name}${fileExtension}`);
    });

    return `${uniqueBaseName}${fileExtension}`;
}

/**
 * Handles the upload of a new background image.
 * @param {express.Request} request - The Express request object.
 *   - `request.file` is provided by Multer and contains the uploaded file's details.
 *   - `request.user` is middleware-provided and contains user-specific data and directories.
 * @param {express.Response} response - The Express response object.
 * @returns {Promise<void>}
 */
router.post('/upload', async function (request, response) {
    if (!request.body || !request.file) {
        return response.status(400).send('No file uploaded.');
    }

    let finalBgPath;

    try {
        const tempPath = request.file.path;
        const backgroundsFolderPath = request.user.directories.backgrounds;

        const uniqueFilename = await getUniqueFilename(backgroundsFolderPath, request.file.originalname);
        finalBgPath = path.join(backgroundsFolderPath, uniqueFilename);

        await fsp.rename(tempPath, finalBgPath);

        const fileExtension = path.extname(uniqueFilename).toLowerCase();
        const isSkippedFormat = SKIPPED_EXTENSIONS.has(fileExtension);

        const thumbResult = await generateThumbnail(
            request.user.directories,
            'bg',
            uniqueFilename,
            !isSkippedFormat,
            null,
        );
        const newMetadata = await generateSingleFileMetadata(finalBgPath);

        if (!newMetadata) {
            throw new Error(`Failed to generate metadata for ${uniqueFilename}.`);
        }

        if (thumbResult && thumbResult.resolution) {
            newMetadata.thumbnailResolution = thumbResult.resolution;
        }

        const manager = new BackgroundsMetadataManager(request.user.directories);
        await manager.update(metadata => {
            metadata.images[uniqueFilename] = newMetadata;
        });

        response.json({ filename: uniqueFilename, ...newMetadata });

    } catch (err) {
        const originalFilename = request.file?.originalname ?? 'unknown file';
        console.error(`Background upload failed for ${originalFilename}:`, err);

        if (finalBgPath && await fileExists(finalBgPath)) {
            await fsp.unlink(finalBgPath);
        }
        if (request.file?.path && await fileExists(request.file.path)) {
            await fsp.unlink(request.file.path);
        }

        response.status(500);
    }
});
