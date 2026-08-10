/* ============================================================================
 * pvxSitePlan — background drawing (site plan, P&ID, photo, single line) with
 * data-bound hotspots
 * ----------------------------------------------------------------------------
 * DataShape: Table (multiple data sources)
 *
 * WHY THIS EXISTS INSTEAD OF A MAP SYMBOL
 * ---------------------------------------
 * The obvious "put my tags on a map" symbol needs a tile provider, and most
 * plant networks cannot reach one — the display renders as a grey grid with
 * markers floating on nothing. For a single site a scaled plant drawing is also
 * simply more useful than a satellite view: an operator navigates by "the north
 * cooling tower", not by latitude. So the background here is any image the site
 * already owns, served from the PI Vision web server, and it works air-gapped.
 *
 * COORDINATE SYSTEM — the one thing that is easy to get wrong
 * -----------------------------------------------------------
 * Hotspots are stored as PERCENTAGES OF THE IMAGE, not pixels of the symbol.
 *   * Pixels would break the moment anybody resized the display.
 *   * Percentages of the *frame* would break as soon as the aspect ratio
 *     changed, because with ImageFit 'contain' the image is letterboxed inside
 *     the frame and only occupies part of it.
 * Every marker position is therefore derived from `fittedRect()` — the actual
 * rectangle the image occupies — never from the frame. Render the same config
 * at 620x340 and 340x620: the markers stay on the same features.
 *
 * MARKERS KEEP A CONSTANT SCREEN SIZE
 * -----------------------------------
 * The SVG user space is 1:1 with CSS pixels (viewBox = 0 0 W H,
 * preserveAspectRatio="none" is not used for scaling content — the image is
 * placed explicitly). Marker radii, label chips and stroke widths are computed
 * in screen pixels, so a marker is the same physical size on a 140px tile and
 * on a 900px wall display. Scaling markers with the image would turn them into
 * dots on one and blobs on the other.
 *
 * NO-IMAGE STATE
 * --------------
 * This is what an engineer sees the moment the symbol is dropped on a display,
 * and it is also the fallback when the image URL 404s. It draws a labelled
 * percentage grid with every hotspot already positioned on it, so the layout
 * can be configured (and read back off the ruler) before anyone uploads a
 * drawing. A blank rectangle would make the symbol look broken.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxSitePlan',
        displayName: 'PVX Site Plan',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        // A collection would repeat the whole drawing once per asset. The point
        // of this symbol is that ONE drawing carries many assets at once.
        supportsCollections: false,
        configTitle: 'Format Site Plan',

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                // Positional contract with PI Vision's Summary cells; kept in
                // step with Statistic by PVX.config.syncStatColumns().
                Columns: ['Value'],
                SortColumn: 'Value',
                Statistic: 'Value',        // Value|Average|Minimum|Maximum|Range|StdDev|Total
                Height: 320,
                Width: 520,

                Title: '',                 // blank => no header

                // --- background image ---------------------------------
                ImageUrl: '',
                ImageFit: 'contain',       // contain | cover | stretch
                ImageOpacity: 1,
                ImageGrayscale: false,

                // --- hotspots -----------------------------------------
                // "x,y" or "x,y:Label", percent of the image, ' | ' between
                // entries. Positionally matched to the data sources.
                Hotspots: '',

                // --- markers ------------------------------------------
                MarkerShape: 'circle',     // circle | square | pin | diamond
                MarkerSize: 18,
                MarkerBorder: 2,

                // --- labels -------------------------------------------
                ShowValues: true,
                ShowNames: false,
                LabelPosition: 'below',    // below | above | right | inside | none
                LabelBackground: true,

                // --- colour -------------------------------------------
                ColorMode: 'threshold',    // threshold | state | single
                StateMap: 'Running:#2f9e5f, Stopped:#8a8f96, Fault:#c8452f, Alarm:#c8452f',
                SingleColor: '#3b82c4',

                // --- emphasis -----------------------------------------
                PulseOnAlarm: true,
                ShowLeaderLine: false,
                ShowLegend: false,

                // --- interaction --------------------------------------
                ClickAction: 'none',       // none | navigate
                NavigateTarget: ''
            });
        }
    };

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Only the chrome is Angular-bound; the plan itself is SVG.
        scope.pvx = {
            title: '', subtitle: '', note: '', count: '', error: '',
            background: '', showHeader: false, showFooter: false
        };

        var rows = [];
        // Items in draw order. The delegated click handler maps a marker's
        // data-pvx-i back through this array, so it must stay in sync.
        var placed = [];
        var boundHost = null;
        var liveCfg = {};

        /* ------------------------------------------------------------------ *
         * Background image state
         * ------------------------------------------------------------------ *
         * The image is preloaded through a detached Image() rather than being
         * dropped straight into the SVG for two reasons:
         *   1. We need naturalWidth/naturalHeight to letterbox it correctly,
         *      and those are only known after load.
         *   2. A failed load has to be *detected*, not just look broken. An
         *      <image> that 404s leaves an empty symbol with no explanation;
         *      the error event lets us fall back to the placeholder grid and
         *      say so in the footer.
         */
        var img = { url: null, state: 'none', w: 0, h: 0, loader: null };

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-sp-body',

            onData: function (d) {
                // Parse against the column we actually asked for — see the
                // shared statistic helpers.
                rows = PVX.data.rows(d, PVX.config.statColumns(scope.config || {})) || [];
            },

            onConfigChange: function (newCfg) {
                // The statistic decides which aggregate PI Vision computes, so
                // the request must be updated before the next fetch.
                PVX.config.syncStatColumns(newCfg || scope.config);
            },

            render: render,

            onDestroy: function () {
                unbindHost();
                cancelLoad();
                placed = [];
            }
        });

        /* ================================================================== *
         * Image loading
         * ================================================================== */

        function cancelLoad() {
            if (img.loader) {
                img.loader.onload = null;
                img.loader.onerror = null;
                img.loader = null;
            }
        }

        /** Start (or keep) a load for `url`. Idempotent per URL. */
        function ensureImage(url) {
            var u = String(url === null || url === undefined ? '' : url).trim();
            if (img.url === u) { return; }
            cancelLoad();
            img.url = u;
            img.w = 0;
            img.h = 0;
            if (!u) { img.state = 'none'; return; }
            img.state = 'loading';

            var loader = new Image();
            img.loader = loader;
            loader.onload = function () {
                // A config change may have superseded this load while it was in
                // flight; the stale result must not overwrite the new one.
                if (img.loader !== loader) { return; }
                img.state = 'ok';
                img.w = loader.naturalWidth || loader.width || 0;
                img.h = loader.naturalHeight || loader.height || 0;
                ctx.render();
            };
            loader.onerror = function () {
                if (img.loader !== loader) { return; }
                img.state = 'error';
                ctx.render();
            };
            try { loader.src = u; } catch (e) { img.state = 'error'; }
        }

        /**
         * The rectangle the image actually occupies inside the WxH frame.
         * Hotspot percentages are resolved against THIS, never against the
         * frame — that is what keeps markers on the same features when the
         * symbol's aspect ratio changes.
         */
        function fittedRect(W, H, cfg) {
            var usable = img.state === 'ok' && img.w > 0 && img.h > 0;
            if (!usable) {
                // Placeholder mode: the "image" is the frame itself, so the
                // ruler percentages the engineer reads off are the ones they
                // type into the config.
                return { x: 0, y: 0, w: W, h: H, placeholder: true };
            }
            var fit = cfg.ImageFit || 'contain';
            if (fit === 'stretch') { return { x: 0, y: 0, w: W, h: H, placeholder: false }; }
            var s = fit === 'cover'
                ? Math.max(W / img.w, H / img.h)
                : Math.min(W / img.w, H / img.h);
            var w = img.w * s, h = img.h * s;
            return { x: (W - w) / 2, y: (H - h) / 2, w: w, h: h, placeholder: false };
        }

        /* ================================================================== *
         * Hotspot grammar
         * ================================================================== *
         *   "12,44 | 61,20:Pump A | 80,72"
         *
         * ' | ' separates hotspots and ',' separates the coordinate pair. The
         * outer separator is deliberately NOT a comma: every other list in this
         * library (thresholds, state maps) is comma separated, and a coordinate
         * pair is itself comma separated, so reusing the comma at both levels
         * would make the grammar ambiguous to read and to type.
         *
         * An EMPTY entry is meaningful: it leaves that data source unplaced, so
         * "12,44 |  | 80,72" pins sources 1 and 3 and auto-places source 2.
         */
        function parseHotspots(spec, notes) {
            var list = [];
            var raw = String(spec === null || spec === undefined ? '' : spec);
            if (!raw.replace(/\s+/g, '')) { return list; }

            var parts = raw.split('|');
            for (var i = 0; i < parts.length; i++) {
                var s = parts[i].trim();
                if (!s) { list.push(null); continue; }

                // First ':' splits coordinate from label, so labels may contain
                // colons ("Pump A: discharge").
                var colon = s.indexOf(':');
                var coord = colon === -1 ? s : s.slice(0, colon);
                var label = colon === -1 ? '' : s.slice(colon + 1).trim();

                var xy = coord.split(',');
                var x = PVX.util.num(xy[0]);
                var y = xy.length > 1 ? PVX.util.num(xy[1]) : null;
                if (x === null || y === null) {
                    notes.malformed += 1;
                    list.push(null);           // keep the positional slot
                    continue;
                }
                var cx = PVX.util.clamp(x, 0, 100);
                var cy = PVX.util.clamp(y, 0, 100);
                // Out-of-range percentages are clamped rather than dropped: a
                // marker pinned to the edge is debuggable, a missing one is not.
                if (cx !== x || cy !== y) { notes.clamped += 1; }
                list.push({ x: cx, y: cy, label: label });
            }
            return list;
        }

        /* ================================================================== *
         * Colour / severity
         * ================================================================== */

        var stateMapCache = { spec: null, map: null };

        /** Same "key:colour[:label]" grammar as pvxStatusGrid's state map. */
        function parseStateMap(spec) {
            if (stateMapCache.spec === spec && stateMapCache.map) { return stateMapCache.map; }
            var map = {};
            String(spec === null || spec === undefined ? '' : spec)
                .split(/[,\n;]/)
                .forEach(function (chunk) {
                    var s = chunk.trim();
                    if (!s) { return; }
                    var p = s.split(':');
                    var key = (p[0] || '').trim();
                    if (!key) { return; }
                    map[key.toLowerCase()] = {
                        color: (p[1] || '').trim() || PVX.color.status.info,
                        label: (p.slice(2).join(':') || '').trim() || key
                    };
                });
            stateMapCache.spec = spec;
            stateMapCache.map = map;
            return map;
        }

        function rawText(row) {
            var r = row.raw;
            if (r === null || r === undefined) { return ''; }
            return String(r).trim();
        }

        /**
         * Colour + severity for one row.
         * Bad quality wins over every colour mode: a stale tag's last value is
         * often still inside a "normal" band, and painting it green is worse
         * than saying nothing.
         */
        function resolveStatus(row, cfg, value) {
            var out = {
                color: cfg.SingleColor || '#3b82c4',
                label: '',
                bad: false,
                severity: -1,
                topBand: false
            };

            if (!row.good) {
                out.bad = true;
                out.color = PVX.color.status.stale;
                out.label = row.errorDescription || 'Bad quality';
                return out;
            }

            var mode = cfg.ColorMode || 'threshold';

            if (mode === 'state') {
                var hit = parseStateMap(cfg.StateMap)[rawText(row).toLowerCase()];
                if (hit) {
                    out.color = hit.color;
                    out.label = hit.label;
                    return out;
                }
                // Fall through to thresholds: a numeric tag mixed into a digital
                // plan should still get a band colour rather than flat accent.
            }

            if (mode === 'threshold' || mode === 'state') {
                if (cfg.UseThresholds) {
                    var list = PVX.thresholds.parse(cfg.Thresholds);
                    if (value !== null && list.length) {
                        for (var i = 0; i < list.length; i++) {
                            if (value >= list[i].value) { out.severity = i; } else { break; }
                        }
                        if (out.severity >= 0) {
                            out.color = list[out.severity].color;
                            out.label = list[out.severity].label || '';
                            out.topBand = out.severity === list.length - 1;
                        }
                    }
                }
            }
            return out;
        }

        /* ================================================================== *
         * Text helpers
         * ================================================================== */

        /**
         * Approximate rendered width. Measuring every label with
         * getComputedTextLength() would force one layout per marker per frame;
         * 0.58em is the average advance of Segoe UI/Roboto at these sizes and
         * label chips are centre-anchored, so a few px of error only shifts a
         * chip rather than pushing text off canvas.
         */
        function textPx(s, font) {
            return String(s === null || s === undefined ? '' : s).length * font * 0.58;
        }

        function truncate(s, maxPx, font) {
            var str = String(s === null || s === undefined ? '' : s);
            var per = font * 0.58;
            var max = Math.floor(maxPx / per);
            if (max < 1) { return ''; }
            if (str.length <= max) { return str; }
            if (max === 1) { return '…'; }
            return str.slice(0, max - 1) + '…';
        }

        /* ================================================================== *
         * Placement
         * ================================================================== */

        /**
         * Cell centres of a cols x rowsN grid over `rect`, dropping any cell a
         * configured hotspot already sits in. `pts` are those hotspots in
         * pixels — they are resolved against the IMAGE rect, which is not
         * necessarily the rect being tiled here.
         */
        function gridCells(rect, cols, rowsN, pts) {
            var cw = rect.w / cols;
            var ch = rect.h / rowsN;
            var out = [];
            for (var r = 0; r < rowsN; r++) {
                for (var c = 0; c < cols; c++) {
                    var p = { x: rect.x + (c + 0.5) * cw, y: rect.y + (r + 0.5) * ch };
                    var clash = false;
                    for (var k = 0; pts && k < pts.length; k++) {
                        if (Math.abs(pts[k].x - p.x) < cw * 0.55 &&
                            Math.abs(pts[k].y - p.y) < ch * 0.55) {
                            clash = true;
                            break;
                        }
                    }
                    if (!clash) { out.push(p); }
                }
            }
            return out;
        }

        /** Squared distance from p to the nearest point in either list. */
        function nearestSq(p, a, b) {
            var best = 1e18, i, d, q;
            for (i = 0; i < a.length; i++) {
                q = a[i];
                d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
                if (d < best) { best = d; }
            }
            for (i = 0; i < b.length; i++) {
                q = b[i];
                d = (q.x - p.x) * (q.x - p.x) + (q.y - p.y) * (q.y - p.y);
                if (d < best) { best = d; }
            }
            return best;
        }

        /**
         * Farthest-point sampling: repeatedly take the cell furthest from every
         * configured hotspot and everything already chosen.
         *
         * Taking the first N cells row-major instead would line every
         * auto-placed marker up along the top edge of the drawing — exactly
         * where the title block and the busiest plant usually are.
         */
        function pickSpread(cells, need, avoid) {
            var chosen = [];
            var pool = cells.slice();
            while (chosen.length < need && pool.length) {
                var bestI = 0, bestD = -1;
                for (var i = 0; i < pool.length; i++) {
                    var d = nearestSq(pool[i], avoid, chosen);
                    if (d > bestD) { bestD = d; bestI = i; }
                }
                chosen.push(pool[bestI]);
                pool.splice(bestI, 1);
            }
            // Reading order, so the Nth data source lands in a predictable place
            // rather than wherever the sampling happened to start.
            chosen.sort(function (p, q) { return (p.y - q.y) || (p.x - q.x); });
            return chosen;
        }

        /**
         * Positions for sources with no hotspot entry.
         *
         * Nothing may be silently invisible: a source the engineer forgot to
         * position still has to appear somewhere sensible and be named in the
         * footer, otherwise a missing marker looks identical to a missing tag.
         */
        function autoGrid(rect, pts, step, need) {
            // Cell pitch is bounded below by what a marker plus a chip needs, so
            // the grid never packs items on top of each other. The upper bound
            // on the track count keeps pickSpread's O(need x cells) search cheap.
            var maxCols = PVX.util.clamp(Math.floor(rect.w / step.x), 1, 14);
            var maxRows = PVX.util.clamp(Math.floor(rect.h / step.y), 1, 14);

            // Shape the grid to the number of items rather than filling the
            // frame: a sparse grid keeps auto-placed markers legible.
            var aspect = rect.w / Math.max(1, rect.h);
            var cols = Math.max(1, Math.min(maxCols, Math.ceil(Math.sqrt(Math.max(1, need) * aspect))));
            var rowsN = Math.max(1, Math.min(maxRows, Math.ceil(need / cols)));

            var free = gridCells(rect, cols, rowsN, pts);
            if (free.length < need && (cols < maxCols || rowsN < maxRows)) {
                // Not enough unused cells at the preferred density — go to the
                // finest grid that still fits a marker per cell, then spread the
                // picks over it.
                free = pickSpread(gridCells(rect, maxCols, maxRows, pts), need, pts);
            }
            // If every cell clashes there is no unused area left; overlapping is
            // still better than dropping the marker entirely.
            return free.length ? free : gridCells(rect, cols, rowsN, null);
        }

        /**
         * rows + config -> the exact list of markers to draw, plus footnotes.
         * `rect` is the image rectangle every hotspot percentage resolves
         * against; `autoRect` is where unplaced sources may be dropped (the
         * same thing, minus any band the placeholder ruler and caption own).
         */
        function buildModel(cfg, rect, autoRect, geom, W, H) {
            var notes = {
                malformed: 0, clamped: 0, extra: 0,
                auto: 0, offFrame: 0, bad: 0, noValue: 0
            };
            var spots = parseHotspots(cfg.Hotspots, notes);
            if (spots.length > rows.length) { notes.extra = spots.length - rows.length; }

            var configured = [];
            var i;
            for (i = 0; i < rows.length && i < spots.length; i++) {
                if (spots[i]) { configured.push(spots[i]); }
            }

            function hotspotPoints(r, list) {
                var out = [];
                for (var j = 0; j < list.length; j++) {
                    out.push({
                        x: r.x + r.w * list[j].x / 100,
                        y: r.y + r.h * list[j].y / 100
                    });
                }
                return out;
            }

            var autoCells = null;
            var autoIdx = 0;
            var items = [];
            var autoNames = [];

            // How many will need auto-placing — the grid is shaped around that
            // count, so it has to be known before the first cell is handed out.
            var needAuto = 0;
            for (i = 0; i < rows.length; i++) {
                if (!(i < spots.length && spots[i])) { needAuto += 1; }
            }

            for (i = 0; i < rows.length; i++) {
                var row = rows[i];
                var hs = i < spots.length ? spots[i] : null;
                var px, py, auto;

                if (hs) {
                    px = rect.x + rect.w * hs.x / 100;
                    py = rect.y + rect.h * hs.y / 100;
                    auto = false;
                } else {
                    if (!autoCells) {
                        autoCells = autoGrid(autoRect, hotspotPoints(rect, configured),
                            geom.cell, needAuto);
                    }
                    var cell = autoCells[autoIdx % autoCells.length];
                    autoIdx += 1;
                    px = cell.x;
                    py = cell.y;
                    auto = true;
                    notes.auto += 1;
                    autoNames.push(row.label || ('Row ' + (i + 1)));
                }

                // With ImageFit 'cover' the image overflows the frame, so a
                // legitimately positioned hotspot can be cropped out of view.
                // Count those instead of pretending everything is visible.
                if (px < -1 || py < -1 || px > W + 1 || py > H + 1) { notes.offFrame += 1; }

                var value = PVX.data.statValue(row, cfg);
                if (value === null) { notes.noValue += 1; }
                var st = resolveStatus(row, cfg, value);
                if (st.bad) { notes.bad += 1; }

                items.push({
                    row: row,
                    index: i,
                    x: px,
                    y: py,
                    auto: auto,
                    value: value,
                    status: st,
                    // An explicitly typed hotspot label is always honoured: the
                    // engineer wrote it on purpose. ShowNames only governs
                    // whether the *data source* name is used as a fallback.
                    name: (hs && hs.label) ? hs.label : (row.label || ''),
                    explicit: !!(hs && hs.label)
                });
            }

            return { items: items, notes: notes, autoNames: autoNames };
        }

        /* ================================================================== *
         * Render
         * ================================================================== */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;
            if (!host) { return; }

            // Self-heal a config saved by an older build or edited by hand.
            // Only writes when something differs, so it cannot loop with PI
            // Vision's own change detection.
            PVX.config.syncStatColumns(cfg);

            liveCfg = cfg;
            applyThemeVars(c, t);
            ensureImage(cfg.ImageUrl);

            var W = Math.max(24, Math.round(c.width));
            var H = Math.max(20, Math.round(c.height));

            // Chrome visibility is decided from the SYMBOL box, not the body
            // box: deciding it from the body would change the body height and
            // could oscillate between two layouts on consecutive frames.
            var nodeH = (c.node && c.node.clientHeight) || H;
            var nodeW = (c.node && c.node.clientWidth) || W;

            var svgRoot = host.querySelector('svg.pvx-sp-svg');
            if (!svgRoot) {
                svgRoot = PVX.svg.el('svg', { 'class': 'pvx-canvas pvx-sp-svg' }, host);
            }
            svgRoot.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
            // 1 user unit == 1 CSS pixel, which is what lets marker geometry be
            // expressed in screen pixels.
            svgRoot.setAttribute('preserveAspectRatio', 'none');
            PVX.svg.clear(svgRoot);
            bindHost(svgRoot);

            /* --- responsive tiers ------------------------------------------
             * Below ~200x140 there is no room for a legible chip next to a
             * marker, so labels go and markers shrink. Below ~140x100 the plan
             * is a thumbnail: markers only, and no ruler labels either. */
            var tiny = W < 140 || H < 100;
            var small = tiny || W < 200 || H < 140;

            var baseSize = PVX.util.clamp(PVX.util.num(cfg.MarkerSize) === null ? 18 : PVX.util.num(cfg.MarkerSize), 5, 72);
            var size = baseSize * (tiny ? 0.5 : (small ? 0.72 : 1));
            size = PVX.util.clamp(size, 5, Math.max(6, Math.min(W, H) * 0.4));
            var border = PVX.util.clamp(PVX.util.num(cfg.MarkerBorder) === null ? 2 : PVX.util.num(cfg.MarkerBorder), 0, 8);

            var font = PVX.util.clamp(Math.round(Math.min(W, H) / 26), 8, 12);
            var labelsOn = !small && (cfg.LabelPosition || 'below') !== 'none' &&
                (cfg.ShowValues || cfg.ShowNames || String(cfg.Hotspots || '').indexOf(':') !== -1);

            var geom = {
                size: size,
                border: border,
                font: font,
                // Auto-placement grid pitch: wide enough for a marker plus a
                // short chip so auto-placed items do not pile on each other.
                cell: {
                    x: Math.max(size * 2.2, labelsOn ? 76 : size * 2.2),
                    y: Math.max(size * 2.0, labelsOn ? 46 : size * 2.0)
                }
            };

            var rect = fittedRect(W, H, cfg);

            // Auto-placed markers must not land on the placeholder's ruler
            // numerals or its caption. Configured hotspots still use the full
            // rect: their percentages have to mean exactly what the ruler says.
            var autoRect = rect;
            if (rect.placeholder && !tiny) {
                var topIn = font * 1.7;
                var botIn = H >= 120 ? font * 2.6 : 4;
                autoRect = {
                    x: rect.x + 2,
                    y: rect.y + topIn,
                    w: Math.max(20, rect.w - 4),
                    h: Math.max(20, rect.h - topIn - botIn)
                };
            }

            var model = buildModel(cfg, rect, autoRect, geom, W, H);
            placed = model.items;

            // ---- background ------------------------------------------------
            if (rect.placeholder) {
                drawPlaceholder(svgRoot, W, H, t, tiny, font);
            } else {
                drawImage(svgRoot, W, H, rect, cfg);
            }

            // ---- markers + labels -------------------------------------------
            drawMarkers(svgRoot, W, H, cfg, t, model, geom, labelsOn);

            if (cfg.ShowLegend && !small) { drawLegend(svgRoot, W, H, cfg, t, font); }

            // ---- chrome ------------------------------------------------------
            scope.pvx.background = cfg.Transparent ? 'transparent' : t.surface;
            scope.pvx.title = cfg.Title || 'Site plan';
            scope.pvx.subtitle = PVX.config.statLabel(cfg) + commonUnitsSuffix(cfg, model);
            scope.pvx.note = footerNote(cfg, model).join(' · ');
            scope.pvx.count = rows.length
                ? (rows.length + (rows.length === 1 ? ' source' : ' sources'))
                : '';
            scope.pvx.error = model.notes.bad
                ? (model.notes.bad + (model.notes.bad === 1 ? ' source reports' : ' sources report') + ' bad quality')
                : '';
            scope.pvx.showHeader = !!cfg.ShowLabel && nodeH >= 96 && nodeW >= 130;
            scope.pvx.showFooter = nodeH >= 110 && nodeW >= 130 &&
                !!(scope.pvx.note || scope.pvx.count);

            digest();
        }

        /** Units are only meaningful in the header when every row agrees. */
        function commonUnitsSuffix(cfg, model) {
            if (!cfg.ShowUnits) { return ''; }
            var u = null;
            for (var i = 0; i < model.items.length; i++) {
                var iu = model.items[i].row.units || '';
                if (u === null) { u = iu; } else if (u !== iu) { return ''; }
            }
            return u ? ' · ' + u : '';
        }

        /** Everything the operator needs to know that the drawing cannot show. */
        function footerNote(cfg, model) {
            var n = model.notes;
            var out = [];

            if (img.state === 'error') {
                out.push('Image failed to load — showing placeholder grid');
            } else if (img.state === 'loading') {
                out.push('Loading image…');
            } else if (img.state === 'none' && rows.length) {
                out.push('No background image — grid shows % coordinates');
            }

            if (!rows.length) { out.push('Drop attributes onto this symbol'); }

            if (n.auto) {
                var names = model.autoNames.slice(0, 3).join(', ');
                out.push(n.auto + (n.auto === 1 ? ' source' : ' sources') +
                    ' not positioned, auto-placed' +
                    (names ? ' (' + names + (model.autoNames.length > 3 ? ', …' : '') + ')' : ''));
            }
            if (n.malformed) {
                out.push(n.malformed + ' hotspot' + (n.malformed === 1 ? '' : 's') + ' malformed');
            }
            if (n.clamped) {
                out.push(n.clamped + ' coordinate' + (n.clamped === 1 ? '' : 's') + ' out of range, clamped');
            }
            if (n.extra) {
                out.push(n.extra + ' extra hotspot' + (n.extra === 1 ? '' : 's') + ' with no data source');
            }
            if (n.offFrame) {
                out.push(n.offFrame + ' marker' + (n.offFrame === 1 ? '' : 's') + ' cropped by the image fit');
            }
            if (n.noValue) {
                out.push(n.noValue + ' with no ' + PVX.config.statLabel(cfg).toLowerCase());
            }
            return out;
        }

        /* ------------------------------------------------------------------ *
         * Background: real image
         * ------------------------------------------------------------------ */
        function drawImage(svgRoot, W, H, rect, cfg) {
            var g = PVX.svg.el('g', { 'class': 'pvx-sp-bg' }, svgRoot);

            // 'cover' deliberately overflows the frame, so it must be clipped —
            // an un-clipped <image> paints over the header and footer.
            var clipId = null;
            if (rect.x < 0 || rect.y < 0 || rect.w > W || rect.h > H) {
                clipId = PVX.util.uid('pvxspclip');
                var defs = PVX.svg.el('defs', null, g);
                var cp = PVX.svg.el('clipPath', { id: clipId }, defs);
                PVX.svg.el('rect', { x: 0, y: 0, width: W, height: H }, cp);
                g.setAttribute('clip-path', 'url(#' + clipId + ')');
            }

            var op = PVX.util.num(cfg.ImageOpacity);
            op = op === null ? 1 : PVX.util.clamp(op, 0, 1);

            var el = PVX.svg.el('image', {
                x: rect.x.toFixed(2), y: rect.y.toFixed(2),
                width: Math.max(0, rect.w).toFixed(2),
                height: Math.max(0, rect.h).toFixed(2),
                // The rect already encodes the fit, so the image must fill it
                // exactly rather than doing its own letterboxing on top.
                preserveAspectRatio: 'none',
                opacity: op
            }, g);
            // href for modern browsers, xlink:href for the older engines PI
            // Vision still supports.
            el.setAttribute('href', img.url);
            try { el.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', img.url); } catch (e) { /* ignore */ }
            if (cfg.ImageGrayscale) {
                // Desaturating a busy drawing is what makes coloured markers
                // pop off it; it is a display choice, not a data change.
                el.setAttribute('style', 'filter:grayscale(100%);-webkit-filter:grayscale(100%)');
            }
        }

        /* ------------------------------------------------------------------ *
         * Background: labelled placeholder grid
         * ------------------------------------------------------------------ *
         * Doubles as the configuration aid and the load-failure fallback. The
         * ruler is in percent because that is exactly what the Hotspots field
         * takes, so an engineer can read a position off the screen and type it.
         */
        function drawPlaceholder(svgRoot, W, H, t, tiny, font) {
            var g = PVX.svg.el('g', { 'class': 'pvx-sp-placeholder' }, svgRoot);

            PVX.svg.el('rect', {
                x: 0.5, y: 0.5, width: Math.max(0, W - 1), height: Math.max(0, H - 1),
                fill: t.surfaceAlt, stroke: t.border,
                'stroke-width': 1, 'stroke-dasharray': '5 4'
            }, g);

            var i, p;
            var minor = PVX.svg.el('g', {
                'class': 'pvx-grid-line', stroke: t.grid, 'stroke-width': 1, fill: 'none'
            }, g);
            var major = PVX.svg.el('g', {
                'class': 'pvx-grid-line', stroke: t.axis, 'stroke-width': 1,
                'stroke-opacity': 0.55, fill: 'none'
            }, g);

            // 10% minor, 25% major. Denser than that is noise at symbol sizes.
            for (i = 10; i < 100; i += 10) {
                p = (i % 25 === 0) ? major : minor;
                var gx = (W * i / 100);
                var gy = (H * i / 100);
                PVX.svg.el('line', { x1: gx.toFixed(1), y1: 0, x2: gx.toFixed(1), y2: H }, p);
                PVX.svg.el('line', { x1: 0, y1: gy.toFixed(1), x2: W, y2: gy.toFixed(1) }, p);
            }

            if (tiny) { return; }

            // Ruler numbers along the top and left edges.
            var rf = Math.max(7, font - 1);
            var marks = [25, 50, 75];
            for (i = 0; i < marks.length; i++) {
                var m = marks[i];
                PVX.svg.text(g, (W * m / 100).toFixed(1), rf * 0.9, String(m), {
                    'class': 'pvx-svg-label pvx-sp-ruler', 'text-anchor': 'middle',
                    'font-size': rf, fill: t.textMuted
                });
                PVX.svg.text(g, 3, (H * m / 100).toFixed(1), String(m), {
                    'class': 'pvx-svg-label pvx-sp-ruler', 'text-anchor': 'start',
                    'font-size': rf, fill: t.textMuted
                });
            }
            // Corner origin marker so "0,0 is top-left" needs no explanation.
            PVX.svg.text(g, 3, rf * 0.9, '0,0 %', {
                'class': 'pvx-svg-label pvx-sp-ruler', 'text-anchor': 'start',
                'font-size': rf, fill: t.textMuted
            });

            if (H < 120) { return; }

            var caption = img.state === 'error'
                ? 'Image did not load: ' + shortUrl(img.url, Math.floor(W / (font * 0.58)) - 22)
                : 'No background image — x,y are % of this frame';
            var cap = PVX.svg.text(g, W / 2, H - font * 1.1,
                truncate(caption, W - 16, font), {
                    'class': 'pvx-svg-label pvx-sp-caption', 'text-anchor': 'middle',
                    'font-size': font, fill: t.textMuted
                });
            cap.setAttribute('opacity', '0.9');
        }

        /** Keep the tail of a URL — the filename is the part that identifies it. */
        function shortUrl(u, maxChars) {
            var s = String(u || '');
            var max = Math.max(8, maxChars || 28);
            return s.length <= max ? s : '…' + s.slice(s.length - (max - 1));
        }

        /* ------------------------------------------------------------------ *
         * Markers
         * ------------------------------------------------------------------ */

        /**
         * Vertical extent of a marker above/below its anchor, in screen px.
         * A pin points AT its coordinate, so its body sits entirely above the
         * anchor; every other shape is centred on it.
         */
        function markerExtent(shape, size) {
            if (shape === 'pin') { return { up: size, down: 2 }; }
            return { up: size / 2, down: size / 2 };
        }

        function drawMarkerShape(parent, shape, cx, cy, size, fill, stroke, strokeW) {
            var s = size, h = size / 2, el;
            var attrs = {
                fill: fill,
                stroke: strokeW > 0 ? stroke : 'none',
                'stroke-width': strokeW > 0 ? strokeW : null,
                'stroke-linejoin': 'round'
            };

            if (shape === 'square') {
                attrs.x = (cx - h).toFixed(2);
                attrs.y = (cy - h).toFixed(2);
                attrs.width = s.toFixed(2);
                attrs.height = s.toFixed(2);
                attrs.rx = Math.max(1, s * 0.14).toFixed(2);
                el = PVX.svg.el('rect', attrs, parent);
            } else if (shape === 'diamond') {
                attrs.points = [
                    cx.toFixed(2) + ',' + (cy - h).toFixed(2),
                    (cx + h).toFixed(2) + ',' + cy.toFixed(2),
                    cx.toFixed(2) + ',' + (cy + h).toFixed(2),
                    (cx - h).toFixed(2) + ',' + cy.toFixed(2)
                ].join(' ');
                el = PVX.svg.el('polygon', attrs, parent);
            } else if (shape === 'pin') {
                // Teardrop whose tip is exactly on the anchor. r is chosen so the
                // total height is ~= size, keeping every shape visually equal.
                var r = s * 0.42;
                var by = cy - r * 1.5;
                attrs.d = 'M' + cx.toFixed(2) + ' ' + cy.toFixed(2) +
                    ' C' + (cx - r * 1.15).toFixed(2) + ' ' + (cy - r * 1.0).toFixed(2) +
                    ',' + (cx - r * 1.1).toFixed(2) + ' ' + (by - r * 0.75).toFixed(2) +
                    ',' + cx.toFixed(2) + ' ' + (by - r).toFixed(2) +
                    ' C' + (cx + r * 1.1).toFixed(2) + ' ' + (by - r * 0.75).toFixed(2) +
                    ',' + (cx + r * 1.15).toFixed(2) + ' ' + (cy - r * 1.0).toFixed(2) +
                    ',' + cx.toFixed(2) + ' ' + cy.toFixed(2) + ' Z';
                el = PVX.svg.el('path', attrs, parent);
            } else {
                attrs.cx = cx.toFixed(2);
                attrs.cy = cy.toFixed(2);
                attrs.r = h.toFixed(2);
                el = PVX.svg.el('circle', attrs, parent);
            }
            return el;
        }

        function drawMarkers(svgRoot, W, H, cfg, t, model, geom, labelsOn) {
            var items = model.items;
            if (!items.length) { return; }

            var shape = cfg.MarkerShape || 'circle';
            var size = geom.size;
            var border = geom.border;
            var font = geom.font;
            var ext = markerExtent(shape, size);
            // Ringing the marker in the surface colour is what keeps it legible
            // over an arbitrary photograph; the theme border colour alone
            // disappears against mid-grey drawings.
            var ring = t.surface === 'transparent' ? (t.dark ? '#22262b' : '#ffffff') : t.surface;
            var clickable = cfg.ClickAction === 'navigate';
            var opts = PVX.config.numberOpts(cfg);
            var reduceMotion = false;
            try {
                reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            } catch (e) { reduceMotion = false; }

            // ---- label boxes, resolved before anything is drawn -------------
            var boxes = labelsOn ? layoutLabels(items, cfg, W, H, font, ext, size) : [];

            // Leader lines first so they sit under every marker and chip.
            if (labelsOn && cfg.ShowLeaderLine) {
                var lg = PVX.svg.el('g', { 'class': 'pvx-sp-leaders' }, svgRoot);
                for (var b = 0; b < boxes.length; b++) {
                    var bx = boxes[b];
                    if (!bx || bx.dropped || !bx.moved) { continue; }
                    var mx = items[bx.i].x, my = items[bx.i].y;
                    // Aim at the nearest point on the chip's edge, not its
                    // centre: a line to the centre is hidden underneath the chip
                    // and only the useless stub between marker and chip edge
                    // would ever be visible anyway.
                    var ex = PVX.util.clamp(mx, bx.x, bx.x + bx.w);
                    var ey = PVX.util.clamp(my, bx.y, bx.y + bx.h);
                    if (Math.abs(ex - mx) < 1 && Math.abs(ey - my) < 1) { continue; }
                    PVX.svg.el('line', {
                        x1: mx.toFixed(2), y1: my.toFixed(2),
                        x2: ex.toFixed(2), y2: ey.toFixed(2),
                        stroke: items[bx.i].status.color,
                        'stroke-width': 1, 'stroke-opacity': 0.8
                    }, lg);
                }
            }

            var markersG = PVX.svg.el('g', { 'class': 'pvx-sp-markers' }, svgRoot);

            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                var st = it.status;
                var g = PVX.svg.el('g', {
                    'class': 'pvx-sp-marker' + (clickable ? ' pvx-sp-click' : '') +
                        (it.auto ? ' pvx-sp-auto' : ''),
                    'data-pvx-i': String(i)
                }, markersG);

                // Pulse halo for the worst band. Only opacity is animated: CSS
                // animation of SVG geometry (r) is not supported everywhere PI
                // Vision runs, and a halo that never appears is worse than none.
                if (cfg.PulseOnAlarm && st.topBand && !st.bad && !reduceMotion) {
                    var hy = shape === 'pin' ? it.y - size * 0.63 : it.y;
                    PVX.svg.el('circle', {
                        'class': 'pvx-sp-pulse',
                        cx: it.x.toFixed(2), cy: hy.toFixed(2),
                        r: (size * 0.78).toFixed(2),
                        fill: 'none', stroke: st.color, 'stroke-width': Math.max(1.5, border)
                    }, g);
                }

                drawMarkerShape(g, shape, it.x, it.y, size, st.color, ring, border);

                // Bad quality gets a hollow centre rather than a different hue:
                // the colour still says "which tag", the hole says "do not trust
                // this reading".
                if (st.bad && size >= 9) {
                    drawMarkerShape(g, shape, it.x, it.y, size * 0.42,
                        ring, st.color, Math.max(1, border * 0.6));
                }

                if (clickable) {
                    // Reachable and activatable from the keyboard. The SVG is
                    // rebuilt from the model on every data update, so focus does
                    // not survive a refresh — the price of drawing purely from
                    // state, and the same behaviour as the other SVG symbols.
                    g.setAttribute('tabindex', '0');
                    g.setAttribute('role', 'button');
                }

                // The tooltip is the source of truth; the chip is a compromise.
                var tip = PVX.svg.el('title', null, g);
                tip.textContent = (it.name || 'Row ' + (i + 1)) +
                    '\n' + valueText(it, cfg, opts) +
                    (st.label ? '\n' + st.label : '') +
                    (it.auto ? '\nAuto-placed: no hotspot configured' : '') +
                    (it.row.path ? '\n' + it.row.path : '');
            }

            // ---- label chips -------------------------------------------------
            if (!labelsOn) { return; }
            var labelsG = PVX.svg.el('g', { 'class': 'pvx-sp-labels' }, svgRoot);
            for (var q = 0; q < boxes.length; q++) {
                var box = boxes[q];
                if (!box || box.dropped) { continue; }
                drawLabelChip(labelsG, box, items[box.i], cfg, t, font);
            }
        }

        function valueText(it, cfg, opts) {
            var s;
            if (it.value === null) {
                // Digital states and error strings arrive as text; show them as
                // they came rather than forcing them through the number format.
                s = rawText(it.row) || '--';
            } else {
                s = PVX.fmt.number(it.value, opts);
            }
            if (cfg.ShowUnits && it.row.units && it.value !== null) { s += ' ' + it.row.units; }
            return s;
        }

        /**
         * Decide where every label chip goes.
         *
         * Two chips on top of each other are unreadable, and the pair that
         * overlaps is usually the pair the operator most needs to compare. So
         * boxes are placed worst-first (highest severity, then bad quality, then
         * source order): a high-severity marker keeps the requested position and
         * a quieter neighbour is the one that moves — or, if nowhere is free, is
         * dropped. Its value is still in the tooltip.
         */
        function layoutLabels(items, cfg, W, H, font, ext, size) {
            var pos = cfg.LabelPosition || 'below';
            var pad = 3;
            var lineH = font * 1.22;
            var opts = PVX.config.numberOpts(cfg);
            var i;

            var boxes = [];
            for (i = 0; i < items.length; i++) {
                var it = items[i];
                // A marker cropped out by ImageFit 'cover' has no visible anchor,
                // and a chip clamped back into the frame would read as a label
                // belonging to whatever marker it happened to land next to.
                if (it.x < 0 || it.y < 0 || it.x > W || it.y > H) { boxes.push(null); continue; }
                var lines = [];
                // An explicit hotspot label is always shown; the data source
                // name only when ShowNames is on.
                if ((cfg.ShowNames || it.explicit) && it.name) { lines.push(it.name); }
                if (cfg.ShowValues) { lines.push(valueText(it, cfg, opts)); }
                if (!lines.length || !lines.join('')) { boxes.push(null); continue; }

                var wPx = 0;
                for (var k = 0; k < lines.length; k++) {
                    wPx = Math.max(wPx, textPx(lines[k], font));
                }
                var bw = Math.min(wPx + pad * 2 + 2, Math.max(24, W - 4));
                var bh = lines.length * lineH + pad * 2 - 2;

                boxes.push({
                    i: i, lines: lines, w: bw, h: bh,
                    x: 0, y: 0, dropped: false, moved: false,
                    sev: it.status.bad ? -0.5 : it.status.severity
                });
            }

            // Worst-first, stable on index.
            var order = [];
            for (i = 0; i < boxes.length; i++) { if (boxes[i]) { order.push(boxes[i]); } }
            order.sort(function (a, b) { return (b.sev - a.sev) || (a.i - b.i); });

            // The markers themselves are obstacles. Label-label collisions are
            // the obvious problem, but a chip parked on top of a neighbouring
            // marker hides the one thing the symbol exists to show — and it is
            // usually the marker nearest the busiest part of the drawing.
            var obstacles = [];
            for (i = 0; i < items.length; i++) {
                obstacles.push({
                    x: items[i].x - size / 2 - 1,
                    y: items[i].y - ext.up - 1,
                    w: size + 2,
                    h: ext.up + ext.down + 2,
                    owner: i
                });
            }

            var accepted = [];
            for (i = 0; i < order.length; i++) {
                var box = order[i];
                var it2 = items[box.i];
                var cands = candidates(pos, it2, box, ext, size);
                var done = false;
                for (var c = 0; c < cands.length; c++) {
                    var p = clampBox(cands[c], box, W, H);
                    // A chip drawn 'inside' is meant to sit on its own marker,
                    // so that marker alone is not an obstacle to it. Every other
                    // position must clear its own marker too: near the frame
                    // edge the clamp can otherwise push a label straight back on
                    // top of the marker it belongs to.
                    var blocked = overlapsAny(p, box, accepted) ||
                        overlapsAny(p, box, obstacles, cands[c].inside ? box.i : undefined);
                    if (!blocked) {
                        box.x = p.x;
                        box.y = p.y;
                        box.moved = c > 0 || p.nudged;
                        box.inside = cands[c].inside;
                        accepted.push(box);
                        done = true;
                        break;
                    }
                }
                if (!done) { box.dropped = true; }
            }
            return boxes;
        }

        /** Requested position first, then the other sides, then a diagonal. */
        function candidates(pos, it, box, ext, size) {
            var below = { x: it.x - box.w / 2, y: it.y + ext.down + 3, inside: false };
            var above = { x: it.x - box.w / 2, y: it.y - ext.up - 3 - box.h, inside: false };
            var right = { x: it.x + size / 2 + 4, y: it.y - box.h / 2, inside: false };
            var left = { x: it.x - size / 2 - 4 - box.w, y: it.y - box.h / 2, inside: false };
            var inside = { x: it.x - box.w / 2, y: it.y - box.h / 2, inside: true };

            // 'inside' only works while the text actually fits within the
            // marker. Text spilling past the marker has no chip behind it, so on
            // a busy drawing it becomes unreadable — moving the label is the
            // lesser evil, exactly as with a bar chart's inside value labels.
            var fitsInside = box.w <= size * 1.02 && box.h <= size * 0.92;

            var order;
            switch (pos) {
                case 'above': order = [above, below, right, left]; break;
                case 'right': order = [right, left, below, above]; break;
                case 'inside':
                    order = fitsInside ? [inside, below, above, right] : [below, above, right, left];
                    break;
                default: order = [below, above, right, left]; break;
            }
            // Last resort: offset diagonally from the requested spot rather than
            // giving up on a label that still has room somewhere.
            order.push({ x: order[0].x + box.w * 0.55, y: order[0].y + box.h * 0.9, inside: false });
            return order;
        }

        /** Keep a chip inside the frame; an off-canvas label is silent data loss. */
        function clampBox(p, box, W, H) {
            var x = PVX.util.clamp(p.x, 2, Math.max(2, W - box.w - 2));
            var y = PVX.util.clamp(p.y, 2, Math.max(2, H - box.h - 2));
            return { x: x, y: y, nudged: (x !== p.x || y !== p.y) };
        }

        function overlapsAny(p, box, list, skipOwner) {
            for (var i = 0; i < list.length; i++) {
                var a = list[i];
                if (skipOwner !== undefined && a.owner === skipOwner) { continue; }
                if (p.x < a.x + a.w && p.x + box.w > a.x &&
                    p.y < a.y + a.h && p.y + box.h > a.y) {
                    return true;
                }
            }
            return false;
        }

        function drawLabelChip(parent, box, it, cfg, t, font) {
            var pad = 3;
            var lineH = font * 1.22;
            var g = PVX.svg.el('g', { 'class': 'pvx-sp-label' }, parent);

            var fill = t.text;
            if (cfg.LabelBackground) {
                // A chip is what makes text survive a busy drawing. Inside the
                // marker the chip IS the marker, so the text takes the readable
                // foreground for the marker colour instead.
                var bg = box.inside
                    ? 'transparent'
                    : PVX.color.rgba(t.surface === 'transparent' ? (t.dark ? '#22262b' : '#ffffff') : t.surface, 0.86);
                if (!box.inside) {
                    PVX.svg.el('rect', {
                        x: box.x.toFixed(2), y: box.y.toFixed(2),
                        width: box.w.toFixed(2), height: box.h.toFixed(2),
                        rx: 3, fill: bg,
                        stroke: PVX.color.rgba(it.status.color, 0.55),
                        'stroke-width': 1
                    }, g);
                }
            }
            if (box.inside) { fill = PVX.color.readable(it.status.color); }

            for (var i = 0; i < box.lines.length; i++) {
                var isValue = cfg.ShowValues && i === box.lines.length - 1;
                PVX.svg.text(g,
                    (box.x + box.w / 2).toFixed(2),
                    (box.y + pad + lineH * (i + 0.5) - 1).toFixed(2),
                    truncate(box.lines[i], box.w - pad * 2, font), {
                        'class': isValue ? 'pvx-svg-value pvx-num pvx-sp-labeltext'
                                         : 'pvx-svg-label pvx-sp-labeltext',
                        'text-anchor': 'middle',
                        'font-size': isValue ? font : (font * 0.92).toFixed(1),
                        fill: fill
                    });
            }
        }

        /* ------------------------------------------------------------------ *
         * Legend
         * ------------------------------------------------------------------ */
        function drawLegend(svgRoot, W, H, cfg, t, font) {
            var entries = [];
            var mode = cfg.ColorMode || 'threshold';
            var i;

            if (mode === 'state') {
                var map = parseStateMap(cfg.StateMap);
                for (var k in map) {
                    if (Object.prototype.hasOwnProperty.call(map, k)) {
                        entries.push({ color: map[k].color, label: map[k].label });
                    }
                }
            } else if (mode === 'threshold' && cfg.UseThresholds) {
                var list = PVX.thresholds.parse(cfg.Thresholds);
                for (i = 0; i < list.length; i++) {
                    entries.push({ color: list[i].color, label: list[i].label || ('≥ ' + list[i].value) });
                }
            }
            if (!entries.length) { return; }

            var sw = font * 0.85;
            var gap = 6;
            var widths = [];
            var total = 0;
            for (i = 0; i < entries.length; i++) {
                var w = sw + 3 + textPx(entries[i].label, font * 0.92);
                widths.push(w);
                total += w + gap;
            }
            total -= gap;

            // Bottom-left: the corner least likely to hold the interesting part
            // of a plant drawing, and it never fights the header.
            var boxW = Math.min(total + 10, W - 8);
            var boxH = sw + 8;
            var x0 = 4;
            var y0 = H - boxH - 4;

            var g = PVX.svg.el('g', { 'class': 'pvx-sp-legend' }, svgRoot);
            PVX.svg.el('rect', {
                x: x0, y: y0.toFixed(2), width: boxW.toFixed(2), height: boxH.toFixed(2),
                rx: 3,
                fill: PVX.color.rgba(t.surface === 'transparent' ? (t.dark ? '#22262b' : '#ffffff') : t.surface, 0.88),
                stroke: t.border, 'stroke-width': 1
            }, g);

            var cx = x0 + 5;
            for (i = 0; i < entries.length; i++) {
                if (cx + widths[i] > x0 + boxW - 4) { break; }   // silently trim overflow
                PVX.svg.el('rect', {
                    x: cx.toFixed(2), y: (y0 + 4).toFixed(2),
                    width: sw.toFixed(2), height: sw.toFixed(2),
                    rx: 2, fill: entries[i].color
                }, g);
                PVX.svg.text(g, (cx + sw + 3).toFixed(2), (y0 + 4 + sw / 2).toFixed(2),
                    entries[i].label, {
                        'class': 'pvx-svg-label', 'text-anchor': 'start',
                        'font-size': (font * 0.92).toFixed(1), fill: t.textMuted
                    });
                cx += widths[i] + gap;
            }
        }

        /* ------------------------------------------------------------------ *
         * Interaction — one delegated listener pair for the whole plan
         * ------------------------------------------------------------------ */
        function bindHost(host) {
            if (boundHost === host) { return; }
            unbindHost();
            host.addEventListener('click', onClick, false);
            host.addEventListener('keydown', onKeyDown, false);
            boundHost = host;
        }

        function unbindHost() {
            if (!boundHost) { return; }
            boundHost.removeEventListener('click', onClick, false);
            boundHost.removeEventListener('keydown', onKeyDown, false);
            boundHost = null;
        }

        /** Walk up to the marker group. Element.closest is missing on IE11. */
        function markerIndexOf(target) {
            var n = target;
            var guard = 0;
            while (n && n !== boundHost && guard < 12) {
                if (n.getAttribute && n.getAttribute('data-pvx-i') !== null) {
                    var i = parseInt(n.getAttribute('data-pvx-i'), 10);
                    return isNaN(i) ? -1 : i;
                }
                n = n.parentNode;
                guard += 1;
            }
            return -1;
        }

        function onClick(ev) {
            if (liveCfg.ClickAction !== 'navigate') { return; }
            activate(markerIndexOf(ev.target));
        }

        function onKeyDown(ev) {
            if (liveCfg.ClickAction !== 'navigate') { return; }
            var k = ev.keyCode || ev.which;
            if (k !== 13 && k !== 32) { return; }     // Enter, Space
            var i = markerIndexOf(ev.target);
            if (i < 0) { return; }
            if (ev.preventDefault) { ev.preventDefault(); }   // Space scrolls otherwise
            activate(i);
        }

        function activate(index) {
            if (index < 0 || index >= placed.length) { return; }
            var row = placed[index].row;
            var target = String(liveCfg.NavigateTarget || '').trim();
            // With neither a target display nor an asset path there is nowhere
            // to go, and re-navigating to the current URL just flickers.
            if (!target && !row.path) { return; }
            PVX.nav.go(PVX.nav.url({
                display: target || undefined,
                asset: row.path || undefined
            }), false);
        }

        /* ------------------------------------------------------------------ *
         * Misc
         * ------------------------------------------------------------------ */
        function applyThemeVars(c, t) {
            var n = c.node;
            if (!n || !n.style || !n.style.setProperty) { return; }
            n.style.setProperty('--pvx-text', t.text);
            n.style.setProperty('--pvx-muted', t.textMuted);
            n.style.setProperty('--pvx-border', t.border);
            n.style.setProperty('--pvx-surface-alt', t.surfaceAlt);
            n.style.setProperty('--pvx-accent', c.config.AccentColor || '#3b82c4');
        }

        /* Rendering happens in a rAF, i.e. outside Angular's digest, so the
         * scope.pvx writes need an explicit (guarded) digest. */
        function digest() {
            if (!scope.$$phase && scope.$root && !scope.$root.$$phase) {
                try { scope.$digest(); } catch (e) { /* already digesting */ }
            }
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
