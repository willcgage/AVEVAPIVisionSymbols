#!/usr/bin/env node
/* ============================================================================
 * PVX charts test — Wind Rose arithmetic and XY Scatter bubble mode, against
 * data whose right answer is known.
 * ----------------------------------------------------------------------------
 *   node tools/test-charts.js
 *
 * verify.js proves these render without faults on mock data, which would
 * still pass if every share were wrong. This feeds each symbol a small
 * hand-built payload through tools/probe.js (real Chromium, straight from
 * src/) and reads the computed numbers back out of the tooltips and footer:
 *
 *   wind rose   350° and 10° both land in the north sector (wrap at north);
 *               shares are weighted by time held, not by sample count; a gap
 *               longer than the limit is not credited to the direction before
 *               it, and the footer says how much was left out; calm is
 *               reported, not drawn; "blows to" turns the rose round.
 *   bubble      the third source's value reaches each point's tooltip and
 *               the footer's size range; a pair with no size value is counted.
 *
 * Requires the dev dependency `playwright`. Set PVX_CHROMIUM to use a
 * pre-installed browser.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const C = { reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', bold: '\x1b[1m' };
let failures = 0;
let passes = 0;

function check(name, ok, detail) {
    if (ok) { passes += 1; console.log('  ' + C.green + 'ok  ' + C.reset + name); return; }
    failures += 1;
    console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + name + (detail !== undefined ? C.dim + '  got ' + JSON.stringify(detail) + C.reset : ''));
}

const T0 = Date.parse('2026-10-20T00:00:00Z');
const MIN = 60000;

/** One TimeSeries data source from [minutesAfterT0, value] pairs. */
function series(label, units, pts) {
    return {
        Label: label, Units: units, Path: '\\\\AF\\Test|' + label, IsGood: true,
        Value: pts.map((p) => ({ Time: new Date(T0 + p[0] * MIN).toISOString(), Value: p[1] }))
    };
}

let seq = 0;
function probe(typeName, data, config) {
    const file = path.join(os.tmpdir(), 'pvx-charts-' + process.pid + '-' + (seq++) + '.json');
    fs.writeFileSync(file, JSON.stringify({ Data: data }));
    const args = [path.join(__dirname, 'probe.js'), typeName, '--w', '520', '--h', '340', '--json',
        '--payload', file, '--out', file.replace(/\.json$/, '.png')];
    if (config) { args.push('--config', config); }
    let out;
    try {
        out = execFileSync(process.execPath, args, { encoding: 'utf8', env: process.env });
    } catch (e) {
        // probe exits 1 on page errors but still prints its report.
        out = e.stdout || '';
    }
    const json = JSON.parse(out.slice(out.indexOf('{')));
    const r = json.report || {};
    return { tips: r.tips || [], footer: r.footer || '', errors: (json.errors || []).concat(r.fatal ? [r.fatal] : []) };
}

/** The tooltip of the wedge for one direction word, e.g. 'from N ('. */
function tipFor(res, prefix) {
    return res.tips.filter((t) => t.indexOf(prefix) === 0).join(' | ');
}

