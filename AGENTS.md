# Guia para agentes

## Estado atual

WaDelivery é um monorepo com landing Next.js, loja operacional Fabin, painel administrativo e APIs .NET. A integração foi autorizada para este repositório; não altere `D:\delivery`, que permanece como origem separada.

- `app/`, `components/`, `lib/`: landing, painel da plataforma e rotas Next.js.
- `/login`: entrada do painel da plataforma; `/admin/login` redireciona para `/login`.
- `/admin/lojas`: gestão da plataforma; `/admin/legado`: painel operacional existente.
- `/{slug}/admin`: painel do proprietário da loja (o mesmo `apps/admin` em modo loja, `?tenant={slug}`). Sessão separada por loja, `X-Tenant-Slug` em todas as chamadas e login recusado para usuários de outra loja ou perfil `Dev`. `/admin` é exclusivo da plataforma (perfil `Dev`).
- `/criar-loja`: formulário de quatro etapas; o provisionamento real requer catalog-api com PostgreSQL.
- `POST /api/lojas/criar-completa`: cria a loja, `AdminLoja`, dados padrão e imagens dentro do fluxo transacional. A senha temporária é exibida apenas na resposta; não há envio por e-mail. Cada loja nasce com o cardápio de exemplo do segmento (`Services/SampleCatalog.cs`: categorias + dois produtos com fotos do Unsplash em `services/catalog-api/Assets/sample-products`, copiadas para os uploads com prefixo `exemplo-`) e, sem logo enviado, um logo padrão em SVG (`Services/DefaultLogo.cs`, arquivo `logo-padrao-*`). O checklist do painel não conta esses itens como concluídos.
- `GET /api/lojas/slug/{slug}` e `app/[slug]`: resolução pública de tenants por caminho. A URL planejada/implementada é `/{slug}`, não subdomínio.
- `/fabin`: storefront original em `apps/storefront`, publicado em `public/storefront` por `scripts/sync-storefront.mjs`.
- `apps/admin`: painel operacional original, publicado em `public/legacy-admin` por `scripts/sync-legacy-admin.mjs`.
- `services/`: catalog-api, orders-api e gateway .NET.
- `data/`: seed/configuração local; PostgreSQL é usado no ambiente completo.

## Comportamento e limitações conhecidas

- `/{slug}` (inclui `/fabin`) é servido por `app/[slug]/(cardapio)/route.ts`: o servidor entrega o `index.html` do storefront com `<base href="/storefront/">`, a loja em `window.WA_TENANT_SLUG`, SEO (título, descrição, canônica, Open Graph), JSON-LD Restaurant/Menu e os produtos no HTML (`lib/storefront-ssr.ts`); o app assume a página em seguida. Não há mais iframe. `/storefront/index.html?tenant=` continua válido (prévia do painel, QR de mesa).
- Lojas da plataforma usam rolagem vertical por seções (`body.menu-vertical`); a Fabin mantém o carrossel e o visual original. Carrinho, último pedido, acompanhamento e sessões de equipe ficam em chaves de storage por loja (a Fabin mantém as chaves antigas). Slug inexistente retorna 404 e API indisponível retorna 503.
- O cadastro automatizado depende de PostgreSQL, migration aplicada e armazenamento persistente para uploads; o modo JSON/leve não provisiona lojas.
- Cobrança de mensalidades (`Services/BillingPolicy.cs`, `BillingWorker`): a loja nova nasce com teste grátis de `Billing:TrialDays` dias (padrão 30) e mensalidade `Billing:DefaultMonthlyFee`; ao fim do teste vira cobrança pendente. Vencida, fica "overdue"; passados `Billing:BlockAfterDays` dias (padrão 5) é bloqueada automaticamente (`Active=false`, `BillingBlocked=true`: cardápio 403 e orders-api recusa pedidos). Registrar pagamento desbloqueia; bloqueio manual nunca é desfeito pela rotina. A rotina roda a cada `Billing:IntervalMinutes` (60) apenas com PostgreSQL. Gestão em `/admin/lojas` → "Cobrança"; o lojista vê o aviso no painel (`GET /api/v1/admin/billing`). Não há cobrança automática (boleto/Pix) nem integração de e-mail, CRM ou WhatsApp.
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
