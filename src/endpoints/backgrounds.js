import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';
import {
    dimensions,
    invalidateThumbnail,
    generateThumbnail,
    currentMetadataVersion as sharedMetadataVersion,
} from './thumbnails.js';
import { sync as sharedWriteFileAtomicSync } from 'write-file-atomic';
import { getImages } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import { ASPECT_RATIOS_FILENAME } from '../constants.js';

export const router = express.Router();

router.post('/all', function (request, response) {
    const images = getImages(request.user.directories.backgrounds);

    images.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));

    const config = { width: dimensions.bg[0], height: dimensions.bg[1] };
    if (!request.user.directories.root) {
        console.error('User root directory not defined. Cannot load aspect ratios for /all endpoint.');
        return response.json({ images, config, aspects: {} });
    }
    const aspectRatiosJsonPath = path.join(request.user.directories.root, ASPECT_RATIOS_FILENAME);
    let aspects = {};

    try {
        if (fs.existsSync(aspectRatiosJsonPath)) {
            aspects = JSON.parse(fs.readFileSync(aspectRatiosJsonPath, 'utf-8'));
        }
    } catch (e) {
        console.error(`Failed to read or parse aspect_ratios.json: ${e.message}`, e);
        aspects = {};
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
    const { originalname: filename } = request.file;

    try {
        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename));
        fs.unlinkSync(img_path);

        // Proactively generate thumbnail and aspect ratio for the new upload.
        (async () => {
            try {
                const thumbnailResult = await generateThumbnail(request.user.directories, 'bg', filename);

                if (!request.user.directories.root) {
                    console.error('[Upload] User root directory not defined. Cannot update aspect ratios.');
                    return;
                }

                const userRootPath = request.user.directories.root;
                const aspectRatiosJsonPath = path.join(userRootPath, ASPECT_RATIOS_FILENAME);

                if (thumbnailResult && thumbnailResult.aspectRatio !== undefined) {
                    let aspectRatiosData = {};
                    if (fs.existsSync(aspectRatiosJsonPath)) {
                        try {
                            const jsonDataString = fs.readFileSync(aspectRatiosJsonPath, 'utf-8');
                            aspectRatiosData = JSON.parse(jsonDataString);
                        } catch (e) {
                            console.error(`[Upload] Failed to parse aspect_ratios.json: ${e.message}. Initializing new object.`);
                            aspectRatiosData = {};
                        }
                    }

                    const currentVersionInFile = aspectRatiosData._metadata_version;
                    delete aspectRatiosData._metadata_version;

                    if (aspectRatiosData[filename] !== thumbnailResult.aspectRatio || currentVersionInFile !== sharedMetadataVersion) {
                        aspectRatiosData[filename] = thumbnailResult.aspectRatio;
                        aspectRatiosData._metadata_version = sharedMetadataVersion;
                        try {
                            sharedWriteFileAtomicSync(aspectRatiosJsonPath, JSON.stringify(aspectRatiosData, null, 2));
                        } catch (e) {
                            console.error(`[Upload] Failed to write aspect_ratios.json in ${userRootPath}: ${e.message}`);
                        }
                    }
                }
            } catch (e) {
                console.error(`[Upload] Error during thumbnail generation or aspect ratio update for ${filename}: ${e.message}`);
            }
        })();

        response.send(filename);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});
