import { createChatCompletionAccumulator, ResponsesResponseConverter } from './response-converter.js';
import { SseParser } from './sse-parser.js';

function writeSse(response, chunk) {
    const frame = `data: ${JSON.stringify(chunk)}\n\n`;
    response.write(frame);
    return frame;
}

function byteLength(value) {
    if (typeof value === 'string') return Buffer.byteLength(value);
    return value?.byteLength ?? value?.length ?? 0;
}

function defaultNormalizeError({ text, statusText }) {
    let message = statusText || 'Unknown error occurred';
    try {
        const data = JSON.parse(text);
        message = data?.error?.message || data?.detail || message;
    } catch {
        if (text) message = text;
    }
    return { error: { message } };
}

/**
 * Proxy a Chat Completions-shaped request through an OpenAI Responses endpoint.
 * Transport-specific behavior is supplied through callbacks.
 * @param {object} options
 * @param {import('express').Request} options.request
 * @param {import('express').Response} options.response
 * @param {(signal: AbortSignal) => Promise<Response>} options.fetchUpstream
 * @param {object} [options.convertOptions]
 * @param {(error: { text: string, status: number, statusText: string, response: Response }) => object|Promise<object>} [options.normalizeError]
 * @param {(headers: Headers, response: Response) => void|Promise<void>} [options.onHeaders]
 * @param {(event: object) => boolean|void|Promise<boolean|void>} [options.onEvent]
 * @param {(completion: object) => void|Promise<void>} [options.onCompletion]
 * @param {(bytes: number) => void} [options.onUpstreamChunk]
 * @param {(event: object) => void} [options.onProtocolEvent]
 * @param {(details: { frameBytes: number, first: boolean, contentEncoding: string|undefined, contentType: string|undefined }) => void} [options.onDownstreamWrite]
 * @param {boolean} [options.logStreaming=false] Whether to log stream lifecycle messages
 * @returns {Promise<object|undefined>}
 */
export async function proxyResponsesAsChatCompletion({
    request,
    response,
    fetchUpstream,
    convertOptions = {},
    normalizeError = defaultNormalizeError,
    onHeaders,
    onEvent,
    onCompletion,
    onUpstreamChunk,
    onProtocolEvent,
    onDownstreamWrite,
    logStreaming = false,
}) {
    const controller = new AbortController();
    let clientClosed = false;
    const abortOnClose = () => {
        clientClosed = true;
        controller.abort();
    };
    request.socket?.once('close', abortOnClose);

    let converter;
    try {
        const upstream = await fetchUpstream(controller.signal);
        await onHeaders?.(upstream.headers, upstream);
        if (request.body.stream && logStreaming) console.info('Streaming request in progress');
        if (!upstream.ok) {
            const text = await upstream.text();
            return response.status(upstream.status).json(await normalizeError({
                text,
                status: upstream.status,
                statusText: upstream.statusText,
                response: upstream,
            }));
        }

        converter = new ResponsesResponseConverter(convertOptions);
        const accumulator = createChatCompletionAccumulator(convertOptions.model, { fallbackId: convertOptions.fallbackId });
        let downstreamWriteCount = 0;
        const writeDownstreamSse = frameOrChunk => {
            const frame = typeof frameOrChunk === 'string' ? frameOrChunk : writeSse(response, frameOrChunk);
            if (typeof frameOrChunk === 'string') response.write(frame);
            onDownstreamWrite?.({
                frameBytes: byteLength(frame),
                first: downstreamWriteCount === 0,
                contentEncoding: response.getHeader('Content-Encoding'),
                contentType: response.getHeader('Content-Type'),
            });
            downstreamWriteCount++;
        };
        if (request.body.stream) {
            response.status(200);
            response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
            response.setHeader('Cache-Control', 'no-cache, no-transform');
            response.setHeader('Connection', 'keep-alive');
        }

        const handleEvent = async event => {
            onProtocolEvent?.(event);
            if (await onEvent?.(event)) return;
            for (const chunk of converter.convert(event)) {
                accumulator.push(chunk);
                if (request.body.stream && !clientClosed) writeDownstreamSse(chunk);
            }
            if (converter.stopped && !controller.signal.aborted) controller.abort();
        };
        const parser = new SseParser(handleEvent);
        try {
            for await (const chunk of upstream.body) {
                onUpstreamChunk?.(byteLength(chunk));
                await parser.push(chunk);
            }
            await parser.push('', true);
            if (!converter.state.completed) {
                for (const chunk of converter.finish()) {
                    accumulator.push(chunk);
                    if (request.body.stream && !clientClosed) writeDownstreamSse(chunk);
                }
            }
        } catch (error) {
            if (!converter.stopped && error.name !== 'AbortError') throw error;
        }

        if (clientClosed) return undefined;
        const completion = accumulator.finish();
        await onCompletion?.(completion);
        if (request.body.stream) {
            if (logStreaming) console.info('Streaming request finished');
            writeDownstreamSse('data: [DONE]\n\n');
            return response.end();
        }
        return response.json(completion);
    } finally {
        request.socket?.off('close', abortOnClose);
    }
}
