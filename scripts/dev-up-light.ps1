# Ambiente leve sem Docker: catalog-api (JSON) + gateway + storefront + admin
#
# Uso:
#   .\scripts\dev-up-light.ps1
#   npm run dev:up:light

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

$JwtKey = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")

function Set-ApiBaseUrl([string]$Url) {
    Write-Ok "api-config.js do repo (gateway local em http://localhost:5100; catalog-api em $Url). Modo leve: use Persistence=Json na API."
}

function Test-PortOpen([int]$Port) {
    $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $c
}

function Wait-Http([string]$Url, [int]$Seconds = 60) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) { return $true }
        } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}

Write-Host "Delivery Platform - modo leve (sem Docker)" -ForegroundColor White

Set-ApiBaseUrl "http://localhost:5101"

Write-Step "Catalog API (:5101)"
if (-not (Test-PortOpen 5101)) {
    $proj = Join-Path $Root "services\catalog-api"
    $arg = '/c cd /d "' + $proj + '" & set Jwt__Key=' + $JwtKey + ' & set ASPNETCORE_ENVIRONMENT=Development & set ASPNETCORE_URLS=http://localhost:5101 & dotnet run -c Release --no-launch-profile'
    Start-Process -FilePath "cmd.exe" -ArgumentList $arg -WindowStyle Minimized
    Write-Ok "catalog-api iniciando..."
} else {
    Write-Warn "Porta 5101 ja em uso - reutilizando."
}

if (-not (Wait-Http "http://127.0.0.1:5101/api/v1/store" 90)) {
    throw "Catalog API nao respondeu em :5101"
}
Write-Ok "Catalog API OK"

Write-Step "Gateway (:5100)"
if (-not (Test-PortOpen 5100)) {
    $proj = Join-Path $Root "services\gateway"
    $arg = '/c cd /d "' + $proj + '" & set ASPNETCORE_ENVIRONMENT=Development& dotnet run --launch-profile http'
    Start-Process -FilePath "cmd.exe" -ArgumentList $arg -WindowStyle Minimized
    Write-Ok "Gateway iniciando..."
} else {
    Write-Warn "Porta 5100 ja em uso - reutilizando."
}

if (-not (Wait-Http "http://127.0.0.1:5100/api/v1/store" 90)) {
    throw "Gateway nao respondeu em :5100"
}
Write-Ok "Gateway OK"

Write-Step "Fronts"
if (-not (Test-PortOpen 8080)) {
    $sf = Join-Path $Root "apps\storefront"
    $arg0 = '/c cd /d "' + $sf + '" & npx --yes serve . -l tcp://0.0.0.0:8080'
    Start-Process -FilePath "cmd.exe" -ArgumentList $arg0 -WindowStyle Minimized
}
if (-not (Test-PortOpen 8081)) {
    $ad = Join-Path $Root "apps\admin"
    $arg1 = '/c cd /d "' + $ad + '" & npx --yes serve . -l tcp://0.0.0.0:8081'
    Start-Process -FilePath "cmd.exe" -ArgumentList $arg1 -WindowStyle Minimized
}
if (-not (Test-PortOpen 3000)) {
    $arg2 = '/c cd /d "' + $Root + '" & npm run dev'
    Start-Process -FilePath "cmd.exe" -ArgumentList $arg2 -WindowStyle Minimized
}

if (-not (Wait-Http "http://localhost:3000/login" 90)) {
    throw "Next.js nao respondeu em :3000"
}

Start-Process "http://localhost:8080/"
Start-Process "http://localhost:8081/"
Start-Process "http://localhost:3000/login"

Write-Host ""
Write-Host "Cardapio  http://localhost:8080/" -ForegroundColor Green
Write-Host "Admin     http://localhost:8081/  (credenciais de desenvolvimento da API)" -ForegroundColor Green
Write-Host "Admin Wa  http://localhost:3000/login"
Write-Host "Gateway   http://localhost:5100" -ForegroundColor Green
Write-Host "Catalog   http://localhost:5101/api/v1/health" -ForegroundColor Green
Write-Host ""
Write-Host "Para encerrar fronts + APIs: .\scripts\dev-down-light.ps1"
