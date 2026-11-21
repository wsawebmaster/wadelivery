# Guia 05 — Gateway e observabilidade

## 1. Propósito

**Gateway YARP** (`:5100`): porta única para fronts → catalog-api e orders-api.  
**Observabilidade**: Serilog + OpenTelemetry → Jaeger; health nos serviços; RabbitMQ UI para fila.

## 2. Onde está no código

| Caminho | Papel |
|---------|--------|
| [`services/gateway/`](../../services/gateway/) | YARP + CORS + correlation |
| [`docker-compose.yml`](../../docker-compose.yml) | gateway, APIs, Postgres, RabbitMQ, Jaeger |
| Config OTel | `Program.cs` / appsettings dos serviços |

Rotas típicas do gateway: `/api/v1/*` → catalog ou orders conforme path (`/orders` → orders-api; resto catalog).

## 3. Como rodar / testar

Stack completa:

```powershell
npm run dev:up
# ou
docker compose up --build -d
```

| URL | O quê |
|-----|--------|
| http://localhost:5100 | Gateway |
| http://localhost:5100/api/v1/health | Health (via YARP) |
| http://localhost:16686 | Jaeger UI |
| http://localhost:15672 | RabbitMQ (`guest`/`guest` local) |

Só gateway local (APIs já rodando):

```powershell
npm run gateway
```

Fronts devem usar `API_BASE_URL=http://localhost:5100`.

## 4. Fluxos principais

### Proxy

1. Browser chama `https://…/api/v1/...` no gateway.  
2. YARP encaminha para o serviço certo.  
3. Correlation id / headers de tracing propagam para OTel.

### Traces

1. Requisição atravessa gateway → API.  
2. Spans exportados OTLP para o collector/Jaeger.  
3. Inspecionar em http://localhost:16686.

### Health

- Cada API expõe `/api/v1/health`.  
- Compose reinicia catalog/orders se Postgres ainda não estiver pronto (aguardar ou `docker compose restart`).

## 5. Endpoints / extensão

- Não inventar regras de negócio no gateway: só roteamento, CORS e cross-cutting.  
- Novas rotas de API: ajustar cluster/route no YARP se o path não cair nas regras atuais.  
- CORS: origens dos fronts (localhost + Vercel) no gateway **e/ou** nas APIs, conforme o deploy.

## 6. Como alterar com segurança

- Mudança de porta: atualizar Compose, `api-config.js` e docs.  
- Produção: gateway no Railway (ver [README-DEPLOY.md](../../README-DEPLOY.md)); Jaeger/Rabbit costumam ficar só em demo local.  
- Não expor RabbitMQ UI na internet sem autenticação forte.  
- Após alterar rotas YARP, validar storefront + admin + tracking de pedido ponta a ponta.
