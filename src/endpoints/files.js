import path from 'node:path';
import fs from 'node:fs';

import multer from 'multer';
import express from 'express';
import sanitize from 'sanitize-filename';
import { sync as writeFileSyncAtomic } from 'write-file-atomic';

import { validateAssetFileName } from './assets.js';
import { clientRelativePath } from '../util.js';
import { getSandboxDir } from './sandbox.js';

export const router = express.Router();

const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
        try {
            // Read the destination from the URL's query parameters
            const destination = req.query.destination;
            let uploadPath;

            if (destination === 'sandbox') {
                uploadPath = getSandboxDir(req.query.workspace, req.query.character);
            } else {
                // Default to a generic user file upload directory (for temporary character uploads)
                uploadPath = req.user.directories.files;
            }

            // Ensure the destination directory exists.
            await fs.promises.mkdir(uploadPath, { recursive: true });
            cb(null, uploadPath);
        } catch (error) {
            console.error('Error setting upload destination:', error);
            cb(error);
        }
    },
    filename: (req, file, cb) => {
        const destination = req.query.destination;
        const uploadPath = (destination === 'sandbox')
            ? getSandboxDir(req.query.workspace, req.query.character)
            : req.user.directories.files;

        const sanitizedFilename = sanitize(path.basename(file.originalname));
        const { name, ext } = path.parse(sanitizedFilename);

        let finalFilename = sanitizedFilename;
        let counter = 1;

        while (fs.existsSync(path.join(uploadPath, finalFilename))) {
            finalFilename = `${name}(${counter})${ext}`;
            counter++;
        }

        cb(null, finalFilename);
    },
});

const multipartUpload = multer({
    storage: storage,
    limits: {
        fileSize: 1000 * 1024 * 1024,
    },
});

router.post('/upload-multipart', multipartUpload.single('file'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    // The file has been saved by multer. Now, send a success response.
    res.status(200).json({
        message: 'File uploaded successfully.',
        filename: req.file.filename,
        filepath: req.file.path, // Send back the full server path for the next step
    });
});

router.post('/sanitize-filename', async (request, response) => {
    try {
        const fileName = String(request.body.fileName);
        if (!fileName) {
            return response.status(400).send('No fileName specified');
        }

        const sanitizedFilename = sanitize(fileName);
        return response.send({ fileName: sanitizedFilename });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/upload', async (request, response) => {
    try {
        if (!request.body.name) {
            return response.status(400).send('No upload name specified');
        }

        if (!request.body.data) {
            return response.status(400).send('No upload data specified');
        }

        // Validate filename
        const validation = validateAssetFileName(request.body.name);
        if (validation.error)
            return response.status(400).send(validation.message);

        const pathToUpload = path.join(request.user.directories.files, request.body.name);
        writeFileSyncAtomic(pathToUpload, request.body.data, 'base64');
        const url = clientRelativePath(request.user.directories.root, pathToUpload);
        console.info(`Uploaded file: ${url} from ${request.user.profile.handle}`);
        return response.send({ path: url });
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.get('/download/:filename', (req, res) => {
    const { filename } = req.params;

    // Sanitize the filename to prevent directory traversal attacks
    const sanitizedFilename = sanitize(path.basename(filename));

    if (sanitizedFilename !== filename) {
        return res.status(403).send('Forbidden: Invalid filename.');
    }

    const sandboxDir = getSandboxDir(req.query.workspace, req.query.character);
    const filePath = path.join(sandboxDir, sanitizedFilename);

    res.sendFile(filePath, (err) => {
        if (err) {
            if (err.code === 'ENOENT') {
                return res.status(404).send('File not found.');
            }

            if (res.headersSent) {
                console.log('Client aborted file download.');
            } else {
                console.error('Error sending file:', err);
                return res.status(500).send('Internal server error.');
            }
        }
    });
});

router.post('/delete', async (request, response) => {
    try {
        if (!request.body.path) {
            return response.status(400).send('No path specified');
        }

        const pathToDelete = path.join(request.user.directories.root, request.body.path);
        if (!pathToDelete.startsWith(request.user.directories.files)) {
            return response.status(400).send('Invalid path');
        }

        if (!fs.existsSync(pathToDelete)) {
            return response.status(404).send('File not found');
        }

        fs.unlinkSync(pathToDelete);
        console.info(`Deleted file: ${request.body.path} from ${request.user.profile.handle}`);
        return response.sendStatus(200);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});

router.post('/verify', async (request, response) => {
    try {
        if (!Array.isArray(request.body.urls)) {
            return response.status(400).send('No URLs specified');
        }

        const verified = {};

        for (const url of request.body.urls) {
            const pathToVerify = path.join(request.user.directories.root, url);
            if (!pathToVerify.startsWith(request.user.directories.files)) {
                console.warn(`File verification: Invalid path: ${pathToVerify}`);
                continue;
            }
            const fileExists = fs.existsSync(pathToVerify);
            verified[url] = fileExists;
        }

        return response.send(verified);
    } catch (error) {
        console.error(error);
        return response.sendStatus(500);
    }
});
