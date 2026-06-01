<#
.SYNOPSIS
  Launch the Web2cmd server and (optionally) a public tunnel.

.EXAMPLE
  .\start.ps1                       # local only, http://localhost:8787
  .\start.ps1 -Tunnel cloudflare    # expose via a free Cloudflare quick tunnel
  .\start.ps1 -Tunnel ngrok         # expose via ngrok
  .\start.ps1 -Build                # rebuild web + server first

  Set a password once before first run:
    pnpm --filter @web2cmd/server set-password -- <your-password>
#>
param(
  [ValidateSet('none', 'cloudflare', 'ngrok')]
  [string]$Tunnel = 'none',
  [int]$Port = 8787,
  [switch]$Build
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$procs = @()

function Stop-All {
  foreach ($p in $procs) {
    if ($p -and -not $p.HasExited) { try { $p.Kill() } catch {} }
  }
}

try {
  # 1. build if requested or missing
  if ($Build -or -not (Test-Path "$root\web\dist\index.html")) {
    Write-Host "[start] building web app..." -ForegroundColor Cyan
    pnpm --filter @web2cmd/web build
  }
  if ($Build -or -not (Test-Path "$root\server\dist\index.js")) {
    Write-Host "[start] building server..." -ForegroundColor Cyan
    pnpm --filter @web2cmd/server build
  }

  # 2. exposure: local runs open on localhost/LAN; tunnelled runs are gated by OTP pairing.
  $remote = $Tunnel -ne 'none'
  $cfgFile = "$root\.web2cmd\config.json"
  $hasPass = (Test-Path $cfgFile) -and ((Get-Content $cfgFile -Raw) -match '"passwordHash"\s*:\s*"')
  if ($remote) {
    Write-Host "[start] Tunnelled: clients must PAIR using the code the server prints below." -ForegroundColor Cyan
    if ($hasPass) { Write-Host "        (auth=password is set, so pairing will also ask for the password.)" -ForegroundColor DarkGray }
  }
  elseif (-not $hasPass) {
    Write-Host "[start] No password set — running OPEN on localhost/LAN (auth=off)." -ForegroundColor Yellow
  }

  # 3. start the server. Declare exposure so it enforces pairing on remote access.
  $env:WEB2CMD_PORT = "$Port"
  $env:WEB2CMD_EXPOSURE = if ($remote) { 'remote' } else { 'local' }
  Write-Host "[start] starting server on port $Port..." -ForegroundColor Cyan
  $server = Start-Process -FilePath "node" -ArgumentList "`"$root\server\dist\index.js`"" `
    -NoNewWindow -PassThru
  $procs += $server

  # 4. wait for health
  $healthy = $false
  for ($i = 0; $i -lt 30; $i++) {
    try {
      if ((Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2).ok) { $healthy = $true; break }
    } catch {}
    Start-Sleep -Milliseconds 400
  }
  if (-not $healthy) { throw "server did not become healthy" }
  Write-Host "[start] server is up: http://localhost:$Port" -ForegroundColor Green

  # 5. optional tunnel
  $publicUrl = $null
  if ($Tunnel -eq 'cloudflare') {
    $log = New-TemporaryFile
    Write-Host "[start] starting cloudflare tunnel..." -ForegroundColor Cyan
    $t = Start-Process -FilePath "cloudflared" `
      -ArgumentList "tunnel --url http://localhost:$Port" `
      -NoNewWindow -PassThru -RedirectStandardError $log.FullName -RedirectStandardOutput "$($log.FullName).out"
    $procs += $t
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      $m = Select-String -Path $log.FullName -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($m) { $publicUrl = $m.Matches[0].Value; break }
    }
  }
  elseif ($Tunnel -eq 'ngrok') {
    Write-Host "[start] starting ngrok tunnel..." -ForegroundColor Cyan
    $t = Start-Process -FilePath "ngrok" -ArgumentList "http $Port --log stdout" -NoNewWindow -PassThru
    $procs += $t
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 500
      try {
        $api = Invoke-RestMethod "http://127.0.0.1:4040/api/tunnels" -TimeoutSec 2
        $https = $api.tunnels | Where-Object { $_.public_url -like 'https*' } | Select-Object -First 1
        if ($https) { $publicUrl = $https.public_url; break }
      } catch {}
    }
  }

  Write-Host ""
  Write-Host "==================================================" -ForegroundColor Green
  Write-Host " Web2cmd is running." -ForegroundColor Green
  Write-Host "   Local:  http://localhost:$Port"
  if ($publicUrl) {
    Write-Host "   Public: $publicUrl" -ForegroundColor Green
    Write-Host "   ^ open this on your phone, then pair with the code the server prints."
  }
  elseif ($Tunnel -ne 'none') {
    Write-Host "   (tunnel URL not detected yet — check the tunnel output above)" -ForegroundColor Yellow
  }
  Write-Host "==================================================" -ForegroundColor Green
  Write-Host " Press Ctrl+C to stop." -ForegroundColor DarkGray
  Write-Host ""

  # 6. wait on the server process
  Wait-Process -Id $server.Id
}
finally {
  Stop-All
}
