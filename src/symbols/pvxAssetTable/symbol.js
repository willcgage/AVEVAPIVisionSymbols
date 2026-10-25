/* ============================================================================
 * pvxAssetTable — one row per asset, one column per attribute
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 * @mock assets
 *
 * The overview table every area display wants and PI Vision's own table does
 * not draw: compressors down the side, Discharge Pressure / Vibration / Status
 * across the top, each cell coloured by its own limits, a status dot that
 * carries the worst cell in the row, and the row name opening the unit's
 * display with that unit as the asset.
 *
 * Rows come from one of two places:
 *   sources  the data sources dropped on the symbol, pivoted: each AF
 *            attribute path \\srv\db\...\K-301|Vibration lands in row K-301,
 *            column Vibration. Values arrive through PI Vision's own pipeline.
 *   search   the elements under the current asset, found through PI Web API
 *            (optionally only one template), with the listed attributes read
 *            for each. This is what follows an asset swap to an area with a
 *            different number of units; data sources cannot, because PI
 *            Vision rebinds them by relative path and a fixed list of eight
 *            attributes cannot become twelve.
 *
 * Nothing is dropped silently: a PI point (no element) or an attribute left
 * out of the column list is named in the footer, a missing cell shows a dash
 * with a tooltip saying which attribute the element lacks.
 *
 * Built imperatively, like the Status Grid: an ng-repeat over a live table
 * re-digests every cell on every update.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxAssetTable',
        displayName: 'PVX Asset Table',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // The table is already a collection of assets.
        supportsCollections: false,
        configTitle: 'Format Asset Table',
        // A red cell is an alarm whatever the symbol is called: no limits
        // until someone sets them (see pvxAlarmBanner).
        limitsRequired: true,

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                Columns: ['Value'],
                Height: 220,
                Width: 520,

                Title: '',

                // Where rows come from.
                RowSource: 'sources',      // sources | search
                SearchRoot: '',            // used when the URL names no asset
                SearchTemplate: '',
                SearchDescendants: false,
                MaxRows: 50,
                RefreshSeconds: 30,

                // Columns: "Attribute | Header | Colour | Show" per line.
                ColumnSpec: '',
                RowLabel: 'name',          // name | parentName | path
                NameHeader: 'Asset',

                // Colour
                Thresholds: '',
                StateMap: 'Running:#2f9e5f, Stopped:#8a8f96, Fault:#c8452f, Alarm:#c8452f',
                CellStyle: 'text',         // text | fill | dot
                StatusColumn: 'worst',     // worst | none
                ShowUnits: true,
                ShowBadQuality: true,

                // Order
                SortBy: 'none',            // none | name | worst | column
                SortColumn: '',
                SortDescending: false,

                // Interaction
                ClickAction: 'none',       // none | navigate
                NavigateTarget: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        var sourceRows = [];          // PVX.data.rows from the last update
        var searchRows = [];          // rows read through PI Web API
        var view = null;              // the model on screen; clicks map through it
        var built = '';               // structure key of the table in the DOM
        var cellRecs = [];            // [row][col] -> {td, last}
        var rowRecs = [];
        var boundHost = null;
        var liveCfg = {};

        var search = {
            status: 'idle',           // idle | loading | ready | error | unconfigured | noroot
            message: '',
            root: '',
            rootKey: null,
            elements: [],             // [{name, path}]
            truncated: false,
            attrIds: {},              // element|attr (lower) -> WebId, or '' when absent
            failed: 0,
            gen: 0,
            timer: null,
            pollTimer: null,
            configTimer: null,
            lastAsset: null,
            refreshEvery: 0
        };
        var sourceAsset = '';

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-atable-body',

            onData: function (d) {
                sourceRows = PVX.data.rows(d, ['Value']);
                var a = sourceRows.length ? PVX.nav.assetOf(sourceRows[0].path) : '';
                if (a !== sourceAsset) {
                    sourceAsset = a;
                    if (liveCfg.RowSource === 'search') { refreshSearch(true); }
                }
            },

            onConfigChange: function (cfg) {
                liveCfg = cfg || liveCfg;
                ensureTimers(liveCfg);
                // Debounced: the pane fires this on every keystroke in a path
                // or the column list, each a PI Web API round trip otherwise.
                if (search.configTimer !== null) { clearTimeout(search.configTimer); }
                search.configTimer = setTimeout(function () {
                    search.configTimer = null;
                    if (liveCfg.RowSource === 'search') { refreshSearch(false); }
                }, 400);
            },

            render: render,

            onDestroy: function () {
                // A leaked poller on a control-room kiosk runs for weeks.
                if (search.timer !== null) { clearInterval(search.timer); search.timer = null; }
                if (search.pollTimer !== null) { clearInterval(search.pollTimer); search.pollTimer = null; }
                if (search.configTimer !== null) { clearTimeout(search.configTimer); search.configTimer = null; }
                search.gen += 1;
                unbindHost();
                cellRecs = [];
                rowRecs = [];
            }
        });

        function trim(s) {
            return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, '');
        }

        function intIn(v, lo, hi, dflt) {
            var n = parseInt(v, 10);
            return isFinite(n) ? PVX.util.clamp(n, lo, hi) : dflt;
        }

        /* ================================================================ *
         * paths
         * ================================================================ */

        /** '\\srv\db\A\K-301|Seal|Pressure?g' -> {element, attr: 'Seal|Pressure', leaf: 'Pressure'} */
        function splitPath(path) {
            var s = String(path || '');
            var q = s.lastIndexOf('?');
            if (q > 0) { s = s.slice(0, q); }
            s = s.replace(/^[a-z]+:/i, '');
            var bar = s.indexOf('|');
            if (bar === -1) { return null; }
            var attr = s.slice(bar + 1);
            var leaf = attr.slice(attr.lastIndexOf('|') + 1);
            return { element: s.slice(0, bar), attr: attr, leaf: leaf };
        }

        function lastSeg(p) {
            var segs = String(p || '').split('\\');
            for (var i = segs.length - 1; i >= 0; i--) { if (segs[i]) { return segs[i]; } }
            return String(p || '');
        }

        function key(s) { return trim(s).toLowerCase(); }

        /* ================================================================ *
         * column spec — "Attribute | Header | Colour | Show"
         * ================================================================ *
         * Colour: blank = automatic (numbers by the table's bands, states by
         * its state map), none, bands, states, or a band list of this
         * column's own, e.g. "0:#2f9e5f:Normal, 1150:#c8452f:High". Show:
         * value (default), label, or both.
         */
        var SHOWS = { value: 1, label: 1, both: 1 };

        function parseSpec(text) {
            var out = [];
            var lines = String(text || '').split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                var line = trim(lines[i]);
                if (!line || line.charAt(0) === '#') { continue; }
                var f = line.split('|');
                var attr = trim(f[0]);
                if (!attr) { continue; }
                var colour = trim(f[2]);
                var show = trim(f[3]).toLowerCase();
                out.push({
                    attr: attr,
                    header: trim(f[1]) || attr,
                    colour: colour,
                    show: SHOWS[show] ? show : 'value'
                });
            }
            return out;
        }

        /** Does this column take that attribute? Full sub-path, or the leaf name. */
        function columnTakes(col, sp) {
            var k = key(col.attr);
            return k === key(sp.attr) || k === key(sp.leaf);
        }

        /* ================================================================ *
         * model — pivot rows into elements x columns
         * ================================================================ */

        function buildModel(rows, cfg) {
            var spec = parseSpec(cfg.ColumnSpec);
            var cols = spec.slice();
            var autoCols = !cols.length;
            var elements = [];
            var byEl = {};
            var points = 0;
            var unlisted = {};
            var unlistedOrder = [];
            var duplicates = 0;

            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                var sp = r.split || splitPath(r.path);
                if (!sp) { points += 1; continue; }

                var c = -1, j;
                for (j = 0; j < cols.length; j++) {
                    if (columnTakes(cols[j], sp)) { c = j; break; }
                }
                if (c === -1) {
                    if (!autoCols) {
                        if (!unlisted[key(sp.attr)]) { unlisted[key(sp.attr)] = true; unlistedOrder.push(sp.attr); }
                        continue;
                    }
                    cols.push({ attr: sp.attr, header: sp.leaf, colour: '', show: 'value', auto: true });
                    c = cols.length - 1;
                }

                var ek = key(sp.element);
                var e = byEl[ek];
                if (!e) {
                    e = { path: sp.element, name: lastSeg(sp.element), cells: [] };
                    byEl[ek] = e;
                    elements.push(e);
                }
                if (e.cells[c]) { duplicates += 1; continue; }
                e.cells[c] = r;
            }

            // In search mode the element list is the answer even where an
            // element has none of the attributes: an empty row is a finding.
            if (cfg.RowSource === 'search') {
                for (i = 0; i < search.elements.length; i++) {
                    var sk = key(search.elements[i].path);
                    if (!byEl[sk]) {
                        byEl[sk] = { path: search.elements[i].path, name: search.elements[i].name, cells: [] };
                        elements.push(byEl[sk]);
                    }
                }
            }

            labelRows(elements, cfg);

            var notes = [];
            if (points) {
                notes.push(points + ' PI point source' + (points === 1 ? '' : 's') +
                    ' not shown: a row is an AF element, and a PI point has none');
            }
            if (unlistedOrder.length) {
                notes.push(unlistedOrder.length + ' attribute' + (unlistedOrder.length === 1 ? '' : 's') +
                    ' not in the column list: ' + unlistedOrder.slice(0, 4).join(', ') +
                    (unlistedOrder.length > 4 ? ', ...' : ''));
            }
            if (duplicates) {
                notes.push(duplicates + ' duplicate source' + (duplicates === 1 ? '' : 's') + ' ignored');
            }
            return { elements: elements, cols: cols, notes: notes };
        }

        /** Names, made unique where two elements share one under different parents. */
        function labelRows(elements, cfg) {
            var mode = cfg.RowLabel || 'name';
            var seen = {};
            var i;
            for (i = 0; i < elements.length; i++) {
                var n = key(elements[i].name);
                seen[n] = (seen[n] || 0) + 1;
            }
            for (i = 0; i < elements.length; i++) {
                var e = elements[i];
                var segs = PVX.nav.segments(e.path).elements;
                if (mode === 'path') {
                    e.label = segs.join(' \u203a ') || e.name;
                } else if (mode === 'parentName' || seen[key(e.name)] > 1) {
                    e.label = (segs.length > 1 ? segs[segs.length - 2] + ' \u203a ' : '') + e.name;
                } else {
                    e.label = e.name;
                }
            }
        }

        /* ================================================================ *
         * cell status
         * ================================================================ */

        var bandCache = {};
        function bandsOf(spec) {
            if (!bandCache.hasOwnProperty(spec)) { bandCache[spec] = PVX.thresholds.parse(spec); }
            return bandCache[spec];
        }

        var stateCache = { spec: null, map: null };
        function stateMap(spec) {
            if (stateCache.spec !== spec) {
                var map = {};
                var list = PVX.states.parse(spec, 'map');
                for (var i = 0; i < list.length; i++) {
                    map[list[i].state.toLowerCase()] = { color: list[i].color || PVX.color.status.info, label: list[i].label || list[i].state };
                }
                stateCache.spec = spec;
                stateCache.map = map;
            }
            return stateCache.map;
        }

        // Comparable ranks for "worst in the row". A band's rank is its
        // position from the bottom; a state's comes from the severity its
        // colour names in the shared palette.
        var STATE_RANK = { 'normal': 0, 'information': 0, 'off / stale': 0, 'warning': 1, 'alarm': 2, 'critical': 3 };

        function statusOf(row, col, cfg) {
            var out = { color: '', label: '', rank: -1 };
            if (!row) { return out; }
            if (cfg.ShowBadQuality !== false && !row.good) {
                out.bad = true;
                out.label = row.errorDescription || 'Bad';
                return out;
            }
            var mode = trim(col.colour).toLowerCase();
            if (mode === 'none') { return out; }

            var n = row.value;
            var text = PVX.states.text(row.raw);
            if (mode === 'states' || (!mode && n === null)) {
                var hit = stateMap(cfg.StateMap)[text.toLowerCase()];
                if (hit) {
                    var sev = PVX.states.severityOf(hit.color).toLowerCase();
                    out.color = hit.color;
                    out.label = hit.label;
                    out.rank = STATE_RANK.hasOwnProperty(sev) ? STATE_RANK[sev] : 1;
                }
                return out;
            }
            var list = (!mode || mode === 'bands') ? bandsOf(cfg.Thresholds || '') : bandsOf(col.colour);
            if (n === null || !list.length) { return out; }
            for (var i = 0; i < list.length; i++) {
                if (n >= list[i].value) { out.rank = i; } else { break; }
            }
            if (out.rank >= 0) {
                out.color = list[out.rank].color;
                out.label = list[out.rank].label || '';
            }
            return out;
        }

        function cellText(row, col, st, cfg, opts) {
            if (!row) { return '\u2014'; }
            var v = row.value === null ? (PVX.states.text(row.raw) || '--') : PVX.fmt.number(row.raw, opts);
            if (row.value !== null && cfg.ShowUnits !== false && row.units) { v += ' ' + row.units; }
            if (col.show === 'label') { return st.label || v; }
            if (col.show === 'both' && st.label && st.label !== v) { return v + ' \u00b7 ' + st.label; }
            return v;
        }

        /* ================================================================ *
         * ordering
         * ================================================================ */

        function sortElements(model, cfg) {
            var by = cfg.SortBy || 'none';
            var els = model.elements;
            if (by === 'none') { return; }
            var dir = cfg.SortDescending ? -1 : 1;
            var dec = [];
            var ci = -1, i;
            if (by === 'column') {
                var want = key(cfg.SortColumn);
                for (i = 0; i < model.cols.length; i++) {
                    if (key(model.cols[i].attr) === want || key(model.cols[i].header) === want) { ci = i; break; }
                }
                if (ci === -1) {
                    model.notes.push('Sort column "' + trim(cfg.SortColumn) + '" is not a column; rows left in order');
                    return;
                }
            }
            for (i = 0; i < els.length; i++) {
                var k;
                if (by === 'name') { k = els[i].label.toLowerCase(); }
                else if (by === 'worst') { k = els[i].worst ? els[i].worst.rank : -1; }
                else {
                    var cell = els[i].cells[ci];
                    k = cell ? (cell.value !== null ? cell.value : PVX.states.text(cell.raw).toLowerCase()) : null;
                }
                dec.push({ e: els[i], k: k, i: i });
            }
            dec.sort(function (a, b) {
                // Missing values sink whichever way the sort runs.
                if (a.k === null && b.k !== null) { return 1; }
                if (b.k === null && a.k !== null) { return -1; }
                if (a.k === b.k) { return a.i - b.i; }
                var d = a.k < b.k ? -1 : 1;
                // Worst first is the useful default for severity.
                return (by === 'worst' ? -d : d) * dir;
            });
            for (i = 0; i < dec.length; i++) { els[i] = dec[i].e; }
        }

        /* ================================================================ *
         * search mode — rows from PI Web API
         * ================================================================ */

        function searchRoot(cfg) {
            return trim(PVX.nav.currentAsset()) || trim(cfg.SearchRoot) || sourceAsset;
        }

        function ensureTimers(cfg) {
            var every = cfg.RowSource === 'search' ? intIn(cfg.RefreshSeconds, 5, 3600, 30) : 0;
            if (every !== search.refreshEvery) {
                if (search.timer !== null) { clearInterval(search.timer); search.timer = null; }
                search.refreshEvery = every;
                if (every) { search.timer = setInterval(function () { refreshSearch(false); }, every * 1000); }
            }
            if (cfg.RowSource === 'search' && search.pollTimer === null) {
                // Follow the display's asset: some PI Vision releases change
                // it through the router without a hashchange.
                search.lastAsset = key(PVX.nav.currentAsset());
                search.pollTimer = setInterval(function () {
                    if (ctx.destroyed) { return; }
                    var a = key(PVX.nav.currentAsset());
                    if (a !== search.lastAsset) { search.lastAsset = a; refreshSearch(true); }
                }, 1000);
            } else if (cfg.RowSource !== 'search' && search.pollTimer !== null) {
                clearInterval(search.pollTimer);
                search.pollTimer = null;
            }
        }

        function fail(message) {
            search.status = 'error';
            search.message = message;
            ctx.render();
        }

        function errText(err) {
            var e = err && err.pvxError;
            if (e) { return e.message + (e.check ? ' Check: ' + e.check + '.' : ''); }
            return String((err && err.message) || err);
        }

        /**
         * One refresh: resolve the root and its elements when the root,
         * template or column list changed, then read every cell's value. The
         * attribute lookups are cached per element, so a steady display costs
         * one batch of value reads per refresh.
         */
        function refreshSearch(force) {
            var cfg = liveCfg;
            if (cfg.RowSource !== 'search') { return; }
            if (!PVX.api.isConfigured()) {
                search.status = 'unconfigured';
                ctx.render();
                return;
            }
            var root = searchRoot(cfg);
            if (!root) {
                search.status = 'noroot';
                ctx.render();
                return;
            }
            var cols = parseSpec(cfg.ColumnSpec);
            var max = intIn(cfg.MaxRows, 1, 500, 50);
            var rootKey = [key(root), key(cfg.SearchTemplate), !!cfg.SearchDescendants, max,
                cols.map(function (c) { return key(c.attr); }).join('|')].join('\u0000');
            var gen = ++search.gen;
            var fresh = force || rootKey !== search.rootKey;
            if (fresh) {
                search.rootKey = rootKey;
                search.root = root;
                search.status = 'loading';
                search.elements = [];
                search.attrIds = {};
                searchRows = [];
                ctx.render();
            }
            if (!cols.length) {
                search.status = 'error';
                search.message = 'List the attributes to show under Columns: in search mode they decide what is read for each element.';
                ctx.render();
                return;
            }

            var chain = fresh ? listElements(root, cfg, max) : Promise.resolve();
            chain.then(function () {
                if (gen !== search.gen) { return null; }
                return resolveAttributes(cols);
            }).then(function () {
                if (gen !== search.gen) { return null; }
                return readValues(cols);
            }).then(function (rows) {
                if (gen !== search.gen || !rows) { return; }
                searchRows = rows;
                search.status = 'ready';
                ctx.render();
            })['catch'](function (err) {
                if (gen !== search.gen) { return; }
                fail(errText(err));
            });
        }

        function listElements(root, cfg, max) {
            return PVX.api.get('elements?path=' + encodeURIComponent(root) + '&selectedFields=WebId;Name;Path')
                ['catch'](function (err) {
                    // A 404 here is the root, not a WebID: say which path.
                    if (err && err.pvxError && err.pvxError.code === 'not-found') { return null; }
                    throw err;
                })
                .then(function (el) {
                    if (!el || !el.WebId) {
                        throw { pvxError: { message: 'There is no AF element at "' + root + '".',
                            check: 'the display\'s asset, or Search root in Format' } };
                    }
                    var q = ['selectedFields=Items.Name;Items.Path', 'maxCount=' + (max + 1)];
                    if (cfg.SearchDescendants) { q.push('searchFullHierarchy=true'); }
                    if (trim(cfg.SearchTemplate)) { q.push('templateName=' + encodeURIComponent(trim(cfg.SearchTemplate))); }
                    return PVX.api.get('elements/' + encodeURIComponent(el.WebId) + '/elements?' + q.join('&'));
                })
                .then(function (res) {
                    var items = (res && res.Items) || [];
                    search.truncated = items.length > max;
                    search.elements = [];
                    for (var i = 0; i < items.length && i < max; i++) {
                        if (items[i] && items[i].Path) {
                            search.elements.push({ name: items[i].Name || lastSeg(items[i].Path), path: items[i].Path });
                        }
                    }
                });
        }

        function attrKey(elPath, attr) { return key(elPath) + '|' + key(attr); }

        /** Look up each element x column attribute once; absent ones are remembered as ''. */
        function resolveAttributes(cols) {
            var reqs = {};
            var asks = {};
            var n = 0;
            for (var i = 0; i < search.elements.length; i++) {
                for (var c = 0; c < cols.length; c++) {
                    var p = search.elements[i].path + '|' + cols[c].attr;
                    var k = attrKey(search.elements[i].path, cols[c].attr);
                    if (search.attrIds.hasOwnProperty(k)) { continue; }
                    var id = 'a' + (n++);
                    asks[id] = k;
                    reqs[id] = { Method: 'GET', Resource: PVX.api.base() + '/attributes?path=' +
                        encodeURIComponent(p) + '&selectedFields=WebId' };
                }
            }
            if (!n) { return Promise.resolve(); }
            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                var r = PVX.api.batchResults(res);
                var other = 0;
                for (var id in asks) {
                    if (!asks.hasOwnProperty(id)) { continue; }
                    if (r.ok[id] && r.ok[id].WebId) { search.attrIds[asks[id]] = r.ok[id].WebId; continue; }
                    var st = r.failed[id] && r.failed[id].status;
                    // 404 is an element without that attribute: a dash, not an error.
                    if (st === 404 || st === undefined) { search.attrIds[asks[id]] = ''; } else { other += 1; }
                }
                search.failed = other;
            });
        }

        function readValues(cols) {
            var reqs = {};
            var cells = {};
            var n = 0;
            for (var i = 0; i < search.elements.length; i++) {
                for (var c = 0; c < cols.length; c++) {
                    var webId = search.attrIds[attrKey(search.elements[i].path, cols[c].attr)];
                    if (!webId) { continue; }
                    var id = 'v' + (n++);
                    cells[id] = { el: search.elements[i], col: cols[c] };
                    reqs[id] = { Method: 'GET', Resource: PVX.api.base() + '/streams/' + encodeURIComponent(webId) +
                        '/value?selectedFields=Timestamp;Value;UnitsAbbreviation;Good' };
                }
            }
            if (!n) { return Promise.resolve([]); }
            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                var r = PVX.api.batchResults(res);
                var rows = [];
                for (var id in cells) {
                    if (!cells.hasOwnProperty(id)) { continue; }
                    var cell = cells[id];
                    var v = r.ok[id];
                    var raw = v ? v.Value : null;
                    if (raw && typeof raw === 'object') { raw = raw.Name !== undefined ? raw.Name : raw.Value; }
                    rows.push({
                        path: cell.el.path + '|' + cell.col.attr,
                        split: { element: cell.el.path, attr: cell.col.attr, leaf: cell.col.attr },
                        label: cell.el.name + '|' + cell.col.attr,
                        raw: raw,
                        value: PVX.util.num(raw),
                        units: (v && v.UnitsAbbreviation) || '',
                        time: v && v.Timestamp,
                        good: !!v && v.Good !== false,
                        errorDescription: v ? '' : 'Read failed (HTTP ' + (r.failed[id] && r.failed[id].status) + ')'
                    });
                }
                return rows;
            });
        }

        /* ================================================================ *
         * render
         * ================================================================ */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }
            liveCfg = cfg;
            ensureTimers(cfg);
            applyThemeVars(c, t);
            bindHost(host);

            var searching = cfg.RowSource === 'search';
            if (searching && search.status === 'idle') { refreshSearch(false); }

            var message = searching ? searchMessage(cfg) : null;
            var model = buildModel(searching ? searchRows : sourceRows, cfg);
            if (searching && search.truncated) {
                model.notes.unshift('First ' + intIn(cfg.MaxRows, 1, 500, 50) + ' elements: raise Most rows to show the rest');
            }
            if (searching && search.failed) {
                model.notes.push(search.failed + ' attribute lookup' + (search.failed === 1 ? '' : 's') + ' failed');
            }

            if (message || !model.elements.length) {
                renderMessage(host, message || {
                    title: 'No rows',
                    text: searching ? 'No elements under ' + search.root + (trim(cfg.SearchTemplate) ? ' of template ' + trim(cfg.SearchTemplate) : '') + '.'
                        : (model.notes.length ? model.notes.join('. ') + '.' : 'Drop AF attributes of several elements onto the table.')
                });
                view = null;
                return;
            }

            var opts = PVX.config.numberOpts(cfg);
            var els = model.elements;
            var i, j;
            for (i = 0; i < els.length; i++) {
                var e = els[i];
                e.status = [];
                e.worst = null;
                for (j = 0; j < model.cols.length; j++) {
                    var st = statusOf(e.cells[j], model.cols[j], cfg);
                    e.status.push(st);
                    if (st.rank >= 0 && (!e.worst || st.rank > e.worst.rank)) {
                        e.worst = { rank: st.rank, color: st.color, label: st.label, col: model.cols[j].header };
                    }
                }
            }
            sortElements(model, cfg);
            view = model;

            var showStatus = cfg.StatusColumn !== 'none';
            var structure = [showStatus, cfg.NameHeader, model.cols.length, els.length].concat(
                model.cols.map(function (col) { return col.header; })).join('\u0000');
            if (structure !== built) { buildTable(host, model, cfg, showStatus); built = structure; }

            var style = cfg.CellStyle || 'text';
            var clickable = cfg.ClickAction === 'navigate';
            for (i = 0; i < els.length; i++) {
                var rr = rowRecs[i];
                setText(rr.name, els[i].label, rr.last, 'name');
                var tip = els[i].path + (clickable ? '\nClick to open with this asset' : '');
                if (rr.last.tip !== tip) { rr.last.tip = tip; rr.name.title = tip; }
                var rowCls = 'pvx-atable-row' + (clickable ? ' pvx-atable-click' : '');
                if (rr.last.cls !== rowCls) { rr.last.cls = rowCls; rr.tr.className = rowCls; }
                if (clickable) { rr.tr.setAttribute('tabindex', '0'); } else { rr.tr.removeAttribute('tabindex'); }
                if (showStatus) {
                    var w = els[i].worst;
                    setStyle(rr.dot, 'backgroundColor', w ? w.color : 'transparent', rr.last, 'dot');
                    setStyle(rr.dot, 'borderColor', w ? w.color : t.border, rr.last, 'dotb');
                    var wt = w ? w.col + ': ' + (w.label || 'band ' + (w.rank + 1)) : 'No coloured cells';
                    if (rr.last.wt !== wt) { rr.last.wt = wt; rr.dot.title = wt; }
                }
                for (j = 0; j < model.cols.length; j++) {
                    paintCell(cellRecs[i][j], els[i], els[i].cells[j], model.cols[j], els[i].status[j], cfg, opts, style, t);
                }
            }

            setText(footerEl(), model.notes.join(' \u00b7 '), footerLast, 'text');
        }

        function searchMessage(cfg) {
            if (search.status === 'unconfigured') {
                return { title: 'PI Web API is not configured', warn: true,
                    text: 'Search mode reads elements through PI Web API. Set baseUrl in ext/libraries/pvx/pvx-config.js ' +
                          'on this PI Vision server, then confirm it with ext/piwebapi-check.html.' };
            }
            if (search.status === 'noroot') {
                return { title: 'No asset to search under',
                    text: 'Open this display with an asset, set Search root in Format, or drop an attribute of the parent element onto the table.' };
            }
            if (search.status === 'error') {
                return { title: 'Could not list the rows', warn: true, text: search.message };
            }
            if (search.status === 'loading' && !searchRows.length && !search.elements.length) {
                return { title: '', text: 'Loading elements under ' + search.root + '\u2026' };
            }
            return null;
        }

        function paintCell(rec, el, row, col, st, cfg, opts, style, t) {
            var text = cellText(row, col, st, cfg, opts);
            setText(rec.text, text, rec.last, 'text');
            var color = st.color;
            var cls = 'pvx-atable-cell' + (row ? '' : ' pvx-atable-missing') + (st.bad ? ' pvx-atable-bad' : '') +
                (row && row.value !== null ? ' pvx-num' : '');
            if (rec.last.cls !== cls) { rec.last.cls = cls; rec.td.className = cls; }
            var bg = '', fg = '';
            if (color && style === 'fill') { bg = color; fg = PVX.color.readable(color); }
            else if (color && style === 'text') { fg = color; }
            setStyle(rec.td, 'backgroundColor', bg, rec.last, 'bg');
            setStyle(rec.td, 'color', fg, rec.last, 'fg');
            setStyle(rec.dot, 'display', color && style === 'dot' ? 'inline-block' : 'none', rec.last, 'dd');
            setStyle(rec.dot, 'backgroundColor', color || 'transparent', rec.last, 'dc');
            var tip = row
                ? (row.path || '') + '\n' + text + (st.label && text.indexOf(st.label) === -1 ? '\n' + st.label : '') +
                  (row.time ? '\n' + PVX.fmt.time(row.time, 'datetime') : '') + (st.bad ? '\n' + st.label : '')
                : el.name + ' has no ' + col.attr + (cfg.RowSource === 'search' ? ' attribute' : ' data source');
            if (rec.last.tip !== tip) { rec.last.tip = tip; rec.td.title = tip; }
        }

        /* ================================================================ *
         * DOM
         * ================================================================ */

        function makeEl(tag, cls, parent) {
            var e = document.createElement(tag);
            if (cls) { e.className = cls; }
            if (parent) { parent.appendChild(e); }
            return e;
        }

        function clear(node) { while (node && node.firstChild) { node.removeChild(node.firstChild); } }

        var footer = null;
        var footerLast = {};
        function footerEl() {
            if (!footer || !footer.parentNode) {
                footer = PVX.util.find ? PVX.util.find(elem, '.pvx-atable-footer') : null;
                footerLast = {};
            }
            return footer || { textContent: '' };
        }

        function buildTable(host, model, cfg, showStatus) {
            clear(host);
            host.setAttribute('data-pvx-mode', 'table');
            cellRecs = [];
            rowRecs = [];
            var table = makeEl('table', 'pvx-atable-table', host);
            var thead = makeEl('thead', '', table);
            var hr = makeEl('tr', '', thead);
            if (showStatus) { makeEl('th', 'pvx-atable-statushead', hr).setAttribute('aria-label', 'Status'); }
            makeEl('th', 'pvx-atable-namehead', hr).textContent = trim(cfg.NameHeader) || 'Asset';
            for (var c = 0; c < model.cols.length; c++) {
                var th = makeEl('th', 'pvx-atable-colhead', hr);
                th.textContent = model.cols[c].header;
                th.title = model.cols[c].attr;
            }
            var tbody = makeEl('tbody', '', table);
            for (var i = 0; i < model.elements.length; i++) {
                var tr = makeEl('tr', 'pvx-atable-row', tbody);
                tr.setAttribute('data-pvx-i', String(i));
                var rec = { tr: tr, dot: null, name: null, last: {} };
                if (showStatus) {
                    var sd = makeEl('td', 'pvx-atable-status', tr);
                    rec.dot = makeEl('span', 'pvx-atable-statusdot', sd);
                }
                rec.name = makeEl('td', 'pvx-atable-name', tr);
                rowRecs.push(rec);
                var cells = [];
                for (c = 0; c < model.cols.length; c++) {
                    var td = makeEl('td', 'pvx-atable-cell', tr);
                    var dot = makeEl('span', 'pvx-atable-dot', td);
                    var text = makeEl('span', 'pvx-atable-text', td);
                    cells.push({ td: td, dot: dot, text: text, last: {} });
                }
                cellRecs.push(cells);
            }
        }

        function renderMessage(host, m) {
            var sig = (m.title || '') + '\u0000' + (m.text || '');
            if (built === 'msg:' + sig) { return; }
            built = 'msg:' + sig;
            clear(host);
            host.setAttribute('data-pvx-mode', 'empty');
            var box = makeEl('div', 'pvx-empty pvx-atable-message', host);
            if (m.title) { makeEl('div', 'pvx-atable-msgtitle' + (m.warn ? ' pvx-atable-warn' : ''), box).textContent = m.title; }
            makeEl('div', 'pvx-atable-msgtext', box).textContent = m.text || '';
            setText(footerEl(), '', footerLast, 'text');
        }

        function setText(node, text, last, k) {
            if (last[k] === text) { return; }
            last[k] = text;
            node.textContent = text;   // never innerHTML: PI and AF text is untrusted
        }

        function setStyle(node, prop, value, last, k) {
            if (last[k] === value) { return; }
            last[k] = value;
            node.style[prop] = value;
        }

        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', c.config.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-surface-alt', t.surfaceAlt);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-stripe', t.dark ? 'rgba(255,255,255,0.16)' : 'rgba(0,0,0,0.13)');
        }

        /* ================================================================ *
         * interaction — one delegated listener pair for the whole table
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

        function rowIndexOf(target) {
            var node = target;
            var guard = 0;
            while (node && node !== boundHost && guard < 8) {
                if (node.getAttribute && node.getAttribute('data-pvx-i') !== null) {
                    var i = parseInt(node.getAttribute('data-pvx-i'), 10);
                    return isNaN(i) ? -1 : i;
                }
                node = node.parentNode;
                guard += 1;
            }
            return -1;
        }

        function isEditMode() {
            try { if (scope.runtimeData && scope.runtimeData.isEditMode) { return true; } } catch (e) { /* ignore */ }
            return false;
        }

        function onClick(ev) {
            if (liveCfg.ClickAction !== 'navigate' || isEditMode()) { return; }
            activate(rowIndexOf(ev.target));
        }

        function onKeyDown(ev) {
            if (liveCfg.ClickAction !== 'navigate') { return; }
            var k = ev.keyCode || ev.which;
            if (k !== 13 && k !== 32) { return; }
            var i = rowIndexOf(ev.target);
            if (i < 0) { return; }
            if (ev.preventDefault) { ev.preventDefault(); }
            activate(i);
        }

        function activate(index) {
            if (!view || index < 0 || index >= view.elements.length) { return; }
            var target = trim(liveCfg.NavigateTarget);
            PVX.nav.go(PVX.nav.url({
                display: target || undefined,
                asset: view.elements[index].path
            }), false);
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
