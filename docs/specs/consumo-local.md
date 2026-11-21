# Modulos adicionais: consumo no local, mesa e garcom

Este documento e uma especificacao de implementacao para adicionar pedidos de consumo no local sem alterar o funcionamento atual de delivery, retirada, WhatsApp e acompanhamento do cliente.

A implementacao deve ser feita neste repositorio monorepo, respeitando a arquitetura existente e entregando codigo funcional, testes e atualizacao do contrato OpenAPI.

## 1. Resultado esperado

O sistema deve aceitar dois novos caminhos para pedidos de uma mesa:

1. O cliente le um QR Code fixado na mesa, abre o storefront com a mesa identificada e faz o proprio pedido.
2. O garcom acessa o painel com usuario autenticado, seleciona uma mesa e cria o pedido para o cliente.

Os dois caminhos devem usar o mesmo dominio de pedidos, persistencia, status, SSE, acompanhamento por token e fila operacional do painel.

Fluxo geral:

```text
Cliente -- QR Code --> storefront -- POST /api/v1/orders --> orders-api --> painel
Garcom -- login --> admin -- POST /api/v1/orders --> orders-api --> painel
```

## 2. Regras que nao podem ser quebradas

Estas regras sao obrigatorias:

- O comportamento atual de `delivery` deve continuar identico.
- O comportamento atual de `pickup` deve continuar identico.
- `delivery` continua sendo o valor padrao quando nenhuma modalidade nova for enviada.
- Pedidos antigos devem continuar sendo lidos e exibidos.
- Campos novos devem ser opcionais para pedidos antigos.
- A funcionalidade nova deve ser desativada por padrao.
- Um QR Code invalido nao pode bloquear o cardapio publico normal.
- O WhatsApp continua sendo usado para delivery e pickup como hoje.
- Pedido criado pelo garcom nao deve abrir WhatsApp automaticamente.
- O `AccessToken` atual continua protegendo o acompanhamento publico.
- O cliente nao pode consultar outros pedidos da mesa apenas por conhecer o numero dela.
- Nunca confiar no `StoreId`, mesa ou garcom enviados pelo navegador.
- Nao remover, renomear ou mudar semantica de colunas existentes.
- Nao fazer refatoracao ampla de storefront, admin ou APIs para implementar este recurso.

## 3. Arquitetura existente relevante

| Area | Local | Responsabilidade |
|------|-------|------------------|
| Storefront | `apps/storefront` | Cardapio PWA, checkout, WhatsApp e rastreio |
| Admin | `apps/admin` | Pedidos, operacao, impressao e configuracao |
| Gateway | `services/gateway` | Entrada unica YARP |
| Catalog API | `services/catalog-api` | Loja, catalogo, usuarios e JWT |
| Orders API | `services/orders-api` | Criacao, status, SSE e persistencia de pedidos |
| Banco | PostgreSQL | Dados multi-tenant e RLS |
| Contrato | `contracts/openapi/v1.yaml` | Contrato publico compartilhado |

Pontos de entrada atuais:

- Checkout e persistencia do pedido: `apps/storefront/assets/script/script.js`.
- Formulario de checkout: `apps/storefront/index.html`.
- Card dos pedidos: `apps/admin/app.js`.
- DTOs e entidade: `services/orders-api/Models/Dtos.cs` e `services/orders-api/Data/OrdersDbContext.cs`.
- Criacao e transicoes: `services/orders-api/Program.cs`.
- Status: `services/orders-api/Models/OrderStatus.cs`.
- Autenticacao e papeis: `services/catalog-api/Services/AuthService.cs`.

## 4. Feature flags e defaults

Adicionar configuracao publica da loja com defaults desligados:

```json
{
  "dineInEnabled": false,
  "customerQrOrdersEnabled": false,
  "waiterOrdersEnabled": false,
  "allowManualTableEntry": false,
  "requireCustomerNameForQrOrder": false,
  "allowCustomerChooseWaiter": false
}
```

Nomes podem seguir o estilo de configuracao existente, mas os defaults devem ser equivalentes.

Quando `dineInEnabled` for `false`:

