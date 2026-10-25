#!/usr/bin/env node
/* ============================================================================
 * PVX sources test — removing a data source from a placed symbol.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-sources.js
 *
 * Two halves:
 *
 *   rules    PVX.sources in plain Node: name parsing, every renumbering rule,
 *            and the guard that keeps the last source. These are the parts
 *            that are silently wrong when they are wrong — a Sankey link left
 *            pointing at the neighbour of the source it meant draws a
 *            convincing diagram of the wrong plant.
 *   pane     the BUILT format pane in real Chromium: the injected list shows
 *            one row per source, Remove asks before acting, Confirm shortens
 *            symbol.DataSources and renumbers positional config, and a
 *            single-source symbol offers no Remove at all.
 *
 * Requires the dev dependency `playwright` for the second half. Set
 * PVX_CHROMIUM to use a pre-installed browser.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'dist', 'ext', 'libraries', 'pvx', 'pvx-core.js');
const PORT = 31790;

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', bold: '\x1b[1m' };
let failures = 0;
let passes = 0;

function check(name, ok, detail) {
    if (ok) { passes += 1; console.log('  ' + C.green + 'ok  ' + C.reset + name); return; }
    failures += 1;
    console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + name + (detail !== undefined ? C.dim + '  got ' + JSON.stringify(detail) + C.reset : ''));
}

if (!fs.existsSync(CORE)) {
    console.error('dist/ext/libraries/pvx/pvx-core.js not found. Run: node tools/build.js');
    process.exit(1);
}

/* ------------------------------------------------------------------ rules */

function loadCore() {
    const win = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
    win.window = win;
    vm.createContext(win);
    vm.runInContext(fs.readFileSync(CORE, 'utf8'), win, { filename: 'pvx-core.js' });
    return win.PVX;
}

