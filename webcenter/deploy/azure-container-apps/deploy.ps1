<#
.SYNOPSIS
  Deploys (or updates) the remote Esko WebCenter MCP server to Azure Container Apps.

.DESCRIPTION
  Creates a resource group, a Container Apps environment and the container app (scale to zero, HTTPS built in),
  pulling the server image from GitHub's container registry (ghcr.io). Secrets (the WebCenter service account
  password and the registry token) are stored as Container Apps secrets, never in plain environment variables.
  Run again to update settings or the image. Use -ImageOnly to just roll out a new image version.

  Needs the Azure CLI (az) and an account that can create resources in the subscription. Works in Windows
  PowerShell 5.1, PowerShell 7, and Azure Cloud Shell.

.PARAMETER TenantId
  Your Microsoft Entra Directory (tenant) ID.

.PARAMETER Audience
  Application ID URI of the "Esko WebCenter MCP" app registration, e.g. api://<client-id>.

.PARAMETER RegistryUsername
  GitHub username that can read the image package (e.g. dgrammatico). You'll be asked for a GitHub token with the
  read:packages scope. Leave empty if the image is public.

.EXAMPLE
  .\deploy.ps1 -TenantId <tenant-id> -Audience api://<client-id> -RegistryUsername dgrammatico

.EXAMPLE
  .\deploy.ps1 -ImageOnly -Image ghcr.io/dgrammatico/esko-webcenter-mcp:1.2.1

.EXAMPLE
  .\deploy.ps1 -AddAudience api://auth-<registration-guid>/<client-id>
  Adds a token audience (e.g. the Application ID URI the Teams Developer Portal gives the Copilot agent's
  Entra SSO registration) without touching anything else or asking for secrets.
#>
[CmdletBinding()]
param(
  [string]$TenantId = "",
  [string]$Audience = "",
  [string]$RequiredRole = "",
  [ValidateSet("entra", "oauth", "service")][string]$AuthMode = "entra",
  [string]$WebCenterUrl = "https://abp.esko-saas.com/WebCenter/",
  [string]$Image = "ghcr.io/dgrammatico/esko-webcenter-mcp:latest",
  [string]$RegistryUsername = "",
  [string]$ResourceGroup = "rg-esko-mcp",
  [string]$Location = "eastus",
  [string]$EnvironmentName = "esko-mcp-env",
  [string]$AppName = "esko-webcenter-mcp",
  [string]$Subscription = "",
  [switch]$ImageOnly,
  # Add one or more accepted token audiences (comma-separated) to the running app; nothing else changes.
  [string]$AddAudience = "",
  # Print the container app spec (secrets masked) without signing in to Azure or changing anything.
  [switch]$PrintSpec
)

$ErrorActionPreference = "Stop"
function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# Run az and fail loudly; returns stdout text.
function Invoke-Az {
  $out = & az @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "az $($args -join ' ') failed:`n$($out | Out-String)" }
  return ($out | Where-Object { $_ -isnot [System.Management.Automation.ErrorRecord] } | Out-String).Trim()
}
function Plain([Security.SecureString]$s) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
# YAML single-quoted scalar: only ' needs escaping (as '')
function Q([string]$v) { "'" + ($v -replace "'", "''") + "'" }

# ---- Azure sign-in -------------------------------------------------------------------
if ($PrintSpec) { if (-not $TenantId) { $TenantId = "00000000-0000-0000-0000-000000000000" } }
elseif (-not (Get-Command az -ErrorAction SilentlyContinue)) { throw "The Azure CLI (az) isn't installed. Install it from https://aka.ms/installazurecliwindows or use Azure Cloud Shell." }
if (-not $PrintSpec) {
Step "Azure sign-in"
$acct = (& az account show -o json 2>$null) | Out-String
if ($LASTEXITCODE -ne 0) { Invoke-Az login --only-show-errors | Out-Null; $acct = Invoke-Az account show -o json }
if ($Subscription) { Invoke-Az account set --subscription $Subscription | Out-Null; $acct = Invoke-Az account show -o json }
$acctObj = $acct | ConvertFrom-Json
Ok "Subscription: $($acctObj.name) ($($acctObj.id))"
if (-not $TenantId) { $TenantId = $acctObj.tenantId }

Invoke-Az extension add --name containerapp --upgrade --only-show-errors | Out-Null
}

