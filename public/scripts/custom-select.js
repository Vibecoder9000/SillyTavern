/* Lightweight custom select widget that mirrors an existing <select>
   Keeps the original select in the DOM (hidden) so existing code
   that uses #model_custom_select still works. The widget is searchable
   and constrains dropdown width to avoid spanning the whole page.
*/
(function () {
    'use strict';

    function buildCustomSelect(selectEl) {
        if (!selectEl) return;

        // don't build twice
        if (selectEl.dataset.customized === '1') return;
        selectEl.dataset.customized = '1';

        // Create container
        const container = document.createElement('div');
        container.className = 'custom-select-container';
        container.style.position = 'relative';

        // Create display / search input
        const display = document.createElement('input');
        display.type = 'text';
        display.className = 'custom-select-display text_pole';
        display.placeholder = selectEl.getAttribute('data-placeholder') || '';
        display.setAttribute('aria-haspopup', 'listbox');
        display.setAttribute('aria-expanded', 'false');

        // Dropdown list (rendered as a portal to document.body to avoid
        // ancestor overflow/transform clipping issues)
        const dropdown = document.createElement('ul');
        dropdown.className = 'custom-select-dropdown';
        dropdown.setAttribute('role', 'listbox');
        dropdown.tabIndex = -1;
        // Append to body so it's not clipped by parent stacking/overflow
        document.body.appendChild(dropdown);

        // Build items from select options
        function rebuildItems(filter) {
            dropdown.innerHTML = '';
            const options = Array.from(selectEl.options);
            options.forEach(function (opt, idx) {
                const text = opt.textContent || opt.value || '';
                if (filter && !text.toLowerCase().includes(filter.toLowerCase())) return;
                const li = document.createElement('li');
                li.className = 'custom-select-item';
                li.setAttribute('data-value', opt.value);
                li.setAttribute('role', 'option');
                li.textContent = text;
                if (opt.disabled) li.classList.add('disabled');
                if (opt.selected) li.classList.add('selected');
                li.addEventListener('click', function (e) {
                    e.stopPropagation();
                    selectValue(opt.value, text);
                    closeDropdown();
                });
                dropdown.appendChild(li);
            });
        }

        function positionDropdown() {
            const rect = container.getBoundingClientRect();
            // prefer dropdown width equal to container width but clamp to max
            dropdown.style.minWidth = Math.max(rect.width, 256) + 'px';
            dropdown.style.left = rect.left + window.scrollX + 'px';
            dropdown.style.top = rect.bottom + window.scrollY + 6 + 'px';
            // make sure it doesn't overflow right edge
            const ddRect = dropdown.getBoundingClientRect();
            const overflowRight = ddRect.right - (window.innerWidth);
            if (overflowRight > 0) {
                dropdown.style.left = Math.max(8, rect.left + window.scrollX - overflowRight - 8) + 'px';
            }
        }

        function openDropdown() {
            positionDropdown();
            dropdown.classList.add('open');
            display.setAttribute('aria-expanded', 'true');
            // reposition on scroll/resize while open
            window.addEventListener('scroll', positionDropdown, true);
            window.addEventListener('resize', positionDropdown);
        }

        function closeDropdown() {
            dropdown.classList.remove('open');
            display.setAttribute('aria-expanded', 'false');
            window.removeEventListener('scroll', positionDropdown, true);
            window.removeEventListener('resize', positionDropdown);
        }

        function selectValue(value, text) {
            // set native select and trigger change
            selectEl.value = value;
            // reflect display
            display.value = text;
            // trigger change event for existing handlers
            const ev = new Event('change', { bubbles: true });
            selectEl.dispatchEvent(ev);
            // also trigger jQuery change if present
            // trigger jQuery change if present (use globalThis to avoid type warnings)
            try {
                const jq = window['jQuery'];
                if (typeof jq === 'function') jq(selectEl).trigger('change');
            } catch {
                void 0;
            }
            // mark selected in list
            const items = dropdown.querySelectorAll('.custom-select-item');
            items.forEach(function (it) { it.classList.toggle('selected', it.getAttribute('data-value') === value); });
        }

        // keep display in sync when native select changes externally
        selectEl.addEventListener('change', function () {
            const opt = selectEl.selectedOptions[0];
            if (opt) display.value = opt.textContent || opt.value || '';
        });

        // search
        display.addEventListener('input', function () {
            rebuildItems(display.value);
            openDropdown();
        });

        display.addEventListener('focus', function () {
            rebuildItems('');
            openDropdown();
        });

        display.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                const first = dropdown.querySelector('.custom-select-item:not(.disabled)');
                if (first && first instanceof HTMLElement) first.focus();
            } else if (e.key === 'Escape') {
                closeDropdown();
                display.blur();
            }
        });

        // close when clicking outside
        document.addEventListener('click', function (e) {
            // consider clicks inside container OR the portal dropdown as inside
            const t = e.target;
            if (!(t instanceof Node)) return;
            if (!container.contains(t) && !dropdown.contains(t)) closeDropdown();
        });

        // assemble
        // place elements: native select moved into container but dropdown stays on body
        selectEl.style.display = 'none';
        selectEl.parentNode.insertBefore(container, selectEl);
        container.appendChild(display);
        container.appendChild(selectEl);

        // initial items and value
        rebuildItems('');
        const initial = selectEl.selectedOptions[0];
        if (initial) display.value = initial.textContent || initial.value || '';

    // if the page changes the layout significantly, ensure dropdown is repositioned
    // when the user opens it — positionDropdown is called inside openDropdown
    }

    // on DOM ready, attach to #model_custom_select
    function init() {
        const sel = document.getElementById('model_custom_select');
        if (sel) buildCustomSelect(sel);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
