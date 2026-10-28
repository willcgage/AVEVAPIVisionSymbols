/* ============================================================================
 * pvxDisplayMenu — a site menu: nested drop-downs or a side menu of displays
 * ----------------------------------------------------------------------------
 * DataShape: Value, never read for its value: its one data source gets the
 * symbol into the selector and names the asset a relative menu attribute
 * hangs off (see ItemsAttribute).
 *
 * pvxNavPanel is a row of buttons, one level deep, that can also switch the
 * asset or the time or walk the AF hierarchy. This is the other shape a site
 * asks for: the plant's display tree as a menu bar with drop-downs (or a side
 * menu that expands in place), icons, a logo, a back button, and switches
 * for PI Vision's kiosk mode and its toolbar, time bar and side bar. One menu
 * can live in an AF string attribute so every display shows the same one.
 *
 * Items grammar, one entry per line, nested by indentation:
 *
 *     [home] Overview -- Plant overview | 101
 *     Boilers
 *         Boiler 1 | 205 | asset=\\AF\DB\Plant\Boiler 1
 *         Boiler 2 | 206
 *         ---
 *         Water chemistry | 230 | start=*-7d; end=*
 *     Reports
 *         [external] Shift report | https://intranet/shift | tab=new
 *
 *   - `Label | target | options`, the label as pvxNavPanel takes it:
 *     `[icon]` first, the tooltip after ` -- `.
 *   - A target is a display (id, id/slug, /Displays/... or a full PI Vision
 *     address) or a web page (http:// or https://).
 *   - Options, `;` separated: asset=, start=, end=, tab=new, keeptime=no,
 *     keepasset=no.
 *   - Indent a line further than the one before to put it under it; a tab
 *     counts as four spaces, and a leading `>` per level works too, for an
 *     AF attribute edited in a tool that eats leading spaces.
 *   - `---` is a separator. Blank lines and lines starting `#` are skipped.
 *   - A line with no target and nothing under it goes nowhere: it is left
 *     out and counted in the note, never dropped silently.
 *
 * Drop-downs and the collapsed menu are drawn on document.body, not inside
 * the symbol: a menu has to open over the rest of the display, and PI
 * Vision gives each symbol a box of its own that would cut it off.
 *
 * @mock numeric
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxDisplayMenu',
        displayName: 'PVX Display Menu',

        // One data source, which the menu only reads an asset from. A symbol
        // with none never reaches the selector (DatasourceBehaviors.None).
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,

        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Display Menu',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Value',
                Height: 40,
                Width: 640,

                // Where the entries come from: Items below, or the text of an
                // AF string attribute, so one menu serves every display.
                ItemsFrom: 'config',       // config | af
                ItemsAttribute: '',
                Items: '[home] Overview | 101\n' +
                       'Units\n' +
                       '    Unit 1 | 201\n' +
                       '    Unit 2 | 202\n' +
                       'Reports\n' +
                       '    Daily report | 301\n' +
                       '    Shift log | 302',

                Layout: 'bar',             // bar | side
                SubmenuOpen: 'click',      // click | hover
                Collapse: 'narrow',        // never | narrow | always
                MenuLabel: 'Menu',
                IconPosition: 'start',     // start | end

                // Behaviour
                KeepAsset: true,
                KeepTime: true,
                OpenInNewTab: false,
                ShowActive: true,

                // Extras on the bar
                ShowBack: false,
                ShowKioskToggle: false,
                ShowToolbarToggle: false,
                ShowTimebarToggle: false,
                ShowSidebarToggle: false,

                // Logo
                LogoUrl: '',
                LogoPosition: 'start',     // start | end
                LogoHeight: 0,             // 0: the bar's height less padding
                LogoTarget: '',
                LogoAlt: 'Logo',

                // Appearance
                ItemColor: '',             // text; blank follows the theme
                HighlightColor: '',        // active and hover; blank: AccentColor
                FontSize: 13,
                CornerRadius: 0,
                ShowDivider: false
            });
        }
    };

    /* ---------------------------------------------------------------- *
     * the grammar, pure, for tools/test-overview.js
     * ---------------------------------------------------------------- */

    function trim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }

    /** "a=1; tab=new" -> {a: '1', tab: 'new'}, keys lower-cased. */
    function parsePairs(s) {
        var out = {};
        var chunks = String(s || '').split(';');
        for (var i = 0; i < chunks.length; i++) {
            var c = trim(chunks[i]);
            var eq = c.indexOf('=');
            if (eq <= 0) { continue; }
            out[trim(c.slice(0, eq)).toLowerCase()] = trim(c.slice(eq + 1));
        }
        return out;
    }

    /**
     * Text -> {items: tree, dropped: n, lines: n}. Each item is
     * {label, icon, tip, target, opts, kind: 'display'|'web'|'none', children,
     * sep, id}; `id` is its position, "0.2.1", so open and expanded state
     * survive a rebuild of the same text.
     */
    function parseMenu(text, iconNames) {
        var root = { children: [] };
        var stack = [{ indent: -1, node: root }];
        var lines = String(text || '').split(/\r?\n/);
        var count = 0;
        for (var i = 0; i < lines.length; i++) {
            var raw = lines[i];
            if (!trim(raw) || trim(raw).charAt(0) === '#') { continue; }
            var indent = 0, k = 0;
            for (; k < raw.length; k++) {
                var ch = raw.charAt(k);
                if (ch === ' ') { indent += 1; } else if (ch === '\t') { indent += 4; } else if (ch === '>') { indent += 4; } else { break; }
            }
            var body = trim(raw.slice(k));
            while (stack.length > 1 && stack[stack.length - 1].indent >= indent) { stack.pop(); }
            var parent = stack[stack.length - 1].node;
            if (/^-{3,}$/.test(body)) { parent.children.push({ sep: true, children: [] }); continue; }
            var item = parseLine(body, iconNames);
            if (!item) { continue; }
            count += 1;
            parent.children.push(item);
            stack.push({ indent: indent, node: item });
        }
        var dropped = prune(root);
        number(root.children, '');
        return { items: root.children, dropped: dropped, count: count };
    }

    function parseLine(s, iconNames) {
        var label = s, target = '', extra = '';
        var first = s.indexOf('|');
        if (first !== -1) {
            label = trim(s.slice(0, first));
            var rest = s.slice(first + 1);
            var second = rest.indexOf('|');
            target = trim(second === -1 ? rest : rest.slice(0, second));
            extra = second === -1 ? '' : trim(rest.slice(second + 1));
        }
        var tip = '', icon = '';
        var dash = label.indexOf(' -- ');
        if (dash !== -1) { tip = trim(label.slice(dash + 4)); label = trim(label.slice(0, dash)); }
        var im = /^\[([a-z]+)\]\s*/.exec(label);
        // An unknown icon name stays in the label, where it is visibly wrong.
        if (im && iconNames && iconNames[im[1]]) { icon = im[1]; label = trim(label.slice(im[0].length)); }
        if (!label && !icon) { return null; }
        return {
            label: label, icon: icon, tip: tip, target: target, opts: parsePairs(extra),
            kind: !target ? 'none' : (/^https?:\/\//i.test(target) ? 'web' : 'display'),
            children: [], sep: false, id: ''
        };
    }

    /** Leaves that go nowhere are taken out, and counted; so are separators at an edge. */
    function prune(node) {
        var dropped = 0;
        var kept = [];
        for (var i = 0; i < node.children.length; i++) {
            var c = node.children[i];
            if (c.sep) { kept.push(c); continue; }
            dropped += prune(c);
            if (c.kind === 'none' && !c.children.length) { dropped += 1; continue; }
            kept.push(c);
        }
        // A separator first, last or doubled separates nothing.
        var out = [];
        for (var j = 0; j < kept.length; j++) {
            if (kept[j].sep && (!out.length || out[out.length - 1].sep)) { continue; }
            out.push(kept[j]);
        }
        while (out.length && out[out.length - 1].sep) { out.pop(); }
        node.children = out;
        return dropped;
    }

    function number(list, prefix) {
        for (var i = 0; i < list.length; i++) {
            list[i].id = prefix + i;
            number(list[i].children, prefix + i + '.');
        }
    }

    /**
     * Anything that names a display, reduced to what identifies it: the id
     * from "1234", "1234/slug", "/Displays/1234/slug" or a full address. The
     * slug follows the display's name, so it must not decide a match.
     */
    function displayKey(s) {
        var v = trim(s);
        if (!v) { return ''; }
        var h = v.indexOf('#');
        if (h !== -1) { v = v.slice(h + 1); }
        var q = v.indexOf('?');
        if (q !== -1) { v = v.slice(0, q); }
        var m = /\/?displays\//i.exec(v);
        if (m) { return v.slice(m.index + m[0].length).split('/')[0].toLowerCase(); }
        if (v.charAt(0) === '/') { return v.toLowerCase().replace(/\/+$/, ''); }
        return v.split('/')[0].toLowerCase();
    }

    /** The ids of the item matching the current display and of every menu above it. */
    function activePath(items, currentKey) {
        if (!currentKey) { return []; }
        for (var i = 0; i < items.length; i++) {
            var it = items[i];
            if (it.sep) { continue; }
            var below = activePath(it.children, currentKey);
            if (below.length) { return [it.id].concat(below); }
            if (it.kind === 'display' && displayKey(it.target) === currentKey) { return [it.id]; }
        }
        return [];
    }

    symbolVis.parseMenu = parseMenu;
    symbolVis.displayKey = displayKey;
    symbolVis.activePath = activePath;

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = { note: '' };

        var ICONS = PVX.icons.paths;
        var built = '';            // what the bar was built from
        var tree = [];
        var openPath = [];         // ids of the drop-downs open, outermost first
        var expanded = {};         // side menu and collapsed panel: id -> true
        var collapsed = false;
        var layer = null;          // drop-downs, on document.body
        var hoverTimer = null;
        var docDown = null, docKey = null, hashListener = null;
        var sourceAsset = '';
        var logoFailed = '';
        var lastNote = '';

        // ItemsFrom 'af': the menu text read from an AF attribute.
        var menu = { path: '', text: null, error: '', at: 0, gen: 0, timer: null };
        var MENU_MS = 60000;
        var HOVER_CLOSE_MS = 350;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-dmenu-body',
            render: render,
            onData: function (d) {
                var one = PVX.data.single(d);
                var a = one ? PVX.nav.assetOf(one.path) : '';
                if (a !== sourceAsset) { sourceAsset = a; ctx.render(); }
            },
            onConfigChange: function () { built = ''; },
            onDestroy: teardown
        });

        /* ================================================================ *
         * where the menu comes from
         * ================================================================ */

        function fromAf(cfg) { return cfg.ItemsFrom === 'af' && trim(cfg.ItemsAttribute); }

        /** "|Menu" is an attribute of the display's asset, else of the data source's element. */
        function attributePath(cfg) {
            var p = trim(cfg.ItemsAttribute);
            if (p.charAt(0) !== '|') { return p; }
            var asset = trim(PVX.nav.currentAsset()) || sourceAsset;
            return asset ? asset.replace(/[\\]+$/, '') + p : '';
        }

        function menuText(cfg) {
            if (!fromAf(cfg)) { stopMenu(); return cfg.Items || ''; }
            askMenu(cfg);
            if (menu.timer === null) { menu.timer = setInterval(function () { askMenu(ctx.config || {}); }, MENU_MS); }
            return menu.text !== null ? menu.text : (cfg.Items || '');
        }

        function stopMenu() {
            if (menu.timer !== null) { clearInterval(menu.timer); menu.timer = null; }
            menu.path = ''; menu.text = null; menu.error = '';
        }

        function askMenu(cfg) {
            var path = attributePath(cfg);
            var now = (new Date()).getTime();
            if (!path) {
                menu.path = ''; menu.text = null;
                menu.error = 'the attribute starts with | but there is no asset in the address or data source to read it from';
                return;
            }
            if (path === menu.path && now - menu.at < MENU_MS - 1000) { return; }
            if (path !== menu.path) { menu.text = null; menu.error = ''; }
            menu.path = path;
            menu.at = now;
            if (PVX.api.discovering()) {
                menu.at = 0;
                PVX.api.discover().then(function () { ctx.render(); });
                return;
            }
            if (!PVX.api.isConfigured()) { menu.error = PVX.api.unsetHint(); return; }
            var gen = ++menu.gen;
            PVX.af.text(path).then(function (text) {
                if (gen !== menu.gen || ctx.destroyed) { return; }
                menu.error = trim(text) ? '' : 'the attribute is empty';
                menu.text = menu.error ? null : text;
                built = '';
                ctx.render();
            }, function (err) {
                if (gen !== menu.gen || ctx.destroyed) { return; }
                menu.error = (err && err.pvxError && err.pvxError.message) || 'the attribute could not be read';
                menu.text = null;
                ctx.render();
            });
        }

        /* ================================================================ *
         * acting on an item
         * ================================================================ */

        function isEditMode() {
            try { if (scope.runtimeData && scope.runtimeData.isEditMode) { return true; } } catch (e) { /* shape differs */ }
            try { if (scope.$root && scope.$root.isEditMode) { return true; } } catch (e2) { /* ignore */ }
            return false;
        }

        function no(v) { return /^(no|false|0|off)$/i.test(trim(v)); }

        function urlOf(item, cfg) {
            if (item.kind === 'web') { return item.target; }
            if (item.kind !== 'display') { return ''; }
            var o = item.opts;
            var opts = {
                display: item.target,
                keepAsset: o.keepasset !== undefined ? !no(o.keepasset) : cfg.KeepAsset !== false,
                keepTime: o.keeptime !== undefined ? !no(o.keeptime) : cfg.KeepTime !== false
            };
            if (o.asset !== undefined) { opts.asset = o.asset; }
            if (o.start !== undefined) { opts.start = o.start; }
            if (o.end !== undefined) { opts.end = o.end; }
            return PVX.nav.url(opts);
        }

        function newTab(item, cfg) {
            if (item.opts.tab !== undefined) { return /^new$/i.test(item.opts.tab); }
            // A web page leaves PI Vision; by default it gets a tab of its own.
            return item.kind === 'web' ? true : cfg.OpenInNewTab === true;
        }

        function tipOf(item, cfg) {
            if (item.tip) { return item.tip; }
            if (item.kind === 'web') { return item.target + (newTab(item, cfg) ? ' (new tab)' : ''); }
            if (item.kind === 'display') {
                var o = item.opts;
                return 'Display ' + item.target + (o.asset ? ', asset ' + o.asset : '') +
                    (o.start ? ', from ' + o.start + ' to ' + (o.end || '*') : '');
            }
            return item.label;
        }

        function activate(item) {
            var cfg = ctx.config || {};
            if (item.children.length) { return; }
            if (isEditMode()) { return; }
            var url = urlOf(item, cfg);
            if (!url) { return; }
            closeAll();
            PVX.nav.go(url, newTab(item, cfg));
        }

        /** The current address with one of PI Vision's view switches flipped. */
        function toggleUrl(key) {
            var cur = PVX.nav.parseHash();
            var params = {};
            for (var k in cur.params) {
                if (Object.prototype.hasOwnProperty.call(cur.params, k)) {
                    params[k] = cur.params[k] === '' ? true : cur.params[k];
                }
            }
            if (key === 'kiosk') {
                if (String(params.mode || '').toLowerCase() === 'kiosk') { delete params.mode; } else { params.mode = 'kiosk'; }
            } else if (Object.prototype.hasOwnProperty.call(params, key)) { delete params[key]; } else { params[key] = true; }
            return PVX.nav.buildHash({ base: cur.base, path: cur.path, params: params });
        }

        function viewOn(key) {
            var p = PVX.nav.parseHash().params;
            if (key === 'kiosk') { return String(p.mode || '').toLowerCase() === 'kiosk'; }
            return Object.prototype.hasOwnProperty.call(p, key);
        }

        function toggleView(key) {
            if (isEditMode()) { return; }
            var url = toggleUrl(key);
            try {
                window.location.href = url;
                // Only the hash changes, and PI Vision reads these switches as
                // it loads a display, so load it again to apply them.
                window.location.reload();
            } catch (e) { /* blocked: nothing useful to do */ }
        }

        /* ================================================================ *
         * drawing
         * ================================================================ */

        function el(tag, cls, parent) {
            var n = document.createElement(tag);
            if (cls) { n.className = cls; }
            if (parent) { parent.appendChild(n); }
            return n;
        }

        function clearNode(n) { while (n && n.firstChild) { n.removeChild(n.firstChild); } }

        function colours(cfg) {
            var t = ctx.theme || {};
            return {
                bg: cfg.Transparent ? 'transparent' : (t.surface || '#ffffff'),
                pop: t.surface && t.surface !== 'transparent' ? t.surface : (t.dark ? '#22262b' : '#ffffff'),
                fg: cfg.ItemColor || t.text || '#1d2126',
                muted: t.textMuted || '#5c6570',
                border: t.border || '#d6dbe1',
                accent: cfg.HighlightColor || cfg.AccentColor || '#3b82c4',
                shadow: t.shadow || 'rgba(0,0,0,0.18)'
            };
        }

        function applyVars(node, c, cfg) {
            node.style.setProperty('--pvx-dm-bg', c.bg);
            node.style.setProperty('--pvx-dm-pop', c.pop);
            node.style.setProperty('--pvx-dm-fg', c.fg);
            node.style.setProperty('--pvx-dm-muted', c.muted);
            node.style.setProperty('--pvx-dm-border', c.border);
            node.style.setProperty('--pvx-dm-accent', c.accent);
            node.style.setProperty('--pvx-dm-shadow', c.shadow);
            var fs = PVX.util.num(cfg.FontSize);
            node.style.setProperty('--pvx-dm-font', PVX.util.clamp(fs === null ? 13 : fs, 8, 28) + 'px');
        }

        /** One entry's button: icon, label, and a caret when it opens more. */
        function itemButton(item, cfg, cls, level, active) {
            var b = el('button', cls);
            b.type = 'button';
            b.setAttribute('data-id', item.id);
            b.title = item.children.length ? (item.tip || '') : tipOf(item, cfg);
            if (!item.label) { b.setAttribute('aria-label', item.tip || item.target || item.icon); }
            if (active[item.id]) { b.setAttribute('data-active', active[item.id]); }
            var icon = item.icon ? PVX.icons.el(item.icon, 'pvx-dmenu-icon') : null;
            var endIcon = cfg.IconPosition === 'end';
            if (icon && !endIcon) { b.appendChild(icon); }
            if (item.label) { el('span', 'pvx-dmenu-label', b).textContent = item.label; }
            if (icon && endIcon) { b.appendChild(icon); }
            if (item.kind === 'web' && newTab(item, cfg) && item.icon !== 'external') {
                b.appendChild(PVX.icons.el('external', 'pvx-dmenu-badge'));
            }
            if (item.children.length) {
                b.setAttribute('aria-haspopup', 'true');
                b.setAttribute('aria-expanded', 'false');
                b.appendChild(PVX.icons.el(level === 0 && cfg.Layout !== 'side' ? 'down' : 'forward', 'pvx-dmenu-caret'));
            }
            return b;
        }

        function find(items, id) {
            for (var i = 0; i < items.length; i++) {
                if (items[i].sep) { continue; }
                if (items[i].id === id) { return items[i]; }
                var f = find(items[i].children, id);
                if (f) { return f; }
            }
            return null;
        }

        function activeMap(cfg) {
            var out = {};
            if (cfg.ShowActive === false) { return out; }
            var path = activePath(tree, displayKey(PVX.nav.parseHash().path));
            for (var i = 0; i < path.length; i++) { out[path[i]] = i === path.length - 1 ? 'item' : 'parent'; }
            return out;
        }

        function render() {
            var cfg = ctx.config || {};
            var host = ctx.host;
            if (!host) { return; }
            var root = ctx.node;
            var c = colours(cfg);
            applyVars(root, c, cfg);

            var text = menuText(cfg);
            var parsed = parseMenu(text, ICONS);
            tree = parsed.items;

            var notes = [];
            if (fromAf(cfg) && menu.error) { notes.push('Menu from AF: ' + menu.error + '; showing the typed items'); }
            if (parsed.dropped) {
                notes.push(parsed.dropped + (parsed.dropped === 1 ? ' line has' : ' lines have') +
                    ' no address and nothing under ' + (parsed.dropped === 1 ? 'it' : 'them') + ', so ' +
                    (parsed.dropped === 1 ? 'it is' : 'they are') + ' left out');
            }
            if (logoFailed && logoFailed === trim(cfg.LogoUrl)) { notes.push('the logo at "' + logoFailed + '" did not load'); }

            var sig = [text, cfg.Layout, cfg.Collapse, cfg.MenuLabel, cfg.IconPosition, cfg.ShowBack, cfg.ShowKioskToggle,
                cfg.ShowToolbarToggle, cfg.ShowTimebarToggle, cfg.ShowSidebarToggle, cfg.LogoUrl, cfg.LogoPosition,
                cfg.LogoHeight, cfg.LogoTarget, cfg.LogoAlt, cfg.ShowActive, cfg.ShowDivider, notes.join('|'),
                PVX.nav.currentUrl(), ctx.width, ctx.height, JSON.stringify(expanded)].join('\u0001');
            if (sig === built) { return; }
            built = sig;

            bindDocument();
            var side = cfg.Layout === 'side';
            var mode = cfg.Collapse === 'always' ? 'collapsed' : 'open';
            build(host, cfg, side, mode === 'collapsed', notes);
            // Narrow: collapse only when the open menu does not fit.
            if (mode === 'open' && cfg.Collapse !== 'never' && overflows(host, side)) {
                build(host, cfg, side, true, notes);
            }
            if (openPath.length) { drawLayer(cfg); }

            var note = notes.join(' \u00b7 ');
            if (note !== lastNote) {
                lastNote = note;
                scope.pvx.note = note;
                try { if (scope.$evalAsync) { scope.$evalAsync(function () {}); } } catch (e) { /* no Angular */ }
            }
        }

        function overflows(host, side) {
            var list = host.querySelector('.pvx-dmenu-items');
            if (!list) { return false; }
            return side ? list.scrollHeight > list.clientHeight + 1 : list.scrollWidth > list.clientWidth + 1;
        }

        function build(host, cfg, side, isCollapsed, notes) {
            collapsed = isCollapsed;
            clearNode(host);
            var bar = el('div', 'pvx-dmenu-bar' + (side ? ' pvx-dmenu-side' : ' pvx-dmenu-row') +
                (cfg.ShowDivider ? ' pvx-dmenu-divided' : ''), host);
            bar.setAttribute('role', 'menubar');
            var logoStart = cfg.LogoPosition !== 'end';
            if (trim(cfg.LogoUrl) && logoStart) { logo(bar, cfg); }
            if (cfg.ShowBack) {
                var back = el('button', 'pvx-dmenu-tool pvx-dmenu-back', bar);
                back.type = 'button';
                back.title = 'Back to the previous display';
                back.setAttribute('aria-label', 'Back');
                back.appendChild(PVX.icons.el('back', 'pvx-dmenu-icon'));
                back.setAttribute('data-tool', 'back');
            }

            var active = activeMap(cfg);
            if (isCollapsed) {
                var btn = el('button', 'pvx-dmenu-item pvx-dmenu-burger', bar);
                btn.type = 'button';
                btn.setAttribute('data-id', '*');
                btn.setAttribute('aria-haspopup', 'true');
                btn.setAttribute('aria-expanded', openPath[0] === '*' ? 'true' : 'false');
                btn.appendChild(PVX.icons.el('menu', 'pvx-dmenu-icon'));
                var lbl = trim(cfg.MenuLabel);
                if (lbl) { el('span', 'pvx-dmenu-label', btn).textContent = lbl; } else { btn.setAttribute('aria-label', 'Menu'); }
                el('div', 'pvx-dmenu-items pvx-dmenu-spacer', bar);
            } else {
                var list = el('div', 'pvx-dmenu-items', bar);
                if (!tree.length) {
                    el('span', 'pvx-dmenu-empty', list).textContent = 'No menu entries yet: add them under Items in Format.';
                }
                if (side) { sideList(list, tree, cfg, 0, active); } else {
                    for (var i = 0; i < tree.length; i++) {
                        var it = tree[i];
                        if (it.sep) { el('span', 'pvx-dmenu-sep', list).setAttribute('role', 'separator'); continue; }
                        var b = itemButton(it, cfg, 'pvx-dmenu-item pvx-dmenu-top', 0, active);
                        b.setAttribute('role', 'menuitem');
                        if (openPath[0] === it.id) { b.setAttribute('aria-expanded', 'true'); }
                        list.appendChild(b);
                    }
                }
            }

            var tools = [['kiosk', cfg.ShowKioskToggle, 'kiosk mode (PI Vision without its menus)'],
                ['hidetoolbar', cfg.ShowToolbarToggle, 'PI Vision toolbar'],
                ['hidetimebar', cfg.ShowTimebarToggle, 'time bar'],
                ['hidesidebar', cfg.ShowSidebarToggle, 'side bar']];
            var anyTool = false;
            for (var ti = 0; ti < tools.length; ti++) {
                if (!tools[ti][1]) { continue; }
                if (!anyTool) { el('span', 'pvx-dmenu-gap', bar); anyTool = true; }
                var key = tools[ti][0];
                var on = viewOn(key);
                var tb = el('button', 'pvx-dmenu-tool', bar);
                tb.type = 'button';
                tb.setAttribute('data-tool', key);
                tb.setAttribute('aria-pressed', on ? 'true' : 'false');
                var hides = key !== 'kiosk';
                tb.title = hides ? (on ? 'Show the ' : 'Hide the ') + tools[ti][2] : (on ? 'Leave ' : 'Enter ') + tools[ti][2];
                tb.appendChild(PVX.icons.el(key === 'kiosk' ? 'kiosk' : key.replace('hide', ''), 'pvx-dmenu-icon'));
            }
            if (notes.length) {
                var n = el('span', 'pvx-dmenu-note', bar);
                n.textContent = '\u26a0 ' + notes.join(' \u00b7 ');
                n.title = notes.join('\n');
            }
            if (trim(cfg.LogoUrl) && !logoStart) { logo(bar, cfg); }
            bindHost(host);
        }

        /** The side menu and the collapsed panel: nested, expanding in place. */
        function sideList(parent, items, cfg, level, active) {
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (it.sep) { el('div', 'pvx-dmenu-hsep', parent).setAttribute('role', 'separator'); continue; }
                var b = itemButton(it, cfg, 'pvx-dmenu-item pvx-dmenu-row-item', level, active);
                b.style.paddingLeft = (8 + level * 14) + 'px';
                b.setAttribute('role', 'menuitem');
                parent.appendChild(b);
                if (it.children.length) {
                    // The way to the current display starts open.
                    var open = expanded[it.id] !== undefined ? expanded[it.id] : active[it.id] === 'parent';
                    b.setAttribute('aria-expanded', open ? 'true' : 'false');
                    if (open) { sideList(parent, it.children, cfg, level + 1, active); }
                }
            }
        }

        function logo(bar, cfg) {
            var url = trim(cfg.LogoUrl);
            var wrap = el(trim(cfg.LogoTarget) ? 'button' : 'span', 'pvx-dmenu-logo', bar);
            if (trim(cfg.LogoTarget)) {
                wrap.type = 'button';
                wrap.setAttribute('data-tool', 'logo');
                wrap.title = 'Display ' + trim(cfg.LogoTarget);
            }
            var img = el('img', '', wrap);
            img.alt = cfg.LogoAlt || 'Logo';
            var h = PVX.util.num(cfg.LogoHeight);
            if (h !== null && h > 0) { img.style.height = h + 'px'; }
            img.onerror = function () {
                if (logoFailed === url) { return; }
                logoFailed = url;
                built = '';
                ctx.render();
            };
            img.onload = function () {
                if (logoFailed !== url) { return; }
                logoFailed = '';
                built = '';
                ctx.render();
            };
            img.src = url;
        }

        /* ================================================================ *
         * drop-downs, on document.body
         * ================================================================ */

        function ensureLayer(cfg) {
            if (layer && layer.parentNode) { return layer; }
            layer = document.createElement('div');
            layer.className = 'pvx-dmenu-layer';
            document.body.appendChild(layer);
            layer.addEventListener('click', onClick, false);
            layer.addEventListener('mouseover', onOver, false);
            layer.addEventListener('mouseout', onOut, false);
            layer.addEventListener('keydown', onKey, false);
            return layer;
        }

        function drawLayer(cfg) {
            if (!openPath.length) { removeLayer(); return; }
            var c = colours(cfg);
            var L = ensureLayer(cfg);
            applyVars(L, c, cfg);
            // Text size: the bar is zoomed with the symbol, so the menus are too.
            var z = ctx.fontScale && ctx.fontScale !== 1 ? String(ctx.fontScale) : '';
            L.style.zoom = z;
            clearNode(L);
            var host = ctx.host;
            var opener = host ? host.querySelector('[data-id="' + openPath[0] + '"]') : null;
            if (!opener) { openPath = []; removeLayer(); return; }
            var active = activeMap(cfg);
            var scale = z ? ctx.fontScale : 1;
            var r = opener.getBoundingClientRect();
            var side = cfg.Layout === 'side';
            var anchor = side ? { x: r.right, y: r.top } : { x: r.left, y: r.bottom };

            if (openPath[0] === '*') {
                var panel = el('div', 'pvx-dmenu-pop pvx-dmenu-panel', L);
                panel.setAttribute('role', 'menu');
                if (!tree.length) { el('div', 'pvx-dmenu-empty', panel).textContent = 'No menu entries yet.'; }
                sideList(panel, tree, cfg, 0, active);
                place(panel, { x: r.left, y: r.bottom }, scale);
                return;
            }

            var items = tree;
            for (var lv = 0; lv < openPath.length; lv++) {
                var owner = find(items === tree ? tree : items, openPath[lv]) || find(tree, openPath[lv]);
                if (!owner || !owner.children.length) { openPath = openPath.slice(0, lv); break; }
                var pop = el('div', 'pvx-dmenu-pop', L);
                pop.setAttribute('role', 'menu');
                pop.setAttribute('data-level', String(lv));
                for (var i = 0; i < owner.children.length; i++) {
                    var it = owner.children[i];
                    if (it.sep) { el('div', 'pvx-dmenu-hsep', pop).setAttribute('role', 'separator'); continue; }
                    var b = itemButton(it, cfg, 'pvx-dmenu-item pvx-dmenu-row-item', lv + 1, active);
                    b.setAttribute('role', 'menuitem');
                    if (openPath[lv + 1] === it.id) { b.setAttribute('aria-expanded', 'true'); }
                    pop.appendChild(b);
                }
                place(pop, anchor, scale);
                var next = openPath[lv + 1];
                if (next) {
                    var row = pop.querySelector('[data-id="' + next + '"]');
                    if (!row) { openPath = openPath.slice(0, lv + 1); break; }
                    var rr = row.getBoundingClientRect();
                    anchor = { x: pop.getBoundingClientRect().right, y: rr.top - 4 };
                }
                items = owner.children;
            }
        }

        /** Put a menu at a point, kept on the screen. */
        function place(pop, at, scale) {
            pop.style.left = '0px';
            pop.style.top = '0px';
            var w = pop.offsetWidth * scale, h = pop.offsetHeight * scale;
            var vw = window.innerWidth || document.documentElement.clientWidth;
            var vh = window.innerHeight || document.documentElement.clientHeight;
            var x = Math.max(4, Math.min(at.x, vw - w - 4));
            var y = Math.max(4, Math.min(at.y, vh - h - 4));
            pop.style.left = (x / scale) + 'px';
            pop.style.top = (y / scale) + 'px';
        }

        function removeLayer() {
            if (layer && layer.parentNode) { layer.parentNode.removeChild(layer); }
            layer = null;
        }

        /** A click or a key draws at once; waiting for the next frame left a
         *  second click landing on the menu as it was before the first. */
        function show() { if (ctx.renderNow) { ctx.renderNow(); } else { ctx.render(); } }

        function closeAll() {
            if (!openPath.length) { return; }
            openPath = [];
            removeLayer();
            built = '';
            show();
        }

        /** Open the menu of `id`, which sits at `level` (0 the bar), closing deeper ones. */
        function openAt(level, id) {
            openPath = openPath.slice(0, level).concat([id]);
            built = '';
            show();
        }

        /* ================================================================ *
         * events: one listener per container, by data-id
         * ================================================================ */

        var boundHost = null;
        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            boundHost = host;
            host.addEventListener('click', onClick, false);
            host.addEventListener('mouseover', onOver, false);
            host.addEventListener('mouseout', onOut, false);
            host.addEventListener('keydown', onKey, false);
        }

        function unbindHost() {
            if (!boundHost) { return; }
            boundHost.removeEventListener('click', onClick, false);
            boundHost.removeEventListener('mouseover', onOver, false);
            boundHost.removeEventListener('mouseout', onOut, false);
            boundHost.removeEventListener('keydown', onKey, false);
            boundHost = null;
        }

        function bindDocument() {
            if (docDown) { return; }
            docDown = function (ev) {
                if (!openPath.length) { return; }
                var t = ev.target;
                if ((boundHost && boundHost.contains(t)) || (layer && layer.contains(t))) { return; }
                closeAll();
            };
            docKey = function (ev) { if (ev.key === 'Escape' || ev.keyCode === 27) { closeAll(); } };
            hashListener = function () { built = ''; openPath = []; removeLayer(); ctx.render(); };
            document.addEventListener('mousedown', docDown, true);
            document.addEventListener('touchstart', docDown, true);
            document.addEventListener('keydown', docKey, false);
            window.addEventListener('hashchange', hashListener, false);
        }

        function buttonOf(ev) {
            var n = ev.target;
            while (n && n !== boundHost && n !== layer && n.nodeType === 1) {
                if (n.tagName === 'BUTTON') { return n; }
                n = n.parentNode;
            }
            return null;
        }

        function levelOf(b) {
            var pop = b.parentNode;
            while (pop && pop !== layer && !(pop.getAttribute && pop.getAttribute('data-level') !== null)) { pop = pop.parentNode; }
            return pop && pop !== layer && pop.getAttribute ? parseInt(pop.getAttribute('data-level'), 10) + 1 : 0;
        }

        function inLayer(b) { return !!(layer && layer.contains(b)); }

        /** True where the item expands in place: the side menu and the collapsed panel. */
        function inPlace(b) {
            var cfg = ctx.config || {};
            if (inLayer(b)) { return openPath[0] === '*'; }
            return cfg.Layout === 'side';
        }

        function onClick(ev) {
            var b = buttonOf(ev);
            if (!b) { return; }
            var tool = b.getAttribute('data-tool');
            if (tool) {
                if (tool === 'back') { if (!isEditMode()) { try { window.history.back(); } catch (e) { /* ignore */ } } return; }
                if (tool === 'logo') { activate({ kind: 'display', target: trim((ctx.config || {}).LogoTarget), opts: {}, children: [] }); return; }
                toggleView(tool);
                return;
            }
            var id = b.getAttribute('data-id');
            if (id === '*') {
                if (openPath[0] === '*') { closeAll(); } else { openAt(0, '*'); }
                return;
            }
            var item = find(tree, id);
            if (!item) { return; }
            if (!item.children.length) { activate(item); return; }
            if (inPlace(b)) {
                var open = b.getAttribute('aria-expanded') === 'true';
                expanded[id] = !open;
                built = '';
                show();
                return;
            }
            var lv = inLayer(b) ? levelOf(b) : 0;
            // Pointing may have opened it already, a moment before the click
            // arrives: a click only closes a bar entry's menu, and only when
            // menus open on a click.
            if (openPath[lv] === id && lv === 0 && !hovering()) { openPath = []; built = ''; removeLayer(); show(); }
            else if (openPath[lv] !== id) { openAt(lv, id); }
        }

        function hovering() { return (ctx.config || {}).SubmenuOpen === 'hover'; }

        function onOver(ev) {
            if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
            var b = buttonOf(ev);
            if (!b || b.getAttribute('data-tool')) { return; }
            var id = b.getAttribute('data-id');
            if (id === '*' || inPlace(b)) { return; }
            var item = find(tree, id);
            if (!item) { return; }
            var lv = inLayer(b) ? levelOf(b) : 0;
            // Inside an open menu, pointing at a row with more under it opens
            // that too, whatever the setting: the click already made the choice.
            if (lv === 0 && !hovering() && !openPath.length) { return; }
            if (item.children.length) { if (openPath[lv] !== id) { openAt(lv, id); } }
            else if (openPath.length > lv) { openPath = openPath.slice(0, lv); built = ''; if (!openPath.length) { removeLayer(); } show(); }
        }

        function onOut(ev) {
            if (!hovering() || !openPath.length || openPath[0] === '*') { return; }
            var to = ev.relatedTarget;
            if (to && ((boundHost && boundHost.contains(to)) || (layer && layer.contains(to)))) { return; }
            if (hoverTimer) { clearTimeout(hoverTimer); }
            hoverTimer = setTimeout(function () { hoverTimer = null; closeAll(); }, HOVER_CLOSE_MS);
        }

        /** Arrow keys move through a menu; Right opens, Left closes, Escape leaves. */
        function onKey(ev) {
            var b = buttonOf(ev);
            if (!b) { return; }
            var key = ev.key;
            var group = b.parentNode;
            var list = Array.prototype.filter.call(group.children, function (n) { return n.tagName === 'BUTTON'; });
            var i = list.indexOf(b);
            var vertical = inLayer(b) || (ctx.config || {}).Layout === 'side';
            var nextKey = vertical ? 'ArrowDown' : 'ArrowRight', prevKey = vertical ? 'ArrowUp' : 'ArrowLeft';
            if (key === nextKey || key === prevKey) {
                var j = (i + (key === nextKey ? 1 : -1) + list.length) % list.length;
                if (list[j]) { list[j].focus(); }
                ev.preventDefault();
                return;
            }
            var id = b.getAttribute('data-id');
            var item = id && id !== '*' ? find(tree, id) : null;
            var opens = (!vertical && key === 'ArrowDown') || (vertical && key === 'ArrowRight');
            if (opens && (id === '*' || (item && item.children.length)) && !inPlace(b)) {
                var lv = inLayer(b) ? levelOf(b) : 0;
                openAt(lv, id);
                focusFirst(lv);
                ev.preventDefault();
            } else if (key === 'ArrowLeft' && inLayer(b)) {
                var at = levelOf(b);
                var openerId = openPath[at - 1];
                openPath = openPath.slice(0, at - 1 < 0 ? 0 : at - 1);
                built = '';
                if (!openPath.length) { removeLayer(); }
                show();
                refocus(openerId);
                ev.preventDefault();
            } else if (key === 'Escape') {
                var top = openPath[0];
                closeAll();
                refocus(top);
            }
        }

        function focusFirst(level) {
            setTimeout(function () {
                if (!layer) { return; }
                var pops = layer.querySelectorAll('.pvx-dmenu-pop');
                var pop = pops[Math.min(level, pops.length - 1)];
                var first = pop ? pop.querySelector('button') : null;
                if (first) { first.focus(); }
            }, 40);
        }

        function refocus(id) {
            setTimeout(function () {
                var n = (layer && layer.querySelector('[data-id="' + id + '"]')) ||
                    (ctx.host && ctx.host.querySelector('[data-id="' + id + '"]'));
                if (n) { n.focus(); }
            }, 40);
        }

        function teardown() {
            if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
            if (menu.timer !== null) { clearInterval(menu.timer); menu.timer = null; }
            menu.gen += 1;
            unbindHost();
            removeLayer();
            if (docDown) {
                document.removeEventListener('mousedown', docDown, true);
                document.removeEventListener('touchstart', docDown, true);
                document.removeEventListener('keydown', docKey, false);
                window.removeEventListener('hashchange', hashListener, false);
                docDown = docKey = hashListener = null;
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);
}(window.PIVisualization));
