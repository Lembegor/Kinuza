# Builds a signed Kinuza installer and the update feed (latest.json) for one version.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/release.ps1 -Version 0.2.0 -Notes "What changed"
#   add -Publish to upload the release to GitHub (needs the gh CLI, logged in).
# Keep this file ASCII only: Windows PowerShell 5.1 misreads BOM-less UTF-8.

param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = "",
    [string]$Repo = "Lembegor/Kinuza",
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must look like 1.2.3 (got '$Version')."
}

$keyPath = Join-Path $env:USERPROFILE ".tauri\kinuza.key"
if (-not (Test-Path $keyPath)) {
    throw "Signing key not found at $keyPath. Without it friends' apps will reject the update."
}
if (-not (Test-Path (Join-Path $root ".env"))) {
    throw ".env with VITE_TMDB_API_KEY is missing; the catalog would be empty in this build."
}

Write-Host "== Setting version $Version"
npm version $Version --no-git-tag-version --allow-same-version | Out-Null
if ($LASTEXITCODE -ne 0) { throw "npm version failed." }

Write-Host "== Building the signed installer (this takes a few minutes)"
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content $keyPath -Raw).Trim()
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
npx tauri build
if ($LASTEXITCODE -ne 0) { throw "tauri build failed." }

$bundleDir = Join-Path $root "src-tauri\target\release\bundle\nsis"
$installer = Get-ChildItem $bundleDir -Filter "*_${Version}_x64-setup.exe" | Select-Object -First 1
if (-not $installer) { throw "Installer for $Version not found in $bundleDir." }
$signaturePath = $installer.FullName + ".sig"
if (-not (Test-Path $signaturePath)) { throw "Signature file is missing: the build was not signed." }

$outDir = Join-Path $root "release\v$Version"
New-Item -ItemType Directory -Force $outDir | Out-Null
Copy-Item $installer.FullName $outDir -Force

$feed = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = (Get-Content $signaturePath -Raw).Trim()
            url       = "https://github.com/$Repo/releases/download/v$Version/$($installer.Name)"
        }
    }
}
$feedPath = Join-Path $outDir "latest.json"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($feedPath, ($feed | ConvertTo-Json -Depth 5), $utf8NoBom)

Write-Host ""
Write-Host "Ready: $outDir"
Write-Host "  $($installer.Name)  - send this to friends for the first install"
Write-Host "  latest.json           - the update feed"

if ($Publish) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw "gh CLI is not installed. Install it (winget install GitHub.cli) or upload both files to a GitHub release by hand."
    }
    Write-Host "== Publishing v$Version to $Repo"
    gh release create "v$Version" (Join-Path $outDir $installer.Name) $feedPath --repo $Repo --title "Kinuza $Version" --notes $Notes
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed." }
    Write-Host "Published. Installed apps will offer the update on their next start."
} else {
    Write-Host ""
    Write-Host "To publish: create a GitHub release tagged v$Version in $Repo and attach both files,"
    Write-Host "or rerun this script with -Publish."
}
