# Working on PVX

Repository: <https://github.com/willcgage/AVEVAPIVisionSymbols>

## Setup

```bash
git clone https://github.com/willcgage/AVEVAPIVisionSymbols.git
cd AVEVAPIVisionSymbols
npm ci                                   # only needed for verify/probe/test:api
npx playwright install chromium
npm run preview                          # http://localhost:8777
```

`npm ci`, not `npm install` — it installs exactly what the lockfile pins and
fails if the lockfile and `package.json` have drifted.

If you only need to build, skip both installs. `node tools/build.js` and
`node tools/wix.js` run on a bare Node ≥ 14 with no packages at all, and that
stays true because CI's installer job runs without `npm ci` and would fail if
a dependency crept into the build path.

## The inner loop

Do not run the full verify while iterating — it renders 51 symbols 18 ways and
takes a while. Use the probe:

```bash
node tools/probe.js pvxHistogram --w 900 --h 480 --config "LSL=100;USL=140"
node tools/probe.js pvxComboChart --dark --config "TraceSpec=1:bar,2:line:right"
node tools/probe.js pvxSlideshow --hash "/Displays/101/Overview"
```

It renders straight from `src/`, so there is no build round-trip, and picks its
own port so several can run at once. Config pairs are separated by `;` because
values contain commas.

## Before opening a pull request

```bash
npm run verify        # 918 render checks — the gate
npm run test:api      # PI Web API layer against six misconfigured mocks
node tools/docgen.js  # regenerate the option reference if you changed a default
```

CI runs all three plus the installer structure check, and fails if
`docs/SYMBOL-REFERENCE.md` is out of date. Running them locally first turns a
15-minute round trip into a 2-minute one.

## Adding a symbol

Read **[AUTHORING-CONTRACT.md](AUTHORING-CONTRACT.md)** first — it is binding,
and the build validator enforces most of it. Then copy
`src/symbols/pvxRadialGauge` (the reference implementation), rename it, and
build.

The rules that catch people out:

- **ES5 only.** No `let`, `const`, arrow functions, template literals or
  spread. PI Vision 2019 has to load this. Promises are fine — that is a runtime
  API, not syntax.
- **No third-party code.** Not a convenience, a constraint: see `NOTICE.md`.
- **Namespace your CSS.** Every rule must be scoped to the symbol's own class.
- **Never drop a data source silently.** If a symbol excludes a tag — negative
  value in a treemap, non-numeric in a chart — it must say so in the footer. A
  display that quietly omits a tag is worse than one that refuses to draw.

New files are picked up automatically: the build discovers symbols from the
directory, and `tools/wix.js` regenerates the installer source from the build
output. Nothing needs registering by hand.

## Things that will bite

**Do not edit `dist/`.** It is generated and gitignored. Edit `src/`.

**Do not change `PVX_NAMESPACE` or `UPGRADE_CODE` in `tools/wix.js`.** They are
the installer's identity across every version ever shipped. `docs/RELEASING.md`
explains what breaks — briefly, every installed copy in the field becomes
unupgradeable.

**`ext/libraries/pvx/pvx-config.js` is a site's file, not ours.** Both the deploy script
and the MSI refuse to overwrite it. If you rename it, `tools/wix.js` fails the
build on purpose rather than shipping an installer that silently destroys a
site's PI Web API settings on upgrade.

**Raw control characters break the deployment.** A literal NUL in a source file
makes it register as binary: `grep` skips it, git treats it as non-text, and a
text-mode file transfer can corrupt it in flight. Use the escape sequence
(`'\u0000'`), never the literal byte. This has happened once already.

## Releasing

See **[RELEASING.md](RELEASING.md)**. Short version: bump `package.json`, tag
`v<version>`, push. CI does the rest and refuses to build if the tag and
`package.json` disagree.
