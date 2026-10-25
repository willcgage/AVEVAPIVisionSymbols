#!/usr/bin/env node
/* ============================================================================
 * PVX limits test — an alarm symbol with no limits set must not alarm.
 * ----------------------------------------------------------------------------
 *   node tools/build.js && node tools/test-limits.js
 *
 * On a live 1.9.0 server the Exception Banner, Annunciator and Status Grid
 * flagged points that had no limits at all. They were applying the shared
 * placeholder bands (0 / 70 / 90, PVX.thresholds.DEFAULT) to every point,
 * whatever its units, and displays had saved that placeholder.
 *
 *   rules    in plain Node, against the BUILT files: the placeholder is
 *            recognised however it is spaced or ordered, the three alarm
 *            symbols default to no bands, a saved placeholder is cleared on
 *            load while chosen bands survive, and symbols that only colour
 *            (a gauge) keep the placeholder as before.
 *   render   each alarm symbol through tools/probe.js in real Chromium, fed
 *            the mock plant (steam flow ~92-96 klb/h, well above 90): with no
 *            bands nothing is flagged and the panel says why; with bands set
 *            the same data alarms, so the first half is not passing because
 *            the symbol stopped working.
 *
 * Requires the dev dependency `playwright` for the second half. Set
 * PVX_CHROMIUM to use a pre-installed browser.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const EXT = path.join(ROOT, 'dist', 'ext');
const CORE = path.join(EXT, 'libraries', 'pvx', 'pvx-core.js');
const ALARM_SYMBOLS = ['pvxAlarmBanner', 'pvxAnnunciator', 'pvxStatusGrid'];

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

/** The built core and symbols in one context, registered into the mock catalog. */
function loadBuilt(typeNames) {
    const win = { console: console, setTimeout: setTimeout, clearTimeout: clearTimeout };
    win.window = win;
    vm.createContext(win);
    const run = (file) => vm.runInContext(fs.readFileSync(file, 'utf8'), win, { filename: path.basename(file) });
    run(path.join(ROOT, 'dev', 'pv-mock.js'));
    run(CORE);
    typeNames.forEach((t) => run(path.join(EXT, 'sym-' + t + '.js')));
    return win;
}

function rules() {
    console.log('');
    console.log(C.bold + 'Limits rules' + C.reset);
    const win = loadBuilt(ALARM_SYMBOLS.concat(['pvxRadialGauge']));
    const T = win.PVX.thresholds;
    const PLACEHOLDER = T.DEFAULT;

    check('the placeholder is recognised', T.isPlaceholder(PLACEHOLDER) === true);
    check('...however it is spaced or ordered',
        T.isPlaceholder('90:#c8452f:Critical,0:#2f9e5f:Normal,   70:#d99024:High') === true);
    check('changing one limit makes it a real spec', T.isPlaceholder('0:#2f9e5f:Normal, 75:#d99024:High, 90:#c8452f:Critical') === false);
    check('changing one label makes it a real spec', T.isPlaceholder('0:#2f9e5f:Normal, 70:#d99024:Hi, 90:#c8452f:Critical') === false);
    check('empty is not the placeholder', T.isPlaceholder('') === false && T.isPlaceholder(undefined) === false);

    ALARM_SYMBOLS.forEach((t) => {
        const def = win.PVMock.get(t);
        check(t + ': registered', !!def);
        if (!def) { return; }
        check(t + ': defaults to no bands', def.getDefaultConfig().Thresholds === '', def.getDefaultConfig().Thresholds);
        check(t + ': limitsRequired is not left on the catalog definition', !('limitsRequired' in def));

        const saved = def.loadConfig({ Thresholds: PLACEHOLDER, Title: 'Unit 1' });
        check(t + ': a saved placeholder is cleared on load', saved.Thresholds === '', saved.Thresholds);
        check(t + ': ...and nothing else is touched', saved.Title === 'Unit 1', saved.Title);

        const chosen = '0:#2f9e5f:Normal, 120:#c8452f:Trip';
        check(t + ': bands someone chose survive load', def.loadConfig({ Thresholds: chosen }).Thresholds === chosen);
        check(t + ': a display saved without the key loads with no bands', def.loadConfig({}).Thresholds === '');
    });

    // A gauge colouring its arc with the placeholder raises no alarm, and
    // its saved displays must render exactly as they did.
    const gauge = win.PVMock.get('pvxRadialGauge');
    check('pvxRadialGauge keeps the placeholder default', gauge.getDefaultConfig().Thresholds === PLACEHOLDER);
    check('pvxRadialGauge keeps a saved placeholder', gauge.loadConfig({ Thresholds: PLACEHOLDER }).Thresholds === PLACEHOLDER);
}

