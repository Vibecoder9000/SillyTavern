import { getRoster, getState, getLocations, setCharacterStrings, saveWorldSimState, locationFromCoords } from './state.js';
import { getThumbnailUrl } from '../../script.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const PIN_PX = 18;          // pin radius in screen pixels (kept constant across zoom)
const LABEL_PX = 11;        // label font size in screen pixels
const MIN_SPAN = 20;        // most zoomed-in world width
const MAX_SPAN = 5000;      // most zoomed-out world width
const GRID_MIN_PX = 56;     // target minimum spacing between grid lines
const GRID_LABEL_MIN_PX = 120; // target minimum spacing between numeric labels
const LOCATION_CULL_PAD_PX = 240;
const PIN_CULL_PAD_PX = 240;
const CULL_PAD_VIEWPORT_RATIO = 0.35;
const PAN_SEGMENT_REDRAW_RATIO = 0.55;
const LABEL_LINE_HEIGHT = 1.2;
const LABEL_CHAR_WIDTH = 0.6;
const LABEL_PAD_X = 4;
const LABEL_PAD_Y = 2;
const LABEL_MAX_SHIFT_STEPS = 2;
const MOBILE_SIMPLE_RENDER_MAX_WIDTH = 980;
const MOBILE_LOCATION_LABEL_MAX_VISIBLE = 18;
const MOBILE_PIN_LABEL_MAX_VISIBLE = 12;

let containerEl = null;
let svg = null;
let gridLayer = null;
let locationsLayer = null;
let pinsLayer = null;
let labelsLayer = null;
let defsLayer = null;
let listEl = null;
let perfEl = null;
let inited = false;
/** viewBox in SVG space (y-down). World y = -svgY. */
let view = { x: -100, y: -100, w: 200, h: 200 };
let drag = null;
let dragRaf = 0;
let selectedLoc = null;
let selectedLocIds = new Set();
let justInitializedLocIds = new Set();
let selectedCharId = null;
let saveQueued = false;
let panCompositedMode = false;
let renderQueued = false;
let pendingViewBoxRender = false;
let pendingGridRender = false;
let pendingLocationsRender = false;
let pendingPinsRender = false;
let pendingListRender = false;
let pendingRenderRequestedAt = 0;
let pendingRenderRequestCount = 0;
const pinImageUrlCache = new Map();
const perfState = {
    frame: 0,
    lastTs: 0,
    fps: 0,
    avgFrameMs: 0,
    avgGridMs: 0,
    avgLocationsMs: 0,
    avgPinsMs: 0,
    avgListMs: 0,
    avgOtherMs: 0,
    avgTotalMs: 0,
};
const PERF_SMOOTHING = 0.18;
const PERF_LOG_LIMIT = 180;
const PERF_LOG_BATCH_SIZE = 20;
const PERF_LOG_FLUSH_MS = 400;
const DEFAULT_DISPLAY_FLAGS = Object.freeze({
    showGrid: true,
    showLocationBoxes: true,
    showLocationLabels: true,
    showHandles: true,
    showPinRings: true,
    showPinImages: true,
    showPinLabels: true,
});
let perfLogBuffer = [];
let perfLogTimer = null;
let perfHudRaf = 0;
let perfHudLastSampleTs = 0;
let perfHudSampleFrames = 0;

/**
 * @param {string} name
 * @param {Record<string, string|number>} attrs
 * @returns {SVGElement}
 */
function el(name, attrs = {}) {
    const node = document.createElementNS(SVGNS, name);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
}

/**
 * Initializes the map once into its container element.
 * @param {HTMLElement} container
 */
export function initWorldSimMap(container) {
    if (inited || !container) return;
    containerEl = container;
    svg = el('svg', { class: 'world-sim-map-svg' });
    svg.setAttribute('preserveAspectRatio', 'none');
    defsLayer = el('defs');
    const pinClip = el('clipPath', { id: 'ws-pin-clip' });
    pinClip.appendChild(el('circle', { cx: 0, cy: 0, r: PIN_PX }));
    defsLayer.appendChild(pinClip);
    gridLayer = el('g');
    locationsLayer = el('g');
    pinsLayer = el('g');
    labelsLayer = el('g');
    svg.append(defsLayer, gridLayer, locationsLayer, pinsLayer, labelsLayer);
    container.prepend(svg);
    perfEl = document.createElement('div');
    perfEl.className = 'world-sim-map-perf';
    container.appendChild(perfEl);
    updatePerfHud();
    startPerfHudLoop();

    svg.addEventListener('pointerdown', onPointerDown);
    svg.addEventListener('wheel', onWheel, { passive: false });
    container.addEventListener('click', onToolbarClick);

    listEl = document.getElementById('world-sim-locations-list');
    if (listEl) {
        listEl.addEventListener('click', onListClick);
        listEl.addEventListener('input', onListInput);
    }

    if ('ResizeObserver' in window) {
        const ro = new ResizeObserver(() => refreshMap());
        ro.observe(container);
    }
    document.addEventListener('visibilitychange', onVisibilityChange);
    inited = true;
    fitToContent();
    refreshMap({ list: true });
}

/** Redraws the requested map layers from current data + view. */
export function refreshMap({
    viewBox = true,
    grid = true,
    locations = true,
    pins = true,
    list = false,
    immediate = false,
} = {}) {
    if (!inited) return;
    if (!pendingRenderRequestedAt) pendingRenderRequestedAt = performance.now();
    pendingRenderRequestCount++;
    pendingViewBoxRender ||= viewBox;
    pendingGridRender ||= grid;
    pendingLocationsRender ||= locations;
    pendingPinsRender ||= pins;
    pendingListRender ||= list;
    if (immediate && !renderQueued) {
        processQueuedRender(performance.now());
        return;
    }
    if (renderQueued) return;

    renderQueued = true;
    requestAnimationFrame((ts) => processQueuedRender(ts));
}

