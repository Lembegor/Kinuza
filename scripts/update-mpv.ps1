$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$lockPath = Join-Path $root "src-tauri\mpv.lock.json"
$old = Get-Content $lockPath -Raw | ConvertFrom-Json

$release = Invoke-RestMethod "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/latest" -Headers @{ "User-Agent" = "kinuza-build" }
$asset = $release.assets | Where-Object { $_.name -like "mpv-x86_64-*.7z" -and $_.name -notlike "*-v3-*" -and $_.name -notlike "*dev*" -and $_.name -notlike "*debug*" } | Select-Object -First 1
if (-not $asset) { throw "The latest mpv release has no x86_64 build." }
if (-not $asset.digest -or -not $asset.digest.StartsWith("sha256:")) { throw "The latest mpv release publishes no checksum." }

if ($asset.name -eq $old.asset) {
    Write-Host "mpv is already the latest build ($($old.tag))."
    exit 0
}

$lock = [ordered]@{
    tag = $release.tag_name
    asset = $asset.name
    sha256 = $asset.digest.Substring(7)
    version = ($asset.name -replace '^mpv-x86_64-\d+-git-', 'git-' -replace '\.7z$', '')
    pinnedAt = (Get-Date).ToString("yyyy-MM-dd")
}
[System.IO.File]::WriteAllText($lockPath, (($lock | ConvertTo-Json) + "`n"), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "mpv: $($old.tag) -> $($lock.tag). Check that a film plays before releasing."
& (Join-Path $PSScriptRoot "fetch-mpv.ps1")
