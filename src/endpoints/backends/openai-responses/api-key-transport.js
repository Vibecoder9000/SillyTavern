import fetch from 'node-fetch';
import urlJoin from 'url-join';

import { getConfigValue } from '../../../util.js';
import { readSecret, SECRET_KEYS } from '../../secrets.js';
import { sanitizeResponsesLogValue } from './log-sanitizer.js';
import { convertChatCompletionRequest } from './request-converter.js';
import { proxyResponsesAsChatCompletion } from './proxy.js';

function isResponsesProtocolLoggingEnabled() {
    return getConfigValue('logging.enableResponsesProtocolLogging', false, 'boolean');
}

function getChatCompletionLogRequest(body) {
    // Keep the normal request log at the Chat Completions protocol boundary,
    // rather than including SillyTavern-only generation and routing fields.
    return sanitizeResponsesLogValue({
        messages: body.messages,
        prompt: undefined,
        model: body.model,
        temperature: body.temperature,
        max_tokens: body.max_tokens,
        max_completion_tokens: body.max_completion_tokens,
        stream: body.stream,
        presence_penalty: body.presence_penalty,
        frequency_penalty: body.frequency_penalty,
        top_p: body.top_p,
        top_k: body.top_k,
        stop: body.stop,
        logit_bias: body.logit_bias,
        seed: body.seed,
        n: body.n,
        reasoning_effort: body.reasoning_effort,
        verbosity: body.verbosity,
        tools: body.tools,
        tool_choice: body.tool_choice,
        response_format: body.json_schema ? {
            type: 'json_schema',
            json_schema: {
                name: body.json_schema.name,
                strict: body.json_schema.strict ?? true,
                schema: body.json_schema.value,
            },
        } : undefined,
    });
}

/**
 * Sends a Chat Completions-shaped request to an API-key-authenticated
 * OpenAI Responses-compatible endpoint.
 * @param {import('express').Request} request Express request
 * @param {import('express').Response} response Express response
 * @returns {Promise<object|undefined>}
 */
export async function sendOpenAIResponsesChatCompletion(request, response) {
    const baseUrl = String(request.body.openai_responses_url || '').trim();
    if (!baseUrl) {
        return response.status(400).json({ error: { message: 'OpenAI Responses endpoint URL is missing.' } });
    }

    const apiKey = readSecret(request.user.directories, SECRET_KEYS.OPENAI_RESPONSES, request.body.secret_id);
    const protocolLoggingEnabled = isResponsesProtocolLoggingEnabled();
    const traceStartedAt = protocolLoggingEnabled && request.body.stream ? performance.now() : null;
    const elapsedMs = () => Math.round((performance.now() - traceStartedAt) * 10) / 10;
    console.debug('Chat Completion request:', getChatCompletionLogRequest(request.body));
    const responsesBody = convertChatCompletionRequest(request.body, {
        store: false,
        forceStream: true,
        encryptedReasoning: false,
    });
    const endpointUrl = urlJoin(baseUrl, '/responses');
    return proxyResponsesAsChatCompletion({
        request,
        response,
        convertOptions: { model: responsesBody.model, stop: request.body.stop },
        fetchUpstream: signal => {
            if (protocolLoggingEnabled) {
                console.debug('OpenAI Responses translated request:', sanitizeResponsesLogValue(responsesBody));
            }
            return fetch(endpointUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Accept': 'text/event-stream',
                    ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
                },
                body: JSON.stringify(responsesBody),
                signal,
            });
        },
        logStreaming: true,
        onProtocolEvent: event => {
            if (protocolLoggingEnabled && request.body.stream) {
                const details = { atMs: elapsedMs(), type: event?.type };
                if (Object.hasOwn(event ?? {}, 'delta')) {
                    details.deltaLength = typeof event.delta === 'string' ? event.delta.length : undefined;
                }
                console.debug('OpenAI Responses parsed event:', details);
            }
        },
        onEvent: event => {
            if (protocolLoggingEnabled && [
                'response.completed',
                'response.incomplete',
                'response.failed',
                'error',
            ].includes(event.type)) {
                console.debug('OpenAI Responses upstream response:', sanitizeResponsesLogValue(event.response || event));
            }
        },
        onUpstreamChunk: bytes => {
            if (protocolLoggingEnabled && request.body.stream) {
                console.debug('OpenAI Responses upstream body chunk:', { atMs: elapsedMs(), bytes });
            }
        },
        onDownstreamWrite: details => {
            if (protocolLoggingEnabled && request.body.stream) {
                const logValue = { atMs: elapsedMs(), frameBytes: details.frameBytes };
                if (details.first) {
                    logValue.acceptEncoding = request.headers['accept-encoding'];
                    logValue.contentEncoding = details.contentEncoding;
                    logValue.contentType = details.contentType;
                }
                console.debug('OpenAI Responses downstream Chat Completion SSE write:', logValue);
            }
        },
        onCompletion: completion => console.debug('Chat Completion response:', sanitizeResponsesLogValue(completion)),
    });
}
