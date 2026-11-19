<#
.SYNOPSIS
  Builds the "WebCenter" Copilot agent package (a .zip you upload in the Teams / Microsoft 365 admin center).

.DESCRIPTION
  Fills in your server URL and Entra SSO registration ID, then zips the app package. Nothing is uploaded and
  nothing in Azure or Microsoft 365 is changed: you upload the zip yourself.

  The app ID is saved in agent-settings.json next to this script so that later rebuilds update the same agent
  instead of creating a second one. Keep that file. Bump -Version every time you upload a new build.

.PARAMETER ServerUrl
  The MCP server's public address, e.g. https://esko-webcenter-mcp.<random>.eastus.azurecontainerapps.io
  ("/mcp" is added if missing).

.PARAMETER AuthReferenceId
  The "Microsoft Entra SSO registration ID" from the Teams Developer Portal (Tools > Microsoft Entra SSO client ID
  registration). For OAuth instead of SSO, use the OAuth client registration ID; the manifest is the same.

.EXAMPLE
  .\build-agent-package.ps1 -ServerUrl https://esko-webcenter-mcp.xyz.eastus.azurecontainerapps.io -AuthReferenceId <registration-id>

.EXAMPLE
  .\build-agent-package.ps1 -Version 1.0.1     # rebuild with the saved settings and a new version
#>
[CmdletBinding()]
param(
  [string]$ServerUrl = "",
  [string]$AuthReferenceId = "",
  [string]$CompanyName = "",
  [string]$Version = "",
  [string]$OutputDir = ""
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$src = Join-Path $here "appPackage"
$settingsPath = Join-Path $here "agent-settings.json"
if (-not $OutputDir) { $OutputDir = $here }

# ---- settings (remembered between runs) ---------------------------------------------------------
$s = [ordered]@{ appId = ""; serverUrl = ""; authReferenceId = ""; companyName = "Anchor Bay Packaging"; version = "1.0.0" }
if (Test-Path $settingsPath) {
  $saved = Get-Content $settingsPath -Raw | ConvertFrom-Json
  foreach ($k in @($s.Keys)) { if ($saved.$k) { $s[$k] = [string]$saved.$k } }
}
if ($ServerUrl) { $s.serverUrl = $ServerUrl }
if ($AuthReferenceId) { $s.authReferenceId = $AuthReferenceId.Trim() }
if ($CompanyName) { $s.companyName = $CompanyName }
if ($Version) { $s.version = $Version }
if (-not $s.appId) { $s.appId = [guid]::NewGuid().ToString() }

if (-not $s.serverUrl) { throw "Pass -ServerUrl (the https address the deploy script printed)." }
if (-not $s.authReferenceId) { throw "Pass -AuthReferenceId (the Microsoft Entra SSO registration ID from the Teams Developer Portal)." }
if ($s.version -notmatch '^\d+\.\d+\.\d+$') { throw "-Version must look like 1.0.0" }

$url = $s.serverUrl.Trim().TrimEnd("/")
if ($url -notmatch '^https://') { throw "ServerUrl must start with https://" }
if ($url -notmatch '/mcp$') { $url = "$url/mcp" }
$uri = [Uri]$url
$s.serverUrl = $url

$values = @{
  "TEAMS_APP_ID"      = $s.appId
  "AGENT_VERSION"     = $s.version
  "COMPANY_NAME"      = $s.companyName
  "MCP_SERVER_URL"    = $url
  "MCP_HOST"          = $uri.Host
  "AUTH_REFERENCE_ID" = $s.authReferenceId
}

# ---- fill in and validate -----------------------------------------------------------------------
$stage = Join-Path ([IO.Path]::GetTempPath()) ("webcenter-agent-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $utf8 = New-Object Text.UTF8Encoding $false
  foreach ($f in @("manifest.json", "declarativeAgent.json", "ai-plugin.json")) {
    $text = [IO.File]::ReadAllText((Join-Path $src $f))
    foreach ($k in $values.Keys) {
      $j = ($values[$k] | ConvertTo-Json -Compress); $v = $j.Substring(1, $j.Length - 2)   # JSON-escape the value
      $text = $text.Replace('${{' + $k + '}}', $v)
    }
    if ($text -match '\$\{\{([A-Z_]+)\}\}') { throw "$f still has an unfilled placeholder: $($Matches[1])" }
    try { $null = $text | ConvertFrom-Json } catch { throw "$f isn't valid JSON after filling in values: $_" }
    [IO.File]::WriteAllText((Join-Path $stage $f), $text, $utf8)
  }
  foreach ($f in @("color.png", "outline.png")) { Copy-Item (Join-Path $src $f) (Join-Path $stage $f) }

  $zip = Join-Path $OutputDir "esko-webcenter-agent-$($s.version).zip"
  if (Test-Path $zip) { Remove-Item $zip -Force }
  Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip
} finally {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

($s | ConvertTo-Json) | Set-Content -Path $settingsPath -Encoding UTF8
Write-Host ""
Write-Host "Built $zip" -ForegroundColor Green
Write-Host "  App ID:      $($s.appId)  (saved in agent-settings.json - keep it)"
Write-Host "  Version:     $($s.version)"
Write-Host "  MCP server:  $url"
Write-Host "  Auth config: $($s.authReferenceId)"
Write-Host ""
Write-Host "Next: upload the zip in the Microsoft 365 admin center (Agents > All agents > Upload custom agent)"
Write-Host "      or the Teams admin center (Teams apps > Manage apps > Upload new app). See README.md."
