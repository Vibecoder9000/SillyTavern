import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { serverDirectory } from '../server-directory.js';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

export const router = express.Router();

const SANDBOX_DIR = path.resolve(path.join(serverDirectory, 'uploads'));

// Track active processes to kill previous ones when new ones start
const activeProcesses = {
    python: null,
    shell: null,
};

const COMMAND_DENYLIST = new Set([
    'rm',
    'mv',
    'shred',
    'dd',
    'truncate',
    'chmod',
    'chown',
    'del',
    'erase',
    'move',
    'rename',
    'ren',
    'icacls',
]);

let cachedPythonLauncher = null;

/**
 * Resolves an available Python launcher command for the current platform.
 * @returns {{command: string, args: string[]}|null}
 */
function resolvePythonLauncher() {
    if (cachedPythonLauncher) {
        return cachedPythonLauncher;
    }

    const candidates = process.platform === 'win32'
        ? [
            { command: 'python', args: [] },
            { command: 'py', args: ['-3'] },
            { command: 'python3', args: [] },
        ]
        : [
            { command: 'python3', args: [] },
            { command: 'python', args: [] },
        ];

    for (const candidate of candidates) {
        try {
            const probe = spawnSync(candidate.command, [...candidate.args, '--version'], {
                shell: false,
                stdio: 'ignore',
            });

            if (!probe.error && probe.status === 0) {
                cachedPythonLauncher = candidate;
                return candidate;
            }
        } catch {
            // Try the next launcher candidate.
        }
    }

    return null;
}

/**
 * Safely checks if a given path is within the designated sandbox directory.
 * It resolves the path and uses fs.realpath to prevent path traversal
 * attacks via symbolic links.
 * @param {string} userPath - The path provided by the user/LLM.
 * @param {object} [options]
 * @param {boolean} [options.checkExists=true] - If true, checks the realpath of an existing file/dir. Set to false for write operations where the path may not exist yet.
 * @returns {Promise<boolean>} - True if the path is safely within the sandbox.
 */
