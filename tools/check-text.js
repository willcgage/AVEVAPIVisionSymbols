/* ============================================================================
 * tools/check-text.js — no raw control characters anywhere in the repo
 * ----------------------------------------------------------------------------
 *   node tools/check-text.js
 *
 * The build validator catches these in symbol sources. This catches them
 * everywhere else — docs, workflows, tooling — because the failure has nothing
 * to do with JavaScript.
 *
 * A raw control byte is invisible in an editor and legal in most formats, but
 * it makes the file register as binary: grep skips it, git stops treating it as
 * text and will not diff it, and a text-mode file transfer to a Windows server
 * can mangle it in flight. A NUL used as a cache-key separator reached a
 * shipped file this way, and then reached two documents *describing* the
 * problem, which is roughly the point at which a manual check stops being good
 * enough.
 *
 * Tab (0x09), LF (0x0A) and CR (0x0D) are fine. Everything else below 0x20 is
 * not, and neither is DEL (0x7F).
 * ==========================================================================*/
'use strict';

var fs = require('fs');
var path = require('path');
var cp = require('child_process');

var ROOT = path.join(__dirname, '..');
var C = { red: '\u001b[31m', green: '\u001b[32m', dim: '\u001b[2m', bold: '\u001b[1m', reset: '\u001b[0m' };

// Binary by intent. Everything else tracked in git is expected to be text.
var BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|eot|zip|msi|cab|pdf)$/i;

function tracked() {
    try {
        return cp.execSync('git ls-files -z', { cwd: ROOT, encoding: 'buffer' })
            .toString('utf8').split('\u0000').filter(Boolean);
    } catch (e) {
        console.error('Not a git repository, or git is unavailable.');
        process.exit(1);
    }
}

function main() {
    var bad = [];
    var scanned = 0;

    tracked().forEach(function (rel) {
        if (BINARY.test(rel)) { return; }
        var full = path.join(ROOT, rel);
        var buf;
        try { buf = fs.readFileSync(full); } catch (e) { return; }
        scanned++;

        for (var i = 0; i < buf.length; i++) {
            var b = buf[i];
            if ((b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127) {
                var line = buf.slice(0, i).toString('utf8').split('\n').length;
                bad.push({
                    file: rel,
                    line: line,
                    code: 'U+' + ('000' + b.toString(16).toUpperCase()).slice(-4)
                });
                break;      // one report per file is enough to act on
            }
        }
    });

    // A check that passes because it examined nothing is worse than one that
    // fails: it reports green and teaches you to trust it. `git ls-files` is
    // empty in a fresh working tree with no commits and nothing staged, which
    // is exactly when someone is most likely to run this.
    if (scanned === 0) {
        console.log('\n  ' + C.red + 'FAIL' + C.reset +
            ' no files to check — git ls-files returned nothing.');
        console.log('  ' + C.dim + 'Stage or commit the tree first; an empty scan is not a pass.' +
            C.reset + '\n');
        process.exit(1);
    }

    if (bad.length) {
        console.log('');
        bad.forEach(function (b) {
            console.log('  ' + C.red + 'FAIL' + C.reset + ' ' + b.file + ':' + b.line +
                '  raw control character ' + b.code);
        });
        console.log('\n  ' + C.dim + 'Write the \\uXXXX escape sequence instead of the ' +
            'literal byte.' + C.reset);
        console.log(C.red + C.bold + '\n' + bad.length + ' file(s) contain raw control characters' +
            C.reset + '\n');
        process.exit(1);
    }

    console.log('  ' + C.green + 'ok  ' + C.reset + scanned +
        ' text files, no raw control characters');
}

main();
