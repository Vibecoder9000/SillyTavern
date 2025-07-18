import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import sanitize from 'sanitize-filename';
import { invalidateThumbnail, dimensions, generateThumbnail } from './thumbnails.js';
import { getImages } from '../util.js';
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
    if (!request.body) return response.sendStatus(400);

    const oldFileName = path.join(request.user.directories.backgrounds, sanitize(request.body.old_bg));
    const sanitizedNewName = sanitize(request.body.new_bg);
    const fileExtension = path.extname(sanitizedNewName);
    const baseName = path.basename(sanitizedNewName, fileExtension);

    let finalNewName = sanitizedNewName;
    let newFileName = path.join(request.user.directories.backgrounds, finalNewName);
    let counter = 1;

    // Loop as long as a file at the target path exists AND it's not the same as the source file.
    while (fs.existsSync(newFileName) && newFileName !== oldFileName) {
        finalNewName = `${baseName} (${counter})${fileExtension}`;
        newFileName = path.join(request.user.directories.backgrounds, finalNewName);
        counter++;
    }

    // If the final name is the same as the old one, it's a no-op. Return success without file operations.
    if (newFileName === oldFileName) {
        const thumbnailResult = await generateThumbnail(request.user.directories, 'bg', request.body.old_bg, false, true);
        return response.json({
            filename: request.body.old_bg,
            aspectRatio: thumbnailResult?.aspectRatio || null,
        });
    }

    if (!fs.existsSync(oldFileName)) {
        console.error('BG file not found');
        return response.sendStatus(400);
    }

    fs.copyFileSync(oldFileName, newFileName);
    fs.unlinkSync(oldFileName);

    invalidateThumbnail(request.user.directories, 'bg', request.body.old_bg);
    const thumbnailResult = await generateThumbnail(request.user.directories, 'bg', finalNewName, true, false);

    return response.json({
        filename: finalNewName,
        aspectRatio: thumbnailResult?.aspectRatio || null,
    });
});

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
    const { originalname: filename } = request.file;
    const userBgPath = path.join(request.user.directories.backgrounds, filename);
    const backgroundsJsonPath = path.join(request.user.directories.root, 'backgrounds.json');

    try {
        // Move the uploaded file from the temp location to the backgrounds folder
        await fsp.rename(tempPath, userBgPath);

        await generateThumbnail(request.user.directories, 'bg', filename, true, false);

        // Generate metadata for the newly uploaded file
        const newMetadata = await generateSingleFileMetadata(userBgPath);

        if (!newMetadata) {
            // If metadata generation fails, clean up the uploaded file
            await fsp.unlink(userBgPath);
            throw new Error(`Failed to generate metadata for ${filename}.`);
        }

        // Read the existing backgrounds.json
        let metadataFile;
        try {
            const rawData = await fsp.readFile(backgroundsJsonPath, 'utf8');
            metadataFile = JSON.parse(rawData);
        } catch (error) {
            // If the file doesn't exist, create a fresh structure
            metadataFile = { version: 1, images: {}, folders: [], tags: [] };
        }

        // Add the new image's metadata and save the file
        metadataFile.images[filename] = newMetadata;
        const jsonString = JSON.stringify(metadataFile, null, 4);
        await fsp.writeFile(backgroundsJsonPath, jsonString, 'utf8');

        // Send back the complete metadata for the new file to the client
        response.json({ filename, ...newMetadata });

    } catch (err) {
        console.error('Background upload failed:', err);
        // Clean up the temp file if it still exists on error
        try { await fsp.unlink(tempPath); } catch { /* ignore */ }

        if (!response.headersSent) {
            response.status(500).send('Failed to process uploaded file.');
        }
    }
});
