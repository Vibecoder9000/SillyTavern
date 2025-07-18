import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import sanitize from 'sanitize-filename';
import { invalidateThumbnail, dimensions, generateThumbnail } from './thumbnails.js';
import { getImages } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

export const router = express.Router();

/**
 * Handles the request to get all background image filenames and their aspect ratios.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
router.post('/all', async function (request, response) {
    const bgFileNames = getImages(request.user.directories.backgrounds);
    bgFileNames.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const allImages = await Promise.all(bgFileNames.map(async (filename) => {
        const result = await generateThumbnail(request.user.directories, 'bg', filename, false, true);
        return {
            filename: filename,
            aspectRatio: result?.aspectRatio || null,
        };
    }));

    const config = { width: dimensions.bg[0], height: dimensions.bg[1] };
    response.json({ images: allImages, config });
});

/**
 * Handles the request to delete a background image.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
router.post('/delete', getFileNameValidationFunction('bg'), function (request, response) {
    if (!request.body) return response.sendStatus(400);
    const fileName = path.join(request.user.directories.backgrounds, request.body.bg);
    if (!fs.existsSync(fileName)) {
        console.error('BG file not found');
        return response.sendStatus(400);
    }
    fs.unlinkSync(fileName);
    invalidateThumbnail(request.user.directories, 'bg', request.body.bg);
    return response.send('ok');
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
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
router.post('/upload', async function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const img_path = path.join(request.file.destination, request.file.filename);
    const { originalname: filename } = request.file;

    try {
        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename));
        fs.unlinkSync(img_path);

        // Generate a thumbnail for static images
        await generateThumbnail(request.user.directories, 'bg', filename, true, false);

        response.send(filename);
    } catch (err) {
        console.error(err);
        if (!response.headersSent) {
            response.sendStatus(500);
        }
    }
});
