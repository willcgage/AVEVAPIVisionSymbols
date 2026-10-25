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
 * carry Permanent + NeverOverwrite, and the upgrade machinery (searches, the
 * 1.6.0 clean-up, the settings move, the folder dialog) to be present. Leave it
 * OFF for MSIs built with `wixl`, which ignores both attributes and cannot
 * compile the rest (the .wxs is compiled with PvxFull=0 for it); turn it ON
 * for the official WiX toolset build that actually ships.
 *
 * Tables prove the package is assembled right, not that Windows Installer
 * does the right thing with it. The `installer-windows` CI job installs,
 * upgrades from 1.6.0 and uninstalls for real; this is the fast half.
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

    // A 32-bit package has Windows Installer redirect C:\Program Files to
    // Program Files (x86) — 1.6.0's default install went where PI Vision is not.
    var suminfo = cp.execSync('msiinfo suminfo ' + JSON.stringify(msiPath), { encoding: 'utf8' });
    var template = (/Template:\s*(\S+)/.exec(suminfo) || [])[1] || '';
    check('package is x64 (no Program Files (x86) redirection)',
        /^x64;/.test(template), 'Template: ' + template);
    var comps64 = table('Component').filter(function (r) { return !((parseInt(r[3], 10) || 0) & 256); });
    check('every component is 64-bit', comps64.length === 0,
        comps64.slice(0, 4).map(function (r) { return r[0]; }).join(', '));

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
    // The point of the 1.7 layout: nothing of ours loose in the folders other
    // symbol packs share. Every file must sit under ext/pvx/ or
    // ext/libraries/pvx/, and the build must not have drifted back.
    var loose = expected.filter(function (p) {
        return p.indexOf('pvx/') !== 0 && p.indexOf('libraries/pvx/') !== 0;
    });
    check('every file is inside ext/pvx/ or ext/libraries/pvx/',
        loose.length === 0, loose.slice(0, 6).join(', '));

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
    // The location is set by type-51 actions now, not a Property default, so
    // that drive and PIPC folder can be chosen separately. Assert the chain.
    var cas = {};
    table('CustomAction').forEach(function (r) { cas[r[0]] = { type: r[1], target: r[2], value: r[3] }; });
    check('PIVISIONPATH falls back to the standard PI Vision folder',
        !!cas.PvxLocDefault && cas.PvxLocDefault.target === 'PIVISIONPATH' &&
        /^C:\\Program Files\\PIPC\\PIVision\\?$/i.test(cas.PvxLocDefault.value),
        'got: ' + JSON.stringify(cas.PvxLocDefault));
    check('PIHOME64, INSTALLDRIVE and PIPCFOLDER all feed PIVISIONPATH',
        !!cas.PvxLocFromPihome && /%PIHOME64/.test(cas.PvxLocFromPihome.value) &&
        !!cas.PvxLocFromParts && /\[PVXDRIVEROOT\]\[PIPCFOLDER\]/.test(cas.PvxLocFromParts.value),
        'location custom actions missing or rewritten');
    ['InstallUISequence', 'InstallExecuteSequence'].forEach(function (seq) {
        var rows = {};
        table(seq).forEach(function (r) { rows[r[0]] = parseInt(r[2], 10); });
        var rules = Object.keys(cas).filter(function (k) { return /^Pvx(Loc|Drive|Pipc)/.test(k); });
        // wixl leaves AppSearch out when there is nothing to search for (the
        // searches are PvxFull-only), so fall back to its standard number.
        var appSearch = rows.AppSearch || 50;
        var misplaced = rules.filter(function (k) {
            return !(rows[k] > rows.FindRelatedProducts && rows[k] < appSearch);
        });
        check(seq + ': location rules run before AppSearch',
            rules.length > 0 && misplaced.length === 0,
            'the searches look in PIVISIONPATH, so it must be resolved first: ' + misplaced.join(', '));
    });
    // wixl drops Secure="yes", so this is only checkable on the real build.
    if (STRICT) {
        ['PIVISIONPATH', 'INSTALLDRIVE', 'PIPCFOLDER'].forEach(function (p) {
            check(p + ' is Secure (survives elevation)',
                (props.SecureCustomProperties || '').split(';').indexOf(p) !== -1,
                'SecureCustomProperties = ' + props.SecureCustomProperties);
        });
    }
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

    /* --- upgrade machinery: only the official toolset can compile it -------- */
    if (STRICT) {
        var sigs = {};
        table('AppSearch').forEach(function (r) { sigs[r[0]] = r[1]; });
        check('AppSearch looks for PI Vision, the old and the new pvx-config.js',
            !!sigs.PVXSYMBOLSDIR && !!sigs.PVXLEGACYCONFIG && !!sigs.PVXSITECONFIG,
            'got: ' + Object.keys(sigs).join(', '));
        var moves = table('MoveFile');
        check('a 1.6.0-era pvx-config.js is moved (not copied) into libraries/pvx',
            moves.length === 1 && /pvx-config\.js/.test(moves[0][2]) && moves[0][6] === '1',
            'MoveFile rows: ' + JSON.stringify(moves));
        var removes = table('RemoveFile').map(function (r) { return r[2]; });
        check('the 1.6.0 flat files are removed on install',
            ['sym-pvx*.js', 'pvx*.svg', 'pvx-core.js'].every(function (n) {
                return removes.some(function (x) { return x.split('|').pop() === n; });
            }),
            'RemoveFile names: ' + removes.join(', '));
        check('the folder dialog is wired to PIVISIONPATH',
            props.WIXUI_INSTALLDIR === 'PIVISIONPATH', 'got: ' + props.WIXUI_INSTALLDIR);
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
