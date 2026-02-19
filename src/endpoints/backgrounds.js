import fs from 'node:fs';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { invalidateThumbnail } from './thumbnails.js';
import { thumbnailDimensions, readMetadataIndex, renameMetadata, removeMetadata, getOrGenerateMetadataBatch } from './image-metadata.js';
import { getImages } from '../util.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';

export const router = express.Router();

router.post('/all', async function (request, response) {
    const images = getImages(request.user.directories.backgrounds);
    const config = { width: thumbnailDimensions.bg[0], height: thumbnailDimensions.bg[1] };
    response.json({ images, config });
});

/**
 * POST /api/backgrounds/folders
 * Returns folders and per-image folderIds from the metadata index.
 * Loaded separately from /all to avoid blocking image rendering.
 */
router.post('/folders', async function (request, response) {
    try {
        const index = await readMetadataIndex(request.user.directories.root);
        const folders = index.folders || [];

        // Build a slim map of image → folderIds for the frontend
        /** @type {Object.<string, string[]>} */
        const imageFolderMap = {};
        for (const [relativePath, meta] of Object.entries(index.images)) {
            if (Array.isArray(meta.folderIds) && meta.folderIds.length > 0) {
                // Strip the directory prefix to get just the filename
                const filename = relativePath.split('/').pop() || relativePath;
                imageFolderMap[filename] = meta.folderIds;
            }
        }

        response.json({ folders, imageFolderMap });
    } catch (error) {
        console.error('[Backgrounds] Folders endpoint error:', error);
        response.status(500).json({ error: 'Internal server error.' });
    }
});

router.post('/delete', getFileNameValidationFunction('bg'), async function (request, response) {
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

    // Remove metadata entry (including folder assignments)
    try {
        const relPath = `backgrounds/${sanitize(request.body.bg)}`;
        await removeMetadata(request.user.directories.root, relPath);
    } catch (/** @type {any} */ err) {
        console.debug('[Backgrounds] Metadata removal skipped:', err?.message);
    }

    return response.send('ok');
});

router.post('/rename', async function (request, response) {
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

    // Update metadata index key so folder assignments are preserved
    try {
        const oldRelPath = `backgrounds/${sanitize(request.body.old_bg)}`;
        const newRelPath = `backgrounds/${sanitize(request.body.new_bg)}`;
        await renameMetadata(request.user.directories.root, oldRelPath, newRelPath);
    } catch (/** @type {any} */ err) {
        // Non-fatal: metadata entry may not exist yet
        console.debug('[Backgrounds] Metadata rename skipped:', err?.message);
    }

    return response.send('ok');
});

router.post('/upload', function (request, response) {
    if (!request.body || !request.file) return response.sendStatus(400);

    const img_path = path.join(request.file.destination, request.file.filename);
    const filename = sanitize(request.file.originalname);

    try {
        fs.copyFileSync(img_path, path.join(request.user.directories.backgrounds, filename));
        fs.unlinkSync(img_path);
        invalidateThumbnail(request.user.directories, 'bg', filename);

        // Generate metadata for the new image
        const relativePath = path.join('backgrounds', filename);
        getOrGenerateMetadataBatch(request.user.directories.root, [relativePath], 'bg').catch(err => {
            console.warn('[Backgrounds] Failed to generate metadata for upload:', err.message);
        });

        response.send(filename);
    } catch (err) {
        console.error(err);
        response.sendStatus(500);
    }
});