- o storefront nao mostra a opcao de consumo no local;
- o QR Code nao ativa o fluxo de mesa;
- o admin nao mostra a tela de novo pedido de mesa, salvo para configuracao;
- pedidos `delivery` e `pickup` seguem sem qualquer alteracao.

A configuracao deve funcionar tanto com persistencia JSON quanto PostgreSQL, respeitando a limitacao ja existente de que JSON e single-tenant.

## 5. Modelo de dados

### 5.1 Pedido

Manter `FulfillmentType` como string para compatibilidade e adicionar o valor:

```text
delivery | pickup | dine_in
```

Adicionar campos opcionais em `OrderEntity`, DTOs e resposta:

```text
TableId             int?
TableLabel          string?
TableAccessCode     string?
OrderSource         string?   // customer_qr | waiter_panel | admin_panel
CreatedByUserId     int?
CreatedByUsername   string?
WaiterId            int?
WaiterName          string?
DiningSessionId     string?
```

Regras:

- `TableLabel` e `WaiterName` sao snapshots historicos do pedido.
- `OrderSource` deve ser validado no servidor.
- Para `delivery` e `pickup`, todos esses campos permanecem nulos, salvo compatibilidade explicita.
- Para `dine_in`, `DeliveryFee` deve ser zero.
- `DiningSessionId` pode ficar nulo na primeira versao, mas o modelo deve permitir seu uso futuro.

### 5.2 Mesas

Criar entidade/repository/rotas para mesas por loja:

```text
store_tables
- Id
- StoreId
- Label
- AccessCode
- Active
- AllowCustomerOrder
- Capacity opcional
- CreatedAtUtc
- UpdatedAtUtc opcional
```

Regras:

- `AccessCode` deve ser aleatorio, opaco e dificil de adivinhar.
- Nao usar o numero sequencial da mesa como segredo.
- `AccessCode` deve ser unico por loja.
- A consulta publica deve retornar somente dados necessarios para o storefront.
- Mesa inativa nao pode gerar pedido de cliente.
- Todas as consultas devem ser escopadas por `StoreId`.

### 5.3 Garcons

Na primeira versao, reutilizar usuarios da loja com papel `Atendimento` ou `Admin`, se isso for suficiente para o cadastro atual.

O nome do usuario autenticado deve ser salvo em `CreatedByUsername` e, quando aplicavel, em `WaiterName`.

Se for necessario ter garcons que nao fazem login, criar depois uma entidade separada. Nao criar uma segunda identidade paralela sem necessidade.

## 6. Contratos sugeridos

### 6.1 Resolver QR Code

```text
GET /api/v1/tables/resolve/{accessCode}
```

Resposta publica:

```json
{
  "tableId": 12,
  "tableLabel": "Mesa 12",
  "storeId": 1,
  "active": true,
  "allowCustomerOrder": true
}
```

Nao retornar dados internos, usuarios, sessoes ou credenciais.

### 6.2 Listar mesas para o admin

```text
GET /api/v1/admin/tables
GET /api/v1/admin/tables/{id}
```

Requer `Admin` ou permissao de operacao definida para o garcom.

A listagem por seguranca nao expoe o `AccessCode`. O `GET /api/v1/admin/tables/{id}` (Admin) devolve o codigo da mesa para reimpressao do QR apos recarregar a pagina.**

### 6.3 Criar/atualizar mesas

```text
POST /api/v1/admin/tables
PUT /api/v1/admin/tables/{id}
PATCH /api/v1/admin/tables/{id}/active
DELETE /api/v1/admin/tables/{id}
```

A gestao completa de mesas deve ficar protegida por `Admin`. Garcom pode listar mesas ativas, mas nao deve alterar sua configuracao.

### 6.4 Criar pedido

Manter:

```text
POST /api/v1/orders
```

Adicionar campos opcionais:

```json
{
  "fulfillmentType": "dine_in",
  "tableAccessCode": "codigo-opaco",
  "tableId": 12,
  "orderSource": "customer_qr",
  "waiterId": null,
  "waiterName": null,
  "diningSessionId": null,
  "clientRequestId": "chave-idempotencia-uuid"
}
```

