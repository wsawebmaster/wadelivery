# Arquitetura — Delivery Platform

## Visão

Plataforma API-first de delivery e consumo no local: microfrontends (storefront/admin), microserviços (catalog/orders), mensageria, observabilidade e persistência multi-tenant.

## Componentes

| Componente | Pasta | Responsabilidade |
|------------|-------|------------------|
| Storefront | `apps/storefront` | Cardápio PWA (HTML/CSS/JS) — Vercel |
| Admin MF | `apps/admin` | Painel admin (deploy independente) |
| Gateway | `services/gateway` | YARP + correlation id + CORS |
| Catalog API | `services/catalog-api` | Store + catálogo + JWT + CRUD + frete |
| Orders API | `services/orders-api` | Pedidos + SSE + RabbitMQ `OrderCreated` |
| Dados seed | `data/*.json` | Catálogo e config iniciais |
| Contrato | `contracts/openapi/v1.yaml` | OpenAPI compartilhado |

## Persistência

- `Persistence=Json` (padrão local): lê/grava `data/products.json` e `data/store-config.json`
- `Persistence=PostgreSQL` (ou `Postgres`): EF Core + Npgsql; seed automático a partir do JSON

## Papéis (admin)

| Papel | Uso típico |
|-------|------------|
| Admin | Pedidos, dashboard, loja, categorias, produtos |
| Atendimento | Pedidos (operação) |
| Dev | Plataforma: lojas / sistemas |

JWT emitido pela catalog-api (`POST /api/v1/auth/login`). Detalhes: [guides/02-admin.md](guides/02-admin.md).

## Fluxo de pedido

1. Storefront valida checkout
2. `POST /api/v1/orders` via Gateway → Orders API
3. Persistência PostgreSQL + publish `order.created` no RabbitMQ (quando disponível)
4. Consumer audita o evento
5. Admin recebe updates via **SSE** (`GET /api/v1/orders/stream`) com fallback para poll
6. WhatsApp continua como canal de confirmação com o cliente

`AcceptedAtUtc` marca o aceite e alimenta alertas de SLA no painel.

## Observabilidade

- Serilog (logs estruturados)
- OpenTelemetry → OTLP (Jaeger em `http://localhost:16686`)

## Como rodar

Ver **[GETTING-STARTED.md](GETTING-STARTED.md)**.

## Guias por recurso

- [guides/01-storefront.md](guides/01-storefront.md)
- [guides/02-admin.md](guides/02-admin.md)
- [guides/03-catalog-api.md](guides/03-catalog-api.md)
- [guides/04-orders-api.md](guides/04-orders-api.md)
- [guides/05-gateway-observabilidade.md](guides/05-gateway-observabilidade.md)
- [guides/06-como-atualizar.md](guides/06-como-atualizar.md)
- [specs/consumo-local.md](specs/consumo-local.md) — mesa, QR Code e pedidos do garçom

Deploy: [README-DEPLOY.md](../README-DEPLOY.md).
