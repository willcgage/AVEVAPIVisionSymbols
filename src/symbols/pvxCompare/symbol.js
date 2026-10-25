/* ============================================================================
 * pvxCompare — "PVX Condition Compare"
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (multiple data sources)
 *
 * The question this symbol answers is "what is DIFFERENT about the bad hours".
 * Yield dropped, the compressor tripped, the kiln ran hot: an engineer's next
 * move is to pull twenty related tags into Excel, split the rows by "was the
 * condition true", and compare. This does that on the display.
 *
 * One data source is the CONDITION tag (the first, by default) and a rule on
 * it — "> 92", "between 40 and 60" — splits the display's time range into the
 * time the rule held (the selection) and the rest (the baseline). Every other
 * tag gets one row: its distribution during the selection drawn over its
 * distribution during the baseline, and the rows are RANKED by how far apart
 * the two are. The tag at the top is the one that behaves most differently
 * when the condition holds, which is where to look first.
 *
 * The idea is Honeycomb's BubbleUp, adapted to process data. Two things had
 * to change on the way:
 *
 *   TIME, NOT SAMPLES. Plot values crowd into upsets and thin out in steady
 *   running, so comparing the raw samples would over-weight exactly the
 *   periods of interest. Every tag is instead read at the same N evenly spaced
 *   instants (linear interpolation, as PI itself interpolates analog values),
 *   which makes every comparison time-weighted and every tag aligned with the
 *   condition at the same moments.
 *
 *   A RANKING. The ranking score is the Kolmogorov-Smirnov distance: the
 *   largest gap between the two cumulative distributions, 0 (identical) to 1
 *   (no overlap at all). It needs no assumption about the shape of either
 *   distribution, is unit-free so a temperature and a flow rank on the same
 *   scale, and reads in words: "at some value, 62% more of the selection than
 *   of the baseline sat below it".
 *
 * This is correlation, not cause. A tag that differs during the selection may
 * be the cause, a consequence, or a third thing's twin. The footer says so,
 * because a ranked list looks more authoritative than it is.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below this many instants on either side, a distribution is a handful of
     * points and its shape is mostly noise. The rows still draw — hiding them
     * would hide the condition's rarity too — but the footer says so. */
    var THIN_SAMPLES = 20;

    var definition = {
        typeName: 'pvxCompare',
        displayName: 'PVX Condition Compare',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        // Positional config, renumbered when a data source is removed.
        sourceRemap: { ConditionSource: 'index' },
        visObjectType: symbolVis,
        // A collection repeats the symbol per asset; the comparison is between
        // tags inside ONE symbol, so a collection of them would compare nothing
        // to anything new.
        supportsCollections: false,
        configTitle: 'Format Condition Compare',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 400,
                Height: 300,
                Width: 460,

                Title: '',

                /* -- the condition ------------------------------------------ */
                ConditionSource: 1,          // 1-based position in the data source list
                ConditionOp: 'gt',           // gt | lt | between | outside
                ConditionValue: '',          // blank => the condition tag's 90th percentile
                ConditionValue2: '',         // upper bound for between / outside

                /* -- the comparison ----------------------------------------- */
                SampleCount: 400,            // aligned instants across the range
                Bins: 16,
                SortBy: 'difference',        // difference | display
                MaxRows: 12,

                /* -- colour ------------------------------------------------- */
                SelectionColor: '#d99024',
                BaselineColor: '',           // blank => AccentColor

                ShowMedians: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            title: '',
            subtitle: '',
            note: '',
            count: '',
            error: '',
            background: ''
        };

        var seriesList = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-cmp-body',
            onData: function (d) { seriesList = PVX.data.series(d) || []; },
            render: render
        });

        /* ================================================================ *
         * Pure helpers
         * ================================================================ */

        function intIn(v, lo, hi, fallback) {
            var n = parseInt(v, 10);
            if (!isFinite(n)) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        /**
         * Value of a series at time t, linearly interpolated between its two
         * neighbouring points. Null outside the series' own span: a tag with
         * no data at an instant has no value there, and inventing one by
         * holding the edge value would put fake mass at the edge of its
         * distribution.
         */
        function makeReader(points) {
            var n = points.length;
            var lastIdx = 0;
            return function (t) {
                if (!n || t < points[0].t || t > points[n - 1].t) { return null; }
                // Instants arrive in increasing order, so a forward walk from
                // the last position is O(1) amortised — no search needed.
                if (points[lastIdx].t > t) { lastIdx = 0; }
                while (lastIdx + 1 < n && points[lastIdx + 1].t < t) { lastIdx++; }
                var a = points[lastIdx];
                var b = lastIdx + 1 < n ? points[lastIdx + 1] : a;
                if (b.t === a.t) { return a.v; }
                return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t));
            };
        }

        function sortNum(arr) {
            return arr.slice().sort(function (a, b) { return a - b; });
        }

        function median(sorted) {
            var n = sorted.length;
            if (!n) { return null; }
            var mid = (n - 1) / 2;
            var lo = Math.floor(mid), hi = Math.ceil(mid);
            return (sorted[lo] + sorted[hi]) / 2;
        }

        /** Two-sample Kolmogorov-Smirnov distance between sorted arrays. */
        function ksDistance(a, b) {
            var i = 0, j = 0, d = 0;
            var na = a.length, nb = b.length;
            if (!na || !nb) { return 0; }
            while (i < na && j < nb) {
                // Step past every copy of the smaller value on both sides
                // together, or ties would open a gap that is not there.
                var v = a[i] < b[j] ? a[i] : b[j];
                while (i < na && a[i] === v) { i++; }
                while (j < nb && b[j] === v) { j++; }
                var gap = Math.abs(i / na - j / nb);
                if (gap > d) { d = gap; }
            }
            return d;
        }

        /** Fractions per bin, so two groups of different size share a scale. */
        function binFractions(sorted, lo, hi, nBins) {
            var out = [], i;
            for (i = 0; i < nBins; i++) { out.push(0); }
            if (!sorted.length) { return out; }
            var w = (hi - lo) / nBins;
            for (i = 0; i < sorted.length; i++) {
                var k = w > 0 ? Math.floor((sorted[i] - lo) / w) : 0;
                out[PVX.util.clamp(k, 0, nBins - 1)] += 1;
            }
            for (i = 0; i < nBins; i++) { out[i] /= sorted.length; }
            return out;
        }

        function opText(cfg, v1, v2) {
            var a = PVX.fmt.tick(v1), b = PVX.fmt.tick(v2);
            switch (cfg.ConditionOp) {
                case 'lt': return '< ' + a;
                case 'between': return a + ' – ' + b;
                case 'outside': return 'outside ' + a + ' – ' + b;
                default: return '> ' + a;
            }
        }

        function makeTest(cfg, v1, v2) {
            var lo = Math.min(v1, v2), hi = Math.max(v1, v2);
            switch (cfg.ConditionOp) {
                case 'lt': return function (v) { return v < v1; };
                case 'between': return function (v) { return v >= lo && v <= hi; };
                case 'outside': return function (v) { return v < lo || v > hi; };
                default: return function (v) { return v > v1; };
            }
        }

        /* ================================================================ *
         * Model — pure: series + config -> rows, notes
         * ================================================================ */

        function buildModel(cfg) {
            var m = {
                ok: false, message: '', detail: '',
                rows: [], notes: [], excluded: [],
                cond: null, condText: '', selShare: 0, selMs: 0,
                nSel: 0, nBase: 0
            };

            if (!seriesList.length) { m.message = 'No data sources'; return m; }

            var ci = intIn(cfg.ConditionSource, 1, 999, 1) - 1;
            if (ci >= seriesList.length) {
                m.message = 'Condition source ' + (ci + 1) + ' is not on this symbol';
                m.detail = 'It has ' + seriesList.length + ' data source' +
                    (seriesList.length === 1 ? '' : 's') + '. Set the condition source in the format pane.';
                return m;
            }
            var cond = seriesList[ci];
            m.cond = cond;
            if (cond.points.length < 2) {
                m.message = 'No values for ' + cond.label + ' in this time range';
                return m;
            }
            if (seriesList.length < 2) {
                m.message = 'Add the tags to compare';
                m.detail = 'The condition tag splits the time; every OTHER data source is compared.';
                return m;
            }

            var t0 = cond.points[0].t, t1 = cond.points[cond.points.length - 1].t;
            if (!(t1 > t0)) { m.message = 'Not enough time in range to compare'; return m; }

            var nS = intIn(cfg.SampleCount, 50, 5000, 400);
            var step = (t1 - t0) / nS;
            var times = [], i;
            // Mid-points of N equal slices: no instant sits exactly on an edge,
            // where only one of two series might happen to have a value.
            for (i = 0; i < nS; i++) { times.push(t0 + (i + 0.5) * step); }

            var readCond = makeReader(cond.points);
            var condVals = [];
            for (i = 0; i < nS; i++) { condVals.push(readCond(times[i])); }

            var v1 = PVX.util.num(cfg.ConditionValue);
            var v2 = PVX.util.num(cfg.ConditionValue2);
            var defaulted = false;
            if (v1 === null) {
                // No rule typed yet: "the top 10% of the time" is the most
                // common first question and gives a working chart on drop.
                var present = [];
                for (i = 0; i < nS; i++) { if (condVals[i] !== null) { present.push(condVals[i]); } }
                v1 = PVX.stats.percentile(present, cfg.ConditionOp === 'lt' ? 0.1 : 0.9);
                defaulted = true;
            }
            if ((cfg.ConditionOp === 'between' || cfg.ConditionOp === 'outside') && v2 === null) {
                m.message = 'The condition needs an upper bound';
                m.detail = '"' + (cfg.ConditionOp === 'between' ? 'Between' : 'Outside') +
                    '" compares against a range; set the second value in the format pane.';
                return m;
            }
            if (v2 === null) { v2 = v1; }
            var test = makeTest(cfg, v1, v2);

            var inSel = [];
            for (i = 0; i < nS; i++) {
                var cv = condVals[i];
                inSel.push(cv === null ? null : test(cv));
                if (cv === null) { continue; }
                if (inSel[i]) { m.nSel++; } else { m.nBase++; }
            }
            m.condText = cond.label + ' ' + opText(cfg, v1, v2) + (cond.units ? ' ' + cond.units : '') +
                (defaulted ? (cfg.ConditionOp === 'lt' ? ' (bottom 10%)' : ' (top 10%)') : '');
            m.selShare = (m.nSel + m.nBase) ? m.nSel / (m.nSel + m.nBase) : 0;
            m.selMs = m.nSel * step;

            if (!m.nSel) {
                m.message = 'The condition never held in this range';
                m.detail = m.condText + ' was not true at any point. Widen the time range or change the rule.';
                return m;
            }
            if (!m.nBase) {
                m.message = 'The condition held for the whole range';
                m.detail = 'There is no "otherwise" to compare against. Widen the time range or tighten the rule.';
                return m;
            }

            var nBins = intIn(cfg.Bins, 4, 60, 16);
            for (var s = 0; s < seriesList.length; s++) {
                if (s === ci) { continue; }
                var ser = seriesList[s];
                if (!ser.good) { m.excluded.push(ser.label + ' (bad quality)'); continue; }
                if (ser.points.length < 2) { m.excluded.push(ser.label + ' (no numeric values)'); continue; }

                var read = makeReader(ser.points);
                var sel = [], base = [];
                for (i = 0; i < nS; i++) {
                    if (inSel[i] === null) { continue; }
                    var v = read(times[i]);
                    if (v === null) { continue; }
                    (inSel[i] ? sel : base).push(v);
                }
                if (sel.length < 2 || base.length < 2) {
                    m.excluded.push(ser.label + ' (no overlap with the condition tag)');
                    continue;
                }
                sel = sortNum(sel);
                base = sortNum(base);
                var lo = Math.min(sel[0], base[0]);
                var hi = Math.max(sel[sel.length - 1], base[base.length - 1]);
                if (!(hi > lo)) { hi = lo + (Math.abs(lo) * 0.01 || 1); }
                m.rows.push({
                    index: s,
                    label: ser.label,
                    units: ser.units || '',
                    path: ser.path || ser.label,
                    d: ksDistance(sel, base),
                    selMed: median(sel), baseMed: median(base),
                    selN: sel.length, baseN: base.length,
                    lo: lo, hi: hi,
                    selBins: binFractions(sel, lo, hi, nBins),
                    baseBins: binFractions(base, lo, hi, nBins)
                });
            }

            if (!m.rows.length) {
                m.message = 'Nothing to compare';
                m.detail = 'Every other data source was excluded: ' + m.excluded.join(', ') + '.';
                return m;
            }

            if (cfg.SortBy !== 'display') {
                m.rows.sort(function (a, b) { return (b.d - a.d) || (a.index - b.index); });
            }

            if (m.nSel < THIN_SAMPLES || m.nBase < THIN_SAMPLES) {
                m.notes.push('only ' + Math.min(m.nSel, m.nBase) + ' instants on one side — shapes are noisy');
            }
            if (m.excluded.length) { m.notes.push('excluded: ' + m.excluded.join(', ')); }
            m.ok = true;
            return m;
        }

        /* ================================================================ *
         * Render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;

            scope.pvx.background = cfg.Transparent ? 'transparent' : (cfg.BackgroundColor || t.surface);
            applyThemeVars(c, t);

            var m = buildModel(cfg);
            // The rule IS the heading: "what is different" is the same question
            // on every instance; the condition is what tells two apart.
            scope.pvx.title = cfg.Title || (m.condText ? 'When ' + m.condText : 'Condition compare');
            // Below ~260px the header has room for one line, and the rule
            // (the title) is the part that cannot be lost.
            scope.pvx.subtitle = m.condText && (c.width || 0) >= 260
                ? PVX.fmt.number(100 * m.selShare, { decimals: m.selShare < 0.1 ? 1 : 0 }) +
                  '% of the time (' + PVX.fmt.duration(m.selMs) + ')'
                : '';
            scope.pvx.error = (m.cond && !m.cond.good) ? (m.cond.errorDescription || 'Bad data') : '';
            scope.pvx.note = '';
            scope.pvx.count = '';

            if (host) { draw(c, cfg, t, host, m); }

            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
        }

        function textPx(s, fontPx) {
            return String(s === null || s === undefined ? '' : s).length * fontPx * 0.58;
        }

        /**
         * Trim an already-drawn <text> until it measures inside maxPx. Tag
         * names are proper nouns with wide glyphs, and an estimate that is
         * generous in the test font is tight in Segoe UI — the same trap
         * pvxProfile documents. Measure, do not guess.
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
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return; }
                node.textContent = core.slice(0, keep) + '…';
            }
            if (measure() > maxPx) { node.textContent = ''; }
        }

        function draw(c, cfg, t, host, m) {
            var svgRoot = host.querySelector('svg.pvx-cmp-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-cmp-svg' }, host);
            }
            var W = Math.max(24, host.clientWidth || c.width);
            var H = Math.max(24, host.clientHeight || c.height);
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            if (!m.ok) {
                drawMessage(svgRoot, W, H, t, m.message, m.detail);
                return;
            }

            var selColor = cfg.SelectionColor || PVX.color.status.warning;
            var baseColor = cfg.BaselineColor || cfg.AccentColor || '#3b82c4';
            var compact = W < 260 || H < 120;

            var pad = 4;
            var headH = compact ? 0 : 14;
            var font = PVX.util.clamp(Math.min(W / 34, 11), 7, 11);
            var subFont = Math.max(7, font * 0.85);
            var showMed = cfg.ShowMedians !== false && !compact;

            // Rows are as tall as the box allows, between a readable minimum
            // and a ceiling past which a histogram stops gaining anything.
            var minRowH = showMed ? font + subFont + 8 : font + 6;
            var avail = H - pad * 2 - headH;
            var cap = Math.max(1, Math.floor(avail / minRowH));
            var maxRows = intIn(cfg.MaxRows, 1, 100, 12);
            var shown = Math.min(m.rows.length, maxRows, cap);
            var rows = m.rows.slice(0, shown);
            var hidden = m.rows.length - shown;
            var rowH = Math.min(avail / Math.max(1, shown), 46);

            var nameW = PVX.util.clamp(W * (compact ? 0.45 : 0.32), 40, 220);
            var scoreW = compact ? Math.min(70, W * 0.4) : PVX.util.clamp(W * 0.18, 56, 100);
            var x0 = pad, xName1 = x0 + nameW;
            var xHist0 = xName1 + 8, xHist1 = W - pad - scoreW - 8;
            if (compact || xHist1 - xHist0 < 30) { xHist1 = xHist0; }
            var xScore0 = W - pad - scoreW;

            // ---- column header + legend ------------------------------------
            if (headH) {
                var hy = pad + headH * 0.55;
                PVX.svg.text(svgRoot, x0, hy.toFixed(1), 'Tag', {
                    'class': 'pvx-svg-label pvx-cmp-colhead', 'font-size': subFont.toFixed(1), fill: t.textMuted
                });
                if (xHist1 > xHist0) {
                    var lx = xHist0;
                    lx = legendKey(svgRoot, lx, hy, selColor, 'when true', subFont, t, true);
                    legendKey(svgRoot, lx + 8, hy, baseColor, 'otherwise', subFont, t, false);
                }
                PVX.svg.text(svgRoot, (W - pad).toFixed(1), hy.toFixed(1), 'Difference', {
                    'class': 'pvx-svg-label pvx-cmp-colhead', 'text-anchor': 'end',
                    'font-size': subFont.toFixed(1), fill: t.textMuted
                });
            }

            var y0 = pad + headH;
            var g = PVX.svg.el('g', { 'class': 'pvx-cmp-rows' }, svgRoot);
            for (var r = 0; r < rows.length; r++) {
                var row = rows[r];
                var ry = y0 + r * rowH;
                var rg = PVX.svg.el('g', { 'class': 'pvx-cmp-row' }, g);

                if (r % 2 === 1) {
                    PVX.svg.el('rect', {
                        x: 0, y: ry.toFixed(1), width: W.toFixed(1), height: rowH.toFixed(1),
                        fill: t.grid, 'class': 'pvx-cmp-band'
                    }, rg);
                }

                // name (+ medians underneath when there is room)
                var two = showMed && rowH >= font + subFont + 6;
                var nameY = two ? ry + rowH / 2 - subFont * 0.45 : ry + rowH / 2;
                var nm = PVX.svg.text(rg, x0, nameY.toFixed(1), row.label, {
                    'class': 'pvx-svg-label pvx-cmp-name', 'font-size': font.toFixed(1), fill: t.text
                });
                fitTextTo(nm, nameW - 2);
                if (two) {
                    var medTxt = PVX.fmt.number(row.selMed, PVX.config.numberOpts(cfg)) + ' vs ' +
                        PVX.fmt.number(row.baseMed, PVX.config.numberOpts(cfg)) +
                        (row.units && cfg.ShowUnits !== false ? ' ' + row.units : '');
                    var md = PVX.svg.text(rg, x0, (nameY + font * 0.6 + subFont * 0.55).toFixed(1), medTxt, {
                        'class': 'pvx-svg-label pvx-num pvx-cmp-medians',
                        'font-size': subFont.toFixed(1), fill: t.textMuted
                    });
                    fitTextTo(md, nameW - 2);
                }

                // paired histograms
                if (xHist1 > xHist0) {
                    drawHist(rg, row, xHist0, ry + 3, xHist1 - xHist0, rowH - 6, selColor, baseColor, t, showMed);
                }

                // difference score + bar
                var barY = ry + rowH / 2 - 3;
                var barMax = Math.max(4, scoreW - 34);
                PVX.svg.el('rect', {
                    x: xScore0.toFixed(1), y: barY.toFixed(1), width: barMax.toFixed(1), height: 6,
                    rx: 2, fill: t.track, 'class': 'pvx-cmp-track'
                }, rg);
                PVX.svg.el('rect', {
                    x: xScore0.toFixed(1), y: barY.toFixed(1),
                    width: Math.max(1, barMax * row.d).toFixed(1), height: 6,
                    rx: 2, fill: selColor, 'class': 'pvx-cmp-score'
                }, rg);
                PVX.svg.text(rg, (W - pad).toFixed(1), (ry + rowH / 2).toFixed(1),
                    Math.round(100 * row.d) + '%', {
                        'class': 'pvx-svg-value pvx-num pvx-cmp-scoretext', 'text-anchor': 'end',
                        'font-size': font.toFixed(1), fill: t.text
                    });

                PVX.svg.el('title', null, rg).textContent = tipFor(row, cfg, m);
            }

            var notes = m.notes.slice();
            if (hidden > 0) {
                notes.unshift('+' + hidden + (hidden === 1 ? ' tag' : ' tags') +
                    (cfg.SortBy === 'display' ? ' not shown' : ' with smaller differences not shown'));
            }
            notes.push('correlation, not cause');
            scope.pvx.note = notes.join(' · ');
            scope.pvx.count = m.rows.length + (m.rows.length === 1 ? ' tag' : ' tags');
        }

        function legendKey(parent, x, y, color, label, font, t, solid) {
            PVX.svg.el('rect', {
                x: x.toFixed(1), y: (y - font * 0.4).toFixed(1), width: 9, height: (font * 0.8).toFixed(1),
                rx: 1.5, fill: color, 'fill-opacity': solid ? 0.55 : 0.3,
                stroke: color, 'stroke-width': 1
            }, parent);
            PVX.svg.text(parent, (x + 12).toFixed(1), y.toFixed(1), label, {
                'class': 'pvx-svg-label', 'font-size': font.toFixed(1), fill: t.textMuted
            });
            return x + 12 + textPx(label, font);
        }

        /**
         * The baseline is a filled silhouette, the selection a stepped outline
         * on top of it. Two filled shapes would hide each other wherever they
         * overlap — which is everywhere when the answer is "no difference",
         * the most common answer and the one that most needs to be readable.
         */
        function drawHist(parent, row, x, y, w, h, selColor, baseColor, t, showMed) {
            var n = row.selBins.length;
            var peak = 0, i;
            for (i = 0; i < n; i++) {
                peak = Math.max(peak, row.selBins[i], row.baseBins[i]);
            }
            if (!(peak > 0)) { return; }
            var bw = w / n;
            var yb = y + h;
            var f = function (v) { return v.toFixed(2); };

            var dBase = 'M' + f(x) + ' ' + f(yb);
            var dSel = 'M' + f(x) + ' ' + f(yb);
            for (i = 0; i < n; i++) {
                var hb = h * row.baseBins[i] / peak;
                var hs = h * row.selBins[i] / peak;
                dBase += ' V' + f(yb - hb) + ' H' + f(x + (i + 1) * bw);
                dSel += ' V' + f(yb - hs) + ' H' + f(x + (i + 1) * bw);
            }
            dBase += ' V' + f(yb) + ' Z';
            dSel += ' V' + f(yb);

            PVX.svg.el('path', { d: dBase, fill: baseColor, 'fill-opacity': 0.3, stroke: 'none', 'class': 'pvx-cmp-base' }, parent);
            PVX.svg.el('path', {
                d: dSel + ' Z', fill: selColor, 'fill-opacity': 0.1, stroke: 'none', 'class': 'pvx-cmp-selfill'
            }, parent);
            PVX.svg.el('path', {
                d: dSel, fill: 'none', stroke: selColor, 'stroke-width': 1.5, 'class': 'pvx-cmp-sel'
            }, parent);
            PVX.svg.el('line', {
                x1: f(x), y1: f(yb), x2: f(x + w), y2: f(yb),
                stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-cmp-axis'
            }, parent);

            if (showMed) {
                var span = row.hi - row.lo;
                var mx = function (v) { return x + PVX.util.clamp((v - row.lo) / span, 0, 1) * w; };
                PVX.svg.el('line', {
                    x1: f(mx(row.baseMed)), y1: f(y), x2: f(mx(row.baseMed)), y2: f(yb),
                    stroke: baseColor, 'stroke-width': 1, 'stroke-dasharray': '2 2', 'class': 'pvx-cmp-med'
                }, parent);
                PVX.svg.el('line', {
                    x1: f(mx(row.selMed)), y1: f(y), x2: f(mx(row.selMed)), y2: f(yb),
                    stroke: selColor, 'stroke-width': 1.5, 'class': 'pvx-cmp-med'
                }, parent);
            }
        }

        function tipFor(row, cfg, m) {
            var o = PVX.config.numberOpts(cfg);
            var u = row.units ? ' ' + row.units : '';
            return row.path + '\n' +
                'When ' + m.condText + ': median ' + PVX.fmt.number(row.selMed, o) + u +
                ' (' + row.selN + ' instants)\n' +
                'Otherwise: median ' + PVX.fmt.number(row.baseMed, o) + u +
                ' (' + row.baseN + ' instants)\n' +
                'Range shown: ' + PVX.fmt.tick(row.lo) + ' – ' + PVX.fmt.tick(row.hi) + u + '\n' +
                'Difference: ' + Math.round(100 * row.d) + '% (largest gap between the two cumulative distributions)';
        }

        /** Headline and one wrapped line of explanation, shrunk to fit. */
        function drawMessage(svgRoot, W, H, t, headline, detail) {
            var hFont = PVX.util.clamp(Math.min(W / 22, H / 7), 7, 12);
            var dFont = Math.max(6.5, hFont * 0.82);
            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(1), (H / 2 - (detail ? dFont : 0)).toFixed(1), headline, {
                'class': 'pvx-svg-label pvx-cmp-msg', 'text-anchor': 'middle',
                'font-size': hFont.toFixed(1), 'font-weight': '600', fill: t.textMuted
            });
            fitTextTo(head, W - 12);
            if (!detail) { return; }
            var words = String(detail).split(/\s+/);
            var maxChars = Math.max(6, Math.floor((W - 16) / (dFont * 0.58)));
            var lines = [], cur = '';
            for (var i = 0; i < words.length; i++) {
                var next = cur ? cur + ' ' + words[i] : words[i];
                if (next.length > maxChars && cur) { lines.push(cur); cur = words[i]; } else { cur = next; }
            }
            if (cur) { lines.push(cur); }
            var maxLines = Math.max(0, Math.floor((H / 2 - 4) / (dFont * 1.3)));
            lines = lines.slice(0, Math.min(4, maxLines));
            for (var k = 0; k < lines.length; k++) {
                var ln = PVX.svg.text(svgRoot, (W / 2).toFixed(1),
                    (H / 2 + dFont * 0.6 + k * dFont * 1.3).toFixed(1), lines[k], {
                        'class': 'pvx-svg-label pvx-cmp-msgdetail', 'text-anchor': 'middle',
                        'font-size': dFont.toFixed(1), fill: t.textMuted
                    });
                fitTextTo(ln, W - 12);
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
