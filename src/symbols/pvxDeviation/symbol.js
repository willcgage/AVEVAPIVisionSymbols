/* ============================================================================
 * pvxDeviation — "PVX Deviation from Target" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources)
 *
 * A normal trend answers "what was the value". A control engineer is almost
 * never asking that — they are asking "how far off target was it, and how much
 * of the shift was it where it should be". On a stock trend a 2% offset is a
 * hair's width inside an axis that spans the whole operating range, so it looks
 * like nothing. Here the target is the origin: zero sits in the middle, the
 * tolerance band is drawn, and the offset is the subject of the picture.
 *
 * Two ways to say what the target IS:
 *   TargetMode 'fixed'  — one constant (config.TargetValue) for every series.
 *   TargetMode 'series' — one data source is the setpoint (TargetSource, the
 *                         LAST source when left automatic) and the others are
 *                         process values measured against it, or just the one
 *                         chosen as ValueSource. Picking them by name in the
 *                         pane beats relying on the order they were dropped
 *                         in, which is invisible on the display. PI stores PV
 *                         and SP on their own timestamps, so
 *                         they are paired by a forward two-pointer walk taking
 *                         the last setpoint at or before each PV sample
 *                         (last-known-value, which is what a setpoint actually
 *                         does between writes).
 *
 * Everything in `.pvx-dev-body` is one imperative SVG. Only the header title,
 * the footer notes and the bad-quality badge are Angular bindings.
 *
 * @mock numeric
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Mean advance width of the UI font, in ems. Used for every text-fitting
     * decision instead of getComputedTextLength(), which flushes layout on
     * every call and turns a re-render into a layout-thrash stall. */
    var CHAR_W = 0.58;

    /* A bar narrower than this reads as a tick mark, not a bar. */
    var MIN_BAR_PX = 2.2;

    /* Identity palette for multi-trace displays. Deliberately a COOL/NEUTRAL
     * subset of the shared categorical palette: red, orange and green are
     * reserved here for "above tolerance", "below tolerance" and the tolerance
     * band itself, so a trace tinted with any of them could be mistaken for a
     * status. Six entries, matching the default MaxSeries. */
    var IDENTITY = ['#3b82c4', '#8267b0', '#3fa3ad', '#c377a8', '#6f7378', '#7a6355'];

    var definition = {
        typeName: 'pvxDeviation',
        displayName: 'PVX Deviation from Target',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format Deviation from Target',
        sourceRemap: { TargetSource: 'indexAuto', ValueSource: 'indexAuto' },

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 400,
                Height: 240,
                Width: 360,

                // Target
                TargetMode: 'fixed',            // fixed | series
                TargetValue: 100,
                TargetSource: '0',              // series: 1-based setpoint source, 0 = the last
                ValueSource: '0',               // 1-based process value, 0 = every other source
                DeviationMode: 'percent',       // percent | absolute
                Mode: 'band',                   // band | bars | trend

                // Tolerance — units follow DeviationMode
                ToleranceMode: 'symmetric',     // symmetric | asymmetric
                Tolerance: 2,
                ToleranceLow: '',
                ToleranceHigh: '',

                // Color
                BandColor: '#2f9e5f',
                BandOpacity: 0.12,
                InBandColor: '#3b82c4',
                HighColor: '#c8452f',
                LowColor: '#d99024',

                // Trace
                ShowZeroLine: true,
                SmoothLine: false,
                LineWidth: 1.8,
                FillDeviation: true,
                FillOpacity: 0.22,

                // Stats panel
                ShowStats: true,
                StatsWarnBelow: 95,

                // Axes
                ShowGrid: true,
                TickCount: 5,
                TimeTickCount: 5,
                ScaleMode: 'auto',              // auto | fixed | symmetric
                ScaleMax: '',

                // Chrome
                MaxSeries: 6,
                ShowLegend: true,
                ShowCurrentValue: true,
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Template bindings — everything else is drawn into the SVG.
        scope.pvx = { title: '', target: '', note: '', error: '' };

        /* Derived once per data update (and per config change, because the
         * target source and the deviation units change what the numbers ARE,
         * not merely how they are drawn). Reused across resize renders. */
        var model = {
            raw: [],            // every series exactly as delivered
            sp: null,           // the setpoint series, when TargetMode = 'series'
            series: [],         // prepared process-value series
            hidden: 0,          // series dropped by MaxSeries
            unpaired: 0,        // PV samples with no setpoint in force
            fallback: [],       // labels forced from percent to absolute
            needSetpoint: false // series mode, but only one data source
        };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-dev-body',

            onData: function (d) {
                model.raw = PVX.data.series(d) || [];
                rebuild(ctx.config || scope.config || {});
            },

            onConfigChange: function (newCfg) { rebuild(newCfg || {}); },

            render: render
        });

        /* ================================================================== *
         * model
         * ================================================================== */

        function rebuild(cfg) {
            var i;
            model.series = [];
            model.hidden = 0;
            model.unpaired = 0;
            model.fallback = [];
            model.sp = null;
            model.needSetpoint = false;
            model.picks = [];

            var all = model.raw || [];
            var pvList = all;
            var seriesTarget = (cfg.TargetMode === 'series');
            var spIdx = -1;

            if (seriesTarget) {
                if (all.length < 2) {
                    model.needSetpoint = true;
                    return;
                }
                // Automatic is the LAST source: users drop the process values
                // first and add the setpoint once, so "last" survives adding
                // another PV in a way that "first" would not.
                spIdx = all.length - 1;
                var want = parseInt(cfg.TargetSource, 10) || 0;
                if (want >= 1 && want <= all.length) { spIdx = want - 1; }
                else if (want > all.length) {
                    model.picks.push('setpoint source ' + want + ' does not exist; using the last');
                }
                model.sp = all[spIdx];
                pvList = [];
                for (i = 0; i < all.length; i++) { if (i !== spIdx) { pvList.push(all[i]); } }
            }

            var pvWant = parseInt(cfg.ValueSource, 10) || 0;
            if (pvWant >= 1 && pvWant <= all.length && pvWant - 1 !== spIdx) {
                pvList = [all[pvWant - 1]];
            } else if (pvWant >= 1) {
                model.picks.push(pvWant - 1 === spIdx
                    ? 'value source is the setpoint; showing every other source'
                    : 'value source ' + pvWant + ' does not exist; showing every source');
            }

            // Past a handful of traces the excursions overlap into a single
            // colored mush; keep the first N and confess in the footer rather
            // than drawing something unreadable.
            var cap = PVX.util.clamp(parseInt(cfg.MaxSeries, 10) || 6, 1, 12);
            if (pvList.length > cap) {
                model.hidden = pvList.length - cap;
                pvList = pvList.slice(0, cap);
            }

            var wantPercent = (cfg.DeviationMode !== 'absolute');
            var fixedTarget = PVX.util.num(cfg.TargetValue);
            if (fixedTarget === null) { fixedTarget = 0; }

            for (i = 0; i < pvList.length; i++) {
                model.series.push(buildSeries(
                    pvList[i], seriesTarget ? model.sp : null, fixedTarget, wantPercent));
            }
        }

        /** One process-value series turned into a deviation trace. */
        function buildSeries(pv, spSeries, fixedTarget, wantPercent) {
            var pts = pv.points || [];
            var paired = spSeries
                ? pairWithSetpoint(pts, spSeries.points || [])
                : constantPairs(pts, fixedTarget);
            model.unpaired += paired.dropped;

            /* Percentage deviation from a zero or negative target is undefined —
             * the divisor vanishes, and through zero the sign of the answer
             * inverts. A series whose target ever reaches zero is therefore
             * reported in engineering units instead, and said so in the footer.
             * Silently dividing would put a meaningless number in front of an
             * operator, which is worse than admitting the unit changed. */
            var percent = wantPercent;
            var k;
            if (percent) {
                for (k = 0; k < paired.pairs.length; k++) {
                    if (!(paired.pairs[k].sp > 0)) { percent = false; break; }
                }
            }
            if (wantPercent && !percent && paired.pairs.length) {
                model.fallback.push(pv.label || 'series');
            }

            var dev = [];
            for (k = 0; k < paired.pairs.length; k++) {
                var p = paired.pairs[k];
                dev.push({
                    t: p.t,
                    v: percent ? ((p.pv - p.sp) / p.sp) * 100 : (p.pv - p.sp),
                    pv: p.pv,
                    sp: p.sp
                });
            }

            return {
                label: pv.label || '',
                units: pv.units || '',
                path: pv.path || '',
                good: pv.good !== false,
                errorDescription: pv.errorDescription || '',
                percent: percent,
                dev: dev
            };
        }

        /**
         * Pair each process value with the setpoint in force at that instant.
         *
         * PI is a compressed historian: PV and SP are stored on their own
         * timestamps and PI Vision returns each on its own grid, so the arrays
         * almost never line up. `i` only ever walks FORWARD to the last setpoint
         * at or before the PV sample, which makes the whole merge O(n + m)
         * instead of the O(n * m) a nested scan would cost on the 400-point
         * payloads this symbol asks for.
         */
        function pairWithSetpoint(pvPts, spPts) {
            var pairs = [], dropped = 0;
            if (!pvPts.length || !spPts.length) {
                return { pairs: pairs, dropped: pvPts.length };
            }
            var i = 0;
            for (var j = 0; j < pvPts.length; j++) {
                var t = pvPts[j].t;
                while (i + 1 < spPts.length && spPts[i + 1].t <= t) { i++; }
                // A PV sample older than the very first setpoint has no
                // last-known value at all — there is nothing to measure it
                // against, so it is dropped rather than guessed at.
                if (spPts[i].t > t) { dropped++; continue; }
                pairs.push({ t: t, pv: pvPts[j].v, sp: spPts[i].v });
            }
            return { pairs: pairs, dropped: dropped };
        }

        function constantPairs(pvPts, target) {
            var pairs = [];
            for (var i = 0; i < pvPts.length; i++) {
                pairs.push({ t: pvPts[i].t, pv: pvPts[i].v, sp: target });
            }
            return { pairs: pairs, dropped: 0 };
        }

        /* ================================================================== *
         * tolerance and zones
         * ================================================================== */

        function toleranceFor(cfg) {
            var base = PVX.util.num(cfg.Tolerance);
            base = (base === null) ? 2 : Math.abs(base);
            if (cfg.ToleranceMode === 'asymmetric') {
                var lo = PVX.util.num(cfg.ToleranceLow);
                var hi = PVX.util.num(cfg.ToleranceHigh);
                /* Both are read as MAGNITUDES: a low limit typed as "1" means one
                 * unit below target. Taking the sign literally would let a stray
                 * minus flip the band inside out and mark a healthy loop as
                 * permanently out of spec. Blank falls back to Tolerance. */
                return {
                    lo: -(lo === null ? base : Math.abs(lo)),
                    hi: (hi === null ? base : Math.abs(hi))
                };
            }
            return { lo: -base, hi: base };
        }

        /** -1 below tolerance, 0 in band, +1 above. Exactly on a limit is in. */
        function zoneOf(v, tol) {
            if (v > tol.hi) { return 1; }
            if (v < tol.lo) { return -1; }
            return 0;
        }

        /**
         * Split a deviation trace into contiguous runs of one zone, inserting
         * the exact tolerance crossing between runs.
         *
         * Coloring whole samples would move every color change to the NEXT
         * sample — minutes late on a compressed tag — so the trace would appear
         * to change color somewhere inside the band, and the band would look
         * like it was drawn in the wrong place. Splitting at the interpolated
         * crossing lands the color change exactly on the limit, and hands the
         * duration arithmetic the same edges the eye sees.
         */
        function segmentize(pts, tol) {
            var segs = [];
            if (!pts.length) { return segs; }
            var bounds = [tol.lo, tol.hi];
            var cur = { zone: zoneOf(pts[0].v, tol), pts: [pts[0]] };

            for (var i = 1; i < pts.length; i++) {
                var a = pts[i - 1], b = pts[i];
                if (zoneOf(a.v, tol) !== zoneOf(b.v, tol) && b.v !== a.v) {
                    var cross = [];
                    for (var k = 0; k < bounds.length; k++) {
                        var bnd = bounds[k];
                        if ((a.v < bnd && b.v > bnd) || (a.v > bnd && b.v < bnd)) {
                            cross.push({ u: (bnd - a.v) / (b.v - a.v), v: bnd });
                        }
                    }
                    cross.sort(function (p, q) { return p.u - q.u; });

                    for (var c = 0; c < cross.length; c++) {
                        var u = cross[c].u;
                        var pt = interpAt(a, b, u, cross[c].v);
                        cur.pts.push(pt);
                        segs.push(cur);
                        // Zone of the piece that follows: sample the midpoint
                        // between this crossing and the next (or b), which stays
                        // unambiguous when one span clips both limits.
                        var nextU = (c + 1 < cross.length) ? cross[c + 1].u : 1;
                        var midV = a.v + (b.v - a.v) * ((u + nextU) / 2);
                        cur = { zone: zoneOf(midV, tol), pts: [pt] };
                    }
                }
                cur.pts.push(b);
            }
            segs.push(cur);
            return segs;
        }

        /** Crossing point — pv and sp interpolate too, so 'trend' mode can use it. */
        function interpAt(a, b, u, v) {
            return {
                t: a.t + (b.t - a.t) * u,
                v: v,
                pv: a.pv + (b.pv - a.pv) * u,
                sp: a.sp + (b.sp - a.sp) * u,
                crossing: true
            };
        }

        /* ================================================================== *
         * statistics
         * ================================================================== *
         * Everything below is weighted by the SPAN BETWEEN SAMPLES, never by
         * the sample count. PI stores on compression, so samples cluster where
         * the signal is busy — counting samples would report a two-minute trip
         * that generated fifty events as a bigger share of the window than a
         * two-hour drift that generated three.
         */

        function statsFor(segs, pts) {
            var s = {
                span: 0, inBand: 0, pct: null, mean: null,
                excursions: 0, longest: 0,
                maxAbs: null, maxValue: null, maxTime: null
            };
            var i, k;

            for (i = 0; i < segs.length; i++) {
                var sp = segs[i].pts;
                var dur = sp[sp.length - 1].t - sp[0].t;
                if (!(dur > 0)) { dur = 0; }
                s.span += dur;
                if (segs[i].zone === 0) { s.inBand += dur; }
            }
            if (s.span > 0) { s.pct = (s.inBand / s.span) * 100; }

            /* An excursion is a contiguous RUN outside tolerance, not a sample.
             * One long trip that produced two hundred stored values is one
             * event, and an operator counting "how many times did we lose it"
             * means events. A run ends only when the trace comes back inside. */
            var runStart = null, runEnd = 0;
            for (i = 0; i < segs.length; i++) {
                if (segs[i].zone !== 0) {
                    if (runStart === null) { runStart = segs[i].pts[0].t; }
                    runEnd = segs[i].pts[segs[i].pts.length - 1].t;
                } else if (runStart !== null) {
                    s.excursions += 1;
                    if (runEnd - runStart > s.longest) { s.longest = runEnd - runStart; }
                    runStart = null;
                }
            }
            if (runStart !== null) {
                s.excursions += 1;
                if (runEnd - runStart > s.longest) { s.longest = runEnd - runStart; }
            }

            // Trapezoidal time average: the mean of a signal is the area under
            // it divided by the elapsed time, not the mean of its rows.
            var area = 0;
            for (k = 1; k < pts.length; k++) {
                area += ((pts[k].v + pts[k - 1].v) / 2) * (pts[k].t - pts[k - 1].t);
            }
            if (s.span > 0) { s.mean = area / s.span; }
            else if (pts.length) { s.mean = pts[0].v; }

            for (k = 0; k < pts.length; k++) {
                var a = Math.abs(pts[k].v);
                if (s.maxAbs === null || a > s.maxAbs) {
                    s.maxAbs = a; s.maxValue = pts[k].v; s.maxTime = pts[k].t;
                }
            }
            return s;
        }

        /** Roll several traces into one headline. */
        function aggregate(rows) {
            var out = {
                span: 0, inBand: 0, pct: null, mean: null,
                excursions: 0, longest: 0,
                maxAbs: null, maxValue: null, maxTime: null, maxLabel: '',
                multi: rows.length > 1
            };
            var area = 0, weight = 0;
            for (var i = 0; i < rows.length; i++) {
                var st = rows[i].stats;
                out.span += st.span;
                out.inBand += st.inBand;
                out.excursions += st.excursions;
                if (st.longest > out.longest) { out.longest = st.longest; }
                if (st.mean !== null) {
                    // Weight by elapsed time so a short trace cannot outvote a
                    // long one; a zero-span trace still counts once.
                    var w = st.span > 0 ? st.span : 1;
                    area += st.mean * w;
                    weight += w;
                }
                if (st.maxAbs !== null && (out.maxAbs === null || st.maxAbs > out.maxAbs)) {
                    out.maxAbs = st.maxAbs;
                    out.maxValue = st.maxValue;
                    out.maxTime = st.maxTime;
                    out.maxLabel = rows[i].label;
                }
            }
            if (out.span > 0) { out.pct = (out.inBand / out.span) * 100; }
            if (weight > 0) { out.mean = area / weight; }
            return out;
        }

        /* ================================================================== *
         * decimation
         * ================================================================== */

        /**
         * Min/max-preserving bucket decimation, one bucket per two pixels.
         *
         * Plain stride sampling would drop the spikes — and on this symbol the
         * spikes ARE the excursions, the only thing anybody is looking for.
         * Each bucket contributes its minimum AND its maximum in time order, so
         * the trace keeps its true vertical extent (and therefore its true
         * crossings of the tolerance limits).
         */
        function decimate(pts, buckets) {
            var n = pts.length;
            if (buckets < 2 || n <= buckets * 2) { return pts; }
            var out = [];
            var push = function (p) { if (out[out.length - 1] !== p) { out.push(p); } };
            var size = n / buckets;
            push(pts[0]);
            for (var b = 0; b < buckets; b++) {
                var s = Math.floor(b * size);
                var e = Math.min(n, Math.floor((b + 1) * size));
                if (e <= s) { continue; }
                var lo = s, hi = s;
                for (var i = s + 1; i < e; i++) {
                    if (pts[i].v < pts[lo].v) { lo = i; }
                    if (pts[i].v > pts[hi].v) { hi = i; }
                }
                var first = Math.min(lo, hi), last = Math.max(lo, hi);
                push(pts[first]);
                if (last !== first) { push(pts[last]); }
            }
            push(pts[n - 1]);
            return out;
        }

        /**
         * Bars share ONE slot grid across every series, so grouped bars line up
         * in time instead of drifting apart. Each slot keeps its most extreme
         * deviation: averaging the bucket would erase exactly the spike the
         * chart exists to show.
         */
        function bucketBars(pts, tMin, tMax, slots) {
            var out = [], i;
            for (i = 0; i < slots; i++) { out.push(null); }
            var span = (tMax - tMin) || 1;
            for (i = 0; i < pts.length; i++) {
                var idx = PVX.util.clamp(Math.floor(((pts[i].t - tMin) / span) * slots), 0, slots - 1);
                if (out[idx] === null || Math.abs(pts[i].v) > Math.abs(out[idx].v)) {
                    out[idx] = pts[i];
                }
            }
            return out;
        }

        /* ================================================================== *
         * text helpers
         * ================================================================== */

        function fitText(str, maxW, fontPx) {
            var s = String(str === null || str === undefined ? '' : str);
            var m = Math.floor(maxW / (fontPx * CHAR_W));
            if (m < 1) { return ''; }
            if (s.length <= m) { return s; }
            if (m === 1) { return '…'; }
            return s.slice(0, m - 1) + '…';
        }

        /** The unit shown after a deviation number. */
        function devUnit(cfg, list) {
            // With nothing on the symbol yet the caption still has to be honest
            // about the units the tolerance is expressed in, so fall back to the
            // configured mode rather than silently dropping the suffix.
            if (!list.length) { return (cfg.DeviationMode !== 'absolute') ? '%' : ''; }
            var anyPercent = false, allPercent = true;
            var units = null, mixed = false;
            for (var i = 0; i < list.length; i++) {
                if (list[i].percent) { anyPercent = true; } else { allPercent = false; }
                if (units === null) { units = list[i].units; }
                else if (units !== list[i].units) { mixed = true; }
            }
            if (allPercent) { return '%'; }
            // A mix of percent and engineering units has no single suffix that
            // is true for the whole axis, so the axis carries none and the
            // footer says which series changed units.
            if (anyPercent || mixed || !units) { return ''; }
            return units;
        }

        /** Signed deviation, because "-1.2" and "1.2" are different problems. */
        function devText(v, cfg, unit) {
            var n = PVX.util.num(v);
            if (n === null) { return '--'; }
            var s = PVX.fmt.number(n, { decimals: cfg.Decimals, compact: !!cfg.CompactNumbers });
            if (n > 0) { s = '+' + s; }
            return s + (unit || '');
        }

        function tickText(v, unit) {
            var s = PVX.fmt.tick(v);
            if (v > 0) { s = '+' + s; }
            return s + (unit || '');
        }

        /* ================================================================== *
         * color
         * ================================================================== */

        /**
         * In-band color for one trace.
         *
         * With a single trace this is the configured InBandColor. With several
         * it is the categorical palette instead: six identically blue traces
         * cannot be told apart and the legend would mean nothing. Out-of-band
         * segments always take HighColor / LowColor whatever the count — while
         * a loop is off spec, WHICH tag it is matters less than which way it
         * went, and hot and cold are different problems.
         */
        function inBandColor(cfg, index, count) {
            if (count <= 1) { return cfg.InBandColor || '#3b82c4'; }
            return IDENTITY[index % IDENTITY.length];
        }

        function zoneColor(cfg, zone, index, count) {
            if (zone > 0) { return cfg.HighColor || PVX.color.status.alarm; }
            if (zone < 0) { return cfg.LowColor || PVX.color.status.warning; }
            return inBandColor(cfg, index, count);
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

            /* The header and footer are HTML outside the SVG, so they must be
             * measured against the WHOLE symbol — measuring them against the
             * plot host would make suppressing the footer grow the host, which
             * un-suppresses it, which shrinks it again. */
            var rootW = (c.node && c.node.clientWidth) || W;
            var rootH = (c.node && c.node.clientHeight) || H;

            var svgRoot = host.querySelector('svg.pvx-dev-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-dev-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var tol = toleranceFor(cfg);
            var mode = cfg.Mode || 'band';
            var seriesTarget = (cfg.TargetMode === 'series');
            var list = model.series;
            var unit = devUnit(cfg, list);
            var i, k;

            // ---- header / footer bindings ---------------------------------
            scope.pvx.error = '';
            for (i = 0; i < list.length; i++) {
                if (!list[i].good) {
                    scope.pvx.error = list[i].errorDescription ||
                        ('Bad data on ' + (list[i].label || 'a source'));
                    break;
                }
            }
            if (!scope.pvx.error && model.sp && !model.sp.good) {
                scope.pvx.error = model.sp.errorDescription || 'Bad data on the setpoint';
            }

            var showTitle = rootH >= 96 && rootW >= 120;
            scope.pvx.title = showTitle ? titleText(list, seriesTarget) : '';
            scope.pvx.target = (showTitle && rootW >= 210) ? targetText(cfg, tol, unit, seriesTarget) : '';

            // ---- empty states ----------------------------------------------
            if (!model.raw.length) {
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, 'No data sources configured',
                    'Drop the process value onto the symbol.');
                digest();
                return;
            }
            if (model.needSetpoint) {
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, 'Setpoint source required',
                    'Add the setpoint as a second data source.');
                digest();
                return;
            }

            var totalPts = 0;
            for (i = 0; i < list.length; i++) { totalPts += list[i].dev.length; }
            if (!totalPts) {
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t,
                    model.unpaired ? 'No paired samples' : 'No samples in this time range',
                    model.unpaired
                        ? 'The setpoint never covers the process value.'
                        : 'Widen the display time range.');
                digest();
                return;
            }

            /* ---- what the box can afford ---------------------------------
             * Below roughly 200x140 the stats panel and axis titles cost more
             * than they inform; below 140x100 even the tick labels do. Shed
             * chrome from the outside in and keep the trace readable.
             *
             * These two thresholds are measured against the SYMBOL, not the
             * drawing host: the user sizes the symbol, and gating on the host
             * makes the header and footer silently eat 40px of the allowance,
             * so a 280x180 symbol loses its panel over a three-pixel shortfall.
             * The panel then sizes itself from measured content and withdraws
             * on its own if it still will not fit — that is the real guard. */
            var tickFont = PVX.util.clamp(Math.round(Math.min(W, H) / 20), 8, 12);
            var titleFont = PVX.util.clamp(tickFont + 1, 9, 13);
            var showTicks = W >= 140 && H >= 100;
            var showAxisTitle = rootW >= 200 && rootH >= 140;
            var showStats = cfg.ShowStats !== false && rootW >= 200 && rootH >= 140;
            var showLegend = cfg.ShowLegend !== false && showTicks &&
                             (list.length > 1 || mode === 'trend');
            var showChips = cfg.ShowCurrentValue !== false && W >= 220 && H >= 110;

            // ---- time domain ------------------------------------------------
            var tMin = null, tMax = null;
            for (i = 0; i < list.length; i++) {
                var dp = list[i].dev;
                if (!dp.length) { continue; }
                if (tMin === null || dp[0].t < tMin) { tMin = dp[0].t; }
                if (tMax === null || dp[dp.length - 1].t > tMax) { tMax = dp[dp.length - 1].t; }
            }
            if (tMin === null) { tMin = 0; tMax = 1; }
            if (!(tMax > tMin)) { tMax = tMin + 1; }

            // ---- statistics on the FULL traces --------------------------------
            // Never on the decimated ones: the numbers must describe the data,
            // not the drawing.
            var rows = [];
            for (i = 0; i < list.length; i++) {
                var fullSegs = segmentize(list[i].dev, tol);
                rows.push({
                    label: list[i].label,
                    series: list[i],
                    segs: fullSegs,
                    stats: statsFor(fullSegs, list[i].dev)
                });
            }
            var agg = aggregate(rows);

            // ---- value domain --------------------------------------------------
            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 10);
            var domain = (mode === 'trend')
                ? trendDomain(rows, tol, tickCount)
                : deviationDomain(cfg, rows, tol, tickCount);
            var vTicks = PVX.scale.ticks(domain[0], domain[1], tickCount);

            // ---- margins from the actual tick strings ---------------------------
            var axisUnit = (mode === 'trend') ? '' : unit;
            var vLabelW = 0;
            if (showTicks) {
                for (k = 0; k < vTicks.length; k++) {
                    var lbl = (mode === 'trend') ? PVX.fmt.tick(vTicks[k]) : tickText(vTicks[k], axisUnit);
                    vLabelW = Math.max(vLabelW, lbl.length * tickFont * CHAR_W);
                }
            }

            var chipW = 0;
            if (showChips) {
                for (i = 0; i < rows.length; i++) {
                    var lastDev = lastValue(rows[i].series.dev);
                    if (lastDev === null) { continue; }
                    chipW = Math.max(chipW,
                        devText(lastDev, cfg, unit).length * tickFont * CHAR_W + 10);
                }
            }

            var axisTitle = showAxisTitle ? axisTitleText(mode, list, unit) : '';
            var legendH = showLegend ? (tickFont + 7) : 0;

            var mL = 6 + (axisTitle ? titleFont + 3 : 0) + vLabelW + (showTicks ? 5 : 0);
            var mR = 6 + chipW + (showTicks ? 12 : 0);
            var mT = 6 + legendH;
            var mB = 5 + (showTicks ? tickFont + 6 : 2);

            // On a small tile the chrome can swallow the plot; cap every side.
            mL = Math.min(mL, W * 0.45);
            mR = Math.min(mR, W * 0.35);
            mT = Math.min(mT, H * 0.40);
            mB = Math.min(mB, H * 0.40);

            var plot = {
                x: mL, y: mT,
                w: Math.max(10, W - mL - mR),
                h: Math.max(10, H - mT - mB)
            };
            plot.x1 = plot.x + plot.w;
            plot.y1 = plot.y + plot.h;

            var sx = PVX.scale.linear(tMin, tMax, plot.x, plot.x1);
            var sy = PVX.scale.linear(domain[0], domain[1], plot.y1, plot.y); // SVG y grows down

            // ---- grid ------------------------------------------------------------
            var timeTicks = buildTimeTicks(cfg, tMin, tMax, plot.w, tickFont);
            if (cfg.ShowGrid !== false) {
                for (k = 0; k < vTicks.length; k++) {
                    gridLine(svgRoot, plot.x, sy(vTicks[k]), plot.x1, sy(vTicks[k]), t.grid);
                }
                for (k = 0; k < timeTicks.length; k++) {
                    var gx = sx(timeTicks[k]);
                    gridLine(svgRoot, gx, plot.y, gx, plot.y1, t.grid);
                }
            }

            // ---- clip everything data-driven to the plot rect ---------------------
            var clipId = host.getAttribute('data-pvx-clip') || PVX.util.uid('devclip');
            host.setAttribute('data-pvx-clip', clipId);
            var defs = PVX.svg.el('defs', null, svgRoot);
            var clip = PVX.svg.el('clipPath', { id: clipId }, defs);
            PVX.svg.el('rect', {
                x: plot.x.toFixed(2), y: plot.y.toFixed(2),
                width: plot.w.toFixed(2), height: plot.h.toFixed(2)
            }, clip);
            var plotG = PVX.svg.el('g', { 'clip-path': 'url(#' + clipId + ')' }, svgRoot);

            // ---- tolerance band ----------------------------------------------------
            var bandOp = PVX.util.num(cfg.BandOpacity);
            bandOp = (bandOp === null) ? 0.12 : PVX.util.clamp(bandOp, 0, 1);
            var bandCol = cfg.BandColor || PVX.color.status.normal;

            if (mode === 'trend') {
                drawTrendBand(plotG, rows, sx, sy, plot, bandCol, bandOp, tol);
            } else {
                drawFlatBand(plotG, sy, plot, bandCol, bandOp, tol);
            }

            // ---- zero line ---------------------------------------------------------
            /* The visual anchor of the whole symbol: drawn heavier than the grid
             * so the eye lands on "target" first and reads every excursion as a
             * distance from it. In trend mode the anchor is the setpoint trace
             * itself, which drawTrendBand has already drawn. */
            if (cfg.ShowZeroLine !== false && mode !== 'trend' &&
                domain[0] <= 0 && domain[1] >= 0) {
                PVX.svg.el('line', {
                    x1: plot.x.toFixed(2), y1: sy(0).toFixed(2),
                    x2: plot.x1.toFixed(2), y2: sy(0).toFixed(2),
                    stroke: t.axis, 'stroke-width': 1.6,
                    'class': 'pvx-dev-zero'
                }, plotG);
            }

            // ---- traces -------------------------------------------------------------
            var quad = [0, 0, 0, 0];              // TL, TR, BL, BR marker tally
            var midX = plot.x + plot.w / 2, midY = plot.y + plot.h / 2;
            var decimated = false;
            var lineW = PVX.util.clamp(PVX.util.num(cfg.LineWidth) || 1.8, 0.5, 8);
            var fillOp = PVX.util.num(cfg.FillOpacity);
            fillOp = (fillOp === null) ? 0.22 : PVX.util.clamp(fillOp, 0, 1);
            var smooth = !!cfg.SmoothLine;

            var draw = {
                cfg: cfg, theme: t, plot: plot, sx: sx, sy: sy, tol: tol, mode: mode,
                lineW: lineW, fillOp: fillOp, smooth: smooth,
                count: rows.length, quad: quad, midX: midX, midY: midY
            };

            var slots = (mode === 'bars')
                ? Math.max(1, Math.floor(plot.w / (rows.length * MIN_BAR_PX * 1.6)))
                : 0;
            var buckets = Math.max(2, Math.floor(plot.w / 2));

            for (i = 0; i < rows.length; i++) {
                /* Bad quality dims the trace rather than recoloring it: the zone
                 * color still carries meaning, it just should not command
                 * attention while the value itself is untrustworthy. */
                var g = PVX.svg.el('g', {
                    'class': 'pvx-dev-series',
                    opacity: rows[i].series.good ? null : '0.5'
                }, plotG);

                if (mode === 'bars') {
                    // One shared slot grid so grouped bars stay aligned in time.
                    if (rows[i].series.dev.length > slots) { decimated = true; }
                    drawBars(g, bucketBars(rows[i].series.dev, tMin, tMax, slots),
                             i, slots, draw);
                } else {
                    var pts = decimate(rows[i].series.dev, buckets);
                    if (pts.length < rows[i].series.dev.length) { decimated = true; }
                    var segs = segmentize(pts, tol);
                    if (mode === 'trend') { drawTrendTrace(g, segs, i, draw); }
                    else { drawBandTrace(g, segs, i, draw); }
                }
            }

            // ---- axes + labels --------------------------------------------------------
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
                    var vtxt = (mode === 'trend')
                        ? PVX.fmt.tick(vTicks[k])
                        : tickText(vTicks[k], axisUnit);
                    PVX.svg.text(svgRoot, (plot.x - 4).toFixed(2), sy(vTicks[k]).toFixed(2), vtxt, {
                        'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end',
                        'font-size': tickFont, fill: t.textMuted
                    });
                }
                for (k = 0; k < timeTicks.length; k++) {
                    drawTimeLabel(svgRoot, sx(timeTicks[k]), plot.y1 + 4 + tickFont * 0.6,
                        PVX.fmt.time(timeTicks[k], 'short'), W, tickFont, t);
                }
            }

            if (axisTitle) {
                var ax = titleFont * 0.8 + 1;
                PVX.svg.text(svgRoot, ax.toFixed(2), midY.toFixed(2), fitText(axisTitle, plot.h, titleFont), {
                    'class': 'pvx-svg-label pvx-dev-axis-title', 'text-anchor': 'middle',
                    'font-size': titleFont, fill: t.text,
                    transform: 'rotate(-90 ' + ax.toFixed(2) + ' ' + midY.toFixed(2) + ')'
                });
            }

            // ---- legend ------------------------------------------------------------------
            if (showLegend) {
                drawLegend(svgRoot, rows, cfg, t, plot, tickFont, mode, seriesTarget);
            }

            // ---- current-value chips ------------------------------------------------------
            if (showChips && chipW > 0) {
                drawChips(svgRoot, rows, draw, chipW, tickFont, unit);
            }

            // ---- stats panel ---------------------------------------------------------------
            if (showStats) {
                drawStats(svgRoot, agg, cfg, t, plot, quad, tickFont, unit, rows.length);
            }

            // ---- footer notes ----------------------------------------------------------------
            var notes = [];
            for (var pk = 0; pk < (model.picks || []).length; pk++) { notes.push(model.picks[pk]); }
            if (model.hidden) {
                notes.push('showing ' + rows.length + ' of ' + (rows.length + model.hidden) +
                           ' sources (MaxSeries)');
            }
            if (decimated) { notes.push('decimated to fit'); }
            if (model.unpaired) {
                notes.push(model.unpaired + ' sample' + (model.unpaired === 1 ? '' : 's') +
                           ' had no setpoint in force');
            }
            if (model.fallback.length) {
                notes.push(model.fallback.join(', ') +
                           ': target reaches zero, shown in engineering units');
            }
            if (totalPts === 1) { notes.push('single sample — no duration to report'); }
            scope.pvx.note = (rootW >= 240 && rootH >= 150) ? notes.join(' · ') : '';

            digest();
        }

        /* ================================================================== *
         * domains
         * ================================================================== */

        /** Deviation axis. Zero is the anchor, so zero is always inside it. */
        function deviationDomain(cfg, rows, tol, tickCount) {
            var lo = 0, hi = 0, i, k;
            for (i = 0; i < rows.length; i++) {
                var pts = rows[i].series.dev;
                for (k = 0; k < pts.length; k++) {
                    if (pts[k].v < lo) { lo = pts[k].v; }
                    if (pts[k].v > hi) { hi = pts[k].v; }
                }
            }
            // Fold the tolerance limits in, or a band drawn outside the data
            // range would be invisible and the setting would look inert.
            if (tol.lo < lo) { lo = tol.lo; }
            if (tol.hi > hi) { hi = tol.hi; }

            var scaleMode = cfg.ScaleMode || 'auto';
            var explicit = PVX.util.num(cfg.ScaleMax);

            if (scaleMode === 'fixed' && explicit !== null && explicit > 0) {
                return [-explicit, explicit];
            }
            if (scaleMode === 'symmetric') {
                /* Equal extent either side puts zero dead centre. This is usually
                 * what you want: an axis that runs -0.2 to +4 makes a small
                 * offset look like a trend, because the eye reads distance from
                 * the middle of the box, not distance from the line. */
                var m = Math.max(Math.abs(lo), Math.abs(hi)) || 1;
                var nice = PVX.scale.niceDomain(-m, m, tickCount);
                m = Math.max(Math.abs(nice[0]), Math.abs(nice[1]));
                return [-m, m];
            }
            var d = PVX.scale.niceDomain(lo, hi, tickCount);
            if (d[0] > 0) { d[0] = 0; }
            if (d[1] < 0) { d[1] = 0; }
            if (!(d[1] > d[0])) { d[1] = d[0] + 1; }
            return d;
        }

        /** Trend mode plots engineering units, so PV, SP and the band all count. */
        function trendDomain(rows, tol, tickCount) {
            var lo = null, hi = null, i, k;
            var take = function (v) {
                if (!PVX.util.isNum(v)) { return; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            };
            for (i = 0; i < rows.length; i++) {
                var pts = rows[i].series.dev;
                var percent = rows[i].series.percent;
                for (k = 0; k < pts.length; k++) {
                    take(pts[k].pv);
                    take(pts[k].sp);
                    take(bandEdge(pts[k].sp, tol.hi, percent));
                    take(bandEdge(pts[k].sp, tol.lo, percent));
                }
            }
            if (lo === null) { return [0, 1]; }
            var d = PVX.scale.niceDomain(lo, hi, tickCount);
            if (!(d[1] > d[0])) { d[1] = d[0] + 1; }
            return d;
        }

        /** A tolerance limit expressed in the process value's own units. */
        function bandEdge(sp, tolValue, percent) {
            return percent ? sp * (1 + tolValue / 100) : sp + tolValue;
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

        /** Constant-width tolerance band around the zero baseline. */
        function drawFlatBand(parent, sy, plot, color, opacity, tol) {
            if (!(opacity > 0)) { return; }
            var yTop = sy(tol.hi), yBot = sy(tol.lo);
            var y0 = Math.min(yTop, yBot), h = Math.abs(yBot - yTop);
            PVX.svg.el('rect', {
                x: plot.x.toFixed(2), y: y0.toFixed(2),
                width: plot.w.toFixed(2), height: Math.max(0.5, h).toFixed(2),
                fill: color, 'fill-opacity': opacity, 'class': 'pvx-dev-band'
            }, parent);
            // The shading says "region"; the dashed rules say "these exact
            // numbers are the limits".
            limitRule(parent, plot.x, yTop, plot.x1, color);
            limitRule(parent, plot.x, yBot, plot.x1, color);
        }

        function limitRule(parent, x1, y, x2, color) {
            PVX.svg.el('line', {
                x1: x1.toFixed(2), y1: y.toFixed(2), x2: x2.toFixed(2), y2: y.toFixed(2),
                stroke: color, 'stroke-width': 1, 'stroke-opacity': 0.75,
                'stroke-dasharray': '4 3', 'class': 'pvx-dev-limit'
            }, parent);
        }

        /**
         * Trend mode: the band follows the setpoint, so a setpoint ramp shows as
         * a ramping band rather than a fixed corridor the process appears to
         * leave for no reason.
         */
        function drawTrendBand(parent, rows, sx, sy, plot, color, opacity, tol) {
            // The setpoint is the same signal for every trace, so one trace's
            // pairing is enough to draw it once — the first that actually has
            // samples, since an empty tag would otherwise erase the band.
            var pts = [], percent = false, r;
            for (r = 0; r < rows.length; r++) {
                if (rows[r].series.dev.length) {
                    pts = rows[r].series.dev;
                    percent = rows[r].series.percent;
                    break;
                }
            }
            if (!pts.length) { return; }
            var top = [], bot = [], mid = [], i;
            for (i = 0; i < pts.length; i++) {
                var x = sx(pts[i].t);
                top.push({ x: x, y: sy(bandEdge(pts[i].sp, tol.hi, percent)) });
                bot.push({ x: x, y: sy(bandEdge(pts[i].sp, tol.lo, percent)) });
                mid.push({ x: x, y: sy(pts[i].sp) });
            }
            if (opacity > 0) {
                PVX.svg.el('path', {
                    d: ribbonPath(top, bot),
                    fill: color, 'fill-opacity': opacity, 'class': 'pvx-dev-band'
                }, parent);
            }
            PVX.svg.el('path', {
                d: PVX.svg.line(mid, false), fill: 'none',
                stroke: color, 'stroke-width': 1.6, 'stroke-dasharray': '6 4',
                'stroke-linejoin': 'round', 'class': 'pvx-dev-sp'
            }, parent);
        }

        /** Closed path between an upper and a lower polyline. */
        function ribbonPath(top, bottom, smooth) {
            if (!top.length || !bottom.length) { return ''; }
            var rev = [], i;
            for (i = bottom.length - 1; i >= 0; i--) { rev.push(bottom[i]); }
            var back = PVX.svg.line(rev, smooth);
            return PVX.svg.line(top, smooth) + ' L' + back.slice(1) + ' Z';
        }

        /** Band mode: deviation trace around zero, one path per zone segment. */
        function drawBandTrace(parent, segs, index, D) {
            var cfg = D.cfg;
            var zeroY = D.sy(0);
            var fill = cfg.FillDeviation !== false && D.fillOp > 0;
            // Several overlapping fills turn into a single opaque smear, so the
            // fill thins out as traces are added.
            var op = D.fillOp / Math.max(1, D.count);

            for (var s = 0; s < segs.length; s++) {
                var pts = toXY(segs[s].pts, D, 'v');
                if (pts.length < 2) {
                    if (pts.length === 1) { dot(parent, pts[0], zoneColor(cfg, segs[s].zone, index, D.count)); }
                    continue;
                }
                var col = zoneColor(cfg, segs[s].zone, index, D.count);
                if (fill) {
                    PVX.svg.el('path', {
                        d: PVX.svg.area(pts, zeroY, D.smooth),
                        fill: col, 'fill-opacity': op, stroke: 'none',
                        'class': 'pvx-dev-fill'
                    }, parent);
                }
                PVX.svg.el('path', {
                    d: PVX.svg.line(pts, D.smooth), fill: 'none',
                    stroke: col, 'stroke-width': D.lineW,
                    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
                    'vector-effect': 'non-scaling-stroke', 'class': 'pvx-dev-line'
                }, parent);
                tally(pts, D);
            }
        }

        /** Trend mode: PV trace in engineering units, gap to SP shaded. */
        function drawTrendTrace(parent, segs, index, D) {
            var cfg = D.cfg;
            var fill = cfg.FillDeviation !== false && D.fillOp > 0;
            var op = D.fillOp / Math.max(1, D.count);

            for (var s = 0; s < segs.length; s++) {
                var raw = segs[s].pts;
                var pts = toXY(raw, D, 'pv');
                if (pts.length < 2) {
                    if (pts.length === 1) { dot(parent, pts[0], zoneColor(cfg, segs[s].zone, index, D.count)); }
                    continue;
                }
                var col = zoneColor(cfg, segs[s].zone, index, D.count);
                if (fill) {
                    // The shaded gap IS the deviation — that is the whole reason
                    // this mode exists rather than being a plain two-tag trend.
                    PVX.svg.el('path', {
                        d: ribbonPath(pts, toXY(raw, D, 'sp'), D.smooth),
                        fill: col, 'fill-opacity': op, stroke: 'none',
                        'class': 'pvx-dev-fill'
                    }, parent);
                }
                PVX.svg.el('path', {
                    d: PVX.svg.line(pts, D.smooth), fill: 'none',
                    stroke: col, 'stroke-width': D.lineW,
                    'stroke-linejoin': 'round', 'stroke-linecap': 'round',
                    'vector-effect': 'non-scaling-stroke', 'class': 'pvx-dev-line'
                }, parent);
                tally(pts, D);
            }
        }

        /** Bars mode: one mark per slot, from the zero baseline. */
        function drawBars(parent, bucketed, index, slots, D) {
            var cfg = D.cfg;
            var zeroY = D.sy(0);
            var slotW = D.plot.w / slots;
            var groupW = slotW / Math.max(1, D.count);
            var barW = Math.max(0.8, groupW * 0.82);

            for (var i = 0; i < slots; i++) {
                var p = bucketed[i];
                if (!p) { continue; }
                var col = zoneColor(cfg, zoneOf(p.v, D.tol), index, D.count);
                var y = D.sy(p.v);
                var x = D.plot.x + slotW * i + groupW * index + (groupW - barW) / 2;
                var top = Math.min(y, zeroY);
                var h = Math.max(0.8, Math.abs(y - zeroY));
                var bar = PVX.svg.el('rect', {
                    x: x.toFixed(2), y: top.toFixed(2),
                    width: barW.toFixed(2), height: h.toFixed(2),
                    fill: col, 'class': 'pvx-dev-bar'
                }, parent);
                var title = PVX.svg.el('title', null, bar);
                title.textContent = devText(p.v, cfg, '') + '\n' + PVX.fmt.time(p.t, 'datetime');
                D.quad[(y < D.midY ? 0 : 2) + (x < D.midX ? 0 : 1)]++;
            }
        }

        function toXY(pts, D, field) {
            var out = [];
            for (var i = 0; i < pts.length; i++) {
                out.push({ x: D.sx(pts[i].t), y: D.sy(pts[i][field]) });
            }
            return out;
        }

        function dot(parent, p, color) {
            PVX.svg.el('circle', {
                cx: p.x.toFixed(2), cy: p.y.toFixed(2), r: 2.2,
                fill: color, 'class': 'pvx-dev-dot'
            }, parent);
        }

        /** Quadrant occupancy, so the stats panel can park where it hides least. */
        function tally(pts, D) {
            for (var i = 0; i < pts.length; i++) {
                D.quad[(pts[i].y < D.midY ? 0 : 2) + (pts[i].x < D.midX ? 0 : 1)]++;
            }
        }

        /* ================================================================== *
         * chrome
         * ================================================================== */

        /**
         * Evenly spaced time ticks, thinned to whatever the width can carry.
         * "MM/DD HH:MM" is 11 characters and two of them touching is worse than
         * half as many that can be read.
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

        /** Time labels pull inward at the ends so they are never half-clipped. */
        function drawTimeLabel(parent, x, y, str, W, font, t) {
            var half = str.length * font * CHAR_W / 2;
            var anchor = 'middle';
            if (x - half < 2) { anchor = 'start'; x = Math.max(2, x - half); }
            else if (x + half > W - 2) { anchor = 'end'; x = Math.min(W - 2, x + half); }
            PVX.svg.text(parent, x.toFixed(2), y.toFixed(2), str, {
                'class': 'pvx-svg-label pvx-num', 'text-anchor': anchor,
                'font-size': font, fill: t.textMuted
            });
        }

        function drawLegend(parent, rows, cfg, t, plot, font, mode, seriesTarget) {
            var items = [], i;
            for (i = 0; i < rows.length; i++) {
                items.push({
                    label: rows[i].label || ('Series ' + (i + 1)),
                    color: inBandColor(cfg, i, rows.length),
                    dashed: false
                });
            }
            if (mode === 'trend') {
                items.push({
                    label: seriesTarget ? ((model.sp && model.sp.label) || 'Setpoint')
                                        : ('Target ' + PVX.fmt.tick(PVX.util.num(cfg.TargetValue) || 0)),
                    color: cfg.BandColor || PVX.color.status.normal,
                    dashed: true
                });
            }

            /* Traces are recolored by zone, so a legend that showed only the
             * identity colors would be a lie for every out-of-band stretch: a
             * reader seeing an amber trace could not tell whether amber means
             * "pump B" or "below tolerance". The excursion key gets reserved
             * space on the right and is never dropped in favour of one more tag
             * name — but it yields entirely when it would take half the row. */
            var key = [
                { label: 'above tol', color: cfg.HighColor || PVX.color.status.alarm },
                { label: 'below tol', color: cfg.LowColor || PVX.color.status.warning }
            ];

            var y = Math.max(font * 0.8, plot.y - font * 0.9);
            var sw = font * 0.9;
            var right = plot.x + plot.w;
            var keyW = 0;
            for (i = 0; i < key.length; i++) {
                keyW += sw + 4 + key[i].label.length * font * CHAR_W + 10;
            }
            // Only reserve the key when the names still get half the row.
            if (keyW > plot.w * 0.5) { key = []; keyW = 0; }

            var x = plot.x;
            var avail = right - keyW;
            var shown = 0;
            for (i = 0; i < items.length; i++) {
                var text = fitText(items[i].label, Math.min(120, avail - x - sw - 16), font);
                if (!text) { break; }
                var w = sw + 4 + text.length * font * CHAR_W + 10;
                if (x + w > avail && shown > 0) { break; }
                keyMark(parent, x, y, sw,
                    { label: text, color: items[i].color, dashed: items[i].dashed }, font, t);
                x += w;
                shown++;
            }
            // Never let the legend imply it listed everything when it did not.
            if (shown < items.length) {
                PVX.svg.text(parent, Math.min(x, avail - font * 1.6).toFixed(2), y.toFixed(2),
                    '+' + (items.length - shown), {
                        'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted
                    });
            }

            var kx = right - keyW;
            for (i = 0; i < key.length; i++) {
                keyMark(parent, kx, y, sw, key[i], font, t);
                kx += sw + 4 + key[i].label.length * font * CHAR_W + 10;
            }
        }

        function keyMark(parent, x, y, sw, item, font, t) {
            PVX.svg.el('line', {
                x1: x.toFixed(2), y1: y.toFixed(2),
                x2: (x + sw).toFixed(2), y2: y.toFixed(2),
                stroke: item.color, 'stroke-width': 2.4, 'stroke-linecap': 'round',
                'stroke-dasharray': item.dashed ? '4 3' : null,
                'class': 'pvx-dev-key'
            }, parent);
            PVX.svg.text(parent, (x + sw + 4).toFixed(2), y.toFixed(2), item.label, {
                'class': 'pvx-svg-label pvx-dev-legend-text',
                'font-size': font, fill: t.textMuted
            });
        }

        function lastValue(pts) {
            return pts.length ? pts[pts.length - 1].v : null;
        }

        /**
         * Current deviation per trace, parked in the reserved right margin at
         * the height of its own last sample — so the number is attached to the
         * trace it belongs to instead of floating in a corner.
         */
        function drawChips(parent, rows, D, chipW, font, unit) {
            var placed = [], i;
            var h = font + 5;
            for (i = 0; i < rows.length; i++) {
                var pts = rows[i].series.dev;
                if (!pts.length) { continue; }
                var last = pts[pts.length - 1];
                var v = last.v;
                var zone = zoneOf(v, D.tol);
                // The chip always READS as a deviation, but it is parked beside
                // the trace it belongs to — and in trend mode that trace is
                // drawn in engineering units, so the anchor is the PV, not the
                // deviation. Anchoring both to sy(v) would float the chip in
                // empty space halfway down an unrelated axis.
                var y = PVX.util.clamp(D.sy(D.mode === 'trend' ? last.pv : v),
                    D.plot.y + h / 2, D.plot.y1 - h / 2);
                // Nudge apart rather than overlap; drop the chip entirely if
                // there is genuinely no room left in the column.
                for (var g = 0; g < placed.length; g++) {
                    if (Math.abs(placed[g] - y) < h) { y = placed[g] + h; }
                }
                if (y > D.plot.y1 - h / 2) { continue; }
                placed.push(y);

                var col = zoneColor(D.cfg, zone, i, D.count);
                var text = devText(v, D.cfg, unit);
                var w = Math.min(chipW, text.length * font * CHAR_W + 8);
                var x = D.plot.x1 + 3;
                // The readout dims with its own trace: a confident-looking
                // number sitting beside a faded trace would be the one thing on
                // the symbol that hid the quality problem.
                var chipG = PVX.svg.el('g', {
                    opacity: rows[i].series.good ? null : '0.5'
                }, parent);
                PVX.svg.el('path', {
                    d: PVX.svg.roundRect(x, y - h / 2, w, h, 2),
                    fill: col, 'fill-opacity': zone === 0 ? 0.16 : 0.9,
                    stroke: col, 'stroke-width': zone === 0 ? 1 : 0,
                    'class': 'pvx-dev-chip'
                }, chipG);
                PVX.svg.text(chipG, (x + w / 2).toFixed(2), y.toFixed(2), text, {
                    'class': 'pvx-svg-label pvx-num', 'text-anchor': 'middle',
                    'font-size': font * 0.92,
                    'font-weight': '600',
                    fill: zone === 0 ? D.theme.text : PVX.color.readable(col)
                });
            }
        }

        /**
         * True rendered width of a text node.
         *
         * Everywhere else in this file text is sized from the CHAR_W average,
         * because those decisions happen once per sample and getComputedTextLength
         * flushes layout on every call. The stats card is laid out ONCE per
         * render, so it can afford the truth — and it needs the truth, because
         * the average is only ever approximately right: it is generous in one
         * font and tight in another, and "approximately" is the difference
         * between a card that contains its own text and one that does not. PI
         * Vision ships Segoe UI; a review harness does not necessarily have it.
         */
        function textWidth(node, font) {
            if (node && node.getComputedTextLength) {
                try { return node.getComputedTextLength(); } catch (e) { /* not laid out */ }
            }
            // Only reached in a host with no SVG text metrics at all.
            return String(node ? node.textContent : '').length * font * CHAR_W;
        }

        function detach(node) {
            if (node && node.parentNode) { node.parentNode.removeChild(node); }
        }

        /** Shrink a text node's content until it really measures within maxPx. */
        function fitNode(node, maxPx, font) {
            if (!node) { return 0; }
            if (!(maxPx > 0)) { node.textContent = ''; return 0; }
            for (var guard = 0; guard < 8; guard++) {
                var w = textWidth(node, font);
                if (!(w > maxPx)) { return w; }
                var cur = node.textContent || '';
                var core = cur.charAt(cur.length - 1) === '…' ? cur.slice(0, -1) : cur;
                if (core.length < 2) { node.textContent = ''; return 0; }
                // -1 leaves room for the ellipsis; the min() guarantees the
                // string shrinks every pass even when the ratio rounds up.
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return 0; }
                node.textContent = core.slice(0, keep) + '…';
            }
            return textWidth(node, font);
        }

        /**
         * The corner card. Time in band is the headline because it is the one
         * number that answers "is this loop doing its job"; everything else
         * explains it.
         *
         * Laid out by measurement, not by estimate: the rows are created first,
         * measured, and only then is the box sized around them and positioned.
         * Sizing a card against typical content is how you end up with a panel
         * that fits at two data sources and spills its text at eight.
         */
        function drawStats(parent, agg, cfg, t, plot, quad, font, unit, count) {
            var warnBelow = PVX.util.num(cfg.StatsWarnBelow);
            warnBelow = (warnBelow === null) ? 95 : warnBelow;
            // The alarm floor never rises above the warning threshold, whatever
            // the user typed — an alarm that fires before the warning is a bug.
            var alarmBelow = Math.min(80, warnBelow);

            var status = t.text;
            if (agg.pct !== null) {
                if (agg.pct < alarmBelow) { status = PVX.color.status.alarm; }
                else if (agg.pct < warnBelow) { status = PVX.color.status.warning; }
                else { status = PVX.color.status.normal; }
            }

            /* The panel must never become the chart. It is capped to roughly
             * two thirds of the plot in each direction, and rows are shed by
             * PRIORITY (the `p` field, high = expendable) until the height fits
             * — so a small tile still gets the one number that matters instead
             * of a card that blankets the trace. */
            var padX = 6, padY = 4, gap = 10;
            var lineH = font * 1.4;
            var keyFont = font * 0.9;
            var maxW = Math.min(plot.w - 8, plot.w * 0.62);
            var maxH = Math.min(plot.h - 8, plot.h * 0.62);
            var i, L;

            var lines = [];
            lines.push({
                p: 0, k: 'In band', fs: font, bold: true,
                v: agg.pct === null ? '--' : PVX.fmt.percent(agg.pct, 1),
                c: status
            });
            lines.push({ p: 3, k: 'Mean', fs: font, v: devText(agg.mean, cfg, unit), c: t.text });
            if (agg.maxValue !== null) {
                var maxTxt = devText(agg.maxValue, cfg, unit);
                lines.push({
                    p: 1, k: 'Max', fs: font,
                    // The timestamp is what makes "max" actionable ("go look at
                    // the log for 20:07"), but it is the first thing dropped
                    // when the row will not fit — see the measuring pass below.
                    v: maxTxt + '  ' + PVX.fmt.time(agg.maxTime, 'short'),
                    vShort: maxTxt,
                    c: agg.maxValue >= 0 ? (cfg.HighColor || PVX.color.status.alarm)
                                         : (cfg.LowColor || PVX.color.status.warning)
                });
                if (count > 1 && agg.maxLabel) {
                    // Which tag the worst excursion belongs to. It is the one
                    // row whose content is arbitrary user text, so it is never
                    // allowed to set the panel width — it truncates instead.
                    lines.push({ p: 5, k: '', fs: font * 0.85, v: agg.maxLabel, c: t.textMuted, name: true });
                }
            }
            lines.push({ p: 2, k: 'Excursions', fs: font, v: String(agg.excursions), c: t.text });
            lines.push({
                p: 4, k: 'Longest', fs: font,
                v: agg.longest > 0 ? PVX.fmt.duration(agg.longest) : '--',
                c: t.text
            });

            // Height depends only on the row count, so shed first and measure
            // the survivors — measuring rows that are about to go is wasted.
            while (lines.length > 1 && lines.length * lineH + padY * 2 > maxH) {
                var worst = 0;
                for (i = 1; i < lines.length; i++) {
                    if (lines[i].p > lines[worst].p) { worst = i; }
                }
                lines.splice(worst, 1);
            }
            var boxH = lines.length * lineH + padY * 2;
            if (boxH > maxH) { return; }

            // ---- create the rows, then measure what was actually rendered ----
            var g = PVX.svg.el('g', { 'class': 'pvx-dev-stats-g' }, parent);
            for (i = 0; i < lines.length; i++) {
                L = lines[i];
                L.keyNode = L.k ? PVX.svg.text(g, 0, 0, L.k, {
                    'class': 'pvx-svg-label', 'font-size': keyFont.toFixed(1), fill: t.textMuted
                }) : null;
                L.valNode = PVX.svg.text(g, 0, 0, L.v, {
                    'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end',
                    'font-size': L.fs.toFixed(1),
                    'font-weight': L.bold ? '700' : '400',
                    fill: L.c
                });
                L.keyW = L.keyNode ? textWidth(L.keyNode, keyFont) : 0;
            }

            var room = maxW - padX * 2;
            var contentW = 0;
            for (i = 0; i < lines.length; i++) {
                L = lines[i];
                if (L.name) { continue; }
                L.valW = textWidth(L.valNode, L.fs);
                // Drop the timestamp before touching the number it belongs to.
                if (L.vShort && L.keyW + gap + L.valW > room) {
                    L.valNode.textContent = L.vShort;
                    L.valW = textWidth(L.valNode, L.fs);
                }
                /* A truncated number is a WRONG number — "2…" could be 2.5% or
                 * 25%, and an operator has no way to tell. Numeric rows are
                 * therefore atomic: a row that will not fit whole is dropped
                 * rather than ellipsised or left as a label with no value. */
                L.drop = (L.keyW + gap + L.valW > room);
                if (!L.drop) { contentW = Math.max(contentW, L.keyW + gap + L.valW); }
            }

            // Time in band is the reason the card exists; if even that row will
            // not fit, there is no card worth drawing.
            if (lines[0].drop) { parent.removeChild(g); return; }

            /* The series name is the one row whose content is arbitrary user
             * text, so it is also the only one allowed to truncate — and it
             * gets no more width than the numbers already needed, because a tag
             * path long enough to double the card would eat the plot the card
             * exists to annotate. */
            for (i = 0; i < lines.length; i++) {
                L = lines[i];
                if (!L.name) { continue; }
                L.valW = fitNode(L.valNode, Math.min(room, Math.max(contentW, font * 8)), L.fs);
                L.drop = !L.valNode.textContent;
                if (!L.drop) { contentW = Math.max(contentW, L.valW); }
            }

            var kept = [];
            for (i = 0; i < lines.length; i++) {
                if (lines[i].drop) {
                    detach(lines[i].keyNode);
                    detach(lines[i].valNode);
                } else {
                    kept.push(lines[i]);
                }
            }
            lines = kept;
            boxH = lines.length * lineH + padY * 2;

            var boxW = Math.min(maxW, contentW + padX * 2);
            if (boxW < 54) { parent.removeChild(g); return; }

            // Park it in whichever quadrant holds the fewest marks. The card
            // always sits INSIDE the plot rect, and the current-value chips are
            // drawn in the reserved margin beyond plot.x1, so the two can never
            // reach each other.
            var best = 0;
            for (i = 1; i < 4; i++) { if (quad[i] < quad[best]) { best = i; } }
            var left = (best === 0 || best === 2);
            var top = (best === 0 || best === 1);
            var bx = left ? plot.x + 4 : plot.x + plot.w - boxW - 4;
            var by = top ? plot.y + 4 : plot.y + plot.h - boxH - 4;

            // A transparent symbol has no surface color to borrow, so fall back
            // to a scrim that keeps the text legible over the trace.
            var fill = (t.surface && t.surface !== 'transparent')
                ? PVX.color.rgba(t.surface, 0.88)
                : (t.dark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.8)');

            var card = PVX.svg.el('path', {
                d: PVX.svg.roundRect(bx, by, boxW, boxH, 3),
                fill: fill, stroke: status, 'stroke-width': 1,
                'class': 'pvx-dev-stats'
            });
            g.insertBefore(card, g.firstChild);   // behind the rows it frames

            for (i = 0; i < lines.length; i++) {
                L = lines[i];
                var cy = by + padY + lineH * (i + 0.5);
                if (L.keyNode) {
                    L.keyNode.setAttribute('x', (bx + padX).toFixed(2));
                    L.keyNode.setAttribute('y', cy.toFixed(2));
                }
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

        function titleText(list, seriesTarget) {
            if (!list.length) { return 'Deviation from target'; }
            if (list.length === 1) {
                return (list[0].label || 'Deviation') + ' — deviation';
            }
            if (seriesTarget && model.sp) {
                return 'Deviation from ' + (model.sp.label || 'setpoint');
            }
            return 'Deviation from target';
        }

        function targetText(cfg, tol, unit, seriesTarget) {
            var tolTxt;
            if (tol.hi === -tol.lo) {
                tolTxt = '±' + PVX.fmt.tick(tol.hi) + unit;
            } else {
                tolTxt = '-' + PVX.fmt.tick(-tol.lo) + unit + ' / +' + PVX.fmt.tick(tol.hi) + unit;
            }
            var head = seriesTarget
                ? 'SP: ' + ((model.sp && model.sp.label) || 'setpoint')
                : 'Target ' + PVX.fmt.number(cfg.TargetValue, { decimals: cfg.Decimals });
            return head + '  ' + tolTxt;
        }

        function axisTitleText(mode, list, unit) {
            if (mode === 'trend') {
                var u = list.length ? list[0].units : '';
                return u ? ('Value (' + u + ')') : 'Value';
            }
            return unit ? ('Deviation (' + unit + ')') : 'Deviation';
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
         * and this symbol writes its title/footer through scope bindings. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