# ---- image-only update -----------------------------------------------------------------
if ($ImageOnly) {
  Step "Updating $AppName to $Image"
  Invoke-Az containerapp update -n $AppName -g $ResourceGroup --image $Image --only-show-errors -o none | Out-Null
  $fqdn = Invoke-Az containerapp show -n $AppName -g $ResourceGroup --query properties.configuration.ingress.fqdn -o tsv
  Ok "Done: https://$fqdn/mcp"
  return
}

# ---- add token audience(s) only ---------------------------------------------------------------
if ($AddAudience) {
  Step "Adding token audience to $AppName"
  $cur = Invoke-Az containerapp show -n $AppName -g $ResourceGroup --query "properties.template.containers[0].env[?name=='ENTRA_AUDIENCE'].value | [0]" -o tsv
  $list = New-Object System.Collections.Generic.List[string]
  foreach ($a in (($cur + "," + $AddAudience) -split ",")) { $a = $a.Trim(); if ($a -and -not $list.Contains($a)) { $list.Add($a) } }
  Invoke-Az containerapp update -n $AppName -g $ResourceGroup --set-env-vars ("ENTRA_AUDIENCE=" + ($list -join ",")) --only-show-errors -o none | Out-Null
  Ok "Accepted audiences now: $($list -join ', ')"
  return
}

# ---- checks -------------------------------------------------------------------------------
if ($AuthMode -eq "entra") {
  if ($TenantId -notmatch '^[0-9a-fA-F-]{36}$') { throw "Entra mode needs -TenantId (Directory (tenant) ID)." }
  if (-not $Audience) { throw "Entra mode needs -Audience (the app registration's Application ID URI, e.g. api://<client-id>)." }
}
if (-not $WebCenterUrl.EndsWith("/")) { $WebCenterUrl += "/" }

# ---- resource providers, group, environment ---------------------------------------------
if ($PrintSpec) {
  $envId = "/subscriptions/<sub>/resourceGroups/$ResourceGroup/providers/Microsoft.App/managedEnvironments/$EnvironmentName"
  $fqdn = "$AppName.<environment-domain>"
} else {
Step "Preparing Azure resources"
# Registering providers needs subscription-level rights; with access to just a resource group, ask an admin to
# register Microsoft.App and Microsoft.OperationalInsights once (Subscription -> Resource providers).
foreach ($ns in @("Microsoft.App", "Microsoft.OperationalInsights")) {
  try {
    $state = Invoke-Az provider show -n $ns --query registrationState -o tsv
    if ($state -ne "Registered") { Invoke-Az provider register -n $ns --wait | Out-Null }
    Ok "$ns registered"
  } catch {
    Warn "Couldn't check/register $ns (needs subscription-level rights). Continuing; if the next step fails, have an admin register it under Subscription -> Resource providers."
  }
}
$rgLoc = & az group show -n $ResourceGroup --query location -o tsv 2>$null
if ($LASTEXITCODE -eq 0 -and $rgLoc) {
  Ok "Using existing resource group $ResourceGroup ($rgLoc)"
  if (-not $PSBoundParameters.ContainsKey("Location")) { $Location = $rgLoc }
} else {
  Invoke-Az group create -n $ResourceGroup -l $Location -o none | Out-Null
  Ok "Created resource group $ResourceGroup ($Location)"
}

$envId = & az containerapp env show -n $EnvironmentName -g $ResourceGroup --query id -o tsv 2>$null
if ($LASTEXITCODE -ne 0 -or -not $envId) {
  Write-Host "    Creating Container Apps environment $EnvironmentName (takes a few minutes)..."
  Invoke-Az containerapp env create -n $EnvironmentName -g $ResourceGroup -l $Location --only-show-errors -o none | Out-Null
  $envId = Invoke-Az containerapp env show -n $EnvironmentName -g $ResourceGroup --query id -o tsv
}
$domain = Invoke-Az containerapp env show -n $EnvironmentName -g $ResourceGroup --query properties.defaultDomain -o tsv
$fqdn = "$AppName.$domain"
Ok "Environment ready; the server will be at https://$fqdn"
}

