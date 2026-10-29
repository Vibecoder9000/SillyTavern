export { ServerStartup } from './server-listen.js';

// Express routers
import { router as userDataRouter } from './users.js';
import { router as usersPrivateRouter } from './endpoints/users-private.js';
import { router as usersAdminRouter } from './endpoints/users-admin.js';
import { router as movingUIRouter } from './endpoints/moving-ui.js';
import { router as imagesRouter } from './endpoints/images.js';
import { router as quickRepliesRouter } from './endpoints/quick-replies.js';
import { router as avatarsRouter } from './endpoints/avatars.js';
import { router as themesRouter } from './endpoints/themes.js';
import { router as openAiRouter } from './endpoints/openai.js';
import { router as googleRouter } from './endpoints/google.js';
import { router as anthropicRouter } from './endpoints/anthropic.js';
import { router as presetsRouter } from './endpoints/presets.js';
import { router as secretsRouter } from './endpoints/secrets.js';
import { router as novelAiRouter } from './endpoints/novelai.js';
import { router as assetsRouter } from './endpoints/assets.js';
import { router as filesRouter } from './endpoints/files.js';
import { router as charactersRouter } from './endpoints/characters.js';
import { router as chatsRouter } from './endpoints/chats.js';
import { router as workspaceLastChatRouter } from './endpoints/workspace-last-chat.js';
import { router as chatWorkspaceRouter } from './endpoints/chat-workspace.js';
import { router as characterDesignerRouter } from './endpoints/character-designer.js';
import { router as groupsRouter } from './endpoints/groups.js';
import { router as worldInfoRouter } from './endpoints/worldinfo.js';
import { router as statsRouter } from './endpoints/stats.js';
import { router as contentManagerRouter } from './endpoints/content-manager.js';
import { router as settingsRouter } from './endpoints/settings.js';
import { router as backgroundsRouter } from './endpoints/backgrounds.js';
import { apiRouter as thumbnailApiRouter } from './endpoints/thumbnails.js';
import { router as spritesRouter } from './endpoints/sprites.js';
import { router as stableDiffusionRouter } from './endpoints/stable-diffusion.js';
import { router as hordeRouter } from './endpoints/horde.js';
import { router as openRouterRouter } from './endpoints/openrouter.js';
import { router as nanogptRouter } from './endpoints/nanogpt.js';
import { router as koboldRouter } from './endpoints/backends/kobold.js';
import { router as textCompletionsRouter } from './endpoints/backends/text-completions.js';
import { router as azureRouter } from './endpoints/azure.js';
import { router as minimaxRouter } from './endpoints/minimax.js';
import { router as dataMaidRouter } from './endpoints/data-maid.js';
import { router as backupsRouter } from './endpoints/backups.js';
import { router as imageMetadataRouter } from './endpoints/image-metadata.js';
import { router as volcengineRouter } from './endpoints/volcengine.js';
import { router as worldSimRouter } from './endpoints/world-sim.js';

const deferredRouters = [];

/**
 * Load a router on first use, or during the post-listen warmup.
 * @param {string} modulePath Router module path relative to this module
 * @returns {import('express').RequestHandler} Express middleware
 */
function deferredRouter(modulePath) {
    let loading;
    const load = () => {
        if (!loading) {
            loading = import(modulePath).then(module => module.router).catch(error => {
                loading = undefined;
                throw error;
            });
        }
        return loading;
    };
    deferredRouters.push({ load, name: modulePath });
    return (req, res, next) => { load().then(router => router(req, res, next)).catch(next); };
}

/** Begin warming optional routers after the server can accept requests. */
export function warmDeferredRouters() {
    const loaders = [
        ...deferredRouters,
        { name: 'image processing', load: () => import('./jimp.js') },
        { name: 'archiver', load: () => import('archiver') },
    ];
    let index = 0;
    const warmNext = () => {
        if (index >= loaders.length) return;
        const { load, name } = loaders[index++];
        const start = performance.now();
        load().catch(error => console.warn('Deferred module warmup failed:', error)).finally(() => {
            if (globalThis.STARTUP_TIMING_ENABLED) {
                console.log(`[startup:warmup] ${name}: ${Math.round(performance.now() - start)}ms wall`);
            }
            setImmediate(warmNext).unref();
        });
    };
    setImmediate(warmNext).unref();
}

/**
 * Redirect deprecated API endpoints to their replacements.
 * @param {import('express').Express} app The Express app to use
 */