function processQueuedRender(frameStart = performance.now()) {
    renderQueued = false;
    const profile = {
        frame: ++perfState.frame,
        map: pendingGridRender || pendingLocationsRender || pendingPinsRender,
        list: pendingListRender,
        requestCount: pendingRenderRequestCount,
        queueDelayMs: pendingRenderRequestedAt ? frameStart - pendingRenderRequestedAt : 0,
        frameIntervalMs: perfState.lastTs ? frameStart - perfState.lastTs : 0,
        gridMs: 0,
        locationsMs: 0,
        pinsMs: 0,
        listMs: 0,
        totalMs: 0,
        otherMs: 0,
        viewport: null,
        scale: 0,
        view: null,
        dragType: drag?.type || null,
        panCompositedMode,
        requested: {
            viewBox: pendingViewBoxRender,
            grid: pendingGridRender,
            locations: pendingLocationsRender,
            pins: pendingPinsRender,
            list: pendingListRender,
        },
        rendered: {
            viewBox: false,
            grid: false,
            locations: false,
            pins: false,
            list: false,
        },
        counts: {
            gridLines: 0,
            axisLabels: 0,
            locations: 0,
            totalLocations: 0,
            locationHandles: 0,
            pins: 0,
            totalPins: 0,
            domLocationNodes: 0,
            domPinNodes: 0,
            listItems: 0,
        },
        displayFlags: getDisplayFlags(panCompositedMode),
        ts: frameStart,
    };
    pendingRenderRequestedAt = 0;
    pendingRenderRequestCount = 0;

    if (pendingViewBoxRender || pendingGridRender || pendingLocationsRender || pendingPinsRender) {
        const renderState = {
            viewBox: pendingViewBoxRender,
            grid: pendingGridRender,
            locations: pendingLocationsRender,
            pins: pendingPinsRender,
        };
        pendingViewBoxRender = false;
        pendingGridRender = false;
        pendingLocationsRender = false;
        pendingPinsRender = false;
        profile.map = renderState.grid || renderState.locations || renderState.pins;
        profile.viewBox = renderState.viewBox;
        renderMapLayers(profile, renderState);
    }

    if (pendingListRender) {
        pendingListRender = false;
        const listStart = performance.now();
        profile.counts.listItems = renderLocationsList();
        profile.listMs = performance.now() - listStart;
        profile.rendered.list = true;
    }

    profile.totalMs = performance.now() - frameStart;
    profile.otherMs = Math.max(0, profile.totalMs - profile.gridMs - profile.locationsMs - profile.pinsMs - profile.listMs);
    profile.counts.domLocationNodes = locationsLayer?.childElementCount || 0;
    profile.counts.domPinNodes = pinsLayer?.childElementCount || 0;
    publishFrameProfile(profile);
}

function renderMapLayers(profile, renderState) {
    if (!svg || !gridLayer || !locationsLayer || !pinsLayer || !labelsLayer) return;

    const pxW = svg.clientWidth;
    const pxH = svg.clientHeight;
    if (!pxW || !pxH) return; // not visible yet
    profile.viewport = { width: pxW, height: pxH };

    if (renderState.grid || renderState.locations || renderState.pins) {
        fixAspect(pxW, pxH);
    }
    if (renderState.viewBox || renderState.grid || renderState.locations || renderState.pins) {
        applyViewBox();
    }
    profile.rendered.viewBox = renderState.viewBox || renderState.grid || renderState.locations || renderState.pins;

    const scale = view.w / pxW; // world units per pixel
    profile.scale = scale;
    profile.view = { x: round(view.x), y: round(view.y), w: round(view.w), h: round(view.h) };
    profile.displayFlags = getDisplayFlags(panCompositedMode, scale);
    const labelLayout = createLabelLayout(profile.viewport);
    const labelsFragment = document.createDocumentFragment();
    if (renderState.grid) {
        const gridStart = performance.now();
        const gridCounts = drawGrid(scale, profile.displayFlags);
        profile.gridMs = performance.now() - gridStart;
        profile.rendered.grid = true;
        profile.counts.gridLines = gridCounts.gridLines;
        profile.counts.axisLabels = gridCounts.axisLabels;
    }
    if (renderState.locations) {
        const locationsStart = performance.now();
        const locationCounts = drawLocations(scale, profile.displayFlags, labelLayout);
        profile.locationsMs = performance.now() - locationsStart;
        profile.rendered.locations = true;
        profile.counts.locations = locationCounts.locations;
        profile.counts.totalLocations = locationCounts.totalLocations;
        profile.counts.locationHandles = locationCounts.handles;
        if (locationCounts.labelsFragment) labelsFragment.appendChild(locationCounts.labelsFragment);
    }
    if (renderState.pins) {
        const pinsStart = performance.now();
        const pinCounts = drawPins(scale, profile.displayFlags, labelLayout);
        profile.counts.pins = pinCounts.pins;
        profile.counts.totalPins = pinCounts.totalPins;
        profile.pinsMs = performance.now() - pinsStart;
        profile.rendered.pins = true;
        if (pinCounts.labelsFragment) labelsFragment.appendChild(pinCounts.labelsFragment);
    }
    if (renderState.locations || renderState.pins) {
        labelsLayer.replaceChildren(labelsFragment);
    }
}

/**
 * Renders the HTML overlay listing every boxed location, with inline name/description
 * editing for the selected one. Skipped while a list field is focused so typing isn't
 * clobbered by the frequent refreshMap() calls from panning/zooming/dragging.
 */
function renderLocationsList() {
    if (!listEl) return;
    const active = document.activeElement;
    if (active && active.closest && active.closest('#world-sim-locations-list')) return 0;

    const locs = getLocations().locations || {};
    const entries = Object.entries(locs).sort((a, b) => String(a[1].name || a[0]).localeCompare(String(b[1].name || b[0])));

    listEl.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ws-loclist-head';
    head.textContent = `Locations (${entries.length})`;
    listEl.appendChild(head);

    if (!entries.length) {
        const empty = document.createElement('div');
        empty.className = 'ws-loclist-empty';
        empty.textContent = 'No locations yet.';
        listEl.appendChild(empty);
        return 0;
    }

    for (const [id, loc] of entries) {
        const selected = selectedLocIds.has(id);
        const justInitialized = justInitializedLocIds.has(id);
        const item = document.createElement('div');
        item.className = 'ws-loc-item'
            + (selected ? ' selected' : '')
            + (justInitialized ? ' ws-loc-just-initialized' : '')
            + (isFiniteRect(loc) ? '' : ' unplaced');
        item.setAttribute('data-loc-item', id);

        if (selected) {
            const name = document.createElement('input');
            name.type = 'text';
            name.className = 'text_pole ws-loc-edit-name';
            name.setAttribute('data-loc-edit', id);
            name.value = loc.name || '';
            name.placeholder = 'Name';
            const desc = document.createElement('textarea');
            desc.className = 'text_pole ws-loc-edit-desc';
            desc.setAttribute('data-loc-desc', id);
            desc.value = loc.description || '';
            desc.placeholder = 'Description — what kind of place this is';
            item.append(name, desc);
        } else {
            const nameRow = document.createElement('div');
            nameRow.className = 'ws-loc-item-name';
            nameRow.textContent = loc.name || id;
            item.appendChild(nameRow);
            if (loc.description) {
                const descRow = document.createElement('div');
                descRow.className = 'ws-loc-item-desc';
                descRow.textContent = loc.description;
                item.appendChild(descRow);
            }
        }
        listEl.appendChild(item);
    }
    return entries.length;
}

function onListClick(e) {
    if (e.target.closest('input, textarea')) return;
    const item = e.target.closest('[data-loc-item]');
    if (!item) return;
    const id = item.getAttribute('data-loc-item');
    clearJustInitializedLocation(id);
    selectedLoc = selectedLoc === id ? null : id;
    if (selectedLoc) {
        setSelectedLocationIds([selectedLoc], selectedLoc);
        focusLocation(selectedLoc);
    } else {
        selectedLocIds = new Set();
    }
    refreshMap({ locations: true, pins: true, list: true, grid: true });
}

