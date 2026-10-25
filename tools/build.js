#!/usr/bin/env node
/* ============================================================================
 * PVX build — assembles src/ into a deployable PI Vision `ext` folder.
 * ----------------------------------------------------------------------------
 *   node tools/build.js            build + validate
 *   node tools/build.js --package  also produce dist/pvx-symbols-<ver>.zip
 *   node tools/build.js --watch    rebuild on change (development)
 *   node tools/build.js --clean    remove dist/ first
 *
 * Zero npm dependencies on purpose: this has to run on a locked-down
 * engineering workstation with nothing but Node installed.
 * ==========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const SYMBOLS_DIR = path.join(SRC, 'symbols');
const SHARED_DIR = path.join(SRC, 'shared');
const DIST = path.join(ROOT, 'dist');
const EXT = path.join(DIST, 'ext');

/* dist/ext mirrors the server's ext folder exactly, so every tool that reads it
 * (the MSI generator, the zip, the deploy script, the harnesses) sees the same
 * layout a PI Vision server does.
 *
 *   ext\                  sym-pvx*.js, .css, -template.html, -config.html,
 *                         and piwebapi-check.html
 *   ext\icons\            palette icons, pvx*.svg
 *   ext\libraries\pvx\    the shared runtime and the site's settings
 *
 * This is the layout AVEVA's extensibility guide describes, and the only one
 * proven on a live server. 1.7.0 moved everything but the runtime into
 * ext\pvx\ to keep out of the folders other symbol packs share, and nothing
 * there worked: the scripts did not load, and once they were moved up, the
 * icons and templates still did not, though every URL pointed at them
 * explicitly. Do not move files into a subfolder of ext again without
 * proving it on a server first.
 *
 * The runtime is the exception, under ext\libraries\pvx: libraries is the only
 * folder PI Vision documents as loading BEFORE the symbols, and its guide
 * explicitly allows subfolders of it. */
const ICON_DIR = path.join(EXT, 'icons');
const LIB_DIR = path.join(EXT, 'libraries', 'pvx');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;

const args = process.argv.slice(2);
const FLAG = (f) => args.indexOf(f) !== -1;

/* ---------------------------------------------------------------- helpers */

const C = {
    reset: '\x1b[0m', dim: '\x1b[2m', red: '\x1b[31m',
    green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m'
};
const say = (msg) => process.stdout.write(msg + '\n');
const ok = (msg) => say(C.green + '  ok  ' + C.reset + msg);
const warn = (msg) => say(C.yellow + ' warn ' + C.reset + msg);
const fail = (msg) => say(C.red + ' FAIL ' + C.reset + msg);

function rmrf(p) {
    if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); }
}
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, s) { mkdirp(path.dirname(p)); fs.writeFileSync(p, s, 'utf8'); }

/* ----------------------------------------------------------- validation */

const problems = [];
const warnings = [];

function problem(sym, msg) { problems.push(sym + ': ' + msg); }
function warning(sym, msg) { warnings.push(sym + ': ' + msg); }

/**
 * Catch the ES6+ constructs that would break inside PI Vision's AngularJS host
 * on older supported browsers. Strings and comments are stripped first so a
 * documentation example never trips the check.
 *
 * KNOWN LIMITATION: this does not understand regular-expression literals. A
 * regex containing a quote (/['"]/) reads as the start of a string and can
 * swallow the code after it until the next matching quote — which means checks
 * can silently pass over a region rather than failing on it. That is a
 * false-negative risk, never a false positive, so it will not block a good
 * build; but do not trust a clean result as proof that a file was fully
 * scanned. The rendering gate in tools/verify.js is the real safety net.
 */
