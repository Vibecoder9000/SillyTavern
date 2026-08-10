import {
    HISTORY_NODE_HEIGHT,
    HISTORY_NODE_WIDTH,
    HISTORY_ORBIT_RADIUS,
    HISTORY_SHARED_NODE_HEIGHT,
    calculateOrbitPositions,
    createDisplayEventHistory,
    editEventSummary,
    getEventAncestors,
    getEventHistory,
    getEventSummaryText,
    layoutEventHistory,
} from './event-history.js';
import { promptWorldSimText } from './popups.js';
const SVG_NS = 'http://www.w3.org/2000/svg';
const SCENE_PADDING_X = HISTORY_ORBIT_RADIUS + 90;
const SCENE_PADDING_Y = HISTORY_ORBIT_RADIUS + 90;
const MIN_SCALE = 0.35;
const MAX_SCALE = 2.4;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const PINCH_ZOOM_SENSITIVITY = 0.01;
const controllers = new WeakMap();

export function renderHistoryTimeline(container, eventHistory, roster, options = {}) {
    controllers.get(container)?.destroy();
    const controller = new HistoryTimeline(container, createDisplayEventHistory(eventHistory), roster, options);
    controllers.set(container, controller);
    controller.render();
    return controller;
}

class HistoryTimeline {
    constructor(container, eventHistory, roster, options = {}) {
        this.container = container;
        this.history = eventHistory;
        this.roster = roster;
        this.options = options;
        this.children = new Map();
        this.basePositions = new Map();
        this.orbitPositions = new Map();
        this.baseNodeElements = new Map();
        this.aggregateElements = new Map();
        this.trail = [];
        this.transform = { x: 36, y: 36, scale: 1 };
        this.drag = null;
        this.pinned = false;
        this.panLockUntil = 0;
        this.closeTimer = null;
        this.abort = new AbortController();
    }

    destroy() {
        this.abort.abort();
        clearTimeout(this.closeTimer);
        this.container.replaceChildren();
    }

    render() {
        this.container.replaceChildren();
        const events = Object.values(this.history?.events || {});
        if (!events.length) {
            const empty = document.createElement('div');
            empty.className = 'world-sim-empty';
            empty.textContent = 'Character events will appear here.';
            this.container.append(empty);
            return;
        }

        const characterIds = Object.values(this.roster?.characters || {})
            .filter(character => events.some(event => event.characterId === character.id))
            .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
            .map(character => character.id);
        this.layout = layoutEventHistory(this.history, characterIds);
        this.children = this.layout.children;

        this.viewport = document.createElement('div');
        this.viewport.className = 'world-sim-history-viewport';
        this.scene = document.createElement('div');
        this.scene.className = 'world-sim-history-scene';
        this.edgeLayer = document.createElementNS(SVG_NS, 'svg');
        this.edgeLayer.classList.add('world-sim-history-edges');
        this.orbitLayer = document.createElement('div');
        this.orbitLayer.className = 'world-sim-history-orbits';

        const maxX = Math.max(...this.layout.nodes.map(node => node.x), 0) + SCENE_PADDING_X * 2 + HISTORY_NODE_WIDTH;
        const maxY = Math.max(...this.layout.nodes.map(node => node.y), 0) + SCENE_PADDING_Y * 2 + HISTORY_SHARED_NODE_HEIGHT;
        this.scene.style.width = `${Math.max(1800, maxX + 1800)}px`;
        this.scene.style.height = `${Math.max(1100, maxY + 900)}px`;
        this.edgeLayer.setAttribute('width', this.scene.style.width);
        this.edgeLayer.setAttribute('height', this.scene.style.height);
        this.scene.append(this.edgeLayer);

        for (const node of this.layout.nodes) this.renderBaseNode(node);
        this.renderEdges();
        this.scene.append(this.orbitLayer);
        this.viewport.append(this.scene);
        this.container.append(this.viewport);
        this.bind();
        this.applyTransform();
        requestAnimationFrame(() => this.recenter(false));
    }

