/* ============================================================================
 * pvxPareto — ranked bar / Pareto chart for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 *
 * The question this symbol answers is "which five assets are driving 80% of my
 * downtime / energy / scrap". That is a *ranking* question, so the symbol is
 * built around one sorted list of (name, value) pairs plus an optional
 * cumulative-percentage line on its own 0-100% axis.
 *
 * Why the Table shape rather than TimeSeries: PI Vision computes the aggregate
 * server-side, one number per data source, so a display with 40 tags costs one
 * request of 40 cells instead of 40 windows of samples. The aggregate to
 * compute is chosen with `config.Columns` — see COLUMN SYNC below.
 *
 * COLUMN SYNC
 *   PI Vision returns Summary cells *positionally*, matching config.Columns.
 *   The statistic the operator picked therefore has to drive that array, or the
 *   chart silently plots the wrong aggregate. Everything about that lives in
 *   the STATS table plus columnsFor()/syncColumns()/statValue(): one place
 *   decides which column is requested, and one place reads it back out.
 *   syncColumns() runs on every config change *and* at render time, so a
 *   display saved by an older build (or with a hand-edited config) repairs
 *   itself on load instead of charting stale numbers.
 *
 * RENDERING
 *   Everything is SVG drawn into `.pvx-pareto-body`; only the header/footer
 *   chrome is Angular-bound. The model (buildModel) is pure: given rows and a
 *   config it returns the exact list of bars, the cumulative series, and the
 *   notes to show — so the drawing code never has to make data decisions.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* ------------------------------------------------------------------ *
     * Statistics
     * ------------------------------------------------------------------ *
     * `column` is the PI Vision Table column name to request; `label` is what
     * the header shows. The two are separate because PI Vision's column names
     * are an API contract we must match exactly, while the label is for humans.
     */
    var STATS = {
        Value:   { column: 'Value',   label: 'Value' },
        Average: { column: 'Average', label: 'Average' },
        Minimum: { column: 'Minimum', label: 'Minimum' },
        Maximum: { column: 'Maximum', label: 'Maximum' },
        Range:   { column: 'Range',   label: 'Range' },
        StdDev:  { column: 'StdDev',  label: 'Std deviation' }
    };

    /** Chosen statistic, defaulted defensively — configs are user-editable. */
    function statKey(cfg) {
        var k = cfg && cfg.Statistic;
        return Object.prototype.hasOwnProperty.call(STATS, k) ? k : 'Value';
    }

    function statLabel(cfg) { return STATS[statKey(cfg)].label; }

    function columnFor(cfg) { return STATS[statKey(cfg)].column; }

    /** Exactly one column is ever requested, so the cell we want is always [0]. */
    function columnsFor(cfg) { return [columnFor(cfg)]; }

    /**
     * Force config.Columns (and the server-side sort column) to agree with the
     * chosen statistic. Returns true if anything changed, so callers can avoid
     * writing to the config — and re-triggering PI Vision's data fetch — on
     * every render.
     */
    function syncColumns(cfg) {
        if (!cfg) { return false; }
        var want = columnsFor(cfg);
        var changed = false;
        var cur = cfg.Columns;
        if (!cur || cur.length !== 1 || cur[0] !== want[0]) {
            cfg.Columns = want;
            changed = true;
        }
        // SortColumn only affects PI Vision's own row ordering; we re-sort
        // client-side anyway. Keeping it on the requested column just makes the
        // server's ordering meaningful rather than referring to a column we did
        // not ask for.
        if (cfg.SortColumn !== want[0]) {
            cfg.SortColumn = want[0];
            changed = true;
        }
        return changed;
    }

    var definition = {
        typeName: 'pvxPareto',
        displayName: 'PVX Ranked Bar',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // A collection would repeat the whole ranking per asset, which defeats
        // the purpose: the ranking IS the comparison across assets.
        supportsCollections: false,
        configTitle: 'Format Ranked Bar',

        getDefaultConfig: function () {
            // An AF search can supply the rows instead (PVX.afsource); off by default.
            // Shared filters (PVX.filter) likewise.
            return window.PVX.filter.defaults(window.PVX.afsource.defaults(window.PVX.config.base({
                DataShape: 'Table',
                // Positional contract with PI Vision's Summary cells. Kept in
                // sync with Statistic by syncColumns().
                Columns: ['Value'],
                SortColumn: 'Value',
                SortDescending: true,
                Height: 260,
                Width: 420,

                Title: '',                   // blank => generic heading

                // --- what is charted ---------------------------------
                Statistic: 'Value',          // Value|Average|Minimum|Maximum|Range|StdDev

                // --- shape -------------------------------------------
                // Horizontal is the default because tag/asset names are long
                // and reading them upright beats rotating them.
                Orientation: 'horizontal',   // horizontal | vertical
                SortMode: 'valueDesc',       // valueDesc | valueAsc | name | none
                TopN: 0,                     // 0 = show everything
                GroupRemainderAsOther: true,
                MaxBars: 40,
                BarGap: 0.25,                // fraction of each category slot
                NameWidthPct: 28,            // horizontal orientation only

                // --- Pareto line -------------------------------------
                ShowCumulative: true,
                CumulativeColor: '#c8452f',
                ShowEightyLine: true,
                EightyLineValue: 80,

                // --- bar color --------------------------------------
                ColorMode: 'single',         // single | palette | threshold | rank
                BarColor: '#3b82c4',

                // --- labels ------------------------------------------
                ShowValues: true,
                ValuePosition: 'end',        // end | inside | none
                ShowPercentOfTotal: false,

                // --- axes --------------------------------------------
                ShowAxis: true,
                ShowGrid: true,
                TickCount: 5,

                // --- rows ------------------------------------------
                // "element" names a bar after the AF element its attribute
                // belongs to: one attribute per complex reads as a ranking of
                // complexes, which "Greenwood|C2 Opportunity" does not.
                NameFrom: 'label',           // label | element
                // A $0 opportunity is a complex the ranking is not about
                // (Recovery mode); hiding it is said in the footer.
                HideZero: false,

                // --- interaction ------------------------------------
                ClickAction: 'none',         // none | navigate | filter
                NavigateTarget: ''
            })));
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the chart itself is SVG.
        scope.pvx = {
            title: '',
            subtitle: '',
            note: '',
            count: '',
            error: '',
            background: ''
        };

        var rows = [];
        var unusedAttrs = [];
        // Bars on screen, index-aligned with the data-pvx-i on each bar, so
        // the delegated click handler can find the element it stands for.
        var drawn = [];
        var boundHost = null;
        var liveCfg = {};

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-pareto-body',

            onDestroy: function () { unbindHost(); drawn = []; },

            onData: function (d) {
                var cfg = scope.config || {};
                // Parse against the columns we actually asked for. Immediately
                // after a statistic change the in-flight payload may still be
                // the previous aggregate; it is replaced within one refresh, so
                // we prefer a one-frame stale number over dropping the row.
                rows = PVX.data.rows(d, cfg.Columns || columnsFor(cfg)) || [];
                // From an AF search a ranking compares one quantity: the first
                // attribute named. Any others are named in the footer.
                unusedAttrs = [];
                if (PVX.afsource.wanted(cfg)) {
                    var sp = PVX.afsource.split(rows, cfg, 1);
                    if (sp.attrs.length > 1) { rows = sp.byAttr[0]; unusedAttrs = sp.unused; }
                }
            },

            onConfigChange: function (newCfg) {
                // The statistic determines which aggregate PI Vision computes,
                // so the request has to be updated before the next fetch.
                syncColumns(newCfg || scope.config);
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

        /** The charted number for one row, or null when the cell is empty. */
        function statValue(row, cfg) {
            var col = columnFor(cfg);
            var cell = row.summary ? row.summary[col] : null;
            var v = cell ? cell.value : null;
            // Some releases also put the plain current value on the row itself;
            // use it as a fallback so the default statistic never comes back
            // empty just because Summary was omitted.
            if (v === null && col === 'Value') { v = row.value; }
            return v;
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
         * rows + config -> everything the renderer needs.
         * @returns {Object} {items, cum, total, pctBase, notes[], hidden,
         *                    skipped, badCount, allZero, anyNegative, empty}
         */
        function buildModel(cfg) {
            var i;
            var items = [];
            var skipped = 0;     // rows whose chosen statistic is null
            var zeros = 0;       // rows hidden by HideZero
            var badCount = 0;
            var picked = ctx.filter.active();
            var filtered = 0;    // rows hidden by a filter from another symbol

            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (picked && !PVX.filter.matches(picked, r.assetPath || PVX.nav.assetOf(r.path))) { filtered += 1; continue; }
                var v = statValue(r, cfg);
                if (v === null) { skipped += 1; continue; }
                if (cfg.HideZero && v === 0) { zeros += 1; continue; }
                if (!r.good) { badCount += 1; }
                var asset = PVX.nav.assetOf(r.path);
                var elName = asset ? asset.slice(asset.lastIndexOf('\\') + 1) : '';
                items.push({
                    label: (cfg.NameFrom === 'element' && elName) ? elName : (r.label || ('Row ' + (i + 1))),
                    path: r.path || '',
                    asset: asset,
                    units: r.units || '',
                    good: r.good !== false,
                    error: r.errorDescription || '',
                    value: v,
                    index: i,
                    isOther: false,
                    rank: 0
                });
            }

            items.sort(compareBy(cfg.SortMode));

            // --- Top N ----------------------------------------------------
            var hidden = 0;
            var otherCount = 0;
            var topN = Math.max(0, intOr(cfg.TopN, 0));
            if (topN > 0 && items.length > topN) {
                var rest = items.slice(topN);
                items = items.slice(0, topN);
                if (cfg.GroupRemainderAsOther) {
                    var sum = 0, allGood = true;
                    for (i = 0; i < rest.length; i++) {
                        sum += rest[i].value;
                        if (!rest[i].good) { allGood = false; }
                    }
                    otherCount = rest.length;
                    items.push({
                        label: 'Other (' + rest.length + ')',
                        path: '', units: '',
                        // Inherit bad quality: a total built from an untrusted
                        // value is itself untrusted, so it must render hatched.
                        good: allGood,
                        error: '',
                        value: sum,
                        index: 1e9,
                        isOther: true,
                        rank: 0
                    });
                } else {
                    hidden += rest.length;
                }
            }

            // --- hard cap -------------------------------------------------
            // Beyond this the bars are sub-pixel and the SVG node count starts
            // to hurt PI Vision's re-layout on every resize.
            var maxBars = PVX.util.clamp(intOr(cfg.MaxBars, 40), 1, 400);
            if (items.length > maxBars) {
                hidden += items.length - maxBars;
                items = items.slice(0, maxBars);
            }

            // --- totals ---------------------------------------------------
            var total = 0, anyNegative = false, allZero = items.length > 0, absTotal = 0;
            for (i = 0; i < items.length; i++) {
                total += items[i].value;
                absTotal += Math.abs(items[i].value);
                if (items[i].value < 0) { anyNegative = true; }
                if (items[i].value !== 0) { allZero = false; }
            }

            // --- color rank ----------------------------------------------
            // Rank is by magnitude over the *displayed* bars, so the ramp still
            // reads correctly when the list is sorted ascending or by name.
            var byMag = items.slice().sort(function (a, b) {
                return Math.abs(b.value) - Math.abs(a.value);
            });
            for (i = 0; i < byMag.length; i++) { byMag[i].rank = i; }

            // --- cumulative ------------------------------------------------
            // A running percentage of a mixed-sign total is meaningless (it can
            // exceed 100% then come back down), so the Pareto line is dropped
            // rather than drawn misleadingly.
            var cum = null;
            var cumSuppressed = false;
            if (cfg.ShowCumulative && items.length) {
                if (anyNegative || total <= 0) {
                    cumSuppressed = true;
                } else {
                    cum = [];
                    var run = 0;
                    for (i = 0; i < items.length; i++) {
                        run += items[i].value;
                        cum.push((run / total) * 100);
                    }
                }
            }

            // --- notes -----------------------------------------------------
            var notes = [];
            if (filtered) { notes.push(filtered + (filtered === 1 ? ' bar' : ' bars') + ' hidden by the filter (' + picked.label + ')'); }
            if (skipped) {
                notes.push(skipped + (skipped === 1 ? ' source has no ' : ' sources have no ') +
                    statLabel(cfg).toLowerCase());
            }
            if (zeros) {
                notes.push(zeros + (zeros === 1 ? ' zero value hidden' : ' zero values hidden'));
            }
            if (hidden) { notes.push('+' + hidden + ' more not shown'); }
            if (otherCount) { notes.push('Other = ' + otherCount + ' remaining combined'); }
            if (unusedAttrs.length) { notes.push('ranks ' + PVX.afsource.attributes(cfg.SearchAttributes)[0] + '; not used: ' + unusedAttrs.join(', ')); }
            if (cumSuppressed) {
                notes.push(anyNegative
                    ? 'Cumulative % hidden: values include negatives'
                    : 'Cumulative % hidden: total is not positive');
            }
            if (cum && cfg.SortMode !== 'valueDesc') {
                notes.push('Cumulative follows display order');
            }
            if (allZero) { notes.push('All values are zero'); }

            return {
                items: items,
                cum: cum,
                total: total,
                sources: rows.length,
                // Percent-of-total uses absolute magnitudes when signs are
                // mixed, otherwise a -50 in a total of 0 produces nonsense.
                pctBase: anyNegative ? absTotal : total,
                notes: notes,
                hidden: hidden,
                skipped: skipped,
                badCount: badCount,
                allZero: allZero,
                anyNegative: anyNegative,
                empty: items.length === 0
            };
        }

        /* ================================================================ *
         * Text helpers
         * ================================================================ */

        /**
         * Approximate rendered width. Measuring properly means inserting the
         * text, forcing a layout and reading getComputedTextLength() once per
         * label — far too expensive for 40 bars on every resize frame. 0.58em
         * is the average advance of Segoe UI/Roboto at small sizes.
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
         * Why measure here when textPx()'s 0.58em estimate is good enough for
         * the value/tick labels: those are numeric, centre- or start-anchored,
         * and a few pixels of error only shifts them. Category names are
         * end-anchored against the left edge of the symbol, so an estimate that
         * runs narrow (mixed-case proper nouns — "Feedwater Pump B" — average
         * well above 0.58em) pushes the string's start off-canvas, where the
         * host's overflow:hidden chops the first glyph instead of ellipsising.
         * There is no clamp that can save it after the fact: the text has to be
         * short enough. Cost is one forced layout per name, bounded by MaxBars
         * bars per render, which is affordable at this cadence — it is not
         * affordable for the per-frame label sizing that feeds the layout maths.
         *
         * The caller passes text already cut by the estimate, so the common case
         * measures once and returns. When it does not, each pass takes a
         * proportional bite out of the measured overshoot rather than walking a
         * character at a time, so it converges in one or two more measurements.
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

        function valueLabel(item, cfg, pctBase) {
            var s = PVX.fmt.number(item.value, PVX.config.numberOpts(cfg));
            if (cfg.ShowPercentOfTotal && pctBase > 0) {
                s += ' (' + Math.round((Math.abs(item.value) / pctBase) * 100) + '%)';
            }
            return s;
        }

        /* ================================================================ *
         * Color
         * ================================================================ */

        function barColor(item, model, cfg, t) {
            var base = cfg.BarColor || '#3b82c4';
            switch (cfg.ColorMode) {
                case 'palette':
                    return PVX.color.categorical[item.rank % PVX.color.categorical.length];
                case 'threshold':
                    // Falls back to the flat color when thresholds are off, so
                    // the mode never silently paints everything one band color.
                    return cfg.UseThresholds
                        ? PVX.thresholds.colorFor(cfg.Thresholds, item.value, base)
                        : base;
                case 'rank':
                    return rankColor(item, model.items.length, cfg, t);
                case 'single':
                default:
                    return base;
            }
        }

        /** Accent -> muted accent ramp; the biggest contributor stays darkest. */
        function rankColor(item, n, cfg, t) {
            var accent = cfg.AccentColor || '#3b82c4';
            // Mixing toward the surface (not toward grey) keeps the ramp in the
            // same hue family in both light and dark themes.
            var weak = PVX.color.mix(accent, t.dark ? '#2b3037' : '#eef2f6', 0.66);
            var f = n <= 1 ? 0 : item.rank / (n - 1);
            return PVX.color.mix(accent, weak, f);
        }

        /**
         * Hatched fill for bad quality. Operators must be able to see at a
         * glance that a bar's height is not trustworthy, and a solid bar in a
         * "stale" color still reads as a real measurement.
         * One pattern per color per render; ids are unique so several symbol
         * instances on one display cannot collide.
         */
        function hatchFor(defs, cache, fill) {
            if (cache[fill]) { return cache[fill]; }
            var id = PVX.util.uid('pvxhatch');
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
            syncColumns(cfg);

            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;
            liveCfg = cfg;
            bindHost(host);
            drawn = [];

            var W = Math.max(40, c.width);
            var H = Math.max(30, c.height);

            var svgRoot = host.querySelector('svg.pvx-pareto-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-pareto-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var model = buildModel(cfg);

            // ---- chrome -----------------------------------------------------
            scope.pvx.title = cfg.Title || 'Ranked comparison';
            scope.pvx.subtitle = statLabel(cfg) + commonUnitsSuffix(cfg, model);
            scope.pvx.note = model.notes.join(' · ');
            // "8 of 40 sources" whenever bars stand for fewer rows than were
            // returned — Top N grouping and the MaxBars cap both cause that.
            scope.pvx.count = model.items.length
                ? ((model.items.length < model.sources
                        ? model.items.length + ' of ' + model.sources
                        : String(model.items.length)) +
                   (model.sources === 1 ? ' source' : ' sources'))
                : '';
            scope.pvx.error = model.badCount
                ? (model.badCount + (model.badCount === 1 ? ' source reports' : ' sources report') + ' bad quality')
                : '';

            if (model.empty) {
                emptyState(svgRoot, W, H, t,
                    rows.length ? 'No ' + statLabel(cfg).toLowerCase() + ' values' : 'No data sources',
                    rows.length
                        ? 'All ' + rows.length + ' sources returned an empty cell.'
                        : 'Drop one or more attributes onto this symbol.');
                digest();
                return;
            }

            drawChart(svgRoot, W, H, cfg, t, model);
            digest();
        }

        /* ================================================================ *
         * Click-through: one delegated listener, so redrawing the SVG on every
         * update never has to re-register per-bar handlers.
         * ================================================================ */
        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            host.addEventListener('click', onClick, false);
            boundHost = host;
        }

        function unbindHost() {
            if (!boundHost) { return; }
            boundHost.removeEventListener('click', onClick, false);
            boundHost = null;
        }

        function onClick(ev) {
            if (liveCfg.ClickAction !== 'navigate' && liveCfg.ClickAction !== 'filter') { return; }
            var node = ev.target, guard = 0;
            while (node && node !== boundHost && guard < 8) {
                var raw = node.getAttribute ? node.getAttribute('data-pvx-i') : null;
                if (raw !== null && raw !== undefined) {
                    var it = drawn[parseInt(raw, 10)];
                    if (liveCfg.ClickAction === 'filter') {
                        // "Other" stands for several assets, so it filters nothing.
                        if (it && !it.isOther && it.asset) {
                            PVX.filter.toggle(PVX.filter.channel(liveCfg), it.asset, it.asset.slice(it.asset.lastIndexOf('\\') + 1),
                                liveCfg.Title || 'the Ranked Bar');
                        }
                        return;
                    }
                    var target = String(liveCfg.NavigateTarget || '').trim();
                    // "Other" stands for several elements, so it goes nowhere.
                    if (!it || it.isOther || (!target && !it.asset)) { return; }
                    PVX.nav.go(PVX.nav.url({
                        display: target || undefined,
                        asset: it.asset || undefined
                    }), false);
                    return;
                }
                node = node.parentNode;
                guard += 1;
            }
        }

        /** Units are only meaningful in the header when every row agrees. */
        function commonUnitsSuffix(cfg, model) {
            if (!cfg.ShowUnits) { return ''; }
            var u = null;
            for (var i = 0; i < model.items.length; i++) {
                if (model.items[i].isOther) { continue; }
                var iu = model.items[i].units || '';
                if (u === null) { u = iu; }
                else if (u !== iu) { return ''; }
            }
            return u ? ' · ' + u : '';
        }

        function drawChart(svgRoot, W, H, cfg, t, model) {
            var i;
            var items = model.items;
            var n = items.length;
            var horiz = cfg.Orientation !== 'vertical';
            var defs = PVX.svg.el('defs', null, svgRoot);
            var hatchCache = {};

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 24), 8, 12);
            var pad = 5;

            // ---- value domain ------------------------------------------------
            // Zero is always inside the domain, which is what puts the baseline
            // at zero (not at the edge) when the data spans both signs.
            var lo = 0, hi = 0;
            for (i = 0; i < n; i++) {
                if (items[i].value < lo) { lo = items[i].value; }
                if (items[i].value > hi) { hi = items[i].value; }
            }
            if (lo === hi) { hi = lo + 1; }   // all-zero (or single zero) data
            var tickCount = PVX.util.clamp(parseInt(cfg.TickCount, 10) || 5, 2, 12);
            var dom = PVX.scale.niceDomain(lo, hi, tickCount);
            var ticks = cfg.ShowGrid || cfg.ShowAxis ? PVX.scale.ticks(dom[0], dom[1], tickCount) : [];

            var showCum = !!model.cum;
            var cumTicks = showCum && cfg.ShowAxis ? PVX.scale.ticks(0, 100, PVX.util.clamp(tickCount, 2, 6)) : [];
            var cumColor = cfg.CumulativeColor || '#c8452f';

            // ---- label widths (heuristic, see textPx) -------------------------
            var valuePos = cfg.ShowValues ? (cfg.ValuePosition || 'end') : 'none';
            var maxValuePx = 0;
            var labels = [];
            for (i = 0; i < n; i++) {
                labels.push(valuePos === 'none' ? '' : valueLabel(items[i], cfg, model.pctBase));
                maxValuePx = Math.max(maxValuePx, textPx(labels[i], font));
            }
            var maxTickPx = 0;
            for (i = 0; i < ticks.length; i++) {
                maxTickPx = Math.max(maxTickPx, textPx(PVX.fmt.tick(ticks[i]), font));
            }
            var maxCumTickPx = 0;
            for (i = 0; i < cumTicks.length; i++) {
                maxCumTickPx = Math.max(maxCumTickPx, textPx(cumTicks[i] + '%', font));
            }

            // ---- plot box ------------------------------------------------------
            var mLeft = pad, mRight = pad, mTop = pad, mBottom = pad;
            var nameW = 0;
            var rotateNames = false;

            if (horiz) {
                nameW = PVX.util.clamp(W * (PVX.util.num(cfg.NameWidthPct) || 28) / 100, 26, W * 0.55);
                mLeft += nameW + 6;
                if (cfg.ShowAxis) { mBottom += font * 1.9; }          // value ticks below
                if (showCum && cfg.ShowAxis) { mTop += font * 1.9; }  // % ticks above
                if (valuePos === 'end') { mRight += maxValuePx + 8; }
            } else {
                if (cfg.ShowAxis) { mLeft += maxTickPx + 8; }
                if (showCum && cfg.ShowAxis) { mRight += maxCumTickPx + 8; }
                if (valuePos === 'end') { mTop += font * 1.5; }
            }

            var plot = { x0: mLeft, y0: mTop, x1: W - mRight, y1: H - mBottom };

            if (!horiz) {
                // Name band height depends on whether names fit upright, which
                // depends on the slot width — so it is resolved after the
                // horizontal margins but before the vertical ones are final.
                var slotW = (plot.x1 - plot.x0) / Math.max(1, n);
                rotateNames = slotW < font * 4.5;
                // A 45-degree label needs vertical room proportional to its
                // length; this band is what the truncation below is measured
                // against, so the two must be changed together.
                mBottom += rotateNames ? font * 4.2 : font * 1.9;
                plot.y1 = H - mBottom;
            }

            // Degenerate boxes (tiny symbol, huge labels): give the chart the
            // whole frame rather than drawing nothing at all.
            if (plot.x1 - plot.x0 < 16) { plot.x0 = pad; plot.x1 = W - pad; nameW = 0; }
            if (plot.y1 - plot.y0 < 16) { plot.y0 = pad; plot.y1 = H - pad; }

            var plotW = plot.x1 - plot.x0;
            var plotH = plot.y1 - plot.y0;

            // ---- scales ----------------------------------------------------------
            var vs = horiz
                ? PVX.scale.linear(dom[0], dom[1], plot.x0, plot.x1)
                : PVX.scale.linear(dom[0], dom[1], plot.y1, plot.y0);
            var zero = vs(0);
            var cs = showCum
                ? (horiz ? PVX.scale.linear(0, 100, plot.x0, plot.x1)
                         : PVX.scale.linear(0, 100, plot.y1, plot.y0))
                : null;

            // ---- category slots ---------------------------------------------------
            var catStart = horiz ? plot.y0 : plot.x0;
            var catSpan = horiz ? plotH : plotW;
            var slot = catSpan / n;
            var gap = PVX.util.clamp(PVX.util.num(cfg.BarGap) === null ? 0.25 : PVX.util.num(cfg.BarGap), 0, 0.9);
            // A single row would otherwise produce one bar as thick as the whole
            // symbol, which reads as a background block rather than a bar.
            var thick = Math.max(1, Math.min(slot * (1 - gap), Math.max(18, catSpan * 0.4)));
            var center = function (idx) { return catStart + slot * (idx + 0.5); };

            var barRadius = PVX.util.clamp(PVX.util.num(cfg.CornerRadius) || 0, 0, Math.min(4, thick / 3));

            // Where does a negative bar's "end" label go? Outside the bar is the
            // natural place, but that runs into the name column (horizontal) or
            // the name band (vertical). Decide once for the whole chart: labels
            // that jump sides bar-by-bar are harder to scan than labels that are
            // all on the "wrong" side together.
            var flipNegLabels = false;
            if (valuePos === 'end') {
                for (i = 0; i < n; i++) {
                    if (items[i].value >= 0) { continue; }
                    var np = vs(items[i].value);
                    if (horiz) {
                        if (np - (textPx(labels[i], font) + 8) < plot.x0) { flipNegLabels = true; break; }
                    } else if (np + font * 0.9 > plot.y1) {
                        flipNegLabels = true; break;
                    }
                }
            }

            // ---- grid + zero line ---------------------------------------------------
            var g;
            if (cfg.ShowGrid) {
                g = PVX.svg.el('g', { 'class': 'pvx-pareto-grid pvx-grid-line', stroke: t.grid }, svgRoot);
                for (i = 0; i < ticks.length; i++) {
                    var tp = vs(ticks[i]);
                    PVX.svg.el('line', horiz
                        ? { x1: tp.toFixed(2), y1: plot.y0.toFixed(2), x2: tp.toFixed(2), y2: plot.y1.toFixed(2) }
                        : { x1: plot.x0.toFixed(2), y1: tp.toFixed(2), x2: plot.x1.toFixed(2), y2: tp.toFixed(2) },
                        g);
                }
            }

            // The baseline is where zero is, which is only the plot edge when
            // the data is single-signed.
            PVX.svg.el('line', horiz
                ? { x1: zero.toFixed(2), y1: plot.y0.toFixed(2), x2: zero.toFixed(2), y2: plot.y1.toFixed(2) }
                : { x1: plot.x0.toFixed(2), y1: zero.toFixed(2), x2: plot.x1.toFixed(2), y2: zero.toFixed(2) },
                svgRoot).setAttribute('stroke', t.axis);

            // ---- 80% reference line ---------------------------------------------------
            // Lives on the cumulative axis, so it only exists when that axis does.
            if (showCum && cfg.ShowEightyLine) {
                var ev = PVX.util.clamp(PVX.util.num(cfg.EightyLineValue) === null ? 80 : PVX.util.num(cfg.EightyLineValue), 0, 100);
                var ep = cs(ev);
                var eLine = PVX.svg.el('line', horiz
                    ? { x1: ep.toFixed(2), y1: plot.y0.toFixed(2), x2: ep.toFixed(2), y2: plot.y1.toFixed(2) }
                    : { x1: plot.x0.toFixed(2), y1: ep.toFixed(2), x2: plot.x1.toFixed(2), y2: ep.toFixed(2) },
                    svgRoot);
                eLine.setAttribute('class', 'pvx-pareto-eighty');
                eLine.setAttribute('stroke', cumColor);
                eLine.setAttribute('stroke-width', '1');
                eLine.setAttribute('stroke-dasharray', '4 3');
                eLine.setAttribute('opacity', '0.75');
            }

            // ---- bars ----------------------------------------------------------------
            var barsG = PVX.svg.el('g', { 'class': 'pvx-pareto-bars' }, svgRoot);
            for (i = 0; i < n; i++) {
                var it = items[i];
                var p = vs(it.value);
                var col = barColor(it, model, cfg, t);
                var fill = it.good ? col : hatchFor(defs, hatchCache, col);
                var cCoord = center(i);

                var x, y, w, h;
                if (horiz) {
                    x = Math.min(zero, p);
                    // Keep a hairline for exact zeros so the category still has
                    // a visible anchor next to its name.
                    w = Math.max(1, Math.abs(p - zero));
                    y = cCoord - thick / 2;
                    h = thick;
                } else {
                    y = Math.min(zero, p);
                    h = Math.max(1, Math.abs(p - zero));
                    x = cCoord - thick / 2;
                    w = thick;
                }

                var filtering = cfg.ClickAction === 'filter';
                var clickable = !it.isOther && (filtering ? !!it.asset
                    : cfg.ClickAction === 'navigate' && !!(it.asset || String(cfg.NavigateTarget || '').trim()));
                var isPicked = filtering && PVX.filter.isPicked(PVX.filter.channel(cfg), it.asset);
                drawn[i] = it;
                var grp = PVX.svg.el('g', {
                    'class': 'pvx-pareto-bar' + (clickable ? ' pvx-pareto-click' : '') + (isPicked ? ' pvx-pareto-picked' : ''),
                    'data-pvx-i': String(i)
                }, barsG);
                PVX.svg.el('rect', {
                    x: x.toFixed(2), y: y.toFixed(2),
                    width: w.toFixed(2), height: h.toFixed(2),
                    rx: barRadius ? barRadius.toFixed(1) : null,
                    fill: fill,
                    stroke: it.good ? 'none' : col,
                    'stroke-width': it.good ? null : 0.8
                }, grp);

                // Full name + value live in a <title>: the truncated label is a
                // display compromise, the tooltip is the source of truth.
                var tip = PVX.svg.el('title', null, grp);
                tip.textContent = it.label +
                    ' — ' + PVX.fmt.number(it.value, PVX.config.numberOpts(cfg)) +
                    (it.units ? ' ' + it.units : '') +
                    (model.cum ? ' · cumulative ' + model.cum[i].toFixed(1) + '%' : '') +
                    (it.good ? '' : ' · BAD QUALITY' + (it.error ? ': ' + it.error : '')) +
                    (it.path ? '\n' + it.path : '');

                // ---- value label -------------------------------------------------
                if (valuePos !== 'none' && labels[i]) {
                    drawValueLabel(svgRoot, cfg, t, {
                        horiz: horiz, pos: valuePos, text: labels[i], font: font,
                        x: x, y: y, w: w, h: h, positive: it.value >= 0,
                        center: cCoord, fillOnBar: col, frameW: W, plot: plot,
                        flipNeg: flipNegLabels
                    });
                }
            }

            // ---- category names --------------------------------------------------------
            var namesG = PVX.svg.el('g', { 'class': 'pvx-pareto-names' }, svgRoot);
            for (i = 0; i < n; i++) {
                var name = items[i].label;
                var cc = center(i);
                if (horiz) {
                    if (slot < font * 1.1) { break; }   // no room for any legible name
                    // Budget is the name column, but never more than the room
                    // between the anchor and the frame edge.
                    var nameAvail = Math.min(nameW - 4, plot.x0 - 7);
                    var nt = PVX.svg.text(namesG, (plot.x0 - 6).toFixed(2), cc.toFixed(2),
                        truncate(name, nameAvail, font), {
                            'class': 'pvx-svg-label pvx-pareto-name',
                            'text-anchor': 'end', 'font-size': font, fill: t.textMuted
                        });
                    // Estimate first (above) so this measurement almost always
                    // confirms rather than corrects — see fitTextTo.
                    fitTextTo(nt, nameAvail);
                    PVX.svg.el('title', null, nt).textContent = name;
                } else {
                    if (slot < font * 0.75) { break; }
                    var ny = plot.y1 + font * 1.2;
                    var vt;
                    if (rotateNames) {
                        // -45 degrees keeps long names readable without the
                        // vertical-text guessing game. The text runs down-left
                        // from its anchor, so its length is bounded by the room
                        // below the plot *and* the room to the left edge —
                        // times sqrt(2) because it is on the diagonal.
                        var availV = H - ny - 2;
                        var availX = cc - 2;
                        var diag = Math.max(0, Math.min(availV, availX)) * 1.414;
                        vt = PVX.svg.text(namesG, 0, 0,
                            truncate(name, diag, font), {
                            'class': 'pvx-svg-label pvx-pareto-name',
                            'text-anchor': 'end', 'font-size': font, fill: t.textMuted,
                            transform: 'translate(' + cc.toFixed(2) + ',' + ny.toFixed(2) + ') rotate(-45)'
                        });
                        // Same failure mode as the horizontal names: end-anchored
                        // on the diagonal, so an under-estimate runs off the
                        // bottom-left corner. getComputedTextLength() is measured
                        // along the (rotated) baseline, which is exactly the
                        // diagonal budget above.
                        fitTextTo(vt, diag);
                    } else {
                        vt = PVX.svg.text(namesG, cc.toFixed(2), ny.toFixed(2),
                            truncate(name, slot * 1.05, font), {
                                'class': 'pvx-svg-label pvx-pareto-name',
                                'text-anchor': 'middle', 'font-size': font, fill: t.textMuted
                            });
                        fitTextTo(vt, slot * 1.05);
                    }
                    PVX.svg.el('title', null, vt).textContent = name;
                }
            }

            // ---- value axis ticks --------------------------------------------------------
            if (cfg.ShowAxis) {
                var axisG = PVX.svg.el('g', { 'class': 'pvx-pareto-axis' }, svgRoot);
                for (i = 0; i < ticks.length; i++) {
                    var q = vs(ticks[i]);
                    if (horiz) {
                        PVX.svg.text(axisG, q.toFixed(2), (plot.y1 + font * 1.1).toFixed(2),
                            PVX.fmt.tick(ticks[i]), {
                                'class': 'pvx-svg-label', 'text-anchor': 'middle',
                                'font-size': font, fill: t.textMuted
                            });
                    } else {
                        PVX.svg.text(axisG, (plot.x0 - 5).toFixed(2), q.toFixed(2),
                            PVX.fmt.tick(ticks[i]), {
                                'class': 'pvx-svg-label', 'text-anchor': 'end',
                                'font-size': font, fill: t.textMuted
                            });
                    }
                }
            }

            // ---- cumulative line ------------------------------------------------------------
            if (showCum) {
                var pts = [];
                for (i = 0; i < n; i++) {
                    pts.push(horiz
                        ? { x: cs(model.cum[i]), y: center(i) }
                        : { x: center(i), y: cs(model.cum[i]) });
                }

                var lineG = PVX.svg.el('g', { 'class': 'pvx-pareto-cum' }, svgRoot);
                if (pts.length > 1) {
                    PVX.svg.el('path', {
                        d: PVX.svg.line(pts, false),
                        fill: 'none',
                        stroke: cumColor,
                        'stroke-width': 1.6,
                        'stroke-linejoin': 'round',
                        'stroke-linecap': 'round'
                    }, lineG);
                }
                for (i = 0; i < pts.length; i++) {
                    var mk = PVX.svg.el('circle', {
                        cx: pts[i].x.toFixed(2), cy: pts[i].y.toFixed(2),
                        r: Math.max(1.8, Math.min(3, thick * 0.18)).toFixed(1),
                        fill: cumColor,
                        stroke: t.surface === 'transparent' ? 'none' : t.surface,
                        'stroke-width': 0.8
                    }, lineG);
                    PVX.svg.el('title', null, mk).textContent =
                        items[i].label + ' · cumulative ' + model.cum[i].toFixed(1) + '%';
                }

                // Secondary axis on the opposite side, in its own color so it
                // is never mistaken for the value axis.
                for (i = 0; i < cumTicks.length; i++) {
                    var cq = cs(cumTicks[i]);
                    if (horiz) {
                        PVX.svg.text(svgRoot, cq.toFixed(2), (plot.y0 - font * 0.9).toFixed(2),
                            cumTicks[i] + '%', {
                                'class': 'pvx-svg-label pvx-pareto-cumtick', 'text-anchor': 'middle',
                                'font-size': font * 0.92, fill: cumColor
                            });
                    } else {
                        PVX.svg.text(svgRoot, (plot.x1 + 5).toFixed(2), cq.toFixed(2),
                            cumTicks[i] + '%', {
                                'class': 'pvx-svg-label pvx-pareto-cumtick', 'text-anchor': 'start',
                                'font-size': font * 0.92, fill: cumColor
                            });
                    }
                }
            }
        }

        /**
         * Place one value label. 'inside' silently degrades to 'end' when the
         * bar is too short to hold the text — a clipped number is worse than a
         * number that moved.
         */
        function drawValueLabel(svgRoot, cfg, t, o) {
            var need = textPx(o.text, o.font) + 8;
            var pos = o.pos;
            if (pos === 'inside' && (o.horiz ? o.w : o.h) < need) { pos = 'end'; }

            var x, y, anchor, fill;
            if (o.horiz) {
                y = o.center;
                if (pos === 'inside') {
                    x = o.positive ? o.x + o.w - 4 : o.x + 4;
                    anchor = o.positive ? 'end' : 'start';
                    fill = PVX.color.readable(o.fillOnBar);
                } else if (o.positive) {
                    x = o.x + o.w + 4;
                    anchor = 'start';
                    fill = t.text;
                } else if (o.flipNeg) {
                    // No room left of the negative bars without colliding with
                    // the name column, so they all label on the empty positive
                    // side of the baseline instead.
                    x = o.x + o.w + 4;
                    anchor = 'start';
                    fill = t.text;
                } else {
                    x = o.x - 4;
                    anchor = 'end';
                    fill = t.text;
                }
            } else {
                x = o.center;
                anchor = 'middle';
                if (pos === 'inside') {
                    y = o.positive ? o.y + o.font * 0.9 : o.y + o.h - o.font * 0.9;
                    fill = PVX.color.readable(o.fillOnBar);
                } else if (o.positive) {
                    y = o.y - o.font * 0.7;
                    fill = t.text;
                } else {
                    // Below a negative bar, unless that lands in the name band —
                    // then all negative labels sit just above the baseline.
                    y = o.flipNeg ? o.y - o.font * 0.7 : o.y + o.h + o.font * 0.7;
                    fill = t.text;
                }
            }

            // Keep the text inside the frame; an off-canvas label is a silent
            // data loss for whoever is reading the display.
            x = PVX.util.clamp(x, 2, Math.max(2, o.frameW - 2));
            PVX.svg.text(svgRoot, x.toFixed(2), y.toFixed(2), o.text, {
                'class': 'pvx-svg-value pvx-num pvx-pareto-value',
                'text-anchor': anchor,
                'font-size': o.font,
                fill: fill
            });
        }

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);

            // Centre-anchored text spills past BOTH edges once it is wider than
            // the frame, so shrink to fit first and only then truncate. Same
            // 0.58em glyph estimate used for the category labels.
            // 0.62em rather than the 0.58em used for tick labels: this copy is
            // sentence case with wide glyphs, and a centred line that guesses
            // narrow overshoots on both sides at once.
            var avail = Math.max(24, W - 12);
            var longest = Math.max(String(headline).length, String(detail).length);
            if (longest * font * 0.62 > avail) {
                font = PVX.util.clamp(Math.floor(avail / (longest * 0.62)), 7, font);
            }
            var fitLine = function (str, px) {
                var maxChars = Math.max(3, Math.floor(avail / (px * 0.62)));
                return str.length > maxChars ? str.slice(0, maxChars - 1) + '…' : str;
            };

            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2), fitLine(headline, font), {
                'class': 'pvx-svg-label pvx-pareto-emptymsg', 'text-anchor': 'middle',
                'font-size': font, 'font-weight': '600', fill: t.textMuted
            });
            var sub = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.8).toFixed(2), fitLine(detail, font * 0.85), {
                'class': 'pvx-svg-label pvx-pareto-emptymsg', 'text-anchor': 'middle',
                'font-size': (font * 0.85).toFixed(1), fill: t.textMuted
            });

            // The glyph-width estimate is good enough for hundreds of per-frame
            // bar labels but can be a few pixels out. This runs at most twice,
            // only when there is nothing to chart, so an exact measurement is
            // affordable here — and a centred message that pokes out of both
            // edges is the most obviously broken thing a symbol can show.
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
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            var w = measure();
            if (!(w > avail)) { return; }

            var size = parseFloat(node.getAttribute('font-size')) || 10;
            var scaled = Math.max(6, size * (avail / w));
            node.setAttribute('font-size', scaled.toFixed(1));

            w = measure();
            if (!(w > avail)) { return; }

            // Still too wide at the floor — drop characters proportionally, then
            // shave one at a time (at most a handful of iterations).
            var str = node.textContent;
            var keep = Math.max(3, Math.floor(str.length * (avail / w)) - 1);
            node.textContent = str.slice(0, keep) + '…';
            for (var guard = 0; guard < 24 && measure() > avail && node.textContent.length > 2; guard++) {
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
