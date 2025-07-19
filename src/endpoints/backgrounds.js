import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import sanitize from 'sanitize-filename';
import { invalidateThumbnail, dimensions, generateThumbnail } from './thumbnails.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { generateSingleFileMetadata } from './backgrounds-manager.js';

export const router = express.Router();

/**
 * Handles the request to get all background images and their metadata.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
router.post('/all', async function (request, response) {
    try {
        const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');
        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        // The frontend expects an array of image data. The keys of the 'images' object are the filenames, so we need to transform it
        const allImages = Object.entries(metadata.images).map(([filename, data]) => ({
            filename: filename,
            ...data,
        }));

        // Sort the images alphabetically by filename, with numeric sorting
        allImages.sort((a, b) => a.filename.localeCompare(b.filename, undefined, { numeric: true, sensitivity: 'base' }));

        // Use the thumbnail dimensions already available in the module
        const config = { width: dimensions.bg[0], height: dimensions.bg[1] };

        response.json({ images: allImages, config });

    } catch (error) {
        console.error('Failed to read or parse backgrounds.json:', error);
        // If the file doesn't exist or is corrupt, send an empty array to prevent frontend errors
        response.json({ images: [], config: { width: dimensions.bg[0], height: dimensions.bg[1] } });
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

    const filename = request.body.bg;
    const filePath = path.join(request.user.directories.backgrounds, filename);
    const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');

    try {
        // 1. Delete the physical file if it exists.
        try {
            await fsp.unlink(filePath);
        } catch (fileError) {
            // Ignore "file not found" errors, but log others.
            if (fileError.code !== 'ENOENT') {
                console.warn(`Could not delete background file ${filename}:`, fileError);
            }
        }

        // 2. Invalidate the associated thumbnail.
        invalidateThumbnail(request.user.directories, 'bg', filename);

        // 3. Read backgrounds.json, remove the entry, and save.
        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        // Check if the key exists before deleting
        if (metadata.images[filename]) {
            delete metadata.images[filename];
            const jsonString = JSON.stringify(metadata, null, 4);
            await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');
        }

        // 4. Send a success response.
        return response.status(200).send('ok');

    } catch (error) {
        console.error(`Failed to process delete request for ${filename}:`, error);
        return response.status(500).send('Failed to delete background.');
    }
});

/**
 * Handles the request to rename a background image.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
router.post('/rename', async function (request, response) {
    if (!request.body || !request.body.old_bg || !request.body.new_bg) {
        return response.status(400).send('Old and new filenames are required.');
    }

    const oldFilename = sanitize(request.body.old_bg);
    const newFilename = sanitize(request.body.new_bg);
    const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');
    const backgroundsFolderPath = request.user.directories.backgrounds;
    const thumbnailsFolderPath = request.user.directories.thumbnailsBg;

    if (oldFilename === newFilename) {
        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);
        return response.json({ filename: oldFilename, ...metadata.images[oldFilename] });
    }

    try {
        const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
        const metadata = JSON.parse(rawData);

        const oldMetadata = metadata.images[oldFilename];
        if (!oldMetadata) {
            return response.status(404).send(`Background '${oldFilename}' not found in metadata.`);
        }

        // 1. Rename the main background file.
        const oldFilePath = path.join(backgroundsFolderPath, oldFilename);
        const newFilePath = path.join(backgroundsFolderPath, newFilename);
        await fsp.rename(oldFilePath, newFilePath);

        // 2. Find and rename the corresponding thumbnail file.
        const allThumbnails = await fsp.readdir(thumbnailsFolderPath);
        const oldThumbFilename = allThumbnails.find(thumb => thumb.startsWith(oldFilename));

        if (oldThumbFilename) {
            const oldThumbPath = path.join(thumbnailsFolderPath, oldThumbFilename);
            const newThumbFilename = oldThumbFilename.replace(oldFilename, newFilename);
            const newThumbPath = path.join(thumbnailsFolderPath, newThumbFilename);
            await fsp.rename(oldThumbPath, newThumbPath);
        } else {
            console.warn(`[Rename] No thumbnail found for ${oldFilename}. It will be regenerated on next access.`);
        }

        // 3. Update the metadata object in memory.
        delete metadata.images[oldFilename];
        metadata.images[newFilename] = oldMetadata;

        // 4. Save the updated backgrounds.json.
        const jsonString = JSON.stringify(metadata, null, 4);
        await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');

        // 5. Send back the updated metadata object.
        response.json({ filename: newFilename, ...oldMetadata });

    } catch (error) {
        console.error(`Failed to rename background from ${oldFilename} to ${newFilename}:`, error);
        return response.status(500).send('Failed to rename background.');
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

    const tempPath = request.file.path;
    const backgroundsFolderPath = request.user.directories.backgrounds;
    const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');

    try {
        // 1. Get a unique filename to prevent overwriting
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
        try { await fsp.unlink(tempPath); } catch { /* ignore */ }

        if (!response.headersSent) {
            response.status(500).send('Failed to process uploaded file.');
        }
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

    const filename = sanitize(request.body.filename);
    const { isStarred } = request.body;
    const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');

    try {
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

        // Send a success response
        return response.status(200).send('ok');

    } catch (error) {
        console.error(`Failed to update star status for ${filename}:`, error);
        return response.status(500).send('Failed to update background metadata.');
    }
});