function rules() {
    console.log('');
    console.log(C.bold + 'PVX.sources rules' + C.reset);
    const S = loadCore().sources;
    const run = (rule, v, k) => { const r = S.rules[rule](v, k, 'Key'); return r ? r.value : null; };

    check('AF attribute path -> Element|Attribute',
        S.name('af:\\\\srv\\db\\Area\\Pump 101|Flow?7a2b') === 'Pump 101|Flow', S.name('af:\\\\srv\\db\\Area\\Pump 101|Flow?7a2b'));
    check('PI point path -> tag', S.name('pi:\\\\srv\\SINUSOID?123') === 'SINUSOID', S.name('pi:\\\\srv\\SINUSOID?123'));
    check('child attribute keeps both bars',
        S.name('af:\\\\srv\\db\\Pump|Motor|Current') === 'Pump|Motor|Current', S.name('af:\\\\srv\\db\\Pump|Motor|Current'));

    check('index: later position moves up', run('index', 3, 2) === 2, run('index', 3, 2));
    check('index: removed position falls back to 1', run('index', 2, 2) === 1, run('index', 2, 2));
    check('index: earlier position untouched', run('index', 1, 2) === null, run('index', 1, 2));

    check('traceSpec: entry dropped, later renumbered',
        run('traceSpec', '1:bar, 2:line:right, 3:area', 2) === '1:bar, 2:area', run('traceSpec', '1:bar, 2:line:right, 3:area', 2));
    check('traceSpec: one-per-line layout survives',
        run('traceSpec', '1:bar\n2:line\n3:area:#8267b0', 1) === '1:line\n2:area:#8267b0', run('traceSpec', '1:bar\n2:line\n3:area:#8267b0', 1));
    check('traceSpec: no entry for or after k -> untouched', run('traceSpec', '1:bar', 3) === null, run('traceSpec', '1:bar', 3));

    check('listComma: removes the k-th entry, blanks kept',
        run('listComma', '0:200, , 0:100', 1) === ', 0:100', run('listComma', '0:200, , 0:100', 1));
    check('listComma: list shorter than k -> untouched', run('listComma', '0:200', 3) === null, run('listComma', '0:200', 3));
    check('listBar: removes the k-th hotspot',
        run('listBar', '10,20 | 30,40:Tank | 50,60', 2) === '10,20 | 50,60', run('listBar', '10,20 | 30,40:Tank | 50,60', 2));
    check('numberList: reads any separator, writes commas',
        run('numberList', '0 1.5; 3.2, 7', 2) === '0, 3.2, 7', run('numberList', '0 1.5; 3.2, 7', 2));

    check('steps: subtotal after removed step stays in place',
        run('steps', '2, 4', 4) === '2, 3', run('steps', '2, 4', 4));
    check('steps: subtotal after step 1 when step 1 goes is dropped',
        run('steps', '1, 3', 1) === '2', run('steps', '1, 3', 1));

    const links = 'Feed > Reactor : 1 | Reactor > Product : 2 | Reactor > Vent : 3';
    check('links: link fed by the removed source goes, later renumbered',
        run('links', links, 2) === 'Feed > Reactor : 1 | Reactor > Vent : 2', run('links', links, 2));
    const note = S.rules.links(links, 2, 'Links').note;
    check('links: the note names the link it removed', /Reactor > Product/.test(note), note);

    const unknown = S.remap({ X: 'a' }, { X: 'nope' }, 1);
    check('unknown rule is reported, never silently skipped', /NOT renumbered/.test(unknown[0] || ''), unknown);

    // bind/remove against a fake scope
    const scope = {
        config: { TraceSpec: '1:bar, 2:line, 3:area' },
        symbol: { DataSources: ['pi:\\\\s\\A?1', 'pi:\\\\s\\B?2', 'pi:\\\\s\\C?3'] }
    };
    let repaints = 0;
    const st = S.bind(scope, { sourceRemap: { TraceSpec: 'traceSpec' } }, () => { repaints += 1; });
    check('bind publishes on runtimeData', scope.runtimeData.pvxSources === st);
    check('one item per source', st.items.length === 3 && st.items[1].name === 'B', st.items);
    const arr = scope.symbol.DataSources;
    st.ask(1);
    check('ask marks the row pending, removes nothing', st.pending === 1 && arr.length === 3);
    st.remove(1);
    check('remove splices symbol.DataSources in place',
        scope.symbol.DataSources === arr && arr.join() === 'pi:\\\\s\\A?1,pi:\\\\s\\C?3', arr);
    check('remove renumbers declared config', scope.config.TraceSpec === '1:bar, 2:area', scope.config.TraceSpec);
    check('remove says what it did', /Removed B\./.test(st.message) && /TraceSpec/.test(st.message), st.message);
    check('remove repaints the symbol', repaints === 1, repaints);
    st.remove(0);
    check('can go down to one source', arr.length === 1);
    check('the last source cannot be removed', st.remove(0) === false && arr.length === 1, arr);
}

/* ------------------------------------------------------------------- pane */

