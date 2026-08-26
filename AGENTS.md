# Guia para agentes

## Objetivo do produto

O WaDelivery é um SaaS de delivery para restaurantes e operações de alimentação. A landing page na raiz do domínio atrai lojistas e, no produto final, cada lojista terá um cardápio digital próprio, painel de gestão e API multi-tenant.

Este repositório ainda contém somente o MVP da landing page. Atualmente não há Next.js, backend, banco de dados, integração de API, pipeline de provisionamento ou suíte de testes.

## Estado atual do repositório

- `index.html`: landing page em HTML, conteúdo em pt-BR, acessibilidade e formulário de interesse.
- `assets/css/style.css`: tokens visuais, layout, responsividade e animações.
- `assets/js/script.js`: menu mobile, efeitos de entrada, contadores, modal, máscara e validação do formulário.
- `package.json`: scripts `npm start` e `npm run dev`, ambos usando `serve` na porta `8082`.
- `vercel.json`: rewrite temporário para servir `index.html` nas rotas que não são assets.

Não declare capacidades futuras como implementadas. O formulário atual valida nome, telefone e e-mail no navegador e salva os dados somente em `localStorage`, usando a chave `landing_leads_v1`. Ele não envia leads para API, CRM, WhatsApp ou e-mail.

## Arquitetura alvo

Quando a migração for aprovada, a arquitetura planejada será:

| Finalidade | URL | Hospedagem |
| --- | --- | --- |
| Landing de vendas B2B | `https://wadelivery.com.br` | Frontend Next.js na Vercel |
| Cardápio do cliente | `https://wadelivery.com.br/{slug}` | Frontend Next.js na Vercel |
| Painel do lojista | `https://admin.wadelivery.com.br` | Frontend Next.js na Vercel |
| API do sistema | `https://api.wadelivery.com.br` | C#/.NET na Railway |
| Banco de dados | PostgreSQL | Railway |

### Decisão de roteamento

O formato recomendado para o cardápio é uma rota por caminho, como `wadelivery.com.br/novocliente`. Isso é uma rota dinâmica, não um subdomínio. No Next.js, a implementação deverá usar uma rota equivalente a `app/[slug]/page.tsx`, extrair o `slug` e consultar a API.

Essa escolha evita criar ou alterar DNS para cada novo lojista. O uso futuro de subdomínios, como `novocliente.wadelivery.com.br`, exigirá uma decisão separada sobre wildcard DNS, middleware, domínios da Vercel e resolução por host.

Fluxo conceitual do cardápio:

```text
GET /novocliente
	-> Next.js extrai o slug "novocliente"
	-> API: GET https://api.wadelivery.com.br/api/tenants/novocliente/menu
	-> página renderiza marca, categorias e produtos do tenant
```

O PostgreSQL poderá usar um banco compartilhado com `tenant_id` ou isolamento por banco/schema. Essa decisão pertence ao backend e deve ser registrada antes da implementação. Nunca misture dados de tenants por confiar apenas no frontend.

## Onboarding sem trabalho manual

O fluxo alvo para um novo lojista é:

1. O lojista preenche o formulário da landing com nome, telefone, e-mail e segmento.
2. O frontend envia os dados para um endpoint real da API.
3. O backend valida e normaliza os dados, registra o lead e cria ou inicia o tenant.
4. O segmento deve ser controlado e validado no servidor: `lanchonete`, `hamburgueria`, `pizzaria` ou `marmitaria`.
5. O backend gera, reserva e verifica a disponibilidade de um `slug` único. O segmento não deve ser usado diretamente como slug sem normalização e tratamento de colisões.
6. A API retorna a URL do cardápio, por exemplo `https://wadelivery.com.br/novocliente`.
7. O lojista administra produtos, categorias, pedidos e configurações pelo painel.

A criação do tenant deve ser idempotente quando houver reenvio da mesma solicitação. O backend é responsável por autorização, validação, persistência, isolamento dos tenants, LGPD, rate limiting e observabilidade.

## Contrato frontend/API

