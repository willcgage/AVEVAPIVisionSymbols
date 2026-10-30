/* ============================================================================
 * pvxKpiCard — headline value, trend delta and inline sparkline
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (data source 1 = the KPI, optional data source 2 = plan)
 *
 * The second reference implementation in the library. Where pvxRadialGauge
 * shows the single-value/Gauge pattern, this one shows the TimeSeries pattern:
 * PI Vision hands back the whole window of values, and the symbol derives the
 * headline number, the period-over-period delta and the sparkline from it.
 *
 * WHY A SECOND DATA SOURCE
 *   A roll-up box asks "are we on plan", not "are we up on an hour ago". The
 *   plan is an AF attribute beside the actual (Revenue Target, daily inlet
 *   plan), so it arrives the way the actual does: drop it on the card as the
 *   second source, and an asset swap re-binds both. The symbol used to be
 *   Single; a display saved then has one source and behaves exactly as before.
 *   Sources beyond the second are not used, and the card says so.
 *
 *   Or the plan is the KPI attribute's own Target trait in AF (PlanFrom
 *   'af'), read through PVX.af once a minute: one place to change a target
 *   that a dozen cards compare against. Or it is a number typed in the pane
 *   (PlanFrom 'fixed'), for a target nobody keeps anywhere else.
 *
 * TOLERANCE AND PROGRESS
 *   "On plan" is rarely exact equality. Within the tolerance the change reads
 *   as on target, in the good color with no arrow, rather than a red 0.3%
 *   that sends someone to look at nothing. The progress bar or ring shows
 *   the headline as a share of the target, measured from a chosen zero, and
 *   is colored by whether the target is met in the good direction.
 *
 * SUMMARY TYPES
 *   'sum' adds the samples, which only means something for counts. 'total'
 *   integrates a rate over time (a flow in t/h totals in t), and 'twavg'
 *   weights each value by how long it held, which is what an average of
 *   compressed or plot values needs: they crowd into the changes. Both use
 *   the trapezoid between samples, as PI does for a continuous tag.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxKpiCard',
        displayName: 'PVX KPI Card',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format KPI Card',
        StateVariables: ['MultistateColor'],

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModePlotValues',
                Intervals: 120,
                Height: 130,
                Width: 240,

                Title: '',                  // blank => use the attribute label
                Statistic: 'last',          // last | avg | twavg | min | max | first | range | sum | total | stdev | count | pctgood
                TotalPer: 'h',              // the rate's time unit for 'total': s | min | h | d
                ShowSparkline: true,
                SparkStyle: 'area',         // area | line | bars
                SparkHeightPct: 38,
                SmoothLine: true,

                ShowDelta: true,
                DeltaBasis: 'window',       // window | plan (plan = data source 2) | average (of the time range)
                // Typed after the change, "vs 7-day avg"; blank: "vs plan",
                // "vs average", or nothing for 'window', as before.
                DeltaCaption: '',
                PlanFrom: 'source',         // source (data source 2) | af (the KPI's Target trait) | fixed
                TargetValue: '',            // PlanFrom 'fixed'
                TargetTolerance: '',        // blank, an amount, or a percent ("2%") either side of the plan
                ProgressStyle: 'none',      // none | bar | ring: the headline as a share of the plan
                ProgressZero: 0,            // where the progress starts
                DeltaMode: 'percent',       // percent | absolute | both
                DeltaLookback: 0.25,        // fraction of the window used as the baseline
                DeltaGoodDirection: 'up',   // up | down | none
                GoodColor: '#2f9e5f',
                BadColor: '#c8452f',

                ShowSecondary: true,
                SecondaryLeft: 'min',       // none | min | max | avg | range | first | count | plan
                SecondaryRight: 'max',
                ShowPlanOnSpark: true,      // plan as a dashed line on the sparkline

                // A colored left edge for the headline's threshold band, the
                // way a roll-up box flags itself without recoloring the
                // number. The placeholder bands never color it.
                StatusEdge: false,
                EdgeWidth: 4,

                ValueColorFromThreshold: false,
                UseThresholds: false,
                AccentColor: '#3b82c4',
                Align: 'left',              // left | center
                ShowUnits: true,
                ShowTime: false,
                TimeFormat: 'short',        // short | datetime | relative
                CornerRadius: 6
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            title: '',
            value: '--',
            units: '',
            time: '',
            deltaText: '',
            deltaArrow: '',
            deltaColor: '',
            showDelta: false,
            secLeft: null,
            secRight: null,
            error: '',
            valueColor: '',
            edgeColor: '',
            note: '',
            progress: null,
            align: 'left'
        };

        var series = null;
        var plan = null;
        var sourcePlan = null;
        var sourceCount = 0;
        var extraSources = 0;
        var quality = null;         // {good, all} samples of the KPI, bad ones included

        var traits = PVX.af.watcher(function () { if (ctx && !ctx.destroyed) { ctx.render(); } });

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-kpi-spark',

            onData: function (d) {
                var all = PVX.data.series(d);
                // series() drops what is not a number; the share that was
                // good needs them counted, so ask the raw samples too.
                var raw = PVX.data.stateSeries(d);
                quality = null;
                if (raw.length) {
                    var good = 0;
                    for (var q = 0; q < raw[0].points.length; q++) {
                        var rp = raw[0].points[q];
                        if (rp.good !== false && rp.v !== null) { good++; }
                    }
                    quality = { good: good, all: raw[0].points.length };
                }
                series = all.length ? all[0] : null;
                sourcePlan = all.length > 1 ? all[1] : null;
                sourceCount = all.length;
                askTarget();
            },
            onConfigChange: function () { askTarget(); },
            onDestroy: function () { traits.stop(); },

            render: render
        });

        function fromAf(cfg) { return cfg.PlanFrom === 'af'; }

        function askTarget() {
            var cfg = scope.config || {};
            var ds = (scope.symbol && scope.symbol.DataSources) || [];
            traits.ask(ds[0], fromAf(cfg) ? ['Target'] : []);
        }

        /** The plan in force: data source 2, or the Target trait as one level. */
        function resolvePlan(cfg) {
            var pts0 = series && series.points.length ? series.points : null;
            if (cfg.PlanFrom === 'fixed') {
                extraSources = Math.max(0, sourceCount - 1);
                var fv = PVX.util.num(cfg.TargetValue);
                plan = fv === null ? null : { points: [{ t: pts0 ? pts0[pts0.length - 1].t : 0, v: fv }], fixed: true };
                return;
            }
            if (!fromAf(cfg)) {
                plan = sourcePlan;
                extraSources = Math.max(0, sourceCount - 2);
                return;
            }
            extraSources = Math.max(0, sourceCount - 1);
            var tv = traits.get('Target');
            var pts = series && series.points.length ? series.points : null;
            plan = tv === null || !pts ? null : { points: [{ t: pts[pts.length - 1].t, v: tv }] };
        }

        var PER_MS = { s: 1000, min: 60000, h: 3600000, d: 86400000 };

        /** Trapezoid integral of the points, in value x milliseconds, and its span. */
        function integral(points) {
            var area = 0, span = 0;
            for (var i = 0; i + 1 < points.length; i++) {
                var dt = points[i + 1].t - points[i].t;
                if (!(dt > 0)) { continue; }
                area += (points[i].v + points[i + 1].v) / 2 * dt;
                span += dt;
            }
            return { area: area, span: span };
        }

        function statValue(stats, key, points) {
            var cfg = ctx && ctx.config ? ctx.config : (scope.config || {});
            switch (key) {
                case 'twavg':
                    if (!points || !points.length) { return null; }
                    var ig = integral(points);
                    return ig.span > 0 ? ig.area / ig.span : stats.avg;
                case 'total':
                    if (!points || points.length < 2) { return null; }
                    return integral(points).area / (PER_MS[cfg.TotalPer] || PER_MS.h);
                case 'stdev':
                    return PVX.stats.stddev(points.map(function (p) { return p.v; }));
                case 'pctgood':
                    return quality && quality.all ? 100 * quality.good / quality.all : null;
                case 'avg': return stats.avg;
                case 'min': return stats.min;
                case 'max': return stats.max;
                case 'first': return stats.first;
                case 'range': return stats.range;
                case 'sum': return stats.sum;
                case 'count': return stats.count;
                case 'last':
                default: return stats.last;
            }
        }

        var STAT_LABEL = {
            last: 'Last', avg: 'Avg', twavg: 'Avg', min: 'Min', max: 'Max', first: 'First', range: 'Range',
            sum: 'Sum', total: 'Total', stdev: 'Std dev', count: 'Count', pctgood: 'Good', plan: 'Plan'
        };

        /**
         * The plan, reduced by the same statistic as the headline, so an
         * average is compared with an average and a sum with a sum. A plan
         * held as one daily value has a single point, and every statistic of
         * one point is that point.
         */
        function planValue(cfg) {
            if (!plan || !plan.points.length) { return null; }
            // A target is a level: the total, spread or quality of one
            // point says nothing, so those compare with the level itself.
            if (plan.points.length === 1 && /^(total|stdev|count|pctgood|twavg)$/.test(cfg.Statistic)) {
                return plan.points[0].v;
            }
            var v = statValue(PVX.data.stats(plan.points), cfg.Statistic, plan.points);
            return v === undefined ? null : v;
        }

        /** Actual vs plan, in the same shape PVX.stats.delta returns. */
        function planDelta(actual, target) {
            if (actual === null || actual === undefined || target === null) { return null; }
            var abs = actual - target;
            return {
                absolute: abs,
                percent: Math.abs(target) > 1e-12 ? (abs / Math.abs(target)) * 100 : null,
                direction: abs > 0 ? 1 : (abs < 0 ? -1 : 0),
                from: target,
                to: actual
            };
        }

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;

            resolvePlan(cfg);
            scope.pvx.align = cfg.Align === 'center' ? 'center' : 'left';

            var points = series ? series.points : [];
            var stats = PVX.data.stats(points);

            scope.pvx.title = cfg.Title || (series ? series.label : '') || '';
            scope.pvx.units = cfg.ShowUnits && series ? (series.units || '') : '';
            scope.pvx.error = (series && !series.good) ? (series.errorDescription || 'Bad data') : '';

            var last = points.length ? points[points.length - 1] : null;
            var tf = cfg.TimeFormat === 'datetime' || cfg.TimeFormat === 'relative' ? cfg.TimeFormat : 'short';
            scope.pvx.time = (cfg.ShowTime && last) ? PVX.fmt.time(last.date || last.time, tf) : '';

            var headline = statValue(stats, cfg.Statistic, points);
            scope.pvx.value = headline === null || headline === undefined
                ? '--'
                : PVX.fmt.number(headline, PVX.config.numberOpts(cfg));
            if (cfg.Statistic === 'pctgood' && cfg.ShowUnits) { scope.pvx.units = '% good'; }
            else if (cfg.Statistic === 'total' && cfg.ShowUnits && series && series.units) {
                scope.pvx.units = totalUnits(series.units, cfg.TotalPer);
            }

            // ---- value color ------------------------------------------------
            if (scope.MultistateColor) {
                scope.pvx.valueColor = scope.MultistateColor;
            } else if (cfg.UseThresholds && cfg.ValueColorFromThreshold) {
                scope.pvx.valueColor = PVX.thresholds.colorFor(cfg.Thresholds, headline, t.text);
            } else {
                scope.pvx.valueColor = t.text;
            }

            // ---- status edge --------------------------------------------------
            // Multistate wins, as it does for the value. Below the first band,
            // or with only the placeholder bands, the edge stays the border.
            scope.pvx.edgeColor = '';
            if (cfg.StatusEdge) {
                if (scope.MultistateColor) {
                    scope.pvx.edgeColor = scope.MultistateColor;
                } else if (headline !== null && headline !== undefined &&
                        !PVX.thresholds.isPlaceholder(cfg.Thresholds)) {
                    var band = PVX.thresholds.evaluate(cfg.Thresholds, headline);
                    scope.pvx.edgeColor = band ? band.color : '';
                }
            }

            // ---- delta -------------------------------------------------------
            var target = planValue(cfg);
            var vsPlan = cfg.DeltaBasis === 'plan';
            var notes = [];
            if (fromAf(cfg) && !plan) {
                notes.push(traits.phase === 'error' ? 'Target from AF: ' + traits.error
                    : traits.phase === 'ok' ? 'No Target trait on this attribute in AF' : 'Reading the target from AF');
            } else if (cfg.PlanFrom === 'fixed' && !plan && (vsPlan || progressOn(cfg))) {
                notes.push('No target value set: open Format and type one');
            } else if (vsPlan && !plan) { notes.push('No plan source: add the plan as data source 2'); }
            else if (vsPlan && target === null) { notes.push('Plan has no value in this time range'); }
            if (extraSources) {
                notes.push(extraSources + (extraSources === 1 ? ' extra source' : ' extra sources') + ' not used');
            }
            scope.pvx.note = notes.join(' · ');

            // 'average': the headline against the time-weighted average of the
            // whole range, so "vs 7-day avg" means that over a 7-day range.
            var vsAvg = !vsPlan && cfg.DeltaBasis === 'average';
            var delta = !cfg.ShowDelta ? null
                : vsPlan ? planDelta(headline, target)
                : vsAvg ? planDelta(headline, statValue(stats, 'twavg', points))
                : PVX.stats.delta(points, PVX.util.num(cfg.DeltaLookback) || 0.25);
            var caption = String(cfg.DeltaCaption === undefined || cfg.DeltaCaption === null ? '' : cfg.DeltaCaption).trim();
            var suffix = caption ? ' ' + caption : (vsPlan ? ' vs plan' : (vsAvg ? ' vs average' : ''));
            var tol = vsPlan ? tolerance(cfg, target) : null;
            var onTarget = !!(delta && tol !== null && Math.abs(delta.absolute) <= tol);
            scope.pvx.showDelta = !!delta;
            if (delta && onTarget) {
                var tPct = delta.percent === null ? '' : ' (' + (delta.percent >= 0 ? '+' : '') + delta.percent.toFixed(1) + '%)';
                scope.pvx.deltaText = 'On target' + (cfg.DeltaMode === 'absolute' ? '' : tPct) + (caption ? ' ' + caption : '');
                scope.pvx.deltaArrow = '\u25cf';
                scope.pvx.deltaColor = cfg.DeltaGoodDirection === 'none' ? t.textMuted : (cfg.GoodColor || '#2f9e5f');
            } else if (delta) {
                var pctText = delta.percent === null ? '--' : (delta.percent >= 0 ? '+' : '') + delta.percent.toFixed(1) + '%';
                var absText = (delta.absolute >= 0 ? '+' : '') + PVX.fmt.number(delta.absolute, PVX.config.numberOpts(cfg));
                scope.pvx.deltaText =
                    (cfg.DeltaMode === 'absolute' ? absText :
                     cfg.DeltaMode === 'both' ? (absText + '  (' + pctText + ')') : pctText) + suffix;

                scope.pvx.deltaArrow = delta.direction > 0 ? '▲' : (delta.direction < 0 ? '▼' : '▬');

                var good = cfg.DeltaGoodDirection;
                if (good === 'none' || delta.direction === 0) {
                    scope.pvx.deltaColor = t.textMuted;
                } else {
                    var isGood = (good === 'up' && delta.direction > 0) || (good === 'down' && delta.direction < 0);
                    scope.pvx.deltaColor = isGood ? (cfg.GoodColor || '#2f9e5f') : (cfg.BadColor || '#c8452f');
                }
            }

            // ---- progress ------------------------------------------------------
            scope.pvx.progress = progressOn(cfg) ? progress(cfg, t, headline, target) : null;
            if (progressOn(cfg) && !scope.pvx.progress && target === null && !scope.pvx.note) {
                scope.pvx.note = 'Progress needs a plan or target';
            }

            // ---- secondary stats ---------------------------------------------
            var mkSec = function (key) {
                if (!key || key === 'none') { return null; }
                var v = key === 'plan' ? target : statValue(stats, key, points);
                if (v === null || v === undefined) { return null; }
                return {
                    label: STAT_LABEL[key] || key,
                    value: PVX.fmt.number(v, PVX.config.numberOpts(cfg))
                };
            };
            scope.pvx.secLeft = cfg.ShowSecondary ? mkSec(cfg.SecondaryLeft) : null;
            scope.pvx.secRight = cfg.ShowSecondary ? mkSec(cfg.SecondaryRight) : null;

            applyThemeVars(c, t);
            renderSpark(c, cfg, t, host, points, stats);

            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        function progressOn(cfg) { return cfg.ProgressStyle === 'bar' || cfg.ProgressStyle === 'ring'; }

        /** The tolerance either side of the plan, in the KPI's units, or null. */
        function tolerance(cfg, target) {
            var raw = String(cfg.TargetTolerance === undefined || cfg.TargetTolerance === null ? '' : cfg.TargetTolerance).trim();
            if (!raw || target === null) { return null; }
            var pct = /%$/.test(raw);
            var n = PVX.util.num(pct ? raw.slice(0, -1) : raw);
            if (n === null || n < 0) { return null; }
            return pct ? Math.abs(target) * n / 100 : n;
        }

        /**
         * The headline as a share of the way from ProgressZero to the plan.
         * Met means reaching the plan in the good direction (or within the
         * tolerance of it); with no good direction the bar keeps the accent.
         */
        function progress(cfg, t, headline, target) {
            if (headline === null || headline === undefined || target === null) { return null; }
            var zero = PVX.util.num(cfg.ProgressZero);
            if (zero === null) { zero = 0; }
            if (Math.abs(target - zero) < 1e-12) { return null; }
            var share = (headline - zero) / (target - zero) * 100;
            var tol = tolerance(cfg, target) || 0;
            var dir = cfg.DeltaGoodDirection;
            var met = dir === 'down' ? headline <= target + tol : headline >= target - tol;
            var color = dir === 'none' ? (cfg.AccentColor || '#3b82c4') :
                met ? (cfg.GoodColor || '#2f9e5f') : (cfg.BadColor || '#c8452f');
            var fill = PVX.util.clamp(share, 0, 100);
            return {
                style: cfg.ProgressStyle,
                fill: fill.toFixed(1),
                // r = 15.915 makes the ring's circumference 100, so the
                // dash length is the percentage itself.
                dash: fill.toFixed(1) + ' 100',
                text: Math.round(share) + '%',
                title: Math.round(share) + '% of ' + (plan && plan.fixed ? 'the target' : 'plan') + ' (' +
                    PVX.fmt.number(target, PVX.config.numberOpts(cfg)) + ')' +
                    (zero ? ', counted from ' + PVX.fmt.number(zero, PVX.config.numberOpts(cfg)) : ''),
                color: color
            };
        }

        /** "t/h" totalled per hour is "t"; anything else gets "x h" spelled out. */
        function totalUnits(units, per) {
            var p = per && PER_MS[per] ? per : 'h';
            var m = new RegExp('^(.*?)\\s*/\\s*' + (p === 'min' ? 'min' : p) + '$', 'i').exec(units);
            if (m && m[1]) { return m[1]; }
            return units + '\u00b7' + p;
        }

        /** Push theme tokens onto the element as CSS custom properties. */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', c.config.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
        }

        function renderSpark(c, cfg, t, host, points, stats) {
            if (!host) { return; }
            var svgRoot = host.querySelector('svg.pvx-kpi-svg');
            if (!cfg.ShowSparkline || points.length < 2) {
                if (svgRoot) { PVX.svg.clear(svgRoot); }
                return;
            }
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-kpi-svg' }, host);
            }

            var W = Math.max(20, host.clientWidth || c.width);
            var H = Math.max(12, host.clientHeight || 30);
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var padY = 2;
            var lo = stats.min, hi = stats.max;
            // The plan shares the scale, or a plan line above every actual
            // would be drawn off the top of the card.
            var planPts = (cfg.ShowPlanOnSpark && plan) ? plan.points : [];
            if (planPts.length) {
                var ps = PVX.data.stats(planPts);
                if (ps.min !== null) { lo = Math.min(lo, ps.min); hi = Math.max(hi, ps.max); }
            }
            if (lo === hi) { lo -= 0.5; hi += 0.5; }
            var x = PVX.scale.linear(points[0].t, points[points.length - 1].t, 0, W);
            var y = PVX.scale.linear(lo, hi, H - padY, padY);

            var pts = points.map(function (p) { return { x: x(p.t), y: y(p.v) }; });

            var strokeColor = scope.pvx.valueColor && cfg.ValueColorFromThreshold
                ? scope.pvx.valueColor
                : (cfg.AccentColor || '#3b82c4');

            if (cfg.SparkStyle === 'bars') {
                var bw = Math.max(1, (W / points.length) * 0.7);
                for (var i = 0; i < pts.length; i++) {
                    var h = Math.max(1, (H - padY) - pts[i].y);
                    PVX.svg.el('rect', {
                        x: (pts[i].x - bw / 2).toFixed(2),
                        y: pts[i].y.toFixed(2),
                        width: bw.toFixed(2),
                        height: h.toFixed(2),
                        fill: strokeColor,
                        opacity: 0.85
                    }, svgRoot);
                }
            } else {
                if (cfg.SparkStyle === 'area') {
                    var gradId = host.getAttribute('data-pvx-grad') || PVX.util.uid('kpigrad');
                    host.setAttribute('data-pvx-grad', gradId);
                    var defs = PVX.svg.el('defs', null, svgRoot);
                    var grad = PVX.svg.el('linearGradient', {
                        id: gradId, x1: '0', y1: '0', x2: '0', y2: '1'
                    }, defs);
                    PVX.svg.el('stop', { offset: '0%', 'stop-color': strokeColor, 'stop-opacity': '0.38' }, grad);
                    PVX.svg.el('stop', { offset: '100%', 'stop-color': strokeColor, 'stop-opacity': '0.02' }, grad);
                    PVX.svg.el('path', {
                        d: PVX.svg.area(pts, H, !!cfg.SmoothLine),
                        fill: 'url(#' + gradId + ')',
                        stroke: 'none'
                    }, svgRoot);
                }
                PVX.svg.el('path', {
                    d: PVX.svg.line(pts, !!cfg.SmoothLine),
                    fill: 'none',
                    stroke: strokeColor,
                    'stroke-width': 1.6,
                    'stroke-linejoin': 'round',
                    'stroke-linecap': 'round',
                    'vector-effect': 'non-scaling-stroke'
                }, svgRoot);
            }

            if (planPts.length) {
                // A plan held as one daily value is a level, so it spans the
                // card rather than sitting as a dot at its own timestamp.
                var t0 = points[0].t, t1 = points[points.length - 1].t;
                var pp = planPts.length === 1
                    ? [{ x: 0, y: y(planPts[0].v) }, { x: W, y: y(planPts[0].v) }]
                    : planPts.filter(function (p) { return p.t >= t0 && p.t <= t1; })
                        .map(function (p) { return { x: x(p.t), y: y(p.v) }; });
                if (pp.length > 1) {
                    PVX.svg.el('path', {
                        d: PVX.svg.stepLine(pp),
                        fill: 'none',
                        stroke: t.textMuted,
                        'stroke-width': 1,
                        'stroke-dasharray': '4 3',
                        'vector-effect': 'non-scaling-stroke',
                        'class': 'pvx-kpi-plan'
                    }, svgRoot);
                }
            }

            // Endpoint dot anchors the eye to "now".
            var lastPt = pts[pts.length - 1];
            PVX.svg.el('circle', {
                cx: Math.min(lastPt.x, W - 2).toFixed(2),
                cy: lastPt.y.toFixed(2),
                r: 2.2,
                fill: strokeColor
            }, svgRoot);
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
