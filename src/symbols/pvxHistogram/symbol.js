/* ============================================================================
 * pvxHistogram — "PVX Distribution" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources; the FIRST is charted by default)
 *
 * A histogram on its own only restates what a trend already showed. What it can
 * do that a trend cannot is answer the process question: is this tag CENTRED
 * between its limits, and is the spread narrow enough to stay there? That needs
 * spec limits, so LSL/USL and the capability panel are the point of this symbol
 * — the bars are the supporting evidence.
 *
 * Everything statistical comes from PVX.stats (histogram / capability /
 * normalPdf / quartiles). This file owns layout and drawing only; duplicating
 * the binning or the capability arithmetic here would let the two drift apart.
 *
 * The one piece of maths that genuinely belongs to the drawing is scaling the
 * fitted normal into the histogram's units: a pdf integrates to 1, so overlaying
 * it raw on a count axis draws a flat line along the bottom. See freqOf() and
 * curvePoints() — the same n * binWidth factor appears in both, deliberately.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Four overlaid distributions is where the outlines stop being separable;
     * beyond that the comparison is lost and we say so in the footer instead. */
    var MAX_OVERLAY = 4;

    /* Samples along the fitted normal. Enough for a smooth curve at 900px and
     * cheap enough that a 90px-wide symbol pays nothing noticeable. */
    var CURVE_SAMPLES = 96;

    /* Mean advance width of the UI font, in ems. Text boxes are sized from this
     * rather than getBBox() because getBBox forces a synchronous layout on every
     * frame, and this symbol redraws on every data update. */
    var CHAR_W = 0.58;

    var definition = {
        typeName: 'pvxHistogram',
        displayName: 'PVX Distribution',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        // Positional config, renumbered when a data source is removed.
        sourceRemap: { SeriesIndex: 'index' },
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Distribution',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                // A distribution needs samples, not a sketch: 500 intervals is
                // the smallest count that gives stable bins over a shift.
                Intervals: 500,
                Height: 260,
                Width: 340,

                // --- which series -------------------------------------------
                SeriesIndex: 1,             // 1-based, matches the data source list
                Overlay: false,

                // --- binning ------------------------------------------------
                Bins: 'auto',               // 'auto' = Freedman-Diaconis
                BinWidth: '',               // overrides Bins when set
                RangeMin: '',
                RangeMax: '',

                // --- geometry -----------------------------------------------
                Orientation: 'vertical',    // vertical | horizontal
                YAxisMode: 'count',         // count | percent | density

                // --- bars ---------------------------------------------------
                BarColor: '#3b82c4',
                BarOpacity: 0.9,
                BarGap: 0.08,
                ColorBySpec: true,

                // --- fitted normal ------------------------------------------
                ShowNormalCurve: true,
                NormalCurveColor: '#c8452f',

                // --- reference lines ----------------------------------------
                ShowMeanLine: true,
                ShowMedianLine: false,
                ShowSigmaLines: false,

                // --- specification ------------------------------------------
                LSL: '',
                USL: '',
                Target: '',

                // --- capability ---------------------------------------------
                ShowCapability: true,
                CapabilityWarnBelow: 1.33,  // the conventional "capable" floor

                // --- chrome -------------------------------------------------
                ShowStats: true,
                ShowGrid: true,
                TickCount: 5,
                ShowAxisLabels: true,
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Template bindings (header / footer live in HTML, the chart is SVG).
        scope.pvx = {
            title: '',
            stats: '',
            note: '',
            error: '',
            background: ''
        };

        // Normalised payload, refreshed on every data update and reused across
        // resize / config renders.
        var model = { all: [] };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-hist-body',
            onData: function (d) { model.all = PVX.data.series(d); },
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

            // c.width / c.height are the DRAWING host, which is what is left
            // after the header and footer have taken their slice. The
            // responsive decisions below are about how big the operator made
            // the symbol, so they read the root element instead — otherwise a
            // symbol shrinks its own chart, then decides it is big enough to
            // keep the chrome that shrank it.
            var W = Math.max(40, c.width);
            var H = Math.max(40, c.height);
            var boxW0 = (c.node && c.node.clientWidth) || W;
            var boxH0 = (c.node && c.node.clientHeight) || H;

            // The HTML chrome (title, footer) cannot read ctx.theme, so push the
            // two tokens it needs onto the root as custom properties. styles.css
            // carries light-theme fallbacks for the frame before the first paint.
            paintChrome(c.node, t, cfg);

            var svgRoot = host.querySelector('svg.pvx-hist-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-hist-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            /* ---- series selection ---------------------------------------- */
            var all = model.all || [];
            var selIdx = PVX.util.clamp(
                (parseInt(cfg.SeriesIndex, 10) || 1) - 1, 0, Math.max(0, all.length - 1));
            var sel = all.length ? all[selIdx] : null;

            scope.pvx.error = '';
            if (sel && !sel.good) { scope.pvx.error = sel.errorDescription || 'Bad data quality'; }
            // Under ~84px the title band is a quarter of the symbol; the bars
            // say more than the name does at that size.
            scope.pvx.title = (boxH0 < 84) ? '' : (sel
                ? (sel.label + (sel.units && cfg.ShowUnits !== false ? ' (' + sel.units + ')' : ''))
                : 'Distribution');

            var values = seriesValues(sel);

            /* ---- empty / degenerate states -------------------------------- */
            if (!sel || !values.length) {
                scope.pvx.stats = '';
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, 'No data',
                    all.length ? 'The selected data source returned no numeric samples.'
                               : 'Drop an attribute onto the symbol.');
                digest();
                return;
            }
            if (values.length < 2) {
                scope.pvx.stats = '';
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, 'Not enough data',
                    'A distribution needs at least two samples.');
                digest();
                return;
            }

            /* ---- which series are drawn ----------------------------------- */
            // The selected series leads the list so it keeps the configured
            // colour and stays the one the capability panel describes.
            var drawn = [sel];
            var extra = 0;
            if (cfg.Overlay) {
                for (var a = 0; a < all.length; a++) {
                    if (a === selIdx) { continue; }
                    if (!seriesValues(all[a]).length) { continue; }
                    if (drawn.length < MAX_OVERLAY) { drawn.push(all[a]); } else { extra++; }
                }
            }

            /* ---- value-axis extent ---------------------------------------- */
            // Bins are shared across every overlaid series: histograms drawn on
            // different bin edges cannot be compared by eye, which is the only
            // reason to overlay them.
            var cfgMin = PVX.util.num(cfg.RangeMin);
            var cfgMax = PVX.util.num(cfg.RangeMax);
            var ext = extentOf(drawn);
            var histLo = cfgMin === null ? ext.lo : cfgMin;
            var histHi = cfgMax === null ? ext.hi : cfgMax;

            var hists = [];
            var h0 = PVX.stats.histogram(values, {
                bins: cfg.Bins, min: histLo, max: histHi, width: cfg.BinWidth
            });
            hists.push(h0);
            for (var s = 1; s < drawn.length; s++) {
                hists.push(PVX.stats.histogram(seriesValues(drawn[s]), {
                    bins: h0.bins.length, min: h0.min, max: h0.max
                }));
            }

            var binW = h0.width;
            var mode = cfg.YAxisMode || 'count';

            /* ---- specification limits -------------------------------------- */
            var lsl = PVX.util.num(cfg.LSL);
            var usl = PVX.util.num(cfg.USL);
            var target = PVX.util.num(cfg.Target);
            // A limit the process never approaches is exactly the limit an
            // operator most needs to see, so the axis grows to include it —
            // otherwise an LSL of 0 on a tag running at 120 simply vanishes and
            // the setting looks broken.
            var v0 = h0.min, v1 = h0.max;
            var refs = [lsl, usl, target];
            for (var r = 0; r < refs.length; r++) {
                if (refs[r] === null) { continue; }
                if (refs[r] < v0) { v0 = refs[r]; }
                if (refs[r] > v1) { v1 = refs[r]; }
            }
            var vPad = (v1 - v0) * 0.02;
            if (v0 < h0.min) { v0 -= vPad; }
            if (v1 > h0.max) { v1 += vPad; }
            if (!(v1 > v0)) { v1 = v0 + 1; }

            /* ---- statistics ------------------------------------------------ */
            var mean = PVX.stats.mean(values);
            var sd = PVX.stats.stddev(values);
            var quart = PVX.stats.quartiles(values);
            var cap = PVX.stats.capability(values, cfg.LSL, cfg.USL);
            var numOpts = PVX.config.numberOpts(cfg);

            /* ---- frequency-axis extent -------------------------------------- */
            var fMax = 0, hi2, b2;
            for (hi2 = 0; hi2 < hists.length; hi2++) {
                for (b2 = 0; b2 < hists[hi2].bins.length; b2++) {
                    var fv = freqOf(hists[hi2].bins[b2].count, hists[hi2].n, hists[hi2].width, mode);
                    if (fv > fMax) { fMax = fv; }
                }
            }
            // The fitted curve is part of the picture, so it sets the ceiling
            // too — a tall narrow peak must not be sliced off at the top.
            var curveTop = 0;
            var showCurve = cfg.ShowNormalCurve !== false && sd > 0;
            if (showCurve) {
                curveTop = freqOf(0, 0, 0, mode, PVX.stats.normalPdf(mean, mean, sd), values.length, binW);
                if (curveTop > fMax) { fMax = curveTop; }
            }
            if (!(fMax > 0)) { fMax = 1; }
            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12);
            var fDom = PVX.scale.niceDomain(0, fMax, tickCount);
            fDom[0] = 0;                      // frequency axes always start at zero

            var valueTicks = PVX.scale.ticks(v0, v1, tickCount);
            var freqTicks = PVX.scale.ticks(fDom[0], fDom[1], tickCount);

            /* ---- responsive chrome ------------------------------------------ */
            var tickFont = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var titleFont = PVX.util.clamp(tickFont + 1, 9, 13);
            // Below these sizes the chrome costs more than it tells you. Shedding
            // it in this order keeps the bars readable in a mosaic instead of
            // stacking labels on top of each other.
            var showTickLabels = boxW0 >= 140 && boxH0 >= 100;
            var showAxisTitles = cfg.ShowAxisLabels !== false && showTickLabels &&
                                 boxW0 >= 200 && boxH0 >= 140;
            var showPanel = cfg.ShowCapability !== false && !!cap &&
                            boxW0 >= 200 && boxH0 >= 140;
            var vertical = (cfg.Orientation || 'vertical') !== 'horizontal';

            var valueLabel = tickFormatter(valueTicks, '');
            var freqLabel = tickFormatter(freqTicks, mode === 'percent' ? '%' : '');
            var valueTitle = showAxisTitles ? (sel.units || sel.label || '') : '';
            var freqTitle = showAxisTitles
                ? (mode === 'percent' ? 'Percent' : (mode === 'density' ? 'Density' : 'Count'))
                : '';

            // Axis roles swap with the orientation; everything downstream reads
            // "left" / "bottom" so the drawing code is written once.
            var leftTicks = vertical ? freqTicks : valueTicks;
            var leftFmt = vertical ? freqLabel : valueLabel;
            var leftTitle = vertical ? freqTitle : valueTitle;
            var bottomTicks = vertical ? valueTicks : freqTicks;
            var bottomFmt = vertical ? valueLabel : freqLabel;
            var bottomTitle = vertical ? valueTitle : freqTitle;

            /* ---- margins ---------------------------------------------------- */
            var leftLabelW = 0, k;
            if (showTickLabels) {
                for (k = 0; k < leftTicks.length; k++) {
                    leftLabelW = Math.max(leftLabelW, leftFmt(leftTicks[k]).length * tickFont * CHAR_W);
                }
            }
            var lastBottomW = (showTickLabels && bottomTicks.length)
                ? bottomFmt(bottomTicks[bottomTicks.length - 1]).length * tickFont * CHAR_W
                : 0;

            var legendH = (cfg.Overlay && drawn.length > 1 && showTickLabels && W >= 240)
                ? tickFont + 8 : 0;

            var mL = 8 + (leftTitle ? titleFont + 4 : 0) + leftLabelW + (showTickLabels ? 6 : 0);
            var mR = 8 + lastBottomW / 2;
            var mT = 8 + legendH;
            var mB = 6 + (showTickLabels ? tickFont + 6 : 2) + (bottomTitle ? titleFont + 4 : 0);

            mL = Math.min(mL, W * 0.45); mR = Math.min(mR, W * 0.25);
            mT = Math.min(mT, H * 0.35); mB = Math.min(mB, H * 0.45);

            var plot = {
                x: mL, y: mT,
                w: Math.max(10, W - mL - mR),
                h: Math.max(10, H - mT - mB)
            };
            plot.x1 = plot.x + plot.w;
            plot.y1 = plot.y + plot.h;

            /* ---- scales ------------------------------------------------------ */
            // sv maps a data value onto the value axis, sf a frequency onto the
            // frequency axis; both SVG axes that point "up" run backwards.
            var sv, sf;
            if (vertical) {
                sv = PVX.scale.linear(v0, v1, plot.x, plot.x1);
                sf = PVX.scale.linear(fDom[0], fDom[1], plot.y1, plot.y);
            } else {
                sv = PVX.scale.linear(v0, v1, plot.y1, plot.y);
                sf = PVX.scale.linear(fDom[0], fDom[1], plot.x, plot.x1);
            }
            var leftScale = vertical ? sf : sv;
            var bottomScale = vertical ? sv : sf;

            /** Pixel rect covering a value interval across the whole frequency axis. */
            function spanRect(fromVal, toVal) {
                var p = sv(fromVal), q = sv(toVal);
                var lo = Math.min(p, q), hi = Math.max(p, q);
                if (vertical) {
                    return { x: lo, y: plot.y, width: Math.max(0, hi - lo), height: plot.h };
                }
                return { x: plot.x, y: lo, width: plot.w, height: Math.max(0, hi - lo) };
            }

            /** Pixel rect for one bar: value interval x frequency height. */
            function barRect(fromVal, toVal, freq, gapFrac) {
                var p = sv(fromVal), q = sv(toVal);
                var lo = Math.min(p, q), hi = Math.max(p, q);
                var gap = (hi - lo) * gapFrac;
                lo += gap / 2; hi -= gap / 2;
                // A hairline bar still has to be visible: on a 200-bin histogram
                // in a narrow box, or on a zero-variance tag whose single bin is
                // a sliver of the axis, a sub-pixel rect just disappears.
                if (hi - lo < 2) { var mid = (lo + hi) / 2; lo = mid - 1; hi = mid + 1; }
                var f = sf(freq), base = sf(0);
                if (vertical) {
                    return {
                        x: lo, y: Math.min(f, base),
                        width: hi - lo, height: Math.max(0, Math.abs(base - f))
                    };
                }
                return {
                    x: Math.min(f, base), y: lo,
                    width: Math.max(0, Math.abs(base - f)), height: hi - lo
                };
            }

            /* ---- grid + axes -------------------------------------------------- */
            var i;
            if (cfg.ShowGrid !== false) {
                for (i = 0; i < leftTicks.length; i++) {
                    var gy = leftScale(leftTicks[i]);
                    PVX.svg.el('line', {
                        x1: plot.x.toFixed(2), y1: gy.toFixed(2),
                        x2: plot.x1.toFixed(2), y2: gy.toFixed(2),
                        stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-grid-line'
                    }, svgRoot);
                }
                for (i = 0; i < bottomTicks.length; i++) {
                    var gx = bottomScale(bottomTicks[i]);
                    PVX.svg.el('line', {
                        x1: gx.toFixed(2), y1: plot.y.toFixed(2),
                        x2: gx.toFixed(2), y2: plot.y1.toFixed(2),
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
                for (i = 0; i < leftTicks.length; i++) {
                    PVX.svg.text(svgRoot, (plot.x - 5).toFixed(2), leftScale(leftTicks[i]).toFixed(2),
                        leftFmt(leftTicks[i]), {
                            'class': 'pvx-svg-label', 'text-anchor': 'end',
                            'font-size': tickFont, fill: t.textMuted
                        });
                }
                for (i = 0; i < bottomTicks.length; i++) {
                    PVX.svg.text(svgRoot, bottomScale(bottomTicks[i]).toFixed(2),
                        (plot.y1 + 4 + tickFont * 0.6).toFixed(2), bottomFmt(bottomTicks[i]), {
                            'class': 'pvx-svg-label', 'text-anchor': 'middle',
                            'font-size': tickFont, fill: t.textMuted
                        });
                }
            }
            if (bottomTitle) {
                PVX.svg.text(svgRoot, (plot.x + plot.w / 2).toFixed(2), (H - titleFont * 0.5 - 2).toFixed(2),
                    bottomTitle, {
                        'class': 'pvx-svg-label pvx-hist-axis-title', 'text-anchor': 'middle',
                        'font-size': titleFont, fill: t.text
                    });
            }
            if (leftTitle) {
                var ly = plot.y + plot.h / 2;
                var lx = titleFont * 0.8 + 2;
                PVX.svg.text(svgRoot, lx.toFixed(2), ly.toFixed(2), leftTitle, {
                    'class': 'pvx-svg-label pvx-hist-axis-title', 'text-anchor': 'middle',
                    'font-size': titleFont, fill: t.text,
                    transform: 'rotate(-90 ' + lx.toFixed(2) + ' ' + ly.toFixed(2) + ')'
                });
            }

            // Everything data-driven is clipped to the plot rect so a curve that
            // overshoots or a bar at the edge never bleeds onto the axis labels.
            var clipId = host.getAttribute('data-pvx-clip') || PVX.util.uid('histclip');
            host.setAttribute('data-pvx-clip', clipId);
            var defs = PVX.svg.el('defs', null, svgRoot);
            var clip = PVX.svg.el('clipPath', { id: clipId }, defs);
            PVX.svg.el('rect', {
                x: plot.x.toFixed(2), y: plot.y.toFixed(2),
                width: plot.w.toFixed(2), height: plot.h.toFixed(2)
            }, clip);
            var plotG = PVX.svg.el('g', { 'clip-path': 'url(#' + clipId + ')' }, svgRoot);

            /* ---- out-of-spec tint --------------------------------------------- */
            var alarm = PVX.color.status.alarm;
            // The caption often lands on the out-of-spec tint, and #c8452f on a
            // dark red wash is barely legible; lift it toward the foreground.
            var specText = t.dark ? PVX.color.mix(alarm, '#ffffff', 0.35) : alarm;
            if (lsl !== null && lsl > v0) { tintRect(plotG, spanRect(v0, lsl), alarm); }
            if (usl !== null && usl < v1) { tintRect(plotG, spanRect(usl, v1), alarm); }

            /* ---- bars ---------------------------------------------------------- */
            var gapFrac = PVX.util.num(cfg.BarGap);
            gapFrac = gapFrac === null ? 0.08 : PVX.util.clamp(gapFrac, 0, 0.6);
            var barOp = PVX.util.num(cfg.BarOpacity);
            barOp = barOp === null ? 0.9 : PVX.util.clamp(barOp, 0.05, 1);
            var barColor = cfg.BarColor || cfg.AccentColor || '#3b82c4';
            var unitSuffix = sel.units ? ' ' + sel.units : '';

            // Bar geometry is kept so the capability panel can be parked where it
            // covers the least ink (see pickCorner).
            var ink = [];
            var bins = h0.bins;
            for (i = 0; i < bins.length; i++) {
                if (!bins[i].count) { continue; }
                var freq = freqOf(bins[i].count, h0.n, binW, mode);
                var rc = barRect(bins[i].from, bins[i].to, freq, gapFrac);
                ink.push(rc);
                // "Fully outside" only — a bin straddling the limit contains
                // conforming product too, and colouring it red would overstate
                // the loss.
                var outside = cfg.ColorBySpec !== false &&
                    ((lsl !== null && bins[i].to <= lsl) || (usl !== null && bins[i].from >= usl));
                var bar = PVX.svg.el('rect', {
                    x: rc.x.toFixed(2), y: rc.y.toFixed(2),
                    width: rc.width.toFixed(2), height: rc.height.toFixed(2),
                    fill: outside ? alarm : barColor,
                    'fill-opacity': barOp,
                    'class': 'pvx-hist-bar'
                }, plotG);
                var bt = PVX.svg.el('title', null, bar);
                bt.textContent =
                    PVX.fmt.number(bins[i].from, numOpts) + ' – ' +
                    PVX.fmt.number(bins[i].to, numOpts) + unitSuffix + '\n' +
                    bins[i].count + ' of ' + h0.n + ' samples (' +
                    PVX.fmt.percent(bins[i].fraction * 100, 1) + ')';
            }

            /* ---- overlaid distributions ----------------------------------------- */
            // Drawn as outlines rather than more bars: filled bars at four
            // series hide each other, and the selected series has to stay the
            // one you read because the capability panel describes only it.
            var overlayColors = [barColor];
            for (var oi = 1; oi < drawn.length; oi++) {
                var oc = PVX.color.categorical[(oi + 1) % PVX.color.categorical.length];
                overlayColors.push(oc);
                PVX.svg.el('path', {
                    d: outlinePath(hists[oi], mode, sv, sf, vertical),
                    fill: oc,
                    'fill-opacity': 0.12,
                    stroke: oc,
                    'stroke-width': 1.6,
                    'stroke-linejoin': 'round',
                    'class': 'pvx-hist-outline'
                }, plotG);
            }

            /* ---- fitted normal ---------------------------------------------------- */
            if (showCurve) {
                PVX.svg.el('path', {
                    d: PVX.svg.line(curvePoints(mean, sd, values.length, binW, mode,
                                                v0, v1, sv, sf, vertical), false),
                    fill: 'none',
                    stroke: cfg.NormalCurveColor || '#c8452f',
                    'stroke-width': 1.8,
                    'stroke-linecap': 'round',
                    'class': 'pvx-hist-curve'
                }, plotG);
            }

            /* ---- reference lines ---------------------------------------------------- */
            if (cfg.ShowSigmaLines && sd > 0) {
                for (var g = 1; g <= 3; g++) {
                    refLine(plotG, mean - g * sd, t.textMuted, '1 3', 1, 0.55, g + 'σ below mean');
                    refLine(plotG, mean + g * sd, t.textMuted, '1 3', 1, 0.55, g + 'σ above mean');
                }
            }
            // With zero variation the mean, the median and the single bar are all
            // the same vertical line, and drawing the reference on top hides the
            // data it is meant to annotate.
            if (cfg.ShowMeanLine !== false && sd > 0) {
                refLine(plotG, mean, t.text, null, 1.5, 0.8,
                    'Mean ' + PVX.fmt.number(mean, numOpts) + unitSuffix);
                markLabel(plotG, mean, 'x̄', t.text);
            }
            if (cfg.ShowMedianLine && quart && sd > 0) {
                refLine(plotG, quart.median, t.text, '4 3', 1.3, 0.65,
                    'Median ' + PVX.fmt.number(quart.median, numOpts) + unitSuffix);
                markLabel(plotG, quart.median, 'M', t.text);
            }
            if (target !== null) {
                refLine(plotG, target, PVX.color.status.normal, '6 3', 1.5, 0.9,
                    'Target ' + PVX.fmt.number(target, numOpts) + unitSuffix);
            }

            /* ---- capability panel ------------------------------------------------------ */
            // Laid out before the spec limits are drawn (so their captions can
            // dodge it) but painted after them, so it stays on top of the bars.
            var panel = showPanel ? layoutCapability(cap, ink) : null;

            /* ---- spec limits ---------------------------------------------------------- */
            if (lsl !== null) { specLine(plotG, lsl, 'LSL', true, panel); }
            if (usl !== null) { specLine(plotG, usl, 'USL', false, panel); }

            if (panel) { paintCapability(svgRoot, panel); }

            /* ---- overlay legend --------------------------------------------------------- */
            if (legendH > 0) { drawLegend(svgRoot, drawn, overlayColors); }

            /* ---- footer ------------------------------------------------------------------ */
            var statBits = [];
            // The footer costs a fixed ~17px whatever the symbol size, so under
            // ~150px tall it is taking a fifth of the chart to repeat numbers
            // the bars already show.
            if (cfg.ShowStats !== false && boxH0 >= 150) {
                statBits.push('n ' + PVX.fmt.group(String(values.length)));
                statBits.push('x̄ ' + PVX.fmt.number(mean, numOpts));
                statBits.push('σ ' + (sd > 0 ? PVX.fmt.number(sd, numOpts) : '0'));
                statBits.push('min ' + PVX.fmt.number(quart.min, numOpts));
                statBits.push('max ' + PVX.fmt.number(quart.max, numOpts) + unitSuffix);
            }
            scope.pvx.stats = statBits.join(' · ');

            var notes = [];
            if (boxH0 >= 150) {
                notes.push(h0.bins.length + (h0.bins.length === 1 ? ' bin' : ' bins'));
                if (extra) { notes.push(extra + ' more series not shown'); }
                if (cap && cap.degenerate) { notes.push('no variation'); }
            }
            scope.pvx.note = notes.join(' · ');

            digest();

            /* ================================================================== *
             * drawing helpers — closed over plot / scales / theme for this frame
             * ================================================================== */

            function tintRect(parent, rc, col) {
                PVX.svg.el('rect', {
                    x: rc.x.toFixed(2), y: rc.y.toFixed(2),
                    width: rc.width.toFixed(2), height: rc.height.toFixed(2),
                    fill: col, 'fill-opacity': t.dark ? 0.14 : 0.08,
                    'class': 'pvx-hist-oos'
                }, parent);
            }

            /** A line perpendicular to the value axis at `val`. */
            function refLine(parent, val, col, dash, width, opacity, tip) {
                if (!PVX.util.isNum(val) || val < v0 || val > v1) { return; }
                var p = sv(val);
                var attrs = vertical
                    ? { x1: p.toFixed(2), y1: plot.y.toFixed(2), x2: p.toFixed(2), y2: plot.y1.toFixed(2) }
                    : { x1: plot.x.toFixed(2), y1: p.toFixed(2), x2: plot.x1.toFixed(2), y2: p.toFixed(2) };
                attrs.stroke = col;
                attrs['stroke-width'] = width;
                attrs['stroke-opacity'] = opacity;
                if (dash) { attrs['stroke-dasharray'] = dash; }
                attrs['class'] = 'pvx-hist-ref';
                var ln = PVX.svg.el('line', attrs, parent);
                if (tip) { PVX.svg.el('title', null, ln).textContent = tip; }
            }

            /** Tiny caption for the mean / median markers, kept away from the
             *  spec labels by living at the far end of the plot. */
            function markLabel(parent, val, txt, col) {
                if (!showTickLabels || !PVX.util.isNum(val) || val < v0 || val > v1) { return; }
                var p = sv(val);
                if (vertical) {
                    PVX.svg.text(parent, (p + 2).toFixed(2), (plot.y1 - tickFont * 0.6).toFixed(2), txt, {
                        'class': 'pvx-svg-label', 'text-anchor': 'start',
                        'font-size': tickFont * 0.9, fill: col, opacity: '0.75'
                    });
                } else {
                    PVX.svg.text(parent, (plot.x + 3).toFixed(2), (p - tickFont * 0.6).toFixed(2), txt, {
                        'class': 'pvx-svg-label', 'text-anchor': 'start',
                        'font-size': tickFont * 0.9, fill: col, opacity: '0.75'
                    });
                }
            }

            /** Dashed spec limit plus its LSL / USL caption, drawn on the
             *  conforming side of the line so it never sits off the plot. */
            function specLine(parent, val, txt, isLower, panelBox) {
                var p = sv(val);
                var attrs = vertical
                    ? { x1: p.toFixed(2), y1: plot.y.toFixed(2), x2: p.toFixed(2), y2: plot.y1.toFixed(2) }
                    : { x1: plot.x.toFixed(2), y1: p.toFixed(2), x2: plot.x1.toFixed(2), y2: p.toFixed(2) };
                attrs.stroke = alarm;
                attrs['stroke-width'] = 1.8;
                attrs['stroke-dasharray'] = '6 4';
                attrs['class'] = 'pvx-hist-spec';
                var ln = PVX.svg.el('line', attrs, parent);
                PVX.svg.el('title', null, ln).textContent =
                    (isLower ? 'LSL ' : 'USL ') + PVX.fmt.number(val, numOpts) + unitSuffix;
                if (!showTickLabels) { return; }

                // Captions sit at the head of the line by default. If the
                // capability card has claimed that corner, flip to the far end
                // rather than printing "USL" underneath an opaque box.
                var capW = txt.length * tickFont * CHAR_W;
                var lx, ly, anchor;
                if (vertical) {
                    lx = p + (isLower ? 3 : -3);
                    ly = plot.y + tickFont * 0.8;
                    anchor = isLower ? 'start' : 'end';
                    if (hits(panelBox, isLower ? lx : lx - capW, ly - tickFont * 0.7, capW, tickFont)) {
                        // Swapping sides usually clears the card; only if that
                        // fails does the caption drop to the foot of the line,
                        // which is further from the limit it names.
                        var altX = p + (isLower ? -3 : 3);
                        var altAnchor = isLower ? 'end' : 'start';
                        if (!hits(panelBox, isLower ? altX - capW : altX,
                                  ly - tickFont * 0.7, capW, tickFont)) {
                            lx = altX; anchor = altAnchor;
                        } else {
                            ly = plot.y1 - tickFont * 0.7;
                        }
                    }
                } else {
                    lx = plot.x1 - 3;
                    ly = p + (isLower ? tickFont * 0.8 : -tickFont * 0.8);
                    anchor = 'end';
                    if (hits(panelBox, lx - capW, ly - tickFont * 0.7, capW, tickFont)) {
                        lx = plot.x + 3 + capW;
                    }
                }
                PVX.svg.text(parent, lx.toFixed(2), ly.toFixed(2), txt, {
                    'class': 'pvx-svg-label pvx-hist-spec-label', 'text-anchor': anchor,
                    'font-size': tickFont, fill: specText
                });
            }

            /** Rect intersection against the (optional) capability card. */
            function hits(box, x, y, w2, h3) {
                if (!box) { return false; }
                return !(x + w2 < box.x || x > box.x + box.w ||
                         y + h3 < box.y || y > box.y + box.h);
            }

            /** Corner of the plot covered by the least bar area. */
            function pickCorner(boxW, boxH, rects) {
                var pad = 4;
                var cands = [
                    { x: plot.x + pad, y: plot.y + pad },
                    { x: plot.x1 - boxW - pad, y: plot.y + pad },
                    { x: plot.x + pad, y: plot.y1 - boxH - pad },
                    { x: plot.x1 - boxW - pad, y: plot.y1 - boxH - pad }
                ];
                var best = 0, bestScore = Infinity;
                for (var ci = 0; ci < cands.length; ci++) {
                    var score = 0;
                    for (var ri = 0; ri < rects.length; ri++) {
                        var ox = Math.max(0, Math.min(cands[ci].x + boxW, rects[ri].x + rects[ri].width) -
                                              Math.max(cands[ci].x, rects[ri].x));
                        var oy = Math.max(0, Math.min(cands[ci].y + boxH, rects[ri].y + rects[ri].height) -
                                              Math.max(cands[ci].y, rects[ri].y));
                        score += ox * oy;
                    }
                    if (score < bestScore) { bestScore = score; best = ci; }
                }
                return cands[best];
            }

            /** Size and place the Cp / Cpk card. Returns null when there is no
             *  honest room for it — a card that blankets the bars answers the
             *  capability question while hiding the evidence for it. */
            function layoutCapability(capIn, rects) {
                var warnBelow = PVX.util.num(cfg.CapabilityWarnBelow);
                if (warnBelow === null) { warnBelow = 1.33; }

                var rows = [];
                if (capIn.degenerate) {
                    // sigma is exactly zero: every index divides by it. Saying
                    // "no variation" is honest; printing Infinity is not.
                    rows.push({ l: 'Cpk', v: 'no variation', c: t.textMuted });
                    rows.push({ l: 'Mean', v: PVX.fmt.number(capIn.mean, numOpts), c: t.text });
                    rows.push({ l: 'n', v: PVX.fmt.group(String(capIn.n)), c: t.text });
                } else {
                    var cpkColor = capIn.cpk < 1
                        ? PVX.color.status.alarm
                        : (capIn.cpk < warnBelow ? PVX.color.status.warning : PVX.color.status.normal);
                    // Cp needs both limits; one-sided specs legitimately have none.
                    rows.push({ l: 'Cp', v: PVX.util.isNum(capIn.cp) ? capIn.cp.toFixed(2) : '—', c: t.text });
                    rows.push({ l: 'Cpk', v: capIn.cpk.toFixed(2), c: cpkColor, bold: true });
                    rows.push({ l: 'Mean', v: PVX.fmt.number(capIn.mean, numOpts), c: t.text });
                    rows.push({ l: 'σ', v: PVX.fmt.number(capIn.sd, numOpts), c: t.text });
                    rows.push({ l: 'n', v: PVX.fmt.group(String(capIn.n)), c: t.text });
                    rows.push({
                        l: 'Out', v: PVX.fmt.percent(capIn.percentOut, capIn.percentOut < 1 ? 2 : 1),
                        c: capIn.percentOut > 0 ? PVX.color.status.alarm : t.text
                    });
                    rows.push({
                        l: 'PPM', v: PVX.fmt.compact(Math.round(capIn.ppmExpected), 1), c: t.text
                    });
                }

                var padX = 6, padY = 4;
                var lineH = tickFont * 1.45;
                var titleH = tickFont * 1.5;

                // Shed rows from the bottom rather than overflow the plot: the
                // top two (Cp, Cpk) are the reason the panel exists. Half the
                // plot height is the most the card may claim.
                var maxRows = Math.max(2, Math.floor((plot.h * 0.5 - titleH - padY * 2) / lineH));
                if (rows.length > maxRows) { rows = rows.slice(0, maxRows); }

                var labelW = 0, valueW = 0, ri;
                for (ri = 0; ri < rows.length; ri++) {
                    labelW = Math.max(labelW, rows[ri].l.length);
                    valueW = Math.max(valueW, rows[ri].v.length);
                }
                var boxW = padX * 2 + (labelW + valueW + 2) * tickFont * CHAR_W;
                var titleW = ('Capability'.length + 1) * tickFont * CHAR_W + padX * 2;
                var showCardTitle = titleW <= Math.min(plot.w * 0.5, boxW * 1.35);
                if (showCardTitle) { boxW = Math.max(boxW, titleW); }
                var boxH = padY * 2 + (showCardTitle ? titleH : 0) + rows.length * lineH;
                // Even trimmed to two rows the card can be too big for the box;
                // no card at all beats a card with no chart behind it.
                if (boxW > plot.w * 0.55 || boxH > plot.h * 0.62) { return null; }

                var at = pickCorner(boxW, boxH, rects);
                return {
                    x: at.x, y: at.y, w: boxW, h: boxH,
                    rows: rows, padX: padX, padY: padY,
                    lineH: lineH, titleH: showCardTitle ? titleH : 0,
                    warnBelow: warnBelow
                };
            }

            /** Paint the card laid out above. Cpk is the number that decides
             *  whether anyone acts, so it is the only value that carries colour. */
            function paintCapability(parent, p2) {
                var g2 = PVX.svg.el('g', { 'class': 'pvx-hist-cap' }, parent);
                PVX.svg.el('title', null, g2).textContent =
                    'Cp / Cpk from the overall sample standard deviation. A PI time series has ' +
                    'no rational subgroups, so within-subgroup sigma is unavailable and these ' +
                    'equal Pp / Ppk. Cpk below ' + p2.warnBelow + ' is marginal, below 1.00 the ' +
                    'process is producing out-of-spec material.';

                // Transparent symbols have no surface to borrow; fall back to a
                // scrim that keeps the numbers legible over the bars.
                var fill = (t.surface && t.surface !== 'transparent')
                    ? PVX.color.rgba(t.surface, 0.9)
                    : (t.dark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.82)');

                PVX.svg.el('path', {
                    d: PVX.svg.roundRect(p2.x, p2.y, p2.w, p2.h, 3),
                    fill: fill, stroke: t.border, 'stroke-width': 1
                }, g2);

                if (p2.titleH) {
                    PVX.svg.text(g2, (p2.x + p2.padX).toFixed(2),
                        (p2.y + p2.padY + p2.titleH * 0.5).toFixed(2), 'Capability', {
                            'class': 'pvx-svg-label', 'font-size': tickFont * 0.92,
                            'font-weight': '700', fill: t.textMuted
                        });
                }

                for (var ri = 0; ri < p2.rows.length; ri++) {
                    var ry = p2.y + p2.padY + p2.titleH + p2.lineH * (ri + 0.5);
                    PVX.svg.text(g2, (p2.x + p2.padX).toFixed(2), ry.toFixed(2), p2.rows[ri].l, {
                        'class': 'pvx-svg-label', 'font-size': tickFont, fill: t.textMuted
                    });
                    PVX.svg.text(g2, (p2.x + p2.w - p2.padX).toFixed(2), ry.toFixed(2), p2.rows[ri].v, {
                        'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end',
                        'font-size': tickFont, fill: p2.rows[ri].c,
                        'font-weight': p2.rows[ri].bold ? '700' : '600'
                    });
                }
            }

            /** One-line key for Overlay mode, in the strip reserved above the plot. */
            function drawLegend(parent, series, colors) {
                var n = series.length;
                var share = plot.w / n;
                var y = plot.y - legendH / 2 - 2;
                for (var li = 0; li < n; li++) {
                    var x = plot.x + share * li;
                    PVX.svg.el('rect', {
                        x: x.toFixed(2), y: (y - tickFont * 0.35).toFixed(2),
                        width: 8, height: (tickFont * 0.7).toFixed(2),
                        fill: colors[li], rx: 1, 'class': 'pvx-hist-key'
                    }, parent);
                    var room = Math.max(3, Math.floor((share - 14) / (tickFont * CHAR_W)));
                    var lab = series[li].label || ('Series ' + (li + 1));
                    if (lab.length > room) { lab = lab.slice(0, Math.max(1, room - 1)) + '…'; }
                    PVX.svg.text(parent, (x + 11).toFixed(2), y.toFixed(2), lab, {
                        'class': 'pvx-svg-label', 'font-size': tickFont * 0.92,
                        fill: t.textMuted
                    });
                }
            }

            function emptyState(root2, w2, h2, th, headline, detail) {
                var f = PVX.util.clamp(Math.round(Math.min(w2, h2) / 16), 9, 13);
                PVX.svg.text(root2, (w2 / 2).toFixed(2), (h2 / 2 - f * 0.7).toFixed(2), headline, {
                    'class': 'pvx-svg-label', 'text-anchor': 'middle',
                    'font-size': f, 'font-weight': '600', fill: th.textMuted
                });
                PVX.svg.text(root2, (w2 / 2).toFixed(2), (h2 / 2 + f * 0.7).toFixed(2), detail, {
                    'class': 'pvx-svg-label', 'text-anchor': 'middle',
                    'font-size': f * 0.9, fill: th.textMuted, opacity: '0.8'
                });
            }
        }

        /* ================================================================== *
         * pure helpers
         * ================================================================== */

        /**
         * Tick labels precise enough that two adjacent ticks never print the
         * same string. PVX.fmt.tick rounds to two decimals, which is right for a
         * flow in klb/h and wrong for a density axis stepping by 0.005 — that
         * axis would read "0.03, 0.03, 0.02, 0.02" and look broken. Decimals are
         * taken from the tick step, so the axis stays as terse as it can be.
         */
        function tickFormatter(ticks, suffix) {
            var step = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 0;
            var dec = 0;
            if (step > 0 && step < 1) {
                dec = PVX.util.clamp(Math.ceil(-Math.log(step) / Math.LN10), 0, 6);
            }
            return function (v) {
                var s = dec > 0 ? Number(v).toFixed(dec) : PVX.fmt.tick(v);
                return s + (suffix || '');
            };
        }

        function paintChrome(node, t, cfg) {
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;
            if (!node || !node.style || !node.style.setProperty) { return; }
            node.style.setProperty('--pvx-text', t.text);
            node.style.setProperty('--pvx-muted', t.textMuted);
        }

        function seriesValues(series) {
            var out = [];
            if (!series || !series.points) { return out; }
            for (var i = 0; i < series.points.length; i++) {
                if (PVX.util.isNum(series.points[i].v)) { out.push(series.points[i].v); }
            }
            return out;
        }

        function extentOf(list) {
            var lo = null, hi = null;
            for (var i = 0; i < list.length; i++) {
                var vals = seriesValues(list[i]);
                for (var j = 0; j < vals.length; j++) {
                    if (lo === null || vals[j] < lo) { lo = vals[j]; }
                    if (hi === null || vals[j] > hi) { hi = vals[j]; }
                }
            }
            return { lo: lo === null ? 0 : lo, hi: hi === null ? 1 : hi };
        }

        /**
         * Convert a bin count into the configured frequency unit.
         *
         * Called two ways: with a real bin count, or — when `pdf` is supplied —
         * to convert a probability density into the same unit. That second form
         * is the fix for the classic histogram bug: a pdf integrates to 1, so on
         * a count axis it must be multiplied by n * binWidth (the area of the
         * histogram) and on a percent axis by 100 * binWidth. Skip it and the
         * curve either lies flat on the axis or shoots off the top.
         */
        function freqOf(count, n, width, mode, pdf, pdfN, pdfWidth) {
            if (pdf !== undefined) {
                if (mode === 'density') { return pdf; }
                if (mode === 'percent') { return pdf * 100 * pdfWidth; }
                return pdf * pdfN * pdfWidth;
            }
            if (!n) { return 0; }
            if (mode === 'percent') { return (count / n) * 100; }
            if (mode === 'density') { return width > 0 ? count / (n * width) : 0; }
            return count;
        }

        /** Sampled normal curve as plot-space points. */
        function curvePoints(mu, sd, n, width, mode, v0, v1, sv, sf, vertical) {
            var pts = [];
            var step = (v1 - v0) / (CURVE_SAMPLES - 1);
            for (var i = 0; i < CURVE_SAMPLES; i++) {
                var x = v0 + step * i;
                var y = freqOf(0, 0, 0, mode, PVX.stats.normalPdf(x, mu, sd), n, width);
                pts.push(vertical
                    ? { x: sv(x), y: sf(y) }
                    : { x: sf(y), y: sv(x) });
            }
            return pts;
        }

        /**
         * Stepped outline around a histogram — the silhouette a filled bar chart
         * would have. Closed along the zero line so a translucent fill reads as
         * one shape rather than a comb.
         */
        function outlinePath(hist, mode, sv, sf, vertical) {
            var bins = hist.bins;
            if (!bins.length) { return ''; }
            var pts = [];
            var put = function (val, freq) {
                var p = sv(val), q = sf(freq);
                pts.push(vertical ? { x: p, y: q } : { x: q, y: p });
            };
            put(bins[0].from, 0);
            for (var i = 0; i < bins.length; i++) {
                var f = freqOf(bins[i].count, hist.n, hist.width, mode);
                put(bins[i].from, f);
                put(bins[i].to, f);
            }
            put(bins[bins.length - 1].to, 0);
            var d = 'M' + pts[0].x.toFixed(2) + ' ' + pts[0].y.toFixed(2);
            for (var k = 1; k < pts.length; k++) {
                d += ' L' + pts[k].x.toFixed(2) + ' ' + pts[k].y.toFixed(2);
            }
            return d + ' Z';
        }

        /* Renders run inside requestAnimationFrame, outside Angular's digest,
         * and the header/footer are scope bindings. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
