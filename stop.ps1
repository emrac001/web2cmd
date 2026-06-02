<#
.SYNOPSIS
  Stop the Web2cmd server and any tunnel (cloudflared/ngrok) it was started with.

  Use this when the server was launched in the background (no window to Ctrl+C). If you started
  it in a normal terminal, pressing Ctrl+C there already cleans up both the server and tunnel.

.EXAMPLE
  .\stop.ps1            # stop the server on the default port (8787) + tunnels
  .\stop.ps1 -Port 9000 # stop a server running on a custom port
#>
param([int]$Port = 8787)

$stopped = 0

# 1. The server: whatever process is listening on the port.
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($c in $conns) {
  $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
  if ($p) {
    Write-Host "[stop] server: pid $($p.Id) ($($p.ProcessName)) on port $Port" -ForegroundColor Cyan
    Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
    $stopped++
  }
}
if (-not $conns) { Write-Host "[stop] no server listening on port $Port" -ForegroundColor DarkGray }

# 2. Tunnels. NOTE: this stops ALL cloudflared/ngrok processes — fine if Web2cmd is the only thing
#    using them; comment this out if you run other tunnels.
foreach ($name in 'cloudflared', 'ngrok') {
  Get-Process $name -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "[stop] tunnel: $name pid $($_.Id)" -ForegroundColor Cyan
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
    $stopped++
  }
}

Write-Host "[stop] done — stopped $stopped process(es)." -ForegroundColor Green
