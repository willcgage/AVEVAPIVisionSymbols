/* ============================================================================
 * pvxRadar — "PVX Fingerprint": a normalised multi-axis profile (radar / spider)
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 *
 * The question this symbol answers is "does this asset still LOOK like it used
 * to". It is a shape-recognition instrument, not a reading instrument: the
 * axes carry different units (°F, A, klb/h, %), each is normalised to its own
 * 0..1, and what the operator compares is the outline — not the numbers.
 * Anything that needs magnitudes compared should be a bar chart instead, and
 * the config pane says so.
 *
 * SCALING is the whole design problem here. A radar over mixed units is only
 * honest if every axis carries its own min/max, and only STABLE if those
 * min/max come from configuration rather than from the data currently on
 * screen. Three modes, in increasing order of trustworthiness:
 *
 *   shared        one scale for every axis. Only honest when the units match.
 *   perAxisData   each axis takes its extent from the values plotted on it.
 *                 Needs at least two values on an axis to have an extent at
 *                 all, so in "Current only" mode there is nothing to measure
 *                 and those axes borrow the shared extent — see axisDomain().
 *   perAxisFixed  explicit limits from AxisLimits. The only mode where the
 *                 shape means the same thing tomorrow as it does today, which
 *                 is the only thing that makes a saved display worth saving.
 *
 * COLUMN SYNC
 *   PI Vision returns Summary cells positionally, matching config.Columns, so
 *   the chosen statistic must drive that array or the symbol silently plots a
 *   different aggregate. All of that lives in the shared helpers
 *   (PVX.config.statColumns / syncStatColumns, PVX.data.statValue); this file
 *   only has to call syncStatColumns from onConfigChange AND from render so a
 *   display saved by an older build repairs itself on load.
 *
 * RENDERING
 *   Everything inside the body is SVG drawn into `.pvx-radar-body`; only the
 *   header/footer chrome is Angular-bound. buildModel() is pure — given rows
 *   and a config it returns the axes, the series, the per-axis domains and the
 *   notes, so the drawing code never has to make a data decision.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* A radar with fewer than three axes is a line or a dot, not a shape. */
    var MIN_AXES = 3;

    var definition = {
        typeName: 'pvxRadar',
        displayName: 'PVX Fingerprint',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        // Positional config, renumbered when a data source is removed.
        sourceRemap: { AxisLimits: 'listComma' },
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format Fingerprint',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                // Positional contract with PI Vision's Summary cells; kept in
                // step with Statistic by PVX.config.syncStatColumns().
                Columns: ['Value'],
                SortColumn: 'Value',
                Height: 300,
                Width: 380,

                Title: '',
                ShowLabel: true,

                // --- what is plotted -------------------------------------
                Statistic: 'Value',          // Value|Average|Minimum|Maximum|Range|StdDev|Total

                // --- scaling ---------------------------------------------
                ScaleMode: 'perAxisData',    // perAxisData | perAxisFixed | shared
                AxisLimits: '',              // "0:200, 40:90, 0:100" — positional

                // --- series ----------------------------------------------
                SeriesMode: 'single',        // single | reference | compare
                ReferenceLabel: 'Reference',
                CurrentLabel: 'Current',

                // --- shape -----------------------------------------------
                FillOpacity: 0.25,
                LineWidth: 2,
                ShowPoints: true,
                PointRadius: 3,

                // --- web -------------------------------------------------
                ShowAxisLines: true,
                ShowRings: true,
                RingCount: 4,
                RingStyle: 'polygon',        // polygon | circle
                StartAngle: 0,               // degrees, 0 = 12 o'clock, clockwise +
                MaxAxes: 12,

                // --- labels ----------------------------------------------
                ShowAxisLabels: true,
                ShowValueLabels: false,
                ShowScaleLabels: false,
                ShowLegend: true,

                // --- colour ----------------------------------------------
                CurrentColor: '#3b82c4',
                ReferenceColor: '#8a8f96',
                ColorByThreshold: false
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the chart itself is SVG.
        scope.pvx = {
            title: '',
            subtitle: '',
            note: '',
            count: '',
            error: '',
            background: '',
            showHeader: true,
            showFooter: true
        };

        var rows = [];
        // Last chrome decision, so a change can request exactly one extra frame
        // (see render) instead of re-rendering forever.
        var chromeState = '';

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-radar-body',

            onData: function (d) {
                // Parse against the column the chosen statistic actually asks
                // for. statValue() falls back to the row value for one refresh
                // if an in-flight payload still carries the previous column.
                rows = PVX.data.rows(d, PVX.config.statColumns(scope.config)) || [];
            },

            onConfigChange: function (newCfg) {
                // The statistic decides which aggregate PI Vision computes, so
                // the request has to be corrected before the next fetch.
                PVX.config.syncStatColumns(newCfg || scope.config);
            },

            render: render
        });

        /* ================================================================ *
         * Pure model
         * ================================================================ */

        function intOr(v, fallback) {
            var n = parseInt(v, 10);
            return isFinite(n) ? n : fallback;
        }

        /**
         * Parse the AxisLimits grammar: comma-separated `min:max` entries that
         * line up positionally with the data sources. A blank entry means "use
         * the data extent for this axis", and so does a malformed one — a typo
         * in axis 4 must not stop axes 1-3 from being drawn correctly.
         * @returns {Object} {list:[{min,max}|null], bad:Number}
         */
        function parseLimits(spec) {
            var out = { list: [], bad: 0 };
            var raw = (spec === null || spec === undefined) ? '' : String(spec);
            if (!raw.replace(/\s/g, '')) { return out; }
            var parts = raw.split(',');
            for (var i = 0; i < parts.length; i++) {
                var s = parts[i].replace(/^\s+|\s+$/g, '');
                if (!s) { out.list.push(null); continue; }
                var bits = s.split(':');
                var lo = PVX.util.num(bits[0]);
                var hi = PVX.util.num(bits[1]);
                if (bits.length < 2 || lo === null || hi === null || !(hi > lo)) {
                    out.list.push(null);
                    out.bad += 1;
                    continue;
                }
                out.list.push({ min: lo, max: hi });
            }
            return out;
        }

        function extentOf(values) {
            var lo = null, hi = null;
            for (var i = 0; i < values.length; i++) {
                var v = values[i];
                if (!PVX.util.isNum(v)) { continue; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            }
            return lo === null ? null : { min: lo, max: hi };
        }

        /**
         * One scale covering every value on every axis.
         *
         * Anchored at zero whenever the data is entirely positive: a radar is
         * read outward from the centre, so a centre that does not mean "none"
         * exaggerates small differences into a dramatic change of shape.
         */
        function sharedDomain(values) {
            var e = extentOf(values);
            if (!e) { return { min: 0, max: 1, degenerate: true }; }
            var lo = e.min > 0 ? 0 : e.min;
            var hi = e.max < 0 ? 0 : e.max;
            if (lo === hi) {
                // Every source reports the same number. Nothing is wrong with
                // the data; there is simply no spread to map, so pad around it
                // and let the polygon come out regular.
                var pad = Math.abs(lo) * 0.1 || 1;
                return { min: lo - pad, max: hi + pad, degenerate: true };
            }
            var d = PVX.scale.niceDomain(lo, hi, 4);
            return { min: d[0], max: d[1], degenerate: false };
        }

        /**
         * Domain for one axis under the configured scale mode.
         * `fallback` counts the axes that could not honour the requested mode,
         * so the footer can admit it rather than quietly lying about the scale.
         */
        function axisDomain(axis, index, cfg, limits, shared, fallback) {
            if (cfg.ScaleMode === 'shared') { return shared; }

            if (cfg.ScaleMode === 'perAxisFixed') {
                var L = limits.list[index];
                if (L) { return L; }
                fallback.fixed += 1;
                // fall through to the data extent, as documented
            }

            var vals = [axis.cur.value];
            if (axis.ref) { vals.push(axis.ref.value); }

            // One value is not an extent. Borrowing the shared scale keeps the
            // outline varied and honest; the alternative — scaling each axis to
            // its own single value — puts every vertex at the same radius and
            // draws a regular polygon that says nothing at all. The footer note
            // admits the substitution.
            if (vals.length < 2) {
                fallback.data += 1;
                return shared;
            }

            var e = extentOf(vals);
            if (!e) { fallback.data += 1; return shared; }

            // Anchored at zero rather than spanning min..max. Spanning the two
            // values would put one at the centre and the other at the rim on
            // EVERY axis, so all the axes look identically changed; anchoring
            // at zero keeps the ratio between the profiles visible, which is
            // the whole reason for drawing two of them.
            var lo = e.min > 0 ? 0 : e.min;
            var hi = e.max < 0 ? 0 : e.max;
            var span = hi - lo;
            if (!(span > 0)) { fallback.data += 1; return shared; }
            // Breathing room so the larger value is not welded to the outer
            // ring, where a further rise would be invisible.
            if (lo < 0) { lo -= span * 0.12; }
            if (hi > 0) { hi += span * 0.12; }
            return { min: lo, max: hi };
        }

        /** Normalised radius 0..1 for a value on an axis. */
        function normalise(v, dom) {
            if (!PVX.util.isNum(v)) { return null; }
            var span = dom.max - dom.min;
            // A zero-width axis (min == max, from data or from a hand-edited
            // limit) carries no information. Mid-radius says "no position
            // known" without pretending the value is at either extreme.
            if (!(span > 0)) { return 0.5; }
            // Clamped, so a value below the axis minimum stops at the centre
            // instead of going negative and inverting through the origin.
            return PVX.util.clamp((v - dom.min) / span, 0, 1);
        }

        /**
         * rows + config -> {axes, series, notes, ...}
         * Each axis is {label, units, cur, ref, dom}; each series entry knows
         * its colour, its label and its normalised radii.
         */
        function buildModel(cfg) {
            var i;
            var pts = [];
            var skipped = 0;
            var badCount = 0;

            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                var v = PVX.data.statValue(r, cfg);
                if (v === null || v === undefined) { skipped += 1; continue; }
                if (!r.good) { badCount += 1; }
                pts.push({
                    label: r.label || ('Source ' + (i + 1)),
                    units: r.units || '',
                    path: r.path || '',
                    good: r.good !== false,
                    error: r.errorDescription || '',
                    value: v
                });
            }

            var notes = [];
            var mode = cfg.SeriesMode || 'single';
            if (mode !== 'single' && mode !== 'reference' && mode !== 'compare') { mode = 'single'; }

            // Two profiles need two halves, and each half needs enough sources
            // to be a shape in its own right. Below that the split is dropped
            // rather than drawing a triangle against a line.
            if (mode !== 'single' && pts.length < MIN_AXES * 2) {
                notes.push('Two profiles need at least ' + (MIN_AXES * 2) + ' sources; showing one');
                mode = 'single';
            }

            var axes = [];
            if (mode === 'single') {
                for (i = 0; i < pts.length; i++) {
                    axes.push({ label: pts[i].label, units: pts[i].units, cur: pts[i], ref: null });
                }
            } else {
                // N = half the sources. The LAST N are the reference profile,
                // paired positionally with the first N. An odd source count
                // leaves one in the middle with no partner; dropping it is the
                // only pairing that cannot silently mis-align the two profiles.
                var half = Math.floor(pts.length / 2);
                var unpaired = pts.length - half * 2;
                for (i = 0; i < half; i++) {
                    axes.push({
                        label: pts[i].label,
                        units: pts[i].units,
                        cur: pts[i],
                        ref: pts[pts.length - half + i]
                    });
                }
                if (unpaired) {
                    notes.push('Odd source count — "' + pts[half].label + '" has no partner and is not shown');
                }
            }

            // Beyond a dozen axes the labels collide and the outline stops
            // being memorable, which is the only thing this symbol is for.
            var maxAxes = PVX.util.clamp(intOr(cfg.MaxAxes, 12), MIN_AXES, 24);
            var hidden = 0;
            if (axes.length > maxAxes) {
                hidden = axes.length - maxAxes;
                axes = axes.slice(0, maxAxes);
                notes.push('+' + hidden + ' ' + (hidden === 1 ? 'axis' : 'axes') + ' beyond the ' + maxAxes + '-axis limit');
            }

            // --- domains -------------------------------------------------
            var all = [];
            for (i = 0; i < axes.length; i++) {
                all.push(axes[i].cur.value);
                if (axes[i].ref) { all.push(axes[i].ref.value); }
            }
            var shared = sharedDomain(all);
            var limits = parseLimits(cfg.AxisLimits);
            var fallback = { fixed: 0, data: 0 };
            var flat = 0;

            for (i = 0; i < axes.length; i++) {
                axes[i].dom = axisDomain(axes[i], i, cfg, limits, shared, fallback);
                if (!(axes[i].dom.max > axes[i].dom.min)) { flat += 1; }
                axes[i].curR = normalise(axes[i].cur.value, axes[i].dom);
                axes[i].refR = axes[i].ref ? normalise(axes[i].ref.value, axes[i].dom) : null;
            }

            if (limits.bad) {
                notes.push(limits.bad + ' axis ' + (limits.bad === 1 ? 'limit is' : 'limits are') + ' malformed (use min:max)');
            }
            if (cfg.ScaleMode === 'perAxisFixed' && fallback.fixed) {
                notes.push(fallback.fixed + ' of ' + axes.length + ' axes have no fixed limit; falling back to the data scale');
            }
            if (cfg.ScaleMode === 'perAxisData' && fallback.data) {
                notes.push(fallback.data === axes.length
                    ? 'One value per axis — no per-axis extent, using one shared scale'
                    : fallback.data + ' axes have a single value; using the shared scale');
            }
            if (flat) { notes.push(flat + ' ' + (flat === 1 ? 'axis has' : 'axes have') + ' no range'); }
            if (shared.degenerate && axes.length) { notes.push('All values are identical'); }
            if (skipped) {
                notes.push(skipped + (skipped === 1 ? ' source has no ' : ' sources have no ') +
                    PVX.config.statLabel(cfg).toLowerCase());
            }

            // --- series --------------------------------------------------
            // Reference first so it is drawn (and legended) behind the current
            // profile; the eye should land on today's shape.
            var series = [];
            if (mode !== 'single') {
                series.push({
                    key: 'ref',
                    label: PVX.util.def(cfg.ReferenceLabel, 'Reference'),
                    color: cfg.ReferenceColor || '#8a8f96',
                    dashed: mode === 'reference',
                    // A reference is context, not a measurement, so in
                    // 'reference' mode it is deliberately quieter than the
                    // current profile. In 'compare' both carry equal weight.
                    weight: mode === 'reference' ? 0.6 : 1
                });
            }
            series.push({
                key: 'cur',
                label: PVX.util.def(cfg.CurrentLabel, 'Current'),
                color: cfg.CurrentColor || '#3b82c4',
                dashed: false,
                weight: 1
            });

            return {
                axes: axes,
                series: series,
                mode: mode,
                shared: shared,
                sources: rows.length,
                notes: notes,
                badCount: badCount,
                skipped: skipped,
                empty: pts.length === 0
            };
        }

        /* ================================================================ *
         * Text helpers
         * ================================================================ */

        /**
         * Approximate rendered width. Good enough to pick a first cut of a
         * label, and cheap enough to call for every axis on every frame.
         */
        function textPx(s, fontPx) {
            return String(s === null || s === undefined ? '' : s).length * fontPx * 0.58;
        }

        function truncate(s, maxPx, fontPx) {
            var str = String(s === null || s === undefined ? '' : s);
            var per = fontPx * 0.58;
            var max = Math.floor(maxPx / per);
            if (max < 1) { return ''; }
            if (str.length <= max) { return str; }
            if (max === 1) { return '…'; }
            return str.slice(0, max - 1) + '…';
        }

        /**
         * Trim an already-drawn <text> until getComputedTextLength() reports it
         * inside `maxPx`.
         *
         * Axis labels are the one place in this symbol where the 0.58em glyph
         * estimate is not safe. They are anchored against the frame edge — end
         * on the left, start on the right — so an estimate that runs narrow
         * (mixed-case asset names such as "Feedwater Pump B Amps" average well
         * above 0.58em) pushes the text off canvas, where the host's
         * overflow:hidden chops glyphs instead of ellipsising. No clamp can
         * repair that after the fact; the string has to be short enough. One
         * forced layout per axis, bounded by MaxAxes, is affordable here.
         *
         * The caller passes text already cut by the estimate, so the common
         * case measures once and returns.
         */
        function fitTextTo(node, maxPx) {
            if (!node || !node.getComputedTextLength) { return; }
            if (!(maxPx > 0)) { node.textContent = ''; return; }
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            for (var guard = 0; guard < 8; guard++) {
                var w = measure();
                if (!(w > maxPx)) { return; }
                var cur = node.textContent || '';
                var core = cur.charAt(cur.length - 1) === '…' ? cur.slice(0, -1) : cur;
                if (core.length < 2) { node.textContent = ''; return; }
                // -1 leaves room for the ellipsis; the min() guarantees the
                // string shrinks every pass even when the ratio rounds up.
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return; }
                node.textContent = core.slice(0, keep) + '…';
            }
            if (measure() > maxPx) { node.textContent = ''; }
        }

        /* ================================================================ *
         * Render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            // Self-heal a config saved by an older build or edited by hand.
            // Only writes when something differs, so it cannot loop with PI
            // Vision's own change detection.
            PVX.config.syncStatColumns(cfg);

            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            var W = Math.max(40, c.width);
            var H = Math.max(30, c.height);

            // Breakpoints are judged on the SYMBOL box, not on the drawing
            // host: the host shrinks when the header and footer are shown, so
            // deciding from it would make the two decisions chase each other.
            var symW = (c.node && c.node.clientWidth) || W;
            var symH = (c.node && c.node.clientHeight) || H;
            var compact = (symW < 220 || symH < 180);
            var mini = (symW < 140 || symH < 100);

            // A tile too small for the web is far too small for chrome; the
            // shape is the only thing worth the pixels.
            scope.pvx.showHeader = cfg.ShowLabel !== false && !mini;
            scope.pvx.showFooter = !compact;

            var svgRoot = host.querySelector('svg.pvx-radar-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-radar-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            // The web is circular, so the box must not be stretched: a squashed
            // radar reads as a changed profile when only the window changed.
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var model = buildModel(cfg);

            // ---- chrome ---------------------------------------------------
            scope.pvx.title = cfg.Title || 'Profile';
            scope.pvx.subtitle = PVX.config.statLabel(cfg) + ' · ' + scaleModeLabel(cfg);
            scope.pvx.note = model.notes.join(' · ');
            scope.pvx.count = model.axes.length
                ? (model.axes.length + (model.axes.length === 1 ? ' axis' : ' axes') +
                   (model.mode === 'single' ? '' : ' × 2 profiles'))
                : '';
            scope.pvx.error = model.badCount
                ? (model.badCount + (model.badCount === 1 ? ' source reports' : ' sources report') + ' bad quality')
                : '';

            // Showing or hiding the chrome changes the drawing host's height,
            // and that only lands after Angular's digest — so one extra frame
            // is requested when (and only when) the decision actually flips.
            var wantChrome = (scope.pvx.showHeader ? 'h' : '') + (scope.pvx.showFooter ? 'f' : '');
            var chromeChanged = wantChrome !== chromeState;
            chromeState = wantChrome;

            if (model.empty) {
                message(svgRoot, W, H, t,
                    rows.length ? 'No ' + PVX.config.statLabel(cfg).toLowerCase() + ' values' : 'No data sources',
                    rows.length
                        ? 'All ' + rows.length + ' sources returned an empty cell.'
                        : 'Drop three or more attributes onto this symbol.');
                digest();
                if (chromeChanged) { c.render(); }
                return;
            }

            if (model.axes.length < MIN_AXES) {
                // A two-axis "radar" is a line through the centre and a
                // one-axis radar is a dot. Saying so beats drawing it.
                message(svgRoot, W, H, t,
                    'Needs ' + MIN_AXES + ' axes',
                    model.mode === 'single'
                        ? model.axes.length + ' of ' + MIN_AXES + ' attributes added so far.'
                        : 'Two profiles need ' + (MIN_AXES * 2) + ' sources.');
                digest();
                if (chromeChanged) { c.render(); }
                return;
            }

            drawRadar(svgRoot, W, H, cfg, t, model, compact, mini);
            digest();
            if (chromeChanged) { c.render(); }
        }

        function scaleModeLabel(cfg) {
            switch (cfg.ScaleMode) {
                case 'perAxisFixed': return 'fixed axis limits';
                case 'shared': return 'one shared scale';
                default: return 'axis limits from data';
            }
        }

        /**
         * @param {Boolean} compact below ~220x180: no labels, no web — just
         *        the outline, because the label ring would eat more room than
         *        the shape it describes.
         * @param {Boolean} mini below ~140x100: the legend goes too.
         */
        function drawRadar(svgRoot, W, H, cfg, t, model, compact, mini) {
            var i;
            var axes = model.axes;
            var n = axes.length;

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 20), 8, 12);
            var pad = 4;

            var showLabels = cfg.ShowAxisLabels !== false && !compact;
            var showRings = cfg.ShowRings !== false && !compact;
            var showSpokes = cfg.ShowAxisLines !== false && !compact;
            var showScale = !!cfg.ShowScaleLabels && !compact;
            var showValues = !!cfg.ShowValueLabels && !compact;

            var legend = buildLegend(cfg, model);
            var showLegend = cfg.ShowLegend !== false && !mini && legend.length > 0;
            var legendH = showLegend ? font * 2.0 : 0;

            var boxX0 = pad, boxX1 = W - pad;
            var boxY0 = pad, boxY1 = H - pad - legendH;
            if (boxY1 - boxY0 < 30) {        // legend would starve the web
                showLegend = false;
                legendH = 0;
                boxY1 = H - pad;
            }

            var availW = Math.max(10, boxX1 - boxX0);
            var availH = Math.max(10, boxY1 - boxY0);

            // Reserve the label ring BEFORE the radius is chosen, the way
            // pvxRadialGauge reserves its scale-label ring — labels sized
            // afterwards can only be squeezed out of the frame.
            var reserveX = 0, reserveY = 0;
            var r;
            for (var attempt = 0; attempt < 2; attempt++) {
                reserveX = showLabels ? PVX.util.clamp(availW * 0.20, 16, availW * 0.30) : 2;
                reserveY = showLabels ? font * 1.7 : 2;
                r = Math.min((availW - 2 * reserveX) / 2, (availH - 2 * reserveY) / 2);
                // If the ring leaves nothing worth drawing, the labels are the
                // thing to give up — not the shape.
                if (r >= 14 || !showLabels) { break; }
                showLabels = false;
            }
            r = Math.max(8, r);

            var cx = (boxX0 + boxX1) / 2;
            var cy = (boxY0 + boxY1) / 2;

            var start = PVX.util.num(cfg.StartAngle);
            if (start === null) { start = 0; }
            var step = 360 / n;
            var angleAt = function (idx) { return start + idx * step; };

            // ---- rings ----------------------------------------------------
            var ringCount = PVX.util.clamp(intOr(cfg.RingCount, 4), 1, 10);
            var ringsG = PVX.svg.el('g', { 'class': 'pvx-radar-web' }, svgRoot);
            if (showRings) {
                for (var k = 1; k <= ringCount; k++) {
                    var rk = r * (k / ringCount);
                    var outer = (k === ringCount);
                    if (cfg.RingStyle === 'circle') {
                        PVX.svg.el('circle', {
                            cx: cx.toFixed(2), cy: cy.toFixed(2), r: rk.toFixed(2),
                            fill: 'none',
                            stroke: outer ? t.axis : t.grid,
                            'stroke-width': outer ? 1 : 0.8
                        }, ringsG);
                    } else {
                        PVX.svg.el('path', {
                            d: ringPath(cx, cy, rk, n, angleAt),
                            fill: 'none',
                            stroke: outer ? t.axis : t.grid,
                            'stroke-width': outer ? 1 : 0.8,
                            'stroke-linejoin': 'round'
                        }, ringsG);
                    }
                }
            }

            // ---- spokes ---------------------------------------------------
            if (showSpokes) {
                for (i = 0; i < n; i++) {
                    var sp = PVX.svg.polar(cx, cy, r, angleAt(i));
                    PVX.svg.el('line', {
                        x1: cx.toFixed(2), y1: cy.toFixed(2),
                        x2: sp.x.toFixed(2), y2: sp.y.toFixed(2),
                        stroke: t.grid, 'stroke-width': 0.8
                    }, ringsG);
                }
            }

            // ---- scale labels ---------------------------------------------
            // Drawn along the first axis only. Under a per-axis scale they
            // describe THAT axis and nothing else, which the config pane says.
            if (showScale) {
                var dom0 = axes[0].dom;
                for (var s = 0; s <= ringCount; s++) {
                    var sr = r * (s / ringCount);
                    var sp2 = PVX.svg.polar(cx, cy, sr, angleAt(0));
                    var sv = dom0.min + (dom0.max - dom0.min) * (s / ringCount);
                    PVX.svg.text(ringsG, (sp2.x + 3).toFixed(2), sp2.y.toFixed(2), PVX.fmt.tick(sv), {
                        'class': 'pvx-svg-label pvx-radar-scale',
                        'text-anchor': 'start',
                        'font-size': (font * 0.85).toFixed(1),
                        fill: t.textMuted
                    });
                }
            }

            // ---- series polygons ------------------------------------------
            var lineW = PVX.util.clamp(PVX.util.num(cfg.LineWidth) === null ? 2 : PVX.util.num(cfg.LineWidth), 0.5, 8);
            var fillOp = PVX.util.clamp(PVX.util.num(cfg.FillOpacity) === null ? 0.25 : PVX.util.num(cfg.FillOpacity), 0, 1);
            var pointR = PVX.util.clamp(PVX.util.num(cfg.PointRadius) === null ? 3 : PVX.util.num(cfg.PointRadius), 1, 10);
            // Markers scale with the web so a 900px symbol does not show pin
            // pricks and a 140px one is not swallowed by its own dots.
            pointR = PVX.util.clamp(pointR * (r / 90), 1.2, pointR * 1.6);

            var seriesG = PVX.svg.el('g', { 'class': 'pvx-radar-series' }, svgRoot);

            for (var si = 0; si < model.series.length; si++) {
                var ser = model.series[si];
                var pts = [];
                for (i = 0; i < n; i++) {
                    var rad = ser.key === 'ref' ? axes[i].refR : axes[i].curR;
                    if (rad === null) { rad = 0; }
                    pts.push(PVX.svg.polar(cx, cy, r * rad, angleAt(i)));
                }

                var g = PVX.svg.el('g', { 'class': 'pvx-radar-poly pvx-radar-' + ser.key }, seriesG);
                PVX.svg.el('path', {
                    d: polygonPath(pts),
                    fill: fillOp > 0 ? PVX.color.rgba(ser.color, fillOp * ser.weight) : 'none',
                    stroke: ser.color,
                    'stroke-width': (lineW * ser.weight).toFixed(2),
                    'stroke-linejoin': 'round',
                    'stroke-dasharray': ser.dashed ? (lineW * 2.5).toFixed(1) + ' ' + (lineW * 1.8).toFixed(1) : null,
                    opacity: ser.weight < 1 ? '0.85' : null
                }, g);

                // ---- vertex markers ---------------------------------------
                if (cfg.ShowPoints !== false) {
                    for (i = 0; i < n; i++) {
                        var src = ser.key === 'ref' ? axes[i].ref : axes[i].cur;
                        if (!src) { continue; }
                        var mColor = ser.color;
                        // Threshold colouring is what turns "the shape changed"
                        // into "THIS axis changed" at a glance.
                        if (cfg.ColorByThreshold && cfg.UseThresholds) {
                            mColor = PVX.thresholds.colorFor(cfg.Thresholds, src.value, ser.color);
                        }
                        if (!src.good) { mColor = PVX.color.status.stale; }
                        var mk = PVX.svg.el('circle', {
                            cx: pts[i].x.toFixed(2), cy: pts[i].y.toFixed(2),
                            r: (ser.key === 'ref' ? pointR * 0.8 : pointR).toFixed(2),
                            fill: src.good ? mColor : 'none',
                            stroke: src.good ? (t.surface === 'transparent' ? 'none' : t.surface) : mColor,
                            'stroke-width': src.good ? 0.8 : 1.4,
                            'class': 'pvx-radar-point'
                        }, g);
                        PVX.svg.el('title', null, mk).textContent = pointTip(cfg, axes[i], src, ser);
                    }
                }

                // ---- value labels -----------------------------------------
                // Only the current profile is labelled: two numbers per vertex
                // collide, and the reference is context rather than a reading.
                if (showValues && ser.key === 'cur') {
                    for (i = 0; i < n; i++) {
                        var vrad = axes[i].curR === null ? 0 : axes[i].curR;
                        // Outside the vertex normally, but a vertex near the rim
                        // would push its number into the axis-label ring, so
                        // those flip inward instead of colliding with the name.
                        var inward = vrad > 0.82;
                        var voff = pointR + font * 0.6;
                        var vp = PVX.svg.polar(cx, cy, Math.max(0, r * vrad + (inward ? -voff : voff)), angleAt(i));
                        PVX.svg.text(g, vp.x.toFixed(2), vp.y.toFixed(2),
                            PVX.fmt.number(axes[i].cur.value, PVX.config.numberOpts(cfg)), {
                                'class': 'pvx-svg-value pvx-num pvx-radar-value',
                                'text-anchor': inward ? 'middle' : anchorFor(vp.x, cx, r),
                                'font-size': (font * 0.9).toFixed(1),
                                fill: t.text
                            });
                    }
                }
            }

            // ---- axis labels ------------------------------------------------
            if (showLabels) {
                var labG = PVX.svg.el('g', { 'class': 'pvx-radar-labels' }, svgRoot);
                for (i = 0; i < n; i++) {
                    var lp = PVX.svg.polar(cx, cy, r + font * 0.55, angleAt(i));
                    var anchor = anchorFor(lp.x, cx, r);
                    // Push the label clear of the outer ring along the radius,
                    // then let the anchor keep it from crossing the polygon.
                    var lx = lp.x + (anchor === 'start' ? 3 : (anchor === 'end' ? -3 : 0));
                    var ly = lp.y + ((lp.y - cy) / r) * font * 0.55;

                    // Budget is the real distance to the frame edge at this
                    // anchor — never a guess, so a long name cannot run off.
                    var avail;
                    if (anchor === 'start') { avail = (W - pad) - lx; }
                    else if (anchor === 'end') { avail = lx - pad; }
                    else { avail = Math.min(lx - pad, (W - pad) - lx) * 2; }

                    var lt = PVX.svg.text(labG, lx.toFixed(2), ly.toFixed(2),
                        truncate(axes[i].label, avail, font), {
                            'class': 'pvx-svg-label pvx-radar-axis-label',
                            'text-anchor': anchor,
                            'font-size': font,
                            fill: t.textMuted
                        });
                    // Estimate first (above) so this measurement almost always
                    // confirms rather than corrects — see fitTextTo.
                    fitTextTo(lt, avail);
                    PVX.svg.el('title', null, lt).textContent = axes[i].label +
                        (axes[i].units ? ' (' + axes[i].units + ')' : '');
                }
            }

            // ---- legend --------------------------------------------------
            if (showLegend) {
                drawLegend(svgRoot, W, H - pad - legendH * 0.35, cfg, t, legend, font);
            }
        }

        /** Tooltip text: the numbers a radar deliberately refuses to show. */
        function pointTip(cfg, axis, src, ser) {
            var s = axis.label + ' · ' + ser.label + '\n' +
                PVX.fmt.number(src.value, PVX.config.numberOpts(cfg)) +
                (src.units ? ' ' + src.units : '') +
                '\naxis ' + PVX.fmt.tick(axis.dom.min) + ' … ' + PVX.fmt.tick(axis.dom.max);
            if (!src.good) { s += '\nBAD QUALITY' + (src.error ? ': ' + src.error : ''); }
            if (src.path) { s += '\n' + src.path; }
            return s;
        }

        /**
         * Anchor by quadrant. A label on the right of the web must run
         * outward to the right, one on the left outward to the left, and one
         * at 12/6 o'clock is centred — otherwise labels lean back over the
         * polygon they are describing.
         */
        function anchorFor(x, cx, r) {
            var dx = x - cx;
            if (Math.abs(dx) < r * 0.20) { return 'middle'; }
            return dx > 0 ? 'start' : 'end';
        }

        function polygonPath(pts) {
            var d = '';
            for (var i = 0; i < pts.length; i++) {
                d += (i ? ' L' : 'M') + pts[i].x.toFixed(2) + ' ' + pts[i].y.toFixed(2);
            }
            return d + ' Z';
        }

        function ringPath(cx, cy, rad, n, angleAt) {
            var pts = [];
            for (var i = 0; i < n; i++) { pts.push(PVX.svg.polar(cx, cy, rad, angleAt(i))); }
            return polygonPath(pts);
        }

        /* ---------------------------------------------------------------- *
         * Legend
         * ---------------------------------------------------------------- */

        function buildLegend(cfg, model) {
            var out = [];
            var i;
            if (model.series.length > 1) {
                // Current first: it is what the operator is looking at.
                for (i = model.series.length - 1; i >= 0; i--) {
                    out.push({
                        label: model.series[i].label,
                        color: model.series[i].color,
                        dashed: model.series[i].dashed
                    });
                }
            }
            if (cfg.ColorByThreshold && cfg.UseThresholds) {
                var bands = PVX.thresholds.parse(cfg.Thresholds);
                for (i = 0; i < bands.length; i++) {
                    if (!bands[i].label) { continue; }
                    out.push({ label: bands[i].label, color: bands[i].color, dashed: false });
                }
            }
            return out;
        }

        function drawLegend(svgRoot, W, y, cfg, t, items, font) {
            var g = PVX.svg.el('g', { 'class': 'pvx-radar-legend' }, svgRoot);
            var swatch = font * 0.85;
            var gapIn = 4;      // swatch -> text
            var gapOut = 12;    // entry -> entry

            // Measure with the estimate, then drop entries that will not fit —
            // a legend that runs off the edge is worse than a shorter legend.
            var widths = [];
            var total = 0;
            var shown = 0;
            for (var i = 0; i < items.length; i++) {
                var w = swatch + gapIn + textPx(items[i].label, font);
                if (total + w + (shown ? gapOut : 0) > W - 8) { break; }
                total += w + (shown ? gapOut : 0);
                widths.push(w);
                shown += 1;
            }
            if (!shown) { return; }

            var x = (W - total) / 2;
            for (var j = 0; j < shown; j++) {
                var it = items[j];
                PVX.svg.el('rect', {
                    x: x.toFixed(2), y: (y - swatch / 2).toFixed(2),
                    width: swatch.toFixed(2), height: swatch.toFixed(2),
                    rx: 1.5,
                    fill: PVX.color.rgba(it.color, 0.35),
                    stroke: it.color,
                    'stroke-width': 1.2,
                    'stroke-dasharray': it.dashed ? '2.5 1.8' : null
                }, g);
                PVX.svg.text(g, (x + swatch + gapIn).toFixed(2), y.toFixed(2), it.label, {
                    'class': 'pvx-svg-label pvx-radar-legend-text',
                    'text-anchor': 'start',
                    'font-size': font,
                    fill: t.textMuted
                });
                x += widths[j] + gapOut;
            }
        }

        /* ---------------------------------------------------------------- *
         * States
         * ---------------------------------------------------------------- */

        function message(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);

            // Centre-anchored text spills past BOTH edges once it is wider than
            // the frame, so shrink to fit first and only then truncate. 0.62em
            // rather than 0.58em: this copy is sentence case with wide glyphs.
            var avail = Math.max(24, W - 12);
            var longest = Math.max(String(headline).length, String(detail).length);
            if (longest * font * 0.62 > avail) {
                font = PVX.util.clamp(Math.floor(avail / (longest * 0.62)), 7, font);
            }
            var fitLine = function (str, px) {
                var maxChars = Math.max(3, Math.floor(avail / (px * 0.62)));
                return str.length > maxChars ? str.slice(0, maxChars - 1) + '…' : str;
            };

            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2),
                fitLine(headline, font), {
                    'class': 'pvx-svg-label pvx-radar-msg', 'text-anchor': 'middle',
                    'font-size': font, 'font-weight': '600', fill: t.textMuted
                });
            var sub = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.8).toFixed(2),
                fitLine(detail, font * 0.85), {
                    'class': 'pvx-svg-label pvx-radar-msg', 'text-anchor': 'middle',
                    'font-size': (font * 0.85).toFixed(1), fill: t.textMuted
                });

            // At most two measurements, and only when there is nothing to
            // chart — a centred message poking out of both edges is the most
            // obviously broken thing a symbol can show.
            shrinkToFit(head, avail);
            shrinkToFit(sub, avail);
        }

        /**
         * Scale an SVG <text> down until it fits `avail`, then truncate if the
         * 6px floor still is not enough. Shrinking alone is not sufficient: a
         * long sentence in a 140px-wide symbol would need an unreadable font.
         */
        function shrinkToFit(node, avail) {
            if (!node || !node.getComputedTextLength || !(avail > 0)) { return; }
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            var w = measure();
            if (!(w > avail)) { return; }

            var size = parseFloat(node.getAttribute('font-size')) || 10;
            node.setAttribute('font-size', Math.max(6, size * (avail / w)).toFixed(1));

            w = measure();
            if (!(w > avail)) { return; }

            var str = node.textContent;
            var keep = Math.max(3, Math.floor(str.length * (avail / w)) - 1);
            node.textContent = str.slice(0, keep) + '…';
            for (var guard = 0; guard < 24 && measure() > avail && node.textContent.length > 2; guard++) {
                node.textContent = node.textContent.slice(0, -2) + '…';
            }
        }

        /** Theme tokens as CSS custom properties for the Angular chrome. */
        function applyThemeVars(c, t) {
            var nde = c.node;
            if (!nde || !nde.style || !nde.style.setProperty) { return; }
            nde.style.setProperty('--pvx-text', t.text);
            nde.style.setProperty('--pvx-muted', t.textMuted);
            nde.style.setProperty('--pvx-border', t.border);
            nde.style.setProperty('--pvx-accent', c.config.CurrentColor || c.config.AccentColor || '#3b82c4');
        }

        /* Rendering happens in a rAF, i.e. outside Angular's digest, so the
         * scope.pvx writes above need an explicit (guarded) digest. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
