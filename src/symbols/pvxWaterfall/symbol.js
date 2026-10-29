/* ============================================================================
 * pvxWaterfall — floating-bar waterfall / bridge chart for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 *
 * The question this symbol answers is "how did we get from A to B" — a mass or
 * energy balance, a yield-loss account, a production-vs-plan bridge. Each bar
 * is a step, and every step is drawn floating at the running total left behind
 * by the step before it, so the eye can follow one continuous path from the
 * start bar to the total bar.
 *
 * THE ONE INVARIANT
 *   bar i spans [runningBefore, runningBefore + delta]. Start, subtotal and
 *   total bars are grounded on the baseline instead of floating, because they
 *   report a POSITION rather than a CHANGE. A waterfall whose bars do not
 *   connect is just a bar chart, so the running total — not the raw value — is
 *   what drives every bar's extent, and the connectors are drawn from the same
 *   numbers rather than from the bar rectangles.
 *
 * TWO WAYS TO FEED IT
 *   'delta'    — each data source IS a step (losses, gains, adjustments).
 *   'absolute' — each source is a LEVEL and the steps are the differences
 *                between consecutive sources. Stage-by-stage temperatures and
 *                pressures come out of PI as levels, not as changes, and
 *                differencing them in the symbol beats asking the operator to
 *                build a dozen calculated attributes.
 *
 * COLUMN SYNC
 *   PI Vision returns Summary cells positionally, matching config.Columns, so
 *   the chosen statistic has to drive that array or the chart silently plots
 *   the wrong aggregate. That is not re-implemented here: PVX.config
 *   .statColumns / .syncStatColumns / PVX.data.statValue own it, and
 *   syncStatColumns runs both on config change and at the top of render so a
 *   display saved by an older build repairs itself on load.
 *
 * RENDERING
 *   Everything is SVG drawn into `.pvx-wf-body`; only the header/footer chrome
 *   is Angular-bound. buildModel() is pure — given rows and a config it returns
 *   the exact list of bars with their from/to extents — so the drawing code
 *   never has to make data decisions.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxWaterfall',
        displayName: 'PVX Waterfall',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        // Positional config, renumbered when a data source is removed.
        sourceRemap: { SubtotalAfter: 'steps' },
        visObjectType: symbolVis,
        // A collection repeats the symbol once per asset and rebinds each copy to
        // that asset's own attributes: one chart per unit, built once.
        // The breakdown is then of one asset's own attributes, not across assets.
        supportsCollections: true,
        configTitle: 'Format Waterfall',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                // Positional contract with PI Vision's Summary cells. Kept in
                // step with Statistic by PVX.config.syncStatColumns().
                Columns: ['Value'],
                SortColumn: 'Value',
                // The order the operator dropped the attributes in IS the order
                // of the bridge, so the server must not re-sort them.
                SortDescending: false,
                Height: 260,
                Width: 460,

                Title: '',                    // blank => generic heading

                // --- what is charted ---------------------------------
                Statistic: 'Value',           // Value|Average|Minimum|Maximum|Range|StdDev|Total
                StepMode: 'delta',            // delta | absolute

                // --- anchors -----------------------------------------
                ShowStart: true,
                StartLabel: 'Start',
                StartValue: '',               // blank: 0 (delta) / first source (absolute)
                ShowTotal: true,
                TotalLabel: 'Total',
                SubtotalAfter: '',            // comma-separated 1-based step indices

                // --- shape -------------------------------------------
                Orientation: 'vertical',      // vertical | horizontal
                BarGap: 0.3,
                MaxSteps: 24,

                // --- color ------------------------------------------
                IncreaseColor: '#2f9e5f',
                DecreaseColor: '#c8452f',
                TotalColor: '#3b82c4',
                SubtotalColor: '#6f7378',
                InvertColors: false,

                // --- connectors --------------------------------------
                ShowConnectors: true,
                ConnectorColor: '',           // blank => theme line color

                // --- labels ------------------------------------------
                ShowValues: true,
                ValuePosition: 'outside',     // outside | inside | none
                ShowPercentOfStart: false,
                LabelAngle: 0,                // 0 | -45 | -90

                // --- axes --------------------------------------------
                ShowAxis: true,
                ShowGrid: true,
                TickCount: 5,
                BaselineAtZero: true
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
            showHeader: true
        };

        var rows = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-wf-body',

            onData: function (d) {
                // Parse against the column the chosen statistic asks for.
                // Immediately after a statistic change the in-flight payload may
                // still carry the previous aggregate; PVX.data.statValue falls
                // back to the row value so the bridge keeps drawing something
                // sane for the one refresh that takes.
                rows = PVX.data.rows(d, PVX.config.statColumns(scope.config)) || [];
            },

            onConfigChange: function (newCfg) {
                // The statistic decides which aggregate PI Vision computes, so
                // the request has to be updated before the next fetch.
                PVX.config.syncStatColumns(newCfg || scope.config);
            },

            render: render
        });

        /* ================================================================ *
         * Small helpers
         * ================================================================ */

        function intOr(v, fallback) {
            var n = parseInt(v, 10);
            return isFinite(n) ? n : fallback;
        }

        function numOr(v, fallback) {
            var n = PVX.util.num(v);
            return n === null ? fallback : n;
        }

        /**
         * "2, 4" -> {2:true, 4:true}. 1-based because the config pane talks
         * about "after step 2", and operators do not count from zero.
         */
        function parseIndices(spec, maxN) {
            var map = {};
            if (spec === null || spec === undefined || spec === '') { return map; }
            var parts = String(spec).split(/[^0-9-]+/);
            for (var i = 0; i < parts.length; i++) {
                var n = parseInt(parts[i], 10);
                if (isFinite(n) && n >= 1 && n <= maxN) { map[n] = true; }
            }
            return map;
        }

        /* ================================================================ *
         * Pure model — no DOM, no drawing decisions
         * ================================================================ */

        /**
         * rows + config -> the exact list of bars to draw.
         *
         * @returns {Object} {bars, start, end, steps, sources, floorFrom,
         *                    notes[], badCount, empty, notEnough, allZero}
         *   Each bar: {kind, label, level, from, to, delta, carry, grounded,
         *              good, units, path, error}
         *   `carry` is the running total AFTER the bar — the height a connector
         *   leaving that bar sits at. Deriving connectors from `carry` rather
         *   than from the drawn rectangle is what guarantees they meet the bars.
         */
        function buildModel(cfg) {
            var i;
            var srcs = [];
            var skipped = 0;
            var badCount = 0;

            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                var v = PVX.data.statValue(r, cfg);
                if (v === null || v === undefined) { skipped += 1; continue; }
                if (!r.good) { badCount += 1; }
                srcs.push({
                    label: r.label || ('Row ' + (i + 1)),
                    units: r.units || '',
                    path: r.path || '',
                    good: r.good !== false,
                    error: r.errorDescription || '',
                    value: v
                });
            }

            var absolute = cfg.StepMode === 'absolute';
            // Blank is meaningful (it means "infer the start"), so an empty
            // string must not collapse to zero — PVX.util.num returns null.
            var startCfg = PVX.util.num(cfg.StartValue);

            // Beyond the cap the bars are sub-pixel and the running total is no
            // longer readable as a path. Absolute mode consumes one extra source
            // for the implied start level, so it is allowed one more.
            var maxSteps = PVX.util.clamp(intOr(cfg.MaxSteps, 24), 1, 200);
            var maxSrc = (absolute && startCfg === null) ? maxSteps + 1 : maxSteps;
            var hidden = 0;
            if (srcs.length > maxSrc) {
                hidden = srcs.length - maxSrc;
                srcs = srcs.slice(0, maxSrc);
            }

            var steps = [];
            var start = 0;
            var notEnough = false;

            if (absolute) {
                if (startCfg !== null) {
                    // An explicit start turns the FIRST source into a step too:
                    // the change from the stated starting level to level 1.
                    start = startCfg;
                    for (i = 0; i < srcs.length; i++) {
                        steps.push({
                            src: srcs[i],
                            delta: srcs[i].value - (i === 0 ? start : srcs[i - 1].value)
                        });
                    }
                } else if (srcs.length >= 2) {
                    start = srcs[0].value;
                    for (i = 1; i < srcs.length; i++) {
                        steps.push({ src: srcs[i], delta: srcs[i].value - srcs[i - 1].value });
                    }
                } else {
                    // One level is a position, not a journey. Say so rather than
                    // drawing a single bar that looks like a complete bridge.
                    notEnough = srcs.length > 0;
                }
            } else {
                start = startCfg === null ? 0 : startCfg;
                for (i = 0; i < srcs.length; i++) {
                    steps.push({ src: srcs[i], delta: srcs[i].value });
                }
            }

            var subs = parseIndices(cfg.SubtotalAfter, steps.length);
            var startLabel = PVX.util.def(cfg.StartLabel, 'Start');
            var totalLabel = PVX.util.def(cfg.TotalLabel, 'Total');

            // How many subtotals will actually be drawn, so they can be numbered
            // only when numbering them tells the reader something.
            var subTotal = 0;
            for (i = 1; i <= steps.length; i++) {
                if (subs[i] && !(i === steps.length && cfg.ShowTotal !== false)) { subTotal += 1; }
            }

            var bars = [];
            var running = start;
            var allZero = steps.length > 0;
            var subSeen = 0;

            if (cfg.ShowStart !== false && steps.length) {
                bars.push({
                    kind: 'start', label: startLabel, level: start, delta: null,
                    carry: start, grounded: true, good: true, units: '', path: '', error: ''
                });
            }

            for (i = 0; i < steps.length; i++) {
                var before = running;
                running += steps[i].delta;
                if (steps[i].delta !== 0) { allZero = false; }
                bars.push({
                    kind: 'step',
                    label: steps[i].src.label,
                    level: running,
                    delta: steps[i].delta,
                    from: before,
                    to: running,
                    carry: running,
                    grounded: false,
                    good: steps[i].src.good,
                    units: steps[i].src.units,
                    path: steps[i].src.path,
                    error: steps[i].src.error
                });

                // A subtotal after the LAST step is the total bar under another
                // name; drawing both puts two identical bars side by side.
                if (subs[i + 1] && !(i === steps.length - 1 && cfg.ShowTotal !== false)) {
                    subSeen += 1;
                    bars.push({
                        kind: 'subtotal',
                        label: subTotal > 1 ? ('Subtotal ' + subSeen) : 'Subtotal',
                        level: running, delta: null, carry: running, grounded: true,
                        good: true, units: '', path: '', error: ''
                    });
                }
            }

            if (cfg.ShowTotal !== false && steps.length) {
                bars.push({
                    kind: 'total', label: totalLabel, level: running, delta: null,
                    carry: running, grounded: true, good: true, units: '', path: '', error: ''
                });
            }

            /* ---- notes -------------------------------------------------- */
            var notes = [];
            if (skipped) {
                notes.push(skipped + (skipped === 1 ? ' source has no ' : ' sources have no ') +
                    PVX.config.statLabel(cfg).toLowerCase());
            }
            if (hidden) { notes.push('+' + hidden + ' more not shown'); }
            if (allZero) { notes.push('Every step is zero'); }
            if (cfg.ShowPercentOfStart && start === 0) {
                notes.push('% of start hidden: start is zero');
            }
            // The "axis clipped" warning is NOT raised here: whether turning
            // BaselineAtZero off actually moved the baseline depends on where
            // the nice domain lands, which is a drawing decision. drawChart adds
            // it only when the baseline really left zero.

            return {
                bars: bars,
                steps: steps.length,
                sources: rows.length,
                start: start,
                end: running,
                absolute: absolute,
                notes: notes,
                badCount: badCount,
                skipped: skipped,
                allZero: allZero,
                notEnough: notEnough,
                empty: bars.length === 0
            };
        }

        /* ================================================================ *
         * Color
         * ================================================================ */

        function barColor(bar, cfg) {
            if (bar.kind === 'start' || bar.kind === 'total') {
                return cfg.TotalColor || '#3b82c4';
            }
            var neutral = cfg.SubtotalColor || '#6f7378';
            if (bar.kind === 'subtotal') { return neutral; }

            var inc = cfg.IncreaseColor || '#2f9e5f';
            var dec = cfg.DecreaseColor || '#c8452f';
            // Loss accounting inverts the moral of the story: a decrease in
            // scrap is the good outcome, so the sign-to-color mapping has to be
            // configurable rather than baked in.
            if (cfg.InvertColors) { var swap = inc; inc = dec; dec = swap; }

            if (bar.delta > 0) { return inc; }
            if (bar.delta < 0) { return dec; }
            // Exactly no change is neither good nor bad; painting it green would
            // claim an improvement that did not happen.
            return neutral;
        }

        /**
         * Hatched fill for bad quality. Operators must be able to see at a
         * glance that a step's size is not trustworthy — and in a waterfall one
         * untrustworthy step moves every bar after it, so this matters more here
         * than in a plain bar chart. One pattern per color per render; ids are
         * unique so several instances on one display cannot collide.
         */
        function hatchFor(defs, cache, fill) {
            if (cache[fill]) { return cache[fill]; }
            var id = PVX.util.uid('pvxwfhatch');
            var p = PVX.svg.el('pattern', {
                id: id, width: 6, height: 6,
                patternUnits: 'userSpaceOnUse',
                patternTransform: 'rotate(45)'
            }, defs);
            PVX.svg.el('rect', { x: 0, y: 0, width: 6, height: 6, fill: fill, 'fill-opacity': 0.22 }, p);
            PVX.svg.el('rect', { x: 0, y: 0, width: 3, height: 6, fill: fill, 'fill-opacity': 0.9 }, p);
            cache[fill] = 'url(#' + id + ')';
            return cache[fill];
        }

        /* ================================================================ *
         * Text
         * ================================================================ */

        /**
         * Approximate rendered width, used only for reserving MARGINS. Exact
         * measurement is used where a label is actually placed (see fitTextTo
         * and drawValue); doing it here too would mean laying out the whole
         * chart twice on every resize frame.
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
         * fits `maxPx`, re-adding the ellipsis.
         *
         * Category names are anchored against a frame edge, so a glyph-width
         * estimate that runs narrow (mixed-case proper nouns — "Feedwater Pump
         * B" — average well above 0.58em) pushes the string off-canvas, where
         * the host's overflow:hidden chops it instead of ellipsising. No clamp
         * saves it after the fact: the text has to be short enough. The caller
         * passes text already cut by the estimate, so the common case measures
         * once and returns.
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

        /**
         * The label for one bar.
         *
         * A step's value is a CHANGE and a total's value is a POSITION, so they
         * are formatted differently on purpose: "+12.4" versus "148". Showing a
         * step's running total instead of its delta is the single easiest way to
         * make a waterfall unreadable.
         */
        function barValueText(bar, cfg, model) {
            var opts = PVX.config.numberOpts(cfg);
            var mag = bar.kind === 'step' ? bar.delta : bar.level;
            var s = PVX.fmt.number(mag, opts);
            if (bar.kind === 'step' && bar.delta > 0) { s = '+' + s; }

            var base = Math.abs(model.start);
            if (cfg.ShowPercentOfStart && base > 0) {
                s += ' (' + PVX.fmt.number((mag / base) * 100, { decimals: 0 }) + '%)';
            }
            return s;
        }

        /* ================================================================ *
         * Render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            // Self-heal a config saved before the statistic existed, or edited
            // by hand. Only writes when something differs, so this cannot loop
            // with PI Vision's own change detection.
            PVX.config.syncStatColumns(cfg);

            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            var W = Math.max(40, c.width);
            var H = Math.max(30, c.height);

            var svgRoot = host.querySelector('svg.pvx-wf-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-wf-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var model = buildModel(cfg);

            /* ---- chrome ------------------------------------------------- */
            // The header is chrome, not data: on a tile this short it would take
            // the space the bridge needs, so it is dropped rather than shrunk.
            scope.pvx.showHeader = H >= 112 && W >= 150;
            scope.pvx.title = cfg.Title || 'Waterfall';
            scope.pvx.subtitle = H >= 140
                ? PVX.config.statLabel(cfg) + commonUnitsSuffix(cfg, model)
                : '';
            scope.pvx.note = model.notes.join(' · ');
            scope.pvx.count = model.steps
                ? (model.steps + (model.steps === 1 ? ' step' : ' steps') +
                   (model.steps < model.sources ? ' of ' + model.sources : ''))
                : '';
            scope.pvx.error = model.badCount
                ? (model.badCount + (model.badCount === 1 ? ' source reports' : ' sources report') + ' bad quality')
                : '';

            if (model.empty) {
                var headline, detail;
                if (model.notEnough) {
                    headline = 'Not enough levels';
                    detail = 'Absolute mode needs two sources, or a start value.';
                } else if (rows.length) {
                    headline = 'No ' + PVX.config.statLabel(cfg).toLowerCase() + ' values';
                    detail = 'All ' + rows.length + ' sources returned an empty cell.';
                } else {
                    headline = 'No data sources';
                    detail = 'Drop one or more attributes onto this symbol.';
                }
                emptyState(svgRoot, W, H, t, headline, detail);
                digest();
                return;
            }

            drawChart(svgRoot, W, H, cfg, t, model);
            digest();
        }

        /** Units are only meaningful in the header when every source agrees. */
        function commonUnitsSuffix(cfg, model) {
            if (!cfg.ShowUnits) { return ''; }
            var u = null;
            for (var i = 0; i < model.bars.length; i++) {
                if (model.bars[i].kind !== 'step') { continue; }
                var iu = model.bars[i].units || '';
                if (u === null) { u = iu; }
                else if (u !== iu) { return ''; }
            }
            return u ? ' · ' + u : '';
        }

        function drawChart(svgRoot, W, H, cfg, t, model) {
            var i;
            var bars = model.bars;
            var n = bars.length;
            var vertical = cfg.Orientation !== 'horizontal';
            var defs = PVX.svg.el('defs', null, svgRoot);
            var hatchCache = {};

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var pad = 5;

            // Below these sizes there is no room for decoration; the bars and
            // their shape are the payload, everything else is commentary.
            var tiny = W < 200 || H < 140;
            var micro = W < 140 || H < 100;
            var showValues = cfg.ShowValues !== false &&
                             (cfg.ValuePosition || 'outside') !== 'none' && !tiny;
            var showTicks = cfg.ShowAxis !== false && !micro;
            var valuePos = (cfg.ValuePosition === 'inside') ? 'inside' : 'outside';

            /* ---- value domain ------------------------------------------- */
            // Grounded bars contribute only their level here. Whether they are
            // grounded at zero or at the axis floor is decided AFTER the domain
            // is known, so BaselineAtZero=false is free to clip the axis.
            var lo = null, hi = null;
            var see = function (v) {
                if (v === null || !isFinite(v)) { return; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            };
            for (i = 0; i < n; i++) {
                if (bars[i].grounded) { see(bars[i].level); }
                else { see(bars[i].from); see(bars[i].to); }
            }
            if (cfg.BaselineAtZero !== false) { see(0); }
            if (lo === null) { lo = 0; hi = 1; }
            if (lo === hi) { hi = lo + (Math.abs(lo) * 0.1 || 1); }

            var tickCount = PVX.util.clamp(intOr(cfg.TickCount, 5), 2, 12);
            var dom = PVX.scale.niceDomain(lo, hi, tickCount);
            var ticks = (cfg.ShowGrid !== false || showTicks)
                ? PVX.scale.ticks(dom[0], dom[1], tickCount) : [];

            // Where a grounded bar starts. With the baseline at zero this is the
            // real zero line; with the axis clipped to the data it is the bottom
            // of the frame, which is honest about the bar being cut off.
            var floorValue = cfg.BaselineAtZero !== false ? 0 : dom[0];
            if (floorValue !== 0) {
                // Said out loud because a bar standing on a non-zero floor no
                // longer has a length proportional to its value, and nothing
                // else on the chart admits that. render() digests after this.
                scope.pvx.note = (scope.pvx.note ? scope.pvx.note + ' · ' : '') +
                    'Bars start at ' + PVX.fmt.tick(floorValue) + ', not zero';
            }
            for (i = 0; i < n; i++) {
                if (bars[i].grounded) {
                    bars[i].from = floorValue;
                    bars[i].to = bars[i].level;
                }
            }

            /* ---- label sizing (estimates, for margins only) -------------- */
            var labels = [];
            var maxValuePx = 0;
            for (i = 0; i < n; i++) {
                labels.push(showValues ? barValueText(bars[i], cfg, model) : '');
                maxValuePx = Math.max(maxValuePx, textPx(labels[i], font));
            }
            var maxTickPx = 0;
            for (i = 0; showTicks && i < ticks.length; i++) {
                maxTickPx = Math.max(maxTickPx, textPx(PVX.fmt.tick(ticks[i]), font));
            }

            // Vertical value labels sit centred over their own bar, so once a
            // label is wider than a category slot every one of them collides
            // with its neighbours. Overlapping numbers are not a degraded
            // reading of the data, they are an unreadable one — dropping them
            // leaves the bar shape, which is still true. Estimated from the slot
            // the chart is about to get, so the decision is made before the
            // margins reserve room for labels that will not be drawn.
            if (showValues) {
                var provSlot = vertical
                    ? (W - pad * 2 - (showTicks ? maxTickPx + 6 : 0)) / n
                    : (H - pad * 2 - (showTicks ? font * 1.9 : 0)) / n;
                // Horizontal labels stack one per row, so there the limiting
                // dimension is the row height rather than the label width.
                if (provSlot < (vertical ? maxValuePx : font * 1.6)) { showValues = false; }
            }

            /* ---- plot box ------------------------------------------------ */
            var mLeft = pad, mRight = pad, mTop = pad, mBottom = pad;
            var nameW = 0;
            var angle = 0;
            var showNames = true;

            if (vertical) {
                if (showTicks) { mLeft += maxTickPx + 6; }
                if (showValues) { mTop += font * 1.6; }
                if (showValues) { mBottom += font * 0.8; }   // room under falling steps
            } else {
                // Reserve the name column only if the rows are tall enough to
                // put a legible name in it; otherwise a third of the width goes
                // to an empty gutter. (The vertical branch makes the equivalent
                // call below, once the slot width is known.)
                showNames = ((H - pad * 2 - (showTicks ? font * 1.9 : 0)) / n) >= font * 1.05;
                if (showNames) {
                    nameW = PVX.util.clamp(W * 0.28, 24, W * 0.5);
                    mLeft += nameW + 6;
                }
                if (showTicks) { mBottom += font * 1.9; }
                // A value label sits past the end of the longest bar; capping the
                // reservation stops one long number from squeezing the bars flat.
                if (showValues) { mRight += Math.min(maxValuePx + 8, W * 0.3); }
            }

            var plot = { x0: mLeft, y0: mTop, x1: W - mRight, y1: H - mBottom };

            if (vertical) {
                // The category band's height depends on whether names fit
                // upright, which depends on the slot width — so it is resolved
                // after the horizontal margins but before the vertical ones.
                var slotW = (plot.x1 - plot.x0) / Math.max(1, n);
                angle = intOr(cfg.LabelAngle, 0);
                if (angle !== -45 && angle !== -90) { angle = 0; }
                // Auto-rotate rather than silently dropping every other name.
                if (angle === 0 && slotW < font * 4.2) { angle = -45; }

                // A rotated name needs about four characters before it says
                // anything at all; below that the band is spent on a row of
                // ellipses that also interleave with their neighbours. The bar
                // shape is the honest payload on a tile this small, so the names
                // go rather than the chart.
                showNames = slotW >= font * 2.4;

                var band = !showNames ? 0
                    : (angle === 0 ? font * 1.9 : (angle === -45 ? font * 4.0 : font * 5.2));
                band = Math.min(band, Math.max(0, (H - plot.y0 - pad) * 0.45));
                mBottom += band;
                plot.y1 = H - mBottom;
            }

            // Degenerate boxes (tiny symbol, huge labels): give the chart the
            // whole frame rather than drawing nothing at all.
            if (plot.x1 - plot.x0 < 16) {
                plot.x0 = pad; plot.x1 = W - pad;
                // The name column is what was reclaimed, so it cannot be used.
                nameW = 0;
                if (!vertical) { showNames = false; }
            }
            if (plot.y1 - plot.y0 < 16) { plot.y0 = pad; plot.y1 = H - pad; }

            var plotW = plot.x1 - plot.x0;
            var plotH = plot.y1 - plot.y0;

            /* ---- scales --------------------------------------------------- */
            var vs = vertical
                ? PVX.scale.linear(dom[0], dom[1], plot.y1, plot.y0)
                : PVX.scale.linear(dom[0], dom[1], plot.x0, plot.x1);

            var catStart = vertical ? plot.x0 : plot.y0;
            var catSpan = vertical ? plotW : plotH;
            var slot = catSpan / n;
            var gap = PVX.util.clamp(numOr(cfg.BarGap, 0.3), 0, 0.9);
            // A two-bar bridge would otherwise produce slabs as wide as the
            // symbol, which read as background blocks rather than bars.
            var thick = Math.max(1, Math.min(slot * (1 - gap), Math.max(20, catSpan * 0.3)));
            var center = function (idx) { return catStart + slot * (idx + 0.5); };

            var radius = PVX.util.clamp(numOr(cfg.CornerRadius, 0), 0, Math.min(3, thick / 4));

            /* ---- grid ------------------------------------------------------ */
            var g, tp;
            if (cfg.ShowGrid !== false) {
                g = PVX.svg.el('g', { 'class': 'pvx-wf-grid pvx-grid-line', stroke: t.grid }, svgRoot);
                for (i = 0; i < ticks.length; i++) {
                    tp = vs(ticks[i]);
                    PVX.svg.el('line', vertical
                        ? { x1: plot.x0.toFixed(2), y1: tp.toFixed(2), x2: plot.x1.toFixed(2), y2: tp.toFixed(2) }
                        : { x1: tp.toFixed(2), y1: plot.y0.toFixed(2), x2: tp.toFixed(2), y2: plot.y1.toFixed(2) },
                        g);
                }
            }

            // The baseline is where the grounded bars stand. Drawn only when it
            // is inside the domain — with a clipped axis it is off-frame.
            if (floorValue >= dom[0] && floorValue <= dom[1]) {
                var bp = vs(floorValue);
                PVX.svg.el('line', vertical
                    ? { x1: plot.x0.toFixed(2), y1: bp.toFixed(2), x2: plot.x1.toFixed(2), y2: bp.toFixed(2) }
                    : { x1: bp.toFixed(2), y1: plot.y0.toFixed(2), x2: bp.toFixed(2), y2: plot.y1.toFixed(2) },
                    svgRoot).setAttribute('stroke', t.axis);
            }

            /* ---- connectors (BEHIND the bars) ------------------------------ */
            // Drawn across the full width of both bars they join, then covered
            // by the bars themselves, so only the gap segment shows and the line
            // can never fall short of either rectangle.
            if (cfg.ShowConnectors !== false && n > 1) {
                // The theme grid color is reference furniture at 8% alpha; a
                // connector is load-bearing — it is the visual proof that the
                // running total carried across — so the blank default takes the
                // theme's line color instead of its grid color.
                var connColor = cfg.ConnectorColor || t.axis;
                var connG = PVX.svg.el('g', {
                    'class': 'pvx-wf-connectors',
                    stroke: connColor, 'stroke-width': 1, fill: 'none'
                }, svgRoot);
                for (i = 0; i < n - 1; i++) {
                    var cv = vs(bars[i].carry);
                    var a0 = center(i) - thick / 2;
                    var a1 = center(i + 1) + thick / 2;
                    PVX.svg.el('line', vertical
                        ? { x1: a0.toFixed(2), y1: cv.toFixed(2), x2: a1.toFixed(2), y2: cv.toFixed(2) }
                        : { x1: cv.toFixed(2), y1: a0.toFixed(2), x2: cv.toFixed(2), y2: a1.toFixed(2) },
                        connG);
                }
            }

            /* ---- bars ------------------------------------------------------ */
            var barsG = PVX.svg.el('g', { 'class': 'pvx-wf-bars' }, svgRoot);
            var geo = [];
            for (i = 0; i < n; i++) {
                var bar = bars[i];
                var p0 = vs(bar.from);
                var p1 = vs(bar.to);
                var col = barColor(bar, cfg);
                var fill = bar.good ? col : hatchFor(defs, hatchCache, col);
                var cc = center(i);

                var x, y, w, h;
                if (vertical) {
                    y = Math.min(p0, p1);
                    // Keep a hairline for a zero step so the category still has a
                    // visible anchor above its name.
                    h = Math.max(1, Math.abs(p1 - p0));
                    x = cc - thick / 2;
                    w = thick;
                } else {
                    x = Math.min(p0, p1);
                    w = Math.max(1, Math.abs(p1 - p0));
                    y = cc - thick / 2;
                    h = thick;
                }
                geo.push({ x: x, y: y, w: w, h: h, color: col });

                var grp = PVX.svg.el('g', { 'class': 'pvx-wf-bar pvx-wf-' + bar.kind }, barsG);
                PVX.svg.el('rect', {
                    x: x.toFixed(2), y: y.toFixed(2),
                    width: w.toFixed(2), height: h.toFixed(2),
                    rx: radius ? radius.toFixed(1) : null,
                    fill: fill,
                    stroke: bar.good ? 'none' : col,
                    'stroke-width': bar.good ? null : 0.8
                }, grp);

                // The tooltip is the source of truth; the drawn label is a
                // display compromise. Steps report the change AND where it left
                // the running total, because both are questions people ask.
                var tip = PVX.svg.el('title', null, grp);
                tip.textContent = bar.label + ' — ' +
                    (bar.kind === 'step'
                        ? (bar.delta > 0 ? '+' : '') + PVX.fmt.number(bar.delta, PVX.config.numberOpts(cfg)) +
                          (bar.units ? ' ' + bar.units : '') +
                          ' → ' + PVX.fmt.number(bar.carry, PVX.config.numberOpts(cfg))
                        : PVX.fmt.number(bar.level, PVX.config.numberOpts(cfg))) +
                    (bar.good ? '' : ' · BAD QUALITY' + (bar.error ? ': ' + bar.error : '')) +
                    (bar.path ? '\n' + bar.path : '');
            }

            /* ---- value labels ---------------------------------------------- */
            if (showValues) {
                var valG = PVX.svg.el('g', { 'class': 'pvx-wf-values' }, svgRoot);
                var labelLo = vertical ? 1 : plot.x0 + 2;
                var labelHi = vertical ? (showNames ? plot.y1 : H - 1) : W - 2;
                for (i = 0; i < n; i++) {
                    if (!labels[i]) { continue; }
                    var gi = geo[i];
                    var bi = bars[i];
                    drawValue(valG, {
                        text: labels[i],
                        font: font,
                        vertical: vertical,
                        pos: valuePos,
                        // Which way the bar grew, so the label lands on the free
                        // side rather than on top of the bar it describes.
                        up: (bi.kind === 'step' ? bi.delta >= 0 : bi.level >= floorValue),
                        x: gi.x, y: gi.y, w: gi.w, h: gi.h,
                        fillOn: gi.color, textFill: t.text,
                        W: W, H: H,
                        // How far an OUTSIDE label may reach. Not the frame:
                        // the category names occupy the band under (or the
                        // column left of) the plot, and a value label dropped
                        // into it lands on top of a name. The margin on the
                        // other side was reserved for exactly this label, so
                        // there the frame edge is the real limit.
                        loLimit: labelLo,
                        hiLimit: labelHi
                    });
                }
            }

            /* ---- category names -------------------------------------------- */
            var namesG = PVX.svg.el('g', { 'class': 'pvx-wf-names' }, svgRoot);
            for (i = 0; showNames && i < n; i++) {
                var name = bars[i].label;
                var nc = center(i);
                var nt;
                if (vertical) {
                    if (slot < font * 0.75) { break; }
                    var ny = plot.y1 + font * 1.15;
                    if (ny > H - 1) { break; }
                    if (angle === 0) {
                        nt = PVX.svg.text(namesG, nc.toFixed(2), ny.toFixed(2),
                            truncate(name, slot * 1.05, font), {
                                'class': 'pvx-svg-label pvx-wf-name',
                                'text-anchor': 'middle', 'font-size': font, fill: t.textMuted
                            });
                        fitTextTo(nt, slot * 1.05);
                    } else {
                        // Rotated text runs down-left from its anchor, so its
                        // length is bounded by the room below the plot AND the
                        // room to the left frame edge. getComputedTextLength()
                        // measures along the rotated baseline, which is exactly
                        // that budget.
                        var availV = H - ny - 2;
                        var availX = nc - 2;
                        var budget = angle === -90
                            ? Math.max(0, availV)
                            : Math.max(0, Math.min(availV, availX)) * 1.414;
                        nt = PVX.svg.text(namesG, 0, 0, truncate(name, budget, font), {
                            'class': 'pvx-svg-label pvx-wf-name',
                            'text-anchor': 'end', 'font-size': font, fill: t.textMuted,
                            transform: 'translate(' + nc.toFixed(2) + ',' + ny.toFixed(2) +
                                       ') rotate(' + angle + ')'
                        });
                        fitTextTo(nt, budget);
                    }
                } else {
                    if (slot < font * 1.05) { break; }
                    // Budget is the name column, but never more than the room
                    // between the anchor and the frame edge.
                    var avail = Math.min(nameW - 4, plot.x0 - 7);
                    nt = PVX.svg.text(namesG, (plot.x0 - 6).toFixed(2), nc.toFixed(2),
                        truncate(name, avail, font), {
                            'class': 'pvx-svg-label pvx-wf-name',
                            'text-anchor': 'end', 'font-size': font, fill: t.textMuted
                        });
                    fitTextTo(nt, avail);
                }
                if (nt) { PVX.svg.el('title', null, nt).textContent = name; }
            }

            /* ---- value axis ticks ------------------------------------------- */
            if (showTicks) {
                var axisG = PVX.svg.el('g', { 'class': 'pvx-wf-axis' }, svgRoot);
                for (i = 0; i < ticks.length; i++) {
                    var q = vs(ticks[i]);
                    if (vertical) {
                        PVX.svg.text(axisG, (plot.x0 - 5).toFixed(2), q.toFixed(2),
                            PVX.fmt.tick(ticks[i]), {
                                'class': 'pvx-svg-label', 'text-anchor': 'end',
                                'font-size': font, fill: t.textMuted
                            });
                    } else {
                        PVX.svg.text(axisG, q.toFixed(2), (plot.y1 + font * 1.1).toFixed(2),
                            PVX.fmt.tick(ticks[i]), {
                                'class': 'pvx-svg-label', 'text-anchor': 'middle',
                                'font-size': font, fill: t.textMuted
                            });
                    }
                }
            }
        }

        /**
         * Place one value label.
         *
         * 'outside' is the readable default, but a bar that ends near the frame
         * would push its label off-canvas — silent data loss for whoever is
         * reading the display — so those flip to inside. The decision is made
         * from getComputedTextLength(), not from a glyph-width estimate: this
         * library has already been bitten by estimates that ran narrow on
         * proportional fonts, and being a few pixels out here is the difference
         * between a legible number and a clipped one. Inside is refused when the
         * bar is too small to hold the text, because a clipped number is worse
         * than a number that moved.
         */
        function drawValue(parent, o) {
            var node = PVX.svg.text(parent, 0, 0, o.text, {
                'class': 'pvx-svg-value pvx-num pvx-wf-value',
                'text-anchor': 'middle',
                'font-size': o.font,
                fill: o.textFill
            });

            var len;
            try { len = node.getComputedTextLength(); }
            catch (e) { len = textPx(o.text, o.font); }
            if (!(len > 0)) { len = textPx(o.text, o.font); }

            var inside, x, y;

            if (o.vertical) {
                var yOut = o.up ? o.y - o.font * 0.72 : o.y + o.h + o.font * 0.78;
                var fitsOut = o.up
                    ? (yOut - o.font * 0.55 >= o.loLimit)
                    : (yOut + o.font * 0.55 <= o.hiLimit);
                inside = (o.pos === 'inside') || !fitsOut;
                if (inside && o.h < o.font * 1.7) { inside = false; }

                if (inside) {
                    y = o.up ? o.y + o.font * 0.95 : o.y + o.h - o.font * 0.95;
                    node.setAttribute('fill', PVX.color.readable(o.fillOn));
                } else {
                    y = PVX.util.clamp(yOut,
                        o.loLimit + o.font * 0.55,
                        Math.max(o.loLimit + o.font * 0.55, o.hiLimit - o.font * 0.55));
                }

                // Centred text spills past BOTH edges once it is wider than the
                // frame; when it cannot fit at all, centring it at least keeps
                // the middle digits visible.
                var cx = o.x + o.w / 2;
                x = (len > o.W - 6)
                    ? o.W / 2
                    : PVX.util.clamp(cx, 2 + len / 2, o.W - 2 - len / 2);
                node.setAttribute('x', x.toFixed(2));
                node.setAttribute('y', y.toFixed(2));
                return;
            }

            var endX = o.up ? o.x + o.w : o.x;
            var xOut = o.up ? endX + 4 : endX - 4;
            var anchor = o.up ? 'start' : 'end';
            var fitsH = o.up ? (xOut + len <= o.hiLimit) : (xOut - len >= o.loLimit);
            inside = (o.pos === 'inside') || !fitsH;
            if (inside && o.w < len + 8) { inside = false; }

            if (inside) {
                x = o.up ? endX - 4 : endX + 4;
                anchor = o.up ? 'end' : 'start';
                node.setAttribute('fill', PVX.color.readable(o.fillOn));
            } else {
                x = xOut;
                if (o.up && x + len > o.hiLimit) { x = Math.max(o.loLimit, o.hiLimit - len); }
                if (!o.up && x - len < o.loLimit) { x = Math.min(o.hiLimit, o.loLimit + len); }
            }
            node.setAttribute('x', x.toFixed(2));
            node.setAttribute('y', (o.y + o.h / 2).toFixed(2));
            node.setAttribute('text-anchor', anchor);
        }

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);

            // 0.62em rather than the 0.58em used for tick labels: this copy is
            // sentence case with wide glyphs, and a centred line that guesses
            // narrow overshoots on both sides at once.
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
                    'class': 'pvx-svg-label pvx-wf-emptymsg', 'text-anchor': 'middle',
                    'font-size': font, 'font-weight': '600', fill: t.textMuted
                });
            var sub = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.8).toFixed(2),
                fitLine(detail, font * 0.85), {
                    'class': 'pvx-svg-label pvx-wf-emptymsg', 'text-anchor': 'middle',
                    'font-size': (font * 0.85).toFixed(1), fill: t.textMuted
                });

            // Exact measurement is affordable here — it runs at most twice, only
            // when there is nothing to chart — and a centred message poking out
            // of both edges is the most obviously broken thing a symbol can show.
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

        /** Theme tokens as CSS custom properties for the Angular-rendered chrome. */
        function applyThemeVars(c, t) {
            var nde = c.node;
            if (!nde || !nde.style || !nde.style.setProperty) { return; }
            nde.style.setProperty('--pvx-text', t.text);
            nde.style.setProperty('--pvx-muted', t.textMuted);
            nde.style.setProperty('--pvx-border', t.border);
            nde.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
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