function onListInput(e) {
    const nameInput = e.target.closest('[data-loc-edit]');
    if (nameInput) {
        const loc = getLocations().locations[nameInput.getAttribute('data-loc-edit')];
        if (loc) { loc.name = nameInput.value; queueSave(); refreshMap({ locations: true }); }
        return;
    }
    const descInput = e.target.closest('[data-loc-desc]');
    if (descInput) {
        const loc = getLocations().locations[descInput.getAttribute('data-loc-desc')];
        if (loc) { loc.description = descInput.value; queueSave(); }
    }
}

/**
 * Centers the view on a location's bounding box (with padding) so selecting it from the
 * list brings it into view.
 * @param {string} id
 */
function focusLocation(id) {
    const loc = getLocations().locations[id];
    if (!isFiniteRect(loc)) return;
    const pad = Math.max(loc.w, loc.h) * 0.6 + 2;
    const targetSpan = clamp(Math.max(loc.w, loc.h) + pad * 2, MIN_SPAN, MAX_SPAN);
    const span = Math.max(targetSpan, view.w / 2);
    const cx = loc.x + loc.w / 2;
    const cy = -(loc.y + loc.h / 2); // world y inverted into svg space
    view = { x: cx - span / 2, y: cy - span / 2, w: span, h: span };
}

function focusWorldPoint(x, y) {
    const span = clamp(Math.max(view.w / 2, MIN_SPAN), MIN_SPAN, MAX_SPAN);
    view = { x: x - span / 2, y: -y - span / 2, w: span, h: span };
}

/**
 * Keeps SVG units square by matching viewBox aspect to the pixel aspect.
 * @param {number} pxW
 * @param {number} pxH
 */
function fixAspect(pxW, pxH) {
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    view.h = view.w * (pxH / pxW);
    view.x = cx - view.w / 2;
    view.y = cy - view.h / 2;
}

function drawGrid(scale, displayFlags = DEFAULT_DISPLAY_FLAGS) {
    if (!displayFlags.showGrid) {
        gridLayer.replaceChildren();
        return { gridLines: 0, axisLabels: 0 };
    }
    const step = niceStep(scale * GRID_MIN_PX);
    const labelStep = step * Math.max(1, Math.ceil(GRID_LABEL_MIN_PX / (step / scale)));
    const left = view.x;
    const right = view.x + view.w;
    const top = view.y;
    const bottom = view.y + view.h;
    const g = el('g', { class: 'ws-grid' });
    const labelFontSize = `${LABEL_PX * scale}px`;
    let gridLines = 0;
    let axisLabels = 0;

    for (let sx = Math.ceil(left / step) * step; sx <= right; sx += step) {
        const axis = Math.abs(sx) < step / 2;
        g.appendChild(el('line', { x1: sx, y1: top, x2: sx, y2: bottom, class: axis ? 'ws-axis' : 'ws-gridline' }));
        gridLines++;
        if (0 >= top && 0 <= bottom && isLabelStep(sx, labelStep, step)) {
            const label = el('text', { x: sx + view.w * 0.004, y: 0 - view.h * 0.004, class: 'ws-axislabel' });
            label.style.fontSize = labelFontSize;
            label.textContent = String(round(sx));
            g.appendChild(label);
            axisLabels++;
        }
    }
    for (let sy = Math.ceil(top / step) * step; sy <= bottom; sy += step) {
        const axis = Math.abs(sy) < step / 2;
        g.appendChild(el('line', { x1: left, y1: sy, x2: right, y2: sy, class: axis ? 'ws-axis' : 'ws-gridline' }));
        gridLines++;
        if (Math.abs(sy) > step / 2 && isLabelStep(sy, labelStep, step)) {
            const label = el('text', { x: view.x + view.w * 0.004, y: sy - view.h * 0.004, class: 'ws-axislabel' });
            label.style.fontSize = labelFontSize;
            label.textContent = String(round(-sy)); // world y is inverted
            g.appendChild(label);
            axisLabels++;
        }
    }
    gridLayer.replaceChildren(g);
    return { gridLines, axisLabels };
}

/**
 * @param {number} scale world units per pixel
 * @param {ReturnType<typeof createLabelLayout>} labelLayout
 */
function drawLocations(scale, displayFlags = DEFAULT_DISPLAY_FLAGS, labelLayout = null) {
    const locs = getLocations().locations || {};
    const boxesFragment = document.createDocumentFragment();
    const labelsFragment = document.createDocumentFragment();
    const labelFontSize = `${(LABEL_PX + 1) * scale}px`;
    let locations = 0;
    let totalLocations = 0;
    let handles = 0;
    const bounds = getCullingBounds(scale, LOCATION_CULL_PAD_PX);
    const entries = Object.entries(locs)
        .filter(([, loc]) => isFiniteRect(loc))
        .sort((a, b) => {
            const aSelected = selectedLocIds.has(a[0]) ? 1 : 0;
            const bSelected = selectedLocIds.has(b[0]) ? 1 : 0;
            if (aSelected !== bSelected) return bSelected - aSelected;
            return (b[1].w * b[1].h) - (a[1].w * a[1].h);
        });

    for (const [id, loc] of entries) {
        totalLocations++;
        if (selectedLoc !== id && !rectIntersectsBounds(loc.x, loc.y, loc.w, loc.h, bounds)) continue;
        locations++;
        const sx = loc.x;
        const sy = -(loc.y + loc.h); // svg top edge
        const selected = selectedLocIds.has(id);
        const justInitialized = justInitializedLocIds.has(id);
        const rect = el('rect', {
            x: sx, y: sy, width: loc.w, height: loc.h,
            rx: 0.15,
            class: 'ws-loc'
                + (selected ? ' selected' : '')
                + (justInitialized ? ' ws-loc-just-initialized' : ''),
            'data-loc': id,
        });
        if (displayFlags.showLocationBoxes) boxesFragment.appendChild(rect);
        if (displayFlags.showLocationLabels || selected) {
            const text = String(loc.name || id);
            const placed = placeLabel(labelLayout, {
                text,
                fontPx: LABEL_PX + 1,
                anchorXWorld: sx + loc.w / 2,
                anchorYWorld: sy + 0.04 + LABEL_PX * scale,
                selected,
            });
            if (placed) {
                const label = el('text', { x: placed.xWorld, y: placed.yWorld, class: 'ws-loc-label', 'data-loc': id });
                label.style.fontSize = labelFontSize;
                label.textContent = text;
                labelsFragment.appendChild(label);
            }
        }

        if (selected && displayFlags.showHandles) {
            const hr = PIN_PX * 0.5 * scale;
            // resize handle (upper-right corner in world = top-right in svg)
            boxesFragment.appendChild(el('rect', { x: sx + loc.w - hr, y: sy - hr, width: hr * 2, height: hr * 2, class: 'ws-handle resize', 'data-handle': id }));
            handles++;
            // delete handle (top-left)
            const del = el('g', { class: 'ws-handle delete', 'data-del': id });
            del.appendChild(el('circle', { cx: sx, cy: sy, r: hr * 1.1 }));
            const x1 = el('text', { x: sx, y: sy + hr * 0.55, class: 'ws-handle-x' });
            x1.style.fontSize = `${LABEL_PX * scale}px`;
            x1.textContent = '×';
            del.appendChild(x1);
            boxesFragment.appendChild(del);
            handles++;
        }
    }
    locationsLayer.replaceChildren(boxesFragment);
    return { locations, totalLocations, handles, labelsFragment };
}

