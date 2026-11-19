<#
.SYNOPSIS
  Removes the remote Esko WebCenter MCP server from this VM.
.DESCRIPTION
  Stops and removes the startup tasks and firewall rules. Pass -DeleteFiles to also delete the install folder
  (including settings, certificates and logs).
#>
[CmdletBinding()]
param([string]$InstallDir = "C:\EskoMCP", [switch]$DeleteFiles)
$ErrorActionPreference = "Stop"
foreach ($t in @("EskoMCP-Server", "EskoMCP-Caddy")) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $t -Confirm:$false
    Write-Host "Removed task $t"
  }
}
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='caddy.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$InstallDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
foreach ($p in @(80, 443)) { Remove-NetFirewallRule -DisplayName "EskoMCP HTTPS $p" -ErrorAction SilentlyContinue }
Write-Host "Removed firewall rules"
if ($DeleteFiles -and (Test-Path $InstallDir)) { Remove-Item $InstallDir -Recurse -Force; Write-Host "Deleted $InstallDir" }
Write-Host "Done."
