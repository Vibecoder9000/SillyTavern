import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { hasCurrentWebpackOutput, saveWebpackOutputSnapshot } from '../src/webpack-output-cache.js';

let directory, config, source, output, missing, context, buildDirectory, stats;
beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'st-build-cache-'));
    source = path.join(directory, 'source.js');
    output = path.join(directory, 'lib.js');
    missing = path.join(directory, 'optional.js');
    context = path.join(directory, 'context');
    buildDirectory = path.join(directory, 'compiler');
    fs.mkdirSync(context);
    fs.mkdirSync(buildDirectory);
    fs.writeFileSync(path.join(buildDirectory, 'loader.js'), 'loader');
    fs.writeFileSync(source, 'source');
    fs.writeFileSync(output, 'bundle');
    config = { output: { path: directory, filename: 'lib.js' } };
    stats = {
        hasErrors: () => false,
        compilation: {
            fileDependencies: new Set([source]),
            contextDependencies: new Set([context]),
            missingDependencies: new Set([missing]),
            buildDependencies: new Set([buildDirectory]),
        },
    };
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function save() { saveWebpackOutputSnapshot(config, stats); }

describe('frontend output cache', () => {
    test('reuses a successful build with unchanged inputs', () => {
        expect(hasCurrentWebpackOutput(config)).toBe(false);
        save();
        expect(hasCurrentWebpackOutput(config)).toBe(true);
    });

    test('detects a source edit even with unchanged size and timestamp', () => {
        save();
        const stamp = fs.statSync(source);
        fs.writeFileSync(source, 'edited');
        fs.utimesSync(source, stamp.atime, stamp.mtime);
        expect(hasCurrentWebpackOutput(config)).toBe(false);
    });

    test.each(['missing', 'context', 'compiler', 'output', 'deleted output', 'config'])('invalidates changed %s', kind => {
        save();
        if (kind === 'missing') fs.writeFileSync(missing, 'new dependency');
        if (kind === 'context') fs.writeFileSync(path.join(context, 'new.js'), 'new file');
        if (kind === 'compiler') fs.writeFileSync(path.join(buildDirectory, 'loader.js'), 'updated');
        if (kind === 'output') fs.writeFileSync(output, 'corrupted');
        if (kind === 'deleted output') fs.unlinkSync(output);
        if (kind === 'config') config.mode = 'development';
        expect(hasCurrentWebpackOutput(config)).toBe(false);
    });

    test('never records a failed build', () => {
        stats.hasErrors = () => true;
        save();
        expect(hasCurrentWebpackOutput(config)).toBe(false);
    });

    test('falls back to compilation for a corrupt snapshot', () => {
        save();
        fs.writeFileSync(path.join(directory, '.build-inputs.json'), '{');
        expect(hasCurrentWebpackOutput(config)).toBe(false);
    });
});
