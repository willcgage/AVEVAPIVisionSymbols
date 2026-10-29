/* ============================================================================
 * pvxProfile — spatial profile ("PVX Spatial Profile") for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 *
 * Every other chart in this library plots against TIME. This one plots against
 * POSITION: kiln zone temperatures, distillation column tray temperatures,
 * bearing positions along a shaft, cell voltages across an electrolyser stack,
 * thickness across a web. The x axis is physical, the y axis is the measurement,
 * and the SHAPE of the line is the diagnosis — a sagging middle, a hot end, a
 * step at one tray.
 *
 * Why the Table shape: PI Vision computes the aggregate server-side, one number
 * per data source, so a 24-zone kiln costs one request of 24 cells instead of 24
 * windows of samples. The aggregate is chosen with config.Columns — see COLUMN
 * SYNC below, which is the crux of this symbol because the shadow profile needs
 * a SECOND column.
 *
 * ORDERING is the design problem this symbol exists to solve. The data-source
 * order is whatever the display author dropped, which is usually alphabetical
 * and therefore wrong: Zone10 sorts before Zone2, and the resulting "profile" is
 * a shape that no physical asset has. PositionMode gives three honest answers —
 * take the author's order, parse a number out of each name, or read true
 * physical distances from a list.
 *
 * RENDERING is entirely SVG into `.pvx-profile-body`; only the header/footer
 * chrome is Angular-bound. buildModel() is pure — given rows and a config it
 * returns the exact points, limits, notes and summary statistics — so the
 * drawing code never has to make a data decision.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* ------------------------------------------------------------------ *
     * Statistics
     * ------------------------------------------------------------------ *
     * `column` is the PI Vision Table column name to request; `label` is what a
     * human reads. They are separate because the column names are an API
     * contract we must match exactly, while the label is prose.
     */
    var STATS = {
        Value:   { column: 'Value',   label: 'Value' },
        Average: { column: 'Average', label: 'Average' },
        Minimum: { column: 'Minimum', label: 'Minimum' },
        Maximum: { column: 'Maximum', label: 'Maximum' },
        Range:   { column: 'Range',   label: 'Range' },
        StdDev:  { column: 'StdDev',  label: 'Std deviation' }
    };

    /** Chosen statistic, defaulted defensively — configs are user-editable. */
    function statKey(cfg) {
        var k = cfg && cfg.Statistic;
        return Object.prototype.hasOwnProperty.call(STATS, k) ? k : 'Value';
    }

    /** Statistic drawn as the faded reference profile behind the live one. */
    function shadowKey(cfg) {
        var k = cfg && cfg.ShadowStatistic;
        return Object.prototype.hasOwnProperty.call(STATS, k) ? k : 'Average';
    }

    function statLabel(cfg) { return STATS[statKey(cfg)].label; }
    function shadowLabel(cfg) { return STATS[shadowKey(cfg)].label; }

    /** True when the shadow is switched on AND is a different aggregate. */
    function shadowActive(cfg) {
        return !!(cfg && cfg.ShowShadow) && shadowKey(cfg) !== statKey(cfg);
    }

    /* ------------------------------------------------------------------ *
     * COLUMN SYNC — the crux of this symbol
     * ------------------------------------------------------------------ *
     * PI Vision returns Summary cells POSITIONALLY, matching config.Columns:
     * cell[0] is the aggregate named by Columns[0], cell[1] by Columns[1], and
     * so on. The statistic the operator picked therefore has to DRIVE that
     * array, or the chart silently plots a different aggregate than its own
     * header claims.
     *
     * The shadow profile is what makes this non-trivial. It is a second
     * aggregate over the same window, so with ShowShadow on the request needs
     * TWO columns — [primary, shadow] — and both have to be read back in that
     * same order. PVX.data.rows() keys the summary object by the names in the
     * array it is handed, so parsing with the identical array is what makes the
     * read positional: summary[primaryColumn] is always cell[0] and
     * summary[shadowColumn] is always cell[1].
     *
     * When the two statistics are the same, only ONE column is requested. Asking
     * for the same aggregate twice would not just waste a cell — it would draw a
     * shadow exactly underneath the line, which reads as "no drift at all" when
     * in truth nothing was compared. shadowActive() gates both the request and
     * the drawing from the same condition so they can never disagree.
     *
     * syncColumns() runs on every config change AND at render time, so a display
     * saved by an older build (or with a hand-edited config) repairs itself on
     * load instead of charting stale numbers.
     */
    function columnsFor(cfg) {
        var out = [STATS[statKey(cfg)].column];
        if (shadowActive(cfg)) { out.push(STATS[shadowKey(cfg)].column); }
        return out;
    }

    /**
     * Force config.Columns (and the server-side sort) to agree with the chosen
     * statistics. Returns true if anything changed, so callers can avoid writing
     * to the config — and re-triggering PI Vision's data fetch — every render.
     */
    function syncColumns(cfg) {
        if (!cfg) { return false; }
        var want = columnsFor(cfg);
        var cur = cfg.Columns;
        var changed = false;

        if (!cur || cur.length !== want.length) {
            changed = true;
        } else {
            for (var i = 0; i < want.length; i++) {
                if (cur[i] !== want[i]) { changed = true; break; }
            }
        }
        if (changed) { cfg.Columns = want; }

        // SortColumn only affects PI Vision's own row ordering. We re-order
        // client-side by position anyway; keeping it on the primary column just
        // means the server's ordering refers to a column we actually asked for.
        if (cfg.SortColumn !== want[0]) { cfg.SortColumn = want[0]; changed = true; }
        // Descending is meaningless for a profile — position orders this chart,
        // never magnitude — and a descending server sort would scramble the
        // author's drop order, which is exactly what PositionMode 'source' is.
        if (cfg.SortDescending !== false) { cfg.SortDescending = false; changed = true; }
        return changed;
    }

    /* Default position pattern: the LAST number anywhere in the name.
     * "(\d+(?:\.\d+)?)(?!.*\d)" — a run of digits with an optional decimal part,
     * asserted to have no further digit after it. That is what makes Zone1 …
     * Zone12 order correctly (1 < 12) where alphabetical ordering never can, and
     * it survives the prefixes real tags carry: "KILN1.ZONE07.TEMP" -> 7. */
    var DEFAULT_PATTERN = '(\\d+(?:\\.\\d+)?)(?!.*\\d)';

    var definition = {
        typeName: 'pvxProfile',
        displayName: 'PVX Spatial Profile',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        // Positional config, renumbered when a data source is removed.
        sourceRemap: { Positions: 'numberList' },
        visObjectType: symbolVis,
        // A collection repeats the symbol once per asset and rebinds each copy to
        // that asset's own attributes: one chart per unit, built once.
        supportsCollections: true,
        configTitle: 'Format Spatial Profile',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                // Positional contract with PI Vision's Summary cells. Kept in
                // sync with Statistic/ShadowStatistic by syncColumns().
                Columns: ['Value'],
                SortColumn: 'Value',
                SortDescending: false,
                Height: 240,
                Width: 420,

                Title: '',

                // --- what is charted ---------------------------------
                Statistic: 'Value',              // Value|Average|Minimum|Maximum|Range|StdDev

                // --- where each point sits ---------------------------
                PositionMode: 'source',          // source | parsed | manual
                PositionPattern: DEFAULT_PATTERN,
                Positions: '',                   // manual mode: "0, 1.5, 3.2, 7"
                PositionLabel: '',               // x axis title, e.g. "Zone"

                // --- line --------------------------------------------
                LineStyle: 'line',               // line | smooth | step | none
                LineColor: '#3b82c4',
                LineWidth: 2,
                ShowPoints: true,
                PointSize: 3.2,
                ShowArea: false,
                AreaOpacity: 0.18,
                ColorPointsByThreshold: true,

                // --- limits ------------------------------------------
                ShowLimitEnvelope: false,
                UpperLimit: '',
                LowerLimit: '',
                LimitColor: '#c8452f',
                EnvelopeOpacity: 0.10,

                // --- reference (shadow) profile ----------------------
                ShowShadow: false,
                ShadowStatistic: 'Average',
                ShadowColor: '',                 // blank => muted LineColor
                ShadowOpacity: 0.45,

                // --- labels ------------------------------------------
                ShowValues: false,
                ShowNames: true,
                NameAngle: 0,                    // 0 = horizontal, -45 = angled
                HighlightExtremes: false,
                ShowStats: true,

                // --- axes --------------------------------------------
                ShowGrid: true,
                TickCount: 5,
                ScaleMin: '',
                ScaleMax: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the chart itself is SVG.
        scope.pvx = {
            title: '',
            subtitle: '',
            stats: '',
            note: '',
            error: '',
            showHeader: false,
            showFooter: false,
            background: ''
        };

        var rows = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-profile-body',

            onData: function (d) {
                var cfg = scope.config || {};
                // Parse against the columns we actually asked for. Straight
                // after a statistic change the in-flight payload may still be
                // the previous aggregate; it is replaced within one refresh, so
                // a one-frame stale number beats dropping the row entirely.
                rows = PVX.data.rows(d, cfg.Columns || columnsFor(cfg)) || [];
            },

            onConfigChange: function (newCfg) {
                // The statistics determine which aggregates PI Vision computes,
                // so the request has to be updated before the next fetch.
                syncColumns(newCfg || scope.config);
            },

            render: render
        });

        /* ================================================================ *
         * Pure model — no DOM, no drawing decisions
         * ================================================================ */

        /**
         * The charted number for one row.
         *
         * `col` is a column NAME, but the lookup is positional: PVX.data.rows()
         * built row.summary by walking the very same Columns array we sent, so
         * summary[Columns[k]] is exactly Summary cell k.
         */
        function cellValue(row, col) {
            var cell = row.summary ? row.summary[col] : null;
            var v = cell ? cell.value : null;
            // Some releases also put the plain current value on the row itself.
            // Use it as a fallback so the default statistic never comes back
            // empty just because Summary was omitted.
            if (v === null && col === 'Value') { v = row.value; }
            return v;
        }

        /** User-supplied regex, compiled defensively — a bad pattern must not throw. */
        function compilePattern(src) {
            var s = (src === undefined || src === null || src === '') ? DEFAULT_PATTERN : String(src);
            try { return new RegExp(s); } catch (e) { return null; }
        }

        /** First capture group (or the whole match) as a number, or null. */
        function matchPosition(name, re) {
            if (!re || !name) { return null; }
            var m;
            try { m = re.exec(String(name)); } catch (e) { return null; }
            if (!m) { return null; }
            return PVX.util.num(m[1] !== undefined ? m[1] : m[0]);
        }

        /** "0, 1.5, 3.2, 7" -> [0, 1.5, 3.2, 7]. Blanks and junk are dropped. */
        function parseNumberList(spec) {
            var out = [];
            if (!spec) { return out; }
            String(spec).split(/[,;\s]+/).forEach(function (chunk) {
                if (!chunk) { return; }
                var n = PVX.util.num(chunk);
                if (n !== null) { out.push(n); }
            });
            return out;
        }

        /**
         * rows + config -> everything the renderer needs.
         *
         * @returns {Object} {points, numeric, notes[], stats, limits, empty, ...}
         */
        function buildModel(cfg) {
            var i;
            var mode = cfg.PositionMode;
            if (mode !== 'parsed' && mode !== 'manual') { mode = 'source'; }

            var notes = [];
            var manual = parseNumberList(cfg.Positions);
            var re = null;
            if (mode === 'parsed') {
                re = compilePattern(cfg.PositionPattern);
                if (!re) { notes.push('Position pattern is not a valid expression'); }
            }

            // --- pass 1: a position per DATA SOURCE ------------------------
            // Indexed by row order, not by the surviving points: "one per data
            // source" in the manual list means exactly that, so a source whose
            // cell came back empty must still consume its own entry.
            var pos = [];
            var usable = 0;
            for (i = 0; i < rows.length; i++) {
                var p = null;
                if (mode === 'manual') {
                    p = i < manual.length ? manual[i] : null;
                } else if (mode === 'parsed') {
                    // The attribute name only. Falling back to the full AF path
                    // would happily match an element number ("\\SRV1\Kiln2\...")
                    // and silently order the chart by the wrong number.
                    p = matchPosition(rows[i].label, re);
                }
                pos.push(p);
                if (p !== null) { usable += 1; }
            }

            // Two points is the minimum that can describe a spatial axis; below
            // that, an axis built from one number is a worse lie than admitting
            // we are showing the author's drop order.
            var numeric = (mode !== 'source') && usable >= 2;
            if (mode !== 'source' && !numeric) {
                notes.push(mode === 'manual'
                    ? 'Manual positions unusable — showing source order'
                    : 'No positions found in the names — showing source order');
            }

            // --- pass 2: points -------------------------------------------
            var points = [];
            var skipped = 0;        // statistic came back empty
            var unpositioned = 0;   // no position, and the axis is numeric
            var badCount = 0;

            var primaryCol = STATS[statKey(cfg)].column;
            var shadowCol = shadowActive(cfg) ? STATS[shadowKey(cfg)].column : null;

            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (numeric && pos[i] === null) { unpositioned += 1; continue; }
                var v = cellValue(r, primaryCol);
                if (v === null) { skipped += 1; continue; }
                if (!r.good) { badCount += 1; }
                points.push({
                    label: r.label || ('Row ' + (i + 1)),
                    path: r.path || '',
                    units: r.units || '',
                    good: r.good !== false,
                    error: r.errorDescription || '',
                    value: v,
                    shadow: shadowCol ? cellValue(r, shadowCol) : null,
                    position: numeric ? pos[i] : 0,   // ordinal fixed up below
                    index: i
                });
            }

            // Sorting by position is the whole point of the parsed/manual modes.
            // The index tiebreak keeps ordering deterministic: Array#sort is not
            // guaranteed stable on the older engines PI Vision still supports.
            if (numeric) {
                points.sort(function (a, b) {
                    return (a.position - b.position) || (a.index - b.index);
                });
            } else {
                for (i = 0; i < points.length; i++) { points[i].position = i; }
            }

            // --- limits ----------------------------------------------------
            var upper = PVX.util.num(cfg.UpperLimit);
            var lower = PVX.util.num(cfg.LowerLimit);
            // A band entered upside-down is a typo, not an empty band.
            if (upper !== null && lower !== null && lower > upper) {
                var swap = upper; upper = lower; lower = swap;
            }
            var limits = {
                upper: upper,
                lower: lower,
                on: !!cfg.ShowLimitEnvelope && (upper !== null || lower !== null)
            };

            var outCount = 0;
            for (i = 0; i < points.length; i++) {
                var pt = points[i];
                pt.outHigh = limits.on && limits.upper !== null && pt.value > limits.upper;
                pt.outLow = limits.on && limits.lower !== null && pt.value < limits.lower;
                if (pt.outHigh || pt.outLow) { outCount += 1; }
            }

            // --- summary across the profile --------------------------------
            var vals = [];
            for (i = 0; i < points.length; i++) { vals.push(points[i].value); }
            var sorted = PVX.stats.sorted(vals);
            var summary = {
                count: sorted.length,
                min: sorted.length ? sorted[0] : null,
                max: sorted.length ? sorted[sorted.length - 1] : null,
                mean: PVX.stats.mean(vals),
                spread: sorted.length ? sorted[sorted.length - 1] - sorted[0] : null
            };

            // Extremes are located by index so the renderer can ring them
            // without re-scanning; ties take the first occurrence, which is the
            // lowest position — the end of the asset an operator walks to first.
            var iMax = -1, iMin = -1;
            for (i = 0; i < points.length; i++) {
                if (iMax === -1 || points[i].value > points[iMax].value) { iMax = i; }
                if (iMin === -1 || points[i].value < points[iMin].value) { iMin = i; }
            }

            // --- notes -----------------------------------------------------
            if (skipped) {
                notes.push(skipped + (skipped === 1 ? ' source has no ' : ' sources have no ') +
                    statLabel(cfg).toLowerCase());
            }
            if (unpositioned) {
                notes.push(unpositioned + (unpositioned === 1 ? ' source has' : ' sources have') +
                    ' no position');
            }
            if (outCount) {
                notes.push(outCount + (outCount === 1 ? ' point' : ' points') + ' outside limits');
            }

            return {
                points: points,
                numeric: numeric,
                mode: mode,
                sources: rows.length,
                skipped: skipped,
                unpositioned: unpositioned,
                badCount: badCount,
                outCount: outCount,
                limits: limits,
                stats: summary,
                iMax: iMax,
                iMin: iMin,
                shadow: !!shadowCol,
                notes: notes,
                empty: points.length === 0
            };
        }

        /* ================================================================ *
         * Text helpers
         * ================================================================ */

        /**
         * Approximate rendered width. Measuring properly means inserting the
         * text, forcing a layout and reading getComputedTextLength() once per
         * label — too expensive for the per-frame margin maths. 0.58em is the
         * average advance of Segoe UI/Roboto at small sizes.
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
         * Why measure exactly when the 0.58em estimate is good enough for tick
         * and value labels: those are numeric and centre-anchored, so a few
         * pixels of error only nudges them. Position names are proper nouns with
         * wide glyphs ("Feedwater Pump B") that average well above 0.58em, and
         * they sit hard against a neighbouring name or the frame edge — an
         * under-estimate does not ellipsise, it collides or gets chopped by the
         * host's overflow:hidden. There is no clamp that fixes that afterwards;
         * the string has to actually be short enough.
         *
         * The caller passes text already cut by the estimate, so the common case
         * measures once and returns. When it does not, each pass takes a
         * proportional bite out of the measured overshoot rather than walking a
         * character at a time, so it converges in one or two more measurements.
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

        /**
         * Scale an SVG <text> down until it fits, then truncate if the 6px floor
         * still is not enough. Used only for the empty-state copy, where a
         * centred line that overshoots pokes out of BOTH edges at once.
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
            node.textContent = str.slice(0, Math.max(3, Math.floor(str.length * (avail / w)) - 1)) + '…';
            for (var guard = 0; guard < 24 && measure() > avail && node.textContent.length > 2; guard++) {
                node.textContent = node.textContent.slice(0, -2) + '…';
            }
        }

        /**
         * Greedy left-to-right collision filter over x-ordered items.
         *
         * `widths[i]` is the label's full width; a label is kept only when its
         * left edge clears the right edge of the last one kept. This is what
         * "auto-thinned so labels never collide" means in practice, and it works
         * for the UNEVEN spacing of a manual-position axis, which a fixed
         * every-k-th rule cannot.
         */
        function thinLabels(xs, widths, gapPx) {
            var keep = [];
            var lastRight = -Infinity;
            for (var i = 0; i < xs.length; i++) {
                var half = widths[i] / 2;
                if (xs[i] - half >= lastRight) {
                    keep.push(true);
                    lastRight = xs[i] + half + (gapPx || 4);
                } else {
                    keep.push(false);
                }
            }
            return keep;
        }

        /* ================================================================ *
         * Geometry helpers
         * ================================================================ */

        function pathFor(pts, style) {
            if (!pts.length) { return ''; }
            if (style === 'step') { return PVX.svg.stepLine(pts); }
            return PVX.svg.line(pts, style === 'smooth');
        }

        /** Same outline as pathFor, closed down to a baseline. */
        function areaPathFor(pts, style, baseY) {
            if (!pts.length) { return ''; }
            return pathFor(pts, style) +
                ' L' + pts[pts.length - 1].x.toFixed(2) + ' ' + baseY.toFixed(2) +
                ' L' + pts[0].x.toFixed(2) + ' ' + baseY.toFixed(2) + ' Z';
        }

        /**
         * Split into runs of consecutive points that have a value, so a shadow
         * with a hole in it draws two segments rather than one straight line
         * bridging the gap — a bridge would invent a shape that was not measured.
         */
        function segmentsOf(pts) {
            var segs = [], cur = [];
            for (var i = 0; i < pts.length; i++) {
                if (pts[i] === null) {
                    if (cur.length) { segs.push(cur); cur = []; }
                } else {
                    cur.push(pts[i]);
                }
            }
            if (cur.length) { segs.push(cur); }
            return segs;
        }

        /* ================================================================ *
         * Color
         * ================================================================ */

        function pointColor(pt, cfg, t) {
            var base = cfg.LineColor || cfg.AccentColor || '#3b82c4';
            // Out-of-band always wins: a point outside the limits is the single
            // most important thing on the chart and must never be repainted by a
            // threshold band that happens to call it normal.
            if (pt.outHigh || pt.outLow) { return cfg.LimitColor || PVX.color.status.alarm; }
            // Threshold coloring still honours the shared UseThresholds switch,
            // so turning bands off anywhere turns them off here too.
            if (cfg.ColorPointsByThreshold && cfg.UseThresholds !== false) {
                return PVX.thresholds.colorFor(cfg.Thresholds, pt.value, base);
            }
            return base;
        }

        /**
         * Blank ShadowColor derives a muted version of the line color: mixing
         * toward the surface rather than toward grey keeps the reference profile
         * in the same hue family, so it reads as "the same measurement, earlier"
         * instead of as a second, unrelated series.
         */
        function shadowColor(cfg, t) {
            if (cfg.ShadowColor) { return cfg.ShadowColor; }
            var base = cfg.LineColor || cfg.AccentColor || '#3b82c4';
            return PVX.color.mix(base, t.dark ? '#2b3037' : '#eef2f6', 0.45);
        }

        /* ================================================================ *
         * Render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            // Self-heal a config saved before the shadow existed, or hand-edited.
            // Only writes when something actually differs, so this cannot loop
            // with PI Vision's own change detection.
            syncColumns(cfg);

            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            var W = Math.max(40, c.width);
            var H = Math.max(30, c.height);

            var svgRoot = host.querySelector('svg.pvx-profile-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-profile-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var model = buildModel(cfg);

            // Below roughly 200x140 the chrome costs more than it informs —
            // these get dropped small into mosaics — so shed the header, footer,
            // names and axis titles and keep the line, points and envelope,
            // which are the parts that still read at that size.
            //
            // Measured on the SYMBOL box, never on the SVG host: the host shrinks
            // when the header and footer are shown, so deciding from it would
            // hide the chrome, grow the host, show the chrome again and flicker
            // forever at exactly the sizes near the threshold.
            var boxW = (c.node && c.node.clientWidth) || W;
            var boxH = (c.node && c.node.clientHeight) || H;
            var compact = boxW < 200 || boxH < 140;

            // ---- chrome ---------------------------------------------------
            scope.pvx.title = cfg.Title || 'Spatial profile';
            scope.pvx.subtitle = statLabel(cfg) +
                (shadowActive(cfg) ? ' vs ' + shadowLabel(cfg).toLowerCase() : '') +
                commonUnitsSuffix(cfg, model);
            scope.pvx.note = model.notes.join(' · ');
            scope.pvx.stats = (cfg.ShowStats && !model.empty) ? statsText(cfg, model) : '';
            scope.pvx.error = model.badCount
                ? (model.badCount + (model.badCount === 1 ? ' source reports' : ' sources report') + ' bad quality')
                : '';
            scope.pvx.showHeader = !compact && cfg.ShowLabel !== false;
            scope.pvx.showFooter = !compact && !!(scope.pvx.stats || scope.pvx.note);

            if (model.empty) {
                emptyState(svgRoot, W, H, t,
                    rows.length ? 'No ' + statLabel(cfg).toLowerCase() + ' values' : 'No data sources',
                    rows.length
                        ? 'All ' + rows.length + ' sources returned an empty cell.'
                        : 'Drop one attribute per position onto this symbol.');
                digest();
                return;
            }

            drawChart(svgRoot, W, H, cfg, t, model, compact);
            digest();
        }

        /** Units are only meaningful in the header when every point agrees. */
        function commonUnits(model) {
            var u = null;
            for (var i = 0; i < model.points.length; i++) {
                var iu = model.points[i].units || '';
                if (u === null) { u = iu; }
                else if (u !== iu) { return ''; }
            }
            return u || '';
        }

        function commonUnitsSuffix(cfg, model) {
            if (cfg.ShowUnits === false) { return ''; }
            var u = commonUnits(model);
            return u ? ' · ' + u : '';
        }

        /** Footer summary: what the profile looks like as four numbers. */
        function statsText(cfg, model) {
            var o = PVX.config.numberOpts(cfg);
            var s = model.stats;
            var u = (cfg.ShowUnits === false) ? '' : commonUnits(model);
            var suffix = u ? ' ' + u : '';
            return 'min ' + PVX.fmt.number(s.min, o) +
                ' · max ' + PVX.fmt.number(s.max, o) +
                ' · mean ' + PVX.fmt.number(s.mean, o) +
                ' · spread ' + PVX.fmt.number(s.spread, o) + suffix;
        }

        /* ---------------------------------------------------------------- *
         * The chart
         * ---------------------------------------------------------------- */

        function drawChart(svgRoot, W, H, cfg, t, model, compact) {
            var i;
            var pts = model.points;
            var n = pts.length;
            var numOpts = PVX.config.numberOpts(cfg);

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 24), 8, 12);
            var titleFont = PVX.util.clamp(font + 1, 9, 13);
            var pad = 5;

            var showTicks = W >= 130 && H >= 100;
            var showNames = !compact && cfg.ShowNames !== false;
            var angled = showNames && PVX.util.num(cfg.NameAngle) !== null &&
                         PVX.util.num(cfg.NameAngle) <= -20;
            var axisTitle = (!compact && cfg.PositionLabel) ? String(cfg.PositionLabel) : '';

            // ---- value domain -------------------------------------------
            var lo = null, hi = null;
            var consider = function (v) {
                if (!PVX.util.isNum(v)) { return; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            };
            for (i = 0; i < n; i++) { consider(pts[i].value); consider(pts[i].shadow); }
            // Fold the limits into the domain, otherwise an envelope outside the
            // data range would be invisible and the operator would think the
            // setting did nothing.
            if (model.limits.on) { consider(model.limits.upper); consider(model.limits.lower); }
            if (lo === null) { lo = 0; hi = 1; }

            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12);
            var dom = PVX.scale.niceDomain(lo, hi, tickCount);   // handles lo === hi
            var sMin = PVX.util.num(cfg.ScaleMin);
            var sMax = PVX.util.num(cfg.ScaleMax);
            if (sMin !== null) { dom[0] = sMin; }
            if (sMax !== null) { dom[1] = sMax; }
            if (!(dom[1] > dom[0])) { dom[1] = dom[0] + 1; }     // never divide by zero
            var vTicks = PVX.scale.ticks(dom[0], dom[1], tickCount);

            // ---- position domain ----------------------------------------
            var pLo = pts[0].position, pHi = pts[0].position;
            for (i = 1; i < n; i++) {
                if (pts[i].position < pLo) { pLo = pts[i].position; }
                if (pts[i].position > pHi) { pHi = pts[i].position; }
            }

            // ---- margins -------------------------------------------------
            // Derived from the ACTUAL tick strings, so a "1,234,567" axis is
            // never clipped and a "0..5" axis does not waste half the width.
            var yLabelW = 0;
            if (showTicks) {
                for (i = 0; i < vTicks.length; i++) {
                    yLabelW = Math.max(yLabelW, textPx(PVX.fmt.tick(vTicks[i]), font));
                }
            }

            var nameBand = 0;
            // An angled name is laid out along the diagonal, so the band it needs
            // is roughly its length / sqrt(2). Giving it ~5.5 line-heights buys
            // about 13 legible characters, which is where real tag names start
            // to survive intact.
            if (showNames) { nameBand = angled ? font * 5.5 : font * 1.7; }
            // Numeric positions get their own tick row; ordinal positions are
            // just 1..n, a number that means nothing, so the names ARE the axis.
            var xTickBand = (showTicks && model.numeric) ? font * 1.6 : 0;
            var titleBand = axisTitle ? titleFont + 4 : 0;

            var mL = pad + (showTicks ? yLabelW + 6 : 0);
            var mR = pad + (model.numeric && showTicks ? font * 1.4 : 2);
            // Values sit one row above the markers and the extreme captions sit
            // above those again, so with both switched on the top margin has to
            // hold two rows or the highest point's captions leave the frame.
            var mT = pad + ((cfg.ShowValues || cfg.HighlightExtremes) ? font * 1.6 : 2) +
                     ((cfg.ShowValues && cfg.HighlightExtremes) ? font * 1.2 : 0);
            var mB = pad + nameBand + xTickBand + titleBand;

            // On tiny symbols the margins can swallow the plot; cap them.
            mL = Math.min(mL, W * 0.42);
            mR = Math.min(mR, W * 0.2);
            mT = Math.min(mT, H * 0.3);
            mB = Math.min(mB, H * 0.5);

            var plot = {
                x: mL, y: mT,
                w: Math.max(10, W - mL - mR),
                h: Math.max(10, H - mT - mB)
            };
            plot.x1 = plot.x + plot.w;
            plot.y1 = plot.y + plot.h;

            // ---- scales ---------------------------------------------------
            var sy = PVX.scale.linear(dom[0], dom[1], plot.y1, plot.y);   // SVG y grows down
            var sx, slot;
            if (model.numeric) {
                // A hair of padding so the first and last markers are not half
                // swallowed by the axis. A single position (or several sources
                // that all parsed the same number) has no span at all.
                var span = pHi - pLo;
                var padX = span > 0 ? span * 0.04 : (Math.abs(pLo) * 0.1 || 1);
                sx = PVX.scale.linear(pLo - padX, pHi + padX, plot.x, plot.x1);
            } else {
                // Ordinal: even spacing on category centres, which keeps the
                // first and last names inside the frame.
                slot = plot.w / n;
                sx = function (idx) { return plot.x + slot * (idx + 0.5); };
            }

            var xs = [];
            for (i = 0; i < n; i++) { xs.push(sx(pts[i].position)); }

            // ---- grid + axis lines ----------------------------------------
            var gridG;
            if (cfg.ShowGrid !== false) {
                gridG = PVX.svg.el('g', { 'class': 'pvx-profile-grid pvx-grid-line', stroke: t.grid }, svgRoot);
                for (i = 0; i < vTicks.length; i++) {
                    var gy = sy(vTicks[i]);
                    PVX.svg.el('line', {
                        x1: plot.x.toFixed(2), y1: gy.toFixed(2),
                        x2: plot.x1.toFixed(2), y2: gy.toFixed(2)
                    }, gridG);
                }
                // A rule at every position: on a profile the reader is always
                // asking "which zone is that dip?", and the rule is what ties
                // the marker to its name. Skipped once the positions are dense
                // enough that the rules would read as a solid block.
                if (plot.w / n >= 10) {
                    for (i = 0; i < n; i++) {
                        PVX.svg.el('line', {
                            x1: xs[i].toFixed(2), y1: plot.y.toFixed(2),
                            x2: xs[i].toFixed(2), y2: plot.y1.toFixed(2)
                        }, gridG);
                    }
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

            // Everything data-driven is clipped to the plot rect, so a point
            // pushed out of range by ScaleMin/ScaleMax cannot bleed over the
            // axis labels.
            var clipId = clipIdFor(svgRoot);
            var defs = PVX.svg.el('defs', null, svgRoot);
            var clip = PVX.svg.el('clipPath', { id: clipId }, defs);
            PVX.svg.el('rect', {
                x: plot.x.toFixed(2), y: plot.y.toFixed(2),
                width: plot.w.toFixed(2), height: plot.h.toFixed(2)
            }, clip);
            var plotG = PVX.svg.el('g', { 'clip-path': 'url(#' + clipId + ')' }, svgRoot);

            // ---- limit envelope ------------------------------------------
            if (model.limits.on) {
                drawLimits(plotG, plot, sy, dom, cfg, model.limits);
            }

            // ---- shadow (reference) profile -------------------------------
            // Drawn first so the live profile always sits on top of it: the
            // question is "how has the shape moved", and the answer is easier to
            // read when the current line is unobscured.
            if (model.shadow) {
                drawShadow(plotG, cfg, t, model, xs, sy);
            }

            // ---- area + line ----------------------------------------------
            var style = cfg.LineStyle || 'line';
            var lineColor = cfg.LineColor || cfg.AccentColor || '#3b82c4';
            var lineW = PVX.util.clamp(PVX.util.num(cfg.LineWidth) === null ? 2 : PVX.util.num(cfg.LineWidth), 0.5, 10);
            var linePts = [];
            for (i = 0; i < n; i++) { linePts.push({ x: xs[i], y: sy(pts[i].value) }); }

            if (cfg.ShowArea && linePts.length > 1) {
                var areaOp = PVX.util.num(cfg.AreaOpacity);
                areaOp = areaOp === null ? 0.18 : PVX.util.clamp(areaOp, 0, 1);
                PVX.svg.el('path', {
                    d: areaPathFor(linePts, style, plot.y1),
                    fill: lineColor,
                    'fill-opacity': areaOp,
                    stroke: 'none',
                    'class': 'pvx-profile-area'
                }, plotG);
            }

            if (style !== 'none' && linePts.length > 1) {
                PVX.svg.el('path', {
                    d: pathFor(linePts, style),
                    fill: 'none',
                    // The line keeps LineColor even when the points are colored
                    // by threshold: it encodes the SHAPE, and a line that changes
                    // color along its length reads as a change in the signal.
                    stroke: lineColor,
                    'stroke-width': lineW,
                    'stroke-linejoin': 'round',
                    'stroke-linecap': 'round',
                    'class': 'pvx-profile-line'
                }, plotG);
            }

            // ---- points ----------------------------------------------------
            // With no line there is nothing else to see, so markers are forced
            // on rather than rendering an empty plot.
            var drawPoints = cfg.ShowPoints !== false || style === 'none';
            var r = PVX.util.clamp(PVX.util.num(cfg.PointSize) === null ? 3.2 : PVX.util.num(cfg.PointSize), 0.5, 14);
            var markersG = PVX.svg.el('g', { 'class': 'pvx-profile-points' }, plotG);

            for (i = 0; i < n; i++) {
                var pt = pts[i];
                var col = pointColor(pt, cfg, t);
                var cy = sy(pt.value);
                var marker;

                if (drawPoints) {
                    marker = PVX.svg.el('circle', {
                        cx: xs[i].toFixed(2), cy: cy.toFixed(2),
                        r: r.toFixed(2),
                        // Bad quality draws HOLLOW. A solid marker in a "stale"
                        // color still reads as a real measurement; a ring reads
                        // as "there is no trustworthy number here".
                        fill: pt.good ? col : (t.surface === 'transparent' ? 'none' : t.surface),
                        stroke: col,
                        'stroke-width': pt.good ? ((pt.outHigh || pt.outLow) ? 1.4 : 0) : 1.4,
                        'class': 'pvx-profile-point' + (pt.good ? '' : ' pvx-profile-bad')
                    }, markersG);
                } else {
                    // Still needs a hit target so the tooltip works.
                    marker = PVX.svg.el('circle', {
                        cx: xs[i].toFixed(2), cy: cy.toFixed(2), r: Math.max(4, r).toFixed(2),
                        fill: 'transparent', 'class': 'pvx-hit'
                    }, markersG);
                }

                // Out-of-band points get a halo as well as the alarm color, so
                // they survive being printed or screenshotted in greyscale.
                if (pt.outHigh || pt.outLow) {
                    PVX.svg.el('circle', {
                        cx: xs[i].toFixed(2), cy: cy.toFixed(2),
                        r: (r + 2.6).toFixed(2),
                        fill: 'none',
                        stroke: cfg.LimitColor || PVX.color.status.alarm,
                        'stroke-width': 1,
                        opacity: 0.75,
                        'class': 'pvx-profile-outring'
                    }, markersG);
                }

                PVX.svg.el('title', null, marker).textContent = tooltipFor(pt, cfg, model, numOpts);
            }

            // ---- extremes --------------------------------------------------
            if (cfg.HighlightExtremes && n > 1 && model.iMax !== model.iMin) {
                ringExtreme(markersG, xs[model.iMax], sy(pts[model.iMax].value), r, t, 'high');
                ringExtreme(markersG, xs[model.iMin], sy(pts[model.iMin].value), r, t, 'low');
            }

            // ---- value labels ----------------------------------------------
            if (cfg.ShowValues) {
                drawValueLabels(svgRoot, cfg, t, model, xs, sy, font, r, plot);
            }
            if (cfg.HighlightExtremes && n > 1 && model.iMax !== model.iMin) {
                drawExtremeLabels(svgRoot, cfg, t, model, xs, sy, font, r, plot, numOpts);
            }

            // ---- value axis -------------------------------------------------
            if (showTicks) {
                var axisG = PVX.svg.el('g', { 'class': 'pvx-profile-axis' }, svgRoot);
                for (i = 0; i < vTicks.length; i++) {
                    PVX.svg.text(axisG, (plot.x - 5).toFixed(2), sy(vTicks[i]).toFixed(2),
                        PVX.fmt.tick(vTicks[i]), {
                            'class': 'pvx-svg-label', 'text-anchor': 'end',
                            'font-size': font, fill: t.textMuted
                        });
                }
            }

            // ---- position axis ----------------------------------------------
            // Numeric ticks sit immediately under the axis line and the names go
            // below them. The order matters for angled names: a -45 label runs
            // DOWN-left from its anchor, so putting the names first would drag
            // them straight through the tick row.
            if (xTickBand > 0) {
                drawPositionTicks(svgRoot, plot, sx, pLo, pHi, model, cfg, t, font,
                    plot.y1 + font * 1.05);
            }
            if (showNames) {
                drawNames(svgRoot, cfg, t, model, xs, plot, font, angled, W, H,
                    plot.y1 + xTickBand + font * 1.25);
            }
            if (axisTitle) {
                PVX.svg.text(svgRoot, (plot.x + plot.w / 2).toFixed(2),
                    (H - titleFont * 0.5 - 2).toFixed(2), axisTitle, {
                        'class': 'pvx-svg-label pvx-profile-axis-title',
                        'text-anchor': 'middle', 'font-size': titleFont, fill: t.text
                    });
            }
        }

        /**
         * Stable clip id per symbol instance. Several copies of this symbol can
         * share one display, and duplicate SVG ids would make them all clip to
         * whichever rect was defined last.
         */
        function clipIdFor(svgRoot) {
            var id = svgRoot.getAttribute('data-pvx-clip');
            if (!id) {
                id = PVX.util.uid('pvxprofclip');
                svgRoot.setAttribute('data-pvx-clip', id);
            }
            return id;
        }

        function tooltipFor(pt, cfg, model, numOpts) {
            var units = pt.units ? ' ' + pt.units : '';
            var where = model.numeric
                ? ((cfg.PositionLabel ? cfg.PositionLabel + ' ' : 'Position ') +
                   PVX.fmt.number(pt.position, { decimals: 'auto' }))
                : ('Position ' + (model.points.indexOf(pt) + 1) + ' of ' + model.points.length);
            var s = pt.label + '\n' + where + '\n' +
                statLabel(cfg) + ': ' + PVX.fmt.number(pt.value, numOpts) + units;
            if (model.shadow && pt.shadow !== null) {
                s += '\n' + shadowLabel(cfg) + ': ' + PVX.fmt.number(pt.shadow, numOpts) + units;
            }
            if (model.limits.on) {
                s += '\n' + (pt.outHigh ? 'ABOVE upper limit'
                    : (pt.outLow ? 'BELOW lower limit' : 'Within limits'));
            }
            if (!pt.good) { s += '\nBAD QUALITY' + (pt.error ? ': ' + pt.error : ''); }
            if (pt.path) { s += '\n' + pt.path; }
            return s;
        }

        /** Shaded band between the limits; a single limit gives a single line. */
        function drawLimits(plotG, plot, sy, dom, cfg, limits) {
            var col = cfg.LimitColor || PVX.color.status.alarm;
            var op = PVX.util.num(cfg.EnvelopeOpacity);
            op = op === null ? 0.10 : PVX.util.clamp(op, 0, 1);

            if (limits.upper !== null && limits.lower !== null) {
                var yTop = sy(limits.upper), yBot = sy(limits.lower);
                PVX.svg.el('rect', {
                    x: plot.x.toFixed(2), y: yTop.toFixed(2),
                    width: plot.w.toFixed(2),
                    height: Math.max(0, yBot - yTop).toFixed(2),
                    fill: col, 'fill-opacity': op, stroke: 'none',
                    'class': 'pvx-profile-envelope'
                }, plotG);
            }

            var rule = function (v) {
                if (v === null) { return; }
                PVX.svg.el('line', {
                    x1: plot.x.toFixed(2), y1: sy(v).toFixed(2),
                    x2: plot.x1.toFixed(2), y2: sy(v).toFixed(2),
                    stroke: col, 'stroke-width': 1, 'stroke-dasharray': '5 4',
                    opacity: 0.85, 'class': 'pvx-profile-limit'
                }, plotG);
            };
            rule(limits.upper);
            rule(limits.lower);
        }

        /**
         * The faded reference profile. This is the feature that makes the symbol
         * diagnostic rather than decorative: drift shows up as a change of
         * SHAPE, not just of level, which is invisible on a level-only trend.
         */
        function drawShadow(plotG, cfg, t, model, xs, sy) {
            var i;
            var pts = model.points;
            var raw = [];
            for (i = 0; i < pts.length; i++) {
                raw.push(pts[i].shadow === null ? null : { x: xs[i], y: sy(pts[i].shadow) });
            }
            var segs = segmentsOf(raw);
            if (!segs.length) { return; }

            var col = shadowColor(cfg, t);
            var op = PVX.util.num(cfg.ShadowOpacity);
            op = op === null ? 0.45 : PVX.util.clamp(op, 0.05, 1);
            var style = cfg.LineStyle === 'none' ? 'line' : (cfg.LineStyle || 'line');
            var lineW = PVX.util.clamp(PVX.util.num(cfg.LineWidth) === null ? 2 : PVX.util.num(cfg.LineWidth), 0.5, 10);

            var g = PVX.svg.el('g', {
                'class': 'pvx-profile-shadow', opacity: op.toFixed(2)
            }, plotG);

            for (i = 0; i < segs.length; i++) {
                if (segs[i].length > 1) {
                    PVX.svg.el('path', {
                        d: pathFor(segs[i], style),
                        fill: 'none', stroke: col,
                        'stroke-width': Math.max(1, lineW * 0.9).toFixed(2),
                        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
                    }, g);
                } else {
                    // A lone shadow sample has no line to belong to; a dot at
                    // least shows that a reference value exists there.
                    PVX.svg.el('circle', {
                        cx: segs[i][0].x.toFixed(2), cy: segs[i][0].y.toFixed(2),
                        r: Math.max(1.2, lineW * 0.8).toFixed(2), fill: col
                    }, g);
                }
            }
        }

        function ringExtreme(g, x, y, r, t, kind) {
            PVX.svg.el('circle', {
                cx: x.toFixed(2), cy: y.toFixed(2),
                r: (r + 4.5).toFixed(2),
                fill: 'none',
                stroke: t.text,
                'stroke-width': 1,
                opacity: 0.55,
                'class': 'pvx-profile-extreme pvx-profile-extreme-' + kind
            }, g);
        }

        /**
         * Value at each point, thinned left-to-right so labels never collide.
         * Labels go above the marker, except where that would leave the plot —
         * then they flip below.
         */
        function drawValueLabels(svgRoot, cfg, t, model, xs, sy, font, r, plot) {
            var i;
            var pts = model.points;
            var numOpts = PVX.config.numberOpts(cfg);
            var texts = [], widths = [];
            for (i = 0; i < pts.length; i++) {
                texts.push(PVX.fmt.number(pts[i].value, numOpts));
                widths.push(textPx(texts[i], font));
            }
            var keep = thinLabels(xs, widths, 5);
            var g = PVX.svg.el('g', { 'class': 'pvx-profile-values' }, svgRoot);

            for (i = 0; i < pts.length; i++) {
                if (!keep[i]) { continue; }
                var y = sy(pts[i].value) - r - font * 0.55;
                if (y < plot.y + font * 0.5) { y = sy(pts[i].value) + r + font * 0.9; }
                PVX.svg.text(g,
                    PVX.util.clamp(xs[i], 2, Math.max(2, plot.x1)).toFixed(2), y.toFixed(2),
                    texts[i], {
                        'class': 'pvx-svg-value pvx-num pvx-profile-value',
                        'text-anchor': 'middle', 'font-size': font, fill: t.text
                    });
            }
        }

        /** "max 18.9" above the highest point, "min 4.2" below the lowest. */
        function drawExtremeLabels(svgRoot, cfg, t, model, xs, sy, font, r, plot, numOpts) {
            var g = PVX.svg.el('g', { 'class': 'pvx-profile-extremes' }, svgRoot);
            // With ShowValues on the number is already printed at the marker, so
            // the caption drops to the bare word and moves up a row rather than
            // stacking a second copy of the same figure on top of the first.
            var withValues = !!cfg.ShowValues;
            var lift = withValues ? font * 1.25 : 0;
            var put = function (idx, text, above) {
                var pt = model.points[idx];
                var y = above ? sy(pt.value) - r - font * 1.5 - lift
                              : sy(pt.value) + r + font * 1.6 + lift;
                // Flip when the preferred side falls outside the plot.
                if (y < plot.y + font * 0.5) { y = sy(pt.value) + r + font * 1.6 + lift; }
                if (y > plot.y1 - font * 0.2) { y = sy(pt.value) - r - font * 1.5 - lift; }
                var node = PVX.svg.text(g, xs[idx].toFixed(2), y.toFixed(2), text, {
                    'class': 'pvx-svg-value pvx-num pvx-profile-extreme-label',
                    'text-anchor': 'middle', 'font-size': (font * 0.95).toFixed(1),
                    fill: t.textMuted
                });
                // Anchored on the marker, so an overlong caption runs off both
                // sides of the frame — measure and trim to the plot width.
                fitTextTo(node, plot.w);
            };
            put(model.iMax, withValues ? 'max'
                : 'max ' + PVX.fmt.number(model.points[model.iMax].value, numOpts), true);
            put(model.iMin, withValues ? 'min'
                : 'min ' + PVX.fmt.number(model.points[model.iMin].value, numOpts), false);
        }

        /**
         * Numeric position ticks.
         *
         * When the positions are whole numbers and few enough to fit, tick at
         * the ACTUAL positions — a kiln has zones 1..12, not 1, 2.5, 4. Anything
         * else falls back to nice round ticks over the padded domain, then
         * thinned to whatever actually fits.
         */
        function drawPositionTicks(svgRoot, plot, sx, pLo, pHi, model, cfg, t, font, y) {
            var i;
            var values = [];
            var seen = {};
            var allInt = true;
            for (i = 0; i < model.points.length; i++) {
                var p = model.points[i].position;
                if (Math.abs(p - Math.round(p)) > 1e-9) { allInt = false; }
                if (!seen[p]) { seen[p] = true; values.push(p); }
            }

            var ticks;
            if (allInt && values.length <= 14) {
                ticks = values;
            } else {
                ticks = PVX.scale.ticks(pLo, pHi, PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12));
                if (!ticks.length) { ticks = values; }
            }

            var xs = [], widths = [], labels = [];
            for (i = 0; i < ticks.length; i++) {
                labels.push(PVX.fmt.tick(ticks[i]));
                widths.push(textPx(labels[i], font));
                xs.push(sx(ticks[i]));
            }
            var keep = thinLabels(xs, widths, 6);

            var g = PVX.svg.el('g', { 'class': 'pvx-profile-xaxis' }, svgRoot);
            for (i = 0; i < ticks.length; i++) {
                if (!keep[i]) { continue; }
                PVX.svg.el('line', {
                    x1: xs[i].toFixed(2), y1: plot.y1.toFixed(2),
                    x2: xs[i].toFixed(2), y2: (plot.y1 + 3).toFixed(2),
                    stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
                }, g);
                PVX.svg.text(g, xs[i].toFixed(2), y.toFixed(2), labels[i], {
                    'class': 'pvx-svg-label pvx-num', 'text-anchor': 'middle',
                    'font-size': font, fill: t.textMuted
                });
            }
        }

        /**
         * Position names under the axis. Thinned by measured width so they never
         * collide, then each survivor is trimmed EXACTLY (fitTextTo) against the
         * room its neighbours actually leave it.
         */
        function drawNames(svgRoot, cfg, t, model, xs, plot, font, angled, W, H, baseY) {
            var i;
            var pts = model.points;
            var n = pts.length;
            var g = PVX.svg.el('g', { 'class': 'pvx-profile-names' }, svgRoot);

            // The narrowest label still worth drawing — roughly four characters
            // plus an ellipsis. Thinning is measured against THIS, not against
            // the full name: a truncated "Feedwater Pu…" still tells the reader
            // which point they are looking at, so dropping it because the whole
            // name does not fit would throw away information for nothing.
            var minNeed = font * 3.2;

            if (angled) {
                // -45 degrees keeps long names readable without the vertical-text
                // guessing game. The text runs down-left from its anchor, so its
                // length is bounded by the room BELOW the plot and the room to
                // the LEFT edge — times sqrt(2) because it is on the diagonal.
                // Two -45 labels clear each other once their anchors are about
                // a line-height apart measured on the diagonal, i.e. sqrt(2)
                // line-heights apart horizontally.
                var need = font * 1.6;
                var keepA = [];
                var lastX = -Infinity;
                for (i = 0; i < n; i++) {
                    if (xs[i] - lastX >= need) { keepA.push(true); lastX = xs[i]; }
                    else { keepA.push(false); }
                }
                for (i = 0; i < n; i++) {
                    if (!keepA[i]) { continue; }
                    var availV = H - baseY - 2;
                    var availX = xs[i] - 2;
                    var diag = Math.max(0, Math.min(availV, availX)) * 1.414;
                    var an = PVX.svg.text(g, 0, 0, truncate(pts[i].label, diag, font), {
                        'class': 'pvx-svg-label pvx-profile-name' + (pts[i].good ? '' : ' pvx-profile-name-bad'),
                        'text-anchor': 'end', 'font-size': font,
                        // Bad quality mutes the name as well as hollowing the
                        // marker, so the pairing is legible without a legend.
                        fill: pts[i].good ? t.textMuted : PVX.color.rgba(t.textMuted, 0.55)
                    });
                    an.setAttribute('transform',
                        'translate(' + xs[i].toFixed(2) + ',' + baseY.toFixed(2) + ') rotate(-45)');
                    // Estimate first (above) so this measurement almost always
                    // confirms rather than corrects — see fitTextTo.
                    fitTextTo(an, diag);
                    PVX.svg.el('title', null, an).textContent = pts[i].label;
                }
                return;
            }

            // Horizontal. Two passes: decide WHICH names survive, then give each
            // survivor the room its surviving NEIGHBOURS actually leave it — a
            // label next to a thinned-out gap may legitimately grow into it.
            var widths = [];
            for (i = 0; i < n; i++) { widths.push(minNeed); }
            var keep = thinLabels(xs, widths, 4);

            var kept = [];
            for (i = 0; i < n; i++) { if (keep[i]) { kept.push(i); } }

            for (var k = 0; k < kept.length; k++) {
                i = kept[k];
                // The outermost names are bounded by the FRAME, not by the plot
                // rectangle: this row sits below the plot, where the y-axis tick
                // labels are not, so a name may legitimately reach out over the
                // left margin instead of being needlessly chopped.
                var left = k > 0 ? xs[i] - xs[kept[k - 1]] : (xs[i] - 2) * 2;
                var right = k < kept.length - 1 ? xs[kept[k + 1]] - xs[i] : (W - 2 - xs[i]) * 2;
                var avail = Math.max(0, Math.min(left, right)) * 0.94;
                if (avail < font * 1.6) { continue; }
                var nt = PVX.svg.text(g, xs[i].toFixed(2), baseY.toFixed(2),
                    truncate(pts[i].label, avail, font), {
                        'class': 'pvx-svg-label pvx-profile-name' + (pts[i].good ? '' : ' pvx-profile-name-bad'),
                        'text-anchor': 'middle', 'font-size': font,
                        fill: pts[i].good ? t.textMuted : PVX.color.rgba(t.textMuted, 0.55)
                    });
                fitTextTo(nt, avail);
                PVX.svg.el('title', null, nt).textContent = pts[i].label;
            }
        }

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);
            // Centre-anchored text spills past BOTH edges once it is wider than
            // the frame, so shrink to fit first and only then truncate. 0.62em
            // rather than 0.58em: this copy is sentence case with wide glyphs.
            var avail = Math.max(24, W - 12);
            var longest = Math.max(String(headline).length, String(detail).length);
            if (longest * font * 0.62 > avail) {
                font = PVX.util.clamp(Math.floor(avail / (longest * 0.62)), 7, font);
            }
            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2),
                headline, {
                    'class': 'pvx-svg-label pvx-profile-emptymsg', 'text-anchor': 'middle',
                    'font-size': font, 'font-weight': '600', fill: t.textMuted
                });
            var sub = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.8).toFixed(2),
                detail, {
                    'class': 'pvx-svg-label pvx-profile-emptymsg', 'text-anchor': 'middle',
                    'font-size': (font * 0.85).toFixed(1), fill: t.textMuted, opacity: '0.85'
                });
            // At most two exact measurements, only when there is nothing to
            // chart — and a centred message poking out of both edges is the most
            // obviously broken thing a symbol can show.
            shrinkToFit(head, avail);
            shrinkToFit(sub, avail);
        }

        /** Theme tokens as CSS custom properties for the Angular-rendered chrome. */
        function applyThemeVars(c, t) {
            var nde = c.node;
            if (!nde || !nde.style || !nde.style.setProperty) { return; }
            nde.style.setProperty('--pvx-text', t.text);
            nde.style.setProperty('--pvx-muted', t.textMuted);
            nde.style.setProperty('--pvx-border', t.border);
            nde.style.setProperty('--pvx-accent', c.config.LineColor || c.config.AccentColor || '#3b82c4');
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
