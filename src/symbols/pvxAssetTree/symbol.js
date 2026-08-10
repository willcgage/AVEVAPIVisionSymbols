/* ============================================================================
 * pvxAssetTree — "PVX Asset Navigator"
 * ----------------------------------------------------------------------------
 * DataShape: NONE. Like pvxEventGantt, this symbol has no PI Vision data
 * pipeline at all: everything it shows comes from PI Web API through PVX.api.
 *
 * WHY THIS EXISTS ALONGSIDE pvxNavPanel
 *   pvxNavPanel is a configured list of buttons — an author types the assets in
 *   and the display shows exactly those. That is right for a curated overview
 *   and wrong for a plant that changes: a unit added in AF on Tuesday is
 *   invisible until somebody edits every display that should offer it. This
 *   symbol walks the REAL AF hierarchy, so the tree is whatever AF currently
 *   says it is.
 *
 * WHY IT IS DOM AND NOT SVG
 *   Every other charting symbol in this library draws into one imperative SVG.
 *   A navigator is not a chart: it needs keyboard focus, a roving tabindex,
 *   ARIA roles, native scrolling and text that the browser truncates for us.
 *   All of that is free in DOM and hand-built in SVG. So the rows are real
 *   elements — still built imperatively (no ng-repeat, no watcher per row), and
 *   still with every data-derived string written through textContent so an
 *   element named by somebody else can never become markup.
 *
 * LAZY LOADING IS THE WHOLE DESIGN
 *   An AF database routinely holds tens of thousands of elements. Fetching the
 *   hierarchy up front would hang the display for a minute, push megabytes over
 *   the wire and hammer the AF server — for a tree of which an operator will
 *   open four branches. So a node's children are fetched the FIRST time it is
 *   expanded and never again: childCache is keyed by WebId, which is stable for
 *   the life of the element, so a cache hit can never show something different
 *   from a fresh request — only cheaper.
 *
 * FAILURE IS PER-NODE, NOT PER-TREE
 *   AF security is applied per element. One branch the operator may not read is
 *   normal, not a fault, and it must not take the rest of the tree down with it:
 *   a failed child fetch marks that ONE row with the reason and leaves every
 *   other branch expandable. See fetchChildren() and buildRow().
 *
 * WHAT SELECTING AN ASSET DOES
 *   It writes the display's `?asset=` parameter through PVX.nav. That is the
 *   PI Vision contract every other symbol on the display already follows, so
 *   one click here re-points the whole display — which is the entire reason a
 *   navigator is worth having.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    /* Below this a tree is not a tree: three rows, and no width left for a name
     * once the indent and the twisty have taken theirs. Naming the symbol is
     * more useful to whoever is laying the display out than an unusable stub. */
    var MIN_W = 160, MIN_H = 120;

    /* Chrome that only earns its space above a certain size. */
    var SEARCH_MIN_H = 150;      // below this the search box costs a row we need
    var TEMPLATE_MIN_W = 230;    // template column
    var PATH_MIN_W = 300;        // full path column
    var CONTEXT_MIN_W = 210;     // "where does this search hit live" column

    /* selectedFields on every list query. Without it PI Web API returns the
     * whole object graph — links, security, extended properties — for every
     * element, which on a 500-child level is megabytes for five fields. */
    var CHILD_FIELDS = 'Items.Name;Items.WebId;Items.Path;Items.HasChildren;Items.TemplateName';
    var ROOT_FIELDS = 'Name;WebId;Path;HasChildren;TemplateName';
    var DB_FIELDS = 'Name;WebId;Path';

    /* Guards. Every one of these exists to make a runaway impossible rather
     * than unlikely — this symbol expands trees on a timer-free display that
     * may stay open for a week. */
    var MAX_AUTO_DEPTH = 12;     // ancestors auto-expand-to-current will walk
    var EAGER_BUDGET = 40;       // child fetches ExpandDepth may spend
    var RESTORE_BUDGET = 60;     // child fetches remembered expansion may spend
    var MAX_EXPAND_DEPTH = 6;

    var SEARCH_DEBOUNCE_MS = 300;
    var CONFIG_DEBOUNCE_MS = 400;
    var HASH_POLL_MS = 1000;

    var definition = {
        typeName: 'pvxAssetTree',
        displayName: 'PVX Asset Navigator',

        // No data sources: PI Vision offers no attribute drop target and never
        // calls onDataUpdate. Everything arrives through PVX.api.
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.None,

        visObjectType: symbolVis,
        // A collection would repeat the whole navigator once per element, which
        // is a contradiction: the navigator is what CHOOSES the element.
        supportsCollections: false,
        configTitle: 'Format Asset Navigator',

        getDefaultConfig: function () {
            // NOTE: deliberately no DataShape and no DataQueryMode. Declaring
            // either on a DatasourceBehaviors.None symbol makes PI Vision ask
            // its own backend for data that will never arrive.
            return window.PVX.config.base({
                Height: 420,
                Width: 320,

                Title: 'Assets',
                ShowLabel: true,

                /* -- where the tree starts ----------------------------------- */
                DatabasePath: '',          // \\AFSERVER01\Production
                RootElementPath: '',       // optional: start below this element

                /* -- what the tree shows ------------------------------------- */
                TemplateFilter: '',
                NameFilter: '',
                MaxChildren: 500,
                ExpandDepth: 1,

                /* -- search --------------------------------------------------- */
                ShowSearch: true,
                SearchMinChars: 2,

                /* -- rows ----------------------------------------------------- */
                ShowIcons: true,
                ShowTemplate: false,
                ShowPath: false,
                CompactRows: false,
                RowHeight: 24,
                IndentPx: 14,

                /* -- what selecting a row does -------------------------------- */
                SelectAction: 'asset',     // asset | navigate | both
                NavigateTarget: '',

                /* -- context -------------------------------------------------- */
                HighlightCurrent: true,
                AutoExpandToCurrent: true,
                RememberExpanded: true,

                /* -- deployment ------------------------------------------------ *
                 * Testing escape hatch only — same contract as pvxEventGantt.
                 * The base URL belongs in libraries/pvx-config.js, where one
                 * site setting serves every symbol. See the config pane. */
                BaseUrlOverride: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound. Everything below .pvx-tree-body is
        // built by hand.
        scope.pvx = {
            title: '',
            subtitle: '',
            note: '',
            showHeader: false,
            surface: 'transparent'
        };

        /* ================================================================ *
         * instance state
         * ================================================================ */
        var state = {
            phase: 'idle',      // idle | loading | ok | unconfigured | nopath | error
            error: null         // the rejection from PVX.api, carrying .pvxError
        };

        var liveCfg = scope.config || {};
        var generation = 0;     // bumps on refresh/teardown; stale replies are dropped

        var root = null;        // root tree node, or null

        /* Caches that outlive a refresh. Keyed by WebId, which is stable for the
         * life of the element, so a hit can only ever save a request — it can
         * never show something a fresh request would not. */
        var childCache = {};    // webId -> {items: [raw], truncated: Boolean}

        /* Expansion memory, keyed by normalised AF path so it survives a refresh
         * that rebuilds every node object (RememberExpanded). */
        var expandedPaths = {};

        var search = {
            active: false,
            query: '',
            phase: 'idle',      // idle | loading | ok | error
            results: [],
            truncated: false,
            error: null
        };

        var rows = [];          // flattened visible rows, in draw order
        var focusKey = '';      // roving focus, tracked by node key not index
        var currentKey = '';    // normalised display asset, for the highlight
        var notes = [];         // footer honesty column, rebuilt each render
        var outsideRoot = false;// the display's asset is not under this root

        var hashTimer = null;
        var hashListener = null;
        var configTimer = null;
        var searchTimer = null;
        var lastAssetKey = null;

        var boundHost = null;   // host carrying the delegated listeners
        var boundInput = null;  // search input carrying its own listeners
        var boundClear = null;
        var restoreBudget = RESTORE_BUDGET;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-tree-body',
            render: render,

            onConfigChange: function (newCfg) {
                liveCfg = newCfg || liveCfg;
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

        /**
         * Comparable form of an AF path.
         * AF paths are case-insensitive, and a path copied out of PI System
         * Explorer routinely carries a trailing separator — an exact string
         * comparison would leave the current-asset highlight permanently off.
         */
        function pathKey(s) {
            return trim(s).replace(/[\\\/]+$/, '').toLowerCase();
        }

        function stale(gen) {
            return ctx.destroyed || gen !== generation;
        }

        /* ================================================================ *
         * nodes
         * ================================================================ */

        /**
         * @param {Object} raw  {Name, WebId, Path, HasChildren, TemplateName}
         * @param {Object} parent node or null
         * @param {Boolean} isDatabase the root is an AF database, not an element
         */
        function makeNode(raw, parent, isDatabase) {
            var p = raw.Path || '';
            return {
                name: raw.Name || '(unnamed)',
                webId: raw.WebId || '',
                path: p,
                key: pathKey(p) || ('webid:' + (raw.WebId || '')),
                template: trim(raw.TemplateName),
                // An AF database always has somewhere to go; the field does not
                // exist on the database object, so do not infer "leaf" from it.
                hasChildren: isDatabase ? true : raw.HasChildren !== false,
                isDatabase: !!isDatabase,
                parent: parent || null,
                depth: parent ? parent.depth + 1 : 0,
                children: null,     // null => never loaded
                truncated: false,
                expanded: false,
                loading: false,
                error: null,
                pending: null       // in-flight guard: one fetch per node at a time
            };
        }

        /* ================================================================ *
         * PI Web API
         * ================================================================ */

        /**
         * Point PVX.api at a different PI Web API.
         *
         * This writes the LIBRARY's settings, not this symbol's — PVX.api is one
         * shared client on purpose, so that authentication is configured once
         * per site. That makes the override page-wide; the config pane says so.
         */
        function applyBaseUrlOverride(cfg) {
            var override = trim(cfg.BaseUrlOverride);
            if (!override) { return; }
            if (PVX.api.settings.baseUrl === override) { return; }
            PVX.api.configure({ baseUrl: override });
            // The shared GET cache is keyed by URL so entries from the previous
            // base could not be returned by mistake anyway; dropping them, and
            // this symbol's own cache, keeps the switch clean for one refresh.
            PVX.api.clearCache();
            childCache = {};
        }

        function filterQuery(cfg) {
            var q = [];
            var tpl = trim(cfg.TemplateFilter);
            var nf = trim(cfg.NameFilter);
            // Filtering server-side rather than after the fact: the MaxChildren
            // cap then applies to the rows we will actually draw, so "showing
            // the first 500" means 500 matching elements, not 500 candidates of
            // which four survived.
            if (tpl) { q.push('templateName=' + encodeURIComponent(tpl)); }
            if (nf) { q.push('nameFilter=' + encodeURIComponent(nf)); }
            return q;
        }

        /**
         * The children endpoint for a node.
         *
         * A database's elements are NOT under elements/{webId}/elements — the
         * database is not an element. Getting this wrong gives a 404 on the very
         * first expand and looks like a bad path.
         */
        function childrenUrl(node, cfg) {
            var max = intIn(cfg.MaxChildren, 1, 5000, 500);
            var base = node.isDatabase
                ? 'assetdatabases/' + encodeURIComponent(node.webId) + '/elements'
                : 'elements/' + encodeURIComponent(node.webId) + '/elements';
            // One MORE than we will draw: that single extra row is what
            // distinguishes "this level has exactly MaxChildren" from "PI Web
            // API truncated the answer", which the operator has to be told.
            var q = ['selectedFields=' + CHILD_FIELDS, 'maxCount=' + (max + 1)];
            return base + '?' + q.concat(filterQuery(cfg)).join('&');
        }

        /**
         * Search.
         *
         * Deliberately the element-search endpoint with searchFullHierarchy,
         * NOT a client-side walk of the tree: walking would mean fetching every
         * level of a database that may hold tens of thousands of elements, which
         * is precisely what the lazy load exists to avoid. It is also not
         * /search/query — indexed search needs the PI Web API crawler configured
         * and indexes the whole system, whereas this is always available and is
         * already scoped to the root this symbol is showing.
         */
        function searchUrl(node, cfg, term) {
            var base = node.isDatabase
                ? 'assetdatabases/' + encodeURIComponent(node.webId) + '/elements'
                : 'elements/' + encodeURIComponent(node.webId) + '/elements';
            var max = intIn(cfg.MaxChildren, 1, 5000, 500);
            var q = [
                'searchFullHierarchy=true',
                'selectedFields=' + CHILD_FIELDS,
                'maxCount=' + (max + 1),
                // Wrapped in wildcards: an operator typing "mill" means "find me
                // the mills", not "find the element literally called mill".
                'nameFilter=' + encodeURIComponent('*' + term + '*')
            ];
            var tpl = trim(cfg.TemplateFilter);
            if (tpl) { q.push('templateName=' + encodeURIComponent(tpl)); }
            return base + '?' + q.join('&');
        }

        /** Resolve the configured starting point to a node. */
        function resolveRoot(cfg) {
            var rootPath = trim(cfg.RootElementPath);
            var dbPath = trim(cfg.DatabasePath);

            if (rootPath) {
                return PVX.api.get('elements?path=' + encodeURIComponent(rootPath) +
                    '&selectedFields=' + ROOT_FIELDS).then(function (el) {
                        if (!el || !el.WebId) {
                            throw {
                                pvxError: {
                                    code: 'no-root',
                                    message: 'PI Web API answered, but there is no AF element at "' + rootPath +
                                             '". The path is \\\\<AF server>\\<database>\\<element>\\<element> and it is ' +
                                             'case-insensitive but not forgiving about the server or database name.',
                                    check: 'RootElementPath'
                                }
                            };
                        }
                        return makeNode(el, null, false);
                    });
            }

            return PVX.api.get('assetdatabases?path=' + encodeURIComponent(dbPath) +
                '&selectedFields=' + DB_FIELDS).then(function (db) {
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
                    // assetdatabases does not report Path when selectedFields is
                    // narrowed on some releases; the configured path is the
                    // authoritative one anyway and is what asset comparison uses.
                    if (!db.Path) { db.Path = dbPath; }
                    return makeNode(db, null, true);
                });
        }

        /**
         * Fetch one node's children, once.
         *
         * Never rejects: the caller (a keypress, a click, the auto-expand chain)
         * has no useful way to handle a rejection, and a rejected promise that
         * nobody catches is a console error on a kiosk display. A failure is
         * recorded ON THE NODE and resolves with null, so the rest of the tree
         * stays exactly as usable as it was.
         *
         * @returns {Promise} resolves with the children array, or null on failure
         */
        function fetchChildren(node, cfg, gen) {
            if (node.children) { return Promise.resolve(node.children); }
            // One fetch per node at a time. Without this, holding Right on a
            // slow branch queues a request per keypress.
            if (node.pending) { return node.pending; }

            var cached = childCache[node.webId];
            if (cached) {
                adoptChildren(node, cached.items, cached.truncated, cfg, gen);
                return Promise.resolve(node.children);
            }

            node.loading = true;
            node.error = null;
            ctx.render();

            var max = intIn(cfg.MaxChildren, 1, 5000, 500);
            var p = PVX.api.get(childrenUrl(node, cfg), { cache: false })
                .then(function (res) {
                    node.pending = null;
                    node.loading = false;
                    if (stale(gen)) { return null; }
                    var items = (res && res.Items) || [];
                    var truncated = items.length > max;
                    if (truncated) { items = items.slice(0, max); }
                    childCache[node.webId] = { items: items, truncated: truncated };
                    adoptChildren(node, items, truncated, cfg, gen);
                    ctx.render();
                    return node.children;
                })['catch'](function (err) {
                    node.pending = null;
                    node.loading = false;
                    if (stale(gen)) { return null; }
                    // Recorded, not thrown. `children` stays null on purpose so
                    // collapsing and re-expanding the row retries — a 403 is
                    // permanent, a timeout is not, and the symbol cannot tell.
                    node.error = (err && err.pvxError) || {
                        code: 'unknown',
                        message: 'The request failed and returned no diagnosis.',
                        check: 'PI Web API'
                    };
                    ctx.render();
                    return null;
                });

            node.pending = p;
            return p;
        }

        /** Turn raw items into child nodes and restore any remembered expansion. */
        function adoptChildren(node, items, truncated, cfg, gen) {
            var kids = [];
            for (var i = 0; i < items.length; i++) {
                kids.push(makeNode(items[i], node, false));
            }
            node.children = kids;
            node.truncated = !!truncated;

            if (cfg.RememberExpanded === false) { return; }
            // Re-open what was open before this refresh. Budgeted: a remembered
            // set from a deep session must not turn one refresh into a hundred
            // requests.
            for (var j = 0; j < kids.length; j++) {
                if (!expandedPaths[kids[j].key] || !kids[j].hasChildren) { continue; }
                if (restoreBudget <= 0) { break; }
                restoreBudget -= 1;
                expand(kids[j], cfg, gen);
            }
        }

        /* ================================================================ *
         * expand / collapse
         * ================================================================ */

        function expand(node, cfg, gen) {
            if (!node || !node.hasChildren) { return Promise.resolve(null); }
            node.expanded = true;
            if (cfg.RememberExpanded !== false) { expandedPaths[node.key] = true; }
            return fetchChildren(node, cfg, gen);
        }

        function collapse(node, cfg) {
            if (!node) { return; }
            node.expanded = false;
            delete expandedPaths[node.key];
            ctx.render();
        }

        function toggle(node, cfg) {
            if (!node || !node.hasChildren) { return; }
            if (node.expanded) { collapse(node, cfg); return; }
            expand(node, cfg, generation);
            ctx.render();
        }

        /**
         * Open the first ExpandDepth levels.
         *
         * Sequential and budgeted. Depth 2 on a level of 500 children would
         * otherwise be 500 requests before the display has drawn anything.
         */
        function expandToDepth(node, depth, cfg, gen, budget) {
            if (!node || depth <= 0 || budget.left <= 0 || stale(gen)) {
                return Promise.resolve();
            }
            budget.left -= 1;
            return expand(node, cfg, gen).then(function (kids) {
                if (!kids || depth <= 1 || stale(gen)) { return null; }
                return kids.reduce(function (chain, kid) {
                    return chain.then(function () {
                        if (!kid.hasChildren || budget.left <= 0) { return null; }
                        return expandToDepth(kid, depth - 1, cfg, gen, budget);
                    });
                }, Promise.resolve());
            });
        }

        /**
         * Open every branch down to the display's current asset.
         *
         * Without this, reopening a display shows a collapsed tree with the
         * current selection invisible somewhere inside it, and the operator has
         * to rediscover where they already are.
         *
         * Bounded three ways, because "walk down a path" is exactly the shape of
         * code that loops forever: the segment list is finite and computed once,
         * it is capped at MAX_AUTO_DEPTH, and a segment that does not resolve
         * stops the walk instead of retrying.
         */
        function autoExpandToCurrent(cfg, gen) {
            outsideRoot = false;
            if (cfg.AutoExpandToCurrent === false || !root) { return Promise.resolve(); }

            var asset = trim(PVX.nav.currentAsset());
            if (!asset) { return Promise.resolve(); }

            var rootKey = pathKey(root.path);
            var assetK = pathKey(asset);
            if (!rootKey || assetK === rootKey) { return Promise.resolve(); }

            if (assetK.indexOf(rootKey + '\\') !== 0 && assetK.indexOf(rootKey + '/') !== 0) {
                // Legitimate and common: the display is pointed at another
                // database, or at an attribute. Say so and stop — do not go
                // looking for it, and above all do not walk a path that cannot
                // be here.
                outsideRoot = true;
                ctx.render();
                return Promise.resolve();
            }
            outsideRoot = false;

            var rest = asset.slice(root.path.length).replace(/^[\\\/]+/, '');
            var segs = [];
            var raw = rest.split(/[\\\/]/);
            for (var i = 0; i < raw.length; i++) {
                if (trim(raw[i])) { segs.push(trim(raw[i])); }
            }
            // Only the ANCESTORS need opening; the asset itself just needs to be
            // visible, which it is once its parent is open.
            segs = segs.slice(0, Math.max(0, segs.length - 1));
            if (segs.length > MAX_AUTO_DEPTH) { segs = segs.slice(0, MAX_AUTO_DEPTH); }

            var node = root;
            return segs.reduce(function (chain, seg) {
                return chain.then(function () {
                    // A segment that does not resolve leaves `node` null and
                    // every later step short-circuits — the walk stops, it does
                    // not retry and it cannot spin.
                    if (!node || stale(gen)) { return null; }
                    return expand(node, cfg, gen).then(function (kids) {
                        node = findChild(kids, seg);
                        return null;
                    });
                });
            }, Promise.resolve()).then(function () {
                // The last ancestor has to be OPENED, not merely reached: the
                // asset itself is one of its children, and leaving it shut is
                // the difference between "revealed" and "one click away".
                if (!node || stale(gen)) { return null; }
                return expand(node, cfg, gen);
            }).then(function () {
                if (!stale(gen)) { ctx.render(); }
            });
        }

        function findChild(kids, name) {
            if (!kids) { return null; }
            var want = String(name).toLowerCase();
            for (var i = 0; i < kids.length; i++) {
                if (String(kids[i].name).toLowerCase() === want) { return kids[i]; }
            }
            return null;
        }

        /* ================================================================ *
         * refresh
         * ================================================================ */

        function refresh() {
            if (ctx.destroyed) { return; }
            var cfg = liveCfg = scope.config || liveCfg;

            applyBaseUrlOverride(cfg);

            // Each of these is a different problem with a different owner, so
            // each gets its own message rather than one shared "no data".
            if (!PVX.api.isConfigured()) {
                state.phase = 'unconfigured';
                state.error = null;
                root = null;
                ctx.render();
                return;
            }
            if (!trim(cfg.DatabasePath) && !trim(cfg.RootElementPath)) {
                state.phase = 'nopath';
                state.error = null;
                root = null;
                ctx.render();
                return;
            }

            var gen = ++generation;
            state.phase = 'loading';
            state.error = null;
            root = null;
            outsideRoot = false;
            restoreBudget = RESTORE_BUDGET;
            exitSearch(false);
            ctx.render();

            resolveRoot(cfg)
                .then(function (node) {
                    if (stale(gen)) { return null; }
                    root = node;
                    state.phase = 'ok';
                    focusKey = node.key;
                    ctx.render();
                    var depth = intIn(cfg.ExpandDepth, 0, MAX_EXPAND_DEPTH, 1);
                    return expandToDepth(root, depth, cfg, gen, { left: EAGER_BUDGET });
                })
                .then(function () {
                    if (stale(gen)) { return null; }
                    return autoExpandToCurrent(cfg, gen);
                })
                .then(function () {
                    if (!stale(gen)) { ctx.render(); }
                })['catch'](function (err) {
                    if (stale(gen)) { return; }
                    state.phase = 'error';
                    state.error = err;
                    root = null;
                    ctx.render();
                });
        }

        function refreshSoon() {
            if (configTimer !== null) { clearTimeout(configTimer); }
            configTimer = setTimeout(function () {
                configTimer = null;
                refresh();
            }, CONFIG_DEBOUNCE_MS);
        }

        /* ================================================================ *
         * search
         * ================================================================ */

        function runSearch(term) {
            var cfg = liveCfg;
            if (!root) { return; }
            var gen = generation;

            search.active = true;
            search.query = term;
            search.phase = 'loading';
            search.error = null;
            search.results = [];
            search.truncated = false;
            ctx.render();

            var max = intIn(cfg.MaxChildren, 1, 5000, 500);
            PVX.api.get(searchUrl(root, cfg, term), { cache: false })
                .then(function (res) {
                    if (stale(gen) || !search.active || search.query !== term) { return; }
                    var items = (res && res.Items) || [];
                    search.truncated = items.length > max;
                    if (search.truncated) { items = items.slice(0, max); }
                    var out = [];
                    for (var i = 0; i < items.length; i++) {
                        out.push(makeNode(items[i], null, false));
                    }
                    search.results = out;
                    search.phase = 'ok';
                    focusKey = out.length ? out[0].key : '';
                    ctx.render();
                })['catch'](function (err) {
                    if (stale(gen) || !search.active || search.query !== term) { return; }
                    search.phase = 'error';
                    search.error = (err && err.pvxError) || null;
                    ctx.render();
                });
        }

        function exitSearch(rerender) {
            if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
            search.active = false;
            search.query = '';
            search.phase = 'idle';
            search.results = [];
            search.error = null;
            search.truncated = false;
            if (boundInput && boundInput.value) { boundInput.value = ''; }
            if (rerender !== false) { ctx.render(); }
        }

        function onSearchInput() {
            var cfg = liveCfg;
            var term = trim(boundInput ? boundInput.value : '');
            var min = intIn(cfg.SearchMinChars, 1, 10, 2);
            if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }

            if (term.length < min) {
                // Not "no results" — not searching yet. Falling back to the tree
                // is what an operator who just cleared the box expects.
                if (search.active) { exitSearch(true); }
                return;
            }
            // Debounced: one request per pause, not one per keystroke against a
            // full-hierarchy search.
            searchTimer = setTimeout(function () {
                searchTimer = null;
                runSearch(term);
            }, SEARCH_DEBOUNCE_MS);
        }

        /* ================================================================ *
         * selection
         * ================================================================ */

        /**
         * In the PI Vision display EDITOR, clicking a symbol is how the designer
         * selects it. Navigating at that moment would discard the display they
         * are building. Probe both known locations of the flag; assume runtime
         * if neither exists, because a false positive would make the symbol dead
         * on a live display.
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

        /**
         * Act on a row.
         *
         * 'asset'    — rewrite this display's ?asset=. That is the PI Vision
         *              contract every other symbol follows, so the whole display
         *              re-points; it is the reason this symbol exists.
         * 'navigate' — open NavigateTarget carrying the selected asset.
         * 'both'     — navigate when a target is configured, and fall back to
         *              setting the asset context when one is not, so a
         *              half-configured symbol still does something useful
         *              instead of nothing.
         */
        function activate(node) {
            if (!node || !node.path) { return; }
            if (isEditMode()) { return; }

            var cfg = liveCfg;
            var mode = cfg.SelectAction || 'asset';
            var target = trim(cfg.NavigateTarget);

            // Optimistic: the URL change and Angular's route update are not
            // instant, and a navigator that does not visibly respond to a click
            // gets clicked again.
            currentKey = node.key;
            ctx.render();

            if (mode === 'navigate' || (mode === 'both' && target)) {
                if (!target) { return; }   // nothing to navigate to; say so in the pane
                PVX.nav.go(PVX.nav.url({ display: target, asset: node.path }), false);
                return;
            }
            PVX.nav.go(PVX.nav.url({ asset: node.path }), false);
        }

        /* ================================================================ *
         * keyboard
         * ================================================================ *
         * A navigation control that needs a mouse is a poor navigation control.
         * The tree is ONE tab stop (roving tabindex: exactly one row carries
         * tabindex 0 and the rest carry -1), and the arrows do what every tree
         * on every platform does.
         */

        /** Normalise across releases: IE11 and old Edge use the short names. */
        function keyName(ev) {
            var k = ev.key;
            if (!k) {
                var c = ev.keyCode;
                if (c === 38) { return 'ArrowUp'; }
                if (c === 40) { return 'ArrowDown'; }
                if (c === 37) { return 'ArrowLeft'; }
                if (c === 39) { return 'ArrowRight'; }
                if (c === 13) { return 'Enter'; }
                if (c === 32) { return ' '; }
                if (c === 36) { return 'Home'; }
                if (c === 35) { return 'End'; }
                if (c === 27) { return 'Escape'; }
                return '';
            }
            if (k === 'Up') { return 'ArrowUp'; }
            if (k === 'Down') { return 'ArrowDown'; }
            if (k === 'Left') { return 'ArrowLeft'; }
            if (k === 'Right') { return 'ArrowRight'; }
            if (k === 'Spacebar') { return ' '; }
            if (k === 'Esc') { return 'Escape'; }
            return k;
        }

        function rowIndexOf(key) {
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].node.key === key) { return i; }
            }
            return -1;
        }

        function moveFocus(index) {
            if (!rows.length) { return; }
            var i = PVX.util.clamp(index, 0, rows.length - 1);
            focusKey = rows[i].node.key;
            setRovingTabindex();
            focusRow();
        }

        /**
         * Exactly one row carries tabindex 0.
         *
         * Deliberately separate from focusRow(): this runs on EVERY render, and
         * a render that also called focus() would rip the caret out of the
         * search box — or out of another symbol entirely — every time a branch
         * finished loading.
         */
        function setRovingTabindex() {
            var idx = rowIndexOf(focusKey);
            if (idx === -1) { idx = 0; }
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].el) { rows[i].el.setAttribute('tabindex', i === idx ? '0' : '-1'); }
            }
        }

        /** Move the DOM focus onto the focused row. Only ever from a user act. */
        function focusRow() {
            var idx = rowIndexOf(focusKey);
            if (idx === -1) { idx = 0; }
            var target = rows[idx];
            if (!target || !target.el) { return; }
            try { target.el.focus(); } catch (e) { /* detached */ }
            if (target.el.scrollIntoView) {
                // 'nearest' so arrowing down one row does not recentre the list
                // under the operator's eye on every keypress.
                try { target.el.scrollIntoView({ block: 'nearest' }); }
                catch (e2) { /* older signature; focus() has already scrolled it */ }
            }
        }

        function onKeyDown(ev) {
            if (!rows.length) { return; }
            var k = keyName(ev);
            var idx = rowIndexOf(focusKey);
            if (idx === -1) { idx = 0; }
            var node = rows[idx] ? rows[idx].node : null;
            if (!node) { return; }
            var cfg = liveCfg;

            if (k === 'ArrowDown') { moveFocus(idx + 1); }
            else if (k === 'ArrowUp') { moveFocus(idx - 1); }
            else if (k === 'Home') { moveFocus(0); }
            else if (k === 'End') { moveFocus(rows.length - 1); }
            else if (k === 'ArrowRight') {
                if (node.hasChildren && !node.expanded) {
                    expand(node, cfg, generation);
                    ctx.render();
                } else if (node.expanded && node.children && node.children.length) {
                    // Already open: Right descends, which is the standard tree
                    // contract and the only way to reach a child without the
                    // mouse when the row is already expanded.
                    moveFocus(idx + 1);
                }
            } else if (k === 'ArrowLeft') {
                if (node.expanded) {
                    collapse(node, cfg);
                } else if (node.parent) {
                    var p = rowIndexOf(node.parent.key);
                    if (p !== -1) { moveFocus(p); }
                }
            } else if (k === 'Enter' || k === ' ') {
                activate(node);
            } else if (k === 'Escape') {
                if (search.active) { exitSearch(true); }
                else { return; }
            } else {
                return;
            }

            // Arrows scroll the page and Space pages it; a tree that also moves
            // the display underneath it is unusable.
            if (ev.preventDefault) { ev.preventDefault(); }
            if (ev.stopPropagation) { ev.stopPropagation(); }
        }

        /** The search box owns Down/Enter/Escape so the operator never has to
         *  reach for the mouse to get from typing to the results. */
        function onSearchKeyDown(ev) {
            var k = keyName(ev);
            if (k === 'Escape') {
                exitSearch(true);
                if (ev.preventDefault) { ev.preventDefault(); }
                return;
            }
            if (k === 'ArrowDown') {
                if (rows.length) { moveFocus(0); }
                if (ev.preventDefault) { ev.preventDefault(); }
                return;
            }
            if (k === 'Enter') {
                if (rows.length) { activate(rows[0].node); }
                if (ev.preventDefault) { ev.preventDefault(); }
            }
        }

        /* ================================================================ *
         * pointer
         * ================================================================ */

        function rowFromEvent(ev) {
            var el = ev.target;
            var guard = 0;
            var toggled = false;
            while (el && el !== boundHost && guard < 12) {
                if (el.getAttribute) {
                    if (el.getAttribute('data-pvx-toggle') !== null) { toggled = true; }
                    var raw = el.getAttribute('data-pvx-i');
                    if (raw !== null) {
                        return { row: rows[parseInt(raw, 10)], toggle: toggled };
                    }
                }
                el = el.parentNode;
                guard += 1;
            }
            return null;
        }

        function onClick(ev) {
            var hit = rowFromEvent(ev);
            if (!hit || !hit.row) { return; }
            focusKey = hit.row.node.key;
            setRovingTabindex();
            focusRow();
            if (hit.toggle) {
                toggle(hit.row.node, liveCfg);
                return;
            }
            activate(hit.row.node);
        }

        /** Double-click anywhere on a branch row expands it — the habit every
         *  file explorer has trained. */
        function onDblClick(ev) {
            var hit = rowFromEvent(ev);
            if (!hit || !hit.row || hit.toggle) { return; }
            toggle(hit.row.node, liveCfg);
        }

        /* ================================================================ *
         * timers and listeners — every one is undone in teardown()
         * ================================================================ */

        /**
         * Follow the display's asset.
         *
         * A hashchange listener is wired up too, but polling is the primary
         * mechanism on purpose: some PI Vision releases change the asset through
         * the router without producing a hashchange, and a navigator that
         * highlighted the wrong row would be worse than one that highlighted
         * none. One string comparison a second is not worth optimising away.
         */
        function pollAsset() {
            if (ctx.destroyed) { return; }
            var k = pathKey(PVX.nav.currentAsset());
            if (k === lastAssetKey) { return; }
            lastAssetKey = k;
            currentKey = k;
            if (root && liveCfg.AutoExpandToCurrent !== false) {
                // The display moved somewhere else; reveal it. Already-expanded
                // ancestors resolve from cache, so this is cheap after the first.
                autoExpandToCurrent(liveCfg, generation);
            }
            ctx.render();
        }

        function teardown() {
            // A leaked poller on a control-room kiosk runs for weeks.
            if (hashTimer !== null) { clearInterval(hashTimer); hashTimer = null; }
            if (configTimer !== null) { clearTimeout(configTimer); configTimer = null; }
            if (searchTimer !== null) { clearTimeout(searchTimer); searchTimer = null; }
            if (hashListener) {
                try { window.removeEventListener('hashchange', hashListener, false); }
                catch (e) { /* ignore */ }
                hashListener = null;
            }
            unbindHost();
            unbindSearch();
            // Anything still in flight resolves into stale() and is discarded.
            generation += 1;
            root = null;
            rows = [];
            childCache = {};
            search.results = [];
        }

        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            if (!host || !host.addEventListener) { return; }
            // One delegated listener each: rows are rebuilt on every expand, so
            // per-row listeners would have to be torn down and reattached
            // constantly.
            host.addEventListener('click', onClick, false);
            host.addEventListener('dblclick', onDblClick, false);
            host.addEventListener('keydown', onKeyDown, false);
            boundHost = host;
        }

        function unbindHost() {
            if (boundHost && boundHost.removeEventListener) {
                try {
                    boundHost.removeEventListener('click', onClick, false);
                    boundHost.removeEventListener('dblclick', onDblClick, false);
                    boundHost.removeEventListener('keydown', onKeyDown, false);
                } catch (e) { /* ignore */ }
            }
            boundHost = null;
        }

        function bindSearch(input, clearBtn) {
            if (boundInput !== input) {
                unbindSearch();
                if (input && input.addEventListener) {
                    input.addEventListener('input', onSearchInput, false);
                    input.addEventListener('keydown', onSearchKeyDown, false);
                    boundInput = input;
                }
            }
            if (boundClear !== clearBtn) {
                if (boundClear && boundClear.removeEventListener) {
                    try { boundClear.removeEventListener('click', onClearClick, false); }
                    catch (e) { /* ignore */ }
                }
                boundClear = null;
                if (clearBtn && clearBtn.addEventListener) {
                    clearBtn.addEventListener('click', onClearClick, false);
                    boundClear = clearBtn;
                }
            }
        }

        function onClearClick() {
            exitSearch(true);
            if (boundInput) { try { boundInput.focus(); } catch (e) { /* ignore */ } }
        }

        function unbindSearch() {
            if (boundInput && boundInput.removeEventListener) {
                try {
                    boundInput.removeEventListener('input', onSearchInput, false);
                    boundInput.removeEventListener('keydown', onSearchKeyDown, false);
                } catch (e) { /* ignore */ }
            }
            boundInput = null;
            if (boundClear && boundClear.removeEventListener) {
                try { boundClear.removeEventListener('click', onClearClick, false); }
                catch (e2) { /* ignore */ }
            }
            boundClear = null;
        }

        /* ================================================================ *
         * flatten — tree -> the rows that are actually visible
         * ================================================================ */

        function flatten(cfg) {
            var out = [];
            if (search.active) {
                for (var s = 0; s < search.results.length; s++) {
                    out.push({ node: search.results[s], level: 1, setSize: search.results.length, posInSet: s + 1 });
                }
                return out;
            }
            if (!root) { return out; }
            out.push({ node: root, level: 1, setSize: 1, posInSet: 1 });
            walk(root, 2, out);
            return out;
        }

        function walk(node, level, out) {
            if (!node.expanded || !node.children) { return; }
            for (var i = 0; i < node.children.length; i++) {
                var kid = node.children[i];
                out.push({ node: kid, level: level, setSize: node.children.length, posInSet: i + 1 });
                walk(kid, level + 1, out);
            }
            if (node.truncated) {
                notes.push(node.name + ': first ' + node.children.length + ' of more');
            }
        }

        /* ================================================================ *
         * render
         * ================================================================ */

        function render(c) {
            var cfg = liveCfg = c.config || liveCfg;
            var t = c.theme;
            var host = c.host;

            applyBaseUrlOverride(cfg);
            applyVars(c, cfg, t);
            scope.pvx.surface = cfg.Transparent ? 'transparent' : t.surface;

            // Measured against the SYMBOL, not the drawing host: the host is
            // what is left after the header, search box and footer, so measuring
            // it would make the decision depend on the chrome the decision
            // itself removes — and the layout would oscillate frame to frame.
            var rootW = Math.max(20, (c.node && c.node.clientWidth) || c.width || 20);
            var rootH = Math.max(20, (c.node && c.node.clientHeight) || c.height || 20);
            var tiny = rootW < MIN_W || rootH < MIN_H;

            notes = [];
            currentKey = pathKey(PVX.nav.currentAsset());

            scope.pvx.title = cfg.ShowLabel === false ? '' : (trim(cfg.Title) || 'Assets');
            scope.pvx.subtitle = '';
            scope.pvx.showHeader = !tiny && !!scope.pvx.title;

            if (!host) { digest(); return; }

            // Keep focus where it was: a full rebuild on every expand would
            // otherwise drop the operator back to the top of the tree.
            var active = null;
            try { active = document.activeElement; } catch (e) { active = null; }
            var hadFocus = !!(active && host.contains && host.contains(active));

            bindHost(host);
            bindSearchChrome(cfg, tiny, rootH);
            clear(host);
            rows = [];

            if (tiny) {
                // Naming the symbol beats a stub nobody can identify when they
                // find it three sizes too small on someone else's display.
                host.removeAttribute('role');
                host.setAttribute('tabindex', '-1');
                buildTiny(host);
                scope.pvx.note = '';
                digest();
                return;
            }

            host.setAttribute('role', 'tree');
            host.setAttribute('aria-label', scope.pvx.title || 'Asset navigator');
            // The container is not the tab stop — one of its rows is (roving
            // tabindex). -1 keeps it programmatically focusable for the empty
            // states, where there is no row to hold the focus.
            host.setAttribute('tabindex', '-1');

            if (state.phase !== 'ok') {
                buildStatus(host, cfg, t);
                scope.pvx.note = '';
                digest();
                return;
            }

            if (search.active && search.phase === 'loading') {
                buildMessage(host, 'Searching\u2026', '', t.textMuted);
                scope.pvx.note = '';
                digest();
                return;
            }
            if (search.active && search.phase === 'error') {
                buildMessage(host, 'Search failed',
                    search.error ? search.error.message + '  \u2014  Check: ' + search.error.check : '',
                    PVX.color.status.alarm);
                scope.pvx.note = '';
                digest();
                return;
            }

            rows = flatten(cfg);

            if (search.active && !rows.length) {
                // A query that matched nothing is an answer, not a failure.
                buildMessage(host, 'Nothing matched \u201c' + search.query + '\u201d',
                    'No element under ' + (root ? root.name : 'this root') + ' has that in its name' +
                    (trim(cfg.TemplateFilter) ? ' and uses template "' + trim(cfg.TemplateFilter) + '"' : '') + '.',
                    t.textMuted);
                scope.pvx.note = '';
                digest();
                return;
            }

            if (!search.active && root && root.expanded && root.children && !root.children.length && !root.error) {
                // Resolved fine; there is simply nothing in it.
                buildMessage(host, 'This database is empty',
                    (trim(cfg.TemplateFilter) || trim(cfg.NameFilter))
                        ? 'No element under ' + root.name + ' matches the template and name filters.'
                        : 'No elements under ' + root.name + '. Check the AF database, or the root element path.',
                    t.textMuted);
                scope.pvx.note = '';
                digest();
                return;
            }

            var cols = {
                icons: cfg.ShowIcons !== false,
                template: !!cfg.ShowTemplate && rootW >= TEMPLATE_MIN_W,
                // Forced on for search results whatever ShowPath says: a flat
                // list of names is ambiguous by construction — "Pump A" exists
                // under four units and the operator has to know which one they
                // are about to point the whole display at.
                // and it earns its width sooner there than a full path column
                // would, so it gets a lower threshold of its own.
                path: search.active
                    ? rootW >= CONTEXT_MIN_W
                    : (!!cfg.ShowPath && rootW >= PATH_MIN_W)
            };
            var rowH = intIn(cfg.RowHeight, 14, 60, 24);
            var indent = intIn(cfg.IndentPx, 0, 48, 14);

            for (var i = 0; i < rows.length; i++) {
                rows[i].el = buildRow(rows[i], i, cfg, t, cols, rowH, indent);
                host.appendChild(rows[i].el);
            }

            // Roving tabindex, every frame: exactly one row is reachable by Tab.
            if (rowIndexOf(focusKey) === -1 && rows.length) { focusKey = rows[0].node.key; }
            setRovingTabindex();
            // Rows are rebuilt on every expand, which destroys the focused node.
            // Restore it ONLY if the operator had it — never steal it.
            if (hadFocus) { focusRow(); }

            scope.pvx.subtitle = search.active
                ? (rows.length + (search.truncated ? '+' : '') + ' found')
                : '';
            if (search.truncated) {
                notes.push('more matches than the cap — showing the first ' + rows.length);
            }
            if (outsideRoot && !search.active) {
                notes.push('the display’s asset is not under this root');
            }
            scope.pvx.note = notes.join(' \u00b7 ');

            digest();
        }

        /* ---- chrome ------------------------------------------------------- */

        /**
         * The search box lives in the template but carries no Angular
         * directives, so this symbol owns it outright and the two never fight
         * over the same DOM.
         */
        function bindSearchChrome(cfg, tiny, rootH) {
            var wrap = PVX.util.find(elem, '.pvx-tree-searchwrap');
            var input = PVX.util.find(elem, '.pvx-tree-search-input');
            var clearBtn = PVX.util.find(elem, '.pvx-tree-search-clear');
            if (!wrap) { return; }

            var show = !tiny && cfg.ShowSearch !== false && rootH >= SEARCH_MIN_H &&
                       state.phase === 'ok';
            wrap.style.display = show ? '' : 'none';
            if (!show) {
                if (search.active) { exitSearch(false); }
                unbindSearch();
                return;
            }
            if (input) {
                var min = intIn(cfg.SearchMinChars, 1, 10, 2);
                input.setAttribute('placeholder', 'Search assets (' + min + '+ characters)');
                input.setAttribute('aria-label', 'Search assets');
            }
            if (clearBtn) { clearBtn.style.visibility = search.active ? 'visible' : 'hidden'; }
            bindSearch(input, clearBtn);
        }

        function buildTiny(host) {
            var wrap = div('pvx-tree-tiny');
            var name = div('pvx-tree-tiny-name');
            name.textContent = 'PVX Asset Navigator';
            wrap.appendChild(name);
            var hint = div('pvx-tree-tiny-hint');
            hint.textContent = 'Needs ' + MIN_W + '\u00d7' + MIN_H;
            wrap.appendChild(hint);
            host.appendChild(wrap);
        }

        /* ---- non-tree states ---------------------------------------------- *
         * Five different problems with five different owners. One shared "no
         * data" would send every one of them to the wrong person.
         */
        function buildStatus(host, cfg, t) {
            if (state.phase === 'unconfigured') {
                buildMessage(host, 'PI Web API is not configured',
                    'Set baseUrl in libraries/pvx-config.js on this PI Vision server, then confirm it ' +
                    'with ext/piwebapi-check.html — that page reproduces exactly what this symbol does ' +
                    'and names what to fix.', PVX.color.status.warning);
                return;
            }
            if (state.phase === 'nopath') {
                buildMessage(host, 'No AF database configured',
                    'Set the AF database path in the format pane, for example \\\\AFSERVER01\\Production. ' +
                    'A root element path may be used instead to start further down the hierarchy.',
                    PVX.color.status.warning);
                return;
            }
            if (state.phase === 'error') {
                var e = (state.error && state.error.pvxError) || null;
                var isRoot = e && (e.code === 'no-database' || e.code === 'no-root');
                buildMessage(host,
                    isRoot ? 'Root did not resolve' : 'PI Web API request failed',
                    e ? e.message + '  \u2014  Check: ' + e.check
                      : 'The request failed and returned no diagnosis.',
                    PVX.color.status.alarm);
                return;
            }
            buildMessage(host, 'Loading the AF hierarchy\u2026', '', t.textMuted);
        }

        function buildMessage(host, headline, detail, tone) {
            var wrap = div('pvx-tree-msg');
            var h = div('pvx-tree-msg-head');
            h.textContent = headline;
            h.style.color = tone || '';
            wrap.appendChild(h);
            if (detail) {
                var d = div('pvx-tree-msg-body');
                d.textContent = detail;
                wrap.appendChild(d);
            }
            host.appendChild(wrap);
        }

        /* ---- rows --------------------------------------------------------- */

        function buildRow(row, index, cfg, t, cols, rowH, indent) {
            var node = row.node;
            var el = div('pvx-tree-row');
            var selected = !!(cfg.HighlightCurrent !== false && currentKey && node.key === currentKey);

            el.setAttribute('data-pvx-i', String(index));
            el.setAttribute('role', 'treeitem');
            el.setAttribute('tabindex', '-1');
            el.setAttribute('aria-level', String(row.level));
            el.setAttribute('aria-setsize', String(row.setSize));
            el.setAttribute('aria-posinset', String(row.posInSet));
            el.setAttribute('aria-selected', selected ? 'true' : 'false');
            if (node.hasChildren) {
                el.setAttribute('aria-expanded', node.expanded ? 'true' : 'false');
            }
            if (node.loading) { el.setAttribute('aria-busy', 'true'); }
            if (selected) { el.className += ' pvx-tree-row-current'; }
            if (node.error) { el.className += ' pvx-tree-row-failed'; }
            el.style.minHeight = rowH + 'px';

            // Indent by padding rather than by nested containers: a flat row list
            // with aria-level is a valid tree and keeps arrow-key movement a
            // simple index step instead of a walk.
            var depth = search.active ? 0 : node.depth;
            el.style.paddingLeft = (4 + depth * indent) + 'px';

            // Title carries what the row cannot: the full path, and the reason a
            // branch failed.
            el.setAttribute('title', node.error
                ? node.name + '\n' + node.path + '\n\n' + node.error.message + '\nCheck: ' + node.error.check
                : (node.path || node.name));

            el.appendChild(buildTwisty(node, t));
            if (cols.icons) { el.appendChild(buildIcon(node, t)); }

            var name = div('pvx-tree-name pvx-truncate');
            // textContent, never innerHTML: element names come from AF and must
            // never be interpreted as markup.
            name.textContent = node.name;
            el.appendChild(name);

            if (cols.template && node.template) {
                var tpl = div('pvx-tree-template pvx-truncate');
                tpl.textContent = node.template;
                el.appendChild(tpl);
            }
            if (cols.path && node.path) {
                var ptext = search.active ? contextPath(node) : relPath(node);
                if (ptext) {
                    var pth = div('pvx-tree-path pvx-truncate');
                    pth.textContent = ptext;
                    el.appendChild(pth);
                }
            }

            if (node.loading) {
                // Per-node, on the row being expanded. A symbol-wide "loading"
                // would blank a tree the operator is still reading; a frozen row
                // would look broken.
                el.appendChild(spinner());
            } else if (node.error) {
                var warnEl = div('pvx-tree-warn');
                warnEl.textContent = accessDenied(node.error) ? 'no access' : 'failed';
                warnEl.style.color = PVX.color.status.alarm;
                el.appendChild(warnEl);
            }

            return el;
        }

        function accessDenied(err) {
            return !!err && (err.code === 'forbidden' || err.code === 'unauthorized');
        }

        /**
         * The path with the tree's own root stripped off.
         * The root prefix is the same on every row, so it is pure noise in a
         * column that is competing with the element's name for width — and the
         * absolute path is on the tooltip for anyone who needs to paste it.
         */
        function relPath(node) {
            if (!root || !node.path) { return node.path || ''; }
            var rp = root.path || '';
            if (rp && node.path.length > rp.length &&
                pathKey(node.path).indexOf(pathKey(rp)) === 0) {
                return node.path.slice(rp.length).replace(/^[\\\/]+/, '');
            }
            return node.path;
        }

        /**
         * Where a search hit lives — its relative path minus its own name.
         *
         * Elided from the LEFT, in JS, not by CSS. A CSS ellipsis cuts the tail,
         * and the tail is the discriminating part: three hits reading
         * "North Plant\Boiler Hou…" are no more distinguishable than three bare
         * names, which is the entire problem this column exists to solve.
         */
        function contextPath(node) {
            var rel = relPath(node);
            var cut = rel.lastIndexOf('\\');
            if (cut === -1) { cut = rel.lastIndexOf('/'); }
            var ctxPath = cut === -1 ? '' : rel.slice(0, cut);
            if (!ctxPath) { return root ? root.name : ''; }
            var segs = ctxPath.split(/[\\\/]/);
            if (segs.length <= 2) { return ctxPath; }
            return '…\\' + segs.slice(segs.length - 2).join('\\');
        }

        /**
         * The expand/collapse control.
         *
         * Always present as a fixed-width box, even on a leaf: without it every
         * leaf name would sit one twisty-width left of its branch siblings and
         * the indent would stop reading as hierarchy.
         */
        function buildTwisty(node, t) {
            var box = div('pvx-tree-twisty');
            if (search.active || !node.hasChildren) { return box; }
            box.className += ' pvx-tree-twisty-on';
            box.setAttribute('data-pvx-toggle', '1');
            box.setAttribute('aria-hidden', 'true');
            if (node.expanded) { box.className += ' pvx-tree-twisty-open'; }
            var s = PVX.svg.el('svg', { viewBox: '0 0 10 10', 'class': 'pvx-tree-caret' }, box);
            PVX.svg.el('path', { d: 'M3 1 L8 5 L3 9 Z', fill: t.textMuted }, s);
            return box;
        }

        /**
         * A branch and a leaf need to be distinguishable at a glance even when
         * the twisty is the only other difference — so branches get a container
         * glyph and leaves a device glyph.
         */
        function buildIcon(node, t) {
            var box = div('pvx-tree-icon');
            var s = PVX.svg.el('svg', { viewBox: '0 0 12 12', 'class': 'pvx-tree-glyph' }, box);
            if (node.hasChildren) {
                PVX.svg.el('path', {
                    d: 'M1 3.2 h3.4 l1 1.1 H11 v5.4 a0.8 0.8 0 0 1 -0.8 0.8 H1.8 A0.8 0.8 0 0 1 1 9.7 Z',
                    fill: node.isDatabase ? PVX.color.status.info : t.textMuted,
                    opacity: node.isDatabase ? 1 : 0.75
                }, s);
            } else {
                PVX.svg.el('rect', {
                    x: 2.4, y: 3.2, width: 7.2, height: 5.6, rx: 1.2,
                    fill: 'none', stroke: t.textMuted, 'stroke-width': 1.2, opacity: 0.8
                }, s);
                PVX.svg.el('rect', { x: 4.6, y: 5.2, width: 2.8, height: 1.6, rx: 0.4, fill: t.textMuted }, s);
            }
            return box;
        }

        function spinner() {
            var box = div('pvx-tree-spin');
            box.setAttribute('aria-hidden', 'true');
            var ring = div('pvx-tree-spin-ring');
            box.appendChild(ring);
            return box;
        }

        /* ================================================================ *
         * plumbing
         * ================================================================ */

        function div(cls) {
            var d = document.createElement('div');
            d.className = cls;
            return d;
        }

        function clear(node) {
            while (node && node.firstChild) { node.removeChild(node.firstChild); }
        }

        function applyVars(c, cfg, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            var set = function (k, v) { n.style.setProperty(k, v); };
            set('--pvx-surface', cfg.Transparent ? 'transparent' : t.surface);
            set('--pvx-surface-alt', t.surfaceAlt);
            set('--pvx-text', t.text);
            set('--pvx-muted', t.textMuted);
            set('--pvx-border', t.border);

            var accent = cfg.AccentColor || '#3b82c4';
            set('--pvx-tree-accent', accent);
            // Translucent tints derived from the accent so hover and selection
            // read the same on a light and a dark canvas.
            set('--pvx-tree-hover', PVX.color.rgba(accent, t.dark ? 0.20 : 0.10));
            set('--pvx-tree-sel', PVX.color.rgba(accent, t.dark ? 0.34 : 0.18));
            set('--pvx-tree-focus', PVX.color.rgba(accent, 0.65));
            set('--pvx-tree-row-font', (cfg.CompactRows ? 11 : 12) + 'px');
            set('--pvx-tree-row-pad', (cfg.CompactRows ? 1 : 3) + 'px');
        }

        /* Rendering happens in a rAF and replies arrive in Promise callbacks —
         * both outside Angular's digest — so the scope.pvx writes need an
         * explicit, guarded digest. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        /* ---- go ------------------------------------------------------------ */
        lastAssetKey = pathKey(PVX.nav.currentAsset());
        currentKey = lastAssetKey;
        hashTimer = setInterval(pollAsset, HASH_POLL_MS);
        hashListener = function () { pollAsset(); };
        try { window.addEventListener('hashchange', hashListener, false); }
        catch (e) { hashListener = null; }
        refresh();

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
