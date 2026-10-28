/* ============================================================================
 * pvxAlarmTone — "PVX Alarm Tone"
 * ----------------------------------------------------------------------------
 * DataShape: Table (Multiple data sources)
 *
 * Sounds a tone when one of its data sources goes into alarm, and keeps
 * sounding until the alarm is silenced, acknowledged or clears. The same
 * threshold bands, digital state map and deadband as the Annunciator and the
 * Exception Banner decide what an alarm is.
 *
 * WHY THE TONE IS MADE, NOT PLAYED
 *   The tone is synthesised with the browser's Web Audio API. There are no
 *   sound files to ship, and so nothing to add to PI Vision's web.config to
 *   let the server hand out audio types, which is what a played file needs.
 *
 * WHY IT NEEDS ONE CLICK
 *   Browsers do not let a page make sound until someone has clicked on it.
 *   The symbol says so and arms on that click; it cannot arm itself when a
 *   display opens, and it does not pretend to.
 *
 * SILENCING
 *   - Silence (the button) quiets this screen for the alarms in force. It is
 *     not an acknowledgement and nobody else hears of it.
 *   - With shared acknowledgement on, an acknowledgement made on an
 *     Annunciator pointed at the same AF attribute silences every screen,
 *     because this symbol reads that record (PVX.ack.store). It only reads.
 *   - An alarm that rises to a worse band sounds again (ResoundOnEscalation).
 *   - An alarm that clears ends its episode; the next one sounds afresh.
 *
 * The episode logic is the pure function symbolVis.advance, tested in Node.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxAlarmTone',
        displayName: 'PVX Alarm Tone',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Alarm Tone',
        // Like the other alarm symbols: no limits, no alarms, and the
        // placeholder bands older displays saved are cleared on load.
        limitsRequired: true,

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                Columns: ['Value'],
                Height: 64,
                Width: 300,

                Thresholds: '',
                StateBands: '',
                SeverityFrom: 'thresholds',   // thresholds | quality
                MinSeverityBand: 1,           // sound from this band up
                Deadband: '',

                Tone: 'beep',                 // beep | twoTone | pulse | chime | siren
                TopBandTone: 'same',          // same, or a tone for the highest band
                Volume: 60,                   // 0-100
                RepeatSeconds: 10,            // 0 = once per alarm
                ResoundOnEscalation: true,
                // Alarms already in force when the sound is switched on.
                SoundStanding: true,

                ShowList: true,
                MaxListed: 3,

                SharedAck: false,
                AckAttributePath: '',
                AckPollSeconds: 15,

                ShowTitle: false,
                Title: ''
            });
        }
    };

    /* ------------------------------------------------------------------ *
     * Tones. Each is a list of notes: [start s, length s, Hz from, Hz to,
     * wave]. Kept short, so a repeat interval of a few seconds still leaves
     * quiet between them.
     * ------------------------------------------------------------------ */
    var TONES = {
        beep: [[0, 0.22, 880, 880, 'square'], [0.36, 0.22, 880, 880, 'square'], [0.72, 0.22, 880, 880, 'square']],
        twoTone: [[0, 0.3, 660, 660, 'square'], [0.32, 0.3, 880, 880, 'square'],
            [0.64, 0.3, 660, 660, 'square'], [0.96, 0.3, 880, 880, 'square']],
        pulse: [[0, 0.09, 1000, 1000, 'square'], [0.15, 0.09, 1000, 1000, 'square'], [0.3, 0.09, 1000, 1000, 'square'],
            [0.45, 0.09, 1000, 1000, 'square'], [0.6, 0.09, 1000, 1000, 'square'], [0.75, 0.09, 1000, 1000, 'square']],
        chime: [[0, 0.7, 1046.5, 1046.5, 'sine'], [0.45, 0.9, 784, 784, 'sine']],
        siren: [[0, 0.6, 600, 1200, 'triangle'], [0.6, 0.6, 1200, 600, 'triangle']]
    };
    var TONE_NAMES = { beep: 'Beep', twoTone: 'Two tone', pulse: 'Pulse', chime: 'Chime', siren: 'Siren' };

    function toneLength(name) {
        var t = TONES[name] || TONES.beep;
        var end = 0;
        for (var i = 0; i < t.length; i++) { end = Math.max(end, t[i][0] + t[i][1]); }
        return end;
    }

    /**
     * One step of every episode, from one data update.
     *
     * @param eps   key -> {sev, start, silenced, soundedSev, fromSeed, pass}
     * @param items [{key, sev (deadband applied, -1 none), inAlarm, known}]
     * @param now   ms
     * @param opts  {resound, standing, armedAt, shared (key -> {at}), seeded, silenceAll}
     * @returns {sounding: [keys], newest}
     */
    symbolVis.advance = function (eps, items, now, opts) {
        opts = opts || {};
        var pass = (eps.__pass || 0) + 1;
        eps.__pass = pass;
        var sounding = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            var e = eps[it.key];
            if (!it.known) {
                // A value that cannot be trusted neither raises nor clears.
                if (e) { e.pass = pass; if (!e.silenced && e.sev >= 0) { sounding.push(it.key); } }
                continue;
            }
            if (!it.inAlarm) {
                if (e) { delete eps[it.key]; }
                continue;
            }
            if (!e) {
                e = eps[it.key] = { sev: it.sev, start: now, silenced: false, soundedSev: it.sev,
                    // In alarm on the first update: begun at a time nobody saw.
                    fromSeed: !opts.seeded, pass: pass };
                // An alarm standing when the sound was switched on sounds only
                // when the site wants standing alarms heard.
                if (e.fromSeed && opts.standing === false) { e.silenced = true; }
            }
            e.pass = pass;
            if (it.sev > e.soundedSev) {
                if (opts.resound !== false) { e.silenced = false; }
                e.soundedSev = it.sev;
            }
            e.sev = it.sev;
            // An acknowledgement made after this episode began, or any for
            // one that was already running, silences it everywhere.
            var a = opts.shared && Object.prototype.hasOwnProperty.call(opts.shared, it.key) ? opts.shared[it.key] : null;
            if (a && typeof a === 'object' && (e.fromSeed || a.at >= e.start)) { e.silenced = true; }
            if (opts.silenceAll) { e.silenced = true; }
            if (!e.silenced) { sounding.push(it.key); }
        }
        // Sources removed from the symbol take their episodes with them.
        for (var k in eps) {
            if (k !== '__pass' && Object.prototype.hasOwnProperty.call(eps, k) && eps[k].pass !== pass) { delete eps[k]; }
        }
        return { sounding: sounding };
    };

    symbolVis.TONES = TONES;

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { title: '', surface: 'transparent' };

        var rawRows = [];
        var eps = {};            // episodes by key
        var sounding = [];       // keys
        var seeded = false;
        var armed = false;
        var audio = null;        // AudioContext
        var nextAt = 0;          // when the tone may play again
        var timer = null;
        var ackStore = null, ackSig = '', sharedMap = {}, sharedErr = null;
        var silenceNext = false;
        var boundHost = null;
        var note = '';
        var lastItems = [];

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-tone-body',
            onData: function (d) {
                rawRows = PVX.data.rows(d, ['Value']);
                evaluate();
            },
            onDestroy: teardown,
            render: render
        });

        function isEditMode() {
            try { if (scope && scope.runtimeData && scope.runtimeData.isEditMode) { return true; } } catch (e) { /* shape differs */ }
            try { if (scope && scope.$root && scope.$root.isEditMode) { return true; } } catch (e2) { /* ignore */ }
            return false;
        }

        function keyOf(row) { return row.path || ('label:' + row.label); }

        function severityOf(row, bands, stateBands) {
            if (stateBands) {
                var hit0 = stateBands[PVX.states.text(row.raw).toLowerCase()];
                if (hit0 !== undefined) { return hit0; }
            }
            if (row.value === null) { return -1; }
            var hit = -1;
            for (var i = 0; i < bands.length; i++) {
                if (row.value >= bands[i].value) { hit = i; } else { break; }
            }
            return hit;
        }

        /** Live rows -> episode items, the same rules as the Annunciator. */
        function evaluate() {
            var cfg = ctx.config || scope.config || {};
            ensureAckStore(cfg);
            var bands = PVX.thresholds.parse(cfg.Thresholds);
            var stateBands = PVX.states.bandMap(cfg.StateBands, bands);
            var byQuality = cfg.SeverityFrom === 'quality';
            var minBand = Math.max(0, parseInt(cfg.MinSeverityBand, 10) || 0);
            var db = PVX.thresholds.parseDeadband(cfg.Deadband);
            var items = [];
            var seen = {};
            for (var i = 0; i < rawRows.length; i++) {
                var r = rawRows[i];
                var base = keyOf(r);
                var dup = seen[base] || 0;
                seen[base] = dup + 1;
                var key = dup ? (base + '#' + dup) : base;
                if (byQuality) {
                    items.push({ key: key, sev: r.good ? -1 : 0, inAlarm: !r.good, known: true, row: r, band: 'Bad quality' });
                    continue;
                }
                var sev = severityOf(r, bands, stateBands);
                var prev = eps[key] ? eps[key].sev : -1;
                if (db && r.good) { sev = PVX.thresholds.hold(r.value, bands, sev, prev, db); }
                items.push({ key: key, sev: sev, inAlarm: sev >= minBand && sev >= 0, known: r.good, row: r,
                    band: sev >= 0 && bands[sev] ? (bands[sev].label || ('Band ' + (sev + 1))) : '',
                    color: sev >= 0 && bands[sev] ? bands[sev].color : '' });
            }
            lastItems = items;
            var res = symbolVis.advance(eps, items, Date.now(), {
                resound: cfg.ResoundOnEscalation !== false,
                standing: cfg.SoundStanding !== false,
                shared: ackStore ? sharedMap : null,
                seeded: seeded,
                silenceAll: silenceNext
            });
            silenceNext = false;
            if (rawRows.length) { seeded = true; }
            var before = sounding.length;
            sounding = res.sounding;
            // A new alarm plays at once, not at the next repeat.
            if (sounding.length > before) { nextAt = 0; }
            var notes = [];
            if (db && db.bad) { notes.push('Deadband "' + cfg.Deadband + '" not read, so none applied'); }
            if (ackStore && sharedErr) {
                notes.push('Shared acknowledgements not read: ' +
                    ((sharedErr.message) || 'PI Web API did not answer') + '. Silence works on this screen only.');
            }
            note = notes.join(' · ');
            tick();
        }

        /* ---- shared acknowledgement, read only -------------------------- */

        function ensureAckStore(cfg) {
            var want = cfg.SharedAck === true;
            var path = String(cfg.AckAttributePath || '').trim();
            var pollMs = Math.round(Math.max(2, Math.min(3600, parseFloat(cfg.AckPollSeconds) || 15)) * 1000);
            var sig = want ? (path + '\n' + pollMs) : '';
            if (sig === ackSig) { return; }
            if (ackStore) { ackStore.destroy(); }
            ackStore = null; sharedMap = {}; sharedErr = null;
            ackSig = sig;
            if (!want) { return; }
            ackStore = PVX.ack.store({ attributePath: path, pollMs: pollMs, user: 'unknown' });
            ackStore.onChange(function (map, err) {
                if (ctx.destroyed) { return; }
                sharedMap = map || {};
                sharedErr = err || null;
                evaluate();
                ctx.render();
            });
            ackStore.start();
        }

        /* ---- sound -------------------------------------------------------- */

        function arm() {
            if (armed) { return true; }
            var AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { note = 'This browser cannot make sound (no Web Audio).'; return false; }
            try {
                audio = audio || new AC();
                if (audio.resume) { audio.resume(); }
            } catch (e) {
                note = 'The browser refused to start sound: ' + (e && e.message ? e.message : e);
                return false;
            }
            armed = true;
            nextAt = 0;
            if (!timer) { timer = setInterval(tick, 500); }
            return true;
        }

        function disarm() {
            armed = false;
            if (timer) { clearInterval(timer); timer = null; }
            if (audio && audio.close) { try { audio.close(); } catch (e) { /* already closed */ } }
            audio = null;
        }

        function play(name, cfg) {
            if (!audio) { return; }
            var notes = TONES[name] || TONES.beep;
            var vol = Math.max(0, Math.min(100, parseFloat(cfg.Volume))) / 100;
            if (!(vol > 0)) { return; }
            var t0 = audio.currentTime + 0.02;
            for (var i = 0; i < notes.length; i++) {
                var n = notes[i];
                var osc = audio.createOscillator();
                var g = audio.createGain();
                osc.type = n[4];
                osc.frequency.setValueAtTime(n[2], t0 + n[0]);
                if (n[3] !== n[2]) { osc.frequency.linearRampToValueAtTime(n[3], t0 + n[0] + n[1]); }
                // Square waves are loud for their level; a soft attack and
                // release keep the edges from clicking.
                var peak = vol * (n[4] === 'square' ? 0.18 : 0.45);
                g.gain.setValueAtTime(0.0001, t0 + n[0]);
                g.gain.linearRampToValueAtTime(peak, t0 + n[0] + 0.01);
                if (n[4] === 'sine') {
                    g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[0] + n[1]);
                } else {
                    g.gain.setValueAtTime(peak, t0 + n[0] + n[1] - 0.02);
                    g.gain.linearRampToValueAtTime(0.0001, t0 + n[0] + n[1]);
                }
                osc.connect(g);
                g.connect(audio.destination);
                osc.start(t0 + n[0]);
                osc.stop(t0 + n[0] + n[1] + 0.02);
            }
        }

        /** Which tone: the top band may have its own. */
        function toneFor(cfg) {
            var tone = TONES[cfg.Tone] ? cfg.Tone : 'beep';
            if (cfg.TopBandTone && cfg.TopBandTone !== 'same' && TONES[cfg.TopBandTone]) {
                var top = PVX.thresholds.parse(cfg.Thresholds).length - 1;
                for (var i = 0; i < sounding.length; i++) {
                    var e = eps[sounding[i]];
                    if (e && top > 0 && e.sev === top) { return cfg.TopBandTone; }
                }
            }
            return tone;
        }

        function tick() {
            if (ctx.destroyed || !armed || isEditMode() || !sounding.length) { return; }
            var now = Date.now();
            if (now < nextAt) { return; }
            var cfg = ctx.config || {};
            var name = toneFor(cfg);
            play(name, cfg);
            var rep = parseFloat(cfg.RepeatSeconds);
            nextAt = rep > 0 ? now + Math.max(toneLength(name) * 1000 + 500, rep * 1000) : Infinity;
        }

        /* ---- render -------------------------------------------------------- */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            scope.pvx.title = cfg.Title || '';
            scope.pvx.surface = cfg.Transparent ? 'transparent' : t.surface;
            scope.pvx.note = note;
            ensureAckStore(cfg);
            var n = c.node;
            if (n && n.style && n.style.setProperty) {
                n.style.setProperty('--pvx-surface', cfg.Transparent ? 'transparent' : t.surface);
                n.style.setProperty('--pvx-text', t.text);
                n.style.setProperty('--pvx-muted', t.textMuted);
            }
            if (host) {
                bindHost(host);
                while (host.firstChild) { host.removeChild(host.firstChild); }
                var bands = PVX.thresholds.parse(cfg.Thresholds);
                var noLimits = cfg.SeverityFrom !== 'quality' && !bands.length;
                var state, text, sub = '';
                var inAlarm = 0;
                for (var i = 0; i < lastItems.length; i++) { if (eps[lastItems[i].key]) { inAlarm += 1; } }
                if (noLimits) {
                    state = 'nolimits';
                    text = 'No limits set, so nothing can sound';
                    sub = 'Add threshold bands in Format.';
                } else if (!armed) {
                    state = 'off';
                    text = 'Click to turn alarm sound on';
                    sub = 'Browsers need one click before a page may make sound.';
                } else if (sounding.length) {
                    state = 'sounding';
                    text = sounding.length === 1 ? '1 alarm sounding' : sounding.length + ' alarms sounding';
                    sub = 'Click to silence on this screen';
                } else if (inAlarm) {
                    state = 'silenced';
                    text = 'Silenced';
                    sub = inAlarm + ' in alarm';
                } else {
                    state = 'armed';
                    text = 'Alarm sound on';
                    sub = 'All quiet · click to hear the tone';
                }
                var accent = state === 'sounding' ? PVX.color.status.alarm
                    : state === 'silenced' ? PVX.color.status.warning
                    : state === 'armed' ? PVX.color.status.normal : t.textMuted;

                var btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'pvx-tone-btn pvx-tone-' + state;
                btn.setAttribute('data-pvx-act', 'main');
                btn.style.borderColor = PVX.color.rgba(accent, 0.6);
                btn.style.background = PVX.color.rgba(accent, t.dark ? 0.2 : 0.1);
                btn.style.color = t.text;
                if (state === 'nolimits') { btn.disabled = true; }

                btn.appendChild(speaker(accent, state === 'off' || state === 'nolimits'));

                var words = document.createElement('span');
                words.className = 'pvx-tone-words';
                var main = document.createElement('span');
                main.className = 'pvx-tone-main pvx-truncate';
                main.textContent = text;
                words.appendChild(main);
                if (sub) {
                    var s2 = document.createElement('span');
                    s2.className = 'pvx-tone-sub pvx-truncate';
                    s2.textContent = sub;
                    words.appendChild(s2);
                }
                btn.appendChild(words);
                host.appendChild(btn);

                if (armed) {
                    var off = document.createElement('button');
                    off.type = 'button';
                    off.className = 'pvx-tone-off';
                    off.setAttribute('data-pvx-act', 'off');
                    off.setAttribute('title', 'Turn alarm sound off on this screen');
                    off.textContent = '×';
                    off.style.color = t.textMuted;
                    host.appendChild(off);
                }

                if (cfg.ShowList && state === 'sounding') {
                    var max = Math.max(1, parseInt(cfg.MaxListed, 10) || 3);
                    var list = document.createElement('div');
                    list.className = 'pvx-tone-list pvx-truncate';
                    var names = [];
                    for (var j = 0; j < lastItems.length && names.length < max; j++) {
                        if (sounding.indexOf(lastItems[j].key) !== -1) {
                            names.push(lastItems[j].row.label + (lastItems[j].band ? ' (' + lastItems[j].band + ')' : ''));
                        }
                    }
                    list.textContent = names.join(', ') + (sounding.length > names.length ? ', +' + (sounding.length - names.length) : '');
                    host.appendChild(list);
                }
            }
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        /** A speaker, with sound waves or a cross. Drawn, so it takes the state's color. */
        function speaker(col, muted) {
            var NS = 'http://www.w3.org/2000/svg';
            var svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('class', 'pvx-tone-icon');
            var body = document.createElementNS(NS, 'path');
            body.setAttribute('d', 'M3 9h4l5-4v14l-5-4H3z');
            body.setAttribute('fill', col);
            svg.appendChild(body);
            var mark = document.createElementNS(NS, 'path');
            mark.setAttribute('d', muted ? 'M16 9l5 6M21 9l-5 6' : 'M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13');
            mark.setAttribute('fill', 'none');
            mark.setAttribute('stroke', col);
            mark.setAttribute('stroke-width', '2');
            mark.setAttribute('stroke-linecap', 'round');
            svg.appendChild(mark);
            return svg;
        }

        /* ---- interaction ------------------------------------------------- */

        function bindHost(host) {
            if (boundHost === host) { return; }
            if (boundHost) { boundHost.removeEventListener('click', onClick, false); }
            host.addEventListener('click', onClick, false);
            boundHost = host;
        }

        function onClick(ev) {
            if (isEditMode()) { return; }
            var el = ev.target;
            while (el && el !== boundHost && !(el.getAttribute && el.getAttribute('data-pvx-act'))) { el = el.parentNode; }
            var act = el && el.getAttribute ? el.getAttribute('data-pvx-act') : '';
            var cfg = ctx.config || {};
            if (act === 'off') {
                disarm();
            } else if (act === 'main') {
                if (!armed) {
                    arm();
                    tick();
                } else if (sounding.length) {
                    silenceNext = true;
                    evaluate();
                } else {
                    play(TONES[cfg.Tone] ? cfg.Tone : 'beep', cfg);
                }
            }
            ctx.render();
        }

        function teardown() {
            disarm();
            if (ackStore) { ackStore.destroy(); }
            ackStore = null;
            if (boundHost) { boundHost.removeEventListener('click', onClick, false); }
            boundHost = null;
            eps = {};
            sounding = [];
        }

        return ctx;
    };

    symbolVis.TONE_NAMES = TONE_NAMES;

    window.PVX.register(PV, definition);

}(window.PIVisualization));