export function redirectDeprecatedEndpoints(app) {
    /**
     * Redirect a deprecated API endpoint URL to its replacement. Because fetch, form submissions, and $.ajax follow
     * redirects, this is transparent to client-side code.
     * @param {string} src The URL to redirect from.
     * @param {string} destination The URL to redirect to.
     */
    function redirect(src, destination) {
        app.use(src, (req, res) => {
            console.warn(`API endpoint ${src} is deprecated; use ${destination} instead`);
            // HTTP 301 causes the request to become a GET. 308 preserves the request method.
            res.redirect(308, destination);
        });
    }

    redirect('/createcharacter', '/api/characters/create');
    redirect('/renamecharacter', '/api/characters/rename');
    redirect('/editcharacter', '/api/characters/edit');
    redirect('/editcharacterattribute', '/api/characters/edit-attribute');
    redirect('/v2/editcharacterattribute', '/api/characters/merge-attributes');
    redirect('/deletecharacter', '/api/characters/delete');
    redirect('/getcharacters', '/api/characters/all');
    redirect('/getonecharacter', '/api/characters/get');
    redirect('/getallchatsofcharacter', '/api/characters/chats');
    redirect('/importcharacter', '/api/characters/import');
    redirect('/dupecharacter', '/api/characters/duplicate');
    redirect('/exportcharacter', '/api/characters/export');
    redirect('/savechat', '/api/chats/save');
    redirect('/getchat', '/api/chats/get');
    redirect('/renamechat', '/api/chats/rename');
    redirect('/delchat', '/api/chats/delete');
    redirect('/exportchat', '/api/chats/export');
    redirect('/importgroupchat', '/api/chats/group/import');
    redirect('/importchat', '/api/chats/import');
    redirect('/getgroupchat', '/api/chats/group/get');
    redirect('/deletegroupchat', '/api/chats/group/delete');
    redirect('/savegroupchat', '/api/chats/group/save');
    redirect('/getgroups', '/api/groups/all');
    redirect('/creategroup', '/api/groups/create');
    redirect('/editgroup', '/api/groups/edit');
    redirect('/deletegroup', '/api/groups/delete');
    redirect('/getworldinfo', '/api/worldinfo/get');
    redirect('/deleteworldinfo', '/api/worldinfo/delete');
    redirect('/importworldinfo', '/api/worldinfo/import');
    redirect('/editworldinfo', '/api/worldinfo/edit');
    redirect('/getstats', '/api/stats/get');
    redirect('/recreatestats', '/api/stats/recreate');
    redirect('/updatestats', '/api/stats/update');
    redirect('/getbackgrounds', '/api/backgrounds/all');
    redirect('/delbackground', '/api/backgrounds/delete');
    redirect('/renamebackground', '/api/backgrounds/rename');
    redirect('/downloadbackground', '/api/backgrounds/upload'); // yes, the downloadbackground endpoint actually uploads one
    redirect('/savetheme', '/api/themes/save');
    redirect('/getuseravatars', '/api/avatars/get');
    redirect('/deleteuseravatar', '/api/avatars/delete');
    redirect('/uploaduseravatar', '/api/avatars/upload');
    redirect('/deletequickreply', '/api/quick-replies/delete');
    redirect('/savequickreply', '/api/quick-replies/save');
    redirect('/uploadimage', '/api/images/upload');
    redirect('/listimgfiles/:folder', '/api/images/list/:folder');
    redirect('/api/content/import', '/api/content/importURL');
    redirect('/savemovingui', '/api/moving-ui/save');
    redirect('/api/serpapi/search', '/api/search/serpapi');
    redirect('/api/serpapi/visit', '/api/search/visit');
    redirect('/api/serpapi/transcript', '/api/search/transcript');
}

/**
 * Setup the routers for the endpoints.
 * @param {import('express').Express} app The Express app to use
 */
export function setupPrivateEndpoints(app) {
    app.use('/', userDataRouter);
    app.use('/api/users', usersPrivateRouter);
    app.use('/api/users', usersAdminRouter);
    app.use('/api/moving-ui', movingUIRouter);
    app.use('/api/images', imagesRouter);
    app.use('/api/quick-replies', quickRepliesRouter);
    app.use('/api/avatars', avatarsRouter);
    app.use('/api/themes', themesRouter);
    app.use('/api/openai', openAiRouter);
    app.use('/api/google', googleRouter);
    app.use('/api/anthropic', anthropicRouter);
    app.use('/api/tokenizers', deferredRouter('./endpoints/tokenizers.js'));
    app.use('/api/presets', presetsRouter);
    app.use('/api/secrets', secretsRouter);
    app.use('/api/novelai', novelAiRouter);
    app.use('/api/extensions', deferredRouter('./endpoints/extensions.js'));
    app.use('/api/extensions/tools', deferredRouter('./endpoints/tools.js'));
    app.use('/api/assets', assetsRouter);
    app.use('/api/files', filesRouter);
    app.use('/api/characters', charactersRouter);
    app.use('/api/chats', chatsRouter);
    app.use('/api/workspace-last-chat', workspaceLastChatRouter);
    app.use('/api/chat-workspace', chatWorkspaceRouter);
    app.use('/api/character-designer', characterDesignerRouter);
    app.use('/api/groups', groupsRouter);
    app.use('/api/worldinfo', worldInfoRouter);
    app.use('/api/stats', statsRouter);
    app.use('/api/backgrounds', backgroundsRouter);
    app.use('/api/thumbnails', thumbnailApiRouter);
    app.use('/api/sprites', spritesRouter);
    app.use('/api/content', contentManagerRouter);
    app.use('/api/settings', settingsRouter);
    app.use('/api/sd', stableDiffusionRouter);
    app.use('/api/horde', hordeRouter);
    app.use('/api/vector', deferredRouter('./endpoints/vectors.js'));
    app.use('/api/translate', deferredRouter('./endpoints/translate.js'));
    app.use('/api/extra/classify', deferredRouter('./endpoints/classify.js'));
    app.use('/api/extra/caption', deferredRouter('./endpoints/caption.js'));
    app.use('/api/search', deferredRouter('./endpoints/search.js'));
    app.use('/api/backends/text-completions', textCompletionsRouter);
    app.use('/api/openrouter', openRouterRouter);
    app.use('/api/nanogpt', nanogptRouter);
    app.use('/api/backends/kobold', koboldRouter);
    app.use('/api/backends/chat-completions', deferredRouter('./endpoints/backends/chat-completions.js'));
    app.use('/api/speech', deferredRouter('./endpoints/speech.js'));
    app.use('/api/azure', azureRouter);
    app.use('/api/volcengine', volcengineRouter);
    app.use('/api/minimax', minimaxRouter);
    app.use('/api/data-maid', dataMaidRouter);
    app.use('/api/backups', backupsRouter);
    app.use('/api/image-metadata', imageMetadataRouter);
    app.use('/api/world-sim', worldSimRouter);
}
