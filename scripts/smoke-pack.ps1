#!/usr/bin/env pwsh
# Smoke test: build + pack the SDK, install into a temp workspace, run a setup
# against the target backend, assert the response shape doesn't leak a private
# key. Used before tagging a release and in release-candidate CI.
#
# Usage:
#   scripts/smoke-pack.ps1 -ApiUrl <url> -Audience <audience>
#
# Example (staging):
#   scripts/smoke-pack.ps1 -ApiUrl https://yosobet-app-staging.up.railway.app -Audience yoso.bet-staging

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ApiUrl,
  [Parameter(Mandatory = $true)][string]$Audience
)

$ErrorActionPreference = "Stop"

$SdkRoot = (Resolve-Path "$PSScriptRoot/..").Path
Set-Location $SdkRoot

Write-Host "==> building"
npm run build | Out-Null

Write-Host "==> packing"
$packOutput = npm pack 2>$null
$Tarball = ($packOutput | Select-Object -Last 1).Trim()
$TarballPath = Join-Path $SdkRoot $Tarball
if (-not (Test-Path $TarballPath)) {
  Write-Error "npm pack did not produce a tarball"
}
Write-Host "    tarball: $Tarball"

$TmpDir = Join-Path ([System.IO.Path]::GetTempPath()) ("yoso-smoke-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $TmpDir | Out-Null
Write-Host "==> temp workspace: $TmpDir"

try {
  Set-Location $TmpDir
  npm init -y | Out-Null
  npm install $TarballPath 2>&1 | Out-Null

  $AgentName = "smoke-" + [int][double]::Parse((Get-Date -UFormat %s))

  Write-Host "==> running setup against $ApiUrl (audience=$Audience, agent=$AgentName)"
  $env:YOSO_API_URL = $ApiUrl
  $env:YOSO_CANONICAL_AUDIENCE = $Audience
  npx yoso-agent setup --name $AgentName --yes --skip-fund-poll 2>&1 | Tee-Object -FilePath setup.log

  if (-not (Test-Path "$TmpDir/.env")) {
    Write-Error "FAIL: .env not written to temp workspace"
  }
  $EnvText = Get-Content "$TmpDir/.env" -Raw
  if ($EnvText -notmatch 'AGENT_PRIVATE_KEY=0x[0-9a-fA-F]{64}') {
    Write-Error "FAIL: AGENT_PRIVATE_KEY missing or malformed in .env"
  }
  if (-not (Test-Path "$TmpDir/config.json")) {
    Write-Error "FAIL: config.json not written"
  }
  if ((Get-Content "$TmpDir/config.json" -Raw) -notmatch '"apiKey":') {
    Write-Error "FAIL: apiKey not present in config.json"
  }
  if ((Get-Content "$TmpDir/setup.log" -Raw) -match 'walletPrivateKey') {
    Write-Error "FAIL: setup output mentioned walletPrivateKey — server is leaking secrets"
  }

  Write-Host ""
  Write-Host "==> PASS"
  Write-Host "    Agent created: $AgentName"
  Write-Host "    Private key lives in temp workspace (.env) — will be wiped on exit"
}
finally {
  Set-Location $SdkRoot
  Remove-Item -Recurse -Force $TmpDir -ErrorAction SilentlyContinue
  Remove-Item -Force $TarballPath -ErrorAction SilentlyContinue
}
