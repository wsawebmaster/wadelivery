# Encerra o modo leve (Next.js, storefront, admin e APIs locais)
$ErrorActionPreference = "Continue"

function Stop-Port([int]$Port) {
    Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        Write-Host "Parado PID $($_.OwningProcess) na porta $Port"
    }
}

Stop-Port 3000
Stop-Port 8080
Stop-Port 8081
Stop-Port 5100
Stop-Port 5101
Write-Host "Modo leve encerrado."
