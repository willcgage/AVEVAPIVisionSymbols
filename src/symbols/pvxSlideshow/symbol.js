/* ============================================================================
 * pvxSlideshow — "PVX Display Slideshow"
 * ----------------------------------------------------------------------------
 * Rotates a control-room screen through a list of PI Vision displays on a
 * timer. Its one data source is never read (it only gets the symbol into the
 * selector), and there is no PI Web API: everything is URL navigation through
 * PVX.nav, the same mechanism pvxNavPanel uses.
 *
 * THE ONE THING TO UNDERSTAND BEFORE READING ANY OF THIS
 *   Navigating away destroys this symbol along with the rest of the display. A
 *   slideshow that lives on display A and jumps to display B does not survive
 *   to make the jump after that. So the rotation is not owned by one instance:
 *   the SAME symbol with the SAME configuration is placed on EVERY display in
 *   the list. Each instance reads the current display out of the URL, finds its
 *   own position in the configured list, and schedules exactly one jump — to
 *   the next entry. The instance waiting on that display then does the same.
 *
 *   That is why the configuration is identical everywhere, and why nothing here
 *   is per-display. A design that needed per-display setup is the one people
 *   abandon after wiring up the third display.
 *
 * CONSEQUENCES THAT SHAPE THIS FILE
 *   - Pause cannot be instance state. Pausing on display A would mean nothing
 *     if display B's copy resumed the instant the screen changed. So pause
 *     lives in sessionStorage (per tab, gone when the browser session ends),
 *     guarded, with an in-memory fallback for locked-down environments.
 *   - Edit mode is re-checked on every tick, never once at init. An engineer
 *     editing a display that navigates out from under them loses work, and will
 *     never place this symbol again.
 *   - The timer is ONE interval that decrements a remaining-time counter, not a
 *     setTimeout aimed at a target instant. Pausing is then simply "stop
 *     decrementing", and a throttled background tab still does correct
 *     arithmetic instead of firing a burst of missed jumps.
 *   - The UI is real DOM, not SVG: the controls are <button> elements so they
 *     get focus, Enter/Space and screen-reader semantics for free. Only the
 *     countdown ring inside them is SVG.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* ================================================================== *
     * Shared rotation state — deliberately NOT per instance
     * ================================================================== *
     * One fixed key for the whole rotation. Every display in the list reads and
     * writes the same record, which is what makes "pause" survive a navigation.
     *
     * sessionStorage rather than localStorage: a pause is a decision about THIS
     * screen for THIS shift. localStorage would silently pause a slideshow on a
     * different monitor tomorrow morning, and nobody would know why.
     *
     * Some deployments (kiosk lockdowns, third-party-cookie style policies, a
     * sandboxed iframe) throw on any access. That must never break the symbol,
     * so every access is guarded and falls back to a module-level object shared
     * by all instances in this document — pause then still works, just not
     * across a navigation. The symbol says so rather than pretending.
     */
    var STORE_KEY = 'pvx.slideshow.v1';
    var storageBroken = false;

    var memoryState = {
        paused: false,      // manual pause by an operator
        pausedAt: 0,
        interactAt: 0,      // epoch ms of the last human activity on the page
        lastIndex: -1       // last rotation entry actually visited
    };

    function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

    /** Current shared state. Always returns an object; never throws. */
    function readState() {
        if (!storageBroken) {
            try {
                var raw = window.sessionStorage.getItem(STORE_KEY);
                if (raw) {
                    var o = JSON.parse(raw);
                    if (o && typeof o === 'object') {
                        memoryState = {
                            paused: !!o.paused,
                            pausedAt: Number(o.pausedAt) || 0,
                            interactAt: Number(o.interactAt) || 0,
                            lastIndex: typeof o.lastIndex === 'number' ? o.lastIndex : -1
                        };
                    }
                }
            } catch (e) {
                // Once it throws it will keep throwing; stop paying for it.
                storageBroken = true;
            }
        }
        return memoryState;
    }

    /** Merge a patch into the shared state and persist it. */
    function writeState(patch) {
        var s = readState();
        for (var k in patch) {
            if (hasOwn(patch, k)) { s[k] = patch[k]; }
        }
        memoryState = s;
        if (!storageBroken) {
            try { window.sessionStorage.setItem(STORE_KEY, JSON.stringify(s)); }
            catch (e2) { storageBroken = true; }
        }
        return s;
    }

    /** True once an access has actually failed — not a guess made up front. */
    function isStorageBlocked() { return storageBroken; }

    /* ================================================================== *
     * definition
     * ================================================================== */
    var definition = {
        typeName: 'pvxSlideshow',
        displayName: 'PVX Display Slideshow',

        // One data source, which this symbol ignores: everything it shows comes
        // from its config pane. PI Vision keeps DatasourceBehaviors.None symbols
        // out of the symbol selector altogether (its guide calls them "static
        // symbols"), so declared that way this could never be placed on a
        // display. Pick it and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Display Slideshow',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                // The cheapest query PI Vision has, for a value nothing reads.
                DataShape: 'Value',
                Height: 56,
                Width: 360,

                // The rotation. One entry per line:
                //   display | label | dwellSeconds
                Displays: '',
                DwellSeconds: 30,
                Enabled: true,

                // What to do when the current display is NOT in the list.
                StartBehaviour: 'resume',      // resume | first | nearest

                // Never navigate out from under somebody who is using the screen.
                PauseOnInteraction: true,
                ResumeAfterIdleSeconds: 120,   // 0 => stay paused until resumed by hand

                // Chrome
                ShowControls: 'hover',         // always | hover | never
                ShowProgress: true,
                ShowPosition: true,
                ShowLabel: true,
                Title: '',

                // What travels to the next display
                KeepTimeRange: true,
                KeepAsset: false,

                // Layout
                Orientation: 'horizontal',     // horizontal | vertical
                CompactMode: false
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Fields the template binds to.
        scope.pvx = { title: '', surface: 'transparent' };

        /* ---------------------------------------------------------------- *
         * instance state
         * ---------------------------------------------------------------- */
        var ui = null;              // handles into the DOM we built
        var builtSig = null;        // structure the current DOM was built from
        var boundHost = null;       // host carrying the delegated listeners
        var docBound = false;       // are the activity listeners attached?
        var tickTimer = null;
        var destroyed = false;

        var remainingMs = 0;        // countdown for the current dwell
        var cycleKey = null;        // identifies "which dwell are we in"
        var lastTickMs = 0;

        // 250 ms is four progress updates a second — smooth enough for a ring,
        // cheap enough to run for weeks on a kiosk.
        var TICK_MS = 250;

        // A mouse crossing the screen fires mousemove dozens of times. Recording
        // every one costs a sessionStorage write each; the idle window is
        // measured in minutes, so being up to a second stale is free.
        var ACTIVITY_THROTTLE_MS = 1000;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-ss-body',
            render: render,
            onDestroy: teardown
        });

        function now() { return Date.now(); }

        function trim(s) {
            return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, '');
        }

        /* ================================================================ *
         * Displays grammar
         * ================================================================ *
         *     displayId or /Displays/123/Name | Label | dwellSeconds
         *
         * Only the first field is required. Blank lines and lines starting with
         * '#' are ignored, so an author can comment a display out of the
         * rotation for a shift without losing the line.
         */

        function parseEntry(line) {
            var s = trim(line);
            if (!s || s.charAt(0) === '#') { return null; }

            var target = s, label = '', dwell = null;
            var first = s.indexOf('|');
            if (first !== -1) {
                target = trim(s.slice(0, first));
                var rest = s.slice(first + 1);
                var second = rest.indexOf('|');
                if (second === -1) {
                    label = trim(rest);
                } else {
                    label = trim(rest.slice(0, second));
                    dwell = PVX.util.num(rest.slice(second + 1));
                }
            }
            if (!target) { return null; }          // no target is not an entry
            if (dwell !== null) { dwell = PVX.util.clamp(Math.round(dwell), 1, 86400); }
            return {
                target: target,
                label: label || labelFromTarget(target),
                dwell: dwell,
                key: displayKey(target)
            };
        }

        /**
         * A usable name when the author did not supply one. PI Vision's URL slug
         * IS the display name with the spaces swapped for dashes, so it reads
         * well: "/Displays/1042/Boiler-Overview" -> "Boiler Overview".
         */
        function labelFromTarget(target) {
            var v = trim(target);
            var h = v.indexOf('#');
            if (h !== -1) { v = v.slice(h + 1); }
            var q = v.indexOf('?');
            if (q !== -1) { v = v.slice(0, q); }
            var parts = v.replace(/\/+$/, '').split('/');
            var last = parts[parts.length - 1] || '';
            if (last && !/^\d+$/.test(last)) {
                return last.replace(/[-_]+/g, ' ');
            }
            return 'Display ' + (last || v);
        }

        // Parsing is cheap, but it happens four times a second forever; cache on
        // the raw text so a steady state costs one string comparison.
        var entryCache = { raw: null, list: [] };

        function parseDisplays(text) {
            var raw = String(text === null || text === undefined ? '' : text);
            if (entryCache.raw === raw) { return entryCache.list; }
            var out = [];
            var lines = raw.split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                var e = parseEntry(lines[i]);
                if (e) { out.push(e); }
            }
            entryCache = { raw: raw, list: out };
            return out;
        }

        /**
         * Reduce anything that identifies a display to a comparable key — the
         * same normalisation pvxNavPanel uses for its active-state highlight,
         * and for the same reason: operators paste full URLs, ids copied from
         * the address bar, and paths, and an exact comparison would never match.
         *
         * "1042", "1042/Boiler-Overview", "/Displays/1042/x" and
         * ".../#/Displays/1042/x?asset=y" all collapse to "1042". The slug is
         * cosmetic and PI Vision regenerates it whenever a display is renamed,
         * so it must not take part in matching.
         */
        function displayKey(s) {
            if (!s) { return ''; }
            var v = trim(s);
            var h = v.indexOf('#');
            if (h !== -1) {
                v = v.slice(h + 1);                       // drop scheme/host
            } else if (/^https?:\/\//i.test(v)) {
                // An external URL with no PI Vision route in it: the whole thing
                // is the identity. Truncating it would make every external link
                // compare equal to every other.
                return v.toLowerCase().replace(/\/+$/, '');
            }
            var q = v.indexOf('?');
            if (q !== -1) { v = v.slice(0, q); }           // drop the query string

            var m = /\/?displays\//i.exec(v);
            if (m) {
                v = v.slice(m.index + m[0].length);
                return v.split('/')[0].toLowerCase();      // the numeric id
            }
            if (v.charAt(0) === '/') { return v.toLowerCase().replace(/\/+$/, ''); }
            return v.split('/')[0].toLowerCase();
        }

        /* ================================================================ *
         * target resolution
         * ================================================================ */

        function entryUrl(entry, cfg) {
            return PVX.nav.url({
                display: entry.target,
                keepTime: cfg.KeepTimeRange !== false,
                keepAsset: !!cfg.KeepAsset
            });
        }

        /** Compare two URLs the way a browser would for "is this a reload?". */
        function sameUrl(a, b) {
            return String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
        }

        /**
         * Is this entry the display we are already looking at?
         *
         * Two independent tests, because either can be true on its own: the list
         * may name the current display a second time under a different spelling
         * (id vs full path), or two different spellings may resolve to the same
         * URL once the carried-over asset and time range are applied. Navigating
         * in either case is a visible reload that fetches everything again and
         * throws away the operator's scroll position for nothing.
         */
        function isCurrentEntry(entry, cfg, curKey) {
            if (entry.key && curKey && entry.key === curKey) { return true; }
            return sameUrl(entryUrl(entry, cfg), PVX.nav.currentUrl());
        }

        /** First entry in `dir` from `from` that is not the current display. */
        function stepIndex(entries, from, dir, cfg, curKey) {
            var n = entries.length;
            if (!n) { return -1; }
            for (var step = 1; step <= n; step++) {
                var i = ((from + dir * step) % n + n) % n;
                if (!isCurrentEntry(entries[i], cfg, curKey)) { return i; }
            }
            return -1;      // every entry in the list is this display
        }

        /* ================================================================ *
         * edit-mode guard
         * ================================================================ *
         * PI Vision exposes the flag on the symbol scope; older releases put it
         * on $root. Probe both. A false negative costs one unwanted navigation
         * in the editor; a false positive would make the symbol dead at runtime,
         * so when neither exists we assume runtime.
         *
         * This is re-read on every tick on purpose. An engineer can drop into
         * edit mode at any moment, and the rotation must stop at that moment —
         * not at the next reload.
         */
        function isEditMode() {
            try {
                if (scope && scope.runtimeData && scope.runtimeData.isEditMode) { return true; }
            } catch (e) { /* scope shape differs by release */ }
            try {
                if (scope && scope.$root && scope.$root.isEditMode) { return true; }
            } catch (e2) { /* ignore */ }
            return false;
        }

        /* ================================================================ *
         * state machine
         * ================================================================ *
         * evaluate() is a pure-ish read: it looks at the config, the URL and the
         * shared pause record, and says what the symbol should be doing. All the
         * decisions live here so the rendering code never has to reason about
         * them and the failure states cannot drift apart from the behaviour.
         */

        function dwellDefault(cfg) {
            var n = PVX.util.num(cfg.DwellSeconds);
            return PVX.util.clamp(Math.round(n === null ? 30 : n), 1, 86400);
        }

        /**
         * Said out loud, because the alternative is a mystery: where session
         * storage is blocked the pause is real but local, so an operator who
         * pauses here and then lets the previous display's timer carry them
         * onward will find the next screen rotating happily.
         */
        function storageNote() {
            return isStorageBlocked()
                ? ' (this browser blocks session storage, so the pause applies to this display only)'
                : '';
        }

        function evaluate(cfg) {
            var entries = parseDisplays(cfg.Displays);
            var cur = PVX.nav.parseHash();
            var curKey = displayKey(cur.path);
            var shared = readState();

            var idx = -1;
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].key && entries[i].key === curKey) { idx = i; break; }
            }

            // Remember where the rotation actually got to. This is what makes
            // StartBehaviour 'nearest' able to pick the thread back up on a
            // display that is not itself in the list.
            if (idx >= 0 && shared.lastIndex !== idx) {
                shared = writeState({ lastIndex: idx });
            }

            var st = {
                entries: entries,
                index: idx,
                curKey: curKey,
                targetIndex: -1,
                target: null,
                dwellMs: (idx >= 0 && entries[idx].dwell ? entries[idx].dwell : dwellDefault(cfg)) * 1000,
                counting: false,
                manualPaused: !!shared.paused,
                state: 'running',
                message: '',
                tone: 'run'
            };

            // Identifies the dwell we are in. When it changes, the countdown is
            // reloaded — that is how a navigation, an edited list or a changed
            // dwell all reset the clock without any special-casing.
            st.cycleKey = cur.path + '\u0000' + idx + '\u0000' + st.dwellMs + '\u0000' + entries.length;

            /* --- where would we go next? --- */
            var behaviour = cfg.StartBehaviour || 'resume';
            var from = idx;
            if (idx < 0) {
                // Off the list. 'nearest' carries on from wherever the rotation
                // got to; everything else starts at entry 1 (from = -1 => 0).
                from = (behaviour === 'nearest' &&
                        shared.lastIndex >= 0 && shared.lastIndex < entries.length)
                    ? shared.lastIndex : -1;
            }
            st.targetIndex = stepIndex(entries, from, 1, cfg, curKey);
            st.target = st.targetIndex >= 0 ? entries[st.targetIndex] : null;

            /* --- what state are we in? highest priority first --- */
            var idleMs = shared.interactAt ? (now() - shared.interactAt) : -1;
            var resumeSecs = PVX.util.num(cfg.ResumeAfterIdleSeconds);
            resumeSecs = resumeSecs === null ? 120 : Math.max(0, Math.round(resumeSecs));
            var idlePaused = cfg.PauseOnInteraction !== false && idleMs >= 0 &&
                             (resumeSecs === 0 || idleMs < resumeSecs * 1000);

            if (cfg.Enabled === false) {
                st.state = 'disabled';
                st.tone = 'off';
                st.message = 'Rotation switched off — turn "Rotate automatically" back on in the config pane.';
            } else if (!entries.length) {
                st.state = 'empty';
                st.tone = 'warn';
                st.message = 'No displays configured. List them one per line in the Displays box in the config pane.';
            } else if (entries.length === 1) {
                st.state = 'single';
                st.tone = 'warn';
                st.message = 'Only one display is configured, so there is nothing to rotate to. Add more lines to the Displays box.';
            } else if (isEditMode()) {
                st.state = 'edit';
                st.tone = 'warn';
                st.message = 'Rotation suspended: this display is being edited.';
            } else if (st.manualPaused) {
                st.state = 'paused';
                st.tone = 'paused';
                st.message = 'Paused by an operator. Press Resume to continue.' + storageNote();
            } else if (idlePaused) {
                st.state = 'idle';
                st.tone = 'paused';
                st.message = (resumeSecs === 0
                    ? 'Paused — someone is using this screen. Press Resume to continue.'
                    : 'Paused — someone is using this screen. Resumes in ' +
                      PVX.fmt.duration(resumeSecs * 1000 - idleMs, { parts: 2 }) + '.') + storageNote();
            } else if (st.targetIndex < 0) {
                // Requirement 4's dead end: every configured entry resolves to
                // the display we are already on.
                st.state = 'deadend';
                st.tone = 'warn';
                st.message = 'Every entry in the list is this display, so there is nowhere to rotate to.';
            } else if (idx < 0) {
                st.state = 'offlist';
                if (behaviour === 'first' || behaviour === 'nearest') {
                    st.counting = true;
                    st.tone = 'run';
                } else {
                    st.tone = 'warn';
                }
            } else {
                st.state = 'running';
                st.counting = true;
            }
            st.behaviour = behaviour;
            return st;
        }

        /* ================================================================ *
         * countdown + navigation
         * ================================================================ */

        /** Advance the countdown by dt and return the current state. */
        function sync(dt) {
            var cfg = ctx.config || {};
            var st = evaluate(cfg);
            if (st.cycleKey !== cycleKey) {
                cycleKey = st.cycleKey;
                remainingMs = st.dwellMs;
            } else if (st.counting && dt > 0) {
                remainingMs -= dt;
            }
            if (remainingMs > st.dwellMs) { remainingMs = st.dwellMs; }
            st.remainingMs = Math.max(0, remainingMs);
            st.fraction = st.dwellMs > 0 ? st.remainingMs / st.dwellMs : 0;
            return st;
        }

        /**
         * Move one entry in `dir`. Used by the timer and by the prev/next
         * buttons, so there is exactly one place that decides where to go and
         * exactly one place that can refuse.
         */
        function advance(st, cfg, dir) {
            // Absolutely never in the editor, whatever asked.
            if (isEditMode()) { return false; }

            var entries = st.entries;
            if (entries.length < 2) { return false; }

            var from = st.index;
            if (from < 0) {
                var shared = readState();
                from = (st.behaviour === 'nearest' &&
                        shared.lastIndex >= 0 && shared.lastIndex < entries.length)
                    ? shared.lastIndex : (dir > 0 ? -1 : 0);
            }
            var i = stepIndex(entries, from, dir, cfg, st.curKey);
            if (i < 0) { return false; }

            var url = entryUrl(entries[i], cfg);
            if (!url || sameUrl(url, PVX.nav.currentUrl())) { return false; }

            // Recorded BEFORE we go: the next document may be a fresh page load
            // and this instance will not exist to record anything afterwards.
            writeState({ lastIndex: i });

            // Reload the countdown first. Normally the page is on its way out,
            // but where the router handles the change in place (or navigation is
            // blocked) this is what stops a jump-per-tick storm.
            remainingMs = st.dwellMs;
            cycleKey = null;

            PVX.nav.go(url, false);
            return true;
        }

        function tick() {
            if (destroyed) { return; }
            var t = now();
            var dt = lastTickMs ? Math.max(0, t - lastTickMs) : 0;
            lastTickMs = t;

            var cfg = ctx.config || {};
            var st = sync(dt);
            if (st.counting && st.remainingMs <= 0) {
                if (advance(st, cfg, 1)) { return; }   // gone; nothing to paint
                st = sync(0);
            }
            paint(st, cfg);
        }

        /* ================================================================ *
         * interaction detection
         * ================================================================ *
         * A display that navigates away while somebody is reading it is worse
         * than no rotation at all, so any activity on the page holds the screen.
         *
         * Listeners go on `document` (a symbol occupies a corner of the screen;
         * activity anywhere counts), are passive (they never call
         * preventDefault, and saying so keeps scrolling smooth), and ignore
         * anything originating inside this symbol — clicking our own Next button
         * is an instruction, not a reason to stop the rotation.
         */
        var lastRecorded = 0;

        function onActivity(ev) {
            if (destroyed) { return; }
            var cfg = ctx.config || {};
            if (cfg.PauseOnInteraction === false) { return; }

            // Our own controls do not count as "somebody is using the screen".
            try {
                if (ev && ev.target && ctx.node && ctx.node.contains &&
                    ctx.node.contains(ev.target)) { return; }
            } catch (e) { /* cross-document target; treat as real activity */ }

            var t = now();
            if (t - lastRecorded < ACTIVITY_THROTTLE_MS) { return; }
            lastRecorded = t;
            writeState({ interactAt: t });
        }

        // Feature-detect passive listener support once. Browsers that do not
        // understand the options object read it as `capture: true`, which would
        // silently change the semantics.
        var passiveOpt = false;
        try {
            var probe = Object.defineProperty({}, 'passive', {
                get: function () { passiveOpt = { passive: true }; return true; }
            });
            window.addEventListener('pvx-probe', null, probe);
            window.removeEventListener('pvx-probe', null, probe);
        } catch (e) { passiveOpt = false; }

        var ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'];

        function bindDocument(cfg) {
            var want = cfg.PauseOnInteraction !== false;
            if (want === docBound) { return; }
            for (var i = 0; i < ACTIVITY_EVENTS.length; i++) {
                if (want) { document.addEventListener(ACTIVITY_EVENTS[i], onActivity, passiveOpt); }
                else { document.removeEventListener(ACTIVITY_EVENTS[i], onActivity, passiveOpt); }
            }
            docBound = want;
        }

        /* ================================================================ *
         * controls
         * ================================================================ */

        function controlFromEvent(ev) {
            var el = ev.target;
            var guard = 0;
            while (el && el !== boundHost && guard < 12) {
                if (el.getAttribute && el.getAttribute('data-pvx-act')) { return el; }
                el = el.parentNode;
                guard += 1;
            }
            return null;
        }

        function onClick(ev) {
            var el = controlFromEvent(ev);
            if (!el) { return; }

            // In the editor a click is how the designer selects the symbol. Do
            // nothing, and deliberately do not stopPropagation.
            if (isEditMode()) { return; }

            var act = el.getAttribute('data-pvx-act');
            var cfg = ctx.config || {};
            var st = sync(0);

            if (act === 'toggle') {
                if (st.manualPaused || st.state === 'idle') {
                    // Resuming clears BOTH pauses. Otherwise pressing Resume
                    // while the idle timer is still running appears to do
                    // nothing, and the operator presses it again, and again.
                    writeState({ paused: false, pausedAt: 0, interactAt: 0 });
                    lastRecorded = 0;
                } else {
                    writeState({ paused: true, pausedAt: now() });
                }
            } else if (act === 'next') {
                advance(st, cfg, 1);
            } else if (act === 'prev') {
                advance(st, cfg, -1);
            }
            paint(sync(0), cfg);
        }

        // Keyboard users must be able to reach controls that only appear on
        // hover, so focus reveals them too. focusin/focusout bubble (focus does
        // not), which is why these and not focus/blur.
        function onFocusIn() { if (ui && ui.host) { addClass(ui.host, 'pvx-ss-focus'); } }
        function onFocusOut() { if (ui && ui.host) { removeClass(ui.host, 'pvx-ss-focus'); } }

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            if (!host || !host.addEventListener) { return; }
            host.addEventListener('click', onClick, false);
            host.addEventListener('focusin', onFocusIn, false);
            host.addEventListener('focusout', onFocusOut, false);
            boundHost = host;
        }

        function unbindHost() {
            if (boundHost && boundHost.removeEventListener) {
                boundHost.removeEventListener('click', onClick, false);
                boundHost.removeEventListener('focusin', onFocusIn, false);
                boundHost.removeEventListener('focusout', onFocusOut, false);
            }
            boundHost = null;
        }

        /**
         * Everything this symbol owns, released. On a kiosk this instance may
         * have run for weeks; a leaked interval or document listener per
         * navigation would eventually be the reason the browser gets slow.
         */
        function teardown() {
            destroyed = true;
            if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
            if (docBound) {
                for (var i = 0; i < ACTIVITY_EVENTS.length; i++) {
                    document.removeEventListener(ACTIVITY_EVENTS[i], onActivity, passiveOpt);
                }
                docBound = false;
            }
            unbindHost();
            ui = null;
            builtSig = null;
        }

        /* ================================================================ *
         * DOM
         * ================================================================ */

        function addClass(el, c) {
            if (!el || (' ' + el.className + ' ').indexOf(' ' + c + ' ') !== -1) { return; }
            el.className = el.className ? el.className + ' ' + c : c;
        }

        function removeClass(el, c) {
            if (!el) { return; }
            el.className = (' ' + el.className + ' ').replace(' ' + c + ' ', ' ').replace(/^\s+|\s+$/g, '');
        }

        function setText(el, s) {
            if (el && el.textContent !== s) { el.textContent = s; }
        }

        function setAttr(el, k, v) {
            if (el && el.getAttribute(k) !== v) { el.setAttribute(k, v); }
        }

        function clearNode(n) {
            while (n && n.firstChild) { n.removeChild(n.firstChild); }
        }

        /**
         * Which parts fit? Below roughly 160x60 the words are unreadable anyway,
         * so drop to the countdown and the position; below 100x40 the countdown
         * alone is the only honest thing to draw.
         */
        function tierFor(w, h) {
            if (w < 100 || h < 40) { return 'tiny'; }
            if (w < 160 || h < 60) { return 'mini'; }
            return 'full';
        }

        function parts(cfg, tier) {
            var showProgress = cfg.ShowProgress !== false;
            var showPos = cfg.ShowPosition !== false;
            var p = {
                tier: tier,
                progress: showProgress,
                // At the smallest size the countdown is the whole symbol; if the
                // author turned it off, show the position rather than nothing.
                position: tier === 'tiny' ? (showPos && !showProgress) : showPos,
                info: tier === 'full',
                label: tier === 'full' && cfg.ShowLabel !== false,
                controls: tier === 'full' && (cfg.ShowControls || 'hover') !== 'never',
                controlMode: cfg.ShowControls || 'hover',
                vertical: cfg.Orientation === 'vertical',
                compact: !!cfg.CompactMode,
                // Tall enough for the status to run to a second line. The
                // failure messages name a config field and say what will happen;
                // truncating one to "...in the Displays box in t…" would defeat
                // the point of writing it.
                roomy: false
            };
            return p;
        }

        function signature(p) {
            return [p.tier, p.progress, p.position, p.info, p.label, p.controls,
                    p.controlMode, p.vertical, p.compact, p.roomy].join('|');
        }

        var SVG_NS = 'http://www.w3.org/2000/svg';

        function svgEl(name, attrs, parent) {
            var e = document.createElementNS(SVG_NS, name);
            for (var k in attrs) {
                if (hasOwn(attrs, k)) { e.setAttribute(k, attrs[k]); }
            }
            if (parent) { parent.appendChild(e); }
            return e;
        }

        // Ring geometry, in viewBox units so it scales with the box.
        var RING_R = 15.5;
        var RING_C = 2 * Math.PI * RING_R;

        function buildRing(host) {
            var wrap = document.createElement('div');
            wrap.className = 'pvx-ss-progress';

            var svg = svgEl('svg', {
                viewBox: '0 0 36 36', 'class': 'pvx-ss-ring',
                focusable: 'false', 'aria-hidden': 'true'
            }, wrap);

            svgEl('circle', {
                'class': 'pvx-ss-track', cx: 18, cy: 18, r: RING_R, fill: 'none', 'stroke-width': 3
            }, svg);

            // -90deg so the countdown starts at 12 o'clock like a clock face.
            var arc = svgEl('circle', {
                'class': 'pvx-ss-arc', cx: 18, cy: 18, r: RING_R, fill: 'none',
                'stroke-width': 3, 'stroke-linecap': 'round',
                'stroke-dasharray': RING_C.toFixed(2),
                'stroke-dashoffset': '0',
                transform: 'rotate(-90 18 18)'
            }, svg);

            var txt = svgEl('text', {
                'class': 'pvx-ss-ringtext', x: 18, y: 18.5,
                'text-anchor': 'middle', 'font-size': '11'
            }, svg);

            // Shown instead of the countdown whenever the clock is not running,
            // so a 90x36 symbol with no room for words still says "not moving".
            var glyph = svgEl('g', { 'class': 'pvx-ss-ringglyph' }, svg);
            svgEl('rect', { x: 14.2, y: 12.5, width: 2.6, height: 11, rx: 1 }, glyph);
            svgEl('rect', { x: 19.2, y: 12.5, width: 2.6, height: 11, rx: 1 }, glyph);

            host.appendChild(wrap);
            return { wrap: wrap, svg: svg, arc: arc, text: txt, glyph: glyph };
        }

        var GLYPHS = {
            prev: 'M10.5 3 L5 8 L10.5 13 Z M4 3 H5.2 V13 H4 Z',
            next: 'M5.5 3 L11 8 L5.5 13 Z M10.8 3 H12 V13 H10.8 Z',
            play: 'M5 3 L12 8 L5 13 Z',
            pause: 'M4.5 3 H7 V13 H4.5 Z M9 3 H11.5 V13 H9 Z'
        };

        function buildButton(act, label, glyph) {
            var b = document.createElement('button');
            b.type = 'button';                       // never submit anything
            b.className = 'pvx-ss-btn';
            b.setAttribute('data-pvx-act', act);
            b.setAttribute('aria-label', label);
            b.title = label;
            var svg = svgEl('svg', { viewBox: '0 0 16 16', 'aria-hidden': 'true', focusable: 'false' }, b);
            var path = svgEl('path', { d: GLYPHS[glyph] }, svg);
            return { el: b, path: path };
        }

        function build(host, p) {
            clearNode(host);
            ui = { host: host };

            if (p.progress) { ui.ring = buildRing(host); }

            if (p.info) {
                var info = document.createElement('div');
                info.className = 'pvx-ss-info';
                if (p.label) {
                    ui.label = document.createElement('div');
                    ui.label.className = 'pvx-ss-label pvx-truncate';
                    info.appendChild(ui.label);
                }
                ui.status = document.createElement('div');
                ui.status.className = 'pvx-ss-status pvx-truncate';
                info.appendChild(ui.status);
                host.appendChild(info);
                ui.info = info;
            }

            if (p.position) {
                ui.pos = document.createElement('div');
                ui.pos.className = 'pvx-ss-pos pvx-num';
                host.appendChild(ui.pos);
            }

            if (p.controls) {
                var bar = document.createElement('div');
                bar.className = 'pvx-ss-controls';
                ui.prev = buildButton('prev', 'Previous display', 'prev');
                ui.toggle = buildButton('toggle', 'Pause rotation', 'pause');
                ui.next = buildButton('next', 'Next display', 'next');
                bar.appendChild(ui.prev.el);
                bar.appendChild(ui.toggle.el);
                bar.appendChild(ui.next.el);
                host.appendChild(bar);
                ui.controls = bar;
            }

            // The whole thing is one named group for a screen reader; the live
            // state is on the buttons, which is where somebody would look for it.
            setAttr(host, 'role', 'group');
            setAttr(host, 'aria-label', 'Display slideshow');
        }

        /* ================================================================ *
         * painting — called four times a second, so it only ever writes what
         * actually changed
         * ================================================================ */

        function positionText(st, tier) {
            var n = st.entries.length;
            // With nothing configured, "0 of 0" beside "Not configured" is noise.
            if (!n) { return tier === 'full' ? '' : '--'; }
            if (st.index < 0) { return tier === 'full' ? '-- of ' + n : '--/' + n; }
            return tier === 'full' ? (st.index + 1) + ' of ' + n : (st.index + 1) + '/' + n;
        }

        /**
         * The bold first line. Normally the name of the display being shown —
         * but when the rotation is not running, the reason belongs in the line
         * somebody's eye lands on first, not buried in the small print.
         */
        function headline(st) {
            switch (st.state) {
                case 'disabled': return 'Rotation off';
                case 'empty':    return 'Not configured';
                case 'single':   return 'Only one display';
                case 'edit':     return 'Edit mode';
                case 'paused':   return 'Paused';
                case 'idle':     return 'Paused';
                case 'deadend':  return 'Nowhere to go';
                case 'offlist':  return 'Not in the rotation';
                default:         return st.index >= 0 ? st.entries[st.index].label : '';
            }
        }

        /**
         * @param {Boolean} withTime include the countdown in words. Suppressed
         *        when the ring is already showing it a centimetre to the left —
         *        the duplicate is what pushes "Next: Turbine Hall" out of a
         *        narrow strip and into an ellipsis.
         */
        function messageFor(st, withTime) {
            if (st.message) { return st.message; }
            var wait = withTime === false ? '' : (' in ' + PVX.fmt.duration(st.remainingMs, { parts: 2 }));
            var name = st.target ? st.target.label : '';
            if (st.state === 'offlist') {
                // The headline already says this display is not in the list, so
                // the sentence spends its width on what happens next instead.
                if (st.behaviour === 'first') {
                    return 'Start behaviour "Go to the first entry": moving to ' + name + wait + '.';
                }
                if (st.behaviour === 'nearest') {
                    return 'Start behaviour "Pick the rotation back up": moving to ' + name + wait + '.';
                }
                return 'Start behaviour "Stay put", so nothing here will move.';
            }
            return 'Next: ' + name + wait;
        }

        function paint(st, cfg) {
            if (!ui || !ui.host) { return; }
            var tier = ui.tier || 'full';

            var running = st.counting;
            var ringHasClock = false;

            if (ui.ring) {
                // Arc shrinks as the dwell runs out. Frozen where it stands when
                // the rotation is not counting, which is the point of pausing.
                var offset = RING_C * (1 - (running ? st.fraction : 1));
                setAttr(ui.ring.arc, 'stroke-dashoffset', offset.toFixed(2));
                setAttr(ui.ring.svg, 'class', 'pvx-ss-ring pvx-ss-tone-' + st.tone);

                ringHasClock = running && (ui.ringPx === undefined || ui.ringPx >= 26);
                setText(ui.ring.text, ringHasClock ? PVX.fmt.duration(st.remainingMs, { parts: 1 }) : '');
                setAttr(ui.ring.glyph, 'display', running ? 'none' : 'inline');
                // The full sentence is always available on hover, whatever size
                // the symbol has been squeezed to.
                setAttr(ui.ring.wrap, 'title', messageFor(st, true));
            }

            if (ui.label) { setText(ui.label, headline(st)); }
            if (ui.status) { setText(ui.status, messageFor(st, !ringHasClock)); }
            if (ui.pos) { setText(ui.pos, positionText(st, tier)); }

            if (ui.toggle) {
                var showPlay = !running;
                setAttr(ui.toggle.path, 'd', showPlay ? GLYPHS.play : GLYPHS.pause);
                var lbl = showPlay ? 'Resume rotation' : 'Pause rotation';
                setAttr(ui.toggle.el, 'aria-label', lbl);
                setAttr(ui.toggle.el, 'aria-pressed', st.manualPaused ? 'true' : 'false');
                ui.toggle.el.title = lbl;

                // A rotation of one, or a list where every entry is this
                // display, has nothing for these to do.
                var movable = st.entries.length > 1 && st.targetIndex >= 0;
                ui.prev.el.disabled = !movable;
                ui.next.el.disabled = !movable;
            }

            if (st.tone === 'paused') { addClass(ui.host, 'pvx-ss-paused'); }
            else { removeClass(ui.host, 'pvx-ss-paused'); }
        }

        /* ================================================================ *
         * render — structure, theme and size; the tick handles the clock
         * ================================================================ */

        function applyVars(c, cfg, t, p) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            var set = function (k, v) { n.style.setProperty(k, v); };

            var accent = cfg.AccentColor || t.status.info;

            set('--pvx-surface', t.surface);
            set('--pvx-ss-text', t.text);
            set('--pvx-ss-muted', t.textMuted);
            set('--pvx-ss-border', t.border);
            set('--pvx-ss-track', t.track);
            set('--pvx-ss-accent', accent);
            set('--pvx-ss-warn', t.status.warning);
            set('--pvx-ss-tint', PVX.color.rgba(accent, 0.16));
            // Backdrop for the floating controls. Derived from the THEME rather
            // than from t.surface, which is the string 'transparent' whenever
            // the author asked for a transparent panel — and controls floating
            // over unreadable text would be the result.
            set('--pvx-ss-ctlbg', t.dark ? 'rgba(30,34,39,0.94)' : 'rgba(255,255,255,0.94)');
            set('--pvx-ss-focus', PVX.color.rgba(accent, 0.55));

            // The ring is the one element worth scaling with the box: on a wall
            // screen the symbol may be 900px wide, and a fixed 24px ring would
            // be invisible from across the control room.
            var avail = p.vertical ? Math.min(c.width, c.height) : c.height;
            var ringPx;
            if (p.tier === 'tiny') {
                // The ring IS the symbol here, so it takes nearly the whole box.
                ringPx = PVX.util.clamp(Math.min(c.width, c.height) - 6, 14, 32);
            } else if (p.tier === 'mini') {
                ringPx = PVX.util.clamp(Math.min(c.width, c.height) - 10, 16, 36);
            } else {
                // A fraction, not a margin: at 55% of the short side the ring
                // reads as an indicator beside the text rather than as the
                // subject of the symbol, at every box size.
                ringPx = PVX.util.clamp(Math.round(avail * (p.compact ? 0.5 : 0.55)), 20, 140);
            }
            set('--pvx-ss-ring', Math.round(ringPx) + 'px');
            if (ui) { ui.ringPx = Math.round(ringPx); }

            // Bounded by the width as well as the height. Two lines of text sit
            // beside the ring, so the height alone would size a 320x80 strip for
            // type it has nowhere near the width to show.
            var labelPx = PVX.util.clamp(
                Math.round(Math.min(c.height / 6, c.width / 22)), 11, p.compact ? 14 : 30);
            set('--pvx-ss-label', labelPx + 'px');
            set('--pvx-ss-status', PVX.util.clamp(Math.round(labelPx * 0.72), 10, 14) + 'px');
        }

        function hostClass(p) {
            return 'pvx-ss-body' +
                ' pvx-ss-tier-' + p.tier +
                (p.vertical ? ' pvx-ss-vertical' : ' pvx-ss-horizontal') +
                (p.compact ? ' pvx-ss-compact' : '') +
                (p.roomy ? ' pvx-ss-roomy' : '') +
                ' pvx-ss-ctl-' + p.controlMode;
        }

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;

            scope.pvx.surface = cfg.Transparent ? 'transparent' : t.surface;

            // Which parts to draw is decided from the box the AUTHOR drew, not
            // from the host: the host is a couple of pixels shorter (the
            // surface's border) and a symbol sized to exactly the documented
            // 160x60 threshold would otherwise fall through to the smaller
            // layout for reasons invisible from the outside. The sizes further
            // down still come from the host, which is the space really there.
            var boxW = c.width, boxH = c.height;
            if (c.node && c.node.clientHeight > 0) {
                boxW = c.node.clientWidth;
                boxH = c.node.clientHeight;
            }
            var tier = tierFor(boxW, boxH);
            var p = parts(cfg, tier);
            p.roomy = tier === 'full' && !p.compact && boxH >= 72;

            // The title is a template binding; it only earns its space when
            // there is space, and CompactMode is the author saying there is not.
            scope.pvx.title = (tier === 'full' && !p.compact && cfg.Title) ? cfg.Title : '';

            if (host) {
                bindHost(host);
                bindDocument(cfg);

                var sig = signature(p);
                if (sig !== builtSig) {
                    // Rebuilding wipes focus, so it happens only when the
                    // structure genuinely changed — never on a timer tick.
                    build(host, p);
                    builtSig = sig;
                }
                ui.tier = tier;
                host.className = hostClass(p);
                applyVars(c, cfg, t, p);
                paint(sync(0), cfg);
            }

            // We wrote scope.pvx fields inside requestAnimationFrame, outside
            // Angular's digest.
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        // One interval for the life of the symbol. Started here rather than on
        // first render so a symbol whose host never links still cannot leak it.
        lastTickMs = now();
        tickTimer = setInterval(tick, TICK_MS);

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
