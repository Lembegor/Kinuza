$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$line = Get-Content (Join-Path $root ".env") | Where-Object { $_ -match '^\s*VITE_REPORT_BOT_TOKEN\s*=' } | Select-Object -First 1
$token = if ($line) { ($line -split '=', 2)[1].Trim().Trim('"') } else { "" }
if (-not $token) { throw "Put the bot token into .env as VITE_REPORT_BOT_TOKEN first." }
$updates = Invoke-RestMethod "https://api.telegram.org/bot$token/getUpdates"
$chats = $updates.result | ForEach-Object { $_.message.chat } | Where-Object { $_ } | Sort-Object id -Unique
if (-not $chats) { throw "No messages yet. Open your bot in Telegram, press Start, then run this again." }
foreach ($chat in $chats) { "{0}  @{1}  {2} {3}" -f $chat.id, $chat.username, $chat.first_name, $chat.last_name }
