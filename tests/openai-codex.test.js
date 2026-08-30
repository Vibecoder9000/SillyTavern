import { describe, expect, test } from '@jest/globals';

import { parseCodexErrorResponse } from '../src/endpoints/backends/openai-codex/error-response';
import { convertChatCompletionRequest } from '../src/endpoints/backends/openai-codex/request-converter';
import { CodexResponseConverter, createChatCompletionAccumulator } from '../src/endpoints/backends/openai-codex/response-converter';
import { clearObservedLimits, readObservedLimits, updateObservedLimitsFromEvent, updateObservedLimitsFromHeaders } from '../src/endpoints/backends/openai-codex/limits';
import { sanitizeCodexLogValue } from '../src/endpoints/backends/openai-codex/log-sanitizer';
import { ChatCompletionStreamCollector } from '../src/chat-completion-stream';
import { SseParser } from '../src/endpoints/backends/openai-codex/sse-parser';

describe('OpenAI Codex request conversion', () => {
    test('converts instructions, multimodal messages, tools, schema, and settings', () => {
        const result = convertChatCompletionRequest({
            model: 'gpt-5.6-sol',
            messages: [
                { role: 'system', content: 'System text' },
                { role: 'developer', content: 'Developer text' },
                { role: 'user', content: [{ type: 'text', text: 'Look' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
                { role: 'assistant', content: 'Calling', signature: 'encrypted', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"x":1}' } }] },
                { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
            ],
            tools: [{ type: 'function', function: { name: 'lookup', description: 'Lookup', parameters: { type: 'object' } } }],
            tool_choice: { type: 'function', function: { name: 'lookup' } },
            max_tokens: 123,
            max_completion_tokens: 456,
            reasoning_effort: 'max',
            verbosity: 'high',
            json_schema: { name: 'answer', strict: true, value: { type: 'object' } },
        });

        expect(result).toMatchObject({
            model: 'gpt-5.6-sol',
            instructions: 'SYSTEM:\nSystem text\n\nDEVELOPER:\nDeveloper text',
            store: false,
            stream: true,
            include: ['reasoning.encrypted_content'],
            reasoning: { effort: 'max', summary: 'auto' },
            text: { verbosity: 'high', format: { type: 'json_schema', name: 'answer', strict: true } },
            tool_choice: { type: 'function', name: 'lookup' },
        });
        expect(result.input).toEqual(expect.arrayContaining([
            expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted' }),
            expect.objectContaining({ type: 'function_call', call_id: 'call_1', name: 'lookup' }),
            expect.objectContaining({ type: 'function_call_output', call_id: 'call_1' }),
        ]));
        expect(result.input[0].content[1]).toMatchObject({ type: 'input_image', image_url: 'data:image/png;base64,AA==' });
        expect(result).not.toHaveProperty('max_output_tokens');
    });

    test('maps minimum effort and omits automatic options', () => {
        expect(convertChatCompletionRequest({ model: 'x', messages: [], reasoning_effort: 'min' }).reasoning.effort).toBe('minimal');
        expect(convertChatCompletionRequest({ model: 'x', messages: [], reasoning_effort: 'auto', verbosity: 'auto' })).not.toHaveProperty('reasoning');
    });
});

describe('OpenAI Codex error handling', () => {
    test('surfaces subscription endpoint detail errors', () => {
        expect(parseCodexErrorResponse('{"detail":"Unsupported parameter: max_output_tokens"}', 'Bad Request')).toEqual({
            message: 'Unsupported parameter: max_output_tokens',
            logValue: { detail: 'Unsupported parameter: max_output_tokens' },
        });
        expect(parseCodexErrorResponse('{"error":{"message":"Quota exhausted"}}', 'Too Many Requests').message).toBe('Quota exhausted');
        expect(parseCodexErrorResponse('gateway failed', 'Bad Gateway').message).toBe('Bad Gateway');
    });

    test('omits base64 from parsed and raw error logs without mutating the input', () => {
        const dataUrl = `data:image/png;base64,${'A'.repeat(512)}`;
        const payload = { error: { message: 'Invalid image', request: { image_url: dataUrl } } };
        const sanitizedPayload = sanitizeCodexLogValue(payload);
        expect(sanitizedPayload.error.request.image_url).toBe('[base64 omitted]');
        expect(payload.error.request.image_url).toBe(dataUrl);

        const rawError = JSON.stringify(payload);
        const sanitizedText = sanitizeCodexLogValue(rawError);
        expect(sanitizedText).toContain('[base64 omitted]');
        expect(sanitizedText).not.toContain('A'.repeat(64));
    });
});

describe('OpenAI Codex response conversion', () => {
    test('normalizes text, reasoning, tools, signatures, usage, and split stop strings', () => {
        const converter = new CodexResponseConverter({ model: 'gpt-5.6-sol', stop: ['STOP'] });
        const accumulator = createChatCompletionAccumulator('gpt-5.6-sol');
        const events = [
            { type: 'response.created', response: { id: 'resp_1', model: 'gpt-5.6-sol' } },
            { type: 'response.reasoning_summary_text.delta', delta: 'Summary' },
            { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'lookup' } },
            { type: 'response.function_call_arguments.delta', output_index: 1, item_id: 'fc_1', delta: '{"x":1}' },
            { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'secret' } },
            { type: 'response.output_text.delta', delta: 'Hello ST' },
            { type: 'response.output_text.delta', delta: 'OP ignored' },
            { type: 'response.completed', response: { usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
        ];
        for (const event of events) for (const chunk of converter.convert(event)) accumulator.push(chunk);
        const result = accumulator.finish();
        expect(result.id).toBe('resp_1');
        expect(result.choices[0].message.content).toBe('Hello ');
        expect(result.choices[0].message.reasoning_content).toBe('Summary');
        expect(result.choices[0].message.tool_calls[0]).toMatchObject({ id: 'call_1', function: { name: 'lookup', arguments: '{"x":1}' } });
        expect(result.choices[0].message.reasoning_details[0]).toMatchObject({ type: 'reasoning.encrypted', data: 'secret' });
        expect(result.usage).toEqual({ prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 });
    });

    test('produces ordinary SSE chunks consumable by the existing collector', () => {
        const converter = new CodexResponseConverter({ model: 'gpt-5.5' });
        const chunks = [
            ...converter.convert({ type: 'response.output_text.delta', delta: 'Hello' }),
            ...converter.finish(),
        ];
        const transcript = chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
        const collector = new ChatCompletionStreamCollector();
        const state = collector.push(transcript);
        expect(state.done).toBe(true);
        expect(state.result.response.choices[0]).toMatchObject({
            message: { role: 'assistant', content: 'Hello' },
            finish_reason: 'stop',
        });
    });

    test('parses arbitrarily split upstream SSE and ignores malformed events', async () => {
        const events = [];
        const parser = new SseParser(event => events.push(event));
        const transcript = 'data: {"type":"response.output_text.delta","delta":"✓"}\n\ndata: broken\n\ndata: {"type":"response.completed"}\n\n';
        const bytes = new TextEncoder().encode(transcript);
        for (const byte of bytes) await parser.push(Uint8Array.of(byte));
        await parser.push('', true);
        expect(events).toEqual([
            { type: 'response.output_text.delta', delta: '✓' },
            { type: 'response.completed' },
        ]);
    });

    test('uses completed tool arguments and reports incomplete output as length', () => {
        const converter = new CodexResponseConverter({ model: 'gpt-5.5' });
        const chunks = [
            ...converter.convert({ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"x":1}' } }),
            ...converter.convert({ type: 'response.incomplete', response: { usage: { input_tokens: 1, output_tokens: 2 } } }),
        ];
        expect(chunks[0].choices[0].delta.tool_calls[0].function.arguments).toBe('{"x":1}');
        expect(chunks.at(-1).choices[0].finish_reason).toBe('length');
    });
});

describe('OpenAI Codex observed limits', () => {
    test('parses header and SSE limit snapshots', () => {
        const headers = new Headers({
            'x-codex-primary-used-percent': '37',
            'x-codex-primary-window-minutes': '300',
            'x-codex-primary-reset-at': '1700000000',
        });
        updateObservedLimitsFromHeaders('user', 'account', headers);
        expect(readObservedLimits('user', 'account')[0].primary).toMatchObject({ usedPercent: 37, windowMinutes: 300, resetsAt: 1700000000 });
        updateObservedLimitsFromEvent('user', 'account', {
            type: 'codex.rate_limits',
            limit_name: 'weekly',
            rate_limits: { primary: { used_percent: 50, window_minutes: 10080, reset_at: 1800000000 } },
        });
        expect(readObservedLimits('user', 'account')).toHaveLength(2);
        clearObservedLimits('user', 'account');
        expect(readObservedLimits('user', 'account')).toEqual([]);
    });
});
