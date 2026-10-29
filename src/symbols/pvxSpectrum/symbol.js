/* ============================================================================
 * pvxSpectrum: "PVX Spectrum" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources; the one selected is analysed)
 * @mock spectrum
 *
 * Which cycles are in a signal, and how big each is: a loop hunting every
 * twenty minutes, a recycle rippling every seven, a machine at its running
 * speed. A trend shows them tangled together; a spectrum pulls them apart.
 *
 * The arithmetic is PVX.stats.spectrum (resample, detrend, window, FFT) and
 * PVX.stats.spectrumPeaks, so the test suite checks it against known sines.
 * This file chooses units and draws.
 *
 * WHICH SAMPLES. Recorded values (ModeEvents), never plot values: PI
 * Vision's plot values are the minimum and maximum of each pixel column,
 * which is a sawtooth at the screen's own resolution and would show up as a
 * peak that is not in the process. Recorded values are resampled onto an
 * even grid, because an FFT needs one; the footer says how many recorded
 * values made it, since a grid finer than the data shows interpolation.
 *
 * Bands with an alarm level mark a frequency range whose largest amplitude
 * must stay under a limit. They color the band and say so in the footer;
 * nothing is written anywhere.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxSpectrum',
        displayName: 'PVX Spectrum',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        sourceRemap: { SeriesIndex: 'index' },
        visObjectType: symbolVis,
        // A collection repeats the symbol once per asset and rebinds each copy to
        // that asset's own attributes: one chart per unit, built once.
        supportsCollections: true,
        configTitle: 'Format Spectrum',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                // Recorded values, never plot values: see the header.
                DataQueryMode: 'ModeEvents',
                Height: 300,
                Width: 480,

                SeriesIndex: 1,
                Title: '',

                // --- the transform ------------------------------------------
                Points: 1024,               // even samples, a power of two
                Interpolate: 'linear',      // linear | step
                Window: 'hann',             // hann | hamming | blackman | rect
                Detrend: 'mean',            // mean | linear | none

                // --- axes ---------------------------------------------------
                FreqUnit: 'auto',           // auto | hz | perMin | perHour
                MaxFreq: '',                // blank: up to the Nyquist frequency
                XScale: 'linear',           // linear | log
                YScale: 'amplitude',        // amplitude | db

                // --- peaks --------------------------------------------------
                PeakCount: 3,
                // A peak smaller than this share of the largest is the noise
                // floor, and a label on it says nothing.
                PeakMinPercent: 10,
                ShowPeriod: true,           // label a peak with its period too

                // --- bands --------------------------------------------------
                // "lo..hi : limit : label", in the axis unit, one per line or
                // comma separated. A limit is optional; with one the band
                // turns red when anything in it is larger.
                Bands: '',
                BandColor: '#3b82c4',
                AlarmColor: '#c8452f',

                LineColor: '#3b82c4',
                FillArea: true,
                ShowGrid: true,
                TickCount: 5,
                ShowLabel: true
            });
        }
    };

    var UNITS = {
        hz: { mult: 1, name: 'Hz', per: 's' },
        perMin: { mult: 60, name: 'cycles/min', per: 'min' },
        perHour: { mult: 3600, name: 'cycles/h', per: 'h' }
    };

    /** The unit that keeps the axis readable: the Nyquist frequency above 1. */
    function unitFor(cfg, nyquistHz) {
        if (UNITS[cfg.FreqUnit]) { return cfg.FreqUnit; }
        if (nyquistHz >= 1) { return 'hz'; }
        if (nyquistHz * 60 >= 1) { return 'perMin'; }
        return 'perHour';
    }

    /** A period, in the largest unit that keeps it above one. */
    function periodText(sec) {
        if (!isFinite(sec) || sec <= 0) { return ''; }
        if (sec < 1) { return (sec * 1000).toPrecision(3) + ' ms'; }
        if (sec < 120) { return sec.toPrecision(3) + ' s'; }
        if (sec < 7200) { return (sec / 60).toPrecision(3) + ' min'; }
        return (sec / 3600).toPrecision(3) + ' h';
    }

    var NUM = '(\\d*\\.?\\d+(?:e[-+]?\\d+)?)';
    var BAND_RE = new RegExp('^' + NUM + '\\s*(?:\\.\\.|-|to)\\s*' + NUM + '\\s*(?::\\s*([^:]*?)\\s*)?(?::\\s*(.*))?$', 'i');

    /**
     * "lo..hi : limit : label" -> [{lo, hi, limit|null, label}], and the
     * entries it could not read, which the footer names.
     */
    function parseBands(text) {
        var out = { bands: [], bad: [] };
        String(text || '').split(/[\n,;]/).forEach(function (raw) {
            var s = raw.trim();
            if (!s) { return; }
            var m = BAND_RE.exec(s);
            if (!m) { out.bad.push(s); return; }
            var lo = parseFloat(m[1]), hi = parseFloat(m[2]);
            var lim = m[3] !== undefined && m[3] !== '' ? parseFloat(m[3]) : null;
            if (!(hi > lo) || (lim !== null && !isFinite(lim))) { out.bad.push(s); return; }
            out.bands.push({ lo: lo, hi: hi, limit: lim, label: (m[4] || '').trim() });
        });
        return out;
    }

    symbolVis.parseBands = parseBands;
    symbolVis.periodText = periodText;

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { title: '', stats: '', note: '', error: '', background: '' };

        var model = { all: [] };
        var cache = { key: '', spec: null };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-spec-body',
            onData: function (d) { model.all = PVX.data.series(d); cache.key = ''; },
            render: render,
            // The saved file is the spectrum, not the raw values.
            csv: function () {
                var s = cache.spec;
                if (!s) { return null; }
                var u = UNITS[cache.unit] || UNITS.hz;
                var rows = [['Frequency (' + u.name + ')', 'Period (s)', 'Amplitude' + (cache.units ? ' (' + cache.units + ')' : '')]];
                for (var i = 1; i < s.freq.length; i++) {
                    rows.push([s.freq[i] * u.mult, 1 / s.freq[i], s.amp[i]]);
                }
                return rows;
            }
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

            var svgRoot = host.querySelector('svg.pvx-spec-svg');
            if (!svgRoot) { svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-spec-svg' }, host); }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var all = model.all || [];
            var idx = PVX.util.clamp((parseInt(cfg.SeriesIndex, 10) || 1) - 1, 0, Math.max(0, all.length - 1));
            var sel = all.length ? all[idx] : null;
            scope.pvx.error = sel && !sel.good ? (sel.errorDescription || 'Bad data quality') : '';
            scope.pvx.title = sel ? (cfg.Title || ('Spectrum of ' + sel.label)) : (cfg.Title || 'Spectrum');
            var notes = [];
            if (all.length > 1) { notes.push((all.length - 1) + ' other source' + (all.length > 2 ? 's' : '') + ' not analysed'); }

            var key = [idx, cfg.Points, cfg.Interpolate, cfg.Window, cfg.Detrend].join('|');
            if (cache.key !== key) {
                cache.key = key;
                cache.spec = sel ? PVX.stats.spectrum(sel.points || [], {
                    n: cfg.Points, window: cfg.Window, detrend: cfg.Detrend, interp: cfg.Interpolate }) : null;
            }
            var spec = cache.spec;
            cache.units = sel ? sel.units : '';
            if (!spec) {
                scope.pvx.stats = '';
                scope.pvx.note = notes.join(' · ');
                emptyState(svgRoot, W, H, t, sel ? 'Not enough data' : 'No data',
                    sel ? 'A spectrum needs at least four numeric values at different times.' : 'Drop an attribute onto the symbol.');
                digest();
                return;
            }
            if (spec.excluded) { notes.push(spec.excluded + ' value' + (spec.excluded === 1 ? '' : 's') + ' not a number, left out'); }

            var nyq = spec.freq[spec.freq.length - 1];
            var unit = unitFor(cfg, nyq);
            cache.unit = unit;
            var U = UNITS[unit];
            var maxF = PVX.util.num(cfg.MaxFreq);
            var fMax = maxF !== null && maxF > 0 ? Math.min(nyq, maxF / U.mult) : nyq;
            var df = spec.freq[1];
            var logX = cfg.XScale === 'log';
            var fMin = logX ? df : 0;

            // Bins drawn: DC is never one (detrending emptied it, or it is
            // the level, which is not a cycle).
            var bins = [];
            for (var i = 1; i < spec.freq.length && spec.freq[i] <= fMax * 1.0000001; i++) { bins.push(i); }

            var db = cfg.YScale === 'db';
            var peakAmp = 0;
            for (i = 0; i < bins.length; i++) { peakAmp = Math.max(peakAmp, spec.amp[bins[i]]); }
            var yOf = function (a) { return db ? 20 * Math.log(Math.max(a, peakAmp * 1e-6, 1e-12)) / Math.LN10 : a; };

            var bandSpec = parseBands(cfg.Bands);
            if (bandSpec.bad.length) { notes.push('Band not read: ' + bandSpec.bad.join('; ')); }

            /* ---- layout -------------------------------------------------- */
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 26), 9, 12);
            var yLo = db ? yOf(peakAmp) - 80 : 0;
            var yHi = db ? yOf(peakAmp) + 3 : peakAmp * 1.12 || 1;
            var bandMax = 0;
            for (i = 0; i < bandSpec.bands.length; i++) {
                if (bandSpec.bands[i].limit !== null && !db) { bandMax = Math.max(bandMax, bandSpec.bands[i].limit * 1.08); }
            }
            yHi = Math.max(yHi, bandMax);
            var yTicks = PVX.scale.ticks(yLo, yHi, Math.max(2, parseInt(cfg.TickCount, 10) || 5));
            var yMax = Math.max(yHi, yTicks[yTicks.length - 1]);
            var labelW = 0;
            for (i = 0; i < yTicks.length; i++) { labelW = Math.max(labelW, PVX.fmt.tick(yTicks[i]).length); }
            var plot = { x: Math.round(labelW * font * 0.6 + font * 1.6), y: Math.round(font * 1.2),
                w: 0, h: 0 };
            plot.w = Math.max(10, W - plot.x - font);
            plot.h = Math.max(10, H - plot.y - font * 3.2);
            var sx = function (f) {
                if (logX) {
                    var lf = Math.log(Math.max(f, fMin)), l0 = Math.log(fMin), l1 = Math.log(Math.max(fMax, fMin * 1.0001));
                    return plot.x + (lf - l0) / (l1 - l0) * plot.w;
                }
                return plot.x + (f - fMin) / ((fMax - fMin) || 1) * plot.w;
            };
            var sy = function (v) { return plot.y + plot.h - (Math.max(yLo, Math.min(yMax, v)) - yLo) / ((yMax - yLo) || 1) * plot.h; };

            /* ---- grid and axes ------------------------------------------- */
            for (i = 0; i < yTicks.length; i++) {
                var gy = sy(yTicks[i]);
                if (cfg.ShowGrid) {
                    PVX.svg.el('line', { x1: plot.x, x2: plot.x + plot.w, y1: gy.toFixed(2), y2: gy.toFixed(2),
                        stroke: t.grid, 'stroke-width': 1 }, svgRoot);
                }
                PVX.svg.text(svgRoot, (plot.x - 5).toFixed(2), (gy + font * 0.35).toFixed(2), PVX.fmt.tick(yTicks[i]), {
                    'class': 'pvx-svg-label', 'text-anchor': 'end', 'font-size': font, fill: t.textMuted });
            }
            var xTicks = logX ? logTicks(fMin * U.mult, fMax * U.mult) : PVX.scale.ticks(0, fMax * U.mult, Math.max(2, Math.floor(plot.w / (font * 6))));
            for (i = 0; i < xTicks.length; i++) {
                var fx = xTicks[i] / U.mult;
                if (fx < fMin || fx > fMax * 1.0001) { continue; }
                var gx = sx(fx);
                if (cfg.ShowGrid) {
                    PVX.svg.el('line', { x1: gx.toFixed(2), x2: gx.toFixed(2), y1: plot.y, y2: plot.y + plot.h,
                        stroke: t.grid, 'stroke-width': 1 }, svgRoot);
                }
                // Log ticks span decades, so two decimals would print 0.005
                // and 0.01 alike; two significant figures never do.
                var xl = logX ? String(Number(xTicks[i].toPrecision(2))) : PVX.fmt.tick(xTicks[i]);
                PVX.svg.text(svgRoot, gx.toFixed(2), (plot.y + plot.h + font * 1.3).toFixed(2), xl, {
                    'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': font, fill: t.textMuted });
            }
            // Axis names only where they fit beside the ticks; a small
            // symbol keeps the unit in the tooltip of each peak.
            var named = plot.h >= 90 && W >= 240;
            if (named) {
                PVX.svg.text(svgRoot, (plot.x + plot.w / 2).toFixed(2), (H - font * 0.4).toFixed(2),
                    'Frequency (' + U.name + ')', { 'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': font, fill: t.textMuted });
                var yName = db ? 'dB re 1 ' + (cache.units || 'unit') : 'Amplitude' + (cache.units ? ' (' + cache.units + ')' : '');
                PVX.svg.text(svgRoot, (font * 0.9).toFixed(2), (plot.y + plot.h / 2).toFixed(2), yName, {
                    'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': font, fill: t.textMuted,
                    transform: 'rotate(-90 ' + (font * 0.9).toFixed(2) + ' ' + (plot.y + plot.h / 2).toFixed(2) + ')' });
            }

            /* ---- bands ---------------------------------------------------- */
            var over = [];
            for (i = 0; i < bandSpec.bands.length; i++) {
                var b = bandSpec.bands[i];
                var blo = b.lo / U.mult, bhi = b.hi / U.mult;
                if (bhi < fMin || blo > fMax) { notes.push('Band ' + (b.label || (b.lo + '..' + b.hi)) + ' is off the axis'); continue; }
                var bMax = 0;
                for (var k = 0; k < bins.length; k++) {
                    var f = spec.freq[bins[k]];
                    if (f >= blo && f <= bhi) { bMax = Math.max(bMax, spec.amp[bins[k]]); }
                }
                var bad = b.limit !== null && bMax > b.limit;
                if (bad) { over.push((b.label || (b.lo + '..' + b.hi)) + ' ' + PVX.fmt.number(bMax, PVX.config.numberOpts(cfg)) + ' > ' + b.limit); }
                var col = bad ? (cfg.AlarmColor || PVX.color.status.alarm) : (cfg.BandColor || '#3b82c4');
                var x0 = sx(Math.max(blo, fMin)), x1 = sx(Math.min(bhi, fMax));
                PVX.svg.el('rect', { x: x0.toFixed(2), y: plot.y, width: Math.max(1, x1 - x0).toFixed(2), height: plot.h,
                    fill: col, 'fill-opacity': bad ? 0.16 : 0.08, 'class': 'pvx-spec-band' + (bad ? ' pvx-spec-band-over' : '') }, svgRoot);
                if (b.limit !== null && !db) {
                    var ly = sy(b.limit);
                    PVX.svg.el('line', { x1: x0.toFixed(2), x2: x1.toFixed(2), y1: ly.toFixed(2), y2: ly.toFixed(2),
                        stroke: col, 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }, svgRoot);
                }
                // At the foot of the band: the top belongs to the peak labels.
                if (b.label && x1 - x0 > font * 2) {
                    PVX.svg.text(svgRoot, ((x0 + x1) / 2).toFixed(2), (plot.y + plot.h - font * 0.5).toFixed(2), b.label, {
                        'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': font * 0.9, fill: col });
                }
            }
            if (over.length) { notes.unshift('Over limit: ' + over.join('; ')); }

            /* ---- the spectrum --------------------------------------------- */
            var line = [];
            for (i = 0; i < bins.length; i++) {
                line.push({ x: sx(spec.freq[bins[i]]), y: sy(yOf(spec.amp[bins[i]])) });
            }
            var lc = cfg.LineColor || '#3b82c4';
            if (cfg.FillArea && line.length > 1) {
                PVX.svg.el('path', { d: PVX.svg.area(line, plot.y + plot.h), fill: lc, 'fill-opacity': 0.14, stroke: 'none' }, svgRoot);
            }
            PVX.svg.el('path', { d: PVX.svg.line(line), fill: 'none', stroke: lc, 'stroke-width': 1.6,
                'stroke-linejoin': 'round', 'class': 'pvx-spec-line' }, svgRoot);

            /* ---- peaks ----------------------------------------------------- */
            var peaks = PVX.stats.spectrumPeaks(spec.freq.slice(0, bins.length + 1), spec.amp.slice(0, bins.length + 1),
                Math.max(0, Math.min(10, parseInt(cfg.PeakCount, 10) || 0)), 1);
            var minShare = Math.max(0, Math.min(100, parseFloat(cfg.PeakMinPercent) || 0)) / 100;
            peaks = peaks.filter(function (pk) { return pk.amp >= (peaks[0] ? peaks[0].amp : 0) * minShare; });
            var placed = [];
            for (i = 0; i < peaks.length; i++) {
                var p = peaks[i];
                var px = sx(p.freq), py = sy(yOf(p.amp));
                PVX.svg.el('circle', { cx: px.toFixed(2), cy: py.toFixed(2), r: 3.2, fill: t.surface, stroke: lc,
                    'stroke-width': 1.6, 'class': 'pvx-spec-peak' }, svgRoot);
                var lab = PVX.fmt.number(p.freq * U.mult, { decimals: p.freq * U.mult < 10 ? 2 : 1 }) +
                    (cfg.ShowPeriod !== false ? ' · ' + periodText(1 / p.freq) : '');
                var ty = py - 6;
                var labW = lab.length * font * 0.58;
                for (var q = 0; q < placed.length; q++) {
                    if (Math.abs(placed[q][0] - px) < (labW + placed[q][2]) / 2 && Math.abs(placed[q][1] - ty) < font) { ty = placed[q][1] - font * 1.1; }
                }
                // No room left above the others: the marker stays, the label
                // goes, and the marker's tooltip still says it all.
                if (ty < plot.y + font * 0.8) { ty = -1; }
                if (ty < 0 && i > 0) {
                    PVX.svg.el('title', {}, svgRoot.lastChild).textContent = 'Peak at ' +
                        PVX.fmt.number(p.freq * U.mult, { decimals: 4 }) + ' ' + U.name + ', a period of ' + periodText(1 / p.freq);
                    continue;
                }
                ty = Math.max(plot.y + font * 0.8, ty);
                placed.push([px, ty, labW]);
                var anchor = px > plot.x + plot.w * 0.8 ? 'end' : (px < plot.x + plot.w * 0.15 ? 'start' : 'middle');
                var ptx = PVX.svg.text(svgRoot, px.toFixed(2), ty.toFixed(2), lab, {
                    'class': 'pvx-svg-label pvx-spec-peaklabel', 'text-anchor': anchor, 'font-size': font, fill: t.text });
                PVX.svg.el('title', {}, ptx).textContent = 'Peak at ' +
                    PVX.fmt.number(p.freq * U.mult, { decimals: 4 }) + ' ' + U.name + ', a period of ' + periodText(1 / p.freq) +
                    ', amplitude ' + PVX.fmt.number(p.amp, PVX.config.numberOpts(cfg)) + (cache.units ? ' ' + cache.units : '');
            }

            /* ---- footer --------------------------------------------------- */
            scope.pvx.stats = spec.used + ' recorded values over ' + periodText(spec.span) + ', resampled to ' +
                spec.n + ' every ' + periodText(spec.dt) + ' · resolution ' +
                PVX.fmt.number(df * U.mult, { decimals: 4 }) + ' ' + U.name;
            if (spec.used < spec.n / 4) {
                notes.push('Fewer recorded values than the grid: high frequencies show the interpolation, not the process');
            }
            scope.pvx.note = notes.join(' · ');
            digest();
        }

        /** 1, 2, 5 per decade between lo and hi. */
        function logTicks(lo, hi) {
            var out = [];
            if (!(lo > 0) || !(hi > lo)) { return out; }
            for (var e = Math.floor(Math.log(lo) / Math.LN10); Math.pow(10, e) <= hi; e++) {
                var steps = [1, 2, 5];
                for (var s = 0; s < steps.length; s++) {
                    var v = steps[s] * Math.pow(10, e);
                    if (v >= lo && v <= hi) { out.push(v); }
                }
            }
            return out;
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
