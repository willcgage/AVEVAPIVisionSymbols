<#
.SYNOPSIS
    Deploys the PVX custom symbol library to a PI Vision server.

.DESCRIPTION
    Copies the contents of .\ext into the PI Vision extensibility folder,
    taking a timestamped backup of the ext folder first. Run from an elevated
    PowerShell session on the PI Vision web server.

    PVX keeps to folders of its own inside ext, except for the files PI Vision
    only loads from its own folders:

        ext\                  sym-pvx*.js and sym-pvx*.css
        ext\icons\            palette icons, pvx*.svg
        ext\pvx\              templates, config panes, the diagnostic page
        ext\libraries\pvx\    the shared runtime and the site's pvx-config.js

    Upgrading from 1.6.0 or earlier, which installed flat into ext\, the script
    moves the site's pvx-config.js into ext\libraries\pvx\ and removes the old
    PVX files from ext\ and ext\libraries\. Upgrading from 1.7.0, it removes
    the sym-pvx*.js, .css and icons that version put in ext\pvx\. Only files
    with PVX names are removed; nothing else in ext is touched.

.PARAMETER Drive
    The drive PI Vision is installed on, such as D or D:. Combined with
    -PIPCFolder. Defaults to C when only -PIPCFolder is given.

.PARAMETER PIPCFolder
    The PIPC folder on that drive, such as 'Program Files\PIPC' (the default
    when only -Drive is given). A full path such as 'E:\Apps\PIPC' is accepted
    too, in which case -Drive must be left out.

.PARAMETER PIVisionPath
    The full PI Vision installation folder. Overrides -Drive and -PIPCFolder,
    for servers where PI Vision is not in a PIVision folder under PIPC.

    With none of the three, the script uses the PIHOME64 environment variable
    the PI installers set, and falls back to C:\Program Files\PIPC\PIVision.

.PARAMETER SkipBackup
    Do not copy the existing ext folder to ext-backup-<timestamp> first.

.PARAMETER WhatIf
    Show what would be copied, moved and removed without changing anything.

.EXAMPLE
    .\Deploy-PvxSymbols.ps1
    .\Deploy-PvxSymbols.ps1 -Drive D
    .\Deploy-PvxSymbols.ps1 -Drive E -PIPCFolder 'Apps\PIPC'
    .\Deploy-PvxSymbols.ps1 -PIVisionPath 'D:\Program Files\PIPC\PIVision'
    .\Deploy-PvxSymbols.ps1 -Drive D -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $Drive,
    [string] $PIPCFolder,
    [string] $PIVisionPath,
    [switch] $SkipBackup
)

$ErrorActionPreference = 'Stop'

$source = Join-Path $PSScriptRoot 'ext'
if (-not (Test-Path -LiteralPath $source)) {
    throw "Cannot find '$source'. Run this script from the folder that contains the ext directory."
}

