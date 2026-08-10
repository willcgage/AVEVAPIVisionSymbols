/* ============================================================================
 * pvxKpiCard — headline value, trend delta and inline sparkline
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (single data source)
 *
 * The second reference implementation in the library. Where pvxRadialGauge
 * shows the single-value/Gauge pattern, this one shows the TimeSeries pattern:
 * PI Vision hands back the whole window of values, and the symbol derives the
 * headline number, the period-over-period delta and the sparkline from it.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxKpiCard',
        displayName: 'PVX KPI Card',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,
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
                Statistic: 'last',          // last | avg | min | max | first | range | sum
                ShowSparkline: true,
                SparkStyle: 'area',         // area | line | bars
                SparkHeightPct: 38,
                SmoothLine: true,

                ShowDelta: true,
                DeltaMode: 'percent',       // percent | absolute | both
                DeltaLookback: 0.25,        // fraction of the window used as the baseline
                DeltaGoodDirection: 'up',   // up | down | none
                GoodColor: '#2f9e5f',
                BadColor: '#c8452f',

                ShowSecondary: true,
                SecondaryLeft: 'min',       // none | min | max | avg | range | first | count
                SecondaryRight: 'max',

                ValueColorFromThreshold: false,
                UseThresholds: false,
                AccentColor: '#3b82c4',
                Align: 'left',              // left | center
                ShowUnits: true,
                ShowTime: false,
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
            align: 'left'
        };

        var series = null;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-kpi-spark',

            onData: function (d) {
                var all = PVX.data.series(d);
                series = all.length ? all[0] : null;
            },

            render: render
        });

        function statValue(stats, key, points) {
            switch (key) {
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
            last: 'Last', avg: 'Avg', min: 'Min', max: 'Max',
            first: 'First', range: 'Range', sum: 'Sum', count: 'Count'
        };

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;

            scope.pvx.align = cfg.Align === 'center' ? 'center' : 'left';

            var points = series ? series.points : [];
            var stats = PVX.data.stats(points);

            scope.pvx.title = cfg.Title || (series ? series.label : '') || '';
            scope.pvx.units = cfg.ShowUnits && series ? (series.units || '') : '';
            scope.pvx.error = (series && !series.good) ? (series.errorDescription || 'Bad data') : '';

            var last = points.length ? points[points.length - 1] : null;
            scope.pvx.time = (cfg.ShowTime && last) ? PVX.fmt.time(last.date || last.time, 'short') : '';

            var headline = statValue(stats, cfg.Statistic, points);
            scope.pvx.value = headline === null || headline === undefined
                ? '--'
                : PVX.fmt.number(headline, PVX.config.numberOpts(cfg));

            // ---- value colour ------------------------------------------------
            if (scope.MultistateColor) {
                scope.pvx.valueColor = scope.MultistateColor;
            } else if (cfg.UseThresholds && cfg.ValueColorFromThreshold) {
                scope.pvx.valueColor = PVX.thresholds.colorFor(cfg.Thresholds, headline, t.text);
            } else {
                scope.pvx.valueColor = t.text;
            }

            // ---- delta -------------------------------------------------------
            var delta = cfg.ShowDelta ? PVX.stats.delta(points, PVX.util.num(cfg.DeltaLookback) || 0.25) : null;
            scope.pvx.showDelta = !!delta;
            if (delta) {
                var pctText = delta.percent === null ? '--' : (delta.percent >= 0 ? '+' : '') + delta.percent.toFixed(1) + '%';
                var absText = (delta.absolute >= 0 ? '+' : '') + PVX.fmt.number(delta.absolute, PVX.config.numberOpts(cfg));
                scope.pvx.deltaText =
                    cfg.DeltaMode === 'absolute' ? absText :
                    cfg.DeltaMode === 'both' ? (absText + '  (' + pctText + ')') : pctText;

                scope.pvx.deltaArrow = delta.direction > 0 ? '▲' : (delta.direction < 0 ? '▼' : '▬');

                var good = cfg.DeltaGoodDirection;
                if (good === 'none' || delta.direction === 0) {
                    scope.pvx.deltaColor = t.textMuted;
                } else {
                    var isGood = (good === 'up' && delta.direction > 0) || (good === 'down' && delta.direction < 0);
                    scope.pvx.deltaColor = isGood ? (cfg.GoodColor || '#2f9e5f') : (cfg.BadColor || '#c8452f');
                }
            }

            // ---- secondary stats ---------------------------------------------
            var mkSec = function (key) {
                if (!key || key === 'none') { return null; }
                var v = statValue(stats, key, points);
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
