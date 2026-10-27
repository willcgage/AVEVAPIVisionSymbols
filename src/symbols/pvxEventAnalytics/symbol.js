/* ============================================================================
 * pvxEventAnalytics — "PVX Event Analytics"
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector (see the definition). Like pvxEventGantt, every number here comes from PI Web API
 * through PVX.api, never from PI Vision's data pipeline.
 *
 * WHY THIS EXISTS
 *   PI Vision's native Events Table lists events, and a list answers "what
 *   happened". The question a plant manager actually asks is "which reason code
 *   is costing me the most hours" — an ACCOUNTING question. Answering it means
 *   grouping events (by reason code, by asset, by template, by a fragment of the
 *   event name) and ranking the groups by how much time they consumed. That is
 *   a different operation from listing, and no amount of sorting a table gets
 *   you there.
 *
 * WHAT MAKES IT AN INSTRUMENT RATHER THAN A CHART
 *   Four arithmetic decisions separate a number you can put in a report from a
 *   number that is merely plausible. Each is implemented once, commented at the
 *   place it happens, and disclosed in the footer when it changed the answer:
 *
 *   1. CLIPPING. An event that started three days before the window and is
 *      still running contributes only the part inside the window. Summing raw
 *      event durations over a window over-reports, sometimes by days.
 *   2. OPEN EVENTS. An event with no end time (or PI's year-9999 sentinel) runs
 *      to the window end or to now, whichever is earlier. Its contribution grows
 *      every minute, so the count of open events is reported: a total that
 *      silently includes a still-running event is a different number tomorrow.
 *   3. OVERLAP. Two operators logging the same outage as two events is normal.
 *      Summing their durations double-counts the outage, so intervals are merged
 *      per group before totalling, and the footer says when merging changed the
 *      total.
 *   4. UNASSIGNED. Events with no value for the grouping attribute go into an
 *      explicit "(unassigned)" group. In practice that group is often the
 *      finding — nobody is filling in the reason code.
 *
 *   And one disclosure: if MaxEvents truncated the result the RANKING may be
 *   wrong, not merely incomplete, so the footer says so rather than implying a
 *   complete picture.
 *
 * DATA ACCESS
 *   - The AF database is resolved once per path and cached: a WebId is stable,
 *     and re-resolving it every refresh doubles the request count for nothing.
 *   - Event Frames come back with an explicit `selectedFields`. Without it PI
 *     Web API returns the entire object graph per event; on 1000 events that is
 *     megabytes for the four fields this symbol reads.
 *   - Grouping by an event ATTRIBUTE (the reason-code case) needs one value per
 *     event. That goes through ONE PVX.api.batch() — as individual requests it
 *     would be one authentication handshake and, cross-origin, one CORS
 *     preflight PER EVENT. Element names are deduplicated to unique elements and
 *     cached for the life of the symbol. Failed sub-requests are counted and
 *     reported, never silently dropped.
 *
 * RENDERING
 *   One imperative SVG into `.pvx-ea-body`, sharing the visual language of
 *   pvxPareto (ranked bars, cumulative line, 80% marker). Only the header and
 *   footer are Angular-bound.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below these sizes the symbol sheds furniture rather than drawing an
     * illegible version of the full chart. Measured against the SYMBOL, never
     * against the drawing host — see the note in render(). */
    var COMPACT_W = 240, COMPACT_H = 160;   // drop value labels, axis, summary
    var MINIMAL_W = 140, MINIMAL_H = 100;   // bars only

    /** The one label for "this event carries no value for what you grouped by".
     *  Never dropped: a missing reason code is a finding, not a nuisance. */
    var UNASSIGNED = '(unassigned)';

    /** PI marks an unfinished event frame with a sentinel end time far in the
     *  future rather than a null — and different releases have used both. */
    var OPEN_AFTER_MS = Date.UTC(9000, 0, 1);

    /* Offsets accepted in a PI time expression. 'mo'/'y' are calendar units PI
     * resolves properly; here they only place a window, and a month-accurate
     * window on a downtime report is not worth a calendar library. */
    var UNIT_MS = {
        ms: 1, s: 1000, m: 60000, h: 3600000,
        d: 86400000, w: 604800000, mo: 2592000000, y: 31536000000
    };

    /**
     * `additive` is the load-bearing flag: a cumulative Pareto line and a donut
     * both assume the parts sum to the whole. A mean or a maximum does not, so
     * both are suppressed rather than drawn misleadingly.
     */
    var METRICS = {
        totalDuration: { label: 'Total duration', duration: true, additive: true },
        count: { label: 'Event count', duration: false, additive: true },
        meanDuration: { label: 'Mean duration', duration: true, additive: false },
        maxDuration: { label: 'Longest event', duration: true, additive: false }
    };

    var DURATION_UNITS = {
        minutes: { ms: 60000, label: 'min' },
        hours: { ms: 3600000, label: 'h' },
        days: { ms: 86400000, label: 'd' }
    };

    var definition = {
        typeName: 'pvxEventAnalytics',
        displayName: 'PVX Event Analytics',

        // One data source, which this symbol ignores: everything it shows comes
        // from its config pane. PI Vision keeps DatasourceBehaviors.None symbols
        // out of the symbol selector altogether (its guide calls them "static
        // symbols"), so declared that way this could never be placed on a
        // display. Pick it and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        // A collection would repeat the whole ranking once per asset, which
        // destroys the comparison the ranking exists to make.
        supportsCollections: false,
        configTitle: 'Format Event Analytics',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                // The cheapest query PI Vision has, for a value nothing reads.
                DataShape: 'Value',
                Height: 300,
                Width: 620,

                Title: 'Event analytics',
                ShowLabel: true,

                /* -- what to fetch ------------------------------------------ */
                DatabasePath: '',            // \\AFSERVER01\Production
                TemplateName: '',
                NameFilter: '',
                ElementNameFilter: '',
                SearchMode: 'Overlapped',
                MaxEvents: 1000,
                RefreshSeconds: 120,

                /* -- time window fallback ----------------------------------- *
                 * Only used when the display URL carries no starttime/endtime. */
                StartTime: '*-7d',
                EndTime: '*',

                /* -- grouping ------------------------------------------------ */
                GroupBy: 'template',         // template | element | attribute | name | none
                GroupAttribute: '',          // e.g. Reason Code
                NamePattern: '',             // regex; capture group 1 is the group

                /* -- what is ranked ------------------------------------------ */
                Metric: 'totalDuration',     // totalDuration | count | meanDuration | maxDuration
                Chart: 'pareto',             // pareto | bars | donut | table
                ShowCumulative: true,
                EightyLine: true,
                TopN: 10,
                GroupRemainderAsOther: true,

                /* -- presentation -------------------------------------------- */
                ShowValues: true,
                DurationUnit: 'auto',        // auto | minutes | hours | days
                ColorMode: 'single',         // single | palette | threshold
                BarColor: '#3b82c4',
                ShowSummary: true,
                ShowOpenEventNote: true,

                /* -- interaction ---------------------------------------------- */
                ClickAction: 'none',         // none | navigate
                NavigateTarget: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the chart itself is SVG.
        scope.pvx = {
            title: '',
            subtitle: '',
            summary: '',
            note: '',
            background: '',
            clickable: false
        };

        /* ---------------------------------------------------------------- *
         * instance state
         * ---------------------------------------------------------------- */
        var state = {
            phase: 'idle',        // idle | loading | ok | error | unconfigured | nodb
            error: null,          // rejection from PVX.api, carrying .pvxError
            events: [],
            capped: false,        // more events matched than MaxEvents
            maxEvents: 0,
            failedBatch: 0,       // failed sub-requests in the enrichment batch
            win: null,            // window the current events were fetched for
            db: { path: '', from: '' }   // database in use; `from` set when not configured
        };
        var sourceAsset = '';     // element of the placeholder data source

        var liveCfg = scope.config || {};
        var generation = 0;       // bumps on every refresh; stale replies dropped

        // Caches that outlive a refresh, both keyed by something stable (an AF
        // path, an element WebId) so they can only ever save a request, never
        // change what is drawn.
        var dbCache = {};
        var elemNames = {};

        var refreshTimer = null;
        var hashTimer = null;
        var debounceTimer = null;
        var timerSeconds = null;
        var lastHashKey = null;
        var hashListener = null;

        var boundHost = null;
        var hits = [];            // clickable marks, indexed by data-pvx-i
        var model = null;
        var chromeOff = false;    // true below the minimal size: bars only

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-ea-body',
            render: render,

            // The data source is otherwise ignored, but a blank DatabasePath
            // takes its database from it, and PI Vision re-binds it on an
            // asset swap.
            onData: function (d) {
                var one = PVX.data.single(d);
                var a = one ? PVX.nav.assetOf(one.path) : '';
                if (a !== sourceAsset) {
                    sourceAsset = a;
                    if (!trim(liveCfg.DatabasePath)) { refreshSoon(); }
                }
            },

            onConfigChange: function (newCfg) {
                liveCfg = newCfg || liveCfg;
                ensureTimers(liveCfg);
                // Debounced: the config pane fires on every keystroke in the
                // database path, and each one would be a round trip against a
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

        function firstNonEmpty(list) {
            for (var i = 0; i < list.length; i++) {
                var s = trim(list[i]);
                if (s) { return s; }
            }
            return '';
        }

        function isoOf(ms) { return new Date(ms).toISOString(); }

        /** Average-glyph-width estimate. Measuring properly forces a layout per
         *  label, and this chart draws dozens per frame. */
        function textW(s, fontPx) {
            return String(s === null || s === undefined ? '' : s).length * fontPx * 0.56;
        }

        function fitText(s, maxPx, fontPx) {
            var str = String(s === null || s === undefined ? '' : s);
            var max = Math.floor(maxPx / (fontPx * 0.56));
            if (max < 1) { return ''; }
            if (str.length <= max) { return str; }
            if (max === 1) { return '\u2026'; }
            return str.slice(0, max - 1) + '\u2026';
        }

        function metricDef(cfg) {
            var k = cfg && cfg.Metric;
            return Object.prototype.hasOwnProperty.call(METRICS, k) ? METRICS[k] : METRICS.totalDuration;
        }

        function metricKey(cfg) {
            var k = cfg && cfg.Metric;
            return Object.prototype.hasOwnProperty.call(METRICS, k) ? k : 'totalDuration';
        }

        function chartMode(cfg) {
            var c = cfg && cfg.Chart;
            return (c === 'bars' || c === 'donut' || c === 'table') ? c : 'pareto';
        }

        /* ================================================================ *
         * PI time expressions
         * ================================================================ *
         * The window arrives as PI time text ('*-7d', 't', '*'). PI Web API
         * understands that grammar natively, so the simplest thing would be to
         * forward the string — but then the ARITHMETIC and the QUERY could
         * disagree: if the server resolves '*' half a second after we compute
         * the window, every clipped duration is wrong by that much and the
         * "percentage of the window accounted for" is wrong with it. One
         * resolved instant, used for the query, the clipping and the axis,
         * cannot disagree with itself.
         *
         * When an expression is beyond this parser we hand the ORIGINAL text to
         * PI Web API — which is authoritative — and take the window from the
         * events that come back. The footer says so, because a total is only
         * meaningful next to the window it was taken over.
         */

        function localMidnight(nowMs, dayOffset) {
            var d = new Date(nowMs);
            d.setHours(0, 0, 0, 0);
            // setDate rather than adding 86400000: crossing a DST boundary by
            // arithmetic lands an hour off midnight.
            d.setDate(d.getDate() + (dayOffset || 0));
            return d.getTime();
        }

        /** @returns {Number|null} epoch ms, or null when this parser cannot say. */
        function parsePiTime(expr, nowMs) {
            var raw = trim(expr);
            if (!raw) { return null; }
            var s = raw.replace(/\s+/g, '').toLowerCase();

            var anchor = null;
            var rest = '';
            var head = s.charAt(0);
            if (head === '*') { anchor = nowMs; rest = s.slice(1); }
            else if (head === 't') { anchor = localMidnight(nowMs, 0); rest = s.slice(1); }
            else if (head === 'y') { anchor = localMidnight(nowMs, -1); rest = s.slice(1); }
            else if (head === '+' || head === '-') { anchor = nowMs; rest = s; }
            else {
                // Absolute timestamp. Parsing anything non-ISO is
                // implementation-defined, so an unparseable string returns null
                // rather than a plausible-looking wrong answer.
                var d = PVX.fmt.toDate(raw);
                return d ? d.getTime() : null;
            }
            if (!rest) { return anchor; }

            // Signed offset terms: '-7d', '+30m', '-1d+6h'. 'mo' and 'ms'
            // precede 'm' or they would never match.
            var re = /([+-])(\d+(?:\.\d+)?)(mo|ms|s|m|h|d|w|y)/g;
            var total = 0, consumed = 0, mm;
            while ((mm = re.exec(rest)) !== null) {
                total += (mm[1] === '-' ? -1 : 1) * parseFloat(mm[2]) * UNIT_MS[mm[3]];
                consumed += mm[0].length;
            }
            // A partially-understood expression is not understood.
            if (!consumed || consumed !== rest.length) { return null; }
            return anchor + total;
        }

        /**
         * The window this symbol accounts over.
         *
         * URL first, config second — the URL is where PI Vision's own time bar
         * writes, and following it is what makes this symbol obey the display's
         * time controls despite having no data pipeline to be told through.
         */
        function resolveWindow(cfg) {
            var params = {};
            try { params = PVX.nav.parseHash().params || {}; } catch (e) { params = {}; }

            // PI Vision writes these lower-case; deep-link tooling is less
            // careful, so both spellings are accepted.
            var startExpr = firstNonEmpty([params.starttime, params.StartTime, cfg.StartTime, '*-7d']);
            var endExpr = firstNonEmpty([params.endtime, params.EndTime, cfg.EndTime, '*']);

            var now = (new Date()).getTime();
            var from = parsePiTime(startExpr, now);
            var to = parsePiTime(endExpr, now);
            var parsed = from !== null && to !== null && to > from;

            if (!parsed) {
                from = now - 7 * 86400000;
                to = now;
            }
            return {
                startExpr: startExpr, endExpr: endExpr,
                from: from, to: to,
                useRaw: !parsed, now: now
            };
        }

        /** Key that changes exactly when the display's time range changes. */
        function hashKey() {
            var p = {};
            try { p = PVX.nav.parseHash().params || {}; } catch (e) { p = {}; }
            return String(p.starttime || p.StartTime || '') + '|' +
                   String(p.endtime || p.EndTime || '');
        }

        /* ================================================================ *
         * PI Web API
         * ================================================================ */

        /**
         * AF database path -> WebId, resolved once and remembered.
         *
         * A FAILED lookup is deliberately not cached: a transient outage would
         * otherwise poison every refresh for as long as the display stays open.
         */
        function resolveDatabase(dbPath) {
            if (dbCache[dbPath]) { return dbCache[dbPath]; }

            var p = PVX.api.get('assetdatabases?path=' + encodeURIComponent(dbPath))
                .then(function (db) {
                    if (!db || !db.WebId) {
                        throw {
                            pvxError: {
                                code: 'no-database',
                                message: 'PI Web API answered, but there is no AF database at "' + dbPath +
                                         '". The path is \\\\<AF server>\\<database> and it is case-insensitive ' +
                                         'but not forgiving about the server name.',
                                check: 'DatabasePath / AF server name'
                            }
                        };
                    }
                    return db.WebId;
                });

            p['catch'](function () {
                if (dbCache[dbPath] === p) { delete dbCache[dbPath]; }
            });
            dbCache[dbPath] = p;
            return p;
        }

        function needsElement(cfg) { return cfg.GroupBy === 'element'; }

        /** The attribute to read per event, or '' when the config does not need one. */
        function groupAttribute(cfg) {
            return cfg.GroupBy === 'attribute' ? trim(cfg.GroupAttribute) : '';
        }

        /**
         * The Event Frame query.
         *
         * `selectedFields` is not an optimisation, it is the difference between
         * a workable symbol and an unusable one — see the file header. Each
         * field below is asked for because something draws it, and the two
         * conditional ones are omitted entirely when the current grouping does
         * not need them.
         *
         * maxCount is asked for one HIGHER than we will use. That single extra
         * row is what distinguishes "exactly MaxEvents events matched" from "PI
         * Web API truncated the answer" — and truncation does not merely make
         * this chart incomplete, it can make the RANKING wrong, so it has to be
         * detectable.
         */
        function queryEvents(dbWebId, cfg, win) {
            var max = intIn(cfg.MaxEvents, 1, 20000, 1000);
            var fields = [
                'Items.Name',
                'Items.StartTime',
                'Items.EndTime',
                'Items.TemplateName'
            ];
            if (needsElement(cfg)) {
                // The search endpoint returns a LINK to the referenced element,
                // not its name. This field is the cheapest thing that leads to
                // one: it carries the WebId the enrichment batch resolves, once
                // per element, then cached.
                fields.push('Items.Links.PrimaryReferencedElement');
            }
            if (groupAttribute(cfg)) {
                // Only when an attribute value is needed per event — Self is the
                // WebId the streamset lookup is addressed to.
                fields.push('Items.Links.Self');
            }

            return PVX.api.eventFrames({
                databaseWebId: dbWebId,
                startTime: win.useRaw ? win.startExpr : isoOf(win.from),
                endTime: win.useRaw ? win.endExpr : isoOf(win.to),
                templateName: trim(cfg.TemplateName),
                nameFilter: trim(cfg.NameFilter),
                elementNameFilter: trim(cfg.ElementNameFilter),
                // 'Overlapped' is the operational default and the only one that
                // is arithmetically right for downtime accounting: the event
                // that started before the window and is still running consumed
                // time INSIDE the window, and every stricter mode drops it.
                searchMode: trim(cfg.SearchMode) || 'Overlapped',
                maxCount: max + 1,
                selectedFields: fields.join(';')
            }, {
                // Never served from the shared GET cache: this symbol owns its
                // refresh cadence, and a RefreshSeconds shorter than the cache
                // TTL would silently become the TTL.
                cache: false
            });
        }

        /** Last path segment of a PI Web API link — the WebId. */
        function webIdFromLink(url) {
            var s = trim(url);
            if (!s) { return ''; }
            s = s.split('?')[0].replace(/\/+$/, '');
            var i = s.lastIndexOf('/');
            return i === -1 ? '' : s.slice(i + 1);
        }

        function toEvent(item, cfg) {
            var startD = PVX.fmt.toDate(item.StartTime);
            if (!startD) { return null; }      // an event with no start cannot be placed
            var endD = PVX.fmt.toDate(item.EndTime);
            // Open = no end time at all, or the year-9999 sentinel. Treating
            // either as a real end would book a finished outage for a fault that
            // is still on the plant.
            var open = !endD || endD.getTime() >= OPEN_AFTER_MS;
            var links = item.Links || {};
            return {
                name: item.Name || '(unnamed event)',
                template: trim(item.TemplateName),
                start: startD.getTime(),
                end: open ? null : endD.getTime(),
                open: open,
                webId: groupAttribute(cfg) ? webIdFromLink(links.Self) : '',
                elWebId: needsElement(cfg) ? webIdFromLink(links.PrimaryReferencedElement) : '',
                elName: '',
                attrValue: null
            };
        }

        /**
         * ONE batch for every per-event follow-up the grouping needs.
         *
         * Element names are DEDUPLICATED to unique elements and cached forever
         * after: 1000 events across 12 assets is 12 sub-requests on the first
         * refresh and zero on every one after it. Attribute values cannot be
         * cached — an operator editing a reason code is exactly the change this
         * symbol exists to show — so they are one sub-request per event, which
         * is precisely why they go in a batch and never down the wire
         * individually. PVX.api.batch chunks them itself.
         */
        function enrich(events, cfg) {
            var attr = groupAttribute(cfg);
            var wantEl = needsElement(cfg);
            var reqs = {};
            var ids = [];             // parallel arrays keep batch ids opaque
            var kinds = [];
            var targets = [];
            var i, key;

            if (wantEl) {
                var seenEl = {};
                for (i = 0; i < events.length; i++) {
                    var id = events[i].elWebId;
                    if (!id || seenEl[id] || elemNames[id] !== undefined) { continue; }
                    seenEl[id] = true;
                    key = 'e' + ids.length;
                    reqs[key] = {
                        Method: 'GET',
                        Resource: apiUrl('elements/' + encodeURIComponent(id) + '?selectedFields=Name')
                    };
                    ids.push(key); kinds.push('element'); targets.push(id);
                }
            }

            if (attr) {
                var seenEv = {};
                for (i = 0; i < events.length; i++) {
                    var wid = events[i].webId;
                    // Deduplicated defensively: an event cannot legitimately
                    // appear twice, but a second request for the same WebId
                    // would be a sub-request bought for nothing.
                    if (!wid || seenEv[wid]) { continue; }
                    seenEv[wid] = true;
                    key = 'a' + ids.length;
                    reqs[key] = {
                        Method: 'GET',
                        // streamsets rather than a per-attribute lookup: one
                        // request returns the named attribute's value without
                        // first resolving the attribute's own WebId.
                        Resource: apiUrl('streamsets/' + encodeURIComponent(wid) +
                            '/value?nameFilter=' + encodeURIComponent(attr) +
                            '&selectedFields=Items.Name;Items.Value')
                    };
                    ids.push(key); kinds.push('attribute'); targets.push(wid);
                }
            }

            if (!ids.length) {
                applyElementNames(events);
                return Promise.resolve(0);
            }

            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                var r = PVX.api.batchResults(res);
                var byWebId = {};
                for (var k = 0; k < ids.length; k++) {
                    var body = r.ok[ids[k]];
                    if (body === undefined) { continue; }
                    if (kinds[k] === 'element') {
                        elemNames[targets[k]] = (body && body.Name) || '';
                    } else {
                        byWebId[targets[k]] = firstStreamValue(body);
                    }
                }
                for (var e = 0; e < events.length; e++) {
                    if (events[e].webId && byWebId[events[e].webId] !== undefined) {
                        events[e].attrValue = byWebId[events[e].webId];
                    }
                }
                applyElementNames(events);
                // Reported, not swallowed: a group total built from 40 of 50
                // events is a smaller number than the truth, and nothing on the
                // chart would show it.
                return r.failedCount;
            })['catch'](function () {
                // A failed batch degrades the GROUPING, which matters more here
                // than it does on a timeline — every event lands in
                // "(unassigned)". Say so rather than presenting that as a
                // finding about the plant.
                applyElementNames(events);
                return -1;
            });
        }

        function apiUrl(path) { return PVX.api.base() + '/' + path; }

        function applyElementNames(events) {
            for (var i = 0; i < events.length; i++) {
                var id = events[i].elWebId;
                if (id && elemNames[id]) { events[i].elName = elemNames[id]; }
            }
        }

        /** First value out of a streamset response, whatever shape it arrived in. */
        function firstStreamValue(body) {
            var items = body && body.Items;
            if (!items || !items.length) { return null; }
            var v = items[0].Value;
            if (v !== null && typeof v === 'object') {
                // A TimedValue wrapper; PI digital states nest one deeper.
                v = v.Value;
                if (v !== null && typeof v === 'object') { v = v.Name !== undefined ? v.Name : null; }
            }
            return v === undefined ? null : v;
        }

        /* ================================================================ *
         * refresh
         * ================================================================ */

        /**
         * The configured database, else the one this symbol's data source
         * lives in (see PVX.nav.defaultDatabase).
         */
        function databaseFor(cfg) {
            var typed = trim(cfg.DatabasePath);
            if (typed) { return { path: typed, from: '' }; }
            return PVX.nav.defaultDatabase(scope, sourceAsset);
        }

        function refresh() {
            if (ctx.destroyed) { return; }
            var cfg = liveCfg = scope.config || liveCfg;

            // With no baseUrl set, PVX.api first asks PI Vision's own server
            // for /piwebapi. Decide nothing until it has its answer.
            if (PVX.api.discovering()) {
                PVX.api.discover().then(function () { if (!ctx.destroyed) { refresh(); } });
                return;
            }

            // Each state below is a different problem with a different owner, so
            // each gets its own message rather than one "no data".
            if (!PVX.api.isConfigured()) {
                state.phase = 'unconfigured';
                state.error = null;
                ctx.render();
                return;
            }

            state.db = databaseFor(cfg);
            var dbPath = state.db.path;
            if (!dbPath) {
                state.phase = 'nodb';
                state.error = null;
                ctx.render();
                return;
            }

            var gen = ++generation;
            var win = resolveWindow(cfg);
            var maxEvents = intIn(cfg.MaxEvents, 1, 20000, 1000);

            // Keep whatever is drawn while the new answer is in flight; blanking
            // a working chart every tick is worse than a stale one.
            if (state.phase !== 'ok') { state.phase = 'loading'; }
            ctx.render();

            resolveDatabase(dbPath)
                .then(function (webId) {
                    if (stale(gen)) { return null; }
                    return queryEvents(webId, cfg, win);
                })
                .then(function (res) {
                    if (stale(gen) || res === null) { return null; }

                    var items = (res && res.Items) || [];
                    var capped = items.length > maxEvents;
                    if (capped) { items = items.slice(0, maxEvents); }

                    var events = [];
                    for (var i = 0; i < items.length; i++) {
                        var ev = toEvent(items[i], cfg);
                        if (ev) { events.push(ev); }
                    }
                    events.sort(function (a, b) { return a.start - b.start; });

                    state.capped = capped;
                    state.maxEvents = maxEvents;
                    state.events = events;
                    state.win = win;

                    // The server understood an expression we could not, so the
                    // window has to come from what it returned.
                    if (win.useRaw) { adoptWindowFromEvents(win, events); }

                    return enrich(events, cfg);
                })
                .then(function (failed) {
                    if (stale(gen) || failed === null) { return; }
                    state.failedBatch = failed;
                    state.phase = 'ok';
                    state.error = null;
                    ctx.render();
                })['catch'](function (err) {
                    if (stale(gen)) { return; }
                    state.phase = 'error';
                    state.error = err;
                    state.events = [];
                    ctx.render();
                });
        }

        /** A reply from a superseded request must not overwrite a newer one. */
        function stale(gen) { return ctx.destroyed || gen !== generation; }

        function adoptWindowFromEvents(win, events) {
            if (!events.length) { return; }
            var lo = events[0].start, hi = events[0].start;
            for (var i = 0; i < events.length; i++) {
                if (events[i].start < lo) { lo = events[i].start; }
                var e = events[i].open ? win.now : events[i].end;
                if (e > hi) { hi = e; }
            }
            if (!(hi > lo)) { hi = lo + 60000; }
            win.from = lo;
            win.to = hi;
        }

        /* ================================================================ *
         * timers and listeners — every one is torn down in teardown()
         * ================================================================ */

        function ensureTimers(cfg) {
            var secs = intIn(cfg.RefreshSeconds, 5, 86400, 120);
            if (refreshTimer !== null && timerSeconds === secs) { return; }
            if (refreshTimer !== null) { clearInterval(refreshTimer); }
            timerSeconds = secs;
            refreshTimer = setInterval(function () { refresh(); }, secs * 1000);
        }

        /**
         * Poll the URL for a time-range change.
         *
         * A hashchange listener is wired up too, but polling is the primary
         * mechanism on purpose: some PI Vision releases change the time range
         * through the router without producing a hashchange, and a symbol that
         * relied on the event alone would quietly keep reporting yesterday's
         * totals under today's heading.
         */
        function pollHash() {
            if (ctx.destroyed) { return; }
            var k = hashKey();
            if (k === lastHashKey) { return; }
            lastHashKey = k;
            refresh();
        }

        function refreshSoon() {
            if (debounceTimer !== null) { clearTimeout(debounceTimer); }
            debounceTimer = setTimeout(function () {
                debounceTimer = null;
                refresh();
            }, 400);
        }

        function teardown() {
            // A leaked poller on a kiosk display runs for weeks. Everything this
            // symbol started, it stops.
            if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
            if (hashTimer !== null) { clearInterval(hashTimer); hashTimer = null; }
            if (debounceTimer !== null) { clearTimeout(debounceTimer); debounceTimer = null; }
            if (hashListener) {
                try { window.removeEventListener('hashchange', hashListener, false); } catch (e) { /* ignore */ }
                hashListener = null;
            }
            unbindHost();
            // Any request still in flight resolves into stale() and is dropped.
            generation += 1;
            state.events = [];
            hits = [];
            model = null;
        }

        /* ================================================================ *
         * model — pure: events + config -> ranked groups, totals, notes
         * ================================================================ */

        /**
         * Total covered time of a set of intervals, MERGING overlaps.
         *
         * Two operators logging the same four-hour outage as two events is
         * routine, and adding their durations reports eight hours of downtime
         * that never happened. The union is the only defensible total, and the
         * difference between the union and the raw sum is disclosed by the
         * caller when it is non-zero.
         *
         * @param {Array} intervals [{from,to}] — mutated only through a copy
         */
        function mergedTotal(intervals) {
            if (!intervals.length) { return 0; }
            var arr = intervals.slice().sort(function (a, b) { return a.from - b.from; });
            var total = 0;
            var curFrom = arr[0].from, curTo = arr[0].to;
            for (var i = 1; i < arr.length; i++) {
                if (arr[i].from > curTo) {
                    total += curTo - curFrom;
                    curFrom = arr[i].from;
                    curTo = arr[i].to;
                } else if (arr[i].to > curTo) {
                    curTo = arr[i].to;
                }
            }
            return total + (curTo - curFrom);
        }

        /**
         * Compile NamePattern once per render.
         * An invalid regex is the operator's typo, not a crash: it is reported
         * in the footer and grouping falls back to the whole event name.
         */
        function nameRegex(cfg) {
            var src = trim(cfg.NamePattern);
            if (!src) { return { re: null, bad: false }; }
            try { return { re: new RegExp(src), bad: false }; }
            catch (e) { return { re: null, bad: true }; }
        }

        /** Which group does this event belong to? '' means "(unassigned)". */
        function groupKeyFor(ev, cfg, rx) {
            var mode = cfg.GroupBy;
            if (mode === 'none') { return 'All events'; }
            if (mode === 'template') { return trim(ev.template); }
            if (mode === 'element') { return trim(ev.elName); }
            if (mode === 'attribute') {
                var v = ev.attrValue;
                return (v === null || v === undefined) ? '' : trim(String(v));
            }
            // 'name' — the reason is very often buried in the event name and a
            // regex is the only way to get it out. Capture group 1 wins; with no
            // pattern the whole name is the group.
            if (rx && rx.re) {
                var m = rx.re.exec(ev.name || '');
                if (!m) { return ''; }
                return trim(m.length > 1 && m[1] !== undefined ? m[1] : m[0]);
            }
            return trim(ev.name);
        }

        function metricOf(g, key) {
            if (key === 'count') { return g.count; }
            if (key === 'meanDuration') { return g.count ? g.rawSum / g.count : 0; }
            if (key === 'maxDuration') { return g.max; }
            return g.merged;
        }

        function buildModel(cfg) {
            var win = state.win;
            var mk = metricKey(cfg);
            var md = METRICS[mk];
            var m = {
                items: [], cum: null, groupCount: 0,
                count: 0, openCount: 0, outOfWindow: 0,
                rawSum: 0, mergedSum: 0, covered: 0,
                windowSpan: 0, from: 0, to: 0,
                unassigned: 0, allUnassigned: false,
                total: 0, notes: [], metric: mk, metricLabel: md.label,
                additive: md.additive, isDuration: md.duration,
                unit: DURATION_UNITS.hours, badPattern: false,
                otherCount: 0
            };
            if (!win) { return m; }

            m.from = win.from;
            m.to = win.to;
            m.windowSpan = Math.max(1, win.to - win.from);

            // An open event runs to the window end or to NOW, whichever is
            // earlier — a window that extends into the future must not book
            // downtime that has not happened yet.
            var openEnd = Math.min(win.to, win.now);

            var rx = nameRegex(cfg);
            m.badPattern = rx.bad;

            var byKey = {};
            var all = [];             // every clipped interval, for window coverage
            var i, ev;

            for (i = 0; i < state.events.length; i++) {
                ev = state.events[i];

                /* CLIPPING — requirement 1.
                 * Only the part of the event INSIDE the window counts. An event
                 * that started three days before the window and is still running
                 * contributes the window, not its whole life; summing raw
                 * durations over-reports, and that number ends up in a report. */
                var from = Math.max(ev.start, win.from);
                var to = Math.min(ev.open ? openEnd : ev.end, win.to);
                if (!(to > from)) {
                    // Zero or negative overlap. 'Overlapped' should not return
                    // these, but a clock skew or a zero-length event can, and a
                    // negative duration would corrupt every total downstream.
                    m.outOfWindow += 1;
                    continue;
                }

                var dur = to - from;
                var key = groupKeyFor(ev, cfg, rx);
                var label = key || UNASSIGNED;   // requirement 4: never dropped
                if (!key) { m.unassigned += 1; }

                if (!byKey[label]) {
                    byKey[label] = {
                        label: label, count: 0, rawSum: 0, max: 0, merged: 0,
                        intervals: [], first: from, last: to, isOther: false,
                        open: 0, unassigned: !key
                    };
                    m.items.push(byKey[label]);
                }
                var g = byKey[label];
                g.count += 1;
                g.rawSum += dur;
                if (dur > g.max) { g.max = dur; }
                g.intervals.push({ from: from, to: to });
                if (from < g.first) { g.first = from; }
                if (to > g.last) { g.last = to; }
                if (ev.open) { g.open += 1; m.openCount += 1; }

                all.push({ from: from, to: to });
                m.count += 1;
                m.rawSum += dur;
            }

            // MERGE — requirement 3. Per group, because the ranking is per
            // group; and once globally, because "how much of the window is
            // accounted for" is a question about the window, not about any one
            // reason code.
            for (i = 0; i < m.items.length; i++) {
                m.items[i].merged = mergedTotal(m.items[i].intervals);
                m.mergedSum += m.items[i].merged;
            }
            m.covered = mergedTotal(all);
            m.groupCount = m.items.length;
            m.allUnassigned = m.count > 0 && m.unassigned === m.count;

            // Rank. Ties break on label so the order does not shuffle between
            // refreshes — a ranking that reshuffles is unreadable on a kiosk.
            for (i = 0; i < m.items.length; i++) {
                m.items[i].value = metricOf(m.items[i], mk);
            }
            m.items.sort(function (a, b) {
                return (b.value - a.value) || (a.label < b.label ? -1 : (a.label > b.label ? 1 : 0));
            });

            // --- Top N ---------------------------------------------------
            var topN = intIn(cfg.TopN, 0, 200, 10);
            var hidden = 0;
            if (topN > 0 && m.items.length > topN) {
                var rest = m.items.slice(topN);
                m.items = m.items.slice(0, topN);
                if (cfg.GroupRemainderAsOther !== false) {
                    var other = {
                        label: 'Other (' + rest.length + ')',
                        count: 0, rawSum: 0, max: 0, merged: 0, intervals: [],
                        first: rest[0].first, last: rest[0].last,
                        isOther: true, open: 0, unassigned: false
                    };
                    for (i = 0; i < rest.length; i++) {
                        other.count += rest[i].count;
                        other.rawSum += rest[i].rawSum;
                        other.open += rest[i].open;
                        if (rest[i].max > other.max) { other.max = rest[i].max; }
                        // Sum of the per-group unions, NOT a union across
                        // groups: the cumulative line has to add up to the same
                        // total the individual bars do, and cross-group overlap
                        // is a property of the window (m.covered), not of any
                        // reason code.
                        other.merged += rest[i].merged;
                        if (rest[i].first < other.first) { other.first = rest[i].first; }
                        if (rest[i].last > other.last) { other.last = rest[i].last; }
                    }
                    other.value = metricOf(other, mk);
                    m.items.push(other);
                    m.otherCount = rest.length;
                } else {
                    hidden = rest.length;
                }
            }

            // --- totals + cumulative --------------------------------------
            var shown = 0;
            for (i = 0; i < m.items.length; i++) { shown += m.items[i].value; }
            m.total = shown;

            // A running percentage only means something when the parts sum to
            // the whole. A mean or a maximum does not, so no Pareto line.
            if (cfg.ShowCumulative !== false && m.additive && shown > 0 && m.items.length) {
                m.cum = [];
                var run = 0;
                for (i = 0; i < m.items.length; i++) {
                    run += m.items[i].value;
                    m.cum.push((run / shown) * 100);
                }
            }

            // Display unit for durations, resolved from the biggest bar so the
            // axis reads in whole-ish numbers rather than 0.003 days.
            m.unit = resolveUnit(cfg, m.items.length ? m.items[0].value : 0);

            /* ---- notes: everything the picture cannot say for itself ---- */
            if (state.capped) {
                // Truncation is not merely "some events missing". PI Web API
                // returns the first N by start time, not the N that matter, so
                // the RANKING may be wrong. Say that, not "showing 1000".
                m.notes.push('capped at ' + state.maxEvents + ' events \u2014 the ranking may be incomplete');
            }
            if (m.rawSum > m.mergedSum + 500) {
                // Disclosed, with the size of the correction: an engineer
                // comparing this against a hand-built spreadsheet needs to know
                // why the two disagree.
                m.notes.push('overlaps merged: \u2212' +
                    PVX.fmt.duration(m.rawSum - m.mergedSum) + ' vs raw sum');
            }
            if (m.openCount && cfg.ShowOpenEventNote !== false) {
                m.notes.push(m.openCount + ' open ' + (m.openCount === 1 ? 'event' : 'events') +
                    ' counted to now (totals grow)');
            }
            if (m.unassigned && !m.allUnassigned) {
                m.notes.push(m.unassigned + '/' + m.count + ' events have no ' + groupNoun(cfg));
            }
            if (hidden) { m.notes.push('+' + hidden + ' groups not shown'); }
            if (m.outOfWindow) {
                m.notes.push(m.outOfWindow + ' events fall outside the window');
            }
            if (m.badPattern) {
                m.notes.push('name pattern is not a valid regular expression \u2014 grouping by full name');
            }
            if (state.failedBatch > 0) {
                m.notes.push(state.failedBatch + ' follow-up ' +
                    (state.failedBatch === 1 ? 'request' : 'requests') +
                    ' failed \u2014 those events are unassigned');
            } else if (state.failedBatch === -1) {
                m.notes.push('follow-up request failed \u2014 grouping is incomplete');
            }
            if (!m.additive && cfg.ShowCumulative !== false) {
                m.notes.push('cumulative % hidden: ' + m.metricLabel.toLowerCase() + ' does not sum to a whole');
            }
            if (win.useRaw) { m.notes.push('time range resolved by PI Web API'); }
            return m;
        }

        /** What the operator called the thing they grouped by, for prose. */
        function groupNoun(cfg) {
            if (cfg.GroupBy === 'attribute') { return trim(cfg.GroupAttribute) || 'attribute value'; }
            if (cfg.GroupBy === 'element') { return 'referenced element'; }
            if (cfg.GroupBy === 'template') { return 'template'; }
            if (cfg.GroupBy === 'name') { return 'name match'; }
            return 'group';
        }

        function groupByLabel(cfg) {
            if (cfg.GroupBy === 'attribute') { return trim(cfg.GroupAttribute) || 'attribute'; }
            if (cfg.GroupBy === 'element') { return 'asset'; }
            if (cfg.GroupBy === 'name') { return 'event name'; }
            if (cfg.GroupBy === 'none') { return 'all events'; }
            return 'template';
        }

        /**
         * Display unit for durations. 'auto' picks from the largest value so a
         * chart of four-minute trips is not labelled in days, and a chart of
         * week-long outages is not labelled in 10080-minute bars.
         */
        function resolveUnit(cfg, maxMs) {
            var u = cfg.DurationUnit;
            if (Object.prototype.hasOwnProperty.call(DURATION_UNITS, u)) { return DURATION_UNITS[u]; }
            if (maxMs < 90 * 60000) { return DURATION_UNITS.minutes; }
            if (maxMs < 48 * 3600000) { return DURATION_UNITS.hours; }
            return DURATION_UNITS.days;
        }

        /**
         * A span of time, as text.
         * 'auto' gets the human form ("2d 4h"), which is what an operator reads
         * fastest; an explicit unit gets one comparable number, which is what
         * anyone copying the figure into a report actually wants.
         */
        function durText(ms, cfg) {
            var u = DURATION_UNITS[cfg && cfg.DurationUnit];
            if (!u) { return PVX.fmt.duration(ms); }
            var n = ms / u.ms;
            return PVX.fmt.number(n, { decimals: n >= 100 ? 0 : (n >= 10 ? 1 : 2) }) + ' ' + u.label;
        }

        /** The chosen metric's value as it is drawn on a bar or in a cell. */
        function valueText(v, m, cfg) {
            return m.isDuration ? durText(v, cfg) : PVX.fmt.number(v, { decimals: 0 });
        }

        /** Axis ticks are always a plain number in the resolved unit. */
        function tickText(v, m) {
            return m.isDuration ? PVX.fmt.tick(v / m.unit.ms) : PVX.fmt.tick(v);
        }

        /* ================================================================ *
         * render
         * ================================================================ */

        function render(c) {
            var cfg = liveCfg = c.config || liveCfg;
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            var W = Math.max(40, host.clientWidth || c.width || 40);
            var H = Math.max(24, host.clientHeight || c.height || 24);

            /* The size thresholds are measured against the SYMBOL, not the
             * drawing host — and that is load-bearing, not pedantry. The host is
             * what is left after the header and footer, so measuring it makes
             * the decision depend on the chrome the decision itself removes:
             * drop the summary, the footer shrinks, the host grows past the
             * threshold, the summary comes back, and the symbol oscillates
             * between two layouts on every frame. */
            var rootW = Math.max(40, (c.node && c.node.clientWidth) || W);
            var rootH = Math.max(24, (c.node && c.node.clientHeight) || H);
            var minimal = rootW < MINIMAL_W || rootH < MINIMAL_H;
            var compact = minimal || rootW < COMPACT_W || rootH < COMPACT_H;
            chromeOff = minimal;

            var svgRoot = host.querySelector('svg.pvx-ea-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-ea-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);
            hits = [];

            scope.pvx.title = minimal ? '' : (trim(cfg.Title) || 'Event analytics');
            scope.pvx.subtitle = '';
            scope.pvx.summary = '';
            scope.pvx.note = '';
            scope.pvx.clickable = cfg.ClickAction === 'navigate';
            bindHost(host);

            if (state.phase !== 'ok') {
                drawStatus(svgRoot, W, H, t, minimal);
                digest();
                return;
            }

            model = buildModel(cfg);

            if (!minimal) {
                // The window is dropped from the subtitle on a narrow symbol. It
                // is the least surprising thing on that line — the display's own
                // time bar already says it — and keeping it costs the operator's
                // own title, which nothing else shows.
                scope.pvx.subtitle = subtitleText(model, cfg, rootW >= 420);
            }

            // ---- distinct "the query worked but there is nothing to rank" states
            if (!model.count) {
                drawMessage(svgRoot, W, H, t, 'No events in this window',
                    minimal ? '' : describeFilter(cfg), t.textMuted);
                digest();
                return;
            }
            if (model.allUnassigned && (cfg.GroupBy === 'attribute' || cfg.GroupBy === 'name')) {
                drawMessage(svgRoot, W, H, t, missingGroupHeadline(cfg),
                    minimal ? '' : missingGroupDetail(cfg, model), PVX.color.status.warning);
                if (!minimal) { scope.pvx.note = model.notes.join(' \u00b7 '); }
                if (!minimal && state.db.from) { addNote('database ' + state.db.path + ' from ' + state.db.from); }
                digest();
                return;
            }
            if (model.groupCount === 1 && cfg.GroupBy !== 'none') {
                // A ranking of one is not a ranking. Say what the one group is —
                // that IS the answer — and say what to change to get a breakdown.
                var only = model.items[0];
                drawMessage(svgRoot, W, H, t,
                    'All ' + model.count + ' events are "' + only.label + '"',
                    minimal ? '' :
                    'Nothing to rank by ' + groupByLabel(cfg) + '. ' +
                    valueText(only.value, model, cfg) + ' ' + model.metricLabel.toLowerCase() +
                    '. Group by something that varies, or use the name pattern to pull a reason ' +
                    'code out of the event name.', t.textMuted);
                if (!minimal) { scope.pvx.note = model.notes.join(' \u00b7 '); }
                if (!minimal && state.db.from) { addNote('database ' + state.db.path + ' from ' + state.db.from); }
                digest();
                return;
            }

            if (!compact && cfg.ShowSummary !== false) {
                scope.pvx.summary = summaryText(model, cfg);
            }
            if (!minimal) { scope.pvx.note = model.notes.join(' \u00b7 '); }
            if (!minimal && state.db.from) { addNote('database ' + state.db.path + ' from ' + state.db.from); }

            var mode = chartMode(cfg);
            if (mode === 'donut' && !model.additive) {
                // A donut asserts that the slices make a whole. A mean does not.
                addNote('donut needs an additive metric \u2014 showing bars');
                mode = 'bars';
            }
            // Below the minimal size there is room for bars and nothing else. A
            // donut that small is a ring with no legend and no readable slice
            // labels, and a table is one clipped row — both are worse than the
            // shape comparison the bars still give.
            if (minimal) { mode = 'bars'; }

            if (mode === 'donut') { drawDonut(svgRoot, W, H, cfg, t, model, compact, minimal); }
            else if (mode === 'table') { drawTable(svgRoot, W, H, cfg, t, model, compact); }
            else { drawRanked(svgRoot, W, H, cfg, t, model, compact, minimal, mode === 'pareto'); }

            digest();
        }

        function subtitleText(m, cfg, withRange) {
            var unit = (m.isDuration && cfg.DurationUnit !== 'auto' && cfg.DurationUnit)
                ? ' (' + m.unit.label + ')' : '';
            var s = m.metricLabel + unit + ' by ' + groupByLabel(cfg);
            if (withRange) {
                s += ' \u00b7 ' + PVX.fmt.time(m.from, 'short') + ' \u2013 ' + PVX.fmt.time(m.to, 'short');
            }
            return s;
        }

        /**
         * The footer line. Every number in it is one the operator could be asked
         * to defend: how many events, how much time they consumed, how much of
         * the window that union covers, and what fraction of the window that is.
         */
        function summaryText(m, cfg) {
            var pct = (m.covered / m.windowSpan) * 100;
            // Always a duration, whatever the ranking metric is: "how much time
            // did this cost" is the question the footer answers.
            var bits = [
                m.count + (m.count === 1 ? ' event' : ' events'),
                durText(m.mergedSum, cfg) + ' total'
            ];
            // Coverage is the union across ALL groups, so it is the honest
            // answer to "how much of the window was affected" even when two
            // reason codes overlap in time.
            bits.push(PVX.fmt.duration(m.covered) + ' of ' + PVX.fmt.duration(m.windowSpan) +
                ' (' + PVX.fmt.percent(pct, pct < 10 ? 1 : 0) + ' of window)');
            if (m.openCount) { bits.push(m.openCount + ' open'); }
            return bits.join(' \u00b7 ');
        }

        function describeFilter(cfg) {
            var bits = [];
            if (trim(cfg.TemplateName)) { bits.push('template "' + trim(cfg.TemplateName) + '"'); }
            if (trim(cfg.NameFilter)) { bits.push('name "' + trim(cfg.NameFilter) + '"'); }
            if (trim(cfg.ElementNameFilter)) { bits.push('element "' + trim(cfg.ElementNameFilter) + '"'); }
            return bits.length
                ? 'Nothing matched ' + bits.join(' and ') + '. Widen the filter or the time range.'
                : 'No event frames overlap this time range on ' + state.db.path +
                  (state.db.from ? ' (from ' + state.db.from + ')' : '') + '.';
        }

        function missingGroupHeadline(cfg) {
            if (cfg.GroupBy === 'attribute') {
                return trim(cfg.GroupAttribute)
                    ? 'No event has "' + trim(cfg.GroupAttribute) + '"'
                    : 'No grouping attribute set';
            }
            return 'No event name matched the pattern';
        }

        function missingGroupDetail(cfg, m) {
            if (cfg.GroupBy === 'attribute') {
                if (!trim(cfg.GroupAttribute)) {
                    return 'Grouping by event attribute needs the attribute name — for example "Reason Code". ' +
                           'It must exist on the Event Frame template.';
                }
                return 'All ' + m.count + ' events came back without a value for that attribute. Check the ' +
                       'spelling against the Event Frame template — attribute names are exact — and that the ' +
                       'signed-in user can read it.';
            }
            return 'The pattern "' + trim(cfg.NamePattern) + '" matched none of the ' + m.count +
                   ' event names. Capture group 1 becomes the group, so a pattern like ' +
                   '"- ([A-Z]+)-" pulls MECH out of "Downtime - Mill 1 - MECH-04".';
        }

        /* ---- non-chart states -------------------------------------------- *
         * Four different problems with four different owners. One shared "no
         * data" message would send every one of them to the wrong person.
         */
        function drawStatus(svgRoot, W, H, t, minimal) {
            if (state.phase === 'unconfigured') {
                drawMessage(svgRoot, W, H, t, 'PI Web API is not configured',
                    minimal ? '' :
                    PVX.api.unsetHint() + ', then confirm it ' +
                    'with ext/piwebapi-check.html — that page reproduces exactly what this symbol does ' +
                    'and names what to fix.', PVX.color.status.warning);
                return;
            }
            if (state.phase === 'nodb') {
                drawMessage(svgRoot, W, H, t, 'No AF database configured',
                    minimal ? '' :
                    'Drop an AF attribute onto this symbol to use its database, or set the AF database ' +
                    'path in the format pane, for example \\\\AFSERVER01\\Production.',
                    PVX.color.status.warning);
                return;
            }
            if (state.phase === 'error') {
                var e = (state.error && state.error.pvxError) || null;
                drawMessage(svgRoot, W, H, t, 'PI Web API request failed',
                    minimal ? '' :
                    (e ? e.message + '  \u2014  Check: ' + e.check
                       : 'The request failed and returned no diagnosis.'),
                    PVX.color.status.alarm);
                return;
            }
            drawMessage(svgRoot, W, H, t, 'Loading events\u2026', '', t.textMuted);
        }

        /* ================================================================ *
         * colour
         * ================================================================ */

        function colorFor(item, i, m, cfg, t) {
            var base = trim(cfg.BarColor) || '#3b82c4';
            if (item.isOther) {
                // "Other" is a bucket, not a finding. It is deliberately the
                // quietest mark on the chart so it never out-shouts a real
                // reason code.
                return t.dark ? '#6f7378' : '#9aa4b0';
            }
            if (cfg.ColorMode === 'palette') {
                return PVX.color.categorical[i % PVX.color.categorical.length];
            }
            if (cfg.ColorMode === 'threshold') {
                // A duration threshold is expressed in the DISPLAY unit, which
                // is the only unit the operator saw when they typed the numbers.
                var v = m.isDuration ? item.value / m.unit.ms : item.value;
                return cfg.UseThresholds
                    ? PVX.thresholds.colorFor(cfg.Thresholds, v, base)
                    : base;
            }
            return base;
        }

        /* ================================================================ *
         * ranked bars (pareto / bars)
         * ================================================================ */

        function drawRanked(svgRoot, W, H, cfg, t, m, compact, minimal, withCum) {
            var i;
            var items = m.items;
            var n = items.length;
            var pad = 5;
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 22), 7.5, 12);

            var showValues = !compact && cfg.ShowValues !== false;
            var showAxis = !compact;
            var showCum = withCum && !!m.cum && !compact;
            var cumColor = PVX.color.status.alarm;

            // Label budgets, from the glyph estimate.
            var labels = [];
            var maxValuePx = 0;
            for (i = 0; i < n; i++) {
                labels.push(showValues ? valueText(items[i].value, m, cfg) : '');
                maxValuePx = Math.max(maxValuePx, textW(labels[i], font));
            }

            var nameW = minimal ? 0 : PVX.util.clamp(W * 0.32, 30, W * 0.5);
            var plot = {
                x0: pad + nameW + (nameW > 0 ? 6 : 0),
                y0: pad + (showCum ? font * 1.9 : 0),
                x1: W - pad - (showValues ? maxValuePx + 8 : 0),
                y1: H - pad - (showAxis ? font * 1.9 : 0)
            };
            // Degenerate boxes (tiny symbol, long labels): give the chart the
            // whole frame rather than drawing nothing at all.
            if (plot.x1 - plot.x0 < 24) { plot.x0 = pad; plot.x1 = W - pad; nameW = 0; showValues = false; }
            if (plot.y1 - plot.y0 < 16) { plot.y0 = 1; plot.y1 = H - 1; showAxis = false; }

            var plotW = plot.x1 - plot.x0;
            var plotH = plot.y1 - plot.y0;

            // Durations and counts are non-negative, so the domain starts at
            // zero — a bar chart whose baseline is not zero lies about ratios,
            // and ratios are the entire point of a Pareto.
            var maxV = 0;
            for (i = 0; i < n; i++) { if (items[i].value > maxV) { maxV = items[i].value; } }
            if (!(maxV > 0)) { maxV = 1; }
            var tickCount = PVX.util.clamp(Math.floor(plotW / 70), 2, 6);
            var dom = PVX.scale.niceDomain(0, maxV, tickCount);
            var vs = PVX.scale.linear(0, dom[1], plot.x0, plot.x1);
            var cs = showCum ? PVX.scale.linear(0, 100, plot.x0, plot.x1) : null;

            var slot = plotH / n;
            var thick = Math.max(1.5, Math.min(slot * 0.72, 26));
            var center = function (idx) { return plot.y0 + slot * (idx + 0.5); };
            var radius = PVX.util.clamp(PVX.util.num(cfg.CornerRadius) || 0, 0, Math.min(3, thick / 3));

            // ---- grid + ticks (behind the bars) ---------------------------
            var ticks = showAxis ? PVX.scale.ticks(0, dom[1], tickCount) : [];
            if (showAxis) {
                var gridG = PVX.svg.el('g', { 'class': 'pvx-ea-grid' }, svgRoot);
                for (i = 0; i < ticks.length; i++) {
                    var gx = vs(ticks[i]);
                    PVX.svg.el('line', {
                        x1: gx.toFixed(2), y1: plot.y0.toFixed(2),
                        x2: gx.toFixed(2), y2: plot.y1.toFixed(2),
                        stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-grid-line'
                    }, gridG);
                    // The unit rides on the LAST tick rather than sitting in its
                    // own caption at the origin, where it collided with the "0".
                    // Without it anywhere, "36" on a duration axis is unreadable.
                    var last = i === ticks.length - 1;
                    PVX.svg.text(gridG, gx.toFixed(2), (plot.y1 + font * 1.1).toFixed(2),
                        tickText(ticks[i], m) + (last && m.isDuration ? ' ' + m.unit.label : ''), {
                            'class': 'pvx-svg-label pvx-ea-tick',
                            'text-anchor': last ? 'end' : 'middle',
                            'font-size': font, fill: t.textMuted
                        });
                }
            }

            // Baseline at zero.
            PVX.svg.el('line', {
                x1: plot.x0.toFixed(2), y1: plot.y0.toFixed(2),
                x2: plot.x0.toFixed(2), y2: plot.y1.toFixed(2),
                stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, svgRoot);

            // ---- 80% marker (lives on the cumulative axis) -----------------
            if (showCum && cfg.EightyLine !== false) {
                var ex = cs(80);
                PVX.svg.el('line', {
                    x1: ex.toFixed(2), y1: plot.y0.toFixed(2),
                    x2: ex.toFixed(2), y2: plot.y1.toFixed(2),
                    stroke: cumColor, 'stroke-width': 1, 'stroke-dasharray': '4 3',
                    opacity: 0.75, 'class': 'pvx-ea-eighty'
                }, svgRoot);
            }

            // ---- bars ------------------------------------------------------
            var barsG = PVX.svg.el('g', { 'class': 'pvx-ea-bars' }, svgRoot);
            for (i = 0; i < n; i++) {
                var it = items[i];
                var w = Math.max(1, vs(it.value) - plot.x0);
                var y = center(i) - thick / 2;
                var col = colorFor(it, i, m, cfg, t);

                var grp = PVX.svg.el('g', { 'class': 'pvx-ea-bar' }, barsG);
                if (scope.pvx.clickable) {
                    grp.setAttribute('class', 'pvx-ea-bar pvx-hit-group');
                    grp.setAttribute('data-pvx-i', String(hits.length));
                    hits.push(it);
                }
                PVX.svg.el('path', {
                    d: PVX.svg.roundRect(plot.x0, y, w, thick, radius),
                    fill: col, 'class': 'pvx-ea-shape'
                }, grp);
                PVX.svg.el('title', null, grp).textContent = tipFor(it, m, cfg, i);

                if (showValues && labels[i]) {
                    PVX.svg.text(grp, (plot.x0 + w + 4).toFixed(2), center(i).toFixed(2), labels[i], {
                        'class': 'pvx-svg-value pvx-num pvx-ea-value',
                        'text-anchor': 'start', 'font-size': font, fill: t.text
                    });
                }
            }

            // ---- group names ------------------------------------------------
            if (nameW > 2 && slot >= font * 1.05) {
                var namesG = PVX.svg.el('g', { 'class': 'pvx-ea-names' }, svgRoot);
                for (i = 0; i < n; i++) {
                    var avail = Math.min(nameW - 4, plot.x0 - 7);
                    var nt = PVX.svg.text(namesG, (plot.x0 - 6).toFixed(2), center(i).toFixed(2),
                        fitText(items[i].label, avail, font), {
                            'class': 'pvx-svg-label pvx-ea-name',
                            'text-anchor': 'end', 'font-size': font,
                            // "(unassigned)" is not a reason code; it is a gap in
                            // the data, and it reads as one.
                            fill: items[i].unassigned ? PVX.color.status.warning : t.text
                        });
                    fitTextTo(nt, avail);
                    PVX.svg.el('title', null, nt).textContent = items[i].label;
                }
            }

            // ---- cumulative line -------------------------------------------
            if (showCum) {
                var pts = [];
                for (i = 0; i < n; i++) { pts.push({ x: cs(m.cum[i]), y: center(i) }); }
                var lineG = PVX.svg.el('g', { 'class': 'pvx-ea-cum' }, svgRoot);
                if (pts.length > 1) {
                    PVX.svg.el('path', {
                        d: PVX.svg.line(pts, false), fill: 'none', stroke: cumColor,
                        'stroke-width': 1.6, 'stroke-linejoin': 'round', 'stroke-linecap': 'round'
                    }, lineG);
                }
                for (i = 0; i < pts.length; i++) {
                    var mk2 = PVX.svg.el('circle', {
                        cx: pts[i].x.toFixed(2), cy: pts[i].y.toFixed(2),
                        r: Math.max(1.6, Math.min(3, thick * 0.18)).toFixed(1),
                        fill: cumColor,
                        stroke: t.surface === 'transparent' ? 'none' : t.surface,
                        'stroke-width': 0.8
                    }, lineG);
                    PVX.svg.el('title', null, mk2).textContent =
                        items[i].label + ' \u00b7 cumulative ' + m.cum[i].toFixed(1) + '%';
                }
                /* Secondary axis above the plot, in the line's own colour so it
                 * is never mistaken for the value axis.
                 *
                 * Candidates are placed in order of importance and any that
                 * would collide with one already placed is dropped. 80% and
                 * 100% are only 20% of the width apart, so on a narrow symbol a
                 * fixed set of ticks prints "80%100%" as one word — which is
                 * worse than three readable ticks. */
                var cumFont = font * 0.9;
                var cumTicks = [0, 100, 80, 50];
                var placed = [];
                // One label is centred and its neighbour is end-anchored, so the
                // clearance needed is one full label plus half of another, not
                // one label width.
                var minGap = textW('100%', cumFont) * 2.2 + 6;
                for (i = 0; i < cumTicks.length; i++) {
                    var px = cs(cumTicks[i]);
                    var clash = false;
                    for (var q = 0; q < placed.length; q++) {
                        if (Math.abs(px - placed[q]) < minGap) { clash = true; break; }
                    }
                    if (clash) { continue; }
                    placed.push(px);
                    PVX.svg.text(svgRoot, px.toFixed(2), (plot.y0 - font * 0.85).toFixed(2),
                        cumTicks[i] + '%', {
                            'class': 'pvx-svg-label pvx-ea-cumtick',
                            'text-anchor': cumTicks[i] === 100 ? 'end' : (cumTicks[i] === 0 ? 'start' : 'middle'),
                            'font-size': cumFont, fill: cumColor
                        });
                }
            }
        }

        /* ================================================================ *
         * donut — contribution
         * ================================================================ */

        function drawDonut(svgRoot, W, H, cfg, t, m, compact, minimal) {
            var i;
            var items = m.items;
            var n = items.length;
            var total = m.total;
            if (!(total > 0)) {
                drawMessage(svgRoot, W, H, t, 'Nothing to divide up', '', t.textMuted);
                return;
            }

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 18), 7.5, 12);
            // A legend only when the box is wide enough to hold one without
            // eating the ring; otherwise the slices carry their own labels.
            // The budget is whatever is left once the ring has its square, so on
            // a wide symbol the legend takes the surplus rather than a fixed
            // fraction — a fraction was ellipsising "Planned maintenance" beside
            // 200px of empty canvas.
            var legendW = (!compact && W > H * 1.5)
                ? PVX.util.clamp(W - H * 1.15, 90, 260) : 0;
            var boxW = W - legendW;
            var cx = boxW / 2;
            var cy = H / 2;
            var r = Math.max(8, Math.min(boxW, H) / 2 - 6);
            var inner = r * 0.58;

            var g = PVX.svg.el('g', { 'class': 'pvx-ea-donut' }, svgRoot);
            var angle = 0;
            for (i = 0; i < n; i++) {
                var frac = items[i].value / total;
                var sweep = frac * 360;
                if (!(sweep > 0.05)) { continue; }
                var col = colorFor(items[i], i, m, cfg, t);
                var seg = PVX.svg.el('g', { 'class': 'pvx-ea-slice' }, g);
                if (scope.pvx.clickable) {
                    seg.setAttribute('class', 'pvx-ea-slice pvx-hit-group');
                    seg.setAttribute('data-pvx-i', String(hits.length));
                    hits.push(items[i]);
                }
                PVX.svg.el('path', {
                    d: PVX.svg.annulus(cx, cy, inner, r, angle, angle + sweep),
                    fill: col,
                    stroke: t.surface === 'transparent' ? 'none' : t.surface,
                    'stroke-width': 0.8
                }, seg);
                PVX.svg.el('title', null, seg).textContent = tipFor(items[i], m, cfg, i);

                // Only slices with room get a label drawn on them; a 2% slice
                // with a number jammed over it is noise.
                if (!compact && frac > 0.07) {
                    var mid = PVX.svg.polar(cx, cy, (inner + r) / 2, angle + sweep / 2);
                    PVX.svg.text(seg, mid.x.toFixed(2), mid.y.toFixed(2),
                        Math.round(frac * 100) + '%', {
                            'class': 'pvx-svg-value pvx-num pvx-ea-slicelabel',
                            'text-anchor': 'middle', 'font-size': Math.min(font, (r - inner) * 0.8),
                            fill: PVX.color.readable(col)
                        });
                }
                angle += sweep;
            }

            // Centre: the total the ring adds up to, so the percentages have a
            // denominator on screen rather than in someone's head.
            if (inner > font * 1.6) {
                // The hole is a circle, so the usable width at the text's own
                // baseline is a chord, not the diameter — 1.7r rather than 2r.
                var holeW = inner * 1.7;
                var ct = PVX.svg.text(g, cx.toFixed(2), (cy - font * 0.35).toFixed(2),
                    fitText(valueText(total, m, cfg), holeW, font * 1.05), {
                        'class': 'pvx-svg-value pvx-num pvx-ea-center',
                        'text-anchor': 'middle', 'font-size': (font * 1.05).toFixed(1), fill: t.text
                    });
                // Centre-anchored, so an under-estimate spills out of BOTH sides
                // of the ring at once. Two measurements a frame is affordable.
                fitTextTo(ct, holeW);
                if (inner > font * 2.6) {
                    var cs2 = PVX.svg.text(g, cx.toFixed(2), (cy + font * 0.9).toFixed(2),
                        fitText(m.metricLabel, holeW, font * 0.8), {
                            'class': 'pvx-svg-label pvx-ea-centersub',
                            'text-anchor': 'middle', 'font-size': (font * 0.8).toFixed(1), fill: t.textMuted
                        });
                    fitTextTo(cs2, holeW);
                }
            }

            // ---- legend -----------------------------------------------------
            if (legendW > 0) {
                var rowH = Math.min(font * 1.6, H / Math.max(1, n));
                if (rowH >= font * 1.05) {
                    var lg = PVX.svg.el('g', { 'class': 'pvx-ea-legend' }, svgRoot);
                    var top = Math.max(2, (H - n * rowH) / 2);
                    var lx = boxW + 6;
                    for (i = 0; i < n; i++) {
                        var ly = top + i * rowH;
                        PVX.svg.el('rect', {
                            x: lx.toFixed(1), y: (ly + rowH / 2 - font * 0.35).toFixed(1),
                            width: (font * 0.7).toFixed(1), height: (font * 0.7).toFixed(1),
                            rx: 1.5, fill: colorFor(items[i], i, m, cfg, t)
                        }, lg);
                        var txt = items[i].label + '  ' + valueText(items[i].value, m, cfg);
                        var lt = PVX.svg.text(lg, (lx + font).toFixed(1), (ly + rowH / 2).toFixed(1),
                            fitText(txt, legendW - font - 10, font * 0.92), {
                                'class': 'pvx-svg-label pvx-ea-legendtext',
                                'text-anchor': 'start', 'font-size': (font * 0.92).toFixed(1),
                                fill: items[i].unassigned ? PVX.color.status.warning : t.text
                            });
                        PVX.svg.el('title', null, lt).textContent = tipFor(items[i], m, cfg, i);
                    }
                }
            }
        }

        /* ================================================================ *
         * table — the same ranking, as numbers
         * ================================================================ */

        function drawTable(svgRoot, W, H, cfg, t, m, compact) {
            var i;
            var items = m.items;
            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 20), 7.5, 12);
            var pad = 6;
            // The tightest row that is still readable. It decides how many rows
            // FIT; it is not necessarily the row height that gets drawn.
            var minRowH = PVX.util.clamp(font * 1.75, font + 3, 26);

            // How many rows physically fit, header included. Truncation here is
            // the box being too short, which is a different limit from TopN and
            // needs its own note.
            var capacity = Math.max(1, Math.floor((H - pad * 2) / minRowH) - 1);
            var rows = items;
            if (rows.length > capacity) {
                addNote('+' + (rows.length - capacity) + ' rows below the fold');
                rows = rows.slice(0, capacity);
            }
            // Then spread whatever is left over the rows that survived, so a
            // short table does not sit as a dense block above half a screen of
            // nothing. Capped, or three rows on a tall symbol become bands.
            var rowH = PVX.util.clamp((H - pad * 2) / (rows.length + 1), minRowH, 30);

            // Columns are dropped right-to-left as the box narrows: the group
            // and its total are the answer, the rest is supporting detail.
            var wMean = (!compact && W > 300) ? Math.max(52, W * 0.16) : 0;
            var wTotal = Math.max(52, W * 0.18);
            var wCount = (W > 200) ? Math.max(30, W * 0.10) : 0;
            var xRight = W - pad;
            var xMean = xRight;
            var xTotal = xRight - wMean;
            var xCount = xTotal - wTotal;
            var nameRight = xCount - (wCount ? wCount : 0) - 6;

            var g = PVX.svg.el('g', { 'class': 'pvx-ea-table' }, svgRoot);
            var y = pad + rowH * 0.5;

            var head = function (x, text, anchor) {
                PVX.svg.text(g, x.toFixed(1), y.toFixed(1), text, {
                    'class': 'pvx-svg-label pvx-ea-th', 'text-anchor': anchor,
                    'font-size': (font * 0.9).toFixed(1), fill: t.textMuted
                });
            };
            head(pad, groupByLabel(cfg), 'start');
            if (wCount) { head(xCount, 'n', 'end'); }
            head(xTotal, 'total', 'end');
            if (wMean) { head(xMean, 'mean', 'end'); }

            PVX.svg.el('line', {
                x1: pad, y1: (y + rowH * 0.42).toFixed(1),
                x2: (W - pad).toFixed(1), y2: (y + rowH * 0.42).toFixed(1),
                stroke: t.border, 'stroke-width': 1, 'class': 'pvx-grid-line'
            }, g);

            for (i = 0; i < rows.length; i++) {
                var it = rows[i];
                y += rowH;
                if (i % 2 === 1) {
                    PVX.svg.el('rect', {
                        x: pad - 2, y: (y - rowH * 0.5).toFixed(1),
                        width: (W - pad * 2 + 4).toFixed(1), height: rowH.toFixed(1),
                        fill: t.grid, 'class': 'pvx-ea-rowband'
                    }, g);
                }

                var rowG = PVX.svg.el('g', { 'class': 'pvx-ea-row' }, g);
                if (scope.pvx.clickable) {
                    rowG.setAttribute('class', 'pvx-ea-row pvx-hit-group');
                    rowG.setAttribute('data-pvx-i', String(hits.length));
                    hits.push(it);
                }
                // An invisible hit rectangle: SVG text only reacts over its own
                // glyphs, so without this the tooltip is unreachable in the gaps.
                PVX.svg.el('rect', {
                    x: pad - 2, y: (y - rowH * 0.5).toFixed(1),
                    width: (W - pad * 2 + 4).toFixed(1), height: rowH.toFixed(1),
                    fill: 'transparent'
                }, rowG);
                PVX.svg.el('title', null, rowG).textContent = tipFor(it, m, cfg, i);

                var nt = PVX.svg.text(rowG, pad.toFixed(1), y.toFixed(1),
                    fitText(it.label, Math.max(10, nameRight - pad), font), {
                        'class': 'pvx-svg-label pvx-ea-td', 'text-anchor': 'start',
                        'font-size': font, fill: it.unassigned ? PVX.color.status.warning : t.text
                    });
                fitTextTo(nt, Math.max(10, nameRight - pad));

                if (wCount) {
                    PVX.svg.text(rowG, xCount.toFixed(1), y.toFixed(1), String(it.count), {
                        'class': 'pvx-svg-label pvx-num pvx-ea-td', 'text-anchor': 'end',
                        'font-size': font, fill: t.textMuted
                    });
                }
                // Total and mean are always TIME, whatever the ranking metric
                // is: the table exists to show the accounting behind the rank,
                // and "3" in a total column would be a count pretending to be
                // an amount of downtime.
                PVX.svg.text(rowG, xTotal.toFixed(1), y.toFixed(1),
                    durText(it.merged, cfg), {
                        'class': 'pvx-svg-value pvx-num pvx-ea-td', 'text-anchor': 'end',
                        'font-size': font, fill: t.text
                    });
                if (wMean) {
                    PVX.svg.text(rowG, xMean.toFixed(1), y.toFixed(1),
                        durText(it.count ? it.rawSum / it.count : 0, cfg), {
                            'class': 'pvx-svg-label pvx-num pvx-ea-td', 'text-anchor': 'end',
                            'font-size': font, fill: t.textMuted
                        });
                }
            }
        }

        /* ---- tooltip: the source of truth behind every truncated label ---- */
        function tipFor(it, m, cfg, i) {
            var lines = [it.label];
            lines.push(it.count + (it.count === 1 ? ' event' : ' events'));
            lines.push('Total (overlap merged): ' + PVX.fmt.duration(it.merged));
            if (it.rawSum > it.merged + 500) {
                lines.push('Raw sum of durations: ' + PVX.fmt.duration(it.rawSum));
            }
            lines.push('Mean: ' + PVX.fmt.duration(it.count ? it.rawSum / it.count : 0));
            lines.push('Longest: ' + PVX.fmt.duration(it.max));
            if (it.open) {
                lines.push(it.open + (it.open === 1 ? ' event is' : ' events are') + ' still open');
            }
            if (m.total > 0 && m.additive) {
                lines.push('Share of ' + m.metricLabel.toLowerCase() + ': ' +
                    PVX.fmt.percent((it.value / m.total) * 100, 1));
            }
            if (m.cum && m.cum[i] !== undefined) {
                lines.push('Cumulative: ' + m.cum[i].toFixed(1) + '%');
            }
            if (it.isOther) {
                lines.push('Combined from ' + m.otherCount + ' smaller groups');
            }
            return lines.join('\n');
        }

        /* ================================================================ *
         * messages
         * ================================================================ */

        function drawMessage(svgRoot, W, H, t, headline, detail, tone) {
            var avail = Math.max(24, W - 16);
            var hFont = PVX.util.clamp(Math.min(W / 20, H / 8), 8, 13);
            if (textW(headline, hFont) > avail) {
                hFont = PVX.util.clamp(avail / (String(headline).length * 0.56), 7, hFont);
            }
            var dFont = Math.max(7, hFont * 0.82);

            var lines = detail ? wrapText(detail, avail, dFont, 5) : [];
            var lineH = dFont * 1.28;
            var block = hFont * 1.3 + (lines.length ? lines.length * lineH + 3 : 0);
            var top = Math.max(hFont, (H - block) / 2 + hFont * 0.8);

            var head = PVX.svg.text(svgRoot, (W / 2).toFixed(1), top.toFixed(1),
                fitText(headline, avail, hFont), {
                    'class': 'pvx-svg-label pvx-ea-msg-head', 'text-anchor': 'middle',
                    'font-size': hFont.toFixed(1), 'font-weight': '600', fill: tone || t.textMuted
                });
            // A centred line spills past BOTH edges once it is wider than the
            // frame, and the glyph estimate can be a few pixels out. This runs
            // at most six times, only when there is nothing to chart.
            fitTextTo(head, avail);

            for (var i = 0; i < lines.length; i++) {
                var ln = PVX.svg.text(svgRoot, (W / 2).toFixed(1),
                    (top + hFont * 0.6 + (i + 1) * lineH).toFixed(1), lines[i], {
                        'class': 'pvx-svg-label pvx-ea-msg-body', 'text-anchor': 'middle',
                        'font-size': dFont.toFixed(1), fill: t.textMuted
                    });
                fitTextTo(ln, avail);
            }
        }

        /** Greedy word wrap on the same glyph-width estimate used elsewhere. */
        function wrapText(str, maxPx, fontPx, maxLines) {
            var words = String(str).split(/\s+/);
            var perChar = fontPx * 0.56;
            var max = Math.max(4, Math.floor(maxPx / perChar));
            var lines = [];
            var cur = '';
            for (var i = 0; i < words.length; i++) {
                var next = cur ? cur + ' ' + words[i] : words[i];
                if (next.length <= max) { cur = next; continue; }
                if (cur) { lines.push(cur); }
                cur = words[i].length > max ? words[i].slice(0, max - 1) + '\u2026' : words[i];
                if (lines.length >= maxLines) { break; }
            }
            if (cur && lines.length < maxLines) { lines.push(cur); }
            if (lines.length === maxLines) {
                var lastLine = lines[maxLines - 1];
                if (lastLine.charAt(lastLine.length - 1) !== '\u2026') {
                    lines[maxLines - 1] = lastLine.slice(0, Math.max(1, max - 1)) + '\u2026';
                }
            }
            return lines;
        }

        /**
         * Trim an already-drawn <text> until it measures inside `maxPx`.
         *
         * The 0.56em estimate is fine for numbers, which are start- or
         * centre-anchored and only shift a few pixels when it is wrong. Group
         * names are END-anchored against the left edge of the symbol, so an
         * under-estimate pushes the string's START off-canvas, where the host's
         * overflow:hidden chops the first glyph instead of ellipsising. There is
         * no clamp that fixes that after the fact — the text has to be short
         * enough. The caller passes text already cut by the estimate, so the
         * common case measures once and returns.
         */
        function fitTextTo(node, maxPx) {
            if (!node || !node.getComputedTextLength) { return; }
            if (!(maxPx > 0)) { node.textContent = ''; return; }
            var measure = function () {
                try { return node.getComputedTextLength(); } catch (e) { return 0; }
            };
            for (var guard = 0; guard < 8; guard++) {
                var w = measure();
                if (!(w > maxPx)) { return; }
                var cur = node.textContent || '';
                var core = cur.charAt(cur.length - 1) === '\u2026' ? cur.slice(0, -1) : cur;
                if (core.length < 2) { node.textContent = ''; return; }
                var keep = Math.min(core.length - 1, Math.floor(core.length * (maxPx / w)) - 1);
                if (keep < 1) { node.textContent = ''; return; }
                node.textContent = core.slice(0, keep) + '\u2026';
            }
            if (measure() > maxPx) { node.textContent = ''; }
        }

        /* ================================================================ *
         * interaction
         * ================================================================ */

        /** Appends to the footer note, unless the box is too small to have one. */
        function addNote(text) {
            if (chromeOff) { return; }
            scope.pvx.note = (scope.pvx.note ? scope.pvx.note + ' \u00b7 ' : '') + text;
        }

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            if (!host || !host.addEventListener) { return; }
            host.addEventListener('click', onClick, false);
            boundHost = host;
        }

        function unbindHost() {
            if (boundHost && boundHost.removeEventListener) {
                try { boundHost.removeEventListener('click', onClick, false); } catch (e) { /* ignore */ }
            }
            boundHost = null;
        }

        function onClick(ev) {
            if (liveCfg.ClickAction !== 'navigate') { return; }
            var node = ev.target;
            var guard = 0;
            while (node && node !== boundHost && guard < 12) {
                if (node.getAttribute && node.getAttribute('data-pvx-i') !== null) {
                    activate(parseInt(node.getAttribute('data-pvx-i'), 10));
                    return;
                }
                node = node.parentNode;
                guard += 1;
            }
        }

        /**
         * Navigate to the configured display over the clicked group's own span —
         * first event start to last event end. The reason to click a reason code
         * is to go and look at what the plant was doing while it was happening.
         */
        function activate(index) {
            if (!(index >= 0) || index >= hits.length) { return; }
            var it = hits[index];
            var target = trim(liveCfg.NavigateTarget);
            if (!target) { return; }
            var pad = Math.max(60000, (it.last - it.first) * 0.05);
            PVX.nav.go(PVX.nav.url({
                display: target,
                start: isoOf(it.first - pad),
                end: isoOf(it.last + pad)
            }), false);
        }

        /* ================================================================ *
         * plumbing
         * ================================================================ */

        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-surface', c.config.Transparent ? 'transparent' : t.surface);
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
        }

        /* Rendering happens in a rAF and data arrives in a Promise callback —
         * both outside Angular's digest — so the scope.pvx writes need an
         * explicit (guarded) digest. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        /* ---- go ------------------------------------------------------------ */
        lastHashKey = hashKey();
        hashTimer = setInterval(pollHash, 1000);
        hashListener = function () { pollHash(); };
        try { window.addEventListener('hashchange', hashListener, false); } catch (e) { hashListener = null; }
        ensureTimers(liveCfg);
        refresh();

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
