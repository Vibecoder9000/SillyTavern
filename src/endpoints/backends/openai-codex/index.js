import express from 'express';
import fetch from 'node-fetch';

import { uuidv4 } from '../../../util.js';
import { getAccessAccount, getAuthStatus, startBrowserFlow, pollBrowserFlow, startDeviceFlow, pollDeviceFlow, cancelFlow, activateAccount, signOutAccount, requireReconnect } from './auth.js';
import { CODEX_MODELS, CODEX_RESPONSES_ENDPOINT } from './constants.js';
import { parseCodexErrorResponse } from './error-response.js';
import { updateObservedLimitsFromEvent, updateObservedLimitsFromHeaders } from './limits.js';
import { sanitizeResponsesLogValue } from '../openai-responses/log-sanitizer.js';
import { convertChatCompletionRequest, proxyResponsesAsChatCompletion } from '../openai-responses/index.js';

export const router = express.Router();

function route(handler) {
    return async (request, response) => {
        try {
            await handler(request, response);
        } catch (error) {
            console.error('Codex provider request failed:', error);
            if (response.headersSent) {
                if (!response.writableEnded) {
                    response.write(`data: ${JSON.stringify({ error: { message: error.message || 'Codex provider request failed' } })}\n\n`);
                    response.end();
                }
                return;
            }
            response.status(error.status || 500).json({ error: { message: error.message || 'Codex provider request failed' } });
        }
    };
}

router.get('/auth/status', route(async (request, response) => response.json(getAuthStatus(request))));
router.post('/auth/browser/start', route(async (request, response) => response.json(await startBrowserFlow(request))));
router.get('/auth/browser/:flowId', route(async (request, response) => response.json(pollBrowserFlow(request, request.params.flowId))));
router.post('/auth/device/start', route(async (request, response) => response.json(await startDeviceFlow(request))));
router.get('/auth/device/:flowId', route(async (request, response) => response.json(await pollDeviceFlow(request, request.params.flowId))));
router.post('/auth/cancel', route(async (request, response) => {
    cancelFlow(request, String(request.body?.flowId || ''));
    response.sendStatus(204);
}));
router.post('/auth/activate', route(async (request, response) => {
    if (!activateAccount(request, String(request.body?.accountId || ''))) return response.status(404).json({ error: { message: 'Account not found' } });
    response.json(getAuthStatus(request));
}));
router.post('/auth/logout', route(async (request, response) => {
    signOutAccount(request, String(request.body?.accountId || ''));
    response.json(getAuthStatus(request));
}));

export function sendCodexStatus(request, response) {
    const status = getAuthStatus(request);
    if (!status.connected) return response.status(401).json({ error: { message: 'Sign in to ChatGPT to use Codex' }, ...status });
    return response.json({ data: CODEX_MODELS.map(model => ({ id: model.id, object: 'model', name: model.name })), codex: status });
}

async function fetchCodex(request, account, body, signal) {
    return fetch(CODEX_RESPONSES_ENDPOINT, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'text/event-stream',
            'Authorization': `Bearer ${account.accessToken}`,
            'ChatGPT-Account-Id': account.accountId,
            'originator': 'sillytavern',
            'User-Agent': 'SillyTavern/1.18.0',
            'session-id': uuidv4(),
            ...(account.residency ? { 'x-openai-internal-codex-residency': account.residency } : {}),
        },
        body: JSON.stringify(body),
        signal,
    });
}

export async function sendCodexChatCompletion(request, response) {
    let account;
    const codexBody = convertChatCompletionRequest({ ...request.body, n: 1 }, {
        store: false,
        forceStream: true,
        encryptedReasoning: true,
    });
    return proxyResponsesAsChatCompletion({
        request,
        response,
        convertOptions: { model: codexBody.model, stop: request.body.stop, fallbackId: 'chatcmpl-codex', errorMessage: 'Codex generation failed' },
        fetchUpstream: async signal => {
            account = await getAccessAccount(request);
            console.debug('OpenAI Codex request:', sanitizeResponsesLogValue(codexBody));
            let upstream = await fetchCodex(request, account, codexBody, signal);
            if (upstream.status === 401) {
                account = await getAccessAccount(request, { forceRefresh: true });
                upstream = await fetchCodex(request, account, codexBody, signal);
                if (upstream.status === 401) requireReconnect(request, account.accountId, 'ChatGPT rejected the refreshed credentials. Sign in again.');
            }
            return upstream;
        },
        onHeaders: headers => updateObservedLimitsFromHeaders(request.user.profile.handle, account.accountId, headers),
        onEvent: event => {
            if (event.type === 'codex.rate_limits') {
                updateObservedLimitsFromEvent(request.user.profile.handle, account.accountId, event);
                return true;
            }
            return false;
        },
        normalizeError: ({ text, status, statusText }) => {
            const { message, logValue } = parseCodexErrorResponse(text, statusText);
            console.debug('OpenAI Codex error response:', status, sanitizeResponsesLogValue(logValue));
            return { error: { message }, quota_error: status === 429 };
        },
        onCompletion: completion => console.debug('OpenAI Codex response:', sanitizeResponsesLogValue(completion)),
    });
}
