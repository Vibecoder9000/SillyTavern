import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installCommand = 'npm install --no-save --no-audit --no-fund --loglevel=error --no-progress --omit=dev --ignore-scripts';

function fingerprint(directory) {
    const hash = crypto.createHash('sha256');
    hash.update(JSON.stringify([1, process.version, process.platform, process.arch, installCommand]));
    for (const file of ['package.json', 'package-lock.json', '.npmrc', 'node_modules/.package-lock.json']) {
        hash.update(file);
        hash.update(fs.existsSync(path.join(directory, file)) ? fs.readFileSync(path.join(directory, file)) : '<missing>');
    }
    return hash.digest('hex');
}

function installDependencies(directory) {
    const result = process.platform === 'win32'
        ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', installCommand], { cwd: directory, stdio: 'inherit' })
        : spawnSync('npm', installCommand.split(' ').slice(1), { cwd: directory, stdio: 'inherit' });
    if (result.error) console.error('Unable to run npm:', result.error.message);
    return result.status ?? 1;
}

/** Skip npm only after a successful install with the same inputs and installed tree. */
export function ensureDependencies(directory = serverDirectory, install = installDependencies) {
    const stampPath = path.join(directory, 'node_modules', '.sillytavern-dependencies');
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    const dependenciesPresent = fs.existsSync(path.join(directory, 'node_modules'))
        && Object.keys(manifest.dependencies ?? {}).every(name => fs.existsSync(path.join(directory, 'node_modules', name, 'package.json')));
    let previousFingerprint;
    try {
        previousFingerprint = fs.readFileSync(stampPath, 'utf8');
    } catch {
        // First launch, or node_modules was removed: run npm before recording a stamp.
    }
    if (process.env.ST_FORCE_NPM_INSTALL !== '1' && dependenciesPresent && previousFingerprint === fingerprint(directory)) {
        console.log('Dependencies unchanged; skipping npm install.');
        return 0;
    }

    // A failed or interrupted install must not leave a reusable success stamp.
    fs.rmSync(stampPath, { force: true });
    const status = install(directory);
    if (status !== 0) return status;
    try {
        fs.writeFileSync(stampPath, fingerprint(directory));
    } catch (error) {
        console.warn('Unable to cache the dependency check:', error.message);
    }
    return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = ensureDependencies();
}