    renderBaseNode(node) {
        const x = SCENE_PADDING_X + node.x;
        const y = SCENE_PADDING_Y + node.y;
        if (node.type === 'aggregate') {
            const element = document.createElement('div');
            element.className = 'world-sim-history-node world-sim-history-aggregate';
            element.dataset.aggregateParent = node.parentId;
            element.tabIndex = 0;
            element.setAttribute('role', 'button');
            element.setAttribute('aria-label', `${node.count} child events`);
            element.textContent = String(node.count);
            this.positionElement(element, x, y, HISTORY_NODE_HEIGHT);
            this.scene.append(element);
            this.aggregateElements.set(node.parentId, element);
            this.basePositions.set(`aggregate:${node.parentId}`, { x, y });
            return;
        }
        const element = this.createEventNode(node.event, 'world-sim-history-base-node');
        this.positionElement(element, x, y, this.nodeHeight(node.event));
        this.scene.append(element);
        this.baseNodeElements.set(node.event.id, element);
        this.basePositions.set(node.event.id, { x, y });
    }

    renderEdges() {
        this.edgeLayer.replaceChildren();
        for (const edge of this.layout.edges) {
            const parent = this.basePositions.get(edge.parentId);
            const child = this.basePositions.get(edge.childId);
            if (!parent || !child) continue;
            const path = document.createElementNS(SVG_NS, 'path');
            const x1 = parent.x + HISTORY_NODE_WIDTH;
            const y1 = parent.y + this.nodeHeight(this.history.events[edge.parentId]) / 2;
            const x2 = child.x;
            const childHeight = edge.childId.startsWith('aggregate:') ? HISTORY_NODE_HEIGHT : this.nodeHeight(this.history.events[edge.childId]);
            const y2 = child.y + childHeight / 2;
            path.setAttribute('d', `M ${x1} ${y1} C ${x1 + 52} ${y1}, ${x2 - 52} ${y2}, ${x2} ${y2}`);
            path.dataset.parentId = edge.parentId;
            path.dataset.childId = edge.childId;
            this.edgeLayer.append(path);
        }
    }

    createEventNode(event, extraClass = '') {
        const node = document.createElement('div');
        node.className = `world-sim-history-node world-sim-history-event-node ${extraClass}`.trim();
        node.classList.toggle('is-initialize', event.kind === 'initialize');
        node.classList.toggle('is-guided', !!event.generation?.guidance);
        node.dataset.eventId = event.id;
        node.tabIndex = 0;
        node.setAttribute('role', 'button');
        const summary = document.createElement('div');
        summary.className = 'world-sim-history-event-summary';
        if (event.kind !== 'initialize' && !event.summary) {
            summary.classList.add('is-missing');
        }
        summary.textContent = event.kind === 'initialize'
            ? this.roster.characters?.[event.characterId]?.name || event.characterId
            : getEventSummaryText(event);
        node.append(summary);
        if (event.generation?.guidance) {
            const marker = document.createElement('i');
            marker.className = 'world-sim-history-guided-marker fa-solid fa-wand-magic-sparkles';
            marker.title = 'Created with user guidance';
            marker.setAttribute('aria-label', 'Created with user guidance');
            node.append(marker);
        }

        const links = (event.participants || []).slice(0, 10)
            .map(link => ({ ...link, name: this.roster.characters?.[link.characterId]?.name || link.characterId }))
            .filter(link => this.history.events?.[link.eventId]);
        node.classList.toggle('has-participants', links.length > 0);
        if (links.length) {
            summary.textContent = `${summary.textContent.replace(/[\s,.;:!?]+$/, '')},`;
            const participants = document.createElement('div');
            participants.className = 'world-sim-history-participants';
            node.append(participants);
            this.renderParticipantSequence(participants, links, links.length, 0);
            requestAnimationFrame(() => this.fitParticipantLinks(participants, links));
        }
        return node;
    }

    renderParticipantSequence(container, links, visibleCount, omitted) {
        container.replaceChildren();
        container.append(document.createTextNode('with '));
        const items = links.slice(0, visibleCount).map(link => ({ type: 'link', link }));
        if (omitted) items.push({ type: 'more', count: omitted });
        items.forEach((item, index) => {
            if (index > 0) {
                const separator = items.length === 2 ? ' and ' : index === items.length - 1 ? ', and ' : ', ';
                container.append(document.createTextNode(separator));
            }
            if (item.type === 'more') {
                const more = document.createElement('span');
                more.className = 'world-sim-history-more';
                more.textContent = `${item.count} more`;
                container.append(more);
                return;
            }
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'world-sim-history-participant';
            button.dataset.targetEvent = item.link.eventId;
            button.textContent = item.link.name;
            container.append(button);
        });
    }

