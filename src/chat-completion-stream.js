const STREAMED_MESSAGE_FIELDS = new Set(['content', 'reasoning', 'reasoning_content', 'refusal', 'data', 'transcript']);
const MAX_ERROR_PREVIEW_LENGTH = 200;
const MAX_RECORDED_PARSE_ERRORS = 10;

function cloneValue(value) {
    if (value === undefined) {
        return undefined;
    }

    return structuredClone(value);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeObject(target, source, streamedStringFields = STREAMED_MESSAGE_FIELDS) {
    for (const [key, value] of Object.entries(source)) {
        if (key === '__proto__' || key === 'constructor' || value === undefined) {
            continue;
        }

        if (typeof value === 'string' && streamedStringFields.has(key)) {
            target[key] = typeof target[key] === 'string' ? target[key] + value : value;
        } else if (Array.isArray(value)) {
            target[key] = Array.isArray(target[key]) ? target[key].concat(cloneValue(value)) : cloneValue(value);
        } else if (isPlainObject(value)) {
            if (!isPlainObject(target[key])) {
                target[key] = {};
            }
            mergeObject(target[key], value, streamedStringFields);
        } else {
            target[key] = cloneValue(value);
        }
    }
}

function mergeStreamingObject(target, source) {
    for (const [key, value] of Object.entries(source)) {
        if (key === '__proto__' || key === 'constructor' || value === undefined) {
            continue;
        }

        if (typeof value === 'string') {
            target[key] = typeof target[key] === 'string' ? target[key] + value : value;
        } else if (isPlainObject(value)) {
            if (!isPlainObject(target[key])) {
                target[key] = {};
            }
            mergeStreamingObject(target[key], value);
        } else if (Array.isArray(value)) {
            target[key] = cloneValue(value);
        } else if (value !== null || target[key] === undefined) {
            target[key] = cloneValue(value);
        }
    }
}

function mergeToolCalls(target, deltas) {
    for (let position = 0; position < deltas.length; position++) {
        const delta = deltas[position];
        if (!isPlainObject(delta)) {
            continue;
        }

        const toolIndex = Number.isInteger(delta.index) && delta.index >= 0 ? delta.index : position;
        target[toolIndex] ??= {};
        const { index: _index, ...toolDelta } = delta;
        mergeStreamingObject(target[toolIndex], toolDelta);
    }
}

function mergeLogprobs(target, source) {
    if (!isPlainObject(source)) {
        return cloneValue(source);
    }

    const result = isPlainObject(target) ? target : {};
    for (const [key, value] of Object.entries(source)) {
        if (Array.isArray(value)) {
            result[key] = Array.isArray(result[key]) ? result[key].concat(cloneValue(value)) : cloneValue(value);
        } else {
            result[key] = cloneValue(value);
        }
    }
    return result;
}

function normalizeObjectType(value) {
    return typeof value === 'string' && value.endsWith('.chunk') ? value.slice(0, -'.chunk'.length) : value;
}

/**
 * Incrementally reconstructs an OpenAI-compatible completion response from SSE events.
 */
export class ChatCompletionStreamCollector {
    constructor() {
        this.decoder = new TextDecoder('utf-8');
        this.streamBuffer = '';
        this.response = {};
        this.choices = new Map();
        this.parseErrors = [];
        this.parseErrorCount = 0;
        this.parsedEventCount = 0;
        this.doneReceived = false;
        this.finalized = false;
        this.aborted = false;
        this.finalResult = null;
    }

    /**
     * Consume a binary stream chunk.
     * @param {Uint8Array|string} chunk Stream data
     * @returns {{done: boolean, result: ReturnType<ChatCompletionStreamCollector['finish']>|null}}
     */
    push(chunk) {
        if (this.finalized || this.aborted) {
            return { done: this.doneReceived, result: this.finalResult };
        }

        this.streamBuffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
        this.#processEvents();

        if (this.doneReceived) {
            return { done: true, result: this.finish() };
        }

        return { done: false, result: null };
    }

    /**
     * Complete reconstruction after a normally-ended stream.
     * @returns {{response: object|null, complete: boolean, parseErrors: string[], parsedEventCount: number, doneReceived: boolean}}
     */
    finish() {
        if (this.finalResult) {
            return this.finalResult;
        }

        if (this.aborted) {
            return { response: null, complete: false, parseErrors: [], parsedEventCount: 0, doneReceived: false };
        }

        this.streamBuffer += this.decoder.decode();
        this.#processEvents();
        if (!this.doneReceived && this.streamBuffer.trim()) {
            this.#recordParseError('Stream ended with an unterminated SSE event', this.streamBuffer);
        }
        this.finalized = true;

        if (this.parsedEventCount === 0) {
            this.finalResult = {
                response: null,
                complete: false,
                parseErrors: [...this.parseErrors],
                parsedEventCount: 0,
                doneReceived: this.doneReceived,
            };
            return this.finalResult;
        }

        const response = { ...this.response };
        response.choices = [...this.choices.values()]
            .sort((a, b) => a.index - b.index)
            .map(choice => this.#buildChoice(choice));

        this.finalResult = {
            response,
            complete: this.parseErrors.length === 0,
            parseErrors: [...this.parseErrors],
            parsedEventCount: this.parsedEventCount,
            doneReceived: this.doneReceived,
        };
        return this.finalResult;
    }

    abort() {
        if (!this.finalized) {
            this.aborted = true;
            this.streamBuffer = '';
            this.response = {};
            this.choices.clear();
            this.parseErrors = [];
            this.parseErrorCount = 0;
        }
    }

    #processEvents() {
        const events = this.streamBuffer.split(/\r\n\r\n|\r\r|\n\n/g);
        this.streamBuffer = events.pop() ?? '';

        for (const event of events) {
            if (this.doneReceived) {
                break;
            }

            const dataLines = [];
            for (const line of event.split(/\r\n|\r|\n/g)) {
                if (!line || line.startsWith(':')) {
                    continue;
                }

                const separatorIndex = line.indexOf(':');
                const field = separatorIndex === -1 ? line : line.slice(0, separatorIndex);
                let value = separatorIndex === -1 ? '' : line.slice(separatorIndex + 1);
                if (value.startsWith(' ')) {
                    value = value.slice(1);
                }

                if (field === 'data') {
                    dataLines.push(value);
                }
            }

            if (dataLines.length === 0) {
                continue;
            }

            const data = dataLines.join('\n');
            if (data === '[DONE]') {
                this.doneReceived = true;
                continue;
            }

            try {
                const parsed = JSON.parse(data);
                if (isPlainObject(parsed)) {
                    this.parsedEventCount++;
                    this.#mergeResponseChunk(parsed);
                }
            } catch (error) {
                this.#recordParseError(error.message, data);
            }
        }
    }

    #recordParseError(message, data) {
        this.parseErrorCount++;
        if (this.parseErrors.length >= MAX_RECORDED_PARSE_ERRORS) {
            return;
        }

        const preview = data.length > MAX_ERROR_PREVIEW_LENGTH
            ? `${data.slice(0, MAX_ERROR_PREVIEW_LENGTH)}…`
            : data;
        this.parseErrors.push(`${message}: ${preview}`);
    }

    #mergeResponseChunk(chunk) {
        for (const [key, value] of Object.entries(chunk)) {
            if (key === 'choices' || value === undefined) {
                continue;
            }

            this.response[key] = key === 'object' ? normalizeObjectType(value) : cloneValue(value);
        }

        if (!Array.isArray(chunk.choices)) {
            return;
        }

        for (let position = 0; position < chunk.choices.length; position++) {
            const incoming = chunk.choices[position];
            if (!isPlainObject(incoming)) {
                continue;
            }

            const choiceIndex = Number.isInteger(incoming.index) ? incoming.index : position;
            const choice = this.choices.get(choiceIndex) ?? {
                index: choiceIndex,
                extras: {},
                message: null,
                text: undefined,
                logprobs: undefined,
                finish_reason: null,
            };

            for (const [key, value] of Object.entries(incoming)) {
                if (['index', 'delta', 'message', 'text', 'logprobs', 'finish_reason'].includes(key) || value === undefined) {
                    continue;
                }
                choice.extras[key] = cloneValue(value);
            }

            if (typeof incoming.text === 'string') {
                choice.text = (choice.text ?? '') + incoming.text;
            }
            if (incoming.logprobs !== undefined) {
                choice.logprobs = mergeLogprobs(choice.logprobs, incoming.logprobs);
            }
            if (incoming.finish_reason !== undefined && incoming.finish_reason !== null) {
                choice.finish_reason = cloneValue(incoming.finish_reason);
            }
            if (isPlainObject(incoming.delta)) {
                choice.message ??= {};
                this.#mergeMessage(choice.message, incoming.delta);
            }
            if (isPlainObject(incoming.message)) {
                choice.message ??= {};
                this.#mergeMessage(choice.message, incoming.message);
            }

            this.choices.set(choiceIndex, choice);
        }
    }

    #mergeMessage(target, source) {
        for (const [key, value] of Object.entries(source)) {
            if (key === 'tool_calls' && Array.isArray(value)) {
                target.tool_calls ??= [];
                mergeToolCalls(target.tool_calls, value);
            } else if (key === 'function_call' && isPlainObject(value)) {
                target.function_call ??= {};
                mergeStreamingObject(target.function_call, value);
            } else {
                mergeObject(target, { [key]: value });
            }
        }
    }

    #buildChoice(choice) {
        const result = {
            ...choice.extras,
            index: choice.index,
        };

        if (choice.text !== undefined && choice.message === null) {
            result.text = choice.text;
        } else {
            result.message = choice.message ?? { role: 'assistant', content: null };
            result.message.role ??= 'assistant';
            if (result.message.content === undefined) {
                result.message.content = null;
            }
            if (Array.isArray(result.message.tool_calls)) {
                result.message.tool_calls = result.message.tool_calls.filter(Boolean);
            }
        }

        result.logprobs = choice.logprobs ?? null;
        result.finish_reason = choice.finish_reason;
        return result;
    }
}
