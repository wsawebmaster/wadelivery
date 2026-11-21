# Guia 02 — Painel Admin

## 1. Propósito

Painel operacional da loja: pedidos (SSE/poll + alertas), dashboard, cupom, loja, catálogo e (papel Dev) lojas da plataforma. Autenticação JWT via catalog-api.

## 2. Onde está no código

| Caminho | Papel |
|---------|--------|
| [`apps/admin/`](../../apps/admin/) | Microfrontend admin |
| [`index.html`](../../apps/admin/index.html) | Shell + abas |
| [`app.js`](../../apps/admin/app.js) | UI, pedidos, alertas, CRUD |
| [`api-config.js`](../../apps/admin/api-config.js) | `API_BASE_URL` |
| [`styles.css`](../../apps/admin/styles.css) | Estilos |

Papéis (JWT claims): **Admin** (loja), **Atendimento** (pedidos), **Dev** (plataforma / lojas / sistemas). Credenciais locais: [GETTING-STARTED.md](../GETTING-STARTED.md).

## 3. Como rodar / testar

```powershell
cd apps/admin
npm start
```

- URL: http://localhost:8081  
- Login demo local: `admin` / `admin123`  
- `api-config` deve apontar para a mesma base do storefront (gateway `:5100` ou catalog `:5101`)

## 4. Fluxos principais

### Login

1. `POST /api/v1/auth/login` → token JWT.  
2. `GET /api/v1/auth/me` define abas visíveis por papel.

### Pedidos + alertas

1. Lista `GET /api/v1/orders` (filtro por status).  
2. Preferência: **SSE** `GET /api/v1/orders/stream`; se falhar, poll.  
3. Alertas de SLA (atraso desde `AcceptedAtUtc`), som, snooze, silenciar.  
4. Aceitar / mudar status / pagamento; cupom para impressão (iframe, sem pop-up).  
5. Export de backup do cardápio (download JSON/catálogo).

### Dashboard

- `GET /api/v1/orders/dashboard` (período; UI abre em **Hoje**).  
- Auto-refresh enquanto a aba está ativa.

### Loja / catálogo

- CRUD via rotas `/api/v1/admin/*` (categorias, produtos, ingredientes, logo/ícone).  
- Operações de horário: `/api/v1/ops/*` (ex.: aceitando pedidos, estender horário).

### Plataforma (Dev)

- Abas Lojas / Sistemas → `/api/v1/admin/platform-stores` e tráfego.

## 5. Endpoints / extensão

| Área | Exemplos |
|------|----------|
| Auth | `POST /auth/login`, `GET /auth/me` |
| Pedidos | `GET /orders`, `GET /orders/stream`, `GET /orders/dashboard`, status/payment |
| Catálogo admin | `PUT /admin/categories`, `PUT /admin/products`, … |
| Ops | `GET/POST /ops/accepting-orders`, `POST /ops/extend-hours` |
| Platform | `/admin/platform-stores` |

Extensão no front: novas abas em `index.html` + handlers em `app.js`. Políticas JWT ficam na catalog-api / orders-api.

## 6. Como alterar com segurança

- Mudanças em `app.js` / CSS: bump `?v=` no `index.html` do admin (mesmo critério do storefront).  
- Não quebrar papéis: Atendimento não deve ver CRUD de catálogo; Dev vê plataforma.  
- Sons/alertas: testar aceitar pedido e aba em segundo plano (AudioContext).  
- Produção: senhas fortes via env — nunca `admin123`.  
- Ver [06-como-atualizar.md](06-como-atualizar.md).