    fitParticipantLinks(container, links) {
        if (!container.isConnected || container.scrollHeight <= container.clientHeight + 1) return;
        for (let visible = links.length - 1; visible >= 0; visible--) {
            this.renderParticipantSequence(container, links, visible, links.length - visible);
            if (container.scrollHeight <= container.clientHeight + 1) return;
        }
    }

    positionElement(element, x, y, height) {
        element.style.left = `${x}px`;
        element.style.top = `${y}px`;
        element.style.width = `${HISTORY_NODE_WIDTH}px`;
        element.style.height = `${height}px`;
    }

    nodeHeight(event) {
        return event?.participants?.length ? HISTORY_SHARED_NODE_HEIGHT : HISTORY_NODE_HEIGHT;
    }

    bind() {
        const options = { signal: this.abort.signal };
        this.scene.addEventListener('pointerover', event => {
            const aggregate = event.target.closest('[data-aggregate-parent]');
            if (aggregate && !this.pinned) this.openAggregate(aggregate.dataset.aggregateParent);
        }, options);
        this.scene.addEventListener('pointerover', event => {
            const bridge = event.target.closest('[data-history-bridge]');
            if (bridge && !this.pinned) this.openDescendants(bridge.dataset.historyBridge, Number(bridge.dataset.level));
        }, options);
        this.scene.addEventListener('click', event => this.onSceneClick(event), options);
        this.scene.addEventListener('keydown', event => {
            if (!['Enter', ' '].includes(event.key)) return;
            const node = event.target.closest('[data-event-id]');
            if (!node) return;
            event.preventDefault();
            this.openDropdown(node.dataset.eventId, node);
        }, options);
        this.viewport.addEventListener('pointerdown', event => this.onPointerDown(event), options);
        window.addEventListener('pointermove', event => this.onPointerMove(event), options);
        window.addEventListener('pointerup', () => { this.drag = null; }, options);
        this.viewport.addEventListener('wheel', event => this.onWheel(event), { passive: false, signal: this.abort.signal });
        this.viewport.addEventListener('pointerleave', () => this.scheduleClose(), options);
        this.viewport.addEventListener('pointerenter', () => clearTimeout(this.closeTimer), options);
        this.scene.addEventListener('pointermove', event => {
            if (!this.trail.length || this.pinned) return;
            if (event.target.closest('.world-sim-history-node, .world-sim-history-hover-bridge, .world-sim-history-dropdown')) {
                clearTimeout(this.closeTimer);
            } else {
                this.scheduleClose();
            }
        }, options);
        document.addEventListener('pointerdown', event => {
            if (!this.dropdown || event.target.closest('.world-sim-history-dropdown') || event.target.closest('[data-event-id]')) return;
            this.closeDropdown();
        }, { capture: true, signal: this.abort.signal });
        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') this.closeDropdown();
        }, options);
    }

    onSceneClick(event) {
        const participant = event.target.closest('[data-target-event]');
        if (participant) {
            event.preventDefault();
            event.stopPropagation();
            this.navigateToParticipant(participant.dataset.targetEvent, participant.closest('[data-event-id]'), event);
            return;
        }
        const node = event.target.closest('[data-event-id]');
        if (!node) return;
        event.stopPropagation();
        this.openDropdown(node.dataset.eventId, node);
    }

    onPointerDown(event) {
        if (event.button !== 0 || event.target.closest('.world-sim-history-node, .world-sim-history-dropdown, button')) return;
        event.preventDefault();
        this.drag = { clientX: event.clientX, clientY: event.clientY, x: this.transform.x, y: this.transform.y };
        this.viewport.setPointerCapture?.(event.pointerId);
    }

    onPointerMove(event) {
        if (!this.drag) return;
        this.transform.x = this.drag.x + event.clientX - this.drag.clientX;
        this.transform.y = this.drag.y + event.clientY - this.drag.clientY;
        this.applyTransform();
    }

    onWheel(event) {
        // Chromium exposes a trackpad pinch as a Ctrl-modified wheel event.
        const isPinch = event.ctrlKey;
        const levelIndex = isPinch ? -1 : this.circleLevelAt(event.clientX, event.clientY);
        if (levelIndex >= 0) {
            event.preventDefault();
            if (this.pinned) return;
            const level = this.trail[levelIndex];
            if (!level) return;
            const direction = event.deltaY > 0 ? 1 : -1;
            level.rotation = Math.max(0, Math.min(level.childIds.length - 1, level.rotation + direction));
            this.panLockUntil = performance.now() + 220;
            this.renderTrail();
            return;
        }
        event.preventDefault();
        const rect = this.viewport.getBoundingClientRect();
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const previous = this.transform.scale;
        const sensitivity = isPinch ? PINCH_ZOOM_SENSITIVITY : WHEEL_ZOOM_SENSITIVITY;
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, previous * Math.exp(-event.deltaY * sensitivity)));
        const worldX = (px - this.transform.x) / previous;
        const worldY = (py - this.transform.y) / previous;
        this.transform.scale = next;
        this.transform.x = px - worldX * next;
        this.transform.y = py - worldY * next;
        this.applyTransform();
    }

    circleLevelAt(clientX, clientY) {
        if (!this.trail.length) return -1;
        const rect = this.viewport.getBoundingClientRect();
        const worldX = (clientX - rect.left - this.transform.x) / this.transform.scale;
        const worldY = (clientY - rect.top - this.transform.y) / this.transform.scale;
        for (let index = this.trail.length - 1; index >= 0; index--) {
            const center = this.getEventPosition(this.trail[index].parentId);
            if (!center) continue;
            const centerX = center.x + HISTORY_NODE_WIDTH / 2;
            const centerY = center.y + this.nodeHeight(this.history.events[this.trail[index].parentId]) / 2;
            if (Math.hypot(worldX - centerX, worldY - centerY) <= HISTORY_ORBIT_RADIUS + HISTORY_NODE_WIDTH / 2) return index;
        }
        return -1;
    }

    openAggregate(parentId) {
        const childIds = (this.children.get(parentId) || []).map(event => event.id);
        if (!childIds.length) return;
        this.trail = [{ parentId, childIds, rotation: 0 }];
        this.renderTrail();
    }

    openDescendants(parentId, levelIndex) {
        const childIds = (this.children.get(parentId) || []).map(event => event.id);
        if (!childIds.length) return;
        this.trail = this.trail.slice(0, Math.max(0, levelIndex + 1));
        this.trail.push({ parentId, childIds, rotation: 0 });
        this.renderTrail();
        this.autoPanForNewestLevel();
    }

    renderTrail() {
        this.orbitLayer.replaceChildren();
        this.orbitPositions.clear();
        this.aggregateElements.forEach((element, parentId) => element.classList.toggle('is-expanded', this.trail.some(level => level.parentId === parentId)));
        const activeIds = new Set();
        this.trail.forEach((level, levelIndex) => {
            activeIds.add(level.parentId);
            const center = this.getEventPosition(level.parentId);
            if (!center) return;
            const events = level.childIds.map(id => this.history.events[id]).filter(Boolean);
            const positions = calculateOrbitPositions(events, level.rotation);
            positions.forEach(item => {
                activeIds.add(item.event.id);
                const height = this.nodeHeight(item.event);
                const x = center.x + HISTORY_NODE_WIDTH / 2 + item.x - HISTORY_NODE_WIDTH / 2;
                const y = center.y + this.nodeHeight(this.history.events[level.parentId]) / 2 + item.y - height / 2;
                const node = this.createEventNode(item.event, 'world-sim-history-orbit-node');
                node.dataset.level = String(levelIndex);
                node.style.zIndex = String(1000 + Math.round(y));
                this.positionElement(node, x, y, height);
                this.orbitLayer.append(node);
                this.orbitPositions.set(item.event.id, { x, y });
                this.ensureSceneSize(x + HISTORY_NODE_WIDTH + HISTORY_ORBIT_RADIUS, y + height + HISTORY_ORBIT_RADIUS);
                if ((this.children.get(item.event.id) || []).length) this.renderHoverBridge(item.event, levelIndex, x, y, height);
            });
        });
        this.scene.classList.toggle('is-exploring', this.trail.length > 0);
        this.scene.querySelectorAll('[data-event-id]').forEach(node => node.classList.toggle('is-related', activeIds.has(node.dataset.eventId)));
        this.fitAllParticipantLinks();
    }

    renderHoverBridge(event, levelIndex, x, y, height) {
        const bridge = document.createElement('div');
        bridge.className = 'world-sim-history-hover-bridge';
        bridge.dataset.historyBridge = event.id;
        bridge.dataset.level = String(levelIndex);
        bridge.style.left = `${x + HISTORY_NODE_WIDTH - 4}px`;
        bridge.style.top = `${y + height * 0.2}px`;
        bridge.style.width = `${Math.max(80, HISTORY_ORBIT_RADIUS * 0.45)}px`;
        bridge.style.height = `${height * 0.6}px`;
        bridge.style.zIndex = '900';
        this.orbitLayer.append(bridge);
    }

    fitAllParticipantLinks() {
        requestAnimationFrame(() => {
            this.orbitLayer.querySelectorAll('.world-sim-history-participants').forEach(container => {
                const node = container.closest('[data-event-id]');
                const event = this.history.events[node?.dataset.eventId];
                if (!event) return;
                const links = (event.participants || []).slice(0, 10)
                    .map(link => ({ ...link, name: this.roster.characters?.[link.characterId]?.name || link.characterId }))
                    .filter(link => this.history.events?.[link.eventId]);
                this.fitParticipantLinks(container, links);
            });
        });
    }

    getEventPosition(eventId) {
        return this.orbitPositions.get(eventId) || this.basePositions.get(eventId) || null;
    }

    ensureSceneSize(width, height) {
        const nextWidth = Math.max(Number.parseFloat(this.scene.style.width) || 0, width);
        const nextHeight = Math.max(Number.parseFloat(this.scene.style.height) || 0, height);
        this.scene.style.width = `${nextWidth}px`;
        this.scene.style.height = `${nextHeight}px`;
        this.edgeLayer.setAttribute('width', String(nextWidth));
        this.edgeLayer.setAttribute('height', String(nextHeight));
    }

    closeTrail() {
        if (this.pinned) return;
        this.trail = [];
        this.renderTrail();
    }

    scheduleClose() {
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => {
            if (this.pinned) return;
            const remainingLock = this.panLockUntil - performance.now();
            if (remainingLock > 0) {
                this.closeTimer = setTimeout(() => this.closeTrail(), remainingLock + 24);
                return;
            }
            this.closeTrail();
        }, 220);
    }

    openDropdown(eventId, node) {
        this.closeDropdown();
        const position = this.getEventPosition(eventId);
        if (!position) return;
        this.pinned = true;
        const menu = document.createElement('div');
        menu.className = 'world-sim-history-dropdown';
        menu.dataset.eventMenu = eventId;
        menu.style.left = `${position.x}px`;
        menu.style.top = `${position.y + this.nodeHeight(this.history.events[eventId]) + 6}px`;
        menu.style.width = `${HISTORY_NODE_WIDTH}px`;
        const selectedEvent = this.history.events[eventId];
        if (selectedEvent?.kind !== 'initialize') {
            const edit = document.createElement('button');
            edit.className = 'menu_button';
            edit.type = 'button';
            edit.textContent = 'Edit event';
            edit.addEventListener('click', async () => {
                const event = this.history.events[eventId];
                if (!event) return;
                const summary = await promptWorldSimText({
                    title: 'Edit event summary',
                    message: 'Change the short description shown on the World Sim timeline.',
                    value: event.summary || '',
                    confirmLabel: 'Save summary',
                    icon: 'fa-pen-to-square',
                    placeholder: 'What happened in this event?',
                    rows: 3,
                    maxLength: 500,
                });
                if (summary === null || summary === event.summary) return;
                edit.disabled = true;
                try {
                    await editEventSummary(event.logicalEventId, event.characterId, summary);
                    renderHistoryTimeline(this.container, getEventHistory(), this.roster, this.options);
                } catch (error) {
                    console.error(error);
                    toastr.error(error.message, 'World Sim');
                    edit.disabled = false;
                }
            });
            menu.append(edit);
        }
        if (selectedEvent?.generation?.guidance) {
            const guidance = document.createElement('div');
            guidance.className = 'world-sim-history-event-guidance';
            const label = document.createElement('strong');
            label.textContent = 'Guidance';
            const text = document.createElement('div');
            text.textContent = selectedEvent.generation.guidance;
            guidance.append(label, text);
            menu.append(guidance);
        }
        const createOption = document.createElement('button');
        createOption.className = 'menu_button';
        createOption.type = 'button';
        createOption.textContent = 'Create next option';
        createOption.disabled = !this.history.events[eventId]?.revisionId || typeof this.options.onCreateOption !== 'function';
        createOption.addEventListener('click', async () => {
            const event = this.history.events[eventId];
            if (!event?.revisionId) return;
            createOption.disabled = true;
            try {
                await this.options.onCreateOption?.(event);
            } catch (error) {
                console.error(error);
                toastr.error(error.message, 'World Sim');
            } finally {
                if (createOption.isConnected) createOption.disabled = false;
            }
        });
        menu.append(createOption);
        this.orbitLayer.append(menu);
        this.dropdown = menu;
        node.classList.add('is-menu-open');
    }

    closeDropdown() {
        this.dropdown?.remove();
        this.dropdown = null;
        this.scene?.querySelectorAll('.is-menu-open').forEach(node => node.classList.remove('is-menu-open'));
        this.pinned = false;
    }

    navigateToParticipant(targetEventId, sourceNode, pointerEvent) {
        const sourceRect = sourceNode.getBoundingClientRect();
        this.closeDropdown();
        this.trail = [];
        this.renderTrail();
        this.revealEvent(targetEventId);
        requestAnimationFrame(() => {
            const target = this.scene.querySelector(`[data-event-id="${CSS.escape(targetEventId)}"]`);
            if (!target) return;
            const rect = target.getBoundingClientRect();
            this.transform.x += sourceRect.left - rect.left;
            this.transform.y += sourceRect.top - rect.top;
            this.panLockUntil = performance.now() + 420;
            this.scene.classList.add('is-auto-panning');
            this.applyTransform();
            target.classList.add('is-jump-target');
            setTimeout(() => {
                this.scene?.classList.remove('is-auto-panning');
                target.classList.remove('is-jump-target');
                const finalRect = target.getBoundingClientRect();
                if (pointerEvent.clientX >= finalRect.left && pointerEvent.clientX <= finalRect.right
                    && pointerEvent.clientY >= finalRect.top && pointerEvent.clientY <= finalRect.bottom) {
                    target.focus({ preventScroll: true });
                }
            }, 360);
        });
    }

    revealEvent(eventId) {
        if (this.baseNodeElements.has(eventId)) return;
        const ancestors = getEventAncestors(eventId, this.history);
        const baseIndex = ancestors.findLastIndex(event => this.baseNodeElements.has(event.id));
        if (baseIndex < 0) return;
        const trail = [];
        for (let index = baseIndex; index < ancestors.length - 1; index++) {
            const parent = ancestors[index];
            const next = ancestors[index + 1];
            const childIds = (this.children.get(parent.id) || []).map(event => event.id);
            const rotation = Math.max(0, childIds.indexOf(next.id));
            trail.push({ parentId: parent.id, childIds, rotation });
        }
        this.trail = trail;
        this.renderTrail();
    }

    autoPanForNewestLevel() {
        requestAnimationFrame(() => {
            const level = this.trail.length - 1;
            const nodes = [...this.orbitLayer.querySelectorAll(`[data-level="${level}"]`)];
            if (!nodes.length) return;
            const viewport = this.viewport.getBoundingClientRect();
            const right = Math.max(...nodes.map(node => node.getBoundingClientRect().right));
            if (right <= viewport.right - 24) return;
            this.transform.x -= right - viewport.right + 36;
            this.panLockUntil = performance.now() + 420;
            this.scene.classList.add('is-auto-panning');
            this.applyTransform();
            setTimeout(() => this.scene?.classList.remove('is-auto-panning'), 360);
        });
    }

    recenter(animate) {
        if (!this.viewport || !this.layout?.nodes.length) return;
        const boundsWidth = Math.max(...this.layout.nodes.map(node => node.x), 0) + HISTORY_NODE_WIDTH;
        const boundsHeight = Math.max(...this.layout.nodes.map(node => node.y), 0) + HISTORY_SHARED_NODE_HEIGHT;
        const scale = Math.max(MIN_SCALE, Math.min(1, (this.viewport.clientWidth - 72) / boundsWidth, (this.viewport.clientHeight - 72) / boundsHeight));
        this.transform.scale = scale;
        this.transform.x = 36 - SCENE_PADDING_X * scale;
        this.transform.y = Math.max(36 - SCENE_PADDING_Y * scale, (this.viewport.clientHeight - boundsHeight * scale) / 2 - SCENE_PADDING_Y * scale);
        this.scene.classList.toggle('is-auto-panning', animate);
        this.applyTransform();
        if (animate) setTimeout(() => this.scene?.classList.remove('is-auto-panning'), 360);
    }

    applyTransform() {
        this.scene.style.transform = `translate(${this.transform.x}px, ${this.transform.y}px) scale(${this.transform.scale})`;
    }
}
