/* ============================================================================
 * pvxAssetRollup: "PVX Asset Rollup" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector, and gives the search a starting asset (see the
 * definition). Every number comes from PI Web API through PVX.api.
 *
 * One number across many assets: how many compressors are running, the
 * total rate of every well under an area, the average efficiency of each
 * template's units. The assets are found by an AF search (the elements under
 * the display's asset, optionally all the way down, of one template, with a
 * name filter); one attribute is read from each, and a count, sum, minimum,
 * maximum, average, median, standard deviation or count of distinct values
 * is taken over them. The cards can be split by template, by parent element
 * or by the value of another attribute, largest first, with the rest folded
 * into one "Others" card that is worked out from its assets, not by adding
 * up the cards it replaces (an average of averages is not an average).
 *
 * WHY NOT THE KPI CARD. A KPI Card is one tag through PI Vision's pipeline.
 * A roll-up over a search has no fixed list of tags: an area with twelve
 * units today and fourteen next year must not need its display edited, and
 * PI Vision's data sources cannot grow by themselves.
 *
 * DATA ACCESS. The search is one request, repeated only when the root,
 * template, filter or depth change. Each refresh reads every element's
 * attribute in ONE PVX.api.batch, a stream set value per element filtered
 * to the attribute name, so an element without the attribute costs nothing
 * extra and says so. Elements without a value, with a bad one, or with text
 * where a number is needed are counted in the footer, never dropped quietly.
 *
 * The cards are written as one string per render: only the header and the
 * footer are Angular-bound.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var OTHERS = 'Others';
    var UNASSIGNED = '(unassigned)';

    var AGG_NAMES = {
        count: 'Count', countDistinct: 'Distinct values', sum: 'Total', min: 'Minimum',
        max: 'Maximum', avg: 'Average', median: 'Median', stddev: 'Standard deviation'
    };

    var definition = {
        typeName: 'pvxAssetRollup',
        displayName: 'PVX Asset Rollup',

        // One data source, which this symbol ignores but for its element:
        // PI Vision keeps DatasourceBehaviors.None symbols out of the symbol
        // selector. Pick it and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        // It is already a roll-up across assets.
        supportsCollections: false,
        configTitle: 'Format Asset Rollup',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Value',
                Height: 200,
                Width: 520,
                Title: '',

                /* -- which assets ------------------------------------------- */
                SearchRoot: '',              // used when the URL names no asset
                SearchTemplate: '',
                SearchNameFilter: '',
                SearchDescendants: true,
                MaxElements: 500,
                RefreshSeconds: 60,

                /* -- what is rolled up -------------------------------------- */
                Attribute: '',               // e.g. Production Rate; blank counts the assets
                Aggregate: 'sum',            // count | countDistinct | sum | min | max | avg | median | stddev
                CountWhen: '',               // count only: values equal to this (e.g. Running)

                /* -- cards --------------------------------------------------- */
                GroupBy: 'none',             // none | template | parent | attribute
                GroupAttribute: '',
                TopN: 8,
                ShowOthers: true,
                ShowAll: true,               // a first card over every asset, when split
                SortBy: 'value',             // value | name
                SortDescending: true,

                /* -- color -------------------------------------------------- */
                // No bands until someone sets them: a red card is an alarm.
                Thresholds: '',
                Target: '',
                TargetDirection: 'higher',   // higher | lower is better

                /* -- click --------------------------------------------------- */
                ClickAction: 'none',         // none | asset (parent cards) | navigate
                NavigateTarget: ''
            });
        }
    };

    /* ====================================================================== *
     * pure, exposed on symbolVis for tools/test-overview.js
     * ====================================================================== */

    function trim(s) {
        return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, '');
    }

    function isNum(v) { return typeof v === 'number' && isFinite(v); }

    /** A value against the wanted list: a number by value (1 = "1.0"), else by name, ignoring case. */
    function matches(v, want) {
        var text = String(v).toLowerCase();
        for (var i = 0; i < want.length; i++) {
            if (text === want[i]) { return true; }
            if (isNum(v) && want[i] !== '' && isFinite(Number(want[i])) && Number(want[i]) === v) { return true; }
        }
        return false;
    }

    /**
     * One aggregate over a list of rows {value, good}.
     * @returns {{v: Number|null, n: Number, used: Number, skipped: Number}}
     *   n rows, `used` the values that went in, `skipped` the ones that could
     *   not (no value, bad quality, or text where a number is needed).
     */
    function aggregate(rows, kind, countWhen) {
        var out = { v: null, n: rows.length, used: 0, skipped: 0 };
        var nums = [], seen = {}, distinct = 0, hits = 0, i;
        // Several wanted values, any of which counts: "Running, Starting".
        var want = trim(countWhen) ? trim(countWhen).split(',').map(function (w) { return trim(w).toLowerCase(); })
            .filter(function (w) { return w !== ''; }) : [];
        for (i = 0; i < rows.length; i++) {
            var r = rows[i];
            var has = r.value !== null && r.value !== undefined && trim(r.value) !== '';
            if (kind === 'count') {
                // Counting assets needs no value unless a value is asked for.
                if (!want.length) { out.used += 1; hits += 1; continue; }
                if (!has || r.good === false) { out.skipped += 1; continue; }
                out.used += 1;
                if (matches(r.value, want)) { hits += 1; }
                continue;
            }
            if (!has || r.good === false) { out.skipped += 1; continue; }
            if (kind === 'countDistinct') {
                var k = String(r.value).toLowerCase();
                out.used += 1;
                if (!seen[k]) { seen[k] = true; distinct += 1; }
                continue;
            }
            if (!isNum(r.value)) { out.skipped += 1; continue; }
            out.used += 1;
            nums.push(r.value);
        }
        if (kind === 'count') { out.v = hits; return out; }
        if (kind === 'countDistinct') { out.v = distinct; return out; }
        if (!nums.length) { return out; }
        var sum = 0;
        for (i = 0; i < nums.length; i++) { sum += nums[i]; }
        if (kind === 'sum') { out.v = sum; }
        else if (kind === 'min') { out.v = Math.min.apply(null, nums); }
        else if (kind === 'max') { out.v = Math.max.apply(null, nums); }
        else if (kind === 'median') {
            nums.sort(function (a, b) { return a - b; });
            var m = nums.length >> 1;
            out.v = nums.length % 2 ? nums[m] : (nums[m - 1] + nums[m]) / 2;
        } else if (kind === 'stddev') {
            // Sample standard deviation: these are some of the plant's units,
            // read now, not every value there could be.
            if (nums.length < 2) { return out; }
            var mean = sum / nums.length, ss = 0;
            for (i = 0; i < nums.length; i++) { ss += (nums[i] - mean) * (nums[i] - mean); }
            out.v = Math.sqrt(ss / (nums.length - 1));
        } else { out.v = sum / nums.length; }
        return out;
    }

    /**
     * Rows -> cards: one per group, sorted, the first TopN kept and the rest
     * folded into Others, each worked out from its own rows.
     * @param {Array} rows [{name, path, template, parent, value, good, group}]
     * @param {Object} o {groupBy, kind, countWhen, topN, others, all, sortBy, desc}
     */
    function buildCards(rows, o) {
        var cards = [];
        if (o.groupBy === 'none') {
            cards.push(card('', rows, o));
            return { cards: cards, groups: 1, folded: 0 };
        }
        var by = {}, order = [], i;
        for (i = 0; i < rows.length; i++) {
            var g = rows[i].group;
            g = g === null || g === undefined || trim(g) === '' ? UNASSIGNED : String(g);
            if (!Object.prototype.hasOwnProperty.call(by, g)) { by[g] = []; order.push(g); }
            by[g].push(rows[i]);
        }
        var groups = [];
        for (i = 0; i < order.length; i++) { groups.push(card(order[i], by[order[i]], o)); }
        var dir = o.desc ? -1 : 1;
        groups.sort(function (a, b) {
            // Unassigned last: it is often the finding, but it is not a value.
            if (a.label === UNASSIGNED && b.label !== UNASSIGNED) { return 1; }
            if (b.label === UNASSIGNED && a.label !== UNASSIGNED) { return -1; }
            if (o.sortBy === 'value') {
                if (a.v === null && b.v !== null) { return 1; }
                if (b.v === null && a.v !== null) { return -1; }
                if (a.v !== b.v) { return (a.v - b.v) * dir; }
            }
            var x = a.label.toLowerCase(), y = b.label.toLowerCase();
            return (x < y ? -1 : (x > y ? 1 : 0)) * (o.sortBy === 'name' ? dir : 1);
        });
        var top = o.topN > 0 ? o.topN : groups.length;
        var kept = groups.slice(0, top);
        var rest = groups.slice(top);
        if (rest.length && o.others) {
            var restRows = [];
            for (i = 0; i < rest.length; i++) { restRows = restRows.concat(rest[i].rows); }
            var oc = card(OTHERS + ' (' + rest.length + ')', restRows, o);
            oc.others = true;
            kept.push(oc);
        }
        if (o.all) {
            var all = card('All', rows, o);
            all.all = true;
            kept.unshift(all);
        }
        return { cards: kept, groups: groups.length, folded: o.others ? 0 : rest.length };
    }

    function card(label, rows, o) {
        var a = aggregate(rows, o.kind, o.countWhen);
        return { label: label, rows: rows, v: a.v, n: a.n, used: a.used, skipped: a.skipped };
    }

    symbolVis.aggregate = aggregate;
    symbolVis.buildCards = buildCards;

    /* ====================================================================== *
     * the symbol
     * ====================================================================== */

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { title: '', note: '', clickable: false };

        var liveCfg = scope.config || {};
        var sourceAsset = '';
        var state = {
            phase: 'idle',      // idle | loading | ok | error | unconfigured | noroot
            error: null,
            searchKey: '',
            root: '',
            elements: [],       // [{name, path, webId, template, parent}]
            truncated: false,
            rows: [],
            failed: 0,
            reading: '',        // the read in flight, by what it asks for
            units: '',
            gen: 0
        };
        var refreshTimer = null, timerSeconds = null, pollTimer = null, lastAsset = null, debounceTimer = null;
        var boundHost = null;
        var shown = [];
        var lastHtml = '';

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-arl-body',
            render: render,
            csv: function () { return csvRows(); },
            onData: function (d) {
                var one = PVX.data.single(d);
                var a = one ? PVX.nav.assetOf(one.path) : '';
                if (a === sourceAsset) { return; }
                sourceAsset = a;
                // Only when the source's element is the root: the display's
                // asset or a Search root outranks it.
                if (state.phase !== 'loading' && key(searchRoot(liveCfg)) !== key(state.root)) { refreshSoon(); }
            },
            onConfigChange: function (cfg) {
                liveCfg = cfg || liveCfg;
                ensureTimers(liveCfg);
                refreshSoon();
            },
            onDestroy: teardown
        });

        function intIn(v, lo, hi, fallback) {
            var n = parseInt(v, 10);
            if (!isFinite(n)) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        function key(s) { return trim(s).toLowerCase(); }

        function searchRoot(cfg) {
            return trim(PVX.nav.currentAsset()) || trim(cfg.SearchRoot) || sourceAsset;
        }

        function parentOf(path) {
            var p = PVX.nav.parentOf ? PVX.nav.parentOf(path) : '';
            return p;
        }

        function lastSeg(p) {
            var s = String(p || '');
            var i = s.lastIndexOf('\\');
            return i === -1 ? s : s.slice(i + 1);
        }

        /* ---------------------------------------------------------------- *
         * PI Web API
         * ---------------------------------------------------------------- */

        function refresh() {
            if (ctx.destroyed) { return; }
            var cfg = liveCfg = scope.config || liveCfg;
            if (PVX.api.discovering()) {
                PVX.api.discover().then(function () { if (!ctx.destroyed) { refresh(); } });
                return;
            }
            if (!PVX.api.isConfigured()) { state.phase = 'unconfigured'; ctx.render(); return; }
            var root = searchRoot(cfg);
            if (!root) { state.phase = 'noroot'; ctx.render(); return; }

            var max = intIn(cfg.MaxElements, 1, 5000, 500);
            var sk = [key(root), key(cfg.SearchTemplate), key(cfg.SearchNameFilter), cfg.SearchDescendants !== false, max].join('|');
            var gen = ++state.gen;
            var fresh = sk !== state.searchKey;
            if (fresh) {
                state.searchKey = sk;
                state.root = root;
                state.elements = [];
                state.phase = 'loading';
                ctx.render();
            }
            // The first data update names the source's element and asks again
            // within a second of init; the same read already on its way answers it.
            var rk = sk + '|' + key(cfg.Attribute) + '|' + (cfg.GroupBy === 'attribute' ? key(cfg.GroupAttribute) : '');
            if (!fresh && state.reading === rk) { return; }
            state.reading = rk;
            var chain = fresh ? search(root, cfg, max) : Promise.resolve();
            chain.then(function () {
                if (gen !== state.gen) { return null; }
                return readValues(cfg);
            }).then(function (rows) {
                if (gen !== state.gen || rows === null) { return; }
                state.reading = '';
                state.rows = rows;
                state.phase = 'ok';
                state.error = null;
                ctx.render();
            })['catch'](function (err) {
                if (gen !== state.gen) { return; }
                state.reading = '';
                // The search is asked again next time, not trusted.
                state.searchKey = '';
                state.phase = 'error';
                state.error = err;
                ctx.render();
            });
        }

        function search(root, cfg, max) {
            // A database is a root too ("every compressor in Gathering"), but
            // PI Web API finds it under assetdatabases, not elements.
            var isDb = PVX.nav.databaseOf(root).toLowerCase() === trim(root).replace(/\\$/, '').toLowerCase();
            var kind = isDb ? 'assetdatabases' : 'elements';
            return PVX.api.get(kind + '?path=' + encodeURIComponent(root) + '&selectedFields=WebId;Name;Path')
                ['catch'](function (err) {
                    if (err && err.pvxError && err.pvxError.code === 'not-found') { return null; }
                    throw err;
                })
                .then(function (el) {
                    if (!el || !el.WebId) {
                        throw { pvxError: { message: 'There is no AF ' + (isDb ? 'database' : 'element') + ' at "' + root + '".',
                            check: 'the display\'s asset, or Search root in the format pane' } };
                    }
                    var q = ['selectedFields=Items.WebId;Items.Name;Items.Path;Items.TemplateName', 'maxCount=' + (max + 1)];
                    if (cfg.SearchDescendants !== false) { q.push('searchFullHierarchy=true'); }
                    if (trim(cfg.SearchTemplate)) { q.push('templateName=' + encodeURIComponent(trim(cfg.SearchTemplate))); }
                    if (trim(cfg.SearchNameFilter)) { q.push('nameFilter=' + encodeURIComponent(trim(cfg.SearchNameFilter))); }
                    return PVX.api.get(kind + '/' + encodeURIComponent(el.WebId) + '/elements?' + q.join('&'), { cache: false });
                })
                .then(function (res) {
                    var items = (res && res.Items) || [];
                    state.truncated = items.length > max;
                    state.elements = [];
                    for (var i = 0; i < items.length && i < max; i++) {
                        var it = items[i];
                        if (!it || !it.WebId || !it.Path) { continue; }
                        state.elements.push({ name: it.Name || lastSeg(it.Path), path: it.Path, webId: it.WebId,
                            template: trim(it.TemplateName), parent: parentOf(it.Path) });
                    }
                });
        }

        /** A stream set value, a digital state's name, or null. */
        function plain(v) {
            if (v !== null && typeof v === 'object') {
                if (v.Name !== undefined) { return v.Name; }
                return v.Value !== undefined ? plain(v.Value) : null;
            }
            return v === undefined ? null : v;
        }

        /**
         * Each element's attribute (and group attribute) in one batch, one
         * sub-request per element and name. Resolves with the rows.
         */
        function readValues(cfg) {
            var attr = trim(cfg.Attribute);
            var gattr = cfg.GroupBy === 'attribute' ? trim(cfg.GroupAttribute) : '';
            var names = [];
            if (attr) { names.push(attr); }
            if (gattr && key(gattr) !== key(attr)) { names.push(gattr); }
            var els = state.elements;
            var rows = [], i;
            for (i = 0; i < els.length; i++) {
                rows.push({ name: els[i].name, path: els[i].path, template: els[i].template, parent: els[i].parent,
                    value: null, good: true, has: !attr, units: '', group: null, groupHas: !gattr });
            }
            state.failed = 0;
            if (!names.length || !els.length) { return Promise.resolve(rows); }
            var reqs = {}, meta = [];
            for (i = 0; i < els.length; i++) {
                for (var j = 0; j < names.length; j++) {
                    reqs['r' + meta.length] = { Method: 'GET', Resource: PVX.api.base() + '/streamsets/' +
                        encodeURIComponent(els[i].webId) + '/value?nameFilter=' + encodeURIComponent(names[j]) +
                        '&selectedFields=Items.Name;Items.Value' };
                    meta.push({ row: rows[i], name: names[j] });
                }
            }
            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                var r = PVX.api.batchResults(res);
                var keys = Object.keys(reqs);
                var units = null, mixed = false;
                for (var k = 0; k < keys.length; k++) {
                    var m = meta[k];
                    var body = r.ok[keys[k]];
                    if (body === undefined) { state.failed += 1; continue; }
                    var items = (body && body.Items) || [];
                    var hit = null;
                    for (var x = 0; x < items.length; x++) { if (key(items[x].Name) === key(m.name)) { hit = items[x]; break; } }
                    if (!hit) { continue; }
                    var tv = hit.Value;
                    var raw = plain(tv && typeof tv === 'object' && 'Value' in tv ? tv.Value : tv);
                    if (key(m.name) === key(attr)) {
                        m.row.has = true;
                        m.row.value = raw;
                        m.row.good = !(tv && tv.Good === false);
                        m.row.units = (tv && tv.UnitsAbbreviation) || '';
                        if (typeof raw === 'number') {
                            if (units === null) { units = m.row.units; } else if (units !== m.row.units) { mixed = true; }
                        }
                    }
                    if (gattr && key(m.name) === key(gattr)) { m.row.groupHas = true; m.row.group = raw; }
                }
                state.units = mixed ? '' : (units || '');
                state.mixedUnits = mixed;
                return rows;
            });
        }

        /* ---------------------------------------------------------------- *
         * timers, every one stopped in teardown()
         * ---------------------------------------------------------------- */

        function ensureTimers(cfg) {
            var secs = intIn(cfg.RefreshSeconds, 5, 86400, 60);
            if (refreshTimer === null || timerSeconds !== secs) {
                if (refreshTimer !== null) { clearInterval(refreshTimer); }
                timerSeconds = secs;
                refreshTimer = setInterval(refresh, secs * 1000);
            }
            if (pollTimer === null) {
                // Follow the display's asset: some PI Vision releases change
                // it through the router without a hashchange.
                lastAsset = key(PVX.nav.currentAsset());
                pollTimer = setInterval(function () {
                    var a = key(PVX.nav.currentAsset());
                    if (a !== lastAsset) { lastAsset = a; refresh(); }
                }, 1000);
            }
        }

        function refreshSoon() {
            if (debounceTimer !== null) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(function () { debounceTimer = null; refresh(); }, 400);
        }

        function teardown() {
            if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
            if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
            if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
            unbindHost();
            state.gen += 1;
        }

        /* ---------------------------------------------------------------- *
         * render
         * ---------------------------------------------------------------- */

        function aggKind(cfg) {
            return Object.prototype.hasOwnProperty.call(AGG_NAMES, cfg.Aggregate) ? cfg.Aggregate : 'sum';
        }

        function groupByOf(cfg) {
            var g = cfg.GroupBy;
            if (g === 'attribute' && !trim(cfg.GroupAttribute)) { return 'none'; }
            return g === 'template' || g === 'parent' || g === 'attribute' ? g : 'none';
        }

        function model(cfg) {
            var gb = groupByOf(cfg);
            var kind = aggKind(cfg);
            // Without an attribute there is nothing to add up: the assets are counted.
            if (!trim(cfg.Attribute)) { kind = 'count'; }
            var rows = state.rows.map(function (r) {
                var g = gb === 'template' ? r.template : gb === 'parent' ? lastSeg(r.parent) : gb === 'attribute' ? r.group : null;
                return { name: r.name, path: r.path, parent: r.parent, template: r.template, value: r.has ? r.value : null,
                    good: r.good, group: g, has: r.has };
            });
            var built = buildCards(rows, {
                groupBy: gb, kind: kind, countWhen: kind === 'count' && trim(cfg.Attribute) ? cfg.CountWhen : '',
                topN: intIn(cfg.TopN, 0, 100, 8), others: cfg.ShowOthers !== false,
                all: gb !== 'none' && cfg.ShowAll !== false, sortBy: cfg.SortBy === 'name' ? 'name' : 'value',
                desc: cfg.SortDescending !== false
            });
            built.kind = kind;
            built.rows = rows;
            return built;
        }

        function valueText(v, kind, cfg) {
            if (v === null) { return '--'; }
            if (kind === 'count' || kind === 'countDistinct') { return String(v); }
            return PVX.fmt.number(v, PVX.config.numberOpts(cfg));
        }

        /** Color of a card: its threshold band, else above or below target. */
        function colorOf(v, cfg) {
            if (v === null) { return ''; }
            if (trim(cfg.Thresholds)) {
                var b = PVX.thresholds.evaluate(cfg.Thresholds, v);
                if (b) { return b.color; }
            }
            var tg = PVX.util.num(cfg.Target);
            if (tg !== null) {
                var good = cfg.TargetDirection === 'lower' ? v <= tg : v >= tg;
                return good ? PVX.color.status.normal : PVX.color.status.alarm;
            }
            return '';
        }

        function render(c) {
            var cfg = liveCfg = c.config || liveCfg;
            var host = c.host;
            if (!host) { return; }
            applyThemeVars(c, c.theme);
            scope.pvx.title = trim(cfg.Title) || defaultTitle(cfg);
            scope.pvx.clickable = cfg.ClickAction === 'navigate' && !!trim(cfg.NavigateTarget) ||
                (cfg.ClickAction === 'asset' && groupByOf(cfg) === 'parent');
            bindHost(host);
            shown = [];
            var html, notes = [];
            if (state.phase !== 'ok') {
                html = statusHtml();
            } else {
                var m = model(cfg);
                html = cardsHtml(m, cfg);
                notes = footerNotes(m, cfg);
            }
            if (html !== lastHtml) {
                host.innerHTML = html;
                lastHtml = html;
            }
            scope.pvx.note = notes.join(' · ');
            digest();
        }

        function defaultTitle(cfg) {
            var a = trim(cfg.Attribute);
            if (!a) { return trim(cfg.SearchTemplate) ? trim(cfg.SearchTemplate) + ' count' : 'Asset count'; }
            var kind = aggKind(cfg);
            return (kind === 'count' && trim(cfg.CountWhen) ? trim(cfg.CountWhen) : AGG_NAMES[kind]) + ' · ' + a;
        }

        function statusHtml() {
            var esc = PVX.util.escapeHtml;
            var head, detail = '', tone = '';
            if (state.phase === 'unconfigured') {
                head = 'PI Web API is not configured';
                detail = PVX.api.unsetHint() + ', then confirm it with ext/piwebapi-check.html.';
                tone = ' pvx-arl-warn';
            } else if (state.phase === 'noroot') {
                head = 'No asset to search under';
                detail = 'Open the display on an asset, drop an AF attribute on this symbol, or set Search root in the format pane.';
                tone = ' pvx-arl-warn';
            } else if (state.phase === 'error') {
                var e = (state.error && state.error.pvxError) || null;
                head = 'PI Web API request failed';
                detail = e ? e.message + (e.check ? ' Check: ' + e.check + '.' : '') : 'The request failed and returned no diagnosis.';
                tone = ' pvx-arl-alarm';
            } else {
                head = 'Searching AF…';
            }
            return '<div class="pvx-arl-msg' + tone + '"><div class="pvx-arl-msg-head">' + esc(head) + '</div>' +
                (detail ? '<div class="pvx-arl-msg-detail">' + esc(detail) + '</div>' : '') + '</div>';
        }

        function cardsHtml(m, cfg) {
            var esc = PVX.util.escapeHtml;
            if (!state.elements.length) {
                return '<div class="pvx-arl-msg"><div class="pvx-arl-msg-head">No assets found</div>' +
                    '<div class="pvx-arl-msg-detail">' + esc(describeSearch(cfg)) + '</div></div>';
            }
            var units = (m.kind === 'count' || m.kind === 'countDistinct' || cfg.ShowUnits === false) ? '' : state.units;
            var tg = PVX.util.num(cfg.Target);
            var parts = ['<div class="pvx-arl-grid">'];
            for (var i = 0; i < m.cards.length; i++) {
                var cd = m.cards[i];
                var col = colorOf(cd.v, cfg);
                var idx = shown.length;
                shown.push(cd);
                var cls = 'pvx-arl-card' + (cd.all ? ' pvx-arl-all' : '') + (cd.others ? ' pvx-arl-others' : '');
                var sub = cd.used + ' of ' + cd.n + (cd.n === 1 ? ' asset' : ' assets');
                if (m.kind === 'count' && !trim(cfg.Attribute)) { sub = cd.n === 1 ? 'asset' : 'assets'; }
                var tip = (cd.label || scope.pvx.title) + '\n' + cd.n + ' assets, ' + cd.used + ' with a value' +
                    (cd.skipped ? ', ' + cd.skipped + ' without a usable one' : '');
                parts.push('<div class="', cls, '" data-pvx-i="', idx, '" title="', esc(tip), '"',
                    col ? ' style="border-left-color:' + esc(col) + '"' : '', '>');
                if (cd.label) { parts.push('<div class="pvx-arl-label">', esc(cd.label), '</div>'); }
                parts.push('<div class="pvx-arl-value pvx-num"', col ? ' style="color:' + esc(col) + '"' : '', '>',
                    esc(valueText(cd.v, m.kind, cfg)),
                    units ? '<span class="pvx-arl-units">' + esc(units) + '</span>' : '', '</div>');
                parts.push('<div class="pvx-arl-sub">', esc(sub), '</div>');
                if (tg !== null && cd.v !== null) {
                    var d = cd.v - tg;
                    parts.push('<div class="pvx-arl-target">Target ', esc(valueText(tg, m.kind, cfg)), ' · ',
                        d >= 0 ? '+' : '−', esc(valueText(Math.abs(d), m.kind, cfg)), '</div>');
                }
                parts.push('</div>');
            }
            parts.push('</div>');
            return parts.join('');
        }

        function describeSearch(cfg) {
            var bits = [];
            if (trim(cfg.SearchTemplate)) { bits.push('template "' + trim(cfg.SearchTemplate) + '"'); }
            if (trim(cfg.SearchNameFilter)) { bits.push('name "' + trim(cfg.SearchNameFilter) + '"'); }
            return 'No element ' + (bits.length ? 'with ' + bits.join(' and ') + ' ' : '') +
                (cfg.SearchDescendants !== false ? 'anywhere under ' : 'directly under ') + state.root + '.';
        }

        function footerNotes(m, cfg) {
            var n = [];
            var attr = trim(cfg.Attribute);
            n.push(state.elements.length + (state.elements.length === 1 ? ' asset' : ' assets') + ' under ' + lastSeg(state.root));
            var without = 0, bad = 0, text = 0, i;
            for (i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                if (!attr) { break; }
                if (!r.has) { without += 1; }
                else if (r.good === false) { bad += 1; }
                else if (m.kind !== 'count' && m.kind !== 'countDistinct' && !isNum(r.value) && r.value !== null) { text += 1; }
            }
            if (without) { n.push(without + ' without "' + attr + '"'); }
            if (bad) { n.push(bad + ' of bad quality, left out'); }
            if (text) { n.push(text + ' not a number, left out'); }
            if (state.mixedUnits) { n.push('units differ between assets'); }
            if (m.kind === 'stddev' && m.cards.some(function (c) { return c.used === 1; })) {
                n.push('a card of one asset has no standard deviation');
            }
            if (groupByOf(cfg) === 'attribute') {
                var noGroup = 0;
                for (i = 0; i < state.rows.length; i++) { if (!state.rows[i].groupHas) { noGroup += 1; } }
                if (noGroup) { n.push(noGroup + ' without "' + trim(cfg.GroupAttribute) + '", in ' + UNASSIGNED); }
            }
            if (m.folded) { n.push(m.folded + ' more group' + (m.folded === 1 ? '' : 's') + ' not shown'); }
            if (state.truncated) { n.push('only the first ' + state.elements.length + ' assets read; raise Most assets or narrow the search'); }
            if (state.failed) { n.push(state.failed + ' read' + (state.failed === 1 ? '' : 's') + ' failed'); }
            return n;
        }

        /* ---------------------------------------------------------------- *
         * CSV: the cards as shown, and the assets behind them
         * ---------------------------------------------------------------- */
        function csvRows() {
            if (state.phase !== 'ok' || !shown.length) { return null; }
            var cfg = liveCfg;
            var out = [['Card', 'Asset', 'Path', trim(cfg.Attribute) || 'Asset', 'Units']];
            for (var i = 0; i < shown.length; i++) {
                var cd = shown[i];
                out.push([cd.label || 'All', '', '', cd.v === null ? '' : cd.v, '']);
                for (var j = 0; j < cd.rows.length; j++) {
                    var r = cd.rows[j];
                    out.push(['', r.name, r.path, r.value === null ? '' : r.value, '']);
                }
            }
            return out;
        }

        /* ---------------------------------------------------------------- *
         * click
         * ---------------------------------------------------------------- */

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            if (!host || !host.addEventListener) { return; }
            host.addEventListener('click', onClick, false);
            boundHost = host;
        }

        function unbindHost() {
            if (boundHost && boundHost.removeEventListener) {
                try { boundHost.removeEventListener('click', onClick, false); } catch (e) { /* ignore */ }
            }
            boundHost = null;
        }

        function onClick(ev) {
            var node = ev.target, guard = 0;
            while (node && node !== boundHost && guard < 8) {
                if (node.getAttribute && node.getAttribute('data-pvx-i') !== null) {
                    activate(parseInt(node.getAttribute('data-pvx-i'), 10));
                    return;
                }
                node = node.parentNode;
                guard += 1;
            }
        }

        /**
         * A parent card goes to that parent: the assets on the card are its
         * children, so it is the natural next display. Any card can open a
         * display instead, on the parent when the card has one.
         */
        function activate(index) {
            var cfg = liveCfg;
            var cd = shown[index];
            if (!cd) { return; }
            var parentPath = groupByOf(cfg) === 'parent' && !cd.all && !cd.others && cd.rows.length ? cd.rows[0].parent : '';
            if (cfg.ClickAction === 'asset') {
                if (parentPath) { PVX.nav.go(PVX.nav.url({ asset: parentPath }), false); }
            } else if (cfg.ClickAction === 'navigate' && trim(cfg.NavigateTarget)) {
                var opts = { display: trim(cfg.NavigateTarget) };
                if (parentPath) { opts.asset = parentPath; }
                PVX.nav.go(PVX.nav.url(opts), false);
            }
        }

        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            var cfg = c.config || {};
            n.style.setProperty('--pvx-surface', cfg.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-surface-alt', cfg.Transparent ? 'transparent' : (t.surfaceAlt || t.surface));
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-accent', cfg.AccentColor || '#3b82c4');
        }

        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        ensureTimers(liveCfg);
        refresh();
        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
