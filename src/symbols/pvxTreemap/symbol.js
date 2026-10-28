/* ============================================================================
 * pvxTreemap — squarified treemap for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 *
 * The question this symbol answers is "which of my hundred tags is both BIG and
 * IN TROUBLE". A ranked bar chart runs out of vertical room somewhere around
 * thirty rows; a treemap keeps going because it spends area instead of height.
 *
 * The colour dimension is what makes it more than a fancy bar chart: size shows
 * who is big, colour shows who is in trouble, and the tile that is both is the
 * one to look at first.
 *
 * WHY SQUARIFIED
 *   The naive "slice and dice" treemap alternates the split direction per level
 *   and produces slivers — 400px x 3px tiles that cannot be labelled, cannot be
 *   clicked and cannot be compared to each other by eye. Squarified layout
 *   (Bruls, Huizing & van Wijk, 1999) greedily fills the current rectangle with
 *   rows of tiles, extending a row only while the worst aspect ratio in it
 *   improves. That keeps tiles near square, which is the only reason a treemap
 *   is readable at all. See squarify() for the aspect-ratio test itself.
 *
 * COLUMN SYNC
 *   PI Vision returns Summary cells positionally, matching config.Columns, so
 *   the chosen statistic must drive that array or the symbol silently sizes
 *   tiles by the wrong aggregate. All of that lives in the shared helpers
 *   (PVX.config.statColumns / syncStatColumns / PVX.data.statValue), called
 *   from onConfigChange AND from the top of render so a display saved by an
 *   older build repairs itself on load.
 *
 * HONESTY RULES
 *   - Area cannot represent a negative or zero value. Those rows are excluded
 *     and NAMED in the footer; silently dropping a tag is how a display lies.
 *   - Tiles too small to label are merged into one "Other" tile rather than
 *     drawn as unreadable slivers, and the footer says how many went in.
 *   - Bad-quality rows keep their share of the plant and are drawn hatched.
 *   - Every label is measured with getComputedTextLength() before it is kept.
 *     Glyph-width estimation has been a real source of overflow bugs here.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxTreemap',
        displayName: 'PVX Treemap',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // A collection would repeat the whole treemap per asset, which defeats
        // the purpose: the comparison across assets IS the treemap.
        supportsCollections: false,
        configTitle: 'Format Treemap',

        getDefaultConfig: function () {
            // An AF search can supply the rows instead (PVX.afsource); off by default.
            return window.PVX.afsource.defaults(window.PVX.config.base({
                DataShape: 'Table',
                // Positional contract with PI Vision's Summary cells; kept in
                // step with Statistic by PVX.config.syncStatColumns().
                Columns: ['Value'],
                SortColumn: 'Value',
                SortDescending: true,
                Height: 300,
                Width: 480,

                Title: '',                  // blank => generic heading

                // --- what is sized -----------------------------------
                Statistic: 'Value',         // Value|Average|Minimum|Maximum|Range|StdDev|Total

                // --- hierarchy ---------------------------------------
                // PI hands us a flat list, so hierarchy has to come out of the
                // tag name or the AF path.
                GroupBy: 'none',            // none | delimiter | prefix | parent
                GroupDelimiter: '\\',
                GroupDepth: 1,
                GroupPrefixChars: 3,

                // --- colour ------------------------------------------
                ColorMode: 'threshold',     // threshold | value | palette | group | single
                SingleColor: '#3b82c4',
                ShowColorLegend: true,

                // --- readability -------------------------------------
                MinTilePx: 26,
                ShowOther: true,
                OtherLabel: 'Other',
                MaxTiles: 60,

                // --- labels ------------------------------------------
                ShowValues: true,
                ShowPercent: false,
                LabelMode: 'auto',          // auto | nameOnly | valueOnly | both

                // --- tiles -------------------------------------------
                TilePadding: 2,
                TileRadius: 2,
                ShowBorders: true,

                // --- interaction -------------------------------------
                ClickAction: 'none',        // none | navigate | drill
                NavigateTarget: ''
            }));
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; every tile is SVG.
        scope.pvx = {
            title: '', subtitle: '', note: '', count: '', error: '',
            background: '', showHeader: false, showFooter: false,
            // Drill-down trail: "All > Station 1". A click goes back up.
            crumbs: [],
            crumb: function () { focus = null; ctx.render(); }
        };

        var rows = [];
        // The group a click drilled into, or null for every group.
        var focus = null;
        // From an AF search with two attributes or more: the second colours
        // the tiles (by asset path), and any after that are named as unused.
        var colorRows = null;
        var colorAttr = '';
        var unusedAttrs = [];
        // Tiles currently on screen, in draw order. The click handler maps a
        // tile index back through this array, so it must stay in sync.
        var view = [];
        var boundHost = null;
        var liveCfg = {};

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-tm-body',

            onData: function (d) {
                // Parse against exactly the column the chosen statistic asks
                // for — see PVX.config.statColumns.
                var cfg = scope.config || {};
                rows = PVX.data.rows(d, PVX.config.statColumns(cfg)) || [];
                colorRows = null;
                colorAttr = '';
                unusedAttrs = [];
                if (PVX.afsource.wanted(cfg)) {
                    var sp = PVX.afsource.split(rows, cfg, 2);
                    if (sp.attrs.length > 1) {
                        // Size from one quantity, colour from another: load by
                        // efficiency, say. Paired by asset, never by position.
                        rows = sp.byAttr[0];
                        colorAttr = sp.attrs[1];
                        colorRows = {};
                        for (var i = 0; i < sp.byAttr[1].length; i++) {
                            colorRows[String(sp.byAttr[1][i].assetPath).toLowerCase()] = sp.byAttr[1][i];
                        }
                        unusedAttrs = sp.unused;
                    }
                }
            },

            onConfigChange: function (newCfg) {
                // The statistic decides which aggregate PI Vision computes, so
                // the request has to be corrected before the next fetch.
                PVX.config.syncStatColumns(newCfg || scope.config);
            },

            render: render,

            onDestroy: function () {
                unbindHost();
                view = [];
            }
        });

        /* ================================================================ *
         * Small numeric helpers
         * ================================================================ */

        function numIn(v, lo, hi, fallback) {
            var n = PVX.util.num(v);
            if (n === null) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        function intIn(v, lo, hi, fallback) {
            var n = parseInt(v, 10);
            if (!isFinite(n)) { return fallback; }
            return Math.round(PVX.util.clamp(n, lo, hi));
        }

        function byValueDesc(a, b) {
            return (b.value - a.value) || (a.index - b.index);
        }

        /* ================================================================ *
         * Grouping — hierarchy recovered from the tag name or the AF path
         * ================================================================ */

        /** Group key for one row, or null when grouping is off. */
        function groupOf(row, cfg) {
            var mode = cfg.GroupBy || 'none';

            if (mode === 'prefix') {
                var chars = intIn(cfg.GroupPrefixChars, 1, 24, 3);
                var name = String(row.label || '').trim();
                return name ? name.slice(0, chars) : 'Ungrouped';
            }

            if (mode === 'parent') {
                // The AF hierarchy itself: the element one level up. From an
                // AF search the row says so; from a dropped attribute it is
                // read off the attribute's path.
                if (row.parent) { return row.parent; }
                var el = PVX.nav.parentOf(PVX.nav.assetOf(row.path));
                return el ? el.slice(el.lastIndexOf('\\') + 1) : 'Ungrouped';
            }

            if (mode === 'delimiter') {
                var delim = cfg.GroupDelimiter;
                if (delim === undefined || delim === null || delim === '') { delim = '\\'; }
                // The AF path is the real hierarchy; fall back to the tag name
                // so a display built on plain PI points still groups on
                // something rather than collapsing to one box.
                var src = String(row.path || row.label || '');
                var parts = src.split(String(delim));
                var segs = [];
                for (var i = 0; i < parts.length; i++) {
                    if (parts[i] !== '') { segs.push(parts[i]); }
                }
                if (!segs.length) { return 'Ungrouped'; }
                var depth = intIn(cfg.GroupDepth, 1, 12, 1);
                // Asking for a level deeper than this particular path goes:
                // the last real segment is the most specific honest answer,
                // and it beats lumping half the plant into "Ungrouped".
                return segs[Math.min(depth, segs.length) - 1];
            }

            return null;
        }

        /* ================================================================ *
         * Pure model — no DOM, no drawing decisions
         * ================================================================ *
         * @returns {Object} {items, groups, total, notes[], excluded[],
         *                    skipped, badCount, hidden, empty, headline, detail}
         */
        function buildModel(cfg, maxTiles, grouped) {
            var i;
            var items = [];
            var excluded = [];   // named in the footer — never silently dropped
            var skipped = 0;     // rows whose chosen statistic cell is empty
            var badCount = 0;
            var negatives = 0;

            var noColor = 0;
            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                // Drilled into one group: only its tiles, laid out flat.
                if (focus !== null && groupOf(r, cfg) !== focus) { continue; }
                var v = PVX.data.statValue(r, cfg);
                if (v === null || v === undefined || !isFinite(v)) { skipped += 1; continue; }
                if (v <= 0) {
                    // Area is a non-negative quantity. A tile of "minus four"
                    // has no honest size, so the row leaves the layout and
                    // enters the footer by name.
                    if (v < 0) { negatives += 1; }
                    excluded.push({ label: r.label || ('Row ' + (i + 1)), value: v });
                    continue;
                }
                if (!r.good) { badCount += 1; }
                var cv;
                if (colorRows) {
                    var cr = colorRows[String(r.assetPath).toLowerCase()];
                    cv = cr ? PVX.data.statValue(cr, cfg) : null;
                    if (cv === null || cv === undefined || !isFinite(cv)) { cv = null; noColor += 1; }
                }
                items.push({
                    colorValue: cv,
                    label: r.label || ('Row ' + (i + 1)),
                    path: r.path || '',
                    units: r.units || '',
                    good: r.good !== false,
                    error: r.errorDescription || '',
                    value: v,
                    count: 1,
                    index: i,
                    row: r,
                    group: grouped ? groupOf(r, cfg) : null,
                    isOther: false,
                    rank: 0
                });
            }

            // Descending order is a precondition of squarify(): the algorithm
            // only produces near-square tiles when the biggest go first.
            items.sort(byValueDesc);

            // --- hard cap -------------------------------------------------
            var hidden = 0;
            var cap = Math.max(1, maxTiles);
            if (items.length > cap) {
                var rest = items.slice(cap);
                items = items.slice(0, cap);
                if (cfg.ShowOther) { items.push(makeOther(rest, cfg, null)); }
                else { hidden = rest.length; }
            }

            for (i = 0; i < items.length; i++) { items[i].rank = i; }

            var total = 0;
            for (i = 0; i < items.length; i++) { total += items[i].value; }

            // --- groups ---------------------------------------------------
            var groups = null;
            if (grouped && items.length) {
                var byKey = {};
                var order = [];
                for (i = 0; i < items.length; i++) {
                    // The cap's "Other" spans every group, so it gets its own.
                    var key = items[i].isOther ? (String(cfg.OtherLabel || 'Other')) : items[i].group;
                    if (key === null || key === undefined || key === '') { key = 'Ungrouped'; }
                    if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
                        byKey[key] = { key: key, label: key, items: [], value: 0, index: order.length };
                        order.push(byKey[key]);
                    }
                    byKey[key].items.push(items[i]);
                    byKey[key].value += items[i].value;
                }
                order.sort(byValueDesc);
                for (i = 0; i < order.length; i++) { order[i].groupIndex = i; }
                // Colour-by-group needs a stable hue per tile, so stamp the
                // group's ordinal onto its members here rather than looking it
                // up again in the drawing code.
                for (i = 0; i < order.length; i++) {
                    for (var j = 0; j < order[i].items.length; j++) {
                        order[i].items[j].groupIndex = i;
                        order[i].items[j].groupLabel = order[i].label;
                    }
                }
                groups = order;
            }

            // --- notes ----------------------------------------------------
            var notes = [];
            if (excluded.length) { notes.push(excludedNote(excluded, cfg)); }
            if (skipped) {
                notes.push(skipped + (skipped === 1 ? ' source has no ' : ' sources have no ') +
                    PVX.config.statLabel(cfg).toLowerCase());
            }
            // The cap's own "Other" is reported by the renderer along with the
            // slivers it merges later, so that there is one combined count in
            // the footer rather than two that have to be added up.
            if (hidden) { notes.push('+' + hidden + ' more not shown'); }
            if (noColor) {
                notes.push(noColor + (noColor === 1 ? ' tile has' : ' tiles have') + ' no ' + colorAttr + ' to colour by');
            }
            if (unusedAttrs.length) { notes.push('not used: ' + unusedAttrs.join(', ')); }

            // --- empty states ---------------------------------------------
            var headline = '', detail = '';
            if (!items.length) {
                if (!rows.length) {
                    headline = 'No data sources';
                    detail = 'Drop one or more attributes onto this symbol.';
                } else if (excluded.length && negatives === excluded.length) {
                    // "Say so instead of drawing nothing" — a blank frame reads
                    // as a broken symbol, not as a data condition.
                    headline = 'All values are negative';
                    detail = 'Area cannot represent a negative quantity.';
                } else if (excluded.length) {
                    headline = 'Nothing to size';
                    detail = 'All ' + excluded.length + ' values are zero or negative.';
                } else {
                    headline = 'No ' + PVX.config.statLabel(cfg).toLowerCase() + ' values';
                    detail = 'All ' + rows.length + ' sources returned an empty cell.';
                }
            }

            // How many real sources the tile list stands for. The renderer
            // compares this with what it actually managed to draw, so that a
            // tag squeezed out by a sub-pixel rectangle is reported rather
            // than quietly disappearing.
            var placedSources = 0;
            for (i = 0; i < items.length; i++) { placedSources += items[i].count || 1; }

            return {
                items: items,
                groups: groups,
                total: total,
                sources: rows.length,
                placedSources: placedSources,
                notes: notes,
                excluded: excluded,
                skipped: skipped,
                badCount: badCount,
                hidden: hidden,
                empty: items.length === 0,
                headline: headline,
                detail: detail
            };
        }

        /** One aggregate tile standing in for several real ones. */
        function makeOther(list, cfg, existing) {
            var sum = existing ? existing.value : 0;
            var count = existing ? existing.count : 0;
            var good = existing ? existing.good : true;
            for (var i = 0; i < list.length; i++) {
                sum += list[i].value;
                count += list[i].count || 1;
                // An aggregate built from an untrusted number is itself
                // untrusted, so it inherits the hatching.
                if (!list[i].good) { good = false; }
            }
            return {
                label: String(cfg.OtherLabel || 'Other'),
                path: '', units: '', error: '',
                good: good,
                value: sum,
                count: count,
                index: 1e9,
                row: null,
                group: existing ? existing.group : null,
                groupIndex: existing ? existing.groupIndex : 0,
                isOther: true,
                rank: 1e9
            };
        }

        /** Name the excluded tags — a count alone does not let anyone act. */
        function excludedNote(excluded, cfg) {
            var names = [];
            var shown = Math.min(excluded.length, 3);
            for (var i = 0; i < shown; i++) { names.push(excluded[i].label); }
            var more = excluded.length - shown;
            return 'Not sizable (zero or negative): ' + names.join(', ') +
                (more ? ' +' + more + ' more' : '');
        }

        /* ================================================================ *
         * Squarified layout (Bruls, Huizing & van Wijk, 1999)
         * ================================================================ */

        /**
         * Worst (i.e. largest) aspect ratio in a row of tiles.
         *
         * A row of total area `sum`, laid along a side of length `side`, forms
         * a strip `sum / side` thick. The row's tallest member then measures
         * `maxArea / thickness` along the side and the shortest `minArea /
         * thickness`, so the two extreme aspect ratios simplify to
         *
         *     side^2 * maxArea / sum^2      and      sum^2 / (side^2 * minArea)
         *
         * and the row is only as good as the worse of the two. This is the
         * quantity the layout minimises, and 1.0 is a perfect square.
         */
        function worstRatio(side, sum, minArea, maxArea) {
            if (!(sum > 0) || !(side > 0) || !(minArea > 0)) { return Infinity; }
            var s2 = side * side;
            var q2 = sum * sum;
            return Math.max((s2 * maxArea) / q2, q2 / (s2 * minArea));
        }

        /**
         * Lay `items` out inside `rect`.
         * @param {Array} items sorted DESCENDING by .value; every value > 0
         * @param {Object} rect {x, y, w, h}
         * @returns {Array} [{item, x, y, w, h}] in the same order as `items`
         */
        function squarify(items, rect) {
            var out = [];
            var n = items.length;
            if (!n) { return out; }

            var x = rect.x, y = rect.y, w = rect.w, h = rect.h;
            var i = 0, k;

            // Total still to be placed. Kept incrementally so the value->area
            // scale can be recomputed against the shrinking rectangle each row,
            // which stops rounding error from accumulating into the last tile.
            var remaining = 0;
            for (k = 0; k < n; k++) { remaining += items[k].value; }

            var guard = 0;
            while (i < n && guard < 4000) {
                guard += 1;

                if (!(w > 0.01) || !(h > 0.01) || !(remaining > 0)) {
                    // Out of room (a symbol resized to nothing, say). Emit the
                    // rest as zero-size so the caller's index bookkeeping — and
                    // therefore click routing — stays aligned with `items`.
                    for (; i < n; i++) { out.push({ item: items[i], x: x, y: y, w: 0, h: 0 }); }
                    break;
                }

                var scale = (w * h) / remaining;
                // Rows always run along the SHORT side of what is left. That is
                // what bounds the aspect ratio, and it is the whole trick.
                var side = Math.min(w, h);

                // --- grow the row while the worst ratio keeps improving -----
                var rowSum = 0, rowMin = Infinity, rowMax = 0, best = Infinity;
                var j = i;
                while (j < n) {
                    var a = items[j].value * scale;
                    var sum2 = rowSum + a;
                    var mn = a < rowMin ? a : rowMin;
                    var mx = a > rowMax ? a : rowMax;
                    var cand = worstRatio(side, sum2, mn, mx);
                    // Adding a tile always thickens the strip: it makes the
                    // small members squarer and the large ones flatter. Keep
                    // going while the net effect is an improvement, and close
                    // the row the moment it would get worse. Greedy, and the
                    // reason the result is near-square everywhere.
                    if (j > i && cand > best) { break; }
                    rowSum = sum2; rowMin = mn; rowMax = mx; best = cand;
                    j += 1;
                }

                // --- place the row ------------------------------------------
                var thick = rowSum / side;
                var horizontal = w < h;     // strip across the top, else column down the left
                var pos = horizontal ? x : y;
                for (k = i; k < j; k++) {
                    var area = items[k].value * scale;
                    var len = thick > 0 ? area / thick : 0;
                    out.push(horizontal
                        ? { item: items[k], x: pos, y: y, w: len, h: thick }
                        : { item: items[k], x: x, y: pos, w: thick, h: len });
                    pos += len;
                    remaining -= items[k].value;
                }
                if (horizontal) { y += thick; h -= thick; }
                else { x += thick; w -= thick; }
                i = j;
            }

            return out;
        }

        /**
         * squarify() plus the readability rule: anything that lands smaller
         * than half MinTilePx on its short side is folded into one "Other"
         * tile and the whole set re-laid.
         *
         * Sizes are only known after a layout, so this iterates. Removing
         * slivers only ever gives the survivors more room, so each pass finds
         * fewer of them and it converges quickly; the loop is bounded anyway.
         */
        function layoutWithMerge(items, rect, cfg, minPx) {
            var list = items.slice();
            var placed = squarify(list, rect);
            if (!cfg.ShowOther || list.length < 2) { return { placed: placed, items: list }; }

            var floor = minPx / 2;

            for (var pass = 0; pass < 4; pass++) {
                var keep = [], drop = [], existing = null;
                var i;
                for (i = 0; i < placed.length; i++) {
                    var p = placed[i];
                    if (p.item.isOther) { existing = p.item; keep.push(p.item); continue; }
                    if (Math.min(p.w, p.h) < floor) { drop.push(p.item); }
                    else { keep.push(p.item); }
                }
                if (!drop.length) { break; }

                // Never collapse the whole treemap into one grey box: a single
                // aggregate tells the operator nothing at all. `drop` is in
                // descending order, so shifting keeps the largest.
                var real = 0;
                for (i = 0; i < keep.length; i++) { if (!keep[i].isOther) { real += 1; } }
                while (real < 1 && drop.length) { keep.push(drop.shift()); real += 1; }

                // Renaming one tile to "Other" helps nobody.
                if (!drop.length || (drop.length === 1 && !existing)) { break; }

                var next = [];
                for (i = 0; i < keep.length; i++) {
                    if (keep[i] !== existing) { next.push(keep[i]); }
                }
                next.push(makeOther(drop, cfg, existing));
                next.sort(byValueDesc);
                list = next;
                placed = squarify(list, rect);
            }

            return { placed: placed, items: list };
        }

        /**
         * Grouped layout: squarify the groups over the whole frame first, then
         * squarify each group's members inside its own rectangle. That is what
         * keeps a group visually contiguous — the point of grouping at all.
         */
        function layoutGrouped(groups, rect, cfg, minPx) {
            var tiles = [];
            var headers = [];
            var pad = numIn(cfg.TilePadding, 0, 20, 2);
            var gBoxes = squarify(groups, rect);

            for (var i = 0; i < gBoxes.length; i++) {
                var box = gBoxes[i];
                var g = box.item;

                // Breathing room between groups, on top of the tile padding.
                var gx = box.x + pad, gy = box.y + pad;
                var gw = box.w - pad * 2, gh = box.h - pad * 2;
                if (!(gw > 2) || !(gh > 2)) { continue; }

                // A header strip only earns its space when the group is big
                // enough that the tiles below it are still worth drawing.
                var headFont = PVX.util.clamp(Math.min(gh * 0.16, gw * 0.09, 10), 7, 10);
                var headH = headFont + 4;
                var wantHead = gh > headH * 3 && gw > 42;
                if (wantHead) {
                    headers.push({ group: g, x: gx, y: gy, w: gw, h: headH, font: headFont });
                    gy += headH;
                    gh -= headH;
                }

                var inner = layoutWithMerge(g.items, { x: gx, y: gy, w: gw, h: gh }, cfg, minPx);
                for (var j = 0; j < inner.placed.length; j++) {
                    inner.placed[j].group = g;
                    tiles.push(inner.placed[j]);
                }
            }

            return { tiles: tiles, headers: headers };
        }

        /* ================================================================ *
         * Colour
         * ================================================================ */

        /**
         * Sequential ramp used by ColorMode 'value', reversed so that the
         * biggest number is the darkest tile. PVX.color.sequential runs
         * dark -> light, and "more = paler" reads backwards on a wall display.
         */
        function valueStops() {
            return PVX.color.sequential.slice().reverse();
        }

        function tileColor(item, cfg, t, domain) {
            var single = cfg.SingleColor || '#3b82c4';

            // An aggregate is not a measurement, so it never takes a threshold
            // colour or a ramp position — it would claim a severity it does not
            // have. Neutral grey says "several things, summed".
            if (item.isOther) {
                return PVX.color.mix(t.surfaceAlt, t.textMuted, 0.55);
            }

            // The number the colour stands for: the second attribute of an AF
            // search when there is one, else the size itself. A tile with no
            // second value has nothing to say in colour and stays neutral.
            var cv = item.colorValue === undefined ? item.value : item.colorValue;
            if (cv === null && (cfg.ColorMode === 'value' || cfg.ColorMode === 'threshold')) {
                return PVX.color.mix(t.surfaceAlt, t.textMuted, 0.3);
            }

            switch (cfg.ColorMode) {
                case 'value':
                    var span = domain[1] - domain[0];
                    var f = span > 0 ? (cv - domain[0]) / span : 1;
                    return PVX.color.ramp(valueStops(), f);
                case 'palette':
                    return PVX.color.categorical[item.rank % PVX.color.categorical.length];
                case 'group':
                    // With grouping off every tile is in the same implicit
                    // group, so this degrades to the flat colour rather than
                    // painting the whole frame one arbitrary palette entry.
                    var gi = item.groupIndex;
                    if (gi === undefined || gi === null) { return single; }
                    return PVX.color.categorical[gi % PVX.color.categorical.length];
                case 'single':
                    return single;
                case 'threshold':
                default:
                    // Falls back to the flat colour when thresholds are off, so
                    // the mode never silently paints everything one band.
                    return cfg.UseThresholds
                        ? PVX.thresholds.colorFor(cfg.Thresholds, cv, single)
                        : single;
            }
        }

        /** The colour the symbol is actually painted on, transparent included. */
        function surfaceOf(t) {
            if (t.surface && t.surface !== 'transparent') { return t.surface; }
            return t.dark ? '#22262b' : '#ffffff';
        }

        /**
         * Hatched fill for bad quality. An unreadable sensor still occupies its
         * share of the plant, so it keeps its tile; but a solid tile in a
         * "stale" colour still reads as a real measurement, and this must not.
         * One pattern per colour per render; ids are unique so several
         * instances of the symbol on one display cannot collide.
         */
        function hatchFor(defs, cache, fill) {
            if (cache[fill]) { return cache[fill]; }
            var id = PVX.util.uid('pvxtmhatch');
            var p = PVX.svg.el('pattern', {
                id: id, width: 6, height: 6,
                patternUnits: 'userSpaceOnUse',
                patternTransform: 'rotate(45)'
            }, defs);
            PVX.svg.el('rect', { x: 0, y: 0, width: 6, height: 6, fill: fill, 'fill-opacity': 0.25 }, p);
            PVX.svg.el('rect', { x: 0, y: 0, width: 3, height: 6, fill: fill, 'fill-opacity': 0.9 }, p);
            cache[fill] = 'url(#' + id + ')';
            return cache[fill];
        }

        /* ================================================================ *
         * Text
         * ================================================================ */

        /** Cheap pre-truncation estimate. 0.58em is the average advance of
         *  Segoe UI / Roboto at small sizes; fitTextTo() does the real work. */
        function textPx(s, fontPx) {
            return String(s === null || s === undefined ? '' : s).length * fontPx * 0.58;
        }

        function truncate(s, maxPx, fontPx) {
            var str = String(s === null || s === undefined ? '' : s);
            var max = Math.floor(maxPx / (fontPx * 0.58));
            if (max < 1) { return ''; }
            if (str.length <= max) { return str; }
            if (max === 1) { return '…'; }
            return str.slice(0, max - 1) + '…';
        }

        /**
         * Trim an already-drawn <text> until getComputedTextLength() reports it
         * fits `maxPx`, re-adding the ellipsis; empty it if even one glyph is
         * too much.
         *
         * Why measure rather than trust the estimate: a tile label is boxed on
         * both sides by its own tile, and a name that runs even a few pixels
         * long spills over the neighbouring tile where it reads as that tile's
         * label. There is no clip that saves it — the text has to be short
         * enough. The caller passes text already cut by the estimate, so the
         * common case measures once and returns; when it does not, each pass
         * takes a proportional bite out of the measured overshoot instead of
         * walking one character at a time.
         */
        function fitTextTo(node, maxPx) {
            if (!node || !node.getComputedTextLength) { return true; }
            if (!(maxPx > 0)) { node.textContent = ''; return false; }
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            for (var guard = 0; guard < 8; guard++) {
                var w = measure();
                if (!(w > maxPx)) { return node.textContent !== ''; }
                var cur = node.textContent || '';
                var core = cur.charAt(cur.length - 1) === '…' ? cur.slice(0, -1) : cur;
                if (core.length < 2) { node.textContent = ''; return false; }
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return false; }
                node.textContent = core.slice(0, keep) + '…';
            }
            if (measure() > maxPx) { node.textContent = ''; return false; }
            return true;
        }

        function valueText(item, cfg, total) {
            var s = PVX.fmt.number(item.value, PVX.config.numberOpts(cfg));
            if (cfg.ShowUnits && item.units) { s += ' ' + item.units; }
            if (cfg.ShowPercent && total > 0) {
                s += ' (' + Math.round((item.value / total) * 100) + '%)';
            }
            return s;
        }

        /* ================================================================ *
         * Render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            // Self-heal a config saved by an older build or edited by hand.
            // Only writes when something actually differs, so this cannot loop
            // with PI Vision's own change detection.
            PVX.config.syncStatColumns(cfg);

            liveCfg = cfg;
            applyThemeVars(c, t);
            bindHost(host);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            // Chrome decisions are about the SYMBOL box, not the drawing host —
            // the host is already smaller by however much chrome is showing, so
            // deciding from it would oscillate between two layouts.
            var symW = (c.node && c.node.clientWidth) || c.width;
            var symH = (c.node && c.node.clientHeight) || c.height;
            var compact = symW < 200 || symH < 140;   // no legend, no chrome
            var tiny = symW < 140 || symH < 100;      // largest few tiles, no labels

            var W = Math.max(20, c.width);
            var H = Math.max(16, c.height);

            var svgRoot = host.querySelector('svg.pvx-tm-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-tm-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);

            var groupable = cfg.GroupBy === 'delimiter' || cfg.GroupBy === 'prefix' || cfg.GroupBy === 'parent';
            // A drill-down only means something while there are groups.
            if (!groupable || cfg.ClickAction !== 'drill') { focus = null; }
            var grouped = !tiny && groupable && focus === null;
            scope.pvx.crumbs = focus !== null && !compact
                ? [{ label: 'All', i: 0 }, { label: focus, i: 1, last: true }] : [];
            var maxTiles = tiny ? 4 : intIn(cfg.MaxTiles, 1, 400, 60);
            var model = buildModel(cfg, maxTiles, grouped);

            // ---- chrome --------------------------------------------------
            scope.pvx.title = cfg.Title || 'Treemap';
            scope.pvx.subtitle = PVX.config.statLabel(cfg) + commonUnitsSuffix(cfg, model) +
                (colorAttr ? ' \u00b7 colour: ' + colorAttr : '');
            scope.pvx.error = model.badCount
                ? (model.badCount + (model.badCount === 1 ? ' source reports' : ' sources report') + ' bad quality')
                : '';
            scope.pvx.showHeader = !compact && !!cfg.ShowLabel;

            if (model.empty) {
                view = [];
                scope.pvx.note = model.notes.join(' · ');
                scope.pvx.count = '';
                scope.pvx.showFooter = !compact && !!scope.pvx.note;
                emptyState(svgRoot, W, H, t, model.headline, model.detail);
                digest();
                return;
            }

            // How many tiles survive is a LAYOUT result, not a model one — the
            // sliver merge only knows what it merged once the rectangles exist.
            // So the footer is written after drawing, from what is on screen.
            var drawn = drawTreemap(svgRoot, W, H, cfg, t, model, compact, tiny);

            var notes = model.notes.slice();
            var lost = model.placedSources - drawn.sources;
            if (lost > 0) {
                // A tag whose share of the frame rounds to nothing still has to
                // be accounted for out loud.
                notes.push(lost + (lost === 1 ? ' source is' : ' sources are') + ' too small to draw');
            }
            if (drawn.otherCount > 1) {
                notes.push(drawn.otherCount + ' combined as "' +
                    String(cfg.OtherLabel || 'Other') + '"');
            }
            scope.pvx.note = notes.join(' · ');
            // "36 of 40 sources" whenever the tiles stand for fewer rows than
            // came back — exclusions, the cap and the sliver merge all do that.
            scope.pvx.count = (drawn.sources < model.sources
                    ? drawn.sources + ' of ' + model.sources
                    : String(model.sources)) +
                (model.sources === 1 ? ' source' : ' sources');
            scope.pvx.showFooter = !compact && !!(scope.pvx.note || scope.pvx.count);

            digest();
        }

        /** Units only belong in the header when every row agrees on them. */
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

        function drawTreemap(svgRoot, W, H, cfg, t, model, compact, tiny) {
            var i;
            var defs = PVX.svg.el('defs', null, svgRoot);
            var hatchCache = {};
            var pad = numIn(cfg.TilePadding, 0, 20, 2);
            var radius = numIn(cfg.TileRadius, 0, 20, 2);
            var minPx = numIn(cfg.MinTilePx, 6, 200, 26);

            // ---- colour domain (ColorMode 'value') ------------------------
            // Built from the real tiles only: the aggregate's sum is not a
            // reading and would stretch the ramp to nothing.
            var lo = null, hi = null;
            for (i = 0; i < model.items.length; i++) {
                if (model.items[i].isOther) { continue; }
                var v = model.items[i].colorValue === undefined ? model.items[i].value : model.items[i].colorValue;
                if (v === null) { continue; }
                if (lo === null || v < lo) { lo = v; }
                if (hi === null || v > hi) { hi = v; }
            }
            if (lo === null) { lo = 0; hi = 1; }
            if (hi === lo) { hi = lo + 1; }     // all values equal
            var domain = [lo, hi];

            // ---- legend strip ---------------------------------------------
            var legendMode = legendKind(cfg, model);
            var legendH = 0;
            if (!compact && cfg.ShowColorLegend && legendMode && H > 70) {
                legendH = 15;
            }

            var frame = {
                x: pad / 2,
                y: legendH + pad / 2,
                w: Math.max(1, W - pad),
                h: Math.max(1, H - legendH - pad)
            };

            // ---- layout ----------------------------------------------------
            var tiles, headers = [];
            if (model.groups) {
                var gl = layoutGrouped(model.groups, frame, cfg, minPx);
                tiles = gl.tiles;
                headers = gl.headers;
            } else {
                tiles = layoutWithMerge(model.items, frame, cfg, minPx).placed;
            }

            // ---- draw -------------------------------------------------------
            var borderColor = t.surface === 'transparent'
                ? (t.dark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.75)')
                : t.surface;
            var opts = { cfg: cfg, theme: t, defs: defs, hatch: hatchCache,
                pad: pad, radius: radius, minPx: minPx, domain: domain,
                total: model.total, border: borderColor, tiny: tiny,
                clickable: cfg.ClickAction === 'navigate' || cfg.ClickAction === 'drill' };

            var tilesG = PVX.svg.el('g', { 'class': 'pvx-tm-tiles' }, svgRoot);
            var sources = 0, otherCount = 0;
            view = [];
            for (i = 0; i < tiles.length; i++) {
                // A tile the layout could not give real room to is not drawn at
                // all: a sub-pixel rectangle is a smudge, not a data point.
                if (!(tiles[i].w > 0.5) || !(tiles[i].h > 0.5)) { continue; }
                drawTile(tilesG, tiles[i], opts, view.length);
                view.push(tiles[i].item);
                sources += tiles[i].item.count || 1;
                if (tiles[i].item.isOther) { otherCount += tiles[i].item.count || 0; }
            }

            // Group headers go on top so a tile can never overdraw its own name.
            for (i = 0; i < headers.length; i++) {
                drawGroupHeader(svgRoot, headers[i], cfg, t);
            }

            if (legendH) { drawLegend(svgRoot, cfg, t, legendMode, domain, model, W, legendH); }

            // The footer is written from this, not from the model: how many
            // tiles survive is a layout outcome, not a data one.
            return { tiles: view.length, sources: sources, otherCount: otherCount };
        }

        /**
         * Which legend, if any, this colour mode can honestly show.
         * 'palette' and 'single' get none: they encode identity, not magnitude,
         * so a key would only restate the tile labels. 'group' needs groups to
         * actually exist, or the reserved strip would be blank.
         */
        function legendKind(cfg, model) {
            if (cfg.ColorMode === 'value') { return 'value'; }
            if (cfg.ColorMode === 'threshold' && cfg.UseThresholds) {
                return PVX.thresholds.parse(cfg.Thresholds).length ? 'threshold' : null;
            }
            if (cfg.ColorMode === 'group') {
                return (model.groups && model.groups.length) ? 'group' : null;
            }
            return null;
        }

        function drawTile(parent, p, o, viewIndex) {
            var cfg = o.cfg, t = o.theme;
            var item = p.item;

            // The padding is taken out of the tile rather than added between
            // tiles, so the layout maths stays in one coordinate system and the
            // areas remain proportional to the values.
            var inset = Math.min(o.pad / 2, p.w / 2 - 0.25, p.h / 2 - 0.25);
            if (!(inset > 0)) { inset = 0; }
            var x = p.x + inset, y = p.y + inset;
            var w = Math.max(0.5, p.w - inset * 2), h = Math.max(0.5, p.h - inset * 2);

            var col = tileColor(item, cfg, t, o.domain);
            var fill = item.good ? col : hatchFor(o.defs, o.hatch, col);

            var g = PVX.svg.el('g', { 'class': 'pvx-tm-tile' }, parent);
            g.setAttribute('data-pvx-i', String(viewIndex));

            PVX.svg.el('rect', {
                x: x.toFixed(2), y: y.toFixed(2),
                width: w.toFixed(2), height: h.toFixed(2),
                rx: o.radius ? Math.min(o.radius, w / 2, h / 2).toFixed(1) : null,
                fill: fill,
                stroke: cfg.ShowBorders ? o.border : (item.good ? 'none' : col),
                'stroke-width': cfg.ShowBorders ? 1 : (item.good ? null : 0.8)
            }, g);

            // The full name and value live in a <title>: the drawn label is a
            // display compromise, the tooltip is the source of truth.
            var tip = PVX.svg.el('title', null, g);
            tip.textContent = item.label +
                (item.isOther && item.count > 1 ? ' (' + item.count + ' sources)' : '') +
                ' — ' + PVX.fmt.number(item.value, PVX.config.numberOpts(cfg)) +
                (item.units ? ' ' + item.units : '') +
                (o.total > 0 ? ' · ' + ((item.value / o.total) * 100).toFixed(1) + '% of total' : '') +
                (item.colorValue !== undefined ? '\n' + colorAttr + ': ' +
                    (item.colorValue === null ? 'no value' : PVX.fmt.number(item.colorValue, PVX.config.numberOpts(cfg))) : '') +
                (item.groupLabel ? '\n' + item.groupLabel : '') +
                (item.good ? '' : '\n BAD QUALITY' + (item.error ? ': ' + item.error : '')) +
                (item.path ? '\n' + item.path : '');

            if (o.clickable && item.row) {
                g.setAttribute('class', 'pvx-tm-tile pvx-tm-click');
                g.setAttribute('tabindex', '0');
                g.setAttribute('role', 'button');
            }

            // Label contrast is judged against what the label actually sits on.
            // A hatched tile is mostly surface showing through the 45-degree
            // gaps, so measuring against the solid fill picks white text and
            // then prints it on near-white — exactly the tile whose number is
            // least trustworthy becomes the one nobody can read.
            var labelBg = item.good ? col : PVX.color.mix(surfaceOf(t), col, 0.55);
            if (!o.tiny) { drawTileLabel(g, item, x, y, w, h, labelBg, o); }
        }

        /**
         * Label one tile, dropping detail in this order: the value line first,
         * then characters off the name, then the label entirely. A tile below
         * MinTilePx on its short side gets nothing — a half-glyph is noise, not
         * information.
         */
        function drawTileLabel(g, item, x, y, w, h, labelBg, o) {
            var cfg = o.cfg;
            if (Math.min(w, h) < o.minPx) { return; }

            var mode = cfg.LabelMode || 'auto';
            var wantName = mode !== 'valueOnly';
            var wantValue = mode === 'valueOnly' || mode === 'both' ||
                (mode === 'auto' && cfg.ShowValues);
            if (!wantName && !wantValue) { return; }

            var fg = PVX.color.readable(labelBg);
            var availW = w - 8;
            if (!(availW > 6)) { return; }

            // Font from the tile box: a wide flat tile can still take a full
            // size line, a small square one cannot.
            var font = PVX.util.clamp(Math.min(h * 0.34, w * 0.30, 12), 8, 12);
            var lines = (wantName ? 1 : 0) + (wantValue ? 1 : 0);

            // Not enough height for two lines: the value goes first. The name
            // is what identifies the tile; the number is recoverable from the
            // tooltip and from the tile's own size.
            if (lines === 2 && h < font * 2.7) { wantValue = false; lines = 1; }

            var ty = y + 4 + font * 0.62;
            var drew = false;

            if (wantName) {
                var nameNode = PVX.svg.text(g, (x + 4).toFixed(2), ty.toFixed(2),
                    truncate(item.label, availW, font), {
                        'class': 'pvx-svg-label pvx-tm-name',
                        'text-anchor': 'start', 'font-size': font.toFixed(1),
                        'font-weight': '600', fill: fg
                    });
                drew = fitTextTo(nameNode, availW);
                if (!drew) { g.removeChild(nameNode); }
                else { ty += font * 1.15; }
            }

            if (wantValue && (!wantName || drew || mode === 'valueOnly')) {
                // Second line only when it actually fits inside the tile.
                if (ty + font * 0.5 <= y + h - 2) {
                    var vFont = wantName ? font * 0.9 : font;
                    var txt = valueText(item, cfg, o.total);
                    var valNode = PVX.svg.text(g, (x + 4).toFixed(2), ty.toFixed(2),
                        truncate(txt, availW, vFont), {
                            'class': 'pvx-svg-value pvx-num pvx-tm-value',
                            'text-anchor': 'start', 'font-size': vFont.toFixed(1),
                            fill: PVX.color.rgba(fg, 0.85)
                        });
                    if (!fitTextTo(valNode, availW)) { g.removeChild(valNode); }
                }
            }
        }

        function drawGroupHeader(svgRoot, head, cfg, t) {
            var g = PVX.svg.el('g', { 'class': 'pvx-tm-grouphead' }, svgRoot);
            var font = head.font;

            // A hairline under the name separates the header from the tiles
            // without spending a whole band of colour on it.
            PVX.svg.el('line', {
                x1: head.x.toFixed(2), y1: (head.y + head.h - 1).toFixed(2),
                x2: (head.x + head.w).toFixed(2), y2: (head.y + head.h - 1).toFixed(2),
                stroke: t.border, 'stroke-width': 1, 'shape-rendering': 'crispEdges'
            }, g);

            var totalTxt = PVX.fmt.compact(head.group.value, 1);
            var totalW = textPx(totalTxt, font) + 4;
            var nameBudget = Math.max(8, head.w - totalW - 6);

            var nameNode = PVX.svg.text(g, head.x.toFixed(2), (head.y + head.h / 2 - 1).toFixed(2),
                truncate(head.group.label, nameBudget, font), {
                    'class': 'pvx-svg-label pvx-tm-groupname',
                    'text-anchor': 'start', 'font-size': font.toFixed(1),
                    'font-weight': '700', fill: t.text
                });
            fitTextTo(nameNode, nameBudget);
            PVX.svg.el('title', null, nameNode).textContent = head.group.label;

            // The group total only goes in when it does not squeeze the name.
            if (head.w > totalW * 2.2) {
                PVX.svg.text(g, (head.x + head.w).toFixed(2), (head.y + head.h / 2 - 1).toFixed(2),
                    totalTxt, {
                        'class': 'pvx-svg-label pvx-num pvx-tm-grouptotal',
                        'text-anchor': 'end', 'font-size': (font * 0.95).toFixed(1),
                        fill: t.textMuted
                    });
            }
        }

        /**
         * A continuous scale gets a gradient bar with its min and max; a
         * threshold scale gets one swatch per band, because interpolating
         * between band colours would imply values the scale never produces.
         *
         * The gradient is built from adjacent slices sampled off the same ramp
         * the tiles use — no <linearGradient>, hence no defs id that could
         * collide with another instance of the symbol on the same display.
         */
        function drawLegend(svgRoot, cfg, t, kind, domain, model, W, bandH) {
            var g = PVX.svg.el('g', { 'class': 'pvx-tm-legend' }, svgRoot);
            var font = 9;
            var y = 2;
            var sw = 9;
            var i, x;

            if (kind === 'threshold' || kind === 'group') {
                var entries = [];
                if (kind === 'threshold') {
                    var bands = PVX.thresholds.parse(cfg.Thresholds);
                    for (i = 0; i < bands.length; i++) {
                        entries.push({
                            color: bands[i].color,
                            label: bands[i].label || ('≥' + PVX.fmt.tick(bands[i].value))
                        });
                    }
                } else if (model.groups) {
                    for (i = 0; i < model.groups.length; i++) {
                        entries.push({
                            color: PVX.color.categorical[i % PVX.color.categorical.length],
                            label: model.groups[i].label
                        });
                    }
                }
                if (!entries.length) { return; }

                x = 2;
                for (i = 0; i < entries.length; i++) {
                    var itemW = sw + 4 + textPx(entries[i].label, font) + 10;
                    // Stop cleanly at the edge rather than drawing a swatch
                    // whose label is chopped off by the frame.
                    if (x + itemW > W - 2) { break; }
                    PVX.svg.el('rect', {
                        x: x.toFixed(1), y: y.toFixed(1),
                        width: sw, height: sw, rx: 2, fill: entries[i].color
                    }, g);
                    PVX.svg.text(g, (x + sw + 4).toFixed(1), (y + sw / 2).toFixed(1),
                        entries[i].label, {
                            'class': 'pvx-svg-label', 'font-size': font, fill: t.textMuted
                        });
                    x += itemW;
                }
                return;
            }

            // --- continuous ------------------------------------------------
            var loTxt = PVX.fmt.tick(domain[0]);
            var hiTxt = PVX.fmt.tick(domain[1]);
            var loW = textPx(loTxt, font) + 6;
            var hiW = textPx(hiTxt, font) + 6;
            var barX = 2 + loW;
            var barW = W - 4 - loW - hiW;
            if (!(barW > 24)) { return; }

            var stops = valueStops();
            var SLICES = 36;
            var sliceW = barW / SLICES;
            for (i = 0; i < SLICES; i++) {
                PVX.svg.el('rect', {
                    x: (barX + i * sliceW).toFixed(2), y: (y + 1).toFixed(1),
                    // +0.6 overlap kills the hairline seams antialiasing leaves
                    // between adjacent rects.
                    width: (sliceW + 0.6).toFixed(2), height: (bandH - 6).toFixed(1),
                    fill: PVX.color.ramp(stops, (i + 0.5) / SLICES),
                    'shape-rendering': 'crispEdges'
                }, g);
            }
            PVX.svg.text(g, (barX - 4).toFixed(1), (y + (bandH - 6) / 2 + 1).toFixed(1), loTxt, {
                'class': 'pvx-svg-label pvx-num', 'text-anchor': 'end',
                'font-size': font, fill: t.textMuted
            });
            PVX.svg.text(g, (barX + barW + 4).toFixed(1), (y + (bandH - 6) / 2 + 1).toFixed(1), hiTxt, {
                'class': 'pvx-svg-label pvx-num', 'text-anchor': 'start',
                'font-size': font, fill: t.textMuted
            });
        }

        /* ================================================================ *
         * Empty state
         * ================================================================ */

        function emptyState(svgRoot, W, H, t, headline, detail) {
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 16), 9, 13);
            var avail = Math.max(24, W - 12);

            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 - font * 0.7).toFixed(2),
                headline, {
                    'class': 'pvx-svg-label pvx-tm-emptymsg', 'text-anchor': 'middle',
                    'font-size': font, 'font-weight': '600', fill: t.textMuted
                });
            var sub = PVX.svg.text(svgRoot, (W / 2).toFixed(2), (H / 2 + font * 0.8).toFixed(2),
                detail, {
                    'class': 'pvx-svg-label pvx-tm-emptymsg', 'text-anchor': 'middle',
                    'font-size': (font * 0.85).toFixed(1), fill: t.textMuted
                });

            // Centre-anchored text spills past BOTH edges once it is wider than
            // the frame, which is the most obviously broken thing a symbol can
            // show. Nothing else is being drawn, so measure properly.
            shrinkToFit(head, avail);
            shrinkToFit(sub, avail);
        }

        /** Scale a <text> down until it fits, then truncate at the 6px floor. */
        function shrinkToFit(node, avail) {
            if (!node || !node.getComputedTextLength || !(avail > 0)) { return; }
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            var w = measure();
            if (!(w > avail)) { return; }

            var size = parseFloat(node.getAttribute('font-size')) || 10;
            node.setAttribute('font-size', Math.max(6, size * (avail / w)).toFixed(1));

            w = measure();
            if (!(w > avail)) { return; }

            var str = node.textContent;
            var keep = Math.max(3, Math.floor(str.length * (avail / w)) - 1);
            node.textContent = str.slice(0, keep) + '…';
            for (var guard = 0; guard < 24 && measure() > avail && node.textContent.length > 2; guard++) {
                node.textContent = node.textContent.slice(0, -2) + '…';
            }
        }

        /* ================================================================ *
         * Interaction — one delegated listener pair for the whole treemap
         * ================================================================ */

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            host.addEventListener('click', onClick, false);
            host.addEventListener('keydown', onKeyDown, false);
            boundHost = host;
        }

        function unbindHost() {
            if (!boundHost) { return; }
            boundHost.removeEventListener('click', onClick, false);
            boundHost.removeEventListener('keydown', onKeyDown, false);
            boundHost = null;
        }

        /** Walk up to the tile group. Element.closest is missing on IE11. */
        function tileIndexOf(target) {
            var node = target;
            var guard = 0;
            while (node && node !== boundHost && guard < 12) {
                if (node.getAttribute && node.getAttribute('data-pvx-i') !== null) {
                    var i = parseInt(node.getAttribute('data-pvx-i'), 10);
                    return isNaN(i) ? -1 : i;
                }
                node = node.parentNode;
                guard += 1;
            }
            return -1;
        }

        function onClick(ev) {
            if (liveCfg.ClickAction !== 'navigate' && liveCfg.ClickAction !== 'drill') { return; }
            activate(tileIndexOf(ev.target));
        }

        function onKeyDown(ev) {
            if (liveCfg.ClickAction !== 'navigate' && liveCfg.ClickAction !== 'drill') { return; }
            var k = ev.keyCode || ev.which;
            if (k !== 13 && k !== 32) { return; }   // Enter, Space
            var i = tileIndexOf(ev.target);
            if (i < 0) { return; }
            // Space would scroll the display container otherwise.
            if (ev.preventDefault) { ev.preventDefault(); }
            activate(i);
        }

        function activate(index) {
            if (index < 0 || index >= view.length) { return; }
            var item = view[index];
            // The aggregate tile stands for several assets, so there is no one
            // asset to drill into.
            if (!item || item.isOther) { return; }
            // Drill-down: a tile in a group opens that group; inside it, a
            // tile goes where a navigating click would.
            if (liveCfg.ClickAction === 'drill' && focus === null && item.group !== null && item.group !== undefined) {
                focus = item.group;
                ctx.render();
                return;
            }
            var target = String(liveCfg.NavigateTarget || '').trim();
            // With no target and no asset path there is nowhere to go, and
            // navigating to the current URL would just flicker the display.
            if (!target && !item.path) { return; }
            PVX.nav.go(PVX.nav.url({
                display: target || undefined,
                asset: item.path || undefined
            }), false);
        }

        /* ================================================================ *
         * Chrome plumbing
         * ================================================================ */

        /** Theme tokens as CSS custom properties for the Angular-rendered chrome. */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
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
