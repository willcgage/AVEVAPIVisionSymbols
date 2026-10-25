/* ============================================================================
 * pvxNavPanel — configurable navigation / control button bar
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector (see the definition). This symbol has no data sources at all; it is a *control*,
 * not a visualization. Operators use it to do the three things PI Vision
 * otherwise buries in menus: jump to another display, swap the asset context,
 * and change the time range.
 *
 * Everything is driven through the PI Vision URL contract (PVX.nav), which is
 * stable across releases, rather than through private Angular services which
 * are not.
 *
 * Implementation notes that matter:
 *   - Buttons are real <button> elements built with document.createElement.
 *     Real buttons give us keyboard focus, Enter/Space activation and
 *     aria-pressed for free; a pile of styled <div>s would not.
 *   - ONE delegated click listener lives on the host, not one per button, so a
 *     50-button panel still costs a single listener and teardown is trivial.
 *   - The DOM is rebuilt only when the Items text or the Mode changes. Colour,
 *     layout, size and active-state changes are applied to the existing nodes,
 *     so dragging a colour picker in the config pane does not thrash the DOM
 *     (and does not blow away an in-flight "Confirm?" state).
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxNavPanel',
        displayName: 'PVX Navigation Panel',

        // One data source, which this symbol ignores: everything it shows comes
        // from its config pane. PI Vision keeps DatasourceBehaviors.None symbols
        // out of the symbol selector altogether (its guide calls them "static
        // symbols"), so declared that way this could never be placed on a
        // display. Pick it and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Navigation Panel',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                // The cheapest query PI Vision has, for a value nothing reads.
                DataShape: 'Value',
                Height: 44,
                Width: 380,

                // What a click does.
                Mode: 'time',              // display | asset | time | custom
                Items: '8 hours | *-8h | *\n' +
                       '24 hours | *-24h | *\n' +
                       '7 days | *-7d | *\n' +
                       '30 days | *-30d | *',

                // Arrangement
                Layout: 'row',             // row | column | wrap | grid
                GridColumns: 3,
                FullWidth: true,
                ButtonGap: 6,

                // Appearance
                ButtonStyle: 'filled',     // filled | outline | ghost | tab
                ButtonSize: 'medium',      // small | medium | large
                ButtonColor: '#3b82c4',
                ActiveColor: '',           // blank => darker shade of ButtonColor
                ButtonRadius: 4,

                // Behaviour
                ShowActiveState: true,
                OpenInNewTab: false,
                KeepAsset: true,
                KeepTime: true,
                ConfirmNavigation: false,
                ConfirmText: 'Leave this display?',

                // Chrome
                ShowTitle: false,
                Title: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Fields the template binds to.
        scope.pvx = {
            title: '',
            surface: 'transparent'
        };

        /* ---------------------------------------------------------------- *
         * instance state
         * ---------------------------------------------------------------- */
        var buttons = [];             // [{el, labelEl, item, active, confirming}]
        var builtSignature = null;    // Mode + Items the current DOM was built from
        var boundHost = null;         // host the delegated listeners are attached to
        var pendingIndex = -1;        // index of the button awaiting confirmation
        var pendingTimer = null;

        // Long enough to read "Confirm?" and act, short enough that a stray
        // click never leaves a button stuck in a scary state.
        var CONFIRM_MS = 4000;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-nav-body',
            render: render,
            onDestroy: teardown
        });

        /* ================================================================ *
         * Items grammar
         * ================================================================ *
         * One button per line:
         *
         *     Label | target | extra
         *
         * Blank lines and lines beginning with '#' are comments. Everything is
         * trimmed. Only the first two pipes are structural, so `extra` may
         * itself contain pipes (harmless, but keeps the parser predictable).
         */

        function trim(s) {
            return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, '');
        }

        /** Parse one line -> {label, target, extra, raw}, or null if unusable. */
        function parseItem(line) {
            var s = trim(line);
            if (!s || s.charAt(0) === '#') { return null; }

            var label = s, target = '', extra = '';
            var first = s.indexOf('|');
            if (first !== -1) {
                label = trim(s.slice(0, first));
                var rest = s.slice(first + 1);
                var second = rest.indexOf('|');
                if (second === -1) {
                    target = trim(rest);
                } else {
                    target = trim(rest.slice(0, second));
                    extra = trim(rest.slice(second + 1));
                }
            }
            if (!label) { return null; }   // a button with no text is not a button
            return { label: label, target: target, extra: extra, raw: s };
        }

        /**
         * Is this item actionable in the current mode? In every mode but
         * 'custom' the target carries the whole payload, so a missing target is
         * a dead button and we drop it rather than render something inert.
         */
        function itemUsable(item, mode) {
            if (!item) { return false; }
            if (mode === 'custom') { return !!(item.target || item.extra); }
            return !!item.target;
        }

        function parseItems(text, mode) {
            var out = [];
            if (!text) { return out; }
            var lines = String(text).split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                var it = parseItem(lines[i]);
                if (itemUsable(it, mode)) { out.push(it); }
            }
            return out;
        }

        /** "asset=...;start=...;end=..." -> {asset:..., start:..., end:...} */
        function parsePairs(s) {
            var out = {};
            if (!s) { return out; }
            var chunks = String(s).split(';');
            for (var i = 0; i < chunks.length; i++) {
                var c = trim(chunks[i]);
                if (!c) { continue; }
                var eq = c.indexOf('=');
                if (eq === -1) { continue; }
                var k = trim(c.slice(0, eq)).toLowerCase();
                if (!k) { continue; }
                out[k] = trim(c.slice(eq + 1));
            }
            return out;
        }

        /* ================================================================ *
         * target resolution
         * ================================================================ */

        /** Build the URL a click on this item should navigate to. */
        function targetUrl(item, cfg) {
            var mode = cfg.Mode || 'display';
            var opts = {
                keepAsset: cfg.KeepAsset !== false,
                keepTime: cfg.KeepTime !== false
            };

            if (mode === 'asset') {
                opts.asset = item.target;
            } else if (mode === 'time') {
                opts.start = item.target;
                opts.end = item.extra || '*';        // '*' = now, the usual intent
            } else if (mode === 'custom') {
                if (item.target) { opts.display = item.target; }   // blank => stay put
                var p = parsePairs(item.extra);
                if (p.asset !== undefined) { opts.asset = p.asset; }
                if (p.start !== undefined) { opts.start = p.start; }
                if (p.end !== undefined) { opts.end = p.end; }
                if (p.mode !== undefined) { opts.mode = p.mode; }
            } else {
                opts.display = item.target;
                if (item.extra) { opts.asset = item.extra; }
            }

            // PVX.nav.url copies the current asset/time first (subject to
            // keepAsset/keepTime) and only then applies these overrides, so an
            // explicit value always wins over the inherited one.
            return PVX.nav.url(opts);
        }

        /** Short human description used as the button tooltip. */
        function describe(item, cfg) {
            var mode = cfg.Mode || 'display';
            if (mode === 'asset') { return 'Asset: ' + item.target; }
            if (mode === 'time') { return 'Time: ' + item.target + ' to ' + (item.extra || '*'); }
            if (mode === 'custom') {
                return (item.target ? 'Display ' + item.target + '  ' : '') + (item.extra || '');
            }
            return 'Display ' + item.target + (item.extra ? '  (asset ' + item.extra + ')' : '');
        }

        /* ================================================================ *
         * active-state detection
         * ================================================================ *
         * Deliberately tolerant. Operators paste display URLs, AF paths copied
         * out of PI System Explorer, and hand-typed ids; an exact string
         * comparison would leave the highlight permanently off.
         */

        /**
         * Reduce anything that identifies a display to a comparable key.
         * Accepts "1234", "1234/Boiler-Overview", "/Displays/1234/slug",
         * "https://host/PIVision/#/Displays/1234/slug?asset=..." — all collapse
         * to "1234". The slug is presentation only and PI Vision regenerates it
         * whenever the display is renamed, so it must not affect matching.
         */
        function displayKey(s) {
            if (!s) { return ''; }
            var v = trim(s);
            var h = v.indexOf('#');
            if (h !== -1) { v = v.slice(h + 1); }          // drop scheme/host
            var q = v.indexOf('?');
            if (q !== -1) { v = v.slice(0, q); }           // drop query string

            var m = /\/?displays\//i.exec(v);
            if (m) {
                v = v.slice(m.index + m[0].length);
                return v.split('/')[0].toLowerCase();      // the numeric id
            }
            // Some other route (e.g. "/Search") — compare the whole path.
            if (v.charAt(0) === '/') { return v.toLowerCase().replace(/\/+$/, ''); }
            return v.split('/')[0].toLowerCase();          // bare id or id/slug
        }

        /**
         * AF element paths are case-insensitive and users routinely leave a
         * trailing separator on a path copied from PI System Explorer.
         */
        function assetKey(s) {
            if (!s) { return ''; }
            return trim(s).replace(/[\\\/]+$/, '').toLowerCase();
        }

        /** PI time strings differ only by whitespace/case surprisingly often. */
        function timeKey(s) {
            return String(s === null || s === undefined ? '' : s)
                .replace(/\s+/g, '').toLowerCase();
        }

        function isActive(item, cfg) {
            var mode = cfg.Mode || 'display';
            var cur = PVX.nav.parseHash();

            if (mode === 'asset') {
                return !!item.target && assetKey(item.target) === assetKey(PVX.nav.currentAsset());
            }
            if (mode === 'time') {
                return timeKey(cur.params.starttime) === timeKey(item.target) &&
                       timeKey(cur.params.endtime || '*') === timeKey(item.extra || '*');
            }
            if (mode === 'custom') {
                // Every dimension the item actually specifies must match. An item
                // that specifies nothing can never be "current".
                var p = parsePairs(item.extra);
                var checked = false;
                if (item.target) {
                    if (displayKey(item.target) !== displayKey(cur.path)) { return false; }
                    checked = true;
                }
                if (p.asset !== undefined) {
                    if (assetKey(p.asset) !== assetKey(PVX.nav.currentAsset())) { return false; }
                    checked = true;
                }
                if (p.start !== undefined) {
                    if (timeKey(p.start) !== timeKey(cur.params.starttime)) { return false; }
                    checked = true;
                }
                if (p.end !== undefined) {
                    if (timeKey(p.end) !== timeKey(cur.params.endtime)) { return false; }
                    checked = true;
                }
                return checked;
            }
            // 'display'
            return !!item.target && displayKey(item.target) === displayKey(cur.path);
        }

        /* ================================================================ *
         * edit-mode guard
         * ================================================================ *
         * In the PI Vision display *editor*, clicking a symbol is how the
         * designer selects it. Navigating away at that moment would discard the
         * display they are building — actively hostile. So when we can detect
         * edit mode we do nothing at all and let the click fall through to PI
         * Vision's own selection handling.
         *
         * The flag has lived in different places across releases, so probe both
         * known locations defensively. If neither exists we assume runtime;
         * a false negative only costs an unwanted navigation in the editor,
         * whereas a false positive would make the symbol dead at runtime.
         */
        function isEditMode() {
            try {
                if (scope && scope.runtimeData && scope.runtimeData.isEditMode) { return true; }
            } catch (e) { /* scope shape differs by release */ }
            try {
                if (scope && scope.$root && scope.$root.isEditMode) { return true; }
            } catch (e2) { /* ignore */ }
            return false;
        }

        /* ================================================================ *
         * two-step confirmation
         * ================================================================ *
         * window.confirm() is banned here: a native modal blocks the browser's
         * event loop, which stalls PI Vision's data polling and, on kiosk
         * displays with no keyboard, can wedge the screen entirely. The
         * first click instead turns the button itself into the confirmation.
         */

        function clearConfirm() {
            if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
            if (pendingIndex >= 0 && buttons[pendingIndex]) {
                var rec = buttons[pendingIndex];
                rec.confirming = false;
                rec.labelEl.textContent = rec.item.label;
                syncClass(rec);
            }
            pendingIndex = -1;
        }

        function beginConfirm(index, cfg) {
            clearConfirm();
            var rec = buttons[index];
            if (!rec) { return; }
            pendingIndex = index;
            rec.confirming = true;
            rec.labelEl.textContent = 'Confirm?';
            rec.el.title = cfg.ConfirmText || 'Leave this display?';
            syncClass(rec);
            pendingTimer = setTimeout(function () {
                pendingTimer = null;
                clearConfirm();
            }, CONFIRM_MS);
        }

        /* ================================================================ *
         * event handling — one delegated listener for the whole panel
         * ================================================================ */

        /** Walk up from the event target to the button element we own. */
        function buttonFromEvent(ev) {
            var el = ev.target;
            var guard = 0;
            while (el && el !== boundHost && guard < 12) {
                if (el.getAttribute && el.getAttribute('data-pvx-index') !== null) { return el; }
                el = el.parentNode;
                guard += 1;
            }
            return null;
        }

        function onClick(ev) {
            var el = buttonFromEvent(ev);
            if (!el) { return; }

            // Do nothing in the editor — see isEditMode(). We deliberately do
            // NOT stopPropagation so PI Vision still selects the symbol.
            if (isEditMode()) { return; }

            var index = parseInt(el.getAttribute('data-pvx-index'), 10);
            var rec = buttons[index];
            if (!rec) { return; }

            var cfg = ctx.config || {};

            if (cfg.ConfirmNavigation) {
                if (pendingIndex === index) {
                    clearConfirm();                 // second click within the window
                } else {
                    beginConfirm(index, cfg);       // first click, or a different button
                    return;
                }
            } else if (pendingIndex !== -1) {
                clearConfirm();
            }

            var url = targetUrl(rec.item, cfg);
            if (url) { PVX.nav.go(url, !!cfg.OpenInNewTab); }
        }

        // 'blur' does not bubble, so capture it. Losing focus means the operator
        // moved on; a stale "Confirm?" would be a trap for the next person.
        function onBlurCapture() {
            if (pendingIndex !== -1) { clearConfirm(); }
        }

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            if (!host || !host.addEventListener) { return; }
            host.addEventListener('click', onClick, false);
            host.addEventListener('blur', onBlurCapture, true);
            boundHost = host;
        }

        function unbindHost() {
            if (boundHost && boundHost.removeEventListener) {
                boundHost.removeEventListener('click', onClick, false);
                boundHost.removeEventListener('blur', onBlurCapture, true);
            }
            boundHost = null;
        }

        function teardown() {
            if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
            pendingIndex = -1;
            unbindHost();
            buttons = [];
            builtSignature = null;
        }

        /* ================================================================ *
         * DOM construction
         * ================================================================ */

        function syncClass(rec) {
            var cls = 'pvx-btn pvx-nav-btn';
            if (rec.active) { cls += ' pvx-nav-btn-active'; }
            if (rec.confirming) { cls += ' pvx-nav-confirm'; }
            rec.el.className = cls;
        }

        function clearNode(n) {
            while (n && n.firstChild) { n.removeChild(n.firstChild); }
        }

        /** The only thing that forces a DOM rebuild. */
        function signature(cfg) {
            return (cfg.Mode || 'display') + '\u0000' + (cfg.Items || '');
        }

        function build(host, items, cfg) {
            clearConfirm();
            buttons = [];
            clearNode(host);

            if (!items.length) {
                // Empty state. Never throw, never render a blank box the author
                // cannot diagnose.
                var hint = document.createElement('div');
                hint.className = 'pvx-empty pvx-nav-hint';
                hint.textContent = 'Add one button per line in the format Label | target';
                host.appendChild(hint);
                return;
            }

            for (var i = 0; i < items.length; i++) {
                var item = items[i];

                var b = document.createElement('button');
                b.type = 'button';                       // never submit a form
                b.setAttribute('data-pvx-index', String(i));
                b.setAttribute('aria-pressed', 'false');
                b.title = describe(item, cfg);

                // textContent, not innerHTML: labels are operator-authored text
                // and must never be interpreted as markup.
                var labelEl = document.createElement('span');
                labelEl.className = 'pvx-nav-label';
                labelEl.textContent = item.label;
                b.appendChild(labelEl);

                host.appendChild(b);
                buttons.push({ el: b, labelEl: labelEl, item: item, active: false, confirming: false });
                syncClass(buttons[i]);
            }
        }

        /* ================================================================ *
         * styling — applied every render, no DOM rebuild
         * ================================================================ */

        function applyVars(c, cfg, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }

            var base = cfg.ButtonColor || '#3b82c4';
            // A blank ActiveColor means "same button, pressed": mixing 32%
            // toward black keeps the hue and reads as depressed in both themes.
            var active = cfg.ActiveColor || PVX.color.mix(base, '#000000', 0.32);
            var confirm = PVX.color.status.warning;

            var set = function (k, v) { n.style.setProperty(k, v); };

            set('--pvx-surface', t.surface);
            set('--pvx-text', t.text);
            set('--pvx-muted', t.textMuted);
            set('--pvx-border', t.border);

            set('--pvx-nav-color', base);
            set('--pvx-nav-active', active);
            set('--pvx-nav-on-color', PVX.color.readable(base));
            set('--pvx-nav-on-active', PVX.color.readable(active));
            set('--pvx-nav-confirm', confirm);
            set('--pvx-nav-on-confirm', PVX.color.readable(confirm));

            // Translucent tints for ghost/outline hover, derived from the button
            // colour so they work on light and dark surfaces alike.
            set('--pvx-nav-tint', PVX.color.rgba(base, 0.14));
            set('--pvx-nav-tint-strong', PVX.color.rgba(base, 0.26));
            set('--pvx-nav-focus', PVX.color.rgba(base, 0.55));

            var gap = PVX.util.num(cfg.ButtonGap);
            set('--pvx-nav-gap', PVX.util.clamp(gap === null ? 6 : gap, 0, 40) + 'px');

            var radius = PVX.util.num(cfg.ButtonRadius);
            set('--pvx-nav-radius', PVX.util.clamp(radius === null ? 4 : radius, 0, 40) + 'px');

            var cols = parseInt(cfg.GridColumns, 10);
            set('--pvx-nav-cols', String(PVX.util.clamp(isFinite(cols) ? cols : 3, 1, 12)));
        }

        var LAYOUTS = { row: 1, column: 1, wrap: 1, grid: 1 };
        var STYLES = { filled: 1, outline: 1, ghost: 1, tab: 1 };
        var SIZES = { small: 1, medium: 1, large: 1 };

        function hostClass(cfg) {
            var layout = LAYOUTS[cfg.Layout] ? cfg.Layout : 'row';
            var style = STYLES[cfg.ButtonStyle] ? cfg.ButtonStyle : 'filled';
            var size = SIZES[cfg.ButtonSize] ? cfg.ButtonSize : 'medium';
            return 'pvx-nav-body' +
                ' pvx-nav-lay-' + layout +
                ' pvx-nav-style-' + style +
                ' pvx-nav-size-' + size +
                (cfg.FullWidth === false ? '' : ' pvx-nav-full');
        }

        function updateActive(cfg) {
            var show = cfg.ShowActiveState !== false;
            for (var i = 0; i < buttons.length; i++) {
                var rec = buttons[i];
                var on = false;
                if (show) {
                    // Never let a malformed item break the whole panel.
                    try { on = isActive(rec.item, cfg); } catch (e) { on = false; }
                }
                if (rec.active !== on) {
                    rec.active = on;
                    syncClass(rec);
                }
                rec.el.setAttribute('aria-pressed', on ? 'true' : 'false');
            }
        }

        /* ================================================================ *
         * render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;

            scope.pvx.title = cfg.ShowTitle ? (cfg.Title || '') : '';
            scope.pvx.surface = cfg.Transparent ? 'transparent' : t.surface;

            if (host) {
                bindHost(host);

                var items = parseItems(cfg.Items, cfg.Mode || 'display');
                var sig = signature(cfg);
                if (sig !== builtSignature) {
                    build(host, items, cfg);
                    builtSignature = sig;
                }

                host.className = hostClass(cfg);
                applyVars(c, cfg, t);
                updateActive(cfg);
            }

            // The render runs inside requestAnimationFrame, outside Angular's
            // digest, and we just wrote scope.pvx fields the template binds to.
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
