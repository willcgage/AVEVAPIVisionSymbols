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
var SITE_CONFIG = 'libraries\\pvx-config.js';

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
    L.push('<!-- GENERATED by tools/wix.js — do not edit. Regenerate with: node tools/wix.js -->');
    L.push('<Wix xmlns="http://schemas.microsoft.com/wix/2006/wi">');
    L.push('  <Product Id="*"');
    L.push('           Name="' + xml(PRODUCT_NAME) + '"');
    L.push('           Language="1033"');
    L.push('           Version="' + xml(pkg.version) + '"');
    L.push('           Manufacturer="' + xml(MANUFACTURER) + '"');
    L.push('           UpgradeCode="' + UPGRADE_CODE + '">');
    L.push('');
    L.push('    <Package InstallerVersion="200" Compressed="yes"');
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
    L.push('    <!-- Override on the command line:');
    L.push('           msiexec /i PvxSymbols.msi PIVISIONPATH="D:\\Program Files\\PIPC\\PIVision"');
    L.push('         Secure="yes" is what allows that to survive elevation. -->');
    L.push('    <Property Id="PIVISIONPATH" Secure="yes" Value="C:\\Program Files\\PIPC\\PIVision" />');
    L.push('');
    L.push('    <Property Id="ARPNOREPAIR" Value="0" />');
    L.push('    <Property Id="ARPCOMMENTS" Value="Custom symbol library for AVEVA PI Vision. ' +
           'Site settings live in libraries\\pvx-config.js and are never overwritten." />');
    L.push('');
    L.push('    <Directory Id="TARGETDIR" Name="SourceDir">');
    L.push('      <Directory Id="PIVISIONPATH">');

    var indent = '        ';
    spine.forEach(function (seg, i) {
        var id = (i === spine.length - 1) ? 'PVXEXTDIR' : 'PVXSPINE' + i;
        L.push(indent + '<Directory Id="' + id + '" Name="' + seg + '">');
        indent += '  ';
    });

    // Sub-directories of ext (icons, libraries), depth-first.
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
            L.push(pad + '<Component Id="' + c.id + '" Guid="' + c.guid + '"' + attrs + '>');
            // Forward slashes in Source deliberately: Windows accepts them, and
            // it keeps one .wxs valid for both the official WiX toolset on the
            // release runner and `wixl` used to validate the source on Linux.
            L.push(pad + '  <File Id="' + c.fileId + '" KeyPath="yes"');
            L.push(pad + '        Source="$(var.PayloadDir)/' + xml(posix(c.rel)) + '" />');
            L.push(pad + '</Component>');
        });
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
    L.push('    </Feature>');
    L.push('');
    L.push('  </Product>');
    L.push('</Wix>');

    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'PvxSymbols.wxs'), L.join('\n') + '\n');

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

function countSymbols(files) {
    var seen = {};
    files.forEach(function (f) {
        var m = /^sym-(\w+)\./.exec(f);
        if (m) { seen[m[1]] = 1; }
    });
    return Object.keys(seen).length;
}

build();
