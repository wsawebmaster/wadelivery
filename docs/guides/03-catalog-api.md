# Guia 03 — Catalog API

## 1. Propósito

Backend de **loja**, **catálogo**, **auth JWT**, **frete/geo**, **ops** e **plataforma de lojas**. Persistência alternável: JSON em disco ou PostgreSQL.

## 2. Onde está no código

| Caminho | Papel |
|---------|--------|
| [`services/catalog-api/`](../../services/catalog-api/) | Projeto ASP.NET |
| [`Program.cs`](../../services/catalog-api/Program.cs) | Endpoints, CORS, auth |
| [`Repositories/`](../../services/catalog-api/Repositories/) | `JsonCatalogRepository`, `MySqlCatalogRepository` / Postgres |
| [`Data/`](../../services/catalog-api/Data/) | EF, entities, seeder |
| [`Models/Dtos.cs`](../../services/catalog-api/Models/Dtos.cs) | Contratos |
| [`data/`](../../data/) | Seed: `products.json`, `store-config.json`, … |

Config: `Persistence=Json|PostgreSQL`, `Data__Root`, `Jwt__*`, `Admin__*`, `Cors__Origins__*`.

## 3. Como rodar / testar

```powershell
cd services/catalog-api
dotnet run --launch-profile http
```

- http://localhost:5101  
- Health: `/api/v1/health`  
- OpenAPI: `/openapi/v1.json`  
- Ou: `npm run catalog` na raiz

Com Docker/`dev:up`, o tráfego público passa pelo gateway `:5100`.

## 4. Fluxos principais

### Leitura pública

1. Storefront pede `GET /store` e `GET /catalog`.  
2. Repositório lê JSON ou Postgres (seed a partir de `data/` no modo DB).

### Cotação de entrega

1. `POST /delivery/quote` (+ opcional `POST /geo/geocode`).  
2. Usa config da loja (raio, taxas, CEPs).

### Admin autenticado

1. `POST /auth/login` → JWT.  
2. Políticas: `DevOnly` / `OrdersStaff` / `PlatformDev` conforme grupo de rotas.  
3. CRUD categorias/produtos/ingredientes; upload logo/ícone.

### Plataforma

- CRUD de lojas em `/admin/platform-stores` (papel Dev).

## 5. Endpoints / pontos de extensão

Prefixo: `/api/v1`

| Grupo | Exemplos |
|-------|----------|
| Público | `/health`, `/store`, `/catalog`, `/delivery/quote`, `/geo/geocode` |
| Auth | `/auth/login`, `/auth/me` |
| Admin | `/admin/categories`, `/admin/products`, `/admin/ingredients`, `/admin/logo` |
| Ops | `/ops/accepting-orders`, `/ops/extend-hours` |
| Analytics | `/analytics/pageview`, `/analytics/hit` |
| Platform | `/admin/platform-stores` |

Contrato compartilhado: [`contracts/openapi/v1.yaml`](../../contracts/openapi/v1.yaml).

## 6. Como alterar com segurança

- Novo campo no cardápio: DTO + entity + repositório JSON **e** Postgres + seed em `data/` se for default.  
- CORS: incluir origem do front (local e Vercel).  
- Não versionar senhas reais; use `.env.example` e env do host.  
- Após mudar seed JSON, em Postgres pode ser preciso reseed/migração consciente.  
- Deploy da API: [README-DEPLOY.md](../../README-DEPLOY.md).