# ---- secrets ------------------------------------------------------------------------------------
Step "Settings and secrets"
$secrets = @()
$envVars = @(
  @{ name = "WEBCENTER_BASE_URL"; value = $WebCenterUrl },
  @{ name = "MCP_AUTH_MODE"; value = $AuthMode },
  @{ name = "MCP_PUBLIC_URL"; value = "https://$fqdn" }
)
if ($AuthMode -eq "entra") {
  $aud = New-Object System.Collections.Generic.List[string]
  foreach ($a in ($Audience -split ",")) {
    $a = $a.Trim(); if (-not $a) { continue }
    if (-not $aud.Contains($a)) { $aud.Add($a) }
    if ($a -match '^api://([0-9a-fA-F-]{36})$' -and -not $aud.Contains($Matches[1])) { $aud.Add($Matches[1]) }
  }
  $envVars += @{ name = "ENTRA_TENANT_ID"; value = $TenantId }, @{ name = "ENTRA_AUDIENCE"; value = ($aud -join ",") }
  if ($RequiredRole) { $envVars += @{ name = "ENTRA_REQUIRED_ROLE"; value = $RequiredRole } }
}
$apiKey = $null
if ($AuthMode -ne "oauth") {
  Warn "WebCenter calls will run as this service account: Copilot users will see what it can see."
  if ($PrintSpec) { $svcUser = "COPILOT_SVC"; $svcPass = "<masked>" } else {
    $svcUser = Read-Host "    WebCenter service account username"
    $svcPass = Plain (Read-Host "    WebCenter service account password" -AsSecureString)
  }
  $secrets += @{ name = "webcenter-password"; value = $svcPass }
  $envVars += @{ name = "WEBCENTER_USERNAME"; value = $svcUser }, @{ name = "WEBCENTER_PASSWORD"; secretRef = "webcenter-password" }
  if ($AuthMode -eq "service") {
    $bytes = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $apiKey = ([Convert]::ToBase64String($bytes) -replace '[+/=]', '')
    if ($PrintSpec) { $apiKey = "<masked>" }
    $secrets += @{ name = "mcp-api-key"; value = $apiKey }
    $envVars += @{ name = "MCP_API_KEY"; secretRef = "mcp-api-key" }
  }
}
$registryServer = ($Image -split "/")[0]
if ($RegistryUsername) {
  if ($PrintSpec) { $regToken = "<masked>" } else {
    $regToken = Plain (Read-Host "    Token for $RegistryUsername on $registryServer (GitHub: classic token with read:packages)" -AsSecureString)
  }
  $secrets += @{ name = "registry-token"; value = $regToken }
}
Ok "Collected"

