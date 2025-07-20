import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import sanitize from 'sanitize-filename';
import crypto from 'node:crypto';
import { invalidateThumbnail, dimensions, generateThumbnail } from './thumbnails.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { generateSingleFileMetadata } from './backgrounds-manager.js';

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

export const router = express.Router();

/**
 * Handles the request to get all background images and their metadata.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
router.post('/all', async function (request, response) {
    const release = await fileLock.acquire();
    try {
        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');
        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        // The frontend expects an array of image data. The keys of the 'images' object are the filenames, so we need to transform it
        const allImages = Object.entries(metadata.images).map(([filename, data]) => ({
            filename: filename,
            ...data,
        }));

        const config = { width: dimensions.bg[0], height: dimensions.bg[1] };
        const folders = metadata.folders || []; // Get folders from metadata

        response.json({ images: allImages, config, folders }); // Add folders to the response

    } catch (error) {
        console.error('Failed to read or parse backgrounds.json:', error);
        response.json({ images: [], config: { width: dimensions.bg[0], height: dimensions.bg[1] }, folders: [] });
    } finally {
        release();
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

    const release = await fileLock.acquire();
    try {
        const filename = request.body.bg;
        const filePath = path.join(request.user.directories.backgrounds, filename);
        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');

        try {
            await fsp.unlink(filePath);
        } catch (fileError) {
            if (fileError.code !== 'ENOENT') {
                console.warn(`Could not delete background file ${filename}:`, fileError);
            }
        }

        invalidateThumbnail(request.user.directories, 'bg', filename);

        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        if (metadata.images[filename]) {
            delete metadata.images[filename];
            const jsonString = JSON.stringify(metadata, null, 4);
            await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');
        }

        return response.status(200).send('ok');

    } catch (error) {
        console.error(`Failed to process delete request for ${request.body.bg}:`, error);
        return response.status(500).send('Failed to delete background.');
    } finally {
        release();
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

    const release = await fileLock.acquire();
    try {
        const oldFilename = sanitize(request.body.old_bg);
        // The original desired name from the user
        const desiredNewFilename = sanitize(request.body.new_bg);

        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');
        const backgroundsFolderPath = request.user.directories.backgrounds;
        const thumbnailsFolderPath = request.user.directories.thumbnailsBg;

        // If the names are the same, it's a no-op. Return the existing data.
        if (oldFilename === desiredNewFilename) {
            const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
            const metadata = JSON.parse(rawData);
            return response.json({ filename: oldFilename, ...metadata.images[oldFilename] });
        }

        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        const oldMetadata = metadata.images[oldFilename];
        if (!oldMetadata) {
            return response.status(404).send(`Background '${oldFilename}' not found in metadata.`);
        }

        // Determine the unique filename to use, handling potential conflicts.
        const finalNewFilename = await getUniqueFilename(backgroundsFolderPath, desiredNewFilename);

        // 1. Rename the main background file using the final unique name.
        const oldFilePath = path.join(backgroundsFolderPath, oldFilename);
        const newFilePath = path.join(backgroundsFolderPath, finalNewFilename);
        await fsp.rename(oldFilePath, newFilePath);

        // 2. Rename the corresponding thumbnail file using the final unique name.
        const oldThumbPath = path.join(thumbnailsFolderPath, oldFilename);
        const newThumbPath = path.join(thumbnailsFolderPath, finalNewFilename);

        try {
            await fsp.access(oldThumbPath); // Check for existence
            await fsp.rename(oldThumbPath, newThumbPath);
        } catch (thumbError) {
            // If the thumbnail doesn't exist (ENOENT), it's not a critical error.
            if (thumbError.code !== 'ENOENT') {
                console.warn(`[Rename] Could not rename thumbnail for ${oldFilename}:`, thumbError);
            }
        }

        // 3. Update the metadata object in memory using the final unique name.
        delete metadata.images[oldFilename];
        metadata.images[finalNewFilename] = oldMetadata;

        // 4. Save the updated backgrounds.json.
        const jsonString = JSON.stringify(metadata, null, 4);
        await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');

        // 5. Respond with the final unique name and its metadata.
        response.json({ filename: finalNewFilename, ...oldMetadata });

    } catch (error) {
        console.error(`Failed to rename background from ${request.body.old_bg} to ${request.body.new_bg}:`, error);
        return response.status(500).send('Failed to rename background.');
    } finally {
        release();
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
router.post('/upload', async function (request, response) {
    if (!request.body || !request.file) {
        return response.status(400).send('No file uploaded.');
    }

    const release = await fileLock.acquire();
    try {
        // 1. Get a unique filename to prevent overwriting
        const tempPath = request.file.path;
        const backgroundsFolderPath = request.user.directories.backgrounds;
        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');

        const uniqueFilename = await getUniqueFilename(backgroundsFolderPath, request.file.originalname);
        const finalBgPath = path.join(backgroundsFolderPath, uniqueFilename);

        // 2. Move the uploaded file to its final destination with the unique name
        await fsp.rename(tempPath, finalBgPath);

        // 3. Generate thumbnail and metadata for the file with its new unique name
        await generateThumbnail(request.user.directories, 'bg', uniqueFilename, true, false);
        const newMetadata = await generateSingleFileMetadata(finalBgPath);

        if (!newMetadata) {
            await fsp.unlink(finalBgPath); // Clean up if metadata fails
            throw new Error(`Failed to generate metadata for ${uniqueFilename}.`);
        }

        // 4. Read, update, and write backgrounds.json
        let metadataFile;
        try {
            const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
            metadataFile = JSON.parse(rawData);
        } catch {
            metadataFile = { version: 1, images: {}, folders: [], tags: [] };
        }

        metadataFile.images[uniqueFilename] = newMetadata;
        const jsonString = JSON.stringify(metadataFile, null, 4);
        await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');

        // 5. Send back the complete metadata including the FINAL unique filename
        response.json({ filename: uniqueFilename, ...newMetadata });

    } catch (err) {
        console.error('Background upload failed:', err);
        try { await fsp.unlink(request.file.path); } catch { /* ignore */ }
        if (!response.headersSent) {
            response.status(500).send('Failed to process uploaded file.');
        }
    } finally {
        release();
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

    const release = await fileLock.acquire();
    try {
        const filename = sanitize(request.body.filename);
        const { isStarred } = request.body;
        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');

        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        if (!metadata.images[filename]) {
            return response.status(404).send(`Background '${filename}' not found in metadata.`);
        }

        // Update the isStarred property
        metadata.images[filename].isStarred = isStarred;

        // Save the updated backgrounds.json
        const jsonString = JSON.stringify(metadata, null, 4);
        await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');

        return response.status(200).send('ok');

    } catch (error) {
        console.error(`Failed to update star status for ${request.body.filename}:`, error);
        return response.status(500).send('Failed to update background metadata.');
    } finally {
        release();
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

    const release = await fileLock.acquire();
    try {
        const filename = sanitize(request.body.filename);
        const { folderIds } = request.body;
        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');

        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        if (!metadata.images[filename]) {
            return response.status(404).send(`Background '${filename}' not found in metadata.`);
        }

        // Update the folderIds property for the specified image
        metadata.images[filename].folderIds = folderIds;

        // Save the updated backgrounds.json
        const jsonString = JSON.stringify(metadata, null, 4);
        await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');

        return response.status(200).send('ok');

    } catch (error) {
        console.error(`Failed to update folder IDs for ${request.body.filename}:`, error);
        return response.status(500).send('Failed to update background metadata.');
    } finally {
        release();
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

    const release = await fileLock.acquire();
    try {
        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');
        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        if (!Array.isArray(metadata.folders)) {
            metadata.folders = [];
        }

        const newFolder = {
            id: crypto.randomUUID(),
            name: sanitize(request.body.name),
        };

        metadata.folders.push(newFolder);

        const jsonString = JSON.stringify(metadata, null, 4);
        await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');

        response.status(201).json(newFolder); // Send back the created folder

    } catch (error) {
        console.error('Failed to create folder:', error);
        return response.status(500).send('Failed to update background metadata.');
    } finally {
        release();
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

    const release = await fileLock.acquire();
    try {
        const { folderId } = request.body;
        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');
        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

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

        const jsonString = JSON.stringify(metadata, null, 4);
        await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');

        return response.status(200).send('ok');

    } catch (error) {
        console.error('Failed to delete folder:', error);
        return response.status(500).send('Failed to update background metadata.');
    } finally {
        release();
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

    const release = await fileLock.acquire();
    try {
        const { folderId, newName } = request.body;
        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');
        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        const folderToUpdate = metadata.folders?.find(f => f.id === folderId);

        if (!folderToUpdate) {
            return response.status(404).send('Folder not found.');
        }

        folderToUpdate.name = sanitize(newName.trim());

        const jsonString = JSON.stringify(metadata, null, 4);
        await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');

        return response.status(200).send('ok');

    } catch (error) {
        console.error('Failed to rename folder:', error);
        return response.status(500).send('Failed to update background metadata.');
    } finally {
        release();
    }
});
