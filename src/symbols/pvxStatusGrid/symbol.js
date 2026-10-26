/* ============================================================================
 * pvxStatusGrid — responsive grid of status tiles, one per tag
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 *
 * This is the overview panel operators put at the top of a display: every tag
 * gets a tile with its name, its current value, and a colour driven either by
 * the shared PVX threshold spec or by a digital-state map.
 *
 * WHY imperative DOM instead of ng-repeat
 * ---------------------------------------
 * The other symbols in this library draw into SVG; this one deliberately builds
 * real DOM elements by hand:
 *   1. Tiles need genuine text layout — ellipsis, wrapping, baseline alignment
 *      and CSS grid — none of which SVG gives us without manual measurement.
 *   2. An ng-repeat over 60 live rows registers 60+ watchers that re-evaluate on
 *      every PI Vision data update (every few seconds on a busy display). At
 *      that point the digest, not the drawing, is the bottleneck.
 * So we patch the DOM ourselves: when the row *count* is unchanged we reuse the
 * existing tile nodes and only rewrite text and colours; we rebuild the tile
 * list only when the count changes. All text goes in through textContent, so
 * PI-supplied strings can never be interpreted as markup.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxStatusGrid',
        displayName: 'PVX Status Grid',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // Collections repeat one symbol per element; this symbol already shows
        // many tags at once, so collection support would only ever confuse.
        supportsCollections: false,
        configTitle: 'Format Status Grid',
        // A red "Critical" tile is an alarm whatever the symbol is called, so
        // the grid takes no limits it was not given; see pvxAlarmBanner.
        limitsRequired: true,

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                // PI Vision's Table shape uses `Columns` to pick summary columns.
                // Leave it alone — the symbol's own column count lives in
                // `GridColumns` precisely to avoid colliding with this key.
                Columns: ['Value'],
                Height: 180,
                Width: 440,

                Title: '',                 // blank => no header

                // Colour
                ColorSource: 'thresholds', // thresholds | stateMap | quality | none
                // No bands until someone sets them: tiles take the accent
                // colour. The shared 0 / 70 / 90 placeholder painted every
                // point above 90 Critical, whatever its units.
                Thresholds: '',
                StateMap: 'Running:#2f9e5f, Stopped:#8a8f96, Fault:#c8452f, Alarm:#c8452f',

                // Layout
                TileStyle: 'filled',       // filled | outline | accentBar | dot
                GridColumns: 0,            // 0 => auto-fit from MinTileWidth
                MinTileWidth: 110,
                TileHeight: 0,             // 0 => auto from the available height
                TileGap: 6,
                TileRadius: 6,

                // Content
                ShowName: true,
                ShowValue: true,
                ShowUnits: true,
                ShowTime: false,
                ShowStateLabel: true,
                NamePosition: 'above',     // above | below (relative to the value)

                // Ordering
                SortBy: 'none',            // none | name | valueAsc | valueDesc | severity

                // Alarm emphasis
                BlinkOnAlarm: false,
                AlarmBandLabel: 'Critical',

                // Quality
                ShowBadQuality: true,

                // Interaction
                ClickAction: 'none',       // none | navigate
                NavigateTarget: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Normalized rows from the last data update.
        var rows = [];
        // The rows actually on screen, in render order — the click handler maps
        // a tile index back through this array, so it must stay in sync.
        var view = [];
        // Cached tile node records, index-aligned with `view`.
        var tiles = [];
        // Host we attached the delegated listeners to, so onDestroy can undo it.
        var boundHost = null;
        // Live config for the delegated handlers (they fire outside render).
        var liveCfg = {};

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-grid-body',

            onData: function (d) {
                rows = PVX.data.rows(d, ['Value']);
            },

            render: render,

            onDestroy: function () {
                unbindHost();
                tiles = [];
                view = [];
            }
        });

        /* ------------------------------------------------------------------ *
         * state map — "Running:#2f9e5f, Stopped:#8a8f96"
         * ------------------------------------------------------------------ *
         * Same "key:colour[:label]" grammar as PVX.thresholds, but the key is a
         * digital state string rather than a numeric lower bound. Matching is
         * case-insensitive and exact: PI digital states are a closed set, so a
         * substring match would silently colour "Fault Reset" as "Fault".
         */
        var stateMapCache = { spec: null, map: null };

        function parseStateMap(spec) {
            // Re-parsing per row per frame is pure waste on a 60-tile grid, and
            // the spec only changes when someone edits the config pane.
            if (stateMapCache.spec === spec && stateMapCache.map) { return stateMapCache.map; }
            var map = {};
            String(spec === null || spec === undefined ? '' : spec)
                .split(/[,\n;]/)
                .forEach(function (chunk) {
                    var s = chunk.trim();
                    if (!s) { return; }
                    var parts = s.split(':');
                    var key = (parts[0] || '').trim();
                    if (!key) { return; }
                    map[key.toLowerCase()] = {
                        color: (parts[1] || '').trim() || PVX.color.status.info,
                        // Optional third field overrides the label shown on the
                        // tile; default to the key as typed (keeps its casing).
                        label: (parts.slice(2).join(':') || '').trim() || key
                    };
                });
            stateMapCache.spec = spec;
            stateMapCache.map = map;
            return map;
        }

        /** Raw value as a trimmed display string, or '' when there is nothing. */
        function rawText(row) {
            var r = row.raw;
            if (r === null || r === undefined) { return ''; }
            return String(r).trim();
        }

        /* ------------------------------------------------------------------ *
         * colour resolution
         * ------------------------------------------------------------------ *
         * Order: bad quality -> state map -> threshold band -> accent.
         * Quality wins because a stale tag's *last* value is often still inside
         * a "normal" band; painting it green would be actively misleading.
         */
        function resolveStatus(row, cfg) {
            var out = { color: cfg.AccentColor || '#3b82c4', label: '', bad: false, severity: -1 };

            var bad = cfg.ShowBadQuality && !row.good;
            if (bad) {
                out.bad = true;
                out.color = PVX.color.status.stale;
                out.label = row.errorDescription || 'Bad';
                return out;
            }

            var source = cfg.ColorSource || 'thresholds';

            if (source === 'quality') {
                out.color = row.good ? PVX.color.status.normal : PVX.color.status.stale;
                out.label = row.good ? 'Good' : 'Bad';
                return out;
            }

            if (source === 'none') {
                return out;
            }

            if (source === 'stateMap') {
                var hit = parseStateMap(cfg.StateMap)[rawText(row).toLowerCase()];
                if (hit) {
                    out.color = hit.color;
                    out.label = hit.label;
                    return out;
                }
                // Fall through: a numeric tag mixed into a digital grid should
                // still get a sensible band colour rather than flat accent.
            }

            if (cfg.UseThresholds) {
                var list = PVX.thresholds.parse(cfg.Thresholds);
                var n = row.value;
                if (n !== null && list.length) {
                    for (var i = 0; i < list.length; i++) {
                        if (n >= list[i].value) { out.severity = i; } else { break; }
                    }
                    if (out.severity >= 0) {
                        out.color = list[out.severity].color;
                        out.label = list[out.severity].label || '';
                    }
                }
            }
            return out;
        }

        /* ------------------------------------------------------------------ *
         * ordering
         * ------------------------------------------------------------------ */
        function sortRows(list, cfg) {
            var mode = cfg.SortBy || 'none';
            if (mode === 'none') { return list; }
            // Copy: `rows` is the data-update snapshot and other code (and the
            // next render) expects it in PI Vision's original order.
            var out = list.slice();

            if (mode === 'name') {
                out.sort(function (a, b) {
                    return String(a.label).toLowerCase() < String(b.label).toLowerCase() ? -1 :
                        (String(a.label).toLowerCase() > String(b.label).toLowerCase() ? 1 : 0);
                });
                return out;
            }

            if (mode === 'severity') {
                // Worst-first by threshold band index. Bad-quality rows are left
                // in band order on purpose: they already read as different
                // (stripes + muted), and mixing two ranking rules into one sort
                // makes the resulting order impossible for an operator to
                // predict.
                //
                // Decorate-sort-undecorate: resolveStatus parses the threshold
                // spec, and a comparator would call it O(n log n) times.
                var dec = out.map(function (r, i) {
                    return { r: r, s: resolveStatus(r, cfg).severity, i: i };
                });
                dec.sort(function (a, b) {
                    return (b.s - a.s) || (a.i - b.i);   // stable within a band
                });
                return dec.map(function (x) { return x.r; });
            }

            var dir = mode === 'valueAsc' ? 1 : -1;
            out.sort(function (a, b) {
                // Nulls (non-numeric / no data) always sink to the bottom
                // regardless of direction — they are not "the smallest value".
                if (a.value === null && b.value === null) { return 0; }
                if (a.value === null) { return 1; }
                if (b.value === null) { return -1; }
                return (a.value - b.value) * dir;
            });
            return out;
        }

        /* ------------------------------------------------------------------ *
         * tile construction / patching
         * ------------------------------------------------------------------ */
        function makeEl(tag, cls, parent) {
            var e = document.createElement(tag);
            if (cls) { e.className = cls; }
            if (parent) { parent.appendChild(e); }
            return e;
        }

        /**
         * Build one empty tile. Every optional part exists up front and is shown
         * or hidden per render — creating/removing nodes on each update is what
         * makes hand-rolled DOM slow, and it also loses keyboard focus.
         */
        function buildTile() {
            var el = makeEl('div', 'pvx-tile');
            var rec = {
                el: el,
                bar: makeEl('span', 'pvx-tile-bar', el),
                nameRow: makeEl('div', 'pvx-tile-namerow', el),
                valueRow: null,
                dot: null,
                name: null,
                value: null,
                units: null,
                state: null,
                time: null,
                // Last applied text/attributes, so patching can skip untouched
                // nodes; touching textContent forces layout even when equal.
                last: {}
            };
            rec.dot = makeEl('span', 'pvx-tile-dot', rec.nameRow);
            rec.name = makeEl('span', 'pvx-tile-name', rec.nameRow);
            rec.valueRow = makeEl('div', 'pvx-tile-valuerow', el);
            rec.value = makeEl('span', 'pvx-tile-value pvx-num', rec.valueRow);
            rec.units = makeEl('span', 'pvx-tile-units', rec.valueRow);
            rec.state = makeEl('div', 'pvx-tile-state', el);
            rec.time = makeEl('div', 'pvx-tile-time', el);
            return rec;
        }

        function setText(node, text, rec, key) {
            if (rec.last[key] === text) { return; }
            rec.last[key] = text;
            node.textContent = text;   // never innerHTML — PI text is untrusted
        }

        /**
         * Toggle a part of the tile.
         * `onDisplay` must be given for parts whose stylesheet default is
         * `none` (the dot and the accent bar) — clearing the inline value there
         * would fall back to the rule and hide them again.
         */
        function show(node, on, rec, key, onDisplay) {
            var v = on ? (onDisplay || '') : 'none';
            if (rec.last[key] === v) { return; }
            rec.last[key] = v;
            node.style.display = v;
        }

        /* ------------------------------------------------------------------ *
         * render
         * ------------------------------------------------------------------ */
        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            liveCfg = cfg;
            applyThemeVars(c, t);
            bindHost(host);

            if (!rows.length) {
                renderEmpty(host);
                return;
            }

            view = sortRows(rows, cfg);
            var n = view.length;

            // --- geometry -------------------------------------------------
            var gap = numIn(cfg.TileGap, 0, 40, 6);
            var minW = numIn(cfg.MinTileWidth, 40, 600, 110);
            var radius = numIn(cfg.TileRadius, 0, 40, 6);
            var fixedCols = Math.floor(numIn(cfg.GridColumns, 0, 40, 0));
            var fixedH = numIn(cfg.TileHeight, 0, 400, 0);

            var W = Math.max(40, c.width);
            var H = Math.max(24, c.height);

            // Mirror what the CSS will actually do, so the JS-side font sizing
            // agrees with the real tile width. `auto-fill` lays down every track
            // that fits — including empty ones — so the track count must NOT be
            // clamped to the row count, or two tags in a wide symbol would be
            // sized as if they were half the width each.
            var cols = fixedCols > 0
                ? fixedCols
                : Math.max(1, Math.floor((W + gap) / (minW + gap)));
            var tileW = (W - gap * (cols - 1)) / cols;
            // Height, though, only cares about the tracks that hold a tile.
            var rowCount = Math.max(1, Math.ceil(n / Math.max(1, Math.min(cols, n))));
            var tileH = fixedH > 0 ? fixedH : Math.max(34, (H - gap * (rowCount - 1)) / rowCount);

            host.style.display = 'grid';
            host.style.gridTemplateColumns = fixedCols > 0
                ? 'repeat(' + cols + ', 1fr)'
                : 'repeat(auto-fill, minmax(' + Math.round(minW) + 'px, 1fr))';
            host.style.gridAutoRows = Math.round(tileH) + 'px';
            host.style.gap = gap + 'px';
            host.style.gridGap = gap + 'px';   // older Grid implementations

            // --- node pool ------------------------------------------------
            // Rebuild only when the tile count changes; otherwise reuse nodes so
            // a data update is a handful of textContent writes.
            if (tiles.length !== n || host.getAttribute('data-pvx-mode') !== 'tiles') {
                clear(host);
                tiles = [];
                for (var b = 0; b < n; b++) {
                    var rec = buildTile();
                    rec.el.setAttribute('data-pvx-i', String(b));
                    host.appendChild(rec.el);
                    tiles.push(rec);
                }
                host.setAttribute('data-pvx-mode', 'tiles');
            }

            // --- typography ------------------------------------------------
            // Sizes come from the tile box, not the symbol box: a 6-column grid
            // in a wide symbol still has narrow tiles.
            var nameFont = clamp(tileW * 0.10, 9, 13);
            var subFont = clamp(tileW * 0.085, 8, 12);
            var maxValueFont = clamp(Math.min(tileW * 0.26, tileH * 0.42), 10, 30);

            var style = cfg.TileStyle || 'filled';
            var opts = PVX.config.numberOpts(cfg);
            var alarmLabel = String(cfg.AlarmBandLabel || '').trim().toLowerCase();
            var clickable = cfg.ClickAction === 'navigate';

            for (var i = 0; i < n; i++) {
                paintTile(tiles[i], view[i], {
                    cfg: cfg, theme: t, style: style, opts: opts,
                    radius: radius, tileW: tileW, tileH: tileH,
                    nameFont: nameFont, subFont: subFont, maxValueFont: maxValueFont,
                    alarmLabel: alarmLabel, clickable: clickable
                });
            }

            // Nothing here writes to scope.pvx — the template binds only to
            // `config`, so no guarded $digest is needed.
        }

        function paintTile(rec, row, m) {
            var cfg = m.cfg, t = m.theme;
            var st = resolveStatus(row, cfg);

            // --- text ------------------------------------------------------
            var display;
            if (row.value === null) {
                // Digital states and error strings arrive as text; show them as
                // they came rather than forcing them through the number format.
                display = rawText(row) || '--';
            } else {
                display = PVX.fmt.number(row.raw, m.opts);
            }

            setText(rec.name, row.label || '', rec, 'name');
            setText(rec.value, display, rec, 'value');
            setText(rec.units, (cfg.ShowUnits && row.units) ? row.units : '', rec, 'units');
            setText(rec.state, (cfg.ShowStateLabel && st.label) ? st.label : '', rec, 'state');
            setText(rec.time, cfg.ShowTime ? PVX.fmt.time(row.time, 'short') : '', rec, 'time');

            show(rec.nameRow, !!cfg.ShowName, rec, 'showName');
            show(rec.valueRow, !!cfg.ShowValue, rec, 'showValue');
            show(rec.state, !!(cfg.ShowStateLabel && st.label), rec, 'showState');
            show(rec.time, !!(cfg.ShowTime && row.time), rec, 'showTime');
            show(rec.dot, m.style === 'dot', rec, 'showDot', 'inline-block');
            show(rec.bar, m.style === 'accentBar', rec, 'showBar', 'block');

            // NamePosition flips visual order only; the name stays first in the
            // DOM so screen readers and the title tooltip still read name-first.
            rec.nameRow.style.order = cfg.NamePosition === 'below' ? '3' : '0';

            // --- colours ---------------------------------------------------
            var fg = t.text, muted = t.textMuted, bg = t.surfaceAlt, border = 'transparent';
            if (m.style === 'filled') {
                bg = st.color;
                fg = PVX.color.readable(st.color);
                muted = PVX.color.rgba(fg, 0.78);
                border = PVX.color.rgba(fg, 0.14);
            } else if (m.style === 'outline') {
                border = st.color;
            }

            var el = rec.el;
            // backgroundColor, not the `background` shorthand: the shorthand
            // would blow away the bad-quality stripe background-image that the
            // .pvx-tile-bad class paints.
            setStyle(el, 'backgroundColor', bg, rec, 'bg');
            setStyle(el, 'color', fg, rec, 'fg');
            setStyle(el, 'borderColor', border, rec, 'bc');
            setStyle(el, 'borderWidth', m.style === 'outline' ? '2px' : '1px', rec, 'bw');
            setStyle(el, 'borderRadius', m.radius + 'px', rec, 'br');
            setStyle(rec.name, 'color', m.style === 'filled' ? muted : t.textMuted, rec, 'nc');
            setStyle(rec.name, 'fontSize', m.nameFont.toFixed(1) + 'px', rec, 'nf');
            setStyle(rec.units, 'color', muted, rec, 'uc');
            setStyle(rec.units, 'fontSize', m.subFont.toFixed(1) + 'px', rec, 'uf');
            setStyle(rec.time, 'color', muted, rec, 'tc');
            setStyle(rec.time, 'fontSize', (m.subFont * 0.92).toFixed(1) + 'px', rec, 'tf');
            setStyle(rec.state, 'color', m.style === 'filled' ? muted : st.color, rec, 'sc');
            setStyle(rec.state, 'fontSize', m.subFont.toFixed(1) + 'px', rec, 'sf');
            setStyle(rec.dot, 'backgroundColor', st.color, rec, 'dc');
            setStyle(rec.bar, 'backgroundColor', st.color, rec, 'barc');
            setStyle(rec.value, 'color', m.style === 'filled' ? fg : t.text, rec, 'vc');

            // The value is the one string that must not clip: shrink it to fit
            // the tile rather than truncating a reading to "12…".
            var valueFont = PVX.layout.fitFont(
                display + (rec.last.units ? ' ' + rec.last.units : ''),
                m.tileW - 14, m.tileH * 0.42, m.maxValueFont, 9
            );
            setStyle(rec.value, 'fontSize', valueFont.toFixed(1) + 'px', rec, 'vf');

            // --- state classes ----------------------------------------------
            var isAlarm = !!cfg.BlinkOnAlarm && !st.bad && !!st.label &&
                st.label.toLowerCase() === m.alarmLabel;
            // `-st-` in the style class is deliberate: a bare `pvx-tile-dot`
            // would collide with the dot element's own class and style the whole
            // tile as a 7px circle.
            var cls = 'pvx-tile pvx-tile-st-' + m.style +
                (st.bad ? ' pvx-tile-bad' : '') +
                (isAlarm ? ' pvx-tile-blink' : '') +
                (m.clickable ? ' pvx-tile-click' : '');
            if (rec.last.cls !== cls) { rec.last.cls = cls; el.className = cls; }

            // --- accessibility + tooltip --------------------------------------
            var tip = (row.path || row.label || '') +
                '\n' + display + (row.units ? ' ' + row.units : '') +
                (st.label ? '\n' + st.label : '') +
                (row.time ? '\n' + PVX.fmt.time(row.time, 'datetime') : '') +
                (st.bad ? '\n' + (row.errorDescription || 'Bad quality') : '');
            if (rec.last.tip !== tip) { rec.last.tip = tip; el.setAttribute('title', tip); }

            if (m.clickable) {
                el.setAttribute('tabindex', '0');
                el.setAttribute('role', 'button');
            } else {
                el.removeAttribute('tabindex');
                el.removeAttribute('role');
            }
        }

        function setStyle(node, prop, value, rec, key) {
            if (rec.last[key] === value) { return; }
            rec.last[key] = value;
            node.style[prop] = value;
        }

        function renderEmpty(host) {
            // A rebuilt empty state would drop focus if it ran every update, so
            // only touch the DOM when we are not already showing it.
            if (host.getAttribute('data-pvx-mode') === 'empty') { return; }
            clear(host);
            tiles = [];
            view = [];
            // Drop the grid styling the tile path wrote inline, so .pvx-empty's
            // own centring layout applies.
            host.removeAttribute('style');
            var msg = makeEl('div', 'pvx-empty', host);
            msg.textContent = 'No data sources configured';
            host.setAttribute('data-pvx-mode', 'empty');
        }

        function clear(node) {
            while (node.firstChild) { node.removeChild(node.firstChild); }
        }

        /** Push theme tokens onto the element as CSS custom properties. */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', c.config.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-surface-alt', t.surfaceAlt);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            // Diagonal stripes for bad quality are drawn in CSS from this token
            // so they stay legible on both themes.
            n.style.setProperty('--pvx-stripe', t.dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.13)');
        }

        /* ------------------------------------------------------------------ *
         * interaction — one delegated listener pair for the whole grid
         * ------------------------------------------------------------------ *
         * Per-tile listeners would mean 2N registrations that all have to be
         * torn down by hand; delegation keeps teardown to two removeEventListener
         * calls no matter how many tags the display grows to.
         */
        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            host.addEventListener('click', onClick, false);
            host.addEventListener('keydown', onKeyDown, false);
            boundHost = host;
        }

        function unbindHost() {
            if (!boundHost) { return; }
            boundHost.removeEventListener('click', onClick, false);
            boundHost.removeEventListener('keydown', onKeyDown, false);
            boundHost = null;
        }

        /** Walk up to the tile element. Element.closest is missing on IE11. */
        function tileIndexOf(target) {
            var node = target;
            var guard = 0;
            while (node && node !== boundHost && guard < 12) {
                if (node.getAttribute && node.getAttribute('data-pvx-i') !== null) {
                    var i = parseInt(node.getAttribute('data-pvx-i'), 10);
                    return isNaN(i) ? -1 : i;
                }
                node = node.parentNode;
                guard += 1;
            }
            return -1;
        }

        function onClick(ev) {
            if (liveCfg.ClickAction !== 'navigate') { return; }
            activate(tileIndexOf(ev.target));
        }

        function onKeyDown(ev) {
            if (liveCfg.ClickAction !== 'navigate') { return; }
            var k = ev.keyCode || ev.which;
            if (k !== 13 && k !== 32) { return; }   // Enter, Space
            var i = tileIndexOf(ev.target);
            if (i < 0) { return; }
            // Space would scroll the display container otherwise.
            if (ev.preventDefault) { ev.preventDefault(); }
            activate(i);
        }

        function activate(index) {
            if (index < 0 || index >= view.length) { return; }
            var row = view[index];
            var target = String(liveCfg.NavigateTarget || '').trim();
            // The tile's element, not its attribute: asset= names an element.
            var asset = PVX.nav.assetOf(row.path);
            // With no target and no element there is nowhere to go, and
            // navigating to the current URL would just flicker the display.
            if (!target && !asset) { return; }
            PVX.nav.go(PVX.nav.url({
                display: target || undefined,
                asset: asset || undefined
            }), false);
        }

        /* ------------------------------------------------------------------ *
         * small numeric helpers
         * ------------------------------------------------------------------ */
        function clamp(v, lo, hi) { return PVX.util.clamp(v, lo, hi); }

        function numIn(v, lo, hi, fallback) {
            var n = PVX.util.num(v);
            if (n === null) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
