/* ============================================================================
 * pvxXYScatter — correlation (X vs Y) plot for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources; the FIRST is X, the SECOND is
 * Y, and in bubble mode the THIRD sets each point's size)
 *
 * PI Vision's own XY Plot puts one tag against another; this one answers the
 * question that comes next, "how strongly, and is it still inside the box":
 * a least-squares fit with its equation and R², an operating envelope that
 * turns excursions red, points colored by time or by limit, and a bubble
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
 *
 * Options added later, all off by default so a saved display draws as before:
 *   YSources 'all'    every source after X is a Y series in its own color,
 *                     each with its own fit (bubble size stays the third).
 *   GateSource        a data source whose value, at each point's instant,
 *                     must lie in GateMin..GateMax for the point to count:
 *                     "only while the unit is running".
 *   FitType           a polynomial of degree 2 or 3 instead of a line.
 *   EnvelopeShape     'polygon': an operating envelope of any shape, typed
 *                     as x,y corners, instead of the box.
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
        // The gate names a source by number; renumbered when one is removed.
        sourceRemap: { GateSource: 'indexAuto' },
        visObjectType: symbolVis,
        // A collection repeats the symbol once per asset and rebinds each copy to
        // that asset's own attributes: one chart per unit, built once.
        supportsCollections: true,
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
                YSources: 'second',         // second | all
                // Gate: '0' none, else a data source number. Strings because
                // the pane picks it with a plain <select>.
                GateSource: '0',
                GateMin: '',
                GateMax: '',

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
                FitType: 'linear',          // linear | poly2 | poly3
                ShowEquation: true,
                ShowR2: true,

                // Operating envelope
                ShowEnvelope: false,
                EnvelopeXMin: '',
                EnvelopeXMax: '',
                EnvelopeYMin: '',
                EnvelopeYMax: '',
                EnvelopeShape: 'box',       // box | polygon
                EnvelopePolygon: '',        // "x,y; x,y; x,y ..." corners in order

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
            noSize: 0,         // bubble mode: pairs with no size value close enough
            all: [],           // every series, as sent
            list: [],          // [{series, pairs, dropped, noSize, gated}] one per Y
            gated: 0,          // pairs left out by the gate, all series
            noGate: 0          // pairs with no gate value close enough
        };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-xy-body',

            onData: function (d) {
                var all = PVX.data.series(d);
                model.xSeries = all.length > 0 ? all[0] : null;
                model.ySeries = all.length > 1 ? all[1] : null;
                model.zSeries = all.length > 2 ? all[2] : null;
                model.sourceCount = all.length;
                model.all = all;
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
            var gateIdx = (parseInt(cfg.GateSource, 10) || 0) - 1;
            var gate = gateIdx >= 0 && gateIdx < model.all.length ? model.all[gateIdx] : null;
            var bubbleIdx = cfg.BubbleMode && model.zSeries ? 2 : -1;

            // Which sources are Y. The default is the second alone, as always.
            var yIdx = [];
            if (cfg.YSources === 'all') {
                for (var k = 1; k < model.all.length; k++) {
                    if (k !== bubbleIdx && k !== gateIdx) { yIdx.push(k); }
                }
            } else if (model.all.length > 1) {
                yIdx.push(1);
            }

            model.list = [];
            model.gated = 0;
            model.noGate = 0;
            for (var y = 0; y < yIdx.length; y++) {
                var ser = model.all[yIdx[y]];
                var res = mergeByTime(xp, ser.points, maxGapMs);
                var entry = { series: ser, index: yIdx[y], pairs: res.pairs, dropped: res.dropped, noSize: 0 };
                if (bubbleIdx !== -1) {
                    var sz = attachValues(entry.pairs, model.zSeries.points, maxGapMs, 'z');
                    entry.pairs = sz.kept;
                    entry.noSize = sz.missing;
                }
                if (gate) { applyGate(entry, gate.points, maxGapMs, cfg); }
                model.list.push(entry);
            }
            var first = model.list[0];
            model.pairs = first ? first.pairs : [];
            model.dropped = first ? first.dropped : (model.ySeries ? model.ySeries.points.length : 0);
            model.noSize = first ? first.noSize : 0;
        }

        /**
         * Keep only the pairs whose gate value, taken by the same rule as X,
         * lies inside GateMin..GateMax. A pair with no gate value is left out
         * too, and counted apart: "not running" and "unknown" are different.
         */
        function applyGate(entry, gp, maxGapMs, cfg) {
            var lo = PVX.util.num(cfg.GateMin), hi = PVX.util.num(cfg.GateMax);
            var g = attachValues(entry.pairs, gp, maxGapMs, 'g');
            model.noGate += g.missing;
            var kept = [];
            for (var i = 0; i < g.kept.length; i++) {
                var v = g.kept[i].g;
                if ((lo !== null && v < lo) || (hi !== null && v > hi)) { model.gated++; continue; }
                kept.push(g.kept[i]);
            }
            entry.pairs = kept;
        }

        /**
         * The value of another series in force at each pair's instant, as
         * `key`, by the same last-known-value rule and gap limit as X. A pair
         * with no value is dropped and counted rather than given an invented
         * one (a bubble size, a gate reading), so a fit describes exactly the
         * points on the plot.
         */
        function attachValues(pairs, zs, maxGapMs, key) {
            var kept = [], missing = 0, i = 0;
            for (var j = 0; j < pairs.length; j++) {
                var pr = pairs[j];
                if (zs.length) {
                    while (i + 1 < zs.length && zs[i + 1].t <= pr.t) { i++; }
                    var zPt = zs[i];
                    if (zPt.t <= pr.t && pr.t - zPt.t <= maxGapMs) {
                        pr[key] = zPt.v;
                        kept.push(pr);
                        continue;
                    }
                }
                missing++;
            }
            return { kept: kept, missing: missing };
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
         * color
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
            var list = model.list;
            var multi = list.length > 1;
            scope.pvx.title = (xs && ys) ? ((multi ? list.length + ' series' : yName) + ' vs ' + xName) : 'XY Scatter';
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
            var pairs = [];
            for (var li = 0; li < list.length; li++) { pairs = pairs.concat(list[li].pairs); }
            if (!pairs.length) {
                scope.pvx.countText = '';
                scope.pvx.note = [
                    model.dropped ? model.dropped + ' samples had no X value within the pairing window' : '',
                    model.noSize ? model.noSize + ' pairs had no size value within it' : '',
                    model.gated ? model.gated + ' outside the gate' : '',
                    model.noGate ? model.noGate + ' with no gate value' : ''
                ].filter(function (x) { return x; }).join(' · ');
                emptyState(svgRoot, W, H, t,
                    'No paired samples',
                    'X and Y never overlap within ' +
                    (PVX.util.num(cfg.MaxPairGapSeconds) || 60) + 's.');
                digest();
                return;
            }

            // The marker budget is shared, so ten series draw no more than one.
            for (li = 0; li < list.length; li++) {
                for (var pi = 0; pi < list[li].pairs.length; pi++) { list[li].pairs[pi].s = li; }
            }
            var shownBy = list.map(function (en) { return subsample(en.pairs, Math.max(50, Math.floor(MAX_POINTS / list.length))); });
            var shown = [];
            for (li = 0; li < shownBy.length; li++) { shown = shown.concat(shownBy[li]); }
            var sampled = shown.length < pairs.length;

            scope.pvx.countText = cfg.ShowPointCount
                ? PVX.fmt.group(String(pairs.length)) + (pairs.length === 1 ? ' point' : ' points')
                : '';
            var notes = [];
            if (sampled) {
                notes.push('showing ' + PVX.fmt.group(String(shown.length)) + ' of ' +
                           PVX.fmt.group(String(pairs.length)) + ' (uniform sample)');
            }
            var dropped = 0, noSize = 0;
            for (li = 0; li < list.length; li++) { dropped += list[li].dropped; noSize += list[li].noSize; }
            if (dropped) { notes.push(dropped + ' unpaired'); }
            var zs = (cfg.BubbleMode && model.zSeries) ? model.zSeries : null;
            if (noSize) { notes.push(noSize + ' without a size value'); }
            if (cfg.BubbleMode && !zs) { notes.push('bubble size needs a third data source'); }
            var gateIdx = (parseInt(cfg.GateSource, 10) || 0) - 1;
            var gateSer = gateIdx >= 0 && gateIdx < model.all.length ? model.all[gateIdx] : null;
            if (gateSer) {
                var gLo = PVX.util.num(cfg.GateMin), gHi = PVX.util.num(cfg.GateMax);
                notes.push('only while ' + (gateSer.label || 'source ' + (gateIdx + 1)) + ' ' +
                    (gLo !== null && gHi !== null ? PVX.fmt.tick(gLo) + '\u2013' + PVX.fmt.tick(gHi) :
                     gLo !== null ? '\u2265 ' + PVX.fmt.tick(gLo) : gHi !== null ? '\u2264 ' + PVX.fmt.tick(gHi) : 'has a value'));
                if (model.gated) { notes.push(model.gated + ' outside the gate'); }
                if (model.noGate) { notes.push(model.noGate + ' with no gate value'); }
            } else if (gateIdx >= 0) {
                notes.push('gate source ' + (gateIdx + 1) + ' does not exist');
            }
            var used = 1 + list.length + (zs ? 1 : 0) + (gateSer && gateIdx !== 0 && list.every(function (en) { return en.index !== gateIdx; }) ? 1 : 0);
            var extraCount = Math.max(0, model.sourceCount - used);
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
            var poly = cfg.EnvelopeShape === 'polygon' ? parsePolygon(cfg.EnvelopePolygon) : null;
            var hasEnvelope = !!cfg.ShowEnvelope && (poly ? poly.pts.length >= 3 :
                (env.x0 !== null || env.x1 !== null || env.y0 !== null || env.y1 !== null));
            if (cfg.ShowEnvelope && poly && poly.pts.length < 3) {
                notes.push('envelope needs at least three x,y corners');
            }
            if (cfg.ShowEnvelope && poly && poly.bad) {
                notes.push(poly.bad + ' envelope corner' + (poly.bad > 1 ? 's' : '') + ' not read: write each as x,y');
            }
            // Fold the envelope into the extent, otherwise a box drawn outside
            // the data range would be invisible and the operator would think the
            // setting did nothing.
            if (hasEnvelope && poly) {
                for (var pp = 0; pp < poly.pts.length; pp++) { xVals.push(poly.pts[pp][0]); yVals.push(poly.pts[pp][1]); }
            } else if (hasEnvelope) {
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
            // Several series share the axis: name their common units, if any;
            // the legend names the series.
            var yTitle = showAxisTitles ? (cfg.YLabel || (multi ? sharedUnits(list) : axisName(ys))) : '';

            // The ramp key needs its "older"/"newer" captions to mean anything.
            var legendH = ((cfg.ColorMode === 'time' || multi) && showTickLabels) ? (tickFont + 12) : 0;

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
            if (hasEnvelope && poly) {
                PVX.svg.el('path', {
                    d: poly.pts.map(function (q, qi) { return (qi ? 'L' : 'M') + sx(q[0]).toFixed(2) + ' ' + sy(q[1]).toFixed(2); }).join(' ') + ' Z',
                    fill: 'none',
                    stroke: t.textMuted,
                    'stroke-width': 1,
                    'stroke-dasharray': '5 4',
                    'class': 'pvx-xy-envelope'
                }, plotG);
            } else if (hasEnvelope) {
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
                if (poly) { return PVX.stats.inPolygon(pt.x, pt.y, poly.pts); }
                if (env.x0 !== null && pt.x < env.x0) { return false; }
                if (env.x1 !== null && pt.x > env.x1) { return false; }
                if (env.y0 !== null && pt.y < env.y0) { return false; }
                if (env.y1 !== null && pt.y > env.y1) { return false; }
                return true;
            }

            // ---- point colors ------------------------------------------------
            var mode = cfg.ColorMode || 'single';
            var baseColor = cfg.PointColor || cfg.AccentColor || '#3b82c4';
            var stops = timeStops(t);
            var tMin = pairs[0].t, tMax = pairs[pairs.length - 1].t;
            for (i = 0; i < pairs.length; i++) {          // payload order is Y order,
                if (pairs[i].t < tMin) { tMin = pairs[i].t; }   // but be defensive
                if (pairs[i].t > tMax) { tMax = pairs[i].t; }
            }
            var tSpan = (tMax - tMin) || 1;

            // One color per series when there are several: the first keeps
            // PointColor, the rest take the palette, skipping a near twin.
            var serColor = [baseColor];
            var pal = PVX.color.categorical, pc = 0;
            while (serColor.length < list.length) {
                var cand = pal[pc % pal.length];
                pc++;
                if (pc <= pal.length && cand.toLowerCase() === String(baseColor).toLowerCase()) { continue; }
                serColor.push(cand);
            }

            function colorFor(pt) {
                if (!inEnvelope(pt)) { return PVX.color.status.alarm; }
                if (multi && mode === 'single') { return serColor[pt.s]; }
                if (mode === 'time') { return PVX.color.ramp(stops, (pt.t - tMin) / tSpan); }
                // Threshold coloring still honours the shared UseThresholds
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
                    (multi ? (list[pt.s].series.label || 'Y') + ': ' + PVX.fmt.number(pt.y, numOpts) +
                        (list[pt.s].series.units ? ' ' + list[pt.s].series.units : '') :
                        yTip + ': ' + PVX.fmt.number(pt.y, numOpts) + yUnits) + '\n' +
                    (zs ? zTip + ': ' + PVX.fmt.number(pt.z, numOpts) + zUnits + '\n' : '') +
                    PVX.fmt.time(pt.t, 'datetime');

                quad[(cyp < midY ? 0 : 2) + (cxp < midX ? 0 : 1)]++;
            }

            if (hasEnvelope) {
                var outside = 0;
                for (i = 0; i < pairs.length; i++) { if (!inEnvelope(pairs[i])) { outside++; } }
                notes.push(outside ? outside + ' outside the envelope' : 'all inside the envelope');
            }

            // ---- fit ----------------------------------------------------------------
            // Fitted on every pair, not just the drawn sample: the statistics should
            // describe the data, not the decimation. One fit per series.
            var degree = cfg.FitType === 'poly3' ? 3 : cfg.FitType === 'poly2' ? 2 : 1;
            var statLines = [], statColors = [];
            for (li = 0; cfg.ShowRegression && li < list.length; li++) {
                var fitColor = multi ? serColor[li] : (cfg.RegressionColor || '#c8452f');
                var fit = fitOf(list[li].pairs, degree);
                if (!fit) { continue; }
                drawFit(plotG, fit, xd, yd, sx, sy, fitColor);
                var parts = [];
                if (cfg.ShowEquation) { parts.push(equationText(fit, numOpts)); }
                if (cfg.ShowR2) { parts.push('R\u00b2 = ' + fit.r2.toFixed(4)); }
                if (!parts.length) { continue; }
                if (multi) {
                    // Several series: one line each, named, R² first so it survives truncation.
                    statLines.push((list[li].series.label || 'Y') + ': ' + parts.slice().reverse().join(', '));
                    statColors.push(fitColor);
                } else {
                    for (var lp = 0; lp < parts.length; lp++) {
                        statLines.push(parts[lp]);
                        statColors.push(lp === 0 ? fitColor : t.text);
                    }
                }
            }

            // ---- stats box ------------------------------------------------------------
            // The card is only worth its ink if it does not blanket the plot.
            if (statLines.length && plot.w >= 90 && plot.h >= 50) {
                drawStatsBox(svgRoot, plot, statLines.slice(0, Math.max(1, Math.floor((plot.h - 10) / (tickFont * 1.35)) - 1)), quad, t, tickFont, statColors);
            }

            if (multi && legendH > 0 && mode !== 'time') {
                drawSeriesLegend(svgRoot, plot, list, serColor, t, tickFont);
            }

            // ---- time color legend -------------------------------------------------------
            if (mode === 'time' && legendH > 0) {
                drawTimeLegend(svgRoot, defs, host, plot, stops, t, tickFont);
            }

            scope.pvx.note = notes.join(' \u00b7 ');
            digest();
        }

        /* ------------------------------------------------------------------ *
         * render helpers
         * ------------------------------------------------------------------ */

        function sharedUnits(list) {
            var u = list[0].series.units || '';
            for (var i = 1; i < list.length; i++) { if ((list[i].series.units || '') !== u) { return ''; } }
            return u;
        }

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

        /** A line (as before) or a polynomial; null when there is nothing to fit. */
        function fitOf(pairs, degree) {
            if (degree === 1) {
                var reg = PVX.stats.linreg(pairs);
                return reg ? { degree: 1, coef: [reg.intercept, reg.slope], r2: reg.r2 } : null;
            }
            return PVX.stats.polyfit(pairs, degree);
        }

        function drawFit(g, fit, xd, yd, sx, sy, color) {
            if (fit.degree === 1) {
                var seg = clipRegression(fit.coef[1], fit.coef[0], xd, yd);
                if (!seg) { return; }
                PVX.svg.el('line', {
                    x1: sx(seg.x0).toFixed(2), y1: sy(seg.y0).toFixed(2),
                    x2: sx(seg.x1).toFixed(2), y2: sy(seg.y1).toFixed(2),
                    stroke: color, 'stroke-width': 1.8, 'stroke-linecap': 'round', 'class': 'pvx-xy-fit'
                }, g);
                return;
            }
            // A curve across the X range; the plot's clip trims what leaves
            // the window, and a run far outside it is broken rather than
            // drawn as a spike to infinity.
            var d = '', pen = false, steps = 120;
            var span = yd[1] - yd[0];
            for (var i = 0; i <= steps; i++) {
                var x = xd[0] + (xd[1] - xd[0]) * i / steps;
                var y = PVX.stats.polyval(fit.coef, x);
                if (!isFinite(y) || y < yd[0] - span * 2 || y > yd[1] + span * 2) { pen = false; continue; }
                d += (pen ? 'L' : 'M') + sx(x).toFixed(2) + ' ' + sy(y).toFixed(2) + ' ';
                pen = true;
            }
            if (!d) { return; }
            PVX.svg.el('path', {
                d: d, fill: 'none', stroke: color, 'stroke-width': 1.8,
                'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'class': 'pvx-xy-fit'
            }, g);
        }

        /** "y = 0.82x + 3.1" as before; a polynomial highest power first. */
        function equationText(fit, numOpts) {
            if (fit.degree === 1) {
                return 'y = ' + PVX.fmt.number(fit.coef[1], numOpts) + 'x ' +
                    (fit.coef[0] < 0 ? '- ' : '+ ') + PVX.fmt.number(Math.abs(fit.coef[0]), numOpts);
            }
            var sup = ['', '', '\u00b2', '\u00b3', '\u2074'];
            // Zero terms are left out (polyfit zeroes rounding residue), so an
            // exact quadratic reads y = 1.00x² rather than carrying + 0x + 0.
            var out = 'y = ', first = true;
            for (var i = fit.degree; i >= 0; i--) {
                var c = fit.coef[i];
                if (c === 0 && !(i === 0 && first)) { continue; }
                var mag = Math.abs(c) !== 0 && (Math.abs(c) < 0.001 || Math.abs(c) >= 1e6)
                    ? Math.abs(c).toExponential(3) : PVX.fmt.number(Math.abs(c), numOpts);
                out += (first ? (c < 0 ? '-' : '') : (c < 0 ? ' - ' : ' + ')) + mag +
                    (i > 0 ? 'x' + sup[i] : '');
                first = false;
            }
            return out;
        }

        /** Swatch and name per series, above the plot. */
        function drawSeriesLegend(svgRoot, plot, list, colors, t, font) {
            var x = plot.x, y = Math.max(2, plot.y - font - 4) + font / 2;
            var maxX = plot.x + plot.w;
            for (var i = 0; i < list.length; i++) {
                var name = list[i].series.label || ('Y' + (i + 1));
                var w = 10 + Math.min(name.length, 22) * font * 0.58 + 10;
                if (x + w > maxX && i > 0) {
                    PVX.svg.text(svgRoot, x.toFixed(2), y.toFixed(2), '+' + (list.length - i), {
                        'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted
                    });
                    break;
                }
                PVX.svg.el('circle', { cx: (x + 4).toFixed(2), cy: y.toFixed(2), r: 3.5, fill: colors[i], 'class': 'pvx-xy-legend' }, svgRoot);
                PVX.svg.text(svgRoot, (x + 10).toFixed(2), y.toFixed(2), name.length > 22 ? name.slice(0, 21) + '\u2026' : name, {
                    'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted
                });
                x += w;
            }
        }

        /** Polygon envelope corners "x,y; x,y; ..." (or | or one per line). */
        function parsePolygon(text) {
            var out = { pts: [], bad: 0 };
            String(text === null || text === undefined ? '' : text).split(/[;|\n]/).forEach(function (chunk) {
                var c = chunk.trim();
                if (!c) { return; }
                var m = /^(-?[\d.]+(?:[eE][+\-]?\d+)?)\s*[,\s]\s*(-?[\d.]+(?:[eE][+\-]?\d+)?)$/.exec(c);
                var x = m ? parseFloat(m[1]) : NaN, y = m ? parseFloat(m[2]) : NaN;
                if (!isFinite(x) || !isFinite(y)) { out.bad++; return; }
                out.pts.push([x, y]);
            });
            return out;
        }

        /** Park the equation/R² card in whichever quadrant holds fewest markers. */
        function drawStatsBox(svgRoot, plot, lines, quad, t, font, colors) {
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

            // A transparent-background symbol has no surface color to borrow, so
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
                        fill: colors[i] || t.text
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
