/* ============================================================================
 * pvxTargetForecast: "PVX Target & Forecast" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources, each given a role)
 * @mock forecast
 *
 * One question, asked every shift: are we where we said we would be, and
 * where will we be by the end of it? The actual is a solid line, the target
 * a step line (a plan or setpoint holds until it is changed) with an
 * optional tolerance band, and the forecast a dashed line that carries on
 * past "now", with an optional range from two more sources. A strip of
 * tiles states the answers in numbers: the actual and target now, the gap
 * between them, where the forecast ends against the target there, and how
 * far the forecast has been off the actual so far.
 *
 * ROLES. Each data source is picked by name for its role, as the Deviation
 * chart's are; left on automatic, the first is the actual, the next the
 * target (unless it is typed or read from AF) and the next the forecast.
 * Sources given no role are counted in the footer, never silently ignored.
 *
 * THE FUTURE. PI Vision sends a symbol the display's time range and nothing
 * after it, so with the display ending at now a forecast stops at now. Two
 * ways round it:
 *   - end the display in the future (an end time of *+8h): PI Vision then
 *     sends future values itself, for points that store them;
 *   - or set Look ahead (8h, 1d): the symbol reads the forecast, its range
 *     and a target from a data source, from the display's end onward,
 *     through PI Web API, and extends the time axis to cover it. Off by
 *     default; asked at most once a minute.
 * Either way the region after now is shaded and the now line drawn, and
 * the past part of the forecast is drawn fainter, so a forecast that was
 * wrong earlier in the day stays visible beside what actually happened.
 *
 * PAIRING. Samples of different tags rarely share timestamps. A target is a
 * step value: at any moment the one in force is the last one written at or
 * before it, held to the end of the axis. Actual and forecast are read
 * between their samples by straight lines, the way PI Vision's plot values
 * are drawn, and never beyond their own first and last samples.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Mean advance width of the UI font, in ems (see pvxHistogram). */
    var CHAR_W = 0.58;

    /* A display ending more than this before now is a look back at history,
     * where a look-ahead past its end would draw a forecast beside no actual. */
    var LIVE_SLACK = 5 * 60000;

    /* Look-ahead reads at most this often while the display stays open. */
    var LOOK_EVERY = 60000;

    var definition = {
        typeName: 'pvxTargetForecast',
        displayName: 'PVX Target & Forecast',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        // Positional config, renumbered when a data source is removed.
        sourceRemap: {
            ActualSource: 'indexAuto', TargetSource: 'indexAuto', ForecastSource: 'indexAuto',
            ForecastLowSource: 'indexAuto', ForecastHighSource: 'indexAuto'
        },
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Target & Forecast',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 300,
                Height: 320,
                Width: 520,

                // --- roles: data source numbers, '0' = automatic (low and high: none)
                ActualSource: '0',
                TargetSource: '0',
                ForecastSource: '0',
                ForecastLowSource: '0',     // lower edge of the forecast range
                ForecastHighSource: '0',    // upper edge of the forecast range

                // --- target --------------------------------------------------
                TargetMode: 'series',       // series | fixed | af
                TargetValue: '',            // fixed: one value for the whole axis
                TargetStep: true,           // hold each target until the next one
                ToleranceMode: 'none',      // none | units | percent
                Tolerance: '',              // ± around the target, in units or % of target

                // --- forecast ------------------------------------------------
                LookAhead: '',              // e.g. 8h: read the forecast past the display's end
                LookAheadMaxValues: 5000,   // per source, per read
                ShowPastForecast: true,     // the forecast before now, drawn fainter
                ShowNow: true,              // the now line and the shaded future

                // --- statistics ----------------------------------------------
                ShowStats: true,            // the tiles above the plot
                GapMode: 'absolute',        // absolute | percent: how the gap tile leads

                // --- text ----------------------------------------------------
                Title: '',
                ActualLabel: '',            // blank: Actual
                TargetLabel: '',            // blank: Target
                ForecastLabel: '',          // blank: Forecast
                RangeLabel: '',             // blank: Forecast range
                ShowLegend: true,

                // --- colors: blank follows the theme -------------------------
                ActualColor: '',
                TargetColor: '',
                ForecastColor: '',
                ToleranceColor: '',

                // --- axes ----------------------------------------------------
                ScaleMode: 'auto',          // auto | fixed
                ScaleMin: '',
                ScaleMax: '',
                LineWidth: 1.8,
                SmoothLine: false,
                ShowGrid: true,
                TickCount: 5,
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { title: '', note: '', error: '', background: '' };

        var model = { all: [], raw: [], win: null };

        // Look-ahead: values after the display's end, read through PI Web API.
        var la = { key: '', at: 0, phase: 'off', error: '', extra: {}, to: null, gen: 0, failed: [], capped: [] };
        var laTimer = null;

        // The actual attribute's Target trait, for TargetMode 'af'.
        var traits = PVX.af.watcher(function () { if (ctx && !ctx.destroyed) { ctx.render(); } });

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-tfc-body',
            onData: function (d) {
                model.all = PVX.data.series(d);
                model.raw = rawCounts(d);
                model.win = windowOf(d, model.all);
                askTraits();
                lookAhead(false);
            },
            onConfigChange: function () { askTraits(); lookAhead(true); },
            onDestroy: function () {
                traits.stop();
                if (laTimer) { clearInterval(laTimer); laTimer = null; }
                la.gen += 1;
            },
            render: render
        });

        function cfgNow() { return scope.config || {}; }

        function askTraits() {
            var cfg = cfgNow();
            var ds = (scope.symbol && scope.symbol.DataSources) || [];
            var r = roles(cfg, Math.max(ds.length, model.all.length));
            traits.ask(r.actual >= 0 ? ds[r.actual] : null, cfg.TargetMode === 'af' ? ['Target'] : []);
        }

        /* ================================================================== *
         * look-ahead
         * ================================================================== */

        function lookAhead(force) {
            var cfg = cfgNow();
            var span = PVX.nav.parseSpan(cfg.LookAhead);
            if (!span) { la.phase = cfg.LookAhead ? 'bad' : 'off'; la.extra = {}; la.to = null; la.key = ''; return; }
            var win = model.win;
            if (!win) { return; }
            var now = Date.now();
            if (win.end < now - LIVE_SLACK) { la.phase = 'past'; la.extra = {}; la.to = null; la.key = ''; return; }
            if (PVX.api.discovering()) {
                la.phase = 'finding';
                PVX.api.discover().then(function () { if (!ctx.destroyed) { lookAhead(true); ctx.render(); } });
                return;
            }
            if (!PVX.api.isConfigured()) { la.phase = 'unconfigured'; la.extra = {}; la.to = null; return; }

            var ds = (scope.symbol && scope.symbol.DataSources) || [];
            var r = roles(cfg, Math.max(ds.length, model.all.length));
            var want = [r.forecast, r.low, r.high];
            if (cfg.TargetMode !== 'fixed' && cfg.TargetMode !== 'af') { want.push(r.target); }
            var idx = [], paths = [];
            for (var i = 0; i < want.length; i++) {
                if (want[i] >= 0 && idx.indexOf(want[i]) === -1) {
                    idx.push(want[i]);
                    paths.push(PVX.states.sourcePath(ds[want[i]]));
                }
            }
            if (!idx.length) { la.phase = 'nothing'; la.extra = {}; la.to = null; return; }
            var max = PVX.util.clamp(parseInt(cfg.LookAheadMaxValues, 10) || 5000, 100, 50000);
            var key = paths.join('\n') + '|' + span + '|' + max;
            if (!force && key === la.key && (la.phase === 'ok' || la.phase === 'loading') && now - la.at < LOOK_EVERY) { return; }
            la.key = key;
            la.at = now;
            var from = win.end, to = win.end + span;
            var g = ++la.gen;
            if (la.phase !== 'ok') { la.phase = 'loading'; }
            var jobs = paths.map(function (p) {
                if (!p) { return Promise.resolve({ error: 'no data source path' }); }
                return PVX.api.webIdByPath(p).then(function (id) {
                    return PVX.api.get('streams/' + encodeURIComponent(id) + '/recorded?startTime=' +
                        encodeURIComponent(new Date(from).toISOString()) + '&endTime=' + encodeURIComponent(new Date(to).toISOString()) +
                        '&maxCount=' + max + '&selectedFields=Items.Timestamp;Items.Value;Items.Good', { cache: false });
                }).then(function (res) {
                    var items = (res && res.Items) || [];
                    return { points: recordedPoints(items), capped: items.length >= max };
                }, function (e) {
                    return { error: (e && e.pvxError && e.pvxError.message) || (e && e.message) || 'PI Web API did not answer.' };
                });
            });
            Promise.all(jobs).then(function (got) {
                if (ctx.destroyed || g !== la.gen) { return; }
                la.extra = {};
                la.failed = [];
                la.capped = [];
                for (var j = 0; j < got.length; j++) {
                    var name = sourceName(idx[j]);
                    if (got[j].error) { la.failed.push(name + ': ' + got[j].error); continue; }
                    la.extra[idx[j]] = got[j].points;
                    if (got[j].capped) { la.capped.push(name); }
                }
                la.phase = 'ok';
                la.to = to;
                ctx.render();
            });
            if (!laTimer) {
                laTimer = setInterval(function () { if (!ctx.destroyed) { lookAhead(false); } }, 10000);
            }
        }

        function sourceName(i) {
            var s = model.all[i];
            return s ? s.label : 'source ' + (i + 1);
        }

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

            var svgRoot = host.querySelector('svg.pvx-tfc-svg');
            if (!svgRoot) { svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-tfc-svg' }, host); }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var all = model.all || [];
            var R = roles(cfg, all.length);
            var tMode = cfg.TargetMode === 'fixed' || cfg.TargetMode === 'af' ? cfg.TargetMode : 'series';
            var numOpts = PVX.config.numberOpts(cfg);
            var names = {
                actual: String(cfg.ActualLabel || '').trim() || 'Actual',
                target: String(cfg.TargetLabel || '').trim() || 'Target',
                forecast: String(cfg.ForecastLabel || '').trim() || 'Forecast',
                range: String(cfg.RangeLabel || '').trim() || 'Forecast range'
            };

            var act = R.actual >= 0 ? all[R.actual] : null;
            var tgt = tMode === 'series' && R.target >= 0 ? all[R.target] : null;
            var fc = R.forecast >= 0 ? all[R.forecast] : null;
            var lo = R.low >= 0 ? all[R.low] : null;
            var hi = R.high >= 0 ? all[R.high] : null;

            scope.pvx.error = '';
            var bad = [];
            for (var b = 0; b < R.used.length; b++) {
                var us = all[R.used[b]];
                if (us && !us.good) { bad.push(us.label + ': ' + (us.errorDescription || 'bad data quality')); }
            }
            if (bad.length) { scope.pvx.error = bad.join('; '); }

            var units = (act && act.units) || (fc && fc.units) || (tgt && tgt.units) || '';
            scope.pvx.title = boxH0 < 84 ? '' : (String(cfg.Title || '').trim() || (act
                ? act.label + (units && cfg.ShowUnits !== false ? ' (' + units + ')' : '')
                : 'Actual, target and forecast'));

            /* ---- the points each role draws ------------------------------- */
            var aPts = act ? act.points : [];
            var tPts = tgt ? withExtra(tgt.points, la.extra[R.target]) : [];
            var fPts = fc ? withExtra(fc.points, la.extra[R.forecast]) : [];
            var loPts = lo ? withExtra(lo.points, la.extra[R.low]) : [];
            var hiPts = hi ? withExtra(hi.points, la.extra[R.high]) : [];

            if (!aPts.length && !fPts.length && !tPts.length) {
                scope.pvx.note = all.length && R.unused ? R.unused + ' data source' + (R.unused === 1 ? '' : 's') + ' given no role' : '';
                emptyState(svgRoot, W, H, t, 'No data',
                    !all.length ? 'Drop the actual, target and forecast onto the symbol.'
                        : 'The actual, target and forecast have no numeric values in the time range.');
                digest();
                return;
            }

            var fixedTarget = null;
            if (tMode === 'fixed') { fixedTarget = PVX.util.num(cfg.TargetValue); }
            if (tMode === 'af') { fixedTarget = traits.get('Target'); }
            var step = cfg.TargetStep !== false;
            var targetAt = function (tm) {
                if (tMode !== 'series') { return fixedTarget; }
                return heldAt(tPts, tm, step);
            };
            var hasTarget = tMode === 'series' ? tPts.length > 0 : fixedTarget !== null;

            var tolMode = cfg.ToleranceMode === 'units' || cfg.ToleranceMode === 'percent' ? cfg.ToleranceMode : 'none';
            var tolV = PVX.util.num(cfg.Tolerance);
            if (tolMode !== 'none' && !(tolV > 0)) { tolMode = 'none'; }
            var tolAt = function (v) {
                if (tolMode === 'none' || v === null) { return null; }
                return tolMode === 'units' ? tolV : Math.abs(v) * tolV / 100;
            };

            /* ---- the time axis -------------------------------------------- */
            var now = Date.now();
            var win = model.win || { start: null, end: null };
            var t0 = win.start, t1 = win.end;
            var ext = [aPts, tPts, fPts, loPts, hiPts];
            for (var e = 0; e < ext.length; e++) {
                if (!ext[e].length) { continue; }
                if (t0 === null || ext[e][0].t < t0) { t0 = ext[e][0].t; }
                if (t1 === null || ext[e][ext[e].length - 1].t > t1) { t1 = ext[e][ext[e].length - 1].t; }
            }
            if (la.phase === 'ok' && la.to !== null && la.to > t1) { t1 = la.to; }
            if (!(t1 > t0)) { t1 = t0 + 60000; }
            var split = PVX.util.clamp(now, t0, t1);
            var futureOn = now > t0 && now < t1;

            /* ---- the numbers ----------------------------------------------- */
            var S = summarize();

            /* ---- layout ---------------------------------------------------- */
            var tickFont = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var showTicks = W >= 150 && H >= 100;
            var showTime = W >= 150 && H >= 90;
            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 10);
            var showTiles = cfg.ShowStats !== false && W >= 200 && H >= 150;
            var showLegend = cfg.ShowLegend !== false && W >= 200 && H >= 130;

            var y = 4;
            var tilesBox = null;
            if (showTiles) {
                var tileH = PVX.util.clamp(Math.round(H * 0.17), 40, 58);
                tilesBox = { x: 4, y: y, w: W - 8, h: tileH };
                y += tileH + 6;
            }
            var legendY = 0;
            if (showLegend) { legendY = y + tickFont * 0.75; y += tickFont + 8; }

            // Value domain: everything drawn.
            var vLo = null, vHi = null;
            var take = function (v) {
                if (v === null || !isFinite(v)) { return; }
                if (vLo === null || v < vLo) { vLo = v; }
                if (vHi === null || v > vHi) { vHi = v; }
            };
            var tv = targetVertices();
            var lists = [aPts, fPts, loPts, hiPts];
            for (var l = 0; l < lists.length; l++) {
                for (var q = 0; q < lists[l].length; q++) {
                    if (lists[l][q].t >= t0 && lists[l][q].t <= t1) { take(lists[l][q].v); }
                }
            }
            for (q = 0; q < tv.length; q++) {
                take(tv[q].v);
                var tl = tolAt(tv[q].v);
                if (tl !== null) { take(tv[q].v - tl); take(tv[q].v + tl); }
            }
            if (vLo === null) { vLo = 0; vHi = 1; }
            var dom;
            var sMin = PVX.util.num(cfg.ScaleMin), sMax = PVX.util.num(cfg.ScaleMax);
            if (cfg.ScaleMode === 'fixed' && sMin !== null && sMax !== null && sMax > sMin) {
                dom = [sMin, sMax];
            } else {
                if (!(vHi > vLo)) { vLo -= 1; vHi += 1; }
                dom = PVX.scale.niceDomain(vLo, vHi, tickCount);
                if (!(dom[1] > dom[0])) { dom = [vLo - 1, vHi + 1]; }
            }
            var ticks = PVX.scale.ticks(dom[0], dom[1], tickCount);

            var tickW = 0;
            if (showTicks) {
                for (q = 0; q < ticks.length; q++) { tickW = Math.max(tickW, textW(PVX.fmt.tick(ticks[q]), tickFont)); }
            }
            var mL = Math.min(W * 0.3, 4 + tickW + (tickW ? 5 : 0));
            var mR = 8;
            var mB = showTime ? tickFont + 10 : 4;
            var plot = { x: mL, y: y + 2, w: Math.max(10, W - mL - mR), h: Math.max(10, H - y - 2 - mB) };
            plot.x1 = plot.x + plot.w;
            plot.y1 = plot.y + plot.h;

            var sx = PVX.scale.linear(t0, t1, plot.x, plot.x1);
            var sy = PVX.scale.linear(dom[0], dom[1], plot.y1, plot.y);
            var cy = function (v) { return sy(PVX.util.clamp(v, dom[0], dom[1])); };
            var cs = t.status;
            var cat = t.categorical || PVX.color.categorical;
            var colA = cfg.ActualColor || cfg.AccentColor || cat[0];
            var colT = cfg.TargetColor || t.text;
            var colF = cfg.ForecastColor || cat[1];
            var colTol = cfg.ToleranceColor || cs.normal;
            var lw = PVX.util.clamp(PVX.util.num(cfg.LineWidth) || 1.8, 0.5, 8);

            /* ---- the future ------------------------------------------------ */
            if (cfg.ShowNow !== false && futureOn) {
                PVX.svg.el('rect', {
                    x: sx(now).toFixed(2), y: plot.y.toFixed(2), width: Math.max(0, plot.x1 - sx(now)).toFixed(2),
                    height: plot.h.toFixed(2), fill: t.text, 'fill-opacity': t.dark ? 0.07 : 0.045, 'class': 'pvx-tfc-future'
                }, svgRoot);
            }

            if (cfg.ShowGrid !== false) {
                for (q = 0; q < ticks.length; q++) { hline(plot, sy(ticks[q]), t.grid, null, 1); }
            }

            /* ---- tolerance band and target -------------------------------- */
            if (tolMode !== 'none' && tv.length) {
                var up = [], dn = [];
                for (q = 0; q < tv.length; q++) {
                    var tt = tolAt(tv[q].v);
                    up.push({ x: sx(tv[q].t), y: cy(tv[q].v + tt) });
                    dn.unshift({ x: sx(tv[q].t), y: cy(tv[q].v - tt) });
                }
                PVX.svg.el('path', {
                    d: PVX.svg.line(up.concat(dn), false) + ' Z', fill: colTol, 'fill-opacity': 0.14, stroke: 'none',
                    'class': 'pvx-tfc-tol'
                }, svgRoot);
            }

            /* ---- forecast range ------------------------------------------- */
            if (loPts.length && hiPts.length) {
                var bandUp = [], bandDn = [];
                for (q = 0; q < hiPts.length; q++) {
                    if (hiPts[q].t >= t0 && hiPts[q].t <= t1) { bandUp.push({ x: sx(hiPts[q].t), y: cy(hiPts[q].v) }); }
                }
                for (q = loPts.length - 1; q >= 0; q--) {
                    if (loPts[q].t >= t0 && loPts[q].t <= t1) { bandDn.push({ x: sx(loPts[q].t), y: cy(loPts[q].v) }); }
                }
                if (bandUp.length && bandDn.length) {
                    PVX.svg.el('path', {
                        d: PVX.svg.line(bandUp.concat(bandDn), false) + ' Z', fill: colF, 'fill-opacity': 0.16, stroke: 'none',
                        'class': 'pvx-tfc-range'
                    }, svgRoot);
                }
            }

            if (tv.length) {
                var txy = [];
                for (q = 0; q < tv.length; q++) { txy.push({ x: sx(tv[q].t), y: cy(tv[q].v) }); }
                PVX.svg.el('path', {
                    d: PVX.svg.line(txy, false), fill: 'none', stroke: colT, 'stroke-width': Math.max(1, lw * 0.8).toFixed(2),
                    'stroke-opacity': 0.85, 'stroke-linejoin': 'miter', 'class': 'pvx-tfc-target'
                }, svgRoot);
            }

            /* ---- forecast: faint before now, full after ------------------- */
            if (fPts.length) {
                var past = [], fut = [];
                var fs = forecastSplit();
                for (q = 0; q < fs.past.length; q++) { past.push({ x: sx(fs.past[q].t), y: cy(fs.past[q].v) }); }
                for (q = 0; q < fs.future.length; q++) { fut.push({ x: sx(fs.future[q].t), y: cy(fs.future[q].v) }); }
                if (past.length > 1 && cfg.ShowPastForecast !== false) {
                    PVX.svg.el('path', {
                        d: PVX.svg.line(past, !!cfg.SmoothLine), fill: 'none', stroke: colF, 'stroke-width': lw.toFixed(2),
                        'stroke-dasharray': '5 4', 'stroke-opacity': 0.45, 'class': 'pvx-tfc-forecast pvx-tfc-forecast-past'
                    }, svgRoot);
                }
                if (fut.length > 1) {
                    PVX.svg.el('path', {
                        d: PVX.svg.line(fut, !!cfg.SmoothLine), fill: 'none', stroke: colF, 'stroke-width': lw.toFixed(2),
                        'stroke-dasharray': '6 4', 'class': 'pvx-tfc-forecast'
                    }, svgRoot);
                }
                if (S.fEnd) { dot(sx(S.fEnd.t), cy(S.fEnd.v), colF); }
            }

            /* ---- actual ---------------------------------------------------- */
            if (aPts.length) {
                var axy = [];
                for (q = 0; q < aPts.length; q++) {
                    if (aPts[q].t >= t0 && aPts[q].t <= t1) { axy.push({ x: sx(aPts[q].t), y: cy(aPts[q].v) }); }
                }
                PVX.svg.el('path', {
                    d: PVX.svg.line(axy, !!cfg.SmoothLine), fill: 'none', stroke: colA, 'stroke-width': lw.toFixed(2),
                    'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'class': 'pvx-tfc-actual'
                }, svgRoot);
                if (S.aNow) { dot(sx(S.aNow.t), cy(S.aNow.v), colA); }
            }

            /* ---- now line -------------------------------------------------- */
            if (cfg.ShowNow !== false && futureOn) {
                var xn = sx(now);
                PVX.svg.el('line', {
                    x1: xn.toFixed(2), y1: plot.y.toFixed(2), x2: xn.toFixed(2), y2: plot.y1.toFixed(2),
                    stroke: t.textMuted, 'stroke-width': 1, 'stroke-dasharray': '2 3', 'class': 'pvx-tfc-now'
                }, svgRoot);
                if (plot.w > 120 && plot.h > 40) {
                    var nowRight = plot.x1 - xn > textW('Now', tickFont * 0.85) + 6;
                    PVX.svg.text(svgRoot, (nowRight ? xn + 3 : xn - 3).toFixed(2), (plot.y + tickFont * 0.85).toFixed(2), 'Now', {
                        'class': 'pvx-svg-label pvx-tfc-now-label', 'font-size': (tickFont * 0.85).toFixed(1), fill: t.textMuted,
                        'text-anchor': nowRight ? 'start' : 'end'
                    });
                }
            }

            /* ---- axes ------------------------------------------------------ */
            hline(plot, plot.y1, t.axis, null, 1);
            PVX.svg.el('line', {
                x1: plot.x.toFixed(2), y1: plot.y.toFixed(2), x2: plot.x.toFixed(2), y2: plot.y1.toFixed(2),
                stroke: t.axis, 'stroke-width': 1
            }, svgRoot);
            if (showTicks) {
                for (q = 0; q < ticks.length; q++) {
                    PVX.svg.text(svgRoot, (plot.x - 4).toFixed(2), (sy(ticks[q]) + tickFont * 0.35).toFixed(2), PVX.fmt.tick(ticks[q]), {
                        'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end', 'font-size': tickFont, fill: t.textMuted
                    });
                }
            }
            if (showTime) {
                var n = Math.max(2, Math.min(6, Math.floor(plot.w / (11 * tickFont * CHAR_W + 10))));
                var yTime = plot.y1 + 4 + tickFont * 0.85;
                for (q = 0; q < n; q++) {
                    var tm = t0 + (t1 - t0) * q / (n - 1);
                    var str = PVX.fmt.time(tm, 'short');
                    var x = sx(tm), w = textW(str, tickFont), anchor = 'middle';
                    if (x - w / 2 < 1) { anchor = 'start'; x = Math.max(1, x); }
                    else if (x + w / 2 > W - 1) { anchor = 'end'; x = Math.min(W - 1, x); }
                    PVX.svg.text(svgRoot, x.toFixed(2), yTime.toFixed(2), str, {
                        'class': 'pvx-svg-label pvx-num', 'text-anchor': anchor, 'font-size': tickFont, fill: t.textMuted
                    });
                }
            }

            /* ---- legend and tiles ------------------------------------------ */
            if (showLegend) { drawLegend(); }
            if (tilesBox) { drawTiles(); }

            /* ---- hover: one slice per few pixels, each with its readings --- */
            drawHits();

            /* ---- footer ---------------------------------------------------- */
            var notes = [];
            if (!act) { notes.push('no actual source'); }
            if (!hasTarget) {
                notes.push(tMode === 'fixed' ? 'no target value set'
                    : tMode === 'af' ? (traits.phase === 'loading' ? 'reading the Target trait from AF'
                        : traits.phase === 'error' ? 'target from AF: ' + traits.error : 'the actual has no Target trait in AF')
                    : 'no target source');
            }
            if (!fc) { notes.push('no forecast source'); }
            if (R.unused) { notes.push(R.unused + ' data source' + (R.unused === 1 ? '' : 's') + ' given no role'); }
            var dropped = 0;
            for (b = 0; b < R.used.length; b++) {
                var ri = R.used[b];
                dropped += Math.max(0, (model.raw[ri] || 0) - (all[ri] ? all[ri].points.length : 0));
            }
            if (dropped) { notes.push(dropped + ' non-numeric value' + (dropped === 1 ? '' : 's') + ' left out'); }
            if ((lo && !hi) || (hi && !lo)) { notes.push('a forecast range needs both a low and a high source'); }
            var lan = lookNote(cfg);
            if (lan) { notes.push(lan); }
            if (tMode === 'af' && hasTarget) { notes.push('target from AF'); }
            scope.pvx.note = notes.join(' · ');

            digest();

            /* ---- closures over this frame ---------------------------------- */

            /** The target line's corners across the axis, steps included. */
            function targetVertices() {
                var out = [];
                if (!hasTarget) { return out; }
                if (tMode !== 'series') {
                    return [{ t: t0, v: fixedTarget }, { t: t1, v: fixedTarget }];
                }
                // The value in force at the left edge, then each change inside
                // the axis, then held to the right edge.
                var first = heldAt(tPts, t0, step);
                if (first !== null) { out.push({ t: t0, v: first }); }
                for (var i = 0; i < tPts.length; i++) {
                    var p = tPts[i];
                    if (p.t <= t0 || p.t > t1) { continue; }
                    if (step && out.length) { out.push({ t: p.t, v: out[out.length - 1].v }); }
                    out.push({ t: p.t, v: p.v });
                }
                if (out.length) { out.push({ t: t1, v: heldAt(tPts, t1, step) }); }
                return out;
            }

            function forecastSplit() {
                var pastPts = [], futPts = [];
                var atSplit = lineAt(fPts, split);
                for (var i = 0; i < fPts.length; i++) {
                    var p = fPts[i];
                    if (p.t < t0 || p.t > t1) { continue; }
                    if (p.t <= split) { pastPts.push(p); } else { futPts.push(p); }
                }
                if (atSplit !== null) {
                    pastPts.push({ t: split, v: atSplit });
                    futPts.unshift({ t: split, v: atSplit });
                }
                // Nothing after now, as on a display that looks back: all of
                // it is what the forecast said, drawn at full strength.
                if (!futureOn && now >= t1) { return { past: [], future: pastPts }; }
                return { past: pastPts, future: futPts };
            }

            function summarize() {
                var out = { aNow: null, tNow: null, gap: null, gapPct: null, inTol: null,
                    fEnd: null, tEnd: null, gapEnd: null, cross: null, mae: null, bias: null, pairs: 0 };
                if (aPts.length) {
                    out.aNow = aPts[aPts.length - 1];
                    out.tNow = targetAt(out.aNow.t);
                    if (out.tNow !== null) {
                        out.gap = out.aNow.v - out.tNow;
                        out.gapPct = out.tNow !== 0 ? out.gap / Math.abs(out.tNow) * 100 : null;
                        var tol = tolAt(out.tNow);
                        out.inTol = tol === null ? null : Math.abs(out.gap) <= tol;
                    }
                }
                if (fPts.length) {
                    out.fEnd = fPts[fPts.length - 1];
                    out.tEnd = targetAt(out.fEnd.t);
                    if (out.tEnd !== null) { out.gapEnd = out.fEnd.v - out.tEnd; }
                    out.cross = hasTarget ? crossing(out.aNow ? out.aNow.t : split) : null;
                    // How far the forecast has been off what happened.
                    var sumAbs = 0, sum = 0, n2 = 0;
                    for (var k = 0; k < aPts.length; k++) {
                        var fv = lineAt(fPts, aPts[k].t);
                        if (fv === null) { continue; }
                        sumAbs += Math.abs(fv - aPts[k].v);
                        sum += fv - aPts[k].v;
                        n2++;
                    }
                    if (n2 >= 3) { out.mae = sumAbs / n2; out.bias = sum / n2; out.pairs = n2; }
                }
                return out;
            }

            /**
             * The first time after `from` that the forecast crosses the
             * target: {t, up}, or null. Between two neighbouring times the
             * forecast is a straight line and the target is flat or a straight
             * line too, so the gap crosses zero where its straight line does.
             * A stepped target can also cross by jumping over the forecast;
             * the times it changes are checked on both sides, and a jump
             * across is the crossing, at the moment of the step.
             */
            function crossing(from) {
                var times = [], i;
                for (i = 0; i < fPts.length; i++) { if (fPts[i].t >= from) { times.push(fPts[i].t); } }
                var stepped = tMode === 'series' && step;
                if (tMode === 'series' && times.length) {
                    var last = fPts[fPts.length - 1].t;
                    for (i = 0; i < tPts.length; i++) {
                        if (tPts[i].t > from && tPts[i].t < last) { times.push(tPts[i].t); }
                    }
                    times.sort(function (a, b) { return a - b; });
                }
                var flips = function (a, b) { return (a < 0 && b >= 0) || (a > 0 && b <= 0); };
                var prev = null;
                for (i = 0; i < times.length; i++) {
                    var tm = times[i];
                    if (prev && tm === prev.t) { continue; }
                    var fv = lineAt(fPts, tm);
                    var tg = targetAt(tm);
                    if (fv === null || tg === null) { continue; }
                    var d = fv - tg;
                    // Just before a step, the target still holds its old value.
                    var before = stepped && prev ? heldAt(tPts, tm - 1, true) : tg;
                    var dB = before === null ? d : fv - before;
                    if (prev && flips(prev.d, dB)) {
                        var f = prev.d === dB ? 0 : prev.d / (prev.d - dB);
                        return { t: prev.t + (tm - prev.t) * f, up: dB >= 0 };
                    }
                    if (prev && dB !== d && flips(dB, d)) { return { t: tm, up: d >= 0 }; }
                    prev = { t: tm, d: d };
                }
                return null;
            }

            function drawTiles() {
                var u = units ? ' ' + units : '';
                var tiles = [];
                var aSub = S.aNow ? PVX.fmt.time(S.aNow.t, 'short') : 'no value';
                tiles.push({ key: 'actual', pri: 1, label: names.actual, value: S.aNow ? fmtV(S.aNow.v) : '--', sub: aSub,
                    color: colA, tip: names.actual + ': ' + (S.aNow ? fmtV(S.aNow.v) + u + ' at ' + PVX.fmt.time(S.aNow.t, 'datetime') : 'no value') });
                var tolTxt = tolMode === 'none' || S.tNow === null ? '' : '± ' + fmtV(tolAt(S.tNow)) + u;
                tiles.push({ key: 'target', pri: 2, label: names.target, value: S.tNow !== null ? fmtV(S.tNow) : '--',
                    sub: tolTxt || (tMode === 'af' ? 'from AF' : tMode === 'fixed' ? 'fixed' : ''), color: colT,
                    tip: names.target + ': ' + (S.tNow !== null ? fmtV(S.tNow) + u + (tolTxt ? ' ' + tolTxt : '') : 'none') });
                var gapTone = S.inTol === null ? t.text : (S.inTol ? cs.normal : cs.warning);
                var gapAbs = S.gap !== null ? signed(S.gap) : '--';
                var gapPct = S.gapPct !== null ? signed(S.gapPct, 1) + '%' : '';
                var pctLead = cfg.GapMode === 'percent' && gapPct;
                tiles.push({ key: 'gap', pri: 0, label: 'Gap', value: pctLead ? gapPct : gapAbs,
                    sub: S.inTol === null ? (pctLead ? gapAbs + u : gapPct ? gapPct + ' of target' : '') : (S.inTol ? 'in tolerance' : 'out of tolerance'),
                    color: gapTone,
                    tip: 'Gap: ' + names.actual + ' minus ' + names.target + ' = ' + (S.gap !== null ? signed(S.gap) + u : 'no target') +
                        (gapPct ? ' (' + gapPct + ' of target)' : '') +
                        (S.inTol === null ? '' : S.inTol ? ', in tolerance' : ', out of tolerance') });
                if (fc) {
                    var fSub = S.cross ? (S.cross.up ? 'reaches ' : 'falls to ') + names.target.toLowerCase() + ' ' + hhmm(S.cross.t)
                        : S.gapEnd !== null ? signed(S.gapEnd) + ' vs ' + names.target.toLowerCase() : '';
                    tiles.push({ key: 'forecast', pri: 3, label: names.forecast + (S.fEnd ? ' ' + hhmm(S.fEnd.t) : ''),
                        value: S.fEnd ? fmtV(S.fEnd.v) : '--', sub: fSub, color: colF,
                        tip: names.forecast + ' at its end: ' + (S.fEnd ? fmtV(S.fEnd.v) + u + ' at ' + PVX.fmt.time(S.fEnd.t, 'datetime') : 'no value') +
                            (S.gapEnd !== null ? '; ' + signed(S.gapEnd) + u + ' against the ' + names.target.toLowerCase() + ' then' : '') +
                            (S.cross ? '; crosses the ' + names.target.toLowerCase() + ' at ' + PVX.fmt.time(S.cross.t, 'datetime') : '') });
                    tiles.push({ key: 'error', pri: 4, label: names.forecast + ' error', value: S.mae !== null ? '± ' + fmtV(S.mae) : '--',
                        sub: S.mae !== null ? 'bias ' + signed(S.bias) : 'no overlap yet', color: t.text,
                        tip: S.mae !== null ? names.forecast + ' error so far: mean absolute ' + fmtV(S.mae) + u + ', bias ' + signed(S.bias) + u +
                            ' (forecast minus actual) over ' + S.pairs + ' samples'
                            : names.forecast + ' error: fewer than three ' + names.actual.toLowerCase() + ' samples inside the forecast to compare' });
                }
                // An inline size: the shared label class fixes SVG text at
                // 10px, which reads as a caption, not as the number a tile
                // is there to give.
                var px = function (n) { return 'font-size:' + n + 'px'; };
                var fit = Math.max(1, Math.min(tiles.length, Math.floor((tilesBox.w + 6) / 92)));
                var keep = tiles.slice().sort(function (p1, p2) { return p1.pri - p2.pri; }).slice(0, fit);
                var shown = tiles.filter(function (x) { return keep.indexOf(x) !== -1; });
                var gapX = 6;
                var tw = (tilesBox.w - gapX * (shown.length - 1)) / shown.length;
                var lf = PVX.util.clamp(Math.round(tilesBox.h * 0.2), 8, 11);
                var vf = PVX.util.clamp(Math.round(tilesBox.h * 0.36), 11, 22);
                for (var i = 0; i < shown.length; i++) {
                    var tl2 = shown[i];
                    var x0 = tilesBox.x + i * (tw + gapX);
                    var g = PVX.svg.el('g', { 'class': 'pvx-tfc-tile pvx-tfc-tile-' + tl2.key }, svgRoot);
                    PVX.svg.el('path', {
                        d: PVX.svg.roundRect(x0, tilesBox.y, tw, tilesBox.h, 5), fill: t.surfaceAlt || t.track,
                        stroke: t.border, 'stroke-width': 1
                    }, g);
                    PVX.svg.el('rect', { x: (x0 + 1).toFixed(2), y: (tilesBox.y + 5).toFixed(2), width: 3, height: (tilesBox.h - 10).toFixed(2),
                        fill: tl2.color, rx: 1.5 }, g);
                    var tx = x0 + 10, maxW = tw - 14;
                    PVX.svg.fit(PVX.svg.text(g, tx.toFixed(2), (tilesBox.y + lf + 3).toFixed(2), tl2.label, {
                        'class': 'pvx-svg-label', style: px(lf), fill: t.textMuted
                    }), maxW);
                    PVX.svg.fit(PVX.svg.text(g, tx.toFixed(2), (tilesBox.y + lf + 4 + vf).toFixed(2), tl2.value, {
                        'class': 'pvx-svg-label pvx-num pvx-tfc-tile-value', style: px(vf), 'font-weight': '600',
                        fill: tl2.key === 'gap' ? tl2.color : t.text
                    }), maxW);
                    if (tl2.sub && tilesBox.h >= 46) {
                        PVX.svg.fit(PVX.svg.text(g, tx.toFixed(2), (tilesBox.y + tilesBox.h - 5).toFixed(2), tl2.sub, {
                            'class': 'pvx-svg-label pvx-num', style: px(Math.max(8, lf - 1)), fill: t.textMuted
                        }), maxW);
                    }
                    PVX.svg.el('title', null, g).textContent = tl2.tip;
                }
            }

            function drawLegend() {
                var items = [];
                if (act) { items.push({ label: names.actual, kind: 'line', color: colA }); }
                if (hasTarget) { items.push({ label: names.target, kind: 'line', color: colT }); }
                if (tolMode !== 'none' && hasTarget) { items.push({ label: 'Tolerance', kind: 'band', color: colTol }); }
                if (fc) { items.push({ label: names.forecast, kind: 'dash', color: colF }); }
                if (lo && hi) { items.push({ label: names.range, kind: 'band', color: colF }); }
                var fsz = tickFont * 0.95;
                var x = plot.x;
                for (var i = 0; i < items.length; i++) {
                    var it = items[i];
                    var need = 18 + textW(it.label, fsz) + 12;
                    if (x + 18 + 24 > W - 4) { break; }
                    var g = PVX.svg.el('g', { 'class': 'pvx-tfc-key' }, svgRoot);
                    var ky = legendY - fsz * 0.3;
                    if (it.kind === 'band') {
                        PVX.svg.el('rect', { x: x.toFixed(2), y: (ky - 4).toFixed(2), width: 14, height: 8, fill: it.color, 'fill-opacity': 0.3 }, g);
                    } else {
                        var a = { x1: x.toFixed(2), y1: ky.toFixed(2), x2: (x + 14).toFixed(2), y2: ky.toFixed(2), stroke: it.color, 'stroke-width': 2 };
                        if (it.kind === 'dash') { a['stroke-dasharray'] = '4 2'; }
                        PVX.svg.el('line', a, g);
                    }
                    var room = Math.min(need - 18, W - 4 - (x + 18));
                    PVX.svg.fit(PVX.svg.text(g, (x + 18).toFixed(2), legendY.toFixed(2), it.label, {
                        'class': 'pvx-svg-label pvx-tfc-legend-text', 'font-size': fsz.toFixed(1), fill: t.textMuted
                    }), room);
                    x += need;
                }
            }

            function drawHits() {
                if (plot.w < 40 || plot.h < 20) { return; }
                var slices = PVX.util.clamp(Math.floor(plot.w / 6), 8, 160);
                var sw = plot.w / slices;
                var u = units ? ' ' + units : '';
                var g = PVX.svg.el('g', { 'class': 'pvx-tfc-hits' }, svgRoot);
                for (var i = 0; i < slices; i++) {
                    var tm2 = t0 + (t1 - t0) * (i + 0.5) / slices;
                    var lines = [PVX.fmt.time(tm2, 'datetime')];
                    var av = lineAt(aPts, tm2), tg = targetAt(tm2), fv = lineAt(fPts, tm2);
                    if (av !== null) { lines.push(names.actual + ': ' + fmtV(av) + u); }
                    if (tg !== null) { lines.push(names.target + ': ' + fmtV(tg) + u); }
                    if (fv !== null) { lines.push(names.forecast + ': ' + fmtV(fv) + u); }
                    if (lo && hi) {
                        var lv = lineAt(loPts, tm2), hv = lineAt(hiPts, tm2);
                        if (lv !== null && hv !== null) { lines.push(names.range + ': ' + fmtV(lv) + ' to ' + fmtV(hv) + u); }
                    }
                    if (tg !== null && (av !== null || fv !== null)) {
                        lines.push('Gap: ' + signed((av !== null ? av : fv) - tg) + u + (av !== null ? '' : ' (forecast)'));
                    }
                    if (lines.length < 2) { continue; }
                    var r = PVX.svg.el('rect', {
                        x: (plot.x + i * sw).toFixed(2), y: plot.y.toFixed(2), width: sw.toFixed(2), height: plot.h.toFixed(2),
                        fill: 'transparent', 'class': 'pvx-tfc-hit'
                    }, g);
                    PVX.svg.el('title', null, r).textContent = lines.join('\n');
                }
            }

            function dot(x, y2, color) {
                PVX.svg.el('circle', {
                    cx: x.toFixed(2), cy: y2.toFixed(2), r: Math.max(2.5, lw + 1).toFixed(2), fill: color,
                    stroke: cfg.Transparent ? 'none' : t.surface, 'stroke-width': 1, 'class': 'pvx-tfc-dot'
                }, svgRoot);
            }

            function hline(box, yy, stroke, dash, width) {
                if (!PVX.util.isNum(yy)) { return; }
                var a = {
                    x1: box.x.toFixed(2), y1: yy.toFixed(2), x2: box.x1.toFixed(2), y2: yy.toFixed(2),
                    stroke: stroke, 'stroke-width': width || 1, 'class': 'pvx-tfc-ref'
                };
                if (dash) { a['stroke-dasharray'] = dash; }
                PVX.svg.el('line', a, svgRoot);
            }

            function fmtV(v) { return PVX.fmt.number(v, numOpts); }
            function signed(v, dec) {
                if (v === null || !isFinite(v)) { return '--'; }
                var s = dec !== undefined ? Math.abs(v).toFixed(dec) : PVX.fmt.number(Math.abs(v), numOpts);
                return (v > 0 ? '+' : v < 0 ? '−' : '') + s;
            }
        }

        /** What the look-ahead is doing, for the footer; '' when it is off. */
        function lookNote(cfg) {
            if (la.phase === 'off') { return ''; }
            var what = 'look-ahead ' + String(cfg.LookAhead).trim();
            switch (la.phase) {
                case 'bad': return what + ' is not a length of time (try 8h or 1d)';
                case 'past': return what + ' is off: the display ends before now';
                case 'finding':
                case 'loading': return what + ': reading from PI Web API';
                case 'unconfigured': return what + ' needs PI Web API: ' + PVX.api.unsetHint();
                case 'nothing': return what + ': no forecast or target source to read';
                default:
                    var bits = [what + ' from PI Web API'];
                    if (la.capped.length) { bits.push('only the first ' + (parseInt(cfg.LookAheadMaxValues, 10) || 5000) + ' values of ' + la.capped.join(', ')); }
                    if (la.failed.length) { bits.push('not read: ' + la.failed.join('; ')); }
                    return bits.join(', ');
            }
        }

        /* ================================================================== *
         * helpers
         * ================================================================== */

        /**
         * Which data source plays each role: {actual, target, forecast, low,
         * high} as 0-based indexes (-1 for none), plus the indexes used and a
         * count of those given no role. A picked source wins; automatic roles
         * take the first sources nobody picked, in order. The forecast range
         * is never automatic: two stray tags would draw a band that means
         * nothing.
         */
        function roles(cfg, n) {
            var pick = function (k) {
                var i = parseInt(cfg[k], 10);
                return i >= 1 && i <= n ? i - 1 : -1;
            };
            var r = { actual: pick('ActualSource'), target: -1, forecast: pick('ForecastSource'),
                low: pick('ForecastLowSource'), high: pick('ForecastHighSource') };
            var series = cfg.TargetMode !== 'fixed' && cfg.TargetMode !== 'af';
            if (series) { r.target = pick('TargetSource'); }
            var taken = {};
            var mark = function (i) { if (i >= 0) { taken[i] = true; } };
            mark(r.actual); mark(r.target); mark(r.forecast); mark(r.low); mark(r.high);
            var next = function () {
                for (var i = 0; i < n; i++) { if (!taken[i]) { taken[i] = true; return i; } }
                return -1;
            };
            if (r.actual < 0) { r.actual = next(); }
            if (series && r.target < 0) { r.target = next(); }
            if (r.forecast < 0) { r.forecast = next(); }
            var used = [];
            var add = function (i) { if (i >= 0 && used.indexOf(i) === -1) { used.push(i); } };
            add(r.actual); add(r.target); add(r.forecast); add(r.low); add(r.high);
            r.used = used;
            r.unused = Math.max(0, n - used.length);
            return r;
        }

        /** Samples PI Vision sent per source, numeric or not, for the footer. */
        function rawCounts(d) {
            var items = d && (d.Data || d.data);
            var out = [];
            for (var i = 0; items && i < items.length; i++) {
                var vals = (items[i] && (items[i].Value || items[i].Values)) || [];
                out.push(vals.length);
            }
            return out;
        }

        /**
         * The time range PI Vision asked for, from the items' StartTime and
         * EndTime, else null so the axis is laid out from the data. Taking it
         * from the payload rather than the address keeps the symbol right
         * under its own time range (PVX.ownrange sets both).
         */
        function windowOf(d, all) {
            var items = d && (d.Data || d.data);
            var s = null, e = null;
            var take = function (o) {
                if (!o) { return; }
                var a = PVX.fmt.toDate(o.StartTime || o.startTime), b = PVX.fmt.toDate(o.EndTime || o.endTime);
                if (a && (s === null || a.getTime() < s)) { s = a.getTime(); }
                if (b && (e === null || b.getTime() > e)) { e = b.getTime(); }
            };
            take(d);
            for (var i = 0; items && i < items.length; i++) { take(items[i]); }
            if (e === null) {
                // No window named: the data's own extent, so a look-ahead
                // starts from the newest value PI Vision sent.
                for (i = 0; i < all.length; i++) {
                    var p = all[i].points;
                    if (!p.length) { continue; }
                    if (s === null || p[0].t < s) { s = p[0].t; }
                    if (e === null || p[p.length - 1].t > e) { e = p[p.length - 1].t; }
                }
            }
            return e === null ? null : { start: s, end: e };
        }

        /** Recorded items -> [{t, v}], numbers only, good values only. */
        function recordedPoints(items) {
            var out = [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i] || {};
                if (it.Good === false) { continue; }
                var v = it.Value;
                if (v !== null && typeof v === 'object') { v = v.Value; }
                v = PVX.util.num(v);
                var dt = PVX.fmt.toDate(it.Timestamp);
                if (v === null || !dt) { continue; }
                out.push({ t: dt.getTime(), v: v });
            }
            out.sort(function (a, b) { return a.t - b.t; });
            return out;
        }

        /** The pipeline's points, then look-ahead points after the last of them. */
        function withExtra(pts, extra) {
            if (!extra || !extra.length) { return pts; }
            var last = pts.length ? pts[pts.length - 1].t : -Infinity;
            var out = pts.slice();
            for (var i = 0; i < extra.length; i++) { if (extra[i].t > last) { out.push(extra[i]); } }
            return out;
        }

        /** Index of the last point at or before tm, or -1. */
        function lastAtOrBefore(pts, tm) {
            var a = 0, b = pts.length - 1, hit = -1;
            while (a <= b) {
                var m = (a + b) >> 1;
                if (pts[m].t <= tm) { hit = m; a = m + 1; } else { b = m - 1; }
            }
            return hit;
        }

        /** Read between samples by a straight line; null outside them. */
        function lineAt(pts, tm) {
            if (!pts.length || tm < pts[0].t || tm > pts[pts.length - 1].t) { return null; }
            var i = lastAtOrBefore(pts, tm);
            if (i < 0) { return null; }
            if (i === pts.length - 1 || pts[i].t === tm) { return pts[i].v; }
            var p = pts[i], q = pts[i + 1];
            return p.v + (q.v - p.v) * (tm - p.t) / (q.t - p.t);
        }

        /** A target at tm: the one in force (step) or between samples, held after the last. */
        function heldAt(pts, tm, step) {
            if (!pts.length) { return null; }
            var i = lastAtOrBefore(pts, tm);
            if (i < 0) { return null; }
            if (step || i === pts.length - 1) { return pts[i].v; }
            return lineAt(pts, tm);
        }

        /** "14:20": the clock time alone, where the date is the axis's job. */
        function hhmm(tm) { return PVX.fmt.time(tm, 'short').slice(6); }

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
