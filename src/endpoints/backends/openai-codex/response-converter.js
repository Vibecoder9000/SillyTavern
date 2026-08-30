function createChunk(state, delta, finishReason = null, usage = undefined) {
    return {
        id: state.id || 'chatcmpl-codex',
        object: 'chat.completion.chunk',
        created: state.created,
        model: state.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
        ...(usage ? { usage } : {}),
    };
}

function normalizeUsage(usage) {
    if (!usage) return undefined;
    const input = usage.input_tokens ?? usage.inputTokens ?? 0;
    const output = usage.output_tokens ?? usage.outputTokens ?? 0;
    return {
        prompt_tokens: input,
        completion_tokens: output,
        total_tokens: usage.total_tokens ?? usage.totalTokens ?? input + output,
    };
}

export class CodexResponseConverter {
    constructor({ model, stop = [] } = {}) {
        this.state = {
            id: null,
            model,
            created: Math.floor(Date.now() / 1000),
            toolIndexes: new Map(),
            nextToolIndex: 0,
            sawToolCall: false,
            completed: false,
        };
        this.stop = Array.isArray(stop) ? stop.filter(value => typeof value === 'string' && value.length > 0) : [];
        this.stopTail = '';
        this.stopped = false;
    }

    #filterStop(delta, final = false) {
        if (this.stop.length === 0 || this.stopped) return delta;
        const combined = this.stopTail + delta;
        let stopIndex = -1;
        for (const stop of this.stop) {
            const index = combined.indexOf(stop);
            if (index !== -1 && (stopIndex === -1 || index < stopIndex)) stopIndex = index;
        }
        if (stopIndex !== -1) {
            this.stopped = true;
            this.stopTail = '';
            return combined.slice(0, stopIndex);
        }
        if (final) {
            this.stopTail = '';
            return combined;
        }
        const keep = Math.max(0, ...this.stop.map(value => value.length - 1));
        if (combined.length <= keep) {
            this.stopTail = combined;
            return '';
        }
        this.stopTail = combined.slice(-keep);
        return keep > 0 ? combined.slice(0, -keep) : combined;
    }

    flush() {
        const text = this.#filterStop('', true);
        return text ? [createChunk(this.state, { content: text })] : [];
    }

    finish(usage = undefined, finishReason = undefined) {
        if (this.state.completed) return [];
        const chunks = this.flush();
        this.state.completed = true;
        chunks.push(createChunk(
            this.state,
            {},
            finishReason || (this.stopped ? 'stop' : this.state.sawToolCall ? 'tool_calls' : 'stop'),
            usage,
        ));
        return chunks;
    }

    convert(event) {
        if (!event || typeof event !== 'object') return [];
        if (event.response?.id) this.state.id = event.response.id;
        if (event.response?.model) this.state.model = event.response.model;
        const chunks = [];
        switch (event.type) {
            case 'response.created':
            case 'response.in_progress':
                if (event.response?.id) this.state.id = event.response.id;
                break;
            case 'response.output_text.delta': {
                const content = this.#filterStop(String(event.delta || ''));
                if (content) chunks.push(createChunk(this.state, { content }));
                break;
            }
            case 'response.reasoning_summary_text.delta':
                chunks.push(createChunk(this.state, { reasoning_content: String(event.delta || '') }));
                break;
            case 'response.refusal.delta': {
                const refusal = String(event.delta || '');
                chunks.push(createChunk(this.state, { content: refusal, refusal }));
                break;
            }
            case 'response.output_item.added': {
                const item = event.item;
                if (item?.type !== 'function_call') break;
                const key = item.id || item.call_id || String(event.output_index);
                const index = this.state.nextToolIndex++;
                this.state.toolIndexes.set(key, index);
                this.state.toolIndexes.set(String(event.output_index), index);
                this.state.sawToolCall = true;
                chunks.push(createChunk(this.state, {
                    tool_calls: [{
                        index,
                        id: item.call_id || item.id,
                        type: 'function',
                        function: { name: item.name || '', arguments: item.arguments || '' },
                    }],
                }));
                break;
            }
            case 'response.function_call_arguments.delta': {
                const key = event.item_id || String(event.output_index);
                const index = this.state.toolIndexes.get(key) ?? 0;
                chunks.push(createChunk(this.state, {
                    tool_calls: [{ index, function: { arguments: String(event.delta || '') } }],
                }));
                break;
            }
            case 'response.output_item.done': {
                const item = event.item;
                if (item?.type === 'reasoning' && item.encrypted_content) {
                    chunks.push(createChunk(this.state, {
                        reasoning_details: [{ type: 'reasoning.encrypted', data: item.encrypted_content, id: item.id }],
                    }));
                }
                break;
            }
            case 'response.completed': {
                const response = event.response || {};
                const incompleteReason = response.incomplete_details?.reason;
                chunks.push(...this.finish(normalizeUsage(response.usage), incompleteReason ? 'length' : undefined));
                break;
            }
            case 'response.incomplete': {
                const response = event.response || {};
                chunks.push(...this.finish(normalizeUsage(response.usage), 'length'));
                break;
            }
            case 'response.failed':
            case 'error':
                throw new Error(event.response?.error?.message || event.error?.message || event.message || 'Codex generation failed');
        }
        return chunks;
    }
}

export function createChatCompletionAccumulator(model) {
    const result = {
        id: 'chatcmpl-codex',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning_content: '', tool_calls: [] }, finish_reason: null }],
    };
    return {
        push(chunk) {
            result.id = chunk.id || result.id;
            result.model = chunk.model || result.model;
            const choice = chunk.choices?.[0];
            const delta = choice?.delta || {};
            result.choices[0].message.content += delta.content || '';
            result.choices[0].message.reasoning_content += delta.reasoning_content || '';
            if (delta.refusal) result.choices[0].message.refusal = (result.choices[0].message.refusal || '') + delta.refusal;
            if (Array.isArray(delta.reasoning_details)) {
                result.choices[0].message.reasoning_details = [
                    ...(result.choices[0].message.reasoning_details || []),
                    ...delta.reasoning_details,
                ];
            }
            for (const toolDelta of delta.tool_calls || []) {
                const index = toolDelta.index || 0;
                const target = result.choices[0].message.tool_calls[index] ??= { id: toolDelta.id, type: 'function', function: { name: '', arguments: '' } };
                if (toolDelta.id) target.id = toolDelta.id;
                if (toolDelta.function?.name) target.function.name += toolDelta.function.name;
                if (toolDelta.function?.arguments) target.function.arguments += toolDelta.function.arguments;
            }
            if (choice?.finish_reason) result.choices[0].finish_reason = choice.finish_reason;
            if (chunk.usage) result.usage = chunk.usage;
        },
        finish() {
            if (!result.choices[0].message.reasoning_content) delete result.choices[0].message.reasoning_content;
            if (result.choices[0].message.tool_calls.length === 0) delete result.choices[0].message.tool_calls;
            return result;
        },
    };
}
