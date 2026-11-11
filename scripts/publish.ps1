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

$remoteTag = git ls-remote --tags origin "refs/tags/$tag"
if ($LASTEXITCODE -ne 0) { throw "Cannot reach GitHub (git ls-remote failed)." }
if ($remoteTag) {
    throw "Version $Version is already released (tag $tag is on GitHub). Pick the next number."
}

if (git tag -l $tag) {
    Write-Host "== Tag $tag exists here but not on GitHub: finishing the interrupted release"
} else {
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($branch -ne "master") {
        throw "Releases go out from master, but this is '$branch'. Switch with: git switch master"
    }

    $changed = @(git status --porcelain --untracked-files=all | ForEach-Object { $_.Substring(3).Trim('"') })
    $secretLike = $changed | Where-Object { $_ -match '(^|/)\.env(\.|$)|\.(key|pem|pfx|p12)$|(^|/)secrets?(/|\.|$)' -and $_ -notmatch '(^|/)\.env\.example$' }
    if ($secretLike) {
        throw "These files look like secrets and would go into the public repository: $($secretLike -join ', '). Add them to .gitignore or move them out of the project."
    }
    if ($changed.Count -gt 0) {
        Write-Host "== These changes go into the release:"
        $changed | ForEach-Object { Write-Host "   $_" }
    }

    $mpvLock = Get-Content (Join-Path $root "src-tauri\mpv.lock.json") -Raw | ConvertFrom-Json
    $mpvAge = ((Get-Date) - [datetime]::ParseExact($mpvLock.pinnedAt, "yyyy-MM-dd", $null)).Days
    if ($mpvAge -gt 60) {
        Write-Warning "The bundled mpv ($($mpvLock.tag)) is $mpvAge days old. Update it with scripts/update-mpv.ps1, check a film, then release."
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

    if (-not $Notes.Trim()) { $Notes = "Kinuza $Version" }
    $notesFile = [System.IO.Path]::GetTempFileName()
    try {
        [System.IO.File]::WriteAllText($notesFile, $Notes, (New-Object System.Text.UTF8Encoding($false)))
        Invoke-Checked "git tag" { git tag -a $tag --cleanup=whitespace -F $notesFile }
    } finally {
        Remove-Item $notesFile -ErrorAction SilentlyContinue
    }
}

Write-Host "== Pushing"
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
git push origin $branch $tag
if ($LASTEXITCODE -ne 0) {
    throw "git push failed. Nothing is lost: the commit and the tag $tag are saved here. Fix the access (see the message above) and run the same command again."
}

Write-Host ""
Write-Host "Version $Version is on its way. GitHub is building it now (about 15-25 minutes):"
Write-Host "  https://github.com/$Repo/actions"
Write-Host "The build checks the files first and publishes the release only if the update is complete."
Write-Host "When the build is green, the release appears here:"
Write-Host "  https://github.com/$Repo/releases/latest"
Write-Host "Installed apps will offer the update on their next start (or within a few hours if they stay open)."