function pageHtml(typeName) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><link rel="icon" href="data:,">
</head><body><div id="box" style="width:320px;height:200px"></div><div id="pane" style="width:260px"></div>
<script src="/dev/vendor/angular.min.js"></script>
<script src="/dev/pv-mock.js"></script>
<script src="/dist/ext/libraries/pvx/pvx-core.js"></script>
<link rel="stylesheet" href="/dist/ext/sym-${typeName}.css">
<script src="/dist/ext/sym-${typeName}.js"></script>
</body></html>`;
}

function serve() {
    return new Promise((resolve) => {
        const s = http.createServer((req, res) => {
            const rel = decodeURIComponent(req.url.split('?')[0]);
            const m = /^\/page\/(\w+)$/.exec(rel);
            if (m) {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
                res.end(pageHtml(m[1]));
                return;
            }
            const target = path.normalize(path.join(ROOT, rel));
            if (!target.startsWith(ROOT) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
                res.writeHead(404).end('not found');
                return;
            }
            const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(target)] || 'text/plain';
            res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
            fs.createReadStream(target).pipe(res);
        });
        s.listen(PORT, () => resolve(s));
    });
}

/** Runs in the browser: mount symbol + pane with the given sources. */
async function mount(a) {
    const def = window.PVMock.get(a.typeName);
    const injector = angular.injector(['ng']);
    const $compile = injector.get('$compile');
    const scope = injector.get('$rootScope').$new(true);
    scope.config = def.getDefaultConfig();
    Object.keys(a.config || {}).forEach((k) => { scope.config[k] = a.config[k]; });
    scope.runtimeData = { isEditMode: true };
    scope.symbol = { Name: a.typeName, DataSources: a.sources };
    const tpl = await fetch('/dist/ext/sym-' + a.typeName + '-template.html').then((r) => r.text());
    const el = $compile(tpl)(scope);
    angular.element(document.getElementById('box')).append(el);
    const cfg = await fetch('/dist/ext/sym-' + a.typeName + '-config.html').then((r) => r.text());
    angular.element(document.getElementById('pane')).append($compile(cfg)(scope));
    new def.visObjectType().init(scope, el, undefined);
    scope.$digest();
    window.__scope = scope;
}

async function pane() {
    console.log('');
    console.log(C.bold + 'Format pane (built)' + C.reset);
    const { chromium } = require('playwright');
    const server = await serve();
    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launchOpts.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launchOpts);
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));

        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxComboChart', { waitUntil: 'networkidle' });
        await page.evaluate(mount, {
            typeName: 'pvxComboChart',
            config: { TraceSpec: '1:bar, 2:line:right, 3:area' },
            sources: ['af:\\\\srv\\db\\Pump 101|Flow?a', 'af:\\\\srv\\db\\Pump 101|Wrong?b', 'pi:\\\\srv\\SINUSOID?c']
        });
        const rows = page.locator('.pvx-cfg-src-row');
        check('one row per data source', await rows.count() === 3, await rows.count());
        check('rows show short names', (await rows.nth(1).locator('.pvx-cfg-src-name').textContent()) === 'Pump 101|Wrong');
        check('the list is the first group in the pane',
            await page.evaluate(() => document.querySelector('#pane .pvx-cfg-group').classList.contains('pvx-cfg-src')));

        await rows.nth(1).locator('button', { hasText: 'Remove' }).click();
        check('Remove asks first',
            await page.evaluate(() => window.__scope.symbol.DataSources.length) === 3 &&
            await rows.nth(1).locator('button', { hasText: 'Confirm' }).count() === 1);
        await rows.nth(1).locator('button', { hasText: 'Keep' }).click();
        check('Keep backs out', await rows.nth(1).locator('button', { hasText: 'Remove' }).count() === 1);

        await rows.nth(1).locator('button', { hasText: 'Remove' }).click();
        await rows.nth(1).locator('button', { hasText: 'Confirm' }).click();
        const after = await page.evaluate(() => ({
            ds: window.__scope.symbol.DataSources.slice(),
            spec: window.__scope.config.TraceSpec,
            msg: (document.querySelector('.pvx-cfg-src-msg') || {}).textContent || ''
        }));
        check('Confirm removes exactly that source',
            after.ds.length === 2 && !after.ds.some((d) => /Wrong/.test(d)), after.ds);
        check('positional config renumbered', after.spec === '1:bar, 2:area', after.spec);
        check('the pane says what changed', /Removed Pump 101\|Wrong\./.test(after.msg) && /TraceSpec/.test(after.msg), after.msg);
        check('rows follow the shorter list', await rows.count() === 2, await rows.count());

        await page.goto('http://127.0.0.1:' + PORT + '/page/pvxRadialGauge', { waitUntil: 'networkidle' });
        await page.evaluate(mount, { typeName: 'pvxRadialGauge', sources: ['pi:\\\\srv\\SINUSOID?c'] });
        check('single-source symbol lists its source', await page.locator('.pvx-cfg-src-row').count() === 1);
        check('...and offers no Remove', await page.locator('.pvx-cfg-src-btn').count() === 0);

        check('no page errors', errors.length === 0, errors);
    } finally {
        await browser.close();
        server.close();
    }
}

(async () => {
    try {
        rules();
        await pane();
    } catch (e) {
        failures += 1;
        console.error(C.red + 'test-sources crashed: ' + (e.stack || e.message) + C.reset);
    }
    console.log('');
    console.log((failures ? C.red + C.bold + failures + ' failed' : C.green + C.bold + 'all ' + passes + ' passed') + C.reset);
    process.exit(failures ? 1 : 0);
})();