/**
 * @param {number} scale world units per pixel
 * @param {ReturnType<typeof createLabelLayout>} labelLayout
 */
function drawPins(scale, displayFlags = DEFAULT_DISPLAY_FLAGS, labelLayout = null) {
    const roster = getRoster();
    const state = getState();
    const r = PIN_PX;
    let idx = 0;
    const pinsFragment = document.createDocumentFragment();
    const labelsFragment = document.createDocumentFragment();
    const labelFontSize = `${LABEL_PX * scale}px`;
    const bounds = getCullingBounds(scale, PIN_CULL_PAD_PX);

    const included = Object.values(roster.characters || {}).filter(c => c.included);
    for (const char of included) {
        const strings = state.characters[char.id] || { location: '', activity: '', plan: '' };
        let displayX, displayY;
        if (Number.isFinite(strings.x) && Number.isFinite(strings.y)) {
            displayX = strings.x;
            displayY = strings.y;
        } else {
            // Not yet placed — render at a placeholder position without touching state.
            const cols = 5;
            displayX = ((idx % cols) - 2) * 2;
            displayY = Math.floor(idx / cols) * -2;
        }
        idx++;

        const cx = displayX;
        const cy = -displayY;
        if (!pointInBounds(cx, cy, bounds)) continue;
        const selected = selectedCharId === char.id;
        const g = el('g', { class: `ws-pin${selected ? ' selected' : ''}`, 'data-pin': char.id, transform: `translate(${cx} ${cy}) scale(${scale})` });
        if (selected) {
            g.appendChild(el('circle', { cx: 0, cy: 0, r: r * 1.7, class: 'ws-pin-glow' }));
        }
        if (displayFlags.showPinRings) {
            g.appendChild(el('circle', { cx: 0, cy: 0, r: r * 1.08, class: 'ws-pin-ring' }));
        }
        if (displayFlags.showPinImages) {
            const img = el('image', { x: -r, y: -r, width: r * 2, height: r * 2, 'clip-path': 'url(#ws-pin-clip)', preserveAspectRatio: 'xMidYMid slice' });
            const avatarUrl = getPinImageUrl(char);
            img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', avatarUrl);
            img.setAttribute('href', avatarUrl);
            g.appendChild(img);
        }

        if (displayFlags.showPinLabels) {
            const placed = placeLabel(labelLayout, {
                text: String(char.name || ''),
                fontPx: LABEL_PX,
                anchorXWorld: cx,
                anchorYWorld: cy + (r + LABEL_PX * 1.1) * scale,
                selected,
            });
            if (placed) {
                const label = el('text', {
                    x: placed.xWorld,
                    y: placed.yWorld,
                    class: 'ws-pin-label',
                });
                label.style.fontSize = labelFontSize;
                label.textContent = char.name;
                labelsFragment.appendChild(label);
            }
        }

        pinsFragment.appendChild(g);
    }
    pinsLayer.replaceChildren(pinsFragment);
    return { pins: pinsFragment.childElementCount, totalPins: included.length, labelsFragment };
}

// ---- Interaction ----

function onPointerDown(e) {
    // elementsFromPoint gives all hit elements top-to-bottom in render order,
    // letting us apply explicit priority regardless of SVG z-layer.
    const hits = document.elementsFromPoint(e.clientX, e.clientY)
        .filter(n => svg.contains(n));

    // Delete handle — highest priority
    for (const node of hits) {
        const del = node.closest('[data-del]');
        if (del) { deleteLocation(del.getAttribute('data-del')); return; }
    }

    // Resize handle — always beats pin/loc drag
    for (const node of hits) {
        const handle = node.closest('[data-handle]');
        if (handle) {
            startDrag(e, { type: 'resize', id: handle.getAttribute('data-handle') });
            return;
        }
    }

    // Collect candidate pins and locs
    const pinIds = [];
    const locIds = [];
    const seenPins = new Set();
    const seenLocs = new Set();
    for (const node of hits) {
        const pin = node.closest('[data-pin]');
        if (pin) {
            const id = pin.getAttribute('data-pin');
            if (!seenPins.has(id)) { seenPins.add(id); pinIds.push(id); }
        }
        const loc = node.closest('[data-loc]');
        if (loc) {
            const id = loc.getAttribute('data-loc');
            if (!seenLocs.has(id)) { seenLocs.add(id); locIds.push(id); }
        }
    }

    // Pins beat locs; among multiple locs pick the smallest area
    if (pinIds.length) {
        const id = pinIds[0];
        selectedCharId = id;
        startDrag(e, { type: 'pin', id });
        return;
    }

    if (locIds.length) {
        const locs = getLocations().locations;
        let bestId = locIds[0], bestArea = Infinity;
        for (const id of locIds) {
            const loc = locs[id];
            const area = loc ? (loc.w || 0) * (loc.h || 0) : Infinity;
            if (area < bestArea) { bestArea = area; bestId = id; }
        }
        setSelectedLocationIds([bestId], bestId);
        clearJustInitializedLocation(bestId);
        startDrag(e, { type: 'loc', id: bestId, world: screenToWorld(e) });
        return;
    }

    if (selectedLoc || selectedCharId) {
        selectedLoc = null;
        selectedLocIds = new Set();
        selectedCharId = null;
        refreshMap({ locations: true, list: true, pins: true, grid: false });
    }
    startDrag(e, { type: 'pan', svg0: { x: view.x, y: view.y, w: view.w, h: view.h } });
}

function startDrag(e, info) {
    const w = clientToWorld(e.clientX, e.clientY);
    const s = clientToSvg(e.clientX, e.clientY);
    drag = {
        ...info,
        startWorld: w,
        startSvg: s,
        startClientX: e.clientX,
        startClientY: e.clientY,
        latestClientX: e.clientX,
        latestClientY: e.clientY,
    };
    if (info.type === 'loc') {
        const loc = getLocations().locations[info.id];
        drag.orig = { x: loc.x, y: loc.y };
    }
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    e.preventDefault();
}

function onPointerMove(e) {
    if (!drag) return;
    drag.latestClientX = e.clientX;
    drag.latestClientY = e.clientY;
    scheduleDragFrame();
}

function scheduleDragFrame() {
    if (!drag || dragRaf) return;
    dragRaf = requestAnimationFrame(() => {
        dragRaf = 0;
        applyDragFrame();
    });
}

