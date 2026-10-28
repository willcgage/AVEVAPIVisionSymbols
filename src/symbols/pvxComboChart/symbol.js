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
 *
 * MORE TRACE KINDS, all opt-in through TraceSpec:
 *   states   a digital tag as shaded bands behind the traces, one lane per
 *            such tag, coloured by StateColors. It uses no axis.
 *   range    this source and the NEXT one as the lower and upper edge of a
 *            filled band (a min/max envelope, a spec window). The next source
 *            is used up by it and not drawn on its own.
 *   maN      a moving average over N samples, or a time with a unit (ma1h,
 *            ma30m), drawn dashed over the trace. Trailing, so it never
 *            looks ahead of the value it averages.
 *   fit      a least-squares straight line through the trace over the window,
 *            with its slope per hour in the tooltip and the rulers' table.
 *
 * Panels: 'separate' gives every trace its own strip and scale over one time
 * axis, for tags whose units have nothing in common. LeftScale/RightScale
 * 'log' puts an axis on a log scale; values at or below zero cannot be
 * placed on one, and how many were left out is said in the footer.
 *
 * Rulers (off by default): click the plot to put ruler A, again for B; drag
 * either. A table under the chart gives each source's value at A and B, the
 * change, and the minimum, maximum, time-weighted average, standard
 * deviation and sample count between them.
 *
 * EVENT FRAMES (ShowEvents, off by default) are shaded behind the traces with
 * their names along the top: a trip, a batch, a grade change, read from AF
 * through PVX.api because PI Vision's data pipeline does not carry them. They
 * are fetched for the window the traces cover, again when it moves by more
 * than a fiftieth of its length, and on a timer, never once per data update.
 * Whatever stops them from showing (no PI Web API, no asset, a failed query,
 * more events than the cap) is said in the footer, and the traces draw
 * regardless: the events are an annotation, not a dependency.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* The complete trace vocabulary. Kept as a lookup rather than an array so
     * the parser can classify a token in one step without a linear scan. */
    var TRACE_TYPES = {
        line: 1, area: 1, bar: 1, step: 1, scatter: 1, hidden: 1, states: 1, range: 1
    };

    /* "ma20" is twenty samples; "ma1h" or "ma30m" is a time. */
    var MA_RE = /^ma(\d+(?:\.\d+)?)([smhd]?)$/;
    var UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000 };

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
                LeftScale: 'linear',        // linear | log
                RightScale: 'linear',
                Panels: 'shared',           // shared | separate

                // Traces typed "states" in TraceSpec: colours per state,
                // "Running:#2f9e5f, Stopped:#c8452f"; others take the palette.
                StateColors: '',
                StateOpacity: 0.18,

                // Rulers A and B with a statistics table between them.
                Rulers: false,

                // Limit bands — threshold grammar, LEFT axis only.
                LimitBands: '',
                LimitBandOpacity: 0.14,

                // Legend
                ShowLegend: true,
                LegendPosition: 'top',      // top | bottom | none
                ShowValues: false,

                ShowTooltips: true,
                MaxPointsPerTrace: 600,

                // Event frames behind the traces, from PI Web API.
                ShowEvents: false,
                EventScope: 'asset',        // asset | database
                EventDatabasePath: '',      // blank => the data source's database
                EventTemplate: '',
                EventNameFilter: '',
                EventMax: 50,
                EventColor: '',             // blank => one colour per template
                EventOpacity: 0.12,
                EventLabels: true,
                EventClick: 'none',         // none | time
                EventRefreshSeconds: 60
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
            var entry = { index: idx, type: null, axis: null, color: null, dash: null, width: null, ma: '', fit: false };
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
                else if (MA_RE.test(low)) { entry.ma = low.slice(2); }
                else if (low === 'fit') { entry.fit = true; }
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
            var ma = String(e.ma || '').replace(/\s+/g, '').toLowerCase();
            if (ma && MA_RE.test('ma' + ma)) { toks.push('ma' + ma); }
            if (e.fit) { toks.push('fit'); }
            if (toks.length > 1) { out.push(toks.join(':')); }
        }
        return out.join(', ');
    }

    var TYPE_NAMES = { line: 'Line', area: 'Area', bar: 'Bar', step: 'Step', scatter: 'Scatter',
        states: 'State bands', range: 'Range to next' };

    /** "20" -> {count: 20}; "1h" -> {ms: 3600000}; anything else -> null. */
    function parseMa(text) {
        var m = MA_RE.exec('ma' + String(text || '').toLowerCase());
        if (!m) { return null; }
        var n = parseFloat(m[1]);
        if (!(n > 0)) { return null; }
        return m[2] ? { ms: n * UNIT_MS[m[2]], text: m[1] + m[2] } : { count: Math.max(2, Math.round(n)), text: m[1] + ' samples' };
    }

    /**
     * Trailing moving average. By count, the last N samples; by time, every
     * sample in the last span, so the window is the same length of time
     * however often a compressed tag happened to report inside it.
     */
    function movingAverage(points, ma) {
        var out = [], sum = 0, lo = 0;
        for (var i = 0; i < points.length; i++) {
            sum += points[i].v;
            if (ma.count) {
                if (i - lo + 1 > ma.count) { sum -= points[lo].v; lo += 1; }
            } else {
                while (points[i].t - points[lo].t > ma.ms) { sum -= points[lo].v; lo += 1; }
            }
            out.push({ t: points[i].t, v: sum / (i - lo + 1) });
        }
        return out;
    }

    /** The trailing linear trend of a trace, against time in hours. */
    function fitLine(points) {
        if (!points || points.length < 3) { return null; }
        var t0 = points[0].t, xy = [];
        for (var i = 0; i < points.length; i++) { xy.push({ x: (points[i].t - t0) / 3600000, y: points[i].v }); }
        var r = window.PVX.stats.linreg(xy);
        if (!r) { return null; }
        return { t0: t0, slope: r.slope, intercept: r.intercept, r2: r.r2,
            at: function (t) { return r.intercept + r.slope * (t - t0) / 3600000; } };
    }

    /** Value at a time: interpolated for a line, held for a step, bar or state. */
    function valueAt(points, tm, hold) {
        if (!points.length || tm < points[0].t) { return null; }
        var lo = 0, hi = points.length - 1;
        if (tm >= points[hi].t) { return points[hi]; }
        while (hi - lo > 1) {
            var mid = (lo + hi) >> 1;
            if (points[mid].t <= tm) { lo = mid; } else { hi = mid; }
        }
        var a = points[lo], b = points[hi];
        var num = function (v) { return typeof v === 'number' && isFinite(v); };
        if (hold || !num(a.v) || !num(b.v) || b.t === a.t) { return a; }
        return { t: tm, v: a.v + (b.v - a.v) * (tm - a.t) / (b.t - a.t) };
    }

    /* ---------------------------------------------------------------- *
     * log scale
     * ---------------------------------------------------------------- */

    /** A y scale, linear or log10, mapping domain to [r0, r1]. */
    function yScale(domain, log, r0, r1) {
        if (!log) { return window.PVX.scale.linear(domain[0], domain[1], r0, r1); }
        var a = Math.log(domain[0]) / Math.LN10, b = Math.log(domain[1]) / Math.LN10;
        return function (v) {
            var lv = v > 0 ? Math.log(v) / Math.LN10 : a;
            return r0 + (lv - a) / ((b - a) || 1) * (r1 - r0);
        };
    }

    /** The nearest 1, 2 or 5 times a power of ten at or beyond v. */
    function logSnap(v, up) {
        var e = Math.floor(Math.log(v) / Math.LN10 + 1e-9);
        var steps = [1, 2, 5, 10];
        var base = Math.pow(10, e);
        var i;
        if (up) {
            for (i = 0; i < steps.length; i++) { if (steps[i] * base >= v * (1 - 1e-9)) { return parseFloat((steps[i] * base).toPrecision(12)); } }
            return base * 10;
        }
        for (i = steps.length - 1; i >= 0; i--) { if (steps[i] * base <= v * (1 + 1e-9)) { return parseFloat((steps[i] * base).toPrecision(12)); } }
        return base;
    }

    /** Decade ticks, with 2 and 5 between them when there are few decades. */
    function logTicks(lo, hi) {
        var out = [];
        var e0 = Math.floor(Math.log(lo) / Math.LN10 + 1e-9), e1 = Math.ceil(Math.log(hi) / Math.LN10 - 1e-9);
        var mults = (e1 - e0) <= 2 ? [1, 2, 5] : [1];
        for (var e = e0; e <= e1; e++) {
            for (var m = 0; m < mults.length; m++) {
                var v = mults[m] * Math.pow(10, e);
                if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) { out.push(parseFloat(v.toPrecision(12))); }
            }
        }
        return out.length >= 2 ? out : [lo, hi];
    }

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
                    width: e.width || null,
                    ma: e.ma || '',
                    fit: !!e.fit
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

        /** A moving average and a fit are for traces that have numbers. */
        state.numeric = function (r) {
            var c = cfg();
            var t = r.type || normType(c && c.DefaultType) || 'line';
            return t !== 'hidden' && t !== 'states';
        };

        state.maBad = function (r) { return !!r.ma && !parseMa(r.ma); };

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

    // The parts with right answers, for tools/test-charts.js.
    symbolVis.parseTraceSpec = parseTraceSpec;
    symbolVis.stringifyTraceSpec = stringifyTraceSpec;
    symbolVis.parseMa = parseMa;
    symbolVis.movingAverage = movingAverage;
    symbolVis.logSnap = logSnap;
    symbolVis.logTicks = logTicks;
    symbolVis.valueAt = valueAt;

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Template bindings (header / footer only; everything else is SVG).
        scope.pvx = { title: '', note: '', error: '' };

        var series = [];
        var stateList = [];       // the same sources with their text values kept
        var rulers = { a: null, b: null, drag: null, shape: '' };
        scope.pvx.clearRulers = function () { rulers.a = rulers.b = null; ctx.render(); };

        var traceEditor = bindTraceEditor(scope, PVX);

        // Event frames: what was fetched, and for what.
        var events = { phase: 'off', items: [], error: null, capped: false, max: 0, key: '', gen: 0,
            db: null, timer: null, timerSecs: 0 };
        var dbCache = {};
        var elementCache = {};
        var sourceAsset = '';

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-combo-body',
            // LimitBands is the threshold grammar, so it gets the same rows.
            bandKeys: ['LimitBands'],
            onData: function (d) {
                series = PVX.data.series(d) || [];
                stateList = PVX.data.stateSeries(d) || [];
                sourceAsset = '';
                for (var i = 0; i < series.length && !sourceAsset; i++) { sourceAsset = PVX.nav.assetOf(series[i].path); }
                fetchEvents(false);
            },
            onConfigChange: function () { fetchEvents(false); },
            onDestroy: function () {
                traceEditor.destroy();
                if (events.timer !== null) { clearInterval(events.timer); events.timer = null; }
                events.gen += 1;
            },
            render: render
        });

        /* ------------------------------------------------------------------ *
         * event frames
         * ------------------------------------------------------------------ */

        function trim(v) { return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, ''); }

        function isEditMode() {
            try { if (scope && scope.runtimeData && scope.runtimeData.isEditMode) { return true; } } catch (e) { /* shape differs */ }
            try { if (scope && scope.$root && scope.$root.isEditMode) { return true; } } catch (e2) { /* ignore */ }
            return false;
        }

        /** The window the traces cover, as the render will compute it. */
        function dataWindow() {
            var lo = null, hi = null;
            for (var i = 0; i < series.length; i++) {
                var pts = series[i].points || [];
                if (!pts.length) { continue; }
                if (lo === null || pts[0].t < lo) { lo = pts[0].t; }
                if (hi === null || pts[pts.length - 1].t > hi) { hi = pts[pts.length - 1].t; }
            }
            return lo === null || !(hi > lo) ? null : { from: lo, to: hi };
        }

        /** A path resolved once; a failure is forgotten so an outage cannot stick. */
        function cached(store, key, make) {
            if (store[key]) { return store[key]; }
            var p = make();
            p['catch'](function () { if (store[key] === p) { delete store[key]; } });
            store[key] = p;
            return p;
        }

        function ensureTimer(cfg) {
            var secs = PVX.util.num(cfg.EventRefreshSeconds);
            secs = cfg.ShowEvents ? PVX.util.clamp(secs === null ? 60 : secs, 10, 86400) : 0;
            if (secs === events.timerSecs) { return; }
            if (events.timer !== null) { clearInterval(events.timer); events.timer = null; }
            events.timerSecs = secs;
            if (secs) { events.timer = setInterval(function () { fetchEvents(true); }, secs * 1000); }
        }

        function fetchEvents(force) {
            if (!ctx || ctx.destroyed) { return; }
            var cfg = scope.config || {};
            ensureTimer(cfg);
            if (!cfg.ShowEvents) {
                if (events.phase !== 'off') { events.phase = 'off'; events.items = []; events.key = ''; ctx.render(); }
                return;
            }
            var win = dataWindow();
            if (!win) { return; }

            if (PVX.api.discovering()) {
                PVX.api.discover().then(function () { fetchEvents(true); });
                return;
            }
            if (!PVX.api.isConfigured()) {
                events.phase = 'unconfigured';
                events.key = '';
                ctx.render();
                return;
            }

            var byAsset = cfg.EventScope !== 'database';
            var asset = trim(PVX.nav.currentAsset()) || sourceAsset;
            var typed = trim(cfg.EventDatabasePath);
            var db = typed ? { path: typed, from: '' } : PVX.nav.defaultDatabase(scope, sourceAsset);
            var max = Math.round(PVX.util.clamp(PVX.util.num(cfg.EventMax) || 50, 1, 500));

            // Refetch only when the window has moved by a fiftieth of its
            // length; a rolling display updates every few seconds.
            var grain = Math.max(1000, (win.to - win.from) / 50);
            var key = [byAsset ? 'a:' + asset : 'd:' + db.path, trim(cfg.EventTemplate), trim(cfg.EventNameFilter), max,
                Math.floor(win.from / grain), Math.floor(win.to / grain)].join('\u0001');
            if (!force && key === events.key) { return; }
            events.key = key;
            events.db = db;

            if (byAsset && !asset) {
                events.phase = 'error';
                events.error = { pvxError: { message: 'Events follow the display\'s asset, but the address names none and no data source is an AF attribute.',
                    check: 'open the display on an asset, or set Events from to the whole database' } };
                ctx.render();
                return;
            }
            if (!byAsset && !db.path) {
                events.phase = 'error';
                events.error = { pvxError: { message: 'No AF database to search for events.',
                    check: 'set the event database in Format, or drop an AF attribute on the chart' } };
                ctx.render();
                return;
            }

            var gen = ++events.gen;
            if (events.phase !== 'ok') { events.phase = 'loading'; }
            var where = byAsset ?
                cached(elementCache, asset, function () {
                    return PVX.api.elementByPath(asset).then(function (el) {
                        if (!el || !el.WebId) { throw { pvxError: { message: 'No AF element at "' + asset + '".', check: 'the display\'s asset' } }; }
                        return { elementWebId: el.WebId };
                    });
                }) :
                cached(dbCache, db.path, function () {
                    return PVX.api.get('assetdatabases?path=' + encodeURIComponent(db.path)).then(function (d) {
                        if (!d || !d.WebId) { throw { pvxError: { message: 'No AF database at "' + db.path + '".', check: 'the event database in Format' } }; }
                        return { databaseWebId: d.WebId };
                    });
                });

            where.then(function (w) {
                if (gen !== events.gen) { return null; }
                return PVX.api.eventFrames({
                    elementWebId: w.elementWebId,
                    databaseWebId: w.databaseWebId,
                    startTime: new Date(win.from).toISOString(),
                    endTime: new Date(win.to).toISOString(),
                    templateName: trim(cfg.EventTemplate),
                    nameFilter: trim(cfg.EventNameFilter),
                    searchMode: 'Overlapped',
                    maxCount: max + 1,
                    selectedFields: 'Items.Name;Items.StartTime;Items.EndTime;Items.TemplateName;Items.WebId'
                }, { cache: false });
            }).then(function (res) {
                if (res === null || gen !== events.gen || ctx.destroyed) { return; }
                var raw = (res && res.Items) || [];
                events.capped = raw.length > max;
                events.max = max;
                if (events.capped) { raw = raw.slice(0, max); }
                var out = [];
                for (var i = 0; i < raw.length; i++) {
                    var st = Date.parse(raw[i].StartTime);
                    if (isNaN(st)) { continue; }
                    var en = Date.parse(raw[i].EndTime);
                    // AF writes an open event's end as 9999-12-31, or leaves it out.
                    var open = isNaN(en) || new Date(en).getUTCFullYear() >= 9999;
                    out.push({ name: raw[i].Name || 'Event', start: st, end: open ? null : en,
                        template: raw[i].TemplateName || '' });
                }
                out.sort(function (a, b) { return a.start - b.start; });
                events.items = out;
                events.phase = 'ok';
                events.error = null;
                ctx.render();
            })['catch'](function (err) {
                if (gen !== events.gen || ctx.destroyed) { return; }
                events.phase = 'error';
                events.error = err;
                events.items = [];
                // Ask again on the next window move or tick, not on every update.
                ctx.render();
            });
        }

        /** Shaded spans behind the traces, with names along the top. */
        function drawEvents(parent, cfg, plot, sx, tMin, tMax, t, font) {
            if (events.phase !== 'ok' || !events.items.length) { return 0; }
            var op = PVX.util.num(cfg.EventOpacity);
            op = op === null ? 0.12 : PVX.util.clamp(op, 0, 1);
            var templates = [];
            events.items.forEach(function (ev) { if (templates.indexOf(ev.template) === -1) { templates.push(ev.template); } });
            templates.sort();
            var pal = PVX.color.categorical;
            var fixed = cfg.EventColor && PVX.color.toRgb(cfg.EventColor) ? cfg.EventColor : '';
            var clickable = cfg.EventClick === 'time';
            var g = PVX.svg.el('g', { 'class': 'pvx-combo-events' }, parent);
            var drawn = 0;
            var lastLabelEnd = -Infinity;
            for (var i = 0; i < events.items.length; i++) {
                var ev = events.items[i];
                var end = ev.end === null ? tMax : ev.end;
                if (end < tMin || ev.start > tMax) { continue; }
                var x0 = sx(Math.max(ev.start, tMin));
                var x1 = Math.max(x0 + 1, sx(Math.min(end, tMax)));
                var col = fixed || pal[templates.indexOf(ev.template) % pal.length];
                var tip = ev.name + (ev.template ? ' (' + ev.template + ')' : '') + '\n' +
                    PVX.fmt.time(ev.start, 'datetime') + ' to ' + (ev.end === null ? 'still running' : PVX.fmt.time(ev.end, 'datetime')) +
                    (ev.end === null ? '' : ' \u00b7 ' + PVX.fmt.duration(ev.end - ev.start)) +
                    (clickable ? '\nClick to show this event' : '');
                var r = PVX.svg.el('rect', {
                    'class': 'pvx-combo-event' + (clickable ? ' pvx-combo-event-link' : ''),
                    x: x0.toFixed(2), y: plot.y.toFixed(2), width: (x1 - x0).toFixed(2), height: plot.h.toFixed(2),
                    fill: col, 'fill-opacity': op
                }, g);
                PVX.svg.el('title', null, r).textContent = tip;
                if (clickable) { bindEventClick(r, ev, tMax); }
                PVX.svg.el('line', { x1: x0.toFixed(2), y1: plot.y.toFixed(2), x2: x0.toFixed(2), y2: plot.y1.toFixed(2),
                    stroke: col, 'stroke-opacity': Math.min(1, op * 5), 'stroke-width': 1, 'pointer-events': 'none' }, g);
                // A name only where there is room for it and it does not run
                // into the one before; the tooltip always has it.
                if (cfg.EventLabels !== false && x0 >= lastLabelEnd + 4) {
                    var room = plot.x1 - x0 - 4;
                    var label = room > font * 2 ? fitText(ev.name, Math.min(room, Math.max(x1 - x0, font * 10)), font) : '';
                    if (label) {
                        PVX.svg.text(g, (x0 + 3).toFixed(2), (plot.y + font * 0.9).toFixed(2), label, {
                            'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted, 'pointer-events': 'none'
                        });
                        lastLabelEnd = x0 + 3 + textW(label, font);
                    }
                }
                drawn += 1;
            }
            return drawn;
        }

        function bindEventClick(rect, ev, tMax) {
            rect.addEventListener('click', function () {
                if (isEditMode()) { return; }
                var end = ev.end === null ? Math.max(tMax, Date.now()) : ev.end;
                var pad = Math.max(60000, (end - ev.start) * 0.1);
                PVX.nav.setTimeRange(new Date(ev.start - pad).toISOString(), new Date(end + pad).toISOString());
            }, false);
        }

        function eventNote(cfg, drawn) {
            if (!cfg.ShowEvents) { return ''; }
            switch (events.phase) {
                case 'unconfigured': return 'events: ' + PVX.api.unsetHint() + ', then confirm it with ext/piwebapi-check.html';
                case 'loading': return 'events: loading';
                case 'error':
                    var e = (events.error && events.error.pvxError) || {};
                    return 'events: ' + (e.message || 'the request failed') + (e.check ? ' Check: ' + e.check + '.' : '');
                case 'ok':
                    if (!events.items.length) { return 'no events in this window'; }
                    return drawn + (drawn === 1 ? ' event' : ' events') +
                        (events.capped ? ', the first ' + events.max + ' only: raise the limit or narrow the template' : '');
                default: return '';
            }
        }

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
            var usedBy = {};
            for (var s = 0; s < list.length; s++) {
                var e = byIndex[s + 1] || null;
                var type = (e && e.type) || defType;
                if (type === 'hidden') { continue; }
                // The upper edge of the range before it: drawn there, not here.
                if (usedBy[s]) { continue; }
                if (type === 'range') {
                    if (s + 1 < list.length) { usedBy[s + 1] = true; } else { type = 'line'; out.rangeAlone = s + 1; }
                }
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
                    raw: type === 'states' ? [] : (list[s].points || []),
                    // The text values, for state bands and the rulers' table.
                    states: stateList[s] ? stateList[s].points : [],
                    upper: type === 'range' ? list[s + 1] : null,
                    pts: [],          // decimated, for line/area/step/scatter
                    pts2: [],         // decimated upper edge of a range
                    slots: null,      // aggregated, for bars
                    ma: e && e.ma ? parseMa(e.ma) : null,
                    maBad: !!(e && e.ma && !parseMa(e.ma)),
                    fit: !!(e && e.fit),
                    decimated: false,
                    last: null
                });
                var tr = out[out.length - 1];
                if (type === 'states') { tr.axis = 'none'; }
                if (type === 'range') {
                    tr.label = tr.label + ' \u2013 ' + (list[s + 1].label || ('Series ' + (s + 2)));
                    tr.raw2 = list[s + 1].points || [];
                }
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

        /** Points above zero: the only ones a log scale can place. */
        function positive(points) {
            var out = [];
            for (var i = 0; i < points.length; i++) { if (points[i].v > 0) { out.push(points[i]); } }
            return out;
        }

        function axisTicks(d, log, count) {
            return log ? logTicks(d[0], d[1]) : PVX.scale.ticks(d[0], d[1], count);
        }

        /** Domain for one axis, honouring explicit bounds and a bar baseline. */
        function domainFor(values, minCfg, maxCfg, needsZero, tickCount, log) {
            var lo = null, hi = null, i;
            for (i = 0; i < values.length; i++) {
                var v = values[i];
                if (!PVX.util.isNum(v) || (log && !(v > 0))) { continue; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            }
            if (log) {
                // Out to the next 1, 2 or 5, so the ends are round numbers
                // that logTicks marks; whole decades left a tag reading 60 to
                // 120 squeezed into a third of a 10 to 1000 axis. A bar on a
                // log axis stands on the bottom of the axis, not on zero.
                if (lo === null) { lo = 1; hi = 10; }
                var dlo = logSnap(lo, false), dhi = logSnap(hi, true);
                if (!(dhi > dlo)) { dhi = logSnap(dlo * 1.01, true); }
                var lMin = PVX.util.num(minCfg), lMax = PVX.util.num(maxCfg);
                if (lMin !== null && lMin > 0) { dlo = lMin; }
                if (lMax !== null && lMax > dlo) { dhi = lMax; }
                return [dlo, dhi];
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
                if (traces[i].raw.length || (traces[i].type === 'states' && traces[i].states.length)) { anyPoints = true; break; }
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
                var rp = traces[i].type === 'states' ? traces[i].states : traces[i].raw;
                if (!rp.length) { continue; }
                if (tMin === null || rp[0].t < tMin) { tMin = rp[0].t; }
                if (tMax === null || rp[rp.length - 1].t > tMax) { tMax = rp[rp.length - 1].t; }
                traces[i].last = traces[i].type === 'states' ? rp[rp.length - 1].state : rp[rp.length - 1].v;
            }
            if (tMin === null) { tMin = 0; tMax = 1; }
            if (!(tMax > tMin)) { tMax = tMin + 1; }

            // ---- which axes are actually in play -----------------------------
            var rightUsed = false, leftUsed = false;
            var barsLeft = false, barsRight = false;
            for (i = 0; i < traces.length; i++) {
                if (traces[i].axis === 'none') { continue; }
                if (traces[i].axis === 'right') { rightUsed = true; } else { leftUsed = true; }
                if (traces[i].type === 'bar') {
                    if (traces[i].axis === 'right') { barsRight = true; } else { barsLeft = true; }
                }
            }
            // Drop the right axis entirely when nothing uses it — reserving its
            // margin would shrink the plot for no information at all.
            var drawRight = rightUsed && cfg.ShowRightAxis !== false;
            var drawLeft = leftUsed && cfg.ShowLeftAxis !== false;
            var logL = trim(cfg.LeftScale).toLowerCase() === 'log';
            var logR = trim(cfg.RightScale).toLowerCase() === 'log';
            var logOf = function (tr) { return tr.axis === 'right' ? logR : logL; };
            var notes = [];

            // Separate panels: one strip per trace that has an axis. They
            // share the time axis and nothing else, so the right axis goes.
            var drawn = [];
            for (i = 0; i < traces.length; i++) { if (traces[i].axis !== 'none') { drawn.push(traces[i]); } }
            var panelMode = trim(cfg.Panels).toLowerCase() === 'separate' && drawn.length > 0;
            if (panelMode) {
                drawLeft = cfg.ShowLeftAxis !== false;
                drawRight = false;
            }

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
            var logDropped = 0;
            for (i = 0; i < traces.length; i++) {
                if (traces[i].axis === 'none' || !logOf(traces[i])) { continue; }
                var kept = positive(traces[i].raw), kept2 = traces[i].raw2 ? positive(traces[i].raw2) : null;
                logDropped += traces[i].raw.length - kept.length + (kept2 ? traces[i].raw2.length - kept2.length : 0);
                traces[i].raw = kept;
                if (kept2) { traces[i].raw2 = kept2; }
            }
            var provL = collectRaw(traces, 'left');
            var provR = collectRaw(traces, 'right');
            var provLd = domainFor(provL, cfg.LeftMin, cfg.LeftMax, barsLeft, tickCount, logL);
            var provRd = domainFor(provR, cfg.RightMin, cfg.RightMax, barsRight, tickCount, logR);
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
            // In separate panels each bar trace is alone in its strip.
            var stack = !!cfg.StackBars && !panelMode;
            if (cfg.StackBars && panelMode && barTraces.length > 1) { notes.push('bars are not stacked in separate panels'); }
            var groupOf = {};
            var groupCount = 0;
            for (i = 0; i < barTraces.length; i++) {
                var key = panelMode ? 'panel' : (stack ? ('axis:' + barTraces[i].axis) : ('trace:' + barTraces[i].index));
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
                if (tr.type === 'states') { continue; }
                // A moving average and a fit come from every sample, before
                // anything is thinned for drawing.
                if (tr.ma && tr.raw.length) { tr.maPts = decimate(movingAverage(tr.raw, tr.ma), buckets); }
                if (tr.fit) { tr.fitLine = fitLine(tr.raw); }
                if (tr.type === 'bar') { continue; }
                tr.pts = decimate(tr.raw, buckets);
                if (tr.pts.length < tr.raw.length) { tr.decimated = true; }
                if (tr.raw2) { tr.pts2 = decimate(tr.raw2, buckets); }
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

            var ld = domainFor(leftVals, cfg.LeftMin, cfg.LeftMax, barsLeft, tickCount, logL);
            var rd = domainFor(rightVals, cfg.RightMin, cfg.RightMax, barsRight, tickCount, logR);

            var lTicks = axisTicks(ld, logL, tickCount);
            var rTicks = axisTicks(rd, logR, tickCount);

            // Each panel's own domain, from what it will draw. Explicit axis
            // bounds still apply to the traces on that axis.
            var panelTicks = Math.min(tickCount, 4);
            if (panelMode) {
                for (i = 0; i < drawn.length; i++) {
                    tr = drawn[i];
                    var pv = collectDrawn([tr], tr.axis, false, null);
                    if (tr.axis === 'left') { for (j = 0; j < bandList.length; j++) { pv.push(bandList[j].value); } }
                    tr.pd = tr.axis === 'right'
                        ? domainFor(pv, cfg.RightMin, cfg.RightMax, tr.type === 'bar', panelTicks, logR)
                        : domainFor(pv, cfg.LeftMin, cfg.LeftMax, tr.type === 'bar', panelTicks, logL);
                    tr.pt = axisTicks(tr.pd, logOf(tr), panelTicks);
                }
            }

            // ---- legend layout (needs the final width, not the plot rect) ----
            var legend = null;
            if (wantLegend) {
                legend = layoutLegend(traces, cfg, W - 12, legendFont, rightUsed, H);
            }
            var legendH = legend ? legend.height : 0;

            var mT = 5 + (legend && legendPos !== 'bottom' ? legendH : 0);
            var mB = 5 + (showTimeTicks ? tickFont + 6 : 2) +
                     (legend && legendPos === 'bottom' ? legendH : 0);
            var PANEL_GAP = 6;
            if (panelMode) {
                var plotH0 = Math.max(10, H - Math.min(mT, H * 0.45) - Math.min(mB, H * 0.45));
                if ((plotH0 - PANEL_GAP * (drawn.length - 1)) / drawn.length < 24) {
                    // Too short to read a scale per trace: say so, and share.
                    notes.push('too short for ' + drawn.length + ' separate panels, so they share axes');
                    panelMode = false;
                    drawRight = rightUsed && cfg.ShowRightAxis !== false;
                    drawLeft = leftUsed && cfg.ShowLeftAxis !== false;
                }
            }
            var m = margins(ld, rd);

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
            var syL = yScale(ld, logL, plot.y1, plot.y);   // SVG y grows down
            var syR = yScale(rd, logR, plot.y1, plot.y);

            // Strips for separate panels, top to bottom in data source order.
            if (panelMode) {
                var ph = (plot.h - PANEL_GAP * (drawn.length - 1)) / drawn.length;
                for (i = 0; i < drawn.length; i++) {
                    var py = plot.y + i * (ph + PANEL_GAP);
                    drawn[i].panel = { x: plot.x, y: py, w: plot.w, h: ph, x1: plot.x1, y1: py + ph };
                    drawn[i].psy = yScale(drawn[i].pd, logOf(drawn[i]), py + ph, py);
                }
            }

            // ---- limit bands (LEFT axis, underneath everything) --------------
            var bandOpacity = PVX.util.num(cfg.LimitBandOpacity);
            bandOpacity = bandOpacity === null ? 0.14 : PVX.util.clamp(bandOpacity, 0, 1);
            if (bandList.length && bandOpacity > 0) {
                if (panelMode) {
                    for (i = 0; i < drawn.length; i++) {
                        if (drawn[i].axis !== 'left') { continue; }
                        drawBands(svgRoot, bandSpec, drawn[i].pd, drawn[i].psy, drawn[i].panel, t, bandOpacity, tickFont, showTicks);
                    }
                } else {
                    drawBands(svgRoot, bandSpec, ld, syL, plot, t, bandOpacity, tickFont, showTicks);
                }
            }

            // ---- digital states, as lanes of shaded bands ----------------------
            var stateSummary = drawStateLanes(svgRoot, traces, cfg, plot, sx, tMin, tMax, t, tickFont);

            // ---- event frames (under the grid and the traces) ----------------
            var eventsDrawn = drawEvents(svgRoot, cfg, plot, sx, tMin, tMax, t, tickFont);

            // ---- grid ---------------------------------------------------------
            var timeTicks = buildTimeTicks(cfg, tMin, tMax, plot.w, tickFont);
            if (cfg.ShowGrid !== false) {
                if (panelMode) {
                    for (i = 0; i < drawn.length; i++) {
                        for (j = 0; j < drawn[i].pt.length; j++) {
                            var gy = drawn[i].psy(drawn[i].pt[j]);
                            gridLine(svgRoot, plot.x, gy, plot.x1, gy, t.grid);
                        }
                    }
                } else {
                    // Horizontal lines follow the LEFT axis when it exists:
                    // gridlines for two different scales would draw a lattice
                    // that means nothing on either.
                    var gridTicks = drawLeft || !drawRight ? lTicks : rTicks;
                    var gridScale = drawLeft || !drawRight ? syL : syR;
                    for (i = 0; i < gridTicks.length; i++) {
                        gridLine(svgRoot, plot.x, gridScale(gridTicks[i]), plot.x1, gridScale(gridTicks[i]), t.grid);
                    }
                }
                for (i = 0; i < timeTicks.length; i++) {
                    var gx = sx(timeTicks[i]);
                    gridLine(svgRoot, gx, plot.y, gx, plot.y1, t.grid);
                }
            }

            // ---- clip everything data-driven ------------------------------------
            var clipId = host.getAttribute('data-pvx-clip') || PVX.util.uid('comboclip');
            host.setAttribute('data-pvx-clip', clipId);
            var defs = PVX.svg.el('defs', null, svgRoot);
            var clipRects = panelMode ? drawn.map(function (d) { return d.panel; }) : [plot];
            var clip = PVX.svg.el('clipPath', { id: clipId }, defs);
            for (i = 0; i < clipRects.length; i++) {
                PVX.svg.el('rect', {
                    x: clipRects[i].x.toFixed(2), y: clipRects[i].y.toFixed(2),
                    width: clipRects[i].w.toFixed(2), height: clipRects[i].h.toFixed(2)
                }, clip);
            }
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
                if (panelMode) {
                    return { plot: tr.panel, sx: sx, sy: tr.psy, domain: tr.pd,
                        cfg: cfg, theme: t, numOpts: numOpts, tips: tips };
                }
                return {
                    plot: plot, sx: sx,
                    sy: tr.axis === 'right' ? syR : syL,
                    domain: tr.axis === 'right' ? rd : ld,
                    cfg: cfg, theme: t, numOpts: numOpts, tips: tips
                };
            };

            if (slots) {
                if (panelMode) {
                    for (i = 0; i < barTraces.length; i++) {
                        tr = barTraces[i];
                        drawBars(plotG, [tr], {
                            plot: tr.panel, slots: slots, groups: 1, stack: false,
                            syL: tr.psy, syR: tr.psy, ld: tr.pd, rd: tr.pd,
                            tMin: tMin, tMax: tMax, cfg: cfg, theme: t, numOpts: numOpts, tips: tips
                        });
                    }
                } else {
                    drawBars(plotG, barTraces, {
                        plot: plot, slots: slots, groups: Math.max(1, groupCount),
                        stack: stack, syL: syL, syR: syR, ld: ld, rd: rd,
                        tMin: tMin, tMax: tMax, cfg: cfg, theme: t,
                        numOpts: numOpts, tips: tips
                    });
                }
            }

            var order = ['range', 'area', 'step', 'line', 'scatter'];
            for (var o = 0; o < order.length; o++) {
                for (i = 0; i < traces.length; i++) {
                    if (traces[i].type !== order[o]) { continue; }
                    drawTrace(plotG, traces[i], traceOpts(traces[i]));
                }
            }
            // Moving averages and fits over every trace, bars included.
            for (i = 0; i < traces.length; i++) {
                if (traces[i].axis !== 'none' && (traces[i].maPts || traces[i].fitLine)) {
                    drawDerived(plotG, traces[i], traceOpts(traces[i]), tMin, tMax);
                }
            }

            // ---- axis lines, ticks, labels -----------------------------------------
            if (panelMode) {
                for (i = 0; i < drawn.length; i++) {
                    var P = drawn[i].panel;
                    gridLine(svgRoot, P.x, P.y1, P.x1, P.y1, t.axis);
                    if (drawLeft) { gridLine(svgRoot, P.x, P.y, P.x, P.y1, t.axis); }
                    if (showTicks && drawLeft) {
                        for (j = 0; j < drawn[i].pt.length; j++) {
                            PVX.svg.text(svgRoot, (P.x - 4).toFixed(2), drawn[i].psy(drawn[i].pt[j]).toFixed(2),
                                PVX.fmt.tick(drawn[i].pt[j]), {
                                    'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end',
                                    'font-size': tickFont, fill: t.textMuted
                                });
                        }
                    }
                    // Which trace a strip is, in its corner: the scales differ,
                    // so the colour key alone is not enough.
                    if (P.h >= tickFont + 6 && P.w > 80) {
                        PVX.svg.text(svgRoot, (P.x + 4).toFixed(2), (P.y + tickFont * 0.75).toFixed(2),
                            fitText(drawn[i].label + (drawn[i].units ? ' (' + drawn[i].units + ')' : ''), P.w * 0.6, tickFont), {
                                'class': 'pvx-svg-label pvx-combo-panel-label', 'font-size': tickFont,
                                fill: drawn[i].color, 'pointer-events': 'none'
                            });
                    }
                }
            } else {
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
            }

            if (showTimeTicks) {
                for (i = 0; i < timeTicks.length; i++) {
                    drawTimeLabel(svgRoot, sx(timeTicks[i]), plot.y1 + 4 + tickFont * 0.6,
                        PVX.fmt.time(timeTicks[i], 'short'), W, tickFont, t);
                }
            }

            if (showAxisTitles && drawLeft && cfg.LeftLabel && !panelMode) {
                axisTitle(svgRoot, titleFont * 0.8 + 1, plot.y + plot.h / 2,
                    fitText(cfg.LeftLabel, plot.h, titleFont), -90, titleFont, t);
            }
            if (showAxisTitles && drawRight && cfg.RightLabel) {
                axisTitle(svgRoot, W - titleFont * 0.8 - 1, plot.y + plot.h / 2,
                    fitText(cfg.RightLabel, plot.h, titleFont), 90, titleFont, t);
            }

            // ---- rulers --------------------------------------------------------------
            drawRulers(svgRoot, cfg, plot, sx, tMin, tMax, t, tickFont, traces);

            // ---- legend --------------------------------------------------------------
            if (legend) {
                drawLegend(svgRoot, legend, 6,
                    legendPos === 'bottom' ? (H - legendH + 1) : 3,
                    legendFont, t);
            }

            // ---- footer note ------------------------------------------------------------
            var decCount = 0;
            for (i = 0; i < traces.length; i++) { if (traces[i].decimated) { decCount += 1; } }
            if (logDropped) {
                notes.push(logDropped + (logDropped === 1 ? ' value' : ' values') + ' at or below 0 not drawn on the log scale');
            }
            if (traces.rangeAlone) { notes.push('trace ' + traces.rangeAlone + ' is a range but has no next source, so it is a line'); }
            for (i = 0; i < traces.length; i++) {
                if (traces[i].maBad) { notes.push(traces[i].label + ': moving average is not a count or a time such as 1h, so none is drawn'); }
                if (traces[i].fit && !traces[i].fitLine && traces[i].raw.length) { notes.push(traces[i].label + ': too few values for a fit'); }
            }
            if (stateSummary) { notes.push(stateSummary); }
            if (decCount) {
                notes.push(decCount + (decCount === 1 ? ' trace' : ' traces') + ' decimated to fit');
            }
            if (barTraces.length && slots) {
                notes.push(slots + (slots === 1 ? ' bar slot' : ' bar slots'));
            }
            var evNote = eventNote(cfg, eventsDrawn);
            if (evNote) { notes.push(evNote); }
            scope.pvx.note = showNote ? notes.join(' · ') : '';

            digest();

            /* -------------------------------------------------------------- *
             * closures over the current frame
             * -------------------------------------------------------------- */

            /** Margins from the ACTUAL tick strings, so a "1,234,567" axis is
             *  never clipped and a "0..5" axis does not waste half the width. */
            function margins(leftDomain, rightDomain) {
                var lw = 0, rw = 0, q;
                // The provisional pass runs before the panels have domains;
                // the shared one is near enough to set the width bars use.
                if (showTicks && drawLeft && panelMode && drawn[0].pt) {
                    for (var pi = 0; pi < drawn.length; pi++) {
                        for (q = 0; q < drawn[pi].pt.length; q++) {
                            lw = Math.max(lw, textW(PVX.fmt.tick(drawn[pi].pt[q]), tickFont));
                        }
                    }
                } else if (showTicks && drawLeft) {
                    var lt = axisTicks(leftDomain, logL, tickCount);
                    for (q = 0; q < lt.length; q++) {
                        lw = Math.max(lw, textW(PVX.fmt.tick(lt[q]), tickFont));
                    }
                }
                if (showTicks && drawRight) {
                    var rt = axisTicks(rightDomain, logR, tickCount);
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
                p = traces[i].raw2 || [];
                for (j = 0; j < p.length; j++) { out.push(p[j].v); }
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
                    for (j = 0; j < tr.pts2.length; j++) { out.push(tr.pts2[j].v); }
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
            } else if (tr.type === 'range') {
                var xy2 = [];
                for (var u = 0; u < tr.pts2.length; u++) {
                    xy2.push({ x: L.sx(tr.pts2[u].t), y: L.sy(PVX.util.clamp(tr.pts2[u].v, lo, hi)) });
                }
                var ro = PVX.util.num(L.cfg.AreaOpacity);
                ro = ro === null ? 0.25 : PVX.util.clamp(ro, 0, 1);
                if (xy2.length) {
                    // Upper edge left to right, then the lower edge back: a
                    // closed band whatever times either source reported at.
                    var d = PVX.svg.line(xy2, false) + ' L' + PVX.svg.line(xy.slice().reverse(), false).slice(1) + ' Z';
                    PVX.svg.el('path', { d: d, fill: tr.color, 'fill-opacity': ro, stroke: 'none', 'class': 'pvx-combo-range' }, g);
                    PVX.svg.el('path', { d: PVX.svg.line(xy2, false), fill: 'none', stroke: tr.color, 'stroke-width': Math.max(0.8, lw * 0.6),
                        'stroke-opacity': 0.8, 'vector-effect': 'non-scaling-stroke', 'class': 'pvx-combo-line' }, g);
                }
                PVX.svg.el('path', { d: PVX.svg.line(xy, false), fill: 'none', stroke: tr.color, 'stroke-width': Math.max(0.8, lw * 0.6),
                    'stroke-opacity': 0.8, 'vector-effect': 'non-scaling-stroke', 'class': 'pvx-combo-line' }, g);
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

        /** A trace's moving average (dashed) and straight-line fit (dotted). */
        function drawDerived(parent, tr, L, tMin, tMax) {
            var lo = Math.min(L.domain[0], L.domain[1]);
            var hi = Math.max(L.domain[0], L.domain[1]);
            var lw = tr.width !== null ? tr.width : PVX.util.num(L.cfg.LineWidth);
            lw = lw === null ? 1.8 : PVX.util.clamp(lw, 0.3, 8);
            var g = PVX.svg.el('g', { 'class': 'pvx-combo-derived' }, parent);
            if (tr.maPts && tr.maPts.length) {
                var xy = [];
                for (var i = 0; i < tr.maPts.length; i++) {
                    xy.push({ x: L.sx(tr.maPts[i].t), y: L.sy(PVX.util.clamp(tr.maPts[i].v, lo, hi)) });
                }
                var p = PVX.svg.el('path', {
                    d: PVX.svg.line(xy, false), fill: 'none', stroke: tr.color, 'stroke-width': lw + 0.6,
                    'stroke-dasharray': (6 * lw).toFixed(1) + ' ' + (3 * lw).toFixed(1), 'stroke-opacity': 0.9,
                    'vector-effect': 'non-scaling-stroke', 'class': 'pvx-combo-ma'
                }, g);
                if (L.tips) { PVX.svg.el('title', null, p).textContent = tr.label + ': moving average over ' + tr.ma.text; }
            }
            if (tr.fitLine) {
                var f = tr.fitLine;
                var t0 = tr.raw[0].t, t1 = tr.raw[tr.raw.length - 1].t;
                var fl = PVX.svg.el('line', {
                    x1: L.sx(t0).toFixed(2), y1: L.sy(PVX.util.clamp(f.at(t0), lo, hi)).toFixed(2),
                    x2: L.sx(t1).toFixed(2), y2: L.sy(PVX.util.clamp(f.at(t1), lo, hi)).toFixed(2),
                    stroke: tr.color, 'stroke-width': Math.max(1, lw), 'stroke-dasharray': '1.5 3',
                    'stroke-linecap': 'round', 'class': 'pvx-combo-fit'
                }, g);
                if (L.tips) {
                    PVX.svg.el('title', null, fl).textContent = tr.label + ': trend ' + slopeText(f, tr.units, L.numOpts) +
                        ', R\u00b2 ' + f.r2.toFixed(2);
                }
            }
        }

        function slopeText(f, units, numOpts) {
            var sgn = f.slope > 0 ? '+' : '';
            return sgn + PVX.fmt.number(f.slope, numOpts) + (units ? ' ' + units : '') + ' per hour';
        }

        /* ------------------------------------------------------------------ *
         * digital states
         * ------------------------------------------------------------------ */

        /**
         * One lane per "states" trace across the plot, each state a shaded
         * span from its timestamp to the next. Colours come from StateColors,
         * then the palette in order of first appearance, so the same state
         * keeps its colour across lanes. Returns a footer note, or ''.
         */
        function drawStateLanes(parent, traces, cfg, plot, sx, tMin, tMax, t, font) {
            var lanes = [];
            for (var i = 0; i < traces.length; i++) { if (traces[i].type === 'states') { lanes.push(traces[i]); } }
            if (!lanes.length) { return ''; }
            var fixed = {};
            var list = PVX.states.parse(cfg.StateColors || '', 'colors');
            for (i = 0; i < list.length; i++) { if (list[i].color) { fixed[list[i].state.toLowerCase()] = list[i].color; } }
            // A state with no colour of its own takes the next palette
            // colour that is not close to one already given: "Auto" shaded
            // the same red as a listed "Stopped" reads as the same state.
            var taken = [];
            for (var fk in fixed) { if (fixed.hasOwnProperty(fk)) { taken.push(PVX.color.toRgb(fixed[fk])); } }
            var near = function (c) {
                var rgb = PVX.color.toRgb(c);
                for (var q = 0; q < taken.length; q++) {
                    if (rgb && taken[q] && Math.abs(rgb.r - taken[q].r) + Math.abs(rgb.g - taken[q].g) + Math.abs(rgb.b - taken[q].b) < 120) { return true; }
                }
                return false;
            };
            var pal = [];
            var basePal = t.categorical || PVX.color.categorical;
            for (var pi = 0; pi < basePal.length; pi++) { if (!near(basePal[(pi + 3) % basePal.length])) { pal.push(basePal[(pi + 3) % basePal.length]); } }
            if (!pal.length) { pal = basePal; }
            var seen = [];
            var colourOf = function (st) {
                var k = st.toLowerCase();
                if (fixed[k]) { return fixed[k]; }
                var n = seen.indexOf(k);
                if (n === -1) { seen.push(k); n = seen.length - 1; }
                return pal[n % pal.length];
            };
            var op = PVX.util.num(cfg.StateOpacity);
            op = op === null ? 0.18 : PVX.util.clamp(op, 0.02, 1);
            var laneH = plot.h / lanes.length;
            var g = PVX.svg.el('g', { 'class': 'pvx-combo-states' }, parent);
            var empty = 0;
            for (var l = 0; l < lanes.length; l++) {
                var pts = lanes[l].states;
                var y0 = plot.y + l * laneH;
                if (!pts.length) { empty += 1; continue; }
                lanes[l].stateColor = colourOf;
                for (var j = 0; j < pts.length; j++) {
                    var a = Math.max(pts[j].t, tMin), b = j + 1 < pts.length ? pts[j + 1].t : tMax;
                    if (!(b > a)) { continue; }
                    var st = pts[j].state;
                    var col = colourOf(st);
                    var x0 = sx(a), x1 = Math.max(x0 + 0.5, sx(b));
                    var r = PVX.svg.el('rect', {
                        x: x0.toFixed(2), y: y0.toFixed(2), width: (x1 - x0).toFixed(2), height: laneH.toFixed(2),
                        fill: col, 'fill-opacity': op, 'class': 'pvx-combo-state'
                    }, g);
                    PVX.svg.el('title', null, r).textContent = lanes[l].label + ': ' + st + '\n' +
                        PVX.fmt.time(pts[j].t, 'datetime') + ' \u00b7 ' + PVX.fmt.duration(b - pts[j].t);
                    // The state's name where its span is wide enough to hold it.
                    if (x1 - x0 > font * 3 && laneH >= font + 4) {
                        var label = fitText(st, x1 - x0 - 6, font * 0.9);
                        if (label) {
                            PVX.svg.text(g, (x0 + 3).toFixed(2), (y0 + laneH - font * 0.55).toFixed(2), label, {
                                'class': 'pvx-svg-label pvx-combo-state-label', 'font-size': (font * 0.9).toFixed(1),
                                fill: col, 'pointer-events': 'none'
                            });
                        }
                    }
                }
            }
            return empty ? empty + (empty === 1 ? ' state lane' : ' state lanes') + ' with no values' : '';
        }

        /* ------------------------------------------------------------------ *
         * rulers
         * ------------------------------------------------------------------ */

        /**
         * The rulers and, through scope.pvx.rulers, the table under the chart.
         * The overlay that takes clicks is drawn only when Rulers is on and
         * the display is not being edited.
         */
        function drawRulers(parent, cfg, plot, sx, tMin, tMax, t, font, traces) {
            var on = cfg.Rulers === true;
            if (!on) { rulers.a = rulers.b = null; }
            // A ruler outside the window has nothing to measure: take it off.
            if (rulers.a !== null && (rulers.a < tMin || rulers.a > tMax)) { rulers.a = null; }
            if (rulers.b !== null && (rulers.b < tMin || rulers.b > tMax)) { rulers.b = null; }
            if (rulers.a === null && rulers.b !== null) { rulers.a = rulers.b; rulers.b = null; }
            scope.pvx.rulers = on ? rulerTable(cfg, traces) : null;
            // The table is an Angular binding under the SVG, and a render
            // started by a click runs outside any digest, so ask for one.
            // When the table changes height the body it shares the symbol
            // with changes too, and the plot was sized for the old one: draw
            // again once Angular has laid the table out. The shape is what
            // decides its height, so a drag that only moves a ruler does not
            // loop through a second render each frame.
            var shape = on ? (scope.pvx.rulers.rows.length + ':' + (scope.pvx.rulers.hint ? 1 : 0) + ':' + (rulers.a !== null ? 1 : 0)) : '';
            try { if (scope.$evalAsync) { scope.$evalAsync(function () {}); } } catch (e) { /* no Angular: tests */ }
            if (shape !== rulers.shape) {
                rulers.shape = shape;
                setTimeout(function () { ctx.render(); }, 30);
            }
            if (!on) { return; }

            var span = (tMax - tMin) || 1;
            var g = PVX.svg.el('g', { 'class': 'pvx-combo-rulers' }, parent);
            var hit = PVX.svg.el('rect', {
                x: plot.x.toFixed(2), y: plot.y.toFixed(2), width: plot.w.toFixed(2), height: plot.h.toFixed(2),
                fill: 'transparent', 'class': 'pvx-combo-ruler-hit'
            }, g);
            var marks = [['A', rulers.a], ['B', rulers.b]];
            for (var i = 0; i < marks.length; i++) {
                if (marks[i][1] === null) { continue; }
                var x = sx(marks[i][1]);
                PVX.svg.el('line', { x1: x.toFixed(2), y1: plot.y.toFixed(2), x2: x.toFixed(2), y2: plot.y1.toFixed(2),
                    stroke: t.text, 'stroke-width': 1.2, 'stroke-dasharray': '3 2', 'class': 'pvx-combo-ruler',
                    'pointer-events': 'none' }, g);
                PVX.svg.el('rect', { x: (x - font * 0.55).toFixed(2), y: plot.y.toFixed(2), width: (font * 1.1).toFixed(2),
                    height: (font + 3).toFixed(2), rx: 2, fill: t.text, 'class': 'pvx-combo-ruler-tag', 'pointer-events': 'none' }, g);
                PVX.svg.text(g, x.toFixed(2), (plot.y + font * 0.6 + 1.5).toFixed(2), marks[i][0], {
                    'class': 'pvx-svg-label pvx-combo-ruler-name', 'text-anchor': 'middle', 'font-size': font,
                    fill: t.surface, 'pointer-events': 'none'
                });
            }
            var toT = function (ev) {
                var box = hit.getBoundingClientRect();
                var f = box.width > 0 ? (ev.clientX - box.left) / box.width : 0;
                return tMin + PVX.util.clamp(f, 0, 1) * span;
            };
            hit.addEventListener('pointerdown', function (ev) {
                if (isEditMode()) { return; }
                var tm = toT(ev);
                var tol = 6 / Math.max(1, plot.w) * span;
                var near = null;
                if (rulers.a !== null && Math.abs(rulers.a - tm) <= tol) { near = 'a'; }
                else if (rulers.b !== null && Math.abs(rulers.b - tm) <= tol) { near = 'b'; }
                else if (rulers.a === null) { near = 'a'; }
                else if (rulers.b === null) { near = 'b'; }
                else { near = Math.abs(rulers.a - tm) <= Math.abs(rulers.b - tm) ? 'a' : 'b'; }
                rulers[near] = tm;
                rulers.drag = near;
                ev.preventDefault();
                var move = function (e2) { if (rulers.drag) { rulers[rulers.drag] = toT(e2); ctx.render(); } };
                var up = function () {
                    rulers.drag = null;
                    document.removeEventListener('pointermove', move, false);
                    document.removeEventListener('pointerup', up, false);
                };
                document.addEventListener('pointermove', move, false);
                document.addEventListener('pointerup', up, false);
                ctx.render();
            }, false);
        }

        /** Rows for the table: every data source drawn, by its own name. */
        function rulerTable(cfg, traces) {
            var a = rulers.a, b = rulers.b;
            var numOpts = PVX.config.numberOpts(cfg);
            var fmtv = function (p, units) {
                if (!p) { return '\u2014'; }
                if (!PVX.util.isNum(p.v)) { return p.state !== undefined ? p.state : '\u2014'; }
                return PVX.fmt.number(p.v, numOpts) + (units ? ' ' + units : '');
            };
            var lo = a === null ? null : (b === null ? a : Math.min(a, b));
            var hi = a === null ? null : (b === null ? a : Math.max(a, b));
            var out = {
                hint: a === null ? 'Click the chart to place ruler A, then again for B.' :
                    (b === null ? 'Click again to place ruler B.' : ''),
                a: a === null ? '' : PVX.fmt.time(a, 'datetime'),
                b: b === null ? '' : PVX.fmt.time(b, 'datetime'),
                span: a !== null && b !== null ? PVX.fmt.duration(Math.abs(b - a)) : '',
                both: a !== null && b !== null,
                rows: []
            };
            if (a === null) { return out; }
            // The times lead the table, with the span where Change goes.
            out.rows.push({ label: 'Time', color: 'transparent', a: out.a, b: out.b, delta: out.span,
                min: '', max: '', avg: '', std: '', n: '', trend: '', time: true });
            var add = function (label, units, points, color, isState, hold) {
                var row = { label: label, color: color, a: fmtv(valueAt(points, a, hold), units),
                    b: b === null ? '' : fmtv(valueAt(points, b, hold), units),
                    delta: '', min: '', max: '', avg: '', std: '', n: '', trend: '' };
                if (b !== null && !isState) {
                    var pa = valueAt(points, a, hold), pb = valueAt(points, b, hold);
                    if (pa && pb && PVX.util.isNum(pa.v) && PVX.util.isNum(pb.v)) {
                        var dv = pb.v - pa.v;
                        row.delta = (dv > 0 ? '+' : '') + PVX.fmt.number(dv, numOpts);
                    }
                    var inside = [], vals = [];
                    for (var i = 0; i < points.length; i++) {
                        if (points[i].t >= lo && points[i].t <= hi && PVX.util.isNum(points[i].v)) {
                            inside.push(points[i]); vals.push(points[i].v);
                        }
                    }
                    row.n = String(vals.length);
                    if (vals.length) {
                        row.min = PVX.fmt.number(Math.min.apply(null, vals), numOpts);
                        row.max = PVX.fmt.number(Math.max.apply(null, vals), numOpts);
                        var avg = PVX.stats.intervalAverages(points, lo, hi, 1);
                        row.avg = avg.length && avg[0].v !== null ? PVX.fmt.number(avg[0].v, numOpts) : '';
                        row.std = vals.length > 1 ? PVX.fmt.number(PVX.stats.stddev(vals, true), numOpts) : '';
                    }
                    // The trend between the rulers is worth having on any
                    // numeric trace, not only one that draws its fit line.
                    if (inside.length >= 3) {
                        var f = fitLine(inside);
                        if (f) { row.trend = slopeText(f, units, numOpts); }
                    }
                }
                out.rows.push(row);
            };
            for (var i = 0; i < traces.length; i++) {
                var tr = traces[i];
                if (tr.type === 'states') { add(tr.label, '', tr.states, tr.color, true, true); continue; }
                var hold = tr.type === 'step' || tr.type === 'bar';
                if (tr.type === 'range') {
                    var names = tr.label.split(' \u2013 ');
                    add(names[0], tr.units, tr.raw, tr.color, false, false);
                    add(names[1] || '', tr.upper ? tr.upper.units : tr.units, tr.raw2, tr.color, false, false);
                    continue;
                }
                add(tr.label, tr.units, tr.raw, tr.color, false, hold);
            }
            return out;
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
                if (showAxis && tr.axis !== 'none') { text += tr.axis === 'right' ? ' (R)' : ' (L)'; }
                if (cfg.ShowValues && tr.last !== null) {
                    text += '  ' + (tr.type === 'states' ? String(tr.last)
                        : PVX.fmt.number(tr.last, PVX.config.numberOpts(cfg)) + (tr.units ? ' ' + tr.units : ''));
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
            if (tr.type === 'states') {
                // Three stripes: a lane of states, not one colour.
                var pal = PVX.color.categorical;
                for (var q = 0; q < 3; q++) {
                    PVX.svg.el('rect', {
                        x: (x + 1 + q * (size - 2) / 3).toFixed(2), y: (cy - size * 0.36).toFixed(2),
                        width: ((size - 2) / 3).toFixed(2), height: (size * 0.72).toFixed(2),
                        fill: pal[(q + 3) % pal.length], 'fill-opacity': 0.6, 'class': 'pvx-combo-key'
                    }, parent);
                }
            } else if (tr.type === 'range') {
                PVX.svg.el('rect', {
                    x: (x + 1).toFixed(2), y: (cy - size * 0.32).toFixed(2),
                    width: (size - 2).toFixed(2), height: (size * 0.64).toFixed(2),
                    fill: col, 'fill-opacity': 0.35, stroke: col, 'stroke-width': 1, 'class': 'pvx-combo-key'
                }, parent);
            } else if (tr.type === 'bar') {
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