`clientRequestId` (opcional) e a chave de idempotencia: o checkout gera um UUID por tentativa de pedido e REUTILIZA a MESMA chave em retries. O servidor cria no maximo UM pedido por `(StoreId, ClientRequestId)` — se a chave ja existir, devolve o pedido criado (200) em vez de gravar outro. Isso evita duplicidade quando o processamento demora e o cliente/clique envia de novo (duplo clique, timeout, retry). Após um pedido confirmado, o cliente troca a chave (novo pedido = chave nova). Índice unico parcial em `orders` garante a regra para requests concorrentes.

Pedido criado pelo painel:

```json
{
  "fulfillmentType": "dine_in",
  "tableId": 12,
  "orderSource": "waiter_panel",
  "waiterId": 4,
  "waiterName": "Joao"
}
```

O backend deve sobrescrever ou ignorar valores de autoria enviados pelo navegador quando o pedido for autenticado. Para pedido de garcom, usar o usuario do JWT como fonte de verdade.

### 6.5 Fechar mesa com divisao de conta

Usado pelo caixa/garcom ao finalizar a mesa. Confirma o pagamento e finaliza todas as comandas abertas:

```text
GET  /api/v1/orders/table/{tableId}     // comandas da sessao atual, incl. pagas (OrdersStaff)
POST /api/v1/admin/tables/{id}/close    // fecha a mesa (OrdersStaff)
```

```json
// body do close (paymentMethod opcional — "Em Aberto" esta na comanda)
{ "paymentMethod": "Pix" }
```

Comportamento do `close`:

- Atua sobre a **sessao atual** (comandas nao-canceladas desde o ultimo fechamento — inclui as ja pagas). 404 se a mesa nao existe na loja; 409 se nao ha comandas na sessao.
- Para cada comanda aberta: define `PaymentMethod` quando informado, marca pagamento `confirmed` + `timing_now` (se ainda nao confirmado), forca `Delivered`, `StatusUpdatedAtUtc=now` e `AcceptedAtUtc ??= now`. Comandas **ja entregues + pagas** sao preservadas (nao re-setam metodo/datas).
- Marca `store_tables.ClosedAtUtc = now` (encerra a sessao; mesa volta a "Livre"). O proximo pedido abre nova sessao automaticamente: `GET /orders/table/{id}` e `GET /admin/tables` usam `CreatedAtUtc >= ClosedAtUtc` como limite da sessao.
- Publica SSE (broadcast + por pedido) com motivo `status`/`payment`.
- Retorna `{ tableId, closedOrders, total, orderIds }`.

While a sessao esta aberta, comandas com pagamento confirmado continuam listadas no card da mesa com pill verde "Pago" (`status-Pago`) — elas so somem depois do fechamento oficial (`ClosedAtUtc`). `GET /admin/tables` expoe `SessionOrders`/`SessionTotal` (sessao atual, incl. pagas) e `OpenOrders`/`OpenOrdersTotal` (apenas nao-entregues); mesa "em atendimento" = `SessionOrders > 0`.

Divisao (regra de negociio no painel, criada antes de confirmar):

- Informar quantidade de pessoas pagantes (1..50) e, opcionalmente, gorjeta.
- Por pessoa: nome opcional + checkbox "valor fixo" + valor. Quem paga a mais (cobre parte da conta) fica marcado como fixo; a sobra e dividida igualmente entre os demais (a ultima pessoa dinamica absorve os centavos).
- A soma das pessoas (fixos + dinamicos) precisa bater com o total + gorjeta — a interface bloqueia a confirmacao enquanto houver diferenca.
- Apos fechar, e possivel imprimir a cobranca com a divisao por pessoa.

## 7. Regras do backend

Na criacao do pedido, manter esta ordem de decisao:

```text
1. Validar campos comuns e itens.
2. Resolver a modalidade.
3. Se delivery: manter validacao e cotacao atuais.
4. Se pickup: manter comportamento atual.
5. Se dine_in: validar mesa, origem e permissao.
6. Precificar itens pelo catalog-api.
7. Gravar pedido e publicar evento.
8. Retornar AccessToken para acompanhamento.
```

### Pedido de cliente via QR Code

Aceitar `dine_in` sem JWT somente quando:

- a feature estiver habilitada;
- `customerQrOrdersEnabled` estiver habilitada;
- `tableAccessCode` existir e resolver para mesa ativa da loja;
- a mesa permitir pedidos de cliente.

