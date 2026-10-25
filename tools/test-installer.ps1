<#
.SYNOPSIS
    Installs, upgrades and uninstalls PVX for real, and checks every file.

.DESCRIPTION
    tools/verify-msi.js reads the MSI's tables. That proves the package is
    assembled right; it cannot prove what Windows Installer then does with it,
    and the upgrade from 1.6.0 depends on exactly that: searches resolving a
    path, a component condition, a file move and wildcard removals, in the
    right order. This script runs them on a Windows machine and looks at the
    disk afterwards.

    Each scenario builds a fake PI Vision tree (just the folders PVX looks for,
    plus another vendor's files that must survive untouched) under its own
    root, so nothing here needs or touches a real PI Vision.

    Run elevated. CI runs it on windows-latest; it is equally usable on a test
    VM before a release:

        .\tools\test-installer.ps1 -Msi dist\installer\PvxSymbols-1.6.0.msi `
            -LegacyMsi legacy\PvxSymbols-1.6.0.msi -LegacyZip legacy\pvx-symbols-1.6.0.zip `
            -PreviousMsi legacy\PvxSymbols-1.7.0.msi

    Expected output: one "ok" line per check and "All installer scenarios
    passed" at the end. Any FAIL line exits non-zero after the remaining
    checks have run, and the msiexec logs are left in -WorkDir.

.PARAMETER Msi
    The MSI under test.

.PARAMETER LegacyMsi
    A 1.6.0 MSI, for the upgrade scenario.

.PARAMETER LegacyZip
    A 1.6.0 manual-copy zip, for the PowerShell upgrade scenario.

.PARAMETER PreviousMsi
    A 1.7.0 MSI, for the upgrade from the release that put the symbol scripts
    in ext\pvx. Optional; the scenario is skipped without it.

.PARAMETER DeployScript
    The Deploy-PvxSymbols.ps1 under test. Defaults to dist\Deploy-PvxSymbols.ps1.

.PARAMETER Drive
    The drive for the custom-drive scenario. Defaults to D when it exists, as it
    does on GitHub's Windows runners, otherwise C.

.PARAMETER WorkDir
    Where logs and the extracted zip go. Defaults to a folder under TEMP.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)] [string] $Msi,
    [Parameter(Mandatory = $true)] [string] $LegacyMsi,
    [Parameter(Mandatory = $true)] [string] $LegacyZip,
    [string] $PreviousMsi,
    [string] $DeployScript,
    [string] $Drive,
    [string] $WorkDir = (Join-Path $env:TEMP 'pvx-installer-test')
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path $PSScriptRoot -Parent
if (-not $DeployScript) { $DeployScript = Join-Path $repo 'dist\Deploy-PvxSymbols.ps1' }
foreach ($p in @($Msi, $LegacyMsi, $LegacyZip, $DeployScript)) {
    if (-not (Test-Path -LiteralPath $p)) { throw "Not found: $p" }
}
if ($PreviousMsi) { $PreviousMsi = (Resolve-Path -LiteralPath $PreviousMsi).Path }
$Msi       = (Resolve-Path -LiteralPath $Msi).Path
$LegacyMsi = (Resolve-Path -LiteralPath $LegacyMsi).Path
if (-not $Drive) { $Drive = if (Test-Path 'D:\') { 'D' } else { 'C' } }

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

# What the build says it ships, so the checks cannot drift from the package.
$manifest = Get-Content (Join-Path $repo 'dist\installer\components.json') -Raw | ConvertFrom-Json
$shipped  = @($manifest.components | ForEach-Object { $_.path })
$siteRel  = $manifest.siteConfig

$failures = 0
function Check([string] $name, [bool] $ok, [string] $detail = '') {
    if ($ok) { Write-Host "  ok   $name" -ForegroundColor Green }
    else {
        Write-Host "  FAIL $name" -ForegroundColor Red
        if ($detail) { Write-Host "       $detail" -ForegroundColor DarkGray }
        $script:failures++
    }
}

function New-FakePIVision([string] $root) {
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
    $ext = Join-Path $root 'Scripts\app\editor\symbols\ext'
    foreach ($d in @($ext, "$ext\icons", "$ext\libraries")) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
    }
    # Another vendor's symbol pack, in the shared folders PVX used to fill.
    Set-Content -LiteralPath "$ext\sym-vendorGauge.js" -Value '// not ours' -Encoding ascii
    Set-Content -LiteralPath "$ext\icons\vendorGauge.svg" -Value '<svg/>' -Encoding ascii
    Set-Content -LiteralPath "$ext\libraries\vendor-lib.js" -Value '// not ours' -Encoding ascii
    return $ext
}

function Invoke-Msi([string] $label, [string[]] $arguments, [int[]] $expect = @(0, 3010)) {
    $log = Join-Path $WorkDir "$label.log"
    $p = Start-Process -FilePath msiexec.exe -ArgumentList ($arguments + @('/qn', '/l*v', "`"$log`"")) `
                       -Wait -PassThru
    Check "$label (msiexec exit $($p.ExitCode))" ($expect -contains $p.ExitCode) "log: $log"
    return $p.ExitCode
}

function Test-NewLayout([string] $ext, [string] $what) {
    $missing = @($shipped | Where-Object { -not (Test-Path -LiteralPath (Join-Path $ext $_)) })
    Check "$what`: all $($shipped.Count) files where this version puts them" `
        ($missing.Count -eq 0) ("missing: " + (($missing | Select-Object -First 5) -join ', '))
}

# What 1.6.0 left loose in the shared folders, and the symbol scripts 1.7.0
# put in ext\pvx. ext\sym-pvx*.js and .css are this version's own, so only
# a 1.6.0 template counts there.
function Test-NoStaleFiles([string] $ext, [string] $what) {
    $stale = @()
    $stale += @(Get-ChildItem -LiteralPath $ext -File -Filter 'sym-pvx*.html' -ErrorAction SilentlyContinue)
    $stale += @(Get-ChildItem -LiteralPath "$ext\icons" -File -Filter 'pvx*' -ErrorAction SilentlyContinue)
    $stale += @(Get-ChildItem -LiteralPath "$ext\libraries" -File -Filter 'pvx-*' -ErrorAction SilentlyContinue)
    $stale += @(Get-ChildItem -LiteralPath $ext -File -Filter 'piwebapi-check.html' -ErrorAction SilentlyContinue)
    $stale += @(Get-ChildItem -LiteralPath "$ext\pvx" -File -Filter 'sym-pvx*.js' -ErrorAction SilentlyContinue)
    $stale += @(Get-ChildItem -LiteralPath "$ext\pvx" -File -Filter 'sym-pvx*.css' -ErrorAction SilentlyContinue)
    Check "$what`: nothing left where an earlier version put it" `
        ($stale.Count -eq 0) (($stale | Select-Object -First 5 | ForEach-Object { $_.FullName }) -join ', ')
}

function Test-VendorIntact([string] $ext, [string] $what) {
    $ok = (Test-Path "$ext\sym-vendorGauge.js") -and (Test-Path "$ext\icons\vendorGauge.svg") -and
          (Test-Path "$ext\libraries\vendor-lib.js")
    Check "$what`: another vendor's files are untouched" $ok
}

function Test-Removed([string] $ext, [string] $what) {
    $left = @($shipped | Where-Object { $_ -ne $siteRel -and (Test-Path -LiteralPath (Join-Path $ext $_)) })
    Check "$what`: every shipped file except the site settings is removed" `
        ($left.Count -eq 0) ("left: " + (($left | Select-Object -First 5) -join ', '))
    Check "$what`: the site settings survive" (Test-Path -LiteralPath (Join-Path $ext $siteRel))
}

$marker = '// pvx-ci-marker: edited by the site'
function Add-Marker([string] $file) {
    # A later write time than creation time is what tells Windows Installer
    # the file was edited, exactly as a real edit would.
    Start-Sleep -Seconds 2
    Add-Content -LiteralPath $file -Value $marker -Encoding ascii
}
function Test-Marker([string] $file, [string] $what) {
    $ok = (Test-Path -LiteralPath $file) -and ((Get-Content -LiteralPath $file -Raw) -match [regex]::Escape($marker))
    Check "$what`: the site's edited settings are at $file" $ok
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario 1: fresh install with INSTALLDRIVE and PIPCFOLDER, uninstall with no arguments" -ForegroundColor Cyan
$root = "$($Drive):\pvx-ci-drive\PIPC\PIVision"
$ext = New-FakePIVision $root
# A bare letter, the form most likely to be typed; D: and D:\ take other rules.
Invoke-Msi 's1-install' @('/i', "`"$Msi`"", "INSTALLDRIVE=$Drive", 'PIPCFOLDER="pvx-ci-drive\PIPC"') | Out-Null
Test-NewLayout $ext 's1'
Test-NoStaleFiles $ext 's1'
Test-VendorIntact $ext 's1'
$remembered = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\PVX\PI Vision Symbols' -ErrorAction SilentlyContinue).InstallLocation
Check 's1: the install location is remembered' ($remembered -and $remembered.TrimEnd('\') -eq $root) "got: $remembered"
Invoke-Msi 's1-uninstall' @('/x', "`"$Msi`"") | Out-Null
Test-Removed $ext 's1'
Test-VendorIntact $ext 's1 after uninstall'
# The settings component is Permanent, so Windows keeps it registered at this
# path after the uninstall. Left on disk it would make a later scenario's
# NeverOverwrite see "already installed" and skip laying down its own copy.
Remove-Item -LiteralPath (Join-Path $ext $siteRel) -Force

# ---------------------------------------------------------------------------
Write-Host "`nScenario 2: MSI upgrade from 1.6.0, with edited site settings" -ForegroundColor Cyan
$root = 'C:\pvx-ci-upgrade\PIVision'
$ext = New-FakePIVision $root
Invoke-Msi 's2-install-1.6.0' @('/i', "`"$LegacyMsi`"", "PIVISIONPATH=`"$root`"") | Out-Null
Check 's2: 1.6.0 laid down its flat layout' (Test-Path "$ext\libraries\pvx-core.js")
Add-Marker "$ext\libraries\pvx-config.js"
# No trailing backslash, the way people type it.
Invoke-Msi 's2-upgrade' @('/i', "`"$Msi`"", "PIVISIONPATH=`"$root`"") | Out-Null
Test-NewLayout $ext 's2'
Test-NoStaleFiles $ext 's2'
Test-VendorIntact $ext 's2'
Test-Marker (Join-Path $ext $siteRel) 's2'
Invoke-Msi 's2-uninstall' @('/x', "`"$Msi`"") | Out-Null
Test-Removed $ext 's2'
Test-Marker (Join-Path $ext $siteRel) 's2 after uninstall'

# ---------------------------------------------------------------------------
Write-Host "`nScenario 3: PowerShell upgrade from a 1.6.0 manual copy" -ForegroundColor Cyan
$root = 'C:\pvx-ci-ps\PIPC\PIVision'
$ext = New-FakePIVision $root
$legacyDir = Join-Path $WorkDir 'legacy-zip'
if (Test-Path $legacyDir) { Remove-Item $legacyDir -Recurse -Force }
Expand-Archive -LiteralPath $LegacyZip -DestinationPath $legacyDir
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $legacyDir 'Deploy-PvxSymbols.ps1') `
    -PIVisionPath $root -SkipBackup | Out-Null
Check 's3: 1.6.0 script laid down its flat layout' (Test-Path "$ext\libraries\pvx-core.js")
Add-Marker "$ext\libraries\pvx-config.js"

# -WhatIf first: it must report and change nothing.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DeployScript `
    -Drive C -PIPCFolder 'pvx-ci-ps\PIPC' -SkipBackup -WhatIf | Out-Null
Check 's3: -WhatIf changed nothing' ((Test-Path "$ext\libraries\pvx-core.js") -and
    -not (Test-Path "$ext\pvx") -and -not (Test-Path "$ext\libraries\pvx"))

# Windows PowerShell 5.1, deliberately: it is what a PI Vision server has.
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DeployScript `
    -Drive 'C:' -PIPCFolder 'pvx-ci-ps\PIPC'
Check 's3: deploy script exit code' ($LASTEXITCODE -eq 0) "exit $LASTEXITCODE"
Test-NewLayout $ext 's3'
Test-NoStaleFiles $ext 's3'
Test-VendorIntact $ext 's3'
Test-Marker (Join-Path $ext $siteRel) 's3'
Check 's3: a backup of ext was taken' (@(Get-ChildItem (Split-Path $ext -Parent) -Directory -Filter 'ext-backup-*').Count -eq 1)

# Run again over what a 1.7.0 copy leaves: symbol scripts in ext\pvx, which
# must go, and a dropped symbol in ext, which must not linger and register.
# The settings must stay in place.
Set-Content -LiteralPath "$ext\pvx\sym-pvxKpiCard.js" -Value '// 1.7.0 copy' -Encoding ascii
Set-Content -LiteralPath "$ext\pvx\sym-pvxKpiCard.css" -Value '/* 1.7.0 copy */' -Encoding ascii
Set-Content -LiteralPath "$ext\sym-pvxRetired.js" -Value '// dropped symbol' -Encoding ascii
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DeployScript -PIVisionPath $root -SkipBackup | Out-Null
Test-Marker (Join-Path $ext $siteRel) 's3 redeploy'
Test-NewLayout $ext 's3 redeploy'
Test-NoStaleFiles $ext 's3 redeploy'
Check 's3 redeploy: a symbol the package no longer ships is removed' (-not (Test-Path "$ext\sym-pvxRetired.js"))
Test-VendorIntact $ext 's3 redeploy'

# ---------------------------------------------------------------------------
Write-Host "`nScenario 4: a location with no PI Vision is refused" -ForegroundColor Cyan
$nowhere = 'C:\pvx-ci-nowhere\PIVision'
if (Test-Path $nowhere) { Remove-Item $nowhere -Recurse -Force }
Invoke-Msi 's4-msi-refuses' @('/i', "`"$Msi`"", "PIVISIONPATH=`"$nowhere`"") -expect @(1603) | Out-Null
Check 's4: the MSI created nothing there' (-not (Test-Path "$nowhere\Scripts"))
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $DeployScript -PIVisionPath $nowhere 2>&1 | Out-Null
Check 's4: the deploy script refuses too' ($LASTEXITCODE -ne 0) "exit $LASTEXITCODE"

# ---------------------------------------------------------------------------
Write-Host "`nScenario 5: no arguments at all installs to the standard location" -ForegroundColor Cyan
if ($env:PIHOME64) {
    Write-Host '  skip PIHOME64 is set on this machine, so it decides instead' -ForegroundColor DarkGray
}
else {
    $root = 'C:\Program Files\PIPC\PIVision'
    if (Test-Path -LiteralPath $root) {
        # New-FakePIVision starts by deleting its root. On a VM with a real PI
        # Vision that would be the real one.
        Write-Host "  skip $root exists; not touching what may be a real PI Vision" -ForegroundColor DarkGray
    }
    else {
        $ext = New-FakePIVision $root
        Invoke-Msi 's5-install' @('/i', "`"$Msi`"") | Out-Null
        Test-NewLayout $ext 's5'
        Invoke-Msi 's5-uninstall' @('/x', "`"$Msi`"") | Out-Null
        Test-Removed $ext 's5'
    }
}

# ---------------------------------------------------------------------------
Write-Host "`nScenario 6: MSI upgrade from 1.7.0, with edited site settings" -ForegroundColor Cyan
if (-not $PreviousMsi) {
    Write-Host '  skip no -PreviousMsi given' -ForegroundColor DarkGray
}
else {
    $root = 'C:\pvx-ci-from17\PIVision'
    $ext = New-FakePIVision $root
    Invoke-Msi 's6-install-1.7.0' @('/i', "`"$PreviousMsi`"", "PIVISIONPATH=`"$root`"") | Out-Null
    Check 's6: 1.7.0 put its symbol scripts in ext\pvx' (Test-Path "$ext\pvx\sym-pvxKpiCard.js")
    Add-Marker (Join-Path $ext $siteRel)
    # No PIVISIONPATH: the remembered location has to carry the upgrade.
    Invoke-Msi 's6-upgrade' @('/i', "`"$Msi`"") | Out-Null
    Test-NewLayout $ext 's6'
    Test-NoStaleFiles $ext 's6'
    Test-VendorIntact $ext 's6'
    Test-Marker (Join-Path $ext $siteRel) 's6'
    Invoke-Msi 's6-uninstall' @('/x', "`"$Msi`"") | Out-Null
    Test-Removed $ext 's6'
    Remove-Item -LiteralPath (Join-Path $ext $siteRel) -Force
}

Write-Host ''
if ($failures -gt 0) {
    Write-Host "$failures installer check(s) failed. Logs: $WorkDir" -ForegroundColor Red
    exit 1
}
Write-Host 'All installer scenarios passed' -ForegroundColor Green
# Explicitly: otherwise the script's exit code is the last native command's,
# and scenario 4 ends on a deploy script that is supposed to fail.
exit 0
