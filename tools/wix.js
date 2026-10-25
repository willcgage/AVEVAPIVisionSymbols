/* ============================================================================
 * tools/wix.js — generates the WiX source for the PVX installer
 * ----------------------------------------------------------------------------
 *   node tools/wix.js            reads dist/ext, writes dist/installer/
 *
 * Emits:
 *   dist/installer/PvxSymbols.wxs      WiX v3 source, one component per file
 *   dist/installer/components.json     the GUID map, for auditing
 *
 * WHY THIS IS GENERATED RATHER THAN HAND-WRITTEN
 *
 * The library is 153 files and grows every release. A hand-maintained .wxs
 * drifts from the build the first time someone adds a symbol and forgets, and
 * the failure mode is silent: the MSI installs a subset and the missing symbol
 * simply does not appear in the palette. Generating it from the actual build
 * output makes that impossible.
 *
 * WHY THE GUIDs ARE DERIVED RATHER THAN RANDOM
 *
 * Windows Installer identifies a component by its GUID, not by its path. If a
 * file's component GUID changes between versions, the installer treats the new
 * one as a different component that happens to live at the same path — it
 * installs the new file, then the uninstall of the old version deletes it,
 * and the upgrade removes the very file it just laid down.
 *
 * So GUIDs must be stable across releases for a given path, and must differ
 * between paths. UUIDv5 over the relative path gives exactly that, with no
 * state to keep: the same path always yields the same GUID, on any machine,
 * forever. Adding a file adds a GUID; removing one retires it; nothing else
 * moves.
 *
 * DO NOT change PVX_NAMESPACE or UPGRADE_CODE. They are the identity of the
 * product across every version that has ever shipped. A new namespace makes
 * every future upgrade a stranger to every installed copy.
 * ==========================================================================*/
'use strict';

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var ROOT = path.join(__dirname, '..');
var SRC = path.join(ROOT, 'dist', 'ext');
var OUT = path.join(ROOT, 'dist', 'installer');

var pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

/* --- identity. Frozen. See the header. ---------------------------------- */
var PVX_NAMESPACE = 'b1a7f2c4-5d3e-4f8a-9c6b-7e0d1a2b3c4d';
var UPGRADE_CODE = uuid5(PVX_NAMESPACE, 'pvx:upgrade-code').toUpperCase();

var MANUFACTURER = 'PVX';
var PRODUCT_NAME = 'PVX Symbol Library for PI Vision';

/* The file whose content belongs to the site rather than to the build. It is
 * marked Permanent + NeverOverwrite so neither an upgrade nor an uninstall can
 * take a site's PI Web API settings away. */
var SITE_CONFIG = 'libraries\\pvx\\pvx-config.js';
var SITE_DIR = 'libraries/pvx';

/* Files earlier versions left where this one does not put them, by PVX's own
 * name patterns. An MSI upgrade removes them through the old product, but a
 * server deployed by hand or with the PowerShell script has no old product.
 *
 *   1.6.0 and earlier: the runtime loose in ext\libraries\.
 *   1.7.0: everything but the runtime in ext\pvx\ and ext\pvx\icons\, where
 *   PI Vision served none of it.
 *
 * ext\sym-pvx*, ext\piwebapi-check.html and ext\icons\pvx*.svg are listed
 * although this version installs them there too. RemoveFiles runs before
 * InstallFiles, so the current ones are laid down again, and a symbol dropped
 * from the library cannot linger and register.
 * pvx-config.js is not here: it is moved into SITE_DIR, never deleted. */
var LEGACY_FILES = [
    { dir: '',          name: 'sym-pvx*.js' },
    { dir: '',          name: 'sym-pvx*.css' },
    { dir: '',          name: 'sym-pvx*.html' },
    { dir: '',          name: 'piwebapi-check.html' },
    { dir: 'icons',     name: 'pvx*.svg' },
    { dir: 'libraries', name: 'pvx-core.js' },
    { dir: 'pvx',       name: 'sym-pvx*' },
    { dir: 'pvx',       name: 'piwebapi-check.html' },
    { dir: 'pvx/icons', name: 'pvx*.svg' }
];
/* 1.7.0's folders, emptied by the entries above and then removed, innermost
 * first. A folder something else was put in is left alone. */