/* ----------------------------------------------------------------- render */

function probe(typeName, config) {
    const args = [path.join(__dirname, 'probe.js'), typeName, '--w', '480', '--h', '240', '--json',
        '--out', path.join(require('os').tmpdir(), 'pvx-limits-' + typeName + '.png')];
    if (config) { args.push('--config', config); }
    let out;
    try {
        out = execFileSync(process.execPath, args, { encoding: 'utf8', env: process.env });
    } catch (e) {
        // probe exits 1 on page errors but still prints its report.
        out = e.stdout || '';
    }
    const json = JSON.parse(out.slice(out.indexOf('{')));
    return { text: (json.report && json.report.text) || '', errors: json.errors || [], fatal: json.report && json.report.fatal };
}

function render() {
    console.log('');
    console.log(C.bold + 'Limits render (mock plant, values above 90)' + C.reset);
    const BANDS = 'Thresholds=0:#2f9e5f:Normal, 80:#c8452f:Trip';

    const ab = probe('pvxAlarmBanner');
    check('banner, no bands: says no limits are set', /No limits set/.test(ab.text), ab.text);
    check('banner, no bands: no false all-clear', !/within limits/.test(ab.text), ab.text);
    check('banner, no bands: nothing flagged', !/Critical|High|Trip/.test(ab.text), ab.text);
    const abSet = probe('pvxAlarmBanner', BANDS);
    check('banner, bands set: the same data is flagged', /Trip/.test(abSet.text) && !/No limits set/.test(abSet.text), abSet.text);

    const an = probe('pvxAnnunciator');
    check('annunciator, no bands: says no tile can alarm', /No limits set/.test(an.text), an.text);
    check('annunciator, no bands: no tile latched', !/NEW|CRITICAL|HIGH|TRIP/.test(an.text) && /NO LIMITS/.test(an.text), an.text);
    const anSet = probe('pvxAnnunciator', BANDS);
    check('annunciator, bands set: the same data latches', /TRIP/.test(anSet.text) && !/No limits set/.test(anSet.text), anSet.text);

    const sg = probe('pvxStatusGrid');
    check('status grid, no bands: no tile is banded', !/Critical|High|Normal|Trip/.test(sg.text), sg.text);
    const sgSet = probe('pvxStatusGrid', BANDS);
    check('status grid, bands set: the same data is banded', /Trip/.test(sgSet.text), sgSet.text);

    const all = [ab, abSet, an, anSet, sg, sgSet];
    const errs = [].concat.apply([], all.map((r) => r.errors.concat(r.fatal ? [r.fatal] : [])));
    check('no page errors', errs.length === 0, errs);
}

(() => {
    try {
        rules();
        render();
    } catch (e) {
        failures += 1;
        console.error(C.red + 'test-limits crashed: ' + (e.stack || e.message) + C.reset);
    }
    console.log('');
    console.log((failures ? C.red + C.bold + failures + ' failed' : C.green + C.bold + 'all ' + passes + ' passed') + C.reset);
    process.exit(failures ? 1 : 0);
})();
