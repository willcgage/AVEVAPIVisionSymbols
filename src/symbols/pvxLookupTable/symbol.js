/* ============================================================================
 * pvxLookupTable: "PVX Lookup Table" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector, and gives a blank database path a database. Every row
 * comes from PI Web API through PVX.api.
 *
 * An AF table on a display, read only: grade specifications, shift rosters,
 * product codes, equipment lists, whatever a site keeps in AF's Library >
 * Tables, static or linked to an external source. The columns shown and
 * their order, a filter box, a sort on any heading, groups by a column, row
 * conditions written as "Column op value" (one can name the display's asset,
 * so a shared display shows that unit's rows), rows limited to the display's
 * time range by a date column, and one column colored by threshold bands.
 *
 * WHY PI WEB API. PI Vision has no data source for an AF table: an
 * attribute can look a value up in one, but the table itself is not
 * something a display can show. PI Web API reads it as columns and rows
 * through tables/{webId}/data, which works the same for a table linked to
 * an external database, so AF does the linking and this only reads.
 *
 * DATA ACCESS. The database and the table are found by path and name once
 * and cached; the rows are read again on the refresh timer, because a table
 * is edited by people and a linked one changes with its source. One request
 * per refresh, whatever the table's size: AF returns the whole table, so
 * Max rows bounds what is drawn, not what is read, and the footer says so.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var UNASSIGNED = '(blank)';

    /** .NET type names AF reports for a column, by how they read. */
    var NUMERIC = { byte: 1, sbyte: 1, int16: 1, int32: 1, int64: 1, uint16: 1, uint32: 1, uint64: 1,
        single: 1, double: 1, decimal: 1 };

    var OPS = ['<>', '!=', '<=', '>=', '=', '<', '>', 'contains', 'starts', 'in'];

    var definition = {
        typeName: 'pvxLookupTable',
        displayName: 'PVX Lookup Table',

        // One data source, which this symbol ignores but for its database:
        // PI Vision keeps DatasourceBehaviors.None symbols out of the symbol
        // selector. Pick it and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Lookup Table',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Value',
                Height: 300,
                Width: 600,
                Title: '',
                ShowLabel: true,

                /* -- which table -------------------------------------------- */
                DatabasePath: '',
                TableName: '',
                RefreshSeconds: 300,

                /* -- columns ------------------------------------------------- */
                Columns: '',                 // blank: every column, in the table's order
                TimeFormat: 'short',         // short | datetime | date | iso

                /* -- rows ---------------------------------------------------- */
                RowFilter: '',               // one "Column op value" per line, all must hold
                TimeColumn: '',              // a date column: only rows in the display's range
                Filter: '',
                ShowFilterBox: true,
                SortBy: '',
                SortDescending: false,
                GroupBy: '',
                MaxRows: 1000,

                /* -- color -------------------------------------------------- */
                ColorColumn: '',
                Thresholds: '',

                /* -- click --------------------------------------------------- */
                ClickAction: 'none',         // none | asset | navigate
                AssetColumn: '',             // a column holding an element path
                NavigateTarget: '',          // may hold {Column} tokens
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

    function lower(s) { return trim(s).toLowerCase(); }

    function isNumType(type) { return !!NUMERIC[lower(type).replace(/^system\./, '')]; }
    function isTimeType(type) { return lower(type).replace(/^system\./, '') === 'datetime'; }

    /**
     * "Grade, Min Width | Min (mm), Max Width" -> [{name, label}], matched to
     * the table's columns without case. Names not in the table are returned
     * in `missing`, never dropped quietly. Blank means every column.
     */
    function parseColumns(spec, tableCols) {
        var byName = {};
        for (var i = 0; i < tableCols.length; i++) { byName[tableCols[i].toLowerCase()] = tableCols[i]; }
        var out = [], missing = [], seen = {};
        var parts = trim(spec) ? String(spec).split(/[,\n]/) : tableCols.slice();
        for (var j = 0; j < parts.length; j++) {
            var bits = String(parts[j]).split('|');
            var name = trim(bits[0]);
            if (!name) { continue; }
            var real = byName[name.toLowerCase()];
            if (!real) { missing.push(name); continue; }
            if (seen[real.toLowerCase()]) { continue; }
            seen[real.toLowerCase()] = true;
            out.push({ name: real, label: trim(bits[1]) || real });
        }
        return { cols: out, missing: missing };
    }

    /**
     * One condition per line, "Column op value", every one must hold.
     *   Grade = {asset}        the display's asset's name
     *   Width >= 1200
     *   Line in A, B, C
     *   Product contains foil
     * Returns {rules: [{col, op, value}], errors: [line]}: a line that does
     * not read is named in the footer, not ignored.
     */
    function parseRowFilter(text) {
        var rules = [], errors = [];
        var lines = String(text || '').split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = trim(lines[i]);
            if (!line || line.charAt(0) === '#') { continue; }
            var hit = null;
            for (var k = 0; k < OPS.length && !hit; k++) {
                var op = OPS[k];
                var re = /^[a-z]+$/.test(op) ? new RegExp('^(.+?)\\s+' + op + '\\s+(.*)$', 'i') : null;
                if (re) {
                    var m = re.exec(line);
                    if (m) { hit = { col: trim(m[1]), op: op, value: trim(m[2]) }; }
                } else {
                    var at = line.indexOf(op);
                    if (at > 0) { hit = { col: trim(line.slice(0, at)), op: op === '!=' ? '<>' : op, value: trim(line.slice(at + op.length)) }; }
                }
            }
            if (!hit || !hit.col) { errors.push(line); continue; }
            hit.value = hit.value.replace(/^"(.*)"$/, '$1');
            rules.push(hit);
        }
        return { rules: rules, errors: errors };
    }

    function asNumber(v) {
        if (typeof v === 'number') { return isFinite(v) ? v : null; }
        var s = trim(v);
        if (!s || !/^[+\-]?(\d+\.?\d*|\.\d+)([eE][+\-]?\d+)?$/.test(s)) { return null; }
        return parseFloat(s);
    }

    function asTime(v) {
        if (v === null || v === undefined || v === '') { return null; }
        var d = new Date(v);
        var t = d.getTime();
        return isFinite(t) ? t : null;
    }

    /** Does one cell meet one rule? Numbers compare as numbers, else text without case. */
    function test(cell, rule, tokens) {
        var want = String(rule.value).replace(/\{(\w+)\}/g, function (all, k) {
            return Object.prototype.hasOwnProperty.call(tokens || {}, k.toLowerCase()) ? tokens[k.toLowerCase()] : all;
        });
        var text = cell === null || cell === undefined ? '' : String(cell);
        if (rule.op === 'contains') { return text.toLowerCase().indexOf(want.toLowerCase()) !== -1; }
        if (rule.op === 'starts') { return text.toLowerCase().indexOf(want.toLowerCase()) === 0; }
        if (rule.op === 'in') {
            var list = want.split(',');
            for (var i = 0; i < list.length; i++) { if (trim(list[i]).toLowerCase() === text.toLowerCase()) { return true; } }
            return false;
        }
        var a = asNumber(cell), b = asNumber(want);
        var cmp;
        if (a !== null && b !== null) {
            cmp = a < b ? -1 : (a > b ? 1 : 0);
        } else {
            var ta = asTime(cell), tb = /\d{4}-\d{2}-\d{2}/.test(want) ? asTime(want) : null;
            if (ta !== null && tb !== null && typeof cell !== 'number') { cmp = ta < tb ? -1 : (ta > tb ? 1 : 0); }
            else {
                var x = text.toLowerCase(), y = want.toLowerCase();
                cmp = x < y ? -1 : (x > y ? 1 : 0);
            }
        }
        switch (rule.op) {
            case '=': return cmp === 0;
            case '<>': return cmp !== 0;
            case '<': return cmp < 0;
            case '<=': return cmp <= 0;
            case '>': return cmp > 0;
            default: return cmp >= 0;
        }
    }

    function cellOf(row, col) {
        if (Object.prototype.hasOwnProperty.call(row, col)) { return row[col]; }
        var want = String(col).toLowerCase();
        for (var k in row) {
            if (Object.prototype.hasOwnProperty.call(row, k) && k.toLowerCase() === want) { return row[k]; }
        }
        return undefined;
    }

    function compare(a, b) {
        var ea = a === null || a === undefined || a === '', eb = b === null || b === undefined || b === '';
        if (ea || eb) { return ea && eb ? 0 : (ea ? 1 : -1); }
        var na = asNumber(a), nb = asNumber(b);
        if (na !== null && nb !== null) { return na - nb; }
        var x = String(a).toLowerCase(), y = String(b).toLowerCase();
        return x < y ? -1 : (x > y ? 1 : 0);
    }

    /**
     * Rows -> what is shown.
     * @param {Array} rows the table's rows, objects by column name
     * @param {Object} o {rules, tokens, timeCol, from, to, filter, textOf(row)->String,
     *                    sortCol, desc, groupCol, max}
     * @returns {{groups:[{label, rows}], total, ruled, timed, hidden, shown, capped}}
     *   ruled: left out by the row conditions; timed: outside the time range;
     *   hidden: left out by the filter box; capped: past Max rows.
     */
    function buildTable(rows, o) {
        var out = { groups: [], total: rows.length, ruled: 0, timed: 0, hidden: 0, shown: 0, capped: 0 };
        var keep = [], i, j;
        var f = lower(o.filter);
        for (i = 0; i < rows.length; i++) {
            var r = rows[i], ok = true;
            for (j = 0; j < (o.rules || []).length && ok; j++) { ok = test(cellOf(r, o.rules[j].col), o.rules[j], o.tokens); }
            if (!ok) { out.ruled += 1; continue; }
            if (o.timeCol && o.from !== null && o.to !== null) {
                var t = asTime(cellOf(r, o.timeCol));
                if (t === null || t < o.from || t > o.to) { out.timed += 1; continue; }
            }
            if (f && String(o.textOf ? o.textOf(r) : '').toLowerCase().indexOf(f) === -1) { out.hidden += 1; continue; }
            keep.push(r);
        }
        if (o.sortCol) {
            var dir = o.desc ? -1 : 1;
            var idx = keep.map(function (row, n) { return { row: row, n: n }; });
            idx.sort(function (a, b) {
                var x = cellOf(a.row, o.sortCol), y = cellOf(b.row, o.sortCol);
                var ex = x === null || x === undefined || x === '', ey = y === null || y === undefined || y === '';
                // Blank last either way: it is not the smallest value.
                if (ex || ey) { return ex && ey ? a.n - b.n : (ex ? 1 : -1); }
                return (compare(x, y) * dir) || (a.n - b.n);
            });
            keep = idx.map(function (x) { return x.row; });
        }
        var max = o.max > 0 ? o.max : keep.length;
        if (keep.length > max) { out.capped = keep.length - max; keep = keep.slice(0, max); }
        out.shown = keep.length;
        if (!o.groupCol) {
            out.groups.push({ label: '', rows: keep });
            return out;
        }
        var by = {}, order = [];
        for (i = 0; i < keep.length; i++) {
            var g = cellOf(keep[i], o.groupCol);
            g = g === null || g === undefined || trim(g) === '' ? UNASSIGNED : String(g);
            if (!Object.prototype.hasOwnProperty.call(by, g)) { by[g] = []; order.push(g); }
            by[g].push(keep[i]);
        }
        order.sort(function (a, b) {
            if (a === UNASSIGNED) { return 1; }
            if (b === UNASSIGNED) { return -1; }
            return compare(a, b);
        });
        for (i = 0; i < order.length; i++) { out.groups.push({ label: order[i], rows: by[order[i]] }); }
        return out;
    }

    symbolVis.parseColumns = parseColumns;
    symbolVis.parseRowFilter = parseRowFilter;
    symbolVis.test = test;
    symbolVis.buildTable = buildTable;

    /* ====================================================================== *
     * the symbol
     * ====================================================================== */

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            title: '', filter: '', showFilter: false, note: '', summary: '', saveNote: '',
            canDownload: false, clickable: false,
            onFilter: function () { ctx.render(); },
            download: function () { save(); }
        };

        var state = {
            phase: 'idle',        // idle | loading | ok | error | unconfigured | nodb | notable
            error: null,
            columns: [],          // [name] in the table's order
            types: {},            // name -> .NET type
            rows: [],
            db: { path: '', from: '' }
        };
        var sourceAsset = '';
        var liveCfg = scope.config || {};
        var generation = 0;
        var dbCache = {}, tableCache = {};
        var sortOverride = null;
        var lastFilterSeed = null;
        var refreshTimer = null, timerSeconds = null, hashTimer = null, lastHashKey = null, debounceTimer = null;
        var boundHost = null;
        var rowsShown = [];
        var lastHtml = '';
        var lastView = null;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-lkt-body',
            render: render,
            csv: function () { return lastView ? csvRows(lastView) : null; },
            onData: function (d) {
                var one = PVX.data.single(d);
                var a = one ? PVX.nav.assetOf(one.path) : '';
                if (a !== sourceAsset) {
                    sourceAsset = a;
                    if (!trim(liveCfg.DatabasePath) && state.phase !== 'ok') { refreshSoon(); }
                    else { ctx.render(); }
                }
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

        function databaseFor(cfg) {
            var typed = trim(cfg.DatabasePath);
            if (typed) { return { path: typed, from: '' }; }
            return PVX.nav.defaultDatabase(scope, sourceAsset);
        }

        function hashKey() {
            var p = {};
            try { p = PVX.nav.parseHash().params || {}; } catch (e) { p = {}; }
            return String(p.starttime || '') + '|' + String(p.endtime || '') + '|' + String(p.asset || '');
        }

        /* ---------------------------------------------------------------- *
         * PI Web API
         * ---------------------------------------------------------------- */

        function resolveDatabase(dbPath) {
            var k = dbPath.toLowerCase();
            if (dbCache[k]) { return dbCache[k]; }
            var p = PVX.api.get('assetdatabases?path=' + encodeURIComponent(dbPath) + '&selectedFields=WebId').then(function (db) {
                if (!db || !db.WebId) {
                    throw { pvxError: { message: 'PI Web API answered, but there is no AF database at "' + dbPath + '".',
                        check: 'the AF database path, written \\\\<AF server>\\<database>' } };
                }
                return db.WebId;
            });
            p['catch'](function () { if (dbCache[k] === p) { delete dbCache[k]; } });
            dbCache[k] = p;
            return p;
        }

        /** The table's WebId by name, or null when the database has none by it. */
        function resolveTable(dbWebId, name) {
            var k = dbWebId + '|' + name.toLowerCase();
            if (tableCache[k]) { return tableCache[k]; }
            var p = PVX.api.get('assetdatabases/' + encodeURIComponent(dbWebId) + '/tables?selectedFields=Items.WebId;Items.Name',
                { cache: false }).then(function (res) {
                var items = (res && res.Items) || [];
                state.tableNames = items.map(function (t) { return t.Name; });
                for (var i = 0; i < items.length; i++) {
                    if (String(items[i].Name).toLowerCase() === name.toLowerCase() && items[i].WebId) { return items[i].WebId; }
                }
                return null;
            });
            p.then(function (id) { if (!id && tableCache[k] === p) { delete tableCache[k]; } },
                function () { if (tableCache[k] === p) { delete tableCache[k]; } });
            tableCache[k] = p;
            return p;
        }

        function refresh() {
            if (ctx.destroyed) { return; }
            var cfg = liveCfg = scope.config || liveCfg;
            if (PVX.api.discovering()) {
                PVX.api.discover().then(function () { if (!ctx.destroyed) { refresh(); } });
                return;
            }
            if (!PVX.api.isConfigured()) { state.phase = 'unconfigured'; ctx.render(); return; }
            state.db = databaseFor(cfg);
            var name = trim(cfg.TableName);
            if (!state.db.path || !name) { state.phase = 'nodb'; ctx.render(); return; }
            var gen = ++generation;
            if (state.phase !== 'ok') { state.phase = 'loading'; ctx.render(); }
            resolveDatabase(state.db.path).then(function (dbId) {
                if (stale(gen)) { return null; }
                return resolveTable(dbId, name);
            }).then(function (tid) {
                if (stale(gen)) { return null; }
                if (!tid) {
                    state.phase = 'notable';
                    state.rows = [];
                    ctx.render();
                    return null;
                }
                return PVX.api.get('tables/' + encodeURIComponent(tid) + '/data', { cache: false });
            }).then(function (data) {
                if (stale(gen) || !data) { return; }
                var cols = data.Columns || {};
                state.columns = Object.keys(cols);
                state.types = cols;
                state.rows = data.Rows || [];
                // A table with rows but no column list still shows its rows.
                if (!state.columns.length && state.rows.length) { state.columns = Object.keys(state.rows[0]); }
                state.phase = 'ok';
                state.error = null;
                ctx.render();
            })['catch'](function (err) {
                if (stale(gen)) { return; }
                state.phase = 'error';
                state.error = err;
                state.rows = [];
                ctx.render();
            });
        }

        function stale(gen) { return ctx.destroyed || gen !== generation; }

        function ensureTimers(cfg) {
            var secs = intIn(cfg.RefreshSeconds, 10, 86400, 300);
            if (refreshTimer !== null && timerSeconds === secs) { return; }
            if (refreshTimer !== null) { clearInterval(refreshTimer); }
            timerSeconds = secs;
            refreshTimer = setInterval(function () { refresh(); }, secs * 1000);
        }

        /* The rows depend on the display's time range and asset only through
         * the time column and {asset}: re-filtered, never re-read. */
        function pollHash() {
            if (ctx.destroyed) { return; }
            var k = hashKey();
            if (k === lastHashKey) { return; }
            lastHashKey = k;
            ctx.render();
        }

        function refreshSoon() {
            if (debounceTimer !== null) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(function () { debounceTimer = null; refresh(); }, 400);
        }

        function teardown() {
            if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
            if (hashTimer !== null) { clearInterval(hashTimer); hashTimer = null; }
            if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
            unbindHost();
            generation += 1;
            rowsShown = [];
        }

        /* ---------------------------------------------------------------- *
         * cells
         * ---------------------------------------------------------------- */

        function tokens() {
            var asset = trim(PVX.nav.currentAsset()) || sourceAsset;
            var segs = String(asset).split('\\').filter(function (x) { return !!x; });
            return { asset: segs.length > 2 ? segs[segs.length - 1] : '', assetpath: asset };
        }

        function cellText(v, col, cfg) {
            if (v === null || v === undefined) { return ''; }
            var type = state.types[col] || '';
            if (isTimeType(type) || (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v))) {
                var t = asTime(v);
                if (t !== null) {
                    var f = cfg.TimeFormat;
                    return PVX.fmt.time(t, f === 'datetime' || f === 'date' || f === 'iso' ? f : 'short');
                }
            }
            if (typeof v === 'number') { return PVX.fmt.number(v, PVX.config.numberOpts(cfg)); }
            if (typeof v === 'boolean') { return v ? 'True' : 'False'; }
            if (typeof v === 'object') { return v.Name !== undefined ? String(v.Name) : JSON.stringify(v); }
            return String(v);
        }

        function isNumCol(col) {
            if (isNumType(state.types[col])) { return true; }
            // A type AF did not name: numeric when every value is.
            if (state.types[col]) { return false; }
            var any = false;
            for (var i = 0; i < state.rows.length; i++) {
                var v = cellOf(state.rows[i], col);
                if (v === null || v === undefined || v === '') { continue; }
                if (typeof v !== 'number') { return false; }
                any = true;
            }
            return any;
        }

        function realColumn(name) {
            var want = lower(name);
            if (!want) { return ''; }
            for (var i = 0; i < state.columns.length; i++) { if (state.columns[i].toLowerCase() === want) { return state.columns[i]; } }
            return '';
        }

        /* ---------------------------------------------------------------- *
         * render
         * ---------------------------------------------------------------- */

        function render(c) {
            var cfg = liveCfg = c.config || liveCfg;
            var host = c.host;
            if (!host) { return; }
            applyThemeVars(c, c.theme);
            if (lastFilterSeed !== String(cfg.Filter || '')) {
                lastFilterSeed = String(cfg.Filter || '');
                scope.pvx.filter = lastFilterSeed;
            }
            scope.pvx.title = trim(cfg.Title) || trim(cfg.TableName);
            scope.pvx.showFilter = cfg.ShowFilterBox !== false && state.phase === 'ok' && state.rows.length > 0;
            scope.pvx.clickable = (cfg.ClickAction === 'asset' && !!realColumn(cfg.AssetColumn)) ||
                (cfg.ClickAction === 'navigate' && !!trim(cfg.NavigateTarget));
            scope.pvx.summary = '';
            bindHost(host);
            rowsShown = [];
            lastView = null;
            var html, notes = [];
            if (state.phase !== 'ok') {
                html = statusHtml(cfg);
            } else {
                var pc = parseColumns(cfg.Columns, state.columns);
                var rf = parseRowFilter(cfg.RowFilter);
                var unknownRule = rf.rules.filter(function (r) { return !realColumn(r.col); }).map(function (r) { return r.col; });
                var timeCol = realColumn(cfg.TimeColumn);
                var win = { from: null, to: null };
                if (timeCol) {
                    var p = PVX.nav.parseHash().params || {};
                    var now = Date.now();
                    win.from = PVX.nav.parseTime(p.starttime || '*-8h', now);
                    win.to = PVX.nav.parseTime(p.endtime || '*', now);
                }
                var sortCol = sortOverride ? sortOverride.col : realColumn(cfg.SortBy);
                var desc = sortOverride ? sortOverride.desc : cfg.SortDescending === true;
                var view = buildTable(state.rows, {
                    rules: rf.rules.filter(function (r) { return !!realColumn(r.col); }),
                    tokens: tokens(),
                    timeCol: timeCol, from: win.from, to: win.to,
                    filter: scope.pvx.filter,
                    textOf: function (row) {
                        return pc.cols.map(function (col) { return cellText(cellOf(row, col.name), col.name, cfg); }).join('\u0001');
                    },
                    sortCol: sortCol, desc: desc,
                    groupCol: realColumn(cfg.GroupBy),
                    max: intIn(cfg.MaxRows, 1, 20000, 1000)
                });
                view.cols = pc.cols;
                view.sortCol = sortCol;
                view.desc = desc;
                lastView = view;
                html = tableHtml(view, cfg);
                notes = footerNotes(view, cfg, pc, rf, unknownRule, timeCol);
                scope.pvx.summary = view.shown + (view.shown === 1 ? ' row' : ' rows') +
                    (view.shown !== view.total ? ' of ' + view.total : '');
            }
            if (html !== lastHtml) {
                var scroll = host.querySelector('.pvx-lkt-scroll');
                if (!scroll) {
                    scroll = document.createElement('div');
                    scroll.className = 'pvx-lkt-scroll';
                    host.appendChild(scroll);
                }
                scroll.innerHTML = html;
                lastHtml = html;
            }
            scope.pvx.note = notes.join(' · ');
            scope.pvx.canDownload = cfg.ShowDownload !== false && !!lastView && lastView.shown > 0;
            digest();
        }

        function statusHtml(cfg) {
            var esc = PVX.util.escapeHtml;
            var head, detail = '', tone = '';
            if (state.phase === 'unconfigured') {
                head = 'PI Web API is not configured';
                detail = PVX.api.unsetHint() + ', then confirm it with ext/piwebapi-check.html.';
                tone = ' pvx-lkt-warn';
            } else if (state.phase === 'nodb') {
                head = trim(cfg.TableName) ? 'No AF database configured' : 'No table chosen';
                detail = trim(cfg.TableName)
                    ? 'Drop an AF attribute onto this symbol to use its database, or set the AF database path in the format pane.'
                    : 'Set Table in the format pane to the name of a table in the database\'s Library, under Tables.';
                tone = ' pvx-lkt-warn';
            } else if (state.phase === 'notable') {
                head = 'No table "' + trim(cfg.TableName) + '"';
                var names = state.tableNames || [];
                detail = 'The database ' + state.db.path + ' has ' + (names.length ? 'these tables: ' + names.join(', ') + '.' : 'no tables.');
                tone = ' pvx-lkt-warn';
            } else if (state.phase === 'error') {
                var e = (state.error && state.error.pvxError) || null;
                head = 'PI Web API request failed';
                detail = e ? e.message + (e.check ? ' Check: ' + e.check + '.' : '') : 'The request failed and returned no diagnosis.';
                tone = ' pvx-lkt-alarm';
            } else {
                head = 'Loading the table…';
            }
            return '<div class="pvx-lkt-empty' + tone + '"><div class="pvx-lkt-empty-head">' + esc(head) + '</div>' +
                (detail ? '<div class="pvx-lkt-empty-detail">' + esc(detail) + '</div>' : '') + '</div>';
        }

        function tableHtml(view, cfg) {
            var esc = PVX.util.escapeHtml;
            var cols = view.cols;
            if (!cols.length) {
                return '<div class="pvx-lkt-empty pvx-lkt-warn"><div class="pvx-lkt-empty-head">No columns to show</div>' +
                    '<div class="pvx-lkt-empty-detail">' + esc('The table has: ' + state.columns.join(', ') + '.') + '</div></div>';
            }
            var colorCol = realColumn(cfg.ColorColumn);
            var bands = trim(cfg.Thresholds);
            var parts = ['<table class="pvx-lkt-table"><thead><tr>'];
            var j;
            for (j = 0; j < cols.length; j++) {
                var on = view.sortCol === cols[j].name;
                parts.push('<th data-pvx-sort="', esc(cols[j].name), '" class="pvx-lkt-', isNumCol(cols[j].name) ? 'right' : 'left',
                    on ? ' pvx-lkt-sorted' : '', '" title="Sort by ', esc(cols[j].label), '">', esc(cols[j].label),
                    on ? '<span class="pvx-lkt-arrow">' + (view.desc ? '▾' : '▴') + '</span>' : '', '</th>');
            }
            parts.push('</tr></thead><tbody>');
            if (!view.shown) {
                parts.push('<tr class="pvx-lkt-none"><td colspan="', cols.length, '">', esc(emptyText(view)), '</td></tr>');
            }
            var grouped = view.groups.length && view.groups[0].label !== '';
            for (var g = 0; g < view.groups.length; g++) {
                var grp = view.groups[g];
                if (grouped) {
                    parts.push('<tr class="pvx-lkt-group"><td colspan="', cols.length, '">', esc(grp.label),
                        '<span class="pvx-lkt-group-n">', grp.rows.length, '</span></td></tr>');
                }
                for (var r = 0; r < grp.rows.length; r++) {
                    var row = grp.rows[r];
                    var idx = rowsShown.length;
                    rowsShown.push(row);
                    parts.push('<tr data-pvx-i="', idx, '">');
                    for (j = 0; j < cols.length; j++) {
                        var v = cellOf(row, cols[j].name);
                        var style = '';
                        if (bands && colorCol === cols[j].name) {
                            var b = PVX.thresholds.evaluate(bands, v);
                            if (b) { style = ' style="box-shadow: inset 4px 0 0 ' + esc(b.color) + '"'; }
                        }
                        parts.push('<td class="pvx-lkt-', isNumCol(cols[j].name) ? 'right' : 'left', '"', style, '>',
                            esc(cellText(v, cols[j].name, cfg)), '</td>');
                    }
                    parts.push('</tr>');
                }
            }
            parts.push('</tbody></table>');
            return parts.join('');
        }

        function emptyText(view) {
            if (view.hidden) { return 'No row matches "' + trim(scope.pvx.filter) + '"'; }
            if (view.timed && !view.ruled) { return 'No row dated in this time range'; }
            if (view.ruled) { return 'No row meets the row conditions'; }
            return 'The table has no rows';
        }

        function footerNotes(view, cfg, pc, rf, unknownRule, timeCol) {
            var n = [];
            if (view.ruled) { n.push(view.ruled + ' left out by the row conditions'); }
            if (view.timed) { n.push(view.timed + ' dated outside this time range'); }
            if (view.hidden) { n.push(view.hidden + ' not matching "' + trim(scope.pvx.filter) + '"'); }
            if (view.capped) { n.push(view.capped + ' more not shown; raise Max rows'); }
            if (pc.missing.length) { n.push('no column ' + pc.missing.map(function (x) { return '"' + x + '"'; }).join(', ')); }
            if (unknownRule.length) { n.push('row condition on no column ' + unknownRule.map(function (x) { return '"' + x + '"'; }).join(', ') + ', not applied'); }
            if (rf.errors.length) { n.push('row condition not read: ' + rf.errors.map(function (x) { return '"' + x + '"'; }).join(', ')); }
            if (rf.rules.some(function (r) { return /\{asset\}/i.test(r.value); }) && !tokens().asset) {
                n.push('{asset} is blank: the display has no asset');
            }
            if (trim(cfg.TimeColumn) && !timeCol) { n.push('no date column "' + trim(cfg.TimeColumn) + '"'); }
            if (trim(cfg.GroupBy) && !realColumn(cfg.GroupBy)) { n.push('no column "' + trim(cfg.GroupBy) + '" to group by'); }
            if (trim(cfg.ColorColumn) && !realColumn(cfg.ColorColumn)) { n.push('no column "' + trim(cfg.ColorColumn) + '" to color'); }
            if (state.db.from) { n.push('database ' + state.db.path + ' from ' + state.db.from); }
            return n;
        }

        /* ---------------------------------------------------------------- *
         * CSV: the rows shown, raw values, in their order
         * ---------------------------------------------------------------- */
        function csvRows(view) {
            var cols = view.cols;
            var out = [cols.map(function (c) { return c.label; })];
            for (var g = 0; g < view.groups.length; g++) {
                for (var r = 0; r < view.groups[g].rows.length; r++) {
                    var row = view.groups[g].rows[r];
                    out.push(cols.map(function (c) {
                        var v = cellOf(row, c.name);
                        return v === null || v === undefined ? '' : (typeof v === 'object' ? (v.Name !== undefined ? v.Name : JSON.stringify(v)) : v);
                    }));
                }
            }
            return out;
        }

        function save() {
            var cfg = liveCfg;
            if (!lastView || !lastView.shown) { return; }
            var name = (trim(cfg.Title) || trim(cfg.TableName) || 'Table') + ' ' +
                PVX.fmt.time(Date.now(), 'iso').slice(0, 16).replace(/[:T]/g, '-');
            var ok = PVX.download.csv(name, csvRows(lastView));
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
            var node = ev.target, guard = 0;
            while (node && node !== boundHost && guard < 12) {
                if (node.getAttribute) {
                    var col = node.getAttribute('data-pvx-sort');
                    if (col !== null) { sortBy(col); return; }
                    var i = node.getAttribute('data-pvx-i');
                    if (i !== null) { activate(parseInt(i, 10)); return; }
                }
                node = node.parentNode;
                guard += 1;
            }
        }

        /** First click: numbers largest first, text A to Z; the next reverses. */
        function sortBy(col) {
            var cfg = liveCfg;
            var cur = sortOverride || { col: realColumn(cfg.SortBy), desc: cfg.SortDescending === true };
            sortOverride = cur.col === col ? { col: col, desc: !cur.desc } : { col: col, desc: isNumCol(col) };
            ctx.render();
        }

        /**
         * {Column} in the target is the row's value, so one table of units
         * can open each unit's display. The asset column, when set, goes as
         * asset= and must hold an element path.
         */
        function activate(index) {
            var cfg = liveCfg;
            var row = rowsShown[index];
            if (!row) { return; }
            var assetCol = realColumn(cfg.AssetColumn);
            var asset = assetCol ? trim(cellOf(row, assetCol)) : '';
            if (cfg.ClickAction === 'asset') {
                if (asset) { PVX.nav.go(PVX.nav.url({ asset: asset }), false); }
            } else if (cfg.ClickAction === 'navigate') {
                var target = trim(cfg.NavigateTarget).replace(/\{([^}]+)\}/g, function (all, name) {
                    var col = realColumn(name);
                    return col ? encodeURIComponent(trim(cellText(cellOf(row, col), col, { TimeFormat: 'iso' }))) : all;
                });
                if (!target) { return; }
                var opts = { display: target };
                if (asset) { opts.asset = asset; }
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
        }

        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        lastHashKey = hashKey();
        hashTimer = setInterval(pollHash, 1000);
        ensureTimers(liveCfg);
        refresh();
        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
