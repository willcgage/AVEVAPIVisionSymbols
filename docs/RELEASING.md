# Releasing PVX

Releases are cut by pushing a version tag. Everything after that is CI: no one
builds a shipping artifact on a laptop, and no artifact reaches a release
without passing the same gate that runs on every pull request.

---

## Cutting a release

```bash
# 1. Version bump — package.json is the single source of truth.
#    PVX.version in src/shared/pvx-core.js must match.
npm version 1.6.0 --no-git-tag-version

# 2. Regenerate what is generated, and prove it still works.
node tools/docgen.js
npm run verify                        # 540 render checks
npm run test:api

# 3. Commit, tag, push.
git commit -am "Release 1.6.0"
git tag v1.6.0
git push origin main --follow-tags
```

The tag triggers `.github/workflows/release.yml`. The `gate` job re-runs the
full verification on the tagged commit and **refuses to continue if the tag and
`package.json` disagree** — that mismatch is the classic way a release ends up
labelled one version and containing another.

---

## What comes out

| Artifact | What it is |
|---|---|
| `PvxSymbols-<version>.msi` | The installer. Built with the official WiX toolset on a Windows runner. |
| `pvx-symbols-<version>.zip` | `ext` folder plus `Deploy-PvxSymbols.ps1`, for sites that copy files. |
| `PvxSymbols.wxs` | The installer source that produced the MSI, for audit. |
| `components.json` | Every file's component GUID. See below. |
| `SHA256SUMS.txt` | Checksums for all of the above. |

Both install routes are published because they clear different hurdles: an MSI
is what a software deployment system wants, and a folder copy is what sometimes
gets approved the same week.

---

## The one thing that must never change

`tools/wix.js` holds two frozen constants:

```js
var PVX_NAMESPACE = 'b1a7f2c4-5d3e-4f8a-9c6b-7e0d1a2b3c4d';
var UPGRADE_CODE  = uuid5(PVX_NAMESPACE, 'pvx:upgrade-code');
```

Every component GUID in the MSI is derived — UUIDv5 — from that namespace plus
the file's path inside `ext`. That is what makes upgrades safe.

Windows Installer identifies a component by GUID, not by path. If a file's GUID
changes between versions, the installer sees the new one as a *different*
component that happens to sit at the same path: it installs the new file, then
the removal of the old version deletes it. The upgrade destroys the file it just
laid down, and the symbol vanishes from the palette on a machine that was
working ten minutes earlier.

Deriving GUIDs from paths means the same path always yields the same GUID, on
any machine, forever, with no state to keep. Adding a file adds a GUID; renaming
one retires the old and mints a new one, which is correct because a rename *is*
a different component.

Change `PVX_NAMESPACE` or `UPGRADE_CODE` and every already-installed copy in the
field becomes a stranger to every future release. There is no recovery except
uninstalling by hand on every server.

`node tools/wix.js` is deterministic — a clean rebuild of the same source
produces byte-identical `components.json`. If a diff shows GUIDs moving,
something is wrong; investigate before tagging.

---

## What CI actually proves

**On every pull request** (`.github/workflows/ci.yml`):

- The build validator passes — ES5 only, namespaced CSS, correct registration.
- 540 render checks: every symbol × 3 sizes × 3 data scenarios × light and dark.
- The PI Web API layer against a mock misconfigured six ways, plus the
  write-safety assertions.
- `docs/SYMBOL-REFERENCE.md` is regenerated and compared — a changed default
  with stale docs fails the build.
- The installer source compiles, and `tools/verify-msi.js` reads the resulting
  MSI's own tables: all 153 files present, subfolders actually nested, every
  component GUID matching `components.json`, the Upgrade table wired to the
  frozen code, `PIVISIONPATH` overridable.

The installer job deliberately runs **without `npm ci`**. That is a standing
proof that the build tooling stays zero-dependency, which is what makes an
air-gapped build machine viable.

**At release time**, additionally: the MSI is built with the real WiX toolset,
and a PowerShell step reads the shipping MSI and fails the release if
`libraries\pvx-config.js` has lost its `Permanent` + `NeverOverwrite`
attributes. That check exists because `wixl` — used for the pull-request
validation on Linux — silently ignores both attributes, so the property that
protects a site's PI Web API settings cannot be confirmed anywhere else.

---

## Code signing

Optional and off until two repository secrets exist:

| Secret | Value |
|---|---|
| `CODE_SIGN_PFX_BASE64` | The signing certificate, `.pfx`, base64-encoded |
| `CODE_SIGN_PASSWORD` | Its password |

With them set, the release signs both `PvxSymbols-<version>.msi` and
`Deploy-PvxSymbols.ps1`, timestamped so signatures outlive the certificate.

Worth doing. Unsigned, Windows shows "Unknown Publisher" on the MSI, and a
site with a restrictive PowerShell execution policy cannot run the deploy
script at all — which is the documented fallback for exactly the sites most
likely to have that policy.

---

## Cadence, and a caution

There is no schedule. A release happens when there is something to release.

The library is at 30 symbols and the roadmap is closed by decision, so the
expected shape of the next while is fixes and small additions rather than
another fourteen symbols. Resist bundling: a release containing one fix is
trivial to reason about when something breaks in a control room at 3am, and a
release containing nine changes is not.
