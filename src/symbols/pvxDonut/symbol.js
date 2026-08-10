/* ============================================================================
 * pvxDonut — "PVX Contribution" — part-to-whole donut for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 *
 * The question this symbol answers is "how is my total split between these
 * sources" — one number per source, expressed as a share of their sum, with the
 * sum itself in the hole.
 *
 * A HONEST CAVEAT, stated here and in the config pane
 *   For *comparing magnitudes*, a ranked bar wins over a donut in essentially
 *   every controlled study: people judge length far more accurately than angle
 *   or arc area. pvxPareto is the better symbol for "which asset is worst".
 *   This symbol exists because part-to-whole is a genuinely different question,
 *   and because when management asks for a pie the alternative is a screenshot
 *   pasted into Excel — which nobody maintains and nobody can trust.
 *
 * Design decisions that follow from that
 *   - The hole is on by default. It removes the "compare wedges by area"
 *     illusion and gives the total somewhere to live.
 *   - Negative values are not silently dropped. A share of a total is undefined
 *     for a negative part, so those rows are excluded AND NAMED in the footer.
 *     A display that quietly omits a tag is a display that lies.
 *   - Slice labels are measured with getComputedTextLength, not estimated from
 *     glyph counts. Estimation has been a real source of overflow bugs here.
 *
 * COLUMN SYNC
 *   PI Vision returns Summary cells positionally, matching config.Columns, so
 *   the chosen statistic must drive that array. All of that lives in the shared
 *   helpers (PVX.config.statColumns / syncStatColumns / PVX.data.statValue);
 *   this symbol never hand-rolls column handling. syncStatColumns runs on every
 *   config change AND at the top of render, so a display saved by an older
 *   build repairs itself on load instead of charting a stale aggregate.
 *
 * RENDERING
 *   Everything inside the body is SVG drawn into `.pvx-donut-body`; only the
 *   header/footer chrome is Angular-bound. buildModel() is pure: rows + config
 *   in, slices + notes out, so the drawing code never makes data decisions.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxDonut',
        displayName: 'PVX Contribution',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // A collection would repeat the whole split per asset, which defeats the
        // purpose: the split IS the comparison across the assets.
        supportsCollections: false,
        configTitle: 'Format Contribution',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                // Positional contract with PI Vision's Summary cells. Kept in
                // agreement with Statistic by PVX.config.syncStatColumns().
                Columns: ['Value'],
                SortColumn: 'Value',
                SortDescending: true,
                Height: 260,
                Width: 380,

                Title: '',

                // --- what is charted ---------------------------------
                Statistic: 'Value',        // Value|Average|Minimum|Maximum|Range|StdDev|Total

                // --- ring geometry -----------------------------------
                // 0 makes it a pie. The default is a donut because the hole is
                // where the total goes, and because it kills the "compare the
                // wedges by area" illusion.
                InnerRadiusPct: 58,
                StartAngle: 0,             // degrees, 0 = 12 o'clock
                Clockwise: true,
                PadAngle: 0.6,             // degrees of gap between slices

                // --- which slices exist ------------------------------
                SortMode: 'valueDesc',     // valueDesc | valueAsc | name | none
                GroupSmallBelow: 3,        // percent; below this rolls into "Other"
                MaxSlices: 10,
                OtherLabel: 'Other',
                OtherColor: '#8a8f96',

                // --- colour ------------------------------------------
                ColorMode: 'palette',      // palette | threshold | single
                SingleColor: '#3b82c4',

                // --- centre readout ----------------------------------
                ShowCenter: true,
                CenterMode: 'total',       // total | count | largest | custom
                CenterLabel: '',
                CenterValue: '',

                // --- legend ------------------------------------------
                ShowLegend: true,
                LegendPosition: 'auto',    // auto | right | bottom | none
                LegendShowValue: true,
                LegendShowPercent: true,

                // --- slice labels ------------------------------------
                ShowSliceLabels: false,
                SliceLabelMode: 'percent', // percent | value | name | nameAndPercent
                ShowLeaderLines: true,
                MinSliceLabelPct: 5
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the ring itself is SVG.
        scope.pvx = {
            title: '',
            subtitle: '',
            note: '',
            count: '',
            error: '',
            background: ''
        };

        var rows = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-donut-body',

            onData: function (d) {
                var cfg = scope.config || {};
                // Parse against the columns we actually asked for. Immediately
                // after a statistic change the in-flight payload may still carry
                // the previous aggregate; it is replaced within one refresh, so
                // a one-frame stale number beats dropping every row.
                rows = PVX.data.rows(d, cfg.Columns || PVX.config.statColumns(cfg)) || [];
            },

            onConfigChange: function (newCfg) {
                // The statistic decides which aggregate PI Vision computes, so
                // the request must be corrected before the next fetch.
                PVX.config.syncStatColumns(newCfg || scope.config);
            },

            render: render
        });

        /* ================================================================ *
         * Pure model — no DOM, no drawing decisions
         * ================================================================ */

        function intOr(v, fallback) {
            var n = parseInt(v, 10);
            return isFinite(n) ? n : fallback;
        }

        function numOr(v, fallback) {
            var n = PVX.util.num(v);
            return n === null ? fallback : n;
        }

        function compareBy(mode) {
            // Index tiebreak keeps ordering deterministic: Array#sort is not
            // guaranteed stable on the older engines PI Vision still supports.
            switch (mode) {
                case 'valueAsc':
                    return function (a, b) { return (a.value - b.value) || (a.index - b.index); };
                case 'name':
                    return function (a, b) {
                        var la = String(a.label).toLowerCase(), lb = String(b.label).toLowerCase();
                        return la < lb ? -1 : (la > lb ? 1 : a.index - b.index);
                    };
                case 'none':
                    return function (a, b) { return a.index - b.index; };
                case 'valueDesc':
                default:
                    return function (a, b) { return (b.value - a.value) || (a.index - b.index); };
            }
        }

        /**
         * rows + config -> {slices, total, notes, ...}
         *
         * Every slice carries its own angles, so the drawing code only converts
         * degrees to paths. `empty` / `reason` describe why there is nothing to
         * draw, which is a different message for "no sources" than for "the
         * total is zero" — an empty ring would say neither.
         */
        function buildModel(cfg) {
            var i;
            var items = [];
            var skipped = 0;        // rows whose chosen statistic cell is empty
            var badCount = 0;
            var negatives = [];     // NAMED in the footer, never silently dropped

            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                var v = PVX.data.statValue(r, cfg);
                var name = r.label || ('Row ' + (i + 1));
                if (v === null) { skipped += 1; continue; }
                if (v < 0) {
                    // A share of a total is undefined for a negative part: it
                    // would either shrink the total it belongs to or draw a
                    // wedge running backwards over its neighbour.
                    negatives.push(name);
                    continue;
                }
                if (!r.good) { badCount += 1; }
                items.push({
                    label: name,
                    path: r.path || '',
                    units: r.units || '',
                    good: r.good !== false,
                    error: r.errorDescription || '',
                    value: v,
                    index: i,
                    isOther: false,
                    members: 1
                });
            }

            var total = 0;
            for (i = 0; i < items.length; i++) { total += items[i].value; }

            if (!items.length || !(total > 0)) {
                return {
                    slices: [], total: 0, sources: rows.length,
                    skipped: skipped, badCount: badCount, negatives: negatives,
                    notes: negativeNote(negatives).concat(skippedNote(skipped, cfg)),
                    empty: true,
                    reason: !rows.length ? 'nodata'
                        : (negatives.length && !items.length ? 'allnegative'
                            : (items.length ? 'zerototal' : 'novalues'))
                };
            }

            // --- roll up the long tail --------------------------------------
            // Two independent caps, applied in this order: a percentage floor
            // (slices too thin to read) and a hard slice count (beyond which the
            // legend is longer than the chart is tall).
            var floorPct = PVX.util.clamp(numOr(cfg.GroupSmallBelow, 3), 0, 50);
            var maxSlices = PVX.util.clamp(intOr(cfg.MaxSlices, 10), 1, 40);

            var byValue = items.slice().sort(function (a, b) {
                return (b.value - a.value) || (a.index - b.index);
            });

            var keep = [], rest = [];
            for (i = 0; i < byValue.length; i++) {
                var pct = (byValue[i].value / total) * 100;
                if (pct < floorPct || keep.length >= maxSlices) { rest.push(byValue[i]); }
                else { keep.push(byValue[i]); }
            }

            // Everything below the floor means the floor is wrong for this data;
            // one 100% "Other" slice tells the operator nothing at all.
            if (!keep.length) {
                keep = byValue.slice(0, maxSlices);
                rest = byValue.slice(maxSlices);
            }
            // An "Other" made of exactly one source is just that source wearing
            // a worse name.
            if (rest.length === 1) { keep.push(rest[0]); rest = []; }

            var slices = keep.slice().sort(compareBy(cfg.SortMode));

            var otherCount = rest.length;
            if (otherCount) {
                var sum = 0, allGood = true;
                for (i = 0; i < rest.length; i++) {
                    sum += rest[i].value;
                    if (!rest[i].good) { allGood = false; }
                }
                slices.push({
                    label: (cfg.OtherLabel || 'Other') + ' (' + otherCount + ')',
                    path: '', units: '',
                    // Inherit bad quality: a total built from an untrusted value
                    // is itself untrusted, so it must render hatched.
                    good: allGood,
                    error: '',
                    value: sum,
                    index: 1e9,
                    isOther: true,
                    members: otherCount
                });
            }

            // --- angles ------------------------------------------------------
            var start = numOr(cfg.StartAngle, 0);
            var dir = cfg.Clockwise === false ? -1 : 1;
            var cum = 0;
            var minSweep = 360;
            for (i = 0; i < slices.length; i++) {
                var s = slices[i];
                s.pct = (s.value / total) * 100;
                s.a0 = start + dir * (cum / total) * 360;
                cum += s.value;
                s.a1 = start + dir * (cum / total) * 360;
                s.sweep = Math.abs(s.a1 - s.a0);
                s.mid = (s.a0 + s.a1) / 2;
                if (s.sweep < minSweep) { minSweep = s.sweep; }
            }

            // A single slice is a complete ring: a pad gap there is a seam in a
            // circle that has no joins, which reads as a missing sliver of data.
            var pad = slices.length > 1
                ? Math.min(PVX.util.clamp(numOr(cfg.PadAngle, 0.6), 0, 15), minSweep * 0.6)
                : 0;

            var notes = negativeNote(negatives).concat(skippedNote(skipped, cfg));
            if (otherCount) {
                notes.push((cfg.OtherLabel || 'Other') + ' = ' + otherCount + ' smaller sources combined');
            }

            return {
                slices: slices,
                total: total,
                pad: pad,
                sources: rows.length,
                otherCount: otherCount,
                skipped: skipped,
                badCount: badCount,
                negatives: negatives,
                notes: notes,
                empty: false
            };
        }

        /** Naming the excluded rows is the whole point — a count would not do. */
        function negativeNote(negatives) {
            if (!negatives.length) { return []; }
            var shown = negatives.slice(0, 3).join(', ');
            if (negatives.length > 3) { shown += ' +' + (negatives.length - 3) + ' more'; }
            return ['Negative, excluded: ' + shown];
        }

        function skippedNote(skipped, cfg) {
            if (!skipped) { return []; }
            return [skipped + (skipped === 1 ? ' source has no ' : ' sources have no ') +
                PVX.config.statLabel(cfg).toLowerCase()];
        }

        /* ================================================================ *
         * Text helpers
         * ================================================================ */

        /**
         * Approximate rendered width. Used only to pre-size layout boxes and to
         * pre-cut strings; anything that can overflow the frame is confirmed
         * afterwards with getComputedTextLength(). 0.58em is the average advance
         * of Segoe UI / Roboto at these sizes.
         */
        function textPx(s, fontPx) {
            return String(s === null || s === undefined ? '' : s).length * fontPx * 0.58;
        }

        function truncate(s, maxPx, fontPx) {
            var str = String(s === null || s === undefined ? '' : s);
            var per = fontPx * 0.58;
            var max = Math.floor(maxPx / per);
            if (max < 1) { return ''; }
            if (str.length <= max) { return str; }
            if (max === 1) { return '…'; }
            return str.slice(0, max - 1) + '…';
        }

        /**
         * Trim an already-drawn <text> until getComputedTextLength() reports it
         * fits `maxPx`, re-adding the ellipsis.
         *
         * The glyph-count estimate above runs narrow on mixed-case proper nouns
         * ("Cooling Tower Basin Temp" averages well over 0.58em), and both the
         * legend names and the outside slice labels are anchored against a frame
         * edge — an under-estimate there pushes the string off-canvas, where the
         * host's overflow:hidden chops glyphs instead of ellipsising. There is no
         * clamp that can rescue it after the fact: the text has to be short
         * enough. The caller passes text already cut by the estimate, so the
         * common case measures once and returns.
         */
        function fitTextTo(node, maxPx) {
            if (!node || !node.getComputedTextLength) { return; }
            if (!(maxPx > 0)) { node.textContent = ''; return; }
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            for (var guard = 0; guard < 8; guard++) {
                var w = measure();
                if (!(w > maxPx)) { return; }
                var cur = node.textContent || '';
                var core = cur.charAt(cur.length - 1) === '…' ? cur.slice(0, -1) : cur;
                if (core.length < 2) { node.textContent = ''; return; }
                // -1 leaves room for the ellipsis; the min() guarantees the
                // string shrinks every pass even when the ratio rounds up.
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return; }
                node.textContent = core.slice(0, keep) + '…';
            }
            if (measure() > maxPx) { node.textContent = ''; }
        }

        /** Measured width of a drawn <text>, 0 when the browser will not say. */
        function measured(node) {
            if (!node || !node.getComputedTextLength) { return 0; }
            try { return node.getComputedTextLength(); } catch (e) { return 0; }
        }

        function pctText(pct) {
            return PVX.fmt.percent(pct, pct >= 9.95 ? 0 : 1);
        }

        function valueText(v, cfg) {
            return PVX.fmt.number(v, PVX.config.numberOpts(cfg));
        }

        /* ================================================================ *
         * Colour
         * ================================================================ */

        function sliceColor(slice, idx, cfg, t) {
            if (slice.isOther) { return cfg.OtherColor || '#8a8f96'; }
            switch (cfg.ColorMode) {
                case 'threshold':
                    // Falls back to the flat colour when thresholds are off, so
                    // the mode never silently paints the whole ring one band.
                    return cfg.UseThresholds
                        ? PVX.thresholds.colorFor(cfg.Thresholds, slice.value, cfg.SingleColor || '#3b82c4')
                        : (cfg.SingleColor || '#3b82c4');
                case 'single':
                    return cfg.SingleColor || '#3b82c4';
                case 'palette':
                default:
                    return PVX.color.categorical[idx % PVX.color.categorical.length];
            }
        }

        /**
         * Hatched fill for bad quality. Operators must see at a glance that a
         * slice's size is not trustworthy, and a solid slice in a "stale" colour
         * still reads as a real measurement. One pattern per colour per render;
         * ids are unique so several symbol instances cannot collide.
         */
        function hatchFor(defs, cache, fill) {
            if (cache[fill]) { return cache[fill]; }
            var id = PVX.util.uid('pvxdhatch');
            var p = PVX.svg.el('pattern', {
                id: id,
                width: 6, height: 6,
                patternUnits: 'userSpaceOnUse',
                patternTransform: 'rotate(45)'
            }, defs);
            PVX.svg.el('rect', { x: 0, y: 0, width: 6, height: 6, fill: fill, 'fill-opacity': 0.22 }, p);
            PVX.svg.el('rect', { x: 0, y: 0, width: 3, height: 6, fill: fill, 'fill-opacity': 0.9 }, p);
            cache[fill] = 'url(#' + id + ')';
            return cache[fill];
        }

        /* ================================================================ *
         * Geometry
         * ================================================================ */

        /**
         * A complete ring — two concentric circles with opposite winding, read
         * with fill-rule evenodd so the hole stays a hole.
         *
         * PVX.svg.annulus() cannot express a 360-degree sweep (its start and end
         * points coincide, and the arc collapses), and clamping the sweep to
         * 359.99 like PVX.svg.arc() does would leave a visible seam on the one
         * case where there is genuinely no join: a single source at 100%.
         */
        function ringPath(cx, cy, rInner, rOuter) {
            var circle = function (r, sweepFlag) {
                if (!(r > 0)) { return ''; }
                return 'M' + (cx - r).toFixed(2) + ' ' + cy.toFixed(2) +
                    ' A' + r.toFixed(2) + ' ' + r.toFixed(2) + ' 0 1 ' + sweepFlag + ' ' + (cx + r).toFixed(2) + ' ' + cy.toFixed(2) +
                    ' A' + r.toFixed(2) + ' ' + r.toFixed(2) + ' 0 1 ' + sweepFlag + ' ' + (cx - r).toFixed(2) + ' ' + cy.toFixed(2) + ' Z';
            };
            return circle(rOuter, 1) + ' ' + circle(rInner, 0);
        }

        /**
         * One slice as a path. Angles may run either way (Clockwise), while
         * PVX.svg.annulus() always sweeps positively — the region is the same
         * either way, so the endpoints are simply ordered before being handed
         * over.
         */
        function slicePath(cx, cy, rInner, rOuter, a0, a1, pad) {
            var lo = Math.min(a0, a1) + pad / 2;
            var hi = Math.max(a0, a1) - pad / 2;
            if (hi - lo < 0.02) { return ''; }
            if (hi - lo >= 359.9) { return ringPath(cx, cy, rInner, rOuter); }
            return PVX.svg.annulus(cx, cy, rInner, rOuter, lo, hi);
        }

        /* ================================================================ *
         * Render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            // Self-heal a config saved before the statistic existed, or edited
            // by hand. Only writes when something actually differs, so this
            // cannot loop with PI Vision's own change detection.
            PVX.config.syncStatColumns(cfg);

            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            var W = Math.max(40, c.width);
            var H = Math.max(30, c.height);

            var svgRoot = host.querySelector('svg.pvx-donut-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-donut-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var model = buildModel(cfg);

            // Size tiers are decided from the symbol's OUTER box, never from the
            // SVG host: the host shrinks when the header and footer are shown,
            // so a tier that reacted to it would hide the chrome, grow the host,
            // qualify for the chrome again, and oscillate every frame.
            var outer = {
                w: (c.node && c.node.clientWidth) || W,
                h: (c.node && c.node.clientHeight) || H
            };
            var tier = {
                ringOnly: outer.w < 140 || outer.h < 100,
                cramped: outer.w < 200 || outer.h < 140
            };
            tier.cramped = tier.cramped || tier.ringOnly;

            // ---- chrome -----------------------------------------------------
            // At the smallest tier every pixel belongs to the ring; the error
            // badge survives because it costs 8px and reports untrustworthy data.
            scope.pvx.title = tier.ringOnly ? '' : (cfg.Title || 'Contribution');
            scope.pvx.subtitle = tier.ringOnly ? '' : (PVX.config.statLabel(cfg) + commonUnitsSuffix(cfg, model));
            scope.pvx.note = tier.ringOnly ? '' : model.notes.join(' · ');
            scope.pvx.count = (tier.ringOnly || tier.cramped || model.empty) ? '' : sourceCount(model);
            scope.pvx.error = model.badCount
                ? (model.badCount + (model.badCount === 1 ? ' source reports' : ' sources report') + ' bad quality')
                : '';

            if (model.empty) {
                emptyState(svgRoot, W, H, t, emptyMessage(model, cfg));
                digest();
                return;
            }

            drawDonut(svgRoot, W, H, cfg, t, model, tier);
            digest();
        }

        /** "6 of 16 sources" whenever slices stand for fewer rows than arrived. */
        function sourceCount(model) {
            var drawn = model.slices.length;
            var represented = model.sources - model.skipped - model.negatives.length;
            var head = (drawn < represented) ? (drawn + ' of ' + represented) : String(represented);
            return head + (represented === 1 ? ' source' : ' sources');
        }

        /** Units belong in the header only when every row agrees on them. */
        function commonUnitsSuffix(cfg, model) {
            if (!cfg.ShowUnits) { return ''; }
            var u = null;
            for (var i = 0; i < model.slices.length; i++) {
                if (model.slices[i].isOther) { continue; }
                var iu = model.slices[i].units || '';
                if (u === null) { u = iu; }
                else if (u !== iu) { return ''; }
            }
            return u ? ' · ' + u : '';
        }

        /** Say what is wrong, rather than drawing a ring with nothing in it. */
        function emptyMessage(model, cfg) {
            switch (model.reason) {
                case 'allnegative':
                    return ['Nothing to share out',
                        'Every source is negative; a share of a total is undefined for a negative part.'];
                case 'zerototal':
                    return ['Total is zero',
                        'All ' + model.sources + ' sources sum to zero, so no source has a share.'];
                case 'novalues':
                    return ['No ' + PVX.config.statLabel(cfg).toLowerCase() + ' values',
                        'All ' + model.sources + ' sources returned an empty cell.'];
                default:
                    return ['No data sources', 'Drop one or more attributes onto this symbol.'];
            }
        }

        /* ---------------------------------------------------------------- *
         * Layout
         * ---------------------------------------------------------------- */

        /**
         * 'auto' picks right for a wide symbol and bottom for a tall one.
         * This matters more than it looks: a right-hand legend on a 220x300
         * symbol leaves a ring the size of a coin, and a bottom legend on a
         * 700x220 one wastes the half of the frame the ring cannot use.
         */
        function resolveLegendPos(cfg, W, H) {
            if (cfg.ShowLegend === false) { return 'none'; }
            var pos = cfg.LegendPosition || 'auto';
            if (pos === 'none') { return 'none'; }
            if (pos === 'right' || pos === 'bottom') { return pos; }
            return (W >= H * 1.25 && W >= 240) ? 'right' : 'bottom';
        }

        function drawDonut(svgRoot, W, H, cfg, t, model, tier) {
            var i;
            var slices = model.slices;
            var n = slices.length;
            var defs = PVX.svg.el('defs', null, svgRoot);
            var hatchCache = {};

            // ---- size tiers ---------------------------------------------------
            // Below these the extras stop being information and start being
            // noise that eats the only mark carrying data — the ring.
            var ringOnly = tier.ringOnly;
            var cramped = tier.cramped;

            var legendPos = cramped ? 'none' : resolveLegendPos(cfg, W, H);
            var showLabels = !!cfg.ShowSliceLabels && !cramped;
            var showCenter = cfg.ShowCenter !== false && !ringOnly;

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 8, 12);
            var pad = 5;

            // Colours resolved once: the ring, the legend and the labels must
            // agree, and palette indices follow display order.
            var colors = [];
            for (i = 0; i < n; i++) { colors.push(sliceColor(slices[i], i, cfg, t)); }

            // ---- plot box ------------------------------------------------------
            var plot = { x0: pad, y0: pad, x1: W - pad, y1: H - pad };
            var legend = null;

            if (legendPos === 'right') {
                legend = planLegendRight(slices, colors, cfg, W, H, font);
                if (legend) { plot.x1 -= legend.width + 4; }
            } else if (legendPos === 'bottom') {
                legend = planLegendBottom(slices, colors, cfg, W, H, font);
                if (legend) { plot.y1 -= legend.height + 2; }
            }

            var plotW = Math.max(20, plot.x1 - plot.x0);
            var plotH = Math.max(20, plot.y1 - plot.y0);

            // Outside slice labels need room outside the ring; reserve it before
            // sizing the ring rather than discovering the overflow afterwards.
            // Names need materially more room outside the ring than a bare
            // percentage does, so the reserve follows the label mode.
            var wordy = cfg.SliceLabelMode === 'name' || cfg.SliceLabelMode === 'nameAndPercent';
            var reserveX = showLabels ? Math.min(plotW * 0.26, font * (wordy ? 6.5 : 4)) : 0;
            var reserveY = showLabels ? Math.min(plotH * 0.16, font * (wordy ? 2.2 : 1.6)) : 0;

            var rOuter = Math.max(8, Math.min((plotW - reserveX * 2) / 2, (plotH - reserveY * 2) / 2));
            var cx = plot.x0 + plotW / 2;
            var cy = plot.y0 + plotH / 2;

            // A ring beside a legend is one visual block, so it is that block —
            // not the ring alone — that gets centred. Otherwise a short, wide
            // symbol shows a ring pinned to the middle with its legend trailing
            // off to the right and a lake of empty space on the left.
            var legendGap = Math.max(12, font * 1.4);
            if (legend && legendPos === 'right') {
                var blockW = rOuter * 2 + reserveX * 2 + legendGap + legend.width;
                cx = pad + Math.max(0, (W - pad * 2 - blockW) / 2) + reserveX + rOuter;
            }

            var innerPct = PVX.util.clamp(numOr(cfg.InnerRadiusPct, 58), 0, 92);
            var rInner = rOuter * (innerPct / 100);

            // ---- slices ---------------------------------------------------------
            var ringG = PVX.svg.el('g', { 'class': 'pvx-donut-ring' }, svgRoot);
            for (i = 0; i < n; i++) {
                var s = slices[i];
                var d = slicePath(cx, cy, rInner, rOuter, s.a0, s.a1, model.pad);
                if (!d) { continue; }
                var col = colors[i];
                var grp = PVX.svg.el('g', { 'class': 'pvx-donut-slice' }, ringG);
                PVX.svg.el('path', {
                    d: d,
                    'fill-rule': 'evenodd',
                    fill: s.good ? col : hatchFor(defs, hatchCache, col),
                    stroke: s.good ? 'none' : col,
                    'stroke-width': s.good ? null : 0.8
                }, grp);

                // The full name and number live in a <title>: the drawn label is
                // a display compromise, the tooltip is the source of truth.
                PVX.svg.el('title', null, grp).textContent =
                    s.label + ' — ' + valueText(s.value, cfg) +
                    (s.units ? ' ' + s.units : '') +
                    ' · ' + pctText(s.pct) + ' of ' + valueText(model.total, cfg) +
                    (s.good ? '' : ' · BAD QUALITY' + (s.error ? ': ' + s.error : '')) +
                    (s.path ? '\n' + s.path : '');
            }

            // ---- slice labels ----------------------------------------------------
            if (showLabels) {
                drawSliceLabels(svgRoot, cfg, t, {
                    slices: slices, colors: colors, cx: cx, cy: cy,
                    rInner: rInner, rOuter: rOuter, font: font,
                    W: W, H: H, plot: plot
                });
            }

            // ---- centre readout --------------------------------------------------
            if (showCenter) {
                drawCenter(svgRoot, cfg, t, model, cx, cy, rInner, rOuter, cramped);
            }

            // ---- legend -----------------------------------------------------------
            if (legend) {
                if (legendPos === 'right') {
                    // Sit next to the ring rather than flush against the frame:
                    // when the ring is height-limited a flush legend floats away
                    // from the marks it explains, and the eye has to travel.
                    var lx = Math.max(plot.x0,
                        Math.min(W - pad - legend.width, cx + rOuter + reserveX + legendGap));
                    drawLegendRight(svgRoot, legend, cfg, t, defs, hatchCache,
                        lx, plot.y0, plot.y1 - plot.y0);
                } else {
                    drawLegendBottom(svgRoot, legend, cfg, t, defs, hatchCache,
                        plot.x0, H - pad - legend.height, plot.x1 - plot.x0);
                }
            }
        }

        /* ---------------------------------------------------------------- *
         * Centre readout
         * ---------------------------------------------------------------- *
         * Same discipline as pvxRadialGauge: reserve the space FIRST, then size
         * the text to it. The hole is a circle, so the usable width is a chord
         * well inside it, not its diameter — text sized to the diameter clips on
         * both sides against the ring.
         */
        function drawCenter(svgRoot, cfg, t, model, cx, cy, rInner, rOuter, cramped) {
            var readout = centerText(cfg, model);
            if (!readout.value) { return; }

            // A pie has no hole to write in. Stamping the total over the wedges
            // would sit unreadable text on top of the only marks carrying data,
            // and painting a disc behind it would just be a donut drawn the
            // dishonest way — so the readout is dropped and the config pane says
            // why. The hole is what buys the readout.
            if (!(rInner > rOuter * 0.26)) { return; }
            var rBox = rInner * 0.94;
            if (rBox < 9) { return; }

            var caption = cramped ? '' : readout.caption;
            var maxW = rBox * (caption ? 1.7 : 1.8);
            var vBudget = rBox * (caption ? 0.86 : 1.15);
            var vFont = PVX.layout.fitFont(readout.value, maxW, vBudget, Math.max(10, rBox * 0.66), 8);
            var cFont = PVX.util.clamp(vFont * 0.38, 7, 14);

            var g = PVX.svg.el('g', { 'class': 'pvx-donut-center' }, svgRoot);
            var valueY = cy - (caption ? vFont * 0.16 : 0);

            var vNode = PVX.svg.text(g, cx.toFixed(2), valueY.toFixed(2), readout.value, {
                'class': 'pvx-svg-value pvx-num pvx-donut-total',
                'text-anchor': 'middle',
                'font-size': vFont.toFixed(1),
                fill: readout.color || t.text
            });

            var cNode = null;
            if (caption) {
                cNode = PVX.svg.text(g, cx.toFixed(2),
                    (valueY + vFont * 0.58 + cFont * 0.5).toFixed(2), caption, {
                        'class': 'pvx-svg-label pvx-donut-caption',
                        'text-anchor': 'middle',
                        'font-size': cFont.toFixed(1),
                        fill: t.textMuted
                    });
            }

            // The glyph estimate inside fitFont is good enough to choose a size
            // but not to guarantee a fit, and this is the one string an operator
            // reads from across a control room. Measure, then shrink BOTH lines
            // by the same ratio so the block keeps its proportions instead of
            // the caption suddenly out-sizing the number.
            var ratio = 1;
            var wv = measured(vNode);
            if (wv > maxW && wv > 0) { ratio = Math.min(ratio, maxW / wv); }
            if (cNode) {
                var wc = measured(cNode);
                if (wc > maxW && wc > 0) { ratio = Math.min(ratio, maxW / wc); }
            }
            if (ratio < 0.999) {
                vFont = Math.max(7, vFont * ratio);
                cFont = Math.max(6, cFont * ratio);
                valueY = cy - (caption ? vFont * 0.16 : 0);
                vNode.setAttribute('font-size', vFont.toFixed(1));
                vNode.setAttribute('y', valueY.toFixed(2));
                if (cNode) {
                    cNode.setAttribute('font-size', cFont.toFixed(1));
                    cNode.setAttribute('y', (valueY + vFont * 0.58 + cFont * 0.5).toFixed(2));
                }
            }
            // Below the readable floor a caption is worse than none: it costs the
            // number the vertical room it needs.
            if (cNode && (cFont < 7 || measured(cNode) > maxW)) {
                fitTextTo(cNode, maxW);
                if (!cNode.textContent) { g.removeChild(cNode); }
            }
        }

        function centerText(cfg, model) {
            var mode = cfg.CenterMode || 'total';
            var label = cfg.CenterLabel || '';
            var i, biggest;

            if (mode === 'custom') {
                return { value: String(cfg.CenterValue === undefined ? '' : cfg.CenterValue), caption: label };
            }
            if (mode === 'count') {
                return {
                    value: String(model.slices.length),
                    caption: label || (model.slices.length === 1 ? 'slice' : 'slices')
                };
            }
            if (mode === 'largest') {
                biggest = model.slices[0];
                for (i = 1; i < model.slices.length; i++) {
                    if (model.slices[i].value > biggest.value) { biggest = model.slices[i]; }
                }
                return {
                    value: pctText(biggest.pct),
                    caption: label || biggest.label
                };
            }
            return { value: valueText(model.total, cfg), caption: label || 'Total' };
        }

        /* ---------------------------------------------------------------- *
         * Slice labels
         * ---------------------------------------------------------------- */

        function sliceLabelText(slice, cfg) {
            switch (cfg.SliceLabelMode) {
                case 'value': return valueText(slice.value, cfg);
                case 'name': return slice.label;
                case 'nameAndPercent': return slice.label + ' ' + pctText(slice.pct);
                case 'percent':
                default: return pctText(slice.pct);
            }
        }

        /**
         * Is an axis-aligned box centred on (px,py) wholly inside this annulus
         * sector? Tested corner by corner, because the alternative — estimating
         * the "room" at a given angle by interpolating between the wedge chord
         * and the ring thickness — is exactly the kind of approximation that
         * puts a label half over its neighbour and half in the hole. A rectangle
         * this small is convex enough that its corners decide it.
         */
        function boxInSector(cx, cy, rIn, rOut, a0, a1, px, py, w, h) {
            var lo = Math.min(a0, a1), span = Math.abs(a1 - a0);
            if (span >= 359.9) { span = 360; }
            var xs = [px - w / 2, px + w / 2];
            var ys = [py - h / 2, py + h / 2];
            for (var i = 0; i < 2; i++) {
                for (var j = 0; j < 2; j++) {
                    var dx = xs[i] - cx, dy = ys[j] - cy;
                    var r = Math.sqrt(dx * dx + dy * dy);
                    if (r < rIn || r > rOut) { return false; }
                    if (span >= 360) { continue; }
                    // Same convention as PVX.svg.polar: 0 = 12 o'clock, clockwise.
                    var deg = Math.atan2(dy, dx) * 180 / Math.PI + 90;
                    var delta = ((deg - lo) % 360 + 360) % 360;
                    if (delta > span) { return false; }
                }
            }
            return true;
        }

        /**
         * Inside the wedge when it fits, outside with a leader line when it does
         * not — and nowhere at all when even the outside placement would collide
         * with a bigger slice's label.
         *
         * Fit is decided from getComputedTextLength(), never from glyph counts:
         * the estimate runs narrow on mixed-case names, and a slice label that
         * overhangs its own wedge attributes a number to the wrong source.
         */
        function drawSliceLabels(svgRoot, cfg, t, o) {
            var i;
            var minPct = PVX.util.clamp(numOr(cfg.MinSliceLabelPct, 5), 0, 100);
            // A pie has no band to sit in, so its labels ride at the radius that
            // leaves the most wedge on both sides of the text.
            var rLabel = o.rInner > 0 ? (o.rInner + o.rOuter) / 2 : o.rOuter * 0.62;
            var insideG = PVX.svg.el('g', { 'class': 'pvx-donut-labels' }, svgRoot);
            var outside = [];

            for (i = 0; i < o.slices.length; i++) {
                var s = o.slices[i];
                if (s.pct < minPct) { continue; }
                var str = sliceLabelText(s, cfg);
                if (!str) { continue; }

                var p = PVX.svg.polar(o.cx, o.cy, rLabel, s.mid);
                var node = PVX.svg.text(insideG, p.x.toFixed(2), p.y.toFixed(2), str, {
                    'class': 'pvx-svg-label pvx-donut-slicelabel',
                    'text-anchor': 'middle',
                    'font-size': o.font,
                    fill: PVX.color.readable(o.colors[i])
                });

                var w = measured(node) + 4;          // +4 so glyphs never kiss the edge
                if (w > 4 && boxInSector(o.cx, o.cy, o.rInner, o.rOuter, s.a0, s.a1,
                        p.x, p.y, w, o.font * 1.05)) {
                    continue;  // fits inside; leave it where it is
                }
                insideG.removeChild(node);
                outside.push({ slice: s, text: str, idx: i });
            }

            if (!outside.length) { return; }
            placeOutsideLabels(svgRoot, cfg, t, o, outside);
        }

        /**
         * Outside labels, clamped inside the frame and de-conflicted per side.
         * Where two would overlap, the SMALLER slice loses its label: a missing
         * label on a sliver is a small loss, two labels drawn on top of each
         * other are unreadable for both.
         */
        function placeOutsideLabels(svgRoot, cfg, t, o, cand) {
            var i, j;
            var g = PVX.svg.el('g', { 'class': 'pvx-donut-outside' }, svgRoot);
            var gap = Math.min(10, Math.max(5, o.font * 0.7));
            var lineH = o.font * 1.25;

            var sides = { left: [], right: [] };
            for (i = 0; i < cand.length; i++) {
                var s = cand[i].slice;
                var anchor = PVX.svg.polar(o.cx, o.cy, o.rOuter + gap, s.mid);
                var right = anchor.x >= o.cx;
                sides[right ? 'right' : 'left'].push({
                    text: cand[i].text,
                    value: s.value,
                    slice: s,
                    color: o.colors[cand[i].idx],
                    elbow: anchor,
                    tip: PVX.svg.polar(o.cx, o.cy, o.rOuter + 1, s.mid),
                    y: anchor.y,
                    right: right
                });
            }

            var keys = ['left', 'right'];
            for (var k = 0; k < keys.length; k++) {
                var list = sides[keys[k]];
                list.sort(function (a, b) { return a.y - b.y; });

                // Greedy de-confliction down the side; a collision is resolved
                // in favour of the larger slice, whichever of the two it is.
                var kept = [];
                for (i = 0; i < list.length; i++) {
                    var it = list[i];
                    var prev = kept.length ? kept[kept.length - 1] : null;
                    if (prev && Math.abs(it.y - prev.y) < lineH) {
                        if (it.value > prev.value) { kept.pop(); kept.push(it); }
                        continue;   // otherwise the smaller candidate is dropped
                    }
                    kept.push(it);
                }

                for (j = 0; j < kept.length; j++) {
                    drawOutsideLabel(g, cfg, t, o, kept[j], gap);
                }
            }
        }

        function drawOutsideLabel(g, cfg, t, o, it, gap) {
            // Keep the whole label inside the frame — an off-canvas label is
            // silent data loss for whoever is reading the display.
            var y = PVX.util.clamp(it.y, o.plot.y0 + o.font * 0.7, o.plot.y1 - o.font * 0.4);
            var x = it.right ? it.elbow.x + 4 : it.elbow.x - 4;
            x = PVX.util.clamp(x, o.plot.x0 + 2, o.plot.x1 - 2);
            var avail = it.right ? (o.plot.x1 - x - 1) : (x - o.plot.x0 - 1);
            if (avail < o.font * 1.2) { return; }

            if (cfg.ShowLeaderLines !== false) {
                PVX.svg.el('path', {
                    d: 'M' + it.tip.x.toFixed(2) + ' ' + it.tip.y.toFixed(2) +
                        ' L' + it.elbow.x.toFixed(2) + ' ' + it.elbow.y.toFixed(2) +
                        ' L' + x.toFixed(2) + ' ' + y.toFixed(2),
                    fill: 'none',
                    stroke: t.textMuted,
                    'stroke-width': 0.8,
                    'stroke-opacity': 0.75,
                    'class': 'pvx-donut-leader'
                }, g);
            }

            var node = PVX.svg.text(g, x.toFixed(2), y.toFixed(2),
                truncate(it.text, avail, o.font), {
                    'class': 'pvx-svg-label pvx-donut-slicelabel',
                    'text-anchor': it.right ? 'start' : 'end',
                    'font-size': o.font,
                    fill: t.text
                });
            // Estimate first (above) so this measurement usually confirms rather
            // than corrects — see fitTextTo.
            fitTextTo(node, avail);
            PVX.svg.el('title', null, node).textContent =
                it.slice.label + ' — ' + valueText(it.slice.value, cfg) + ' · ' + pctText(it.slice.pct);
        }

        /* ---------------------------------------------------------------- *
         * Legend
         * ---------------------------------------------------------------- *
         * Names truncate, they never wrap: a wrapped name changes the row height
         * and therefore how many rows fit, which makes the legend's length a
         * function of its own content. Values and percents are right-aligned in
         * tabular figures so the columns can be read down.
         */

        function legendRowText(slice, cfg) {
            return {
                name: slice.label,
                value: cfg.LegendShowValue !== false ? valueText(slice.value, cfg) : '',
                pct: cfg.LegendShowPercent !== false ? pctText(slice.pct) : ''
            };
        }

        function planLegendRight(slices, colors, cfg, W, H, font) {
            var i;
            var lf = PVX.util.clamp(font * 0.95, 8, 11.5);
            var rowH = Math.max(11, lf * 1.55);
            var texts = [], valW = 0, pctW = 0, nameW = 0;
            for (i = 0; i < slices.length; i++) {
                var r = legendRowText(slices[i], cfg);
                texts.push(r);
                valW = Math.max(valW, textPx(r.value, lf));
                pctW = Math.max(pctW, textPx(r.pct, lf));
                nameW = Math.max(nameW, textPx(r.name, lf));
            }

            // The estimate above runs narrow on proper nouns and on tabular
            // digits; a few percent of headroom keeps the right-aligned number
            // columns from growing into each other once they are measured.
            valW = Math.ceil(valW * 1.08);
            pctW = Math.ceil(pctW * 1.08);
            nameW = Math.ceil(nameW * 1.08);

            var swatch = Math.max(6, Math.min(9, lf));
            var maxW = Math.min(W * 0.46, 240);
            var nameCap = 180;
            var fixed = swatch + 4 + (valW ? valW + 8 : 0) + (pctW ? pctW + 8 : 0);
            var width = Math.min(maxW, fixed + Math.min(nameW, nameCap) + 4);

            // Drop the least load-bearing column first when the box is narrow:
            // the value, then the percent. A legend with no names is useless.
            if (width - fixed < 26 && valW) { valW = 0; fixed = swatch + 4 + (pctW ? pctW + 8 : 0); width = Math.min(maxW, fixed + Math.min(nameW, nameCap) + 4); }
            if (width - fixed < 26 && pctW) { pctW = 0; fixed = swatch + 4; width = Math.min(maxW, fixed + Math.min(nameW, nameCap) + 4); }
            if (width - fixed < 20) { return null; }

            var capacity = Math.max(0, Math.floor((H - 10) / rowH));
            if (capacity < 1) { return null; }

            return {
                mode: 'right', texts: texts, colors: colors, slices: slices,
                font: lf, rowH: rowH, swatch: swatch,
                valW: valW, pctW: pctW, width: width, capacity: capacity
            };
        }

        function planLegendBottom(slices, colors, cfg, W, H, font) {
            var i;
            var lf = PVX.util.clamp(font * 0.95, 8, 11);
            var rowH = Math.max(11, lf * 1.5);
            var texts = [], valW = 0, pctW = 0, nameW = 0;
            for (i = 0; i < slices.length; i++) {
                var r = legendRowText(slices[i], cfg);
                texts.push(r);
                valW = Math.max(valW, textPx(r.value, lf));
                pctW = Math.max(pctW, textPx(r.pct, lf));
                nameW = Math.max(nameW, textPx(r.name, lf));
            }
            var swatch = Math.max(6, Math.min(8, lf));

            // A bottom legend is a grid. Column count comes from what one row
            // genuinely needs, so two columns are only used when both are
            // readable.
            var need = swatch + 4 + Math.min(nameW, 90) + (valW ? valW + 5 : 0) + (pctW ? pctW + 5 : 0) + 10;
            var cols = PVX.util.clamp(Math.floor(W / Math.max(70, need)), 1, 4);
            var colW = (W - 10) / cols;
            if (colW < swatch + 30) { cols = 1; colW = W - 10; }

            // At most 40% of the height, and never more than half the rows the
            // ring needs to stay a ring.
            var maxRows = Math.max(1, Math.floor(Math.min(H * 0.4, H - 90) / rowH));
            if (maxRows < 1) { return null; }
            var rowsNeeded = Math.ceil(slices.length / cols);
            var rowCount = Math.min(rowsNeeded, maxRows);
            var capacity = rowCount * cols;

            return {
                mode: 'bottom', texts: texts, colors: colors, slices: slices,
                font: lf, rowH: rowH, swatch: swatch,
                valW: valW, pctW: pctW, cols: cols, colW: colW,
                rowCount: rowCount, capacity: capacity,
                height: rowCount * rowH + 2
            };
        }

        function drawLegendRight(svgRoot, L, cfg, t, defs, hatchCache, x0, y0, availH) {
            var g = PVX.svg.el('g', { 'class': 'pvx-donut-legend' }, svgRoot);
            var n = L.slices.length;
            var capacity = Math.max(1, Math.min(L.capacity, Math.floor(availH / L.rowH)));
            var draw = n;
            var overflow = 0;
            if (n > capacity) { draw = Math.max(0, capacity - 1); overflow = n - draw; }

            // Centre the block vertically against the ring it annotates.
            var used = (draw + (overflow ? 1 : 0)) * L.rowH;
            var y = y0 + Math.max(0, (availH - used) / 2);

            for (var i = 0; i < draw; i++) {
                legendRow(g, L, cfg, t, defs, hatchCache, i, x0, y + i * L.rowH, L.width);
            }
            if (overflow) {
                PVX.svg.text(g, (x0 + L.swatch + 4).toFixed(2), (y + draw * L.rowH + L.rowH / 2).toFixed(2),
                    '+' + overflow + ' more', {
                        'class': 'pvx-svg-label pvx-donut-legend-more',
                        'font-size': L.font, fill: t.textMuted
                    });
            }
        }

        function drawLegendBottom(svgRoot, L, cfg, t, defs, hatchCache, x0, y0, availW) {
            var g = PVX.svg.el('g', { 'class': 'pvx-donut-legend' }, svgRoot);
            var n = L.slices.length;
            var draw = n;
            var overflow = 0;
            if (n > L.capacity) { draw = Math.max(0, L.capacity - 1); overflow = n - draw; }

            var colW = availW / L.cols;
            for (var i = 0; i < draw; i++) {
                var col = i % L.cols;
                var row = Math.floor(i / L.cols);
                legendRow(g, L, cfg, t, defs, hatchCache, i,
                    x0 + col * colW, y0 + row * L.rowH, colW - 6);
            }
            if (overflow) {
                var oc = draw % L.cols, orow = Math.floor(draw / L.cols);
                PVX.svg.text(g, (x0 + oc * colW + L.swatch + 4).toFixed(2),
                    (y0 + orow * L.rowH + L.rowH / 2).toFixed(2),
                    '+' + overflow + ' more', {
                        'class': 'pvx-svg-label pvx-donut-legend-more',
                        'font-size': L.font, fill: t.textMuted
                    });
            }
        }

        /** One legend row: swatch, truncated name, right-aligned value + percent. */
        function legendRow(g, L, cfg, t, defs, hatchCache, i, x, y, width) {
            var row = L.texts[i];
            var slice = L.slices[i];
            var color = L.colors[i];
            var midY = y + L.rowH / 2;

            PVX.svg.el('rect', {
                x: x.toFixed(2), y: (midY - L.swatch / 2).toFixed(2),
                width: L.swatch, height: L.swatch, rx: 2,
                // Bad-quality sources keep their place in the legend — hiding
                // them would make the percentages unaccountable — but the swatch
                // is hatched exactly like the slice.
                fill: slice.good ? color : hatchFor(defs, hatchCache, color),
                'class': 'pvx-donut-swatch'
            }, g);

            var right = x + width;
            var pctX = right;
            var valX = right - (L.pctW ? L.pctW + 8 : 0);
            var nameRight = valX - (L.valW ? L.valW + 8 : 0);
            var nameX = x + L.swatch + 4;
            var nameAvail = nameRight - nameX - 2;

            if (nameAvail > 6) {
                var nt = PVX.svg.text(g, nameX.toFixed(2), midY.toFixed(2),
                    truncate(row.name, nameAvail, L.font), {
                        'class': 'pvx-svg-label pvx-donut-legend-name',
                        'font-size': L.font,
                        fill: slice.good ? t.text : t.textMuted,
                        opacity: slice.good ? null : 0.75
                    });
                fitTextTo(nt, nameAvail);
                PVX.svg.el('title', null, nt).textContent = slice.label +
                    (slice.good ? '' : ' · BAD QUALITY');
            }

            if (L.valW && row.value) {
                PVX.svg.text(g, valX.toFixed(2), midY.toFixed(2), row.value, {
                    'class': 'pvx-svg-label pvx-num pvx-donut-legend-value',
                    'text-anchor': 'end', 'font-size': L.font, fill: t.text
                });
            }
            if (L.pctW && row.pct) {
                PVX.svg.text(g, pctX.toFixed(2), midY.toFixed(2), row.pct, {
                    'class': 'pvx-svg-label pvx-num pvx-donut-legend-pct',
                    'text-anchor': 'end', 'font-size': L.font, fill: t.textMuted
                });
            }
        }

        /* ---------------------------------------------------------------- *
         * Empty state
         * ---------------------------------------------------------------- */

        function emptyState(svgRoot, W, H, t, msg) {
            var headline = msg[0], detail = msg[1];
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);

            // Centre-anchored text spills past BOTH edges once it is wider than
            // the frame, so shrink to fit first and only then truncate. 0.62em
            // rather than 0.58: this copy is sentence case with wide glyphs.
            var avail = Math.max(24, W - 12);
            var longest = Math.max(String(headline).length, String(detail).length);
            if (longest * font * 0.62 > avail) {
                font = PVX.util.clamp(Math.floor(avail / (longest * 0.62)), 7, font);
            }
            var fitLine = function (str, px) {
                var maxChars = Math.max(3, Math.floor(avail / (px * 0.62)));
                return str.length > maxChars ? str.slice(0, maxChars - 1) + '…' : str;
            };

            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2),
                fitLine(headline, font), {
                    'class': 'pvx-svg-label pvx-donut-emptymsg', 'text-anchor': 'middle',
                    'font-size': font, 'font-weight': '600', fill: t.textMuted
                });
            var sub = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.8).toFixed(2),
                fitLine(detail, font * 0.85), {
                    'class': 'pvx-svg-label pvx-donut-emptymsg', 'text-anchor': 'middle',
                    'font-size': (font * 0.85).toFixed(1), fill: t.textMuted
                });

            // Two forced layouts, only when there is nothing to chart — and a
            // centred message poking out of both edges is the most obviously
            // broken thing a symbol can show.
            shrinkToFit(head, avail);
            shrinkToFit(sub, avail);
        }

        /**
         * Scale an SVG <text> down until it fits `avail`, then truncate if the
         * 6px floor still is not enough. Shrinking alone is not sufficient: a
         * long sentence in a 140px-wide symbol would need an unreadable font.
         */
        function shrinkToFit(node, avail) {
            if (!node || !node.getComputedTextLength || !(avail > 0)) { return; }
            var w = measured(node);
            if (!(w > avail)) { return; }

            var size = parseFloat(node.getAttribute('font-size')) || 10;
            node.setAttribute('font-size', Math.max(6, size * (avail / w)).toFixed(1));

            w = measured(node);
            if (!(w > avail)) { return; }

            var str = node.textContent;
            var keep = Math.max(3, Math.floor(str.length * (avail / w)) - 1);
            node.textContent = str.slice(0, keep) + '…';
            for (var guard = 0; guard < 24 && measured(node) > avail && node.textContent.length > 2; guard++) {
                node.textContent = node.textContent.slice(0, -2) + '…';
            }
        }

        /** Theme tokens as CSS custom properties for the Angular-rendered chrome. */
        function applyThemeVars(c, t) {
            var nde = c.node;
            if (!nde || !nde.style || !nde.style.setProperty) { return; }
            nde.style.setProperty('--pvx-text', t.text);
            nde.style.setProperty('--pvx-muted', t.textMuted);
            nde.style.setProperty('--pvx-border', t.border);
            nde.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
        }

        /* Rendering happens in a rAF, i.e. outside Angular's digest, so the
         * scope.pvx writes above need an explicit (guarded) digest. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
