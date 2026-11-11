# Releases a new version of Kinuza in one step: sets the version, commits what is in the folder,
# tags it and pushes. GitHub then builds the signed installer and publishes the release
# (.github/workflows/release.yml); installed apps offer the update by themselves.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/publish.ps1 -Version 0.2.0 -Notes "What changed"
#
# Keep this file ASCII only: Windows PowerShell 5.1 misreads BOM-less UTF-8.

param(
    [Parameter(Mandatory = $true)][string]$Version,
    [string]$Notes = "",
    [string]$Repo = "Lembegor/Kinuza"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Invoke-Checked([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed." }
}

if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version must look like 1.2.3 (got '$Version')."
}
$tag = "v$Version"

$current = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
if ([version]$Version -lt [version]$current) {
    throw "Version $Version is lower than the current $current. Installed apps only take a higher version."
}

# Released versions are final: installed apps already have them.
$remoteTag = git ls-remote --tags origin "refs/tags/$tag"
if ($LASTEXITCODE -ne 0) { throw "Cannot reach GitHub (git ls-remote failed)." }
if ($remoteTag -or (git tag -l $tag)) {
    throw "Version $Version is already released (tag $tag exists). Pick the next number."
}

Write-Host "== Checking that the app builds"
Invoke-Checked "Type check (npm run typecheck)" { npm run typecheck }

Write-Host "== Setting version $Version"
Invoke-Checked "npm version" { npm version $Version --no-git-tag-version --allow-same-version | Out-Null }

Write-Host "== Committing"
Invoke-Checked "git add" { git add -A }
git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
    Invoke-Checked "git commit" { git commit -m "Kinuza $Version" }
}

# The notes travel as the tag's message; a file keeps Cyrillic text intact on any console.
if (-not $Notes.Trim()) { $Notes = "Kinuza $Version" }
$notesFile = [System.IO.Path]::GetTempFileName()
try {
    [System.IO.File]::WriteAllText($notesFile, $Notes, (New-Object System.Text.UTF8Encoding($false)))
    Invoke-Checked "git tag" { git tag -a $tag --cleanup=whitespace -F $notesFile }
} finally {
    Remove-Item $notesFile -ErrorAction SilentlyContinue
}

Write-Host "== Pushing"
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
Invoke-Checked "git push" { git push origin $branch $tag }

Write-Host ""
Write-Host "Version $Version is on its way. GitHub is building it now (about 15-25 minutes):"
Write-Host "  https://github.com/$Repo/actions"
Write-Host "When the build is green, the release appears here:"
Write-Host "  https://github.com/$Repo/releases/latest"
Write-Host "Installed apps will offer the update on their next start (or within a few hours if they stay open)."
