import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

// invalidateThumbnail is still used for /delete and /rename, dimensions for /all
import {
    dimensions,
    invalidateThumbnail,
    generateThumbnail,
    getThumbnailFolder,
    currentMetadataVersion as sharedMetadataVersion,
    writeFileAtomicSync as sharedWriteFileAtomicSync
} from './thumbnails.js';
import { getImages } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

export const router = express.Router();

router.post('/all', function (request, response) {
    const images = getImages(request.user.directories.backgrounds);
    const config = { width: dimensions.bg[0], height: dimensions.bg[1] };
    if (!request.user.directories.root) {
        console.error('User root directory not defined. Cannot load aspect ratios for /all endpoint.');
        // Send empty aspects or handle error as appropriate for your frontend
        return response.json({ images, config, aspects: {} });
    }
    const aspectRatiosJsonPath = path.join(request.user.directories.root, 'aspect_ratios.json');
    let aspects = {};

    try {
        if (fs.existsSync(aspectRatiosJsonPath)) {
            aspects = JSON.parse(fs.readFileSync(aspectRatiosJsonPath, 'utf-8'));
        }
    } catch (e) {
        console.error('Failed to read or parse aspect_ratios.json:', e);
        aspects = {}; // Ensure aspects is an empty object on error
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
    // Ensure filename is from originalname, as sanitize might have been applied to request.file.filename
    const { originalname: filename } = request.file;

    try {
        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename));
        fs.unlinkSync(img_path);
        // invalidateThumbnail(request.user.directories, 'bg', filename); // Removed old call

        // New logic to update aspect_ratios.json
        (async () => { // IIFE to use async/await
            try {
                const thumbnailResult = await generateThumbnail(request.user.directories, 'bg', filename);

                if (!request.user.directories.root) {
                    console.error('[Upload] User root directory not defined. Cannot update aspect ratios.');
                } else {
                    const userRootPath = request.user.directories.root;
                    const aspectRatiosJsonPath = path.join(userRootPath, 'aspect_ratios.json');
                    // const versionFilePath = path.join(userRootPath, 'aspect_metadata_version.txt'); // REMOVED

                    if (thumbnailResult && thumbnailResult.aspectRatio !== undefined) {
                        let aspectRatiosData = {}; // This will hold all data including metadata key
                        if (fs.existsSync(aspectRatiosJsonPath)) {
                            try {
                                const jsonDataString = fs.readFileSync(aspectRatiosJsonPath, 'utf-8');
                                aspectRatiosData = JSON.parse(jsonDataString);
                            } catch (e) {
                                console.error(`[Upload] Failed to parse aspect_ratios.json: ${e.message}. Initializing new object.`);
                                aspectRatiosData = {}; // Initialize if parse fails
                            }
                        }

                        // Separate metadata from actual aspect ratios for comparison/update
                        const currentVersionInFile = aspectRatiosData._metadata_version;
                        delete aspectRatiosData._metadata_version; // Work with clean aspect ratios

                        if (aspectRatiosData[filename] !== thumbnailResult.aspectRatio) {
                            aspectRatiosData[filename] = thumbnailResult.aspectRatio;
                            aspectRatiosData._metadata_version = sharedMetadataVersion; // Add/update version before writing
                            try {
                                sharedWriteFileAtomicSync(aspectRatiosJsonPath, JSON.stringify(aspectRatiosData, null, 2));
                                console.info(`[Upload] Updated aspect_ratios.json in ${userRootPath} for: ${filename} -> ${thumbnailResult.aspectRatio}. Version: ${sharedMetadataVersion}`);
                                // fs.writeFileSync(versionFilePath, sharedMetadataVersion); // REMOVED
                            } catch (e) {
                                 console.error(`[Upload] Failed to write aspect_ratios.json in ${userRootPath}: ${e.message}`);
                            }
                        } else if (currentVersionInFile !== sharedMetadataVersion) {
                            // Aspect ratio is the same, but if version was different (e.g. old file format), update version
                            aspectRatiosData._metadata_version = sharedMetadataVersion;
                             try {
                                sharedWriteFileAtomicSync(aspectRatiosJsonPath, JSON.stringify(aspectRatiosData, null, 2));
                                console.info(`[Upload] Updated version in aspect_ratios.json in ${userRootPath} for: ${filename}. Version: ${sharedMetadataVersion}`);
                            } catch (e) {
                                 console.error(`[Upload] Failed to write aspect_ratios.json (version update) in ${userRootPath}: ${e.message}`);
                            }
                        }

                    } else if (thumbnailResult === null) { // If thumbnail generation failed or was skipped
                        if (fs.existsSync(aspectRatiosJsonPath)) {
                            try {
                                let aspectRatiosData = JSON.parse(fs.readFileSync(aspectRatiosJsonPath, 'utf-8'));
                                // const currentVersionInFile = aspectRatiosData._metadata_version; // Not strictly needed for delete
                                delete aspectRatiosData._metadata_version;

                                if (aspectRatiosData.hasOwnProperty(filename)) {
                                    delete aspectRatiosData[filename];
                                    aspectRatiosData._metadata_version = sharedMetadataVersion; // Add/update version before writing
                                    sharedWriteFileAtomicSync(aspectRatiosJsonPath, JSON.stringify(aspectRatiosData, null, 2));
                                    console.info(`[Upload] Removed entry for ${filename} from aspect_ratios.json in ${userRootPath}. Updated version to ${sharedMetadataVersion}.`);
                                    // fs.writeFileSync(versionFilePath, sharedMetadataVersion); // REMOVED
                                }
                            } catch (e) {
                                console.error(`[Upload] Error processing aspect_ratios.json (for removal) in ${userRootPath} for ${filename}: ${e.message}`);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`[Upload] Error during thumbnail generation or aspect ratio update for ${filename}: ${e.message}`);
            }
        })(); // End of IIFE

        response.send(filename);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});
