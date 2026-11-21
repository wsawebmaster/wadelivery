# WaDelivery

WaDelivery reúne a landing page Next.js, a loja operacional Fabin, o painel administrativo e os serviços de API em um único repositório. O código de origem foi integrado a partir de `D:\delivery`; esse diretório de origem não é alterado por este projeto.

## O que está implementado

- **Landing page:** Next.js em `/`.
- **Cadastro automático de lojas:** `/criar-loja` oferece um formulário de quatro etapas. Com o catalog-api em PostgreSQL, o envio cria a loja, o administrador `AdminLoja`, categorias e produto de exemplo, cinco mesas e os arquivos enviados; a senha temporária é exibida somente na confirmação.
- **Loja Fabin:** `/fabin` carrega o storefront operacional existente em um `iframe` de mesma origem. A implementação original fica em `apps/storefront` e é publicada em `public/storefront` antes de `dev` e `build`. Inclui cardápio, carrinho, endereço/frete, checkout, pedidos, acompanhamento e PWA; os dados e pedidos dependem das APIs.
- **Lojas por slug:** `/{slug}` consulta `GET /api/lojas/slug/{slug}`; lojas existentes carregam o storefront com as configurações visuais salvas. Slugs inválidos/inexistentes retornam 404 e indisponibilidade da API apresenta opção para tentar novamente.
- **Painel da plataforma:** `/login`, `/admin` e `/admin/lojas`, com acesso de perfil `Dev`. `/admin/login` redireciona para `/login`.
- **Painel operacional completo:** `/admin/legado` incorpora o painel existente de `apps/admin` e compartilha a sessão do mesmo domínio.
- **APIs:** `services/catalog-api`, `services/orders-api` e gateway YARP em `services/gateway`.
- **Dados iniciais:** `data/products.json`, `data/ingredients.json`, `data/store-config.json` e `data/platform-stores.json`. O backend pode usar JSON local ou PostgreSQL.

O slug `gota-acai` continua disponível como demonstração local. O provisionamento automatizado requer `Persistence=PostgreSQL`; o modo JSON/leves não cria lojas. O formulário não envia leads a CRM, WhatsApp ou e-mail: ao ser enviado, ele solicita à API a criação real da loja.

## Rotas principais

| URL local | Conteúdo |
| --- | --- |
| `http://localhost:3000/` | Landing page |
| `http://localhost:3000/criar-loja` | Cadastro automático de loja |
| `http://localhost:3000/fabin` | Loja Fabin operacional |
| `http://localhost:3000/login` | Login do painel da plataforma |
| `http://localhost:3000/admin` | Dashboard da plataforma |
| `http://localhost:3000/admin/lojas` | Gestão/listagem das lojas |
| `http://localhost:3000/admin/legado` | Painel operacional completo |

O login da plataforma exige o perfil `Dev`; os usuários e senhas são definidos pela configuração local ou pelo ambiente de produção. O painel completo também aplica as permissões e regras da API.

Após criar uma loja, use o endereço público exibido e entre no painel operacional em `/admin/legado` com o e-mail e a senha temporária mostrados na confirmação. A senha não é enviada por e-mail. A URL pública segue o formato `https://wadelivery.com.br/{slug}` (caminho, não subdomínio).

## Executar localmente

Pré-requisitos: Node.js/npm, .NET 10 SDK e, para o ambiente completo, Docker com Compose.

1. Crie o arquivo local de configuração e substitua os valores de exemplo por valores próprios:

   ```powershell
   Copy-Item .env.example .env
   ```

   Configure ao menos `POSTGRES_PASSWORD`, `JWT_KEY`, `ADMIN_PASSWORD`, `DEV_PASSWORD` e `ATENDIMENTO_PASSWORD`. O `.env` é ignorado pelo Git; não o compartilhe nem o versione.

2. Inicie o ambiente completo:

   ```bash
   npm install
   npm run dev:up
   ```

   O ambiente completo sobe PostgreSQL, as APIs, o gateway, o storefront, o admin legado e o Next.js. Acesse as rotas da tabela acima. O script também disponibiliza os frontends legados em `http://localhost:8080` e `http://localhost:8081`.

3. Encerre o ambiente:

   ```bash
   npm run dev:down
   ```

Para executar apenas o Next.js, use `npm run dev` (porta 3000); as APIs precisam estar disponíveis separadamente. `npm run dev:up:light` inicia catalog-api em JSON, gateway e frontends sem Docker, mas **não inicia orders-api**; portanto, não substitui o ambiente completo para validar o fluxo de pedidos.

### Build e testes

```bash
npm run build
npm start
dotnet test services/catalog-api.Tests/Catalog.Api.Tests.csproj
dotnet test services/orders-api.Tests/Orders.Api.Tests.csproj
```

O build do Next sincroniza as cópias públicas do storefront e do painel legado. O script `npm run lint` ainda usa `next lint` sem configuração ESLint e atualmente abre o assistente interativo; não é uma validação automatizada utilizável.

## Estrutura

| Caminho | Responsabilidade |
| --- | --- |
| `app/`, `components/`, `lib/`, `styles/` | Landing, rota de loja Next.js e painel da plataforma |
| `apps/storefront/` | Loja operacional Fabin (HTML/CSS/JavaScript e PWA) |
| `apps/admin/` | Painel operacional legado |
| `services/catalog-api/` | Catálogo, loja, autenticação e gestão de tenants |
| `services/orders-api/` | Pedidos e eventos de acompanhamento |
| `services/gateway/` | Entrada única e roteamento YARP |
| `data/` | Catálogo e configuração usados como seed/persistência JSON |
| `contracts/openapi/` | Contrato OpenAPI |
| `infra/`, `docker-compose.yml` | Configuração local de banco, serviços e arquivos estáticos |

## Produção e multi-tenancy

O frontend Next.js pode ser publicado na Vercel; as APIs e PostgreSQL devem ser hospedados em infraestrutura de backend, como Railway. Configure `API_BASE_URL` para o storefront e `NEXT_PUBLIC_API_BASE_URL` para o painel Next.js. Em produção, use HTTPS e adicione a origem do frontend ao CORS das APIs e do gateway.

Configure também `PublicApp__BaseUrl=https://wadelivery.com.br` no catalog-api e um volume persistente para `/app/wwwroot/uploads`. A migration `AutomaticTenantProvisioning` é aplicada no startup do catalog-api; faça backup do banco antes de atualizar produção. O endpoint `POST /api/lojas/criar-completa` só fica disponível com PostgreSQL. A rota Next resolve lojas pelo caminho `/{slug}`, sem wildcard DNS; slugs internos são reservados no frontend e no backend.

O cadastro marca a loja como teste/cortesia (`IsTeste=true`, plano `teste`), sem prazo de expiração definido. Ainda não há envio de e-mail nem período de teste automático. O provisionamento cria o usuário inicial e devolve uma senha temporária em texto apenas na resposta de criação.

Consulte [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md), [docs/architecture.md](docs/architecture.md) e [README-DEPLOY.md](README-DEPLOY.md) para detalhes operacionais. Não faça commits ou crie branches durante tarefas de manutenção sem solicitação explícita.
