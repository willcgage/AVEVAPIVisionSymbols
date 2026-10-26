#!/usr/bin/env node
/* ============================================================================
 * PVX verify — renders every symbol in a real browser and fails on anything
 * that would look broken on a live display.
 * ----------------------------------------------------------------------------
 *   node tools/verify.js               run all checks
 *   node tools/verify.js --shots       also write PNGs to dist/screenshots/
 *
 * Checks per symbol, at several sizes, in light and dark, with live/empty/
 * bad-quality data:
 *   - no console errors, no thrown exceptions
 *   - the symbol actually painted something (SVG/DOM children exist)
 *   - no NaN / Infinity / undefined leaked into SVG attributes
 *   - nothing drawn outside the symbol's own box
 *   - text is large enough to read at the smallest tested size
 *
 * Requires the dev dependency `playwright`. Everything the browser loads comes
 * from dist/, so this verifies the built artefacts, not the sources.
 * ==========================================================================*/
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;
const SHOTS = process.argv.indexOf('--shots') !== -1;

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', bold: '\x1b[1m' };

const SIZES = [
    { w: 320, h: 200, name: 'default' },
    { w: 140, h: 90, name: 'small' },
    { w: 900, h: 480, name: 'large' }
];

const SCENARIOS = [
    { name: 'live', empty: false, bad: false },
    { name: 'empty', empty: true, bad: false },
    { name: 'bad-quality', empty: false, bad: true }
];

/* ------------------------------------------------------------- static server */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serve() {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            let rel = decodeURIComponent(req.url.split('?')[0]);
            // Serve the per-symbol test page over HTTP rather than via
            // page.setContent — setContent leaves the document on about:blank,
            // where root-relative script/CSS URLs cannot resolve.
            const m = /^\/verify\/([A-Za-z0-9_-]+)$/.exec(rel);
            if (m) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(pageHtml(m[1]));
                return;
            }
            if (rel === '/') { rel = '/dev/harness.html'; }
            const target = path.normalize(path.join(ROOT, rel));
            if (!target.startsWith(ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
                res.writeHead(404).end('nope');
                return;
            }
            res.writeHead(200, { 'Content-Type': (TYPES[path.extname(target)] || 'text/plain') + '; charset=utf-8' });
            fs.createReadStream(target).pipe(res);
        });
        s.listen(PORT, () => resolve(s));
    });
}

/* ----------------------------------------------------------------- the page */
/**
 * A stripped-down harness page: one symbol, one size, no UI chrome. Keeps the
 * failure surface small so a verification failure means the symbol is broken,
 * not the preview app.
 */
