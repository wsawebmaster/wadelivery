# Encerra o ambiente local iniciado por scripts/dev-up.ps1
#
# Uso:
#   .\scripts\dev-down.ps1
#   npm run dev:down

param(
    [switch]$KeepDocker
)

$ErrorActionPreference = "Continue"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root
$ComposeScript = Join-Path $PSScriptRoot "docker-compose-wsl.ps1"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }

function Stop-Port([int]$Port) {
    $conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in $conns) {
        try {
            $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue
            if ($p) {
                Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
                Write-Ok "Porta $Port - encerrado PID $($p.Id) ($($p.ProcessName))"
            }
        } catch { }
    }
}

Write-Host "Delivery Platform - encerrando ambiente local" -ForegroundColor White

Write-Step "Parando fronts (:3000 Next.js, :8080 storefront, :8081 admin)"
Stop-Port 3000
Stop-Port 8080
Stop-Port 8081

if (-not $KeepDocker) {
    Write-Step "Parando Docker Compose"
    try {
        & $ComposeScript down
        Write-Ok "Containers parados"
    } catch {
        Write-Host "    Docker Compose down falhou ou Docker offline: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'wadelivery-keepalive' } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
            Write-Ok "Sessao WSL de keep-alive encerrada (PID $($_.ProcessId))"
        }
} else {
    Write-Ok "Docker mantido (--KeepDocker)"
}

Write-Host "`nAmbiente local encerrado." -ForegroundColor Green
