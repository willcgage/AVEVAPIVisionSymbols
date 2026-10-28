/* ============================================================================
 * pvxReplay: "PVX Replay" for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector. Like pvxTimeRange this is a control.
 *
 * Plays a stretch of history back through the whole display: a window of
 * fixed length (an hour, say) slides from the start of the stretch to its
 * end, a step at a time, and every symbol on the display follows it. The
 * trip at 03:12 last night, watched as it built up, on the display the
 * operators already know.
 *
 * HOW. Each step sets the display's time range, by the same route as the
 * navigation panel and pvxTimeRange (PVX.nav.setTimeRange, a hash change).
 * PI Vision then asks the archive for the new range, so a step takes as long
 * as the display takes to load; the shortest step interval is one second for
 * that reason, and a display with many symbols wants more.
 *
 * Nothing is saved: the position lives in the address, so Back undoes a step
 * and a saved display opens live as before. Playback pauses by itself when
 * the time range is changed by anything else (PI Vision's time bar, a
 * navigation button, Back), rather than fighting the person who changed it.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below this the display has not finished loading one range before the
     * next is asked for. */
    var MIN_STEP_SECONDS = 1;
    /* A frame count above this is a slider no hand can place. */
    var MAX_FRAMES = 100000;

    var definition = {
        typeName: 'pvxReplay',
        displayName: 'PVX Replay',
        // One ignored data source; DatasourceBehaviors.None would keep the
        // symbol out of PI Vision's selector altogether.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Replay',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Value',
                Height: 84,
                Width: 560,

                ReplayFrom: '*-1d',         // PI time: where playback starts
                ReplayTo: '*',              // PI time: where it ends
                WindowSpan: '1h',           // how much the display shows at each step
                Step: '10m',                // how far each step moves
                StepSeconds: 3,             // wall-clock seconds between steps
                Loop: false,
                ShowSlider: true,
                ShowReadout: true,
                ButtonColor: '#3b82c4',
                ButtonRadius: 4,
                ShowTitle: false,
                Title: ''
            });
        }
    };

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function clock(ms) {
        var d = new Date(ms);
        return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function timeOnly(ms) {
        var d = new Date(ms);
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function isoOf(ms) { return new Date(ms).toISOString(); }

    /**
     * The frames of a replay: frame i shows [end_i - span, end_i], with
     * end_0 = from + span and each later end one step on, the last clipped to
     * `to` so the stretch's end is always shown. Pure, for the test suite.
     */
    function plan(fromMs, toMs, spanMs, stepMs) {
        if (!(toMs > fromMs) || !(spanMs > 0) || !(stepMs > 0)) { return null; }
        // A window longer than the stretch shows the whole stretch at once.
        var span = Math.min(spanMs, toMs - fromMs);
        var first = fromMs + span;
        var n = Math.floor((toMs - first) / stepMs) + 1;
        var ends = (toMs - (first + (n - 1) * stepMs)) > 0 ? n + 1 : n;
        if (ends > MAX_FRAMES) { return { tooMany: ends }; }
        return {
            from: fromMs, to: toMs, span: span, step: stepMs, count: ends,
            frame: function (i) {
                var e = Math.min(first + i * stepMs, toMs);
                return { start: e - span, end: e };
            }
        };
    }

    symbolVis.plan = plan;

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { title: '', surface: 'transparent' };

        var built = null;
        var boundHost = null;
        var listener = null;
        var timer = null;

        // Playback state. `p` is the plan frozen when Play was pressed, so a
        // relative "*-1d" does not slide under a replay in progress.
        var st = {
            p: null, i: 0, playing: false,
            setKey: null,           // the range this symbol last put in the address
            before: null,           // the range in force when playback began
            message: ''
        };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-replay-body',
            render: render,
            onConfigChange: function () {
                // A changed stretch or step is a new replay.
                stop();
                st.p = null;
                st.i = 0;
            },
            onDestroy: teardown
        });

        function isEditMode() {
            try { if (scope && scope.runtimeData && scope.runtimeData.isEditMode) { return true; } } catch (e) { /* shape differs */ }
            try { if (scope && scope.$root && scope.$root.isEditMode) { return true; } } catch (e2) { /* ignore */ }
            return false;
        }

        function rangeKey() {
            var p = PVX.nav.parseHash().params;
            return String(p.starttime || '') + '\u0001' + String(p.endtime || '');
        }

        /** Resolve the configured stretch now. Returns a plan or {error}. */
        function makePlan(cfg) {
            var now = Date.now();
            var f = PVX.nav.parseTime(cfg.ReplayFrom || '*-1d', now);
            var t = PVX.nav.parseTime(cfg.ReplayTo || '*', now);
            var span = PVX.nav.parseSpan(cfg.WindowSpan || '1h');
            var step = PVX.nav.parseSpan(cfg.Step || '10m');
            if (f === null) { return { error: 'Replay from "' + cfg.ReplayFrom + '" is not a time this symbol can read, for example *-1d or 2026-10-27 06:00.' }; }
            if (t === null) { return { error: 'Replay to "' + cfg.ReplayTo + '" is not a time this symbol can read.' }; }
            if (!(t > f)) { return { error: 'The replay ends before it starts: check Replay from and Replay to.' }; }
            if (t > now) { t = now; }
            if (!(t > f)) { return { error: 'The replay starts in the future.' }; }
            if (span === null) { return { error: 'Window "' + cfg.WindowSpan + '" is not a length of time, for example 1h or 30m.' }; }
            if (step === null) { return { error: 'Step "' + cfg.Step + '" is not a length of time, for example 10m.' }; }
            var p = plan(f, t, span, step);
            if (p && p.tooMany) { return { error: 'That is ' + p.tooMany + ' steps: lengthen Step or shorten the replay.' }; }
            return p;
        }

        function ensurePlan() {
            if (st.p) { return st.p; }
            var p = makePlan(ctx.config || {});
            if (p.error) { st.message = p.error; return null; }
            st.p = p;
            st.i = 0;
            return p;
        }

        function show(i) {
            var p = st.p;
            if (!p) { return; }
            st.i = Math.max(0, Math.min(p.count - 1, i));
            var fr = p.frame(st.i);
            if (st.before === null) { st.before = rangeKey(); }
            PVX.nav.setTimeRange(isoOf(fr.start), isoOf(fr.end));
            st.setKey = rangeKey();
            ctx.render();
        }

        function interval(cfg) {
            var n = PVX.util.num(cfg.StepSeconds);
            return Math.max(MIN_STEP_SECONDS, n === null ? 3 : n) * 1000;
        }

        function tick() {
            timer = null;
            if (!st.playing || ctx.destroyed) { return; }
            var cfg = ctx.config || {};
            if (st.i >= st.p.count - 1) {
                if (cfg.Loop) { show(0); }
                else { stop(); st.message = 'Reached the end of the replay.'; ctx.render(); return; }
            } else {
                show(st.i + 1);
            }
            timer = setTimeout(tick, interval(cfg));
        }

        function play() {
            if (isEditMode()) { return; }
            st.message = '';
            if (!ensurePlan()) { ctx.render(); return; }
            // Play at the end starts over.
            if (st.i >= st.p.count - 1) { st.i = 0; }
            st.playing = true;
            show(st.i);
            if (timer) { clearTimeout(timer); }
            timer = setTimeout(tick, interval(ctx.config || {}));
        }

        function stop() {
            st.playing = false;
            if (timer) { clearTimeout(timer); timer = null; }
        }

        function stepBy(d) {
            if (isEditMode()) { return; }
            stop();
            st.message = '';
            if (!ensurePlan()) { ctx.render(); return; }
            show(st.i + d);
        }

        /** Back to the range in force before the replay, and forget it. */
        function exit() {
            if (isEditMode()) { return; }
            stop();
            var back = st.before;
            st.p = null;
            st.i = 0;
            st.before = null;
            st.setKey = null;
            st.message = '';
            if (back !== null) {
                var parts = back.split('\u0001');
                // An address with no range was the display's own default:
                // leaving it empty again returns to exactly that.
                PVX.nav.setTimeRange(parts[0] || '', parts[1] || '');
            }
            ctx.render();
        }

        function onClick(ev) {
            var t = ev.target;
            while (t && t !== boundHost && !(t.getAttribute && t.getAttribute('data-pvx-act'))) { t = t.parentNode; }
            if (!t || t === boundHost || !built || isEditMode()) { return; }
            var act = t.getAttribute('data-pvx-act');
            if (act === 'play') { if (st.playing) { stop(); ctx.render(); } else { play(); } }
            else if (act === 'back') { stepBy(-1); }
            else if (act === 'fwd') { stepBy(1); }
            else if (act === 'first') { stop(); if (ensurePlan()) { show(0); } else { ctx.render(); } }
            else if (act === 'last') { stop(); if (ensurePlan()) { show(st.p.count - 1); } else { ctx.render(); } }
            else if (act === 'exit') { exit(); }
        }

        // The slider shows the frame while dragged and goes there on release:
        // a range per pixel of drag would queue a load for each.
        function onInput(ev) {
            if (!built || ev.target !== built.slider) { return; }
            if (!ensurePlan()) { return; }
            var fr = st.p.frame(parseInt(built.slider.value, 10) || 0);
            built.readout.textContent = clock(fr.start) + ' – ' + timeOnly(fr.end);
        }

        function onChange(ev) {
            if (!built || ev.target !== built.slider || isEditMode()) { return; }
            stop();
            if (!ensurePlan()) { ctx.render(); return; }
            show(parseInt(built.slider.value, 10) || 0);
        }

        // Space plays and pauses, the arrows step, Home and End jump, when
        // the symbol has the keyboard focus.
        function onKey(ev) {
            if (!built || isEditMode()) { return; }
            if (ev.target === built.slider && /Arrow|Home|End/.test(ev.key || '')) { return; }
            var k = ev.key;
            if (k === ' ' || k === 'Spacebar') { ev.preventDefault(); onClick({ target: built.play }); }
            else if (k === 'ArrowLeft') { ev.preventDefault(); stepBy(-1); }
            else if (k === 'ArrowRight') { ev.preventDefault(); stepBy(1); }
            else if (k === 'Home') { ev.preventDefault(); onClick({ target: built.first }); }
            else if (k === 'End') { ev.preventDefault(); onClick({ target: built.last }); }
        }

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            if (!host || !host.addEventListener) { return; }
            host.addEventListener('click', onClick, false);
            host.addEventListener('input', onInput, false);
            host.addEventListener('change', onChange, false);
            host.addEventListener('keydown', onKey, false);
            boundHost = host;
            built = null;
        }

        function unbindHost() {
            if (boundHost && boundHost.removeEventListener) {
                boundHost.removeEventListener('click', onClick, false);
                boundHost.removeEventListener('input', onInput, false);
                boundHost.removeEventListener('change', onChange, false);
                boundHost.removeEventListener('keydown', onKey, false);
            }
            boundHost = null;
        }

        function teardown() {
            stop();
            if (listener) {
                try { window.removeEventListener('hashchange', listener, false); } catch (e) { /* ignore */ }
                listener = null;
            }
            unbindHost();
            built = null;
        }

        /* ---------------------------------------------------------------- *
         * DOM, built once and updated in place, so a drag is never lost
         * ---------------------------------------------------------------- */

        function el(tag, cls, text) {
            var n = document.createElement(tag);
            if (cls) { n.className = cls; }
            if (text !== undefined) { n.textContent = text; }
            return n;
        }

        function button(cls, text, act, title) {
            var b = el('button', 'pvx-replay-btn ' + cls, text);
            b.type = 'button';
            b.setAttribute('data-pvx-act', act);
            b.title = title;
            b.setAttribute('aria-label', title);
            return b;
        }

        function build(host) {
            while (host.firstChild) { host.removeChild(host.firstChild); }
            var b = {};
            var bar = el('div', 'pvx-replay-bar');
            b.first = button('pvx-replay-small', '⏮', 'first', 'To the start of the replay');
            b.back = button('pvx-replay-small', '◀', 'back', 'One step back');
            b.play = button('pvx-replay-play', '▶', 'play', 'Play');
            b.fwd = button('pvx-replay-small', '▶', 'fwd', 'One step forward');
            b.last = button('pvx-replay-small', '⏭', 'last', 'To the end of the replay');
            b.slider = el('input', 'pvx-replay-slider');
            b.slider.type = 'range';
            b.slider.min = '0';
            b.slider.setAttribute('aria-label', 'Replay position');
            b.exit = button('pvx-replay-exit', 'Exit', 'exit', 'Stop the replay and go back to the range shown before it');
            [b.first, b.back, b.play, b.fwd, b.last, b.slider, b.exit].forEach(function (n) { bar.appendChild(n); });
            host.appendChild(bar);
            b.foot = el('div', 'pvx-replay-foot');
            b.readout = el('span', 'pvx-replay-readout pvx-truncate');
            b.msg = el('span', 'pvx-replay-msg pvx-truncate');
            b.msg.setAttribute('role', 'status');
            b.foot.appendChild(b.readout);
            b.foot.appendChild(b.msg);
            host.appendChild(b.foot);
            host.tabIndex = 0;
            return b;
        }

        function applyVars(c, cfg, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            var base = cfg.ButtonColor || '#3b82c4';
            var set = function (k, v) { n.style.setProperty(k, v); };
            set('--pvx-surface', t.surface);
            set('--pvx-text', t.text);
            set('--pvx-muted', t.textMuted);
            set('--pvx-border', t.border);
            set('--pvx-replay-color', base);
            set('--pvx-replay-on-color', PVX.color.readable(base));
            set('--pvx-replay-tint', PVX.color.rgba(base, 0.14));
            set('--pvx-replay-warn', PVX.color.status.alarm || '#c8452f');
            var radius = PVX.util.num(cfg.ButtonRadius);
            set('--pvx-replay-radius', PVX.util.clamp(radius === null ? 4 : radius, 0, 40) + 'px');
        }

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            scope.pvx.title = cfg.ShowTitle ? (cfg.Title || '') : '';
            scope.pvx.surface = cfg.Transparent ? 'transparent' : t.surface;
            if (host) {
                bindHost(host);
                if (!built) { built = build(host); }
                applyVars(c, cfg, t);
                update(cfg);
            }
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        function update(cfg) {
            var b = built;
            // A plan for the readout before Play: what pressing it would do.
            var p = st.p;
            var preview = p ? null : makePlan(cfg);
            var shown = p || (preview && !preview.error ? preview : null);
            var active = st.before !== null;

            b.play.textContent = st.playing ? '❚❚' : '▶';
            b.play.title = st.playing ? 'Pause' : 'Play';
            b.play.setAttribute('aria-label', b.play.title);
            b.play.setAttribute('aria-pressed', st.playing ? 'true' : 'false');
            var edit = isEditMode();
            [b.first, b.back, b.play, b.fwd, b.last, b.slider].forEach(function (n) { n.disabled = edit || !shown; });
            b.exit.disabled = edit || !active;
            b.slider.style.display = cfg.ShowSlider === false ? 'none' : '';
            if (shown) {
                b.slider.max = String(shown.count - 1);
                if (document.activeElement !== b.slider) { b.slider.value = String(p ? st.i : 0); }
            }

            var readout = '';
            if (cfg.ShowReadout !== false && shown) {
                if (active && p) {
                    var fr = p.frame(st.i);
                    readout = clock(fr.start) + ' – ' + timeOnly(fr.end) + '  ·  step ' + (st.i + 1) + ' of ' + p.count;
                } else {
                    readout = 'Replays ' + clock(shown.from) + ' to ' + clock(shown.to) + ' in ' + shown.count + ' steps';
                }
            }
            var msg = st.message || (preview && preview.error ? preview.error : '');
            if (edit && !msg) { msg = 'Playback is off while the display is being edited.'; }
            b.readout.textContent = readout;
            b.readout.title = readout;
            b.msg.textContent = msg;
            b.msg.title = msg;
            b.foot.style.display = readout || msg ? '' : 'none';
        }

        // Anyone else changing the range takes over: playback pauses, and
        // the replay forgets the range it would have returned to, because
        // that person has now chosen one.
        listener = function () {
            if (st.before !== null && st.setKey !== null && rangeKey() !== st.setKey) {
                var was = st.playing;
                stop();
                st.p = null;
                st.before = null;
                st.setKey = null;
                st.message = was ? 'Paused: the time range was changed elsewhere.' : '';
            }
            ctx.render();
        };
        try { window.addEventListener('hashchange', listener, false); } catch (e) { listener = null; }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
