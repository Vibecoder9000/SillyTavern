function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter(part => part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text')
        .map(part => String(part.text || ''))
        .join('');
}

function convertContent(content, role) {
    const output = [];
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    if (typeof content === 'string') return content ? [{ type: textType, text: content }] : [];
    if (!Array.isArray(content)) return [];
    for (const part of content) {
        if (part?.type === 'text' || part?.type === 'input_text' || part?.type === 'output_text') {
            output.push({ type: textType, text: String(part.text || '') });
        } else if (part?.type === 'image_url' && role !== 'assistant') {
            const imageUrl = typeof part.image_url === 'string' ? part.image_url : part.image_url?.url;
            if (imageUrl) output.push({ type: 'input_image', image_url: imageUrl, detail: part.image_url?.detail || 'auto' });
        }
    }
    return output;
}

function convertToolCall(toolCall) {
    return {
        type: 'function_call',
        call_id: toolCall.id,
        name: toolCall.function?.name || '',
        arguments: toolCall.function?.arguments || '{}',
    };
}

function convertMessage(message) {
    const items = [];
    if (message?.signature) {
        items.push({ type: 'reasoning', encrypted_content: message.signature, summary: [] });
    }
    if (message?.role === 'tool' || message?.tool_call_id) {
        items.push({
            type: 'function_call_output',
            call_id: message.tool_call_id || message.identifier,
            output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''),
        });
        return items;
    }
    const content = convertContent(message?.content, message?.role);
    if (content.length > 0) {
        items.push({ type: 'message', role: message.role, content });
    }
    if (Array.isArray(message?.tool_calls)) {
        items.push(...message.tool_calls.map(convertToolCall));
    }
    return items;
}

function convertTools(tools) {
    if (!Array.isArray(tools)) return undefined;
    const result = tools.filter(tool => tool?.type === 'function' && tool.function?.name).map(tool => ({
        type: 'function',
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters || {},
        strict: tool.function.strict ?? false,
    }));
    return result.length > 0 ? result : undefined;
}

function convertToolChoice(choice) {
    if (!choice || typeof choice === 'string') return choice;
    if (choice.type === 'function' && choice.function?.name) {
        return { type: 'function', name: choice.function.name };
    }
    return undefined;
}

export function convertChatCompletionRequest(body, {
    store = false,
    forceStream = true,
    encryptedReasoning = false,
} = {}) {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const instructionMessages = [];
    let firstConversationIndex = 0;
    while (firstConversationIndex < messages.length && ['system', 'developer'].includes(messages[firstConversationIndex]?.role)) {
        instructionMessages.push(messages[firstConversationIndex]);
        firstConversationIndex++;
    }
    const instructions = instructionMessages
        .map(message => `${String(message.role).toUpperCase()}:\n${textFromContent(message.content)}`)
        .join('\n\n') || 'Follow the conversation and respond to the user.';
    const input = messages.slice(firstConversationIndex).flatMap(convertMessage);
    const request = {
        model: String(body.model || ''),
        instructions,
        input,
        store,
        stream: forceStream ? true : body.stream,
        include: encryptedReasoning ? ['reasoning.encrypted_content'] : undefined,
        tools: convertTools(body.tools),
        tool_choice: convertToolChoice(body.tool_choice),
    };
    if (body.reasoning_effort && body.reasoning_effort !== 'auto') {
        request.reasoning = {
            effort: body.reasoning_effort === 'min' ? 'minimal' : body.reasoning_effort,
            summary: 'auto',
        };
    }
    if (body.verbosity && body.verbosity !== 'auto') {
        request.text = { verbosity: body.verbosity };
    }
    if (body.json_schema?.value) {
        request.text = {
            ...request.text,
            format: {
                type: 'json_schema',
                name: body.json_schema.name || 'response',
                schema: body.json_schema.value,
                strict: body.json_schema.strict ?? true,
            },
        };
    }
    return Object.fromEntries(Object.entries(request).filter(([, value]) => value !== undefined));
}
