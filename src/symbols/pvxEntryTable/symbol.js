/* ============================================================================
 * pvxEntryTable — "PVX Shift Log"
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector (see the definition). Everything here goes through PI Web API via PVX.api.
 *
 * WHAT THIS IS
 *   pvxManualEntry at operator-rounds scale. One form, several attributes, one
 *   submit. The operator walks the unit with a clipboard, comes back, types
 *   twelve readings and presses one button — which is how rounds actually work.
 *   Twelve separate entry symbols would be twelve confirmations and twelve
 *   chances to forget one.
 *
 * WHY THE SUBMIT IS ONE ACTION BUT THE WRITES ARE NOT
 *   PI has no transaction. Twelve writes are twelve independent facts, and the
 *   eleventh can fail while the other eleven succeed. So the symbol uses
 *   PVX.api.writeValues(), which sends them one at a time and resolves with
 *   {ok, failed} and NEVER rejects — precisely so three saved rows and one
 *   failure can be shown as exactly that. Collapsing a partial success into
 *   "failed" would send the operator back to re-type eleven readings that are
 *   already in the historian, which is how duplicates get made.
 *
 * REQUEST SHAPE
 *   - Every row path is resolved to a WebId in ONE batched request, not one
 *     request per row: on a 20-row form that is one authentication handshake
 *     and one CORS preflight instead of twenty. WebIds are cached for the life
 *     of the symbol; values never are.
 *   - Current values come back in ONE streamsets call for the whole form.
 *   - Writes are the exception, deliberately: one call each, no batching, no
 *     retry. A write that is quietly coalesced or repeated is a wrong number in
 *     the archive.
 *
 * WHY REAL DOM
 *   Twenty inputs that have to be reachable with Tab and typed into. SVG would
 *   look the same and be unusable.
 *
 * TEARDOWN
 *   The refresh timer and every listener are the symbol's own, so every one of
 *   them is removed in onDestroy. A leaked poller on a kiosk runs for weeks.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below this a multi-row form is not usable: the labels, the fields and the
     * confirm step cannot all be read. A squeezed rounds sheet is a mis-typed
     * write waiting to happen, so the symbol names itself and refuses. */
    var MIN_W = 200, MIN_H = 140;

    /* Columns are dropped in this order as the symbol narrows. */
    var CURRENT_W = 330;      // the "now" column needs this much width
    var STATUS_W = 300;       // the per-row saved/failed column

    var definition = {
        typeName: 'pvxEntryTable',
        displayName: 'PVX Shift Log',

        // One data source, which this symbol ignores: everything it shows comes
        // from its config pane. PI Vision keeps DatasourceBehaviors.None symbols
        // out of the symbol selector altogether (its guide calls them "static
        // symbols"), so declared that way this could never be placed on a
        // display. Pick it and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        // A collection would repeat the whole sheet per element while every
        // copy still wrote to the paths typed in the config pane.
        supportsCollections: false,
        configTitle: 'Format Shift Log',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                // The cheapest query PI Vision has, for a value nothing reads.
                DataShape: 'Value',
                Height: 320,
                Width: 460,

                Title: 'Shift log',
                ShowLabel: true,

                /* -- the rows ------------------------------------------------- *
                 * One row per line:  <path> | <label> | <units> | <min>:<max>
                 * Only the path is required. See parseRows() for why the field
                 * separator is a pipe with a SPACE beside it. */
                Rows: '',

                /* -- optional base -------------------------------------------- *
                 * With this set, a row may be a bare attribute name. It is the
                 * difference between a readable 20-row form and 20 lines of
                 * near-identical 80-character paths. */
                ElementPath: '',

                /* -- what the operator sees ------------------------------------ */
                ShowCurrentValues: true,
                RefreshSeconds: 60,

                /* -- the submit -------------------------------------------------- */
                RequireConfirm: true,
                SubmitLabel: 'Submit readings',
                AllowPartial: true,
                ClearAfterSubmit: true,

                /* -- when the values happened ------------------------------------ */
                TimestampMode: 'now',      // now | custom | perRow

                /* -- feedback ------------------------------------------------------ */
                ShowRowStatus: true,
                CompactRows: false,

                /* -- build-before-permissions mode ---------------------------------- */
                ReadOnlyPreview: false
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the header is Angular-bound; the sheet itself is imperative DOM.
        scope.pvx = { title: '', subtitle: '', background: '' };

        /* ---------------------------------------------------------------- *
         * instance state
         * ---------------------------------------------------------------- */
        var state = {
            phase: 'idle',        // idle | resolving | ready | unconfigured | norows
            rows: [],             // parsed + resolved rows, in configured order
            busy: false,          // a submit is in flight — the whole form locks
            pending: null,        // validated writes awaiting confirmation
            message: null,        // {tone, text, detail}
            lastSubmit: null      // {ok, failed} counts from the last submit
        };

        var liveCfg = scope.config || {};
        var generation = 0;

        /* Path -> WebId, resolved once and kept. A WebId is stable for the life
         * of the attribute; the VALUE is the thing that must never be cached. */
        var webIds = {};

        var refreshTimer = null;
        var timerSeconds = null;
        var debounceTimer = null;

        var ui = null;
        var rowSig = '';          // rebuild row nodes only when the rows change
        var listeners = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-etable-body',
            render: render,

            onConfigChange: function (newCfg) {
                liveCfg = newCfg || liveCfg;
                ensureTimer(liveCfg);
                // Debounced: the Rows textarea fires this on every keystroke,
                // and each one would otherwise be a batch of lookups against
                // half-typed paths.
                refreshSoon();
            },

            onDestroy: teardown
        });

        /* ================================================================ *
         * helpers
         * ================================================================ */

        function trim(s) {
            return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, '');
        }

        function intIn(v, lo, hi, fallback) {
            var n = parseInt(v, 10);
            if (!isFinite(n)) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        function el(tag, cls, parent) {
            var n = document.createElement(tag);
            if (cls) { n.className = cls; }
            if (parent) { parent.appendChild(n); }
            return n;
        }

        function on(node, type, fn) {
            node.addEventListener(type, fn, false);
            listeners.push({ node: node, type: type, fn: fn });
        }

        function show(node, visible) {
            if (node) { node.style.display = visible ? '' : 'none'; }
        }

        function setText(node, text) {
            // textContent everywhere: an AF name or a server error must never
            // be able to become markup.
            if (node && node.textContent !== text) { node.textContent = text; }
        }

        function isPreview(cfg) { return cfg.ReadOnlyPreview === true; }

        /* ================================================================ *
         * the row grammar
         * ================================================================ *
         *   \\AFSERVER01\Production\Reactor1|Catalyst Charge | Charge | kg | 0:500
         *   Catalyst Charge | Charge | kg | 0:500          (with an ElementPath)
         *
         * THE SEPARATOR PROBLEM, AND THE RULE THAT SOLVES IT
         *   The field separator is a pipe. So is the element/attribute separator
         *   inside an AF path. Splitting naively on '|' therefore cuts every
         *   full path in half and silently turns the attribute name into the
         *   label — a row that resolves to the wrong thing, or to nothing.
         *
         *   The rule: a pipe with WHITESPACE beside it separates fields; a pipe
         *   with no space either side belongs to the path. AF paths are written
         *   without spaces around the pipe, and a field list is far easier to
         *   read with them, so the two conventions do not collide in practice.
         *   The config pane states this with a worked example, because a rule
         *   nobody is told about is a trap.
         */
        function splitFields(line) {
            // Two passes rather than one regex with alternation: the sentinel
            // makes it obvious that ' | ' is consumed exactly once.
            return line
                .replace(/\s+\|/g, '\u0001')
                .replace(/\|\s+/g, '\u0001')
                .split('\u0001');
        }

        function parseRange(text) {
            var s = trim(text);
            if (!s || s.indexOf(':') === -1) { return { min: null, max: null }; }
            var bits = s.split(':');
            return { min: PVX.util.num(bits[0]), max: PVX.util.num(bits[1]) };
        }

        /** Last path segment — the attribute's own name, for a default label. */
        function leafOf(p) {
            var s = String(p);
            var bar = s.lastIndexOf('|');
            if (bar !== -1) { s = s.slice(bar + 1); }
            var bs = s.lastIndexOf('\\');
            if (bs !== -1) { s = s.slice(bs + 1); }
            return s || String(p);
        }

        function parseRows(cfg) {
            var base = trim(cfg.ElementPath);
            var out = [];
            String(cfg.Rows || '').split(/\r?\n/).forEach(function (line) {
                var raw = trim(line);
                // '#' comments so a site can leave a note in a rounds sheet.
                if (!raw || raw.charAt(0) === '#') { return; }

                var f = splitFields(raw);
                var pathText = trim(f[0]);
                if (!pathText) { return; }

                var absolute = pathText.indexOf('\\\\') === 0;
                var full = absolute ? pathText : (base ? base + '|' + pathText : '');
                var range = parseRange(f[3]);

                out.push({
                    key: 'r' + out.length,
                    path: full,
                    // Named before it is resolved, so the confirmation can say
                    // what it is writing to even if the lookup is still running.
                    label: trim(f[1]) || leafOf(pathText),
                    units: trim(f[2]),
                    min: range.min,
                    max: range.max,
                    webId: full ? (webIds[full] || '') : '',
                    // A relative name with no ElementPath is the one row error
                    // that needs no round trip to diagnose.
                    error: full ? null : {
                        message: 'This row is a relative attribute name, but no element path is set.',
                        check: 'ElementPath'
                    },
                    current: null,
                    status: '',
                    note: ''
                });
            });
            return out;
        }

        /** Changes exactly when the ROW SET changes — not when a value does. */
        function rowSignature(rows, cfg) {
            var parts = [];
            for (var i = 0; i < rows.length; i++) {
                parts.push(rows[i].path + '\u0002' + rows[i].label + '\u0002' + rows[i].units);
            }
            return parts.join('\u0003') + '||' + (cfg.TimestampMode === 'perRow' ? 'per' : 'one');
        }

        /* ================================================================ *
         * PI Web API
         * ================================================================ */

        function apiUrl(p) { return PVX.api.base() + '/' + p; }

        /**
         * Resolve every unresolved row path in ONE batch.
         *
         * As individual requests this is one authentication handshake and one
         * CORS preflight per row. Rows already resolved are skipped, so the
         * second refresh of a 20-row sheet costs nothing.
         */
        function resolveRows(rows) {
            var reqs = {};
            var keys = [];
            var paths = [];
            var i;

            for (i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (!r.path || r.webId) { continue; }
                var k = 'p' + keys.length;
                reqs[k] = {
                    Method: 'GET',
                    Resource: apiUrl('attributes?path=' + encodeURIComponent(r.path) +
                        '&selectedFields=WebId;Name;DefaultUnitsName')
                };
                keys.push(k);
                paths.push(i);
            }
            if (!keys.length) { return Promise.resolve(); }

            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                var split = PVX.api.batchResults(res);
                for (var j = 0; j < keys.length; j++) {
                    var row = rows[paths[j]];
                    var body = split.ok[keys[j]];
                    if (body && body.WebId) {
                        row.webId = body.WebId;
                        webIds[row.path] = body.WebId;
                        if (!row.units) { row.units = body.DefaultUnitsName || ''; }
                        row.error = null;
                    } else {
                        var f = split.failed[keys[j]];
                        // Per row, because one bad line in a rounds sheet must
                        // not take the other nineteen down with it.
                        row.error = {
                            message: 'Path did not resolve' + (f && f.status ? ' (HTTP ' + f.status + ')' : '') +
                                     '. Check the AF server, database, element and attribute names.',
                            check: 'row path'
                        };
                    }
                }
            })['catch'](function (err) {
                // The batch itself failed — a transport or auth problem, not a
                // per-row one. Say so on every unresolved row rather than
                // blaming the paths.
                var e = (err && err.pvxError) || null;
                for (var j = 0; j < keys.length; j++) {
                    rows[paths[j]].error = e
                        ? { message: e.message, check: e.check }
                        : { message: 'The lookup failed and returned no diagnosis.', check: 'PI Web API' };
                }
            });
        }

        /** Current values for the whole sheet in ONE request. */
        function readCurrent(rows, cfg, gen) {
            if (cfg.ShowCurrentValues === false) { return Promise.resolve(); }
            var ids = [];
            var byId = {};
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].webId && !byId[rows[i].webId]) {
                    byId[rows[i].webId] = true;
                    ids.push(rows[i].webId);
                }
            }
            if (!ids.length) { return Promise.resolve(); }

            return PVX.api.readValues(ids, { cache: false }).then(function (res) {
                if (stale(gen)) { return; }
                var map = {};
                var items = (res && res.Items) || [];
                for (var j = 0; j < items.length; j++) {
                    map[items[j].WebId] = items[j].Value || items[j];
                }
                for (var k = 0; k < rows.length; k++) {
                    var v = map[rows[k].webId];
                    if (!v) { continue; }
                    var raw = unwrap(v.Value);
                    rows[k].current = {
                        display: displayValue(raw, cfg),
                        timestamp: v.Timestamp,
                        good: v.Good !== false
                    };
                }
            })['catch'](function () {
                // A failed READ never blocks a WRITE: read and write are
                // separate permissions in PI and having one without the other
                // is normal. The column simply shows nothing.
                for (var k = 0; k < rows.length; k++) { rows[k].current = null; }
            });
        }

        function unwrap(v) {
            if (v !== null && typeof v === 'object') {
                if (v.Name !== undefined) { return v.Name; }      // digital state
                if (v.Value !== undefined) { return unwrap(v.Value); }
                return null;
            }
            return v === undefined ? null : v;
        }

        function displayValue(raw, cfg) {
            if (raw === null || raw === undefined || raw === '') { return '--'; }
            if (typeof raw === 'boolean') { return raw ? 'True' : 'False'; }
            if (typeof raw === 'string') { return raw; }
            var n = PVX.util.num(raw);
            return n === null ? String(raw) : PVX.fmt.number(n, { decimals: cfg.Decimals });
        }

        /* ================================================================ *
         * refresh
         * ================================================================ */

        function refresh() {
            if (ctx.destroyed) { return; }
            var cfg = liveCfg = scope.config || liveCfg;

            // With no baseUrl set, PVX.api first asks PI Vision's own server
            // for /piwebapi. Decide nothing until it has its answer.
            if (PVX.api.discovering()) {
                PVX.api.discover().then(function () { if (!ctx.destroyed) { refresh(); } });
                return;
            }
            if (!PVX.api.isConfigured()) {
                state.phase = 'unconfigured';
                ctx.render();
                return;
            }

            var parsed = parseRows(cfg);
            if (!parsed.length) {
                state.phase = 'norows';
                state.rows = [];
                ctx.render();
                return;
            }

            // Carry over what the operator has already typed and what the last
            // submit reported. Re-parsing must not blank a half-filled sheet.
            carryOver(parsed, state.rows);
            state.rows = parsed;

            var gen = ++generation;
            if (state.phase !== 'ready') { state.phase = 'resolving'; }
            ctx.render();

            resolveRows(parsed)
                .then(function () {
                    if (stale(gen)) { return null; }
                    state.phase = 'ready';
                    ctx.render();
                    return readCurrent(parsed, cfg, gen);
                })
                .then(function () {
                    if (stale(gen)) { return; }
                    ctx.render();
                })['catch'](function () {
                    if (stale(gen)) { return; }
                    state.phase = 'ready';
                    ctx.render();
                });
        }

        /** Preserve typed values and per-row status across a re-parse. */
        function carryOver(next, prev) {
            var byPath = {};
            for (var i = 0; i < prev.length; i++) {
                if (prev[i].path) { byPath[prev[i].path] = prev[i]; }
            }
            for (var j = 0; j < next.length; j++) {
                var old = byPath[next[j].path];
                if (!old) { continue; }
                next[j].current = old.current;
                next[j].status = old.status;
                next[j].note = old.note;
                next[j].typed = old.typed;
                next[j].typedStamp = old.typedStamp;
            }
        }

        function stale(gen) {
            return ctx.destroyed || gen !== generation;
        }

        /* ================================================================ *
         * timers
         * ================================================================ */

        function ensureTimer(cfg) {
            var secs = intIn(cfg.RefreshSeconds, 5, 86400, 60);
            if (refreshTimer !== null && timerSeconds === secs) { return; }
            if (refreshTimer !== null) { clearInterval(refreshTimer); }
            timerSeconds = secs;
            refreshTimer = setInterval(function () {
                // Never mid-confirmation or mid-submit: the numbers being
                // approved must not move under the operator.
                if (state.pending || state.busy) { return; }
                captureTyped();
                refresh();
            }, secs * 1000);
        }

        function refreshSoon() {
            if (debounceTimer !== null) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(function () {
                debounceTimer = null;
                captureTyped();
                refresh();
            }, 400);
        }

        function teardown() {
            if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
            if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
            for (var i = 0; i < listeners.length; i++) {
                try {
                    listeners[i].node.removeEventListener(listeners[i].type, listeners[i].fn, false);
                } catch (e) { /* the node may already be gone */ }
            }
            listeners = [];
            generation += 1;      // anything in flight resolves into stale()
            ui = null;
            state.rows = [];
            state.pending = null;
            state.busy = false;
        }

        /* ================================================================ *
         * timestamps — see pvxManualEntry for the reasoning; the same rules
         * apply, only the scope differs (one stamp for the set, or one each).
         * ================================================================ */

        var UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

        function parseTimestamp(text, nowMs) {
            var raw = trim(text);
            if (!raw) { return null; }
            var s = raw.replace(/\s+/g, '').toLowerCase();
            if (s.charAt(0) === '*') {
                var rest = s.slice(1);
                if (!rest) { return nowMs; }
                var re = /([+-])(\d+(?:\.\d+)?)(s|m|h|d|w)/g;
                var total = 0, consumed = 0, m;
                while ((m = re.exec(rest)) !== null) {
                    total += (m[1] === '-' ? -1 : 1) * parseFloat(m[2]) * UNIT_MS[m[3]];
                    consumed += m[0].length;
                }
                if (!consumed || consumed !== rest.length) { return null; }
                return nowMs + total;
            }
            var d = PVX.fmt.toDate(raw);
            return d ? d.getTime() : null;
        }

        /**
         * @returns {Object} {ok, iso, error}
         * '*' means "let PI stamp it" — the historian's clock is the authority
         * and a browser's is routinely minutes out.
         */
        function resolveStamp(text, allowFuture) {
            if (!trim(text)) { return { ok: true, iso: '*' }; }
            var now = (new Date()).getTime();
            var ms = parseTimestamp(text, now);
            if (ms === null) {
                return { ok: false, error: 'timestamp not understood (use 2026-08-08 06:00 or *-2h)' };
            }
            if (!allowFuture && ms > now + 60000) {
                return { ok: false, error: 'timestamp is in the future' };
            }
            return { ok: true, iso: new Date(ms).toISOString() };
        }

        /* ================================================================ *
         * validation — everything checkable is checked BEFORE anything is sent
         * ================================================================ */

        /** Pull what is currently in the inputs into the row model. */
        function captureTyped() {
            if (!ui || !ui.rowNodes) { return; }
            for (var i = 0; i < state.rows.length; i++) {
                var n = ui.rowNodes[i];
                if (!n) { continue; }
                state.rows[i].typed = n.input ? n.input.value : '';
                state.rows[i].typedStamp = n.stamp ? n.stamp.value : '';
            }
        }

        function filledCount() {
            var c = 0;
            for (var i = 0; i < state.rows.length; i++) {
                if (trim(state.rows[i].typed)) { c += 1; }
            }
            return c;
        }

        function writableCount() {
            var c = 0;
            for (var i = 0; i < state.rows.length; i++) {
                if (state.rows[i].webId) { c += 1; }
            }
            return c;
        }

        /**
         * @returns {Object} {ok, writes:[{key,webId,value,timestamp,display,label,units,index}],
         *                    errors:[{index,text}]}
         */
        function validateAll(cfg) {
            captureTyped();
            var writes = [];
            var errors = [];
            var perRow = trim(cfg.TimestampMode) === 'perRow';
            var setStamp = { ok: true, iso: '*' };

            if (trim(cfg.TimestampMode) === 'custom') {
                setStamp = resolveStamp(ui && ui.stampInput ? ui.stampInput.value : '', false);
                if (!setStamp.ok) {
                    return { ok: false, writes: [], errors: [{ index: -1, text: 'The sheet ' + setStamp.error + '.' }] };
                }
            }

            for (var i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                var text = trim(r.typed);
                if (!text) { continue; }               // blank rows are simply not sent

                if (!r.webId) {
                    errors.push({ index: i, text: r.label + ': this row did not resolve, so it cannot be written.' });
                    continue;
                }

                // Not PVX.util.num: that strips non-numeric characters so charts
                // survive "12.3 kg". Here "12.3kg" is a typo the operator must
                // see, not a number to be guessed at.
                if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
                    errors.push({ index: i, text: r.label + ': "' + text + '" is not a number.' });
                    continue;
                }
                var value = parseFloat(text);
                if (!isFinite(value)) {
                    errors.push({ index: i, text: r.label + ': "' + text + '" is not a number.' });
                    continue;
                }
                if (r.min !== null && value < r.min) {
                    errors.push({ index: i, text: r.label + ': ' + value + ' is below ' + r.min + '.' });
                    continue;
                }
                if (r.max !== null && value > r.max) {
                    errors.push({ index: i, text: r.label + ': ' + value + ' is above ' + r.max + '.' });
                    continue;
                }

                var stamp = setStamp.iso;
                if (perRow) {
                    var rs = resolveStamp(r.typedStamp, false);
                    if (!rs.ok) {
                        errors.push({ index: i, text: r.label + ': ' + rs.error + '.' });
                        continue;
                    }
                    stamp = rs.iso;
                }

                writes.push({
                    key: r.key,
                    index: i,
                    webId: r.webId,
                    value: value,
                    timestamp: stamp,
                    label: r.label,
                    units: r.units,
                    display: PVX.fmt.number(value, { decimals: cfg.Decimals })
                });
            }

            return { ok: errors.length === 0 && writes.length > 0, writes: writes, errors: errors };
        }

        /* ================================================================ *
         * the submit
         * ================================================================ */

        function onSubmit() {
            var cfg = liveCfg;
            if (state.busy || state.phase !== 'ready') { return; }

            if (isPreview(cfg)) {
                state.message = {
                    tone: 'warn',
                    text: 'Read-only preview',
                    detail: 'This symbol is in preview mode and will not write. Clear "Read-only preview" ' +
                            'in the format pane once the AF write permissions are in place.'
                };
                ctx.render();
                return;
            }

            if (cfg.AllowPartial === false && filledCount() < writableCount()) {
                state.message = {
                    tone: 'warn',
                    text: 'Every row needs a value',
                    detail: 'This sheet is set to all-or-nothing. Fill the remaining rows, or allow ' +
                            'partial submission in the format pane.'
                };
                ctx.render();
                return;
            }

            var v = validateAll(cfg);
            if (v.errors.length) {
                markRowErrors(v.errors);
                // index -1 is the sheet-wide timestamp, not a row. Calling that
                // "one row cannot be sent" would send the operator looking down
                // the rows for a problem that is not in any of them.
                var sheetLevel = v.errors.length === 1 && v.errors[0].index === -1;
                state.message = {
                    tone: 'error',
                    text: sheetLevel ? 'The sheet cannot be sent'
                        : (v.errors.length === 1 ? 'One row cannot be sent' : v.errors.length + ' rows cannot be sent'),
                    // Nothing at all is sent while a row is invalid: a partial
                    // send here would be the symbol deciding which of the
                    // operator's readings to keep, which is not its call.
                    detail: v.errors[0].text + (v.errors.length > 1 ? ' (and ' + (v.errors.length - 1) + ' more)' : '')
                };
                state.pending = null;
                ctx.render();
                return;
            }
            if (!v.writes.length) {
                state.message = { tone: 'warn', text: 'Nothing to submit', detail: 'No row has a value in it yet.' };
                ctx.render();
                return;
            }

            if (cfg.RequireConfirm !== false) {
                // The confirmation approves THESE values, captured now, not
                // whatever is in the boxes by the time it is clicked.
                state.pending = v.writes;
                state.message = null;
                ctx.render();
                return;
            }
            sendWrites(v.writes);
        }

        function markRowErrors(errors) {
            for (var i = 0; i < state.rows.length; i++) {
                state.rows[i].status = '';
                state.rows[i].note = '';
            }
            for (var j = 0; j < errors.length; j++) {
                var idx = errors[j].index;
                if (idx >= 0 && state.rows[idx]) {
                    state.rows[idx].status = 'invalid';
                    state.rows[idx].note = 'check';
                }
            }
        }

        function onConfirm() {
            if (!state.pending || state.busy) { return; }
            sendWrites(state.pending);
        }

        function onCancel() {
            state.pending = null;
            state.message = { tone: 'info', text: 'Cancelled. Nothing was written.', detail: '' };
            ctx.render();
        }

        /**
         * Send the set.
         *
         * PVX.api.writeValues sends them one at a time and resolves with
         * {ok, failed}; it never rejects. That is the whole reason it exists:
         * three saved rows and one failure must show as three saved rows and
         * one failure. The form is locked for the flight and unlocked
         * afterwards, whatever the outcome.
         */
        function sendWrites(writes) {
            var cfg = liveCfg;
            state.busy = true;
            state.pending = null;
            state.message = { tone: 'info', text: 'Writing ' + writes.length + (writes.length === 1 ? ' value\u2026' : ' values\u2026'), detail: '' };

            var byIndex = {};
            var i;
            for (i = 0; i < writes.length; i++) {
                byIndex[writes[i].key] = writes[i];
                if (state.rows[writes[i].index]) {
                    state.rows[writes[i].index].status = 'sending';
                    state.rows[writes[i].index].note = '\u2026';
                }
            }
            ctx.render();

            var gen = generation;

            PVX.api.writeValues(writes).then(function (res) {
                if (ctx.destroyed) { return; }
                state.busy = false;

                var okKeys = {};
                for (i = 0; i < res.ok.length; i++) {
                    okKeys[res.ok[i].key] = true;
                    var w = byIndex[res.ok[i].key];
                    if (w && state.rows[w.index]) {
                        state.rows[w.index].status = 'saved';
                        state.rows[w.index].note = 'saved';
                        // Clear only the rows that ACTUALLY saved. Clearing a
                        // failed row would throw away a reading the operator
                        // still has to send, and they may no longer remember it.
                        if (cfg.ClearAfterSubmit !== false) {
                            state.rows[w.index].typed = '';
                            state.rows[w.index].typedStamp = '';
                            if (ui && ui.rowNodes[w.index] && ui.rowNodes[w.index].input) {
                                ui.rowNodes[w.index].input.value = '';
                                // The per-row timestamp goes with it. Leaving it
                                // behind means the NEXT reading typed into this
                                // row silently inherits the previous reading's
                                // time, which is a wrong timestamp nobody chose.
                                if (ui.rowNodes[w.index].stamp) { ui.rowNodes[w.index].stamp.value = ''; }
                            }
                        }
                    }
                }
                var forbidden = 0;
                for (i = 0; i < res.failed.length; i++) {
                    var f = res.failed[i];
                    var w2 = byIndex[f.key];
                    var code = (f.error && f.error.code) || '';
                    if (code === 'forbidden') { forbidden += 1; }
                    if (w2 && state.rows[w2.index]) {
                        state.rows[w2.index].status = 'failed';
                        // 'refused' rather than 'not permitted': the column is
                        // narrow and truncating the longer phrase leaves
                        // "not permi..." which reads as nothing at all. The
                        // full explanation is in the message below and in the
                        // cell's tooltip.
                        state.rows[w2.index].note = code === 'forbidden' ? 'refused' : 'failed';
                        state.rows[w2.index].failDetail = (f.error && f.error.message) || 'no diagnosis';
                    }
                }

                state.lastSubmit = { ok: res.ok.length, failed: res.failed.length };
                state.message = summarise(res, forbidden);

                // Read back, so the "now" column shows what PI holds rather
                // than what we believe we sent.
                if (!stale(gen)) { readCurrent(state.rows, cfg, gen).then(function () { ctx.render(); }); }
                ctx.render();
            });
        }

        function summarise(res, forbidden) {
            var okN = res.ok.length, badN = res.failed.length;
            if (!badN) {
                return {
                    tone: 'ok',
                    text: okN + (okN === 1 ? ' value saved' : ' values saved'),
                    detail: ''
                };
            }
            if (!okN) {
                return {
                    tone: 'error',
                    text: badN === 1 ? 'The write failed' : 'All ' + badN + ' writes failed',
                    detail: forbidden
                        ? 'Not permitted. PI and AF security govern who may write and the symbol cannot ' +
                          'grant it — ask for a write mapping on the AF database or the PI points.'
                        : firstFailure(res)
                };
            }
            // The case this symbol exists to report honestly.
            return {
                tone: 'warn',
                text: okN + ' saved, ' + badN + (badN === 1 ? ' failed' : ' failed'),
                detail: (forbidden
                    ? forbidden + (forbidden === 1 ? ' row was refused' : ' rows were refused') +
                      ' — PI/AF security governs who may write to those attributes. '
                    : '') +
                    'The saved rows are in PI; only the failed ones still need sending.'
            };
        }

        function firstFailure(res) {
            var e = res.failed[0] && res.failed[0].error;
            return e ? e.message + '  Check: ' + e.check : 'No diagnosis was returned.';
        }

        /* ================================================================ *
         * DOM — built once per row set, then patched
         * ================================================================ */

        function buildDom(host) {
            host.innerHTML = '';
            var u = {};

            u.state = el('div', 'pvx-etable-state', host);
            u.stateHead = el('div', 'pvx-etable-state-head', u.state);
            u.stateBody = el('div', 'pvx-etable-state-body', u.state);

            u.form = el('div', 'pvx-etable-form', host);

            u.head = el('div', 'pvx-etable-row pvx-etable-head', u.form);
            u.headLabel = el('span', 'pvx-etable-c-label', u.head);
            u.headCurrent = el('span', 'pvx-etable-c-current', u.head);
            u.headInput = el('span', 'pvx-etable-c-input', u.head);
            u.headStatus = el('span', 'pvx-etable-c-status', u.head);
            setText(u.headLabel, 'Reading');
            setText(u.headCurrent, 'Now');
            setText(u.headInput, 'New value');
            setText(u.headStatus, 'Result');

            u.rows = el('div', 'pvx-etable-rows', u.form);
            u.rowNodes = [];

            /* -- one timestamp for the whole set ------------------------------ */
            u.stampRow = el('div', 'pvx-etable-stamp', u.form);
            u.stampLabel = el('label', 'pvx-etable-stamp-label', u.stampRow);
            setText(u.stampLabel, 'Readings taken');
            u.stampInput = el('input', 'pvx-etable-input pvx-etable-stamp-input', u.stampRow);
            u.stampInput.type = 'text';
            u.stampInput.setAttribute('placeholder', '2026-08-08 06:00  or  *-2h');
            u.stampInput.id = PVX.util.uid('pvx-et-ts');
            u.stampLabel.setAttribute('for', u.stampInput.id);

            u.foot = el('div', 'pvx-etable-foot', u.form);

            u.actions = el('div', 'pvx-etable-actions', u.foot);
            u.submit = el('button', 'pvx-btn pvx-etable-submit', u.actions);
            u.submit.type = 'button';
            on(u.submit, 'click', function () { onSubmit(); });

            /* The confirmation replaces the submit button rather than sitting
             * beside it, so a second submit cannot be started while it is up. */
            u.confirm = el('div', 'pvx-etable-confirm', u.foot);
            u.confirmText = el('div', 'pvx-etable-confirm-text', u.confirm);
            u.confirmList = el('div', 'pvx-etable-confirm-list', u.confirm);
            u.confirmBtns = el('div', 'pvx-etable-confirm-btns', u.confirm);
            u.confirmYes = el('button', 'pvx-btn pvx-etable-yes', u.confirmBtns);
            u.confirmYes.type = 'button';
            setText(u.confirmYes, 'Confirm');
            on(u.confirmYes, 'click', function () { onConfirm(); });
            u.confirmNo = el('button', 'pvx-btn pvx-etable-no', u.confirmBtns);
            u.confirmNo.type = 'button';
            setText(u.confirmNo, 'Cancel');
            on(u.confirmNo, 'click', function () { onCancel(); });

            u.msg = el('div', 'pvx-etable-msg', u.foot);
            u.msgText = el('div', 'pvx-etable-msg-text', u.msg);
            u.msgDetail = el('div', 'pvx-etable-msg-detail', u.msg);

            return u;
        }

        /**
         * Build the row nodes.
         *
         * Only when the ROW SET changes. Rebuilding on every render would throw
         * away a half-filled rounds sheet and the operator's focus on every
         * refresh tick — the single worst thing this symbol could do.
         */
        function buildRows(cfg) {
            var sig = rowSignature(state.rows, cfg);
            if (rowSig === sig && ui.rowNodes.length === state.rows.length) { return; }
            rowSig = sig;

            ui.rows.innerHTML = '';
            ui.rowNodes = [];
            var perRow = trim(cfg.TimestampMode) === 'perRow';

            for (var i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                var node = el('div', 'pvx-etable-row', ui.rows);

                var label = el('label', 'pvx-etable-c-label', node);
                var current = el('span', 'pvx-etable-c-current pvx-num', node);
                var wrap = el('span', 'pvx-etable-c-input', node);
                var input = el('input', 'pvx-etable-input', wrap);
                input.type = 'number';
                // 'any', or a browser silently refuses decimals on the default
                // integer step, before validateAll() ever sees the text.
                input.setAttribute('step', 'any');
                input.id = PVX.util.uid('pvx-et-in');
                label.setAttribute('for', input.id);
                if (r.typed) { input.value = r.typed; }

                var stamp = null;
                if (perRow) {
                    stamp = el('input', 'pvx-etable-input pvx-etable-rowstamp', wrap);
                    stamp.type = 'text';
                    stamp.setAttribute('placeholder', 'time');
                    stamp.setAttribute('aria-label', r.label + ' timestamp');
                    if (r.typedStamp) { stamp.value = r.typedStamp; }
                }

                var status = el('span', 'pvx-etable-c-status', node);

                // Enter anywhere in the sheet submits — the operator's hands are
                // on the keyboard, not the mouse.
                on(input, 'keydown', onRowKey);
                on(input, 'input', onRowInput);

                ui.rowNodes.push({
                    node: node, label: label, current: current,
                    input: input, stamp: stamp, status: status
                });
            }
        }

        function onRowKey(ev) {
            if (ev.key === 'Enter' || ev.keyCode === 13) {
                ev.preventDefault();
                if (state.pending) { onConfirm(); } else { onSubmit(); }
            }
        }

        function onRowInput() {
            if (state.busy) { return; }
            // The typed values are part of the model, not just of the DOM: the
            // submit button's label carries the count and its enabled state
            // depends on how many rows are filled, so both have to move as the
            // operator types rather than only when they press the button.
            captureTyped();
            // Typing after a rejection clears the rejection: the message
            // referred to the previous contents and is now just noise.
            if (state.message && (state.message.tone === 'error' || state.message.tone === 'warn')) {
                state.message = null;
                for (var i = 0; i < state.rows.length; i++) {
                    if (state.rows[i].status === 'invalid') { state.rows[i].status = ''; state.rows[i].note = ''; }
                }
            }
            ctx.render();
        }

        /* ================================================================ *
         * render
         * ================================================================ */

        function render(c) {
            var cfg = liveCfg = c.config || liveCfg;
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            applyThemeVars(c, t, cfg);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            if (!ui || ui.form.parentNode !== host) { ui = buildDom(host); rowSig = ''; }

            /* Measured against the SYMBOL, not the drawing host: the host is
             * what is left after the header, so measuring it would make the
             * decision depend on the chrome the decision itself removes. */
            var rootW = Math.max(40, (c.node && c.node.clientWidth) || c.width || 40);
            var rootH = Math.max(24, (c.node && c.node.clientHeight) || c.height || 24);

            scope.pvx.title = '';
            scope.pvx.subtitle = '';

            if (rootW < MIN_W || rootH < MIN_H) {
                showState('PVX Shift Log',
                    'Too small for a data-entry form. Make this symbol at least ' +
                    MIN_W + ' \u00d7 ' + MIN_H + ' pixels.', 'warn');
                digest();
                return;
            }

            scope.pvx.title = trim(cfg.Title) || 'Shift log';

            if (state.phase === 'unconfigured') {
                showState('PI Web API is not configured',
                    'This symbol writes through PI Web API. ' + PVX.api.unsetHint() +
                    ', then confirm it with ext/piwebapi-check.html.', 'warn');
                digest();
                return;
            }
            if (state.phase === 'norows') {
                showState('No rows configured',
                    'Add one row per line in the format pane: an AF attribute path, then optionally ' +
                    'a label, units and a min:max range, separated by " | ".', 'warn');
                digest();
                return;
            }
            if (state.phase === 'idle') {
                showState('Resolving\u2026', '', 'muted');
                digest();
                return;
            }

            renderForm(cfg, t, rootW, rootH);
            digest();
        }

        function showState(head, body, tone) {
            show(ui.state, true);
            show(ui.form, false);
            ui.state.setAttribute('data-tone', tone);
            setText(ui.stateHead, head);
            setText(ui.stateBody, body);
            show(ui.stateBody, !!body);
        }

        function renderForm(cfg, t, rootW, rootH) {
            show(ui.state, false);
            show(ui.form, true);
            buildRows(cfg);

            var preview = isPreview(cfg);
            var compact = cfg.CompactRows === true;
            var wantCurrent = cfg.ShowCurrentValues !== false && rootW >= CURRENT_W;
            var wantStatus = cfg.ShowRowStatus !== false && rootW >= STATUS_W;

            ui.form.setAttribute('data-compact', compact ? 'yes' : 'no');
            ui.form.setAttribute('data-current', wantCurrent ? 'yes' : 'no');
            ui.form.setAttribute('data-status', wantStatus ? 'yes' : 'no');

            // The column header earns its line only when there is height for it.
            show(ui.head, !compact && rootH >= 200);

            var resolving = state.phase === 'resolving';
            var i;
            for (i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                var n = ui.rowNodes[i];
                if (!n) { continue; }

                setText(n.label, r.label + (r.units ? ' (' + r.units + ')' : ''));
                n.label.setAttribute('title', r.path || r.label);

                if (r.error) {
                    // A bad row says so in its own status cell and is left
                    // un-writable; the other rows carry on working.
                    setText(n.current, '');
                    setText(n.status, 'no path');
                    n.node.setAttribute('data-status', 'error');
                    n.input.disabled = true;
                    n.input.setAttribute('title', r.error.message + '  Check: ' + r.error.check);
                } else {
                    setText(n.current, r.current ? r.current.display : (resolving ? '\u2026' : '--'));
                    setText(n.status, r.note || '');
                    n.node.setAttribute('data-status', r.status || '');
                    n.input.disabled = state.busy || preview;
                    n.input.setAttribute('title',
                        r.min !== null || r.max !== null
                            ? rangeText(r) : (r.path || ''));
                    n.input.setAttribute('placeholder', rangeText(r) || '');
                    if (r.min !== null) { n.input.setAttribute('min', r.min); } else { n.input.removeAttribute('min'); }
                    if (r.max !== null) { n.input.setAttribute('max', r.max); } else { n.input.removeAttribute('max'); }
                }
                if (n.stamp) { n.stamp.disabled = state.busy || preview; }
                if (r.failDetail && r.status === 'failed') {
                    n.status.setAttribute('title', r.failDetail);
                } else {
                    n.status.removeAttribute('title');
                }
            }

            /* ---- one timestamp for the set --------------------------------- */
            var custom = trim(cfg.TimestampMode) === 'custom';
            show(ui.stampRow, custom);
            ui.stampInput.disabled = state.busy || preview;

            /* ---- actions ---------------------------------------------------- */
            var confirming = !!state.pending;
            show(ui.actions, !confirming);
            show(ui.confirm, confirming);

            if (confirming) {
                renderConfirm(cfg);
                ui.confirmYes.disabled = state.busy;
                ui.confirmNo.disabled = state.busy;
                ui.confirmYes.style.background = cfg.AccentColor || '#3b82c4';
                ui.confirmYes.style.color = PVX.color.readable(cfg.AccentColor || '#3b82c4');
            } else {
                var filled = filledCount();
                var allOrNothing = cfg.AllowPartial === false;
                var short = allOrNothing ? Math.max(0, writableCount() - filled) : 0;

                setText(ui.submit, state.busy
                    ? 'Writing\u2026'
                    : (preview ? 'Preview only'
                        : (trim(cfg.SubmitLabel) || 'Submit readings') +
                          (filled ? '  (' + filled + ')' : '')));

                // Disabled for the whole flight, and re-enabled on both paths.
                // Also disabled when all-or-nothing is on and rows are missing —
                // with the reason said out loud below, because a dead button
                // with no explanation is its own kind of failure.
                ui.submit.disabled = state.busy || preview || !filled || short > 0;
                var bg = (preview || ui.submit.disabled) ? t.textMuted : (cfg.AccentColor || '#3b82c4');
                ui.submit.style.background = bg;
                ui.submit.style.color = PVX.color.readable(bg);

                if (!state.message && short > 0) {
                    setText(ui.msgText, short + (short === 1 ? ' row still needs' : ' rows still need') + ' a value');
                    setText(ui.msgDetail, 'This sheet is set to all-or-nothing.');
                    ui.msg.setAttribute('data-tone', 'warn');
                    show(ui.msg, true);
                    show(ui.msgDetail, true);
                    return;
                }
            }

            /* ---- message ------------------------------------------------------ */
            var msg = state.message;
            if (!msg && preview) {
                msg = { tone: 'warn', text: 'Read-only preview', detail: 'The form is live but writes are disabled.' };
            }
            show(ui.msg, !!msg);
            if (msg) {
                ui.msg.setAttribute('data-tone', msg.tone);
                setText(ui.msgText, msg.text);
                setText(ui.msgDetail, msg.detail || '');
                show(ui.msgDetail, !!msg.detail);
            }
        }

        function rangeText(r) {
            if (r.min !== null && r.max !== null) { return r.min + ' to ' + r.max; }
            if (r.min !== null) { return 'min ' + r.min; }
            if (r.max !== null) { return 'max ' + r.max; }
            return '';
        }

        /**
         * The confirmation names every value AND every target. A summary that
         * said only "write 4 values?" would be a button people learn to click
         * without reading, and there is no undo behind it.
         */
        function renderConfirm(cfg) {
            var writes = state.pending;
            setText(ui.confirmText,
                'Write ' + writes.length + (writes.length === 1 ? ' value' : ' values') + '?');

            if (ui.confirmList.childNodes.length !== writes.length) {
                ui.confirmList.innerHTML = '';
                ui.confirmItems = [];
                for (var i = 0; i < writes.length; i++) {
                    var line = el('div', 'pvx-etable-confirm-item', ui.confirmList);
                    ui.confirmItems.push({
                        name: el('span', 'pvx-etable-confirm-name', line),
                        value: el('span', 'pvx-etable-confirm-value pvx-num', line)
                    });
                }
            }
            for (var j = 0; j < writes.length; j++) {
                setText(ui.confirmItems[j].name, writes[j].label);
                setText(ui.confirmItems[j].value,
                    writes[j].display + (writes[j].units ? ' ' + writes[j].units : ''));
            }
        }

        /* ================================================================ *
         * plumbing
         * ================================================================ */

        function applyThemeVars(c, t, cfg) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', cfg.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-surface-alt', t.surfaceAlt);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-ok', PVX.color.status.normal);
            n.style.setProperty('--pvx-warn', PVX.color.status.warning);
            n.style.setProperty('--pvx-alarm', PVX.color.status.alarm);
        }

        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        /* ---- go ------------------------------------------------------------ */
        ensureTimer(liveCfg);
        refresh();

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
