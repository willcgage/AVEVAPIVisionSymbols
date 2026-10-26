/* ============================================================================
 * PVX Core — shared runtime for the PVX custom symbol library for AVEVA PI Vision
 * ----------------------------------------------------------------------------
 * Deployed to:  <PIVision>\Scripts\app\editor\symbols\ext\libraries\pvx\pvx-core.js
 *
 * PI Vision loads every .js file under the `libraries` folder, subfolders
 * included, BEFORE it loads the sym-*.js symbol files, so window.PVX is guaranteed to exist by the time a
 * symbol's init()/onDataUpdate() runs. As a defensive convention, symbols in
 * this library never touch PVX at *definition* time — only at runtime.
 *
 * Written in ES5 style on purpose: PI Vision hosts symbols inside its AngularJS
 * (1.x) application and this keeps the code safe across every supported browser
 * and every PI Vision release from 2019 through 2025.
 *
 * No external dependencies. No jQuery required (PI Vision ships it, but we only
 * use the element handle Angular hands us).
 * ==========================================================================*/
(function (root) {
    'use strict';

    var PVX = root.PVX || {};
    root.PVX = PVX;

    PVX.version = '1.11.0';
    PVX.SVG_NS = 'http://www.w3.org/2000/svg';

    /* ------------------------------------------------------------------ *
     * util — small helpers used everywhere
     * ------------------------------------------------------------------ */
    var util = PVX.util = {};

    util.isNum = function (n) {
        return typeof n === 'number' && isFinite(n);
    };

    /** Coerce anything PI Vision hands us into a finite number, or null. */
    util.num = function (v) {
        if (v === null || v === undefined || v === '') { return null; }
        if (typeof v === 'number') { return isFinite(v) ? v : null; }
        // PI values arrive as strings when formatted, and may carry engineering units
        var n = parseFloat(String(v).replace(/[^0-9eE+\-.]/g, ''));
        return isFinite(n) ? n : null;
    };

    util.clamp = function (v, lo, hi) {
        return v < lo ? lo : (v > hi ? hi : v);
    };

    util.def = function (v, fallback) {
        return (v === undefined || v === null || v === '') ? fallback : v;
    };

    util.debounce = function (fn, ms) {
        var t = null;
        return function () {
            var self = this, args = arguments;
            if (t) { clearTimeout(t); }
            t = setTimeout(function () { t = null; fn.apply(self, args); }, ms || 60);
        };
    };

    /** Stable-ish id for SVG defs (gradients, clip paths) so multiple instances
     *  of the same symbol on one display do not collide. */
    var _uid = 0;
    util.uid = function (prefix) {
        _uid += 1;
        return (prefix || 'pvx') + '-' + _uid + '-' + Math.floor(Math.random() * 1e6).toString(36);
    };

    /**
     * Unwrap the raw DOM element from whatever init() gave us (jqLite / jQuery /
     * raw node).
     *
     * A jqLite collection is NOT guaranteed to start with an element: if a
     * template file begins with an HTML comment or stray whitespace, index 0 is
     * a comment/text node and naive `elem[0]` returns something that has no
     * querySelector. That silently breaks every symbol whose template happens to
     * carry a header comment, so scan the collection for the first element.
     */
    util.node = function (elem) {
        if (!elem) { return null; }
        if (elem.nodeType === 1) { return elem; }
        var len = typeof elem.length === 'number' ? elem.length : 0;
        for (var i = 0; i < len; i++) {
            if (elem[i] && elem[i].nodeType === 1) { return elem[i]; }
        }
        return null;
    };

    /**
     * All element nodes in the collection — needed because a symbol's real root
     * may not be the only top-level node in its template.
     */
    util.nodes = function (elem) {
        if (!elem) { return []; }
        if (elem.nodeType === 1) { return [elem]; }
        var out = [];
        var len = typeof elem.length === 'number' ? elem.length : 0;
        for (var i = 0; i < len; i++) {
            if (elem[i] && elem[i].nodeType === 1) { out.push(elem[i]); }
        }
        return out;
    };

    /**
     * querySelector scoped to the symbol's own element. Searches every top-level
     * element in the collection, and matches the root itself as well as its
     * descendants.
     */
    util.find = function (elem, selector) {
        var roots = util.nodes(elem);
        for (var i = 0; i < roots.length; i++) {
            var r = roots[i];
            if (r.matches && r.matches(selector)) { return r; }
            var hit = r.querySelector(selector);
            if (hit) { return hit; }
        }
        return null;
    };

    util.escapeHtml = function (s) {
        return String(s === null || s === undefined ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    };

    /* ------------------------------------------------------------------ *
     * fmt — number / time formatting
     * ------------------------------------------------------------------ */
    var fmt = PVX.fmt = {};

    /**
     * Format a value for display.
     * @param {*} v
     * @param {Object} opts {decimals:number|'auto', compact:boolean, prefix, suffix, fallback}
     */
    fmt.number = function (v, opts) {
        opts = opts || {};
        var n = util.num(v);
        if (n === null) { return util.def(opts.fallback, (v === null || v === undefined) ? '--' : String(v)); }

        var out;
        if (opts.compact) {
            out = fmt.compact(n, opts.decimals === 'auto' ? 1 : opts.decimals);
        } else {
            var d = opts.decimals;
            if (d === 'auto' || d === undefined || d === null || d === '') {
                d = fmt.autoDecimals(n);
            }
            d = util.clamp(parseInt(d, 10) || 0, 0, 8);
            out = n.toFixed(d);
            if (opts.thousands !== false) { out = fmt.group(out); }
        }
        return (opts.prefix || '') + out + (opts.suffix || '');
    };

    /** Pick a sensible precision from the magnitude of the value. */
    fmt.autoDecimals = function (n) {
        var a = Math.abs(n);
        if (a === 0) { return 0; }
        if (a >= 1000) { return 0; }
        if (a >= 100) { return 1; }
        if (a >= 1) { return 2; }
        if (a >= 0.01) { return 3; }
        return 4;
    };

    fmt.group = function (s) {
        var parts = String(s).split('.');
        parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return parts.join('.');
    };

    /** 12345 -> "12.3k", 1.2e9 -> "1.2B" */
    fmt.compact = function (v, decimals) {
        var n = util.num(v);
        if (n === null) { return '--'; }
        var d = (decimals === undefined || decimals === null) ? 1 : decimals;
        var abs = Math.abs(n);
        var units = [
            [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']
        ];
        for (var i = 0; i < units.length; i++) {
            if (abs >= units[i][0]) {
                return (n / units[i][0]).toFixed(d).replace(/\.0+$/, '') + units[i][1];
            }
        }
        return n.toFixed(abs < 1 && abs > 0 ? Math.max(d, 2) : d).replace(/\.0+$/, '');
    };

    fmt.percent = function (v, decimals) {
        var n = util.num(v);
        if (n === null) { return '--'; }
        return n.toFixed(decimals === undefined ? 1 : decimals) + '%';
    };

    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    /** Parse whatever PI Vision hands us for a timestamp into a Date, or null. */
    fmt.toDate = function (t) {
        if (!t && t !== 0) { return null; }
        if (t instanceof Date) { return isNaN(t.getTime()) ? null : t; }
        if (typeof t === 'number') { var dn = new Date(t); return isNaN(dn.getTime()) ? null : dn; }
        var d = new Date(t);
        if (!isNaN(d.getTime())) { return d; }
        // PI Vision sometimes delivers already-localised display strings; give up cleanly.
        return null;
    };

    var pad = function (n) { return (n < 10 ? '0' : '') + n; };

    /**
     * @param {*} t
     * @param {String} style 'time' | 'datetime' | 'date' | 'short' | 'iso' | 'relative'
     */
    fmt.time = function (t, style) {
        var d = fmt.toDate(t);
        if (!d) { return t ? String(t) : '--'; }
        switch (style) {
            case 'iso': return d.toISOString();
            case 'date': return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
            case 'short': return pad(d.getMonth() + 1) + '/' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
            case 'relative': return fmt.ago(d);
            case 'datetime':
                return MONTHS[d.getMonth()] + ' ' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
            default:
                return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }
    };

    fmt.ago = function (t, nowMs) {
        var d = fmt.toDate(t);
        if (!d) { return '--'; }
        var s = Math.max(0, Math.round(((nowMs || Date.now()) - d.getTime()) / 1000));
        if (s < 60) { return s + 's ago'; }
        if (s < 3600) { return Math.round(s / 60) + 'm ago'; }
        if (s < 86400) { return Math.round(s / 3600) + 'h ago'; }
        return Math.round(s / 86400) + 'd ago';
    };

    /**
     * A bare duration — "45s", "12m", "2h 15m", "3d 4h".
     * Deliberately not fmt.ago(): a run length is not a time-since.
     * @param {Number} ms
     * @param {Object} opts {parts:1|2, style:'short'|'clock'|'hours'}
     */
    fmt.duration = function (ms, opts) {
        opts = opts || {};
        var n = util.num(ms);
        if (n === null || n < 0) { return '--'; }
        var total = Math.round(n / 1000);

        if (opts.style === 'hours') {
            return (n / 3600000).toFixed(n < 3600000 ? 2 : 1) + ' h';
        }
        if (opts.style === 'clock') {
            var hh = Math.floor(total / 3600);
            var mm = Math.floor((total % 3600) / 60);
            var ss = total % 60;
            return hh + ':' + pad(mm) + ':' + pad(ss);
        }

        var d = Math.floor(total / 86400);
        var h = Math.floor((total % 86400) / 3600);
        var m = Math.floor((total % 3600) / 60);
        var s = total % 60;

        var parts = [];
        if (d) { parts.push(d + 'd'); }
        if (h) { parts.push(h + 'h'); }
        if (m && !d) { parts.push(m + 'm'); }
        if (s && !d && !h) { parts.push(s + 's'); }
        if (!parts.length) { parts.push('0s'); }
        return parts.slice(0, opts.parts || 2).join(' ');
    };

    /** Short axis-friendly tick label. */
    fmt.tick = function (v) {
        var n = util.num(v);
        if (n === null) { return ''; }
        if (Math.abs(n) >= 10000 || (Math.abs(n) < 0.01 && n !== 0)) { return fmt.compact(n, 1); }
        return String(Math.round(n * 100) / 100);
    };

    /* ------------------------------------------------------------------ *
     * color — parsing, mixing, contrast, palettes
     * ------------------------------------------------------------------ */
    var color = PVX.color = {};

    /**
     * Categorical palette. Deliberately brand-neutral, ordered for maximum
     * adjacent-hue separation, and checked for >=3:1 contrast against both the
     * PI Vision light (#ffffff) and dark (#1f2124) canvases.
     */
    color.categorical = [
        '#3b82c4', '#e2803c', '#3f9e6a', '#b5504f', '#8267b0',
        '#7a6355', '#c377a8', '#6f7378', '#a8a13c', '#3fa3ad'
    ];

    /** Status palette — the only colors used for good/warn/alarm semantics. */
    color.status = {
        normal: '#2f9e5f',
        info: '#3b82c4',
        warning: '#d99024',
        alarm: '#c8452f',
        critical: '#8f1f14',
        stale: '#8a8f96',
        unknown: '#6f7378'
    };

    color.sequential = ['#0d3b66', '#1c5c92', '#3b82c4', '#75aad8', '#b3cfe8', '#e8f0f7'];
    color.diverging = ['#2166ac', '#67a9cf', '#d1e5f0', '#f7f7f7', '#fddbc7', '#ef8a62', '#b2182b'];

    color.toRgb = function (c) {
        if (!c) { return null; }
        c = String(c).trim();
        var m;
        if (c.charAt(0) === '#') {
            var hex = c.slice(1);
            if (hex.length === 3) { hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2]; }
            if (hex.length !== 6) { return null; }
            var v = parseInt(hex, 16);
            if (isNaN(v)) { return null; }
            return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255, a: 1 };
        }
        m = /^rgba?\(([^)]+)\)$/i.exec(c);
        if (m) {
            var p = m[1].split(',');
            return {
                r: parseInt(p[0], 10) || 0,
                g: parseInt(p[1], 10) || 0,
                b: parseInt(p[2], 10) || 0,
                a: p.length > 3 ? parseFloat(p[3]) : 1
            };
        }
        return null;
    };

    color.toHex = function (rgb) {
        if (!rgb) { return '#000000'; }
        var f = function (x) {
            var s = util.clamp(Math.round(x), 0, 255).toString(16);
            return s.length === 1 ? '0' + s : s;
        };
        return '#' + f(rgb.r) + f(rgb.g) + f(rgb.b);
    };

    color.rgba = function (c, alpha) {
        var rgb = color.toRgb(c);
        if (!rgb) { return c; }
        return 'rgba(' + rgb.r + ',' + rgb.g + ',' + rgb.b + ',' + util.clamp(alpha, 0, 1) + ')';
    };

    /** Linear blend, t=0 -> a, t=1 -> b. */
    color.mix = function (a, b, t) {
        var ra = color.toRgb(a), rb = color.toRgb(b);
        if (!ra || !rb) { return a; }
        t = util.clamp(t, 0, 1);
        return color.toHex({
            r: ra.r + (rb.r - ra.r) * t,
            g: ra.g + (rb.g - ra.g) * t,
            b: ra.b + (rb.b - ra.b) * t
        });
    };

    /** Sample a multi-stop ramp at t in [0,1]. */
    color.ramp = function (stops, t) {
        if (!stops || !stops.length) { return '#888888'; }
        if (stops.length === 1) { return stops[0]; }
        t = util.clamp(t, 0, 1);
        var scaled = t * (stops.length - 1);
        var i = Math.min(Math.floor(scaled), stops.length - 2);
        return color.mix(stops[i], stops[i + 1], scaled - i);
    };

    color.luminance = function (c) {
        var rgb = color.toRgb(c);
        if (!rgb) { return 0.5; }
        var f = function (x) {
            x = x / 255;
            return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(rgb.r) + 0.7152 * f(rgb.g) + 0.0722 * f(rgb.b);
    };

    color.contrastRatio = function (a, b) {
        var la = color.luminance(a), lb = color.luminance(b);
        var hi = Math.max(la, lb), lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    };

    /** Best-contrast foreground (near-black or near-white) for a background. */
    color.readable = function (bg, dark, light) {
        dark = dark || '#14171a';
        light = light || '#ffffff';
        return color.contrastRatio(bg, dark) >= color.contrastRatio(bg, light) ? dark : light;
    };

    /* ------------------------------------------------------------------ *
     * theme — light / dark aware tokens
     * ------------------------------------------------------------------ *
     * PI Vision applies a dark theme by adding classes to <body>. Rather than
     * guessing class names (they move between releases), we sample the actual
     * rendered background of the symbol's ancestor chain. That works on every
     * release and also works inside our offline harness.
     */
    var theme = PVX.theme = {};

    theme.isDark = function (elem) {
        var n = util.node(elem);
        // Start at the PARENT, never at the symbol's own root.
        //
        // A symbol's root often carries a background — either from config or as
        // a CSS fallback in its stylesheet — and that background is this
        // function's OUTPUT, not its input. Sampling it makes the first frame
        // read the symbol's own light-mode fallback and latch to the light
        // palette on a dark display. Context comes from what the symbol is
        // sitting on.
        var probe = n ? n.parentElement : null;
        var guard = 0;
        while (probe && guard < 30) {
            var bg = null;
            try { bg = root.getComputedStyle(probe).backgroundColor; } catch (e) { bg = null; }
            var rgb = color.toRgb(bg);
            if (rgb && rgb.a > 0.1) {
                return color.luminance(color.toHex(rgb)) < 0.4;
            }
            probe = probe.parentElement;
            guard += 1;
        }
        // Fall back to PI Vision's documented dark-theme body classes.
        try {
            var cls = (root.document.body.className || '').toLowerCase();
            if (cls.indexOf('dark') !== -1 || cls.indexOf('night') !== -1) { return true; }
        } catch (e2) { /* ignore */ }
        return false;
    };

    /**
     * Resolve the drawing palette for a symbol instance.
     * @param {Object} config symbol config (may carry explicit overrides)
     * @param {*} elem symbol element, used for auto light/dark detection
     */
    theme.tokens = function (config, elem) {
        config = config || {};
        var mode = config.Theme || 'auto';
        var dark = mode === 'dark' || (mode === 'auto' && theme.isDark(elem));

        var t = dark ? {
            dark: true,
            surface: '#22262b',
            surfaceAlt: '#2b3037',
            border: '#3b424b',
            text: '#e8ecf1',
            textMuted: '#9aa4b0',
            grid: 'rgba(255,255,255,0.10)',
            axis: 'rgba(255,255,255,0.28)',
            track: 'rgba(255,255,255,0.12)',
            shadow: 'rgba(0,0,0,0.45)'
        } : {
            dark: false,
            surface: '#ffffff',
            surfaceAlt: '#f4f6f8',
            border: '#d6dbe1',
            text: '#1d2126',
            textMuted: '#5c6570',
            grid: 'rgba(0,0,0,0.08)',
            axis: 'rgba(0,0,0,0.25)',
            track: 'rgba(0,0,0,0.10)',
            shadow: 'rgba(0,0,0,0.18)'
        };

        // Explicit config overrides always win.
        if (config.BackgroundColor) { t.surface = config.BackgroundColor; }
        if (config.TextColor) { t.text = config.TextColor; }
        if (config.Transparent) { t.surface = 'transparent'; }
        t.status = color.status;
        t.categorical = color.categorical;
        return t;
    };

    /* ------------------------------------------------------------------ *
     * thresholds — shared limit / state engine used by every symbol
     * ------------------------------------------------------------------ *
     * Config format is a single string so it round-trips cleanly through the
     * PI Vision display database and is easy to edit in the config pane:
     *
     *   "0:#2f9e5f:Normal, 70:#d99024:High, 90:#c8452f:Critical"
     *
     * Each entry is  <lowerBound>:<color>[:<label>]  and applies for values
     * >= lowerBound and < the next entry's lowerBound.
     */
    var thresholds = PVX.thresholds = {};

    thresholds.DEFAULT = '0:#2f9e5f:Normal, 70:#d99024:High, 90:#c8452f:Critical';

    thresholds.parse = function (spec) {
        if (!spec) { return []; }
        if (Object.prototype.toString.call(spec) === '[object Array]') { return spec.slice(); }
        var out = [];
        String(spec).split(/[,\n;]/).forEach(function (chunk) {
            var s = chunk.trim();
            if (!s) { return; }
            var parts = s.split(':');
            var v = util.num(parts[0]);
            if (v === null) { return; }
            out.push({
                value: v,
                color: (parts[1] || '').trim() || color.status.info,
                label: (parts.slice(2).join(':') || '').trim()
            });
        });
        out.sort(function (a, b) { return a.value - b.value; });
        return out;
    };

    thresholds.stringify = function (list) {
        return (list || []).map(function (t) {
            return t.value + ':' + t.color + (t.label ? ':' + t.label : '');
        }).join(', ');
    };

    /**
     * Is this spec the shipped placeholder rather than limits someone chose?
     *
     * DEFAULT is a demonstration on a 0-100 scale, not a limit. Colouring a
     * gauge with it is harmless; an alarm symbol applying it to every point
     * declared steam flow at 118 klb/h "Critical" on a live server, for points
     * with no limits at all. Compared after parse + stringify so spacing and
     * band order do not matter: the band editor rewrites the string, and a
     * display saved through it must still be recognised.
     */
    thresholds.isPlaceholder = function (spec) {
        if (!spec) { return false; }
        return thresholds.stringify(thresholds.parse(spec)) ===
            thresholds.stringify(thresholds.parse(thresholds.DEFAULT));
    };

    /** Which band does this value fall into? Returns null below the first band. */
    thresholds.evaluate = function (spec, value) {
        var list = thresholds.parse(spec);
        var n = util.num(value);
        if (n === null || !list.length) { return null; }
        var hit = null;
        for (var i = 0; i < list.length; i++) {
            if (n >= list[i].value) { hit = list[i]; } else { break; }
        }
        return hit;
    };

    thresholds.colorFor = function (spec, value, fallback) {
        var band = thresholds.evaluate(spec, value);
        return band ? band.color : (fallback || color.status.info);
    };

    /** Bands clipped to [min,max], for drawing gauge/bar arcs. */
    thresholds.bands = function (spec, min, max) {
        var list = thresholds.parse(spec);
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var from = Math.max(list[i].value, min);
            var to = (i + 1 < list.length) ? Math.min(list[i + 1].value, max) : max;
            if (to > from) {
                out.push({ from: from, to: to, color: list[i].color, label: list[i].label });
            }
        }
        return out;
    };

    /**
     * Row editor for config.Thresholds, behind the "Threshold bands" fields
     * build.js injects into a format pane (src/shared/config-bands.html).
     *
     * The stored value stays the grammar string: saved displays load
     * unchanged, every symbol keeps reading it through parse(), and the
     * operator edits a limit, a colour and a label per band instead of
     * typing the grammar.
     *
     * Rows are NOT the parse() of the string while the operator is typing.
     * parse() sorts and drops a band with no number, so reparsing every
     * keystroke would reorder the row under the cursor and make a half-typed
     * limit vanish. Rows write the string; the string is read back into rows
     * only when something else changed it (the text box, an undo, a load).
     *
     * Most symbols have one band list, config.Thresholds. A symbol with
     * another key in the same grammar (Combo Chart's LimitBands) binds that
     * key too; each editor is published under its key so two on one pane
     * never write into each other's string.
     *
     * @param {Object} scope the symbol's Angular scope
     * @param {String} [key] config key holding the grammar, default 'Thresholds'
     * @returns {Object} state, at scope.runtimeData.pvxBandsFor[key], and
     *          for Thresholds also at scope.runtimeData.pvxBands
     */
    thresholds.bind = function (scope, key) {
        if (!scope) { return null; }
        if (!scope.runtimeData) { scope.runtimeData = {}; }
        key = key || 'Thresholds';

        var state = {
            rows: [],
            textMode: false,
            written: null,      // the last string this editor wrote
            unwatch: null
        };

        var cfg = function () {
            return scope.config || (scope.symbol && scope.symbol.Configuration) || null;
        };

        // The picker only takes #rrggbb. A colour it cannot show (a named
        // colour typed into the text box, say) is kept as written until the
        // operator picks a new one, rather than being replaced by black.
        var rowFor = function (t) {
            var rgb = color.toRgb(t.color);
            return { value: t.value, color: t.color, hex: rgb ? color.toHex(rgb) : '#000000', label: t.label };
        };

        state.load = function (spec) {
            var list = thresholds.parse(spec);
            var rows = [];
            for (var i = 0; i < list.length; i++) { rows.push(rowFor(list[i])); }
            state.rows = rows;
            state.written = spec === undefined || spec === null ? '' : String(spec);
        };

        /** Write the rows back as the grammar string. */
        state.commit = function () {
            var c = cfg();
            var out = [];
            for (var i = 0; i < state.rows.length; i++) {
                var r = state.rows[i];
                // The grammar separates bands with , ; and newlines, so any of
                // those in a label would split it into a bogus extra band.
                // Replaced where the operator can see it, in the field itself.
                if (r.label && /[,;\r\n]/.test(r.label)) { r.label = r.label.replace(/\s*[,;\r\n]+\s*/g, ' '); }
                r.invalid = util.num(r.value) === null;
                // A band with no limit is left out of the string but kept as a
                // row, flagged, so it is fixed rather than silently lost.
                if (!r.invalid) {
                    out.push({ value: util.num(r.value), color: r.color || color.status.info, label: (r.label || '').trim() });
                }
            }
            state.written = thresholds.stringify(out);
            if (c) { c[key] = state.written; }
        };

        state.setColor = function (r) {
            r.color = r.hex;
            state.commit();
        };

        state.add = function () {
            var top = null;
            for (var i = 0; i < state.rows.length; i++) {
                var v = util.num(state.rows[i].value);
                if (v !== null && (top === null || v > top)) { top = v; }
            }
            var c = color.categorical[state.rows.length % color.categorical.length];
            state.rows.push({ value: top === null ? 0 : top + 10, color: c, hex: c, label: '' });
            state.commit();
        };

        state.remove = function (i) {
            if (i < 0 || i >= state.rows.length) { return; }
            state.rows.splice(i, 1);
            state.commit();
        };

        /** Lowest limit first, which is the order the bands apply in. */
        state.sort = function () {
            state.rows.sort(function (a, b) {
                var x = util.num(a.value), y = util.num(b.value);
                if (x === null) { return y === null ? 0 : 1; }
                if (y === null) { return -1; }
                return x - y;
            });
            state.commit();
        };

        state.unsorted = function () {
            var last = null;
            for (var i = 0; i < state.rows.length; i++) {
                var v = util.num(state.rows[i].value);
                if (v === null) { continue; }
                if (last !== null && v < last) { return true; }
                last = v;
            }
            return false;
        };

        state.hasInvalid = function () {
            for (var i = 0; i < state.rows.length; i++) { if (state.rows[i].invalid) { return true; } }
            return false;
        };

        state.toggleText = function () { state.textMode = !state.textMode; };

        if (scope.$watch) {
            try {
                state.unwatch = scope.$watch(function () {
                    var c = cfg();
                    return c ? c[key] : undefined;
                }, function (v) {
                    var s = v === undefined || v === null ? '' : String(v);
                    if (s !== state.written) { state.load(v); }
                });
            } catch (e) { state.unwatch = null; }
        }
        state.destroy = function () {
            if (state.unwatch) { state.unwatch(); state.unwatch = null; }
        };

        var c0 = cfg();
        state.load(c0 ? c0[key] : '');
        if (!scope.runtimeData.pvxBandsFor) { scope.runtimeData.pvxBandsFor = {}; }
        scope.runtimeData.pvxBandsFor[key] = state;
        if (key === 'Thresholds') { scope.runtimeData.pvxBands = state; }
        return state;
    };

    /* ------------------------------------------------------------------ *
     * states — digital state maps edited as rows in a format pane
     * ================================================================== *
     * Three grammars name digital states in config, all comma separated:
     *   map     State:colour[:label]   pvxStatusGrid, pvxSitePlan StateMap
     *   colors  State:colour           pvxStateDuration StateColors
     *   list    State                  pvxStateDuration UptimeStates
     *   bands   State:band             pvxAlarmBanner, pvxAnnunciator StateBands
     *
     * `bands` puts a digital state into one of the symbol's threshold bands,
     * named by label (or by 0-based index for a band with none), so a state
     * alarms, latches, sorts and colours exactly as a number in that band
     * would, and nothing downstream needs a second notion of severity.
     *
     * Typed by hand, a state map is wrong in the quiet way: "Runing" or
     * "Fault " matches nothing, and the tile falls back to another colour
     * with no error anywhere. So build.js expands a marker in config.html
     *   <!-- pvx:states key=StateMap kind=map -->
     * into rows (src/shared/config-states.html) whose state is chosen from a
     * list, a severity or colour is picked, and the stored value stays the
     * grammar string, so saved displays and every symbol's parser are
     * unaffected.
     *
     * WHERE THE LIST COMES FROM
     *   1. The digital state set of each data source, read from PI Web API
     *      when the site has configured it (a PI point's DigitalSetName, an
     *      AF attribute's enumeration set). Not yet proven on a server; the
     *      mock in tools/test-states.js is the only evidence.
     *   2. States seen in the symbol's live data, so the list is useful on a
     *      site with no PI Web API at all.
     *   3. States already in the map, so a saved entry is always selectable.
     * A state none of those know can still be typed: an empty list must not
     * make the editor unusable.
     *
     * Like the AF picker, every write goes to the `config` the pane passes
     * in from its own expressions, which is the object PI Vision saves.
     */
    var states = PVX.states = {};

    states.KINDS = { map: true, colors: true, list: true, bands: true };
    states.MAX_OPTIONS = 300;

    // Severity names over the shared status palette. A severity is only a
    // colour in the stored string; the name is recovered from the colour.
    states.SEVERITIES = [
        { name: 'Normal', color: color.status.normal },
        { name: 'Information', color: color.status.info },
        { name: 'Warning', color: color.status.warning },
        { name: 'Alarm', color: color.status.alarm },
        { name: 'Critical', color: color.status.critical },
        { name: 'Off / stale', color: color.status.stale }
    ];

    function stTrim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }

    /** Severity name for a colour, or '' when it is not one of the palette's. */
    states.severityOf = function (c) {
        var rgb = color.toRgb(c);
        if (!rgb) { return ''; }
        var hex = color.toHex(rgb).toLowerCase();
        for (var i = 0; i < states.SEVERITIES.length; i++) {
            if (states.SEVERITIES[i].color.toLowerCase() === hex) { return states.SEVERITIES[i].name; }
        }
        return '';
    };

    /**
     * Grammar string -> [{state, color, label}], in the order written and
     * without dropping anything the symbols would keep. The symbols read
     * these strings with parsers of their own; this one must agree with them.
     */
    states.parse = function (spec, kind) {
        var out = [];
        String(spec === null || spec === undefined ? '' : spec).split(/[,\n;]/).forEach(function (chunk) {
            var s = stTrim(chunk);
            if (!s) { return; }
            if (kind === 'list') { out.push({ state: s, color: '', label: '' }); return; }
            var p = s.split(':');
            var key = stTrim(p[0]);
            if (!key) { return; }
            if (kind === 'bands') {
                out.push({ state: key, color: '', label: '', band: stTrim(p.slice(1).join(':')) });
                return;
            }
            out.push({
                state: key,
                // colors keeps everything after the first colon as the colour,
                // exactly as pvxStateDuration reads it.
                color: kind === 'colors' ? stTrim(p.slice(1).join(':')) : stTrim(p[1]),
                label: kind === 'map' ? stTrim(p.slice(2).join(':')) : ''
            });
        });
        return out;
    };

    states.stringify = function (list, kind) {
        return (list || []).map(function (e) {
            if (kind === 'list') { return e.state; }
            if (kind === 'bands') { return e.state + ':' + e.band; }
            var s = e.state + ':' + e.color;
            return kind === 'map' && e.label ? s + ':' + e.label : s;
        }).join(', ');
    };

    /**
     * Which band a `bands` entry names: a band label (case-insensitive),
     * else a 0-based index. -1 when it names neither, which the format pane
     * flags; a symbol treats that state as unmapped.
     * @param {String} name  the part after the colon
     * @param {Array} bands  PVX.thresholds.parse() output
     */
    states.bandOf = function (name, bands) {
        var n = stTrim(name).toLowerCase();
        if (!n || !bands) { return -1; }
        for (var i = 0; i < bands.length; i++) {
            if (stTrim(bands[i].label).toLowerCase() === n) { return i; }
        }
        return /^\d+$/.test(n) && +n < bands.length ? +n : -1;
    };

    /** StateBands string -> {state lower-cased: band index}, unresolved left out. */
    states.bandMap = function (spec, bands) {
        var out = {};
        var list = states.parse(spec, 'bands');
        for (var i = 0; i < list.length; i++) {
            var b = states.bandOf(list[i].band, bands);
            if (b >= 0) { out[list[i].state.toLowerCase()] = b; }
        }
        return out;
    };

    /** A raw value as the state text it would be matched by, or ''. */
    states.text = function (raw) {
        if (raw && typeof raw === 'object') { raw = raw.Name !== undefined ? raw.Name : raw.name; }
        return raw === null || raw === undefined ? '' : stTrim(raw);
    };

    /**
     * Non-numeric values anywhere in a PI Vision data object: Value, Table
     * and TimeSeries shapes alike. A digital state arrives as a string, or on
     * some releases as {Name, Value}; numbers are not states.
     */
    states.seenIn = function (d, into) {
        var found = into || [];
        var have = {};
        for (var h = 0; h < found.length; h++) { have[found[h].toLowerCase()] = true; }
        var add = function (v) {
            if (v && typeof v === 'object') { v = v.Name !== undefined ? v.Name : v.name; }
            if (typeof v !== 'string') { return; }
            var s = stTrim(v);
            if (!s || util.num(s) !== null || have[s.toLowerCase()] || found.length >= states.MAX_OPTIONS) { return; }
            have[s.toLowerCase()] = true;
            found.push(s);
        };
        var walk = function (o, depth) {
            if (!o || typeof o !== 'object' || depth > 4) { return; }
            if (Object.prototype.toString.call(o) === '[object Array]') {
                for (var i = 0; i < o.length; i++) { walk(o[i], depth + 1); }
                return;
            }
            if (o.Value !== undefined) {
                if (o.Value && typeof o.Value === 'object' && o.Value.Name === undefined) { walk(o.Value, depth + 1); }
                else { add(o.Value); }
            }
            walk(o.Values, depth + 1);
            walk(o.Rows, depth + 1);
            walk(o.Data, depth + 1);
        };
        walk(d, 0);
        return found;
    };

    /** 'pi:\\srv\TAG?12' -> '\\srv\TAG' — the path PI Web API resolves. */
    states.sourcePath = function (ds) {
        var s = String(ds === null || ds === undefined ? '' : ds);
        var q = s.indexOf('?');
        if (q > 0) { s = s.slice(0, q); }
        return stTrim(s.replace(/^[a-z]+:/i, ''));
    };

    function stErr(e) {
        return (e && e.pvxError && e.pvxError.message) || (e && e.message) || 'PI Web API request failed.';
    }

    function namesOf(r) {
        var out = [];
        var items = (r && r.Items) || [];
        for (var i = 0; i < items.length; i++) { if (items[i] && items[i].Name) { out.push(String(items[i].Name)); } }
        return out;
    }

    // Per page, keyed by source path: a set does not change while a display
    // is open, and three panes on one tag should cost one lookup.
    var setCache = {};

    /**
     * The digital state set behind one data source: {set, states:[...]} or
     * {set:'', states:[]} when it is not digital. Rejects on a request that
     * fails, so the pane can say why the list is short.
     */
    states.lookupSet = function (ds) {
        var p = states.sourcePath(ds);
        if (!p) { return Promise.resolve({ set: '', states: [] }); }
        var k = p.toLowerCase();
        if (setCache[k]) { return setCache[k]; }

        var none = { set: '', states: [] };
        var fromPoint = function (pt) {
            // A Data Archive digital set is named on the point and listed on
            // its server, so it is found by name there.
            if (!pt || String(pt.PointType || '').toLowerCase() !== 'digital' || !pt.DigitalSetName) { return none; }
            var srv = pt.Links && pt.Links.DataServer;
            if (!srv) { return none; }
            var name = String(pt.DigitalSetName);
            return api.get(srv + '/enumerationsets').then(function (r) {
                var items = (r && r.Items) || [];
                for (var i = 0; i < items.length; i++) {
                    if (String(items[i].Name).toLowerCase() === name.toLowerCase() && items[i].WebId) {
                        return api.get('enumerationsets/' + encodeURIComponent(items[i].WebId) + '/enumerationvalues')
                            .then(function (v) { return { set: name, states: namesOf(v) }; });
                    }
                }
                throw { message: 'Digital state set ' + name + ' is not listed on its PI Data Archive.' };
            });
        };

        var job;
        if (p.indexOf('|') !== -1) {
            job = api.get('attributes?path=' + encodeURIComponent(p)).then(function (a) {
                var links = (a && a.Links) || {};
                // An AF attribute typed as an enumeration carries its set;
                // one that only references a digital PI point does not.
                if (links.EnumerationValues) {
                    return api.get(links.EnumerationValues).then(function (v) {
                        return { set: (a && a.TypeQualifier) || '', states: namesOf(v) };
                    });
                }
                if (links.Point) { return api.get(links.Point).then(fromPoint); }
                return none;
            });
        } else {
            job = api.get('points?path=' + encodeURIComponent(p)).then(fromPoint);
        }
        setCache[k] = job;
        // A failure is not cached: the next pane open tries again.
        job.then(null, function () { if (setCache[k] === job) { delete setCache[k]; } });
        return job;
    };

    states.clearCache = function () { setCache = {}; };

    /**
     * Publish the editor at runtimeData.pvxStates. Editors are made per
     * config key by use(), called from the pane, so a symbol whose pane has
     * no state map pays nothing, and nothing is requested from PI Web API
     * until a pane with one is opened.
     *
     * @param {Object} scope the symbol's Angular scope
     * @returns {Object} state, also at scope.runtimeData.pvxStates
     */
    states.bind = function (scope) {
        if (!scope) { return null; }
        if (!scope.runtimeData) { scope.runtimeData = {}; }

        var mod = {
            ed: {},
            seen: [],           // states seen in live data
            sets: [],           // [{set, states}] read from PI Web API
            busy: false,
            loaded: '',         // the source list the sets were read for
            pending: null,      // the read in flight, or done, for that list
            note: '',
            version: 0,
            severities: states.SEVERITIES
        };

        var digest = function () {
            try { if (scope.$evalAsync) { scope.$evalAsync(function () {}); } } catch (e) { /* no Angular: tests */ }
        };

        var sourceList = function () {
            var ds = scope.symbol && scope.symbol.DataSources;
            var out = [];
            if (ds && typeof ds.length === 'number') { for (var i = 0; i < ds.length; i++) { out.push(String(ds[i])); } }
            return out;
        };

        /** Read each source's digital set once per source list. */
        mod.load = function () {
            var list = sourceList();
            var key = list.join('\n');
            if (key === mod.loaded && mod.pending) { return mod.pending; }
            mod.loaded = key;
            if (!api.isConfigured()) {
                mod.sets = [];
                mod.note = 'PI Web API is not set up for this site, so the list holds only states seen in ' +
                    'live data. Any other state can be typed.';
                mod.version += 1;
                mod.pending = Promise.resolve();
                return mod.pending;
            }
            mod.busy = true;
            mod.note = '';
            var failed = [];
            var jobs = list.map(function (ds) {
                return states.lookupSet(ds).then(null, function (e) {
                    failed.push(sources.name(ds) + ': ' + stErr(e));
                    return { set: '', states: [] };
                });
            });
            mod.pending = Promise.all(jobs).then(function (found) {
                if (mod.loaded !== key) { return; }
                var sets = [];
                var named = {};
                for (var i = 0; i < found.length; i++) {
                    var f = found[i];
                    if (!f.states.length || named[f.set.toLowerCase()]) { continue; }
                    named[f.set.toLowerCase()] = true;
                    sets.push(f);
                }
                mod.sets = sets;
                mod.busy = false;
                if (failed.length) {
                    mod.note = 'Could not read the digital state set of ' + failed.join('; ') +
                        '. Check the data source in PI Web API; states seen in live data are still listed.';
                } else if (!sets.length) {
                    mod.note = 'No data source here has a digital state set, so the list holds states seen ' +
                        'in live data. Any other state can be typed.';
                }
                mod.version += 1;
                digest();
            });
            return mod.pending;
        };

        /** Feed live data in; called by bootstrap on every data update. */
        mod.observe = function (d) {
            var n = mod.seen.length;
            states.seenIn(d, mod.seen);
            if (mod.seen.length !== n) { mod.version += 1; }
        };

        /**
         * The editor for one config key, made on first use.
         * @param {String} key  config key, e.g. 'StateMap'
         * @param {String} kind map | colors | list
         */
        mod.use = function (key, kind) {
            if (mod.ed[key]) { return mod.ed[key]; }
            var ed = makeEditor(mod, key, states.KINDS[kind] ? kind : 'map');
            mod.ed[key] = ed;
            mod.load();
            return ed;
        };

        mod.destroy = function () { mod.ed = {}; };

        scope.runtimeData.pvxStates = mod;
        return mod;
    };

    function makeEditor(mod, key, kind) {
        var ed = {
            key: key,
            kind: kind,
            rows: [],
            textMode: false,
            written: null,      // the last string this editor wrote or loaded
            choices: [],
            built: -1           // mod.version the choices were built for
        };

        var rowFor = function (e) {
            var rgb = color.toRgb(e.color);
            return {
                state: e.state,
                color: e.color,
                hex: rgb ? color.toHex(rgb) : '#000000',
                label: e.label,
                band: e.band || '',
                severity: states.severityOf(e.color),
                typed: false
            };
        };

        ed.load = function (spec) {
            var list = states.parse(spec, kind);
            var rows = [];
            for (var i = 0; i < list.length; i++) { rows.push(rowFor(list[i])); }
            ed.rows = rows;
            ed.written = spec === undefined || spec === null ? '' : String(spec);
            ed.built = -1;
        };

        /**
         * Called by the pane with the stored value on every digest. Rows are
         * not rebuilt from the string while they are what wrote it, or a
         * half-typed state would vanish; they are when the text box, an undo
         * or a load changed it. Always true, so it can sit in an ng-if.
         */
        ed.sync = function (spec) {
            var s = spec === undefined || spec === null ? '' : String(spec);
            if (s !== ed.written) { ed.load(spec); }
            return true;
        };

        /** Write the rows back as the grammar string, into the pane's config. */
        ed.commit = function (cfg) {
            var out = [];
            var seen = {};
            for (var i = 0; i < ed.rows.length; i++) {
                var r = ed.rows[i];
                // Separators in a state or label would split the entry; a colon
                // in a state would move its colour. Fixed where it can be seen.
                if (r.state && /[,;:\r\n]/.test(r.state)) { r.state = r.state.replace(/\s*[,;:\r\n]+\s*/g, ' '); }
                if (r.label && /[,;\r\n]/.test(r.label)) { r.label = r.label.replace(/\s*[,;\r\n]+\s*/g, ' '); }
                var st = stTrim(r.state);
                r.invalid = !st;
                r.duplicate = !!st && !!seen[st.toLowerCase()];
                if (st) { seen[st.toLowerCase()] = true; }
                // A row with no state is kept, flagged, rather than lost.
                if (!r.invalid) {
                    out.push({ state: st, color: r.color || color.status.info, label: stTrim(r.label), band: stTrim(r.band) });
                }
            }
            ed.written = states.stringify(out, kind);
            // A state typed into one row is offered to the others.
            ed.built = -1;
            if (cfg) { cfg[key] = ed.written; }
            return ed.written;
        };

        ed.setColor = function (r, cfg) {
            r.color = r.hex;
            r.severity = states.severityOf(r.hex);
            return ed.commit(cfg);
        };

        ed.setSeverity = function (r, cfg) {
            for (var i = 0; i < states.SEVERITIES.length; i++) {
                if (states.SEVERITIES[i].name === r.severity) {
                    r.color = r.hex = states.SEVERITIES[i].color;
                }
            }
            return ed.commit(cfg);
        };

        /** A new row takes the first listed state not already mapped. */
        ed.add = function (cfg) {
            var used = {};
            for (var i = 0; i < ed.rows.length; i++) { used[stTrim(ed.rows[i].state).toLowerCase()] = true; }
            var next = '';
            var ch = ed.options();
            for (var j = 0; j < ch.length; j++) {
                if (!used[ch[j].name.toLowerCase()]) { next = ch[j].name; break; }
            }
            var c = kind === 'list' || kind === 'bands' ? '' : color.status.normal;
            // A state is mapped to raise it, so a new one starts in the worst band.
            var bo = kind === 'bands' ? ed.bandOptions(cfg && cfg.Thresholds) : [];
            ed.rows.push({ state: next, color: c, hex: c || '#000000', label: '',
                           band: bo.length ? bo[bo.length - 1].value : '',
                           severity: c ? states.severityOf(c) : '', typed: !ch.length });
            return ed.commit(cfg);
        };

        var bandCache = { spec: null, list: [] };

        /**
         * The bands a `bands` row can name, from the pane's own Thresholds.
         * A band is stored by its label so inserting a band does not move a
         * state into its neighbour; by index only when it has no label or
         * shares one. Same array until Thresholds changes.
         */
        ed.bandOptions = function (spec) {
            var s = spec === undefined || spec === null ? '' : String(spec);
            if (bandCache.spec === s) { return bandCache.list; }
            var bands = thresholds.parse(s);
            var count = {};
            var i;
            for (i = 0; i < bands.length; i++) {
                var l = stTrim(bands[i].label).toLowerCase();
                count[l] = (count[l] || 0) + 1;
            }
            var list = [];
            for (i = 0; i < bands.length; i++) {
                var lab = stTrim(bands[i].label);
                var byLabel = lab && count[lab.toLowerCase()] === 1;
                list.push({
                    value: byLabel ? lab : String(i),
                    text: lab || 'Band ' + (i + 1) + ' (from ' + bands[i].value + ')',
                    color: bands[i].color
                });
            }
            bandCache.spec = s;
            bandCache.list = list;
            return list;
        };

        /** True when some row names a band the Thresholds do not have. */
        ed.unknownBand = function (spec) {
            if (kind !== 'bands') { return false; }
            var bands = thresholds.parse(spec);
            for (var i = 0; i < ed.rows.length; i++) {
                var r = ed.rows[i];
                if (stTrim(r.state) && states.bandOf(r.band, bands) < 0) { return true; }
            }
            return false;
        };

        /** Colour of the band a row names, for the swatch beside it. */
        ed.bandColor = function (r, spec) {
            var bands = thresholds.parse(spec);
            var b = states.bandOf(r.band, bands);
            return b >= 0 ? bands[b].color : 'transparent';
        };

        ed.remove = function (i, cfg) {
            if (i < 0 || i >= ed.rows.length) { return ed.written; }
            ed.rows.splice(i, 1);
            ed.built = -1;
            return ed.commit(cfg);
        };

        /** Switch one row between the list and a text box. */
        ed.type = function (r) { r.typed = !r.typed; ed.built = -1; };

        ed.toggleText = function () { ed.textMode = !ed.textMode; };

        ed.hasInvalid = function () {
            for (var i = 0; i < ed.rows.length; i++) { if (ed.rows[i].invalid) { return true; } }
            return false;
        };

        ed.hasDuplicate = function () {
            for (var i = 0; i < ed.rows.length; i++) { if (ed.rows[i].duplicate) { return true; } }
            return false;
        };

        /**
         * What the state lists offer, grouped by where each came from. The
         * same array is returned until something changes, so a digest does
         * not see a new collection every pass.
         */
        ed.options = function () {
            if (ed.built === mod.version && ed.choices) { return ed.choices; }
            var out = [];
            var have = {};
            var push = function (name, group) {
                var s = stTrim(name);
                if (!s || have[s.toLowerCase()] || out.length >= states.MAX_OPTIONS) { return; }
                have[s.toLowerCase()] = true;
                out.push({ name: s, group: group });
            };
            var i, j;
            for (i = 0; i < mod.sets.length; i++) {
                var g = 'Digital state set' + (mod.sets[i].set ? ' ' + mod.sets[i].set : '');
                for (j = 0; j < mod.sets[i].states.length; j++) { push(mod.sets[i].states[j], g); }
            }
            for (i = 0; i < mod.seen.length; i++) { push(mod.seen[i], 'Seen in live data'); }
            for (i = 0; i < ed.rows.length; i++) { push(ed.rows[i].state, 'Already in this list'); }
            ed.choices = out;
            ed.built = mod.version;
            return out;
        };

        return ed;
    }

    /* ------------------------------------------------------------------ *
     * scale — linear mapping + nice ticks
     * ------------------------------------------------------------------ */
    var scale = PVX.scale = {};

    scale.linear = function (d0, d1, r0, r1) {
        var span = (d1 - d0) || 1;
        var f = function (v) {
            return r0 + ((util.num(v) - d0) / span) * (r1 - r0);
        };
        f.invert = function (p) { return d0 + ((p - r0) / ((r1 - r0) || 1)) * span; };
        f.domain = [d0, d1];
        f.range = [r0, r1];
        f.clamped = function (v) {
            return util.clamp(f(v), Math.min(r0, r1), Math.max(r0, r1));
        };
        return f;
    };

    /** Round a domain outward to human-friendly bounds. */
    scale.niceDomain = function (min, max, tickCount) {
        if (!util.isNum(min) || !util.isNum(max)) { return [0, 1]; }
        if (min === max) {
            var pad2 = Math.abs(min) * 0.1 || 1;
            min -= pad2; max += pad2;
        }
        var step = scale.tickStep(min, max, tickCount || 5);
        return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
    };

    scale.tickStep = function (min, max, count) {
        var raw = (max - min) / Math.max(1, count || 5);
        if (!(raw > 0)) { return 1; }
        var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
        var norm = raw / mag;
        var step;
        if (norm >= 7.5) { step = 10; }
        else if (norm >= 3.5) { step = 5; }
        else if (norm >= 1.5) { step = 2; }
        else { step = 1; }
        return step * mag;
    };

    scale.ticks = function (min, max, count) {
        var step = scale.tickStep(min, max, count);
        var out = [];
        var start = Math.ceil(min / step) * step;
        // Guard against pathological loops on degenerate domains.
        for (var v = start, guard = 0; v <= max + step * 1e-6 && guard < 500; v += step, guard++) {
            out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
        }
        return out;
    };

    /* ------------------------------------------------------------------ *
     * svg — element + path construction
     * ------------------------------------------------------------------ */
    var svg = PVX.svg = {};

    svg.el = function (name, attrs, parent) {
        var e = root.document.createElementNS(PVX.SVG_NS, name);
        if (attrs) {
            for (var k in attrs) {
                if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
                    e.setAttribute(k, attrs[k]);
                }
            }
        }
        if (parent) { parent.appendChild(e); }
        return e;
    };

    svg.clear = function (node) {
        if (!node) { return; }
        while (node.firstChild) { node.removeChild(node.firstChild); }
    };

    svg.text = function (parent, x, y, str, attrs) {
        var a = attrs || {};
        a.x = x; a.y = y;
        var t = svg.el('text', a, parent);
        t.textContent = str === null || str === undefined ? '' : String(str);
        return t;
    };

    /** Point on a circle. Angles in degrees, 0 = 12 o'clock, increasing clockwise. */
    svg.polar = function (cx, cy, r, angleDeg) {
        var rad = (angleDeg - 90) * Math.PI / 180;
        return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
    };

    /** Stroked arc path (no fill). */
    svg.arc = function (cx, cy, r, startDeg, endDeg) {
        var sweep = endDeg - startDeg;
        if (Math.abs(sweep) < 0.01) { return ''; }
        if (Math.abs(sweep) >= 359.99) { endDeg = startDeg + (sweep > 0 ? 359.99 : -359.99); }
        var s = svg.polar(cx, cy, r, startDeg);
        var e = svg.polar(cx, cy, r, endDeg);
        var large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
        var dir = endDeg > startDeg ? 1 : 0;
        return 'M' + s.x.toFixed(2) + ' ' + s.y.toFixed(2) +
               ' A' + r.toFixed(2) + ' ' + r.toFixed(2) + ' 0 ' + large + ' ' + dir + ' ' +
               e.x.toFixed(2) + ' ' + e.y.toFixed(2);
    };

    /** Filled annulus segment — used for gauge threshold bands. */
    svg.annulus = function (cx, cy, rInner, rOuter, startDeg, endDeg) {
        if (Math.abs(endDeg - startDeg) < 0.01) { return ''; }
        var large = Math.abs(endDeg - startDeg) > 180 ? 1 : 0;
        var o1 = svg.polar(cx, cy, rOuter, startDeg);
        var o2 = svg.polar(cx, cy, rOuter, endDeg);
        var i2 = svg.polar(cx, cy, rInner, endDeg);
        var i1 = svg.polar(cx, cy, rInner, startDeg);
        return 'M' + o1.x.toFixed(2) + ' ' + o1.y.toFixed(2) +
               ' A' + rOuter.toFixed(2) + ' ' + rOuter.toFixed(2) + ' 0 ' + large + ' 1 ' + o2.x.toFixed(2) + ' ' + o2.y.toFixed(2) +
               ' L' + i2.x.toFixed(2) + ' ' + i2.y.toFixed(2) +
               ' A' + rInner.toFixed(2) + ' ' + rInner.toFixed(2) + ' 0 ' + large + ' 0 ' + i1.x.toFixed(2) + ' ' + i1.y.toFixed(2) +
               ' Z';
    };

    svg.roundRect = function (x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        if (!(r > 0)) { return 'M' + x + ' ' + y + ' h' + w + ' v' + h + ' h' + (-w) + ' Z'; }
        return 'M' + (x + r) + ' ' + y +
               ' h' + (w - 2 * r) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + r +
               ' v' + (h - 2 * r) + ' a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + r +
               ' h' + (-(w - 2 * r)) + ' a' + r + ' ' + r + ' 0 0 1 ' + (-r) + ' ' + (-r) +
               ' v' + (-(h - 2 * r)) + ' a' + r + ' ' + r + ' 0 0 1 ' + r + ' ' + (-r) + ' Z';
    };

    /** Polyline / smoothed line through [{x,y}] points. */
    svg.line = function (points, smooth) {
        if (!points || !points.length) { return ''; }
        var d = 'M' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2);
        if (!smooth || points.length < 3) {
            for (var i = 1; i < points.length; i++) {
                d += ' L' + points[i].x.toFixed(2) + ' ' + points[i].y.toFixed(2);
            }
            return d;
        }
        // Catmull-Rom -> cubic Bezier, tension 0.5
        for (var j = 0; j < points.length - 1; j++) {
            var p0 = points[j > 0 ? j - 1 : 0];
            var p1 = points[j];
            var p2 = points[j + 1];
            var p3 = points[j + 2 < points.length ? j + 2 : points.length - 1];
            var c1x = p1.x + (p2.x - p0.x) / 6;
            var c1y = p1.y + (p2.y - p0.y) / 6;
            var c2x = p2.x - (p3.x - p1.x) / 6;
            var c2y = p2.y - (p3.y - p1.y) / 6;
            d += ' C' + c1x.toFixed(2) + ' ' + c1y.toFixed(2) + ',' +
                        c2x.toFixed(2) + ' ' + c2y.toFixed(2) + ',' +
                        p2.x.toFixed(2) + ' ' + p2.y.toFixed(2);
        }
        return d;
    };

    /** Step-after line — correct rendering for PI compressed/stepped tags. */
    svg.stepLine = function (points) {
        if (!points || !points.length) { return ''; }
        var d = 'M' + points[0].x.toFixed(2) + ' ' + points[0].y.toFixed(2);
        for (var i = 1; i < points.length; i++) {
            d += ' L' + points[i].x.toFixed(2) + ' ' + points[i - 1].y.toFixed(2) +
                 ' L' + points[i].x.toFixed(2) + ' ' + points[i].y.toFixed(2);
        }
        return d;
    };

    svg.area = function (points, baselineY, smooth) {
        if (!points || !points.length) { return ''; }
        var d = svg.line(points, smooth);
        return d + ' L' + points[points.length - 1].x.toFixed(2) + ' ' + baselineY.toFixed(2) +
                   ' L' + points[0].x.toFixed(2) + ' ' + baselineY.toFixed(2) + ' Z';
    };

    /* ------------------------------------------------------------------ *
     * data — normalizers for each PI Vision DataShape
     * ------------------------------------------------------------------ *
     * PI Vision's payload shapes differ between releases in small ways (extra
     * fields, occasional casing). These functions absorb that so symbol code
     * only ever deals with one predictable structure.
     */
    var data = PVX.data = {};

    var pick = function (obj, names) {
        for (var i = 0; i < names.length; i++) {
            if (obj && obj[names[i]] !== undefined && obj[names[i]] !== null) { return obj[names[i]]; }
        }
        return undefined;
    };

    /** DataShape 'Value' / 'Gauge' -> {value, raw, time, label, units, path, good} */
    data.single = function (d) {
        if (!d) { return null; }
        var raw = pick(d, ['Value', 'value']);
        return {
            raw: raw,
            value: util.num(raw),
            time: pick(d, ['Time', 'time']),
            label: pick(d, ['Label', 'label']) || '',
            units: pick(d, ['Units', 'units']) || '',
            path: pick(d, ['Path', 'path']) || '',
            indicator: util.num(pick(d, ['Indicator'])),
            startIndicator: util.num(pick(d, ['StartIndicator'])),
            scaleLabels: pick(d, ['ValueScaleLabels']) || null,
            good: d.IsGood !== false,
            errorCode: d.ErrorCode,
            errorDescription: d.ErrorDescription || ''
        };
    };

    /**
     * DataShape 'TimeSeries' -> [{label, units, path, good, points:[{t,v,time}]}]
     * Also accepts a bare array (some releases hand the array directly).
     */
    data.series = function (d) {
        if (!d) { return []; }
        var items = d.Data || d.data || (Object.prototype.toString.call(d) === '[object Array]' ? d : null);
        if (!items) { return []; }
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            var vals = it.Value || it.Values || it.value || [];
            var pts = [];
            for (var j = 0; j < vals.length; j++) {
                var p = vals[j];
                if (p === null || p === undefined) { continue; }
                var v = util.num(pick(p, ['Value', 'value', 'Y', 'y']));
                if (v === null) { continue; }
                var tRaw = pick(p, ['Time', 'time', 'X', 'x']);
                var dt = fmt.toDate(tRaw);
                pts.push({ v: v, t: dt ? dt.getTime() : j, time: tRaw, date: dt });
            }
            pts.sort(function (a, b) { return a.t - b.t; });
            out.push({
                label: pick(it, ['Label', 'label']) || ('Series ' + (i + 1)),
                units: pick(it, ['Units', 'units']) || '',
                path: pick(it, ['Path', 'path']) || '',
                good: it.IsGood !== false,
                errorDescription: it.ErrorDescription || '',
                points: pts
            });
        }
        return out;
    };

    /**
     * DataShape 'TimeSeries' for DIGITAL tags -> the same series structure, but
     * every sample keeps its raw value and nothing is dropped for being
     * non-numeric.
     *
     * data.series() exists to feed charts, so it discards anything that is not a
     * number — which silently empties a digital tag whose values are "Running" /
     * "Stopped". Symbols that reason about state (time-in-state, annunciators)
     * need the strings, so they use this instead.
     *
     * Pair it with DataQueryMode 'ModeEvents': PI Vision then returns the actual
     * transitions rather than an interpolated sample grid, which is what makes
     * duration arithmetic correct instead of approximate.
     */
    data.stateSeries = function (d) {
        if (!d) { return []; }
        var items = d.Data || d.data || (Object.prototype.toString.call(d) === '[object Array]' ? d : null);
        if (!items) { return []; }
        var out = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            var vals = it.Value || it.Values || it.value || [];
            var pts = [];
            for (var j = 0; j < vals.length; j++) {
                var p = vals[j];
                if (p === null || p === undefined) { continue; }
                var raw = pick(p, ['Value', 'value']);
                if (raw === null || raw === undefined || raw === '') { continue; }
                // PI digital states sometimes arrive as {Name, Value} objects.
                if (typeof raw === 'object') {
                    raw = pick(raw, ['Name', 'name', 'Value', 'value']);
                }
                var dt = fmt.toDate(pick(p, ['Time', 'time']));
                pts.push({
                    t: dt ? dt.getTime() : j,
                    date: dt,
                    time: pick(p, ['Time', 'time']),
                    raw: raw,
                    state: String(raw),
                    v: util.num(raw),
                    good: p.IsGood !== false
                });
            }
            pts.sort(function (a, b) { return a.t - b.t; });
            out.push({
                label: pick(it, ['Label', 'label']) || ('Series ' + (i + 1)),
                units: pick(it, ['Units', 'units']) || '',
                path: pick(it, ['Path', 'path']) || '',
                good: it.IsGood !== false,
                errorDescription: it.ErrorDescription || '',
                points: pts
            });
        }
        return out;
    };

    /**
     * Collapse a state series into contiguous runs clipped to [fromMs, toMs].
     * Returns [{state, from, to, duration}] plus a per-state total.
     *
     * The last sample runs to the end of the window rather than to itself —
     * a tag that has been "Running" for six hours has no further events, and
     * dropping the tail would report zero run time for a healthy asset.
     */
    data.stateRuns = function (points, fromMs, toMs) {
        var runs = [];
        var totals = {};
        var order = [];
        if (!points || !points.length) { return { runs: runs, totals: totals, order: order, span: 0 }; }

        var start = util.isNum(fromMs) ? fromMs : points[0].t;
        var end = util.isNum(toMs) ? toMs : points[points.length - 1].t;
        if (!(end > start)) { end = start + 1; }

        for (var i = 0; i < points.length; i++) {
            var from = Math.max(points[i].t, start);
            var to = (i + 1 < points.length) ? Math.min(points[i + 1].t, end) : end;
            if (to <= from) { continue; }
            var st = points[i].state;
            runs.push({ state: st, raw: points[i].raw, from: from, to: to, duration: to - from, good: points[i].good });
            if (totals[st] === undefined) { totals[st] = 0; order.push(st); }
            totals[st] += (to - from);
        }
        return { runs: runs, totals: totals, order: order, span: end - start };
    };

    /**
     * DataShape 'Table' -> [{label, units, path, value, good, summary:{}, trend:[]}]
     * `Summary` arrives positionally, matching config.Columns order.
     */
    data.rows = function (d, columns) {
        if (!d) { return []; }
        var rows = d.Rows || d.rows || (Object.prototype.toString.call(d) === '[object Array]' ? d : null);
        if (!rows) { return []; }
        var cols = columns || ['Value'];
        var out = [];
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i] || {};
            var summary = {};
            var sArr = r.Summary || r.summary || [];
            for (var c = 0; c < cols.length; c++) {
                var cell = sArr[c];
                var cv = (cell && typeof cell === 'object') ? pick(cell, ['Value', 'value']) : cell;
                summary[cols[c]] = { raw: cv, value: util.num(cv) };
            }
            var rawVal = pick(r, ['Value', 'value']);
            if (rawVal === undefined && summary.Value) { rawVal = summary.Value.raw; }
            out.push({
                label: pick(r, ['Label', 'label']) || ('Row ' + (i + 1)),
                units: pick(r, ['Units', 'units']) || '',
                path: pick(r, ['Path', 'path']) || '',
                time: pick(r, ['Time', 'time']),
                raw: rawVal,
                value: util.num(rawVal),
                good: r.IsGood !== false,
                errorDescription: r.ErrorDescription || '',
                summary: summary,
                trend: r.Trend || r.trend || []
            });
        }
        return out;
    };

    /** DataShape 'Trend' -> {startTime, endTime, traces:[{label, units, segments}]} */
    data.trend = function (d) {
        if (!d) { return { traces: [] }; }
        return {
            startTime: d.StartTime,
            endTime: d.EndTime,
            duration: d.Duration,
            valueScaleLabels: d.ValueScaleLabels || [],
            timeScaleLabels: d.TimeScaleLabels || [],
            traces: (d.Traces || []).map(function (t, i) {
                return {
                    label: t.Label || ('Trace ' + (i + 1)),
                    units: t.Units || '',
                    path: t.Path || '',
                    value: util.num(t.Value),
                    stepped: !!t.Stepped,
                    segments: t.LineSegments || [],
                    errorMarkers: t.ErrorMarkers || []
                };
            })
        };
    };

    /** Min / max / avg / first / last over normalized points. */
    data.stats = function (points) {
        var s = { count: 0, min: null, max: null, avg: null, first: null, last: null, sum: 0, range: null };
        if (!points || !points.length) { return s; }
        for (var i = 0; i < points.length; i++) {
            var v = points[i].v;
            if (v === null) { continue; }
            if (s.count === 0) { s.min = v; s.max = v; s.first = v; }
            if (v < s.min) { s.min = v; }
            if (v > s.max) { s.max = v; }
            s.last = v;
            s.sum += v;
            s.count += 1;
        }
        if (s.count) {
            s.avg = s.sum / s.count;
            s.range = s.max - s.min;
        }
        return s;
    };

    /* ------------------------------------------------------------------ *
     * stats — analytics used by the chart symbols
     * ------------------------------------------------------------------ */
    var stats = PVX.stats = {};

    /** Ordinary least squares over [{x,y}]. Returns slope/intercept/r2 or null. */
    stats.linreg = function (pts) {
        if (!pts || pts.length < 2) { return null; }
        var n = 0, sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
        for (var i = 0; i < pts.length; i++) {
            var x = util.num(pts[i].x), y = util.num(pts[i].y);
            if (x === null || y === null) { continue; }
            n++; sx += x; sy += y; sxy += x * y; sxx += x * x; syy += y * y;
        }
        if (n < 2) { return null; }
        var denom = (n * sxx - sx * sx);
        if (Math.abs(denom) < 1e-12) { return null; }
        var slope = (n * sxy - sx * sy) / denom;
        var intercept = (sy - slope * sx) / n;
        var rDen = Math.sqrt(denom * (n * syy - sy * sy));
        var r = Math.abs(rDen) < 1e-12 ? 0 : (n * sxy - sx * sy) / rDen;
        return { slope: slope, intercept: intercept, r: r, r2: r * r, n: n };
    };

    /** Simple moving average over normalized points. */
    stats.sma = function (points, window) {
        var w = Math.max(1, parseInt(window, 10) || 1);
        var out = [], sum = 0, q = [];
        for (var i = 0; i < points.length; i++) {
            q.push(points[i].v);
            sum += points[i].v;
            if (q.length > w) { sum -= q.shift(); }
            out.push({ t: points[i].t, v: sum / q.length, date: points[i].date });
        }
        return out;
    };

    /** Percentile (linear interpolation) over an array of numbers. */
    stats.percentile = function (values, p) {
        var v = (values || []).filter(util.isNum).sort(function (a, b) { return a - b; });
        if (!v.length) { return null; }
        var idx = util.clamp(p, 0, 1) * (v.length - 1);
        var lo = Math.floor(idx), hi = Math.ceil(idx);
        return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
    };

    /** Direction + magnitude of change, used by KPI cards. */
    stats.delta = function (points, lookbackFraction) {
        if (!points || points.length < 2) { return null; }
        var frac = util.clamp(lookbackFraction || 0.25, 0.02, 1);
        var idx = Math.max(0, Math.floor(points.length * (1 - frac)) - 1);
        var base = points[idx].v;
        var last = points[points.length - 1].v;
        if (base === null || last === null) { return null; }
        var abs = last - base;
        return {
            absolute: abs,
            percent: Math.abs(base) > 1e-12 ? (abs / Math.abs(base)) * 100 : null,
            direction: abs > 0 ? 1 : (abs < 0 ? -1 : 0),
            from: base,
            to: last
        };
    };

    /** Sorted copy of the finite numbers in `values`. Cheap to reuse. */
    stats.sorted = function (values) {
        return (values || []).filter(util.isNum).sort(function (a, b) { return a - b; });
    };

    stats.mean = function (values) {
        var n = 0, sum = 0;
        for (var i = 0; i < (values || []).length; i++) {
            if (util.isNum(values[i])) { sum += values[i]; n++; }
        }
        return n ? sum / n : null;
    };

    /**
     * Standard deviation. `sample` true divides by n-1 (Bessel's correction),
     * which is what capability indices and control limits expect; false gives
     * the population figure.
     */
    stats.stddev = function (values, sample) {
        var v = (values || []).filter(util.isNum);
        if (v.length < 2) { return v.length ? 0 : null; }
        var mu = stats.mean(v);
        var ss = 0;
        for (var i = 0; i < v.length; i++) { ss += (v[i] - mu) * (v[i] - mu); }
        return Math.sqrt(ss / (sample === false ? v.length : v.length - 1));
    };

    /**
     * Five-number summary plus Tukey fences and outliers.
     * @param {Array} values
     * @param {Object} opts {whisker:'tukey'|'percentile'|'minmax', k:1.5, lowP:0.05, highP:0.95}
     */
    stats.quartiles = function (values, opts) {
        opts = opts || {};
        var v = stats.sorted(values);
        if (!v.length) { return null; }

        var at = function (p) {
            var idx = util.clamp(p, 0, 1) * (v.length - 1);
            var lo = Math.floor(idx), hi = Math.ceil(idx);
            return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
        };

        var q1 = at(0.25), median = at(0.5), q3 = at(0.75);
        var iqr = q3 - q1;
        var mode = opts.whisker || 'tukey';
        var lower, upper;

        if (mode === 'minmax') {
            lower = v[0];
            upper = v[v.length - 1];
        } else if (mode === 'percentile') {
            lower = at(opts.lowP === undefined ? 0.05 : opts.lowP);
            upper = at(opts.highP === undefined ? 0.95 : opts.highP);
        } else {
            // Tukey: the whisker stops at the most extreme value still INSIDE the
            // fence, not at the fence itself — otherwise it draws past the data.
            var k = opts.k === undefined ? 1.5 : opts.k;
            var loFence = q1 - k * iqr, hiFence = q3 + k * iqr;
            lower = v[0]; upper = v[v.length - 1];
            for (var a = 0; a < v.length; a++) { if (v[a] >= loFence) { lower = v[a]; break; } }
            for (var b = v.length - 1; b >= 0; b--) { if (v[b] <= hiFence) { upper = v[b]; break; } }
        }

        var outliers = [];
        for (var i = 0; i < v.length; i++) {
            if (v[i] < lower || v[i] > upper) { outliers.push(v[i]); }
        }

        return {
            min: v[0], max: v[v.length - 1],
            q1: q1, median: median, q3: q3, iqr: iqr,
            lower: lower, upper: upper,
            mean: stats.mean(v),
            sd: stats.stddev(v),
            n: v.length,
            outliers: outliers
        };
    };

    /**
     * Frequency bins.
     * @param {Array} values
     * @param {Object} opts {bins:number|'auto', min, max, width}
     * @returns {Object} {bins:[{from,to,mid,count,fraction}], min, max, width, n, mode}
     *
     * 'auto' uses the Freedman-Diaconis rule, falling back to Sturges when the
     * IQR is zero — FD is robust to the outliers that PI data is full of, but
     * degenerates on a near-constant tag.
     */
    stats.histogram = function (values, opts) {
        opts = opts || {};
        var v = stats.sorted(values);
        if (!v.length) { return { bins: [], n: 0, min: null, max: null, width: 0, mode: null }; }

        var lo = util.isNum(util.num(opts.min)) ? util.num(opts.min) : v[0];
        var hi = util.isNum(util.num(opts.max)) ? util.num(opts.max) : v[v.length - 1];
        if (!(hi > lo)) { hi = lo + (Math.abs(lo) * 0.01 || 1); }

        var count;
        if (util.isNum(util.num(opts.width)) && util.num(opts.width) > 0) {
            count = Math.ceil((hi - lo) / util.num(opts.width));
        } else if (opts.bins && opts.bins !== 'auto') {
            count = parseInt(opts.bins, 10);
        } else {
            var q = stats.quartiles(v);
            var fd = q && q.iqr > 0 ? 2 * q.iqr / Math.pow(v.length, 1 / 3) : 0;
            count = fd > 0 ? Math.ceil((hi - lo) / fd) : Math.ceil(Math.log(v.length) / Math.LN2) + 1;
        }
        count = util.clamp(parseInt(count, 10) || 10, 1, 200);

        var width = (hi - lo) / count;
        var bins = [];
        for (var b = 0; b < count; b++) {
            bins.push({ from: lo + b * width, to: lo + (b + 1) * width, mid: lo + (b + 0.5) * width, count: 0, fraction: 0 });
        }
        for (var i = 0; i < v.length; i++) {
            if (v[i] < lo || v[i] > hi) { continue; }
            // The last bin is closed at the top so the maximum lands somewhere.
            var idx = util.clamp(Math.floor((v[i] - lo) / width), 0, count - 1);
            bins[idx].count += 1;
        }
        var peak = 0;
        for (var k = 0; k < bins.length; k++) {
            bins[k].fraction = bins[k].count / v.length;
            if (bins[k].count > peak) { peak = bins[k].count; }
        }
        return { bins: bins, n: v.length, min: lo, max: hi, width: width, peak: peak };
    };

    /** Normal probability density — used to overlay a fitted curve on a histogram. */
    stats.normalPdf = function (x, mu, sigma) {
        if (!(sigma > 0)) { return 0; }
        var z = (x - mu) / sigma;
        return Math.exp(-0.5 * z * z) / (sigma * Math.sqrt(2 * Math.PI));
    };

    /** Standard normal CDF via an Abramowitz & Stegun erf approximation. */
    stats.normalCdf = function (z) {
        var s = z < 0 ? -1 : 1;
        var x = Math.abs(z) / Math.sqrt(2);
        var t = 1 / (1 + 0.3275911 * x);
        var y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
        return 0.5 * (1 + s * y);
    };

    /**
     * Process capability. Returns null unless at least one spec limit is given.
     *
     * Cp/Cpk conventionally use a within-subgroup sigma; PI hands us a single
     * time-ordered stream with no subgroups, so this uses the overall sample
     * standard deviation for both. That makes Cp equal to Pp and Cpk equal to
     * Ppk — reported honestly rather than inventing subgroups that do not
     * exist. Both names are returned so either convention reads correctly.
     */
    stats.capability = function (values, lsl, usl) {
        var v = (values || []).filter(util.isNum);
        var lo = util.num(lsl), hi = util.num(usl);
        if (v.length < 2 || (lo === null && hi === null)) { return null; }

        var mu = stats.mean(v);
        var sd = stats.stddev(v);
        if (!(sd > 0)) { return { mean: mu, sd: 0, degenerate: true, lsl: lo, usl: hi, n: v.length }; }

        var out = { mean: mu, sd: sd, n: v.length, lsl: lo, usl: hi, degenerate: false };

        if (lo !== null && hi !== null) {
            out.cp = (hi - lo) / (6 * sd);
            out.cpu = (hi - mu) / (3 * sd);
            out.cpl = (mu - lo) / (3 * sd);
            out.cpk = Math.min(out.cpu, out.cpl);
        } else if (hi !== null) {
            out.cpu = (hi - mu) / (3 * sd);
            out.cpk = out.cpu;
        } else {
            out.cpl = (mu - lo) / (3 * sd);
            out.cpk = out.cpl;
        }
        out.pp = out.cp;
        out.ppk = out.cpk;

        // Observed rather than predicted: what the data actually did.
        var below = 0, above = 0;
        for (var i = 0; i < v.length; i++) {
            if (lo !== null && v[i] < lo) { below++; }
            if (hi !== null && v[i] > hi) { above++; }
        }
        out.countBelow = below;
        out.countAbove = above;
        out.percentOut = ((below + above) / v.length) * 100;

        // Predicted from the fitted normal, which is the figure quality staff
        // usually quote as ppm defective.
        var pLo = lo !== null ? stats.normalCdf((lo - mu) / sd) : 0;
        var pHi = hi !== null ? 1 - stats.normalCdf((hi - mu) / sd) : 0;
        out.ppmExpected = (pLo + pHi) * 1e6;
        return out;
    };

    /* ------------------------------------------------------------------ *
     * nav — display navigation via PI Vision URL contract
     * ------------------------------------------------------------------ *
     * PI Vision's display URLs are a stable public contract across releases:
     *   /PIVision/#/Displays/<id>/<slug>?asset=<AF path>&starttime=*-8h&endtime=*&mode=kiosk
     * Driving navigation through the URL avoids depending on private internal
     * Angular services that change between versions.
     */
    var nav = PVX.nav = {};

    nav.currentUrl = function () {
        try { return root.location.href; } catch (e) { return ''; }
    };

    nav.parseHash = function (href) {
        var url = href || nav.currentUrl();
        var hashIdx = url.indexOf('#');
        var hash = hashIdx === -1 ? '' : url.slice(hashIdx + 1);
        var qIdx = hash.indexOf('?');
        var path = qIdx === -1 ? hash : hash.slice(0, qIdx);
        var query = qIdx === -1 ? '' : hash.slice(qIdx + 1);
        var params = {};
        query.split('&').forEach(function (kv) {
            if (!kv) { return; }
            var eq = kv.indexOf('=');
            var k = eq === -1 ? kv : kv.slice(0, eq);
            var v = eq === -1 ? '' : kv.slice(eq + 1);
            try { params[decodeURIComponent(k)] = decodeURIComponent(v); }
            catch (e) { params[k] = v; }
        });
        return { base: hashIdx === -1 ? url : url.slice(0, hashIdx), path: path, params: params };
    };

    nav.buildHash = function (parsed) {
        var qs = [];
        for (var k in parsed.params) {
            if (Object.prototype.hasOwnProperty.call(parsed.params, k)) {
                var v = parsed.params[k];
                if (v === null || v === undefined || v === '') { continue; }
                qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
            }
        }
        return parsed.base + '#' + parsed.path + (qs.length ? '?' + qs.join('&') : '');
    };

    /**
     * Build a target URL.
     * @param {Object} opts {display, asset, start, end, mode, keepAsset, keepTime, params}
     *   display — display id, id/slug, or a full URL/relative path
     */
    nav.url = function (opts) {
        opts = opts || {};
        var cur = nav.parseHash();
        var path = cur.path;
        var params = {};

        if (opts.keepAsset !== false && cur.params.asset) { params.asset = cur.params.asset; }
        if (opts.keepTime !== false) {
            if (cur.params.starttime) { params.starttime = cur.params.starttime; }
            if (cur.params.endtime) { params.endtime = cur.params.endtime; }
        }
        if (cur.params.mode) { params.mode = cur.params.mode; }

        var target = opts.display;
        if (target) {
            var s = String(target).trim();
            if (/^https?:\/\//i.test(s)) { return s; }          // fully external
            if (s.indexOf('#') !== -1) { return s; }            // caller supplied a full hash URL
            path = s.charAt(0) === '/' ? s : '/Displays/' + s;
        }

        if (opts.asset !== undefined) { params.asset = opts.asset; }
        if (opts.start !== undefined) { params.starttime = opts.start; }
        if (opts.end !== undefined) { params.endtime = opts.end; }
        if (opts.mode !== undefined) { params.mode = opts.mode; }
        if (opts.params) {
            for (var k in opts.params) {
                if (Object.prototype.hasOwnProperty.call(opts.params, k)) { params[k] = opts.params[k]; }
            }
        }
        return nav.buildHash({ base: cur.base, path: path, params: params });
    };

    nav.go = function (url, newTab) {
        if (!url) { return; }
        try {
            if (newTab) {
                var w = root.open(url, '_blank');
                if (w) { w.opener = null; }
            } else {
                root.location.href = url;
                // Same-document hash changes do not always retrigger the router.
                if (url.indexOf('#') !== -1 && url.split('#')[0] === nav.currentUrl().split('#')[0]) {
                    // Angular's $location picks up hashchange; nothing further required.
                }
            }
        } catch (e) { /* navigation blocked — nothing useful to do */ }
    };

    /** Apply just a time range to the current display. */
    nav.setTimeRange = function (start, end) {
        var cur = nav.parseHash();
        cur.params.starttime = start;
        cur.params.endtime = end;
        nav.go(nav.buildHash(cur), false);
    };

    /** Current asset (AF element path) driving the display, if any. */
    nav.currentAsset = function () {
        return nav.parseHash().params.asset || '';
    };

    /**
     * The AF element a data source belongs to, as PI Vision's asset= wants it.
     *   af:\\srv\db\Area\Pump 101|Flow?guid  -> \\srv\db\Area\Pump 101
     *   \\PISRV01\SINUSOID                    -> '' (a PI point has no element)
     * Drill-down used to pass the attribute's whole path as the asset. PI
     * Vision's asset parameter names an element, and nothing has shown it
     * tolerates an attribute path there, so callers pass the element.
     */
    nav.assetOf = function (path) {
        var s = String(path === null || path === undefined ? '' : path);
        var q = s.lastIndexOf('?');
        if (q > 0) { s = s.slice(0, q); }
        s = s.replace(/^[a-z]+:/i, '');
        var bar = s.indexOf('|');
        return bar === -1 ? '' : s.slice(0, bar);
    };

    /** Parent of an element path, or '' at the database root. */
    nav.parentOf = function (elementPath) {
        var s = String(elementPath || '').replace(/[\\]+$/, '');
        var segs = nav.segments(s);
        if (segs.elements.length < 2) { return ''; }
        return segs.prefix + segs.elements.slice(0, -1).join('\\');
    };

    /**
     * Split \\server\database\A\B\C into its parts. `prefix` is
     * "\\server\database\", and `elements` are the element names from the
     * top of the database down, so elements.slice(0, n) is the n-th ancestor.
     */
    nav.segments = function (elementPath) {
        var s = String(elementPath || '').replace(/^[a-z]+:/i, '');
        var m = /^(\\\\[^\\]+\\[^\\]+\\?)(.*)$/.exec(s);
        if (!m) { return { prefix: '', elements: s ? s.split('\\').filter(function (x) { return !!x; }) : [] }; }
        var prefix = m[1].charAt(m[1].length - 1) === '\\' ? m[1] : m[1] + '\\';
        return { prefix: prefix, elements: m[2] ? m[2].split('\\').filter(function (x) { return !!x; }) : [] };
    };

    /* ------------------------------------------------------------------ *
     * layout — resize plumbing shared by every symbol
     * ------------------------------------------------------------------ */
    var layout = PVX.layout = {};

    /**
     * Standard render loop. Symbols call PVX.layout.renderer(fn) and get back an
     * object with .request() (coalesced to one animation frame) so data updates,
     * config changes and resizes never triple-render the same frame.
     */
    layout.renderer = function (renderFn) {
        var pending = false;
        var destroyed = false;
        var raf = root.requestAnimationFrame || function (cb) { return setTimeout(cb, 16); };
        var caf = root.cancelAnimationFrame || clearTimeout;
        var handle = null;
        return {
            request: function () {
                if (destroyed || pending) { return; }
                pending = true;
                handle = raf(function () {
                    pending = false;
                    if (destroyed) { return; }
                    try { renderFn(); }
                    catch (e) {
                        if (root.console && root.console.error) { root.console.error('[PVX] render failed', e); }
                    }
                });
            },
            flush: function () {
                if (destroyed) { return; }
                pending = false;
                try { renderFn(); } catch (e) { /* swallow */ }
            },
            destroy: function () {
                destroyed = true;
                if (handle) { caf(handle); }
            }
        };
    };

    /** Font size that fits `text` into `width` px at the given aspect heuristic. */
    layout.fitFont = function (text, width, height, maxPx, minPx) {
        var len = Math.max(1, String(text === null || text === undefined ? '' : text).length);
        var byWidth = width / (len * 0.62);
        var byHeight = height;
        return util.clamp(Math.floor(Math.min(byWidth, byHeight)), minPx || 9, maxPx || 96);
    };

    /* ------------------------------------------------------------------ *
     * text — one text size control for every symbol
     * ------------------------------------------------------------------ *
     * Symbols size text three ways (stylesheet px, inline styles written
     * while rendering, SVG font-size attributes), and most then lay out
     * around it: axis margins, legend rows, truncation. Scaling the text
     * after layout made labels overlap the chart they belong to, so the
     * control zooms the symbol's contents instead: CSS zoom on the .pvx
     * root. The root still fills the symbol (a percentage size is not
     * zoomed), but its contents lay out in CSS px that are k screen px
     * each, so the host the symbol measures reports 1/k of its on-screen
     * size, the symbol lays out for that, and everything it draws, text
     * included, comes out k times larger and still fits. Sizing the root
     * to 100/k % as well was tried and double-counts. A browser without
     * CSS zoom ignores the setting and the symbol draws as before.
     */
    var text = PVX.text = {};

    /** config.TextScale (percent) as a factor, clamped to 50%..300%. */
    text.scaleOf = function (cfg) {
        var n = util.num(cfg && cfg.TextScale);
        if (n === null || n <= 0) { return 1; }
        return util.clamp(n / 100, 0.5, 3);
    };

    /** Apply factor k to a symbol's root. Writes only when it changes. */
    text.apply = function (rootNode, k) {
        if (!rootNode || !rootNode.style) { return; }
        if (rootNode.__pvxZoom === k) { return; }
        if (rootNode.__pvxZoom === undefined && k === 1) { rootNode.__pvxZoom = 1; return; }
        rootNode.__pvxZoom = k;
        rootNode.style.zoom = k === 1 ? '' : String(k);
    };

    /* ------------------------------------------------------------------ *
     * config — helpers for the configuration pane
     * ------------------------------------------------------------------ */
    var config = PVX.config = {};

    /** Shared defaults every PVX symbol inherits. Merge into getDefaultConfig(). */
    config.base = function (extra) {
        var base = {
            Theme: 'auto',              // auto | light | dark
            Transparent: false,
            // Empty means "follow the theme". theme.resolve always honoured it,
            // but no pane offered it until operators on a live server asked for
            // it first: matching a display's look is not optional for them.
            BackgroundColor: '',
            // Percent, as a string because the pane picks it with a plain
            // <select>. Applied by PVX.bootstrap to every symbol: see text.
            TextScale: '100',
            ShowLabel: true,
            ShowUnits: true,
            ShowTime: false,
            Decimals: 'auto',
            CompactNumbers: false,
            Thresholds: thresholds.DEFAULT,
            UseThresholds: true,
            AccentColor: '#3b82c4',
            CornerRadius: 6
        };
        if (extra) {
            for (var k in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, k)) { base[k] = extra[k]; }
            }
        }
        return base;
    };

    /**
     * Fill in any config keys added by a newer version of a symbol so displays
     * saved by an older version keep working. Call from loadConfig().
     */
    config.upgrade = function (saved, defaults) {
        saved = saved || {};
        for (var k in defaults) {
            if (Object.prototype.hasOwnProperty.call(defaults, k) && saved[k] === undefined) {
                saved[k] = defaults[k];
            }
        }
        return saved;
    };

    /* ---- Table statistic selection ---------------------------------------- *
     * Every Table-shape symbol that lets the operator pick an aggregate faces
     * the same trap: PI Vision returns Summary cells POSITIONALLY, matching
     * config.Columns. If the chosen statistic and that array drift apart, the
     * symbol silently charts the wrong number — no error, just wrong. One
     * implementation here means one place that can be wrong, and it is tested.
     */
    config.TABLE_STATS = {
        Value:   { column: 'Value',   label: 'Value' },
        Average: { column: 'Average', label: 'Average' },
        Minimum: { column: 'Minimum', label: 'Minimum' },
        Maximum: { column: 'Maximum', label: 'Maximum' },
        Range:   { column: 'Range',   label: 'Range' },
        StdDev:  { column: 'StdDev',  label: 'Std deviation' },
        Total:   { column: 'Total',   label: 'Total' }
    };

    /** Chosen statistic key, defaulted defensively — configs are user-editable. */
    config.statKey = function (cfg) {
        var k = cfg && cfg.Statistic;
        return Object.prototype.hasOwnProperty.call(config.TABLE_STATS, k) ? k : 'Value';
    };

    config.statLabel = function (cfg) { return config.TABLE_STATS[config.statKey(cfg)].label; };

    /** Exactly one column is ever requested, so the cell we want is always [0]. */
    config.statColumns = function (cfg) { return [config.TABLE_STATS[config.statKey(cfg)].column]; };

    /**
     * Force cfg.Columns and cfg.SortColumn to agree with cfg.Statistic.
     * Returns true if anything changed, so callers can avoid writing to the
     * config — and re-triggering PI Vision's data fetch — on every render.
     *
     * Call this from onConfigChange AND from render: a display saved by an
     * older build, or with a hand-edited config, then repairs itself on load
     * instead of charting a stale aggregate.
     */
    config.syncStatColumns = function (cfg) {
        if (!cfg) { return false; }
        var want = config.statColumns(cfg);
        var changed = false;
        var cur = cfg.Columns;
        if (!cur || cur.length !== 1 || cur[0] !== want[0]) {
            cfg.Columns = want;
            changed = true;
        }
        if (cfg.SortColumn !== want[0]) {
            cfg.SortColumn = want[0];
            changed = true;
        }
        return changed;
    };

    /** Numeric value of the chosen statistic on a row from PVX.data.rows(). */
    data.statValue = function (row, cfg) {
        if (!row) { return null; }
        var col = config.statColumns(cfg)[0];
        var cell = row.summary ? row.summary[col] : null;
        if (cell && cell.value !== null && cell.value !== undefined) { return cell.value; }
        // Immediately after a statistic change the in-flight payload may still
        // carry the previous column; falling back to the row value keeps the
        // symbol drawing something sane for one refresh rather than blanking.
        return row.value;
    };

    /** Format options object shared by number-rendering symbols. */
    config.numberOpts = function (cfg) {
        return {
            decimals: cfg.Decimals,
            compact: !!cfg.CompactNumbers,
            thousands: cfg.ThousandsSeparator !== false
        };
    };

    /* ================================================================== *
     * api — PI Web API client
     * ================================================================== *
     * Everything PI Vision's DataShape mechanism cannot reach — Event Frames,
     * the AF hierarchy, writing values back — comes through here.
     *
     * WHY THIS IS IN THE CORE AND NOT IN EACH SYMBOL
     *   Authentication is a property of the DEPLOYMENT, not of a chart. A site
     *   running Kerberos today and OIDC next year should not have to touch a
     *   single symbol. So the auth strategy lives in one place, configured once
     *   per site in `ext/libraries/pvx/pvx-config.js`, and symbols only ever call
     *   PVX.api.get()/post(). None of them know or care which strategy is live.
     *
     * WHAT AVEVA RECOMMENDS, AND WHY THE DEFAULT IS WHAT IT IS
     *   AVEVA's PI Vision security guidance is Kerberos with constrained
     *   delegation between the PI Vision application servers, Data Archive and
     *   AF; Negotiate/NTLM as a fallback; Basic over TLS for mobile clients.
     *   Their guidance also assumes PI Web API sits on its own origin and tells
     *   you to list the explicit PI Vision URLs in CorsOrigins rather than '*'.
     *   So: cross-origin with credentials is the documented arrangement, and
     *   'iwa' is the default strategy.
     *
     * THE CROSS-ORIGIN + WINDOWS-AUTH TRAP
     *   A credentialed cross-origin request is preceded by an OPTIONS preflight,
     *   and the preflight is sent WITHOUT credentials by definition. If the
     *   server answers OPTIONS with a 401 auth challenge, Chrome and Firefox
     *   abandon the whole request — the symbol sees an opaque network error with
     *   nothing useful in it. PI Web API must answer the preflight anonymously.
     *   That is the single most common reason this integration "just doesn't
     *   work", so classifyError() below names it explicitly instead of
     *   reporting "failed to fetch".
     * ================================================================== */

    var api = PVX.api = {};

    /**
     * Deployment settings. Overwritten wholesale by ext/libraries/pvx/pvx-config.js at
     * load time; the values here are only a safe inert default, so a library
     * deployed without a site config does nothing rather than guessing at a
     * hostname.
     */
    api.settings = {
        baseUrl: '',              // e.g. 'https://piwebapi01.corp.example/piwebapi'
        auth: 'iwa',              // iwa | bearer | basic | anonymous
        getToken: null,           // bearer: function() -> token | Promise<token>
        basicCredentials: null,   // basic: 'user:pass' — development only
        timeoutMs: 20000,
        cacheTtlMs: 30000,
        maxBatchSize: 50,
        verifySsl: true,          // informational; the browser enforces this
        webIdVersion: null        // pin if a site needs a specific WebID scheme
    };

    /** Merge site settings without discarding keys the site did not mention. */
    api.configure = function (settings) {
        if (!settings) { return api.settings; }
        for (var k in settings) {
            if (Object.prototype.hasOwnProperty.call(settings, k)) {
                api.settings[k] = settings[k];
            }
        }
        return api.settings;
    };

    // pvx-config.js may have run first — PI Vision does not promise an order
    // within a libraries folder, and by name it sorts ahead of this file. It
    // queues its settings in that case rather than losing them; apply them now.
    if (PVX.pendingSiteSettings) {
        for (var pi = 0; pi < PVX.pendingSiteSettings.length; pi++) {
            api.configure(PVX.pendingSiteSettings[pi]);
        }
        delete PVX.pendingSiteSettings;
    }

    api.isConfigured = function () {
        return !!(api.settings.baseUrl && String(api.settings.baseUrl).trim());
    };

    /** Normalised base, no trailing slash. */
    api.base = function () {
        return String(api.settings.baseUrl || '').replace(/\/+$/, '');
    };

    /**
     * Is PI Web API on a different origin from the page? Determines whether
     * credentials mode and CORS are in play at all — and it is worth knowing,
     * because the failure modes are completely different.
     */
    api.isCrossOrigin = function () {
        var b = api.base();
        if (!b) { return false; }
        if (!/^https?:\/\//i.test(b)) { return false; }   // relative => same origin
        try {
            var a = root.document.createElement('a');
            a.href = b;
            return a.protocol !== root.location.protocol ||
                   a.hostname !== root.location.hostname ||
                   (a.port || '') !== (root.location.port || '');
        } catch (e) { return true; }
    };

    /* ---- errors ---------------------------------------------------------- */

    /**
     * Turn a failure into something an engineer can act on.
     *
     * A symbol that says "failed to fetch" has told the operator nothing and
     * sent the engineer looking in the wrong place. Each code below maps to one
     * specific thing to go and check.
     */
    function classifyError(status, err, crossOrigin) {
        if (status === 0 || status === null || status === undefined) {
            if (crossOrigin) {
                return {
                    code: 'cors-or-network',
                    message: 'Could not reach PI Web API. On a cross-origin deployment this is ' +
                             'usually the CORS preflight: PI Web API must list this PI Vision URL in ' +
                             'CorsOrigins, set CorsSupportsCredentials to true, and answer the OPTIONS ' +
                             'request without an authentication challenge.',
                    check: 'CorsOrigins / CorsSupportsCredentials / anonymous OPTIONS'
                };
            }
            return {
                code: 'network',
                message: 'Could not reach PI Web API. Check the base URL, that the service is running, ' +
                         'and that the certificate matches the hostname being used.',
                check: 'base URL / service / certificate'
            };
        }
        if (status === 401) {
            return {
                code: 'unauthorized',
                message: 'PI Web API rejected the credentials. With Windows authentication the browser ' +
                         'must be willing to send them to this host; with bearer authentication the token ' +
                         'must be valid and issued for PI Web API\'s audience.',
                check: 'authentication method / token audience'
            };
        }
        if (status === 403) {
            return {
                code: 'forbidden',
                message: 'Authenticated, but this identity is not permitted. PI and AF security are the ' +
                         'access control — check the mapping for this user on the AF database.',
                check: 'AF / Data Archive mappings'
            };
        }
        if (status === 404) {
            return { code: 'not-found', message: 'Not found. Check the path and the WebID.', check: 'path / WebID' };
        }
        if (status >= 500) {
            return { code: 'server', message: 'PI Web API returned a server error (' + status + ').', check: 'PI Web API logs' };
        }
        return {
            code: 'http-' + status,
            message: 'PI Web API returned HTTP ' + status + (err ? ' — ' + err : ''),
            check: 'request'
        };
    }

    api.classifyError = classifyError;

    /* ---- cache ----------------------------------------------------------- */
    // A display can hold a dozen symbols asking overlapping questions on the
    // same refresh tick. Without a short shared cache that is a dozen round
    // trips per tick to the same endpoints.
    var cache = {};

    api.clearCache = function () { cache = {}; };

    function cacheGet(key, ttl, nowMs) {
        var hit = cache[key];
        if (!hit) { return null; }
        if (nowMs - hit.at > ttl) { delete cache[key]; return null; }
        return hit.value;
    }

    function cacheSet(key, value, nowMs) {
        cache[key] = { at: nowMs, value: value };
    }

    /* ---- auth strategies -------------------------------------------------- */
    /**
     * Each strategy returns {headers, withCredentials}. Adding a new one — a
     * gateway that injects a header, say — means adding a case here and nothing
     * else anywhere in the library.
     */
    function applyAuth(strategy) {
        var s = api.settings;
        var mode = strategy || s.auth || 'iwa';

        if (mode === 'bearer') {
            var token = typeof s.getToken === 'function' ? s.getToken() : s.getToken;
            // A promise is legitimate here — a silent token refresh is async —
            // so resolve it before the request goes out.
            return Promise.resolve(token).then(function (t) {
                if (!t) {
                    throw { pvxError: { code: 'no-token', message: 'Bearer authentication is selected but no token was supplied. ' +
                        'Check the getToken function in pvx-config.js.', check: 'pvx-config.js getToken' } };
                }
                return { headers: { Authorization: 'Bearer ' + t }, withCredentials: false };
            });
        }
        if (mode === 'basic') {
            if (!s.basicCredentials) {
                return Promise.reject({ pvxError: { code: 'no-credentials',
                    message: 'Basic authentication is selected but no credentials were supplied.',
                    check: 'pvx-config.js basicCredentials' } });
            }
            // Deliberately not encouraged: this puts a credential in a file on
            // the web server. AVEVA permits Basic over TLS for mobile clients;
            // for a display symbol there is almost always a better option.
            return Promise.resolve({
                headers: { Authorization: 'Basic ' + root.btoa(s.basicCredentials) },
                withCredentials: false
            });
        }
        if (mode === 'anonymous') {
            return Promise.resolve({ headers: {}, withCredentials: false });
        }
        // 'iwa' — Kerberos/Negotiate, AVEVA's recommended arrangement. The
        // browser attaches the credential itself; we only have to ask for it.
        return Promise.resolve({ headers: {}, withCredentials: true });
    }

    /* ---- request ---------------------------------------------------------- */

    /**
     * @param {String} method
     * @param {String} pathOrUrl  absolute, or relative to the configured base
     * @param {Object} opts {body, headers, cache:Boolean, ttl, timeoutMs, auth}
     * @returns {Promise} resolves with parsed JSON, rejects with {pvxError}
     */
    api.request = function (method, pathOrUrl, opts) {
        opts = opts || {};
        var s = api.settings;

        if (!api.isConfigured()) {
            return Promise.reject({ pvxError: {
                code: 'not-configured',
                message: 'PI Web API is not configured for this PI Vision server. Set baseUrl in ' +
                         'ext/libraries/pvx/pvx-config.js on the PI Vision server.',
                check: 'pvx-config.js'
            } });
        }

        // An empty path means the service root. Joining it naively yields a
        // trailing slash, which most servers tolerate and some do not — so
        // build the root URL as the bare base.
        var rel = String(pathOrUrl === undefined || pathOrUrl === null ? '' : pathOrUrl).replace(/^\/+/, '');
        var url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl
                : (rel ? api.base() + '/' + rel : api.base());
        var crossOrigin = api.isCrossOrigin();
        var useCache = opts.cache !== false && String(method).toUpperCase() === 'GET';
        var ttl = opts.ttl === undefined ? s.cacheTtlMs : opts.ttl;
        var nowMs = (new Date()).getTime();
        var key = url;

        if (useCache) {
            var hit = cacheGet(key, ttl, nowMs);
            if (hit) { return Promise.resolve(hit); }
        }

        return applyAuth(opts.auth).then(function (auth) {
            return new Promise(function (resolve, reject) {
                var xhr = new root.XMLHttpRequest();
                var done = false;

                var fail = function (status, detail) {
                    if (done) { return; }
                    done = true;
                    reject({ pvxError: classifyError(status, detail, crossOrigin), status: status, url: url });
                };

                try { xhr.open(String(method).toUpperCase(), url, true); }
                catch (e) { fail(0, e.message); return; }

                // Only meaningful cross-origin, and setting it same-origin is
                // harmless — the browser sends cookies there regardless.
                xhr.withCredentials = !!auth.withCredentials;
                xhr.timeout = opts.timeoutMs || s.timeoutMs;

                xhr.setRequestHeader('Accept', 'application/json');
                if (opts.body !== undefined && opts.body !== null) {
                    xhr.setRequestHeader('Content-Type', 'application/json');
                }
                // PI Web API's CSRF guard: it accepts this header in place of a
                // token for requests it can see are script-originated.
                xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                for (var h in auth.headers) {
                    if (Object.prototype.hasOwnProperty.call(auth.headers, h)) {
                        xhr.setRequestHeader(h, auth.headers[h]);
                    }
                }
                for (var h2 in (opts.headers || {})) {
                    if (Object.prototype.hasOwnProperty.call(opts.headers, h2)) {
                        xhr.setRequestHeader(h2, opts.headers[h2]);
                    }
                }

                xhr.onload = function () {
                    if (done) { return; }
                    if (xhr.status >= 200 && xhr.status < 300) {
                        done = true;
                        var parsed = null;
                        if (xhr.responseText) {
                            try { parsed = JSON.parse(xhr.responseText); }
                            catch (e) {
                                reject({ pvxError: { code: 'bad-json',
                                    message: 'PI Web API returned a response that is not JSON. This usually means a ' +
                                             'proxy or a login page answered instead of the API.',
                                    check: 'proxy / authentication redirect' }, status: xhr.status, url: url });
                                return;
                            }
                        }
                        if (useCache) { cacheSet(key, parsed, (new Date()).getTime()); }
                        resolve(parsed);
                        return;
                    }
                    fail(xhr.status, xhr.responseText && xhr.responseText.slice(0, 200));
                };
                xhr.onerror = function () { fail(0, null); };
                xhr.ontimeout = function () {
                    if (done) { return; }
                    done = true;
                    reject({ pvxError: { code: 'timeout',
                        message: 'PI Web API did not respond within ' + (opts.timeoutMs || s.timeoutMs) + 'ms.',
                        check: 'PI Web API load / network' }, status: 0, url: url });
                };

                try { xhr.send(opts.body === undefined || opts.body === null ? null : JSON.stringify(opts.body)); }
                catch (e) { fail(0, e.message); }
            });
        });
    };

    api.get = function (path, opts) { return api.request('GET', path, opts); };
    api.post = function (path, body, opts) {
        opts = opts || {}; opts.body = body;
        return api.request('POST', path, opts);
    };
    api.put = function (path, body, opts) {
        opts = opts || {}; opts.body = body;
        return api.request('PUT', path, opts);
    };

    /**
     * PI Web API's /batch endpoint: many sub-requests, one round trip.
     *
     * A Gantt over 40 assets is 40 Event Frame queries. As 40 requests that is
     * 40 authentication handshakes and 40 CORS preflights; as one batch it is
     * one of each. Use this wherever the request count scales with the number
     * of data sources.
     *
     * @param {Object} requests {id: {Method, Resource, Content, Headers, ParentIds}}
     */
    api.batch = function (requests, opts) {
        var ids = Object.keys(requests || {});
        if (!ids.length) { return Promise.resolve({}); }

        var limit = api.settings.maxBatchSize || 50;
        if (ids.length <= limit) {
            return api.post('batch', requests, opts);
        }
        // Chunk rather than send one enormous request — PI Web API has its own
        // limits and a partial failure of a huge batch is hard to attribute.
        var chunks = [];
        for (var i = 0; i < ids.length; i += limit) {
            var chunk = {};
            ids.slice(i, i + limit).forEach(function (id) { chunk[id] = requests[id]; });
            chunks.push(chunk);
        }
        return chunks.reduce(function (chain, chunk) {
            return chain.then(function (acc) {
                return api.post('batch', chunk, opts).then(function (res) {
                    for (var k in res) {
                        if (Object.prototype.hasOwnProperty.call(res, k)) { acc[k] = res[k]; }
                    }
                    return acc;
                });
            });
        }, Promise.resolve({}));
    };

    /**
     * Pull the successful bodies out of a batch response, and report the rest.
     * PI Web API returns per-sub-request status codes; a caller that ignores
     * them silently drops the assets that failed.
     */
    api.batchResults = function (response) {
        var ok = {}, failed = {};
        for (var id in (response || {})) {
            if (!Object.prototype.hasOwnProperty.call(response, id)) { continue; }
            var r = response[id];
            if (r && r.Status >= 200 && r.Status < 300) { ok[id] = r.Content; }
            else { failed[id] = { status: r && r.Status, content: r && r.Content }; }
        }
        return { ok: ok, failed: failed, failedCount: Object.keys(failed).length };
    };

    /* ---- convenience ------------------------------------------------------ */

    /** Root document — the cheapest call there is, so it doubles as a health probe. */
    api.root = function (opts) { return api.get('', opts); };

    /** Resolve an AF path (\\SERVER\Database\Element) to an element. */
    api.elementByPath = function (afPath, opts) {
        return api.get('elements?path=' + encodeURIComponent(afPath), opts);
    };

    /** Resolve an attribute or PI point path to a data stream. */
    api.attributeByPath = function (afPath, opts) {
        return api.get('attributes?path=' + encodeURIComponent(afPath), opts);
    };

    /**
     * Event Frames overlapping a window.
     * @param {Object} q {databaseWebId, elementWebId, startTime, endTime,
     *                    templateName, nameFilter, searchMode, maxCount, selectedFields}
     */
    api.eventFrames = function (q, opts) {
        q = q || {};
        var parts = [];
        var add = function (k, v) {
            if (v === undefined || v === null || v === '') { return; }
            parts.push(k + '=' + encodeURIComponent(v));
        };
        add('startTime', q.startTime);
        add('endTime', q.endTime);
        add('templateName', q.templateName);
        add('nameFilter', q.nameFilter);
        add('referencedElementNameFilter', q.elementNameFilter);
        // 'Overlapped' is the right default: an event that started before the
        // window and is still running is exactly the one an operator cares
        // about, and the stricter modes drop it.
        add('searchMode', q.searchMode || 'Overlapped');
        add('maxCount', q.maxCount || 1000);
        add('selectedFields', q.selectedFields);
        var base = q.elementWebId
            ? 'elements/' + encodeURIComponent(q.elementWebId) + '/eventframes'
            : 'assetdatabases/' + encodeURIComponent(q.databaseWebId) + '/eventframes';
        return api.get(base + (parts.length ? '?' + parts.join('&') : ''), opts);
    };

    /** Current value of one stream. */
    api.readValue = function (webId, opts) {
        return api.get('streams/' + encodeURIComponent(webId) + '/value', opts);
    };

    /**
     * Current values of many streams in one request.
     * Prefer this over a loop: N separate calls is N authentication handshakes
     * and, cross-origin, N preflights.
     */
    api.readValues = function (webIds, opts) {
        var ids = (webIds || []).filter(function (w) { return !!w; });
        if (!ids.length) { return Promise.resolve({ Items: [] }); }
        var qs = ids.map(function (w) { return 'webId=' + encodeURIComponent(w); }).join('&');
        return api.get('streamsets/value?' + qs, opts);
    };

    /**
     * Write a single value to a stream.
     *
     * Deliberately never cached and never batched: a write is not idempotent
     * from the operator's point of view, and quietly retrying or coalescing one
     * is how a wrong number ends up in the historian. Callers that want to send
     * several values must decide that for themselves, one call at a time, and
     * report each result separately.
     *
     * The caller is also responsible for confirming the value with a human
     * before this is reached. There is no undo.
     */
    api.writeValue = function (webId, value, timestamp, opts) {
        opts = opts || {};
        opts.cache = false;
        return api.post('streams/' + encodeURIComponent(webId) + '/value',
            { Timestamp: timestamp || '*', Value: value }, opts);
    };

    /**
     * Write to several streams, sequentially, reporting each outcome.
     * Resolves with {ok:[{key,response}], failed:[{key,error}]} and NEVER
     * rejects — a shift log where three rows saved and one did not must show
     * exactly that, not a single failure that hides the three that worked.
     *
     * @param {Array} writes [{key, webId, value, timestamp}]
     */
    api.writeValues = function (writes, opts) {
        var list = writes || [];
        var ok = [], failed = [];
        return list.reduce(function (chain, w) {
            return chain.then(function () {
                return api.writeValue(w.webId, w.value, w.timestamp, opts)
                    .then(function (res) { ok.push({ key: w.key, response: res }); })
                    .catch(function (e) {
                        failed.push({ key: w.key, error: (e && e.pvxError) || { code: 'unknown', message: String(e) } });
                    });
            });
        }, Promise.resolve()).then(function () { return { ok: ok, failed: failed }; });
    };

    /* ================================================================== *
     * ack — shared alarm acknowledgement, stored in an AF attribute
     * ================================================================== *
     * pvxAnnunciator latches an alarm until someone acknowledges it. On its
     * own that state lives in one browser tab, which means an alarm
     * acknowledged by the day shift is still flashing on the panel next door
     * and returns from the dead when anyone reopens the display. For a panel
     * a crew is supposed to trust, acknowledgement has to be shared.
     *
     * STORAGE
     *   One AF attribute of type String holds a JSON map:
     *       { "<key>": { "at": <epoch ms>, "by": "<who>", "st": "<state>" } }
     *   A single attribute rather than one per alarm: an annunciator covers
     *   dozens of tags, and dozens of attributes to provision is a barrier
     *   that stops this being used at all.
     *
     * THE CONCURRENCY LIMIT, STATED PLAINLY
     *   PI Web API offers no compare-and-swap. Two operators acknowledging
     *   different alarms within the same poll interval both read the same map,
     *   each adds their entry, and the second write wins — losing the first
     *   acknowledgement, which reappears as an unacknowledged alarm at the next
     *   refresh.
     *
     *   Mitigated in three layers, because a read-then-merge alone is NOT
     *   enough — a test of two concurrent acknowledgements loses one of them
     *   every time, so this is written against a demonstrated failure rather
     *   than an imagined one:
     *
     *     1. Every write re-reads immediately beforehand and merges per key by
     *        newest timestamp. Shrinks the window to one round trip.
     *     2. Every write then VERIFIES: re-read, and if our entry is missing or
     *        older than what we wrote, somebody clobbered us — merge and write
     *        again, up to a small retry limit. This is what actually closes the
     *        race, and it converts a lost acknowledgement into a slow one.
     *     3. Merging never deletes. A store that polls keeps its own confirmed
     *        entries, so an acknowledgement erased by someone else's write is
     *        re-asserted rather than forgotten.
     *
     *   Acknowledgement is idempotent, so the worst case of all this is a
     *   duplicate write, never a silently cleared alarm.
     *
     *   If a site needs guaranteed acknowledgement, this is not the mechanism;
     *   an AF analysis or a notification with real transactional semantics is.
     *   Say so rather than letting anyone assume otherwise.
     * ================================================================== */

    var ack = PVX.ack = {};

    /**
     * @param {Object} opts {attributePath, pollMs, user}
     * @returns {Object} store — call .start(), .acknowledge(key), .destroy()
     */
    ack.store = function (opts) {
        opts = opts || {};
        var attributePath = opts.attributePath || '';
        var pollMs = opts.pollMs || 15000;
        var user = opts.user || 'operator';

        var webId = null;
        var map = {};                 // key -> {at, by, st}
        var lastError = null;
        var timer = null;
        var destroyed = false;
        var listeners = [];
        var inFlight = false;

        function emit() {
            for (var i = 0; i < listeners.length; i++) {
                try { listeners[i](map, lastError); } catch (e) { /* a bad listener must not stop the rest */ }
            }
        }

        function parse(raw) {
            if (!raw && raw !== 0) { return {}; }
            if (typeof raw === 'object') { return raw; }
            try {
                var parsed = JSON.parse(String(raw));
                return (parsed && typeof parsed === 'object') ? parsed : {};
            } catch (e) {
                // Somebody typed into the attribute by hand, or it holds
                // something else entirely. Treat it as empty rather than
                // throwing — but surface it, because silently ignoring the
                // store means acknowledgements vanish with no explanation.
                lastError = { code: 'bad-store', message: 'The acknowledgement attribute does not contain valid JSON. ' +
                    'It will be overwritten on the next acknowledgement.', check: 'acknowledgement attribute contents' };
                return {};
            }
        }

        /** Newest entry per key wins. Never deletes — a stale read must not clear anyone. */
        function merge(a, b) {
            var out = {};
            var k;
            for (k in a) { if (Object.prototype.hasOwnProperty.call(a, k)) { out[k] = a[k]; } }
            for (k in b) {
                if (!Object.prototype.hasOwnProperty.call(b, k)) { continue; }
                if (!out[k] || (b[k] && b[k].at > out[k].at)) { out[k] = b[k]; }
            }
            return out;
        }

        function resolve() {
            if (webId) { return Promise.resolve(webId); }
            if (!attributePath) {
                return Promise.reject({ pvxError: { code: 'no-path',
                    message: 'Shared acknowledgement is enabled but no attribute path is configured.',
                    check: 'the symbol\'s acknowledgement attribute path' } });
            }
            return api.attributeByPath(attributePath).then(function (attr) {
                webId = attr && attr.WebId;
                if (!webId) {
                    throw { pvxError: { code: 'not-found',
                        message: 'The acknowledgement attribute path did not resolve.',
                        check: 'attribute path' } };
                }
                return webId;
            });
        }

        /**
         * read -> build -> write -> verify -> (retry if clobbered).
         *
         * PI Web API has no compare-and-swap, so this is the closest available
         * thing: an optimistic write plus a check that it survived. Bounded, and
         * with a small backoff, so two operators racing converge instead of
         * ping-ponging writes at each other forever.
         */
        function writeWithVerify(build, landed, attempt) {
            attempt = attempt || 0;
            return resolve()
                .then(function (id) { return api.readValue(id, { cache: false }); })
                .then(function (res) {
                    map = build(parse(res && res.Value));
                    return api.writeValue(webId, JSON.stringify(map));
                })
                .then(function () { return api.readValue(webId, { cache: false }); })
                .then(function (res) {
                    var server = parse(res && res.Value);
                    map = merge(map, server);
                    if (landed(server)) { lastError = null; emit(); return map; }
                    if (attempt >= 3) {
                        // Give up loudly. A silent failure here means an operator
                        // believes they acknowledged something and they have not.
                        lastError = { code: 'ack-contended',
                            message: 'The acknowledgement could not be saved — another operator is writing to ' +
                                     'the same attribute at the same moment. Try again.',
                            check: 'acknowledgement attribute contention' };
                        emit();
                        return map;
                    }
                    return new Promise(function (r) { setTimeout(r, 120 * (attempt + 1)); })
                        .then(function () { return writeWithVerify(build, landed, attempt + 1); });
                })
                .catch(function (e) {
                    lastError = (e && e.pvxError) || { code: 'unknown', message: String(e), check: '' };
                    emit();
                    return map;
                });
        }

        var store = {
            /** Current map. Read-only to callers. */
            state: function () { return map; },
            error: function () { return lastError; },
            isConfigured: function () { return !!attributePath; },

            onChange: function (fn) { listeners.push(fn); },

            /** Fetch once, then poll so other operators' acknowledgements appear. */
            start: function () {
                store.refresh();
                if (timer) { clearInterval(timer); }
                timer = setInterval(function () { store.refresh(); }, pollMs);
                return store;
            },

            refresh: function () {
                if (destroyed || inFlight) { return Promise.resolve(map); }
                inFlight = true;
                return resolve()
                    .then(function (id) { return api.readValue(id, { cache: false }); })
                    .then(function (res) {
                        lastError = null;
                        map = merge(map, parse(res && res.Value));
                        emit();
                        return map;
                    })
                    .catch(function (e) {
                        lastError = (e && e.pvxError) || { code: 'unknown', message: String(e), check: '' };
                        emit();
                        return map;
                    })
                    .then(function (m) { inFlight = false; return m; });
            },

            /**
             * Acknowledge one key. Re-reads immediately before writing so a
             * concurrent acknowledgement of a DIFFERENT key is preserved.
             */
            acknowledge: function (key, state) {
                if (destroyed) { return Promise.resolve(map); }
                var entry = { at: (new Date()).getTime(), by: user, st: state || 'ack' };
                // Optimistic: the operator sees their click take effect now,
                // and the server round trip either confirms it or reports.
                map[key] = entry;
                emit();

                return writeWithVerify(function (server) {
                    var fresh = merge(server, map);
                    fresh[key] = entry;                   // our click is the newest fact
                    return fresh;
                }, function (server) {
                    // Landed only if our entry is there and no older than ours.
                    return !!(server[key] && server[key].at >= entry.at);
                });
            },

            /** Acknowledge many at once — one write, not one per alarm. */
            acknowledgeAll: function (keys, state) {
                if (destroyed || !keys || !keys.length) { return Promise.resolve(map); }
                var now = (new Date()).getTime();
                var added = {};
                for (var i = 0; i < keys.length; i++) {
                    added[keys[i]] = { at: now, by: user, st: state || 'ack' };
                }
                map = merge(map, added);
                emit();
                return writeWithVerify(function (server) {
                    return merge(merge(server, map), added);
                }, function (server) {
                    for (var k in added) {
                        if (!Object.prototype.hasOwnProperty.call(added, k)) { continue; }
                        if (!server[k] || server[k].at < added[k].at) { return false; }
                    }
                    return true;
                });
            },

            destroy: function () {
                destroyed = true;
                if (timer) { clearInterval(timer); timer = null; }
                listeners = [];
            }
        };
        return store;
    };

    /* ================================================================== *
     * sources — removing one data source from a placed symbol
     * ================================================================== *
     * PI Vision lets an operator drop attributes onto a multi-source symbol
     * but gives a custom symbol no way to take one off again, so a single
     * wrong drop used to mean deleting the symbol and configuring it from
     * scratch. Every PVX symbol gets a "Data sources" list at the top of its
     * format pane (injected by tools/build.js) with a Remove button per row.
     *
     * The list lives on scope.runtimeData, which PI Vision shares between a
     * symbol and its format pane without persisting it. What IS persisted is
     * symbol.DataSources, the array PI Vision saves with the display and
     * builds its data requests from; removal edits that array in place.
     *
     * WHY REMOVAL ALSO REWRITES CONFIG
     *   Several symbols address their sources by position: ComboChart's
     *   "3:line:right", Sankey's "Feed > Reactor : 2", SitePlan's hotspot
     *   list. Remove source 2 and every later source moves up one, so a
     *   config left alone would now style, place or route the WRONG
     *   attribute — no error, just a convincing picture of the wrong plant.
     *   A symbol declares those keys in `sourceRemap` on its definition and
     *   they are renumbered in the same step, and the pane says what changed.
     */
    var sources = PVX.sources = {};

    /**
     * Short display name for a PI Vision data source path.
     *   af:\\srv\db\Area\Pump 101|Flow?guid  -> "Pump 101|Flow"
     *   pi:\\srv\SINUSOID?123                -> "SINUSOID"
     * The full path stays available as a tooltip; this only has to tell two
     * rows apart at a glance.
     */
    sources.name = function (path) {
        var s = String(path === null || path === undefined ? '' : path);
        var q = s.lastIndexOf('?');
        if (q > 0) { s = s.slice(0, q); }
        s = s.replace(/^[a-z]+:/i, '');
        var bar = s.indexOf('|');
        var head = bar === -1 ? s : s.slice(0, bar);
        var tail = bar === -1 ? '' : s.slice(bar);
        var slash = head.lastIndexOf('\\');
        var name = (slash === -1 ? head : head.slice(slash + 1)) + tail;
        return name || String(path || '');
    };

    function renumber(n, k) { return n > k ? n - 1 : n; }

    /** Remove the k-th (1-based) sep-separated piece, or null if there is none. */
    function dropPiece(text, sep, k) {
        var parts = String(text).split(sep);
        if (parts.length < k) { return null; }
        parts.splice(k - 1, 1);
        return parts.join(sep).replace(/^\s+|\s+$/g, '');
    }

    /**
     * Rewrite rules, one per positional grammar. Each takes the current value
     * and the 1-based position removed, and returns {value, note} — or null
     * when the value does not refer to that position and is left alone.
     */
    sources.rules = {
        // A single 1-based position (Histogram SeriesIndex, Compare
        // ConditionSource). Pointing at the removed source falls back to 1,
        // the default, rather than silently picking its neighbour.
        index: function (v, k, key) {
            var n = parseInt(v, 10);
            if (!isFinite(n) || n < k) { return null; }
            if (n === k) { return { value: 1, note: key + ' pointed at the removed source; it now uses source 1.' }; }
            return { value: n - 1, note: key + ' renumbered from ' + n + ' to ' + (n - 1) + '.' };
        },

        // A 1-based position where 0 means "automatic" (Deviation
        // TargetSource / ValueSource). Pointing at the removed source goes
        // back to automatic: falling back to 1 would silently make the first
        // process value the setpoint. Stored as a string, because the pane
        // picks it with a plain <select> whose option values are strings.
        indexAuto: function (v, k, key) {
            var n = parseInt(v, 10);
            if (!isFinite(n) || n < 1 || n < k) { return null; }
            if (n === k) { return { value: '0', note: key + ' pointed at the removed source; it is automatic again.' }; }
            return { value: String(n - 1), note: key + ' renumbered from ' + n + ' to ' + (n - 1) + '.' };
        },

        // One entry per source in order, comma separated (Radar AxisLimits,
        // Profile Positions). The removed source's entry goes with it.
        listComma: function (v, k, key) {
            if (!String(v === null || v === undefined ? '' : v).replace(/\s+/g, '')) { return null; }
            var out = dropPiece(v, ',', k);
            return out === null ? null : { value: out, note: key + ': entry ' + k + ' removed.' };
        },

        // Numbers only, separated by commas, semicolons or spaces, the way
        // Profile reads its manual Positions. Rewritten as "0, 1.5, 7".
        numberList: function (v, k, key) {
            var nums = [];
            var parts = String(v === null || v === undefined ? '' : v).split(/[,;\s]+/);
            for (var i = 0; i < parts.length; i++) {
                if (util.num(parts[i]) !== null) { nums.push(parts[i]); }
            }
            if (nums.length < k) { return null; }
            nums.splice(k - 1, 1);
            return { value: nums.join(', '), note: key + ': entry ' + k + ' removed.' };
        },

        // Same, '|' separated (SitePlan Hotspots).
        listBar: function (v, k, key) {
            if (!String(v === null || v === undefined ? '' : v).replace(/\s+/g, '')) { return null; }
            var out = dropPiece(v, '|', k);
            return out === null ? null : { value: out, note: key + ': entry ' + k + ' removed.' };
        },

        // "1:bar, 2:line:right" — entries keyed by a leading index, separated
        // by , ; or newline exactly as ComboChart's parser accepts. Separators
        // are kept so a spec typed one per line stays one per line.
        traceSpec: function (v, k, key) {
            var raw = String(v === null || v === undefined ? '' : v);
            if (!raw.replace(/\s+/g, '')) { return null; }
            var bits = raw.split(/([,\n;])/);
            var kept = [];
            var dropped = 0, moved = 0;
            for (var i = 0; i < bits.length; i += 2) {
                var chunk = bits[i];
                var sep = i + 1 < bits.length ? bits[i + 1] : '';
                var m = /^(\s*#?\s*)(\d+)/.exec(chunk);
                if (m) {
                    var n = parseInt(m[2], 10);
                    if (n === k) { dropped += 1; continue; }
                    if (n > k) {
                        chunk = m[1] + (n - 1) + chunk.slice(m[0].length);
                        moved += 1;
                    }
                }
                kept.push(chunk, sep);
            }
            if (!dropped && !moved) { return null; }
            var out = kept.join('').replace(/^[\s,;]+|[\s,;]+$/g, '');
            var said = [];
            if (dropped) { said.push('entry for source ' + k + ' removed'); }
            if (moved) { said.push('later entries renumbered'); }
            return { value: out, note: key + ': ' + said.join(', ') + '.' };
        },

        // Waterfall's "subtotal after step N". A subtotal after the removed
        // step stays where it stood in the sequence, after the step before it.
        steps: function (v, k, key) {
            var raw = String(v === null || v === undefined ? '' : v);
            var parts = raw.split(/[^0-9-]+/);
            var out = [], seen = {}, changed = false;
            for (var i = 0; i < parts.length; i++) {
                var n = parseInt(parts[i], 10);
                if (!isFinite(n)) { continue; }
                var m = n >= k ? n - 1 : n;
                if (m !== n) { changed = true; }
                if (m >= 1 && !seen[m]) { seen[m] = true; out.push(m); }
                else if (m < 1) { changed = true; }
            }
            return changed ? { value: out.join(', '), note: key + ' renumbered to "' + out.join(', ') + '".' } : null;
        },

        // Sankey "From > To : source | ...". A link whose magnitude came from
        // the removed source has nothing left to measure, so it goes too and
        // the note names it; later indices move up.
        links: function (v, k, key) {
            var raw = String(v === null || v === undefined ? '' : v);
            if (!raw.replace(/\s+/g, '')) { return null; }
            var parts = raw.split('|');
            var kept = [], gone = [], moved = 0;
            for (var i = 0; i < parts.length; i++) {
                var s = parts[i].replace(/^\s+|\s+$/g, '');
                if (!s) { continue; }
                var colon = s.lastIndexOf(':');
                var n = colon === -1 ? NaN : parseInt(s.slice(colon + 1), 10);
                if (n === k) { gone.push(s.slice(0, colon).replace(/\s+$/, '')); continue; }
                if (isFinite(n) && n > k) { s = s.slice(0, colon + 1) + ' ' + (n - 1); moved += 1; }
                kept.push(s);
            }
            if (!gone.length && !moved) { return null; }
            var said = [];
            if (gone.length) { said.push('removed ' + gone.join(', ')); }
            if (moved) { said.push('later sources renumbered'); }
            return { value: kept.join(' | '), note: key + ': ' + said.join('; ') + '.' };
        }
    };

    /**
     * Apply a symbol's sourceRemap to its config for removed position k.
     * @param {Object} cfg   the symbol's config (edited in place)
     * @param {Object} remap {ConfigKey: ruleName}
     * @returns {String[]} one note per key that changed
     */
    sources.remap = function (cfg, remap, k) {
        var notes = [];
        if (!cfg || !remap) { return notes; }
        for (var key in remap) {
            if (!Object.prototype.hasOwnProperty.call(remap, key)) { continue; }
            var rule = sources.rules[remap[key]];
            if (!rule) {
                // A typo in a definition must not pass as "nothing to renumber".
                notes.push(key + ' was NOT renumbered: unknown rule "' + remap[key] + '".');
                continue;
            }
            var r = rule(cfg[key], k, key);
            if (r) { cfg[key] = r.value; notes.push(r.note); }
        }
        return notes;
    };

    /**
     * Publish the data source list for the format pane and the actions on it.
     *
     * @param {Object} scope the symbol's Angular scope
     * @param {Object} info  {sourceRemap} from the symbol definition (may be null)
     * @param {Function} onChange called after a removal so the symbol repaints
     * @returns {Object} state, also at scope.runtimeData.pvxSources
     */
    sources.bind = function (scope, info, onChange) {
        if (!scope) { return null; }
        if (!scope.runtimeData) { scope.runtimeData = {}; }
        info = info || {};

        var state = {
            items: [],
            pending: -1,        // row awaiting confirmation
            message: '',
            unwatch: null
        };

        var list = function () {
            var sym = scope.symbol;
            return sym && sym.DataSources && typeof sym.DataSources.length === 'number' ? sym.DataSources : null;
        };

        state.refresh = function () {
            var ds = list() || [];
            var same = ds.length === state.items.length;
            for (var j = 0; same && j < ds.length; j++) {
                if (state.items[j].path !== String(ds[j])) { same = false; }
            }
            if (same) { return; }
            var items = [];
            for (var i = 0; i < ds.length; i++) {
                items.push({ path: String(ds[i]), name: sources.name(ds[i]) });
            }
            state.items = items;
            state.pending = -1;
        };

        // Two clicks, not one: the button sits in a narrow pane next to the
        // row it removes, and a misclick would cost exactly the rework this
        // feature exists to save.
        state.ask = function (i) { state.pending = i; state.message = ''; };
        state.cancel = function () { state.pending = -1; };

        state.remove = function (i) {
            var ds = list();
            state.pending = -1;
            if (!ds || i < 0 || i >= ds.length) { return false; }
            if (ds.length < 2) {
                state.message = 'A symbol needs at least one data source. Delete the symbol to remove the last one.';
                return false;
            }
            var name = sources.name(ds[i]);
            var cfg = scope.config || (scope.symbol && scope.symbol.Configuration);
            var notes = sources.remap(cfg, info.sourceRemap, i + 1);
            // In place: whatever in PI Vision already holds this array sees
            // the change, and a $watchCollection on it fires.
            ds.splice(i, 1);
            state.refresh();
            state.message = 'Removed ' + name + '.' + (notes.length ? ' ' + notes.join(' ') : '');
            // Ask the data layer to rebuild its request for the shorter list.
            // An event nobody listens to is a no-op, so this costs nothing on
            // a release that refreshes by itself.
            try {
                var rs = scope.$root;
                if (rs && rs.$broadcast) { rs.$broadcast('refreshDataForChangedSymbols'); }
            } catch (e) { /* the removal itself already happened */ }
            if (onChange) { onChange(); }
            return true;
        };

        if (scope.$watchCollection) {
            try {
                state.unwatch = scope.$watchCollection(function () { return list(); }, state.refresh);
            } catch (e) { state.unwatch = null; }
        }
        state.destroy = function () {
            if (state.unwatch) { state.unwatch(); state.unwatch = null; }
        };

        state.refresh();
        scope.runtimeData.pvxSources = state;
        return state;
    };

    /* ------------------------------------------------------------------ *
     * afpick — choosing AF objects in a format pane the way PI Vision does
     * ================================================================== *
     * A path typed by hand is the commonest way a PI Web API symbol ends up
     * blank: one wrong backslash, a server alias, a database renamed last
     * year. 1.9.0 answered that with a tree browser and a name box, and it
     * was not enough: the people configuring displays already know PI
     * Vision's own Search Criteria pane (Database, Search Root, Return All
     * Descendants, Asset Name, Asset Type with attribute filters, Asset
     * Category, Number of Results, Sort, Refresh), and finding "every
     * Compressor in Area 2 whose Status is Running" by clicking down a tree
     * is not a thing anyone should have to do. So every PVX field that takes
     * an AF path gets that same pane (expanded by tools/build.js from a
     * marker in config.html), driven through PI Web API.
     *
     * WHAT IS STORED DOES NOT CHANGE
     *   Picking writes the item's plain Path into the same config key the
     *   text box edits, so a display saved before this existed loads exactly
     *   as before, and the box stays editable for a path PI Web API cannot
     *   see from here. The write happens in the pane's own ng-click
     *   expression, on the `config` its ng-model already binds, rather than
     *   from here — that is the one object guaranteed to be the one saved.
     *
     * TWO WAYS TO SEARCH
     *   Without attribute filters the pane uses the long-standing element
     *   collection endpoints, whose parameters are the criteria one for one.
     *   Attribute VALUE filters exist only in AF's search syntax, so with any
     *   filter set the same criteria are written as an AFSearch query and
     *   sent to elements/search. Older PI Web API releases lack that
     *   endpoint; the pane then says so instead of quietly dropping the
     *   filters and returning a list that looks filtered and is not.
     */
    var afpick = PVX.afpick = {};

    afpick.DEFAULT_MAX = 100;

    // What each kind of field may be set to. A PI point counts as an
    // attribute because every attribute field resolves through
    // attributes?path=, which takes either.
    afpick.kinds = {
        database:  { database: true },
        element:   { element: true },
        attribute: { attribute: true, point: true }
    };

    afpick.ops = ['=', '<>', '<', '<=', '>', '>='];

    /** '\\srv\db\A\B|x|y' -> {segs: ['srv','db','A','B'], attrs: ['x','y']} */
    afpick.split = function (p) {
        var s = String(p === null || p === undefined ? '' : p).replace(/^\s+|\s+$/g, '');
        var bar = s.indexOf('|');
        var head = bar === -1 ? s : s.slice(0, bar);
        var attrs = bar === -1 ? [] : s.slice(bar + 1).split('|');
        var segs = head.replace(/^\\+/, '').split('\\');
        var out = [];
        for (var i = 0; i < segs.length; i++) { if (segs[i]) { out.push(segs[i]); } }
        return { segs: out, attrs: attrs };
    };

    /** What a path names, from its shape alone. */
    afpick.typeOf = function (p) {
        var sp = afpick.split(p);
        if (!sp.segs.length) { return 'root'; }
        if (sp.attrs.length) { return 'attribute'; }
        return sp.segs.length === 1 ? 'server' : sp.segs.length === 2 ? 'database' : 'element';
    };

    /** One level up; '' once there is nothing above but the server list. */
    afpick.parent = function (p) {
        var sp = afpick.split(p);
        if (sp.attrs.length) { sp.attrs.pop(); }
        else { sp.segs.pop(); }
        if (!sp.segs.length) { return ''; }
        return '\\\\' + sp.segs.join('\\') + (sp.attrs.length ? '|' + sp.attrs.join('|') : '');
    };

    /**
     * The value a pick writes. Plain fields get the path. A list field gets
     * one more line in its own grammar, and the same line twice is refused
     * rather than added, because a duplicate row in a rounds sheet or a nav
     * bar is a mistake nobody meant to make.
     * @returns {{value: String, added: Boolean}}
     */
    afpick.compose = function (append, item, current, cfg) {
        var path = item.path;
        if (!append) { return { value: path, added: true }; }
        var line = path;
        if (append === 'entryRow') {
            // EntryTable reads a bare attribute name against its element
            // path, so a pick under that element is written the short way.
            var base = String((cfg && cfg.ElementPath) || '').replace(/^\s+|\s+$/g, '');
            if (base && path.toLowerCase().indexOf(base.toLowerCase() + '|') === 0) {
                line = path.slice(base.length + 1);
            }
        } else if (append === 'navItem') {
            line = (cfg && cfg.Mode === 'custom')
                ? item.name + ' |  | asset=' + path
                : item.name + ' | ' + path;
        }
        var text = String(current === null || current === undefined ? '' : current).replace(/\s+$/, '');
        var lines = text.split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].replace(/^\s+|\s+$/g, '') === line) { return { value: text, added: false, line: line }; }
        }
        return { value: text ? text + '\n' + line : line, added: true, line: line };
    };

    /**
     * A search root as the pane shows it — relative to the database, the way
     * PI Vision writes it — from whatever was typed or picked. A full path
     * outside the chosen database comes back null: searching it would mean
     * searching some other database than the one the dropdown names.
     */
    afpick.relRoot = function (root, dbPath) {
        var r = String(root === null || root === undefined ? '' : root).replace(/^\s+|\s+$/g, '').replace(/\\+$/, '');
        if (!r) { return ''; }
        if (!/^\\\\/.test(r)) { return r.replace(/^\\+/, ''); }
        var db = String(dbPath || '').replace(/\\+$/, '');
        if (r.toLowerCase() === db.toLowerCase()) { return ''; }
        if (r.toLowerCase().indexOf(db.toLowerCase() + '\\') !== 0) { return null; }
        return r.slice(db.length + 1);
    };

    /** A name filter as PI Vision's box behaves: no wildcard typed means "contains". */
    afpick.nameFilter = function (name) {
        var n = String(name === null || name === undefined ? '' : name).replace(/^\s+|\s+$/g, '');
        if (!n) { return ''; }
        return /[*?]/.test(n) ? n : '*' + n + '*';
    };

    /** Quote a value for AFSearch with whichever quote it does not contain. */
    afpick.quote = function (v) {
        var s = String(v === null || v === undefined ? '' : v);
        return s.indexOf("'") === -1 ? "'" + s + "'" : '"' + s.replace(/"/g, '') + '"';
    };

    /**
     * The criteria as an AFSearch query, for elements/search.
     *   Root:'Area 2' AllDescendants:false Name:'*comp*' Template:'Compressor'
     *   Category:'Rotating' '|Status':'Running' '|Discharge Pressure':>=50
     * Numbers go bare so the comparison is numeric; everything else quoted.
     * An attribute filter with no attribute name is skipped by the caller
     * and reported, never sent as an empty token.
     */
    afpick.searchQuery = function (c) {
        var t = [];
        if (c.rootRel) { t.push('Root:' + afpick.quote(c.rootRel)); }
        if (!c.descendants) { t.push('AllDescendants:false'); }
        var nf = afpick.nameFilter(c.name);
        if (nf) { t.push('Name:' + afpick.quote(nf)); }
        if (c.template) { t.push('Template:' + afpick.quote(c.template)); }
        if (c.category) { t.push('Category:' + afpick.quote(c.category)); }
        var attrs = c.attrs || [];
        for (var i = 0; i < attrs.length; i++) {
            var a = attrs[i];
            if (!a || !a.name) { continue; }
            var op = afpick.ops.indexOf(a.op) === -1 || a.op === '=' ? '' : a.op;
            var v = String(a.value === null || a.value === undefined ? '' : a.value).replace(/^\s+|\s+$/g, '');
            var val = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v) ? v : afpick.quote(v);
            t.push(afpick.quote('|' + a.name) + ':' + op + val);
        }
        return t.join(' ');
    };

    /** Sort in place by name or asset type, then name; returns the array. */
    afpick.sortItems = function (items, by, order) {
        var dir = order === 'desc' ? -1 : 1;
        var key = function (it) { return String((by === 'template' ? it.template : it.name) || '').toLowerCase(); };
        items.sort(function (a, b) {
            var ka = key(a), kb = key(b);
            if (ka === kb && by === 'template') { ka = String(a.name).toLowerCase(); kb = String(b.name).toLowerCase(); }
            return ka < kb ? -dir : ka > kb ? dir : 0;
        });
        return items;
    };

    function afErr(e) {
        return (e && e.pvxError && e.pvxError.message) || (e && e.message) || 'PI Web API request failed.';
    }

    function afQs(parts) {
        var out = [];
        for (var i = 0; i < parts.length; i++) { if (parts[i]) { out.push(parts[i]); } }
        return out.length ? '?' + out.join('&') : '';
    }

    function afTrim(v) { return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, ''); }

    /**
     * Publish picker state for the format pane at runtimeData.pvxAf.
     * Nothing is requested until a Browse button is pressed, so binding it
     * on every symbol costs nothing on a display that never opens a pane.
     */
    afpick.bind = function (scope) {
        if (!scope) { return null; }
        if (!scope.runtimeData) { scope.runtimeData = {}; }
        var seq = 0;            // latest search wins; slower replies are dropped
        var F = 'selectedFields=Items.Name;Items.Path;Items.WebId;Items.HasChildren;Items.TemplateName;Items.CategoryNames';

        var state = {
            key: '', kind: '', append: '',
            sources: [],        // databases (and Data Archives for attribute fields)
            crit: null,
            templates: [], categories: [], attrNames: [],
            results: [], searched: false,
            focus: null,        // element or attribute whose attributes are listed
            attributes: [],
            ops: afpick.ops,
            busy: false, message: '', note: ''
        };

        var digest = function () {
            // Replies arrive outside Angular, so ask for a digest or the pane
            // sits on "Searching" until something unrelated triggers one.
            try { if (scope.$evalAsync) { scope.$evalAsync(function () {}); } } catch (e) { /* no Angular: tests */ }
        };

        var fresh = function () {
            // "Any" is null rather than '': it is the empty <option> of an
            // ng-options select, and '' would show as a blank unknown choice.
            return { source: '', root: '', descendants: false, name: '', template: null, attrs: [],
                     category: null, max: afpick.DEFAULT_MAX, sortBy: 'name', order: 'asc' };
        };

        state.source = function () {
            var c = state.crit;
            for (var i = 0; c && i < state.sources.length; i++) {
                if (state.sources[i].path === c.source) { return state.sources[i]; }
            }
            return null;
        };

        var shape = function (type, list, under) {
            var out = [];
            var items = (list && list.Items) || [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                var path = String(it.Path || '');
                var where = '';
                // Below the search root, say where a hit lives.
                if (under && path.toLowerCase().indexOf(under.toLowerCase()) === 0) {
                    where = afpick.parent(path).slice(under.length).replace(/^[\\|]+/, '');
                }
                out.push({ name: it.Name, path: path, webId: it.WebId, type: type,
                           hasChildren: it.HasChildren, template: it.TemplateName || '', where: where });
            }
            return out;
        };

        /** Every database on every AF server, plus Data Archives where a point is valid. */
        var loadSources = function () {
            return api.get('assetservers?selectedFields=Items.Name;Items.Path;Items.WebId').then(function (r) {
                var servers = (r && r.Items) || [];
                var many = servers.length > 1;
                var jobs = [];
                for (var i = 0; i < servers.length; i++) {
                    (function (s) {
                        jobs.push(api.get('assetservers/' + encodeURIComponent(s.WebId) +
                            '/assetdatabases?selectedFields=Items.Name;Items.Path;Items.WebId').then(function (d) {
                            var out = [];
                            var dbs = (d && d.Items) || [];
                            for (var j = 0; j < dbs.length; j++) {
                                out.push({ label: many ? s.Name + ' \\ ' + dbs[j].Name : dbs[j].Name,
                                           path: dbs[j].Path, webId: dbs[j].WebId, type: 'database' });
                            }
                            return out;
                        }, function (e) {
                            state.note = 'The databases on ' + s.Name + ' could not be listed: ' + afErr(e);
                            return [];
                        }));
                    }(servers[i]));
                }
                if (state.kind === 'attribute') {
                    jobs.push(api.get('dataservers?selectedFields=Items.Name;Items.Path;Items.WebId').then(function (d) {
                        var out = [];
                        var das = (d && d.Items) || [];
                        for (var j = 0; j < das.length; j++) {
                            out.push({ label: 'PI points on ' + das[j].Name, path: das[j].Path,
                                       webId: das[j].WebId, type: 'dataserver' });
                        }
                        return out;
                    }, function (e) {
                        state.note = 'PI Data Archive servers could not be listed: ' + afErr(e);
                        return [];
                    }));
                }
                return Promise.all(jobs).then(function (lists) {
                    var all = [];
                    for (var k = 0; k < lists.length; k++) { all = all.concat(lists[k]); }
                    return all;
                });
            });
        };

        /** Asset types and categories for the chosen database. */
        var loadLists = function () {
            var src = state.source();
            state.templates = [];
            state.categories = [];
            state.attrNames = [];
            if (!src || src.type !== 'database') { return Promise.resolve(); }
            var w = encodeURIComponent(src.webId);
            var names = function (r) {
                var out = [];
                var items = (r && r.Items) || [];
                for (var i = 0; i < items.length; i++) { out.push(items[i].Name); }
                return out;
            };
            // Either list failing only costs its dropdown; say so and carry on.
            return Promise.all([
                api.get('assetdatabases/' + w + '/elementtemplates?selectedFields=Items.Name;Items.WebId').then(function (r) {
                    state.templates = (r && r.Items) || [];
                }, function (e) { state.note = 'Asset types could not be listed: ' + afErr(e); }),
                api.get('assetdatabases/' + w + '/elementcategories?selectedFields=Items.Name').then(function (r) {
                    state.categories = names(r);
                }, function (e) { state.note = 'Asset categories could not be listed: ' + afErr(e); })
            ]);
        };

        var loadAttrNames = function () {
            state.attrNames = [];
            var t = null;
            for (var i = 0; i < state.templates.length; i++) {
                if (state.templates[i].Name === state.crit.template) { t = state.templates[i]; }
            }
            if (!t) { return Promise.resolve(); }
            return api.get('elementtemplates/' + encodeURIComponent(t.WebId) +
                    '/attributetemplates?showInherited=true&selectedFields=Items.Name').then(function (r) {
                var items = (r && r.Items) || [];
                var out = [];
                for (var j = 0; j < items.length; j++) { out.push(items[j].Name); }
                state.attrNames = out;
            }, function (e) { state.note = 'The attributes of ' + t.Name + ' could not be listed: ' + afErr(e); });
        };

        /** Run the criteria. Resolves when the results (or the reason for none) are shown. */
        state.refresh = function () {
            var c = state.crit;
            var src = state.source();
            var mine = ++seq;
            state.message = '';
            state.note = '';
            state.focus = null;
            state.attributes = [];
            if (!src) {
                state.message = 'Choose a database first.';
                return Promise.resolve();
            }
            var max = parseInt(c.max, 10);
            if (!isFinite(max) || max < 1) { max = afpick.DEFAULT_MAX; c.max = max; }
            var M = 'maxCount=' + max;
            var w = encodeURIComponent(src.webId);
            var job;

            if (src.type === 'dataserver') {
                job = api.get('dataservers/' + w + '/points' + afQs([M,
                        'nameFilter=' + encodeURIComponent(afpick.nameFilter(c.name) || '*'),
                        'selectedFields=Items.Name;Items.Path;Items.WebId']), { cache: false })
                    .then(function (r) { return shape('point', r); });
            } else {
                var rel = afpick.relRoot(c.root, src.path);
                if (rel === null) {
                    state.message = 'The search root ' + c.root + ' is not in ' + src.path +
                        '. Clear it, or choose the database it belongs to.';
                    return Promise.resolve();
                }
                var rootPath = rel ? src.path + '\\' + rel : '';
                var filters = [];
                var skipped = 0;
                for (var i = 0; i < c.attrs.length; i++) {
                    if (c.attrs[i].name) { filters.push(c.attrs[i]); } else { skipped += 1; }
                }
                if (filters.length) {
                    var q = afpick.searchQuery({ rootRel: rel, descendants: c.descendants, name: c.name,
                        template: c.template, category: c.category, attrs: filters });
                    job = api.get('elements/search' + afQs(['databaseWebId=' + w, 'query=' + encodeURIComponent(q), M, F]), { cache: false })
                        .then(function (r) { return shape('element', r, rootPath || src.path); }, function (e) {
                            if (e && e.status === 404) {
                                throw { pvxError: { message: 'This PI Web API has no elements/search endpoint, so ' +
                                    'attribute value filters cannot run. Remove the filters, or upgrade PI Web API.' } };
                            }
                            throw e;
                        });
                } else {
                    var parts = [M, F,
                        c.descendants ? 'searchFullHierarchy=true' : '',
                        afpick.nameFilter(c.name) ? 'nameFilter=' + encodeURIComponent(afpick.nameFilter(c.name)) : '',
                        c.template ? 'templateName=' + encodeURIComponent(c.template) : '',
                        c.category ? 'categoryName=' + encodeURIComponent(c.category) : '',
                        'sortField=Name', 'sortOrder=' + (c.order === 'desc' ? 'Descending' : 'Ascending')];
                    job = (rootPath
                        ? api.get('elements?path=' + encodeURIComponent(rootPath) + '&selectedFields=WebId').then(function (r) {
                            return 'elements/' + encodeURIComponent(r.WebId);
                        }, function (e) {
                            throw { pvxError: { message: 'The search root ' + rootPath + ' could not be found: ' + afErr(e) } };
                        })
                        : Promise.resolve('assetdatabases/' + w))
                        .then(function (base) { return api.get(base + '/elements' + afQs(parts), { cache: false }); })
                        .then(function (r) { return shape('element', r, rootPath || src.path); });
                }
                if (skipped) {
                    state.note = skipped + ' attribute filter' + (skipped === 1 ? ' has' : 's have') +
                        ' no attribute chosen and ' + (skipped === 1 ? 'was' : 'were') + ' left out.';
                }
            }

            state.busy = true;
            digest();
            return job.then(function (items) {
                if (mine !== seq) { return; }
                state.results = afpick.sortItems(items, c.sortBy, c.order);
                state.searched = true;
                state.busy = false;
                if (items.length >= max) {
                    state.note = (state.note ? state.note + ' ' : '') + 'Showing the first ' + max +
                        '. Raise Number of Results or narrow the search to see the rest.';
                } else if (!items.length) {
                    state.note = (state.note ? state.note + ' ' : '') + 'Nothing matches these criteria.';
                }
                digest();
            }, function (e) {
                if (mine !== seq) { return; }
                state.busy = false;
                state.searched = true;
                state.results = [];
                state.message = afErr(e);
                digest();
            });
        };

        state.changeSource = function () {
            var c = state.crit;
            c.root = '';
            c.template = null;
            c.category = null;
            c.attrs = [];
            state.results = [];
            state.searched = false;
            return loadLists().then(function () {
                digest();
                if (state.kind !== 'database') { return state.refresh(); }
            });
        };

        state.changeTemplate = function () {
            state.crit.attrs = [];
            return loadAttrNames().then(digest);
        };

        state.addFilter = function () { state.crit.attrs.push({ name: null, op: '=', value: '' }); };
        state.removeFilter = function (i) { state.crit.attrs.splice(i, 1); };

        state.setRoot = function (it) {
            var src = state.source();
            state.crit.root = (src && afpick.relRoot(it.path, src.path)) || '';
            return state.refresh();
        };

        state.rootUp = function () {
            var r = afTrim(state.crit.root).replace(/\\+$/, '');
            var cut = r.lastIndexOf('\\');
            state.crit.root = cut === -1 ? '' : r.slice(0, cut);
            return state.refresh();
        };

        state.onKey = function (ev) { if (ev && ev.keyCode === 13) { state.refresh(); } };

        state.isOpen = function (id) { return state.key === id; };

        /**
         * @param {String} id      the config key this Browse button edits
         * @param {String} kind    database | element | attribute
         * @param {String} append  '' to replace, or a list grammar to append to
         * @param {String} current the field's value: the search opens around it
         * @param {String} start   another key's value to search inside (a
         *                         database for an element field, say)
         */
        state.open = function (id, kind, append, current, start) {
            if (state.key === id) { state.close(); return Promise.resolve(); }
            seq += 1;
            state.key = id;
            state.kind = afpick.kinds[kind] ? kind : 'element';
            state.append = append || '';
            state.crit = fresh();
            state.results = [];
            state.searched = false;
            state.focus = null;
            state.attributes = [];
            state.message = '';
            state.note = '';
            state.busy = true;
            var cur = afTrim(current);
            var st = afTrim(start);
            var near = /^\\\\/.test(cur) ? cur : /^\\\\/.test(st) ? st : '';
            var sp = afpick.split(near);
            var dbPath = sp.segs.length >= 2 ? '\\\\' + sp.segs[0] + '\\' + sp.segs[1] : '';
            var owner = '';
            var mine = seq;
            return loadSources().then(function (list) {
                if (mine !== seq) { return; }
                state.sources = list;
                state.busy = false;
                if (!list.length) {
                    state.message = state.message || 'PI Web API lists no AF databases this account can read.';
                    digest();
                    return;
                }
                var pick = null;
                for (var i = 0; i < list.length; i++) {
                    if (dbPath && list[i].path.toLowerCase() === dbPath.toLowerCase()) { pick = list[i]; }
                    if (!pick && sp.segs.length === 1 && list[i].path.toLowerCase() === near.toLowerCase()) { pick = list[i]; }
                }
                if (near && !pick && sp.segs.length >= 2) {
                    state.note = dbPath + ' is not a database PI Web API lists for this account. ' +
                        'It may be misspelt, renamed, or not visible to you.';
                }
                state.crit.source = (pick || list[0]).path;
                // Open around the value: the element it names (or, for an
                // attribute field, the element that owns it) is listed from
                // its parent, so it is in the first results without a search.
                var base = cur ? cur.split('|')[0] : st;
                if (state.kind === 'attribute' && afpick.split(cur).attrs.length) { owner = base; }
                if (state.kind === 'attribute' && !cur && afpick.typeOf(st) === 'element') { owner = st; }
                if (pick && pick.type === 'database' && state.kind !== 'database' && /^\\\\/.test(base) &&
                        afpick.split(base).segs.length >= 3) {
                    state.crit.root = afpick.relRoot(afpick.parent(base), pick.path) || '';
                }
                var keepNote = state.note;
                return loadLists().then(function () {
                    if (mine !== seq) { return; }
                    digest();
                    if (state.kind === 'database') { return; }
                    return state.refresh().then(function () {
                        if (keepNote) { state.note = keepNote + (state.note ? ' ' + state.note : ''); }
                        // An attribute field opens on its own element's attributes.
                        if (owner) {
                            for (var k = 0; k < state.results.length; k++) {
                                if (state.results[k].path.toLowerCase() === owner.toLowerCase()) {
                                    return state.enter(state.results[k]);
                                }
                            }
                        }
                    });
                });
            }, function (e) {
                if (mine !== seq) { return; }
                state.busy = false;
                state.message = afErr(e);
                digest();
            });
        };

        state.close = function () {
            seq += 1;
            state.key = '';
            state.busy = false;
        };

        state.canOpen = function (it) {
            if (state.kind !== 'attribute') { return false; }
            return it.type === 'element' || (it.type === 'attribute' && !!it.hasChildren);
        };

        state.canRoot = function (it) { return it.type === 'element' && it.hasChildren !== false; };

        state.canUse = function (it) { return !!(afpick.kinds[state.kind] || {})[it.type]; };

        state.label = function (it) {
            if (it.type === 'element') { return it.template || 'element'; }
            return { database: 'database', attribute: 'attribute', point: 'PI point' }[it.type] || it.type;
        };

        /** List an element's (or a parent attribute's) attributes. */
        state.enter = function (it) {
            if (!state.canOpen(it)) { return Promise.resolve(); }
            var mine = ++seq;
            state.busy = true;
            state.message = '';
            digest();
            var ep = (it.type === 'element' ? 'elements/' : 'attributes/') + encodeURIComponent(it.webId) + '/attributes';
            return api.get(ep + afQs(['maxCount=1000', 'selectedFields=Items.Name;Items.Path;Items.WebId;Items.HasChildren']))
                .then(function (r) {
                    if (mine !== seq) { return; }
                    state.focus = it;
                    state.attributes = afpick.sortItems(shape('attribute', r), 'name', 'asc');
                    state.busy = false;
                    if (!state.attributes.length) { state.note = it.name + ' has no attributes.'; }
                    digest();
                }, function (e) {
                    if (mine !== seq) { return; }
                    state.busy = false;
                    state.message = afErr(e);
                    digest();
                });
        };

        state.back = function () {
            var f = state.focus;
            state.attributes = [];
            state.focus = null;
            state.note = '';
            // A child attribute steps back to its parent attribute, not the list.
            if (f && f.type === 'attribute') {
                var up = afpick.parent(f.path);
                var owner = { type: afpick.typeOf(up) === 'attribute' ? 'attribute' : 'element', path: up,
                              name: afpick.split(up).attrs.slice(-1)[0] || afpick.split(up).segs.slice(-1)[0] };
                return api.get((owner.type === 'element' ? 'elements' : 'attributes') + '?path=' +
                        encodeURIComponent(up) + '&selectedFields=WebId').then(function (r) {
                    owner.webId = r.WebId;
                    owner.hasChildren = true;
                    return state.enter(owner);
                }, function (e) { state.message = afErr(e); digest(); });
            }
            return Promise.resolve();
        };

        /** Called from the pane's ng-click; returns the value to store. */
        state.use = function (it, current, cfg) {
            var r = afpick.compose(state.append, it, current, cfg);
            if (!state.append) { state.close(); return r.value; }
            state.message = r.added ? 'Added ' + r.line + '.' : r.line + ' is already in the list.';
            return r.value;
        };

        /** A database field takes the dropdown's choice. */
        state.useSource = function (current, cfg) {
            var src = state.source();
            if (!src) { return current; }
            return state.use({ name: src.label, path: src.path, type: src.type }, current, cfg);
        };

        state.destroy = function () { state.close(); };

        scope.runtimeData.pvxAf = state;
        return state;
    };

    /* ------------------------------------------------------------------ *
     * register — thin wrapper over PV.symbolCatalog.register
     * ------------------------------------------------------------------ *
     * Adds: consistent iconUrl/template paths, automatic loadConfig upgrade,
     * and a guard so one broken symbol cannot stop the rest of the library
     * from loading.
     */
    // Every URL is spelled out rather than left to PI Vision's defaults. The
    // files are where the defaults would look (ext and ext/icons, the layout
    // AVEVA's guide describes); 1.7.0 tried a subfolder of ext and PI Vision
    // served nothing from it, so keep these pointing at the folders it does.
    PVX.EXT_PATH = 'scripts/app/editor/symbols/ext/';
    PVX.ICON_PATH = 'scripts/app/editor/symbols/ext/icons/';

    // typeNames that reached PI Vision's catalog. Lets a deployment be checked
    // from the browser console in two halves: PVX.version answers "did
    // ext/libraries/pvx load", PVX.registered.length "did the sym-pvx*.js
    // files in ext load".
    PVX.registered = PVX.registered || [];

    PVX.register = function (PV, def) {
        try {
            if (!PV || !PV.symbolCatalog) {
                if (root.console) { root.console.warn('[PVX] PI Vision symbol catalog unavailable; skipping ' + (def && def.typeName)); }
                return;
            }
            if (!def.iconUrl) {
                def.iconUrl = PVX.ICON_PATH + def.typeName + '.svg';
            }
            if (!def.templateUrl) {
                def.templateUrl = PVX.EXT_PATH + 'sym-' + def.typeName + '-template.html';
            }
            if (def.configTemplateUrl !== null && !def.configTemplateUrl) {
                def.configTemplateUrl = PVX.EXT_PATH + 'sym-' + def.typeName + '-config.html';
            }
            // What sources.bind needs, parked where bootstrap can reach it:
            // init() receives the vis instance, never the definition. Taken
            // off the definition so PI Vision's catalog sees only its own keys.
            if (def.visObjectType && def.visObjectType.prototype) {
                def.visObjectType.prototype.pvxSourceInfo = { sourceRemap: def.sourceRemap || null };
            }
            delete def.sourceRemap;
            // Symbols that raise alarms set limitsRequired: their default is
            // no limits, and a display saved by 1.9.0 or earlier stored the
            // placeholder bands (see thresholds.isPlaceholder), so those are
            // cleared on load. Clearing rather than ignoring keeps the format
            // pane honest: it shows no bands, which is what is in effect.
            var limitsRequired = def.limitsRequired === true;
            delete def.limitsRequired;
            if (!def.loadConfig && def.getDefaultConfig) {
                def.loadConfig = function (saved) {
                    var c = config.upgrade(saved, def.getDefaultConfig());
                    if (limitsRequired && thresholds.isPlaceholder(c.Thresholds)) { c.Thresholds = ''; }
                    return c;
                };
            }
            PV.symbolCatalog.register(def);
            PVX.registered.push(def.typeName);
        } catch (e) {
            if (root.console && root.console.error) {
                root.console.error('[PVX] failed to register symbol ' + (def && def.typeName), e);
            }
        }
    };

    /**
     * Boilerplate every symbol's init() shares: renderer wiring, size tracking,
     * theme resolution, and clean teardown.
     *
     * @param {Object} vis   the symbolVis instance (`this` inside init)
     * @param {Object} scope Angular scope
     * @param {*} elem       symbol element
     * @param {Object} hooks {render:fn(ctx), rootSelector:String, onData:fn(data,ctx)}
     * @returns {Object} ctx shared context object
     */
    PVX.bootstrap = function (vis, scope, elem, hooks) {
        hooks = hooks || {};

        /**
         * The symbol's own root: the template's `.pvx` element.
         *
         * PI Vision passes init() its wrapper element with the template linked
         * inside it, not the template root. Symbols write theme tokens onto
         * ctx.node as inline --pvx-* custom properties, and their stylesheets
         * declare fallbacks for the same properties on the `.pvx-*` root. Set
         * on the wrapper, the inline values only reach the root by inheritance,
         * which the root's own declarations beat, so Transparent, dark theme
         * and BackgroundColor were ignored on a live server while the harness,
         * which passed the bare template, looked correct. The fallback covers
         * a template without a `.pvx` root.
         */
        var resolveNode = function () {
            return util.find(elem, '.pvx') || util.node(elem);
        };
        var node = resolveNode();

        /**
         * Resolve the drawing host fresh on every frame.
         *
         * This MUST NOT be cached. A template can wrap the host in ng-if (a
         * "show sparkline" toggle, an empty-state swap), and Angular destroys
         * and recreates that element — a host captured at init time then points
         * at a detached node, or at the symbol root, and the symbol draws into
         * the wrong box at the wrong size. When a rootSelector is declared and
         * no match exists, the host is null and the symbol renders nothing,
         * which is the correct behaviour for a hidden sub-view.
         */
        var resolveHost = function () {
            return hooks.rootSelector ? util.find(elem, hooks.rootSelector) : node;
        };
        var host = resolveHost();

        var ctx = {
            scope: scope,
            elem: elem,
            node: node,
            host: host || node,
            config: scope.config || {},
            data: null,
            width: (scope.config && scope.config.Width) || (node ? node.clientWidth : 200) || 200,
            height: (scope.config && scope.config.Height) || (node ? node.clientHeight : 120) || 120,
            theme: null,
            destroyed: false
        };

        var renderer = layout.renderer(function () {
            if (ctx.destroyed) { return; }
            ctx.config = scope.config || ctx.config;
            ctx.node = resolveNode() || ctx.node;
            // Zoom before measuring, so the host's size below is the box the
            // symbol lays out in, already 1/k of what is on screen.
            ctx.fontScale = text.scaleOf(ctx.config);
            text.apply(ctx.node, ctx.fontScale);
            ctx.host = resolveHost();
            if (ctx.host) {
                var w = ctx.host.clientWidth, h = ctx.host.clientHeight;
                if (w > 0) { ctx.width = w; }
                if (h > 0) { ctx.height = h; }
            }
            ctx.theme = theme.tokens(ctx.config, elem);
            if (hooks.render) { hooks.render(ctx); }
        });
        ctx.render = renderer.request;
        ctx.renderNow = renderer.flush;

        ctx.sources = sources.bind(scope, vis.pvxSourceInfo, renderer.request);
        ctx.bands = thresholds.bind(scope);
        // Other keys in the band grammar, named by the symbol, e.g. LimitBands.
        ctx.bandEditors = [];
        for (var bk = 0; hooks.bandKeys && bk < hooks.bandKeys.length; bk++) {
            if (hooks.bandKeys[bk] !== 'Thresholds') { ctx.bandEditors.push(thresholds.bind(scope, hooks.bandKeys[bk])); }
        }
        ctx.afpick = afpick.bind(scope);
        ctx.states = states.bind(scope);

        vis.onDataUpdate = function (d) {
            ctx.data = d;
            // Also catches a source added by drag and drop, on a release
            // where nothing re-runs the collection watch in sources.bind.
            if (ctx.sources) { ctx.sources.refresh(); }
            // So a state map's list can offer what this symbol is showing,
            // on a site with no PI Web API to read digital sets from.
            if (ctx.states) { ctx.states.observe(d); }
            if (hooks.onData) {
                try { hooks.onData(d, ctx); }
                catch (e) { if (root.console) { root.console.error('[PVX] onData failed', e); } }
            }
            renderer.request();
        };

        vis.onConfigChange = function (newConfig, oldConfig) {
            ctx.config = newConfig || ctx.config;
            scope.config = ctx.config;
            if (hooks.onConfigChange) {
                try { hooks.onConfigChange(newConfig, oldConfig, ctx); } catch (e) { /* swallow */ }
            }
            renderer.request();
        };

        vis.onResize = function (width, height) {
            if (width > 0) { ctx.width = width; }
            if (height > 0) { ctx.height = height; }
            if (hooks.onResize) {
                try { hooks.onResize(width, height, ctx); } catch (e) { /* swallow */ }
            }
            renderer.request();
        };

        vis.onDestroy = function () {
            ctx.destroyed = true;
            renderer.destroy();
            if (ctx.sources) { ctx.sources.destroy(); }
            if (ctx.bands) { ctx.bands.destroy(); }
            for (var be = 0; be < ctx.bandEditors.length; be++) { ctx.bandEditors[be].destroy(); }
            if (ctx.afpick) { ctx.afpick.destroy(); }
            if (ctx.states) { ctx.states.destroy(); }
            if (hooks.onDestroy) {
                try { hooks.onDestroy(ctx); } catch (e) { /* swallow */ }
            }
        };

        // First paint after Angular has linked the template. A symbol with no
        // data sources (a navigation panel, say) never receives onDataUpdate, so
        // if the host is not linked yet we retry briefly rather than leaving the
        // symbol blank forever.
        var attempts = 0;
        var firstPaint = function () {
            if (ctx.destroyed) { return; }
            renderer.request();
            attempts += 1;
            if (!resolveHost() && attempts < 8) { setTimeout(firstPaint, 40); }
        };
        setTimeout(firstPaint, 0);

        return ctx;
    };

}(window));
