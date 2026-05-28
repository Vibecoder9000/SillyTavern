import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import sanitize from 'sanitize-filename';
import multer from 'multer';

import { UPLOADS_DIRECTORY } from '../constants.js';

import writeFileAtomic from 'write-file-atomic';
import { uuidv4 } from '../util.js';
import { invalidateThumbnail, dimensions, generateThumbnail, SKIPPED_EXTENSIONS_FOR_JIMP } from './thumbnails.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { generateSingleFileMetadata, syncPromise } from './backgrounds-manager.js';

const upload = multer({ dest: UPLOADS_DIRECTORY });
let isSyncComplete = false;

// When the main sync promise resolves, we flip the flag to true.
syncPromise.then(() => {
    isSyncComplete = true;
});

/**
 * A simple async lock to prevent race conditions when modifying files.
 * Ensures that operations on `backgrounds.json` are serialized to prevent data corruption.
 */
class AsyncLock {
    constructor() {
        this.disable = false;
        this.promise = Promise.resolve();
    }

    acquire() {
        let release;
        const newPromise = new Promise(resolve => {
            release = resolve;
        });
        const prevPromise = this.promise;
        this.promise = newPromise;
        return prevPromise.then(() => release);
    }
}

const fileLock = new AsyncLock();

/**
 * Manages locked, atomic operations on the backgrounds.json file.
 */
class BackgroundsMetadataManager {
    /**
     * @param {object} userDirectories The user's directory paths.
     */
    constructor(userDirectories) {
        this.jsonPath = path.join(userDirectories.root, 'backgrounds.json');
    }