Até existir um contrato oficial, trate endpoints e payloads como decisões pendentes. Antes de escrever integração, confirmar o contrato OpenAPI ou equivalente com o backend.

Regras obrigatórias para qualquer frontend futuro:

- Usar a URL da API por variável de ambiente; nunca fixar ambientes ou segredos no código.
- Considerar a API como fonte de verdade para tenants, cardápios, produtos, pedidos e leads.
- Implementar estados de carregamento, tenant inexistente (`404`), API indisponível, resposta inválida e tentativa novamente.
- Configurar e validar CORS, autenticação e autorização conforme o backend. Não confiar em `tenant_id` fornecido pelo cliente.
- Não colocar connection strings, tokens privados ou credenciais em código executado no navegador.
- Validar entradas no frontend para boa experiência e novamente no backend por segurança.
- Usar WebSockets para atualização em tempo real somente quando o contrato e a autenticação estiverem definidos.
- Não exibir mensagem de sucesso de captação real enquanto a API não confirmar o recebimento.

## Regras de implementação

- Enquanto a migração não for aprovada, preserve a natureza estática e o JavaScript compatível com navegadores modernos.
- Na migração, preferir Next.js com App Router e rota dinâmica `[slug]`, mantendo a landing em `/` e separando as áreas de cliente e administração.
- Não criar backend C#/.NET ou código PostgreSQL neste repositório sem decisão explícita de monorepo. Esses serviços são externos ao MVP atual.
- Reavaliar ou substituir o `vercel.json` quando o projeto deixar de ser servido como arquivos estáticos; não manter rewrites incompatíveis com o roteamento do Next.js.
- Manter textos principais em pt-BR, HTML semântico, atributos ARIA, foco do modal e responsividade.
- Preservar os tokens e padrões existentes em `assets/css/style.css`. Evitar estilos inline, duplicação e reformatação sem necessidade.
- Ao alterar id, classe, atributo `data-*` ou seletor, atualizar todos os consumidores em HTML, CSS e JavaScript.
- Fazer alterações pequenas e focadas. Não adicionar dependências ou ferramentas de build sem necessidade concreta.
- Nunca alegar que leads foram enviados externamente enquanto o fluxo continuar usando apenas `localStorage`.

## Comandos

No estado atual, use Node.js/npm:

```bash
npm start
npm run dev
```

Acesse `http://localhost:8082`. Os comandos usam `npx serve` e podem baixar o executável na primeira execução.

Não invente `npm test`, `npm run build` ou `npm run lint`: esses scripts ainda não existem. Depois da migração para Next.js, adicione somente scripts realmente configurados, como `dev`, `build`, `start`, `lint` e testes.

## Validação

Após alterações no MVP atual:

1. Rode `npm start` ou `npm run dev`.
2. Verifique a landing em desktop e viewport estreito.
3. Teste âncoras, menu mobile, modal, foco, validação do formulário, mensagem local de sucesso e contador quando afetados.
4. Confirme no console que JavaScript, CSS e fontes carregam sem erros.
5. Confira títulos, links, contraste, semântica e atributos de acessibilidade.

Após a migração, acrescente validação de:

- `/` como landing B2B;
- `/{slug}` com tenant válido, slug inexistente e API indisponível;
- criação de lead/tenant e prevenção de slug duplicado;
- isolamento entre tenants;
- painel autenticado;
- integração em desktop, mobile e produção na Vercel/Railway.

Não há testes automatizados neste repositório atualmente; a validação manual é o critério padrão até que testes sejam adicionados.

## Processo para agentes

Antes de editar, leia o arquivo diretamente relacionado ao comportamento solicitado e seus consumidores imediatos. Formule uma hipótese local sobre a causa ou comportamento esperado e escolha uma checagem barata que possa refutá-la.

Depois da primeira edição, execute uma validação focada antes de ampliar a investigação ou alterar outra área. Não faça commit nem crie branch sem solicitação explícita.

Ao finalizar, informe arquivos alterados, comportamento validado e limitações conhecidas. Diferencie sempre o que já está funcionando do que é arquitetura planejada.
