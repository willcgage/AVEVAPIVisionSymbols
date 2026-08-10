/* ============================================================================
 * pvxSparkline — dense multi-series micro-trend list
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (multiple data sources)
 *
 * One row per tag: [name] [sparkline] [current value]. This is the "20 tags at
 * a glance" view that PI Vision's stock trend cannot do — a stock trend with 20
 * traces is unreadable, and 20 stock trends do not fit on a screen.
 *
 * The entire symbol is drawn as ONE imperative SVG inside `.pvx-spark-body`.
 * A per-row Angular template (ng-repeat with bindings for name/value/colour)
 * would put 30 rows x ~6 watchers into the digest loop of a display that also
 * refreshes every few seconds; on a wall board with several of these symbols
 * that is the difference between a smooth display and a stuttering one. Drawing
 * imperatively also means we never write to scope during render, so this symbol
 * needs no $digest at all.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below this a row cannot carry legible text, so we stop adding rows and
     * tell the user how many were left out instead of silently truncating. */
    var MIN_ROW_H = 14;

    var definition = {
        typeName: 'pvxSparkline',
        displayName: 'PVX Multi Sparkline',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format Multi Sparkline',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 150,
                Height: 220,
                Width: 320,

                // Rows
                RowHeight: 26,
                AutoRowHeight: true,
                ShowRowSeparators: true,
                ShowZebra: false,
                SortBy: 'none',             // none | name | valueAsc | valueDesc

                // Columns
                ShowNames: true,
                NameWidthPct: 30,
                ShowValues: true,
                ValueWidthPct: 22,
                ShowUnits: true,

                // Sparkline
                LineStyle: 'line',          // line | area | bars | stepped
                SmoothLine: false,
                ScaleMode: 'perRow',        // perRow | shared
                ShowMinMax: false,
                ShowEndDot: true,

                // Colour
                ColorMode: 'palette',       // palette | single | threshold
                LineColor: '#3b82c4',
                UseThresholds: true,

                // Chrome
                ShowHeader: false,
                HeaderText: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        var series = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-spark-body',

            onData: function (d) {
                series = PVX.data.series(d) || [];
            },

            render: render
        });

        /* ------------------------------------------------------------------ *
         * text fitting
         * ------------------------------------------------------------------ */

        /**
         * Truncate `str` to what fits in `maxW` px using an average-glyph-width
         * heuristic. getComputedTextLength() is exact, but it flushes pending
         * layout on every call — doing that once per name per render (30 rows x
         * every data update) is the classic layout-thrash stall. 0.55em is a good
         * average for mixed-case Segoe UI; erring narrow only costs a character.
         */
        function maxChars(maxW, fontPx) {
            return Math.floor(maxW / (fontPx * 0.55));
        }

        function fitText(str, maxW, fontPx) {
            var s = String(str === null || str === undefined ? '' : str);
            var m = maxChars(maxW, fontPx);
            if (m < 1) { return ''; }
            if (s.length <= m) { return s; }
            if (m === 1) { return '…'; }
            return s.slice(0, m - 1) + '…';
        }

        /**
         * Fit "1234.5 degC" into the value column, shedding the least important
         * part first. A truncated unit ("75.9 d…") is worse than no unit at all,
         * so the units are dropped before the number is ever cut.
         */
        function fitValue(value, units, maxW, fontPx) {
            var m = maxChars(maxW, fontPx);
            if (units && (value + units).length <= m) { return value + units; }
            return fitText(value, maxW, fontPx);
        }

        /* ------------------------------------------------------------------ *
         * data preparation
         * ------------------------------------------------------------------ */

        /**
         * Bucket decimation down to roughly one sample per available pixel.
         *
         * A sparkline column is typically 100-200px wide but the query returns
         * up to `Intervals` points per tag. Plain stride sampling would drop the
         * spikes — exactly the events an operator is scanning for.
         *
         * `envelope` true (lines/areas): each bucket contributes its minimum AND
         * maximum in time order, so the trace keeps its true vertical extent.
         * `envelope` false (bars): one bar per bucket, the bucket's maximum —
         * emitting two points per bucket would stack overlapping sub-pixel bars
         * into a solid smear.
         */
        function decimate(points, buckets, envelope) {
            var n = points.length;
            var perBucket = envelope ? 2 : 1;
            if (buckets < 2 || n <= buckets * perBucket) { return points; }
            var out = [];
            var push = function (p) {
                if (out[out.length - 1] !== p) { out.push(p); }
            };
            var size = n / buckets;
            if (envelope) { push(points[0]); }   // anchor the trace to the left edge
            for (var b = 0; b < buckets; b++) {
                var s = Math.floor(b * size);
                var e = Math.min(n, Math.floor((b + 1) * size));
                if (e <= s) { continue; }
                var lo = s, hi = s;
                for (var i = s + 1; i < e; i++) {
                    if (points[i].v < points[lo].v) { lo = i; }
                    if (points[i].v > points[hi].v) { hi = i; }
                }
                if (!envelope) { push(points[hi]); continue; }
                var a = Math.min(lo, hi), z = Math.max(lo, hi);
                push(points[a]);
                if (z !== a) { push(points[z]); }
            }
            push(points[n - 1]);   // the newest sample drives the value column
            return out;
        }

        function sortRows(list, mode) {
            if (mode === 'name') {
                list.sort(function (a, b) {
                    return String(a.series.label).toLowerCase() < String(b.series.label).toLowerCase() ? -1 : 1;
                });
            } else if (mode === 'valueAsc' || mode === 'valueDesc') {
                var dir = mode === 'valueAsc' ? 1 : -1;
                list.sort(function (a, b) {
                    // Rows with no current value always sink to the bottom; they
                    // carry no ranking information either way.
                    if (a.last === null && b.last === null) { return 0; }
                    if (a.last === null) { return 1; }
                    if (b.last === null) { return -1; }
                    return (a.last - b.last) * dir;
                });
            }
            return list;
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

            var W = Math.max(40, host.clientWidth || c.width || 40);
            var H = Math.max(20, host.clientHeight || c.height || 20);

            var svgRoot = host.querySelector('svg.pvx-spark-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-spark-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            // Rows must keep their true pixel height, so no aspect-ratio fitting.
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            if (!series.length) {
                PVX.svg.text(svgRoot, (W / 2).toFixed(1), (H / 2).toFixed(1),
                    'No data sources configured', {
                        'class': 'pvx-svg-label',
                        'text-anchor': 'middle',
                        'font-size': '11',
                        fill: t.textMuted
                    });
                return;
            }

            // ---- prepare rows ------------------------------------------------
            var padX = 8;
            var contentW = Math.max(20, W - padX * 2);
            var gap = 6;

            var nameW = cfg.ShowNames ? contentW * (PVX.util.clamp(PVX.util.num(cfg.NameWidthPct) || 0, 0, 60) / 100) : 0;
            var valueW = cfg.ShowValues ? contentW * (PVX.util.clamp(PVX.util.num(cfg.ValueWidthPct) || 0, 0, 50) / 100) : 0;
            var gaps = (nameW > 0 ? gap : 0) + (valueW > 0 ? gap : 0);

            // The sparkline is the whole point of the symbol; if the label and
            // value columns would squeeze it below a quarter of the width, shrink
            // them proportionally rather than letting the trend disappear.
            var minSpark = contentW * 0.25;
            if (contentW - gaps - nameW - valueW < minSpark && (nameW + valueW) > 0) {
                var room = Math.max(0, contentW - gaps - minSpark);
                var shrink = room / (nameW + valueW);
                nameW *= shrink;
                valueW *= shrink;
            }
            var sparkX = padX + nameW + (nameW > 0 ? gap : 0);
            var sparkW = Math.max(4, contentW - nameW - valueW - gaps);

            var rowH = rowHeight(cfg, H, series.length);
            var capacity = Math.max(1, Math.floor(H / rowH));

            var overflow = 0;
            var drawCount = series.length;
            if (series.length > capacity) {
                // Spend one row on the "+N more" notice so the count is honest.
                drawCount = Math.max(0, capacity - 1);
                overflow = series.length - drawCount;
            }

            // Bars need elbow room to read as discrete marks; lines can carry one
            // envelope pair per two pixels.
            var isBars = cfg.LineStyle === 'bars';
            var buckets = Math.max(2, Math.floor(sparkW / (isBars ? 4 : 2)));

            var prepared = [];
            for (var i = 0; i < series.length; i++) {
                var s = series[i];
                var pts = decimate(s.points || [], buckets, !isBars);
                var st = PVX.data.stats(pts);
                prepared.push({ series: s, pts: pts, stats: st, last: st.last });
            }
            sortRows(prepared, cfg.SortBy);
            prepared = prepared.slice(0, drawCount);

            // ---- scales --------------------------------------------------------
            // The X domain is always shared: every row covers the same display
            // time range, and rows would be misleading to compare side by side if
            // each had its own time axis. Only Y is configurable.
            var tMin = null, tMax = null, sharedLo = null, sharedHi = null;
            for (var j = 0; j < prepared.length; j++) {
                var p = prepared[j];
                if (p.pts.length) {
                    if (tMin === null || p.pts[0].t < tMin) { tMin = p.pts[0].t; }
                    if (tMax === null || p.pts[p.pts.length - 1].t > tMax) { tMax = p.pts[p.pts.length - 1].t; }
                }
                if (p.stats.count) {
                    if (sharedLo === null || p.stats.min < sharedLo) { sharedLo = p.stats.min; }
                    if (sharedHi === null || p.stats.max > sharedHi) { sharedHi = p.stats.max; }
                }
            }
            if (tMin === null) { tMin = 0; tMax = 1; }
            if (tMax === tMin) { tMax = tMin + 1; }
            var xScale = PVX.scale.linear(tMin, tMax, sparkX, sparkX + sparkW);

            // Reserve a quality gutter for every row when ANY row is bad, so the
            // names stay left-aligned instead of jumping in and out.
            var anyBad = false;
            for (var q = 0; q < prepared.length; q++) {
                if (!prepared[q].series.good) { anyBad = true; break; }
            }
            var badGutter = anyBad ? 9 : 0;

            var nameFont = PVX.util.clamp(rowH * 0.46, 8, 13);
            var valueFont = PVX.util.clamp(rowH * 0.50, 8.5, 14);
            var numOpts = PVX.config.numberOpts(cfg);
            var zebraFill = t.dark ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.035)';

            // ---- rows ------------------------------------------------------------
            for (var r = 0; r < prepared.length; r++) {
                drawRow(svgRoot, prepared[r], r, {
                    W: W, y: r * rowH, rowH: rowH, padX: padX,
                    nameW: nameW, valueW: valueW, sparkX: sparkX, sparkW: sparkW,
                    badGutter: badGutter, nameFont: nameFont, valueFont: valueFont,
                    xScale: xScale, sharedLo: sharedLo, sharedHi: sharedHi,
                    zebraFill: zebraFill, numOpts: numOpts,
                    cfg: cfg, theme: t
                });
            }

            // ---- overflow notice --------------------------------------------------
            if (overflow > 0) {
                var fy = drawCount * rowH + Math.min(rowH, H - drawCount * rowH) / 2;
                PVX.svg.text(svgRoot, padX, fy.toFixed(1),
                    '+' + overflow + ' more', {
                        'class': 'pvx-spark-more',
                        'font-size': PVX.util.clamp(rowH * 0.42, 8, 11).toFixed(1),
                        fill: t.textMuted
                    });
            }
        }

        /** Resolve the row height, honouring the auto/fixed switch. */
        function rowHeight(cfg, H, count) {
            var fixed = PVX.util.num(cfg.RowHeight);
            var auto = cfg.AutoRowHeight !== false || !fixed || cfg.RowHeight === 'auto';
            var h = auto ? (H / Math.max(1, count)) : fixed;
            // Never go below the legibility floor — overflow handling takes over.
            return Math.max(MIN_ROW_H, h);
        }

        /** Colour for one row, from the configured colour mode. */
        function rowColor(cfg, row, index, theme) {
            if (cfg.ColorMode === 'single') {
                return cfg.LineColor || cfg.AccentColor || '#3b82c4';
            }
            if (cfg.ColorMode === 'threshold') {
                // Bands are evaluated against the row's CURRENT value, matching
                // what the value column shows, so colour and number never disagree.
                if (cfg.UseThresholds === false || row.last === null) {
                    return cfg.LineColor || '#3b82c4';
                }
                return PVX.thresholds.colorFor(cfg.Thresholds, row.last, cfg.LineColor || '#3b82c4');
            }
            var pal = theme.categorical || PVX.color.categorical;
            return pal[index % pal.length];
        }

        function drawRow(svgRoot, row, index, L) {
            var cfg = L.cfg;
            var t = L.theme;
            var s = row.series;
            var color = rowColor(cfg, row, index, t);

            var g = PVX.svg.el('g', { 'class': 'pvx-spark-row' }, svgRoot);
            // Bad quality dims the whole row rather than recolouring it: the
            // thresholds/palette colour still carries meaning, it just should not
            // command attention while the value is untrustworthy.
            if (!s.good) { g.setAttribute('opacity', '0.55'); }

            if (cfg.ShowZebra && (index % 2 === 1)) {
                PVX.svg.el('rect', {
                    x: 0, y: L.y.toFixed(1), width: L.W, height: L.rowH.toFixed(1),
                    fill: L.zebraFill
                }, g);
            }

            // Hit target goes in early so painted content sits above it; SVG text
            // only receives pointer events over its glyphs, so the name keeps its
            // own full-path tooltip while the rest of the row shows the summary.
            var valueText = row.last === null ? '--' : PVX.fmt.number(row.last, L.numOpts);
            var unitText = (cfg.ShowUnits && s.units) ? ' ' + s.units : '';
            var hit = PVX.svg.el('rect', {
                x: 0, y: L.y.toFixed(1), width: L.W, height: L.rowH.toFixed(1),
                'class': 'pvx-hit'
            }, g);
            var hitTitle = PVX.svg.el('title', null, hit);
            hitTitle.textContent = (s.label || '') + ': ' + valueText + unitText +
                (s.good ? '' : ' (' + (s.errorDescription || 'bad quality') + ')');

            var midY = L.y + L.rowH / 2;

            // ---- name column ---------------------------------------------------
            if (cfg.ShowNames && L.nameW > 2) {
                if (!s.good) {
                    PVX.svg.el('circle', {
                        cx: (L.padX + 3).toFixed(1), cy: midY.toFixed(1), r: 2.6,
                        fill: PVX.color.status.alarm,
                        'class': 'pvx-spark-bad'
                    }, g);
                }
                var nameX = L.padX + L.badGutter;
                var nameAvail = L.nameW - L.badGutter;
                var nameNode = PVX.svg.text(g, nameX.toFixed(1), midY.toFixed(1),
                    fitText(s.label, nameAvail, L.nameFont), {
                        'class': 'pvx-spark-name',
                        'font-size': L.nameFont.toFixed(1),
                        fill: t.text
                    });
                // Full path on hover — the truncated name is rarely enough to tell
                // two attributes of two assets apart.
                var nameTitle = PVX.svg.el('title', null, nameNode);
                nameTitle.textContent = s.path ? (s.label + '\n' + s.path) : (s.label || '');
            }

            // ---- sparkline ------------------------------------------------------
            drawSpark(g, row, color, L, midY);

            // ---- value column ----------------------------------------------------
            if (cfg.ShowValues && L.valueW > 2) {
                var valColor = (cfg.ColorMode === 'threshold') ? color : t.text;
                PVX.svg.text(g, (L.W - L.padX).toFixed(1), midY.toFixed(1),
                    fitValue(valueText, unitText, L.valueW, L.valueFont), {
                        'class': 'pvx-spark-value pvx-num',
                        'text-anchor': 'end',
                        'font-size': L.valueFont.toFixed(1),
                        fill: valColor
                    });
            }

            // ---- separator --------------------------------------------------------
            if (cfg.ShowRowSeparators) {
                var sy = (L.y + L.rowH).toFixed(1);
                PVX.svg.el('line', {
                    x1: L.padX, y1: sy, x2: (L.W - L.padX), y2: sy,
                    stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-grid-line'
                }, g);
            }
        }

        function drawSpark(g, row, color, L, midY) {
            var cfg = L.cfg;
            var t = L.theme;
            var pts = row.pts;

            // Keep the trace clear of the separators above and below.
            var padY = PVX.util.clamp(L.rowH * 0.18, 2, 6);
            var top = L.y + padY;
            var bottom = L.y + L.rowH - padY;

            if (pts.length < 2) {
                // One point (or none) cannot form a trend. A dashed mid-line says
                // "there is a row here, but no shape to show" without implying a
                // flat process — a solid line would look like real data.
                PVX.svg.el('line', {
                    x1: L.sparkX.toFixed(1), y1: midY.toFixed(1),
                    x2: (L.sparkX + L.sparkW).toFixed(1), y2: midY.toFixed(1),
                    stroke: PVX.color.rgba(t.textMuted, 0.7),
                    'stroke-width': 1,
                    'stroke-dasharray': '3 3',
                    'class': 'pvx-spark-flat'
                }, g);
                return;
            }

            var lo, hi;
            if (cfg.ScaleMode === 'shared' && L.sharedLo !== null) {
                lo = L.sharedLo; hi = L.sharedHi;
            } else {
                lo = row.stats.min; hi = row.stats.max;
            }
            if (lo === null || hi === null) { return; }
            if (hi === lo) {
                // A dead-flat trace still deserves a visible line through the
                // middle of the band rather than a degenerate scale.
                var padFlat = Math.abs(hi) * 0.05 || 0.5;
                lo -= padFlat; hi += padFlat;
            }
            var y = PVX.scale.linear(lo, hi, bottom, top);

            var xy = [];
            for (var i = 0; i < pts.length; i++) {
                xy.push({ x: L.xScale(pts[i].t), y: PVX.util.clamp(y(pts[i].v), top, bottom) });
            }

            var style = cfg.LineStyle || 'line';
            var smooth = !!cfg.SmoothLine && style !== 'stepped';

            if (style === 'bars') {
                var bw = Math.max(0.8, (L.sparkW / xy.length) * 0.7);
                for (var b = 0; b < xy.length; b++) {
                    PVX.svg.el('rect', {
                        x: (xy[b].x - bw / 2).toFixed(2),
                        y: xy[b].y.toFixed(2),
                        width: bw.toFixed(2),
                        height: Math.max(0.8, bottom - xy[b].y).toFixed(2),
                        fill: color,
                        opacity: 0.85
                    }, g);
                }
            } else {
                if (style === 'area') {
                    // Flat translucent fill, not a gradient: one <linearGradient> per
                    // row would mean 30 extra defs nodes rebuilt on every update for
                    // an effect only a few pixels tall.
                    PVX.svg.el('path', {
                        d: PVX.svg.area(xy, bottom, smooth),
                        fill: PVX.color.rgba(color, 0.22),
                        stroke: 'none'
                    }, g);
                }
                PVX.svg.el('path', {
                    d: style === 'stepped' ? PVX.svg.stepLine(xy) : PVX.svg.line(xy, smooth),
                    fill: 'none',
                    stroke: color,
                    'stroke-width': 1.4,
                    'stroke-linejoin': 'round',
                    'stroke-linecap': 'round',
                    'vector-effect': 'non-scaling-stroke',
                    'class': 'pvx-spark-line'
                }, g);
            }

            // ---- min / max markers ------------------------------------------------
            if (cfg.ShowMinMax) {
                var loI = 0, hiI = 0;
                for (var k = 1; k < pts.length; k++) {
                    if (pts[k].v < pts[loI].v) { loI = k; }
                    if (pts[k].v > pts[hiI].v) { hiI = k; }
                }
                // Max solid, min hollow — distinguishable at 2px without a legend.
                PVX.svg.el('circle', {
                    cx: xy[hiI].x.toFixed(2), cy: xy[hiI].y.toFixed(2), r: 1.8,
                    fill: color, 'class': 'pvx-spark-max'
                }, g);
                PVX.svg.el('circle', {
                    cx: xy[loI].x.toFixed(2), cy: xy[loI].y.toFixed(2), r: 1.8,
                    fill: PVX.color.rgba(color, 0.35),
                    stroke: color, 'stroke-width': 0.8, 'class': 'pvx-spark-min'
                }, g);
            }

            if (cfg.ShowEndDot) {
                var last = xy[xy.length - 1];
                PVX.svg.el('circle', {
                    // Keep the dot inside the column so it is never half-clipped.
                    cx: Math.min(last.x, L.sparkX + L.sparkW - 2).toFixed(2),
                    cy: last.y.toFixed(2),
                    r: 2,
                    fill: color,
                    'class': 'pvx-spark-end'
                }, g);
            }
        }

        /** Theme tokens as CSS custom properties, consumed by styles.css and the
         *  template's ng-style. Keeps all colour decisions in one place and means
         *  render() never writes to scope (so no $digest is required). */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', c.config.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
