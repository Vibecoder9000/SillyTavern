import { debounce_timeout } from './constants.js';

/**
 * Drag and drop handler
 *
 * Can be used on any element, enabling drag&drop styling and callback on drop.
 */
export class DragAndDropHandler {
    /** @private @type {JQuery.Selector} */ selector;
    /** @private @type {(files: File[], event:JQuery.DropEvent<HTMLElement, undefined, any, any>) => void} */ onDropCallback;
    /** @private @type {function} */ onDragEnterCallback;
    /** @private @type {function} */ onDragLeaveCallback;
    /** @private @type {function} */ onDragOverCallback;
    /** @private @type {NodeJS.Timeout} Remark: Not actually NodeJS timeout, but it's close */ dragLeaveTimeout;

    /** @private @type {boolean} */ noAnimation;

    /**
     * Create a DragAndDropHandler
     * @param {JQuery.Selector} selector - The CSS selector for the elements to enable drag and drop
     * @param {(files: File[], event:JQuery.DropEvent<HTMLElement, undefined, any, any>) => void} onDropCallback - The callback function to handle the drop event
     * @param {object} [options] - Additional options
     * @param {boolean} [options.noAnimation=false] - Disable animations
     * @param {(event: JQuery.DragEnterEvent) => void} [options.onDragEnter] - Callback for drag enter
     * @param {(event: JQuery.DragLeaveEvent) => void} [options.onDragLeave] - Callback for drag leave
     * @param {(event: JQuery.DragOverEvent) => void} [options.onDragOver] - Callback for drag over
     */
    constructor(selector, onDropCallback, { noAnimation = false, onDragEnter = null, onDragLeave = null, onDragOver = null } = {}) {
        this.selector = selector;
        this.onDropCallback = onDropCallback;
        this.onDragEnterCallback = onDragEnter;
        this.onDragLeaveCallback = onDragLeave;
        this.onDragOverCallback = onDragOver;
        this.dragLeaveTimeout = null;

        this.noAnimation = noAnimation;

        this.init();
    }

    /**
     * Destroy the drag and drop functionality
     */
    destroy() {
        const target = this.selector === 'body' ? $(document.body) : $(document.body);
        const eventSelector = this.selector === 'body' ? undefined : this.selector;

        target.off('dragenter', eventSelector, this.handleDragEnter.bind(this));
        target.off('dragover', eventSelector, this.handleDragOver.bind(this));
        target.off('dragleave', eventSelector, this.handleDragLeave.bind(this));
        target.off('drop', eventSelector, this.handleDrop.bind(this));

        $(this.selector).removeClass('drop_target no_animation');
    }

    /**
     * Initialize the drag and drop functionality
     * Automatically called on construction
     * @private
     */
    init() {
        const target = this.selector === 'body' ? $(document.body) : $(document.body);
        const eventSelector = this.selector === 'body' ? undefined : this.selector;

        target.on('dragenter', eventSelector, this.handleDragEnter.bind(this));
        target.on('dragover', eventSelector, this.handleDragOver.bind(this));
        target.on('dragleave', eventSelector, this.handleDragLeave.bind(this));
        target.on('drop', eventSelector, this.handleDrop.bind(this));

        $(this.selector).addClass('drop_target');
        if (this.noAnimation) $(this.selector).addClass('no_animation');
    }

    /**
     * @param {JQuery.DragOverEvent<HTMLElement, undefined, any, any>} event - The dragover event
     * @private
     */
    handleDragEnter(event) {
        event.preventDefault();
        event.stopPropagation();
        if (this.onDragEnterCallback) {
            this.onDragEnterCallback(event);
        }
    }

    handleDragOver(event) {
        event.preventDefault();
        event.stopPropagation();
        if (this.onDragOverCallback) {
            this.onDragOverCallback(event);
        }
        clearTimeout(this.dragLeaveTimeout);
        $(event.currentTarget).addClass('drop_target dragover');
        if (this.noAnimation) $(event.currentTarget).addClass('no_animation');
    }

    /**
     * @param {JQuery.DragLeaveEvent<HTMLElement, undefined, any, any>} event - The dragleave event
     * @private
     */
    handleDragLeave(event) {
        event.preventDefault();
        event.stopPropagation();
        if (this.onDragLeaveCallback) {
            this.onDragLeaveCallback(event);
        }

        // Debounce the removal of the class, so it doesn't "flicker" on dragging over
        clearTimeout(this.dragLeaveTimeout);
        this.dragLeaveTimeout = setTimeout(() => {
            $(event.currentTarget).removeClass('dragover');
        }, debounce_timeout.quick);
    }

    /**
     * @param {JQuery.DropEvent<HTMLElement, undefined, any, any>} event - The drop event
     * @private
     */
    handleDrop(event) {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(this.dragLeaveTimeout);
        $(event.currentTarget).removeClass('dragover');

        const files = Array.from(event.originalEvent.dataTransfer.files);
        this.onDropCallback(files, event);
    }
}
