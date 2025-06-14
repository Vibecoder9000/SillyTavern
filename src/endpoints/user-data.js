import express from 'express';
import path from 'node:path';
import { promises as fsPromises } from 'node:fs';

export const router = express.Router();

router.get('/aspect_ratios', async (request, response) => {
    try {
        // Ensure user and directories are available.
        // setUserDataMiddleware should have populated request.user
        if (!request.user || !request.user.directories) {
            console.error('User data not available in request.');
            return response.status(401).send('Unauthorized or user data missing.');
        }
        const { directories } = request.user;
        const aspectFilePath = path.join(directories.root, 'aspect_ratios.json');

        try {
            const data = await fsPromises.readFile(aspectFilePath, 'utf8');
            response.setHeader('Content-Type', 'application/json');
            response.send(data);
        } catch (err) {
            if (err.code === 'ENOENT') {
                response.setHeader('Content-Type', 'application/json');
                response.json({}); // Send empty JSON if file not found
            } else {
                console.error('Error reading aspect_ratios.json:', err);
                response.status(500).send('Error reading aspect ratio data.');
            }
        }
    } catch (error) {
        console.error('Failed to get aspect ratios:', error);
        response.status(500).send('Server error while fetching aspect ratios.');
    }
});
