/* ============================================================================
 * pvxGeoView — assets on a map, coloured by state or by value
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources), one marker per data source.
 *
 * Where each marker goes:
 *   - 'af' (default): the Latitude and Longitude attributes of the data
 *     source's AF element, read through PI Web API once a minute. The names
 *     are settings, since sites call them Lat, GPS Latitude, ...
 *   - 'list': typed in the format pane, "Name | lat | lon" per line, matched
 *     to a data source by its label, its element's name or its element path.
 * A source with no location is named in the footer, never left off quietly.
 *
 * The map under the markers is tiles from a server the site names in
 * pvx-config.js (map.tileUrl, Web Mercator {z}/{x}/{y}). Nothing in the
 * library knows of one, so without it the markers sit on a latitude and
 * longitude grid and the footer says how to add the map: a control room
 * display must not quietly fetch tiles from the internet.
 *
 * Colour follows the value: a digital state through StateMap, a number
 * through the threshold bands. Drag to pan, the wheel or + and − to zoom,
 * the fit button to frame every marker again; none of these act while the
 * display is being edited, when a drag is PI Vision's to move the symbol.
 *
 * @mock numeric
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxGeoView',
        displayName: 'PVX Geo View',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: true,
        configTitle: 'Format Geo View',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                Columns: ['Value'],
                Height: 320,
                Width: 480,

                // Where the markers go
                LocationFrom: 'af',        // af | list
                LatAttribute: 'Latitude',
                LonAttribute: 'Longitude',
                Locations: '',

                // Colour
                StateMap: '',
                UseThresholds: true,
                Thresholds: '',

                // Markers
                MarkerSize: 14,
                ShowLabels: true,
                ShowValues: false,
                ShowLegend: true,

                // View
                InitialView: 'fit',        // fit | fixed
                CenterLat: 0,
                CenterLon: 0,
                Zoom: 4,
                MaxFitZoom: 15,
                TileOpacity: 1,

                // Click
                ClickAction: 'none',       // none | asset | display
                ClickDisplay: '',

                Title: ''
            });
        },

        // No bands until the operator sets some: a map coloured green by the
        // library's placeholder bands would claim a normal it was never told.
        limitsRequired: true
    };

    /** The element's last path segment: "\\AF\DB\Site\Pump 1" -> "Pump 1". */
    function leaf(path) {
        var p = String(path || '').replace(/[\\]+$/, '');
        var i = p.lastIndexOf('\\');
        return i === -1 ? p : p.slice(i + 1);
    }

    /**
     * Each row's location from the typed list: by label, then element name,
     * then element path, all without regard to case.
     */
    function matchLocations(rows, list, assetOf) {
        var by = {};
        for (var i = 0; i < list.length; i++) { by[list[i].key.toLowerCase()] = list[i]; }
        var out = [];
        for (var r = 0; r < rows.length; r++) {
            var el = assetOf(rows[r].path) || '';
            var hit = by[String(rows[r].label).toLowerCase()] || (el && (by[leaf(el).toLowerCase()] || by[el.toLowerCase()])) || null;
            out.push(hit ? { lat: hit.lat, lon: hit.lon } : null);
        }
        return out;
    }

    symbolVis.leaf = leaf;
    symbolVis.matchLocations = matchLocations;

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;
        scope.pvx = { title: '', note: '', error: '' };

        var rows = [];
        var view = null;            // null: fit the markers; else {z, cx, cy}
        var tileImgs = {};          // url -> <img>, reused between renders
        var failedTiles = 0;
        var drag = null;
        var boundMap = null;
        var lastCfgView = '';

        // Locations read from AF: element path -> {lat, lon} | {error}
        var afLoc = { key: '', at: 0, gen: 0, byEl: {}, phase: 'off', error: '' };
        var AF_MS = 60000;

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-geo-body',
            onData: function (d) {
                rows = PVX.data.rows(d, ['Value']);
                askLocations(ctx.config || {});
            },
            onConfigChange: function (cfg) {
                var v = [cfg.InitialView, cfg.CenterLat, cfg.CenterLon, cfg.Zoom].join('|');
                if (v !== lastCfgView) { lastCfgView = v; view = null; }
                afLoc.key = '';
                askLocations(cfg);
            },
            onDestroy: function () {
                afLoc.gen += 1;
                unbindMap();
                tileImgs = {};
            },
            render: render
        });

        function trim(v) { return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, ''); }

        function isEditMode() {
            try { if (scope.runtimeData && scope.runtimeData.isEditMode) { return true; } } catch (e) { /* shape differs */ }
            try { if (scope.$root && scope.$root.isEditMode) { return true; } } catch (e2) { /* ignore */ }
            return false;
        }

        /* ================================================================ *
         * locations from AF
         * ================================================================ */

        function elements() {
            var out = [];
            for (var i = 0; i < rows.length; i++) {
                var el = PVX.nav.assetOf(rows[i].path);
                if (el && out.indexOf(el) === -1) { out.push(el); }
            }
            return out;
        }

        function askLocations(cfg) {
            if (cfg.LocationFrom === 'list') { afLoc.phase = 'off'; return; }
            var els = elements();
            var key = els.join('\n') + '\u0001' + trim(cfg.LatAttribute) + '\u0001' + trim(cfg.LonAttribute);
            var now = (new Date()).getTime();
            if (key === afLoc.key && now - afLoc.at < AF_MS) { return; }
            afLoc.key = key;
            afLoc.at = now;
            if (!els.length) { afLoc.phase = 'ok'; afLoc.byEl = {}; return; }
            if (PVX.api.discovering()) {
                afLoc.key = '';
                PVX.api.discover().then(function () { askLocations(ctx.config || {}); ctx.render(); });
                return;
            }
            if (!PVX.api.isConfigured()) {
                afLoc.phase = 'error';
                afLoc.error = PVX.api.unsetHint();
                ctx.render();
                return;
            }
            var gen = ++afLoc.gen;
            if (afLoc.phase !== 'ok') { afLoc.phase = 'loading'; }
            var latName = trim(cfg.LatAttribute) || 'Latitude', lonName = trim(cfg.LonAttribute) || 'Longitude';
            var read = function (path) {
                return PVX.af.text(path).then(function (t) { return { v: PVX.util.num(trim(t)) }; },
                    function (err) { return { err: (err && err.pvxError && err.pvxError.message) || 'could not be read' }; });
            };
            Promise.all(els.map(function (el) {
                return Promise.all([read(el + '|' + latName), read(el + '|' + lonName)]).then(function (ll) {
                    if (ll[0].err || ll[1].err) { return { el: el, error: ll[0].err || ll[1].err }; }
                    if (!PVX.geo.valid(ll[0].v, ll[1].v)) { return { el: el, error: latName + ' and ' + lonName + ' are not a place' }; }
                    return { el: el, lat: ll[0].v, lon: ll[1].v };
                });
            })).then(function (list) {
                if (gen !== afLoc.gen || ctx.destroyed) { return; }
                afLoc.byEl = {};
                for (var i = 0; i < list.length; i++) { afLoc.byEl[list[i].el] = list[i]; }
                afLoc.phase = 'ok';
                ctx.render();
            });
        }

        /** Each row's place, or null with the reason in `why`. */
        function places(cfg) {
            var out = [];
            if (cfg.LocationFrom === 'list') {
                var parsed = PVX.geo.parseLocations(cfg.Locations);
                var m = matchLocations(rows, parsed.list, PVX.nav.assetOf);
                for (var i = 0; i < rows.length; i++) { out.push(m[i] ? m[i] : { why: 'not in the location list' }); }
                out.bad = parsed.bad;
                return out;
            }
            for (var j = 0; j < rows.length; j++) {
                var el = PVX.nav.assetOf(rows[j].path);
                if (!el) { out.push({ why: 'a PI point has no AF element to hold a location' }); continue; }
                var l = afLoc.byEl[el];
                if (afLoc.phase === 'error') { out.push({ why: 'pending' }); continue; }
                if (!l) { out.push({ why: 'pending' }); continue; }
                out.push(l.error ? { why: l.error } : { lat: l.lat, lon: l.lon });
            }
            out.bad = [];
            return out;
        }

        /* ================================================================ *
         * colour
         * ================================================================ */

        function colourOf(row, cfg, t) {
            if (!row.good) { return { color: PVX.color.status.stale || t.textMuted, label: 'Bad quality' }; }
            var text = PVX.states.text(row.raw);
            if (row.value === null && text) {
                var map = PVX.states.parse(cfg.StateMap, 'map');
                for (var i = 0; i < map.length; i++) {
                    if (map[i].state.toLowerCase() === text.toLowerCase()) {
                        return { color: map[i].color || t.textMuted, label: map[i].label || map[i].state };
                    }
                }
                return { color: t.textMuted, label: text };
            }
            if (row.value !== null && cfg.UseThresholds !== false && trim(cfg.Thresholds)) {
                var band = PVX.thresholds.evaluate(cfg.Thresholds, row.value);
                if (band) { return { color: band.color, label: band.label || '' }; }
            }
            return { color: cfg.AccentColor || '#3b82c4', label: '' };
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

        function render() {
            var cfg = ctx.config || {};
            var host = ctx.host;
            if (!host) { return; }
            var t = ctx.theme;
            var root = ctx.node;
            root.style.setProperty('--pvx-surface', t.surface);
            root.style.setProperty('--pvx-text', t.text);
            root.style.setProperty('--pvx-muted', t.textMuted);
            root.style.setProperty('--pvx-border', t.border);
            scope.pvx.title = cfg.Title || '';
            scope.pvx.error = '';

            var W = Math.max(40, ctx.width || host.clientWidth || 0);
            var H = Math.max(40, ctx.height || host.clientHeight || 0);
            var site = PVX.geo.site();
            var maxZoom = site ? site.maxZoom : 18;

            var where = places(cfg);
            var marks = [], missing = [], pending = 0;
            for (var i = 0; i < rows.length; i++) {
                var w = where[i];
                if (w && w.lat !== undefined) { marks.push({ row: rows[i], lat: w.lat, lon: w.lon }); continue; }
                if (w && w.why === 'pending') { pending += 1; continue; }
                missing.push(rows[i].label + (w && w.why ? ' (' + w.why + ')' : ''));
            }

            // The view: fixed, fitted, or where the operator has panned to.
            var v = view;
            if (!v) {
                if (cfg.InitialView === 'fixed' && PVX.geo.valid(PVX.util.num(cfg.CenterLat), PVX.util.num(cfg.CenterLon))) {
                    var z0 = PVX.util.clamp(Math.round(PVX.util.num(cfg.Zoom) || 4), 1, maxZoom);
                    var c0 = PVX.geo.project(PVX.util.num(cfg.CenterLat), PVX.util.num(cfg.CenterLon), z0);
                    v = { z: z0, cx: c0.x, cy: c0.y };
                } else {
                    var fz = PVX.util.num(cfg.MaxFitZoom);
                    v = PVX.geo.fit(marks, W, H, Math.max(24, (PVX.util.num(cfg.MarkerSize) || 14) + 8),
                        Math.min(maxZoom, fz === null ? 15 : PVX.util.clamp(Math.round(fz), 1, 22)));
                }
            }
            var x0 = v.cx - W / 2, y0 = v.cy - H / 2;

            var map = PVX.util.find(host, '.pvx-geo-map');
            if (!map) {
                while (host.firstChild) { host.removeChild(host.firstChild); }
                map = el('div', 'pvx-geo-map', host);
                el('div', 'pvx-geo-tiles', map);
                var ctl = el('div', 'pvx-geo-ctl', map);
                [['in', '+', 'Zoom in'], ['out', '\u2212', 'Zoom out'], ['fit', '\u2922', 'Show every marker']].forEach(function (b) {
                    var btn = el('button', 'pvx-geo-btn', ctl);
                    btn.type = 'button';
                    btn.setAttribute('data-act', b[0]);
                    btn.textContent = b[1];
                    btn.title = b[2];
                    btn.setAttribute('aria-label', b[2]);
                });
                el('div', 'pvx-geo-attr', map);
                tileImgs = {};
            }
            bindMap(map);
            var tilesEl = PVX.util.find(map, '.pvx-geo-tiles');
            drawTiles(tilesEl, site, v, W, H, cfg);
            var attr = PVX.util.find(map, '.pvx-geo-attr');
            attr.textContent = site ? site.attribution : '';
            attr.style.display = site && site.attribution ? '' : 'none';

            // Markers and the grid, on one SVG over the tiles.
            var old = map.querySelector('svg.pvx-geo-svg');
            if (old) { map.removeChild(old); }
            var svg = PVX.svg.el('svg', { 'class': 'pvx-geo-svg', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H });
            map.insertBefore(svg, PVX.util.find(map, '.pvx-geo-ctl'));
            if (!site) { drawGrid(svg, v, W, H, t); }

            var size = PVX.util.clamp(PVX.util.num(cfg.MarkerSize) || 14, 4, 60);
            var font = 11;
            var legend = {};
            var order = [];
            var placed = [];
            var unitsOf = function (r) { return r.units ? ' ' + r.units : ''; };
            for (var m = 0; m < marks.length; m++) {
                var mk = marks[m];
                var p = PVX.geo.project(mk.lat, mk.lon, v.z);
                var sx = p.x - x0, sy = p.y - y0;
                var col = colourOf(mk.row, cfg, t);
                var valText = mk.row.value !== null ? PVX.fmt.number(mk.row.value, PVX.config.numberOpts(cfg)) + unitsOf(mk.row) : PVX.states.text(mk.row.raw);
                if (col.label && !legend[col.label]) { legend[col.label] = col.color; order.push(col.label); }
                var g = PVX.svg.el('g', { 'class': 'pvx-geo-mark', 'data-index': String(m) }, svg);
                PVX.svg.el('circle', { cx: sx.toFixed(1), cy: sy.toFixed(1), r: (size / 2).toFixed(1), fill: col.color,
                    stroke: t.surface === 'transparent' ? '#ffffff' : t.surface, 'stroke-width': 2 }, g);
                PVX.svg.el('title', null, g).textContent = mk.row.label + ': ' + valText + (col.label && col.label !== valText ? ' (' + col.label + ')' : '') +
                    '\n' + mk.lat.toFixed(5) + ', ' + mk.lon.toFixed(5);
                if (cfg.ShowLabels !== false || cfg.ShowValues) {
                    var lbl = cfg.ShowLabels !== false ? mk.row.label : '';
                    if (cfg.ShowValues) { lbl = lbl ? lbl + ': ' + valText : valText; }
                    PVX.svg.text(g, (sx + size / 2 + 4).toFixed(1), (sy + font * 0.35).toFixed(1), lbl, {
                        'class': 'pvx-svg-label pvx-geo-label', 'font-size': font, fill: t.text
                    });
                }
                placed.push({ x: sx, y: sy, mk: mk });
            }
            var offScreen = 0;
            for (var q = 0; q < placed.length; q++) {
                if (placed[q].x < 0 || placed[q].y < 0 || placed[q].x > W || placed[q].y > H) { offScreen += 1; }
            }

            if (cfg.ShowLegend !== false && order.length) { drawLegend(svg, order, legend, H, t, font); }

            // ---- footer ---------------------------------------------------
            var notes = [];
            if (!site) { notes.push('no map: name a tile server as map.tileUrl in pvx-config.js'); }
            if (failedTiles) { notes.push(failedTiles + (failedTiles === 1 ? ' map tile' : ' map tiles') + ' did not load'); }
            if (cfg.LocationFrom !== 'list' && afLoc.phase === 'error') { notes.push('locations from AF: ' + afLoc.error); }
            if (pending && afLoc.phase !== 'error') { notes.push('reading ' + pending + (pending === 1 ? ' location' : ' locations') + ' from AF'); }
            if (missing.length) { notes.push(missing.length + ' with no location: ' + missing.join(', ')); }
            if (where.bad && where.bad.length) { notes.push(where.bad.length + (where.bad.length === 1 ? ' location line does' : ' location lines do') + ' not read: ' + where.bad.join('; ')); }
            if (offScreen) { notes.push(offScreen + ' outside the view'); }
            if (!rows.length) { notes.push('add data sources: one marker each'); }
            scope.pvx.note = notes.join(' \u00b7 ');
            try { if (scope.$evalAsync) { scope.$evalAsync(function () {}); } } catch (e) { /* no Angular */ }

            current = { v: v, W: W, H: H, maxZoom: maxZoom, marks: placed };
        }

        var current = null;

        function drawTiles(container, site, v, W, H, cfg) {
            if (!site) { while (container.firstChild) { container.removeChild(container.firstChild); } tileImgs = {}; return; }
            var T = PVX.geo.TILE;
            var n = Math.pow(2, v.z);
            var x0 = v.cx - W / 2, y0 = v.cy - H / 2;
            var tx0 = Math.floor(x0 / T), tx1 = Math.floor((x0 + W) / T);
            var ty0 = Math.max(0, Math.floor(y0 / T)), ty1 = Math.min(n - 1, Math.floor((y0 + H) / T));
            var keep = {};
            var op = PVX.util.num(cfg.TileOpacity);
            container.style.opacity = op === null ? '' : String(PVX.util.clamp(op, 0, 1));
            for (var ty = ty0; ty <= ty1; ty++) {
                for (var tx = tx0; tx <= tx1; tx++) {
                    var url = PVX.geo.tileUrl(site.tileUrl, v.z, tx, ty, site.subdomains);
                    var key = url + '@' + tx;
                    var img = tileImgs[key];
                    if (!img) {
                        img = document.createElement('img');
                        img.className = 'pvx-geo-tile';
                        img.alt = '';
                        img.draggable = false;
                        img.onerror = onTileError;
                        img.src = url;
                        tileImgs[key] = img;
                    }
                    img.style.left = (tx * T - x0).toFixed(1) + 'px';
                    img.style.top = (ty * T - y0).toFixed(1) + 'px';
                    if (img.parentNode !== container) { container.appendChild(img); }
                    keep[key] = true;
                }
            }
            for (var k in tileImgs) {
                if (Object.prototype.hasOwnProperty.call(tileImgs, k) && !keep[k]) {
                    if (tileImgs[k].parentNode) { tileImgs[k].parentNode.removeChild(tileImgs[k]); }
                    delete tileImgs[k];
                }
            }
        }

        function onTileError() {
            if (this.getAttribute('data-failed')) { return; }
            this.setAttribute('data-failed', '1');
            failedTiles += 1;
            ctx.render();
        }

        /** Without tiles, a latitude and longitude grid so the markers have a frame. */
        function drawGrid(svg, v, W, H, t) {
            var tl = PVX.geo.unproject(v.cx - W / 2, v.cy - H / 2, v.z);
            var br = PVX.geo.unproject(v.cx + W / 2, v.cy + H / 2, v.z);
            var stepFor = function (span) {
                var steps = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 45, 90];
                for (var i = 0; i < steps.length; i++) { if (span / steps[i] <= 6) { return steps[i]; } }
                return 90;
            };
            var g = PVX.svg.el('g', { 'class': 'pvx-geo-grid' }, svg);
            var dLon = stepFor(br.lon - tl.lon), dLat = stepFor(tl.lat - br.lat);
            var dec = function (d) { return d >= 1 ? 0 : Math.ceil(-Math.log(d) / Math.LN10); };
            var lon, lat, p;
            for (lon = Math.ceil(tl.lon / dLon) * dLon; lon <= br.lon; lon += dLon) {
                p = PVX.geo.project(0, lon, v.z);
                var x = p.x - (v.cx - W / 2);
                PVX.svg.el('line', { x1: x.toFixed(1), y1: 0, x2: x.toFixed(1), y2: H, stroke: t.grid, 'stroke-width': 1 }, g);
                PVX.svg.text(g, (x + 3).toFixed(1), (H - 4).toFixed(1), lon.toFixed(dec(dLon)) + '\u00b0', { 'class': 'pvx-svg-label pvx-geo-gridlabel', 'font-size': 9, fill: t.textMuted });
            }
            for (lat = Math.ceil(br.lat / dLat) * dLat; lat <= tl.lat; lat += dLat) {
                p = PVX.geo.project(lat, 0, v.z);
                var y = p.y - (v.cy - H / 2);
                PVX.svg.el('line', { x1: 0, y1: y.toFixed(1), x2: W, y2: y.toFixed(1), stroke: t.grid, 'stroke-width': 1 }, g);
                PVX.svg.text(g, 3, (y - 3).toFixed(1), lat.toFixed(dec(dLat)) + '\u00b0', { 'class': 'pvx-svg-label pvx-geo-gridlabel', 'font-size': 9, fill: t.textMuted });
            }
        }

        function drawLegend(svg, order, legend, H, t, font) {
            var g = PVX.svg.el('g', { 'class': 'pvx-geo-legend' }, svg);
            var rowH = font + 6;
            var n = Math.min(order.length, Math.max(1, Math.floor((H - 40) / rowH)));
            var w = 0;
            for (var i = 0; i < n; i++) { w = Math.max(w, order[i].length * font * 0.6); }
            var y0 = H - 8 - n * rowH;
            PVX.svg.el('rect', { x: 6, y: (y0 - 4).toFixed(1), width: (w + 30).toFixed(1), height: (n * rowH + 6).toFixed(1), rx: 4,
                fill: t.surface === 'transparent' ? 'rgba(255,255,255,0.8)' : t.surface, 'fill-opacity': 0.85, stroke: t.border }, g);
            for (var j = 0; j < n; j++) {
                var y = y0 + j * rowH + rowH / 2;
                PVX.svg.el('circle', { cx: 16, cy: y.toFixed(1), r: 4.5, fill: legend[order[j]] }, g);
                PVX.svg.text(g, 26, (y + font * 0.35).toFixed(1), order[j], { 'class': 'pvx-svg-label', 'font-size': font, fill: t.text });
            }
        }

        /* ================================================================ *
         * pan, zoom and click
         * ================================================================ */

        function scale() { return ctx.fontScale || 1; }

        function local(ev, map) {
            var r = map.getBoundingClientRect();
            return { x: (ev.clientX - r.left) / scale(), y: (ev.clientY - r.top) / scale() };
        }

        function zoomAt(dz, px, py) {
            if (!current) { return; }
            var v = current.v;
            var z = PVX.util.clamp(v.z + dz, 1, current.maxZoom);
            if (z === v.z) { return; }
            var f = Math.pow(2, z - v.z);
            var mx = px === undefined ? current.W / 2 : px, my = py === undefined ? current.H / 2 : py;
            var wx = v.cx - current.W / 2 + mx, wy = v.cy - current.H / 2 + my;
            view = { z: z, cx: wx * f - mx + current.W / 2, cy: wy * f - my + current.H / 2 };
            renderNow();
        }

        function renderNow() { if (ctx.renderNow) { ctx.renderNow(); } else { ctx.render(); } }

        var handlers = null;

        function bindMap(map) {
            if (boundMap === map) { return; }
            unbindMap();
            boundMap = map;
            handlers = {
                down: function (ev) {
                    if (isEditMode() || ev.button !== 0) { return; }
                    var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
                    if (b) { return; }
                    var at = local(ev, map);
                    drag = { x: at.x, y: at.y, moved: false, start: current ? { z: current.v.z, cx: current.v.cx, cy: current.v.cy } : null, target: ev.target };
                    document.addEventListener('pointermove', handlers.move, false);
                    document.addEventListener('pointerup', handlers.up, false);
                },
                move: function (ev) {
                    if (!drag || !drag.start) { return; }
                    var at = local(ev, map);
                    var dx = at.x - drag.x, dy = at.y - drag.y;
                    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) { return; }
                    drag.moved = true;
                    view = { z: drag.start.z, cx: drag.start.cx - dx, cy: drag.start.cy - dy };
                    renderNow();
                },
                up: function () {
                    document.removeEventListener('pointermove', handlers.move, false);
                    document.removeEventListener('pointerup', handlers.up, false);
                    var d = drag;
                    drag = null;
                    if (d && !d.moved) { clickAt(d.target); }
                },
                wheel: function (ev) {
                    if (isEditMode()) { return; }
                    ev.preventDefault();
                    var at = local(ev, map);
                    zoomAt(ev.deltaY < 0 ? 1 : -1, at.x, at.y);
                },
                click: function (ev) {
                    var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
                    if (!b) { return; }
                    var act = b.getAttribute('data-act');
                    if (act === 'in') { zoomAt(1); } else if (act === 'out') { zoomAt(-1); } else if (act === 'fit') { view = null; renderNow(); }
                }
            };
            map.addEventListener('pointerdown', handlers.down, false);
            map.addEventListener('wheel', handlers.wheel, { passive: false });
            map.addEventListener('click', handlers.click, false);
        }

        function unbindMap() {
            if (!boundMap || !handlers) { return; }
            boundMap.removeEventListener('pointerdown', handlers.down, false);
            boundMap.removeEventListener('wheel', handlers.wheel, { passive: false });
            boundMap.removeEventListener('click', handlers.click, false);
            document.removeEventListener('pointermove', handlers.move, false);
            document.removeEventListener('pointerup', handlers.up, false);
            boundMap = null;
        }

        function clickAt(target) {
            var cfg = ctx.config || {};
            if (cfg.ClickAction === 'none' || !cfg.ClickAction || isEditMode() || !current) { return; }
            var g = target && target.closest ? target.closest('.pvx-geo-mark') : null;
            if (!g) { return; }
            var p = current.marks[parseInt(g.getAttribute('data-index'), 10)];
            if (!p) { return; }
            var asset = PVX.nav.assetOf(p.mk.row.path);
            if (!asset) { return; }
            var opts = { asset: asset };
            if (cfg.ClickAction === 'display' && trim(cfg.ClickDisplay)) { opts.display = trim(cfg.ClickDisplay); }
            PVX.nav.go(PVX.nav.url(opts), false);
        }

        return ctx;
    };

    window.PVX.register(PV, definition);
}(window.PIVisualization));
