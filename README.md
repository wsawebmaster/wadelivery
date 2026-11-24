# WaDelivery

WaDelivery reúne a landing page Next.js, a loja operacional Fabin, o painel administrativo e os serviços de API em um único repositório. O código de origem foi integrado a partir de `D:\delivery`; esse diretório de origem não é alterado por este projeto.

## O que está implementado

- **Landing page:** Next.js em `/`.
- **Cadastro automático de lojas:** `/criar-loja` oferece um formulário de quatro etapas. Com o catalog-api em PostgreSQL, o envio cria a loja, o administrador `AdminLoja`, o cardápio de exemplo do segmento (categorias e dois produtos com foto real), um logo padrão moderno (monograma nas cores do segmento, quando nenhum logo é enviado), cinco mesas e os arquivos enviados; a senha temporária é exibida somente na confirmação. Nos dois modos (teste rápido e completo) o cadastro pede o endereço da loja e a cobrança da entrega: taxa fixa ou valor por km, com distância máxima. A API localiza a loja pelo CEP e grava os campos usados pelo painel (taxa fixa = taxa por km 0 + taxa mínima com o valor fixo); se o endereço não for localizado, a loja é criada com pedidos desativados e a confirmação explica como ajustar no painel.
- **Mensalidades:** a loja nova começa com teste grátis (`BILLING_TRIAL_DAYS`, padrão 30 dias). Em `/admin/lojas` → **Cobrança** a plataforma define mensalidade, vencimento e cortesia, registra pagamentos (com histórico) e bloqueia/desbloqueia a loja. Mensalidade vencida gera aviso no painel do lojista; passados `BILLING_BLOCK_AFTER_DAYS` dias (padrão 5) a loja é bloqueada automaticamente (cardápio fora do ar e pedidos recusados) até o pagamento ser registrado. Não há cobrança automática por boleto/Pix.
- **Cardápio das lojas:** `/{slug}` (inclusive `/fabin`) entrega o storefront operacional direto na página, renderizado no servidor com SEO, dados estruturados e produtos no HTML (indexável), e o app assume carrinho, checkout, mesa e acompanhamento. A implementação fica em `apps/storefront` e é publicada em `public/storefront` antes de `dev` e `build`. Lojas da plataforma usam rolagem vertical por categorias; a Fabin mantém o layout original.
- **Acesso do lojista:** a senha temporária do cadastro (ou redefinida pela plataforma) exige troca no primeiro acesso; o lojista também troca a senha pelo menu da conta. "Esqueci minha senha" orienta a pedir a redefinição à plataforma (não há envio de e-mail). O painel mostra o aviso da mensalidade (vencimento próximo, vencida com data de bloqueio ou loja bloqueada) e o checklist "Complete sua loja" (logo próprio, Pix, mapa, entrega, horário, produtos próprios e fotos; o logo padrão e os produtos de exemplo não contam).
- **Lojas por slug:** `/{slug}` consulta `GET /api/lojas/slug/{slug}`; lojas existentes carregam o storefront com as configurações visuais salvas. Slugs inválidos/inexistentes retornam 404 e indisponibilidade da API apresenta opção para tentar novamente.
- **Painel da plataforma:** `/login`, `/admin` e `/admin/lojas`, com acesso de perfil `Dev`. `/admin/login` redireciona para `/login`. O dashboard mostra receita recorrente, cadastros, ações do dia (vencidas, testes terminando, bloqueadas, prestes a expirar por abandono), funil de ativação dos lojistas e pedidos por loja. Cada loja tem uma página (`/admin/lojas/{id}`) com dados cadastrais, cobrança, segmento, usuários (redefinição de senha com senha temporária gerada), logo, histórico de ações e zona de risco. Toda alteração da plataforma e das rotinas automáticas fica registrada no histórico. O lembrete de cobrança abre o WhatsApp do lojista com a mensagem pronta (link `wa.me`; sem envio automático).
- **Painel operacional antigo:** `/admin/legado` incorpora o painel existente de `apps/admin` e compartilha a sessão do mesmo domínio. Fica fora do menu (acesso pela URL); hoje só ele oferece o explorador do banco, duplicar loja e galeria.
- **APIs:** `services/catalog-api`, `services/orders-api` e gateway YARP em `services/gateway`.
- **Dados iniciais:** `data/products.json`, `data/ingredients.json`, `data/store-config.json` e `data/platform-stores.json`. O backend pode usar JSON local ou PostgreSQL.

