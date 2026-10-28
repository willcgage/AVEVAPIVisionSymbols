/* ============================================================================
 * pvxManualEntry — "PVX Manual Entry"
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector (see the definition). This symbol does not read PI Vision's data pipeline and it
 * does not draw a chart. It puts ONE number (or state, or string) into ONE AF
 * attribute or PI point, from a display, on purpose, by a human.
 *
 * WHY THIS EXISTS
 *   Plenty of real plant data never comes off an instrument: a lab result, a
 *   manual tank dip, a catalyst charge, a shift note. Today that is a
 *   spreadsheet somebody re-keys later, which means the historian is missing
 *   the number at the moment anybody needs it. A write-back field on the
 *   display is the shortest path from "the operator knows" to "PI knows".
 *
 * WHY IT IS BUILT AS REAL DOM AND NOT SVG
 *   Every other symbol in this library draws into SVG. This one must not: the
 *   operator has to be able to Tab into the field, type, and press Enter, and a
 *   screen reader has to be able to announce the label. Only real <input>,
 *   <select> and <button> elements do that. SVG would look identical and be
 *   unusable with a keyboard.
 *
 * THE RULES A WRITE-BACK SYMBOL LIVES BY
 *   1. CONFIRM FIRST. There is no undo on a PI write. The confirmation names
 *      the value AND the target, because "Are you sure?" on its own is a
 *      button people learn to click without reading.
 *   2. VALIDATE BEFORE SENDING. Range, numeric parse, digital-state membership
 *      and timestamp are all checked locally. A rejection the operator can see
 *      and fix in a second beats a 400 that arrives after a round trip and says
 *      something about a serialiser.
 *   3. ONE WRITE AT A TIME. The button is disabled for the whole flight of the
 *      request and re-enabled on BOTH the success and the failure path. An
 *      impatient double-click must not put the number in twice.
 *   4. NEVER RETRY, NEVER CACHE. PVX.api refuses to cache or retry a write, and
 *      this symbol adds nothing of its own. A silently repeated write is how a
 *      wrong number gets into the historian twice.
 *   5. SAY WHAT HAPPENED. Not configured, no path, path did not resolve, 403,
 *      rejected, read-only preview: six different problems with six different
 *      owners. One shared "failed" message sends five of them to the wrong
 *      person.
 *
 * SECURITY
 *   PI and AF security are the access control. This symbol does not decide who
 *   may write; when the answer is no it surfaces the 403 plainly and says so.
 *
 * REFRESH AND TEARDOWN
 *   With no data pipeline nothing tells this symbol when the current value
 *   changed, so it runs its own interval. Everything it starts, it stops in
 *   onDestroy — a leaked poller on a control-room kiosk runs for weeks.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below this the form is not usable — the label, the field and the confirm
     * step cannot all be read and hit. A squeezed form invites a mis-typed
     * write, so the symbol names itself and refuses instead of pretending. */
    var MIN_W = 200, MIN_H = 140;

    /* Progressive shedding above the minimum, tallest requirement first. */
    var HISTORY_H = 226;      // the recent-writes list
    var CURRENT_H = 168;      // the current-value line

    var definition = {
        typeName: 'pvxManualEntry',
        displayName: 'PVX Manual Entry',

        // One data source, which this symbol ignores: everything it shows comes
        // from its config pane. PI Vision keeps DatasourceBehaviors.None symbols
        // out of the symbol selector altogether (its guide calls them "static
        // symbols"), so declared that way this could never be placed on a
        // display. Pick it and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        // A collection would repeat one input box per element, and each copy
        // would still write to the path typed in the config pane. That is a
        // trap, not a feature.
        supportsCollections: false,
        configTitle: 'Format Manual Entry',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                // The cheapest query PI Vision has, for a value nothing reads.
                DataShape: 'Value',
                Height: 240,
                Width: 400,

                Title: '',
                ShowLabel: true,

                /* -- target ---------------------------------------------------- *
                 * An AF attribute path, or a PI point path. Both resolve through
                 * the same endpoint, so both are accepted here. */
                AttributePath: '',

                /* -- what the operator sees before typing ---------------------- */
                ShowCurrentValue: true,
                ShowTimestamp: true,
                RefreshSeconds: 30,

                /* -- what the operator may type -------------------------------- */
                InputType: 'number',      // number | text | digital | boolean
                DigitalStates: '',        // comma separated, for InputType digital
                Units: '',
                Decimals: 'auto',

                /* -- how it is entered ------------------------------------------ *
                 * 'field' is the box or dropdown this symbol always had. The
                 * rest come from PVX.entry: stepper and slider for a number, a
                 * switch for two positions, a row of buttons for a few choices,
                 * and 'value', a button that writes one fixed value. */
                Control: 'field',         // field | stepper | slider | switch | buttons | value
                StepSize: '1',            // stepper and slider
                SwitchOffLabel: '',       // blank = the state's own name
                SwitchOnLabel: '',
                // A switch, button row, slider or dropdown writes as soon as it
                // is used (still through the confirmation when that is on).
                WriteOnChange: false,
                // Control 'value': what the button writes, and for a momentary
                // button what is written back after ResetSeconds.
                PressValue: '',
                ResetValue: '',
                ResetSeconds: 2,

                /* -- guard rails ------------------------------------------------ *
                 * Checked locally, before anything is sent. */
                MinValue: '',
                MaxValue: '',

                /* -- the confirmation step -------------------------------------- *
                 * Default ON. There is no undo. */
                RequireConfirm: true,
                ConfirmText: 'Write {value} to {name}?',

                /* -- when the value happened ------------------------------------ */
                TimestampMode: 'now',     // now | custom
                AllowFutureTimestamp: false,

                /* -- the button -------------------------------------------------- */
                ButtonLabel: 'Write',
                ButtonColor: '#3b82c4',

                /* -- audit trail for this symbol instance ------------------------ *
                 * Not a history of the tag — a history of what THIS symbol sent,
                 * so the operator can see their own last few entries without
                 * leaving the display. It lives in memory and dies with the
                 * display; PI is the record. */
                ShowHistory: true,
                HistoryCount: 5,

                /* -- build-before-permissions mode -------------------------------- */
                ReadOnlyPreview: false
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the header is Angular-bound; the form itself is imperative DOM.
        scope.pvx = { title: '', subtitle: '', background: '' };

        /* ---------------------------------------------------------------- *
         * instance state
         * ---------------------------------------------------------------- */
        var state = {
            // idle | resolving | ready | unconfigured | nopath | unresolved
            phase: 'idle',
            error: null,          // resolution failure, carrying .pvxError
            webId: '',            // resolved once, then reused (see resolvePath)
            name: '',             // the attribute's own name, from PI Web API
            units: '',            // its engineering units, if it has any
            current: null,        // {value, display, timestamp, good}
            currentErr: null,     // a failed READ never blocks a write
            busy: false,          // a write is in flight — the control is locked
            pending: null,        // a validated write awaiting confirmation
            message: null,        // {tone, text, detail}
            history: [],          // writes made from THIS symbol instance
            reset: null           // a momentary reset waiting to be sent: {v, timer, at}
        };

        var liveCfg = scope.config || {};
        var generation = 0;       // bumps on refresh; stale replies are dropped

        /* Path -> Promise of {webId, name, units}.
         *
         * A WebId is stable for the life of the attribute, so this is resolved
         * once and reused. The VALUE is never cached — that is the one thing
         * that must always be fresh. */
        var pathCache = {};

        var refreshTimer = null;
        var timerSeconds = null;
        var debounceTimer = null;

        // Imperative DOM, built once and patched. Rebuilding it every frame
        // would blow away the operator's half-typed value and their focus.
        var ui = null;
        var inputSig = '';        // rebuild the control only when its shape changes
        var ctl = null;           // the PVX.entry control in the form
        var ctlInfo = null;       // controlOf() for the control that is built
        var listeners = [];       // every one is removed in teardown()

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-mentry-body',
            render: render,

            onConfigChange: function (newCfg) {
                liveCfg = newCfg || liveCfg;
                ensureTimer(liveCfg);
                // Debounced: the config pane fires on every keystroke in the
                // path field, and each one would be a round trip against a
                // half-typed path.
                refreshSoon();
            },

            onDestroy: teardown
        });

        /* ================================================================ *
         * small helpers
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
            // textContent throughout: a PI-supplied name or an error message
            // from a server must never be able to become markup.
            if (node && node.textContent !== text) { node.textContent = text; }
        }

        /* ================================================================ *
         * configuration readers
         * ================================================================ */

        function digitalStates(cfg) {
            var out = [];
            String(cfg.DigitalStates || '').split(',').forEach(function (s) {
                var v = trim(s);
                if (v) { out.push(v); }
            });
            return out;
        }

        function inputType(cfg) {
            var t = trim(cfg.InputType).toLowerCase();
            if (t === 'text' || t === 'digital' || t === 'boolean') { return t; }
            return 'number';
        }

        /* Kinds that keep their value in a hidden input: nothing is chosen
         * until the operator moves them, and they go back to showing what PI
         * holds once a write has gone through. */
        var PICKED = { slider: 1, 'switch': 1, buttons: 1 };

        /**
         * Which PVX.entry control to build for this type and Control setting.
         * A Control that does not fit the type gives the plain field and a
         * note saying why, never a quietly different control.
         * @returns {Object} {kind, choices, note}
         */
        function controlOf(cfg) {
            var type = inputType(cfg);
            var want = trim(cfg.Control).toLowerCase() || 'field';
            var states = digitalStates(cfg);
            var listOf = function (arr) { return arr.map(function (x) { return { value: x, label: x }; }); };
            var tf = [{ value: 'True', label: 'True' }, { value: 'False', label: 'False' }];
            var field = function (note) {
                if (type === 'digital') { return { kind: 'select', choices: listOf(states), note: note || '' }; }
                if (type === 'boolean') { return { kind: 'select', choices: tf, note: note || '' }; }
                return { kind: type === 'text' ? 'text' : 'number', choices: [], note: note || '' };
            };
            if (want === 'stepper') {
                return type === 'number' ? { kind: 'stepper', choices: [], note: '' }
                    : field('A stepper is for numbers, so this ' + type + ' value has the plain field.');
            }
            if (want === 'slider') {
                if (type !== 'number') { return field('A slider is for numbers, so this ' + type + ' value has the plain field.'); }
                if (PVX.util.num(cfg.MinValue) === null || PVX.util.num(cfg.MaxValue) === null) {
                    return field('A slider needs a minimum and a maximum, so this has the plain field until both are set.');
                }
                return { kind: 'slider', choices: [], note: '' };
            }
            if (want === 'switch') {
                var pair = null;
                if (type === 'boolean') { pair = [tf[1], tf[0]]; }
                else if (type === 'number') { pair = [{ value: '0', label: 'Off' }, { value: '1', label: 'On' }]; }
                else if (type === 'digital' && states.length === 2) { pair = listOf(states); }
                if (!pair) {
                    return field(type === 'digital'
                        ? 'A switch needs exactly two digital states (off first); this has ' + states.length + ', so it has the dropdown.'
                        : 'A switch is for two positions, so this text value has the plain field.');
                }
                return { kind: 'switch', note: '', choices: [
                    { value: pair[0].value, label: trim(cfg.SwitchOffLabel) || pair[0].label },
                    { value: pair[1].value, label: trim(cfg.SwitchOnLabel) || pair[1].label }] };
            }
            if (want === 'buttons') {
                var list = type === 'boolean' ? tf : listOf(states);
                if (!list.length) { return field('Buttons need choices: list them under Choices in the format pane.'); }
                if (list.length > 12) { return field('Buttons are for a few choices; ' + list.length + ' are listed, so this has the dropdown.'); }
                return { kind: 'buttons', choices: list, note: '' };
            }
            if (want === 'value') {
                return { kind: 'value', choices: [], note: trim(cfg.PressValue) ? ''
                    : 'Set the value this button writes (Value written) in the format pane.' };
            }
            return field('');
        }

        function resetConfigured(cfg) {
            return trim(cfg.Control).toLowerCase() === 'value' && trim(cfg.ResetValue) !== '';
        }

        function resetSeconds(cfg) {
            var n = PVX.util.num(cfg.ResetSeconds);
            return n === null ? 2 : PVX.util.clamp(n, 0.5, 3600);
        }

        function targetName(cfg) {
            // What the operator will see in the confirmation. The attribute's
            // real name from PI Web API is the truthful answer; the configured
            // path is the fallback while it is still resolving.
            return state.name || trim(cfg.AttributePath) || 'this attribute';
        }

        function unitsOf(cfg) {
            return trim(cfg.Units) || state.units || '';
        }

        function isPreview(cfg) {
            return cfg.ReadOnlyPreview === true;
        }

        /* ================================================================ *
         * PI Web API
         * ================================================================ */

        /**
         * Attribute or PI point path -> {webId, name, units}, resolved once.
         *
         * A FAILED lookup is not cached: a transient outage would otherwise
         * poison every refresh for as long as the display stays open.
         */
        function resolvePath(path) {
            if (pathCache[path]) { return pathCache[path]; }

            var p = PVX.api.get('attributes?path=' + encodeURIComponent(path) +
                    '&selectedFields=WebId;Name;Path;DefaultUnitsName')
                .then(function (a) {
                    if (!a || !a.WebId) {
                        throw {
                            pvxError: {
                                code: 'no-attribute',
                                message: 'PI Web API answered, but there is nothing at "' + path +
                                         '". An AF attribute path is \\\\<AF server>\\<database>\\<element>|<attribute>; ' +
                                         'a PI point path is \\\\<data server>\\<tag>.',
                                check: 'AttributePath / AF server name'
                            }
                        };
                    }
                    return { webId: a.WebId, name: a.Name || '', units: a.DefaultUnitsName || '' };
                });

            p['catch'](function () {
                if (pathCache[path] === p) { delete pathCache[path]; }
            });
            pathCache[path] = p;
            return p;
        }

        /** Unwrap PI Web API's value shape, including the nested digital state. */
        function unwrap(v) {
            if (v !== null && typeof v === 'object') {
                // A digital state arrives as {Name, Value, IsSystem}; the Name is
                // what an operator recognises.
                if (v.Name !== undefined) { return v.Name; }
                if (v.Value !== undefined) { return unwrap(v.Value); }
                return null;
            }
            return v === undefined ? null : v;
        }

        /* ================================================================ *
         * refresh — resolve the path, then read the current value
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

            // Each of these is a different problem with a different owner.
            if (!PVX.api.isConfigured()) {
                state.phase = 'unconfigured';
                state.error = null;
                ctx.render();
                return;
            }

            var path = trim(cfg.AttributePath);
            if (!path) {
                state.phase = 'nopath';
                state.error = null;
                ctx.render();
                return;
            }

            var gen = ++generation;
            if (state.phase !== 'ready') { state.phase = 'resolving'; }
            ctx.render();

            resolvePath(path)
                .then(function (info) {
                    if (stale(gen)) { return null; }
                    state.webId = info.webId;
                    state.name = info.name;
                    state.units = info.units;
                    state.phase = 'ready';
                    state.error = null;
                    ctx.render();
                    return readCurrent(gen, cfg);
                })['catch'](function (err) {
                    if (stale(gen)) { return; }
                    state.phase = 'unresolved';
                    state.error = err;
                    state.webId = '';
                    ctx.render();
                });
        }

        /**
         * The current value. A failure here is reported in the current-value
         * slot and nowhere else: not being able to READ the tag is no reason to
         * stop the operator WRITING to it, and the two permissions are genuinely
         * separate in PI.
         */
        function readCurrent(gen, cfg) {
            if (cfg.ShowCurrentValue === false || !state.webId) { return null; }
            return PVX.api.readValue(state.webId, { cache: false })
                .then(function (v) {
                    if (stale(gen)) { return; }
                    var raw = unwrap(v && v.Value);
                    state.current = {
                        value: raw,
                        display: displayValue(raw, cfg),
                        timestamp: v && v.Timestamp,
                        good: !v || v.Good !== false
                    };
                    state.currentErr = null;
                    ctx.render();
                })['catch'](function (e) {
                    if (stale(gen)) { return; }
                    state.current = null;
                    state.currentErr = (e && e.pvxError) || null;
                    ctx.render();
                });
        }

        function displayValue(raw, cfg) {
            if (raw === null || raw === undefined || raw === '') { return '--'; }
            if (typeof raw === 'boolean') { return raw ? 'True' : 'False'; }
            var n = PVX.util.num(raw);
            if (n === null || typeof raw === 'string') {
                // A digital state or a free-text value: show it as it came.
                return String(raw);
            }
            return PVX.fmt.number(n, { decimals: cfg.Decimals });
        }

        function stale(gen) {
            return ctx.destroyed || gen !== generation;
        }

        /* ================================================================ *
         * timers
         * ================================================================ */

        function ensureTimer(cfg) {
            var secs = intIn(cfg.RefreshSeconds, 5, 86400, 30);
            if (refreshTimer !== null && timerSeconds === secs) { return; }
            if (refreshTimer !== null) { clearInterval(refreshTimer); }
            timerSeconds = secs;
            refreshTimer = setInterval(function () {
                // A refresh mid-confirmation would move the number the operator
                // is about to approve out from under them. The value being
                // confirmed is the one they saw.
                if (state.pending || state.busy || state.reset) { return; }
                refresh();
            }, secs * 1000);
        }

        function refreshSoon() {
            if (debounceTimer !== null) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(function () {
                debounceTimer = null;
                refresh();
            }, 400);
        }

        function teardown() {
            // A display closed during a momentary press still sends the reset,
            // at once: a start signal left at 1 because somebody navigated
            // away is worse than a reset a second early.
            if (state.reset) {
                var r = state.reset;
                state.reset = null;
                if (r.timer !== null) { clearTimeout(r.timer); }
                try { PVX.api.writeValue(state.webId, r.v.value, '*')['catch'](function () { /* nobody left to tell */ }); } catch (e) { /* ditto */ }
            }
            if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
            if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
            for (var i = 0; i < listeners.length; i++) {
                try {
                    listeners[i].node.removeEventListener(listeners[i].type, listeners[i].fn, false);
                } catch (e) { /* the node may already be gone */ }
            }
            listeners = [];
            // Anything still in flight resolves into stale() and is dropped.
            generation += 1;
            ui = null;
            state.pending = null;
            state.busy = false;
        }

        /* ================================================================ *
         * timestamps
         * ================================================================ *
         * 'now' sends '*' and lets PI stamp it. The historian's clock is the
         * authority and a browser's clock is routinely minutes out; asking the
         * server to timestamp its own write is both simpler and more correct.
         *
         * 'custom' is for the reading that was TAKEN at 06:00 and typed in at
         * 07:15 — the common case for rounds and lab results. That one is
         * resolved locally, because the future-timestamp check and the value
         * actually sent must be the same instant. Checking one moment and
         * sending another is how "no future timestamps" quietly stops holding.
         */

        var UNIT_MS = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 };

        /** @returns {Number|null} epoch ms, or null when this cannot be read. */
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
                // A partly-understood expression is not understood. Guessing at
                // the timestamp of a manual entry is worse than declining.
                if (!consumed || consumed !== rest.length) { return null; }
                return nowMs + total;
            }

            var d = PVX.fmt.toDate(raw);
            return d ? d.getTime() : null;
        }

        /* ================================================================ *
         * validation — everything checkable is checked BEFORE anything is sent
         * ================================================================ */

        /**
         * @returns {Object} {ok, value, display, timestamp, error}
         *   value      what goes on the wire
         *   display    what the confirmation and the history show
         *   timestamp  '*' or an ISO string
         */
        function validate(cfg, override) {
            var type = inputType(cfg);
            var rawText = override !== undefined ? String(override)
                : (ui && ui.input ? String(ui.input.value) : '');
            var text = trim(rawText);
            var value = null;
            var display = '';
            var picked = ctlInfo && (PICKED[ctlInfo.kind] || ctlInfo.kind === 'select');

            if (!text && type !== 'text') {
                return { ok: false, error: picked ? 'Choose a value first.' : 'Enter a value first.' };
            }

            if (type === 'number') {
                // Not PVX.util.num: that helper strips non-numeric characters so
                // charts survive "12.3 kg". Here "12.3kg" is a typo the operator
                // must see, not a number to be guessed at.
                if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(text)) {
                    return { ok: false, error: '"' + text + '" is not a number.' };
                }
                value = parseFloat(text);
                if (!isFinite(value)) {
                    return { ok: false, error: '"' + text + '" is not a number.' };
                }
                var lo = PVX.util.num(cfg.MinValue);
                var hi = PVX.util.num(cfg.MaxValue);
                if (lo !== null && value < lo) {
                    return { ok: false, error: value + ' is below the minimum of ' + lo + '.' };
                }
                if (hi !== null && value > hi) {
                    return { ok: false, error: value + ' is above the maximum of ' + hi + '.' };
                }
                display = PVX.fmt.number(value, { decimals: cfg.Decimals });

            } else if (type === 'digital') {
                var states = digitalStates(cfg);
                if (!states.length) {
                    return { ok: false, error: 'No digital states are configured for this symbol.' };
                }
                // The dropdown already limits the choice; this checks it anyway,
                // because the list can change under a selection that is still
                // sitting in the control.
                var found = null;
                for (var i = 0; i < states.length; i++) {
                    if (states[i].toLowerCase() === text.toLowerCase()) { found = states[i]; }
                }
                if (found === null) {
                    return { ok: false, error: '"' + text + '" is not one of the configured states.' };
                }
                value = found;
                display = found;

            } else if (type === 'boolean') {
                if (text !== 'True' && text !== 'False') {
                    return { ok: false, error: 'Choose True or False.' };
                }
                value = (text === 'True');
                display = text;

            } else {
                if (!text) { return { ok: false, error: picked ? 'Choose a value first.' : 'Enter a value first.' }; }
                value = rawText;          // text is stored as typed, spaces and all
                display = text;
            }

            /* ---- timestamp ------------------------------------------------- */
            var stamp = '*';
            if (trim(cfg.TimestampMode) === 'custom') {
                var tsText = ui && ui.tsInput ? ui.tsInput.value : '';
                if (!trim(tsText)) {
                    return { ok: false, error: 'Enter a timestamp, or switch this symbol back to "now".' };
                }
                var now = (new Date()).getTime();
                var ms = parseTimestamp(tsText, now);
                if (ms === null) {
                    return { ok: false, error: 'Timestamp not understood. Use 2026-08-08 14:30, or * with an offset such as *-2h.' };
                }
                if (cfg.AllowFutureTimestamp !== true && ms > now + 60000) {
                    // A minute of slack: clocks disagree, and rejecting a value
                    // stamped 20 seconds ahead helps nobody.
                    return { ok: false, error: 'That timestamp is in the future. Allow future timestamps in the format pane if that is deliberate.' };
                }
                stamp = new Date(ms).toISOString();
            }

            return { ok: true, value: value, display: display, timestamp: stamp };
        }

        /* ================================================================ *
         * the write
         * ================================================================ */

        function onSubmit() {
            var cfg = liveCfg;

            // Guard 3 of the write rules: nothing starts while something is in
            // flight. The button is also disabled — this is the belt to that
            // pair of braces, because Enter can reach a disabled button's
            // handler on some browsers.
            if (state.busy || state.reset || state.phase !== 'ready') { return; }

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

            var press = ctlInfo && ctlInfo.kind === 'value';
            if (press && !trim(cfg.PressValue)) {
                state.message = { tone: 'warn', text: 'No value set for this button', detail: ctlInfo.note };
                ctx.render();
                return;
            }
            var v = validate(cfg, press ? trim(cfg.PressValue) : undefined);
            if (v.ok && press) { v.press = true; }
            if (!v.ok) {
                state.message = { tone: 'error', text: v.error, detail: press ? 'Value written: "' + trim(cfg.PressValue) + '"' : '' };
                state.pending = null;
                ctx.render();
                return;
            }

            if (cfg.RequireConfirm !== false) {
                // Hold the validated value. The confirmation approves THIS
                // value, not whatever is in the box by the time it is clicked.
                state.pending = v;
                state.message = null;
                ctx.render();
                return;
            }
            sendWrite(v);
        }

        function onConfirm() {
            var v = state.pending;
            if (!v || state.busy) { return; }
            sendWrite(v);
        }

        function onCancel() {
            state.pending = null;
            // A switch flipped and then cancelled goes back to showing what PI
            // holds; leaving it flipped would show a state nobody wrote.
            if (ui && ui.input && ctlInfo && PICKED[ctlInfo.kind]) { ui.input.value = ''; }
            state.message = { tone: 'info', text: 'Cancelled. Nothing was written.', detail: '' };
            ctx.render();
        }

        /**
         * One value, one call, no retry, no batching.
         *
         * The control is locked for the whole flight and unlocked on BOTH
         * paths — a failure that left the form disabled would strand the
         * operator with a value they cannot resend.
         */
        function sendWrite(v) {
            var cfg = liveCfg;
            state.busy = true;
            state.pending = null;
            state.message = { tone: 'info', text: 'Writing\u2026', detail: '' };
            ctx.render();

            var gen = generation;
            var target = targetName(cfg);

            PVX.api.writeValue(state.webId, v.value, v.timestamp)
                .then(function () {
                    if (ctx.destroyed) { return; }
                    state.busy = false;
                    state.message = {
                        tone: 'ok',
                        text: (v.isReset ? 'Reset to ' : 'Saved ') + v.display + (unitsOf(cfg) ? ' ' + unitsOf(cfg) : ''),
                        detail: 'to ' + target
                    };
                    pushHistory(v.display, true, v.isReset ? 'reset' : 'saved');
                    if (ui && ui.input && ctlInfo && PICKED[ctlInfo.kind]) { ui.input.value = ''; }
                    if (v.press && resetConfigured(cfg)) { scheduleReset(cfg); }
                    // Read it back so the current-value line shows what PI
                    // actually holds, not what we believe we sent.
                    if (!stale(gen)) { readCurrent(gen, cfg); }
                    ctx.render();
                })['catch'](function (err) {
                    if (ctx.destroyed) { return; }
                    state.busy = false;
                    var e = (err && err.pvxError) || null;
                    var forbidden = e && e.code === 'forbidden';
                    state.message = {
                        tone: 'error',
                        text: forbidden
                            ? 'Write refused — not permitted'
                            : 'Write rejected',
                        detail: forbidden
                            // Named plainly, because the instinct is to look for
                            // a symbol setting and there is not one to find.
                            ? 'You are signed in, but this identity may not write to ' + target + '. ' +
                              'PI and AF security govern this and the symbol cannot grant it — ask for a ' +
                              'write mapping on the AF database or the PI point. Check: ' +
                              (e.check || 'AF / Data Archive mappings')
                            : (e ? e.message + '  Check: ' + e.check
                                 : 'The write failed and returned no diagnosis.')
                    };
                    if (v.isReset) {
                        // The one failure that leaves the plant in a state
                        // nobody chose: say what it is still holding.
                        state.message.text = 'Reset to ' + v.display + ' failed';
                        state.message.detail = target + ' may still hold ' + trim(cfg.PressValue) +
                            '. Write ' + v.display + ' to it by hand.  ' + state.message.detail;
                    }
                    pushHistory(v.display, false, v.isReset ? 'reset failed' : (forbidden ? 'not permitted' : 'failed'));
                    ctx.render();
                });
        }

        /* ================================================================ *
         * momentary — a value button that puts the old value back
         * ================================================================ *
         * A start pulse, a reset request or a sample trigger: write 1, and
         * after a couple of seconds write 0. The reset is a second write,
         * sent once with no retry like every other write here, with no
         * confirmation: the press was the confirmed action. The button stays
         * locked until the reset has gone, so presses cannot overlap. */
        function scheduleReset(cfg) {
            var v = validate(cfg, trim(cfg.ResetValue));
            if (!v.ok) {
                state.message = { tone: 'error', text: 'Reset value "' + trim(cfg.ResetValue) + '" not sent',
                    detail: v.error + '  ' + targetName(cfg) + ' still holds ' + trim(cfg.PressValue) + '.' };
                pushHistory(trim(cfg.ResetValue), false, 'reset not sent');
                return;
            }
            // The reset is about now, whatever stamp the press carried.
            v.timestamp = '*';
            v.isReset = true;
            var ms = resetSeconds(cfg) * 1000;
            state.reset = { v: v, at: (new Date()).getTime() + ms, timer: null };
            state.reset.timer = setTimeout(function () { fireReset(); }, ms);
        }

        function fireReset() {
            var r = state.reset;
            if (!r) { return; }
            if (r.timer !== null) { clearTimeout(r.timer); }
            state.reset = null;
            sendWrite(r.v);
        }

        function pushHistory(display, ok, note) {
            state.history.unshift({
                at: (new Date()).getTime(),
                display: display,
                ok: ok,
                note: note
            });
            // Bounded: this is a courtesy list, not a journal. PI is the record.
            if (state.history.length > 20) { state.history.length = 20; }
        }

        /* ================================================================ *
         * DOM — built once, then patched
         * ================================================================ */

        function buildDom(host) {
            host.innerHTML = '';
            var u = {};

            /* -- the non-form states (not configured, no path, too small) ---- */
            u.state = el('div', 'pvx-mentry-state', host);
            u.stateHead = el('div', 'pvx-mentry-state-head', u.state);
            u.stateBody = el('div', 'pvx-mentry-state-body', u.state);

            /* -- the form ---------------------------------------------------- */
            u.form = el('div', 'pvx-mentry-form', host);

            u.current = el('div', 'pvx-mentry-current', u.form);
            u.currentLabel = el('span', 'pvx-mentry-current-label', u.current);
            setText(u.currentLabel, 'Current');
            u.currentValue = el('span', 'pvx-mentry-current-value pvx-num', u.current);
            u.currentTime = el('span', 'pvx-mentry-current-time', u.current);

            u.fieldLabel = el('label', 'pvx-mentry-label', u.form);
            u.inputWrap = el('div', 'pvx-mentry-inputwrap', u.form);
            // The control itself is created by ensureInput(), which knows the
            // configured type.
            u.note = el('div', 'pvx-mentry-note', u.form);

            u.tsRow = el('div', 'pvx-mentry-ts', u.form);
            u.tsLabel = el('label', 'pvx-mentry-ts-label', u.tsRow);
            setText(u.tsLabel, 'Timestamp');
            u.tsInput = el('input', 'pvx-mentry-input pvx-mentry-ts-input', u.tsRow);
            u.tsInput.type = 'text';
            u.tsInput.setAttribute('placeholder', '2026-08-08 06:00  or  *-2h');
            u.tsInput.id = PVX.util.uid('pvx-me-ts');
            u.tsLabel.setAttribute('for', u.tsInput.id);

            u.actions = el('div', 'pvx-mentry-actions', u.form);
            u.button = el('button', 'pvx-btn pvx-mentry-btn', u.actions);
            u.button.type = 'button';
            on(u.button, 'click', function () { onSubmit(); });

            /* -- the confirmation step ---------------------------------------- *
             * Replaces the button rather than sitting beside it: there must be
             * no way to click "Write" again while a confirmation is open. */
            u.confirm = el('div', 'pvx-mentry-confirm', u.form);
            u.confirmText = el('div', 'pvx-mentry-confirm-text', u.confirm);
            u.confirmBtns = el('div', 'pvx-mentry-confirm-btns', u.confirm);
            u.confirmYes = el('button', 'pvx-btn pvx-mentry-yes', u.confirmBtns);
            u.confirmYes.type = 'button';
            setText(u.confirmYes, 'Confirm');
            on(u.confirmYes, 'click', function () { onConfirm(); });
            u.confirmNo = el('button', 'pvx-btn pvx-mentry-no', u.confirmBtns);
            u.confirmNo.type = 'button';
            setText(u.confirmNo, 'Cancel');
            on(u.confirmNo, 'click', function () { onCancel(); });

            u.msg = el('div', 'pvx-mentry-msg', u.form);
            u.msgText = el('div', 'pvx-mentry-msg-text', u.msg);
            u.msgDetail = el('div', 'pvx-mentry-msg-detail', u.msg);

            u.history = el('div', 'pvx-mentry-history', u.form);

            return u;
        }

        /**
         * Create the input control for the configured type.
         *
         * Rebuilt only when the SHAPE changes (number -> dropdown, or the state
         * list is edited). Rebuilding on every render would destroy focus and
         * whatever the operator had half-typed.
         */
        function ensureInput(cfg) {
            var info = controlOf(cfg);
            var sig = info.kind + '|' + info.choices.map(function (c) { return c.value + '=' + c.label; }).join(',') +
                '|' + trim(cfg.StepSize) + '|' + trim(cfg.MinValue) + '|' + trim(cfg.MaxValue);
            ctlInfo = info;
            if (ui.input && inputSig === sig) { return; }
            inputSig = sig;

            ui.inputWrap.innerHTML = '';
            if (info.kind === 'value') {
                // No field: the button is the control. A hidden input keeps
                // the rest of the form's code the same for every kind.
                ui.input = el('input', null, ui.inputWrap);
                ui.input.type = 'hidden';
                ui.pressText = el('div', 'pvx-mentry-press', ui.inputWrap);
                ctl = null;
                ui.fieldLabel.removeAttribute('for');
                return;
            }
            ui.pressText = null;
            ctl = PVX.entry.build({
                kind: info.kind,
                parent: ui.inputWrap,
                inputClass: 'pvx-mentry-input' + (info.kind === 'select' ? ' pvx-mentry-select' : ''),
                min: PVX.util.num(cfg.MinValue),
                max: PVX.util.num(cfg.MaxValue),
                step: trim(cfg.StepSize),
                choices: info.choices,
                listen: on,
                format: function (v) {
                    var n = PVX.util.num(v);
                    return n === null ? String(v) : PVX.fmt.number(n, { decimals: liveCfg.Decimals });
                },
                onPick: function (v, commit) {
                    if (state.message && state.message.tone === 'error' && !state.busy) { state.message = null; }
                    // Stepper clicks never commit; see PVX.entry.
                    if (commit && liveCfg.WriteOnChange === true && v !== '') { onSubmit(); return; }
                    ctx.render();
                }
            });
            var node = ctl.input;
            ui.input = node;
            if (ctl.focus) {
                if (!ctl.focus.id) { ctl.focus.id = PVX.util.uid('pvx-me-in'); }
                ui.fieldLabel.setAttribute('for', ctl.focus.id);
            }

            if (info.kind === 'number' || info.kind === 'text' || info.kind === 'stepper' || info.kind === 'select') {
                // Enter submits — the whole point of a keyboard-usable form.
                on(node, 'keydown', function (ev) {
                    if (ev.key === 'Enter' || ev.keyCode === 13) {
                        ev.preventDefault();
                        if (state.pending) { onConfirm(); } else { onSubmit(); }
                    }
                });
                // Typing after a rejection clears the rejection: the message
                // referred to the old text and is now just noise.
                on(node, 'input', function () {
                    if (state.message && state.message.tone === 'error' && !state.busy) {
                        state.message = null;
                        ctx.render();
                    }
                });
            }
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

            if (!ui || ui.form.parentNode !== host) { ui = buildDom(host); inputSig = ''; }

            /* Measured against the SYMBOL, not the drawing host: the host is
             * what is left after the header, so measuring it would make the
             * decision depend on the chrome the decision itself removes. */
            var rootW = Math.max(40, (c.node && c.node.clientWidth) || c.width || 40);
            var rootH = Math.max(24, (c.node && c.node.clientHeight) || c.height || 24);
            var tooSmall = rootW < MIN_W || rootH < MIN_H;

            scope.pvx.title = tooSmall ? '' : (trim(cfg.Title) || 'Manual entry');
            scope.pvx.subtitle = '';

            if (tooSmall) {
                // Named, so an engineer looking at a wall of small boxes knows
                // which one to resize.
                showState('PVX Manual Entry',
                    'Too small for a data-entry form. Make this symbol at least ' +
                    MIN_W + ' × ' + MIN_H + ' pixels.', 'warn');
                digest();
                return;
            }
            if (state.phase === 'unconfigured') {
                showState('PI Web API is not configured',
                    'This symbol writes through PI Web API. ' + PVX.api.unsetHint() +
                    ', then confirm it with ext/piwebapi-check.html.', 'warn');
                digest();
                return;
            }
            if (state.phase === 'nopath') {
                showState('No attribute configured',
                    'Set the AF attribute or PI point path in the format pane, for example ' +
                    '\\\\AFSERVER01\\Production\\Reactor1|Catalyst Charge.', 'warn');
                digest();
                return;
            }
            if (state.phase === 'unresolved') {
                var e = (state.error && state.error.pvxError) || null;
                showState('Attribute path did not resolve',
                    e ? e.message + '  Check: ' + e.check
                      : 'The lookup failed and returned no diagnosis.', 'error');
                digest();
                return;
            }
            if (state.phase !== 'ready') {
                showState('Resolving\u2026', '', 'muted');
                digest();
                return;
            }

            renderForm(cfg, t, rootH);
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

        function renderForm(cfg, t, rootH) {
            show(ui.state, false);
            show(ui.form, true);
            ensureInput(cfg);

            var preview = isPreview(cfg);
            var units = unitsOf(cfg);

            /* ---- current value ---------------------------------------------- */
            var wantCurrent = cfg.ShowCurrentValue !== false && rootH >= CURRENT_H;
            show(ui.current, wantCurrent);
            if (wantCurrent) {
                if (state.currentErr) {
                    setText(ui.currentValue, 'read failed');
                    setText(ui.currentTime, state.currentErr.check ? '(' + state.currentErr.check + ')' : '');
                    ui.current.setAttribute('data-quality', 'bad');
                } else if (state.current) {
                    setText(ui.currentValue, state.current.display + (units ? ' ' + units : ''));
                    setText(ui.currentTime,
                        (cfg.ShowTimestamp !== false && state.current.timestamp)
                            ? PVX.fmt.time(state.current.timestamp, 'time') : '');
                    ui.current.setAttribute('data-quality', state.current.good ? 'good' : 'bad');
                } else {
                    setText(ui.currentValue, '--');
                    setText(ui.currentTime, '');
                    ui.current.setAttribute('data-quality', 'good');
                }
            }

            /* ---- the field --------------------------------------------------- */
            setText(ui.fieldLabel, targetName(cfg) + (units ? '  (' + units + ')' : ''));

            var range = rangeText(cfg);
            ui.input.setAttribute('title', range || '');
            setText(ui.note, ctlInfo.note);
            show(ui.note, !!ctlInfo.note);
            if (ui.pressText) {
                var units0 = units ? ' ' + units : '';
                setText(ui.pressText, trim(cfg.PressValue)
                    ? 'Writes ' + trim(cfg.PressValue) + units0 +
                      (resetConfigured(cfg) ? ', then ' + trim(cfg.ResetValue) + units0 + ' after ' + resetSeconds(cfg) + ' s' : '')
                    : 'No value set');
            }
            if (inputType(cfg) === 'number' && ctl && (ctlInfo.kind === 'number' || ctlInfo.kind === 'stepper')) {
                // Native hints as well as our own check: the browser's spinner
                // and mobile keyboards use them, and validate() still owns the
                // decision.
                var lo = PVX.util.num(cfg.MinValue), hi = PVX.util.num(cfg.MaxValue);
                if (lo !== null) { ui.input.setAttribute('min', lo); } else { ui.input.removeAttribute('min'); }
                if (hi !== null) { ui.input.setAttribute('max', hi); } else { ui.input.removeAttribute('max'); }
                ui.input.setAttribute('placeholder', range || 'Value');
            }

            var custom = trim(cfg.TimestampMode) === 'custom';
            show(ui.tsRow, custom);

            /* ---- actions ------------------------------------------------------ *
             * Exactly one of the button and the confirmation is ever visible. */
            var confirming = !!state.pending;
            show(ui.actions, !confirming);
            show(ui.confirm, confirming);

            if (confirming) {
                setText(ui.confirmText, confirmMessage(cfg, state.pending));
                ui.confirmYes.disabled = state.busy;
                ui.confirmNo.disabled = state.busy;
                ui.confirmYes.style.background = trim(cfg.ButtonColor) || '#3b82c4';
                ui.confirmYes.style.color = PVX.color.readable(trim(cfg.ButtonColor) || '#3b82c4');
            } else {
                setText(ui.button, state.busy ? 'Writing\u2026'
                    : (state.reset ? 'Resetting\u2026'
                    : (preview ? 'Preview only' : (trim(cfg.ButtonLabel) || 'Write'))));
                // Disabled for the whole flight of the request. Re-enabled on
                // both the success and the failure path, by sendWrite(). A
                // momentary press also holds it until its reset has gone.
                ui.button.disabled = state.busy || preview || !!state.reset;
                var bg = preview ? t.textMuted : (trim(cfg.ButtonColor) || '#3b82c4');
                ui.button.style.background = bg;
                ui.button.style.color = PVX.color.readable(bg);
            }
            if (ctl) {
                ctl.sync({ current: state.current ? state.current.value : null, disabled: state.busy || !!state.reset });
            } else {
                ui.input.disabled = state.busy;
            }
            ui.tsInput.disabled = state.busy;

            /* ---- message ------------------------------------------------------ */
            var msg = state.message;
            if (!msg && preview) {
                msg = {
                    tone: 'warn',
                    text: 'Read-only preview',
                    detail: 'The form is live but writes are disabled.'
                };
            }
            show(ui.msg, !!msg);
            if (msg) {
                ui.msg.setAttribute('data-tone', msg.tone);
                setText(ui.msgText, msg.text);
                setText(ui.msgDetail, msg.detail || '');
                show(ui.msgDetail, !!msg.detail);
            }

            /* ---- history ------------------------------------------------------ */
            var wantHistory = cfg.ShowHistory !== false && rootH >= HISTORY_H && state.history.length > 0;
            show(ui.history, wantHistory);
            if (wantHistory) { renderHistory(cfg); }
        }

        function rangeText(cfg) {
            var lo = PVX.util.num(cfg.MinValue), hi = PVX.util.num(cfg.MaxValue);
            if (lo !== null && hi !== null) { return lo + ' to ' + hi; }
            if (lo !== null) { return 'at least ' + lo; }
            if (hi !== null) { return 'at most ' + hi; }
            return '';
        }

        /**
         * The confirmation sentence. It names the VALUE and the TARGET, always:
         * a confirmation that says only "are you sure?" trains people to click
         * it without reading, which is worse than no confirmation at all.
         */
        function confirmMessage(cfg, v) {
            var units = unitsOf(cfg);
            var tpl = trim(cfg.ConfirmText) || 'Write {value} to {name}?';
            var out = tpl
                .split('{value}').join(v.display + (units ? ' ' + units : ''))
                .split('{name}').join(targetName(cfg))
                .split('{units}').join(units)
                .split('{path}').join(trim(cfg.AttributePath));
            if (v.timestamp !== '*') {
                out += '  Timestamp ' + PVX.fmt.time(v.timestamp, 'datetime') + '.';
            }
            return out;
        }

        function renderHistory(cfg) {
            var want = intIn(cfg.HistoryCount, 1, 20, 5);
            var rows = state.history.slice(0, want);

            // Rebuild only when the row count changes; otherwise patch, so the
            // list does not flicker on every refresh tick.
            if (ui.history.childNodes.length !== rows.length + 1) {
                ui.history.innerHTML = '';
                ui.historyHead = el('div', 'pvx-mentry-history-head', ui.history);
                ui.historyRows = [];
                for (var i = 0; i < rows.length; i++) {
                    var r = el('div', 'pvx-mentry-history-row', ui.history);
                    var rec = {
                        row: r,
                        time: el('span', 'pvx-mentry-history-time', r),
                        value: el('span', 'pvx-mentry-history-value pvx-num', r),
                        note: el('span', 'pvx-mentry-history-note', r)
                    };
                    ui.historyRows.push(rec);
                }
            }
            setText(ui.historyHead, 'This session');
            for (var j = 0; j < rows.length; j++) {
                var rec2 = ui.historyRows[j];
                setText(rec2.time, PVX.fmt.time(rows[j].at, 'time'));
                setText(rec2.value, rows[j].display);
                setText(rec2.note, rows[j].note);
                rec2.row.setAttribute('data-ok', rows[j].ok ? 'yes' : 'no');
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
            n.style.setProperty('--pvx-ctl-accent', trim(cfg.ButtonColor) || '#3b82c4');
        }

        /* Renders happen in a rAF and answers arrive in Promise callbacks, both
         * outside Angular's digest, so the scope.pvx writes need a guarded one. */
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
