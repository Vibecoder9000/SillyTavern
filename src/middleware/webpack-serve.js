import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig from '../../webpack.config.js';

export default function getWebpackServeMiddleware() {
    let compilerClosePromise = Promise.resolve();
    /**
     * A very spartan recreation of webpack-dev-middleware.
     * @param {import('express').Request} req Request object.
     * @param {import('express').Response} res Response object.
     * @param {import('express').NextFunction} next Next function.
     * @type {import('express').RequestHandler}
     */
    async function devMiddleware(req, res, next) {
        try {
            const publicLibConfig = await getPublicLibConfig();
            const outputPath = publicLibConfig.output?.path;
            const outputFile = publicLibConfig.output?.filename;
            const parsedPath = path.parse(req.path);

            if (req.method === 'GET' && parsedPath.dir === '/' && parsedPath.base === outputFile) {
                return res.sendFile(outputFile, { root: outputPath });
            }

            next();
        } catch (error) {
            next(error);
        }
    }

    /**
     * Wait until Webpack is done compiling.
     * @param {object} param Parameters.
     * @param {boolean} [param.forceDist=false] Whether to force the use the /dist folder.
     * @param {boolean} [param.pruneCache=false] Whether to prune old cache directories before compiling.
     * @returns {Promise<void>}
     */
    devMiddleware.runWebpackCompiler = async ({ forceDist = false, pruneCache = false } = {}) => {
        console.log();
        console.log('Compiling frontend libraries...');

        const startupTimingEnabled = globalThis.STARTUP_TIMING_ENABLED === true;
        const setupStart = performance.now();
        const setupCpuStart = process.cpuUsage();
        const publicLibConfig = await getPublicLibConfig({ forceDist, pruneCache });
        const compilerStart = startupTimingEnabled ? performance.now() : null;
        const compilerCpuStart = startupTimingEnabled ? process.cpuUsage() : null;
        const compiler = webpack(publicLibConfig);
        if (startupTimingEnabled) {
            const compilerCpu = process.cpuUsage(compilerCpuStart);
            console.log(`[startup:webpack] Compiler construction completed in ${Math.round(performance.now() - compilerStart)}ms wall, ${Math.round((compilerCpu.user + compilerCpu.system) / 1000)}ms CPU.`);
        }
        const setupCpu = process.cpuUsage(setupCpuStart);
        if (startupTimingEnabled) {
            console.log(`[startup:webpack] Compiler setup completed in ${Math.round(performance.now() - setupStart)}ms wall, ${Math.round((setupCpu.user + setupCpu.system) / 1000)}ms CPU.`);
        }

        return new Promise((resolve) => {
            const compileStart = performance.now();
            const compileCpuStart = process.cpuUsage();
            compiler.run((_error, stats) => {
                const compileCpu = process.cpuUsage(compileCpuStart);
                if (startupTimingEnabled) {
                    console.log(`[startup:webpack] compiler.run completed in ${Math.round(performance.now() - compileStart)}ms wall, ${Math.round((compileCpu.user + compileCpu.system) / 1000)}ms CPU.`);
                }
                const output = stats?.toString(publicLibConfig.stats);
                if (output) {
                    console.log(output);
                    console.log();
                }
                // The output is ready after compiler.run. Persist the cache in
                // the background and let graceful shutdown wait for it.
                compilerClosePromise = new Promise(closeResolve => {
                    setImmediate(() => {
                        const closeStart = performance.now();
                        const closeCpuStart = process.cpuUsage();
                        if (startupTimingEnabled) {
                            console.log('[startup:webpack] Closing compiler and persisting filesystem cache...');
                        }
                        const finishClose = error => {
                            if (error) console.error('Failed to close the Webpack compiler:', error);
                            const closeCpu = process.cpuUsage(closeCpuStart);
                            if (startupTimingEnabled) {
                                console.log(`[startup:webpack] compiler.close completed in ${Math.round(performance.now() - closeStart)}ms wall, ${Math.round((closeCpu.user + closeCpu.system) / 1000)}ms CPU.`);
                            }
                            closeResolve();
                        };
                        try {
                            compiler.close(finishClose);
                        } catch (error) {
                            finishClose(error);
                        }
                    });
                });
                resolve();
            });
        });
    };

    devMiddleware.waitForWebpackClose = () => compilerClosePromise;

    return devMiddleware;
}
