# Publicação — WaDelivery

O deploy atual usa um único frontend Next.js na Vercel e os serviços .NET/PostgreSQL em infraestrutura de backend (por exemplo, Railway). Não configure projetos Vercel separados para `apps/storefront` e `apps/admin`: essas aplicações são incluídas no Next.js por meio de assets sincronizados.

## URLs do frontend

| Caminho | Função |
| --- | --- |
| `https://wadelivery.com.br/` | Landing |
| `https://wadelivery.com.br/criar-loja` | Cadastro automático de loja |
| `https://wadelivery.com.br/fabin` | Loja operacional Fabin |
| `https://wadelivery.com.br/login` | Login do painel da plataforma |
| `https://wadelivery.com.br/admin` | Painel da plataforma |
| `https://wadelivery.com.br/admin/lojas` | Gestão de lojas |
| `https://wadelivery.com.br/admin/legado` | Painel operacional completo |

`/admin/login` redireciona para `/login`. O login do painel da plataforma exige o perfil `Dev`.

## 1. Backend

Publique PostgreSQL, `catalog-api`, `orders-api` e `gateway`. Para imagens, configure um volume persistente montado em `/app/wwwroot/uploads` no serviço catalog-api. Os Dockerfiles dos serviços usam a raiz do repositório como contexto de build.

Variáveis principais:

| Serviço | Configuração |
| --- | --- |
| catalog-api | `ASPNETCORE_ENVIRONMENT=Production`, `Persistence=PostgreSQL`, `ConnectionStrings__Postgres`, `Data__Root=/app/data`, `Jwt__Key`, credenciais `Admin__*`, `Dev__*` e `Atendimento__*` |
| orders-api | `ConnectionStrings__Postgres`, mesma `Jwt__Key`, `Jwt__Issuer=delivery-catalog`, `Jwt__Audience=delivery-clients`, `CatalogApi__BaseUrl` interno e `RabbitMq__Enabled=false` |
| gateway | `ASPNETCORE_ENVIRONMENT=Docker`, URLs internas de catalog/orders e a única URL pública da API |

Use segredos fortes e exclusivos por ambiente. `Security__AllowInsecureDefaults` deve permanecer `false`. Nunca copie ou reutilize credenciais reais de outro ambiente.

Configure `PublicApp__BaseUrl=https://wadelivery.com.br` no catalog-api. A migration `AutomaticTenantProvisioning` é aplicada no startup; faça backup antes do primeiro deploy com essa migration. O upload local exige armazenamento persistente montado em `/app/wwwroot/uploads`. O provisionamento (`POST /api/lojas/criar-completa`) funciona apenas com PostgreSQL; o modo JSON local não cria lojas.

O Dockerfile publica o catalog-api em `Release` usando ImageSharp 3.2.0. O build requer uma licença Six Labors válida (`SixLaborsLicenseKey` ou `SixLaborsLicenseFile`); forneça-a pelo mecanismo seguro do pipeline e nunca a versione.

Verifique o backend pelo gateway:

```text
GET https://<gateway>/api/v1/health
GET https://<gateway>/api/v1/health/catalog
GET https://<gateway>/api/v1/health/orders
GET https://<gateway>/api/v1/store
GET https://<gateway>/api/v1/catalog
GET https://<gateway>/api/lojas/slug/<slug>
```

## 2. Vercel

Crie um único projeto Vercel apontando para a raiz do repositório:

- Framework: Next.js
- Root Directory: `.`
- Build Command: `npm run build`
- Output Directory: padrão do Next.js
- Node.js: versão suportada pelo Next.js 15

Configure no ambiente de build e runtime:

| Variável | Valor |
| --- | --- |
| `API_BASE_URL` | URL HTTPS pública do gateway |
| `NEXT_PUBLIC_API_BASE_URL` | URL HTTPS pública do gateway |

O build sincroniza `apps/storefront` e `apps/admin`. A variável `API_BASE_URL` é obrigatória no build Vercel e precisa usar HTTPS; sem ela o script de sincronização falha intencionalmente.

Adicione `wadelivery.com.br` e, se usado, `www.wadelivery.com.br` ao projeto e configure os registros DNS indicados pela Vercel.

## 3. CORS e domínios

Configure no gateway, catalog-api e orders-api as origens exatas servidas pelo Next.js, sem barra final:

```text
Cors__Origins__0=https://wadelivery.com.br
Cors__Origins__1=https://www.wadelivery.com.br
```

Para URLs Preview da Vercel, adicione origens específicas apenas se forem necessárias; evite curingas amplos. Após alterar CORS ou variáveis de backend, faça redeploy e valide chamadas no navegador.

O cardápio de cada loja usa caminho (`https://wadelivery.com.br/{slug}`), resolvido no primeiro acesso pela API. `dynamicParams = true` permite rotas sob demanda sem deploy por loja; slugs reservados são bloqueados. Não é necessário wildcard DNS.

## 4. Login e smoke test

1. Abra `https://wadelivery.com.br/login`.
2. Entre com as credenciais do perfil `Dev` configuradas no catalog-api.
3. Confirme acesso a `/admin` e `/admin/lojas`.
4. Abra `/admin/legado` e confira a operação da loja.
5. Abra `/fabin` e valide catálogo, carrinho, checkout e pedidos com o gateway disponível.
6. Abra `/criar-loja` e valide o fluxo de criação em um ambiente de teste PostgreSQL, incluindo slug duplicado e credenciais temporárias.
7. Teste um slug inexistente: deve retornar 404.

Não use senhas de desenvolvimento em produção. A criação só é confirmada após resposta de sucesso da API; o endpoint não envia confirmação por e-mail.

## Ambiente local

Consulte [README.md](README.md) e [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md). O ambiente completo usa Docker Compose e `.env`; o modo leve não inicia orders-api e não valida o fluxo completo de pedidos. O arquivo [`.env.example`](.env.example) contém apenas placeholders.
