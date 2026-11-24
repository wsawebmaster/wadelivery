<#
.SYNOPSIS
  Libera a API do WaDelivery (gateway :5100) para outros aparelhos da rede local (celular).

.DESCRIPTION
  O Docker roda dentro do WSL e publica a porta 5100 só em localhost do Windows. Este script
  cria um encaminhamento (netsh portproxy) do IP da rede para 127.0.0.1:5100 e uma regra de
  firewall de entrada restrita ao perfil de rede Privado. Execute uma vez como administrador.
  Se o IP do computador mudar (DHCP), execute de novo.

.EXAMPLE
  .\scripts\lan-expose.ps1                     # detecta o IP da placa ativa
  .\scripts\lan-expose.ps1 -Address 192.168.15.7
  .\scripts\lan-expose.ps1 -Remove             # desfaz encaminhamento e regra
#>
[CmdletBinding()]
param(
    [string]$Address,
    [int]$Port = 5100,
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$RuleName = "WaDelivery API (rede local) $Port"

function Test-Admin {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    return ([Security.Principal.WindowsPrincipal]$identity).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

if (-not (Test-Admin)) {
    Write-Host "Execute este script como administrador:" -ForegroundColor Yellow
    Write-Host "  Abra o PowerShell com 'Executar como administrador' e rode: .\scripts\lan-expose.ps1"
    exit 1
}

function Get-LanAddress {
    # IPv4 privado da placa ativa (Wi-Fi/Ethernet); ignora WSL/Hyper-V, VirtualBox e APIPA.
    $candidates = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object {
            $_.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)' -and
            $_.InterfaceAlias -notmatch 'vEthernet|WSL|VirtualBox|VMware|Loopback|Bluetooth'
        }
    $withGateway = $candidates | Where-Object {
        (Get-NetIPConfiguration -InterfaceIndex $_.InterfaceIndex -ErrorAction SilentlyContinue).IPv4DefaultGateway
    }
    # @() garante lista mesmo com um único resultado (CimInstance não soma com +).
    return @(@($withGateway) + @($candidates) | Where-Object { $_ } | Select-Object -ExpandProperty IPAddress -Unique)[0]
}

# Remove encaminhamentos anteriores desta porta (IP antigo, reexecução).
$existing = netsh interface portproxy show v4tov4 | Select-String -Pattern "^\s*(\S+)\s+$Port\s+"
foreach ($line in $existing) {
    $listen = $line.Matches[0].Groups[1].Value
    netsh interface portproxy delete v4tov4 listenaddress=$listen listenport=$Port | Out-Null
}
Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue | Remove-NetFirewallRule

if ($Remove) {
    Write-Host "Encaminhamento e regra de firewall da porta $Port removidos." -ForegroundColor Green
    exit 0
}

if (-not $Address) { $Address = Get-LanAddress }
if (-not $Address) {
    Write-Host "Não encontrei um IP de rede local. Informe com -Address 192.168.x.y" -ForegroundColor Red
    exit 1
}

# O portproxy depende do serviço "Auxiliar IP".
$svc = Get-Service iphlpsvc -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Running') { Start-Service iphlpsvc }

# IP específico (não 0.0.0.0): o wslrelay já escuta em 127.0.0.1:$Port.
netsh interface portproxy add v4tov4 listenaddress=$Address listenport=$Port connectaddress=127.0.0.1 connectport=$Port | Out-Null
New-NetFirewallRule -DisplayName $RuleName -Direction Inbound -Protocol TCP -LocalPort $Port `
    -LocalAddress $Address -Action Allow -Profile Private | Out-Null

Write-Host "API liberada na rede: http://${Address}:$Port (firewall: só perfil Privado)" -ForegroundColor Green
try {
    $r = Invoke-WebRequest -Uri "http://${Address}:$Port/api/v1/segment-palettes" -TimeoutSec 5 -UseBasicParsing
    Write-Host "Teste da API pelo IP da rede: $($r.StatusCode)" -ForegroundColor Green
} catch {
    Write-Host "A API não respondeu em http://${Address}:$Port — confira se o ambiente está no ar (npm run dev:up)." -ForegroundColor Yellow
}

$netCategory = (Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object -First 1).NetworkCategory
if ($netCategory -and $netCategory -ne 'Private') {
    Write-Host "Atenção: a rede atual está como '$netCategory'. A regra vale só para redes Privadas;" -ForegroundColor Yellow
    Write-Host "marque a rede como Privada em Configurações > Rede e Internet." -ForegroundColor Yellow
}
Write-Host "No celular (mesma rede), abra: http://${Address}:3000" -ForegroundColor Cyan