var LEGACY_DIRS = ['pvx/icons', 'pvx'];

/* Two components that carry behaviour rather than a file. Their GUIDs come from
 * the same frozen namespace under names no file path can produce, so they stay
 * stable across releases exactly as the file components do. */
var CLEANUP_ID = 'cPvxLegacyCleanup';
var CLEANUP_GUID = uuid5(PVX_NAMESPACE, 'pvx:behaviour:legacy-cleanup').toUpperCase();
var MOVE_ID = 'cPvxMoveSiteConfig';
var MOVE_GUID = uuid5(PVX_NAMESPACE, 'pvx:behaviour:move-site-config').toUpperCase();
var REMEMBER_ID = 'cPvxRememberLocation';
var REMEMBER_GUID = uuid5(PVX_NAMESPACE, 'pvx:behaviour:remember-location').toUpperCase();
var REMEMBER_KEY = 'Software\\PVX\\PI Vision Symbols';

/* Where PI Vision is, resolved before AppSearch so the searches below look in
 * the right place. Each rule only fires while PIVISIONPATH is still unset, so
 * the first match wins:
 *
 *   PIVISIONPATH=...                  the whole folder, as in 1.6.0
 *   PIPCFOLDER=E:\Apps\PIPC            a full PIPC path (INSTALLDRIVE ignored)
 *   INSTALLDRIVE=D: PIPCFOLDER=...     either or both; C: and Program Files\PIPC
 *                                     stand in for the one left out
 *   %PIHOME64%                        the PIPC folder the PI installers record —
 *                                     which is where PI really is on a server
 *                                     that put it on another drive
 *   C:\Program Files\PIPC\PIVision     the standard location
 *
 * Ahead of PIHOME64 and the default, though it can only be applied after
 * AppSearch: the folder this product was last installed to, read back from
 * the registry. Windows Installer keeps no memory of a command-line property,
 * so without this an uninstall, a repair, or a silent upgrade to the next
 * version would all resolve PIVISIONPATH from the defaults again — the
 * upgrade laying the library down on C: and removing it from the D: folder PI
 * Vision actually reads. When the remembered folder is used, the searches
 * below looked somewhere else; PVXREMEMBEREDUSED tells their consumers so.
 * (1.6.0 wrote no such value, which is why the 1.6.0 clean-up does not need
 * it: it only ever runs where this install is going.)
 *
 * The same rules run in the UI sequence, so the folder dialog opens on the
 * answer; whatever the dialog leaves in PIVISIONPATH is then passed to the
 * execute sequence (it is Secure), where every rule sees it set and stands
 * aside. INSTALLDRIVE is accepted as D, D: or D:\ because people type all
 * three, and Windows Installer formatting cannot trim a string. */
var LOCATION_RULES = [
    { id: 'PvxLocFromPihome', prop: 'PIVISIONPATH', value: '[%PIHOME64]\\PIVision\\',
      when: 'NOT INSTALLDRIVE AND NOT PIPCFOLDER AND %PIHOME64' },
    { id: 'PvxLocDefault', prop: 'PIVISIONPATH', value: 'C:\\Program Files\\PIPC\\PIVision\\',
      when: 'NOT INSTALLDRIVE AND NOT PIPCFOLDER' },
    { id: 'PvxLocFromFullPipc', prop: 'PIVISIONPATH', value: '[PIPCFOLDER]\\PIVision\\',
      when: 'PIPCFOLDER >< ":"' },
    { id: 'PvxDriveAsRoot', prop: 'PVXDRIVEROOT', value: '[INSTALLDRIVE]',
      when: 'INSTALLDRIVE >> "\\"' },
    { id: 'PvxDriveAsColon', prop: 'PVXDRIVEROOT', value: '[INSTALLDRIVE]\\',
      when: 'INSTALLDRIVE >> ":"' },
    { id: 'PvxDriveAsLetter', prop: 'PVXDRIVEROOT', value: '[INSTALLDRIVE]:\\',
      when: 'INSTALLDRIVE AND NOT PVXDRIVEROOT' },
    { id: 'PvxDriveDefault', prop: 'PVXDRIVEROOT', value: 'C:\\',
      when: 'NOT PVXDRIVEROOT' },
    { id: 'PvxPipcDefault', prop: 'PIPCFOLDER', value: 'Program Files\\PIPC',
      when: 'NOT PIPCFOLDER' },
    { id: 'PvxLocFromParts', prop: 'PIVISIONPATH', value: '[PVXDRIVEROOT][PIPCFOLDER]\\PIVision\\',
      when: '' }
];