function applyDragFrame() {
    if (!drag) return;
    if (drag.type === 'pan') {
        const dx = drag.latestClientX - drag.startClientX;
        const dy = drag.latestClientY - drag.startClientY;
        if (shouldRedrawPanSegment(dx, dy) && commitPanSegment(dx, dy)) return;
        setPanVisualOffset(dx, dy);
        publishCompositedPanProfile(dx, dy);
        return;
    }
    const w = clientToWorld(drag.latestClientX, drag.latestClientY);
    if (drag.type === 'pin') {
        setCharacterStrings(drag.id, { x: round(w.x), y: round(w.y) });
        refreshMap({ grid: false, locations: false, pins: true, viewBox: false, immediate: true });
    } else if (drag.type === 'loc') {
        const loc = getLocations().locations[drag.id];
        loc.x = round(drag.orig.x + (w.x - drag.startWorld.x));
        loc.y = round(drag.orig.y + (w.y - drag.startWorld.y));
        refreshMap({ grid: false, locations: true, pins: false, viewBox: false, immediate: true });
    } else if (drag.type === 'resize') {
        const loc = getLocations().locations[drag.id];
        loc.w = Math.max(10, round(w.x - loc.x));
        loc.h = Math.max(10, round(w.y - loc.y));
        refreshMap({ grid: false, locations: true, pins: false, viewBox: false, immediate: true });
    }
}

function onPointerUp() {
    if (dragRaf) {
        cancelAnimationFrame(dragRaf);
        dragRaf = 0;
        applyDragFrame();
    }
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    const finishedDragType = drag?.type;
    if (finishedDragType === 'pan') {
        const nextView = getDragPanView(
            (drag?.latestClientX ?? drag?.startClientX ?? 0) - (drag?.startClientX ?? 0),
            (drag?.latestClientY ?? drag?.startClientY ?? 0) - (drag?.startClientY ?? 0),
        );
        if (nextView) view = nextView;
        setPanVisualOffset(0, 0);
        refreshMap({ viewBox: true, grid: true, locations: true, pins: true, list: false });
    } else if (finishedDragType === 'pin') {
        const strings = getState().characters[drag.id];
        if (strings) {
            setCharacterStrings(drag.id, { x: snap(strings.x), y: snap(strings.y) });
            refreshMap({ grid: false, locations: false, pins: true, viewBox: false });
        }
    } else if (finishedDragType === 'loc') {
        const loc = getLocations().locations[drag.id];
        if (loc) {
            loc.x = snap(loc.x);
            loc.y = snap(loc.y);
            refreshMap({ grid: false, locations: true, pins: false, viewBox: false });
        }
    } else if (finishedDragType === 'resize') {
        const loc = getLocations().locations[drag.id];
        if (loc) {
            loc.w = Math.max(10, snap(loc.w));
            loc.h = Math.max(10, snap(loc.h));
            refreshMap({ grid: false, locations: true, pins: false, viewBox: false });
        }
    }
    if (drag && drag.type !== 'pan') queueSave();
    drag = null;
}

function onWheel(e) {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.1 : 1 / 1.1;
    zoomAt(e, factor);
}

/**
 * @param {PointerEvent|WheelEvent} e
 * @param {number} factor
 */
function zoomAt(e, factor) {
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    const newW = clamp(view.w * factor, MIN_SPAN, MAX_SPAN);
    const realFactor = newW / view.w;
    const newH = view.h * realFactor;
    const sx = view.x + px * view.w;
    const sy = view.y + py * view.h;
    view.x = sx - px * newW;
    view.y = sy - py * newH;
    view.w = newW;
    view.h = newH;
    refreshMap();
}

function onToolbarClick(e) {
    const btn = e.target.closest('[data-map]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const action = btn.getAttribute('data-map');
    if (action === 'zoom-in') zoomCenter(1 / 1.3);
    else if (action === 'zoom-out') zoomCenter(1.3);
    else if (action === 'recenter') { fitToContent(); refreshMap(); }
    else if (action === 'add-location') addLocation();
}

/**
 * Sets the view to fit all locations and placed character pins, with padding.
 * Falls back to a default view if there is no content.
 */
export function fitToContent() {
    const locs = Object.values(getLocations().locations || {}).filter(isFiniteRect);
    const state = getState();
    const placedChars = Object.values(state.characters || {}).filter(s => Number.isFinite(s.x) && Number.isFinite(s.y));

    if (!locs.length && !placedChars.length) {
        view = { x: -100, y: -100, w: 200, h: 200 };
        return;
    }

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const loc of locs) {
        minX = Math.min(minX, loc.x);
        maxX = Math.max(maxX, loc.x + loc.w);
        minY = Math.min(minY, loc.y);
        maxY = Math.max(maxY, loc.y + loc.h);
    }
    for (const s of placedChars) {
        minX = Math.min(minX, s.x);
        maxX = Math.max(maxX, s.x);
        minY = Math.min(minY, s.y);
        maxY = Math.max(maxY, s.y);
    }

    const pad = Math.max((maxX - minX), (maxY - minY)) * 0.15 + 20;
    const worldW = (maxX - minX) + pad * 2;
    const worldH = (maxY - minY) + pad * 2;

    const pxW = svg.clientWidth || 400;
    const pxH = svg.clientHeight || 400;
    const aspect = pxW / pxH;

    // Keep the view's aspect ratio matched to the SVG element.
    let vw = worldW, vh = worldH;
    if (vw / vh > aspect) vh = vw / aspect;
    else vw = vh * aspect;

    // World coords: y-up. SVG coords: y-down (negate y).
    view = {
        x: minX - pad - (vw - worldW) / 2,
        y: -(maxY + pad) - (vh - worldH) / 2,
        w: vw,
        h: vh,
    };
}

/**
 * Marks one or more location ids as newly initialized so the map/list can highlight them.
 * @param {string|string[]} ids
 */
export function markJustInitializedLocations(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    let changed = false;
    for (const id of list) {
        if (!id || justInitializedLocIds.has(id)) continue;
        justInitializedLocIds.add(id);
        changed = true;
    }
    if (changed) refreshMap({ locations: true, list: true, pins: false, grid: false });
}

/**
 * Clears a just-initialized marker for a location after the user opens it.
 * @param {string} id
 */
function clearJustInitializedLocation(id) {
    if (!id || !justInitializedLocIds.has(id)) return;
    justInitializedLocIds.delete(id);
}

/**
 * Highlights a character's place on the map and optionally centers the view on it.
 * @param {string|null} characterId
 * @param {{ focus?: boolean }} [options]
 * @returns {boolean}
 */
export function selectCharacterOnMap(characterId, { focus = true } = {}) {
    selectedCharId = characterId || null;

    if (!characterId) {
        selectedLoc = null;
        selectedLocIds = new Set();
        refreshMap({ locations: true, pins: true, list: true, grid: false });
        return false;
    }

    const strings = getState().characters?.[characterId] || {};
    const locationName = locationFromCoords(strings.x, strings.y) || strings.location || '';
    const primaryLocationId = findLocationIdAtCoords(strings.x, strings.y) || findLocationIdByName(locationName);
    setSelectedLocationIds(primaryLocationId ? [primaryLocationId] : [], primaryLocationId);

    if (focus) {
        if (primaryLocationId) focusLocation(primaryLocationId);
        else if (Number.isFinite(strings.x) && Number.isFinite(strings.y)) focusWorldPoint(strings.x, strings.y);
    }

    refreshMap({ locations: true, pins: true, list: true, grid: true });
    return Boolean(primaryLocationId || (Number.isFinite(strings.x) && Number.isFinite(strings.y)));
}

