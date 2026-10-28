/* ============================================================================
 * pvxEventList: "PVX Event List" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector, and gives a blank database path a database (see the
 * definition). Every row comes from PI Web API through PVX.api.
 *
 * One row per event frame, read only: name, asset, template, start, end,
 * duration, and any event attributes asked for (Reason Code, Operator). The
 * operator can filter the rows by typing, sort by any column, and group them
 * with a count and a total per group. A click on a row takes this display to
 * the event's time range, to its asset, or both on another display.
 *
 * WHY NOT THE EVENT ANALYTICS TABLE. That one answers "which reason code cost
 * the most hours", so it merges, clips and ranks. This one answers "what
 * happened, and when", so each row is the event as PI records it, its whole
 * duration and not the part inside the window. The two disagree on purpose,
 * and the footer says where: the total here is the sum of the durations
 * listed, and when events overlap that counts the overlap twice.
 *
 * DATA ACCESS is Event Analytics' and the Event Timeline's: the database or
 * asset is resolved once and cached, Event Frames come back with explicit
 * selectedFields, and everything per event (element names, attribute values)
 * goes in ONE PVX.api.batch. Element names are cached for the life of the
 * symbol; attribute values are not, because an edited reason code is the
 * change the list must show. Failed sub-requests are counted in the footer.
 *
 * The table is written as one string per render, as the History Table's is:
 * an ng-repeat over a thousand rows would put every cell in the digest. Only
 * the header, the filter box and the footer are Angular-bound.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /** PI marks an unfinished event frame with a sentinel end time far in the
     *  future rather than a null, and different releases have used both. */
    var OPEN_AFTER_MS = Date.UTC(9000, 0, 1);

    /** The one label for "this event carries no value for what you grouped by". */
    var UNASSIGNED = '(unassigned)';

    /* The fixed columns, by the word the Columns setting uses. Anything else
     * in that list is taken as an event attribute name. */
    var FIXED = {
        name: { label: 'Event', align: 'left' },
        element: { label: 'Asset', align: 'left' },
        template: { label: 'Template', align: 'left' },
        start: { label: 'Start', align: 'left' },
        end: { label: 'End', align: 'left' },
        duration: { label: 'Duration', align: 'right' }
    };

    var DURATION_UNITS = {
        minutes: { ms: 60000, label: 'min' },
        hours: { ms: 3600000, label: 'h' },
        days: { ms: 86400000, label: 'd' }
    };

    var definition = {
        typeName: 'pvxEventList',
        displayName: 'PVX Event List',

        // One data source, which this symbol ignores: PI Vision keeps
        // DatasourceBehaviors.None symbols out of the symbol selector. Pick it
        // and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        // One list per display; a collection would repeat the query per asset.
        supportsCollections: false,
        configTitle: 'Format Event List',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                // The cheapest query PI Vision has, for a value nothing reads.
                DataShape: 'Value',
                Height: 300,
                Width: 640,

                Title: 'Events',
                ShowLabel: true,

                /* -- what to fetch ------------------------------------------ */
                DatabasePath: '',
                TemplateName: '',
                NameFilter: '',
                ElementNameFilter: '',
                SearchMode: 'Overlapped',
                AssetScope: 'none',          // none | asset | assetTree
                MaxScopeElements: 200,
                MaxEvents: 500,
                RefreshSeconds: 60,
                // Only used when the display URL carries no starttime/endtime.
                StartTime: '*-7d',
                EndTime: '*',

                /* -- columns ------------------------------------------------ */
                // name, element, template, start, end, duration; any other
                // word is an event attribute, e.g. "name, Reason Code, duration".
                Columns: 'name, element, start, end, duration',
                DurationUnit: 'auto',        // auto | minutes | hours | days
                TimeFormat: 'short',         // short | datetime | iso
                HighlightOpen: true,

                /* -- rows --------------------------------------------------- */
                Filter: '',                  // the filter box's starting text
                ShowFilterBox: true,
                OpenOnly: false,
                SortBy: 'start',             // a column word from Columns
                SortDescending: true,

                /* -- groups and totals -------------------------------------- */
                GroupBy: 'none',             // none | template | element | attribute
                GroupAttribute: '',
                Totals: true,
                AttributeTotals: 'none',     // none | sum | avg | min | max

                /* -- click -------------------------------------------------- */
                ClickAction: 'none',         // none | time | asset | navigate
                NavigateTarget: '',
                ShowDownload: true
            });
        }
    };

    /* ====================================================================== *
     * pure, exposed on symbolVis for tools/test-overview.js
     * ====================================================================== */

    function trim(s) {
        return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, '');
    }

    /**
     * "name, Reason Code, duration" -> [{key, kind, label, align}].
     * A fixed word is matched without case; anything else is an attribute,
     * kept as typed because AF matches attribute names without case too and
     * the header should read the way the operator wrote it. A column listed
     * twice is shown once.
     */
    function parseColumns(spec) {
        var out = [], seen = {};
        var parts = String(spec === null || spec === undefined ? '' : spec).split(/[,;\n]/);
        for (var i = 0; i < parts.length; i++) {
            var word = trim(parts[i]);
            if (!word) { continue; }
            var low = word.toLowerCase();
            if (low === 'asset') { low = 'element'; }
            var key = FIXED[low] ? low : 'attr:' + low;
            if (seen[key]) { continue; }
            seen[key] = true;
            if (FIXED[low]) {
                out.push({ key: key, kind: low, label: FIXED[low].label, align: FIXED[low].align });
            } else {
                out.push({ key: key, kind: 'attr', name: word, label: word, align: 'left' });
            }
        }
        if (!out.length) { return parseColumns('name, element, start, end, duration'); }
        return out;
    }

    /** Attribute names a configuration needs read per event, without case duplicates. */
    function attributeNames(cols, cfg) {
        var out = [], seen = {};
        var add = function (n) {
            var s = trim(n);
            if (!s || seen[s.toLowerCase()]) { return; }
            seen[s.toLowerCase()] = true;
            out.push(s);
        };
        for (var i = 0; i < cols.length; i++) { if (cols[i].kind === 'attr') { add(cols[i].name); } }
        if (cfg && cfg.GroupBy === 'attribute') { add(cfg.GroupAttribute); }
        return out;
    }

    /** Covered time of a set of intervals, merging overlaps. */
    function unionMs(list) {
        var arr = list.slice().sort(function (a, b) { return a.from - b.from; });
        var total = 0, curFrom = null, curTo = null;
        for (var i = 0; i < arr.length; i++) {
            var it = arr[i];
            if (!(it.to > it.from)) { continue; }
            if (curTo === null || it.from > curTo) {
                if (curTo !== null) { total += curTo - curFrom; }
                curFrom = it.from; curTo = it.to;
            } else if (it.to > curTo) {
                curTo = it.to;
            }
        }
        if (curTo !== null) { total += curTo - curFrom; }
        return total;
    }

    function attrOf(ev, name) {
        var a = ev.attrs && ev.attrs[String(name).toLowerCase()];
        return a === undefined ? null : a;
    }

    /** The comparable value of one cell: a number, ms or lower-case text. */
    function sortValue(ev, col, now) {
        switch (col.kind) {
            case 'name': return ev.name.toLowerCase();
            case 'element': return (ev.elName || '').toLowerCase();
            case 'template': return (ev.template || '').toLowerCase();
            case 'start': return ev.start;
            case 'end': return ev.open ? Infinity : ev.end;
            case 'duration': return (ev.open ? now : ev.end) - ev.start;
            default:
                var a = attrOf(ev, col.name);
                if (!a || a.value === null || a.value === undefined) { return null; }
                return typeof a.value === 'number' ? a.value : String(a.value).toLowerCase();
        }
    }

    function compare(x, y) {
        // Blank sorts last whichever way, so a column nobody filled in does
        // not push the events that have a value off the screen.
        if (x === null && y === null) { return 0; }
        if (x === null) { return 1; }
        if (y === null) { return -1; }
        if (typeof x === 'number' && typeof y === 'number') { return x - y; }
        if (typeof x === 'number') { return -1; }
        if (typeof y === 'number') { return 1; }
        return x < y ? -1 : (x > y ? 1 : 0);
    }

    /**
     * Events + settings -> what the table shows.
     *
     * @param {Array} events  [{name, template, start, end|null, open, elName, elPath, attrs{lower:{value,units}}}]
     * @param {Object} o {cols, filter, openOnly, sortKey, desc, groupBy, groupAttribute,
     *                    attrTotals, now, textOf(ev, col)}
     * @returns {Object} {groups[{label, rows[], count, durMs, union, open, attrs{key:{n,sum,min,max}}}],
     *                    shown, total, hidden, durMs, union, open, attrs}
     */
    function buildList(events, o) {
        var now = o.now;
        var cols = o.cols;
        var needle = trim(o.filter).toLowerCase();
        var rows = [];
        var hidden = 0, closedHidden = 0;
        var i, j;

        for (i = 0; i < events.length; i++) {
            var ev = events[i];
            if (o.openOnly && !ev.open) { closedHidden += 1; continue; }
            if (needle) {
                // Over what the row SHOWS, so the filter finds exactly what
                // the operator can see, units and formatted times included.
                var hit = false;
                for (j = 0; j < cols.length && !hit; j++) {
                    if (String(o.textOf(ev, cols[j])).toLowerCase().indexOf(needle) !== -1) { hit = true; }
                }
                if (!hit) { hidden += 1; continue; }
            }
            rows.push(ev);
        }

        var sortCol = null;
        for (j = 0; j < cols.length; j++) { if (cols[j].key === o.sortKey) { sortCol = cols[j]; } }
        if (!sortCol) {
            // A sort column not shown still sorts, by start, so the order is
            // never the server's arbitrary one.
            sortCol = { kind: FIXED[o.sortKey] ? o.sortKey : 'start', key: o.sortKey };
        }
        var dir = o.desc ? -1 : 1;
        rows.sort(function (a, b) {
            var va = sortValue(a, sortCol, now), vb = sortValue(b, sortCol, now);
            var c = compare(va, vb);
            // Blank stays last in both directions; only real values flip.
            if (va === null || vb === null) { return c; }
            if (c === 0) { c = a.start - b.start; }
            return c * dir;
        });

        var groups = [];
        var byKey = {};
        for (i = 0; i < rows.length; i++) {
            var key = '';
            if (o.groupBy === 'template') { key = rows[i].template || UNASSIGNED; }
            else if (o.groupBy === 'element') { key = rows[i].elName || UNASSIGNED; }
            else if (o.groupBy === 'attribute') {
                var a = attrOf(rows[i], o.groupAttribute);
                key = (a && a.value !== null && a.value !== undefined && trim(a.value) !== '') ? String(a.value) : UNASSIGNED;
            }
            if (!Object.prototype.hasOwnProperty.call(byKey, key)) {
                byKey[key] = { label: key, rows: [] };
                groups.push(byKey[key]);
            }
            byKey[key].rows.push(rows[i]);
        }
        if (o.groupBy !== 'none') {
            // Groups alphabetically, the unassigned one last: it is often the
            // finding, but it is not a value, so it does not sort among them.
            groups.sort(function (a, b) {
                if (a.label === UNASSIGNED) { return 1; }
                if (b.label === UNASSIGNED) { return -1; }
                var x = a.label.toLowerCase(), y = b.label.toLowerCase();
                return x < y ? -1 : (x > y ? 1 : 0);
            });
        }

        var all = summarize(rows, cols, now);
        for (i = 0; i < groups.length; i++) {
            var s = summarize(groups[i].rows, cols, now);
            for (var k in s) { if (s.hasOwnProperty(k)) { groups[i][k] = s[k]; } }
        }
        return {
            groups: groups,
            shown: rows.length,
            total: events.length,
            hidden: hidden,
            closedHidden: closedHidden,
            count: all.count,
            durMs: all.durMs,
            union: all.union,
            open: all.open,
            attrs: all.attrs
        };
    }

    /** Count, summed and merged duration, open count and numeric attribute stats. */
    function summarize(rows, cols, now) {
        var out = { count: rows.length, durMs: 0, union: 0, open: 0, attrs: {} };
        var spans = [];
        for (var i = 0; i < rows.length; i++) {
            var ev = rows[i];
            var to = ev.open ? Math.max(ev.start, now) : ev.end;
            out.durMs += to - ev.start;
            spans.push({ from: ev.start, to: to });
            if (ev.open) { out.open += 1; }
            for (var j = 0; j < cols.length; j++) {
                if (cols[j].kind !== 'attr') { continue; }
                var a = attrOf(ev, cols[j].name);
                if (!a || typeof a.value !== 'number' || !isFinite(a.value)) { continue; }
                var st = out.attrs[cols[j].key] || (out.attrs[cols[j].key] = { n: 0, sum: 0, min: Infinity, max: -Infinity });
                st.n += 1;
                st.sum += a.value;
                if (a.value < st.min) { st.min = a.value; }
                if (a.value > st.max) { st.max = a.value; }
            }
        }
        out.union = unionMs(spans);
        return out;
    }

    symbolVis.parseColumns = parseColumns;
    symbolVis.attributeNames = attributeNames;
    symbolVis.buildList = buildList;
    symbolVis.unionMs = unionMs;

    /* ====================================================================== *
     * the symbol
     * ====================================================================== */

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            title: '',
            filter: '',
            showFilter: false,
            note: '',
            summary: '',
            saveNote: '',
            canDownload: false,
            clickable: false,
            onFilter: function () { ctx.render(); },
            download: function () { save(); }
        };

        var state = {
            phase: 'idle',        // idle | loading | ok | error | unconfigured | nodb
            error: null,
            events: [],
            capped: false,
            maxEvents: 0,
            failedBatch: 0,
            scopeCapped: false,
            scopeFailed: 0,
            missingAttrs: [],
            db: { path: '', from: '' }
        };
        var sourceAsset = '';
        var liveCfg = scope.config || {};
        var generation = 0;

        var dbCache = {};
        var assetCache = {};
        var elemInfo = {};        // element WebId -> {name, path}

        // The operator's sort, by header click. Not saved: it is a reading
        // choice, like scrolling, and the saved default stays the designer's.
        var sortOverride = null;  // {key, desc}
        var lastFilterSeed = null;

        var refreshTimer = null, timerSeconds = null;
        var hashTimer = null, hashListener = null, lastHashKey = null;
        var debounceTimer = null;
        var boundHost = null;
        var rowsShown = [];
        var lastHtml = '';
        var lastList = null, lastCols = null;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-evl-body',
            render: render,
            csv: function (c) { return lastList ? csvRows(lastList, lastCols, c.config || liveCfg) : null; },
            onData: function (d) {
                var one = PVX.data.single(d);
                var a = one ? PVX.nav.assetOf(one.path) : '';
                if (a !== sourceAsset) {
                    sourceAsset = a;
                    if (!trim(liveCfg.DatabasePath) || (liveCfg.AssetScope && liveCfg.AssetScope !== 'none')) { refreshSoon(); }
                }
            },
            onConfigChange: function (newCfg) {
                liveCfg = newCfg || liveCfg;
                ensureTimers(liveCfg);
                refreshSoon();
            },
            onDestroy: teardown
        });

        /* ---------------------------------------------------------------- *
         * small helpers
         * ---------------------------------------------------------------- */

        function intIn(v, lo, hi, fallback) {
            var n = parseInt(v, 10);
            if (!isFinite(n)) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        function firstNonEmpty(list) {
            for (var i = 0; i < list.length; i++) {
                var s = trim(list[i]);
                if (s) { return s; }
            }
            return '';
        }

        function isoOf(ms) { return new Date(ms).toISOString(); }

        function apiUrl(path) { return PVX.api.base() + '/' + path; }

        function webIdFromLink(url) {
            var s = trim(url);
            if (!s) { return ''; }
            s = s.split('?')[0].replace(/\/+$/, '');
            var i = s.lastIndexOf('/');
            return i === -1 ? '' : s.slice(i + 1);
        }

        /** The window events are asked for: the display's, else the pane's. */
        function resolveWindow(cfg) {
            var params = {};
            try { params = PVX.nav.parseHash().params || {}; } catch (e) { params = {}; }
            var startExpr = firstNonEmpty([params.starttime, params.StartTime, cfg.StartTime, '*-7d']);
            var endExpr = firstNonEmpty([params.endtime, params.EndTime, cfg.EndTime, '*']);
            var now = Date.now();
            var from = PVX.nav.parseTime(startExpr, now);
            var to = PVX.nav.parseTime(endExpr, now);
            var parsed = from !== null && to !== null && to > from;
            // An expression this cannot read is still PI Web API's to read:
            // it goes through as typed.
            return { startExpr: startExpr, endExpr: endExpr, from: from, to: to, useRaw: !parsed, now: now };
        }

        function hashKey() {
            var p = {};
            try { p = PVX.nav.parseHash().params || {}; } catch (e) { p = {}; }
            return String(p.starttime || p.StartTime || '') + '|' + String(p.endtime || p.EndTime || '') +
                '|' + String(p.asset || '');
        }

        function needsElement(cfg, cols) {
            if (cfg.GroupBy === 'element') { return true; }
            if (cfg.ClickAction === 'asset' || cfg.ClickAction === 'navigate') { return true; }
            for (var i = 0; i < cols.length; i++) { if (cols[i].kind === 'element') { return true; } }
            return false;
        }

        /* ---------------------------------------------------------------- *
         * PI Web API
         * ---------------------------------------------------------------- */

        function resolveDatabase(dbPath) {
            if (dbCache[dbPath]) { return dbCache[dbPath]; }
            var p = PVX.api.get('assetdatabases?path=' + encodeURIComponent(dbPath)).then(function (db) {
                if (!db || !db.WebId) {
                    throw { pvxError: {
                        code: 'no-database',
                        message: 'PI Web API answered, but there is no AF database at "' + dbPath + '".',
                        check: 'the AF database path, written \\\\<AF server>\\<database>'
                    } };
                }
                return db.WebId;
            });
            // A failed lookup is not cached: a passing outage would otherwise
            // stay on the list for as long as the display is open.
            p['catch'](function () { if (dbCache[dbPath] === p) { delete dbCache[dbPath]; } });
            dbCache[dbPath] = p;
            return p;
        }

        function scopeAsset() { return trim(PVX.nav.currentAsset()) || sourceAsset; }

        function scopeElements(cfg) {
            var asset = scopeAsset();
            var tree = cfg.AssetScope === 'assetTree';
            var cap = intIn(cfg.MaxScopeElements, 1, 2000, 200);
            var key = asset + '|' + (tree ? 'tree:' + cap : 'one');
            if (assetCache[key]) { return assetCache[key]; }
            var p = PVX.api.elementByPath(asset).then(function (el) {
                if (!el || !el.WebId) {
                    throw { pvxError: {
                        code: 'no-asset',
                        message: 'The display\'s asset "' + asset + '" is not an AF element PI Web API can see.',
                        check: 'the asset in the URL, or the element of this symbol\'s data source'
                    } };
                }
                if (!tree) { return { ids: [el.WebId], capped: false }; }
                return PVX.api.get('elements/' + encodeURIComponent(el.WebId) +
                    '/elements?searchFullHierarchy=true&maxCount=' + (cap + 1) +
                    '&selectedFields=Items.WebId').then(function (res) {
                    var ids = [el.WebId];
                    var items = (res && res.Items) || [];
                    for (var i = 0; i < items.length && i < cap; i++) {
                        if (items[i].WebId) { ids.push(items[i].WebId); }
                    }
                    return { ids: ids, capped: items.length > cap };
                });
            });
            p['catch'](function () { if (assetCache[key] === p) { delete assetCache[key]; } });
            assetCache[key] = p;
            return p;
        }

        function frameFields(cfg, cols) {
            var f = ['Items.Name', 'Items.StartTime', 'Items.EndTime', 'Items.TemplateName', 'Items.Links.Self'];
            if (needsElement(cfg, cols)) { f.push('Items.Links.PrimaryReferencedElement'); }
            return f.join(';');
        }

        /**
         * The Event Frame query for one database or element. maxCount is one
         * more than the list will hold: that extra row is how "exactly
         * MaxEvents" is told from "PI Web API stopped counting".
         */
        function framesPath(base, cfg, cols, win, max) {
            var q = [
                ['startTime', win.useRaw ? win.startExpr : isoOf(win.from)],
                ['endTime', win.useRaw ? win.endExpr : isoOf(win.to)],
                ['templateName', trim(cfg.TemplateName)],
                ['nameFilter', trim(cfg.NameFilter)],
                ['referencedElementNameFilter', trim(cfg.ElementNameFilter)],
                ['searchMode', trim(cfg.SearchMode) || 'Overlapped'],
                ['maxCount', max + 1],
                ['selectedFields', frameFields(cfg, cols)]
            ];
            var parts = [];
            for (var i = 0; i < q.length; i++) {
                if (q[i][1] === '' || q[i][1] === null || q[i][1] === undefined) { continue; }
                parts.push(q[i][0] + '=' + encodeURIComponent(q[i][1]));
            }
            return base + '/eventframes?' + parts.join('&');
        }

        function queryEvents(dbWebId, cfg, cols, win, max) {
            if (!cfg.AssetScope || cfg.AssetScope === 'none') {
                return PVX.api.get(framesPath('assetdatabases/' + encodeURIComponent(dbWebId), cfg, cols, win, max), { cache: false });
            }
            return scopeElements(cfg).then(function (sc) {
                state.scopeCapped = sc.capped;
                if (sc.ids.length === 1) {
                    return PVX.api.get(framesPath('elements/' + encodeURIComponent(sc.ids[0]), cfg, cols, win, max), { cache: false });
                }
                var reqs = {};
                for (var i = 0; i < sc.ids.length; i++) {
                    reqs['e' + i] = { Method: 'GET', Resource: apiUrl(framesPath('elements/' + encodeURIComponent(sc.ids[i]), cfg, cols, win, max)) };
                }
                return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                    var split = PVX.api.batchResults(res);
                    var seen = {}, items = [];
                    for (var id in split.ok) {
                        if (!Object.prototype.hasOwnProperty.call(split.ok, id)) { continue; }
                        var list = (split.ok[id] && split.ok[id].Items) || [];
                        for (var j = 0; j < list.length; j++) {
                            // An event referencing two elements of the tree
                            // comes back twice and is one row.
                            var self = (list[j].Links && list[j].Links.Self) || (list[j].Name + list[j].StartTime);
                            if (seen[self]) { continue; }
                            seen[self] = true;
                            items.push(list[j]);
                        }
                    }
                    state.scopeFailed = split.failedCount || 0;
                    items.sort(function (a, b) { return String(b.StartTime).localeCompare(String(a.StartTime)); });
                    return { Items: items };
                });
            });
        }

        function toEvent(item) {
            var startD = PVX.fmt.toDate(item.StartTime);
            if (!startD) { return null; }
            var endD = PVX.fmt.toDate(item.EndTime);
            var open = !endD || endD.getTime() >= OPEN_AFTER_MS;
            var links = item.Links || {};
            return {
                name: item.Name || '(unnamed event)',
                template: trim(item.TemplateName),
                start: startD.getTime(),
                end: open ? null : endD.getTime(),
                open: open,
                webId: webIdFromLink(links.Self),
                elWebId: webIdFromLink(links.PrimaryReferencedElement),
                elName: '',
                elPath: '',
                attrs: {}
            };
        }

        /** A streamset value, a digital state's name, or null. */
        function plainValue(v) {
            if (v !== null && typeof v === 'object') {
                if (v.Name !== undefined) { return v.Name; }
                if (v.Value !== undefined) { return plainValue(v.Value); }
                return null;
            }
            return v === undefined ? null : v;
        }

        /**
         * ONE batch for everything per event: each new element's name and
         * path, and each event's attribute values. With one attribute wanted
         * the request names it; with several it asks for all the event's
         * values and picks, which is one sub-request instead of several.
         * Resolves with the number of failed sub-requests, or -1 when the
         * batch itself failed.
         */
        function enrich(events, cfg, cols) {
            var names = attributeNames(cols, cfg);
            var wantEl = needsElement(cfg, cols);
            var reqs = {}, meta = [];
            var i;

            if (wantEl) {
                var seenEl = {};
                for (i = 0; i < events.length; i++) {
                    var id = events[i].elWebId;
                    if (!id || seenEl[id] || elemInfo[id]) { continue; }
                    seenEl[id] = true;
                    reqs['e' + meta.length] = { Method: 'GET', Resource: apiUrl('elements/' + encodeURIComponent(id) + '?selectedFields=Name;Path') };
                    meta.push({ kind: 'element', id: id });
                }
            }
            if (names.length) {
                var filter = names.length === 1 ? '&nameFilter=' + encodeURIComponent(names[0]) : '';
                for (i = 0; i < events.length; i++) {
                    if (!events[i].webId) { continue; }
                    reqs['a' + meta.length] = { Method: 'GET', Resource: apiUrl('streamsets/' + encodeURIComponent(events[i].webId) +
                        '/value?selectedFields=Items.Name;Items.Value' + filter) };
                    meta.push({ kind: 'attr', ev: events[i] });
                }
            }

            if (!meta.length) { applyElements(events); return Promise.resolve(0); }

            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                var r = PVX.api.batchResults(res);
                var found = {};
                var keys = Object.keys(reqs);
                for (var k = 0; k < keys.length; k++) {
                    var body = r.ok[keys[k]];
                    var m = meta[k];
                    if (body === undefined) { continue; }
                    if (m.kind === 'element') {
                        elemInfo[m.id] = { name: (body && body.Name) || '', path: (body && body.Path) || '' };
                        continue;
                    }
                    var items = (body && body.Items) || [];
                    for (var j = 0; j < items.length; j++) {
                        var nm = String(items[j].Name || '').toLowerCase();
                        var tv = items[j].Value;
                        m.ev.attrs[nm] = {
                            value: plainValue(tv && typeof tv === 'object' && 'Value' in tv ? tv.Value : tv),
                            units: (tv && tv.UnitsAbbreviation) || '',
                            good: !(tv && tv.Good === false)
                        };
                        found[nm] = true;
                    }
                }
                state.missingAttrs = names.filter(function (n) { return !found[n.toLowerCase()]; });
                applyElements(events);
                return r.failedCount;
            })['catch'](function () {
                applyElements(events);
                state.missingAttrs = [];
                return -1;
            });
        }

        function applyElements(events) {
            for (var i = 0; i < events.length; i++) {
                var info = elemInfo[events[i].elWebId];
                if (info) { events[i].elName = info.name; events[i].elPath = info.path; }
            }
        }

        function databaseFor(cfg) {
            var typed = trim(cfg.DatabasePath);
            if (typed) { return { path: typed, from: '' }; }
            return PVX.nav.defaultDatabase(scope, sourceAsset);
        }

        function refresh() {
            if (ctx.destroyed) { return; }
            var cfg = liveCfg = scope.config || liveCfg;

            if (PVX.api.discovering()) {
                PVX.api.discover().then(function () { if (!ctx.destroyed) { refresh(); } });
                return;
            }
            if (!PVX.api.isConfigured()) {
                state.phase = 'unconfigured';
                ctx.render();
                return;
            }
            state.db = databaseFor(cfg);
            if (!state.db.path) {
                state.phase = 'nodb';
                ctx.render();
                return;
            }

            var gen = ++generation;
            var cols = parseColumns(cfg.Columns);
            var win = resolveWindow(cfg);
            var max = intIn(cfg.MaxEvents, 1, 5000, 500);
            if (state.phase !== 'ok') { state.phase = 'loading'; }
            ctx.render();

            resolveDatabase(state.db.path)
                .then(function (webId) {
                    if (stale(gen)) { return null; }
                    state.scopeCapped = false;
                    state.scopeFailed = 0;
                    return queryEvents(webId, cfg, cols, win, max);
                })
                .then(function (res) {
                    if (stale(gen) || res === null) { return null; }
                    var items = (res && res.Items) || [];
                    state.capped = items.length > max;
                    if (state.capped) { items = items.slice(0, max); }
                    var events = [];
                    for (var i = 0; i < items.length; i++) {
                        var ev = toEvent(items[i]);
                        if (ev) { events.push(ev); }
                    }
                    state.maxEvents = max;
                    return enrich(events, cfg, cols).then(function (failed) {
                        return { events: events, failed: failed };
                    });
                })
                .then(function (out) {
                    if (stale(gen) || out === null) { return; }
                    state.events = out.events;
                    state.failedBatch = out.failed;
                    state.phase = 'ok';
                    state.error = null;
                    ctx.render();
                })['catch'](function (err) {
                    if (stale(gen)) { return; }
                    state.phase = 'error';
                    state.error = err;
                    state.events = [];
                    ctx.render();
                });
        }

        function stale(gen) { return ctx.destroyed || gen !== generation; }

        /* ---------------------------------------------------------------- *
         * timers, every one stopped in teardown()
         * ---------------------------------------------------------------- */

        function ensureTimers(cfg) {
            var secs = intIn(cfg.RefreshSeconds, 5, 86400, 60);
            if (refreshTimer !== null && timerSeconds === secs) { return; }
            if (refreshTimer !== null) { clearInterval(refreshTimer); }
            timerSeconds = secs;
            refreshTimer = setInterval(function () { refresh(); }, secs * 1000);
        }

        /* Polled as well as listened for: some PI Vision releases change the
         * time range through the router without a hashchange. */
        function pollHash() {
            if (ctx.destroyed) { return; }
            var k = hashKey();
            if (k === lastHashKey) { return; }
            lastHashKey = k;
            refresh();
        }

        function refreshSoon() {
            if (debounceTimer !== null) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(function () { debounceTimer = null; refresh(); }, 400);
        }

        function teardown() {
            if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
            if (hashTimer !== null) { clearInterval(hashTimer); hashTimer = null; }
            if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
            if (hashListener) {
                try { window.removeEventListener('hashchange', hashListener, false); } catch (e) { /* ignore */ }
                hashListener = null;
            }
            unbindHost();
            generation += 1;
            state.events = [];
            rowsShown = [];
        }

        /* ---------------------------------------------------------------- *
         * cells
         * ---------------------------------------------------------------- */

        function durUnit(cfg) {
            return DURATION_UNITS.hasOwnProperty(cfg.DurationUnit) ? DURATION_UNITS[cfg.DurationUnit] : null;
        }

        function durText(ms, cfg) {
            var u = durUnit(cfg);
            if (!u) { return PVX.fmt.duration(ms); }
            var v = ms / u.ms;
            return PVX.fmt.number(v, { decimals: v < 10 ? 2 : 1 });
        }

        /** An attribute value as AF holds it, to seven significant figures,
         *  not padded to a fixed number of decimals: 12.5 t was typed as 12.5. */
        function numText(v) {
            if (!isFinite(v)) { return String(v); }
            var s = Math.abs(v) >= 1e7 ? v.toFixed(0) : String(Number(v.toPrecision(7)));
            return /e/.test(s) ? s : PVX.fmt.group(s);
        }

        function timeText(ms, cfg) {
            var style = cfg.TimeFormat === 'iso' || cfg.TimeFormat === 'datetime' ? cfg.TimeFormat : 'short';
            return PVX.fmt.time(ms, style);
        }

        /** Units shared by a whole attribute column go in its header, once. */
        function columnUnits(events, cols) {
            var out = {};
            for (var j = 0; j < cols.length; j++) {
                if (cols[j].kind !== 'attr') { continue; }
                var u = null, mixed = false;
                for (var i = 0; i < events.length; i++) {
                    var a = attrOf(events[i], cols[j].name);
                    if (!a || a.value === null) { continue; }
                    // Units only mean something next to a number; a digital
                    // state with none must not hide a column's tons.
                    if (typeof a.value !== 'number') { continue; }
                    var units = a.units || '';
                    if (u === null) { u = units; } else if (u !== units) { mixed = true; }
                }
                // A column with any number in it is a numeric column, aligned
                // right, header and totals with it.
                out[cols[j].key] = { units: mixed ? '' : (u || ''), mixed: mixed, numeric: u !== null };
            }
            return out;
        }

        function cellText(ev, col, cfg, units, now) {
            switch (col.kind) {
                case 'name': return ev.name;
                case 'element': return ev.elName;
                case 'template': return ev.template;
                case 'start': return timeText(ev.start, cfg);
                case 'end': return ev.open ? 'active' : timeText(ev.end, cfg);
                case 'duration': return durText((ev.open ? Math.max(ev.start, now) : ev.end) - ev.start, cfg);
                default:
                    var a = attrOf(ev, col.name);
                    if (!a || a.value === null || a.value === undefined) { return ''; }
                    var s = typeof a.value === 'number' ? numText(a.value) : String(a.value);
                    var cu = units && units[col.key];
                    if (cu && cu.mixed && a.units) { s += ' ' + a.units; }
                    return s;
            }
        }

        function alignOf(col, units) {
            var cu = units && units[col.key];
            return cu && cu.numeric ? 'right' : col.align;
        }

        function headerText(col, cfg, units) {
            if (col.kind === 'duration') {
                var u = durUnit(cfg);
                return u ? col.label + ' (' + u.label + ')' : col.label;
            }
            var cu = units && units[col.key];
            return cu && cu.units ? col.label + ' (' + cu.units + ')' : col.label;
        }

        function attrTotalKind(cfg) {
            var k = cfg.AttributeTotals;
            return k === 'sum' || k === 'avg' || k === 'min' || k === 'max' ? k : 'none';
        }

        function totalCells(sum, cols, cfg, label) {
            var kind = attrTotalKind(cfg);
            var out = [];
            var labelled = false;
            for (var j = 0; j < cols.length; j++) {
                var c = cols[j];
                var txt = '';
                if (c.kind === 'duration') {
                    txt = durText(sum.durMs, cfg);
                } else if (c.kind === 'attr' && kind !== 'none' && sum.attrs[c.key]) {
                    var st = sum.attrs[c.key];
                    var v = kind === 'sum' ? st.sum : (kind === 'avg' ? st.sum / st.n : (kind === 'min' ? st.min : st.max));
                    txt = numText(v);
                } else if (!labelled && c.kind !== 'duration') {
                    txt = label + ' · ' + sum.count + (sum.count === 1 ? ' event' : ' events');
                    labelled = true;
                }
                out.push(txt);
            }
            if (!labelled && out.length) { out[0] = label + ' · ' + sum.count + ' · ' + out[0]; }
            return out;
        }

        /* ---------------------------------------------------------------- *
         * render
         * ---------------------------------------------------------------- */

        function render(c) {
            var cfg = liveCfg = c.config || liveCfg;
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }
            applyThemeVars(c, t);

            // The filter box starts from the saved Filter, and follows it when
            // the designer changes it; what an operator types is theirs.
            if (lastFilterSeed !== String(cfg.Filter || '')) {
                lastFilterSeed = String(cfg.Filter || '');
                scope.pvx.filter = lastFilterSeed;
            }
            scope.pvx.title = trim(cfg.Title);
            scope.pvx.showFilter = cfg.ShowFilterBox !== false && state.phase === 'ok' && state.events.length > 0;
            scope.pvx.clickable = cfg.ClickAction === 'time' || cfg.ClickAction === 'asset' ||
                (cfg.ClickAction === 'navigate' && !!trim(cfg.NavigateTarget));
            scope.pvx.summary = '';
            bindHost(host);

            var notes = [];
            var html;
            lastList = null;
            rowsShown = [];

            if (state.phase !== 'ok') {
                html = statusHtml();
            } else {
                var cols = parseColumns(cfg.Columns);
                var now = Date.now();
                var units = columnUnits(state.events, cols);
                var sort = sortOverride || { key: sortKeyOf(cfg, cols), desc: cfg.SortDescending !== false };
                var list = buildList(state.events, {
                    cols: cols,
                    filter: scope.pvx.filter,
                    openOnly: cfg.OpenOnly === true,
                    sortKey: sort.key,
                    desc: sort.desc,
                    groupBy: groupByOf(cfg),
                    groupAttribute: trim(cfg.GroupAttribute),
                    now: now,
                    textOf: function (ev, col) { return cellText(ev, col, cfg, units, now); }
                });
                lastList = list;
                lastCols = { cols: cols, units: units, now: now };
                html = list.total ? tableHtml(list, cols, units, cfg, sort, now) : emptyHtml(cfg);
                notes = footerNotes(list, cfg, cols);
                if (list.total && cfg.Totals !== false) { scope.pvx.summary = summaryText(list, cfg); }
            }

            if (html !== lastHtml) {
                var scroll = host.querySelector('.pvx-evl-scroll');
                if (!scroll) {
                    scroll = document.createElement('div');
                    scroll.className = 'pvx-evl-scroll';
                    host.appendChild(scroll);
                }
                scroll.innerHTML = html;
                lastHtml = html;
            }
            scope.pvx.note = notes.join(' · ');
            scope.pvx.canDownload = cfg.ShowDownload !== false && !!lastList && lastList.shown > 0;
            digest();
        }

        function sortKeyOf(cfg, cols) {
            var want = trim(cfg.SortBy).toLowerCase();
            if (want === 'asset') { want = 'element'; }
            for (var i = 0; i < cols.length; i++) {
                if (cols[i].key === want || cols[i].key === 'attr:' + want) { return cols[i].key; }
            }
            return FIXED[want] ? want : 'start';
        }

        function groupByOf(cfg) {
            var g = cfg.GroupBy;
            if (g === 'attribute' && !trim(cfg.GroupAttribute)) { return 'none'; }
            return g === 'template' || g === 'element' || g === 'attribute' ? g : 'none';
        }

        function statusHtml() {
            var esc = PVX.util.escapeHtml;
            var head, detail = '', tone = '';
            if (state.phase === 'unconfigured') {
                head = 'PI Web API is not configured';
                detail = PVX.api.unsetHint() + ', then confirm it with ext/piwebapi-check.html.';
                tone = ' pvx-evl-warn';
            } else if (state.phase === 'nodb') {
                head = 'No AF database configured';
                detail = 'Drop an AF attribute onto this symbol to use its database, or set the AF database ' +
                    'path in the format pane, for example \\\\AFSERVER01\\Production.';
                tone = ' pvx-evl-warn';
            } else if (state.phase === 'error') {
                var e = (state.error && state.error.pvxError) || null;
                head = 'PI Web API request failed';
                detail = e ? e.message + (e.check ? ' Check: ' + e.check + '.' : '') : 'The request failed and returned no diagnosis.';
                tone = ' pvx-evl-alarm';
            } else {
                head = 'Loading events…';
            }
            return '<div class="pvx-evl-empty' + tone + '"><div class="pvx-evl-empty-head">' + esc(head) + '</div>' +
                (detail ? '<div class="pvx-evl-empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
        }

        function emptyHtml(cfg) {
            var bits = [];
            if (trim(cfg.TemplateName)) { bits.push('template "' + trim(cfg.TemplateName) + '"'); }
            if (trim(cfg.NameFilter)) { bits.push('name "' + trim(cfg.NameFilter) + '"'); }
            if (trim(cfg.ElementNameFilter)) { bits.push('asset "' + trim(cfg.ElementNameFilter) + '"'); }
            var where = cfg.AssetScope && cfg.AssetScope !== 'none' ? scopeAsset() : state.db.path;
            var detail = bits.length ? 'Nothing matched ' + bits.join(' and ') + ' in this time range.'
                : 'No event frames overlap this time range on ' + where + '.';
            return '<div class="pvx-evl-empty"><div class="pvx-evl-empty-head">No events in this time range</div>' +
                '<div class="pvx-evl-empty-detail">' + PVX.util.escapeHtml(detail) + '</div></div>';
        }

        function tableHtml(list, cols, units, cfg, sort, now) {
            var esc = PVX.util.escapeHtml;
            var parts = ['<table class="pvx-evl-table"><thead><tr>'];
            var j;
            for (j = 0; j < cols.length; j++) {
                var col = cols[j];
                var on = col.key === sort.key;
                parts.push('<th data-pvx-sort="', esc(col.key), '" class="pvx-evl-', alignOf(col, units),
                    on ? ' pvx-evl-sorted' : '', '" title="Sort by ', esc(col.label), '">',
                    esc(headerText(col, cfg, units)),
                    on ? '<span class="pvx-evl-arrow">' + (sort.desc ? '▾' : '▴') + '</span>' : '',
                    '</th>');
            }
            parts.push('</tr></thead><tbody>');

            if (!list.shown) {
                parts.push('<tr class="pvx-evl-none"><td colspan="', cols.length, '">',
                    esc(list.hidden ? 'No event matches "' + trim(scope.pvx.filter) + '"' : 'No event is still active'),
                    '</td></tr>');
            }

            var grouped = groupByOf(cfg) !== 'none';
            var totals = cfg.Totals !== false;
            for (var g = 0; g < list.groups.length; g++) {
                var grp = list.groups[g];
                if (grouped) {
                    parts.push('<tr class="pvx-evl-group"><td colspan="', cols.length, '">', esc(grp.label),
                        '<span class="pvx-evl-group-n">', grp.count, '</span></td></tr>');
                }
                for (var r = 0; r < grp.rows.length; r++) {
                    var ev = grp.rows[r];
                    var idx = rowsShown.length;
                    rowsShown.push(ev);
                    var cls = ev.open && cfg.HighlightOpen !== false ? ' class="pvx-evl-open"' : '';
                    parts.push('<tr data-pvx-i="', idx, '"', cls, ' title="', esc(rowTip(ev, cfg)), '">');
                    for (j = 0; j < cols.length; j++) {
                        var a = cols[j].kind === 'attr' ? attrOf(ev, cols[j].name) : null;
                        var tdc = 'pvx-evl-' + alignOf(cols[j], units) + (a && a.good === false ? ' pvx-evl-bad' : '');
                        parts.push('<td class="', tdc, '">', esc(cellText(ev, cols[j], cfg, units, now)), '</td>');
                    }
                    parts.push('</tr>');
                }
                if (grouped && totals && list.groups.length > 1) {
                    parts.push(totalRowHtml(grp, cols, units, cfg, 'Subtotal', false));
                }
            }
            if (totals && list.shown) { parts.push(totalRowHtml(list, cols, units, cfg, 'Total', true)); }
            parts.push('</tbody></table>');
            return parts.join('');
        }

        function totalRowHtml(sum, cols, units, cfg, label, grand) {
            var esc = PVX.util.escapeHtml;
            var cells = totalCells(sum, cols, cfg, label);
            var out = ['<tr class="pvx-evl-total', grand ? ' pvx-evl-grand' : '', '">'];
            for (var j = 0; j < cols.length; j++) {
                out.push('<td class="pvx-evl-', alignOf(cols[j], units), '">', esc(cells[j]), '</td>');
            }
            out.push('</tr>');
            return out.join('');
        }

        function rowTip(ev, cfg) {
            var bits = [ev.name];
            if (ev.elPath) { bits.push(ev.elPath); }
            bits.push(PVX.fmt.time(ev.start, 'datetime') + ' – ' + (ev.open ? 'still active' : PVX.fmt.time(ev.end, 'datetime')));
            if (cfg.ClickAction === 'time') { bits.push('Click to show this event\'s time range'); }
            else if (cfg.ClickAction === 'asset') { bits.push(ev.elPath ? 'Click to show this asset' : 'No asset to show'); }
            else if (cfg.ClickAction === 'navigate' && trim(cfg.NavigateTarget)) { bits.push('Click to open ' + trim(cfg.NavigateTarget)); }
            return bits.join('\n');
        }

        function summaryText(list, cfg) {
            var bits = [list.count + (list.count === 1 ? ' event' : ' events'), durText(list.durMs, cfg) + ' listed'];
            if (list.open) { bits.push(list.open + ' active'); }
            return bits.join(' · ');
        }

        function footerNotes(list, cfg, cols) {
            var notes = [];
            var f = trim(scope.pvx.filter);
            if (list.hidden) { notes.push(list.shown + ' of ' + (list.total - list.closedHidden) + ' match "' + f + '"'); }
            if (list.closedHidden) { notes.push(list.closedHidden + ' ended, not shown'); }
            if (state.capped) {
                notes.push('only the first ' + state.maxEvents + ' events read; raise Max events or narrow the filter');
            }
            if (state.scopeCapped) {
                notes.push('more than ' + intIn(cfg.MaxScopeElements, 1, 2000, 200) + ' elements under the asset; the rest not searched');
            }
            if (state.scopeFailed) { notes.push(state.scopeFailed + ' element' + (state.scopeFailed === 1 ? '' : 's') + ' not searched'); }
            if (state.failedBatch > 0) {
                notes.push(state.failedBatch + ' lookup' + (state.failedBatch === 1 ? '' : 's') + ' failed; some names or values are blank');
            } else if (state.failedBatch < 0) {
                notes.push('asset names and attribute values not read; PI Web API refused the batch');
            }
            if (state.missingAttrs.length && state.events.length) {
                notes.push('no event has ' + state.missingAttrs.map(function (n) { return '"' + n + '"'; }).join(', '));
            }
            if (list.open && hasColumn(cols, 'duration')) { notes.push('active events timed to now'); }
            if (cfg.Totals !== false && list.durMs - list.union > 1000) {
                // The total is the column's sum. When events overlap that
                // counts the overlap twice, so say by how much; Event
                // Analytics is the symbol that merges them.
                notes.push('events overlap: ' + PVX.fmt.duration(list.durMs - list.union) + ' of the total is counted twice');
            }
            if (state.db.from && (!cfg.AssetScope || cfg.AssetScope === 'none')) {
                notes.push('database ' + state.db.path + ' from ' + state.db.from);
            }
            return notes;
        }

        function hasColumn(cols, kind) {
            for (var i = 0; i < cols.length; i++) { if (cols[i].kind === kind) { return true; } }
            return false;
        }

        /* ---------------------------------------------------------------- *
         * CSV: the rows shown, in their order, with ISO times and durations
         * in seconds, which a spreadsheet can format but cannot recover.
         * ---------------------------------------------------------------- */
        function csvRows(list, lc, cfg) {
            var cols = lc.cols;
            var head = [];
            var j;
            var grouped = groupByOf(cfg) !== 'none';
            if (grouped) { head.push('Group'); }
            for (j = 0; j < cols.length; j++) {
                head.push(cols[j].kind === 'duration' ? 'Duration (s)' : headerText(cols[j], cfg, lc.units));
            }
            var rows = [head];
            for (var g = 0; g < list.groups.length; g++) {
                var grp = list.groups[g];
                for (var r = 0; r < grp.rows.length; r++) {
                    var ev = grp.rows[r];
                    var line = grouped ? [grp.label] : [];
                    for (j = 0; j < cols.length; j++) {
                        var c = cols[j];
                        if (c.kind === 'start') { line.push(isoOf(ev.start)); }
                        else if (c.kind === 'end') { line.push(ev.open ? '' : isoOf(ev.end)); }
                        else if (c.kind === 'duration') { line.push(Math.round(((ev.open ? lc.now : ev.end) - ev.start) / 1000)); }
                        else if (c.kind === 'attr') {
                            var a = attrOf(ev, c.name);
                            line.push(a && a.value !== null && a.value !== undefined ? a.value : '');
                        } else { line.push(cellText(ev, c, cfg, lc.units, lc.now)); }
                    }
                    rows.push(line);
                }
            }
            return rows;
        }

        function save() {
            var cfg = liveCfg;
            if (!lastList || !lastList.shown) { return; }
            var name = (trim(cfg.Title) || 'Events') + ' ' + PVX.fmt.time(Date.now(), 'iso').slice(0, 16).replace(/[:T]/g, '-');
            var ok = PVX.download.csv(name, csvRows(lastList, lastCols, cfg));
            scope.pvx.saveNote = ok ? '' : 'This browser cannot save files from a page';
            digest();
        }

        /* ---------------------------------------------------------------- *
         * clicks: a header sorts, a row acts
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
            var node = ev.target;
            var guard = 0;
            while (node && node !== boundHost && guard < 12) {
                if (node.getAttribute) {
                    var key = node.getAttribute('data-pvx-sort');
                    if (key !== null) { sortBy(key); return; }
                    var i = node.getAttribute('data-pvx-i');
                    if (i !== null) { activate(parseInt(i, 10)); return; }
                }
                node = node.parentNode;
                guard += 1;
            }
        }

        /** The first click on a column sorts it the way it reads best (text
         *  A to Z, times and durations largest first); the next reverses. */
        function sortBy(key) {
            var cfg = liveCfg;
            var cur = sortOverride || { key: sortKeyOf(cfg, parseColumns(cfg.Columns)), desc: cfg.SortDescending !== false };
            if (cur.key === key) {
                sortOverride = { key: key, desc: !cur.desc };
            } else {
                var textual = key === 'name' || key === 'element' || key === 'template' || key.indexOf('attr:') === 0;
                sortOverride = { key: key, desc: !textual };
            }
            ctx.render();
        }

        function activate(index) {
            var cfg = liveCfg;
            var ev = rowsShown[index];
            if (!ev) { return; }
            var act = cfg.ClickAction;
            var from = ev.start;
            var to = ev.open ? Date.now() : ev.end;
            var pad = Math.max(60000, (to - from) * 0.1);
            if (act === 'time') {
                // This display, zoomed to the event: the other symbols on it
                // follow the time range, so they show what they did meanwhile.
                PVX.nav.setTimeRange(isoOf(from - pad), isoOf(to + pad));
            } else if (act === 'asset') {
                if (!ev.elPath) { return; }
                PVX.nav.go(PVX.nav.url({ asset: ev.elPath }), false);
            } else if (act === 'navigate') {
                var target = trim(cfg.NavigateTarget);
                if (!target) { return; }
                var opts = { display: target, start: isoOf(from - pad), end: isoOf(to + pad) };
                if (ev.elPath) { opts.asset = ev.elPath; }
                PVX.nav.go(PVX.nav.url(opts), false);
            }
        }

        /* ---------------------------------------------------------------- *
         * plumbing
         * ---------------------------------------------------------------- */

        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            var cfg = c.config || {};
            n.style.setProperty('--pvx-surface', cfg.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-surface-alt', cfg.Transparent ? 'transparent' : (t.surfaceAlt || t.surface));
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-open', PVX.color.status.warning);
        }

        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        /* ---- go ------------------------------------------------------------ */
        lastHashKey = hashKey();
        hashTimer = setInterval(pollHash, 1000);
        hashListener = function () { pollHash(); };
        try { window.addEventListener('hashchange', hashListener, false); } catch (e) { hashListener = null; }
        ensureTimers(liveCfg);
        refresh();

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
