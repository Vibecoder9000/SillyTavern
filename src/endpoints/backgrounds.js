import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

// Import generateThumbnail as well
import { dimensions, invalidateThumbnail, generateThumbnail } from './thumbnails.js';
import { getImages } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

export const router = express.Router();

router.post('/all', async function (request, response) { // Made async
    const images = getImages(request.user.directories.backgrounds);
    const config = { width: dimensions.bg[0], height: dimensions.bg[1] };

    let aspects = {};
    const aspectFilePath = path.join(request.user.directories.root, 'aspect_ratios.json');
    try {
        const data = await fs.promises.readFile(aspectFilePath, 'utf8'); // Use fs.promises
        aspects = JSON.parse(data);
    } catch (err) {
        if (err.code === 'ENOENT') {
            console.log(`[Backgrounds API /all] aspect_ratios.json not found for user ${request.user.username}. Sending empty aspects.`);
        } else {
            console.error(`[Backgrounds API /all] Error reading aspect_ratios.json for user ${request.user.username}:`, err);
        }
        // aspects remains {}
    }

    response.json({ images, config, aspects });
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
        const finalPath = path.join(request.user.directories.backgrounds, filename);
        fs.copyFileSync(img_path, finalPath);
        console.log(`[Backgrounds Upload] Copied ${filename} to ${finalPath}`);
        fs.unlinkSync(img_path);
        console.log(`[Backgrounds Upload] Deleted temp file ${img_path}`);

        // Invalidate any old thumbnail first
        invalidateThumbnail(request.user.directories, 'bg', filename);
        console.log(`[Backgrounds Upload] Invalidated old thumbnail for ${filename} (if any).`);

        // Now generate new thumbnail and save its aspect ratio
        let currentAspectRatios = {};
        const aspectFilePath = path.join(request.user.directories.root, 'aspect_ratios.json');
        try {
            const data = await fs.promises.readFile(aspectFilePath, 'utf8');
            currentAspectRatios = JSON.parse(data);
        } catch (err) {
            if (err.code !== 'ENOENT') {
                console.error(`[Backgrounds Upload] Error reading ${aspectFilePath} for ${filename}: ${err.message}`);
            } else {
                console.log(`[Backgrounds Upload] ${aspectFilePath} not found for ${filename}, will create if new AR is generated.`);
            }
        }

        const thumbnailResult = await generateThumbnail(request.user.directories, 'bg', filename, currentAspectRatios);

        if (thumbnailResult && thumbnailResult.aspectRatio !== null) {
            // generateThumbnail updated currentAspectRatios in memory, now write it to disk.
            try {
                console.log(`[Backgrounds Upload] Attempting to write updated aspect ratios to ${aspectFilePath} for file ${filename}`);
                await fs.promises.writeFile(aspectFilePath, JSON.stringify(currentAspectRatios, null, 2), 'utf8');
                console.log(`[Backgrounds Upload] Updated ${aspectFilePath} for ${filename} with AR: ${thumbnailResult.aspectRatio}`);
            } catch (writeErr) {
                console.error(`[Backgrounds Upload] Error writing updated ${aspectFilePath} for ${filename}: ${writeErr.message}`);
            }
        } else {
            console.warn(`[Backgrounds Upload] Thumbnail generation for ${filename} did not return a valid aspect ratio. aspect_ratios.json may not be updated for this file.`);
        }

        response.send(filename);
    } catch (err) {
        console.error('[Backgrounds Upload] Error during upload process:', err);
        response.sendStatus(500);
    }
});
