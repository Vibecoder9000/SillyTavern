import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { serverDirectory } from '../server-directory.js';
import { exec, spawn } from 'node:child_process';
import util from 'node:util';
import crypto from 'node:crypto';

const execPromise = util.promisify(exec);
export const router = express.Router();

const SANDBOX_DIR = path.join(serverDirectory, 'uploads');

async function isPathInSandbox(filepath) {
    try {
        const resolvedPath = path.resolve(SANDBOX_DIR, filepath);
        const sandboxPath = path.resolve(SANDBOX_DIR);
        return resolvedPath.startsWith(sandboxPath);
    } catch (error) {
        return false;
    }
}

router.post('/readfile', async (req, res) => {
    let { filepath } = req.body;

    if (!filepath) {
        return res.status(400).json({ error: 'filepath is required.' });
    }

    if (filepath.startsWith('/')) {
        filepath = filepath.substring(1);
    }

    if (!(await isPathInSandbox(filepath))) {
        return res.status(403).json({ error: 'Access denied: Path is outside the sandbox.' });
    }

    try {
        const fullPath = path.join(SANDBOX_DIR, filepath);
        // Ensure the directory exists before trying to read from it.
        await fs.mkdir(SANDBOX_DIR, { recursive: true });
        const content = await fs.readFile(fullPath, 'utf-8');
        res.json({ content });
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: `File not found: ${filepath}` });
        } else {
            console.error(`Error reading file "${filepath}":`, error);
            res.status(500).json({ error: 'An error occurred while reading the file.' });
        }
    }
});

router.post('/listdir', async (req, res) => {
    let { path: dirPath = '.' } = req.body;

    // Sanitize path to handle LLM confusion between absolute and sandbox-relative paths.
    if (dirPath.startsWith('/')) {
        dirPath = dirPath.substring(1);
    }
    // If stripping the slash resulted in an empty string (from path="/"), default to '.'
    if (dirPath === '') {
        dirPath = '.';
    }

    if (!(await isPathInSandbox(dirPath))) {
        return res.status(403).json({ error: 'Access denied: Path is outside the sandbox.' });
    }

    try {
        const fullPath = path.join(SANDBOX_DIR, dirPath);
        await fs.mkdir(SANDBOX_DIR, { recursive: true });
        const dirents = await fs.readdir(fullPath, { withFileTypes: true });

        const files = [];
        const directories = [];

        for (const dirent of dirents) {
            if (dirent.isDirectory()) {
                directories.push(dirent.name);
            } else {
                files.push(dirent.name);
            }
        }

        res.json({ files, directories });
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: `Directory not found: ${dirPath}` });
        } else {
            console.error(`Error listing directory "${dirPath}":`, error);
            res.status(500).json({ error: 'An error occurred while listing the directory.' });
        }
    }
});

router.post('/writefile', async (req, res) => {
    let { filepath, content, append = false } = req.body;

    if (!filepath || typeof content !== 'string') {
        return res.status(400).json({ error: 'filepath and content are required.' });
    }

    if (filepath.startsWith('/')) {
        filepath = filepath.substring(1);
    }

    if (!(await isPathInSandbox(filepath))) {
        return res.status(403).json({ error: 'Access denied: Path is outside the sandbox.' });
    }

    try {
        const fullPath = path.join(SANDBOX_DIR, filepath);

        // Ensure the directory for the file exists before writing.
        await fs.mkdir(path.dirname(fullPath), { recursive: true });

        const flag = append ? 'a' : 'w'; // 'a' for append, 'w' for write/overwrite
        await fs.writeFile(fullPath, content, { flag });

        const bytesWritten = Buffer.byteLength(content, 'utf8');
        res.json({ message: `Successfully ${append ? 'appended' : 'wrote'} ${bytesWritten} bytes to ${filepath}` });
    } catch (error) {
        console.error(`Error writing file "${filepath}":`, error);
        res.status(500).json({ error: 'An error occurred while writing the file.' });
    }
});

router.post('/deletefile', async (req, res) => {
    let { filepath } = req.body;

    if (!filepath) {
        return res.status(400).json({ error: 'filepath is required.' });
    }

    if (filepath.startsWith('/')) {
        filepath = filepath.substring(1);
    }

    if (!(await isPathInSandbox(filepath))) {
        return res.status(403).json({ error: 'Access denied: Path is outside the sandbox.' });
    }

    try {
        const fullPath = path.join(SANDBOX_DIR, filepath);
        await fs.unlink(fullPath);
        res.json({ message: `Successfully deleted file: ${filepath}` });
    } catch (error) {
        if (error.code === 'ENOENT') {
            res.status(404).json({ error: `File not found: ${filepath}` });
        } else if (error.code === 'EISDIR') {
            res.status(400).json({ error: `Cannot delete a directory with this tool: ${filepath}` });
        }
        else {
            console.error(`Error deleting file "${filepath}":`, error);
            res.status(500).json({ error: 'An error occurred while deleting the file.' });
        }
    }
});

router.post('/executeshell', async (req, res) => {
    const { command } = req.body;

    if (!command) {
        return res.status(400).json({ error: 'command is required.' });
    }

    try {
        // We call our new promise-based wrapper here
        const { stdout, stderr } = await execPromise(command, {
            cwd: SANDBOX_DIR,
            shell: true,
        });

        const fullOutput = stdout + stderr;
        res.json({ output: fullOutput });

    } catch (error) {
        console.error(`Error executing command "${command}":`, error);
        // The error object now contains the output from the failed command
        const fullOutput = (error.stdout || '') + (error.stderr || '');
        res.json({ output: fullOutput || `Command failed with error: ${error.message}` });
    }
});

router.post('/executepython', async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'code is required.' });
    }

    const tempFilename = `exec_${crypto.randomBytes(16).toString('hex')}.py`;
    const scriptPath = path.join(SANDBOX_DIR, tempFilename);
    await fs.mkdir(SANDBOX_DIR, { recursive: true });

    try {
        await fs.writeFile(scriptPath, code, 'utf-8');

        // Set headers for streaming
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        const childProcess = spawn('python', ['-u', scriptPath], {
            cwd: SANDBOX_DIR,
            // Use shell: true on Windows to ensure commands like 'pip' are found in PATH
            shell: process.platform === 'win32',
        });

        // Stream stdout
        childProcess.stdout.on('data', (data) => {
            res.write(data);
        });

        // Stream stderr
        childProcess.stderr.on('data', (data) => {
            res.write(data);
        });

        // Handle process exit
        childProcess.on('close', (code) => {
            console.log(`Python process exited with code ${code}`);
            res.end();
        });

        // Handle client disconnect
        req.on('close', () => {
            console.log('Client disconnected, killing Python process.');
            childProcess.kill();
        });

        childProcess.on('error', (err) => {
            console.error('Failed to start subprocess.', err);
            res.status(500).send(`Failed to start subprocess: ${err.message}`);
        });

    } catch (error) {
        console.error('Error setting up Python execution:', error);
        res.status(500).send(`Server error: ${error.message}`);
    } finally {
        // Schedule deletion of the temp file after a short delay
        setTimeout(async () => {
            try {
                await fs.unlink(scriptPath);
            } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') {
                    console.error(`Failed to delete temp script: ${scriptPath}`, unlinkError);
                }
            }
        }, 1000);
    }
});
