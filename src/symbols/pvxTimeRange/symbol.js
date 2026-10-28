/* ============================================================================
 * pvxTimeRange — presets, a typed or calendar range, and step back / forward
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector. Like pvxNavPanel this is a control, and it sets the
 * display's time range by the same route, PVX.nav.setTimeRange, a hash change
 * that the browser's Back button undoes.
 *
 * What it adds over the navigation panel's time buttons:
 *   - a From / To pair, either calendar inputs or PI time expressions checked
 *     as they are typed, applied together so a half-typed range never reaches
 *     the display;
 *   - step back and forward by the span of the range in force, and Now, which
 *     keeps the span and ends it at the present;
 *   - a readout of the range in force, resolved to clock times, so "*-8h"
 *     reads as the hours it means.
 *
 * WHY IT RESOLVES PI TIME ITSELF
 *   Stepping needs the range in milliseconds, and the address holds whatever
 *   was typed: "*-8h", "t", "y+6h", an ISO stamp. PVX.nav.parseTime covers
 *   the grammar operators use. An expression it cannot read is still applied
 *   as typed, since PI Vision may accept it, but stepping is switched off and
 *   the readout says why rather than guessing.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxTimeRange',
        displayName: 'PVX Time Range',

        // One ignored data source; DatasourceBehaviors.None would keep the
        // symbol out of PI Vision's selector altogether.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Time Range',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Value',
                Height: 76,
                Width: 640,

                // Same grammar as the navigation panel's time buttons.
                Presets: '1 hour | *-1h | *\n' +
                         '8 hours | *-8h | *\n' +
                         'Today | t | *\n' +
                         'Yesterday | y | t\n' +
                         '7 days | *-7d | *',
                ShowPresets: true,
                PresetStyle: 'buttons',     // buttons | dropdown

                ShowCustom: true,
                CustomInput: 'calendar',    // calendar | text

                ShowStep: true,
                ShowNow: true,
                ShowReadout: true,

                Layout: 'row',              // row | column
                ButtonColor: '#3b82c4',
                ButtonRadius: 4,

                ShowTitle: false,
                Title: ''
            });
        }
    };

    /** PI time strings differ only by whitespace and case surprisingly often. */
    function timeKey(s) {
        return String(s === null || s === undefined ? '' : s).replace(/\s+/g, '').toLowerCase();
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    /** A datetime-local input's value, in the browser's own time zone. */
    function localInput(ms) {
        var d = new Date(ms);
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
            'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    function clock(ms, withYear) {
        var d = new Date(ms);
        return MONTHS[d.getMonth()] + ' ' + d.getDate() + (withYear ? ' ' + d.getFullYear() : '') +
            ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    function spanText(ms) {
        var mins = Math.round(ms / 60000);
        if (mins < 120) { return mins + ' min'; }
        var hours = ms / 3600000;
        if (hours < 72) { return (Math.round(hours * 10) / 10) + ' h'; }
        return (Math.round(hours / 24 * 10) / 10) + ' d';
    }

    function isoOf(ms) { return new Date(ms).toISOString(); }

    /**
     * Presets as "Label | start | end", one per line. A line that is not
     * three parts is reported, not skipped silently.
     */
    function parsePresets(text) {
        var out = { items: [], bad: [] };
        String(text || '').split(/\r?\n/).forEach(function (line, i) {
            var s = line.trim();
            if (!s || s.charAt(0) === '#') { return; }
            var parts = s.split('|').map(function (p) { return p.trim(); });
            if (parts.length < 2 || !parts[0] || !parts[1]) { out.bad.push(i + 1); return; }
            out.items.push({ label: parts[0], start: parts[1], end: parts[2] || '*' });
        });
        return out;
    }

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { title: '', surface: 'transparent' };

        var built = null;           // { sig, presetBtns, select, from, to, apply, back, fwd, now, readout, msg }
        var boundHost = null;
        var lastRangeKey = null;    // the address's range the inputs were last filled from
        var message = '';           // the From / To pair's own complaint, if any
        var timer = null;
        var listener = null;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-trange-body',
            render: render,
            onDestroy: teardown
        });

        /** See pvxNavPanel: a click in the editor selects the symbol. */
        function isEditMode() {
            try { if (scope && scope.runtimeData && scope.runtimeData.isEditMode) { return true; } } catch (e) { /* shape differs */ }
            try { if (scope && scope.$root && scope.$root.isEditMode) { return true; } } catch (e2) { /* ignore */ }
            return false;
        }

        /** The range in force: what the address says, resolved where possible. */
        function current() {
            var p = PVX.nav.parseHash().params;
            var now = Date.now();
            var r = { start: p.starttime || '', end: p.endtime || '', inAddress: !!p.starttime };
            if (!r.inAddress) { return r; }
            if (!r.end) { r.end = '*'; }
            r.s = PVX.nav.parseTime(r.start, now);
            r.e = PVX.nav.parseTime(r.end, now);
            r.ok = r.s !== null && r.e !== null && r.e > r.s;
            return r;
        }

        function apply(start, end) {
            if (isEditMode()) { return; }
            message = '';
            PVX.nav.setTimeRange(start, end);
            ctx.render();
        }

        function step(dir) {
            var r = current();
            if (!r.ok) { return; }
            var span = r.e - r.s;
            var s = r.s + dir * span;
            var e = r.e + dir * span;
            var now = Date.now();
            // Forward stops at the present: past it there is nothing to show,
            // and a range ending within the minute is the live one again.
            if (e >= now - 60000) { apply('*-' + Math.round(span / 1000) + 's', '*'); return; }
            apply(isoOf(s), isoOf(e));
        }

        function toNow() {
            var r = current();
            if (!r.ok) { return; }
            apply('*-' + Math.round((r.e - r.s) / 1000) + 's', '*');
        }

        function readPair() {
            var cfg = ctx.config || {};
            var a = built.from.value;
            var b = built.to.value;
            var now = Date.now();
            if (cfg.CustomInput === 'text') {
                var sa = PVX.nav.parseTime(a, now);
                var sb = PVX.nav.parseTime(b || '*', now);
                if (!a) { return { error: 'Type a start time, for example *-8h.' }; }
                if (sa === null) { return { error: '"' + a + '" is not a time this symbol can read, for example *-8h, t+6h or 2026-10-01 06:00.' }; }
                if (sb === null) { return { error: '"' + b + '" is not a time this symbol can read.' }; }
                if (sb <= sa) { return { error: 'The end is not after the start.' }; }
                return { start: a.trim(), end: (b || '*').trim() };
            }
            var da = a ? new Date(a).getTime() : NaN;
            var db = b ? new Date(b).getTime() : NaN;
            if (isNaN(da) || isNaN(db)) { return { error: 'Pick both a start and an end.' }; }
            if (db <= da) { return { error: 'The end is not after the start.' }; }
            return { start: isoOf(da), end: isoOf(db) };
        }

        function onClick(ev) {
            var t = ev.target;
            while (t && t !== boundHost && !(t.getAttribute && t.getAttribute('data-pvx-act'))) { t = t.parentNode; }
            if (!t || t === boundHost || !built) { return; }
            if (isEditMode()) { return; }
            var act = t.getAttribute('data-pvx-act');
            if (act === 'preset') {
                var it = built.items[parseInt(t.getAttribute('data-pvx-i'), 10)];
                if (it) { apply(it.start, it.end); }
            } else if (act === 'back') { step(-1); }
            else if (act === 'fwd') { step(1); }
            else if (act === 'now') { toNow(); }
            else if (act === 'apply') {
                var pair = readPair();
                if (pair.error) { message = pair.error; ctx.render(); return; }
                apply(pair.start, pair.end);
            }
        }

        function onChange(ev) {
            if (!built || ev.target !== built.select || isEditMode()) { return; }
            var it = built.items[parseInt(built.select.value, 10)];
            if (it) { apply(it.start, it.end); }
        }

        // Live validation of typed expressions, and Enter applies.
        function onInput(ev) {
            if (!built || (ev.target !== built.from && ev.target !== built.to)) { return; }
            var cfg = ctx.config || {};
            if (cfg.CustomInput !== 'text') { message = ''; ctx.render(); return; }
            var r = readPair();
            message = r.error || '';
            ctx.render();
        }

        function onKey(ev) {
            if (!built || (ev.target !== built.from && ev.target !== built.to)) { return; }
            if (ev.key === 'Enter' || ev.keyCode === 13) {
                ev.preventDefault();
                onClick({ target: built.apply });
            }
        }

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            if (!host || !host.addEventListener) { return; }
            host.addEventListener('click', onClick, false);
            host.addEventListener('change', onChange, false);
            host.addEventListener('input', onInput, false);
            host.addEventListener('keydown', onKey, false);
            boundHost = host;
            built = null;
        }

        function unbindHost() {
            if (boundHost && boundHost.removeEventListener) {
                boundHost.removeEventListener('click', onClick, false);
                boundHost.removeEventListener('change', onChange, false);
                boundHost.removeEventListener('input', onInput, false);
                boundHost.removeEventListener('keydown', onKey, false);
            }
            boundHost = null;
        }

        function teardown() {
            if (timer !== null) { clearInterval(timer); timer = null; }
            if (listener) {
                try { window.removeEventListener('hashchange', listener, false); } catch (e) { /* ignore */ }
                listener = null;
            }
            unbindHost();
            built = null;
        }

        /* ---------------------------------------------------------------- *
         * DOM, built only when the shape changes, so typing is never lost
         * ---------------------------------------------------------------- */

        function signature(cfg) {
            return [cfg.Presets, cfg.ShowPresets, cfg.PresetStyle, cfg.ShowCustom, cfg.CustomInput,
                cfg.ShowStep, cfg.ShowNow, cfg.ShowReadout].join('\u0001');
        }

        function el(tag, cls, text) {
            var n = document.createElement(tag);
            if (cls) { n.className = cls; }
            if (text !== undefined) { n.textContent = text; }
            return n;
        }

        function button(cls, text, act, title) {
            var b = el('button', 'pvx-trange-btn ' + cls, text);
            b.type = 'button';
            b.setAttribute('data-pvx-act', act);
            if (title) { b.title = title; b.setAttribute('aria-label', title); }
            return b;
        }

        function build(host, cfg) {
            while (host.firstChild) { host.removeChild(host.firstChild); }
            var parsed = parsePresets(cfg.Presets);
            var b = { sig: signature(cfg), items: parsed.items, bad: parsed.bad, presetBtns: [] };

            var bar = el('div', 'pvx-trange-bar');
            host.appendChild(bar);

            if (cfg.ShowStep !== false) {
                b.back = button('pvx-trange-step', '◀', 'back', 'Step back by the span shown');
                bar.appendChild(b.back);
            }

            if (cfg.ShowPresets !== false && parsed.items.length) {
                var group = el('div', 'pvx-trange-presets');
                if (cfg.PresetStyle === 'dropdown') {
                    b.select = el('select', 'pvx-trange-select');
                    b.select.setAttribute('aria-label', 'Time range');
                    var none = el('option', '', 'Range…');
                    none.value = '';
                    b.select.appendChild(none);
                    parsed.items.forEach(function (it, i) {
                        var o = el('option', '', it.label);
                        o.value = String(i);
                        b.select.appendChild(o);
                    });
                    group.appendChild(b.select);
                } else {
                    parsed.items.forEach(function (it, i) {
                        var pb = button('pvx-trange-preset', it.label, 'preset', it.label + ': ' + it.start + ' to ' + it.end);
                        pb.setAttribute('data-pvx-i', String(i));
                        b.presetBtns.push(pb);
                        group.appendChild(pb);
                    });
                }
                bar.appendChild(group);
            }

            if (cfg.ShowStep !== false) {
                b.fwd = button('pvx-trange-step', '▶', 'fwd', 'Step forward by the span shown');
                bar.appendChild(b.fwd);
            }
            if (cfg.ShowNow !== false) {
                b.now = button('pvx-trange-now', 'Now', 'now', 'Keep the span and end it now');
                bar.appendChild(b.now);
            }

            if (cfg.ShowCustom !== false) {
                var custom = el('div', 'pvx-trange-custom');
                var text = cfg.CustomInput === 'text';
                b.from = el('input', 'pvx-trange-input');
                b.to = el('input', 'pvx-trange-input');
                b.from.type = b.to.type = text ? 'text' : 'datetime-local';
                b.from.setAttribute('aria-label', 'From');
                b.to.setAttribute('aria-label', 'To');
                if (text) { b.from.placeholder = '*-8h'; b.to.placeholder = '*'; }
                custom.appendChild(el('span', 'pvx-trange-lab', 'From'));
                custom.appendChild(b.from);
                custom.appendChild(el('span', 'pvx-trange-lab', 'To'));
                custom.appendChild(b.to);
                b.apply = button('pvx-trange-apply', 'Apply', 'apply', 'Show this range');
                custom.appendChild(b.apply);
                bar.appendChild(custom);
            }

            b.foot = el('div', 'pvx-trange-foot');
            b.readout = el('span', 'pvx-trange-readout pvx-truncate');
            b.msg = el('span', 'pvx-trange-msg pvx-truncate');
            b.msg.setAttribute('role', 'status');
            b.foot.appendChild(b.readout);
            b.foot.appendChild(b.msg);
            host.appendChild(b.foot);
            return b;
        }

        /* ---------------------------------------------------------------- *
         * render
         * ---------------------------------------------------------------- */

        function applyVars(c, cfg, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            var base = cfg.ButtonColor || '#3b82c4';
            var active = PVX.color.mix(base, '#000000', 0.32);
            var set = function (k, v) { n.style.setProperty(k, v); };
            set('--pvx-surface', t.surface);
            set('--pvx-text', t.text);
            set('--pvx-muted', t.textMuted);
            set('--pvx-border', t.border);
            set('--pvx-trange-color', base);
            set('--pvx-trange-on-color', PVX.color.readable(base));
            set('--pvx-trange-active', active);
            set('--pvx-trange-on-active', PVX.color.readable(active));
            set('--pvx-trange-tint', PVX.color.rgba(base, 0.14));
            set('--pvx-trange-warn', PVX.color.status.alarm || '#c8452f');
            var radius = PVX.util.num(cfg.ButtonRadius);
            set('--pvx-trange-radius', PVX.util.clamp(radius === null ? 4 : radius, 0, 40) + 'px');
        }

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;

            scope.pvx.title = cfg.ShowTitle ? (cfg.Title || '') : '';
            scope.pvx.surface = cfg.Transparent ? 'transparent' : t.surface;

            if (host) {
                bindHost(host);
                if (!built || built.sig !== signature(cfg)) {
                    built = build(host, cfg);
                    lastRangeKey = null;
                }
                host.className = 'pvx-trange-body pvx-trange-lay-' + (cfg.Layout === 'column' ? 'column' : 'row');
                applyVars(c, cfg, t);
                update(cfg);
            }

            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        function update(cfg) {
            var r = current();
            var b = built;

            // Which preset is in force, if any.
            var activeIndex = -1;
            if (r.inAddress) {
                for (var i = 0; i < b.items.length; i++) {
                    if (timeKey(b.items[i].start) === timeKey(r.start) && timeKey(b.items[i].end) === timeKey(r.end)) { activeIndex = i; break; }
                }
            }
            b.presetBtns.forEach(function (pb, j) {
                var on = j === activeIndex;
                pb.className = 'pvx-trange-btn pvx-trange-preset' + (on ? ' pvx-trange-on' : '');
                pb.setAttribute('aria-pressed', on ? 'true' : 'false');
            });
            if (b.select) { b.select.value = activeIndex === -1 ? '' : String(activeIndex); }

            var stepNote = !r.inAddress ? 'The display is on its own default range; pick one to step from.' :
                !r.ok ? 'Stepping is off: "' + r.start + '" to "' + r.end + '" is not a range this symbol can read.' : '';
            var atPresent = r.ok && r.e >= Date.now() - 60000;
            [b.back, b.fwd, b.now].forEach(function (btn) {
                if (!btn) { return; }
                var off = !r.ok || (btn === b.fwd && atPresent) || (btn === b.now && atPresent && timeKey(r.end) === '*');
                btn.disabled = off;
                if (off && stepNote) { btn.title = stepNote; }
                else if (btn === b.fwd && atPresent) { btn.title = 'Already showing the present'; }
                else { btn.title = btn === b.back ? 'Step back by the span shown' : btn === b.fwd ? 'Step forward by the span shown' : 'Keep the span and end it now'; }
            });

            // Fill the From / To pair when the address's range changes, unless
            // someone is typing in it.
            var key = r.start + '\u0001' + r.end;
            if (b.from && key !== lastRangeKey) {
                var focused = document.activeElement === b.from || document.activeElement === b.to;
                if (!focused) {
                    if (cfg.CustomInput === 'text') {
                        b.from.value = r.inAddress ? r.start : '';
                        b.to.value = r.inAddress ? r.end : '';
                    } else if (r.ok) {
                        b.from.value = localInput(r.s);
                        b.to.value = localInput(r.e);
                    }
                    lastRangeKey = key;
                }
            }

            var readout = '';
            if (cfg.ShowReadout !== false) {
                if (!r.inAddress) { readout = 'Showing the display’s own range'; }
                else if (r.ok) {
                    var yr = new Date(r.s).getFullYear() !== new Date().getFullYear();
                    readout = clock(r.s, yr) + ' to ' + clock(r.e, yr) + ' (' + spanText(r.e - r.s) + ')';
                    if (activeIndex !== -1) { readout = b.items[activeIndex].label + ': ' + readout; }
                } else { readout = r.start + ' to ' + r.end; }
            }
            var notes = [];
            if (message) { notes.push(message); }
            else if (r.inAddress && !r.ok) { notes.push(stepNote); }
            if (b.bad.length) { notes.push('Preset line' + (b.bad.length > 1 ? 's ' : ' ') + b.bad.join(', ') + ' ignored: each needs Label | start | end.'); }
            if (cfg.ShowPresets !== false && !b.items.length && !b.bad.length) { notes.push('No presets listed.'); }
            b.readout.textContent = readout;
            b.readout.title = readout;
            b.msg.textContent = notes.join(' ');
            b.msg.title = notes.join(' ');
            b.foot.style.display = readout || notes.length ? '' : 'none';
        }

        // The range can change from PI Vision's own time bar, a navigation
        // panel or the Back button; a relative range also moves with the
        // clock, so the readout is refreshed now and then as well.
        listener = function () { ctx.render(); };
        try { window.addEventListener('hashchange', listener, false); } catch (e) { listener = null; }
        timer = setInterval(function () {
            if (ctx.destroyed) { return; }
            var r = current();
            var key = r.start + '\u0001' + r.end;
            if (key !== lastRangeKey || Date.now() % 30000 < 1000) { ctx.render(); }
        }, 1000);

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
