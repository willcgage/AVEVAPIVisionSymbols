/* ============================================================================
 * tools/verify-msi.js — asserts the built MSI actually does what we claim
 * ----------------------------------------------------------------------------
 *   node tools/verify-msi.js [path/to/PvxSymbols.msi] [--strict-attributes]
 *
 * Requires `msiinfo` (Debian/Ubuntu: apt-get install msitools). Reads the MSI's
 * own tables rather than trusting the .wxs that produced it.
 *
 * WHAT THIS EXISTS TO CATCH
 *
 * An MSI fails in ways a build log never shows. It compiles cleanly and then
 * puts the icons in the wrong folder, or ships 140 of 153 files, or — worst —
 * changes a component GUID so that next year's upgrade deletes the file it
 * just installed. None of that is visible without opening the tables.
 *
 * --strict-attributes additionally requires the site-settings component to
 * carry Permanent + NeverOverwrite. Leave it OFF for MSIs built with `wixl`,
 * which silently ignores both attributes; turn it ON for the official WiX
 * toolset build that actually ships.
 * ==========================================================================*/
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var C = { red: '\u001b[31m', green: '\u001b[32m', dim: '\u001b[2m', bold: '\u001b[1m', reset: '\u001b[0m' };

var args = process.argv.slice(2);
var STRICT = args.indexOf('--strict-attributes') !== -1;
var msiPath = args.filter(function (a) { return a.charAt(0) !== '-'; })[0] ||
    path.join(ROOT, 'dist', 'installer', 'PvxSymbols.msi');

var PERMANENT = 16;         // msidbComponentAttributesPermanent
var NEVER_OVERWRITE = 128;  // msidbComponentAttributesNeverOverwrite

var failures = [];
function check(name, ok, detail) {
    if (ok) { console.log('  ' + C.green + 'ok  ' + C.reset + name); }
    else {
        console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + name +
            (detail ? '\n       ' + C.dim + detail + C.reset : ''));
        failures.push(name);
    }
}

