# Sobe o ambiente local completo para testar e administrar.
# - Docker: PostgreSQL, catalog-api, orders-api, gateway
# - Next.js admin/plataforma (:3000)
# - Fronts legados opcionais: storefront (:8080) e admin (:8081) com -LegacyFronts
#
# Uso (na raiz do repo):
#   .\scripts\dev-up.ps1
#   npm run dev:up
#   .\scripts\dev-up.ps1 -Build      # rebuild das imagens .NET
#   .\scripts\dev-up.ps1 -LegacyFronts

param(
    [switch]$Build,
    [switch]$SkipBuild,
    [switch]$NoBrowser,
    [switch]$LegacyFronts
)

$ErrorActionPreference = "Stop"
$Root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $Root
$ComposeScript = Join-Path $PSScriptRoot "docker-compose-wsl.ps1"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Ensure-LocalProxy([int]$ListenPort, [string]$TargetHost, [int]$TargetPort) {
    $existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match "wsl-portproxy\.cjs\D+$ListenPort\D+$([regex]::Escape($TargetHost))\D+$TargetPort" }
    if ($existing) {
        Write-Ok "Proxy local :$ListenPort -> ${TargetHost}:$TargetPort ja ativo."
        return
    }
    $proxyScript = Join-Path $env:TEMP "opencode\wsl-portproxy.cjs"
    $proxyDir = Split-Path -Parent $proxyScript
    if (-not (Test-Path $proxyDir)) { New-Item -ItemType Directory -Path $proxyDir -Force | Out-Null }
    $proxyCode = @'
const net = require('net');
const [,, listenPort, targetHost, targetPort] = process.argv;
if (!listenPort || !targetHost || !targetPort) process.exit(1);
const server = net.createServer((client) => {
  const target = net.connect({ host: targetHost, port: Number(targetPort) });
  client.pipe(target); target.pipe(client);
  const cleanup = () => { client.destroy(); target.destroy(); };
  client.on('error', cleanup); target.on('error', cleanup);
  client.on('close', cleanup); target.on('close', cleanup);
});
server.on('error', (e) => { console.error(e.message); process.exit(1); });
server.listen(Number(listenPort), '127.0.0.1');
'@
    [System.IO.File]::WriteAllText($proxyScript, $proxyCode, [System.Text.UTF8Encoding]::new($false))
    Start-Process -FilePath "node" -ArgumentList @($proxyScript, "$ListenPort", $TargetHost, "$TargetPort") -WindowStyle Hidden | Out-Null
    Start-Sleep -Milliseconds 400
    if (Test-PortOpen $ListenPort) {
        Write-Ok "Proxy local :$ListenPort -> ${TargetHost}:$TargetPort iniciado."
    } else {
        Write-Warn "Nao foi possivel iniciar proxy local na porta $ListenPort."
    }
}

function Ensure-WslKeepAlive() {
    # Com systemd, o WSL encerra a distro quando nenhuma sessao wsl.exe fica aberta,
    # derrubando o Docker e todos os containers ~1 min apos este script terminar.
    $existing = Get-CimInstance Win32_Process -Filter "Name='wsl.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'wadelivery-keepalive' }
    if ($existing) {
        Write-Ok "Sessao WSL de keep-alive ja ativa."
        return
    }
    Start-Process -FilePath "wsl.exe" -ArgumentList @('-d', 'Ubuntu', '--', 'bash', '-c', '"exec -a wadelivery-keepalive sleep infinity"') -WindowStyle Hidden | Out-Null
    Write-Ok "Sessao WSL de keep-alive iniciada (encerrada por dev-down)."
}

function Get-WslHostIp() {
    $addresses = & wsl.exe -d Ubuntu -- hostname -I 2>$null
    if ($LASTEXITCODE -ne 0) { return $null }
    foreach ($address in (($addresses -join " ") -split "\s+")) {
        if ($address -match '^\d{1,3}(\.\d{1,3}){3}$') { return $address }
    }
    return $null
}

function Write-TextFile([string]$Path, [string]$Content) {
    $dir = Split-Path -Parent $Path
    $tmp = Join-Path $dir ("." + [IO.Path]::GetFileName($Path) + ".tmp")
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes($Content)
    $lastError = $null
    for ($i = 1; $i -le 8; $i++) {
        try {
            [System.IO.File]::WriteAllBytes($tmp, $bytes)
            [System.IO.File]::Copy($tmp, $Path, $true)
            Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            return
        } catch {
            $lastError = $_
            Start-Sleep -Milliseconds (200 * $i)
        }
    }
    throw "Nao foi possivel gravar '$Path'. Feche o arquivo no editor e tente de novo. Detalhe: $lastError"
}

function Set-ApiBaseUrl([string]$Url) {
    # Mantém api-config.js do repositório (LAN + inject Vercel).
    # Não sobrescrever: versão antiga quebrava acesso pelo celular (localhost no phone).
    Write-Ok "api-config.js do repo (LAN = mesmo host:5100; local = $Url)"
}

