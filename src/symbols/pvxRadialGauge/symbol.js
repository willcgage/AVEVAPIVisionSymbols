/* ============================================================================
 * pvxRadialGauge — threshold-banded radial gauge for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Gauge (single data source)
 *
 * Features
 *   - Configurable sweep angle (full circle through to a shallow arc)
 *   - Threshold bands drawn on the dial, driven by the shared PVX threshold spec
 *   - Needle or progress-arc styles
 *   - Optional target/setpoint marker
 *   - Value colour follows the active threshold band
 *   - Auto light/dark theming, fully responsive typography
 *
 * This file is the reference implementation for the library: every other PVX
 * symbol follows the same structure (definition -> init -> PVX.bootstrap ->
 * one pure render function).
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxRadialGauge',
        displayName: 'PVX Radial Gauge',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format Radial Gauge',
        StateVariables: ['MultistateColor'],

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Gauge',
                Height: 200,
                Width: 220,

                // Scale
                MinValue: 0,
                MaxValue: 100,
                UseSymbolScale: true,      // false => trust PI Vision's Indicator
                StartAngle: -120,          // degrees, 0 = 12 o'clock, clockwise +
                EndAngle: 120,

                // Style
                GaugeStyle: 'arc',         // arc | needle | both
                ArcThickness: 14,          // px at a 200px reference size
                ShowBands: true,
                BandOpacity: 0.28,
                ShowScaleLabels: true,
                ShowTicks: true,
                TickCount: 5,

                // Target marker
                ShowTarget: false,
                TargetValue: 75,
                TargetColor: '#1d2126',

                // Readout
                ValueColorFromThreshold: true,
                ValueColor: '#1d2126',
                ShowStateLabel: false,
                ShowLabel: true,
                ShowUnits: true,
                ShowTime: false
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // scope fields consumed by the template
        scope.pvx = {
            label: '',
            units: '',
            time: '',
            error: ''
        };

        var model = {
            value: null,
            display: '--',
            indicator: null,
            good: true
        };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-gauge-body',

            onData: function (d) {
                var s = PVX.data.single(d);
                if (!s) { return; }
                model.value = s.value;
                model.raw = s.raw;
                model.indicator = s.indicator;
                model.good = s.good;
                scope.pvx.label = s.label || '';
                scope.pvx.units = s.units || '';
                scope.pvx.time = s.time || '';
                scope.pvx.error = s.good ? '' : (s.errorDescription || 'Bad data');
                // Expose for PI Vision multistate binding.
                scope.value = s.raw;
            },

            render: render
        });

        function scaleBounds(cfg) {
            var min = PVX.util.num(cfg.MinValue);
            var max = PVX.util.num(cfg.MaxValue);
            if (min === null) { min = 0; }
            if (max === null || max <= min) { max = min + 100; }
            return [min, max];
        }

        /** Fraction 0..1 of the way along the dial for the current value. */
        function fraction(cfg) {
            if (!cfg.UseSymbolScale && PVX.util.isNum(model.indicator)) {
                return PVX.util.clamp(model.indicator / 100, 0, 1);
            }
            if (model.value === null) { return null; }
            var b = scaleBounds(cfg);
            return PVX.util.clamp((model.value - b[0]) / ((b[1] - b[0]) || 1), 0, 1);
        }

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            var W = Math.max(40, c.width);
            var H = Math.max(40, c.height);

            var svgRoot = host.querySelector('svg.pvx-gauge-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-gauge-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'xMidYMid meet');
            PVX.svg.clear(svgRoot);

            var startA = PVX.util.num(cfg.StartAngle);
            var endA = PVX.util.num(cfg.EndAngle);
            if (startA === null) { startA = -120; }
            if (endA === null || endA <= startA) { endA = startA + 240; }
            var sweep = Math.min(endA - startA, 360);
            endA = startA + sweep;

            var bounds = scaleBounds(cfg);
            var frac = fraction(cfg);

            // --- geometry -----------------------------------------------------
            // Fit the arc's bounding box rather than assuming a square, so partial
            // sweeps use the available height instead of leaving a dead band.
            var box = arcBoundingBox(startA, endA);
            var pad = 6;
            var availW = W - pad * 2;
            var availH = H - pad * 2;
            var r = Math.max(8, Math.min(availW / (box.w || 1), availH / (box.h || 1)));
            var cx = pad + (-box.x0) * r + (availW - box.w * r) / 2;
            var cy = pad + (-box.y0) * r + (availH - box.h * r) / 2;

            var thickness = PVX.util.clamp(
                (PVX.util.num(cfg.ArcThickness) || 14) * (r / 90),
                4, r * 0.6
            );
            var rOuter = r;
            var rInner = r - thickness;
            var rMid = (rOuter + rInner) / 2;

            var angleFor = function (v) {
                var f = PVX.util.clamp((v - bounds[0]) / ((bounds[1] - bounds[0]) || 1), 0, 1);
                return startA + f * sweep;
            };

            // --- track --------------------------------------------------------
            PVX.svg.el('path', {
                d: PVX.svg.annulus(cx, cy, rInner, rOuter, startA, endA),
                fill: t.track,
                'class': 'pvx-gauge-track'
            }, svgRoot);

            // --- threshold bands ----------------------------------------------
            var activeBand = cfg.UseThresholds ? PVX.thresholds.evaluate(cfg.Thresholds, model.value) : null;
            if (cfg.ShowBands && cfg.UseThresholds) {
                var bands = PVX.thresholds.bands(cfg.Thresholds, bounds[0], bounds[1]);
                for (var i = 0; i < bands.length; i++) {
                    var a0 = angleFor(bands[i].from);
                    var a1 = angleFor(bands[i].to);
                    if (a1 - a0 < 0.2) { continue; }
                    PVX.svg.el('path', {
                        d: PVX.svg.annulus(cx, cy, rInner, rOuter, a0, a1),
                        fill: PVX.color.rgba(bands[i].color, PVX.util.num(cfg.BandOpacity) || 0.28),
                        'class': 'pvx-gauge-band'
                    }, svgRoot);
                }
            }

            // --- value colour ---------------------------------------------------
            var valueColor;
            if (scope.MultistateColor) {
                valueColor = scope.MultistateColor;            // PI Vision multistate wins
            } else if (cfg.ValueColorFromThreshold && activeBand) {
                valueColor = activeBand.color;
            } else {
                valueColor = cfg.AccentColor || '#3b82c4';
            }
            if (!model.good) { valueColor = PVX.color.status.stale; }

            // --- progress arc ---------------------------------------------------
            var style = cfg.GaugeStyle || 'arc';
            if (frac !== null && (style === 'arc' || style === 'both')) {
                var valA = startA + frac * sweep;
                if (valA - startA > 0.2) {
                    PVX.svg.el('path', {
                        d: PVX.svg.annulus(cx, cy, rInner, rOuter, startA, valA),
                        fill: valueColor,
                        'class': 'pvx-gauge-value-arc pvx-animate'
                    }, svgRoot);
                }
            }

            // --- ticks + scale labels -------------------------------------------
            // Scale labels live inside the dial, so the centre readout has to be
            // sized against the radius left INSIDE them. Reserve that ring here,
            // before anything is drawn, and let the readout use rContent.
            var tickLen = (cfg.ShowTicks ? Math.max(3, r * 0.06) + 2 : 0);
            var scaleFont = PVX.util.clamp(r * 0.13, 7, 13);
            var rContent = rInner - tickLen - (cfg.ShowScaleLabels ? scaleFont * 2.0 : 4);
            rContent = Math.max(12, rContent);

            if (cfg.ShowTicks || cfg.ShowScaleLabels) {
                var tickVals = PVX.scale.ticks(bounds[0], bounds[1],
                    PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12));
                // Always anchor the ends of the dial.
                if (tickVals[0] > bounds[0]) { tickVals.unshift(bounds[0]); }
                if (tickVals[tickVals.length - 1] < bounds[1]) { tickVals.push(bounds[1]); }

                for (var k = 0; k < tickVals.length; k++) {
                    var tv = tickVals[k];
                    if (tv < bounds[0] - 1e-9 || tv > bounds[1] + 1e-9) { continue; }
                    var ta = angleFor(tv);
                    if (cfg.ShowTicks) {
                        var p1 = PVX.svg.polar(cx, cy, rInner - 2, ta);
                        var p2 = PVX.svg.polar(cx, cy, rInner - tickLen, ta);
                        PVX.svg.el('line', {
                            x1: p1.x.toFixed(2), y1: p1.y.toFixed(2),
                            x2: p2.x.toFixed(2), y2: p2.y.toFixed(2),
                            stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
                        }, svgRoot);
                    }
                    if (cfg.ShowScaleLabels) {
                        var lp = PVX.svg.polar(cx, cy, rInner - tickLen - scaleFont * 0.9, ta);
                        PVX.svg.text(svgRoot, lp.x.toFixed(2), lp.y.toFixed(2), PVX.fmt.tick(tv), {
                            'class': 'pvx-svg-label',
                            'text-anchor': 'middle',
                            'font-size': scaleFont.toFixed(1),
                            fill: t.textMuted
                        });
                    }
                }
            }

            // --- target marker ----------------------------------------------------
            var target = PVX.util.num(cfg.TargetValue);
            if (cfg.ShowTarget && target !== null) {
                var tg = angleFor(target);
                var tp1 = PVX.svg.polar(cx, cy, rInner - 1, tg);
                var tp2 = PVX.svg.polar(cx, cy, rOuter + 3, tg);
                PVX.svg.el('line', {
                    x1: tp1.x.toFixed(2), y1: tp1.y.toFixed(2),
                    x2: tp2.x.toFixed(2), y2: tp2.y.toFixed(2),
                    stroke: cfg.TargetColor || t.text,
                    'stroke-width': Math.max(2, r * 0.03),
                    'stroke-linecap': 'round',
                    'class': 'pvx-gauge-target'
                }, svgRoot);
            }

            // --- needle -----------------------------------------------------------
            if (frac !== null && (style === 'needle' || style === 'both')) {
                var na = startA + frac * sweep;
                var tip = PVX.svg.polar(cx, cy, rInner - Math.max(3, r * 0.06), na);
                var baseW = Math.max(2, r * 0.035);
                var bl = PVX.svg.polar(cx, cy, baseW, na - 90);
                var br = PVX.svg.polar(cx, cy, baseW, na + 90);
                PVX.svg.el('path', {
                    d: 'M' + bl.x.toFixed(2) + ' ' + bl.y.toFixed(2) +
                       ' L' + tip.x.toFixed(2) + ' ' + tip.y.toFixed(2) +
                       ' L' + br.x.toFixed(2) + ' ' + br.y.toFixed(2) + ' Z',
                    fill: style === 'both' ? t.text : valueColor,
                    'class': 'pvx-gauge-needle pvx-animate'
                }, svgRoot);
                PVX.svg.el('circle', {
                    cx: cx.toFixed(2), cy: cy.toFixed(2), r: (baseW * 1.6).toFixed(2),
                    fill: t.surface === 'transparent' ? t.text : t.surface,
                    stroke: style === 'both' ? t.text : valueColor,
                    'stroke-width': Math.max(1.5, r * 0.02)
                }, svgRoot);
            }

            // --- centre readout ----------------------------------------------------
            var display = model.value === null
                ? '--'
                : PVX.fmt.number(model.raw, PVX.config.numberOpts(cfg));
            model.display = display;

            // Readout sits in the dial's open area; for a full circle centre it.
            var textCy = cy;
            if (sweep < 330) {
                // Nudge toward the arc's visual centre of mass.
                var midA = startA + sweep / 2;
                var nudge = PVX.svg.polar(cx, cy, rInner * 0.18, midA);
                textCy = cy + (nudge.y - cy);
            }

            // Stacked sub-labels (units, band name) eat into the vertical budget,
            // so the readout gets a smaller slice when they are switched on.
            var subLines = (cfg.ShowUnits && scope.pvx.units ? 1 : 0) +
                           (cfg.ShowStateLabel && activeBand && activeBand.label ? 1 : 0);
            var innerSpan = rContent * 2 * (sweep >= 300 ? 0.80 : 0.96);
            var vertBudget = rContent * (subLines ? 0.78 : 1.05);
            var valueFont = PVX.layout.fitFont(display, innerSpan, vertBudget, Math.max(11, r * 0.42), 9);

            // Lift the number so the block of value + sub-labels stays optically
            // centred rather than the number alone.
            var yShift = subLines * valueFont * 0.16;
            var valueY = textCy - valueFont * 0.08 - yShift;

            var valText = PVX.svg.text(svgRoot, cx.toFixed(2), valueY.toFixed(2), display, {
                'class': 'pvx-svg-value pvx-num',
                'text-anchor': 'middle',
                'font-size': valueFont.toFixed(1),
                fill: cfg.ValueColorFromThreshold || scope.MultistateColor ? valueColor : (cfg.ValueColor || t.text)
            });
            if (!model.good) { valText.setAttribute('opacity', '0.6'); }

            var below = valueY + valueFont * 0.66;
            var subFont = PVX.util.clamp(valueFont * 0.32, 8, 15);

            if (cfg.ShowUnits && scope.pvx.units) {
                PVX.svg.text(svgRoot, cx.toFixed(2), below.toFixed(2), scope.pvx.units, {
                    'class': 'pvx-svg-label',
                    'text-anchor': 'middle',
                    'font-size': subFont.toFixed(1),
                    fill: t.textMuted
                });
                below += subFont * 1.25;
            }

            if (cfg.ShowStateLabel && activeBand && activeBand.label) {
                PVX.svg.text(svgRoot, cx.toFixed(2), below.toFixed(2), activeBand.label, {
                    'class': 'pvx-svg-label',
                    'text-anchor': 'middle',
                    'font-size': subFont.toFixed(1),
                    'font-weight': '600',
                    fill: activeBand.color
                });
            }
        }

        /**
         * Bounding box of a unit-radius arc sweep, in units of r.
         * Lets the gauge fill its frame instead of reserving space for the part
         * of the circle the sweep never reaches.
         */
        function arcBoundingBox(startDeg, endDeg) {
            var xs = [0], ys = [0];  // include the centre — needle/annulus meet there
            var push = function (deg) {
                var p = PVX.svg.polar(0, 0, 1, deg);
                xs.push(p.x); ys.push(p.y);
            };
            push(startDeg); push(endDeg);
            // Include any cardinal direction the sweep crosses.
            for (var a = Math.ceil(startDeg / 90) * 90; a <= endDeg; a += 90) { push(a); }
            var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs);
            var y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
            return { x0: x0, y0: y0, w: Math.max(0.2, x1 - x0), h: Math.max(0.2, y1 - y0) };
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
