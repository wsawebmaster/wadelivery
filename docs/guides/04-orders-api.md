# Guia 04 — Orders API

## 1. Propósito

Microserviço de **pedidos**: criação, consulta, status/pagamento, dashboard, SSE de mudanças e publicação `OrderCreated` no RabbitMQ.

## 2. Onde está no código

| Caminho | Papel |
|---------|--------|
| [`services/orders-api/`](../../services/orders-api/) | Projeto ASP.NET |
| [`Program.cs`](../../services/orders-api/Program.cs) | Rotas HTTP |
| [`OrderChangeNotifier.cs`](../../services/orders-api/OrderChangeNotifier.cs) | Fan-out SSE |
| [`OrderMapping.cs`](../../services/orders-api/OrderMapping.cs) | Entidade ↔ DTO |
| [`Models/Dtos.cs`](../../services/orders-api/Models/Dtos.cs) | Contratos |

Campos relevantes: status, pagamento, `AcceptedAtUtc` (SLA no admin).

## 3. Como rodar / testar

```powershell
cd services/orders-api
dotnet run --launch-profile http
```

- http://localhost:5102  
- Ou `npm run orders` na raiz  
- Stack completa: Docker / `npm run dev:up` (Postgres + RabbitMQ + gateway)

Teste rápido: `GET /api/v1/health` → criar pedido via storefront → ver em `GET /api/v1/orders`.

## 4. Fluxos principais

### Criar pedido

1. Storefront: `POST /api/v1/orders` (via gateway).  
2. Persistência + evento RabbitMQ `order.created` (quando a fila está disponível).  
3. Resposta com `orderId` e link de acompanhamento.

### Status / pagamento

1. Admin atualiza status (aceito → preparo → saída → entregue, etc.).  
2. Ao aceitar, preenche `AcceptedAtUtc` (base do prazo/SLA).  
3. Notifier dispara evento → clientes SSE recebem update.

### SSE

1. Admin abre `GET /api/v1/orders/stream`.  
2. `OrderChangeNotifier` mantém conexões; em falha o admin faz poll.  
3. Storefront pode pollar `GET /orders/{id}` para tracking.

### Dashboard

- `GET /api/v1/orders/dashboard?period=...` agrega volumes/receita.

## 5. Endpoints / extensão

Prefixo: `/api/v1`

| Método | Rota | Uso |
|--------|------|-----|
| GET | `/health` | Saúde |
| POST | `/orders` | Criar |
| GET | `/orders` | Listar (`status`, `limit`) |
| GET | `/orders/stream` | SSE |
| GET | `/orders/dashboard` | Métricas |
| GET | `/orders/{orderId}` | Detalhe / tracking |
| POST | `/orders/{orderId}/confirm-received` | Confirmação |
| (demais) | status / payment | Operação no painel |

Mensageria: publisher + consumer de auditoria no mesmo serviço (quando RabbitMQ está up).

## 6. Como alterar com segurança

- Novo status: atualizar enum/DTO + mapping + UI admin + storefront (labels/notificações).  
- Não remover `AcceptedAtUtc` sem ajustar alertas de atraso no admin.  
- SSE: manter `OrderChangeNotifier` notificado em toda mutação relevante.  
- Local light sem Rabbit: pedido ainda deve gravar; fila é best-effort.  
- Ver [06-como-atualizar.md](06-como-atualizar.md).