function Test-PortOpen([int]$Port) {
    try {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        return $null -ne $c
    } catch {
        return $false
    }
}

function Wait-Http([string]$Url, [int]$Seconds = 90, [hashtable]$Headers = @{}) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3 -Headers $Headers
            if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { return $true }
        } catch { }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Start-Front([string]$Name, [string]$Dir, [int]$Port) {
    if (Test-PortOpen $Port) {
        Write-Warn "$Name ja esta na porta $Port - reutilizando."
        return
    }
    $arg = '/c cd /d "' + $Dir + '" & npx --yes serve . -l tcp://0.0.0.0:' + $Port
    Start-Process -FilePath "cmd.exe" -ArgumentList $arg -WindowStyle Minimized
    Write-Ok "$Name iniciando em http://0.0.0.0:$Port (LAN ok)"
}

function Start-ComposeFront([string]$Name, [string]$Service, [string]$Dir, [int]$Port, [string]$BaseUrl) {
    if ($BaseUrl -eq "http://localhost" -and (Test-PortOpen $Port)) {
        $containerId = & $ComposeScript ps -q $Service
        if ($LASTEXITCODE -eq 0 -and $containerId) {
            $running = docker inspect --format '{{.State.Running}}' $containerId
            if ($LASTEXITCODE -eq 0 -and $running -eq "true") {
                Write-Ok "$Name ja esta ativo na porta $Port."
                return $true
            }
        }
        Write-Warn "$Name nao iniciado: a porta $Port ja esta ocupada. O processo existente foi preservado."
        return $false
    }

    try {
        & $ComposeScript up --detach $Service | Out-Null
    } catch {
        if ($BaseUrl -eq "http://localhost") {
            Write-Warn "Falha ao subir $Name via Docker - tentando npm serve como fallback: $($_.Exception.Message)"
            Start-Front $Name $Dir $Port
        } else {
            Write-Warn "Falha ao subir $Name via Docker: $($_.Exception.Message)"
            return $false
        }
    }

    if (Wait-Http ("{0}:{1}/" -f $BaseUrl, $Port) 45) {
        Write-Ok "$Name OK"
        return $true
    }
    Write-Warn "$Name ainda nao respondeu"
    return $false
}

Write-Host "Delivery Platform - ambiente local" -ForegroundColor White
Write-Host "Raiz: $Root"

Write-Step "Verificando Docker"
docker version *> $null
if ($LASTEXITCODE -ne 0) {
    throw "Docker nao esta disponivel. Inicie o Ubuntu WSL e o Docker Engine e rode de novo."
}
Write-Ok "Docker OK"
Ensure-WslKeepAlive

Write-Step "Subindo banco e APIs (PostgreSQL, catalog-api, orders-api, Gateway)"
$shouldBuild = $Build -and -not $SkipBuild
if ($shouldBuild) {
    Write-Ok "Build habilitado (-Build)."
    & $ComposeScript up --build --detach postgres catalog-api orders-api gateway
} else {
    Write-Ok "Inicializacao rapida (sem rebuild). Use -Build se mudou codigo .NET/Dockerfile."
    & $ComposeScript up --detach postgres catalog-api orders-api gateway
}

Write-Step "Aguardando Gateway em :5100"
$AccessBaseUrl = "http://localhost"
$GatewayHealthUrl = "{0}:5100/api/v1/health" -f $AccessBaseUrl
$gatewayReady = Wait-Http $GatewayHealthUrl 15
if (-not $gatewayReady) {
    $wslIp = Get-WslHostIp
    if ($wslIp) {
        $wslBaseUrl = "http://$wslIp"
        $wslGatewayHealthUrl = "{0}:5100/api/v1/health" -f $wslBaseUrl
        $gatewayReadyWsl = Wait-Http $wslGatewayHealthUrl 90
        if ($gatewayReadyWsl) {
            Write-Warn "Portas do Docker WSL nao estao encaminhadas para localhost; criando proxy local."
            Ensure-LocalProxy 5100 $wslIp 5100
            $AccessBaseUrl = "http://localhost"
            $GatewayHealthUrl = "{0}:5100/api/v1/health" -f $AccessBaseUrl
            $gatewayReady = Wait-Http $GatewayHealthUrl 20
            if (-not $gatewayReady) {
                $AccessBaseUrl = $wslBaseUrl
                $GatewayHealthUrl = $wslGatewayHealthUrl
                $gatewayReady = $true
            }
        }
    } else {
        $gatewayReady = Wait-Http $GatewayHealthUrl 60
    }
}
if (-not $gatewayReady) {
    Write-Warn "Health do gateway ainda nao respondeu. Tentando catalog..."
}
$CatalogHealthUrl = "{0}:5100/api/v1/health/catalog" -f $AccessBaseUrl
$catalogReady = Wait-Http $CatalogHealthUrl 60
if (-not $catalogReady) {
    Write-Warn "Catalog health ainda falhou - reiniciando catalog/orders..."
    & $ComposeScript restart catalog-api orders-api | Out-Null
    Start-Sleep 10
    $catalogReady = Wait-Http $CatalogHealthUrl 60
}
$StoreUrl = "{0}:5100/api/v1/store" -f $AccessBaseUrl
$tenantHeaders = @{ "X-Tenant-Slug" = "fabin" }
$storeReady = Wait-Http $StoreUrl 45 $tenantHeaders
if ($catalogReady -and $storeReady) {
    Write-Ok "Gateway OK (catalog/store disponiveis)"
} elseif ($catalogReady) {
    Write-Warn "Catalog OK, mas store tenant-aware ainda nao respondeu. Rode: .\scripts\docker-compose-wsl.ps1 logs --tail 80 catalog-api"
} else {
    Write-Warn "Gateway/catalog ainda falhou. Rode: .\scripts\docker-compose-wsl.ps1 logs --tail 80 catalog-api orders-api gateway"
}
Write-Step "Subindo fronts sem encerrar processos de outras aplicacoes"
Set-ApiBaseUrl ("{0}:5100" -f $AccessBaseUrl)