function windRose() {
    console.log('');
    console.log(C.bold + 'Wind rose' + C.reset);
    const all = [];

    // 350° for an hour, 10° for an hour, then 180°. The last sample has no
    // successor and holds for the median hold, an hour: N 2 h of 3, S 1 h.
    const wrap = probe('pvxWindRose', [
        series('Dir', '°', [[0, 350], [60, 10], [120, 180]]),
        series('Speed', 'm/s', [[0, 5], [60, 5], [120, 5]])
    ]);
    all.push(wrap);
    check('350° and 10° share the north sector', /from N \(/.test(tipFor(wrap, 'from N (')) && /67% of the time/.test(tipFor(wrap, 'from N (')), tipFor(wrap, 'from N ('));
    check('...and nothing lands in NNW or NNE', !tipFor(wrap, 'from NNW') && !tipFor(wrap, 'from NNE'), wrap.tips);
    check('south holds the remaining third', /33% of the time/.test(tipFor(wrap, 'from S (')), tipFor(wrap, 'from S ('));
    check('the speed band is named from its range', /4–6 m\/s/.test(tipFor(wrap, 'from N (')), tipFor(wrap, 'from N ('));
    check('footer gives the time covered', /3\.0 h covered/.test(wrap.footer), wrap.footer);

    // Ten samples a minute apart from the east, then the west for an hour.
    // Counting samples would make east 10 of 12; by time west is 61 of 71.
    const dense = [];
    for (let m = 0; m < 10; m++) { dense.push([m, 90]); }
    dense.push([10, 270], [70, 270]);
    const weighted = probe('pvxWindRose', [
        series('Dir', '°', dense),
        series('Speed', 'm/s', dense.map((p) => [p[0], 3]))
    ], 'MaxPairGapSeconds=0');
    all.push(weighted);
    check('shares are weighted by time, not sample count', /86% of the time/.test(tipFor(weighted, 'from W (')), tipFor(weighted, 'from W ('));
    check('...east is the minority', /14% of the time/.test(tipFor(weighted, 'from E (')), tipFor(weighted, 'from E ('));

    // Same data with a 10-minute limit: the hour before the last sample is
    // a gap, and 50 minutes of it must not be credited to the west. West is
    // then 10 min plus the last sample's median hold of 1, east 10: 11 of 21.
    const gapped = probe('pvxWindRose', [
        series('Dir', '°', dense),
        series('Speed', 'm/s', dense.map((p) => [p[0], 3]))
    ], 'MaxPairGapSeconds=600');
    all.push(gapped);
    check('a gap is not credited to the direction before it', /52% of the time/.test(tipFor(gapped, 'from W (')), tipFor(gapped, 'from W ('));
    check('...and the footer says how much was left out', /in data gaps not counted/.test(gapped.footer), gapped.footer);

    // Half the time below the calm limit: reported, not drawn.
    const calm = probe('pvxWindRose', [
        series('Dir', '°', [[0, 90], [60, 90], [120, 90], [180, 90]]),
        series('Speed', 'm/s', [[0, 0.2], [60, 0.3], [120, 4], [180, 4]])
    ], 'CalmBelow=0.5');
    all.push(calm);
    check('calm time is in the footer', /calm 50%/.test(calm.footer), calm.footer);
    check('...and the sector shares are of all the time, calm included', /50% of the time/.test(tipFor(calm, 'from E (')), tipFor(calm, 'from E ('));

    const to = probe('pvxWindRose', [
        series('Dir', '°', [[0, 0], [60, 0]]),
        series('Speed', 'm/s', [[0, 5], [60, 5]])
    ], 'DirectionIs=to');
    all.push(to);
    check('"blows to" turns a northerly round to the south', !!tipFor(to, 'toward S (') && !tipFor(to, 'toward N ('), to.tips);

    // An "I/O Timeout" in the direction for the middle hour: that hour is
    // reported, not credited to the direction before it.
    const outage = probe('pvxWindRose', [
        series('Dir', '°', [[0, 90], [60, 'I/O Timeout'], [120, 90], [180, 90]]),
        series('Speed', 'm/s', [[0, 3], [60, 3], [120, 3], [180, 3]])
    ]);
    all.push(outage);
    check('a bad value ends the hold before it', /3\.0 h covered/.test(outage.footer) && /1\.0 h of bad or unpaired values not counted/.test(outage.footer), outage.footer);
    check('...and the good time is all east', /100% of the time/.test(tipFor(outage, 'from E (')), tipFor(outage, 'from E ('));

    // Direction alone is a direction histogram, no legend bands.
    const alone = probe('pvxWindRose', [series('Dir', '°', [[0, 45], [60, 45], [120, 225]])]);
    all.push(alone);
    check('direction alone still draws', /67% of the time/.test(tipFor(alone, 'from NE (')), alone.tips);

    const errs = [].concat.apply([], all.map((r) => r.errors));
    check('no page errors', errs.length === 0, errs);
}

function bubble() {
    console.log('');
    console.log(C.bold + 'XY Scatter bubble mode' + C.reset);
    const xs = [], ys = [], zs = [];
    for (let m = 0; m < 10; m++) { xs.push([m, m]); ys.push([m, 2 * m]); }
    // The size tag starts five minutes late: five pairs have no size value.
    for (let m = 5; m < 10; m++) { zs.push([m, m * 10]); }
    const data = [series('Load', 'MW', xs), series('Flow', 't/h', ys), series('Temp', 'degC', zs)];

    const on = probe('pvxXYScatter', data, 'BubbleMode=true');
    check('the size value is in each point tooltip', on.tips.some((t) => /Temp: 90(\.0+)? degC/.test(t)), on.tips.slice(0, 3));
    check('the footer gives the size range', /size: Temp 50–90 degC/.test(on.footer), on.footer);
    check('pairs with no size value are counted', /5 without a size value/.test(on.footer), on.footer);
    check('...and not drawn', on.tips.filter((t) => /^Load:/.test(t)).length === 5, on.tips.length);

    const off = probe('pvxXYScatter', data);
    check('bubble mode off: third source ignored and said so', /1 extra source ignored/.test(off.footer), off.footer);
    check('bubble mode off: every pair drawn', off.tips.filter((t) => /^Load:/.test(t)).length === 10, off.tips.length);

    const errs = [].concat(on.errors, off.errors);
    check('no page errors', errs.length === 0, errs);
}

(() => {
    try {
        windRose();
        bubble();
    } catch (e) {
        failures += 1;
        console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + (e.stack || e.message));
    }
    console.log('');
    if (failures) {
        console.log(C.red + C.bold + failures + ' failed' + C.reset + C.dim + ', ' + passes + ' passed' + C.reset);
        process.exit(1);
    }
    console.log(C.green + C.bold + 'All ' + passes + ' chart checks passed' + C.reset);
})();
