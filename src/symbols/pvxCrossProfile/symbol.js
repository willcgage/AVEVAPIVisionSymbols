/* ============================================================================
 * pvxCrossProfile: "PVX Cross Profile" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources, one per position)
 * @mock crossprofile
 *
 * A measurement taken at many positions across a sheet, a web, a kiln or a
 * stack, over time. pvxProfile shows the shape across positions now; this
 * shows how that shape has moved:
 *
 *   - a map of position (across) against time (down, newest at the top),
 *     each cell colored by how far it is from the target, so a streak, a
 *     drifting edge or a whole-width step is visible at a glance;
 *   - under it, the current profile, the average profile over the range,
 *     and a band of plus or minus two standard deviations at each position
 *     over time (how much each position wanders);
 *   - in the footer, the 2-sigma across positions of the current profile
 *     (the cross-direction figure a paper or film mill quotes) and the
 *     average 2-sigma over time at one position (the machine-direction one).
 *
 * Time is cut into Rows equal intervals; each cell is the average of the
 * values in it, and an interval with none holds the last value before it,
 * as a scanner's profile does between scans. A position with no values at
 * all is a blank column and is named in the footer.
 *
 * The arithmetic is symbolVis.grid and symbolVis.summary, pure, tested in
 * Node; this file draws.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxCrossProfile',
        displayName: 'PVX Cross Profile',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Cross Profile',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                Height: 360,
                Width: 520,

                Title: '',
                PositionOrder: 'source',    // source | number (from each name)
                Rows: 48,                   // time intervals in the map

                Target: '',                 // blank: the average of every cell
                ColorSpan: '',              // blank: the largest deviation seen
                ColorMode: 'diverging',     // diverging | sequential

                ShowProfile: true,
                ShowAverage: true,
                Sigma: 2,                   // the band, in standard deviations
                LineColor: '#3b82c4',
                ShowLabel: true
            });
        }
    };

    /** Last number in a name: "CD Gauge 12 Basis Weight" -> 12. */
    function numberIn(name) {
        var m = String(name || '').match(/-?\d+(?:\.\d+)?/g);
        return m ? parseFloat(m[m.length - 1]) : null;
    }

    /**
     * Column order. 'number' sorts by the last number in each name, so
     * "Zone 10" follows "Zone 9" whatever order the sources were dropped in;
     * a name with none keeps its place after the numbered ones.
     */
    symbolVis.order = function (labels, mode) {
        var idx = [];
        for (var i = 0; i < labels.length; i++) { idx.push(i); }
        if (mode !== 'number') { return { order: idx, unnumbered: 0 }; }
        var un = 0;
        var key = labels.map(function (l) { var n = numberIn(l); if (n === null) { un += 1; } return n; });
        idx.sort(function (a, b) {
            var ka = key[a], kb = key[b];
            if (ka === null && kb === null) { return a - b; }
            if (ka === null) { return 1; }
            if (kb === null) { return -1; }
            return ka - kb || a - b;
        });
        return { order: idx, unnumbered: un };
    };

    /**
     * Series -> cells[row][col]: row 0 the oldest interval.
     * @param cols [{points:[{t, v}]}] already in column order
     * @returns {from, to, rows, cells, held, empty: [col], excluded}
     */
    symbolVis.grid = function (cols, rows, from, to) {
        var n = Math.max(2, Math.min(500, parseInt(rows, 10) || 48));
        var span = (to - from) / n;
        var cells = [], held = 0, excluded = 0, empty = [];
        var r, c;
        for (r = 0; r < n; r++) { cells.push([]); }
        for (c = 0; c < cols.length; c++) {
            var sum = [], cnt = [];
            for (r = 0; r < n; r++) { sum.push(0); cnt.push(0); }
            var pts = cols[c].points || [], last = null, lastT = -Infinity, any = false;
            for (var i = 0; i < pts.length; i++) {
                var v = pts[i].v;
                if (typeof v !== 'number' || !isFinite(v)) { excluded += 1; continue; }
                any = true;
                if (pts[i].t < from) { if (pts[i].t >= lastT) { last = v; lastT = pts[i].t; } continue; }
                var k = Math.min(n - 1, Math.floor((pts[i].t - from) / span));
                if (k < 0 || k >= n) { continue; }
                sum[k] += v; cnt[k] += 1;
            }
            if (!any) { empty.push(c); }
            for (r = 0; r < n; r++) {
                if (cnt[r]) {
                    last = sum[r] / cnt[r];
                    cells[r].push(last);
                } else {
                    if (last !== null) { held += 1; }
                    cells[r].push(last);
                }
            }
        }
        return { from: from, to: to, rows: n, cells: cells, held: held, empty: empty, excluded: excluded };
    };

    function meanSd(vals) {
        var n = 0, s = 0, ss = 0;
        for (var i = 0; i < vals.length; i++) {
            if (vals[i] === null) { continue; }
            n += 1; s += vals[i]; ss += vals[i] * vals[i];
        }
        if (!n) { return null; }
        var m = s / n;
        return { mean: m, sd: n > 1 ? Math.sqrt(Math.max(0, (ss - n * m * m) / (n - 1))) : 0, n: n };
    }

    /**
     * The statistics under the map: per position, the mean and spread over
     * time; across positions, the current profile's spread (CD) and the
     * average spread of one position over time (MD).
     */
    symbolVis.summary = function (g) {
        var cols = g.cells.length ? g.cells[0].length : 0;
        var per = [], c, r;
        for (c = 0; c < cols; c++) {
            var col = [];
            for (r = 0; r < g.rows; r++) { col.push(g.cells[r][c]); }
            per.push(meanSd(col));
        }
        var current = g.rows ? g.cells[g.rows - 1] : [];
        var cd = meanSd(current);
        var md = 0, mdn = 0, all = [];
        for (c = 0; c < per.length; c++) {
            if (per[c]) { md += per[c].sd; mdn += 1; }
        }
        for (r = 0; r < g.rows; r++) { all = all.concat(g.cells[r]); }
        var tot = meanSd(all);
        return { per: per, current: current, cd: cd, mdSd: mdn ? md / mdn : null, overall: tot };
    };

    symbolVis.numberIn = numberIn;

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { title: '', stats: '', note: '', error: '', background: '' };
        var model = { all: [] };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-xprof-body',
            onData: function (d) { model.all = PVX.data.series(d); },
            render: render
        });

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }
            var W = Math.max(40, c.width);
            var H = Math.max(40, c.height);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;
            if (c.node && c.node.style && c.node.style.setProperty) {
                c.node.style.setProperty('--pvx-text', t.text);
                c.node.style.setProperty('--pvx-muted', t.textMuted);
            }
            var svgRoot = host.querySelector('svg.pvx-xprof-svg');
            if (!svgRoot) { svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-xprof-svg' }, host); }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var all = model.all || [];
            var labels = all.map(function (s) { return s.label; });
            var ord = symbolVis.order(labels, cfg.PositionOrder);
            var cols = ord.order.map(function (i) { return all[i]; });
            scope.pvx.title = cfg.Title || (all.length ? 'Cross profile, ' + all.length + ' positions' : 'Cross profile');
            var notes = [];
            var bad = all.filter(function (s) { return !s.good; }).length;
            scope.pvx.error = bad ? bad + ' position' + (bad === 1 ? '' : 's') + ' with bad data quality' : '';

            var from = Infinity, to = -Infinity;
            cols.forEach(function (s) {
                var p = s.points || [];
                if (p.length) { from = Math.min(from, p[0].t); to = Math.max(to, p[p.length - 1].t); }
            });
            if (cols.length < 2 || !(to > from)) {
                scope.pvx.stats = '';
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, cols.length < 2 ? 'Needs two positions or more' : 'No data',
                    cols.length < 2 ? 'Drop one attribute per position across the sheet.' : 'No values in this time range.');
                digest();
                return;
            }

            var g = symbolVis.grid(cols, cfg.Rows, from, to);
            var sum = symbolVis.summary(g);
            if (ord.unnumbered && cfg.PositionOrder === 'number') {
                notes.push(ord.unnumbered + ' name' + (ord.unnumbered === 1 ? '' : 's') + ' with no number, placed last');
            }
            if (g.empty.length) {
                notes.push('No values: ' + g.empty.map(function (ci) { return cols[ci].label; }).join(', '));
            }
            if (g.excluded) { notes.push(g.excluded + ' value' + (g.excluded === 1 ? '' : 's') + ' not a number, left out'); }

            var target = PVX.util.num(cfg.Target);
            var tgt = target !== null ? target : (sum.overall ? sum.overall.mean : 0);
            var span = PVX.util.num(cfg.ColorSpan);
            var lo = Infinity, hi = -Infinity;
            g.cells.forEach(function (row) { row.forEach(function (v) { if (v !== null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }); });
            if (!(span > 0)) { span = Math.max(Math.abs(hi - tgt), Math.abs(tgt - lo)) || 1; }
            var diverging = cfg.ColorMode !== 'sequential';
            var colorOf = function (v) {
                if (v === null) { return null; }
                if (diverging) { return PVX.color.ramp(PVX.color.diverging, 0.5 + (v - tgt) / (2 * span)); }
                return PVX.color.ramp(PVX.color.sequential.slice().reverse(), (v - lo) / ((hi - lo) || 1));
            };

            /* ---- layout -------------------------------------------------- */
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 28), 9, 12);
            var showProf = cfg.ShowProfile !== false && H >= 150;
            var left = Math.round(font * 4.2), right = Math.round(font * 0.8);
            var legendH = Math.round(font * 2.2);
            var profH = showProf ? Math.round((H - legendH) * 0.38) : 0;
            var map = { x: left, y: Math.round(font * 0.5), w: Math.max(10, W - left - right), h: 0 };
            // Under the profile: its key above it and the position numbers below.
            map.h = Math.max(10, H - map.y - legendH - profH - (showProf ? font * 3.2 : font * 1.4));
            var cw = map.w / cols.length, rh = map.h / g.rows;

            for (var r = 0; r < g.rows; r++) {
                // Newest at the top, as a scanner's display scrolls.
                var y = map.y + (g.rows - 1 - r) * rh;
                for (var ci = 0; ci < cols.length; ci++) {
                    var v = g.cells[r][ci];
                    var fill = colorOf(v);
                    if (!fill) { continue; }
                    PVX.svg.el('rect', { x: (map.x + ci * cw).toFixed(2), y: y.toFixed(2), width: (cw + 0.4).toFixed(2),
                        height: (rh + 0.4).toFixed(2), fill: fill, 'class': 'pvx-xprof-cell' }, svgRoot);
                }
            }
            PVX.svg.el('rect', { x: map.x, y: map.y, width: map.w.toFixed(2), height: map.h.toFixed(2), fill: 'none',
                stroke: t.border, 'stroke-width': 1 }, svgRoot);
            // Time labels: newest at the top, oldest at the bottom, the middle.
            [[map.y + font * 0.8, g.to], [map.y + map.h / 2 + font * 0.35, (g.from + g.to) / 2], [map.y + map.h - 2, g.from]].forEach(function (lt) {
                PVX.svg.text(svgRoot, (map.x - 4).toFixed(2), lt[0].toFixed(2), PVX.fmt.time(lt[1], 'short').slice(6), {
                    'class': 'pvx-svg-label', 'text-anchor': 'end', 'font-size': font * 0.9, fill: t.textMuted });
            });
            // One tooltip per column, on a transparent strip, rather than one
            // per cell: thousands of titles cost more than they say.
            for (ci = 0; ci < cols.length; ci++) {
                var ps = sum.per[ci];
                var strip = PVX.svg.el('rect', { x: (map.x + ci * cw).toFixed(2), y: map.y, width: cw.toFixed(2),
                    height: map.h.toFixed(2), fill: 'transparent', 'class': 'pvx-xprof-col' }, svgRoot);
                PVX.svg.el('title', {}, strip).textContent = cols[ci].label + (ps ? ': now ' + fmt(sum.current[ci]) +
                    ', average ' + fmt(ps.mean) + ', ' + fmt(2 * ps.sd) + ' at 2 sigma over time' : ': no values');
            }

            /* ---- color legend ------------------------------------------ */
            var ly = map.y + map.h + font * 0.6;
            var lw = Math.min(map.w, 220), lx = map.x + (map.w - lw) / 2;
            for (var s = 0; s < 40; s++) {
                var tv = diverging ? tgt - span + 2 * span * s / 39 : lo + (hi - lo) * s / 39;
                PVX.svg.el('rect', { x: (lx + lw * s / 40).toFixed(2), y: ly.toFixed(2), width: (lw / 40 + 0.4).toFixed(2),
                    height: (font * 0.6).toFixed(2), fill: colorOf(tv) }, svgRoot);
            }
            var lText = diverging
                ? [fmt(tgt - span), (target !== null ? 'target ' : 'average ') + fmt(tgt), fmt(tgt + span)]
                : [fmt(lo), '', fmt(hi)];
            [['start', lx], ['middle', lx + lw / 2], ['end', lx + lw]].forEach(function (a, k) {
                PVX.svg.text(svgRoot, a[1].toFixed(2), (ly + font * 1.55).toFixed(2), lText[k], {
                    'class': 'pvx-svg-label', 'text-anchor': a[0], 'font-size': font * 0.85, fill: t.textMuted });
            });

            /* ---- profile panel ------------------------------------------- */
            if (showProf) {
                var pr = { x: map.x, y: ly + legendH + font * 0.9, w: map.w, h: profH };
                var k2 = Math.max(0, parseFloat(cfg.Sigma) || 2);
                var plo = Infinity, phi = -Infinity;
                for (ci = 0; ci < cols.length; ci++) {
                    var q = sum.per[ci];
                    if (q) { plo = Math.min(plo, q.mean - k2 * q.sd); phi = Math.max(phi, q.mean + k2 * q.sd); }
                    if (sum.current[ci] !== null) { plo = Math.min(plo, sum.current[ci]); phi = Math.max(phi, sum.current[ci]); }
                }
                if (target !== null) { plo = Math.min(plo, target); phi = Math.max(phi, target); }
                var pad = (phi - plo) * 0.08 || 1;
                plo -= pad; phi += pad;
                var px = function (i) { return pr.x + (i + 0.5) * cw; };
                var py = function (v) { return pr.y + pr.h - (v - plo) / (phi - plo) * pr.h; };
                PVX.svg.el('rect', { x: pr.x, y: pr.y.toFixed(2), width: pr.w.toFixed(2), height: pr.h.toFixed(2),
                    fill: 'none', stroke: t.border, 'stroke-width': 1 }, svgRoot);
                PVX.scale.ticks(plo, phi, 3).forEach(function (tk) {
                    if (tk < plo || tk > phi) { return; }
                    PVX.svg.text(svgRoot, (pr.x - 4).toFixed(2), (py(tk) + font * 0.35).toFixed(2), PVX.fmt.tick(tk), {
                        'class': 'pvx-svg-label', 'text-anchor': 'end', 'font-size': font * 0.9, fill: t.textMuted });
                });
                var up = [], dn = [], avg = [], cur = [];
                for (ci = 0; ci < cols.length; ci++) {
                    var q2 = sum.per[ci];
                    if (q2) {
                        up.push({ x: px(ci), y: py(q2.mean + k2 * q2.sd) });
                        dn.unshift({ x: px(ci), y: py(q2.mean - k2 * q2.sd) });
                        avg.push({ x: px(ci), y: py(q2.mean) });
                    }
                    if (sum.current[ci] !== null) { cur.push({ x: px(ci), y: py(sum.current[ci]) }); }
                }
                var lc = cfg.LineColor || '#3b82c4';
                if (up.length > 1 && k2 > 0) {
                    PVX.svg.el('path', { d: PVX.svg.line(up.concat(dn)) + ' Z', fill: lc, 'fill-opacity': 0.13,
                        stroke: 'none', 'class': 'pvx-xprof-band' }, svgRoot);
                }
                if (target !== null) {
                    PVX.svg.el('line', { x1: pr.x, x2: pr.x + pr.w, y1: py(target).toFixed(2), y2: py(target).toFixed(2),
                        stroke: t.textMuted, 'stroke-width': 1, 'stroke-dasharray': '2 3' }, svgRoot);
                }
                if (cfg.ShowAverage !== false && avg.length > 1) {
                    PVX.svg.el('path', { d: PVX.svg.line(avg), fill: 'none', stroke: lc, 'stroke-width': 1.2,
                        'stroke-dasharray': '5 3', 'class': 'pvx-xprof-avg' }, svgRoot);
                }
                if (cur.length > 1) {
                    PVX.svg.el('path', { d: PVX.svg.line(cur), fill: 'none', stroke: lc, 'stroke-width': 2,
                        'class': 'pvx-xprof-current' }, svgRoot);
                }
                // Positions along the bottom, as many as fit.
                var every = Math.max(1, Math.ceil(cols.length * font * 2.4 / pr.w));
                for (ci = 0; ci < cols.length; ci += every) {
                    var num = cfg.PositionOrder === 'number' ? numberIn(cols[ci].label) : null;
                    PVX.svg.text(svgRoot, px(ci).toFixed(2), (pr.y + pr.h + font * 1.2).toFixed(2), num !== null ? String(num) : String(ci + 1), {
                        'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': font * 0.85, fill: t.textMuted });
                }
                PVX.svg.text(svgRoot, (pr.x + pr.w).toFixed(2), (pr.y - 3).toFixed(2),
                    'now —   average - -   ±' + k2 + 'σ over time', {
                        'class': 'pvx-svg-label', 'text-anchor': 'end', 'font-size': font * 0.85, fill: t.textMuted });
            }

            var units = cols[0] && cols[0].units ? ' ' + cols[0].units : '';
            scope.pvx.stats = (sum.cd ? 'Across, now: 2σ ' + fmt(2 * sum.cd.sd) + units + ', average ' + fmt(sum.cd.mean) + units : '') +
                (sum.mdSd !== null ? ' · Along, each position: 2σ ' + fmt(2 * sum.mdSd) + units : '');
            if (g.held) { notes.push(g.held + ' interval' + (g.held === 1 ? '' : 's') + ' with no value held the last one'); }
            scope.pvx.note = notes.join(' · ');
            digest();

            function fmt(v) { return v === null || v === undefined ? '--' : PVX.fmt.number(v, PVX.config.numberOpts(cfg)); }
        }

        function emptyState(root2, w2, h2, th, headline, detail) {
            var f = PVX.util.clamp(Math.round(Math.min(w2, h2) / 16), 9, 13);
            PVX.svg.fit(PVX.svg.text(root2, (w2 / 2).toFixed(2), (h2 / 2 - f * 0.7).toFixed(2), headline, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': f, 'font-weight': '600', fill: th.textMuted }), w2 - 8);
            PVX.svg.fit(PVX.svg.text(root2, (w2 / 2).toFixed(2), (h2 / 2 + f * 0.7).toFixed(2), detail, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': f * 0.9, fill: th.textMuted, opacity: '0.8' }), w2 - 8);
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
