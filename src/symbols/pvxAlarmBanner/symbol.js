/* ============================================================================
 * pvxAlarmBanner — "PVX Exception Banner"
 * ----------------------------------------------------------------------------
 * DataShape: Table (Multiple data sources)
 *
 * A live exception list. Point it at a whole unit's worth of attributes and it
 * shows only the ones currently outside their limits, worst first, with how
 * long each has been out. Turns a wall of green into a short actionable list.
 *
 * SCOPE — read this before wiring it into an operations workflow:
 * This symbol evaluates PI Vision's *live values* against the symbol's own
 * threshold configuration (PVX.thresholds / config.Thresholds). It is NOT a
 * PI Notifications or AF Event Frames client — it does not read acknowledged
 * state, alarm priorities, notification rules or historical event frames, and
 * it has no server-side state of any kind. Two operators looking at the same
 * display see the same rows, but "duration" is measured from when *their*
 * browser first saw the row in that band (see durationOf() below).
 *
 * Rendering note: rows are built imperatively into `.pvx-alarm-body` rather
 * than with ng-repeat. PI Vision pushes a full data update on every poll (as
 * often as every second on a fast display); an ng-repeat over that would run a
 * watcher per row per digest and make the whole display stutter once a few of
 * these are on screen. Building the rows by hand keeps the cost proportional
 * to the number of rows actually drawn, not to the digest rate.
 * ==========================================================================*/