No momento, a única loja cadastrada é a Fabin (`/fabin`); slugs sem loja na API retornam 404. O provisionamento automatizado requer `Persistence=PostgreSQL`; o modo JSON/leves não cria lojas. O formulário não envia leads a CRM, WhatsApp ou e-mail: ao ser enviado, ele solicita à API a criação real da loja.

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
| `http://localhost:3000/{slug}/admin` | Painel do proprietário da loja (ex.: `/fabin/admin`) |

Em **Loja → Aparência** o proprietário escolhe o modelo dos cards de produto (Moderno, Foto grande, Vitrine, Lista horizontal, Minimalista, Destaque ou Compacto) e as cores da loja, com prévia ao vivo do cardápio real. Lojas novas nascem com a paleta do segmento (Lanchonete, Hamburgueria, Pizzaria, Marmitaria ou Açaí; demais usam o azul padrão), definida em `services/catalog-api/Services/SegmentPalettes.cs` e exposta em `GET /api/v1/segment-palettes`; o proprietário pode trocar cores, logo e marca a qualquer momento e voltar ao padrão com "Usar cores do segmento". Ao salvar, o cardápio aberto pelos clientes se atualiza sozinho na próxima consulta da loja (até 60 s). O cardápio da Fabin mantém o visual original.

Recursos do cardápio configuráveis no painel da loja: **selos nos produtos** (Produtos → Selo de destaque: Rei da Casa, Mais Pedido, Novidade, Promoção, Para Dividir, Vegetariano) e **destaque no topo** (Loja → Aparência: título, subtítulo e produto carro-chefe, com tempo médio de entrega e formas de pagamento). No cardápio: selo de horário no cabeçalho (aberto, fecha em breve, pausa, fechado com o próximo horário de abertura) atualizado a cada 30 s, **troco rápido** no pagamento em dinheiro (sem troco, R$ 50, R$ 100, R$ 200 ou outro valor) e **tema claro/escuro** escolhido pelo cliente (salvo no navegador; lojas com tema próprio).

No painel da loja, **Loja → Mensagem WhatsApp** mostra a mensagem que o cliente envia ao WhatsApp da loja ao concluir o pedido e permite personalizá-la com variáveis (`{loja}`, `{pedido}`, `{itens}`, `{total}`, `{pagamento}`, `{endereco_entrega}`, `{cliente}`…), com prévia e opção de restaurar o padrão. O texto padrão fica em `services/catalog-api/Services/WhatsAppOrderTemplate.cs`; o cardápio mantém uma cópia como fallback.

O login da plataforma exige o perfil `Dev`; os usuários e senhas são definidos pela configuração local ou pelo ambiente de produção. O painel completo também aplica as permissões e regras da API.

Após criar uma loja, use o endereço público exibido e entre no painel da loja em `/{slug}/admin` com o e-mail e a senha temporária mostrados na confirmação. Cada loja tem sessão própria; usuários de outra loja e o perfil `Dev` são recusados ali (a plataforma usa `/admin`). A senha não é enviada por e-mail. A URL pública segue o formato `https://wadelivery.com.br/{slug}` (caminho, não subdomínio).

> **Publicação:** o front publicado compartilha backend e banco com a Fabin, cliente em produção pelo projeto `D:delivery`. Push em `main` não publica (trava no `vercel.json`). Antes de publicar ou atualizar o backend, siga [docs/PUBLICACAO.md](docs/PUBLICACAO.md).

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

### Testar no celular (rede local)

1. Com o ambiente no ar (`npm run dev:up`), rode **uma vez, como administrador**: `.\scripts\lan-expose.ps1`. Ele encaminha a porta 5100 (API) do IP da rede para o Docker no WSL (`netsh portproxy`) e cria uma regra de firewall só para redes **Privadas**. Para desfazer: `.\scripts\lan-expose.ps1 -Remove`.
2. No celular, na mesma rede Wi-Fi, abra `http://<IP-do-PC>:3000` (o script mostra o endereço).