/* ------------------------------------------------------------------------ */

function uuid5(namespace, name) {
    var nsHex = namespace.replace(/-/g, '');
    var nsBytes = Buffer.from(nsHex, 'hex');
    var hash = crypto.createHash('sha1')
        .update(nsBytes)
        .update(Buffer.from(name, 'utf8'))
        .digest();
    var b = Buffer.from(hash.slice(0, 16));
    b[6] = (b[6] & 0x0f) | 0x50;   // version 5
    b[8] = (b[8] & 0x3f) | 0x80;   // RFC 4122 variant
    var h = b.toString('hex');
    return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16),
            h.slice(16, 20), h.slice(20)].join('-');
}

function walk(dir, base, out) {
    base = base || dir;
    out = out || [];
    fs.readdirSync(dir).sort().forEach(function (name) {
        var full = path.join(dir, name);
        var st = fs.statSync(full);
        if (st.isDirectory()) { walk(full, base, out); }
        else { out.push(path.relative(base, full).split('/').join('\\')); }
    });
    return out;
}

/* WiX identifiers: letters, digits, underscore and period only, and must not
 * start with a digit. Hash the tail so two different paths cannot collide
 * after sanitising — 'a-b.js' and 'a_b.js' both sanitise to 'a_b.js'. */
function ident(prefix, key) {
    var safe = key.replace(/[^A-Za-z0-9_.]/g, '_');
    if (safe.length > 40) { safe = safe.slice(-40); }
    var tag = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    return prefix + '_' + safe + '_' + tag;
}

function xml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------------ */

