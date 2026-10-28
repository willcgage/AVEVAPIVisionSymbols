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
                 * One row per line:
                 *   <path> | <label> | <units> | <min>:<max> | <control>
                 * Only the path is required. See parseRows() for why the field
                 * separator is a pipe with a SPACE beside it. A line [Name]
                 * starts a section. */
                Rows: '',

                /* -- layout ---------------------------------------------------- *
                 * 'list' is the sheet this symbol always drew, a row per
                 * reading. 'form' puts each reading in a cell of a grid of
                 * FormColumns, section by section. */
                Layout: 'list',           // list | form | slots
                FormColumns: 2,

                /* -- the time-slot grid (Layout 'slots') ----------------------- *
                 * One column per slot, from SlotStart (a PI time, snapped to
                 * the interval) every SlotInterval, SlotCount of them. Each
                 * cell shows what PI holds in its slot and writes at the
                 * slot's time. */
                SlotStart: '*-7h',
                SlotInterval: '1h',
                SlotCount: 8,

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

                /* -- checks and what is written ---------------------------------- *
                 * 'hard' refuses a value outside a row's min:max, as this
                 * symbol always did; 'soft' lets it through after the
                 * confirmation says so. A row's own "warn lo:hi" is always soft. */
                LimitMode: 'hard',         // hard | soft
                // A value already at that time: replaced (PI Web API's own
                // default, and what was always written), kept beside the new
                // one, or kept instead of it.
                ExistingValues: 'replace', // replace | insert | protect
                AllowQuestionable: false,
                // A column pasted from a spreadsheet fills the rows down; a
                // CSV file of name,value[,time] lines fills them by name.
                PasteRows: false,
                ShowImport: false,

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
            lastSubmit: null,     // {ok, failed} counts from the last submit
            slots: { times: [], step: 0, error: '', key: '' },
            user: ''              // PI Web API's name for the viewer, for "prefill user"
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

        function isForm(cfg) { return trim(cfg.Layout).toLowerCase() === 'form'; }

        function isSlots(cfg) { return trim(cfg.Layout).toLowerCase() === 'slots'; }

        /* "30m", "1h", "8h", "1d" -> ms, or null. */
        function intervalMs(text) {
            var m = /^(\d+(?:\.\d+)?)\s*(s|m|min|h|d|w)$/i.exec(trim(text));
            if (!m) { return null; }
            var u = m[2].toLowerCase() === 'min' ? 'm' : m[2].toLowerCase();
            var ms = parseFloat(m[1]) * UNIT_MS[u];
            return ms >= 60000 ? ms : null;
        }

        /**
         * The slot times: SlotStart resolved, snapped down to the interval in
         * local time (so hourly slots sit on the hour and 8h slots on 06:00,
         * 14:00 and 22:00 only when the interval divides the day from local
         * midnight), then SlotCount of them.
         * @returns {Object} {times:[ms], step, error}
         */
        function slotTimes(cfg, now) {
            var step = intervalMs(cfg.SlotInterval);
            if (step === null) { return { times: [], step: 0, error: 'Slot interval "' + trim(cfg.SlotInterval) + '" is not a duration such as 30m, 1h or 8h.' }; }
            var start = PVX.nav.parseTime(trim(cfg.SlotStart) || '*-7h', now);
            if (start === null) { return { times: [], step: step, error: 'Slot start "' + trim(cfg.SlotStart) + '" is not a PI time such as *-8h or t+6h.' }; }
            var off = new Date(start).getTimezoneOffset() * 60000;
            if (step <= 86400000) { start = Math.floor((start - off) / step) * step + off; }
            var n = intIn(cfg.SlotCount, 1, 48, 8);
            var out = [];
            for (var k = 0; k < n; k++) { out.push(start + k * step); }
            return { times: out, step: step, error: '' };
        }

        function slotLabel(ms, step) {
            var d = new Date(ms);
            var pad = function (x) { return (x < 10 ? '0' : '') + x; };
            var hm = pad(d.getHours()) + ':' + pad(d.getMinutes());
            if (step >= 86400000) { return pad(d.getDate()) + '/' + pad(d.getMonth() + 1); }
            return hm;
        }

        /**
         * The sixth field of a row: required, warn lo:hi, prefill last|user|text,
         * comma separated. @returns {Object} {required, warn, prefill, error}
         */
        function parseOptions(text) {
            var out = { required: false, warnMin: null, warnMax: null, prefill: '', error: '' };
            var parts = trim(text) ? String(text).split(',') : [];
            for (var i = 0; i < parts.length; i++) {
                var tok = trim(parts[i]);
                if (!tok) { continue; }
                var low = tok.toLowerCase();
                var m;
                if (low === 'required') { out.required = true; continue; }
                if ((m = /^warn\s+(.+)$/i.exec(tok))) {
                    var r = parseRange(m[1]);
                    if (r.min === null && r.max === null) { out.error = 'warn needs a lo:hi range, such as warn 10:90'; continue; }
                    out.warnMin = r.min; out.warnMax = r.max;
                    continue;
                }
                if ((m = /^prefill\s+(.+)$/i.exec(tok))) { out.prefill = trim(m[1]); continue; }
                out.error = 'option "' + tok + '" is not one of required, warn lo:hi, prefill last, prefill user or prefill <text>';
            }
            return out;
        }

        /* Kinds that are picked rather than typed. After a write they go
         * back to showing what PI holds, as in Manual Entry. */
        var PICKED = { slider: 1, 'switch': 1, buttons: 1 };

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
            var section = '', sectionOpen = false;
            String(cfg.Rows || '').split(/\r?\n/).forEach(function (line) {
                var raw = trim(line);
                // '#' comments so a site can leave a note in a rounds sheet.
                if (!raw || raw.charAt(0) === '#') { return; }
                // [Pump house] starts a section. No AF path starts with '[',
                // so a sheet saved before sections existed reads the same.
                var sec = /^\[(.*)\]$/.exec(raw);
                if (sec) { section = trim(sec[1]); sectionOpen = true; return; }

                var f = splitFields(raw);
                var pathText = trim(f[0]);
                if (!pathText) { return; }

                var absolute = pathText.indexOf('\\\\') === 0;
                var full = absolute ? pathText : (base ? base + '|' + pathText : '');
                var range = parseRange(f[3]);
                var control = PVX.entry.parse(f[4]);
                var ctlError = control.error;
                if (!ctlError && control.kind === 'slider' && (range.min === null || range.max === null)) {
                    ctlError = 'a slider needs a min:max range in the fourth field';
                }
                var opts = parseOptions(f[5]);

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
                    // Kept apart from error, which the path lookup clears:
                    // a row whose path resolves but whose control cannot be
                    // read must still not be written.
                    ctlError: ctlError ? {
                        message: 'Control: ' + ctlError + '.',
                        check: 'the fifth field of this row',
                        short: 'bad control'
                    } : (opts.error ? {
                        message: 'Options: ' + opts.error + '.',
                        check: 'the sixth field of this row',
                        short: 'bad option'
                    } : null),
                    required: opts.required,
                    warnMin: opts.warnMin,
                    warnMax: opts.warnMax,
                    prefill: opts.prefill,
                    control: control,
                    section: section,
                    sectionStart: sectionOpen,
                    current: null,
                    status: '',
                    note: ''
                });
                sectionOpen = false;
            });
            return out;
        }

        /** Changes exactly when the ROW SET changes — not when a value does. */
        function rowSignature(rows, cfg) {
            var parts = [];
            for (var i = 0; i < rows.length; i++) {
                var c = rows[i].control;
                parts.push(rows[i].path + '\u0002' + rows[i].label + '\u0002' + rows[i].units + '\u0002' +
                    c.kind + ':' + c.step + ':' + c.wide + ':' + c.choices.map(function (x) { return x.value + '=' + x.label; }).join('/') +
                    '\u0002' + rows[i].min + ':' + rows[i].max + '\u0002' + (rows[i].sectionStart ? rows[i].section : ''));
            }
            return parts.join('\u0003') + '||' + (cfg.TimestampMode === 'perRow' ? 'per' : 'one') +
                '||' + (isSlots(cfg) ? 'slots:' + state.slots.times.join(',') : (isForm(cfg) ? 'form' : 'list')) +
                '||' + (cfg.AllowQuestionable === true ? 'q' : '');
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
                        raw: raw,
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
            updateSlots(cfg);
            if (!state.user && needsUser(parsed)) {
                PVX.api.userName().then(function (n) { if (n && !ctx.destroyed) { state.user = n; ctx.render(); } });
            }

            var gen = ++generation;
            if (state.phase !== 'ready') { state.phase = 'resolving'; }
            ctx.render();

            resolveRows(parsed)
                .then(function () {
                    if (stale(gen)) { return null; }
                    state.phase = 'ready';
                    ctx.render();
                    return isSlots(cfg) ? readSlots(parsed, cfg, gen) : readCurrent(parsed, cfg, gen);
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

        function needsUser(rows) {
            for (var i = 0; i < rows.length; i++) { if (rows[i].prefill.toLowerCase() === 'user') { return true; } }
            return false;
        }

        /**
         * The slot times, kept while anything is typed in the grid: an hour
         * rolling over must not move a reading typed for 06:00 into 07:00.
         */
        function updateSlots(cfg) {
            if (!isSlots(cfg)) { return; }
            var key = trim(cfg.SlotStart) + '|' + trim(cfg.SlotInterval) + '|' + cfg.SlotCount;
            if (key === state.slots.key && slotsTyped()) { return; }
            var st = slotTimes(cfg, Date.now());
            st.key = key;
            if (st.times.join() !== state.slots.times.join()) {
                for (var i = 0; i < state.rows.length; i++) { state.rows[i].slotTyped = null; state.rows[i].slotStatus = null; state.rows[i].archived = null; }
            }
            state.slots = st;
        }

        function slotsTyped() {
            for (var i = 0; i < state.rows.length; i++) {
                var t = state.rows[i].slotTyped || [];
                for (var k = 0; k < t.length; k++) { if (trim(t[k])) { return true; } }
            }
            return false;
        }

        /**
         * What PI holds in each slot: one recorded-values read per row over
         * the whole grid, in one batch. The newest value inside a slot is
         * its value; a slot with none is blank.
         */
        function readSlots(rows, cfg, gen) {
            var times = state.slots.times, step = state.slots.step;
            if (!times.length) { return Promise.resolve(); }
            var from = new Date(times[0]).toISOString();
            var to = new Date(times[times.length - 1] + step - 1).toISOString();
            var reqs = {}, idx = [];
            for (var i = 0; i < rows.length; i++) {
                if (!rows[i].webId) { continue; }
                reqs['h' + idx.length] = { Method: 'GET', Resource: apiUrl('streams/' + encodeURIComponent(rows[i].webId) +
                    '/recorded?startTime=' + encodeURIComponent(from) + '&endTime=' + encodeURIComponent(to) +
                    '&maxCount=1000&selectedFields=Items.Timestamp;Items.Value;Items.Good') };
                idx.push(i);
            }
            if (!idx.length) { return Promise.resolve(); }
            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                if (stale(gen)) { return; }
                var split = PVX.api.batchResults(res);
                for (var j = 0; j < idx.length; j++) {
                    var r = rows[idx[j]];
                    var body = split.ok['h' + j];
                    r.archived = [];
                    for (var k = 0; k < times.length; k++) { r.archived.push(null); }
                    r.archiveFailed = body === undefined;
                    var items = (body && body.Items) || [];
                    for (var x = 0; x < items.length; x++) {
                        var d = PVX.fmt.toDate(items[x].Timestamp);
                        if (!d) { continue; }
                        var slot = Math.floor((d.getTime() - times[0]) / step);
                        if (slot < 0 || slot >= times.length) { continue; }
                        var raw = unwrap(items[x].Value);
                        r.archived[slot] = { raw: raw, display: displayValue(raw, cfg), good: items[x].Good !== false };
                    }
                }
            })['catch'](function () {
                for (var j = 0; j < idx.length; j++) { rows[idx[j]].archived = null; rows[idx[j]].archiveFailed = true; }
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
                next[j].questionable = old.questionable;
                next[j].prefilled = old.prefilled;
                next[j].slotTyped = old.slotTyped;
                next[j].slotStatus = old.slotStatus;
                next[j].archived = old.archived;
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
                if (n.cells) {
                    state.rows[i].slotTyped = n.cells.map(function (c) { return c.input.value; });
                    continue;
                }
                state.rows[i].typed = n.input ? n.input.value : '';
                state.rows[i].typedStamp = n.stamp ? n.stamp.value : '';
                state.rows[i].questionable = !!(n.q && n.q.checked);
            }
        }

        function filledCount() {
            var c = 0;
            for (var i = 0; i < state.rows.length; i++) {
                if (isSlots(liveCfg)) {
                    var t = state.rows[i].slotTyped || [];
                    for (var k = 0; k < t.length; k++) { if (trim(t[k])) { c += 1; } }
                } else if (trim(state.rows[i].typed)) { c += 1; }
            }
            return c;
        }

        function writableCount() {
            var c = 0;
            for (var i = 0; i < state.rows.length; i++) {
                if (state.rows[i].webId && !state.rows[i].ctlError) { c += 1; }
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
            var slots = isSlots(cfg);

            if (!slots && trim(cfg.TimestampMode) === 'custom') {
                setStamp = resolveStamp(ui && ui.stampInput ? ui.stampInput.value : '', false);
                if (!setStamp.ok) {
                    return { ok: false, writes: [], errors: [{ index: -1, text: 'The sheet ' + setStamp.error + '.' }] };
                }
            }

            for (var i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                if (slots) {
                    var typed = r.slotTyped || [];
                    for (var k = 0; k < typed.length; k++) {
                        var cell = trim(typed[k]);
                        if (!cell) { continue; }
                        var at = state.slots.times[k];
                        // A slot still to come is a reading nobody has taken.
                        if (at > Date.now() + 60000) {
                            errors.push({ index: i, slot: k, text: r.label + ' at ' + slotLabel(at, state.slots.step) + ': that time has not come yet.' });
                            continue;
                        }
                        var cw = checkValue(r, i, typed[k], cell, new Date(at).toISOString(), cfg, errors);
                        if (cw) {
                            cw.key = r.key + '@' + k;
                            cw.slot = k;
                            cw.label = r.label + ' · ' + slotLabel(at, state.slots.step);
                            writes.push(cw);
                        }
                    }
                    continue;
                }
                var text = trim(r.typed);
                if (!text) {
                    // A required row is the one blank that is not simply skipped.
                    if (r.required && !r.error && !r.ctlError) { errors.push({ index: i, text: r.label + ' is required.' }); }
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
                var w = checkValue(r, i, r.typed, text, stamp, cfg, errors);
                if (w) { writes.push(w); }
            }

            var warned = 0;
            for (var j = 0; j < writes.length; j++) { if (writes[j].warn) { warned += 1; } }
            return { ok: errors.length === 0 && writes.length > 0, writes: writes, errors: errors, warned: warned };
        }

        /**
         * One value, checked as the row says: a write, or null with the
         * reason pushed on errors. A value outside a soft limit is a write
         * carrying `warn`, which the confirmation has to show.
         */
        function checkValue(r, i, typed, text, stamp, cfg, errors) {
            if (r.ctlError) {
                errors.push({ index: i, text: r.label + ': ' + r.ctlError.message });
                return null;
            }
            if (!r.webId) {
                errors.push({ index: i, text: r.label + ': this row did not resolve, so it cannot be written.' });
                return null;
            }

            var kind = r.control.kind;
            if (kind === 'text') {
                return writeOf(r, i, typed, stamp, text);
            }
            if (r.control.choices.length) {
                // Picked from a list, but checked against it anyway: the
                // list can be edited while a choice is still in the row.
                // A typed or pasted caption counts as its choice.
                var found = null;
                for (var c = 0; c < r.control.choices.length; c++) {
                    if (PVX.entry.same(r.control.choices[c].value, text) || PVX.entry.same(r.control.choices[c].label, text)) {
                        found = r.control.choices[c];
                    }
                }
                if (!found) {
                    errors.push({ index: i, text: r.label + ': "' + text + '" is not one of its choices.' });
                    return null;
                }
                // A plain switch writes True/False; choices that are all
                // numbers write numbers; anything else is a state name.
                var wv = r.control.plain ? (found.value === 'True')
                    : (PVX.entry.numericChoices(r.control.choices) ? parseFloat(found.value) : found.value);
                return writeOf(r, i, wv, stamp, found.label);
            }

            // Not PVX.util.num: that strips non-numeric characters so charts
            // survive "12.3 kg". Here "12.3kg" is a typo the operator must
            // see, not a number to be guessed at.
            if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
                errors.push({ index: i, text: r.label + ': "' + text + '" is not a number.' });
                return null;
            }
            var value = parseFloat(text);
            if (!isFinite(value)) {
                errors.push({ index: i, text: r.label + ': "' + text + '" is not a number.' });
                return null;
            }
            var soft = trim(cfg.LimitMode).toLowerCase() === 'soft';
            var warn = '';
            if (r.min !== null && value < r.min) {
                if (!soft) { errors.push({ index: i, text: r.label + ': ' + value + ' is below ' + r.min + '.' }); return null; }
                warn = 'below the limit of ' + r.min;
            } else if (r.max !== null && value > r.max) {
                if (!soft) { errors.push({ index: i, text: r.label + ': ' + value + ' is above ' + r.max + '.' }); return null; }
                warn = 'above the limit of ' + r.max;
            } else if (r.warnMin !== null && value < r.warnMin) {
                warn = 'below the usual ' + r.warnMin;
            } else if (r.warnMax !== null && value > r.warnMax) {
                warn = 'above the usual ' + r.warnMax;
            }
            var w = writeOf(r, i, value, stamp, PVX.fmt.number(value, { decimals: cfg.Decimals }));
            w.warn = warn;
            return w;
        }

        function writeOf(r, i, value, stamp, display) {
            var ev = trim(liveCfg.ExistingValues).toLowerCase();
            return {
                key: r.key,
                index: i,
                webId: r.webId,
                value: value,
                timestamp: stamp,
                label: r.label,
                units: r.units,
                display: display,
                questionable: !isSlots(liveCfg) && !!r.questionable,
                // Replace is PI Web API's default, so nothing is added for it
                // and a sheet saved before this option writes exactly as it did.
                updateOption: ev === 'insert' ? 'Insert' : (ev === 'protect' ? 'NoReplace' : '')
            };
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

            if (!isSlots(cfg) && cfg.AllowPartial === false && filledCount() < writableCount()) {
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

            // A value outside its usual range is always confirmed, whatever
            // RequireConfirm says: letting it through unasked would make the
            // soft limit no limit at all.
            if (cfg.RequireConfirm !== false || v.warned) {
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
                    if (errors[j].slot !== undefined) { setSlotStatus(state.rows[idx], errors[j].slot, 'invalid'); continue; }
                    state.rows[idx].status = 'invalid';
                    state.rows[idx].note = 'check';
                }
            }
        }

        function setSlotStatus(r, k, st) {
            if (!r.slotStatus) { r.slotStatus = []; }
            r.slotStatus[k] = st;
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
        /**
         * Protect: a value already at a write's own time is kept, and that
         * write is not sent. Asked once, in one batch, for every write with a
         * time of its own ('*' is PI's clock, where nothing is yet). The
         * write itself also carries NoReplace, so if this check could not
         * be made PI still keeps the old value.
         * @returns {Promise} resolves {send:[writes], kept:[writes]}
         */
        function protectCheck(writes) {
            var reqs = {}, ask = [];
            for (var i = 0; i < writes.length; i++) {
                if (writes[i].updateOption !== 'NoReplace' || writes[i].timestamp === '*') { continue; }
                reqs['x' + ask.length] = { Method: 'GET', Resource: apiUrl('streams/' + encodeURIComponent(writes[i].webId) +
                    '/recordedattime?time=' + encodeURIComponent(writes[i].timestamp) + '&retrievalMode=Exact&selectedFields=Timestamp;Value;Good') };
                ask.push(i);
            }
            if (!ask.length) { return Promise.resolve({ send: writes, kept: [] }); }
            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                var split = PVX.api.batchResults(res);
                var keep = {};
                for (var j = 0; j < ask.length; j++) {
                    var b = split.ok['x' + j];
                    var v = b && b.Value;
                    // PI answers an exact time with no value as a system
                    // state ("No Data"), not as an error.
                    var none = !b || v === null || v === undefined ||
                        (typeof v === 'object' && v.IsSystem && /no data|no result|pt created/i.test(String(v.Name || '')));
                    if (!none) { keep[ask[j]] = true; }
                }
                var out = { send: [], kept: [] };
                for (var k = 0; k < writes.length; k++) { (keep[k] ? out.kept : out.send).push(writes[k]); }
                return out;
            }, function () { return { send: writes, kept: [] }; });
        }

        function sendWrites(writes) {
            var cfg = liveCfg;
            state.busy = true;
            state.pending = null;
            state.message = { tone: 'info', text: 'Checking for values already there…', detail: '' };
            ctx.render();
            protectCheck(writes).then(function (pc) {
                if (ctx.destroyed) { return; }
                for (var i = 0; i < pc.kept.length; i++) {
                    var kw = pc.kept[i], kr = state.rows[kw.index];
                    if (!kr) { continue; }
                    if (kw.slot !== undefined) { setSlotStatus(kr, kw.slot, 'kept'); }
                    else { kr.status = 'kept'; kr.note = 'kept'; kr.failDetail = 'PI already holds a value at that time, so it was kept and this one not written.'; }
                }
                if (!pc.send.length) {
                    state.busy = false;
                    state.message = { tone: 'warn', text: 'Nothing written', detail: keptText(pc.kept.length) };
                    ctx.render();
                    return;
                }
                doWrites(pc.send, pc.kept.length);
            });
        }

        function keptText(n) {
            return n ? n + (n === 1 ? ' value was' : ' values were') + ' kept: PI already holds a value at that time.' : '';
        }

        function doWrites(writes, keptN) {
            var cfg = liveCfg;
            state.busy = true;
            state.pending = null;
            state.message = { tone: 'info', text: 'Writing ' + writes.length + (writes.length === 1 ? ' value\u2026' : ' values\u2026'), detail: '' };

            var byIndex = {};
            var i;
            for (i = 0; i < writes.length; i++) {
                byIndex[writes[i].key] = writes[i];
                if (writes[i].slot !== undefined) { setSlotStatus(state.rows[writes[i].index], writes[i].slot, 'sending'); continue; }
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
                    if (w && w.slot !== undefined && state.rows[w.index]) {
                        // A saved cell is cleared, and the read-back below
                        // shows the value PI now holds in its place.
                        setSlotStatus(state.rows[w.index], w.slot, 'saved');
                        var cellN = ui && ui.rowNodes[w.index] && ui.rowNodes[w.index].cells && ui.rowNodes[w.index].cells[w.slot];
                        if (cellN) { cellN.input.value = ''; }
                        if (state.rows[w.index].slotTyped) { state.rows[w.index].slotTyped[w.slot] = ''; }
                        continue;
                    }
                    if (w && state.rows[w.index]) {
                        state.rows[w.index].status = 'saved';
                        state.rows[w.index].note = 'saved';
                        // Clear only the rows that ACTUALLY saved. Clearing a
                        // failed row would throw away a reading the operator
                        // still has to send, and they may no longer remember it.
                        var picked = PICKED[state.rows[w.index].control.kind];
                        if (cfg.ClearAfterSubmit !== false || picked) {
                            state.rows[w.index].typed = '';
                            state.rows[w.index].typedStamp = '';
                            state.rows[w.index].questionable = false;
                            // Prefilled again on the next render, for the next round.
                            state.rows[w.index].prefilled = false;
                            if (ui && ui.rowNodes[w.index] && ui.rowNodes[w.index].input) {
                                ui.rowNodes[w.index].input.value = '';
                                // The per-row timestamp goes with it. Leaving it
                                // behind means the NEXT reading typed into this
                                // row silently inherits the previous reading's
                                // time, which is a wrong timestamp nobody chose.
                                if (ui.rowNodes[w.index].stamp) { ui.rowNodes[w.index].stamp.value = ''; }
                                if (ui.rowNodes[w.index].q) { ui.rowNodes[w.index].q.checked = false; }
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
                    if (w2 && w2.slot !== undefined && state.rows[w2.index]) { setSlotStatus(state.rows[w2.index], w2.slot, 'failed'); continue; }
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
                if (keptN) { state.message.detail = (state.message.detail ? state.message.detail + ' ' : '') + keptText(keptN); if (state.message.tone === 'ok') { state.message.tone = 'warn'; } }

                // Read back, so the "now" column shows what PI holds rather
                // than what we believe we sent.
                if (!stale(gen)) {
                    (isSlots(cfg) ? readSlots(state.rows, cfg, gen) : readCurrent(state.rows, cfg, gen)).then(function () { ctx.render(); });
                }
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
            // A CSV of name,value[,time] lines, read in the browser: nothing
            // is sent until the operator submits what it filled in.
            u.importBtn = el('button', 'pvx-btn pvx-etable-import', u.actions);
            u.importBtn.type = 'button';
            setText(u.importBtn, 'Import CSV');
            u.importFile = el('input', 'pvx-etable-file', u.actions);
            u.importFile.type = 'file';
            u.importFile.setAttribute('accept', '.csv,text/csv,text/plain');
            u.importFile.style.display = 'none';
            on(u.importBtn, 'click', function () { if (!state.busy) { u.importFile.value = ''; u.importFile.click(); } });
            on(u.importFile, 'change', function () { onImportFile(u.importFile); });

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
            ui.grids = [];
            if (isSlots(cfg)) { buildSlots(cfg); return; }
            var perRow = trim(cfg.TimestampMode) === 'perRow';
            var form = isForm(cfg);
            var parent = ui.rows;

            for (var i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];

                // A section is a heading in the list, and a heading over its
                // own grid in the form, so a wide field never straddles two.
                if (r.sectionStart || (form && i === 0)) {
                    if (form) {
                        var sec = el('div', 'pvx-etable-sec', ui.rows);
                        if (r.section) { setText(el('div', 'pvx-etable-section', sec), r.section); }
                        parent = el('div', 'pvx-etable-grid', sec);
                        ui.grids.push(parent);
                    } else if (r.section) {
                        setText(el('div', 'pvx-etable-section', ui.rows), r.section);
                    }
                }

                var node = el('div', 'pvx-etable-row', parent);
                if (r.control.wide) { node.setAttribute('data-wide', 'yes'); }

                var label = el('label', 'pvx-etable-c-label', node);
                var current = el('span', 'pvx-etable-c-current pvx-num', node);
                var wrap = el('span', 'pvx-etable-c-input', node);
                var ctl = PVX.entry.build({
                    kind: r.control.kind,
                    parent: wrap,
                    inputClass: 'pvx-etable-input',
                    min: r.min,
                    max: r.max,
                    step: r.control.step,
                    choices: r.control.choices,
                    listen: on,
                    format: function (v) {
                        var n = PVX.util.num(v);
                        return n === null ? String(v) : PVX.fmt.number(n, { decimals: liveCfg.Decimals });
                    },
                    onPick: function () { onRowInput(); }
                });
                var input = ctl.input;
                if (ctl.focus) {
                    ctl.focus.id = PVX.util.uid('pvx-et-in');
                    label.setAttribute('for', ctl.focus.id);
                }
                if (r.typed) { input.value = r.typed; }

                // Questionable: kept with the value in PI, for whoever reads it.
                var q = null;
                if (cfg.AllowQuestionable === true) {
                    var ql = el('label', 'pvx-etable-q', wrap);
                    q = el('input', 'pvx-etable-q-box', ql);
                    q.type = 'checkbox';
                    if (r.questionable) { q.checked = true; }
                    setText(el('span', '', ql), '?');
                    ql.setAttribute('title', 'Mark this reading as questionable');
                    q.setAttribute('aria-label', r.label + ': questionable');
                    on(q, 'change', function () { onRowInput(); });
                }

                var stamp = null;
                if (perRow) {
                    stamp = el('input', 'pvx-etable-input pvx-etable-rowstamp', wrap);
                    stamp.type = 'text';
                    stamp.setAttribute('placeholder', 'time');
                    stamp.setAttribute('aria-label', r.label + ' timestamp');
                    if (r.typedStamp) { stamp.value = r.typedStamp; }
                }

                var status = el('span', 'pvx-etable-c-status', node);

                if (!PICKED[r.control.kind]) {
                    // Enter anywhere in the sheet submits — the operator's
                    // hands are on the keyboard, not the mouse.
                    on(input, 'keydown', onRowKey);
                    on(input, 'input', onRowInput);
                    on(input, 'paste', pasteHandler(i, -1));
                }

                ui.rowNodes.push({
                    node: node, label: label, current: current,
                    input: input, ctl: ctl, stamp: stamp, status: status, q: q
                });
            }
        }

        /**
         * The time-slot grid: a row per reading, a column per slot. Every
         * cell is a plain box (a choice is typed by its value or caption),
         * with what PI already holds in that slot shown faintly behind it.
         */
        function buildSlots(cfg) {
            var times = state.slots.times;
            var wrapT = el('div', 'pvx-etable-slotwrap', ui.rows);
            var table = el('table', 'pvx-etable-slots', wrapT);
            var head = el('tr', 'pvx-etable-slothead', el('thead', '', table));
            setText(el('th', 'pvx-etable-slot-name', head), 'Reading');
            for (var k = 0; k < times.length; k++) {
                var th = el('th', 'pvx-etable-slot-time', head);
                setText(th, slotLabel(times[k], state.slots.step));
                th.setAttribute('title', PVX.fmt.time(times[k], 'datetime'));
            }
            var body = el('tbody', '', table);
            for (var i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                var tr = el('tr', 'pvx-etable-slotrow', body);
                var label = el('th', 'pvx-etable-slot-label', tr);
                var cells = [];
                for (var c = 0; c < times.length; c++) {
                    var td = el('td', 'pvx-etable-slot', tr);
                    var input = el('input', 'pvx-etable-input pvx-etable-slot-input pvx-num', td);
                    input.type = 'text';
                    input.setAttribute('aria-label', r.label + ' at ' + slotLabel(times[c], state.slots.step));
                    if (r.slotTyped && r.slotTyped[c]) { input.value = r.slotTyped[c]; }
                    on(input, 'keydown', onRowKey);
                    on(input, 'input', onRowInput);
                    on(input, 'paste', pasteHandler(i, c));
                    cells.push({ td: td, input: input });
                }
                ui.rowNodes.push({ node: tr, label: label, cells: cells });
            }
        }

        function pasteHandler(row, slot) {
            return function (ev) {
                if (liveCfg.PasteRows !== true || state.busy) { return; }
                var text = '';
                try { text = (ev.clipboardData || window.clipboardData).getData('text'); } catch (e) { return; }
                // One value is an ordinary paste into the box.
                if (!/[\r\n\t]/.test(String(text).replace(/[\r\n]+$/, ''))) { return; }
                if (ev.preventDefault) { ev.preventDefault(); }
                pasteGrid(String(text), row, slot);
            };
        }

        /** Set a row's box (or a slot's) to a value, as if it were typed. */
        function setTyped(i, slot, value) {
            var n = ui && ui.rowNodes[i];
            var r = state.rows[i];
            if (!n || !r || r.error || r.ctlError) { return false; }
            if (slot >= 0) {
                if (!n.cells || !n.cells[slot]) { return false; }
                n.cells[slot].input.value = value;
                return true;
            }
            // A switch, buttons or a slider are picked, not typed: a pasted
            // value is not guessed onto them.
            if (PICKED[r.control.kind] || !n.input) { return false; }
            if (n.input.tagName === 'SELECT') {
                var ok = false;
                for (var o = 0; o < r.control.choices.length; o++) {
                    var ch = r.control.choices[o];
                    if (PVX.entry.same(ch.value, value) || PVX.entry.same(ch.label, value)) { n.input.value = ch.value; ok = true; }
                }
                return ok;
            }
            n.input.value = value;
            return true;
        }

        /** The row a pasted or imported name means: its label, attribute or path. */
        function rowByName(name) {
            var want = trim(name).toLowerCase();
            if (!want) { return -1; }
            for (var i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                if (r.label.toLowerCase() === want || r.path.toLowerCase() === want || leafOf(r.path).toLowerCase() === want) { return i; }
            }
            return -1;
        }

        /**
         * A block from a spreadsheet. A first cell that names a row puts the
         * rest of its line on that row; otherwise the lines go down the rows
         * from the box it was pasted into, and in the grid the cells across
         * the slots as well.
         */
        function pasteGrid(text, row, slot) {
            var lines = text.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n');
            var set = 0, skipped = 0;
            for (var l = 0; l < lines.length; l++) {
                var cells = lines[l].split('\t');
                var named = cells.length > 1 ? rowByName(cells[0]) : -1;
                var ri = named >= 0 ? named : row + l;
                var vals = named >= 0 ? cells.slice(1) : cells;
                if (ri >= state.rows.length) { skipped += vals.length; continue; }
                var start = named >= 0 ? (slot >= 0 ? 0 : -1) : slot;
                if (start < 0) {
                    if (setTyped(ri, -1, trim(vals[0]))) { set += 1; } else { skipped += 1; }
                    continue;
                }
                for (var c = 0; c < vals.length; c++) {
                    if (!trim(vals[c])) { continue; }
                    if (setTyped(ri, start + c, trim(vals[c]))) { set += 1; } else { skipped += 1; }
                }
            }
            captureTyped();
            state.message = { tone: skipped ? 'warn' : 'info', text: 'Pasted ' + set + (set === 1 ? ' value' : ' values'),
                detail: skipped ? skipped + ' not placed: past the last row or slot, or on a row that is picked, not typed.' : 'Nothing is written until you submit.' };
            ctx.render();
        }

        function onImportFile(input) {
            var f = input.files && input.files[0];
            if (!f || typeof FileReader === 'undefined') { return; }
            var rd = new FileReader();
            rd.onload = function () { if (!ctx.destroyed) { importCsv(String(rd.result || ''), f.name); } };
            rd.onerror = function () {
                state.message = { tone: 'error', text: 'Could not read ' + f.name, detail: 'The browser refused to read the file.' };
                ctx.render();
            };
            rd.readAsText(f);
        }

        /** One CSV line into fields, with "quoted, fields" and "" inside them. */
        function csvFields(line) {
            var out = [], cur = '', q = false;
            for (var i = 0; i < line.length; i++) {
                var ch = line.charAt(i);
                if (q) {
                    if (ch === '"' && line.charAt(i + 1) === '"') { cur += '"'; i += 1; }
                    else if (ch === '"') { q = false; }
                    else { cur += ch; }
                } else if (ch === '"') { q = true; }
                else if (ch === ',') { out.push(cur); cur = ''; }
                else { cur += ch; }
            }
            out.push(cur);
            return out;
        }

        /**
         * name,value[,time] per line, by the row's label, attribute name or
         * path. The time goes in the row's own time box when the sheet has
         * one; in the grid it chooses the slot. Nothing is written until the
         * operator submits; what could not be placed is said.
         */
        function importCsv(text, fileName) {
            var lines = text.replace(/\r\n?/g, '\n').split('\n');
            var slots = isSlots(liveCfg);
            var perRow = trim(liveCfg.TimestampMode) === 'perRow';
            var set = 0, unmatched = [], noSlot = 0, skipped = 0;
            for (var l = 0; l < lines.length; l++) {
                if (!trim(lines[l])) { continue; }
                var f = csvFields(lines[l]);
                var ri = rowByName(f[0]);
                if (ri < 0) {
                    // A header line is not a reading.
                    if (l === 0 && /value/i.test(f[1] || '')) { continue; }
                    unmatched.push(trim(f[0]));
                    continue;
                }
                var val = trim(f[1]);
                if (!val) { continue; }
                if (slots) {
                    var at = parseTimestamp(f[2], Date.now());
                    var k = at === null ? -1 : state.slots.times.indexOf(at);
                    if (k < 0) { noSlot += 1; continue; }
                    if (setTyped(ri, k, val)) { set += 1; } else { skipped += 1; }
                    continue;
                }
                if (!setTyped(ri, -1, val)) { skipped += 1; continue; }
                set += 1;
                if (perRow && trim(f[2]) && ui.rowNodes[ri] && ui.rowNodes[ri].stamp) { ui.rowNodes[ri].stamp.value = trim(f[2]); }
            }
            captureTyped();
            var bits = [];
            if (unmatched.length) { bits.push(unmatched.length + ' not a row here: ' + unmatched.slice(0, 5).join(', ') + (unmatched.length > 5 ? '\u2026' : '')); }
            if (noSlot) { bits.push(noSlot + ' with no slot at that time'); }
            if (skipped) { bits.push(skipped + ' on a row that is picked, not typed'); }
            state.message = { tone: bits.length ? 'warn' : 'info',
                text: 'Imported ' + set + (set === 1 ? ' value' : ' values') + ' from ' + fileName,
                detail: bits.length ? bits.join('; ') + '.' : 'Nothing is written until you submit.' };
            ctx.render();
        }

        /**
         * "prefill last|user|text": put a starting value in an empty box,
         * once, until it is sent or cleared. Only boxes that are typed in or
         * chosen from a list; a picked control shows what PI holds already.
         */
        function applyPrefill() {
            for (var i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                var n = ui.rowNodes[i];
                if (!r.prefill || r.prefilled || !n || !n.input || trim(r.typed) || r.error || r.ctlError || PICKED[r.control.kind]) { continue; }
                var how = r.prefill.toLowerCase();
                var v = null;
                if (how === 'last') { v = r.current && r.current.raw !== null && r.current.raw !== undefined && r.current.raw !== '' ? String(r.current.raw) : null; }
                else if (how === 'user') { v = state.user || null; }
                else { v = r.prefill; }
                if (v === null || trim(n.input.value)) { continue; }
                if (setTyped(i, -1, v)) {
                    r.prefilled = true;
                    r.typed = n.input.value;
                }
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

            var form = isForm(cfg);
            var slots = isSlots(cfg);
            ui.form.setAttribute('data-layout', slots ? 'slots' : (form ? 'form' : 'list'));
            if (slots) { renderSlots(cfg, preview); }
            else { applyPrefill(); }
            if (form) {
                // Fewer columns than asked for when the symbol is too narrow
                // for them: a cell under about 170px cannot hold a label and
                // a control side by side with the reading under them.
                var cols = Math.max(1, Math.min(intIn(cfg.FormColumns, 1, 6, 2), Math.floor((rootW - 16) / 170)));
                for (var g = 0; g < ui.grids.length; g++) {
                    ui.grids[g].style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
                }
            }
            ui.form.setAttribute('data-compact', compact ? 'yes' : 'no');
            ui.form.setAttribute('data-current', wantCurrent ? 'yes' : 'no');
            ui.form.setAttribute('data-status', wantStatus ? 'yes' : 'no');

            // The column header earns its line only when there is height for it.
            show(ui.head, !form && !slots && !compact && rootH >= 200);

            var resolving = state.phase === 'resolving';
            var i;
            for (i = 0; i < state.rows.length && !slots; i++) {
                var r = state.rows[i];
                var n = ui.rowNodes[i];
                if (!n) { continue; }

                setText(n.label, r.label + (r.units ? ' (' + r.units + ')' : '') + (r.required ? ' *' : ''));
                if (n.input) { n.input.classList.toggle('pvx-etable-prefilled', !!r.prefilled && n.input.value === r.typed); }
                if (n.q) { n.q.disabled = state.busy || preview; }
                n.label.setAttribute('title', r.path || r.label);

                var bad = r.error || r.ctlError;
                if (bad) {
                    // A bad row says so in its own status cell and is left
                    // un-writable; the other rows carry on working.
                    setText(n.current, '');
                    setText(n.status, bad.short || 'no path');
                    n.node.setAttribute('data-status', 'error');
                    n.ctl.sync({ current: null, disabled: true });
                    n.input.setAttribute('title', bad.message + '  Check: ' + bad.check);
                    n.node.setAttribute('title', bad.message + '  Check: ' + bad.check);
                } else {
                    n.node.removeAttribute('title');
                    setText(n.current, r.current ? captionOf(r, r.current) : (resolving ? '\u2026' : '--'));
                    setText(n.status, r.note || '');
                    n.node.setAttribute('data-status', r.status || '');
                    n.ctl.sync({ current: r.current ? r.current.raw : null, disabled: state.busy || preview });
                    n.input.setAttribute('title',
                        r.min !== null || r.max !== null
                            ? rangeText(r) : (r.path || ''));
                    var k = r.control.kind;
                    if (k === 'number' || k === 'stepper') {
                        n.input.setAttribute('placeholder', rangeText(r) || '');
                        if (r.min !== null) { n.input.setAttribute('min', r.min); } else { n.input.removeAttribute('min'); }
                        if (r.max !== null) { n.input.setAttribute('max', r.max); } else { n.input.removeAttribute('max'); }
                    }
                }
                if (n.stamp) { n.stamp.disabled = state.busy || preview; }
                if (r.failDetail && r.status === 'failed') {
                    n.status.setAttribute('title', r.failDetail);
                } else {
                    n.status.removeAttribute('title');
                }
            }

            /* ---- one timestamp for the set --------------------------------- */
            var custom = !slots && trim(cfg.TimestampMode) === 'custom';
            show(ui.stampRow, custom);
            show(ui.importBtn, cfg.ShowImport === true);
            ui.importBtn.disabled = state.busy || preview;
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
                var allOrNothing = cfg.AllowPartial === false && !slots;
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

        function renderSlots(cfg, preview) {
            var times = state.slots.times;
            for (var i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                var n = ui.rowNodes[i];
                if (!n || !n.cells) { continue; }
                setText(n.label, r.label + (r.units ? ' (' + r.units + ')' : ''));
                var bad = r.error || r.ctlError;
                n.label.setAttribute('title', bad ? bad.message + '  Check: ' + bad.check : (r.path || r.label) + (rangeText(r) ? '\n' + rangeText(r) : ''));
                n.node.setAttribute('data-status', bad ? 'error' : '');
                for (var k = 0; k < n.cells.length; k++) {
                    var cell = n.cells[k];
                    var a = r.archived && r.archived[k];
                    var future = times[k] > Date.now() + 60000;
                    cell.input.disabled = !!bad || state.busy || preview || future;
                    cell.input.setAttribute('placeholder', a ? captionOf(r, a) : '');
                    cell.input.setAttribute('title', (a ? 'PI holds ' + captionOf(r, a) + ' in this slot. A value typed here is written at ' : 'Written at ') +
                        PVX.fmt.time(times[k], 'datetime') + (future ? ' (not yet)' : '') + '.');
                    cell.td.setAttribute('data-archived', a ? 'yes' : 'no');
                    cell.td.setAttribute('data-status', (r.slotStatus && r.slotStatus[k]) || '');
                }
            }
            if (state.slots.error && !state.message) {
                state.message = { tone: 'error', text: 'The slots cannot be laid out', detail: state.slots.error };
            }
        }

        /** The value now, by its caption when the row lists one for it. */
        function captionOf(r, cur) {
            var list = r.control.choices;
            for (var i = 0; i < list.length; i++) {
                if (PVX.entry.same(list[i].value, cur.raw)) { return list[i].label; }
            }
            return cur.display;
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
            var warned = 0;
            for (var w = 0; w < writes.length; w++) { if (writes[w].warn) { warned += 1; } }
            setText(ui.confirmText,
                'Write ' + writes.length + (writes.length === 1 ? ' value' : ' values') + '?' +
                (warned ? ' ' + warned + (warned === 1 ? ' is' : ' are') + ' outside the usual range.' : ''));

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
                    writes[j].display + (writes[j].units ? ' ' + writes[j].units : '') +
                    (writes[j].questionable ? ' (questionable)' : '') +
                    (writes[j].warn ? ' \u26a0 ' + writes[j].warn : ''));
                ui.confirmItems[j].value.parentNode.setAttribute('data-warn', writes[j].warn ? 'yes' : 'no');
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
            n.style.setProperty('--pvx-ctl-accent', cfg.AccentColor || '#3b82c4');
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