$storefrontReady = $false
$adminReady = $false
if ($LegacyFronts) {
    $wslIp = Get-WslHostIp
    if ($wslIp -and $AccessBaseUrl -eq "http://localhost") {
        Ensure-LocalProxy 8080 $wslIp 8080
        Ensure-LocalProxy 8081 $wslIp 8081
    }
    & $ComposeScript --profile legacy-fronts up --detach storefront admin | Out-Null
    $storefrontReady = Wait-Http ("{0}:8080/" -f $AccessBaseUrl) 45
    $adminReady = Wait-Http ("{0}:8081/" -f $AccessBaseUrl) 45
} else {
    Write-Ok "Fronts legados 8080/8081 nao iniciados (use -LegacyFronts se precisar)."
}

if (-not (Test-PortOpen 3000)) {
    $arg = '/c cd /d "' + $Root + '" & npm run dev'
    Start-Process -FilePath "cmd.exe" -ArgumentList $arg -WindowStyle Minimized
    $nextReady = Wait-Http "http://localhost:3000/login" 120
} else {
    $nextReady = Wait-Http "http://localhost:3000/login" 10
    if (-not $nextReady) {
        Write-Warn "Porta 3000 ocupada, mas /login nao respondeu; verifique o processo Next.js atual."
    }
}

if (-not $NoBrowser) {
    if ($LegacyFronts -and $storefrontReady) { Start-Process ("{0}:8080/" -f $AccessBaseUrl) }
    if ($LegacyFronts -and $adminReady) { Start-Process ("{0}:8081/" -f $AccessBaseUrl) }
    if ($nextReady) { Start-Process "http://localhost:3000/login" }
}

Write-Host ""
Write-Host "Servicos disponiveis:" -ForegroundColor Green
if ($nextReady) {
    Write-Host "  Next.js      http://localhost:3000/"
    Write-Host "  Admin Wa     http://localhost:3000/login"
    Write-Host "  Admin legado http://localhost:3000/admin/legado"
} else {
    Write-Warn "Next.js nao iniciou; execute npm run dev em outro terminal."
}
if ($LegacyFronts) {
    if ($storefrontReady) {
        Write-Host ("  Cardapio     {0}:8080/" -f $AccessBaseUrl)
    } else {
        Write-Warn "Cardapio nao iniciou; confira se a porta 8080 esta livre."
    }
    if ($adminReady) {
        Write-Host ("  Admin        {0}:8081/   (credenciais configuradas no .env)" -f $AccessBaseUrl)
    } else {
        Write-Warn "Admin nao iniciou; confira se a porta 8081 esta livre."
    }
}
Write-Host ("  Gateway API  {0}:5100/api/v1/health" -f $AccessBaseUrl)
Write-Host ""
if ($LegacyFronts) {
  Write-Host ""
  Write-Host "  Opcoes futuras (opcionais):" -ForegroundColor Cyan
  Write-Host "    RabbitMQ UI  http://localhost:15672/"
  Write-Host "    Jaeger       http://localhost:16686/"
  Write-Host "    Subir: wsl -d Ubuntu --cd /mnt/d/wadelivery -- docker compose -f docker-compose.future-options.yml up -d"
}
try {
  $lan = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -like '192.168.*' -or $_.IPAddress -like '10.*' } |
    Select-Object -ExpandProperty IPAddress -First 1
  if ($lan) {
    Write-Host ""
    Write-Host "Na rede (celular):" -ForegroundColor Cyan
    if ($LegacyFronts -and $storefrontReady) { Write-Host "  Cardapio     http://${lan}:8080/" }
    if ($LegacyFronts -and $adminReady) { Write-Host "  Admin        http://${lan}:8081/" }
    Write-Host "  Admin Wa     http://${lan}:3000/login"
    Write-Host "  (API usa automaticamente http://${lan}:5100 - libere as portas no Firewall)"
  }
} catch { }
Write-Host ""
Write-Host "Para encerrar:  .\scripts\dev-down.ps1   ou   npm run dev:down"
