/* ============================================================================
 * pvxEventAnalytics — "PVX Event Analytics"
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector (see the definition). Like pvxEventGantt, every number here comes from PI Web API
 * through PVX.api, never from PI Vision's data pipeline.
 *
 * WHY THIS EXISTS
 *   PI Vision's native Events Table lists events, and a list answers "what
 *   happened". The question a plant manager actually asks is "which reason code
 *   is costing me the most hours" — an ACCOUNTING question. Answering it means
 *   grouping events (by reason code, by asset, by template, by a fragment of the
 *   event name) and ranking the groups by how much time they consumed. That is
 *   a different operation from listing, and no amount of sorting a table gets
 *   you there.
 *
 * WHAT MAKES IT AN INSTRUMENT RATHER THAN A CHART
 *   Four arithmetic decisions separate a number you can put in a report from a
 *   number that is merely plausible. Each is implemented once, commented at the
 *   place it happens, and disclosed in the footer when it changed the answer:
 *
 *   1. CLIPPING. An event that started three days before the window and is
 *      still running contributes only the part inside the window. Summing raw
 *      event durations over a window over-reports, sometimes by days.
 *   2. OPEN EVENTS. An event with no end time (or PI's year-9999 sentinel) runs
 *      to the window end or to now, whichever is earlier. Its contribution grows
 *      every minute, so the count of open events is reported: a total that
 *      silently includes a still-running event is a different number tomorrow.
 *   3. OVERLAP. Two operators logging the same outage as two events is normal.
 *      Summing their durations double-counts the outage, so intervals are merged
 *      per group before totalling, and the footer says when merging changed the
 *      total.
 *   4. UNASSIGNED. Events with no value for the grouping attribute go into an
 *      explicit "(unassigned)" group. In practice that group is often the
 *      finding — nobody is filling in the reason code.
 *
 *   And one disclosure: if MaxEvents truncated the result the RANKING may be
 *   wrong, not merely incomplete, so the footer says so rather than implying a
 *   complete picture.
 *
 * DATA ACCESS
 *   - The AF database is resolved once per path and cached: a WebId is stable,
 *     and re-resolving it every refresh doubles the request count for nothing.
 *   - Event Frames come back with an explicit `selectedFields`. Without it PI
 *     Web API returns the entire object graph per event; on 1000 events that is
 *     megabytes for the four fields this symbol reads.
 *   - Grouping by an event ATTRIBUTE (the reason-code case) needs one value per
 *     event. That goes through ONE PVX.api.batch() — as individual requests it
 *     would be one authentication handshake and, cross-origin, one CORS
 *     preflight PER EVENT. Element names are deduplicated to unique elements and
 *     cached for the life of the symbol. Failed sub-requests are counted and
 *     reported, never silently dropped.
 *
 * AS AN ANALYTICS ENGINE
 *   Events become FACTS (factsFor): clipped to the window, cut at period
 *   boundaries when a day, week or month is in use, each carrying its key at
 *   every grouping level and in the split. Everything after that is a filter
 *   and an aggregate over the same list:
 *   - the metric can be a sum, mean, median, min, max or std dev of any
 *     numeric event attribute, not only a duration or a count;
 *   - a second dimension (SplitBy) stacks the bars and fills a pivot;
 *   - a click drills into a group (DrillBy, DrillBy2) without a new query;
 *   - targets per group judge each bar, row and card.
 *   Totals are always recomputed from the events they cover — a true overall
 *   mean, a union of time — never added up from rows. Every option is off by
 *   default, which is the chart as it was.
 *
 * RENDERING
 *   One imperative SVG into `.pvx-ea-body`, sharing the visual language of
 *   pvxPareto (ranked bars, cumulative line, 80% marker). Only the header,
 *   the drill-down trail and the footer are Angular-bound.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below these sizes the symbol sheds furniture rather than drawing an
     * illegible version of the full chart. Measured against the SYMBOL, never
     * against the drawing host — see the note in render(). */
    var COMPACT_W = 240, COMPACT_H = 160;   // drop value labels, axis, summary
    var MINIMAL_W = 140, MINIMAL_H = 100;   // bars only

    /** The one label for "this event carries no value for what you grouped by".
     *  Never dropped: a missing reason code is a finding, not a nuisance. */
    var UNASSIGNED = '(unassigned)';

    /** PI marks an unfinished event frame with a sentinel end time far in the
     *  future rather than a null — and different releases have used both. */
    var OPEN_AFTER_MS = Date.UTC(9000, 0, 1);

    /* Offsets accepted in a PI time expression. 'mo'/'y' are calendar units PI
     * resolves properly; here they only place a window, and a month-accurate
     * window on a downtime report is not worth a calendar library. */
    var UNIT_MS = {
        ms: 1, s: 1000, m: 60000, h: 3600000,
        d: 86400000, w: 604800000, mo: 2592000000, y: 31536000000
    };

    /**
     * `additive` is the load-bearing flag: a cumulative Pareto line and a donut
     * both assume the parts sum to the whole. A mean or a maximum does not, so
     * both are suppressed rather than drawn misleadingly.
     */
    var METRICS = {
        totalDuration: { label: 'Total duration', duration: true, additive: true },
        count: { label: 'Event count', duration: false, additive: true },
        meanDuration: { label: 'Mean duration', duration: true, additive: false },
        maxDuration: { label: 'Longest event', duration: true, additive: false }
    };

    var DURATION_UNITS = {
        minutes: { ms: 60000, label: 'min' },
        hours: { ms: 3600000, label: 'h' },
        days: { ms: 86400000, label: 'd' }
    };

    /* Summaries of a numeric EVENT ATTRIBUTE (lost production, scrap, cost).
     * Only a sum adds up to a whole, so only a sum may be stacked, put in a
     * donut or given a cumulative line. */
    var ATTR_METRICS = {
        attrSum: { label: 'Sum of', additive: true },
        attrMean: { label: 'Mean of', additive: false },
        attrMin: { label: 'Lowest', additive: false },
        attrMax: { label: 'Highest', additive: false },
        attrMedian: { label: 'Median of', additive: false },
        attrStdDev: { label: 'Std dev of', additive: false }
    };

    var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /* A period cap: a week of days is 7 groups, a year of days is 366, and
     * past that a bar per period is a barcode, not a chart. */
    var MAX_PERIODS = 400;

    function isPeriod(by) { return by === 'day' || by === 'week' || by === 'month' || by === 'weekday'; }

    /**
     * Start of the period holding `ms`, in the browser's local time — the time
     * zone PI Vision draws its own time bar in. Built with the Date setters,
     * never by adding 86400000: a day that crosses a DST change is 23 or 25
     * hours long, and arithmetic would put every later bucket an hour off
     * midnight.
     */
    function periodStart(ms, by, weekStart) {
        var d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        if (by === 'week') {
            var ws = weekStart === 'sunday' ? 0 : 1;
            d.setDate(d.getDate() - ((d.getDay() - ws + 7) % 7));
        } else if (by === 'month') {
            d.setDate(1);
        }
        return d.getTime();
    }

    /** Start of the period after the one starting at `start`. */
    function periodNext(start, by) {
        var d = new Date(start);
        if (by === 'month') { d.setMonth(d.getMonth() + 1); }
        else if (by === 'week') { d.setDate(d.getDate() + 7); }
        else { d.setDate(d.getDate() + 1); }
        return d.getTime();
    }

    /** The group key of an instant: a period start, or the day of the week. */
    function periodKey(ms, by, weekStart) {
        if (by === 'weekday') { return String(new Date(ms).getDay()); }
        return String(periodStart(ms, by, weekStart));
    }

    function periodLabel(key, by) {
        if (by === 'weekday') { return WEEKDAYS[parseInt(key, 10)] || key; }
        var d = new Date(parseInt(key, 10));
        var mon = MONTHS[d.getMonth()];
        if (by === 'month') { return mon + ' ' + d.getFullYear(); }
        if (by === 'week') { return 'Week of ' + d.getDate() + ' ' + mon; }
        return WEEKDAYS[d.getDay()].slice(0, 3) + ' ' + d.getDate() + ' ' + mon;
    }

    /**
     * Every period key in [from, to), in time order — including the empty
     * ones. A day with no downtime is the best news on the chart, and leaving
     * it out would close the gap and hide it. Days of the week come Monday
     * (or Sunday) first, all seven. `capped` is set past MAX_PERIODS.
     */
    function periodRange(from, to, by, weekStart) {
        var keys = [];
        if (by === 'weekday') {
            var first = weekStart === 'sunday' ? 0 : 1;
            for (var w = 0; w < 7; w++) { keys.push(String((first + w) % 7)); }
            return { keys: keys, capped: false };
        }
        var t = periodStart(from, by, weekStart);
        while (t < to) {
            if (keys.length >= MAX_PERIODS) { return { keys: keys, capped: true }; }
            keys.push(String(t));
            t = periodNext(t, by);
        }
        return { keys: keys, capped: false };
    }

    /**
     * Cut [from, to) at every boundary of the periods in use, so an outage
     * from 22:00 to 03:00 books two hours to one day and three to the next.
     * Summing it whole into the day it started is the error a hand-built
     * spreadsheet makes. Weeks do not nest in months, so with both in use
     * the interval is cut at the boundaries of each.
     */
    function sliceAt(from, to, kinds, weekStart) {
        if (!kinds.length) { return [{ from: from, to: to }]; }
        var out = [];
        var t = from;
        for (var guard = 0; t < to && guard < 5000; guard++) {
            var next = to;
            for (var k = 0; k < kinds.length; k++) {
                var by = kinds[k] === 'weekday' ? 'day' : kinds[k];
                var b = periodNext(periodStart(t, by, weekStart), by);
                if (b < next) { next = b; }
            }
            out.push({ from: t, to: next });
            t = next;
        }
        if (t < to) { out.push({ from: t, to: to }); }
        return out;
    }

    /** n, sum, min, max, mean, median and SAMPLE standard deviation. */
    function summarize(values) {
        var n = values.length;
        var s = { n: n, sum: 0, min: null, max: null, mean: null, median: null, std: null };
        if (!n) { return s; }
        var sorted = values.slice().sort(function (a, b) { return a - b; });
        for (var i = 0; i < n; i++) { s.sum += sorted[i]; }
        s.min = sorted[0];
        s.max = sorted[n - 1];
        s.mean = s.sum / n;
        s.median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
        var ss = 0;
        for (i = 0; i < n; i++) { ss += (sorted[i] - s.mean) * (sorted[i] - s.mean); }
        // n - 1: these events are a sample of the process, not all of it.
        s.std = n > 1 ? Math.sqrt(ss / (n - 1)) : 0;
        return s;
    }

    /**
     * Targets, one per line: `Mechanical | 4h`. A `*` line is the target for
     * every group without its own. Labels match without regard to case.
     * @returns {{map:Object, def:(String|null), bad:Array, count:Number}}
     */
    function parseTargets(text) {
        var out = { map: {}, def: null, bad: [], count: 0 };
        var lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/^\s+|\s+$/g, '');
            if (!line) { continue; }
            var bar = line.lastIndexOf('|');
            var label = bar === -1 ? '' : line.slice(0, bar).replace(/\s+$/, '');
            var value = bar === -1 ? '' : line.slice(bar + 1).replace(/^\s+/, '');
            if (!label || !value) { out.bad.push(line); continue; }
            if (label === '*') { out.def = value; } else { out.map[label.toLowerCase()] = value; }
            out.count += 1;
        }
        return out;
    }

    var TARGET_UNITS = { ms: 1, s: 1000, m: 60000, min: 60000, h: 3600000, d: 86400000, w: 604800000 };

    /**
     * A target as a number in the metric's own terms: milliseconds for a
     * duration (`4h`, `90m`, or a bare number in `bareUnitMs`), the plain
     * number otherwise. null when it cannot be read.
     */
    function targetValue(raw, isDuration, bareUnitMs) {
        var s = String(raw === null || raw === undefined ? '' : raw).replace(/\s+/g, '').toLowerCase();
        if (!s) { return null; }
        if (!isDuration) {
            return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/.test(s) ? parseFloat(s) : null;
        }
        var m = /^(\d+\.?\d*|\.\d+)(ms|min|s|m|h|d|w)?$/.exec(s);
        if (!m) { return null; }
        return parseFloat(m[1]) * (m[2] ? TARGET_UNITS[m[2]] : bareUnitMs);
    }

    var definition = {
        typeName: 'pvxEventAnalytics',
        displayName: 'PVX Event Analytics',

        // One data source, which this symbol ignores: everything it shows comes
        // from its config pane. PI Vision keeps DatasourceBehaviors.None symbols
        // out of the symbol selector altogether (its guide calls them "static
        // symbols"), so declared that way this could never be placed on a
        // display. Pick it and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        // A collection would repeat the whole ranking once per asset, which
        // destroys the comparison the ranking exists to make.
        supportsCollections: false,
        configTitle: 'Format Event Analytics',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                // The cheapest query PI Vision has, for a value nothing reads.
                DataShape: 'Value',
                Height: 300,
                Width: 620,

                Title: 'Event analytics',
                ShowLabel: true,

                /* -- what to fetch ------------------------------------------ */
                DatabasePath: '',            // \\AFSERVER01\Production
                TemplateName: '',
                NameFilter: '',
                ElementNameFilter: '',
                SearchMode: 'Overlapped',
                MaxEvents: 1000,
                RefreshSeconds: 120,

                /* -- time window fallback ----------------------------------- *
                 * Only used when the display URL carries no starttime/endtime. */
                StartTime: '*-7d',
                EndTime: '*',

                /* -- grouping ------------------------------------------------ */
                GroupBy: 'template',         // template | element | attribute | name | none | day | week | month | weekday
                GroupAttribute: '',          // e.g. Reason Code
                NamePattern: '',             // regex; capture group 1 is the group
                WeekStart: 'monday',         // monday | sunday — for week and weekday groups

                /* -- a second dimension, and the levels a click drills into --
                 * Each is 'none' by default, which is the chart as it was. */
                SplitBy: 'none',             // none | the GroupBy choices
                SplitAttribute: '',
                SplitMode: 'stacked',        // stacked | percent
                SplitTopN: 6,
                DrillBy: 'none',             // the level a click on a group opens
                DrillAttribute: '',
                DrillBy2: 'none',            // and the one below that
                DrillAttribute2: '',

                /* -- what is ranked ------------------------------------------ */
                Metric: 'totalDuration',     // totalDuration | count | meanDuration | maxDuration | attrSum | attrMean | attrMin | attrMax | attrMedian | attrStdDev
                MetricAttribute: '',         // the event attribute an attr* metric summarises
                MetricUnits: '',             // blank: the attribute's own units
                MetricDecimals: '',          // blank: chosen from the size of the number
                Chart: 'pareto',             // pareto | bars | donut | table | pivot | cards
                ShowCumulative: true,
                EightyLine: true,
                TopN: 10,
                GroupRemainderAsOther: true,

                /* -- presentation -------------------------------------------- */
                ShowValues: true,
                DurationUnit: 'auto',        // auto | minutes | hours | days
                ColorMode: 'single',         // single | palette | threshold | target
                BarColor: '#3b82c4',
                ShowSummary: true,
                ShowOpenEventNote: true,
                TableTotals: false,          // a totals row under the table
                PivotShading: true,          // pivot cells shaded by size
                CardTotal: true,             // cards: a first card for everything

                /* -- targets ------------------------------------------------- */
                Targets: '',                 // lines of `Group | target`; `* | target` for the rest
                TargetDirection: 'lower',    // lower | higher — which side of the target is good

                /* -- interaction ---------------------------------------------- */
                ClickAction: 'none',         // none | navigate | drill
                NavigateTarget: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the chart itself is SVG.
        scope.pvx = {
            title: '',
            subtitle: '',
            summary: '',
            note: '',
            background: '',
            clickable: false,
            // Drill-down trail: "All > Mechanical > K-301". A click on one
            // goes back to that level.
            crumbs: [],
            crumb: function (i) {
                if (!(i >= 0) || i >= drill.length) { return; }
                drill.length = i;
                ctx.render();
            }
        };

        /* ---------------------------------------------------------------- *
         * instance state
         * ---------------------------------------------------------------- */
        var state = {
            phase: 'idle',        // idle | loading | ok | error | unconfigured | nodb
            error: null,          // rejection from PVX.api, carrying .pvxError
            events: [],
            capped: false,        // more events matched than MaxEvents
            maxEvents: 0,
            failedBatch: 0,       // failed sub-requests in the enrichment batch
            win: null,            // window the current events were fetched for
            db: { path: '', from: '' }   // database in use; `from` set when not configured
        };
        var sourceAsset = '';     // element of the placeholder data source

        var liveCfg = scope.config || {};
        var generation = 0;       // bumps on every refresh; stale replies dropped

        // Caches that outlive a refresh, both keyed by something stable (an AF
        // path, an element WebId) so they can only ever save a request, never
        // change what is drawn.
        var dbCache = {};
        var elemNames = {};

        var refreshTimer = null;
        var hashTimer = null;
        var debounceTimer = null;
        var timerSeconds = null;
        var lastHashKey = null;
        var hashListener = null;

        var boundHost = null;
        var hits = [];            // clickable marks, indexed by data-pvx-i
        var model = null;
        var chromeOff = false;    // true below the minimal size: bars only
        // The groups clicked into, outermost first: [{key, label}]. Cleared
        // whenever the levels themselves change in the pane.
        var drill = [];
        var drillSig = '';

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-ea-body',
            render: render,

            // The data source is otherwise ignored, but a blank DatabasePath
            // takes its database from it, and PI Vision re-binds it on an
            // asset swap.
            onData: function (d) {
                var one = PVX.data.single(d);
                var a = one ? PVX.nav.assetOf(one.path) : '';
                if (a !== sourceAsset) {
                    sourceAsset = a;
                    if (!trim(liveCfg.DatabasePath)) { refreshSoon(); }
                }
            },

            onConfigChange: function (newCfg) {
                liveCfg = newCfg || liveCfg;
                ensureTimers(liveCfg);
                // Debounced: the config pane fires on every keystroke in the
                // database path, and each one would be a round trip against a
                // half-typed path.
                refreshSoon();
            },

            onDestroy: teardown
        });

        /* ================================================================ *
         * small helpers
         * ================================================================ */

        function trim(s) {
            return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, '');
        }

        function intIn(v, lo, hi, fallback) {
            var n = parseInt(v, 10);
            if (!isFinite(n)) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        function firstNonEmpty(list) {
            for (var i = 0; i < list.length; i++) {
                var s = trim(list[i]);
                if (s) { return s; }
            }
            return '';
        }

        function isoOf(ms) { return new Date(ms).toISOString(); }

        /** Average-glyph-width estimate. Measuring properly forces a layout per
         *  label, and this chart draws dozens per frame. */
        function textW(s, fontPx) {
            return String(s === null || s === undefined ? '' : s).length * fontPx * 0.56;
        }

        function fitText(s, maxPx, fontPx) {
            var str = String(s === null || s === undefined ? '' : s);
            var max = Math.floor(maxPx / (fontPx * 0.56));
            if (max < 1) { return ''; }
            if (str.length <= max) { return str; }
            if (max === 1) { return '\u2026'; }
            return str.slice(0, max - 1) + '\u2026';
        }

        function metricKey(cfg) {
            var k = cfg && cfg.Metric;
            return (Object.prototype.hasOwnProperty.call(METRICS, k) ||
                    Object.prototype.hasOwnProperty.call(ATTR_METRICS, k)) ? k : 'totalDuration';
        }

        /** The metric as the model uses it: label, kind, and the attribute it reads. */
        function metricDef(cfg) {
            var k = metricKey(cfg);
            if (METRICS[k]) {
                return { key: k, label: METRICS[k].label, duration: METRICS[k].duration,
                         additive: METRICS[k].additive, attr: '' };
            }
            var a = trim(cfg.MetricAttribute);
            return { key: k, label: ATTR_METRICS[k].label + ' ' + (a || 'an attribute'),
                     duration: false, additive: ATTR_METRICS[k].additive, attr: a };
        }

        function chartMode(cfg) {
            var c = cfg && cfg.Chart;
            return (c === 'bars' || c === 'donut' || c === 'table' || c === 'pivot' || c === 'cards') ? c : 'pareto';
        }

        /* ---- dimensions --------------------------------------------------- *
         * One shape for everything an event can be sorted by: the grouping,
         * the split, and each level a click drills into. */
        var DIMS = { template: 1, element: 1, attribute: 1, name: 1, none: 1, day: 1, week: 1, month: 1, weekday: 1 };

        function dim(by, attr) {
            return { by: DIMS[by] === 1 ? by : 'template', attr: trim(attr) };
        }

        /** The grouping levels (the first, then any drill levels) and the split. */
        function dimsOf(cfg) {
            var levels = [dim(cfg.GroupBy, cfg.GroupAttribute)];
            if (levels[0].by !== 'none') {
                var more = [[cfg.DrillBy, cfg.DrillAttribute], [cfg.DrillBy2, cfg.DrillAttribute2]];
                for (var i = 0; i < more.length; i++) {
                    if (!more[i][0] || more[i][0] === 'none' || DIMS[more[i][0]] !== 1) { break; }
                    levels.push(dim(more[i][0], more[i][1]));
                }
            }
            var split = (cfg.SplitBy && cfg.SplitBy !== 'none' && DIMS[cfg.SplitBy] === 1)
                ? dim(cfg.SplitBy, cfg.SplitAttribute) : null;
            return { levels: levels, split: split };
        }

        function allDims(d) { return d.split ? d.levels.concat([d.split]) : d.levels; }

        /** Every event attribute something on this chart reads, once each. */
        function attrList(cfg) {
            var out = [], seen = {};
            var add = function (a) {
                a = trim(a);
                if (a && !seen[a.toLowerCase()]) { seen[a.toLowerCase()] = true; out.push(a); }
            };
            var ds = allDims(dimsOf(cfg));
            for (var i = 0; i < ds.length; i++) { if (ds[i].by === 'attribute') { add(ds[i].attr); } }
            add(metricDef(cfg).attr);
            return out;
        }

        /* ================================================================ *
         * PI time expressions
         * ================================================================ *
         * The window arrives as PI time text ('*-7d', 't', '*'). PI Web API
         * understands that grammar natively, so the simplest thing would be to
         * forward the string — but then the ARITHMETIC and the QUERY could
         * disagree: if the server resolves '*' half a second after we compute
         * the window, every clipped duration is wrong by that much and the
         * "percentage of the window accounted for" is wrong with it. One
         * resolved instant, used for the query, the clipping and the axis,
         * cannot disagree with itself.
         *
         * When an expression is beyond this parser we hand the ORIGINAL text to
         * PI Web API — which is authoritative — and take the window from the
         * events that come back. The footer says so, because a total is only
         * meaningful next to the window it was taken over.
         */

        function localMidnight(nowMs, dayOffset) {
            var d = new Date(nowMs);
            d.setHours(0, 0, 0, 0);
            // setDate rather than adding 86400000: crossing a DST boundary by
            // arithmetic lands an hour off midnight.
            d.setDate(d.getDate() + (dayOffset || 0));
            return d.getTime();
        }

        /** @returns {Number|null} epoch ms, or null when this parser cannot say. */
        function parsePiTime(expr, nowMs) {
            var raw = trim(expr);
            if (!raw) { return null; }
            var s = raw.replace(/\s+/g, '').toLowerCase();

            var anchor = null;
            var rest = '';
            var head = s.charAt(0);
            if (head === '*') { anchor = nowMs; rest = s.slice(1); }
            else if (head === 't') { anchor = localMidnight(nowMs, 0); rest = s.slice(1); }
            else if (head === 'y') { anchor = localMidnight(nowMs, -1); rest = s.slice(1); }
            else if (head === '+' || head === '-') { anchor = nowMs; rest = s; }
            else {
                // Absolute timestamp. Parsing anything non-ISO is
                // implementation-defined, so an unparseable string returns null
                // rather than a plausible-looking wrong answer.
                var d = PVX.fmt.toDate(raw);
                return d ? d.getTime() : null;
            }
            if (!rest) { return anchor; }

            // Signed offset terms: '-7d', '+30m', '-1d+6h'. 'mo' and 'ms'
            // precede 'm' or they would never match.
            var re = /([+-])(\d+(?:\.\d+)?)(mo|ms|s|m|h|d|w|y)/g;
            var total = 0, consumed = 0, mm;
            while ((mm = re.exec(rest)) !== null) {
                total += (mm[1] === '-' ? -1 : 1) * parseFloat(mm[2]) * UNIT_MS[mm[3]];
                consumed += mm[0].length;
            }
            // A partially-understood expression is not understood.
            if (!consumed || consumed !== rest.length) { return null; }
            return anchor + total;
        }

        /**
         * The window this symbol accounts over.
         *
         * URL first, config second — the URL is where PI Vision's own time bar
         * writes, and following it is what makes this symbol obey the display's
         * time controls despite having no data pipeline to be told through.
         */
        function resolveWindow(cfg) {
            var params = {};
            try { params = PVX.nav.parseHash().params || {}; } catch (e) { params = {}; }

            // PI Vision writes these lower-case; deep-link tooling is less
            // careful, so both spellings are accepted.
            var startExpr = firstNonEmpty([params.starttime, params.StartTime, cfg.StartTime, '*-7d']);
            var endExpr = firstNonEmpty([params.endtime, params.EndTime, cfg.EndTime, '*']);

            var now = (new Date()).getTime();
            var from = parsePiTime(startExpr, now);
            var to = parsePiTime(endExpr, now);
            var parsed = from !== null && to !== null && to > from;

            if (!parsed) {
                from = now - 7 * 86400000;
                to = now;
            }
            return {
                startExpr: startExpr, endExpr: endExpr,
                from: from, to: to,
                useRaw: !parsed, now: now
            };
        }

        /** Key that changes exactly when the display's time range changes. */
        function hashKey() {
            var p = {};
            try { p = PVX.nav.parseHash().params || {}; } catch (e) { p = {}; }
            return String(p.starttime || p.StartTime || '') + '|' +
                   String(p.endtime || p.EndTime || '');
        }

        /* ================================================================ *
         * PI Web API
         * ================================================================ */

        /**
         * AF database path -> WebId, resolved once and remembered.
         *
         * A FAILED lookup is deliberately not cached: a transient outage would
         * otherwise poison every refresh for as long as the display stays open.
         */
        function resolveDatabase(dbPath) {
            if (dbCache[dbPath]) { return dbCache[dbPath]; }

            var p = PVX.api.get('assetdatabases?path=' + encodeURIComponent(dbPath))
                .then(function (db) {
                    if (!db || !db.WebId) {
                        throw {
                            pvxError: {
                                code: 'no-database',
                                message: 'PI Web API answered, but there is no AF database at "' + dbPath +
                                         '". The path is \\\\<AF server>\\<database> and it is case-insensitive ' +
                                         'but not forgiving about the server name.',
                                check: 'DatabasePath / AF server name'
                            }
                        };
                    }
                    return db.WebId;
                });

            p['catch'](function () {
                if (dbCache[dbPath] === p) { delete dbCache[dbPath]; }
            });
            dbCache[dbPath] = p;
            return p;
        }

        function needsElement(cfg) {
            var ds = allDims(dimsOf(cfg));
            for (var i = 0; i < ds.length; i++) { if (ds[i].by === 'element') { return true; } }
            return false;
        }

        /**
         * The Event Frame query.
         *
         * `selectedFields` is not an optimisation, it is the difference between
         * a workable symbol and an unusable one — see the file header. Each
         * field below is asked for because something draws it, and the two
         * conditional ones are omitted entirely when the current grouping does
         * not need them.
         *
         * maxCount is asked for one HIGHER than we will use. That single extra
         * row is what distinguishes "exactly MaxEvents events matched" from "PI
         * Web API truncated the answer" — and truncation does not merely make
         * this chart incomplete, it can make the RANKING wrong, so it has to be
         * detectable.
         */
        function queryEvents(dbWebId, cfg, win) {
            var max = intIn(cfg.MaxEvents, 1, 20000, 1000);
            var fields = [
                'Items.Name',
                'Items.StartTime',
                'Items.EndTime',
                'Items.TemplateName'
            ];
            if (needsElement(cfg)) {
                // The search endpoint returns a LINK to the referenced element,
                // not its name. This field is the cheapest thing that leads to
                // one: it carries the WebId the enrichment batch resolves, once
                // per element, then cached.
                fields.push('Items.Links.PrimaryReferencedElement');
            }
            if (attrList(cfg).length) {
                // Only when an attribute value is needed per event — Self is the
                // WebId the streamset lookup is addressed to.
                fields.push('Items.Links.Self');
            }

            return PVX.api.eventFrames({
                databaseWebId: dbWebId,
                startTime: win.useRaw ? win.startExpr : isoOf(win.from),
                endTime: win.useRaw ? win.endExpr : isoOf(win.to),
                templateName: trim(cfg.TemplateName),
                nameFilter: trim(cfg.NameFilter),
                elementNameFilter: trim(cfg.ElementNameFilter),
                // 'Overlapped' is the operational default and the only one that
                // is arithmetically right for downtime accounting: the event
                // that started before the window and is still running consumed
                // time INSIDE the window, and every stricter mode drops it.
                searchMode: trim(cfg.SearchMode) || 'Overlapped',
                maxCount: max + 1,
                selectedFields: fields.join(';')
            }, {
                // Never served from the shared GET cache: this symbol owns its
                // refresh cadence, and a RefreshSeconds shorter than the cache
                // TTL would silently become the TTL.
                cache: false
            });
        }

        /** Last path segment of a PI Web API link — the WebId. */
        function webIdFromLink(url) {
            var s = trim(url);
            if (!s) { return ''; }
            s = s.split('?')[0].replace(/\/+$/, '');
            var i = s.lastIndexOf('/');
            return i === -1 ? '' : s.slice(i + 1);
        }

        function toEvent(item, cfg) {
            var startD = PVX.fmt.toDate(item.StartTime);
            if (!startD) { return null; }      // an event with no start cannot be placed
            var endD = PVX.fmt.toDate(item.EndTime);
            // Open = no end time at all, or the year-9999 sentinel. Treating
            // either as a real end would book a finished outage for a fault that
            // is still on the plant.
            var open = !endD || endD.getTime() >= OPEN_AFTER_MS;
            var links = item.Links || {};
            return {
                name: item.Name || '(unnamed event)',
                template: trim(item.TemplateName),
                start: startD.getTime(),
                end: open ? null : endD.getTime(),
                open: open,
                webId: attrList(cfg).length ? webIdFromLink(links.Self) : '',
                elWebId: needsElement(cfg) ? webIdFromLink(links.PrimaryReferencedElement) : '',
                elName: '',
                // Lower-cased attribute name -> {v, u}; filled by enrich().
                attrs: {}
            };
        }

        /**
         * ONE batch for every per-event follow-up the grouping needs.
         *
         * Element names are DEDUPLICATED to unique elements and cached forever
         * after: 1000 events across 12 assets is 12 sub-requests on the first
         * refresh and zero on every one after it. Attribute values cannot be
         * cached — an operator editing a reason code is exactly the change this
         * symbol exists to show — so they are one sub-request per event, which
         * is precisely why they go in a batch and never down the wire
         * individually. PVX.api.batch chunks them itself.
         */
        function enrich(events, cfg) {
            var attrs = attrList(cfg);
            var wantEl = needsElement(cfg);
            var reqs = {};
            var ids = [];             // parallel arrays keep batch ids opaque
            var kinds = [];
            var targets = [];
            var i, key;

            if (wantEl) {
                var seenEl = {};
                for (i = 0; i < events.length; i++) {
                    var id = events[i].elWebId;
                    if (!id || seenEl[id] || elemNames[id] !== undefined) { continue; }
                    seenEl[id] = true;
                    key = 'e' + ids.length;
                    reqs[key] = {
                        Method: 'GET',
                        Resource: apiUrl('elements/' + encodeURIComponent(id) + '?selectedFields=Name')
                    };
                    ids.push(key); kinds.push('element'); targets.push(id);
                }
            }

            // One sub-request per event per attribute. Asking for every
            // attribute of the event in one go (no nameFilter) would be fewer
            // requests, but an Event Frame template commonly carries dozens of
            // attributes, and their values are what dominates the payload.
            for (var ai = 0; ai < attrs.length; ai++) {
                var seenEv = {};
                for (i = 0; i < events.length; i++) {
                    var wid = events[i].webId;
                    // Deduplicated defensively: an event cannot legitimately
                    // appear twice, but a second request for the same WebId
                    // would be a sub-request bought for nothing.
                    if (!wid || seenEv[wid]) { continue; }
                    seenEv[wid] = true;
                    key = 'a' + ids.length;
                    reqs[key] = {
                        Method: 'GET',
                        // streamsets rather than a per-attribute lookup: one
                        // request returns the named attribute's value without
                        // first resolving the attribute's own WebId.
                        Resource: apiUrl('streamsets/' + encodeURIComponent(wid) +
                            '/value?nameFilter=' + encodeURIComponent(attrs[ai]) +
                            '&selectedFields=Items.Name;Items.Value')
                    };
                    ids.push(key); kinds.push('attribute'); targets.push({ wid: wid, attr: attrs[ai].toLowerCase() });
                }
            }

            if (!ids.length) {
                applyElementNames(events);
                return Promise.resolve(0);
            }

            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                var r = PVX.api.batchResults(res);
                var byWebId = {};
                for (var k = 0; k < ids.length; k++) {
                    var body = r.ok[ids[k]];
                    if (body === undefined) { continue; }
                    if (kinds[k] === 'element') {
                        elemNames[targets[k]] = (body && body.Name) || '';
                    } else {
                        byWebId[targets[k].wid + '\n' + targets[k].attr] = firstStreamValue(body);
                    }
                }
                for (var e = 0; e < events.length; e++) {
                    if (!events[e].webId) { continue; }
                    for (var a2 = 0; a2 < attrs.length; a2++) {
                        var got = byWebId[events[e].webId + '\n' + attrs[a2].toLowerCase()];
                        if (got !== undefined) { events[e].attrs[attrs[a2].toLowerCase()] = got; }
                    }
                }
                applyElementNames(events);
                // Reported, not swallowed: a group total built from 40 of 50
                // events is a smaller number than the truth, and nothing on the
                // chart would show it.
                return r.failedCount;
            })['catch'](function () {
                // A failed batch degrades the GROUPING, which matters more here
                // than it does on a timeline — every event lands in
                // "(unassigned)". Say so rather than presenting that as a
                // finding about the plant.
                applyElementNames(events);
                return -1;
            });
        }

        function apiUrl(path) { return PVX.api.base() + '/' + path; }

        function applyElementNames(events) {
            for (var i = 0; i < events.length; i++) {
                var id = events[i].elWebId;
                if (id && elemNames[id]) { events[i].elName = elemNames[id]; }
            }
        }

        /** First value out of a streamset response, whatever shape it arrived
         *  in, with its units: {v, u}. */
        function firstStreamValue(body) {
            var items = body && body.Items;
            if (!items || !items.length) { return { v: null, u: '' }; }
            var v = items[0].Value;
            var u = '';
            if (v !== null && typeof v === 'object') {
                // A TimedValue wrapper; PI digital states nest one deeper.
                u = trim(v.UnitsAbbreviation);
                v = v.Value;
                if (v !== null && typeof v === 'object') { v = v.Name !== undefined ? v.Name : null; }
            }
            return { v: v === undefined ? null : v, u: u };
        }

        /* ================================================================ *
         * refresh
         * ================================================================ */

        /**
         * The configured database, else the one this symbol's data source
         * lives in (see PVX.nav.defaultDatabase).
         */
        function databaseFor(cfg) {
            var typed = trim(cfg.DatabasePath);
            if (typed) { return { path: typed, from: '' }; }
            return PVX.nav.defaultDatabase(scope, sourceAsset);
        }

        function refresh() {
            if (ctx.destroyed) { return; }
            var cfg = liveCfg = scope.config || liveCfg;

            // With no baseUrl set, PVX.api first asks PI Vision's own server
            // for /piwebapi. Decide nothing until it has its answer.
            if (PVX.api.discovering()) {
                PVX.api.discover().then(function () { if (!ctx.destroyed) { refresh(); } });
                return;
            }

            // Each state below is a different problem with a different owner, so
            // each gets its own message rather than one "no data".
            if (!PVX.api.isConfigured()) {
                state.phase = 'unconfigured';
                state.error = null;
                ctx.render();
                return;
            }

            state.db = databaseFor(cfg);
            var dbPath = state.db.path;
            if (!dbPath) {
                state.phase = 'nodb';
                state.error = null;
                ctx.render();
                return;
            }

            var gen = ++generation;
            var win = resolveWindow(cfg);
            var maxEvents = intIn(cfg.MaxEvents, 1, 20000, 1000);

            // Keep whatever is drawn while the new answer is in flight; blanking
            // a working chart every tick is worse than a stale one.
            if (state.phase !== 'ok') { state.phase = 'loading'; }
            ctx.render();

            resolveDatabase(dbPath)
                .then(function (webId) {
                    if (stale(gen)) { return null; }
                    return queryEvents(webId, cfg, win);
                })
                .then(function (res) {
                    if (stale(gen) || res === null) { return null; }

                    var items = (res && res.Items) || [];
                    var capped = items.length > maxEvents;
                    if (capped) { items = items.slice(0, maxEvents); }

                    var events = [];
                    for (var i = 0; i < items.length; i++) {
                        var ev = toEvent(items[i], cfg);
                        if (ev) { events.push(ev); }
                    }
                    events.sort(function (a, b) { return a.start - b.start; });

                    state.capped = capped;
                    state.maxEvents = maxEvents;
                    state.events = events;
                    state.win = win;

                    // The server understood an expression we could not, so the
                    // window has to come from what it returned.
                    if (win.useRaw) { adoptWindowFromEvents(win, events); }

                    return enrich(events, cfg);
                })
                .then(function (failed) {
                    if (stale(gen) || failed === null) { return; }
                    state.failedBatch = failed;
                    state.phase = 'ok';
                    state.error = null;
                    ctx.render();
                })['catch'](function (err) {
                    if (stale(gen)) { return; }
                    state.phase = 'error';
                    state.error = err;
                    state.events = [];
                    ctx.render();
                });
        }

        /** A reply from a superseded request must not overwrite a newer one. */
        function stale(gen) { return ctx.destroyed || gen !== generation; }

        function adoptWindowFromEvents(win, events) {
            if (!events.length) { return; }
            var lo = events[0].start, hi = events[0].start;
            for (var i = 0; i < events.length; i++) {
                if (events[i].start < lo) { lo = events[i].start; }
                var e = events[i].open ? win.now : events[i].end;
                if (e > hi) { hi = e; }
            }
            if (!(hi > lo)) { hi = lo + 60000; }
            win.from = lo;
            win.to = hi;
        }

        /* ================================================================ *
         * timers and listeners — every one is torn down in teardown()
         * ================================================================ */

        function ensureTimers(cfg) {
            var secs = intIn(cfg.RefreshSeconds, 5, 86400, 120);
            if (refreshTimer !== null && timerSeconds === secs) { return; }
            if (refreshTimer !== null) { clearInterval(refreshTimer); }
            timerSeconds = secs;
            refreshTimer = setInterval(function () { refresh(); }, secs * 1000);
        }

        /**
         * Poll the URL for a time-range change.
         *
         * A hashchange listener is wired up too, but polling is the primary
         * mechanism on purpose: some PI Vision releases change the time range
         * through the router without producing a hashchange, and a symbol that
         * relied on the event alone would quietly keep reporting yesterday's
         * totals under today's heading.
         */
        function pollHash() {
            if (ctx.destroyed) { return; }
            var k = hashKey();
            if (k === lastHashKey) { return; }
            lastHashKey = k;
            refresh();
        }

        function refreshSoon() {
            if (debounceTimer !== null) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(function () {
                debounceTimer = null;
                refresh();
            }, 400);
        }

        function teardown() {
            // A leaked poller on a kiosk display runs for weeks. Everything this
            // symbol started, it stops.
            if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
            if (hashTimer !== null) { clearInterval(hashTimer); hashTimer = null; }
            if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
            if (hashListener) {
                try { window.removeEventListener('hashchange', hashListener, false); } catch (e) { /* ignore */ }
                hashListener = null;
            }
            unbindHost();
            // Any request still in flight resolves into stale() and is dropped.
            generation += 1;
            state.events = [];
            hits = [];
            model = null;
        }

        /* ================================================================ *
         * model — pure: events + config -> ranked groups, totals, notes
         * ================================================================ */

        /**
         * Total covered time of a set of intervals, MERGING overlaps.
         *
         * Two operators logging the same four-hour outage as two events is
         * routine, and adding their durations reports eight hours of downtime
         * that never happened. The union is the only defensible total, and the
         * difference between the union and the raw sum is disclosed by the
         * caller when it is non-zero.
         *
         * @param {Array} intervals [{from,to}] — mutated only through a copy
         */
        function mergedTotal(intervals) {
            if (!intervals.length) { return 0; }
            var arr = intervals.slice().sort(function (a, b) { return a.from - b.from; });
            var total = 0;
            var curFrom = arr[0].from, curTo = arr[0].to;
            for (var i = 1; i < arr.length; i++) {
                if (arr[i].from > curTo) {
                    total += curTo - curFrom;
                    curFrom = arr[i].from;
                    curTo = arr[i].to;
                } else if (arr[i].to > curTo) {
                    curTo = arr[i].to;
                }
            }
            return total + (curTo - curFrom);
        }

        /**
         * Compile NamePattern once per render.
         * An invalid regex is the operator's typo, not a crash: it is reported
         * in the footer and grouping falls back to the whole event name.
         */
        function nameRegex(cfg) {
            var src = trim(cfg.NamePattern);
            if (!src) { return { re: null, bad: false }; }
            try { return { re: new RegExp(src), bad: false }; }
            catch (e) { return { re: null, bad: true }; }
        }

        /**
         * Which group does this event belong to — or, when periods are in use,
         * this slice of it, which starts at `at`? '' means "(unassigned)".
         */
        function keyFor(ev, d, rx, at, weekStart) {
            var mode = d.by;
            if (mode === 'none') { return 'All events'; }
            if (isPeriod(mode)) { return periodKey(at, mode, weekStart); }
            if (mode === 'template') { return trim(ev.template); }
            if (mode === 'element') { return trim(ev.elName); }
            if (mode === 'attribute') {
                var got = ev.attrs[d.attr.toLowerCase()];
                var v = got ? got.v : null;
                return (v === null || v === undefined) ? '' : trim(String(v));
            }
            // 'name' — the reason is very often buried in the event name and a
            // regex is the only way to get it out. Capture group 1 wins; with no
            // pattern the whole name is the group.
            if (rx && rx.re) {
                var m = rx.re.exec(ev.name || '');
                if (!m) { return ''; }
                return trim(m.length > 1 && m[1] !== undefined ? m[1] : m[0]);
            }
            return trim(ev.name);
        }

        function labelFor(key, d) {
            if (!key) { return UNASSIGNED; }
            return isPeriod(d.by) ? periodLabel(key, d.by) : key;
        }

        /** An attribute value as a number, or null. A digital state, a
         *  "Bad Input", or text is not a quantity and is never read as 0. */
        function numericOf(got) {
            var v = got ? got.v : null;
            if (typeof v === 'number') { return isFinite(v) ? v : null; }
            if (typeof v === 'string' && /^\s*[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?\s*$/i.test(v)) { return parseFloat(v); }
            return null;
        }

        /**
         * Events -> FACTS: one per event, clipped to the window, or one per
         * slice of it when a period is in use (see sliceAt). A fact carries
         * its key at every level and in the split, so a drill-down or a pivot
         * is a filter over the same list, never a second query.
         *
         * Counts, means and attribute values belong to the event and go with
         * its FIRST slice — the period it started in. Time is split. Both are
         * the conventional reading, and the footer says so when it mattered.
         */
        function factsFor(cfg, d, win, rx) {
            // An open event runs to the window end or to NOW, whichever is
            // earlier — a window that extends into the future must not book
            // downtime that has not happened yet.
            var openEnd = Math.min(win.to, win.now);
            var ds = allDims(d);
            var kinds = [];
            for (var i = 0; i < ds.length; i++) {
                if (isPeriod(ds[i].by) && kinds.indexOf(ds[i].by) === -1) { kinds.push(ds[i].by); }
            }
            var ws = cfg.WeekStart;
            var mAttr = metricDef(cfg).attr.toLowerCase();
            var out = { facts: [], outOfWindow: 0, sliced: 0, units: '' };

            for (i = 0; i < state.events.length; i++) {
                var ev = state.events[i];
                /* CLIPPING — requirement 1.
                 * Only the part of the event INSIDE the window counts. An event
                 * that started three days before the window and is still running
                 * contributes the window, not its whole life; summing raw
                 * durations over-reports, and that number ends up in a report. */
                var from = Math.max(ev.start, win.from);
                var to = Math.min(ev.open ? openEnd : ev.end, win.to);
                if (!(to > from)) {
                    // Zero or negative overlap. 'Overlapped' should not return
                    // these, but a clock skew or a zero-length event can, and a
                    // negative duration would corrupt every total downstream.
                    out.outOfWindow += 1;
                    continue;
                }
                var mv = null;
                if (mAttr) {
                    mv = numericOf(ev.attrs[mAttr]);
                    if (mv !== null && !out.units && ev.attrs[mAttr].u) { out.units = ev.attrs[mAttr].u; }
                }
                var parts = sliceAt(from, to, kinds, ws);
                if (parts.length > 1) { out.sliced += 1; }
                for (var j = 0; j < parts.length; j++) {
                    var f = {
                        ev: ev, from: parts[j].from, to: parts[j].to, first: j === 0,
                        evDur: to - from, mv: mv, keys: [], skey: ''
                    };
                    for (var L = 0; L < d.levels.length; L++) {
                        f.keys.push(keyFor(ev, d.levels[L], rx, parts[j].from, ws));
                    }
                    if (d.split) { f.skey = keyFor(ev, d.split, rx, parts[j].from, ws); }
                    out.facts.push(f);
                }
            }
            return out;
        }

        /** Everything any metric needs, over a set of facts. */
        function aggregate(facts) {
            var g = {
                count: 0, evSum: 0, rawSum: 0, max: 0, merged: 0, open: 0,
                first: Infinity, last: -Infinity, missing: 0, stats: null, facts: facts
            };
            var intervals = [], vals = [];
            for (var i = 0; i < facts.length; i++) {
                var f = facts[i];
                intervals.push({ from: f.from, to: f.to });
                g.rawSum += f.to - f.from;
                if (f.from < g.first) { g.first = f.from; }
                if (f.to > g.last) { g.last = f.to; }
                if (!f.first) { continue; }
                g.count += 1;
                g.evSum += f.evDur;
                if (f.evDur > g.max) { g.max = f.evDur; }
                if (f.ev.open) { g.open += 1; }
                if (f.mv === null) { g.missing += 1; } else { vals.push(f.mv); }
            }
            /* MERGE — requirement 3. Two operators logging the same outage is
             * one outage. */
            g.merged = mergedTotal(intervals);
            g.stats = summarize(vals);
            return g;
        }

        /** The chosen metric over an aggregate; null when there is nothing to
         *  summarise (no event in it carries a number). */
        function metricOf(g, key) {
            if (key === 'count') { return g.count; }
            if (key === 'meanDuration') { return g.count ? g.evSum / g.count : 0; }
            if (key === 'maxDuration') { return g.max; }
            if (key === 'totalDuration') { return g.merged; }
            var st = g.stats;
            if (!st || !st.n) { return null; }
            if (key === 'attrSum') { return st.sum; }
            if (key === 'attrMean') { return st.mean; }
            if (key === 'attrMin') { return st.min; }
            if (key === 'attrMax') { return st.max; }
            if (key === 'attrMedian') { return st.median; }
            return st.std;
        }

        /** A group's value as a number to draw: a group with nothing to
         *  summarise draws as nothing, and its label says so. */
        function vOf(it) { return it.value === null || it.value === undefined ? 0 : it.value; }

        /**
         * Pool several groups into one ("Other"). Every metric is recomputed
         * from the pooled events — the mean of the rest is the mean of their
         * events, not the mean of their means — except the total duration,
         * which is the SUM of the per-group unions: the cumulative line has to
         * add up to the same total the individual bars do, and cross-group
         * overlap is a property of the window (m.covered), not of any group.
         */
        function pooled(groups, mk, label) {
            var facts = [];
            var merged = 0;
            for (var i = 0; i < groups.length; i++) {
                facts = facts.concat(groups[i].facts);
                merged += groups[i].merged;
            }
            var g = aggregate(facts);
            g.merged = merged;
            g.label = label;
            g.key = null;
            g.isOther = true;
            g.unassigned = false;
            g.value = metricOf(g, mk);
            return g;
        }

        function buildModel(cfg) {
            var win = state.win;
            var md = metricDef(cfg);
            var mk = md.key;
            var d = dimsOf(cfg);
            // A drill-down deeper than the levels now configured (one was
            // removed in the pane) comes back up to the deepest that exists.
            if (drill.length > d.levels.length - 1) { drill.length = d.levels.length - 1; }
            var level = drill.length;
            var cur = d.levels[level];
            var m = {
                items: [], cum: null, groupCount: 0,
                count: 0, openCount: 0, outOfWindow: 0,
                rawSum: 0, mergedSum: 0, covered: 0,
                windowSpan: 0, from: 0, to: 0,
                unassigned: 0, allUnassigned: false,
                total: 0, notes: [], metric: mk, metricLabel: md.label,
                additive: md.additive, isDuration: md.duration,
                isAttr: !!ATTR_METRICS[mk], attr: md.attr, units: '',
                unit: DURATION_UNITS.hours, badPattern: false,
                otherCount: 0, missingValue: 0,
                level: level, levels: d.levels.length, dim: cur, split: d.split,
                period: isPeriod(cur.by), series: null, stack: null, pivot: null,
                overall: null, overallAgg: null, targets: null, partsOver: false
            };
            if (!win) { return m; }

            m.from = win.from;
            m.to = win.to;
            m.windowSpan = Math.max(1, win.to - win.from);

            var rx = nameRegex(cfg);
            var usesName = false;
            var ds = allDims(d);
            for (var i = 0; i < ds.length; i++) { if (ds[i].by === 'name') { usesName = true; } }
            m.badPattern = rx.bad && usesName;

            var F = factsFor(cfg, d, win, rx);
            m.outOfWindow = F.outOfWindow;
            m.units = trim(cfg.MetricUnits) || F.units;

            // The drill-down is a filter: the facts under every group clicked so far.
            var facts = [];
            for (i = 0; i < F.facts.length; i++) {
                var keep = true;
                for (var j = 0; j < level; j++) {
                    if (F.facts[i].keys[j] !== drill[j].key) { keep = false; break; }
                }
                if (keep) { facts.push(F.facts[i]); }
            }

            var all = aggregate(facts);
            m.overallAgg = all;
            m.count = all.count;
            m.openCount = all.open;
            m.rawSum = all.rawSum;
            m.covered = all.merged;
            m.missingValue = m.isAttr ? all.missing : 0;
            var sliced = 0;
            for (i = 0; i < facts.length; i++) { if (facts[i].first && facts[i].evDur > facts[i].to - facts[i].from) { sliced += 1; } }

            var byKey = {}, order = [];
            for (i = 0; i < facts.length; i++) {
                var k = facts[i].keys[level];
                if (!Object.prototype.hasOwnProperty.call(byKey, k)) { byKey[k] = []; order.push(k); }
                byKey[k].push(facts[i]);
            }

            var makeItem = function (key, list) {
                var g = aggregate(list);
                g.key = key;
                g.label = labelFor(key, cur);
                g.isOther = false;
                // requirement 4: never dropped, and it reads as a gap
                g.unassigned = !key;
                g.value = metricOf(g, mk);
                return g;
            };

            if (m.period) {
                // Time order, and every period in the window — empty ones too.
                var range = periodRange(win.from, win.to, cur.by, cfg.WeekStart);
                var seen = {};
                for (i = 0; i < range.keys.length; i++) {
                    seen[range.keys[i]] = true;
                    m.items.push(makeItem(range.keys[i], byKey[range.keys[i]] || []));
                }
                // A slice past the cap still has to land somewhere it is seen.
                var late = [];
                for (i = 0; i < order.length; i++) {
                    if (!seen[order[i]]) { late.push(makeItem(order[i], byKey[order[i]])); }
                }
                if (late.length) {
                    m.items.push(pooled(late, mk, 'Later (' + late.length + ')'));
                    m.notes.push('more than ' + MAX_PERIODS + ' periods — the rest combined as "Later"');
                }
            } else {
                for (i = 0; i < order.length; i++) { m.items.push(makeItem(order[i], byKey[order[i]])); }
            }

            for (i = 0; i < m.items.length; i++) {
                m.mergedSum += m.items[i].merged;
                if (m.items[i].unassigned) { m.unassigned += m.items[i].count; }
            }
            m.groupCount = m.items.length;
            m.allUnassigned = m.count > 0 && m.unassigned === m.count;

            // A sum that goes negative (a gain logged as negative loss) does
            // not divide into parts of a whole any more.
            if (mk === 'attrSum') {
                for (i = 0; i < m.items.length; i++) {
                    if (m.items[i].value !== null && m.items[i].value < 0) { m.additive = false; m.negative = true; break; }
                }
            }

            // Rank. Ties break on label so the order does not shuffle between
            // refreshes — a ranking that reshuffles is unreadable on a kiosk.
            // Periods keep time order: ranking days scrambles the calendar.
            if (!m.period) {
                m.items.sort(function (a, b) {
                    var av = a.value === null ? -Infinity : a.value;
                    var bv = b.value === null ? -Infinity : b.value;
                    if (av !== bv) { return bv > av ? 1 : -1; }
                    return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
                });
            }

            // --- Top N ---------------------------------------------------
            // Not for periods: dropping the quietest days would hide the good news.
            var topN = intIn(cfg.TopN, 0, 200, 10);
            var hidden = 0;
            if (!m.period && topN > 0 && m.items.length > topN) {
                var rest = m.items.slice(topN);
                m.items = m.items.slice(0, topN);
                if (cfg.GroupRemainderAsOther !== false) {
                    m.items.push(pooled(rest, mk, 'Other (' + rest.length + ')'));
                    m.otherCount = rest.length;
                } else {
                    hidden = rest.length;
                }
            }

            // --- totals + cumulative --------------------------------------
            var shown = 0;
            for (i = 0; i < m.items.length; i++) { shown += vOf(m.items[i]); }
            m.total = shown;
            // The whole, as one number: the duration total the footer already
            // gives, the sum of the counts, and every other metric taken over
            // all the events — a true overall mean, never a mean of means.
            m.overall = mk === 'totalDuration' ? m.mergedSum : metricOf(all, mk);

            // A running percentage only means something when the parts sum to
            // the whole. A mean or a maximum does not, so no Pareto line; nor
            // do periods, which are in time order rather than ranked.
            if (cfg.ShowCumulative !== false && m.additive && !m.period && shown > 0 && m.items.length) {
                m.cum = [];
                var run = 0;
                for (i = 0; i < m.items.length; i++) {
                    run += vOf(m.items[i]);
                    m.cum.push((run / shown) * 100);
                }
            }

            // Display unit for durations, resolved from the biggest bar so the
            // axis reads in whole-ish numbers rather than 0.003 days.
            var biggest = 0;
            for (i = 0; i < m.items.length; i++) { if (vOf(m.items[i]) > biggest) { biggest = vOf(m.items[i]); } }
            m.unit = resolveUnit(cfg, biggest);

            if (d.split) { splitModel(m, facts, d.split, cfg, mk); }
            applyTargets(m, cfg);

            /* ---- notes: everything the picture cannot say for itself ---- */
            if (state.capped) {
                // Truncation is not merely "some events missing". PI Web API
                // returns the first N by start time, not the N that matter, so
                // the RANKING may be wrong. Say that, not "showing 1000".
                m.notes.push('capped at ' + state.maxEvents + ' events — the ranking may be incomplete');
            }
            if (m.rawSum > m.mergedSum + 500) {
                // Disclosed, with the size of the correction: an engineer
                // comparing this against a hand-built spreadsheet needs to know
                // why the two disagree.
                m.notes.push('overlaps merged: −' +
                    PVX.fmt.duration(m.rawSum - m.mergedSum) + ' vs raw sum');
            }
            if (m.openCount && cfg.ShowOpenEventNote !== false) {
                m.notes.push(m.openCount + ' open ' + (m.openCount === 1 ? 'event' : 'events') +
                    ' counted to now (totals grow)');
            }
            if (m.unassigned && !m.allUnassigned) {
                m.notes.push(m.unassigned + '/' + m.count + ' events have no ' + groupNoun(cur));
            }
            if (m.isAttr && m.missingValue && m.missingValue < m.count) {
                // Nothing dropped silently: an event with no number is not a zero.
                m.notes.push(m.missingValue + '/' + m.count + ' events have no number for ' +
                    (m.attr || 'the attribute') + ' — not in the ' + m.metricLabel.split(' ')[0].toLowerCase());
            }
            if (sliced) {
                m.notes.push(sliced + (sliced === 1 ? ' event crosses' : ' events cross') +
                    ' a period boundary: time split, counted where it starts');
            }
            if (hidden) { m.notes.push('+' + hidden + ' groups not shown'); }
            if (m.outOfWindow) {
                m.notes.push(m.outOfWindow + ' events fall outside the window');
            }
            if (m.badPattern) {
                m.notes.push('name pattern is not a valid regular expression — grouping by full name');
            }
            if (state.failedBatch > 0) {
                m.notes.push(state.failedBatch + ' follow-up ' +
                    (state.failedBatch === 1 ? 'request' : 'requests') +
                    ' failed — those events are unassigned');
            } else if (state.failedBatch === -1) {
                m.notes.push('follow-up request failed — grouping is incomplete');
            }
            if (m.negative) {
                m.notes.push('the sum goes below zero — no cumulative %, donut or stacking');
            } else if (!m.additive && cfg.ShowCumulative !== false && chartMode(cfg) === 'pareto') {
                m.notes.push('cumulative % hidden: ' + m.metricLabel.toLowerCase() + ' does not sum to a whole');
            } else if (m.period && cfg.ShowCumulative !== false && chartMode(cfg) === 'pareto') {
                m.notes.push('no cumulative %: periods are in time order, not ranked');
            }
            if (win.useRaw) { m.notes.push('time range resolved by PI Web API'); }
            return m;
        }

        /**
         * The second dimension. Series are the split's values, ranked by the
         * same metric (periods in time order), the first SplitTopN kept and
         * the rest pooled. Every group gets one part per series — a pivot
         * cell — computed from that group's events with that value, so a
         * cell's mean is a real mean, not a share of one.
         *
         * Stacking only adds up for an additive metric. Total duration has a
         * wrinkle: one outage logged under two reason codes is merged within
         * each, so the parts of a bar can add up to more than its own merged
         * total. The bar is drawn at the sum of its parts and the footer says
         * so, rather than squeezing the parts to fit.
         */
        function splitModel(m, facts, sd, cfg, mk) {
            var byS = {}, order = [];
            for (var i = 0; i < facts.length; i++) {
                var k = facts[i].skey;
                if (!Object.prototype.hasOwnProperty.call(byS, k)) { byS[k] = []; order.push(k); }
                byS[k].push(facts[i]);
            }
            var series = [];
            for (i = 0; i < order.length; i++) {
                var agg = aggregate(byS[order[i]]);
                series.push({ key: order[i], label: labelFor(order[i], sd), value: metricOf(agg, mk),
                              agg: agg, isOther: false, unassigned: !order[i] && !isPeriod(sd.by) });
            }
            if (isPeriod(sd.by)) {
                series.sort(function (a, b) {
                    if (sd.by === 'weekday') {
                        var ws = cfg.WeekStart === 'sunday' ? 0 : 1;
                        return ((+a.key - ws + 7) % 7) - ((+b.key - ws + 7) % 7);
                    }
                    return (+a.key) - (+b.key);
                });
            } else {
                series.sort(function (a, b) {
                    var av = a.value === null ? -Infinity : a.value;
                    var bv = b.value === null ? -Infinity : b.value;
                    if (av !== bv) { return bv > av ? 1 : -1; }
                    return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
                });
            }
            var topS = intIn(cfg.SplitTopN, 0, 24, 6);
            if (topS > 0 && series.length > topS) {
                var restS = series.slice(topS);
                series = series.slice(0, topS);
                var pf = [];
                for (i = 0; i < restS.length; i++) { pf = pf.concat(restS[i].agg.facts); }
                var oagg = aggregate(pf);
                series.push({ key: null, keys: restS.map(function (s) { return s.key; }),
                              label: 'Other (' + restS.length + ')', value: metricOf(oagg, mk),
                              agg: oagg, isOther: true, unassigned: false });
            }
            // "(unassigned)" wears the warning colour everywhere on this
            // chart, so a palette colour close to it is skipped: two oranges
            // side by side in one bar read as one.
            var pal = PVX.color.categorical;
            var warn = PVX.color.status.warning;
            var rgb = function (h) {
                var x = /^#?([0-9a-f]{6})$/i.exec(String(h));
                if (!x) { return null; }
                var n = parseInt(x[1], 16);
                return [n >> 16, (n >> 8) & 255, n & 255];
            };
            var w0 = rgb(warn);
            var usable = [];
            for (i = 0; i < pal.length; i++) {
                var c = rgb(pal[i]);
                var near = w0 && c && Math.sqrt(Math.pow(c[0] - w0[0], 2) + Math.pow(c[1] - w0[1], 2) + Math.pow(c[2] - w0[2], 2)) < 120;
                if (!near) { usable.push(pal[i]); }
            }
            if (!usable.length) { usable = pal; }
            var nextColor = 0;
            for (i = 0; i < series.length; i++) {
                series[i].color = series[i].isOther ? '#9aa4b0'
                    : (series[i].unassigned ? warn : usable[nextColor++ % usable.length]);
            }
            m.series = series;

            // Each group's part in each series.
            var inSeries = function (f, s) {
                return s.isOther ? s.keys.indexOf(f.skey) !== -1 : f.skey === s.key;
            };
            for (i = 0; i < m.items.length; i++) {
                var it = m.items[i];
                it.parts = [];
                var sum = 0;
                for (var s = 0; s < series.length; s++) {
                    var sub = [];
                    for (var q = 0; q < it.facts.length; q++) {
                        if (inSeries(it.facts[q], series[s])) { sub.push(it.facts[q]); }
                    }
                    var v = sub.length ? metricOf(aggregate(sub), mk) : null;
                    it.parts.push(v);
                    sum += v || 0;
                }
                it.partSum = sum;
                if (mk === 'totalDuration' && sum > it.merged + 500) { m.partsOver = true; }
            }

            if (m.additive) {
                m.stack = cfg.SplitMode === 'percent' ? 'percent' : 'stacked';
            } else {
                var mode = chartMode(cfg);
                if (mode === 'pareto' || mode === 'bars') {
                    m.notes.push('split needs a metric that adds up (total, count or sum) — bars not split; the pivot shows it');
                }
            }
            if (m.partsOver && m.stack) {
                m.notes.push('one outage under two ' + groupNoun(sd) + ' values counts in each');
            }
        }

        /**
         * Targets per group, in the metric's own terms. A duration target is
         * `4h` or `90m`, or a bare number in the chosen duration unit (hours
         * on Automatic, since that is what nobody misreads).
         */
        function applyTargets(m, cfg) {
            var T = parseTargets(cfg.Targets);
            if (!T.count && !T.bad.length) { return; }
            var bare = DURATION_UNITS[cfg.DurationUnit] ? DURATION_UNITS[cfg.DurationUnit].ms : 3600000;
            var lower = cfg.TargetDirection !== 'higher';
            var unread = T.bad.length;
            var judge = function (it, raw) {
                if (raw === undefined || raw === null) { return; }
                var tv = targetValue(raw, m.isDuration, bare);
                if (tv === null) { unread += 1; return; }
                it.target = tv;
                if (it.value === null || it.value === undefined) { return; }
                it.delta = it.value - tv;
                it.pctOf = tv !== 0 ? (it.value / tv) * 100 : null;
                it.good = lower ? it.value <= tv : it.value >= tv;
            };
            for (var i = 0; i < m.items.length; i++) {
                var it = m.items[i];
                if (it.isOther) { continue; }   // a bucket has no target of its own
                var own = T.map[String(it.label).toLowerCase()];
                judge(it, own !== undefined ? own : T.def);
            }
            m.totalItem = { label: 'Total', value: m.overall, count: m.count, isTotal: true };
            judge(m.totalItem, T.map.total !== undefined ? T.map.total : T.map.all);
            m.targets = { lower: lower, count: T.count };
            if (unread) {
                m.notes.push(unread + ' target ' + (unread === 1 ? 'line' : 'lines') + ' not understood');
            }
        }

        /** What the operator called the thing they grouped by, for prose. */
        function groupNoun(d) {
            if (d.by === 'attribute') { return d.attr || 'attribute value'; }
            if (d.by === 'element') { return 'referenced element'; }
            if (d.by === 'template') { return 'template'; }
            if (d.by === 'name') { return 'name match'; }
            if (isPeriod(d.by)) { return d.by === 'weekday' ? 'day of the week' : d.by; }
            return 'group';
        }

        function groupByLabel(d) {
            if (d.by === 'attribute') { return d.attr || 'attribute'; }
            if (d.by === 'element') { return 'asset'; }
            if (d.by === 'name') { return 'event name'; }
            if (d.by === 'none') { return 'all events'; }
            if (d.by === 'weekday') { return 'day of the week'; }
            if (isPeriod(d.by)) { return d.by; }
            return 'template';
        }

        /**
         * Display unit for durations. 'auto' picks from the largest value so a
         * chart of four-minute trips is not labelled in days, and a chart of
         * week-long outages is not labelled in 10080-minute bars.
         */
        function resolveUnit(cfg, maxMs) {
            var u = cfg.DurationUnit;
            if (Object.prototype.hasOwnProperty.call(DURATION_UNITS, u)) { return DURATION_UNITS[u]; }
            if (maxMs < 90 * 60000) { return DURATION_UNITS.minutes; }
            if (maxMs < 48 * 3600000) { return DURATION_UNITS.hours; }
            return DURATION_UNITS.days;
        }

        /**
         * A span of time, as text.
         * 'auto' gets the human form ("2d 4h"), which is what an operator reads
         * fastest; an explicit unit gets one comparable number, which is what
         * anyone copying the figure into a report actually wants.
         */
        function durText(ms, cfg) {
            var u = DURATION_UNITS[cfg && cfg.DurationUnit];
            if (!u) { return PVX.fmt.duration(ms); }
            var n = ms / u.ms;
            // Nothing is "0", not "0.00": an empty day is a whole number.
            return PVX.fmt.number(n, { decimals: n === 0 || n >= 100 ? 0 : (n >= 10 ? 1 : 2) }) + ' ' + u.label;
        }

        /** The chosen metric's value as it is drawn on a bar or in a cell.
         *  A group with nothing to summarise reads as a dash, never as 0. */
        function valueText(v, m, cfg) {
            if (v === null || v === undefined) { return '\u2014'; }
            if (m.isDuration) { return durText(v, cfg); }
            if (!m.isAttr) { return PVX.fmt.number(v, { decimals: 0 }); }
            return attrText(v, m, cfg);
        }

        /** An attribute summary: the decimals asked for, else from its size. */
        function attrText(v, m, cfg) {
            var dec = parseInt(cfg.MetricDecimals, 10);
            if (!(dec >= 0 && dec <= 6)) {
                var a = Math.abs(v);
                dec = a >= 100 ? 0 : (a >= 10 ? 1 : 2);
            }
            return PVX.fmt.number(v, { decimals: dec }) + (m.units ? ' ' + m.units : '');
        }

        /** Axis ticks are always a plain number in the resolved unit. */
        function tickText(v, m) {
            return m.isDuration ? PVX.fmt.tick(v / m.unit.ms) : PVX.fmt.tick(v);
        }

        /* ================================================================ *
         * render
         * ================================================================ */

        function render(c) {
            var cfg = liveCfg = c.config || liveCfg;
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            var W = Math.max(40, host.clientWidth || c.width || 40);
            var H = Math.max(24, host.clientHeight || c.height || 24);

            /* The size thresholds are measured against the SYMBOL, not the
             * drawing host — and that is load-bearing, not pedantry. The host is
             * what is left after the header and footer, so measuring it makes
             * the decision depend on the chrome the decision itself removes:
             * drop the summary, the footer shrinks, the host grows past the
             * threshold, the summary comes back, and the symbol oscillates
             * between two layouts on every frame. */
            var rootW = Math.max(40, (c.node && c.node.clientWidth) || W);
            var rootH = Math.max(24, (c.node && c.node.clientHeight) || H);
            var minimal = rootW < MINIMAL_W || rootH < MINIMAL_H;
            var compact = minimal || rootW < COMPACT_W || rootH < COMPACT_H;
            chromeOff = minimal;

            var svgRoot = host.querySelector('svg.pvx-ea-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-ea-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);
            hits = [];

            scope.pvx.title = minimal ? '' : (trim(cfg.Title) || 'Event analytics');
            scope.pvx.subtitle = '';
            scope.pvx.summary = '';
            scope.pvx.note = '';
            scope.pvx.clickable = cfg.ClickAction === 'navigate' || cfg.ClickAction === 'drill';
            scope.pvx.crumbs = [];
            bindHost(host);

            // A change to what the levels ARE starts the drill-down again: a
            // trail of keys from the old grouping filters the new one to nothing.
            var sig = [cfg.GroupBy, cfg.GroupAttribute, cfg.DrillBy, cfg.DrillAttribute,
                       cfg.DrillBy2, cfg.DrillAttribute2, cfg.NamePattern, cfg.WeekStart].join('\n');
            if (sig !== drillSig) { drillSig = sig; drill = []; }

            if (state.phase !== 'ok') {
                drawStatus(svgRoot, W, H, t, minimal);
                digest();
                return;
            }

            model = buildModel(cfg);
            var cur = model.dim;
            if (drill.length && !minimal) {
                scope.pvx.crumbs.push({ label: 'All', i: 0 });
                for (var di = 0; di < drill.length; di++) {
                    scope.pvx.crumbs.push({ label: drill[di].label, i: di + 1, last: di === drill.length - 1 });
                }
            }

            if (!minimal) {
                // The window is dropped from the subtitle on a narrow symbol. It
                // is the least surprising thing on that line — the display's own
                // time bar already says it — and keeping it costs the operator's
                // own title, which nothing else shows.
                scope.pvx.subtitle = subtitleText(model, cfg, rootW >= 420);
            }

            // ---- distinct "the query worked but there is nothing to rank" states
            if (!model.count) {
                drawMessage(svgRoot, W, H, t, 'No events in this window',
                    minimal ? '' : describeFilter(cfg), t.textMuted);
                digest();
                return;
            }
            if (model.isAttr && (!model.attr || model.missingValue === model.count)) {
                drawMessage(svgRoot, W, H, t,
                    model.attr ? 'No event has a number for "' + model.attr + '"' : 'No attribute to summarise',
                    minimal ? '' : (model.attr
                        ? 'All ' + model.count + ' events came back without a numeric value for that attribute. ' +
                          'Check the spelling against the Event Frame template \u2014 attribute names are exact \u2014 ' +
                          'and that it holds a number rather than text or a digital state.'
                        : 'Name the event attribute to add up or average \u2014 for example "Lost Production". ' +
                          'It must exist on the Event Frame template.'),
                    PVX.color.status.warning);
                if (!minimal) { scope.pvx.note = model.notes.join(' \u00b7 '); }
                digest();
                return;
            }
            if (model.allUnassigned && (cur.by === 'attribute' || cur.by === 'name')) {
                drawMessage(svgRoot, W, H, t, missingGroupHeadline(cur, cfg),
                    minimal ? '' : missingGroupDetail(cur, cfg, model), PVX.color.status.warning);
                if (!minimal) { scope.pvx.note = model.notes.join(' \u00b7 '); }
                if (!minimal && state.db.from) { addNote('database ' + state.db.path + ' from ' + state.db.from); }
                digest();
                return;
            }
            if (model.groupCount === 1 && cur.by !== 'none' && !model.period && !model.series) {
                // A ranking of one is not a ranking. Say what the one group is —
                // that IS the answer — and say what to change to get a breakdown.
                var only = model.items[0];
                drawMessage(svgRoot, W, H, t,
                    'All ' + model.count + ' events are "' + only.label + '"',
                    minimal ? '' :
                    'Nothing to rank by ' + groupByLabel(cur) + '. ' +
                    valueText(only.value, model, cfg) + ' ' + model.metricLabel.toLowerCase() +
                    '. Group by something that varies, or use the name pattern to pull a reason ' +
                    'code out of the event name.', t.textMuted);
                if (!minimal) { scope.pvx.note = model.notes.join(' \u00b7 '); }
                if (!minimal && state.db.from) { addNote('database ' + state.db.path + ' from ' + state.db.from); }
                digest();
                return;
            }

            if (!compact && cfg.ShowSummary !== false) {
                scope.pvx.summary = summaryText(model, cfg);
            }
            if (!minimal) { scope.pvx.note = model.notes.join(' \u00b7 '); }
            if (!minimal && state.db.from) { addNote('database ' + state.db.path + ' from ' + state.db.from); }

            var mode = chartMode(cfg);
            if (mode === 'donut' && !model.additive) {
                // A donut asserts that the slices make a whole. A mean does not.
                addNote('donut needs an additive metric \u2014 showing bars');
                mode = 'bars';
            }
            if (mode === 'pivot' && !model.series) {
                addNote('a pivot needs a Split by \u2014 showing the table');
                mode = 'table';
            }
            if (model.series && (mode === 'donut' || mode === 'cards')) {
                addNote('the split is drawn by bars and the pivot');
            }
            // Below the minimal size there is room for bars and nothing else. A
            // donut that small is a ring with no legend and no readable slice
            // labels, and a table is one clipped row — both are worse than the
            // shape comparison the bars still give.
            if (minimal) { mode = 'bars'; }

            if (mode === 'donut') { drawDonut(svgRoot, W, H, cfg, t, model, compact, minimal); }
            else if (mode === 'table') { drawTable(svgRoot, W, H, cfg, t, model, compact); }
            else if (mode === 'pivot') { drawPivot(svgRoot, W, H, cfg, t, model, compact); }
            else if (mode === 'cards') { drawCards(svgRoot, W, H, cfg, t, model, compact); }
            else { drawRanked(svgRoot, W, H, cfg, t, model, compact, minimal, mode === 'pareto'); }

            digest();
        }

        function subtitleText(m, cfg, withRange) {
            var unit = (m.isDuration && cfg.DurationUnit !== 'auto' && cfg.DurationUnit)
                ? ' (' + m.unit.label + ')' : '';
            var s = m.metricLabel + unit + ' by ' + groupByLabel(m.dim) +
                (m.split ? ' and ' + groupByLabel(m.split) : '');
            if (withRange) {
                s += ' \u00b7 ' + PVX.fmt.time(m.from, 'short') + ' \u2013 ' + PVX.fmt.time(m.to, 'short');
            }
            return s;
        }

        /**
         * The footer line. Every number in it is one the operator could be asked
         * to defend: how many events, how much time they consumed, how much of
         * the window that union covers, and what fraction of the window that is.
         */
        function summaryText(m, cfg) {
            var pct = (m.covered / m.windowSpan) * 100;
            // Always a duration, whatever the ranking metric is: "how much time
            // did this cost" is the question the footer answers.
            var bits = [
                m.count + (m.count === 1 ? ' event' : ' events'),
                durText(m.mergedSum, cfg) + ' total'
            ];
            // Coverage is the union across ALL groups, so it is the honest
            // answer to "how much of the window was affected" even when two
            // reason codes overlap in time.
            bits.push(PVX.fmt.duration(m.covered) + ' of ' + PVX.fmt.duration(m.windowSpan) +
                ' (' + PVX.fmt.percent(pct, pct < 10 ? 1 : 0) + ' of window)');
            if (m.openCount) { bits.push(m.openCount + ' open'); }
            // The attribute's own whole, beside the time: "16.5 t lost".
            if (m.isAttr && m.overall !== null) {
                bits.push(m.metricLabel + ' ' + valueText(m.overall, m, cfg));
            }
            return bits.join(' \u00b7 ');
        }

        function describeFilter(cfg) {
            var bits = [];
            if (trim(cfg.TemplateName)) { bits.push('template "' + trim(cfg.TemplateName) + '"'); }
            if (trim(cfg.NameFilter)) { bits.push('name "' + trim(cfg.NameFilter) + '"'); }
            if (trim(cfg.ElementNameFilter)) { bits.push('element "' + trim(cfg.ElementNameFilter) + '"'); }
            return bits.length
                ? 'Nothing matched ' + bits.join(' and ') + '. Widen the filter or the time range.'
                : 'No event frames overlap this time range on ' + state.db.path +
                  (state.db.from ? ' (from ' + state.db.from + ')' : '') + '.';
        }

        function missingGroupHeadline(d, cfg) {
            if (d.by === 'attribute') {
                return d.attr
                    ? 'No event has "' + d.attr + '"'
                    : 'No grouping attribute set';
            }
            return 'No event name matched the pattern';
        }

        function missingGroupDetail(d, cfg, m) {
            if (d.by === 'attribute') {
                if (!d.attr) {
                    return 'Grouping by event attribute needs the attribute name — for example "Reason Code". ' +
                           'It must exist on the Event Frame template.';
                }
                return 'All ' + m.count + ' events came back without a value for that attribute. Check the ' +
                       'spelling against the Event Frame template — attribute names are exact — and that the ' +
                       'signed-in user can read it.';
            }
            return 'The pattern "' + trim(cfg.NamePattern) + '" matched none of the ' + m.count +
                   ' event names. Capture group 1 becomes the group, so a pattern like ' +
                   '"- ([A-Z]+)-" pulls MECH out of "Downtime - Mill 1 - MECH-04".';
        }

        /* ---- non-chart states -------------------------------------------- *
         * Four different problems with four different owners. One shared "no
         * data" message would send every one of them to the wrong person.
         */
        function drawStatus(svgRoot, W, H, t, minimal) {
            if (state.phase === 'unconfigured') {
                drawMessage(svgRoot, W, H, t, 'PI Web API is not configured',
                    minimal ? '' :
                    PVX.api.unsetHint() + ', then confirm it ' +
                    'with ext/piwebapi-check.html — that page reproduces exactly what this symbol does ' +
                    'and names what to fix.', PVX.color.status.warning);
                return;
            }
            if (state.phase === 'nodb') {
                drawMessage(svgRoot, W, H, t, 'No AF database configured',
                    minimal ? '' :
                    'Drop an AF attribute onto this symbol to use its database, or set the AF database ' +
                    'path in the format pane, for example \\\\AFSERVER01\\Production.',
                    PVX.color.status.warning);
                return;
            }
            if (state.phase === 'error') {
                var e = (state.error && state.error.pvxError) || null;
                drawMessage(svgRoot, W, H, t, 'PI Web API request failed',
                    minimal ? '' :
                    (e ? e.message + '  \u2014  Check: ' + e.check
                       : 'The request failed and returned no diagnosis.'),
                    PVX.color.status.alarm);
                return;
            }
            drawMessage(svgRoot, W, H, t, 'Loading events\u2026', '', t.textMuted);
        }

        /* ================================================================ *
         * colour
         * ================================================================ */

        function colorFor(item, i, m, cfg, t) {
            var base = trim(cfg.BarColor) || '#3b82c4';
            if (item.isOther) {
                // "Other" is a bucket, not a finding. It is deliberately the
                // quietest mark on the chart so it never out-shouts a real
                // reason code.
                return t.dark ? '#6f7378' : '#9aa4b0';
            }
            if (cfg.ColorMode === 'palette') {
                return PVX.color.categorical[i % PVX.color.categorical.length];
            }
            if (cfg.ColorMode === 'target') {
                // A group with no target keeps the plain colour: only a
                // judgement gets a judgement's colour.
                if (item.good === true) { return PVX.color.status.normal; }
                if (item.good === false) { return PVX.color.status.alarm; }
                return base;
            }
            if (cfg.ColorMode === 'threshold') {
                // A duration threshold is expressed in the DISPLAY unit, which
                // is the only unit the operator saw when they typed the numbers.
                var v = m.isDuration ? vOf(item) / m.unit.ms : vOf(item);
                return cfg.UseThresholds
                    ? PVX.thresholds.colorFor(cfg.Thresholds, v, base)
                    : base;
            }
            return base;
        }

        /** "8.0 h over target 6 h", or "" when the group has no target. */
        function targetText(it, m, cfg) {
            if (it.target === undefined || it.delta === undefined) { return ''; }
            var gap = Math.abs(it.delta);
            if (gap < 1e-9) { return 'on target ' + valueText(it.target, m, cfg); }
            return valueText(gap, m, cfg) + (it.delta > 0 ? ' over' : ' under') +
                ' target ' + valueText(it.target, m, cfg);
        }

        /* ================================================================ *
         * ranked bars (pareto / bars), split into stacked parts when asked
         * ================================================================ */

        function drawRanked(svgRoot, W, H, cfg, t, m, compact, minimal, withCum) {
            var i, s;
            var items = m.items;
            var n = items.length;
            var pad = 5;
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 7.5, 12);
            var stack = m.series && m.stack ? m.stack : null;
            var series = stack ? m.series : null;
            var pct = stack === 'percent';

            var showValues = !compact && cfg.ShowValues !== false;
            var showAxis = !compact;
            var showCum = withCum && !!m.cum && !compact && !stack;
            var cumColor = PVX.color.status.alarm;
            // A legend is what makes a stacked bar readable at all; it takes
            // one line above the plot, and goes when the box cannot spare it.
            var showLegend = !!series && !minimal && H > 90;

            // What each bar is drawn at: its value, or the sum of its parts.
            var barV = function (it) { return pct ? 100 : (stack ? it.partSum : vOf(it)); };

            // Label budgets, from the glyph estimate.
            var labels = [];
            var maxValuePx = 0;
            for (i = 0; i < n; i++) {
                var lab = '';
                if (showValues) {
                    lab = stack && !pct ? valueText(items[i].partSum, m, cfg) : valueText(items[i].value, m, cfg);
                }
                labels.push(lab);
                maxValuePx = Math.max(maxValuePx, textW(labels[i], font));
            }

            var nameW = minimal ? 0 : PVX.util.clamp(W * 0.32, 30, W * 0.5);
            var legendH = showLegend ? font * 1.7 : 0;
            var plot = {
                x0: pad + nameW + (nameW > 0 ? 6 : 0),
                y0: pad + legendH + (showCum ? font * 1.9 : 0),
                x1: W - pad - (showValues ? maxValuePx + 8 : 0),
                y1: H - pad - (showAxis ? font * 1.9 : 0)
            };
            // Degenerate boxes (tiny symbol, long labels): give the chart the
            // whole frame rather than drawing nothing at all.
            if (plot.x1 - plot.x0 < 24) { plot.x0 = pad; plot.x1 = W - pad; nameW = 0; showValues = false; }
            if (plot.y1 - plot.y0 < 16) { plot.y0 = 1; plot.y1 = H - 1; showAxis = false; showLegend = false; }

            var plotW = plot.x1 - plot.x0;
            var plotH = plot.y1 - plot.y0;

            // Durations and counts are non-negative, so the domain starts at
            // zero — a bar chart whose baseline is not zero lies about ratios,
            // and ratios are the entire point of a Pareto. An attribute can go
            // below zero, and then the axis does too, with zero still marked.
            var maxV = 0, minV = 0;
            for (i = 0; i < n; i++) {
                var bv = barV(items[i]);
                if (bv > maxV) { maxV = bv; }
                if (bv < minV) { minV = bv; }
                if (items[i].target !== undefined && !pct) {
                    if (items[i].target > maxV) { maxV = items[i].target; }
                    if (items[i].target < minV) { minV = items[i].target; }
                }
            }
            if (!(maxV > minV)) { maxV = minV + 1; }
            var tickCount = PVX.util.clamp(Math.floor(plotW / 70), 2, 6);
            // Nice numbers in the unit the axis is READ in: rounded in
            // milliseconds, an hour-long axis ticks at 16.67 minutes.
            var tu = m.isDuration ? m.unit.ms : 1;
            var dom = pct ? [0, 100] : PVX.scale.niceDomain(minV / tu, maxV / tu, tickCount);
            if (!pct) { dom = [dom[0] * tu, dom[1] * tu]; }
            var vs = PVX.scale.linear(dom[0], dom[1], plot.x0, plot.x1);
            var zeroX = vs(0);
            var cs = showCum ? PVX.scale.linear(0, 100, plot.x0, plot.x1) : null;

            var slot = plotH / n;
            var thick = Math.max(1.5, Math.min(slot * 0.72, 26));
            var center = function (idx) { return plot.y0 + slot * (idx + 0.5); };
            var radius = PVX.util.clamp(PVX.util.num(cfg.CornerRadius) || 0, 0, Math.min(3, thick / 3));

            // ---- legend ----------------------------------------------------
            if (showLegend) {
                var legG = PVX.svg.el('g', { 'class': 'pvx-ea-legend' }, svgRoot);
                var lx = plot.x0, ly = pad + font * 0.7;
                for (s = 0; s < series.length; s++) {
                    var lt = fitText(series[s].label, 120, font * 0.9);
                    var need = font * 1.1 + textW(lt, font * 0.9) + 10;
                    if (lx + need > W - pad) {
                        if (s < series.length) {
                            PVX.svg.text(legG, lx.toFixed(1), (ly + font * 0.32).toFixed(1),
                                '+' + (series.length - s), {
                                    'class': 'pvx-svg-label pvx-ea-legend-more', 'font-size': (font * 0.9).toFixed(1), fill: t.textMuted
                                });
                        }
                        break;
                    }
                    PVX.svg.el('rect', { x: lx.toFixed(1), y: (ly - font * 0.4).toFixed(1),
                        width: (font * 0.8).toFixed(1), height: (font * 0.8).toFixed(1), rx: 1.5,
                        fill: series[s].color, 'class': 'pvx-ea-legend-sw' }, legG);
                    PVX.svg.text(legG, (lx + font * 1.1).toFixed(1), (ly + font * 0.32).toFixed(1), lt, {
                        'class': 'pvx-svg-label pvx-ea-legend-label', 'font-size': (font * 0.9).toFixed(1),
                        fill: series[s].unassigned ? PVX.color.status.warning : t.text
                    });
                    lx += need;
                }
            }

            // ---- grid + ticks (behind the bars) ---------------------------
            var ticks = [];
            if (showAxis) {
                ticks = PVX.scale.ticks(dom[0] / (pct ? 1 : tu), dom[1] / (pct ? 1 : tu), tickCount);
                if (!pct) { for (i = 0; i < ticks.length; i++) { ticks[i] *= tu; } }
            }
            if (showAxis) {
                var gridG = PVX.svg.el('g', { 'class': 'pvx-ea-grid' }, svgRoot);
                for (i = 0; i < ticks.length; i++) {
                    var gx = vs(ticks[i]);
                    PVX.svg.el('line', {
                        x1: gx.toFixed(2), y1: plot.y0.toFixed(2),
                        x2: gx.toFixed(2), y2: plot.y1.toFixed(2),
                        stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-grid-line'
                    }, gridG);
                    // The unit rides on the LAST tick rather than sitting in its
                    // own caption at the origin, where it collided with the "0".
                    // Without it anywhere, "36" on a duration axis is unreadable.
                    var last = i === ticks.length - 1;
                    var unitTxt = pct ? '%' : (m.isDuration ? ' ' + m.unit.label : '');
                    PVX.svg.text(gridG, gx.toFixed(2), (plot.y1 + font * 1.1).toFixed(2),
                        (pct ? String(ticks[i]) : tickText(ticks[i], m)) + (last ? unitTxt : ''), {
                            'class': 'pvx-svg-label pvx-ea-tick',
                            'text-anchor': last ? 'end' : 'middle',
                            'font-size': font, fill: t.textMuted
                        });
                }
            }

            // Baseline at zero.
            PVX.svg.el('line', {
                x1: zeroX.toFixed(2), y1: plot.y0.toFixed(2),
                x2: zeroX.toFixed(2), y2: plot.y1.toFixed(2),
                stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, svgRoot);

            // ---- 80% marker (lives on the cumulative axis) -----------------
            if (showCum && cfg.EightyLine !== false) {
                var ex = cs(80);
                PVX.svg.el('line', {
                    x1: ex.toFixed(2), y1: plot.y0.toFixed(2),
                    x2: ex.toFixed(2), y2: plot.y1.toFixed(2),
                    stroke: cumColor, 'stroke-width': 1, 'stroke-dasharray': '4 3',
                    opacity: 0.75, 'class': 'pvx-ea-eighty'
                }, svgRoot);
            }

            // ---- bars ------------------------------------------------------
            var barsG = PVX.svg.el('g', { 'class': 'pvx-ea-bars' }, svgRoot);
            for (i = 0; i < n; i++) {
                var it = items[i];
                var y = center(i) - thick / 2;
                var grp = PVX.svg.el('g', { 'class': 'pvx-ea-bar' }, barsG);
                if (scope.pvx.clickable) {
                    grp.setAttribute('class', 'pvx-ea-bar pvx-hit-group');
                    grp.setAttribute('data-pvx-i', String(hits.length));
                    hits.push(it);
                }
                var endX;
                if (stack) {
                    // Parts laid end to end from zero, in series order.
                    var at = 0;
                    var whole = it.partSum > 0 ? it.partSum : 1;
                    for (s = 0; s < series.length; s++) {
                        var pv = it.parts[s] || 0;
                        if (!(pv > 0)) { continue; }
                        var a0 = pct ? (at / whole) * 100 : at;
                        var a1 = pct ? ((at + pv) / whole) * 100 : at + pv;
                        var seg = PVX.svg.el('rect', {
                            x: vs(a0).toFixed(2), y: y.toFixed(2),
                            width: Math.max(0.5, vs(a1) - vs(a0)).toFixed(2), height: thick.toFixed(2),
                            fill: series[s].color, 'class': 'pvx-ea-shape pvx-ea-seg'
                        }, grp);
                        PVX.svg.el('title', null, seg).textContent = it.label + ' · ' + series[s].label + ': ' +
                            valueText(pv, m, cfg) + (pct ? ' (' + PVX.fmt.percent((pv / whole) * 100, 1) + ')' : '');
                        at += pv;
                    }
                    endX = vs(pct ? (it.partSum > 0 ? 100 : 0) : it.partSum);
                } else {
                    var v = vOf(it);
                    var x0b = Math.min(vs(v), zeroX);
                    var w = Math.max(1, Math.abs(vs(v) - zeroX));
                    if (it.value === null) { w = 0; }
                    if (w > 0) {
                        PVX.svg.el('path', {
                            d: PVX.svg.roundRect(x0b, y, w, thick, radius),
                            fill: colorFor(it, i, m, cfg, t), 'class': 'pvx-ea-shape'
                        }, grp);
                    }
                    endX = Math.max(vs(v), zeroX);
                }
                PVX.svg.el('title', null, grp).textContent = tipFor(it, m, cfg, i);

                // Target: a tick across the bar, so "over" reads without a number.
                if (it.target !== undefined && !pct) {
                    var tx = vs(it.target);
                    PVX.svg.el('line', {
                        x1: tx.toFixed(2), y1: (y - 2).toFixed(2),
                        x2: tx.toFixed(2), y2: (y + thick + 2).toFixed(2),
                        stroke: t.text, 'stroke-width': 2, 'class': 'pvx-ea-target'
                    }, grp);
                }

                if (showValues && labels[i]) {
                    PVX.svg.text(grp, (endX + 4).toFixed(2), center(i).toFixed(2), labels[i], {
                        'class': 'pvx-svg-value pvx-num pvx-ea-value',
                        'text-anchor': 'start', 'font-size': font, fill: t.text
                    });
                }
            }

            // ---- group names ------------------------------------------------
            if (nameW > 2 && slot >= font * 1.05) {
                var namesG = PVX.svg.el('g', { 'class': 'pvx-ea-names' }, svgRoot);
                var nameX = Math.min(plot.x0, zeroX);
                for (i = 0; i < n; i++) {
                    var avail = Math.min(nameW - 4, nameX - 7);
                    var nt = PVX.svg.text(namesG, (nameX - 6).toFixed(2), center(i).toFixed(2),
                        fitText(items[i].label, avail, font), {
                            'class': 'pvx-svg-label pvx-ea-name',
                            'text-anchor': 'end', 'font-size': font,
                            // "(unassigned)" is not a reason code; it is a gap in
                            // the data, and it reads as one.
                            fill: items[i].unassigned ? PVX.color.status.warning : t.text
                        });
                    fitTextTo(nt, avail);
                    PVX.svg.el('title', null, nt).textContent = items[i].label;
                }
            }

            // ---- cumulative line -------------------------------------------
            if (showCum) {
                var pts = [];
                for (i = 0; i < n; i++) { pts.push({ x: cs(m.cum[i]), y: center(i) }); }
                var lineG = PVX.svg.el('g', { 'class': 'pvx-ea-cum' }, svgRoot);
                if (pts.length > 1) {
                    PVX.svg.el('path', {
                        d: PVX.svg.line(pts, false), fill: 'none', stroke: cumColor,
                        'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
                    }, lineG);
                }
                for (i = 0; i < pts.length; i++) {
                    var mk2 = PVX.svg.el('circle', {
                        cx: pts[i].x.toFixed(2), cy: pts[i].y.toFixed(2),
                        r: Math.max(1.6, Math.min(3, thick * 0.18)).toFixed(1),
                        fill: cumColor,
                        stroke: t.surface === 'transparent' ? 'none' : t.surface,
                        'stroke-width': 0.8
                    }, lineG);
                    PVX.svg.el('title', null, mk2).textContent =
                        items[i].label + ' \u00b7 cumulative ' + m.cum[i].toFixed(1) + '%';
                }
                /* Secondary axis above the plot, in the line's own colour so it
                 * is never mistaken for the value axis.
                 *
                 * Candidates are placed in order of importance and any that
                 * would collide with one already placed is dropped. 80% and
                 * 100% are only 20% of the width apart, so on a narrow symbol a
                 * fixed set of ticks prints "80%100%" as one word — which is
                 * worse than three readable ticks. */
                var cumFont = font * 0.9;
                var cumTicks = [0, 100, 80, 50];
                var placed = [];
                // One label is centred and its neighbour is end-anchored, so the
                // clearance needed is one full label plus half of another, not
                // one label width.
                var minGap = textW('100%', cumFont) * 2.2 + 6;
                for (i = 0; i < cumTicks.length; i++) {
                    var px = cs(cumTicks[i]);
                    var clash = false;
                    for (var q = 0; q < placed.length; q++) {
                        if (Math.abs(px - placed[q]) < minGap) { clash = true; break; }
                    }
                    if (clash) { continue; }
                    placed.push(px);
                    PVX.svg.text(svgRoot, px.toFixed(2), (plot.y0 - font * 0.85).toFixed(2),
                        cumTicks[i] + '%', {
                            'class': 'pvx-svg-label pvx-ea-cumtick',
                            'text-anchor': cumTicks[i] === 100 ? 'end' : (cumTicks[i] === 0 ? 'start' : 'middle'),
                            'font-size': cumFont, fill: cumColor
                        });
                }
            }
        }

        /* ================================================================ *
         * donut — contribution
         * ================================================================ */

        function drawDonut(svgRoot, W, H, cfg, t, m, compact, minimal) {
            var i;
            var items = m.items;
            var n = items.length;
            var total = m.total;
            if (!(total > 0)) {
                drawMessage(svgRoot, W, H, t, 'Nothing to divide up', '', t.textMuted);
                return;
            }

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 18), 7.5, 12);
            // A legend only when the box is wide enough to hold one without
            // eating the ring; otherwise the slices carry their own labels.
            // The budget is whatever is left once the ring has its square, so on
            // a wide symbol the legend takes the surplus rather than a fixed
            // fraction — a fraction was ellipsising "Planned maintenance" beside
            // 200px of empty canvas.
            var legendW = (!compact && W > H * 1.5)
                ? PVX.util.clamp(W - H * 1.15, 90, 260) : 0;
            var boxW = W - legendW;
            var cx = boxW / 2;
            var cy = H / 2;
            var r = Math.max(8, Math.min(boxW, H) / 2 - 6);
            var inner = r * 0.58;

            var g = PVX.svg.el('g', { 'class': 'pvx-ea-donut' }, svgRoot);
            var angle = 0;
            for (i = 0; i < n; i++) {
                var frac = vOf(items[i]) / total;
                var sweep = frac * 360;
                if (!(sweep > 0.05)) { continue; }
                var col = colorFor(items[i], i, m, cfg, t);
                var seg = PVX.svg.el('g', { 'class': 'pvx-ea-slice' }, g);
                if (scope.pvx.clickable) {
                    seg.setAttribute('class', 'pvx-ea-slice pvx-hit-group');
                    seg.setAttribute('data-pvx-i', String(hits.length));
                    hits.push(items[i]);
                }
                PVX.svg.el('path', {
                    d: PVX.svg.annulus(cx, cy, inner, r, angle, angle + sweep),
                    fill: col,
                    stroke: t.surface === 'transparent' ? 'none' : t.surface,
                    'stroke-width': 0.8
                }, seg);
                PVX.svg.el('title', null, seg).textContent = tipFor(items[i], m, cfg, i);

                // Only slices with room get a label drawn on them; a 2% slice
                // with a number jammed over it is noise.
                if (!compact && frac > 0.07) {
                    var mid = PVX.svg.polar(cx, cy, (inner + r) / 2, angle + sweep / 2);
                    PVX.svg.text(seg, mid.x.toFixed(2), mid.y.toFixed(2),
                        Math.round(frac * 100) + '%', {
                            'class': 'pvx-svg-value pvx-num pvx-ea-slicelabel',
                            'text-anchor': 'middle', 'font-size': Math.min(font, (r - inner) * 0.8),
                            fill: PVX.color.readable(col)
                        });
                }
                angle += sweep;
            }

            // Centre: the total the ring adds up to, so the percentages have a
            // denominator on screen rather than in someone's head.
            if (inner > font * 1.6) {
                // The hole is a circle, so the usable width at the text's own
                // baseline is a chord, not the diameter — 1.7r rather than 2r.
                var holeW = inner * 1.7;
                var ct = PVX.svg.text(g, cx.toFixed(2), (cy - font * 0.35).toFixed(2),
                    fitText(valueText(total, m, cfg), holeW, font * 1.05), {
                        'class': 'pvx-svg-value pvx-num pvx-ea-center',
                        'text-anchor': 'middle', 'font-size': (font * 1.05).toFixed(1), fill: t.text
                    });
                // Centre-anchored, so an under-estimate spills out of BOTH sides
                // of the ring at once. Two measurements a frame is affordable.
                fitTextTo(ct, holeW);
                if (inner > font * 2.6) {
                    var cs2 = PVX.svg.text(g, cx.toFixed(2), (cy + font * 0.9).toFixed(2),
                        fitText(m.metricLabel, holeW, font * 0.8), {
                            'class': 'pvx-svg-label pvx-ea-centersub',
                            'text-anchor': 'middle', 'font-size': (font * 0.8).toFixed(1), fill: t.textMuted
                        });
                    fitTextTo(cs2, holeW);
                }
            }

            // ---- legend -----------------------------------------------------
            if (legendW > 0) {
                var rowH = Math.min(font * 1.6, H / Math.max(1, n));
                if (rowH >= font * 1.05) {
                    var lg = PVX.svg.el('g', { 'class': 'pvx-ea-legend' }, svgRoot);
                    var top = Math.max(2, (H - n * rowH) / 2);
                    var lx = boxW + 6;
                    for (i = 0; i < n; i++) {
                        var ly = top + i * rowH;
                        PVX.svg.el('rect', {
                            x: lx.toFixed(1), y: (ly + rowH / 2 - font * 0.35).toFixed(1),
                            width: (font * 0.7).toFixed(1), height: (font * 0.7).toFixed(1),
                            rx: 1.5, fill: colorFor(items[i], i, m, cfg, t)
                        }, lg);
                        var txt = items[i].label + '  ' + valueText(items[i].value, m, cfg);
                        var lt = PVX.svg.text(lg, (lx + font).toFixed(1), (ly + rowH / 2).toFixed(1),
                            fitText(txt, legendW - font - 10, font * 0.92), {
                                'class': 'pvx-svg-label pvx-ea-legendtext',
                                'text-anchor': 'start', 'font-size': (font * 0.92).toFixed(1),
                                fill: items[i].unassigned ? PVX.color.status.warning : t.text
                            });
                        PVX.svg.el('title', null, lt).textContent = tipFor(items[i], m, cfg, i);
                    }
                }
            }
        }

        /* ================================================================ *
         * table — the same ranking, as numbers
         * ================================================================ */

        /** Signed gap to target as text: "+1.5 h", "−3". */
        function deltaText(it, m, cfg) {
            if (it.delta === undefined) { return ''; }
            var sign = it.delta > 0 ? '+' : (it.delta < 0 ? '−' : '');
            return sign + valueText(Math.abs(it.delta), m, cfg);
        }

        function deltaColor(it, t) {
            if (it.good === true) { return PVX.color.status.normal; }
            if (it.good === false) { return PVX.color.status.alarm; }
            return t.textMuted;
        }

        /**
         * The table's columns, most important first. Columns are dropped from
         * the end of this list as the box narrows: the group and its total are
         * the answer, the rest is supporting detail. Display order is fixed
         * (`at`), so a dropped column never reshuffles the ones that stay.
         */
        function tableColumns(cfg, m, W, compact) {
            var extra = m.metric !== 'totalDuration' && m.metric !== 'meanDuration' && m.metric !== 'count';
            var cols = [];
            // Total and mean are always TIME, whatever the ranking metric is:
            // the table exists to show the accounting behind the rank, and "3"
            // in a total column would be a count pretending to be an amount of
            // downtime.
            cols.push({ key: 'total', at: 2, head: 'total', w: Math.max(52, W * 0.18), cls: 'pvx-svg-value',
                text: function (it) { return durText(it.merged, cfg); }, strong: true });
            if (extra) {
                cols.push({ key: 'metric', at: 4, head: m.isAttr ? m.metricLabel : 'longest', w: Math.max(60, W * 0.18),
                    cls: 'pvx-svg-value', strong: true,
                    text: function (it) { return valueText(it.value, m, cfg); } });
            }
            if (m.targets) {
                cols.push({ key: 'delta', at: 6, head: 'Δ target', w: Math.max(56, W * 0.14), cls: 'pvx-svg-value',
                    text: function (it) { return deltaText(it, m, cfg); },
                    color: function (it) { return deltaColor(it, { textMuted: '' }); } });
            }
            if (W > 200) {
                cols.push({ key: 'n', at: 1, head: 'n', w: Math.max(30, W * 0.10), cls: 'pvx-svg-label',
                    text: function (it) { return String(it.count); } });
            }
            if (m.targets) {
                cols.push({ key: 'target', at: 5, head: 'target', w: Math.max(52, W * 0.13), cls: 'pvx-svg-label',
                    text: function (it) { return it.target === undefined ? '' : valueText(it.target, m, cfg); } });
            }
            if (!compact && W > 300) {
                cols.push({ key: 'mean', at: 3, head: 'mean', w: Math.max(52, W * 0.16), cls: 'pvx-svg-label',
                    text: function (it) { return durText(it.count ? it.evSum / it.count : 0, cfg); } });
            }
            // Keep columns while the group name still gets a readable share.
            var room = W - 12 - Math.max(70, W * 0.28);
            var kept = [], used = 0;
            for (var i = 0; i < cols.length; i++) {
                if (i > 0 && used + cols[i].w > room) { continue; }
                kept.push(cols[i]);
                used += cols[i].w;
            }
            kept.sort(function (a, b) { return a.at - b.at; });
            return { cols: kept, dropped: cols.length - kept.length };
        }

        function drawTable(svgRoot, W, H, cfg, t, m, compact) {
            var i, c;
            var items = m.items;
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 20), 7.5, 12);
            var pad = 6;
            // The tightest row that is still readable. It decides how many rows
            // FIT; it is not necessarily the row height that gets drawn.
            var minRowH = PVX.util.clamp(font * 1.75, font + 3, 26);
            var totals = cfg.TableTotals === true;

            // How many rows physically fit, header (and totals) included.
            // Truncation here is the box being too short, which is a different
            // limit from TopN and needs its own note.
            var capacity = Math.max(1, Math.floor((H - pad * 2) / minRowH) - 1 - (totals ? 1 : 0));
            var rows = items;
            if (rows.length > capacity) {
                addNote('+' + (rows.length - capacity) + ' rows below the fold');
                rows = rows.slice(0, capacity);
            }
            // Then spread whatever is left over the rows that survived, so a
            // short table does not sit as a dense block above half a screen of
            // nothing. Capped, or three rows on a tall symbol become bands.
            var rowH = PVX.util.clamp((H - pad * 2) / (rows.length + 1 + (totals ? 1 : 0)), minRowH, 30);

            var layout = tableColumns(cfg, m, W, compact);
            var cols = layout.cols;
            if (layout.dropped) { addNote(layout.dropped + (layout.dropped === 1 ? ' column' : ' columns') + ' hidden — widen the symbol'); }
            var x = W - pad;
            for (i = cols.length - 1; i >= 0; i--) { cols[i].x = x; x -= cols[i].w; }
            var nameRight = x - 6;

            var g = PVX.svg.el('g', { 'class': 'pvx-ea-table' }, svgRoot);
            var y = pad + rowH * 0.5;

            var head = function (hx, text, anchor, maxW) {
                var h = PVX.svg.text(g, hx.toFixed(1), y.toFixed(1), fitText(text, maxW, font * 0.9), {
                    'class': 'pvx-svg-label pvx-ea-th', 'text-anchor': anchor,
                    'font-size': (font * 0.9).toFixed(1), fill: t.textMuted
                });
                fitTextTo(h, maxW);
            };
            head(pad, groupByLabel(m.dim), 'start', Math.max(10, nameRight - pad));
            for (c = 0; c < cols.length; c++) { head(cols[c].x, cols[c].head, 'end', cols[c].w - 4); }

            PVX.svg.el('line', {
                x1: pad, y1: (y + rowH * 0.42).toFixed(1),
                x2: (W - pad).toFixed(1), y2: (y + rowH * 0.42).toFixed(1),
                stroke: t.border, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, g);

            var drawRow = function (it, i2, isTotal) {
                y += rowH;
                if (!isTotal && i2 % 2 === 1) {
                    PVX.svg.el('rect', {
                        x: pad - 2, y: (y - rowH * 0.5).toFixed(1),
                        width: (W - pad * 2 + 4).toFixed(1), height: rowH.toFixed(1),
                        fill: t.grid, 'class': 'pvx-ea-rowband'
                    }, g);
                }
                if (isTotal) {
                    PVX.svg.el('line', {
                        x1: pad, y1: (y - rowH * 0.5).toFixed(1),
                        x2: (W - pad).toFixed(1), y2: (y - rowH * 0.5).toFixed(1),
                        stroke: t.border, 'stroke-width': 1, 'class': 'pvx-grid-line'
                    }, g);
                }

                var rowG = PVX.svg.el('g', { 'class': isTotal ? 'pvx-ea-row pvx-ea-total' : 'pvx-ea-row' }, g);
                if (scope.pvx.clickable && !isTotal) {
                    rowG.setAttribute('class', 'pvx-ea-row pvx-hit-group');
                    rowG.setAttribute('data-pvx-i', String(hits.length));
                    hits.push(it);
                }
                // An invisible hit rectangle: SVG text only reacts over its own
                // glyphs, so without this the tooltip is unreachable in the gaps.
                PVX.svg.el('rect', {
                    x: pad - 2, y: (y - rowH * 0.5).toFixed(1),
                    width: (W - pad * 2 + 4).toFixed(1), height: rowH.toFixed(1),
                    fill: 'transparent'
                }, rowG);
                if (!isTotal) { PVX.svg.el('title', null, rowG).textContent = tipFor(it, m, cfg, i2); }

                var nt = PVX.svg.text(rowG, pad.toFixed(1), y.toFixed(1),
                    fitText(it.label, Math.max(10, nameRight - pad), font), {
                        'class': 'pvx-svg-label pvx-ea-td', 'text-anchor': 'start',
                        'font-size': font, 'font-weight': isTotal ? '600' : null,
                        fill: it.unassigned ? PVX.color.status.warning : t.text
                    });
                fitTextTo(nt, Math.max(10, nameRight - pad));

                for (var c2 = 0; c2 < cols.length; c2++) {
                    var col = cols[c2];
                    var fill = col.color ? (col.color(it) || t.textMuted) : (col.strong ? t.text : t.textMuted);
                    var ct = PVX.svg.text(rowG, col.x.toFixed(1), y.toFixed(1), col.text(it), {
                        'class': col.cls + ' pvx-num pvx-ea-td pvx-ea-col-' + col.key, 'text-anchor': 'end',
                        'font-size': font, 'font-weight': isTotal ? '600' : null, fill: fill
                    });
                    fitTextTo(ct, col.w - 4);
                }
            };

            for (i = 0; i < rows.length; i++) { drawRow(rows[i], i, false); }

            if (totals) {
                // The true overall figures, from every event — not a sum of
                // the rows' means or a column of rounded numbers added up.
                var all = m.overallAgg;
                var tot = {
                    label: 'Total', count: m.count, merged: m.mergedSum, evSum: all.evSum,
                    value: m.overall, isTotal: true
                };
                if (m.totalItem) {
                    tot.target = m.totalItem.target; tot.delta = m.totalItem.delta; tot.good = m.totalItem.good;
                }
                drawRow(tot, rows.length, true);
            }
        }

        /* ================================================================ *
         * pivot — groups down, the split across, totals both ways
         * ================================================================ */

        /**
         * Every cell is the metric over that group's events with that split
         * value; every total is the metric over all the events it covers, so
         * a mean's row total is the mean of the row's events and a duration's
         * is its union (an outage under two codes counted once). Totals are
         * therefore NOT always the sum of the cells, and that is the point.
         */
        function drawPivot(svgRoot, W, H, cfg, t, m, compact) {
            var i, s;
            var items = m.items;
            var series = m.series;
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 7, 11.5);
            var pad = 5;
            var rowH = PVX.util.clamp(font * 1.8, font + 3, 26);
            var shade = cfg.PivotShading !== false;

            // Column widths from the widest value the column will hold.
            var cellW = 0;
            var sample = function (v) { cellW = Math.max(cellW, textW(valueText(v, m, cfg), font) + 10); };
            for (i = 0; i < items.length; i++) {
                sample(items[i].value);
                for (s = 0; s < series.length; s++) { sample(items[i].parts[s]); }
            }
            sample(m.overall);
            // A column is as wide as its heading wants, within reason: a
            // reason code cut to "Mech…" is a guessing game.
            // Measured, not estimated: a few headings, set in capitals by the
            // stylesheet, which the glyph estimate knows nothing about.
            var probe = PVX.svg.text(svgRoot, 0, -100, '', { 'class': 'pvx-svg-label pvx-ea-th', 'font-size': (font * 0.9).toFixed(1) });
            for (s = 0; s < series.length; s++) {
                probe.textContent = series[s].label;
                var hw = 0;
                try { hw = probe.getComputedTextLength(); } catch (e) { hw = 0; }
                cellW = Math.max(cellW, Math.min(110, (hw || textW(series[s].label, font * 0.9)) + 12));
            }
            svgRoot.removeChild(probe);
            cellW = PVX.util.clamp(cellW, 40, 110);
            var nameW = PVX.util.clamp(W * 0.26, 50, 200);
            var fitCols = Math.max(1, Math.floor((W - pad * 2 - nameW - cellW) / cellW));
            var cols = series;
            if (cols.length > fitCols) {
                addNote('+' + (cols.length - fitCols) + ' ' + groupNoun(m.split) + ' columns hidden — widen the symbol or lower Split top N');
                cols = cols.slice(0, fitCols);
            }
            var capacity = Math.max(1, Math.floor((H - pad * 2) / rowH) - 2);
            var rows = items;
            if (rows.length > capacity) {
                addNote('+' + (rows.length - capacity) + ' rows below the fold');
                rows = rows.slice(0, capacity);
            }

            // The biggest cell sets the shading; cells only, so one large
            // total does not wash every cell out.
            var maxCell = 0;
            for (i = 0; i < rows.length; i++) {
                for (s = 0; s < cols.length; s++) {
                    var cv = rows[i].parts[s];
                    if (cv !== null && Math.abs(cv) > maxCell) { maxCell = Math.abs(cv); }
                }
            }
            var accent = trim(cfg.BarColor) || '#3b82c4';

            var g = PVX.svg.el('g', { 'class': 'pvx-ea-pivot' }, svgRoot);
            var colX = function (c) { return pad + nameW + cellW * (c + 1); };   // right edge
            var y = pad + rowH * 0.55;

            // Header: the split's values, then the row total.
            var corner = groupByLabel(m.dim) + ' ↓  ' + groupByLabel(m.split) + ' →';
            var ch = PVX.svg.text(g, pad.toFixed(1), y.toFixed(1), fitText(corner, nameW - 4, font * 0.85), {
                'class': 'pvx-svg-label pvx-ea-th', 'font-size': (font * 0.85).toFixed(1), fill: t.textMuted
            });
            fitTextTo(ch, nameW - 4);
            for (s = 0; s <= cols.length; s++) {
                var isTot = s === cols.length;
                var hl = isTot ? 'Total' : cols[s].label;
                var ht = PVX.svg.text(g, (colX(s) - 4).toFixed(1), y.toFixed(1), fitText(hl, cellW - 6, font * 0.9), {
                    'class': 'pvx-svg-label pvx-ea-th pvx-ea-pivot-col', 'text-anchor': 'end',
                    'font-size': (font * 0.9).toFixed(1), 'font-weight': isTot ? '600' : null,
                    fill: !isTot && cols[s].unassigned ? PVX.color.status.warning : t.textMuted
                });
                fitTextTo(ht, cellW - 6);
                PVX.svg.el('title', null, ht).textContent = hl;
            }
            PVX.svg.el('line', {
                x1: pad, y1: (y + rowH * 0.42).toFixed(1), x2: (W - pad).toFixed(1), y2: (y + rowH * 0.42).toFixed(1),
                stroke: t.border, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, g);

            var cell = function (parent, c, yy, v, strong, tip) {
                var x1 = colX(c);
                if (shade && !strong && v !== null && maxCell > 0) {
                    PVX.svg.el('rect', {
                        x: (x1 - cellW + 1).toFixed(1), y: (yy - rowH * 0.5 + 1).toFixed(1),
                        width: (cellW - 2).toFixed(1), height: (rowH - 2).toFixed(1), rx: 2,
                        fill: accent, opacity: (0.08 + 0.42 * Math.abs(v) / maxCell).toFixed(3),
                        'class': 'pvx-ea-pivot-shade'
                    }, parent);
                }
                var tx = PVX.svg.text(parent, (x1 - 4).toFixed(1), yy.toFixed(1), valueText(v, m, cfg), {
                    'class': 'pvx-svg-value pvx-num pvx-ea-pivot-cell', 'text-anchor': 'end',
                    'font-size': font, 'font-weight': strong ? '600' : null,
                    fill: v === null ? t.textMuted : t.text
                });
                fitTextTo(tx, cellW - 6);
                if (tip) { PVX.svg.el('title', null, tx).textContent = tip; }
            };

            for (i = 0; i < rows.length; i++) {
                var it = rows[i];
                y += rowH;
                var rowG = PVX.svg.el('g', { 'class': 'pvx-ea-row' }, g);
                if (scope.pvx.clickable) {
                    rowG.setAttribute('class', 'pvx-ea-row pvx-hit-group');
                    rowG.setAttribute('data-pvx-i', String(hits.length));
                    hits.push(it);
                }
                PVX.svg.el('rect', {
                    x: pad - 2, y: (y - rowH * 0.5).toFixed(1), width: (W - pad * 2 + 4).toFixed(1),
                    height: rowH.toFixed(1), fill: 'transparent'
                }, rowG);
                var nt = PVX.svg.text(rowG, pad.toFixed(1), y.toFixed(1), fitText(it.label, nameW - 6, font), {
                    'class': 'pvx-svg-label pvx-ea-td', 'font-size': font,
                    fill: it.unassigned ? PVX.color.status.warning : t.text
                });
                fitTextTo(nt, nameW - 6);
                PVX.svg.el('title', null, nt).textContent = tipFor(it, m, cfg, i);
                for (s = 0; s < cols.length; s++) {
                    cell(rowG, s, y, it.parts[s], false, it.label + ' · ' + cols[s].label + ': ' + valueText(it.parts[s], m, cfg));
                }
                cell(rowG, cols.length, y, it.value, true, it.label + ' total: ' + valueText(it.value, m, cfg));
            }

            // Column totals and the grand total, from the events themselves.
            y += rowH;
            PVX.svg.el('line', {
                x1: pad, y1: (y - rowH * 0.5).toFixed(1), x2: (W - pad).toFixed(1), y2: (y - rowH * 0.5).toFixed(1),
                stroke: t.border, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, g);
            var totG = PVX.svg.el('g', { 'class': 'pvx-ea-row pvx-ea-total' }, g);
            PVX.svg.text(totG, pad.toFixed(1), y.toFixed(1), 'Total', {
                'class': 'pvx-svg-label pvx-ea-td', 'font-size': font, 'font-weight': '600', fill: t.text
            });
            for (s = 0; s < cols.length; s++) {
                cell(totG, s, y, cols[s].value, true, cols[s].label + ' total: ' + valueText(cols[s].value, m, cfg));
            }
            var grand = m.metric === 'totalDuration' ? m.covered : m.overall;
            cell(totG, cols.length, y, grand, true, 'Everything: ' + valueText(grand, m, cfg) +
                (m.metric === 'totalDuration' ? ' (time covered, overlap counted once)' : ''));
        }

        /* ================================================================ *
         * cards — one figure per group, judged against its target
         * ================================================================ */

        function drawCards(svgRoot, W, H, cfg, t, m, compact) {
            var list = [];
            if (cfg.CardTotal !== false) {
                var tot = m.totalItem || { label: 'Total', value: m.overall, count: m.count, isTotal: true };
                tot.label = drill.length ? drill[drill.length - 1].label : 'Total';
                tot.value = m.overall;
                tot.count = m.count;
                list.push(tot);
            }
            for (var i = 0; i < m.items.length; i++) { list.push(m.items[i]); }

            var gap = 6, pad = 4;
            var minW = compact ? 90 : 128, minH = compact ? 46 : 64;
            var cols = PVX.util.clamp(Math.floor((W - pad * 2 + gap) / (minW + gap)), 1, list.length);
            var rowsFit = Math.max(1, Math.floor((H - pad * 2 + gap) / (minH + gap)));
            var shown = Math.min(list.length, cols * rowsFit);
            if (shown < list.length) {
                addNote('+' + (list.length - shown) + ' cards below the fold');
            }
            var rows = Math.max(1, Math.ceil(shown / cols));
            var cw = (W - pad * 2 - gap * (cols - 1)) / cols;
            var chh = Math.min(120, (H - pad * 2 - gap * (rows - 1)) / rows);
            var big = PVX.util.clamp(Math.min(cw / 6, chh / 2.6), 11, 30);
            var small = PVX.util.clamp(big * 0.45, 8, 11.5);

            var g = PVX.svg.el('g', { 'class': 'pvx-ea-cards' }, svgRoot);
            for (i = 0; i < shown; i++) {
                var it = list[i];
                var cx = pad + (i % cols) * (cw + gap);
                var cy = pad + Math.floor(i / cols) * (chh + gap);
                var card = PVX.svg.el('g', { 'class': it.isTotal ? 'pvx-ea-card pvx-ea-card-total' : 'pvx-ea-card' }, g);
                if (scope.pvx.clickable && !it.isTotal) {
                    card.setAttribute('class', 'pvx-ea-card pvx-hit-group');
                    card.setAttribute('data-pvx-i', String(hits.length));
                    hits.push(it);
                }
                PVX.svg.el('rect', {
                    x: cx.toFixed(1), y: cy.toFixed(1), width: cw.toFixed(1), height: chh.toFixed(1), rx: 4,
                    fill: t.grid, stroke: t.border, 'stroke-width': 1, 'class': 'pvx-ea-card-bg'
                }, card);
                // The accent edge carries the judgement: green, red, or the
                // group's plain colour when there is no target to judge by.
                var edge = it.good === true ? PVX.color.status.normal
                    : (it.good === false ? PVX.color.status.alarm
                        : (it.isTotal ? t.textMuted : colorFor(it, i, m, cfg, t)));
                PVX.svg.el('rect', {
                    x: cx.toFixed(1), y: cy.toFixed(1), width: 4, height: chh.toFixed(1), rx: 2,
                    fill: edge, 'class': 'pvx-ea-card-edge'
                }, card);
                var tx = cx + 11, tw = cw - 16;
                var lt = PVX.svg.text(card, tx.toFixed(1), (cy + small * 1.5).toFixed(1), fitText(it.label, tw, small), {
                    'class': 'pvx-svg-label pvx-ea-card-label', 'font-size': small.toFixed(1),
                    'font-weight': it.isTotal ? '600' : null,
                    fill: it.unassigned ? PVX.color.status.warning : t.textMuted
                });
                fitTextTo(lt, tw);
                var vt = PVX.svg.text(card, tx.toFixed(1), (cy + small * 1.9 + big * 0.95).toFixed(1),
                    valueText(it.value, m, cfg), {
                        'class': 'pvx-svg-value pvx-num pvx-ea-card-value', 'font-size': big.toFixed(1),
                        'font-weight': '600', fill: t.text
                    });
                fitTextTo(vt, tw);
                // Short enough for a card: the signed gap and the target. The
                // edge colour already says which side of it is good.
                var sub = it.delta === undefined ? (it.count + (it.count === 1 ? ' event' : ' events'))
                    : (Math.abs(it.delta) < 1e-9 ? 'on target ' + valueText(it.target, m, cfg)
                        : deltaText(it, m, cfg) + ' vs ' + valueText(it.target, m, cfg));
                if (chh > small * 2.4 + big * 1.4) {
                    var st = PVX.svg.text(card, tx.toFixed(1), (cy + chh - small * 0.8).toFixed(1), fitText(sub, tw, small), {
                        'class': 'pvx-svg-label pvx-ea-card-sub', 'font-size': small.toFixed(1),
                        fill: it.good === undefined ? t.textMuted : deltaColor(it, t)
                    });
                    fitTextTo(st, tw);
                }
                PVX.svg.el('title', null, card).textContent = it.isTotal
                    ? it.label + ': ' + valueText(it.value, m, cfg) + (targetText(it, m, cfg) ? '\n' + targetText(it, m, cfg) : '')
                    : tipFor(it, m, cfg, i);
            }
        }

        /* ---- tooltip: the source of truth behind every truncated label ---- */
        function tipFor(it, m, cfg, i) {
            var lines = [it.label];
            lines.push(it.count + (it.count === 1 ? ' event' : ' events'));
            lines.push('Total (overlap merged): ' + PVX.fmt.duration(it.merged));
            if (it.rawSum > it.merged + 500) {
                lines.push('Raw sum of durations: ' + PVX.fmt.duration(it.rawSum));
            }
            lines.push('Mean: ' + PVX.fmt.duration(it.count ? it.evSum / it.count : 0));
            lines.push('Longest: ' + PVX.fmt.duration(it.max));
            if (m.isAttr) {
                lines.push(m.metricLabel + ': ' + valueText(it.value, m, cfg) +
                    (it.missing ? ' (' + it.missing + ' with no number)' : ''));
            }
            if (it.target !== undefined) {
                lines.push('Target: ' + valueText(it.target, m, cfg) +
                    (it.delta !== undefined ? ' \u2014 ' + targetText(it, m, cfg) +
                        (it.pctOf !== null && it.pctOf !== undefined ? ' (' + PVX.fmt.percent(it.pctOf, 0) + ' of target)' : '') : ''));
            }
            if (it.parts && m.series) {
                for (var p = 0; p < m.series.length; p++) {
                    if (it.parts[p] !== null) { lines.push('  ' + m.series[p].label + ': ' + valueText(it.parts[p], m, cfg)); }
                }
            }
            if (canDrill(it)) { lines.push('Click for ' + groupByLabel(dimsOf(liveCfg).levels[drill.length + 1])); }
            if (it.open) {
                lines.push(it.open + (it.open === 1 ? ' event is' : ' events are') + ' still open');
            }
            if (m.total > 0 && m.additive) {
                lines.push('Share of ' + m.metricLabel.toLowerCase() + ': ' +
                    PVX.fmt.percent((vOf(it) / m.total) * 100, 1));
            }
            if (m.cum && m.cum[i] !== undefined) {
                lines.push('Cumulative: ' + m.cum[i].toFixed(1) + '%');
            }
            if (it.isOther) {
                lines.push('Combined from ' + m.otherCount + ' smaller groups');
            }
            return lines.join('\n');
        }

        /* ================================================================ *
         * messages
         * ================================================================ */

        function drawMessage(svgRoot, W, H, t, headline, detail, tone) {
            var avail = Math.max(24, W - 16);
            var hFont = PVX.util.clamp(Math.min(W / 20, H / 8), 8, 13);
            if (textW(headline, hFont) > avail) {
                hFont = PVX.util.clamp(avail / (String(headline).length * 0.56), 7, hFont);
            }
            var dFont = Math.max(7, hFont * 0.82);

            var lines = detail ? wrapText(detail, avail, dFont, 5) : [];
            var lineH = dFont * 1.28;
            var block = hFont * 1.3 + (lines.length ? lines.length * lineH + 3 : 0);
            var top = Math.max(hFont, (H - block) / 2 + hFont * 0.8);

            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(1), top.toFixed(1),
                fitText(headline, avail, hFont), {
                    'class': 'pvx-svg-label pvx-ea-msg-head', 'text-anchor': 'middle',
                    'font-size': hFont.toFixed(1), 'font-weight': '600', fill: tone || t.textMuted
                });
            // A centred line spills past BOTH edges once it is wider than the
            // frame, and the glyph estimate can be a few pixels out. This runs
            // at most six times, only when there is nothing to chart.
            fitTextTo(head, avail);

            for (var i = 0; i < lines.length; i++) {
                var ln = PVX.svg.text(svgRoot, (W / 2).toFixed(1),
                    (top + hFont * 0.6 + (i + 1) * lineH).toFixed(1), lines[i], {
                        'class': 'pvx-svg-label pvx-ea-msg-body', 'text-anchor': 'middle',
                        'font-size': dFont.toFixed(1), fill: t.textMuted
                    });
                fitTextTo(ln, avail);
            }
        }

        /** Greedy word wrap on the same glyph-width estimate used elsewhere. */
        function wrapText(str, maxPx, fontPx, maxLines) {
            var words = String(str).split(/\s+/);
            var perChar = fontPx * 0.56;
            var max = Math.max(4, Math.floor(maxPx / perChar));
            var lines = [];
            var cur = '';
            for (var i = 0; i < words.length; i++) {
                var next = cur ? cur + ' ' + words[i] : words[i];
                if (next.length <= max) { cur = next; continue; }
                if (cur) { lines.push(cur); }
                cur = words[i].length > max ? words[i].slice(0, max - 1) + '\u2026' : words[i];
                if (lines.length >= maxLines) { break; }
            }
            if (cur && lines.length < maxLines) { lines.push(cur); }
            if (lines.length === maxLines) {
                var lastLine = lines[maxLines - 1];
                if (lastLine.charAt(lastLine.length - 1) !== '\u2026') {
                    lines[maxLines - 1] = lastLine.slice(0, Math.max(1, max - 1)) + '\u2026';
                }
            }
            return lines;
        }

        /**
         * Trim an already-drawn <text> until it measures inside `maxPx`.
         *
         * The 0.56em estimate is fine for numbers, which are start- or
         * centre-anchored and only shift a few pixels when it is wrong. Group
         * names are END-anchored against the left edge of the symbol, so an
         * under-estimate pushes the string's START off-canvas, where the host's
         * overflow:hidden chops the first glyph instead of ellipsising. There is
         * no clamp that fixes that after the fact — the text has to be short
         * enough. The caller passes text already cut by the estimate, so the
         * common case measures once and returns.
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
                var core = cur.charAt(cur.length - 1) === '\u2026' ? cur.slice(0, -1) : cur;
                if (core.length < 2) { node.textContent = ''; return; }
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return; }
                node.textContent = core.slice(0, keep) + '\u2026';
            }
            if (measure() > maxPx) { node.textContent = ''; }
        }

        /* ================================================================ *
         * interaction
         * ================================================================ */

        /** Appends to the footer note, unless the box is too small to have one. */
        function addNote(text) {
            if (chromeOff) { return; }
            scope.pvx.note = (scope.pvx.note ? scope.pvx.note + ' \u00b7 ' : '') + text;
        }

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            if (!host || !host.addEventListener) { return; }
            host.addEventListener('click', onClick, false);
            boundHost = host;
        }

        function unbindHost() {
            if (boundHost && boundHost.removeEventListener) {
                try { boundHost.removeEventListener('click', onClick, false); } catch (e) { /* ignore */ }
            }
            boundHost = null;
        }

        function onClick(ev) {
            if (liveCfg.ClickAction !== 'navigate' && liveCfg.ClickAction !== 'drill') { return; }
            var node = ev.target;
            var guard = 0;
            while (node && node !== boundHost && guard < 12) {
                if (node.getAttribute && node.getAttribute('data-pvx-i') !== null) {
                    activate(parseInt(node.getAttribute('data-pvx-i'), 10));
                    return;
                }
                node = node.parentNode;
                guard += 1;
            }
        }

        /**
         * Navigate to the configured display over the clicked group's own span —
         * first event start to last event end. The reason to click a reason code
         * is to go and look at what the plant was doing while it was happening.
         */
        /** A group a click opens the next level of: a real group (not
         *  "Other", which is many) with a level below it. */
        function canDrill(it) {
            if (liveCfg.ClickAction !== 'drill' || !it || it.isOther || it.isTotal || it.key === null || it.key === undefined) { return false; }
            if (!it.facts || !it.facts.length) { return false; }
            return drill.length + 1 < dimsOf(liveCfg).levels.length;
        }

        function activate(index) {
            if (!(index >= 0) || index >= hits.length) { return; }
            var it = hits[index];
            if (canDrill(it)) {
                drill.push({ key: it.key, label: it.label });
                ctx.render();
                return;
            }
            // At the last level a drill-down opens the target display, when one is set.
            var target = trim(liveCfg.NavigateTarget);
            // A period with no events has no span of its own to open.
            if (!target || !isFinite(it.first) || !isFinite(it.last)) { return; }
            var pad = Math.max(60000, (it.last - it.first) * 0.05);
            PVX.nav.go(PVX.nav.url({
                display: target,
                start: isoOf(it.first - pad),
                end: isoOf(it.last + pad)
            }), false);
        }

        /* ================================================================ *
         * plumbing
         * ================================================================ */

        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', c.config.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
        }

        /* Rendering happens in a rAF and data arrives in a Promise callback —
         * both outside Angular's digest — so the scope.pvx writes need an
         * explicit (guarded) digest. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        /* ---- go ------------------------------------------------------------ */
        lastHashKey = hashKey();
        hashTimer = setInterval(pollHash, 1000);
        hashListener = function () { pollHash(); };
        try { window.addEventListener('hashchange', hashListener, false); } catch (e) { hashListener = null; }
        ensureTimers(liveCfg);
        refresh();

        return ctx;
    };

    // For tools/test-overview.js: the period and target rules, without a page.
    symbolVis.periodStart = periodStart;
    symbolVis.periodNext = periodNext;
    symbolVis.periodKey = periodKey;
    symbolVis.periodLabel = periodLabel;
    symbolVis.periodRange = periodRange;
    symbolVis.sliceAt = sliceAt;
    symbolVis.summarize = summarize;
    symbolVis.parseTargets = parseTargets;
    symbolVis.targetValue = targetValue;

    window.PVX.register(PV, definition);

}(window.PIVisualization));
