/* ============================================================================
 * pvxComboChart — mixed-geometry, dual-axis chart for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources)
 *
 * PI Vision's native trend draws every trace the same way on one scale, so the
 * moment a question spans two units — "did efficiency hold while we pushed
 * production?" — the answer moves to Excel. This symbol keeps it on the
 * display: production as bars, efficiency as a line on a right-hand axis, the
 * operating limit as a shaded band, run/stop as a stepped strip, one frame,
 * one time axis, one glance.
 *
 * THE CENTRAL DESIGN PROBLEM is configuration. PI Vision hands a symbol an
 * ORDERED LIST of data sources and nothing else — no names we can rely on, no
 * stable ids. So the per-trace grammar is index-based and lives in a single
 * string, exactly like the shared threshold grammar, which means it round-trips
 * through the PI Vision display database and can be typed in one text box:
 *
 *     TraceSpec: "1:bar, 2:line:right, 3:area, 4:step:right:#8267b0"
 *
 * A line, step or area outline can also be `dashed` or `dotted` and carry a
 * width such as `1px`: a plan drawn as a thin dashed line beside the actual
 * is the convention high-performance HMI guides use, and colour alone cannot
 * carry that distinction for a colour-blind operator.
 *
 * Anything not mentioned falls back to DefaultType on the left axis, so the
 * symbol is useful the second it lands on a display and only needs editing when
 * the engineer wants something specific.
 *
 * Limit bands are deliberately NOT a trace type. A limit is a property of the
 * axis, not of a data source: it does not consume a data source, it does not
 * belong in the legend, and it must survive the trace it was drawn for being
 * deleted. So it reuses the threshold grammar against the LEFT axis instead.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* The complete trace vocabulary. Kept as a lookup rather than an array so
     * the parser can classify a token in one step without a linear scan. */
    var TRACE_TYPES = {
        line: 1, area: 1, bar: 1, step: 1, scatter: 1, hidden: 1
    };

    /* Mean advance width of the UI font in ems. Every margin in this symbol is
     * derived from it rather than from getComputedTextLength(), which forces a
     * layout flush per call — on a wall board refreshing every few seconds that
     * is the difference between a smooth display and a stuttering one. */
    var CHAR_W = 0.58;

    /* Bar slot geometry, kept in one place so the decimation maths and the
     * drawing maths can never drift apart.
     *
     * SLOT_INNER_FRAC is the share of a time slot the bars may occupy; the
     * remainder is the gap that separates one slot from the next.
     * GROUP_BAR_FRAC is the share of its own column a single bar takes when
     * several bar traces are grouped inside one slot, and SOLO_BAR_FRAC the
     * same for a lone bar (or a lone stack) that owns the slot outright.
     *
     * Together they let the slot count be SOLVED for a target bar width rather
     * than guessed at: a slot has to be
     *     MinBarWidth * columns / (SLOT_INNER_FRAC * barFrac)
     * pixels wide for every bar inside it to clear both gaps and still reach
     * MinBarWidth. */
    var SLOT_INNER_FRAC = 0.86;
    var GROUP_BAR_FRAC = 0.88;
    var SOLO_BAR_FRAC = 0.98;

    var definition = {
        typeName: 'pvxComboChart',
        displayName: 'PVX Combo Chart',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        // Positional config, renumbered when a data source is removed.
        sourceRemap: { TraceSpec: 'traceSpec' },
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Combo Chart',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 300,
                Height: 300,
                Width: 460,

                Title: '',

                // Per-trace grammar. Blank => every source uses DefaultType.
                TraceSpec: '',
                DefaultType: 'line',

                // Geometry
                SmoothLines: false,
                LineWidth: 1.8,
                AreaOpacity: 0.25,
                BarOpacity: 0.85,
                StackBars: false,
                MinBarWidth: 4,

                // Axes
                ShowLeftAxis: true,
                ShowRightAxis: true,
                LeftMin: '',
                LeftMax: '',
                RightMin: '',
                RightMax: '',
                LeftLabel: '',
                RightLabel: '',
                ShowGrid: true,
                TickCount: 5,
                TimeTickCount: 5,

                // Limit bands — threshold grammar, LEFT axis only.
                LimitBands: '',
                LimitBandOpacity: 0.14,

                // Legend
                ShowLegend: true,
                LegendPosition: 'top',      // top | bottom | none
                ShowValues: false,

                ShowTooltips: true,
                MaxPointsPerTrace: 600
            });
        }
    };

    /* ---------------------------------------------------------------- *
     * TraceSpec parsing
     * ---------------------------------------------------------------- */

    /* Stroke patterns, in units of the stroke width so a 1px plan line and a
     * 3px one read as the same pattern. */
    var DASHES = { solid: null, dashed: [4, 3], dotted: [1, 2.5] };

    /** Only #hex is accepted: a bare word that is not a real CSS colour would
     *  silently paint the trace black, which is worse than ignoring it. */
    function isColorToken(tok) {
        return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(tok);
    }

    function normType(v) {
        var s = String(v === null || v === undefined ? '' : v).trim().toLowerCase();
        return TRACE_TYPES[s] === 1 ? s : null;
    }

    /**
     * Parse "1:bar, 2:line:right, 3:area, 4:step:right:#8267b0:dashed:1px"
     * into [{index, type, axis, color, dash, width}].
     *
     * After the index the remaining tokens are classified by WHAT THEY ARE
     * rather than by position. An operator typing "2:line:#c8452f:right" means
     * exactly what "2:line:right:#c8452f" means, and a parser that honoured
     * only one of them would be maddening to configure from memory. Unknown
     * tokens are dropped rather than failing the whole entry, so one typo costs
     * one attribute of one trace instead of the entire chart.
     */
    function parseTraceSpec(spec) {
        var out = [];
        if (!spec) { return out; }
        var chunks = String(spec).split(/[,\n;]/);
        for (var i = 0; i < chunks.length; i++) {
            var s = chunks[i].trim();
            if (!s) { continue; }
            var parts = s.split(':');
            // parseInt on the raw token tolerates " 3", "3 " and "#3".
            var idx = parseInt(String(parts[0]).replace(/[^0-9]/g, ''), 10);
            if (!isFinite(idx) || idx < 1) { continue; }
            var entry = { index: idx, type: null, axis: null, color: null, dash: null, width: null };
            for (var p = 1; p < parts.length; p++) {
                var tok = parts[p].trim();
                if (!tok) { continue; }
                var low = tok.toLowerCase();
                if (TRACE_TYPES[low] === 1) { entry.type = low; }
                else if (low === 'right' || low === 'r') { entry.axis = 'right'; }
                else if (low === 'left' || low === 'l') { entry.axis = 'left'; }
                else if (isColorToken(tok)) { entry.color = tok; }
                else if (DASHES.hasOwnProperty(low)) { entry.dash = low; }
                else if (/^\d+(\.\d+)?px$/.test(low)) { entry.width = parseFloat(low); }
            }
            out.push(entry);
        }
        return out;
    }

    /** The inverse of parseTraceSpec for one entry per trace, tokens in the
     *  documented order. An entry that sets nothing is left out: it would
     *  mean exactly what leaving the trace unlisted means. */
    function stringifyTraceSpec(entries) {
        var out = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            var toks = [String(e.index)];
            if (e.type) { toks.push(e.type); }
            if (e.axis === 'right') { toks.push('right'); }
            if (e.color && isColorToken(e.color)) { toks.push(e.color); }
            if (e.dash && e.dash !== 'solid') { toks.push(e.dash); }
            if (e.width > 0) { toks.push(String(Math.round(e.width * 100) / 100) + 'px'); }
            if (toks.length > 1) { out.push(toks.join(':')); }
        }
        return out.join(', ');
    }

    var TYPE_NAMES = { line: 'Line', area: 'Area', bar: 'Bar', step: 'Step', scatter: 'Scatter' };

    /**
     * TraceSpec as rows in the format pane, one per data source, published
     * at scope.runtimeData.pvxTraces. The stored value stays the grammar
     * string, so saved displays and the parser above are unaffected; the
     * operator picks a type, an axis and a colour instead of counting data
     * sources and typing "3:line:right:#5aa0d6".
     *
     * Rows follow the data source list, not the string: a trace with no
     * entry still gets a row (showing the default), and an entry for a
     * position with no data source keeps a row marked as such, so a spec
     * written for four sources is not trimmed when the pane is opened on
     * three.
     *
     * As with the band editor, rows are not re-read from the string while
     * the operator edits them, only when something else changed it (the
     * text box, a removed data source, a load).
     */
    function bindTraceEditor(scope, PVX) {
        if (!scope.runtimeData) { scope.runtimeData = {}; }
        var state = { rows: [], textMode: false, written: null, seenSources: null, unwatch: null };
        var pal = PVX.color.categorical;

        var cfg = function () {
            return scope.config || (scope.symbol && scope.symbol.Configuration) || null;
        };
        var sourceList = function () {
            var ds = scope.symbol && scope.symbol.DataSources;
            var out = [];
            if (ds && typeof ds.length === 'number') { for (var i = 0; i < ds.length; i++) { out.push(String(ds[i])); } }
            return out;
        };
        var autoHex = function (index) { return pal[(index - 1) % pal.length]; };

        state.load = function (spec) {
            var list = sourceList();
            var byIndex = {};
            var top = list.length;
            var parsed = parseTraceSpec(spec);
            for (var i = 0; i < parsed.length; i++) {
                byIndex[parsed[i].index] = parsed[i];
                if (parsed[i].index > top) { top = parsed[i].index; }
            }
            var rows = [];
            for (var n = 1; n <= top; n++) {
                var e = byIndex[n] || {};
                var rgb = e.color ? PVX.color.toRgb(e.color) : null;
                rows.push({
                    index: n,
                    name: n <= list.length ? PVX.sources.name(list[n - 1]) : 'No data source',
                    path: n <= list.length ? list[n - 1] : '',
                    missing: n > list.length,
                    type: e.type || '',
                    axis: e.axis === 'right' ? 'right' : 'left',
                    color: e.color || null,
                    hex: rgb ? PVX.color.toHex(rgb) : autoHex(n),
                    dash: e.dash && e.dash !== 'solid' ? e.dash : '',
                    width: e.width || null
                });
            }
            state.rows = rows;
            state.written = spec === undefined || spec === null ? '' : String(spec);
            state.seenSources = list.join('\n');
        };

        state.commit = function () {
            var c = cfg();
            var w;
            for (var i = 0; i < state.rows.length; i++) {
                w = PVX.util.num(state.rows[i].width);
                state.rows[i].width = w !== null && w > 0 ? w : null;
            }
            state.written = stringifyTraceSpec(state.rows);
            if (c) { c.TraceSpec = state.written; }
        };

        state.setColor = function (r) { r.color = r.hex; state.commit(); };
        state.autoColor = function (r) { r.color = null; r.hex = autoHex(r.index); state.commit(); };

        state.defaultName = function () {
            var c = cfg();
            return TYPE_NAMES[normType(c && c.DefaultType)] || 'Line';
        };

        /** Line style and width only mean something for a drawn outline. */
        state.stroked = function (r) {
            var c = cfg();
            var t = r.type || normType(c && c.DefaultType) || 'line';
            return t === 'line' || t === 'step' || t === 'area';
        };

        state.hasMissing = function () {
            for (var i = 0; i < state.rows.length; i++) { if (state.rows[i].missing) { return true; } }
            return false;
        };

        state.toggleText = function () { state.textMode = !state.textMode; };

        if (scope.$watch) {
            try {
                state.unwatch = scope.$watch(function () {
                    var c = cfg();
                    var v = c ? c.TraceSpec : '';
                    return (v === undefined || v === null ? '' : String(v)) + '\u0001' + sourceList().join('\n');
                }, function () {
                    var c = cfg();
                    var v = c ? c.TraceSpec : '';
                    var s2 = v === undefined || v === null ? '' : String(v);
                    if (s2 !== state.written || sourceList().join('\n') !== state.seenSources) { state.load(v); }
                });
            } catch (e) { state.unwatch = null; }
        }
        state.destroy = function () {
            if (state.unwatch) { state.unwatch(); state.unwatch = null; }
        };

        var c0 = cfg();
        state.load(c0 ? c0.TraceSpec : '');
        scope.runtimeData.pvxTraces = state;
        return state;
    }

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Template bindings (header / footer only; everything else is SVG).
        scope.pvx = { title: '', note: '', error: '' };

        var series = [];

        var traceEditor = bindTraceEditor(scope, PVX);

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-combo-body',
            // LimitBands is the threshold grammar, so it gets the same rows.
            bandKeys: ['LimitBands'],
            onData: function (d) { series = PVX.data.series(d) || []; },
            onDestroy: function () { traceEditor.destroy(); },
            render: render
        });

        /* ------------------------------------------------------------------ *
         * model
         * ------------------------------------------------------------------ */

        /**
         * Bind the ordered data-source list to the spec.
         * Sources with no entry take DefaultType on the left axis — the whole
         * reason the symbol works before anyone opens the config pane.
         */
        function buildTraces(cfg, list, t) {
            var spec = parseTraceSpec(cfg.TraceSpec);
            var byIndex = {};
            for (var i = 0; i < spec.length; i++) {
                // Last entry wins, so an edit appended to the string overrides
                // an earlier one instead of being quietly ignored.
                byIndex[spec[i].index] = spec[i];
            }
            var pal = (t && t.categorical) || PVX.color.categorical;
            var defType = normType(cfg.DefaultType) || 'line';
            var out = [];
            for (var s = 0; s < list.length; s++) {
                var e = byIndex[s + 1] || null;
                var type = (e && e.type) || defType;
                if (type === 'hidden') { continue; }
                out.push({
                    index: s + 1,
                    label: list[s].label || ('Series ' + (s + 1)),
                    units: list[s].units || '',
                    path: list[s].path || '',
                    good: list[s].good !== false,
                    error: list[s].errorDescription || '',
                    type: type,
                    axis: (e && e.axis === 'right') ? 'right' : 'left',
                    color: (e && e.color) || pal[s % pal.length],
                    dash: (e && e.dash) || 'solid',
                    width: (e && e.width) || null,
                    raw: list[s].points || [],
                    pts: [],          // decimated, for line/area/step/scatter
                    slots: null,      // aggregated, for bars
                    decimated: false,
                    last: null
                });
            }
            return out;
        }

        /**
         * Min/max-preserving bucket decimation (the pvxSparkline pattern).
         *
         * Plain stride sampling drops exactly the spikes an engineer is looking
         * for. Each bucket contributes its minimum AND its maximum in time
         * order, so the trace keeps its true vertical extent no matter how hard
         * it is squeezed.
         */
        function decimate(points, buckets) {
            var n = points.length;
            if (buckets < 2 || n <= buckets * 2) { return points; }
            var out = [];
            var push = function (p) {
                if (out[out.length - 1] !== p) { out.push(p); }
            };
            var size = n / buckets;
            push(points[0]);                       // anchor to the left edge
            for (var b = 0; b < buckets; b++) {
                var s = Math.floor(b * size);
                var e = Math.min(n, Math.floor((b + 1) * size));
                if (e <= s) { continue; }
                var lo = s, hi = s;
                for (var i = s + 1; i < e; i++) {
                    if (points[i].v < points[lo].v) { lo = i; }
                    if (points[i].v > points[hi].v) { hi = i; }
                }
                var a = Math.min(lo, hi), z = Math.max(lo, hi);
                push(points[a]);
                if (z !== a) { push(points[z]); }
            }
            push(points[n - 1]);                   // newest sample drives the legend
            return out;
        }

        /**
         * Aggregate a bar trace onto a SHARED slot grid.
         *
         * Bars must decimate by aggregation, never by striding: 300 samples on
         * a 200px symbol drawn one bar per sample is mush, and a strided sample
         * would report one arbitrary reading as if it were the interval. The
         * mean is used rather than the max because a bar encodes the level over
         * its slot — taking the max would bias every bar upward and make the
         * chart lie about production.
         *
         * The grid is shared across every bar trace so that grouped and stacked
         * bars line up; per-trace grids would leave them straddling each other.
         */
        function bucketBars(points, tMin, tMax, slots) {
            var sums = [], counts = [], i;
            for (i = 0; i < slots; i++) { sums.push(0); counts.push(0); }
            var span = (tMax - tMin) || 1;
            for (var j = 0; j < points.length; j++) {
                var k = Math.floor((points[j].t - tMin) / span * slots);
                if (k < 0) { k = 0; }
                if (k >= slots) { k = slots - 1; }
                sums[k] += points[j].v;
                counts[k] += 1;
            }
            var out = [];
            for (i = 0; i < slots; i++) {
                out.push(counts[i] ? (sums[i] / counts[i]) : null);
            }
            return out;
        }

        /** Domain for one axis, honouring explicit bounds and a bar baseline. */
        function domainFor(values, minCfg, maxCfg, needsZero, tickCount) {
            var lo = null, hi = null, i;
            for (i = 0; i < values.length; i++) {
                var v = values[i];
                if (!PVX.util.isNum(v)) { continue; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            }
            if (lo === null) { lo = 0; hi = 1; }
            // A bar drawn from a non-zero baseline misstates every ratio the eye
            // reads off it, so an axis carrying bars always includes zero.
            if (needsZero) {
                if (lo > 0) { lo = 0; }
                if (hi < 0) { hi = 0; }
            }
            var d = PVX.scale.niceDomain(lo, hi, tickCount);
            var eMin = PVX.util.num(minCfg);
            var eMax = PVX.util.num(maxCfg);
            if (eMin !== null) { d[0] = eMin; }
            if (eMax !== null) { d[1] = eMax; }
            if (!(d[1] > d[0])) { d[1] = d[0] + 1; }     // never divide by zero
            return d;
        }

        /* ------------------------------------------------------------------ *
         * text helpers
         * ------------------------------------------------------------------ */

        function textW(str, fontPx) {
            return String(str === null || str === undefined ? '' : str).length * fontPx * CHAR_W;
        }

        function fitText(str, maxW, fontPx) {
            var s = String(str === null || str === undefined ? '' : str);
            // The epsilon matters: textW() and this are inverses of each other,
            // and without it floating-point drift truncates a string that was
            // measured as fitting exactly.
            var m = Math.floor(maxW / (fontPx * CHAR_W) + 1e-6);
            if (m < 1) { return ''; }
            if (s.length <= m) { return s; }
            if (m === 1) { return '…'; }
            return s.slice(0, m - 1) + '…';
        }

        /* ------------------------------------------------------------------ *
         * render
         * ------------------------------------------------------------------ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            applyThemeVars(c, t);

            var W = Math.max(30, host.clientWidth || c.width || 30);
            var H = Math.max(24, host.clientHeight || c.height || 24);

            // The footer is HTML, outside the SVG, so it is measured against the
            // WHOLE symbol rather than the plot host — otherwise suppressing it
            // grows the host, which un-suppresses it, which shrinks it again.
            var rootW = (c.node && c.node.clientWidth) || W;
            var rootH = (c.node && c.node.clientHeight) || H;
            var showNote = rootW >= 200 && rootH >= 130;

            var svgRoot = host.querySelector('svg.pvx-combo-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-combo-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            // The plot must keep its true pixel geometry; no aspect fitting.
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            scope.pvx.title = cfg.Title || '';
            scope.pvx.note = '';
            scope.pvx.error = '';

            var traces = buildTraces(cfg, series, t);
            var i, j, k, tr;

            // Surface the first bad-quality source as a corner badge.
            for (i = 0; i < traces.length; i++) {
                if (!traces[i].good) {
                    scope.pvx.error = traces[i].label + ': ' + (traces[i].error || 'bad quality');
                    break;
                }
            }

            // ---- empty state ------------------------------------------------
            var anyPoints = false;
            for (i = 0; i < traces.length; i++) {
                if (traces[i].raw.length) { anyPoints = true; break; }
            }
            if (!traces.length || !anyPoints) {
                emptyState(svgRoot, W, H, t,
                    !series.length ? 'No data sources configured'
                                   : (traces.length ? 'No samples in this time range'
                                                    : 'Every trace is hidden'));
                digest();
                return;
            }

            // ---- shared time domain -----------------------------------------
            // Every trace covers the display's time range; a per-trace X domain
            // would destroy the correlation the symbol exists to show.
            var tMin = null, tMax = null;
            for (i = 0; i < traces.length; i++) {
                var rp = traces[i].raw;
                if (!rp.length) { continue; }
                if (tMin === null || rp[0].t < tMin) { tMin = rp[0].t; }
                if (tMax === null || rp[rp.length - 1].t > tMax) { tMax = rp[rp.length - 1].t; }
                traces[i].last = rp[rp.length - 1].v;
            }
            if (tMin === null) { tMin = 0; tMax = 1; }
            if (!(tMax > tMin)) { tMax = tMin + 1; }

            // ---- which axes are actually in play -----------------------------
            var rightUsed = false, leftUsed = false;
            var barsLeft = false, barsRight = false;
            for (i = 0; i < traces.length; i++) {
                if (traces[i].axis === 'right') { rightUsed = true; } else { leftUsed = true; }
                if (traces[i].type === 'bar') {
                    if (traces[i].axis === 'right') { barsRight = true; } else { barsLeft = true; }
                }
            }
            // Drop the right axis entirely when nothing uses it — reserving its
            // margin would shrink the plot for no information at all.
            var drawRight = rightUsed && cfg.ShowRightAxis !== false;
            var drawLeft = leftUsed && cfg.ShowLeftAxis !== false;

            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 10);
            var maxPts = PVX.util.clamp(parseInt(cfg.MaxPointsPerTrace, 10) || 600, 20, 5000);

            // ---- fonts and what the box can afford ---------------------------
            var tickFont = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var titleFont = PVX.util.clamp(tickFont + 1, 9, 13);
            var legendFont = PVX.util.clamp(tickFont, 8, 11);

            // Below these sizes the chrome costs more than it informs; shed it
            // and keep the traces themselves readable.
            var showTicks = W >= 150 && H >= 100;
            var showTimeTicks = W >= 150 && H >= 90;
            var showAxisTitles = showTicks && W >= 230 && H >= 140;
            var legendPos = cfg.LegendPosition || 'top';
            var wantLegend = cfg.ShowLegend !== false && legendPos !== 'none' && W >= 120 && H >= 92;

            /* ---- PASS 1 ------------------------------------------------------
             * Bar aggregation needs the plot width, but the plot width needs the
             * tick labels, which come from a domain that bar aggregation feeds.
             * Break the loop by sizing the plot once from the RAW extents, then
             * doing the real work inside it. A few pixels of difference in the
             * provisional width only ever shifts the slot count by one.
             * ---------------------------------------------------------------- */
            var provL = collectRaw(traces, 'left');
            var provR = collectRaw(traces, 'right');
            var provLd = domainFor(provL, cfg.LeftMin, cfg.LeftMax, barsLeft, tickCount);
            var provRd = domainFor(provR, cfg.RightMin, cfg.RightMax, barsRight, tickCount);
            var prov = margins(provLd, provRd);
            var plotW0 = Math.max(20, W - prov.l - prov.r);

            // ---- prepare traces at the provisional width ---------------------
            var barTraces = [];
            for (i = 0; i < traces.length; i++) {
                if (traces[i].type === 'bar') { barTraces.push(traces[i]); }
            }

            // Grouping: without stacking every bar trace gets its own slice of
            // the slot; with stacking each AXIS collapses to one slice, so bars
            // on the left and the right axis still sit side by side rather than
            // stacking two unrelated units on top of each other.
            var stack = !!cfg.StackBars;
            var groupOf = {};
            var groupCount = 0;
            for (i = 0; i < barTraces.length; i++) {
                var key = stack ? ('axis:' + barTraces[i].axis) : ('trace:' + barTraces[i].index);
                if (groupOf[key] === undefined) { groupOf[key] = groupCount; groupCount += 1; }
                barTraces[i].group = groupOf[key];
            }

            /* ---- how many time slots can the bars afford? --------------------
             * Sizing this from the plot width alone is what turns a bar chart
             * into a hairline comb: two bar traces sharing 570px of plot at 135
             * slots leaves each bar about 2px, and the shape information a bar
             * exists to convey is gone.
             *
             * So the target is a bar WIDTH, not a slot count. Every column that
             * shares a slot has to clear MinBarWidth after the inter-slot gap
             * and the intra-group gap have been taken out, which inverts to the
             * slot count below. Grouped and stacked differ only in the divisor:
             * a stack is one column no matter how many traces feed it.
             */
            var slots = 0;
            if (barTraces.length) {
                var maxRaw = 0;
                for (i = 0; i < barTraces.length; i++) {
                    maxRaw = Math.max(maxRaw, barTraces[i].raw.length);
                }
                var columns = Math.max(1, groupCount);
                var minBarW = PVX.util.num(cfg.MinBarWidth);
                minBarW = minBarW === null ? 4 : PVX.util.clamp(minBarW, 0.5, 60);
                var barFrac = columns > 1 ? GROUP_BAR_FRAC : SOLO_BAR_FRAC;
                var slotPx = (minBarW * columns) / (SLOT_INNER_FRAC * barFrac);
                var bySpace = Math.floor(plotW0 / slotPx);
                // At least one slot even in a sliver of a symbol, and never more
                // slots than there are samples to fill them.
                slots = Math.max(1, Math.min(maxRaw, bySpace, maxPts));
                for (i = 0; i < barTraces.length; i++) {
                    barTraces[i].slots = bucketBars(barTraces[i].raw, tMin, tMax, slots);
                    if (barTraces[i].raw.length > slots) { barTraces[i].decimated = true; }
                }
            }

            // Lines carry one envelope pair per two pixels — finer than that is
            // invisible and just costs path data.
            var buckets = Math.max(2, Math.min(Math.floor(plotW0 / 2), Math.floor(maxPts / 2)));
            for (i = 0; i < traces.length; i++) {
                tr = traces[i];
                if (tr.type === 'bar') { continue; }
                tr.pts = decimate(tr.raw, buckets);
                if (tr.pts.length < tr.raw.length) { tr.decimated = true; }
            }

            // ---- stacked bar totals, per axis --------------------------------
            // Positives stack up from zero, negatives down, so a mixed-sign
            // trace does not cancel a neighbour and hide it.
            var stackTot = { left: null, right: null };
            if (stack && slots) {
                stackTot.left = newTotals(slots);
                stackTot.right = newTotals(slots);
                for (i = 0; i < barTraces.length; i++) {
                    var acc = stackTot[barTraces[i].axis];
                    for (k = 0; k < slots; k++) {
                        var bv = barTraces[i].slots[k];
                        if (bv === null) { continue; }
                        if (bv >= 0) { acc.pos[k] += bv; } else { acc.neg[k] += bv; }
                    }
                }
            }

            /* ---- PASS 2: real domains from what will actually be drawn ------ */
            var leftVals = collectDrawn(traces, 'left', stack, stackTot.left);
            var rightVals = collectDrawn(traces, 'right', stack, stackTot.right);

            // Limit bands are folded into the left domain: a band drawn outside
            // the visible range would be invisible, and the engineer would
            // conclude the setting does nothing.
            var bandSpec = cfg.LimitBands || '';
            var bandList = PVX.thresholds.parse(bandSpec);
            for (i = 0; i < bandList.length; i++) { leftVals.push(bandList[i].value); }

            var ld = domainFor(leftVals, cfg.LeftMin, cfg.LeftMax, barsLeft, tickCount);
            var rd = domainFor(rightVals, cfg.RightMin, cfg.RightMax, barsRight, tickCount);

            var lTicks = PVX.scale.ticks(ld[0], ld[1], tickCount);
            var rTicks = PVX.scale.ticks(rd[0], rd[1], tickCount);

            // ---- legend layout (needs the final width, not the plot rect) ----
            var legend = null;
            if (wantLegend) {
                legend = layoutLegend(traces, cfg, W - 12, legendFont, rightUsed, H);
            }
            var legendH = legend ? legend.height : 0;

            var m = margins(ld, rd);
            var mT = 5 + (legend && legendPos !== 'bottom' ? legendH : 0);
            var mB = 5 + (showTimeTicks ? tickFont + 6 : 2) +
                     (legend && legendPos === 'bottom' ? legendH : 0);

            // On small boxes the chrome can swallow the plot; cap every side.
            var mL = Math.min(m.l, W * 0.42);
            var mR = Math.min(m.r, W * 0.32);
            mT = Math.min(mT, H * 0.45);
            mB = Math.min(mB, H * 0.45);

            var plot = {
                x: mL, y: mT,
                w: Math.max(10, W - mL - mR),
                h: Math.max(10, H - mT - mB)
            };
            plot.x1 = plot.x + plot.w;
            plot.y1 = plot.y + plot.h;

            var sx = PVX.scale.linear(tMin, tMax, plot.x, plot.x1);
            var syL = PVX.scale.linear(ld[0], ld[1], plot.y1, plot.y);   // SVG y grows down
            var syR = PVX.scale.linear(rd[0], rd[1], plot.y1, plot.y);

            // ---- limit bands (LEFT axis, underneath everything) --------------
            var bandOpacity = PVX.util.num(cfg.LimitBandOpacity);
            bandOpacity = bandOpacity === null ? 0.14 : PVX.util.clamp(bandOpacity, 0, 1);
            if (bandList.length && bandOpacity > 0) {
                drawBands(svgRoot, bandSpec, ld, syL, plot, t, bandOpacity, tickFont, showTicks);
            }

            // ---- grid ---------------------------------------------------------
            if (cfg.ShowGrid !== false) {
                // Horizontal lines follow the LEFT axis when it exists: gridlines
                // for two different scales would draw a lattice that means
                // nothing on either.
                var gridTicks = drawLeft || !drawRight ? lTicks : rTicks;
                var gridScale = drawLeft || !drawRight ? syL : syR;
                for (i = 0; i < gridTicks.length; i++) {
                    gridLine(svgRoot, plot.x, gridScale(gridTicks[i]), plot.x1, gridScale(gridTicks[i]), t.grid);
                }
            }

            // ---- time axis ------------------------------------------------------
            var timeTicks = buildTimeTicks(cfg, tMin, tMax, plot.w, tickFont);
            if (cfg.ShowGrid !== false) {
                for (i = 0; i < timeTicks.length; i++) {
                    var gx = sx(timeTicks[i]);
                    gridLine(svgRoot, gx, plot.y, gx, plot.y1, t.grid);
                }
            }

            // ---- clip everything data-driven ------------------------------------
            var clipId = host.getAttribute('data-pvx-clip') || PVX.util.uid('comboclip');
            host.setAttribute('data-pvx-clip', clipId);
            var defs = PVX.svg.el('defs', null, svgRoot);
            var clip = PVX.svg.el('clipPath', { id: clipId }, defs);
            PVX.svg.el('rect', {
                x: plot.x.toFixed(2), y: plot.y.toFixed(2),
                width: plot.w.toFixed(2), height: plot.h.toFixed(2)
            }, clip);
            var plotG = PVX.svg.el('g', { 'clip-path': 'url(#' + clipId + ')' }, svgRoot);

            var numOpts = PVX.config.numberOpts(cfg);
            var tips = cfg.ShowTooltips !== false;

            /* ---- painter's order ---------------------------------------------
             * Bars first, then areas, then the thin marks — lines, steps and
             * dots. Bars are opaque and tall, so anything drawn under them is
             * gone; an area is a translucent wash (AreaOpacity defaults to
             * 0.25) and still reads as an area when it sits over bars, so it
             * yields the bottom of the stack rather than the top.
             * ------------------------------------------------------------- */
            var traceOpts = function (tr) {
                return {
                    plot: plot, sx: sx,
                    sy: tr.axis === 'right' ? syR : syL,
                    domain: tr.axis === 'right' ? rd : ld,
                    cfg: cfg, theme: t, numOpts: numOpts, tips: tips
                };
            };

            if (slots) {
                drawBars(plotG, barTraces, {
                    plot: plot, slots: slots, groups: Math.max(1, groupCount),
                    stack: stack, syL: syL, syR: syR, ld: ld, rd: rd,
                    tMin: tMin, tMax: tMax, cfg: cfg, theme: t,
                    numOpts: numOpts, tips: tips
                });
            }

            var order = ['area', 'step', 'line', 'scatter'];
            for (var o = 0; o < order.length; o++) {
                for (i = 0; i < traces.length; i++) {
                    if (traces[i].type !== order[o]) { continue; }
                    drawTrace(plotG, traces[i], traceOpts(traces[i]));
                }
            }

            // ---- axis lines, ticks, labels -----------------------------------------
            gridLine(svgRoot, plot.x, plot.y1, plot.x1, plot.y1, t.axis);
            if (drawLeft) { gridLine(svgRoot, plot.x, plot.y, plot.x, plot.y1, t.axis); }
            if (drawRight) { gridLine(svgRoot, plot.x1, plot.y, plot.x1, plot.y1, t.axis); }

            if (showTicks && drawLeft) {
                for (i = 0; i < lTicks.length; i++) {
                    PVX.svg.text(svgRoot, (plot.x - 4).toFixed(2), syL(lTicks[i]).toFixed(2),
                        PVX.fmt.tick(lTicks[i]), {
                            'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end',
                            'font-size': tickFont, fill: t.textMuted
                        });
                }
            }
            if (showTicks && drawRight) {
                for (i = 0; i < rTicks.length; i++) {
                    PVX.svg.text(svgRoot, (plot.x1 + 4).toFixed(2), syR(rTicks[i]).toFixed(2),
                        PVX.fmt.tick(rTicks[i]), {
                            'class': 'pvx-svg-label pvx-num', 'text-anchor': 'start',
                            'font-size': tickFont, fill: t.textMuted
                        });
                }
            }

            if (showTimeTicks) {
                for (i = 0; i < timeTicks.length; i++) {
                    drawTimeLabel(svgRoot, sx(timeTicks[i]), plot.y1 + 4 + tickFont * 0.6,
                        PVX.fmt.time(timeTicks[i], 'short'), W, tickFont, t);
                }
            }

            if (showAxisTitles && drawLeft && cfg.LeftLabel) {
                axisTitle(svgRoot, titleFont * 0.8 + 1, plot.y + plot.h / 2,
                    fitText(cfg.LeftLabel, plot.h, titleFont), -90, titleFont, t);
            }
            if (showAxisTitles && drawRight && cfg.RightLabel) {
                axisTitle(svgRoot, W - titleFont * 0.8 - 1, plot.y + plot.h / 2,
                    fitText(cfg.RightLabel, plot.h, titleFont), 90, titleFont, t);
            }

            // ---- legend --------------------------------------------------------------
            if (legend) {
                drawLegend(svgRoot, legend, 6,
                    legendPos === 'bottom' ? (H - legendH + 1) : 3,
                    legendFont, t);
            }

            // ---- footer note ------------------------------------------------------------
            var decCount = 0;
            for (i = 0; i < traces.length; i++) { if (traces[i].decimated) { decCount += 1; } }
            var notes = [];
            if (decCount) {
                notes.push(decCount + (decCount === 1 ? ' trace' : ' traces') + ' decimated to fit');
            }
            if (barTraces.length && slots) {
                notes.push(slots + (slots === 1 ? ' bar slot' : ' bar slots'));
            }
            scope.pvx.note = showNote ? notes.join(' · ') : '';

            digest();

            /* -------------------------------------------------------------- *
             * closures over the current frame
             * -------------------------------------------------------------- */

            /** Margins from the ACTUAL tick strings, so a "1,234,567" axis is
             *  never clipped and a "0..5" axis does not waste half the width. */
            function margins(leftDomain, rightDomain) {
                var lw = 0, rw = 0, q;
                if (showTicks && drawLeft) {
                    var lt = PVX.scale.ticks(leftDomain[0], leftDomain[1], tickCount);
                    for (q = 0; q < lt.length; q++) {
                        lw = Math.max(lw, textW(PVX.fmt.tick(lt[q]), tickFont));
                    }
                }
                if (showTicks && drawRight) {
                    var rt = PVX.scale.ticks(rightDomain[0], rightDomain[1], tickCount);
                    for (q = 0; q < rt.length; q++) {
                        rw = Math.max(rw, textW(PVX.fmt.tick(rt[q]), tickFont));
                    }
                }
                var lTitle = (showAxisTitles && drawLeft && cfg.LeftLabel) ? titleFont + 3 : 0;
                var rTitle = (showAxisTitles && drawRight && cfg.RightLabel) ? titleFont + 3 : 0;
                return {
                    l: 4 + lTitle + lw + (lw ? 5 : 0),
                    r: 4 + rTitle + rw + (rw ? 5 : 0)
                };
            }
        }

        /* ------------------------------------------------------------------ *
         * value collection
         * ------------------------------------------------------------------ */

        function collectRaw(traces, axis) {
            var out = [];
            for (var i = 0; i < traces.length; i++) {
                if (traces[i].axis !== axis) { continue; }
                var p = traces[i].raw;
                for (var j = 0; j < p.length; j++) { out.push(p[j].v); }
            }
            return out;
        }

        /** Values as they will actually be drawn — decimated, aggregated and,
         *  when stacking, summed. Scaling to anything else would clip. */
        function collectDrawn(traces, axis, stack, totals) {
            var out = [], i, j;
            for (i = 0; i < traces.length; i++) {
                var tr = traces[i];
                if (tr.axis !== axis) { continue; }
                if (tr.type === 'bar') {
                    if (stack || !tr.slots) { continue; }
                    for (j = 0; j < tr.slots.length; j++) {
                        if (tr.slots[j] !== null) { out.push(tr.slots[j]); }
                    }
                } else {
                    for (j = 0; j < tr.pts.length; j++) { out.push(tr.pts[j].v); }
                }
            }
            if (stack && totals) {
                for (i = 0; i < totals.pos.length; i++) {
                    out.push(totals.pos[i]);
                    out.push(totals.neg[i]);
                }
            }
            return out;
        }

        function newTotals(slots) {
            var pos = [], neg = [];
            for (var i = 0; i < slots; i++) { pos.push(0); neg.push(0); }
            return { pos: pos, neg: neg };
        }

        /* ------------------------------------------------------------------ *
         * drawing primitives
         * ------------------------------------------------------------------ */

        function gridLine(parent, x1, y1, x2, y2, stroke) {
            PVX.svg.el('line', {
                x1: x1.toFixed(2), y1: y1.toFixed(2),
                x2: x2.toFixed(2), y2: y2.toFixed(2),
                stroke: stroke, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, parent);
        }

        function axisTitle(parent, x, y, str, deg, font, t) {
            PVX.svg.text(parent, x.toFixed(2), y.toFixed(2), str, {
                'class': 'pvx-svg-label pvx-combo-axis-title', 'text-anchor': 'middle',
                'font-size': font, fill: t.text,
                transform: 'rotate(' + deg + ' ' + x.toFixed(2) + ' ' + y.toFixed(2) + ')'
            });
        }

        /**
         * Time labels are anchored in the middle, except at the edges where the
         * anchor flips so the first and last labels cannot spill outside the
         * symbol — the one place a time axis reliably gets clipped.
         */
        function drawTimeLabel(parent, x, y, str, W, font, t) {
            var w = textW(str, font);
            var anchor = 'middle', tx = x;
            if (x - w / 2 < 1) { anchor = 'start'; tx = 1; }
            else if (x + w / 2 > W - 1) { anchor = 'end'; tx = W - 1; }
            PVX.svg.text(parent, tx.toFixed(2), y.toFixed(2), str, {
                'class': 'pvx-svg-label pvx-num', 'text-anchor': anchor,
                'font-size': font, fill: t.textMuted
            });
        }

        /**
         * Evenly spaced time ticks, thinned to whatever the width can carry.
         * "MM/DD HH:MM" is 11 characters, and two of them touching is worse
         * than half as many that can be read.
         */
        function buildTimeTicks(cfg, tMin, tMax, plotW, font) {
            var want = PVX.util.clamp(parseInt(cfg.TimeTickCount, 10) || 5, 2, 12);
            var fits = Math.max(2, Math.floor(plotW / (11 * font * CHAR_W + 10)));
            var n = Math.min(want, fits);
            var out = [];
            for (var i = 0; i < n; i++) {
                out.push(tMin + (tMax - tMin) * (n === 1 ? 0.5 : i / (n - 1)));
            }
            return out;
        }

        /**
         * Horizontal shaded regions on the LEFT axis, from the shared threshold
         * grammar: each band runs from its own limit to the next one, and the
         * topmost runs to the top of the axis.
         */
        function drawBands(parent, spec, domain, sy, plot, t, opacity, font, showLabels) {
            var bands = PVX.thresholds.bands(spec, domain[0], domain[1]);
            for (var i = 0; i < bands.length; i++) {
                var yTop = sy(bands[i].to);
                var yBot = sy(bands[i].from);
                var h = Math.abs(yBot - yTop);
                if (h < 0.5) { continue; }
                PVX.svg.el('rect', {
                    x: plot.x.toFixed(2), y: Math.min(yTop, yBot).toFixed(2),
                    width: plot.w.toFixed(2), height: h.toFixed(2),
                    fill: bands[i].color, 'fill-opacity': opacity,
                    'class': 'pvx-combo-band'
                }, parent);
                // A crisp edge at the limit itself: the shading says "region",
                // the line says "this exact number is the limit".
                if (bands[i].from > domain[0]) {
                    PVX.svg.el('line', {
                        x1: plot.x.toFixed(2), y1: yBot.toFixed(2),
                        x2: (plot.x + plot.w).toFixed(2), y2: yBot.toFixed(2),
                        stroke: bands[i].color, 'stroke-width': 1,
                        'stroke-opacity': 0.75, 'stroke-dasharray': '4 3',
                        'class': 'pvx-combo-limit'
                    }, parent);
                }
                // The caption sits just inside the band's OWN limit line, not at
                // the far edge: a label parked against the next band's limit
                // reads as belonging to that limit instead of this one.
                if (showLabels && bands[i].label && h >= font + 3 && plot.w > 90) {
                    PVX.svg.text(parent, (plot.x + plot.w - 4).toFixed(2),
                        (Math.max(yTop, yBot) - font * 0.75).toFixed(2),
                        fitText(bands[i].label, plot.w * 0.5, font * 0.9), {
                            'class': 'pvx-svg-label pvx-combo-band-label',
                            'text-anchor': 'end', 'font-size': (font * 0.9).toFixed(1),
                            fill: bands[i].color, opacity: '0.9'
                        });
                }
            }
        }

        /** Grouped or stacked bars on the shared slot grid. */
        function drawBars(parent, barTraces, L) {
            if (!barTraces.length) { return; }
            var plot = L.plot;
            // The same three fractions the slot count was solved against, so the
            // bars really do come out at MinBarWidth or wider.
            var slotW = plot.w / L.slots;
            var inner = slotW * SLOT_INNER_FRAC;
            var groupW = inner / L.groups;
            var barW = Math.max(0.7, groupW * (L.groups > 1 ? GROUP_BAR_FRAC : SOLO_BAR_FRAC));
            var opacity = PVX.util.num(L.cfg.BarOpacity);
            opacity = opacity === null ? 0.85 : PVX.util.clamp(opacity, 0.05, 1);

            // Stack cursors, one per axis, advanced trace by trace.
            var cursors = { left: null, right: null };
            if (L.stack) {
                cursors.left = newTotals(L.slots);
                cursors.right = newTotals(L.slots);
            }

            for (var i = 0; i < barTraces.length; i++) {
                var tr = barTraces[i];
                var sy = tr.axis === 'right' ? L.syR : L.syL;
                var domain = tr.axis === 'right' ? L.rd : L.ld;
                var zeroV = PVX.util.clamp(0, Math.min(domain[0], domain[1]), Math.max(domain[0], domain[1]));
                var g = PVX.svg.el('g', { 'class': 'pvx-combo-bars' }, parent);
                if (!tr.good) { g.setAttribute('opacity', '0.55'); }
                var cur = L.stack ? cursors[tr.axis] : null;

                for (var k = 0; k < L.slots; k++) {
                    var v = tr.slots[k];
                    if (v === null) { continue; }
                    var base = zeroV, top = v;
                    if (cur) {
                        if (v >= 0) { base = cur.pos[k]; top = cur.pos[k] + v; cur.pos[k] = top; }
                        else { base = cur.neg[k]; top = cur.neg[k] + v; cur.neg[k] = top; }
                    }
                    var y0 = sy(base), y1 = sy(top);
                    var x = plot.x + k * slotW + (slotW - inner) / 2 + tr.group * groupW +
                            (groupW - barW) / 2;
                    var h = Math.abs(y1 - y0);
                    // A zero-height bar still deserves a mark at the baseline;
                    // otherwise a slot with a genuine zero looks like missing data.
                    var rect = PVX.svg.el('rect', {
                        x: x.toFixed(2), y: Math.min(y0, y1).toFixed(2),
                        width: barW.toFixed(2), height: Math.max(0.6, h).toFixed(2),
                        fill: tr.color, 'fill-opacity': opacity,
                        'class': 'pvx-combo-bar'
                    }, g);
                    if (L.tips) {
                        var slotT = L.tMin + (k + 0.5) * (L.tMax - L.tMin) / L.slots;
                        var title = PVX.svg.el('title', null, rect);
                        title.textContent = tr.label + ': ' +
                            PVX.fmt.number(v, L.numOpts) + (tr.units ? ' ' + tr.units : '') +
                            '\n' + PVX.fmt.time(slotT, 'datetime');
                    }
                }
            }
        }

        /** One line / area / step / scatter trace. */
        function drawTrace(parent, tr, L) {
            var pts = tr.pts;
            if (!pts.length) { return; }
            var plot = L.plot;
            var lo = Math.min(L.domain[0], L.domain[1]);
            var hi = Math.max(L.domain[0], L.domain[1]);

            var xy = [];
            for (var i = 0; i < pts.length; i++) {
                xy.push({
                    x: L.sx(pts[i].t),
                    // Clamping in DATA space keeps an out-of-range excursion
                    // riding the edge of the plot instead of vanishing, which is
                    // what an operator needs to see when a limit is exceeded.
                    y: L.sy(PVX.util.clamp(pts[i].v, lo, hi))
                });
            }

            var lw = tr.width !== null ? tr.width : PVX.util.num(L.cfg.LineWidth);
            lw = lw === null ? 1.8 : PVX.util.clamp(lw, 0.3, 8);
            var smooth = !!L.cfg.SmoothLines && tr.type !== 'step';
            var g = PVX.svg.el('g', { 'class': 'pvx-combo-trace' }, parent);
            if (!tr.good) { g.setAttribute('opacity', '0.55'); }

            if (tr.type === 'scatter') {
                var r = PVX.util.clamp(lw * 1.3, 1, 5);
                for (var s = 0; s < xy.length; s++) {
                    PVX.svg.el('circle', {
                        cx: xy[s].x.toFixed(2), cy: xy[s].y.toFixed(2), r: r.toFixed(2),
                        fill: tr.color, 'fill-opacity': 0.75, 'class': 'pvx-combo-dot'
                    }, g);
                }
            } else {
                if (tr.type === 'area') {
                    var opacity = PVX.util.num(L.cfg.AreaOpacity);
                    opacity = opacity === null ? 0.25 : PVX.util.clamp(opacity, 0, 1);
                    // Fill down to zero when zero is on the axis, otherwise to the
                    // axis floor — an area hanging off the bottom of its own scale
                    // would read as a value the tag never had.
                    var baseY = L.sy(PVX.util.clamp(0, lo, hi));
                    PVX.svg.el('path', {
                        d: PVX.svg.area(xy, baseY, smooth),
                        fill: tr.color, 'fill-opacity': opacity, stroke: 'none',
                        'class': 'pvx-combo-area'
                    }, g);
                }
                PVX.svg.el('path', {
                    d: tr.type === 'step' ? PVX.svg.stepLine(xy) : PVX.svg.line(xy, smooth),
                    fill: 'none', stroke: tr.color,
                    'stroke-width': lw,
                    'stroke-dasharray': dashFor(tr, lw),
                    'stroke-linejoin': 'round',
                    // A round cap fills the gaps of a dotted line back in.
                    'stroke-linecap': tr.dash === 'solid' ? 'round' : 'butt',
                    'vector-effect': 'non-scaling-stroke',
                    'class': 'pvx-combo-line'
                }, g);
            }

            if (L.tips) {
                // One tooltip per trace, not per sample: hundreds of <title>
                // nodes cost real memory and tell the operator nothing extra.
                var title = PVX.svg.el('title', null, g);
                title.textContent = tr.label +
                    (tr.last === null ? '' : ': ' + PVX.fmt.number(tr.last, L.numOpts) +
                        (tr.units ? ' ' + tr.units : '')) +
                    '\n' + tr.type + ' · ' + tr.axis + ' axis' +
                    (tr.good ? '' : '\n' + (tr.error || 'bad quality'));
            }
        }

        /* ------------------------------------------------------------------ *
         * legend
         * ------------------------------------------------------------------ */

        /**
         * Flow the entries into rows and report the height they need, so the
         * caller can reserve exactly that much before sizing the plot.
         * The axis side is only ever shown when the right axis is in use —
         * on a single-axis chart "(L)" on every entry is pure noise.
         */
        function layoutLegend(traces, cfg, availW, font, showAxis, H) {
            var SWATCH = 11, GAP = 5, PAD = 12;
            var lineH = font + 5;
            var maxLines = H >= 150 ? 2 : 1;
            // Only the NAME is capped, and only to stop one long AF path from
            // swallowing a whole row. The axis side and the current value are
            // appended afterwards so they can never be the part that gets cut —
            // a legend reading "Boiler 1 Steam Flow (L) 91.8 kl…" is worse than
            // useless, because the number it truncated is the one being read.
            var maxLabelW = PVX.util.clamp(availW * 0.30, 46, 230);

            var entries = [];
            for (var i = 0; i < traces.length; i++) {
                var tr = traces[i];
                var text = fitText(tr.label, maxLabelW, font);
                if (showAxis) { text += tr.axis === 'right' ? ' (R)' : ' (L)'; }
                if (cfg.ShowValues && tr.last !== null) {
                    text += '  ' + PVX.fmt.number(tr.last, PVX.config.numberOpts(cfg)) +
                            (tr.units ? ' ' + tr.units : '');
                }
                var w = SWATCH + GAP + textW(text, font) + PAD;
                if (w > availW) {
                    // Narrower symbol than a single entry: fall back to cutting
                    // the composed string rather than overflowing the box.
                    text = fitText(text, availW - SWATCH - GAP - PAD, font);
                    w = availW;
                }
                entries.push({ trace: tr, text: text, w: w });
            }

            var lines = [[]], lineW = 0;
            for (i = 0; i < entries.length; i++) {
                if (lineW > 0 && lineW + entries[i].w > availW) {
                    if (lines.length >= maxLines) { break; }
                    lines.push([]);
                    lineW = 0;
                }
                lines[lines.length - 1].push(entries[i]);
                lineW += entries[i].w;
            }
            var shown = 0;
            for (i = 0; i < lines.length; i++) { shown += lines[i].length; }

            return {
                lines: lines,
                overflow: entries.length - shown,
                lineH: lineH,
                swatch: SWATCH,
                gap: GAP,
                height: lines.length * lineH + 3
            };
        }

        function drawLegend(parent, legend, x0, y0, font, t) {
            for (var r = 0; r < legend.lines.length; r++) {
                var row = legend.lines[r];
                var x = x0;
                var cy = y0 + legend.lineH * (r + 0.5);
                for (var i = 0; i < row.length; i++) {
                    drawSwatch(parent, row[i].trace, x, cy, legend.swatch);
                    PVX.svg.text(parent, (x + legend.swatch + legend.gap).toFixed(2), cy.toFixed(2),
                        row[i].text, {
                            'class': 'pvx-svg-label pvx-combo-legend-text',
                            'font-size': font, fill: t.text,
                            opacity: row[i].trace.good ? '1' : '0.55'
                        });
                    x += row[i].w;
                }
                // "+N" rather than silent truncation: the operator must be able
                // to tell that traces exist which the legend could not show.
                if (r === legend.lines.length - 1 && legend.overflow > 0) {
                    PVX.svg.text(parent, x.toFixed(2), cy.toFixed(2), '+' + legend.overflow, {
                        'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted
                    });
                }
            }
        }

        /** The swatch encodes the geometry, so the legend explains the chart's
         *  grammar as well as its colours. */
        function drawSwatch(parent, tr, x, cy, size) {
            var col = tr.color;
            if (tr.type === 'bar') {
                PVX.svg.el('rect', {
                    x: (x + 1).toFixed(2), y: (cy - size * 0.42).toFixed(2),
                    width: (size - 2).toFixed(2), height: (size * 0.84).toFixed(2),
                    fill: col, rx: 1, 'class': 'pvx-combo-key'
                }, parent);
            } else if (tr.type === 'area') {
                PVX.svg.el('rect', {
                    x: (x + 1).toFixed(2), y: (cy - size * 0.1).toFixed(2),
                    width: (size - 2).toFixed(2), height: (size * 0.5).toFixed(2),
                    fill: col, 'fill-opacity': 0.35, 'class': 'pvx-combo-key'
                }, parent);
                PVX.svg.el('line', {
                    x1: (x + 1).toFixed(2), y1: (cy - size * 0.1).toFixed(2),
                    x2: (x + size - 1).toFixed(2), y2: (cy - size * 0.1).toFixed(2),
                    stroke: col, 'stroke-width': 1.6, 'class': 'pvx-combo-key'
                }, parent);
            } else if (tr.type === 'scatter') {
                PVX.svg.el('circle', {
                    cx: (x + size / 2).toFixed(2), cy: cy.toFixed(2), r: (size * 0.26).toFixed(2),
                    fill: col, 'class': 'pvx-combo-key'
                }, parent);
            } else if (tr.type === 'step') {
                var h = size * 0.3;
                PVX.svg.el('path', {
                    d: 'M' + (x + 1).toFixed(2) + ' ' + (cy + h).toFixed(2) +
                       ' H' + (x + size / 2).toFixed(2) +
                       ' V' + (cy - h).toFixed(2) +
                       ' H' + (x + size - 1).toFixed(2),
                    fill: 'none', stroke: col, 'stroke-width': 1.8,
                    'stroke-linejoin': 'round', 'class': 'pvx-combo-key'
                }, parent);
            } else {
                PVX.svg.el('line', {
                    x1: (x + 1).toFixed(2), y1: cy.toFixed(2),
                    x2: (x + size - 1).toFixed(2), y2: cy.toFixed(2),
                    stroke: col, 'stroke-width': 2.2,
                    'stroke-dasharray': dashFor(tr, 2.2),
                    'stroke-linecap': tr.dash === 'solid' ? 'round' : 'butt',
                    'class': 'pvx-combo-key'
                }, parent);
            }
        }

        /** stroke-dasharray for a trace at a given stroke width, or null. */
        function dashFor(tr, lw) {
            var d = DASHES[tr.dash];
            if (!d) { return null; }
            var w = Math.max(1, lw);
            return (d[0] * w).toFixed(1) + ' ' + (d[1] * w).toFixed(1);
        }

        /* ------------------------------------------------------------------ *
         * misc
         * ------------------------------------------------------------------ */

        /** Theme tokens as CSS custom properties, consumed by styles.css and the
         *  template's ng-style. t.surface already accounts for Transparent and
         *  an explicit BackgroundColor, so the template needs no logic of its
         *  own beyond the transparency switch. */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', t.surface);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
        }

        function emptyState(svgRoot, W, H, t, message) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);
            PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2).toFixed(2),
                fitText(message, W - 8, font), {
                    'class': 'pvx-svg-label', 'text-anchor': 'middle',
                    'font-size': font, fill: t.textMuted
                });
        }

        /* Renders run inside requestAnimationFrame, outside Angular's digest,
         * and this symbol writes the title/footer through scope bindings. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