async function isPathInSandbox(userPath, { checkExists = true } = {}) {
    try {
        const resolvedPath = path.resolve(SANDBOX_DIR, userPath);

        if (!resolvedPath.startsWith(SANDBOX_DIR)) {
            return false;
        }

        if (checkExists) {
            const realPath = await fs.realpath(resolvedPath);
            if (!realPath.startsWith(SANDBOX_DIR)) {
                return false;
            }
        }

        return true;
    } catch (error) {
        if (error.code === 'ENOENT' && checkExists) {
            return false;
        }
        if (error.code === 'ENOENT' && !checkExists) {
            return true;
        }
        console.error('isPathInSandbox unexpected error:', error);
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

    if (!(await isPathInSandbox(filepath, { checkExists: true }))) {
        return res.status(403).json({ error: 'Access denied: Path is outside the sandbox.' });
    }

    try {
        const fullPath = path.join(SANDBOX_DIR, filepath);
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

    if (dirPath.startsWith('/')) {
        dirPath = dirPath.substring(1);
    }
    if (dirPath === '') {
        dirPath = '.';
    }

    if (!(await isPathInSandbox(dirPath, { checkExists: true }))) {
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

    if (!(await isPathInSandbox(filepath, { checkExists: false }))) {
        return res.status(403).json({ error: 'Access denied: Path is outside the sandbox.' });
    }

    try {
        const fullPath = path.join(SANDBOX_DIR, filepath);
        const dir = path.dirname(fullPath);

        await fs.mkdir(dir, { recursive: true });

        const realDir = await fs.realpath(dir);
        if (!realDir.startsWith(SANDBOX_DIR)) {
             return res.status(403).json({ error: 'Access denied: Cannot write to a directory outside the sandbox.' });
        }

        const flag = append ? 'a' : 'w';
        await fs.writeFile(fullPath, content, { flag });

        const bytesWritten = Buffer.byteLength(content, 'utf8');
        res.json({ message: `Successfully ${append ? 'appended' : 'wrote'} ${bytesWritten} bytes to ${filepath}` });
    } catch (error) {
        console.error(`Error writing file "${filepath}":`, error);
        res.status(500).json({ error: 'An error occurred while writing the file.' });
    }
});

/**
 * Executes a command safely using `spawn` and returns a promise.
 * It splits the command string into an executable and arguments, and crucially
 * uses `shell: false` to prevent command injection vulnerabilities.
 * @param {string} command - The full command string to execute.
 * @param {object} options - Options to pass to spawn, including `cwd` and `signal`.
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
function spawnPromise(command, options) {
    return new Promise((resolve, reject) => {
        const parts = command.trim().split(/\s+/);
        const cmd = parts[0];
        const args = parts.slice(1);

        if (!cmd) {
            return reject(new Error("Command cannot be empty."));
        }

        const normalizedCmd = path.basename(cmd).toLowerCase();

        if (COMMAND_DENYLIST.has(normalizedCmd)) {
            const errorMessage = `Error: The command "${normalizedCmd}" is forbidden for security reasons.`;
            console.warn(`Blocked forbidden command: ${command}`);
            return reject(new Error(errorMessage));
        }

        const childProcess = spawn(cmd, args, {
            ...options,
            shell: false,
        });

        let stdout = '';
        let stderr = '';

        childProcess.stdout.on('data', (data) => { stdout += data.toString(); });
        childProcess.stderr.on('data', (data) => { stderr += data.toString(); });

        const killProcess = () => {
            if (!childProcess.killed) {
                childProcess.kill();
            }
        };

        const onError = (error) => {
            killProcess();
            error.stdout = stdout;
            error.stderr = stderr;
            reject(error);
        };

        childProcess.on('error', onError);

        childProcess.on('close', (code) => {
            resolve({ stdout, stderr, code });
        });

        if (options.signal) {
            options.signal.addEventListener('abort', () => {
                killProcess();
                reject(new Error("Execution was cancelled by the user."));
            });
        }
    });
}

router.post('/executeshell', async (req, res) => {
    const { command } = req.body;

    if (!command) {
        return res.status(400).json({ error: 'command is required.' });
    }

    // Kill any previous shell process
    if (activeProcesses.shell && !activeProcesses.shell.killed) {
        console.log('Killing previous shell process.');
        activeProcesses.shell.kill();
    }

    try {
        const { stdout, stderr } = await spawnPromise(command, {
            cwd: SANDBOX_DIR,
            signal: req.signal,
        });

        const fullOutput = stdout + stderr;
        res.json({ output: fullOutput });

    } catch (error) {
        console.error(`Error executing command "${command}":`, error);
        const fullOutput = (error.stdout || '') + (error.stderr || '');

        if (error.message.includes('forbidden for security reasons')) {
            return res.status(403).json({ output: error.message });
        }

        res.json({ output: fullOutput || `Command failed with error: ${error.message}` });
    }
});

router.post('/executepython', async (req, res) => {
    const { code } = req.body;

    if (!code) {
        return res.status(400).json({ error: 'code is required.' });
    }

    // Kill any previous Python process
    if (activeProcesses.python && !activeProcesses.python.killed) {
        console.log('Killing previous Python process.');
        activeProcesses.python.kill();
    }

    const tempFilename = `exec_${crypto.randomBytes(16).toString('hex')}.py`;
    const scriptPath = path.join(SANDBOX_DIR, tempFilename);
    await fs.mkdir(SANDBOX_DIR, { recursive: true });
    const launcher = resolvePythonLauncher();

    try {
        if (!launcher) {
            return res.status(500).send('Python runtime not found. Install Python and ensure `python`, `python3`, or `py` is available on PATH.');
        }

        await fs.writeFile(scriptPath, code, 'utf-8');

        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');

        const childProcess = spawn(launcher.command, [...launcher.args, '-u', scriptPath], {
            cwd: SANDBOX_DIR,
            shell: false,
        });

        // Track this process so we can kill it when a new one starts
        activeProcesses.python = childProcess;

        childProcess.stdout.on('data', (data) => {
            res.write(data);
        });

        childProcess.stderr.on('data', (data) => {
            res.write(data);
        });

        childProcess.on('close', (code) => {
            console.log(`Python process exited with code ${code}`);
            res.end();
        });

        req.on('close', () => {
            console.log('Client disconnected, killing Python process.');
            childProcess.kill();
        });

        childProcess.on('error', (err) => {
            console.error('Failed to start subprocess.', err);
            if (!res.headersSent) {
                res.status(500).send(`Failed to start subprocess: ${err.message}`);
            } else {
                res.end();
            }
        });

    } catch (error) {
        console.error('Error setting up Python execution:', error);
        if (!res.headersSent) {
            res.status(500).send(`Server error: ${error.message}`);
        } else {
            res.end();
        }
    } finally {
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
