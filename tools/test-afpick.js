#!/usr/bin/env node
/* ============================================================================
 * PVX afpick test — choosing AF paths in a format pane instead of typing them.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-afpick.js
 *
 * Two halves:
 *
 *   rules    PVX.afpick in plain Node: path splitting, the breadcrumb, and the
 *            line each list grammar appends. These decide what is SAVED, so a
 *            mistake here is a display that loads with a wrong path in it.
 *   pane     the BUILT format panes in real Chromium against a mock PI Web
 *            API: Browse opens beside the current value, drills and searches,
 *            Use writes a plain path into the bound config key, a list field
 *            gets a line in its own grammar, a bad path falls back to the
 *            nearest level that opens and says so, and an unconfigured site
 *            is told where to configure it.
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
const PORT = 31795;

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
    console.log(C.bold + 'PVX.afpick rules' + C.reset);
    const A = loadCore().afpick;

    check('typeOf: server / database / element / attribute / root',
        [A.typeOf('\\\\S'), A.typeOf('\\\\S\\DB'), A.typeOf('\\\\S\\DB\\E'), A.typeOf('\\\\S\\DB\\E|a'), A.typeOf('')].join() ===
        'server,database,element,attribute,root');
    check('parent of a child attribute drops one attribute', A.parent('\\\\S\\DB\\E|a|b') === '\\\\S\\DB\\E|a', A.parent('\\\\S\\DB\\E|a|b'));
    check('parent of an attribute is its element', A.parent('\\\\S\\DB\\E|a') === '\\\\S\\DB\\E', A.parent('\\\\S\\DB\\E|a'));
    check('parent of a server is the top', A.parent('\\\\S') === '', A.parent('\\\\S'));
    check('spaces inside names survive', A.parent('\\\\S\\Prod DB\\Site A\\Pump 1') === '\\\\S\\Prod DB\\Site A');

    const cr = A.crumbs({ type: 'attribute', path: '\\\\S\\DB\\E|a' });
    check('crumbs: one per level, each navigable by its own path',
        cr.map((c) => c.type + '=' + c.path).join(' ') ===
        'root= server=\\\\S database=\\\\S\\DB element=\\\\S\\DB\\E attribute=\\\\S\\DB\\E|a', cr);

    const it = { name: 'Charge', path: '\\\\S\\DB\\R1|Charge' };
    check('plain field: the pick is the path, nothing else',
        A.compose('', it, 'old', {}).value === '\\\\S\\DB\\R1|Charge');
    check('entryRow: under ElementPath it is written bare',
        A.compose('entryRow', it, '', { ElementPath: '\\\\S\\DB\\R1' }).value === 'Charge');
    check('entryRow: elsewhere it is written in full',
        A.compose('entryRow', it, 'Temp', { ElementPath: '\\\\S\\DB\\R2' }).value === 'Temp\n\\\\S\\DB\\R1|Charge');
    check('entryRow: ElementPath match ignores case',
        A.compose('entryRow', it, '', { ElementPath: '\\\\s\\db\\r1' }).value === 'Charge');
    const dup = A.compose('entryRow', it, 'Charge | Catalyst | kg\nCharge', { ElementPath: '\\\\S\\DB\\R1' });
    check('a line already present is not added twice', dup.added === false && dup.value === 'Charge | Catalyst | kg\nCharge', dup);
    const el = { name: 'Boiler 3', path: '\\\\S\\DB\\Boiler 3' };
    check('navItem: asset mode is "Label | path"',
        A.compose('navItem', el, '', { Mode: 'asset' }).value === 'Boiler 3 | \\\\S\\DB\\Boiler 3');
    check('navItem: custom mode puts the path in asset=',
        A.compose('navItem', el, 'A | 1', { Mode: 'custom' }).value === 'A | 1\nBoiler 3 |  | asset=\\\\S\\DB\\Boiler 3');
}

/* --------------------------------------------------------- mock PI Web API */