O `tableId` enviado pelo cliente nunca deve ser suficiente sem validar o `tableAccessCode`.

### Pedido de garcom

Aceitar `orderSource = waiter_panel` somente com JWT e papel `Admin` ou `Atendimento`.

O servidor deve:

- obter `StoreId` do tenant/JWT;
- obter username e id do usuario autenticado;
- conferir que a mesa pertence ao tenant e esta ativa;
- preencher `CreatedByUserId`, `CreatedByUsername` e `WaiterName`;
- nao depender de `waiterName` informado no body.

### Validacao de delivery/pickup

Nao alterar as regras atuais. Em especial:

- delivery continua exigindo endereco valido;
- delivery continua calculando taxa;
- pickup continua usando endereco da loja e taxa zero;
- `ReadyForPickup` continua sendo o status de retirada.

## 8. Status e acompanhamento

Adicionar status especifico:

```text
ReadyForTable = "Pronto para a mesa"
```

Sequencia de `dine_in`:

```text
Created
Accepted
Preparing
ReadyForTable
Delivered
```

O cliente deve ver labels amigaveis:

```text
Pedido recebido
Confirmado
Em preparacao
Pronto para voce
Finalizado
```

O SSE e o endpoint protegido por `AccessToken` devem continuar sendo os mesmos. Nao criar acompanhamento por `TableId`, pois isso permitiria vazar pedidos de outras pessoas da mesa.

Acoes de confirmacao devem continuar respeitando a modalidade:

- delivery: confirmacao de recebimento atual;
- pickup: confirmacao de retirada atual;
- dine_in: confirmacao de recebimento na mesa, se o fluxo atual permitir.

## 9. Storefront

### 9.1 URL do QR Code

O QR Code deve apontar para o storefront com um parametro opaco, por exemplo:

```text
https://cardapio.exemplo.com/?table=CODIGO_OPACO
```

Sem `table`, o storefront deve funcionar exatamente como funciona hoje.

Ao carregar:

1. ler o parametro;
2. chamar o endpoint de resolucao;
3. se valido, guardar contexto temporario da mesa;
4. mostrar `Mesa 12` no carrinho;
5. habilitar `dine_in` quando a loja permitir;
6. se falhar, manter o cardapio normal e mostrar erro nao bloqueante.

Nao persistir o contexto de uma mesa indefinidamente em localStorage. Limpar ou revalidar o contexto ao iniciar novo pedido.

### 9.2 Checkout

Adicionar uma terceira modalidade ao lado de delivery e pickup:

```text
Entregar no meu endereco
Retirar no local
Consumir no local
```

A opcao so aparece com `dineInEnabled = true`.

Para `dine_in`:

- esconder endereco, CEP e cotacao de entrega;
- esconder taxa de entrega;
- exibir mesa identificada;
- permitir nome do cliente conforme configuracao;
- permitir garcom somente se `allowCustomerChooseWaiter = true`;
- manter itens, pagamento e observacoes atuais.

O payload deve conter `fulfillmentType = dine_in` e o `tableAccessCode` resolvido.

### 9.3 WhatsApp

Delivery e pickup devem manter a mensagem atual.

Para `dine_in`, adicionar somente contexto especifico:

```text
Consumo no local
Mesa: Mesa 12
Garcom: Joao
```

Adicionar o link de acompanhamento quando a API retornar `AccessToken`.

Para pedido de cliente em mesa, se a API estiver indisponivel, nao usar fallback silencioso para um pedido nao rastreado. Exibir erro e permitir nova tentativa. O fallback atual de delivery/pickup deve permanecer inalterado.

## 10. Painel administrativo

### 10.1 Novo pedido de mesa

Adicionar uma acao visivel para usuarios que podem operar pedidos:

```text
Novo pedido de mesa
```

Campos minimos:

- mesa ativa;
- cliente opcional;
- itens do catalogo;
- observacoes;
- forma de pagamento;
- garcom responsavel, preenchido pelo usuario logado.

O garcom deve poder criar o pedido sem passar pelo WhatsApp.

