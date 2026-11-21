# Guia para agentes

## Estado atual

WaDelivery é um monorepo com landing Next.js, loja operacional Fabin, painel administrativo e APIs .NET. A integração foi autorizada para este repositório; não altere `D:\delivery`, que permanece como origem separada.

- `app/`, `components/`, `lib/`: landing, painel da plataforma e rotas Next.js.
- `/login`: entrada do painel da plataforma; `/admin/login` redireciona para `/login`.
- `/admin/lojas`: gestão da plataforma; `/admin/legado`: painel operacional existente.
- `/criar-loja`: formulário de quatro etapas; o provisionamento real requer catalog-api com PostgreSQL.
- `POST /api/lojas/criar-completa`: cria a loja, `AdminLoja`, dados padrão e imagens dentro do fluxo transacional. A senha temporária é exibida apenas na resposta; não há envio por e-mail.
- `GET /api/lojas/slug/{slug}` e `app/[slug]`: resolução pública de tenants por caminho. A URL planejada/implementada é `/{slug}`, não subdomínio.
- `/fabin`: storefront original em `apps/storefront`, publicado em `public/storefront` por `scripts/sync-storefront.mjs`.
- `apps/admin`: painel operacional original, publicado em `public/legacy-admin` por `scripts/sync-legacy-admin.mjs`.
- `services/`: catalog-api, orders-api e gateway .NET.
- `data/`: seed/configuração local; PostgreSQL é usado no ambiente completo.

## Comportamento e limitações conhecidas

- `/fabin` mantém o storefront original dentro de um iframe e depende das APIs para catálogo, checkout e pedidos.
- `/fabin` mantém o storefront original dentro de um iframe. Lojas cadastradas pela API são resolvidas por slug, carregam as configurações visuais e exibem 404 se não existirem.
- O cadastro automatizado depende de PostgreSQL, migration aplicada e armazenamento persistente para uploads; o modo JSON/leve não provisiona lojas.
- O cadastro marca lojas como teste/cortesia sem expiração automática definida. Não há integração de e-mail, CRM ou WhatsApp.
- A pilha completa de pedidos requer `npm run dev:up`, Docker e um `.env` local preenchido. `npm run dev:up:light` não inicia orders-api.
- `npm run lint` não é uma validação automatizada utilizável enquanto não houver configuração ESLint compatível.

Não descreva capacidades planejadas como implementadas. Para funcionalidades de tenant, confirmar o contrato OpenAPI e usar a API como fonte de verdade; nunca confiar apenas no `tenant_id` enviado pelo cliente.

## Regras de implementação

- Faça alterações pequenas, leia os consumidores diretos e atualize rotas, links e estilos relacionados.
- Preserve `apps/storefront` e `apps/admin` como fontes; não edite manualmente suas cópias geradas em `public/`.
- Não copie segredos de `D:\delivery`, não versione `.env` e não coloque credenciais no código do navegador.
- A URL do backend deve vir de configuração: `API_BASE_URL` para o storefront e `NEXT_PUBLIC_API_BASE_URL` para o painel Next.js. Produção exige HTTPS e CORS configurado no gateway e nas APIs.
- Mantenha a lista `RESERVED_SLUGS` alinhada às rotas internas e valide slugs também no backend.
- Mantenha slugs reservados consistentes entre `lib/tenant-hosts.ts` e `CatalogInputValidation`; nunca permita que um slug de loja sobrescreva uma rota interna.
- Não altere `D:\delivery`; todas as escritas desta integração devem ficar neste repositório.
- Não adicione serviços ou dependências fora do escopo sem decisão explícita.

## Comandos e validação

```bash
npm run dev
npm run build
npm run dev:up
npm run dev:down
npm run dev:up:light
dotnet test services/catalog-api.Tests/Catalog.Api.Tests.csproj
dotnet test services/orders-api.Tests/Orders.Api.Tests.csproj
```

`npm run dev` inicia apenas o Next.js na porta 3000. O modo completo usa Docker/Compose e requer `.env`; copie `.env.example` e substitua os placeholders por valores locais próprios. O modo leve não valida pedidos. Antes de concluir alterações, valide o build ou o teste focado correspondente e informe limitações reais.
