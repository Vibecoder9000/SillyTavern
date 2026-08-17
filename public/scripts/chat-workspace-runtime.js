export const RUNTIME_LIFECYCLE = Object.freeze({
    BOOTING: 'booting',
    ACTIVE: 'active',
    PREPARING: 'preparing',
    FAILED: 'failed',
});

/**
 * Owns the single reusable application runtime used by the chat workspace.
 * Tabs are logical sessions; changing tabs navigates this one runtime.
 */
export class WorkspaceRuntimeController {
    constructor({
        createSlot,
        assignSlot,
        setSlotActive,
    }) {
        this.createSlot = createSlot;
        this.assignSlot = assignSlot;
        this.setSlotActive = setSlotActive;
        this.slot = null;
        this.slots = new Map();
        this.activeSessionId = null;
        this.pendingSessionId = null;
        this.pendingRequestId = null;
        this.requestSequence = 0;
    }

    ensureRuntime() {
        if (this.slot) return this.slot;
        const created = this.createSlot();
        this.slot = {
            id: created.id,
            frame: created.frame,
            lifecycle: RUNTIME_LIFECYCLE.BOOTING,
            sessionId: null,
            targetSessionId: null,
            requestId: null,
            appReady: false,
            recovering: false,
        };
        this.slots.set(this.slot.id, this.slot);
        return this.slot;
    }

    getSlot(slotId) {
        return this.slot?.id === slotId ? this.slot : null;
    }

    getSlotBySession(sessionId) {
        return this.slot?.sessionId === sessionId ? this.slot : null;
    }

    markAppReady(slotId) {
        const slot = this.getSlot(slotId);
        if (!slot) return false;
        slot.appReady = true;
        return true;
    }

    markUnloaded(slotId) {
        const slot = this.getSlot(slotId);
        if (!slot) return false;
        slot.appReady = false;
        slot.lifecycle = RUNTIME_LIFECYCLE.BOOTING;
        return true;
    }

    activate(sessionId, { force = false, recovering = false } = {}) {
        if (!sessionId) return { type: 'failed', requestId: null, slot: null };
        if (this.pendingRequestId) {
            return {
                type: 'pending',
                requestId: this.pendingRequestId,
                slot: this.slot,
                sessionId: this.pendingSessionId,
            };
        }
        if (!force && sessionId === this.activeSessionId) {
            return { type: 'active', requestId: null, slot: this.slot, sessionId };
        }

        const slot = this.ensureRuntime();
        const requestId = ++this.requestSequence;
        this.pendingSessionId = sessionId;
        this.pendingRequestId = requestId;
        slot.targetSessionId = sessionId;
        slot.requestId = requestId;
        slot.recovering = recovering;
        slot.lifecycle = RUNTIME_LIFECYCLE.PREPARING;
        this.assignSlot(slot, {
            sessionId,
            requestId,
            previousSessionId: this.activeSessionId,
            recovering,
        });
        return { type: 'switching', requestId, slot, sessionId, recovering };
    }

    markPrepared(slotId, requestId, sessionId) {
        const slot = this.getSlot(slotId);
        if (!slot
            || requestId !== this.pendingRequestId
            || requestId !== slot.requestId
            || sessionId !== this.pendingSessionId
            || sessionId !== slot.targetSessionId) return false;

        const previousSessionId = this.activeSessionId;
        slot.sessionId = sessionId;
        slot.targetSessionId = null;
        slot.requestId = null;
        slot.recovering = false;
        slot.lifecycle = RUNTIME_LIFECYCLE.ACTIVE;
        this.activeSessionId = sessionId;
        this.pendingSessionId = null;
        this.pendingRequestId = null;
        this.setSlotActive({ slot, sessionId, previousSessionId, requestId });
        return true;
    }

    fail(slotId, requestId, sessionId) {
        const slot = this.getSlot(slotId);
        if (!slot
            || requestId !== this.pendingRequestId
            || requestId !== slot.requestId
            || sessionId !== this.pendingSessionId) return null;
        const failure = {
            sessionId,
            previousSessionId: this.activeSessionId,
            recovering: slot.recovering,
        };
        this.requestSequence++;
        this.pendingSessionId = null;
        this.pendingRequestId = null;
        slot.targetSessionId = null;
        slot.requestId = null;
        slot.recovering = false;
        slot.lifecycle = this.activeSessionId ? RUNTIME_LIFECYCLE.ACTIVE : RUNTIME_LIFECYCLE.FAILED;
        return failure;
    }
}
