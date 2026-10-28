/* ============================================================================
 * pvxHistoryTable: "PVX History Table" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (multiple data sources), DataQueryMode: ModeEvents
 * @mock default
 *
 * A row per time, a column per data source: the shift log, the hourly report,
 * the table an engineer copies into a spreadsheet. PI Vision's own table shows
 * one current value per row; reading history back means a trend and a mouse.
 *
 * Three ways to make the rows:
 *   interpolated  the value of each source at clock-aligned times (on the
 *                 hour, every 15 minutes, at midnight), linear between
 *                 samples or held as a step.
 *   summary       one statistic per clock-aligned interval: time-weighted
 *                 average, minimum, maximum, total, count, range, change.
 *   recorded      every archived value, as stored.
 *
 * WHY ModeEvents. PI Vision's default query hands back plot values, the
 * minimum and maximum of each pixel column; an hourly average of those is
 * biased towards the extremes and a minimum would be the trend's, not the
 * tag's. Recorded values are what PI's own summaries are computed from.
 *
 * Every number here is computed from the recorded values PI Vision sent for
 * the display's time range. A source with no value before the first row
 * leaves that cell blank rather than inventing one, and every value left out
 * of a statistic is counted in the footer.
 *
 * The table is built as one string per render and written once: an ng-repeat
 * over rows x columns would put thousands of watchers into the digest of a
 * display that refreshes every few seconds. Only the footer is Angular-bound.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };
    var PER_MS = { s: 1000, min: 60000, h: 3600000, d: 86400000 };

    var STAT_NAMES = {
        twavg: 'Time-weighted average', avg: 'Mean of samples', min: 'Minimum', max: 'Maximum',
        total: 'Total', count: 'Count', range: 'Range', delta: 'Change',
        start: 'Start', end: 'End'
    };

    /* Which totals row "auto" means for each statistic: a sum only where adding
     * the rows means something. */
    var AUTO_TOTAL = {
        twavg: 'avg', avg: 'avg', min: 'min', max: 'max', total: 'sum',
        count: 'sum', range: 'max', delta: 'sum', start: 'avg', end: 'avg'
    };
    var TOTAL_NAMES = { avg: 'Average', min: 'Minimum', max: 'Maximum', sum: 'Total' };

    var definition = {
        typeName: 'pvxHistoryTable',
        displayName: 'PVX History Table',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // One table already holds every source side by side; a collection
        // would repeat the time column once per element.
        supportsCollections: false,
        configTitle: 'Format History Table',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                // Recorded values, never plot values: see the header.
                DataQueryMode: 'ModeEvents',
                Height: 300,
                Width: 460,
                Title: '',

                // --- rows ---------------------------------------------------
                Mode: 'interpolated',       // interpolated | summary | recorded
                Interval: '1h',             // n s|m|h|d|w|mo, aligned to the clock
                Interpolate: 'linear',      // linear | step
                Statistic: 'twavg',         // summary: see STAT_NAMES
                TotalPer: 'h',              // summary total: rate units are per s|min|h|d
                PartialIntervals: 'show',   // summary: show | hide the cut-off first and last
                TimeLabel: 'start',         // summary: start | end | range
                NewestFirst: true,
                MaxRows: 1000,

                // --- grouping and totals ------------------------------------
                GroupBy: 'none',            // none | day | week | month
                Totals: 'none',             // none | auto | avg | min | max | sum

                // --- cells --------------------------------------------------
                TimeFormat: 'auto',         // auto | datetime | short | time | date | iso
                // Off for a new table: one set of bands rarely fits every
                // column of a table that mixes tags.
                UseThresholds: false,
                ShowDownload: true,
                ShowLabel: true
            });
        }
    };

    /* ====================================================================== *
     * pure arithmetic, exposed on symbolVis for tools/test-charts.js
     * ====================================================================== */

    /** "1h", "15 min", "2d", "1mo" -> {n, unit, ms}, or null. */
    function parseInterval(spec) {
        var m = /^\s*(\d+(?:\.\d+)?)?\s*(mo|months?|min|mins|minutes?|sec|secs|seconds?|hr|hrs|hours?|days?|weeks?|[smhdw])\s*$/i
            .exec(String(spec === null || spec === undefined ? '' : spec));
        if (!m) { return null; }
        var n = m[1] ? parseFloat(m[1]) : 1;
        if (!(n > 0)) { return null; }
        var u = m[2].toLowerCase();
        var unit = /^mo/.test(u) ? 'mo' : /^mi/.test(u) || u === 'm' ? 'm' : /^s/.test(u) ? 's' :
            /^h/.test(u) ? 'h' : /^d/.test(u) ? 'd' : 'w';
        // Months are calendar steps and whole; a fraction of one has no edge.
        if (unit === 'mo') { n = Math.max(1, Math.round(n)); }
        if (unit === 'd' || unit === 'w') { n = Math.max(1, Math.round(n)); }
        var ms = unit === 'mo' ? 31 * 86400000 : n * UNIT_MS[unit];
        // Below a second the table is a dump, not a report.
        if (ms < 1000) { return null; }
        return { n: n, unit: unit, ms: ms };
    }

    /**
     * Clock-aligned times from `from` to `to`, both ends included where they
     * fall on one. Sub-day steps restart at each local midnight so a 7-hour
     * step still reads 00:00, 07:00, 14:00, 21:00 every day; days count from
     * midnight, weeks from Monday, months from the 1st. `limit` stops a
     * one-second step over a month from building millions of rows only to
     * keep a thousand.
     */
    function boundaries(from, to, iv, limit) {
        var out = [];
        if (!iv || !(to >= from)) { return out; }
        var cap = limit || 200000;
        var d0 = new Date(from);
        var t, k;
        if (iv.unit === 'mo') {
            for (k = 0; out.length < cap; k += iv.n) {
                t = new Date(d0.getFullYear(), d0.getMonth() + k, 1).getTime();
                if (t > to) { break; }
                if (t >= from) { out.push(t); }
            }
            return out;
        }
        if (iv.unit === 'd' || iv.unit === 'w') {
            var start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
            if (iv.unit === 'w') { start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); }
            var days = iv.unit === 'w' ? 7 * iv.n : iv.n;
            for (k = 0; out.length < cap; k += days) {
                t = new Date(start.getFullYear(), start.getMonth(), start.getDate() + k).getTime();
                if (t > to) { break; }
                if (t >= from) { out.push(t); }
            }
            return out;
        }
        var day = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
        while (out.length < cap) {
            var dayStart = day.getTime();
            if (dayStart > to) { break; }
            var next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime();
            for (k = 0; out.length < cap; k++) {
                t = dayStart + k * iv.ms;
                if (t >= next || t > to) { break; }
                if (t >= from) { out.push(t); }
            }
            day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        }
        return out;
    }

    /** Index of the last point at or before t, or -1. Points are time-sorted. */
    function lastAtOrBefore(pts, t) {
        var lo = 0, hi = pts.length - 1, at = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (pts[mid].t <= t) { at = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        return at;
    }

    /**
     * The value of a source at time t, as PI would interpolate it: the sample
     * itself at its own time, a straight line to the next sample, or a step.
     * Before the first sample there is no value. After the last one the
     * value holds, because the last archived value is the current one.
     * A sample that is not a number (a digital state, "I/O Timeout") holds
     * as text until the next sample, as PI shows it.
     * Returns {v, text, good} or null.
     */
    function valueAt(pts, t, step) {
        var i = lastAtOrBefore(pts, t);
        if (i < 0) { return null; }
        var a = pts[i];
        if (a.v === null || a.t === t || step || i + 1 >= pts.length) {
            return { v: a.v, text: a.v === null ? a.state : null, good: a.good };
        }
        var b = pts[i + 1];
        if (b.v === null || b.t === a.t) { return { v: a.v, text: null, good: a.good }; }
        return { v: a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t), text: null, good: a.good && b.good };
    }

    /**
     * One statistic of one source over [s, e).
     *
     * Time-weighted, as PI's own summaries are by default: the line runs from
     * the interpolated value at s through every numeric sample to the value
     * at e, so an interval with no sample inside it still has an average, a
     * minimum and a maximum. The part of the interval before the source's
     * first numeric sample is not covered and counts for nothing. Samples
     * that are not numbers are left out and counted (`skipped`); the line
     * bridges them, as PI does when a summary meets a system state.
     *
     * Returns {v, covered, samples, skipped, bad}.
     */
    function summarize(pts, s, e, stat, opts) {
        opts = opts || {};
        var step = !!opts.step;
        var num = [];
        var skipped = 0, bad = 0, samples = 0;
        for (var i = 0; i < pts.length; i++) {
            var p = pts[i];
            if (p.v === null) {
                if (p.t >= s && p.t < e) { skipped += 1; }
                continue;
            }
            num.push(p);
            if (p.t >= s && p.t < e) { samples += 1; if (!p.good) { bad += 1; } }
        }
        var out = { v: null, covered: 0, samples: samples, skipped: skipped, bad: bad };
        if (stat === 'count') { out.v = samples; out.covered = e - s; return out; }
        if (!num.length || num[0].t >= e) { return out; }

        var cs = Math.max(s, num[0].t);
        var vS = valueAt(num, cs, step);
        var vE = valueAt(num, e, step);
        var knots = [{ t: cs, v: vS.v }];
        for (var j = 0; j < num.length; j++) {
            if (num[j].t > cs && num[j].t < e) { knots.push({ t: num[j].t, v: num[j].v }); }
        }
        knots.push({ t: e, v: vE.v });

        var area = 0, mn = Infinity, mx = -Infinity;
        for (var k = 0; k < knots.length; k++) {
            if (knots[k].v < mn) { mn = knots[k].v; }
            if (knots[k].v > mx) { mx = knots[k].v; }
            if (k === 0) { continue; }
            var dt = knots[k].t - knots[k - 1].t;
            // A step holds the earlier value across the gap; a line averages.
            area += (step ? knots[k - 1].v : (knots[k - 1].v + knots[k].v) / 2) * dt;
        }
        // In a step the value at e belongs to the next interval: it is the
        // sample that ends this one, not a value this interval ever had.
        if (step && knots.length > 1 && knots[knots.length - 1].t === e) {
            mn = Infinity; mx = -Infinity;
            for (k = 0; k < knots.length - 1; k++) {
                if (knots[k].v < mn) { mn = knots[k].v; }
                if (knots[k].v > mx) { mx = knots[k].v; }
            }
        }
        var span = e - cs;
        out.covered = span;
        var per = PER_MS[opts.per] || PER_MS.h;
        switch (stat) {
            case 'twavg': out.v = span > 0 ? area / span : vS.v; break;
            case 'avg':
                var sum = 0, n = 0;
                for (k = 0; k < num.length; k++) {
                    if (num[k].t >= s && num[k].t < e) { sum += num[k].v; n += 1; }
                }
                out.v = n ? sum / n : null;
                break;
            case 'min': out.v = mn; break;
            case 'max': out.v = mx; break;
            case 'range': out.v = mx - mn; break;
            case 'total': out.v = area / per; break;
            // From the start of the interval, or the first sample if it came
            // later: a change since before the tag existed is unknown.
            case 'delta': out.v = vE.v - vS.v; break;
            case 'start': out.v = cs === s ? vS.v : null; break;
            case 'end': out.v = vE.v; break;
            default: out.v = null;
        }
        return out;
    }

    /** Totals row over one column's numbers. */
    function aggregate(values, kind) {
        var n = 0, sum = 0, mn = Infinity, mx = -Infinity;
        for (var i = 0; i < values.length; i++) {
            var v = values[i];
            if (typeof v !== 'number' || !isFinite(v)) { continue; }
            n += 1; sum += v;
            if (v < mn) { mn = v; }
            if (v > mx) { mx = v; }
        }
        if (!n) { return null; }
        return kind === 'sum' ? sum : kind === 'min' ? mn : kind === 'max' ? mx : sum / n;
    }

    symbolVis.parseInterval = parseInterval;
    symbolVis.boundaries = boundaries;
    symbolVis.valueAt = valueAt;
    symbolVis.summarize = summarize;
    symbolVis.aggregate = aggregate;

    /* ====================================================================== *
     * the symbol
     * ====================================================================== */

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            note: '',
            canDownload: false,
            saveNote: '',
            download: function () { save(); }
        };

        var series = [];
        var window0 = { from: null, to: null };
        var lastModel = null;
        var lastHtml = '';

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-htable-body',
            // The save button's CSV is the table as shown, as the CSV button's is.
            csv: function (c) {
                return lastModel && !lastModel.empty ? csvRows(lastModel, c.config || {}) : null;
            },
            onData: function (d) {
                // stateSeries, not series: series() drops every value that is
                // not a number, and a history table must show "I/O Timeout"
                // where the archive has it.
                series = PVX.data.stateSeries(d) || [];
                window0 = windowOf(d);
            },
            render: render
        });

        /**
         * The display's time range. PI Vision puts StartTime and EndTime on
         * each data item when it has them; the address carries what an
         * operator typed; failing both, the first and last sample are the
         * only evidence there is.
         */
        function windowOf(d) {
            var items = (d && (d.Data || d.data)) || [];
            var from = null, to = null, i;
            for (i = 0; i < items.length; i++) {
                var a = PVX.fmt.toDate(items[i] && items[i].StartTime);
                var b = PVX.fmt.toDate(items[i] && items[i].EndTime);
                if (a && (from === null || a.getTime() < from)) { from = a.getTime(); }
                if (b && (to === null || b.getTime() > to)) { to = b.getTime(); }
            }
            if (from === null || to === null) {
                var p = (PVX.nav.parseHash().params) || {};
                var now = Date.now();
                if (from === null && p.starttime) { from = PVX.nav.parseTime(p.starttime, now); }
                if (to === null && p.endtime) { to = PVX.nav.parseTime(p.endtime, now); }
            }
            return { from: from, to: to };
        }

        function sampleSpan() {
            var from = null, to = null;
            for (var i = 0; i < series.length; i++) {
                var pts = series[i].points || [];
                if (!pts.length) { continue; }
                if (from === null || pts[0].t < from) { from = pts[0].t; }
                if (to === null || pts[pts.length - 1].t > to) { to = pts[pts.length - 1].t; }
            }
            return { from: from, to: to };
        }

        /* ------------------------------------------------------------------ *
         * model
         * ------------------------------------------------------------------ */

        function buildModel(cfg) {
            var m = {
                cols: [], rows: [], notes: [], empty: true,
                mode: cfg.Mode === 'summary' || cfg.Mode === 'recorded' ? cfg.Mode : 'interpolated',
                stat: STAT_NAMES[cfg.Statistic] ? cfg.Statistic : 'twavg',
                iv: null, from: null, to: null
            };
            var i, j;
            for (i = 0; i < series.length; i++) {
                var s = series[i];
                var numeric = 0;
                for (j = 0; j < s.points.length; j++) { if (s.points[j].v !== null) { numeric += 1; } }
                m.cols.push({
                    label: s.label || ('Series ' + (i + 1)),
                    units: s.units || '',
                    good: s.good !== false,
                    error: s.errorDescription || '',
                    points: s.points || [],
                    numeric: numeric,
                    // A source with no numbers at all is a digital tag: it
                    // steps whatever the setting says, and a line between
                    // "Running" and "Stopped" means nothing.
                    step: cfg.Interpolate === 'step' || (s.points.length > 0 && numeric === 0)
                });
            }
            if (!m.cols.length) { return m; }

            var span = sampleSpan();
            var from = PVX.util.isNum(window0.from) ? window0.from : span.from;
            var to = PVX.util.isNum(window0.to) ? window0.to : span.to;
            if (from === null || to === null) { return m; }
            if (!(to > from)) { to = from + 1; }
            m.from = from;
            m.to = to;

            var maxRows = Math.round(PVX.util.clamp(PVX.util.num(cfg.MaxRows) || 1000, 1, 20000));
            if (m.mode === 'recorded') { recordedRows(m, maxRows); } else { intervalRows(m, cfg, maxRows); }
            m.empty = !m.rows.length;
            return m;
        }

        function recordedRows(m, maxRows) {
            var times = {}, list = [], i, j;
            for (i = 0; i < m.cols.length; i++) {
                var pts = m.cols[i].points;
                for (j = 0; j < pts.length; j++) {
                    if (pts[j].t < m.from || pts[j].t > m.to) { continue; }
                    if (!times[pts[j].t]) { times[pts[j].t] = true; list.push(pts[j].t); }
                }
            }
            list.sort(function (a, b) { return a - b; });
            var total = list.length;
            // The newest rows are the ones an operator came for.
            if (list.length > maxRows) { list = list.slice(list.length - maxRows); }
            var idx = m.cols.map(function () { return 0; });
            for (i = 0; i < list.length; i++) {
                var t = list[i];
                var cells = [];
                for (j = 0; j < m.cols.length; j++) {
                    var p2 = m.cols[j].points;
                    while (idx[j] < p2.length && p2[idx[j]].t < t) { idx[j] += 1; }
                    var hit = idx[j] < p2.length && p2[idx[j]].t === t ? p2[idx[j]] : null;
                    cells.push(hit ? { v: hit.v, text: hit.v === null ? hit.state : null, good: hit.good } : { v: null, text: null, blank: true });
                }
                m.rows.push({ t: t, cells: cells });
            }
            if (total > list.length) {
                m.notes.push('Showing the newest ' + list.length + ' of ' + total + ' times (Most rows)');
            }
        }

        function intervalRows(m, cfg, maxRows) {
            var iv = parseInterval(cfg.Interval);
            if (!iv) {
                m.notes.push('Interval "' + cfg.Interval + '" not understood: using 1h');
                iv = parseInterval('1h');
            }
            m.iv = iv;
            var b = boundaries(m.from, m.to, iv, 200001);
            var capped = b.length > 200000;
            var rows = [], i, j;

            if (m.mode === 'interpolated') {
                for (i = 0; i < b.length; i++) {
                    var cells = [];
                    for (j = 0; j < m.cols.length; j++) {
                        var va = valueAt(m.cols[j].points, b[i], m.cols[j].step);
                        cells.push(va || { v: null, text: null, blank: true });
                    }
                    rows.push({ t: b[i], cells: cells });
                }
            } else {
                // Edges: the window's own ends cut the first and last interval.
                var edges = b.slice();
                if (!edges.length || edges[0] > m.from) { edges.unshift(m.from); }
                if (edges[edges.length - 1] < m.to) { edges.push(m.to); }
                var hidden = 0, skipped = 0, bad = 0, uncovered = 0;
                for (i = 0; i + 1 < edges.length; i++) {
                    var s = edges[i], e = edges[i + 1];
                    var partial = !isAligned(b, s) || !isAligned(b, e);
                    if (partial && cfg.PartialIntervals === 'hide') { hidden += 1; continue; }
                    var cl = [];
                    for (j = 0; j < m.cols.length; j++) {
                        var col = m.cols[j];
                        if (!col.numeric) { cl.push({ v: null, text: null, blank: true }); continue; }
                        var r = summarize(col.points, s, e, m.stat, { step: col.step, per: cfg.TotalPer });
                        skipped += r.skipped;
                        bad += r.bad;
                        if (r.v === null && m.stat !== 'count') { uncovered += 1; }
                        cl.push({ v: r.v, text: null, good: r.bad === 0, blank: r.v === null,
                                  title: r.samples + ' sample' + (r.samples === 1 ? '' : 's') +
                                         (r.bad ? ', ' + r.bad + ' of bad quality' : '') });
                    }
                    rows.push({ t: s, end: e, partial: partial, cells: cl });
                }
                if (hidden) { m.notes.push(hidden + ' partial interval' + (hidden === 1 ? '' : 's') + ' at the window edge not shown'); }
                if (skipped) { m.notes.push(skipped + ' value' + (skipped === 1 ? '' : 's') + ' not a number, left out of the ' + STAT_NAMES[m.stat].toLowerCase()); }
                if (bad) { m.notes.push(bad + ' sample' + (bad === 1 ? '' : 's') + ' of bad quality included (marked)'); }
                if (uncovered) { m.notes.push(uncovered + ' cell' + (uncovered === 1 ? '' : 's') + ' blank: no value yet'); }
                if (m.cols.some(function (c) { return c.points.length && !c.numeric; })) {
                    m.notes.push('Sources with no numbers have no ' + STAT_NAMES[m.stat].toLowerCase());
                }
            }
            var total = rows.length;
            if (rows.length > maxRows) { rows = rows.slice(rows.length - maxRows); }
            m.rows = rows;
            if (capped || total > rows.length) {
                m.notes.push('Showing the newest ' + rows.length + ' of ' + (capped ? 'over 200000' : total) +
                    ' rows: lengthen Interval or raise Most rows');
            }
        }

        function isAligned(b, t) {
            var lo = 0, hi = b.length - 1;
            while (lo <= hi) {
                var mid = (lo + hi) >> 1;
                if (b[mid] === t) { return true; }
                if (b[mid] < t) { lo = mid + 1; } else { hi = mid - 1; }
            }
            return false;
        }

        /* ------------------------------------------------------------------ *
         * grouping, totals, order
         * ------------------------------------------------------------------ */

        function groupKey(t, by) {
            var d = new Date(t);
            if (by === 'month') { return d.getFullYear() * 12 + d.getMonth(); }
            if (by === 'week') {
                var w = new Date(d.getFullYear(), d.getMonth(), d.getDate());
                w.setDate(w.getDate() - ((w.getDay() + 6) % 7));
                return w.getTime();
            }
            return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        }

        var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
            'August', 'September', 'October', 'November', 'December'];
        var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

        function groupLabel(t, by) {
            var d = new Date(t);
            if (by === 'month') { return MONTHS[d.getMonth()] + ' ' + d.getFullYear(); }
            if (by === 'week') {
                var w = new Date(groupKey(t, 'week'));
                return 'Week of ' + PVX.fmt.time(w, 'date');
            }
            return DAYS[d.getDay()] + ' ' + PVX.fmt.time(d, 'date');
        }

        function totalKind(cfg, m) {
            var k = cfg.Totals;
            if (k === 'auto') { return m.mode === 'summary' ? AUTO_TOTAL[m.stat] : 'avg'; }
            return TOTAL_NAMES[k] ? k : null;
        }

        /** Rows in display order with group headers and totals between them. */
        function layoutRows(m, cfg) {
            var by = cfg.GroupBy === 'day' || cfg.GroupBy === 'week' || cfg.GroupBy === 'month' ? cfg.GroupBy : null;
            var kind = totalKind(cfg, m);
            var newest = cfg.NewestFirst !== false;
            var groups = [], cur = null, i;
            for (i = 0; i < m.rows.length; i++) {
                var key = by ? groupKey(m.rows[i].t, by) : 0;
                if (!cur || cur.key !== key) { cur = { key: key, t: m.rows[i].t, rows: [] }; groups.push(cur); }
                cur.rows.push(m.rows[i]);
            }
            if (newest) {
                groups.reverse();
                for (i = 0; i < groups.length; i++) { groups[i].rows.reverse(); }
            }
            var out = [];
            for (i = 0; i < groups.length; i++) {
                var g = groups[i];
                if (by) { out.push({ kind: 'group', label: groupLabel(g.t, by) }); }
                for (var j = 0; j < g.rows.length; j++) { out.push({ kind: 'row', row: g.rows[j] }); }
                if (by && kind && groups.length > 1) { out.push(totalRow(m, g.rows, kind, TOTAL_NAMES[kind])); }
            }
            if (kind && m.rows.length) {
                out.push(totalRow(m, m.rows, kind, (by && groups.length > 1 ? 'All: ' : '') + TOTAL_NAMES[kind], true));
            }
            return out;
        }

        function totalRow(m, rows, kind, label, grand) {
            var cells = [];
            for (var j = 0; j < m.cols.length; j++) {
                var vals = [];
                for (var i = 0; i < rows.length; i++) { vals.push(rows[i].cells[j].v); }
                cells.push({ v: aggregate(vals, kind) });
            }
            return { kind: 'total', label: label, cells: cells, grand: !!grand };
        }

        /* ------------------------------------------------------------------ *
         * text
         * ------------------------------------------------------------------ */

        function timeStyle(cfg, m) {
            var f = cfg.TimeFormat;
            if (f && f !== 'auto') { return f; }
            if (m.iv && (m.iv.unit === 'd' || m.iv.unit === 'w' || m.iv.unit === 'mo') && m.mode !== 'recorded') { return 'date'; }
            if (cfg.GroupBy === 'day') { return 'time'; }
            return 'datetime';
        }

        function timeText(row, cfg, m, style) {
            if (m.mode === 'interpolated' || (m.mode === 'summary' && (cfg.TimeLabel === 'start' || !cfg.TimeLabel))) {
                return wholeMinutes(m) ? PVX.fmt.time(row.t, style).replace(/(\d\d:\d\d):00$/, '$1') : PVX.fmt.time(row.t, style);
            }
            if (m.mode !== 'summary') { return PVX.fmt.time(row.t, style); }
            if (cfg.TimeLabel === 'end') { return PVX.fmt.time(row.end, style); }
            var endStyle = style === 'datetime' && sameDay(row.t, row.end) ? 'time' : style;
            var endText = PVX.fmt.time(row.end, endStyle);
            if (endStyle === 'time') { endText = endText.replace(/:00$/, ''); }
            var startText = PVX.fmt.time(row.t, style);
            if (style === 'datetime' || style === 'time') { startText = startText.replace(/:00$/, ''); }
            return startText + ' – ' + endText;
        }

        /* Seconds on an hourly row are noise: every one reads :00. */
        function wholeMinutes(m) {
            return !!(m.iv && m.iv.ms % 60000 === 0);
        }

        function sameDay(a, b) {
            var x = new Date(a), y = new Date(b - 1);
            return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
        }

        /**
         * One precision per column, from the median magnitude of its values,
         * so a column reads as a column: auto decimals per cell would print
         * 99.85 above 100.2 above 101.
         */
        function columnDecimals(m, j, cfg) {
            if (cfg.Decimals !== 'auto' && cfg.Decimals !== undefined && cfg.Decimals !== '') { return cfg.Decimals; }
            if (m.mode === 'summary' && m.stat === 'count') { return 0; }
            var mags = [];
            for (var i = 0; i < m.rows.length; i++) {
                var v = m.rows[i].cells[j].v;
                if (typeof v === 'number' && isFinite(v)) { mags.push(Math.abs(v)); }
            }
            if (!mags.length) { return 'auto'; }
            mags.sort(function (a, b) { return a - b; });
            var med = mags[mags.length >> 1];
            return PVX.fmt.autoDecimals(med === 0 ? (mags[mags.length - 1] || 0) : med);
        }

        function cellText(c, dec, cfg) {
            if (!c || c.blank) { return ''; }
            if (c.v === null) { return c.text === null || c.text === undefined ? '' : String(c.text); }
            return PVX.fmt.number(c.v, { decimals: dec, compact: !!cfg.CompactNumbers });
        }

        function headerText(col, cfg) {
            return col.label;
        }

        function unitsText(col, cfg, m) {
            if (cfg.ShowUnits === false) { return ''; }
            if (m.mode === 'summary' && m.stat === 'count') { return 'samples'; }
            if (m.mode === 'summary' && m.stat === 'total' && col.units) { return totalUnits(col.units, cfg.TotalPer); }
            return col.units;
        }

        /** "t/h" totalled per hour is "t"; anything else is shown as units·h. */
        function totalUnits(units, per) {
            var p = per && PER_MS[per] ? per : 'h';
            var re = new RegExp('^(.*?)\\s*/\\s*' + p + '$', 'i');
            var hit = re.exec(units);
            if (hit && hit[1]) { return hit[1]; }
            return units + '·' + p;
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

            var m = buildModel(cfg);
            lastModel = m;
            var esc = PVX.util.escapeHtml;
            var html;

            if (!m.cols.length) {
                html = '<div class="pvx-htable-empty">Add data sources to list their history</div>';
            } else if (m.empty) {
                html = '<div class="pvx-htable-empty">No values in the time range</div>';
            } else {
                html = tableHtml(m, cfg, t, esc);
            }

            var bads = m.cols.filter(function (col) { return !col.good; });
            if (bads.length) {
                m.notes.unshift(bads.length + ' source' + (bads.length === 1 ? '' : 's') + ' of bad quality: ' +
                    bads.map(function (col) { return col.label + (col.error ? ' (' + col.error + ')' : ''); }).join(', '));
            }
            if (m.mode === 'summary' && !m.empty) {
                m.notes.unshift(STAT_NAMES[m.stat] + ' per ' + intervalName(m.iv) +
                    (m.rows.some(function (r) { return r.partial; }) ? ', * partial interval' : ''));
            } else if (m.mode === 'interpolated' && !m.empty) {
                m.notes.unshift('Value every ' + intervalName(m.iv) +
                    (m.cols.some(function (col) { return col.step && cfg.Interpolate !== 'step'; }) ? ', digital sources held' : ''));
            }

            if (html !== lastHtml) {
                // Keep the reader's place: rewriting the table resets nothing
                // the scroll container owns, but say so in code, because a
                // naive "clear then build" on the container does.
                var tableHost = host.querySelector('.pvx-htable-scroll');
                if (!tableHost) {
                    tableHost = document.createElement('div');
                    tableHost.className = 'pvx-htable-scroll';
                    host.appendChild(tableHost);
                }
                tableHost.innerHTML = html;
                lastHtml = html;
            }

            scope.pvx.note = m.notes.join(' · ');
            scope.pvx.canDownload = cfg.ShowDownload !== false && !m.empty;
            digest();
        }

        function intervalName(iv) {
            if (!iv) { return ''; }
            var names = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month' };
            var n = iv.n;
            return n === 1 ? names[iv.unit] : n + ' ' + names[iv.unit] + 's';
        }

        function tableHtml(m, cfg, t, esc) {
            var style = timeStyle(cfg, m);
            var dec = m.cols.map(function (col, j) { return columnDecimals(m, j, cfg); });
            var bands = cfg.UseThresholds ? cfg.Thresholds : null;
            var parts = ['<table class="pvx-htable-table"><thead><tr>',
                '<th class="pvx-htable-timehead">', esc(m.mode === 'summary' ? 'Interval' : 'Time'), '</th>'];
            var j;
            for (j = 0; j < m.cols.length; j++) {
                var col = m.cols[j];
                var u = unitsText(col, cfg, m);
                parts.push('<th title="', esc(col.label + (col.error ? ': ' + col.error : '')), '"',
                    col.good ? '' : ' class="pvx-htable-badhead"', '><span class="pvx-htable-name">',
                    esc(headerText(col, cfg)), '</span>',
                    u ? '<span class="pvx-htable-units">' + esc(u) + '</span>' : '', '</th>');
            }
            parts.push('</tr></thead><tbody>');

            var list = layoutRows(m, cfg);
            var span = m.cols.length + 1;
            for (var i = 0; i < list.length; i++) {
                var it = list[i];
                if (it.kind === 'group') {
                    parts.push('<tr class="pvx-htable-group"><td colspan="', span, '">', esc(it.label), '</td></tr>');
                    continue;
                }
                var isTotal = it.kind === 'total';
                var row = isTotal ? it : it.row;
                parts.push('<tr', isTotal ? ' class="pvx-htable-total' + (it.grand ? ' pvx-htable-grand' : '') + '"' : '', '>');
                parts.push('<td class="pvx-htable-time">', esc(isTotal ? it.label : timeText(row, cfg, m, style) + (row.partial ? ' *' : '')), '</td>');
                for (j = 0; j < m.cols.length; j++) {
                    var cell = row.cells[j];
                    var txt = cellText(cell, dec[j], cfg);
                    var cls = [];
                    var st = '';
                    if (cell.v === null && cell.text) { cls.push('pvx-htable-text'); }
                    if (cell.good === false) { cls.push('pvx-htable-bad'); }
                    if (bands && typeof cell.v === 'number' && !isTotal) {
                        var band = PVX.thresholds.evaluate(bands, cell.v);
                        if (band) { st = ' style="background:' + PVX.color.rgba(band.color, 0.22) + ';box-shadow:inset 3px 0 0 ' + band.color + '"'; }
                    }
                    var title = cell.good === false ? 'Questionable or bad quality' : (cell.title || '');
                    parts.push('<td', cls.length ? ' class="' + cls.join(' ') + '"' : '', st,
                        title ? ' title="' + esc(title) + '"' : '', '>', esc(txt), '</td>');
                }
                parts.push('</tr>');
            }
            parts.push('</tbody></table>');
            return parts.join('');
        }

        /* ------------------------------------------------------------------ *
         * CSV
         * ------------------------------------------------------------------ *
         * The file holds what the table shows, in its order, with full
         * precision: a spreadsheet can round, but it cannot recover digits.
         * Times are ISO 8601 in UTC so Excel and every script read them the
         * same way whatever the viewer's locale.
         */
        function csvRows(m, cfg) {
            var head = [m.mode === 'summary' ? 'Interval start' : 'Time'];
            if (m.mode === 'summary') { head.push('Interval end'); }
            var j;
            for (j = 0; j < m.cols.length; j++) {
                var u = unitsText(m.cols[j], cfg, m);
                head.push(m.cols[j].label + (u ? ' (' + u + ')' : ''));
            }
            var rows = [head];
            var list = layoutRows(m, cfg);
            for (var i = 0; i < list.length; i++) {
                var it = list[i];
                if (it.kind === 'group') { continue; }
                var isTotal = it.kind === 'total';
                var row = isTotal ? it : it.row;
                var r = [isTotal ? it.label : new Date(row.t).toISOString()];
                if (m.mode === 'summary') { r.push(isTotal ? '' : new Date(row.end).toISOString()); }
                for (j = 0; j < m.cols.length; j++) {
                    var cell = row.cells[j];
                    r.push(cell.blank ? '' : (cell.v === null ? (cell.text || '') : cell.v));
                }
                rows.push(r);
            }
            return rows;
        }

        function save() {
            var cfg = (ctx && ctx.config) || scope.config || {};
            if (!lastModel || lastModel.empty) { return; }
            var name = (cfg.Title || 'History') + ' ' + PVX.fmt.time(Date.now(), 'iso').slice(0, 16).replace(/[:T]/g, '-');
            var ok = PVX.download.csv(name, csvRows(lastModel, cfg));
            scope.pvx.saveNote = ok ? '' : 'This browser cannot save files from a page';
        }

        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            var cfg = c.config || {};
            n.style.setProperty('--pvx-surface', cfg.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-surface-alt', cfg.Transparent ? 'transparent' : (t.surfaceAlt || t.surface));
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
        }

        /* Rendering runs in a rAF, outside Angular's digest, so the footer
         * binding needs an explicit (guarded) one. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
