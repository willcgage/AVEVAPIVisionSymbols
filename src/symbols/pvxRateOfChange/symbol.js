/* ============================================================================
 * pvxRateOfChange: "PVX Rate of Change" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources, each charted as its own rate)
 *
 * A trend shows where a value is. How fast it is getting there is what a
 * heat-up, cool-down or pressurization procedure limits, and the slope of a
 * trend line is hard to read by eye: the same climb looks steep on a narrow
 * scale and flat on a wide one. This plots the rate itself, in the units per
 * second, minute, hour or day that the procedure is written in, with rise
 * and fall limits that turn the trace the alarm color while they are broken.
 *
 * THE RATE. Recorded values (ModeEvents), never plot values: those are each
 * pixel column's minimum and maximum, so neighbours zig-zag and their rate is
 * noise. Three ways to take it, all arithmetic in PVX.stats.rateOfChange so
 * the test suite checks it against known answers:
 *   window   the change across a sliding window, divided by its length;
 *            the window is the smoothing, and every window is the same length
 *            of time however the compressed samples fall in it
 *   fit      the slope of a straight line fitted across the same window;
 *            steadier on a noisy signal, slower to show a sudden step
 *   samples  between consecutive recorded values, unsmoothed
 * A trailing window ends at the time plotted, which is what a live rate
 * alarm sees, so the trace lags by half a window; centered removes the lag
 * for analysis and loses the last half window instead.
 *
 * Nothing is drawn across a value that is not a good number, or across a gap
 * longer than the limit when one is set, and the footer counts both.
 * Nothing is written back and nothing alarms outside the symbol.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Mean advance width of the UI font, in ems (see pvxHistogram). */
    var CHAR_W = 0.58;

    var UNIT_MS = { s: 1000, min: 60000, h: 3600000, d: 86400000 };
    var UNIT_WORD = { s: 's', min: 'min', h: 'h', d: 'day' };

    var definition = {
        typeName: 'pvxRateOfChange',
        displayName: 'PVX Rate of Change',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // A chart: one per unit in a collection is the normal use.
        supportsCollections: true,
        configTitle: 'Format Rate of Change',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                // Recorded values, never plot values: see the header.
                DataQueryMode: 'ModeEvents',
                Height: 300,
                Width: 480,

                // --- the rate -----------------------------------------------
                Method: 'window',           // window | fit | samples
                WindowValue: 10,            // smoothing window length, in WindowUnit
                WindowUnit: 'min',          // s | min | h | d
                WindowAlign: 'trailing',    // trailing | centered
                RateUnit: 'min',            // rate per s | min | h | d
                Intervals: 240,             // points across the time range (window and fit)
                MaxGapMinutes: 0,           // break the trace at a longer gap between values; 0 = never
                MaxSeries: 6,

                // --- limits, as rates in RateUnit; blank = none ----------------
                RiseLimit: '',              // rising faster than this is past the limit
                FallLimit: '',              // falling faster than this (typed as a positive number)
                RiseWarn: '',               // warning before the rise limit
                FallWarn: '',               // warning before the fall limit
                AlarmColor: '',             // blank = the status alarm color
                WarnColor: '',              // blank = the status warning color
                ShadeLimits: true,          // shade the regions past the limits

                // --- the chart ----------------------------------------------
                ShowValue: false,           // the measured value too, on a right-hand axis
                SymmetricAxis: false,       // the same scale above and below zero
                ShowZeroLine: true,
                ShowLegend: true,
                ShowGrid: true,
                TickCount: 5,
                ShowStats: true,            // steepest rise, steepest fall and the latest rate in the footer

                // --- text: blank means the wording the symbol builds itself ---
                Title: '',
                ShowMethodCaption: true,
                MethodCaption: '',
                AxisTitle: '',
                ValueAxisTitle: '',
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { title: '', method: '', stats: '', note: '', status: '', error: '', background: '' };

        var model = { all: [], from: null, to: null };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-roc-body',
            onData: function (d) {
                // stateSeries, not series: series drops what is not a number,
                // and the rate must stop at a bad value, not run through it.
                model.all = PVX.data.stateSeries(d);
                var r = range(d);
                model.from = r.from;
                model.to = r.to;
            },
            render: render
        });

        /* ================================================================== *
         * render
         * ================================================================== */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            var W = Math.max(40, c.width);
            var H = Math.max(40, c.height);
            var boxH0 = (c.node && c.node.clientHeight) || H;

            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;
            if (c.node && c.node.style && c.node.style.setProperty) {
                c.node.style.setProperty('--pvx-text', t.text);
                c.node.style.setProperty('--pvx-muted', t.textMuted);
            }

            var svgRoot = host.querySelector('svg.pvx-roc-svg');
            if (!svgRoot) { svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-roc-svg' }, host); }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var all = model.all || [];
            var maxSeries = PVX.util.clamp(parseInt(cfg.MaxSeries, 10) || 6, 1, 12);
            var list = all.slice(0, maxSeries);
            var unit = UNIT_MS[cfg.RateUnit] ? cfg.RateUnit : 'min';
            var winUnit = UNIT_MS[cfg.WindowUnit] ? cfg.WindowUnit : 'min';
            var winMs = Math.max(1000, (PVX.util.num(cfg.WindowValue) || 10) * UNIT_MS[winUnit]);
            var method = cfg.Method === 'fit' || cfg.Method === 'samples' ? cfg.Method : 'window';
            var centered = cfg.WindowAlign === 'centered';
            var maxGapMs = Math.max(0, PVX.util.num(cfg.MaxGapMinutes) || 0) * 60000;
            var numOpts = PVX.config.numberOpts(cfg);

            var badSeries = [];
            for (var b0 = 0; b0 < list.length; b0++) { if (!list[b0].good) { badSeries.push(list[b0]); } }
            scope.pvx.error = badSeries.length ? (badSeries[0].errorDescription || 'Bad data quality') : '';
            scope.pvx.status = '';

            var showTitle = boxH0 >= 84;
            scope.pvx.title = showTitle ? titleText(cfg, list, unit) : '';
            scope.pvx.method = showTitle && W >= 260 && cfg.ShowMethodCaption !== false ? methodText(cfg, method, winMs, centered) : '';

            if (!list.length) {
                scope.pvx.stats = '';
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, 'No data', 'Drop an attribute onto the symbol.');
                digest();
                return;
            }

            /* ---- limits ------------------------------------------------- */
            var lim = {
                hi: limit(cfg.RiseLimit, 1), lo: limit(cfg.FallLimit, -1),
                hiWarn: limit(cfg.RiseWarn, 1), loWarn: limit(cfg.FallWarn, -1)
            };
            var anyLimit = lim.hi !== null || lim.lo !== null || lim.hiWarn !== null || lim.loWarn !== null;
            var cs = t.status;
            var alarmColor = cfg.AlarmColor || cs.alarm;
            var warnColor = cfg.WarnColor || cs.warning;

            /* ---- the rates ---------------------------------------------- */
            var pal = t.categorical || PVX.color.categorical;
            var rows = [];
            var now = Date.now();
            var i, j, k;
            for (i = 0; i < list.length; i++) {
                var s = list[i];
                var pts = s.points || [];
                var from = PVX.util.isNum(model.from) ? model.from : (pts.length ? pts[0].t : null);
                var to = PVX.util.isNum(model.to) ? model.to : (pts.length ? pts[pts.length - 1].t : null);
                var res = PVX.stats.rateOfChange(pts, {
                    from: from, to: to, method: method, windowMs: winMs,
                    align: centered ? 'centered' : 'trailing', intervals: cfg.Intervals,
                    perMs: UNIT_MS[unit], maxGapMs: maxGapMs, now: now
                });
                rows.push({
                    s: s, res: res, sum: PVX.stats.rateSummary(res, lim),
                    color: list.length === 1 ? (cfg.AccentColor || pal[0]) : pal[i % pal.length],
                    rateUnits: rateUnits(s.units, unit)
                });
            }

            var any = false;
            for (i = 0; i < rows.length; i++) { if (rows[i].sum.count) { any = true; break; } }
            if (!any) {
                scope.pvx.stats = '';
                scope.pvx.note = extrasText(rows, cfg, method, winMs, centered, all.length - list.length).join(' · ');
                emptyState(svgRoot, W, H, t, 'Not enough data',
                    method === 'samples' ? 'The rate needs two good values in the time range.'
                        : 'The rate needs good values ' + durationText(winMs) + ' apart: shorten the window or widen the time range.');
                digest();
                return;
            }

            /* ---- domains ------------------------------------------------ */
            var tMin = null, tMax = null, lo = 0, hi = 0;
            var vLo = null, vHi = null;
            for (i = 0; i < rows.length; i++) {
                var rr = rows[i].res;
                if (PVX.util.isNum(rr.from) && (tMin === null || rr.from < tMin)) { tMin = rr.from; }
                if (PVX.util.isNum(rr.to) && (tMax === null || rr.to > tMax)) { tMax = rr.to; }
                if (rows[i].sum.count) {
                    lo = Math.min(lo, rows[i].sum.min.r);
                    hi = Math.max(hi, rows[i].sum.max.r);
                }
                if (cfg.ShowValue) {
                    for (j = 0; j < rr.segments.length; j++) {
                        var sp = rr.segments[j].pts;
                        for (k = 0; k < sp.length; k++) {
                            if (vLo === null || sp[k].v < vLo) { vLo = sp[k].v; }
                            if (vHi === null || sp[k].v > vHi) { vHi = sp[k].v; }
                        }
                    }
                }
            }
            if (tMin === null || !(tMax > tMin)) { tMin = tMin || 0; tMax = tMin + 1; }
            // A limit is drawn only when it is in view or near it: a rise limit
            // of 100 on a trace that never passes 2 would flatten the trace to
            // a line, and the footer says it was never reached either way.
            var span0 = Math.max(hi - lo, 1e-9);
            var near = function (v) { return v !== null && v >= lo - span0 * 1.5 && v <= hi + span0 * 1.5; };
            var drawn = { hi: near(lim.hi), lo: near(lim.lo), hiWarn: near(lim.hiWarn), loWarn: near(lim.loWarn) };
            if (drawn.hi) { hi = Math.max(hi, lim.hi); }
            if (drawn.lo) { lo = Math.min(lo, lim.lo); }
            if (drawn.hiWarn) { hi = Math.max(hi, lim.hiWarn); }
            if (drawn.loWarn) { lo = Math.min(lo, lim.loWarn); }
            if (cfg.SymmetricAxis) { var m = Math.max(Math.abs(lo), Math.abs(hi)); lo = -m; hi = m; }
            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 10);
            var dom = PVX.scale.niceDomain(lo, hi, tickCount);
            if (!(dom[1] > dom[0])) { dom = [lo - 1, hi + 1]; }
            var ticks = PVX.scale.ticks(dom[0], dom[1], tickCount);
            var showValue = !!cfg.ShowValue && vLo !== null;
            var vDom = showValue ? PVX.scale.niceDomain(vLo, vHi, tickCount) : null;
            var vTicks = showValue ? PVX.scale.ticks(vDom[0], vDom[1], tickCount) : [];

            /* ---- layout ------------------------------------------------- */
            var tickFont = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var showTicks = W >= 150 && H >= 100;
            var showTime = W >= 150 && H >= 90;
            var sameUnits = true;
            for (i = 1; i < rows.length; i++) { if (rows[i].rateUnits !== rows[0].rateUnits) { sameUnits = false; } }
            var axisTitle = showTicks && H >= 150 ? axisTitleText(cfg, rows, sameUnits, unit) : '';
            var vAxisTitle = showTicks && H >= 150 && showValue ? valueAxisTitleText(cfg, rows) : '';
            var showLegend = cfg.ShowLegend !== false && rows.length > 1 && H >= 120 && W >= 200;

            var tickW = 0, vTickW = 0;
            if (showTicks) {
                for (i = 0; i < ticks.length; i++) { tickW = Math.max(tickW, textW(signed(ticks[i]), tickFont)); }
                for (i = 0; i < vTicks.length; i++) { vTickW = Math.max(vTickW, textW(PVX.fmt.tick(vTicks[i]), tickFont)); }
            }
            // Limit captions sit at the right end of their lines; reserve room
            // so "+2 °C/min" is never cut off by the edge of the symbol.
            // With the value axis on the right they go inside the plot instead,
            // above their lines, rather than over its tick labels.
            var capW = 0;
            if (W >= 260 && anyLimit && !showValue) {
                var caps = [lim.hi, lim.lo, lim.hiWarn, lim.loWarn];
                for (i = 0; i < caps.length; i++) { if (caps[i] !== null) { capW = Math.max(capW, textW(fmtR(caps[i]), tickFont * 0.9) + 6); } }
            }
            var titleGap = axisTitle ? tickFont + 4 : 0;
            var mL = Math.min(W * 0.35, 4 + titleGap + tickW + (tickW ? 5 : 0));
            var mR = Math.min(W * 0.35, 6 + Math.max(capW, showValue && showTicks ? vTickW + 6 + (vAxisTitle ? tickFont + 4 : 0) : 0));
            var mT = showLegend ? tickFont + 10 : 6;
            var mB = showTime ? tickFont + 10 : 4;
            var plot = { x: mL, y: mT, w: Math.max(10, W - mL - mR), h: Math.max(10, H - mT - mB) };
            plot.x1 = plot.x + plot.w; plot.y1 = plot.y + plot.h;

            var sx = PVX.scale.linear(tMin, tMax, plot.x, plot.x1);
            var sy = PVX.scale.linear(dom[0], dom[1], plot.y1, plot.y);
            var svy = showValue ? PVX.scale.linear(vDom[0], vDom[1], plot.y1, plot.y) : null;
            var yOf = function (v) { return PVX.util.clamp(sy(v), plot.y, plot.y1); };

            /* ---- shading and grid --------------------------------------- */
            if (cfg.ShadeLimits !== false) {
                if (drawn.hi) { band(dom[1], lim.hi, alarmColor, 0.08); }
                if (drawn.lo) { band(lim.lo, dom[0], alarmColor, 0.08); }
                if (drawn.hiWarn) { band(lim.hi !== null ? Math.min(lim.hi, dom[1]) : dom[1], lim.hiWarn, warnColor, 0.07); }
                if (drawn.loWarn) { band(lim.loWarn, lim.lo !== null ? Math.max(lim.lo, dom[0]) : dom[0], warnColor, 0.07); }
            }
            if (cfg.ShowGrid !== false) {
                for (i = 0; i < ticks.length; i++) { hline(sy(ticks[i]), t.grid, null, 1); }
            }
            if (cfg.ShowZeroLine !== false && dom[0] < 0 && dom[1] > 0) { hline(sy(0), t.text, null, 1.2, 0.6); }

            /* ---- the measured value, behind the rate --------------------- */
            if (showValue) {
                for (i = 0; i < rows.length; i++) {
                    var segs = rows[i].res.segments;
                    for (j = 0; j < segs.length; j++) {
                        var vxy = [];
                        for (k = 0; k < segs[j].pts.length; k++) {
                            var vp = segs[j].pts[k];
                            if (vp.t < tMin || vp.t > tMax) { continue; }
                            vxy.push({ x: sx(vp.t), y: svy(vp.v) });
                        }
                        if (vxy.length < 2) { continue; }
                        PVX.svg.el('path', {
                            d: PVX.svg.line(vxy, false), fill: 'none', stroke: rows[i].color,
                            'stroke-opacity': 0.4, 'stroke-width': 1, 'stroke-dasharray': '4 3',
                            'class': 'pvx-roc-value'
                        }, svgRoot);
                    }
                }
            }

            /* ---- limit lines -------------------------------------------- */
            limitLine(lim.hi, drawn.hi, alarmColor, '5 3');
            limitLine(lim.lo, drawn.lo, alarmColor, '5 3');
            limitLine(lim.hiWarn, drawn.hiWarn, warnColor, '2 3');
            limitLine(lim.loWarn, drawn.loWarn, warnColor, '2 3');

            /* ---- the rate ----------------------------------------------- */
            // Past a limit the trace takes the limit's color: drawn once in its
            // own color, then again through a clip of the regions past each
            // limit, so the change of color falls exactly on the limit line.
            var clipAlarm = clipFor([
                lim.hi !== null && lim.hi < dom[1] ? [dom[1], lim.hi] : null,
                lim.lo !== null && lim.lo > dom[0] ? [lim.lo, dom[0]] : null
            ]);
            var clipWarn = clipFor([
                lim.hiWarn !== null ? [lim.hi !== null ? lim.hi : dom[1], lim.hiWarn] : null,
                lim.loWarn !== null ? [lim.loWarn, lim.lo !== null ? lim.lo : dom[0]] : null
            ]);
            for (i = 0; i < rows.length; i++) {
                var runs = rows[i].res.runs;
                for (j = 0; j < runs.length; j++) {
                    var xy = [];
                    for (k = 0; k < runs[j].length; k++) { xy.push({ x: sx(runs[j][k].t), y: yOf(runs[j][k].r) }); }
                    // A 'samples' run already holds each step's two ends.
                    var d = PVX.svg.line(xy, false);
                    if (xy.length === 1) { d = 'M' + (xy[0].x - 1).toFixed(2) + ' ' + xy[0].y.toFixed(2) + 'h2'; }
                    trace(d, rows[i].color, null);
                    if (clipWarn) { trace(d, warnColor, clipWarn); }
                    if (clipAlarm) { trace(d, alarmColor, clipAlarm); }
                }
            }

            /* ---- axes --------------------------------------------------- */
            hline(plot.y1, t.axis, null, 1);
            vline(plot.x, plot.y, plot.y1);
            if (showTicks) {
                for (i = 0; i < ticks.length; i++) { tickLabel(plot.x - 4, sy(ticks[i]), signed(ticks[i]), 'end'); }
                if (showValue) {
                    vline(plot.x1, plot.y, plot.y1);
                    for (i = 0; i < vTicks.length; i++) { tickLabel(plot.x1 + 4, svy(vTicks[i]), PVX.fmt.tick(vTicks[i]), 'start'); }
                }
            }
            if (axisTitle) { sideTitle(axisTitle, 2 + tickFont * 0.8, -90); }
            if (vAxisTitle) { sideTitle(vAxisTitle, W - 2 - tickFont * 0.25, 90); }

            /* ---- time axis ---------------------------------------------- */
            if (showTime) {
                var nT = Math.max(2, Math.min(5, Math.floor(plot.w / (11 * tickFont * CHAR_W + 10))));
                var yTime = plot.y1 + 4 + tickFont * 0.6;
                for (i = 0; i < nT; i++) {
                    var tt = tMin + (tMax - tMin) * i / (nT - 1);
                    var str = PVX.fmt.time(tt, 'short');
                    var x = sx(tt), w = textW(str, tickFont), anchor = 'middle';
                    if (x - w / 2 < 1) { anchor = 'start'; x = Math.max(1, x); }
                    else if (x + w / 2 > W - 1) { anchor = 'end'; x = Math.min(W - 1, x); }
                    PVX.svg.text(svgRoot, x.toFixed(2), yTime.toFixed(2), str, {
                        'class': 'pvx-svg-label pvx-num', 'text-anchor': anchor, 'font-size': tickFont, fill: t.textMuted
                    });
                }
            }

            /* ---- legend ------------------------------------------------- */
            if (showLegend) {
                var lx = plot.x, ly = 4 + tickFont * 0.5;
                var share = Math.max(60, plot.w / rows.length - 6);
                for (i = 0; i < rows.length; i++) {
                    if (lx > plot.x1 - 30) { break; }
                    PVX.svg.el('rect', {
                        x: lx.toFixed(2), y: (ly - 1.5).toFixed(2), width: 12, height: 3, fill: rows[i].color
                    }, svgRoot);
                    var lt = PVX.svg.text(svgRoot, (lx + 16).toFixed(2), ly.toFixed(2), rows[i].s.label, {
                        'class': 'pvx-svg-label', 'font-size': tickFont * 0.9, fill: t.text
                    });
                    PVX.svg.fit(lt, Math.min(share - 20, plot.x1 - lx - 16));
                    PVX.svg.el('title', null, lt).textContent = rows[i].s.label + (rows[i].s.path ? '\n' + rows[i].s.path : '');
                    lx += share;
                }
            }

            /* ---- hover columns ------------------------------------------ */
            var nCols = Math.max(2, Math.min(400, Math.floor(plot.w / 3)));
            var colW = plot.w / nCols;
            for (i = 0; i < nCols; i++) {
                var tc = tMin + (tMax - tMin) * (i + 0.5) / nCols;
                var lines = [PVX.fmt.time(tc, 'datetime')];
                var anyRate = false;
                for (j = 0; j < rows.length; j++) {
                    var rv = rateAt(rows[j].res, tc);
                    if (rv !== null) { anyRate = true; }
                    var line = (rows.length > 1 ? rows[j].s.label + ': ' : 'Rate: ') +
                        (rv === null ? '--' : fmtR(rv) + ' ' + rows[j].rateUnits) + flagText(rv);
                    if (cfg.ShowValue) {
                        var vv = valueAt(rows[j].res.segments, tc);
                        line += (rows.length > 1 ? ' (' : '\nValue: ') + (vv === null ? '--' : PVX.fmt.number(vv, numOpts) +
                            (rows[j].s.units ? ' ' + rows[j].s.units : '')) + (rows.length > 1 ? ')' : '');
                    }
                    lines.push(line);
                }
                if (!anyRate) { continue; }
                var hit = PVX.svg.el('rect', {
                    x: (plot.x + i * colW).toFixed(2), y: plot.y.toFixed(2), width: (colW + 0.01).toFixed(2),
                    height: plot.h.toFixed(2), 'class': 'pvx-hit pvx-roc-hit'
                }, svgRoot);
                PVX.svg.el('title', null, hit).textContent = lines.join('\n');
            }

            /* ---- footer ------------------------------------------------- */
            scope.pvx.stats = cfg.ShowStats !== false ? statsText(rows) : '';
            var note = [];
            if (anyLimit) {
                var out = [];
                for (i = 0; i < rows.length; i++) {
                    var su = rows[i].sum, who = rows.length > 1 ? rows[i].s.label + ': ' : '';
                    if (su.above.ms > 0) { out.push(who + 'over the rise limit ' + PVX.fmt.duration(su.above.ms) + times(su.above.count)); }
                    if (su.below.ms > 0) { out.push(who + 'past the fall limit ' + PVX.fmt.duration(su.below.ms) + times(su.below.count)); }
                }
                if (out.length) {
                    scope.pvx.status = 'out';
                    note.push(out.join(', '));
                } else {
                    var warned = 0;
                    for (i = 0; i < rows.length; i++) { warned += rows[i].sum.warnAbove.ms + rows[i].sum.warnBelow.ms; }
                    note.push(lim.hi === null && lim.lo === null ? (warned ? 'Past a warning for ' + PVX.fmt.duration(warned) : 'Within the warnings')
                        : 'Within the rate limits' + (warned ? ', past a warning for ' + PVX.fmt.duration(warned) : ''));
                }
            } else {
                note.push('No rate limits set');
            }
            note = note.concat(extrasText(rows, cfg, method, winMs, centered, all.length - list.length));
            scope.pvx.note = note.join(' · ');

            digest();

            /* ---- closures over this frame ------------------------------- */
            function flagText(r) {
                if (r === null) { return ''; }
                if (lim.hi !== null && r > lim.hi) { return '  over the rise limit'; }
                if (lim.lo !== null && r < lim.lo) { return '  past the fall limit'; }
                if (lim.hiWarn !== null && r > lim.hiWarn) { return '  rise warning'; }
                if (lim.loWarn !== null && r < lim.loWarn) { return '  fall warning'; }
                return '';
            }
            function band(a, b2, color, opacity) {
                var y0 = yOf(Math.max(a, b2)), y1 = yOf(Math.min(a, b2));
                if (Math.abs(y1 - y0) < 0.5) { return; }
                PVX.svg.el('rect', {
                    x: plot.x.toFixed(2), y: y0.toFixed(2), width: plot.w.toFixed(2),
                    height: (y1 - y0).toFixed(2), fill: color, 'fill-opacity': opacity, 'class': 'pvx-roc-band'
                }, svgRoot);
            }
            function clipFor(pairs) {
                var rects = [];
                for (var p = 0; p < pairs.length; p++) {
                    if (!pairs[p]) { continue; }
                    var y0 = yOf(Math.max(pairs[p][0], pairs[p][1])), y1 = yOf(Math.min(pairs[p][0], pairs[p][1]));
                    if (y1 - y0 >= 0.5) { rects.push([y0, y1]); }
                }
                if (!rects.length) { return null; }
                var id = PVX.util.uid('pvx-roc-clip');
                var defs = PVX.svg.el('defs', null, svgRoot);
                var cp = PVX.svg.el('clipPath', { id: id }, defs);
                for (var q = 0; q < rects.length; q++) {
                    // Wider than the plot by the stroke, so a peak at either
                    // edge keeps its color.
                    PVX.svg.el('rect', {
                        x: (plot.x - 3).toFixed(2), y: rects[q][0].toFixed(2), width: (plot.w + 6).toFixed(2),
                        height: (rects[q][1] - rects[q][0]).toFixed(2)
                    }, cp);
                }
                return id;
            }
            function trace(d2, color, clip) {
                var a = {
                    d: d2, fill: 'none', stroke: color, 'stroke-width': 1.6,
                    'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'class': 'pvx-roc-line'
                };
                if (clip) { a['clip-path'] = 'url(#' + clip + ')'; }
                PVX.svg.el('path', a, svgRoot);
            }
            function limitLine(v, show, color, dash) {
                if (v === null || !show) { return; }
                hline(sy(v), color, dash, 1.2);
                if (showValue && W >= 260) {
                    var above = sy(v) - 3 - tickFont * 0.9 >= plot.y;
                    PVX.svg.text(svgRoot, (plot.x1 - 3).toFixed(2), (above ? sy(v) - 3 : sy(v) + tickFont).toFixed(2), fmtR(v), {
                        'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end', 'font-size': (tickFont * 0.9).toFixed(1), fill: color
                    });
                } else if (capW) {
                    PVX.svg.text(svgRoot, (plot.x1 + 3).toFixed(2), (sy(v) + tickFont * 0.32).toFixed(2), fmtR(v), {
                        'class': 'pvx-svg-label pvx-num', 'font-size': (tickFont * 0.9).toFixed(1), fill: color
                    });
                }
            }
            function hline(y, stroke, dash, width, opacity) {
                if (!PVX.util.isNum(y)) { return; }
                var a = {
                    x1: plot.x.toFixed(2), y1: y.toFixed(2), x2: plot.x1.toFixed(2), y2: y.toFixed(2),
                    stroke: stroke, 'stroke-width': width || 1, 'class': 'pvx-roc-ref'
                };
                if (dash) { a['stroke-dasharray'] = dash; }
                if (opacity !== undefined) { a['stroke-opacity'] = opacity; }
                PVX.svg.el('line', a, svgRoot);
            }
            function vline(x2, y0, y1) {
                PVX.svg.el('line', {
                    x1: x2.toFixed(2), y1: y0.toFixed(2), x2: x2.toFixed(2), y2: y1.toFixed(2),
                    stroke: t.axis, 'stroke-width': 1
                }, svgRoot);
            }
            function tickLabel(x2, y, str2, anchor2) {
                PVX.svg.text(svgRoot, x2.toFixed(2), (y + tickFont * 0.32).toFixed(2), str2, {
                    'class': 'pvx-svg-label pvx-num', 'text-anchor': anchor2, 'font-size': tickFont, fill: t.textMuted
                });
            }
            function sideTitle(str2, x2, angle) {
                var cy = plot.y + plot.h / 2;
                var n = PVX.svg.text(svgRoot, x2.toFixed(2), cy.toFixed(2), str2, {
                    'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': (tickFont * 0.9).toFixed(1),
                    fill: t.textMuted, transform: 'rotate(' + angle + ' ' + x2.toFixed(2) + ' ' + cy.toFixed(2) + ')'
                });
                PVX.svg.fit(n, plot.h);
            }
            function fmtR(v) { return signed(v, numOpts); }
        }

        /* ================================================================== *
         * text
         * ================================================================== */

        /** A text option as typed, or '' when it was left blank. */
        function own(v) {
            return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, '');
        }

        function titleText(cfg, list, unit) {
            if (own(cfg.Title)) { return own(cfg.Title); }
            if (list.length !== 1) { return 'Rate of change'; }
            return list[0].label + ' rate of change' +
                (cfg.ShowUnits !== false ? ' (' + rateUnits(list[0].units, unit) + ')' : '');
        }

        function methodText(cfg, method, winMs, centered) {
            if (own(cfg.MethodCaption)) { return own(cfg.MethodCaption); }
            if (method === 'samples') { return 'between recorded values'; }
            return (method === 'fit' ? 'fit over ' : 'change over ') + durationText(winMs) + (centered ? ', centered' : '');
        }

        function axisTitleText(cfg, rows, sameUnits, unit) {
            if (own(cfg.AxisTitle)) { return own(cfg.AxisTitle); }
            return sameUnits ? 'Rate (' + rows[0].rateUnits + ')' : 'Rate per ' + UNIT_WORD[unit];
        }

        function valueAxisTitleText(cfg, rows) {
            if (own(cfg.ValueAxisTitle)) { return own(cfg.ValueAxisTitle); }
            return rows[0].s.units ? 'Value (' + rows[0].s.units + ')' : 'Value';
        }

        /** Steepest rise and fall and the latest rate; with several sources, the steepest of all, named. */
        function statsText(rows) {
            var best = null, worst = null;
            for (var i = 0; i < rows.length; i++) {
                var su = rows[i].sum;
                if (!su.count) { continue; }
                if (!best || su.max.r > best.p.r) { best = { p: su.max, row: rows[i] }; }
                if (!worst || su.min.r < worst.p.r) { worst = { p: su.min, row: rows[i] }; }
            }
            if (!best) { return ''; }
            var cfg = scope.config || {};
            var numOpts = PVX.config.numberOpts(cfg);
            var who = function (x) { return rows.length > 1 ? ' (' + x.row.s.label + ')' : ''; };
            var parts = [];
            // A "max fall" of +2 reads as nonsense: a side that never happened
            // is left out, and a rate that never changed is called steady.
            var spread = Math.abs(best.p.r - worst.p.r);
            if (spread <= 1e-9 * Math.max(1, Math.abs(best.p.r))) {
                parts.push('Steady ' + signed(best.p.r, numOpts) + ' ' + best.row.rateUnits + who(best));
            } else {
                if (best.p.r > 0) {
                    parts.push('Max rise ' + signed(best.p.r, numOpts) + ' ' + best.row.rateUnits + who(best) + ' at ' + PVX.fmt.time(best.p.t, 'short'));
                }
                if (worst.p.r < 0) {
                    parts.push((parts.length ? 'max fall ' : 'Max fall ') + signed(worst.p.r, numOpts) + ' ' + worst.row.rateUnits + who(worst) + ' at ' + PVX.fmt.time(worst.p.t, 'short'));
                }
                if (!parts.length) { parts.push('No rise or fall'); }
            }
            if (rows.length === 1 && rows[0].sum.last) {
                parts.push('latest ' + signed(rows[0].sum.last.r, numOpts) + ' ' + rows[0].rateUnits);
            }
            if (rows.length === 1 && rows[0].res.net) {
                parts.push('net ' + signed(rows[0].res.net.rate, numOpts) + ' ' + rows[0].rateUnits);
            }
            return parts.join(' · ');
        }

        /** What did not make it onto the chart, and why: nothing is dropped silently. */
        function extrasText(rows, cfg, method, winMs, centered, notCharted) {
            var out = [];
            var bad = 0, gaps = 0, empty = [];
            for (var i = 0; i < rows.length; i++) {
                bad += rows[i].res.bad;
                gaps += rows[i].res.gaps;
                if (!rows[i].sum.count) { empty.push(rows[i].s.label); }
            }
            if (bad) { out.push(bad + ' bad or non-numeric value' + (bad === 1 ? '' : 's') + ': no rate across ' + (bad === 1 ? 'it' : 'them')); }
            if (gaps) { out.push(gaps + ' gap' + (gaps === 1 ? '' : 's') + ' over ' + PVX.fmt.duration(PVX.util.num(cfg.MaxGapMinutes) * 60000)); }
            if (method !== 'samples' && rows.length && rows.length > empty.length) {
                out.push(centered ? 'no rate in the first and last ' + durationText(winMs / 2)
                    : 'no rate in the first ' + durationText(winMs));
            }
            if (empty.length && rows.length > 1) { out.push('no rate for ' + empty.join(', ')); }
            if (notCharted > 0) { out.push(notCharted + ' more source' + (notCharted === 1 ? '' : 's') + ' not charted (limit ' + rows.length + ')'); }
            return out;
        }

        /* ================================================================== *
         * helpers
         * ================================================================== */

        /** The display's time range, from the items PI Vision (or ownrange) sent. */
        function range(d) {
            var items = d && (d.Data || d.data || (Object.prototype.toString.call(d) === '[object Array]' ? d : null));
            var first = items && items.length ? items[0] : null;
            var f = first ? Date.parse(first.StartTime) : NaN;
            var e = first ? Date.parse(first.EndTime) : NaN;
            return { from: isNaN(f) ? null : f, to: isNaN(e) || !(e > f) ? null : e };
        }

        /** A typed limit as a signed rate: a fall limit is typed positive and charted below zero. */
        function limit(v, sign) {
            var n = PVX.util.num(v === '' ? null : v);
            if (n === null) { return null; }
            return sign * Math.abs(n);
        }

        function rateUnits(units, unit) {
            return units ? units + '/' + UNIT_WORD[unit] : 'per ' + UNIT_WORD[unit];
        }

        function durationText(ms) {
            if (ms % 86400000 === 0) { return (ms / 86400000) + (ms === 86400000 ? ' day' : ' days'); }
            if (ms % 3600000 === 0) { return (ms / 3600000) + ' h'; }
            if (ms % 60000 === 0) { return (ms / 60000) + ' min'; }
            return Math.round(ms / 1000) + ' s';
        }

        function times(n) { return n > 1 ? ' (' + n + ' times)' : ''; }

        function signed(v, numOpts) {
            if (!PVX.util.isNum(v)) { return '--'; }
            var s = numOpts ? PVX.fmt.number(v, numOpts) : PVX.fmt.tick(v);
            return v > 0 ? '+' + s : s;
        }

        /** The plotted rate at time t, read along the trace, or null in a break. */
        function rateAt(res, t) {
            for (var i = 0; i < res.runs.length; i++) {
                var run = res.runs[i];
                if (!run.length || t < run[0].t || t > run[run.length - 1].t) { continue; }
                if (run.length === 1) { return run[0].r; }
                var lo = 0, hi = run.length - 1;
                while (hi - lo > 1) {
                    var mid = (lo + hi) >> 1;
                    if (run[mid].t <= t) { lo = mid; } else { hi = mid; }
                }
                var a = run[lo], b = run[hi];
                return b.t === a.t ? b.r : a.r + (b.r - a.r) * (t - a.t) / (b.t - a.t);
            }
            return null;
        }

        /** The measured value at time t, along PI's straight lines, or null between segments. */
        function valueAt(segs, t) {
            for (var i = 0; i < segs.length; i++) {
                var ps = segs[i].pts;
                if (t < ps[0].t || t > ps[ps.length - 1].t) { continue; }
                for (var j = 1; j < ps.length; j++) {
                    if (t <= ps[j].t) {
                        var a = ps[j - 1], b = ps[j];
                        return b.t === a.t ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
                    }
                }
                return ps[ps.length - 1].v;
            }
            return null;
        }

        function textW(str, fontPx) {
            return String(str === null || str === undefined ? '' : str).length * fontPx * CHAR_W;
        }

        function emptyState(root2, w2, h2, th, headline, detail) {
            var f = PVX.util.clamp(Math.round(Math.min(w2, h2) / 16), 9, 13);
            PVX.svg.fit(PVX.svg.text(root2, (w2 / 2).toFixed(2), (h2 / 2 - f * 0.7).toFixed(2), headline, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': f, 'font-weight': '600', fill: th.textMuted
            }), w2 - 8);
            PVX.svg.fit(PVX.svg.text(root2, (w2 / 2).toFixed(2), (h2 / 2 + f * 0.7).toFixed(2), detail, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': f * 0.9, fill: th.textMuted, opacity: '0.8'
            }), w2 - 8);
        }

        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