    /**
     * Safely reads the metadata file with a lock.
     * @returns {Promise<object>} The parsed metadata.
     */
    async read() {
        const release = await fileLock.acquire();
        try {
            const rawData = await fsp.readFile(this.jsonPath, 'utf8');
            return JSON.parse(rawData);
        } catch (error) {
            // If the file doesn't exist or is corrupt, return a default structure.
            if (error.code === 'ENOENT' || error instanceof SyntaxError) {
                return { version: 1, images: {}, folders: [], tags: [], thumbnailSystemVersion: 2 };
            }
            throw error; // Rethrow other errors
        } finally {
            release();
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
        const release = await fileLock.acquire();
        try {
            let metadata;
            try {
                const rawData = await fsp.readFile(this.jsonPath, 'utf8');
                metadata = JSON.parse(rawData);
            } catch (error) {
                if (error.code === 'ENOENT' || error instanceof SyntaxError) {
                    metadata = { version: 1, images: {}, folders: [], tags: [], thumbnailSystemVersion: 2 };
                } else {
                    throw error;
                }
            }

            const result = await updateFn(metadata);

            const jsonString = JSON.stringify(metadata, null, 4);
            await writeFileAtomic(this.jsonPath, jsonString, 'utf8');

            return result;
        } finally {
            release();
        }
    }
}

export const router = express.Router();

/**
 * Prevents the client from requesting data
 * until the server's initial synchronization is fully complete.
 */
router.get('/status', (req, res) => {
    res.json({ ready: isSyncComplete });
});


/**
 * Apply the sync lock to every route in this file. This ensures that no background API requests
 * are processed until the initial startup synchronization is complete, preventing race conditions
 * where the frontend might read or write an outdated/incomplete backgrounds.json file.
 */
router.use(async (req, res, next) => {
    await syncPromise;
    next();
});

/**
 * Handles the request to get all background images and their metadata.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
router.post('/all', async function (request, response) {
    try {
        const manager = new BackgroundsMetadataManager(request.user.directories);
        const metadata = await manager.read();

        // The frontend expects an array of image data. The keys of the 'images' object are the filenames, so we need to transform it
        const allImages = Object.entries(metadata.images).map(([filename, data]) => ({
            filename: filename,
            ...data,
        }));

        response.json({ images: allImages });
    } catch (error) {
        console.error('Failed to read or parse backgrounds.json:', error);
        response.json({ images: [] });
    }
});

/**
 * Handles the request to get only the background folders and config.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
router.post('/folders', async function (request, response) {
    try {
        const manager = new BackgroundsMetadataManager(request.user.directories);
        const metadata = await manager.read();

        const config = { width: dimensions.bg[0], height: dimensions.bg[1] };
        const folders = metadata.folders || [];

        response.json({ config, folders });
    } catch (error) {
        console.error('Failed to read or parse backgrounds.json for folders:', error);
        response.json({ config: { width: dimensions.bg[0], height: dimensions.bg[1] }, folders: [] });
    }
});

/**
 * Handles the request to delete a background image.
 * @param {express.Request & { body: { bg: string }, user: any }} request - The Express request object.
 *   - `request.body.bg` should contain the filename of the background to be deleted.
 *   - `request.user` is middleware-provided and contains user-specific data and directories.
 * @param {express.Response} response - The Express response object.
 * @returns {Promise<void>}
 */
router.post('/delete', getFileNameValidationFunction('bg'), async function (request, response) {
    if (!request.body || !request.body.bg) {
        return response.status(400).send('Background filename not provided.');
    }

    try {
        const filename = request.body.bg;
        const filePath = path.join(request.user.directories.backgrounds, filename);

        try {
            await fsp.unlink(filePath);
        } catch (fileError) {
            if (fileError.code !== 'ENOENT') {
                console.warn(`Could not delete background file ${filename}:`, fileError);
            }
        }

        invalidateThumbnail(request.user.directories, 'bg', filename);

        const manager = new BackgroundsMetadataManager(request.user.directories);
        await manager.update(metadata => {
            if (metadata.images[filename]) {
                delete metadata.images[filename];
            }
        });

        return response.status(200).send('ok');
    } catch (error) {
        console.error(`Failed to process delete request for ${request.body.bg}:`, error);
        return response.status(500).send('Failed to delete background.');
    }
});

/**
 * Handles the request to rename a background image.
 * If the new name conflicts with an existing file, it will append a number.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
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

        // If the names are the same, it's a no-op. Return the existing data.
        if (oldFilename === desiredNewFilename) {
            const metadata = await manager.read();
            return response.json({ filename: oldFilename, ...metadata.images[oldFilename] });
        }

        // Determine the unique filename to use, handling potential conflicts.
        const finalNewFilename = await getUniqueFilename(backgroundsFolderPath, desiredNewFilename);

        // 1. Rename the main background file using the final unique name.
        const oldFilePath = path.join(backgroundsFolderPath, oldFilename);
        const newFilePath = path.join(backgroundsFolderPath, finalNewFilename);
        await fsp.rename(oldFilePath, newFilePath);

        // 2. Rename the corresponding thumbnail file using the final unique name.
        const thumbnailsFolderPath = request.user.directories.thumbnailsBg;
        const oldThumbPath = path.join(thumbnailsFolderPath, oldFilename);
        const newThumbPath = path.join(thumbnailsFolderPath, finalNewFilename);

        try {
            // Attempt to rename the thumbnail only if it exists.
            await fsp.rename(oldThumbPath, newThumbPath);
        } catch (thumbError) {
            // If the thumbnail doesn't exist (ENOENT), it's not a critical error.
            // For any other error (e.g., permissions), we must abort the operation.
            if (thumbError.code !== 'ENOENT') {
                // Re-throwing the error ensures it's caught by the outer catch block,
                // preventing the metadata update and leaving the system in a more predictable state.
                throw thumbError;
            }
        }

        // 3. Update the metadata object using the manager
        const oldMetadata = await manager.update(metadata => {
            const data = metadata.images[oldFilename];
            if (!data) {
                const err = new Error(`Background '${oldFilename}' not found in metadata.`);
                err.statusCode = 404;
                throw err;
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
        const statusCode = error.statusCode || 500;
        const message = error.statusCode ? error.message : 'Failed to rename background.';
        return response.status(statusCode).send(message);
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

    let newFilename = originalFilename;
    let counter = 1;

    while (await fileExists(path.join(directory, newFilename))) {
        newFilename = `${baseName} (${counter})${fileExtension}`;
        counter++;
    }

    return newFilename;
}

/**
 * Handles the upload of a new background image.
 * @param {express.Request & { file: import('multer').File, user: any }} request - The Express request object.
 *   - `request.file` is provided by Multer and contains the uploaded file's details.
 *   - `request.user` is middleware-provided and contains user-specific data and directories.
 * @param {express.Response} response - The Express response object.
 * @returns {Promise<void>}
 */
router.post('/upload', upload.single('avatar'), async function (request, response) {
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
        const isSkippedFormat = SKIPPED_EXTENSIONS_FOR_JIMP.includes(fileExtension);

        const thumbResult = await generateThumbnail(
            request.user.directories,
            'bg',
            uniqueFilename,
            !isSkippedFormat,
            false,
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

        if (finalBgPath) {
            try { await fsp.unlink(finalBgPath); } catch { /* ignore */ }
        }
        if (request.file?.path) {
            try { await fsp.unlink(request.file.path); } catch { /* ignore */ }
        }

        if (!response.headersSent) {
            response.status(500).send('Failed to process uploaded file.');
        }
    }
});

/**
 * Handles a report from the client that client-side thumbnail generation has failed for a file.
 * This sets a flag in the metadata to prevent the client from retrying.
 * @param {express.Request & { body: { filename: string }, user: any }} request
 * @param {express.Response} response
 */
router.post('/mark-thumbnail-fail', async function (request, response) {
    if (!request.body || typeof request.body.filename !== 'string') {
        return response.status(400).send('Filename is required.');
    }

    try {
        const filename = sanitize(request.body.filename);
        const manager = new BackgroundsMetadataManager(request.user.directories);

        await manager.update(metadata => {
            if (!metadata.images[filename]) {
                const err = new Error(`Background '${filename}' not found in metadata.`);
                err.statusCode = 404;
                throw err;
            }
            // Set the failure flag
            metadata.images[filename].staticThumbnailFailed = true;
        });

        return response.status(200).send('ok');
    } catch (error) {
        console.error(`Failed to mark thumbnail generation as failed for ${request.body.filename}:`, error);
        const statusCode = error.statusCode || 500;
        const message = error.statusCode ? error.message : 'Failed to update background metadata.';
        return response.status(statusCode).send(message);
    }
});

/**
 * Handles the request to toggle the starred status of a background image.
 * @param {express.Request & { body: { filename: string, isStarred: boolean }, user: any }} request - The Express request object.
 *   - `request.body.filename` should contain the filename of the background.
 *   - `request.body.isStarred` should contain the new boolean starred state.
 * @param {express.Response} response - The Express response object.
 * @returns {Promise<void>}
 */
router.post('/star', async function (request, response) {
    if (!request.body || typeof request.body.filename !== 'string' || typeof request.body.isStarred !== 'boolean') {
        return response.status(400).send('Filename and isStarred boolean are required.');
    }

    try {
        const filename = sanitize(request.body.filename);
        const { isStarred } = request.body;
        const manager = new BackgroundsMetadataManager(request.user.directories);

        await manager.update(metadata => {
            if (!metadata.images[filename]) {
                const err = new Error(`Background '${filename}' not found in metadata.`);
                err.statusCode = 404;
                throw err;
            }
            // Update the isStarred property
            metadata.images[filename].isStarred = isStarred;
        });

        return response.status(200).send('ok');
    } catch (error) {
        console.error(`Failed to update star status for ${request.body.filename}:`, error);
        const statusCode = error.statusCode || 500;
        const message = error.statusCode ? error.message : 'Failed to update background metadata.';
        return response.status(statusCode).send(message);
    }
});

/**
 * Handles updating the folder associations for a background image.
 * @param {express.Request & { body: { filename: string, folderIds: string[] }, user: any }} request - The Express request object.
 *   - `request.body.filename` should contain the filename of the background.
 *   - `request.body.folderIds` should contain the new array of folder IDs.
 * @param {express.Response} response - The Express response object.
 * @returns {Promise<void>}
 */
router.post('/update-folders', async function (request, response) {
    if (!request.body || typeof request.body.filename !== 'string' || !Array.isArray(request.body.folderIds)) {
        return response.status(400).send('Filename and folderIds array are required.');
    }

    try {
        const filename = sanitize(request.body.filename);
        const { folderIds } = request.body;
        const manager = new BackgroundsMetadataManager(request.user.directories);

        await manager.update(metadata => {
            if (!metadata.images[filename]) {
                const err = new Error(`Background '${filename}' not found in metadata.`);
                err.statusCode = 404;
                throw err;
            }
            // Update the folderIds property for the specified image
            metadata.images[filename].folderIds = folderIds;
        });

        return response.status(200).send('ok');
    } catch (error) {
        console.error(`Failed to update folder IDs for ${request.body.filename}:`, error);
        const statusCode = error.statusCode || 500;
        const message = error.statusCode ? error.message : 'Failed to update background metadata.';
        return response.status(statusCode).send(message);
    }
});

/**
 * Handles the creation of a new background folder.
 * @param {express.Request & { body: { name: string }, user: any }} request
 * @param {express.Response} response
 */
router.post('/folders/create', async function (request, response) {
    if (!request.body || typeof request.body.name !== 'string') {
        return response.status(400).send('Folder name is required.');
    }

    try {
        const manager = new BackgroundsMetadataManager(request.user.directories);
        const newFolder = await manager.update(metadata => {
            if (!Array.isArray(metadata.folders)) {
                metadata.folders = [];
            }

            const folder = {
                id: uuidv4(),
                name: sanitize(request.body.name),
            };

            metadata.folders.push(folder);
            return folder;
        });

        response.status(201).json(newFolder); // Send back the created folder
    } catch (error) {
        console.error('Failed to create folder:', error);
        return response.status(500).send('Failed to update background metadata.');
    }
});

/**
 * Handles the deletion of a background folder.
 * @param {express.Request & { body: { folderId: string }, user: any }} request
 * @param {express.Response} response
 */
router.post('/folders/delete', async function (request, response) {
    if (!request.body || typeof request.body.folderId !== 'string') {
        return response.status(400).send('Folder ID is required.');
    }

    try {
        const { folderId } = request.body;
        const manager = new BackgroundsMetadataManager(request.user.directories);

        await manager.update(metadata => {
            // 1. Remove the folder from the 'folders' array
            if (Array.isArray(metadata.folders)) {
                metadata.folders = metadata.folders.filter(f => f.id !== folderId);
            }

            // 2. Remove the folderId from any image that references it
            for (const filename in metadata.images) {
                const image = metadata.images[filename];
                if (Array.isArray(image.folderIds) && image.folderIds.includes(folderId)) {
                    image.folderIds = image.folderIds.filter(id => id !== folderId);
                }
            }
        });

        return response.status(200).send('ok');
    } catch (error) {
        console.error('Failed to delete folder:', error);
        return response.status(500).send('Failed to update background metadata.');
    }
});

/**
 * Handles the renaming of a background folder.
 * @param {express.Request & { body: { folderId: string, newName: string }, user: any }} request
 * @param {express.Response} response
 */
router.post('/folders/rename', async function (request, response) {
    if (!request.body || typeof request.body.folderId !== 'string' || typeof request.body.newName !== 'string') {
        return response.status(400).send('Folder ID and new name are required.');
    }

    try {
        const { folderId, newName } = request.body;
        const manager = new BackgroundsMetadataManager(request.user.directories);

        await manager.update(metadata => {
            const folderToUpdate = metadata.folders?.find(f => f.id === folderId);

            if (!folderToUpdate) {
                const err = new Error('Folder not found.');
                err.statusCode = 404;
                throw err;
            }

            folderToUpdate.name = sanitize(newName.trim());
        });

        return response.status(200).send('ok');
    } catch (error) {
        console.error('Failed to rename folder:', error);
        const statusCode = error.statusCode || 500;
        const message = error.statusCode ? error.message : 'Failed to update background metadata.';
        return response.status(statusCode).send(message);
    }
});

/**
 * Handles adding multiple backgrounds to a single folder in bulk.
 * @param {express.Request & { body: { filenames: string[], folderId: string }, user: any }} request
 * @param {express.Response} response
 */
router.post('/folders/add-bulk', async function (request, response) {
    if (!request.body || !Array.isArray(request.body.filenames) || typeof request.body.folderId !== 'string') {
        return response.status(400).send('Filenames array and folderId string are required.');
    }

    try {
        const { filenames, folderId } = request.body;
        const manager = new BackgroundsMetadataManager(request.user.directories);

        await manager.update(metadata => {
            // Ensure the folder exists.
            if (!metadata.folders?.some(f => f.id === folderId)) {
                const err = new Error('Target folder not found.');
                err.statusCode = 404;
                throw err;
            }

            for (const filename of filenames) {
                const image = metadata.images[sanitize(filename)];

                if (image) {
                    // Ensure the folderIds array exists
                    if (!Array.isArray(image.folderIds)) {
                        image.folderIds = [];
                    }
                    // Add the folderId if it's not already present
                    if (!image.folderIds.includes(folderId)) {
                        image.folderIds.push(folderId);
                    }
                }
            }
        });

        return response.status(200).send('ok');
    } catch (error) {
        console.error('Failed to bulk add backgrounds to folder:', error);
        const statusCode = error.statusCode || 500;
        const message = error.statusCode ? error.message : 'Failed to update background metadata.';
        return response.status(statusCode).send(message);
    }
});

/**
 * Handles setting a thumbnail for a specific folder.
 * @param {express.Request & { body: { folderId: string, filename: string | null }, user: any }} request
 * @param {express.Response} response
 */
router.post('/folders/set-thumbnail', async function (request, response) {
    if (!request.body || typeof request.body.folderId !== 'string') {
        return response.status(400).send('Folder ID is required.');
    }

    try {
        const { folderId, filename } = request.body;
        const manager = new BackgroundsMetadataManager(request.user.directories);

        await manager.update(metadata => {
            const folderToUpdate = metadata.folders?.find(f => f.id === folderId);

            if (!folderToUpdate) {
                const err = new Error('Folder not found.');
                err.statusCode = 404;
                throw err;
            }

            // Set the thumbnail file. If filename is null or undefined, it clears the thumbnail.
            folderToUpdate.thumbnailFile = filename ? sanitize(filename) : null;
        });

        return response.status(200).send('ok');
    } catch (error) {
        console.error('Failed to set folder thumbnail:', error);
        const statusCode = error.statusCode || 500;
        const message = error.statusCode ? error.message : 'Failed to update background metadata.';
        return response.status(statusCode).send(message);
    }
});