(function (PV) {
    'use strict';

    function symbolVis() { }
    PV.deriveVisualizationFromBase(symbolVis);

    var definition = {
        typeName: 'pvxAlarmBanner',
        displayName: 'PVX Exception Banner',
        datasourceBehavior: PV.Extensibility.Enums.DatasourceBehaviors.Multiple,
        visObjectType: symbolVis,
        supportsCollections: false,
        configTitle: 'Format Exception Banner',
        // An exception list must not invent limits: no bands means no
        // exceptions, and the placeholder bands older displays saved are
        // cleared on load (PVX.register, thresholds.isPlaceholder).
        limitsRequired: true,

        getDefaultConfig: function () {
            return window.PVX.config.base({
                DataShape: 'Table',
                Columns: ['Value'],
                Height: 200,
                Width: 360,

                Title: 'Exceptions',

                // No limits until someone sets them. The shared placeholder
                // (0 / 70 / 90) flagged every point above 70 on a live server,
                // whatever its units, for points that had no limits at all.
                Thresholds: '',

                // Presentation
                Mode: 'list',                 // list | ticker | summary
                DenseMode: false,
                MaxRows: 12,
                RowHeight: 24,

                // What counts as an exception
                SeverityFrom: 'thresholds',   // thresholds | quality
                MinSeverityBand: 1,           // 0 => show every banded row, Normal included
                SortBy: 'severity',           // severity | name | valueDesc | duration

                // Columns
                ShowValue: true,
                ShowUnits: true,
                ShowBandLabel: true,
                ShowDuration: true,
                ShowTime: false,

                // Header
                ShowCounts: true,

                // Empty state
                ShowEmptyState: true,
                EmptyText: 'All values within limits',
                EmptyColor: '#2f9e5f',

                // Motion
                BlinkNew: true,
                BlinkSeconds: 10,
                TickerSpeed: 60,              // px/sec

                // Interaction
                ClickAction: 'none',          // none | navigate
                NavigateTarget: ''
            });
        }
    };

    /* One pulse cycle, in ms. Must match the `pvx-alarm-pulse` keyframe
     * duration in styles.css — the two are kept in sync by hand so the JS can
     * compute an iteration count and a phase offset for it. */
    var PULSE_MS = 1200;

    /* How often the duration column re-stamps itself when no new data has
     * arrived. Durations are rendered at 1s granularity below a minute. */
    var CLOCK_MS = 1000;

    /* Reduced-motion ticker: how long each item sits still before stepping. */
    var STEP_MS = 3200;

    symbolVis.prototype.init = function (scope, elem) {
        var PVX = window.PVX;

        // Fields the Angular template binds to. Everything else is hand-built.
        scope.pvx = {
            title: '',
            counts: [],
            showHeader: false,
            surface: 'transparent'
        };

        var rawRows = [];        // last payload, normalised by PVX.data.rows
        var visible = [];        // rows currently drawn, in draw order (click target lookup)
        var durNodes = [];       // [{node, since}] — updated in place by the clock
        var durationTimer = null;
        var tickerTimer = null;
        var boundHost = null;    // host the click listener is attached to

        /* --------------------------------------------------------------------
         * Duration tracking
         * --------------------------------------------------------------------
         * PI Vision hands a symbol only the *current* value of each attribute —
         * there is no event history and no server-side notion of "this tag went
         * high at 09:14". So the only honest thing we can do is time the row
         * ourselves, from the moment this browser first saw it in its current
         * band. That makes the duration SESSION-SCOPED: it starts at 0 when the
         * display is opened or refreshed, and it resets whenever a row moves to
         * a different band (High -> Critical restarts the clock, which is what
         * an operator expects to see).
         *
         * Keyed by AF path so it survives re-ordering and re-sorting. The map is
         * pruned on every pass — without that, a display left open for a shift
         * accumulates an entry for every tag that ever briefly deviated.
         */
        var durations = {};      // key -> {band, since, pass}
        var pass = 0;            // incremented per data update, used for pruning
        var seeded = false;      // has the first payload landed yet?

        var ctx = PVX.bootstrap(this, scope, elem, {
            rootSelector: '.pvx-alarm-body',

            onData: function (d) {
                rawRows = PVX.data.rows(d, ['Value']);
            },

            onDestroy: teardown,

            render: render
        });

        /* ================================================================== *
         * Severity model
         * ================================================================== *
         * Severity is simply the index of the matching band in the parsed
         * threshold spec — the spec is sorted ascending by lower bound, so a
         * higher index is unambiguously worse without needing the author to
         * label anything. -1 means "matched no band", i.e. below the lowest
         * bound or non-numeric; those rows are never exceptions.
         */

        function bandsFor(cfg) {
            // With thresholds disabled there is nothing to compare against, so
            // only the quality tier can produce an exception.
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

        /* Stable identity for a row. Path is the right key (labels repeat across
         * assets), but element-relative displays sometimes deliver an empty
         * path, so fall back to the label rather than collapsing every row onto
         * the key "". */
        function keyOf(row) {
            return row.path || ('label:' + row.label);
        }

        /**
         * Seed / advance the duration map for one row and return the timestamp
         * it entered its current band.
         */
        function durationOf(row, sev, now) {
            var k = keyOf(row);
            var e = durations[k];
            if (!e || e.band !== sev) {
                e = durations[k] = { band: sev, since: now, pass: pass, fresh: seeded };
            } else {
                e.pass = pass;
            }
            return e;
        }

        /** Drop rows that no longer appear in the payload. */
        function pruneDurations() {
            for (var k in durations) {
                if (Object.prototype.hasOwnProperty.call(durations, k) && durations[k].pass !== pass) {
                    delete durations[k];
                }
            }
        }

        /* ================================================================== *
         * Formatting
         * ================================================================== */

        /**
         * Bare elapsed duration — "42s", "4m", "2h 15m", "3d 4h".
         * Deliberately NOT PVX.fmt.ago: that appends " ago", which reads wrong
         * for a condition that is still active ("high for 4m", not "4m ago").
         */
        function fmtDuration(ms) {
            var s = Math.max(0, Math.round(ms / 1000));
            if (s < 60) { return s + 's'; }
            var m = Math.floor(s / 60);
            if (m < 60) { return m + 'm'; }
            var h = Math.floor(m / 60);
            var rm = m % 60;
            if (h < 24) { return rm ? (h + 'h ' + rm + 'm') : (h + 'h'); }
            var d = Math.floor(h / 24);
            var rh = h % 24;
            return rh ? (d + 'd ' + rh + 'h') : (d + 'd');
        }

        function bandLabel(bands, sev) {
            var b = bands[sev];
            if (!b) { return ''; }
            return b.label || ('Band ' + (sev + 1));
        }

        /* ================================================================== *
         * Model build
         * ================================================================== */

        function buildModel(cfg) {
            var bands = bandsFor(cfg);
            var now = Date.now();
            var byQuality = cfg.SeverityFrom === 'quality';
            var minBand = Math.max(0, parseInt(cfg.MinSeverityBand, 10) || 0);

            pass += 1;

            var all = [];
            var counts = [];   // counts[sev] over every banded row
            var badCount = 0;
            var i;

            for (i = 0; i < bands.length; i++) { counts.push(0); }

            for (i = 0; i < rawRows.length; i++) {
                var r = rawRows[i];
                // A bad-quality row is its own tier, ranked above every band:
                // "I cannot tell you the value" outranks any known deviation.
                var isBad = byQuality && !r.good;
                var sev = isBad ? bands.length : severityOf(r, bands);
                if (sev < 0) { continue; }

                var e = durationOf(r, sev, now);
                if (isBad) { badCount += 1; } else { counts[sev] += 1; }

                all.push({
                    label: r.label,
                    path: r.path,
                    units: r.units,
                    raw: r.raw,
                    value: r.value,
                    time: r.time,
                    good: r.good,
                    bad: isBad,
                    sev: sev,
                    since: e.since,
                    fresh: e.fresh,
                    color: isBad ? PVX.color.status.stale : bands[sev].color,
                    band: isBad ? 'Bad quality' : bandLabel(bands, sev)
                });
            }

            pruneDurations();

            // Bad-quality rows bypass MinSeverityBand entirely — suppressing a
            // sensor you cannot read because its band index is low would hide
            // exactly the case the operator most needs to see.
            var exceptions = [];
            for (i = 0; i < all.length; i++) {
                if (all[i].bad || all[i].sev >= minBand) { exceptions.push(all[i]); }
            }

            sortRows(exceptions, cfg.SortBy);

            return {
                bands: bands,
                // Nothing to compare against, so the empty list means "not
                // checked", not "all clear" — buildEmpty must say which.
                noLimits: !byQuality && !bands.length,
                all: all,
                exceptions: exceptions,
                counts: counts,
                badCount: badCount,
                now: now
            };
        }

        function sortRows(list, mode) {
            if (mode === 'name') {
                list.sort(function (a, b) {
                    return String(a.label).localeCompare(String(b.label));
                });
            } else if (mode === 'valueDesc') {
                list.sort(function (a, b) {
                    var av = a.value === null ? -Infinity : a.value;
                    var bv = b.value === null ? -Infinity : b.value;
                    return bv - av;
                });
            } else if (mode === 'duration') {
                // Oldest `since` first => longest out of limits at the top.
                list.sort(function (a, b) { return a.since - b.since; });
            } else {
                // severity: worst first, then longest-standing, then name, so the
                // order is fully deterministic and rows do not swap on every poll.
                list.sort(function (a, b) {
                    if (b.sev !== a.sev) { return b.sev - a.sev; }
                    if (a.since !== b.since) { return a.since - b.since; }
                    return String(a.label).localeCompare(String(b.label));
                });
            }
        }

        /* ================================================================== *
         * Render
         * ================================================================== */

        function render(c) {
            var cfg = c.config || {};
            var t = c.theme;
            var host = c.host;

            applyThemeVars(c, t);

            var model = buildModel(cfg);
            // The first *populated* payload is now on screen; anything that
            // turns up after this counts as new and may pulse. Without this the
            // whole list flashes the moment a display is opened.
            // The rawRows guard matters: PVX.bootstrap paints once before any
            // data arrives (and onResize/onConfigChange can paint again), so
            // flipping the flag on the first render alone would mark the real
            // first payload as "new" and set the entire list blinking.
            if (rawRows.length) { seeded = true; }

            // ---- header ---------------------------------------------------
            scope.pvx.title = cfg.Title || '';
            scope.pvx.surface = cfg.Transparent ? 'transparent' : t.surface;
            // Count pills need roughly 60px each next to the title. Below that
            // they get sliced in half by the header's overflow clip, which reads
            // as a rendering fault rather than a deliberate omission — so drop
            // them and let the list itself carry the information.
            var pillRoom = c.width - (scope.pvx.title ? 90 : 10);
            scope.pvx.counts = (cfg.ShowCounts && pillRoom >= 120) ? countPills(model, t) : [];
            scope.pvx.showHeader =
                (!!cfg.ShowLabel && !!scope.pvx.title) || scope.pvx.counts.length > 0;

            // ---- body -----------------------------------------------------
            if (host) {
                stopTicker();
                durNodes = [];
                visible = [];
                clear(host);
                bindClicks(host);

                var mode = cfg.Mode || 'list';
                if (mode === 'summary') {
                    buildSummary(host, cfg, t, model);
                } else if (!model.exceptions.length) {
                    buildEmpty(host, cfg, t, model);
                } else if (mode === 'ticker') {
                    buildTicker(host, cfg, t, model);
                } else {
                    buildList(host, cfg, t, model);
                }

                syncClock(cfg);
            }

            // Header bindings were written outside Angular's digest (bootstrap
            // renders inside requestAnimationFrame), so nudge it.
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
        }

        /**
         * Header count pills.
         * Counts are taken over EVERY banded row, not just the ones past
         * MinSeverityBand — the point of the pills is the whole picture ("3
         * Critical, 7 High, 12 Normal") while the list below stays short.
         */
        function countPills(model, t) {
            var out = [];
            if (model.badCount) {
                out.push({
                    key: 'bad',
                    label: 'Bad',
                    count: model.badCount,
                    color: PVX.color.status.stale,
                    bg: PVX.color.rgba(PVX.color.status.stale, t.dark ? 0.22 : 0.14)
                });
            }
            for (var i = model.counts.length - 1; i >= 0; i--) {
                if (!model.counts[i]) { continue; }
                var col = model.bands[i].color;
                out.push({
                    key: 'b' + i,
                    label: bandLabel(model.bands, i),
                    count: model.counts[i],
                    color: col,
                    bg: PVX.color.rgba(col, t.dark ? 0.22 : 0.14)
                });
            }
            return out;
        }

        /* ---- column budget ------------------------------------------------ *
         * As the symbol narrows, drop the least load-bearing column first.
         * Duration goes before the band label (the chip colour already encodes
         * severity), and units go last because a bare number can be ambiguous.
         */
        function columns(cfg, width) {
            return {
                value: !!cfg.ShowValue,
                units: !!cfg.ShowUnits && width >= 150,
                band: !!cfg.ShowBandLabel && width >= 200,
                duration: !!cfg.ShowDuration && width >= 260,
                time: !!cfg.ShowTime && width >= 300
            };
        }

        /* ---- list mode ---------------------------------------------------- */

        function buildList(host, cfg, t, model) {
            var cols = columns(cfg, ctx.width);
            var max = Math.max(1, parseInt(cfg.MaxRows, 10) || 12);
            var rowH = Math.max(14, parseInt(cfg.RowHeight, 10) || 24);
            var list = div('pvx-alarm-list');

            var n = Math.min(max, model.exceptions.length);
            for (var i = 0; i < n; i++) {
                var r = model.exceptions[i];
                visible.push(r);
                list.appendChild(buildRow(r, i, cfg, cols, model.now, rowH));
            }

            if (model.exceptions.length > n) {
                var more = div('pvx-alarm-more');
                more.textContent = '+' + (model.exceptions.length - n) + ' more';
                list.appendChild(more);
            }

            host.appendChild(list);
        }

        function buildRow(r, idx, cfg, cols, now, rowH) {
            var row = div('pvx-alarm-row');
            row.setAttribute('data-pvx-idx', String(idx));
            row.style.minHeight = rowH + 'px';
            // Tooltip carries the full path, which the truncated name cannot.
            row.setAttribute('title', r.path || r.label);
            if (cfg.ClickAction === 'navigate' && cfg.NavigateTarget) {
                row.className += ' pvx-alarm-clickable';
            }
            if (!r.good) { row.className += ' pvx-stale'; }
            applyPulse(row, r, cfg, now);

            var chip = div('pvx-alarm-chip');
            chip.style.background = r.color;
            row.appendChild(chip);

            var name = div('pvx-alarm-name pvx-truncate');
            name.textContent = r.label;
            row.appendChild(name);

            if (cols.value) {
                var val = div('pvx-alarm-value pvx-num');
                val.textContent = r.value === null
                    ? (r.raw === null || r.raw === undefined ? '--' : String(r.raw))
                    : PVX.fmt.number(r.raw, PVX.config.numberOpts(cfg));
                val.style.color = r.color;
                row.appendChild(val);

                if (cols.units && r.units) {
                    var u = div('pvx-alarm-units');
                    u.textContent = r.units;
                    row.appendChild(u);
                }
            }

            if (cols.band && r.band) {
                var band = div('pvx-alarm-band pvx-truncate');
                band.textContent = r.band;
                band.style.color = r.color;
                band.style.borderColor = PVX.color.rgba(r.color, 0.45);
                row.appendChild(band);
            }

            if (cols.time && r.time) {
                var tm = div('pvx-alarm-time pvx-num');
                tm.textContent = PVX.fmt.time(r.time, 'short');
                row.appendChild(tm);
            }

            if (cols.duration) {
                var dur = div('pvx-alarm-dur pvx-num');
                dur.textContent = fmtDuration(now - r.since);
                durNodes.push({ node: dur, since: r.since });
                row.appendChild(dur);
            }

            return row;
        }

        /**
         * Pulse a row that has only just appeared.
         * The row DOM is rebuilt on every data update, which would restart a
         * plain CSS animation on every poll and leave the row blinking forever.
         * Instead we shorten the animation to the time the row has left and
         * push it forward with a negative delay, so the pulse keeps its phase
         * across rebuilds and stops on schedule.
         */
        function applyPulse(row, r, cfg, now) {
            if (!cfg.BlinkNew || !r.fresh) { return; }
            // NB: not named `window` — that would shadow the global inside this
            // function and is exactly the kind of ES5 footgun this file avoids.
            var span = Math.max(0, (parseInt(cfg.BlinkSeconds, 10) || 0) * 1000);
            var age = now - r.since;
            if (age >= span) { return; }
            row.className += ' pvx-alarm-new';
            row.style.animationIterationCount = String(Math.ceil((span - age) / PULSE_MS));
            row.style.animationDelay = '-' + (age % PULSE_MS) + 'ms';
        }

        /* ---- ticker mode --------------------------------------------------- *
         * One strip, built once per data change, moved by a single CSS
         * transform animation. Nothing here runs per frame: the browser
         * compositor owns the movement, so a ticker costs the same whether it
         * holds 3 items or 30.
         */

        function buildTicker(host, cfg, t, model) {
            var cols = columns(cfg, 9999);   // the strip is not width-constrained
            var max = Math.max(1, parseInt(cfg.MaxRows, 10) || 12);
            var items = model.exceptions.slice(0, max);
            var reduced = prefersReducedMotion();

            var viewport = div('pvx-alarm-ticker');
            var strip = div('pvx-alarm-strip');
            viewport.appendChild(strip);
            host.appendChild(viewport);

            // Two copies make the wrap seamless: the animation translates by
            // exactly -50%, at which point copy 2 sits where copy 1 started.
            // The stepped fallback never wraps mid-item, so one copy is enough.
            var copies = reduced ? 1 : 2;
            for (var c = 0; c < copies; c++) {
                for (var i = 0; i < items.length; i++) {
                    var r = items[i];
                    if (c === 0) { visible.push(r); }
                    strip.appendChild(buildTickerItem(r, i, cfg, cols, model.now, c === 0));
                }
            }

            if (!items.length) { return; }

            if (reduced) {
                startSteppedTicker(strip, items.length);
            } else {
                // One forced layout per data change, not per frame.
                var oneCopy = strip.scrollWidth / 2;
                var speed = Math.max(5, PVX.util.num(cfg.TickerSpeed) || 60);
                strip.style.animationDuration = (oneCopy / speed).toFixed(2) + 's';
                strip.className += ' pvx-alarm-strip-run';
            }
        }

        function buildTickerItem(r, idx, cfg, cols, now, live) {
            var item = div('pvx-alarm-item');
            item.setAttribute('data-pvx-idx', String(idx));
            if (cfg.ClickAction === 'navigate' && cfg.NavigateTarget) {
                item.className += ' pvx-alarm-clickable';
            }

            var chip = div('pvx-alarm-chip');
            chip.style.background = r.color;
            item.appendChild(chip);

            var name = div('pvx-alarm-name');
            name.textContent = r.label;
            item.appendChild(name);

            if (cols.value) {
                var val = div('pvx-alarm-value pvx-num');
                val.textContent = r.value === null ? '--' : PVX.fmt.number(r.raw, PVX.config.numberOpts(cfg));
                val.style.color = r.color;
                item.appendChild(val);
                if (cols.units && r.units) {
                    var u = div('pvx-alarm-units');
                    u.textContent = r.units;
                    item.appendChild(u);
                }
            }
            if (cols.band && r.band) {
                var band = div('pvx-alarm-band');
                band.textContent = r.band;
                band.style.color = r.color;
                band.style.borderColor = PVX.color.rgba(r.color, 0.45);
                item.appendChild(band);
            }
            if (cols.time && r.time) {
                var tm = div('pvx-alarm-time pvx-num');
                tm.textContent = PVX.fmt.time(r.time, 'short');
                item.appendChild(tm);
            }
            if (cols.duration) {
                var dur = div('pvx-alarm-dur pvx-num');
                dur.textContent = fmtDuration(now - r.since);
                // Only the first copy is clocked; the duplicate is decorative
                // and would otherwise double the per-second work for nothing.
                if (live) { durNodes.push({ node: dur, since: r.since }); }
                item.appendChild(dur);
            }
            return item;
        }

        /**
         * prefers-reduced-motion fallback: instead of continuous scrolling,
         * hold each item still and jump to the next one. Same information,
         * no sustained movement.
         */
        function startSteppedTicker(strip, count) {
            if (count < 2) { return; }
            var idx = 0;
            tickerTimer = setInterval(function () {
                idx = (idx + 1) % count;
                var child = strip.children[idx];
                strip.style.transform = 'translateX(' + (child ? -child.offsetLeft : 0) + 'px)';
            }, STEP_MS);
        }

        function prefersReducedMotion() {
            try {
                return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
            } catch (e) { return false; }
        }

        function stopTicker() {
            if (tickerTimer) { clearInterval(tickerTimer); tickerTimer = null; }
        }

        /* ---- summary mode -------------------------------------------------- *
         * Deliberately ignores MinSeverityBand: a one-line census is only useful
         * if it accounts for everything, including the tags that are fine.
         */

        function buildSummary(host, cfg, t, model) {
            if (!model.all.length) { buildEmpty(host, cfg, t, model); return; }

            var wrap = div('pvx-alarm-summary');
            var pills = countPills(model, t);
            if (!pills.length) { buildEmpty(host, cfg, t, model); return; }

            for (var i = 0; i < pills.length; i++) {
                var p = pills[i];
                var pill = div('pvx-alarm-pill pvx-alarm-pill-lg');
                pill.style.color = p.color;
                pill.style.background = p.bg;

                var n = document.createElement('b');
                n.className = 'pvx-num';
                n.textContent = String(p.count);
                pill.appendChild(n);

                var lbl = document.createElement('span');
                lbl.textContent = p.label;
                pill.appendChild(lbl);

                wrap.appendChild(pill);
            }
            host.appendChild(wrap);
        }

        /* ---- empty state ---------------------------------------------------- */

        function buildEmpty(host, cfg, t, model) {
            // "All values within limits" over a list with no limits is a
            // false all-clear, so this case ignores ShowEmptyState and
            // EmptyText: it is a configuration fact, not an empty list.
            var noLimits = !!(model && model.noLimits);
            if (!cfg.ShowEmptyState && !noLimits) { return; }
            var wrap = div('pvx-alarm-empty');
            wrap.style.color = noLimits ? t.textMuted : (cfg.EmptyColor || PVX.color.status.normal);

            var glyph = document.createElement('span');
            glyph.className = 'pvx-alarm-check';
            glyph.textContent = noLimits ? '!' : '✓';
            wrap.appendChild(glyph);

            var txt = document.createElement('span');
            txt.textContent = noLimits
                ? 'No limits set, so nothing is flagged. Add threshold bands in Format.'
                : PVX.util.def(cfg.EmptyText, 'All values within limits');
            wrap.appendChild(txt);

            host.appendChild(wrap);
        }

        /* ================================================================== *
         * Duration clock
         * ================================================================== *
         * Durations must advance even when no new data arrives (a tag can sit
         * high for an hour without its value changing). Rewriting text nodes in
         * place is orders of magnitude cheaper than a full rebuild, and it
         * leaves the ticker animation untouched — restarting it every second
         * would make the strip stutter.
         */

        function syncClock(cfg) {
            var wanted = cfg.ShowDuration && durNodes.length > 0;
            if (wanted && !durationTimer) {
                durationTimer = setInterval(tickClock, CLOCK_MS);
            } else if (!wanted && durationTimer) {
                clearInterval(durationTimer);
                durationTimer = null;
            }
        }

        function tickClock() {
            if (ctx.destroyed) { return; }
            var now = Date.now();
            for (var i = 0; i < durNodes.length; i++) {
                var d = durNodes[i];
                var next = fmtDuration(now - d.since);
                // Skip the write when nothing changed — most seconds, most rows.
                if (d.node.textContent !== next) { d.node.textContent = next; }
            }
        }

        /* ================================================================== *
         * Interaction
         * ================================================================== */

        function bindClicks(host) {
            if (boundHost === host) { return; }
            unbindClicks();
            if (!host || !host.addEventListener) { return; }
            // One delegated listener for the whole body: rows are rebuilt
            // constantly, so per-row listeners would have to be torn down and
            // re-attached on every update.
            host.addEventListener('click', onClick, false);
            boundHost = host;
        }

        function unbindClicks() {
            if (boundHost && boundHost.removeEventListener) {
                boundHost.removeEventListener('click', onClick, false);
            }
            boundHost = null;
        }

        function onClick(ev) {
            var cfg = ctx.config || {};
            if (cfg.ClickAction !== 'navigate' || !cfg.NavigateTarget) { return; }
            var el = ev.target;
            while (el && el !== boundHost) {
                if (el.getAttribute) {
                    var raw = el.getAttribute('data-pvx-idx');
                    if (raw !== null) {
                        var r = visible[parseInt(raw, 10)];
                        if (r) {
                            PVX.nav.go(PVX.nav.url({ display: cfg.NavigateTarget, asset: r.path }));
                        }
                        return;
                    }
                }
                el = el.parentNode;
            }
        }

        /* ================================================================== *
         * DOM helpers + teardown
         * ================================================================== */

        function div(cls) {
            var d = document.createElement('div');
            d.className = cls;
            return d;
        }

        function clear(node) {
            while (node.firstChild) { node.removeChild(node.firstChild); }
        }

        function teardown() {
            stopTicker();
            if (durationTimer) { clearInterval(durationTimer); durationTimer = null; }
            unbindClicks();
            durNodes = [];
            visible = [];
            rawRows = [];
            durations = {};
        }

        return ctx;
    };

    window.PVX.register(PV, definition);

}(window.PIVisualization));
