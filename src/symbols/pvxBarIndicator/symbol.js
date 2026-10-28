/* ============================================================================
 * pvxBarIndicator — linear level / progress indicator for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Gauge (single data source)
 *
 * Tank levels, motor load, % capacity — anything that reads as "how full is it".
 *
 * Features
 *   - Horizontal or vertical, solid / gradient / segmented fill
 *   - Threshold bands painted behind the fill, driven by the shared PVX spec
 *   - Optional scale with ticks + labels on either side of the bar
 *   - Optional target/setpoint marker
 *   - Value text inside the fill (auto-contrast) or past the end of the bar
 *   - Auto light/dark theming, typography scaled to the available cross-axis
 *   - Options: a thermometer (a bulb at the minimum end), dim the bands the
 *     value is not in, major ticks on the band limits, minor ticks, and a
 *     scale that runs the other way (maximum at the left or bottom)
 *
 * Orientation note: the render path is written once in an orientation-neutral
 * (u, v) space — u runs along the bar from min to max, v runs across it — and
 * projected to screen coordinates by px()/rectAt(). Vertical simply swaps the
 * axes and flips u so that "more" is up. Nothing else in the render branches on
 * orientation beyond text anchoring, which genuinely differs.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    // Absolute (not proportional) presentation caps. Both exist because the
    // bar's thickness is a poor proxy for how big its decoration should be: a
    // tall symbol makes a thick bar, and scaling corners or type off that
    // thickness produces a lozenge with a billboard number on it.
    var MAX_CORNER_R = 4;        // px — softened corners, never pill-shaped
    var VALUE_FONT_MIN = 9;      // px — below this the readout is unreadable
    var VALUE_FONT_MAX = 22;     // px — above this it stops reading as a label

    var definition = {
        typeName: 'pvxBarIndicator',
        displayName: 'PVX Bar Indicator',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format Bar Indicator',
        StateVariables: ['MultistateColor'],

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Gauge',
                Height: 90,
                Width: 320,

                // Layout
                Orientation: 'horizontal',   // horizontal | vertical

                // Scale
                MinValue: 0,
                MaxValue: 100,
                UseSymbolScale: true,        // false => trust PI Vision's Indicator

                // Bar
                BarStyle: 'solid',           // solid | gradient | segmented | thermometer
                SegmentCount: 20,
                BarThicknessPct: 30,         // % of the cross axis the bar occupies
                RoundedBar: true,
                ShowTrack: true,

                // Threshold bands
                ShowBands: true,
                BandOpacity: 0.25,

                // Scale decoration
                ShowScale: true,
                TickCount: 5,
                ScalePosition: 'end',        // start = above/left, end = below/right
                ShowMinMaxLabels: true,

                // Target marker
                MinorTicks: 0,               // per major interval
                TicksAtBands: false,         // major ticks and labels on the band limits
                HighlightActiveBand: false,  // dim every band but the value's
                InvertScale: false,          // maximum at the left / bottom

                ShowTarget: false,
                TargetValue: 75,
                TargetColor: '#1d2126',

                // Readout
                ShowValueText: true,
                ValuePosition: 'inside',     // inside | end | none
                ValueColorFromThreshold: true,
                ShowLabel: true,
                ShowUnits: true,
                ShowTime: false
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;
        var U = PVX.util;

        // scope fields consumed by the template
        scope.pvx = {
            label: '',
            units: '',
            time: '',
            error: ''
        };

        var model = {
            value: null,
            raw: null,
            indicator: null,
            scaleLabels: null,
            good: true
        };

        // SVG def ids are minted once per symbol instance, not per frame: several
        // bar indicators can share one display and url(#id) references are global.
        var gradId = U.uid('pvxbar-grad');
        var clipId = U.uid('pvxbar-clip');

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-bar-body',

            onData: function (d) {
                var s = PVX.data.single(d);
                if (!s) { return; }
                model.value = s.value;
                model.raw = s.raw;
                model.indicator = s.indicator;
                model.scaleLabels = s.scaleLabels;
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

        /* ---------------------------------------------------------------- *
         * scale helpers
         * ---------------------------------------------------------------- */

        function scaleBounds(cfg) {
            if (!cfg.UseSymbolScale) {
                // PI Vision's Indicator is a 0-100 percentage of the scale it
                // derived from the attribute. When it also sends scale labels we
                // can show real engineering units on the ticks; otherwise the
                // axis is simply a percentage.
                var sl = model.scaleLabels;
                if (sl && sl.length >= 2) {
                    var lo = U.num(sl[0]);
                    var hi = U.num(sl[sl.length - 1]);
                    if (lo !== null && hi !== null && hi > lo) { return [lo, hi]; }
                }
                return [0, 100];
            }
            var min = U.num(cfg.MinValue);
            var max = U.num(cfg.MaxValue);
            if (min === null) { min = 0; }
            if (max === null || max <= min) { max = min + 100; }
            return [min, max];
        }

        /** Fraction 0..1 of the bar that is filled, or null when there is no data. */
        function fraction(cfg, bounds) {
            if (!cfg.UseSymbolScale && U.isNum(model.indicator)) {
                return U.clamp(model.indicator / 100, 0, 1);
            }
            if (model.value === null) { return null; }
            return U.clamp((model.value - bounds[0]) / ((bounds[1] - bounds[0]) || 1), 0, 1);
        }

        /** Rough text width. Avoids a getBBox() reflow on every frame. */
        function textWidth(str, font) {
            return String(str === null || str === undefined ? '' : str).length * font * 0.6;
        }

        /* ---------------------------------------------------------------- *
         * render
         * ---------------------------------------------------------------- */
        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            var W = Math.max(16, c.width);
            var H = Math.max(16, c.height);

            var svgRoot = host.querySelector('svg.pvx-bar-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-bar-svg' }, host);
            }
            // The viewBox is 1:1 with the host box, so 'none' just avoids the
            // browser letterboxing us when the box has fractional dimensions.
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var isVert = cfg.Orientation === 'vertical';
            var bounds = scaleBounds(cfg);
            var min = bounds[0], max = bounds[1];
            var span = (max - min) || 1;
            var frac = fraction(cfg, bounds);

            /* -- cross-axis budget ---------------------------------------- *
             * Everything typographic is sized from the cross axis (height for a
             * horizontal bar, width for a vertical one) because that is the
             * direction the scale has to squeeze into. This is what keeps the
             * symbol readable at 60px and not comically oversized at 800px. */
            var padC = 2;
            var C = Math.max(6, (isVert ? W : H) - padC * 2);
            var alongTotal = Math.max(12, isVert ? H : W);

            var tickFont = U.clamp(C * 0.16, 7, 20);

            // --- tick values ------------------------------------------------
            // Ticks always anchor the ends of the scale; ShowMinMaxLabels only
            // decides whether those two ends get a *label*.
            var showScale = !!cfg.ShowScale;
            var showEnds = !!cfg.ShowMinMaxLabels;
            var tickVals = [];
            var minorVals = [];
            var bandList = cfg.UseThresholds ? PVX.thresholds.bands(cfg.Thresholds, min, max) : [];
            if (showScale && (cfg.TicksAtBands || U.num(cfg.MinorTicks) > 0)) {
                var edges = [];
                if (cfg.TicksAtBands) {
                    for (var be = 0; be < bandList.length; be++) { edges.push(bandList[be].from); }
                }
                var gt = PVX.scale.gaugeTicks(min, max, U.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12),
                    { bandEdges: edges, minorPer: cfg.MinorTicks });
                tickVals = gt.major.map(function (m) { return m.v; });
                minorVals = gt.minor;
            } else if (showScale) {
                tickVals = PVX.scale.ticks(min, max, U.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12));
                tickVals = tickVals.filter(function (v) { return v > min + span * 1e-6 && v < max - span * 1e-6; });
                tickVals.unshift(min);
                tickVals.push(max);
            } else if (showEnds) {
                tickVals = [min, max];
            }

            // Label text per tick, empty where the label is suppressed.
            var items = [];
            for (var ti = 0; ti < tickVals.length; ti++) {
                var isEnd = (ti === 0 || ti === tickVals.length - 1);
                var txt = (isEnd && !showEnds) ? '' : PVX.fmt.tick(tickVals[ti]);
                items.push({ v: tickVals[ti], text: txt });
            }

            var maxLabelW = 0, anyLabel = false;
            for (var li = 0; li < items.length; li++) {
                if (!items[li].text) { continue; }
                anyLabel = true;
                maxLabelW = Math.max(maxLabelW, textWidth(items[li].text, tickFont));
            }

            // --- how much cross axis the scale needs ------------------------
            var tickLen = showScale ? U.clamp(C * 0.05, 2, 7) : 0;
            var labelGap = isVert ? 3 : 2;
            var scaleSpace = 0;
            if (items.length) {
                scaleSpace = tickLen + (anyLabel ? labelGap + (isVert ? maxLabelW : tickFont * 1.05) : 0);
            }
            // On a very small symbol the scale would eat the bar; drop it instead.
            if (scaleSpace > C - 5) {
                scaleSpace = 0;
                items = [];
                anyLabel = false;
            }

            var pct = U.clamp(U.num(cfg.BarThicknessPct) || 30, 5, 100);
            var barThick = U.clamp(C * pct / 100, 3, Math.max(3, C - scaleSpace));

            // Centre the bar+scale block on the cross axis so the symbol does not
            // look bottom-heavy when the scale is hidden.
            var slack = Math.max(0, C - (barThick + scaleSpace));
            var scaleAtStart = cfg.ScalePosition === 'start';
            var barV0 = padC + slack / 2 + (scaleAtStart ? scaleSpace : 0);
            var barV1 = barV0 + barThick;
            var barMidV = (barV0 + barV1) / 2;

            /* -- readout string + along-axis budget ------------------------ */
            var showValue = cfg.ShowValueText !== false && cfg.ValuePosition !== 'none';
            var display = model.value === null
                ? '--'
                : PVX.fmt.number(model.raw, PVX.config.numberOpts(cfg));
            if (cfg.ShowUnits && scope.pvx.units && model.value !== null) {
                display += ' ' + scope.pvx.units;
            }

            // The readout is a label *on* the bar, not the headline number, so it
            // is capped absolutely: on a tall symbol a thickness-proportional
            // font grows to 40px+ and becomes the only thing you see.
            var valueFont = U.clamp(barThick * 0.5, VALUE_FONT_MIN, VALUE_FONT_MAX);
            if (isVert) {
                // A vertical bar reads its value *across* the bar, so the bar width
                // — not its length — is the binding constraint. Sizing the text to
                // the bar (rather than to the whole symbol) also keeps it clear of
                // the scale labels running down the side.
                valueFont = U.clamp(
                    Math.min(valueFont, barThick * 0.95 / Math.max(1, display.length * 0.6)),
                    VALUE_FONT_MIN, VALUE_FONT_MAX
                );
            }
            var valueW = textWidth(display, valueFont);
            var valueGap = Math.max(3, barThick * 0.14);

            // Label overhang: tick labels are centred on their tick, so half of the
            // widest one hangs past each end of the bar (vertical labels overhang by
            // half a line instead).
            var labelPad = anyLabel ? (isVert ? tickFont * 0.7 : maxLabelW / 2) : 0;
            var padS = Math.max(2, labelPad);
            var padE = Math.max(2, labelPad);

            // Is the readout going to land outside the bar? On a horizontal bar
            // that depends on the fill length, so it cannot be budgeted for
            // without the bar twitching shorter as the value rises. On a vertical
            // bar the readout runs *across* the bar, so the test is a function of
            // the string and the thickness alone — stable enough to reserve for.
            var valueOutside = showValue &&
                (cfg.ValuePosition === 'end' || (isVert && valueW > barThick * 0.95));
            if (valueOutside) {
                if (isVert) {
                    // Vertical captions the readout above the bar while the end
                    // tick label sits beside the bar's top, so the two reservations
                    // stack instead of overlapping.
                    padE = labelPad + valueFont * 1.4 + 2;
                } else {
                    // Horizontal keeps the readout on the bar's own cross row and
                    // the end label down on the scale row, so the larger wins.
                    padE = Math.max(padE, valueW + valueGap + 2);
                }
            }
            // Never let the reservations eat the bar itself: an absurdly long unit
            // string should overflow (the root clips it) rather than erase the bar.
            padS = Math.min(padS, alongTotal * 0.3);
            padE = Math.min(padE, alongTotal * 0.4);
            // A thermometer's bulb sits past the minimum end: as wide as the
            // cross axis allows, a little wider than the tube.
            var invert = !!cfg.InvertScale;
            var thermo = cfg.BarStyle === 'thermometer';
            var crossAll = isVert ? W : H;
            // It stops at the tick marks, so the label at the minimum end
            // stays clear of it.
            var bulbR = thermo ? Math.max(2, Math.min(barThick * 0.85, barThick / 2 + Math.max(tickLen, 2),
                barMidV - 1, crossAll - barMidV - 1)) : 0;
            if (thermo) {
                var need = bulbR * 1.85;
                if (invert) { padE = Math.max(padE, need); } else { padS = Math.max(padS, need); }
            }
            var L = Math.max(4, alongTotal - padS - padE);

            /* -- (u,v) -> screen ------------------------------------------- *
             * u = 0 at the min end of the bar, v = 0 at the top (horizontal) or
             * left (vertical) edge of the drawing area. */
            var oA = isVert ? (H - padS) : padS;
            var oC = 0;

            var px = function (u, v) {
                return isVert
                    ? { x: oC + v, y: oA - u }
                    : { x: oA + u, y: oC + v };
            };
            var rectAt = function (u, v, du, dv) {
                return isVert
                    ? { x: oC + v, y: oA - (u + du), width: dv, height: du }
                    : { x: oA + u, y: oC + v, width: du, height: dv };
            };
            var addRect = function (u, v, du, dv, attrs) {
                var r = rectAt(u, v, du, dv);
                var a = attrs || {};
                a.x = r.x.toFixed(2); a.y = r.y.toFixed(2);
                a.width = Math.max(0, r.width).toFixed(2);
                a.height = Math.max(0, r.height).toFixed(2);
                return PVX.svg.el('rect', a, svgRoot);
            };
            // With InvertScale the maximum is at u = 0 and the fill grows
            // from the far end; fillU0 is where it starts.
            var uFor = function (v) {
                var f = U.clamp((v - min) / span, 0, 1);
                return (invert ? 1 - f : f) * L;
            };

            /* -- colours ---------------------------------------------------- */
            var activeBand = cfg.UseThresholds ? PVX.thresholds.evaluate(cfg.Thresholds, model.value) : null;
            var fillColor;
            if (scope.MultistateColor) {
                fillColor = scope.MultistateColor;                 // PI Vision multistate wins
            } else if (cfg.ValueColorFromThreshold && activeBand) {
                fillColor = activeBand.color;
            } else {
                fillColor = cfg.AccentColor || '#3b82c4';
            }
            if (!model.good) { fillColor = PVX.color.status.stale; }

            var rounded = cfg.RoundedBar !== false;
            // Softened corners, not a lozenge. A radius of half the thickness
            // turns the bar into a pill whose semicircular ends swamp the fill
            // at any real size, and it makes the ends of the scale ambiguous —
            // so the radius is a small absolute value, independent of thickness.
            var trackR = rounded ? Math.min(MAX_CORNER_R, barThick / 2) : 0;

            /* -- defs: track clip + gradient -------------------------------- */
            var defs = PVX.svg.el('defs', null, svgRoot);
            var trackRect = rectAt(0, barV0, L, barThick);

            var clip = PVX.svg.el('clipPath', { id: clipId }, defs);
            PVX.svg.el('rect', {
                x: trackRect.x.toFixed(2), y: trackRect.y.toFixed(2),
                width: trackRect.width.toFixed(2), height: trackRect.height.toFixed(2),
                rx: trackR.toFixed(2), ry: trackR.toFixed(2)
            }, clip);

            var style = cfg.BarStyle || 'solid';
            if (style === 'thermometer') { style = 'solid'; }
            var fillPaint = fillColor;
            if (style === 'gradient' && model.good) {
                // userSpaceOnUse across the *whole* track, not the fill: the ramp
                // then stays put as the value moves instead of re-scaling itself.
                var g0 = px(invert ? L : 0, barMidV), g1 = px(invert ? 0 : L, barMidV);
                var grad = PVX.svg.el('linearGradient', {
                    id: gradId,
                    gradientUnits: 'userSpaceOnUse',
                    x1: g0.x.toFixed(2), y1: g0.y.toFixed(2),
                    x2: g1.x.toFixed(2), y2: g1.y.toFixed(2)
                }, defs);
                // Lighten less on dark themes — a near-white stop glares there.
                var lightT = t.dark ? 0.28 : 0.42;
                PVX.svg.el('stop', {
                    offset: '0%',
                    'stop-color': PVX.color.mix(cfg.AccentColor || fillColor, '#ffffff', lightT)
                }, grad);
                PVX.svg.el('stop', { offset: '100%', 'stop-color': fillColor }, grad);
                fillPaint = 'url(#' + gradId + ')';
            }

            /* -- track ------------------------------------------------------ */
            var segmented = style === 'segmented';
            if (cfg.ShowTrack !== false && !segmented) {
                addRect(0, barV0, L, barThick, {
                    fill: t.track, rx: trackR.toFixed(2), ry: trackR.toFixed(2),
                    'class': 'pvx-bar-track'
                });
            }

            /* -- threshold bands -------------------------------------------- *
             * Drawn behind the fill and clipped to the track so square band ends
             * cannot poke out of a rounded track. theme.track is translucent, so
             * on a segmented bar the bands show through the unlit cells. */
            if (cfg.ShowBands && cfg.UseThresholds) {
                var bandOp = U.num(cfg.BandOpacity);
                if (bandOp === null) { bandOp = 0.25; }
                var bands = bandList;
                var bandG = PVX.svg.el('g', { 'clip-path': 'url(#' + clipId + ')' }, svgRoot);
                for (var bi = 0; bi < bands.length; bi++) {
                    var bu0 = Math.min(uFor(bands[bi].from), uFor(bands[bi].to));
                    var bu1 = Math.max(uFor(bands[bi].from), uFor(bands[bi].to));
                    if (bu1 - bu0 < 0.3) { continue; }
                    var br = rectAt(bu0, barV0, bu1 - bu0, barThick);
                    var isActive = activeBand && model.value !== null && model.value >= bands[bi].from &&
                        (model.value < bands[bi].to || bands[bi].to === max);
                    var op = !cfg.HighlightActiveBand ? bandOp :
                        isActive ? Math.min(1, Math.max(bandOp * 2.2, 0.6)) : bandOp * 0.4;
                    PVX.svg.el('rect', {
                        x: br.x.toFixed(2), y: br.y.toFixed(2),
                        width: br.width.toFixed(2), height: br.height.toFixed(2),
                        fill: PVX.color.rgba(bands[bi].color, op),
                        'class': 'pvx-bar-band' + (cfg.HighlightActiveBand && isActive ? ' pvx-bar-band-active' : '')
                    }, bandG);
                }
            }

            /* -- fill -------------------------------------------------------- */
            var fillLen = frac === null ? 0 : frac * L;
            var fillU0 = invert ? L - fillLen : 0;

            if (thermo) {
                // The bulb is always full: it is the reservoir, and an empty
                // bulb would read as no data rather than a low value.
                var bc = px(invert ? L + bulbR * 0.75 : -bulbR * 0.75, barMidV);
                PVX.svg.el('circle', {
                    cx: bc.x.toFixed(2), cy: bc.y.toFixed(2), r: bulbR.toFixed(2),
                    fill: frac === null ? t.track : fillColor, 'class': 'pvx-bar-bulb'
                }, svgRoot);
            }

            if (segmented) {
                var n = U.clamp(parseInt(cfg.SegmentCount, 10) || 20, 2, 200);
                // A cell thinner than ~1.5px is a smudge, and 200 of them on a
                // 120px bar would run off the end entirely: drop segments until the
                // ones that remain are actually readable.
                n = Math.max(2, Math.min(n, Math.floor(L / 1.5)));
                // Gap scales with the cell (never more than half of it) so the bar
                // does not turn into a comb at high segment counts.
                var gap = Math.min(U.clamp((L / n) * 0.22, 0.5, 4), (L / n) * 0.5);
                var cell = (L - gap * (n - 1)) / n;
                var cellR = rounded ? Math.min(Math.min(cell, barThick) * 0.22, trackR) : 0;
                var litExact = frac === null ? 0 : frac * n;
                for (var si = 0; si < n; si++) {
                    var u0 = si * (cell + gap);
                    var lit = litExact - (invert ? n - 1 - si : si);   // >=1 full, 0..1 partial
                    if (lit >= 1) {
                        addRect(u0, barV0, cell, barThick, {
                            fill: fillPaint, rx: cellR.toFixed(2), ry: cellR.toFixed(2),
                            'class': 'pvx-bar-cell'
                        });
                    } else if (lit > 0.02) {
                        // Fade the boundary cell rather than drawing a part-width
                        // rect — a sliver of colour reads as a rendering artefact.
                        addRect(u0, barV0, cell, barThick, {
                            fill: fillPaint, opacity: (0.2 + 0.8 * lit).toFixed(2),
                            rx: cellR.toFixed(2), ry: cellR.toFixed(2),
                            'class': 'pvx-bar-cell'
                        });
                    } else if (cfg.ShowTrack !== false) {
                        addRect(u0, barV0, cell, barThick, {
                            fill: t.track, rx: cellR.toFixed(2), ry: cellR.toFixed(2),
                            'class': 'pvx-bar-cell pvx-bar-cell-off'
                        });
                    }
                }
            } else if (fillLen > 0.5) {
                addRect(fillU0, barV0, fillLen, barThick, {
                    fill: fillPaint,
                    rx: Math.min(trackR, fillLen / 2).toFixed(2),
                    ry: trackR.toFixed(2),
                    'class': 'pvx-bar-fill pvx-animate'
                });
            }

            /* -- ticks + labels ---------------------------------------------- */
            if (items.length) {
                var tickV0 = scaleAtStart ? barV0 : barV1;
                var tickV1 = scaleAtStart ? barV0 - tickLen : barV1 + tickLen;
                var labelV = scaleAtStart
                    ? tickV1 - labelGap - (isVert ? 0 : tickFont * 0.55)
                    : tickV1 + labelGap + (isVert ? 0 : tickFont * 0.55);
                var anchor = isVert ? (scaleAtStart ? 'end' : 'start') : 'middle';

                for (var mk = 0; showScale && mk < minorVals.length; mk++) {
                    var mu = uFor(minorVals[mk]);
                    var mt2 = scaleAtStart ? barV0 - tickLen * 0.55 : barV1 + tickLen * 0.55;
                    var b1 = px(mu, tickV0), b2 = px(mu, mt2);
                    PVX.svg.el('line', {
                        x1: b1.x.toFixed(2), y1: b1.y.toFixed(2), x2: b2.x.toFixed(2), y2: b2.y.toFixed(2),
                        stroke: t.axis, 'stroke-width': 0.75, opacity: 0.7, 'class': 'pvx-grid-line pvx-bar-minor'
                    }, svgRoot);
                }
                for (var k = 0; k < items.length; k++) {
                    if (!showScale) { break; }
                    var tu = uFor(items[k].v);
                    var a1 = px(tu, tickV0), a2 = px(tu, tickV1);
                    PVX.svg.el('line', {
                        x1: a1.x.toFixed(2), y1: a1.y.toFixed(2),
                        x2: a2.x.toFixed(2), y2: a2.y.toFixed(2),
                        stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
                    }, svgRoot);
                }

                // thinLabels walks along the bar, so an inverted scale's
                // items go in reversed.
                var drawn = thinLabels(invert ? items.slice().reverse() : items, tickFont, isVert, L, uFor);
                for (var m = 0; m < drawn.length; m++) {
                    var lp = px(uFor(drawn[m].v), labelV);
                    PVX.svg.text(svgRoot, lp.x.toFixed(2), lp.y.toFixed(2), drawn[m].text, {
                        'class': 'pvx-svg-label',
                        'text-anchor': anchor,
                        'font-size': tickFont.toFixed(1),
                        fill: t.textMuted
                    });
                }
            }

            /* -- target marker ------------------------------------------------ */
            var target = U.num(cfg.TargetValue);
            if (cfg.ShowTarget && target !== null && target >= min && target <= max) {
                var tu2 = uFor(target);
                // The marker overhangs both edges of the bar, but only as far as the
                // drawing area allows — a thick bar in a short symbol has no room.
                var crossTotal = isVert ? W : H;
                var over = Math.max(2, Math.min(barThick * 0.22, barV0, crossTotal - barV1));
                var mv0 = barV0 - over, mv1 = barV1 + over;
                var p1 = px(tu2, mv0), p2 = px(tu2, mv1);
                var tColor = cfg.TargetColor || t.text;
                PVX.svg.el('line', {
                    x1: p1.x.toFixed(2), y1: p1.y.toFixed(2),
                    x2: p2.x.toFixed(2), y2: p2.y.toFixed(2),
                    stroke: tColor,
                    'stroke-width': Math.max(1.5, barThick * 0.07).toFixed(2),
                    'stroke-linecap': 'butt',
                    'class': 'pvx-bar-target'
                }, svgRoot);
                // Small notch on the scale-free side so the marker is findable even
                // when the line sits on top of a same-coloured band.
                var nw = Math.max(2.5, barThick * 0.2);
                var n1 = px(tu2 - nw, mv0), n2 = px(tu2 + nw, mv0), n3 = px(tu2, barV0);
                PVX.svg.el('path', {
                    d: 'M' + n1.x.toFixed(2) + ' ' + n1.y.toFixed(2) +
                       ' L' + n2.x.toFixed(2) + ' ' + n2.y.toFixed(2) +
                       ' L' + n3.x.toFixed(2) + ' ' + n3.y.toFixed(2) + ' Z',
                    fill: tColor, 'class': 'pvx-bar-target'
                }, svgRoot);
            }

            /* -- value text ---------------------------------------------------- */
            if (showValue) {
                // Text footprint expressed on the (u, v) axes so the fit test does
                // not have to know which way round the bar is.
                var alongExtent = isVert ? valueFont * 1.25 : valueW;
                var crossExtent = isVert ? valueW : valueFont * 1.1;
                var wantInside = cfg.ValuePosition === 'inside';
                var fitsInside = wantInside &&
                    fillLen >= alongExtent + valueGap * 2 &&
                    crossExtent <= barThick * 0.95;

                if (fitsInside) {
                    var iu = isVert
                        ? fillLen - valueGap - valueFont * 0.6
                        : fillLen - valueGap;
                    // Inverted, the fill's free end is at its start.
                    if (invert) { iu = isVert ? fillU0 + valueGap + valueFont * 0.6 : fillU0 + valueGap; }

                    var ip = px(iu, barMidV);

                    // A segmented bar is a comb, and the gaps between lit cells
                    // punch the symbol background straight through the readout.
                    // A stroked copy of the text underneath haloes each glyph in
                    // the fill colour, which restores contrast without painting
                    // over the segments the way a solid backing plate would.
                    if (segmented) {
                        PVX.svg.text(svgRoot, ip.x.toFixed(2), ip.y.toFixed(2), display, {
                            'class': 'pvx-svg-value pvx-num pvx-bar-value-halo',
                            'text-anchor': isVert ? 'middle' : (invert ? 'start' : 'end'),
                            'font-size': valueFont.toFixed(1),
                            fill: 'none',
                            stroke: fillColor,
                            'stroke-width': Math.max(2, valueFont * 0.3).toFixed(2),
                            'stroke-linejoin': 'round',
                            opacity: model.good ? null : '0.75'
                        });
                    }

                    PVX.svg.text(svgRoot, ip.x.toFixed(2), ip.y.toFixed(2), display, {
                        'class': 'pvx-svg-value pvx-num',
                        'text-anchor': isVert ? 'middle' : (invert ? 'start' : 'end'),
                        'font-size': valueFont.toFixed(1),
                        // Contrast against the fill, which may be any threshold colour.
                        fill: PVX.color.readable(fillColor),
                        opacity: model.good ? null : '0.75'
                    });
                } else {
                    // 'end', or an 'inside' request the fill is too short to honour:
                    // park the text just past whatever the bar actually drew.
                    var eu = wantInside && !invert ? fillLen + valueGap : L + valueGap;
                    if (isVert) {
                        // A vertical readout that will not fit across the bar is
                        // captioned above the bar, not above the fill — anchoring it
                        // to the fill would slide it onto the end tick label, which
                        // shares the bar's top along-axis position. The clearance is
                        // half of each type size so the two rows never touch.
                        eu = L + valueGap + (valueFont + (anyLabel ? tickFont : 0)) * 0.6;
                        eu = Math.min(eu, alongTotal - padS - valueFont * 0.7);
                    } else if (eu + valueW > alongTotal - padS) {
                        eu = Math.max(0, alongTotal - padS - valueW);
                    }
                    // Outside the bar the text is no longer bounded by the bar's
                    // thickness, so keep it inside the symbol on the cross axis too.
                    var ev = barMidV;
                    if (isVert) {
                        var lo = valueW / 2 + 1, hi = W - valueW / 2 - 1;
                        ev = hi > lo ? U.clamp(barMidV, lo, hi) : W / 2;
                    }
                    var ep = px(eu, ev);
                    PVX.svg.text(svgRoot, ep.x.toFixed(2), ep.y.toFixed(2), display, {
                        'class': 'pvx-svg-value pvx-num',
                        'text-anchor': isVert ? 'middle' : 'start',
                        'font-size': valueFont.toFixed(1),
                        fill: t.text,
                        opacity: model.good ? null : '0.7'
                    });
                }
            }
        }

        /**
         * Drop tick labels that would collide with their neighbour, keeping the
         * ends of the scale — a crowded axis is worse than a sparse one.
         */
        function thinLabels(items, font, isVert, L, uFor) {
            var live = [];
            for (var i = 0; i < items.length; i++) {
                if (items[i].text) { live.push(items[i]); }
            }
            if (live.length < 2) { return live; }

            var extent = function (it) {
                return isVert ? font * 1.3 : textWidth(it.text, font);
            };
            var gap = font * 0.5;

            var kept = [];
            var lastEnd = -1e9;
            for (var j = 0; j < live.length; j++) {
                var half = extent(live[j]) / 2;
                var start = uFor(live[j].v) - half;
                if (start >= lastEnd + gap) {
                    kept.push(live[j]);
                    lastEnd = uFor(live[j].v) + half;
                }
            }

            // The max label is the one users actually look for; if the greedy pass
            // starved it, evict whatever is in its way.
            var last = live[live.length - 1];
            if (kept.length && kept[kept.length - 1] !== last) {
                var lStart = uFor(last.v) - extent(last) / 2 - gap;
                while (kept.length && uFor(kept[kept.length - 1].v) + extent(kept[kept.length - 1]) / 2 > lStart) {
                    kept.pop();
                }
                kept.push(last);
            }
            return kept;
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