function zoomCenter(factor) {
    const rect = svg.getBoundingClientRect();
    zoomAt({ clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }, factor);
}

function addLocation() {
    const name = prompt('Location name:', '');
    if (!name) return;
    const locs = getLocations();
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `loc-${Date.now()}`;
    while (locs.locations[id]) id += '-2';
    const size = Math.max(2, round(view.w / 5));
    const cxWorld = round(view.x + view.w / 2);
    const cyWorld = round(-(view.y + view.h / 2));
    locs.locations[id] = { name, description: '', x: cxWorld - size / 2, y: cyWorld - size / 2, w: size, h: size, adjacent: [] };
    setSelectedLocationIds([id], id);
    queueSave();
    refreshMap({ locations: true, list: true, pins: false, grid: false });
}

function deleteLocation(id) {
    const locs = getLocations();
    delete locs.locations[id];
    if (selectedLoc === id) {
        selectedLoc = null;
        selectedLocIds = new Set();
    }
    justInitializedLocIds.delete(id);
    queueSave();
    refreshMap({ locations: true, list: true, pins: false, grid: false });
}

function findLocationIdByName(name) {
    const needle = String(name || '').trim().toLowerCase();
    if (!needle) return null;

    for (const [id, loc] of Object.entries(getLocations().locations || {})) {
        if (String(loc?.name || id).trim().toLowerCase() === needle) {
            return id;
        }
    }

    return null;
}

function findLocationIdAtCoords(x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;

    for (const [id, loc] of Object.entries(getLocations().locations || {})) {
        if (!isFiniteRect(loc)) continue;
        if (x >= loc.x && x <= loc.x + loc.w && y >= loc.y && y <= loc.y + loc.h) {
            return id;
        }
    }

    return null;
}

function setSelectedLocationIds(ids, primaryId = null) {
    selectedLocIds = new Set(Array.isArray(ids) ? ids.filter(Boolean) : []);
    selectedLoc = primaryId || selectedLocIds.values().next().value || null;
}

function findConnectedLocationIds(seedId) {
    const locs = getLocations().locations || {};
    const seed = locs[seedId];
    if (!isFiniteRect(seed)) return [];

    const connected = new Set([seedId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const [id, loc] of Object.entries(locs)) {
            if (connected.has(id) || !isFiniteRect(loc)) continue;
            for (const cid of connected) {
                const cur = locs[cid];
                if (rectsTouchOrOverlap(cur, loc)) {
                    connected.add(id);
                    changed = true;
                    break;
                }
            }
        }
    }
    return [...connected];
}

function rectsTouchOrOverlap(a, b) {
    if (!isFiniteRect(a) || !isFiniteRect(b)) return false;
    return !(
        a.x + a.w < b.x ||
        b.x + b.w < a.x ||
        a.y + a.h < b.y ||
        b.y + b.h < a.y
    );
}

// ---- helpers ----

function screenToSvg(e) {
    return clientToSvg(e.clientX, e.clientY);
}

function clientToSvg(clientX, clientY) {
    const rect = svg.getBoundingClientRect();
    return {
        x: view.x + ((clientX - rect.left) / rect.width) * view.w,
        y: view.y + ((clientY - rect.top) / rect.height) * view.h,
    };
}

function applyViewBox() {
    if (!svg) return;
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
}

function getDragPanView(dx, dy) {
    if (!svg || !drag?.svg0) return null;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
        x: drag.svg0.x - (dx / rect.width) * drag.svg0.w,
        y: drag.svg0.y - (dy / rect.height) * drag.svg0.h,
        w: drag.svg0.w,
        h: drag.svg0.h,
    };
}

function getCullPadPx(basePx) {
    const viewportMin = Math.min(svg?.clientWidth || 0, svg?.clientHeight || 0);
    return Math.max(basePx, viewportMin * CULL_PAD_VIEWPORT_RATIO);
}

function shouldRedrawPanSegment(dx, dy) {
    const thresholdPx = getCullPadPx(Math.max(LOCATION_CULL_PAD_PX, PIN_CULL_PAD_PX)) * PAN_SEGMENT_REDRAW_RATIO;
    return Math.abs(dx) >= thresholdPx || Math.abs(dy) >= thresholdPx;
}

function commitPanSegment(dx, dy) {
    const nextView = getDragPanView(dx, dy);
    if (!nextView || !drag) return false;
    view = nextView;
    drag.svg0 = { ...nextView };
    drag.startClientX = drag.latestClientX;
    drag.startClientY = drag.latestClientY;
    setPanVisualOffset(0, 0);
    refreshMap({ viewBox: true, grid: true, locations: true, pins: true, list: false, immediate: true });
    return true;
}

function getDisplayFlags(composited, scale = 0) {
    const flags = { ...DEFAULT_DISPLAY_FLAGS };
    if (!shouldPreferSimpleRendering()) return flags;

    const bounds = getCullingBounds(scale || (view.w / Math.max(1, svg?.clientWidth || 1)), Math.max(LOCATION_CULL_PAD_PX, PIN_CULL_PAD_PX));
    const visibleLocationCount = countVisibleLocations(bounds);
    const visiblePinCount = countVisiblePins(bounds);

    flags.showHandles = !composited;
    if (composited) flags.showGrid = false;
    if (visibleLocationCount > MOBILE_LOCATION_LABEL_MAX_VISIBLE) flags.showLocationLabels = false;
    if (visiblePinCount > MOBILE_PIN_LABEL_MAX_VISIBLE || composited) flags.showPinLabels = false;
    return flags;
}

function createLabelLayout(viewport) {
    if (!viewport?.width || !viewport?.height || !view.w || !view.h) return null;
    return {
        viewport,
        occupied: [],
    };
}

function placeLabel(layout, { text, fontPx, anchorXWorld, anchorYWorld, selected = false }) {
    if (!text) return null;
    if (!layout) return { xWorld: anchorXWorld, yWorld: anchorYWorld };

    const lineHeightPx = fontPx * LABEL_LINE_HEIGHT;
    const widthPx = Math.max(fontPx, Math.ceil(text.length * fontPx * LABEL_CHAR_WIDTH + LABEL_PAD_X * 2));
    const heightPx = Math.ceil(lineHeightPx + LABEL_PAD_Y * 2);
    const anchorPx = worldToScreen(anchorXWorld, anchorYWorld, layout.viewport);
    const candidates = [];

    for (let step = 0; step <= LABEL_MAX_SHIFT_STEPS; step++) {
        const baselinePx = anchorPx.y + step * lineHeightPx;
        candidates.push({
            left: anchorPx.x - widthPx / 2,
            right: anchorPx.x + widthPx / 2,
            top: baselinePx - lineHeightPx + LABEL_PAD_Y,
            bottom: baselinePx + LABEL_PAD_Y,
            baselinePx,
        });
    }

    const initialOverlaps = intersectsAnyRect(candidates[0], layout.occupied);
    if (!initialOverlaps) {
        layout.occupied.push(candidates[0]);
        return { xWorld: anchorXWorld, yWorld: anchorYWorld };
    }

    for (let step = 1; step < candidates.length; step++) {
        const rect = candidates[step];
        if (intersectsAnyRect(rect, layout.occupied)) continue;
        layout.occupied.push(rect);
        return {
            xWorld: anchorXWorld,
            yWorld: screenToWorldPoint(anchorPx.x, rect.baselinePx, layout.viewport).y,
        };
    }

    if (selected) {
        layout.occupied.push(candidates[0]);
        return { xWorld: anchorXWorld, yWorld: anchorYWorld };
    }

    return null;
}

