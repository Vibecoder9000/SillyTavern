/**
 * Checks whether a chat message belongs to the XML/native tool-call exchange format.
 * API-native function tool messages carry a tool_invocations array and are deliberately excluded.
 * @param {ChatMessage} message Chat message
 * @returns {boolean} Whether the message is an XML tool call or result
 */
export function isXmlToolExchangeMessage(message) {
    return Boolean(
        message?.extra?.is_tool_call ||
        (message?.extra?.is_tool_result && !Array.isArray(message.extra.tool_invocations)),
    );
}

/**
 * Checks whether XML tool exchanges should be hidden from a group character.
 * @param {Group|null|undefined} group Group settings
 * @param {string|null|undefined} characterAvatar Active character avatar ID
 * @param {object} [options] Visibility options
 * @param {boolean} [options.isUserPersona=false] Whether the active generator is the user persona
 * @returns {boolean} Whether XML tool exchanges and instructions should be omitted
 */
export function shouldHideXmlToolExchanges(group, characterAvatar, { isUserPersona = false } = {}) {
    if (isUserPersona || !group?.hide_xml_tool_exchanges || !characterAvatar) {
        return false;
    }

    const visibleMembers = Array.isArray(group.xml_tool_exchange_visible_members)
        ? group.xml_tool_exchange_visible_members
        : [];
    return !visibleMembers.includes(characterAvatar);
}

/**
 * Returns the ordinary assistant text stored alongside an XML tool call.
 * Modern messages retain every text segment, including text after a tool call;
 * legacy messages only retain the prefix that appeared before the call.
 * @param {ChatMessage} message XML tool-call message
 * @returns {string} Text outside XML tool-call blocks
 */
function getXmlToolCallVisibleText(message) {
    if (Array.isArray(message?.extra?.native_tool_segments)) {
        return message.extra.native_tool_segments
            .filter(segment => segment?.type === 'text')
            .map(segment => String(segment.text ?? ''))
            .join('');
    }

    return String(message?.extra?.prefix_text ?? '');
}

/**
 * Creates a prompt-only copy of a mixed text/tool-call message with its tool metadata removed.
 * @param {ChatMessage} message XML tool-call message
 * @param {string} text Text outside XML tool-call blocks
 * @returns {ChatMessage} Sanitized prompt message
 */
function createTextOnlyMessage(message, text) {
    const clone = {
        ...message,
        mes: text,
        extra: { ...message.extra },
    };

    delete clone.extra.is_tool_call;
    delete clone.extra.tool_call_info;
    delete clone.extra.tool_call_parse_error;
    delete clone.extra.tool_call_started;
    delete clone.extra.native_tool_segments;
    delete clone.extra.native_tool_execution;
    delete clone.extra.prefix_text;
    delete clone.extra.reasoning;
    delete clone.extra.reasoning_duration;
    delete clone.extra.reasoning_signature;

    return clone;
}

/**
 * Returns prompt history with XML tool calls and results removed when hidden from the active character.
 * Ordinary assistant text sharing a message with an XML tool call is retained.
 * The source chat array and its messages are never mutated.
 * @param {ChatMessage[]} messages Shared chat history
 * @param {Group|null|undefined} group Group settings
 * @param {string|null|undefined} characterAvatar Active character avatar ID
 * @param {object} [options] Visibility options
 * @param {boolean} [options.isUserPersona=false] Whether the active generator is the user persona
 * @returns {ChatMessage[]} Prompt-visible chat history
 */
export function filterXmlToolExchanges(messages, group, characterAvatar, { isUserPersona = false } = {}) {
    if (!Array.isArray(messages) || !shouldHideXmlToolExchanges(group, characterAvatar, { isUserPersona })) {
        return messages;
    }

    return messages.flatMap(message => {
        if (message?.extra?.is_tool_call) {
            const visibleText = getXmlToolCallVisibleText(message);
            return visibleText.trim() ? [createTextOnlyMessage(message, visibleText)] : [];
        }

        return isXmlToolExchangeMessage(message) ? [] : [message];
    });
}
