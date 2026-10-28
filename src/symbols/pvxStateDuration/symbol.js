/* ============================================================================
 * pvxStateDuration — "PVX Time in State"
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (multiple data sources), DataQueryMode: ModeEvents
 *
 * @mock digital
 *
 * The downtime view most sites actually need, built from nothing but digital
 * tags: no Event Frames, no PI Web API, no AF templates. One horizontal bar per
 * tag showing how long it spent in each state across the display window, with a
 * run-time percentage and a transition count.
 *
 * Two modes, because they answer different questions:
 *   timeline — one swimlane per tag, segments at their true position in time.
 *              "When did it stop?"  (the default; it is the more useful one)
 *   stacked  — segments sized by TOTAL time in each state, in a stable state
 *              order. "How much of the shift was it running?"
 *
 * WHY ModeEvents
 * --------------
 * PI Vision's default query modes hand back an interpolated sample grid. Adding
 * up grid samples only ever approximates a duration — a two-minute trip between
 * two grid points either vanishes or is rounded to a whole interval. ModeEvents
 * returns the actual archive transitions, so run lengths are the real thing and
 * the arithmetic here is exact rather than "about right".
 *
 * Everything below `.pvx-state-body` is drawn as ONE imperative SVG. An
 * ng-repeat over rows x segments would put hundreds of watchers into the digest
 * loop of a display that refreshes every few seconds; only the header/footer
 * chrome is Angular-bound.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below this a row carries no legible text and reads as a smear, so we stop
     * adding rows and say how many were left out instead. */
    var MIN_ROW_H = 12;
    var AXIS_H = 14;      // time-axis strip (timeline mode)
    var LEGEND_H = 15;    // legend strip

    var definition = {
        typeName: 'pvxStateDuration',
        displayName: 'PVX Time in State',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // A collection repeats one symbol per element; this symbol already shows
        // many tags side by side, and comparing them is its entire purpose.
        supportsCollections: false,
        configTitle: 'Format Time in State',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                // See the header: transitions, not an interpolated grid. This is
                // what makes the duration arithmetic exact.
                DataQueryMode: 'ModeEvents',
                Height: 220,
                Width: 460,

                Mode: 'timeline',           // timeline | stacked

                // Color: same "key:color" grammar as pvxStatusGrid's state map.
                StateColors: 'Running:#2f9e5f, Stopped:#8a8f96, Stop:#8a8f96, ' +
                    'Idle:#d99024, Fault:#c8452f, Trip:#c8452f, Alarm:#c8452f, ' +
                    'Off:#6f7378, On:#2f9e5f, Open:#2f9e5f, Closed:#8a8f96, ' +
                    'Auto:#3b82c4, Manual:#d99024',

                // Which states count as "up" for the percentage column.
                UptimeStates: 'Running, On, Open, Auto, Energised, Base Load',

                // Columns
                ShowNames: true,
                NameWidthPct: 26,
                ShowUptime: true,
                UptimeMode: 'percent',      // percent | duration | both
                ShowTransitions: false,

                // Rows
                RowHeight: 26,
                AutoRowHeight: true,
                RowGap: 4,
                BarRadius: 2,
                SortBy: 'none',             // none | name | uptimeAsc | uptimeDesc

                // Chrome
                ShowLegend: true,
                ShowTimeAxis: true,         // timeline mode only
                TimeTickCount: 5,
                ShowSegmentLabels: false,
                ShowSummary: true,
                Title: '',
                // Header off by default: at small sizes every pixel belongs to
                // the bars, and the title is redundant with the tag names.
                ShowLabel: false,

                // Sub-pixel segments alias into invisibility; merging keeps a
                // flurry of transitions visible as one mark.
                MinSegmentPx: 1
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the chart itself is SVG.
        scope.pvx = {
            title: '',
            range: '',
            summary: '',
            background: ''
        };

        var series = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-state-body',

            onData: function (d) {
                // stateSeries, never series: data.series() drops every
                // non-numeric sample, which silently empties a tag whose values
                // are "Running" / "Stopped".
                series = PVX.data.stateSeries(d) || [];
            },

            render: render
        });

        /* ------------------------------------------------------------------ *
         * config parsing
         * ------------------------------------------------------------------ */

        /**
         * "Running:#2f9e5f, Fault:#c8452f" — the same key:color grammar as
         * pvxStatusGrid's state map, so an operator only has to learn it once.
         * Matching is exact (after trim + lowercase), never substring: PI
         * digital state sets are closed, and a substring rule would color
         * "Fault Reset" as "Fault".
         */
        var colorCache = { spec: null, map: null };

        function parseStateColors(spec) {
            // Re-parsing per row per frame is pure waste; the spec only changes
            // when someone edits the config pane.
            if (colorCache.spec === spec && colorCache.map) { return colorCache.map; }
            var map = {};
            String(spec === null || spec === undefined ? '' : spec)
                .split(/[,\n;]/)
                .forEach(function (chunk) {
                    var s = chunk.trim();
                    if (!s) { return; }
                    var parts = s.split(':');
                    var key = (parts[0] || '').trim();
                    if (!key) { return; }
                    var col = (parts.slice(1).join(':') || '').trim();
                    if (!col) { return; }
                    map[key.toLowerCase()] = col;
                });
            colorCache.spec = spec;
            colorCache.map = map;
            return map;
        }

        var upCache = { spec: null, set: null };

        /** "Running, On, Open" -> {running:true, on:true, open:true} */
        function parseStateList(spec) {
            if (upCache.spec === spec && upCache.set) { return upCache.set; }
            var set = {};
            String(spec === null || spec === undefined ? '' : spec)
                .split(/[,\n;]/)
                .forEach(function (chunk) {
                    var s = chunk.trim().toLowerCase();
                    if (s) { set[s] = true; }
                });
            upCache.spec = spec;
            upCache.set = set;
            return set;
        }

        /* ------------------------------------------------------------------ *
         * text fitting
         * ------------------------------------------------------------------ *
         * Average-glyph-width heuristic rather than getComputedTextLength():
         * that call flushes pending layout every time, and doing it once per
         * label per render is the classic layout-thrash stall.
         */
        function maxChars(maxW, fontPx) {
            return Math.floor(maxW / (fontPx * 0.55));
        }

        function textW(str, fontPx) {
            return String(str === null || str === undefined ? '' : str).length * fontPx * 0.55;
        }

        function fitText(str, maxW, fontPx) {
            var s = String(str === null || str === undefined ? '' : str);
            var m = maxChars(maxW, fontPx);
            if (m < 1) { return ''; }
            if (s.length <= m) { return s; }
            if (m === 1) { return '…'; }
            return s.slice(0, m - 1) + '…';
        }

        /* ------------------------------------------------------------------ *
         * model
         * ------------------------------------------------------------------ */

        /**
         * Collapse every series into runs over one shared window.
         *
         * The window is taken from the first and last sample across ALL series,
         * because that is the only end-to-end evidence we have of the display's
         * time range: ModeEvents returns transitions, not a grid, so there is no
         * sample at the window edges to read it off. Sharing one window across
         * rows is what makes the bars comparable — a per-tag window would give
         * every tag a different pixel-per-minute scale.
         */
        function buildModel(cfg) {
            var m = {
                rows: [], states: [], byKey: {},
                from: null, to: null, span: 0,
                totalSpan: 0, totalUp: 0, badCount: 0,
                empty: true
            };
            if (!series.length) { return m; }

            var i, j, s;
            var from = null, to = null;
            for (i = 0; i < series.length; i++) {
                s = series[i];
                if (!s.points || !s.points.length) { continue; }
                var f = s.points[0].t;
                var l = s.points[s.points.length - 1].t;
                if (from === null || f < from) { from = f; }
                if (to === null || l > to) { to = l; }
            }
            if (from === null) { return m; }
            // A single sample for every tag leaves no span at all; keep the
            // scale non-degenerate rather than dividing by zero.
            if (!(to > from)) { to = from + 1; }
            m.from = from;
            m.to = to;
            m.span = to - from;

            var upSet = parseStateList(cfg.UptimeStates);

            for (i = 0; i < series.length; i++) {
                s = series[i];
                var r = PVX.data.stateRuns(s.points || [], from, to);
                var runs = [];
                var totals = {};
                var up = 0, covered = 0, transitions = 0;
                var prevKey = null;

                for (j = 0; j < r.runs.length; j++) {
                    var run = r.runs[j];
                    var label = String(run.state === null || run.state === undefined ? '' : run.state).trim();
                    if (!label) { label = 'Unknown'; }
                    var key = label.toLowerCase();
                    // Count real state CHANGES, not run boundaries: PI archives
                    // happily store repeated identical values.
                    if (prevKey !== null && key !== prevKey) { transitions += 1; }
                    prevKey = key;

                    runs.push({
                        key: key, label: label,
                        from: run.from, to: run.to, duration: run.duration
                    });
                    if (totals[key] === undefined) { totals[key] = 0; }
                    totals[key] += run.duration;
                    if (upSet[key]) { up += run.duration; }
                    covered += run.duration;
                }

                if (runs.length) { m.empty = false; }
                if (!s.good) { m.badCount += 1; }

                m.rows.push({
                    series: s,
                    label: s.label || '',
                    runs: runs,
                    totals: totals,
                    // `covered` rather than the window span: a tag whose first
                    // event lands after the window start has no data before it,
                    // and counting that gap as downtime would be a lie.
                    covered: covered,
                    uptime: up,
                    uptimePct: covered > 0 ? (up / covered) * 100 : null,
                    transitions: transitions,
                    good: s.good !== false
                });
            }

            sortRows(m.rows, cfg.SortBy);

            // State registry AFTER sorting, so "first appearance" means first
            // appearance on screen — the palette then matches reading order.
            for (i = 0; i < m.rows.length; i++) {
                var rw = m.rows[i];
                for (j = 0; j < rw.runs.length; j++) {
                    var k = rw.runs[j].key;
                    if (!m.byKey[k]) {
                        m.byKey[k] = { key: k, label: rw.runs[j].label, color: null, total: 0 };
                        m.states.push(m.byKey[k]);
                    }
                    m.byKey[k].total += rw.runs[j].duration;
                }
                m.totalSpan += rw.covered;
                m.totalUp += rw.uptime;
            }
            assignColors(m, cfg);
            return m;
        }

        /**
         * Resolve one color per state: the configured map wins, anything left
         * takes the shared categorical palette in first-appearance order.
         *
         * The configured colors are claimed FIRST, before any palette pick, so
         * an unmapped state never lands on a near-twin of a mapped one. Without
         * that, "Off Line" reliably drew in palette green next to a mapped
         * "Running" green — two states, one apparent color, on the symbol whose
         * entire job is telling running from not running.
         */
        function assignColors(m, cfg) {
            var pal = PVX.color.categorical;
            var map = parseStateColors(cfg.StateColors);
            var used = [];
            var i;

            for (i = 0; i < m.states.length; i++) {
                var mapped = map[m.states[i].key];
                if (mapped) {
                    m.states[i].color = mapped;
                    used.push(mapped);
                }
            }

            var cursor = 0;
            for (i = 0; i < m.states.length; i++) {
                if (m.states[i].color) { continue; }
                var pick = null;
                for (var tries = 0; tries < pal.length; tries++) {
                    var cand = pal[(cursor + tries) % pal.length];
                    if (!confusable(cand, used)) {
                        pick = cand;
                        cursor += tries + 1;
                        break;
                    }
                }
                if (!pick) {
                    // Every palette entry clashes with something already on
                    // screen; cycling is still better than leaving states
                    // uncolored, and the legend disambiguates.
                    pick = pal[cursor % pal.length];
                    cursor += 1;
                }
                m.states[i].color = pick;
                used.push(pick);
            }
        }

        /** Manhattan RGB distance — cheap, and good enough to catch twins. */
        function confusable(c, used) {
            var a = PVX.color.toRgb(c);
            if (!a) { return false; }
            for (var i = 0; i < used.length; i++) {
                var b = PVX.color.toRgb(used[i]);
                if (!b) { continue; }
                if (Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) < 90) {
                    return true;
                }
            }
            return false;
        }

        function sortRows(list, mode) {
            if (mode === 'name') {
                list.sort(function (a, b) {
                    var x = String(a.label).toLowerCase(), y = String(b.label).toLowerCase();
                    return x < y ? -1 : (x > y ? 1 : 0);
                });
            } else if (mode === 'uptimeAsc' || mode === 'uptimeDesc') {
                var dir = mode === 'uptimeAsc' ? 1 : -1;
                list.sort(function (a, b) {
                    // Rows with no coverage carry no ranking information, so
                    // they sink to the bottom whichever way the sort points.
                    if (a.uptimePct === null && b.uptimePct === null) { return 0; }
                    if (a.uptimePct === null) { return 1; }
                    if (b.uptimePct === null) { return -1; }
                    return (a.uptimePct - b.uptimePct) * dir;
                });
            }
            return list;
        }

        /* ------------------------------------------------------------------ *
         * segments
         * ------------------------------------------------------------------ */

        /** Timeline: one segment per run, at its true position in time. */
        function timelineSegments(row, xScale, x0, x1) {
            var segs = [];
            for (var i = 0; i < row.runs.length; i++) {
                var r = row.runs[i];
                var a = PVX.util.clamp(xScale(r.from), x0, x1);
                var b = PVX.util.clamp(xScale(r.to), x0, x1);
                if (b <= a) { b = a; }
                segs.push({
                    key: r.key, label: r.label,
                    x0: a, x1: b,
                    from: r.from, to: r.to,
                    duration: r.duration, merged: 0
                });
            }
            return segs;
        }

        /**
         * Stacked: one segment per state, sized by TOTAL time in that state and
         * laid out in the shared state order. The shared order is the point of
         * the mode — if each bar ordered its own states, the same color would
         * sit in a different place on every row and the bars could not be
         * compared, which is the only reason to stack them.
         */
        function stackedSegments(row, states, x0, x1) {
            var segs = [];
            var w = x1 - x0;
            if (!(row.covered > 0) || !(w > 0)) { return segs; }
            var acc = 0;
            var cursor = x0;
            for (var i = 0; i < states.length; i++) {
                var key = states[i].key;
                var d = row.totals[key];
                if (!d) { continue; }
                acc += d;
                // Position from the running total, not by adding widths, so
                // rounding never drifts and the last segment lands on the edge.
                var next = x0 + (acc / row.covered) * w;
                segs.push({
                    key: key, label: states[i].label,
                    x0: cursor, x1: next,
                    from: null, to: null,
                    duration: d, merged: 0
                });
                cursor = next;
            }
            if (segs.length) { segs[segs.length - 1].x1 = x1; }
            return segs;
        }

        /**
         * Fold sub-minimum segments into a neighbour.
         *
         * A tag that chatters between Running and Fault for ten seconds produces
         * segments a fraction of a pixel wide. Drawn as-is they either disappear
         * or alias into a dirty smear that reads as a solid color; absorbed
         * into the neighbour they at least leave the neighbour's length honest
         * and the tooltip records how many runs were swallowed.
         */
        function mergeSegments(segs, minPx) {
            if (!(minPx > 0) || segs.length < 2) { return segs; }
            var out = [];
            for (var i = 0; i < segs.length; i++) {
                var s = segs[i];
                var prev = out.length ? out[out.length - 1] : null;
                if ((s.x1 - s.x0) < minPx && prev) {
                    prev.x1 = s.x1;
                    prev.to = s.to;
                    prev.duration += s.duration;
                    prev.merged += 1 + s.merged;
                    continue;
                }
                out.push(s);
            }
            // A thin FIRST segment has no predecessor to absorb it, so fold it
            // forward instead of leaving a sliver at the left edge.
            if (out.length > 1 && (out[0].x1 - out[0].x0) < minPx) {
                out[1].x0 = out[0].x0;
                out[1].from = out[0].from;
                out[1].duration += out[0].duration;
                out[1].merged += 1 + out[0].merged;
                out.shift();
            }
            return out;
        }

        /**
         * Rounded-end bar segment. Radii are per-side so only the two ends of a
         * bar are rounded and the joins between segments stay square — rounding
         * every segment would leave light gaps down the middle of the bar.
         */
        function segPath(x, y, w, h, rl, rr) {
            rl = Math.max(0, Math.min(rl, w / 2, h / 2));
            rr = Math.max(0, Math.min(rr, w / 2, h / 2));
            var f = function (n) { return n.toFixed(2); };
            if (rl < 0.05 && rr < 0.05) {
                return 'M' + f(x) + ' ' + f(y) + ' h' + f(w) + ' v' + f(h) + ' h' + f(-w) + ' Z';
            }
            var d = 'M' + f(x + rl) + ' ' + f(y) + ' h' + f(w - rl - rr);
            if (rr >= 0.05) { d += ' a' + f(rr) + ' ' + f(rr) + ' 0 0 1 ' + f(rr) + ' ' + f(rr); }
            d += ' v' + f(h - 2 * rr);
            if (rr >= 0.05) { d += ' a' + f(rr) + ' ' + f(rr) + ' 0 0 1 ' + f(-rr) + ' ' + f(rr); }
            d += ' h' + f(-(w - rl - rr));
            if (rl >= 0.05) { d += ' a' + f(rl) + ' ' + f(rl) + ' 0 0 1 ' + f(-rl) + ' ' + f(-rl); }
            d += ' v' + f(-(h - 2 * rl));
            if (rl >= 0.05) { d += ' a' + f(rl) + ' ' + f(rl) + ' 0 0 1 ' + f(rl) + ' ' + f(-rl); }
            return d + ' Z';
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
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            var W = Math.max(40, host.clientWidth || c.width || 40);
            var H = Math.max(20, host.clientHeight || c.height || 20);

            var svgRoot = host.querySelector('svg.pvx-state-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-state-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            // Rows must keep their true pixel height, so no aspect fitting.
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var model = buildModel(cfg);

            // ---- chrome -------------------------------------------------------
            scope.pvx.title = String(cfg.Title || '').trim();
            scope.pvx.range = model.from === null ? '' :
                (PVX.fmt.time(model.from, 'short') + ' – ' + PVX.fmt.time(model.to, 'short'));
            scope.pvx.summary = (cfg.ShowSummary !== false && !model.empty && model.totalSpan > 0)
                ? summaryText(model)
                : '';

            if (model.empty) {
                emptyState(svgRoot, W, H, t,
                    series.length ? 'No state transitions in this window' : 'No data sources configured');
                digest();
                return;
            }

            var mode = cfg.Mode === 'stacked' ? 'stacked' : 'timeline';

            // ---- vertical budget ----------------------------------------------
            // Legend goes first when the box is short, then the axis: a bar with
            // no legend still reads; a legend with no bars does not.
            var legendH = (cfg.ShowLegend !== false && model.states.length) ? LEGEND_H : 0;
            var axisH = (mode === 'timeline' && cfg.ShowTimeAxis !== false) ? AXIS_H : 0;
            // A legend narrow enough to show one state out of fifteen, or one
            // that costs a quarter of the rows, is worse than no legend.
            if (W < 150 || H - legendH - axisH < MIN_ROW_H * 4) { legendH = 0; }
            if (H - axisH < MIN_ROW_H * 2) { axisH = 0; }
            var rowsH = Math.max(MIN_ROW_H, H - legendH - axisH);

            // ---- horizontal budget ---------------------------------------------
            var padX = 8;
            var colGap = 6;
            var contentW = Math.max(20, W - padX * 2);

            var rowPitch = rowHeight(cfg, rowsH, model.rows.length);
            var capacity = Math.max(1, Math.floor(rowsH / rowPitch));
            var drawCount = model.rows.length;
            var overflow = 0;
            if (model.rows.length > capacity) {
                // Spend one row on the "+N more" notice so the count is honest.
                drawCount = Math.max(0, capacity - 1);
                overflow = model.rows.length - drawCount;
            }
            var view = model.rows.slice(0, drawCount);

            var nameFont = PVX.util.clamp(rowPitch * 0.46, 8, 12.5);
            var valFont = PVX.util.clamp(rowPitch * 0.44, 8, 12);

            var nameW = cfg.ShowNames !== false
                ? contentW * (PVX.util.clamp(PVX.util.num(cfg.NameWidthPct) || 0, 0, 60) / 100)
                : 0;

            // Right-hand columns are sized to their widest actual string, so the
            // bars never give up space to an empty gutter.
            var upTexts = [], trTexts = [];
            var i;
            for (i = 0; i < view.length; i++) {
                upTexts.push(uptimeText(view[i], cfg));
                trTexts.push(String(view[i].transitions));
            }
            var upW = (cfg.ShowUptime !== false) ? colWidth(upTexts, valFont, contentW * 0.34) : 0;
            var trW = cfg.ShowTransitions ? colWidth(trTexts, valFont, contentW * 0.16) : 0;

            var gaps = (nameW > 0 ? colGap : 0) + (upW > 0 ? colGap : 0) + (trW > 0 ? colGap : 0);

            // The bar is the symbol; if the columns would squeeze it below a
            // third of the width, shrink them proportionally instead.
            var minBar = contentW * 0.33;
            var used = nameW + upW + trW;
            if (contentW - gaps - used < minBar && used > 0) {
                var room = Math.max(0, contentW - gaps - minBar);
                var shrink = room / used;
                nameW *= shrink; upW *= shrink; trW *= shrink;
            }

            var barX = padX + nameW + (nameW > 0 ? colGap : 0);
            var barW = Math.max(6, contentW - nameW - upW - trW - gaps);
            var upX = padX + contentW - trW - (trW > 0 ? colGap : 0);
            var trX = padX + contentW;

            var xScale = PVX.scale.linear(model.from, model.to, barX, barX + barW);

            // Reserve the bad-quality gutter for every row when ANY row is bad,
            // so names stay left-aligned instead of jumping column to column.
            var anyBad = false;
            for (i = 0; i < view.length; i++) {
                if (!view[i].good) { anyBad = true; break; }
            }
            var badGutter = anyBad ? 9 : 0;

            var minPx = PVX.util.clamp(PVX.util.num(cfg.MinSegmentPx) === null ? 1 : PVX.util.num(cfg.MinSegmentPx), 0, 40);
            var radius = PVX.util.clamp(PVX.util.num(cfg.BarRadius) === null ? 2 : PVX.util.num(cfg.BarRadius), 0, 20);
            var gapY = PVX.util.clamp(PVX.util.num(cfg.RowGap) === null ? 4 : PVX.util.num(cfg.RowGap), 0, 20);

            // ---- axis first: its grid lines belong behind the bars -------------
            // The axis follows the last row rather than sitting at the bottom of
            // the box: with a capped auto row height the rows may not fill the
            // area, and an axis floating away from the bars it scales reads as
            // belonging to nothing.
            var rowsUsed = Math.min(rowsH, (drawCount + (overflow > 0 ? 1 : 0)) * rowPitch);
            if (axisH > 0) {
                drawTimeAxis(svgRoot, model, cfg, t, {
                    barX: barX, barW: barW, top: rowsUsed, height: axisH,
                    rowsTop: 0, rowsBottom: rowsUsed
                });
            }

            // ---- rows ------------------------------------------------------------
            for (i = 0; i < view.length; i++) {
                drawRow(svgRoot, view[i], {
                    cfg: cfg, theme: t, mode: mode, model: model,
                    y: i * rowPitch, pitch: rowPitch, gapY: gapY,
                    padX: padX, W: W, badGutter: badGutter,
                    nameW: nameW, nameFont: nameFont, valFont: valFont,
                    barX: barX, barW: barW, upX: upX, upW: upW, trX: trX, trW: trW,
                    upText: upTexts[i], xScale: xScale,
                    minPx: minPx, radius: radius
                });
            }

            // ---- overflow notice --------------------------------------------------
            if (overflow > 0) {
                var fy = drawCount * rowPitch + Math.min(rowPitch, rowsH - drawCount * rowPitch) / 2;
                PVX.svg.text(svgRoot, padX, fy.toFixed(1), '+' + overflow + ' more', {
                    'class': 'pvx-state-more',
                    'font-size': PVX.util.clamp(rowPitch * 0.42, 8, 11).toFixed(1),
                    fill: t.textMuted
                });
            }

            // ---- legend ------------------------------------------------------------
            if (legendH > 0) {
                drawLegend(svgRoot, model, t, padX, H - legendH, W - padX * 2, legendH);
            }

            digest();
        }

        /** Widest string in the column, plus breathing room, capped. */
        function colWidth(texts, font, cap) {
            var w = 0;
            for (var i = 0; i < texts.length; i++) {
                var x = textW(texts[i], font);
                if (x > w) { w = x; }
            }
            return Math.min(w + 4, Math.max(18, cap));
        }

        /**
         * Row pitch, honouring the auto/fixed switch. Auto is capped: a single
         * tag in a tall symbol should not become one 400px-tall slab.
         */
        function rowHeight(cfg, availH, count) {
            var fixed = PVX.util.num(cfg.RowHeight) || 26;
            var auto = cfg.AutoRowHeight !== false;
            var h = auto ? Math.min(availH / Math.max(1, count), Math.max(fixed, 20) * 3) : fixed;
            return Math.max(MIN_ROW_H, h);
        }

        function uptimeText(row, cfg) {
            if (row.uptimePct === null) { return '--'; }
            var mode = cfg.UptimeMode || 'percent';
            var pct = PVX.fmt.percent(row.uptimePct, row.uptimePct >= 99.95 || row.uptimePct === 0 ? 0 : 1);
            var dur = PVX.fmt.duration(row.uptime);
            if (mode === 'duration') { return dur; }
            if (mode === 'both') { return pct + ' · ' + dur; }
            return pct;
        }

        /**
         * Overall uptime is time-weighted across every configured tag, not the
         * mean of the per-row percentages: a tag with two minutes of data must
         * not carry the same weight as one with the full shift.
         *
         * Bad-quality sources are called out here rather than with the shared
         * corner badge, which would sit on top of the first row's percentage.
         */
        function summaryText(model) {
            var pct = (model.totalUp / model.totalSpan) * 100;
            return 'Uptime ' + PVX.fmt.percent(pct, 1) +
                ' across ' + model.rows.length + (model.rows.length === 1 ? ' tag' : ' tags') +
                ' · ' + PVX.fmt.duration(model.span) + ' window' +
                (model.badCount ? ' · ' + model.badCount + ' bad quality' : '');
        }

        /* ------------------------------------------------------------------ *
         * row drawing
         * ------------------------------------------------------------------ */
        function drawRow(svgRoot, row, L) {
            var cfg = L.cfg, t = L.theme;

            var g = PVX.svg.el('g', { 'class': 'pvx-state-row' }, svgRoot);
            // Bad quality dims the row rather than recoloring it: the state
            // colors still mean what they mean, they just should not command
            // attention while the tag is untrustworthy.
            if (!row.good) { g.setAttribute('opacity', '0.5'); }

            var barH = Math.max(4, L.pitch - L.gapY);
            var barY = L.y + (L.pitch - barH) / 2;
            var midY = L.y + L.pitch / 2;

            // ---- track --------------------------------------------------------
            // Drawn under the segments so a tag whose events start late shows the
            // uncovered stretch as an empty channel, not as a state.
            PVX.svg.el('path', {
                d: segPath(L.barX, barY, L.barW, barH, L.radius, L.radius),
                fill: t.track,
                'class': 'pvx-state-track'
            }, g);

            // ---- segments -------------------------------------------------------
            var segs = L.mode === 'stacked'
                ? stackedSegments(row, L.model.states, L.barX, L.barX + L.barW)
                : timelineSegments(row, L.xScale, L.barX, L.barX + L.barW);
            segs = mergeSegments(segs, L.minPx);

            var labelFont = PVX.util.clamp(barH * 0.5, 7.5, 11);
            for (var i = 0; i < segs.length; i++) {
                var s = segs[i];
                var w = s.x1 - s.x0;
                if (w <= 0) { continue; }
                var st = L.model.byKey[s.key];
                var col = st ? st.color : PVX.color.status.unknown;
                var rl = (i === 0) ? L.radius : 0;
                var rr = (i === segs.length - 1) ? L.radius : 0;

                // Hairline in the surface color so two neighbouring greys read
                // as two runs — but only on segments wide enough to spare it.
                // A 0.5px stroke on a 1px segment IS the segment, which would
                // erase exactly the brief trips that matter most.
                var edged = w >= 4 && !cfg.Transparent;
                var p = PVX.svg.el('path', {
                    d: segPath(s.x0, barY, w, barH, rl, rr),
                    fill: col,
                    stroke: edged ? t.surface : 'none',
                    'stroke-width': edged ? 0.6 : null,
                    'class': 'pvx-state-seg'
                }, g);
                var title = PVX.svg.el('title', null, p);
                title.textContent = segTitle(row, s, L);

                if (cfg.ShowSegmentLabels && barH >= 11) {
                    // Only when the whole name fits: a state truncated to "Ru…"
                    // inside a colored block is noise, not information.
                    var need = textW(s.label, labelFont) + 8;
                    if (w >= need) {
                        PVX.svg.text(g, (s.x0 + w / 2).toFixed(1), midY.toFixed(1), s.label, {
                            'class': 'pvx-state-seglabel',
                            'text-anchor': 'middle',
                            'font-size': labelFont.toFixed(1),
                            fill: PVX.color.readable(col)
                        });
                    }
                }
            }

            // ---- name column ------------------------------------------------------
            if (cfg.ShowNames !== false && L.nameW > 2) {
                if (!row.good) {
                    PVX.svg.el('circle', {
                        cx: (L.padX + 3).toFixed(1), cy: midY.toFixed(1), r: 2.6,
                        fill: PVX.color.status.alarm,
                        'class': 'pvx-state-bad'
                    }, g);
                }
                var nameNode = PVX.svg.text(g, (L.padX + L.badGutter).toFixed(1), midY.toFixed(1),
                    fitText(row.label, L.nameW - L.badGutter, L.nameFont), {
                        'class': 'pvx-state-name',
                        'font-size': L.nameFont.toFixed(1),
                        fill: t.text
                    });
                // Full path on hover — a truncated name rarely tells two
                // attributes of two assets apart.
                var nt = PVX.svg.el('title', null, nameNode);
                nt.textContent = (row.series.path ? row.label + '\n' + row.series.path : row.label) +
                    (row.good ? '' : '\n' + (row.series.errorDescription || 'Bad quality'));
            }

            // ---- uptime column -----------------------------------------------------
            if (cfg.ShowUptime !== false && L.upW > 2) {
                var upNode = PVX.svg.text(g, L.upX.toFixed(1), midY.toFixed(1),
                    fitText(L.upText, L.upW, L.valFont), {
                        'class': 'pvx-state-uptime pvx-num',
                        'text-anchor': 'end',
                        'font-size': L.valFont.toFixed(1),
                        fill: t.text
                    });
                var ut = PVX.svg.el('title', null, upNode);
                ut.textContent = 'Uptime ' + PVX.fmt.duration(row.uptime) +
                    ' of ' + PVX.fmt.duration(row.covered) +
                    (row.uptimePct === null ? '' : ' (' + PVX.fmt.percent(row.uptimePct, 1) + ')');
            }

            // ---- transition column --------------------------------------------------
            if (cfg.ShowTransitions && L.trW > 2) {
                var trNode = PVX.svg.text(g, L.trX.toFixed(1), midY.toFixed(1),
                    String(row.transitions), {
                        'class': 'pvx-state-trans pvx-num',
                        'text-anchor': 'end',
                        'font-size': L.valFont.toFixed(1),
                        fill: t.textMuted
                    });
                var tt = PVX.svg.el('title', null, trNode);
                tt.textContent = row.transitions + (row.transitions === 1 ? ' transition' : ' transitions');
            }
        }

        function segTitle(row, s, L) {
            var head = row.label + '\n' + s.label + '\n';
            var tail = s.merged ? '\n+' + s.merged + ' brief run' + (s.merged === 1 ? '' : 's') + ' merged' : '';
            if (L.mode === 'stacked') {
                var pct = row.covered > 0 ? (s.duration / row.covered) * 100 : 0;
                return head + 'Total ' + PVX.fmt.duration(s.duration) +
                    ' (' + PVX.fmt.percent(pct, 1) + ')\nfrom ' + PVX.fmt.time(L.model.from, 'datetime') + tail;
            }
            return head + PVX.fmt.time(s.from, 'datetime') +
                '\nfor ' + PVX.fmt.duration(s.duration) + tail;
        }

        /* ------------------------------------------------------------------ *
         * time axis (timeline mode)
         * ------------------------------------------------------------------ *
         * One axis shared by every row: the rows are swimlanes over the same
         * window, so per-row axes would only repeat the same numbers.
         */
        function drawTimeAxis(svgRoot, model, cfg, t, A) {
            var g = PVX.svg.el('g', { 'class': 'pvx-state-axis' }, svgRoot);
            var font = 9;

            // Thin the ticks to what the labels can occupy without colliding —
            // "08/07 14:12" needs about 40px, and overlapping timestamps are
            // worse than fewer of them.
            var want = Math.round(PVX.util.clamp(PVX.util.num(cfg.TimeTickCount) || 5, 2, 12));
            // ~90px per interval: a "08/07 14:12" label is about 55px, the end
            // labels are anchored inward (so their centres sit half a label from
            // the edge), and the neighbouring centred label must still clear
            // them. Fewer, readable ticks beat five overlapping ones.
            var fit = Math.floor(A.barW / 90) + 1;
            var n = Math.max(2, Math.min(want, fit));

            // Below the mid-line, to clear the stub ticks drawn from the axis.
            var y = A.top + A.height * 0.62;
            PVX.svg.el('line', {
                x1: A.barX.toFixed(1), y1: A.top.toFixed(1),
                x2: (A.barX + A.barW).toFixed(1), y2: A.top.toFixed(1),
                stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, g);

            if (A.barW < 60) { return; }   // no room for even two labels

            var last = null;
            for (var i = 0; i < n; i++) {
                var f = i / (n - 1);
                var x = A.barX + f * A.barW;
                var ms = model.from + f * model.span;
                var label = PVX.fmt.time(ms, 'short');

                // Interior gridlines run up behind the rows so an operator can
                // read a stop time off the bar without a ruler.
                if (i > 0 && i < n - 1 && A.rowsBottom > A.rowsTop) {
                    PVX.svg.el('line', {
                        x1: x.toFixed(1), y1: A.rowsTop.toFixed(1),
                        x2: x.toFixed(1), y2: A.rowsBottom.toFixed(1),
                        stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-grid-line'
                    }, g);
                }

                // A stub tick anchors the label to a position on the bar; the
                // gridline above is invisible wherever a segment covers it.
                PVX.svg.el('line', {
                    x1: x.toFixed(1), y1: A.top.toFixed(1),
                    x2: x.toFixed(1), y2: (A.top + 3).toFixed(1),
                    stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
                }, g);

                // A window shorter than the label's own resolution (minutes)
                // would otherwise print the same timestamp five times.
                if (label === last) { continue; }
                last = label;

                // End labels are anchored inward so they never clip the box.
                var anchor = i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle');
                PVX.svg.text(g, x.toFixed(1), y.toFixed(1), label, {
                    'class': 'pvx-svg-label pvx-state-tick',
                    'text-anchor': anchor,
                    'font-size': font,
                    fill: t.textMuted
                });
            }
        }

        /* ------------------------------------------------------------------ *
         * legend
         * ------------------------------------------------------------------ *
         * Totals span every configured tag, not just the rows that fit, so the
         * legend agrees with the summary footer rather than with the viewport.
         */
        function drawLegend(svgRoot, model, t, x0, y0, maxW, h) {
            var g = PVX.svg.el('g', { 'class': 'pvx-state-legend' }, svgRoot);
            var font = 9.5;
            var sw = 8;
            var midY = y0 + h / 2;
            var x = x0;
            var shown = 0;

            for (var i = 0; i < model.states.length; i++) {
                var st = model.states[i];
                var text = st.label + ' ' + PVX.fmt.duration(st.total, { parts: 1 });
                var w = sw + 3 + textW(text, font) + 10;
                // Keep room for a "+N" marker unless this is the last item.
                var reserve = (i === model.states.length - 1) ? 0 : 22;
                if (x + w + reserve > x0 + maxW) { break; }

                PVX.svg.el('rect', {
                    x: x.toFixed(1), y: (midY - sw / 2).toFixed(1),
                    width: sw, height: sw, rx: 2,
                    fill: st.color, 'class': 'pvx-state-swatch'
                }, g);
                PVX.svg.text(g, (x + sw + 3).toFixed(1), midY.toFixed(1), text, {
                    'class': 'pvx-svg-label pvx-state-legend-text',
                    'font-size': font,
                    fill: t.textMuted
                });
                x += w;
                shown += 1;
            }

            var rest = model.states.length - shown;
            if (rest > 0) {
                // Start-anchored at the cursor, not end-anchored at the right
                // edge: the reserve above guarantees the room, and anchoring to
                // the edge would print "+12" on top of the last entry whenever
                // the legend does not reach the edge.
                PVX.svg.text(g, x.toFixed(1), midY.toFixed(1), '+' + rest, {
                    'class': 'pvx-svg-label pvx-state-legend-more',
                    'font-size': font,
                    fill: t.textMuted
                });
            }
        }

        /* ------------------------------------------------------------------ *
         * empty state
         * ------------------------------------------------------------------ */
        function emptyState(svgRoot, W, H, t, message) {
            PVX.svg.text(svgRoot, (W / 2).toFixed(1), (H / 2).toFixed(1), message, {
                'class': 'pvx-svg-label pvx-state-empty',
                'text-anchor': 'middle',
                'font-size': PVX.util.clamp(W / 26, 9, 12).toFixed(1),
                fill: t.textMuted
            });
        }

        /** Theme tokens as CSS custom properties for styles.css / ng-style. */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', c.config.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
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
