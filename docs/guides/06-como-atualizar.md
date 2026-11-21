# Guia 06 — Como atualizar com segurança

Checklist para evoluir o monorepo sem quebrar cache, APIs ou seed.

## Fluxo recomendado

```text
feature local → validar UI → bump cache front → API/DTO → seed data/ → deploy API → deploy front
```

## 1. Feature local

1. Suba o ambiente: [GETTING-STARTED.md](../GETTING-STARTED.md) (`dev:up` ou `dev:up:light`).  
2. Altere o mínimo necessário (um recurso por vez).  
3. Teste o caminho feliz + um erro esperado (CEP inválido, API fora, etc.).

## 2. Cache do front (`?v=`)

Arquivos estáticos (CSS/JS) e PWA ficam cacheados no celular.

| App | O que fazer |
|-----|-------------|
| Storefront | Incrementar `?v=` em [`apps/storefront/index.html`](../../apps/storefront/index.html) ou `node apps/storefront/scripts/bump-cache.js` |
| Admin | Incrementar `?v=` em [`apps/admin/index.html`](../../apps/admin/index.html) se houver query de cache nos assets |
| SW | Se mudou `sw.js` / manifest, peça hard refresh ou limpar service worker no teste |

Sem bump, produção “parece” não ter atualizado.

## 3. APIs e contratos

1. Atualize DTO + endpoint + OpenAPI ([`contracts/openapi/v1.yaml`](../../contracts/openapi/v1.yaml)) se a mudança for pública.  
2. Mantenha compatibilidade: campos novos opcionais quando possível.  
3. Catalog **e** Orders: se o front chama pelo gateway, teste via `:5100`, não só a porta direta.  
4. Auth: novas rotas admin precisam da policy correta (`DevOnly`, `OrdersStaff`, `PlatformDev`).

## 4. Seed e persistência

| Modo | Atenção |
|------|---------|
| Json | Edite `data/*.json`; reinicie catalog-api se necessário |
| PostgreSQL | Seed no boot; mudanças de schema → migration/EF + dados existentes |

Não apague dados de produção sem backup. Export de cardápio no admin ajuda em backup operacional.

## 5. Deploy (ordem)

1. **API / gateway** no host .NET (Railway etc.) — health + `/store` + `/catalog` ok.  
2. **CORS** com URL exata do front.  
3. **Front** na Vercel (`API_BASE_URL` apontando para o gateway).  
4. Hard refresh / validar PWA.

Detalhes: [README-DEPLOY.md](../../README-DEPLOY.md). Não duplicar passos longos aqui.

## 6. Checklist rápido pré-merge

- [ ] Storefront carrega loja e catálogo  
- [ ] Frete/CEP com feedback visual  
- [ ] Pedido cria e aparece no admin  
- [ ] SSE ou poll atualiza lista  
- [ ] `?v=` bumpado se CSS/JS mudou  
- [ ] Nenhum secret em commit (`.env`, JWT real)  
- [ ] Credenciais de demo só em Development  

## Guias relacionados

- [01-storefront.md](01-storefront.md)  
- [02-admin.md](02-admin.md)  
- [03-catalog-api.md](03-catalog-api.md)  
- [04-orders-api.md](04-orders-api.md)  
- [05-gateway-observabilidade.md](05-gateway-observabilidade.md)  
- [specs/consumo-local.md](../specs/consumo-local.md) — Spec de mesa, QR Code e pedidos do garçom  
