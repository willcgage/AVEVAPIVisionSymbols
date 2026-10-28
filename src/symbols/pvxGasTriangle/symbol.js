/* ============================================================================
 * pvxGasTriangle — Duval triangle for dissolved gas analysis
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources: methane, ethylene and
 * acetylene in a transformer's oil, in ppm)
 *
 * Duval's Triangle 1, as IEC 60599 gives it, names the likely fault in an
 * oil-filled transformer from the relative amounts of three gases: each
 * gas's share of the three together places one point in a triangle, and the
 * triangle is cut into seven zones (partial discharge, three thermal bands,
 * two discharge energies and a mixed zone). A trend of three ppm values
 * cannot show this, because the diagnosis is in the proportions, not the
 * levels: the same zone holds at 30 ppm or 3000.
 *
 * The trail is the point's path over the display's time range, so a unit
 * moving from T2 toward DT shows the direction it is going, which matters
 * more to an asset engineer than where it is today.
 *
 * WHAT IT DOES NOT DO
 *   The proportions say nothing about whether there is enough gas to matter.
 *   IEC 60599 applies the triangle only once the levels are above the
 *   site's typical values; the Minimum total setting is that gate, and below
 *   it the point is drawn but the zone is not named. This symbol does not
 *   judge the levels or the rate of increase; a trend does that better.
 *
 * GASES
 *   A source whose name says methane / CH4, ethylene / C2H4 or acetylene /
 *   C2H2 is taken as that gas, in any order. Without such names the first
 *   three sources are CH4, C2H4 and C2H2, and the footer says so.
 * @mock dga
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var SQ3 = Math.sqrt(3) / 2;

    var GASES = [
        { key: 'CH4', name: 'CH₄', re: /\bCH4\b|methane/i },
        { key: 'C2H4', name: 'C₂H₄', re: /C2H4|ethylene|ethene/i },
        { key: 'C2H2', name: 'C₂H₂', re: /C2H2|acetylene|ethyne/i }
    ];

    /* Zone outlines as [%CH4, %C2H4, %C2H2] vertices, from the boundaries
     * IEC 60599 tabulates. classify() below is the authority; the outlines
     * only draw it, and tools/test-charts.js checks the two agree. The label
     * point is chosen inside each zone, where it reads at the usual size. */
    var ZONES = [
        { code: 'PD', name: 'Partial discharges', color: '#8e7cc3',
          pts: [[98, 2, 0], [100, 0, 0], [98, 0, 2]], label: null },
        { code: 'T1', name: 'Thermal fault below 300 °C', color: '#f1c232',
          pts: [[98, 2, 0], [80, 20, 0], [76, 20, 4], [96, 0, 4], [98, 0, 2]], label: [88, 10, 2] },
        { code: 'T2', name: 'Thermal fault, 300 to 700 °C', color: '#e69138',
          pts: [[80, 20, 0], [50, 50, 0], [46, 50, 4], [76, 20, 4]], label: [63, 35, 2] },
        { code: 'T3', name: 'Thermal fault above 700 °C', color: '#cc4125',
          pts: [[50, 50, 0], [0, 100, 0], [0, 85, 15], [35, 50, 15]], label: [25, 68, 7] },
        { code: 'D1', name: 'Discharges of low energy', color: '#6fa8dc',
          pts: [[87, 0, 13], [0, 0, 100], [0, 23, 77], [64, 23, 13]], label: [40, 8, 52] },
        { code: 'D2', name: 'Discharges of high energy', color: '#3d6fb4',
          pts: [[64, 23, 13], [0, 23, 77], [0, 71, 29], [31, 40, 29], [47, 40, 13]], label: [18, 40, 42] },
        { code: 'DT', name: 'Electrical and thermal faults', color: '#6aa84f',
          pts: [[96, 0, 4], [46, 50, 4], [35, 50, 15], [0, 85, 15], [0, 71, 29], [31, 40, 29],
                [47, 40, 13], [87, 0, 13]], label: [8, 70, 22] }
    ];

    /** The Triangle 1 zone of a point given as percentages summing to 100. */
    function classify(ch4, c2h4, c2h2) {
        if (ch4 >= 98) { return 'PD'; }
        if (c2h2 >= 13 && c2h4 < 23) { return 'D1'; }
        if (c2h4 >= 23 && (c2h2 >= 29 || (c2h2 >= 13 && c2h4 < 40))) { return 'D2'; }
        if (c2h2 < 4 && c2h4 < 20) { return 'T1'; }
        if (c2h2 < 4 && c2h4 < 50) { return 'T2'; }
        if (c2h2 < 15 && c2h4 >= 50) { return 'T3'; }
        return 'DT';
    }

    var definition = {
        typeName: 'pvxGasTriangle',
        displayName: 'PVX Gas Triangle',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Gas Triangle',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 400,
                Height: 340,
                Width: 460,

                Title: '',                  // blank => "Duval triangle"
                MinTotalPpm: '',            // blank => always name the zone
                MaxPairGapHours: 0,         // 0 => no limit
                ShowTrail: true,
                TrailLength: 60,            // samples; 0 => every one in range
                ShowGrid: true,
                ShowZoneLabels: true,
                ZoneOpacity: 0.32,
                ZoneColors: '',             // "T3:#c00000, D2:#1f4e9c" overrides
                LegendPosition: 'auto',     // auto | right | none
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            title: '',
            zoneText: '',
            zoneColor: '',
            note: '',
            error: ''
        };

        var model = { series: [], gas: null, byOrder: false, extra: 0, samples: [], dropped: {} };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-gt-body',

            // stateSeries keeps a non-numeric sample, so a "Calc Failed" is
            // counted and named instead of vanishing from the trail.
            onData: function (d) {
                model.series = PVX.data.stateSeries(d);
                assign();
                rebuild(ctx.config || scope.config || {});
            },
            onConfigChange: function (newCfg) { rebuild(newCfg || {}); },
            render: render
        });

        /* ------------------------------------------------------------------ *
         * gases and samples
         * ------------------------------------------------------------------ */

        /** Which source is which gas: by name when all three are named. */
        function assign() {
            var s = model.series, found = [-1, -1, -1], g, i;
            for (g = 0; g < GASES.length; g++) {
                for (i = 0; i < s.length; i++) {
                    var text = (s[i].label || '') + ' ' + (s[i].path || '');
                    if (found.indexOf(i) < 0 && GASES[g].re.test(text)) { found[g] = i; break; }
                }
            }
            model.byOrder = found.indexOf(-1) >= 0;
            if (model.byOrder) { found = s.length >= 3 ? [0, 1, 2] : null; }
            model.gas = found;
            model.extra = Math.max(0, s.length - 3);
        }

        /**
         * One sample per instant any gas changed, each gas at its value in
         * force then. An online monitor reports the three together, a lab
         * result may not; holding the last value pairs them either way, and
         * the gap limit stops a months-old reading being paired with today's.
         */
        function rebuild(cfg) {
            model.samples = [];
            model.dropped = { bad: 0, negative: 0, zero: 0, stale: 0 };
            if (!model.gas) { return; }
            var lists = [], times = [], seen = {}, g, i;
            for (g = 0; g < 3; g++) {
                lists.push(model.series[model.gas[g]].points);
                for (i = 0; i < lists[g].length; i++) {
                    var tt = lists[g][i].t;
                    if (!seen[tt]) { seen[tt] = true; times.push(tt); }
                }
            }
            times.sort(function (a, b) { return a - b; });
            var gapH = PVX.util.num(cfg.MaxPairGapHours);
            var maxGap = gapH > 0 ? gapH * 3600000 : Infinity;
            var at = [-1, -1, -1];
            for (var k = 0; k < times.length; k++) {
                var t = times[k], vals = [], ok = true, bad = false, stale = false;
                for (g = 0; g < 3; g++) {
                    while (at[g] + 1 < lists[g].length && lists[g][at[g] + 1].t <= t) { at[g]++; }
                    if (at[g] < 0) { ok = false; break; }
                    var p = lists[g][at[g]];
                    if (p.v === null || p.good === false) { bad = true; }
                    if (t - p.t > maxGap) { stale = true; }
                    vals.push(p.v);
                }
                if (!ok) { continue; }      // before every gas has a first reading
                if (bad) { model.dropped.bad++; continue; }
                if (stale) { model.dropped.stale++; continue; }
                if (vals[0] < 0 || vals[1] < 0 || vals[2] < 0) { model.dropped.negative++; continue; }
                var sum = vals[0] + vals[1] + vals[2];
                if (!(sum > 0)) { model.dropped.zero++; continue; }
                var pct = [100 * vals[0] / sum, 100 * vals[1] / sum, 100 * vals[2] / sum];
                model.samples.push({ t: t, ppm: vals, total: sum, pct: pct,
                                     zone: classify(pct[0], pct[1], pct[2]) });
            }
        }

        function zoneColors(cfg) {
            var out = {}, i;
            for (i = 0; i < ZONES.length; i++) { out[ZONES[i].code] = ZONES[i].color; }
            var parts = String(cfg.ZoneColors || '').split(/[,;]/);
            for (i = 0; i < parts.length; i++) {
                var m = /^\s*(PD|T1|T2|T3|D1|D2|DT)\s*:\s*(#[0-9a-f]{3,8})\s*$/i.exec(parts[i]);
                if (m) { out[m[1].toUpperCase()] = m[2]; }
            }
            return out;
        }

        function zoneOf(code) {
            for (var i = 0; i < ZONES.length; i++) { if (ZONES[i].code === code) { return ZONES[i]; } }
            return null;
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

            var svgRoot = host.querySelector('svg.pvx-gt-svg');
            if (!svgRoot) { svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-gt-svg' }, host); }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            scope.pvx.title = cfg.Title || 'Duval triangle';
            scope.pvx.error = '';
            scope.pvx.zoneText = '';
            scope.pvx.zoneColor = '';
            var i;
            if (model.gas) {
                for (i = 0; i < 3; i++) {
                    var sr = model.series[model.gas[i]];
                    if (!sr.good) { scope.pvx.error = sr.errorDescription || ('Bad data on ' + GASES[i].key); break; }
                }
            }

            var colors = zoneColors(cfg);
            var notes = [];
            if (model.gas && model.byOrder) { notes.push('gases by order: CH4, C2H4, C2H2'); }
            if (model.extra) { notes.push(model.extra + ' extra source' + (model.extra > 1 ? 's' : '') + ' ignored'); }
            var d = model.dropped || {};
            if (d.bad) { notes.push(d.bad + ' bad or non-numeric not plotted'); }
            if (d.negative) { notes.push(d.negative + ' with a negative ppm not plotted'); }
            if (d.zero) { notes.push(d.zero + ' with no gas not plotted'); }
            if (d.stale) { notes.push(d.stale + ' not paired within ' + PVX.util.num(cfg.MaxPairGapHours) + ' h'); }

            // ---- layout --------------------------------------------------------
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 24), 8, 12);
            var legendPos = cfg.LegendPosition === 'none' ? 'none' :
                (cfg.LegendPosition === 'right' || (W >= H * 1.3 && W >= 300)) && W >= 240 ? 'right' : 'none';
            var legendW = legendPos === 'right' ? Math.min(W * 0.42, legendWidth(svgRoot, font)) : 0;
            var pad = font * 1.6;
            var areaW = W - pad * 2 - (legendW ? legendW + font : 0);
            // With the grid on, the bottom edge carries C2H2's ticks, and the
            // corner names drop a row below them rather than collide.
            var showGrid = cfg.ShowGrid !== false && Math.min(areaW, (H - pad * 2) / SQ3) >= 120;
            var cornerDy = showGrid ? font * 2.1 : font * 1.05;
            var areaH = H - pad * 2 - font * 0.6 - (showGrid ? font : 0);
            var side = Math.max(20, Math.min(areaW, areaH / SQ3));
            var x0 = pad + (areaW - side) / 2;
            var yB = pad + font * 0.4 + (areaH + side * SQ3) / 2;
            function xy(p) {
                return { x: x0 + side * (p[1] + p[0] / 2) / 100, y: yB - side * SQ3 * p[0] / 100 };
            }
            function poly(pts) {
                var s = '';
                for (var k = 0; k < pts.length; k++) {
                    var q = xy(pts[k]);
                    s += (k ? ' ' : '') + q.x.toFixed(2) + ',' + q.y.toFixed(2);
                }
                return s;
            }

            // ---- zones -----------------------------------------------------------
            var op = PVX.util.num(cfg.ZoneOpacity);
            op = op === null ? 0.32 : PVX.util.clamp(op, 0, 1);
            var last = model.samples.length ? model.samples[model.samples.length - 1] : null;
            for (i = 0; i < ZONES.length; i++) {
                var z = ZONES[i];
                var zp = PVX.svg.el('polygon', {
                    points: poly(z.pts), fill: colors[z.code], 'fill-opacity': op,
                    stroke: t.axis, 'stroke-width': 0.75, 'stroke-linejoin': 'round',
                    'class': 'pvx-gt-zone' + (last && last.zone === z.code ? ' pvx-gt-zone-now' : '')
                }, svgRoot);
                PVX.svg.el('title', null, zp).textContent = z.code + ': ' + z.name;
            }

            // ---- grid and ticks --------------------------------------------------
            if (showGrid) {
                for (var v = 20; v < 100; v += 20) {
                    gridLine([v, 100 - v, 0], [v, 0, 100 - v], 0, v);           // CH4 = v
                    gridLine([100 - v, v, 0], [0, v, 100 - v], 1, v);           // C2H4 = v
                    gridLine([100 - v, 0, v], [0, 100 - v, v], 2, v);           // C2H2 = v
                }
            }
            function gridLine(a, b, which, v) {
                var p = xy(a), q = xy(b);
                PVX.svg.el('line', {
                    x1: p.x.toFixed(2), y1: p.y.toFixed(2), x2: q.x.toFixed(2), y2: q.y.toFixed(2),
                    stroke: t.grid, 'stroke-width': 0.75, 'stroke-dasharray': '2 3', 'class': 'pvx-gt-grid'
                }, svgRoot);
                // CH4 reads on the left edge, C2H4 on the right, C2H2 along
                // the bottom: each where its own lines meet the edge.
                var at = which === 0 ? xy([v, 0, 100 - v]) : which === 1 ? p : q;
                var dx = which === 0 ? -4 : which === 1 ? 4 : 0;
                var dy = which === 2 ? font * 0.95 : 0;
                PVX.svg.text(svgRoot, (at.x + dx).toFixed(2), (at.y + dy).toFixed(2), String(v), {
                    'class': 'pvx-svg-label pvx-num pvx-gt-tick', 'font-size': (font * 0.8).toFixed(1),
                    'text-anchor': which === 0 ? 'end' : which === 1 ? 'start' : 'middle',
                    'dominant-baseline': which === 2 ? 'auto' : 'central', fill: t.textMuted
                });
            }

            // ---- outline and corner names ---------------------------------------
            PVX.svg.el('polygon', {
                points: poly([[100, 0, 0], [0, 100, 0], [0, 0, 100]]), fill: 'none',
                stroke: t.text, 'stroke-width': 1.25, 'stroke-linejoin': 'round', 'class': 'pvx-gt-outline'
            }, svgRoot);
            var top = xy([100, 0, 0]), right = xy([0, 100, 0]), left = xy([0, 0, 100]);
            corner(top.x, top.y - font * 0.55, '% ' + GASES[0].name, 'middle');
            // The bottom corners' names sit inward of the corner, under the
            // edge, so they never run off a symbol sized tight to the
            // triangle. On a thumbnail they would meet, and are left off.
            if (side >= 110) {
                corner(Math.min(right.x + font * 0.5, W - 2), right.y + cornerDy, '% ' + GASES[1].name, 'end');
                corner(Math.max(left.x - font * 0.5, 2), left.y + cornerDy, '% ' + GASES[2].name, 'start');
            }
            function corner(x, y, str, anchor) {
                PVX.svg.text(svgRoot, x.toFixed(2), y.toFixed(2), str, {
                    'class': 'pvx-svg-label pvx-gt-corner', 'text-anchor': anchor,
                    'font-size': font, 'font-weight': '600', fill: t.text
                });
            }

            // ---- zone labels -------------------------------------------------------
            if (cfg.ShowZoneLabels !== false && side >= 150) {
                var halo = (t.surface && t.surface !== 'transparent') ? t.surface : (t.dark ? '#1d2126' : '#ffffff');
                for (i = 0; i < ZONES.length; i++) {
                    var lz = ZONES[i];
                    var lp = lz.label ? xy(lz.label) : { x: top.x + font * 1.2, y: top.y + font * 0.6 };
                    PVX.svg.text(svgRoot, lp.x.toFixed(2), lp.y.toFixed(2), lz.code, {
                        'class': 'pvx-svg-label pvx-gt-zone-label', 'font-size': (font * 0.95).toFixed(1),
                        'text-anchor': lz.label ? 'middle' : 'start', 'dominant-baseline': 'central',
                        'font-weight': '600', fill: t.text, stroke: halo, 'stroke-width': 2.5,
                        'paint-order': 'stroke', 'stroke-linejoin': 'round'
                    });
                }
            }

            // ---- trail and point ---------------------------------------------------
            var minTotal = PVX.util.num(cfg.MinTotalPpm);
            if (!model.gas) {
                emptyNote(svgRoot, W, H, t, font, model.series.length ?
                    'Three gases needed: CH4, C2H4 and C2H2' : 'No gas data yet', xy([40, 30, 30]));
            } else if (!last) {
                emptyNote(svgRoot, W, H, t, font, 'No complete set of three readings in range', xy([40, 30, 30]));
            } else {
                var trail = model.samples;
                var n = PVX.util.num(cfg.TrailLength);
                if (cfg.ShowTrail === false) { trail = [last]; }
                else if (n > 0 && trail.length > n) { trail = trail.slice(trail.length - n); }
                if (trail.length > 1) {
                    var ptsStr = '';
                    for (i = 0; i < trail.length; i++) {
                        var tp = xy(trail[i].pct);
                        ptsStr += (i ? ' ' : '') + tp.x.toFixed(2) + ',' + tp.y.toFixed(2);
                    }
                    PVX.svg.el('polyline', {
                        points: ptsStr, fill: 'none', stroke: t.textMuted, 'stroke-width': 1,
                        'stroke-opacity': 0.6, 'stroke-linejoin': 'round', 'class': 'pvx-gt-trail'
                    }, svgRoot);
                }
                var accent = cfg.AccentColor || '#3b82c4';
                for (i = 0; i < trail.length; i++) {
                    var sm = trail[i];
                    var isLast = i === trail.length - 1;
                    var q = xy(sm.pct);
                    var dot = PVX.svg.el('circle', {
                        cx: q.x.toFixed(2), cy: q.y.toFixed(2), r: isLast ? Math.max(4, font * 0.45) : 2.2,
                        fill: isLast ? accent : t.textMuted,
                        'fill-opacity': isLast ? 1 : (0.25 + 0.6 * (i + 1) / trail.length).toFixed(2),
                        stroke: isLast ? t.text : 'none', 'stroke-width': isLast ? 1.5 : 0,
                        'class': isLast ? 'pvx-gt-now' : 'pvx-gt-past'
                    }, svgRoot);
                    PVX.svg.el('title', null, dot).textContent = tipText(sm, cfg, minTotal);
                }

                var lz2 = zoneOf(last.zone);
                if (minTotal !== null && last.total < minTotal) {
                    scope.pvx.zoneText = 'Below ' + PVX.fmt.tick(minTotal) + ' ppm: zone not named';
                } else {
                    scope.pvx.zoneText = lz2.code + ' · ' + lz2.name;
                    scope.pvx.zoneColor = colors[lz2.code];
                }
                notes.unshift(pctLine(last.pct));
            }

            if (legendPos === 'right') {
                drawLegend(svgRoot, t, font, colors, W - pad * 0.5 - legendW, H, legendW,
                    last && scope.pvx.zoneColor ? last.zone : '');
            }

            scope.pvx.note = notes.join(' · ');
            digest();
        }

        function pctLine(pct) {
            return 'CH4 ' + Math.round(pct[0]) + '% · C2H4 ' + Math.round(pct[1]) +
                '% · C2H2 ' + Math.round(pct[2]) + '%';
        }

        function tipText(sm, cfg, minTotal) {
            var numOpts = PVX.config.numberOpts(cfg);
            var z = zoneOf(sm.zone);
            var lines = [PVX.fmt.time(sm.t, 'datetime')];
            for (var g = 0; g < 3; g++) {
                lines.push(GASES[g].key + ': ' + PVX.fmt.number(sm.ppm[g], numOpts) + ' ppm (' +
                    PVX.fmt.percent(sm.pct[g], 1) + ')');
            }
            lines.push(minTotal !== null && sm.total < minTotal ?
                'Total ' + PVX.fmt.number(sm.total, numOpts) + ' ppm, below the minimum: zone not named' :
                z.code + ': ' + z.name);
            return lines.join('\n');
        }

        function legendWidth(svgRoot, font) {
            var w = 0;
            for (var i = 0; i < ZONES.length; i++) {
                var probe = PVX.svg.text(svgRoot, 0, 0, ZONES[i].code + '  ' + ZONES[i].name, {
                    'class': 'pvx-svg-label', 'font-size': font * 0.9, visibility: 'hidden'
                });
                var m = 0;
                try { m = probe.getComputedTextLength(); } catch (e) { m = 0; }
                if (!(m > 0)) { m = probe.textContent.length * font * 0.55; }
                w = Math.max(w, m);
                svgRoot.removeChild(probe);
            }
            return w + font + 8;
        }

        function drawLegend(svgRoot, t, font, colors, x, H, width, current) {
            var rowH = font * 1.55;
            var rows = Math.min(ZONES.length, Math.floor((H - 8) / rowH));
            var y = Math.max(4, (H - rows * rowH) / 2);
            for (var i = 0; i < rows; i++) {
                var z = ZONES[i], yy = y + i * rowH, sw = font * 0.85;
                PVX.svg.el('rect', {
                    x: x.toFixed(2), y: (yy + (rowH - sw) / 2).toFixed(2), width: sw.toFixed(2), height: sw.toFixed(2),
                    rx: 2, fill: colors[z.code], stroke: z.code === current ? t.text : 'none',
                    'stroke-width': 1.5, 'class': 'pvx-gt-swatch'
                }, svgRoot);
                var node = PVX.svg.text(svgRoot, (x + sw + 6).toFixed(2), (yy + rowH / 2).toFixed(2),
                    z.code + '  ' + z.name, {
                        'class': 'pvx-svg-label pvx-gt-legend', 'dominant-baseline': 'central',
                        'font-size': (font * 0.9).toFixed(1), fill: z.code === current ? t.text : t.textMuted,
                        'font-weight': z.code === current ? '700' : '400'
                    });
                fitTextTo(node, width - sw - 6);
            }
        }

        /**
         * Trim a drawn label to maxPx with an ellipsis. Measured, because
         * glyph-width guesses run tight in Segoe UI, which PI Vision ships.
         */
        function fitTextTo(node, maxPx) {
            if (!node || !node.getComputedTextLength) { return; }
            if (!(maxPx > 0)) { node.textContent = ''; return; }
            for (var guard = 0; guard < 8; guard++) {
                var w = 0;
                try { w = node.getComputedTextLength(); } catch (e) { return; }
                if (!(w > maxPx)) { return; }
                var cur = node.textContent || '';
                var core = cur.charAt(cur.length - 1) === '…' ? cur.slice(0, -1) : cur;
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return; }
                node.textContent = core.slice(0, keep) + '…';
            }
        }

        function emptyNote(svgRoot, W, H, t, font, str, at) {
            var node = PVX.svg.text(svgRoot, at.x.toFixed(2), at.y.toFixed(2), str, {
                'class': 'pvx-svg-label pvx-gt-empty', 'text-anchor': 'middle', 'dominant-baseline': 'central',
                'font-size': font, 'font-weight': '600', fill: t.textMuted
            });
            fitTextTo(node, Math.max(20, W - 12));
            var b = null;
            try { b = node.getBBox(); } catch (e) { b = null; }
            if (b && b.width > 0 && node.textContent) {
                // On the zones' colors a bare caption is hard to read.
                var bg = PVX.svg.el('rect', {
                    x: (b.x - 4).toFixed(2), y: (b.y - 2).toFixed(2), width: (b.width + 8).toFixed(2),
                    height: (b.height + 4).toFixed(2), rx: 3,
                    fill: (t.surface && t.surface !== 'transparent') ? t.surface : (t.dark ? '#1d2126' : '#ffffff'),
                    'fill-opacity': 0.85, 'class': 'pvx-gt-empty-bg'
                }, null);
                svgRoot.insertBefore(bg, node);
            }
        }

        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    // Exposed for tools/test-charts.js, which checks the outlines against
    // the rules and the rules against the standard's own boundary cases.
    symbolVis.classify = classify;
    symbolVis.ZONES = ZONES;

    window.PVX.register(PV, definition);

}(window.PIVisualization));
