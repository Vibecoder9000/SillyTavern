import { describe, expect, test } from '@jest/globals';
import { RUNTIME_LIFECYCLE, WorkspaceRuntimeController } from '../public/scripts/chat-workspace-runtime.js';

function createHarness() {
    let slotSequence = 0;
    const actions = [];
    const controller = new WorkspaceRuntimeController({
        createSlot: () => {
            const slot = { id: `slot-${++slotSequence}`, frame: { id: slotSequence } };
            actions.push(['create', slot.id]);
            return slot;
        },
        assignSlot: (slot, assignment) => actions.push([
            'navigate',
            slot.id,
            assignment.sessionId,
            assignment.requestId,
            assignment.previousSessionId,
            assignment.recovering,
        ]),
        setSlotActive: details => actions.push([
            'commit',
            details.slot.id,
            details.sessionId,
            details.previousSessionId,
            details.requestId,
        ]),
    });

    function prepare(activation) {
        controller.markAppReady(activation.slot.id);
        expect(controller.markPrepared(
            activation.slot.id,
            activation.requestId,
            activation.sessionId,
        )).toBe(true);
    }

    return { actions, controller, prepare };
}

describe('single-runtime chat workspace activation', () => {
    test('restoring any number of logical sessions creates one runtime', () => {
        const harness = createHarness();
        const restoredSessions = Array.from({ length: 200 }, (_, index) => `session-${index}`);
        const activation = harness.controller.activate(restoredSessions[0]);
        harness.prepare(activation);

        expect(harness.controller.slots.size).toBe(1);
        expect(harness.actions.filter(([type]) => type === 'create')).toHaveLength(1);
        expect(harness.controller.activeSessionId).toBe('session-0');
    });

    test('A -> B -> C -> A reuses the same iframe and commits after preparation', () => {
        const harness = createHarness();
        const first = harness.controller.activate('A');
        harness.prepare(first);
        const slot = first.slot;

        for (const target of ['B', 'C', 'A']) {
            const activation = harness.controller.activate(target);
            expect(activation.type).toBe('switching');
            expect(activation.slot).toBe(slot);
            expect(harness.controller.activeSessionId).not.toBe(target);
            harness.prepare(activation);
            expect(harness.controller.activeSessionId).toBe(target);
        }

        expect(harness.actions.filter(([type]) => type === 'create')).toHaveLength(1);
        expect(harness.actions.filter(([type]) => type === 'navigate')).toHaveLength(4);
    });

    test('a pending switch rejects duplicate and competing activations', () => {
        const harness = createHarness();
        const a = harness.controller.activate('A');
        harness.prepare(a);
        const b = harness.controller.activate('B');

        expect(harness.controller.activate('B')).toMatchObject({ type: 'pending', sessionId: 'B' });
        expect(harness.controller.activate('C')).toMatchObject({ type: 'pending', sessionId: 'B' });
        expect(harness.actions.filter(([type]) => type === 'navigate')).toHaveLength(2);
        harness.prepare(b);
        expect(harness.controller.activeSessionId).toBe('B');
    });

    test('stale preparation responses cannot commit', () => {
        const harness = createHarness();
        const a = harness.controller.activate('A');
        harness.controller.markAppReady(a.slot.id);

        expect(harness.controller.markPrepared(a.slot.id, a.requestId + 1, 'A')).toBe(false);
        expect(harness.controller.markPrepared(a.slot.id, a.requestId, 'B')).toBe(false);
        expect(harness.controller.activeSessionId).toBeNull();
        harness.prepare(a);
        expect(harness.controller.activeSessionId).toBe('A');
    });

    test('failure retains the outgoing session and supports forced recovery', () => {
        const harness = createHarness();
        const a = harness.controller.activate('A');
        harness.prepare(a);
        const b = harness.controller.activate('B');

        expect(harness.controller.fail(b.slot.id, b.requestId, 'B')).toEqual({
            sessionId: 'B',
            previousSessionId: 'A',
            recovering: false,
        });
        expect(harness.controller.activeSessionId).toBe('A');
        const recovery = harness.controller.activate('A', { force: true, recovering: true });
        expect(recovery).toMatchObject({ type: 'switching', sessionId: 'A', recovering: true });
        harness.prepare(recovery);
        expect(harness.controller.activeSessionId).toBe('A');
    });

    test('unload and reload keep the one runtime and pending assignment', () => {
        const harness = createHarness();
        const activation = harness.controller.activate('A');
        expect(harness.controller.markUnloaded(activation.slot.id)).toBe(true);
        expect(activation.slot.lifecycle).toBe(RUNTIME_LIFECYCLE.BOOTING);
        expect(harness.controller.pendingSessionId).toBe('A');
        expect(harness.controller.markAppReady(activation.slot.id)).toBe(true);
        harness.prepare(activation);
        expect(activation.slot.lifecycle).toBe(RUNTIME_LIFECYCLE.ACTIVE);
        expect(harness.controller.slots.size).toBe(1);
    });

    test('activating the committed session is a no-op', () => {
        const harness = createHarness();
        const activation = harness.controller.activate('A');
        harness.prepare(activation);
        harness.actions.length = 0;

        expect(harness.controller.activate('A')).toMatchObject({ type: 'active', sessionId: 'A' });
        expect(harness.actions).toEqual([]);
    });
});
