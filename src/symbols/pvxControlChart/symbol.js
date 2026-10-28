/* ============================================================================
 * pvxControlChart: "PVX Control Chart" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources; the one selected is charted)
 * @mock spc
 *
 * A trend says what a tag did. A control chart says whether what it did is
 * more than the noise the process always makes: the centre line and limits
 * come from the process's own variation, and the run rules flag a pattern
 * (a drift, a shift, a cycle) well before any single point leaves the limits.
 *
 * Three charts, the ones a plant actually uses: individuals with a moving
 * range (I-MR, one reading at a time) and X-bar with a range or a standard
 * deviation (subgroups of consecutive readings). All the arithmetic lives in
 * PVX.stats (controlLimits, runRules, spcCapability, intervalAverages) so the
 * test suite can check it against known answers; this file draws.
 *
 * WHICH SAMPLES. PI Vision's plot values are the minimum and maximum of each
 * pixel column, so consecutive points alternate by construction and rule 4
 * would fire on a steady process. The symbol asks for recorded values
 * (ModeEvents) and by default averages them onto an even time grid, which is
 * what the rules assume. "Recorded" uses them as stored, for a tag sampled
 * at a fixed rate with compression off.
 *
 * Rules are evaluated over the display's time range while the display is
 * open. Nothing is written back, and nothing alarms: this is an analysis view.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Mean advance width of the UI font, in ems (see pvxHistogram). */
    var CHAR_W = 0.58;

    /* Above this many plotted points a marker per point is noise; only the
     * points that break a rule keep one. */
    var MAX_MARKERS = 240;

    var RULE_SETS = {
        nelson: { rules: [1, 2, 3, 4, 5, 6, 7, 8], run2: 9 },
        we: { rules: [1, 2, 5, 6], run2: 8 },
        limits: { rules: [1], run2: 9 },
        none: { rules: [], run2: 9 }
    };

    var definition = {
        typeName: 'pvxControlChart',
        displayName: 'PVX Control Chart',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        // Positional config, renumbered when a data source is removed.
        sourceRemap: {
            SeriesIndex: 'index',
            CenterSource: 'indexAuto', UclSource: 'indexAuto', LclSource: 'indexAuto',
            LslSource: 'indexAuto', UslSource: 'indexAuto'
        },
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Control Chart',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                // Recorded values, never plot values: see the header.
                DataQueryMode: 'ModeEvents',
                Height: 300,
                Width: 460,

                SeriesIndex: 1,
                Title: '',

                // --- the chart ---------------------------------------------
                ChartType: 'imr',           // imr | xbarr | xbars
                SubgroupSize: 5,            // X-bar charts: consecutive points per subgroup
                SampleMode: 'interval',     // interval | recorded
                Intervals: 120,             // interval mode: points across the time range
                Sigma: 3,                   // limit width, 2 to 4

                // --- where the limits come from -----------------------------
                LimitSource: 'window',      // window | baseline | fixed | sources | af
                BaselinePoints: 25,         // baseline: the first N plotted points
                FixedCenter: '',
                FixedUCL: '',
                FixedLCL: '',
                // sources: data source numbers, '0' = none. Strings because
                // the pane picks them with a plain <select>.
                CenterSource: '0',
                UclSource: '0',
                LclSource: '0',
                // af: limit traits of the charted attribute, kept in AF so a
                // change there reaches every display at once.
                AfUclTrait: 'Hi',
                AfLclTrait: 'Lo',

                // --- run rules ----------------------------------------------
                RuleSet: 'nelson',          // nelson | we | limits | custom | none
                CustomRules: '1, 2, 5, 6',
                RunLength: 9,               // custom: points in a row for rule 2
                TrendLength: 6,             // custom: points rising or falling for rule 3
                AlternateLength: 14,        // custom: points alternating for rule 4

                // --- specification ------------------------------------------
                LSL: '',
                USL: '',
                Target: '',
                LslSource: '0',             // a data source overrides the typed LSL
                UslSource: '0',
                SpecFromAf: false,          // LSL, USL and Target from AF limit traits
                AfLslTrait: 'LoLo',
                AfUslTrait: 'HiHi',
                ShowCapability: true,

                // --- chrome -------------------------------------------------
                ShowSecondary: true,
                ShowHistogram: true,
                ShowZones: true,
                ShowSpecLines: true,
                ShowGrid: true,
                TickCount: 5,
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { title: '', stats: '', note: '', status: '', error: '', background: '' };

        var model = { all: [], dropped: 0 };

        // AF limit traits of the charted attribute, when asked for.
        var traits = PVX.af.watcher(function () { if (ctx && !ctx.destroyed) { ctx.render(); } });

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-spc-body',
            onData: function (d) { model.all = PVX.data.series(d); model.dropped = countDropped(d); askTraits(); },
            onConfigChange: function () { askTraits(); },
            onDestroy: function () { traits.stop(); },
            render: render
        });

        function traitNames(cfg) {
            var out = [];
            var add = function (n) { if (n && PVX.af.TRAITS.indexOf(n) !== -1 && out.indexOf(n) === -1) { out.push(n); } };
            if (cfg.LimitSource === 'af') { add(cfg.AfUclTrait || 'Hi'); add(cfg.AfLclTrait || 'Lo'); add('Target'); }
            if (cfg.SpecFromAf) { add(cfg.AfLslTrait || 'LoLo'); add(cfg.AfUslTrait || 'HiHi'); add('Target'); }
            return out;
        }

        function askTraits() {
            var cfg = scope.config || {};
            var ds = (scope.symbol && scope.symbol.DataSources) || [];
            var idx = PVX.util.clamp((parseInt(cfg.SeriesIndex, 10) || 1) - 1, 0, Math.max(0, ds.length - 1));
            traits.ask(ds[idx], traitNames(cfg));
        }

        function trait(name) { return traits.get(name); }

        /* ================================================================== *
         * render
         * ================================================================== */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            var W = Math.max(40, c.width);
            var H = Math.max(40, c.height);
            var boxH0 = (c.node && c.node.clientHeight) || H;

            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;
            if (c.node && c.node.style && c.node.style.setProperty) {
                c.node.style.setProperty('--pvx-text', t.text);
                c.node.style.setProperty('--pvx-muted', t.textMuted);
            }

            var svgRoot = host.querySelector('svg.pvx-spc-svg');
            if (!svgRoot) { svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-spc-svg' }, host); }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var all = model.all || [];
            var selIdx = PVX.util.clamp((parseInt(cfg.SeriesIndex, 10) || 1) - 1, 0, Math.max(0, all.length - 1));
            var sel = all.length ? all[selIdx] : null;

            scope.pvx.error = '';
            scope.pvx.status = '';
            if (sel && !sel.good) { scope.pvx.error = sel.errorDescription || 'Bad data quality'; }
            scope.pvx.title = boxH0 < 84 ? '' : (cfg.Title || (sel
                ? sel.label + (sel.units && cfg.ShowUnits !== false ? ' (' + sel.units + ')' : '')
                : 'Control chart'));

            var raw = sel ? sel.points : [];
            if (!sel || raw.length < 3) {
                scope.pvx.stats = '';
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, !sel ? 'No data' : 'Not enough data',
                    !all.length ? 'Drop an attribute onto the symbol.'
                        : 'A control chart needs at least three samples in the time range.');
                digest();
                return;
            }

            /* ---- the samples the chart is built on ----------------------- */
            var sampleMode = cfg.SampleMode === 'recorded' ? 'recorded' : 'interval';
            var samples = raw;
            var emptyIntervals = 0;
            if (sampleMode === 'interval') {
                var nInt = PVX.util.clamp(parseInt(cfg.Intervals, 10) || 120, 10, 2000);
                var avg = PVX.stats.intervalAverages(raw, raw[0].t, raw[raw.length - 1].t, nInt);
                samples = [];
                for (var a = 0; a < avg.length; a++) {
                    if (avg[a].v === null) { emptyIntervals++; } else { samples.push(avg[a]); }
                }
            }

            var chart = cfg.ChartType === 'xbarr' || cfg.ChartType === 'xbars' ? cfg.ChartType : 'imr';
            var k = PVX.util.clamp(PVX.util.num(cfg.Sigma) || 3, 2, 4);
            var src = cfg.LimitSource || 'window';
            var fixed = null;
            if (src === 'fixed') { fixed = { center: cfg.FixedCenter, ucl: cfg.FixedUCL, lcl: cfg.FixedLCL }; }
            if (src === 'sources') {
                fixed = { center: latest(all, cfg.CenterSource), ucl: latest(all, cfg.UclSource), lcl: latest(all, cfg.LclSource) };
            }
            var afUcl = null, afLcl = null;
            if (src === 'af') {
                afUcl = trait(cfg.AfUclTrait || 'Hi');
                afLcl = trait(cfg.AfLclTrait || 'Lo');
                // No Target: the centre is midway between the two limits.
                var afC = trait('Target');
                if (afC === null && afUcl !== null && afLcl !== null) { afC = (afUcl + afLcl) / 2; }
                fixed = { center: afC, ucl: afUcl, lcl: afLcl };
            }
            var L = PVX.stats.controlLimits(samples, {
                chart: chart,
                size: cfg.SubgroupSize,
                k: k,
                baseline: src === 'baseline' ? cfg.BaselinePoints : 0,
                fixed: fixed
            });
            if (!L) {
                scope.pvx.stats = '';
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, 'Not enough data',
                    chart === 'imr' ? 'Fewer than two points to chart.'
                        : 'Fewer than two complete subgroups of ' + (parseInt(cfg.SubgroupSize, 10) || 5) + '.');
                digest();
                return;
            }
            if ((src === 'fixed' || src === 'sources' || src === 'af') && !L.fixed) {
                scope.pvx.stats = '';
                scope.pvx.note = '';
                emptyState(svgRoot, W, H, t, src === 'af' && traits.phase === 'loading' ? 'Reading AF limits\u2026' : 'Limits not set',
                    src === 'fixed' ? 'Fixed limits need at least a centre line and an upper control limit.'
                        : src === 'sources' ? 'Choose the data sources holding the centre line and the upper control limit.'
                        : traits.phase === 'error' ? 'AF limits: ' + traits.error + '.'
                        : traits.phase === 'loading' ? 'Asking PI Web API for the attribute\u2019s limit traits.'
                        : afUcl === null
                            ? 'The attribute has no ' + (cfg.AfUclTrait || 'Hi') + ' limit trait in AF. Add it there, or choose another trait in Format.'
                            : 'A centre line needs a Target trait, or a ' + (cfg.AfLclTrait || 'Lo') + ' trait to go midway between.');
                digest();
                return;
            }

            /* ---- rules --------------------------------------------------- */
            var ruleCfg = ruleSet(cfg);
            var pvals = [];
            for (var p = 0; p < L.primary.length; p++) { pvals.push(L.primary[p].v); }
            var ruleOpts = { rules: ruleCfg.rules, run2: ruleCfg.run2, run3: ruleCfg.run3, run4: ruleCfg.run4, k: k };
            var broken = PVX.stats.runRules(pvals, L.center, L.s, ruleOpts);
            // The range chart only has a meaningful rule 1: its distribution is
            // skewed, so the zone rules do not apply to it.
            var secBroken = [];
            for (p = 0; p < L.secondary.length; p++) {
                var sv = L.secondary[p].v;
                secBroken.push(ruleCfg.rules.indexOf(1) !== -1 && (sv > L.secUcl || (L.secLcl > 0 && sv < L.secLcl)));
            }

            var counts = {}, nBroken = 0, nSecBroken = 0;
            for (p = 0; p < broken.length; p++) {
                if (broken[p].length) { nBroken++; }
                for (var q = 0; q < broken[p].length; q++) { counts[broken[p][q]] = (counts[broken[p][q]] || 0) + 1; }
            }
            for (p = 0; p < secBroken.length; p++) { if (secBroken[p]) { nSecBroken++; } }

            /* ---- capability ---------------------------------------------- */
            // A spec held in PI beats a typed one: it follows a grade change.
            var lsl = PVX.util.num(cfg.LSL), usl = PVX.util.num(cfg.USL), target = PVX.util.num(cfg.Target);
            var lslSrc = latest(all, cfg.LslSource), uslSrc = latest(all, cfg.UslSource);
            if (lslSrc !== null) { lsl = lslSrc; }
            if (uslSrc !== null) { usl = uslSrc; }
            var specAf = [];
            if (cfg.SpecFromAf) {
                var tl = trait(cfg.AfLslTrait || 'LoLo'), tu = trait(cfg.AfUslTrait || 'HiHi'), tt = trait('Target');
                if (tl !== null) { lsl = tl; specAf.push('LSL'); }
                if (tu !== null) { usl = tu; specAf.push('USL'); }
                if (tt !== null) { target = tt; specAf.push('target'); }
            }
            var indiv = [];
            for (p = 0; p < samples.length; p++) { indiv.push(samples[p].v); }
            var cap = (cfg.ShowCapability !== false && (lsl !== null || usl !== null))
                ? PVX.stats.spcCapability(indiv, L.sigma, lsl, usl) : null;

            /* ---- layout -------------------------------------------------- */
            var tickFont = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var showTicks = W >= 150 && H >= 100;
            var showTime = W >= 150 && H >= 90;
            var wantSec = cfg.ShowSecondary !== false && H >= 150;
            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 10);
            var numOpts = PVX.config.numberOpts(cfg);

            var tMin = L.primary[0].members[0].t;
            var tMax = L.primary[L.primary.length - 1].t;
            if (!(tMax > tMin)) { tMax = tMin + 1; }

            // Primary domain: the data, the limits and any spec line drawn.
            var lo = Math.min(L.lcl, L.center), hi = Math.max(L.ucl, L.center);
            for (p = 0; p < pvals.length; p++) { lo = Math.min(lo, pvals[p]); hi = Math.max(hi, pvals[p]); }
            if (cfg.ShowSpecLines !== false) {
                if (lsl !== null) { lo = Math.min(lo, lsl); hi = Math.max(hi, lsl); }
                if (usl !== null) { lo = Math.min(lo, usl); hi = Math.max(hi, usl); }
                if (target !== null) { lo = Math.min(lo, target); hi = Math.max(hi, target); }
            }
            var dom = PVX.scale.niceDomain(lo, hi, tickCount);
            if (!(dom[1] > dom[0])) { dom = [lo - 1, hi + 1]; }
            var ticks = PVX.scale.ticks(dom[0], dom[1], tickCount);

            var secLo = 0, secHi = Math.max(L.secUcl, L.secCenter);
            for (p = 0; p < L.secondary.length; p++) { secHi = Math.max(secHi, L.secondary[p].v); }
            var secDom = PVX.scale.niceDomain(secLo, secHi || 1, 3);
            var secTicks = PVX.scale.ticks(secDom[0], secDom[1], 3);

            var tickW = 0;
            if (showTicks) {
                for (p = 0; p < ticks.length; p++) { tickW = Math.max(tickW, textW(PVX.fmt.tick(ticks[p]), tickFont)); }
                if (wantSec) {
                    for (p = 0; p < secTicks.length; p++) { tickW = Math.max(tickW, textW(PVX.fmt.tick(secTicks[p]), tickFont)); }
                }
            }
            // Limit captions sit at the right end of their lines; reserve room
            // so "UCL 113.6" is never cut off by the edge of the symbol.
            var capW = W >= 260 ? Math.max(textW('UCL ' + fmtV(L.ucl), tickFont * 0.9),
                textW('LCL ' + fmtV(L.lcl), tickFont * 0.9)) + 6 : 0;
            var mL = Math.min(W * 0.35, 4 + tickW + (tickW ? 5 : 0));
            // The distribution strip shares the value axis, so it reads as
            // "where the points pile up" against the very same limit lines.
            var histW = cfg.ShowHistogram !== false && W - mL - capW >= 300
                ? PVX.util.clamp(Math.round((W - mL - capW) * 0.14), 36, 90) : 0;
            var histGap = histW ? 6 : 0;
            var mR = Math.min(W * 0.3 + histW + histGap, 6 + capW + histW + histGap);
            var mT = 6;
            var mB = showTime ? tickFont + 10 : 4;
            var gap = wantSec ? Math.max(8, tickFont) : 0;
            var innerH = Math.max(20, H - mT - mB - gap);
            var priH = wantSec ? innerH * 0.66 : innerH;
            var secH = wantSec ? innerH - priH : 0;

            var pri = { x: mL, y: mT, w: Math.max(10, W - mL - mR), h: Math.max(10, priH) };
            pri.x1 = pri.x + pri.w; pri.y1 = pri.y + pri.h;
            var hist = { x: pri.x1 + histGap, y: pri.y, w: histW, h: pri.h };
            hist.x1 = hist.x + hist.w; hist.y1 = pri.y1;
            var capX = (histW ? hist.x1 : pri.x1) + 3;
            var sec = { x: pri.x, y: pri.y1 + gap, w: pri.w, h: Math.max(0, secH) };
            sec.x1 = sec.x + sec.w; sec.y1 = sec.y + sec.h;

            var sx = PVX.scale.linear(tMin, tMax, pri.x, pri.x1);
            var sy = PVX.scale.linear(dom[0], dom[1], pri.y1, pri.y);
            var ssy = PVX.scale.linear(secDom[0], secDom[1], sec.y1, sec.y);

            var cs = t.status;

            /* ---- zones --------------------------------------------------- */
            if (cfg.ShowZones !== false && L.s > 0) {
                // Faint bands between 1 and 2 sigma and between 2 sigma and the
                // limit: the eye finds rules 5 and 6 itself once it can see them.
                zone(L.center + L.s, L.center + 2 * L.s, cs.warning, 0.06);
                zone(L.center - 2 * L.s, L.center - L.s, cs.warning, 0.06);
                zone(L.center + 2 * L.s, L.ucl, cs.alarm, 0.07);
                zone(L.lcl, L.center - 2 * L.s, cs.alarm, 0.07);
            }

            if (cfg.ShowGrid !== false) {
                for (p = 0; p < ticks.length; p++) { hline(svgRoot, pri, sy(ticks[p]), t.grid, null, 1); }
            }

            /* ---- limit and spec lines ------------------------------------ */
            hline(svgRoot, pri, sy(L.center), t.text, null, 1.2, 0.7);
            hline(svgRoot, pri, sy(L.ucl), cs.alarm, '5 3', 1.2);
            hline(svgRoot, pri, sy(L.lcl), cs.alarm, '5 3', 1.2);
            if (histW) { drawHistogram(); }
            if (capW) {
                // Tight limits put three captions within a few pixels; push
                // UCL up and LCL down off the centre line, and drop CL when
                // even that does not leave it a line of its own.
                var lineH = tickFont * 0.9 + 1;
                var yU = sy(L.ucl), yC = sy(L.center), yLo = sy(L.lcl);
                var showCL = (yLo - yU) >= 2 * lineH;
                var mid = showCL ? yC : (yU + yLo) / 2;
                var half = showCL ? lineH : lineH / 2;
                if (mid - yU < half) { yU = mid - half; }
                if (yLo - mid < half) { yLo = mid + half; }
                caption(capX, yU, 'UCL ' + fmtV(L.ucl), cs.alarm);
                if (showCL) { caption(capX, yC, 'CL ' + fmtV(L.center), t.textMuted); }
                caption(capX, yLo, 'LCL ' + fmtV(L.lcl), cs.alarm);
            }
            if (cfg.ShowSpecLines !== false) {
                specLine(lsl, 'LSL');
                specLine(usl, 'USL');
                specLine(target, 'Target');
            }

            /* ---- the plotted statistic ----------------------------------- */
            var xy = [];
            for (p = 0; p < L.primary.length; p++) {
                xy.push({ x: sx(L.primary[p].t), y: sy(PVX.util.clamp(pvals[p], dom[0], dom[1])) });
            }
            PVX.svg.el('path', {
                d: PVX.svg.line(xy, false), fill: 'none', stroke: cfg.AccentColor || '#3b82c4',
                'stroke-width': 1.4, 'stroke-linejoin': 'round', 'class': 'pvx-spc-line'
            }, svgRoot);

            var markEvery = L.primary.length <= MAX_MARKERS;
            var label = chart === 'imr' ? 'Value' : 'Subgroup mean';
            for (p = 0; p < L.primary.length; p++) {
                var rules = broken[p];
                if (!markEvery && !rules.length) { continue; }
                var col = rules.indexOf(1) !== -1 ? cs.alarm : (rules.length ? cs.warning : (cfg.AccentColor || '#3b82c4'));
                var dot = PVX.svg.el('circle', {
                    cx: xy[p].x.toFixed(2), cy: xy[p].y.toFixed(2),
                    r: rules.length ? 3.2 : 2, fill: col,
                    stroke: rules.length ? t.surface === 'transparent' ? 'none' : t.surface : 'none',
                    'stroke-width': rules.length ? 1 : 0,
                    'class': rules.length ? 'pvx-spc-dot pvx-spc-flag' : 'pvx-spc-dot'
                }, svgRoot);
                var tip = PVX.fmt.time(L.primary[p].t, 'datetime') + '\n' + label + ': ' + fmtV(pvals[p]) +
                    (sel.units ? ' ' + sel.units : '');
                if (rules.length) {
                    for (q = 0; q < rules.length; q++) { tip += '\nRule ' + rules[q] + ': ' + PVX.stats.ruleText(rules[q], ruleOpts); }
                }
                PVX.svg.el('title', null, dot).textContent = tip;
            }

            /* ---- axes ---------------------------------------------------- */
            hline(svgRoot, pri, pri.y1, t.axis, null, 1);
            vline(pri.x, pri.y, pri.y1);
            if (showTicks) {
                for (p = 0; p < ticks.length; p++) { tickLabel(pri.x - 4, sy(ticks[p]), ticks[p]); }
            }

            /* ---- secondary chart ----------------------------------------- */
            if (wantSec && sec.h >= 14) {
                hline(svgRoot, sec, ssy(L.secCenter), t.text, null, 1, 0.6);
                hline(svgRoot, sec, ssy(L.secUcl), cs.alarm, '5 3', 1);
                if (L.secLcl > 0) { hline(svgRoot, sec, ssy(L.secLcl), cs.alarm, '5 3', 1); }
                var sxy = [];
                for (p = 0; p < L.secondary.length; p++) {
                    sxy.push({ x: sx(L.secondary[p].t), y: ssy(PVX.util.clamp(L.secondary[p].v, secDom[0], secDom[1])) });
                }
                PVX.svg.el('path', {
                    d: PVX.svg.line(sxy, false), fill: 'none', stroke: t.textMuted,
                    'stroke-width': 1.1, 'class': 'pvx-spc-line'
                }, svgRoot);
                for (p = 0; p < sxy.length; p++) {
                    if (!secBroken[p]) { continue; }
                    var sdot = PVX.svg.el('circle', {
                        cx: sxy[p].x.toFixed(2), cy: sxy[p].y.toFixed(2), r: 3, fill: cs.alarm,
                        'class': 'pvx-spc-dot pvx-spc-flag'
                    }, svgRoot);
                    PVX.svg.el('title', null, sdot).textContent = PVX.fmt.time(L.secondary[p].t, 'datetime') +
                        '\n' + L.secName + ': ' + fmtV(L.secondary[p].v) + '\nAbove the ' + L.secName + ' chart limit';
                }
                hline(svgRoot, sec, sec.y1, t.axis, null, 1);
                vline(sec.x, sec.y, sec.y1);
                if (showTicks && sec.h >= 30) {
                    tickLabel(sec.x - 4, ssy(secTicks[secTicks.length - 1]), secTicks[secTicks.length - 1]);
                    tickLabel(sec.x - 4, ssy(secTicks[0]), secTicks[0]);
                }
                if (sec.h >= tickFont + 4 && pri.w > 80) {
                    PVX.svg.text(svgRoot, (sec.x + 4).toFixed(2), (sec.y + tickFont * 0.6).toFixed(2), L.secName, {
                        'class': 'pvx-svg-label', 'font-size': tickFont * 0.9, 'font-weight': '600', fill: t.textMuted
                    });
                }
            }

            /* ---- time axis ----------------------------------------------- */
            if (showTime) {
                var n = Math.max(2, Math.min(5, Math.floor(pri.w / (11 * tickFont * CHAR_W + 10))));
                var yTime = (wantSec ? sec.y1 : pri.y1) + 4 + tickFont * 0.6;
                for (p = 0; p < n; p++) {
                    var tt = tMin + (tMax - tMin) * p / (n - 1);
                    var str = PVX.fmt.time(tt, 'short');
                    var x = sx(tt), w = textW(str, tickFont), anchor = 'middle';
                    if (x - w / 2 < 1) { anchor = 'start'; x = Math.max(1, x); }
                    else if (x + w / 2 > W - 1) { anchor = 'end'; x = Math.min(W - 1, x); }
                    PVX.svg.text(svgRoot, x.toFixed(2), yTime.toFixed(2), str, {
                        'class': 'pvx-svg-label pvx-num', 'text-anchor': anchor, 'font-size': tickFont, fill: t.textMuted
                    });
                }
            }

            /* ---- footer -------------------------------------------------- */
            var st = [];
            st.push((chart === 'imr' ? 'I-MR' : (chart === 'xbarr' ? 'X̄-R' : 'X̄-S') + ' n=' + L.size) +
                ' · ' + k + 'σ');
            st.push('σ ' + fmtV(L.sigma));
            if (cap) {
                if (PVX.util.isNum(cap.cpk)) { st.push('Cpk ' + cap.cpk.toFixed(2)); }
                if (PVX.util.isNum(cap.ppk)) { st.push('Ppk ' + cap.ppk.toFixed(2)); }
            }
            scope.pvx.stats = st.join(' · ');

            if (nBroken || nSecBroken) {
                var parts = [];
                var keys = Object.keys(counts).sort(function (x, y) { return x - y; });
                for (p = 0; p < keys.length; p++) { parts.push(counts[keys[p]] + '× rule ' + keys[p]); }
                if (nSecBroken) { parts.push(nSecBroken + '× ' + L.secName + ' limit'); }
                scope.pvx.status = 'out';
                scope.pvx.note = (nBroken + nSecBroken) + (nBroken + nSecBroken === 1 ? ' point breaks' : ' points break') +
                    ' a rule: ' + parts.join(', ');
            } else {
                scope.pvx.status = ruleCfg.rules.length ? 'in' : '';
                scope.pvx.note = ruleCfg.rules.length
                    ? 'No rule broken over ' + L.primary.length + ' points' : 'Run rules off';
            }
            // Nothing is dropped silently: say what did not make it onto the chart.
            var extra = [];
            if (L.dropped) { extra.push(L.dropped + ' trailing sample' + (L.dropped === 1 ? '' : 's') + ' short of a subgroup'); }
            if (emptyIntervals) { extra.push(emptyIntervals + ' empty interval' + (emptyIntervals === 1 ? '' : 's')); }
            if (model.dropped) { extra.push(model.dropped + ' non-numeric value' + (model.dropped === 1 ? '' : 's') + ' left out'); }
            if (src === 'baseline') { extra.push('limits from the first ' + L.baseline + ' points'); }
            if (src === 'af') { extra.push('limits from AF ' + (cfg.AfUclTrait || 'Hi') + '/' + (cfg.AfLclTrait || 'Lo') + (trait('Target') !== null ? '/Target' : '')); }
            if (cfg.SpecFromAf) {
                extra.push(traits.phase === 'error' ? 'spec from AF: ' + traits.error
                    : specAf.length ? specAf.join(', ') + ' from AF' : traits.phase === 'loading' ? 'reading the spec from AF' : 'no spec traits in AF');
            }
            if (src === 'fixed') { extra.push('fixed limits'); }
            if (src === 'sources') { extra.push('limits from data sources'); }
            if (lslSrc !== null || uslSrc !== null) { extra.push('spec from data sources'); }
            if (extra.length) { scope.pvx.note += ' · ' + extra.join(' · '); }

            digest();

            /* ---- closures over this frame -------------------------------- */
            function drawHistogram() {
                var hst = PVX.stats.histogram(pvals, { min: dom[0], max: dom[1] });
                if (!hst.n || !hst.peak) { return; }
                // The normal curve the limits assume, from the centre line and
                // the within sigma. The strip is scaled to fit both it and the
                // bars: when the bars come out flat beside a tall narrow curve,
                // the spread is far wider than the limits allow for, and that
                // is the point of showing it.
                var sigmaPlot = L.s;
                var scaleCurve = hst.n * hst.width;
                var curvePeak = sigmaPlot > 0 ? PVX.stats.normalPdf(L.center, L.center, sigmaPlot) * scaleCurve : 0;
                var sxh = PVX.scale.linear(0, Math.max(hst.peak, curvePeak), hist.x, hist.x1);
                for (var b = 0; b < hst.bins.length; b++) {
                    var bin = hst.bins[b];
                    if (!bin.count) { continue; }
                    var yTop = sy(bin.to), yBot = sy(bin.from);
                    var out = bin.from >= L.ucl || bin.to <= L.lcl;
                    PVX.svg.el('rect', {
                        x: hist.x.toFixed(2), y: (Math.min(yTop, yBot) + 0.5).toFixed(2),
                        width: Math.max(0.5, sxh(bin.count) - hist.x).toFixed(2),
                        height: Math.max(0.5, Math.abs(yBot - yTop) - 1).toFixed(2),
                        fill: out ? cs.alarm : (cfg.AccentColor || '#3b82c4'), 'fill-opacity': 0.45,
                        'class': 'pvx-spc-bin'
                    }, svgRoot);
                }
                if (sigmaPlot > 0) {
                    var pts = [];
                    for (var i = 0; i <= 40; i++) {
                        var v = dom[0] + (dom[1] - dom[0]) * i / 40;
                        var f = PVX.stats.normalPdf(v, L.center, sigmaPlot) * scaleCurve;
                        pts.push({ x: sxh(f), y: sy(v) });
                    }
                    PVX.svg.el('path', {
                        d: PVX.svg.line(pts, false), fill: 'none', stroke: t.text, 'stroke-opacity': 0.55,
                        'stroke-width': 1, 'class': 'pvx-spc-curve'
                    }, svgRoot);
                }
                hline(svgRoot, hist, sy(L.ucl), cs.alarm, '5 3', 1);
                hline(svgRoot, hist, sy(L.lcl), cs.alarm, '5 3', 1);
                hline(svgRoot, hist, sy(L.center), t.text, null, 1, 0.5);
                PVX.svg.el('line', {
                    x1: hist.x.toFixed(2), y1: hist.y.toFixed(2), x2: hist.x.toFixed(2), y2: hist.y1.toFixed(2),
                    stroke: t.axis, 'stroke-width': 1
                }, svgRoot);
            }
            function zone(a, b, color, opacity) {
                var y0 = sy(PVX.util.clamp(Math.max(a, b), dom[0], dom[1]));
                var y1 = sy(PVX.util.clamp(Math.min(a, b), dom[0], dom[1]));
                if (Math.abs(y1 - y0) < 0.5) { return; }
                PVX.svg.el('rect', {
                    x: pri.x.toFixed(2), y: Math.min(y0, y1).toFixed(2), width: pri.w.toFixed(2),
                    height: Math.abs(y1 - y0).toFixed(2), fill: color, 'fill-opacity': opacity,
                    'class': 'pvx-spc-zone'
                }, svgRoot);
            }
            function specLine(v, name) {
                if (v === null) { return; }
                hline(svgRoot, pri, sy(v), name === 'Target' ? cs.normal : cs.critical, '2 3', 1.4);
                if (pri.w > 120) {
                    // Above its line, unless that would leave the plot.
                    var ly = sy(v) - tickFont * 0.55;
                    if (ly - tickFont * 0.85 < pri.y) { ly = sy(v) + tickFont * 1.1; }
                    PVX.svg.text(svgRoot, (pri.x + 4).toFixed(2), ly.toFixed(2), name, {
                        'class': 'pvx-svg-label pvx-spc-spec', 'font-size': tickFont * 0.85,
                        fill: name === 'Target' ? cs.normal : cs.critical
                    });
                }
            }
            function caption(x, y, str, color) {
                PVX.svg.text(svgRoot, x.toFixed(2), y.toFixed(2), str, {
                    'class': 'pvx-svg-label pvx-num', 'font-size': (tickFont * 0.9).toFixed(1), fill: color
                });
            }
            function vline(x, y0, y1) {
                PVX.svg.el('line', {
                    x1: x.toFixed(2), y1: y0.toFixed(2), x2: x.toFixed(2), y2: y1.toFixed(2),
                    stroke: t.axis, 'stroke-width': 1
                }, svgRoot);
            }
            function tickLabel(x, y, v) {
                PVX.svg.text(svgRoot, x.toFixed(2), y.toFixed(2), PVX.fmt.tick(v), {
                    'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end', 'font-size': tickFont, fill: t.textMuted
                });
            }
            function fmtV(v) { return PVX.fmt.number(v, numOpts); }
        }

        /* ================================================================== *
         * helpers
         * ================================================================== */

        /** Which rules, and how long a run rule 2 needs, from the config. */
        function ruleSet(cfg) {
            var name = cfg.RuleSet || 'nelson';
            if (name !== 'custom') { return RULE_SETS[name] || RULE_SETS.nelson; }
            var rules = [];
            var parts = String(cfg.CustomRules || '').split(/[,;\s]+/);
            for (var i = 0; i < parts.length; i++) {
                var r = parseInt(parts[i], 10);
                if (r >= 1 && r <= 8 && rules.indexOf(r) === -1) { rules.push(r); }
            }
            return {
                rules: rules,
                run2: PVX.util.clamp(parseInt(cfg.RunLength, 10) || 9, 6, 15),
                run3: PVX.util.clamp(parseInt(cfg.TrendLength, 10) || 6, 4, 10),
                run4: PVX.util.clamp(parseInt(cfg.AlternateLength, 10) || 14, 8, 20)
            };
        }

        /**
         * The latest good value of data source n (1-based), or null for '0',
         * a missing source, or one with nothing numeric in the range. Limits
         * held in PI are step values; the latest one is the one in force.
         */
        function latest(all, n) {
            var i = parseInt(n, 10);
            if (!(i >= 1) || !all[i - 1]) { return null; }
            var pts = all[i - 1].points || [];
            return pts.length ? pts[pts.length - 1].v : null;
        }

        /** Samples PI Vision sent that are not numbers, for the footer. */
        function countDropped(d) {
            var items = d && (d.Data || d.data);
            var all = model.all || [];
            if (!items || !items.length) { return 0; }
            var idx = PVX.util.clamp((parseInt((scope.config || {}).SeriesIndex, 10) || 1) - 1, 0, items.length - 1);
            var vals = (items[idx] && (items[idx].Value || items[idx].Values)) || [];
            var kept = all[idx] ? all[idx].points.length : 0;
            return Math.max(0, vals.length - kept);
        }

        function hline(parent, box, y, stroke, dash, width, opacity) {
            if (!PVX.util.isNum(y)) { return; }
            var a = {
                x1: box.x.toFixed(2), y1: y.toFixed(2), x2: box.x1.toFixed(2), y2: y.toFixed(2),
                stroke: stroke, 'stroke-width': width || 1, 'class': 'pvx-spc-ref'
            };
            if (dash) { a['stroke-dasharray'] = dash; }
            if (opacity !== undefined) { a['stroke-opacity'] = opacity; }
            PVX.svg.el('line', a, parent);
        }

        function textW(str, fontPx) {
            return String(str === null || str === undefined ? '' : str).length * fontPx * CHAR_W;
        }

        function emptyState(root2, w2, h2, th, headline, detail) {
            var f = PVX.util.clamp(Math.round(Math.min(w2, h2) / 16), 9, 13);
            var maxChars = Math.max(4, Math.floor((w2 - 8) / (f * 0.9 * CHAR_W)));
            if (detail.length > maxChars) { detail = detail.slice(0, maxChars - 1) + '…'; }
            PVX.svg.text(root2, (w2 / 2).toFixed(2), (h2 / 2 - f * 0.7).toFixed(2), headline, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': f, 'font-weight': '600', fill: th.textMuted
            });
            PVX.svg.text(root2, (w2 / 2).toFixed(2), (h2 / 2 + f * 0.7).toFixed(2), detail, {
                'class': 'pvx-svg-label', 'text-anchor': 'middle', 'font-size': f * 0.9, fill: th.textMuted, opacity: '0.8'
            });
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