function getPanVisualWorldOffset(dx, dy) {
    if (!svg || !drag?.svg0) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return { x: 0, y: 0 };
    return {
        x: (dx / rect.width) * drag.svg0.w,
        y: (dy / rect.height) * drag.svg0.h,
    };
}

function setPanVisualOffset(dx, dy) {
    const active = dx !== 0 || dy !== 0;
    panCompositedMode = active;

    const { x, y } = active ? getPanVisualWorldOffset(dx, dy) : { x: 0, y: 0 };
    const transform = active ? `translate(${round(x)} ${round(y)})` : '';
    for (const layer of [gridLayer, locationsLayer, pinsLayer, labelsLayer]) {
        if (!layer) continue;
        if (transform) layer.setAttribute('transform', transform);
        else layer.removeAttribute('transform');
    }
}

function publishCompositedPanProfile(dx, dy) {
    const frameStart = performance.now();
    const nextView = getDragPanView(dx, dy);
    const viewportWidth = svg?.clientWidth || 0;
    const viewportHeight = svg?.clientHeight || 0;
    const lastCounts = window.__worldSimMapPerf?.lastFrame?.counts || {};
    const lastRequested = window.__worldSimMapPerf?.lastFrame?.requested;
    const lastRendered = window.__worldSimMapPerf?.lastFrame?.rendered;
    const offsetWorld = getPanVisualWorldOffset(dx, dy);
    const scale = nextView && viewportWidth ? nextView.w / viewportWidth : 0;
    const profile = {
        frame: ++perfState.frame,
        map: true,
        list: false,
        requestCount: 1,
        queueDelayMs: 0,
        frameIntervalMs: perfState.lastTs ? frameStart - perfState.lastTs : 0,
        gridMs: 0,
        locationsMs: 0,
        pinsMs: 0,
        listMs: 0,
        totalMs: 0,
        otherMs: 0,
        viewport: viewportWidth && viewportHeight ? { width: viewportWidth, height: viewportHeight } : null,
        scale,
        view: nextView ? { x: round(nextView.x), y: round(nextView.y), w: round(nextView.w), h: round(nextView.h) } : null,
        dragType: 'pan',
        panCompositedMode: true,
        displayFlags: getDisplayFlags(true),
        requested: lastRequested || { viewBox: true, grid: true, locations: true, pins: true, list: false },
        rendered: lastRendered || { viewBox: true, grid: true, locations: true, pins: true, list: false },
        counts: {
            gridLines: lastCounts.gridLines || 0,
            axisLabels: lastCounts.axisLabels || 0,
            locations: lastCounts.locations || 0,
            totalLocations: lastCounts.totalLocations || 0,
            locationHandles: lastCounts.locationHandles || 0,
            pins: lastCounts.pins || 0,
            totalPins: lastCounts.totalPins || 0,
            domLocationNodes: locationsLayer?.childElementCount || 0,
            domPinNodes: pinsLayer?.childElementCount || 0,
            listItems: lastCounts.listItems || 0,
        },
        visualOffsetPx: { x: round(dx), y: round(dy) },
        visualOffsetWorld: { x: round(offsetWorld.x), y: round(offsetWorld.y) },
        ts: frameStart,
    };
    profile.totalMs = performance.now() - frameStart;
    profile.otherMs = profile.totalMs;
    publishFrameProfile(profile);
}

function screenToWorld(e) {
    return clientToWorld(e.clientX, e.clientY);
}

function clientToWorld(clientX, clientY) {
    const s = clientToSvg(clientX, clientY);
    return { x: s.x, y: -s.y };
}

function worldToScreen(worldX, worldY, viewport) {
    return {
        x: ((worldX - view.x) / view.w) * viewport.width,
        y: ((worldY - view.y) / view.h) * viewport.height,
    };
}

function screenToWorldPoint(screenX, screenY, viewport) {
    return {
        x: view.x + (screenX / viewport.width) * view.w,
        y: view.y + (screenY / viewport.height) * view.h,
    };
}

function isFiniteRect(loc) {
    return loc && Number.isFinite(loc.x) && Number.isFinite(loc.y) && Number.isFinite(loc.w) && Number.isFinite(loc.h);
}

function getCullingBounds(scale, padPx) {
    const pad = scale * getCullPadPx(padPx);
    return {
        left: view.x - pad,
        right: view.x + view.w + pad,
        top: view.y - pad,
        bottom: view.y + view.h + pad,
    };
}

function rectIntersectsBounds(x, y, w, h, bounds) {
    const top = -(y + h);
    const bottom = -y;
    return x <= bounds.right && x + w >= bounds.left && top <= bounds.bottom && bottom >= bounds.top;
}

function pointInBounds(x, ySvg, bounds) {
    // Pins are culled after being converted into SVG-space coordinates, so do not
    // invert Y here again or pins will disappear in the wrong half of the map.
    return x >= bounds.left && x <= bounds.right && ySvg >= bounds.top && ySvg <= bounds.bottom;
}

function intersectsAnyRect(rect, occupied) {
    return occupied.some((other) => rectsOverlap(rect, other));
}

