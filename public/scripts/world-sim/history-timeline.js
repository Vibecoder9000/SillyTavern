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
        this.orbitPinned = false;
        this.pointers = new Map();
        this.pinch = null;
        this.tap = null;
        this.panLockUntil = 0;
        this.closeTimer = null;
        this.abort = new AbortController();
    }

    isPinned() {
        return this.pinned || this.orbitPinned;
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
        this.renderToolbar();
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
            element.setAttribute('aria-label', `${node.count} child events. Press Enter to open.`);
            element.setAttribute('aria-expanded', 'false');
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
        if (event.revisionId && this.options.getScene?.(event)) {
            const sceneIcon = document.createElement('i');
            sceneIcon.className = 'world-sim-history-scene-marker fa-solid fa-comments';
            sceneIcon.title = 'A scene is open for this event';
            sceneIcon.setAttribute('aria-label', 'Scene exists for this event');
            node.append(sceneIcon);
        }
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
            if (aggregate && !this.isPinned()) this.openAggregate(aggregate.dataset.aggregateParent);
        }, options);
        this.scene.addEventListener('pointerover', event => {
            const bridge = event.target.closest('[data-history-bridge]');
            if (bridge && !this.isPinned()) this.openDescendants(bridge.dataset.historyBridge, Number(bridge.dataset.level));
        }, options);
        this.scene.addEventListener('click', event => this.onSceneClick(event), options);
        this.scene.addEventListener('keydown', event => {
            if (!['Enter', ' '].includes(event.key)) return;
            const aggregate = event.target.closest('[data-aggregate-parent]');
            if (aggregate) {
                event.preventDefault();
                this.pinAggregate(aggregate.dataset.aggregateParent);
                return;
            }
            if (event.target.closest('button')) return;
            const node = event.target.closest('[data-event-id]');
            if (!node) return;
            event.preventDefault();
            this.openDropdown(node.dataset.eventId, node);
        }, options);
        this.viewport.addEventListener('pointerdown', event => this.onPointerDown(event), options);
        window.addEventListener('pointermove', event => this.onPointerMove(event), options);
        window.addEventListener('pointerup', event => this.onPointerUp(event), options);
        window.addEventListener('pointercancel', event => this.onPointerUp(event), options);
        this.viewport.addEventListener('wheel', event => this.onWheel(event), { passive: false, signal: this.abort.signal });
        this.viewport.addEventListener('pointerleave', () => this.scheduleClose(), options);
        this.viewport.addEventListener('pointerenter', () => clearTimeout(this.closeTimer), options);
        this.scene.addEventListener('pointermove', event => {
            if (!this.trail.length || this.isPinned()) return;
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
            if (event.key !== 'Escape') return;
            this.closeDropdown();
            this.unpinOrbit();
        }, options);
    }

    pinAggregate(parentId) {
        this.closeDropdown();
        this.openAggregate(parentId);
        this.orbitPinned = true;
    }

    unpinOrbit() {
        if (!this.orbitPinned && !this.trail.length) return;
        this.orbitPinned = false;
        this.closeTrail();
    }

    onSceneClick(event) {
        const aggregate = event.target.closest('[data-aggregate-parent]');
        if (aggregate) {
            event.stopPropagation();
            this.pinAggregate(aggregate.dataset.aggregateParent);
            return;
        }
        const rotate = event.target.closest('[data-orbit-rotate]');
        if (rotate) {
            event.stopPropagation();
            this.rotateLevel(Number(rotate.dataset.level), Number(rotate.dataset.orbitRotate));
            return;
        }
        const badge = event.target.closest('[data-child-badge]');
        if (badge) {
            event.stopPropagation();
            this.closeDropdown();
            this.openDescendants(badge.dataset.childBadge, Number(badge.dataset.level));
            this.orbitPinned = true;
            return;
        }
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
        this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (this.pointers.size === 2) {
            const [a, b] = [...this.pointers.values()];
            this.pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y) || 1, scale: this.transform.scale };
            this.drag = null;
            this.tap = null;
            return;
        }
        if (event.button !== 0 || event.target.closest('.world-sim-history-node, .world-sim-history-dropdown, .world-sim-history-toolbar, button')) return;
        event.preventDefault();
        this.drag = { clientX: event.clientX, clientY: event.clientY, x: this.transform.x, y: this.transform.y };
        this.tap = { clientX: event.clientX, clientY: event.clientY };
        this.viewport.setPointerCapture?.(event.pointerId);
    }

    onPointerUp(event) {
        this.pointers.delete(event.pointerId);
        if (this.pointers.size < 2) this.pinch = null;
        const tap = this.tap;
        this.tap = null;
        this.drag = null;
        if (tap && event.type === 'pointerup' && Math.hypot(event.clientX - tap.clientX, event.clientY - tap.clientY) < 5) {
            // Tapping empty canvas closes a pinned orbit or an open event card.
            this.closeDropdown();
            this.unpinOrbit();
        }
    }

    onPointerMove(event) {
        if (this.pointers.has(event.pointerId)) this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (this.pinch && this.pointers.size >= 2) {
            const [a, b] = [...this.pointers.values()];
            const distance = Math.hypot(a.x - b.x, a.y - b.y) || 1;
            this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, this.pinch.scale * distance / this.pinch.distance);
            return;
        }
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
        const sensitivity = isPinch ? PINCH_ZOOM_SENSITIVITY : WHEEL_ZOOM_SENSITIVITY;
        this.zoomAt(event.clientX, event.clientY, this.transform.scale * Math.exp(-event.deltaY * sensitivity));
    }

    /** Zooms to `scale` keeping the point under (clientX, clientY) fixed. */
    zoomAt(clientX, clientY, scale) {
        const rect = this.viewport.getBoundingClientRect();
        const px = clientX - rect.left;
        const py = clientY - rect.top;
        const previous = this.transform.scale;
        const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale));
        const worldX = (px - this.transform.x) / previous;
        const worldY = (py - this.transform.y) / previous;
        this.transform.scale = next;
        this.transform.x = px - worldX * next;
        this.transform.y = py - worldY * next;
        this.applyTransform();
    }

    zoomBy(factor) {
        const rect = this.viewport.getBoundingClientRect();
        this.zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, this.transform.scale * factor);
    }

    renderToolbar() {
        const toolbar = document.createElement('div');
        toolbar.className = 'world-sim-history-toolbar';
        const add = (icon, title, handler) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'menu_button menu_button_icon';
            button.title = title;
            button.setAttribute('aria-label', title);
            button.innerHTML = `<i class="fa-solid ${icon}" aria-hidden="true"></i>`;
            button.addEventListener('click', event => { event.stopPropagation(); handler(); });
            toolbar.append(button);
        };
        add('fa-plus', 'Zoom in', () => this.zoomBy(1.25));
        add('fa-minus', 'Zoom out', () => this.zoomBy(0.8));
        add('fa-crosshairs', 'Fit all', () => this.recenter(true));
        add('fa-forward-step', 'Jump to latest', () => this.jumpToLatest());
        this.container.append(toolbar);
    }

    /** Pans to the newest event by sequence and pulses it. */
    jumpToLatest() {
        const latest = Object.values(this.history.events).sort((a, b) => Number(b.sequence) - Number(a.sequence))[0];
        if (latest) this.focusEvent(latest.id, { pulse: true, force: true });
    }

    /** Pans so the event node is visible (only if off-screen unless `force`). */
    focusEvent(eventId, { pulse = false, force = false } = {}) {
        if (!this.baseNodeElements.has(eventId)) this.revealEvent(eventId);
        requestAnimationFrame(() => {
            const target = this.scene.querySelector(`[data-event-id="${CSS.escape(eventId)}"]`);
            if (!target) return;
            const view = this.viewport.getBoundingClientRect();
            const rect = target.getBoundingClientRect();
            const inside = rect.left >= view.left + 12 && rect.right <= view.right - 12 && rect.top >= view.top + 12 && rect.bottom <= view.bottom - 12;
            if (!inside || force) {
                this.transform.x += view.left + view.width / 2 - (rect.left + rect.width / 2);
                this.transform.y += view.top + view.height / 2 - (rect.top + rect.height / 2);
                this.scene.classList.add('is-auto-panning');
                this.applyTransform();
                setTimeout(() => this.scene?.classList.remove('is-auto-panning'), 360);
            }
            if (pulse) {
                target.classList.add('is-jump-target');
                setTimeout(() => target.classList.remove('is-jump-target'), 1200);
            }
        });
    }

    rotateLevel(levelIndex, direction) {
        const level = this.trail[levelIndex];
        if (!level) return;
        level.rotation = Math.max(0, Math.min(level.childIds.length - 1, level.rotation + direction));
        this.renderTrail();
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
        this.aggregateElements.forEach((element, parentId) => {
            const expanded = this.trail.some(level => level.parentId === parentId);
            element.classList.toggle('is-expanded', expanded);
            element.setAttribute('aria-expanded', String(expanded));
        });
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
                const childCount = (this.children.get(item.event.id) || []).length;
                if (childCount) {
                    this.renderHoverBridge(item.event, levelIndex, x, y, height);
                    const badge = document.createElement('button');
                    badge.type = 'button';
                    badge.className = 'world-sim-history-child-badge';
                    badge.dataset.childBadge = item.event.id;
                    badge.dataset.level = String(levelIndex);
                    badge.textContent = `${childCount} \u203a`;
                    badge.title = `Show ${childCount} following event${childCount === 1 ? '' : 's'}`;
                    badge.setAttribute('aria-label', badge.title);
                    badge.style.left = `${x + HISTORY_NODE_WIDTH - 44}px`;
                    badge.style.top = `${y + height - 22}px`;
                    badge.style.zIndex = '1100';
                    this.orbitLayer.append(badge);
                }
            });
            if (events.length > 6) this.renderOrbitArrows(level, levelIndex, center);
        });
        this.scene.classList.toggle('is-exploring', this.trail.length > 0);
        this.scene.querySelectorAll('[data-event-id]').forEach(node => node.classList.toggle('is-related', activeIds.has(node.dataset.eventId)));
        this.fitAllParticipantLinks();
    }

    renderOrbitArrows(level, levelIndex, center) {
        const controls = document.createElement('div');
        controls.className = 'world-sim-history-orbit-controls';
        controls.style.left = `${center.x}px`;
        controls.style.top = `${center.y + this.nodeHeight(this.history.events[level.parentId]) + 6}px`;
        controls.style.width = `${HISTORY_NODE_WIDTH}px`;
        controls.style.zIndex = '1200';
        const make = (label, text, direction, disabled) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'menu_button menu_button_icon';
            button.dataset.orbitRotate = String(direction);
            button.dataset.level = String(levelIndex);
            button.textContent = text;
            button.title = label;
            button.setAttribute('aria-label', label);
            button.disabled = disabled;
            return button;
        };
        const position = document.createElement('span');
        position.textContent = `${level.rotation + 1} / ${level.childIds.length}`;
        controls.append(
            make('Previous events', '\u2039', -1, level.rotation <= 0),
            position,
            make('Next events', '\u203a', 1, level.rotation >= level.childIds.length - 1),
        );
        this.orbitLayer.append(controls);
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
        if (this.isPinned()) return;
        this.trail = [];
        this.renderTrail();
    }

    scheduleClose() {
        clearTimeout(this.closeTimer);
        this.closeTimer = setTimeout(() => {
            if (this.isPinned()) return;
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
        if (selectedEvent?.revisionId && typeof this.options.onOpenScene === 'function') {
            const existing = this.options.getScene?.(selectedEvent);
            const openScene = document.createElement('button');
            openScene.className = 'menu_button';
            openScene.type = 'button';
            openScene.textContent = existing ? 'Reopen scene' : 'Open scene';
            openScene.addEventListener('click', async () => {
                openScene.disabled = true;
                try {
                    await this.options.onOpenScene(this.history.events[eventId]);
                } catch (error) {
                    console.error(error);
                    toastr.error(error.message, 'World Sim');
                } finally {
                    if (openScene.isConnected) openScene.disabled = false;
                }
            });
            menu.append(openScene);
            if (existing && !existing.committed && typeof this.options.onCommitScene === 'function') {
                const commit = document.createElement('button');
                commit.className = 'menu_button';
                commit.type = 'button';
                commit.textContent = 'Commit scene to world';
                commit.addEventListener('click', async () => {
                    commit.disabled = true;
                    try {
                        await this.options.onCommitScene(this.history.events[eventId], existing);
                    } catch (error) {
                        console.error(error);
                        toastr.error(error.message, 'World Sim');
                    } finally {
                        if (commit.isConnected) commit.disabled = false;
                    }
                });
                menu.append(commit);
            }
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
