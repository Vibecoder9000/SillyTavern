import express from 'express';
import fetch from 'node-fetch';

import { uuidv4 } from '../../../util.js';
import { getAccessAccount, getAuthStatus, startBrowserFlow, pollBrowserFlow, startDeviceFlow, pollDeviceFlow, cancelFlow, activateAccount, signOutAccount, requireReconnect } from './auth.js';
import { CODEX_MODELS, CODEX_RESPONSES_ENDPOINT } from './constants.js';
import { parseCodexErrorResponse } from './error-response.js';
import { updateObservedLimitsFromEvent, updateObservedLimitsFromHeaders } from './limits.js';
import { sanitizeCodexLogValue } from './log-sanitizer.js';
import { convertChatCompletionRequest } from './request-converter.js';
import { CodexResponseConverter, createChatCompletionAccumulator } from './response-converter.js';
import { SseParser } from './sse-parser.js';

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

function writeSse(response, chunk) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
}

export async function sendCodexChatCompletion(request, response) {
    const controller = new AbortController();
    let clientClosed = false;
    const abortOnClose = () => {
        clientClosed = true;
        controller.abort();
    };
    request.socket.once('close', abortOnClose);
    let account = await getAccessAccount(request);
    const codexBody = convertChatCompletionRequest({ ...request.body, n: 1 });
    console.debug('OpenAI Codex request:', sanitizeCodexLogValue(codexBody));
    let upstream = await fetchCodex(request, account, codexBody, controller.signal);
    if (upstream.status === 401) {
        account = await getAccessAccount(request, { forceRefresh: true });
        upstream = await fetchCodex(request, account, codexBody, controller.signal);
        if (upstream.status === 401) requireReconnect(request, account.accountId, 'ChatGPT rejected the refreshed credentials. Sign in again.');
    }
    updateObservedLimitsFromHeaders(request.user.profile.handle, account.accountId, upstream.headers);
    if (!upstream.ok) {
        const errorText = await upstream.text();
        const { message, logValue } = parseCodexErrorResponse(errorText, upstream.statusText);
        console.debug('OpenAI Codex error response:', upstream.status, sanitizeCodexLogValue(logValue));
        return response.status(upstream.status).json({ error: { message }, quota_error: upstream.status === 429 });
    }

    const converter = new CodexResponseConverter({ model: codexBody.model, stop: request.body.stop });
    const accumulator = createChatCompletionAccumulator(codexBody.model);
    if (request.body.stream) {
        response.status(200);
        response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        response.setHeader('Cache-Control', 'no-cache');
        response.setHeader('Connection', 'keep-alive');
    }
    const handleEvent = async event => {
        if (event.type === 'codex.rate_limits') {
            updateObservedLimitsFromEvent(request.user.profile.handle, account.accountId, event);
            return;
        }
        for (const chunk of converter.convert(event)) {
            accumulator.push(chunk);
            if (request.body.stream) {
                if (!clientClosed) writeSse(response, chunk);
            }
        }
        if (converter.stopped && !controller.signal.aborted) controller.abort();
    };
    const parser = new SseParser(handleEvent);
    try {
        for await (const chunk of upstream.body) await parser.push(chunk);
        await parser.push('', true);
        if (!converter.state.completed) {
            for (const chunk of converter.finish()) {
                accumulator.push(chunk);
                if (request.body.stream) {
                    if (!clientClosed) writeSse(response, chunk);
                }
            }
        }
    } catch (error) {
        if (!converter.stopped && error.name !== 'AbortError') throw error;
    }
    request.socket.off('close', abortOnClose);
    if (clientClosed) return;
    const completion = accumulator.finish();
    console.debug('OpenAI Codex response:', sanitizeCodexLogValue(completion));
    if (request.body.stream) {
        response.write('data: [DONE]\n\n');
        return response.end();
    }
    return response.json(completion);
}

export { convertChatCompletionRequest, CodexResponseConverter, createChatCompletionAccumulator, SseParser };