# --- where PI Vision is ----------------------------------------------------
# PIHOME64 comes before the hard-coded default because it is where PIPC
# actually is: a server that put PI on D: has PIHOME64=D:\..., and the old
# behaviour of assuming C: deployed into a folder PI Vision never reads.
if ($PIVisionPath) {
    $how = '-PIVisionPath'
}
elseif ($Drive -or $PIPCFolder) {
    if ($PIPCFolder -and $PIPCFolder.Trim() -match '^[A-Za-z]:') {
        if ($Drive) {
            throw "-PIPCFolder '$PIPCFolder' already names a drive. Pass -Drive with a folder relative to it, such as -Drive D -PIPCFolder 'Program Files\PIPC', or a full path in -PIPCFolder alone."
        }
        $pipc = $PIPCFolder.Trim()
    }
    else {
        if (-not $Drive)      { $Drive = 'C' }
        if (-not $PIPCFolder) { $PIPCFolder = 'Program Files\PIPC' }
        $letter = $Drive.Trim().TrimEnd('\').TrimEnd(':')
        if ($letter -notmatch '^[A-Za-z]$') {
            throw "-Drive '$Drive' is not a drive letter. Pass a single letter such as D or D:."
        }
        $pipc = Join-Path ($letter + ':\') $PIPCFolder.Trim().Trim('\')
    }
    $PIVisionPath = Join-Path $pipc 'PIVision'
    $how = '-Drive / -PIPCFolder'
}
elseif ($env:PIHOME64) {
    $PIVisionPath = Join-Path $env:PIHOME64 'PIVision'
    $how = 'the PIHOME64 environment variable'
}
else {
    $PIVisionPath = 'C:\Program Files\PIPC\PIVision'
    $how = 'the default location'
}

# Test for the symbols folder, not just the install root: a mistyped drive
# that happens to have a PIPC folder on it should fail here, not deploy a
# library into a tree PI Vision does not serve.
$symbolsRoot = Join-Path $PIVisionPath 'Scripts\app\editor\symbols'
if (-not (Test-Path -LiteralPath $symbolsRoot)) {
    throw "PI Vision not found at '$PIVisionPath' (from $how): '$symbolsRoot' does not exist. Pass -Drive and -PIPCFolder, or -PIVisionPath, with the location PI Vision is installed in."
}
$extRoot = Join-Path $symbolsRoot 'ext'

Write-Host ''
Write-Host "PI Vision : $PIVisionPath  ($how)"
Write-Host "Target    : $extRoot  (sym-pvx*.js, .css),  $extRoot\icons,  $extRoot\pvx  and  $extRoot\libraries\pvx"
Write-Host ''

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'

# --- backup ---------------------------------------------------------------
if ((Test-Path -LiteralPath $extRoot) -and -not $SkipBackup) {
    $backup = Join-Path $symbolsRoot "ext-backup-$stamp"
    if ($PSCmdlet.ShouldProcess($backup, 'Create backup')) {
        Copy-Item -LiteralPath $extRoot -Destination $backup -Recurse -Force
        Write-Host "Backed up existing ext folder to: $backup" -ForegroundColor Yellow
    }
}

# --- site settings from a flat (1.6.0 and earlier) install -----------------
# pvx-config.js holds the site's PI Web API settings. It is the one file an
# administrator edits, so it moves to the new folder rather than being
# replaced by the inert default. It cannot stay where it was either: PI Vision
# loads every .js file under ext\libraries, so two copies would both run and
# whichever loaded last would win.
$siteRelative = 'libraries\pvx\pvx-config.js'
$siteConfig   = Join-Path $extRoot $siteRelative
$legacyConfig = Join-Path $extRoot 'libraries\pvx-config.js'
$siteMigrated = $false

if (Test-Path -LiteralPath $legacyConfig) {
    if (-not (Test-Path -LiteralPath $siteConfig)) {
        if ($PSCmdlet.ShouldProcess($legacyConfig, "Move site settings to $siteConfig")) {
            New-Item -ItemType Directory -Path (Split-Path $siteConfig -Parent) -Force | Out-Null
            Move-Item -LiteralPath $legacyConfig -Destination $siteConfig
        }
        Write-Host "  libraries\pvx-config.js -> $siteRelative " -NoNewline
        Write-Host '(moved existing site settings)' -ForegroundColor Yellow
        $siteMigrated = $true
    }
    else {
        # Both exist, so someone has already set up the new location. Keep
        # that one, and park the old one under a name PI Vision does not load.
        $parked = "$legacyConfig.$stamp.bak"
        if ($PSCmdlet.ShouldProcess($legacyConfig, "Rename to $parked")) {
            Move-Item -LiteralPath $legacyConfig -Destination $parked
        }
        Write-Warning ("Found site settings in both libraries\pvx-config.js and $siteRelative. " +
            "Kept $siteRelative; the old file is now $parked. Compare the two if the old one held settings the new one lacks.")
    }
}

# --- remove what earlier versions left -------------------------------------
# 1.6.0 and earlier put templates and the runtime loose in ext\ and
# ext\libraries\; 1.7.0 put the symbol scripts in ext\pvx\, where they did
# not load, and the icons in ext\pvx\icons\, which the palette did not show.
# In the shared ext\ and ext\icons\ only files this package does not ship are
# removed (1.6.0's templates, a symbol since dropped): the rest are about to
# be overwritten. Matched by PVX's own name prefixes only, so another vendor's
# symbols in the same folders are safe.
$legacy = @()
foreach ($spec in @(
        @{ From = $source;                       To = $extRoot;                       Filter = 'sym-pvx*' },
        @{ From = (Join-Path $source 'icons');   To = (Join-Path $extRoot 'icons');   Filter = 'pvx*.svg' })) {
    $from = $spec.From
    $to   = $spec.To
    $shipped = @()
    if (Test-Path -LiteralPath $from) { $shipped = @(Get-ChildItem -LiteralPath $from -File | ForEach-Object { $_.Name }) }
    if (Test-Path -LiteralPath $to) {
        $legacy += @(Get-ChildItem -LiteralPath $to -File -Filter $spec.Filter |
            Where-Object { $shipped -notcontains $_.Name })
    }
}
foreach ($spec in @(
        @{ Dir = (Join-Path $extRoot 'pvx');             Filter = 'sym-pvx*.js' },
        @{ Dir = (Join-Path $extRoot 'pvx');             Filter = 'sym-pvx*.css' },
        @{ Dir = (Join-Path $extRoot 'pvx\icons');       Filter = 'pvx*.svg' },
        @{ Dir = (Join-Path $extRoot 'libraries');       Filter = 'pvx-core.js' },
        @{ Dir = $extRoot;                               Filter = 'piwebapi-check.html' })) {
    if (Test-Path -LiteralPath $spec.Dir) {
        $legacy += @(Get-ChildItem -LiteralPath $spec.Dir -File -Filter $spec.Filter)
    }
}
foreach ($f in $legacy) {
    if ($PSCmdlet.ShouldProcess($f.FullName, 'Remove file left by an earlier PVX version')) {
        Remove-Item -LiteralPath $f.FullName -Force
    }
}
if ($legacy.Count -gt 0) {
    Write-Host "Removed $($legacy.Count) file(s) left by an earlier PVX version." -ForegroundColor Yellow
}
# 1.7.0's icon folder, now empty unless something else was put in it.
$oldIcons = Join-Path $extRoot 'pvx\icons'
if ((Test-Path -LiteralPath $oldIcons) -and -not (Get-ChildItem -LiteralPath $oldIcons -Force)) {
    if ($PSCmdlet.ShouldProcess($oldIcons, 'Remove empty folder left by 1.7.0')) {
        Remove-Item -LiteralPath $oldIcons -Force
    }
}

# --- copy -----------------------------------------------------------------
$files = @(Get-ChildItem -LiteralPath $source -Recurse -File)
if ($files.Count -eq 0) {
    throw "'$source' contains no files. The package is incomplete; download it again."
}
$skipped = 0
foreach ($f in $files) {
    $relative = $f.FullName.Substring($source.Length).TrimStart('\')
    $dest     = Join-Path $extRoot $relative
    $destDir  = Split-Path $dest -Parent

    if ($relative -eq $siteRelative -and ($siteMigrated -or (Test-Path -LiteralPath $dest))) {
        Write-Host "  $relative " -NoNewline
        Write-Host '(kept existing site settings)' -ForegroundColor Yellow
        $skipped++
        continue
    }

    if ($PSCmdlet.ShouldProcess($dest, 'Copy')) {
        if (-not (Test-Path -LiteralPath $destDir)) {
            New-Item -ItemType Directory -Path $destDir -Force | Out-Null
        }
        Copy-Item -LiteralPath $f.FullName -Destination $dest -Force
    }
    Write-Host "  $relative"
}

Write-Host ''
Write-Host "Deployed $($files.Count - $skipped) file(s) to $extRoot, $extRoot\icons, $extRoot\pvx and $extRoot\libraries\pvx." -ForegroundColor Green
if ($skipped -gt 0) {
    Write-Host "Preserved $skipped existing site settings file(s)." -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Recycle the PI Vision application pool, or run: iisreset'
Write-Host '  2. Hard-refresh the browser (Ctrl+F5) - symbol files are cached aggressively.'
Write-Host '  3. The PVX symbols appear at the bottom of the symbol palette in display edit mode.'
Write-Host ''
Write-Host 'PI Web API symbols (Event Frames, AF browsing, manual entry) additionally need' -ForegroundColor Cyan
Write-Host "$extRoot\libraries\pvx\pvx-config.js edited with your base URL and authentication method."
Write-Host 'Open ext/pvx/piwebapi-check.html in a browser, from the PI Vision site, to test the settings.'
Write-Host ''
Write-Host 'To roll back, delete the ext folder and rename the ext-backup-* folder back to ext.'
Write-Host ''
