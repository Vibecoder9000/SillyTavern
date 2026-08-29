import { describe, test, expect } from '@jest/globals';
import { ChatCompletionStreamCollector } from '../src/chat-completion-stream';

function sse(data, newline = '\n') {
    return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}${newline}${newline}`;
}

describe('ChatCompletionStreamCollector', () => {
    test('reconstructs content across arbitrary UTF-8 and SSE boundaries', () => {
        const collector = new ChatCompletionStreamCollector();
        const transcript = [
            ': keepalive\r\n\r\n',
            'data: {"id":"chat-1","object":"chat.completion.chunk",\r\n',
            'data: "created":123,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi 😀"},"finish_reason":null}]}\r\n\r\n',
            sse({ choices: [{ index: 0, delta: { content: ' there' }, finish_reason: 'stop' }] }, '\r\n'),
            sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }, '\r\n'),
            sse('[DONE]', '\r\n'),
        ].join('');
        const bytes = Buffer.from(transcript, 'utf8');
        const emojiStart = bytes.indexOf(Buffer.from('😀'));

        collector.push(bytes.subarray(0, emojiStart + 2));
        const finalPush = collector.push(bytes.subarray(emojiStart + 2));

        expect(finalPush.done).toBe(true);
        expect(finalPush.result).toMatchObject({ complete: true, doneReceived: true, parsedEventCount: 3 });
        expect(finalPush.result.response).toEqual({
            id: 'chat-1',
            object: 'chat.completion',
            created: 123,
            model: 'test-model',
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
            choices: [{
                index: 0,
                message: { role: 'assistant', content: 'Hi 😀 there' },
                logprobs: null,
                finish_reason: 'stop',
            }],
        });
        expect(collector.finish()).toBe(finalPush.result);
    });

    test('reconstructs reasoning, refusal, logprobs, and parallel tool calls', () => {
        const collector = new ChatCompletionStreamCollector();
        collector.push(sse({
            id: 'chat-tools',
            object: 'chat.completion.chunk',
            service_tier: 'priority',
            choices: [{
                index: 0,
                delta: {
                    role: 'assistant',
                    reasoning_content: 'Need ',
                    tool_calls: [
                        { index: 0, id: 'call_', type: 'function', function: { name: 'get_', arguments: '{"q":' } },
                        { index: 1, id: 'call_b', type: 'function', function: { name: 'other', arguments: '{' } },
                    ],
                },
                logprobs: { content: [{ token: 'a' }] },
            }],
        }));
        collector.push(sse({
            choices: [{
                index: 0,
                delta: {
                    reasoning_content: 'tools',
                    refusal: 'no',
                    images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }],
                    reasoning_details: [{ type: 'reasoning.text', text: 'detail' }],
                    tool_calls: [
                        { index: 0, id: 'a', function: { name: 'weather', arguments: '"x"}' } },
                        { index: 1, function: { arguments: '}' } },
                    ],
                },
                logprobs: { content: [{ token: 'b' }] },
                finish_reason: 'tool_calls',
            }],
            usage: { total_tokens: 10 },
        }));

        const result = collector.finish();

        expect(result.complete).toBe(true);
        expect(result.doneReceived).toBe(false);
        expect(result.response.service_tier).toBe('priority');
        expect(result.response.usage).toEqual({ total_tokens: 10 });
        expect(result.response.choices[0]).toEqual({
            index: 0,
            message: {
                role: 'assistant',
                content: null,
                reasoning_content: 'Need tools',
                refusal: 'no',
                images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }],
                reasoning_details: [{ type: 'reasoning.text', text: 'detail' }],
                tool_calls: [
                    { id: 'call_a', type: 'function', function: { name: 'get_weather', arguments: '{"q":"x"}' } },
                    { id: 'call_b', type: 'function', function: { name: 'other', arguments: '{}' } },
                ],
            },
            logprobs: { content: [{ token: 'a' }, { token: 'b' }] },
            finish_reason: 'tool_calls',
        });
    });

    test('supports legacy function calls, text completions, and indexed choices', () => {
        const collector = new ChatCompletionStreamCollector();
        collector.push(sse({
            object: 'text_completion.chunk',
            choices: [
                { index: 2, text: 'third', finish_reason: 'length' },
                { index: 0, text: 'first ', finish_reason: null },
            ],
        }));
        collector.push(sse({ choices: [{ index: 0, text: 'choice', finish_reason: 'stop' }] }));

        expect(collector.finish().response).toEqual({
            object: 'text_completion',
            choices: [
                { index: 0, text: 'first choice', logprobs: null, finish_reason: 'stop' },
                { index: 2, text: 'third', logprobs: null, finish_reason: 'length' },
            ],
        });

        const chatCollector = new ChatCompletionStreamCollector();
        chatCollector.push(sse({ choices: [{ index: 0, delta: { function_call: { name: 'old_', arguments: '{' } } }] }));
        chatCollector.push(sse({ choices: [{ index: 0, delta: { function_call: { name: 'tool', arguments: '}' } }, finish_reason: 'function_call' }] }));
        expect(chatCollector.finish().response.choices[0].message.function_call).toEqual({ name: 'old_tool', arguments: '{}' });
    });

    test('reports malformed events without losing valid reconstructed content', () => {
        const collector = new ChatCompletionStreamCollector();
        collector.push(sse({ choices: [{ index: 0, delta: { content: 'valid' } }] }));
        collector.push(sse('{not json}'));

        const result = collector.finish();
        expect(result.complete).toBe(false);
        expect(result.parseErrors).toHaveLength(1);
        expect(result.parseErrors[0].length).toBeLessThan(300);
        expect(result.response.choices[0].message.content).toBe('valid');

        const invalidCollector = new ChatCompletionStreamCollector();
        invalidCollector.push(sse('{still not json}'));
        expect(invalidCollector.finish()).toMatchObject({ response: null, complete: false, parsedEventCount: 0 });
    });

    test('marks an unterminated final SSE event as incomplete', () => {
        const collector = new ChatCompletionStreamCollector();
        collector.push(sse({ choices: [{ index: 0, delta: { content: 'complete event' } }] }));
        collector.push('data: {"choices":[{"index":0,"delta":{"content":"truncated"}}]}');

        const result = collector.finish();
        expect(result.complete).toBe(false);
        expect(result.parseErrors[0]).toContain('unterminated SSE event');
        expect(result.response.choices[0].message.content).toBe('complete event');
    });

    test('aborts without returning a partial response', () => {
        const collector = new ChatCompletionStreamCollector();
        collector.push(sse({ choices: [{ index: 0, delta: { content: 'partial' } }] }));
        collector.abort();
        collector.abort();

        expect(collector.finish()).toEqual({
            response: null,
            complete: false,
            parseErrors: [],
            parsedEventCount: 0,
            doneReceived: false,
        });
    });
});
