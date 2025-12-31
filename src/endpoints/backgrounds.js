import fsp from 'node:fs/promises';
import path from 'node:path';

import express from 'express';
import sanitize from 'sanitize-filename';

import { invalidateThumbnail, dimensions, generateThumbnail, SKIPPED_EXTENSIONS, ALLOWED_IMAGE_EXTENSIONS } from './thumbnails.js';
import { getFileNameValidationFunction } from '../middleware/validateFileName.js';
import {
    generateImageMetadata,
    readMetadataIndex,
    writeMetadataIndex,
    removeMetadata,
    renameMetadata,
    getOrGenerateMetadataBatch,
    METADATA_FILE,
} from './image-metadata.js';
import { getUniqueName } from '../util.js';

export const router = express.Router();

/**
 * GET /all - Returns list of background images with metadata.
 * Generates metadata on-demand for any files missing from the cache.
 */
router.post('/all', async function (request, response) {
    try {
        const backgroundsDir = request.user.directories.backgrounds;

        // Read all image files from disk
        const allFiles = await fsp.readdir(backgroundsDir);
        const imageFiles = allFiles.filter(filename => {
            const ext = path.extname(filename).toLowerCase();
            return ALLOWED_IMAGE_EXTENSIONS.has(ext);
        });

        // Generate metadata on-demand for all images
        const metadata = await getOrGenerateMetadataBatch(backgroundsDir, imageFiles);

        // Read full index for folders
        const index = await readMetadataIndex(backgroundsDir);

        const config = { width: dimensions.bg[0], height: dimensions.bg[1] };

        response.json({
            images: imageFiles,
            metadata: metadata,
            folders: index.folders || [],
            config,
        });

    } catch (error) {
        console.error('Failed to read backgrounds:', error);
        response.json({ images: [], metadata: {}, folders: [], config: {} });
    }
});

/**
 * POST /delete - Deletes a background image and its metadata.
 */
router.post('/delete', getFileNameValidationFunction('bg'), async function (request, response) {
    if (!request.body || !request.body.bg) {
        return response.status(400).send('Background filename not provided.');
    }

    try {
        const filename = request.body.bg;
        const backgroundsDir = request.user.directories.backgrounds;
        const filePath = path.join(backgroundsDir, filename);

        if (!(await fileExists(filePath))) {
            console.error('BG file not found');
            return response.sendStatus(400);
        }

        await fsp.unlink(filePath);
        invalidateThumbnail(request.user.directories, 'bg', filename);
        await removeMetadata(backgroundsDir, filename);

        return response.send('ok');

    } catch (error) {
        console.error(`Failed to process delete request for ${request.body.bg}:`, error);
        return response.status(500).send('Failed to delete background.');
    }
});

/**
 * POST /rename - Renames a background image.
 */
router.post('/rename', async function (request, response) {
    if (!request.body || !request.body.old_bg || !request.body.new_bg) {
        return response.status(400).send('Old and new filenames are required.');
    }

    try {
        const oldFilename = sanitize(request.body.old_bg);
        const desiredNewFilename = sanitize(request.body.new_bg);
        const backgroundsDir = request.user.directories.backgrounds;

        if (oldFilename === desiredNewFilename) {
            const index = await readMetadataIndex(backgroundsDir);
            return response.json({ filename: oldFilename, ...index.images[oldFilename] });
        }

        const finalNewFilename = await getUniqueFilename(backgroundsDir, desiredNewFilename);

        // 1. Rename the main background file
        const oldFilePath = path.join(backgroundsDir, oldFilename);
        const newFilePath = path.join(backgroundsDir, finalNewFilename);
        await fsp.rename(oldFilePath, newFilePath);

        // 2. Rename the thumbnail if it exists
        const thumbnailsDir = request.user.directories.thumbnailsBg;
        const oldThumbPath = path.join(thumbnailsDir, oldFilename);
        const newThumbPath = path.join(thumbnailsDir, finalNewFilename);

        if (await fileExists(oldThumbPath)) {
            await fsp.rename(oldThumbPath, newThumbPath);
        }

        // 3. Update metadata
        const oldMetadata = await renameMetadata(backgroundsDir, oldFilename, finalNewFilename);

        response.json({ filename: finalNewFilename, ...oldMetadata });

    } catch (error) {
        console.error(`Failed to rename background from ${request.body.old_bg} to ${request.body.new_bg}:`, error);
        return response.status(500).send(error.message || 'Failed to rename background.');
    }
});