# ---- container app spec (YAML avoids command-line quoting problems with passwords) ---------------
$y = New-Object System.Collections.Generic.List[string]
$y.Add("location: $(Q $Location)")
$y.Add("properties:")
$y.Add("  managedEnvironmentId: $(Q $envId)")
$y.Add("  configuration:")
$y.Add("    activeRevisionsMode: Single")
$y.Add("    ingress:")
$y.Add("      external: true")
$y.Add("      targetPort: 8080")
$y.Add("      transport: auto")
$y.Add("      allowInsecure: false")
if ($secrets.Count) {
  $y.Add("    secrets:")
  foreach ($s in $secrets) { $y.Add("      - name: $($s.name)"); $y.Add("        value: $(Q $s.value)") }
}
if ($RegistryUsername) {
  $y.Add("    registries:")
  $y.Add("      - server: $(Q $registryServer)")
  $y.Add("        username: $(Q $RegistryUsername)")
  $y.Add("        passwordSecretRef: registry-token")
}
$y.Add("  template:")
$y.Add("    containers:")
$y.Add("      - name: webcenter-mcp")
$y.Add("        image: $(Q $Image)")
$y.Add("        resources:")
$y.Add("          cpu: 0.25")
$y.Add("          memory: 0.5Gi")
$y.Add("        env:")
foreach ($e in $envVars) {
  $y.Add("          - name: $($e.name)")
  if ($e.secretRef) { $y.Add("            secretRef: $($e.secretRef)") } else { $y.Add("            value: $(Q $e.value)") }
}
$y.Add("        probes:")
$y.Add("          - type: Liveness")
$y.Add("            httpGet:")
$y.Add("              path: /healthz")
$y.Add("              port: 8080")
$y.Add("            periodSeconds: 60")
$y.Add("          - type: Readiness")
$y.Add("            httpGet:")
$y.Add("              path: /healthz")
$y.Add("              port: 8080")
$y.Add("            periodSeconds: 10")
$y.Add("    scale:")
$y.Add("      minReplicas: 0")
$y.Add("      maxReplicas: 1")
$y.Add("      rules:")
$y.Add("        - name: http-requests")
$y.Add("          http:")
$y.Add("            metadata:")
$y.Add("              concurrentRequests: '50'")

if ($PrintSpec) { $y; return }

$yamlFile = Join-Path ([IO.Path]::GetTempPath()) ("eskomcp-" + [guid]::NewGuid().ToString("N") + ".yaml")
try {
  [IO.File]::WriteAllLines($yamlFile, $y)
  Step "Deploying $AppName"
  $exists = & az containerapp show -n $AppName -g $ResourceGroup --query id -o tsv 2>$null
  if ($LASTEXITCODE -eq 0 -and $exists) {
    Invoke-Az containerapp update -n $AppName -g $ResourceGroup --yaml $yamlFile --only-show-errors -o none | Out-Null
    Ok "Updated"
  } else {
    Invoke-Az containerapp create -n $AppName -g $ResourceGroup --yaml $yamlFile --only-show-errors -o none | Out-Null
    Ok "Created"
  }
} finally {
  Remove-Item $yamlFile -Force -ErrorAction SilentlyContinue  # contained secrets
}

# ---- health check ----------------------------------------------------------------------------
Step "Checking the server"
$health = $null
for ($i = 0; $i -lt 30 -and -not $health; $i++) {
  Start-Sleep -Seconds 5
  try { $health = Invoke-RestMethod -Uri "https://$fqdn/healthz" -TimeoutSec 20 } catch {}
}
if ($health) { Ok "Server is up: version $($health.version), auth mode $($health.auth_mode), WebCenter $($health.webcenter)" }
else { Warn "https://$fqdn/healthz isn't answering yet. Check: az containerapp logs show -n $AppName -g $ResourceGroup --tail 50" }

Write-Host ""
Write-Host "MCP server URL:  https://$fqdn/mcp" -ForegroundColor Green
Write-Host "Next: build the Copilot agent with copilot-agent\build-agent-package.ps1 -ServerUrl https://$fqdn (see docs/COPILOT-SETUP.md)." 
if ($apiKey) { Write-Host "API key (shown once):  $apiKey   (header: x-api-key)" -ForegroundColor Yellow }
Write-Host "Logs and audit trail:  az containerapp logs show -n $AppName -g $ResourceGroup --follow"
Write-Host "It scales to zero when idle; the first request after a quiet period takes a few seconds."
