/* ============================================================================
 * pvxMultiGauge — several values on one scale, as a dial or a bar
 * ----------------------------------------------------------------------------
 * DataShape: Table (Multiple data sources, one pointer each)
 *
 * PVX Radial Gauge and PVX Bar Indicator each take one attribute, and keep
 * PI Vision's Gauge data shape, which is what lets them follow the scale PI
 * Vision derives from the attribute. A dial with a pointer per source needs
 * several sources, so it is this symbol instead, on the Table shape the
 * library's other multi-source symbols already use on live servers: the
 * single-value gauges and every display saved with them stay exactly as
 * they were.
 *
 * What it is for: values that share units and limits and belong together.
 * Three bearing temperatures against one alarm band, supply and return on one
 * dial, setpoint, process value and output on one bar. Each pointer is its
 * own colour, with a readout row naming it; the bands come from the shared
 * threshold grammar, and the band of the first source can be highlighted.
 *
 * NOTHING SILENTLY DROPPED
 *   A source whose value is not a number has no pointer, and a value outside
 *   the scale is pinned to the end of it; both are named in the footer and in
 *   the source's own readout row. Sources past MaxPointers are counted.
 * @mock numeric
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxMultiGauge',
        displayName: 'PVX Multi-Pointer Gauge',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        sourceRemap: { PointerColors: 'listComma' },
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format Multi-Pointer Gauge',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                // Positional contract with PI Vision's Summary cells; kept in
                // step with Statistic by PVX.config.syncStatColumns().
                Columns: ['Value'],
                SortColumn: 'Value',
                Height: 260,
                Width: 280,

                Title: '',
                Statistic: 'Value',         // Value | Average | Minimum | Maximum | Range | StdDev | Total
                Shape: 'radial',            // radial | linear
                Orientation: 'horizontal',  // linear only
                PointerStyle: 'needle',     // radial: needle | marker | ring; linear: marker | bar
                PointerColors: '',          // "#c00, , #08f": one per source, blank = palette
                MaxPointers: 8,

                ScaleMode: 'fixed',         // fixed | auto
                MinValue: 0,
                MaxValue: 100,
                StartAngle: -120,
                EndAngle: 120,
                InvertScale: false,
                TickCount: 5,
                MinorTicks: 0,
                TicksAtBands: false,
                ShowScaleLabels: true,

                UseThresholds: false,
                ShowBands: true,
                BandOpacity: 0.28,
                HighlightActiveBand: false, // the band source 1 is in

                ShowReadout: true,
                ShowUnits: true,
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;
        var U = PVX.util;

        scope.pvx = { title: '', readout: [], note: '', error: '' };

        var rows = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-mg-body',
            onData: function (d) {
                rows = PVX.data.rows(d, PVX.config.statColumns(scope.config)) || [];
            },
            onConfigChange: function (newCfg) {
                PVX.config.syncStatColumns(newCfg || scope.config);
            },
            render: render
        });

        /* ------------------------------------------------------------------ *
         * model
         * ------------------------------------------------------------------ */

        function colorsFor(cfg, n) {
            var given = String(cfg.PointerColors || '').split(',');
            var pal = PVX.color.categorical;
            var out = [];
            for (var i = 0; i < n; i++) {
                var c = (given[i] || '').trim();
                out.push(/^#[0-9a-f]{3,8}$/i.test(c) ? c : pal[i % pal.length]);
            }
            return out;
        }

        function bounds(cfg, ptrs) {
            if (cfg.ScaleMode === 'auto') {
                var lo = Infinity, hi = -Infinity;
                for (var i = 0; i < ptrs.length; i++) {
                    if (ptrs[i].v === null) { continue; }
                    lo = Math.min(lo, ptrs[i].v); hi = Math.max(hi, ptrs[i].v);
                }
                if (lo === Infinity) { return [0, 100]; }
                if (lo === hi) { lo -= Math.abs(lo) * 0.1 || 1; hi += Math.abs(hi) * 0.1 || 1; }
                // Room either side, so no pointer sits on an end stop.
                var padV = (hi - lo) * 0.15;
                return PVX.scale.niceDomain(lo >= 0 && lo - padV < 0 ? 0 : lo - padV, hi + padV, 5);
            }
            var mn = U.num(cfg.MinValue), mx = U.num(cfg.MaxValue);
            if (mn === null) { mn = 0; }
            if (mx === null || mx <= mn) { mx = mn + 100; }
            return [mn, mx];
        }

        /* ------------------------------------------------------------------ *
         * render
         * ------------------------------------------------------------------ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }
            PVX.config.syncStatColumns(cfg);

            var W = Math.max(40, c.width), H = Math.max(40, c.height);
            var svgRoot = host.querySelector('svg.pvx-mg-svg');
            if (!svgRoot) { svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-mg-svg' }, host); }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var maxP = U.clamp(parseInt(cfg.MaxPointers, 10) || 8, 1, 12);
            var used = rows.slice(0, maxP);
            var colors = colorsFor(cfg, used.length);
            var ptrs = [], i;
            var bad = [];
            scope.pvx.error = '';
            for (i = 0; i < used.length; i++) {
                var v = PVX.data.statValue(used[i], cfg);
                ptrs.push({ v: U.isNum(v) ? v : null, row: used[i], color: colors[i] });
                if (!U.isNum(v)) { bad.push(used[i].label); }
                if (!used[i].good && !scope.pvx.error) { scope.pvx.error = used[i].label + ': ' + (used[i].errorDescription || 'bad data'); }
            }

            var b = bounds(cfg, ptrs);
            var min = b[0], max = b[1], span = (max - min) || 1;
            var invert = !!cfg.InvertScale;
            var fracOf = function (val) {
                var f = U.clamp((val - min) / span, 0, 1);
                return invert ? 1 - f : f;
            };

            var outside = [];
            for (i = 0; i < ptrs.length; i++) {
                if (ptrs[i].v !== null && (ptrs[i].v < min - span * 1e-9 || ptrs[i].v > max + span * 1e-9)) {
                    outside.push(ptrs[i].row.label);
                    ptrs[i].pinned = true;
                }
            }

            var bands = cfg.UseThresholds ? PVX.thresholds.bands(cfg.Thresholds, min, max) : [];
            var lead = ptrs.length && ptrs[0].v !== null ? ptrs[0].v : null;
            var activeBand = cfg.UseThresholds && lead !== null ? PVX.thresholds.evaluate(cfg.Thresholds, lead) : null;
            var edges = [];
            if (cfg.TicksAtBands) { for (i = 0; i < bands.length; i++) { edges.push(bands[i].from); } }
            var ticks = PVX.scale.gaugeTicks(min, max, U.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12),
                { bandEdges: edges, minorPer: cfg.MinorTicks });

            var bandOpacity = function (bd) {
                var op = U.num(cfg.BandOpacity);
                if (op === null) { op = 0.28; }
                if (!cfg.HighlightActiveBand) { return op; }
                var on = activeBand && lead >= bd.from && (lead < bd.to || bd.to === max);
                return on ? Math.min(1, Math.max(op * 2.2, 0.6)) : op * 0.4;
            };

            var g = { svg: svgRoot, t: t, cfg: cfg, W: W, H: H, ptrs: ptrs, bands: bands, ticks: ticks,
                      fracOf: fracOf, bandOpacity: bandOpacity, min: min, max: max };
            if (!ptrs.length) {
                PVX.svg.fit(PVX.svg.text(svgRoot, (W / 2).toFixed(1), (H / 2).toFixed(1), 'Add the values to compare as data sources', {
                    'class': 'pvx-svg-label', 'text-anchor': 'middle', 'dominant-baseline': 'central',
                    'font-size': U.clamp(Math.min(W, H) / 16, 9, 12), fill: t.textMuted
                }), W - 8);
            } else if (cfg.Shape === 'linear') {
                drawLinear(g);
            } else {
                drawRadial(g);
            }

            // ---- readout and notes ----------------------------------------------
            var numOpts = PVX.config.numberOpts(cfg);
            scope.pvx.readout = cfg.ShowReadout === false ? [] : ptrs.map(function (p) {
                var units = cfg.ShowUnits !== false && p.row.units ? ' ' + p.row.units : '';
                return {
                    label: p.row.label, color: p.color,
                    value: p.v === null ? (p.row.raw === null || p.row.raw === undefined ? '--' : String(p.row.raw)) :
                        PVX.fmt.number(p.v, numOpts) + units,
                    flag: p.v === null ? 'not a number: no pointer' : p.pinned ? 'outside the scale' : ''
                };
            });
            // The readout may take 40% of the symbol (styles.css). Rows it
            // cannot hold would be cut by its overflow:hidden with nothing to
            // say so, so they are left out and counted in the footer.
            var box = c.node || {};
            var totW = box.clientWidth || W, totH = box.clientHeight || H;
            var perCol = Math.floor((totH * 0.4 - 6 + 2) / 18);
            var cols = Math.max(1, Math.floor((totW - 16 + 12) / 152));
            var cap = Math.max(0, perCol) * cols;
            var cut = 0;
            if (scope.pvx.readout.length > cap) {
                cut = scope.pvx.readout.length - cap;
                scope.pvx.readout = scope.pvx.readout.slice(0, cap);
            }
            var notes = [];
            if (cut) { notes.push(cut + ' value' + (cut === 1 ? '' : 's') + ' not listed: too small; hover the pointers'); }
            if (bad.length) { notes.push(bad.length + ' not numeric, no pointer'); }
            if (outside.length) { notes.push(outside.length + ' outside the scale, pinned to the end'); }
            if (rows.length > used.length) { notes.push((rows.length - used.length) + ' more sources not shown'); }
            if (cfg.ScaleMode === 'auto' && ptrs.length) {
                notes.push('scale ' + PVX.fmt.tick(min) + ' to ' + PVX.fmt.tick(max) + ' from the values');
            }
            scope.pvx.note = notes.join(' · ');
            scope.pvx.title = cfg.Title || '';
            digest();
        }

        /* ------------------------------------------------------------------ *
         * radial
         * ------------------------------------------------------------------ */

        function drawRadial(g) {
            var cfg = g.cfg, t = g.t, svg = g.svg;
            var startA = U.num(cfg.StartAngle), endA = U.num(cfg.EndAngle);
            if (startA === null) { startA = -120; }
            if (endA === null || endA <= startA) { endA = startA + 240; }
            var sweep = Math.min(endA - startA, 360);
            endA = startA + sweep;
            var angle = function (val) { return startA + g.fracOf(val) * sweep; };

            var box = arcBox(startA, endA);
            var pad = 8;
            var r = Math.max(10, Math.min((g.W - pad * 2) / box.w, (g.H - pad * 2) / box.h));
            var cx = pad + (-box.x0) * r + (g.W - pad * 2 - box.w * r) / 2;
            var cy = pad + (-box.y0) * r + (g.H - pad * 2 - box.h * r) / 2;
            var style = /^(needle|marker|ring)$/.test(cfg.PointerStyle) ? cfg.PointerStyle : 'needle';
            var markerRoom = style === 'marker' ? Math.max(5, r * 0.07) : 0;
            var rOuter = r - markerRoom;
            var thick = U.clamp(r * 0.11, 4, 26);
            var rInner = rOuter - thick;
            var font = U.clamp(r * 0.12, 7, 13);
            var i;

            PVX.svg.el('path', { d: PVX.svg.annulus(cx, cy, rInner, rOuter, startA, endA), fill: t.track, 'class': 'pvx-mg-track' }, svg);
            if (cfg.ShowBands !== false) {
                for (i = 0; i < g.bands.length; i++) {
                    var a0 = Math.min(angle(g.bands[i].from), angle(g.bands[i].to));
                    var a1 = Math.max(angle(g.bands[i].from), angle(g.bands[i].to));
                    if (a1 - a0 < 0.2) { continue; }
                    PVX.svg.el('path', {
                        d: PVX.svg.annulus(cx, cy, rInner, rOuter, a0, a1),
                        fill: PVX.color.rgba(g.bands[i].color, g.bandOpacity(g.bands[i])), 'class': 'pvx-mg-band'
                    }, svg);
                }
            }

            // ticks, inside the arc
            var tickLen = Math.max(3, r * 0.05);
            for (i = 0; i < g.ticks.minor.length; i++) {
                tick(angle(g.ticks.minor[i]), tickLen * 0.55, 0.75);
            }
            for (i = 0; i < g.ticks.major.length; i++) {
                var ta = angle(g.ticks.major[i].v);
                tick(ta, tickLen, 1);
                if (cfg.ShowScaleLabels !== false && r >= 40) {
                    var lp = PVX.svg.polar(cx, cy, rInner - tickLen - font * 0.95, ta);
                    PVX.svg.text(svg, lp.x.toFixed(2), lp.y.toFixed(2), PVX.fmt.tick(g.ticks.major[i].v), {
                        'class': 'pvx-svg-label pvx-num', 'text-anchor': 'middle', 'dominant-baseline': 'central',
                        'font-size': font.toFixed(1), fill: t.textMuted
                    });
                }
            }
            function tick(a, len, w) {
                var p1 = PVX.svg.polar(cx, cy, rInner - 1, a), p2 = PVX.svg.polar(cx, cy, rInner - 1 - len, a);
                PVX.svg.el('line', {
                    x1: p1.x.toFixed(2), y1: p1.y.toFixed(2), x2: p2.x.toFixed(2), y2: p2.y.toFixed(2),
                    stroke: t.axis, 'stroke-width': w, 'class': 'pvx-grid-line'
                }, svg);
            }

            // pointers
            var ptrs = g.ptrs;
            if (style === 'ring') {
                // One thin ring per source inside the scale, filled from the
                // minimum, the way a set of progress rings reads.
                var room = Math.max(4, rInner - tickLen - font * 2.2 - r * 0.12);
                var rw = Math.max(2, Math.min(thick * 0.7, room / Math.max(1, ptrs.length) * 0.8));
                var from = g.fracOf(g.min) === 0 ? startA : endA;
                for (i = 0; i < ptrs.length; i++) {
                    var ro = rInner - tickLen - font * 2.2 - i * rw * 1.25;
                    if (ro - rw < 2) { break; }
                    PVX.svg.el('path', { d: PVX.svg.annulus(cx, cy, ro - rw, ro, startA, endA), fill: t.track, 'class': 'pvx-mg-ringtrack' }, svg);
                    if (ptrs[i].v === null) { continue; }
                    var va = angle(ptrs[i].v);
                    if (Math.abs(va - from) < 0.2) { continue; }
                    titled(PVX.svg.el('path', {
                        d: PVX.svg.annulus(cx, cy, ro - rw, ro, Math.min(from, va), Math.max(from, va)),
                        fill: ptrs[i].color, 'class': 'pvx-mg-ring'
                    }, svg), ptrs[i]);
                }
            } else if (style === 'marker') {
                for (i = 0; i < ptrs.length; i++) {
                    if (ptrs[i].v === null) { continue; }
                    var ma = angle(ptrs[i].v);
                    var tip = PVX.svg.polar(cx, cy, rOuter - thick * 0.35, ma);
                    var bl = PVX.svg.polar(cx, cy, r + 1, ma - markerRoom * 70 / r);
                    var br = PVX.svg.polar(cx, cy, r + 1, ma + markerRoom * 70 / r);
                    titled(PVX.svg.el('path', {
                        d: 'M' + tip.x.toFixed(2) + ' ' + tip.y.toFixed(2) + ' L' + bl.x.toFixed(2) + ' ' + bl.y.toFixed(2) +
                           ' L' + br.x.toFixed(2) + ' ' + br.y.toFixed(2) + ' Z',
                        fill: ptrs[i].color, stroke: t.surface === 'transparent' ? 'none' : t.surface,
                        'stroke-width': 1, 'class': 'pvx-mg-marker'
                    }, svg), ptrs[i]);
                }
            } else {
                var baseW = Math.max(1.5, r * 0.025);
                // Drawn last-first so source 1's needle is on top.
                for (i = ptrs.length - 1; i >= 0; i--) {
                    if (ptrs[i].v === null) { continue; }
                    var na = angle(ptrs[i].v);
                    var ntip = PVX.svg.polar(cx, cy, rOuter - 1, na);
                    var nl = PVX.svg.polar(cx, cy, baseW, na - 90), nr = PVX.svg.polar(cx, cy, baseW, na + 90);
                    titled(PVX.svg.el('path', {
                        d: 'M' + nl.x.toFixed(2) + ' ' + nl.y.toFixed(2) + ' L' + ntip.x.toFixed(2) + ' ' + ntip.y.toFixed(2) +
                           ' L' + nr.x.toFixed(2) + ' ' + nr.y.toFixed(2) + ' Z',
                        fill: ptrs[i].color, 'class': 'pvx-mg-needle'
                    }, svg), ptrs[i]);
                }
                PVX.svg.el('circle', {
                    cx: cx.toFixed(2), cy: cy.toFixed(2), r: (baseW * 2).toFixed(2),
                    fill: t.surface === 'transparent' ? t.text : t.surface, stroke: t.text, 'stroke-width': 1.25
                }, svg);
            }
        }

        function arcBox(startDeg, endDeg) {
            var xs = [0], ys = [0];
            var push = function (deg) { var p = PVX.svg.polar(0, 0, 1, deg); xs.push(p.x); ys.push(p.y); };
            push(startDeg); push(endDeg);
            for (var a = Math.ceil(startDeg / 90) * 90; a <= endDeg; a += 90) { push(a); }
            var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
            var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
            return { x0: x0, y0: y0, w: Math.max(0.2, x1 - x0), h: Math.max(0.2, y1 - y0) };
        }

        /* ------------------------------------------------------------------ *
         * linear
         * ------------------------------------------------------------------ */

        function drawLinear(g) {
            var cfg = g.cfg, t = g.t, svg = g.svg;
            var vert = cfg.Orientation === 'vertical';
            var style = cfg.PointerStyle === 'bar' ? 'bar' : 'marker';
            var ptrs = g.ptrs;
            var along = vert ? g.H : g.W, across = vert ? g.W : g.H;
            var font = U.clamp(across / 9, 7, 12);
            var padA = font * 1.8;
            var L = Math.max(10, along - padA * 2);
            var mark = style === 'marker' ? U.clamp(across * 0.1, 5, 11) : 0;
            var trackT = style === 'bar' ? U.clamp(across * 0.5, 6, across - font * 3) : U.clamp(across * 0.22, 4, 24);
            var block = mark + trackT + 4 + font * 1.6;
            var v0 = Math.max(2, (across - block) / 2) + mark;
            var uOf = function (val) { return g.fracOf(val) * L; };
            // (u along, v across) to screen; vertical runs bottom-up.
            var P = function (u, v) { return vert ? { x: v, y: g.H - padA - u } : { x: padA + u, y: v }; };
            var R = function (u, v, du, dv, attrs) {
                var a = attrs || {};
                var p = vert ? { x: v, y: g.H - padA - u - du, w: dv, h: du } : { x: padA + u, y: v, w: du, h: dv };
                a.x = p.x.toFixed(2); a.y = p.y.toFixed(2);
                a.width = Math.max(0, p.w).toFixed(2); a.height = Math.max(0, p.h).toFixed(2);
                return PVX.svg.el('rect', a, svg);
            };
            var i;

            R(0, v0, L, trackT, { fill: t.track, rx: 3, 'class': 'pvx-mg-track' });
            if (cfg.ShowBands !== false) {
                for (i = 0; i < g.bands.length; i++) {
                    var u0 = Math.min(uOf(g.bands[i].from), uOf(g.bands[i].to));
                    var u1 = Math.max(uOf(g.bands[i].from), uOf(g.bands[i].to));
                    if (u1 - u0 < 0.3) { continue; }
                    R(u0, v0, u1 - u0, trackT, { fill: PVX.color.rgba(g.bands[i].color, g.bandOpacity(g.bands[i])), 'class': 'pvx-mg-band' });
                }
            }

            if (style === 'bar') {
                var n = Math.max(1, ptrs.length);
                var lane = trackT / n;
                var zeroU = g.fracOf(g.min) === 0 ? 0 : L;
                for (i = 0; i < ptrs.length; i++) {
                    if (ptrs[i].v === null) { continue; }
                    var pu = uOf(ptrs[i].v);
                    titled(R(Math.min(zeroU, pu), v0 + i * lane + lane * 0.15, Math.abs(pu - zeroU), lane * 0.7,
                        { fill: ptrs[i].color, 'class': 'pvx-mg-bar' }), ptrs[i]);
                }
            } else {
                for (i = ptrs.length - 1; i >= 0; i--) {
                    if (ptrs[i].v === null) { continue; }
                    var mu = uOf(ptrs[i].v);
                    var tip = P(mu, v0 + trackT * 0.45), l = P(mu - mark * 0.6, v0 - mark), r = P(mu + mark * 0.6, v0 - mark);
                    titled(PVX.svg.el('path', {
                        d: 'M' + tip.x.toFixed(2) + ' ' + tip.y.toFixed(2) + ' L' + l.x.toFixed(2) + ' ' + l.y.toFixed(2) +
                           ' L' + r.x.toFixed(2) + ' ' + r.y.toFixed(2) + ' Z',
                        fill: ptrs[i].color, stroke: t.surface === 'transparent' ? 'none' : t.surface,
                        'stroke-width': 1, 'class': 'pvx-mg-marker'
                    }, svg), ptrs[i]);
                }
            }

            // ticks below (or right of) the track
            var tv0 = v0 + trackT + 1, tickLen = Math.max(3, font * 0.45);
            for (i = 0; i < g.ticks.minor.length; i++) { tickAt(uOf(g.ticks.minor[i]), tickLen * 0.55, 0.75); }
            var lastEnd = -Infinity;
            var majors = g.ticks.major.slice();
            if (cfg.InvertScale) { majors.reverse(); }
            for (i = 0; i < majors.length; i++) {
                var tu = uOf(majors[i].v);
                tickAt(tu, tickLen, 1);
                if (cfg.ShowScaleLabels === false) { continue; }
                var txt = PVX.fmt.tick(majors[i].v);
                var ext = vert ? font * 1.2 : txt.length * font * 0.6;
                // Crowded labels give way, keeping the scale readable.
                if (tu - ext / 2 < lastEnd + font * 0.4) { continue; }
                lastEnd = tu + ext / 2;
                var lp = P(tu, tv0 + tickLen + 2 + (vert ? 0 : font * 0.5));
                PVX.svg.text(svg, lp.x.toFixed(2), lp.y.toFixed(2), txt, {
                    'class': 'pvx-svg-label pvx-num', 'text-anchor': vert ? 'start' : 'middle', 'dominant-baseline': 'central',
                    'font-size': font.toFixed(1), fill: t.textMuted
                });
            }
            function tickAt(u, len, w) {
                var a = P(u, tv0), b = P(u, tv0 + len);
                PVX.svg.el('line', {
                    x1: a.x.toFixed(2), y1: a.y.toFixed(2), x2: b.x.toFixed(2), y2: b.y.toFixed(2),
                    stroke: t.axis, 'stroke-width': w, 'class': 'pvx-grid-line'
                }, svg);
            }
        }

        function titled(node, p) {
            var units = p.row.units ? ' ' + p.row.units : '';
            PVX.svg.el('title', null, node).textContent = p.row.label + ': ' +
                PVX.fmt.number(p.v, PVX.config.numberOpts(ctx.config || {})) + units +
                (p.pinned ? ' (outside the scale)' : '');
            return node;
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