// One AF server, two databases, a small hierarchy, and a Data Archive.
// WebIDs are the path itself with a prefix, which keeps the mock honest:
// a request for an object nobody resolved first cannot be answered.
const TREE = [
    ['server', '\\\\AFSRV'],
    ['database', '\\\\AFSRV\\Production'],
    ['database', '\\\\AFSRV\\Lab'],
    ['element', '\\\\AFSRV\\Production\\Site A'],
    ['element', '\\\\AFSRV\\Production\\Site A\\Reactor1'],
    ['element', '\\\\AFSRV\\Production\\Site A\\Reactor2'],
    ['element', '\\\\AFSRV\\Production\\Cooling'],
    ['attribute', '\\\\AFSRV\\Production\\Site A\\Reactor1|Catalyst Charge'],
    ['attribute', '\\\\AFSRV\\Production\\Site A\\Reactor1|Temp'],
    ['attribute', '\\\\AFSRV\\Production\\Site A\\Reactor1|Temp|Setpoint'],
    ['dataserver', '\\\\PISRV'],
    ['point', '\\\\PISRV\\SINUSOID'],
    ['point', '\\\\PISRV\\CDT158']
];
const byId = {};
const byPath = {};
TREE.forEach(([type, p]) => {
    const name = p.split(/[\\|]/).filter(Boolean).pop();
    const o = { type, Path: p, Name: name, WebId: 'W' + type[0] + ':' + p };
    byId[o.WebId] = o;
    byPath[type + '|' + p.toLowerCase()] = o;
});
const parentOf = (o) => {
    const p = o.Path;
    const cut = Math.max(p.lastIndexOf('|'), p.lastIndexOf('\\'));
    return p.slice(0, cut);
};
const all = TREE.map(([t, p]) => byPath[t + '|' + p.toLowerCase()]);
const kids = (o, type, deep) => all.filter((c) => c.type === type && (deep
    ? c.Path.toLowerCase().indexOf(o.Path.toLowerCase() + '\\') === 0
    : parentOf(c).toLowerCase() === o.Path.toLowerCase()));
// PI Web API's HasChildren means child elements on an element, child
// attributes on an attribute — never "has attributes".
const out = (o) => ({ Name: o.Name, Path: o.Path, WebId: o.WebId,
    HasChildren: kids(o, o.type === 'attribute' ? 'attribute' : 'element', false).length > 0 });
