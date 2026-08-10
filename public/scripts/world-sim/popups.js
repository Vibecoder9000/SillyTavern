import { Popup, POPUP_RESULT, POPUP_TYPE } from '../popup.js';

let dialogSequence = 0;

/**
 * Builds the shared heading used by World Sim's compact action dialogs.
 * Text is assigned with textContent so names and user-provided labels stay safe.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} options.icon
 * @param {string} options.titleId
 * @param {string} options.descriptionId
 * @param {boolean} [options.danger=false]
 * @returns {HTMLElement}
 */
function buildActionContent({ title, message, icon, titleId, descriptionId, danger = false }) {
    const content = document.createElement('section');
    content.className = `world-sim-confirm${danger ? ' is-danger' : ''}`;
    content.innerHTML = `
        <div class="world-sim-confirm-icon" aria-hidden="true"><i class="fa-solid"></i></div>
        <div class="world-sim-confirm-copy">
            <h3></h3>
            <p class="world-sim-confirm-message"></p>
        </div>
    `;

    const heading = content.querySelector('h3');
    const description = content.querySelector('.world-sim-confirm-message');
    heading.id = titleId;
    heading.textContent = title;
    description.id = descriptionId;
    description.textContent = message;
    content.querySelector('.world-sim-confirm-icon i').classList.add(icon);
    return content;
}

/**
 * Shows a World Sim confirmation using SillyTavern's popup system.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.detail='']
 * @param {string} options.confirmLabel
 * @param {string} [options.icon='fa-circle-question']
 * @param {boolean} [options.danger=false]
 * @returns {Promise<boolean>}
 */
export async function confirmWorldSimAction({
    title,
    message,
    detail = '',
    confirmLabel,
    icon = 'fa-circle-question',
    danger = false,
}) {
    const sequence = ++dialogSequence;
    const titleId = `world-sim-confirm-title-${sequence}`;
    const descriptionId = `world-sim-confirm-description-${sequence}`;
    const content = buildActionContent({ title, message, icon, titleId, descriptionId, danger });
    if (detail) {
        const detailElement = document.createElement('p');
        detailElement.className = 'world-sim-confirm-detail';
        detailElement.textContent = detail;
        content.querySelector('.world-sim-confirm-copy').append(detailElement);
    }

    const popup = new Popup(content, POPUP_TYPE.CONFIRM, '', {
        okButton: confirmLabel,
        cancelButton: 'Cancel',
        defaultResult: POPUP_RESULT.NEGATIVE,
        animation: 'fast',
    });
    popup.dlg.classList.add('world-sim-dialog', 'world-sim-confirm-dialog');
    popup.dlg.classList.toggle('is-danger', danger);
    popup.dlg.setAttribute('aria-labelledby', titleId);
    popup.dlg.setAttribute('aria-describedby', descriptionId);
    popup.okButton.classList.add(danger ? 'world-sim-popup-danger' : 'world-sim-popup-primary');
    popup.cancelButton.classList.add('world-sim-popup-cancel');

    return await popup.show() === POPUP_RESULT.AFFIRMATIVE;
}

/**
 * Shows a themed World Sim text-entry popup.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string} options.message
 * @param {string} [options.value='']
 * @param {string} options.confirmLabel
 * @param {string} [options.icon='fa-pen']
 * @param {string} [options.placeholder='']
 * @param {number} [options.rows=1]
 * @param {number|null} [options.maxLength=null]
 * @param {boolean} [options.required=false]
 * @returns {Promise<string|null>}
 */
export async function promptWorldSimText({
    title,
    message,
    value = '',
    confirmLabel,
    icon = 'fa-pen',
    placeholder = '',
    rows = 1,
    maxLength = null,
    required = false,
}) {
    const sequence = ++dialogSequence;
    const titleId = `world-sim-input-title-${sequence}`;
    const descriptionId = `world-sim-input-description-${sequence}`;
    const content = buildActionContent({ title, message, icon, titleId, descriptionId });
    const popup = new Popup(content, POPUP_TYPE.INPUT, value, {
        okButton: confirmLabel,
        cancelButton: 'Cancel',
        defaultResult: POPUP_RESULT.AFFIRMATIVE,
        placeholder,
        rows,
        maxLength,
        animation: 'fast',
        onClosing: instance => {
            if (instance.result !== POPUP_RESULT.AFFIRMATIVE || !required || instance.mainInput.value.trim()) return true;
            toastr.warning('Enter a value to continue.', 'World Sim');
            instance.mainInput.focus();
            return false;
        },
    });
    popup.dlg.classList.add('world-sim-dialog', 'world-sim-input-dialog');
    popup.dlg.setAttribute('aria-labelledby', titleId);
    popup.dlg.setAttribute('aria-describedby', descriptionId);
    popup.mainInput.setAttribute('aria-labelledby', titleId);
    popup.okButton.classList.add('world-sim-popup-primary');
    popup.cancelButton.classList.add('world-sim-popup-cancel');

    const result = await popup.show();
    return result === false || result === null ? null : String(result);
}
