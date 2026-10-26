/* ============================================================================
 * pvxDataHealth — which of these tags can I not trust right now?
 * ----------------------------------------------------------------------------
 * DataShape: TimeSeries (Multiple data sources), DataQueryMode: ModeEvents
 * @mock health
 *
 * The commonest reason a display lies is not a process upset but a dead tag:
 * an interface that stopped sending, a transmitter frozen at its last reading,
 * a read that now returns "I/O Timeout". None of those look wrong on a gauge.
 * Point this symbol at a whole unit's attributes and it lists only the ones in
 * trouble, worst first, with the healthy rest reduced to a count.
 *
 * Four checks, one verdict per tag — the worst that applies:
 *
 *   Bad           PI Vision marked the attribute bad, or the newest value of a
 *                 numeric tag is a system digital state ("I/O Timeout").
 *   Out of range  newest value outside the instrument span given in Ranges.
 *                 PI Vision does not pass Zero/Span to symbols, so the span has
 *                 to be configured; the format pane can fill it from PI once
 *                 (PVX.tags), but nothing is read from PI Web API here. A range
 *                 entry that matches no tag is reported in the footer rather
 *                 than ignored.
 *   Stale         newest event older than StaleMinutes.
 *   Flatlined     value unchanged (within FlatlineTolerance) for FlatlineHours.
 *
 * WHY ModeEvents. Plot values are interpolated onto a grid that runs to the end
 * of the window, so a dead tag still appears to have a fresh sample at "now".
 * Recorded events are the only shape in which a stopped interface shows a gap.
 *
 * The honest limitation: PI's exception and compression settings decide which
 * events reach the archive. A healthy tag that holds perfectly steady records
 * one event per CompMax (eight hours by default), and from recorded data alone
 * it is indistinguishable from a dead one. StaleMinutes therefore has to sit
 * above CompMax for the tags it watches, and slow tags take an entry in
 * UpdateOverrides. This needs confirming against a real server before anyone
 * relies on the stale/flat distinction.
 *
 * "Now" is the payload's EndTime when PI Vision supplies one and the browser
 * clock otherwise, so on a display scrolled into the past every tag can read
 * as stale. The footer says which clock was used.
 *
 * Questionable and Substituted flags do not reach a symbol through PI Vision's
 * data pipeline — only good/bad does — so they are not shown here.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Severity order. One verdict per tag: the worst that applies. */
    var KINDS = {
        bad:   { sev: 4, label: 'Bad' },
        range: { sev: 3, label: 'Out of range' },
        stale: { sev: 2, label: 'Stale' },
        flat:  { sev: 1, label: 'Flatlined' }
    };
    var ORDER = ['bad', 'range', 'stale', 'flat'];

    var definition = {
        typeName: 'pvxDataHealth',
        displayName: 'PVX Data Health',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Data Health',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'TimeSeries',
                DataQueryMode: 'ModeEvents',
                Height: 300,
                Width: 440,

                Title: 'Data health',

                // Checks
                StaleMinutes: 60,
                FlatlineHours: 4,
                FlatlineTolerance: 0,
                Ranges: '',             // "Label: lo..hi, Label: lo..hi"
                UpdateOverrides: '',    // "Label: minutes" — 0 excludes the tag

                // Layout
                ShowCounts: true,
                ShowSparkline: true,
                ShowValue: true,
                MaxRows: 50,
                RowHeight: 26,
                EmptyText: 'All tags healthy',
                ShowLabel: true
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            title: '',
            counts: [],
            footer: '',
            showHeader: false
        };

        var series = [];        // PVX.data.stateSeries output
        var endTime = null;     // payload EndTime, when PI Vision sends one

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-health-body',

            onData: function (d) {
                // stateSeries, not series: series() throws away non-numeric
                // samples, and "I/O Timeout" in place of a number is exactly
                // the evidence this symbol exists to show.
                series = PVX.data.stateSeries(d);
                endTime = null;
                var et = d ? PVX.fmt.toDate(d.EndTime || d.endTime) : null;
                if (et) { endTime = et.getTime(); }
            },

            render: render
        });

        /* ================================================================== *
         * Config lists — "Label: value" entries, matched on the exact label
         * ================================================================== */

        /**
         * "Label: lo..hi" / "Label: minutes" -> [{key, value, used}]. Read by
         * PVX.tags.parse, the same parser the format pane's rows use, so what
         * the pane shows and what this symbol checks cannot drift apart.
         * Entries it cannot read are left out here; the pane flags them.
         */
        function parseList(spec, kind) {
            var out = [];
            var list = PVX.tags.parse(spec, kind);
            for (var i = 0; i < list.length; i++) {
                var e = list[i];
                if (!e.valid) { continue; }
                var v = kind === 'minutes' ? e.minutes :
                    { lo: Math.min(e.lo, e.hi), hi: Math.max(e.lo, e.hi) };
                out.push({ key: e.label.toLowerCase(), name: e.label, value: v, used: false });
            }
            return out;
        }

        /* Exact, case-insensitive match. A substring match would let a range
         * meant for "Pump 1 Amps" quietly apply to "Pump 11 Amps". */
        function lookup(list, label) {
            var k = String(label || '').trim().toLowerCase();
            for (var i = 0; i < list.length; i++) {
                if (list[i].key === k) { list[i].used = true; return list[i]; }
            }
            return null;
        }

        /* ================================================================== *
         * Model
         * ================================================================== */

        function buildModel(cfg) {
            var now = Date.now();
            var ref = endTime !== null ? endTime : now;
            var usedClock = endTime !== null ? 'display end time' : 'browser clock';

            var staleMin = PVX.util.num(cfg.StaleMinutes);
            if (staleMin === null || staleMin < 0) { staleMin = 60; }
            var flatH = PVX.util.num(cfg.FlatlineHours);
            if (flatH === null || flatH < 0) { flatH = 4; }
            var tol = Math.abs(PVX.util.num(cfg.FlatlineTolerance) || 0);

            var ranges = parseList(cfg.Ranges, 'range');
            var overrides = parseList(cfg.UpdateOverrides, 'minutes');

            // A sample newer than "now" means the browser clock is behind the
            // server's; trust the data rather than calling every tag fresh.
            for (var s0 = 0; s0 < series.length; s0++) {
                var p0 = series[s0].points;
                if (p0.length && p0[p0.length - 1].t > ref) { ref = p0[p0.length - 1].t; }
            }

            var rows = [];
            var healthy = 0, excluded = 0;
            var counts = { bad: 0, range: 0, stale: 0, flat: 0 };

            for (var i = 0; i < series.length; i++) {
                var sr = series[i];
                var ov = lookup(overrides, sr.label);
                var limitMin = ov ? ov.value : staleMin;
                var skipTime = ov && ov.value === 0;
                if (skipTime) { excluded++; }

                var verdict = assess(sr, ref, limitMin * 60000, skipTime, flatH * 3600000, tol, ranges);
                if (!verdict) {
                    if (!skipTime) { healthy++; }
                    continue;
                }
                counts[verdict.kind]++;
                verdict.label = sr.label;
                verdict.path = sr.path;
                verdict.units = sr.units;
                verdict.points = sr.points;
                verdict.sev = KINDS[verdict.kind].sev;
                rows.push(verdict);
            }

            rows.sort(function (a, b) {
                if (b.sev !== a.sev) { return b.sev - a.sev; }
                if (b.age !== a.age) { return b.age > a.age ? 1 : -1; }   // ages can be Infinity
                return String(a.label).localeCompare(String(b.label));
            });

            var unusedRanges = 0, unusedOverrides = 0, k;
            for (k = 0; k < ranges.length; k++) { if (!ranges[k].used) { unusedRanges++; } }
            for (k = 0; k < overrides.length; k++) { if (!overrides[k].used) { unusedOverrides++; } }

            return {
                rows: rows,
                counts: counts,
                total: series.length,
                healthy: healthy,
                excluded: excluded,
                unusedRanges: unusedRanges,
                unusedOverrides: unusedOverrides,
                ref: ref,
                clock: usedClock,
                staleMin: staleMin,
                flatH: flatH
            };
        }

        /**
         * The worst problem with one series, or null when it is healthy.
         * `age` is the sort key within a severity: longer-standing first.
         */
        function assess(sr, ref, staleMs, skipTime, flatMs, tol, ranges) {
            var pts = sr.points;
            var last = pts.length ? pts[pts.length - 1] : null;

            // A tag with any numeric sample is a numeric tag; for those a
            // non-numeric newest value is a system state reporting a failure.
            // A digital tag's values are all strings and that is normal.
            var numeric = false;
            for (var i = 0; i < pts.length; i++) { if (pts[i].v !== null) { numeric = true; break; } }

            if (!sr.good) {
                return { kind: 'bad', detail: sr.errorDescription || 'PI Vision reports bad data', value: '', age: 0 };
            }
            if (last && (last.good === false || (numeric && last.v === null))) {
                return {
                    kind: 'bad',
                    detail: last.state + ' since ' + PVX.fmt.time(last.t, 'short'),
                    value: '',
                    age: ref - last.t
                };
            }

            if (last && numeric && last.v !== null) {
                var rg = lookup(ranges, sr.label);
                if (rg && (last.v < rg.value.lo || last.v > rg.value.hi)) {
                    return {
                        kind: 'range',
                        detail: (last.v > rg.value.hi ? 'Above' : 'Below') + ' span ' +
                            PVX.fmt.tick(rg.value.lo) + '\u2013' + PVX.fmt.tick(rg.value.hi),
                        value: last.raw,
                        age: 0
                    };
                }
            }

            if (skipTime) { return null; }

            if (!last) {
                return { kind: 'stale', detail: 'No data in the time range', value: '', age: Infinity };
            }
            var age = ref - last.t;
            if (staleMs > 0 && age > staleMs) {
                return { kind: 'stale', detail: 'No new value for ' + PVX.fmt.duration(age), value: last.raw, age: age };
            }

            // Walk back from the newest numeric sample while the value holds.
            if (numeric && flatMs > 0 && last.v !== null) {
                var since = last.t, reachedStart = true;
                for (var j = pts.length - 2; j >= 0; j--) {
                    if (pts[j].v === null) { continue; }
                    if (Math.abs(pts[j].v - last.v) > tol) { reachedStart = false; break; }
                    since = pts[j].t;
                }
                // The value is in force from the first sample of the run until
                // "now", not merely until the newest sample.
                var held = ref - since;
                if (held >= flatMs) {
                    return {
                        kind: 'flat',
                        detail: 'Unchanged for ' + (reachedStart ? 'at least ' : '') + PVX.fmt.duration(held),
                        value: last.raw,
                        age: held
                    };
                }
            }
            return null;
        }

        /* ================================================================== *
         * Render
         * ================================================================== */

        function kindColor(kind) {
            var st = PVX.color.status;
            if (kind === 'bad') { return st.alarm; }
            if (kind === 'range') { return PVX.color.categorical[4]; }
            if (kind === 'stale') { return st.stale; }
            return st.warning;
        }

        /* Status colours are mid-tones chosen for fills. As text on a light
         * surface several fall under 4.5:1, so darken them there. */
        function textColor(c, t) {
            return t.dark ? c : PVX.color.mix(c, '#000000', 0.38);
        }

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;

            applyThemeVars(c, t);
            var model = buildModel(cfg);

            scope.pvx.title = cfg.Title || '';
            var pillRoom = c.width - (scope.pvx.title ? 110 : 10);
            scope.pvx.counts = (cfg.ShowCounts && pillRoom >= 120) ? countPills(model, t) : [];
            scope.pvx.showHeader = (!!cfg.ShowLabel && !!scope.pvx.title) || scope.pvx.counts.length > 0;
            scope.pvx.footer = footerText(model);

            if (host) {
                clear(host);
                if (!series.length) {
                    host.appendChild(emptyBox('No data sources', 'Add the attributes to check.', t.textMuted));
                } else if (!model.rows.length) {
                    host.appendChild(emptyBox(cfg.EmptyText || 'All tags healthy', '', PVX.color.status.normal, true));
                } else {
                    buildList(host, cfg, t, model, c.width);
                }
            }

            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', c.config.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-surface-alt', t.surfaceAlt);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
        }

        function countPills(model, t) {
            var out = [];
            for (var i = 0; i < ORDER.length; i++) {
                var k = ORDER[i];
                if (!model.counts[k]) { continue; }
                var col = kindColor(k);
                out.push({
                    key: k,
                    label: KINDS[k].label.toLowerCase(),
                    count: model.counts[k],
                    color: textColor(col, t),
                    bg: PVX.color.rgba(col, t.dark ? 0.22 : 0.14)
                });
            }
            return out;
        }

        /* Nothing leaves the list without the footer accounting for it. */
        function footerText(model) {
            if (!model.total) { return ''; }
            var parts = [model.healthy + ' of ' + model.total + ' healthy'];
            if (model.excluded) { parts.push(model.excluded + ' excluded from time checks'); }
            if (model.unusedRanges) {
                parts.push(model.unusedRanges + ' range ' + (model.unusedRanges === 1 ? 'entry matches' : 'entries match') + ' no tag');
            }
            if (model.unusedOverrides) {
                parts.push(model.unusedOverrides + ' override ' + (model.unusedOverrides === 1 ? 'entry matches' : 'entries match') + ' no tag');
            }
            parts.push('checked against ' + model.clock + ' ' + PVX.fmt.time(model.ref, 'short'));
            return parts.join(' · ');
        }

        /* Drop the least load-bearing column first as the symbol narrows. */
        function columns(cfg, width) {
            return {
                detail: width >= 250,
                value: !!cfg.ShowValue && width >= 330,
                spark: !!cfg.ShowSparkline && width >= 420
            };
        }

        function buildList(host, cfg, t, model, width) {
            var cols = columns(cfg, width);
            var max = Math.max(1, parseInt(cfg.MaxRows, 10) || 50);
            var rowH = Math.max(16, parseInt(cfg.RowHeight, 10) || 26);
            var list = div('pvx-health-list');
            var numOpts = PVX.config.numberOpts(cfg);

            var n = Math.min(max, model.rows.length);
            for (var i = 0; i < n; i++) {
                list.appendChild(buildRow(model.rows[i], cfg, cols, t, rowH, numOpts));
            }
            if (model.rows.length > n) {
                var more = div('pvx-health-more');
                more.textContent = '+' + (model.rows.length - n) + ' more not shown (MaxRows)';
                list.appendChild(more);
            }
            host.appendChild(list);
        }

        function buildRow(r, cfg, cols, t, rowH, numOpts) {
            var row = div('pvx-health-row');
            row.style.minHeight = rowH + 'px';
            row.setAttribute('title', (r.path || r.label) + '\n' + r.detail);

            var col = kindColor(r.kind);
            var chip = div('pvx-health-chip');
            chip.textContent = KINDS[r.kind].label;
            chip.style.color = textColor(col, t);
            chip.style.background = PVX.color.rgba(col, t.dark ? 0.24 : 0.15);
            row.appendChild(chip);

            var name = div('pvx-health-name pvx-truncate');
            name.textContent = r.label;
            row.appendChild(name);

            if (cols.detail) {
                var det = div('pvx-health-detail pvx-truncate');
                det.textContent = r.detail;
                row.appendChild(det);
            }

            if (cols.value) {
                var val = div('pvx-health-value pvx-num pvx-truncate');
                var hasVal = r.value !== '' && r.value !== null && r.value !== undefined;
                val.textContent = hasVal
                    ? PVX.fmt.number(r.value, numOpts) + (cfg.ShowUnits && r.units ? ' ' + r.units : '')
                    : '--';
                row.appendChild(val);
            }

            if (cols.spark) {
                row.appendChild(sparkline(r, t, col));
            }
            return row;
        }

        /**
         * A small trend of the samples that exist. The point is the SHAPE of
         * the failure: a line that stops short (stale), a line that goes flat,
         * a line running over a dashed span limit.
         */
        function sparkline(r, t, col) {
            var W = 72, H = 18;
            var svgRoot = PVX.svg.el('svg', {
                'class': 'pvx-health-spark',
                width: W, height: H,
                viewBox: '0 0 ' + W + ' ' + H,
                'aria-hidden': 'true'
            });
            var pts = [];
            for (var i = 0; i < r.points.length; i++) {
                if (r.points[i].v !== null) { pts.push(r.points[i]); }
            }
            if (pts.length < 1) { return svgRoot; }

            var t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, ctxRef());
            var lo = pts[0].v, hi = pts[0].v;
            for (i = 1; i < pts.length; i++) {
                if (pts[i].v < lo) { lo = pts[i].v; }
                if (pts[i].v > hi) { hi = pts[i].v; }
            }
            if (hi === lo) { hi = lo + 1; lo = lo - 1; }
            var sx = PVX.scale.linear(t0, t1 > t0 ? t1 : t0 + 1, 1, W - 1);
            var sy = PVX.scale.linear(lo, hi, H - 2, 2);

            var line = [];
            for (i = 0; i < pts.length; i++) { line.push({ x: sx(pts[i].t), y: sy(pts[i].v) }); }
            if (line.length === 1) { line.push({ x: line[0].x + 1, y: line[0].y }); }
            PVX.svg.el('path', {
                d: PVX.svg.line(line, false),
                fill: 'none',
                stroke: t.textMuted,
                'stroke-width': 1.2,
                'stroke-linejoin': 'round'
            }, svgRoot);

            // Stale: dotted continuation from the last sample to "now".
            var lastX = line[line.length - 1].x;
            if (r.kind === 'stale' && lastX < W - 3) {
                PVX.svg.el('path', {
                    d: 'M' + lastX.toFixed(1) + ',' + line[line.length - 1].y.toFixed(1) + ' H' + (W - 1),
                    stroke: col, 'stroke-width': 1.2, 'stroke-dasharray': '1.5 2.5', fill: 'none'
                }, svgRoot);
            }
            // Bad: a marker at the failed read.
            if (r.kind === 'bad') {
                PVX.svg.el('rect', {
                    x: (W - 6).toFixed(1), y: '1', width: '5', height: (H - 2).toFixed(1),
                    fill: col, 'fill-opacity': 0.35
                }, svgRoot);
            }
            return svgRoot;
        }

        function ctxRef() {
            return endTime !== null ? endTime : Date.now();
        }

        function emptyBox(headline, detail, colour, check) {
            var box = div('pvx-health-empty');
            box.style.color = colour;
            if (check) {
                var tick = document.createElement('span');
                tick.className = 'pvx-health-check';
                tick.textContent = '✓';
                box.appendChild(tick);
            }
            var txt = document.createElement('span');
            txt.textContent = headline + (detail ? ' — ' + detail : '');
            box.appendChild(txt);
            return box;
        }

        function div(cls) {
            var d = document.createElement('div');
            d.className = cls;
            return d;
        }

        function clear(node) {
            while (node.firstChild) { node.removeChild(node.firstChild); }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
