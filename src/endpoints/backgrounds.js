import fs from 'node:fs';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { invalidateThumbnail } from './thumbnails.js';
import { getImages } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

export const router = express.Router();

router.post('/all', async function (request, response) {
    if (!request.user.directories.root) { // Check for .root instead of .userData
        console.error('User root directory not defined. Cannot load aspect ratios.');
        return response.status(500).json({ error: 'User root directory not configured.' });
    }
    const aspectFilePath = path.join(request.user.directories.root, 'aspect_ratios.json'); // Use .root
    let aspectRatiosMap = {};

    try {
        if (fs.existsSync(aspectFilePath)) {
            const fileContent = await fsPromises.readFile(aspectFilePath, 'utf8');
            aspectRatiosMap = JSON.parse(fileContent);
        }
    } catch (err) {
        console.warn(`Error reading or parsing aspect_ratios.json: ${err.message}. Proceeding without aspect ratios for some items.`);
        aspectRatiosMap = {}; // Default to empty map on error
    }

    const imageFilenames = getImages(request.user.directories.backgrounds);
    const imagesWithData = imageFilenames.map(filename => {
        return {
            filename: filename,
            aspectRatio: aspectRatiosMap[filename] || null
        };
    });
    response.json({ images: imagesWithData });
});

router.post('/delete', getFileNameValidationFunction('bg'), function (request, response) {
    if (!request.body) return response.sendStatus(400);

    if (request.body.bg !== sanitize(request.body.bg)) {
        console.error('Malicious bg name prevented');
        return response.sendStatus(403);
    }

    const fileName = path.join(request.user.directories.backgrounds, sanitize(request.body.bg));

    if (!fs.existsSync(fileName)) {
        console.error('BG file not found');
        return response.sendStatus(400);
    }

    fs.unlinkSync(fileName);
    invalidateThumbnail(request.user.directories, 'bg', request.body.bg);
    return response.send('ok');
});

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

router.post('/upload', function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const img_path = path.join(request.file.destination, request.file.filename);
    const filename = request.file.originalname;

    try {
        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename));
        fs.unlinkSync(img_path);
        invalidateThumbnail(request.user.directories, 'bg', filename);
        response.send(filename);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});
