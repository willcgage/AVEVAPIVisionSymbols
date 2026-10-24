/* ============================================================================
 * pvxHeatmap — time-bucketed heatmap for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (multiple data sources)
 *
 * Two ways of folding time into a grid:
 *
 *   calendar — one data source. Rows are the hour of day (0-23), columns are
 *              calendar days, each cell aggregates that hour. Diurnal and
 *              shift patterns that are invisible on a trend jump straight out.
 *
 *   matrix   — many data sources. Rows are tags, columns are equal time slices
 *              across the display range. The "which unit is running hot, and
 *              when" view.
 *
 *   density  — one data source. Columns are equal time slices, rows are bins
 *              of the tag's OWN value, and a cell's colour is the share of
 *              that slice the tag spent in that bin. A trend shows a line; this
 *              shows where the line lives. A valve hunting between two
 *              positions is two bands, a pressure that moved after a change
 *              is a band stepping up — both easy to miss on a trend, and
 *              invisible in an average.
 *
 * The pipeline is deliberately split into pure steps so the output is a
 * function of (data, config) alone and never of render order:
 *
 *   PVX.data.series -> buildGrid (rows/cols/buckets) -> aggregate -> colour
 *   -> draw
 *
 * buildGrid materialises every bucket up front, including the ones no point
 * lands in, so an empty bucket is a real cell painted in EmptyCellColor rather
 * than a hole in the grid.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Hard ceiling on rendered cells. Every cell is an SVG <rect> plus a
     * <title> node, and PI Vision re-lays-out the whole symbol on each resize;
     * past a couple of thousand nodes that becomes visibly janky. Beyond this
     * point cells are also sub-pixel, so there is nothing to read anyway. */
    var MAX_CELLS = 2000;

    /* Calendar mode always has exactly one row per hour of the day. */
    var CAL_ROWS = 24;

    var AGG_LABEL = {
        avg: 'Avg', max: 'Max', min: 'Min',
        last: 'Last', range: 'Range', count: 'Count'
    };

    var definition = {
        typeName: 'pvxHeatmap',
        displayName: 'PVX Heatmap',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Heatmap',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                // Plot-values resolution. Buckets are built from these points,
                // so this is the sampling floor for every aggregate.
                Intervals: 400,
                Height: 260,
                Width: 420,

                // --- shape -----------------------------------------------
                Mode: 'calendar',            // calendar | matrix | density
                Aggregate: 'avg',            // avg | max | min | last | range | count
                BucketCount: 24,             // matrix + density: number of time columns
                ValueBins: 20,               // density: number of value rows
                ValueMin: '',                // density: blank => data minimum
                ValueMax: '',                // density: blank => data maximum
                Title: '',                   // blank => attribute label

                // --- colour ----------------------------------------------
                ColorScale: 'sequential',    // sequential | diverging | thresholds | custom
                CustomLowColor: '#e8f0f7',
                CustomHighColor: '#0d3b66',
                DivergingCenter: 0,
                ReverseScale: false,
                ScaleMin: '',                // blank => auto from data
                ScaleMax: '',
                EmptyCellColor: '',          // blank => theme.track

                // --- legend ----------------------------------------------
                ShowLegend: true,
                LegendPosition: 'bottom',    // bottom | right

                // --- cells -----------------------------------------------
                ShowValues: false,
                CellGap: 1,
                CellRadius: 1,

                // --- labels ----------------------------------------------
                ShowRowLabels: true,
                ShowColumnLabels: true,
                RowLabelWidthPct: 22,
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Fields the template binds to. Everything else is drawn into SVG.
        scope.pvx = {
            title: '',
            subtitle: '',
            note: '',
            range: '',
            error: '',
            background: ''
        };

        var seriesList = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-heat-body',

            onData: function (d) {
                seriesList = PVX.data.series(d) || [];
            },

            render: render
        });

        /* ================================================================ *
         * Pure helpers — no DOM, no config side effects
         * ================================================================ */

        function pad2(n) { return (n < 10 ? '0' : '') + n; }

        function intOr(v, fallback) {
            var n = parseInt(v, 10);
            return isFinite(n) ? n : fallback;
        }

        /**
         * Reduce one bucket's values to a single number.
         * An empty bucket always returns null — including for 'count' — so the
         * "no data here" case is a single condition everywhere downstream, and
         * a gap never masquerades as a legitimate zero.
         */
        function aggregate(values, kind) {
            var n = values.length;
            if (!n) { return null; }
            var min = values[0], max = values[0], sum = 0, i, v;
            for (i = 0; i < n; i++) {
                v = values[i];
                if (v < min) { min = v; }
                if (v > max) { max = v; }
                sum += v;
            }
            switch (kind) {
                case 'max': return max;
                case 'min': return min;
                case 'last': return values[n - 1];   // points arrive time-sorted
                case 'range': return max - min;
                case 'count': return n;
                case 'avg':
                default: return sum / n;
            }
        }

        /** Local midnight of a Date, as ms. The calendar day key. */
        function dayKey(date) {
            return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        }

        /**
         * Allocate every (row, col) bucket up front. Dense indexing (r * nCols
         * + c) keeps lookup O(1) and makes the output order deterministic
         * regardless of the order points arrive in.
         */
        function makeBuckets(rows, cols) {
            var list = [];
            for (var r = 0; r < rows.length; r++) {
                for (var c = 0; c < cols.length; c++) {
                    list.push({ rowKey: rows[r].key, colKey: cols[c].key, r: r, c: c, values: [] });
                }
            }
            return list;
        }

        /**
         * calendar: rows = hour of day, columns = calendar days spanning the
         * data (including days with no data, so a gap reads as a gap).
         */
        function buildCalendar(series, cfg) {
            var grid = { rows: [], cols: [], buckets: [], note: '', units: '' };
            var pts = series ? series.points : [];
            var i, d;

            for (i = 0; i < CAL_ROWS; i++) {
                grid.rows.push({
                    key: i,
                    label: pad2(i),
                    tip: pad2(i) + ':00–' + pad2(i) + ':59',
                    units: series ? (series.units || '') : ''
                });
            }

            // Span of whole local days covered by the data.
            var minDay = null, maxDay = null;
            for (i = 0; i < pts.length; i++) {
                d = pts[i].date;
                if (!d) { continue; }                 // undecodable timestamp
                var k = dayKey(d);
                if (minDay === null || k < minDay) { minDay = k; }
                if (maxDay === null || k > maxDay) { maxDay = k; }
            }
            if (minDay === null) { return grid; }

            // Walk day by day through the Date API rather than adding 86400000,
            // so DST transitions do not shift the boundary off local midnight.
            var days = [];
            var cursor = new Date(minDay);
            var guard = 0;
            while (cursor.getTime() <= maxDay && guard < 4000) {
                days.push(new Date(cursor.getTime()));
                cursor.setDate(cursor.getDate() + 1);
                guard += 1;
            }

            // Cell cap: 24 rows are fixed, so trim columns. Keep the most
            // recent days — operators care about now, not the far edge.
            var maxCols = Math.max(1, Math.floor(MAX_CELLS / CAL_ROWS));
            if (days.length > maxCols) {
                grid.note = 'Showing the most recent ' + maxCols + ' of ' + days.length +
                            ' days (' + MAX_CELLS + '-cell limit).';
                days = days.slice(days.length - maxCols);
            }

            var index = {};
            for (i = 0; i < days.length; i++) {
                var dk = days[i].getTime();
                index[dk] = i;
                grid.cols.push({
                    key: dk,
                    label: (days[i].getMonth() + 1) + '/' + days[i].getDate(),
                    tip: PVX.fmt.time(days[i], 'date')
                });
            }

            grid.buckets = makeBuckets(grid.rows, grid.cols);
            var nCols = grid.cols.length;
            for (i = 0; i < pts.length; i++) {
                d = pts[i].date;
                if (!d) { continue; }
                var c = index[dayKey(d)];
                if (c === undefined) { continue; }    // trimmed by the cap
                grid.buckets[d.getHours() * nCols + c].values.push(pts[i].v);
            }
            return grid;
        }

        /**
         * matrix: rows = data sources, columns = BucketCount equal slices of
         * the full time span present in the data.
         */
        function buildMatrix(all, cfg) {
            var grid = { rows: [], cols: [], buckets: [], note: '', units: '' };
            var i, j, s;

            var rows = all;
            if (rows.length > MAX_CELLS) {
                grid.note = 'Showing the first ' + MAX_CELLS + ' of ' + rows.length + ' data sources.';
                rows = rows.slice(0, MAX_CELLS);
            }

            // Common time span across every series.
            var t0 = null, t1 = null;
            for (i = 0; i < rows.length; i++) {
                s = rows[i];
                for (j = 0; j < s.points.length; j++) {
                    var t = s.points[j].t;
                    if (t0 === null || t < t0) { t0 = t; }
                    if (t1 === null || t > t1) { t1 = t; }
                }
            }

            for (i = 0; i < rows.length; i++) {
                grid.rows.push({
                    key: rows[i].label,
                    label: rows[i].label,
                    tip: rows[i].path || rows[i].label,
                    units: rows[i].units || ''
                });
            }
            if (t0 === null) { return grid; }

            var buckets = PVX.util.clamp(intOr(cfg.BucketCount, 24), 1, 1000);

            // Cell cap: rows are the data, so the columns give way.
            var maxCols = Math.max(1, Math.floor(MAX_CELLS / Math.max(1, grid.rows.length)));
            if (buckets > maxCols) {
                grid.note = 'Time buckets reduced from ' + buckets + ' to ' + maxCols +
                            ' to stay under the ' + MAX_CELLS + '-cell limit.';
                buckets = maxCols;
            }

            // A single-instant range would divide by zero; one bucket is the
            // honest answer there.
            var width = (t1 - t0) / buckets;
            if (!(width > 0)) { width = 1; buckets = 1; }

            for (i = 0; i < buckets; i++) {
                var start = t0 + i * width;
                grid.cols.push({
                    key: start,
                    label: PVX.fmt.time(start, 'short'),
                    tip: PVX.fmt.time(start, 'datetime')
                });
            }

            grid.buckets = makeBuckets(grid.rows, grid.cols);
            for (i = 0; i < rows.length; i++) {
                for (j = 0; j < rows[i].points.length; j++) {
                    var p = rows[i].points[j];
                    // clamp: the last point sits exactly on t1 and would index
                    // one past the end.
                    var c = PVX.util.clamp(Math.floor((p.t - t0) / width), 0, buckets - 1);
                    grid.buckets[i * buckets + c].values.push(p.v);
                }
            }
            return grid;
        }

        /**
         * density: rows = bins of the tag's value (highest at the top, the way
         * a trend's y axis reads), columns = BucketCount equal time slices, and
         * each cell = the percentage of its slice the tag spent in that bin.
         *
         * Counting POINTS per cell would be wrong, and not subtly. Plot values
         * are chosen to preserve a trend's shape, so they crowd into upsets and
         * thin out in steady running; PI's own compression does the same to
         * the archive underneath. A point count therefore paints the upset as
         * where the tag "usually" was. Weighting by TIME is the fix: every
         * segment between consecutive points is walked as a straight line —
         * PI interpolates analog values linearly between events, so that is
         * what the tag was doing — split at slice boundaries, and its duration
         * shared out across the value bins it passes through.
         *
         * Time spent outside ValueMin..ValueMax is not folded into the edge
         * rows, which would invent a pile-up at the limit. It is counted and
         * reported in the footer instead.
         */
        function buildDensity(series, cfg) {
            var grid = { rows: [], cols: [], buckets: [], note: '', units: '', density: true };
            var pts = series ? series.points : [];
            var i;
            if (pts.length < 2) { return grid; }

            var dMin = pts[0].v, dMax = pts[0].v;
            for (i = 1; i < pts.length; i++) {
                if (pts[i].v < dMin) { dMin = pts[i].v; }
                if (pts[i].v > dMax) { dMax = pts[i].v; }
            }
            var vMin = PVX.util.num(cfg.ValueMin);
            var vMax = PVX.util.num(cfg.ValueMax);
            if (vMin === null) { vMin = dMin; }
            if (vMax === null) { vMax = dMax; }
            if (!(vMax > vMin)) {
                // A flat tag still has a distribution — all of it in one bin.
                // Give that bin a real width so the label means something.
                var halfW = Math.abs(vMin) * 0.05 || 0.5;
                vMin -= halfW; vMax += halfW;
            }

            var nBins = PVX.util.clamp(intOr(cfg.ValueBins, 20), 2, 100);
            var nCols = PVX.util.clamp(intOr(cfg.BucketCount, 24), 1, 1000);
            var maxCols = Math.max(1, Math.floor(MAX_CELLS / nBins));
            if (nCols > maxCols) {
                grid.note = 'Time buckets reduced from ' + nCols + ' to ' + maxCols +
                            ' to stay under the ' + MAX_CELLS + '-cell limit.';
                nCols = maxCols;
            }

            var t0 = pts[0].t, t1 = pts[pts.length - 1].t;
            if (!(t1 > t0)) { return grid; }
            var colW = (t1 - t0) / nCols;
            var binW = (vMax - vMin) / nBins;
            var units = series.units || '';
            grid.units = units;

            // Rows run top-down, so row 0 is the HIGHEST bin.
            for (i = 0; i < nBins; i++) {
                var lo = vMax - (i + 1) * binW;
                var hi = lo + binW;
                grid.rows.push({
                    key: i,
                    label: PVX.fmt.tick(lo),
                    tip: PVX.fmt.tick(lo) + ' – ' + PVX.fmt.tick(hi) + (units ? ' ' + units : ''),
                    units: '',
                    lo: lo, hi: hi
                });
            }
            for (i = 0; i < nCols; i++) {
                var start = t0 + i * colW;
                grid.cols.push({
                    key: start,
                    label: PVX.fmt.time(start, 'short'),
                    tip: PVX.fmt.time(start, 'datetime')
                });
            }
            grid.buckets = makeBuckets(grid.rows, grid.cols);
            for (i = 0; i < grid.buckets.length; i++) { grid.buckets[i].ms = 0; }

            var colTotal = [];
            for (i = 0; i < nCols; i++) { colTotal.push(0); }
            var outside = 0, total = 0;

            /* Share one straight piece (value va -> vb over dt ms) out across
             * the bins of column c. A flat piece lands in one bin; a sloped
             * one gives each bin the fraction of the rise that crosses it. */
            function spread(c, va, vb, dt) {
                if (!(dt > 0)) { return; }
                colTotal[c] += dt;
                total += dt;
                var lo = Math.min(va, vb), hi = Math.max(va, vb);
                var rise = hi - lo;
                if (rise < binW * 1e-6) {
                    if (va < vMin || va > vMax) { outside += dt; return; }
                    // The top edge belongs to the top bin, not to a bin past it.
                    var k = Math.min(nBins - 1, Math.floor((vMax - va) / binW));
                    grid.buckets[k * nCols + c].ms += dt;
                    return;
                }
                var inLo = Math.max(lo, vMin), inHi = Math.min(hi, vMax);
                var inside = inHi > inLo ? inHi - inLo : 0;
                outside += dt * (1 - inside / rise);
                if (!inside) { return; }
                var kTop = Math.max(0, Math.floor((vMax - inHi) / binW));
                var kBot = Math.min(nBins - 1, Math.floor((vMax - inLo) / binW));
                for (var k2 = kTop; k2 <= kBot; k2++) {
                    var bHi = vMax - k2 * binW, bLo = bHi - binW;
                    var ov = Math.min(bHi, inHi) - Math.max(bLo, inLo);
                    if (ov > 0) { grid.buckets[k2 * nCols + c].ms += dt * ov / rise; }
                }
            }

            for (i = 0; i + 1 < pts.length; i++) {
                var a = pts[i], b = pts[i + 1];
                var span = b.t - a.t;
                if (!(span > 0)) { continue; }
                var slope = (b.v - a.v) / span;
                var ta = a.t;
                // Split at every column boundary the segment crosses.
                while (ta < b.t) {
                    var c = PVX.util.clamp(Math.floor((ta - t0) / colW), 0, nCols - 1);
                    var edge = c === nCols - 1 ? b.t : Math.min(b.t, t0 + (c + 1) * colW);
                    if (!(edge > ta)) { edge = b.t; }
                    spread(c, a.v + slope * (ta - a.t), a.v + slope * (edge - a.t), edge - ta);
                    ta = edge;
                }
            }

            for (i = 0; i < grid.buckets.length; i++) {
                var bk = grid.buckets[i];
                var ct = colTotal[bk.c];
                bk.value = (ct > 0 && bk.ms > 0) ? 100 * bk.ms / ct : null;
            }

            if (total > 0 && outside / total >= 0.0005) {
                grid.note = (grid.note ? grid.note + ' ' : '') +
                    PVX.fmt.number(100 * outside / total, { decimals: 1 }) + '% of the time was outside ' +
                    PVX.fmt.tick(vMin) + ' – ' + PVX.fmt.tick(vMax) + ' and is not shown.';
            }
            return grid;
        }

        /** Reduce every bucket, and report the value domain that came out. */
        function reduceGrid(grid, cfg) {
            var kind = cfg.Aggregate || 'avg';
            var lo = null, hi = null;
            for (var i = 0; i < grid.buckets.length; i++) {
                var b = grid.buckets[i];
                // density cells are a time share computed by buildDensity, not
                // an aggregate of values that landed in them.
                var v = grid.density ? b.value : aggregate(b.values, kind);
                b.value = v;
                b.count = b.values.length;
                if (v === null) { continue; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            }
            grid.dataMin = lo;
            grid.dataMax = hi;
            grid.hasValues = lo !== null;
            return grid;
        }

        /** Colour domain: data extent, overridden by ScaleMin / ScaleMax. */
        function colorDomain(grid, cfg) {
            var lo = grid.dataMin, hi = grid.dataMax;
            if (lo === null) { lo = 0; hi = 1; }
            var cMin = PVX.util.num(cfg.ScaleMin);
            var cMax = PVX.util.num(cfg.ScaleMax);
            if (cMin !== null) { lo = cMin; }
            if (cMax !== null) { hi = cMax; }
            if (!(hi > lo)) { hi = lo + 1; }          // degenerate / inverted
            return [lo, hi];
        }

        /**
         * Density colour domain: 0 % up to the busiest cell, unless the
         * operator fixed it. Starting at zero matters — a scale that starts at
         * the quietest cell would paint "almost never" as if it were "never".
         */
        function densityDomain(grid, cfg) {
            var lo = PVX.util.num(cfg.ScaleMin);
            var hi = PVX.util.num(cfg.ScaleMax);
            if (lo === null) { lo = 0; }
            if (hi === null) { hi = grid.dataMax === null ? 100 : grid.dataMax; }
            if (!(hi > lo)) { hi = lo + 1; }
            return [lo, hi];
        }

        /** The config as the colour code should see it in density mode. */
        function densityCfg(cfg) {
            var out = {};
            for (var k in cfg) {
                if (Object.prototype.hasOwnProperty.call(cfg, k)) { out[k] = cfg[k]; }
            }
            out.__density = true;
            if (out.ColorScale === 'thresholds') { out.ColorScale = 'sequential'; }
            return out;
        }

        /**
         * value -> colour. Returns a plain function so the legend can sample
         * exactly the same mapping the cells use.
         */
        function makeColorFn(cfg, t, domain) {
            var lo = domain[0], hi = domain[1];
            var span = (hi - lo) || 1;
            var reverse = !!cfg.ReverseScale;
            var kind = cfg.ColorScale || 'sequential';

            // In density mode the cell value is a percentage of time, and a
            // threshold band is a statement about the tag's value — applying
            // one to the other would colour by a meaningless number.
            if (kind === 'thresholds' && !cfg.__density) {
                // Discrete by definition: no interpolation, the band colour is
                // the cell colour.
                return function (v) {
                    return PVX.thresholds.colorFor(cfg.Thresholds, v, t.track);
                };
            }

            if (kind === 'diverging') {
                var centre = PVX.util.num(cfg.DivergingCenter);
                if (centre === null) { centre = 0; }
                // Symmetric half-span keeps the neutral stop pinned to the
                // centre value even when the data is lopsided.
                var half = Math.max(Math.abs(hi - centre), Math.abs(centre - lo)) || 1;
                return function (v) {
                    var f = PVX.util.clamp(0.5 + (v - centre) / (2 * half), 0, 1);
                    return PVX.color.ramp(PVX.color.diverging, reverse ? 1 - f : f);
                };
            }

            if (kind === 'custom') {
                var a = cfg.CustomLowColor || '#e8f0f7';
                var b = cfg.CustomHighColor || '#0d3b66';
                return function (v) {
                    var f = PVX.util.clamp((v - lo) / span, 0, 1);
                    return PVX.color.mix(a, b, reverse ? 1 - f : f);
                };
            }

            // PVX.color.sequential is ordered dark -> light. Heatmaps read
            // correctly the other way round (pale = quiet, deep = hot), so
            // sample the ramp backwards.
            var seq = PVX.color.sequential.slice().reverse();
            return function (v) {
                var f = PVX.util.clamp((v - lo) / span, 0, 1);
                return PVX.color.ramp(seq, reverse ? 1 - f : f);
            };
        }

        /**
         * Show every Nth label so they cannot collide.
         * `space` is the px available along the label axis, `per` the px one
         * label needs. Never returns 0.
         */
        function labelStep(count, space, per) {
            var fits = Math.max(1, Math.floor(space / Math.max(1, per)));
            return Math.max(1, Math.ceil(count / fits));
        }

        /** Snap an hour step to a value that divides the day evenly. */
        function niceHourStep(step) {
            var nice = [1, 2, 3, 4, 6, 8, 12, 24];
            for (var i = 0; i < nice.length; i++) {
                if (nice[i] >= step) { return nice[i]; }
            }
            return 24;
        }

        /* ================================================================ *
         * Render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;

            // Template bindings first — they are valid even when there is no
            // host element yet (first frame before Angular has linked).
            var mode = cfg.Mode === 'matrix' || cfg.Mode === 'density' ? cfg.Mode : 'calendar';
            var aggName = mode === 'density' ? 'Time share' : (AGG_LABEL[cfg.Aggregate] || 'Avg');
            var primary = seriesList.length ? seriesList[0] : null;

            scope.pvx.background = cfg.Transparent ? 'transparent' : (cfg.BackgroundColor || t.surface);
            scope.pvx.title = cfg.Title || (mode !== 'matrix' && primary ? primary.label : '');
            scope.pvx.subtitle = mode === 'density'
                ? '% of time' + (primary && primary.units ? ' · ' + primary.units : '')
                : aggName + (mode === 'calendar' ? ' · hour × day' : ' · tag × time');
            scope.pvx.error = (primary && !primary.good) ? (primary.errorDescription || 'Bad data') : '';

            applyThemeVars(c, t);

            if (host) {
                drawGrid(c, cfg, t, host, mode, aggName);
            }

            // bootstrap renders inside requestAnimationFrame, outside Angular's
            // digest, so the header/footer bindings above need a nudge.
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        /** Theme tokens as CSS custom properties for the template chrome. */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
        }

        function drawGrid(c, cfg, t, host, mode, aggName) {
            var svgRoot = host.querySelector('svg.pvx-heat-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-heat-svg' }, host);
            }
            var W = Math.max(24, host.clientWidth || c.width);
            var H = Math.max(24, host.clientHeight || c.height);
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            // ---- model ---------------------------------------------------
            var grid = mode === 'matrix'
                ? buildMatrix(seriesList, cfg)
                : (mode === 'density'
                    ? buildDensity(seriesList.length ? seriesList[0] : null, cfg)
                    : buildCalendar(seriesList.length ? seriesList[0] : null, cfg));
            reduceGrid(grid, cfg);
            if (mode === 'density' && seriesList.length > 1) {
                grid.note = (grid.note ? grid.note + ' ' : '') + 'Density mode shows the first data source only; ' +
                    (seriesList.length - 1) + ' more ' + (seriesList.length === 2 ? 'is' : 'are') + ' ignored.';
            }

            scope.pvx.note = grid.note || '';

            if (!grid.hasValues || !grid.cols.length || !grid.rows.length) {
                scope.pvx.range = '';
                PVX.svg.text(svgRoot, (W / 2).toFixed(1), (H / 2).toFixed(1),
                    seriesList.length ? 'No values in this time range' : 'No data sources', {
                        'class': 'pvx-svg-label pvx-heat-emptymsg',
                        'text-anchor': 'middle',
                        'font-size': '11',
                        fill: t.textMuted
                    });
                return;
            }

            var domain = grid.density ? densityDomain(grid, cfg) : colorDomain(grid, cfg);
            var colorFn = makeColorFn(grid.density ? densityCfg(cfg) : cfg, t, domain);
            var emptyColor = cfg.EmptyCellColor || t.track;
            // 'count' is a tally of samples, not a measurement: it has no
            // decimals and it does not inherit the tag's engineering units.
            var isCount = cfg.Aggregate === 'count' || grid.density;
            var numOpts = grid.density
                ? { decimals: 1 }
                : (isCount ? { decimals: 0, compact: !!cfg.CompactNumbers } : PVX.config.numberOpts(cfg));
            var unitSuffix = grid.density ? '%' : '';

            scope.pvx.range = PVX.fmt.tick(domain[0]) + unitSuffix + ' → ' + PVX.fmt.tick(domain[1]) + unitSuffix;

            // ---- layout --------------------------------------------------
            var pad = 4;
            var areaX = pad, areaY = pad;
            var areaW = W - pad * 2, areaH = H - pad * 2;

            // Reserve the legend band before anything else so the grid never
            // has to be re-fitted afterwards.
            var LEG_H = 26, LEG_W = 66;
            var legend = null;
            if (cfg.ShowLegend) {
                if (cfg.LegendPosition === 'right' && areaW > LEG_W + 60) {
                    legend = { vertical: true, x: areaX + areaW - LEG_W, y: areaY, w: LEG_W, h: areaH };
                    areaW -= LEG_W + 6;
                } else if (cfg.LegendPosition !== 'right' && areaH > LEG_H + 40) {
                    legend = { vertical: false, x: areaX, y: areaY + areaH - LEG_H, w: areaW, h: LEG_H };
                    areaH -= LEG_H + 4;
                }
            }

            var colLabelH = cfg.ShowColumnLabels ? 13 : 0;
            var rowLabelW = 0;
            if (cfg.ShowRowLabels) {
                var pct = PVX.util.clamp(PVX.util.num(cfg.RowLabelWidthPct) || 22, 4, 50);
                rowLabelW = PVX.util.clamp(areaW * pct / 100, 16, areaW * 0.5);
            }

            var gridX = areaX + rowLabelW;
            var gridY = areaY + colLabelH;
            var gridW = Math.max(4, areaW - rowLabelW);
            var gridH = Math.max(4, areaH - colLabelH);

            var nRows = grid.rows.length, nCols = grid.cols.length;
            var cellW = gridW / nCols;
            var cellH = gridH / nRows;

            // Gap and radius are user intent, but must never eat the cell.
            var gap = Math.min(PVX.util.clamp(PVX.util.num(cfg.CellGap) || 0, 0, 8),
                               cellW * 0.4, cellH * 0.4);
            var rectW = Math.max(0.5, cellW - gap);
            var rectH = Math.max(0.5, cellH - gap);
            var radius = Math.min(PVX.util.clamp(PVX.util.num(cfg.CellRadius) || 0, 0, 12),
                                  rectW / 2, rectH / 2);

            // ---- cells ---------------------------------------------------
            var showValues = !!cfg.ShowValues && rectW >= 28 && rectH >= 16;
            var valueFont = PVX.util.clamp(Math.min(rectH * 0.5, rectW * 0.3), 7, 13);
            var cellsGroup = PVX.svg.el('g', { 'class': 'pvx-heat-cells' }, svgRoot);

            for (var i = 0; i < grid.buckets.length; i++) {
                var b = grid.buckets[i];
                var has = b.value !== null;
                var fill = has ? colorFn(b.value) : emptyColor;
                var x = gridX + b.c * cellW + gap / 2;
                var y = gridY + b.r * cellH + gap / 2;

                var rect = PVX.svg.el('rect', {
                    x: x.toFixed(2), y: y.toFixed(2),
                    width: rectW.toFixed(2), height: rectH.toFixed(2),
                    rx: radius > 0 ? radius.toFixed(2) : null,
                    ry: radius > 0 ? radius.toFixed(2) : null,
                    fill: fill,
                    'class': 'pvx-heat-cell' + (has ? '' : ' pvx-heat-cell-empty')
                }, cellsGroup);

                var row = grid.rows[b.r], col = grid.cols[b.c];
                var tip = PVX.svg.el('title', null, rect);
                tip.textContent = row.tip + ' · ' + col.tip + '\n' +
                    (grid.density
                        ? (has ? PVX.fmt.number(b.value, numOpts) + '% of this slice (' +
                                 PVX.fmt.duration(b.ms) + ')' : 'No time spent here')
                        : (has
                            ? aggName + ': ' + PVX.fmt.number(b.value, numOpts) +
                              ((row.units && !isCount) ? ' ' + row.units : '') +
                              ' (' + b.count + (b.count === 1 ? ' point)' : ' points)')
                            : 'No data'));

                if (showValues && has) {
                    // A sliver of time rounds to "0.0%", which reads as "never"
                    // on a cell that is coloured precisely because it was not.
                    var txt = (grid.density && b.value < 0.05)
                        ? '<0.1%'
                        : PVX.fmt.number(b.value, numOpts) + unitSuffix;
                    // Fall back to a compact form before giving up entirely.
                    if (txt.length * valueFont * 0.6 > rectW - 4) {
                        txt = PVX.fmt.compact(b.value, 1);
                    }
                    if (txt.length * valueFont * 0.6 <= rectW - 4) {
                        PVX.svg.text(cellsGroup,
                            (x + rectW / 2).toFixed(2), (y + rectH / 2).toFixed(2), txt, {
                                'class': 'pvx-svg-value pvx-num pvx-heat-cellvalue',
                                'text-anchor': 'middle',
                                'font-size': valueFont.toFixed(1),
                                // Contrast against the cell, not the card.
                                fill: PVX.color.readable(fill)
                            });
                    }
                }
            }

            // ---- row labels ----------------------------------------------
            if (cfg.ShowRowLabels && rowLabelW > 8) {
                var rowFont = PVX.util.clamp(cellH * 0.66, 7, 11);
                var rStep = labelStep(nRows, gridH, rowFont * 1.45);
                if (mode === 'calendar') { rStep = niceHourStep(rStep); }
                // Density rows are labelled at their lower edge, and the
                // bottom row is the one that anchors the axis — so count the
                // step up from the bottom, not down from the top.
                var rBase = mode === 'density' ? (nRows - 1) % rStep : 0;
                for (var r = 0; r < nRows; r++) {
                    if ((r - rBase) % rStep !== 0) { continue; }
                    PVX.svg.text(svgRoot,
                        (gridX - 4).toFixed(2),
                        (gridY + (mode === 'density' ? r + 1 : r + 0.5) * cellH).toFixed(2),
                        grid.rows[r].label, {
                            'class': 'pvx-svg-label pvx-heat-rowlabel',
                            'text-anchor': 'end',
                            'font-size': rowFont.toFixed(1),
                            fill: t.textMuted
                        }).appendChild(titleNode(grid.rows[r].tip));
                }
            }

            // ---- column labels -------------------------------------------
            if (cfg.ShowColumnLabels && colLabelH > 0) {
                var colFont = PVX.util.clamp(cellW * 0.5, 7, 10);
                var maxChars = 1;
                for (var m = 0; m < nCols; m++) {
                    maxChars = Math.max(maxChars, grid.cols[m].label.length);
                }
                // 0.62em per character is the usual width heuristic for the
                // Segoe UI / Roboto stack; +8px keeps neighbours apart.
                var cStep = labelStep(nCols, gridW, maxChars * colFont * 0.62 + 8);
                for (var cc = 0; cc < nCols; cc++) {
                    if (cc % cStep !== 0) { continue; }
                    PVX.svg.text(svgRoot,
                        (gridX + (cc + 0.5) * cellW).toFixed(2),
                        (areaY + colLabelH * 0.5).toFixed(2),
                        grid.cols[cc].label, {
                            'class': 'pvx-svg-label pvx-heat-collabel',
                            'text-anchor': 'middle',
                            'font-size': colFont.toFixed(1),
                            fill: t.textMuted
                        }).appendChild(titleNode(grid.cols[cc].tip));
                }
            }

            // ---- legend ---------------------------------------------------
            if (legend) {
                // Align a bottom legend with the grid, not the card.
                if (!legend.vertical) { legend.x = gridX; legend.w = gridW; }
                drawLegend(svgRoot, grid.density ? densityCfg(cfg) : cfg, t, legend, colorFn, domain, unitSuffix);
            }
        }

        function titleNode(text) {
            var n = PVX.svg.el('title', null, null);
            n.textContent = text;
            return n;
        }

        /**
         * Continuous scales get a gradient bar with min/mid/max labels;
         * 'thresholds' gets discrete swatches, because interpolating between
         * band colours would imply values the scale does not actually produce.
         *
         * The bar is built from adjacent slices sampled off the same colour
         * function the cells use — no <linearGradient>, hence no defs id to
         * collide with other instances of the symbol on the same display.
         */
        function drawLegend(svgRoot, cfg, t, box, colorFn, domain, suffix) {
            var g = PVX.svg.el('g', { 'class': 'pvx-heat-legend' }, svgRoot);
            var font = 9;
            var sfx = suffix || '';

            if (cfg.ColorScale === 'thresholds') {
                var bands = PVX.thresholds.parse(cfg.Thresholds);
                if (!bands.length) { return; }
                var sw = 10;
                if (box.vertical) {
                    var rowH = 14;
                    for (var i = 0; i < bands.length; i++) {
                        var by = box.y + i * rowH;
                        if (by + rowH > box.y + box.h) { break; }   // out of room
                        PVX.svg.el('rect', {
                            x: box.x.toFixed(1), y: by.toFixed(1),
                            width: sw, height: sw, rx: 2, fill: bands[i].color
                        }, g);
                        PVX.svg.text(g, (box.x + sw + 4).toFixed(1), (by + sw / 2).toFixed(1),
                            bands[i].label || ('≥' + PVX.fmt.tick(bands[i].value)), {
                                'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted
                            });
                    }
                } else {
                    var x = box.x;
                    for (var j = 0; j < bands.length; j++) {
                        var label = bands[j].label || ('≥' + PVX.fmt.tick(bands[j].value));
                        var itemW = sw + 4 + label.length * font * 0.62 + 12;
                        if (x + itemW > box.x + box.w) { break; }
                        PVX.svg.el('rect', {
                            x: x.toFixed(1), y: (box.y + 2).toFixed(1),
                            width: sw, height: sw, rx: 2, fill: bands[j].color
                        }, g);
                        PVX.svg.text(g, (x + sw + 4).toFixed(1), (box.y + 2 + sw / 2).toFixed(1), label, {
                            'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted
                        });
                        x += itemW;
                    }
                }
                return;
            }

            var lo = domain[0], hi = domain[1], mid = (lo + hi) / 2;
            var SLICES = 40;
            var k;

            if (box.vertical) {
                var barX = box.x, barW = 10, barH = Math.max(20, box.h - 4);
                var sliceH = barH / SLICES;
                for (k = 0; k < SLICES; k++) {
                    // Top of a vertical bar is the high end — matches how the
                    // labels read down the side.
                    var f = 1 - (k + 0.5) / SLICES;
                    PVX.svg.el('rect', {
                        x: barX.toFixed(1),
                        y: (box.y + 2 + k * sliceH).toFixed(2),
                        width: barW,
                        // +0.6 overlap kills the hairline seams antialiasing
                        // leaves between adjacent rects.
                        height: (sliceH + 0.6).toFixed(2),
                        fill: colorFn(lo + f * (hi - lo)),
                        'shape-rendering': 'crispEdges'
                    }, g);
                }
                var tx = barX + barW + 4;
                PVX.svg.text(g, tx, (box.y + 6).toFixed(1), PVX.fmt.tick(hi) + sfx,
                    { 'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted });
                PVX.svg.text(g, tx, (box.y + 2 + barH / 2).toFixed(1), PVX.fmt.tick(mid) + sfx,
                    { 'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted });
                PVX.svg.text(g, tx, (box.y + barH - 2).toFixed(1), PVX.fmt.tick(lo) + sfx,
                    { 'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted });
            } else {
                var bH = 8, bY = box.y + 2, bW = Math.max(20, box.w);
                var sliceW = bW / SLICES;
                for (k = 0; k < SLICES; k++) {
                    PVX.svg.el('rect', {
                        x: (box.x + k * sliceW).toFixed(2),
                        y: bY.toFixed(1),
                        width: (sliceW + 0.6).toFixed(2),
                        height: bH,
                        fill: colorFn(lo + ((k + 0.5) / SLICES) * (hi - lo)),
                        'shape-rendering': 'crispEdges'
                    }, g);
                }
                var ly = bY + bH + 7;
                PVX.svg.text(g, box.x.toFixed(1), ly.toFixed(1), PVX.fmt.tick(lo) + sfx,
                    { 'class': 'pvx-svg-label', 'font-size': font, 'text-anchor': 'start', fill: t.textMuted });
                PVX.svg.text(g, (box.x + bW / 2).toFixed(1), ly.toFixed(1), PVX.fmt.tick(mid) + sfx,
                    { 'class': 'pvx-svg-label', 'font-size': font, 'text-anchor': 'middle', fill: t.textMuted });
                PVX.svg.text(g, (box.x + bW).toFixed(1), ly.toFixed(1), PVX.fmt.tick(hi) + sfx,
                    { 'class': 'pvx-svg-label', 'font-size': font, 'text-anchor': 'end', fill: t.textMuted });
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
