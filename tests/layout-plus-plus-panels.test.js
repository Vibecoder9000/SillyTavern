import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const layoutCss = readFileSync(new URL('../public/css/layout-plus-plus.css', import.meta.url), 'utf8');
const appScript = readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
const powerUserScript = readFileSync(new URL('../public/scripts/power-user.js', import.meta.url), 'utf8');

describe('Layout++ resizable side panels', () => {
    test('provides accessible separators for both side-mounted panels', () => {
        for (const id of ['layout-plus-plus-settings-resize-handle', 'layout-plus-plus-character-resize-handle']) {
            const handle = indexHtml.slice(indexHtml.indexOf(`id="${id}"`), indexHtml.indexOf(`id="${id}"`) + 500);
            expect(handle).toContain('role="separator"');
            expect(handle).toContain('aria-orientation="vertical"');
            expect(handle).toContain('aria-valuemin="280"');
            expect(handle).toContain('aria-valuemax="1600"');
            expect(handle).toContain('tabindex="0"');
        }
    });

    test('keeps independent settings, character detail, and character grid widths', () => {
        expect(powerUserScript).toContain('LAYOUT_PLUS_PLUS_PANEL_MIN_WIDTH = 280');
        expect(powerUserScript).toContain('LAYOUT_PLUS_PLUS_PANEL_MAX_WIDTH = 1600');
        expect(powerUserScript).toMatch(/settings:\s*360/);
        expect(powerUserScript).toMatch(/characterDetail:\s*360/);
        expect(powerUserScript).toMatch(/characterGrid:\s*700/);
        expect(powerUserScript).toContain('Math.min(LAYOUT_PLUS_PLUS_PANEL_MAX_WIDTH, Math.max(LAYOUT_PLUS_PLUS_PANEL_MIN_WIDTH');
        expect(powerUserScript).toContain("panel?.dataset.menuType === 'characters'");
        expect(powerUserScript).toContain("? 'characterGrid'");
        expect(powerUserScript).toContain(": 'characterDetail'");
    });

    test('keeps the resize edge inside the viewport and exposes a reset control', () => {
        expect(powerUserScript).toContain('LAYOUT_PLUS_PLUS_PANEL_VIEWPORT_MARGIN = 24');
        expect(powerUserScript).toContain('viewportWidth - navBarWidth - LAYOUT_PLUS_PLUS_PANEL_VIEWPORT_MARGIN');
        expect(powerUserScript).toContain('Math.min(power_user.layout_plus_plus_panel_widths.settings, effectiveMaxWidth)');
        expect(powerUserScript).toContain('Math.min(getLayoutPlusPlusEffectivePanelMaxWidth()');
        expect(appScript).toContain('? getLayoutPlusPlusEffectivePanelMaxWidth()');
        expect(indexHtml).toContain('id="layout_plus_plus_panel_widths_reset"');
        expect(indexHtml).toContain('aria-label="Reset Layout++ panel widths"');
        expect(powerUserScript).toContain('function resetLayoutPlusPlusPanelWidths()');
        expect(powerUserScript).toContain("$('#layout_plus_plus_panel_widths_reset').on('click'");
        expect(powerUserScript).toContain('power_user.layout_plus_plus_panel_widths = { ...DEFAULT_LAYOUT_PLUS_PLUS_PANEL_WIDTHS }');
    });

    test('selects state-specific CSS widths and exposes handles only on desktop', () => {
        expect(layoutCss).toContain('--char-panel-width: var(--layout-plus-plus-character-grid-width)');
        expect(layoutCss).toContain('--char-panel-width: var(--layout-plus-plus-character-detail-width)');
        expect(layoutCss).toContain('--settings-panel-width: var(--layout-plus-plus-settings-panel-width)');
        expect(layoutCss).toContain('@media (pointer: fine)');
        expect(layoutCss).toContain('body.layout-plus-plus-desktop #left-nav-panel.openDrawer');
        expect(layoutCss).toContain('body.layout-plus-plus-desktop #right-nav-panel.openDrawer');
        expect(layoutCss).toContain('#left-nav-panel .layout-plus-plus-panel-resize-handle { left: -5px; }');
        expect(layoutCss).toContain('#right-nav-panel .layout-plus-plus-panel-resize-handle { right: -5px; }');
        expect(layoutCss).toContain('body.left-tab-layout-transitioning .layout-plus-plus-panel-resize-handle { pointer-events: none; }');
    });

    test('uses pointer capture, animation frames, directional resizing, and persistence', () => {
        const resizing = appScript.slice(
            appScript.indexOf('const LAYOUT_PLUS_PLUS_PANEL_KEYBOARD_STEP'),
            appScript.indexOf('function clearLeftTabDrawerState'),
        );
        expect(resizing).toContain("key: 'settings', direction: -1");
        expect(resizing).toContain('key: getLayoutPlusPlusCharacterWidthKey(), direction: 1');
        expect(resizing).toContain('requestAnimationFrame(applyPendingLayoutPlusPlusPanelResize)');
        expect(resizing).toContain('setPointerCapture(event.pointerId)');
        expect(resizing).toContain('finishLeftTabLayoutTransition()');
        expect(resizing).toContain('cancelActiveCharacterImageAnimation()');
        expect(resizing).toContain('setLayoutPlusPlusPanelWidth(layoutPlusPlusPanelResize.key');
        expect(resizing).toContain('saveSettingsDebounced()');
        expect(resizing).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End']");
    });

    test('commits final character geometry after asynchronous state changes', () => {
        const transition = appScript.slice(
            appScript.indexOf('function beginLeftTabLayoutTransition'),
            appScript.indexOf('function endLeftTabLayoutTransition'),
        );
        const menuState = appScript.slice(
            appScript.indexOf('export function setMenuType'),
            appScript.indexOf('export function setExternalAbortController'),
        );
        const gridToggle = appScript.slice(
            appScript.indexOf('function doCharListDisplaySwitch'),
            appScript.indexOf('export async function handleDeleteCharacter'),
        );
        expect(transition).toContain('deferMeasurement = false');
        expect(transition).toContain('pendingLeftTabLayoutTransition = { generation, measureFinalLayout }');
        expect(transition).toContain('function commitLeftTabLayoutTransition()');
        expect(appScript).toContain('{ includeCharacterPanel: true, deferMeasurement: true }');
        expect(menuState).toContain('applyLayoutPlusPlusPanelWidths()');
        expect(menuState).toContain('commitLeftTabLayoutTransition()');
        expect(gridToggle).toContain('beginCharacterPanelLayoutTransition()');
        expect(gridToggle).toContain('commitLeftTabLayoutTransition()');
        expect(gridToggle).toContain('endLeftTabLayoutTransition(characterPanelLayoutTransition)');
    });
});
