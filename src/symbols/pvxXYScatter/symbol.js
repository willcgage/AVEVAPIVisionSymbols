/* ============================================================================
 * pvxXYScatter — correlation (X vs Y) plot for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources; the FIRST is X, the SECOND is
 * Y, and in bubble mode the THIRD sets each point's size)
 *
 * PI Vision's own XY Plot puts one tag against another; this one answers the
 * question that comes next, "how strongly, and is it still inside the box":
 * a least-squares fit with its equation and R², an operating envelope that
 * turns excursions red, points coloured by time or by limit, and a bubble
 * mode where a third tag sets each point's area. All of it over whatever
 * time range the display is showing.
 *
 * The interesting part is the pairing. PI is a compressed historian: two tags
 * are almost never stored on the same timestamps, and PI Vision's plot-values
 * query returns each one on its own grid. So for every Y sample we take the X
 * value in force at that instant (last-known-value, i.e. the sample at or
 * immediately before it) — the same semantics a PI "interpolated at Y's
 * timestamps" query would give — and drop the pair when the X sample is too
 * stale to be believable (MaxPairGapSeconds).
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Hard cap on rendered markers. Beyond a few thousand SVG circles the
     * browser's paint cost dominates and the plot stops being readable anyway;
     * we subsample uniformly and say so in the footer rather than truncating. */
    var MAX_POINTS = 4000;

    var definition = {
        typeName: 'pvxXYScatter',
        displayName: 'PVX XY Scatter',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format XY Scatter',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 300,
                Height: 260,
                Width: 320,

                // Axes — blank labels fall back to the series label + units.
                XLabel: '',
                YLabel: '',
                XMin: '',
                XMax: '',
                YMin: '',
                YMax: '',
                AutoScale: true,
                TickCount: 5,
                ShowGrid: true,

                // Pairing
                MaxPairGapSeconds: 60,

                // Markers
                PointSize: 3,
                PointOpacity: 0.65,
                ColorMode: 'single',        // single | time | threshold
                PointColor: '#3b82c4',
                ShowConnectingLine: false,

                // Bubble: a third data source sets each point's area.
                BubbleMode: false,
                BubbleMinSize: 3,           // px radius of the smallest size value
                BubbleMaxSize: 16,          // px radius of the largest size value

                // Regression
                ShowRegression: true,
                RegressionColor: '#c8452f',
                ShowEquation: true,
                ShowR2: true,

                // Operating envelope
                ShowEnvelope: false,
                EnvelopeXMin: '',
                EnvelopeXMax: '',
                EnvelopeYMin: '',
                EnvelopeYMax: '',

                ShowPointCount: true,
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Template bindings.
        scope.pvx = {
            title: '',
            countText: '',
            note: '',
            error: ''
        };

        // Derived once per data update, reused across resize/config renders.
        var model = {
            xSeries: null,
            ySeries: null,
            zSeries: null,     // bubble size, when a third source exists
            sourceCount: 0,
            pairs: [],         // [{x, y, t, xt, z}] in Y-time order
            dropped: 0,        // Y samples with no X value close enough
            noSize: 0          // bubble mode: pairs with no size value close enough
        };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-xy-body',

            onData: function (d) {
                var all = PVX.data.series(d);
                model.xSeries = all.length > 0 ? all[0] : null;
                model.ySeries = all.length > 1 ? all[1] : null;
                model.zSeries = all.length > 2 ? all[2] : null;
                model.sourceCount = all.length;
                rebuildPairs(ctx.config || scope.config || {});
            },

            // The gap tolerance changes the pairing, not just the drawing, so a
            // config change has to re-run the merge before the next render.
            onConfigChange: function (newCfg) {
                rebuildPairs(newCfg || {});
            },

            render: render
        });

        /* ------------------------------------------------------------------ *
         * pairing
         * ------------------------------------------------------------------ */

        function rebuildPairs(cfg) {
            var gapSec = PVX.util.num(cfg.MaxPairGapSeconds);
            if (gapSec === null) { gapSec = 60; }
            // <= 0 is the documented "no limit" escape hatch for slow tags.
            var maxGapMs = gapSec > 0 ? gapSec * 1000 : Infinity;

            var xp = model.xSeries ? model.xSeries.points : [];
            var yp = model.ySeries ? model.ySeries.points : [];
            var res = mergeByTime(xp, yp, maxGapMs);
            model.pairs = res.pairs;
            model.dropped = res.dropped;
            model.noSize = 0;
            if (cfg.BubbleMode && model.zSeries) { attachSizes(model.zSeries.points, maxGapMs); }
        }

        /**
         * Bubble mode: give each pair the size value in force at its instant,
         * by the same last-known-value rule and gap limit as X. A pair with no
         * size is dropped and counted rather than drawn at some invented size,
         * and the fit then describes exactly the points on the plot.
         */
        function attachSizes(zs, maxGapMs) {
            var kept = [], i = 0;
            for (var j = 0; j < model.pairs.length; j++) {
                var pr = model.pairs[j];
                if (zs.length) {
                    while (i + 1 < zs.length && zs[i + 1].t <= pr.t) { i++; }
                    var zPt = zs[i];
                    if (zPt.t <= pr.t && pr.t - zPt.t <= maxGapMs) {
                        pr.z = zPt.v;
                        kept.push(pr);
                        continue;
                    }
                }
                model.noSize++;
            }
            model.pairs = kept;
        }

        /**
         * Two-pointer merge of two time-sorted point arrays (PVX.data.series
         * already sorts them). For each Y sample, `i` walks forward — never
         * back — to the last X sample at or before it, so the whole merge is
         * O(nx + ny) rather than the O(nx * ny) a nested scan would cost on the
         * ~300-point-per-tag payloads this symbol asks for.
         */
        function mergeByTime(xs, ys, maxGapMs) {
            var pairs = [], dropped = 0;
            if (!xs.length || !ys.length) {
                return { pairs: pairs, dropped: ys.length };
            }
            var i = 0;
            for (var j = 0; j < ys.length; j++) {
                var yt = ys[j].t;
                while (i + 1 < xs.length && xs[i + 1].t <= yt) { i++; }
                var xPt = xs[i];
                // Y samples that precede the very first X sample have no
                // last-known X value at all — they are not pairable.
                if (xPt.t > yt) { dropped++; continue; }
                if (yt - xPt.t > maxGapMs) { dropped++; continue; }
                pairs.push({ x: xPt.v, y: ys[j].v, t: yt, xt: xPt.t });
            }
            return { pairs: pairs, dropped: dropped };
        }

        /** Uniform decimation that keeps the first and last samples' ordering. */
        function subsample(arr, cap) {
            if (arr.length <= cap) { return arr; }
            var out = [], n = arr.length;
            for (var i = 0; i < cap; i++) {
                out.push(arr[Math.floor(i * n / cap)]);
            }
            return out;
        }

        /* ------------------------------------------------------------------ *
         * scales
         * ------------------------------------------------------------------ */

        /**
         * Resolve one axis domain.
         * Explicit config bounds always win; otherwise AutoScale rounds the data
         * extent outward to tick-friendly numbers, and AutoScale=false uses the
         * exact extent with a hair of padding so edge points are not clipped.
         */
        function domainFor(values, minCfg, maxCfg, autoScale, tickCount) {
            var lo = null, hi = null;
            for (var i = 0; i < values.length; i++) {
                var v = values[i];
                if (!PVX.util.isNum(v)) { continue; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            }
            if (lo === null) { lo = 0; hi = 1; }

            var explicitMin = PVX.util.num(minCfg);
            var explicitMax = PVX.util.num(maxCfg);

            var d;
            if (autoScale) {
                d = PVX.scale.niceDomain(lo, hi, tickCount);
            } else {
                if (lo === hi) {
                    var pad = Math.abs(lo) * 0.1 || 1;
                    d = [lo - pad, hi + pad];
                } else {
                    var span = (hi - lo) * 0.04;
                    d = [lo - span, hi + span];
                }
            }
            if (explicitMin !== null) { d[0] = explicitMin; }
            if (explicitMax !== null) { d[1] = explicitMax; }
            if (!(d[1] > d[0])) { d[1] = d[0] + 1; }   // never divide by zero
            return d;
        }

        /* ------------------------------------------------------------------ *
         * colour
         * ------------------------------------------------------------------ */

        /**
         * Stops used for ColorMode 'time'. PVX.color.sequential ends at a near
         * white (#e8f0f7) which disappears on the light canvas, so on light
         * themes we drop the last stop. The legend is drawn from this same
         * array, so the key always matches what is on the plot.
         */
        function timeStops(t) {
            var seq = PVX.color.sequential;
            return t.dark ? seq.slice() : seq.slice(0, seq.length - 1);
        }

        /* ------------------------------------------------------------------ *
         * render
         * ------------------------------------------------------------------ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            var W = Math.max(40, c.width);
            var H = Math.max(40, c.height);

            var svgRoot = host.querySelector('svg.pvx-xy-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-xy-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var xs = model.xSeries, ys = model.ySeries;

            // ---- header / footer bindings ---------------------------------
            var xName = xs ? (xs.label || 'X') : '';
            var yName = ys ? (ys.label || 'Y') : '';
            scope.pvx.title = (xs && ys) ? (yName + ' vs ' + xName) : 'XY Scatter';
            scope.pvx.error = '';
            if (xs && !xs.good) { scope.pvx.error = xs.errorDescription || 'Bad data on X'; }
            else if (ys && !ys.good) { scope.pvx.error = ys.errorDescription || 'Bad data on Y'; }

            // ---- empty state ----------------------------------------------
            if (!xs || !ys) {
                scope.pvx.countText = '';
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t,
                    'Two data sources required',
                    'Drop the X attribute first, then Y.');
                digest();
                return;
            }
            if (!model.pairs.length) {
                scope.pvx.countText = '';
                scope.pvx.note = [
                    model.dropped ? model.dropped + ' samples had no X value within the pairing window' : '',
                    model.noSize ? model.noSize + ' pairs had no size value within it' : ''
                ].filter(function (x) { return x; }).join(' · ');
                emptyState(svgRoot, W, H, t,
                    'No paired samples',
                    'X and Y never overlap within ' +
                    (PVX.util.num(cfg.MaxPairGapSeconds) || 60) + 's.');
                digest();
                return;
            }

            var pairs = model.pairs;
            var shown = subsample(pairs, MAX_POINTS);
            var sampled = shown.length < pairs.length;

            scope.pvx.countText = cfg.ShowPointCount
                ? PVX.fmt.group(String(pairs.length)) + (pairs.length === 1 ? ' point' : ' points')
                : '';
            var notes = [];
            if (sampled) {
                notes.push('showing ' + PVX.fmt.group(String(shown.length)) + ' of ' +
                           PVX.fmt.group(String(pairs.length)) + ' (uniform sample)');
            }
            if (model.dropped) { notes.push(model.dropped + ' unpaired'); }
            var zs = (cfg.BubbleMode && model.zSeries) ? model.zSeries : null;
            if (model.noSize) { notes.push(model.noSize + ' without a size value'); }
            if (cfg.BubbleMode && !zs) { notes.push('bubble size needs a third data source'); }
            var extraCount = Math.max(0, model.sourceCount - (zs ? 3 : 2));
            if (extraCount) {
                notes.push(extraCount + ' extra source' + (extraCount > 1 ? 's' : '') + ' ignored');
            }

            // Bubble radii: area grows with the value above the smallest one, so
            // a value twice as far up the range covers twice the ink rather than
            // four times, which is how a reader compares circles.
            var zMin = 0, zMax = 0;
            var rMin = PVX.util.clamp(PVX.util.num(cfg.BubbleMinSize) || 3, 0.5, 40);
            var rMax = PVX.util.clamp(PVX.util.num(cfg.BubbleMaxSize) || 16, rMin, 60);
            if (zs) {
                zMin = zMax = pairs[0].z;
                for (var zi = 1; zi < pairs.length; zi++) {
                    if (pairs[zi].z < zMin) { zMin = pairs[zi].z; }
                    if (pairs[zi].z > zMax) { zMax = pairs[zi].z; }
                }
                notes.push('size: ' + (zs.label || 'third source') + ' ' + PVX.fmt.tick(zMin) + '–' +
                           PVX.fmt.tick(zMax) + (zs.units ? ' ' + zs.units : ''));
            }
            function radiusFor(pt) {
                if (!zs) { return r; }
                if (!(zMax > zMin)) { return (rMin + rMax) / 2; }
                return rMin + (rMax - rMin) * Math.sqrt((pt.z - zMin) / (zMax - zMin));
            }
            scope.pvx.note = notes.join(' · ');

            // ---- domains ---------------------------------------------------
            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12);
            var xVals = [], yVals = [];
            for (var p = 0; p < pairs.length; p++) { xVals.push(pairs[p].x); yVals.push(pairs[p].y); }

            var env = {
                x0: PVX.util.num(cfg.EnvelopeXMin),
                x1: PVX.util.num(cfg.EnvelopeXMax),
                y0: PVX.util.num(cfg.EnvelopeYMin),
                y1: PVX.util.num(cfg.EnvelopeYMax)
            };
            var hasEnvelope = !!cfg.ShowEnvelope &&
                (env.x0 !== null || env.x1 !== null || env.y0 !== null || env.y1 !== null);
            // Fold the envelope into the extent, otherwise a box drawn outside
            // the data range would be invisible and the operator would think the
            // setting did nothing.
            if (hasEnvelope) {
                if (env.x0 !== null) { xVals.push(env.x0); }
                if (env.x1 !== null) { xVals.push(env.x1); }
                if (env.y0 !== null) { yVals.push(env.y0); }
                if (env.y1 !== null) { yVals.push(env.y1); }
            }

            var auto = cfg.AutoScale !== false;
            var xd = domainFor(xVals, cfg.XMin, cfg.XMax, auto, tickCount);
            var yd = domainFor(yVals, cfg.YMin, cfg.YMax, auto, tickCount);

            var xTicks = PVX.scale.ticks(xd[0], xd[1], tickCount);
            var yTicks = PVX.scale.ticks(yd[0], yd[1], tickCount);

            // ---- margins ---------------------------------------------------
            // Derived from the *actual* tick strings, so a "1,234,567" axis is
            // never clipped and a "0..5" axis does not waste half the width.
            var tickFont = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var titleFont = PVX.util.clamp(tickFont + 1, 9, 13);
            var CHAR_W = 0.58;   // mean advance width of the UI font, in ems

            // Below a certain box size the chrome costs more than it informs —
            // these get dropped small into mosaics — so shed text and keep the
            // cloud readable rather than overlapping labels onto the data.
            var showTickLabels = W >= 130 && H >= 100;
            var showAxisTitles = showTickLabels && W >= 180 && H >= 130;

            var yLabelW = 0, k;
            if (showTickLabels) {
                for (k = 0; k < yTicks.length; k++) {
                    yLabelW = Math.max(yLabelW, PVX.fmt.tick(yTicks[k]).length * tickFont * CHAR_W);
                }
            }
            var lastXLabelW = (showTickLabels && xTicks.length)
                ? PVX.fmt.tick(xTicks[xTicks.length - 1]).length * tickFont * CHAR_W
                : 0;

            var xTitle = showAxisTitles ? (cfg.XLabel || axisName(xs)) : '';
            var yTitle = showAxisTitles ? (cfg.YLabel || axisName(ys)) : '';

            // The ramp key needs its "older"/"newer" captions to mean anything.
            var legendH = (cfg.ColorMode === 'time' && showTickLabels) ? (tickFont + 12) : 0;

            var mL = 8 + (yTitle ? titleFont + 4 : 0) + yLabelW + (showTickLabels ? 6 : 0);
            var mR = 8 + lastXLabelW / 2;
            var mT = 8 + legendH;
            var mB = 6 + (showTickLabels ? tickFont + 6 : 2) + (xTitle ? titleFont + 4 : 0);

            // On tiny symbol sizes the margins can swallow the plot; cap them.
            mL = Math.min(mL, W * 0.45); mR = Math.min(mR, W * 0.25);
            mT = Math.min(mT, H * 0.35); mB = Math.min(mB, H * 0.45);

            var plot = {
                x: mL, y: mT,
                w: Math.max(10, W - mL - mR),
                h: Math.max(10, H - mT - mB)
            };
            plot.x1 = plot.x + plot.w;
            plot.y1 = plot.y + plot.h;

            var sx = PVX.scale.linear(xd[0], xd[1], plot.x, plot.x1);
            var sy = PVX.scale.linear(yd[0], yd[1], plot.y1, plot.y);   // SVG y grows down

            // ---- grid + axes ------------------------------------------------
            var i;
            if (cfg.ShowGrid !== false) {
                for (i = 0; i < xTicks.length; i++) {
                    var gx = sx(xTicks[i]);
                    PVX.svg.el('line', {
                        x1: gx.toFixed(2), y1: plot.y.toFixed(2),
                        x2: gx.toFixed(2), y2: plot.y1.toFixed(2),
                        stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-grid-line'
                    }, svgRoot);
                }
                for (i = 0; i < yTicks.length; i++) {
                    var gy = sy(yTicks[i]);
                    PVX.svg.el('line', {
                        x1: plot.x.toFixed(2), y1: gy.toFixed(2),
                        x2: plot.x1.toFixed(2), y2: gy.toFixed(2),
                        stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-grid-line'
                    }, svgRoot);
                }
            }

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

            if (showTickLabels) {
                for (i = 0; i < xTicks.length; i++) {
                    PVX.svg.text(svgRoot, sx(xTicks[i]).toFixed(2), (plot.y1 + 4 + tickFont * 0.6).toFixed(2),
                        PVX.fmt.tick(xTicks[i]), {
                            'class': 'pvx-svg-label', 'text-anchor': 'middle',
                            'font-size': tickFont, fill: t.textMuted
                        });
                }
                for (i = 0; i < yTicks.length; i++) {
                    PVX.svg.text(svgRoot, (plot.x - 5).toFixed(2), sy(yTicks[i]).toFixed(2),
                        PVX.fmt.tick(yTicks[i]), {
                            'class': 'pvx-svg-label', 'text-anchor': 'end',
                            'font-size': tickFont, fill: t.textMuted
                        });
                }
            }

            if (xTitle) {
                PVX.svg.text(svgRoot, (plot.x + plot.w / 2).toFixed(2), (H - titleFont * 0.5 - 2).toFixed(2),
                    xTitle, {
                        'class': 'pvx-svg-label pvx-xy-axis-title', 'text-anchor': 'middle',
                        'font-size': titleFont, fill: t.text
                    });
            }
            if (yTitle) {
                var ty = (plot.y + plot.h / 2);
                var tx = titleFont * 0.8 + 2;
                PVX.svg.text(svgRoot, tx.toFixed(2), ty.toFixed(2), yTitle, {
                    'class': 'pvx-svg-label pvx-xy-axis-title', 'text-anchor': 'middle',
                    'font-size': titleFont, fill: t.text,
                    transform: 'rotate(-90 ' + tx.toFixed(2) + ' ' + ty.toFixed(2) + ')'
                });
            }

            // Everything data-driven is clipped to the plot rect so out-of-range
            // points and the regression line never bleed over the axis labels.
            var clipId = host.getAttribute('data-pvx-clip') || PVX.util.uid('xyclip');
            host.setAttribute('data-pvx-clip', clipId);
            var defs = PVX.svg.el('defs', null, svgRoot);
            var clip = PVX.svg.el('clipPath', { id: clipId }, defs);
            PVX.svg.el('rect', {
                x: plot.x.toFixed(2), y: plot.y.toFixed(2),
                width: plot.w.toFixed(2), height: plot.h.toFixed(2)
            }, clip);
            var plotG = PVX.svg.el('g', { 'clip-path': 'url(#' + clipId + ')' }, svgRoot);

            // ---- operating envelope -----------------------------------------
            if (hasEnvelope) {
                var ex0 = env.x0 === null ? xd[0] : env.x0;
                var ex1 = env.x1 === null ? xd[1] : env.x1;
                var ey0 = env.y0 === null ? yd[0] : env.y0;
                var ey1 = env.y1 === null ? yd[1] : env.y1;
                var px0 = sx(Math.min(ex0, ex1)), px1 = sx(Math.max(ex0, ex1));
                var py1 = sy(Math.min(ey0, ey1)), py0 = sy(Math.max(ey0, ey1));
                PVX.svg.el('rect', {
                    x: px0.toFixed(2), y: py0.toFixed(2),
                    width: Math.max(0, px1 - px0).toFixed(2),
                    height: Math.max(0, py1 - py0).toFixed(2),
                    fill: 'none',
                    stroke: t.textMuted,
                    'stroke-width': 1,
                    'stroke-dasharray': '5 4',
                    'class': 'pvx-xy-envelope'
                }, plotG);
            }

            /** Inside the envelope? Missing bounds are treated as unbounded. */
            function inEnvelope(pt) {
                if (!hasEnvelope) { return true; }
                if (env.x0 !== null && pt.x < env.x0) { return false; }
                if (env.x1 !== null && pt.x > env.x1) { return false; }
                if (env.y0 !== null && pt.y < env.y0) { return false; }
                if (env.y1 !== null && pt.y > env.y1) { return false; }
                return true;
            }

            // ---- point colours ------------------------------------------------
            var mode = cfg.ColorMode || 'single';
            var baseColor = cfg.PointColor || cfg.AccentColor || '#3b82c4';
            var stops = timeStops(t);
            var tMin = pairs[0].t, tMax = pairs[pairs.length - 1].t;
            for (i = 0; i < pairs.length; i++) {          // payload order is Y order,
                if (pairs[i].t < tMin) { tMin = pairs[i].t; }   // but be defensive
                if (pairs[i].t > tMax) { tMax = pairs[i].t; }
            }
            var tSpan = (tMax - tMin) || 1;

            function colorFor(pt) {
                if (!inEnvelope(pt)) { return PVX.color.status.alarm; }
                if (mode === 'time') { return PVX.color.ramp(stops, (pt.t - tMin) / tSpan); }
                // Threshold colouring still honours the shared UseThresholds
                // switch, so turning bands off anywhere turns them off here too.
                if (mode === 'threshold' && cfg.UseThresholds !== false) {
                    return PVX.thresholds.colorFor(cfg.Thresholds, pt.y, baseColor);
                }
                return baseColor;
            }

            // ---- connecting line (phase portrait) -------------------------------
            if (cfg.ShowConnectingLine) {
                var linePts = [];
                for (i = 0; i < shown.length; i++) {
                    linePts.push({ x: sx(shown[i].x), y: sy(shown[i].y) });
                }
                PVX.svg.el('path', {
                    d: PVX.svg.line(linePts, false),
                    fill: 'none',
                    stroke: baseColor,
                    'stroke-width': 1,
                    'stroke-opacity': 0.25,
                    'stroke-linejoin': 'round',
                    'class': 'pvx-xy-path'
                }, plotG);
            }

            // ---- points ----------------------------------------------------------
            var r = PVX.util.clamp(PVX.util.num(cfg.PointSize) || 3, 0.5, 20);
            var op = PVX.util.num(cfg.PointOpacity);
            // num() returns null for blank/garbage; clamp() would turn that into
            // the floor and silently make every marker nearly invisible.
            op = (op === null) ? 0.65 : PVX.util.clamp(op, 0.05, 1);
            var xUnits = xs.units ? ' ' + xs.units : '';
            var yUnits = ys.units ? ' ' + ys.units : '';
            // Tooltips name the tag, not the axis title: the auto axis title
            // already carries the units and would read "Temp (degF): 120 degF".
            var xTip = cfg.XLabel || xs.label || 'X';
            var yTip = cfg.YLabel || ys.label || 'Y';
            var numOpts = PVX.config.numberOpts(cfg);
            // Quadrant tally, used to park the equation box where it hides least.
            var quad = [0, 0, 0, 0];   // 0=TL 1=TR 2=BL 3=BR
            var midX = plot.x + plot.w / 2, midY = plot.y + plot.h / 2;

            // Large bubbles first, so a small one is never hidden underneath.
            var drawOrder = shown;
            if (zs) {
                drawOrder = shown.slice().sort(function (a, b) { return b.z - a.z; });
            }
            var zTip = zs ? (zs.label || 'Size') : '';
            var zUnits = (zs && zs.units) ? ' ' + zs.units : '';

            for (i = 0; i < drawOrder.length; i++) {
                var pt = drawOrder[i];
                var cxp = sx(pt.x), cyp = sy(pt.y);
                var fillC = colorFor(pt);
                var dot = PVX.svg.el('circle', {
                    cx: cxp.toFixed(2), cy: cyp.toFixed(2), r: radiusFor(pt).toFixed(2),
                    fill: fillC,
                    'fill-opacity': op,
                    // Overlapping bubbles merge into one blob without an edge.
                    // Inline style, because the stylesheet's stroke:none on
                    // plain dots would beat a presentation attribute.
                    style: zs ? 'stroke:' + fillC + ';stroke-width:0.8px' : null,
                    'class': 'pvx-xy-dot'
                }, plotG);
                var title = PVX.svg.el('title', null, dot);
                title.textContent =
                    xTip + ': ' + PVX.fmt.number(pt.x, numOpts) + xUnits + '\n' +
                    yTip + ': ' + PVX.fmt.number(pt.y, numOpts) + yUnits + '\n' +
                    (zs ? zTip + ': ' + PVX.fmt.number(pt.z, numOpts) + zUnits + '\n' : '') +
                    PVX.fmt.time(pt.t, 'datetime');

                quad[(cyp < midY ? 0 : 2) + (cxp < midX ? 0 : 1)]++;
            }

            // ---- regression ---------------------------------------------------------
            // Fitted on every pair, not just the drawn sample: the statistics should
            // describe the data, not the decimation.
            var reg = cfg.ShowRegression ? PVX.stats.linreg(pairs) : null;
            if (reg) {
                var seg = clipRegression(reg.slope, reg.intercept, xd, yd);
                if (seg) {
                    PVX.svg.el('line', {
                        x1: sx(seg.x0).toFixed(2), y1: sy(seg.y0).toFixed(2),
                        x2: sx(seg.x1).toFixed(2), y2: sy(seg.y1).toFixed(2),
                        stroke: cfg.RegressionColor || '#c8452f',
                        'stroke-width': 1.8,
                        'stroke-linecap': 'round',
                        'class': 'pvx-xy-fit'
                    }, plotG);
                }
            }

            // ---- stats box ------------------------------------------------------------
            // The card is only worth its ink if it does not blanket the plot.
            if (reg && (cfg.ShowEquation || cfg.ShowR2) && plot.w >= 90 && plot.h >= 50) {
                var lines = [];
                if (cfg.ShowEquation) {
                    lines.push('y = ' + PVX.fmt.number(reg.slope, numOpts) + 'x ' +
                               (reg.intercept < 0 ? '- ' : '+ ') +
                               PVX.fmt.number(Math.abs(reg.intercept), numOpts));
                }
                if (cfg.ShowR2) { lines.push('R² = ' + reg.r2.toFixed(4)); }
                drawStatsBox(svgRoot, plot, lines, quad, t, tickFont, cfg);
            }

            // ---- time colour legend -------------------------------------------------------
            if (mode === 'time' && legendH > 0) {
                drawTimeLegend(svgRoot, defs, host, plot, stops, t, tickFont);
            }

            digest();
        }

        /* ------------------------------------------------------------------ *
         * render helpers
         * ------------------------------------------------------------------ */

        function axisName(series) {
            if (!series) { return ''; }
            var n = series.label || '';
            if (series.units) { n = n ? n + ' (' + series.units + ')' : series.units; }
            return n;
        }

        /**
         * Trim the fitted line to the visible rectangle in *data* space, so a
         * steep fit does not shoot off past the top of the plot and leave a stub
         * that reads as a different slope.
         */
        function clipRegression(m, b, xd, yd) {
            var xa = xd[0], xb = xd[1];
            if (Math.abs(m) > 1e-12) {
                var xAtLo = (yd[0] - b) / m;
                var xAtHi = (yd[1] - b) / m;
                xa = Math.max(xa, Math.min(xAtLo, xAtHi));
                xb = Math.min(xb, Math.max(xAtLo, xAtHi));
            } else if (b < yd[0] || b > yd[1]) {
                return null;                      // flat line outside the window
            }
            if (!(xb > xa)) { return null; }
            return { x0: xa, y0: m * xa + b, x1: xb, y1: m * xb + b };
        }

        /** Park the equation/R² card in whichever quadrant holds fewest markers. */
        function drawStatsBox(svgRoot, plot, lines, quad, t, font, cfg) {
            var best = 0;
            for (var i = 1; i < 4; i++) { if (quad[i] < quad[best]) { best = i; } }

            var padX = 6, padY = 4, lineH = font * 1.35;
            var widest = 0;
            for (i = 0; i < lines.length; i++) { widest = Math.max(widest, lines[i].length); }
            var boxW = Math.min(plot.w - 4, widest * font * 0.6 + padX * 2);
            var boxH = lines.length * lineH + padY * 2;

            var left = (best === 0 || best === 2);
            var top = (best === 0 || best === 1);
            var bx = left ? plot.x + 4 : plot.x + plot.w - boxW - 4;
            var by = top ? plot.y + 4 : plot.y + plot.h - boxH - 4;

            // A transparent-background symbol has no surface colour to borrow, so
            // fall back to a theme-appropriate scrim that keeps the text legible.
            var fill = (t.surface && t.surface !== 'transparent')
                ? PVX.color.rgba(t.surface, 0.86)
                : (t.dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.78)');

            PVX.svg.el('path', {
                d: PVX.svg.roundRect(bx, by, boxW, boxH, 3),
                fill: fill,
                stroke: t.border,
                'stroke-width': 1,
                'class': 'pvx-xy-stats'
            }, svgRoot);

            for (i = 0; i < lines.length; i++) {
                PVX.svg.text(svgRoot, (bx + padX).toFixed(2),
                    (by + padY + lineH * (i + 0.5)).toFixed(2), lines[i], {
                        'class': 'pvx-svg-label pvx-num',
                        'font-size': font,
                        'font-weight': i === 0 ? '600' : '400',
                        fill: i === 0 ? (cfg.RegressionColor || t.text) : t.text
                    });
            }
        }

        /** Horizontal ramp key for ColorMode 'time', above the plot area. */
        function drawTimeLegend(svgRoot, defs, host, plot, stops, t, font) {
            var gradId = host.getAttribute('data-pvx-grad') || PVX.util.uid('xygrad');
            host.setAttribute('data-pvx-grad', gradId);
            var grad = PVX.svg.el('linearGradient', {
                id: gradId, x1: '0', y1: '0', x2: '1', y2: '0'
            }, defs);
            for (var i = 0; i < stops.length; i++) {
                PVX.svg.el('stop', {
                    offset: (i / (stops.length - 1) * 100).toFixed(1) + '%',
                    'stop-color': stops[i]
                }, grad);
            }

            var barH = Math.max(4, font * 0.55);
            var labelW = font * 0.58 * 5.5;                // "older" / "newer"
            var barW = Math.min(90, Math.max(24, plot.w - labelW * 2 - 10));
            var barX = plot.x + plot.w - barW - labelW - 2;
            var barY = Math.max(2, plot.y - barH - font * 0.6 - 2);

            PVX.svg.text(svgRoot, (barX - 4).toFixed(2), (barY + barH / 2).toFixed(2), 'older', {
                'class': 'pvx-svg-label', 'text-anchor': 'end',
                'font-size': font * 0.9, fill: t.textMuted
            });
            PVX.svg.el('rect', {
                x: barX.toFixed(2), y: barY.toFixed(2),
                width: barW.toFixed(2), height: barH.toFixed(2),
                fill: 'url(#' + gradId + ')',
                stroke: t.border, 'stroke-width': 0.5,
                'class': 'pvx-xy-legend'
            }, svgRoot);
            PVX.svg.text(svgRoot, (barX + barW + 4).toFixed(2), (barY + barH / 2).toFixed(2), 'newer', {
                'class': 'pvx-svg-label', 'text-anchor': 'start',
                'font-size': font * 0.9, fill: t.textMuted
            });
        }

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);
            PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2), headline, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle',
                'font-size': font, 'font-weight': '600', fill: t.textMuted
            });
            PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.7).toFixed(2), detail, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle',
                'font-size': font * 0.9, fill: t.textMuted, opacity: '0.8'
            });
        }

        /* Renders run inside requestAnimationFrame, outside Angular's digest, and
         * this symbol writes the title/footer through scope bindings. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
