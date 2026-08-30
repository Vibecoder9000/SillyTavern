export class SseParser {
    constructor(onEvent) {
        this.decoder = new TextDecoder();
        this.buffer = '';
        this.onEvent = onEvent;
    }

    async push(chunk, final = false) {
        this.buffer += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: !final });
        if (final) this.buffer += this.decoder.decode();
        const events = this.buffer.split(/\r\n\r\n|\r\r|\n\n/g);
        this.buffer = final ? '' : events.pop() || '';
        for (const raw of events) {
            const data = raw.split(/\r\n|\r|\n/g)
                .filter(line => line.startsWith('data:'))
                .map(line => line.slice(5).trimStart())
                .join('\n');
            if (!data || data === '[DONE]') continue;
            try {
                await this.onEvent(JSON.parse(data));
            } catch (error) {
                if (error instanceof SyntaxError) console.warn('Ignoring malformed Codex SSE event:', data.slice(0, 200));
                else throw error;
            }
        }
    }
}