function build() {
    if (!fs.existsSync(SRC)) {
        console.error('dist/ext not found — run: node tools/build.js');
        process.exit(1);
    }

    var files = walk(SRC);
    if (!files.length) { console.error('dist/ext is empty.'); process.exit(1); }

    if (files.indexOf(SITE_CONFIG) === -1) {
        // If this file is ever renamed, the NeverOverwrite protection silently
        // stops applying and an upgrade starts destroying site settings. Fail
        // the build rather than ship an installer that quietly does that.
        console.error('Expected ' + SITE_CONFIG + ' in dist/ext — it carries the ' +
                      'site PI Web API settings and must be marked NeverOverwrite. ' +
                      'If it was renamed, update SITE_CONFIG in tools/wix.js.');
        process.exit(1);
    }

    /* --- build the directory tree ---------------------------------------- */
    // Fixed spine down to the PI Vision extensibility folder.
    var spine = ['Scripts', 'app', 'editor', 'symbols', 'ext'];

    // `files` holds Windows-style relative paths because that is what the WiX
    // Source attribute needs. Directory nesting must be computed on POSIX
    // paths — path.dirname does not treat '\' as a separator off Windows, so
    // doing it on the raw string silently flattens every subfolder into the
    // root and the icons end up beside the symbols.
    function posix(rel) { return rel.split('\\').join('/'); }
    function parentOf(rel) {
        var i = posix(rel).lastIndexOf('/');
        return i === -1 ? '' : posix(rel).slice(0, i);
    }
    function baseOf(rel) {
        var p = posix(rel);
        return p.slice(p.lastIndexOf('/') + 1);
    }

    var dirs = {};            // 'libraries' -> { id, name, parent }
    function dirId(rel) {
        if (rel === '') { return 'PVXEXTDIR'; }
        if (!dirs[rel]) {
            var parent = parentOf(rel);
            dirs[rel] = { id: ident('d', rel), name: baseOf(rel), parent: parent };
            if (parent !== '') { dirId(parent); }
        }
        return dirs[rel].id;
    }
    files.forEach(function (f) {
        var d = parentOf(f);
        if (d !== '') { dirId(d); }
    });
    // Folders this version ships nothing into but must still name, so the
    // clean-up can empty and remove them. Emitted as empty Directory rows.
    LEGACY_DIRS.forEach(function (d) { dirId(d); });

    var components = files.map(function (rel) {
        return {
            rel: rel,
            id: ident('c', rel),
            fileId: ident('f', rel),
            guid: uuid5(PVX_NAMESPACE, 'pvx:component:' + rel).toUpperCase(),
            dir: parentOf(rel),
            permanent: (rel === SITE_CONFIG)
        };
    });

    /* --- emit ------------------------------------------------------------- */
    var L = [];
    L.push('<?xml version="1.0" encoding="utf-8"?>');
    L.push('<!-- GENERATED by tools/wix.js — do not edit. Regenerate with: node tools/wix.js');
    L.push('     Compile with PvxFull=1 (the official WiX toolset, the MSI that ships) or');
    L.push('     PvxFull=0 (wixl, structure only: it cannot compile the searches, component');
    L.push('     conditions, file moves and dialogs that the upgrade path depends on). -->');
    L.push('<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">');
    L.push('  <Product Id="*"');
    L.push('           Name="' + xml(PRODUCT_NAME) + '"');
    L.push('           Language="1033"');
    L.push('           Version="' + xml(pkg.version) + '"');
    L.push('           Manufacturer="' + xml(MANUFACTURER) + '"');
    L.push('           UpgradeCode="' + UPGRADE_CODE + '">');
    L.push('');
    // x64, and every component Win64. PI Vision is 64-bit and lives under the
    // real C:\Program Files. A 32-bit package — which 1.6.0 was — has Windows
    // Installer silently redirect any component aimed there to
    // C:\Program Files (x86), so a default install "succeeded" into a folder
    // PI Vision never reads. The AppSearch probes are not redirected, which is
    // why nothing complained: they found the real tree, the files went to the
    // other one. tools/test-installer.ps1 scenario 5 is what caught it.
    L.push('    <Package InstallerVersion="200" Compressed="yes" Platform="x64"');
    L.push('             InstallScope="perMachine" Manufacturer="' + xml(MANUFACTURER) + '"');
    L.push('             Description="' + xml(PRODUCT_NAME + ' ' + pkg.version) + '" />');
    L.push('');
    L.push('    <!-- Removes the previous version before laying down this one. Components');
    L.push('         keep their GUIDs across versions (see tools/wix.js), so the upgrade');
    L.push('         replaces files in place rather than deleting what it just installed. -->');
    L.push('    <MajorUpgrade AllowSameVersionUpgrades="yes"');
    L.push('                  DowngradeErrorMessage="A newer version of ' + xml(PRODUCT_NAME) +
           ' is already installed. Uninstall it first." />');
    L.push('');
    L.push('    <Media Id="1" Cabinet="pvx.cab" EmbedCab="yes" />');
    L.push('');
    emitLocation(L);
    L.push('');
    L.push('    <Property Id="ARPNOREPAIR" Value="0" />');
    L.push('    <Property Id="ARPCOMMENTS" Value="Custom symbol library for AVEVA PI Vision. ' +
           'Site settings live in ext\\libraries\\pvx\\pvx-config.js and are never overwritten." />');
    L.push('');
    L.push('<?if $(var.PvxFull) = 1 ?>');
    emitUpgradeSearches(L);
    L.push('');
    L.push('    <!-- The standard WiX folder dialog, pointed at PIVISIONPATH. Its Change...');
    L.push('         button opens a browser with a drive list, which is the drive and PIPC');
    L.push('         folder selection; the field shows the folder the defaults resolved to. -->');
    L.push('    <Property Id="WIXUI_INSTALLDIR" Value="PIVISIONPATH" />');
    L.push('    <WixVariable Id="WixUILicenseRtf" Value="License.rtf" />');
    L.push('    <UIRef Id="WixUI_InstallDir" />');
    L.push('    <UIRef Id="WixUI_ErrorProgressText" />');
    L.push('<?endif?>');
    L.push('');
    L.push('    <Directory Id="TARGETDIR" Name="SourceDir">');
    L.push('      <Directory Id="PIVISIONPATH">');

    var indent = '        ';
    spine.forEach(function (seg, i) {
        var id = (i === spine.length - 1) ? 'PVXEXTDIR' : 'PVXSPINE' + i;
        L.push(indent + '<Directory Id="' + id + '" Name="' + seg + '">');
        indent += '  ';
    });

    // Sub-directories of ext (icons, pvx, libraries, libraries\pvx), depth-first.
    var relDirs = Object.keys(dirs).sort();
    var byParent = {};
    relDirs.forEach(function (r) {
        var p = dirs[r].parent;
        (byParent[p] = byParent[p] || []).push(r);
    });

    function emitComponents(relDir, pad) {
        components.filter(function (c) { return c.dir === relDir; }).forEach(function (c) {
            var attrs = c.permanent
                ? ' Permanent="yes" NeverOverwrite="yes"'
                : '';
            if (c.permanent) {
                L.push(pad + '<!-- Site PI Web API settings. NeverOverwrite keeps an upgrade from');
                L.push(pad + '     replacing them; Permanent keeps an uninstall from deleting them. -->');
            }
            L.push(pad + '<Component Id="' + c.id + '" Guid="' + c.guid + '" Win64="yes"' + attrs + '>');
            if (c.permanent) {
                // Not installed while a 1.6.0-era copy is being moved into place:
                // the move runs after costing, so a component costed for install
                // would lay the inert default down over the settings just moved.
                L.push('<?if $(var.PvxFull) = 1 ?>');
                L.push(pad + '  <Condition>' + xml('NOT PVXLEGACYCONFIG OR PVXSITECONFIG OR PVXREMEMBEREDUSED') + '</Condition>');
                L.push('<?endif?>');
            }
            // Forward slashes in Source deliberately: Windows accepts them, and
            // it keeps one .wxs valid for both the official WiX toolset on the
            // release runner and `wixl` used to validate the source on Linux.
            L.push(pad + '  <File Id="' + c.fileId + '" KeyPath="yes"');
            L.push(pad + '        Source="$(var.PayloadDir)/' + xml(posix(c.rel)) + '" />');
            L.push(pad + '</Component>');
        });
        if (relDir === '') { emitLegacyCleanup(L, pad); emitRemember(L, pad); }
        if (relDir === SITE_DIR) { emitConfigMove(L, pad); }
    }

    function emitDir(relDir, pad) {
        emitComponents(relDir, pad);
        (byParent[relDir] || []).forEach(function (child) {
            L.push(pad + '<Directory Id="' + dirs[child].id + '" Name="' + xml(dirs[child].name) + '">');
            emitDir(child, pad + '  ');
            L.push(pad + '</Directory>');
        });
    }
    emitDir('', indent);

    spine.forEach(function () {
        indent = indent.slice(2);
        L.push(indent + '</Directory>');
    });
    L.push('      </Directory>');
    L.push('    </Directory>');
    L.push('');
    L.push('    <Feature Id="PvxSymbols" Title="' + xml(PRODUCT_NAME) + '" Level="1"');
    L.push('             Description="All ' + countSymbols(files) + ' symbols, the shared runtime and the connectivity diagnostic." >');
    components.forEach(function (c) {
        L.push('      <ComponentRef Id="' + c.id + '" />');
    });
    L.push('      <ComponentRef Id="' + REMEMBER_ID + '" />');
    L.push('<?if $(var.PvxFull) = 1 ?>');
    L.push('      <ComponentRef Id="' + CLEANUP_ID + '" />');
    L.push('      <ComponentRef Id="' + MOVE_ID + '" />');
    L.push('<?endif?>');
    L.push('    </Feature>');
    L.push('');
    L.push('  </Product>');
    L.push('</Wix>');

    /* --- helpers that need the directory map ------------------------------ */

    function emitLegacyCleanup(L, pad) {
        // Runs inside ext itself. RemoveFiles comes before InstallFiles, and
        // only ever matches PVX's own name prefixes.
        L.push('<?if $(var.PvxFull) = 1 ?>');
        L.push(pad + '<!-- Files earlier versions left where this one does not put them: 1.6.0');
        L.push(pad + '     put the runtime loose in ext\\libraries\\, and 1.7.0 put everything else in');
        L.push(pad + '     ext\\pvx\\, where PI Vision served none of it. An MSI upgrade removes those');
        L.push(pad + '     through the old product, but a server deployed by hand or with the');
        L.push(pad + '     PowerShell script has no old product to remove. This version\'s own');
        L.push(pad + '     ext\\sym-pvx* and icons are removed too and laid down again by');
        L.push(pad + '     InstallFiles, so a symbol dropped from the library cannot linger. The');
        L.push(pad + '     site\'s ext\\libraries\\pvx-config.js is moved, not removed. -->');
        L.push(pad + '<Component Id="' + CLEANUP_ID + '" Guid="' + CLEANUP_GUID + '" Win64="yes">');
        // Keyed to ext itself, which exists wherever this installs. Naming
        // ext\pvx here, as 1.7.0 did, would create the folder being retired.
        L.push(pad + '  <CreateFolder />');
        LEGACY_FILES.forEach(function (lf, i) {
            var dir = lf.dir === '' ? 'PVXEXTDIR' : dirId(lf.dir);
            L.push(pad + '  <RemoveFile Id="PvxLegacy' + i + '" Directory="' + dir + '" Name="' +
                   xml(lf.name) + '" On="install" />');
        });
        LEGACY_DIRS.forEach(function (d, i) {
            L.push(pad + '  <RemoveFolder Id="PvxLegacyDir' + i + '" Directory="' + dirId(d) + '" On="install" />');
        });
        L.push(pad + '</Component>');
        L.push('<?endif?>');
    }

    function emitRemember(L, pad) {
        L.push(pad + '<!-- Read back by PvxFindRemembered: see LOCATION_RULES in tools/wix.js. -->');
        L.push(pad + '<Component Id="' + REMEMBER_ID + '" Guid="' + REMEMBER_GUID + '" Win64="yes">');
        L.push(pad + '  <RegistryValue Root="HKLM" Key="' + xml(REMEMBER_KEY) + '" Name="InstallLocation"');
        L.push(pad + '                 Type="string" Value="[PIVISIONPATH]" KeyPath="yes" />');
        L.push(pad + '</Component>');
    }

    function emitConfigMove(L, pad) {
        L.push('<?if $(var.PvxFull) = 1 ?>');
        L.push(pad + '<!-- Carries a 1.6.0-era ext\\libraries\\pvx-config.js into this folder. Moved,');
        L.push(pad + '     not copied: PI Vision loads every .js under ext\\libraries, so a copy left');
        L.push(pad + '     behind would run too, and whichever loaded last would win. A move on one');
        L.push(pad + '     volume also keeps the file\'s timestamps, which is what tells Windows');
        L.push(pad + '     Installer the site edited it. -->');
        L.push(pad + '<Component Id="' + MOVE_ID + '" Guid="' + MOVE_GUID + '" Win64="yes">');
        L.push(pad + '  <Condition>' + xml('PVXLEGACYCONFIG AND NOT PVXSITECONFIG AND NOT PVXREMEMBEREDUSED') + '</Condition>');
        L.push(pad + '  <CreateFolder />');
        L.push(pad + '  <CopyFile Id="PvxMoveSiteConfig" Delete="yes"');
        L.push(pad + '            SourceDirectory="' + dirId('libraries') + '" SourceName="pvx-config.js"');
        L.push(pad + '            DestinationDirectory="' + dirId(SITE_DIR) + '" DestinationName="pvx-config.js" />');
        L.push(pad + '</Component>');
        L.push('<?endif?>');
    }

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'PvxSymbols.wxs'), L.join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'License.rtf'), licenseRtf());

    fs.writeFileSync(path.join(OUT, 'components.json'), JSON.stringify({
        product: PRODUCT_NAME,
        version: pkg.version,
        upgradeCode: UPGRADE_CODE,
        namespace: PVX_NAMESPACE,
        siteConfig: SITE_CONFIG,
        components: components.map(function (c) {
            return { path: c.rel, guid: c.guid, permanent: c.permanent };
        })
    }, null, 2) + '\n');

    console.log('  wix  PvxSymbols.wxs        ' + files.length + ' files, ' +
                components.length + ' components');
    console.log('  wix  components.json       upgrade code ' + UPGRADE_CODE);
}

