/* ============================================================================
 * pv-mock.js — an offline stand-in for the PI Vision symbol host
 * ----------------------------------------------------------------------------
 * Reproduces the parts of window.PIVisualization that custom symbols actually
 * touch, plus a synthetic data generator for each DataShape, so the whole
 * library can be developed and reviewed in a browser with no PI Vision server.
 *
 * This file is a DEVELOPMENT TOOL. It is never deployed to the PI Vision
 * server — tools/build.js does not copy anything from dev/.
 * ==========================================================================*/
(function (root) {
    'use strict';

    /* ------------------------------------------------------------------ *
     * The PIVisualization surface used by symbols
     * ------------------------------------------------------------------ */
    var registry = [];

    var PV = {
        Extensibility: {
            Enums: {
                DatasourceBehaviors: { None: 0, Single: 1, Multiple: 2 }
            }
        },

        /** PI Vision's base prototype: supplies no-op lifecycle callbacks. */
        deriveVisualizationFromBase: function (ctor) {
            function Base() { }
            Base.prototype.onDataUpdate = function () { };
            Base.prototype.onConfigChange = function () { };
            Base.prototype.onResize = function () { };
            Base.prototype.onDestroy = function () { };
            Base.prototype.init = function () { };
            ctor.prototype = new Base();
            ctor.prototype.constructor = ctor;
            return ctor;
        },

        symbolCatalog: {
            register: function (definition) {
                registry.push(definition);
            }
        },

        toolCatalog: {
            register: function () { /* tool panes are out of scope for the harness */ }
        }
    };

    root.PIVisualization = PV;

    /* ------------------------------------------------------------------ *
     * Synthetic data
     * ------------------------------------------------------------------ */

    /** Deterministic PRNG so a reload shows the same shapes — easier to diff. */
    function rng(seed) {
        var s = seed >>> 0 || 1;
        return function () {
            s ^= s << 13; s >>>= 0;
            s ^= s >> 17;
            s ^= s << 5; s >>>= 0;
            return (s >>> 0) / 4294967296;
        };
    }

    var TAGS = [
        { name: 'Boiler 1 Steam Flow', units: 'klb/h', base: 118, amp: 22, noise: 3 },
        { name: 'Boiler 2 Steam Flow', units: 'klb/h', base: 96, amp: 30, noise: 5 },
        { name: 'Feedwater Pump A Amps', units: 'A', base: 63, amp: 9, noise: 2 },
        { name: 'Feedwater Pump B Amps', units: 'A', base: 71, amp: 14, noise: 4 },
        { name: 'Condenser Vacuum', units: 'inHg', base: 27, amp: 2.5, noise: 0.4 },
        { name: 'Cooling Tower Basin Temp', units: '°F', base: 84, amp: 7, noise: 1.2 },
        { name: 'Turbine Bearing 3 Vib', units: 'mils', base: 4.2, amp: 2.6, noise: 0.5 },
        { name: 'Turbine Bearing 4 Vib', units: 'mils', base: 8.9, amp: 3.1, noise: 0.8 },
        { name: 'Generator Output', units: 'MW', base: 148, amp: 26, noise: 4 },
        { name: 'Stack NOx', units: 'ppm', base: 41, amp: 18, noise: 6 },
        { name: 'Air Heater DP', units: 'inH2O', base: 5.4, amp: 1.4, noise: 0.3 },
        { name: 'Mill 3 Outlet Temp', units: '°F', base: 152, amp: 12, noise: 3 },
        { name: 'Precip Field 2 Current', units: 'mA', base: 610, amp: 140, noise: 30 },
        { name: 'Demin Water Conductivity', units: 'µS/cm', base: 0.42, amp: 0.3, noise: 0.06 },
        { name: 'Ash Silo Level', units: '%', base: 68, amp: 24, noise: 2 },
        { name: 'FD Fan Inlet Damper', units: '%', base: 55, amp: 20, noise: 3 }
    ];

    /**
     * One value from a tag's signal at time t. Combines a slow sine, a faster
     * ripple and bounded noise so charts show something with real structure
     * rather than a random walk that wanders off scale.
     */
    function signal(tag, tMs, phase, rand) {
        var hours = tMs / 3600000;
        var slow = Math.sin(hours / 3.1 + phase) * tag.amp;
        var fast = Math.sin(hours * 2.7 + phase * 2) * tag.amp * 0.28;
        var noise = (rand() - 0.5) * tag.noise * 2;
        return tag.base + slow + fast + noise;
    }

    /**
     * Digital tags. `dwell` is the mean minutes spent in each state, which is
     * what makes a time-in-state chart look like a real asset rather than a
     * random flicker — a running pump stays running for hours, a fault clears
     * in minutes.
     */
    var STATE_TAGS = [
        { name: 'Boiler Feed Pump A Status', states: [['Running', 240], ['Stopped', 45], ['Fault', 8]] },
        { name: 'Boiler Feed Pump B Status', states: [['Running', 90], ['Stopped', 120], ['Fault', 15]] },
        { name: 'Mill 3 Drive State', states: [['Running', 180], ['Starting', 4], ['Stopped', 60]] },
        { name: 'FD Fan Mode', states: [['Auto', 300], ['Manual', 40]] },
        { name: 'Precipitator Field 2', states: [['Energised', 400], ['De-energised', 30], ['Trip', 6]] },
        { name: 'Ash Conveyor', states: [['Running', 70], ['Stopped', 70], ['Jam', 12]] },
        { name: 'Cooling Water Valve', states: [['Open', 260], ['Throttled', 60], ['Closed', 25]] },
        { name: 'Unit Load Mode', states: [['Base Load', 500], ['Ramping', 45], ['Off Line', 90]] }
    ];

    var Mock = {};

    Mock.tags = TAGS;
    Mock.stateTags = STATE_TAGS;

    /** Current wall clock, overridable so a paused harness stays still. */
    Mock.now = function () { return Date.now(); };

    /**
     * @param {String} shape  Value | Gauge | TimeSeries | Table | Trend
     * @param {Object} opts   {count, points, hours, seed, tick, badIndex}
     */
    Mock.generate = function (shape, opts) {
        opts = opts || {};
        var count = Math.max(1, opts.count || 1);
        var points = Math.max(2, opts.points || 140);
        var hours = opts.hours || 8;
        var tick = opts.tick || 0;
        var now = Mock.now();
        var span = hours * 3600000;
        var rand = rng((opts.seed || 7) + tick);

        var tags = [];
        for (var i = 0; i < count; i++) { tags.push(TAGS[i % TAGS.length]); }

        function latest(tag, i) {
            return signal(tag, now, i * 0.9, rand);
        }

        if (shape === 'Value' || shape === 'Gauge') {
            var tag0 = tags[0];
            var v = latest(tag0, 0);
            var lo = tag0.base - tag0.amp * 1.6;
            var hi = tag0.base + tag0.amp * 1.6;
            var out = {
                Value: round(v, 2),
                Time: new Date(now).toISOString(),
                Label: tag0.name,
                Units: tag0.units,
                Path: '\\\\PISRV01\\' + tag0.name.replace(/\s+/g, '_'),
                IsGood: true
            };
            if (shape === 'Gauge') {
                out.Indicator = clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
                out.StartIndicator = 0;
                out.ValueScaleLabels = [round(lo, 1), round((lo + hi) / 2, 1), round(hi, 1)];
                out.ValueScalePositions = [0, 50, 100];
            }
            return out;
        }

        // Digital tags: emit transitions, not a sample grid. That is what PI
        // Vision's ModeEvents returns, and duration arithmetic depends on it.
        if (shape === 'TimeSeries' && opts.digital) {
            var sData = [];
            for (var ds = 0; ds < count; ds++) {
                var stag = STATE_TAGS[ds % STATE_TAGS.length];
                var events = [];
                var cursor = now - span;
                var si = Math.floor(rand() * stag.states.length);

                // Seed one sample before the window so the first run has a state.
                events.push({ Time: new Date(cursor).toISOString(), Value: stag.states[si][0] });

                var guard = 0;
                while (cursor < now && guard < 400) {
                    var meanMin = stag.states[si][1];
                    // Exponential dwell — memoryless, which is a fair model for
                    // equipment that has no schedule.
                    var dwellMs = -Math.log(1 - rand() * 0.999) * meanMin * 60000;
                    cursor += Math.max(30000, dwellMs);
                    if (cursor >= now) { break; }
                    var next = si;
                    while (next === si && stag.states.length > 1) {
                        next = Math.floor(rand() * stag.states.length);
                    }
                    si = next;
                    events.push({ Time: new Date(cursor).toISOString(), Value: stag.states[si][0] });
                    guard++;
                }

                sData.push({
                    Label: stag.name,
                    Units: '',
                    Path: '\\\\PISRV01\\' + stag.name.replace(/\s+/g, '_'),
                    IsGood: opts.badIndex === ds ? false : true,
                    ErrorDescription: opts.badIndex === ds ? 'No Data' : '',
                    Value: events
                });
            }
            return { Data: sData };
        }

        // A data-health panel shows nothing on healthy data, so a plain numeric
        // feed would "verify" it against its empty state only. This profile
        // breaks some tags in the specific ways the symbol is meant to catch.
        if (shape === 'TimeSeries' && opts.profile === 'health') {
            var hData = [];
            for (var hs = 0; hs < count; hs++) {
                var ht = tags[hs];
                var kind = hs % 6;          // 0 healthy, 1 stale, 2 flat, 3 bad value, 4-5 healthy
                var hv = [];
                var flatFrom = now - 5 * 3600000;
                var flatVal = null;
                for (var hp = 0; hp < points; hp++) {
                    var htm = now - span + (span * hp) / (points - 1);
                    if (kind === 1 && htm > now - 95 * 60000) { break; }
                    var val = round(signal(ht, htm, hs * 0.9, rand), 3);
                    if (kind === 2 && htm >= flatFrom) {
                        if (flatVal === null) { flatVal = val; }
                        val = flatVal;
                    }
                    hv.push({ Time: new Date(htm).toISOString(), Value: val });
                }
                if (kind === 3 && hv.length) {
                    // PI reports a failed read as a system digital state in
                    // place of the number, not as a missing sample.
                    hv[hv.length - 1] = { Time: hv[hv.length - 1].Time, Value: 'I/O Timeout', IsGood: false };
                }
                hData.push({
                    Label: ht.name,
                    Units: ht.units,
                    Path: '\\\\PISRV01\\' + ht.name.replace(/\s+/g, '_'),
                    IsGood: opts.badIndex === hs ? false : true,
                    ErrorDescription: opts.badIndex === hs ? 'Pt Created' : '',
                    Value: hv
                });
            }
            return { Data: hData };
        }

        // A compressor map needs flow and head on compressor scales, and a curve
        // spec arriving as a string attribute — the way a site would keep each
        // machine's map on its AF element so asset swapping changes the map too.
        if (shape === 'TimeSeries' && opts.profile === 'compressor') {
            var cData = [];
            var flowV = [], headV = [];
            var trailFrom = now - 30 * 60000;
            for (var cp = 0; cp < points; cp++) {
                var ctm = now - span + (span * cp) / (points - 1);
                var flow, head;
                if (ctm < trailFrom) {
                    var ph = (ctm - (now - span)) / span;
                    flow = 6100 + Math.sin(ph * 9) * 380;
                    head = 13900 + Math.sin(ph * 9 + 0.6) * 420;
                } else {
                    // The last half hour walks toward the surge line.
                    var f = (ctm - trailFrom) / (now - trailFrom);
                    flow = 5900 - f * 900;
                    head = 14200 + f * 1000;
                }
                flowV.push({ Time: new Date(ctm).toISOString(), Value: round(flow + (rand() - 0.5) * 60, 1) });
                headV.push({ Time: new Date(ctm).toISOString(), Value: round(head + (rand() - 0.5) * 80, 1) });
            }
            cData.push({ Label: 'K-301 Inlet Flow', Units: 'ACFM', Path: '\\\\AF\\K-301|Inlet Flow',
                IsGood: opts.badIndex === 0 ? false : true, Value: flowV });
            cData.push({ Label: 'K-301 Polytropic Head', Units: 'ft', Path: '\\\\AF\\K-301|Polytropic Head',
                IsGood: opts.badIndex === 1 ? false : true,
                ErrorDescription: opts.badIndex === 1 ? 'Calculation failed' : '', Value: headV });
            if (count > 2) {
                cData.push({ Label: 'K-301 Map Curves', Units: '', Path: '\\\\AF\\K-301|Map Curves', IsGood: true,
                    Value: [{ Time: new Date(now - span).toISOString(), Value:
                        'surge: 2400:5000 3000:8000 3500:10800 4100:14600 4700:19000 5000:21500 5400:24500 | ' +
                        '70%: 3000:8000 4500:7600 6000:6600 7000:5200 | ' +
                        '80%: 3500:10800 5500:10200 7000:8800 8200:6800 | ' +
                        '90%: 4100:14600 6200:13900 8000:12000 9400:9200 | ' +
                        '100%: 4700:19000 7000:18100 9000:15800 10500:12200 | ' +
                        '105%: 5000:21500 7400:20500 9500:18000 11000:14200 | ' +
                        'stonewall: 7000:5200 8200:6800 9400:9200 10500:12200 11000:14200' }] });
            }
            for (var cx = 3; cx < count; cx++) {
                var xt = tags[cx];
                cData.push({ Label: xt.name, Units: xt.units, Path: '', IsGood: true,
                    Value: [{ Time: new Date(now).toISOString(), Value: round(xt.base, 2) }] });
            }
            return { Data: cData };
        }

        // A wind rose is meaningless on a generic sine: it needs a direction
        // that wraps through 360 and favours a quarter, and a speed that is
        // higher from that quarter, the way a real met mast reads.
        if (shape === 'TimeSeries' && opts.profile === 'wind') {
            var wData = [];
            var dirV = [], spdV = [];
            for (var wp = 0; wp < points; wp++) {
                var wtm = now - span + (span * wp) / (points - 1);
                var ph2 = (wtm - (now - span)) / span;
                // Mostly south-westerly, swinging round to the north for a spell.
                var prevailing = ph2 > 0.55 && ph2 < 0.72 ? 350 : 225;
                var dir = prevailing + Math.sin(ph2 * 23) * 28 + (rand() - 0.5) * 50;
                dir = ((dir % 360) + 360) % 360;
                var spd = (prevailing === 225 ? 5.2 : 2.6) + Math.sin(ph2 * 11) * 2.4 + (rand() - 0.5) * 2.6;
                dirV.push({ Time: new Date(wtm).toISOString(), Value: round(dir, 1) });
                spdV.push({ Time: new Date(wtm).toISOString(), Value: round(Math.max(0, spd), 2) });
            }
            wData.push({ Label: 'Met Mast Wind Direction', Units: '°', Path: '\\\\AF\\Met Mast|Wind Direction',
                IsGood: opts.badIndex === 0 ? false : true, Value: dirV });
            if (count > 1) {
                wData.push({ Label: 'Met Mast Wind Speed', Units: 'm/s', Path: '\\\\AF\\Met Mast|Wind Speed',
                    IsGood: opts.badIndex === 1 ? false : true,
                    ErrorDescription: opts.badIndex === 1 ? 'I/O Timeout' : '', Value: spdV });
            }
            for (var wx = 2; wx < count; wx++) {
                var wt = tags[wx];
                wData.push({ Label: wt.name, Units: wt.units, Path: '', IsGood: true,
                    Value: [{ Time: new Date(now).toISOString(), Value: round(wt.base, 2) }] });
            }
            return { Data: wData };
        }

        // A control chart on a generic sine is out of control everywhere,
        // which tests nothing. This is a filler in control for most of the
        // window, with one spike past the limits and a sustained shift of
        // about 1.5 sigma over the last fifth: rules 1, 2, 5 and 6 each have
        // something real to find. Sources 2 and 3 are the spec limits as
        // tags, steady, the way a recipe holds them.
        if (shape === 'TimeSeries' && opts.profile === 'spc') {
            var sData = [], fill = [];
            for (var sp = 0; sp < points; sp++) {
                var stm = now - span + (span * sp) / (points - 1);
                var frac = sp / (points - 1);
                // Sum of uniforms: near-normal, sd about 2.0 g, seeded.
                var noise = (rand() + rand() + rand() + rand() - 2) * 3.46;
                var v = 500 + noise + (frac > 0.8 ? 3 : 0) + (sp === Math.round(points * 0.35) ? 9 : 0);
                fill.push({ Time: new Date(stm).toISOString(), Value: round(v, 2) });
            }
            sData.push({ Label: 'Line 3 Fill Weight', Units: 'g', Path: '\\\\AF\\Line 3|Fill Weight',
                IsGood: opts.badIndex === 0 ? false : true, Value: fill });
            var specs = [['Line 3 Fill Weight USL', 510], ['Line 3 Fill Weight LSL', 490]];
            for (var sx2 = 1; sx2 < count; sx2++) {
                var spec = specs[sx2 - 1] || [tags[sx2].name, tags[sx2].base];
                sData.push({ Label: spec[0], Units: 'g', Path: '', IsGood: true,
                    Value: [{ Time: new Date(now - span).toISOString(), Value: spec[1] },
                        { Time: new Date(now).toISOString(), Value: spec[1] }] });
            }
            return { Data: sData };
        }

        // A spectrum of a generic sine shows one line and tests nothing. This
        // is a pressure loop hunting with a 20 minute period, a 7 minute
        // ripple from a recycle, and noise, recorded every 20 seconds or so
        // (unevenly, as exception reporting stores it).
        if (shape === 'TimeSeries' && opts.profile === 'spectrum') {
            var fData = [];
            for (var fs = 0; fs < count; fs++) {
                var fv = [];
                var ft = now - span;
                while (ft <= now) {
                    var ph = (ft - (now - span)) / 60000;
                    var fval = 52 + 4 * Math.sin(2 * Math.PI * ph / 20 + fs) + 1.5 * Math.sin(2 * Math.PI * ph / 7) +
                        (rand() - 0.5) * 1.2;
                    fv.push({ Time: new Date(ft).toISOString(), Value: round(fval, 3) });
                    ft += 15000 + Math.floor(rand() * 10000);
                }
                fData.push({ Label: fs ? tags[fs].name : 'Reactor 2 Pressure', Units: fs ? tags[fs].units : 'kPa',
                    Path: '\\\\AF\\Reactor 2|Pressure', IsGood: opts.badIndex === fs ? false : true, Value: fv });
            }
            return { Data: fData };
        }

        // A Duval triangle on three sines lands anywhere. This is a unit
        // with a thermal fault that is getting hotter and starting to arc:
        // methane falls, ethylene and acetylene rise, so the trail runs from
        // T2 through T3's edge into DT. Readings are a few hours apart, as an
        // online DGA monitor reports, not every plot interval.
        if (shape === 'TimeSeries' && opts.profile === 'dga') {
            var gData = [], gas = [[], [], []];
            var every = Math.max(1, Math.round(points / 30));
            for (var gp = 0; gp < points; gp += every) {
                var gtm = now - span + (span * gp) / (points - 1);
                var gf = gp / (points - 1);
                var wob = (rand() - 0.5) * 6;
                gas[0].push({ Time: new Date(gtm).toISOString(), Value: round(120 - 60 * gf + wob, 1) });
                gas[1].push({ Time: new Date(gtm).toISOString(), Value: round(80 + 60 * gf + wob, 1) });
                gas[2].push({ Time: new Date(gtm).toISOString(), Value: round(Math.max(0, 1 + 40 * gf * gf + wob * 0.3), 1) });
            }
            var gNames = ['Methane (CH4)', 'Ethylene (C2H4)', 'Acetylene (C2H2)'];
            for (var gx = 0; gx < count; gx++) {
                if (gx < 3) {
                    gData.push({ Label: 'T-101 ' + gNames[gx], Units: 'ppm', Path: '\\\\AF\\T-101|' + gNames[gx],
                        IsGood: opts.badIndex === gx ? false : true,
                        ErrorDescription: opts.badIndex === gx ? 'I/O Timeout' : '', Value: gas[gx] });
                } else {
                    gData.push({ Label: tags[gx].name, Units: tags[gx].units, Path: '', IsGood: true,
                        Value: [{ Time: new Date(now).toISOString(), Value: round(tags[gx].base, 2) }] });
                }
            }
            return { Data: gData };
        }

        if (shape === 'TimeSeries') {
            var data = [];
            for (var s = 0; s < count; s++) {
                var tg = tags[s];
                var vals = [];
                for (var p = 0; p < points; p++) {
                    var t = now - span + (span * p) / (points - 1);
                    vals.push({
                        Time: new Date(t).toISOString(),
                        Value: round(signal(tg, t, s * 0.9, rand), 3)
                    });
                }
                data.push({
                    Label: tg.name,
                    Units: tg.units,
                    Path: '\\\\PISRV01\\' + tg.name.replace(/\s+/g, '_'),
                    IsGood: opts.badIndex === s ? false : true,
                    ErrorDescription: opts.badIndex === s ? 'Pt Created' : '',
                    Value: vals
                });
            }
            return { Data: data };
        }

        // An asset table pivots AF attributes into element rows, so it needs
        // AF paths across several elements, a digital attribute among the
        // numbers, and one element short an attribute to show a missing cell.
        if (shape === 'Table' && opts.profile === 'assets') {
            var aRows = [];
            var ATTRS = [
                { name: 'Discharge Pressure', units: 'psig', base: 1040, amp: 140 },
                { name: 'Vibration', units: 'mils', base: 3.1, amp: 2.4 },
                { name: 'Status', units: '' }
            ];
            var STATES = ['Running', 'Running', 'Stopped', 'Running', 'Fault'];
            for (var ar = 0; ar < count; ar++) {
                var unit = Math.floor(ar / ATTRS.length);
                var at = ATTRS[ar % ATTRS.length];
                var el = 'K-' + (301 + unit);
                var av = at.units ? round(at.base + Math.sin(unit * 1.7 + 0.4) * at.amp + (rand() - 0.5) * at.amp * 0.2, 2)
                                  : STATES[unit % STATES.length];
                aRows.push({
                    Label: el + '|' + at.name,
                    Units: at.units,
                    Path: '\\\\AF\\Gathering\\Station ' + (1 + (unit % 2)) + '\\' + el + '|' + at.name,
                    Time: new Date(now).toISOString(),
                    Value: av,
                    IsGood: opts.badIndex === ar ? false : true,
                    ErrorDescription: opts.badIndex === ar ? 'No Data' : '',
                    Summary: [{ Value: av }],
                    Trend: []
                });
            }
            return { Rows: aRows };
        }

        if (shape === 'Table') {
            var rows = [];
            for (var r = 0; r < count; r++) {
                var tr = tags[r];
                var cur = latest(tr, r);
                var mn = cur - Math.abs(tr.amp) * (0.4 + rand() * 0.5);
                var mx = cur + Math.abs(tr.amp) * (0.4 + rand() * 0.5);
                rows.push({
                    Label: tr.name,
                    Units: tr.units,
                    Path: '\\\\PISRV01\\' + tr.name.replace(/\s+/g, '_'),
                    Time: new Date(now).toISOString(),
                    Value: round(cur, 2),
                    IsGood: opts.badIndex === r ? false : true,
                    ErrorDescription: opts.badIndex === r ? 'No Data' : '',
                    Summary: [
                        { Value: round(cur, 2) },
                        { Value: round((mn + mx) / 2, 2) },
                        { Value: round(mn, 2) },
                        { Value: round(mx, 2) },
                        { Value: round(mx - mn, 2) }
                    ],
                    Trend: []
                });
            }
            return { Rows: rows };
        }

        if (shape === 'Trend') {
            var traces = [];
            for (var q = 0; q < count; q++) {
                var tq = tags[q];
                var segs = [];
                for (var k = 0; k < points; k++) {
                    segs.push({
                        X: (k / (points - 1)) * 100,
                        Y: clamp(((signal(tq, now - span + (span * k) / (points - 1), q, rand) - (tq.base - tq.amp * 2)) /
                            (tq.amp * 4)) * 100, 0, 100)
                    });
                }
                traces.push({
                    Label: tq.name, Units: tq.units, Stepped: false,
                    Value: round(latest(tq, q), 2), LineSegments: [segs], ErrorMarkers: []
                });
            }
            return {
                StartTime: new Date(now - span).toISOString(),
                EndTime: new Date(now).toISOString(),
                Traces: traces
            };
        }

        return null;
    };

    /**
     * Updates after the first carry values only, as PI Vision's do: it sends
     * Label, Units and Path on the first update and then only periodically.
     * The mock used to send them every time, which hid a symbol that lost its
     * names between metadata updates. `opts.metadata: 'every'` restores the
     * old behaviour for a caller that wants it.
     */
    var generateFull = Mock.generate;
    Mock.generate = function (shape, opts) {
        var out = generateFull(shape, opts);
        if (!out || !opts || !(opts.tick >= 2) || opts.metadata === 'every') { return out; }
        var strip = function (o) {
            if (o && typeof o === 'object') { delete o.Label; delete o.Units; delete o.Path; }
        };
        var lists = [out.Data, out.Rows, out.Traces];
        var any = false;
        for (var l = 0; l < lists.length; l++) {
            if (!lists[l]) { continue; }
            any = true;
            for (var i = 0; i < lists[l].length; i++) { strip(lists[l][i]); }
        }
        if (!any) { strip(out); }
        return out;
    };

    function round(v, d) { var f = Math.pow(10, d); return Math.round(v * f) / f; }
    function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

    /* ------------------------------------------------------------------ *
     * Harness API
     * ------------------------------------------------------------------ */

    Mock.registry = registry;

    Mock.get = function (typeName) {
        for (var i = 0; i < registry.length; i++) {
            if (registry[i].typeName === typeName) { return registry[i]; }
        }
        return null;
    };

    root.PVMock = Mock;

}(window));
