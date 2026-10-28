/* ============================================================================
 * pvxEmbeddedPage — another page in a frame, refreshed on a timer
 * ----------------------------------------------------------------------------
 * DataShape: Value. The data source is ignored unless the address is set to
 * come from it, for a URL held in an AF attribute.
 *
 * WHAT A FRAME CAN AND CANNOT KNOW
 *   A PI Vision display, or anything else on PI Vision's own server, always
 *   loads: it is the same site, so nothing blocks it, and the symbol can
 *   tell it loaded. Another site loads only if it allows framing. When it
 *   refuses (X-Frame-Options, or frame-ancestors in its Content Security
 *   Policy) the browser shows an empty frame, and fires the same "load" it
 *   fires on success; a page cannot read another site's frame to tell the
 *   two apart. So the symbol says, under any page from another site, that a
 *   blank frame means the site refused, and always offers Open in a new tab,
 *   which works either way. That is what the roadmap's objection to a web
 *   view was about: the failure is invisible, so it has to be named.
 *
 *   A frame that never loads at all (a name that does not resolve, a server
 *   that does not answer) is reported after a timeout.
 *
 * EDITING
 *   A frame swallows the clicks over it, and in PI Vision's editor a click
 *   is how a symbol is selected and moved. In edit mode a transparent shield
 *   covers the frame so the symbol can still be picked up.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxEmbeddedPage',
        displayName: 'PVX Embedded Page',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Single,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Embedded Page',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Value',
                Height: 360,
                Width: 560,

                Url: '',                    // blank, a PI Vision display id, a path, or http(s)://
                UrlSource: 'config',        // config | source (the data source's value is the address)
                KeepAsset: true,            // PI Vision displays only
                KeepTime: true,
                Kiosk: true,
                RefreshMinutes: 0,          // 0 = never
                Zoom: 100,                  // percent
                Restrict: false,            // sandbox the frame
                LoadTimeoutSeconds: 20,

                ShowToolbar: true,
                Title: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        scope.pvx = {
            title: '',
            surface: 'transparent',
            target: '',                 // what the frame is showing, for Open in a new tab
            note: '',
            warn: false,
            edit: false
        };

        var sourceValue = '';
        var frame = null;
        var frameHost = null;
        var shownUrl = null;        // address the frame was last pointed at
        var shownSandbox = null;
        var loadTimer = null;
        var refreshTimer = null;
        var refreshEvery = 0;
        var loaded = false;
        var listener = null;
        var lastHashKey = null;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-embed-frame',
            onData: function (d) {
                var one = PVX.data.single(d);
                var raw = one && one.raw !== null && one.raw !== undefined ? String(one.raw).trim() : '';
                sourceValue = raw;
            },
            render: render,
            onDestroy: teardown
        });

        function isEditMode() {
            try { if (scope && scope.runtimeData && scope.runtimeData.isEditMode) { return true; } } catch (e) { /* shape differs */ }
            try { if (scope && scope.$root && scope.$root.isEditMode) { return true; } } catch (e2) { /* ignore */ }
            return false;
        }

        /** The page's own origin, to tell PI Vision's server from another site. */
        function origin() {
            try { return window.location.protocol + '//' + window.location.host; } catch (e) { return ''; }
        }

        /**
         * Resolve what was configured into an address, or an explanation.
         *   "101" or "101/Overview"       a PI Vision display, by id
         *   "#/Displays/101/Overview"     the same, as copied from the address bar
         *   "/PIVision/#/Displays/101"    a path on this server
         *   "https://host/page"           anywhere else
         */
        function resolve(cfg) {
            var raw = cfg.UrlSource === 'source' ? sourceValue : String(cfg.Url || '').trim();
            if (!raw) {
                return { error: cfg.UrlSource === 'source' ?
                    'Waiting for the data source to supply an address.' :
                    'No address set. Open Format and give a PI Vision display id or a web address.' };
            }
            if (/^[a-z][a-z0-9+.\-]*:/i.test(raw) && !/^https?:/i.test(raw)) {
                return { error: 'Only http and https addresses can be shown; "' + raw.split(':')[0] + ':" is refused.' };
            }
            var display = /^\d+(\/[^?#]*)?$/.test(raw) || raw.indexOf('#/Displays/') === 0;
            var url;
            if (display) {
                var params = {};
                if (cfg.Kiosk !== false) { params.mode = 'kiosk'; }
                url = PVX.nav.url({
                    display: raw.charAt(0) === '#' ? raw.slice(1) : raw,
                    keepAsset: cfg.KeepAsset !== false,
                    keepTime: cfg.KeepTime !== false,
                    params: params
                });
                // nav.url carries over this display's own mode; the frame's is ours.
                if (cfg.Kiosk === false) { url = url.replace(/([?&])mode=[^&]*&?/, '$1').replace(/[?&]$/, ''); }
            } else {
                url = raw;
            }
            var abs;
            try { abs = new window.URL(url, window.location.href); } catch (e) { return { error: '"' + raw + '" is not an address.' }; }
            return { url: abs.href, sameSite: abs.protocol + '//' + abs.host === origin(), display: display,
                name: display ? 'PI Vision display ' + raw.replace(/^#?\/Displays\//, '') : abs.host + abs.pathname };
        }

        function clearLoadTimer() {
            if (loadTimer !== null) { clearTimeout(loadTimer); loadTimer = null; }
        }

        function onLoad() {
            loaded = true;
            clearLoadTimer();
            ctx.render();
        }

        /** Report a frame that has not loaded within the timeout. */
        function startTimer(cfg) {
            loaded = false;
            clearLoadTimer();
            var secs = PVX.util.num(cfg.LoadTimeoutSeconds);
            secs = PVX.util.clamp(secs === null ? 20 : secs, 3, 300);
            loadTimer = setTimeout(function () {
                loadTimer = null;
                if (!loaded && !ctx.destroyed) { ctx.render(); }
            }, secs * 1000);
        }

        function point(cfg, r) {
            var sandbox = cfg.Restrict ? 'allow-scripts allow-same-origin allow-forms allow-popups' : null;
            if (r.url === shownUrl && sandbox === shownSandbox) { return; }
            // The sandbox attribute only takes effect on navigation, so a
            // change to it needs a fresh frame, not a new src.
            if (frame && sandbox !== shownSandbox) {
                frame.removeEventListener('load', onLoad, false);
                if (frame.parentNode) { frame.parentNode.removeChild(frame); }
                frame = null;
            }
            if (!frame) {
                frame = document.createElement('iframe');
                frame.className = 'pvx-embed-iframe';
                frame.setAttribute('title', cfg.Title || 'Embedded page');
                frame.setAttribute('referrerpolicy', 'same-origin');
                if (sandbox) { frame.setAttribute('sandbox', sandbox); }
                frame.addEventListener('load', onLoad, false);
                frameHost.appendChild(frame);
            }
            shownSandbox = sandbox;
            shownUrl = r.url;
            startTimer(cfg);
            frame.src = r.url;
        }

        function reload() {
            if (!frame || !shownUrl) { return; }
            startTimer(ctx.config || {});
            try { frame.contentWindow.location.reload(); }
            catch (e) { frame.src = shownUrl; }   // another site: reload by address
        }

        function schedule(cfg) {
            var mins = PVX.util.num(cfg.RefreshMinutes);
            mins = mins === null || mins <= 0 ? 0 : Math.max(mins, 0.25);
            if (mins === refreshEvery) { return; }
            if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
            refreshEvery = mins;
            if (mins) { refreshTimer = setInterval(reload, mins * 60000); }
        }

        function teardown() {
            clearLoadTimer();
            if (refreshTimer !== null) { clearInterval(refreshTimer); refreshTimer = null; }
            if (listener) {
                try { window.removeEventListener('hashchange', listener, false); } catch (e) { /* ignore */ }
                listener = null;
            }
            if (frame) {
                frame.removeEventListener('load', onLoad, false);
                // An emptied frame stops a video or a polling page at once.
                try { frame.src = 'about:blank'; } catch (e2) { /* ignore */ }
            }
            frame = null;
        }

        scope.pvx.reload = function () { if (!isEditMode()) { reload(); } };

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var n = c.node;

            if (n && n.style && n.style.setProperty) {
                n.style.setProperty('--pvx-surface', t.surface);
                n.style.setProperty('--pvx-text', t.text);
                n.style.setProperty('--pvx-muted', t.textMuted);
                n.style.setProperty('--pvx-border', t.border);
                n.style.setProperty('--pvx-embed-warn', PVX.color.status.warning || '#d99024');
            }
            scope.pvx.surface = cfg.Transparent ? 'transparent' : t.surface;
            scope.pvx.edit = isEditMode();

            var r = resolve(cfg);
            var host = c.host;
            if (host !== frameHost) {
                // ng-if may have swapped the node; the old frame went with it.
                frame = null;
                shownUrl = null;
                shownSandbox = null;
                frameHost = host;
            }

            var note = '';
            var warn = false;
            if (r.error) {
                note = r.error;
                warn = true;
                if (frame) { frame.style.display = 'none'; }
                scope.pvx.target = '';
            } else if (frameHost) {
                point(cfg, r);
                frame.style.display = '';
                var z = PVX.util.num(cfg.Zoom);
                z = PVX.util.clamp(z === null ? 100 : z, 25, 400) / 100;
                // Scale the frame, not the page in it: a page from another
                // site cannot be styled from here.
                frame.style.width = (100 / z) + '%';
                frame.style.height = (100 / z) + '%';
                frame.style.transform = z === 1 ? '' : 'scale(' + z + ')';
                scope.pvx.target = r.display && cfg.Kiosk !== false ? r.url.replace(/([?&])mode=kiosk&?/, '$1').replace(/[?&]$/, '') : r.url;
                if (!loaded && loadTimer === null) {
                    note = 'The page did not load. Check the address, and that this computer can reach it.';
                    warn = true;
                } else if (!r.sameSite) {
                    note = 'Another site: shown only if it allows framing. If this stays blank, the site refused; open it in a new tab instead.';
                }
            }
            scope.pvx.note = note;
            scope.pvx.warn = warn;
            scope.pvx.title = cfg.Title || r.name || '';
            schedule(cfg);

            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        // A PI Vision display inside follows this display's asset and time.
        listener = function () {
            var p = PVX.nav.parseHash().params;
            var key = [p.asset, p.starttime, p.endtime].join('\u0001');
            if (key === lastHashKey) { return; }
            lastHashKey = key;
            ctx.render();
        };
        try { window.addEventListener('hashchange', listener, false); } catch (e) { listener = null; }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