Apos criar um pedido de mesa (garcom ou QR), o carte consumido no local MANTERE o contexto da mesa (fulfillmentMode, dineInTable, waiterToken) e so limpa o carrinho — ou seja, enquanto a mesa estiver em atendimento ela continua aceitando novos pedidos, sem o garcom/cliente ter que reescanear ou re- logar. A chave de idempotencia e trocada a cada pedido confirmado.

O grid de mesas e UNIFICADO: o painel (aba Mesas) exibe o mesmo card do garcom no cardapio `/login` (sem mapa/bolhas nem toggle "Ver detalhes"). Cada card mostra label + badge `Ocupada`/`Livre`/`Inativa`, meta ('N pedido(s) aberto(s) · R$ X', 'N comanda(s) paga(s) · R$ X' ou 'Toque para fazer o pedido'), comandas (pill `Pago` verde + total + olho) e rodape Comanda/Novo pedido (mesas ocupadas); no painel as acoes admin ficam no card: ✕ (fechar), QR, Ativar/Desativar, Editar e Excluir (StoreAdmin). A listagem `GET /api/v1/admin/tables` retorna `OpenOrderStatus`/`OpenOrderStatusLabel` (ultima comanda por `CreatedAtUtc`; usado apenas para derivar `openOrders`/badges — o card em si nao mostra o andamento), mas o olho de cada comanda e colorido por status (laranja em `ReadyForTable`, azul em `Delivered`) e a mesa com comanda pronta ganha borda em degrade girando (`.has-ready-order`). O grid atualiza ao vivo via SSE/poll enquanto a aba Mesas estiver aberta.

Pedido feito pelo GARCOM nao abre acompanhamento no cardapio digital: sem modal/bolha de tracking e sem `startOrderTracking` no load/finalizacao (sessao com `waiterToken` pula tudo). Apos confirmar, o storefront so mostra um toast ("Pedido enviado - Mesa X") e fica livre para continuar pedindo. O status da comanda acompanha-se pelo card da mesa (painel). Cliente via QR, delivery e pickup mantem o acompanhamento normal.

Como o garcom ja validou o pedido com o cliente, o pedido de garcom nasce CONFIRMADO (`Status=Accepted` no `POST /api/v1/orders` quando `orderSource` e `waiter_panel`/`admin_panel`, com `AcceptedAtUtc` preenchido) — nao passa pela fila de "Aguardando Confirmacao".

No CARD DA MESA (painel e cardapio) cada comanda exibe o **olho colorido por status** (`mesas-comanda-eye`): **laranja** (`.is-ready`) quando a comanda esta `ReadyForTable` ("Pronto para a mesa" — o garcom identifica na hora o que servir) e **azul** (`.is-delivered`) quando `Delivered`; **o mesmo nos dois apps** (painel e `/login`, que usam o mesmo card `mesas-table-card`). Comanda com pagamento confirmado mantem a pill verde `Pago` — o andamento completo ve-se no modal de itens (`askComandaItems` no painel, com badge de status; `showStorefrontComandaItems` no cardapio do garcom). Mesa com alguma comanda `ReadyForTable` exibe **borda em degradê girando** (`.has-ready-order` + `conic-gradient` em `border-box` + `@keyframes mesas-border-spin`, com `@property --mesas-border-angle`) para chamar a atencao do garcom. No modal de itens do cardapio, o garcom so tem o botao "Entregue na mesa" (`markComandaDelivered`) quando a comanda esta `ReadyForTable` ("Pronto para a mesa") — a transicao dine-in para `Delivered` segue a sequencia normal (`OrderStatus.CanTransition`), sem pular etapas, e o bloqueio por pagamento e ignorado para dine-in (pagamento resolve no fechamento, `POST /admin/tables/{id}/close`).

O GRID DE MESAS atualiza ao vivo via webhook: o painel recarrega as mesas a cada evento do SSE `GET /api/v1/orders/stream` enquanto a aba Mesas estiver aberta (`maybeRefreshTablesLive`); no cardapio digital, o mapa do garcom conecta no mesmo stream com o Bearer dele enquanto aberto (`connectMesasLive`) e recarrega em silencio (`loadMesasMap({silent:true})`), com poll de seguranca de 15 s. Em mobile (< 560 px) o grid exibe 2 colunas (`.tables-grid-inner` no painel e `.mesas-map` no cardapio).