const like = (name, filter) => {
    if (!filter) { return true; }
    const re = new RegExp('^' + filter.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
    return re.test(name);
};

let requests = [];

function api(req, res, url) {
    const q = new URL(url, 'http://x').searchParams;
    const rel = decodeURIComponent(new URL(url, 'http://x').pathname).replace(/^\/piwebapi\/?/, '');
    requests.push(rel + (q.toString() ? '?' + q.toString() : ''));
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const items = (list) => send(200, { Items: list.slice(0, parseInt(q.get('maxCount') || '1000', 10)).map(out) });

    const byPathEp = { assetservers: 'server', dataservers: 'dataserver', assetdatabases: 'database', elements: 'element', attributes: 'attribute' };
    if (byPathEp[rel] && q.get('path')) {
        const o = byPath[byPathEp[rel] + '|' + q.get('path').toLowerCase()];
        return o ? send(200, out(o)) : send(404, { Errors: ['Not found: ' + q.get('path')] });
    }
    if (rel === 'assetservers') { return items(all.filter((o) => o.type === 'server')); }
    if (rel === 'dataservers') { return items(all.filter((o) => o.type === 'dataserver')); }
    const m = /^(\w+)\/([^/]+)\/(\w+)$/.exec(rel);
    if (m && byId[m[2]]) {
        const o = byId[m[2]];
        const want = { assetdatabases: 'database', elements: 'element', attributes: 'attribute', points: 'point' }[m[3]];
        const deep = q.get('searchFullHierarchy') === 'true';
        return items(kids(o, want, deep).filter((c) => like(c.Name, q.get('nameFilter'))));
    }
    send(404, { Errors: ['No mock for ' + rel] });
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
            if (req.url.indexOf('/piwebapi') === 0) { api(req, res, req.url); return; }
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

/** Runs in the browser: mount symbol + pane, PI Web API pointed at the mock. */
async function mount(a) {
    window.PVX.api.configure({ baseUrl: a.configured === false ? '' : location.origin + '/piwebapi', auth: 'anonymous' });
    const def = window.PVMock.get(a.typeName);
    const injector = angular.injector(['ng']);
    const $compile = injector.get('$compile');
    const scope = injector.get('$rootScope').$new(true);
    scope.config = def.getDefaultConfig();
    Object.keys(a.config || {}).forEach((k) => { scope.config[k] = a.config[k]; });
    scope.runtimeData = { isEditMode: true };
    scope.symbol = { Name: a.typeName, DataSources: ['pi:\\\\srv\\SINUSOID?c'] };
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
    console.log(C.bold + 'AF path browser (built panes)' + C.reset);
    const { chromium } = require('playwright');
    const server = await serve();
    const launchOpts = { args: ['--no-sandbox', '--disable-dev-shm-usage'] };
    if (process.env.PVX_CHROMIUM) { launchOpts.executablePath = process.env.PVX_CHROMIUM; }
    const browser = await chromium.launch(launchOpts);
    try {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const open = async (typeName, config, configured) => {
            await page.goto('http://127.0.0.1:' + PORT + '/page/' + typeName, { waitUntil: 'networkidle' });
            await page.evaluate(mount, { typeName, config, configured });
        };
        const cfg = (k) => page.evaluate((key) => window.__scope.config[key], k);
        const panel = page.locator('.pvx-cfg-af-panel');
        const names = async () => (await panel.locator('.pvx-cfg-af-name').allTextContents()).map((s) => s.trim());
        const row = (name) => panel.locator('.pvx-cfg-af-row').filter({ has: page.locator('.pvx-cfg-af-name', { hasText: name }) }).first();
        const settle = () => page.waitForFunction(() => {
            const s = window.__scope.runtimeData.pvxAf;
            return s && !s.busy;
        }).then(() => page.waitForTimeout(30));

        // --- Asset Tree: a database, then an element inside it ---
        await open('pvxAssetTree', { DatabasePath: '', RootElementPath: '' });
        const browse = page.locator('.pvx-cfg-af-toggle');
        check('one Browse per AF path field', await browse.count() === 2, await browse.count());
        check('nothing is requested until Browse is pressed',
            !requests.some((r) => /^assetservers/.test(r)), requests);

        await browse.nth(0).click();
        await settle();
        check('a database field starts at the server list, AF servers only', (await names()).join() === 'AFSRV', await names());
        await row('AFSRV').locator('.pvx-cfg-af-name').click();
        await settle();
        check('a server lists its databases', (await names()).join() === 'Production,Lab', await names());
        check('a database field does not drill into a database',
            await row('Production').locator('.pvx-cfg-af-name').isDisabled());
        await row('Production').locator('button', { hasText: 'Use' }).click();
        check('Use writes the plain path into the bound key', await cfg('DatabasePath') === '\\\\AFSRV\\Production', await cfg('DatabasePath'));
        check('...shows it in the text box', await page.inputValue('#pvxat-db') === '\\\\AFSRV\\Production');
        check('...and closes the browser', await panel.count() === 0);

        await browse.nth(1).click();
        await settle();
        check('an element field opens inside the database already chosen',
            (await names()).join() === 'Site A,Cooling', await names());
        check('the breadcrumb leads back up',
            (await panel.locator('.pvx-cfg-af-crumb').allTextContents()).join('>') === 'All servers>AFSRV>Production');

        await panel.locator('.pvx-cfg-af-search').fill('reac');
        await page.waitForTimeout(450);
        await settle();
        const hits = await names();
        check('search finds elements anywhere below, and says where',
            hits.length === 2 && hits[0] === 'Reactor1 in Site A', hits);
        check('search is one server-side request, not a walk',
            requests.filter((r) => /searchFullHierarchy=true/.test(r) && /nameFilter=\*reac\*/.test(r)).length === 1,
            requests.filter((r) => /nameFilter/.test(r)));
        await row('Reactor1').locator('button', { hasText: 'Use' }).click();
        check('the picked element is stored as its path',
            await cfg('RootElementPath') === '\\\\AFSRV\\Production\\Site A\\Reactor1', await cfg('RootElementPath'));

        await browse.nth(1).click();
        await settle();
        check('reopening starts beside the current value',
            (await names()).join() === 'Reactor1,Reactor2', await names());
        await browse.nth(1).click();

        await page.fill('#pvxat-db', '\\\\AFSRV\\Typo');
        await browse.nth(0).click();
        await settle();
        const miss = (await panel.locator('.pvx-cfg-af-msg').textContent()) || '';
        check('a value missing from its own level says so', /AFSRV\\Typo is not in this list/.test(miss), miss);
        await browse.nth(0).click();

        await page.fill('#pvxat-root', '\\\\AFSRV\\Production\\Nowhere\\Pump 9');
        await browse.nth(1).click();
        await settle();
        const msg = (await panel.locator('.pvx-cfg-af-msg').textContent()) || '';
        check('a path whose parent does not resolve says so',
            /Could not open \\\\AFSRV\\Production\\Nowhere/.test(msg) && /Not found/.test(msg), msg);
        check('...and shows the nearest level that does', (await names()).join() === 'Site A,Cooling', await names());

        // --- Entry Table: rows appended in the sheet's own grammar ---
        await open('pvxEntryTable', { ElementPath: '\\\\AFSRV\\Production\\Site A\\Reactor1', Rows: '' });
        await page.locator('.pvx-cfg-af-toggle').nth(1).click();
        await settle();
        check('a rows field opens at the element path', (await names()).join() === 'Catalyst Charge,Temp', await names());
        await row('Catalyst Charge').locator('button', { hasText: 'Add' }).click();
        check('a row under the element path is added bare', await cfg('Rows') === 'Catalyst Charge', await cfg('Rows'));
        check('the browser stays open for the next row', await panel.count() === 1);
        await row('Catalyst Charge').locator('button', { hasText: 'Add' }).click();
        check('the same row is refused a second time, and the pane says so',
            await cfg('Rows') === 'Catalyst Charge' && /already in the list/.test(await panel.locator('.pvx-cfg-af-msg').textContent()));
        await row('Temp').locator('.pvx-cfg-af-name').click();
        await settle();
        await row('Setpoint').locator('button', { hasText: 'Add' }).click();
        check('a child attribute keeps its own pipe', await cfg('Rows') === 'Catalyst Charge\nTemp|Setpoint', await cfg('Rows'));

        // --- Manual Entry: a PI point is a valid pick too ---
        await open('pvxManualEntry', { AttributePath: '' });
        await page.locator('.pvx-cfg-af-toggle').click();
        await settle();
        check('an attribute field also offers Data Archives', (await names()).join() === 'AFSRV,PISRV', await names());
        await row('PISRV').locator('.pvx-cfg-af-name').click();
        await settle();
        check('a Data Archive lists its points', (await names()).join() === 'SINUSOID,CDT158', await names());
        await row('SINUSOID').locator('button', { hasText: 'Use' }).click();
        check('a point is stored as \\\\server\\tag', await cfg('AttributePath') === '\\\\PISRV\\SINUSOID', await cfg('AttributePath'));

        // --- Nav Panel: only where an item takes an asset ---
        await open('pvxNavPanel', { Mode: 'display', Items: '' });
        check('no Browse in display mode, where a line needs a display id first',
            await page.locator('.pvx-cfg-af-toggle').count() === 0);
        await page.evaluate(() => { window.__scope.config.Mode = 'asset'; window.__scope.$digest(); });
        await page.locator('.pvx-cfg-af-toggle').click();
        await settle();
        await row('AFSRV').locator('.pvx-cfg-af-name').click();
        await settle();
        await row('Production').locator('.pvx-cfg-af-name').click();
        await settle();
        await row('Cooling').locator('button', { hasText: 'Add' }).click();
        check('asset mode adds "Label | path"', await cfg('Items') === 'Cooling | \\\\AFSRV\\Production\\Cooling', await cfg('Items'));

        // --- A site that has not configured PI Web API ---
        await open('pvxEventGantt', { DatabasePath: '' }, false);
        await page.locator('.pvx-cfg-af-toggle').click();
        await settle();
        const nc = (await panel.locator('.pvx-cfg-af-msg').textContent()) || '';
        check('unconfigured: the pane names the file to fix', /pvx-config\.js/.test(nc), nc);
        check('...and the text box still takes a typed path', await page.isEditable('#pvxeg-db'));

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
        console.error(C.red + 'test-afpick crashed: ' + (e.stack || e.message) + C.reset);
    }
    console.log('');
    console.log((failures ? C.red + C.bold + failures + ' failed' : C.green + C.bold + 'all ' + passes + ' passed') + C.reset);
    process.exit(failures ? 1 : 0);
})();