/* ------------------------------------------------------------------------ */

function emitLocation(L) {
    L.push('    <!-- Where PI Vision is. Pass any of these on the command line:');
    L.push('           msiexec /i PvxSymbols.msi INSTALLDRIVE=D:');
    L.push('           msiexec /i PvxSymbols.msi INSTALLDRIVE=E: PIPCFOLDER="Apps\\PIPC"');
    L.push('           msiexec /i PvxSymbols.msi PIVISIONPATH="D:\\Program Files\\PIPC\\PIVision"');
    L.push('         With none, PIHOME64 decides, then C:\\Program Files\\PIPC\\PIVision.');
    L.push('         The rules and their order are explained in tools/wix.js. Secure="yes"');
    L.push('         is what lets a command-line value survive elevation. -->');
    L.push('    <Property Id="PIVISIONPATH" Secure="yes" />');
    L.push('    <Property Id="INSTALLDRIVE" Secure="yes" />');
    L.push('    <Property Id="PIPCFOLDER" Secure="yes" />');
    L.push('    <Property Id="PVXREMEMBERED">');
    L.push('      <RegistrySearch Id="PvxFindRemembered" Root="HKLM" Key="' + xml(REMEMBER_KEY) + '"');
    L.push('                      Name="InstallLocation" Type="raw" Win64="yes" />');
    L.push('    </Property>');
    L.push('    <CustomAction Id="PvxNoteExplicit" Property="PVXEXPLICIT" Value="1" />');
    L.push('    <CustomAction Id="PvxUseRemembered" Property="PIVISIONPATH" Value="[PVXREMEMBERED]" />');
    L.push('    <CustomAction Id="PvxNoteRemembered" Property="PVXREMEMBEREDUSED" Value="1" />');
    LOCATION_RULES.forEach(function (r) {
        L.push('    <CustomAction Id="' + r.id + '" Property="' + r.prop + '" Value="' + xml(r.value) + '" />');
    });
    // Shown in Programs and Features, so an administrator can see which of a
    // server's drives this copy went to without opening a log.
    L.push('    <CustomAction Id="PvxArpLocation" Property="ARPINSTALLLOCATION" Value="[PIVISIONPATH]" />');
    // Explicit numbers, not Before/After chains: the rules must run in exactly
    // this order, between FindRelatedProducts (25) and AppSearch (50), and
    // wixl and the WiX toolset do not resolve relative chains identically.
    ['InstallUISequence', 'InstallExecuteSequence'].forEach(function (seq) {
        L.push('    <' + seq + '>');
        L.push('      <Custom Action="PvxNoteExplicit" Sequence="29">' +
               xml('PIVISIONPATH OR INSTALLDRIVE OR PIPCFOLDER') + '</Custom>');
        LOCATION_RULES.forEach(function (r, i) {
            var cond = 'NOT PIVISIONPATH' + (r.when ? ' AND (' + r.when + ')' : '');
            L.push('      <Custom Action="' + r.id + '" Sequence="' + (30 + i) + '">' + xml(cond) + '</Custom>');
        });
        L.push('      <Custom Action="PvxUseRemembered" Sequence="51">' +
               xml('PVXREMEMBERED AND NOT PVXEXPLICIT') + '</Custom>');
        L.push('      <Custom Action="PvxNoteRemembered" Sequence="52">' +
               xml('PVXREMEMBERED AND NOT PVXEXPLICIT') + '</Custom>');
        if (seq === 'InstallExecuteSequence') {
            L.push('      <Custom Action="PvxArpLocation" After="CostFinalize" />');
            // Not on uninstall or repair (Installed): the library is already
            // there, and PI Vision may legitimately be gone first.
            L.push('<?if $(var.PvxFull) = 1 ?>');
            L.push('      <Custom Action="PvxNoPIVision" Sequence="53">' +
                   xml('NOT PVXSYMBOLSDIR AND NOT REMOVE AND NOT Installed AND NOT PVXREMEMBEREDUSED') +
                   '</Custom>');
            L.push('<?endif?>');
        }
        L.push('    </' + seq + '>');
    });
}