No card da mesa (painel e cardapio) cada comanda mostra apenas o OLHO + VALOR, com o olho colorido por status (igual nos dois apps): laranja (`.is-ready`) quando `ReadyForTable`, azul (`.is-delivered`) quando `Delivered`. Comanda com pagamento confirmado fica com pill verde "Pago" (`status-Pago`) e permanece listada ate o fechamento oficial da mesa (sessao atual). O modal de comanda tem um X "Fechar" no canto superior direito e o rodape dividido entre "+ Novo pedido" e "Conta" — no painel "Conta" abre a divisao da conta/fechamento (`fecharTable`); no cardapio fechar a mesa via `POST /admin/tables/{id}/close` (sem divisao).

### 10.2 Lista de pedidos

Para pedido `dine_in`, mostrar no topo do card:

```text
Mesa 12 · Joao
Origem: Pedido do garcom
```

ou:

```text
Mesa 12
Origem: Cliente via QR Code
```

Nao alterar a apresentacao dos cards delivery/pickup alem do necessario para continuar compatibilidade.

Adicionar filtros opcionais:

- por mesa;
- por origem;
- por garcom.

### 10.3 Impressao

Para `dine_in`, imprimir:

```text
MESA: 12
GARCOM: JOAO
ORIGEM: PAINEL
```

Nao imprimir endereco nem taxa de entrega para consumo no local.

Cupons delivery e pickup devem continuar iguais.

## 11. Permissoes

| Acao | Admin | Atendimento/Garcom | Cliente QR |
|------|-------|---------------------|------------|
| Ver pedidos | Sim | Sim | Apenas proprio pedido |
| Criar pedido delivery | Fluxo publico | Conforme necessidade | Nao aplicavel |
| Criar pedido de mesa | Sim | Sim | Via QR validado |
| Listar mesas ativas | Sim | Sim | Nao |
| Criar/editar mesas | Sim | Nao | Nao |
| Fechar mesa (pagamento + divisao) | Sim | Sim (com PIN) | Nao |
| Gerar QR Codes | Sim | Nao | Nao |
| Alterar status | Sim | Sim | Nao |
| Ver dashboard | Conforme regra atual | Conforme regra atual | Nao |

Nao ampliar o papel `Atendimento` para gestao de catalogo ou mesas sem uma decisao explicita.

## 12. Banco, tenant e migracao

As alteracoes devem ser aditivas e compativeis com bases existentes:

- `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` para pedidos;
- criacao idempotente da tabela de mesas;
- indices por `StoreId`, `AccessCode` e `TableId`;
- RLS da tabela de mesas por `StoreId`;
- nenhum RLS em tabelas globais de plataforma;
- seed opcional de mesas somente em ambiente de desenvolvimento.

A inicializacao deve funcionar com uma base existente sem exigir apagar volume PostgreSQL.

Como o projeto usa alteracoes de schema na inicializacao, seguir o padrao ja existente em `orders-api/Program.cs`, adicionando testes para base antiga.

## 13. API e contrato OpenAPI

Atualizar `contracts/openapi/v1.yaml` com:

- novos campos de `CreateOrder`;
- novos campos de `OrderResponse`;
- `dine_in` na documentacao de modalidade;
- endpoint publico de resolucao de mesa;
- endpoints administrativos de mesas;
- respostas de erro `400`, `401`, `403`, `404` e `409` relevantes.

O contrato deve documentar que `tableAccessCode` e usado somente para pedido de cliente via QR Code e nao substitui o `AccessToken` de acompanhamento.

## 14. Testes obrigatorios

### Backend

- pedido delivery antigo continua criando;
- pedido pickup antigo continua criando;
- pedido delivery continua calculando taxa;
- pedido pickup continua com taxa zero;
- pedido dine-in valido via QR Code cria com mesa correta;
- QR Code invalido retorna erro sem permitir pedido;
- mesa inativa nao aceita pedido;
- mesa de outro tenant nao aceita pedido;
- cliente nao pode usar somente `tableId` para forjar mesa;
- pedido de garcom exige JWT;
- Atendimento pode criar pedido de mesa;
- usuario sem permissao recebe `403`;
- garcom de outro tenant nao pode ser associado;
- pedido dine-in grava taxa zero;
- campos novos nulos nao quebram pedidos antigos;
- status `ReadyForTable` segue transicao correta;
- acompanhamento por `AccessToken` continua isolado por pedido;
- SSE continua emitindo eventos para dine-in e modalidades antigas;
- migracao e idempotente.

