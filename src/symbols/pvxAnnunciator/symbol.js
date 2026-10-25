/* ============================================================================
 * pvxAnnunciator — "PVX Annunciator"
 * ----------------------------------------------------------------------------
 * DataShape: Table (Multiple data sources)
 *
 * A LATCHING alarm panel, in the tradition of a hardwired control-room
 * annunciator.
 *
 * WHY THIS EXISTS
 * ---------------
 * pvxStatusGrid and pvxAlarmBanner both render CURRENT state. That is the right
 * answer for "what is happening now", and the wrong answer for "what happened".
 * PI Vision polls; an excursion that starts and clears between two polls simply
 * never appears. A latching tile catches that excursion and HOLDS it until a
 * human acknowledges it — which is exactly the ISA-18.2 "ringback" idea.
 *
 * THE STATE MACHINE (per point)
 *   NORMAL      in limits, nothing outstanding
 *   ALARM_NEW   out of limits, unacknowledged          -> fast flash
 *   ALARM_ACK   out of limits, acknowledged            -> steady + tick
 *   RETURNED    back in limits, never acknowledged     -> slow flash (ringback)
 *
 *   NORMAL    -> ALARM_NEW   on excursion
 *   ALARM_NEW -> ALARM_ACK   on acknowledge
 *   ALARM_NEW -> RETURNED    value returns before acknowledgement
 *   ALARM_ACK -> NORMAL      value returns
 *   RETURNED  -> NORMAL      on acknowledge          (never clears by itself)
 *   RETURNED  -> ALARM_NEW   it goes out again
 *
 * HONEST SCOPE — read this before wiring it into an operations procedure:
 * By default the latch and the acknowledgement live in a plain JavaScript map
 * inside THIS browser tab. They are SESSION-SCOPED and PER-BROWSER: reopening
 * or refreshing the display resets every tile to whatever the current values
 * say, and an acknowledgement made by one operator is invisible to another
 * operator looking at the same display on another screen.
 *
 * SharedAck lifts that, at the cost of a dependency: PVX.ack.store keeps a
 * small JSON map in an AF String attribute over PI Web API, so every screen
 * pointed at the same attribute sees the same acknowledgements and they
 * survive a reload. It is OFF by default because it needs an attribute a site
 * has to provision and a PI Web API a site has to configure — a default that
 * cannot work on a fresh install is not a default.
 *
 * What shared mode does NOT buy is a transaction. PI Web API has no
 * compare-and-swap; the store mitigates that with read-merge-write-verify and
 * says so when it loses (see the concurrency note above PVX.ack in pvx-core).
 * This symbol's job is to never let an operator BELIEVE an acknowledgement
 * reached the crew when it did not: any store error puts a plain-language
 * banner across the panel, acknowledgement falls back to the session latch so
 * the panel stays usable, and the banner says that is what is happening.
 * The config pane says the same things, so nobody has to read this file to
 * find them out.
 *
 * RENDERING
 * Tiles are built imperatively into `.pvx-ann-body` rather than with ng-repeat,
 * for the same reason as the sibling list symbols: PI Vision pushes a full data
 * update on every poll, and an ng-repeat over live rows costs a watcher per tile
 * per digest. Every data-derived string goes in through textContent, so a PI tag
 * name can never be interpreted as markup.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxAnnunciator',
        displayName: 'PVX Annunciator',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // One symbol already shows a whole panel of points; repeating it per
        // collection element would multiply panels, not populate one.
        supportsCollections: false,
        configTitle: 'Format Annunciator',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                // PI Vision's own summary-column list. The symbol's tile column
                // count lives in `ColumnsCount` precisely so it cannot collide
                // with this key.
                Columns: ['Value'],
                Height: 220,
                Width: 480,

                Title: 'Annunciator',
                ShowLabel: true,

                // Layout
                TileMinWidth: 150,
                TileHeight: 0,           // 0 => share the available height evenly
                ColumnsCount: 0,         // 0 => auto from TileMinWidth
                MaxTiles: 24,

                // What counts as an excursion
                SeverityFrom: 'thresholds',   // thresholds | quality
                MinSeverityBand: 1,

                // Tile content
                ShowValue: true,
                ShowUnits: true,
                ShowStateText: true,
                ShowDuration: true,
                DurationMode: 'inState',      // inState | sinceFirstAlarm

                // Motion
                FlashFast: 600,               // ms per cycle, ALARM_NEW
                FlashSlow: 1600,              // ms per cycle, RETURNED
                EnableFlash: true,

                // Acknowledgement
                AckMode: 'click',             // click | button | both | none
                AckAllLabel: 'ACK ALL',

                /* -- shared acknowledgement ------------------------------------ *
                 * Off by default: it needs a PI Web API this display can reach
                 * AND a String attribute provisioned in AF to hold the map, so
                 * turning it on by default would break every fresh install. */
                SharedAck: false,
                // e.g. \\AFSERVER01\Production\Control Room|Annunciator Ack
                AckAttributePath: '',
                AckPollSeconds: 15,           // how fast other operators appear
                // Blank means "unknown". A browser cannot know the PI Vision
                // user, and a WRONG name on an acknowledgement is worse than no
                // name — so nothing is ever invented here.
                AckUser: '',
                ShowAckAttribution: true,

                // Header
                ShowSummaryBar: true,

                // First-out
                ShowFirstOut: true,
                FirstOutWindow: 30,           // seconds

                // Colours
                NormalColor: '#2f9e5f',
                AckColor: '#d99024',
                ReturnedColor: '#3b82c4',
                DimNormal: true,

                /* -- deployment ------------------------------------------------ *
                 * Normally blank: the base URL belongs in ext/libraries/pvx/pvx-config.js
                 * where one site setting serves every symbol. Same testing escape
                 * hatch as pvxEventGantt, and the same caveat — PVX.api is one
                 * shared client, so this moves the base URL for the whole page. */
                BaseUrlOverride: ''
            });
        }
    };

    /* Tile states. Strings rather than numbers so a debugger session and the
     * data-attribute on the tile both read as English. */
    var ST_NORMAL = 'NORMAL';
    var ST_NEW = 'ALARM_NEW';
    var ST_ACK = 'ALARM_ACK';
    var ST_RETURNED = 'RETURNED';

    /* How often the duration text re-stamps itself with no new data. A point can
     * sit in alarm for an hour without its value changing. */
    var CLOCK_MS = 1000;

    /* Smallest tile we will ever lay out. Below this the text is unreadable, so
     * the body scrolls instead of shrinking further. */
    var MIN_TILE_H = 26;

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the header binds to Angular; the tiles are hand-built.
        scope.pvx = {
            title: '',
            surface: 'transparent',
            counts: [],
            showHeader: false,
            showAckAll: false,
            ackAllLabel: 'ACK ALL',
            ackAllTip: '',
            ackBtn: {},
            // The shared-acknowledgement honesty banner. Empty string = nothing
            // is wrong, and the strip is not in the DOM at all.
            notice: '',
            noticeTip: '',
            noticeStyle: {},
            ackAll: function () { ackAll(); }
        };

        var rawRows = [];       // last payload, normalised
        var view = [];          // tiles currently drawn, in draw order
        var tiles = [];         // pooled tile node records, index-aligned with view
        var durNodes = [];      // [{node, since}] rewritten in place by the clock
        var attrNodes = [];     // [{node, at, by}] attribution, same clock
        var clockTimer = null;
        var boundHost = null;
        var lastMore = -1;      // overflow count last laid out, so the pool knows

        /* ------------------------------------------------------------------ *
         * The latch
         * ------------------------------------------------------------------ *
         * key -> {state, sev, peakSev, since, firstAlarmAt, firstOut, pass}
         * `since` is when the tile entered its CURRENT state; `firstAlarmAt` is
         * when the current episode began (it survives an acknowledgement, which
         * is what DurationMode 'sinceFirstAlarm' reports).
         */
        var states = {};
        var pass = 0;           // bumped per model build, used for pruning
        var seeded = false;     // has a populated payload landed yet?
        var cascadeStart = 0;   // when the current first-out window opened

        /* Shared phase origin for every flashing tile. See applyFlash(). */
        var EPOCH = Date.now();

        /* ------------------------------------------------------------------ *
         * Shared acknowledgement (optional — SharedAck)
         * ------------------------------------------------------------------ *
         * `ackStore` is a PVX.ack.store, or null when the feature is off. It
         * owns the AF attribute, the poll timer and the read-merge-write-verify
         * dance; this symbol only reads its map, asks it to acknowledge, and
         * reports its errors. `ackSig` is the config the live store was built
         * from, so a store is rebuilt when — and only when — one of the three
         * things it was constructed with actually changes.
         */
        var ackStore = null;
        var ackSig = '';
        var sharedMap = {};     // key -> {at, by, st}, as last seen by the store
        var sharedErr = null;   // the store's last error, or null when healthy

        /* Acknowledgements made AT THIS SCREEN that never reached the server.
         *   {err: <pvxError>, keys: {key: true}}
         *
         * This exists because the store's own error is transient: the next
         * successful poll clears it, and the tile is still showing a tick from
         * the session latch. That combination is the exact failure this feature
         * has to engineer against — an operator who believes the crew can see
         * their acknowledgement when nobody can. So a failed write is recorded
         * HERE, stays on the banner until a later attempt actually lands, and
         * makes the tile clickable again so "acknowledge again" is advice the
         * operator can follow.
         */
        var ackFailed = null;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-ann-body',

            onData: function (d) {
                rawRows = PVX.data.rows(d, ['Value']);
            },

            render: render,

            onDestroy: teardown
        });

        /* ================================================================== *
         * Severity
         * ================================================================== *
         * Severity is the index of the matching band in the parsed threshold
         * spec. The spec is sorted ascending by lower bound, so a higher index
         * is unambiguously worse without the author having to label anything.
         * -1 means "matched no band" — below the lowest bound, or non-numeric.
         */

        function bandsFor(cfg) {
            return cfg.UseThresholds === false ? [] : PVX.thresholds.parse(cfg.Thresholds);
        }

        function severityOf(row, bands) {
            if (row.value === null) { return -1; }
            var hit = -1;
            for (var i = 0; i < bands.length; i++) {
                if (row.value >= bands[i].value) { hit = i; } else { break; }
            }
            return hit;
        }

        function bandLabel(bands, sev) {
            var b = bands[sev];
            if (!b) { return ''; }
            return b.label || ('Band ' + (sev + 1));
        }

        /**
         * Stable identity for a point.
         *
         * Path is the right key — labels repeat across assets — but some
         * element-relative displays deliver a BLANK path. Without the label
         * fallback every such row would collapse onto the key "" and the whole
         * panel would share one latch.
         */
        function keyOf(row) {
            return row.path || ('label:' + row.label);
        }

        /* ================================================================== *
         * State machine
         * ================================================================== */

        function newEntry(now) {
            return {
                state: ST_NORMAL,
                sev: -1,
                peakSev: -1,
                since: now,
                firstAlarmAt: null,
                firstOut: false,
                // Was this episode already under way when the display opened?
                // Only sharedEntryFor() cares — see the comment there.
                fromSeed: false,
                pass: pass
            };
        }

        function setState(e, next, now) {
            e.state = next;
            e.since = now;
            if (next === ST_NORMAL) {
                // A closed episode leaves nothing behind: no band, no first-out
                // marker, no alarm start. The next excursion is a new episode.
                e.sev = -1;
                e.peakSev = -1;
                e.firstAlarmAt = null;
                e.firstOut = false;
                e.fromSeed = false;
            }
        }

        /** NORMAL/RETURNED -> ALARM_NEW. */
        function raise(e, sev, now, cfg) {
            setState(e, ST_NEW, now);
            e.sev = sev;
            e.peakSev = sev;
            e.firstAlarmAt = now;
            // `seeded` is still false while the FIRST populated payload is being
            // processed, so an episode that was already running when the display
            // opened is marked here and nowhere else.
            e.fromSeed = !seeded;
            markFirstOut(e, now, cfg);
        }

        /**
         * Advance one point by one poll.
         * Deliberately mirrors the transition table in the file header exactly —
         * note what is NOT here: an acknowledged alarm that escalates to a worse
         * band stays ALARM_ACK and merely re-colours. Re-flashing it would
         * silently un-acknowledge an alarm the operator already accepted, and
         * the machine we published does not do that.
         */
        function step(e, inAlarm, sev, now, cfg) {
            if (e.state === ST_NEW) {
                if (!inAlarm) {
                    setState(e, ST_RETURNED, now);
                } else {
                    e.sev = sev;
                    if (sev > e.peakSev) { e.peakSev = sev; }
                }
            } else if (e.state === ST_ACK) {
                if (!inAlarm) {
                    setState(e, ST_NORMAL, now);
                } else {
                    e.sev = sev;
                    if (sev > e.peakSev) { e.peakSev = sev; }
                }
            } else if (e.state === ST_RETURNED) {
                if (inAlarm) { raise(e, sev, now, cfg); }
                // else: stays RETURNED. This is the whole point of the symbol —
                // a ringback tile must never clear itself.
            } else {
                if (inAlarm) { raise(e, sev, now, cfg); }
            }
        }

        /* ---- first-out ---------------------------------------------------- *
         * In a cascade the tile that went first is the one that tells you what
         * actually happened; the rest are consequences. The first alarm to
         * arrive opens a window, and every alarm inside that window is a
         * consequence. The window closes when it expires OR when the marked tile
         * returns to NORMAL (setState clears the flag), so the next event gets
         * its own marker.
         */

        function anyFirstOut() {
            for (var k in states) {
                if (Object.prototype.hasOwnProperty.call(states, k) && states[k].firstOut) { return true; }
            }
            return false;
        }

        function clearFirstOut() {
            for (var k in states) {
                if (Object.prototype.hasOwnProperty.call(states, k)) { states[k].firstOut = false; }
            }
        }

        function markFirstOut(e, now, cfg) {
            // On the very first payload every out-of-limits point alarms at the
            // same instant, so none of them is "first" — marking one would be
            // pure fiction. Only cascades observed live get a marker.
            if (!seeded) { return; }
            var windowMs = Math.max(0, numIn(cfg.FirstOutWindow, 0, 3600, 30) * 1000);
            if (!anyFirstOut() || (now - cascadeStart) > windowMs) {
                clearFirstOut();
                cascadeStart = now;
                e.firstOut = true;
            } else {
                e.firstOut = false;
            }
        }

        /* ---- acknowledgement ------------------------------------------------ */

        /** Is anything outstanding on this point? */
        function isOutstanding(e) {
            return !!e && (e.state === ST_NEW || e.state === ST_RETURNED);
        }

        /**
         * Move the SESSION latch. Shared mode adds a write on top of this; it
         * does not replace it.
         *
         * @returns {Boolean} true if this point's state actually moved.
         */
        function acknowledge(key, now) {
            var e = states[key];
            if (!e) { return false; }
            if (e.state === ST_NEW) { setState(e, ST_ACK, now); return true; }
            if (e.state === ST_RETURNED) { setState(e, ST_NORMAL, now); return true; }
            return false;
        }

        /**
         * One point, acknowledged by the operator standing at THIS screen.
         *
         * The session latch always moves, shared mode or not. Two reasons, and
         * both are about not lying to the person who just pressed the tile:
         *   - the store is optimistic but still asynchronous; a tile that keeps
         *     flashing until a round trip completes reads as "it did not take".
         *   - if the store starts failing a minute later, the tile must not
         *     quietly flip back to unacknowledged. Their click happened.
         * The store write is what tells the REST of the crew, and its failures
         * are reported in the banner rather than by silently reverting a tile.
         */
        function ackPoint(key, now) {
            var outstanding = isOutstanding(states[key]);
            // A tile whose write never landed is still clickable even though the
            // local latch already moved — otherwise the banner's "acknowledge
            // again" would be an instruction the panel refuses to obey.
            var retry = !!(ackFailed && Object.prototype.hasOwnProperty.call(ackFailed.keys, key));
            // Otherwise: never write an acknowledgement for a point with nothing
            // outstanding. The shared map is a record of real operator
            // decisions, not a scratch pad for stray clicks on green tiles.
            if (!outstanding && !retry) { return false; }
            if (outstanding) { acknowledge(key, now); }
            writeAck([key]);
            return true;
        }

        function ackAll() {
            var now = Date.now();
            var keys = [];
            var k;
            for (k in states) {
                if (Object.prototype.hasOwnProperty.call(states, k) && isOutstanding(states[k])) {
                    keys.push(k);
                }
            }
            for (var i = 0; i < keys.length; i++) { acknowledge(keys[i], now); }
            // Anything this panel failed to save earlier rides along, so ACK ALL
            // is also the "try the whole panel again" button the banner asks for.
            if (ackFailed) {
                for (k in ackFailed.keys) {
                    if (Object.prototype.hasOwnProperty.call(ackFailed.keys, k) && keys.indexOf(k) === -1) {
                        keys.push(k);
                    }
                }
            }
            if (!keys.length) { return; }
            writeAck(keys);
            ctx.render();
        }

        /* ================================================================== *
         * Shared acknowledgement
         * ================================================================== */

        /**
         * Point PVX.api at a different PI Web API.
         *
         * Testing escape hatch only. This writes the LIBRARY's settings, not
         * this symbol's — PVX.api is deliberately one shared client so that
         * authentication is configured once per site — so the override moves
         * the base URL for every PVX symbol on the page. The config pane says
         * so.
         */
        function applyBaseUrlOverride(cfg) {
            var override = trim(cfg.BaseUrlOverride);
            if (!override) { return; }
            if (PVX.api.settings.baseUrl === override) { return; }
            PVX.api.configure({ baseUrl: override });
            // The shared GET cache is keyed by URL so stale entries could not be
            // served anyway; dropping them keeps the switch clean.
            PVX.api.clearCache();
        }

        /**
         * Create, rebuild or tear down the shared store to match the config.
         *
         * Called from render(), which is where every config change lands. The
         * signature guard is what keeps that cheap: a store is only rebuilt when
         * the attribute path, poll interval or user actually changes, so the
         * poller is not restarted on every resize.
         */
        function ensureAckStore(cfg) {
            var want = cfg.SharedAck === true;
            var path = trim(cfg.AckAttributePath);
            var pollMs = Math.round(numIn(cfg.AckPollSeconds, 2, 3600, 15) * 1000);
            // Blank means unknown, and unknown is what gets recorded. Inventing
            // an identity here — the Windows user, a hostname, "operator" —
            // would put a name on an acknowledgement that nobody can stand
            // behind afterwards.
            var user = trim(cfg.AckUser) || 'unknown';
            var sig = want ? (path + '\n' + pollMs + '\n' + user) : '';

            if (sig === ackSig) { return; }
            destroyAckStore();
            ackSig = sig;
            if (!want) { return; }

            // Deliberately created even with a blank path: the store answers
            // with a 'no-path' error, which the banner turns into a sentence an
            // engineer can act on. Silently doing nothing would look identical
            // to working.
            ackStore = PVX.ack.store({ attributePath: path, pollMs: pollMs, user: user });
            ackStore.onChange(onAckChange);
            ackStore.start();
        }

        function destroyAckStore() {
            if (ackStore) { ackStore.destroy(); }
            ackStore = null;
            sharedMap = {};
            sharedErr = null;
            ackFailed = null;
        }

        /**
         * Send an acknowledgement to the store and REMEMBER WHETHER IT LANDED.
         *
         * acknowledgeAll is one write for many keys; acknowledge is one for one.
         * Both are optimistic, so the tiles have already moved by the time this
         * returns — what the promise adds is the answer to the only question the
         * operator actually cares about: did the rest of the crew get it?
         */
        function writeAck(keys) {
            if (!ackStore || !keys.length) { return; }
            var store = ackStore;
            var p = keys.length === 1 ? store.acknowledge(keys[0]) : store.acknowledgeAll(keys);
            p.then(function () {
                // The config may have changed the store out from under us while
                // the write was in flight; that store's outcome is no longer
                // this panel's business.
                if (ctx.destroyed || store !== ackStore) { return; }
                recordAckOutcome(keys, store.error());
            });
        }

        /**
         * @param {Array} keys  what we tried to save
         * @param {Object} err  the store's error immediately afterwards, or null
         *
         * A poll failing in the same instant can leave an error behind that was
         * not ours, so this can over-report. That is the correct way round to be
         * wrong: a spurious "check whether this saved" costs a second glance,
         * and the opposite costs an alarm nobody is watching.
         */
        function recordAckOutcome(keys, err) {
            var i;
            if (err) {
                if (!ackFailed) { ackFailed = { err: null, keys: {} }; }
                ackFailed.err = err;
                for (i = 0; i < keys.length; i++) { ackFailed.keys[keys[i]] = true; }
            } else if (ackFailed) {
                for (i = 0; i < keys.length; i++) { delete ackFailed.keys[keys[i]]; }
                var any = false;
                for (var k in ackFailed.keys) {
                    if (Object.prototype.hasOwnProperty.call(ackFailed.keys, k)) { any = true; break; }
                }
                if (!any) { ackFailed = null; }
            }
            ctx.render();
        }

        /** How many of this panel's acknowledgements are still unsaved. */
        function failedCount() {
            var n = 0;
            if (!ackFailed) { return 0; }
            for (var k in ackFailed.keys) {
                if (Object.prototype.hasOwnProperty.call(ackFailed.keys, k)) { n += 1; }
            }
            return n;
        }

        /**
         * The store poll landed, or an acknowledgement was written. Repaint.
         * ctx.render() is the rAF-throttled request, so a burst of store
         * activity costs one frame, not one frame each.
         */
        function onAckChange(map, err) {
            sharedMap = map || {};
            sharedErr = err || null;
            if (!ctx.destroyed) { ctx.render(); }
        }

        /**
         * The shared entry that acknowledges this point's CURRENT episode, or
         * null.
         *
         * Why this is not simply `sharedMap[key]`: the map is a durable record
         * and the store's merge never deletes, so yesterday's acknowledgement is
         * still in it when the same tag alarms again today. Honouring that
         * blindly would open a brand-new alarm already acknowledged, silent and
         * un-flashing — the one thing an annunciator must never do.
         *
         * So an episode this browser WATCHED begin is only acknowledged by an
         * entry stamped at or after that beginning. An episode that was already
         * in alarm on the first payload has no knowable start — it may have been
         * out for hours and acknowledged by the previous shift — so for those,
         * any entry counts. That asymmetry is precisely what makes reopening a
         * display keep the crew's acknowledgements instead of resurrecting
         * every alarm they already dealt with.
         */
        function sharedEntryFor(key, e) {
            // hasOwnProperty, not a bare lookup: the map is built from JSON a
            // human can edit, and a tag path is not allowed to reach anything on
            // Object.prototype and be mistaken for an acknowledgement.
            if (!Object.prototype.hasOwnProperty.call(sharedMap, key)) { return null; }
            var entry = sharedMap[key];
            if (!entry || typeof entry !== 'object') { return null; }
            if (e.fromSeed || e.firstAlarmAt === null) { return entry; }
            return entry.at >= e.firstAlarmAt ? entry : null;
        }

        /**
         * Fold another operator's acknowledgement into the local machine. It
         * lands exactly the transition a local click would have, so the two
         * schemes cannot disagree about what ALARM_ACK means.
         */
        function applyShared(key, e, now) {
            if (!sharedEntryFor(key, e)) { return; }
            if (e.state === ST_NEW) { setState(e, ST_ACK, now); }
            else if (e.state === ST_RETURNED) { setState(e, ST_NORMAL, now); }
        }

        /** Attribution line for an acknowledged tile: who, and how long ago. */
        function attributionText(entry, now, wide) {
            var who = entry.by || 'unknown';
            return wide ? (who + ' · ' + PVX.fmt.ago(entry.at, now)) : who;
        }

        /**
         * A short, specific reason for the banner.
         *
         * The store's own message is a paragraph aimed at an engineer; it goes
         * in the tooltip. What fits across a 320px panel is a clause, and a
         * vague one ("an error occurred") would send that engineer looking in
         * the wrong place — which is the whole failure this maps around.
         */
        function reasonFor(err) {
            var code = err && err.code;
            if (code === 'no-path') { return 'no attribute path is configured'; }
            if (code === 'not-configured') { return 'PI Web API is not configured'; }
            if (code === 'not-found') { return 'the attribute path did not resolve'; }
            if (code === 'forbidden') { return 'this identity may not write it'; }
            if (code === 'unauthorized') { return 'the credentials were rejected'; }
            if (code === 'timeout') { return 'PI Web API did not respond'; }
            if (code === 'cors-or-network' || code === 'network') { return 'PI Web API is unreachable'; }
            if (code === 'bad-store') { return 'the attribute is not valid JSON'; }
            if (code === 'bad-json') { return 'the response was not JSON'; }
            return (err && err.message) ? String(err.message).split('.')[0].toLowerCase() : 'the store is failing';
        }

        /* ================================================================== *
         * Model
         * ================================================================== */

        function buildModel(cfg, now) {
            var bands = bandsFor(cfg);
            var byQuality = cfg.SeverityFrom === 'quality';
            var minBand = Math.max(0, parseInt(cfg.MinSeverityBand, 10) || 0);

            pass += 1;

            var items = [];
            var counts = { neu: 0, ack: 0, ret: 0, normal: 0 };
            // Occurrence counter for duplicate keys. Adding the same tag to a
            // panel twice is legal, and two tiles sharing one latch would make
            // each of them show the OTHER one's state. Disambiguating by
            // position among the duplicates is stable, because PI Vision returns
            // rows in data-source order.
            var seen = {};

            for (var i = 0; i < rawRows.length; i++) {
                var r = rawRows[i];
                var base = keyOf(r);
                var dup = seen[base] || 0;
                seen[base] = dup + 1;
                var key = dup ? (base + '#' + dup) : base;
                var e = states[key];
                if (!e) { e = states[key] = newEntry(now); }
                e.pass = pass;

                var sev, inAlarm, unknown = false;

                if (byQuality) {
                    // Quality mode: the excursion IS the loss of signal, and
                    // there is only one band to be in.
                    inAlarm = !r.good;
                    sev = inAlarm ? 0 : -1;
                } else {
                    sev = severityOf(r, bands);
                    inAlarm = sev >= minBand;
                    // A bad-quality reading in threshold mode is not evidence of
                    // anything: the last known value may sit anywhere. Freeze the
                    // latch rather than inventing a transition in either
                    // direction, and mark the tile stale so the operator can see
                    // why it stopped moving.
                    if (!r.good) { unknown = true; }
                }

                if (!unknown) { step(e, inAlarm, sev, now, cfg); }

                // Other operators' acknowledgements, applied on top of the local
                // machine. Nothing here runs when SharedAck is off, which is why
                // the default path is bit-for-bit what it always was.
                if (ackStore) { applyShared(key, e, now); }

                if (e.state === ST_NEW) { counts.neu += 1; }
                else if (e.state === ST_ACK) { counts.ack += 1; }
                else if (e.state === ST_RETURNED) { counts.ret += 1; }
                else { counts.normal += 1; }

                items.push({
                    key: key,
                    label: r.label,
                    path: r.path,
                    units: r.units,
                    raw: r.raw,
                    value: r.value,
                    time: r.time,
                    good: r.good,
                    error: r.errorDescription,
                    unknown: unknown,
                    entry: e,
                    // In quality mode the threshold bands are not what latched
                    // the tile, so labelling it "Critical" would be a fiction.
                    band: byQuality
                        ? ((e.state === ST_NEW || e.state === ST_ACK) ? 'Bad' : '')
                        : bandLabel(bands, e.sev)
                });
            }

            pruneStates();

            return { items: items, counts: counts, bands: bands, byQuality: byQuality };
        }

        /**
         * Drop points that stopped appearing in the payload. Without this a
         * display left open for a shift accumulates an entry for every tag that
         * was ever briefly configured, and the map leaks for as long as the tab
         * stays open.
         */
        function pruneStates() {
            for (var k in states) {
                if (Object.prototype.hasOwnProperty.call(states, k) && states[k].pass !== pass) {
                    delete states[k];
                }
            }
        }

        /* ================================================================== *
         * Colour
         * ================================================================== */

        /**
         * Resolve the tile palette.
         * ALARM_NEW and ALARM_ACK both take the matching THRESHOLD BAND colour,
         * so a Critical tile and a High tile are visibly different problems;
         * acknowledgement removes the flash and adds a tick, it does not repaint
         * the severity away. RETURNED uses its own colour because "it came back
         * and nobody saw it" is a different fact from "it is out now".
         */
        function paletteFor(item, cfg, t, model) {
            var e = item.entry;
            var on;

            if (e.state === ST_NEW || e.state === ST_ACK) {
                if (model.byQuality) {
                    on = PVX.color.status.stale;
                } else {
                    var b = model.bands[e.sev];
                    on = (b && b.color) || PVX.color.status.alarm;
                }
            } else if (e.state === ST_RETURNED) {
                on = cfg.ReturnedColor || '#3b82c4';
            } else if (item.unknown) {
                // Nothing latched, and the reading cannot be trusted either. A
                // green wash would say "this point is fine", which is precisely
                // what we do not know.
                on = PVX.color.status.stale;
            } else {
                on = cfg.NormalColor || '#2f9e5f';
            }

            var dimNormal = !!cfg.DimNormal && e.state === ST_NORMAL;
            // A dimmed normal tile is a wash rather than a fill, so the abnormal
            // tiles are the only saturated blocks on the panel.
            var bg = dimNormal ? PVX.color.mix(on, t.surface, t.dark ? 0.88 : 0.9) : on;
            var fg = dimNormal ? t.textMuted : PVX.color.readable(bg);

            return {
                on: on,
                bg: bg,
                fg: fg,
                // The "off" half of a flash cycle: the same hue knocked back
                // toward the surface, so the tile pulses instead of strobing to
                // a colour that means something else.
                off: PVX.color.mix(on, t.surface, 0.66),
                offFg: PVX.color.readable(PVX.color.mix(on, t.surface, 0.66)),
                dim: dimNormal
            };
        }

        /* ================================================================== *
         * Render
         * ================================================================== */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            var now = Date.now();

            applyThemeVars(c, t);

            // Both are config-driven and must happen before the model is built:
            // the store is what buildModel folds other operators' acknowledgements
            // in from, and it resolves its attribute against whatever base URL is
            // current at the moment it starts.
            applyBaseUrlOverride(cfg);
            ensureAckStore(cfg);

            var model = buildModel(cfg, now);
            // The first POPULATED payload is now on screen. Everything after
            // this counts as observed live and may claim the first-out marker.
            // The rawRows guard matters: bootstrap paints once before any data
            // arrives, and onResize can paint again.
            if (rawRows.length) { seeded = true; }

            renderHeader(c, cfg, t, model);
            renderNotice(cfg, t);

            if (host) {
                if (!model.items.length) {
                    renderEmpty(host);
                } else {
                    renderTiles(c, host, cfg, t, model, now);
                }
                syncClock(cfg);
            }

            // The header was written from inside requestAnimationFrame, which is
            // outside Angular's digest, so nudge it.
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', c.config.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-surface-alt', t.surfaceAlt);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            // Diagonal stripes for a frozen (bad-quality) tile are drawn in CSS
            // from this token so they stay legible on both themes.
            n.style.setProperty('--pvx-stripe', t.dark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.14)');
        }

        /* ---- header --------------------------------------------------------- */

        function renderHeader(c, cfg, t, model) {
            var mode = cfg.AckMode || 'click';
            var wantButton = mode === 'button' || mode === 'both';
            var outstanding = model.counts.neu + model.counts.ret;

            scope.pvx.title = PVX.util.def(cfg.Title, '');
            scope.pvx.surface = cfg.Transparent ? 'transparent' : t.surface;
            scope.pvx.ackAllLabel = PVX.util.def(cfg.AckAllLabel, 'ACK ALL');

            // Below roughly 130px the button is wider than the header and gets
            // sliced by the overflow clip, which reads as a rendering fault. The
            // per-tile click path still works, so drop the button rather than
            // draw a broken one.
            scope.pvx.showAckAll = wantButton && c.width >= 130;
            scope.pvx.ackBtn = outstanding
                ? { background: cfg.AccentColor || '#3b82c4', color: PVX.color.readable(cfg.AccentColor || '#3b82c4'), borderColor: 'transparent' }
                : { background: 'transparent', color: t.textMuted, borderColor: t.border };

            // Count pills need about 54px each. Sacrifice them before the title:
            // the tiles themselves already carry the same information in colour.
            var room = c.width - (scope.pvx.showAckAll ? 92 : 0) - (cfg.Title ? 70 : 0);
            scope.pvx.counts = (cfg.ShowSummaryBar && room >= 110) ? countPills(cfg, t, model) : [];

            // The button's tooltip is a promise about who will see the result,
            // so it has to track the mode rather than being a fixed string.
            scope.pvx.ackAllTip = 'Acknowledge every tile on this panel' +
                (cfg.SharedAck === true
                    ? ((sharedErr || ackFailed)
                        ? ' (not reaching the other screens right now — see the banner)'
                        : ' (shared with every screen on this attribute)')
                    : ' (this browser only)');

            scope.pvx.showHeader = (!!cfg.ShowLabel && !!scope.pvx.title) ||
                scope.pvx.counts.length > 0 || scope.pvx.showAckAll;
        }

        /* ---- the honesty banner --------------------------------------------- *
         * The failure worth engineering against is an operator who believes
         * their acknowledgement reached the crew when it did not. So whenever
         * the store is unhappy the panel says so in words, in place, without
         * being dismissible — and says what is happening INSTEAD, because a
         * warning that leaves someone wondering whether the panel still works
         * gets ignored the second time.
         */
        function renderNotice(cfg, t) {
            var nFailed = failedCount();
            if (!ackStore || (!sharedErr && !nFailed)) {
                scope.pvx.notice = '';
                scope.pvx.noticeTip = '';
                return;
            }

            var text, tip;
            // A failure of THIS panel's own write is the more specific fact and
            // the one the operator can act on, so it chooses the wording; the
            // store's own error still supplies the "and sharing is down" half.
            var err = nFailed ? ackFailed.err : sharedErr;
            var what = nFailed === 1 ? 'An acknowledgement' : (nFailed + ' acknowledgements');
            var were = nFailed === 1 ? 'was' : 'were';

            if (nFailed && err.code === 'ack-contended') {
                // Contention is its own sentence: the store DID reach the
                // server, the write simply lost a race, and acknowledging again
                // is genuinely the fix. It is the only case where it is.
                text = what + ' ' + were + ' not saved — another operator was writing at the same ' +
                       'moment. Acknowledge again.';
                tip = 'The write reached the attribute but lost a race with another operator, so it did ' +
                      'not stick. Click the tile again (or ACK ALL) — acknowledgement is idempotent, so ' +
                      'retrying is always safe.';
            } else if (nFailed && sharedErr) {
                text = 'Not shared: ' + reasonFor(err) + '. ' + what + ' ' + were +
                       ' not saved — this browser only.';
                tip = 'Shared acknowledgement is not working, so tiles are latching and acknowledging in ' +
                      'this browser only — other operators cannot see them, and they reset when the ' +
                      'display is reopened. ' + nFailed + ' acknowledgement' + (nFailed === 1 ? '' : 's') +
                      ' made here ' + were + ' not saved; click the tile (or ACK ALL) to try again.';
            } else if (nFailed) {
                // Sharing has since recovered, but these never landed. The tiles
                // show acknowledged here and unacknowledged everywhere else,
                // which is the state nobody must be left to discover.
                text = what + ' ' + were + ' not saved: ' + reasonFor(err) + '. Other operators cannot see ' +
                       (nFailed === 1 ? 'it.' : 'them.');
                tip = 'This panel acknowledged ' + nFailed + ' point' + (nFailed === 1 ? '' : 's') +
                      ' that the shared attribute does not contain. Click the tile (or ACK ALL) to try again.';
            } else {
                text = 'Not shared: ' + reasonFor(err) + '. Acknowledgements are being kept in this browser only.';
                tip = 'Shared acknowledgement is not working. Tiles still latch and still acknowledge, but ' +
                      'only for this browser — other operators cannot see them, and they reset when the ' +
                      'display is reopened.';
            }

            // Amber for "try that again", red for "this is not doing what the
            // display says it does". Both outrank the tiles for attention on
            // purpose: a wrong belief about acknowledgement is worse than any
            // single alarm on the panel.
            var col = (err.code === 'ack-contended') ? PVX.color.status.warning : PVX.color.status.alarm;

            scope.pvx.notice = text;
            scope.pvx.noticeTip = tip +
                (err.message ? '\n\n' + err.message : '') +
                (err.check ? '\n\nCheck: ' + err.check : '');
            scope.pvx.noticeStyle = {
                color: col,
                background: PVX.color.rgba(col, t.dark ? 0.26 : 0.13),
                'border-color': PVX.color.rgba(col, 0.45)
            };
        }

        function countPills(cfg, t, model) {
            var out = [];
            var add = function (key, label, count, col) {
                if (!count) { return; }
                out.push({
                    key: key,
                    label: label,
                    count: count,
                    color: col,
                    bg: PVX.color.rgba(col, t.dark ? 0.22 : 0.14)
                });
            };
            add('new', 'NEW', model.counts.neu, PVX.color.status.alarm);
            add('ack', 'ACK', model.counts.ack, cfg.AckColor || '#d99024');
            add('ret', 'RTN', model.counts.ret, cfg.ReturnedColor || '#3b82c4');
            return out;
        }

        /* ---- tile pool ------------------------------------------------------ */

        function makeEl(tag, cls, parent) {
            var e = document.createElement(tag);
            if (cls) { e.className = cls; }
            if (parent) { parent.appendChild(e); }
            return e;
        }

        /**
         * Build one empty tile. Every optional part exists up front and is only
         * shown or hidden per render: creating and destroying nodes on each poll
         * is what makes hand-rolled DOM slow, and it also drops keyboard focus
         * out from under whoever is tabbing across the panel.
         */
        function buildTile() {
            var el = makeEl('div', 'pvx-ann-tile');
            var rec = { el: el, last: {} };
            rec.wedge = makeEl('span', 'pvx-ann-wedge', el);
            rec.nameRow = makeEl('div', 'pvx-ann-namerow', el);
            rec.name = makeEl('span', 'pvx-ann-name pvx-truncate', rec.nameRow);
            // Compact readout for tiles too short for a value row of their own.
            // Dropping the number entirely on a narrow panel would leave the
            // operator with a colour and no reading.
            rec.mini = makeEl('span', 'pvx-ann-mini pvx-num', rec.nameRow);
            rec.tick = makeEl('span', 'pvx-ann-tick', rec.nameRow);
            rec.valueRow = makeEl('div', 'pvx-ann-valuerow', el);
            rec.value = makeEl('span', 'pvx-ann-value pvx-num', rec.valueRow);
            rec.units = makeEl('span', 'pvx-ann-units', rec.valueRow);
            rec.foot = makeEl('div', 'pvx-ann-foot', el);
            rec.first = makeEl('span', 'pvx-ann-first', rec.foot);
            rec.state = makeEl('span', 'pvx-ann-state pvx-truncate', rec.foot);
            // Who acknowledged, and when. Shared mode only — a session latch has
            // nobody to attribute an acknowledgement to.
            rec.by = makeEl('span', 'pvx-ann-by pvx-truncate', rec.foot);
            rec.dur = makeEl('span', 'pvx-ann-dur pvx-num', rec.foot);
            return rec;
        }

        function renderTiles(c, host, cfg, t, model, now) {
            var gap = 6;
            var minW = numIn(cfg.TileMinWidth, 40, 600, 150);
            var fixedCols = Math.floor(numIn(cfg.ColumnsCount, 0, 40, 0));
            var fixedH = numIn(cfg.TileHeight, 0, 400, 0);
            var maxTiles = Math.max(1, Math.floor(numIn(cfg.MaxTiles, 1, 200, 24)));

            var total = model.items.length;
            var n = Math.min(total, maxTiles);
            var more = total - n;

            var W = Math.max(40, c.width);
            var H = Math.max(24, c.height);

            // Mirror what the CSS grid will really do. `auto-fill` lays down every
            // track that fits, including empty ones, so the track count must NOT
            // be clamped to the tile count — two points in a wide panel would
            // otherwise be sized as if each were half the panel wide.
            var cols = fixedCols > 0 ? fixedCols : Math.max(1, Math.floor((W + gap) / (minW + gap)));
            var tileW = (W - gap * (cols - 1)) / cols;
            var rowCount = Math.max(1, Math.ceil((n + (more > 0 ? 1 : 0)) / Math.max(1, cols)));
            var tileH = fixedH > 0 ? fixedH : (H - gap * (rowCount - 1)) / rowCount;
            // Below MIN_TILE_H nothing is readable, so stop shrinking and let the
            // body scroll instead of producing a wall of 6px slivers.
            tileH = Math.max(MIN_TILE_H, tileH);

            host.style.display = 'grid';
            host.style.gridTemplateColumns = fixedCols > 0
                ? 'repeat(' + cols + ', 1fr)'
                : 'repeat(auto-fill, minmax(' + Math.round(Math.min(minW, W)) + 'px, 1fr))';
            host.style.gridAutoRows = Math.round(tileH) + 'px';
            host.style.gap = gap + 'px';
            host.style.gridGap = gap + 'px';   // older Grid implementations
            host.style.alignContent = 'start';

            // Rebuild the pool only when its shape changes; otherwise a poll is a
            // handful of textContent and style writes.
            if (tiles.length !== n || lastMore !== more || host.getAttribute('data-pvx-mode') !== 'tiles') {
                clear(host);
                tiles = [];
                for (var b = 0; b < n; b++) {
                    var rec = buildTile();
                    rec.el.setAttribute('data-pvx-i', String(b));
                    host.appendChild(rec.el);
                    tiles.push(rec);
                }
                if (more > 0) {
                    var moreEl = makeEl('div', 'pvx-ann-more', host);
                    moreEl.textContent = '+' + more + ' more';
                }
                host.setAttribute('data-pvx-mode', 'tiles');
                lastMore = more;
            }

            bindHost(host);

            // Sizes come from the TILE box, not the panel box: a six-column panel
            // in a wide symbol still has narrow tiles.
            var m = {
                cfg: cfg,
                theme: t,
                model: model,
                now: now,
                tileW: tileW,
                tileH: tileH,
                opts: PVX.config.numberOpts(cfg),
                nameFont: clamp(tileW * 0.095, 8.5, 13),
                subFont: clamp(tileW * 0.075, 7.5, 11),
                maxValueFont: clamp(Math.min(tileW * 0.24, tileH * 0.4), 10, 32),
                // Graded density: drop the least load-bearing row first. Colour
                // and flash still carry the state when the text has to go.
                showValue: !!cfg.ShowValue && tileH >= 34 && tileW >= 64,
                showFoot: tileH >= 54 && tileW >= 84,
                wideFoot: tileW >= 132,
                flash: flashEnabled(cfg),
                clickable: cfg.AckMode === 'click' || cfg.AckMode === 'both',
                showFirstOut: !!cfg.ShowFirstOut,
                // Attribution is a fact about the SHARED record, so it only
                // exists in shared mode.
                showBy: cfg.SharedAck === true && cfg.ShowAckAttribution !== false,
                fast: numIn(cfg.FlashFast, 120, 5000, 600),
                slow: numIn(cfg.FlashSlow, 200, 10000, 1600)
            };

            view = model.items.slice(0, n);
            durNodes = [];
            attrNodes = [];
            for (var i = 0; i < n; i++) { paintTile(tiles[i], view[i], m); }
        }

        function paintTile(rec, item, m) {
            var cfg = m.cfg;
            var e = item.entry;
            var pal = paletteFor(item, cfg, m.theme, m.model);
            var el = rec.el;

            // ---- text -------------------------------------------------------
            var display;
            if (item.value === null) {
                // Digital states and error strings arrive as text; show them as
                // they came rather than forcing them through the number format.
                display = (item.raw === null || item.raw === undefined) ? '--' : String(item.raw).trim();
                if (!display) { display = '--'; }
            } else {
                display = PVX.fmt.number(item.raw, m.opts);
            }

            var stateText = stateTextFor(item);
            // The shared record behind an acknowledged tile, if there is one.
            // Nothing is drawn without one — an acknowledgement that came from
            // the session latch alone (SharedAck off, or an episode the map does
            // not cover) has nobody to name, and a blank is the truth there.
            var att = (m.showBy && e.state === ST_ACK) ? sharedEntryFor(item.key, e) : null;
            var byText = att ? attributionText(att, m.now, m.wideFoot) : '';
            var durMs = m.now - ((cfg.DurationMode === 'sinceFirstAlarm' && e.firstAlarmAt !== null)
                ? e.firstAlarmAt : e.since);
            var durText = PVX.fmt.duration(durMs, { parts: m.wideFoot ? 2 : 1 });

            setText(rec.name, item.label || '', rec, 'name');
            setText(rec.value, display, rec, 'value');
            setText(rec.units, (cfg.ShowUnits && item.units) ? item.units : '', rec, 'units');
            setText(rec.state, (cfg.ShowStateText && m.showFoot) ? stateText : '', rec, 'state');
            setText(rec.dur, (cfg.ShowDuration && m.showFoot) ? durText : '', rec, 'dur');
            setText(rec.by, m.showFoot ? byText : '', rec, 'by');
            setText(rec.first, '1ST', rec, 'first');
            setText(rec.tick, '✓', rec, 'tick');

            var isFirst = m.showFirstOut && e.firstOut && e.state !== ST_NORMAL;
            // Too short for a value row, but wide enough to carry the reading
            // beside the name.
            var showMini = !m.showValue && !!cfg.ShowValue && m.tileW >= 100;
            setText(rec.mini, showMini ? (display + (cfg.ShowUnits && item.units ? ' ' + item.units : '')) : '', rec, 'mini');
            show(rec.mini, showMini, rec, 'showMini', 'inline-block');
            setStyle(rec.mini, 'fontSize', m.subFont.toFixed(1) + 'px', rec, 'mf');

            show(rec.valueRow, m.showValue, rec, 'showValue', 'flex');
            show(rec.foot, m.showFoot, rec, 'showFoot', 'flex');
            show(rec.state, !!(cfg.ShowStateText && m.showFoot), rec, 'showState', 'inline-block');
            show(rec.dur, !!(cfg.ShowDuration && m.showFoot), rec, 'showDur', 'inline-block');
            show(rec.by, !!(byText && m.showFoot), rec, 'showBy', 'inline-block');
            show(rec.first, isFirst && m.showFoot, rec, 'showFirst', 'inline-block');
            show(rec.wedge, isFirst, rec, 'showWedge', 'block');
            show(rec.tick, e.state === ST_ACK, rec, 'showTick', 'inline-flex');

            if (cfg.ShowDuration && m.showFoot) {
                durNodes.push({ node: rec.dur, since: (cfg.DurationMode === 'sinceFirstAlarm' && e.firstAlarmAt !== null) ? e.firstAlarmAt : e.since, parts: m.wideFoot ? 2 : 1 });
            }
            // "2m ago" has to keep counting between polls for the same reason a
            // duration does — the shared store polls every 15s at best, and a
            // frozen timestamp reads as a frozen panel. Only the wide form
            // carries a time to re-stamp.
            if (att && m.showFoot && m.wideFoot) {
                attrNodes.push({ node: rec.by, at: att.at, by: att.by || 'unknown' });
            }

            // ---- colour ------------------------------------------------------
            setStyle(el, 'backgroundColor', pal.bg, rec, 'bg');
            setStyle(el, 'color', pal.fg, rec, 'fg');
            // A lit tile is a block of colour; only the receded normal tiles
            // need an outline to read as tiles at all. A fixed border colour on
            // a flashing tile would vanish for half of every cycle anyway.
            setStyle(el, 'borderColor', pal.dim ? PVX.color.rgba(pal.on, 0.45) : 'transparent', rec, 'bc');
            setStyle(el, 'borderRadius', numIn(cfg.CornerRadius, 0, 40, 6) + 'px', rec, 'br');
            setStyle(el, 'opacity', pal.dim ? '0.82' : '1', rec, 'op');
            setStyle(rec.name, 'fontSize', m.nameFont.toFixed(1) + 'px', rec, 'nf');
            setStyle(rec.units, 'fontSize', m.subFont.toFixed(1) + 'px', rec, 'uf');
            setStyle(rec.foot, 'fontSize', m.subFont.toFixed(1) + 'px', rec, 'ff');
            // Units, the foot rail and the wedge deliberately carry NO colour of
            // their own: they inherit the tile's, which the flash keyframes
            // animate. Pinning them to the lit-phase foreground would make them
            // invisible for half of every flash cycle.
            setStyle(rec.tick, 'color', cfg.AckColor || '#d99024', rec, 'tkc');
            setStyle(rec.tick, 'borderColor', PVX.color.rgba(cfg.AckColor || '#d99024', 0.8), rec, 'tkb');

            // The value must never clip — an operator reading "12…" instead of
            // "127.4" is worse than no value at all — so shrink it to fit.
            var valueFont = PVX.layout.fitFont(
                display + (rec.last.units ? ' ' + rec.last.units : ''),
                m.tileW - 14, m.tileH * 0.4, m.maxValueFont, 8
            );
            setStyle(rec.value, 'fontSize', valueFont.toFixed(1) + 'px', rec, 'vf');

            // Custom properties are how the flash keyframes reach a per-tile
            // colour: the stylesheet animates var(--pvx-ann-on / --pvx-ann-off)
            // and never has to know a single actual colour.
            setProp(el, '--pvx-ann-on', pal.on, rec, 'pon');
            setProp(el, '--pvx-ann-on-fg', pal.fg, rec, 'ponf');
            setProp(el, '--pvx-ann-off', pal.off, rec, 'poff');
            setProp(el, '--pvx-ann-off-fg', pal.offFg, rec, 'pofff');

            // ---- classes + flash ----------------------------------------------
            var cls = 'pvx-ann-tile pvx-ann-st-' + e.state.toLowerCase().replace(/_/g, '-') +
                (isFirst ? ' pvx-ann-tile-first' : '') +
                (item.unknown ? ' pvx-ann-tile-stale' : '') +
                (m.clickable ? ' pvx-ann-clickable' : '');
            if (rec.last.cls !== cls) { rec.last.cls = cls; el.className = cls; }

            applyFlash(rec, e, m);

            // ---- tooltip + accessibility ---------------------------------------
            var tip = (item.path || item.label || '') +
                '\n' + display + (item.units ? ' ' + item.units : '') +
                '\n' + stateText + (item.band ? ' (' + item.band + ')' : '') +
                '\n' + durText + (cfg.DurationMode === 'sinceFirstAlarm' ? ' since alarm' : ' in state') +
                // An alarm that escalated and then eased off still shows its
                // current band on the tile; the worst it reached is the part an
                // operator arriving late actually needs.
                (e.peakSev > e.sev ? '\npeaked at ' + (bandLabelOf(m.model, e.peakSev) || 'a worse band') : '') +
                (item.unknown ? '\n' + (item.error || 'Bad quality — latch frozen') : '') +
                // The tooltip has room for the full attribution even when the
                // foot row had to drop it, so it always carries both facts.
                (att ? '\nAcknowledged by ' + (att.by || 'unknown') + ', ' + PVX.fmt.ago(att.at, m.now) : '') +
                (m.clickable && e.state !== ST_NORMAL ? '\nClick to acknowledge' : '');
            if (rec.last.tip !== tip) { rec.last.tip = tip; el.setAttribute('title', tip); }

            if (m.clickable) {
                el.setAttribute('tabindex', '0');
                el.setAttribute('role', 'button');
            } else {
                el.removeAttribute('tabindex');
                el.removeAttribute('role');
            }
        }

        /** Band label for an arbitrary severity, for the tooltip's peak note. */
        function bandLabelOf(model, sev) {
            return model.byQuality ? 'Bad' : bandLabel(model.bands, sev);
        }

        function stateTextFor(item) {
            var e = item.entry;
            if (e.state === ST_NEW) { return (item.band || 'ALARM').toUpperCase(); }
            if (e.state === ST_ACK) { return 'ACK'; }
            if (e.state === ST_RETURNED) { return 'RINGBACK'; }
            return item.unknown ? 'NO DATA' : 'NORMAL';
        }

        /**
         * Flash phase.
         *
         * Tiles are rebuilt (or at least re-styled) on every poll. A plain CSS
         * animation restarts whenever the class is re-applied, so the whole panel
         * would flash in lockstep with the REFRESH — a 5s poll would give a 5s
         * stutter instead of a steady 600ms beat. Fixing it is the same trick
         * pvxAlarmBanner uses for its new-row pulse: keep the animation running
         * and push it forward with a NEGATIVE animation-delay computed from a
         * fixed epoch, so the cycle resumes exactly where it left off.
         *
         * The epoch is shared by every tile on purpose. A real annunciator panel
         * flashes in unison; phasing each tile from its own alarm time would give
         * a shimmering mess that is harder, not easier, to read.
         */
        function applyFlash(rec, e, m) {
            var el = rec.el;
            var period = 0;
            if (m.flash) {
                if (e.state === ST_NEW) { period = m.fast; }
                else if (e.state === ST_RETURNED) { period = m.slow; }
            }
            if (!period) {
                setStyle(el, 'animationDuration', '', rec, 'ad');
                setStyle(el, 'animationDelay', '', rec, 'adl');
                return;
            }
            setStyle(el, 'animationDuration', period + 'ms', rec, 'ad');
            // Recomputed each frame on purpose: the phase must track wall clock,
            // not the last time this tile happened to be repainted.
            var delay = '-' + ((m.now - EPOCH) % period) + 'ms';
            if (rec.last.adl !== delay) { rec.last.adl = delay; el.style.animationDelay = delay; }
        }

        /**
         * Master flash switch. EnableFlash is the display author's choice;
         * prefers-reduced-motion is the viewer's, and the viewer wins. The CSS
         * carries the same media query so a static outline replaces the flash
         * even if this check is ever wrong about a browser.
         */
        function flashEnabled(cfg) {
            if (cfg.EnableFlash === false) { return false; }
            try {
                if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
                    return false;
                }
            } catch (err) { /* matchMedia missing — assume motion is fine */ }
            return true;
        }

        function renderEmpty(host) {
            // Rebuilding the empty state on every poll would drop focus, so only
            // touch the DOM when we are not already showing it.
            if (host.getAttribute('data-pvx-mode') === 'empty') { return; }
            clear(host);
            tiles = [];
            view = [];
            durNodes = [];
            attrNodes = [];
            lastMore = -1;
            // Drop the inline grid styling so .pvx-empty's own centring applies.
            host.removeAttribute('style');
            var msg = makeEl('div', 'pvx-empty', host);
            msg.textContent = 'No data sources configured';
            host.setAttribute('data-pvx-mode', 'empty');
        }

        /* ================================================================== *
         * Duration clock
         * ================================================================== *
         * Durations must advance even when no new data arrives. Rewriting the
         * text nodes in place is far cheaper than a full render, and it leaves
         * the flash animations untouched — restarting them once a second would
         * be exactly the stutter applyFlash() exists to prevent.
         */

        function syncClock(cfg) {
            var wanted = (!!cfg.ShowDuration && durNodes.length > 0) || attrNodes.length > 0;
            if (wanted && !clockTimer) {
                clockTimer = setInterval(tickClock, CLOCK_MS);
            } else if (!wanted && clockTimer) {
                clearInterval(clockTimer);
                clockTimer = null;
            }
        }

        function tickClock() {
            if (ctx.destroyed) { return; }
            var now = Date.now();
            for (var i = 0; i < durNodes.length; i++) {
                var d = durNodes[i];
                var next = PVX.fmt.duration(now - d.since, { parts: d.parts });
                // Skip the write when nothing changed — most seconds, most tiles.
                if (d.node.textContent !== next) { d.node.textContent = next; }
            }
            for (var j = 0; j < attrNodes.length; j++) {
                var a = attrNodes[j];
                var text = a.by + ' · ' + PVX.fmt.ago(a.at, now);
                if (a.node.textContent !== text) { a.node.textContent = text; }
            }
        }

        /* ================================================================== *
         * Interaction
         * ================================================================== *
         * One delegated listener pair for the whole panel. Per-tile listeners
         * would be 2N registrations to tear down, on a node set that is rebuilt
         * whenever the tile count changes.
         */

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            if (!host || !host.addEventListener) { return; }
            host.addEventListener('click', onClick, false);
            host.addEventListener('keydown', onKeyDown, false);
            boundHost = host;
        }

        function unbindHost() {
            if (boundHost && boundHost.removeEventListener) {
                boundHost.removeEventListener('click', onClick, false);
                boundHost.removeEventListener('keydown', onKeyDown, false);
            }
            boundHost = null;
        }

        /** Walk up to the tile element. Element.closest is missing on IE11. */
        function tileIndexOf(target) {
            var node = target;
            var guard = 0;
            while (node && node !== boundHost && guard < 12) {
                if (node.getAttribute && node.getAttribute('data-pvx-i') !== null) {
                    var i = parseInt(node.getAttribute('data-pvx-i'), 10);
                    return isNaN(i) ? -1 : i;
                }
                node = node.parentNode;
                guard += 1;
            }
            return -1;
        }

        function ackAt(index) {
            var cfg = ctx.config || {};
            if (cfg.AckMode !== 'click' && cfg.AckMode !== 'both') { return; }
            if (index < 0 || index >= view.length) { return; }
            if (ackPoint(view[index].key, Date.now())) { ctx.render(); }
        }

        function onClick(ev) {
            ackAt(tileIndexOf(ev.target));
        }

        function onKeyDown(ev) {
            var k = ev.keyCode || ev.which;
            if (k !== 13 && k !== 32) { return; }        // Enter, Space
            var i = tileIndexOf(ev.target);
            if (i < 0) { return; }
            // Space would otherwise scroll the display container.
            if (ev.preventDefault) { ev.preventDefault(); }
            ackAt(i);
        }

        /* ================================================================== *
         * Small helpers + teardown
         * ================================================================== */

        function setText(node, text, rec, key) {
            if (rec.last[key] === text) { return; }
            rec.last[key] = text;
            node.textContent = text;   // never innerHTML — PI text is untrusted
        }

        /**
         * Toggle part of a tile. `onDisplay` must be supplied for parts whose
         * stylesheet default is `none` (the wedge, the tick, the 1ST badge):
         * clearing the inline value there would fall back to the rule and hide
         * them again.
         */
        function show(node, on, rec, key, onDisplay) {
            var v = on ? (onDisplay || '') : 'none';
            if (rec.last[key] === v) { return; }
            rec.last[key] = v;
            node.style.display = v;
        }

        function setStyle(node, prop, value, rec, key) {
            if (rec.last[key] === value) { return; }
            rec.last[key] = value;
            node.style[prop] = value;
        }

        function setProp(node, prop, value, rec, key) {
            if (rec.last[key] === value) { return; }
            rec.last[key] = value;
            if (node.style.setProperty) { node.style.setProperty(prop, value); }
        }

        function clear(node) {
            while (node.firstChild) { node.removeChild(node.firstChild); }
        }

        function clamp(v, lo, hi) { return PVX.util.clamp(v, lo, hi); }

        function trim(s) {
            return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, '');
        }

        function numIn(v, lo, hi, fallback) {
            var n = PVX.util.num(v);
            if (n === null) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        function teardown() {
            if (clockTimer) { clearInterval(clockTimer); clockTimer = null; }
            // The store owns a setInterval against PI Web API. A display left
            // open on a kiosk and then swapped out would otherwise keep polling
            // an AF attribute for weeks — the leaked-poller failure the
            // authoring contract calls out by name.
            destroyAckStore();
            ackSig = '';
            unbindHost();
            tiles = [];
            view = [];
            durNodes = [];
            attrNodes = [];
            rawRows = [];
            states = {};
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
