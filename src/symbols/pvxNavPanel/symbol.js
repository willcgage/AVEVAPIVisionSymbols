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
                Mode: 'time',              // display | asset | time | custom | hierarchy
                // Where the buttons come from: Items below, or the text of an
                // AF attribute, so one menu kept in AF serves every display.
                ItemsFrom: 'config',       // config | af
                ItemsAttribute: '',
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

                // Hierarchy mode: buttons come from the current asset's
                // place in AF, not from Items.
                StartAsset: '',            // used when the URL names no asset
                LevelDisplays: '',         // "level | display" per line, "*" for any
                TopLevel: 1,               // shallowest level shown and reachable by Up
                ShowUp: true,
                ShowBreadcrumb: true,
                ShowSiblings: true,
                SiblingsSameTemplate: true,
                ShowChildren: false,
                MaxSiblings: 50,

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

        // Hierarchy mode. Up and the breadcrumb are path arithmetic on the
        // current asset; siblings and children need PI Web API, fetched once
        // per asset and kept until the asset changes.
        var hier = {
            sourceAsset: '',          // element of the placeholder data source
            fetchedFor: null,         // key of the asset + options last fetched
            siblings: null,           // [{name, path, template}] or null
            children: null,
            notes: [],                // why a group is missing or short
            gen: 0,                   // bumps on every fetch; stale answers drop
            lastAsset: null,
            timer: null,
            listener: null
        };
        var HIER_POLL_MS = 1000;

        // Long enough to read "Confirm?" and act, short enough that a stray
        // click never leaves a button stuck in a scary state.
        var CONFIRM_MS = 4000;

        // The data source's current value, for targets written as {value}.
        var sourceValue = '';

        // ItemsFrom 'af': the menu text read from an AF attribute.
        var menu = { path: '', text: null, error: '', at: 0, gen: 0, timer: null };
        var MENU_MS = 60000;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-nav-body',
            render: render,
            // The data source is otherwise ignored, but in hierarchy mode its
            // element is where the panel starts when the URL names no asset.
            onData: function (d) {
                var one = PVX.data.single(d);
                var raw = one && one.raw !== null && one.raw !== undefined ? trim(one.raw) : '';
                if (raw !== sourceValue) {
                    sourceValue = raw;
                    // Tooltips name the resolved address; rebuild them.
                    builtSignature = null;
                    ctx.render();
                }
                var a = one ? PVX.nav.assetOf(one.path) : '';
                if (a !== hier.sourceAsset) {
                    hier.sourceAsset = a;
                    if ((ctx.config || {}).Mode === 'hierarchy') { ctx.render(); }
                }
            },
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
         *
         * The label may carry two extras, both optional and both kept out of
         * the pipe fields so every mode's targets read as they always have:
         *
         *     [home] Overview -- Plant overview, all units | 101
         *
         * `[name]` at the start draws one of the built-in icons (a label of
         * only an icon makes an icon button), and the text after ` -- ` is the
         * tooltip. A target of {value} is replaced at click time by the data
         * source's current value, so an AF attribute can hold the address.
         */

        /*
         * Built-in icons, drawn here as single stroked paths on a 24-unit grid
         * so nothing third-party ships and they take the button's text colour.
         */
        var ICONS = {
            home: 'M3 11 L12 3 L21 11 M5 9.5 V21 H10 V15 H14 V21 H19 V9.5',
            back: 'M15 5 L8 12 L15 19',
            forward: 'M9 5 L16 12 L9 19',
            up: 'M5 15 L12 8 L19 15',
            trend: 'M3 17 L9 11 L13 15 L21 7 M15 7 H21 V13',
            alarm: 'M12 3 L22 20 H2 Z M12 10 V14 M12 17 V17.5',
            table: 'M3 5 H21 V19 H3 Z M3 10 H21 M3 15 H21 M9 5 V19',
            gauge: 'M4 17 A8 8 0 1 1 20 17 M12 13 L16 8',
            clock: 'M12 3 A9 9 0 1 1 11.99 3 M12 7 V12 L15.5 14',
            map: 'M3 6 L9 4 L15 6 L21 4 V18 L15 20 L9 18 L3 20 Z M9 4 V18 M15 6 V20',
            list: 'M8 6 H21 M8 12 H21 M8 18 H21 M3.5 6 H4.5 M3.5 12 H4.5 M3.5 18 H4.5',
            settings: 'M12 9 A3 3 0 1 1 11.99 9 M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.9 4.9 L7 7 M17 17 L19.1 19.1 M4.9 19.1 L7 17 M17 7 L19.1 4.9',
            info: 'M12 3 A9 9 0 1 1 11.99 3 M12 11 V17 M12 7.5 V8',
            report: 'M6 3 H15 L19 7 V21 H6 Z M15 3 V7 H19 M9 12 H16 M9 16 H16',
            power: 'M12 3 V12 M7 6 A8 8 0 1 0 17 6',
            star: 'M12 3 L14.6 9 L21 9.5 L16 13.8 L17.6 20 L12 16.6 L6.4 20 L8 13.8 L3 9.5 L9.4 9 Z'
        };

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
            var tip = '', icon = '';
            var dash = label.indexOf(' -- ');
            if (dash !== -1) {
                tip = trim(label.slice(dash + 4));
                label = trim(label.slice(0, dash));
            }
            var im = /^\[([a-z]+)\]\s*/.exec(label);
            // An unknown name stays in the label as typed: it is visibly
            // wrong there, where a dropped word would just be missing.
            if (im && ICONS[im[1]]) {
                icon = im[1];
                label = trim(label.slice(im[0].length));
            }
            if (!label && !icon) { return null; }   // a button with nothing on it is not a button
            return { label: label, icon: icon, tip: tip, target: target, extra: extra, raw: s };
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

        /** {value} in a target or extra, replaced by the data source's value. */
        function withValue(str) {
            return String(str || '').replace(/\{value\}/gi, sourceValue);
        }

        function needsValue(item) {
            return /\{value\}/i.test(item.target + ' ' + item.extra);
        }

        /** Build the URL a click on this item should navigate to. */
        function targetUrl(item, cfg) {
            if (needsValue(item)) {
                if (!sourceValue) { return ''; }
                item = { label: item.label, target: withValue(item.target), extra: withValue(item.extra) };
            }
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
            } else if (mode === 'hierarchy') {
                opts.asset = item.target;
                if (item.extra) { opts.display = item.extra; }      // blank => stay put
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
            if (item.tip) { return item.tip; }
            if (needsValue(item)) {
                if (!sourceValue) { return 'Waiting for the data source to supply the address'; }
                item = { target: withValue(item.target), extra: withValue(item.extra) };
            }
            if (mode === 'hierarchy') {
                return item.target + (item.extra ? '  (display ' + item.extra + ')' : '');
            }
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
            if (mode === 'hierarchy') {
                // Up names the parent, which is never where the display is.
                return item.kind !== 'up' && !!item.target &&
                       assetKey(item.target) === assetKey(hierAsset(cfg));
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
            // A leaked poller on a control-room kiosk runs for weeks.
            if (hier.timer !== null) { clearInterval(hier.timer); hier.timer = null; }
            if (menu.timer !== null) { clearInterval(menu.timer); menu.timer = null; }
            menu.gen += 1;
            if (hier.listener) {
                try { window.removeEventListener('hashchange', hier.listener, false); }
                catch (e) { /* ignore */ }
                hier.listener = null;
            }
            hier.gen += 1;
            pendingIndex = -1;
            unbindHost();
            buttons = [];
            builtSignature = null;
        }

        /* ================================================================ *
         * hierarchy mode
         * ================================================================ *
         * The build guide's navigation strip: Up to the parent, a breadcrumb
         * of the current asset's ancestors, and its siblings, all switching
         * the asset and, where a level has its own display, the display too.
         * Everything but siblings and children is read off the path itself,
         * so the strip works before PI Web API is configured and says what
         * it is missing rather than leaving the group out.
         */

        function intIn(v, lo, hi, dflt) {
            var n = parseInt(v, 10);
            return isFinite(n) ? PVX.util.clamp(n, lo, hi) : dflt;
        }

        /** URL asset first, then the configured start, then the data source's element. */
        function hierAsset(cfg) {
            return trim(PVX.nav.currentAsset()) || trim(cfg.StartAsset) || hier.sourceAsset;
        }

        /**
         * "2 | 1058" opens display 1058 for any level-2 element, "* | 1042"
         * for every level without a line of its own. Levels count from the
         * top of the AF database, 1 being its top-level elements, because
         * that is what stays fixed when a site adds a unit under an area.
         */
        function levelDisplays(text) {
            var map = {};
            var lines = String(text || '').split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                var it = parseItem(lines[i]);
                if (!it || !it.target) { continue; }
                if (it.label === '*') { map['*'] = it.target; continue; }
                var n = parseInt(it.label, 10);
                if (n > 0) { map[n] = it.target; }
            }
            return map;
        }

        function displayFor(map, level) {
            return map[level] || map['*'] || '';
        }

        function relativesKey(asset, cfg) {
            return assetKey(asset) + '\u0000' + (cfg.ShowSiblings !== false) + '\u0000' +
                (cfg.ShowChildren === true) + '\u0000' + intIn(cfg.MaxSiblings, 1, 500, 50);
        }

        function apiFailure(err, what) {
            var e = err && err.pvxError;
            return 'Could not list ' + what + ': ' +
                (e ? e.message + (e.check ? ' Check: ' + e.check + '.' : '') : String(err && err.message || err));
        }

        /** A 404 from a path lookup, said as the missing path rather than "check the WebID". */
        function notFoundAs(what) {
            return function (err) {
                if (err && err.pvxError && err.pvxError.code === 'not-found') {
                    throw { pvxError: { code: 'not-found', message: 'there is no AF ' + what + '.',
                        check: 'the asset in the URL, or Start asset in Format' } };
                }
                throw err;
            };
        }

        /** The collection endpoint holding an element's children. */
        function childrenBase(path) {
            var segs = PVX.nav.segments(path);
            if (!segs.elements.length) {
                // A database's elements are not under elements/{id}/elements.
                var db = segs.prefix.replace(/\\+$/, '');
                return PVX.api.get('assetdatabases?path=' + encodeURIComponent(db) + '&selectedFields=WebId')
                    ['catch'](notFoundAs('database at "' + db + '"'))
                    .then(function (r) {
                        if (!r || !r.WebId) { throw new Error('no AF database at ' + db); }
                        return 'assetdatabases/' + encodeURIComponent(r.WebId) + '/elements';
                    });
            }
            return PVX.api.get('elements?path=' + encodeURIComponent(path) + '&selectedFields=WebId')
                ['catch'](notFoundAs('element at "' + path + '"'))
                .then(function (r) {
                    if (!r || !r.WebId) { throw new Error('no AF element at ' + path); }
                    return 'elements/' + encodeURIComponent(r.WebId) + '/elements';
                });
        }

        function listChildren(path, max) {
            return childrenBase(path).then(function (base) {
                // One more than we draw, so "exactly max" and "cut off" differ.
                return PVX.api.get(base + '?selectedFields=Items.Name;Items.Path;Items.TemplateName' +
                    '&maxCount=' + (max + 1));
            }).then(function (res) {
                var raw = (res && res.Items) || [];
                var out = [];
                for (var i = 0; i < raw.length && i < max; i++) {
                    if (!raw[i] || !raw[i].Path) { continue; }
                    out.push({ name: raw[i].Name || raw[i].Path, path: raw[i].Path, template: raw[i].TemplateName || '' });
                }
                return { items: out, truncated: raw.length > max };
            });
        }

        /** Fetch siblings and children once per asset; renders again on arrival. */
        function ensureRelatives(cfg) {
            var asset = hierAsset(cfg);
            var key = relativesKey(asset, cfg);
            if (key === hier.fetchedFor) { return; }
            hier.fetchedFor = key;
            hier.siblings = null;
            hier.children = null;
            hier.notes = [];
            var gen = ++hier.gen;

            var wantSiblings = cfg.ShowSiblings !== false;
            var wantChildren = cfg.ShowChildren === true;
            if (!asset || !PVX.nav.segments(asset).prefix || (!wantSiblings && !wantChildren)) { return; }
            // With no baseUrl set, PVX.api first asks PI Vision's own server
            // for /piwebapi; ask again once it has its answer.
            if (PVX.api.discovering()) {
                hier.fetchedFor = null;
                PVX.api.discover().then(function () { if (gen === hier.gen) { ctx.render(); } });
                return;
            }
            if (!PVX.api.isConfigured()) {
                hier.notes.push({
                    label: (wantSiblings ? 'Siblings' : 'Children') + ' need PI Web API',
                    tip: PVX.api.unsetHint() + ', then confirm it with ext/piwebapi-check.html.'
                });
                return;
            }

            var max = intIn(cfg.MaxSiblings, 1, 500, 50);
            function settle(field, what, promise) {
                promise.then(function (r) {
                    if (gen !== hier.gen) { return; }
                    hier[field] = r.items;
                    if (r.truncated) {
                        hier.notes.push({ label: 'First ' + max + ' ' + what,
                            tip: 'There are more ' + what + ' than MaxSiblings (' + max + ') allows; raise it in Format to show them.' });
                    }
                    ctx.render();
                })['catch'](function (err) {
                    if (gen !== hier.gen) { return; }
                    hier[field] = [];
                    hier.notes.push({ label: 'No ' + what, tip: apiFailure(err, what) });
                    ctx.render();
                });
            }
            var parent = PVX.nav.parentOf(asset) || PVX.nav.segments(asset).prefix;
            if (wantSiblings) { settle('siblings', 'siblings', listChildren(parent, max)); }
            if (wantChildren) { settle('children', 'children', listChildren(asset, max)); }
        }

        function hierarchyItems(cfg) {
            var asset = hierAsset(cfg);
            var segs = PVX.nav.segments(asset);
            var depth = segs.elements.length;
            if (!asset || !segs.prefix || !depth) { return []; }

            var top = intIn(cfg.TopLevel, 1, depth, 1);
            var map = levelDisplays(cfg.LevelDisplays);
            var pathAt = function (d) { return segs.prefix + segs.elements.slice(0, d).join('\\'); };
            var groups = [];
            var i, g;

            if (cfg.ShowUp !== false) {
                var canUp = depth > top;
                groups.push([{
                    kind: 'up', label: '↑ Up',
                    target: canUp ? pathAt(depth - 1) : '',
                    extra: canUp ? displayFor(map, depth - 1) : '',
                    disabled: !canUp,
                    tip: canUp ? 'Up to ' + segs.elements[depth - 2] : 'Already at the top level shown'
                }]);
            }

            if (cfg.ShowBreadcrumb !== false) {
                g = [];
                for (i = top; i <= depth; i++) {
                    if (g.length) { g.push({ kind: 'sep', label: '›' }); }
                    g.push({ kind: 'crumb', label: segs.elements[i - 1], target: pathAt(i), extra: displayFor(map, i) });
                }
                groups.push(g);
            }

            function relatives(list, kind, level) {
                var mine = null, out = [];
                for (var j = 0; j < list.length; j++) {
                    if (assetKey(list[j].path) === assetKey(asset)) { mine = list[j]; }
                }
                // Same template keeps the strip on peers: the other compressors,
                // not the station's tanks and meters that share its parent.
                var tpl = kind === 'sibling' && cfg.SiblingsSameTemplate !== false && mine ? mine.template : '';
                for (j = 0; j < list.length; j++) {
                    if (tpl && list[j].template !== tpl) { continue; }
                    out.push({ kind: kind, label: list[j].name, target: list[j].path, extra: displayFor(map, level) });
                }
                return out;
            }
            if (cfg.ShowSiblings !== false && hier.siblings && hier.siblings.length) {
                groups.push(relatives(hier.siblings, 'sibling', depth));
            }
            if (cfg.ShowChildren === true && hier.children && hier.children.length) {
                groups.push(relatives(hier.children, 'child', depth + 1));
            }
            if (hier.notes.length) {
                g = [];
                for (i = 0; i < hier.notes.length; i++) {
                    g.push({ kind: 'note', label: hier.notes[i].label, tip: hier.notes[i].tip });
                }
                groups.push(g);
            }

            var out = [];
            for (i = 0; i < groups.length; i++) {
                if (!groups[i].length) { continue; }
                if (out.length) { out.push({ kind: 'div', label: '|' }); }
                out = out.concat(groups[i]);
            }
            return out;
        }

        function itemsKey(items) {
            var parts = [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                parts.push([it.kind || '', it.label, it.target || '', it.extra || '', it.disabled ? 1 : 0, it.tip || ''].join('\u0001'));
            }
            return parts.join('\u0002');
        }

        /**
         * Follow the display's asset. Polling as well as hashchange, as the
         * Asset Navigator does: some PI Vision releases change the asset
         * through the router without a hashchange.
         */
        function pollAsset() {
            if (ctx.destroyed) { return; }
            var cfg = ctx.config || {};
            if (cfg.Mode !== 'hierarchy') { return; }
            var a = assetKey(PVX.nav.currentAsset());
            if (a === hier.lastAsset) { return; }
            hier.lastAsset = a;
            ctx.render();
        }

        /* ================================================================ *
         * DOM construction
         * ================================================================ */

        function syncClass(rec) {
            var cls = 'pvx-btn pvx-nav-btn';
            if (rec.item.kind) { cls += ' pvx-nav-btn-' + rec.item.kind; }
            if (rec.active) { cls += ' pvx-nav-btn-active'; }
            if (rec.confirming) { cls += ' pvx-nav-confirm'; }
            rec.el.className = cls;
        }

        function clearNode(n) {
            while (n && n.firstChild) { n.removeChild(n.firstChild); }
        }

        /** The only thing that forces a DOM rebuild. */
        function signature(cfg) {
            return (cfg.Mode || 'display') + '\u0000' + itemsText(cfg) + '\u0000' + menuNote(cfg);
        }

        function fromAf(cfg) { return cfg.ItemsFrom === 'af' && cfg.Mode !== 'hierarchy'; }

        /** The Items text in force: the AF attribute's once read, else the typed one. */
        function itemsText(cfg) {
            if (fromAf(cfg) && menu.path === String(cfg.ItemsAttribute || '').trim() && menu.text !== null) { return menu.text; }
            return cfg.Items || '';
        }

        /** Why the typed buttons are showing in place of the AF menu, or ''. */
        function menuNote(cfg) {
            if (!fromAf(cfg)) { return ''; }
            if (!String(cfg.ItemsAttribute || '').trim()) { return 'Menu from AF: no attribute set in Format; showing the typed buttons.'; }
            if (menu.error) { return 'Menu from AF: ' + menu.error + '; showing the typed buttons.'; }
            return '';
        }

        /** Read the menu attribute when its path changes, and once a minute. */
        function askMenu(cfg) {
            if (!fromAf(cfg)) {
                if (menu.timer !== null) { clearInterval(menu.timer); menu.timer = null; }
                return;
            }
            if (menu.timer === null) { menu.timer = setInterval(function () { askMenu(ctx.config || {}); }, MENU_MS); }
            var path = String(cfg.ItemsAttribute || '').trim();
            var now = (new Date()).getTime();
            if (!path) { menu.path = ''; menu.text = null; menu.error = ''; return; }
            if (path === menu.path && now - menu.at < MENU_MS - 1000) { return; }
            if (path !== menu.path) { menu.text = null; menu.error = ''; }
            menu.path = path;
            menu.at = now;
            if (PVX.api.discovering()) {
                menu.at = 0;
                PVX.api.discover().then(function () { if (!ctx.destroyed) { askMenu(ctx.config || {}); } });
                return;
            }
            if (!PVX.api.isConfigured()) {
                menu.error = PVX.api.unsetHint();
                ctx.render();
                return;
            }
            var gen = ++menu.gen;
            PVX.af.text(path).then(function (text) {
                if (gen !== menu.gen || ctx.destroyed) { return; }
                menu.error = String(text).replace(/^\s+|\s+$/g, '') ? '' : 'the attribute is empty';
                menu.text = menu.error ? null : text;
                ctx.render();
            }, function (err) {
                if (gen !== menu.gen || ctx.destroyed) { return; }
                menu.error = (err && err.pvxError && err.pvxError.message) || 'the attribute could not be read';
                menu.text = null;
                ctx.render();
            });
        }

        // Hierarchy mode puts text between the buttons: the breadcrumb's
        // chevrons, a divider between groups, and notes. They are spans, so
        // they never take a click or a place in `buttons`.
        var TEXT_KINDS = { sep: 'pvx-nav-sep', div: 'pvx-nav-div', note: 'pvx-nav-note' };

        function iconEl(name) {
            var NS = 'http://www.w3.org/2000/svg';
            var svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('class', 'pvx-nav-icon');
            svg.setAttribute('aria-hidden', 'true');
            var path = document.createElementNS(NS, 'path');
            path.setAttribute('d', ICONS[name]);
            svg.appendChild(path);
            return svg;
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
                hint.textContent = cfg.Mode === 'hierarchy'
                    ? 'No current asset. Open this display with an asset, drop an attribute of one onto the panel, or set a start asset in Format.'
                    : 'Add one button per line in the format Label | target';
                host.appendChild(hint);
                return;
            }

            for (var i = 0; i < items.length; i++) {
                var item = items[i];

                if (TEXT_KINDS[item.kind]) {
                    var span = document.createElement('span');
                    span.className = TEXT_KINDS[item.kind];
                    span.textContent = item.label;
                    if (item.tip) { span.title = item.tip; }
                    span.setAttribute('aria-hidden', item.kind === 'note' ? 'false' : 'true');
                    host.appendChild(span);
                    continue;
                }

                var b = document.createElement('button');
                b.type = 'button';                       // never submit a form
                b.setAttribute('data-pvx-index', String(buttons.length));
                b.setAttribute('aria-pressed', 'false');
                b.title = describe(item, cfg);
                if (item.disabled) { b.disabled = true; }

                // textContent, not innerHTML: labels are operator-authored text
                // and must never be interpreted as markup.
                if (item.icon) {
                    b.appendChild(iconEl(item.icon));
                    if (!item.label) { b.setAttribute('aria-label', item.tip || item.icon); }
                }
                var labelEl = document.createElement('span');
                labelEl.className = 'pvx-nav-label';
                labelEl.textContent = item.label;
                b.appendChild(labelEl);

                host.appendChild(b);
                var rec = { el: b, labelEl: labelEl, item: item, active: false, confirming: false };
                buttons.push(rec);
                syncClass(rec);
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

                var hierarchy = cfg.Mode === 'hierarchy';
                if (hierarchy) { ensureRelatives(cfg); }
                if (!hierarchy) { askMenu(cfg); }
                var items = hierarchy ? hierarchyItems(cfg) : parseItems(itemsText(cfg), cfg.Mode || 'display');
                var mnote = hierarchy ? '' : menuNote(cfg);
                if (mnote) { items = items.concat([{ kind: 'note', label: '\u26a0 AF menu', tip: mnote }]); }
                var sig = hierarchy ? 'hierarchy\u0000' + itemsKey(items) : signature(cfg);
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

        hier.lastAsset = assetKey(PVX.nav.currentAsset());
        hier.timer = setInterval(pollAsset, HIER_POLL_MS);
        hier.listener = function () { pollAsset(); };
        try { window.addEventListener('hashchange', hier.listener, false); }
        catch (e) { hier.listener = null; }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
