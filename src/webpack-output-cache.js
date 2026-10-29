import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { serverDirectory } from './server-directory.js';

const snapshotName = '.build-inputs.json';

function signature(config) {
    return JSON.stringify([2, process.version, config]);
}

/** Hash contents as well as directory entries: timestamp-preserving edits count. */
function digest(filename, recursive = false, ancestors = new Set()) {
    try {
        const stat = fs.statSync(filename);
        let content;
        if (stat.isDirectory()) {
            const realPath = fs.realpathSync(filename);
            if (ancestors.has(realPath)) throw new Error('Circular build dependency');
            const entries = fs.readdirSync(filename).sort();
            const parents = new Set([...ancestors, realPath]);
            content = JSON.stringify(recursive
                ? entries.map(name => [name, digest(path.join(filename, name), true, parents)])
                : entries);
        } else {
            content = fs.readFileSync(filename);
        }
        return crypto.createHash('sha256').update(content).digest('hex');
    } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
        throw error;
    }
}

/** Reuse output only when every recorded build input and the output still match. */
export function hasCurrentWebpackOutput(config) {
    try {
        const snapshot = JSON.parse(fs.readFileSync(path.join(config.output.path, snapshotName), 'utf8'));
        return snapshot.signature === signature(config)
            && snapshot.inputs.length > 0
            && snapshot.inputs.every(([filename, hash]) => digest(filename) === hash)
            && snapshot.buildInputs.every(([filename, hash]) => digest(filename, true) === hash);
    } catch {
        return false;
    }
}

/** Record only a successful build; a failed build must always be retried. */
export function saveWebpackOutputSnapshot(config, stats) {
    if (!stats || stats.hasErrors()) return;
    try {
        const compilation = stats.compilation;
        const inputs = new Set([
            ...compilation.fileDependencies,
            ...compilation.contextDependencies,
            ...compilation.missingDependencies,
            path.join(serverDirectory, 'package.json'),
            path.join(serverDirectory, 'package-lock.json'),
            path.join(serverDirectory, 'node_modules', '.package-lock.json'),
            path.join(config.output.path, config.output.filename),
        ]);
        // A missing output cannot be a reusable successful build.
        if (digest(path.join(config.output.path, config.output.filename)) === null) return;
        const snapshot = {
            signature: signature(config),
            inputs: [...inputs].map(filename => [filename, digest(filename)]),
            // Compiler/loader code can live in directories. Check their whole
            // tree, whereas resolver context directories only need entry lists.
            buildInputs: [...compilation.buildDependencies].map(filename => [filename, digest(filename, true)]),
        };
        fs.writeFileSync(path.join(config.output.path, snapshotName), JSON.stringify(snapshot));
    } catch (error) {
        // Cache failures never stop startup. The next launch simply uses Webpack.
        console.warn('Unable to cache frontend build inputs:', error.message);
    }
}
