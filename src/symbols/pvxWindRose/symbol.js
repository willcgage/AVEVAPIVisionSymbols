/* ============================================================================
 * pvxWindRose — wind rose (stacked polar bars) for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources; the FIRST is direction in
 * degrees, the SECOND is speed)
 *
 * The question this symbol answers is "where does it blow from, and how hard".
 * Each sector is a direction, its length is the share of the display's time
 * range the wind held that direction, and the bar is split into speed bands
 * colored by the shared threshold grammar. A met mast at a compressor
 * station, a flare stack, a cooling tower: dispersion, odour and drift
 * questions are direction questions, and a trend of a 0-360 tag cannot answer
 * them because north is at both the top and the bottom of its axis.
 *
 * Bar length can be percent of time, hours, or 100% per direction (percent
 * stacked), which shows only the speed mix within each sector. With bands
 * turned off it is a plain polar bar chart, and with direction alone it is a
 * direction histogram, so this one symbol covers polar, stacked polar and
 * percent stacked polar.
 *
 * Samples are weighted by TIME, not counted. Plot values crowd into changes
 * and thin out in steady running, so a point count would paint a gusty
 * half hour as the prevailing wind. Each sample is credited with the time
 * until the next one, capped at MaxPairGapSeconds so a data outage is not
 * credited to the direction that preceded it. Direction is never
 * interpolated between samples: it wraps at north, and the straight-line
 * average of 350° and 10° is south.
 * @mock wind
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var SECTOR_CHOICES = [4, 8, 12, 16, 24, 36];

    /* Compass names for the sector counts that have them. A 12-, 24- or
     * 36-sector rose has no names for most of its sectors, so it labels the
     * four cardinal points only and the tooltips carry degrees. */
    var NAMES16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                   'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

    var definition = {
        typeName: 'pvxWindRose',
        displayName: 'PVX Wind Rose',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // A collection repeats the symbol once per asset and rebinds each copy to
        // that asset's own attributes: one chart per unit, built once.
        supportsCollections: true,
        configTitle: 'Format Wind Rose',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 600,
                Height: 300,
                Width: 380,

                Title: '',                   // blank => the speed (or direction) attribute name
                Sectors: '16',               // 4 | 8 | 12 | 16 | 24 | 36
                Measure: 'percent',          // percent | hours | normalized (100% per direction)
                DirectionIs: 'from',         // from | to
                CalmBelow: '0.5',            // speed units; blank => no calm class
                MaxPairGapSeconds: 0,        // 0 => no limit, as PI holds a value until the next
                RingCount: 4,
                PadAngle: 1.5,               // degrees of gap between sectors
                ShowCompass: true,
                LegendPosition: 'auto',      // auto | right | bottom | none

                // Speed bands on a scale that suits m/s. The shared default
                // (0-100) would put every real wind speed in one band.
                Thresholds: '0:#c6dbef, 2:#79b3dc, 4:#3b82c4, 6:#d99024, 8:#c8452f',
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            title: '',
            countText: '',
            note: '',
            error: ''
        };

        // Derived once per data update (and per gap change), reused across
        // resize renders. Binning depends on sectors, bands and calm, which
        // are cheap, so it happens in render from these samples.
        var model = {
            dirSeries: null,
            spdSeries: null,
            extraCount: 0,
            samples: [],      // [{d, s (null without speed), t, w ms, bad}]
            unpaired: 0,      // speed samples with no direction recent enough
            badMs: 0,         // time held by a bad value or an unpaired sample
            gapMs: 0          // time not credited because samples were too far apart
        };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-wr-body',

            // stateSeries, not series: series() drops a non-numeric sample, so
            // an "I/O Timeout" would vanish and the direction before it would
            // be credited with the whole outage. Kept, it ends that hold.
            onData: function (d) {
                var all = PVX.data.stateSeries(d);
                model.dirSeries = all.length > 0 ? all[0] : null;
                model.spdSeries = all.length > 1 ? all[1] : null;
                model.extraCount = Math.max(0, all.length - 2);
                rebuild(ctx.config || scope.config || {});
            },

            // The gap limit changes the weights, not just the drawing.
            onConfigChange: function (newCfg) {
                rebuild(newCfg || {});
            },

            render: render
        });

        /* ------------------------------------------------------------------ *
         * samples and weights
         * ------------------------------------------------------------------ */

        function isGood(pt) {
            return pt.v !== null && pt.good !== false;
        }

        function rebuild(cfg) {
            var gapSec = PVX.util.num(cfg.MaxPairGapSeconds);
            var maxGapMs = gapSec > 0 ? gapSec * 1000 : Infinity;

            var dp = model.dirSeries ? model.dirSeries.points : [];
            var sp = model.spdSeries ? model.spdSeries.points : [];
            var raw = [], unpaired = 0, i;

            if (!model.spdSeries) {
                for (i = 0; i < dp.length; i++) {
                    raw.push({ d: dp[i].v, s: null, t: dp[i].t, bad: !isGood(dp[i]) });
                }
            } else if (dp.length) {
                // For each speed sample, the direction in force at that instant
                // (last known value), walked forward only: O(nd + ns). A speed
                // sample with no usable direction still goes in, as a bad
                // sample, so it ends the hold of the sample before it.
                var j = 0;
                for (i = 0; i < sp.length; i++) {
                    var st = sp[i].t;
                    while (j + 1 < dp.length && dp[j + 1].t <= st) { j++; }
                    if (dp[j].t > st) { unpaired++; continue; }
                    var stale = st - dp[j].t > maxGapMs;
                    if (stale) { unpaired++; }
                    raw.push({ d: dp[j].v, s: sp[i].v, t: st,
                               bad: stale || !isGood(dp[j]) || !isGood(sp[i]) });
                }
            } else {
                unpaired = sp.length;
            }

            // Each sample holds until the next one, capped. The last sample has
            // no successor; it gets the median hold, which is what the next
            // sample would most likely have given it.
            var holds = [], gapMs = 0, badMs = 0;
            for (i = 0; i + 1 < raw.length; i++) {
                var dt = raw[i + 1].t - raw[i].t;
                if (!(dt > 0)) { dt = 0; }
                if (dt > maxGapMs) { gapMs += dt - maxGapMs; dt = maxGapMs; }
                raw[i].w = dt;
                if (dt > 0) { holds.push(dt); }
            }
            if (raw.length) {
                holds.sort(function (a, b) { return a - b; });
                var med = holds.length ? holds[Math.floor(holds.length / 2)] : 60000;
                raw[raw.length - 1].w = Math.min(med, maxGapMs);
            }
            for (i = 0; i < raw.length; i++) {
                if (raw[i].bad) { badMs += raw[i].w; }
            }

            model.samples = raw;
            model.unpaired = unpaired;
            model.badMs = badMs;
            model.gapMs = gapMs;
        }

        function sectorCount(cfg) {
            var n = parseInt(cfg.Sectors, 10);
            return SECTOR_CHOICES.indexOf(n) >= 0 ? n : 16;
        }

        /** Speed bands as drawn: [{lo, hi, color, label}] lowest first. */
        function speedBands(cfg, t, units) {
            var accent = cfg.AccentColor || '#3b82c4';
            if (!model.spdSeries || cfg.UseThresholds === false) {
                return [{ lo: -Infinity, hi: Infinity, color: accent,
                          label: model.spdSeries ? 'All speeds' : 'Time share' }];
            }
            var list = PVX.thresholds.parse(cfg.Thresholds);
            if (!list.length) {
                return [{ lo: -Infinity, hi: Infinity, color: accent, label: 'All speeds' }];
            }
            var u = units ? ' ' + units : '';
            var out = [];
            for (var i = 0; i < list.length; i++) {
                var lo = list[i].value;
                var hi = i + 1 < list.length ? list[i + 1].value : Infinity;
                out.push({
                    lo: lo, hi: hi,
                    color: list[i].color || accent,
                    label: list[i].label || (hi === Infinity
                        ? PVX.fmt.tick(lo) + '+' + u
                        : PVX.fmt.tick(lo) + '–' + PVX.fmt.tick(hi) + u)
                });
            }
            return out;
        }

        /**
         * Fold the samples into sectors x bands. Calm and below-the-lowest-band
         * time stay in the total, so the sectors' percentages are shares of all
         * the time covered and the footer can say where the rest went.
         */
        function bin(cfg, n, bands) {
            var width = 360 / n;
            var rot = cfg.DirectionIs === 'to' ? 180 : 0;
            var calmBelow = model.spdSeries ? PVX.util.num(cfg.CalmBelow) : null;
            var grid = [], sectorTot = [], bandTot = [], i, k;
            for (i = 0; i < n; i++) {
                var row = [];
                for (k = 0; k < bands.length; k++) { row.push(0); }
                grid.push(row);
                sectorTot.push(0);
            }
            for (k = 0; k < bands.length; k++) { bandTot.push(0); }

            var total = 0, calm = 0, below = 0;
            for (i = 0; i < model.samples.length; i++) {
                var smp = model.samples[i];
                var w = smp.w;
                if (smp.bad || !(w > 0)) { continue; }
                total += w;
                if (smp.s !== null && calmBelow !== null && smp.s < calmBelow) { calm += w; continue; }
                var b = -1;
                if (smp.s === null) {
                    b = 0;
                } else {
                    for (k = 0; k < bands.length; k++) {
                        if (smp.s >= bands[k].lo && smp.s < bands[k].hi) { b = k; break; }
                    }
                }
                if (b < 0) { below += w; continue; }
                var dir = (((smp.d + rot) % 360) + 360) % 360;
                // Sectors are centred on their direction: north spans
                // -width/2 .. +width/2, not 0 .. width.
                var s = Math.floor((dir + width / 2) / width) % n;
                grid[s][b] += w;
                sectorTot[s] += w;
                bandTot[b] += w;
            }
            return { grid: grid, sectorTot: sectorTot, bandTot: bandTot,
                     total: total, calm: calm, below: below, width: width };
        }

        function sectorName(n, s) {
            if (n === 16) { return NAMES16[s]; }
            if (n === 8) { return NAMES16[s * 2]; }
            if (n === 4) { return NAMES16[s * 4]; }
            return '';
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

            var svgRoot = host.querySelector('svg.pvx-wr-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-wr-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var ds = model.dirSeries, ss = model.spdSeries;
            scope.pvx.title = cfg.Title ||
                (ss ? (ss.label || 'Speed') : (ds ? (ds.label || 'Direction') : 'Wind rose'));
            scope.pvx.error = '';
            if (ds && !ds.good) { scope.pvx.error = ds.errorDescription || 'Bad data on direction'; }
            else if (ss && !ss.good) { scope.pvx.error = ss.errorDescription || 'Bad data on speed'; }

            if (!ds) {
                scope.pvx.countText = '';
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, 'Direction data source required',
                    'Drop the direction first, then the speed.');
                digest();
                return;
            }

            var n = sectorCount(cfg);
            var units = ss ? ss.units : '';
            var bands = speedBands(cfg, t, units);
            var b = bin(cfg, n, bands);
            var notes = [];
            if (model.unpaired) { notes.push(model.unpaired + ' speed samples had no direction'); }
            if (model.extraCount) {
                notes.push(model.extraCount + ' extra source' + (model.extraCount > 1 ? 's' : '') + ' ignored');
            }

            if (!(b.total > 0)) {
                scope.pvx.countText = '';
                scope.pvx.note = notes.join(' · ');
                emptyState(svgRoot, W, H, t, 'No samples in range',
                    ss ? 'Direction and speed never overlap in this time range.' : 'The direction tag has no values here.');
                digest();
                return;
            }

            var measure = cfg.Measure === 'hours' || cfg.Measure === 'normalized' ? cfg.Measure : 'percent';
            scope.pvx.countText = PVX.fmt.duration(b.total, { style: 'hours' }) + ' covered';
            if (b.calm > 0) { notes.unshift('calm ' + pctText(100 * b.calm / b.total)); }
            if (b.below > 0) {
                notes.push(pctText(100 * b.below / b.total) + ' below the lowest band, not drawn');
            }
            if (model.badMs > 0) {
                notes.push(PVX.fmt.duration(model.badMs, { style: 'hours' }) + ' of bad or unpaired values not counted');
            }
            if (model.gapMs > 0) {
                notes.push(PVX.fmt.duration(model.gapMs, { style: 'hours' }) + ' in data gaps not counted');
            }
            scope.pvx.note = notes.join(' · ');

            /** Bar length of one band in one sector, in the measure's units. */
            function value(ms, s) {
                if (measure === 'hours') { return ms / 3600000; }
                if (measure === 'normalized') { return b.sectorTot[s] > 0 ? 100 * ms / b.sectorTot[s] : 0; }
                return 100 * ms / b.total;
            }

            var maxV = 0, s, k;
            for (s = 0; s < n; s++) {
                var len = value(b.sectorTot[s], s);
                if (len > maxV) { maxV = len; }
            }
            if (measure === 'normalized') { maxV = 100; }
            var ringCount = PVX.util.clamp(parseInt(cfg.RingCount, 10) || 4, 2, 8);
            var dom = measure === 'normalized' ? [0, 100] : PVX.scale.niceDomain(0, maxV || 1, ringCount);
            var rings = PVX.scale.ticks(0, dom[1], ringCount).filter(function (v) { return v > 0; });

            // ---- layout -----------------------------------------------------
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var showCompass = cfg.ShowCompass !== false && Math.min(W, H) >= 110;
            var compassPad = showCompass ? font * 1.5 : 2;
            var legendPos = resolveLegendPos(cfg, W, H, bands.length);
            var pad = 6;

            var legend = { w: 0, h: 0, items: [] };
            var rowH = font * 1.5;
            if (legendPos !== 'none') {
                legend.items = legendWidths(svgRoot, bands, b, font);
            }
            if (legendPos === 'right') {
                legend.w = Math.min(W * 0.45, Math.max.apply(null, legend.items));
            } else if (legendPos === 'bottom') {
                legend.h = rowH * legendRows(legend.items, W - pad * 2) + 2;
            }

            var areaW = W - pad * 2 - (legend.w ? legend.w + font : 0);
            var areaH = H - pad * 2 - legend.h;
            var rOuter = Math.max(8, Math.min(areaW, areaH) / 2 - compassPad);
            var cx = pad + areaW / 2;
            var cy = pad + areaH / 2;
            // A rose beside its legend is one block; centre the block, not
            // the rose, or a wide symbol shows a rose with its legend adrift.
            if (legend.w) {
                var blockW = (rOuter + compassPad) * 2 + font + legend.w;
                cx = Math.max(pad, (W - blockW) / 2) + rOuter + compassPad;
            }
            var r0 = rOuter * 0.06;
            var rScale = function (v) { return r0 + (rOuter - r0) * Math.max(0, v) / dom[1]; };

            // ---- rings and spokes ---------------------------------------------
            var i;
            for (i = 0; i < rings.length; i++) {
                PVX.svg.el('circle', {
                    cx: cx.toFixed(2), cy: cy.toFixed(2), r: rScale(rings[i]).toFixed(2),
                    fill: 'none', stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-wr-ring'
                }, svgRoot);
            }
            var spokes = n <= 16 ? n : 8;
            for (i = 0; i < spokes; i++) {
                var sp = PVX.svg.polar(cx, cy, rOuter, i * 360 / spokes);
                PVX.svg.el('line', {
                    x1: cx.toFixed(2), y1: cy.toFixed(2), x2: sp.x.toFixed(2), y2: sp.y.toFixed(2),
                    stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-wr-spoke'
                }, svgRoot);
            }

            // ---- wedges ---------------------------------------------------------
            var padDeg = PVX.util.num(cfg.PadAngle);
            padDeg = padDeg === null ? 1.5 : PVX.util.clamp(padDeg, 0, b.width * 0.6);
            var half = b.width / 2 - padDeg / 2;
            var u = units ? ' ' + units : '';
            var dirWord = cfg.DirectionIs === 'to' ? 'toward ' : 'from ';
            var numOpts = PVX.config.numberOpts(cfg);
            for (s = 0; s < n; s++) {
                if (!(b.sectorTot[s] > 0)) { continue; }
                var centre = s * b.width;
                var acc = 0;
                var name = sectorName(n, s);
                var span = fmtDeg(centre - b.width / 2) + '–' + fmtDeg(centre + b.width / 2);
                for (k = 0; k < bands.length; k++) {
                    var ms = b.grid[s][k];
                    if (!(ms > 0)) { continue; }
                    var v0 = acc, v1 = acc + value(ms, s);
                    acc = v1;
                    var ra = rScale(v0), rb = rScale(v1);
                    if (rb - ra < 0.3) { continue; }
                    var path = PVX.svg.el('path', {
                        d: PVX.svg.annulus(cx, cy, ra, rb, centre - half, centre + half),
                        fill: bands[k].color,
                        stroke: t.surface && t.surface !== 'transparent' ? t.surface : 'none',
                        'stroke-width': 0.5,
                        'class': 'pvx-wr-wedge'
                    }, svgRoot);
                    var tip = PVX.svg.el('title', null, path);
                    tip.textContent = dirWord + (name ? name + ' (' + span + ')' : span) + '\n' +
                        (bands.length > 1 || ss ? bands[k].label + '\n' : '') +
                        pctText(100 * ms / b.total) + ' of the time, ' +
                        PVX.fmt.duration(ms, { style: 'hours' }) +
                        (measure === 'normalized' ? '\n' + pctText(100 * ms / b.sectorTot[s]) + ' of this direction' : '');
                }
            }

            // Calm sits at the centre: it has no direction to be drawn in.
            if (b.calm > 0 && r0 >= 1.5) {
                var hub = PVX.svg.el('circle', {
                    cx: cx.toFixed(2), cy: cy.toFixed(2), r: r0.toFixed(2),
                    fill: t.surfaceAlt || t.grid, stroke: t.axis, 'stroke-width': 0.75, 'class': 'pvx-wr-calm'
                }, svgRoot);
                PVX.svg.el('title', null, hub).textContent =
                    'Calm (below ' + PVX.fmt.number(PVX.util.num(cfg.CalmBelow), numOpts) + u + '): ' +
                    pctText(100 * b.calm / b.total);
            }

            // ---- ring labels ------------------------------------------------------
            // Along the bisector of the NNE gap, where a label clips the fewest
            // petals; a halo keeps it readable where it does cross one.
            if (rOuter >= 45) {
                var labelAngle = b.width / 2;
                var halo = (t.surface && t.surface !== 'transparent') ? t.surface : (t.dark ? '#1d2126' : '#ffffff');
                for (i = 0; i < rings.length; i++) {
                    var lp = PVX.svg.polar(cx, cy, rScale(rings[i]), labelAngle);
                    PVX.svg.text(svgRoot, (lp.x + 2).toFixed(2), (lp.y - 2).toFixed(2), ringText(rings[i], measure), {
                        'class': 'pvx-svg-label pvx-wr-ring-label', 'font-size': (font * 0.85).toFixed(1),
                        fill: t.textMuted, stroke: halo, 'stroke-width': 2.5, 'paint-order': 'stroke',
                        'stroke-linejoin': 'round'
                    });
                }
            }

            // ---- compass -------------------------------------------------------------
            if (showCompass) {
                var pts = [0, 90, 180, 270];
                if (rOuter >= 70 && (n === 8 || n === 16)) { pts = [0, 45, 90, 135, 180, 225, 270, 315]; }
                for (i = 0; i < pts.length; i++) {
                    var cp = PVX.svg.polar(cx, cy, rOuter + font * 0.85, pts[i]);
                    PVX.svg.text(svgRoot, cp.x.toFixed(2), cp.y.toFixed(2), NAMES16[pts[i] / 22.5], {
                        'class': 'pvx-svg-label pvx-wr-compass', 'text-anchor': 'middle',
                        'dominant-baseline': 'central', 'font-size': font, fill: t.text
                    });
                }
            }

            // ---- legend ----------------------------------------------------------------
            if (legendPos === 'right') {
                drawLegendRight(svgRoot, bands, b, t, font,
                    cx + rOuter + compassPad + font, legend.w, H);
            } else if (legendPos === 'bottom') {
                drawLegendBottom(svgRoot, bands, b, t, font, legend.items, pad, H - pad - legend.h + 2, W - pad * 2);
            }

            digest();
        }

        /* ------------------------------------------------------------------ *
         * render helpers
         * ------------------------------------------------------------------ */

        function fmtDeg(d) {
            var v = ((d % 360) + 360) % 360;
            return (Math.round(v * 10) / 10) + '°';
        }

        function pctText(pct) {
            return PVX.fmt.percent(pct, pct >= 9.95 ? 0 : 1);
        }

        function ringText(v, measure) {
            if (measure === 'hours') { return PVX.fmt.tick(v) + ' h'; }
            return PVX.fmt.tick(v) + '%';
        }

        function legendText(band, share) {
            return band.label + '  ' + pctText(100 * share);
        }

        /**
         * Each legend item's width (swatch, gap and text) as the browser will
         * draw it. An estimate from the character count ran short in practice
         * and cut the percentages off, which are the part worth reading.
         */
        function legendWidths(svgRoot, bands, b, font) {
            var out = [];
            for (var i = 0; i < bands.length; i++) {
                var probe = PVX.svg.text(svgRoot, 0, 0, legendText(bands[i], b.bandTot[i] / b.total), {
                    'class': 'pvx-svg-label pvx-num', 'font-size': font, visibility: 'hidden'
                });
                var w = 0;
                try { w = probe.getComputedTextLength(); } catch (e) { w = 0; }
                // Detached or unrendered hosts report 0; fall back to a
                // generous per-glyph guess rather than a zero-width legend.
                if (!(w > 0)) { w = probe.textContent.length * font * 0.62; }
                out.push(w + font * 0.9 + 7);
                svgRoot.removeChild(probe);
            }
            return out;
        }

        /**
         * A right legend on a squat symbol leaves the rose coin-sized, and a
         * bottom legend on a short one does the same from the other side.
         * One band says nothing a legend could add, so it gets none.
         */
        function resolveLegendPos(cfg, W, H, bandCount) {
            var want = cfg.LegendPosition || 'auto';
            if (want === 'none' || bandCount < 2 || Math.min(W, H) < 120) { return 'none'; }
            if (want === 'right' || want === 'bottom') { return want; }
            if (W >= H * 1.25 && W >= 240) { return 'right'; }
            if (H >= 200) { return 'bottom'; }
            return 'none';
        }

        function legendRows(items, width) {
            var x = 0, rows = 1;
            for (var i = 0; i < items.length; i++) {
                var w = items[i] + 12;
                if (x > 0 && x + w > width) { rows++; x = 0; }
                x += w;
            }
            return rows;
        }

        function drawLegendRight(svgRoot, bands, b, t, font, x, width, H) {
            var rowH = font * 1.5;
            var rows = Math.min(bands.length, Math.floor((H - 8) / rowH));
            var y = Math.max(4, (H - rows * rowH) / 2);
            // Highest speed at the top, matching the outward stacking.
            for (var r = 0; r < rows; r++) {
                var k = bands.length - 1 - r;
                drawLegendItem(svgRoot, bands[k], b.bandTot[k] / b.total, t, font, x, y + r * rowH, width);
            }
        }

        function drawLegendBottom(svgRoot, bands, b, t, font, items, x0, y0, width) {
            var rowH = font * 1.5, x = x0, y = y0;
            for (var k = 0; k < bands.length; k++) {
                var w = items[k] + 12;
                if (x > x0 && x + w > x0 + width) { x = x0; y += rowH; }
                drawLegendItem(svgRoot, bands[k], b.bandTot[k] / b.total, t, font, x, y, Math.min(w, width));
                x += w;
            }
        }

        function drawLegendItem(svgRoot, band, share, t, font, x, y, width) {
            var sw = font * 0.9;
            PVX.svg.el('rect', {
                x: x.toFixed(2), y: (y + (font * 1.5 - sw) / 2).toFixed(2),
                width: sw.toFixed(2), height: sw.toFixed(2), rx: 2,
                fill: band.color, 'class': 'pvx-wr-swatch'
            }, svgRoot);
            var node = PVX.svg.text(svgRoot, (x + sw + 5).toFixed(2), (y + font * 0.75).toFixed(2),
                legendText(band, share), {
                    'class': 'pvx-svg-label pvx-num', 'dominant-baseline': 'central',
                    'font-size': font, fill: t.text
                });
            fitTextTo(node, width - sw - 7);
        }

        /**
         * Trim a drawn label to maxPx with an ellipsis. Measured, not
         * estimated: glyph-width guesses run tight in Segoe UI, which is what
         * PI Vision ships, and a legend anchored to the right edge would spill
         * off the symbol rather than shorten.
         */
        function fitTextTo(node, maxPx) {
            if (!node || !node.getComputedTextLength) { return; }
            if (!(maxPx > 0)) { node.textContent = ''; return; }
            var measureW = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            for (var guard = 0; guard < 8; guard++) {
                var w = measureW();
                if (!(w > maxPx)) { return; }
                var cur = node.textContent || '';
                var core = cur.charAt(cur.length - 1) === '…' ? cur.slice(0, -1) : cur;
                if (core.length < 2) { node.textContent = ''; return; }
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return; }
                node.textContent = core.slice(0, keep) + '…';
            }
            if (measureW() > maxPx) { node.textContent = ''; }
        }

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);
            var h1 = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2), headline, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle',
                'font-size': font, 'font-weight': '600', fill: t.textMuted
            });
            fitTextTo(h1, W - 8);
            var h2 = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.7).toFixed(2), detail, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle',
                'font-size': font * 0.9, fill: t.textMuted, opacity: '0.8'
            });
            fitTextTo(h2, W - 8);
        }

        /* Renders run inside requestAnimationFrame, outside Angular's digest, and
         * this symbol writes the title/footer through scope bindings. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
