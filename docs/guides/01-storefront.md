# Guia 01 — Storefront (cardápio cliente)

## 1. Propósito

Front do cliente: cardápio PWA, endereço/CEP, frete, checkout, acompanhamento do pedido e instalação como app. Consome a API via `API_BASE_URL` (gateway ou catalog-api direta).

## 2. Onde está no código

| Caminho | Papel |
|---------|--------|
| [`apps/storefront/`](../../apps/storefront/) | App estático |
| [`index.html`](../../apps/storefront/index.html) | Shell + `?v=` de cache |
| [`assets/script/script.js`](../../apps/storefront/assets/script/script.js) | Lógica principal |
| [`assets/script/api-config.js`](../../apps/storefront/assets/script/api-config.js) | `window.API_BASE_URL` |
| [`assets/css/style.css`](../../apps/storefront/assets/css/style.css) | Estilos |
| [`manifest.json`](../../apps/storefront/manifest.json) / [`sw.js`](../../apps/storefront/sw.js) | PWA |
| [`scripts/bump-cache.js`](../../apps/storefront/scripts/bump-cache.js) | Incrementa `?v=` em CSS/JS |

## 3. Como rodar / testar

Pré-requisito: API no ar (ver [GETTING-STARTED.md](../GETTING-STARTED.md)).

```powershell
cd apps/storefront
npm start
```

- Local: http://localhost:8080  
- Com `dev:up`: `api-config` aponta para o gateway `:5100`  
- Só catalog-api: `API_BASE_URL` → `http://localhost:5101`

Checklist rápido: loja carrega → categorias/itens → CEP/frete → checkout → tracking.

## 4. Fluxos principais

### Cardápio

1. Página chama `GET /api/v1/store` e `GET /api/v1/catalog`.  
2. Renderiza categorias/produtos (categoria **Adicionais** fica fora do menu público).  
3. Carrinho e personalização no cliente.

### Endereço / CEP / frete

1. Cliente informa CEP ou busca por rua.  
2. Cotação via `POST /api/v1/delivery/quote` (e geocode quando necessário).  
3. Erros de validação aparecem inline no formulário.

### Pedido + acompanhamento

1. Checkout monta o payload e envia `POST /api/v1/orders`.  
2. WhatsApp pode abrir como canal de confirmação.  
3. Tracking consulta o pedido; notifica mudança de status; permite compartilhar (WhatsApp/link).  
4. Modal de acompanhamento adapta-se a mobile (`visualViewport`).

### PWA

- `manifest.json` + service worker `sw.js`.  
- Após mudança de CSS/JS: bump de `?v=` (ver seção 6).

## 5. Endpoints / extensão

| Uso | Endpoint |
|-----|----------|
| Loja | `GET /api/v1/store` |
| Catálogo | `GET /api/v1/catalog` |
| Frete | `POST /api/v1/delivery/quote` |
| Geocode | `POST /api/v1/geo/geocode` |
| Pedido | `POST /api/v1/orders` (orders-api) |
| Detalhe | `GET /api/v1/orders/{orderId}` |

Pontos de extensão no front: `api-config.js`, helpers de CEP/carrinho em `script.js`, estilos em `style.css`.

## 6. Como alterar com segurança

- Alterou `script.js` ou `style.css` → rode o bump de cache ou incremente `?v=` em `index.html` (hoje ~`?v=57`).  
- Não commitar URL de produção em `api-config.js`; use env da Vercel (`API_BASE_URL`) no build.  
- Teste com API no ar; sem API o cardápio mostra erro de carregamento.  
- Deploy do front: [README-DEPLOY.md](../../README-DEPLOY.md) — não misturar com deploy da API.  
- Checklist geral: [06-como-atualizar.md](06-como-atualizar.md).
