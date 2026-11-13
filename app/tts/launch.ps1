# Launch the local TTS server (called by the Electron main process).
# Why not spawn python directly from Electron: the same command starts in ~15s from a shell,
# but when spawned by Electron it hangs after the SoX warning (process alive, never listening).
# Starting an independent process tree via Start-Process reproduces the manual environment.
# NOTE: keep this file ASCII-only. PowerShell 5.1 reads .ps1 without a BOM as ANSI and
# non-ASCII comments can break parsing on this machine.
param(
  [Parameter(Mandatory = $true)][string]$Python,
  [Parameter(Mandatory = $true)][string]$Script,
  [Parameter(Mandatory = $true)][string]$Log,
  [Parameter(Mandatory = $true)][string]$WorkDir
)

$ErrorActionPreference = 'Stop'
$env:PATH = (($env:PATH -split ';') | Where-Object { $_ -and $_ -notmatch 'electron' }) -join ';'
$env:PYTHONUNBUFFERED = '1'
$env:PYTHONIOENCODING = 'utf-8'

# Windows env vars are case-insensitive, but Start-Process (ProcessStartInfo) rejects a set
# that contains both NO_PROXY and no_proxy (common when launched from a bash/MSYS shell).
foreach ($k in @('no_proxy', 'http_proxy', 'https_proxy', 'all_proxy')) {
  if (Test-Path "env:$k") { Remove-Item "env:$k" -ErrorAction SilentlyContinue }
}

# Leave an env dump next to the log: the only difference between "works from a shell" and
# "hangs from Electron" so far is the inherited environment, so record it for diffing.
Get-ChildItem env: | ForEach-Object { "$($_.Name)=$($_.Value)" } | Set-Content -Path "$Log.env.txt" -Encoding utf8

$p = Start-Process -FilePath $Python -ArgumentList @($Script) -WorkingDirectory $WorkDir `
  -RedirectStandardOutput $Log -RedirectStandardError "$Log.err" `
  -WindowStyle Hidden -PassThru
"$($p.Id)" | Set-Content -Path "$Log.pid" -Encoding ascii