O front troca `localhost` da API pelo host da página (`lib/api-base.ts`), então o `.env` continua com `http://localhost:5100`. Se o IP do PC mudar (DHCP), rode o script de novo. Pelo encaminhamento, todos os aparelhos da rede chegam à API com o mesmo IP e dividem o limite de cadastros por conexão (`SIGNUP_PER_IP_PER_DAY`).

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

Configure também PublicApp__BaseUrl=https://wadelivery.com.br no catalog-api e um volume persistente para /app/wwwroot/uploads. A migration AutomaticTenantProvisioning e a migration de CNPJ alfanumérico são aplicadas no startup do catalog-api; faça backup do banco antes de atualizar produção. O endpoint POST /api/lojas/criar-completa só fica disponível com PostgreSQL. A rota Next resolve lojas pelo caminho /{slug}, sem wildcard DNS; slugs internos são reservados no frontend e no backend.

O cadastro possui dois modos: **teste rápido** (Nome, E-mail, WhatsApp, Segmento, UF e Cidade; slug auto-gerado) e **configuração completa** (PF/PJ com CPF ou CNPJ alfanumérico para PJ, endereço completo, visual e imagens). No teste rápido, a loja é criada com IsTeste=true, AcceptingOrders=false, sem mesas/módulos de atendimento ativados e com visual padrão; o usuário completa os dados no painel antes de ativar pedidos. A senha temporária é exibida apenas na resposta de criação.

Controles anti-abuso do cadastro (`POST /api/lojas/criar-completa`):

- **CAPTCHA obrigatório** (Cloudflare Turnstile): sem `Captcha:Enabled` + `Captcha:SecretKey` o cadastro responde 503 "temporariamente indisponível"; só `Captcha:AllowDisabled=true` (apenas em `appsettings.Development.json`) dispensa. No Compose, `NEXT_PUBLIC_TURNSTILE_SITE_KEY` e `TURNSTILE_SECRET_KEY`; o `.env.example` traz as chaves de **teste** da Cloudflare (sempre aprovam) — em produção use as chaves reais.
- **E-mail com domínio real**: recusa domínios reservados (`example.com`, `.test`…) e descartáveis (mailinator, yopmail…) e consulta o MX do domínio por DNS-over-HTTPS (Cloudflare). Falha de DNS não bloqueia o cadastro. Isso não prova que a pessoa é dona do endereço: não há confirmação por link (sem provedor de e-mail).
- **Limite por conexão**: até `SIGNUP_PER_IP_PER_DAY` (2) lojas por IP a cada 24h, guardando só o hash do IP com sal (`SIGNUP_IP_SALT`, padrão a chave JWT). O catalog-api confia no `X-Forwarded-For` do gateway (`ForwardedHeaders:KnownNetworks`, redes privadas do Docker no Compose); em produção atrás de CDN/proxy, configure o gateway para confiar no proxy de borda, senão todos os visitantes contam como o mesmo IP.
- **Cotas globais** (`SignupQuota:PerHour`, `PerDay`, `MaxActiveTestStores`) contadas em `platform_stores`, rate limit por IP (`store-signup`) e uma conta por e-mail.
- **Lojas abandonadas**: loja de teste cujo dono nunca entrou no painel é desativada após `SIGNUP_ABANDON_AFTER_DAYS` (7) dias e tem os arquivos enviados apagados `SIGNUP_PURGE_FILES_AFTER_DAYS` (30) dias depois (os registros ficam). Reativar: `/admin/lojas` → Cobrança → Desbloquear loja. Execução manual: `POST /api/v1/admin/platform-stores/cleanup/run`.

Em produção atrás de proxy/CDN, configure também ForwardedHeaders:KnownProxies/KnownNetworks para que os limites por IP usem o endereço real.
Consulte [docs/GETTING-STARTED.md](docs/GETTING-STARTED.md), [docs/architecture.md](docs/architecture.md) e [README-DEPLOY.md](README-DEPLOY.md) para detalhes operacionais. Não faça commits ou crie branches durante tarefas de manutenção sem solicitação explícita.
