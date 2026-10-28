/* ============================================================================
 * pvxPeriodOverlay — "PVX Period Comparison" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources: the first is folded in full,
 * any others draw their current period on the same axis)
 *
 * Folds the display's time range into N equal periods and lays them on ONE
 * relative-time axis: today over yesterday over the day before. The older
 * periods collapse into a min/max envelope, which turns the picture into the
 * "golden batch" comparison — is today running inside the shape the last week
 * ran in, and where exactly did it leave?
 *
 * THE DESIGN CONSTRAINT
 * ---------------------
 * A PI Vision custom symbol only ever receives the display's own time window.
 * It cannot issue its own query for "the same shift last week" — that needs the
 * PI Web API, a server URL, and credentials, none of which a symbol has. So
 * this symbol FOLDS one long window rather than FETCHING several short ones.
 * Practically: set the display range to 7 days, choose a 1-day period, and you
 * get seven daily traces. That constraint is stated plainly in the config pane,
 * because a user who does not know it will keep looking for the "compare to
 * last week" box that cannot exist.
 *
 * Two alignments, and they answer different questions:
 *   'clock'     — periods start on real boundaries (midnight, shift start), so
 *                 08:00 on one trace is 08:00 on every other. This is the right
 *                 axis for "Tuesday against Wednesday".
 *   'windowEnd' — periods count back from the end of the window, so the newest
 *                 trace always ends at "now". This is the right axis for "the
 *                 last 8 hours against the 8 before that".
 * The axis is LABELLED DIFFERENTLY in each case (clock time vs elapsed time)
 * because they are genuinely different axes, and one label set would be a lie
 * for the other.
 *
 * CHANGE FROM A BASELINE
 *   'delta' and 'pctdelta' draw every period as its difference from a
 *   baseline at the same point in the period: the median of the older
 *   periods, or the period before. "Are we above a normal Tuesday, and by
 *   how much" is then read off a zero line instead of estimated between two
 *   traces. The envelope becomes the spread of the older periods around that
 *   baseline. A slot whose baseline is zero has no percent change and is left
 *   out, and the footer counts it.
 *
 * CALENDAR MONTHS
 *   Months are not a fixed length, so 'month' folds on calendar boundaries:
 *   each period starts on the 1st and the axis is the day of the month, 31
 *   days long, with shorter months simply ending early. Months are always
 *   clock aligned; a month counted back from "now" is not a month.
 *
 * SEVERAL TAGS
 *   The first source is folded in full: its periods, envelope and statistics.
 *   Each further source draws its CURRENT period on the same axis in its own
 *   colour, so a pump's flow and its sister pump's flow can be read against
 *   one history. Tags in different units belong on % change, where each is
 *   measured from its own baseline. (Until this was added the symbol took one
 *   source; a display saved then has one and draws exactly as before.)
 *
 * Everything inside `.pvx-po-body` is one imperative SVG. Only the header
 * title, the period caption, the footer note and the quality badge are Angular
 * bindings.
 *
 * @mock numeric
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Mean advance width of the UI font in ems. Used for every text-fitting
     * decision instead of getComputedTextLength(), which flushes layout on
     * every call and turns a re-render into a layout-thrash stall. */
    var CHAR_W = 0.58;

    var HOUR = 3600000;
    var DAY = 86400000;
    var WEEK = 7 * DAY;

    var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    /* Candidate axis steps, coarsest last. The relative axis is a DURATION, so
     * the steps that read well are the ones a clock uses — 15 min, 6 h, a day —
     * not the decimal steps PVX.scale.tickStep would produce. */
    var TIME_STEPS = [
        60000, 2 * 60000, 5 * 60000, 10 * 60000, 15 * 60000, 30 * 60000,
        HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR, 6 * HOUR, 8 * HOUR, 12 * HOUR,
        DAY, 2 * DAY, 7 * DAY
    ];

    var definition = {
        typeName: 'pvxPeriodOverlay',
        displayName: 'PVX Period Comparison',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format Period Comparison',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                /* 800 samples has to cover EVERY period at once, because one
                 * query is all we get — at 7 daily periods that is still ~110
                 * samples a day, enough shape to compare. */
                Intervals: 800,
                Height: 260,
                Width: 420,

                Title: '',
                ShowLabel: true,

                // Folding
                PeriodMode: 'auto',          // auto | hour | shift | day | week | month | custom
                ShiftHours: 8,
                ShiftStartHour: 6,
                CustomPeriodHours: 24,
                AlignTo: 'clock',            // clock | windowEnd
                MaxPeriods: 8,

                // What is drawn
                ShowAs: 'values',            // values | delta | pctdelta
                Baseline: 'median',          // median (of the older periods) | previous

                // Traces
                CurrentStyle: 'bold',        // bold | same
                FadeOlder: true,
                ColorMode: 'fade',           // fade | palette
                CurrentColor: '#3b82c4',
                SmoothLine: false,
                LineWidth: 1.6,

                // Envelope
                ShowEnvelope: true,
                EnvelopeMode: 'minmax',      // minmax | percentile | stddev
                EnvelopeLowP: 0.1,
                EnvelopeHighP: 0.9,
                EnvelopeColor: '',           // blank = AccentColor
                EnvelopeOpacity: 0.18,
                ShowMedian: false,

                // Chrome
                ShowLegend: true,
                LegendLabels: 'auto',        // auto | date | offset
                ShowStats: true,
                ShowGrid: true,
                TickCount: 5,
                TimeTickCount: 6,
                YScaleMode: 'auto',          // auto | fixed
                YMin: '',
                YMax: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Template bindings; everything else is drawn into the SVG.
        scope.pvx = { title: '', period: '', note: '', error: '' };

        /* Rebuilt on every data update AND every config change, because the
         * period length and the alignment change what the periods ARE, not
         * merely how they are drawn. Reused across resize renders. */
        var model = {
            series: null,       // the series folded in full
            others: [],         // [{series, fold}] further sources, current period only
            points: [],         // its samples, time ordered
            windowStart: 0,
            windowEnd: 0,
            span: 0,
            P: DAY,             // period length in ms
            kind: 'day',
            autoKind: false,    // period chosen by the symbol, not the user
            align: 'clock',
            newestStart: 0,     // start instant of period 0
            periods: [],        // [{k, start, pts:[{t,v,rel}], minRel, maxRel, partial}]
            dropped: 0,         // periods beyond MaxPeriods
            gaps: 0,            // periods inside the range that held no samples
            tooShort: false     // the display window is shorter than one period
        };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-po-body',

            onData: function (d) {
                var list = PVX.data.series(d) || [];
                model.series = list.length ? list[0] : null;
                model.list = list;
                model.points = model.series ? (model.series.points || []) : [];
                fold(ctx.config || scope.config || {});
            },

            onConfigChange: function (newCfg) { fold(newCfg || {}); },

            render: render
        });

        /* ================================================================== *
         * period arithmetic
         * ================================================================== */

        /** Local midnight of the day containing t. */
        function localMidnight(t) {
            var d = new Date(t);
            d.setHours(0, 0, 0, 0);
            return d.getTime();
        }

        /**
         * Which period length to fold with.
         *
         * 'auto' exists so the symbol is useful the moment it is dropped on a
         * display: a user who has not opened the config pane yet still gets a
         * comparison that matches the range they are looking at.
         */
        function resolvePeriod(cfg, span) {
            var mode = cfg.PeriodMode || 'auto';
            var kind = mode;
            if (mode === 'auto') {
                kind = span < 48 * HOUR ? 'hour' : (span < 14 * DAY ? 'day' : 'week');
            }
            var P;
            if (kind === 'hour') { P = HOUR; }
            else if (kind === 'week') { P = WEEK; }
            else if (kind === 'shift') {
                P = PVX.util.clamp(PVX.util.num(cfg.ShiftHours) || 8, 0.25, 168) * HOUR;
            } else if (kind === 'custom') {
                P = PVX.util.clamp(PVX.util.num(cfg.CustomPeriodHours) || 24, 0.25, 8760) * HOUR;
            } else if (kind === 'month') {
                P = 31 * DAY;       // the longest month; shorter ones end early
            } else {
                kind = 'day';
                P = DAY;
            }
            return { ms: P, kind: kind, auto: mode === 'auto' };
        }

        /**
         * The most recent real clock boundary at or before t.
         *
         * Every branch derives its anchor with Date setters rather than by
         * subtracting milliseconds, because a day is not always 86400000 ms:
         * across a DST change ms arithmetic lands the "midnight" boundary at
         * 23:00 or 01:00 and every trace shifts an hour against the others.
         */
        function clockBoundary(t, cfg, P, kind) {
            var d = new Date(t);
            if (kind === 'hour') {
                d.setMinutes(0, 0, 0);
                return d.getTime();
            }
            if (kind === 'day') {
                return localMidnight(t);
            }
            if (kind === 'week') {
                // ISO weeks: Monday is day 0 of the comparison.
                var dow = (d.getDay() + 6) % 7;
                d.setDate(d.getDate() - dow);
                d.setHours(0, 0, 0, 0);
                return d.getTime();
            }
            // shift / custom: anchor on the day, then step by whole periods.
            var startHour = 0;
            if (kind === 'shift') {
                startHour = PVX.util.clamp(Math.floor(PVX.util.num(cfg.ShiftStartHour) || 0), 0, 23);
            }
            d.setHours(startHour, 0, 0, 0);
            var anchor = d.getTime();
            // floor() also handles t before the anchor (a negative multiple).
            return anchor + Math.floor((t - anchor) / P) * P;
        }

        /** First instant of the local calendar month containing t. */
        function monthStart(t) {
            var d = new Date(t);
            d.setDate(1);
            d.setHours(0, 0, 0, 0);
            return d.getTime();
        }

        /** Human name for a period length — "1 day", "8 h", "1 week". */
        function periodName(P) {
            if (model.kind === 'month') { return '1 month'; }
            if (P === WEEK) { return '1 week'; }
            if (P % DAY === 0) {
                var d = P / DAY;
                return d + ' day' + (d === 1 ? '' : 's');
            }
            if (P % HOUR === 0) { return (P / HOUR) + ' h'; }
            return Math.round(P / 60000) + ' min';
        }

        /* ================================================================== *
         * folding
         * ================================================================== */

        /**
         * Split the window into periods and give every sample its offset from
         * its own period's start. That offset — not the absolute timestamp — is
         * the x coordinate of the whole symbol.
         */
        function fold(cfg) {
            model.periods = [];
            model.dropped = 0;
            model.gaps = 0;
            model.tooShort = false;
            model.others = [];

            var pts = model.points;
            if (!pts.length) { return; }

            // Every source shares the window, so "current" is the same
            // period for all of them even when one has gone quiet.
            var wStart = pts[0].t, wEnd = pts[pts.length - 1].t, i;
            var list = model.list || [];
            for (i = 1; i < list.length; i++) {
                var lp = list[i].points || [];
                if (lp.length) { wStart = Math.min(wStart, lp[0].t); wEnd = Math.max(wEnd, lp[lp.length - 1].t); }
            }
            model.windowStart = wStart;
            model.windowEnd = wEnd;
            var span = model.windowEnd - model.windowStart;
            if (!(span > 0)) { span = 1; }
            model.span = span;

            var per = resolvePeriod(cfg, span);
            var P = per.ms;
            model.P = P;
            model.kind = per.kind;
            model.autoKind = per.auto;
            model.align = (cfg.AlignTo === 'windowEnd' && per.kind !== 'month') ? 'windowEnd' : 'clock';
            model.tooShort = span < (per.kind === 'month' ? 28 * DAY : P);

            /* Period 0 starts here. In windowEnd mode that is exactly one period
             * back from the last sample, so period 0 ENDS at "now"; in clock
             * mode it is the last real boundary, so period 0 is the one still in
             * progress and its trace stops part way across the axis. */
            var newestStart = per.kind === 'month' ? monthStart(model.windowEnd)
                : (model.align === 'windowEnd')
                ? (model.windowEnd - P)
                : clockBoundary(model.windowEnd, cfg, P, per.kind);
            model.newestStart = newestStart;

            var f = foldPoints(cfg, pts, newestStart, P, per.kind);
            model.periods = f.periods;
            model.dropped = f.dropped;
            model.gaps = f.gaps;
            for (i = 1; i < list.length; i++) {
                model.others.push({ series: list[i], fold: foldPoints(cfg, list[i].points || [], newestStart, P, per.kind) });
            }
        }

        /** Which period a sample is in, and where that period starts. */
        function periodOf(t, newestStart, P, kind) {
            if (kind === 'month') {
                var ms = monthStart(t);
                var a = new Date(ms), b = new Date(newestStart);
                var k = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
                return k < 0 ? { k: 0, start: newestStart } : { k: k, start: ms };
            }
            // ceil() puts a sample landing exactly on a boundary at the
            // START of the newer period, matching how a boundary reads.
            var kk = Math.ceil((newestStart - t) / P);
            if (kk < 0) { kk = 0; }
            return { k: kk, start: newestStart - kk * P };
        }

        function foldPoints(cfg, pts, newestStart, P, kind) {
            var out = { periods: [], dropped: 0, gaps: 0 };
            var byIndex = {};
            var maxK = 0;
            var i, k, rel, bucket;
            for (i = 0; i < pts.length; i++) {
                var po = periodOf(pts[i].t, newestStart, P, kind);
                k = po.k;
                rel = pts[i].t - po.start;
                // Float error at a boundary can push rel a hair outside [0,P].
                if (rel < 0) { rel = 0; }
                if (rel > P) { rel = P; }
                bucket = byIndex[k];
                if (!bucket) {
                    bucket = byIndex[k] = { k: k, start: po.start, pts: [] };
                    if (k > maxK) { maxK = k; }
                }
                bucket.pts.push({ t: pts[i].t, v: pts[i].v, rel: rel });
            }

            // Newest first, so index 0 in the array is always "current".
            var cap = PVX.util.clamp(parseInt(cfg.MaxPeriods, 10) || 8, 1, 24);
            for (k = 0; k <= maxK; k++) {
                bucket = byIndex[k];
                if (!bucket) {
                    // A period inside the range with no samples at all — a gap
                    // in the tag, or a window that does not really cover it.
                    if (k < cap) { out.gaps += 1; }
                    continue;
                }
                if (out.periods.length >= cap) { out.dropped += 1; continue; }
                bucket.pts.sort(function (a, b) { return a.rel - b.rel; });
                bucket.minRel = bucket.pts[0].rel;
                bucket.maxRel = bucket.pts[bucket.pts.length - 1].rel;
                // "Partial" drives the footer, not the drawing: a period that
                // only half covers the axis is still honest to overlay.
                bucket.partial = (bucket.maxRel - bucket.minRel) < P * 0.9;
                out.periods.push(bucket);
            }
            return out;
        }

        /* ================================================================== *
         * resampling onto the common relative grid
         * ================================================================== *
         * Overlaying raw samples would fail quietly: PI returns each period on
         * its own compressed timestamps, so two traces of the same shape land on
         * different x positions and the envelope would be computed across
         * samples that do not correspond to each other. Every period is
         * therefore resampled onto ONE relative grid first.
         */

        /**
         * Min/max-preserving buckets, one entry per grid slot.
         *
         * Averaging into the slot would erase exactly what this symbol exists to
         * show: the excursion spike that made today different from yesterday.
         * Each slot keeps its minimum, its maximum, the offsets they occurred
         * at, and the mean (which the percentile and stddev envelopes need).
         */
        function bucketize(period, P, G) {
            var out = [], i;
            for (i = 0; i < G; i++) { out.push(null); }
            var pts = period.pts;
            for (i = 0; i < pts.length; i++) {
                var idx = PVX.util.clamp(Math.floor((pts[i].rel / P) * G), 0, G - 1);
                var b = out[idx];
                var v = pts[i].v;
                if (!b) {
                    out[idx] = {
                        min: v, max: v, minRel: pts[i].rel, maxRel: pts[i].rel,
                        first: pts[i].rel, last: pts[i].rel, sum: v, n: 1, mean: v
                    };
                    continue;
                }
                if (v < b.min) { b.min = v; b.minRel = pts[i].rel; }
                if (v > b.max) { b.max = v; b.maxRel = pts[i].rel; }
                b.last = pts[i].rel;
                b.sum += v;
                b.n += 1;
                b.mean = b.sum / b.n;
            }
            return out;
        }

        /**
         * Buckets -> polyline segments in relative-time order.
         *
         * Each populated slot contributes its minimum AND its maximum, ordered
         * by the offset they actually occurred at, so the trace keeps its true
         * vertical extent. Slots are only broken apart when the empty run
         * between them is long enough to be a real data gap — a single empty
         * slot is a sampling artefact of the grid, not a hole in the tag, and
         * breaking on it would shred every trace into dashes.
         */
        function segmentsOf(buckets, P, G, breakGap) {
            var segs = [], cur = null, lastRel = null;
            for (var i = 0; i < G; i++) {
                var b = buckets[i];
                if (!b) { continue; }
                if (cur && lastRel !== null && (b.first - lastRel) > breakGap) {
                    segs.push(cur);
                    cur = null;
                }
                if (!cur) { cur = []; }
                if (b.minRel <= b.maxRel) {
                    cur.push({ rel: b.minRel, v: b.min });
                    if (b.maxRel !== b.minRel) { cur.push({ rel: b.maxRel, v: b.max }); }
                } else {
                    cur.push({ rel: b.maxRel, v: b.max });
                    cur.push({ rel: b.minRel, v: b.min });
                }
                lastRel = b.last;
            }
            if (cur && cur.length) { segs.push(cur); }
            return segs;
        }

        /**
         * The envelope, computed PER RELATIVE SLOT across the older periods.
         *
         * One global band would be useless: it would just be the tag's overall
         * range, and every trace would sit inside it. What matters is the range
         * the process occupied AT THIS POINT IN THE PERIOD — 06:00 on a startup
         * day looks nothing like 06:00 on a steady day, and the envelope is the
         * only thing that can say so.
         */
        function buildEnvelope(older, G, mode, lowP, highP) {
            var env = [], i, j;
            for (i = 0; i < G; i++) {
                var lo = null, hi = null, mid = null;
                var means = [];
                var contributors = 0;
                for (j = 0; j < older.length; j++) {
                    var b = older[j][i];
                    if (!b) { continue; }
                    contributors += 1;
                    means.push(b.mean);
                    if (lo === null || b.min < lo) { lo = b.min; }
                    if (hi === null || b.max > hi) { hi = b.max; }
                }

                /* A slot fed by ONE period has no spread to describe. Its
                 * min/max would be that period's own within-slot wobble — a
                 * hairline band — and the "in envelope" figure measured against
                 * it would read as an alarm when all it means is that a single
                 * run is not a reference. The oldest period in a window is
                 * routinely a stub, so this is the common case, not a corner
                 * one: those slots get NO envelope and are excluded from the
                 * comparison rather than poisoning it. */
                if (contributors < 2) { env.push(null); continue; }

                if (mode === 'stddev') {
                    // Percentile and stddev describe the DISTRIBUTION across
                    // periods, so each period contributes one representative
                    // number for the slot — its mean — not its whole range.
                    var m = PVX.stats.mean(means);
                    var sd = PVX.stats.stddev(means) || 0;
                    lo = m - sd; hi = m + sd;
                } else if (mode === 'percentile') {
                    lo = PVX.stats.percentile(means, lowP);
                    hi = PVX.stats.percentile(means, highP);
                }
                // The median line is always the true median of the periods,
                // never the mid-point of the band — on a skewed slot those are
                // different numbers and only one of them is called "median".
                mid = PVX.stats.percentile(means, 0.5);
                env.push({ lo: lo, hi: hi, mid: mid });
            }
            return env;
        }

        /** Contiguous runs of populated envelope slots, for one ribbon each. */
        function envelopeRuns(env, G, maxGapSlots) {
            var runs = [], cur = null, lastIdx = -1;
            for (var i = 0; i < G; i++) {
                if (!env[i]) { continue; }
                if (cur && (i - lastIdx) > maxGapSlots) { runs.push(cur); cur = null; }
                if (!cur) { cur = []; }
                cur.push(i);
                lastIdx = i;
            }
            if (cur && cur.length) { runs.push(cur); }
            return runs;
        }

        /* ================================================================== *
         * comparison statistics
         * ================================================================== */

        /**
         * Current period against the envelope.
         *
         * Two different questions, deliberately answered from two different
         * numbers: "how much of it sits inside" uses each slot's MEAN, because
         * a single stray sample should not make a whole slot count as an
         * excursion; "largest departure" uses the slot's EXTREMES, because a
         * spike that left the envelope for two minutes is precisely the event
         * an operator is looking for and averaging would hide it.
         */
        function compare(cur, env, G, P) {
            var s = { total: 0, inside: 0, pct: null, dep: 0, depRel: null, depSign: 0 };
            for (var i = 0; i < G; i++) {
                if (!cur[i] || !env[i]) { continue; }
                s.total += 1;
                if (cur[i].mean >= env[i].lo && cur[i].mean <= env[i].hi) { s.inside += 1; }
                var above = cur[i].max - env[i].hi;
                var below = env[i].lo - cur[i].min;
                var dep = Math.max(above, below);
                if (dep > s.dep) {
                    s.dep = dep;
                    s.depSign = above >= below ? 1 : -1;
                    s.depRel = above >= below ? cur[i].maxRel : cur[i].minRel;
                }
            }
            if (s.total) { s.pct = (s.inside / s.total) * 100; }
            return s;
        }

        /* ================================================================== *
         * labels
         * ================================================================== */

        function pad2(n) { return (n < 10 ? '0' : '') + n; }

        /** Elapsed-into-period label — the windowEnd axis. */
        function elapsedLabel(rel, P) {
            if (rel <= 0) { return '0'; }
            if (P <= 2 * HOUR) { return Math.round(rel / 60000) + 'm'; }
            if (P <= 2 * DAY) {
                var h = rel / HOUR;
                return (h < 10 ? (Math.round(h * 10) / 10) : Math.round(h)) + 'h';
            }
            return (Math.round((rel / DAY) * 10) / 10) + 'd';
        }

        /** Wall-clock label — the clock-aligned axis. */
        function clockLabel(rel, P, newestStart) {
            if (model.kind === 'month') { return 'day ' + (Math.floor(rel / DAY) + 1); }
            var d = new Date(newestStart + rel);
            // Past a couple of days the interesting coordinate is the day, not
            // the hour: on a weekly fold "Mon" says far more than "00:00".
            if (P >= 2 * DAY) {
                return WEEKDAYS[d.getDay()] + (P >= WEEK ? '' : ' ' + pad2(d.getHours()) + ':00');
            }
            return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        }

        function axisLabel(rel, cfg) {
            return model.align === 'windowEnd'
                ? elapsedLabel(rel, model.P)
                : clockLabel(rel, model.P, model.newestStart);
        }

        function axisTitleText() {
            if (model.align === 'windowEnd') { return 'Elapsed into period'; }
            if (model.kind === 'month') { return 'Day of month'; }
            if (model.P >= 2 * DAY) { return 'Day of week'; }
            return 'Time of day';
        }

        /** "-1 day", "-3 h" — how far back this period sits. */
        function offsetLabel(k, P) {
            if (k === 0) { return 'current'; }
            if (model.kind === 'month') { return '-' + k + ' month' + (k === 1 ? '' : 's'); }
            var name, n;
            if (P === WEEK) { name = 'week'; n = k; }
            else if (P % DAY === 0) { name = 'day'; n = k * (P / DAY); }
            else if (P % HOUR === 0) { name = 'h'; n = k * (P / HOUR); }
            else { name = 'period'; n = k; }
            if (name === 'h') { return '-' + n + ' h'; }
            return '-' + n + ' ' + name + (n === 1 ? '' : 's');
        }

        /** The period's own date, which is what people actually say out loud. */
        function dateLabel(start, P) {
            var d = new Date(start);
            if (model.kind === 'month') {
                return ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()] +
                    ' ' + d.getFullYear();
            }
            var day = WEEKDAYS[d.getDay()] + ' ' + (d.getMonth() + 1) + '/' + d.getDate();
            if (P >= DAY) { return day; }
            return day + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
        }

        function periodLabel(p, cfg) {
            var style = cfg.LegendLabels || 'auto';
            if (style === 'offset') { return offsetLabel(p.k, model.P); }
            if (style === 'date') { return dateLabel(p.start, model.P); }
            /* auto: a date is only a useful name when the period IS a named
             * stretch of the calendar. On a 4-hour fold "Tue 8/4 12:00" is
             * noise; "-8 h" is what the user is thinking. */
            if (model.P >= DAY && model.align === 'clock') { return dateLabel(p.start, model.P); }
            return offsetLabel(p.k, model.P);
        }

        function fitText(str, maxW, fontPx) {
            var s = String(str === null || str === undefined ? '' : str);
            var m = Math.floor(maxW / (fontPx * CHAR_W));
            if (m < 1) { return ''; }
            if (s.length <= m) { return s; }
            if (m === 1) { return '…'; }
            return s.slice(0, m - 1) + '…';
        }

        /* ================================================================== *
         * colour
         * ================================================================== */

        /**
         * Colour for period k.
         *
         * 'fade' is the default because it is the single most effective way to
         * make "which line is today" obvious: the current period keeps its full
         * colour and everything older desaturates toward the muted text colour
         * and, if FadeOlder is on, thins out with age. 'palette' gives every
         * period its own hue, which only earns its keep when the user needs to
         * name a specific past period rather than see the envelope.
         */
        /**
         * The categorical palette with the current period's colour removed.
         *
         * The palette's head is #3b82c4 — which is also the default
         * CurrentColor — so a naive palette would paint yesterday in exactly
         * today's colour, and the two most important traces on the chart would
         * be told apart only by line weight. Compared as resolved hex so a
         * '#3B82C4' typed into the config pane still matches.
         */
        function olderPalette(current, t) {
            var pal = t.categorical || PVX.color.categorical;
            var mine = (PVX.color.toHex(PVX.color.toRgb(current)) || '').toLowerCase();
            var out = [], i, hex;
            for (i = 0; i < pal.length; i++) {
                hex = (PVX.color.toHex(PVX.color.toRgb(pal[i])) || '').toLowerCase();
                if (hex !== mine) { out.push(pal[i]); }
            }
            return out.length ? out : pal;
        }

        function periodColor(cfg, k, olderCount, t) {
            var current = cfg.CurrentColor || cfg.AccentColor || '#3b82c4';
            if (k === 0) { return current; }
            if (cfg.ColorMode === 'palette') {
                var pal = olderPalette(current, t);
                return pal[(k - 1) % pal.length];
            }
            /* Two steps, and they do different jobs. Desaturating toward the
             * muted text colour takes the older runs out of competition with
             * the current one; receding toward the SURFACE is what actually
             * reads as depth, because it is the direction the background lies
             * in. (A transparent surface has no colour to mix with, and
             * PVX.color.mix returns the first argument unchanged, so the
             * desaturation still applies and nothing breaks.) */
            var age = olderCount > 1 ? (k - 1) / (olderCount - 1) : 0;
            var base = PVX.color.mix(current, t.textMuted, 0.55);
            return PVX.color.mix(base, t.surface, age * 0.4);
        }

        function periodOpacity(cfg, k, olderCount) {
            if (k === 0) { return 1; }
            if (cfg.FadeOlder === false) {
                return cfg.ColorMode === 'palette' ? 0.85 : 0.7;
            }
            var age = olderCount > 1 ? (k - 1) / (olderCount - 1) : 0;
            // Never below 0.22: a trace nobody can see is worse than no trace,
            // because the legend still claims it is there.
            var top = cfg.ColorMode === 'palette' ? 0.9 : 0.78;
            return top - age * (top - 0.22);
        }

        /* ================================================================== *
         * render
         * ================================================================== */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            applyThemeVars(c, t);

            var W = Math.max(30, host.clientWidth || c.width || 30);
            var H = Math.max(24, host.clientHeight || c.height || 24);

            /* Header and footer are HTML outside the SVG, so the chrome budget
             * is measured against the WHOLE symbol. Measuring against the plot
             * host would make suppressing the footer grow the host, which
             * un-suppresses it, which shrinks it again. */
            var rootW = (c.node && c.node.clientWidth) || W;
            var rootH = (c.node && c.node.clientHeight) || H;

            var svgRoot = host.querySelector('svg.pvx-po-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-po-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var i, k;

            // ---- bindings that survive every branch -------------------------
            scope.pvx.error = (model.series && model.series.good === false)
                ? (model.series.errorDescription || 'Bad data quality on this source')
                : '';
            var showTitle = rootH >= 96 && rootW >= 120;
            scope.pvx.title = showTitle ? titleText(cfg) : '';
            scope.pvx.period = '';
            scope.pvx.note = '';

            // ---- empty states ------------------------------------------------
            if (!model.series) {
                emptyState(svgRoot, W, H, t, 'No data source configured',
                    'Drop one tag or attribute onto the symbol.');
                digest();
                return;
            }
            if (!model.points.length || !model.periods.length) {
                emptyState(svgRoot, W, H, t, 'No samples in this time range',
                    'Widen the display time range.');
                digest();
                return;
            }

            var P = model.P;
            var periods = model.periods;
            var olderCount = periods.length - 1;

            // The caption shares the header row with the title, and the title
            // says WHICH tag — so the caption only earns its width once there is
            // room for both, and gives up its detail before its substance.
            scope.pvx.period = (showTitle && rootW >= 300) ? periodCaption(rootW >= 430) : '';

            /* ---- what the box can afford -----------------------------------
             * Below roughly 200x140 the stats panel, the legend and the axis
             * titles cost more than they inform; below 140x100 even the tick
             * labels do. Gated on the SYMBOL, not the drawing host, so the
             * header and footer cannot silently eat the allowance. */
            var tickFont = PVX.util.clamp(Math.round(Math.min(W, H) / 20), 8, 12);
            var titleFont = PVX.util.clamp(tickFont + 1, 9, 13);
            var showTicks = W >= 140 && H >= 100;
            /* Chrome comes back in order of what it is worth. The legend is
             * first because "which line is today" is the question the symbol
             * exists to answer; the panel next; the axis titles last, because
             * a labelled tick already says "00:00" and the title only names the
             * thing the ticks are already showing. Cramming all three into a
             * 200x140 tile leaves a plot too small to read them against. */
            var showLegend = cfg.ShowLegend !== false && rootW >= 200 && rootH >= 140;
            var showStats = cfg.ShowStats !== false && rootW >= 230 && rootH >= 160;
            var showAxisTitle = rootW >= 260 && rootH >= 175;

            // ---- resolution of the shared relative grid ------------------------
            /* Two ceilings. The plot cannot show more slots than it has pixels,
             * and the DATA cannot fill more slots than the busiest period has
             * samples — asking for more would scatter every trace into isolated
             * dots with empty slots between them. */
            var densest = 0;
            for (i = 0; i < periods.length; i++) {
                if (periods[i].pts.length > densest) { densest = periods[i].pts.length; }
            }
            var plotWGuess = Math.max(20, W - 44);
            var G = Math.min(Math.floor(plotWGuess / 2), Math.ceil(densest * 0.9));
            G = PVX.util.clamp(G, 4, 400);

            var slotW = P / G;
            // A run of empty slots only breaks a trace when it is a real hole in
            // the data rather than a rounding artefact of the grid.
            var breakGap = Math.max(slotW * 3, P * 0.04);
            var maxGapSlots = Math.max(3, Math.ceil((P * 0.04) / slotW));

            var buckets = [];
            for (i = 0; i < periods.length; i++) {
                buckets.push(bucketize(periods[i], P, G));
            }

            // Further sources: their current period on the same grid, each
            // measured from its own baseline when change is shown.
            var showAs = cfg.ShowAs === 'delta' || cfg.ShowAs === 'pctdelta' ? cfg.ShowAs : 'values';
            var noBase = 0;
            var others = [];
            for (i = 0; i < model.others.length; i++) {
                var ofd = model.others[i].fold;
                var ob = [];
                for (k = 0; k < ofd.periods.length; k++) { ob.push(bucketize(ofd.periods[k], P, G)); }
                if (showAs !== 'values') { noBase += toChange(ob, ofd.periods, G, cfg, showAs).missing; }
                others.push({ series: model.others[i].series,
                              cur: ofd.periods.length && ofd.periods[0].k === 0 ? ob[0] : null });
            }
            if (showAs !== 'values') { noBase += toChange(buckets, periods, G, cfg, showAs).missing; }

            // ---- envelope ---------------------------------------------------------
            var envMode = cfg.EnvelopeMode || 'minmax';
            var lowP = PVX.util.clamp(PVX.util.num(cfg.EnvelopeLowP), 0, 1);
            var highP = PVX.util.clamp(PVX.util.num(cfg.EnvelopeHighP), 0, 1);
            if (!(highP > lowP)) { lowP = 0.1; highP = 0.9; }

            /* An envelope is a statement about how much periods VARY, so it
             * needs at least two of them to compare. With a single older period
             * there is nothing to average, spread or bound — the honest picture
             * is the two traces side by side, and the footer says why the band
             * is missing rather than drawing a band that means nothing. */
            var older = buckets.slice(1);
            var env = (olderCount >= 2) ? buildEnvelope(older, G, envMode, lowP, highP) : null;
            var wantEnvelope = cfg.ShowEnvelope !== false && env !== null;
            var wantMedian = !!cfg.ShowMedian && env !== null;

            // ---- value domain -------------------------------------------------------
            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 10);
            var domain = valueDomain(cfg, buckets.concat(others.map(function (o) { return o.cur || []; })), env, tickCount,
                showAs !== 'values');
            var vTicks = PVX.scale.ticks(domain[0], domain[1], tickCount);

            // ---- margins from the actual tick strings --------------------------------
            var vLabelW = 0;
            if (showTicks) {
                for (k = 0; k < vTicks.length; k++) {
                    vLabelW = Math.max(vLabelW, PVX.fmt.tick(vTicks[k]).length * tickFont * CHAR_W);
                }
            }
            var units = showAs === 'pctdelta' ? '%' : (model.series.units || '');
            var axisTitle = !showAxisTitle ? '' : showAs === 'values' ? (units ? 'Value (' + units + ')' : 'Value') :
                'Change' + (units ? ' (' + units + ')' : '');
            var xTitle = showAxisTitle ? axisTitleText() : '';
            var legendH = showLegend ? (tickFont + 7) : 0;

            var mL = 6 + (axisTitle ? titleFont + 3 : 0) + vLabelW + (showTicks ? 5 : 0);
            var mR = 8;
            var mT = 6 + legendH;
            var mB = 5 + (showTicks ? tickFont + 6 : 2) + (xTitle ? titleFont + 2 : 0);

            mL = Math.min(mL, W * 0.45);
            mT = Math.min(mT, H * 0.40);
            mB = Math.min(mB, H * 0.40);

            var plot = {
                x: mL, y: mT,
                w: Math.max(10, W - mL - mR),
                h: Math.max(10, H - mT - mB)
            };
            plot.x1 = plot.x + plot.w;
            plot.y1 = plot.y + plot.h;

            var sx = PVX.scale.linear(0, P, plot.x, plot.x1);
            var sy = PVX.scale.linear(domain[0], domain[1], plot.y1, plot.y);   // SVG y grows down

            // ---- grid -----------------------------------------------------------------
            var relTicks = buildRelTicks(cfg, P, plot.w, tickFont);
            if (cfg.ShowGrid !== false) {
                for (k = 0; k < vTicks.length; k++) {
                    gridLine(svgRoot, plot.x, sy(vTicks[k]), plot.x1, sy(vTicks[k]), t.grid);
                }
                for (k = 0; k < relTicks.length; k++) {
                    var gx = sx(relTicks[k]);
                    gridLine(svgRoot, gx, plot.y, gx, plot.y1, t.grid);
                }
            }

            // ---- clip everything data-driven to the plot rect ---------------------------
            var clipId = host.getAttribute('data-pvx-clip') || PVX.util.uid('poclip');
            host.setAttribute('data-pvx-clip', clipId);
            var defs = PVX.svg.el('defs', null, svgRoot);
            var clip = PVX.svg.el('clipPath', { id: clipId }, defs);
            PVX.svg.el('rect', {
                x: plot.x.toFixed(2), y: plot.y.toFixed(2),
                width: plot.w.toFixed(2), height: plot.h.toFixed(2)
            }, clip);
            /* Bad quality dims the whole plot rather than recolouring anything:
             * every trace and the envelope come from the same tag, so the
             * problem is with all of it at once. The shapes still carry their
             * meaning, they just should not command attention while the values
             * behind them are untrustworthy — the badge in the corner says why. */
            var plotG = PVX.svg.el('g', {
                'clip-path': 'url(#' + clipId + ')',
                opacity: (model.series.good === false) ? '0.5' : null
            }, svgRoot);

            var smooth = !!cfg.SmoothLine;
            var lineW = PVX.util.clamp(PVX.util.num(cfg.LineWidth) || 1.6, 0.4, 8);
            var envColor = cfg.EnvelopeColor || cfg.AccentColor || '#3b82c4';
            var envOp = PVX.util.num(cfg.EnvelopeOpacity);
            envOp = (envOp === null) ? 0.18 : PVX.util.clamp(envOp, 0, 1);

            // In change mode zero IS the baseline, and the line to read from.
            if (showAs !== 'values' && domain[0] < 0 && domain[1] > 0) {
                PVX.svg.el('line', {
                    x1: plot.x.toFixed(2), y1: sy(0).toFixed(2), x2: plot.x1.toFixed(2), y2: sy(0).toFixed(2),
                    stroke: t.axis, 'stroke-width': 1.2, 'class': 'pvx-po-zero'
                }, plotG);
            }

            // ---- envelope, first and underneath everything ---------------------------------
            if (wantEnvelope && envOp > 0) {
                drawEnvelope(plotG, env, G, P, sx, sy, envColor, envOp, smooth, maxGapSlots);
            }
            if (wantMedian) {
                drawMedian(plotG, env, G, P, sx, sy, envColor, smooth, maxGapSlots);
            }

            /* ---- traces, oldest first ---------------------------------------------------
             * Paint order IS the message: the current period goes on last and
             * heavier so it is never buried under the history it is being
             * compared against. */
            for (i = periods.length - 1; i >= 0; i--) {
                var kk = periods[i].k;
                var col = periodColor(cfg, kk, olderCount, t);
                var op = periodOpacity(cfg, kk, olderCount);
                var wdt = (kk === 0 && cfg.CurrentStyle !== 'same') ? lineW * 1.7 : lineW;
                var segs = segmentsOf(buckets[i], P, G, breakGap);
                var g = PVX.svg.el('g', {
                    'class': kk === 0 ? 'pvx-po-current' : 'pvx-po-older',
                    opacity: op.toFixed(3)
                }, plotG);
                for (k = 0; k < segs.length; k++) {
                    var xy = toXY(segs[k], sx, sy);
                    if (xy.length < 2) {
                        if (xy.length === 1) {
                            PVX.svg.el('circle', {
                                cx: xy[0].x.toFixed(2), cy: xy[0].y.toFixed(2),
                                r: (wdt * 0.9).toFixed(2), fill: col, 'class': 'pvx-po-dot'
                            }, g);
                        }
                        continue;
                    }
                    PVX.svg.el('path', {
                        d: PVX.svg.line(xy, smooth), fill: 'none', stroke: col,
                        'stroke-width': wdt.toFixed(2),
                        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
                        'vector-effect': 'non-scaling-stroke', 'class': 'pvx-po-line'
                    }, g);
                }
                // An end marker on the current trace answers "where are we now"
                // without the user having to trace the heaviest line by eye.
                if (kk === 0 && segs.length) {
                    var lastSeg = segs[segs.length - 1];
                    var lastPt = lastSeg[lastSeg.length - 1];
                    PVX.svg.el('circle', {
                        cx: PVX.util.clamp(sx(lastPt.rel), plot.x, plot.x1 - 1).toFixed(2),
                        cy: sy(lastPt.v).toFixed(2),
                        r: Math.max(2, lineW * 1.4).toFixed(2),
                        fill: col, 'class': 'pvx-po-end'
                    }, g);
                }
            }

            // ---- further sources: current period only, own colour ----------------------------
            var otherPal = olderPalette(cfg.CurrentColor || cfg.AccentColor || '#3b82c4', t);
            for (i = 0; i < others.length; i++) {
                others[i].color = otherPal[i % otherPal.length];
                if (!others[i].cur) { continue; }
                var osegs = segmentsOf(others[i].cur, P, G, breakGap);
                var og = PVX.svg.el('g', { 'class': 'pvx-po-other' }, plotG);
                for (k = 0; k < osegs.length; k++) {
                    var oxy = toXY(osegs[k], sx, sy);
                    if (oxy.length < 2) { continue; }
                    PVX.svg.el('path', {
                        d: PVX.svg.line(oxy, smooth), fill: 'none', stroke: others[i].color,
                        'stroke-width': (lineW * 1.4).toFixed(2), 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
                        'vector-effect': 'non-scaling-stroke', 'class': 'pvx-po-line'
                    }, og);
                }
            }

            // ---- axes -------------------------------------------------------------------------
            PVX.svg.el('line', {
                x1: plot.x.toFixed(2), y1: plot.y1.toFixed(2),
                x2: plot.x1.toFixed(2), y2: plot.y1.toFixed(2),
                stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, svgRoot);
            PVX.svg.el('line', {
                x1: plot.x.toFixed(2), y1: plot.y.toFixed(2),
                x2: plot.x.toFixed(2), y2: plot.y1.toFixed(2),
                stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, svgRoot);

            if (showTicks) {
                for (k = 0; k < vTicks.length; k++) {
                    PVX.svg.text(svgRoot, (plot.x - 4).toFixed(2), sy(vTicks[k]).toFixed(2),
                        PVX.fmt.tick(vTicks[k]), {
                            'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end',
                            'font-size': tickFont, fill: t.textMuted
                        });
                }
                for (k = 0; k < relTicks.length; k++) {
                    drawRelLabel(svgRoot, sx(relTicks[k]), plot.y1 + 4 + tickFont * 0.6,
                        axisLabel(relTicks[k], cfg), W, tickFont, t);
                }
            }

            if (axisTitle) {
                var ax = titleFont * 0.8 + 1;
                var midY = plot.y + plot.h / 2;
                PVX.svg.text(svgRoot, ax.toFixed(2), midY.toFixed(2),
                    fitText(axisTitle, plot.h, titleFont), {
                        'class': 'pvx-svg-label pvx-po-axis-title', 'text-anchor': 'middle',
                        'font-size': titleFont, fill: t.text,
                        transform: 'rotate(-90 ' + ax.toFixed(2) + ' ' + midY.toFixed(2) + ')'
                    });
            }
            if (xTitle) {
                PVX.svg.text(svgRoot, (plot.x + plot.w / 2).toFixed(2), (H - titleFont * 0.5).toFixed(2),
                    fitText(xTitle, plot.w, titleFont), {
                        'class': 'pvx-svg-label pvx-po-axis-title', 'text-anchor': 'middle',
                        'font-size': titleFont, fill: t.text
                    });
            }

            // ---- legend ----------------------------------------------------------------------------
            if (showLegend) {
                drawLegend(svgRoot, cfg, t, plot, tickFont, periods, olderCount,
                    wantEnvelope, wantMedian, envColor, envOp, envMode, lowP, highP, others);
            }

            // ---- statistics --------------------------------------------------------------------------
            var cmp = null;
            if (env) { cmp = compare(buckets[0], env, G, P); }
            if (showStats && cmp && cmp.total > 0) {
                drawStats(svgRoot, cmp, cfg, t, plot, tickFont, units, buckets[0], sy, P);
            }

            // ---- footer notes ---------------------------------------------------------------------------
            var notes = [];
            if (model.tooShort) {
                notes.push('display range (' + PVX.fmt.duration(model.span) +
                    ') is shorter than one ' + periodName(P) + ' period — nothing to compare');
            } else if (periods.length === 1) {
                notes.push('only one ' + periodName(P) +
                    ' period in this range — no envelope is possible; widen the display range');
            } else if (olderCount === 1) {
                notes.push('one older period — an envelope needs at least two, so the traces are compared directly');
            } else if (env && (!cmp || cmp.total === 0)) {
                // Every older period sits at a part of the cycle the current one
                // has not reached (or has already left). There is a band on the
                // chart and a current trace, but they never meet, so there is no
                // comparison to report and the panel is right to stay away.
                notes.push('the current period does not overlap the envelope yet — nothing to compare');
            } else if (cmp && cmp.total > 0) {
                // How much of the current period the envelope actually covers.
                // A comparison over a quarter of the axis is a different claim
                // from one over all of it, and the headline percentage alone
                // cannot tell them apart.
                var occupied = 0;
                for (i = 0; i < G; i++) { if (buckets[0][i]) { occupied += 1; } }
                if (occupied && cmp.total < occupied * 0.7) {
                    notes.push('envelope covers ' + Math.round((cmp.total / occupied) * 100) +
                        '% of the current period — the older periods do not overlap the rest');
                }
            }
            if (model.dropped) {
                notes.push(model.dropped + ' older period' + (model.dropped === 1 ? '' : 's') +
                    ' dropped — MaxPeriods is ' + periods.length);
            }
            if (model.gaps) {
                notes.push(model.gaps + ' period' + (model.gaps === 1 ? '' : 's') + ' had no samples');
            }
            if (showAs !== 'values') {
                notes.unshift((showAs === 'pctdelta' ? '% change' : 'change') + ' from ' +
                    (cfg.Baseline === 'previous' ? 'the period before' : 'the median of the older periods'));
            }
            if (noBase) {
                notes.push(noBase + ' slot' + (noBase === 1 ? '' : 's') + ' with no baseline' +
                    (showAs === 'pctdelta' ? ' or a zero one' : '') + ' left out');
            }
            for (i = 0; i < others.length; i++) {
                if (!others[i].cur) { notes.push((others[i].series.label || 'source ' + (i + 2)) + ' has no current period'); }
            }
            scope.pvx.note = (rootW >= 240 && rootH >= 150) ? notes.join(' · ') : '';

            digest();
        }

        /* ================================================================== *
         * change from a baseline
         * ================================================================== */

        /**
         * Rewrite each period's slots as their change from the baseline at the
         * same slot, in place. Percent change divides by the baseline's size,
         * which keeps the order of min and max, so the slot's extremes stay
         * its extremes. Returns how many slots had no baseline to measure from.
         */
        function toChange(buckets, periods, G, cfg, showAs) {
            var base = [], i, j, missing = 0;
            var prevIdx = -1;
            for (j = 1; j < periods.length; j++) { if (periods[j].k >= 1) { prevIdx = j; break; } }
            for (i = 0; i < G; i++) {
                if (cfg.Baseline === 'previous') {
                    base.push(prevIdx > 0 && buckets[prevIdx][i] ? buckets[prevIdx][i].mean : null);
                    continue;
                }
                var means = [];
                for (j = 1; j < buckets.length; j++) { if (buckets[j][i]) { means.push(buckets[j][i].mean); } }
                base.push(means.length ? PVX.stats.percentile(means, 0.5) : null);
            }
            for (j = 0; j < buckets.length; j++) {
                for (i = 0; i < G; i++) {
                    var b = buckets[j][i];
                    if (!b) { continue; }
                    var bv = base[i];
                    if (bv === null || (showAs === 'pctdelta' && Math.abs(bv) < 1e-12)) {
                        buckets[j][i] = null;
                        if (j === 0) { missing += 1; }
                        continue;
                    }
                    var f = showAs === 'pctdelta' ? 100 / Math.abs(bv) : 1;
                    b.min = (b.min - bv) * f;
                    b.max = (b.max - bv) * f;
                    b.mean = (b.mean - bv) * f;
                    b.sum = b.mean * b.n;
                }
            }
            return { missing: missing };
        }

        /* ================================================================== *
         * domain and ticks
         * ================================================================== */

        function valueDomain(cfg, buckets, env, tickCount, withZero) {
            var lo = null, hi = null, i, k;
            var take = function (v) {
                if (!PVX.util.isNum(v)) { return; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            };
            for (i = 0; i < buckets.length; i++) {
                for (k = 0; k < buckets[i].length; k++) {
                    if (!buckets[i][k]) { continue; }
                    take(buckets[i][k].min);
                    take(buckets[i][k].max);
                }
            }
            // The envelope must fit too — a percentile band drawn outside the
            // axis would make the setting look inert.
            if (env) {
                for (k = 0; k < env.length; k++) {
                    if (!env[k]) { continue; }
                    take(env[k].lo);
                    take(env[k].hi);
                }
            }
            if (lo === null) { return [0, 1]; }
            if (withZero) { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }

            var d = PVX.scale.niceDomain(lo, hi, tickCount);
            if (cfg.YScaleMode === 'fixed') {
                // Each bound is independent: a user who only cares about the
                // ceiling should not have to invent a floor.
                var yMin = PVX.util.num(cfg.YMin);
                var yMax = PVX.util.num(cfg.YMax);
                if (yMin !== null) { d[0] = yMin; }
                if (yMax !== null) { d[1] = yMax; }
            }
            if (!(d[1] > d[0])) { d[1] = d[0] + 1; }
            return d;
        }

        /**
         * Ticks on the relative axis.
         *
         * The axis is a duration, so the steps come from a clock's vocabulary
         * (15 min, 6 h, a day) rather than from decimal rounding — with clock
         * alignment that also lands the labels on 00:00, 06:00, 12:00 instead of
         * on 03:12 and 09:36.
         */
        function buildRelTicks(cfg, P, plotW, font) {
            var want = PVX.util.clamp(parseInt(cfg.TimeTickCount, 10) || 6, 2, 12);
            // "Wed 8/12" is about 8 characters; two touching is worse than half
            // as many that can be read.
            var fits = Math.max(2, Math.floor(plotW / (8 * font * CHAR_W + 10)));
            var n = Math.max(2, Math.min(want, fits));

            var step = P / n;
            for (var i = 0; i < TIME_STEPS.length; i++) {
                if (TIME_STEPS[i] >= step) { step = TIME_STEPS[i]; break; }
                if (i === TIME_STEPS.length - 1) { step = TIME_STEPS[i]; }
            }
            var out = [];
            for (var v = 0, guard = 0; v <= P + 1 && guard < 200; v += step, guard++) {
                out.push(v);
            }
            /* Mark the far edge when the last regular tick falls well short of
             * it — a fold whose axis stops labelling at 20:00 reads as if the
             * period were shorter than it is. Only when the gap is wide enough
             * to keep the two labels apart, though. */
            if (out.length && (P - out[out.length - 1]) > step * 0.75) { out.push(P); }
            return out;
        }

        /* ================================================================== *
         * drawing
         * ================================================================== */

        function gridLine(parent, x1, y1, x2, y2, stroke) {
            PVX.svg.el('line', {
                x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2),
                stroke: stroke, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, parent);
        }

        function toXY(pts, sx, sy) {
            var out = [];
            for (var i = 0; i < pts.length; i++) {
                out.push({ x: sx(pts[i].rel), y: sy(pts[i].v) });
            }
            return out;
        }

        /** Closed path between an upper and a lower polyline. */
        function ribbonPath(top, bottom, smooth) {
            if (!top.length || !bottom.length) { return ''; }
            var rev = [], i;
            for (i = bottom.length - 1; i >= 0; i--) { rev.push(bottom[i]); }
            var back = PVX.svg.line(rev, smooth);
            return PVX.svg.line(top, smooth) + ' L' + back.slice(1) + ' Z';
        }

        function drawEnvelope(parent, env, G, P, sx, sy, color, opacity, smooth, maxGapSlots) {
            var runs = envelopeRuns(env, G, maxGapSlots);
            for (var r = 0; r < runs.length; r++) {
                var top = [], bot = [], idx;
                for (var i = 0; i < runs[r].length; i++) {
                    idx = runs[r][i];
                    // Slot centre: the envelope describes a slot, not an instant.
                    var x = sx(((idx + 0.5) / G) * P);
                    top.push({ x: x, y: sy(env[idx].hi) });
                    bot.push({ x: x, y: sy(env[idx].lo) });
                }
                if (top.length < 2) { continue; }
                PVX.svg.el('path', {
                    d: ribbonPath(top, bot, smooth),
                    fill: color, 'fill-opacity': opacity, stroke: 'none',
                    'class': 'pvx-po-envelope'
                }, parent);
                // A hairline on each edge: the shading says "region", the edges
                // say "these exact values are the limits of the history".
                edgeLine(parent, top, color, smooth);
                edgeLine(parent, bot, color, smooth);
            }
        }

        function edgeLine(parent, pts, color, smooth) {
            PVX.svg.el('path', {
                d: PVX.svg.line(pts, smooth), fill: 'none', stroke: color,
                'stroke-width': 0.9, 'stroke-opacity': 0.4,
                'vector-effect': 'non-scaling-stroke', 'class': 'pvx-po-envedge'
            }, parent);
        }

        function drawMedian(parent, env, G, P, sx, sy, color, smooth, maxGapSlots) {
            var runs = envelopeRuns(env, G, maxGapSlots);
            for (var r = 0; r < runs.length; r++) {
                var pts = [];
                for (var i = 0; i < runs[r].length; i++) {
                    var idx = runs[r][i];
                    pts.push({ x: sx(((idx + 0.5) / G) * P), y: sy(env[idx].mid) });
                }
                if (pts.length < 2) { continue; }
                PVX.svg.el('path', {
                    d: PVX.svg.line(pts, smooth), fill: 'none', stroke: color,
                    'stroke-width': 1.3, 'stroke-dasharray': '5 3',
                    'vector-effect': 'non-scaling-stroke', 'class': 'pvx-po-median'
                }, parent);
            }
        }

        /** Relative-time labels pull inward at the ends so nothing is clipped. */
        function drawRelLabel(parent, x, y, str, W, font, t) {
            var half = str.length * font * CHAR_W / 2;
            var anchor = 'middle';
            if (x - half < 2) { anchor = 'start'; x = Math.max(2, x - half); }
            else if (x + half > W - 2) { anchor = 'end'; x = Math.min(W - 2, x + half); }
            PVX.svg.text(parent, x.toFixed(2), y.toFixed(2), str, {
                'class': 'pvx-svg-label pvx-num', 'text-anchor': anchor,
                'font-size': font, fill: t.textMuted
            });
        }

        /**
         * Legend.
         *
         * In 'fade' colour mode the older traces differ only by tint and
         * opacity, so listing eight of them individually would be a legend
         * nobody can match to a line — it collapses to "current / older (N) /
         * envelope", which is the truth. In 'palette' mode every period really
         * does have its own hue, so every period gets an entry.
         */
        function drawLegend(parent, cfg, t, plot, font, periods, olderCount,
                            wantEnvelope, wantMedian, envColor, envOp, envMode, lowP, highP, others) {
            var items = [], i;
            var current = cfg.CurrentColor || cfg.AccentColor || '#3b82c4';

            if (cfg.ColorMode === 'palette') {
                for (i = 0; i < periods.length; i++) {
                    items.push({
                        label: periodLabel(periods[i], cfg),
                        color: periodColor(cfg, periods[i].k, olderCount, t),
                        opacity: periodOpacity(cfg, periods[i].k, olderCount)
                    });
                }
            } else {
                items.push({ label: periodLabel(periods[0], cfg), color: current, opacity: 1 });
                if (olderCount > 0) {
                    items.push({
                        label: 'older (' + olderCount + ')',
                        color: periodColor(cfg, 1, olderCount, t),
                        opacity: 0.7
                    });
                }
            }
            if (wantEnvelope) {
                items.push({ label: envLabel(envMode, lowP, highP), color: envColor, band: true });
            }
            if (wantMedian) {
                items.push({ label: 'median', color: envColor, dashed: true });
            }
            // With several tags the first one's entries need its name, or
            // "current" could be anyone's.
            if (others && others.length) {
                items[0].label = (model.series.label || 'source 1') + ', ' + items[0].label;
                for (i = 0; i < others.length; i++) {
                    items.push({ label: others[i].series.label || 'source ' + (i + 2), color: others[i].color, opacity: 1 });
                }
            }

            var y = Math.max(font * 0.8, plot.y - font * 0.9);
            var sw = font * 1.1;
            var x = plot.x;
            var right = plot.x1;
            var shown = 0;

            for (i = 0; i < items.length; i++) {
                var text = fitText(items[i].label, Math.min(110, right - x - sw - 18), font);
                if (!text) { break; }
                var w = sw + 4 + text.length * font * CHAR_W + 10;
                if (x + w > right && shown > 0) { break; }
                keyMark(parent, x, y, sw, text, items[i], font, t);
                x += w;
                shown++;
            }
            // Never let the legend imply it listed everything when it did not.
            if (shown < items.length) {
                PVX.svg.text(parent, Math.min(x, right - font * 1.6).toFixed(2), y.toFixed(2),
                    '+' + (items.length - shown), {
                        'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted
                    });
            }
        }

        /* Short on purpose — the legend row has to survive a 200px symbol, and
         * "envelope min/max of the older periods" would push every other key
         * off the row for information the config pane already carries. */
        function envLabel(mode, lowP, highP) {
            if (mode === 'stddev') { return 'mean ±1σ'; }
            if (mode === 'percentile') {
                return 'P' + Math.round(lowP * 100) + '–P' + Math.round(highP * 100);
            }
            return 'envelope';
        }

        function keyMark(parent, x, y, sw, text, item, font, t) {
            if (item.band) {
                PVX.svg.el('rect', {
                    x: x.toFixed(2), y: (y - font * 0.38).toFixed(2),
                    width: sw.toFixed(2), height: (font * 0.76).toFixed(2),
                    fill: item.color, 'fill-opacity': 0.35,
                    stroke: item.color, 'stroke-width': 0.8, 'stroke-opacity': 0.6,
                    'class': 'pvx-po-key'
                }, parent);
            } else {
                PVX.svg.el('line', {
                    x1: x.toFixed(2), y1: y.toFixed(2),
                    x2: (x + sw).toFixed(2), y2: y.toFixed(2),
                    stroke: item.color, 'stroke-width': 2.4, 'stroke-linecap': 'round',
                    'stroke-dasharray': item.dashed ? '4 3' : null,
                    opacity: item.opacity === undefined ? null : item.opacity.toFixed(2),
                    'class': 'pvx-po-key'
                }, parent);
            }
            PVX.svg.text(parent, (x + sw + 4).toFixed(2), y.toFixed(2), text, {
                'class': 'pvx-svg-label pvx-po-legend-text',
                'font-size': font, fill: t.textMuted
            });
        }

        /**
         * True rendered width of a text node.
         *
         * Everywhere else text is sized from the CHAR_W average, because those
         * decisions happen once per sample and getComputedTextLength() flushes
         * layout on every call. The stats card is laid out ONCE per render, so
         * it can afford the truth — and it needs the truth, because "about
         * right" is the difference between a card that contains its own text and
         * one that does not.
         */
        function textWidth(node, font) {
            if (node && node.getComputedTextLength) {
                try { return node.getComputedTextLength(); } catch (e) { /* not laid out */ }
            }
            return String(node ? node.textContent : '').length * font * CHAR_W;
        }

        function detach(node) {
            if (node && node.parentNode) { node.parentNode.removeChild(node); }
        }

        /**
         * The corner card: the current period measured against the envelope.
         *
         * "In envelope" is the headline because it is the one number that
         * answers "is today running like the good days"; the largest departure
         * and where it happened is what turns that answer into an action.
         *
         * Laid out by measurement, not estimate: rows are created, measured, and
         * only then is the box sized around them. Sizing against typical content
         * is how a panel that fits at three periods spills its text at eight.
         */
        function drawStats(parent, cmp, cfg, t, plot, font, units, curBuckets, sy, P) {
            var padX = 6, padY = 4, gap = 10;
            var lineH = font * 1.4;
            var keyFont = font * 0.9;
            var maxW = Math.min(plot.w - 8, plot.w * 0.6);
            var maxH = Math.min(plot.h - 8, plot.h * 0.62);
            var i, L;

            var status = t.text;
            if (cmp.pct !== null) {
                if (cmp.pct < 70) { status = PVX.color.status.alarm; }
                else if (cmp.pct < 90) { status = PVX.color.status.warning; }
                else { status = PVX.color.status.normal; }
            }

            var numOpts = PVX.config.numberOpts(cfg);
            var lines = [];
            lines.push({
                p: 0, k: 'In envelope', fs: font, bold: true,
                v: cmp.pct === null ? '--' : PVX.fmt.percent(cmp.pct, 0),
                c: status
            });
            if (cmp.dep > 0) {
                var depTxt = (cmp.depSign > 0 ? '+' : '-') + PVX.fmt.number(cmp.dep, numOpts) +
                    (units ? ' ' + units : '');
                lines.push({
                    p: 1, k: 'Max departure', fs: font,
                    // Where it happened is what makes the number actionable, but
                    // it is the first thing dropped when the row will not fit.
                    v: depTxt + '  ' + axisLabel(cmp.depRel === null ? 0 : cmp.depRel, cfg),
                    vShort: depTxt,
                    c: cmp.depSign > 0 ? PVX.color.status.alarm : PVX.color.status.warning
                });
            } else {
                lines.push({ p: 1, k: 'Max departure', fs: font, v: 'none', c: t.textMuted });
            }
            lines.push({
                p: 2, k: 'Compared', fs: font,
                v: (model.periods.length - 1) + ' past × ' + periodName(P),
                c: t.textMuted
            });

            // Height depends only on the row count, so shed by priority first
            // and measure the survivors.
            while (lines.length > 1 && lines.length * lineH + padY * 2 > maxH) {
                var worst = 0;
                for (i = 1; i < lines.length; i++) {
                    if (lines[i].p > lines[worst].p) { worst = i; }
                }
                lines.splice(worst, 1);
            }
            var boxH = lines.length * lineH + padY * 2;
            if (boxH > maxH) { return; }

            var g = PVX.svg.el('g', { 'class': 'pvx-po-stats-g' }, parent);
            for (i = 0; i < lines.length; i++) {
                L = lines[i];
                L.keyNode = PVX.svg.text(g, 0, 0, L.k, {
                    'class': 'pvx-svg-label', 'font-size': keyFont.toFixed(1), fill: t.textMuted
                });
                L.valNode = PVX.svg.text(g, 0, 0, L.v, {
                    'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end',
                    'font-size': L.fs.toFixed(1),
                    'font-weight': L.bold ? '700' : '400',
                    fill: L.c
                });
                L.keyW = textWidth(L.keyNode, keyFont);
            }

            var room = maxW - padX * 2;
            var contentW = 0;
            for (i = 0; i < lines.length; i++) {
                L = lines[i];
                L.valW = textWidth(L.valNode, L.fs);
                if (L.vShort && L.keyW + gap + L.valW > room) {
                    L.valNode.textContent = L.vShort;
                    L.valW = textWidth(L.valNode, L.fs);
                }
                /* A truncated number is a WRONG number — "2…" could be 2.5 or
                 * 25, and nobody can tell which. Rows are atomic: one that will
                 * not fit whole is dropped rather than ellipsised. */
                L.drop = (L.keyW + gap + L.valW > room);
                if (!L.drop) { contentW = Math.max(contentW, L.keyW + gap + L.valW); }
            }
            if (lines[0].drop) { parent.removeChild(g); return; }

            var kept = [];
            for (i = 0; i < lines.length; i++) {
                if (lines[i].drop) { detach(lines[i].keyNode); detach(lines[i].valNode); }
                else { kept.push(lines[i]); }
            }
            lines = kept;
            boxH = lines.length * lineH + padY * 2;
            var boxW = Math.min(maxW, contentW + padX * 2);
            if (boxW < 54) { parent.removeChild(g); return; }

            /* Park it where the current trace is not. The current period is the
             * one line the user is reading, so the card avoids ITS half of the
             * plot rather than the busiest quadrant overall — the older traces
             * and the envelope can afford to be covered. */
            var above = 0, below = 0;
            for (i = 0; i < curBuckets.length; i++) {
                if (!curBuckets[i]) { continue; }
                var y = sy(curBuckets[i].mean);
                if (y < plot.y + plot.h / 2) { above += 1; } else { below += 1; }
            }
            var top = above <= below;
            /* Horizontally: with clock alignment the current period is still in
             * progress, so its trace stops part way across and the right-hand
             * side of the plot is genuinely empty — park there. Only when the
             * current trace runs the full width does the side stop mattering,
             * and then the vertical choice above is doing the real work. */
            var lastIdx = -1;
            for (i = 0; i < curBuckets.length; i++) { if (curBuckets[i]) { lastIdx = i; } }
            var left = (lastIdx >= curBuckets.length * 0.85) && (above > below);
            var bx = left ? plot.x + 4 : plot.x + plot.w - boxW - 4;
            var by = top ? plot.y + 4 : plot.y + plot.h - boxH - 4;

            // A transparent symbol has no surface colour to borrow, so fall back
            // to a scrim that keeps the text legible over the traces.
            var fill = (t.surface && t.surface !== 'transparent')
                ? PVX.color.rgba(t.surface, 0.88)
                : (t.dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.8)');

            var card = PVX.svg.el('path', {
                d: PVX.svg.roundRect(bx, by, boxW, boxH, 3),
                fill: fill, stroke: status, 'stroke-width': 1, 'class': 'pvx-po-stats'
            });
            g.insertBefore(card, g.firstChild);

            for (i = 0; i < lines.length; i++) {
                L = lines[i];
                var cy = by + padY + lineH * (i + 0.5);
                L.keyNode.setAttribute('x', (bx + padX).toFixed(2));
                L.keyNode.setAttribute('y', cy.toFixed(2));
                L.valNode.setAttribute('x', (bx + boxW - padX).toFixed(2));
                L.valNode.setAttribute('y', cy.toFixed(2));
            }
        }

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);
            PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2),
                fitText(headline, W - 8, font), {
                    'class': 'pvx-svg-label', 'text-anchor': 'middle',
                    'font-size': font, 'font-weight': '600', fill: t.textMuted
                });
            if (H >= 60) {
                PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.8).toFixed(2),
                    fitText(detail, W - 8, font * 0.9), {
                        'class': 'pvx-svg-label', 'text-anchor': 'middle',
                        'font-size': (font * 0.9).toFixed(1), fill: t.textMuted, opacity: '0.8'
                    });
            }
        }

        /* ================================================================== *
         * bindings
         * ================================================================== */

        function titleText(cfg) {
            if (cfg.Title) { return cfg.Title; }
            if (!model.series) { return 'Period comparison'; }
            return (model.series.label || 'Value') + ' — period comparison';
        }

        /** The caption states the fold, because the fold is the whole symbol. */
        function periodCaption(full) {
            var align = (model.align === 'windowEnd') ? 'from window end' : 'clock aligned';
            if (!full) { return periodName(model.P) + ' · ' + align; }
            var head = periodName(model.P) + ' periods';
            if (model.autoKind) { head += ' (auto)'; }
            return head + ' · ' + align + ' · ' + model.periods.length;
        }

        /** Theme tokens as CSS custom properties for the template and styles.css. */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', t.surface);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
        }

        /* Renders run inside requestAnimationFrame, outside Angular's digest,
         * and this symbol writes its title/caption/footer through bindings. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
