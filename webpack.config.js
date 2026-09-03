import process from 'node:process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import isDocker from 'is-docker';
import webpack from 'webpack';
import { serverDirectory } from './src/server-directory.js';
import { getVersion, color } from './src/util.js';

function startupTimingEnabled() {
    return globalThis.STARTUP_TIMING_ENABLED === true;
}

function startupOffset() {
    return typeof globalThis.SERVER_START_TIME === 'number'
        ? `+${Math.round(performance.now() - globalThis.SERVER_START_TIME)}ms`
        : 'unknown';
}

function processCpuMilliseconds(cpu) {
    return Math.round((cpu.user + cpu.system) / 1000);
}

function reportWebpackTiming(name, start, cpuStart, extra = '') {
    if (!startupTimingEnabled() || start === null || cpuStart === null) return;
    const cpu = process.cpuUsage(cpuStart);
    console.log(`[startup:webpack] ${name} completed at ${startupOffset()} (${Math.round(performance.now() - start)}ms wall, ${processCpuMilliseconds(cpu)}ms CPU${extra})`);
}

/**
 * Generate a cache version string based on the application version, Git revision, and Webpack version.
 * @returns {string} The cache version string.
 */
function getWebpackCacheVersion() {
    return crypto.createHash('shake256', { outputLength: 8 })
        .update(JSON.stringify([appVersion.pkgVersion, appVersion.gitRevision, webpack.version]))
        .digest('hex');
}

/**
 * Prune old Webpack cache directories that do not match the current cache version.
 * @param {string} webpackRoot The root directory where Webpack caches are stored.
 * @param {string} currentCacheVersion The current cache version to keep.
 */
function pruneWebpackCache(webpackRoot, currentCacheVersion) {
    try {
        const enumerationStart = startupTimingEnabled() ? performance.now() : null;
        const enumerationCpuStart = startupTimingEnabled() ? process.cpuUsage() : null;
        if (!fs.existsSync(webpackRoot)) {
            reportWebpackTiming('Cache-directory enumeration', enumerationStart, enumerationCpuStart, ', 0 directories');
            return;
        }

        const cacheDirectories = fs.readdirSync(webpackRoot, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
        reportWebpackTiming('Cache-directory enumeration', enumerationStart, enumerationCpuStart, `, ${cacheDirectories.length} directories`);

        for (const dir of cacheDirectories) {
            const dirPath = path.join(webpackRoot, dir);
            if (dir !== currentCacheVersion) {
                const deletionStart = performance.now();
                const deletionCpuStart = process.cpuUsage();
                try {
                    fs.rmSync(dirPath, { recursive: true, force: true });
                    console.debug(`Removed outdated cache directory: ${color.yellow(dir)}`);
                    reportWebpackTiming(`Delete obsolete cache directory ${dir}`, deletionStart, deletionCpuStart);
                } catch (error) {
                    reportWebpackTiming(`Delete obsolete cache directory ${dir} (failed)`, deletionStart, deletionCpuStart, `, error ${error?.name ?? 'unknown'}`);
                    console.error(`Failed to remove Webpack cache directory: ${color.red(dir)}`, error);
                }
            }
        }
    } catch (error) {
        console.error('Failed to read Webpack cache directories for pruning.', error);
    }
}

const appVersion = await getVersion();

/**
 * Get the Webpack configuration for the public/lib.js file.
 * 1. Docker has got cache and the output file pre-baked.
 * 2. Non-Docker environments use the global DATA_ROOT variable to determine the cache and output directories.
 * @param {object} options Configuration options.
 * @param {boolean} [options.forceDist=false] Whether to force the use the /dist folder.
 * @param {boolean} [options.pruneCache=false] Whether to prune old cache directories.
 * @returns {import('webpack').Configuration}
 * @throws {Error} If the DATA_ROOT variable is not set.
 * */
export default function getPublicLibConfig({ forceDist = false, pruneCache = false } = {}) {
    const preparationStart = startupTimingEnabled() ? performance.now() : null;
    const preparationCpuStart = startupTimingEnabled() ? process.cpuUsage() : null;
    function getWebpackRoot() {
        if (forceDist || isDocker()) {
            return path.resolve(process.cwd(), 'dist', '_webpack');
        }

        if (typeof globalThis.DATA_ROOT === 'string') {
            return path.resolve(globalThis.DATA_ROOT, '_webpack');
        }

        throw new Error('DATA_ROOT variable is not set.');
    }

    function getCacheDirectory() {
        return path.join(webpackRoot, cacheVersion, 'cache');
    }

    function getOutputDirectory() {
        return path.join(webpackRoot, cacheVersion, 'output');
    }

    const webpackRoot = getWebpackRoot();
    const cacheVersion = getWebpackCacheVersion();
    const cacheDirectory = getCacheDirectory();
    const outputDirectory = getOutputDirectory();
    reportWebpackTiming('Configuration/cache-key preparation', preparationStart, preparationCpuStart, `, cache ${cacheVersion}`);

    if (pruneCache) {
        pruneWebpackCache(webpackRoot, cacheVersion);
    }

    return {
        mode: 'production',
        entry: path.join(serverDirectory, 'public/lib.js'),
        cache: {
            type: 'filesystem',
            cacheDirectory: cacheDirectory,
            store: 'pack',
            compression: 'gzip',
        },
        devtool: false,
        watch: false,
        module: {},
        stats: {
            preset: 'minimal',
            assets: false,
            modules: false,
            colors: true,
            timings: true,
        },
        experiments: {
            outputModule: true,
        },
        performance: {
            hints: false,
        },
        output: {
            path: outputDirectory,
            filename: 'lib.js',
            libraryTarget: 'module',
        },
    };
}
