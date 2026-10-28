/* ============================================================================
 * pvxOperatingMap — live operating point on a compressor (or pump) map
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources)
 *   1st  X — usually actual inlet flow
 *   2nd  Y — usually polytropic head (an AF analysis; this symbol plots it, it
 *        does not calculate it)
 *   3rd  optional — a STRING attribute holding the curve spec (see below)
 * @mock compressor
 *
 * A compressor map lives in a vendor PDF, so "how close are we to surge" gets
 * answered by eye or not at all. This symbol draws the map — surge line,
 * control line, speed lines, stonewall — and puts the live operating point on
 * it, with a fading trail so the operator sees which way it is heading, and
 * the surge margin as a number.
 *
 * Curve spec, the same grammar in the config pane and in an AF attribute:
 *
 *   surge: 3000:8000 4100:14600 4700:19000 | control: ... |
 *   90%: 4100:14600 6200:13900 8000:12000 | stonewall: 7000:5200 9400:9200
 *
 * Entries separate on "|" or newlines; each is  name: x:y x:y ... . "surge",
 * "control" and "stonewall" are reserved; any other name is a speed line and
 * the name is its label. Keeping the spec on the compressor's AF element and
 * binding it as the third data source is what makes asset swapping safe:
 * config travels with the symbol, so a map in config stays put when the
 * display switches to a different machine and silently shows the wrong one.
 *
 * Surge margin = (Q - Qsurge) / Qsurge, where Qsurge is the surge-line flow at
 * the CURRENT head. That is the common flow-based definition; an anti-surge
 * controller may define it differently, and when it publishes its own margin
 * that number is authoritative — plot this as the picture, not the protection.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* History dots beyond this are uniformly sampled; the footer says so. */
    var MAX_HISTORY = 1500;

    var definition = {
        typeName: 'pvxOperatingMap',
        displayName: 'PVX Operating Map',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Operating Map',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 300,
                Height: 320,
                Width: 480,

                Title: '',

                // Curves
                CurveSource: 'auto',        // auto | config
                Curves: '',
                ControlMarginPct: 10,       // derives a control line when none is given; 0 = none

                // Margin bands, on surge margin in percent. Shared grammar.
                Thresholds: '-1000000:#8f1f14:Past surge line, 0:#c8452f:Alarm, 10:#d99024:Warning, 20:#2f9e5f:Normal',

                // Points
                TrailMinutes: 30,
                ShowHistory: true,
                MaxPairGapSeconds: 60,

                // Axes
                XLabel: '',
                YLabel: '',
                XMin: '',
                XMax: '',
                YMin: '',
                YMax: '',
                TickCount: 5,
                ShowGrid: true,
                ShowSpeedLabels: true,
                ShowMarginMarker: true,

                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            title: '',
            badge: '',
            badgeColor: '',
            badgeBg: '',
            note: '',
            error: ''
        };

        var model = {
            xs: null,
            ys: null,
            curveRaw: null,     // latest string value of the 3rd source, if any
            curveLabel: '',
            extraCount: 0,
            pairs: [],
            dropped: 0
        };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-opmap-body',

            onData: function (d) {
                var nums = PVX.data.series(d);
                model.xs = nums.length > 0 ? nums[0] : null;
                model.ys = nums.length > 1 ? nums[1] : null;
                // The curve spec is a string, which series() discards; read the
                // third source through stateSeries, which keeps raw values.
                var raw = PVX.data.stateSeries(d);
                model.curveRaw = null;
                model.curveLabel = '';
                if (raw.length > 2 && raw[2].points.length) {
                    model.curveRaw = raw[2].points[raw[2].points.length - 1].raw;
                    model.curveLabel = raw[2].label;
                }
                model.extraCount = Math.max(0, raw.length - 3);
                rebuildPairs(ctx.config || scope.config || {});
            },

            onConfigChange: function (newCfg) { rebuildPairs(newCfg || {}); },

            render: render
        });

        /* ================================================================== *
         * pairing — identical semantics to pvxXYScatter: each Y sample takes
         * the X value in force at that instant, unless it is too old.
         * ================================================================== */

        function rebuildPairs(cfg) {
            var gapSec = PVX.util.num(cfg.MaxPairGapSeconds);
            if (gapSec === null) { gapSec = 60; }
            var maxGapMs = gapSec > 0 ? gapSec * 1000 : Infinity;
            var xp = model.xs ? model.xs.points : [];
            var yp = model.ys ? model.ys.points : [];
            var pairs = [], dropped = 0;
            if (!xp.length || !yp.length) {
                model.pairs = pairs;
                model.dropped = yp.length;
                return;
            }
            var i = 0;
            for (var j = 0; j < yp.length; j++) {
                var yt = yp[j].t;
                while (i + 1 < xp.length && xp[i + 1].t <= yt) { i++; }
                if (xp[i].t > yt || yt - xp[i].t > maxGapMs) { dropped++; continue; }
                pairs.push({ x: xp[i].v, y: yp[j].v, t: yt });
            }
            model.pairs = pairs;
            model.dropped = dropped;
        }

        /* ================================================================== *
         * curve spec
         * ================================================================== */

        /** -> {surge, control, stonewall, speeds:[{label, pts}], bad} */
        function parseCurves(spec) {
            var out = { surge: null, control: null, stonewall: null, speeds: [], bad: 0, count: 0 };
            if (spec === null || spec === undefined) { return out; }
            var entries = String(spec).split(/[|\n]/);
            for (var e = 0; e < entries.length; e++) {
                var s = entries[e].trim();
                if (!s) { continue; }
                var at = s.indexOf(':');
                var name = at > 0 ? s.slice(0, at).trim() : '';
                var pts = at > 0 ? parsePoints(s.slice(at + 1)) : null;
                if (!name || !pts) { out.bad++; continue; }
                out.count++;
                var key = name.toLowerCase();
                if (key === 'surge') { out.surge = pts; }
                else if (key === 'control') { out.control = pts; }
                else if (key === 'stonewall' || key === 'choke') { out.stonewall = pts; }
                else { out.speeds.push({ label: name, pts: pts }); }
            }
            return out;
        }

        /** "x:y x:y, x:y" -> [{x,y}] in the order given, or null if under 2 points. */
        function parsePoints(s) {
            var toks = String(s).trim().split(/[\s,]+/);
            var pts = [];
            for (var i = 0; i < toks.length; i++) {
                if (!toks[i]) { continue; }
                var p = toks[i].split(':');
                var x = PVX.util.num(p[0]), y = PVX.util.num(p[1]);
                if (p.length !== 2 || x === null || y === null) { return null; }
                pts.push({ x: x, y: y });
            }
            return pts.length >= 2 ? pts : null;
        }

        /**
         * Flow on a line at a given head, by linear interpolation along the
         * line sorted by head. Null outside the line's head range: a margin
         * extrapolated off the end of a vendor curve is a guess.
         */
        function flowAtHead(line, head) {
            if (!line || line.length < 2) { return null; }
            var s = line.slice().sort(function (a, b) { return a.y - b.y; });
            if (head < s[0].y || head > s[s.length - 1].y) { return null; }
            for (var i = 0; i < s.length - 1; i++) {
                var a = s[i], b = s[i + 1];
                if (head >= a.y && head <= b.y) {
                    if (b.y === a.y) { return Math.min(a.x, b.x); }
                    return a.x + (b.x - a.x) * (head - a.y) / (b.y - a.y);
                }
            }
            return null;
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

            var svgRoot = host.querySelector('svg.pvx-opmap-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-opmap-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var xs = model.xs, ys = model.ys;
            var notes = [];

            // ---- curves: the AF attribute wins when it parses -----------------
            var fromSource = cfg.CurveSource !== 'config' && model.curveRaw !== null;
            var curves = parseCurves(fromSource ? model.curveRaw : cfg.Curves);
            if (fromSource && !curves.surge) {
                notes.push(model.curveLabel + ' has no readable surge line; using config');
                fromSource = false;
                curves = parseCurves(cfg.Curves);
            }
            if (curves.bad) {
                notes.push(curves.bad + ' curve ' + (curves.bad === 1 ? 'entry' : 'entries') + ' unreadable');
            }
            var ctlPct = PVX.util.num(cfg.ControlMarginPct);
            var controlLine = curves.control;
            if (!controlLine && curves.surge && ctlPct !== null && ctlPct > 0) {
                controlLine = [];
                for (var cs = 0; cs < curves.surge.length; cs++) {
                    controlLine.push({ x: curves.surge[cs].x * (1 + ctlPct / 100), y: curves.surge[cs].y });
                }
            }

            scope.pvx.title = cfg.Title || (ys && xs ? ys.label + ' vs ' + xs.label : 'Operating map');
            scope.pvx.error = '';
            if (xs && !xs.good) { scope.pvx.error = xs.errorDescription || 'Bad data on X'; }
            else if (ys && !ys.good) { scope.pvx.error = ys.errorDescription || 'Bad data on Y'; }
            scope.pvx.badge = '';

            if (!xs || !ys) {
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, 'Two data sources required',
                    'Flow first, then head; curves third.');
                digest();
                return;
            }

            var pairs = model.pairs;
            var cur = pairs.length ? pairs[pairs.length - 1] : null;

            // ---- margin -----------------------------------------------------------
            var margin = null, ctlMargin = null;
            if (cur && curves.surge) {
                var qs = flowAtHead(curves.surge, cur.y);
                if (qs !== null && qs > 0) { margin = (cur.x - qs) / qs * 100; }
                else { notes.push('head outside the surge line, margin unknown'); }
                var qc = flowAtHead(controlLine, cur.y);
                if (qc !== null && qc > 0) { ctlMargin = (cur.x - qc) / qc * 100; }
            }
            if (margin !== null) {
                var band = cfg.UseThresholds !== false ? PVX.thresholds.evaluate(cfg.Thresholds, margin) : null;
                var bc = band ? band.color : (cfg.AccentColor || '#3b82c4');
                scope.pvx.badge = 'Surge margin ' + margin.toFixed(1) + '%' +
                    (ctlMargin !== null && W >= 360 ? ' · ' + ctlMargin.toFixed(1) + '% to control' : '');
                scope.pvx.badgeColor = t.dark ? bc : PVX.color.mix(bc, '#000000', 0.38);
                scope.pvx.badgeBg = PVX.color.rgba(bc, t.dark ? 0.22 : 0.14);
            }

            if (fromSource) { notes.push('map from ' + model.curveLabel); }
            if (model.dropped) { notes.push(model.dropped + ' unpaired'); }
            if (model.extraCount) {
                notes.push(model.extraCount + ' extra source' + (model.extraCount > 1 ? 's' : '') + ' ignored');
            }

            if (!curves.surge && !pairs.length) {
                scope.pvx.note = notes.join(' · ');
                emptyState(svgRoot, W, H, t, 'No surge line and no data',
                    'Add the curves under Format › Curves.');
                digest();
                return;
            }
            if (!curves.surge) { notes.unshift('no surge line configured'); }

            // ---- domains -------------------------------------------------------------
            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12);
            var xVals = [], yVals = [], i, k;
            function addLine(line) {
                if (!line) { return; }
                for (var q = 0; q < line.length; q++) { xVals.push(line[q].x); yVals.push(line[q].y); }
            }
            addLine(curves.surge); addLine(controlLine); addLine(curves.stonewall);
            for (k = 0; k < curves.speeds.length; k++) { addLine(curves.speeds[k].pts); }
            // With a map present, the map sets the frame and an excursion is
            // clamped to the edge and counted. Without one, frame the data.
            var haveMap = xVals.length > 0;
            if (!haveMap) {
                for (i = 0; i < pairs.length; i++) { xVals.push(pairs[i].x); yVals.push(pairs[i].y); }
            } else if (cur) {
                xVals.push(cur.x); yVals.push(cur.y);
            }
            var xd = domainFor(xVals, cfg.XMin, cfg.XMax, tickCount);
            var yd = domainFor(yVals, cfg.YMin, cfg.YMax, tickCount);
            var xTicks = PVX.scale.ticks(xd[0], xd[1], tickCount);
            var yTicks = PVX.scale.ticks(yd[0], yd[1], tickCount);

            // ---- layout ----------------------------------------------------------------
            var tickFont = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var titleFont = PVX.util.clamp(tickFont + 1, 9, 13);
            var CHAR_W = 0.58;
            var showTickLabels = W >= 140 && H >= 110;
            var showAxisTitles = showTickLabels && W >= 200 && H >= 150;
            var yLabelW = 0;
            if (showTickLabels) {
                for (k = 0; k < yTicks.length; k++) {
                    yLabelW = Math.max(yLabelW, PVX.fmt.tick(yTicks[k]).length * tickFont * CHAR_W);
                }
            }
            var lastXLabelW = (showTickLabels && xTicks.length)
                ? PVX.fmt.tick(xTicks[xTicks.length - 1]).length * tickFont * CHAR_W : 0;
            var xTitle = showAxisTitles ? (cfg.XLabel || axisName(xs)) : '';
            var yTitle = showAxisTitles ? (cfg.YLabel || axisName(ys)) : '';

            // Speed-line labels sit past the right end of each line.
            var speedLabelW = 0;
            var showSpeed = cfg.ShowSpeedLabels !== false && W >= 220;
            if (showSpeed) {
                for (k = 0; k < curves.speeds.length; k++) {
                    speedLabelW = Math.max(speedLabelW, curves.speeds[k].label.length * tickFont * 0.95 * CHAR_W);
                }
            }

            var mL = 8 + (yTitle ? titleFont + 4 : 0) + yLabelW + (showTickLabels ? 6 : 0);
            var mR = 8 + Math.max(lastXLabelW / 2, speedLabelW ? speedLabelW + 4 : 0);
            var mT = 10;
            var mB = 6 + (showTickLabels ? tickFont + 6 : 2) + (xTitle ? titleFont + 4 : 0);
            mL = Math.min(mL, W * 0.4); mR = Math.min(mR, W * 0.25);
            mT = Math.min(mT, H * 0.2); mB = Math.min(mB, H * 0.4);
            var plot = { x: mL, y: mT, w: Math.max(10, W - mL - mR), h: Math.max(10, H - mT - mB) };
            plot.x1 = plot.x + plot.w;
            plot.y1 = plot.y + plot.h;

            var sx = PVX.scale.linear(xd[0], xd[1], plot.x, plot.x1);
            var sy = PVX.scale.linear(yd[0], yd[1], plot.y1, plot.y);
            function P(pt) { return { x: sx(pt.x), y: sy(pt.y) }; }
            function linePts(line) {
                var o = [];
                for (var q = 0; q < line.length; q++) { o.push(P(line[q])); }
                return o;
            }

            // ---- grid + axes -----------------------------------------------------------
            if (cfg.ShowGrid !== false) {
                for (i = 0; i < xTicks.length; i++) {
                    hline(svgRoot, sx(xTicks[i]), plot.y, sx(xTicks[i]), plot.y1, t.grid);
                }
                for (i = 0; i < yTicks.length; i++) {
                    hline(svgRoot, plot.x, sy(yTicks[i]), plot.x1, sy(yTicks[i]), t.grid);
                }
            }
            hline(svgRoot, plot.x, plot.y1, plot.x1, plot.y1, t.axis);
            hline(svgRoot, plot.x, plot.y, plot.x, plot.y1, t.axis);
            if (showTickLabels) {
                for (i = 0; i < xTicks.length; i++) {
                    PVX.svg.text(svgRoot, sx(xTicks[i]).toFixed(2), (plot.y1 + 4 + tickFont * 0.6).toFixed(2),
                        PVX.fmt.tick(xTicks[i]), { 'class': 'pvx-svg-label', 'text-anchor': 'middle',
                            'font-size': tickFont, fill: t.textMuted });
                }
                for (i = 0; i < yTicks.length; i++) {
                    PVX.svg.text(svgRoot, (plot.x - 5).toFixed(2), sy(yTicks[i]).toFixed(2),
                        PVX.fmt.tick(yTicks[i]), { 'class': 'pvx-svg-label', 'text-anchor': 'end',
                            'font-size': tickFont, fill: t.textMuted });
                }
            }
            if (xTitle) {
                PVX.svg.text(svgRoot, (plot.x + plot.w / 2).toFixed(2), (H - titleFont * 0.5 - 2).toFixed(2),
                    xTitle, { 'class': 'pvx-svg-label pvx-opmap-axis-title', 'text-anchor': 'middle',
                        'font-size': titleFont, fill: t.text });
            }
            if (yTitle) {
                var ty = plot.y + plot.h / 2, tx = titleFont * 0.8 + 2;
                PVX.svg.text(svgRoot, tx.toFixed(2), ty.toFixed(2), yTitle, {
                    'class': 'pvx-svg-label pvx-opmap-axis-title', 'text-anchor': 'middle',
                    'font-size': titleFont, fill: t.text,
                    transform: 'rotate(-90 ' + tx.toFixed(2) + ' ' + ty.toFixed(2) + ')'
                });
            }

            var clipId = host.getAttribute('data-pvx-clip') || PVX.util.uid('opclip');
            host.setAttribute('data-pvx-clip', clipId);
            var defs = PVX.svg.el('defs', null, svgRoot);
            var clip = PVX.svg.el('clipPath', { id: clipId }, defs);
            PVX.svg.el('rect', { x: plot.x.toFixed(2), y: plot.y.toFixed(2),
                width: plot.w.toFixed(2), height: plot.h.toFixed(2) }, clip);
            var g = PVX.svg.el('g', { 'clip-path': 'url(#' + clipId + ')' }, svgRoot);

            var st = PVX.color.status;

            // ---- regions: left of surge, and between surge and control ----------------
            if (curves.surge) {
                var sp = linePts(sortByY(curves.surge));
                var top = sp[sp.length - 1], bot = sp[0];
                PVX.svg.el('path', {
                    d: PVX.svg.line(sp, false) + ' L' + plot.x.toFixed(2) + ',' + top.y.toFixed(2) +
                        ' L' + plot.x.toFixed(2) + ',' + bot.y.toFixed(2) + ' Z',
                    fill: st.alarm, 'fill-opacity': t.dark ? 0.16 : 0.10, stroke: 'none',
                    'class': 'pvx-opmap-region'
                }, g);
                if (controlLine) {
                    var cp = linePts(sortByY(controlLine)).reverse();
                    PVX.svg.el('path', {
                        d: PVX.svg.line(sp.concat(cp), false) + ' Z',
                        fill: st.warning, 'fill-opacity': t.dark ? 0.18 : 0.14, stroke: 'none',
                        'class': 'pvx-opmap-region'
                    }, g);
                }
            }

            // ---- speed lines + stonewall ------------------------------------------------
            for (k = 0; k < curves.speeds.length; k++) {
                var spd = linePts(curves.speeds[k].pts);
                // Speed lines are smoothed because they are only a backdrop. The
                // surge and control lines are not: the margin is computed by
                // linear interpolation between their points, and the line on
                // screen must be the line the number was measured against.
                PVX.svg.el('path', { d: PVX.svg.line(spd, true), fill: 'none', stroke: t.textMuted,
                    'stroke-width': 1.1, 'stroke-opacity': 0.8, 'class': 'pvx-opmap-curve' }, g);
                if (showSpeed) {
                    var end = spd[spd.length - 1];
                    PVX.svg.text(svgRoot, (end.x + 4).toFixed(2), end.y.toFixed(2), curves.speeds[k].label, {
                        'class': 'pvx-svg-label', 'font-size': (tickFont * 0.95).toFixed(1), fill: t.textMuted
                    });
                }
            }
            if (curves.stonewall) {
                PVX.svg.el('path', { d: PVX.svg.line(linePts(curves.stonewall), false), fill: 'none',
                    stroke: t.textMuted, 'stroke-width': 1.2, 'stroke-dasharray': '2 3',
                    'class': 'pvx-opmap-curve' }, g);
            }
            if (controlLine) {
                PVX.svg.el('path', { d: PVX.svg.line(linePts(sortByY(controlLine)), false), fill: 'none',
                    stroke: st.warning, 'stroke-width': 1.5, 'stroke-dasharray': '6 4',
                    'class': 'pvx-opmap-curve' }, g);
            }
            if (curves.surge) {
                PVX.svg.el('path', { d: PVX.svg.line(linePts(sortByY(curves.surge)), false), fill: 'none',
                    stroke: st.alarm, 'stroke-width': 2.2, 'class': 'pvx-opmap-curve' }, g);
            }

            // ---- points -------------------------------------------------------------------
            var accent = cfg.AccentColor || '#3b82c4';
            var offMap = 0;
            function place(pt) {
                var p = P(pt);
                var cx = PVX.util.clamp(p.x, plot.x, plot.x1);
                var cy = PVX.util.clamp(p.y, plot.y, plot.y1);
                return { x: cx, y: cy, off: cx !== p.x || cy !== p.y };
            }

            var trailMs = Math.max(0, (PVX.util.num(cfg.TrailMinutes) || 0) * 60000);
            var trailFrom = cur ? cur.t - trailMs : 0;
            var hist = [], trail = [];
            for (i = 0; i < pairs.length - 1; i++) {
                if (pairs[i].t >= trailFrom && trailMs > 0) { trail.push(pairs[i]); } else { hist.push(pairs[i]); }
            }
            for (i = 0; i < pairs.length; i++) { if (place(pairs[i]).off) { offMap++; } }

            if (cfg.ShowHistory !== false && hist.length) {
                var shown = subsample(hist, MAX_HISTORY);
                if (shown.length < hist.length) { notes.push('history sampled to ' + shown.length); }
                for (i = 0; i < shown.length; i++) {
                    var hp = place(shown[i]);
                    PVX.svg.el('circle', { cx: hp.x.toFixed(2), cy: hp.y.toFixed(2), r: 1.4,
                        fill: t.textMuted, 'fill-opacity': 0.18, 'class': 'pvx-opmap-hist' }, svgRoot);
                }
            }
            if (trail.length) {
                var tl = [];
                for (i = 0; i < trail.length; i++) { tl.push(place(trail[i])); }
                tl.push(place(cur));
                PVX.svg.el('path', { d: PVX.svg.line(tl, false), fill: 'none', stroke: accent,
                    'stroke-width': 1, 'stroke-opacity': 0.45, 'class': 'pvx-opmap-trail' }, svgRoot);
                for (i = 0; i < trail.length; i++) {
                    var f = (trail[i].t - trailFrom) / (trailMs || 1);
                    PVX.svg.el('circle', { cx: tl[i].x.toFixed(2), cy: tl[i].y.toFixed(2),
                        r: (2 + f * 1.4).toFixed(2), fill: accent,
                        'fill-opacity': (0.12 + f * 0.6).toFixed(2), 'class': 'pvx-opmap-trail' }, svgRoot);
                }
            }

            if (cur) {
                var cp0 = place(cur);
                var numOpts = PVX.config.numberOpts(cfg);

                // Dimension line from the surge line to the point, at the current head.
                if (cfg.ShowMarginMarker !== false && margin !== null && !cp0.off && plot.w >= 120) {
                    var qsx = sx(flowAtHead(curves.surge, cur.y));
                    PVX.svg.el('path', { d: 'M' + qsx.toFixed(2) + ',' + cp0.y.toFixed(2) + ' H' + cp0.x.toFixed(2),
                        stroke: t.text, 'stroke-width': 1, 'stroke-dasharray': '2 2', fill: 'none',
                        'class': 'pvx-opmap-marker' }, g);
                    PVX.svg.el('path', { d: 'M' + qsx.toFixed(2) + ',' + (cp0.y - 5).toFixed(2) + ' V' + (cp0.y + 5).toFixed(2),
                        stroke: t.text, 'stroke-width': 1, 'class': 'pvx-opmap-marker' }, g);
                    // Label ends short of the point's ring so the marker never
                    // sits on top of its own number.
                    if (plot.w >= 220) {
                        PVX.svg.text(svgRoot, (cp0.x - 12).toFixed(2), (cp0.y - 11).toFixed(2),
                            margin.toFixed(1) + '% to surge', { 'class': 'pvx-svg-label', 'text-anchor': 'end',
                                'font-size': tickFont, fill: t.text });
                    }
                }

                var ring = PVX.svg.el('circle', { cx: cp0.x.toFixed(2), cy: cp0.y.toFixed(2), r: 8,
                    fill: 'none', stroke: accent, 'stroke-width': 1.6, 'class': 'pvx-opmap-now' }, svgRoot);
                PVX.svg.el('circle', { cx: cp0.x.toFixed(2), cy: cp0.y.toFixed(2), r: 4,
                    fill: cp0.off ? st.alarm : accent, 'class': 'pvx-opmap-now' }, svgRoot);
                var tip = PVX.svg.el('title', null, ring);
                tip.textContent = (cfg.XLabel || xs.label) + ': ' + PVX.fmt.number(cur.x, numOpts) +
                    (xs.units ? ' ' + xs.units : '') + '\n' +
                    (cfg.YLabel || ys.label) + ': ' + PVX.fmt.number(cur.y, numOpts) +
                    (ys.units ? ' ' + ys.units : '') + '\n' + PVX.fmt.time(cur.t, 'datetime');
            } else {
                notes.unshift('no paired samples');
            }

            if (offMap) { notes.push(offMap + ' point' + (offMap > 1 ? 's' : '') + ' off map, drawn at the edge'); }
            scope.pvx.note = notes.join(' · ');
            digest();
        }

        /* ================================================================== *
         * helpers
         * ================================================================== */

        function sortByY(line) {
            return line.slice().sort(function (a, b) { return a.y - b.y; });
        }

        function subsample(arr, cap) {
            if (arr.length <= cap) { return arr; }
            var out = [], n = arr.length;
            for (var i = 0; i < cap; i++) { out.push(arr[Math.floor(i * n / cap)]); }
            return out;
        }

        function domainFor(values, minCfg, maxCfg, tickCount) {
            var lo = null, hi = null;
            for (var i = 0; i < values.length; i++) {
                var v = values[i];
                if (!PVX.util.isNum(v)) { continue; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            }
            if (lo === null) { lo = 0; hi = 1; }
            if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
            var d = PVX.scale.niceDomain(lo, hi, tickCount);
            var mn = PVX.util.num(minCfg), mx = PVX.util.num(maxCfg);
            if (mn !== null) { d[0] = mn; }
            if (mx !== null) { d[1] = mx; }
            if (!(d[1] > d[0])) { d[1] = d[0] + 1; }
            return d;
        }

        function axisName(series) {
            if (!series) { return ''; }
            var n = series.label || '';
            if (series.units) { n = n ? n + ' (' + series.units + ')' : series.units; }
            return n;
        }

        function hline(parent, x1, y1, x2, y2, color) {
            PVX.svg.el('line', { x1: x1.toFixed(2), y1: y1.toFixed(2), x2: x2.toFixed(2), y2: y2.toFixed(2),
                stroke: color, 'stroke-width': 1, 'class': 'pvx-grid-line' }, parent);
        }

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);
            PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2), headline, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle',
                'font-size': font, 'font-weight': '600', fill: t.textMuted
            });
            // The hint is optional; at mosaic sizes it would only be clipped.
            if (detail.length * font * 0.9 * 0.58 > W - 12) { return; }
            PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.7).toFixed(2), detail, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle',
                'font-size': font * 0.9, fill: t.textMuted, opacity: '0.8'
            });
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