/**
 * POST /upload - Uploads a new background image.
 */
router.post('/upload', async function (request, response) {
    if (!request.body || !request.file) {
        return response.status(400).send('No file uploaded.');
    }

    let finalBgPath;

    try {
        const tempPath = request.file.path;
        const backgroundsDir = request.user.directories.backgrounds;

        const uniqueFilename = await getUniqueFilename(backgroundsDir, request.file.originalname);
        finalBgPath = path.join(backgroundsDir, uniqueFilename);

        await fsp.rename(tempPath, finalBgPath);

        // Generate thumbnail
        const fileExtension = path.extname(uniqueFilename).toLowerCase();
        const isSkippedFormat = SKIPPED_EXTENSIONS.has(fileExtension);

        const thumbResult = await generateThumbnail(
            request.user.directories,
            'bg',
            uniqueFilename,
            !isSkippedFormat,
            null,
        );

        // Generate metadata
        const newMetadata = await generateImageMetadata(finalBgPath);

        if (!newMetadata) {
            throw new Error(`Failed to generate metadata for ${uniqueFilename}.`);
        }

        if (thumbResult && thumbResult.resolution) {
            newMetadata.thumbnailResolution = thumbResult.resolution;
        }

        // Add mtime for cache tracking
        const stats = await fsp.stat(finalBgPath);
        newMetadata.mtime = stats.mtimeMs;

        // Update index
        const index = await readMetadataIndex(backgroundsDir);
        index.images[uniqueFilename] = newMetadata;
        await writeMetadataIndex(backgroundsDir, index);

        response.json({ filename: uniqueFilename, ...newMetadata });

    } catch (err) {
        const originalFilename = request.file?.originalname ?? 'unknown file';
        console.error(`Background upload failed for ${originalFilename}:`, err);

        if (finalBgPath && await fileExists(finalBgPath)) {
            await fsp.unlink(finalBgPath);
        }
        if (request.file?.path && await fileExists(request.file.path)) {
            await fsp.unlink(request.file.path);
        }

        response.sendStatus(500);
    }
});

/**
 * POST /metadata - Get metadata for a specific image (on-demand).
 */
router.post('/metadata', async function (request, response) {
    if (!request.body || !request.body.filename) {
        return response.status(400).send('Filename required.');
    }

    try {
        const filename = sanitize(request.body.filename);
        const backgroundsDir = request.user.directories.backgrounds;

        const metadata = await getOrGenerateMetadataBatch(backgroundsDir, [filename]);

        if (!metadata[filename]) {
            return response.status(404).send('Image not found.');
        }

        response.json(metadata[filename]);

    } catch (error) {
        console.error(`Failed to get metadata for ${request.body.filename}:`, error);
        return response.status(500).send('Failed to get metadata.');
    }
});

/**
 * POST /folders - Update virtual folders.
 */
router.post('/folders', async function (request, response) {
    if (!request.body || !request.body.folders) {
        return response.status(400).send('Folders data required.');
    }

    try {
        const backgroundsDir = request.user.directories.backgrounds;
        const index = await readMetadataIndex(backgroundsDir);

        index.folders = request.body.folders;
        await writeMetadataIndex(backgroundsDir, index);

        response.json({ success: true });

    } catch (error) {
        console.error('Failed to update folders:', error);
        return response.status(500).send('Failed to update folders.');
    }
});

/**
 * POST /folder-assign - Assign an image to virtual folders.
 */
router.post('/folder-assign', async function (request, response) {
    if (!request.body || !request.body.filename || !request.body.folderIds) {
        return response.status(400).send('Filename and folderIds required.');
    }

    try {
        const filename = sanitize(request.body.filename);
        const folderIds = request.body.folderIds;
        const backgroundsDir = request.user.directories.backgrounds;

        const index = await readMetadataIndex(backgroundsDir);

        if (!index.images[filename]) {
            return response.status(404).send('Image not found.');
        }

        index.images[filename].folderIds = folderIds;
        await writeMetadataIndex(backgroundsDir, index);

        response.json({ success: true, folderIds });

    } catch (error) {
        console.error(`Failed to assign folders for ${request.body.filename}:`, error);
        return response.status(500).send('Failed to assign folders.');
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

    const dirContent = await fsp.readdir(directory);
    const existingFiles = new Set(dirContent);

    const uniqueBaseName = getUniqueName(baseName, (name) => {
        return existingFiles.has(`${name}${fileExtension}`);
    });

    return `${uniqueBaseName}${fileExtension}`;
}
