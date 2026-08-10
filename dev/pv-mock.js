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
