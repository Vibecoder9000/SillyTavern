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
router.post('/rename', function (request, response) {
    if (!request.body) return response.sendStatus(400);
    const oldFileName = path.join(request.user.directories.backgrounds, sanitize(request.body.old_bg));
    const newFileName = path.join(request.user.directories.backgrounds, sanitize(request.body.new_bg));
    if (!fs.existsSync(oldFileName)) {
        console.error('BG file not found');
        return response.sendStatus(400);
    }
    if (fs.existsSync(newFileName)) {
        console.error('New BG file already exists');
        return response.sendStatus(400);
    }
    fs.copyFileSync(oldFileName, newFileName);
    fs.unlinkSync(oldFileName);
    invalidateThumbnail(request.user.directories, 'bg', request.body.old_bg);
    return response.send('ok');
});

/**
 * Handles the upload of a new background image.
 * @param {express.Request} request - The Express request object.
 * @param {express.Response} response - The Express response object.
 */
router.post('/upload', function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);
    const img_path = path.join(request.file.destination, request.file.filename);
    const { originalname: filename } = request.file;
    try {
        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename));
        fs.unlinkSync(img_path);
        // Attempt to generate a thumbnail for the newly uploaded image on-demand.
        // This will succeed for static formats like JPG/PNG.
        generateThumbnail(request.user.directories, 'bg', filename, true, false);
        response.send(filename);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});