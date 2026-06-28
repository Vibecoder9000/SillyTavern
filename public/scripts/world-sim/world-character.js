import {
    characters,
    getCharacters,
    getRequestHeaders,
    selectCharacterById,
    system_avatar,
    is_send_press,
    isGenerating,
} from '../../script.js';

// The World Sim host character. Auto-created on demand and kept dead simple
// (no dedup/persistence machinery) — modelled on ST's built-in Assistant.
const WORLD_CHARACTER_NAME = 'World Sim';
const WORLD_CHARACTER_AVATAR = 'world_sim_host.png';

/**
 * @returns {number} The host character's index in `characters`, or -1 if absent.
 */
function findWorldCharacterId() {
    return characters.findIndex(c => c.avatar === WORLD_CHARACTER_AVATAR);
}

/**
 * Creates the World Sim host character. Mirrors ST's permanent-assistant creation.
 * @returns {Promise<void>}
 */
async function createWorldCharacter() {
    if (is_send_press) {
        throw new Error('Cannot create the World Sim character while generating.');
    }

    const formData = new FormData();
    formData.append('ch_name', WORLD_CHARACTER_NAME);
    formData.append('file_name', WORLD_CHARACTER_AVATAR.replace('.png', ''));
    formData.append('creator_notes', 'Auto-created host for World Sim runs. Selector and updater tool calls appear in this character\'s chat.');

    try {
        const avatarResponse = await fetch(system_avatar);
        const avatarBlob = await avatarResponse.blob();
        formData.append('avatar', avatarBlob, WORLD_CHARACTER_AVATAR);
    } catch (error) {
        console.warn('World Sim: failed to fetch host avatar, using fallback.', error);
    }

    const result = await fetch('/api/characters/create', {
        method: 'POST',
        headers: getRequestHeaders({ omitContentType: true }),
        body: formData,
        cache: 'no-cache',
    });

    if (!result.ok) {
        throw new Error('World Sim host character creation request failed.');
    }

    await getCharacters();
}

/**
 * Whether a generation is currently in flight. A world-sim run must not start while
 * one is running, so switching chats doesn't abandon/lose that generation. (Clobbering
 * an idle chat is merely mildly annoying — the user can just disable auto-tick.)
 * @returns {boolean}
 */
export function isGenerationInProgress() {
    return isGenerating();
}

/**
 * Ensures the World Sim host character exists and switches to its chat, so a run's
 * tool calls render there visibly. Refuses while a generation is in flight.
 * @returns {Promise<boolean>} Whether the host chat is now open.
 */
export async function openWorldCharacterChat() {
    if (isGenerationInProgress()) {
        return false;
    }

    let id = findWorldCharacterId();
    if (id === -1) {
        await createWorldCharacter();
        id = findWorldCharacterId();
        if (id === -1) {
            return false;
        }
    }

    await selectCharacterById(id);
    return true;
}

export { WORLD_CHARACTER_NAME, WORLD_CHARACTER_AVATAR };