### Storefront

- sem parametro `table`, o checkout atual nao muda;
- QR Code valido identifica e mostra a mesa;
- QR Code invalido nao bloqueia o cardapio normal;
- dine-in nao exibe endereco nem taxa;
- delivery continua exigindo endereco;
- pickup continua funcionando;
- mensagem delivery/pickup nao muda;
- mensagem dine-in inclui mesa e origem adequada;
- pedido dine-in sem API nao cai em fallback silencioso;
- link de acompanhamento continua sendo gerado.

### Admin

- Atendimento ve pedidos e pode criar pedido de mesa;
- Admin pode administrar mesas;
- usuario sem permissao nao ve a acao;
- card dine-in mostra mesa, origem e garcom;
- cards antigos permanecem corretos;
- impressao dine-in mostra mesa e garcom;
- impressao delivery/pickup nao muda;
- filtros por mesa/origem/garcom nao alteram filtros existentes.

## 15. Ordem de implementacao

1. Ler os arquivos atuais e localizar testes equivalentes antes de editar.
2. Adicionar entidades, DTOs e schema aditivo de mesas/pedidos.
3. Implementar repository e endpoints de mesas com tenant/RLS.
4. Adicionar feature flags na configuracao publica da loja.
5. Adicionar `dine_in` ao backend mantendo delivery/pickup isolados.
6. Adicionar status `ReadyForTable` e testes de transicao.
7. Implementar resolucao de QR Code no storefront.
8. Adicionar modalidade e checkout dine-in no storefront.
9. Implementar criacao de pedido de mesa no painel para Admin/Atendimento.
10. Atualizar card, filtros, recibo e WhatsApp.
11. Atualizar OpenAPI e documentacao.
12. Executar testes focados e depois a suite existente.
13. Testar manualmente os tres fluxos: delivery, pickup e dine-in.

Depois de cada edicao substancial, executar a validacao mais estreita disponivel antes de continuar para outro modulo.

## 16. Criterios de aceite

A entrega somente esta pronta quando:

- uma loja antiga inicia com as flags novas desligadas;
- um cliente antigo consegue fazer delivery sem perceber mudanca;
- um cliente antigo consegue fazer pickup sem perceber mudanca;
- um cliente com QR Code valido cria pedido para a mesa correta;
- um garcom autenticado cria pedido para uma mesa pelo painel;
- ambos os pedidos aparecem na mesma fila administrativa;
- ambos podem ser acompanhados pelo cliente com token individual;
- a mesa nao pode ser falsificada por um cliente;
- a origem do pedido aparece no painel e no cupom;
- o WhatsApp continua funcionando para o fluxo atual;
- nao existe fallback silencioso de dine-in quando o pedido nao foi persistido;
- testes novos e testes existentes passam;
- o contrato OpenAPI esta atualizado;
- a implementacao nao exige apagar banco ou dados existentes.

## 17. Instrucoes para a IA que for implementar

Antes de editar:

- confirme o caminho real dos arquivos no workspace;
- procure implementacoes e testes proximos do comportamento;
- formule uma hipotese local sobre o ponto de controle;
- escolha a menor alteracao que permita valida-la;
- nao reescreva arquivos inteiros sem necessidade.

Durante a implementacao:

- preserve estilo, APIs publicas e defaults atuais;
- use alteracoes aditivas;
- valide entradas no backend;
- mantenha a separacao por tenant;
- escape dados exibidos no admin;
- nao introduza dependencia externa para QR Code se o link puder ser gerado no servidor ou navegador com recurso ja disponivel;
- nao crie autenticacao nova para garcom;
- nao altere delivery/pickup para reaproveitar codigo de dine-in de forma ambigua.

Ao finalizar:

- informe arquivos alterados;
- informe testes executados e resultado;
- informe qualquer limitacao residual;
- nao marque a tarefa como concluida se o fluxo do garcom ou o fluxo QR Code estiver apenas simulado.
