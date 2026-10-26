/* ============================================================================
 * pvxEventGantt — "PVX Event Timeline"
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read: its one data source only gets it into the
 * symbol selector (see the definition). This is the first symbol in the library whose data does not
 * come from PI Vision's data pipeline at all — it comes from PI Web API, through
 * PVX.api, and everything about the symbol follows from that one fact.
 *
 * WHY A GANTT AND NOT A LIST
 *   PI Vision's native Events Table is a list, and a list answers "what
 *   happened". It cannot answer "did these three mills stop at the same time",
 *   "is this asset short-cycling", or "how much of the shift is red" — those are
 *   questions about overlap, clustering and pattern, and they are only visible
 *   when events are drawn against a shared time axis in swimlanes. That is the
 *   entire reason to look at events rather than read them.
 *
 * CONSEQUENCES OF HAVING NO DATA PIPELINE
 *   1. onDataUpdate only carries the placeholder data source, which says
 *      nothing about events. PI Vision will not tell this symbol when to
 *      refresh, so the symbol runs its own timer (see REFRESH below).
 *   2. Nothing tells the symbol the display's time range either. The operator
 *      still expects the chart to follow the display's time controls, and the
 *      only place that range is exposed to display code — on every PI Vision
 *      release, without touching a private Angular service — is the URL:
 *          #/Displays/42/Unit-1?starttime=*-8h&endtime=*
 *      So the window is read from PVX.nav.parseHash().params, falling back to
 *      this symbol's own StartTime/EndTime config when the URL carries neither
 *      (a new display, a standalone preview, an embedded iframe).
 *   3. Every timer and listener is the symbol's own property, so every one of
 *      them is torn down in onDestroy. A leaked poller on a control-room kiosk
 *      does not stop when the operator navigates away; it runs for weeks.
 *
 * DATA ACCESS
 *   All requests go through PVX.api — never a raw XMLHttpRequest. The site's
 *   authentication strategy (Kerberos, bearer, basic, anonymous) is a property
 *   of the DEPLOYMENT, configured once in ext/libraries/pvx/pvx-config.js, and this
 *   symbol neither knows nor cares which one is live.
 *
 *   - The AF database is resolved once per database path and cached for the life
 *     of the symbol: it is a stable identifier, and re-resolving it on every
 *     60-second tick would double the request count for no information.
 *   - Event Frames are fetched with an explicit `selectedFields` list. Without
 *     it PI Web API returns the whole object graph for every event — security
 *     descriptors, category names, extended properties — which on 500 events is
 *     megabytes of payload for six fields we actually draw.
 *   - Anything that needs a per-event follow-up (the referenced element's name,
 *     an attribute value to colour by) goes through ONE PVX.api.batch() call.
 *     As individual requests that would be one authentication handshake and one
 *     CORS preflight per event; as a batch it is one of each. Sub-request
 *     failures are counted and reported in the footer rather than silently
 *     dropping the assets that failed.
 *
 * HIERARCHY MODE (LaneBy: 'hierarchy')
 *   Batch processes and anything else modelled as parent and child Event
 *   Frames (batch -> unit procedure -> operation -> phase) have a second
 *   question a swimlane cannot answer: WHICH STEP of this batch ran long. Here
 *   every frame gets its own row, children indented under their parent in
 *   start order, the way a trace waterfall draws spans. Colour by 'typical'
 *   compares each frame against the median of its siblings-in-kind across the
 *   window (same template and, below the root, the same name), and a tick on
 *   the bar marks where the typical duration would have ended — so "the heat
 *   phase of 1042 ran 40% long" is visible without reading a number.
 *
 *   The tree is fetched a LEVEL at a time: the database search returns roots
 *   only, then one PVX.api.batch() per level asks each frame that HasChildren
 *   for its direct children. MaxDepth bounds the round trips, MaxEvents bounds
 *   the total, and both cuts are reported rather than silently applied.
 *
 * RENDERING
 *   One imperative SVG into `.pvx-egantt-body`. An ng-repeat over lanes x events
 *   would put thousands of watchers into the digest loop of a display that
 *   refreshes every minute; only the header/footer chrome is Angular-bound.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below these sizes the symbol progressively sheds furniture rather than
     * drawing an illegible version of the full chart. */
    var COMPACT_W = 240, COMPACT_H = 160;   // drop event labels + summary
    var MINIMAL_W = 140, MINIMAL_H = 100;   // bars only

    var AXIS_H = 15;          // time-axis strip
    var MIN_LANE_H = 9;       // a lane thinner than this is a smear, not a lane
    var LANE_GAP = 2;         // vertical breathing room inside a lane
    var MIN_BAR_H = 2;

    /* Offsets accepted in a PI time expression. 'mo' and 'y' are calendar-ish
     * units that PI resolves properly; here they are only used to place the axis,
     * and a month-accurate axis on a chart whose bars are minutes long buys
     * nothing — so 30d / 365d approximations are deliberate and harmless. */
    var UNIT_MS = {
        ms: 1, s: 1000, m: 60000, h: 3600000,
        d: 86400000, w: 604800000, mo: 2592000000, y: 31536000000
    };

    var definition = {
        typeName: 'pvxEventGantt',
        displayName: 'PVX Event Timeline',

        // One data source, which this symbol ignores: everything it shows comes
        // from its config pane. PI Vision keeps DatasourceBehaviors.None symbols
        // out of the symbol selector altogether (its guide calls them "static
        // symbols"), so declared that way this could never be placed on a
        // display. Pick it and drop any attribute to create it.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        // A collection would repeat the whole timeline once per element, which
        // destroys the only thing a Gantt is for: seeing assets against each
        // other on one shared axis.
        supportsCollections: false,
        configTitle: 'Format Event Timeline',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                // The cheapest query PI Vision has, for a value nothing reads.
                DataShape: 'Value',
                Height: 300,
                Width: 620,

                Title: 'Event timeline',
                ShowLabel: true,

                /* -- what to fetch ------------------------------------------ */
                DatabasePath: '',          // \\AFSERVER01\Production
                TemplateName: '',          // one Event Frame template
                NameFilter: '',            // wildcard, e.g. Downtime*
                ElementNameFilter: '',     // wildcard on the referenced element
                // Follow the display's asset. A template display (one Area
                // Overview serving every area) needs the events of the area it
                // is showing; a name wildcard cannot follow an asset swap.
                AssetScope: 'none',        // none | asset | assetTree
                MaxScopeElements: 200,     // assetTree: elements searched below the asset
                SearchMode: 'Overlapped',
                MaxEvents: 500,
                RefreshSeconds: 60,

                /* -- time window fallback ------------------------------------ *
                 * Only used when the display URL carries no starttime/endtime.
                 * PI time grammar, same as PI Vision's own time bar. */
                StartTime: '*-8h',
                EndTime: '*',

                /* -- shape ---------------------------------------------------- */
                LaneBy: 'element',         // element | template | none | hierarchy
                MaxLanes: 20,
                MaxDepth: 3,               // hierarchy: levels fetched, roots included

                /* -- colour --------------------------------------------------- */
                ColorBy: 'template',       // template | duration | attribute | single | typical
                ColorAttribute: '',
                TypicalTolerancePct: 20,   // typical: longer than median by this much = long
                SingleColor: '#3b82c4',

                /* -- chrome --------------------------------------------------- */
                ShowNowLine: true,
                ShowGrid: true,
                TimeTickCount: 6,
                ShowLabels: true,
                ShowDurations: true,
                MinBarPx: 3,
                ShowOpenEvents: true,
                ShowSummary: true,

                /* -- interaction ---------------------------------------------- */
                ClickAction: 'none',       // none | navigate
                NavigateTarget: '',

                /* -- deployment ------------------------------------------------ *
                 * Normally blank: the base URL belongs in ext/libraries/pvx/pvx-config.js
                 * where one site setting serves every symbol. Set it here only to
                 * point this symbol at a SECOND PI Web API (a test instance, a
                 * different plant's server). See the config pane hint — it moves
                 * the base URL for the whole page, not just this symbol. */
                BaseUrlOverride: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the chart itself is SVG.
        scope.pvx = {
            title: '',
            range: '',
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
            error: null,          // the rejection from PVX.api, carrying .pvxError
            events: [],
            capped: false,        // more events matched than MaxEvents
            maxEvents: 0,
            failedBatch: 0,       // failed sub-requests in the enrichment batch
            win: null,            // the window the current events were fetched for
            tree: null,           // hierarchy mode: expansion outcome (see expandChildren)
            scopeCapped: false,   // assetTree: more elements below the asset than searched
            scopeFailed: 0,       // assetTree: element searches that failed
            db: { path: '', from: '' }   // database in use; `from` set when not configured
        };

        var liveCfg = scope.config || {};
        var generation = 0;       // bumps on every refresh; stale replies are dropped

        // Caches that outlive a refresh. Both are keyed by something stable
        // (an AF path, an element WebId), so they can never go stale in a way
        // that changes what is drawn — only in a way that saves a request.
        var dbCache = {};         // AF database path -> Promise of WebId
        var elemNames = {};       // element WebId  -> element Name
        var assetCache = {};      // asset path + scope -> Promise of [element WebId]
        var sourceAsset = '';     // element of the placeholder data source

        var refreshTimer = null;
        var hashTimer = null;
        var debounceTimer = null;
        var timerSeconds = null;  // the RefreshSeconds the current timer was built for
        var lastHashKey = null;
        var hashListener = null;

        var boundHost = null;     // host carrying the delegated click listener
        var hits = [];            // drawn bars, indexed by data-pvx-i
        var model = null;
        var chromeOff = false;    // true below the minimal size: bars only

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-egantt-body',
            render: render,

            // The data source is otherwise ignored, but its element is the
            // asset to scope to when the URL names none, and PI Vision
            // re-binds it on an asset swap.
            onData: function (d) {
                var one = PVX.data.single(d);
                var a = one ? PVX.nav.assetOf(one.path) : '';
                if (a !== sourceAsset) {
                    sourceAsset = a;
                    // A blank DatabasePath follows this element's database too.
                    if ((trim(liveCfg.AssetScope) && liveCfg.AssetScope !== 'none') ||
                            !trim(liveCfg.DatabasePath)) { refreshSoon(); }
                }
            },

            onConfigChange: function (newCfg) {
                liveCfg = newCfg || liveCfg;
                ensureTimers(liveCfg);
                // Debounced: the config pane fires this on every keystroke in
                // the database path, and each one would otherwise be a PI Web
                // API round trip against a half-typed path.
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

        function numIn(v, lo, hi, fallback) {
            var n = PVX.util.num(v);
            if (n === null) { return fallback; }
            return PVX.util.clamp(n, lo, hi);
        }

        function firstNonEmpty(list) {
            for (var i = 0; i < list.length; i++) {
                var s = trim(list[i]);
                if (s) { return s; }
            }
            return '';
        }

        function isoOf(ms) {
            return new Date(ms).toISOString();
        }

        /** Average-glyph-width estimate. Measuring properly forces a layout per
         *  label, and this chart draws hundreds of them per frame. */
        function textW(s, fontPx) {
            return String(s === null || s === undefined ? '' : s).length * fontPx * 0.55;
        }

        function fitText(s, maxPx, fontPx) {
            var str = String(s === null || s === undefined ? '' : s);
            var max = Math.floor(maxPx / (fontPx * 0.55));
            if (max < 1) { return ''; }
            if (str.length <= max) { return str; }
            if (max === 1) { return '\u2026'; }
            return str.slice(0, max - 1) + '\u2026';
        }

        /* ================================================================ *
         * PI time expressions
         * ================================================================ *
         * The display's window arrives as PI time text — '*-8h', 't', '*'. PI
         * Web API understands that grammar natively, so the simplest thing would
         * be to forward the string. We parse it locally instead and send ISO
         * timestamps, because the AXIS has to agree with the QUERY exactly: if
         * the server resolves '*' half a second after we draw the axis, every
         * bar is a fraction of a pixel out and the "now" line lands in the wrong
         * place. One resolved instant, used for both, cannot disagree with
         * itself.
         *
         * When an expression is beyond this parser (PI's grammar is larger than
         * what any display ever uses), we hand the ORIGINAL text to PI Web API —
         * which is authoritative — and take the axis from the events that come
         * back. Guessing a window we could not parse would be worse than saying
         * so, and the footer says so.
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
                // Absolute timestamp. Date parsing of anything non-ISO is
                // implementation-defined, so an unparseable string returns null
                // rather than a plausible-looking wrong answer.
                var d = PVX.fmt.toDate(raw);
                return d ? d.getTime() : null;
            }

            if (!rest) { return anchor; }

            // One or more signed offset terms: '-8h', '+30m', '-1d+6h'.
            // 'mo' and 'ms' precede 'm' in the alternation or they would never
            // match — the regex engine takes the first alternative that fits.
            var re = /([+-])(\d+(?:\.\d+)?)(mo|ms|s|m|h|d|w|y)/g;
            var total = 0, consumed = 0, m;
            while ((m = re.exec(rest)) !== null) {
                total += (m[1] === '-' ? -1 : 1) * parseFloat(m[2]) * UNIT_MS[m[3]];
                consumed += m[0].length;
            }
            // A partially-understood expression is not understood. Anything left
            // over means this parser is guessing, so it declines instead.
            if (!consumed || consumed !== rest.length) { return null; }
            return anchor + total;
        }

        /**
         * The window this symbol should show.
         *
         * URL first, config second. The URL is where PI Vision's own time bar
         * writes, so following it is what makes the symbol obey the display's
         * time controls despite having no data pipeline to be told through.
         */
        function resolveWindow(cfg) {
            var params = {};
            try { params = PVX.nav.parseHash().params || {}; } catch (e) { params = {}; }

            // PI Vision writes these lower-case; other tooling that builds deep
            // links is less careful, so both spellings are accepted.
            var startExpr = firstNonEmpty([params.starttime, params.StartTime, cfg.StartTime, '*-8h']);
            var endExpr = firstNonEmpty([params.endtime, params.EndTime, cfg.EndTime, '*']);

            var now = (new Date()).getTime();
            var from = parsePiTime(startExpr, now);
            var to = parsePiTime(endExpr, now);
            var parsed = from !== null && to !== null && to > from;

            if (!parsed) {
                // Placeholder only — replaced by the extent of the events that
                // come back, because the server is the one that understood the
                // expression.
                from = now - 8 * 3600000;
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
                   String(p.endtime || p.EndTime || '') + '|' +
                   String(p.asset || '');
        }

        /* ================================================================ *
         * PI Web API
         * ================================================================ */

        /**
         * Point PVX.api at a different PI Web API.
         *
         * This writes the LIBRARY's settings, not this symbol's — PVX.api is a
         * single shared client, deliberately, so that authentication is
         * configured once per site. That makes the override a page-wide switch;
         * the config pane says so.
         */
        function applyBaseUrlOverride(cfg) {
            var override = trim(cfg.BaseUrlOverride);
            if (!override) { return; }
            if (PVX.api.settings.baseUrl === override) { return; }
            PVX.api.configure({ baseUrl: override });
            // The shared GET cache is keyed by URL, so entries from the previous
            // base cannot be returned by mistake; dropping them anyway keeps the
            // switch clean and costs one refresh.
            PVX.api.clearCache();
            dbCache = {};
            elemNames = {};
        }

        /**
         * AF database path -> WebId, resolved once and remembered.
         *
         * A WebId is stable for the life of the database, so this is the one
         * lookup that genuinely never needs repeating. A FAILED lookup is not
         * cached: a transient outage would otherwise poison every refresh for
         * as long as the display stays open.
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

        /** Does the current configuration need the referenced element at all? */
        function needsElement(cfg) {
            return cfg.LaneBy === 'element';
        }

        function isHierarchy(cfg) {
            return cfg.LaneBy === 'hierarchy';
        }

        /** The selectedFields every frame query in this configuration needs. */
        function frameFields(cfg) {
            var fields = [
                'Items.Name',
                'Items.StartTime',
                'Items.EndTime',
                'Items.TemplateName',
                'Items.Links.Self'
            ];
            if (needsElement(cfg)) {
                // Only when swimlanes are per-asset. The search endpoint returns
                // a LINK to the referenced element, not its name, so this field
                // is the cheapest thing that leads to one — it carries the WebId
                // the enrichment batch resolves (once per element, then cached).
                fields.push('Items.Links.PrimaryReferencedElement');
            }
            if (isHierarchy(cfg)) {
                // Lets the expansion skip leaf frames instead of asking each one
                // for children it does not have.
                fields.push('Items.HasChildren');
            }
            return fields.join(';');
        }

        function colorAttribute(cfg) {
            return cfg.ColorBy === 'attribute' ? trim(cfg.ColorAttribute) : '';
        }

        /**
         * The Event Frame query.
         *
         * `selectedFields` is not an optimisation, it is the difference between
         * a workable symbol and an unusable one — see the file header.
         *
         * maxCount is asked for one HIGHER than we will draw. That single extra
         * row is what distinguishes "there are exactly MaxEvents events" from
         * "there are more than MaxEvents and PI Web API truncated the answer",
         * which the operator has to be told about.
         */
        function queryEvents(dbWebId, cfg, win, elementWebId) {
            var max = intIn(cfg.MaxEvents, 1, 5000, 500);

            return PVX.api.eventFrames({
                databaseWebId: dbWebId,
                elementWebId: elementWebId || undefined,
                startTime: win.useRaw ? win.startExpr : isoOf(win.from),
                endTime: win.useRaw ? win.endExpr : isoOf(win.to),
                templateName: trim(cfg.TemplateName),
                nameFilter: trim(cfg.NameFilter),
                elementNameFilter: trim(cfg.ElementNameFilter),
                // 'Overlapped' is the operational default: the event that started
                // before the window and is still running is exactly the one that
                // matters, and every stricter mode drops it.
                searchMode: trim(cfg.SearchMode) || 'Overlapped',
                maxCount: max + 1,
                selectedFields: frameFields(cfg)
            }, {
                // Never served from the shared GET cache. This symbol owns its
                // own refresh cadence, and a RefreshSeconds shorter than the
                // cache TTL would silently become the TTL.
                cache: false
            });
        }

        /** The asset the scope follows: the URL's, else the data source's. */
        /**
         * The configured database, else the one this symbol's data source
         * lives in (see PVX.nav.defaultDatabase): drop any attribute of the
         * plant onto the symbol and it already knows where to look.
         */
        function databaseFor(cfg) {
            var typed = trim(cfg.DatabasePath);
            if (typed) { return { path: typed, from: '' }; }
            return PVX.nav.defaultDatabase(scope, sourceAsset);
        }

        function scopeAsset() {
            return trim(PVX.nav.currentAsset()) || sourceAsset;
        }

        /**
         * WebIds of the elements whose events are wanted: the asset alone, or
         * the asset and everything below it. Cached per asset, because the AF
         * hierarchy does not change between refreshes the way events do; a
         * failed lookup is not cached, for the same reason as resolveDatabase.
         */
        function scopeElements(cfg) {
            var asset = scopeAsset();
            var tree = cfg.AssetScope === 'assetTree';
            var cap = intIn(cfg.MaxScopeElements, 1, 2000, 200);
            var key = asset + '|' + (tree ? 'tree:' + cap : 'one');
            if (assetCache[key]) { return assetCache[key]; }

            var p = PVX.api.elementByPath(asset).then(function (el) {
                if (!el || !el.WebId) {
                    throw { pvxError: {
                        code: 'no-asset',
                        message: 'The display\'s asset "' + asset + '" is not an AF element PI Web API can see.',
                        check: 'the asset in the URL, or the element of this symbol\'s data source'
                    } };
                }
                if (!tree) { return { ids: [el.WebId], capped: false }; }
                // One more than the cap tells "exactly the cap" from "more".
                return PVX.api.get('elements/' + encodeURIComponent(el.WebId) +
                    '/elements?searchFullHierarchy=true&maxCount=' + (cap + 1) +
                    '&selectedFields=Items.WebId').then(function (res) {
                    var ids = [el.WebId];
                    var items = (res && res.Items) || [];
                    for (var i = 0; i < items.length && i < cap; i++) {
                        if (items[i].WebId) { ids.push(items[i].WebId); }
                    }
                    return { ids: ids, capped: items.length > cap };
                });
            });
            p['catch'](function () {
                if (assetCache[key] === p) { delete assetCache[key]; }
            });
            assetCache[key] = p;
            return p;
        }

        /**
         * Events referenced by any of the scope's elements, in one batch.
         * PI Web API searches events per element, so the tree is asked
         * element by element and the answers merged; an event that references
         * two of them comes back twice and is kept once.
         */
        function queryScoped(dbWebId, cfg, win) {
            return scopeElements(cfg).then(function (sc) {
                state.scopeCapped = sc.capped;
                if (sc.ids.length === 1) { return queryEvents(dbWebId, cfg, win, sc.ids[0]); }
                var reqs = {};
                var max = intIn(cfg.MaxEvents, 1, 5000, 500);
                for (var i = 0; i < sc.ids.length; i++) {
                    reqs['e' + i] = { Method: 'GET', Resource: apiUrl(eventFramesPath(sc.ids[i], cfg, win, max)) };
                }
                return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                    var split = PVX.api.batchResults(res);
                    var seen = {}, items = [];
                    for (var id in split.ok) {
                        if (!Object.prototype.hasOwnProperty.call(split.ok, id)) { continue; }
                        var list = (split.ok[id] && split.ok[id].Items) || [];
                        for (var j = 0; j < list.length; j++) {
                            var self = (list[j].Links && list[j].Links.Self) || (list[j].Name + list[j].StartTime);
                            if (seen[self]) { continue; }
                            seen[self] = true;
                            items.push(list[j]);
                        }
                    }
                    state.scopeFailed = split.failedCount || 0;
                    // Newest first before the cap, so a busy tree loses its
                    // oldest events rather than an arbitrary element's.
                    items.sort(function (a, b) {
                        return String(b.StartTime).localeCompare(String(a.StartTime));
                    });
                    return { Items: items };
                });
            });
        }

        /** The same query as queryEvents, as a batch sub-request path. */
        function eventFramesPath(webId, cfg, win, max) {
            var q = [
                ['startTime', win.useRaw ? win.startExpr : isoOf(win.from)],
                ['endTime', win.useRaw ? win.endExpr : isoOf(win.to)],
                ['templateName', trim(cfg.TemplateName)],
                ['nameFilter', trim(cfg.NameFilter)],
                ['referencedElementNameFilter', trim(cfg.ElementNameFilter)],
                ['searchMode', trim(cfg.SearchMode) || 'Overlapped'],
                ['maxCount', max + 1],
                ['selectedFields', frameFields(cfg)]
            ];
            var parts = [];
            for (var i = 0; i < q.length; i++) {
                if (q[i][1] === '' || q[i][1] === null || q[i][1] === undefined) { continue; }
                parts.push(q[i][0] + '=' + encodeURIComponent(q[i][1]));
            }
            return 'elements/' + encodeURIComponent(webId) + '/eventframes?' + parts.join('&');
        }

        /** Last path segment of a PI Web API self/reference link — the WebId. */
        function webIdFromLink(url) {
            var s = trim(url);
            if (!s) { return ''; }
            s = s.split('?')[0].replace(/\/+$/, '');
            var i = s.lastIndexOf('/');
            return i === -1 ? '' : s.slice(i + 1);
        }

        /**
         * PI marks an event frame that has not ended with a sentinel end time far
         * in the future, not with a null — and different releases have used
         * both. Anything past the year 9000 is the sentinel; anything missing is
         * the null form. Treating either as a real end time would draw a finished
         * bar for a fault that is still on the plant.
         */
        var OPEN_AFTER_MS = Date.UTC(9000, 0, 1);

        function toEvent(item, cfg) {
            var startD = PVX.fmt.toDate(item.StartTime);
            if (!startD) { return null; }     // an event with no start cannot be placed
            var endD = PVX.fmt.toDate(item.EndTime);
            var open = !endD || endD.getTime() >= OPEN_AFTER_MS;
            var links = item.Links || {};
            return {
                name: item.Name || '(unnamed event)',
                template: trim(item.TemplateName),
                start: startD.getTime(),
                end: open ? null : endD.getTime(),
                open: open,
                webId: webIdFromLink(links.Self),
                elWebId: needsElement(cfg) ? webIdFromLink(links.PrimaryReferencedElement) : '',
                elName: '',
                attrValue: null,
                hasChildren: item.HasChildren === true,
                depth: 0,
                children: []
            };
        }

        /**
         * Fill in the tree under the roots, one level per round trip.
         *
         * Each level is ONE batch: a sub-request per frame that HasChildren,
         * asking for its direct children over the same window. Twenty batches
         * of five phases each are therefore one request per level, not a
         * hundred. The window and search mode are the roots' own, so a child
         * that lies wholly outside the display's range is not fetched — it
         * would not be drawn anyway.
         *
         * Resolves with { failed, capped, depthCut }: failed sub-requests,
         * whether MaxEvents stopped the expansion, and how many frames still
         * had children when MaxDepth was reached. All three reach the footer.
         */
        function expandChildren(roots, cfg, win, budget) {
            var maxDepth = intIn(cfg.MaxDepth, 1, 8, 3);
            var out = { failed: 0, capped: false, depthCut: 0, count: roots.length };
            var params = '?startTime=' + encodeURIComponent(win.useRaw ? win.startExpr : isoOf(win.from)) +
                '&endTime=' + encodeURIComponent(win.useRaw ? win.endExpr : isoOf(win.to)) +
                '&searchMode=' + encodeURIComponent(trim(cfg.SearchMode) || 'Overlapped') +
                '&selectedFields=' + encodeURIComponent(frameFields(cfg));

            function level(parents, depth) {
                var asks = [];
                for (var i = 0; i < parents.length; i++) {
                    if (parents[i].hasChildren && parents[i].webId) { asks.push(parents[i]); }
                }
                if (!asks.length) { return Promise.resolve(out); }
                if (depth >= maxDepth) { out.depthCut += asks.length; return Promise.resolve(out); }
                if (out.count >= budget) { out.capped = true; return Promise.resolve(out); }

                var reqs = {};
                for (var k = 0; k < asks.length; k++) {
                    reqs['c' + k] = {
                        Method: 'GET',
                        Resource: apiUrl('eventframes/' + encodeURIComponent(asks[k].webId) + '/eventframes' +
                            params + '&maxCount=' + (budget - out.count + 1))
                    };
                }
                return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                    var r = PVX.api.batchResults(res);
                    out.failed += r.failedCount;
                    var next = [];
                    for (var a = 0; a < asks.length; a++) {
                        var body = r.ok['c' + a];
                        var items = (body && body.Items) || [];
                        for (var j = 0; j < items.length; j++) {
                            if (out.count >= budget) { out.capped = true; break; }
                            var ch = toEvent(items[j], cfg);
                            if (!ch) { continue; }
                            ch.depth = depth;
                            ch.parent = asks[a];
                            asks[a].children.push(ch);
                            next.push(ch);
                            out.count += 1;
                        }
                    }
                    return level(next, depth + 1);
                });
            }

            return level(roots, 1)['catch'](function () {
                // A failed level keeps the frames already fetched; a partial
                // tree is still a correct picture of what it shows.
                out.failed = out.failed || -1;
                return out;
            });
        }

        /** Depth-first, children in start order: the waterfall's row order. */
        function flattenTree(roots) {
            var rows = [];
            function walk(ev) {
                rows.push(ev);
                ev.children.sort(function (a, b) { return a.start - b.start; });
                for (var i = 0; i < ev.children.length; i++) { walk(ev.children[i]); }
            }
            for (var i = 0; i < roots.length; i++) { walk(roots[i]); }
            return rows;
        }

        /**
         * ONE batch for every per-event follow-up the configuration needs.
         *
         * Element names are deduplicated first and cached forever after: 500
         * events across 12 assets is 12 sub-requests on the first refresh and
         * zero on every one after it. Attribute values cannot be cached — that
         * is the point of them — so they are one sub-request per event, which is
         * exactly why they go in a batch and not down the wire individually.
         */
        function enrich(events, cfg) {
            var attr = colorAttribute(cfg);
            var wantEl = needsElement(cfg);
            var reqs = {};
            var ids = [];             // parallel arrays keep batch ids opaque and safe
            var kinds = [];
            var targets = [];
            var i, ev;

            if (wantEl) {
                var seen = {};
                for (i = 0; i < events.length; i++) {
                    var id = events[i].elWebId;
                    if (!id || seen[id] || elemNames[id] !== undefined) { continue; }
                    seen[id] = true;
                    var key = 'e' + ids.length;
                    reqs[key] = {
                        Method: 'GET',
                        Resource: apiUrl('elements/' + encodeURIComponent(id) + '?selectedFields=Name')
                    };
                    ids.push(key); kinds.push('element'); targets.push(id);
                }
            }

            if (attr) {
                for (i = 0; i < events.length; i++) {
                    ev = events[i];
                    if (!ev.webId) { continue; }
                    var akey = 'a' + ids.length;
                    reqs[akey] = {
                        Method: 'GET',
                        // streamsets rather than a per-attribute lookup: one
                        // request returns the named attribute's current value
                        // without first resolving the attribute's own WebId.
                        Resource: apiUrl('streamsets/' + encodeURIComponent(ev.webId) +
                            '/value?nameFilter=' + encodeURIComponent(attr) +
                            '&selectedFields=Items.Name;Items.Value')
                    };
                    ids.push(akey); kinds.push('attribute'); targets.push(i);
                }
            }

            if (!ids.length) {
                applyElementNames(events);
                return Promise.resolve(0);
            }

            return PVX.api.batch(reqs, { cache: false }).then(function (res) {
                var r = PVX.api.batchResults(res);
                for (var k = 0; k < ids.length; k++) {
                    var body = r.ok[ids[k]];
                    if (body === undefined) { continue; }
                    if (kinds[k] === 'element') {
                        elemNames[targets[k]] = (body && body.Name) || '';
                    } else {
                        events[targets[k]].attrValue = firstStreamValue(body);
                    }
                }
                applyElementNames(events);
                return r.failedCount;
            })['catch'](function () {
                // A failed batch degrades the colouring or the lane names; it is
                // not a reason to throw away a timeline that is otherwise
                // correct. The footer reports it.
                applyElementNames(events);
                return -1;
            });
        }

        function apiUrl(path) {
            return PVX.api.base() + '/' + path;
        }

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
                // A TimedValue wrapper, and PI digital states nest one deeper.
                v = v.Value;
                if (v !== null && typeof v === 'object') { v = v.Name !== undefined ? v.Name : null; }
            }
            return v === undefined ? null : v;
        }

        /* ================================================================ *
         * refresh
         * ================================================================ */

        function refresh() {
            if (ctx.destroyed) { return; }
            var cfg = liveCfg = scope.config || liveCfg;

            applyBaseUrlOverride(cfg);

            // With no baseUrl set, PVX.api first asks PI Vision's own server
            // for /piwebapi. Decide nothing until it has its answer.
            if (PVX.api.discovering()) {
                PVX.api.discover().then(function () { if (!ctx.destroyed) { refresh(); } });
                return;
            }

            // Each state below is a genuinely different problem with a different
            // owner, so each gets its own message rather than one "no data".
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
            var maxEvents = intIn(cfg.MaxEvents, 1, 5000, 500);

            // Keep whatever is already drawn while the new answer is in flight;
            // blanking a working chart on every tick is worse than a stale one.
            if (state.phase !== 'ok') { state.phase = 'loading'; }
            ctx.render();

            var scoped = trim(cfg.AssetScope) && cfg.AssetScope !== 'none';
            state.scopeCapped = false;
            state.scopeFailed = 0;
            if (scoped && !scopeAsset()) {
                state.phase = 'error';
                state.error = { pvxError: {
                    code: 'no-asset',
                    message: 'Events are scoped to the display\'s asset, but the URL names no asset and ' +
                             'this symbol\'s data source is not an AF attribute.',
                    check: 'open the display on an asset, or drop an attribute of the asset onto the symbol'
                } };
                state.events = [];
                ctx.render();
                return;
            }

            resolveDatabase(dbPath)
                .then(function (webId) {
                    if (stale(gen)) { return null; }
                    return scoped ? queryScoped(webId, cfg, win) : queryEvents(webId, cfg, win);
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
                    // axis has to come from what it returned.
                    if (win.useRaw) { adoptWindowFromEvents(win, events); }

                    state.tree = null;
                    if (!isHierarchy(cfg)) { return enrich(events, cfg); }
                    return expandChildren(events, cfg, win, maxEvents).then(function (tree) {
                        if (stale(gen)) { return null; }
                        state.tree = tree;
                        state.events = flattenTree(events);
                        return enrich(state.events, cfg);
                    });
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
        function stale(gen) {
            return ctx.destroyed || gen !== generation;
        }

        function adoptWindowFromEvents(win, events) {
            if (!events.length) { return; }
            var lo = events[0].start, hi = events[0].start;
            for (var i = 0; i < events.length; i++) {
                if (events[i].start < lo) { lo = events[i].start; }
                var e = events[i].open ? win.now : events[i].end;
                if (e > hi) { hi = e; }
            }
            if (!(hi > lo)) { hi = lo + 60000; }
            // A little padding, or the first and last bars sit on the frame.
            var pad = (hi - lo) * 0.02;
            win.from = lo - pad;
            win.to = hi + pad;
        }

        /* ================================================================ *
         * timers and listeners — every one of these is torn down in teardown()
         * ================================================================ */

        function ensureTimers(cfg) {
            var secs = intIn(cfg.RefreshSeconds, 5, 86400, 60);
            if (refreshTimer !== null && timerSeconds === secs) { return; }
            if (refreshTimer !== null) { clearInterval(refreshTimer); }
            timerSeconds = secs;
            refreshTimer = setInterval(function () { refresh(); }, secs * 1000);
        }

        /**
         * Poll the URL for a time-range change.
         *
         * A hashchange listener is wired up too, but polling is the primary
         * mechanism on purpose: some PI Vision releases update the time range
         * through the router without producing a hashchange event, and a symbol
         * that relied on the event alone would quietly keep showing yesterday.
         * One string comparison a second is not a cost worth optimising away.
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
         * model — pure: events + config -> lanes, notes, statistics
         * ================================================================ */

        function laneKeyFor(ev, cfg) {
            if (cfg.LaneBy === 'template') { return ev.template || '(no template)'; }
            if (cfg.LaneBy === 'none') { return 'All events'; }
            return ev.elName || '(no element)';
        }

        function buildModel(cfg) {
            var win = state.win;
            var m = {
                lanes: [], laneCount: 0, hiddenLanes: 0, hiddenLaneEvents: 0,
                count: 0, total: 0, longest: 0, mean: 0, openCount: 0,
                hiddenOpen: 0, notes: [],
                from: win ? win.from : 0, to: win ? win.to : 1,
                colors: {}, colorOrder: [],
                durMin: 0, durMax: 0
            };
            if (!win) { return m; }
            if (!(m.to > m.from)) { m.to = m.from + 60000; }

            var showOpen = cfg.ShowOpenEvents !== false;
            var byKey = {};
            var i, ev;

            if (isHierarchy(cfg)) { return buildTreeModel(m, cfg, showOpen); }

            for (i = 0; i < state.events.length; i++) {
                ev = state.events[i];
                if (ev.open && !showOpen) { m.hiddenOpen += 1; continue; }

                // Clipped to the window: that is what the bar occupies, and a
                // "total downtime" that counted the part of an event outside the
                // window would not match the picture it is printed under.
                var from = Math.max(ev.start, m.from);
                var to = Math.min(ev.open ? m.to : ev.end, m.to);
                if (!(to >= from)) { continue; }

                var item = {
                    ev: ev,
                    from: from, to: to,
                    duration: to - from,
                    trueDuration: ev.open ? null : (ev.end - ev.start),
                    clippedStart: ev.start < m.from,
                    open: ev.open
                };

                var key = laneKeyFor(ev, cfg);
                if (!byKey[key]) {
                    byKey[key] = { key: key, label: key, items: [], total: 0, subRows: 1 };
                    m.lanes.push(byKey[key]);
                }
                byKey[key].items.push(item);
                byKey[key].total += item.duration;

                m.count += 1;
                m.total += item.duration;
                if (item.duration > m.longest) { m.longest = item.duration; }
                if (ev.open) { m.openCount += 1; }
                if (m.count === 1 || item.duration < m.durMin) { m.durMin = item.duration; }
                if (item.duration > m.durMax) { m.durMax = item.duration; }
            }

            m.mean = m.count ? m.total / m.count : 0;

            /* Lane order.
             *
             * Which lanes SURVIVE the MaxLanes cap is ranked by total event
             * duration — dropping the least-affected assets is the only
             * truncation that keeps the chart meaningful. But the survivors are
             * then displayed in name order, because a kiosk display whose rows
             * reshuffle every time a duration ticks over is unreadable. */
            var maxLanes = intIn(cfg.MaxLanes, 1, 200, 20);
            if (m.lanes.length > maxLanes) {
                var ranked = m.lanes.slice().sort(function (a, b) {
                    return (b.total - a.total) || (a.label < b.label ? -1 : 1);
                });
                var keep = ranked.slice(0, maxLanes);
                var drop = ranked.slice(maxLanes);
                m.hiddenLanes = drop.length;
                for (i = 0; i < drop.length; i++) { m.hiddenLaneEvents += drop[i].items.length; }
                m.lanes = keep;
            }
            m.lanes.sort(function (a, b) {
                var x = String(a.label).toLowerCase(), y = String(b.label).toLowerCase();
                return x < y ? -1 : (x > y ? 1 : 0);
            });
            m.laneCount = m.lanes.length;

            for (i = 0; i < m.lanes.length; i++) {
                m.lanes[i].items.sort(function (a, b) { return a.from - b.from; });
            }

            assignColors(m, cfg);

            /* ---- notes: everything the picture cannot say for itself ------- */
            if (state.capped) {
                // PI Web API's event-frame search returns no total, and a second
                // counting query would cost another full round trip on an already
                // oversized result — so this reports the bound honestly rather
                // than inventing a number.
                m.notes.push('more than ' + state.maxEvents + ' events match — showing ' + state.maxEvents);
            }
            if (state.scopeCapped) {
                m.notes.push('more than ' + intIn(cfg.MaxScopeElements, 1, 2000, 200) +
                    ' elements below the asset — only the first were searched');
            }
            if (state.scopeFailed) {
                m.notes.push(state.scopeFailed + ' element ' + (state.scopeFailed === 1 ? 'search' : 'searches') + ' failed');
            }
            if (m.hiddenLanes) {
                m.notes.push('+' + m.hiddenLanes + (m.hiddenLanes === 1 ? ' lane' : ' lanes') +
                    ' hidden (' + m.hiddenLaneEvents + ' events)');
            }
            if (m.hiddenOpen) {
                m.notes.push(m.hiddenOpen + ' open ' + (m.hiddenOpen === 1 ? 'event' : 'events') + ' hidden');
            }
            if (state.failedBatch > 0) {
                m.notes.push(state.failedBatch + ' of the follow-up requests failed');
            } else if (state.failedBatch === -1) {
                m.notes.push('follow-up request failed — lane names or colours may be incomplete');
            }
            if (win.useRaw) {
                m.notes.push('time range resolved by PI Web API');
            }
            return m;
        }

        /**
         * Hierarchy mode: one row per frame, in the depth-first order the
         * refresh already produced. Rows are never re-sorted by name — the
         * order IS the tree — and the MaxLanes cut keeps the first rows, so
         * what is cut is always a tail, never a hole in the middle of a batch.
         */
        function buildTreeModel(m, cfg, showOpen) {
            var i, ev;
            var hiddenOpenIds = {};
            for (i = 0; i < state.events.length; i++) {
                ev = state.events[i];
                // A hidden open parent hides its subtree too: indented rows
                // under a parent that is not there read as the wrong parent's.
                if ((ev.open && !showOpen) || (ev.parent && hiddenOpenIds[ev.parent.webId])) {
                    m.hiddenOpen += 1;
                    if (ev.webId) { hiddenOpenIds[ev.webId] = true; }
                    continue;
                }
                var from = Math.max(ev.start, m.from);
                var to = Math.min(ev.open ? m.to : ev.end, m.to);
                if (!(to >= from)) { continue; }
                var item = {
                    ev: ev, from: from, to: to,
                    duration: to - from,
                    trueDuration: ev.open ? null : (ev.end - ev.start),
                    clippedStart: ev.start < m.from,
                    open: ev.open
                };
                m.lanes.push({
                    key: 'f' + i, label: ev.name, depth: ev.depth,
                    items: [item], total: item.duration, subRows: 1
                });
                m.count += 1;
                if (ev.depth === 0) {
                    m.roots = (m.roots || 0) + 1;
                    m.total += item.duration;
                    if (item.duration > m.longest) { m.longest = item.duration; }
                }
                if (ev.open) { m.openCount += 1; }
                if (m.count === 1 || item.duration < m.durMin) { m.durMin = item.duration; }
                if (item.duration > m.durMax) { m.durMax = item.duration; }
            }
            m.mean = m.roots ? m.total / m.roots : 0;
            m.tree = true;

            assignTypical(m, cfg);

            var maxLanes = intIn(cfg.MaxLanes, 1, 200, 20);
            if (m.lanes.length > maxLanes) {
                m.hiddenLanes = m.lanes.length - maxLanes;
                m.hiddenLaneEvents = m.hiddenLanes;
                m.lanes = m.lanes.slice(0, maxLanes);
            }
            m.laneCount = m.lanes.length;
            assignColors(m, cfg);

            if (state.capped) {
                m.notes.push('more than ' + state.maxEvents + ' top-level frames match \u2014 showing ' + state.maxEvents);
            }
            if (m.hiddenLanes) {
                m.notes.push('+' + m.hiddenLanes + (m.hiddenLanes === 1 ? ' frame' : ' frames') + ' below the last row');
            }
            if (m.hiddenOpen) {
                m.notes.push(m.hiddenOpen + ' open ' + (m.hiddenOpen === 1 ? 'frame' : 'frames') + ' hidden');
            }
            var tr = state.tree;
            if (tr) {
                if (tr.capped) { m.notes.push('child frames stopped at ' + state.maxEvents + ' in total'); }
                if (tr.depthCut) {
                    m.notes.push(tr.depthCut + (tr.depthCut === 1 ? ' frame has' : ' frames have') +
                        ' children below the depth limit');
                }
                if (tr.failed > 0) { m.notes.push(tr.failed + ' child lookups failed'); }
                else if (tr.failed === -1) { m.notes.push('child lookup failed \u2014 the tree may be incomplete'); }
            }
            if (state.failedBatch > 0) {
                m.notes.push(state.failedBatch + ' of the follow-up requests failed');
            } else if (state.failedBatch === -1) {
                m.notes.push('follow-up request failed \u2014 colours may be incomplete');
            }
            if (state.win && state.win.useRaw) { m.notes.push('time range resolved by PI Web API'); }
            return m;
        }

        /**
         * Typical duration per kind of frame: the median true duration of the
         * finished frames that share a template and, below the root, a name.
         *
         * The median, not the mean: one batch that sat on hold over a weekend
         * would drag a mean far enough to make every normal batch look short.
         * A kind needs three finished frames before it has a "typical" at all
         * — with two, "long" just means "the longer of the two".
         */
        function kindKey(ev) {
            return (ev.template || '') + '|' + (ev.depth ? ev.name : '');
        }

        function assignTypical(m, cfg) {
            var groups = {}, i, k, it;
            for (i = 0; i < m.lanes.length; i++) {
                it = m.lanes[i].items[0];
                if (it.open) { continue; }
                k = kindKey(it.ev);
                (groups[k] = groups[k] || []).push(it.trueDuration);
            }
            var med = {};
            for (k in groups) {
                if (!Object.prototype.hasOwnProperty.call(groups, k) || groups[k].length < 3) { continue; }
                med[k] = PVX.stats.percentile(groups[k], 0.5);
            }
            var tol = numIn(cfg.TypicalTolerancePct, 0, 1000, 20) / 100;
            m.typicalKinds = 0;
            for (k in med) { if (Object.prototype.hasOwnProperty.call(med, k)) { m.typicalKinds += 1; } }
            for (i = 0; i < m.lanes.length; i++) {
                it = m.lanes[i].items[0];
                var typ = med[kindKey(it.ev)];
                if (!(typ > 0)) { continue; }
                it.typical = typ;
                // An open frame is compared on its elapsed time: it is already
                // at least this long, which is enough to say "running long".
                var dur = it.open ? (state.win.now - it.ev.start) : it.trueDuration;
                it.ratio = dur / typ;
                it.long = it.ratio > 1 + tol;
                it.veryLong = it.ratio > 1 + 2 * tol;
            }
            if (cfg.ColorBy === 'typical' && !m.typicalKinds) {
                m.notes.push('no kind of frame has 3 finished examples yet \u2014 nothing to call typical');
            }
        }

        /**
         * One colour per event.
         *
         * 'template' and 'attribute' are categorical: colours are claimed in
         * sorted key order so the same template keeps the same colour between
         * refreshes even when the set of events changes — a legend that
         * reshuffles is worse than no legend.
         */
        function assignColors(m, cfg) {
            var mode = cfg.ColorBy || 'template';
            var single = trim(cfg.SingleColor) || '#3b82c4';
            var i, j, keys;

            if (mode === 'single' || mode === 'duration' || mode === 'typical') {
                m.colorMode = mode;
                m.single = single;
                return;
            }

            var seen = {};
            for (i = 0; i < m.lanes.length; i++) {
                for (j = 0; j < m.lanes[i].items.length; j++) {
                    var k = colorKeyFor(m.lanes[i].items[j], mode);
                    if (!seen[k]) { seen[k] = true; }
                }
            }
            keys = [];
            for (var kk in seen) {
                if (Object.prototype.hasOwnProperty.call(seen, kk)) { keys.push(kk); }
            }
            keys.sort();
            for (i = 0; i < keys.length; i++) {
                m.colors[keys[i]] = PVX.color.categorical[i % PVX.color.categorical.length];
                m.colorOrder.push(keys[i]);
            }
            m.colorMode = mode;
            m.single = single;
        }

        function colorKeyFor(item, mode) {
            if (mode === 'attribute') {
                var v = item.ev.attrValue;
                return (v === null || v === undefined || v === '') ? '(no value)' : String(v);
            }
            return item.ev.template || '(no template)';
        }

        function colorFor(item, m, cfg, t) {
            if (m.colorMode === 'single') { return m.single; }
            if (m.colorMode === 'typical') {
                // Status colours, because "ran long" IS a status. A frame
                // with no typical to compare against stays neutral rather than
                // borrowing "normal", which it has not earned.
                if (item.veryLong) { return PVX.color.status.alarm; }
                if (item.long) { return PVX.color.status.warning; }
                if (item.typical) { return PVX.color.status.normal; }
                return t ? t.textMuted : PVX.color.status.unknown;
            }
            if (m.colorMode === 'duration') {
                // Long events heavy, short events light. The sequential ramp runs
                // dark-to-light, so the fraction is inverted.
                //
                // The ends of the ramp are clipped per theme, and that is not
                // cosmetic: the raw ramp's pale end disappears into a white
                // canvas and its dark end disappears into a dark one — and the
                // bars it would erase are the shortest ones, which are exactly
                // what MinBarPx exists to keep visible.
                var span = m.durMax - m.durMin;
                var f = span > 0 ? (item.duration - m.durMin) / span : 1;
                var lo = t && t.dark ? 0.35 : 0;
                var hi = t && t.dark ? 0.92 : 0.72;
                return PVX.color.ramp(PVX.color.sequential, lo + (1 - f) * (hi - lo));
            }
            if (m.colorMode === 'attribute' && cfg.UseThresholds) {
                // A numeric attribute is a measurement, and the display already
                // has a threshold grammar for measurements — reuse it rather
                // than inventing a second one.
                var n = PVX.util.num(item.ev.attrValue);
                if (n !== null) { return PVX.thresholds.colorFor(cfg.Thresholds, n, m.single); }
            }
            var key = colorKeyFor(item, m.colorMode);
            return m.colors[key] || (t ? t.textMuted : '#6f7378');
        }

        /* ================================================================ *
         * render
         * ================================================================ */

        function render(c) {
            var cfg = liveCfg = c.config || liveCfg;
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            applyBaseUrlOverride(cfg);
            applyThemeVars(c, t);
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;

            var W = Math.max(40, host.clientWidth || c.width || 40);
            var H = Math.max(24, host.clientHeight || c.height || 24);

            /* The size thresholds are measured against the SYMBOL, not against
             * the drawing host — and that distinction is load-bearing, not
             * pedantry. The host is what is left after the header and footer,
             * so measuring it makes the decision depend on the chrome the
             * decision itself removes: drop the summary, the footer shrinks,
             * the host grows past the threshold, the summary comes back, and
             * the symbol oscillates between two layouts on every frame. */
            var rootW = Math.max(40, (c.node && c.node.clientWidth) || W);
            var rootH = Math.max(24, (c.node && c.node.clientHeight) || H);
            var minimal = rootW < MINIMAL_W || rootH < MINIMAL_H;
            var compact = minimal || rootW < COMPACT_W || rootH < COMPACT_H;
            chromeOff = minimal;

            var svgRoot = host.querySelector('svg.pvx-egantt-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-egantt-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            // Lanes must keep their true pixel height, so no aspect fitting.
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);
            hits = [];

            // Below the minimal threshold the header and footer are the only
            // things standing between the operator and the bars, and a two-line
            // chrome on a 90px-tall symbol leaves no room for the chart it is
            // describing. Bars only.
            scope.pvx.title = minimal ? '' : (trim(cfg.Title) || 'Event timeline');
            scope.pvx.range = '';
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
                scope.pvx.range = PVX.fmt.time(model.from, 'short') + ' \u2013 ' + PVX.fmt.time(model.to, 'short');
            }

            if (!model.count) {
                // The query worked; there is simply nothing in the window. That
                // is an answer, not a failure, and it is worded as one.
                drawMessage(svgRoot, W, H, t, 'No events in this window',
                    minimal ? '' : describeFilter(cfg), t.textMuted);
                digest();
                return;
            }

            if (!compact && cfg.ShowSummary !== false) {
                scope.pvx.summary = summaryText(model);
            }
            if (!minimal) { scope.pvx.note = model.notes.join(' \u00b7 '); }
            if (!minimal && state.db.from) { addNote('database ' + state.db.path + ' from ' + state.db.from); }

            drawChart(svgRoot, W, H, cfg, t, model, compact, minimal);
            digest();
        }

        function summaryText(m) {
            if (m.tree) {
                // Parents contain their children, so summing every row would
                // count the same hour three times. Totals are over roots.
                return (m.roots || 0) + ((m.roots === 1) ? ' top-level frame' : ' top-level frames') +
                    ' \u00b7 ' + m.count + ' frames' +
                    ' \u00b7 longest ' + PVX.fmt.duration(m.longest) +
                    (m.openCount ? ' \u00b7 ' + m.openCount + ' still open' : '');
            }
            return m.count + (m.count === 1 ? ' event' : ' events') +
                ' \u00b7 ' + PVX.fmt.duration(m.total) + ' total' +
                ' \u00b7 longest ' + PVX.fmt.duration(m.longest) +
                ' \u00b7 mean ' + PVX.fmt.duration(m.mean) +
                (m.openCount ? ' \u00b7 ' + m.openCount + ' still open' : '');
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

        /* ---- non-chart states -------------------------------------------- *
         * Four completely different problems with four different owners. One
         * shared "no data" message would send every one of them to the wrong
         * person.
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
                drawMessage(svgRoot, W, H, t,
                    'PI Web API request failed',
                    minimal ? '' :
                    (e ? e.message + '  \u2014  Check: ' + e.check
                       : 'The request failed and returned no diagnosis.'),
                    PVX.color.status.alarm);
                return;
            }
            drawMessage(svgRoot, W, H, t, 'Loading events\u2026', '', t.textMuted);
        }

        /* ================================================================ *
         * chart
         * ================================================================ */

        function drawChart(svgRoot, W, H, cfg, t, m, compact, minimal) {
            var i;
            var padX = 6;
            var padY = 4;

            var axisH = minimal ? 0 : AXIS_H;
            var laneLabels = !minimal && cfg.LaneBy !== 'none';
            var INDENT = 9;

            // The lane gutter is sized to the widest label it actually has to
            // hold, capped, so a chart of short asset names does not give a
            // third of its width to whitespace.
            var laneFont = PVX.util.clamp(Math.min(W, H) / 26, 8, 11.5);
            var laneLabelW = 0;
            if (laneLabels) {
                var widest = 0;
                for (i = 0; i < m.lanes.length; i++) {
                    widest = Math.max(widest, textW(m.lanes[i].label, laneFont) +
                        (m.tree ? m.lanes[i].depth * INDENT : 0));
                }
                // A tree's labels carry their indentation, so they get a
                // little more of the width before they start to truncate.
                laneLabelW = PVX.util.clamp(widest + 6, 30, W * (m.tree ? 0.38 : 0.3));
            }

            var plot = {
                x0: padX + laneLabelW + (laneLabelW > 0 ? 5 : 0),
                x1: W - padX,
                y0: padY,
                y1: H - padY - axisH
            };
            if (plot.x1 - plot.x0 < 24) { plot.x0 = padX; plot.x1 = W - padX; laneLabelW = 0; }
            if (plot.y1 - plot.y0 < 12) { plot.y0 = 1; plot.y1 = H - 1; axisH = 0; }

            var plotW = plot.x1 - plot.x0;
            var plotH = plot.y1 - plot.y0;

            // How many lanes actually fit? MaxLanes already capped the model;
            // this is the box being physically too short, which is a different
            // limit and needs its own honest note.
            var capacity = Math.max(1, Math.floor(plotH / MIN_LANE_H));
            var lanes = m.lanes;
            var droppedLanes = 0, droppedLaneEvents = 0;
            if (lanes.length > capacity) {
                droppedLanes = lanes.length - capacity;
                for (i = capacity; i < lanes.length; i++) { droppedLaneEvents += lanes[i].items.length; }
                lanes = lanes.slice(0, capacity);
                addNote('+' + droppedLanes + ' lanes below the fold (' + droppedLaneEvents + ' events)');
            }

            var laneH = plotH / lanes.length;
            var xs = PVX.scale.linear(m.from, m.to, plot.x0, plot.x1);

            // ---- grid + axis: behind the bars ------------------------------
            if (!minimal && (cfg.ShowGrid !== false || axisH > 0)) {
                drawTimeAxis(svgRoot, m, cfg, t, plot, axisH, plotW);
            }

            // ---- lane separators + labels ----------------------------------
            var laneG = PVX.svg.el('g', { 'class': 'pvx-egantt-lanes' }, svgRoot);
            for (i = 0; i < lanes.length; i++) {
                var ly = plot.y0 + i * laneH;
                // Alternating bands read better than lines when lanes are thin,
                // and they never get lost behind a bar.
                if (cfg.ShowGrid !== false && i % 2 === 1) {
                    PVX.svg.el('rect', {
                        x: plot.x0.toFixed(1), y: ly.toFixed(1),
                        width: plotW.toFixed(1), height: laneH.toFixed(1),
                        fill: t.grid, 'class': 'pvx-egantt-band'
                    }, laneG);
                }
                if (laneLabelW > 2) {
                    // Tree rows are left-aligned and indented: a right-aligned
                    // column cannot show nesting, which is the whole layout.
                    var indent = m.tree ? Math.min(lanes[i].depth * INDENT, laneLabelW * 0.4) : 0;
                    var lt = PVX.svg.text(laneG,
                        (m.tree ? padX + indent : plot.x0 - 5).toFixed(1), (ly + laneH / 2).toFixed(1),
                        fitText(lanes[i].label, laneLabelW - 4 - indent, laneFont), {
                            'class': 'pvx-svg-label pvx-egantt-lane',
                            'text-anchor': m.tree ? 'start' : 'end',
                            'font-size': laneFont.toFixed(1),
                            'font-weight': m.tree && !lanes[i].depth ? '600' : null,
                            fill: m.tree && lanes[i].depth ? t.textMuted : t.text
                        });
                    PVX.svg.el('title', null, lt).textContent =
                        lanes[i].label + ' \u2014 ' + lanes[i].items.length +
                        (lanes[i].items.length === 1 ? ' event, ' : ' events, ') +
                        PVX.fmt.duration(lanes[i].total);
                }
            }

            // ---- bars --------------------------------------------------------
            var minBar = numIn(cfg.MinBarPx, 0, 40, 3);
            var barsG = PVX.svg.el('g', { 'class': 'pvx-egantt-bars' }, svgRoot);
            var labelFont = PVX.util.clamp(laneH * 0.4, 7.5, 11);
            var showText = !compact && (cfg.ShowLabels !== false || cfg.ShowDurations !== false);

            var unseparated = 0;
            for (i = 0; i < lanes.length; i++) {
                unseparated += drawLane(barsG, lanes[i], {
                    cfg: cfg, theme: t, model: m,
                    y: plot.y0 + i * laneH, laneH: laneH,
                    x0: plot.x0, x1: plot.x1, xs: xs,
                    minBar: minBar, labelFont: labelFont, showText: showText
                });
            }
            if (unseparated > 0) {
                // Said out loud. The alternative — silently drawing two
                // concurrent faults as one bar — is the single failure a Gantt
                // must not have.
                addNote(unseparated + ' overlapping events could not be separated at this height');
            }

            // ---- now line ------------------------------------------------------
            // Only when the window actually contains now. On a window that ended
            // last Tuesday a "now" line is a line through the middle of nothing.
            if (cfg.ShowNowLine !== false) {
                var nowMs = (new Date()).getTime();
                if (nowMs > m.from && nowMs < m.to) {
                    var nx = xs(nowMs);
                    PVX.svg.el('line', {
                        x1: nx.toFixed(1), y1: plot.y0.toFixed(1),
                        x2: nx.toFixed(1), y2: plot.y1.toFixed(1),
                        stroke: PVX.color.status.alarm,
                        'stroke-width': 1,
                        'stroke-dasharray': '3 2',
                        'class': 'pvx-egantt-now'
                    }, svgRoot);
                    if (!minimal && plotW > 90) {
                        PVX.svg.text(svgRoot, (nx - 3).toFixed(1), (plot.y0 + 5).toFixed(1), 'now', {
                            'class': 'pvx-svg-label pvx-egantt-nowlabel',
                            'text-anchor': 'end', 'font-size': 8.5,
                            fill: PVX.color.status.alarm
                        });
                    }
                }
            }
        }

        /**
         * One swimlane.
         *
         * Overlapping events are packed into sub-rows rather than drawn on top of
         * each other: two concurrent faults stacked into one bar look like one
         * fault, which is the exact opposite of what a Gantt is for. Packing is
         * done in PIXEL space, after the MinBarPx clamp, because two events a
         * second apart are not distinguishable in time-space but must still not
         * be drawn over one another.
         *
         * @returns {Number} events the lane had no room to separate.
         */
        function drawLane(parent, lane, L) {
            var cfg = L.cfg, t = L.theme, m = L.model;
            var i;

            var inner = Math.max(MIN_BAR_H, L.laneH - LANE_GAP);
            var subCap = Math.max(1, Math.floor(inner / (MIN_BAR_H + 1)));

            // Resolve pixel extents once; everything after this is layout.
            var bars = [];
            for (i = 0; i < lane.items.length; i++) {
                var it = lane.items[i];
                var a = PVX.util.clamp(L.xs(it.from), L.x0, L.x1);
                var b = it.open ? L.x1 : PVX.util.clamp(L.xs(it.to), L.x0, L.x1);
                // A 20-second trip on an 8-hour window is a third of a pixel,
                // and it is routinely the most interesting mark on the chart.
                if (b - a < L.minBar) { b = a + L.minBar; }
                if (b > L.x1) { a = Math.max(L.x0, L.x1 - L.minBar); b = L.x1; }
                bars.push({ item: it, a: a, b: b, row: 0 });
            }

            // Greedy first-fit packing; bars are already in start order.
            var rowEnd = [];
            var overflow = 0;
            for (i = 0; i < bars.length; i++) {
                var placed = -1;
                for (var r = 0; r < rowEnd.length; r++) {
                    if (bars[i].a >= rowEnd[r] + 1) { placed = r; break; }
                }
                if (placed === -1 && rowEnd.length < subCap) {
                    placed = rowEnd.length;
                    rowEnd.push(0);
                }
                if (placed === -1) {
                    // The lane is physically out of sub-rows. Put it on the row
                    // that ends earliest — the least-bad overlap — rather than
                    // dropping an event the operator is entitled to see.
                    placed = 0;
                    for (var q = 1; q < rowEnd.length; q++) {
                        if (rowEnd[q] < rowEnd[placed]) { placed = q; }
                    }
                    overflow += 1;
                }
                bars[i].row = placed;
                rowEnd[placed] = Math.max(rowEnd[placed], bars[i].b);
            }

            /* Bar height is capped and the stack is centred in the lane.
             *
             * Without the cap a lane that happens to hold one non-overlapping
             * event gets a bar as tall as the whole lane, and the chart reads as
             * a row of blocks next to a row of bars — the visual weight then
             * tracks how crowded a lane is rather than anything in the data. */
            var rows = Math.max(1, rowEnd.length);
            var barH = Math.max(MIN_BAR_H, Math.min((inner - (rows - 1)) / rows, 22));
            var stackH = rows * barH + (rows - 1);
            var stackTop = L.y + Math.max(0, (L.laneH - stackH) / 2);
            var radius = Math.min(2, barH / 3);

            // The next bar in the same sub-row bounds where a label may run.
            var nextInRow = [];
            var lastSeen = {};
            for (i = bars.length - 1; i >= 0; i--) {
                var key = 'r' + bars[i].row;
                nextInRow[i] = lastSeen[key] === undefined ? L.x1 : lastSeen[key];
                lastSeen[key] = bars[i].a;
            }

            for (i = 0; i < bars.length; i++) {
                var bar = bars[i];
                var y = stackTop + bar.row * (barH + 1);
                var w = Math.max(L.minBar > 0 ? L.minBar : 1, bar.b - bar.a);
                var col = colorFor(bar.item, m, cfg, t);

                var g = PVX.svg.el('g', { 'class': 'pvx-egantt-bar' }, parent);
                if (scope.pvx.clickable) {
                    g.setAttribute('data-pvx-i', String(hits.length));
                    g.setAttribute('class', 'pvx-egantt-bar pvx-hit-group');
                    hits.push(bar.item);
                }

                PVX.svg.el('path', {
                    d: bar.item.open
                        ? openBarPath(bar.a, y, w, barH, radius)
                        : PVX.svg.roundRect(bar.a, y, w, barH, radius),
                    fill: col,
                    'class': 'pvx-egantt-shape'
                }, g);

                PVX.svg.el('title', null, g).textContent = tipFor(bar.item, lane);

                // Where a typical frame of this kind would have ended. Only
                // inside the bar's own row and the plot; past the window edge
                // it would point at nothing.
                if (m.tree && bar.item.typical && cfg.ColorBy === 'typical') {
                    var tx = L.xs(bar.item.ev.start + bar.item.typical);
                    if (tx > L.x0 && tx < L.x1) {
                        PVX.svg.el('line', {
                            x1: tx.toFixed(1), y1: (y - 1.5).toFixed(1),
                            x2: tx.toFixed(1), y2: (y + barH + 1.5).toFixed(1),
                            stroke: t.text, 'stroke-width': 1.5, 'class': 'pvx-egantt-typical'
                        }, g);
                    }
                }

                if (L.showText && barH >= 8) {
                    drawBarLabel(g, bar, y, w, barH, col, t, cfg, L, nextInRow[i]);
                }
            }

            return overflow;
        }

        /**
         * A bar for an event that has not ended.
         *
         * The right end is a chevron, not a flat cap. A square end at the window
         * edge reads as "finished exactly here", which is a lie about a fault
         * that is still on the plant — and it is the kind of lie an operator acts
         * on.
         */
        function openBarPath(x, y, w, h, r) {
            var k = Math.min(h * 0.55, w * 0.6);
            r = Math.min(r, h / 2, Math.max(0, w - k) / 2);
            var f = function (n) { return n.toFixed(2); };
            var xr = x + w;
            if (w <= k + 0.5) {
                // Too narrow for both a body and a point: draw the point alone,
                // which still reads as "continues".
                return 'M' + f(x) + ' ' + f(y) + ' L' + f(xr) + ' ' + f(y + h / 2) +
                       ' L' + f(x) + ' ' + f(y + h) + ' Z';
            }
            var d = 'M' + f(x + r) + ' ' + f(y) +
                    ' H' + f(xr - k) +
                    ' L' + f(xr) + ' ' + f(y + h / 2) +
                    ' L' + f(xr - k) + ' ' + f(y + h) +
                    ' H' + f(x + r);
            if (r > 0.05) {
                d += ' a' + f(r) + ' ' + f(r) + ' 0 0 1 ' + f(-r) + ' ' + f(-r) +
                     ' V' + f(y + r) +
                     ' a' + f(r) + ' ' + f(r) + ' 0 0 1 ' + f(r) + ' ' + f(-r);
            } else {
                d += ' V' + f(y);
            }
            return d + ' Z';
        }

        function labelTextFor(item, cfg) {
            var parts = [];
            if (cfg.ShowLabels !== false) { parts.push(item.ev.name); }
            if (cfg.ShowDurations !== false) {
                parts.push(PVX.fmt.duration(item.duration) + (item.open ? '+' : ''));
                if (item.long && cfg.ColorBy === 'typical') {
                    parts.push('+' + Math.round(100 * (item.ratio - 1)) + '% vs typical');
                }
            }
            return parts.join(' \u00b7 ');
        }

        /**
         * Label inside the bar when it fits, beside it when it does not, and not
         * at all when neither works. A clipped label is worse than no label: it
         * costs the same attention and delivers half a word.
         */
        function drawBarLabel(g, bar, y, w, h, col, t, cfg, L, nextX) {
            var text = labelTextFor(bar.item, cfg);
            if (!text) { return; }
            var font = Math.min(L.labelFont, h * 0.72);
            if (font < 7) { return; }
            var mid = y + h / 2;

            // An open bar spends its right end on the chevron, so an inside
            // label has that much less room — otherwise the text runs out
            // through the point.
            var usable = bar.item.open ? w - Math.min(h * 0.55, w * 0.6) : w;
            var needInside = textW(text, font) + 8;
            if (needInside <= usable) {
                PVX.svg.text(g, (bar.a + 4).toFixed(1), mid.toFixed(1), text, {
                    'class': 'pvx-svg-label pvx-egantt-barlabel',
                    'font-size': font.toFixed(1),
                    fill: PVX.color.readable(col)
                });
                return;
            }

            // Outside: bounded by the next bar in this sub-row and by the plot.
            var room = Math.min(nextX, L.x1) - (bar.a + w) - 5;
            if (room < font * 3) { return; }
            PVX.svg.text(g, (bar.a + w + 3).toFixed(1), mid.toFixed(1),
                fitText(text, room, font), {
                    'class': 'pvx-svg-label pvx-egantt-barlabel',
                    'font-size': font.toFixed(1),
                    fill: t.textMuted
                });
        }

        function tipFor(item, lane) {
            var ev = item.ev;
            var lines = [ev.name];
            if (ev.template) { lines.push('Template: ' + ev.template); }
            if (lane && lane.label) { lines.push('Lane: ' + lane.label); }
            lines.push('Start: ' + PVX.fmt.time(ev.start, 'datetime') +
                (item.clippedStart ? '  (before this window)' : ''));
            lines.push(ev.open
                ? 'End: still open'
                : 'End: ' + PVX.fmt.time(ev.end, 'datetime'));
            lines.push(ev.open
                ? 'Duration so far: ' + PVX.fmt.duration(item.duration)
                : 'Duration: ' + PVX.fmt.duration(item.trueDuration) +
                  (item.trueDuration !== item.duration ? '  (' + PVX.fmt.duration(item.duration) + ' in window)' : ''));
            if (item.typical) {
                lines.push('Typical for this kind: ' + PVX.fmt.duration(item.typical) +
                    ' (' + (item.ratio >= 1 ? '+' : '') + Math.round(100 * (item.ratio - 1)) + '%)');
            }
            if (ev.parent) { lines.push('Part of: ' + ev.parent.name); }
            if (ev.attrValue !== null && ev.attrValue !== undefined) {
                lines.push(trim(liveCfg.ColorAttribute) + ': ' + ev.attrValue);
            }
            return lines.join('\n');
        }

        /* ---- time axis ---------------------------------------------------- */
        function drawTimeAxis(svgRoot, m, cfg, t, plot, axisH, plotW) {
            var g = PVX.svg.el('g', { 'class': 'pvx-egantt-axis' }, svgRoot);
            var font = 8.5;

            var want = intIn(cfg.TimeTickCount, 2, 12, 6);
            // A "08/07 14:12" label is roughly 55px; below ~90px of spacing the
            // labels touch, and fewer readable ticks beat more unreadable ones.
            var fit = Math.floor(plotW / 90) + 1;
            var n = Math.max(2, Math.min(want, fit));

            if (axisH > 0) {
                PVX.svg.el('line', {
                    x1: plot.x0.toFixed(1), y1: plot.y1.toFixed(1),
                    x2: plot.x1.toFixed(1), y2: plot.y1.toFixed(1),
                    stroke: t.axis, 'stroke-width': 1, 'class': 'pvx-grid-line'
                }, g);
            }

            var last = null;
            for (var i = 0; i < n; i++) {
                var f = i / (n - 1);
                var x = plot.x0 + f * plotW;
                var ms = m.from + f * (m.to - m.from);

                if (cfg.ShowGrid !== false && i > 0 && i < n - 1) {
                    PVX.svg.el('line', {
                        x1: x.toFixed(1), y1: plot.y0.toFixed(1),
                        x2: x.toFixed(1), y2: plot.y1.toFixed(1),
                        stroke: t.grid, 'stroke-width': 1, 'class': 'pvx-grid-line'
                    }, g);
                }
                if (axisH <= 0 || plotW < 60) { continue; }

                var label = PVX.fmt.time(ms, 'short');
                // A window shorter than the label's own resolution would print
                // the same timestamp several times over.
                if (label === last) { continue; }
                last = label;

                PVX.svg.text(g, x.toFixed(1), (plot.y1 + axisH * 0.6).toFixed(1), label, {
                    'class': 'pvx-svg-label pvx-egantt-tick',
                    'text-anchor': i === 0 ? 'start' : (i === n - 1 ? 'end' : 'middle'),
                    'font-size': font,
                    fill: t.textMuted
                });
            }
        }

        /* ---- messages ------------------------------------------------------ */

        /**
         * Headline plus a wrapped explanation. These are the only text this
         * symbol shows when something is wrong, so they get the space to say
         * something useful — but they still shrink and wrap rather than spilling
         * out of a small symbol.
         */
        function drawMessage(svgRoot, W, H, t, headline, detail, tone) {
            var avail = Math.max(24, W - 16);
            var hFont = PVX.util.clamp(Math.min(W / 20, H / 8), 8, 13);
            if (textW(headline, hFont) > avail) {
                hFont = PVX.util.clamp(avail / (String(headline).length * 0.55), 7, hFont);
            }
            var dFont = Math.max(7, hFont * 0.82);

            var lines = detail ? wrapText(detail, avail, dFont, 5) : [];
            var lineH = dFont * 1.28;
            var block = hFont * 1.3 + (lines.length ? lines.length * lineH + 3 : 0);
            var top = Math.max(hFont, (H - block) / 2 + hFont * 0.8);

            PVX.svg.text(svgRoot, (W / 2).toFixed(1), top.toFixed(1),
                fitText(headline, avail, hFont), {
                    'class': 'pvx-svg-label pvx-egantt-msg-head',
                    'text-anchor': 'middle',
                    'font-size': hFont.toFixed(1),
                    'font-weight': '600',
                    fill: tone || t.textMuted
                });

            for (var i = 0; i < lines.length; i++) {
                PVX.svg.text(svgRoot, (W / 2).toFixed(1),
                    (top + hFont * 0.6 + (i + 1) * lineH).toFixed(1), lines[i], {
                        'class': 'pvx-svg-label pvx-egantt-msg-body',
                        'text-anchor': 'middle',
                        'font-size': dFont.toFixed(1),
                        fill: t.textMuted
                    });
            }
        }

        /** Greedy word wrap on the same glyph-width estimate used elsewhere. */
        function wrapText(str, maxPx, fontPx, maxLines) {
            var words = String(str).split(/\s+/);
            var perChar = fontPx * 0.55;
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
                // Say that it was cut, rather than ending mid-sentence as if the
                // message simply stopped there.
                var lastLine = lines[maxLines - 1];
                if (lastLine.charAt(lastLine.length - 1) !== '\u2026') {
                    lines[maxLines - 1] = lastLine.slice(0, Math.max(1, max - 1)) + '\u2026';
                }
            }
            return lines;
        }

        /* ================================================================ *
         * interaction
         * ================================================================ */

        /** Appends to the footer note, unless the box is too small to have one. */
        function addNote(text) {
            if (chromeOff) { return; }
            scope.pvx.note = (scope.pvx.note ? scope.pvx.note + ' · ' : '') + text;
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
         * Navigate to the configured display, zoomed to the clicked event.
         *
         * Handing the target display the EVENT's time range rather than the
         * current one is the whole point of the click: the operator picked a bar
         * because they want to see what everything else was doing during it.
         */
        function activate(index) {
            if (!(index >= 0) || index >= hits.length) { return; }
            var item = hits[index];
            var target = trim(liveCfg.NavigateTarget);
            if (!target) { return; }

            var from = item.ev.start;
            var to = item.ev.open ? (new Date()).getTime() : item.ev.end;
            // A little context either side; a zero-length event would otherwise
            // navigate to a zero-length window.
            var pad = Math.max(60000, (to - from) * 0.1);
            PVX.nav.go(PVX.nav.url({
                display: target,
                start: isoOf(from - pad),
                end: isoOf(to + pad)
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