function rectsOverlap(a, b) {
    return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function countVisibleLocations(bounds) {
    let count = 0;
    for (const loc of Object.values(getLocations().locations || {})) {
        if (!isFiniteRect(loc)) continue;
        if (rectIntersectsBounds(loc.x, loc.y, loc.w, loc.h, bounds)) count++;
    }
    return count;
}

function countVisiblePins(bounds) {
    const roster = getRoster();
    const state = getState();
    let idx = 0;
    let count = 0;

    for (const char of Object.values(roster.characters || {})) {
        if (!char.included) continue;
        const strings = state.characters?.[char.id] || {};
        let displayX;
        let displayY;
        if (Number.isFinite(strings.x) && Number.isFinite(strings.y)) {
            displayX = strings.x;
            displayY = strings.y;
        } else {
            const cols = 5;
            displayX = ((idx % cols) - 2) * 2;
            displayY = Math.floor(idx / cols) * -2;
        }
        idx++;
        if (pointInBounds(displayX, -displayY, bounds)) count++;
    }
    return count;
}

function shouldPreferSimpleRendering() {
    const hasCoarsePointer = window.matchMedia?.('(pointer: coarse)').matches;
    const narrowViewport = Math.min(window.innerWidth || Infinity, window.innerHeight || Infinity) <= MOBILE_SIMPLE_RENDER_MAX_WIDTH;
    const touchHeavy = navigator.maxTouchPoints > 0;
    const lowMemory = Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory <= 4;
    const ua = navigator.userAgent || '';
    const androidFirefox = /Android/i.test(ua) && /Firefox/i.test(ua);
    return androidFirefox || ((hasCoarsePointer || touchHeavy) && (narrowViewport || lowMemory));
}

function niceStep(raw) {
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / pow;
    const step = n >= 5 ? 5 : n >= 2 ? 2 : 1;
    return step * pow;
}

function isLabelStep(value, labelStep, step) {
    const nearest = Math.round(value / labelStep) * labelStep;
    return Math.abs(value - nearest) < step * 0.25;
}

function round(n) {
    return Math.round(n * 100) / 100;
}

function snap(n) {
    return Math.round(n);
}

function clamp(n, lo, hi) {
    return Math.min(hi, Math.max(lo, n));
}

function getPinImageUrl(char) {
    const cached = pinImageUrlCache.get(char.id);
    if (cached?.avatar === char.avatar) return cached.url;

    const url = getThumbnailUrl('avatar', char.avatar);
    pinImageUrlCache.set(char.id, { avatar: char.avatar, url });
    return url;
}

function publishFrameProfile(profile) {
    const dt = perfState.lastTs ? Math.max(0.001, profile.ts - perfState.lastTs) : 0;
    perfState.lastTs = profile.ts;
    perfState.avgFrameMs = perfState.avgFrameMs ? blend(perfState.avgFrameMs, dt || profile.totalMs) : (dt || profile.totalMs);
    perfState.avgGridMs = perfState.avgGridMs ? blend(perfState.avgGridMs, profile.gridMs) : profile.gridMs;
    perfState.avgLocationsMs = perfState.avgLocationsMs ? blend(perfState.avgLocationsMs, profile.locationsMs) : profile.locationsMs;
    perfState.avgPinsMs = perfState.avgPinsMs ? blend(perfState.avgPinsMs, profile.pinsMs) : profile.pinsMs;
    perfState.avgListMs = perfState.avgListMs ? blend(perfState.avgListMs, profile.listMs) : profile.listMs;
    perfState.avgOtherMs = perfState.avgOtherMs ? blend(perfState.avgOtherMs, profile.otherMs) : profile.otherMs;
    perfState.avgTotalMs = perfState.avgTotalMs ? blend(perfState.avgTotalMs, profile.totalMs) : profile.totalMs;
    profile.fps = round(perfState.fps || 0);
    profile.averages = {
        frameIntervalMs: round(perfState.avgFrameMs),
        totalMs: round(perfState.avgTotalMs),
        gridMs: round(perfState.avgGridMs),
        locationsMs: round(perfState.avgLocationsMs),
        pinsMs: round(perfState.avgPinsMs),
        listMs: round(perfState.avgListMs),
        otherMs: round(perfState.avgOtherMs),
    };

    const perfStore = window.__worldSimMapPerf ??= { frames: [], lastFrame: null, slowFrames: [] };
    perfStore.lastFrame = profile;
    perfStore.frames.push(profile);
    if (perfStore.frames.length > PERF_LOG_LIMIT) perfStore.frames.shift();
    perfStore.slowFrames.push(profile);
    if (perfStore.slowFrames.length > PERF_LOG_LIMIT) perfStore.slowFrames.shift();
    queuePerfLog(profile);

    updatePerfHud();
}

function updatePerfHud() {
    if (!perfEl) return;
    perfEl.textContent = `FPS ${round(perfState.fps || 0)}`;
}

function startPerfHudLoop() {
    if (perfHudRaf) cancelAnimationFrame(perfHudRaf);

    const tick = (ts) => {
        if (!inited) return;

        if (!document.hidden && svg?.clientWidth && svg?.clientHeight) {
            if (!perfHudLastSampleTs) perfHudLastSampleTs = ts;
            perfHudSampleFrames++;

            const elapsed = ts - perfHudLastSampleTs;
            if (elapsed >= 250) {
                const instantFps = (perfHudSampleFrames * 1000) / elapsed;
                perfState.fps = perfState.fps ? blend(perfState.fps, instantFps) : instantFps;
                perfHudLastSampleTs = ts;
                perfHudSampleFrames = 0;
                updatePerfHud();
            }
        } else {
            perfHudLastSampleTs = ts;
            perfHudSampleFrames = 0;
        }

        perfHudRaf = requestAnimationFrame(tick);
    };

    perfHudLastSampleTs = 0;
    perfHudSampleFrames = 0;
    perfHudRaf = requestAnimationFrame(tick);
}

function onVisibilityChange() {
    if (!document.hidden) {
        startPerfHudLoop();
    }
}

function compactProfile(profile) {
    return {
        frame: profile.frame,
        fps: profile.fps,
        frameIntervalMs: round(profile.frameIntervalMs),
        queueDelayMs: round(profile.queueDelayMs),
        requestCount: profile.requestCount,
        totalMs: round(profile.totalMs),
        gridMs: round(profile.gridMs),
        locationsMs: round(profile.locationsMs),
        pinsMs: round(profile.pinsMs),
        listMs: round(profile.listMs),
        otherMs: round(profile.otherMs),
        map: profile.map,
        list: profile.list,
        dragType: profile.dragType,
        panCompositedMode: profile.panCompositedMode,
        displayFlags: profile.displayFlags,
        requested: profile.requested,
        rendered: profile.rendered,
        viewport: profile.viewport,
        view: profile.view,
        scale: round(profile.scale),
        counts: profile.counts,
        averages: profile.averages,
        visualOffsetPx: profile.visualOffsetPx,
        visualOffsetWorld: profile.visualOffsetWorld,
    };
}

function queuePerfLog(profile) {
    if (window.__worldSimMapPerfLogging !== true) return;
    perfLogBuffer.push(compactProfile(profile));
    if (perfLogBuffer.length >= PERF_LOG_BATCH_SIZE) {
        flushPerfLogBuffer();
        return;
    }

    if (perfLogTimer !== null) return;
    perfLogTimer = setTimeout(() => {
        perfLogTimer = null;
        flushPerfLogBuffer();
    }, PERF_LOG_FLUSH_MS);
}

function flushPerfLogBuffer() {
    if (!perfLogBuffer.length) return;
    const batch = perfLogBuffer;
    perfLogBuffer = [];
    console.debug('[World Sim Map] frames', batch);
}

function blend(prev, next) {
    return prev + (next - prev) * PERF_SMOOTHING;
}

function queueSave() {
    if (saveQueued) return;
    saveQueued = true;
    setTimeout(() => { saveQueued = false; saveWorldSimState().catch(console.error); }, 250);
}