function pageHtml(typeName) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
<style>html,body{margin:0;padding:0;height:100%;background:#fff}
body.dark{background:#1f2124}
#box{position:absolute;left:0;top:0;overflow:hidden}</style>
</head><body><div id="box"></div>
<script src="/dev/vendor/angular.min.js"></script>
<script src="/dev/pv-mock.js"></script>
<script src="/dist/ext/libraries/pvx/pvx-core.js"></script>
<!-- A site with no PI Web API and discovery off, as in 1.12.0: the
     same-server probe would 404 here, and the browser logs every 404 as a
     console error, which this gate fails on. Discovery is proven by
     test-api, test-afpick and test-overview against mocks that answer. -->
<script>window.PVX.api.configure({ autoDiscover: false });</script>
<link rel="stylesheet" href="/dist/ext/sym-${typeName}.css">
<script src="/dist/ext/sym-${typeName}.js"></script>
<script>window.__inspect = ${inspect.toString()};</script>
</body></html>`;
}

/* --------------------------------------------------------------- assertions */

const BAD_ATTR = /NaN|Infinity|undefined|null/;

/** Runs inside the browser. */
function inspect() {
    function inScrollable(el, box) {
        let p = el.parentElement;
        while (p && p !== box) {
            const st = window.getComputedStyle(p);
            const oy = st.overflowY, ox = st.overflowX;
            if (oy === 'auto' || oy === 'scroll' || ox === 'auto' || ox === 'scroll') { return true; }
            p = p.parentElement;
        }
        return false;
    }
    const box = document.getElementById('box');
    const out = { childCount: box.childElementCount, badAttrs: [], overflow: [], texts: [], svgCount: 0, painted: false, maxOverflow: 0, worstOverflow: '' };
    const boxRect = box.getBoundingClientRect();

    // Theme tokens written as inline --pvx-* properties above the template's
    // .pvx root never take effect: they reach the root only by inheritance,
    // and the symbol's stylesheet declares the same properties on the root.
    // That is how Transparent and the dark theme were silently ignored on a
    // live server, so any such write is a failure, not a style note.
    out.shadowedVars = [];
    const pvxRoot = box.querySelector('.pvx');
    if (pvxRoot) {
        const rootStyle = window.getComputedStyle(pvxRoot);
        for (let anc = pvxRoot.parentElement; anc && anc !== document.body; anc = anc.parentElement) {
            for (let k = 0; k < anc.style.length; k++) {
                const prop = anc.style[k];
                if (prop.indexOf('--pvx-') !== 0) { continue; }
                // Custom properties keep their authored text, so compare with
                // the whitespace out: "rgba(0,0,0,.1)" vs "rgba(0, 0, 0, .1)".
                const want = anc.style.getPropertyValue(prop).replace(/\s+/g, '');
                const got = rootStyle.getPropertyValue(prop).replace(/\s+/g, '');
                if (want !== got) { out.shadowedVars.push(prop + ' set to ' + want + ' but the root has ' + got); }
            }
        }
    }

    const all = box.querySelectorAll('*');
    out.painted = all.length > 1;
    out.svgCount = box.querySelectorAll('svg').length;

    for (let i = 0; i < all.length; i++) {
        const el = all[i];
        for (let a = 0; a < el.attributes.length; a++) {
            const at = el.attributes[a];
            // Only geometry/paint attributes matter; class names legitimately
            // contain words like "null" in other contexts.
            if (!/^(d|x|y|x1|x2|y1|y2|cx|cy|r|rx|ry|width|height|points|transform|offset|font-size|stroke-width|viewBox|fill|stroke|stop-color|opacity)$/.test(at.name)) { continue; }
            if (/NaN|Infinity|undefined/.test(at.value)) {
                out.badAttrs.push(el.tagName + '[' + at.name + '="' + at.value + '"]');
            }
        }
        if (el.tagName === 'text' || el.tagName === 'TEXT') {
            const fs = parseFloat(window.getComputedStyle(el).fontSize);
            if (fs > 0) { out.texts.push(fs); }
        }
        // Content that spills past the symbol box is only a defect when it is
        // unreachable. Anything inside a scrollable ancestor can still be read,
        // so measure against the nearest clipping ancestor and ignore the ones
        // the operator can scroll.
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
            const ov = Math.max(r.right - boxRect.right, r.bottom - boxRect.bottom,
                                boxRect.left - r.left, boxRect.top - r.top);
            if (ov > 2 && !inScrollable(el, box)) {
                if (ov > out.maxOverflow) {
                    out.maxOverflow = ov;
                    out.worstOverflow = el.tagName + '.' + (el.getAttribute('class') || '').split(' ')[0];
                }
                out.overflow.push(el.tagName);
            }
        }
    }
    out.minFont = out.texts.length ? Math.min.apply(null, out.texts) : null;
    out.textLen = (box.textContent || '').trim().length;
    // The mock's second update carries no Label, as PI Vision's routinely
    // don't, so a placeholder name here means a symbol lost the real one
    // between metadata updates: the labels flicker on a live server.
    const words = (box.textContent || '') + ' ' +
        Array.prototype.map.call(box.querySelectorAll('title'), (n) => n.textContent).join(' ');
    const placeholder = /\b(Series|Row|Trace) \d+\b/.exec(words);
    out.placeholder = placeholder ? placeholder[0] : '';
    return out;
}

/* --------------------------------------------------------------------- main */

(async function main() {
    const manifestPath = path.join(ROOT, 'dist', 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
        console.error('dist/manifest.json missing — run `npm run build` first.');
        process.exit(1);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    const server = await serve();
    // PVX_CHROMIUM lets a machine with a pre-installed Chromium skip
    // `npx playwright install` (locked-down engineering workstations, CI images).
    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launchOpts.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launchOpts);

    const shotDir = path.join(ROOT, 'dist', 'screenshots');
    if (SHOTS) { fs.mkdirSync(shotDir, { recursive: true }); }

    let failures = 0;
    let warns = 0;
    let checks = 0;

    console.log('\n' + C.bold + 'PVX verify' + C.reset + C.dim + '  ' + manifest.symbols.length + ' symbols × ' +
        SIZES.length + ' sizes × ' + SCENARIOS.length + ' scenarios × 2 themes' + C.reset + '\n');

    for (const sym of manifest.symbols) {
        const problems = [];
        const soft = [];

        for (const dark of [false, true]) {
            for (const size of SIZES) {
                for (const scenario of SCENARIOS) {
                    checks++;
                    const page = await browser.newPage({ viewport: { width: size.w + 40, height: size.h + 40 } });
                    const consoleErrors = [];
                    page.on('console', (m) => { if (m.type() === 'error') { consoleErrors.push(m.text()); } });
                    page.on('pageerror', (e) => { consoleErrors.push('pageerror: ' + e.message); });

                    await page.goto('http://127.0.0.1:' + PORT + '/verify/' + sym.typeName,
                        { waitUntil: 'networkidle' });

                    const result = await page.evaluate(async (args) => {
                        const { typeName, w, h, dark, empty, bad, shape, behavior, mockProfile } = args;
                        if (dark) { document.body.classList.add('dark'); }
                        const box = document.getElementById('box');
                        box.style.width = w + 'px';
                        box.style.height = h + 'px';

                        const def = window.PVMock.get(typeName);
                        if (!def) { return { fatal: 'symbol did not register' }; }

                        const injector = angular.injector(['ng']);
                        const $compile = injector.get('$compile');
                        const scope = injector.get('$rootScope').$new(true);
                        scope.config = def.getDefaultConfig ? def.getDefaultConfig() : {};
                        scope.runtimeData = { isEditMode: false };
                        scope.symbol = { Name: typeName };

                        const tpl = await fetch('/dist/ext/sym-' + typeName + '-template.html').then((r) => r.text());
                        // init() gets a wrapper with the template linked
                        // inside it, as PI Vision does, never the template
                        // root itself. See the shadowed-variable check.
                        const host = document.createElement('div');
                        host.className = 'pv-symbol-host';
                        host.style.cssText = 'width:100%;height:100%';
                        box.appendChild(host);
                        let el;
                        try {
                            el = angular.element(host).append($compile(tpl)(scope));
                        } catch (e) { return { fatal: 'template compile: ' + e.message }; }

                        // The config pane must compile too — a broken one makes
                        // the symbol unconfigurable even though it renders.
                        try {
                            const cfg = await fetch('/dist/ext/sym-' + typeName + '-config.html').then((r) => r.text());
                            const holder = document.createElement('div');
                            holder.style.cssText = 'position:absolute;left:-9999px;width:260px';
                            document.body.appendChild(holder);
                            angular.element(holder).append($compile(cfg)(scope));
                        } catch (e) { return { fatal: 'config compile: ' + e.message }; }

                        const vis = new def.visObjectType();
                        try { vis.init(scope, el, undefined); }
                        catch (e) { return { fatal: 'init(): ' + (e.stack || e.message) }; }

                        const count = behavior === 'Single' ? 1 : 8;
                        const mockOpts = {
                            count: count, points: 120, hours: 8, seed: 7,
                            digital: mockProfile === 'digital',
                            profile: mockProfile,
                            badIndex: bad && count > 1 ? 1 : -1
                        };
                        const payload = empty ? null : window.PVMock.generate(shape,
                            Object.assign({ tick: 1 }, mockOpts));

                        try { vis.onDataUpdate(payload); }
                        catch (e) { return { fatal: 'onDataUpdate(): ' + (e.stack || e.message) }; }
                        try { vis.onResize(w, h); }
                        catch (e) { return { fatal: 'onResize(): ' + (e.stack || e.message) }; }

                        scope.$applyAsync();
                        await new Promise((r) => setTimeout(r, 140));

                        // A second update exercises the re-render / DOM-reuse path,
                        // which is where list symbols historically break.
                        try {
                            vis.onDataUpdate(empty ? null : window.PVMock.generate(shape,
                                Object.assign({ tick: 2 }, mockOpts)));
                        } catch (e) { return { fatal: 'second onDataUpdate(): ' + (e.stack || e.message) }; }
                        await new Promise((r) => setTimeout(r, 140));

                        const report = window.__inspect();

                        try { vis.onDestroy(); }
                        catch (e) { report.destroyError = e.message; }

                        return report;
                    }, {
                        typeName: sym.typeName, w: size.w, h: size.h, dark,
                        empty: scenario.empty, bad: scenario.bad,
                        shape: sym.dataShape, behavior: sym.datasourceBehavior,
                        mockProfile: sym.mockProfile
                    }).catch((e) => ({ fatal: 'evaluate: ' + e.message }));

                    const tag = (dark ? 'dark' : 'light') + '/' + size.name + '/' + scenario.name;

                    if (result.fatal) {
                        problems.push(tag + ' — ' + result.fatal);
                    } else {
                        if (consoleErrors.length) {
                            problems.push(tag + ' — console error: ' + consoleErrors[0].slice(0, 180));
                        }
                        if (result.badAttrs && result.badAttrs.length) {
                            problems.push(tag + ' — invalid SVG attribute: ' + result.badAttrs.slice(0, 3).join(', '));
                        }
                        if (result.shadowedVars && result.shadowedVars.length) {
                            problems.push(tag + ' — theme variable written outside the .pvx root: ' + result.shadowedVars[0]);
                        }
                        if (result.destroyError) {
                            problems.push(tag + ' — onDestroy threw: ' + result.destroyError);
                        }
                        if (!scenario.empty && result.placeholder) {
                            problems.push(tag + ' — shows "' + result.placeholder + '" after an update without metadata');
                        }
                        if (!scenario.empty && !result.painted) {
                            problems.push(tag + ' — rendered nothing');
                        }
                        if (scenario.empty && result.textLen === 0 && result.svgCount === 0) {
                            soft.push(tag + ' — no empty state shown');
                        }
                        // Under 8px of spill is normal (a clipped descender, a
                        // scrollbar-free list); beyond that, real content is lost.
                        if (result.maxOverflow > 8) {
                            soft.push(tag + ' — content clipped by ' + Math.round(result.maxOverflow) +
                                'px (' + result.worstOverflow + ')');
                        }
                        if (!scenario.empty && result.minFont !== null && result.minFont < 5) {
                            soft.push(tag + ' — text below 5px (' + result.minFont.toFixed(1) + 'px)');
                        }
                    }

                    if (SHOTS && !dark && scenario.name === 'live' && size.name === 'default') {
                        await page.screenshot({
                            path: path.join(shotDir, sym.typeName + '.png'),
                            clip: { x: 0, y: 0, width: size.w, height: size.h }
                        });
                    }

                    await page.close();
                }
            }
        }

        if (problems.length) {
            failures++;
            console.log(C.red + ' FAIL ' + C.reset + C.bold + sym.typeName + C.reset);
            problems.slice(0, 6).forEach((p) => console.log('       ' + C.red + p + C.reset));
            if (problems.length > 6) { console.log('       ' + C.dim + '+' + (problems.length - 6) + ' more' + C.reset); }
        } else if (soft.length) {
            warns++;
            console.log(C.yellow + ' warn ' + C.reset + sym.typeName +
                C.dim + '  (' + soft.length + ' note' + (soft.length === 1 ? '' : 's') + ')' + C.reset);
            dedupe(soft).slice(0, 4).forEach((p) => console.log('       ' + C.dim + p + C.reset));
        } else {
            console.log(C.green + '  ok  ' + C.reset + sym.typeName);
        }
    }

    await browser.close();
    server.close();

    console.log('\n' + C.dim + checks + ' render checks' + C.reset);
    if (failures) {
        console.log(C.red + C.bold + failures + ' symbol(s) failed' + C.reset + '\n');
        process.exit(1);
    }
    console.log(C.green + C.bold + 'All symbols render cleanly' + C.reset +
        (warns ? C.dim + ' (' + warns + ' with notes)' + C.reset : '') + '\n');
    if (SHOTS) { console.log(C.dim + 'screenshots -> dist/screenshots/' + C.reset + '\n'); }
})();

function dedupe(arr) {
    const seen = {};
    return arr.filter((s) => {
        const key = s.replace(/^[a-z/-]+ — /, '').slice(0, 60);
        if (seen[key]) { return false; }
        seen[key] = 1;
        return true;
    });
}