function emitUpgradeSearches(L) {
    var ext = '[PIVISIONPATH]\\Scripts\\app\\editor\\symbols';
    L.push('    <!-- AppSearch runs after the location rules, so these look where this');
    L.push('         install is going. The backslash after [PIVISIONPATH] doubles up when');
    L.push('         the value already ends in one, which Windows tolerates; leaving it out');
    L.push('         would break a value typed without the trailing backslash. -->');
    L.push('    <Property Id="PVXSYMBOLSDIR">');
    L.push('      <DirectorySearch Id="PvxFindSymbols" Path="' + xml(ext) + '"');
    L.push('                       Depth="0" AssignToProperty="yes" />');
    L.push('    </Property>');
    L.push('    <Property Id="PVXLEGACYCONFIG">');
    L.push('      <DirectorySearch Id="PvxFindLegacyLib" Path="' +
           xml(ext + '\\ext\\libraries') + '" Depth="0">');
    L.push('        <FileSearch Id="PvxFindLegacyConfig" Name="pvx-config.js" />');
    L.push('      </DirectorySearch>');
    L.push('    </Property>');
    L.push('    <Property Id="PVXSITECONFIG">');
    L.push('      <DirectorySearch Id="PvxFindSiteLib" Path="' +
           xml(ext + '\\ext\\libraries\\pvx') + '" Depth="0">');
    L.push('        <FileSearch Id="PvxFindSiteConfig" Name="pvx-config.js" />');
    L.push('      </DirectorySearch>');
    L.push('    </Property>');
    L.push('');
    L.push('    <!-- A mistyped drive must fail, not install a library into a tree PI');
    L.push('         Vision does not serve. The deploy script makes the same check. -->');
    L.push('    <CustomAction Id="PvxNoPIVision" Error="PI Vision was not found at [PIVISIONPATH]: its ' +
           'Scripts\\app\\editor\\symbols folder does not exist. Choose the folder PI Vision is ' +
           'installed in, or pass INSTALLDRIVE and PIPCFOLDER, or PIVISIONPATH, on the command line." />');
}

/* The WiX folder dialog sequence includes a licence page and needs RTF for it.
 * Generated from LICENSE so the two cannot disagree. */
function licenseRtf() {
    var text = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8').replace(/\r\n/g, '\n');
    var body = text.split('\n\n').map(function (para) {
        return para.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
            .replace(/[^\x20-\x7e\n]/g, function (ch) { return '\\u' + ch.charCodeAt(0) + '?'; })
            .replace(/\n/g, ' ');
    }).join('\\par\\par\n');
    return '{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Segoe UI;}}\\fs18\n' + body + '\\par\n}\n';
}

function countSymbols(files) {
    var seen = {};
    files.forEach(function (f) {
        var m = /^sym-(\w+)\./.exec(f);
        if (m) { seen[m[1]] = 1; }
    });
    return Object.keys(seen).length;
}

build();
