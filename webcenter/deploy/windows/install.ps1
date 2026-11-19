<#
.SYNOPSIS
  Installs (or updates) the remote Esko WebCenter MCP server on a Windows VM, behind HTTPS.

.DESCRIPTION
  - Installs a private copy of Node.js 22 (if a suitable Node isn't already installed) and Caddy (HTTPS reverse proxy
    with an automatic, auto-renewing Let's Encrypt certificate). Both downloads are checksum-verified.
  - Installs the server to C:\EskoMCP (or -InstallDir), writes its settings to config.env (readable only by
    Administrators and SYSTEM), and registers two startup tasks that keep the server and Caddy running.
  - Opens Windows Firewall for 80/443 and checks the server is answering.
  Safe to run again to update: existing settings in config.env are kept unless you pass -Reconfigure.

.PARAMETER Hostname
  Public DNS name of the VM, e.g. abp-webcenter-mcp.eastus.cloudapp.azure.com (set a DNS name label on the VM's
  public IP in the Azure portal). Must already resolve to this VM.

.PARAMETER AuthMode
  entra (default): Copilot users sign in with their Microsoft work account; the server checks the sign-in and makes
           WebCenter calls with one WebCenter service account (you'll be asked for its username and password).
  oauth:   each user signs in to WebCenter with their own account (needs WebCenter 26.07+ with OAuth enabled).
  service: shared API key + service account. Testing only.

.PARAMETER TenantId
  entra mode: your Microsoft Entra Directory (tenant) ID.

.PARAMETER Audience
  entra mode: the Application ID URI of the "Esko WebCenter MCP" app registration, e.g. api://<client-id>.

.EXAMPLE
  .\install.ps1 -Hostname abp-webcenter-mcp.eastus.cloudapp.azure.com -TenantId <tenant-id> -Audience api://<client-id>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Hostname,
  [string]$WebCenterUrl = "https://abp.esko-saas.com/WebCenter/",
  [ValidateSet("entra", "oauth", "service")][string]$AuthMode = "entra",
  [string]$TenantId = "",
  [string]$Audience = "",
  [string]$RequiredRole = "",
  [string]$OAuthIssuer = "",
  [string]$InstallDir = "C:\EskoMCP",
  [int]$Port = 8787,
  [string]$CertificateEmail = "",
  [switch]$Reconfigure
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# ---- checks ------------------------------------------------------------------------
$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script in PowerShell as Administrator."
}
$Hostname = $Hostname.Trim().ToLower()
if ($Hostname -notmatch '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$') { throw "'$Hostname' isn't a valid DNS name." }
$serverJs = Join-Path $PSScriptRoot "http.js"
if (-not (Test-Path $serverJs)) { throw "http.js not found next to this script. Extract the whole zip and run install.ps1 from that folder." }
if (-not $WebCenterUrl.EndsWith("/")) { $WebCenterUrl += "/" }
if ($AuthMode -eq "entra" -and ($Reconfigure -or -not (Test-Path (Join-Path $InstallDir "config.env")))) {
  if ($TenantId -notmatch '^[0-9a-fA-F-]{36}$') { throw "Entra mode needs -TenantId (the Directory (tenant) ID from the Entra admin center)." }
  if (-not $Audience) { throw "Entra mode needs -Audience (the app registration's Application ID URI, e.g. api://<client-id>)." }
}

Step "Checking that $Hostname points to this VM"
try {
  $resolved = (Resolve-DnsName $Hostname -Type A -ErrorAction Stop | Where-Object { $_.IPAddress } | Select-Object -First 1).IPAddress
  $publicIp = $null
  try { $publicIp = (Invoke-RestMethod -Uri "https://api.ipify.org" -TimeoutSec 10) } catch {}
  if ($publicIp -and $resolved -ne $publicIp) {
    Warn "$Hostname resolves to $resolved, but this VM's public IP looks like $publicIp. The HTTPS certificate will fail until DNS points here."
  } else { Ok "$Hostname -> $resolved" }
} catch {
  Warn "$Hostname doesn't resolve yet. Set the DNS name label on the VM's public IP in the Azure portal; the certificate is issued once it resolves."
}

# ---- folders -----------------------------------------------------------------------
Step "Preparing $InstallDir"
foreach ($d in @("", "app", "node", "caddy", "logs", "data")) { New-Item -ItemType Directory -Force -Path (Join-Path $InstallDir $d) | Out-Null }
$tmp = Join-Path $env:TEMP ("eskomcp-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $tmp | Out-Null

# Stop running copies before replacing files (update case)
foreach ($t in @("EskoMCP-Server", "EskoMCP-Caddy")) {
  if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue }
}
Get-CimInstance Win32_Process -Filter "Name='node.exe' OR Name='caddy.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$InstallDir*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 1

# ---- Node.js -------------------------------------------------------------------------
Step "Node.js"
$nodeExe = Join-Path $InstallDir "node\node.exe"
$systemNode = Get-Command node -ErrorAction SilentlyContinue
$useSystemNode = $false
if ($systemNode) {
  $v = (& $systemNode.Source --version) -replace '^v', ''
  if ([version]$v -ge [version]"20.6.0") { $useSystemNode = $true; $nodeExe = $systemNode.Source; Ok "Using installed Node.js $v ($nodeExe)" }
}
if (-not $useSystemNode -and -not (Test-Path $nodeExe)) {
  $base = "https://nodejs.org/dist/latest-v22.x"
  $sums = (Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $line = ($sums -split "`n" | Where-Object { $_ -match "node-v22\.[0-9.]+-win-x64\.zip$" } | Select-Object -First 1).Trim()
  $hash, $file = $line -split "\s+"
  Invoke-WebRequest -Uri "$base/$file" -OutFile "$tmp\$file" -UseBasicParsing
  if ((Get-FileHash "$tmp\$file" -Algorithm SHA256).Hash -ne $hash.ToUpper()) { throw "Node.js download failed its checksum check." }
  Expand-Archive "$tmp\$file" -DestinationPath $tmp -Force
  $nodeDir = Join-Path $tmp ($file -replace '\.zip$', '')
  Copy-Item (Join-Path $nodeDir "node.exe") $nodeExe -Force
  Ok "Installed $($file -replace '\.zip$','') (checksum verified)"
} elseif (-not $useSystemNode) { Ok "Using $nodeExe" }

# ---- Caddy (HTTPS) -------------------------------------------------------------------
Step "Caddy (HTTPS with automatic certificate)"
$caddyExe = Join-Path $InstallDir "caddy\caddy.exe"
if (-not (Test-Path $caddyExe)) {
  $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/caddyserver/caddy/releases/latest" -Headers @{ "User-Agent" = "eskomcp-installer" }
  $zip = $rel.assets | Where-Object { $_.name -match '^caddy_[0-9.]+_windows_amd64\.zip$' } | Select-Object -First 1
  $sumsAsset = $rel.assets | Where-Object { $_.name -match '_checksums\.txt$' } | Select-Object -First 1
  if (-not $zip -or -not $sumsAsset) { throw "Couldn't find the Caddy Windows download in the latest release." }
  Invoke-WebRequest -Uri $zip.browser_download_url -OutFile "$tmp\$($zip.name)" -UseBasicParsing
  $sums = (Invoke-WebRequest -Uri $sumsAsset.browser_download_url -UseBasicParsing).Content
  $expected = (($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($zip.name) } | Select-Object -First 1) -split "\s+")[0]
  if ((Get-FileHash "$tmp\$($zip.name)" -Algorithm SHA512).Hash -ne $expected.ToUpper()) { throw "Caddy download failed its checksum check." }
  Expand-Archive "$tmp\$($zip.name)" -DestinationPath "$tmp\caddy" -Force
  Copy-Item "$tmp\caddy\caddy.exe" $caddyExe -Force
  Ok "Installed Caddy $($rel.tag_name) (checksum verified)"
} else { Ok "Using $caddyExe" }

# ---- server files ------------------------------------------------------------------------
Step "Installing the WebCenter MCP server"
Copy-Item $serverJs (Join-Path $InstallDir "app\http.js") -Force
Ok "Copied http.js"

# ---- settings ---------------------------------------------------------------------------
$configFile = Join-Path $InstallDir "config.env"
$apiKeyToShow = $null
if ((Test-Path $configFile) -and -not $Reconfigure) {
  Ok "Keeping existing settings in config.env (use -Reconfigure to change them)"
} else {
  Step "Writing settings"
  $lines = @(
    "# Esko WebCenter MCP server settings. Restart the EskoMCP-Server task after editing.",
    "WEBCENTER_BASE_URL=$WebCenterUrl",
    "MCP_AUTH_MODE=$AuthMode",
    "MCP_HOST=127.0.0.1",
    "PORT=$Port",
    "MCP_PUBLIC_URL=https://$Hostname"
  )
  if ($OAuthIssuer) { $lines += "WEBCENTER_OAUTH_ISSUER=$OAuthIssuer" }
  if ($AuthMode -eq "entra") {
    # Accept both the Application ID URI and the bare client ID as the token audience.
    $aud = New-Object System.Collections.Generic.List[string]
    foreach ($a in ($Audience -split ",")) {
      $a = $a.Trim(); if (-not $a) { continue }
      if (-not $aud.Contains($a)) { $aud.Add($a) }
      if ($a -match '^api://([0-9a-fA-F-]{36})$' -and -not $aud.Contains($Matches[1])) { $aud.Add($Matches[1]) }
    }
    $lines += "ENTRA_TENANT_ID=$TenantId", ("ENTRA_AUDIENCE=" + ($aud -join ","))
    if ($RequiredRole) { $lines += "ENTRA_REQUIRED_ROLE=$RequiredRole" }
  }
  if ($AuthMode -eq "service" -or $AuthMode -eq "entra") {
    Write-Host "    WebCenter calls will run as this service account: Copilot users will see what it can see." -ForegroundColor Yellow
    $svcUser = Read-Host "    WebCenter service account username"
    $sec = Read-Host "    WebCenter service account password" -AsSecureString
    $svcPass = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
    if ($AuthMode -eq "service") {
      $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
      $apiKeyToShow = ([Convert]::ToBase64String($bytes) -replace '[+/=]', '')
    }
    # Quote the password so characters like # or spaces survive; single quotes are literal in Node's env-file format.
    if ($svcPass.Contains("'")) {
      $quoted = '"' + ($svcPass -replace '\\', '\\' -replace '"', '\"') + '"'
    } else { $quoted = "'" + $svcPass + "'" }
    $lines += "WEBCENTER_USERNAME=$svcUser", "WEBCENTER_PASSWORD=$quoted"
    if ($apiKeyToShow) { $lines += "MCP_API_KEY=$apiKeyToShow" }
  }
  Set-Content -Path $configFile -Value $lines -Encoding ASCII
  Ok "Wrote config.env"
}
# Only Administrators and SYSTEM may read the settings (they can hold a password / API key)
icacls $configFile /inheritance:r /grant:r "*S-1-5-32-544:(F)" "*S-1-5-18:(F)" | Out-Null

# ---- Caddyfile ----------------------------------------------------------------------------
$caddyData = (Join-Path $InstallDir "data\caddy") -replace '\\', '/'
$logDir = (Join-Path $InstallDir "logs") -replace '\\', '/'
$emailLine = ""
if ($CertificateEmail) { $emailLine = "  email $CertificateEmail" }
@"
{
  storage file_system $caddyData
$emailLine
}

$Hostname {
  encode gzip
  reverse_proxy 127.0.0.1:$Port
  log {
    output file $logDir/caddy-access.log {
      roll_size 10MiB
      roll_keep 5
    }
  }
}
"@ | Set-Content -Path (Join-Path $InstallDir "caddy\Caddyfile") -Encoding ASCII
& $caddyExe validate --config (Join-Path $InstallDir "caddy\Caddyfile") --adapter caddyfile *> "$tmp\caddy-validate.txt"
if ($LASTEXITCODE -ne 0) { Get-Content "$tmp\caddy-validate.txt"; throw "The Caddy configuration is invalid." }
Ok "Caddy configured for https://$Hostname"

# ---- run wrappers + startup tasks -----------------------------------------------------------
Step "Registering startup tasks"
@"
@echo off
rem Keeps the WebCenter MCP server running; restarts it if it stops.
cd /d "$InstallDir"
:loop
"$nodeExe" --env-file="$configFile" "$InstallDir\app\http.js" >> "$InstallDir\logs\server.log" 2>&1
timeout /t 5 /nobreak > nul
goto loop
"@ | Set-Content -Path (Join-Path $InstallDir "run-server.cmd") -Encoding ASCII

@"
@echo off
rem Keeps Caddy (HTTPS) running; restarts it if it stops.
cd /d "$InstallDir\caddy"
:loop
"$caddyExe" run --config "$InstallDir\caddy\Caddyfile" --adapter caddyfile >> "$InstallDir\logs\caddy.log" 2>&1
timeout /t 5 /nobreak > nul
goto loop
"@ | Set-Content -Path (Join-Path $InstallDir "run-caddy.cmd") -Encoding ASCII

$taskPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$trigger = New-ScheduledTaskTrigger -AtStartup
foreach ($t in @(@{ Name = "EskoMCP-Server"; Cmd = "run-server.cmd" }, @{ Name = "EskoMCP-Caddy"; Cmd = "run-caddy.cmd" })) {
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$InstallDir\$($t.Cmd)`"" -WorkingDirectory $InstallDir
  Register-ScheduledTask -TaskName $t.Name -Action $action -Trigger $trigger -Principal $taskPrincipal -Settings $settings `
    -Description "Esko WebCenter MCP server ($($t.Cmd))" -Force | Out-Null
  Start-ScheduledTask -TaskName $t.Name
  Ok "$($t.Name) registered and started"
}

# ---- firewall ---------------------------------------------------------------------------------
Step "Windows Firewall"
foreach ($p in @(80, 443)) {
  $name = "EskoMCP HTTPS $p"
  if (-not (Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName $name -Direction Inbound -Protocol TCP -LocalPort $p -Action Allow | Out-Null
  }
}
Ok "Inbound TCP 80 and 443 allowed (80 is only used for certificate issuing and redirects)"

# ---- health checks ---------------------------------------------------------------------------
Step "Checking the server"
$local = $null
for ($i = 0; $i -lt 20 -and -not $local; $i++) {
  Start-Sleep -Seconds 1
  try { $local = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 3 } catch {}
}
if ($local) { Ok "Server is up: version $($local.version), auth mode $($local.auth_mode), WebCenter $($local.webcenter)" }
else { Warn "The server didn't answer on port $Port. See $InstallDir\logs\server.log" }

$public = $null
for ($i = 0; $i -lt 30 -and -not $public; $i++) {
  Start-Sleep -Seconds 2
  try { $public = Invoke-RestMethod -Uri "https://$Hostname/healthz" -TimeoutSec 5 } catch {}
}
if ($public) { Ok "HTTPS works: https://$Hostname/healthz" }
else { Warn "https://$Hostname isn't answering yet. Check the Azure network security group allows inbound 80 and 443, and that DNS points here. Certificate issuing can take a minute; see $InstallDir\logs\caddy.log" }

Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "MCP server URL for Copilot Studio:  https://$Hostname/mcp" -ForegroundColor Green
if ($apiKeyToShow) {
  Write-Host "API key (shown once, copy it now):   $apiKeyToShow" -ForegroundColor Yellow
  Write-Host "In Copilot Studio use API key authentication, header name: x-api-key" -ForegroundColor Yellow
}
Write-Host "Logs: $InstallDir\logs    Settings: $configFile"
