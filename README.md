# WaDelivery

Landing page comercial do WaDelivery, uma plataforma SaaS para restaurantes e operações de alimentação criarem seu próprio canal de delivery.

> **Status:** MVP da landing page. A integração real de leads, o cardápio multi-tenant, o painel do lojista e a API ainda fazem parte da arquitetura planejada.

## Proposta

O WaDelivery pretende oferecer:

- Cardápio digital com a marca do lojista.
- Pedidos sem comissão de marketplace.
- Acompanhamento de pedidos em tempo real.
- Painel para produtos, categorias, pedidos e vendas.
- Criação automática de uma loja para cada novo cliente.

Os segmentos iniciais são **lanchonete**, **hamburgueria**, **pizzaria** e **marmitaria**.

## Estado atual

Este repositório contém uma landing page estática em português do Brasil:

- `index.html`: conteúdo, estrutura semântica e formulário de interesse.
- `assets/css/style.css`: identidade visual, layout responsivo e animações.
- `assets/js/script.js`: menu mobile, efeitos de entrada, contadores, modal, máscara e validação.
- `vercel.json`: rewrite temporário para hospedagem dos arquivos estáticos.
- `package.json`: scripts para servir o projeto localmente.

O formulário atual valida nome, telefone e e-mail no navegador e grava os dados no `localStorage`, usando a chave `landing_leads_v1`. Portanto, ele é uma demonstração local e ainda não envia dados para uma API, CRM, WhatsApp ou e-mail.

## Executar localmente

Pré-requisito: Node.js e npm instalados.

```bash
npm start
```

Ou:

```bash
npm run dev
```

Acesse [http://localhost:8082](http://localhost:8082).

Os dois scripts usam `npx serve` e podem baixar o executável na primeira execução. Não existem atualmente scripts de build, lint ou testes automatizados.

## Arquitetura planejada

A arquitetura alvo separa a aquisição de clientes, os cardápios, a administração e a API:

| Finalidade | URL | Hospedagem | Estado |
| --- | --- | --- | --- |
| Landing de vendas B2B | `wadelivery.com.br` | Next.js na Vercel | MVP estático atual |
| Cardápio do cliente | `wadelivery.com.br/{slug}` | Next.js na Vercel | Planejado |
| Painel do lojista | `admin.wadelivery.com.br` | Next.js na Vercel | Planejado |
| API do sistema | `api.wadelivery.com.br` | C#/.NET na Railway | Planejado |
| Banco de dados | PostgreSQL | Railway | Planejado |

### Rotas de cardápio

A recomendação é usar uma rota dinâmica por caminho, por exemplo:

```text
https://wadelivery.com.br/novocliente
```

Isso não é um subdomínio. Em uma aplicação Next.js, uma rota equivalente a `app/[slug]/page.tsx` capturará `novocliente` e consultará o cardápio correspondente na API:

```text
GET /api/tenants/novocliente/menu
```

Essa abordagem evita criar registros DNS para cada cliente. Subdomínios como `novocliente.wadelivery.com.br` só devem ser adotados após uma decisão específica sobre wildcard DNS, middleware e configuração de domínios na Vercel.

### Fluxo de criação de cliente

1. O lojista informa nome, telefone, e-mail e segmento na landing.
2. O frontend envia os dados para a API.
3. O backend valida e normaliza os dados.
4. O backend cria ou inicia o tenant e reserva um `slug` único.
5. A API retorna a URL do cardápio.
6. O lojista configura o cardápio pelo painel.
7. O cardápio público consulta os dados pelo `slug`.

A criação deve ser idempotente e o backend deve ser responsável por autorização, isolamento entre tenants, validação, LGPD, rate limiting e observabilidade. O segmento deve ser validado no servidor e nunca usado diretamente como slug sem normalização e tratamento de colisões.

## Integração futura

Antes de implementar o frontend Next.js, confirmar o contrato OpenAPI ou equivalente da API C#/.NET. A integração deverá:

- Usar a URL da API por variável de ambiente.
- Tratar carregamento, `404`, indisponibilidade e respostas inválidas.
- Validar dados no frontend e novamente no backend.
- Respeitar CORS, autenticação e autorização definidos pela API.
- Nunca expor connection strings, tokens privados ou credenciais no navegador.
- Usar a API como fonte de verdade para leads, tenants, cardápios, produtos e pedidos.
- Só mostrar sucesso de cadastro após confirmação real da API.

O banco poderá ser compartilhado com `tenant_id` ou usar isolamento por schema/banco. Essa decisão pertence ao backend e deve ser documentada antes da implementação.

## Próximas etapas

1. Definir o repositório e a estrutura do frontend Next.js.
2. Formalizar o contrato da API e o modelo de tenant.
3. Substituir o armazenamento local do formulário por uma integração segura.
4. Implementar geração idempotente e reserva de slugs.
5. Criar a rota dinâmica de cardápio e os estados de erro.
6. Implementar autenticação e painel do lojista.
7. Configurar ambientes, domínios, observabilidade e deploy na Vercel/Railway.
8. Adicionar testes automatizados para onboarding, isolamento de tenants e cardápio público.

## Desenvolvimento e contribuição

Mantenha textos principais em pt-BR, preserve acessibilidade e responsividade e faça alterações pequenas e focadas. Antes de mudar IDs, classes ou atributos `data-*`, atualize seus consumidores no HTML, CSS e JavaScript.

Consulte o [`AGENTS.md`](AGENTS.md) para regras detalhadas destinadas a agentes de código, limites do MVP, validação e decisões de arquitetura.

Não faça commit ou crie branch automaticamente durante tarefas de manutenção, salvo solicitação explícita.
