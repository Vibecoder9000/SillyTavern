import path from 'node:path';
import webpack from 'webpack';
import getPublicLibConfig from '../../webpack.config.js';

export default function getWebpackServeMiddleware() {
    /**
     * A very spartan recreation of webpack-dev-middleware.
     * @param {import('express').Request} req Request object.
     * @param {import('express').Response} res Response object.
     * @param {import('express').NextFunction} next Next function.
     * @type {import('express').RequestHandler}
     */
    function devMiddleware(req, res, next) {
        const publicLibConfig = getPublicLibConfig();
        const outputPath = publicLibConfig.output?.path;
        const outputFile = publicLibConfig.output?.filename;
        const parsedPath = path.parse(req.path);

        if (req.method === 'GET' && parsedPath.dir === '/' && parsedPath.base === outputFile) {
            return res.sendFile(outputFile, { root: outputPath });
        }

        next();
    }

    /**
     * Wait until Webpack is done compiling.
     * @param {object} param Parameters.
     * @param {boolean} [param.forceDist=false] Whether to force the use the /dist folder.
     * @param {boolean} [param.pruneCache=false] Whether to prune old cache directories before compiling.
     * @returns {Promise<void>}
     */
    devMiddleware.runWebpackCompiler = ({ forceDist = false, pruneCache = false } = {}) => {
        console.log();
        console.log('Compiling frontend libraries...');

        const startupTimingEnabled = globalThis.STARTUP_TIMING_ENABLED === true;
        const setupStart = performance.now();
        const setupCpuStart = process.cpuUsage();
        const publicLibConfig = getPublicLibConfig({ forceDist, pruneCache });
        const compiler = webpack(publicLibConfig);
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
                const closeStart = performance.now();
                const closeCpuStart = process.cpuUsage();
                if (startupTimingEnabled) {
                    console.log('[startup:webpack] Closing compiler and persisting filesystem cache...');
                }
                compiler.close(() => {
                    const closeCpu = process.cpuUsage(closeCpuStart);
                    if (startupTimingEnabled) {
                        console.log(`[startup:webpack] compiler.close completed in ${Math.round(performance.now() - closeStart)}ms wall, ${Math.round((closeCpu.user + closeCpu.system) / 1000)}ms CPU.`);
                    }
                    resolve();
                });
            });
        });
    };

    return devMiddleware;
}
