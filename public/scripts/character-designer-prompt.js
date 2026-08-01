const PROMPT_RESOURCE_URL = new URL('../prompts/character-designer.md', import.meta.url);
const VALID_MODES = ['Adaptive', 'Interview', 'Autonomous'];
const REQUIRED_SECTIONS = [
    'shared',
    'broad-definition',
    ...VALID_MODES.flatMap(mode => [`mode:${mode.toLowerCase()}`, `mode-supplement:${mode.toLowerCase()}`]),
];

let promptResourcePromise = null;

function sectionMap(source) {
    const sections = new Map();
    const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
    let current = null;
    for (const line of lines) {
        const match = line.match(/^## \[([^\]]+)\]\s*$/);
        if (match) {
            current = match[1].trim();
            if (sections.has(current)) throw new Error(`Duplicate Character Designer prompt section: ${current}`);
            sections.set(current, []);
            continue;
        }
        if (current) sections.get(current).push(line);
    }
    return new Map([...sections].map(([name, body]) => [name, body.join('\n').trim()]));
}

function requireSection(sections, name) {
    const value = sections.get(name);
    if (!value) throw new Error(`Missing Character Designer prompt section: ${name}`);
    return value;
}

function renderTemplate(template, replacements = {}) {
    return String(template ?? '').replace(/{{([a-zA-Z0-9_.-]+)}}/g, (match, key) => Object.hasOwn(replacements, key) ? String(replacements[key] ?? '') : match);
}

export function parseCharacterDesignerPromptDocument(source) {
    const sections = sectionMap(source);
    for (const name of REQUIRED_SECTIONS) requireSection(sections, name);
    return { sections };
}

export async function loadCharacterDesignerPrompts() {
    if (!promptResourcePromise) {
        promptResourcePromise = fetch(PROMPT_RESOURCE_URL, { cache: 'no-store' })
            .then(response => {
                if (!response.ok) throw new Error(`Character Designer prompt resource returned HTTP ${response.status}.`);
                return response.text();
            })
            .then(parseCharacterDesignerPromptDocument)
            .catch(error => {
                promptResourcePromise = null;
                throw error;
            });
    }
    return promptResourcePromise;
}

/**
 * Render the Character Designer policy with the active editor context.
 * @param {object} options
 * @param {'Adaptive'|'Interview'|'Autonomous'} options.questioningMode
 * @param {string} options.customInstructions
 * @param {string} options.originalCard
 * @param {string} options.toolDefinitions
 * @param {object} options.metadata
 * @param {object} options.promptResource
 * @returns {string}
 */
export function renderCharacterDesignerPrompt({ questioningMode = 'Adaptive', customInstructions = '', originalCard = '', toolDefinitions = '', metadata = {}, promptResource } = {}) {
    if (!promptResource) throw new Error('Character Designer prompt resource has not been loaded.');
    const mode = VALID_MODES.includes(questioningMode) ? questioningMode : 'Adaptive';
    const replacements = {
        questioning_mode: mode,
        questioning_mode_instructions: `${promptResource.sections.get(`mode:${mode.toLowerCase()}`)}\n\n${promptResource.sections.get(`mode-supplement:${mode.toLowerCase()}`)}`,
        custom_editor_instructions: String(customInstructions || '').trim() || '(none)',
        original_card: String(originalCard || ''),
    };
    const rendered = `${renderTemplate(requireSection(promptResource.sections, 'shared'), replacements)}\n\n${requireSection(promptResource.sections, 'broad-definition')}`;
    const tools = String(toolDefinitions || '').trim();
    const editorMetadata = JSON.stringify(metadata || {}, null, 2);
    return `${rendered}\n\n## Available XML tools\n\n${tools || '(none)'}\n\n## Editor metadata\n\n<editor_metadata>\n${editorMetadata}\n</editor_metadata>`;
}