function stripStringsAndComments(js) {
    let out = '';
    let i = 0;
    const n = js.length;
    let state = 'code';
    let quote = '';
    while (i < n) {
        const c = js[i];
        const c2 = js[i + 1];
        if (state === 'code') {
            if (c === '/' && c2 === '/') { state = 'line'; i += 2; continue; }
            if (c === '/' && c2 === '*') { state = 'block'; i += 2; continue; }
            if (c === '"' || c === "'" || c === '`') { state = 'str'; quote = c; out += ' '; i++; continue; }
            out += c; i++; continue;
        }
        if (state === 'line') {
            if (c === '\n') { state = 'code'; out += '\n'; }
            i++; continue;
        }
        if (state === 'block') {
            if (c === '*' && c2 === '/') { state = 'code'; i += 2; continue; }
            if (c === '\n') { out += '\n'; }
            i++; continue;
        }
        if (state === 'str') {
            if (c === '\\') { i += 2; continue; }
            if (c === quote) { state = 'code'; }
            i++; continue;
        }
    }
    return out;
}

const ES6_PATTERNS = [
    [/=>/, 'arrow function'],
    [/\blet\s+[A-Za-z_$]/, 'let declaration'],
    [/\bconst\s+[A-Za-z_$]/, 'const declaration'],
    [/\bclass\s+[A-Za-z_$]/, 'class declaration'],
    [/\.\.\./, 'spread/rest'],
    [/\?\./, 'optional chaining'],
    [/\?\?/, 'nullish coalescing'],
    [/\bfor\s*\([^)]*\bof\b/, 'for...of'],
    [/`/, 'template literal']
];

/**
 * @param {String} typeName
 * @param {String} js
 * @param {Object} opts {isLibrary} — a library is not a symbol: it has no
 *        typeName, does not register itself, and pvx-core is the ONE file
 *        permitted to call PV.symbolCatalog.register, because it is the wrapper
 *        every symbol is required to use instead.
 */
/**
 * Raw control characters in a source file are legal JavaScript and completely
 * invisible in an editor, but they make the file register as binary: grep skips
 * it, git stops treating it as text, and a text-mode file transfer to the PI
 * Vision server can mangle it in flight. A NUL used as a cache-key separator
 * shipped this way once; it is cheaper to fail the build than to find it again.
 *
 * Tab, LF and CR are fine. Everything else below 0x20 is not.
 */
function validateNoControlChars(name, text) {
    for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 32 && c !== 9 && c !== 10 && c !== 13) {
            const line = text.slice(0, i).split('\n').length;
            problem(name, 'raw control character U+' +
                c.toString(16).toUpperCase().padStart(4, '0') +
                ' at line ' + line + ' — use the \\uXXXX escape instead of the literal byte');
            return;
        }
    }
}

function validateSymbolJs(typeName, js, opts) {
    opts = opts || {};
    const bare = stripStringsAndComments(js);

    validateNoControlChars(typeName, js);

    ES6_PATTERNS.forEach(([re, label]) => {
        const m = re.exec(bare);
        if (m) {
            const line = bare.slice(0, m.index).split('\n').length;
            problem(typeName, 'ES6 construct "' + label + '" at line ' + line + ' (PI Vision symbols must be ES5)');
        }
    });

    if (!opts.isLibrary) {
        // String literals are gone from `bare`, so this runs against the raw source.
        if (!new RegExp("typeName\\s*:\\s*['\"]" + typeName + "['\"]").test(js)) {
            problem(typeName, 'typeName in symbol.js does not match the folder name');
        }
        if (bare.indexOf('PVX.register(') === -1) {
            problem(typeName, 'must register via window.PVX.register(PV, definition)');
        }
        if (/PV\.symbolCatalog\.register/.test(bare)) {
            problem(typeName, 'calls PV.symbolCatalog.register directly; use window.PVX.register instead');
        }
        // PI Vision leaves None symbols (and ones that omit the key, which
        // defaults to None) out of the symbol selector: they cannot be placed.
        // Seven shipped that way and were invisible on the first live server.
        const behavior = /datasourceBehavior\s*:\s*[\w.]*DatasourceBehaviors\.(\w+)/.exec(bare);
        if (!behavior || behavior[1] === 'None') {
            problem(typeName, 'datasourceBehavior is None or missing, so PI Vision hides the symbol ' +
                'from the palette; use Single with DataShape \'Value\' and ignore the data');
        }
        if (bare.indexOf('PVX.bootstrap(') === -1) {
            warning(typeName, 'does not use PVX.bootstrap — lifecycle wiring may be inconsistent');
        }
    }
    if (/\$\(\s*['"]/.test(bare) || /\bjQuery\b/.test(bare)) {
        warning(typeName, 'appears to use jQuery; the library is meant to be dependency-free');
    }
    if (/\bconsole\.log\(/.test(bare)) {
        warning(typeName, 'contains console.log — noisy on a live display');
    }

    // Node can parse ES5 as a script; this catches genuine syntax errors.
    try {
        new (require('vm').Script)(js, { filename: typeName + '/symbol.js' });
    } catch (e) {
        problem(typeName, 'syntax error — ' + e.message);
    }
}

function validateCss(typeName, css) {
    // Symbol CSS must stay inside its own namespace or it will bleed into the
    // PI Vision chrome (which loads its stylesheet after ours).
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = rules.match(/(^|\})\s*([^{@}]+)\{/g) || [];
    selectors.forEach((raw) => {
        const sel = raw.replace(/^[}\s]*/, '').replace(/\{$/, '').trim();
        if (!sel || sel.startsWith('@') || sel.startsWith('from') || sel.startsWith('to') || /^\d+%/.test(sel)) { return; }
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        parts.forEach((p) => {
            if (!/(^|\s|>)\.pvx/.test(p) && !/^:root/.test(p)) {
                warning(typeName, 'CSS selector is not namespaced under .pvx — "' + p + '"');
            }
        });
    });
}

function validateTemplate(typeName, html) {
    if (!/class\s*=\s*["'][^"']*\bpvx\b/.test(html)) {
        warning(typeName, 'template root does not carry the shared "pvx" class');
    }
    // A quick unbalanced-tag check catches the most common copy/paste error.
    const opens = (html.match(/<div\b/g) || []).length;
    const closes = (html.match(/<\/div>/g) || []).length;
    if (opens !== closes) {
        problem(typeName, 'template has ' + opens + ' <div> and ' + closes + ' </div> — unbalanced');
    }
}

function validateIcon(typeName, svg) {
    if (!/<svg[\s\S]*?viewBox\s*=\s*["'][^"']+["']/.test(svg)) {
        problem(typeName, 'icon.svg has no viewBox — PI Vision will not scale it in the picker');
    }
    if (/<script/i.test(svg)) {
        problem(typeName, 'icon.svg contains a <script> tag');
    }
}

/* --------------------------------------------------------------- the build */

function discoverSymbols() {
    return fs.readdirSync(SYMBOLS_DIR)
        .filter((d) => fs.statSync(path.join(SYMBOLS_DIR, d)).isDirectory())
        .sort();
}

const REQUIRED = ['symbol.js', 'template.html', 'config.html', 'styles.css', 'icon.svg'];

function build() {
    const started = Date.now();
    if (FLAG('--clean')) { rmrf(DIST); }
    mkdirp(EXT);
    mkdirp(ICON_DIR);
    mkdirp(LIB_DIR);

    problems.length = 0;
    warnings.length = 0;

    say('');
    say(C.bold + 'PVX symbol library ' + VERSION + C.reset);
    say(C.dim + 'src -> dist/ext' + C.reset);
    say('');

    // --- shared runtime ---------------------------------------------------
    const core = read(path.join(SHARED_DIR, 'pvx-core.js'));
    validateSymbolJs('pvx-core', core, { isLibrary: true });

    write(path.join(LIB_DIR, 'pvx-core.js'), banner('PVX Core runtime') + core);
    ok('libraries/pvx/pvx-core.js  ' + kb(core));

    // Per-site deployment settings. Emitted with an inert default so a fresh
    // build is safe to deploy, and explicitly NOT stamped with the generated-file
    // banner — this is the one file a site is meant to edit, and the deploy
    // script preserves an existing copy on the server rather than clobbering it.
    const siteConfig = read(path.join(SHARED_DIR, 'pvx-config.js'));
    validateSymbolJs('pvx-config', siteConfig, { isLibrary: true });
    write(path.join(LIB_DIR, 'pvx-config.js'), siteConfig);
    ok('libraries/pvx/pvx-config.js  ' + C.dim + 'site settings — preserved on redeploy' + C.reset);

    // The connectivity diagnostic ships INSIDE the ext folder on purpose: it has
    // to be served from the PI Vision origin to reproduce the conditions a real
    // symbol faces. Opened from a file:// path or another host it would test
    // something else entirely and give a confidently wrong answer.
    const checkPage = path.join(SRC, 'tools', 'piwebapi-check.html');
    if (fs.existsSync(checkPage)) {
        write(path.join(EXT, 'piwebapi-check.html'), read(checkPage));
        ok('piwebapi-check.html  ' + C.dim + 'PI Web API diagnostic' + C.reset);
    }

    const baseCss = read(path.join(SHARED_DIR, 'base.css'));
    const sourcesPane = read(path.join(SHARED_DIR, 'config-sources.html'));
    const bandsEditor = read(path.join(SHARED_DIR, 'config-bands.html'));

    // --- symbols ----------------------------------------------------------
    const symbols = discoverSymbols();
    const manifest = [];

    symbols.forEach((typeName) => {
        const dir = path.join(SYMBOLS_DIR, typeName);
        const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(dir, f)));
        if (missing.length) {
            problem(typeName, 'missing file(s): ' + missing.join(', '));
            return;
        }

        const js = read(path.join(dir, 'symbol.js'));
        const template = read(path.join(dir, 'template.html'));
        const config = read(path.join(dir, 'config.html'));
        const css = read(path.join(dir, 'styles.css'));
        const icon = read(path.join(dir, 'icon.svg'));

        validateSymbolJs(typeName, js);
        validateTemplate(typeName, template);
        validateCss(typeName, css);
        validateIcon(typeName, icon);

        write(path.join(EXT, 'sym-' + typeName + '.js'), banner(typeName) + js);
        write(path.join(EXT, 'sym-' + typeName + '-template.html'), template);
        write(path.join(EXT, 'sym-' + typeName + '-config.html'), 
            withBandsEditor(typeName, withSourcesPane(typeName, config, sourcesPane), bandsEditor));
        // Shared base styles are prepended to every symbol stylesheet. PI Vision
        // loads a symbol's CSS by the sym-<name>.css naming convention only, so
        // there is nowhere else to put them; the duplication is a few KB and
        // keeps each symbol self-contained.
        write(path.join(EXT, 'sym-' + typeName + '.css'),
            banner(typeName + ' styles') + baseCss + '\n\n' + css);
        write(path.join(ICON_DIR, typeName + '.svg'), icon);

        const displayName = (/displayName:\s*['"]([^'"]+)['"]/.exec(js) || [])[1] || typeName;
        const shape = (/DataShape:\s*['"]([^'"]+)['"]/.exec(js) || [])[1] || 'None';
        const behavior = (/DatasourceBehaviors\.(\w+)/.exec(js) || [])[1] || 'None';
        // Optional `@mock digital` in the file header tells the preview harness
        // and the verifier to feed this symbol digital-state transitions instead
        // of a numeric signal. Without it, a time-in-state symbol would be
        // "verified" against data it can never receive in the field.
        const mockProfile = (/@mock\s+(\w+)/.exec(js) || [])[1] || 'numeric';

        manifest.push({ typeName, displayName, dataShape: shape, datasourceBehavior: behavior, mockProfile });
        ok('sym-' + typeName + '.*'.padEnd(Math.max(1, 26 - typeName.length)) + C.dim + displayName + C.reset);
    });

    // --- manifest ---------------------------------------------------------
    write(path.join(DIST, 'manifest.json'), JSON.stringify({
        name: pkg.name,
        version: VERSION,
        builtOn: new Date().toISOString(),
        extPath: 'Scripts/app/editor/symbols/ext',
        // Where inside extPath each kind of file lands. Tools read these rather
        // than hard-coding the layout a second time.
        layout: { symbols: '', icons: 'icons', libraries: 'libraries/pvx' },
        symbols: manifest
    }, null, 2));

    // --- deploy script ----------------------------------------------------
    write(path.join(DIST, 'Deploy-PvxSymbols.ps1'), deployScript());

    // --- report -----------------------------------------------------------
    say('');
    warnings.forEach((w) => warn(w));
    problems.forEach((p) => fail(p));
    say('');
    const files = countFiles(EXT);
    say(C.bold + symbols.length + ' symbols' + C.reset + C.dim +
        ' · ' + files + ' files · ' + (Date.now() - started) + 'ms' + C.reset);

    if (problems.length) {
        say(C.red + C.bold + problems.length + ' error(s) — not safe to deploy' + C.reset);
        return false;
    }
    say(C.green + C.bold + 'Build clean' + C.reset +
        (warnings.length ? C.dim + ' (' + warnings.length + ' warning(s))' + C.reset : ''));
    return true;
}

/* Every format pane opens with the shared "Data sources" list, so removing a
   wrong attribute works the same way on all symbols. Injected here rather than
   copied into 33 files that would drift. A pane without the expected root is
   an error, not a skip: that symbol would silently ship without the list. */
const PANE_ROOT = /^\s*<div class="c-config-content pvx-cfg[^"]*">\s*\n/;

function withSourcesPane(typeName, config, pane) {
    const m = PANE_ROOT.exec(config);
    if (!m) {
        problem(typeName, 'config.html must start with <div class="c-config-content pvx-cfg"> on its own line, ' +
            'so the shared Data sources list can be injected');
        return config;
    }
    return m[0] + pane + config.slice(m[0].length);
}

// Threshold bands are edited as rows (limit, colour, label), not by typing
// the grammar. A pane asks for that editor with the marker below, where the
// control would go; a pane that binds config.Thresholds to a control of its
// own is refused, so no symbol quietly keeps the old text box.
const BANDS_MARKER = /^[ \t]*<!-- pvx:bands -->[ \t]*\n/m;

function withBandsEditor(typeName, config, editor) {
    if (/ng-model="config\.Thresholds"/.test(config.replace(BANDS_MARKER, ''))) {
        problem(typeName, 'config.html binds config.Thresholds itself; put <!-- pvx:bands --> on its own line ' +
            'where the control goes and the build injects the shared band editor');
        return config;
    }
    return config.replace(BANDS_MARKER, () => editor);
}

function banner(what) {
    return '/* ' + pkg.name + ' v' + VERSION + ' — ' + what + '\n' +
           '   Generated by tools/build.js. Edit the sources under src/, not this file. */\n';
}

function kb(s) { return C.dim + (Buffer.byteLength(s) / 1024).toFixed(1) + ' KB' + C.reset; }

function countFiles(dir) {
    let n = 0;
    fs.readdirSync(dir).forEach((f) => {
        const p = path.join(dir, f);
        n += fs.statSync(p).isDirectory() ? countFiles(p) : 1;
    });
    return n;
}

/* --------------------------------------------------------------- packaging */

const ZIP_ENTRIES = ['ext', 'manifest.json', 'Deploy-PvxSymbols.ps1'];

/* `zip` is not on Windows and `Compress-Archive` is not on Linux, so try both
   and start with the one native to the platform. The release job builds the
   MSI on a Windows runner, which is exactly where the old `zip`-only version
   found nothing. */
function zipViaZipCommand(zipPath) {
    execFileSync('zip', ['-r', '-q', zipPath].concat(ZIP_ENTRIES),
                 { cwd: DIST, stdio: 'pipe' });
}

function zipViaPowerShell(zipPath) {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        'Compress-Archive -Path ' + ZIP_ENTRIES.join(',') +
        ' -DestinationPath "' + zipPath + '" -Force'],
        { cwd: DIST, stdio: 'pipe' });
}

/**
 * Produce dist/pvx-symbols-<version>.zip.
 *
 * Failing to build it is an error, not a warning. This used to warn and return
 * false, which left the build green: `--package` succeeded while producing no
 * package. The release workflow then copied the zip with a wildcard, and a
 * wildcard matching nothing is silent in PowerShell even under
 * ErrorActionPreference = Stop, so v1.5.0 published without the zip while
 * RELEASING.md and the release notes both told sites to use it. Those are the
 * sites that cannot run an MSI yet, so the missing file was the one thing they
 * needed.
 */
function packageZip() {
    const zipName = 'pvx-symbols-' + VERSION + '.zip';
    const zipPath = path.join(DIST, zipName);
    rmrf(zipPath);

    const attempts = process.platform === 'win32'
        ? [zipViaPowerShell, zipViaZipCommand]
        : [zipViaZipCommand, zipViaPowerShell];
    const tried = [];

    for (let i = 0; i < attempts.length; i++) {
        try {
            attempts[i](zipPath);
            if (fs.existsSync(zipPath)) {
                ok('packaged ' + zipName + ' ' + kb(fs.readFileSync(zipPath)));
                return true;
            }
            tried.push(attempts[i].name + ' wrote no file');
        } catch (e) {
            tried.push(attempts[i].name + ': ' +
                       String(e.message).split('\n')[0].trim());
        }
    }

    fail('could not create ' + zipName + ' (' + tried.join('; ') + '). ' +
         'Install `zip`, or build where PowerShell Compress-Archive exists.');
    return false;
}

/* ------------------------------------------------------------------ deploy */

/* The deploy script lives as a real .ps1 under src/tools rather than as a
   string in this file: it is now long enough to need reviewing as PowerShell,
   and a template literal doubles every backslash in a language made of them.
   It must stay ASCII — Windows PowerShell 5.1 reads a BOM-less script as the
   ANSI code page, so one em dash in a message turns into mojibake or a parse
   error on exactly the servers that cannot run the MSI. */
function deployScript() {
    const ps = read(path.join(SRC, 'tools', 'Deploy-PvxSymbols.ps1'));
    for (let i = 0; i < ps.length; i++) {
        if (ps.charCodeAt(i) > 0x7e) {
            const line = ps.slice(0, i).split('\n').length;
            problem('Deploy-PvxSymbols.ps1', 'non-ASCII character on line ' + line +
                    ' — Windows PowerShell 5.1 misreads it. Use plain ASCII.');
            break;
        }
    }
    return ps;
}

/* --------------------------------------------------------------------- run */

function main() {
    const clean = build();
    /* A failed --package fails the build. It is an explicit request for an
       artifact, and a green build that quietly produced nothing is how the
       zip went missing from the v1.5.0 release. */
    const packaged = clean && FLAG('--package') ? packageZip() : true;

    if (FLAG('--watch')) {
        say(C.dim + '\nwatching src/ — Ctrl+C to stop' + C.reset);
        let timer = null;
        fs.watch(SRC, { recursive: true }, () => {
            if (timer) { clearTimeout(timer); }
            timer = setTimeout(() => { build(); }, 120);
        });
        return;
    }
    process.exit(clean && packaged ? 0 : 1);
}

main();
