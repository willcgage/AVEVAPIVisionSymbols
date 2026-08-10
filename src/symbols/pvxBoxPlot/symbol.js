/* ============================================================================
 * pvxBoxPlot — "PVX Variability": box-and-whisker comparison for PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources), one box per source.
 *
 * The question this symbol answers is "twenty identical assets, which one is
 * misbehaving". A trend of twenty tags is unreadable; twenty boxes side by side
 * are not — the wide box or the long upper whisker is the asset to go and look
 * at. So the symbol is built entirely around COMPARISON: identical geometry per
 * series, one shared value axis, and sort orders that put the outlier asset at
 * the front.
 *
 * The statistics themselves are not computed here. PVX.stats.quartiles() is the
 * single tested implementation of the five-number summary, Tukey fences and
 * outlier extraction for the whole library; this file only decides what to draw
 * and where. That also means the whisker semantics (tukey / percentile / minmax)
 * behave identically here and in every other PVX symbol.
 *
 * NORMALISED SCALES
 *   A shared axis is the point of the chart, but it collapses the moment the
 *   sources have different units — one tag reading 610 mA next to one reading
 *   0.42 uS/cm leaves nineteen flat lines and one box. NormalizeScales maps each
 *   series onto its OWN 0-100% range, so the boxes stay comparable by shape
 *   (skew, relative spread, whisker asymmetry) even though the magnitudes are
 *   unrelated. That is a genuine change of meaning — the axis no longer carries
 *   engineering units — so it is off by default, the axis switches to percent,
 *   and every tooltip states the real min/max it was scaled against.
 *
 * RENDERING
 *   Everything except the header/footer chrome is SVG drawn into
 *   `.pvx-box-body`. Geometry is written once against an abstract
 *   (category-axis, value-axis) coordinate pair and flipped by two tiny helpers,
 *   so vertical and horizontal orientations cannot drift apart.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxBoxPlot',
        displayName: 'PVX Variability',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // A collection would repeat the whole comparison once per asset, which
        // destroys the only thing this symbol is for.
        supportsCollections: false,
        configTitle: 'Format Variability',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                // Plot values gives us the historian's own representative sample
                // of each interval; 400 intervals is enough for stable quartiles
                // without pulling a full archive per tag per refresh.
                DataQueryMode: 'ModePlotValues',
                Intervals: 400,
                Height: 260,
                Width: 420,

                Title: '',                   // blank => generic heading

                // --- shape -------------------------------------------------
                Orientation: 'vertical',     // vertical | horizontal

                // --- statistics --------------------------------------------
                WhiskerMode: 'tukey',        // tukey | percentile | minmax
                WhiskerK: 1.5,
                LowPercentile: 5,
                HighPercentile: 95,

                // --- outliers ----------------------------------------------
                ShowOutliers: true,
                OutlierSize: 2.2,
                OutlierOpacity: 0.5,
                MaxOutliers: 200,

                // --- box decoration ----------------------------------------
                ShowMean: true,
                ShowNotch: false,
                ShowValues: false,
                BoxWidthFraction: 0.6,

                // --- colour -------------------------------------------------
                ColorMode: 'single',         // single | palette | threshold
                BoxColor: '#3b82c4',
                BoxOpacity: 0.55,

                // --- scale ---------------------------------------------------
                NormalizeScales: false,
                ShowScale: true,
                TickCount: 5,
                ScaleMin: '',
                ScaleMax: '',

                // --- layout ---------------------------------------------------
                NameWidthPct: 26,            // horizontal orientation only
                SortBy: 'none',              // none|name|medianAsc|medianDesc|spreadDesc
                MaxBoxes: 30,
                ShowSummaryLine: false
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the chart itself is SVG.
        scope.pvx = {
            title: '',
            subtitle: '',
            note: '',
            count: '',
            error: '',
            background: ''
        };

        var series = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-box-body',
            onData: function (d) { series = PVX.data.series(d) || []; },
            render: render
        });

        /* ================================================================ *
         * Small numeric helpers
         * ================================================================ */

        function intOr(v, fallback) {
            var n = parseInt(v, 10);
            return isFinite(n) ? n : fallback;
        }

        /** PVX.util.num returns null for blank/garbage; clamp() would silently
         *  turn that into the floor, so every read goes through here first. */
        function numOr(v, fallback) {
            var n = PVX.util.num(v);
            return n === null ? fallback : n;
        }

        /**
         * Options for PVX.stats.quartiles. Percentiles are entered 0-100 in the
         * config pane because that is how process engineers write them, and the
         * core takes fractions — converting in exactly one place keeps a "95"
         * from ever being read as 9500%.
         */
        function quartOpts(cfg) {
            var lo = PVX.util.clamp(numOr(cfg.LowPercentile, 5), 0, 100);
            var hi = PVX.util.clamp(numOr(cfg.HighPercentile, 95), 0, 100);
            if (hi < lo) { var swap = lo; lo = hi; hi = swap; }
            return {
                whisker: cfg.WhiskerMode || 'tukey',
                k: PVX.util.clamp(numOr(cfg.WhiskerK, 1.5), 0, 10),
                lowP: lo / 100,
                highP: hi / 100
            };
        }

        /** Uniform decimation that preserves the spread of a sorted array. */
        function subsample(arr, cap) {
            if (!arr || arr.length <= cap) { return arr || []; }
            var out = [], nn = arr.length;
            for (var i = 0; i < cap; i++) { out.push(arr[Math.floor(i * nn / cap)]); }
            return out;
        }

        /**
         * Raw engineering value -> the value actually plotted.
         * Identity unless NormalizeScales is on, in which case the series' own
         * observed range becomes 0-100%. A constant tag has no range to scale
         * against, so it is parked mid-axis rather than dividing by zero.
         */
        function toDisp(item, v, norm) {
            if (!norm) { return v; }
            if (!(item.span > 0)) { return 50; }
            return ((v - item.lo) / item.span) * 100;
        }

        /* ================================================================ *
         * Pure model — no DOM, no drawing decisions
         * ================================================================ */

        function compareBy(mode) {
            // The index tiebreak keeps ordering deterministic: Array#sort is not
            // guaranteed stable on the older engines PI Vision still supports.
            switch (mode) {
                case 'name':
                    return function (a, b) {
                        var la = String(a.label).toLowerCase(), lb = String(b.label).toLowerCase();
                        return la < lb ? -1 : (la > lb ? 1 : a.index - b.index);
                    };
                case 'medianAsc':
                    return function (a, b) { return (a.q.median - b.q.median) || (a.index - b.index); };
                case 'medianDesc':
                    return function (a, b) { return (b.q.median - a.q.median) || (a.index - b.index); };
                case 'spreadDesc':
                    // Widest IQR first, measured in DISPLAY space. Comparing raw
                    // IQRs across mixed units ranks by unit magnitude, not by
                    // variability; with NormalizeScales off display space is raw
                    // space, so nothing changes for the single-unit case.
                    return function (a, b) { return (b.d.iqr - a.d.iqr) || (a.index - b.index); };
                case 'none':
                default:
                    return function (a, b) { return a.index - b.index; };
            }
        }

        /**
         * series + config -> everything the renderer needs.
         * @returns {Object} {items, notes[], hidden, sparse, badCount, sources, empty}
         */
        function buildModel(cfg) {
            var i, j;
            var norm = !!cfg.NormalizeScales;
            var qo = quartOpts(cfg);
            var maxOut = PVX.util.clamp(intOr(cfg.MaxOutliers, 200), 0, 5000);
            var items = [];
            var emptySeries = 0, sparseCount = 0, badCount = 0, trimmedOutliers = 0;

            for (i = 0; i < series.length; i++) {
                var s = series[i];
                var vals = [];
                for (j = 0; j < s.points.length; j++) { vals.push(s.points[j].v); }

                var q = PVX.stats.quartiles(vals, qo);
                if (!q) { emptySeries += 1; continue; }
                if (s.good === false) { badCount += 1; }

                var it = {
                    label: s.label || ('Series ' + (i + 1)),
                    units: s.units || '',
                    path: s.path || '',
                    good: s.good !== false,
                    error: s.errorDescription || '',
                    index: i,
                    q: q,
                    n: q.n,
                    // Fewer than four samples cannot support quartiles: Q1 and Q3
                    // would be interpolations between two or three points and the
                    // box would encode nothing. Drawn as a bare tick instead.
                    sparse: q.n < 4,
                    lo: q.min,
                    span: q.max - q.min,
                    outlierTotal: 0,
                    outlierShown: 0,
                    outliers: []
                };

                it.d = {
                    min: toDisp(it, q.min, norm),
                    max: toDisp(it, q.max, norm),
                    q1: toDisp(it, q.q1, norm),
                    q3: toDisp(it, q.q3, norm),
                    median: toDisp(it, q.median, norm),
                    lower: toDisp(it, q.lower, norm),
                    upper: toDisp(it, q.upper, norm),
                    mean: toDisp(it, q.mean, norm)
                };
                it.d.iqr = Math.abs(it.d.q3 - it.d.q1);

                // Median confidence interval, the standard +/-1.58*IQR/sqrt(n)
                // construction. Two boxes whose notches do not overlap have
                // medians that differ at roughly 95% confidence.
                var half = q.n > 0 ? (1.58 * q.iqr / Math.sqrt(q.n)) : 0;
                it.d.notchLo = toDisp(it, q.median - half, norm);
                it.d.notchHi = toDisp(it, q.median + half, norm);

                if (!it.sparse && cfg.ShowOutliers !== false) {
                    it.outlierTotal = q.outliers.length;
                    // Hundreds of markers on one box overplot into a solid bar
                    // that reads as a second box, so the drawn set is capped and
                    // the true count goes in the tooltip.
                    var outs = subsample(q.outliers, maxOut);
                    for (j = 0; j < outs.length; j++) { it.outliers.push(toDisp(it, outs[j], norm)); }
                    it.outlierShown = outs.length;
                    if (it.outlierTotal > it.outlierShown) { trimmedOutliers += 1; }
                }

                if (it.sparse) { sparseCount += 1; }
                items.push(it);
            }

            items.sort(compareBy(cfg.SortBy));

            // Beyond this the boxes are sub-pixel and the SVG node count starts
            // to hurt PI Vision's re-layout on every resize.
            var hidden = 0;
            var maxBoxes = PVX.util.clamp(intOr(cfg.MaxBoxes, 30), 1, 60);
            if (items.length > maxBoxes) {
                hidden = items.length - maxBoxes;
                items = items.slice(0, maxBoxes);
            }

            var notes = [];
            if (norm) { notes.push('each box scaled 0-100% of its own range'); }
            if (sparseCount) {
                notes.push(sparseCount + (sparseCount === 1 ? ' series has' : ' series have') +
                    ' fewer than 4 points — shown as a tick');
            }
            if (emptySeries) {
                notes.push(emptySeries + (emptySeries === 1 ? ' series has' : ' series have') + ' no numeric data');
            }
            if (trimmedOutliers) { notes.push('outliers capped at ' + maxOut + ' per box'); }
            if (hidden) { notes.push('+' + hidden + ' more not shown'); }

            return {
                items: items,
                notes: notes,
                hidden: hidden,
                sparse: sparseCount,
                badCount: badCount,
                sources: series.length,
                normalised: norm,
                empty: items.length === 0
            };
        }

        /* ================================================================ *
         * Text helpers
         * ================================================================ */

        /**
         * Approximate rendered width. Measuring properly costs a forced layout
         * per string, which is fine for a handful of names but not for the
         * margin arithmetic that runs before anything is in the DOM. 0.58em is
         * the mean advance of Segoe UI / Roboto at these sizes.
         */
        function textPx(s, fontPx) {
            return String(s === null || s === undefined ? '' : s).length * fontPx * 0.58;
        }

        function truncate(s, maxPx, fontPx) {
            var str = String(s === null || s === undefined ? '' : s);
            var per = fontPx * 0.58;
            var max = Math.floor(maxPx / per);
            if (max < 1) { return ''; }
            if (str.length <= max) { return str; }
            if (max === 1) { return '…'; }
            return str.slice(0, max - 1) + '…';
        }

        /**
         * Trim an already-drawn <text> until getComputedTextLength() reports it
         * fits `maxPx`, re-adding the ellipsis.
         *
         * The 0.58em estimate above is good enough for numbers, which are
         * centre-anchored and only shift a pixel or two when it is wrong. It is
         * NOT good enough for asset names: those are end-anchored against the
         * left edge of the symbol, and mixed-case proper nouns ("Feedwater Pump
         * B Amps") average well above 0.58em, so an under-estimate pushes the
         * start of the string off-canvas where overflow:hidden chops the first
         * glyph instead of ellipsising the last. No after-the-fact clamp can
         * recover that — the string has to be short enough. Cost is one forced
         * layout per name, bounded by MaxBoxes.
         *
         * The caller passes text already cut by the estimate, so the common case
         * measures once and returns; when it does not, each pass takes a
         * proportional bite out of the measured overshoot rather than walking a
         * character at a time.
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
                var core = cur.charAt(cur.length - 1) === '…' ? cur.slice(0, -1) : cur;
                if (core.length < 2) { node.textContent = ''; return; }
                // -1 leaves room for the ellipsis; the min() guarantees the
                // string shrinks every pass even when the ratio rounds up.
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return; }
                node.textContent = core.slice(0, keep) + '…';
            }
            if (measure() > maxPx) { node.textContent = ''; }
        }

        /* ================================================================ *
         * Colour
         * ================================================================ */

        function boxColor(item, idx, cfg, t) {
            var base = cfg.BoxColor || t.categorical[0];
            switch (cfg.ColorMode) {
                case 'palette':
                    return t.categorical[idx % t.categorical.length];
                case 'threshold':
                    // Thresholds are written in engineering units, so they are
                    // always evaluated against the RAW median even when the axis
                    // has been normalised to percent. Falls back to the flat
                    // colour when bands are switched off, so the mode never
                    // silently paints every box one colour.
                    return cfg.UseThresholds !== false
                        ? PVX.thresholds.colorFor(cfg.Thresholds, item.q.median, base)
                        : base;
                case 'single':
                default:
                    return base;
            }
        }

        /**
         * Hatched fill for bad quality. An operator must be able to see at a
         * glance that a box's spread is not trustworthy, and a solid box in a
         * "stale" colour still reads as a real measurement.
         * One pattern per colour per render; ids are unique so several instances
         * of the symbol on one display cannot collide.
         */
        function hatchFor(defs, cache, fill) {
            if (cache[fill]) { return cache[fill]; }
            var id = PVX.util.uid('pvxboxhatch');
            var p = PVX.svg.el('pattern', {
                id: id,
                width: 6, height: 6,
                patternUnits: 'userSpaceOnUse',
                patternTransform: 'rotate(45)'
            }, defs);
            PVX.svg.el('rect', { x: 0, y: 0, width: 6, height: 6, fill: fill, 'fill-opacity': 0.18 }, p);
            PVX.svg.el('rect', { x: 0, y: 0, width: 3, height: 6, fill: fill, 'fill-opacity': 0.85 }, p);
            cache[fill] = 'url(#' + id + ')';
            return cache[fill];
        }

        /* ================================================================ *
         * Render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            var W = Math.max(40, c.width);
            var H = Math.max(30, c.height);

            var svgRoot = host.querySelector('svg.pvx-box-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-box-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var model = buildModel(cfg);

            // ---- chrome ------------------------------------------------------
            scope.pvx.title = cfg.Title || 'Variability';
            scope.pvx.subtitle = model.normalised
                ? 'normalised 0-100%'
                : commonUnitsSuffix(cfg, model);
            scope.pvx.note = model.notes.join(' · ');
            scope.pvx.count = model.items.length
                ? ((model.items.length < model.sources
                        ? model.items.length + ' of ' + model.sources
                        : String(model.items.length)) +
                   (model.sources === 1 ? ' series' : ' series'))
                : '';
            scope.pvx.error = model.badCount
                ? (model.badCount + (model.badCount === 1 ? ' series reports' : ' series report') + ' bad quality')
                : '';

            if (model.empty) {
                emptyState(svgRoot, W, H, t,
                    series.length ? 'No numeric samples' : 'No data sources',
                    series.length
                        ? 'All ' + series.length + ' sources returned empty windows.'
                        : 'Drop one or more attributes onto this symbol.');
                digest();
                return;
            }

            drawChart(svgRoot, W, H, cfg, t, model);
            digest();
        }

        /** Units are only meaningful in the header when every series agrees. */
        function commonUnitsSuffix(cfg, model) {
            if (cfg.ShowUnits === false) { return ''; }
            var u = null;
            for (var i = 0; i < model.items.length; i++) {
                var iu = model.items[i].units || '';
                if (u === null) { u = iu; }
                else if (u !== iu) { return 'mixed units'; }
            }
            return u || '';
        }

        function drawChart(svgRoot, W, H, cfg, t, model) {
            var i, j;
            var items = model.items;
            var n = items.length;
            var vert = cfg.Orientation !== 'horizontal';
            var norm = model.normalised;
            var defs = PVX.svg.el('defs', null, svgRoot);
            var hatchCache = {};
            var numOpts = PVX.config.numberOpts(cfg);

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 24), 8, 12);
            var pad = 5;
            var showScale = cfg.ShowScale !== false;
            // Below roughly 200x140 the tick labels eat more of the frame than
            // they explain. The boxes still carry the comparison, so drop the
            // text and keep the shapes.
            var showTicks = showScale && W >= 200 && H >= 140;
            // Same reasoning one step further down: at mosaic sizes a name band
            // costs a third of the frame and delivers two glyphs of a tag name.
            // Dropping it entirely gives the height back to the boxes, which are
            // the only thing still legible — the tooltip still names every box.
            // (W/H here are the plot host's, i.e. already net of header and
            // footer, so the thresholds are lower than the symbol sizes they
            // correspond to: ~200x140 keeps its names but loses its ticks.)
            var showNames = W >= 160 && H >= 96;

            /* ---- value domain --------------------------------------------- */
            var tickCount = PVX.util.clamp(intOr(cfg.TickCount, 5), 2, 10);
            var dom;
            if (norm) {
                // Normalisation already defines the axis; recomputing an extent
                // from the mapped values would just re-introduce the squashing
                // the mode exists to remove.
                dom = [0, 100];
            } else {
                var lo = null, hi = null;
                var consider = function (v) {
                    if (!PVX.util.isNum(v)) { return; }
                    if (lo === null || v < lo) { lo = v; }
                    if (hi === null || v > hi) { hi = v; }
                };
                for (i = 0; i < n; i++) {
                    var d = items[i].d;
                    if (items[i].sparse) { consider(d.median); continue; }
                    consider(d.lower); consider(d.upper);
                    consider(d.median); consider(d.mean);
                    for (j = 0; j < items[i].outliers.length; j++) { consider(items[i].outliers[j]); }
                }
                if (lo === null) { lo = 0; hi = 1; }
                dom = PVX.scale.niceDomain(lo, hi, tickCount);
            }
            var sMin = PVX.util.num(cfg.ScaleMin);
            var sMax = PVX.util.num(cfg.ScaleMax);
            if (sMin !== null) { dom[0] = sMin; }
            if (sMax !== null) { dom[1] = sMax; }
            if (!(dom[1] > dom[0])) { dom[1] = dom[0] + 1; }   // never divide by zero

            var ticks = showScale ? PVX.scale.ticks(dom[0], dom[1], tickCount) : [];
            var tickLabel = function (v) {
                return norm ? (Math.round(v) + '%') : PVX.fmt.tick(v);
            };

            /* ---- label budgets --------------------------------------------- */
            var maxTickPx = 0;
            var lastTickPx = 0;
            if (showTicks) {
                for (i = 0; i < ticks.length; i++) {
                    maxTickPx = Math.max(maxTickPx, textPx(tickLabel(ticks[i]), font));
                }
                // The tick at the top of the domain sits exactly on the end of
                // the axis, so half of it hangs outside the plot box and has to
                // be paid for in the margin or the frame clips it.
                if (ticks.length) { lastTickPx = textPx(tickLabel(ticks[ticks.length - 1]), font); }
            }
            var valueLabels = [];
            var maxValuePx = 0;
            if (cfg.ShowValues) {
                for (i = 0; i < n; i++) {
                    // The printed number is the REAL median even when the axis is
                    // in percent — a percentage of an invisible range is not a
                    // number anybody can act on.
                    valueLabels.push(PVX.fmt.number(items[i].q.median, numOpts));
                    maxValuePx = Math.max(maxValuePx, textPx(valueLabels[i], font));
                }
            }

            /* ---- plot box ---------------------------------------------------- */
            var mLeft = pad, mRight = pad, mTop = pad, mBottom = pad;
            var nameW = 0;
            var rotateNames = false;

            if (vert) {
                if (showTicks) { mLeft += maxTickPx + 6; mTop += font * 0.7; }
                if (cfg.ShowValues) { mTop += font * 1.6; }
            } else {
                if (showNames) {
                    nameW = PVX.util.clamp(W * (numOr(cfg.NameWidthPct, 26)) / 100, 26, W * 0.55);
                    mLeft += nameW + 6;
                }
                if (showTicks) { mBottom += font * 1.9; mRight += lastTickPx / 2; }
                if (cfg.ShowValues) { mRight += maxValuePx + 8; }
            }

            var plot = { x0: mLeft, y0: mTop, x1: W - mRight, y1: H - mBottom };

            if (vert && showNames) {
                // The name band's height depends on whether names fit upright,
                // which depends on the slot width — so it is resolved after the
                // horizontal margins but before the vertical ones are final.
                var slotW = (plot.x1 - plot.x0) / Math.max(1, n);
                rotateNames = slotW < font * 4.5;
                mBottom += rotateNames ? font * 4.2 : font * 1.9;
                plot.y1 = H - mBottom;
            }

            // Degenerate boxes (tiny symbol, huge labels): give the chart the
            // whole frame rather than drawing nothing at all.
            if (plot.x1 - plot.x0 < 16) { plot.x0 = pad; plot.x1 = W - pad; nameW = 0; }
            if (plot.y1 - plot.y0 < 16) { plot.y0 = pad; plot.y1 = H - pad; }

            /* ---- axes -------------------------------------------------------- */
            // Everything below is written against an abstract pair: `a` runs
            // along the CATEGORY axis (one box per slot) and `b` along the VALUE
            // axis. lattr/rattr/pt flip them for the chosen orientation, so a
            // geometry fix can never land in one orientation only.
            var vs = vert
                ? PVX.scale.linear(dom[0], dom[1], plot.y1, plot.y0)   // SVG y grows down
                : PVX.scale.linear(dom[0], dom[1], plot.x0, plot.x1);

            var catStart = vert ? plot.x0 : plot.y0;
            var catSpan = vert ? (plot.x1 - plot.x0) : (plot.y1 - plot.y0);
            var slot = catSpan / n;
            var center = function (idx) { return catStart + slot * (idx + 0.5); };

            var frac = PVX.util.clamp(numOr(cfg.BoxWidthFraction, 0.6), 0.1, 1);
            // A single series would otherwise produce one box as thick as the
            // whole symbol, which reads as a background block rather than a box.
            var bw = Math.max(2, Math.min(slot * frac, Math.max(22, catSpan * 0.35)));

            function lattr(a1, b1, a2, b2) {
                return vert
                    ? { x1: a1.toFixed(2), y1: b1.toFixed(2), x2: a2.toFixed(2), y2: b2.toFixed(2) }
                    : { x1: b1.toFixed(2), y1: a1.toFixed(2), x2: b2.toFixed(2), y2: a2.toFixed(2) };
            }
            function rattr(a0, a1, b0, b1) {
                var alo = Math.min(a0, a1), ahi = Math.max(a0, a1);
                var blo = Math.min(b0, b1), bhi = Math.max(b0, b1);
                return vert
                    ? { x: alo.toFixed(2), y: blo.toFixed(2), width: (ahi - alo).toFixed(2), height: Math.max(1, bhi - blo).toFixed(2) }
                    : { x: blo.toFixed(2), y: alo.toFixed(2), width: Math.max(1, bhi - blo).toFixed(2), height: (ahi - alo).toFixed(2) };
            }
            function pt(a, b) {
                return vert ? (a.toFixed(2) + ' ' + b.toFixed(2)) : (b.toFixed(2) + ' ' + a.toFixed(2));
            }

            /* ---- grid ---------------------------------------------------------- */
            if (showScale && ticks.length) {
                var gridG = PVX.svg.el('g', { 'class': 'pvx-box-grid pvx-grid-line', stroke: t.grid }, svgRoot);
                for (i = 0; i < ticks.length; i++) {
                    PVX.svg.el('line', lattr(catStart, vs(ticks[i]), catStart + catSpan, vs(ticks[i])), gridG);
                }
            }

            /* ---- summary line -------------------------------------------------- */
            // The median of the medians. A group that has drifted together shows
            // up as every box sitting to one side of this line.
            if (cfg.ShowSummaryLine && n > 1) {
                var meds = [];
                for (i = 0; i < n; i++) { meds.push(items[i].d.median); }
                var gm = PVX.stats.percentile(meds, 0.5);
                if (gm !== null) {
                    var sl = PVX.svg.el('line', lattr(catStart, vs(gm), catStart + catSpan, vs(gm)), svgRoot);
                    sl.setAttribute('class', 'pvx-box-summary');
                    sl.setAttribute('stroke', t.textMuted);
                    sl.setAttribute('stroke-width', '1');
                    sl.setAttribute('stroke-dasharray', '5 4');
                    PVX.svg.el('title', null, sl).textContent =
                        'Median of medians: ' + (norm ? Math.round(gm) + '%' : PVX.fmt.number(gm, numOpts));
                }
            }

            /* ---- boxes ---------------------------------------------------------- */
            var boxesG = PVX.svg.el('g', { 'class': 'pvx-box-boxes' }, svgRoot);
            for (i = 0; i < n; i++) {
                drawOneBox(boxesG, defs, hatchCache, items[i], i, cfg, t, {
                    vert: vert, norm: norm, vs: vs, center: center(i), bw: bw,
                    lattr: lattr, rattr: rattr, pt: pt, numOpts: numOpts
                });
            }

            /* ---- category names -------------------------------------------------- */
            var namesG = PVX.svg.el('g', { 'class': 'pvx-box-names' }, svgRoot);
            for (i = 0; showNames && i < n; i++) {
                var item = items[i];
                // Bad quality is marked on the name as well as the box: at small
                // sizes the hatch pattern is only a few pixels wide. The marker
                // leads the string because every truncation path here eats the
                // tail — a suffix would be the first thing lost.
                var name = (item.good ? '' : '! ') + item.label;
                var nameFill = item.good ? t.textMuted : t.status.alarm;
                var cc = center(i);

                if (!vert) {
                    if (slot < font * 1.1) { break; }   // no room for a legible name
                    // Budget is the name column, but never more than the room
                    // between the anchor and the frame edge.
                    var avail = Math.min(nameW - 4, plot.x0 - 7);
                    var nt = PVX.svg.text(namesG, (plot.x0 - 6).toFixed(2), cc.toFixed(2),
                        truncate(name, avail, font), {
                            'class': 'pvx-svg-label pvx-box-name',
                            'text-anchor': 'end', 'font-size': font, fill: nameFill
                        });
                    fitTextTo(nt, avail);
                    PVX.svg.el('title', null, nt).textContent = name;
                } else {
                    if (slot < font * 0.75) { break; }
                    var ny = plot.y1 + font * 1.2;
                    var vt;
                    if (rotateNames) {
                        // -45 degrees keeps long names readable without the
                        // vertical-text guessing game. The text runs down-left
                        // from its anchor, so its length is bounded by the room
                        // below the plot AND the room to the left edge — times
                        // sqrt(2) because it lies on the diagonal.
                        var diag = Math.max(0, Math.min(H - ny - 2, cc - 2)) * 1.414;
                        vt = PVX.svg.text(namesG, 0, 0, truncate(name, diag, font), {
                            'class': 'pvx-svg-label pvx-box-name',
                            'text-anchor': 'end', 'font-size': font, fill: nameFill,
                            transform: 'translate(' + cc.toFixed(2) + ',' + ny.toFixed(2) + ') rotate(-45)'
                        });
                        fitTextTo(vt, diag);
                    } else {
                        vt = PVX.svg.text(namesG, cc.toFixed(2), ny.toFixed(2),
                            truncate(name, slot * 1.05, font), {
                                'class': 'pvx-svg-label pvx-box-name',
                                'text-anchor': 'middle', 'font-size': font, fill: nameFill
                            });
                        fitTextTo(vt, slot * 1.05);
                    }
                    PVX.svg.el('title', null, vt).textContent = name;
                }
            }

            /* ---- median value labels ---------------------------------------------- */
            // Parked in a single row (vertical) or column (horizontal) rather
            // than floating beside each whisker end: a straight line of numbers
            // is comparable at a glance, and it cannot collide with the boxes.
            if (cfg.ShowValues) {
                var valG = PVX.svg.el('g', { 'class': 'pvx-box-values' }, svgRoot);
                for (i = 0; i < n; i++) {
                    var cv = center(i);
                    var lt;
                    if (vert) {
                        if (slot < font * 1.6) { break; }
                        lt = PVX.svg.text(valG, cv.toFixed(2), (plot.y0 - font * 0.55).toFixed(2),
                            truncate(valueLabels[i], slot * 0.95, font), {
                                'class': 'pvx-svg-value pvx-num pvx-box-value',
                                'text-anchor': 'middle', 'font-size': font, fill: t.text
                            });
                        fitTextTo(lt, slot * 0.95);
                    } else {
                        if (slot < font * 1.1) { break; }
                        var vAvail = Math.max(0, W - plot.x1 - 7);
                        lt = PVX.svg.text(valG, (plot.x1 + 5).toFixed(2), cv.toFixed(2),
                            truncate(valueLabels[i], vAvail, font), {
                                'class': 'pvx-svg-value pvx-num pvx-box-value',
                                'text-anchor': 'start', 'font-size': font, fill: t.text
                            });
                        fitTextTo(lt, vAvail);
                    }
                }
            }

            /* ---- value axis ticks --------------------------------------------------- */
            if (showTicks) {
                var axisG = PVX.svg.el('g', { 'class': 'pvx-box-axis' }, svgRoot);
                for (i = 0; i < ticks.length; i++) {
                    var q = vs(ticks[i]);
                    if (vert) {
                        PVX.svg.text(axisG, (plot.x0 - 5).toFixed(2), q.toFixed(2), tickLabel(ticks[i]), {
                            'class': 'pvx-svg-label', 'text-anchor': 'end',
                            'font-size': font, fill: t.textMuted
                        });
                    } else {
                        PVX.svg.text(axisG, q.toFixed(2), (plot.y1 + font * 1.1).toFixed(2), tickLabel(ticks[i]), {
                            'class': 'pvx-svg-label', 'text-anchor': 'middle',
                            'font-size': font, fill: t.textMuted
                        });
                    }
                }
            }
        }

        /**
         * One box-and-whisker glyph (or, for a series too short for quartiles,
         * one muted tick). `g` carries the orientation-flipping helpers so this
         * function never needs to know which way up the chart is.
         */
        function drawOneBox(parent, defs, hatchCache, item, idx, cfg, t, g) {
            var d = item.d;
            var c = g.center;
            var bw = g.bw;
            var a0 = c - bw / 2, a1 = c + bw / 2;
            var col = boxColor(item, idx, cfg, t);
            var grp = PVX.svg.el('g', { 'class': 'pvx-box-item' }, parent);

            // Tooltip first, so it is attached even if the geometry below is
            // degenerate for some reason.
            PVX.svg.el('title', null, grp).textContent = tooltipFor(item, cfg, g.norm);

            if (item.sparse) {
                // A single muted tick. Drawing a box from two points would imply
                // a distribution that was never measured.
                var tick = PVX.svg.el('line',
                    g.lattr(c - bw * 0.4, g.vs(d.median), c + bw * 0.4, g.vs(d.median)), grp);
                tick.setAttribute('class', 'pvx-box-tick');
                tick.setAttribute('stroke', t.textMuted);
                tick.setAttribute('stroke-width', '2');
                tick.setAttribute('stroke-linecap', 'round');
                return;
            }

            var fill = item.good ? col : hatchFor(defs, hatchCache, col);
            var opacity = PVX.util.clamp(numOr(cfg.BoxOpacity, 0.55), 0.05, 1);

            /* --- whisker --------------------------------------------------- */
            var wLine = PVX.svg.el('line', g.lattr(c, g.vs(d.lower), c, g.vs(d.upper)), grp);
            wLine.setAttribute('class', 'pvx-box-whisker');
            wLine.setAttribute('stroke', col);
            wLine.setAttribute('stroke-width', '1');

            var capA = Math.max(1.5, bw * 0.28);
            var lowCap = PVX.svg.el('line', g.lattr(c - capA, g.vs(d.lower), c + capA, g.vs(d.lower)), grp);
            lowCap.setAttribute('stroke', col);
            lowCap.setAttribute('stroke-width', '1');
            var hiCap = PVX.svg.el('line', g.lattr(c - capA, g.vs(d.upper), c + capA, g.vs(d.upper)), grp);
            hiCap.setAttribute('stroke', col);
            hiCap.setAttribute('stroke-width', '1');

            /* --- box ------------------------------------------------------- */
            var bq1 = g.vs(d.q1), bq3 = g.vs(d.q3), bm = g.vs(d.median);
            var medA0 = a0, medA1 = a1;

            if (cfg.ShowNotch) {
                // The notch is clamped inside the box: with a small n the
                // interval can exceed the IQR, and a notch drawn outside the box
                // reads as a rendering fault rather than as low confidence.
                var qLo = Math.min(d.q1, d.q3), qHi = Math.max(d.q1, d.q3);
                var nLo = PVX.util.clamp(d.notchLo, qLo, qHi);
                var nHi = PVX.util.clamp(d.notchHi, qLo, qHi);
                var ai0 = c - bw * 0.25, ai1 = c + bw * 0.25;
                var bnl = g.vs(nLo), bnh = g.vs(nHi);
                var path = 'M' + g.pt(a0, bq3) +
                    ' L' + g.pt(a1, bq3) +
                    ' L' + g.pt(a1, bnh) +
                    ' L' + g.pt(ai1, bm) +
                    ' L' + g.pt(a1, bnl) +
                    ' L' + g.pt(a1, bq1) +
                    ' L' + g.pt(a0, bq1) +
                    ' L' + g.pt(a0, bnl) +
                    ' L' + g.pt(ai0, bm) +
                    ' L' + g.pt(a0, bnh) + ' Z';
                PVX.svg.el('path', {
                    d: path, fill: fill, 'fill-opacity': opacity,
                    stroke: col, 'stroke-width': 1, 'class': 'pvx-box-rect'
                }, grp);
                medA0 = ai0; medA1 = ai1;
            } else {
                var r = PVX.svg.el('rect', g.rattr(a0, a1, bq1, bq3), grp);
                r.setAttribute('class', 'pvx-box-rect');
                r.setAttribute('fill', fill);
                r.setAttribute('fill-opacity', opacity);
                r.setAttribute('stroke', col);
                r.setAttribute('stroke-width', '1');
            }

            /* --- median ----------------------------------------------------- */
            // Darker than the box and twice as thick: the median is the number
            // people actually read off the chart.
            var med = PVX.svg.el('line', g.lattr(medA0, bm, medA1, bm), grp);
            med.setAttribute('class', 'pvx-box-median');
            med.setAttribute('stroke', PVX.color.mix(col, t.dark ? '#ffffff' : '#000000', 0.35));
            med.setAttribute('stroke-width', '2');

            /* --- mean ------------------------------------------------------- */
            if (cfg.ShowMean && PVX.util.isNum(d.mean)) {
                var mr = PVX.util.clamp(bw * 0.22, 2, 5);
                var mx = g.vert ? c : g.vs(d.mean);
                var my = g.vert ? g.vs(d.mean) : c;
                PVX.svg.el('path', {
                    d: 'M' + mx.toFixed(2) + ' ' + (my - mr).toFixed(2) +
                       ' L' + (mx + mr).toFixed(2) + ' ' + my.toFixed(2) +
                       ' L' + mx.toFixed(2) + ' ' + (my + mr).toFixed(2) +
                       ' L' + (mx - mr).toFixed(2) + ' ' + my.toFixed(2) + ' Z',
                    fill: t.surface === 'transparent' ? col : t.surface,
                    stroke: col,
                    'stroke-width': 1,
                    'class': 'pvx-box-mean'
                }, grp);
            }

            /* --- outliers ---------------------------------------------------- */
            if (item.outliers.length) {
                var or2 = PVX.util.clamp(numOr(cfg.OutlierSize, 2.2), 0.5, 10);
                var oop = PVX.util.clamp(numOr(cfg.OutlierOpacity, 0.5), 0.05, 1);
                var og = PVX.svg.el('g', { 'class': 'pvx-box-outliers' }, grp);
                for (var k = 0; k < item.outliers.length; k++) {
                    var ov = g.vs(item.outliers[k]);
                    PVX.svg.el('circle', {
                        cx: (g.vert ? c : ov).toFixed(2),
                        cy: (g.vert ? ov : c).toFixed(2),
                        r: or2,
                        fill: col,
                        'fill-opacity': oop
                    }, og);
                }
            }
        }

        /** The full five-number summary lives in the tooltip; the glyph is a
         *  comparison aid, the tooltip is the source of truth. */
        function tooltipFor(item, cfg, norm) {
            var q = item.q;
            var opts = PVX.config.numberOpts(cfg);
            var f = function (v) { return PVX.fmt.number(v, opts); };
            var u = item.units ? ' ' + item.units : '';
            var lines = [item.label];

            lines.push('n = ' + item.n + (item.sparse ? '  (too few for quartiles)' : ''));
            lines.push('min ' + f(q.min) + u + '   Q1 ' + f(q.q1) + u);
            lines.push('median ' + f(q.median) + u);
            lines.push('Q3 ' + f(q.q3) + u + '   max ' + f(q.max) + u);
            lines.push('mean ' + f(q.mean) + u + '   σ ' + f(q.sd) + u);

            if (norm) {
                lines.push('scaled 0-100% of ' + f(q.min) + ' to ' + f(q.max) + u);
            }
            if (item.outlierTotal > item.outlierShown) {
                lines.push(item.outlierShown + ' of ' + item.outlierTotal + ' outliers drawn');
            } else if (item.outlierTotal) {
                lines.push(item.outlierTotal + ' outlier' + (item.outlierTotal === 1 ? '' : 's'));
            }
            if (!item.good) {
                lines.push('BAD QUALITY' + (item.error ? ': ' + item.error : ''));
            }
            if (item.path) { lines.push(item.path); }
            return lines.join('\n');
        }

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);

            // Centre-anchored text spills past BOTH edges once it is wider than
            // the frame, so shrink to fit first and only then truncate. 0.62em
            // rather than the 0.58em used for tick labels: this copy is sentence
            // case with wide glyphs.
            var avail = Math.max(24, W - 12);
            var longest = Math.max(String(headline).length, String(detail).length);
            if (longest * font * 0.62 > avail) {
                font = PVX.util.clamp(Math.floor(avail / (longest * 0.62)), 7, font);
            }
            var fitLine = function (str, px) {
                var maxChars = Math.max(3, Math.floor(avail / (px * 0.62)));
                return str.length > maxChars ? str.slice(0, maxChars - 1) + '…' : str;
            };

            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2),
                fitLine(headline, font), {
                    'class': 'pvx-svg-label pvx-box-emptymsg', 'text-anchor': 'middle',
                    'font-size': font, 'font-weight': '600', fill: t.textMuted
                });
            var sub = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.8).toFixed(2),
                fitLine(detail, font * 0.85), {
                    'class': 'pvx-svg-label pvx-box-emptymsg', 'text-anchor': 'middle',
                    'font-size': (font * 0.85).toFixed(1), fill: t.textMuted
                });

            shrinkToFit(head, avail);
            shrinkToFit(sub, avail);
        }

        /**
         * Scale an SVG <text> down until it fits `avail`, then truncate if the
         * 6px floor still is not enough. Shrinking alone is not sufficient: a
         * long sentence in a 140px-wide symbol would need an unreadable font.
         */
        function shrinkToFit(node, avail) {
            if (!node || !node.getComputedTextLength || !(avail > 0)) { return; }
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            var w = measure();
            if (!(w > avail)) { return; }

            var size = parseFloat(node.getAttribute('font-size')) || 10;
            node.setAttribute('font-size', Math.max(6, size * (avail / w)).toFixed(1));

            w = measure();
            if (!(w > avail)) { return; }

            var str = node.textContent;
            var keep = Math.max(3, Math.floor(str.length * (avail / w)) - 1);
            node.textContent = str.slice(0, keep) + '…';
            for (var guard = 0; guard < 24 && measure() > avail && node.textContent.length > 2; guard++) {
                node.textContent = node.textContent.slice(0, -2) + '…';
            }
        }

        /** Theme tokens as CSS custom properties for the Angular-rendered chrome. */
        function applyThemeVars(c, t) {
            var nde = c.node;
            if (!nde || !nde.style || !nde.style.setProperty) { return; }
            nde.style.setProperty('--pvx-text', t.text);
            nde.style.setProperty('--pvx-muted', t.textMuted);
            nde.style.setProperty('--pvx-border', t.border);
            nde.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
        }

        /* Rendering happens in a rAF, i.e. outside Angular's digest, so the
         * scope.pvx writes above need an explicit (guarded) digest. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