function table(name) {
    var out = cp.execSync('msiinfo export ' + JSON.stringify(msiPath) + ' ' + name,
        { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    // msiinfo exports IDT files, which are CRLF-terminated. Splitting on '\n'
    // alone leaves a '\r' glued to the last field of every row, so every
    // comparison against a plain string silently fails.
    var lines = out.split(/\r?\n/);
    // Header is: column names, column types, then the table name.
    return lines.slice(3).filter(function (l) { return l.trim() !== ''; })
        .map(function (l) { return l.split('\t'); });
}

function main() {
    if (!fs.existsSync(msiPath)) {
        console.error('MSI not found: ' + msiPath);
        process.exit(1);
    }
    try { cp.execSync('which msiinfo', { stdio: 'ignore' }); }
    catch (e) {
        console.error('msiinfo not found. Install msitools:  apt-get install -y msitools');
        process.exit(1);
    }

    var manifestPath = path.join(ROOT, 'dist', 'installer', 'components.json');
    if (!fs.existsSync(manifestPath)) {
        console.error('components.json not found — run: node tools/wix.js');
        process.exit(1);
    }
    var manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    console.log('\n' + C.bold + 'Verifying ' + path.basename(msiPath) + C.reset +
        C.dim + '  (' + (fs.statSync(msiPath).size / 1024).toFixed(0) + ' KB)' + C.reset + '\n');

    /* --- directory tree ---------------------------------------------------- */
    var dirRows = table('Directory');
    var dirById = {};
    dirRows.forEach(function (r) { dirById[r[0]] = { parent: r[1], name: r[2] }; });

    function fullPath(dirId) {
        var parts = [];
        var guard = 0;
        while (dirId && dirId !== 'TARGETDIR' && guard++ < 40) {
            var d = dirById[dirId];
            if (!d) { return null; }
            if (d.name !== '.') { parts.unshift(d.name); }
            dirId = d.parent;
        }
        return parts.join('/');
    }

    check('installs under PIVISIONPATH, not a hardcoded path',
        !!dirById.PIVISIONPATH && dirById.PIVISIONPATH.parent === 'TARGETDIR',
        'PIVISIONPATH must be a Directory rooted at TARGETDIR for the path override to work');

    var extPath = fullPath('PVXEXTDIR');
    check('target folder is the PI Vision extensibility folder',
        extPath === 'Scripts/app/editor/symbols/ext',
        'got: ' + extPath);

    /* --- every built file is in the package, in the right place ------------ */
    var componentRows = table('Component');
    var compById = {};
    componentRows.forEach(function (r) {
        compById[r[0]] = { guid: r[1], dir: r[2], attrs: parseInt(r[3], 10) || 0 };
    });

    var fileRows = table('File');
    var installedAt = {};       // 'libraries/pvx-core.js' -> componentId
    fileRows.forEach(function (r) {
        var comp = compById[r[1]];
        if (!comp) { return; }
        var dir = fullPath(comp.dir);
        var rel = (dir === extPath ? '' : dir.slice(extPath.length + 1) + '/') + r[2];
        installedAt[rel] = r[1];
    });

    var expected = manifest.components.map(function (c) { return c.path.split('\\').join('/'); });
    var missing = expected.filter(function (p) { return !installedAt[p]; });
    var extra = Object.keys(installedAt).filter(function (p) { return expected.indexOf(p) === -1; });

    check('all ' + expected.length + ' built files are in the package',
        missing.length === 0, missing.slice(0, 6).join(', '));
    check('package contains nothing the build did not produce',
        extra.length === 0, extra.slice(0, 6).join(', '));

    // The icons landing beside the symbols instead of inside icons/ is the
    // exact bug this catches, and it is invisible in a build log.
    var nested = expected.filter(function (p) { return p.indexOf('/') !== -1; });
    var misplaced = nested.filter(function (p) {
        var comp = compById[installedAt[p]];
        return !comp || fullPath(comp.dir) !== extPath + '/' + p.slice(0, p.lastIndexOf('/'));
    });
    check(nested.length + ' files in subfolders are actually nested',
        misplaced.length === 0, misplaced.slice(0, 6).join(', '));

    /* --- upgrade safety ---------------------------------------------------- */
    var guidMismatch = manifest.components.filter(function (c) {
        var id = installedAt[c.path.split('\\').join('/')];
        var comp = id && compById[id];
        return !comp || comp.guid.replace(/[{}]/g, '').toUpperCase() !== c.guid.toUpperCase();
    });
    check('every component GUID matches components.json',
        guidMismatch.length === 0,
        'a drifting GUID makes next release\'s upgrade delete the file it just installed');

    var guids = {};
    var dupes = [];
    manifest.components.forEach(function (c) {
        if (guids[c.guid]) { dupes.push(c.path); } else { guids[c.guid] = c.path; }
    });
    check('component GUIDs are unique', dupes.length === 0, dupes.slice(0, 4).join(', '));

    var upgradeRows = table('Upgrade');
    check('an Upgrade table exists (MajorUpgrade is wired up)', upgradeRows.length > 0);
    check('Upgrade table uses the frozen UpgradeCode',
        upgradeRows.every(function (r) {
            return r[0].replace(/[{}]/g, '').toUpperCase() === manifest.upgradeCode.toUpperCase();
        }),
        'expected ' + manifest.upgradeCode);

    /* --- properties -------------------------------------------------------- */
    var props = {};
    table('Property').forEach(function (r) { props[r[0]] = r[1]; });
    check('PIVISIONPATH has a sane default',
        /PIVision/i.test(props.PIVISIONPATH || ''), 'got: ' + props.PIVISIONPATH);
    check('ProductVersion matches package.json',
        props.ProductVersion === require(path.join(ROOT, 'package.json')).version,
        'got: ' + props.ProductVersion);

    /* --- the site settings file ------------------------------------------- */
    var siteRel = manifest.siteConfig.split('\\').join('/');
    var siteId = installedAt[siteRel];
    check('site settings file is in the package', !!siteId, siteRel);

    if (siteId) {
        var attrs = compById[siteId].attrs;
        var hasBoth = (attrs & PERMANENT) && (attrs & NEVER_OVERWRITE);
        if (STRICT) {
            check('site settings are Permanent + NeverOverwrite (attrs=' + attrs + ')',
                !!hasBoth,
                'without these, an upgrade overwrites the site PI Web API settings ' +
                'and an uninstall deletes them');
        } else {
            console.log('  ' + C.dim + 'skip' + C.reset + ' Permanent/NeverOverwrite bits ' +
                C.dim + '(attrs=' + attrs + '; wixl ignores them — assert with ' +
                '--strict-attributes on the official WiX build)' + C.reset);
        }
    }

    /* --- report ------------------------------------------------------------ */
    console.log('');
    if (failures.length) {
        console.log(C.red + C.bold + failures.length + ' installer check(s) failed' + C.reset + '\n');
        process.exit(1);
    }
    console.log(C.green + C.bold + 'Installer package is correct' + C.reset +
        C.dim + (STRICT ? '' : '  (structure only — run with --strict-attributes on the WiX build)') +
        C.reset + '\n');
}

main();
