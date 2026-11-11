$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$lock = Get-Content (Join-Path $root "src-tauri\mpv.lock.json") -Raw | ConvertFrom-Json
$target = Join-Path $root "src-tauri\resources\bin\mpv"
$marker = Join-Path $target "version.txt"

if ((Test-Path (Join-Path $target "mpv.exe")) -and (Test-Path $marker) -and ((Get-Content $marker -Raw).Trim() -eq $lock.asset)) {
    Write-Host "mpv $($lock.tag) is already in place"
    exit 0
}

$url = "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/$($lock.tag)/$($lock.asset)"
$work = Join-Path ([System.IO.Path]::GetTempPath()) "kinuza-mpv-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $work | Out-Null
try {
    $archive = Join-Path $work $lock.asset
    Write-Host "Downloading mpv $($lock.tag)"
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $archive -TimeoutSec 600
    $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
    if ($actual -ne $lock.sha256.ToLowerInvariant()) {
        throw "The mpv archive does not match src-tauri/mpv.lock.json (got $actual)."
    }
    $unpacked = Join-Path $work "unpacked"
    New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
    & tar -xf $archive -C $unpacked
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $unpacked "mpv.exe"))) {
        throw "Could not unpack the mpv archive."
    }
    if (Test-Path $target) { Remove-Item -Recurse -Force $target }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    Get-ChildItem $unpacked -File | Where-Object { $_.Extension -in ".exe", ".com", ".dll" } | Copy-Item -Destination $target
    Set-Content -Path $marker -Value $lock.asset -Encoding ascii -NoNewline
    Write-Host "mpv $($lock.tag) is ready in src-tauri/resources/bin/mpv"
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
