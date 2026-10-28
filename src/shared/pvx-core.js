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

    PVX.version = '1.14.1';
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

    /* ---- the site's theme ------------------------------------------------ *
     * A plant with a corporate look sets it once, in pvx-config.js, rather
     * than in the format pane of every symbol on every display:
     *
     *   theme: {
     *       palette: ['#00539b', '#f7a800', ...],    series colours, in order
     *       status:  { normal: '#..', warning: '#..', alarm: '#..' },
     *       light:   { surface: '#..', text: '#..', border: '#..' },
     *       dark:    { surface: '#..', text: '#..' },
     *       font:    '"Arial", sans-serif',
     *       container: { radius: 4, border: '1px solid #c8ccd0', shadow: '0 1px 2px rgba(0,0,0,.2)' }
     *   }
     *
     * Every key is optional. A symbol's own Background, Text colour and
     * Theme still win, so nothing set on a display is overridden. A value
     * that is not a colour is ignored and named in the console rather than
     * drawing black, and one bad entry does not discard the rest.
     */
    var siteTokens = { light: {}, dark: {} };
    var SITE_TOKEN_KEYS = ['surface', 'surfaceAlt', 'border', 'text', 'textMuted', 'grid', 'axis', 'track'];
    // Built-ins kept so a second configure() replaces rather than compounds.
    var builtinPalette = color.categorical.slice();
    var builtinStatus = {};
    for (var bsk in color.status) {
        if (Object.prototype.hasOwnProperty.call(color.status, bsk)) { builtinStatus[bsk] = color.status[bsk]; }
    }

    function siteWarn(what) {
        try { root.console.warn('[PVX] pvx-config.js theme: ' + what + ' ignored.'); } catch (e) { /* no console */ }
    }

    /** A CSS value safe to drop into one declaration: no braces, no ';', no markup. */
    function cssValue(v) {
        var str = String(v === null || v === undefined ? '' : v);
        return /[{};<>]/.test(str) ? '' : str;
    }

    theme.applySite = function (cfg) {
        var i, k;
        cfg = cfg && typeof cfg === 'object' ? cfg : {};

        // In place: symbols and the core hold references to these.
        var pal = [];
        if (cfg.palette && cfg.palette.length) {
            for (i = 0; i < cfg.palette.length; i++) {
                if (color.toRgb(cfg.palette[i])) { pal.push(cfg.palette[i]); }
                else { siteWarn('palette entry ' + JSON.stringify(cfg.palette[i])); }
            }
            if (pal.length < 2) { siteWarn('a palette of fewer than two colours'); pal = []; }
        }
        var usePal = pal.length ? pal : builtinPalette;
        color.categorical.length = 0;
        for (i = 0; i < usePal.length; i++) { color.categorical.push(usePal[i]); }

        for (k in builtinStatus) {
            if (Object.prototype.hasOwnProperty.call(builtinStatus, k)) { color.status[k] = builtinStatus[k]; }
        }
        var st = cfg.status && typeof cfg.status === 'object' ? cfg.status : {};
        for (k in st) {
            if (!Object.prototype.hasOwnProperty.call(st, k)) { continue; }
            if (!Object.prototype.hasOwnProperty.call(builtinStatus, k)) { siteWarn('status "' + k + '"'); continue; }
            if (color.toRgb(st[k])) { color.status[k] = st[k]; } else { siteWarn('status ' + k + ' ' + JSON.stringify(st[k])); }
        }

        var modes = ['light', 'dark'];
        for (i = 0; i < modes.length; i++) {
            var src = cfg[modes[i]] && typeof cfg[modes[i]] === 'object' ? cfg[modes[i]] : {};
            var out = {};
            for (k in src) {
                if (!Object.prototype.hasOwnProperty.call(src, k)) { continue; }
                if (SITE_TOKEN_KEYS.indexOf(k) === -1) { siteWarn(modes[i] + '.' + k); continue; }
                if (color.toRgb(src[k])) { out[k] = src[k]; } else { siteWarn(modes[i] + '.' + k + ' ' + JSON.stringify(src[k])); }
            }
            siteTokens[modes[i]] = out;
        }

        // Font and the container are CSS, written once for the page, under
        // .pvx so PI Vision's own chrome is untouched.
        var rules = [];
        // A value cssValue refuses would otherwise vanish without a word, so
        // say which one it was.
        function css(v, what) {
            if (v === undefined || v === null || v === '') { return ''; }
            var ok = cssValue(v);
            if (!ok) { siteWarn(what + ' ' + JSON.stringify(v)); }
            return ok;
        }
        var font = css(cfg.font, 'font');
        if (font) { rules.push('.pvx { font-family: ' + font + '; }'); }
        var box = cfg.container && typeof cfg.container === 'object' ? cfg.container : {};
        var decl = [];
        var radius = util.num(box.radius);
        if (radius !== null) { decl.push('border-radius: ' + util.clamp(radius, 0, 40) + 'px'); }
        else if (box.radius !== undefined && box.radius !== null && box.radius !== '') { siteWarn('container.radius ' + JSON.stringify(box.radius)); }
        var border = css(box.border, 'container.border');
        if (border) { decl.push('border: ' + border); }
        var shadow = css(box.shadow, 'container.shadow');
        if (shadow) { decl.push('box-shadow: ' + shadow); }
        if (decl.length) { rules.push('.pvx .pvx-surface { ' + decl.join('; ') + '; }'); }
        theme.siteCss = rules.join('\n');
        try {
            var doc = root.document;
            if (doc && doc.head) {
                var el = doc.getElementById('pvx-site-theme');
                if (!el && rules.length) {
                    el = doc.createElement('style');
                    el.id = 'pvx-site-theme';
                    doc.head.appendChild(el);
                }
                if (el) { el.textContent = theme.siteCss; }
            }
        } catch (e) { /* no document: Node, a test harness */ }
        return { palette: color.categorical.slice(), status: color.status, light: siteTokens.light, dark: siteTokens.dark, css: theme.siteCss };
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

        // The site's theme, from pvx-config.js, sits between the built-in
        // tokens and the symbol's own settings.
        var site = siteTokens[dark ? 'dark' : 'light'];
        for (var sk in site) {
            if (Object.prototype.hasOwnProperty.call(site, sk)) { t[sk] = site[sk]; }
        }

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
     * Alarm deadband: '2' (engineering units) or '2%' (of each limit's own
     * size). Returns {amount, percent}, null for blank, or {bad:true} for
     * something it cannot read, so a symbol can say so instead of quietly
     * alarming without one.
     */
    thresholds.parseDeadband = function (spec) {
        var s = String(spec === null || spec === undefined ? '' : spec).trim();
        if (!s) { return null; }
        var pct = /%$/.test(s);
        var n = util.num(pct ? s.slice(0, -1).trim() : s);
        if (n === null || n < 0) { return { bad: true }; }
        if (n === 0) { return null; }
        return { amount: n, percent: pct };
    };

    /** The deadband below one limit, in engineering units. */
    thresholds.deadbandAt = function (db, limit) {
        if (!db || db.bad) { return 0; }
        return db.percent ? Math.abs(limit) * db.amount / 100 : db.amount;
    };

    /**
     * Band index with a deadband applied: rising into a band is immediate,
     * leaving it downward waits until the value is a deadband below that
     * band's limit. Without it a value hovering at the limit raises and
     * clears an alarm on every poll, which is the chatter a deadband is for.
     * Only numbers are held; a digital state maps straight to its band.
     *
     * @param value   the number, or null
     * @param bands   parse() output, ascending
     * @param rawSev  the band the value is in, ignoring the deadband
     * @param prevSev the band reported last time (-1 for none)
     */
    thresholds.hold = function (value, bands, rawSev, prevSev, db) {
        if (!db || db.bad || value === null || value === undefined || !(prevSev > rawSev)) { return rawSev; }
        for (var j = Math.min(prevSev, bands.length - 1); j > rawSev; j--) {
            if (value >= bands[j].value - thresholds.deadbandAt(db, bands[j].value)) { return j; }
        }
        return rawSev;
    };

    /**
     * Past alarms from recorded values: one entry per excursion at or above
     * band `minBand`, with the worst band it reached.
     *
     * An excursion starts at the first recorded value in alarm and ends at
     * the first one out of it. That is how PI's own analyses timestamp an
     * event, and the most a list of samples can honestly say: the true
     * crossing lies between two of them. A value of bad quality says nothing
     * about the process, so it neither starts nor ends anything.
     *
     * @param points [{t (ms), v (number or null), raw, good}] in time order
     * @param opts {minBand, deadband (parseDeadband), stateBands, from, to}
     * @returns [{sev, firstSev, start, end (null while still in), openStart,
     *            peak, startValue, endValue}]
     */
    thresholds.excursions = function (points, bands, opts) {
        opts = opts || {};
        var minBand = Math.max(0, parseInt(opts.minBand, 10) || 0);
        var out = [], cur = null, prev = -1, seen = false;
        for (var i = 0; i < (points || []).length; i++) {
            var p = points[i];
            if (!p || p.good === false) { continue; }
            var raw = -1;
            var key = opts.stateBands ? states.text(p.raw).toLowerCase() : '';
            if (key && opts.stateBands[key] !== undefined) {
                raw = opts.stateBands[key];
            } else if (p.v !== null && p.v !== undefined) {
                for (var b = 0; b < bands.length; b++) { if (p.v >= bands[b].value) { raw = b; } else { break; } }
            }
            var sev = thresholds.hold(p.v, bands, raw, prev, opts.deadband);
            prev = sev;
            var inAlarm = sev >= minBand && sev >= 0;
            if (inAlarm && !cur) {
                cur = { sev: sev, firstSev: sev, start: p.t, end: null,
                    // Already in alarm at the first good value: it began
                    // before the window, at a time these values cannot show.
                    openStart: !seen,
                    peak: p.v, startValue: p.raw !== undefined ? p.raw : p.v, endValue: null };
                out.push(cur);
            } else if (inAlarm) {
                if (sev > cur.sev) { cur.sev = sev; }
                if (p.v !== null && (cur.peak === null || p.v > cur.peak)) { cur.peak = p.v; }
            } else if (cur) {
                cur.end = p.t;
                cur.endValue = p.raw !== undefined ? p.raw : p.v;
                cur = null;
            }
            seen = true;
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
            var unset = function () {
                mod.sets = [];
                mod.busy = false;
                mod.note = 'PI Web API is not set up for this site, so the list holds only states seen in ' +
                    'live data. Any other state can be typed.';
                mod.version += 1;
            };
            if (!api.isConfigured()) {
                unset();
                mod.pending = Promise.resolve();
                return mod.pending;
            }
            mod.busy = true;
            mod.note = '';
            var failed = [];
            // Through ready(): with a discovered base, a site with no PI Web
            // API should read as unset, not as one failure per source.
            mod.pending = api.ready().then(function (ok) {
                if (!ok) { return [null]; }
                return Promise.all(list.map(function (ds) {
                    return states.lookupSet(ds).then(null, function (e) {
                        failed.push(sources.name(ds) + ': ' + stErr(e));
                        return { set: '', states: [] };
                    });
                }));
            }).then(function (found) {
                if (mod.loaded !== key) { return; }
                if (found.length === 1 && found[0] === null) { unset(); digest(); return; }
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
     * tags — per-attribute settings edited as rows in a format pane
     * ================================================================== *
     * Some settings belong to one attribute, named by the label the symbol
     * shows for it, in a comma separated list:
     *   range    Label: low..high    pvxDataHealth Ranges
     *   minutes  Label: minutes      pvxDataHealth UpdateOverrides
     *
     * Typed by hand these go wrong quietly: "Pump 1 Amps" for a row the
     * symbol labels "Pump 1|Amps" matches nothing, and the tag is simply
     * never range-checked. So build.js expands a marker in config.html
     *   <!-- pvx:tags key=Ranges kind=range -->
     * into rows (src/shared/config-tags.html) whose attribute is chosen from
     * the labels the symbol is showing, with number fields for the value.
     * The stored value stays the grammar string, and the symbol reads it with
     * tags.parse below, so the pane and the symbol cannot disagree on it.
     *
     * FILL FROM PI (range only)
     *   PI Vision does not pass an attribute's span to a symbol, but PI Web
     *   API has it: an AF attribute's Minimum and Maximum limit traits, else
     *   the Zero and Span of the PI point behind it. The pane reads them once,
     *   when asked, and writes plain rows; nothing is read while a display is
     *   open, so the symbol needs no PI Web API at run time. Proven against
     *   the mock in tools/test-tags.js only, not yet a server.
     */
    var tags = PVX.tags = {};

    tags.KINDS = { range: true, minutes: true };

    var TG_NUM = '-?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?';
    var TG_RANGE = new RegExp('^(' + TG_NUM + ')\\s*\\.\\.\\s*(' + TG_NUM + ')$', 'i');

    /**
     * Grammar string -> [{label, lo, hi, minutes, valid}] in the order written.
     * The LAST colon splits the label from the value, so an AF-style label
     * holding a colon still parses. Entries separate on commas or newlines
     * only, never semicolons. An entry the symbol cannot use is returned with
     * valid false rather than dropped, so the pane can show it.
     */
    tags.parse = function (spec, kind) {
        var out = [];
        String(spec === null || spec === undefined ? '' : spec).split(/[,\n]/).forEach(function (chunk) {
            var s = stTrim(chunk);
            if (!s) { return; }
            var at = s.lastIndexOf(':');
            var label = at > 0 ? stTrim(s.slice(0, at)) : s;
            var v = at > 0 ? stTrim(s.slice(at + 1)) : '';
            var e = { label: label, lo: null, hi: null, minutes: null, valid: false };
            if (kind === 'minutes') {
                var n = util.num(v);
                if (n !== null && n >= 0) { e.minutes = n; e.valid = at > 0 && !!label; }
            } else {
                var m = TG_RANGE.exec(v);
                if (m) { e.lo = util.num(m[1]); e.hi = util.num(m[2]); }
                e.valid = at > 0 && !!label && e.lo !== null && e.hi !== null;
            }
            out.push(e);
        });
        return out;
    };

    tags.stringify = function (list, kind) {
        return (list || []).map(function (e) {
            return e.label + ': ' + (kind === 'minutes' ? e.minutes : e.lo + '..' + e.hi);
        }).join(', ');
    };

    /** Round away float noise, so 0.1 + 0.2 is stored as 0.3. */
    function tgRound(n) { return parseFloat(n.toPrecision(12)); }

    // Per page, keyed by source path, like the digital set cache.
    var spanCache = {};

    /**
     * The instrument span of one data source: {lo, hi, from} or null when PI
     * has none. AF Minimum/Maximum limit traits first, because that is where
     * an AF model keeps the range it means; then Zero/Span of the PI point,
     * which every numeric point has. Rejects on a request that fails.
     */
    tags.lookupSpan = function (ds) {
        var p = states.sourcePath(ds);
        if (!p) { return Promise.resolve(null); }
        var k = p.toLowerCase();
        if (spanCache[k]) { return spanCache[k]; }

        var fromPoint = function (pt) {
            // A digital point's Zero/Span count states, not engineering units.
            if (!pt || !pt.WebId || String(pt.PointType || '').toLowerCase() === 'digital') { return null; }
            var id = encodeURIComponent(pt.WebId);
            return Promise.all([
                api.get('points/' + id + '/attributes/zero'),
                api.get('points/' + id + '/attributes/span')
            ]).then(function (r) {
                var lo = util.num(r[0] && r[0].Value);
                var span = util.num(r[1] && r[1].Value);
                if (lo === null || span === null || !(span > 0)) { return null; }
                return { lo: lo, hi: tgRound(lo + span), from: 'PI point Zero/Span' };
            });
        };

        // One trait at a time, so which value is which never depends on the
        // order or the names PI Web API returns them under.
        var trait = function (webId, name) {
            return api.get('attributes/' + encodeURIComponent(webId) + '/attributes?trait=' + name).then(function (r) {
                var it = ((r && r.Items) || [])[0];
                if (!it || !it.WebId) { return null; }
                return api.get('streams/' + encodeURIComponent(it.WebId) + '/value').then(function (v) {
                    return util.num(v && v.Value);
                });
            });
        };

        var job;
        if (p.indexOf('|') !== -1) {
            job = api.get('attributes?path=' + encodeURIComponent(p)).then(function (a) {
                if (!a || !a.WebId) { return null; }
                return Promise.all([trait(a.WebId, 'Minimum'), trait(a.WebId, 'Maximum')]).then(function (t) {
                    if (t[0] !== null && t[1] !== null && t[1] > t[0]) {
                        return { lo: t[0], hi: t[1], from: 'AF Minimum/Maximum limits' };
                    }
                    var links = a.Links || {};
                    return links.Point ? api.get(links.Point).then(fromPoint) : null;
                });
            });
        } else {
            job = api.get('points?path=' + encodeURIComponent(p)).then(fromPoint);
        }
        spanCache[k] = job;
        job.then(null, function () { if (spanCache[k] === job) { delete spanCache[k]; } });
        return job;
    };

    tags.clearCache = function () { spanCache = {}; };

    /* ------------------------------------------------------------------ *
     * af — settings kept in AF rather than in each display
     * ------------------------------------------------------------------ *
     * A target, a limit or a menu typed into a display is copied into every
     * display that needs it, and goes stale in all but the one someone
     * remembers to edit. Kept in AF, it is changed once. These read it.
     */
    var af = PVX.af = {};

    /** Trait names PI Web API knows for AF limit attributes. */
    af.TRAITS = ['Minimum', 'LoLo', 'Lo', 'Target', 'Hi', 'HiHi', 'Maximum'];

    var afAttr = {};        // attribute path -> Promise of its WebId
    var afTrait = {};       // attribute WebId + trait -> Promise of the trait's WebId or ''
    var afValue = {};       // stream WebId -> {at, job}
    var AF_VALUE_TTL = 60000;

    function afOnce(store, key, make) {
        if (store[key]) { return store[key]; }
        var job = make();
        store[key] = job;
        // A failure is forgotten, so an outage does not stick for the life of the page.
        job.then(null, function () { if (store[key] === job) { delete store[key]; } });
        return job;
    }

    function afRead(webId) {
        var now = (new Date()).getTime();
        var hit = afValue[webId];
        if (hit && now - hit.at < AF_VALUE_TTL) { return hit.job; }
        var job = api.get('streams/' + encodeURIComponent(webId) + '/value?selectedFields=Value;Good', { cache: false });
        afValue[webId] = { at: now, job: job };
        job.then(null, function () { if (afValue[webId] && afValue[webId].job === job) { delete afValue[webId]; } });
        return job;
    }

    /**
     * The AF limit traits of the attribute behind a data source, as numbers:
     * {Hi: 120, Lo: 80, Target: null, ...} for the names asked, null where
     * the attribute has no such trait or its value is not a number. A PI
     * point has no traits, and gives every name null. Values are re-read at
     * most once a minute, however many symbols ask.
     * @param {String} ds a data source as PI Vision stores it, or an AF attribute path
     * @param {Array} names trait names from af.TRAITS
     */
    af.traits = function (ds, names) {
        var p = states.sourcePath(ds);
        var out = {};
        (names || []).forEach(function (n) { out[n] = null; });
        if (!p || p.indexOf('|') === -1) { return Promise.resolve(out); }
        return afOnce(afAttr, p.toLowerCase(), function () {
            return api.get('attributes?path=' + encodeURIComponent(p) + '&selectedFields=WebId').then(function (a) {
                if (!a || !a.WebId) { throw { pvxError: { message: 'No AF attribute at "' + p + '".', check: 'the data source' } }; }
                return a.WebId;
            });
        }).then(function (attrId) {
            return Promise.all((names || []).map(function (n) {
                return afOnce(afTrait, attrId + '|' + n, function () {
                    return api.get('attributes/' + encodeURIComponent(attrId) + '/attributes?trait=' + encodeURIComponent(n) +
                        '&selectedFields=Items.WebId').then(function (r) {
                            var it = ((r && r.Items) || [])[0];
                            return it && it.WebId ? it.WebId : '';
                        });
                }).then(function (traitId) {
                    if (!traitId) { return null; }
                    return afRead(traitId).then(function (v) { return v && v.Good !== false ? util.num(v.Value) : null; });
                });
            })).then(function (vals) {
                (names || []).forEach(function (n, i) { out[n] = vals[i]; });
                return out;
            });
        });
    };

    /**
     * The current value of one AF attribute, by path, as text: for a menu,
     * a list or a setting kept as a string attribute. Re-read at most once a
     * minute. Rejects when the attribute is not there, so the caller can say so.
     */
    af.text = function (path) {
        var p = stTrim(path);
        if (!p) { return Promise.resolve(''); }
        return afOnce(afAttr, p.toLowerCase(), function () {
            return api.get('attributes?path=' + encodeURIComponent(p) + '&selectedFields=WebId').then(function (a) {
                if (!a || !a.WebId) { throw { pvxError: { message: 'No AF attribute at "' + p + '".', check: 'the attribute path' } }; }
                return a.WebId;
            });
        }).then(afRead).then(function (v) {
            var raw = v ? v.Value : '';
            if (raw && typeof raw === 'object') { raw = raw.Name !== undefined ? raw.Name : raw.Value; }
            return raw === null || raw === undefined ? '' : String(raw);
        });
    };

    af.clearCache = function () { afAttr = {}; afTrait = {}; afValue = {}; };

    /**
     * Trait reading for one symbol: ask() on every data update and config
     * change, get() in render. It asks PI Web API only when the attribute or
     * the names change, else once a minute, and calls onChange when an answer
     * (or a reason there is none) arrives, so the symbol re-renders.
     *   phase: 'off' | 'loading' | 'ok' | 'error', with error worded for a footer.
     */
    af.watcher = function (onChange) {
        var w = { key: '', at: 0, vals: null, error: '', phase: 'off', gen: 0 };
        var changed = function () { if (onChange) { onChange(); } };
        w.ask = function (ds, names) {
            names = (names || []).filter(function (n, i, all) { return af.TRAITS.indexOf(n) !== -1 && all.indexOf(n) === i; });
            if (!names.length) { w.phase = 'off'; w.key = ''; return; }
            var path = states.sourcePath(ds);
            var key = path + '\u0001' + names.join(',');
            var now = (new Date()).getTime();
            if (key === w.key && now - w.at < AF_VALUE_TTL) { return; }
            w.key = key;
            w.at = now;
            if (path.indexOf('|') === -1) {
                w.phase = 'error';
                w.error = path ? 'the data source is a PI point, which has no AF limit traits' : 'no data source';
                changed();
                return;
            }
            if (api.discovering()) {
                w.key = '';
                api.discover().then(function () { w.ask(ds, names); });
                return;
            }
            if (!api.isConfigured()) {
                w.phase = 'error';
                w.error = api.unsetHint() + ', then confirm it with ext/piwebapi-check.html';
                changed();
                return;
            }
            var gen = ++w.gen;
            if (w.phase !== 'ok') { w.phase = 'loading'; }
            af.traits(path, names).then(function (v) {
                if (gen !== w.gen) { return; }
                w.vals = v;
                w.phase = 'ok';
                w.error = '';
                changed();
            }, function (err) {
                if (gen !== w.gen) { return; }
                w.phase = 'error';
                w.error = (err && err.pvxError && err.pvxError.message) || 'the AF limit traits could not be read';
                w.key = '';
                changed();
            });
        };
        w.get = function (name) {
            return w.phase === 'ok' && w.vals && w.vals[name] !== undefined ? w.vals[name] : null;
        };
        w.stop = function () { w.gen += 1; onChange = null; };
        return w;
    };

    /** Labels of a PI Vision data object, in data source order. */
    tags.labelsIn = function (d) {
        var items = d && (d.Data || d.data || d.Rows || d.rows);
        if (!items && Object.prototype.toString.call(d) === '[object Array]') { items = d; }
        var out = [];
        for (var i = 0; items && i < items.length; i++) {
            var it = items[i] || {};
            out.push(stTrim(it.Label !== undefined ? it.Label : it.label));
        }
        return out;
    };

    /**
     * Publish the editor at runtimeData.pvxTags. Editors are made per config
     * key by use(), from the pane, so a symbol whose pane has none pays
     * nothing, and PI Web API is only asked when Fill from PI is pressed.
     *
     * @param {Object} scope the symbol's Angular scope
     * @returns {Object} state, also at scope.runtimeData.pvxTags
     */
    tags.bind = function (scope) {
        if (!scope) { return null; }
        if (!scope.runtimeData) { scope.runtimeData = {}; }

        var mod = {
            ed: {},
            labels: [],         // the symbol's labels, by data source position
            busy: false,
            note: '',
            version: 0
        };

        mod.digest = function () {
            try { if (scope.$evalAsync) { scope.$evalAsync(function () {}); } } catch (e) { /* no Angular: tests */ }
        };

        mod.sourceList = function () {
            var ds = scope.symbol && scope.symbol.DataSources;
            var out = [];
            if (ds && typeof ds.length === 'number') { for (var i = 0; i < ds.length; i++) { out.push(String(ds[i])); } }
            return out;
        };

        /** Feed live data in; called by bootstrap on every data update. */
        mod.observe = function (d) {
            var l = tags.labelsIn(d);
            if (!l.length || l.join('\n') === mod.labels.join('\n')) { return; }
            mod.labels = l;
            mod.version += 1;
        };

        /**
         * The editor for one config key, made on first use.
         * @param {String} key  config key, e.g. 'Ranges'
         * @param {String} kind range | minutes
         */
        mod.use = function (key, kind) {
            if (!mod.ed[key]) { mod.ed[key] = makeTagEditor(mod, key, tags.KINDS[kind] ? kind : 'range'); }
            return mod.ed[key];
        };

        mod.destroy = function () { mod.ed = {}; };

        scope.runtimeData.pvxTags = mod;
        return mod;
    };

    function makeTagEditor(mod, key, kind) {
        var ed = {
            key: key,
            kind: kind,
            rows: [],
            textMode: false,
            written: null,      // the last string this editor wrote or loaded
            choices: [],
            built: -1           // mod.version + rows the choices were built for
        };

        ed.load = function (spec) {
            var list = tags.parse(spec, kind);
            var rows = [];
            for (var i = 0; i < list.length; i++) {
                rows.push({ label: list[i].label, lo: list[i].lo, hi: list[i].hi, minutes: list[i].minutes,
                            typed: false, invalid: !list[i].valid });
            }
            ed.rows = rows;
            ed.written = spec === undefined || spec === null ? '' : String(spec);
            ed.built = -1;
        };

        /** As PVX.states: rows are rebuilt only when something else changed the string. */
        ed.sync = function (spec) {
            var s = spec === undefined || spec === null ? '' : String(spec);
            if (s !== ed.written) { ed.load(spec); }
            return true;
        };

        var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : util.num(v); };

        /** Write the rows back as the grammar string, into the pane's config. */
        ed.commit = function (cfg) {
            var out = [];
            var seen = {};
            for (var i = 0; i < ed.rows.length; i++) {
                var r = ed.rows[i];
                var label = stTrim(r.label);
                // A comma or line break would split the entry in two, and
                // unlike a state name the label cannot be changed to suit:
                // it has to match the symbol's. Such a row is flagged, not stored.
                r.separator = /[,\r\n]/.test(label);
                var e = { label: label, lo: num(r.lo), hi: num(r.hi), minutes: num(r.minutes) };
                r.invalid = !label || r.separator ||
                    (kind === 'minutes' ? e.minutes === null || e.minutes < 0 : e.lo === null || e.hi === null);
                r.duplicate = !!label && !!seen[label.toLowerCase()];
                if (label) { seen[label.toLowerCase()] = true; }
                if (!r.invalid) { out.push(e); }
            }
            ed.written = tags.stringify(out, kind);
            ed.built = -1;
            if (cfg) { cfg[key] = ed.written; }
            return ed.written;
        };

        /** A new row takes the first label the symbol shows that has none. */
        ed.add = function (cfg) {
            var used = {};
            for (var i = 0; i < ed.rows.length; i++) { used[stTrim(ed.rows[i].label).toLowerCase()] = true; }
            var next = '';
            for (var j = 0; j < mod.labels.length; j++) {
                if (mod.labels[j] && !used[mod.labels[j].toLowerCase()]) { next = mod.labels[j]; break; }
            }
            ed.rows.push({ label: next, lo: null, hi: null, minutes: kind === 'minutes' ? 0 : null,
                           typed: !ed.options().length });
            return ed.commit(cfg);
        };

        ed.remove = function (i, cfg) {
            if (i < 0 || i >= ed.rows.length) { return ed.written; }
            ed.rows.splice(i, 1);
            return ed.commit(cfg);
        };

        ed.type = function (r) { r.typed = !r.typed; ed.built = -1; };
        ed.toggleText = function () { ed.textMode = !ed.textMode; };

        var any = function (f) {
            for (var i = 0; i < ed.rows.length; i++) { if (ed.rows[i][f]) { return true; } }
            return false;
        };
        ed.hasInvalid = function () { return any('invalid'); };
        ed.hasDuplicate = function () { return any('duplicate'); };
        ed.hasSeparator = function () { return any('separator'); };

        /** True when some row names a label the symbol is not showing. */
        ed.hasUnknown = function () {
            if (!mod.labels.length) { return false; }
            var have = {};
            for (var i = 0; i < mod.labels.length; i++) { have[mod.labels[i].toLowerCase()] = true; }
            for (var j = 0; j < ed.rows.length; j++) {
                var l = stTrim(ed.rows[j].label).toLowerCase();
                if (l && !have[l]) { return true; }
            }
            return false;
        };

        /**
         * The labels a row can name: the symbol's own, then any already in
         * this list that it is not showing, so a saved entry stays selectable
         * and visibly apart. Same array until something changes.
         */
        ed.options = function () {
            var sig = mod.version + '/' + ed.written;
            if (ed.built === sig) { return ed.choices; }
            var out = [];
            var have = {};
            var push = function (name, group) {
                var s = stTrim(name);
                if (!s || have[s.toLowerCase()]) { return; }
                have[s.toLowerCase()] = true;
                out.push({ name: s, group: group });
            };
            var i;
            for (i = 0; i < mod.labels.length; i++) { push(mod.labels[i], 'Attributes on this symbol'); }
            for (i = 0; i < ed.rows.length; i++) { push(ed.rows[i].label, 'Not on this symbol'); }
            ed.choices = out;
            ed.built = sig;
            return out;
        };

        /**
         * Add a row for every attribute that has no row yet and whose span PI
         * knows. A row already there is the user's word and is left alone.
         */
        ed.fill = function (cfg) {
            if (kind !== 'range') { return Promise.resolve(ed.written); }
            var unset = function () {
                mod.note = 'PI Web API is not set up for this site, so spans cannot be read from PI. ' +
                    'Enter them in the rows instead.';
                return ed.written;
            };
            if (!api.isConfigured()) { return Promise.resolve(unset()); }
            if (api.isAuto()) {
                // Ask whether there is a PI Web API before asking it anything.
                return api.ready().then(function (ok) {
                    if (!ok) { var w = unset(); mod.digest(); return w; }
                    return fillFrom(cfg);
                });
            }
            return fillFrom(cfg);
        };

        var fillFrom = function (cfg) {
            var list = mod.sourceList();
            var have = {};
            for (var h = 0; h < ed.rows.length; h++) { have[stTrim(ed.rows[h].label).toLowerCase()] = true; }
            var jobs = [];
            var unlabelled = 0;
            for (var i = 0; i < list.length; i++) {
                var label = mod.labels[i] || '';
                if (!label) { unlabelled++; continue; }
                if (have[label.toLowerCase()]) { continue; }
                jobs.push((function (ds, lab) {
                    return tags.lookupSpan(ds).then(function (s) { return { label: lab, span: s }; },
                        function (e) { return { label: lab, error: stErr(e) }; });
                }(list[i], label)));
            }
            var kept = ed.rows.length;
            mod.busy = true;
            mod.note = '';
            return Promise.all(jobs).then(function (found) {
                var added = [], none = [], failed = [];
                for (var j = 0; j < found.length; j++) {
                    var f = found[j];
                    if (f.error) { failed.push(f.label + ': ' + f.error); continue; }
                    if (!f.span) { none.push(f.label); continue; }
                    ed.rows.push({ label: f.label, lo: f.span.lo, hi: f.span.hi, minutes: null, typed: false });
                    added.push(f.label + ' (' + f.span.from + ')');
                }
                var said = [];
                said.push(added.length ? 'Added ' + added.length + ' from PI: ' + added.join(', ') + '.' :
                    'Nothing added from PI.');
                if (kept) { said.push(kept + ' row' + (kept === 1 ? ' was' : 's were') + ' already set and left as they are.'); }
                if (none.length) {
                    said.push('No Minimum/Maximum limits or point Zero/Span in PI for ' + none.join(', ') + '.');
                }
                if (unlabelled) {
                    said.push(unlabelled + ' data source' + (unlabelled === 1 ? ' has' : 's have') +
                        ' no live data yet to name it; try again once the symbol shows values.');
                }
                if (failed.length) {
                    said.push('Could not read ' + failed.join('; ') + '. Check the data source in PI Web API.');
                }
                mod.note = said.join(' ');
                mod.busy = false;
                var out = ed.commit(cfg);
                mod.digest();
                return out;
            });
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

    /**
     * A gauge's ticks: majors from ticks() plus both ends, the band limits
     * when asked (an operator reads a dial by its limits, not by round
     * numbers), and minorPer evenly spaced minors between majors. Returns
     * {major:[{v, band}], minor:[v]}, majors ascending. A band limit within
     * a third of a step of a round tick replaces it rather than crowding it.
     */
    scale.gaugeTicks = function (min, max, count, opts) {
        var o = opts || {};
        var span = (max - min) || 1;
        var near = Math.max(span * 0.015, scale.tickStep(min, max, count) * 0.34);
        var major = [];
        var base = scale.ticks(min, max, count);
        if (!base.length || base[0] > min + span * 1e-6) { base.unshift(min); }
        if (base[base.length - 1] < max - span * 1e-6) { base.push(max); }
        var i, j;
        for (i = 0; i < base.length; i++) {
            if (base[i] >= min - span * 1e-9 && base[i] <= max + span * 1e-9) { major.push({ v: base[i], band: false }); }
        }
        var edges = o.bandEdges || [];
        for (i = 0; i < edges.length; i++) {
            var e = edges[i];
            if (!(e > min + near && e < max - near)) { continue; }
            var replaced = false;
            for (j = 0; j < major.length; j++) {
                if (Math.abs(major[j].v - e) <= near && j > 0 && j < major.length - 1) {
                    major[j] = { v: e, band: true };
                    replaced = true;
                    break;
                }
            }
            if (!replaced) { major.push({ v: e, band: true }); }
        }
        major.sort(function (a, b) { return a.v - b.v; });
        var minor = [];
        var per = Math.max(0, Math.min(9, parseInt(o.minorPer, 10) || 0));
        if (per && base.length > 1) {
            for (i = 0; i + 1 < base.length; i++) {
                var a = base[i], b = base[i + 1];
                for (j = 1; j <= per; j++) {
                    var mv = a + (b - a) * j / (per + 1);
                    if (mv > min && mv < max) { minor.push(mv); }
                }
            }
        }
        return { major: major, minor: minor };
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

    /**
     * Carry each data source's metadata forward across data updates.
     *
     * PI Vision sends Label, Units and Path with the first update and then only
     * periodically; the updates in between carry values alone (AVEVA's
     * extensibility guide caches `data.Label` for this reason). Normalizing
     * each update on its own therefore fell back to "Series 1" on most
     * updates and back to the real name on the next one with metadata, so
     * every PVX label flickered on a live server. The harness never showed it
     * because the mock sent metadata every time.
     *
     * Returns a factory: one instance per symbol, called on every update. It
     * fills a missing field from the last update that had it and returns a
     * shallow copy, leaving PI Vision's own objects untouched. Entries are
     * keyed by the data source's own string where `sourceList()` gives one
     * per item, so a removed or reordered source cannot inherit its
     * neighbour's name; otherwise by position. Units is only filled when
     * absent, because '' is a real answer for a unitless tag.
     */
    var META_FIELDS = ['Label', 'Units', 'Path', 'Description'];

    var shallow = function (obj) {
        var out = {};
        for (var k in obj) { if (Object.prototype.hasOwnProperty.call(obj, k)) { out[k] = obj[k]; } }
        return out;
    };

    data.metaCarry = function (sourceList) {
        var cache = {};

        var carry = function (item, key) {
            if (!item || typeof item !== 'object') { return item; }
            var seen = cache[key] || (cache[key] = {});
            var copy = null;
            for (var i = 0; i < META_FIELDS.length; i++) {
                var f = META_FIELDS[i];
                var v = pick(item, [f, f.charAt(0).toLowerCase() + f.slice(1)]);
                if (v !== undefined && (v !== '' || f === 'Units')) {
                    seen[f] = v;
                } else if (seen[f] !== undefined) {
                    copy = copy || shallow(item);
                    copy[f] = seen[f];
                }
            }
            return copy || item;
        };

        var carryList = function (items, sources) {
            var byName = sources && sources.length === items.length;
            var out = [];
            for (var i = 0; i < items.length; i++) {
                out.push(carry(items[i], byName ? 's:' + sources[i] : 'i:' + i));
            }
            return out;
        };

        var isList = function (v) { return Object.prototype.toString.call(v) === '[object Array]'; };

        return function (d) {
            if (!d || typeof d !== 'object') { return d; }
            var sources = null;
            try { sources = sourceList ? sourceList() : null; } catch (e) { sources = null; }
            if (isList(d)) { return carryList(d, sources); }
            var out = null;
            var keys = ['Data', 'data', 'Rows', 'rows', 'Traces'];
            for (var k = 0; k < keys.length; k++) {
                if (isList(d[keys[k]])) {
                    out = out || shallow(d);
                    out[keys[k]] = carryList(d[keys[k]], sources);
                }
            }
            // Value and Gauge put the one source's fields on the payload itself.
            return out || carry(d, sources && sources.length === 1 ? 's:' + sources[0] : 'i:0');
        };
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
                // Rows from an AF search (PVX.afsource) say which asset and
                // attribute they are; the pipeline's rows leave these blank.
                asset: pick(r, ['Asset']) || '',
                assetPath: pick(r, ['AssetPath']) || '',
                attribute: pick(r, ['Attribute']) || '',
                parent: pick(r, ['Parent']) || '',
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

    /**
     * Least-squares polynomial y = c0 + c1 x + ... + cd x^d over [{x, y}],
     * degree 1 to 4. Returns {coef, r2, n} or null.
     *
     * Solved on x centred and scaled to about -1..1: the normal equations of
     * a cubic in raw process values (x near 1500) hold x^6 near 1e19, and
     * the solve loses every digit that matters. The coefficients are mapped
     * back to raw x afterwards, so callers evaluate them directly.
     */
    stats.polyfit = function (pts, degree) {
        var d = Math.max(1, Math.min(4, parseInt(degree, 10) || 1));
        var xs = [], ys = [], i, j, k;
        for (i = 0; i < (pts || []).length; i++) {
            var x = util.num(pts[i].x), y = util.num(pts[i].y);
            if (x === null || y === null) { continue; }
            xs.push(x); ys.push(y);
        }
        var n = xs.length;
        if (n < d + 1) { return null; }
        var lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
        if (!(hi > lo)) { return null; }
        var mid = (lo + hi) / 2, half = (hi - lo) / 2;
        var m = d + 1;
        var A = [], b = [];
        for (i = 0; i < m; i++) { A.push([]); b.push(0); for (j = 0; j < m; j++) { A[i].push(0); } }
        for (k = 0; k < n; k++) {
            var u = (xs[k] - mid) / half, pw = [1];
            for (i = 1; i < 2 * m; i++) { pw.push(pw[i - 1] * u); }
            for (i = 0; i < m; i++) {
                b[i] += pw[i] * ys[k];
                for (j = 0; j < m; j++) { A[i][j] += pw[i + j]; }
            }
        }
        // Gaussian elimination with partial pivoting.
        for (i = 0; i < m; i++) {
            var p = i;
            for (k = i + 1; k < m; k++) { if (Math.abs(A[k][i]) > Math.abs(A[p][i])) { p = k; } }
            if (Math.abs(A[p][i]) < 1e-12) { return null; }
            var tmp = A[i]; A[i] = A[p]; A[p] = tmp;
            var tb = b[i]; b[i] = b[p]; b[p] = tb;
            for (k = i + 1; k < m; k++) {
                var f = A[k][i] / A[i][i];
                for (j = i; j < m; j++) { A[k][j] -= f * A[i][j]; }
                b[k] -= f * b[i];
            }
        }
        var cu = [];
        for (i = m - 1; i >= 0; i--) {
            var s = b[i];
            for (j = i + 1; j < m; j++) { s -= A[i][j] * cu[j]; }
            cu[i] = s / A[i][i];
        }
        // Back to raw x: sum cu_i ((x - mid)/half)^i, expanded binomially.
        var coef = [];
        for (i = 0; i < m; i++) { coef.push(0); }
        for (i = 0; i < m; i++) {
            var scale = cu[i] / Math.pow(half, i);
            var binom = 1;
            for (j = 0; j <= i; j++) {
                // term: C(i,j) x^j (-mid)^(i-j)
                coef[j] += scale * binom * Math.pow(-mid, i - j);
                binom = binom * (i - j) / (j + 1);
            }
        }
        // The expansion leaves rounding residue (an exact x^2 comes back with
        // -5e-15 x). A term worth less than a billionth of the data across
        // the whole range is that residue; shown, it reads as a real term.
        var yMag = 0, xMag = Math.max(Math.abs(lo), Math.abs(hi));
        for (k = 0; k < n; k++) { yMag = Math.max(yMag, Math.abs(ys[k])); }
        for (j = 0; j < m; j++) {
            if (Math.abs(coef[j]) * Math.pow(xMag, j) < 1e-9 * (yMag || 1)) { coef[j] = 0; }
        }
        var mean = 0;
        for (k = 0; k < n; k++) { mean += ys[k]; }
        mean /= n;
        var ssr = 0, sst = 0;
        for (k = 0; k < n; k++) {
            var uu = (xs[k] - mid) / half, fit = 0;
            for (i = m - 1; i >= 0; i--) { fit = fit * uu + cu[i]; }
            ssr += (ys[k] - fit) * (ys[k] - fit);
            sst += (ys[k] - mean) * (ys[k] - mean);
        }
        return { coef: coef, r2: sst > 0 ? 1 - ssr / sst : 0, n: n, degree: d };
    };

    /** A polynomial's value: coef[0] + coef[1] x + ... */
    stats.polyval = function (coef, x) {
        var y = 0;
        for (var i = coef.length - 1; i >= 0; i--) { y = y * x + coef[i]; }
        return y;
    };

    /** Is the point inside the polygon [[x, y], ...]? Even-odd rule. */
    stats.inPolygon = function (x, y, poly) {
        var inside = false;
        for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
            var xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
            if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) { inside = !inside; }
        }
        return inside;
    };

    /**
     * In-place radix-2 FFT of re[] / im[]; the length must be a power of two.
     * Iterative Cooley-Tukey: fast enough for 8192 points on every refresh.
     */
    stats.fft = function (re, im) {
        var n = re.length, i, j, k, len;
        for (i = 1, j = 0; i < n; i++) {
            var bit = n >> 1;
            for (; j & bit; bit >>= 1) { j ^= bit; }
            j ^= bit;
            if (i < j) {
                var tr = re[i]; re[i] = re[j]; re[j] = tr;
                var ti = im[i]; im[i] = im[j]; im[j] = ti;
            }
        }
        for (len = 2; len <= n; len <<= 1) {
            var ang = -2 * Math.PI / len;
            var wr = Math.cos(ang), wi = Math.sin(ang);
            for (i = 0; i < n; i += len) {
                var cr = 1, ci = 0;
                for (k = 0; k < len / 2; k++) {
                    var a = i + k, b = a + len / 2;
                    var xr = re[b] * cr - im[b] * ci;
                    var xi = re[b] * ci + im[b] * cr;
                    re[b] = re[a] - xr; im[b] = im[a] - xi;
                    re[a] += xr; im[a] += xi;
                    var nr = cr * wr - ci * wi;
                    ci = cr * wi + ci * wr;
                    cr = nr;
                }
            }
        }
    };

    /**
     * Single-sided amplitude spectrum of a time series.
     *
     * Process data is not evenly sampled (exception reporting and compression
     * store a value only when it changes), and an FFT assumes it is. So the
     * values are first resampled onto n evenly spaced times across their own
     * span, by linear interpolation or by holding each value, and the result
     * says how many recorded values that grid was made from: a grid much
     * finer than the data shows the interpolation, not the process.
     *
     * Amplitude is in the tag's own units: a sine of amplitude A at a bin's
     * frequency reads A, whatever the window, because each window is
     * corrected by its own coherent gain.
     *
     * @param pts  [{t (ms), v}] in time order; non-numbers are counted out
     * @param opts {n (power of two, default 512), window hann|hamming|blackman|rect,
     *              detrend mean|linear|none, interp linear|step}
     * @returns {freq: [Hz], amp: [], dt (s), n, used, excluded, span (s)} or null
     */
    stats.spectrum = function (pts, opts) {
        opts = opts || {};
        var n = 512;
        var want = parseInt(opts.n, 10);
        if (want > 0) { n = 16; while (n < want && n < 65536) { n *= 2; } }
        var xs = [], excluded = 0, i;
        for (i = 0; i < (pts || []).length; i++) {
            var p = pts[i];
            var v = p ? util.num(p.v) : null;
            if (!p || v === null || !isFinite(p.t)) { excluded += 1; continue; }
            if (xs.length && p.t <= xs[xs.length - 1].t) {
                // Two values at one time: keep the later, as PI does.
                if (p.t === xs[xs.length - 1].t) { xs[xs.length - 1].v = v; }
                continue;
            }
            xs.push({ t: p.t, v: v });
        }
        if (xs.length < 4) { return null; }
        var t0 = xs[0].t, span = xs[xs.length - 1].t - t0;
        if (!(span > 0)) { return null; }
        var dt = span / n;
        var re = [], im = [], j = 0;
        for (i = 0; i < n; i++) {
            var t = t0 + i * dt;
            while (j < xs.length - 2 && xs[j + 1].t <= t) { j++; }
            var a = xs[j], b = xs[j + 1];
            var y = opts.interp === 'step' || t <= a.t ? a.v
                : (t >= b.t ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t));
            re.push(y);
            im.push(0);
        }
        // Remove the level (and slope): left in, it fills the lowest bins
        // and the window spreads it into everything near them.
        var det = opts.detrend || 'mean';
        if (det !== 'none') {
            var sx = 0, sy = 0, sxx = 0, sxy = 0;
            for (i = 0; i < n; i++) { sx += i; sy += re[i]; sxx += i * i; sxy += i * re[i]; }
            var slope = det === 'linear' ? (n * sxy - sx * sy) / (n * sxx - sx * sx) : 0;
            var icpt = (sy - slope * sx) / n;
            for (i = 0; i < n; i++) { re[i] -= icpt + slope * i; }
        }
        var win = opts.window || 'hann', wsum = 0;
        for (i = 0; i < n; i++) {
            var x = 2 * Math.PI * i / (n - 1), w = 1;
            if (win === 'hann') { w = 0.5 - 0.5 * Math.cos(x); }
            else if (win === 'hamming') { w = 0.54 - 0.46 * Math.cos(x); }
            else if (win === 'blackman') { w = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x); }
            re[i] *= w;
            wsum += w;
        }
        stats.fft(re, im);
        var freq = [], amp = [], dtS = dt / 1000;
        for (i = 0; i <= n / 2; i++) {
            var mag = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / wsum;
            freq.push(i / (n * dtS));
            amp.push(i === 0 || i === n / 2 ? mag : 2 * mag);
        }
        return { freq: freq, amp: amp, dt: dtS, n: n, used: xs.length, excluded: excluded, span: span / 1000 };
    };

    /**
     * The k largest local maxima of a spectrum, above bin `from`, largest
     * first, each refined between bins by a parabola through its neighbours.
     */
    stats.spectrumPeaks = function (freq, amp, k, from) {
        var out = [];
        for (var i = Math.max(1, from || 1); i < amp.length - 1; i++) {
            if (amp[i] > amp[i - 1] && amp[i] >= amp[i + 1] && amp[i] > 0) {
                var a = amp[i - 1], b = amp[i], c = amp[i + 1];
                var den = a - 2 * b + c;
                var off = den !== 0 ? 0.5 * (a - c) / den : 0;
                off = Math.max(-0.5, Math.min(0.5, off));
                out.push({ index: i, freq: freq[i] + off * (freq[1] - freq[0]), amp: b - 0.25 * (a - c) * off });
            }
        }
        out.sort(function (p, q) { return q.amp - p.amp; });
        return out.slice(0, Math.max(0, k));
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
     * stats.spc: control charts
     * ------------------------------------------------------------------ *
     * The constants are the standard bias-correction factors for estimating
     * sigma from subgroup ranges (d2, d3) and standard deviations (c4), for
     * subgroup sizes 2 to 10. Limits are written as "k sigma" rather than with
     * the familiar A2/D3/D4 tables, because those tables only exist for k = 3
     * and the symbol lets an engineer choose 2 to 4.
     */
    stats.SPC_D2 = { 2: 1.128, 3: 1.693, 4: 2.059, 5: 2.326, 6: 2.534, 7: 2.704, 8: 2.847, 9: 2.970, 10: 3.078 };
    stats.SPC_D3 = { 2: 0.853, 3: 0.888, 4: 0.880, 5: 0.864, 6: 0.848, 7: 0.833, 8: 0.820, 9: 0.808, 10: 0.797 };
    stats.SPC_C4 = { 2: 0.7979, 3: 0.8862, 4: 0.9213, 5: 0.9400, 6: 0.9515, 7: 0.9594, 8: 0.9650, 9: 0.9693, 10: 0.9727 };

    /**
     * Interval averages of a time-ordered stream, time-weighted with straight
     * lines between samples (PI's own interpolation for a non-step tag).
     *
     * A control chart cannot use PI Vision's plot values: those are the
     * minimum and maximum of each pixel column, so consecutive points
     * alternate by construction and Nelson rule 4 fires on a perfectly
     * steady process. Recorded values are honest but uneven in time on a
     * compressed tag; averaging them onto a fixed grid gives the evenly
     * spaced individuals the rules assume. An interval with no sample inside
     * it and none either side yields null rather than an invented number.
     */
    stats.intervalAverages = function (points, fromMs, toMs, count) {
        var n = Math.max(1, parseInt(count, 10) || 1);
        var pts = (points || []).filter(function (p) { return p && util.isNum(p.v) && util.isNum(p.t); });
        if (!pts.length || !(toMs > fromMs)) { return []; }
        var step = (toMs - fromMs) / n;
        var valueAt = function (t) {
            if (t <= pts[0].t) { return pts[0].v; }
            if (t >= pts[pts.length - 1].t) { return pts[pts.length - 1].v; }
            var lo = 0, hi = pts.length - 1;
            while (hi - lo > 1) {
                var mid = (lo + hi) >> 1;
                if (pts[mid].t <= t) { lo = mid; } else { hi = mid; }
            }
            var a = pts[lo], b = pts[hi];
            return b.t === a.t ? b.v : a.v + (b.v - a.v) * (t - a.t) / (b.t - a.t);
        };
        var out = [];
        for (var i = 0; i < n; i++) {
            var s = fromMs + i * step, e = s + step;
            // Outside the span the samples cover there is nothing to average.
            if (e <= pts[0].t || s >= pts[pts.length - 1].t) { out.push({ t: s + step / 2, v: null }); continue; }
            var cs = Math.max(s, pts[0].t), ce = Math.min(e, pts[pts.length - 1].t);
            var knots = [cs];
            for (var j = 0; j < pts.length; j++) {
                if (pts[j].t > cs && pts[j].t < ce) { knots.push(pts[j].t); }
            }
            knots.push(ce);
            var area = 0;
            for (var k = 1; k < knots.length; k++) {
                area += (valueAt(knots[k - 1]) + valueAt(knots[k])) / 2 * (knots[k] - knots[k - 1]);
            }
            out.push({ t: s + step / 2, v: ce > cs ? area / (ce - cs) : valueAt(cs) });
        }
        return out;
    };

    /**
     * Group a stream into consecutive subgroups of `size`. A trailing partial
     * subgroup is returned in `dropped` so the caller can say so; averaging
     * it with fewer samples would give it the wrong limits.
     */
    stats.subgroups = function (points, size) {
        var n = util.clamp(parseInt(size, 10) || 1, 1, 10);
        var groups = [], cur = [];
        for (var i = 0; i < points.length; i++) {
            cur.push(points[i]);
            if (cur.length === n) { groups.push(cur); cur = []; }
        }
        return { groups: groups, dropped: cur.length, size: n };
    };

    /**
     * Control limits for an I-MR, X-bar R or X-bar S chart.
     *
     * @param {Array} points time-ordered [{t, v}], already evenly spaced
     * @param {Object} opts {
     *     chart: 'imr' | 'xbarr' | 'xbars',
     *     size: subgroup size for the X-bar charts (2 to 10),
     *     k: limit width in sigmas (default 3),
     *     baseline: number of plotted points the limits are computed from
     *               (0 = all of them; "phase I" when set),
     *     fixed: {center, ucl, lcl} typed limits for the primary chart, or null
     * }
     * @returns {Object|null} {
     *     chart, size, k, sigma (within), s (sigma of the plotted statistic),
     *     primary: [{t, v, members}], secondary: [{t, v}],
     *     center, ucl, lcl, secCenter, secUcl, secLcl, secName, dropped
     * }
     */
    stats.controlLimits = function (points, opts) {
        opts = opts || {};
        var chart = opts.chart === 'xbarr' || opts.chart === 'xbars' ? opts.chart : 'imr';
        var k = util.num(opts.k);
        k = k === null ? 3 : util.clamp(k, 1, 6);
        var pts = (points || []).filter(function (p) { return p && util.isNum(p.v); });
        var primary = [], secondary = [], dropped = 0, size = 1, secName;
        var i;

        if (chart === 'imr') {
            secName = 'MR';
            for (i = 0; i < pts.length; i++) {
                primary.push({ t: pts[i].t, v: pts[i].v, members: [pts[i]] });
                // The first point has no moving range; it is not dropped, it
                // simply has no partner yet.
                if (i > 0) { secondary.push({ t: pts[i].t, v: Math.abs(pts[i].v - pts[i - 1].v) }); }
            }
            size = 2;
        } else {
            secName = chart === 'xbarr' ? 'R' : 'S';
            var sg = stats.subgroups(pts, util.clamp(parseInt(opts.size, 10) || 5, 2, 10));
            size = sg.size;
            dropped = sg.dropped;
            for (i = 0; i < sg.groups.length; i++) {
                var g = sg.groups[i];
                var vals = [];
                for (var j = 0; j < g.length; j++) { vals.push(g[j].v); }
                var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
                primary.push({ t: g[g.length - 1].t, v: stats.mean(vals), members: g });
                secondary.push({ t: g[g.length - 1].t, v: chart === 'xbarr' ? hi - lo : stats.stddev(vals) });
            }
        }
        if (primary.length < 2) { return null; }

        var base = parseInt(opts.baseline, 10) || 0;
        var nBase = base > 1 ? Math.min(base, primary.length) : primary.length;
        var center, secBar, sigma, s;
        var pv = [], sv = [];
        for (i = 0; i < nBase; i++) { pv.push(primary[i].v); }
        center = stats.mean(pv);
        // The moving range list is one shorter than the individuals.
        var nSec = chart === 'imr' ? Math.max(1, nBase - 1) : nBase;
        for (i = 0; i < Math.min(nSec, secondary.length); i++) { sv.push(secondary[i].v); }
        secBar = stats.mean(sv);
        if (secBar === null) { secBar = 0; }

        var d2 = stats.SPC_D2[size], d3 = stats.SPC_D3[size], c4 = stats.SPC_C4[size];
        if (chart === 'xbars') { sigma = secBar / c4; } else { sigma = secBar / d2; }
        s = chart === 'imr' ? sigma : sigma / Math.sqrt(size);

        var out = {
            chart: chart, size: chart === 'imr' ? 1 : size, k: k, sigma: sigma, s: s,
            primary: primary, secondary: secondary, secName: secName,
            center: center, ucl: center + k * s, lcl: center - k * s,
            secCenter: secBar, dropped: dropped, baseline: nBase, fixed: false
        };
        var spread = chart === 'xbars' ? sigma * Math.sqrt(1 - c4 * c4) : d3 * sigma;
        out.secUcl = secBar + k * spread;
        out.secLcl = Math.max(0, secBar - k * spread);

        var fx = opts.fixed;
        if (fx && util.isNum(util.num(fx.center)) && util.isNum(util.num(fx.ucl))) {
            out.center = util.num(fx.center);
            out.ucl = util.num(fx.ucl);
            var fl = util.num(fx.lcl);
            out.lcl = fl === null ? 2 * out.center - out.ucl : fl;
            // The rules are written in sigmas of the plotted statistic; typed
            // limits imply one, the half-width over k.
            out.s = Math.abs(out.ucl - out.lcl) / (2 * k);
            out.sigma = chart === 'imr' ? out.s : out.s * Math.sqrt(size);
            // The range chart follows the same sigma. Left on the window's
            // own ranges it would flag a step the typed limits allow for, or
            // pass one they do not: the two charts would disagree on sigma.
            out.secCenter = chart === 'xbars' ? c4 * out.sigma : d2 * out.sigma;
            spread = chart === 'xbars' ? out.sigma * Math.sqrt(1 - c4 * c4) : d3 * out.sigma;
            out.secUcl = out.secCenter + k * spread;
            out.secLcl = Math.max(0, out.secCenter - k * spread);
            out.fixed = true;
        }
        return out;
    };

    /**
     * Run rules over the plotted statistic.
     *
     * Rules 1 to 8 are Nelson's (1984). The Western Electric set is rules 1,
     * 5 and 6 with an 8-point run for rule 2 (its "8 in a row on one side").
     * A pattern flags the point that COMPLETES it, the convention in Minitab
     * and the AIAG manual: the chart says when the evidence arrived, not that
     * the earlier points were already wrong.
     *
     * @param {Array} values plotted statistic, in time order
     * @param {number} center
     * @param {number} s sigma of the plotted statistic
     * @param {Object} opts {rules:[1..8], run2: 9, run3: 6, run4: 14, k: 3}
     *   run2, run3 and run4 are the points rules 2, 3 and 4 need. Nelson's
     *   numbers are the defaults; sites copying ProcessBook SQC or an
     *   in-house standard often shorten rule 3 to 5 or rule 2 to 7.
     * @returns {Array} per point, the list of rule numbers it breaks
     */
    stats.runRules = function (values, center, s, opts) {
        opts = opts || {};
        var rules = opts.rules || [1, 2, 3, 4, 5, 6, 7, 8];
        var on = {};
        for (var r = 0; r < rules.length; r++) { on[rules[r]] = true; }
        var run2 = parseInt(opts.run2, 10) || 9;
        var run3 = util.clamp(parseInt(opts.run3, 10) || 6, 3, 20);
        var run4 = util.clamp(parseInt(opts.run4, 10) || 14, 4, 30);
        var k = util.num(opts.k);
        k = k === null ? 3 : k;
        var n = values.length;
        var out = [], i, j;
        for (i = 0; i < n; i++) { out.push([]); }
        if (!(s > 0)) { return out; }
        var z = [];
        for (i = 0; i < n; i++) { z.push(util.isNum(values[i]) ? (values[i] - center) / s : null); }
        var flag = function (idx, rule) { if (out[idx].indexOf(rule) === -1) { out[idx].push(rule); } };
        var side = function (v) { return v === null ? 0 : (v > 0 ? 1 : (v < 0 ? -1 : 0)); };

        for (i = 0; i < n; i++) {
            if (z[i] === null) { continue; }
            if (on[1] && Math.abs(z[i]) > k) { flag(i, 1); }
            if (on[2] && i >= run2 - 1) {
                var sd2 = side(z[i]), same = sd2 !== 0;
                for (j = i - run2 + 1; same && j <= i; j++) { if (side(z[j]) !== sd2) { same = false; } }
                if (same) { flag(i, 2); }
            }
            if (on[3] && i >= run3 - 1) {
                var up = true, down = true;
                for (j = i - run3 + 2; j <= i; j++) {
                    if (z[j] === null || z[j - 1] === null) { up = false; down = false; break; }
                    if (!(z[j] > z[j - 1])) { up = false; }
                    if (!(z[j] < z[j - 1])) { down = false; }
                }
                if (up || down) { flag(i, 3); }
            }
            if (on[4] && i >= run4 - 1) {
                // run4 points make run4 - 2 consecutive pairs of steps, and
                // every pair must change direction.
                var alt = true;
                for (j = i - run4 + 3; j <= i && alt; j++) {
                    if (z[j] === null || z[j - 1] === null || z[j - 2] === null) { alt = false; break; }
                    var a = z[j - 1] - z[j - 2], b = z[j] - z[j - 1];
                    if (!(a * b < 0)) { alt = false; }
                }
                if (alt) { flag(i, 4); }
            }
            if ((on[5] || on[6]) && i >= 2) {
                var countBeyond = function (from, lim, sgn) {
                    var c = 0;
                    for (var q = from; q <= i; q++) { if (z[q] !== null && z[q] * sgn > lim) { c++; } }
                    return c;
                };
                var sg5 = side(z[i]);
                // The completing point must itself be in the zone, on the
                // same side, or the flag lands on an innocent point.
                if (on[5] && sg5 !== 0 && z[i] * sg5 > 2 && countBeyond(i - 2, 2, sg5) >= 2) { flag(i, 5); }
                if (on[6] && i >= 4 && sg5 !== 0 && z[i] * sg5 > 1 && countBeyond(i - 4, 1, sg5) >= 4) { flag(i, 6); }
            }
            if (on[7] && i >= 14) {
                var inside = true;
                for (j = i - 14; j <= i; j++) { if (z[j] === null || Math.abs(z[j]) >= 1) { inside = false; break; } }
                if (inside) { flag(i, 7); }
            }
            if (on[8] && i >= 7) {
                var outside = true;
                for (j = i - 7; j <= i; j++) { if (z[j] === null || Math.abs(z[j]) <= 1) { outside = false; break; } }
                if (outside) { flag(i, 8); }
            }
        }
        return out;
    };

    /** One line per rule, for tooltips and the configuration pane. */
    stats.RULE_TEXT = {
        1: 'a point beyond the control limits',
        2: 'a run on one side of the centre line',
        3: 'six points steadily rising or falling',
        4: 'fourteen points alternating up and down',
        5: 'two of three points beyond 2 sigma on one side',
        6: 'four of five points beyond 1 sigma on one side',
        7: 'fifteen points within 1 sigma (limits too wide, or stratified data)',
        8: 'eight points beyond 1 sigma on either side'
    };

    /**
     * RULE_TEXT with the run lengths actually in force, so a tooltip never
     * says "six points" on a chart configured for five.
     * @param {number} rule 1..8
     * @param {Object} opts the runRules opts (run2, run3, run4)
     */
    stats.ruleText = function (rule, opts) {
        opts = opts || {};
        var n2 = parseInt(opts.run2, 10) || 9, n3 = parseInt(opts.run3, 10) || 6, n4 = parseInt(opts.run4, 10) || 14;
        if (rule === 2) { return n2 + ' points in a row on one side of the centre line'; }
        if (rule === 3) { return n3 + ' points steadily rising or falling'; }
        if (rule === 4) { return n4 + ' points alternating up and down'; }
        return stats.RULE_TEXT[rule] || '';
    };

    /**
     * Cpk from the within-subgroup sigma and Ppk from the overall one. The
     * histogram reports Cp = Pp because it has no subgroups; a control chart
     * does, so here the two differ the way quality staff expect: a Ppk well
     * below Cpk says the process drifts between subgroups.
     */
    stats.spcCapability = function (values, sigmaWithin, lsl, usl) {
        var overall = stats.capability(values, lsl, usl);
        if (!overall || overall.degenerate) { return overall; }
        var lo = util.num(lsl), hi = util.num(usl), mu = overall.mean;
        var out = {
            mean: mu, n: overall.n, sdOverall: overall.sd, sdWithin: sigmaWithin,
            pp: overall.cp, ppk: overall.cpk, percentOut: overall.percentOut, lsl: lo, usl: hi
        };
        if (sigmaWithin > 0) {
            var cpu = hi !== null ? (hi - mu) / (3 * sigmaWithin) : null;
            var cpl = lo !== null ? (mu - lo) / (3 * sigmaWithin) : null;
            out.cp = (lo !== null && hi !== null) ? (hi - lo) / (6 * sigmaWithin) : undefined;
            out.cpk = cpu === null ? cpl : (cpl === null ? cpu : Math.min(cpu, cpl));
        }
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
    /* ------------------------------------------------------------------ *
     * icons — the built-in set the navigation symbols draw
     * ------------------------------------------------------------------ *
     * Single stroked paths on a 24-unit grid, so nothing third-party ships
     * and each takes the text colour of whatever it sits in.
     */
    var icons = PVX.icons = {
        paths: {
            home: 'M3 11 L12 3 L21 11 M5 9.5 V21 H10 V15 H14 V21 H19 V9.5',
            back: 'M15 5 L8 12 L15 19',
            forward: 'M9 5 L16 12 L9 19',
            up: 'M5 15 L12 8 L19 15',
            down: 'M5 9 L12 16 L19 9',
            trend: 'M3 17 L9 11 L13 15 L21 7 M15 7 H21 V13',
            alarm: 'M12 3 L22 20 H2 Z M12 10 V14 M12 17 V17.5',
            table: 'M3 5 H21 V19 H3 Z M3 10 H21 M3 15 H21 M9 5 V19',
            gauge: 'M4 17 A8 8 0 1 1 20 17 M12 13 L16 8',
            clock: 'M12 3 A9 9 0 1 1 11.99 3 M12 7 V12 L15.5 14',
            map: 'M3 6 L9 4 L15 6 L21 4 V18 L15 20 L9 18 L3 20 Z M9 4 V18 M15 6 V20',
            list: 'M8 6 H21 M8 12 H21 M8 18 H21 M3.5 6 H4.5 M3.5 12 H4.5 M3.5 18 H4.5',
            settings: 'M12 9 A3 3 0 1 1 11.99 9 M12 2 V5 M12 19 V22 M2 12 H5 M19 12 H22 M4.9 4.9 L7 7 M17 17 L19.1 19.1 M4.9 19.1 L7 17 M17 7 L19.1 4.9',
            info: 'M12 3 A9 9 0 1 1 11.99 3 M12 11 V17 M12 7.5 V8',
            report: 'M6 3 H15 L19 7 V21 H6 Z M15 3 V7 H19 M9 12 H16 M9 16 H16',
            power: 'M12 3 V12 M7 6 A8 8 0 1 0 17 6',
            star: 'M12 3 L14.6 9 L21 9.5 L16 13.8 L17.6 20 L12 16.6 L6.4 20 L8 13.8 L3 9.5 L9.4 9 Z',
            menu: 'M4 6 H20 M4 12 H20 M4 18 H20',
            external: 'M14 4 H20 V10 M20 4 L11 13 M18 14 V20 H4 V6 H10',
            kiosk: 'M4 9 V4 H9 M15 4 H20 V9 M20 15 V20 H15 M9 20 H4 V15',
            toolbar: 'M3 4 H21 V20 H3 Z M3 9 H21',
            timebar: 'M3 4 H21 V20 H3 Z M3 15 H21 M8 15 V20 M13 15 V20',
            sidebar: 'M3 4 H21 V20 H3 Z M9 4 V20',
            plant: 'M3 21 V11 L9 14 V11 L15 14 V5 H19 V21 Z M3 21 H21',
            search: 'M10 4 A6 6 0 1 1 9.99 4 M14.5 14.5 L20 20'
        }
    };

    /** An <svg> of one icon, or null for a name not in the set. */
    icons.el = function (name, cls) {
        var d = icons.paths[name];
        if (!d) { return null; }
        var NS = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        if (cls) { svg.setAttribute('class', cls); }
        svg.setAttribute('aria-hidden', 'true');
        var path = document.createElementNS(NS, 'path');
        path.setAttribute('d', d);
        svg.appendChild(path);
        return svg;
    };

    var nav = PVX.nav = {};

    /**
     * Flags in a display's address that hide parts of PI Vision. They take
     * no value: present means hidden. hidetoolbar and hidetimebar are the
     * spellings operators report working; hidesidebar is the same pattern,
     * not yet seen on a server.
     */
    nav.VIEW_FLAGS = ['hidetoolbar', 'hidetimebar', 'hidesidebar'];

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
                // A flag PI Vision reads by its presence, such as hidetoolbar.
                if (v === true) { qs.push(encodeURIComponent(k)); continue; }
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
        // Hidden PI Vision chrome stays hidden on the next display, as kiosk
        // mode always did: an operator who hid the toolbar to free the
        // screen should not have to hide it again after every click.
        for (var f = 0; f < nav.VIEW_FLAGS.length; f++) {
            if (Object.prototype.hasOwnProperty.call(cur.params, nav.VIEW_FLAGS[f])) { params[nav.VIEW_FLAGS[f]] = true; }
        }

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

    var TIME_UNIT = { s: 1000, sec: 1000, m: 60000, min: 60000, h: 3600000, hr: 3600000, d: 86400000, w: 604800000 };

    function localMidnight(ms) {
        var d = new Date(ms);
        d.setHours(0, 0, 0, 0);
        return d.getTime();
    }

    /** One offset ("-8h", "+1mo") applied to ms, or null if it is not one. */
    function timeOffset(ms, sign, n, unit) {
        var u = unit.toLowerCase();
        if (u === 'mo' || u === 'y') {
            // Calendar months and years are not a fixed number of milliseconds.
            var d = new Date(ms);
            if (u === 'mo') { d.setMonth(d.getMonth() + sign * n); }
            else { d.setFullYear(d.getFullYear() + sign * n); }
            return d.getTime();
        }
        if (!TIME_UNIT[u]) { return null; }
        return ms + sign * n * TIME_UNIT[u];
    }

    /**
     * Resolve a PI time expression to epoch ms, or null when it is outside
     * what this knows: *, t, y, today, yesterday, a date, or a bare offset,
     * each followed by offsets in s m h d w mo y. Months and years are
     * calendar steps, not fixed lengths. Nothing here talks to PI: a symbol
     * that steps or replays a range needs it in milliseconds, and the address
     * holds whatever an operator typed.
     */
    nav.parseTime = function (expr, nowMs) {
        var s = String(expr === null || expr === undefined ? '' : expr).trim();
        if (!s) { return null; }
        if (typeof nowMs !== 'number') { nowMs = Date.now(); }
        // Date() reads a bare "5" as a day in 2001; PI does not.
        if (/^\d+(\.\d+)?$/.test(s)) { return null; }
        var base = null;
        var rest = '';
        var m = /^(\*|today|yesterday|t|y)(.*)$/i.exec(s);
        if (m) {
            var k = m[1].toLowerCase();
            base = k === '*' ? nowMs :
                   (k === 't' || k === 'today') ? localMidnight(nowMs) :
                   localMidnight(nowMs) - 86400000;
            rest = m[2];
            // "t", "today" are words; "today5" is not today plus anything.
            if (rest && !/^\s*[+-]/.test(rest)) { return null; }
        } else if (/^[+-]/.test(s)) {
            base = nowMs;                   // a bare offset is relative to now
            rest = s;
        } else {
            var d = new Date(s);
            return isNaN(d.getTime()) ? null : d.getTime();
        }
        var re = /\s*([+-])\s*(\d+(?:\.\d+)?)\s*(mo|min|sec|hr|[smhdwy])\s*/gi;
        var pos = 0;
        var hit;
        var ms = base;
        while ((hit = re.exec(rest)) !== null) {
            if (hit.index !== pos) { return null; }
            ms = timeOffset(ms, hit[1] === '-' ? -1 : 1, parseFloat(hit[2]), hit[3]);
            if (ms === null) { return null; }
            pos = re.lastIndex;
        }
        return pos === rest.length ? ms : null;
    };

    /**
     * A length of time, "10m", "1h 30m", "2d", to ms, or null. Fixed units
     * only: a span is added to clock times many times over, and a month has
     * no fixed length to add.
     */
    nav.parseSpan = function (spec) {
        var s = String(spec === null || spec === undefined ? '' : spec).trim();
        if (!s) { return null; }
        var re = /\s*(\d+(?:\.\d+)?)\s*(sec|min|hr|[smhdw])\s*/gi;
        var pos = 0, ms = 0, hit;
        while ((hit = re.exec(s)) !== null) {
            if (hit.index !== pos) { return null; }
            ms += parseFloat(hit[1]) * TIME_UNIT[hit[2].toLowerCase()];
            pos = re.lastIndex;
        }
        return pos === s.length && ms > 0 ? ms : null;
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

    /**
     * The AF database an element path lives in.
     *   \\srv\db\Area\Pump 101  -> \\srv\db
     *   \\srv\db                  -> \\srv\db
     *   ''                          -> ''
     * Takes element paths (nav.assetOf's output, or a URL asset), not raw
     * data source strings: \\PISRV01\SINUSOID has the same shape as a
     * database and only the data source's af:/pi: prefix tells them apart.
     */
    nav.databaseOf = function (elementPath) {
        var segs = nav.segments(elementPath);
        return segs.prefix ? segs.prefix.replace(/\\$/, '') : '';
    };

    /**
     * The element of the first AF attribute among a symbol's data sources, or
     * '' when every source is a PI point. This is the AF context PI Vision
     * does hand a custom symbol: it saves the path with the display.
     */
    nav.sourceAsset = function (scope) {
        var ds = scope && scope.symbol && scope.symbol.DataSources;
        if (!ds || typeof ds.length !== 'number') { return ''; }
        for (var i = 0; i < ds.length; i++) {
            var a = nav.assetOf(ds[i]);
            if (a) { return a; }
        }
        return '';
    };

    /**
     * Where a symbol's AF database comes from when its DatabasePath is blank,
     * best evidence first: the element of its data source as PI Vision last
     * sent it (`live`, which follows an asset swap), then as saved with the
     * display, then the asset the display's URL names, then the site's
     * databasePath in pvx-config.js. Returns
     * {path, from} with `from` worded for a footer, or {path:'', from:''}.
     */
    nav.defaultDatabase = function (scope, live) {
        var db = nav.databaseOf(live);
        if (db) { return { path: db, from: 'this symbol\'s data source' }; }
        db = nav.databaseOf(nav.sourceAsset(scope));
        if (db) { return { path: db, from: 'this symbol\'s data source' }; }
        db = nav.databaseOf(nav.currentAsset());
        if (db) { return { path: db, from: 'the display\'s asset' }; }
        // Site default. PVX.api.defaults is the spelling DEPLOYMENT.md taught
        // before anything read it; a site that followed it gets what it asked for.
        var a = PVX.api || {};
        db = String((a.settings && a.settings.databasePath) || (a.defaults && a.defaults.databasePath) || '')
            .replace(/^\s+|\s+$/g, '');
        if (db) { return { path: db, from: 'pvx-config.js' }; }
        return { path: '', from: '' };
    };

    /* ------------------------------------------------------------------ *
     * geo — Web Mercator for pvxGeoView
     * ------------------------------------------------------------------ *
     * The projection every web map tile server uses (EPSG:3857), in "world
     * pixels": at zoom z the world is 256 * 2^z pixels square, x east from
     * longitude -180, y south from latitude +85.0511. Map tiles come only
     * from a server the site names in pvx-config.js (map.tileUrl): nothing
     * in the library knows of one, so nothing reaches the internet unasked.
     */
    var geo = PVX.geo = {};

    geo.TILE = 256;
    geo.MAX_LAT = 85.0511287798;

    /** The site's tile server, or null: {tileUrl, attribution, maxZoom, subdomains}. */
    geo.site = function () {
        var m = api.settings && api.settings.map;
        if (!m || typeof m !== 'object' || !m.tileUrl || !/\{z\}/.test(m.tileUrl) || !/\{x\}/.test(m.tileUrl) || !/\{y\}/.test(m.tileUrl)) {
            return null;
        }
        var mz = util.num(m.maxZoom);
        return {
            tileUrl: String(m.tileUrl),
            attribution: m.attribution ? String(m.attribution) : '',
            maxZoom: mz === null ? 18 : util.clamp(Math.round(mz), 1, 22),
            subdomains: m.subdomains ? String(m.subdomains) : ''
        };
    };

    /** Latitude and longitude that can be placed: numbers, in range. */
    geo.valid = function (lat, lon) {
        return util.isNum(lat) && util.isNum(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
    };

    geo.project = function (lat, lon, z) {
        var size = geo.TILE * Math.pow(2, z);
        var la = util.clamp(lat, -geo.MAX_LAT, geo.MAX_LAT) * Math.PI / 180;
        return {
            x: size * (lon + 180) / 360,
            y: size * (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2
        };
    };

    geo.unproject = function (x, y, z) {
        var size = geo.TILE * Math.pow(2, z);
        var n = Math.PI - 2 * Math.PI * y / size;
        return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon: x / size * 360 - 180 };
    };

    /** One tile's address; x wraps round the world, y does not. */
    geo.tileUrl = function (tpl, z, x, y, subdomains) {
        var n = Math.pow(2, z);
        var wx = ((x % n) + n) % n;
        var sub = subdomains ? subdomains.charAt(Math.abs(wx + y) % subdomains.length) : '';
        return String(tpl).replace(/\{z\}/g, z).replace(/\{x\}/g, wx).replace(/\{y\}/g, y).replace(/\{s\}/g, sub);
    };

    /**
     * The view that shows every point: the deepest whole zoom at which their
     * extent fits inside w x h less a margin, centred on it. One point alone
     * gets `single` (a street-level view by default).
     * @returns {z, cx, cy} cx/cy in world pixels at zoom z
     */
    geo.fit = function (points, w, h, pad, maxZoom, single) {
        var top = maxZoom === undefined ? 18 : maxZoom;
        if (!points.length) { return { z: 1, cx: geo.TILE, cy: geo.TILE }; }
        var z = top;
        if (points.length > 1) {
            for (z = top; z > 0; z--) {
                var b = geo.extent(points, z);
                if (b.x1 - b.x0 <= w - 2 * pad && b.y1 - b.y0 <= h - 2 * pad) { break; }
            }
        } else {
            z = Math.min(top, single === undefined ? 14 : single);
        }
        var e = geo.extent(points, z);
        return { z: z, cx: (e.x0 + e.x1) / 2, cy: (e.y0 + e.y1) / 2 };
    };

    geo.extent = function (points, z) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (var i = 0; i < points.length; i++) {
            var p = geo.project(points[i].lat, points[i].lon, z);
            if (p.x < x0) { x0 = p.x; }
            if (p.x > x1) { x1 = p.x; }
            if (p.y < y0) { y0 = p.y; }
            if (p.y > y1) { y1 = p.y; }
        }
        return { x0: x0, y0: y0, x1: x1, y1: y1 };
    };

    /**
     * "Name | lat | lon" per line, or "Name | lat, lon". Returns
     * {list: [{key, lat, lon}], bad: [line]}: a line that does not read is
     * kept to be named, never quietly skipped.
     */
    geo.parseLocations = function (text) {
        var out = { list: [], bad: [] };
        var lines = String(text || '').split(/\r?\n/);
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].replace(/^\s+|\s+$/g, '');
            if (!line || line.charAt(0) === '#') { continue; }
            var parts = line.split('|');
            var key = (parts[0] || '').replace(/^\s+|\s+$/g, '');
            var rest = parts.length === 2 ? parts[1].split(',') : parts.slice(1);
            var lat = util.num(rest[0] !== undefined ? String(rest[0]).replace(/^\s+|\s+$/g, '') : null);
            var lon = util.num(rest[1] !== undefined ? String(rest[1]).replace(/^\s+|\s+$/g, '') : null);
            if (!key || !geo.valid(lat, lon)) { out.bad.push(line); continue; }
            out.list.push({ key: key, lat: lat, lon: lon });
        }
        return out;
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
     * download — hand the viewer a file built in the browser
     * ------------------------------------------------------------------ *
     * Nothing leaves the page: the file is made from what the symbol already
     * shows and saved by the browser. PI Vision's own export goes through its
     * server and only covers its own symbols.
     */
    var download = PVX.download = {};

    /**
     * One CSV cell. Quoted when it holds a comma, quote or line break. A text
     * cell that starts with = + - or @ gets a leading apostrophe, because a
     * spreadsheet runs it as a formula otherwise; a number never does, so a
     * negative reading stays a number.
     */
    download.csvCell = function (v) {
        if (v === null || v === undefined) { return ''; }
        if (typeof v === 'number') { return isFinite(v) ? String(v) : ''; }
        var s = String(v);
        // A strict number test: util.num is lenient and reads "=1+2" as 1.
        if (/^[=+\-@\t\r]/.test(s) && !/^[+\-]?(\d+\.?\d*|\.\d+)([eE][+\-]?\d+)?$/.test(s)) { s = '\'' + s; }
        return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };

    /** Rows (arrays of cells) to CSV text, CRLF between rows as RFC 4180 has it. */
    download.csvText = function (rows) {
        return (rows || []).map(function (r) {
            return (r || []).map(download.csvCell).join(',');
        }).join('\r\n') + '\r\n';
    };

    /** A file name with nothing Windows refuses in it. */
    download.fileName = function (base, ext) {
        var s = String(base === null || base === undefined ? '' : base)
            .replace(/[\\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
        return (s || 'pvx').slice(0, 80) + (ext ? '.' + ext : '');
    };

    /**
     * Save text as a file. Returns false when the browser offers no way to,
     * so the caller can say so instead of the button doing nothing. The BOM
     * makes Excel read a CSV as UTF-8: without it a degree sign arrives as
     * two characters.
     */
    download.text = function (name, content, mime) {
        var type = (mime || 'text/plain') + ';charset=utf-8';
        var body = (/csv/.test(type) ? '﻿' : '') + String(content === null || content === undefined ? '' : content);
        var blob;
        try { blob = new window.Blob([body], { type: type }); } catch (e) { return false; }
        // Legacy Edge and IE: the only route they have.
        if (window.navigator && window.navigator.msSaveOrOpenBlob) {
            window.navigator.msSaveOrOpenBlob(blob, name);
            return true;
        }
        if (!window.URL || !window.URL.createObjectURL) { return false; }
        var url = window.URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoked later, not at once: some browsers start the save after
        // click() returns and would find the address already gone.
        window.setTimeout(function () { window.URL.revokeObjectURL(url); }, 4000);
        return true;
    };

    /** Rows to a CSV file. */
    download.csv = function (name, rows) {
        return download.text(download.fileName(name, 'csv'), download.csvText(rows), 'text/csv');
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
            CornerRadius: 6,
            // Every symbol, applied by PVX.overlay; off, so saved displays
            // look as they did. Names of their own: pvxDataHealth already
            // has a StaleMinutes that means something else.
            ExportMenu: false,
            StaleBadgeMinutes: 0,
            HideWhenNoData: false,
            QuickTrend: false,
            // Time-series symbols only, through PVX.ownrange; off, so a saved
            // display follows the display's time range as it always did.
            OwnTimeRange: false,
            OwnStart: '*-1d',
            OwnEnd: '*',
            OwnRefreshSeconds: 60,
            OwnMaxValues: 10000
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
        webIdVersion: null,       // pin if a site needs a specific WebID scheme
        autoDiscover: true,       // blank baseUrl: try /piwebapi on PI Vision's own server
        databasePath: ''          // last-resort AF database (see nav.defaultDatabase)
    };

    /** Merge site settings without discarding keys the site did not mention. */
    api.configure = function (settings) {
        if (!settings) { return api.settings; }
        for (var k in settings) {
            if (Object.prototype.hasOwnProperty.call(settings, k)) {
                api.settings[k] = settings[k];
            }
        }
        // The site file carries the theme too; it is not a PI Web API
        // setting, but it arrives by the same road.
        if (Object.prototype.hasOwnProperty.call(settings, 'theme')) { theme.applySite(settings.theme); }
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

    /* ---- finding PI Web API without being told ---------------------------- *
     * PI Vision gives display code no supported route to its own AF connection
     * (it reaches AF from the server, through AF SDK), so there is nothing of
     * PI Vision's to borrow. What there often is, is a PI Web API installed on
     * the same machine: HTTP.sys lets it share port 443 with IIS under
     * /piwebapi. When baseUrl is blank, ask there once. Same origin also means
     * no CORS, no preflight and no CorsOrigins list — the arrangement that
     * fails most often simply does not arise.
     *
     * The answer is remembered for the page: a PI Web API does not appear or
     * vanish between refreshes, and asking on every request would double the
     * round trips. An explicit baseUrl always wins, and autoDiscover:false in
     * pvx-config.js restores the old inert behaviour for a site that wants it.
     */
    var discovery = { base: '', state: '', promise: null, error: null };   // state: '' | probing | found | missing

    function explicitBase() {
        return String(api.settings.baseUrl || '').replace(/^\s+|\s+$/g, '');
    }

    /** /piwebapi on the page's own origin, or '' where there is no origin to use. */
    api.sameOriginBase = function () {
        try {
            var loc = root.location;
            if (!loc || !/^https?:$/i.test(loc.protocol) || !loc.host) { return ''; }
            return loc.protocol + '//' + loc.host + '/piwebapi';
        } catch (e) { return ''; }
    };

    /** True while the base comes from discovery rather than pvx-config.js. */
    api.isAuto = function () {
        return !explicitBase() && api.settings.autoDiscover !== false && !!api.sameOriginBase();
    };

    function missingError() {
        var probed = discovery.base || api.sameOriginBase();
        return {
            code: 'not-configured',
            message: 'PI Web API is not configured for this PI Vision server, and none answered at ' + probed +
                     (discovery.error ? ' (' + discovery.error + ')' : '') + '. Install PI Web API on this server, ' +
                     'or set baseUrl in ext/libraries/pvx/pvx-config.js to where it lives.',
            check: 'pvx-config.js baseUrl'
        };
    }

    /**
     * Ask the same-origin /piwebapi once. Always resolves, with true when a PI
     * Web API answered; never rejects, so callers can chain a refresh on it.
     */
    api.discover = function () {
        if (!api.isAuto()) { return Promise.resolve(api.isConfigured()); }
        var base = api.sameOriginBase();
        if (discovery.base === base && discovery.promise) { return discovery.promise; }
        discovery.base = base;
        discovery.state = 'probing';
        discovery.error = null;
        discovery.promise = new Promise(function (resolve) {
            var settle = function (found, why) {
                // A late answer for a base that is no longer the one in use
                // (baseUrl set meanwhile) must not overwrite the newer state.
                if (discovery.base !== base) { resolve(false); return; }
                discovery.state = found ? 'found' : 'missing';
                discovery.error = found ? null : why;
                resolve(found);
            };
            applyAuth().then(function (auth) {
                var xhr = new root.XMLHttpRequest();
                try { xhr.open('GET', base + '/', true); } catch (e) { settle(false, e.message); return; }
                xhr.withCredentials = !!auth.withCredentials;
                xhr.timeout = api.settings.timeoutMs;
                xhr.setRequestHeader('Accept', 'application/json');
                xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
                for (var h in auth.headers) {
                    if (Object.prototype.hasOwnProperty.call(auth.headers, h)) { xhr.setRequestHeader(h, auth.headers[h]); }
                }
                xhr.onload = function () {
                    // 401/403 came from something guarding /piwebapi, which on
                    // this origin is PI Web API: it exists, and the real
                    // request will report the credential problem properly.
                    if (xhr.status === 401 || xhr.status === 403) { settle(true); return; }
                    if (xhr.status < 200 || xhr.status >= 300) { settle(false, 'HTTP ' + xhr.status); return; }
                    // IIS or PI Vision answering 200 with a page is not PI
                    // Web API. Its root is JSON carrying a Links object.
                    var body = null;
                    try { body = JSON.parse(xhr.responseText); } catch (e) { body = null; }
                    if (body && body.Links) { settle(true); } else { settle(false, 'the answer was not PI Web API'); }
                };
                xhr.onerror = function () { settle(false, 'no answer'); };
                xhr.ontimeout = function () { settle(false, 'timed out'); };
                try { xhr.send(null); } catch (e) { settle(false, e.message); }
            }, function () { settle(false, 'no credentials for the configured authentication'); });
        });
        return discovery.promise;
    };

    /**
     * True while a symbol should wait for discovery before deciding whether
     * PI Web API exists. Starts the probe if nothing has yet.
     */
    api.discovering = function () {
        if (!api.isAuto()) { return false; }
        if (discovery.base !== api.sameOriginBase() || !discovery.promise) { api.discover(); }
        return discovery.state === 'probing';
    };

    /** Resolves true when there is a PI Web API to talk to, false otherwise. */
    api.ready = function () {
        return api.isAuto() ? api.discover() : Promise.resolve(api.isConfigured());
    };

    /**
     * Is there a PI Web API to call? True for an explicit baseUrl, and for a
     * discovered one — including while discovery is still in flight, so a
     * request made then waits for the answer rather than giving up early.
     */
    api.isConfigured = function () {
        if (explicitBase()) { return true; }
        if (!api.isAuto()) { return false; }
        if (discovery.base !== api.sameOriginBase()) { return true; }
        return discovery.state !== 'missing';
    };

    /** Where the base came from, for diagnostics: 'config' | 'discovered' | 'probing' | 'none'. */
    api.baseSource = function () {
        if (explicitBase()) { return 'config'; }
        if (!api.isAuto()) { return 'none'; }
        if (discovery.base === api.sameOriginBase() && discovery.state === 'found') { return 'discovered'; }
        if (discovery.base === api.sameOriginBase() && discovery.state === 'missing') { return 'none'; }
        return 'probing';
    };

    /**
     * First half of a symbol's "not configured" sentence, so every symbol
     * says what was actually tried; each one finishes it with ", then
     * confirm it with ext/piwebapi-check.html".
     */
    api.unsetHint = function () {
        if (api.isAuto()) {
            return 'Nothing answered at ' + api.sameOriginBase() + ' on this PI Vision server. Install PI Web ' +
                   'API here, or set baseUrl in ext/libraries/pvx/pvx-config.js to where it lives';
        }
        return 'Set baseUrl in ext/libraries/pvx/pvx-config.js on this PI Vision server';
    };

    /** Normalised base, no trailing slash. */
    api.base = function () {
        var b = explicitBase();
        if (b) {
            b = b.replace(/\/+$/, '');
            return api.sameServerByAnotherName(b, root.location) ? api.sameOriginBase() : b;
        }
        return api.isAuto() ? api.sameOriginBase() : '';
    };

    /**
     * True when `base` is this PI Vision server's own /piwebapi spelled with
     * another name for the machine: https://pivision01/piwebapi in
     * pvx-config.js, the display opened as https://pivision01.corp.example.
     *
     * To a browser those are two sites, so every request became cross-origin
     * and failed as a CORS problem on a server that has no CORS to configure,
     * while the check page, opened by the short name, passed. Asking under
     * the page's own name reaches the same PI Web API with no CORS at all.
     * Only the first DNS label is compared, and never for an IP address,
     * where a "first label" means nothing.
     */
    api.sameServerByAnotherName = function (base, loc) {
        try {
            var m = /^(https?:)\/\/([^\/:?#]+)(:\d+)?(\/[^?#]*)?$/i.exec(String(base || ''));
            if (!m || !loc || !loc.hostname) { return false; }
            if (String(m[4] || '').replace(/\/+$/, '').toLowerCase() !== '/piwebapi') { return false; }
            if (m[1].toLowerCase() !== String(loc.protocol || '').toLowerCase()) { return false; }
            if ((m[3] || '').slice(1) !== String(loc.port || '')) { return false; }
            var host = m[2].toLowerCase(), page = String(loc.hostname).toLowerCase();
            if (host === page) { return false; }
            var ip = /^[\d.]+$|:/;
            if (ip.test(host) || ip.test(page)) { return false; }
            return host.split('.')[0] === page.split('.')[0];
        } catch (e) { return false; }
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
                // Name both addresses. The commonest cross-origin failure on a
                // single server is not CORS at all but two names for one
                // machine: pvx-config.js says https://pivision01/piwebapi and
                // the display was opened as https://pivision01.corp.example.
                // To a browser those are different sites.
                var page = '';
                try { page = root.location.protocol + '//' + root.location.host; } catch (e) { page = ''; }
                return {
                    code: 'cors-or-network',
                    message: 'Could not reach PI Web API at ' + api.base() + ' from this page (' + page + '), ' +
                             'which the browser treats as another site. If PI Web API is on this PI Vision ' +
                             'server, leave baseUrl blank in pvx-config.js so it is always asked under the ' +
                             'same name as the page. Otherwise PI Web API must list this PI Vision URL in ' +
                             'CorsOrigins, set CorsSupportsCredentials to true, and answer the OPTIONS ' +
                             'request without an authentication challenge.',
                    check: 'baseUrl blank, or CorsOrigins / CorsSupportsCredentials / anonymous OPTIONS'
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
        // PI Web API explains most failures in an Errors array; its words
        // name the AF server or the path, which no status code can.
        var said = piErrorText(err);
        var tail = said ? ' PI Web API said: ' + said : '';
        if (status === 404) {
            return { code: 'not-found', message: 'Not found. Check the path and the WebID.' + tail, check: 'path / WebID' };
        }
        if (status === 502) {
            // 502 is PI Web API failing to reach what is behind it, not the
            // browser failing to reach PI Web API. Live on a server whose
            // checks all passed, every AF server answered 502 to a database
            // list: the AF server list comes from the local Known Servers
            // Table, so only a request that connects to AF exposes it.
            return {
                code: 'backend',
                message: 'PI Web API answered, but could not reach the AF server or PI Data Archive behind it ' +
                         '(502). With Windows authentication the usual cause is Kerberos delegation: PI Web ' +
                         'API\'s service account must be allowed to delegate to the AF and Data Archive ' +
                         'servers, as PI Vision\'s already is.' + tail,
                check: 'Kerberos delegation from PI Web API\'s service account to AF / Data Archive'
            };
        }
        if (status >= 500) {
            return { code: 'server', message: 'PI Web API returned a server error (' + status + ').' + tail, check: 'PI Web API logs' };
        }
        return {
            code: 'http-' + status,
            message: 'PI Web API returned HTTP ' + status + (said ? ' \u2014 ' + said : err ? ' \u2014 ' + String(err).slice(0, 200) : ''),
            check: 'request'
        };
    }

    /** The Errors (or Message) PI Web API put in a failure body, as one line; '' when none. */
    function piErrorText(body) {
        if (!body || typeof body !== 'string') { return ''; }
        var j = null;
        try { j = JSON.parse(body); } catch (e) { return ''; }
        var list = j && (j.Errors || (j.Message ? [j.Message] : null));
        if (!list || typeof list.length !== 'number') { return ''; }
        var out = [];
        for (var i = 0; i < list.length; i++) { if (list[i]) { out.push(String(list[i])); } }
        var t = out.join(' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
        return t.length > 400 ? t.slice(0, 397) + '...' : t;
    }
    api.piErrorText = piErrorText;

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
            if (api.isAuto()) { return Promise.reject({ pvxError: missingError() }); }
            return Promise.reject({ pvxError: {
                code: 'not-configured',
                message: 'PI Web API is not configured for this PI Vision server. Set baseUrl in ' +
                         'ext/libraries/pvx/pvx-config.js on the PI Vision server.',
                check: 'pvx-config.js'
            } });
        }
        // Discovered base: wait for the one probe, then go — or refuse with
        // the same message an unconfigured site gets, naming what was tried.
        if (api.isAuto() && discovery.state !== 'found') {
            // Re-entering re-checks isConfigured, which is now definite.
            return api.discover().then(function () { return api.request(method, pathOrUrl, opts); });
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
                    fail(xhr.status, xhr.responseText || null);
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
     * Who PI Web API says the viewer is ("DOMAIN\\user"), once per page, for
     * a field prefilled with the user's name. Resolves '' when it cannot
     * tell (anonymous, or an older PI Web API), never rejects.
     */
    var userPromise = null;
    api.userName = function () {
        if (!userPromise) {
            userPromise = api.get('system/userinfo', { cache: false }).then(function (u) {
                return (u && u.Name) ? String(u.Name) : '';
            }, function () { userPromise = null; return ''; });
        }
        return userPromise;
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
        var body = { Timestamp: timestamp || '*', Value: value };
        // Flagged for review by whoever reads it: PI keeps the flag with the
        // value, and PI Vision draws such a value as questionable.
        if (opts.questionable) { body.Questionable = true; }
        // PI Web API's own rule for a value already at that time: Replace
        // (its default, and what every write here did before), Insert (keep
        // both) or NoReplace (keep the old one).
        var q = opts.updateOption ? '?updateOption=' + encodeURIComponent(opts.updateOption) : '';
        return api.post('streams/' + encodeURIComponent(webId) + '/value' + q, body, opts);
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
                var o = {};
                for (var k in (opts || {})) { if (Object.prototype.hasOwnProperty.call(opts, k)) { o[k] = opts[k]; } }
                if (w.questionable) { o.questionable = true; }
                if (w.updateOption) { o.updateOption = w.updateOption; }
                return api.writeValue(w.webId, w.value, w.timestamp, o)
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
                            // Every server's reason, not the last: one note
                            // hid two failing servers on a live system.
                            state.note = (state.note ? state.note + ' ' : '') +
                                'The databases on ' + s.Name + ' could not be listed: ' + afErr(e);
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
                        state.note = (state.note ? state.note + ' ' : '') + 'PI Data Archive servers could not be listed: ' + afErr(e);
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
            // Nothing typed and nothing to start from: open where this
            // symbol's own data source lives, the AF context PI Vision gave it.
            if (!/^\\\\/.test(cur) && !/^\\\\/.test(st)) {
                st = nav.sourceAsset(scope) || afTrim(nav.currentAsset());
                if (state.kind === 'database') { st = nav.databaseOf(st); }
            }
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
                    // With errors below, "none you can read" would send someone to
                    // AF security when the fault is getting to AF at all.
                    state.message = state.message || (state.note ? 'No AF database could be listed.'
                        : 'PI Web API lists no AF databases this account can read.');
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

    /* ------------------------------------------------------------------ *
     * entry: the controls the two write-back symbols put a value in with
     * ------------------------------------------------------------------ *
     * Manual Entry and the Shift Log both used to offer one control, a box to
     * type in. Some values are not typed: a pump is on or off, a grade is one
     * of four, a setpoint moves in steps of 0.5. These controls are shared so
     * the two symbols behave the same way.
     *
     * Every control keeps the value it will write in one element, `input`,
     * whose .value is text exactly as a typed box would hold it. The symbols
     * read, validate and clear that element as before, so they do not need a
     * separate write path for each control. Controls that cannot start out
     * empty (a slider always has a position) keep a hidden input instead and
     * set it only when the operator moves them. If they wrote their starting
     * position into it, every untouched slider on a rounds sheet would count
     * as a reading and be written.
     *
     * Until the operator picks something, a switch or a button row shows the
     * value PI holds now. A pending change is outlined, so a switch that has
     * been flipped but not written does not look like the plant's state.
     */
    var entry = PVX.entry = {};

    function decimalsOf(n) {
        var s = String(n);
        var e = s.indexOf('e-');
        if (e !== -1) { return parseInt(s.slice(e + 2), 10) || 0; }
        var i = s.indexOf('.');
        return i === -1 ? 0 : s.length - i - 1;
    }

    /**
     * One click of a stepper. Rounded to the step's decimals, so ten clicks
     * of 0.1 give 1, not 0.9999999999999999, which would be written as typed.
     */
    entry.step = function (baseText, stepSize, dir, min, max, fallback) {
        var st = Math.abs(util.num(stepSize) || 0) || 1;
        var b = /^\s*[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?\s*$/.test(String(baseText === undefined ? '' : baseText))
            ? parseFloat(baseText) : null;
        if (b === null) { b = (fallback !== null && fallback !== undefined && isFinite(fallback)) ? fallback : (min !== null && min !== undefined ? min : 0); }
        var v = b + dir * st;
        if (min !== null && min !== undefined && v < min) { v = min; }
        if (max !== null && max !== undefined && v > max) { v = max; }
        var d = Math.min(10, Math.max(decimalsOf(st), decimalsOf(parseFloat(b.toFixed(6)))));
        return parseFloat(v.toFixed(d));
    };

    /** "1=Running" -> {value:'1', label:'Running'}; "Running" -> both the same. */
    entry.choice = function (text) {
        var s = String(text === undefined || text === null ? '' : text).replace(/^\s+|\s+$/g, '');
        var eq = s.indexOf('=');
        if (eq > 0) {
            var v = s.slice(0, eq).replace(/\s+$/, ''), l = s.slice(eq + 1).replace(/^\s+/, '');
            return { value: v, label: l || v };
        }
        return { value: s, label: s };
    };

    /** A list of choices, split on "/" or ",". Blank entries are left out. */
    entry.choices = function (text) {
        var out = [];
        String(text || '').split(/[\/,]/).forEach(function (part) {
            var c = entry.choice(part);
            if (c.value) { out.push(c); }
        });
        return out;
    };

    /** True when every choice is a number, so the write sends numbers. */
    entry.numericChoices = function (list) {
        if (!list || !list.length) { return false; }
        for (var i = 0; i < list.length; i++) {
            if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(list[i].value)) { return false; }
        }
        return true;
    };

    var CONTROL_KINDS = { number: 1, text: 1, stepper: 1, slider: 1, 'switch': 1, buttons: 1, select: 1 };

    /**
     * A Shift Log row's control field:
     *   number | text | stepper[:step] | slider[:step] | switch[:off/on] |
     *   buttons:a/b/c | select:a/b/c     with "wide" anywhere for a full row.
     * Any choice can be value=caption. Returns {kind, step, choices, wide, error}.
     */
    entry.parse = function (spec) {
        var out = { kind: 'number', step: '', choices: [], wide: false, plain: false, error: '' };
        var s = String(spec || '').replace(/^\s+|\s+$/g, '');
        if (!s) { return out; }
        var words = s.split(/\s+/);
        var main = '';
        for (var i = 0; i < words.length; i++) {
            if (words[i].toLowerCase() === 'wide') { out.wide = true; } else { main += (main ? ' ' : '') + words[i]; }
        }
        if (!main) { return out; }
        var colon = main.indexOf(':');
        var kind = (colon === -1 ? main : main.slice(0, colon)).toLowerCase();
        var arg = colon === -1 ? '' : main.slice(colon + 1);
        if (!CONTROL_KINDS[kind]) {
            out.error = 'control "' + kind + '" is not one of number, text, stepper, slider, switch, buttons, select';
            return out;
        }
        out.kind = kind;
        if (kind === 'stepper' || kind === 'slider') {
            if (arg && !(util.num(arg) > 0)) { out.error = kind + ' step "' + arg + '" is not a positive number'; }
            out.step = arg;
        } else if (kind === 'switch') {
            // No positions given: a Boolean attribute, written as False/True.
            out.plain = !arg;
            out.choices = arg ? entry.choices(arg) : [{ value: 'False', label: 'Off' }, { value: 'True', label: 'On' }];
            if (out.choices.length !== 2) { out.error = 'a switch needs exactly two positions, off/on'; }
        } else if (kind === 'buttons' || kind === 'select') {
            out.choices = entry.choices(arg);
            if (!out.choices.length) { out.error = kind + ' needs its choices, for example ' + kind + ':Low/Normal/High'; }
        }
        return out;
    };

    function sameValue(a, b) {
        if (a === null || a === undefined || b === null || b === undefined) { return false; }
        var x = String(a).toLowerCase(), y = String(b).toLowerCase();
        if (x === y) { return true; }
        var nx = parseFloat(x), ny = parseFloat(y);
        return isFinite(nx) && isFinite(ny) && /^[\s+\-.\d eE]+$/.test(x) && /^[\s+\-.\d eE]+$/.test(y) && nx === ny;
    }
    entry.same = sameValue;

    /**
     * Build a control.
     *   o.kind      number | text | stepper | slider | switch | buttons | select
     *   o.parent    where it goes; o.inputClass for the typed box
     *   o.min, o.max, o.step, o.choices ([{value,label}], two for a switch)
     *   o.listen    (node, type, fn): the symbol's own registrar, so its
     *               teardown removes these listeners with its others
     *   o.onPick    (value, commit): the operator changed it. commit is true
     *               for a choice made in one action (a switch flip, a button,
     *               letting go of a slider), false while dragging or typing.
     *   o.format    value -> text for a slider's readout
     * Returns {input, focus, wrap, sync(state)}; sync takes {current, disabled}.
     */
    entry.build = function (o) {
        var listen = o.listen || function (n, t, f) { n.addEventListener(t, f, false); };
        function mk(tag, cls, parent) {
            var n = document.createElement(tag);
            if (cls) { n.className = cls; }
            if (parent) { parent.appendChild(n); }
            return n;
        }
        function button(cls, parent, text) {
            var b = mk('button', cls, parent);
            b.type = 'button';
            b.textContent = text;
            return b;
        }
        var kind = o.kind || 'number';
        var wrap = mk('span', 'pvx-ctl pvx-ctl-' + kind, o.parent);
        var ctl = { kind: kind, wrap: wrap, input: null, focus: null, parts: [] };
        var choices = o.choices || [];
        var min = o.min === undefined ? null : o.min, max = o.max === undefined ? null : o.max;
        var fmtv = o.format || function (v) { return String(v); };
        var lastCurrent = null;
        function pick(v, commit) {
            ctl.input.value = v;
            ctl.sync({ current: lastCurrent });
            if (o.onPick) { o.onPick(v, commit); }
        }
        function hidden() {
            var h = mk('input', null, wrap);
            h.type = 'hidden';
            return h;
        }

        if (kind === 'select') {
            var sel = mk('select', o.inputClass || '', wrap);
            var blank = mk('option', null, sel);
            blank.value = '';
            blank.textContent = choices.length ? 'Choose…' : 'No choices configured';
            choices.forEach(function (c) {
                var opt = mk('option', null, sel);
                opt.value = c.value;
                opt.textContent = c.label;
            });
            listen(sel, 'change', function () { if (o.onPick) { o.onPick(sel.value, true); } });
            ctl.input = ctl.focus = sel;

        } else if (kind === 'slider') {
            ctl.input = hidden();
            var range = mk('input', 'pvx-ctl-range', wrap);
            range.type = 'range';
            if (min !== null) { range.min = min; }
            if (max !== null) { range.max = max; }
            range.step = util.num(o.step) > 0 ? String(util.num(o.step)) : 'any';
            var readout = mk('span', 'pvx-ctl-readout pvx-num', wrap);
            listen(range, 'input', function () { pick(range.value, false); });
            listen(range, 'change', function () { pick(range.value, true); });
            ctl.focus = range;
            ctl.parts = [range];
            ctl.range = range;
            ctl.readout = readout;

        } else if (kind === 'switch') {
            ctl.input = hidden();
            var off = choices[0] || { value: 'False', label: 'Off' };
            var on = choices[1] || { value: 'True', label: 'On' };
            var sw = button('pvx-ctl-sw', wrap, '');
            sw.setAttribute('role', 'switch');
            var cap = mk('span', 'pvx-ctl-cap', wrap);
            listen(sw, 'click', function () {
                var eff = ctl.input.value !== '' ? ctl.input.value : lastCurrent;
                pick(sameValue(eff, on.value) ? off.value : on.value, true);
            });
            ctl.focus = sw;
            ctl.parts = [sw];
            ctl.sw = sw;
            ctl.cap = cap;
            ctl.off = off;
            ctl.on = on;

        } else if (kind === 'buttons') {
            ctl.input = hidden();
            var seg = mk('span', 'pvx-ctl-seg', wrap);
            seg.setAttribute('role', 'group');
            ctl.opts = [];
            choices.forEach(function (c) {
                var b = button('pvx-ctl-opt', seg, c.label);
                listen(b, 'click', function () { pick(c.value, true); });
                ctl.opts.push({ node: b, value: c.value });
                ctl.parts.push(b);
            });
            ctl.focus = ctl.parts[0] || null;

        } else {
            var box = mk('input', o.inputClass || '', null);
            box.type = (kind === 'text') ? 'text' : 'number';
            if (box.type === 'number') {
                // 'any', or a browser silently refuses decimals on the default
                // integer step before the symbol's own check sees the text.
                box.setAttribute('step', 'any');
            }
            if (kind === 'stepper') {
                var down = button('pvx-ctl-step', wrap, '−');
                down.setAttribute('aria-label', 'Decrease');
                wrap.appendChild(box);
                var up = button('pvx-ctl-step', wrap, '+');
                up.setAttribute('aria-label', 'Increase');
                var bump = function (dir) {
                    var cur = util.num(lastCurrent);
                    box.value = String(entry.step(box.value, o.step, dir, min, max, cur));
                    // Never a commit: a stepper that wrote on every click would
                    // put each intermediate value into the archive.
                    if (o.onPick) { o.onPick(box.value, false); }
                };
                listen(down, 'click', function () { bump(-1); });
                listen(up, 'click', function () { bump(1); });
                ctl.parts = [down, up];
            } else {
                wrap.appendChild(box);
            }
            ctl.input = ctl.focus = box;
        }

        /** Show the pending choice, or what PI holds when nothing is picked. */
        ctl.sync = function (s) {
            s = s || {};
            if (s.current !== undefined) { lastCurrent = s.current; }
            var v = ctl.input.value;
            var pending = v !== '';
            var eff = pending ? v : lastCurrent;
            wrap.setAttribute('data-pending', pending && kind !== 'number' && kind !== 'text' && kind !== 'select' ? 'yes' : 'no');
            if (s.disabled !== undefined) {
                ctl.input.disabled = !!s.disabled;
                for (var i = 0; i < ctl.parts.length; i++) { ctl.parts[i].disabled = !!s.disabled; }
            }
            if (kind === 'slider') {
                var n = util.num(eff);
                if (n === null) { n = min !== null ? min : 0; }
                if (String(ctl.range.value) !== String(n) && document.activeElement !== ctl.range) { ctl.range.value = n; }
                var txt = pending ? fmtv(v) : (lastCurrent !== null && lastCurrent !== undefined && lastCurrent !== '' ? fmtv(lastCurrent) : '—');
                if (ctl.readout.textContent !== txt) { ctl.readout.textContent = txt; }
            } else if (kind === 'switch') {
                var isOn = sameValue(eff, ctl.on.value), isOff = sameValue(eff, ctl.off.value);
                ctl.sw.setAttribute('aria-checked', isOn ? 'true' : (isOff ? 'false' : 'mixed'));
                var c = isOn ? ctl.on.label : (isOff ? ctl.off.label : '—');
                if (ctl.cap.textContent !== c) { ctl.cap.textContent = c; }
                ctl.sw.setAttribute('aria-label', ctl.off.label + ' / ' + ctl.on.label + ': ' + c);
            } else if (kind === 'buttons') {
                for (var j = 0; j < ctl.opts.length; j++) {
                    ctl.opts[j].node.setAttribute('aria-pressed', pending && sameValue(v, ctl.opts[j].value) ? 'true' : 'false');
                    ctl.opts[j].node.setAttribute('data-current', sameValue(lastCurrent, ctl.opts[j].value) ? 'yes' : 'no');
                }
            }
        };
        ctl.sync({ current: null });
        return ctl;
    };


    /* ------------------------------------------------------------------ *
     * overlay: what every symbol offers on top of its own drawing
     * ------------------------------------------------------------------ *
     * Four options any PVX symbol has, all off by default so a saved display
     * looks as it did:
     *
     *   ExportMenu         a button, shown on hover, that saves the symbol as
     *                      a PNG image, its drawing as SVG, or its data as CSV.
     *   StaleBadgeMinutes  a badge when the newest timestamp PI Vision sent is
     *                      older than this. 0 is off.
     *   HideWhenNoData     the symbol hides itself while none of its data
     *                      sources has a value.
     *   QuickTrend         a button that trends the symbol's data sources in
     *                      a floating panel (PVX.trend, through PI Web API).
     *
     * They live here, wired in by bootstrap, so no symbol has to opt in.
     * Nothing in this block sends anything anywhere: files are made in the
     * browser by PVX.download. The quick trend reads from PI Web API, and
     * only once its button is pressed.
     */
    var overlay = PVX.overlay = {};

    /** Every value PI Vision sent, whatever the data shape, as {t, v, good, label, units}. */
    overlay.items = function (d) {
        var out = [];
        if (!d) { return out; }
        var push = function (label, units, p) {
            if (p === null || p === undefined) { return; }
            var raw = typeof p === 'object' ? (p.Value !== undefined ? p.Value : p.value) : p;
            if (raw !== null && typeof raw === 'object') { raw = raw.Name !== undefined ? raw.Name : raw.Value; }
            var dt = fmt.toDate(typeof p === 'object' ? (p.Time || p.time) : null);
            out.push({ label: label, units: units, t: dt ? dt.getTime() : null, raw: raw, good: !(p && p.IsGood === false) });
        };
        var rows = d.Rows || d.rows;
        if (rows && rows.length !== undefined) {
            for (var r = 0; r < rows.length; r++) {
                var row = rows[r] || {};
                push(row.Label || ('Row ' + (r + 1)), row.Units || '', row);
            }
            return out;
        }
        var list = d.Data || d.data;
        if (!list) {
            if (d.Value !== undefined || d.Time !== undefined) { push(d.Label || 'Value', d.Units || '', d); }
            return out;
        }
        for (var i = 0; i < list.length; i++) {
            var it = list[i] || {};
            var label = it.Label || ('Source ' + (i + 1));
            var vals = it.Values || it.Value;
            if (vals && typeof vals === 'object' && vals.length !== undefined) {
                for (var j = 0; j < vals.length; j++) {
                    var v = vals[j];
                    if (v && it.IsGood === false && v.IsGood === undefined) { v = { Time: v.Time, Value: v.Value, IsGood: false }; }
                    push(label, it.Units || '', v);
                }
            } else {
                push(label, it.Units || '', it.IsGood === false ? { Time: it.Time, Value: it.Value, IsGood: false } : it);
            }
        }
        return out;
    };

    /** Has any source a value? Bad-quality values and system states count as none. */
    overlay.hasData = function (d) {
        var list = overlay.items(d);
        for (var i = 0; i < list.length; i++) {
            if (list[i].good && list[i].raw !== null && list[i].raw !== undefined && list[i].raw !== '') { return true; }
        }
        return false;
    };

    /** The newest timestamp PI Vision sent, or null. */
    overlay.newest = function (d) {
        var list = overlay.items(d), best = null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].t !== null && (best === null || list[i].t > best)) { best = list[i].t; }
        }
        return best;
    };

    /**
     * Is the display looking at the past? Then old data is what was asked
     * for, and calling it stale would be wrong.
     */
    overlay.historical = function (thresholdMs, nowMs) {
        var p = nav.parseHash().params || {};
        if (!p.endtime) { return false; }
        var end = nav.parseTime(p.endtime, nowMs);
        return end !== null && end < nowMs - thresholdMs;
    };

    /** The data as CSV rows, long form: one row per value, lossless. */
    overlay.csvRows = function (d) {
        var rows = [['Source', 'Units', 'Time', 'Value', 'Quality']];
        var list = overlay.items(d);
        for (var i = 0; i < list.length; i++) {
            var it = list[i];
            var n = util.isNum(it.raw) ? it.raw : (typeof it.raw === 'string' && /^-?\d+(\.\d+)?([eE][+\-]?\d+)?$/.test(it.raw) ? parseFloat(it.raw) : it.raw);
            rows.push([it.label, it.units, it.t === null ? '' : new Date(it.t).toISOString(), n, it.good ? 'Good' : 'Bad']);
        }
        return rows;
    };

    /* The properties copied onto each element of a picture. Computed style in
     * full is several hundred per element and makes a table megabytes. */
    var PICTURE_PROPS = ['display', 'position', 'top', 'left', 'right', 'bottom', 'width', 'height',
        'box-sizing', 'margin', 'padding', 'border', 'border-radius', 'background-color', 'background-image',
        'color', 'font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'text-align',
        'vertical-align', 'white-space', 'overflow', 'text-overflow', 'opacity', 'flex', 'flex-direction',
        'align-items', 'justify-content', 'gap', 'border-collapse', 'border-spacing', 'box-shadow',
        'fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-linecap', 'text-anchor',
        'dominant-baseline', 'font-variant-numeric', 'transform', 'visibility', 'z-index'];

    function copyStyles(src, dst) {
        if (!src || !dst || src.nodeType !== 1) { return; }
        var cs = root.getComputedStyle ? root.getComputedStyle(src) : null;
        if (cs) {
            var parts = [];
            for (var i = 0; i < PICTURE_PROPS.length; i++) {
                var v = cs.getPropertyValue(PICTURE_PROPS[i]);
                if (v) { parts.push(PICTURE_PROPS[i] + ':' + v); }
            }
            dst.setAttribute('style', parts.join(';'));
        }
        // Scrolled content is pictured where the reader left it.
        if (src.scrollTop || src.scrollLeft) {
            dst.style.overflow = 'hidden';
            var inner = dst.firstElementChild;
            if (inner) { inner.style.marginTop = (-src.scrollTop) + 'px'; inner.style.marginLeft = (-src.scrollLeft) + 'px'; }
        }
        var a = src.children, b = dst.children;
        for (var k = 0; k < a.length && k < b.length; k++) { copyStyles(a[k], b[k]); }
    }

    /** The symbol's own drawing: its largest SVG, or null for an HTML symbol. */
    overlay.mainSvg = function (node) {
        if (!node || !node.querySelectorAll) { return null; }
        var all = node.querySelectorAll('svg'), best = null, area = 0;
        for (var i = 0; i < all.length; i++) {
            if (all[i].closest && all[i].closest('.pvx-overlay')) { continue; }
            var r = all[i].getBoundingClientRect();
            if (r.width * r.height > area) { area = r.width * r.height; best = all[i]; }
        }
        // A small icon beside HTML text is not the drawing.
        var nr = node.getBoundingClientRect();
        return best && area >= nr.width * nr.height * 0.3 ? best : null;
    };

    /** The SVG drawing as a standalone file, styles inlined so it opens anywhere. */
    overlay.svgText = function (svgEl, background) {
        var clone = svgEl.cloneNode(true);
        copyStyles(svgEl, clone);
        var r = svgEl.getBoundingClientRect();
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.setAttribute('width', String(Math.round(r.width)));
        clone.setAttribute('height', String(Math.round(r.height)));
        if (!clone.getAttribute('viewBox')) { clone.setAttribute('viewBox', '0 0 ' + Math.round(r.width) + ' ' + Math.round(r.height)); }
        if (background && background !== 'transparent') {
            var bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            var vb = clone.getAttribute('viewBox').split(/[\s,]+/);
            bg.setAttribute('x', vb[0]); bg.setAttribute('y', vb[1]);
            bg.setAttribute('width', vb[2]); bg.setAttribute('height', vb[3]);
            bg.setAttribute('fill', background);
            clone.insertBefore(bg, clone.firstChild);
        }
        return new root.XMLSerializer().serializeToString(clone);
    };

    /**
     * The whole symbol, HTML and SVG alike, as a PNG. The symbol is copied
     * into an SVG foreignObject with its styles inlined and drawn onto a
     * canvas at twice its size. A browser that refuses (a canvas tainted by
     * a foreignObject, as older engines do) rejects, and the caller says so.
     */
    overlay.png = function (node, background) {
        return new Promise(function (resolve, reject) {
            var r = node.getBoundingClientRect();
            var w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
            var clone = node.cloneNode(true);
            copyStyles(node, clone);
            var ov = clone.querySelector('.pvx-overlay');
            if (ov) { ov.parentNode.removeChild(ov); }
            clone.style.zoom = '';
            clone.style.width = w + 'px';
            clone.style.height = h + 'px';
            if (background && background !== 'transparent') { clone.style.backgroundColor = background; }
            clone.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
            var xml = new root.XMLSerializer().serializeToString(clone);
            var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' +
                '<foreignObject x="0" y="0" width="100%" height="100%">' + xml + '</foreignObject></svg>';
            var img = new root.Image();
            img.onload = function () {
                try {
                    var k = 2;
                    var c = document.createElement('canvas');
                    c.width = w * k; c.height = h * k;
                    var g = c.getContext('2d');
                    g.scale(k, k);
                    g.drawImage(img, 0, 0);
                    resolve(c.toDataURL('image/png'));
                } catch (e) { reject(e); }
            };
            img.onerror = function () { reject(new Error('the browser could not draw the symbol')); };
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        });
    };

    /** Save a data: URL as a file. */
    overlay.saveDataUrl = function (name, url) {
        var a = document.createElement('a');
        if (typeof a.download !== 'string') { return false; }
        a.href = url;
        a.download = name;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        return true;
    };

    /* ------------------------------------------------------------------ *
     * trend: the quick trend any symbol can open (QuickTrend option)
     * ------------------------------------------------------------------ *
     * A floating panel trending the data sources of the symbol it was opened
     * from; a second symbol's trend button adds its sources to the panel
     * already open, so a comparison is two clicks. One panel per page.
     *
     * WHY PI WEB API. PI Vision's own ad hoc trend opens only from its stock
     * symbols, and a custom symbol cannot add data sources to PI Vision's
     * pipeline at run time: the history a trend needs is not in what the
     * symbol was sent. So each source is one plot request, sized to the
     * panel's width, the same reduction PI Vision's trend asks the archive
     * for. Nothing is written, and nothing is asked until the button is
     * pressed.
     */
    var trend = PVX.trend = {};

    trend.MAX_SOURCES = 8;
    trend.RANGES = [
        ['display', 'Display time range'], ['*-1h', 'Last hour'], ['*-8h', 'Last 8 hours'],
        ['*-1d', 'Last day'], ['*-7d', 'Last 7 days'], ['*-30d', 'Last 30 days']
    ];
    trend.REFRESH_MS = 60000;

    var tr = null;              // the open panel, or null
    var trIds = {};             // source path -> Promise(WebId), shared across opens

    /** "K-301 · Discharge Pressure" for an attribute, the tag for a PI point. */
    trend.labelOf = function (ds) {
        var p = states.sourcePath(ds);
        var bar = p.indexOf('|');
        if (bar === -1) { return p.split('\\').filter(function (x) { return !!x; }).pop() || p; }
        var el = p.slice(0, bar).split('\\').filter(function (x) { return !!x; }).pop() || '';
        var attr = p.slice(bar + 1);
        return el ? el + ' · ' + attr : attr;
    };

    /**
     * The window a range key means now: the display's own range, or a span
     * back from now. {start, end} are PI time expressions for the request,
     * {from, to} the milliseconds for the axis (null when unparseable).
     */
    trend.window = function (key, nowMs) {
        var now = nowMs || Date.now();
        var start, end;
        if (!key || key === 'display') {
            var p = nav.parseHash().params || {};
            start = p.starttime || '*-8h';
            end = p.endtime || '*';
        } else {
            start = key;
            end = '*';
        }
        return { start: start, end: end, from: nav.parseTime(start, now), to: nav.parseTime(end, now),
            live: String(end).replace(/\s+/g, '') === '*' };
    };

    /**
     * Plot items -> {pts:[{t, v}], bad, text, units}. Bad values and text
     * (a digital state, a system state) are counted, not drawn: a gap where
     * the archive had no good number is the honest picture.
     */
    trend.points = function (items) {
        var out = { pts: [], bad: 0, text: 0, units: '' };
        for (var i = 0; i < (items || []).length; i++) {
            var it = items[i] || {};
            if (it.UnitsAbbreviation && !out.units) { out.units = it.UnitsAbbreviation; }
            var d = fmt.toDate(it.Timestamp);
            if (!d) { continue; }
            if (it.Good === false) { out.bad += 1; continue; }
            var v = it.Value;
            if (v !== null && typeof v === 'object') { out.text += 1; continue; }
            if (!util.isNum(v)) { out.text += 1; continue; }
            out.pts.push({ t: d.getTime(), v: v });
        }
        out.pts.sort(function (a, b) { return a.t - b.t; });
        return out;
    };

    trend.isOpen = function () { return !!tr; };

    /** The paths on the open trend, in order. */
    trend.sources = function () {
        if (!tr) { return []; }
        return tr.traces.map(function (x) { return x.path; });
    };

    /**
     * Open the trend with these data sources, or add them to the one open.
     * @param {Array} list data source strings, as in scope.symbol.DataSources
     * @param {Object} [opts] {theme: tokens of the opening symbol}
     * @returns {{added: Number, already: Number, over: Number}}
     */
    trend.open = function (list, opts) {
        opts = opts || {};
        if (!tr) { trBuild(opts.theme || theme.tokens({})); }
        var res = { added: 0, already: 0, over: 0 };
        for (var i = 0; i < (list || []).length; i++) {
            var p = states.sourcePath(list[i]);
            if (!p) { continue; }
            var dup = false;
            for (var j = 0; j < tr.traces.length; j++) { if (tr.traces[j].path.toLowerCase() === p.toLowerCase()) { dup = true; break; } }
            if (dup) { res.already += 1; continue; }
            if (tr.traces.length >= trend.MAX_SOURCES) { res.over += 1; continue; }
            tr.traces.push({ path: p, label: trend.labelOf(p), color: trColor(), data: null, error: '' });
            res.added += 1;
        }
        trLegend();
        var bits = [];
        if (res.over) { bits.push(res.over + ' not added: a quick trend holds ' + trend.MAX_SOURCES + ' sources'); }
        if (res.already && !res.added) { bits.push('already on this trend'); }
        tr.flash = bits.join(' · ');
        trFetch();
        try { tr.el.focus(); } catch (e) { /* focus is a nicety */ }
        return res;
    };

    trend.remove = function (index) {
        if (!tr || !tr.traces[index]) { return; }
        tr.traces.splice(index, 1);
        if (!tr.traces.length) { trend.close(); return; }
        trLegend();
        trDraw();
    };

    trend.setRange = function (key) {
        if (!tr) { return; }
        tr.range = key;
        if (tr.select) { tr.select.value = key; }
        trFetch();
    };

    trend.close = function () {
        if (!tr) { return; }
        if (tr.timer) { clearInterval(tr.timer); }
        if (tr.ro && tr.ro.disconnect) { try { tr.ro.disconnect(); } catch (e) { /* gone */ } }
        if (tr.onHash) { root.removeEventListener('hashchange', tr.onHash, false); }
        if (tr.el && tr.el.parentNode) { tr.el.parentNode.removeChild(tr.el); }
        tr = null;
    };

    function trColor() {
        var used = {};
        for (var i = 0; i < tr.traces.length; i++) { used[tr.traces[i].color] = true; }
        for (var k = 0; k < color.categorical.length; k++) { if (!used[color.categorical[k]]) { return color.categorical[k]; } }
        return color.categorical[tr.traces.length % color.categorical.length];
    }

    function trEl(tag, cls, parent, text) {
        var e = root.document.createElement(tag);
        if (cls) { e.className = cls; }
        if (text !== undefined) { e.textContent = text; }
        if (parent) { parent.appendChild(e); }
        return e;
    }

    function trBuild(t) {
        var doc = root.document;
        var el = trEl('div', 'pvx-qt' + (t.dark ? ' pvx-qt-dark' : ''));
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Quick trend');
        el.tabIndex = -1;
        el.style.setProperty('--pvx-qt-surface', t.surface === 'transparent' ? (t.dark ? '#22262b' : '#ffffff') : t.surface);
        el.style.setProperty('--pvx-qt-text', t.text);
        el.style.setProperty('--pvx-qt-muted', t.textMuted);
        el.style.setProperty('--pvx-qt-border', t.border);
        // Near the top right, clear of PI Vision's own toolbar, on any screen.
        var vw = root.innerWidth || 1024;
        var w = Math.min(560, Math.max(280, vw - 32));
        el.style.width = w + 'px';
        el.style.height = '300px';
        el.style.left = Math.max(8, vw - w - 24) + 'px';
        el.style.top = '72px';

        var head = trEl('div', 'pvx-qt-head', el);
        trEl('span', 'pvx-qt-title', head, 'Quick trend');
        var sel = trEl('select', 'pvx-qt-range', head);
        sel.title = 'Time range of this trend';
        for (var i = 0; i < trend.RANGES.length; i++) {
            var o = trEl('option', '', sel, trend.RANGES[i][1]);
            o.value = trend.RANGES[i][0];
        }
        sel.onchange = function () { trend.setRange(sel.value); };
        var x = trEl('button', 'pvx-qt-close', head, '×');
        x.type = 'button';
        x.title = 'Close the trend';
        x.setAttribute('aria-label', 'Close the trend');
        x.onclick = function () { trend.close(); };
        var legend = trEl('div', 'pvx-qt-legend', el);
        var plot = trEl('div', 'pvx-qt-plot', el);
        var foot = trEl('div', 'pvx-qt-foot', el);
        doc.body.appendChild(el);

        tr = { el: el, head: head, select: sel, legend: legend, plot: plot, foot: foot, traces: [],
            range: 'display', gen: 0, phase: 'idle', note: '', flash: '', hoverT: null, theme: t, w: 0, h: 0 };

        el.onkeydown = function (ev) {
            if (ev && (ev.key === 'Escape' || ev.keyCode === 27)) { trend.close(); }
        };
        trDraggable(head);
        // A resize from the corner redraws at the new size.
        if (root.ResizeObserver) {
            tr.ro = new root.ResizeObserver(function () { if (tr) { trDraw(); } });
            tr.ro.observe(plot);
        } else {
            el.addEventListener('mouseup', function () { if (tr) { trDraw(); } }, false);
        }
        plot.addEventListener('mousemove', trHover, false);
        plot.addEventListener('mouseleave', function () { if (tr) { tr.hoverT = null; trFoot(); trCursor(); } }, false);
        tr.onHash = function () { if (tr && tr.range === 'display') { trFetch(); } };
        root.addEventListener('hashchange', tr.onHash, false);
        tr.timer = setInterval(function () {
            if (tr && trend.window(tr.range).live) { trFetch(true); }
        }, trend.REFRESH_MS);
    }

    function trDraggable(head) {
        head.addEventListener('mousedown', function (ev) {
            var tag = ev.target && ev.target.tagName;
            if (tag === 'SELECT' || tag === 'BUTTON' || tag === 'OPTION' || ev.button !== 0) { return; }
            var el = tr.el;
            var x0 = ev.clientX, y0 = ev.clientY;
            var l0 = parseFloat(el.style.left) || 0, t0 = parseFloat(el.style.top) || 0;
            var move = function (e) {
                var vw = root.innerWidth || 1024, vh = root.innerHeight || 768;
                // The header stays on screen, so the panel can always be dragged back.
                el.style.left = util.clamp(l0 + e.clientX - x0, 40 - el.offsetWidth, vw - 40) + 'px';
                el.style.top = util.clamp(t0 + e.clientY - y0, 0, vh - 30) + 'px';
            };
            var up = function () {
                root.document.removeEventListener('mousemove', move, false);
                root.document.removeEventListener('mouseup', up, false);
            };
            root.document.addEventListener('mousemove', move, false);
            root.document.addEventListener('mouseup', up, false);
            if (ev.preventDefault) { ev.preventDefault(); }
        }, false);
    }

    function trLegend() {
        var lg = tr.legend;
        while (lg.firstChild) { lg.removeChild(lg.firstChild); }
        for (var i = 0; i < tr.traces.length; i++) {
            var x = tr.traces[i];
            var chip = trEl('span', 'pvx-qt-chip', lg);
            chip.title = x.path;
            var sw = trEl('span', 'pvx-qt-swatch', chip);
            sw.style.background = x.color;
            trEl('span', 'pvx-qt-name', chip, x.label);
            var rm = trEl('button', 'pvx-qt-remove', chip, '×');
            rm.type = 'button';
            rm.title = 'Take ' + x.label + ' off the trend';
            rm.setAttribute('aria-label', rm.title);
            rm.onclick = (function (k) { return function () { trend.remove(k); }; }(i));
        }
    }

    function trWebId(p) {
        var k = p.toLowerCase();
        if (trIds[k]) { return trIds[k]; }
        var job = api.get((p.indexOf('|') !== -1 ? 'attributes' : 'points') + '?path=' + encodeURIComponent(p) +
            '&selectedFields=WebId').then(function (r) {
            if (!r || !r.WebId) { throw { message: 'PI Web API does not know ' + p + '.' }; }
            return r.WebId;
        });
        trIds[k] = job;
        job.then(null, function () { if (trIds[k] === job) { delete trIds[k]; } });
        return job;
    }

    function trErr(e) {
        return (e && e.pvxError && e.pvxError.message) || (e && e.message) || 'PI Web API did not answer.';
    }

    /** Ask for every trace's plot values; quiet=true keeps the drawing while it reads. */
    function trFetch(quiet) {
        if (!tr) { return; }
        var gen = ++tr.gen;
        if (api.discovering()) {
            tr.phase = 'loading';
            trDraw();
            api.discover().then(function () { if (tr && gen === tr.gen) { trFetch(); } });
            return;
        }
        if (!api.isConfigured()) { tr.phase = 'unconfigured'; trDraw(); return; }
        var win = trend.window(tr.range);
        tr.win = win;
        if (!quiet) { tr.phase = 'loading'; trDraw(); }
        // About one plot interval per two pixels: the archive returns up to
        // five values per interval, so a 500 px plot asks for ~1250 values.
        var intervals = Math.max(50, Math.min(1000, Math.round((tr.plot.clientWidth || 500) / 2)));
        var jobs = tr.traces.map(function (x) {
            return trWebId(x.path).then(function (id) {
                return api.get('streams/' + encodeURIComponent(id) + '/plot?startTime=' + encodeURIComponent(win.start) +
                    '&endTime=' + encodeURIComponent(win.end) + '&intervals=' + intervals +
                    '&selectedFields=Items.Timestamp;Items.Value;Items.Good;Items.UnitsAbbreviation', { cache: false });
            }).then(function (res) {
                x.data = trend.points((res && res.Items) || []);
                x.error = '';
            }, function (e) {
                x.data = null;
                x.error = trErr(e);
            });
        });
        Promise.all(jobs).then(function () {
            if (!tr || gen !== tr.gen) { return; }
            tr.phase = 'ok';
            trDraw();
        });
    }

    function trMsg(head, detail, tone) {
        var plot = tr.plot;
        while (plot.firstChild) { plot.removeChild(plot.firstChild); }
        var m = trEl('div', 'pvx-qt-msg' + (tone ? ' pvx-qt-' + tone : ''), plot);
        trEl('div', 'pvx-qt-msg-head', m, head);
        if (detail) { trEl('div', 'pvx-qt-msg-detail', m, detail); }
    }

    /**
     * The plot's model: one axis when every drawn trace has the same units,
     * else each trace on its own scale, said in the footer, because a 0-1100
     * psig line and a 0-6 mils line on one axis is one flat line.
     */
    function trModel() {
        var drawn = [], i, j;
        for (i = 0; i < tr.traces.length; i++) {
            var x = tr.traces[i];
            if (x.data && x.data.pts.length) { drawn.push(x); }
        }
        var units = {}, nUnits = 0;
        for (i = 0; i < drawn.length; i++) {
            var u = drawn[i].data.units || '';
            if (!Object.prototype.hasOwnProperty.call(units, u)) { units[u] = true; nUnits += 1; }
        }
        var shared = nUnits <= 1;
        var lo = Infinity, hi = -Infinity;
        for (i = 0; i < drawn.length; i++) {
            var mn = Infinity, mx = -Infinity;
            for (j = 0; j < drawn[i].data.pts.length; j++) {
                var v = drawn[i].data.pts[j].v;
                if (v < mn) { mn = v; }
                if (v > mx) { mx = v; }
            }
            drawn[i].min = mn;
            drawn[i].max = mx;
            if (mn < lo) { lo = mn; }
            if (mx > hi) { hi = mx; }
        }
        return { drawn: drawn, shared: shared, lo: lo, hi: hi, units: shared && drawn.length ? (drawn[0].data.units || '') : '' };
    }

    function trDraw() {
        if (!tr) { return; }
        tr.model = tr.phase === 'ok' ? trModel() : null;
        trFoot();
        // A source with nothing drawn keeps its chip, dimmed, so it can be removed.
        var chips = tr.legend.children;
        for (var c = 0; c < chips.length && c < tr.traces.length; c++) {
            var none = tr.phase === 'ok' && !(tr.traces[c].data && tr.traces[c].data.pts.length);
            chips[c].className = 'pvx-qt-chip' + (none ? ' pvx-qt-chip-none' : '');
        }
        if (tr.phase === 'unconfigured') {
            trMsg('PI Web API is not configured', api.unsetHint() + ', then confirm it with ext/piwebapi-check.html. ' +
                'A quick trend reads history from PI Web API.', 'warn');
            return;
        }
        if (tr.phase === 'loading' || tr.phase === 'idle') { trMsg('Reading history…', ''); return; }
        var m = tr.model;
        if (!m.drawn.length) {
            var why = [];
            for (var e = 0; e < tr.traces.length; e++) {
                var tx = tr.traces[e];
                why.push(tx.label + ': ' + (tx.error || (tx.data && tx.data.text ? 'no numbers, only states or text' : 'no good values in this range')));
            }
            trMsg('Nothing to draw', why.join(' · '), tr.traces.some(function (q) { return !!q.error; }) ? 'alarm' : 'warn');
            return;
        }
        var plot = tr.plot;
        var W = plot.clientWidth || 500, H = plot.clientHeight || 200;
        tr.w = W; tr.h = H;
        while (plot.firstChild) { plot.removeChild(plot.firstChild); }
        var s = svg.el('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'class': 'pvx-qt-svg' }, plot);
        var t = tr.theme;
        var font = 10;
        var win = tr.win || trend.window(tr.range);
        var from = win.from, to = win.to;
        if (from === null || to === null || !(to > from)) {
            from = Infinity; to = -Infinity;
            for (var a = 0; a < m.drawn.length; a++) {
                var ps = m.drawn[a].data.pts;
                if (ps[0].t < from) { from = ps[0].t; }
                if (ps[ps.length - 1].t > to) { to = ps[ps.length - 1].t; }
            }
            if (!(to > from)) { to = from + 60000; }
        }
        var dom = m.shared ? scale.niceDomain(m.lo, m.hi, 5) : [0, 100];
        var mL = m.shared ? 8 + Math.max(fmt.tick(dom[0]).length, fmt.tick(dom[1]).length) * font * 0.62 : 34;
        var plotBox = { x: mL, y: 6, x1: W - 8, y1: H - 18 };
        var xs = scale.linear(from, to, plotBox.x, plotBox.x1);
        var ys = scale.linear(dom[0], dom[1], plotBox.y1, plotBox.y);
        tr.xs = xs;
        tr.box = plotBox;
        // Grid and axes.
        var ticks = scale.ticks(dom[0], dom[1], 4);
        for (var k = 0; k < ticks.length; k++) {
            var yy = ys(ticks[k]);
            svg.el('line', { x1: plotBox.x, x2: plotBox.x1, y1: yy.toFixed(1), y2: yy.toFixed(1), stroke: t.grid, 'stroke-width': 1 }, s);
            svg.text(s, (plotBox.x - 4).toFixed(1), (yy + 3).toFixed(1), m.shared ? fmt.tick(ticks[k]) : ticks[k] + '%',
                { 'class': 'pvx-svg-label', 'font-size': font, 'text-anchor': 'end', fill: t.textMuted });
        }
        var span = to - from;
        var nT = Math.max(2, Math.floor((plotBox.x1 - plotBox.x) / 90));
        for (var q = 0; q <= nT; q++) {
            var tt = from + span * q / nT;
            var xx = xs(tt);
            // A day or more repeats the clock times: the date tells them apart.
            var lab = span > 20 * 3600000 ? fmt.time(tt, 'short') : fmt.time(tt).slice(0, 5);
            svg.text(s, xx.toFixed(1), (H - 5).toFixed(1), lab, { 'class': 'pvx-svg-label', 'font-size': font,
                'text-anchor': q === 0 ? 'start' : (q === nT ? 'end' : 'middle'), fill: t.textMuted });
        }
        svg.el('line', { x1: plotBox.x, x2: plotBox.x1, y1: plotBox.y1, y2: plotBox.y1, stroke: t.axis, 'stroke-width': 1 }, s);
        // Traces, as steps: PI values hold until the next one.
        for (var d = 0; d < m.drawn.length; d++) {
            var tr2 = m.drawn[d];
            var lo = tr2.min, hi = tr2.max;
            var own = function (v) { return hi > lo ? (v - lo) / (hi - lo) * 100 : 50; };
            var pts = [];
            for (var n = 0; n < tr2.data.pts.length; n++) {
                var pt = tr2.data.pts[n];
                pts.push({ x: xs(pt.t), y: ys(m.shared ? pt.v : own(pt.v)) });
            }
            svg.el('path', { d: svg.stepLine(pts), fill: 'none', stroke: tr2.color, 'stroke-width': 1.6,
                'stroke-linejoin': 'round', 'class': 'pvx-qt-line' }, s);
        }
        tr.cursor = svg.el('line', { x1: 0, x2: 0, y1: plotBox.y, y2: plotBox.y1, stroke: t.axis, 'stroke-width': 1,
            'stroke-dasharray': '3 3', visibility: 'hidden', 'class': 'pvx-qt-cursor' }, s);
        trCursor();
    }

    function trCursor() {
        if (!tr || !tr.cursor) { return; }
        if (tr.hoverT === null || !tr.xs) { tr.cursor.setAttribute('visibility', 'hidden'); return; }
        var x = tr.xs(tr.hoverT).toFixed(1);
        tr.cursor.setAttribute('x1', x);
        tr.cursor.setAttribute('x2', x);
        tr.cursor.setAttribute('visibility', 'visible');
    }

    function trHover(ev) {
        if (!tr || !tr.xs || !tr.box) { return; }
        var r = tr.plot.getBoundingClientRect();
        var x = ev.clientX - r.left;
        if (x < tr.box.x || x > tr.box.x1) { tr.hoverT = null; } else { tr.hoverT = tr.xs.invert(x); }
        trFoot();
        trCursor();
    }

    /** The value a step line shows at time t: the last one at or before it. */
    trend.valueAt = function (pts, t) {
        var lo = 0, hi = pts.length - 1, best = -1;
        while (lo <= hi) {
            var mid = (lo + hi) >> 1;
            if (pts[mid].t <= t) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
        }
        return best === -1 ? null : pts[best].v;
    };

    function trFoot() {
        if (!tr) { return; }
        var f = tr.foot;
        var parts = [];
        var m = tr.model;
        if (tr.hoverT !== null && m && m.drawn.length) {
            parts.push(fmt.time(tr.hoverT, 'datetime'));
            for (var i = 0; i < m.drawn.length; i++) {
                var v = trend.valueAt(m.drawn[i].data.pts, tr.hoverT);
                parts.push(m.drawn[i].label + ' ' + (v === null ? '--' : fmt.number(v) + (m.drawn[i].data.units ? ' ' + m.drawn[i].data.units : '')));
            }
        } else if (tr.phase === 'ok') {
            if (m && m.shared && m.units) { parts.push(m.units); }
            if (m && !m.shared && m.drawn.length > 1) {
                parts.push('units differ: each trace on its own scale (' + m.drawn.map(function (x) {
                    return x.label + ' ' + fmt.number(x.min) + '–' + fmt.number(x.max) + (x.data.units ? ' ' + x.data.units : '');
                }).join(', ') + ')');
            }
            for (var j = 0; j < tr.traces.length; j++) {
                var x = tr.traces[j];
                if (x.error) { parts.push(x.label + ': ' + x.error); continue; }
                if (!x.data) { continue; }
                if (!x.data.pts.length) { parts.push(x.label + ': ' + (x.data.text ? 'states or text, not drawn' : 'no good values')); continue; }
                if (x.data.bad) { parts.push(x.label + ': ' + x.data.bad + ' bad value' + (x.data.bad === 1 ? '' : 's') + ' left out'); }
                if (x.data.text) { parts.push(x.label + ': ' + x.data.text + ' non-numeric left out'); }
            }
            if (tr.flash) { parts.push(tr.flash); }
        }
        f.textContent = parts.join(' · ');
        f.title = f.textContent;
    }

    /**
     * Wire the overlay into one symbol. Called by bootstrap; update() runs
     * after every render, so a config change shows at once.
     */
    overlay.bind = function (ctx, hooks) {
        var el = null, menu = null, badge = null, note = null, rangeEl = null, filterEl = null;
        var timer = null, noteTimer = null;
        var hidden = false;

        function cfg() { return ctx.config || {}; }

        function name() {
            var c = cfg();
            var base = c.Title || (ctx.scope && ctx.scope.symbol && ctx.scope.symbol.Name) || 'pvx';
            var d = new Date();
            var pad2 = function (n) { return (n < 10 ? '0' : '') + n; };
            return base + ' ' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
                ' ' + pad2(d.getHours()) + pad2(d.getMinutes());
        }

        function say(text) {
            if (!el) { return; }
            if (!note) { note = document.createElement('div'); note.className = 'pvx-overlay-note'; el.appendChild(note); }
            note.textContent = text;
            note.style.display = text ? '' : 'none';
            if (noteTimer) { clearTimeout(noteTimer); }
            if (text) { noteTimer = setTimeout(function () { say(''); }, 6000); }
        }

        function background() {
            var t = ctx.theme || {};
            return cfg().Transparent ? 'transparent' : (cfg().BackgroundColor || t.surface || '#ffffff');
        }

        function act(kind) {
            closeMenu();
            var n = ctx.node;
            try {
                if (kind === 'csv') {
                    var rows = hooks.csv ? hooks.csv(ctx) : overlay.csvRows(ctx.data);
                    if (!rows || rows.length < 2) { say('No data to save'); return; }
                    if (!download.csv(name(), rows)) { say('This browser cannot save files from a page'); }
                    return;
                }
                if (kind === 'svg') {
                    var s = overlay.mainSvg(n);
                    if (!s) { say('This symbol is not a drawing; save it as an image'); return; }
                    if (!download.text(download.fileName(name(), 'svg'), overlay.svgText(s, background()), 'image/svg+xml')) {
                        say('This browser cannot save files from a page');
                    }
                    return;
                }
                overlay.png(n, background()).then(function (url) {
                    if (!overlay.saveDataUrl(download.fileName(name(), 'png'), url)) { say('This browser cannot save files from a page'); }
                }, function (e) {
                    say('No image: ' + ((e && e.message) || 'the browser refused') + '. Try SVG or CSV, or a screenshot.');
                });
            } catch (e) {
                say('Could not save: ' + ((e && e.message) || e));
            }
        }

        function closeMenu() { if (menu) { menu.style.display = 'none'; } }

        function build() {
            el = document.createElement('div');
            el.className = 'pvx-overlay';
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'pvx-overlay-btn';
            btn.title = 'Save as image or data';
            btn.setAttribute('aria-label', 'Save as image or data');
            btn.textContent = '⤓';
            menu = document.createElement('div');
            menu.className = 'pvx-overlay-menu';
            menu.style.display = 'none';
            var opts = [['png', 'Image (PNG)'], ['svg', 'Drawing (SVG)'], ['csv', 'Data (CSV)']];
            for (var i = 0; i < opts.length; i++) {
                var b = document.createElement('button');
                b.type = 'button';
                b.className = 'pvx-overlay-item';
                b.setAttribute('data-kind', opts[i][0]);
                b.textContent = opts[i][1];
                b.onclick = (function (k) { return function (ev) { if (ev) { ev.stopPropagation(); } act(k); }; }(opts[i][0]));
                menu.appendChild(b);
            }
            btn.onclick = function (ev) {
                if (ev) { ev.stopPropagation(); }
                var open = menu.style.display !== 'none';
                if (!open) {
                    // SVG only where there is a drawing to save.
                    var svgItem = menu.querySelector('[data-kind="svg"]');
                    if (svgItem) { svgItem.style.display = overlay.mainSvg(ctx.node) ? '' : 'none'; }
                }
                menu.style.display = open ? 'none' : '';
            };
            el.appendChild(btn);
            el.appendChild(menu);
            // Quick trend: opens the trend panel, or adds to the one open.
            var tbtn = document.createElement('button');
            tbtn.type = 'button';
            tbtn.className = 'pvx-overlay-btn pvx-overlay-trend';
            tbtn.textContent = '\u223f';
            var trendTitle = function () {
                tbtn.title = trend.isOpen() ? 'Add this symbol\'s data to the quick trend' : 'Quick trend of this symbol\'s data';
                tbtn.setAttribute('aria-label', tbtn.title);
            };
            trendTitle();
            tbtn.onmouseenter = trendTitle;
            tbtn.onfocus = trendTitle;
            tbtn.onclick = function (ev) {
                if (ev) { ev.stopPropagation(); }
                closeMenu();
                var ds = ctx.scope && ctx.scope.symbol && ctx.scope.symbol.DataSources;
                var list = [];
                for (var k = 0; ds && k < ds.length; k++) { list.push(ds[k]); }
                if (!list.length) { say('This symbol has no data source to trend'); return; }
                trend.open(list, { theme: ctx.theme });
            };
            el.appendChild(tbtn);
        }

        function attach(want) {
            var n = ctx.node;
            if (!want) {
                if (el && el.parentNode) { el.parentNode.removeChild(el); }
                return null;
            }
            if (!el) { build(); }
            // The node can be swapped by ng-if; follow it.
            if (n && el.parentNode !== n) { n.appendChild(el); }
            return el;
        }

        function staleCheck() {
            var c = cfg();
            var mins = util.num(c.StaleBadgeMinutes);
            if (!(mins > 0) || !ctx.data) { return null; }
            var now = Date.now();
            var th = mins * 60000;
            if (overlay.historical(th, now)) { return null; }
            var t = overlay.newest(ctx.data);
            if (t === null || now - t <= th) { return null; }
            return t;
        }

        function update() {
            var c = cfg();
            var n = ctx.node;
            var staleAt = staleCheck();
            // An AF search reads its own range, so its badge says both.
            var range = (ctx.afsource && ctx.afsource.badge()) || (ctx.ownrange ? ctx.ownrange.badge() : null);
            var picked = ctx.filter ? ctx.filter.badge() : null;
            var want = !!c.ExportMenu || !!c.QuickTrend || staleAt !== null || !!range || !!picked;
            var host = attach(want);
            if (host) {
                var btn = host.querySelector('.pvx-overlay-btn');
                if (btn) { btn.style.display = c.ExportMenu ? '' : 'none'; }
                var tb = host.querySelector('.pvx-overlay-trend');
                if (tb) { tb.style.display = c.QuickTrend ? '' : 'none'; }
                if (range) {
                    if (!rangeEl) { rangeEl = document.createElement('div'); rangeEl.className = 'pvx-overlay-range'; host.appendChild(rangeEl); }
                    rangeEl.textContent = range.text;
                    rangeEl.title = range.title;
                    rangeEl.className = 'pvx-overlay-range' + (range.warn ? ' pvx-overlay-range-warn' : '');
                    rangeEl.style.display = '';
                } else if (rangeEl) { rangeEl.style.display = 'none'; }
                if (picked) {
                    if (!filterEl) {
                        filterEl = document.createElement('button');
                        filterEl.type = 'button';
                        filterEl.className = 'pvx-overlay-filter';
                        host.appendChild(filterEl);
                    }
                    filterEl.textContent = picked.text;
                    filterEl.title = picked.title;
                    filterEl.setAttribute('aria-label', picked.title);
                    filterEl.onclick = function (ev) { if (ev) { ev.stopPropagation(); } picked.clear(); };
                    filterEl.style.display = '';
                } else if (filterEl) { filterEl.style.display = 'none'; }
                if (!c.ExportMenu) { closeMenu(); }
                if (staleAt !== null) {
                    if (!badge) { badge = document.createElement('div'); badge.className = 'pvx-overlay-stale'; host.appendChild(badge); }
                    badge.textContent = 'Stale · ' + fmt.duration(Date.now() - staleAt, { parts: 1 });
                    badge.title = 'Newest value ' + fmt.time(staleAt, 'datetime') + ', more than ' +
                        c.StaleBadgeMinutes + ' min ago. Check the data source and its interface.';
                    badge.style.display = '';
                } else if (badge) { badge.style.display = 'none'; }
            }
            // Rechecked on a timer as well: a source that stops updating may
            // stop PI Vision sending anything, and then nothing renders.
            var mins = util.num(c.StaleBadgeMinutes);
            if (mins > 0 && !timer) { timer = setInterval(function () { if (!ctx.destroyed) { update(); } }, 30000); }
            if (!(mins > 0) && timer) { clearInterval(timer); timer = null; }

            // Hidden only once data has arrived and has no value: a symbol
            // with no data sources, or before the first update, stays.
            var hide = !!c.HideWhenNoData && ctx.data !== null && !overlay.hasData(ctx.data);
            if (n && n.style && hide !== hidden) {
                n.style.visibility = hide ? 'hidden' : '';
                hidden = hide;
            }
        }

        return {
            update: update,
            destroy: function () {
                if (timer) { clearInterval(timer); }
                if (noteTimer) { clearTimeout(noteTimer); }
                if (el && el.parentNode) { el.parentNode.removeChild(el); }
            }
        };
    };

    /**
     * Show why a symbol could not start, on the symbol itself.
     *
     * Plain DOM and inline styles: whatever failed may be the very code that
     * would otherwise draw this, and the stylesheet may be the stale part.
     */
    function showFatal(elem, typeName, headline, detail) {
        try {
            var host = util.find(elem, '.pvx') || util.node(elem);
            if (!host || !host.appendChild) { return; }
            var box = root.document.createElement('div');
            box.className = 'pvx-fatal';
            box.setAttribute('style', 'position:absolute;left:0;top:0;right:0;bottom:0;z-index:5;' +
                'padding:10px;overflow:auto;background:#fff4f2;color:#5c1a10;border:1px solid #c8452f;' +
                'font:12px/1.4 "Segoe UI",Arial,sans-serif;white-space:normal;');
            var h = root.document.createElement('div');
            h.setAttribute('style', 'font-weight:600;margin-bottom:4px;');
            h.textContent = typeName + ': ' + headline;
            var d = root.document.createElement('div');
            d.textContent = detail;
            box.appendChild(h);
            box.appendChild(d);
            if (root.getComputedStyle && root.getComputedStyle(host).position === 'static') {
                host.style.position = 'relative';
            }
            host.appendChild(box);
        } catch (e) { /* nothing left to report with */ }
    }

    /**
     * Wrap a symbol's init so nothing it throws reaches PI Vision.
     *
     * An exception out of init() leaves PI Vision with a symbol it half-built:
     * the template is on the display, but the editor's own wiring for it never
     * ran, so the symbol stops answering right-click with Format Symbol and
     * can be neither edited nor removed in the normal way. Whatever the cause,
     * the symbol must stay a symbol and say what went wrong.
     *
     * The commonest cause is a mismatch: a symbol file from one release
     * calling a runtime pvx-core.js from another, because one of them was
     * served from a browser or proxy cache or did not update on the server.
     * build.js stamps each symbol file with its release, so that case is
     * named outright rather than surfacing as "x is not a function".
     */
    function guardInit(typeName, proto, build) {
        if (proto.pvxGuarded || typeof proto.init !== 'function') { return; }
        var init = proto.init;
        proto.pvxGuarded = true;
        proto.init = function (scope, elem) {
            if (build && build !== PVX.version) {
                if (root.console && root.console.error) {
                    root.console.error('[PVX] ' + typeName + ' is from ' + build + ' but pvx-core.js is ' + PVX.version);
                }
                showFatal(elem, typeName, 'files from two different releases',
                    'This symbol is from PVX ' + build + ' but the runtime ext/libraries/pvx/pvx-core.js the browser ' +
                    'loaded is ' + PVX.version + '. Clear the browser cache (Ctrl+F5) and reload. If it persists, ' +
                    'reinstall the same release on this PI Vision server so every file matches.');
                return null;
            }
            try {
                return init.apply(this, arguments);
            } catch (e) {
                if (root.console && root.console.error) { root.console.error('[PVX] ' + typeName + ' failed to start', e); }
                showFatal(elem, typeName, 'could not start',
                    String((e && e.message) || e) + '  \u2014  Check: the browser console (F12) for the line ' +
                    'starting [PVX], and that every PVX file on this server is from release ' + PVX.version + '.');
                return null;
            }
        };
    }

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
            if (def.visObjectType && def.visObjectType.prototype) {
                guardInit(def.typeName, def.visObjectType.prototype, PVX.symbolBuild || '');
            }
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

    /* ------------------------------------------------------------------ *
     * ownrange: a time range of the symbol's own (OwnTimeRange option)
     * ------------------------------------------------------------------ *
     * A time-series symbol can show its own range, "the last 30 days"
     * beside a display looking at the last hour, or "yesterday" on a shift
     * report. PI Vision's pipeline serves every symbol on a display the
     * display's range and offers a custom symbol no way to ask for another,
     * so with the option on the bootstrap swaps what the symbol is sent:
     * the pipeline's update still names the sources (labels, units, paths,
     * which PI Vision sends only now and then), and the values come from PI
     * Web API recorded values over the symbol's range. The symbol reads the
     * same shape either way and needs nothing of its own.
     *
     * It fails toward the display: with PI Web API unset or still being
     * found, the symbol is sent PI Vision's own data and the badge says the
     * range is not in force, rather than drawing nothing.
     */
    var ownrange = PVX.ownrange = {};

    ownrange.DEFAULT_MAX = 10000;

    /** Is the option in force for this config? Only time-series symbols have one. */
    ownrange.wanted = function (cfg) {
        return !!(cfg && cfg.OwnTimeRange && cfg.DataShape === 'TimeSeries');
    };

    /** "Last 30 days", "Last 8 hours", else "start to end" as typed. */
    ownrange.label = function (start, end) {
        var s = String(start || '').replace(/\s+/g, '');
        var e = String(end || '').replace(/\s+/g, '');
        var m = /^\*-(\d+(?:\.\d+)?)(s|m|h|d|w|mo|y)$/i.exec(s);
        var words = { s: 'second', m: 'minute', h: 'hour', d: 'day', w: 'week', mo: 'month', y: 'year' };
        if (m && (e === '*' || e === '')) {
            var n = parseFloat(m[1]);
            var u = words[m[2].toLowerCase()];
            return n === 1 ? 'Last ' + u : 'Last ' + m[1] + ' ' + u + 's';
        }
        if (/^t$/i.test(s) && (e === '*' || e === '')) { return 'Today'; }
        if (/^y$/i.test(s) && /^t$/i.test(e)) { return 'Yesterday'; }
        return String(start || '*-1d') + ' to ' + String(end || '*');
    };

    /** Recorded items -> the pipeline's [{Time, Value}], states by name. */
    ownrange.values = function (items) {
        var out = [];
        for (var i = 0; i < (items || []).length; i++) {
            var it = items[i] || {};
            if (!it.Timestamp) { continue; }
            var v = it.Value;
            if (v !== null && typeof v === 'object') { v = v.Name !== undefined ? v.Name : v.Value; }
            out.push(it.Good === false ? { Time: it.Timestamp, Value: v, IsGood: false } : { Time: it.Timestamp, Value: v });
        }
        return out;
    };

    /**
     * Wire it into one symbol. Returns {take(d, deliver), badge(), destroy()}:
     * take() is handed every pipeline update and calls deliver() with what
     * the symbol should see, now or once PI Web API answers.
     */
    ownrange.bind = function (ctx) {
        var ids = {};
        var last = null;             // the latest pipeline update
        var key = '';                // what was last read: sources, range, max
        var readAt = 0, gen = 0, timer = null;
        var st = { phase: 'off', note: '', capped: [], failed: [] };

        function cfg() { return ctx.config || {}; }

        function sourcesOf() {
            var ds = ctx.scope && ctx.scope.symbol && ctx.scope.symbol.DataSources;
            var out = [];
            for (var i = 0; ds && i < ds.length; i++) { out.push(states.sourcePath(ds[i])); }
            return out;
        }

        function streamId(p) {
            var k = p.toLowerCase();
            if (ids[k]) { return ids[k]; }
            var job = api.get((p.indexOf('|') !== -1 ? 'attributes' : 'points') + '?path=' + encodeURIComponent(p) +
                '&selectedFields=WebId').then(function (r) {
                if (!r || !r.WebId) { throw { message: 'PI Web API does not know ' + p + '.' }; }
                return r.WebId;
            });
            ids[k] = job;
            job.then(null, function () { if (ids[k] === job) { delete ids[k]; } });
            return job;
        }

        function errText(e) {
            return (e && e.pvxError && e.pvxError.message) || (e && e.message) || 'PI Web API did not answer.';
        }

        function startEnd() {
            var c = cfg();
            return { start: String(c.OwnStart || '').replace(/^\s+|\s+$/g, '') || '*-1d',
                end: String(c.OwnEnd || '').replace(/^\s+|\s+$/g, '') || '*' };
        }

        function live() { return /\*/.test(startEnd().end); }

        /** The pipeline's update with each source's values replaced by `vals`. */
        function swap(d, vals) {
            var list = d && (d.Data || d.data);
            if (!list) { return d; }
            var out = {};
            for (var k in d) { if (Object.prototype.hasOwnProperty.call(d, k)) { out[k] = d[k]; } }
            // The window each item says it covers is the symbol's own, for
            // the symbols that lay their axis or rows out by it.
            var se = startEnd(), now = Date.now();
            var from = nav.parseTime(se.start, now), to = nav.parseTime(se.end, now);
            var items = [];
            for (var i = 0; i < list.length; i++) {
                var it = {};
                for (var f in list[i]) { if (Object.prototype.hasOwnProperty.call(list[i], f)) { it[f] = list[i][f]; } }
                var v = vals[i];
                if (v && v.error) {
                    it.Value = [];
                    it.IsGood = false;
                    it.ErrorDescription = v.error;
                } else if (v) {
                    it.Value = v.values;
                    it.IsGood = true;
                    it.ErrorDescription = '';
                }
                if (it.Values !== undefined) { delete it.Values; }
                if (from !== null && to !== null) {
                    it.StartTime = new Date(from).toISOString();
                    it.EndTime = new Date(to).toISOString();
                }
                items.push(it);
            }
            out[d.Data ? 'Data' : 'data'] = items;
            return out;
        }

        function read(deliver, force) {
            var c = cfg();
            var se = startEnd();
            var max = Math.max(100, Math.min(150000, parseInt(c.OwnMaxValues, 10) || ownrange.DEFAULT_MAX));
            var paths = sourcesOf();
            var k = paths.join('\n') + '|' + se.start + '|' + se.end + '|' + max;
            var every = Math.max(10, parseInt(c.OwnRefreshSeconds, 10) || 60) * 1000;
            if (!force && k === key && (st.phase === 'ok' || st.phase === 'loading') &&
                (!live() || Date.now() - readAt < every)) {
                return false;
            }
            key = k;
            readAt = Date.now();
            var g = ++gen;
            if (st.phase !== 'ok') { st.phase = 'loading'; }
            var jobs = paths.map(function (p) {
                if (!p) { return Promise.resolve({ error: 'no data source' }); }
                return streamId(p).then(function (id) {
                    return api.get('streams/' + encodeURIComponent(id) + '/recorded?startTime=' + encodeURIComponent(se.start) +
                        '&endTime=' + encodeURIComponent(se.end) + '&maxCount=' + max +
                        '&selectedFields=Items.Timestamp;Items.Value;Items.Good', { cache: false });
                }).then(function (res) {
                    var items = (res && res.Items) || [];
                    return { values: ownrange.values(items), capped: items.length >= max, path: p };
                }, function (e) { return { error: errText(e), path: p }; });
            });
            Promise.all(jobs).then(function (vals) {
                if (ctx.destroyed || g !== gen) { return; }
                st.phase = 'ok';
                st.vals = vals;
                st.capped = [];
                st.failed = [];
                for (var i = 0; i < vals.length; i++) {
                    if (vals[i].capped) { st.capped.push(vals[i].path); }
                    if (vals[i].error) { st.failed.push(vals[i].path + ': ' + vals[i].error); }
                }
                if (last) { deliver(swap(last, vals)); }
            });
            return true;
        }

        return {
            /**
             * One pipeline update. Off: passed straight on. On: the values
             * read for the symbol's range, swapped in; a read is started when
             * the sources or range changed, or a live range is due.
             */
            take: function (d, deliver) {
                if (!ownrange.wanted(cfg())) {
                    st.phase = 'off';
                    deliver(d);
                    return;
                }
                last = d;
                if (api.discovering()) {
                    st.phase = 'finding';
                    api.discover().then(function () { if (!ctx.destroyed && last) { read(deliver, true); } });
                    deliver(d);
                    return;
                }
                if (!api.isConfigured()) {
                    st.phase = 'unconfigured';
                    deliver(d);
                    return;
                }
                read(deliver, false);
                // Until the first read answers the symbol waits on it, rather
                // than drawing the display's range under the symbol's label.
                if (st.phase === 'ok' && st.vals) { deliver(swap(d, st.vals)); }
                if (!timer) {
                    timer = setInterval(function () {
                        if (!ctx.destroyed && last && ownrange.wanted(cfg()) && live()) { read(deliver, false); }
                    }, 10000);
                }
            },
            /** {text, title, warn} for the overlay, or null when off. */
            badge: function () {
                if (!ownrange.wanted(cfg())) { return null; }
                var se = startEnd();
                var label = ownrange.label(se.start, se.end);
                if (st.phase === 'unconfigured') {
                    return { text: label + ' (not in force)', warn: true,
                        title: 'This symbol is set to show ' + se.start + ' to ' + se.end + ', which needs PI Web API. ' +
                            api.unsetHint() + '. It shows the display\'s time range until then.' };
                }
                var bits = ['This symbol shows ' + se.start + ' to ' + se.end + ', not the display\'s time range.'];
                if (st.phase === 'loading' || st.phase === 'finding') { bits.push('Reading recorded values from PI Web API.'); }
                if (st.capped.length) { bits.push('Only the first ' + (parseInt(cfg().OwnMaxValues, 10) || ownrange.DEFAULT_MAX) + ' values read for: ' + st.capped.join(', ') + '.'); }
                if (st.failed.length) { bits.push('Not read: ' + st.failed.join('; ') + '.'); }
                return { text: label + (st.capped.length || st.failed.length ? ' ⚠' : ''), title: bits.join(' '),
                    warn: !!(st.capped.length || st.failed.length) };
            },
            /** Read again now: the range or the sources changed in the pane. */
            changed: function (deliver) {
                if (last && ownrange.wanted(cfg()) && api.isConfigured()) { read(deliver, true); }
                else if (last) { deliver(last); }
            },
            destroy: function () {
                if (timer) { clearInterval(timer); timer = null; }
                gen += 1;
            }
        };
    };

    /* ------------------------------------------------------------------ *
     * afsource: an AF search as a symbol's data (SourceMode 'search')
     * ------------------------------------------------------------------ *
     * A chart of "every compressor under this area" should not need its
     * display edited when a fourteenth compressor is commissioned, and PI
     * Vision's data sources cannot grow by themselves. With the option on,
     * the bootstrap swaps what the symbol is sent for rows built from an AF
     * search: the elements under a root (the display's asset by default), of
     * a template, matching a name, and the attributes named in the pane.
     * The symbol reads the same shape it always reads (Table rows, or
     * TimeSeries items) and needs nothing of its own beyond knowing which
     * row is which asset and attribute (`asset`, `attribute` on each row).
     *
     * The search is one request, asked again only when what it searches for
     * changes; the values are one PVX.api.batch per refresh, a stream set
     * per element filtered to each attribute name. An element without an
     * attribute, a failed read, a search cut short: each is counted in the
     * badge on the symbol, never dropped quietly.
     *
     * Mock-proven only (tools/test-overview.js), like the rest of PVX.api.
     */
    var afsource = PVX.afsource = {};

    afsource.DEFAULTS = {
        SourceMode: 'sources',        // sources | search
        SearchRoot: '',               // used when the display names no asset
        SearchTemplate: '',
        SearchNameFilter: '',
        SearchDescendants: true,
        SearchAttributes: '',         // names, comma separated
        SearchMax: 50,
        SearchRefreshSeconds: 60
    };

    /** The defaults, merged into a symbol's own. */
    afsource.defaults = function (cfg) {
        var out = cfg || {};
        for (var k in afsource.DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(afsource.DEFAULTS, k)) { out[k] = afsource.DEFAULTS[k]; }
        }
        return out;
    };

    afsource.wanted = function (cfg) { return !!(cfg && cfg.SourceMode === 'search'); };

    /** "Power, Flow; Status" -> ['Power', 'Flow', 'Status'], once each. */
    afsource.attributes = function (text) {
        var parts = String(text === null || text === undefined ? '' : text).split(/[,;\n]/);
        var out = [], seen = {};
        for (var i = 0; i < parts.length; i++) {
            var a = parts[i].replace(/^\s+|\s+$/g, '');
            if (a && !seen[a.toLowerCase()]) { seen[a.toLowerCase()] = true; out.push(a); }
        }
        return out;
    };

    /**
     * Rows of an AF search, by attribute: `byAttr[i]` holds the rows of the
     * i-th attribute named in the pane. A symbol that charts one quantity
     * takes byAttr[0] and names the rest in its footer (`unused`); one that
     * pairs two (size and colour) takes two.
     */
    afsource.split = function (rows, cfg, uses) {
        var attrs = afsource.attributes(cfg && cfg.SearchAttributes);
        var byAttr = [];
        for (var a = 0; a < attrs.length; a++) {
            var list = [];
            for (var i = 0; i < rows.length; i++) {
                if (String(rows[i].attribute).toLowerCase() === attrs[a].toLowerCase()) { list.push(rows[i]); }
            }
            byAttr.push(list);
        }
        return { attrs: attrs, byAttr: byAttr, unused: attrs.slice(uses || 1) };
    };

    /* PI Vision's statistic names, as PI Web API's summaryType. */
    afsource.SUMMARY = { Average: 'Average', Minimum: 'Minimum', Maximum: 'Maximum', Range: 'Range', StdDev: 'StdDev', Total: 'Total' };

    /**
     * Wire it into one symbol. Returns {take(d, deliver), changed(deliver),
     * badge(), destroy()}, as ownrange does.
     */
    afsource.bind = function (ctx) {
        var st = { phase: 'off', elements: [], truncated: false, root: '', key: '', error: null,
            failed: 0, missing: {}, readAt: 0, out: null, range: null };
        var gen = 0, timer = null, last = null, sink = null, reading = '';

        function cfg() { return ctx.config || {}; }
        function trim(s) { return String(s === null || s === undefined ? '' : s).replace(/^\s+|\s+$/g, ''); }
        function lc(s) { return trim(s).toLowerCase(); }

        function root() {
            return trim(nav.currentAsset()) || trim(cfg().SearchRoot) || nav.sourceAsset(ctx.scope);
        }

        function maxOf() { return Math.max(1, Math.min(1000, parseInt(cfg().SearchMax, 10) || 50)); }

        /**
         * The time the values cover: the symbol's own range when it has one,
         * else the display's, as the pipeline's own update states it (an
         * absolute range PI Vision resolved), else the address, else PI
         * Vision's default eight hours.
         */
        function range() {
            var c = cfg();
            if (ownrange.wanted(c)) {
                return { start: trim(c.OwnStart) || '*-1d', end: trim(c.OwnEnd) || '*', own: true };
            }
            var list = last && (last.Data || last.data);
            var first = list && list[0];
            if (first && first.StartTime && first.EndTime) { return { start: first.StartTime, end: first.EndTime }; }
            var p = {};
            try { p = nav.parseHash().params || {}; } catch (e) { p = {}; }
            return { start: p.starttime || p.StartTime || '*-8h', end: p.endtime || p.EndTime || '*' };
        }

        function searchKey() {
            var c = cfg();
            return [lc(root()), lc(c.SearchTemplate), lc(c.SearchNameFilter), c.SearchDescendants !== false, maxOf()].join('|');
        }

        function search() {
            var r = root();
            var c = cfg();
            var max = maxOf();
            var isDb = nav.databaseOf(r).toLowerCase() === trim(r).replace(/\\$/, '').toLowerCase();
            var kind = isDb ? 'assetdatabases' : 'elements';
            return api.get(kind + '?path=' + encodeURIComponent(r) + '&selectedFields=WebId;Name;Path')
                .then(null, function (err) {
                    if (err && err.pvxError && err.pvxError.code === 'not-found') { return null; }
                    throw err;
                })
                .then(function (el) {
                    if (!el || !el.WebId) {
                        throw { pvxError: { message: 'There is no AF ' + (isDb ? 'database' : 'element') + ' at "' + r + '".',
                            check: 'the display\'s asset, or Search root in the format pane' } };
                    }
                    var q = ['selectedFields=Items.WebId;Items.Name;Items.Path;Items.TemplateName', 'maxCount=' + (max + 1)];
                    if (c.SearchDescendants !== false) { q.push('searchFullHierarchy=true'); }
                    if (trim(c.SearchTemplate)) { q.push('templateName=' + encodeURIComponent(trim(c.SearchTemplate))); }
                    if (trim(c.SearchNameFilter)) { q.push('nameFilter=' + encodeURIComponent(trim(c.SearchNameFilter))); }
                    return api.get(kind + '/' + encodeURIComponent(el.WebId) + '/elements?' + q.join('&'), { cache: false });
                })
                .then(function (res) {
                    var items = (res && res.Items) || [];
                    var els = [];
                    for (var i = 0; i < items.length && els.length < max; i++) {
                        var it = items[i];
                        if (!it || !it.WebId || !it.Path) { continue; }
                        var parent = nav.parentOf(it.Path);
                        els.push({ name: it.Name || it.Path.slice(it.Path.lastIndexOf('\\') + 1), path: it.Path, webId: it.WebId,
                            template: trim(it.TemplateName), parent: parent.slice(parent.lastIndexOf('\\') + 1) });
                    }
                    st.truncated = items.length > max;
                    st.elements = els;
                    st.root = r;
                });
        }

        /** A stream set value's plain value: a digital state by its name. */
        function plain(v) {
            if (v !== null && typeof v === 'object') {
                if (v.Name !== undefined) { return v.Name; }
                return v.Value !== undefined ? plain(v.Value) : null;
            }
            return v === undefined ? null : v;
        }

        /**
         * Every element's attributes in one batch, then the update the symbol
         * is sent. Table: one row per element and attribute, with the value
         * or the symbol's statistic over the range. TimeSeries: one item per
         * element and attribute, with plot values over the range.
         */
        function readValues() {
            var c = cfg();
            var attrs = afsource.attributes(c.SearchAttributes);
            var series = c.DataShape === 'TimeSeries';
            var stat = config.statKey(c);
            var sumType = !series && afsource.SUMMARY[stat];
            var rg = range();
            var els = st.elements;
            var reqs = {}, meta = [];
            var q = '&startTime=' + encodeURIComponent(rg.start) + '&endTime=' + encodeURIComponent(rg.end);
            for (var i = 0; i < els.length; i++) {
                for (var j = 0; j < attrs.length; j++) {
                    var base = api.base() + '/streamsets/' + encodeURIComponent(els[i].webId);
                    var nf = '?nameFilter=' + encodeURIComponent(attrs[j]);
                    var res = series
                        ? base + '/plot' + nf + q + '&intervals=300&selectedFields=Items.Name;Items.UnitsAbbreviation;Items.Items'
                        : (sumType
                            ? base + '/summary' + nf + q + '&summaryType=' + sumType + '&selectedFields=Items.Name;Items.Items'
                            : base + '/value' + nf + '&selectedFields=Items.Name;Items.Value');
                    reqs['s' + meta.length] = { Method: 'GET', Resource: res };
                    meta.push({ el: els[i], attr: attrs[j] });
                }
            }
            if (!meta.length) { return Promise.resolve({ rows: [], failed: 0, missing: {}, range: rg }); }
            return api.batch(reqs, { cache: false }).then(function (res) {
                var r = api.batchResults(res);
                var out = [], missing = {}, failed = 0;
                for (var k = 0; k < meta.length; k++) {
                    var m = meta[k];
                    var body = r.ok['s' + k];
                    if (body === undefined) { failed += 1; continue; }
                    var hit = null;
                    var items = (body && body.Items) || [];
                    for (var x = 0; x < items.length; x++) { if (lc(items[x].Name) === lc(m.attr)) { hit = items[x]; break; } }
                    if (!hit) { (missing[m.attr] = missing[m.attr] || []).push(m.el.name); continue; }
                    var row = { el: m.el, attr: m.attr };
                    if (series) {
                        row.units = hit.UnitsAbbreviation || '';
                        row.values = ownrange.values(hit.Items || []);
                    } else if (sumType) {
                        var s = (hit.Items || [])[0];
                        var sv = s && s.Value;
                        row.value = plain(sv && typeof sv === 'object' && 'Value' in sv ? sv.Value : sv);
                        row.units = (sv && sv.UnitsAbbreviation) || '';
                        row.good = !(sv && sv.Good === false);
                        row.time = sv && sv.Timestamp;
                    } else {
                        var tv = hit.Value;
                        row.value = plain(tv && typeof tv === 'object' && 'Value' in tv ? tv.Value : tv);
                        row.units = (tv && tv.UnitsAbbreviation) || '';
                        row.good = !(tv && tv.Good === false);
                        row.time = tv && tv.Timestamp;
                    }
                    out.push(row);
                }
                return { rows: out, failed: failed, missing: missing, range: rg, many: attrs.length > 1, series: series };
            });
        }

        /** The read, in the shape PI Vision would have sent. */
        function shape(got) {
            var list = [];
            for (var i = 0; i < got.rows.length; i++) {
                var g = got.rows[i];
                var item = {
                    // One attribute: the asset is the name. More: PI Vision's own
                    // "Element|Attribute", so two rows never share a label.
                    Label: got.many ? g.el.name + '|' + g.attr : g.el.name,
                    Units: g.units,
                    Path: 'af:' + g.el.path + '|' + g.attr,
                    Asset: g.el.name,
                    AssetPath: g.el.path,
                    Attribute: g.attr,
                    Parent: g.el.parent,
                    Template: g.el.template
                };
                if (got.series) {
                    item.Value = g.values;
                    var now = Date.now();
                    var a = nav.parseTime(got.range.start, now), b = nav.parseTime(got.range.end, now);
                    if (a !== null && b !== null) {
                        item.StartTime = new Date(a).toISOString();
                        item.EndTime = new Date(b).toISOString();
                    }
                } else {
                    item.Value = g.value;
                    item.Time = g.time;
                    item.IsGood = g.good;
                    // Summary cells are positional, matching the one column the
                    // symbol asks for (config.statColumns).
                    item.Summary = [{ Value: g.value }];
                }
                list.push(item);
            }
            return got.series ? { Data: list } : { Rows: list };
        }

        function errText(e) {
            return (e && e.pvxError && (e.pvxError.message + (e.pvxError.check ? ' Check: ' + e.pvxError.check + '.' : ''))) ||
                (e && e.message) || 'PI Web API did not answer.';
        }

        function read(force) {
            if (!root()) { st.phase = 'noroot'; send(); return; }
            var c = cfg();
            var sk = searchKey();
            // The range by what was ASKED for, not what it resolved to: PI
            // Vision restates a live range as new absolute times in every
            // update, and keying on those would read again every few seconds.
            var p = {};
            try { p = nav.parseHash().params || {}; } catch (e) { p = {}; }
            var asked = ownrange.wanted(c) ? 'own:' + c.OwnStart + '|' + c.OwnEnd
                : (p.starttime || p.StartTime || '') + '|' + (p.endtime || p.EndTime || '');
            var rk = sk + '|' + lc(c.SearchAttributes) + '|' + c.DataShape + '|' + config.statKey(c) + '|' + asked;
            var every = Math.max(10, parseInt(c.SearchRefreshSeconds, 10) || 60) * 1000;
            if (!force && rk === st.key && (st.phase === 'ok' || st.phase === 'loading') && Date.now() - st.readAt < every) { return; }
            if (reading === rk && st.phase === 'loading') { return; }
            var fresh = sk !== st.searchKey;
            st.key = rk;
            st.readAt = Date.now();
            reading = rk;
            var g = ++gen;
            if (st.phase !== 'ok' || fresh) { st.phase = 'loading'; }
            (fresh ? search().then(function () { st.searchKey = sk; }) : Promise.resolve())
                .then(function () { return g === gen ? readValues() : null; })
                .then(function (got) {
                    if (ctx.destroyed || g !== gen || !got) { return; }
                    reading = '';
                    st.phase = 'ok';
                    st.error = null;
                    st.failed = got.failed;
                    st.missing = got.missing;
                    st.range = got.range;
                    st.out = shape(got);
                    send();
                }, function (e) {
                    if (ctx.destroyed || g !== gen) { return; }
                    reading = '';
                    st.searchKey = '';      // asked again next time, not trusted
                    st.phase = 'error';
                    st.error = errText(e);
                    st.out = null;
                    send();
                });
        }

        /** What the symbol is sent: the rows, or none while there are none. */
        function send() {
            if (!sink) { return; }
            var empty = cfg().DataShape === 'TimeSeries' ? { Data: [] } : { Rows: [] };
            sink(st.phase === 'ok' && st.out ? st.out : empty);
        }

        function startTimer() {
            if (timer) { return; }
            timer = setInterval(function () {
                if (!ctx.destroyed && afsource.wanted(cfg()) && api.isConfigured()) { read(false); }
            }, 5000);
        }

        return {
            take: function (d, deliver) {
                if (!afsource.wanted(cfg())) {
                    st.phase = 'off';
                    deliver(d);
                    return;
                }
                last = d;
                sink = deliver;
                if (api.discovering()) {
                    st.phase = 'finding';
                    api.discover().then(function () { if (!ctx.destroyed) { read(true); } });
                    return;
                }
                if (!api.isConfigured()) { st.phase = 'unconfigured'; send(); return; }
                startTimer();
                if (st.phase === 'ok' && st.out) { deliver(st.out); }
                read(false);
            },
            changed: function (deliver) {
                if (!afsource.wanted(cfg())) {
                    if (st.phase !== 'off') { st.phase = 'off'; if (last) { deliver(last); } }
                    return;
                }
                sink = deliver;
                if (api.isConfigured()) { startTimer(); read(false); } else if (!api.discovering()) { st.phase = 'unconfigured'; send(); }
            },
            /** {text, title, warn} for the overlay, or null when off. */
            badge: function () {
                if (!afsource.wanted(cfg())) { return null; }
                var c = cfg();
                var attrs = afsource.attributes(c.SearchAttributes);
                if (st.phase === 'unconfigured') {
                    return { text: 'AF search (not in force)', warn: true,
                        title: 'This symbol takes its rows from an AF search, which needs PI Web API. ' + api.unsetHint() + '.' };
                }
                if (st.phase === 'noroot') {
                    return { text: 'AF search: no root', warn: true,
                        title: 'Nothing to search under. Open the display on an asset, drop an AF attribute on this symbol, or set Search root in the format pane.' };
                }
                if (!attrs.length) {
                    return { text: 'AF search: no attribute', warn: true, title: 'Name the attributes to read from each asset in the format pane.' };
                }
                if (st.phase === 'error') {
                    return { text: 'AF search failed', warn: true, title: st.error };
                }
                if (st.phase !== 'ok') {
                    return { text: 'AF search…', title: 'Searching AF and reading values from PI Web API.' };
                }
                var bits = ['Rows from an AF search under ' + st.root + (trim(c.SearchTemplate) ? ', template "' + trim(c.SearchTemplate) + '"' : '') +
                    (trim(c.SearchNameFilter) ? ', name "' + trim(c.SearchNameFilter) + '"' : '') + ': ' + st.elements.length +
                    (st.elements.length === 1 ? ' asset' : ' assets') + ', ' + attrs.join(', ') + '.'];
                var warn = false;
                if (st.truncated) { bits.push('Only the first ' + st.elements.length + ' assets: raise Most assets or narrow the search.'); warn = true; }
                for (var a in st.missing) {
                    if (Object.prototype.hasOwnProperty.call(st.missing, a)) {
                        var who = st.missing[a];
                        bits.push(who.length + (who.length === 1 ? ' asset has' : ' assets have') + ' no ' + a + ': ' +
                            who.slice(0, 8).join(', ') + (who.length > 8 ? '…' : '') + '.');
                        warn = true;
                    }
                }
                if (st.failed) { bits.push(st.failed + ' ' + (st.failed === 1 ? 'read' : 'reads') + ' failed.'); warn = true; }
                if (st.range && (c.DataShape === 'TimeSeries' || afsource.SUMMARY[config.statKey(c)])) {
                    bits.push('Over ' + st.range.start + ' to ' + st.range.end + (st.range.own ? ' (the symbol\'s own range)' : '') + '.');
                }
                return { text: 'AF search · ' + st.elements.length + (warn ? ' ⚠' : ''), title: bits.join(' '), warn: warn };
            },
            destroy: function () {
                if (timer) { clearInterval(timer); timer = null; }
                gen += 1;
            }
        };
    };

    /* ------------------------------------------------------------------ *
     * filter: assets picked on one symbol, obeyed by others on the page
     * ------------------------------------------------------------------ *
     * PI Vision's asset context is one asset for the whole display. A click
     * on a row of the Asset Table that should narrow the Event List and the
     * Ranked Bar beside it, without leaving the display or changing what
     * every other symbol shows, needs a second, smaller channel: a set of
     * asset paths with a name, kept on the page. A symbol publishes to it
     * (ClickAction 'filter') and obeys it (FilterObey); FilterChannel names
     * the channel, so two groups of symbols on one display can filter apart.
     *
     * An asset filter matches the asset and everything under it, so Station
     * 1 picked in one table keeps K-301's events in the list beside it. A
     * filter is never applied quietly: an obeying symbol shows a badge with
     * what it is filtered by and how to clear it, and says how many rows it
     * hid. Nothing is stored: a reload starts unfiltered, except that a link
     * can preselect one with `filter=<path>` (or `filter.<channel>=`) in the
     * display's address, separated by semicolons.
     */
    var filter = PVX.filter = {};
    var channels = {}, listeners = [], fromLink = {};

    filter.DEFAULTS = { FilterChannel: '', FilterObey: false };

    filter.defaults = function (cfg) {
        var out = cfg || {};
        for (var k in filter.DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(filter.DEFAULTS, k)) { out[k] = filter.DEFAULTS[k]; }
        }
        return out;
    };

    function chanOf(name) {
        var n = String(name === null || name === undefined ? '' : name).replace(/^\s+|\s+$/g, '').toLowerCase();
        return n || 'main';
    }
    filter.channel = function (cfg) { return chanOf(cfg && cfg.FilterChannel); };

    function normPath(p) {
        return String(p === null || p === undefined ? '' : p).replace(/^[a-z]+:/i, '').replace(/^\s+|\s+$/g, '')
            .replace(/[\\]+$/, '').toLowerCase();
    }

    function lastName(p) {
        var s = String(p || '').replace(/[\\]+$/, '');
        var i = s.lastIndexOf('\\');
        return i === -1 ? s : s.slice(i + 1);
    }

    /** A filter preselected by the display's address, read once per channel. */
    function linked(ch) {
        if (fromLink[ch] !== undefined) { return fromLink[ch]; }
        fromLink[ch] = null;
        var p = {};
        try { p = nav.parseHash().params || {}; } catch (e) { p = {}; }
        var raw = p['filter.' + ch] || (ch === 'main' ? p.filter : '') || '';
        if (raw) {
            var paths = String(raw).split(';');
            var list = [];
            for (var i = 0; i < paths.length; i++) { if (paths[i].replace(/\s/g, '')) { list.push(paths[i].replace(/^\s+|\s+$/g, '')); } }
            if (list.length) {
                fromLink[ch] = { assets: list, label: list.length === 1 ? lastName(list[0]) : list.length + ' assets', by: 'the link', at: Date.now() };
            }
        }
        return fromLink[ch];
    }

    /** {assets: [paths], label, by, at} for a channel, or null when unfiltered. */
    filter.get = function (name) {
        var ch = chanOf(name);
        if (Object.prototype.hasOwnProperty.call(channels, ch)) { return channels[ch]; }
        return linked(ch);
    };

    function changed(ch) {
        var copy = listeners.slice();
        for (var i = 0; i < copy.length; i++) {
            if (copy[i].ch === ch) {
                try { copy[i].fn(filter.get(ch)); } catch (e) { if (root.console) { root.console.error('[PVX] filter listener failed', e); } }
            }
        }
    }

    /** Filter a channel by these asset paths; an empty list clears it. */
    filter.set = function (name, assets, label, by) {
        var ch = chanOf(name);
        var list = [];
        for (var i = 0; assets && i < assets.length; i++) { if (normPath(assets[i])) { list.push(String(assets[i])); } }
        channels[ch] = list.length ? {
            assets: list,
            label: label || (list.length === 1 ? lastName(list[0]) : list.length + ' assets'),
            by: by || '', at: Date.now()
        } : null;
        changed(ch);
        return channels[ch];
    };

    filter.clear = function (name) { return filter.set(name, [], '', ''); };

    /** A click on what is already the filter clears it; anything else replaces it. */
    filter.toggle = function (name, asset, label, by) {
        var f = filter.get(name);
        if (f && f.assets.length === 1 && normPath(f.assets[0]) === normPath(asset)) { return filter.clear(name); }
        return filter.set(name, [asset], label, by);
    };

    /** True when this exact asset is the whole filter: the row to highlight. */
    filter.isPicked = function (name, asset) {
        var f = filter.get(name);
        return !!(f && asset && f.assets.length === 1 && normPath(f.assets[0]) === normPath(asset));
    };

    /**
     * Does an asset pass? The asset itself or anything under it. A filter
     * value with no backslash is a plain name, matched against the asset's
     * own name. No filter passes everything; no asset passes nothing.
     */
    filter.matches = function (f, asset) {
        if (!f || !f.assets || !f.assets.length) { return true; }
        var a = normPath(asset);
        if (!a) { return false; }
        for (var i = 0; i < f.assets.length; i++) {
            var v = normPath(f.assets[i]);
            if (!v) { continue; }
            if (v.indexOf('\\') === -1) {
                if (lastName(a) === v) { return true; }
                continue;
            }
            if (a === v || a.indexOf(v + '\\') === 0) { return true; }
        }
        return false;
    };

    /** Subscribe; returns the unsubscribe function. */
    filter.on = function (name, fn) {
        var entry = { ch: chanOf(name), fn: fn };
        listeners.push(entry);
        return function () {
            for (var i = 0; i < listeners.length; i++) { if (listeners[i] === entry) { listeners.splice(i, 1); return; } }
        };
    };

    /** Forget every channel: tests, and a display left for another. */
    filter.reset = function () { channels = {}; fromLink = {}; };

    /**
     * Wire one symbol: re-render when its channel changes, and the overlay
     * badge. `uses` is true for a symbol that publishes or obeys; a symbol
     * that does neither never subscribes.
     */
    filter.bind = function (ctx) {
        var off = null, sub = '';
        function cfg() { return ctx.config || {}; }
        function uses() { var c = cfg(); return !!c.FilterObey || c.ClickAction === 'filter'; }
        function sync() {
            var want = uses() ? filter.channel(cfg()) : '';
            if (want === sub) { return; }
            if (off) { off(); off = null; }
            sub = want;
            if (want) { off = filter.on(want, function () { if (!ctx.destroyed) { ctx.render(); } }); }
        }
        sync();
        return {
            sync: sync,
            /** The channel's filter when this symbol obeys it, else null. */
            active: function () { return cfg().FilterObey ? filter.get(filter.channel(cfg())) : null; },
            /** {text, title, clear()} for the overlay, or null. */
            badge: function () {
                sync();
                if (!uses()) { return null; }
                var ch = filter.channel(cfg());
                var f = filter.get(ch);
                if (!f) { return null; }
                return {
                    text: 'Filter: ' + f.label + ' ✕',
                    title: (cfg().FilterObey ? 'Showing only ' : 'Filtering other symbols to ') + f.assets.join(', ') +
                        ' and what is under ' + (f.assets.length === 1 ? 'it' : 'them') +
                        (f.by ? ', picked on ' + f.by : '') + (ch !== 'main' ? ' (channel "' + ch + '")' : '') + '. Click to clear.',
                    clear: function () { filter.clear(ch); }
                };
            },
            destroy: function () { if (off) { off(); off = null; } }
        };
    };

    /* ------------------------------------------------------------------ *
     * writer: one panel for a write that is not a form's whole job
     * ------------------------------------------------------------------ *
     * The Asset Table writing a cell, the Event List acknowledging an event,
     * commenting on it or editing its attributes: each is a small write
     * from a symbol whose job is reading. They share one panel so they
     * share one rule, the Shift Log's: what is about to be written is
     * stated in full and confirmed, there is no undo, and the result (or
     * PI Web API's own reason for refusing) is said where the click was.
     *
     * panel(parent) -> {open(spec), close(), isOpen(), destroy()}
     * spec: {title, fields:[{key, label, value, units, kind number|text|
     *        textarea|bool}], action ('Write'), noun ('value'),
     *        confirm(values) -> sentence, submit(values) -> Promise of
     *        {ok, text, detail}, load() -> Promise of [lines] shown above}
     * A field left as it was is not sent; `values` holds only the changed.
     */
    var writer = PVX.writer = {};

    /** "12", "-1.5e3": a number; "12kg" is a typo to show, not to guess at. */
    writer.isNumber = function (text) { return /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(String(text).replace(/^\s+|\s+$/g, '')); };

    writer.panel = function (parent) {
        var doc = root.document;
        var box = doc.createElement('div');
        box.className = 'pvx-writer';
        box.style.display = 'none';
        parent.appendChild(box);
        var spec = null, phase = 'closed', values = null, inputs = [];

        function el(tag, cls, into, text) {
            var n = doc.createElement(tag);
            if (cls) { n.className = cls; }
            if (text !== undefined) { n.textContent = text; }
            (into || box).appendChild(n);
            return n;
        }
        function button(into, cls, text, fn) {
            var b = el('button', 'pvx-writer-btn ' + cls, into, text);
            b.type = 'button';
            b.onclick = function (ev) { if (ev) { ev.stopPropagation(); } fn(); };
            return b;
        }
        function trimmed(v) { return String(v === null || v === undefined ? '' : v).replace(/^\s+|\s+$/g, ''); }

        function draw(msg) {
            box.innerHTML = '';
            box.style.display = '';
            box.setAttribute('data-phase', phase);
            el('div', 'pvx-writer-title', box, spec.title);
            if (spec.lines && spec.lines.length) {
                var ls = el('div', 'pvx-writer-lines', box);
                for (var l = 0; l < spec.lines.length; l++) { el('div', 'pvx-writer-line', ls, spec.lines[l]); }
            }
            if (phase === 'edit') {
                inputs = [];
                var fs = spec.fields || [];
                for (var i = 0; i < fs.length; i++) {
                    var row = el('label', 'pvx-writer-field', box);
                    el('span', 'pvx-writer-label', row, fs[i].label + (fs[i].units ? ' (' + fs[i].units + ')' : ''));
                    var inp;
                    if (fs[i].kind === 'textarea') { inp = el('textarea', 'pvx-writer-input', row); inp.rows = 3; }
                    else if (fs[i].kind === 'bool') {
                        inp = el('select', 'pvx-writer-input', row);
                        el('option', '', inp, 'True').value = 'True';
                        el('option', '', inp, 'False').value = 'False';
                    } else { inp = el('input', 'pvx-writer-input', row); inp.type = 'text'; }
                    var v = values && values[fs[i].key] !== undefined ? values[fs[i].key] : fs[i].value;
                    inp.value = v === null || v === undefined ? '' : String(v);
                    inp.onkeydown = function (ev) {
                        if ((ev.key === 'Enter' || ev.keyCode === 13) && this.tagName !== 'TEXTAREA') { ev.preventDefault(); toConfirm(); }
                        if (ev.key === 'Escape' || ev.keyCode === 27) { api0.close(); }
                    };
                    inputs.push(inp);
                }
                var a = el('div', 'pvx-writer-actions', box);
                button(a, 'pvx-writer-go', spec.action || 'Write', toConfirm);
                button(a, 'pvx-writer-cancel', 'Cancel', function () { api0.close(); });
                if (inputs[0]) { try { inputs[0].focus(); } catch (e) { /* not focusable yet */ } }
            } else if (phase === 'confirm') {
                el('div', 'pvx-writer-confirm', box, spec.confirm ? spec.confirm(values) : 'Write this?');
                var c = el('div', 'pvx-writer-actions', box);
                button(c, 'pvx-writer-yes', 'Confirm', send);
                button(c, 'pvx-writer-back', (spec.fields && spec.fields.length) ? 'Back' : 'Cancel', function () {
                    if (spec.fields && spec.fields.length) { phase = 'edit'; draw(); } else { api0.close(); }
                });
            } else if (phase === 'sending') {
                el('div', 'pvx-writer-msg', box, 'Writing…');
            } else if (phase === 'done' || phase === 'failed') {
                var d = el('div', 'pvx-writer-actions', box);
                if (phase === 'failed' && spec.fields && spec.fields.length) { button(d, 'pvx-writer-back', 'Back', function () { phase = 'edit'; draw(); }); }
                button(d, 'pvx-writer-cancel', 'Close', function () { api0.close(); });
            }
            if (msg) {
                var m = el('div', 'pvx-writer-msg', box);
                m.setAttribute('data-tone', msg.tone || 'info');
                el('div', 'pvx-writer-msg-text', m, msg.text || '');
                if (msg.detail) { el('div', 'pvx-writer-msg-detail', m, msg.detail); }
            }
        }

        function toConfirm() {
            var fs = spec.fields || [];
            var out = {}, changed = 0;
            for (var i = 0; i < fs.length; i++) {
                var t = trimmed(inputs[i] && inputs[i].value);
                var before = trimmed(fs[i].value);
                if (t === before) { continue; }
                if (fs[i].kind === 'number') {
                    if (!writer.isNumber(t)) { draw({ tone: 'error', text: fs[i].label + ': "' + t + '" is not a number.' }); return; }
                    out[fs[i].key] = parseFloat(t);
                } else if (fs[i].kind === 'bool') {
                    out[fs[i].key] = t === 'True';
                } else {
                    out[fs[i].key] = fs[i].kind === 'textarea' ? String(inputs[i].value) : t;
                }
                changed += 1;
            }
            if (fs.length && !changed) { draw({ tone: 'warn', text: 'Nothing changed, so there is nothing to write.' }); return; }
            values = out;
            phase = 'confirm';
            draw();
        }

        function send() {
            phase = 'sending';
            draw();
            var p;
            try { p = Promise.resolve(spec.submit(values)); } catch (e) { p = Promise.reject(e); }
            p.then(function (r) {
                if (phase !== 'sending') { return; }
                phase = r && r.ok ? 'done' : 'failed';
                draw({ tone: r && r.ok ? 'ok' : 'error', text: (r && r.text) || (r && r.ok ? 'Written.' : 'Not written.'), detail: r && r.detail });
            }, function (e) {
                if (phase !== 'sending') { return; }
                phase = 'failed';
                var pe = e && e.pvxError;
                draw({ tone: 'error', text: 'Not written', detail: pe ? pe.message + (pe.check ? ' Check: ' + pe.check + '.' : '') : String((e && e.message) || e) });
            });
        }

        var api0 = {
            open: function (s) {
                spec = s;
                values = null;
                spec.lines = [];
                phase = (s.fields && s.fields.length) ? 'edit' : 'confirm';
                if (!s.fields || !s.fields.length) { values = {}; }
                draw();
                if (s.load) {
                    var mine = s;
                    s.load().then(function (lines) {
                        if (spec !== mine || !lines || !lines.length) { return; }
                        spec.lines = lines;
                        if (phase === 'edit' || phase === 'confirm') {
                            // Keep what is typed: redraw only the lines above.
                            var typed = inputs.map(function (n) { return n.value; });
                            draw();
                            for (var i = 0; i < typed.length && i < inputs.length; i++) { inputs[i].value = typed[i]; }
                        }
                    }, function () { /* the lines are context; the write does not depend on them */ });
                }
            },
            close: function () { spec = null; phase = 'closed'; box.innerHTML = ''; box.style.display = 'none'; },
            isOpen: function () { return phase !== 'closed'; },
            node: box,
            destroy: function () { if (box.parentNode) { box.parentNode.removeChild(box); } }
        };
        return api0;
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
            // After the symbol, so the overlay sits on what it drew.
            try { ctx.overlay.update(); } catch (e) { if (root.console) { root.console.error('[PVX] overlay failed', e); } }
        });
        ctx.render = renderer.request;
        ctx.renderNow = renderer.flush;

        ctx.overlay = overlay.bind(ctx, hooks);
        ctx.sources = sources.bind(scope, vis.pvxSourceInfo, renderer.request);
        ctx.bands = thresholds.bind(scope);
        // Other keys in the band grammar, named by the symbol, e.g. LimitBands.
        ctx.bandEditors = [];
        for (var bk = 0; hooks.bandKeys && bk < hooks.bandKeys.length; bk++) {
            if (hooks.bandKeys[bk] !== 'Thresholds') { ctx.bandEditors.push(thresholds.bind(scope, hooks.bandKeys[bk])); }
        }
        ctx.afpick = afpick.bind(scope);
        ctx.states = states.bind(scope);
        ctx.tags = tags.bind(scope);

        var keepMeta = data.metaCarry(function () {
            var ds = scope.symbol && scope.symbol.DataSources;
            if (!ds || typeof ds.length !== 'number') { return null; }
            var out = [];
            for (var i = 0; i < ds.length; i++) { out.push(String(ds[i])); }
            return out;
        });

        ctx.ownrange = ownrange.bind(ctx);
        ctx.afsource = afsource.bind(ctx);
        ctx.filter = filter.bind(ctx);

        vis.onDataUpdate = function (d) {
            // Before anything reads it: the sources list, the state map and
            // every symbol's own onData all want the names PI Vision only
            // sends now and then. Then rows from an AF search replace the
            // update when the symbol takes them (reading over its own time
            // range itself, when it has one); else the symbol's own time
            // range, if set, swaps in values read for it.
            var d1 = keepMeta(d);
            if (afsource.wanted(ctx.config)) { ctx.afsource.take(d1, deliver); }
            else { ctx.afsource.take(d1, function (d2) { ctx.ownrange.take(d2, deliver); }); }
        };

        function deliver(d) {
            if (ctx.destroyed) { return; }
            ctx.data = d;
            // Also catches a source added by drag and drop, on a release
            // where nothing re-runs the collection watch in sources.bind.
            if (ctx.sources) { ctx.sources.refresh(); }
            // So a state map's list can offer what this symbol is showing,
            // on a site with no PI Web API to read digital sets from.
            if (ctx.states) { ctx.states.observe(d); }
            // So a per-attribute list can offer the labels this symbol shows.
            if (ctx.tags) { ctx.tags.observe(d); }
            if (hooks.onData) {
                try { hooks.onData(d, ctx); }
                catch (e) { if (root.console) { root.console.error('[PVX] onData failed', e); } }
            }
            renderer.request();
        }

        vis.onConfigChange = function (newConfig, oldConfig) {
            ctx.config = newConfig || ctx.config;
            scope.config = ctx.config;
            if (afsource.wanted(ctx.config)) { ctx.afsource.changed(deliver); }
            else {
                ctx.afsource.changed(function (d2) { ctx.ownrange.take(d2, deliver); });
                ctx.ownrange.changed(deliver);
            }
            ctx.filter.sync();
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
            if (ctx.tags) { ctx.tags.destroy(); }
            ctx.overlay.destroy();
            ctx.ownrange.destroy();
            ctx.afsource.destroy();
            ctx.filter.destroy();
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
