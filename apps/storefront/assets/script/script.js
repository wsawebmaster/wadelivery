(function () {
  'use strict';

  const API_BASE = (window.API_BASE_URL || 'http://localhost:5100').replace(/\/$/, '');
  // Dados de pedido ficam separados por loja (todas as lojas compartilham o mesmo domínio).
  // A Fabin mantém as chaves originais para não perder carrinhos já salvos.
  const STORE_KEY_SUFFIX = window.WA_TENANT_SLUG && window.WA_TENANT_SLUG !== 'fabin' ? `:${window.WA_TENANT_SLUG}` : '';
  const CART_STORAGE_KEY = 'fabin-lanches-cart' + STORE_KEY_SUFFIX;
  const CHECKOUT_STORAGE_KEY = 'fabin-lanches-checkout';
  /** Caderno de endereços do CLIENTE (não confundir com endereço da loja). */
  const CUSTOMER_ADDRESSES_KEY = 'fabin-lanches-customer-addresses';
  const LAST_ORDER_KEY = 'fabin-lanches-last-order' + STORE_KEY_SUFFIX;
  /** Credenciais de acompanhamento — só limpa em Finalizado/Cancelado (não na edição de itens). */
  const TRACK_CREDS_KEY = 'fabin-lanches-track-creds' + STORE_KEY_SUFFIX;
  const REPEAT_ASKED_KEY = 'fabin-lanches-repeat-asked' + STORE_KEY_SUFFIX;
  /** Flag de SESSÃO da equipe: carimba quando o localStorage recusar persistir o
   * carrinho vazio após pedido staff (tablet PWA com storage bloqueado/cheio).
   * No load, forçamos carrinho vazio — um reload não pode "restaurar" os itens. */
  const STAFF_CART_CLEARED_KEY = 'fabin-lanches-staff-cart-cleared' + STORE_KEY_SUFFIX;
  const INSTALL_BAR_VISIBLE_MS = 3_000;
  /** Poll do acompanhamento: curto o bastante para refletir confirmação no admin sem SSE público. */
  const ORDER_TRACK_POLL_MS = 3_000;
  /** Mesmo fuso do admin e da catalog-api (expediente da loja). */
  const APP_TIMEZONE = 'America/Sao_Paulo';

  let deferredInstallPrompt = null;
  let installBarHideTimer = null;
  let cfg = null;
  let cart = [];
  let total = 0;
  let bairroValor = 0;
  let bairroNome = '';
  /** null | 'delivery' | 'pickup' | 'dine_in' */
  let fulfillmentMode = null;
  /** Contexto de consumo no local (mesa). null quando não está numa mesa. */
  let dineInTable = null;
  /** JWT do garçom/admin quando o cardápio é aberto autenticado (?token=). null no modo cliente. */
  let waiterToken = null;
  const WAITER_SESSION_KEY = 'fabin_waiter_session' + STORE_KEY_SUFFIX; // { token, tableId, label }
  /** Token JWT obtido no login do garçom pela tela de atendimento (antes de escolher canal/mesa). */
  let mesasAuthToken = null;
  /** Nome de exibição do garçom (claim "name" do JWT), exibido no cardápio. */
  let waiterName = null;
  /** Username digitado no login da tela de atendimento (fallback de exibição). */
  let mesasUserName = null;
  /** Origem de atendimento fora do dine-in: 'balcao' | 'delivery' | 'telefone'. null = fluxo normal. */
  let staffSource = null;
  const STAFF_SESSION_KEY = 'fabin_staff_session' + STORE_KEY_SUFFIX; // { token, source, name }
  /** Trava anti-duplo clique/reenvio durante o checkout (processamento pode demorar). */
  let checkoutInFlight = false;
  /** Chave de idempotência do pedido em andamento; reutilizada em retries e trocada a cada pedido novo. */
  let checkoutKey = null;
  let enderecoBase = '';
  let lastCep = null;
  let deliveryOk = false;
  let deliveryDistanceKm = null;
  let openModalCount = 0;
  let scrollTopWhenModalOpened = 0;
  let activeCategory = null;
  let productSearchQuery = '';
  let categoryNavResizeBound = false;
  let pendingOptionAdd = null;
  /** Categoria "Mais Vendidos" injetada automaticamente a partir dos pedidos reais. */
  const MAIS_VENDIDOS_ID = 'mais-vendidos';
  const MAIS_VENDIDOS_TITLE = 'Mais Vendidos';
  const MAIS_VENDIDOS_LIMIT = 10;
  /** Endereço do cliente selecionado no checkout. */
  let selectedCustomerAddressId = null;
  let editingCustomerAddressId = null;
  let addressFormOpen = false;
  let resolvedViaCep = null;

  /** Regras de opção por categoria/produto (ordem importa). */
  const DEFAULT_BREAD_OPTIONS = [
    { id: 'pao-frances', label: 'Pão francês', available: true },
    { id: 'pao-hamburguer', label: 'Pão hambúrguer', available: true }
  ];

  function getAvailableBreadLabels() {
    const raw = Array.isArray(cfg?.breadOptions) && cfg.breadOptions.length
      ? cfg.breadOptions
      : DEFAULT_BREAD_OPTIONS;
    return raw
      .filter((o) => o && o.available !== false)
      .map((o) => String(o.label || o.name || '').trim())
      .filter(Boolean);
  }

  function buildBreadQuestion(labels) {
    if (labels.length <= 1) return 'Confirme o tipo de pão:';
    if (labels.length === 2) return `Prefere ${labels[0].toLowerCase()} ou ${labels[1].toLowerCase()}?`;
    return 'Escolha o tipo de pão:';
  }

  function normalizeMenuLabel(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function isPortionsCategory(category) {
    if (!category) return false;
    const id = normalizeMenuLabel(category.id);
    const title = normalizeMenuLabel(category.title);
    return id.includes('porc') || title.includes('porcoes') || title.includes('porcao');
  }

  function isIngredientsCategory(category) {
    if (!category) return false;
    const names = new Set(['ingredientes', 'ingrediente', 'ingredients', 'ingredient']);
    return names.has(normalizeMenuLabel(category.title)) || names.has(normalizeMenuLabel(category.id));
  }

  function isAddonsCategory(category) {
    if (!category) return false;
    const names = new Set(['adicionais', 'adicional', 'addons', 'addon']);
    return names.has(normalizeMenuLabel(category.title)) || names.has(normalizeMenuLabel(category.id));
  }

  /** Categorias de lanches que pedem confirmação do tipo de pão (id ou título). */
  function isBreadCategory(category) {
    if (!category) return false;
    const id = normalizeMenuLabel(category.id);
    const title = normalizeMenuLabel(category.title);
    return (
      id === 'hamburguer' ||
      id === 'especiais' ||
      id === 'vegetarianos' ||
      id === 'frango' ||
      title.includes('frango') ||
      title.includes('linguica')
    );
  }

  function isHiddenMenuCategory(category) {
    return isIngredientsCategory(category) || isAddonsCategory(category);
  }

  function hasPortionSizes(item) {
    if (!item || item.priceMedia == null || item.priceInteira == null) return false;
    const media = Number(item.priceMedia);
    const inteira = Number(item.priceInteira);
    return Number.isFinite(media) && Number.isFinite(inteira) && media >= 0 && inteira >= 0;
  }

  function getProductOptionRules() {
    const breads = getAvailableBreadLabels();
    return [
      {
        id: 'hotdog-style',
        match: (category, item) =>
          (category && category.id === 'hot-dog') ||
          /hot[\s-]?dog/i.test(item.name || '') ||
          /hot-dog/i.test(item.id || ''),
        question: 'Prefere prensado ou normal?',
        options: ['Normal', 'Prensado']
      },
      {
        id: 'porcao-tamanho',
        match: (category, item) => isPortionsCategory(category) && hasPortionSizes(item),
        question: 'Prefere média ou inteira?',
        options: ['Média', 'Inteira'],
        optionPricesFromItem: (item) => ({
          'Média': Number(item.priceMedia),
          Inteira: Number(item.priceInteira)
        })
      },
      {
        id: 'lanche-pao',
        match: (category) => isBreadCategory(category),
        question: buildBreadQuestion(breads),
        options: breads
      }
    ];
  }

  /** Ex.: "Queijo, alface e tomate." */
  function formatIngredientsPhrase(names) {
    const items = (Array.isArray(names) ? names : [])
      .map((n) => String(n || '').trim())
      .filter(Boolean);
    if (!items.length) return '';

    items[0] = items[0].charAt(0).toUpperCase() + items[0].slice(1);

    let text;
    if (items.length === 1) {
      text = items[0];
    } else if (items.length === 2) {
      text = `${items[0]} e ${items[1]}`;
    } else {
      text = `${items.slice(0, -1).join(', ')} e ${items[items.length - 1]}`;
    }

    return text.endsWith('.') ? text : `${text}.`;
  }

  function formatMoney(value) {
    const n = Number(value);
    return (Number.isFinite(n) ? n : 0).toLocaleString(cfg?.currencyLocale || 'pt-BR', {
      style: 'currency',
      currency: 'BRL'
    });
  }

  /** Preço da opção só se existir valor explícito; null/undefined NÃO viram 0. */
  function resolveOptionUnitPrice(basePrice, optionPrices, option) {
    const fallback = Number(basePrice);
    const base = Number.isFinite(fallback) ? fallback : 0;
    if (!optionPrices || option == null || option === '') return base;
    if (!Object.prototype.hasOwnProperty.call(optionPrices, option)) return base;
    const priced = optionPrices[option];
    if (priced == null || priced === '') return base;
    const n = Number(priced);
    return Number.isFinite(n) ? n : base;
  }

  function lineTotal(item) {
    const price = Number(item && item.price);
    const qty = Number(item && item.quantity);
    const p = Number.isFinite(price) ? price : 0;
    const q = Number.isFinite(qty) ? qty : 0;
    return p * q;
  }

  function calcItemsTotal() {
    return cart.reduce((sum, item) => sum + lineTotal(item), 0);
  }

  function calcItemsCount() {
    return cart.reduce((sum, item) => {
      const q = Number(item && item.quantity);
      return sum + (Number.isFinite(q) ? q : 0);
    }, 0);
  }

  function debounce(fn, wait) {
    let t;
    return function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), wait);
    };
  }

  function sanitizeInput(input) {
    return String(input || '').replace(/['";=()<>`]/g, '').trim();
  }

  function onlyDigits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function maskCep(value) {
    const d = onlyDigits(value).slice(0, 8);
    if (d.length <= 5) return d;
    return d.slice(0, 5) + '-' + d.slice(5);
  }

  function maskPhone(value) {
    const d = onlyDigits(value).slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : '';
    if (d.length <= 7) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  function validatePhone(phone) {
    const d = onlyDigits(phone);
    return /^(?:55)?(\d{2})9\d{8}$/.test(d);
  }

  function parseTimeToMinutes(hhmm) {
    const parts = String(hhmm || '00:00').split(':').map(Number);
    const h = Number.isFinite(parts[0]) ? parts[0] : 0;
    const m = Number.isFinite(parts[1]) ? parts[1] : 0;
    return h * 60 + m;
  }

  function formatClock(hhmm) {
    const raw = String(hhmm || '').trim();
    if (/^\d{1,2}:\d{2}$/.test(raw)) {
      const [h, m] = raw.split(':');
      return `${String(h).padStart(2, '0')}:${m}`;
    }
    return raw || '--:--';
  }

  /** Dia/hora do expediente em America/Sao_Paulo (igual admin e API). */
  function saoPauloParts(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: APP_TIMEZONE,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    let hour = Number(get('hour'));
    if (hour === 24) hour = 0;
    return {
      day: weekdayMap[get('weekday')] ?? now.getDay(),
      hour,
      minute: Number(get('minute')),
      year: Number(get('year')),
      month: Number(get('month')),
      date: Number(get('day'))
    };
  }

  function perDayFromConfig() {
    const s = cfg?.schedule;
    if (!s) return [];
    if (Array.isArray(s.perDay) && s.perDay.length) return s.perDay;
    const days = (s.days || []).map(Number).filter((d) => d >= 0 && d <= 6);
    return Array.from({ length: 7 }, (_, day) => ({
      day,
      enabled: days.includes(day),
      open: s.open || '18:00',
      close: s.close || '23:55',
      breakEnabled: false,
      breakStart: '',
      breakEnd: '',
      deliveryMinutes: null
    }));
  }

  function perDayEntryFor(day) {
    return perDayFromConfig().find((p) => Number(p.day) === day);
  }

  function scheduleDaysList() {
    return perDayFromConfig()
      .filter((p) => p.enabled)
      .map((p) => p.day)
      .sort((a, b) => a - b);
  }

  function formatScheduleDays(days) {
    const names = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const sorted = [...new Set(days.map(Number))].sort((a, b) => a - b);
    if (!sorted.length) return 'em dias não definidos';
    if (sorted.length === 7) return 'todos os dias';

    // Faixa contínua (ex.: 1..6 => segunda a sábado)
    let contiguous = true;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] !== sorted[i - 1] + 1) {
        contiguous = false;
        break;
      }
    }
    if (contiguous && sorted.length > 1) {
      return `de ${names[sorted[0]]} a ${names[sorted[sorted.length - 1]]}`;
    }

    if (sorted.length === 1) return names[sorted[0]];
    const labels = sorted.map((d) => names[d]);
    const last = labels.pop();
    return `${labels.join(', ')} e ${last}`;
  }

  function buildClosedMessage() {
    if (!cfg || !cfg.schedule) return 'Estamos fechados no momento.';
    const enabled = perDayFromConfig().filter((p) => p.enabled).sort((a, b) => a.day - b.day);
    if (!enabled.length) return 'Estamos fechados no momento.';
    const daysText = formatScheduleDays(enabled.map((d) => d.day));
    const groups = [];
    for (const d of enabled) {
      const g = groups.find((x) => x.open === d.open && x.close === d.close);
      if (g) g.days.push(d.day);
      else groups.push({ open: d.open, close: d.close, days: [d.day] });
    }
    const hours = groups.length === 1
      ? `das ${formatClock(groups[0].open)} às ${formatClock(groups[0].close)}`
      : groups
        .map((g) => `${formatScheduleDays(g.days)} das ${formatClock(g.open)} às ${formatClock(g.close)}`)
        .join('; ');
    const base = `Estamos fechados no momento. Funcionamos ${daysText}, ${hours}.`;
    const custom = String(cfg.schedule.closedMessage || '').trim();
    // Se a mensagem customizada for só um texto curto sem horário, usa como prefixo
    if (custom && !/\d{1,2}:\d{2}/.test(custom) && !/funcionamos/i.test(custom)) {
      return `${custom.replace(/\.*$/, '')}. Funcionamos ${daysText}, ${hours}.`;
    }
    return base;
  }

  function isWithinExtendedClose(now = new Date()) {
    const raw = cfg && cfg.extendedCloseUntilUtc;
    if (!raw) return false;
    const until = new Date(raw);
    return !Number.isNaN(until.getTime()) && until.getTime() > now.getTime();
  }

  /** Resolve a entrada per-day que governa o momento (dia corrente ou anterior na madrugada). */
  function resolveActiveEntry(sp, current) {
    const today = perDayEntryFor(sp.day);
    const yesterday = perDayEntryFor((sp.day + 6) % 7);
    if (today?.enabled) {
      const tOpen = parseTimeToMinutes(today.open);
      const tClose = parseTimeToMinutes(today.close);
      if (tOpen != null && tClose != null) {
        if (tClose >= tOpen) {
          if (current >= tOpen && current <= tClose) return today;
        } else if (current >= tOpen) {
          return today;
        }
      }
    }
    if (yesterday?.enabled) {
      const yOpen = parseTimeToMinutes(yesterday.open);
      const yClose = parseTimeToMinutes(yesterday.close);
      if (yOpen != null && yClose != null && yClose < yOpen && current <= yClose) return yesterday;
    }
    return null;
  }

  function isStoreOpen(now = new Date()) {
    if (!cfg || !cfg.schedule) return false;
    if (isWithinExtendedClose(now)) return true;
    const sp = saoPauloParts(now);
    return resolveActiveEntry(sp, sp.hour * 60 + sp.minute) !== null;
  }

  function isStoreOnBreak(now = new Date()) {
    if (isWithinExtendedClose(now)) return false;
    const sp = saoPauloParts(now);
    const current = sp.hour * 60 + sp.minute;
    const entry = resolveActiveEntry(sp, current);
    if (!entry || !entry.breakEnabled) return false;
    const start = parseTimeToMinutes(entry.breakStart);
    const end = parseTimeToMinutes(entry.breakEnd);
    if (start == null || end == null) return false;
    return current >= start && current <= end;
  }

  function applyStoreConfigFields(store) {
    if (!cfg || !store) return;
    cfg.storeName = store.storeName || cfg.storeName;
    cfg.logoUrl = store.logoUrl != null ? store.logoUrl : cfg.logoUrl;
    cfg.iconUrl = store.iconUrl || '';
    cfg.whatsapp = store.whatsapp != null ? store.whatsapp : cfg.whatsapp;
    cfg.pixKey = store.pixKey != null ? store.pixKey : cfg.pixKey;
    cfg.pixKeyLabel = store.pixKeyLabel != null ? store.pixKeyLabel : cfg.pixKeyLabel;
    if (store.minOrder != null) cfg.minOrder = store.minOrder;
    if (store.schedule) cfg.schedule = store.schedule;
    if (store.deliveryFees) cfg.deliveryFees = store.deliveryFees;
    if (store.address != null) cfg.address = store.address;
    if (store.city != null) cfg.city = store.city;
    if (store.state != null) cfg.state = store.state;
    if (store.latitude !== undefined) cfg.latitude = store.latitude;
    if (store.longitude !== undefined) cfg.longitude = store.longitude;
    if (store.deliveryFeePerKm != null) cfg.deliveryFeePerKm = Number(store.deliveryFeePerKm || 0);
    if (store.maxDeliveryKm != null) cfg.maxDeliveryKm = Number(store.maxDeliveryKm || 0);
    if (store.minDeliveryFee != null) cfg.minDeliveryFee = Number(store.minDeliveryFee || 0);
    if (typeof store.whatsAppOrderTemplate === 'string') cfg.whatsAppOrderTemplate = store.whatsAppOrderTemplate;
    if (store.averageDeliveryMinutes != null) {
      cfg.averageDeliveryMinutes = Number(store.averageDeliveryMinutes || 40);
    }
    if (Array.isArray(store.breadOptions)) cfg.breadOptions = store.breadOptions;
    cfg.acceptingOrders = store.acceptingOrders !== false;
    cfg.extendedCloseUntilUtc = store.extendedCloseUntilUtc || null;
    syncPixPaymentOption();
    // Na prévia do painel o tema vem do editor (ainda não salvo), não da loja.
    if (!IS_THEME_PREVIEW) applyThemeFields(store);
  }

  const THEME_FIELDS = ['tipoCard', 'corPrimaria', 'corSecundaria', 'corFundo', 'corTexto'];
  const HERO_FIELDS = ['heroEnabled', 'heroProductId', 'heroTitle', 'heroSubtitle'];

  /**
   * Aparência escolhida no painel (Loja → Aparência). Reaplica o tema quando algo mudou,
   * para o cardápio aberto se atualizar sozinho na próxima consulta da loja.
   */
  function applyThemeFields(source) {
    if (!cfg || !source) return;
    let changed = false;
    THEME_FIELDS.forEach((field) => {
      const value = source[field];
      if (typeof value === 'string' && value && cfg[field] !== value) {
        cfg[field] = value;
        changed = true;
      }
    });
    if (changed && document.body.classList.contains('tenant-themed')) applyTenantTheme();

    let heroChanged = false;
    HERO_FIELDS.forEach((field) => {
      if (!(field in source)) return;
      const value = field === 'heroEnabled' ? source[field] === true : String(source[field] || '');
      if (cfg[field] !== value) {
        cfg[field] = value;
        heroChanged = true;
      }
    });
    if (heroChanged) renderStoreHero();
  }

  function findMenuItemById(productId) {
    for (const cat of cfg?.menu || []) {
      const item = (cat.items || []).find((i) => i.id === productId);
      if (item) return item;
    }
    return null;
  }

  /**
   * Destaque no topo do cardápio (painel → Loja → Aparência): título, subtítulo, produto
   * carro-chefe e informações rápidas (tempo médio de entrega e formas de pagamento).
   */
  function renderStoreHero() {
    const hero = document.getElementById('storeHero');
    if (!hero) return;
    if (!cfg || !cfg.heroEnabled || waiterToken || staffSource) {
      hero.hidden = true;
      hero.innerHTML = '';
      return;
    }
    const product = cfg.heroProductId ? findMenuItemById(cfg.heroProductId) : null;
    const title = cfg.heroTitle || cfg.storeName || '';
    const minutes = Number(cfg.averageDeliveryMinutes) || 0;
    const payments = [cfg.pixKey ? 'Pix' : null, 'Cartão', 'Dinheiro'].filter(Boolean);
    const chips = [
      minutes > 0 ? `⏱️ Entrega média: <strong>${minutes}–${minutes + 15} min</strong>` : '',
      `💳 ${escapeHtml(payments.length > 2 ? `${payments.slice(0, -1).join(', ')} ou ${payments[payments.length - 1]}` : payments.join(' ou '))}`
    ].filter(Boolean);

    let productHtml = '';
    if (product) {
      const image = resolveAssetUrl(product.imageUrl);
      const price = hasPortionSizes(product)
        ? `A partir de ${formatMoney(Math.min(product.priceMedia, product.priceInteira))}`
        : formatMoney(product.price);
      const badge = PRODUCT_BADGES[product.badge];
      productHtml =
        `<article class="store-hero-product">` +
        (image ? `<div class="store-hero-media"><img src="${escapeHtml(image)}" alt="${escapeHtml(product.name)}" loading="lazy"></div>` : '') +
        (badge ? `<span class="item-badge item-badge--${badge.style}">${escapeHtml(badge.label)}</span>` : '') +
        `<div class="store-hero-product-body">` +
        `<div><strong class="store-hero-product-name">${escapeHtml(product.name)}</strong>` +
        (product.description ? `<p class="store-hero-product-desc">${escapeHtml(product.description)}</p>` : '') +
        `</div><div class="store-hero-product-foot"><span class="store-hero-price">${escapeHtml(price)}</span>` +
        `<button type="button" class="store-hero-add" data-hero-add>+ Pedir o carro-chefe</button></div>` +
        `</div></article>`;
    }

    hero.innerHTML =
      `<div class="store-hero-text">` +
      (title ? `<h2 class="store-hero-title">${escapeHtml(title)}</h2>` : '') +
      (cfg.heroSubtitle ? `<p class="store-hero-subtitle">${escapeHtml(cfg.heroSubtitle)}</p>` : '') +
      `<div class="store-hero-chips">${chips.map((c) => `<span>${c}</span>`).join('')}</div>` +
      `</div>` + productHtml;
    hero.classList.toggle('has-product', !!product);
    hero.querySelector('.store-hero-product')?.classList.toggle('no-media', !resolveAssetUrl(product?.imageUrl));
    hero.hidden = false;

    hero.querySelector('[data-hero-add]')?.addEventListener('click', () => {
      changeQuantity(product.name, product.price, 1, null, product.id);
    });
  }

  // Prévia do painel (Loja → Aparência): o iframe recebe o tema por postMessage, sem salvar.
  const IS_THEME_PREVIEW = (() => {
    try { return new URLSearchParams(location.search).get('preview') === '1' && window.parent !== window; } catch (_) { return false; }
  })();
  if (IS_THEME_PREVIEW) {
    window.addEventListener('message', (event) => {
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.type !== 'wa-theme-preview' || !data.theme) return;
      applyThemeFields(data.theme);
    });
  }

  function buildPausedOrdersMessage() {
    return 'Pedimos desculpas, no momento não estamos recebendo pedidos. Por favor, tente novamente mais tarde.';
  }

  function buildBreakMessage() {
    const sp = saoPauloParts(new Date());
    const entry = resolveActiveEntry(sp, sp.hour * 60 + sp.minute);
    if (entry && entry.breakEnd) {
      return `Estamos em intervalo e voltaremos às ${formatClock(entry.breakEnd)}.`;
    }
    return 'Estamos em intervalo e voltaremos em breve.';
  }

  const WEEKDAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
  const CLOSING_SOON_MINUTES = 30;

  /** "Funcionamos de segunda a sábado, das 11:00 às 23:55." (horário semanal resumido). */
  function scheduleSummaryText() {
    const enabled = perDayFromConfig().filter((p) => p.enabled).sort((a, b) => a.day - b.day);
    if (!enabled.length) return '';
    const groups = [];
    for (const d of enabled) {
      const g = groups.find((x) => x.open === d.open && x.close === d.close);
      if (g) g.days.push(d.day);
      else groups.push({ open: d.open, close: d.close, days: [d.day] });
    }
    const hours = groups.length === 1
      ? `${formatScheduleDays(groups[0].days)}, das ${formatClock(groups[0].open)} às ${formatClock(groups[0].close)}`
      : groups.map((g) => `${formatScheduleDays(g.days)} das ${formatClock(g.open)} às ${formatClock(g.close)}`).join('; ');
    return `Funcionamos ${hours}.`;
  }

  /** Próxima abertura a partir de agora: { when: 'hoje'|'amanhã'|'terça', time: '18:30' } ou null. */
  function nextOpening(now = new Date()) {
    const sp = saoPauloParts(now);
    const current = sp.hour * 60 + sp.minute;
    for (let offset = 0; offset <= 7; offset += 1) {
      const day = (sp.day + offset) % 7;
      const entry = perDayEntryFor(day);
      if (!entry?.enabled) continue;
      const open = parseTimeToMinutes(entry.open);
      if (open == null) continue;
      if (offset === 0 && open <= current) continue;
      const when = offset === 0 ? 'hoje' : offset === 1 ? 'amanhã' : WEEKDAY_NAMES[day];
      return { when, time: formatClock(entry.open) };
    }
    return null;
  }

  /**
   * Situação do horário para o selo do cabeçalho e o aviso do cardápio.
   * state: open | closing | break | closed | paused
   */
  function storeHoursStatus(now = new Date()) {
    if (!cfg) return { state: 'closed', label: 'Fechado agora', detail: '' };
    if (cfg.acceptingOrders === false) {
      return { state: 'paused', label: 'Pedidos pausados', detail: buildPausedOrdersMessage() };
    }
    if (isStoreOnBreak(now)) {
      const sp = saoPauloParts(now);
      const entry = resolveActiveEntry(sp, sp.hour * 60 + sp.minute);
      const back = entry?.breakEnd ? formatClock(entry.breakEnd) : '';
      return { state: 'break', label: back ? `Pausa até ${back}` : 'Em pausa', detail: buildBreakMessage() };
    }
    if (isStoreOpen(now)) {
      const sp = saoPauloParts(now);
      const current = sp.hour * 60 + sp.minute;
      let closeAt = null;
      let minutesLeft = null;
      if (isWithinExtendedClose(now)) {
        const until = new Date(cfg.extendedCloseUntilUtc);
        const usp = saoPauloParts(until);
        closeAt = `${String(usp.hour).padStart(2, '0')}:${String(usp.minute).padStart(2, '0')}`;
        minutesLeft = Math.round((until.getTime() - now.getTime()) / 60000);
      } else {
        const entry = resolveActiveEntry(sp, current);
        const close = parseTimeToMinutes(entry?.close);
        if (close != null) {
          closeAt = formatClock(entry.close);
          minutesLeft = close >= current ? close - current : close + 1440 - current;
        }
      }
      if (minutesLeft != null && minutesLeft <= CLOSING_SOON_MINUTES) {
        return {
          state: 'closing',
          label: `Fecha às ${closeAt}`,
          detail: `Fechamos às ${closeAt}. Faça seu pedido nos próximos ${Math.max(1, minutesLeft)} min.`
        };
      }
      return { state: 'open', label: 'Aberto agora', detail: closeAt ? `Aberto até ${closeAt}.` : '' };
    }
    const next = nextOpening(now);
    const reopen = next ? `Abrimos ${next.when} às ${next.time}.` : '';
    return {
      state: 'closed',
      label: next ? (next.when === 'hoje' ? `Abre às ${next.time}` : 'Fechado agora') : 'Fechado agora',
      detail: `Estamos fechados agora. ${reopen}`.trim()
    };
  }

  function canAcceptOrders(now = new Date()) {
    if (cfg && cfg.acceptingOrders === false) return false;
    if (!isStoreOpen(now)) return false;
    return !isStoreOnBreak(now);
  }

  function ordersUnavailableMessage() {
    if (cfg && cfg.acceptingOrders === false) return buildPausedOrdersMessage();
    if (isStoreOnBreak()) return buildBreakMessage();
    // Fechado: diz quando abre de novo, seguido do horário semanal.
    const next = nextOpening();
    const summary = scheduleSummaryText();
    if (next) return `Estamos fechados agora. Abrimos ${next.when} às ${next.time}.${summary ? ` ${summary}` : ''}`;
    return buildClosedMessage();
  }

  function generateOrderId() {
    const n = Date.now().toString(36).toUpperCase().slice(-6);
    return `FL-${n}`;
  }

  // Chave de idempotência: um "checkout" que falhou e for refeito pelo usuário
  // reutiliza a MESMA chave, então o servidor não cria pedido duplicado.
  function generateCheckoutKey() {
    const c = () => Math.random().toString(36).slice(2, 10);
    return `${c()}${c()}${c()}`;
  }

  function saveCart() {
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
    } catch (_) { /* ignore */ }
  }

  function normalizeCartItems(items) {
    if (!Array.isArray(items)) return [];
    return items.map((item) => ({
      id: item.id || null,
      name: item.name,
      price: Number(item.price) || 0,
      quantity: Number(item.quantity) || 0,
      option: item.option || null,
      note: item.note ? String(item.note).slice(0, 120) : '',
      removed: Array.isArray(item.removed)
        ? item.removed.map((r) => String(r).trim()).filter(Boolean)
        : [],
      mods: Array.isArray(item.mods)
        ? item.mods.filter((m) => m && m.groupId && m.optionId).map((m) => ({
            groupId: String(m.groupId).trim(),
            optionId: String(m.optionId).trim(),
            name: String(m.name || m.optionId).trim(),
            priceDelta: Math.max(0, Number(m.priceDelta) || 0)
          }))
        : []
    })).filter((item) => item.name && item.quantity > 0);
  }

  function loadCart() {
    try {
      const raw = localStorage.getItem(CART_STORAGE_KEY);
      if (!raw) return;
      cart = normalizeCartItems(JSON.parse(raw));
    } catch (_) {
      cart = [];
    }
  }

  function loadLastOrder() {
    try {
      const raw = localStorage.getItem(LAST_ORDER_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const items = normalizeCartItems(parsed.items);
      const orderId = parsed.orderId || '';
      const accessToken = parsed.accessToken || '';
      // Permite acompanhamento mesmo sem snapshot local de itens (link compartilhado)
      if (!items.length && !(orderId && accessToken)) return null;
      return {
        orderId,
        accessToken,
        message: typeof parsed.message === 'string' ? parsed.message : '',
        at: Number(parsed.at) || 0,
        tracking: parsed.tracking !== false,
        items
      };
    } catch (_) {
      return null;
    }
  }

  function showStorefrontToast(message, ms = 3400) {
    const el = document.getElementById('storefrontToast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(showStorefrontToast._t);
    showStorefrontToast._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  function saveLastOrder(payload) {
    try {
      localStorage.setItem(LAST_ORDER_KEY, JSON.stringify(payload));
    } catch (_) { /* ignore */ }
  }

  let orderTrackPollTimer = null;
  let orderTrackSseAbort = null;
  let orderTrackSseConnected = false;
  let orderTrackCurrent = null;
  let orderTrackLastNotifiedStatus = '';
  let orderTrackLastItemsUpdatedAt = '';
  let orderWhatsAppTimer = null;

  const ORDER_STATUS_FALLBACK = {
    Created: 'Aguardando Confirmação',
    Accepted: 'Confirmado',
    Preparing: 'Em preparação',
    OutForDelivery: 'Saiu para entrega',
    ReadyForPickup: 'Disponível para retirada',
    ReadyForTable: 'Pronto para a mesa',
    Delivered: 'Finalizado',
    Cancelled: 'Cancelado'
  };

  const ORDER_TRACK_ICON_CHECK =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.2 16.6 4.8 12.2l1.4-1.4 3 3 8.6-8.6 1.4 1.4z"/></svg>';
  const ORDER_TRACK_ICON_PREP =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h2v7a3 3 0 0 0 3 3v6h2v-6a3 3 0 0 0 3-3V4h2v7a5 5 0 0 1-4 4.9V22H8v-6.1A5 5 0 0 1 4 11V4zm14 0h2v10h-2c-1.7 0-3-1.3-3-3V7c0-1.7 1.3-3 3-3z"/></svg>';
  const ORDER_TRACK_ICON_DELIVERY =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h11v8H3V7zm12 2h3.2l2.3 3H15V9zm0 5h6v2h-1.1a2.5 2.5 0 0 1-4.8 0H15v-2zM6.5 18a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm11 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5 11h7V9H5v2z"/></svg>';
  const ORDER_TRACK_ICON_BAG =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8V6a6 6 0 0 1 12 0v2h2v13H4V8h2zm2 0h8V6a4 4 0 0 0-8 0v2zm1 4v2h2v-2H9zm4 0v2h2v-2h-2z"/></svg>';

  /** Etapas de entrega (após confirmação). */
  const ORDER_TRACK_STEPS_DELIVERY = [
    { key: 'Accepted', label: 'Confirmado', icon: ORDER_TRACK_ICON_CHECK },
    { key: 'Preparing', label: 'Em preparação', icon: ORDER_TRACK_ICON_PREP },
    { key: 'OutForDelivery', label: 'Saiu para entrega', icon: ORDER_TRACK_ICON_DELIVERY },
    { key: 'Delivered', label: 'Finalizado', icon: ORDER_TRACK_ICON_BAG }
  ];

  /** Etapas de retirada: Confirmado → Em preparação → Disponível para retirada. */
  const ORDER_TRACK_STEPS_PICKUP = [
    { key: 'Accepted', label: 'Confirmado', icon: ORDER_TRACK_ICON_CHECK },
    { key: 'Preparing', label: 'Em preparação', icon: ORDER_TRACK_ICON_PREP },
    { key: 'ReadyForPickup', label: 'Disponível para retirada', icon: ORDER_TRACK_ICON_BAG }
  ];

  const ORDER_TRACK_STATUS_RANK_DELIVERY = {
    Created: 0,
    Accepted: 1,
    Preparing: 2,
    OutForDelivery: 3,
    Delivered: 4
  };

  const ORDER_TRACK_STATUS_RANK_PICKUP = {
    Created: 0,
    Accepted: 1,
    Preparing: 2,
    ReadyForPickup: 3,
    Delivered: 4
  };

  /** Etapas de consumo no local (mesa): Confirmado → Em preparação → Pronto para a mesa → Finalizado. */
  const ORDER_TRACK_STEPS_DINEIN = [
    { key: 'Accepted', label: 'Confirmado', icon: ORDER_TRACK_ICON_CHECK },
    { key: 'Preparing', label: 'Em preparação', icon: ORDER_TRACK_ICON_PREP },
    { key: 'ReadyForTable', label: 'Pronto para a mesa', icon: ORDER_TRACK_ICON_BAG },
    { key: 'Delivered', label: 'Finalizado', icon: ORDER_TRACK_ICON_CHECK }
  ];

  const ORDER_TRACK_STATUS_RANK_DINEIN = {
    Created: 0,
    Accepted: 1,
    Preparing: 2,
    ReadyForTable: 3,
    Delivered: 4
  };

  function isPickupTrackOrder(order) {
    return String(order?.fulfillmentType || '').toLowerCase() === 'pickup';
  }

  function isDineInTrackOrder(order) {
    return String(order?.fulfillmentType || '').toLowerCase() === 'dine_in';
  }

  function orderStatusLabel(order) {
    if (!order) return '—';
    return order.statusLabel || ORDER_STATUS_FALLBACK[order.status] || order.status || '—';
  }

  function formatTrackTime(date) {
    if (!date || Number.isNaN(date.getTime())) return '—';
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}hs`;
  }

  function getAverageDeliveryMinutes(day = null) {
    if (day != null) {
      const pd = perDayEntryFor(Number(day));
      const v = pd && pd.deliveryMinutes;
      if (Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
    }
    const n = Number(cfg?.averageDeliveryMinutes);
    return Number.isFinite(n) && n > 0 ? n : 40;
  }

  function computeDeliveryEtaRange(order) {
    const created = order?.createdAtUtc ? new Date(order.createdAtUtc) : null;
    if (!created || Number.isNaN(created.getTime())) return null;
    const avg = getAverageDeliveryMinutes(saoPauloParts(created).day);
    const windowMin = Math.max(10, Math.round(avg * 0.35));
    const end = new Date(created.getTime() + avg * 60_000);
    const start = new Date(end.getTime() - windowMin * 60_000);
    if (start.getTime() < created.getTime()) {
      start.setTime(created.getTime() + 5 * 60_000);
    }
    return { start, end };
  }

  function renderOrderTrackCancelledBanner(order) {
    const reason = (order?.cancellationReason || '').trim() || 'Motivo não informado.';
    const byCustomer = !!order?.cancellationCustomerRequested;
    const apology = byCustomer
      ? ''
      : `<p class="ot-cancel-apology">Pedimos desculpas pelo transtorno.</p>`;
    return (
      `<div class="ot-cancelled" role="alert">` +
        `<strong class="ot-cancelled-title">Pedido cancelado</strong>` +
        apology +
        `<p class="ot-cancelled-reason"><span>Motivo:</span> ${escapeHtml(reason)}</p>` +
      `</div>`
    );
  }

  function renderOrderTrackStepper(order) {
    const stepper = document.getElementById('orderTrackStepper');
    const etaBox = document.getElementById('orderTrackEta');
    const etaRange = document.getElementById('orderTrackEtaRange');
    if (!stepper) return;

    if (order?.status === 'Cancelled') {
      stepper.innerHTML = renderOrderTrackCancelledBanner(order);
      stepper.classList.add('is-cancelled');
      if (etaBox) etaBox.hidden = true;
      return;
    }

    stepper.classList.remove('is-cancelled');
    const pickup = isPickupTrackOrder(order);
    const dineIn = isDineInTrackOrder(order);
    const steps = pickup ? ORDER_TRACK_STEPS_PICKUP : (dineIn ? ORDER_TRACK_STEPS_DINEIN : ORDER_TRACK_STEPS_DELIVERY);
    const rankMap = pickup ? ORDER_TRACK_STATUS_RANK_PICKUP : (dineIn ? ORDER_TRACK_STATUS_RANK_DINEIN : ORDER_TRACK_STATUS_RANK_DELIVERY);
    const rank = rankMap[order?.status] || 0;
    stepper.classList.toggle('is-pickup', pickup);
    stepper.classList.toggle('is-dinein', dineIn && !pickup);
    stepper.style.setProperty('--ot-steps', String(steps.length));
    stepper.innerHTML = steps.map((step, idx) => {
      const stepRank = idx + 1;
      let state = '';
      if (rank > stepRank) state = 'is-done';
      else if (rank === stepRank) state = 'is-current';
      // Finalizado no pickup: marca todas as 3 etapas
      if (pickup && order?.status === 'Delivered') state = 'is-done';
      // Finalizado no dine-in: marca todas as etapas do stepper
      if (dineIn && !pickup && order?.status === 'Delivered') state = 'is-done';
      return (
        `<div class="ot-step ${state}" data-step="${escapeHtml(step.key)}">` +
          `<div class="ot-step-icon">${step.icon}</div>` +
          `<div class="ot-step-label">${escapeHtml(step.label)}</div>` +
        `</div>`
      );
    }).join('');

    const eta = computeDeliveryEtaRange(order);
    if (etaBox && etaRange) {
      if (dineIn && !pickup) {
        if (order?.status === 'ReadyForTable') {
          etaRange.textContent = 'Pronto para a mesa';
          etaBox.hidden = false;
        } else if (order?.status === 'Delivered') {
          etaRange.textContent = 'Pedido entregue na mesa';
          etaBox.hidden = false;
        } else if (order?.status === 'Created') {
          etaRange.textContent = 'Aguardando confirmação da loja';
          etaBox.hidden = false;
        } else if (eta && order?.status !== 'Delivered') {
          etaRange.textContent = `Previsão: entre ${formatTrackTime(eta.start)} e ${formatTrackTime(eta.end)}`;
          etaBox.hidden = false;
        } else {
          etaBox.hidden = true;
        }
      } else if (pickup) {
        if (order?.status === 'ReadyForPickup') {
          etaRange.textContent = 'Pronto para retirar na loja';
          etaBox.hidden = false;
        } else if (order?.status === 'Delivered') {
          etaRange.textContent = 'Pedido retirado';
          etaBox.hidden = false;
        } else if (order?.status === 'Created') {
          etaRange.textContent = 'Aguardando confirmação da loja';
          etaBox.hidden = false;
        } else if (eta && order?.status !== 'Delivered') {
          etaRange.textContent = `Previsão: entre ${formatTrackTime(eta.start)} e ${formatTrackTime(eta.end)}`;
          etaBox.hidden = false;
        } else {
          etaBox.hidden = true;
        }
      } else if (eta && order?.status !== 'Delivered') {
        etaRange.textContent = `Entre ${formatTrackTime(eta.start)} e ${formatTrackTime(eta.end)}`;
        etaBox.hidden = false;
      } else if (eta && order?.status === 'Delivered') {
        etaRange.textContent = 'Pedido finalizado';
        etaBox.hidden = false;
      } else {
        etaBox.hidden = true;
      }
    }
  }

  function saveTrackCredentials(orderId, accessToken) {
    if (!orderId || !accessToken) return;
    try {
      localStorage.setItem(TRACK_CREDS_KEY, JSON.stringify({ orderId, accessToken }));
    } catch (_) { /* ignore */ }
    const current = loadLastOrder();
    if (current) {
      saveLastOrder({ ...current, orderId, accessToken, tracking: true });
    }
  }

  function clearTrackCredentials() {
    try {
      localStorage.removeItem(TRACK_CREDS_KEY);
    } catch (_) { /* ignore */ }
    const current = loadLastOrder();
    if (current) {
      saveLastOrder({ ...current, tracking: false, accessToken: '' });
    }
  }

  function readTrackCredentials() {
    try {
      const raw = localStorage.getItem(TRACK_CREDS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed?.orderId && parsed?.accessToken) {
          return { orderId: parsed.orderId, accessToken: parsed.accessToken };
        }
      }
    } catch (_) { /* ignore */ }
    const last = loadLastOrder();
    if (last?.orderId && last?.accessToken) {
      return { orderId: last.orderId, accessToken: last.accessToken };
    }
    return null;
  }

  function hasTrackCredentials() {
    return !!readTrackCredentials();
  }

  /** Botão some só em Finalizado ou Cancelado — não em preparação/aceito/etc. */
  function isTerminalTrackStatus(order) {
    return order?.status === 'Cancelled' || order?.status === 'Delivered';
  }

  function stopOrderTracking(opts = {}) {
    stopOrderTrackSse();
    if (orderTrackPollTimer) {
      clearInterval(orderTrackPollTimer);
      orderTrackPollTimer = null;
    }
    orderTrackCurrent = null;
    orderTrackLastItemsUpdatedAt = '';
    const fab = document.getElementById('orderTrackFab');
    if (fab) fab.hidden = true;
    closeModal('orderTrackModal');
    if (opts.clearTracking !== false) {
      clearTrackCredentials();
    }
  }

  function showOrderTrackFab(statusText) {
    const fab = document.getElementById('orderTrackFab');
    const statusEl = document.getElementById('orderTrackFabStatus');
    if (!fab) return;
    if (statusEl) statusEl.textContent = statusText || '—';
    fab.hidden = false;
  }

  /** Garante o botão no cardápio enquanto o pedido não estiver finalizado/cancelado. */
  function ensureTrackFabVisible() {
    const creds = readTrackCredentials();
    if (!creds) return;
    if (orderTrackCurrent && isTerminalTrackStatus(orderTrackCurrent)) return;
    showOrderTrackFab(
      orderTrackCurrent ? orderStatusLabel(orderTrackCurrent) : ORDER_STATUS_FALLBACK.Created
    );
  }

  function isOrderTrackModalOpen() {
    const modal = document.getElementById('orderTrackModal');
    if (!modal) return false;
    if (modal.style.display === 'flex') return true;
    try {
      return window.getComputedStyle(modal).display === 'flex';
    } catch (_) {
      return false;
    }
  }

  function applyOrderTrackUi(order) {
    if (!order) return;
    showOrderTrackFab(orderStatusLabel(order));
    if (isOrderTrackModalOpen()) {
      renderOrderTrackDetails(order);
    }
  }

  /** Item do acompanhamento: nome com o valor do produto à direita e adicionais abaixo. */
  function orderTrackItemHtml(it) {
    const parts = itemPriceBreakdown(it);
    const qty = String(it.quantity || 0);
    const hasDetail = parts.addons.length > 0 || parts.removed.length > 0 || !!parts.note;
    if (!hasDetail) {
      return `<li>${escapeHtml(qty)}× ${escapeHtml(it.name || '')} — ${formatMoney(parts.total)}</li>`;
    }
    let html = `<li class="ot-item">` +
      `<div class="ot-row ot-item-head"><span>${escapeHtml(qty)}× ${escapeHtml(parts.name || '')}</span><span class="ot-money">${formatMoney(parts.base)}</span></div>`;
    parts.addons.forEach((m) => {
      const delta = Number(m.priceDelta) || 0;
      html += `<div class="ot-row ot-item-line"><span>Adic. ${escapeHtml(m.name)}</span><span class="ot-money">${delta > 0 ? formatMoney(delta * parts.qty) : 'grátis'}</span></div>`;
    });
    parts.removed.forEach((r) => {
      html += `<div class="ot-row ot-item-line"><span>Sem ${escapeHtml(r)}</span><span class="ot-money">grátis</span></div>`;
    });
    if (parts.note) {
      html += `<div class="ot-item-note">Obs.: ${escapeHtml(parts.note)}</div>`;
    }
    return html + `</li>`;
  }

  /**
   * Pedido pago via Pix: mostra a chave da loja com botão de copiar no acompanhamento,
   * enquanto o pagamento não foi confirmado pela loja e o pedido não foi cancelado.
   */
  // O card é redesenhado pelas atualizações do pedido: guarda o "Copiado!" fora do botão.
  let orderTrackPixCopiedUntil = 0;

  function orderTrackPixHtml(order) {
    const isPix = /pix/i.test(String(order?.paymentMethod || ''));
    const pixKey = String(cfg?.pixKey || '').trim();
    const paid = String(order?.paymentStatus || '').toLowerCase() === 'confirmed';
    if (!isPix || paid || order?.status === 'Cancelled') return '';
    if (!pixKey) {
      // Pedido feito com Pix, mas a loja não tem chave cadastrada (ou removeu depois).
      return (
        `<div class="ot-pix ot-pix-missing" role="note">` +
        `<span>A loja ainda não informou a chave Pix. Combine o pagamento pelo WhatsApp.</span>` +
        `</div>`
      );
    }
    const label = String(cfg?.pixKeyLabel || '').trim();
    return (
      `<div class="ot-pix" role="group" aria-label="Chave Pix para pagamento">` +
      `<div class="ot-pix-info">` +
      `<span class="ot-pix-label">Chave Pix${label ? ` (${escapeHtml(label)})` : ''}</span>` +
      `<strong class="ot-pix-key">${escapeHtml(pixKey)}</strong>` +
      `</div>` +
      `<button type="button" class="ot-pix-copy" data-ot-copy-pix>${Date.now() < orderTrackPixCopiedUntil ? 'Copiado!' : 'Copiar chave Pix'}</button>` +
      `</div>`
    );
  }

  function renderOrderTrackDetails(order) {
    const idEl = document.getElementById('orderTrackId');
    const statusEl = document.getElementById('orderTrackStatusLabel');
    const detailsEl = document.getElementById('orderTrackDetails');
    const confirmBtn = document.getElementById('orderTrackConfirmBtn');
    if (idEl) idEl.textContent = order.orderId || '—';
    if (statusEl) statusEl.textContent = orderStatusLabel(order);
    renderOrderTrackStepper(order);

    const items = Array.isArray(order.items) ? order.items : [];
    const itemsHtml = items.length
      ? `<ul class="ot-items">${items.map((it) => orderTrackItemHtml(it)).join('')}</ul>`
      : '<p>Itens indisponíveis.</p>';

    const prevItemsTotal = Number(order.previousItemsTotal);
    const currItemsTotal = Number(order.itemsTotal);
    const itemsValueChanged =
      !!order.itemsUpdatedAtUtc &&
      Number.isFinite(prevItemsTotal) &&
      Math.abs(prevItemsTotal - currItemsTotal) > 0.009;

    const modalContent = document.querySelector('#orderTrackModal .order-track-modal-content');
    if (modalContent) {
      modalContent.classList.toggle('ot-value-alert', itemsValueChanged);
    }

    let itemsUpdatedBanner = '';
    if (itemsValueChanged) {
      const delivery = Number(order.deliveryFee) || 0;
      const prevTotal = prevItemsTotal + delivery;
      const currTotal = currItemsTotal + delivery;
      itemsUpdatedBanner =
        `<div class="ot-items-updated ot-items-value-alert" role="alert">` +
        `<strong>Valor do pedido alterado</strong>` +
        `<p>${escapeHtml(order.itemsChangeSummary || 'A loja atualizou os itens do seu pedido.')}</p>` +
        `<p class="ot-value-change">Total: <s>${formatMoney(prevTotal)}</s> → <strong>${formatMoney(currTotal)}</strong></p>` +
        `</div>`;
    } else if (order.itemsUpdatedAtUtc) {
      // Sem mudança de valor: fluxo atual (aviso suave)
      itemsUpdatedBanner =
        `<div class="ot-items-updated" role="status">` +
        `<strong>Itens atualizados pela loja</strong>` +
        `<p>${escapeHtml(order.itemsChangeSummary || 'Confira a lista e o total abaixo.')}</p>` +
        `</div>`;
    }

    if (detailsEl) {
      const dineIn = isDineInTrackOrder(order);
      const mesa = dineIn
        ? String(order.address || '').replace(/^Mesa\s+/i, '').trim() || tableNumberText() || '—'
        : '';
      detailsEl.innerHTML =
        itemsUpdatedBanner +
        `<div class="ot-row"><span>Cliente</span><span>${escapeHtml(order.customerName || '—')}</span></div>` +
        (dineIn
          ? `<div class="ot-row"><span>Mesa</span><span>${escapeHtml(mesa)}</span></div>`
          : `<div class="ot-row"><span>Telefone</span><span>${escapeHtml(order.customerPhone || '—')}</span></div>` +
            `<div class="ot-row"><span>Endereço</span><span>${escapeHtml(order.address || '—')}</span></div>` +
            (order.neighborhood
              ? `<div class="ot-row"><span>Bairro</span><span>${escapeHtml(order.neighborhood)}</span></div>`
              : '')) +
        `<div class="ot-row"><span>Pagamento</span><span>${escapeHtml(
          order.paymentStatusLabel || order.paymentMethod || '—'
        )}</span></div>` +
        orderTrackPixHtml(order) +
        (order.needsChange && order.changeFor != null
          ? `<div class="ot-row"><span>Troco</span><span class="ot-money">${formatMoney(Number(order.changeFor))}` +
            (Number(order.changeFor) - Number(order.total) > 0
              ? ` · devolve ${formatMoney(Number(order.changeFor) - Number(order.total))}`
              : '') +
            `</span></div>`
          : '') +
        itemsHtml +
        `<div class="ot-row"><span>Sub-total</span><span class="ot-money">${formatMoney(order.itemsTotal || 0)}</span></div>` +
        `<div class="ot-row ot-total"><span>Entrega</span><span class="ot-money">${formatMoney(order.deliveryFee || 0)}</span></div>` +
        `<div class="ot-row ot-total"><span>Total</span><span class="ot-money">${formatMoney(order.total || 0)}</span></div>`;
    }

    if (confirmBtn) {
      const pickup = isPickupTrackOrder(order);
      const dineIn = isDineInTrackOrder(order);
      let canConfirm = false;
      let label = 'Confirmar o recebimento';
      if (pickup) {
        canConfirm = order.status === 'ReadyForPickup' && !order.customerReceived;
        label = 'Confirmar que retirei';
      } else if (dineIn) {
        canConfirm = order.status === 'ReadyForTable' && !order.customerReceived;
        label = 'Confirmar que recebi';
      } else {
        canConfirm = order.status === 'OutForDelivery' && !order.customerReceived;
        label = 'Confirmar o recebimento';
      }
      confirmBtn.hidden = !canConfirm;
      confirmBtn.disabled = !canConfirm;
      confirmBtn.textContent = label;
    }
  }

  /** UI de itens alterados — isolada: nunca encerra acompanhamento nem esconde o FAB. */
  function maybeHandleItemsUpdatedUi(order) {
    if (!order?.itemsUpdatedAtUtc) return;
    const key = String(order.itemsUpdatedAtUtc);
    const justChanged = !!orderTrackLastItemsUpdatedAt && orderTrackLastItemsUpdatedAt !== key;
    orderTrackLastItemsUpdatedAt = key;

    if (justChanged && !isOrderTrackModalOpen()) {
      openOrderTrackModal({ skipRefresh: true, skipNotifyPermission: true });
    } else if (isOrderTrackModalOpen()) {
      renderOrderTrackDetails(order);
    }
    // Reafirma o botão após qualquer UI de alteração de itens
    ensureTrackFabVisible();
  }

  async function refreshOrderTracking() {
    const creds = readTrackCredentials();
    if (!creds) {
      const fab = document.getElementById('orderTrackFab');
      if (fab) fab.hidden = true;
      return false;
    }

    saveTrackCredentials(creds.orderId, creds.accessToken);

    const order = await fetchOrderStatus(creds.orderId, creds.accessToken);
    if (order?.__trackingInvalid) {
      // Pedido/token definitivamente inválido: encerra acompanhamento e limpa
      // as credenciais para não deixar o botão preso em sessões antigas.
      stopOrderTracking({ clearTracking: true });
      return false;
    }
    if (!order) {
      // API indisponível: mantém botão e poll
      ensureTrackFabVisible();
      return true;
    }

    // Pedido de origem equipe (Balcão/garçom) não é acompanhado no cardápio digital:
    // encerra o tracking mesmo com credenciais antigas ou link compartilhado.
    if (isTrackExemptStaffOrder(order)) {
      stopOrderTracking();
      return false;
    }

    orderTrackCurrent = order;
    maybeNotifyOrderStatusChange(order);

    // Só Finalizado / Cancelado encerram o botão
    if (isTerminalTrackStatus(order)) {
      stopOrderTrackSse();
      if (orderTrackPollTimer) {
        clearInterval(orderTrackPollTimer);
        orderTrackPollTimer = null;
      }
      const fab = document.getElementById('orderTrackFab');
      if (fab) fab.hidden = true;

      if (order.status === 'Cancelled' && !isOrderTrackModalOpen()) {
        syncVisualViewportHeight();
        const modal = document.getElementById('orderTrackModal');
        if (modal) {
          modal.style.display = 'flex';
          attachModalCloseHandlers(modal);
        }
        renderOrderTrackDetails(order);
      }

      clearTrackCredentials();
      if (order.status !== 'Cancelled') {
        orderTrackCurrent = null;
        closeModal('orderTrackModal');
      }
      return false;
    }

    // Pedido ativo: FAB primeiro; alteração de itens depois (não pode interferir)
    applyOrderTrackUi(order);
    try {
      maybeHandleItemsUpdatedUi(order);
    } catch (err) {
      console.warn('UI de itens alterados', err);
      ensureTrackFabVisible();
    }
    return true;
  }

  function buildOrderTrackShareUrl(orderId, accessToken) {
    const url = new URL(window.location.href);
    url.searchParams.set('track', orderId || '');
    url.searchParams.set('t', accessToken || '');
    return url.toString();
  }

  function buildOrderTrackShareText(order) {
    const creds = readTrackCredentials();
    const last = loadLastOrder();
    const id = order?.orderId || creds?.orderId || last?.orderId || '';
    const status = orderStatusLabel(order || {});
    const link = buildOrderTrackShareUrl(id, creds?.accessToken || last?.accessToken || '');
    return `Pedido ${id} — ${status}\nAcompanhe: ${link}`;
  }

  async function shareOrderTrackWhatsApp() {
    const last = loadLastOrder();
    // Reenvia o mesmo texto gerado na finalização do pedido (itens, endereço, total…)
    const message = (last?.message || '').trim();
    if (message) {
      openWhatsApp(message);
      return;
    }
    // Fallback (ex.: link de acompanhamento compartilhado sem mensagem salva)
    const order = orderTrackCurrent;
    if (!order && !last) return;
    const text = buildOrderTrackShareText(order);
    const phone = cfg?.whatsapp ? `phone=${cfg.whatsapp}&` : '';
    window.open(
      `https://api.whatsapp.com/send?${phone}text=${encodeURIComponent(text)}`,
      '_blank',
      'noopener,noreferrer'
    );
  }

  async function shareOrderTrackLink() {
    const creds = readTrackCredentials();
    const last = loadLastOrder();
    const order = orderTrackCurrent;
    const id = order?.orderId || creds?.orderId || last?.orderId;
    const token = creds?.accessToken || last?.accessToken;
    if (!id || !token) return;
    const text = buildOrderTrackShareText(order || { orderId: id });
    try {
      if (navigator.share) {
        await navigator.share({ title: `Pedido ${id}`, text });
        return;
      }
      window.open(
        `https://api.whatsapp.com/send?text=${encodeURIComponent(text)}`,
        '_blank',
        'noopener,noreferrer'
      );
    } catch (err) {
      if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) return;
    }
  }

  function maybeNotifyOrderStatusChange(order) {
    if (!order?.status || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    if (orderTrackLastNotifiedStatus === order.status) return;
    const prev = orderTrackLastNotifiedStatus;
    orderTrackLastNotifiedStatus = order.status;
    if (!prev) return; // evita notificar no primeiro load
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    try {
      const n = new Notification('Atualização do pedido', {
        body: `${order.orderId}: ${orderStatusLabel(order)}`,
        tag: `order-${order.orderId}`,
        renotify: true
      });
      n.onclick = () => {
        try { window.focus(); } catch (_) { /* ignore */ }
        openOrderTrackModal();
        n.close();
      };
    } catch (_) { /* ignore */ }
  }

  async function ensureCustomerNotifyPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      return (await Notification.requestPermission()) === 'granted';
    } catch (_) {
      return false;
    }
  }

  async function resumeOrderTrackingFromQuery() {
    try {
      // Sessão de equipe ativa (Balcão/atendimento/garçom): não abre acompanhamento
      // do cardápio digital — status do pedido fica no painel.
      if (waiterToken || staffSource) return false;
      const params = new URLSearchParams(window.location.search);
      const orderId = params.get('track');
      const accessToken = params.get('t');
      if (!orderId || !accessToken) return false;
      saveLastOrder({
        orderId,
        accessToken,
        at: new Date().toISOString(),
        tracking: true,
        items: loadLastOrder()?.items || []
      });
      saveTrackCredentials(orderId, accessToken);
      showOrderTrackFab(ORDER_STATUS_FALLBACK.Created);
      // Limpa query para não reabrir em todo refresh
      params.delete('track');
      params.delete('t');
      const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash || ''}`;
      window.history.replaceState({}, '', next);
      const ok = await startOrderTracking();
      if (ok) openOrderTrackModal();
      return ok;
    } catch (_) {
      return false;
    }
  }

  async function resolveTableFromQuery() {
    try {
      const params = new URLSearchParams(window.location.search);
      const tableParam = params.get('table');
      const tokenParam = params.get('token');
      if (tableParam == null || tableParam === '') return false;

      // ── Modo garçom: ?token=<JWT>&table=<tableId> ──
      if (tokenParam) {
        const ok = await resolveWaiterTable(tokenParam, tableParam, params);
        return ok;
      }

      // ── Modo cliente: ?table=<accessCode opaco> (QR na mesa) ──
      const tableCode = tableParam;
      const res = await fetch(`${API_BASE}/api/v1/tables/resolve/${encodeURIComponent(tableCode)}`, {
        cache: 'no-store'
      });
      if (!res.ok) return false;
      const table = await res.json();
      // Mesa inválida/desativada ou recurso desligado na loja: NÃO bloqueia o
      // cardápio, apenas ignora o contexto.
      if (!table || !table.active || cfg?.dineInEnabled !== true || cfg?.customerQrOrdersEnabled !== true || !table.allowCustomerOrder) {
        return false;
      }
      applyDineInContext({ accessCode: tableCode, label: table.label, tableId: table.tableId, allowCustomerOrder: table.allowCustomerOrder });
      if (table.allowCustomerOrder) {
        clearTableQuery(params);
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  async function resolveWaiterTable(token, tableIdParam, params) {
    const tableId = Number(tableIdParam);
    if (!Number.isInteger(tableId) || tableId <= 0) {
      clearWaiterSession(params);
      return false;
    }
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/tables`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        clearWaiterSession(params);
        return false;
      }
      const tables = await res.json();
      const table = Array.isArray(tables) ? tables.find((t) => Number(t.id) === tableId) : null;
      if (!table || !table.active || cfg?.dineInEnabled !== true) {
        clearWaiterSession(params);
        return false;
      }

      waiterToken = token;
      waiterName = readWaiterNameFromToken(token);
      updateMesasHeader();
      applyDineInContext({ accessCode: null, label: table.label, tableId: table.id, allowCustomerOrder: true, isWaiter: true });
      try {
        sessionStorage.setItem(WAITER_SESSION_KEY, JSON.stringify({ token, username: mesasUserName || null, tableId: table.id, label: table.label, mesas: true }));
      } catch (_) { /* storage indisponível */ }
      clearTableQuery(params);
      return true;
    } catch (_) {
      clearWaiterSession(params);
      return false;
    }
  }

  function clearWaiterSession(params) {
    waiterToken = null;
    dineInTable = null;
    try { sessionStorage.removeItem(WAITER_SESSION_KEY); } catch (_) { /* storage indisponível */ }
    if (params) clearTableQuery(params);
  }

  function applyDineInContext(table) {
    dineInTable = table;
    fulfillmentMode = 'dine_in';
    deliveryOk = true;
    deliveryDistanceKm = null;
    bairroNome = 'Mesa';
    bairroValor = 0;
  }

  function clearTableQuery(params) {
    params.delete('table');
    params.delete('token');
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash || ''}`;
    window.history.replaceState({}, '', next);
  }

  // True se o caminho atual é a rota /login (tela de atendimento do garçom).
  function isLoginPath(path) {
    const p = String(path || '').replace(/\/+$/, '');
    return p === '/login' || p.endsWith('/login');
  }

  // Tela de atendimento solicitada via rota /login.
  function isLoginRequested() {
    return isLoginPath(window.location.pathname);
  }

  // Restaura a sessão de garçom em navegações/refresh dentro do cardápio (já sem ?token= na URL).
  // Restaura localmente a partir da sessão gravada, valendo enquanto o JWT não expirar
  // (default 8h — ≥ 3h), sem depender de round-trip de rede que poderia limpar/forçar login
  // num refresh simples.
  async function tryRestoreWaiterSession() {
    if (waiterToken || isDineInFulfillment()) return false;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(WAITER_SESSION_KEY) || 'null'); } catch (_) { saved = null; }
    if (!saved || !saved.token) return false;

    const payload = decodeJwtPayload(saved.token);
    if (!payload || !payload.exp || payload.exp * 1000 <= Date.now()) {
      clearWaiterSession();
      return false;
    }

    const savedName = saved.username || payload.unique_name || payload.username || null;

    if (!saved.tableId) {
      // Garçom ainda no mapa (login feito, nenhuma mesa escolhida): restaura o
      // login sem pedir usuário/senha, respeitando a duração do JWT.
      mesasAuthToken = saved.token;
      mesasUserName = savedName;
      waiterName = readWaiterNameFromToken(saved.token) || savedName;
      updateMesasHeader();
      return true;
    }

    waiterToken = saved.token;
    waiterName = readWaiterNameFromToken(saved.token) || savedName;
    updateMesasHeader();
    applyDineInContext({
      accessCode: null,
      label: saved.label || ('Mesa ' + saved.tableId),
      tableId: saved.tableId,
      allowCustomerOrder: true,
      isWaiter: true
    });
    if (isLoginPath(window.location.pathname)) window.history.replaceState({}, '', '/');
    return true;
  }

  // /login explícito: com sessão válida (exp = WaiterSessionHours da loja,
  // definido no Painel administrativo), restaura o login para a tela de canais
  // sem pedir credenciais no refresh. Não entra em contexto de mesa nem
  // reescreve a URL. Fallback para a sessão de atendimento (staff) quando não
  // houver sessão de garçom.
  async function restoreLoginGateSession() {
    if (mesasAuthToken || waiterToken) return true;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(WAITER_SESSION_KEY) || 'null'); } catch (_) { saved = null; }
    if (!saved || !saved.token) {
      try { saved = JSON.parse(sessionStorage.getItem(STAFF_SESSION_KEY) || 'null'); } catch (_) { saved = null; }
    }
    if (!saved || !saved.token) return false;
    const payload = decodeJwtPayload(saved.token);
    if (!payload || !payload.exp || payload.exp * 1000 <= Date.now()) {
      clearWaiterSession();
      try { sessionStorage.removeItem(STAFF_SESSION_KEY); } catch (_) { /* storage indisponível */ }
      return false;
    }
    const savedName = saved.username || payload.unique_name || payload.username || null;
    mesasAuthToken = saved.token;
    mesasUserName = savedName;
    waiterName = readWaiterNameFromToken(saved.token) || savedName;
    updateMesasHeader();
    return true;
  }

  // ── Atendimento (Balcão / Delivery / Telefone) ──
  // Aberto via topbar do painel: ?modo=balcao|delivery|telefone&token=<JWT>.
  // O funcionário logado monta o pedido e a origem é registrada no pedido.

  function atendimentoLabel(source) {
    if (source === 'balcao') return 'Balcão';
    if (source === 'telefone') return 'Telefone';
    return 'Delivery';
  }

  // Origens de pedido de equipe que NÃO exibem acompanhamento no cardápio digital
  // (Balcão e garçom/administrador via mesa). O status fica no painel. Delivery e
  // Telefone continuam acompanháveis pelo cliente.
  const TRACK_EXEMPT_STAFF_SOURCES = ['waiter_panel', 'admin_panel', 'balcao'];
  function isTrackExemptStaffSource(src) {
    return TRACK_EXEMPT_STAFF_SOURCES.includes(String(src || '').toLowerCase());
  }
  function isTrackExemptStaffOrder(order) {
    return isTrackExemptStaffSource(order?.orderSource);
  }

  // Resolve o contexto de atendimento a partir da query (?modo=...&token=...) sem
  // round-trip de rede (mesmo critério do restore do garçom: JWT decodificado + exp).
  function resolveAtendimentoFromQuery() {
    if (waiterToken || staffSource || isDineInFulfillment() || isLoginRequested()) return false;
    let params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (_) {
      return false;
    }
    const modo = params.get('modo');
    const token = params.get('token');
    if (!modo || !token) return false;
    if (modo !== 'balcao' && modo !== 'delivery' && modo !== 'telefone') return false;

    const payload = decodeJwtPayload(token);
    if (!payload || !payload.exp || payload.exp * 1000 <= Date.now()) {
      clearStaffSession(params);
      return false;
    }

    const name = readWaiterNameFromToken(token) || payload.unique_name || payload.username || 'Atendente';
    waiterToken = token;
    waiterName = name;
    staffSource = modo;
    fulfillmentMode = modo === 'balcao' ? 'pickup' : 'delivery';
    deliveryDistanceKm = null;
    if (modo === 'balcao') {
      deliveryOk = true;
      bairroNome = 'Retirada';
      bairroValor = 0;
      enderecoBase = storePickupAddress();
    } else {
      // Delivery/Telefone: endereço + CEP ainda são exigidos (mesmo fluxo do cliente).
      deliveryOk = false;
      bairroNome = '';
      bairroValor = 0;
      enderecoBase = '';
    }
    try {
      sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify({
        token,
        source: modo,
        name,
        ...(fulfillmentMode && modo === 'telefone' ? { fulfillment: fulfillmentMode } : {})
      }));
    } catch (_) { /* storage indisponível */ }
    updateUI();
    clearStaffQuery(params);
    return true;
  }

  // Restaura a sessão de atendimento num refresh dentro do cardápio (já sem ?modo= na URL).
  function tryRestoreStaffSession() {
    if (staffSource || isDineInFulfillment()) return false;
    let saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(STAFF_SESSION_KEY) || 'null'); } catch (_) { saved = null; }
    if (!saved || !saved.token || !saved.source) return false;
    const payload = decodeJwtPayload(saved.token);
    if (!payload || !payload.exp || payload.exp * 1000 <= Date.now()) {
      clearStaffSession();
      return false;
    }
    waiterToken = saved.token;
    waiterName = saved.name || readWaiterNameFromToken(saved.token) || 'Atendente';
    staffSource = saved.source;
    // Telefone lembra a escolha Entrega/Retirada do atendente; Balcão/Delivery são fixos.
    fulfillmentMode = saved.source === 'balcao'
      ? 'pickup'
      : (saved.source === 'telefone' && (saved.fulfillment === 'pickup' || saved.fulfillment === 'delivery'))
        ? saved.fulfillment
        : 'delivery';
    deliveryDistanceKm = null;
    if (fulfillmentMode === 'pickup') {
      deliveryOk = true;
      bairroNome = 'Retirada';
      bairroValor = 0;
      enderecoBase = storePickupAddress();
    } else {
      deliveryOk = false;
      bairroNome = '';
      bairroValor = 0;
      enderecoBase = '';
    }
    // Atendimento ativo tem prioridade: descarta sessão de garçom residual para
    // não conflitar com o mapa de mesas em um próximo refresh sem atendimento.
    try { sessionStorage.removeItem(WAITER_SESSION_KEY); } catch (_) { /* storage indisponível */ }
    updateUI();
    return true;
  }

  function clearStaffSession(params) {
    waiterToken = null;
    waiterName = null;
    staffSource = null;
    try { sessionStorage.removeItem(STAFF_SESSION_KEY); } catch (_) { /* storage indisponível */ }
    if (params) clearStaffQuery(params);
  }

  function clearStaffQuery(params) {
    params.delete('modo');
    params.delete('token');
    const next = `${window.location.pathname}${params.toString() ? `?${params}` : ''}${window.location.hash || ''}`;
    window.history.replaceState({}, '', next);
  }

  /** Decodifica o payload de um JWT (base64url → JSON) sem validar assinatura. */
  function decodeJwtPayload(jwt) {
    try {
      const part = String(jwt || '').split('.')[1];
      if (!part) return null;
      const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
      const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
      const json = decodeURIComponent(
        atob(normalized + pad)
          .split('')
          .map((c) => '%' + c.charCodeAt(0).toString(16).padStart(2, '0'))
          .join('')
      );
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  function readWaiterNameFromToken(token) {
    const payload = decodeJwtPayload(token);
    return (payload && (payload.name || payload.displayName || '').trim()) || null;
  }

  // ── Tela de atendimento (/login) ──

  // Atualização instantânea do grid de mesas via webhook (SSE de pedidos +
  // poll de segurança), enquanto o mapa do garçom estiver aberto.
  let mesasSseAbort = null;
  let mesasPollTimer = null;

  function stopMesasLive() {
    if (mesasSseAbort) { mesasSseAbort.abort(); mesasSseAbort = null; }
    if (mesasPollTimer) { clearInterval(mesasPollTimer); mesasPollTimer = null; }
  }

  async function connectMesasLive() {
    stopMesasLive();
    const token = (mesasAuthToken || waiterToken);
    const gate = document.getElementById('mesasGate');
    const map = document.getElementById('mesasMapScreen');
    const isOpen = () => gate && !gate.hidden && map && !map.hidden && (mesasAuthToken || waiterToken);
    if (!token || !isOpen()) return;
    const ctrl = new AbortController();
    mesasSseAbort = ctrl;
    try {
      const res = await fetch(`${API_BASE}/api/v1/orders/stream`, {
        cache: 'no-store',
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${token}` },
        signal: ctrl.signal
      });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!ctrl.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const chunk of parts) {
          if (!chunk.includes('event: orders')) continue;
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          const data = dataLine ? dataLine.slice(5).trim() : '';
          if (data === 'ping' || !isOpen()) continue;
          loadMesasMap({ silent: true }).catch(() => {});
        }
      }
    } catch (_) { /* SSE indisponível — mantém o poll */ }
    finally {
      if (mesasSseAbort === ctrl) mesasSseAbort = null;
    }
    // Poll de segurança enquanto o mapa estiver aberto.
    if (!mesasPollTimer) {
      mesasPollTimer = setInterval(() => {
        if (isOpen()) loadMesasMap({ silent: true }).catch(() => {});
      }, 15000);
    }
    map.dataset.mesasLive = '1';
  }

  function showMesasGate(mode) {
    const gate = document.getElementById('mesasGate');
    if (!gate) return;
    gate.hidden = false;
    document.body.classList.add('mesas-open');
    gate.dataset.mesasMode = mode === 'map' ? 'map' : mode === 'channels' ? 'channels' : 'login';
    const login = document.getElementById('mesasLoginScreen');
    const channels = document.getElementById('mesasChannelsScreen');
    const map = document.getElementById('mesasMapScreen');
    if (mode === 'channels') {
      if (login) login.hidden = true;
      if (map) map.hidden = true;
      if (channels) channels.hidden = false;
      const nameEl = document.getElementById('mesasChannelsName');
      if (nameEl) nameEl.textContent = waiterName || mesasUserName || '';
    } else if (mode === 'map') {
      if (login) login.hidden = true;
      if (channels) channels.hidden = true;
      if (map) map.hidden = false;
      const waiterLabel = document.getElementById('mesasWaiterName');
      if (waiterLabel) waiterLabel.textContent = waiterName || mesasUserName || '';
      loadMesasMap();
      connectMesasLive();
    } else {
      stopMesasLive();
      if (map) map.hidden = true;
      if (channels) channels.hidden = true;
      if (login) login.hidden = false;
      const err = document.getElementById('mesasLoginError');
      if (err) { err.hidden = true; err.textContent = ''; }
    }
  }

  async function mesasLogin() {
    const err = document.getElementById('mesasLoginError');
    const setErr = (msg) => { if (err) { err.textContent = msg || ''; err.hidden = !msg; } };
    setErr('');
    const user = (document.getElementById('mesasLoginUser') || {}).value?.trim() || '';
    const pass = (document.getElementById('mesasLoginPass') || {}).value || '';
    if (!user || !pass) { setErr('Informe usuário e senha.'); return; }
    try {
      const res = await fetch(`${API_BASE}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      if (!res.ok) {
        console.error('[mesasLogin] login recusado', res.status, res.statusText, `${API_BASE}/api/v1/auth/login`);
        setErr('Usuário ou senha inválidos. Verifique se o usuário é da equipe (Admin, Atendimento ou Garçom).');
        return;
      }
      const data = await res.json();
      mesasAuthToken = data.token;
      mesasUserName = data.username || user;
      waiterName = readWaiterNameFromToken(mesasAuthToken) || mesasUserName;
      try {
        // Login no mapa (sem mesa escolhida): persiste a sessão para sobreviver
        // a recargas enquanto o JWT valer (exp = WaiterSessionHours da loja).
        sessionStorage.setItem(WAITER_SESSION_KEY, JSON.stringify({
          token: data.token,
          username: mesasUserName,
          tableId: null,
          label: null,
          mesas: true
        }));
      } catch (_) { /* storage indisponível */ }
      updateMesasHeader();
      showMesasGate('channels');
    } catch (err) {
      console.error('[mesasLogin] falha ao conectar em', `${API_BASE}/api/v1/auth/login`, err, err && err.cause);
      if (!API_BASE || API_BASE.startsWith('/')) {
        setErr('API_BASE inválido/vazio — confira o api-config.js / API_BASE_URL (veja o console F12).');
        return;
      }
      const networkFail = err instanceof TypeError || (err && err.cause && (err.cause.code || '').includes('ERR_'));
      const hint = networkFail
        ? 'Falha de rede/CORS ao chamar a API. Abra o F12 (console) para o detalhe.'
        : 'Não foi possível conectar à API. Tente novamente.';
      setErr(hint);
    }
  }

  // Mesa "em atendimento" = tem comanda(s) na sessão atual (abertas ou pagas).
  function sfTableHasSession(t) {
    if (Number(t?.sessionOrders) > 0) return true;
    return Number(t?.openOrders) > 0;
  }

  // Comanda paga = pagamento confirmado (independente de já entregue).
  function sfComandaIsPaid(c) {
    return String(c?.paymentStatus).toLowerCase() === 'confirmed';
  }

  async function loadMesasMap({ silent = false } = {}) {
    const map = document.getElementById('mesasMap');
    if (!map) return;
    if (!silent) map.innerHTML = '<p class="muted">Carregando mesas…</p>';
    const token = (mesasAuthToken || waiterToken);
    try {
      const res = await fetch(`${API_BASE}/api/v1/admin/tables`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        map.innerHTML = '<p class="muted">Não foi possível carregar as mesas. Verifique se o usuário tem acesso.</p>';
        return;
      }
      const tables = await res.json();
      window._mesasCache = Array.isArray(tables) ? tables : [];
      const active = Array.isArray(tables)
        ? tables
            .filter((t) => t && t.active)
            .sort((a, b) => {
              const an = Number(a?.tableNumber ?? a?.id ?? 0);
              const bn = Number(b?.tableNumber ?? b?.id ?? 0);
              return an - bn || String(a?.label || '').localeCompare(String(b?.label || ''));
            })
        : [];
      if (!active.length) {
        map.innerHTML = '<p class="muted">Nenhuma mesa ativa disponível no momento.</p>';
        return;
      }
      const money = (v) =>
        new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
      // Comandas em ordem (por mesa ocupada) — mesma exibição do painel admin.
      const comandasByTable = new Map();
      const comandasByOrder = new Map();
      await Promise.all(active
        .filter((t) => sfTableHasSession(t))
        .map(async (t) => {
          try {
            const r = await fetch(`${API_BASE}/api/v1/orders/table/${encodeURIComponent(t.id)}`, {
              cache: 'no-store',
              headers: { Authorization: `Bearer ${token}` }
            });
            if (!r.ok) return;
            const list = await r.json();
            if (!Array.isArray(list)) return;
            const sorted = [...list].sort(
              (a, b) => new Date(a.createdAtUtc || 0) - new Date(b.createdAtUtc || 0)
            );
            comandasByTable.set(String(t.id), sorted);
            sorted.forEach((c) => comandasByOrder.set(String(c.orderId), c));
          } catch (_) { /* mantém sem comandas */ }
        }));
      const EYE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
      map.innerHTML = `<div class="mesas-grid">` +
        active.map((t) => {
          const occupied = sfTableHasSession(t);
          const paidOnly = occupied && Number(t.openOrders) === 0;
          const comandas = comandasByTable.get(String(t.id)) || [];
          const hasReady = comandas.some((c) => c.status === 'ReadyForTable');
          let cls = 'is-free';
          if (!t.active) cls = 'is-inactive';
          else if (occupied) cls = 'is-occupied';
          if (hasReady) cls += ' has-ready-order';
          const label = t.label || ('Mesa ' + t.tableNumber);
          const comandasBlock = comandas.length
            ? `<div class="mesas-comandas">` +
              comandas.map((c) => {
                const paid = sfComandaIsPaid(c);
                const eyeCls = c.status === 'ReadyForTable'
                  ? ' mesas-comanda-eye is-ready'
                  : (c.status === 'Delivered'
                      ? ' mesas-comanda-eye is-delivered'
                      : ' mesas-comanda-eye');
                return `<div class="mesas-comanda-row${paid ? ' is-paid' : ''}">` +
                  (paid ? `<span class="mesas-comanda-paid">Pago</span>` : '') +
                  `<span class="mesas-comanda-total">${escapeHtml(money(c.total))}</span>` +
                  `<button type="button" class="${eyeCls}" data-mesas-eye="${escapeAttr(String(c.orderId))}" aria-label="Ver itens do pedido ${escapeAttr(c.orderId)}" title="Ver itens do pedido">${EYE}</button>` +
                  `</div>`;
              }).join('') +
              `</div>`
            : '';
          const topBadge = occupied
            ? `<span class="status-badge status-Ocupada">Ocupada</span>`
            : `<span class="status-badge status-Livre">Livre</span>`;
          return (
            `<div class="mesas-table-card ${cls}" data-table-id="${String(t.id)}" data-table-label="${escapeAttr(label)}" data-table-occupied="${occupied ? '1' : '0'}">` +
            `<div class="mesas-card-top">` +
            `<span class="mesas-table-num">${escapeHtml(label)}</span>` +
            (t.responsibleName ? `<span class="mesas-responsible">${escapeHtml(t.responsibleName)}</span>` : '') +
            topBadge +
            `</div>` +
            `<div class="mesas-table-meta">${escapeHtml(occupied ? (paidOnly ? `${t.sessionOrders} comanda(s) paga(s) · ${money(t.sessionTotal)}` : `${t.openOrders} pedido(s) aberto(s) · ${money(t.openOrdersTotal)}`) : 'Toque para fazer o pedido')}</div>` +
            comandasBlock +
            (occupied ? `<div class="mesas-card-foot">` +
            `<button type="button" class="secondary-btn mesas-foot-btn" data-mesas-action="comanda">Comanda</button>` +
            `<button type="button" class="secondary-btn mesas-foot-btn" data-mesas-action="edit" title="Editar mesa">Editar</button>` +
            `<button type="button" class="finalize mesas-foot-btn" data-mesas-action="neworder">Novo pedido</button>` +
            `</div>` : '') +
            `</div>`
          );
        }).join('') + `</div>`;
      map.querySelectorAll('[data-table-id]').forEach((card) => {
        const id = Number(card.dataset.tableId);
        const label = card.dataset.tableLabel || ('Mesa ' + card.dataset.tableId);
        card.addEventListener('click', (ev) => {
          const eye = ev.target.closest('[data-mesas-eye]');
          if (eye) {
            ev.stopPropagation();
            showStorefrontComandaItems(comandasByOrder.get(eye.getAttribute('data-mesas-eye')));
            return;
          }
          const actionBtn = ev.target.closest('[data-mesas-action]');
          if (actionBtn) {
            ev.stopPropagation();
            if (actionBtn.getAttribute('data-mesas-action') === 'comanda') {
              openStorefrontComanda(id, label);
            } else if (actionBtn.getAttribute('data-mesas-action') === 'edit') {
              openStorefrontEditTableModal(id, label);
            } else {
              selectMesasTable(id, label);
            }
            return;
          }
          // Mesmo comportamento do painel: tocar no card abre o cardápio da mesa.
          selectMesasTable(id, label);
        });
      });
    } catch (_) {
      map.innerHTML = '<p class="muted">Não foi possível carregar as mesas.</p>';
    }
  }

  function selectMesasTable(tableId, label) {
    const token = mesasAuthToken || waiterToken;
    if (!token || !Number.isInteger(tableId) || tableId <= 0) return;
    waiterToken = token;
    applyDineInContext({ accessCode: null, label, tableId, allowCustomerOrder: true, isWaiter: true });
    try {
      sessionStorage.setItem(WAITER_SESSION_KEY, JSON.stringify({ token, username: mesasUserName || null, tableId, label, mesas: true }));
    } catch (_) { /* storage indisponível */ }
    closeMesasGate();
    const params = new URLSearchParams(window.location.search);
    params.delete('modo');
    let path = window.location.pathname;
    if (isLoginPath(path)) path = '/';
    const next = `${path}${params.toString() ? `?${params}` : ''}${window.location.hash || ''}`;
    window.history.replaceState({}, '', next);
    updateUI();
  }

  function showStorefrontComandaItems(comanda) {
    if (!comanda) return;
    const existing = document.getElementById('mesasComandaItemsModal');
    if (existing) existing.remove();
    const money = (v) =>
      new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
    const items = (comanda.items || []).map((it) =>
      `<li><strong>${it.quantity}×</strong> ${escapeHtml(it.name)} <span class="muted"> · ${escapeHtml(money(it.price))}</span></li>`
    ).join('') || '<li class="muted">Sem itens.</li>';
    const paid = sfComandaIsPaid(comanda);
    const terminal = comanda.status === 'Delivered' || comanda.status === 'Cancelled';
    // Garçom só pode marcar entregue na mesa quando a comanda está "Pronto para a mesa".
    const canDeliver = comanda.status === 'ReadyForTable' && !terminal;
    const modal = document.createElement('div');
    modal.id = 'mesasComandaItemsModal';
    modal.className = 'mesas-actions-modal';
    modal.innerHTML =
      `<div class="mesas-actions-card comanda-items-card" role="dialog" aria-modal="true" aria-label="Itens do pedido">` +
      `<div class="mesas-card-head">` +
      `<h3>Pedido ${escapeHtml(comanda.orderId)}</h3>` +
      (paid ? `<span class="status-badge status-Pago">Pago</span>` : '') +
      `</div>` +
      `<ul class="comanda-items-list">${items}</ul>` +
      `<p class="muted">Total: <strong>${escapeHtml(money(comanda.total))}</strong></p>` +
      (canDeliver
        ? `<button type="button" class="finalize mesas-deliver-btn" data-comanda-deliver="${escapeAttr(String(comanda.orderId))}">Entregue na mesa</button>`
        : '') +
      `</div>`;
    document.body.appendChild(modal);
    const done = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') done(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) done(); });
    modal.querySelector('[data-comanda-deliver]')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      done();
      markComandaDelivered(comanda);
    });
    document.addEventListener('keydown', onKey);
  }

  async function markComandaDelivered(comanda) {
    const token = (mesasAuthToken || waiterToken);
    if (!token || !comanda) return;
    try {
      showStorefrontToast('Marcando como entregue...');
      const res = await fetch(`${API_BASE}/api/v1/orders/${encodeURIComponent(comanda.orderId)}/status`, {
        method: 'PATCH',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ status: 'Delivered' })
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error((data && data.error) || 'Não foi possível atualizar o status.');
      }
      showStorefrontToast(`Pedido ${comanda.orderId} entregue na mesa.`);
      if (typeof loadMesasMap === 'function') loadMesasMap();
    } catch (e) {
      showStorefrontToast(e.message || 'Erro ao atualizar o status.');
    }
  }

  function openStorefrontEditTableModal(tableId, label) {
    const token = (mesasAuthToken || waiterToken);
    if (!token || !tableId) return;
    const existing = document.getElementById('sfEditTableModal');
    if (existing) existing.remove();
    const tablesData = (window._mesasCache || []);
    const table = tablesData.find((t) => t.id === tableId);
    const modal = document.createElement('div');
    modal.id = 'sfEditTableModal';
    modal.className = 'modal';
    modal.innerHTML =
      `<div class="modal-content">` +
      `<h2>Editar mesa</h2>` +
      `<p class="muted" style="margin:0 0 0.75rem">${escapeHtml(label)}</p>` +
      `<label class="field-label">Nome do responsável</label>` +
      `<input id="sfEditResponsible" class="input-field" type="text" value="${escapeHtml(table?.responsibleName || '')}" placeholder="Ex.: João" maxlength="120" />` +
      `<label class="field-label">Quantidade de pessoas</label>` +
      `<input id="sfEditGuestCount" class="input-field" type="number" min="1" max="200" value="${table?.guestCount || ''}" placeholder="Ex.: 4" />` +
      `<div style="display:flex;gap:0.5rem;margin-top:1rem;justify-content:flex-end">` +
      `<button type="button" class="secondary-btn" data-sf-edit-cancel>Cancelar</button>` +
      `<button type="button" class="finalize" data-sf-edit-save>Salvar</button>` +
      `</div></div>`;
    const finish = () => { modal.style.display = 'none'; modal.remove(); document.body.classList.remove('modal-open'); };
    const onKey = (e) => { if (e.key === 'Escape') finish(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) finish(); });
    document.addEventListener('keydown', onKey);
    modal.querySelector('[data-sf-edit-cancel]').addEventListener('click', finish);
    modal.querySelector('[data-sf-edit-save]').addEventListener('click', async () => {
      const responsibleName = (document.getElementById('sfEditResponsible') || {}).value?.trim?.() || '';
      const guestCountVal = (document.getElementById('sfEditGuestCount') || {}).value?.trim?.() || '';
      const guestCount = guestCountVal ? Number(guestCountVal) : null;
      const btn = modal.querySelector('[data-sf-edit-save]');
      if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(`${API_BASE}/api/v1/admin/tables/${tableId}/info`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ responsibleName: responsibleName || null, guestCount })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || 'Erro ao salvar.');
        }
        finish();
        showStorefrontToast('Mesa atualizada.');
        loadMesasMap({ silent: true }).catch(() => {});
      } catch (e) {
        showStorefrontToast(e.message || 'Erro ao salvar.');
        if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
      }
    });
    modal.style.display = 'flex';
    document.body.appendChild(modal);
    document.body.classList.add('modal-open');
    (document.getElementById('sfEditResponsible') || {}).focus?.();
  }

  async function openStorefrontComanda(tableId, label) {
    const token = (mesasAuthToken || waiterToken);
    let comandas = [];
    try {
      const res = await fetch(`${API_BASE}/api/v1/orders/table/${encodeURIComponent(tableId)}`, {
        cache: 'no-store',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        comandas = Array.isArray(data) ? data : [];
      }
    } catch (_) { comandas = []; }
    const money = (v) =>
      new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
    const occupied = comandas.length > 0;
    const total = comandas.reduce((s, c) => s + (Number(c.total) || 0), 0);
    const rows = comandas.map((c) => {
      const items = (c.items || []).map((it) => `${it.quantity}× ${escapeHtml(it.name)}`).join(', ') || 'Sem itens';
      const paid = sfComandaIsPaid(c);
      return (
        `<div class="comanda-row${paid ? ' is-paid' : ''}">` +
        `<div class="comanda-row-head"><strong>Atendimento · ${escapeHtml(label)}</strong>` +
        (paid ? `<span class="status-badge status-Pago">Pago</span>` : '') +
        `</div>` +
        `<div class="comanda-row-items">${items}</div>` +
        `<div class="comanda-row-foot"><span>Total: ${money(c.total)}</span>${paid ? `<span class="muted">Pago</span>` : ''}</div>` +
        `</div>`
      );
    }).join('') || '<p class="muted">Nenhuma comanda aberta nesta mesa.</p>';
    const existing = document.getElementById('mesasComandaModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'mesasComandaModal';
    modal.className = 'mesas-actions-modal';
    modal.innerHTML =
      `<div class="mesas-actions-card comanda-card" role="dialog" aria-modal="true" aria-labelledby="mesasComandaTitle">` +
      `<button type="button" class="mesas-modal-x" data-action="x" aria-label="Fechar" title="Fechar">✕</button>` +
      `<h3 id="mesasComandaTitle">Comanda — ${escapeHtml(label)}</h3>` +
      `<p class="muted">${occupied ? 'Ocupada' : 'Livre'} · total acumulado: <strong>${money(total)}</strong></p>` +
      `<div class="comanda-list">${rows}</div>` +
      `<div class="comanda-foot">` +
      `<button type="button" class="primary-btn" data-action="neworder">+ Novo pedido</button>` +
      `<button type="button" class="finalize" data-action="conta">Conta</button>` +
      `</div>` +
      `</div>`;
    document.body.appendChild(modal);
    const done = () => { modal.remove(); };
    modal.querySelector('[data-action="neworder"]')?.addEventListener('click', () => {
      done();
      selectMesasTable(tableId, label);
    });
    modal.querySelector('[data-action="x"]')?.addEventListener('click', (e) => { e.stopPropagation(); done(); });
    modal.querySelector('[data-action="conta"]')?.addEventListener('click', () => {
      done();
      closeStorefrontTable(tableId, label, comandas);
    });
    modal.addEventListener('click', (e) => { if (e.target === modal) done(); });
  }

  const BILL_PAY_METHODS = ['Pix', 'Dinheiro', 'Cartão de Crédito', 'Cartão de Débito'];

  function billMoney(v) {
    return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(Number(v) || 0);
  }

  function billRound(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
  }

  function billClampInt(v, min, max, fallback) {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  }

  // Mesmas regras do painel admin: quem marca "valor fixo" paga o valor digitado;
  // o restante divide a sobra igualmente (a última pessoa absorve os centavos).
  function billSplit(total, tip, people) {
    const amountToCollect = billRound(billRound(total) + billRound(tip));
    const fixedIndices = [];
    const dynamicIndices = [];
    people.forEach((p, i) => (p.fixed ? fixedIndices : dynamicIndices).push(i));
    let fixedSum = 0;
    fixedIndices.forEach((i) => { fixedSum = billRound(fixedSum + billRound(people[i].amount)); });
    const fixedClamped = Math.min(fixedSum, amountToCollect);
    const perDynamic = dynamicIndices.length > 0 ? billRound((amountToCollect - fixedClamped) / dynamicIndices.length) : 0;
    let assigned = 0;
    const result = people.map((p) => ({ name: p.name, amount: 0, fixed: p.fixed }));
    fixedIndices.forEach((i) => {
      result[i].amount = billRound(people[i].amount);
      assigned = billRound(assigned + result[i].amount);
    });
    dynamicIndices.forEach((i, k) => {
      const isLast = k === dynamicIndices.length - 1;
      let val = isLast ? billRound(amountToCollect - assigned) : perDynamic;
      if (val < 0) val = 0;
      result[i].amount = billRound(val);
      assigned = billRound(assigned + val);
    });
    return {
      amountToCollect,
      total: billRound(total),
      tip: billRound(tip),
      result,
      sum: assigned,
      diff: billRound(assigned - amountToCollect),
      overpay: billRound(fixedSum - amountToCollect)
    };
  }

  function storefrontPrintBill(tableLabel, comandas, split) {
    const rows = split.result.map((p, idx) =>
      `${idx + 1}. ${(p.name || `Pessoa ${idx + 1}`).toUpperCase()} .......... ${billMoney(p.amount)}`
    ).join('\n');
    const win = window.open('', '_blank', 'width=420,height=620');
    if (!win) { showStorefrontToast('Pop-up bloqueado. Habilite para imprimir a cobrança.'); return; }
    const comandaRows = comandas.map((c) => {
      const items = (c.items || []).map((it) =>
        `<div style="padding-left:10px;font-size:13px;">${it.quantity}× ${escapeHtml(it.name)} — ${billMoney(it.price || 0)}</div>`
      ).join('');
      return `<tr><td><strong>${escapeHtml(c.orderId)}</strong>${items}</td><td style="text-align:right;vertical-align:top;white-space:nowrap;"><strong>${billMoney(c.total || 0)}</strong></td></tr>`;
    }).join('');
    win.document.write(
      `<html><head><title>Cobrança - ${escapeHtml(tableLabel)}</title></head>` +
      `<body style="font-family:monospace;max-width:360px;margin:20px auto;font-size:14px;">` +
      `<h2 style="text-align:center;margin:0 0 4px;">${escapeHtml(tableLabel)}</h2>` +
      `<p style="text-align:center;margin:0 0 12px;">${new Date().toLocaleString('pt-BR')}</p>` +
      `<table style="width:100%;border-collapse:collapse;">${comandaRows}</table>` +
      `<hr/>` +
      `<p>Total: ${billMoney(split.total)}</p>` +
      (split.tip > 0 ? `<p>Gorjeta: ${billMoney(split.tip)}</p>` : '') +
      `<p><strong>Total a cobrar: ${billMoney(split.amountToCollect)}</strong></p>` +
      `<hr/><h3>Dividir entre ${split.result.length} pessoa(s)</h3>` +
      `<pre style="white-space:pre-wrap;">${escapeHtml(rows)}</pre>` +
      (split.diff !== 0 ? `<p style="color:#b45309;">Diferença de centavos: ${billMoney(split.diff)}</p>` : '') +
      `<button onclick="window.print()" style="margin-top:20px;padding:10px 20px;">Imprimir</button>` +
      `</body></html>`
    );
    win.document.close();
  }

  function showStorefrontCloseReceipt(tableId, label, comandas, split) {
    return new Promise((resolve) => {
      const existing = document.getElementById('mesasCloseReceiptModal');
      if (existing) existing.remove();
      const rows = split.result.map((p, idx) =>
        `<div class="comanda-row-foot" style="justify-content:space-between;margin-top:6px;">` +
        `<span>${escapeHtml(p.name || `Pessoa ${idx + 1}`)}</span>` +
        `<strong>${billMoney(p.amount)}</strong>` +
        `</div>`
      ).join('');
      const modal = document.createElement('div');
      modal.id = 'mesasCloseReceiptModal';
      modal.className = 'mesas-actions-modal';
      modal.innerHTML =
        `<div class="mesas-actions-card comanda-card" role="dialog" aria-modal="true" aria-labelledby="mesasCloseReceiptTitle">` +
        `<h3 id="mesasCloseReceiptTitle">Mesa fechada — ${escapeHtml(label)}</h3>` +
        `<p class="muted">Total cobrado: <strong>${billMoney(split.amountToCollect)}</strong> · ${split.result.length} pagante(s)</p>` +
        `<div class="comanda-list">${rows}</div>` +
        `<div class="mesas-actions-buttons">` +
        `<button type="button" class="finalize" data-receipt-print>Imprimir comprovante</button>` +
        `<button type="button" class="confirm" data-receipt-close>Concluir</button>` +
        `</div></div>`;
      document.body.appendChild(modal);
      const done = () => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(); };
      const onKey = (e) => { if (e.key === 'Escape') done(); };
      modal.querySelector('[data-receipt-close]')?.addEventListener('click', done);
      modal.querySelector('[data-receipt-print]')?.addEventListener('click', () => storefrontPrintBill(label, comandas, split));
      modal.addEventListener('click', (e) => { if (e.target === modal) done(); });
      document.addEventListener('keydown', onKey);
    });
  }

  // "Conta" no cardápio digital: modal de fechamento com forma de pagamento,
  // gorjeta, nº de pagantes e divisão da conta (mesmo fluxo do painel admin).
  async function closeStorefrontTable(tableId, label, comandas) {
    const token = (mesasAuthToken || waiterToken);
    if (!token || !Number.isInteger(tableId) || tableId <= 0) return;
    if (!Array.isArray(comandas) || !comandas.length) {
      showStorefrontToast('Não há comandas abertas nesta mesa.');
      return;
    }
    const paidComandas = comandas.filter((c) => sfComandaIsPaid(c));
    // A divisão da conta cobre apenas o que ainda NÃO foi pago; pagas ficam como registro.
    const outstanding = comandas.filter((c) => !sfComandaIsPaid(c));
    const total = outstanding.reduce((s, c) => s + (Number(c.total) || 0), 0);
    const result = await new Promise((resolve) => {
      const existing = document.getElementById('mesasCloseBillModal');
      if (existing) existing.remove();
      const rows = comandas.map((c) => {
        const items = (c.items || []).map((it) => `${it.quantity}× ${escapeHtml(it.name)}`).join(', ') || 'Sem itens';
        const paid = sfComandaIsPaid(c);
        return (
          `<div class="comanda-row${paid ? ' is-paid' : ''}">` +
          `<div class="comanda-row-head"><strong>Atendimento · ${escapeHtml(label)}</strong>` +
          (paid ? `<span class="status-badge status-Pago">Pago</span>` : '') +
          `</div>` +
          `<div class="comanda-row-items">${items}</div>` +
          `<div class="comanda-row-foot"><span>Total: ${billMoney(c.total)}</span>${paid ? `<span class="muted">Pago</span>` : ''}</div>` +
          `</div>`
        );
      }).join('');

      const cashSectionHtml =
        `<div id="sfCloseCashSection" class="cb-cash-section" hidden>` +
        `<label class="cb-label">Valor recebido (R$)</label>` +
        `<input id="sfCloseCashReceived" class="cb-input" type="number" min="0" step="0.01" value="${total.toFixed(2)}"/>` +
        `<p id="sfCloseCashChange" class="cb-cash-change"></p>` +
        `</div>`;

      const splitSectionHtml =
        `<div id="sfCloseSplitSection" class="cb-split-section" hidden>` +
        `<label class="cb-label">Quantas pessoas pagam?</label>` +
        `<input id="sfClosePeopleCount" class="cb-input" type="number" min="1" max="50" value="1"/>` +
        `<label class="cb-label">Gorjeta (R$, opcional)</label>` +
        `<input id="sfCloseTip" class="cb-input" type="number" min="0" step="0.01" value="0.00"/>` +
        `<div id="sfClosePeopleRows" class="cb-people-rows"></div>` +
        `<p id="sfCloseBalance" class="cb-balance"></p>` +
        `</div>`;

      const modal = document.createElement('div');
      modal.id = 'mesasCloseBillModal';
      modal.className = 'mesas-actions-modal';
      modal.innerHTML =
        `<div class="mesas-actions-card comanda-card" role="dialog" aria-modal="true" aria-labelledby="mesasCloseBillTitle">` +
        `<button type="button" class="mesas-modal-x" data-close-cancel aria-label="Fechar" title="Fechar">✕</button>` +
        `<h3 id="mesasCloseBillTitle">Fechar — ${escapeHtml(label)}</h3>` +
        `<div class="comanda-list">${rows}</div>` +
        `<p class="muted">Total a receber: <strong>${billMoney(total)}</strong> · ${comandas.length} comanda(s)` +
        (paidComandas.length ? ` (<strong>${billMoney(paidComandas.reduce((s, c) => s + (Number(c.total) || 0), 0))}</strong> já pago(s))` : '') +
        `</p>` +
        `<label class="cb-label">Forma de pagamento recebida</label>` +
        `<select id="sfClosePayMethod" class="cb-input">` +
        BILL_PAY_METHODS.map((m) => `<option value="${escapeAttr(m)}">${escapeHtml(m)}</option>`).join('') +
        `</select>` +
        `${cashSectionHtml}` +
        `<label class="cb-check"><input id="sfClosePayReceived" type="checkbox"/> Confirmo que o pagamento foi recebido</label>` +
        `<hr class="cb-hr"/>` +
        `<label class="cb-check cb-split-toggle">` +
        `<input id="sfCloseSplitCheck" type="checkbox"/> Dividir a conta` +
        `</label>` +
        `${splitSectionHtml}` +
        `<p id="sfCloseMsg" class="cb-msg" hidden></p>` +
        `<div class="mesas-actions-buttons cb-actions">` +
        `<button type="button" class="primary-btn" data-close-print>Imprimir cobrança</button>` +
        `<button type="button" class="finalize" data-close-ok>Confirmar fechamento</button>` +
        `</div></div>`;
      document.body.appendChild(modal);

      const done = (v) => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      const rowsEl = modal.querySelector('#sfClosePeopleRows');
      const balanceEl = modal.querySelector('#sfCloseBalance');
      const msgEl = modal.querySelector('#sfCloseMsg');
      const countInput = modal.querySelector('#sfClosePeopleCount');
      const tipInput = modal.querySelector('#sfCloseTip');
      const splitCheck = modal.querySelector('#sfCloseSplitCheck');
      const splitSection = modal.querySelector('#sfCloseSplitSection');
      const payMethodSelect = modal.querySelector('#sfClosePayMethod');
      const cashSection = modal.querySelector('#sfCloseCashSection');
      const cashReceivedInput = modal.querySelector('#sfCloseCashReceived');
      const cashChangeEl = modal.querySelector('#sfCloseCashChange');

      function toggleSplitSection() {
        const on = !!splitCheck?.checked;
        if (splitSection) splitSection.hidden = !on;
        if (on) { renderPeopleRows(); updateSplitBalance(); prefillAmounts(); }
      }

      function toggleCashSection() {
        const isDinheiro = (payMethodSelect?.value || '') === 'Dinheiro';
        if (cashSection) cashSection.hidden = !isDinheiro;
        updateCashChange();
      }

      function updateCashChange() {
        if (!cashChangeEl) return;
        const isDinheiro = (payMethodSelect?.value || '') === 'Dinheiro';
        if (!isDinheiro) { cashChangeEl.textContent = ''; return; }
        const received = billRound(cashReceivedInput?.value);
        const change = received - total;
        cashChangeEl.textContent = change >= 0
          ? `Troco: ${billMoney(change)}`
          : `Falta: ${billMoney(Math.abs(change))}`;
        cashChangeEl.style.color = change >= 0 ? '#16a34a' : '#dc2626';
      }

      function setCbMsg(text, error) {
        if (!msgEl) return;
        if (!text) {
          msgEl.hidden = true;
          msgEl.textContent = '';
          return;
        }
        msgEl.textContent = text;
        msgEl.classList.toggle('is-error', !!error);
        msgEl.hidden = false;
      }

      function currentSplit() {
        const count = billClampInt(Number(countInput?.value), 1, 50, 1);
        const tip = billRound(tipInput?.value);
        const people = [];
        for (let i = 0; i < count; i++) {
          const rowEl = rowsEl?.children[i];
          const name = rowEl?.querySelector('.cb-person-name')?.value?.trim?.() || '';
          const fixed = !!rowEl?.querySelector('.cb-person-fixed')?.checked;
          const amount = billRound(rowEl?.querySelector('.cb-person-amount')?.value);
          people.push({ name, fixed, amount });
        }
        return billSplit(total, tip, people);
      }

      function renderPeopleRows() {
        const count = billClampInt(Number(countInput?.value), 1, 50, 1);
        while (rowsEl && rowsEl.children.length > count) {
          rowsEl.removeChild(rowsEl.lastChild);
        }
        for (let i = rowsEl ? rowsEl.children.length : 0; i < count; i++) {
          if (!rowsEl) break;
          const row = document.createElement('div');
          row.className = 'cb-person-row';
          row.innerHTML =
            `<span class="cb-person-index">${i + 1}.</span>` +
            `<input class="cb-person-name" type="text" placeholder="Nome (opcional)" value=""/>` +
            `<label class="cb-check"><input class="cb-person-fixed" type="checkbox"/> valor fixo</label>` +
            `<input class="cb-person-amount" type="number" min="0" step="0.01" value="" placeholder="R$" disabled/>`;
          rowsEl.appendChild(row);
          const fixedChk = row.querySelector('.cb-person-fixed');
          const amountInput = row.querySelector('.cb-person-amount');
          fixedChk.addEventListener('change', () => {
            amountInput.disabled = !fixedChk.checked;
            updateSplitBalance();
            prefillAmounts();
          });
          amountInput.addEventListener('input', () => { updateSplitBalance(); prefillAmounts(); });
        }
        if (rowsEl && rowsEl.children.length === 0 && count > 0) renderPeopleRows();
      }

      function updateSplitBalance() {
        const split = currentSplit();
        const lines = split.result.map((p, idx) => {
          const labelSafe = escapeHtml(p.name || `Pessoa ${idx + 1}`);
          return `${idx + 1}. ${labelSafe} → <strong>${billMoney(p.amount)}</strong>`;
        }).join('<br/>');
        const tipLine = split.tip > 0 ? `<br/>Gorjeta: <strong>${billMoney(split.tip)}</strong> · ` : '';
        const diffLine = split.diff === 0
          ? '<br/><span style="color:#16a34a;">✓ Total cobrado confere com a conta.</span>'
          : `<br/><span style="color:#d97706;">⚠ Diferença de ${billMoney(split.diff)} — ajuste os valores.</span>`;
        if (balanceEl) {
          balanceEl.innerHTML = `<strong>A cobrar no total: ${billMoney(split.amountToCollect)}</strong>${tipLine}` +
            (lines ? `<br/>${lines}` : '') + diffLine;
        }
        return split;
      }

      // Preenche automaticamente o valor de cada pessoa não-fixa com a parte
      // calculada (a última pessoa absorve os centavos).
      function prefillAmounts() {
        const split = currentSplit();
        for (let i = 0; i < split.result.length; i++) {
          const rowEl = rowsEl?.children[i];
          if (!rowEl) continue;
          const fixed = !!rowEl.querySelector('.cb-person-fixed')?.checked;
          const amountInput = rowEl.querySelector('.cb-person-amount');
          if (!fixed && amountInput) amountInput.value = (split.result[i].amount || 0).toFixed(2);
        }
      }

      splitCheck?.addEventListener('change', toggleSplitSection);
      payMethodSelect?.addEventListener('change', toggleCashSection);
      cashReceivedInput?.addEventListener('input', updateCashChange);
      modal.querySelectorAll('[data-close-cancel]').forEach((el) => el.addEventListener('click', () => done(null)));
      modal.addEventListener('click', (e) => { if (e.target === modal) done(null); });
      modal.querySelector('[data-close-print]')?.addEventListener('click', () => {
        const split = splitCheck?.checked ? currentSplit() : { amountToCollect: total, tip: 0, diff: 0, result: [] };
        storefrontPrintBill(label, comandas, split);
      });
      countInput?.addEventListener('input', () => { renderPeopleRows(); updateSplitBalance(); prefillAmounts(); });
      tipInput?.addEventListener('input', () => { updateSplitBalance(); prefillAmounts(); });
      modal.querySelector('[data-close-ok]')?.addEventListener('click', async () => {
        const btn = modal.querySelector('[data-close-ok]');
        setCbMsg('', false);
        const payReceived = !!(modal.querySelector('#sfClosePayReceived') || {}).checked;
        if (!payReceived) {
          setCbMsg('Confirme que o pagamento foi recebido antes de fechar a mesa.', true);
          return;
        }
        const isDinheiro = (payMethodSelect?.value || '') === 'Dinheiro';
        if (isDinheiro) {
          const received = billRound(cashReceivedInput?.value);
          if (received < total) {
            setCbMsg(`Valor recebido (${billMoney(received)}) é menor que o total (${billMoney(total)}).`, true);
            return;
          }
        }
        const doSplit = !!splitCheck?.checked;
        let split;
        if (doSplit) {
          try {
            split = currentSplit();
          } catch (err) {
            console.error('[closeTable] split', err);
            setCbMsg(err?.message || 'Não foi possível calcular a divisão.', true);
            return;
          }
          if (split.diff !== 0) {
            setCbMsg('Os valores das pessoas não batem com o total. Ajuste a divisão.', true);
            return;
          }
        } else {
          split = { amountToCollect: total, tip: 0, diff: 0, result: [] };
        }
        const payMethod = (modal.querySelector('#sfClosePayMethod') || {}).value || 'Dinheiro';
        btn.disabled = true;
        btn.textContent = 'Fechando…';
        setCbMsg('Fechando mesa...', false);
        try {
          const res = await fetch(`${API_BASE}/api/v1/admin/tables/${encodeURIComponent(tableId)}/close`, {
            method: 'POST',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ paymentMethod: payMethod })
          });
          const data = await res.json().catch(() => null);
          if (!res.ok) {
            if (res.status === 409 || res.status === 404) {
              // Mesa já fechada/inexistente — reflete o estado real.
              showStorefrontToast((data && data.error) || 'A mesa não tem mais comandas abertas.');
              if (typeof loadMesasMap === 'function') loadMesasMap();
              done(null);
              return;
            }
            throw new Error((data && data.error) || `Erro ao fechar a mesa (HTTP ${res.status}).`);
          }
          setCbMsg('Fechamento confirmado.', false);
          done({ closed: true, split, closedOrders: data && data.closedOrders });
        } catch (e) {
          console.error('[closeTable] close request', e);
          btn.disabled = false;
          btn.textContent = 'Confirmar fechamento';
          setCbMsg(e.message || 'Erro ao fechar a mesa.', true);
          showStorefrontToast(e.message || 'Erro ao fechar a mesa.');
        }
      });

      toggleCashSection();
      document.addEventListener('keydown', onKey);
      payMethodSelect?.focus();
    });

    if (result && result.closed) {
      showStorefrontToast(`Mesa ${label} fechada — ${result.closedOrders ?? comandas.length} comanda(s) finalizada(s).`);
      await showStorefrontCloseReceipt(tableId, label, comandas, result.split);
    }
    if (typeof loadMesasMap === 'function') loadMesasMap();
  }

  function closeMesasGate() {
    stopMesasLive();
    const gate = document.getElementById('mesasGate');
    if (gate) gate.hidden = true;
    document.body.classList.remove('mesas-open');
  }

  // Determina se estamos num host local/LAN (acessível pelo celular na rede).
  function isLocalOrLanHost() {
    const host = location.hostname || 'localhost';
    if (host === 'localhost' || host === '127.0.0.1') return true;
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a === 10) return true;
      if (a === 192 && b === 168) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
    }
    if (host.indexOf('.') === -1) return true;
    if (/\.local$/i.test(host)) return true;
    return false;
  }

  // URL do cardápio digital desta loja (o storefront é o próprio cardápio).
  // Mesma resolução do admin: override STORE_FRONT_URL → LAN fixa
  // http://192.168.15.7:8080/ → domínio público (Vercel).
  function storefrontDigitalMenuQrUrl() {
    const override = window.STORE_FRONT_URL;
    if (override) return `${String(override).replace(/\/$/, '')}/`;
    if (isLocalOrLanHost()) return 'http://192.168.15.7:8080/';
    return 'https://delivery-fabin.vercel.app/';
  }

  // Entra num canal de atendimento a partir da tela de canais (/login).
  // Delivery (tela gar��om): mostra o QR Code do card��pio digital da loja
  // (mesmo componente do painel administrativo) — o cliente escaneia e faz o
  // pr��prio pedido.
  function enterDeliveryQrGate() {
    DeliveryQrModal.show({
      url: storefrontDigitalMenuQrUrl(),
      toast: showStorefrontToast
    });
  }

  function enterStaffChannel(source) {
    if (source === 'delivery') {
      enterDeliveryQrGate();
      return;
    }
    if (source === 'mesas') {
      showMesasGate('map');
      return;
    }
    if (source !== 'balcao' && source !== 'delivery' && source !== 'telefone') return;
    const staffToken = mesasAuthToken || waiterToken;
    if (!staffToken) return;
    const payload = decodeJwtPayload(staffToken);
    const name = readWaiterNameFromToken(staffToken) || payload?.unique_name || payload?.username || waiterName || 'Atendente';
    waiterToken = staffToken;
    waiterName = name;
    staffSource = source;
    fulfillmentMode = source === 'balcao' ? 'pickup' : 'delivery';
    deliveryDistanceKm = null;
    if (source === 'balcao') {
      deliveryOk = true;
      bairroNome = 'Retirada';
      bairroValor = 0;
      enderecoBase = storePickupAddress();
    } else {
      deliveryOk = false;
      bairroNome = '';
      bairroValor = 0;
      enderecoBase = '';
    }
    try {
      sessionStorage.setItem(STAFF_SESSION_KEY, JSON.stringify({
        token: staffToken,
        source,
        name,
        ...(fulfillmentMode && source === 'telefone' ? { fulfillment: fulfillmentMode } : {})
      }));
    } catch (_) { /* storage indisponível */ }
    closeMesasGate();
    // Limpa path /login, mantendo só query/hash se houver.
    let path = window.location.pathname;
    if (isLoginPath(path)) path = '/';
    const params = new URLSearchParams(window.location.search);
    const next = `${path}${params.toString() ? `?${params}` : ''}${window.location.hash || ''}`;
    window.history.replaceState({}, '', next);
    updateUI();
  }

  function mesasLogout() {
    stopMesasLive();
    mesasAuthToken = null;
    mesasUserName = null;
    waiterName = null;
    waiterToken = null;
    staffSource = null;
    dineInTable = null;
    fulfillmentMode = 'delivery';
    try { sessionStorage.removeItem(WAITER_SESSION_KEY); } catch (_) { /* storage indisponível */ }
    updateMesasHeader();
    const login = document.getElementById('mesasLoginScreen');
    const channels = document.getElementById('mesasChannelsScreen');
    const map = document.getElementById('mesasMapScreen');
    if (login) login.hidden = false;
    if (channels) channels.hidden = true;
    if (map) map.hidden = true;
    showMesasGate('login');
  }

  function updateMesasHeader() {
    const el = document.getElementById('mesasHeaderActions');
    if (!el) return;
    el.hidden = !(mesasAuthToken || waiterToken);
  }

  function bindMesasEvents() {
    const loginBtn = document.getElementById('mesasLoginBtn');
    if (loginBtn) loginBtn.addEventListener('click', mesasLogin);
    const cancelBtn = document.getElementById('mesasCancelBtn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        closeMesasGate();
        if (isLoginPath(window.location.pathname)) window.location.assign('/');
      });
    }
    const headerLogoutBtn = document.getElementById('mesasHeaderLogoutBtn');
    if (headerLogoutBtn) headerLogoutBtn.addEventListener('click', () => {
      mesasLogout();
      // Sair do atendimento: limpa a sessão e volta à tela de login do garçom
      // (/login). O gate detecta o path e reexibe a tela de login de atendimento.
      if (isLoginRequested()) return;
      window.location.assign('/login');
    });
    const headerViewBtn = document.getElementById('mesasHeaderViewBtn');
    if (headerViewBtn) headerViewBtn.addEventListener('click', () => {
      if (!(mesasAuthToken || waiterToken)) return;
      // Olho: reabre a tela de canais (aquela exibida após o garçom logar)
      // para escolher o tipo de pedido do próximo atendimento.
      showMesasGate('channels');
    });
    const passInput = document.getElementById('mesasLoginPass');
    if (passInput) passInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') mesasLogin(); });
    const userInput = document.getElementById('mesasLoginUser');
    if (userInput) userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') mesasLogin(); });
    const channelBtns = document.querySelectorAll('[data-staff-channel]');
    channelBtns.forEach((btn) => {
      btn.addEventListener('click', () => enterStaffChannel(btn.dataset.staffChannel));
    });
    const channelsLogoutBtn = document.getElementById('mesasChannelsLogoutBtn');
    if (channelsLogoutBtn) channelsLogoutBtn.addEventListener('click', mesasLogout);
  }

  function escapeAttr(v) {
    return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function setFieldError(errorId, inputId, message) {
    const err = document.getElementById(errorId);
    const input = inputId ? document.getElementById(inputId) : null;
    if (err) {
      err.textContent = message || '';
      err.hidden = !message;
    }
    if (input) input.classList.toggle('is-invalid', !!message);
  }

  function clearAddressLookupErrors() {
    setFieldError('cepFieldError', 'cepInput', '');
    setFieldError('streetSearchError', 'streetSearchNumber', '');
    document.getElementById('streetSearchQuery')?.classList.remove('is-invalid');
  }

  function scheduleOrderTrackPoll() {
    if (orderTrackPollTimer) clearInterval(orderTrackPollTimer);
    orderTrackPollTimer = setInterval(() => {
      refreshOrderTracking().catch(() => {});
    }, ORDER_TRACK_POLL_MS);
  }

  function stopOrderTrackSse() {
    if (orderTrackSseAbort) {
      orderTrackSseAbort.abort();
      orderTrackSseAbort = null;
    }
    orderTrackSseConnected = false;
  }

  /** SSE do rastreio (por pedido). Com conexão ativa, o poll fica desligado. */
  async function connectOrderTrackSse(creds) {
    if (orderTrackSseAbort) return;
    if (!creds?.orderId || !creds?.accessToken) return;
    const ctrl = new AbortController();
    orderTrackSseAbort = ctrl;
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/orders/${encodeURIComponent(creds.orderId)}/stream?accessToken=${encodeURIComponent(creds.accessToken)}`,
        {
          cache: 'no-store',
          headers: { Accept: 'text/event-stream' },
          signal: ctrl.signal
        }
      );
      if (!res.ok || !res.body) {
        throw new Error(`SSE ${res.status}`);
      }
      orderTrackSseConnected = true;
      // SSE ativo: poll desligado (economia de requests)
      if (orderTrackPollTimer) {
        clearInterval(orderTrackPollTimer);
        orderTrackPollTimer = null;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (!ctrl.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const chunk of parts) {
          if (!chunk.includes('event: orders')) continue;
          const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
          const data = dataLine ? dataLine.slice(5).trim() : '';
          if (data === 'ping') continue;
          // Status/itens mudaram (ou terminal): refaz a busca única — reusa
          // notificações, stepper, itens alterados e encerramento do tracking.
          refreshOrderTracking().catch(() => {});
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      orderTrackSseConnected = false;
      console.warn('SSE rastreio indisponível — mantendo poll', err);
      if (hasTrackCredentials() && !orderTrackPollTimer) {
        scheduleOrderTrackPoll();
      }
    } finally {
      if (orderTrackSseAbort === ctrl) {
        orderTrackSseAbort = null;
        orderTrackSseConnected = false;
        // Sem SSE (fim da stream/falha): poll de segurança se ainda houver pedido
        if (hasTrackCredentials() && !orderTrackPollTimer) {
          scheduleOrderTrackPoll();
        }
      }
    }
  }

  async function startOrderTracking() {
    const creds = readTrackCredentials();
    if (!creds) return false;

    saveTrackCredentials(creds.orderId, creds.accessToken);
    ensureTrackFabVisible();

    const active = await refreshOrderTracking();
    if (!active) return false;

    connectOrderTrackSse(creds).catch(() => {});
    return true;
  }

  let orderTrackResumeTimer = null;

  /** Após WhatsApp/PWA, timers do browser costumam congelar — reabre SSE e busca status fresco. */
  function onOrderTrackVisibilityResume() {
    if (waiterToken || staffSource) return;
    if (!hasTrackCredentials()) return;
    ensureTrackFabVisible();
    stopOrderTrackSse();
    connectOrderTrackSse(readTrackCredentials()).catch(() => {});
    if (orderTrackResumeTimer) clearTimeout(orderTrackResumeTimer);
    orderTrackResumeTimer = setTimeout(() => {
      orderTrackResumeTimer = null;
      refreshOrderTracking().catch(() => {});
    }, 120);
  }

  function openOrderTrackModal({ skipRefresh, skipNotifyPermission } = {}) {
    syncVisualViewportHeight();
    const modal = document.getElementById('orderTrackModal');
    if (modal) {
      modal.style.display = 'flex';
      attachModalCloseHandlers(modal);
      const body = modal.querySelector('.ot-modal-body');
      if (body) body.scrollTop = 0;
    }
    if (orderTrackCurrent) {
      renderOrderTrackDetails(orderTrackCurrent);
    }
    // Abrir modal nunca esconde o botão do cardápio
    ensureTrackFabVisible();
    if (!skipRefresh) {
      // Sempre busca status atual (evita UI velha se o poll estava pausado em background)
      refreshOrderTracking()
        .then(() => {
          if (orderTrackCurrent && isOrderTrackModalOpen()) {
            renderOrderTrackDetails(orderTrackCurrent);
          }
          ensureTrackFabVisible();
        })
        .catch(() => ensureTrackFabVisible());
    }
    // Pedido de permissão só após gesto do usuário (não no auto-open por itens)
    if (!skipNotifyPermission) {
      ensureCustomerNotifyPermission().catch(() => {});
    }
  }

  function cancelScheduledOrderWhatsApp() {
    if (orderWhatsAppTimer) {
      clearTimeout(orderWhatsAppTimer);
      orderWhatsAppTimer = null;
    }
  }

  /** Abre o WhatsApp só após o atraso — a tela de status fica visível neste intervalo. */
  function scheduleOrderWhatsApp(message, delayMs = 3000) {
    if (orderWhatsAppTimer) {
      clearTimeout(orderWhatsAppTimer);
      orderWhatsAppTimer = null;
    }
    const text = String(message || '').trim();
    if (!text || !cfg?.whatsapp) return;
    const link = `https://api.whatsapp.com/send?phone=${cfg.whatsapp}&text=${encodeURIComponent(text)}`;
    orderWhatsAppTimer = setTimeout(() => {
      orderWhatsAppTimer = null;
      window.open(link, '_blank', 'noopener,noreferrer');
    }, delayMs);
  }

  async function confirmOrderReceived() {
    const creds = readTrackCredentials();
    if (!creds?.orderId || !creds?.accessToken) return;
    const confirmBtn = document.getElementById('orderTrackConfirmBtn');
    if (confirmBtn) confirmBtn.disabled = true;
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/orders/${encodeURIComponent(creds.orderId)}/confirm-received?accessToken=${encodeURIComponent(creds.accessToken)}`,
        { method: 'POST' }
      );
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        alert(body.error || 'Aguarde o pedido sair para entrega.');
        await refreshOrderTracking();
        return;
      }
      if (!res.ok) {
        alert('Não foi possível confirmar o recebimento. Tente novamente.');
        return;
      }
      // A confirmação finaliza o pedido (Delivered) — refresh reflete o status atualizado
      await refreshOrderTracking();
      alert(isDineInTrackOrder(orderTrackCurrent) ? 'Obrigado! Pedido entregue na mesa.' : 'Obrigado! Recebimento confirmado.');
    } catch (_) {
      alert('Não foi possível confirmar o recebimento. Verifique a conexão.');
    } finally {
      if (confirmBtn) {
        const st = orderTrackCurrent?.status;
        const pickup = isPickupTrackOrder(orderTrackCurrent);
        const dineIn = isDineInTrackOrder(orderTrackCurrent);
        let canConfirm = false;
        if (pickup) canConfirm = st === 'ReadyForPickup' && !orderTrackCurrent?.customerReceived;
        else if (dineIn) canConfirm = st === 'ReadyForTable' && !orderTrackCurrent?.customerReceived;
        else canConfirm = st === 'OutForDelivery' && !orderTrackCurrent?.customerReceived;
        if (canConfirm) confirmBtn.disabled = false;
      }
    }
  }

  function snapshotCartItems() {
    return cart.map((item) => ({
      id: item.id || null,
      name: item.name,
      price: Number(item.price) || 0,
      quantity: Number(item.quantity) || 0,
      option: item.option || null,
      note: item.note ? String(item.note).slice(0, 120) : '',
      removed: item.removed || [],
      mods: item.mods || []
    }));
  }

  function catalogItemMap() {
    const map = new Map();
    if (!cfg || !Array.isArray(cfg.menu)) return map;
    cfg.menu.forEach((cat) => {
      (cat.items || []).forEach((item) => {
        if (item && item.name) map.set(item.name, item);
      });
    });
    return map;
  }

  function applyCatalogPrices(items) {
    const catalog = catalogItemMap();
    return items
      .map((item) => {
        const found = catalog.get(item.name);
        if (!found) return null;
        const optionPrices = {
          'Média': found.priceMedia,
          Inteira: found.priceInteira
        };
        return {
          ...item,
          id: found.id || item.id || null,
          price: resolveOptionUnitPrice(found.price, optionPrices, item.option || null)
            + (item.mods || []).reduce((sum, m) => sum + (Number(m.priceDelta) || 0), 0)
        };
      })
      .filter(Boolean);
  }

  function syncCartWithCatalog() {
    cart = applyCatalogPrices(cart);
    saveCart();
  }

  function formatLastOrderSummary(items) {
    return items
      .map((item) => {
        const label = item.option ? `${item.name} (${item.option})` : item.name;
        return `${item.quantity}× ${label}`;
      })
      .join('\n');
  }

  function markRepeatAsked(orderId) {
    try {
      sessionStorage.setItem(REPEAT_ASKED_KEY, orderId || '1');
    } catch (_) { /* ignore */ }
  }

  function wasRepeatAsked(orderId) {
    try {
      const asked = sessionStorage.getItem(REPEAT_ASKED_KEY);
      if (!asked) return false;
      if (orderId) return asked === orderId;
      return true;
    } catch (_) {
      return false;
    }
  }

  function ensureRepeatOrderModal() {
    let modal = document.getElementById('repeatOrderModal');
    if (modal) return modal;

    modal = document.createElement('div');
    modal.id = 'repeatOrderModal';
    modal.className = 'modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'repeatOrderTitle');
    modal.innerHTML =
      `<div class="modal-content option-modal-content">` +
      `<button class="close-button" type="button" data-close-modal="repeatOrderModal" aria-label="Fechar">Fechar</button>` +
      `<h2 id="repeatOrderTitle">Último pedido</h2>` +
      `<p class="option-question">Encontramos itens do seu último pedido neste aparelho.</p>` +
      `<p id="repeatOrderSummary" class="repeat-order-summary" hidden></p>` +
      `<div class="option-choices drink-upsell-actions">` +
      `<button type="button" id="repeatOrderYesBtn" class="option-choice-btn">Repetir meu último pedido!</button>` +
      `<button type="button" id="repeatOrderNoBtn" class="option-choice-btn option-choice-secondary">Fazer novo pedido!</button>` +
      `</div></div>`;
    document.body.appendChild(modal);

    modal.querySelector('#repeatOrderYesBtn')?.addEventListener('click', acceptRepeatLastOrder);
    modal.querySelector('#repeatOrderNoBtn')?.addEventListener('click', declineRepeatLastOrder);
    modal.querySelector('[data-close-modal="repeatOrderModal"]')?.addEventListener('click', () => {
      declineRepeatLastOrder();
    });
    return modal;
  }

  function maybePromptRepeatLastOrder() {
    // Sessão de equipe (Balcão/garçom/atendimento): não oferece "Repetir" no cardápio.
    if (waiterToken || staffSource) return;
    const last = loadLastOrder();
    if (!last) return;
    if (wasRepeatAsked(last.orderId || '1')) return;
    // Não perguntar enquanto houver pedido em andamento neste aparelho
    if (hasTrackCredentials()) return;

    const modal = ensureRepeatOrderModal();
    const summary = document.getElementById('repeatOrderSummary');
    if (summary) {
      summary.textContent = formatLastOrderSummary(last.items);
      summary.hidden = !summary.textContent;
    }

    const yesBtn = document.getElementById('repeatOrderYesBtn');
    const noBtn = document.getElementById('repeatOrderNoBtn');
    if (yesBtn) yesBtn.textContent = 'Repetir meu último pedido!';
    if (noBtn) noBtn.textContent = 'Fazer novo pedido!';

    modal.style.display = 'flex';
    attachModalCloseHandlers(modal);
  }

  function acceptRepeatLastOrder() {
    const last = loadLastOrder();
    markRepeatAsked(last?.orderId || '1');
    closeModal('repeatOrderModal');
    if (!last) return;

    cart = applyCatalogPrices(last.items);
    saveCart();
    renderMenu();
    updateUI();
    showCartModal();
  }

  function declineRepeatLastOrder() {
    const last = loadLastOrder();
    markRepeatAsked(last?.orderId || '1');
    closeModal('repeatOrderModal');
  }

  function isRunningAsInstalledApp() {
    return window.matchMedia('(display-mode: standalone)').matches
      || window.navigator.standalone === true;
  }

  function getStoreDisplayName() {
    const fromCfg = String(cfg?.storeName || '').trim();
    if (fromCfg) return fromCfg;
    const fromHeader = String(document.querySelector('.barra__topo__md h3')?.textContent || '').trim();
    return fromHeader || 'Fabin Lanches';
  }

  const DYNAMIC_MANIFEST_CACHE = 'fabin-store-manifest';
  let installPromptArmed = false;

  function armInstallPromptCapture() {
    if (installPromptArmed) return;
    installPromptArmed = true;
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredInstallPrompt = e;
    });
  }

  const DEFAULT_STORE_ICON_DATA_URI =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8D%94%3C/text%3E%3C/svg%3E";
  const DEFAULT_STORE_ICON_192 = 'assets/icons/icon-192.png';
  const DEFAULT_STORE_ICON_512 = 'assets/icons/icon-512.png';

  function resolveStoreIconUrl() {
    const raw = String(cfg?.iconUrl || '').trim();
    if (raw) {
      if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
      return `${API_BASE}${raw.startsWith('/') ? raw : `/${raw}`}`;
    }
    return DEFAULT_STORE_ICON_DATA_URI;
  }

  function resolveAssetUrl(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
    return `${API_BASE}${raw.startsWith('/') ? raw : `/${raw}`}`;
  }

  function applyStoreIcons() {
    const url = resolveStoreIconUrl();
    const isSvgData = url.startsWith('data:image/svg+xml');
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = isSvgData ? 'image/svg+xml' : 'image/png';
    if (!isSvgData) link.sizes = '192x192';
    else link.removeAttribute('sizes');
    link.href = url;

    let apple = document.querySelector('link[rel="apple-touch-icon"]');
    if (!apple) {
      apple = document.createElement('link');
      apple.rel = 'apple-touch-icon';
      document.head.appendChild(apple);
    }
    // Atalhos móveis precisam de PNG; SVG fica só como favicon do navegador.
    apple.href = (cfg?.iconUrl)
      ? url
      : new URL(DEFAULT_STORE_ICON_192, window.location.href).href;
  }

  async function updatePwaManifestFromStore() {
    const name = getStoreDisplayName();
    // Android usa short_name no atalho — deve ser o mesmo nome da loja
    const shortName = name;
    const pageUrl = window.location.href;
    const startUrl = new URL('./', pageUrl).href;
    const customIcon = String(cfg?.iconUrl || '').trim();
    const iconUrl = customIcon ? resolveStoreIconUrl() : null;
    const manifestUrl = new URL('manifest.webmanifest', pageUrl).href;

    const icons = customIcon
      ? [
          { src: iconUrl, sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: iconUrl, sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: iconUrl, sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      : [
          {
            src: new URL(DEFAULT_STORE_ICON_192, pageUrl).href,
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: new URL(DEFAULT_STORE_ICON_512, pageUrl).href,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable'
          }
        ];

    // App instalado abre a página da própria loja: /{slug} (servida pelo servidor) ou o
    // storefront com ?tenant= (sem isso, "./" levava a /storefront/ = loja padrão).
    const tenantQuery = new URLSearchParams(window.location.search).get('tenant');
    const storeStartUrl = window.location.pathname.startsWith('/storefront/')
      ? `${window.location.pathname}${tenantQuery ? `?tenant=${encodeURIComponent(tenantQuery)}` : ''}`
      : window.location.pathname;
    const manifest = {
      id: new URL(storeStartUrl, window.location.origin).href || startUrl,
      name,
      short_name: shortName,
      description: `Cardápio delivery — ${name}`,
      start_url: storeStartUrl,
      scope: '/',
      display: 'standalone',
      orientation: 'portrait-primary',
      background_color: '#f3f4f6',
      theme_color: '#1f6feb',
      lang: 'pt-BR',
      icons
    };

    const response = new Response(JSON.stringify(manifest), {
      headers: {
        'Content-Type': 'application/manifest+json',
        'Cache-Control': 'no-cache'
      }
    });

    try {
      const cache = await caches.open(DYNAMIC_MANIFEST_CACHE);
      await cache.put('current', response.clone());
      await cache.put(manifestUrl, response.clone());
      await cache.put(new URL('manifest.json', pageUrl).href, response.clone());
    } catch (_) { /* ignore */ }

    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.getRegistration('./');
        if (reg) await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 1500))]);
      } catch (_) { /* ignore */ }
    }


    let link = document.querySelector('link[rel="manifest"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'manifest';
      document.head.appendChild(link);
    }
    // Mesma origem: o SW devolve o manifesto com o nome da loja
    link.href = `manifest.json?n=${encodeURIComponent(name)}&t=${Date.now()}`;

    const apple = document.querySelector('meta[name="apple-mobile-web-app-title"]');
    if (apple) apple.content = name;

    const btn = document.getElementById('installAppYesBtn');
    if (btn) {
      btn.textContent = `Adicionar ${name} à área de trabalho para acesso rápido!`;
    }
  }

  function getInstallInstructions() {
    const name = getStoreDisplayName();
    const ua = navigator.userAgent || '';
    const isIOS = /iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
      return `1) Toque em Compartilhar\n2) Escolha “Adicionar à Tela de Início”\n3) Confirme. O atalho aparece como “${name}”.`;
    }
    if (/Android/i.test(ua)) {
      return `Para criar o atalho “${name}”:\n1) Menu ⋮ do Chrome\n2) “Instalar app” ou “Adicionar à tela inicial”\n3) Confirme\n\nDepois procure “${name}” na tela inicial ou na gaveta de apps.`;
    }
    return `Use o ícone de instalação na barra de endereço, ou o menu do navegador → “Instalar ${name}”. O atalho se chama “${name}”.`;
  }

  function hideInstallAppBar() {
    const bar = document.getElementById('installAppBar');
    if (!bar || bar.hidden) return;
    if (installBarHideTimer) {
      clearTimeout(installBarHideTimer);
      installBarHideTimer = null;
    }
    const tip = document.getElementById('installAppTip');
    if (tip) {
      tip.hidden = true;
      tip.textContent = '';
    }
    bar.classList.add('is-hiding');
    setTimeout(() => {
      bar.hidden = true;
      bar.classList.remove('is-hiding');
      document.body.classList.remove('install-bar-visible');
    }, 320);
  }

  function showInstallAppBar() {
    if (isRunningAsInstalledApp()) return;
    if (document.body.classList.contains('store-is-inactive')) return;

    const bar = document.getElementById('installAppBar');
    if (!bar) return;

    const tip = document.getElementById('installAppTip');
    if (tip) {
      tip.hidden = true;
      tip.textContent = '';
    }

    const name = getStoreDisplayName();
    const btn = document.getElementById('installAppYesBtn');
    if (btn) {
      btn.textContent = `Adicionar ${name} à área de trabalho para acesso rápido!`;
    }

    bar.hidden = false;
    bar.classList.remove('is-hiding');
    document.body.classList.add('install-bar-visible');

    if (installBarHideTimer) clearTimeout(installBarHideTimer);
    installBarHideTimer = setTimeout(hideInstallAppBar, INSTALL_BAR_VISIBLE_MS);
  }

  function showInstallTipInBar() {
    const tip = document.getElementById('installAppTip');
    if (!tip) {
      alert(getInstallInstructions());
      return;
    }
    tip.textContent = getInstallInstructions();
    tip.hidden = false;
    if (installBarHideTimer) clearTimeout(installBarHideTimer);
    installBarHideTimer = setTimeout(hideInstallAppBar, 20_000);
  }

  async function acceptInstallApp() {
    const promptEvent = deferredInstallPrompt;
    if (promptEvent) {
      deferredInstallPrompt = null;
      try {
        promptEvent.prompt();
        const choice = await promptEvent.userChoice;
        if (choice && choice.outcome === 'accepted') {
          hideInstallAppBar();
          return;
        }
      } catch (_) { /* ignore */ }
    }

    showInstallTipInBar();
  }

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    hideInstallAppBar();
  });

  function collectCheckoutForm() {
    return {
      selectedCustomerAddressId,
      nome: document.getElementById('clienteNome')?.value || '',
      telefone: document.getElementById('clienteTelefone')?.value || '',
      formaPagamento: document.getElementById('formaPagamento')?.value || '',
      pixTiming: getPixTiming(),
      precisaTroco: !!document.getElementById('precisaTroco')?.checked,
      troco: document.getElementById('trocoInput')?.value || '',
      observacoes: document.getElementById('observacoesInput')?.value || '',
      // legado (migração única para o caderno do cliente)
      cep: document.getElementById('cepInput')?.value || '',
      numero: document.getElementById('numeroInput')?.value || '',
      referencia: document.getElementById('pontoReferenciaInput')?.value || ''
    };
  }

  function saveCheckoutForm() {
    try {
      localStorage.setItem(CHECKOUT_STORAGE_KEY, JSON.stringify(collectCheckoutForm()));
    } catch (_) { /* ignore */ }
  }

  const saveCheckoutFormDebounced = debounce(saveCheckoutForm, 250);

  function loadCustomerAddressBook() {
    try {
      const raw = localStorage.getItem(CUSTOMER_ADDRESSES_KEY);
      if (!raw) return { defaultId: null, items: [] };
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      return {
        defaultId: parsed?.defaultId || null,
        items: items.filter((a) => a && a.id && a.cep)
      };
    } catch (_) {
      return { defaultId: null, items: [] };
    }
  }

  function saveCustomerAddressBook(book) {
    try {
      localStorage.setItem(CUSTOMER_ADDRESSES_KEY, JSON.stringify({
        defaultId: book.defaultId || null,
        items: Array.isArray(book.items) ? book.items : []
      }));
    } catch (_) { /* ignore */ }
  }

  function newCustomerAddressId() {
    return `addr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  function residenceTypeLabel(type) {
    return ({ casa: 'Casa', condominio: 'Condomínio', apartamento: 'Apartamento' })[type] || 'Endereço';
  }

  function getResidenceType() {
    return document.querySelector('input[name="residenceType"]:checked')?.value || 'casa';
  }

  function setResidenceType(type) {
    const value = ['casa', 'condominio', 'apartamento'].includes(type) ? type : 'casa';
    document.querySelectorAll('input[name="residenceType"]').forEach((radio) => {
      radio.checked = radio.value === value;
    });
    syncResidenceFields();
  }

  function syncResidenceFields() {
    const type = getResidenceType();
    document.querySelectorAll('[data-residence]').forEach((el) => {
      el.hidden = el.dataset.residence !== type;
    });
  }

  function setCepLookupMode(mode) {
    const useStreet = mode === 'street';
    const cepBox = document.getElementById('cepModeCep');
    const streetBox = document.getElementById('cepModeStreet');
    if (cepBox) cepBox.hidden = useStreet;
    if (streetBox) streetBox.hidden = !useStreet;
    document.querySelectorAll('.cep-mode-tab').forEach((btn) => {
      const active = btn.dataset.cepMode === (useStreet ? 'street' : 'cep');
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (useStreet) {
      applyStoreServiceAreaToStreetSearch({ force: true });
    } else if (!resolvedViaCep) {
      // Saiu da busca por rua sem escolher CEP — limpa o aviso/lista
      const pending = document.getElementById('streetSearchResults')?.querySelector('.street-result-btn');
      if (pending) clearStreetCepPickUi();
    }
  }

  function getSelectedCustomerAddress() {
    if (!selectedCustomerAddressId) return null;
    return loadCustomerAddressBook().items.find((a) => a.id === selectedCustomerAddressId) || null;
  }

  function buildCustomerDeliveryLines(addr) {
    if (!addr) {
      return { address: '', reference: '', neighborhood: '', cep: '', number: '', city: '', state: '', street: '' };
    }
    const street = String(addr.street || '').trim();
    const number = String(addr.number || '').trim();
    const neighborhood = String(addr.neighborhood || '').trim();
    const city = String(addr.city || '').trim();
    const state = String(addr.state || '').trim();
    const baseParts = [
      street && number ? `${street}, ${number}` : (street || number),
      neighborhood,
      city && state ? `${city} - ${state}` : (city || state)
    ].filter(Boolean);
    const bits = [];
    const type = addr.residenceType || 'casa';
    if (type === 'casa') {
      if (addr.complement) bits.push(String(addr.complement));
    } else if (type === 'condominio') {
      if (addr.condoName) bits.push(`Cond.: ${addr.condoName}`);
      if (addr.blockLot) bits.push(`Qd/Lt: ${addr.blockLot}`);
      if (addr.deliveryNotes) bits.push(String(addr.deliveryNotes));
    } else if (type === 'apartamento') {
      if (addr.tower) bits.push(`Bloco/Torre ${addr.tower}`);
      if (addr.apartment) bits.push(`Apto ${addr.apartment}`);
      if (addr.floor) bits.push(`Andar ${addr.floor}`);
      if (addr.deliveryNotes) bits.push(String(addr.deliveryNotes));
    }
    return {
      address: baseParts.join(', '),
      reference: bits.join(' · '),
      neighborhood,
      cep: onlyDigits(addr.cep),
      number: onlyDigits(number),
      city,
      state,
      street
    };
  }

  function summarizeCustomerAddress(addr) {
    const lines = buildCustomerDeliveryLines(addr);
    const label = String(addr.label || '').trim() || residenceTypeLabel(addr.residenceType);
    return {
      title: label,
      subtitle: lines.address || 'Endereço incompleto',
      meta: lines.reference || `${residenceTypeLabel(addr.residenceType)} · CEP ${maskCep(addr.cep || '')}`
    };
  }

  /** Cidade/UF do estabelecimento — padrão da busca de CEP do cliente. */
  function getStoreServiceArea() {
    let state = String(cfg?.state || '').trim().toUpperCase();
    let city = String(cfg?.city || '').trim();
    if ((!state || !city) && cfg?.address) {
      const m = String(cfg.address).match(/,\s*([^,]+)\s*-\s*([A-Za-z]{2})\s*$/);
      if (m) {
        if (!city) city = m[1].trim();
        if (!state) state = m[2].trim().toUpperCase();
      }
    }
    if (!state) state = 'SP';
    if (!city) city = 'Ribeirão Preto';
    return { state: state.slice(0, 2), city };
  }

  function applyStoreServiceAreaToStreetSearch({ force } = {}) {
    const area = getStoreServiceArea();
    const uf = document.getElementById('streetSearchUf');
    const city = document.getElementById('streetSearchCity');
    if (uf && (force || !String(uf.value || '').trim())) uf.value = area.state;
    if (city && (force || !String(city.value || '').trim())) city.value = area.city;
  }

  function clearAddressFormFields() {
    editingCustomerAddressId = null;
    resolvedViaCep = null;
    ['addressLabel', 'numeroInput', 'pontoReferenciaInput', 'condoNumber', 'condoName',
      'condoBlockLot', 'condoNotes', 'aptBuilding', 'aptTower', 'aptNumber', 'aptFloor', 'aptNotes',
      'streetSearchQuery', 'streetSearchNumber'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    const cepInput = document.getElementById('cepInput');
    if (cepInput) cepInput.value = '';
    applyStoreServiceAreaToStreetSearch({ force: true });
    const def = document.getElementById('addressIsDefault');
    if (def) def.checked = loadCustomerAddressBook().items.length === 0;
    clearStreetCepPickUi();
    setResidenceType('casa');
    setCepLookupMode('cep');
    const info = document.getElementById('enderecoInfo');
    if (info) {
      info.style.display = 'none';
      info.textContent = '';
    }
  }

  function fillAddressForm(addr) {
    if (!addr) {
      clearAddressFormFields();
      return;
    }
    editingCustomerAddressId = addr.id;
    setResidenceType(addr.residenceType || 'casa');
    setCepLookupMode('cep');
    const label = document.getElementById('addressLabel');
    if (label) label.value = addr.label || '';
    const cepInput = document.getElementById('cepInput');
    if (cepInput) cepInput.value = maskCep(addr.cep || '');
    const def = document.getElementById('addressIsDefault');
    if (def) def.checked = !!addr.isDefault;

    const numero = document.getElementById('numeroInput');
    if (numero) numero.value = onlyDigits(addr.number || '');
    const streetNum = document.getElementById('streetSearchNumber');
    if (streetNum) streetNum.value = onlyDigits(addr.number || '');
    const ref = document.getElementById('pontoReferenciaInput');
    if (ref) ref.value = addr.complement || '';

    const condoNumber = document.getElementById('condoNumber');
    if (condoNumber) condoNumber.value = onlyDigits(addr.number || '');
    const condoName = document.getElementById('condoName');
    if (condoName) condoName.value = addr.condoName || '';
    const condoBlockLot = document.getElementById('condoBlockLot');
    if (condoBlockLot) condoBlockLot.value = addr.blockLot || '';
    const condoNotes = document.getElementById('condoNotes');
    if (condoNotes) condoNotes.value = addr.deliveryNotes || '';

    const aptBuilding = document.getElementById('aptBuilding');
    if (aptBuilding) aptBuilding.value = onlyDigits(addr.number || addr.buildingNumber || '');
    const aptTower = document.getElementById('aptTower');
    if (aptTower) aptTower.value = addr.tower || '';
    const aptNumber = document.getElementById('aptNumber');
    if (aptNumber) aptNumber.value = addr.apartment || '';
    const aptFloor = document.getElementById('aptFloor');
    if (aptFloor) aptFloor.value = addr.floor || '';
    const aptNotes = document.getElementById('aptNotes');
    if (aptNotes) aptNotes.value = addr.deliveryNotes || '';

    if (addr.street) {
      resolvedViaCep = {
        cep: addr.cep,
        logradouro: addr.street,
        bairro: addr.neighborhood,
        localidade: addr.city,
        uf: addr.state
      };
      enderecoBase = `${addr.street}, ${addr.neighborhood}, ${addr.city} - ${addr.state}`;
      bairroNome = addr.neighborhood || '';
      const info = document.getElementById('enderecoInfo');
      if (info) {
        info.textContent = enderecoBase;
        info.style.display = 'block';
      }
    }
  }

  function readAddressForm() {
    const type = getResidenceType();
    const cep = onlyDigits(document.getElementById('cepInput')?.value);
    const via = resolvedViaCep || {};
    let number = '';
    let complement = '';
    let condoName = '';
    let blockLot = '';
    let tower = '';
    let apartment = '';
    let floor = '';
    let deliveryNotes = '';

    if (type === 'casa') {
      number = onlyDigits(document.getElementById('numeroInput')?.value);
      complement = String(document.getElementById('pontoReferenciaInput')?.value || '').trim();
    } else if (type === 'condominio') {
      number = onlyDigits(document.getElementById('condoNumber')?.value);
      condoName = String(document.getElementById('condoName')?.value || '').trim();
      blockLot = String(document.getElementById('condoBlockLot')?.value || '').trim();
      deliveryNotes = String(document.getElementById('condoNotes')?.value || '').trim();
    } else {
      number = onlyDigits(document.getElementById('aptBuilding')?.value);
      tower = String(document.getElementById('aptTower')?.value || '').trim();
      apartment = String(document.getElementById('aptNumber')?.value || '').trim();
      floor = String(document.getElementById('aptFloor')?.value || '').trim();
      deliveryNotes = String(document.getElementById('aptNotes')?.value || '').trim();
    }

    return {
      id: editingCustomerAddressId || newCustomerAddressId(),
      label: String(document.getElementById('addressLabel')?.value || '').trim(),
      residenceType: type,
      cep,
      street: String(via.logradouro || '').trim(),
      neighborhood: String(via.bairro || bairroNome || '').trim(),
      city: String(via.localidade || '').trim(),
      state: String(via.uf || '').trim(),
      number,
      complement,
      condoName,
      blockLot,
      buildingNumber: type === 'apartamento' ? number : '',
      tower,
      apartment,
      floor,
      deliveryNotes,
      isDefault: !!document.getElementById('addressIsDefault')?.checked,
      updatedAt: new Date().toISOString()
    };
  }

  function clearStreetCepPickUi() {
    const results = document.getElementById('streetSearchResults');
    if (results) {
      results.innerHTML = '';
      results.hidden = true;
      results.classList.remove('is-awaiting-pick');
    }
    const warn = document.getElementById('streetSearchPickWarn');
    if (warn) warn.hidden = true;
  }

  function showStreetCepPickWarning(count) {
    const warn = document.getElementById('streetSearchPickWarn');
    if (!warn) return;
    const n = Number(count) || 0;
    const span = warn.querySelector('span');
    if (span) {
      span.textContent = n > 1
        ? `Encontramos ${n} CEPs para esta rua. Toque em uma opção destacada abaixo para continuar — sem escolher, o endereço não pode ser salvo.`
        : 'Encontramos um CEP para esta rua. Toque na opção destacada abaixo para continuar — sem escolher, o endereço não pode ser salvo.';
    }
    warn.hidden = false;
    try {
      warn.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (_) { /* ignore */ }
  }

  function hasPendingStreetCepSelection() {
    const results = document.getElementById('streetSearchResults');
    const streetMode = document.getElementById('cepModeStreet');
    if (!results || results.hidden || !streetMode || streetMode.hidden) return false;
    return !!results.querySelector('.street-result-btn');
  }

  function validateAddressForm(addr) {
    if (hasPendingStreetCepSelection()) {
      alert('Selecione um dos CEPs encontrados (lista em destaque amarela) antes de salvar o endereço.');
      document.getElementById('streetSearchPickWarn')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return false;
    }
    if (!addr.cep || addr.cep.length !== 8) {
      alert('Informe um CEP válido (ou busque pela rua e selecione um CEP na lista).');
      return false;
    }
    if (!addr.street || !addr.neighborhood || !addr.city) {
      alert('Aguarde a localização do endereço pelo CEP antes de salvar.');
      return false;
    }
    if (!deliveryOk) {
      alert('Este CEP está fora da área de entrega.');
      return false;
    }
    if (!addr.number) {
      alert('Informe o número.');
      return false;
    }
    if (addr.residenceType === 'condominio' && !addr.deliveryNotes) {
      alert('Informe as instruções de entrega / portaria.');
      return false;
    }
    if (addr.residenceType === 'apartamento') {
      if (!addr.tower || !addr.apartment) {
        alert('Informe torre/bloco e número do apartamento.');
        return false;
      }
      if (!addr.deliveryNotes) {
        alert('Informe as instruções para o entregador / portaria.');
        return false;
      }
    }
    return true;
  }

  function upsertCustomerAddress(addr) {
    const book = loadCustomerAddressBook();
    const idx = book.items.findIndex((a) => a.id === addr.id);
    if (idx >= 0) book.items[idx] = addr;
    else book.items.push(addr);

    if (addr.isDefault || book.items.length === 1) {
      book.defaultId = addr.id;
      book.items = book.items.map((a) => ({ ...a, isDefault: a.id === addr.id }));
    } else {
      book.items = book.items.map((a) => ({
        ...a,
        isDefault: book.defaultId ? a.id === book.defaultId : false
      }));
    }
    saveCustomerAddressBook(book);
    return book;
  }

  function deleteCustomerAddress(id) {
    const book = loadCustomerAddressBook();
    book.items = book.items.filter((a) => a.id !== id);
    if (book.defaultId === id) {
      book.defaultId = book.items[0]?.id || null;
      book.items = book.items.map((a, i) => ({ ...a, isDefault: i === 0 }));
    }
    saveCustomerAddressBook(book);
    if (selectedCustomerAddressId === id) {
      selectedCustomerAddressId = book.defaultId;
    }
    if (editingCustomerAddressId === id) {
      editingCustomerAddressId = null;
      addressFormOpen = false;
    }
    renderCustomerAddresses();
    if (selectedCustomerAddressId) {
      selectCustomerAddress(selectedCustomerAddressId, { silent: true });
    } else {
      resetAddressInfo();
      updateUI();
    }
    saveCheckoutForm();
  }

  function openAddressForm(addr) {
    addressFormOpen = true;
    if (addr) fillAddressForm(addr);
    else clearAddressFormFields();
    const section = document.getElementById('addressFormSection');
    if (section) section.hidden = false;
    renderCustomerAddresses();
    if (!addr) {
      resetAddressInfo();
      updateUI();
    } else if (onlyDigits(addr.cep).length === 8) {
      lastCep = null;
      buscarEndereco();
    }
  }

  function closeAddressForm() {
    addressFormOpen = false;
    editingCustomerAddressId = null;
    const section = document.getElementById('addressFormSection');
    if (section) section.hidden = true;
    renderCustomerAddresses();
  }

  function saveAddressFromForm() {
    const addr = readAddressForm();
    if (!validateAddressForm(addr)) return;
    upsertCustomerAddress(addr);
    selectedCustomerAddressId = addr.id;
    closeAddressForm();
    selectCustomerAddress(addr.id, { silent: false });
    saveCheckoutForm();
  }

  function renderCustomerAddresses() {
    const list = document.getElementById('savedAddressesList');
    const empty = document.getElementById('addressBookEmpty');
    const addBtn = document.getElementById('addAddressBtn');
    if (!list) return;
    const book = loadCustomerAddressBook();
    list.innerHTML = '';

    if (empty) empty.hidden = book.items.length > 0 || addressFormOpen;
    if (addBtn) addBtn.hidden = addressFormOpen;

    book.items.forEach((addr) => {
      const summary = summarizeCustomerAddress(addr);
      const card = document.createElement('label');
      card.className = 'address-card';
      if (addr.id === selectedCustomerAddressId) card.classList.add('selected');
      if (addr.isDefault) card.classList.add('is-default');
      card.innerHTML =
        `<input type="radio" name="customerAddress" value="${escapeHtml(addr.id)}" ${addr.id === selectedCustomerAddressId ? 'checked' : ''} />` +
        `<div class="address-card-body">` +
          `<div class="address-card-title-row">` +
            `<strong>${escapeHtml(summary.title)}</strong>` +
            `${addr.isDefault ? '<span class="address-default-pill">Padrão</span>' : ''}` +
            `<span class="address-type-pill">${escapeHtml(residenceTypeLabel(addr.residenceType))}</span>` +
          `</div>` +
          `<span class="address-card-line">${escapeHtml(summary.subtitle)}</span>` +
          `<span class="address-card-meta">${escapeHtml(summary.meta)}</span>` +
          `<div class="address-card-actions">` +
            `<button type="button" class="ghost-link" data-edit-address="${escapeHtml(addr.id)}">Editar</button>` +
            `<button type="button" class="ghost-link danger" data-del-address="${escapeHtml(addr.id)}">Excluir</button>` +
          `</div>` +
        `</div>`;
      list.appendChild(card);
    });

    list.querySelectorAll('input[name="customerAddress"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        if (radio.checked) selectCustomerAddress(radio.value);
      });
    });
    list.querySelectorAll('[data-edit-address]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const addr = book.items.find((a) => a.id === btn.dataset.editAddress);
        if (addr) openAddressForm(addr);
      });
    });
    list.querySelectorAll('[data-del-address]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (confirm('Excluir este endereço salvo?')) deleteCustomerAddress(btn.dataset.delAddress);
      });
    });
  }

  function selectCustomerAddress(id, { silent } = {}) {
    const book = loadCustomerAddressBook();
    const addr = book.items.find((a) => a.id === id);
    if (!addr) return;
    selectedCustomerAddressId = id;
    addressFormOpen = false;
    const section = document.getElementById('addressFormSection');
    if (section) section.hidden = true;
    renderCustomerAddresses();

    const cepInput = document.getElementById('cepInput');
    if (cepInput) cepInput.value = maskCep(addr.cep || '');
    // Número precisa estar disponível antes do quote — sem ele a taxa falha e o checkout some.
    syncStreetNumberFields(addr.number);
    resolvedViaCep = {
      cep: addr.cep,
      logradouro: addr.street,
      bairro: addr.neighborhood,
      localidade: addr.city,
      uf: addr.state
    };
    lastCep = null;
    buscarEndereco();
    saveCheckoutForm();
    if (!silent) updateUI();
  }

  function migrateLegacyCheckoutAddress(data) {
    const book = loadCustomerAddressBook();
    if (book.items.length) return;
    const cep = onlyDigits(data?.cep);
    const number = onlyDigits(data?.numero);
    if (cep.length !== 8 || !number) return;
    const addr = {
      id: newCustomerAddressId(),
      label: 'Principal',
      residenceType: 'casa',
      cep,
      street: '',
      neighborhood: '',
      city: '',
      state: '',
      number,
      complement: String(data.referencia || '').trim(),
      condoName: '',
      blockLot: '',
      buildingNumber: '',
      tower: '',
      apartment: '',
      floor: '',
      deliveryNotes: '',
      isDefault: true,
      updatedAt: new Date().toISOString()
    };
    saveCustomerAddressBook({ defaultId: addr.id, items: [addr] });
    selectedCustomerAddressId = addr.id;
  }

  function applyCheckoutForm(data) {
    if (!data || typeof data !== 'object') return;

    migrateLegacyCheckoutAddress(data);

    const nomeInput = document.getElementById('clienteNome');
    if (nomeInput && data.nome != null) nomeInput.value = String(data.nome);

    const phoneInput = document.getElementById('clienteTelefone');
    if (phoneInput && data.telefone) phoneInput.value = maskPhone(data.telefone);

    // Sessão de equipe (Balcão/Delivery/Telefone/garçom): NÃO restaurar forma de
    // pagamento/Pix/troco salvos de outra navegação — o checkout enxuto só usa
    // nome + total e o pagamento é definido no painel (nunca aqui).
    let staffSessionActive = false;
    try {
      staffSessionActive =
        !!sessionStorage.getItem(STAFF_SESSION_KEY) ||
        !!sessionStorage.getItem(WAITER_SESSION_KEY);
    } catch (_) { /* storage indisponível */ }

    if (!staffSessionActive) {
      const forma = document.getElementById('formaPagamento');
      if (forma && data.formaPagamento) {
        const option = Array.from(forma.options).find((o) => o.value === data.formaPagamento);
        if (option && !option.disabled) forma.value = data.formaPagamento;
      }

      if (data.pixTiming) {
        document.querySelectorAll('input[name="pixTiming"]').forEach((radio) => {
          radio.checked = radio.value === data.pixTiming;
        });
      }

      const precisaTroco = document.getElementById('precisaTroco');
      const trocoInput = document.getElementById('trocoInput');
      if (precisaTroco) {
        precisaTroco.checked = !!data.precisaTroco;
        if (trocoInput) {
          trocoInput.disabled = !precisaTroco.checked;
          trocoInput.value = data.precisaTroco ? String(data.troco || '') : '';
        }
      }
    }

    const obsInput = document.getElementById('observacoesInput');
    if (obsInput && data.observacoes != null) obsInput.value = String(data.observacoes);

    updatePaymentExtras();

    const book = loadCustomerAddressBook();
    selectedCustomerAddressId = data.selectedCustomerAddressId
      || book.defaultId
      || book.items[0]?.id
      || null;
    renderCustomerAddresses();

    if (selectedCustomerAddressId) {
      selectCustomerAddress(selectedCustomerAddressId, { silent: true });
    } else if (book.items.length === 0) {
      openAddressForm(null);
    }
  }

  function loadCheckoutForm() {
    try {
      const raw = localStorage.getItem(CHECKOUT_STORAGE_KEY);
      const data = raw ? JSON.parse(raw) : {};
      applyCheckoutForm(data && typeof data === 'object' ? data : {});
    } catch (_) {
      renderCustomerAddresses();
      if (!loadCustomerAddressBook().items.length) openAddressForm(null);
    }
  }

  function setStatus(message, isError) {
    let el = document.getElementById('apiStatusBanner');
    if (!el) {
      el = document.createElement('div');
      el.id = 'apiStatusBanner';
      el.className = 'store-closed-banner';
      el.setAttribute('role', 'status');
      const header = document.querySelector('.barra__topo__md');
      if (header && header.nextSibling) {
        header.parentNode.insertBefore(el, header.nextSibling);
      } else {
        document.body.prepend(el);
      }
    }
    if (!message) {
      el.hidden = true;
      el.textContent = '';
      return;
    }
    el.hidden = false;
    el.textContent = message;
    el.style.background = isError ? '#b91c1c' : '#1f6feb';
  }

  async function loadFromApi() {
    setStatus('Carregando cardápio…', false);
    const storeRes = await fetch(`${API_BASE}/api/v1/store`, { cache: 'no-store' });
    if (!storeRes.ok) {
      throw new Error(`API indisponível (${storeRes.status})`);
    }
    const store = await storeRes.json();
    if (store.active === false) {
      showStoreInactive(store.storeName);
      return;
    }

    const catalogRes = await fetch(`${API_BASE}/api/v1/catalog`, { cache: 'no-store' });
    if (!catalogRes.ok) {
      throw new Error(`API indisponível (${catalogRes.status})`);
    }
    const catalog = await catalogRes.json();

    cfg = {
      storeName: store.storeName,
      logoUrl: store.logoUrl,
      iconUrl: store.iconUrl || '',
      whatsapp: store.whatsapp,
      pixKey: store.pixKey,
      pixKeyLabel: store.pixKeyLabel,
      minOrder: store.minOrder,
      currencyLocale: store.currencyLocale || 'pt-BR',
      schedule: store.schedule,
      deliveryFees: store.deliveryFees || {},
      address: store.address || '',
      city: store.city || '',
      state: store.state || '',
      latitude: store.latitude,
      longitude: store.longitude,
      deliveryFeePerKm: Number(store.deliveryFeePerKm || 0),
      maxDeliveryKm: Number(store.maxDeliveryKm || 0),
      minDeliveryFee: Number(store.minDeliveryFee || 0),
      averageDeliveryMinutes: Number(store.averageDeliveryMinutes || 40),
      breadOptions: Array.isArray(store.breadOptions) ? store.breadOptions : DEFAULT_BREAD_OPTIONS,
      acceptingOrders: store.acceptingOrders !== false,
      extendedCloseUntilUtc: store.extendedCloseUntilUtc || null,
      dineInEnabled: store.dineInEnabled === true,
      customerQrOrdersEnabled: store.customerQrOrdersEnabled === true,
      requireCustomerNameForQrOrder: store.requireCustomerNameForQrOrder === true,
      allowCustomerChooseWaiter: store.allowCustomerChooseWaiter === true,
      corPrimaria: store.corPrimaria || '#1f6feb',
      corSecundaria: store.corSecundaria || '#ffffff',
      corFundo: store.corFundo || '#f3f4f6',
      corTexto: store.corTexto || '#2c3e50',
      tipoCard: store.tipoCard || 'foto-grande',
      layoutCardapio: store.layoutCardapio || 'grade',
      estiloBotao: store.estiloBotao || 'arredondado',
      bannerUrl: store.bannerUrl || '',
      coverUrl: store.coverUrl || '',
      whatsAppOrderTemplate: typeof store.whatsAppOrderTemplate === 'string' ? store.whatsAppOrderTemplate : '',
      heroEnabled: store.heroEnabled === true,
      heroProductId: store.heroProductId || '',
      heroTitle: store.heroTitle || '',
      heroSubtitle: store.heroSubtitle || '',
      menu: (catalog.categories || [])
        .filter((c) => c && c.showInMenu !== false && !isHiddenMenuCategory(c))
        .map((c) => ({
          id: c.id,
          title: c.title,
          items: (c.items || [])
            .filter((i) => i && i.showInMenu !== false)
            .map((i) => {
              const ingredientObjs = Array.isArray(i.ingredients) ? i.ingredients : [];
              const ingredients = ingredientObjs.map((ing) => ing.name || ing.id).filter(Boolean);
              const principalIngredients = ingredientObjs
                .filter((ing) => ing && ing.isPrincipal)
                .map((ing) => ing.name || ing.id)
                .filter(Boolean);
              const description = ingredients.length
                ? formatIngredientsPhrase(ingredients)
                : (i.description || '');
              return {
                id: i.id,
                name: i.name,
                price: i.price,
                priceMedia: i.priceMedia != null ? Number(i.priceMedia) : null,
                priceInteira: i.priceInteira != null ? Number(i.priceInteira) : null,
                description,
                ingredients,
                principalIngredients,
                modifierGroups: Array.isArray(i.modifierGroups) ? i.modifierGroups : [],
                imageUrl: i.imageUrl,
                badge: typeof i.badge === 'string' ? i.badge : ''
              };
            })
        }))
        .filter((c) => (c.items || []).length > 0)
    };

    await attachTopProducts();

    window.APP_CONFIG = cfg;
    activeCategory = cfg.menu[0] && cfg.menu[0].id;

    const title = document.querySelector('.barra__topo__md h3');
    if (title) title.textContent = (cfg.storeName || 'Fabin Lanches').toUpperCase();
    document.title = `${cfg.storeName} — Cardápio Delivery`;
    if (window.WA_TENANT_SLUG !== 'fabin') applyTenantTheme();
    // Prévia do painel: avisa que carregou para receber o tema em edição.
    if (IS_THEME_PREVIEW) {
      try { window.parent.postMessage({ type: 'wa-theme-preview-ready' }, location.origin); } catch (_) { /* ignore */ }
    }
    applyStoreIcons();
    await updatePwaManifestFromStore();
    armInstallPromptCapture();

    // Mantém a arte original do topo; logoUrl da API só aplica se for diferente da barra padrão
    if (window.WA_TENANT_SLUG !== 'fabin' && cfg.logoUrl && !cfg.logoUrl.includes('barra-v-mobile')) {
      const header = document.querySelector('.barra__topo__md');
      if (header) {
        const logoAbs = cfg.logoUrl.startsWith('http') ? cfg.logoUrl : `${API_BASE}${cfg.logoUrl}`;
        header.style.backgroundImage = `url(${logoAbs})`;
      }
    }

    setStatus('', false);

    const pixKeyEl = document.getElementById('pixKeyValue');
    if (pixKeyEl) pixKeyEl.textContent = cfg.pixKey || '';
    syncPixPaymentOption();

    syncCartWithCatalog();
  }

  // ── Tema claro/escuro escolhido pelo cliente (só lojas com tema; salvo no navegador) ──
  const COLOR_SCHEME_KEY = 'wa-color-scheme';

  function readColorScheme() {
    try { return localStorage.getItem(COLOR_SCHEME_KEY) === 'dark' ? 'dark' : 'light'; } catch (_) { return 'light'; }
  }

  function applyColorScheme(scheme) {
    const dark = scheme === 'dark' && document.body.classList.contains('tenant-themed');
    if (dark) document.documentElement.dataset.theme = 'dark';
    else delete document.documentElement.dataset.theme;
    const btn = document.getElementById('colorSchemeToggle');
    if (btn) {
      btn.hidden = !document.body.classList.contains('tenant-themed');
      btn.setAttribute('aria-pressed', String(dark));
      btn.setAttribute('aria-label', dark ? 'Ativar tema claro' : 'Ativar tema escuro');
      btn.title = dark ? 'Tema claro' : 'Tema escuro';
    }
  }

  function toggleColorScheme() {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(COLOR_SCHEME_KEY, next); } catch (_) { /* sem storage: vale só nesta visita */ }
    applyColorScheme(next);
  }

  function applyTenantTheme() {
    if (!window.WA_TENANT_SLUG || window.WA_TENANT_SLUG === 'fabin') return;

    const root = document.documentElement;
    root.style.setProperty('--tenant-primary', cfg.corPrimaria);
    root.style.setProperty('--tenant-secondary', cfg.corSecundaria);
    root.style.setProperty('--tenant-background', cfg.corFundo);
    root.style.setProperty('--tenant-text', cfg.corTexto);
    document.body.classList.add('tenant-themed');
    // Lojas da plataforma: todas as categorias numa rolagem vertical (a Fabin mantém o carrossel).
    document.body.classList.add('menu-vertical');
    applyColorScheme(readColorScheme());
    document.body.classList.toggle('tenant-layout-list', cfg.layoutCardapio === 'lista');
    document.body.classList.toggle('tenant-layout-grid', cfg.layoutCardapio === 'grade');
    const hasProductPhoto = cfg.layoutCardapio === 'com-foto'
      || (cfg.layoutCardapio !== 'sem-foto' && cfg.tipoCard !== 'compacto');
    document.body.classList.toggle('tenant-no-photo', !hasProductPhoto);
    document.body.classList.toggle('tenant-card-large-photo', cfg.tipoCard === 'foto-grande');
    document.body.classList.toggle('tenant-card-horizontal', cfg.tipoCard === 'lista-horizontal');
    document.body.classList.toggle('tenant-card-compact', cfg.tipoCard === 'compacto');
    document.body.classList.toggle('tenant-card-vitrine', cfg.tipoCard === 'vitrine');
    document.body.classList.toggle('tenant-card-minimal', cfg.tipoCard === 'minimalista');
    document.body.classList.toggle('tenant-card-highlight', cfg.tipoCard === 'destaque');
    document.body.classList.toggle('tenant-card-modern', cfg.tipoCard === 'moderno');
    document.body.classList.toggle('tenant-button-square', cfg.estiloBotao === 'quadrado');
    document.body.classList.toggle('tenant-button-pill', cfg.estiloBotao === 'pilula');

    const header = document.querySelector('.barra__topo__md');
    const banner = resolveAssetUrl(cfg.bannerUrl);
    if (header) header.style.backgroundImage = banner ? `url("${banner}")` : 'none';

    const oldCover = document.querySelector('.tenant-store-cover');
    if (oldCover) oldCover.remove();
    const categories = document.querySelector('.categories-wrapper');
    if (categories && cfg.coverUrl) {
      const cover = document.createElement('div');
      cover.className = 'tenant-store-cover';
      const image = document.createElement('img');
      image.src = resolveAssetUrl(cfg.coverUrl);
      image.alt = `Capa de ${cfg.storeName}`;
      cover.append(image);
      categories.before(cover);
    }

    const brand = document.querySelector('.barra-topo-brand');
    const oldLogo = brand && brand.querySelector('.tenant-store-logo');
    if (oldLogo) oldLogo.remove();
    if (brand && cfg.logoUrl) {
      const logo = document.createElement('img');
      logo.className = 'tenant-store-logo';
      logo.src = resolveAssetUrl(cfg.logoUrl);
      logo.alt = '';
      logo.setAttribute('aria-hidden', 'true');
      brand.prepend(logo);
    }
  }

  function showStoreInactive(storeName) {
    document.body.classList.add('store-is-inactive');
    const screen = document.getElementById('storeInactiveScreen');
    if (screen) {
      screen.hidden = false;
      const title = screen.querySelector('h1');
      if (title && storeName) title.textContent = `${storeName} indisponível`;
    }
    const banner = document.getElementById('bottomMenu');
    if (banner) banner.hidden = true;
    setStatus('', false);
  }

  function getOptionRule(category, item) {
    if (!item) return null;
    const rule = getProductOptionRules().find((r) => r.match(category, item)) || null;
    if (!rule) return null;
    const options = Array.isArray(rule.options) ? rule.options.filter(Boolean) : [];
    if (rule.id === 'lanche-pao' && options.length === 0) return null;
    const optionPrices = typeof rule.optionPricesFromItem === 'function'
      ? rule.optionPricesFromItem(item)
      : (rule.optionPrices || null);
    return { ...rule, options, optionPrices };
  }

  function isMaisVendidosCategory(category) {
    return !!category && category.id === MAIS_VENDIDOS_ID;
  }

  /** Réplica da lógica OrderValidation.BaseProductName do backend:
   *  remove " (Obs.:...)" e o último " (...)" se o nome terminar com ")". */
  function baseProductName(name) {
    let n = String(name || '').trim();
    const obsIdx = n.toLowerCase().indexOf(' (obs.:');
    if (obsIdx > 0) n = n.slice(0, obsIdx).trim();
    const open = n.lastIndexOf(' (');
    if (open > 0 && n.endsWith(')')) n = n.slice(0, open).trim();
    return n;
  }

  /** Busca os produtos mais vendidos e injeta a categoria "Mais Vendidos" no topo do cardápio.
   *  Usa o ranking por nome cru (igual ao dashboard admin), agrupando as variantes
   *  (pão/tamanho/obs) no produto de catálogo e preservando a ordem do ranking cru. */
  async function attachTopProducts() {
    if (!cfg || !Array.isArray(cfg.menu)) return;
    let payload = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(`${API_BASE}/api/v1/orders/top-products?days=30`, {
        cache: 'no-store',
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) return;
      payload = await res.json();
    } catch (_) {
      // API de vendas indisponível → segue com o cardápio cadastrado, sem a categoria.
      return;
    }
    const tops = Array.isArray(payload && payload.items) ? payload.items : [];
    if (!tops.length) return;

    // Mapa por nome-base (case-insensitive) dos itens reais → produto de catálogo.
    const byBase = new Map();
    cfg.menu.forEach((cat) => {
      (cat.items || []).forEach((item) => {
        const key = String(baseProductName(item.name)).toLowerCase();
        if (key && !byBase.has(key)) byBase.set(key, { category: cat, item });
      });
    });

    // Agrupa por produto de catálogo, somando qtd/receita das variantes e
    // registrando a posição da primeira ocorrência no ranking cru.
    const acc = new Map(); // key base → { item, category, pos, count, revenue }
    const baseOrder = [];
    tops.forEach((top, index) => {
      const base = String(baseProductName(top.name)).toLowerCase();
      const match = byBase.get(base);
      if (!match) return;
      const count = Number(top.count) || 0;
      const revenue = Number(top.revenue) || 0;
      if (!acc.has(base)) {
        acc.set(base, {
          item: match.item,
          category: match.category,
          pos: index,
          count: 0,
          revenue: 0
        });
        baseOrder.push(base);
      }
      const rec = acc.get(base);
      rec.count += count;
      rec.revenue += revenue;
    });

    if (!acc.size) return;

    const maisVendidos = baseOrder
      .map((base) => acc.get(base))
      .sort((a, b) => a.pos - b.pos)
      .slice(0, MAIS_VENDIDOS_LIMIT)
      .map((rec) => ({ ...rec.item, __srcCategory: rec.category.id }));

    if (!maisVendidos.length) return;

    cfg.menu.unshift({
      id: MAIS_VENDIDOS_ID,
      title: MAIS_VENDIDOS_TITLE,
      items: maisVendidos,
      sortOrder: -1,
      showInMenu: true
    });
  }

  function findMenuItem(name) {
    if (!cfg || !cfg.menu) return null;
    let fallback = null;
    for (const cat of cfg.menu) {
      const item = (cat.items || []).find((it) => it.name === name);
      if (!item) continue;
      // Prefere a ocorrência original (fora de "Mais Vendidos") para preservar
      // o comportamento de porções/pão/hotdog e o id do produto no carrinho.
      if (!isMaisVendidosCategory(cat)) return { category: cat, item };
      if (!fallback) fallback = { category: cat, item };
    }
    return fallback;
  }

  function lineSignature(item) {
    const removedPart = (item.removed || []).map((r) => String(r)).join(',');
    const modsPart = (item.mods || [])
      .map((m) => `${m.groupId}:${m.optionId}`)
      .join(',');
    return `${removedPart}#${modsPart}`;
  }

  function displayItemName(item) {
    const parts = [];
    if (item.option) parts.push(item.option);

    const custom = [];
    (item.removed || []).forEach((r) => custom.push(`Sem ${r}`));
    (item.mods || []).forEach((m) => {
      const extra = Number(m.priceDelta) > 0
        ? ` +${Number(m.priceDelta).toFixed(2).replace('.', ',')}`
        : '';
      custom.push(extra ? `Adic. ${m.name}${extra}` : m.name);
    });
    if (custom.length) parts.push(custom.join('; '));

    return parts.length ? `${item.name} (${parts.join(') (')})` : item.name;
  }

  // ── Leitura da personalização gravada no nome do item (pedidos vindos da API) ──

  /** "8,00" / "R$ 8" / "+8.00" → número. */
  function parseCustomPrice(text) {
    const m = String(text == null ? '' : text).match(/(\d+(?:[.,]\d{1,2})?)/);
    if (!m) return 0;
    return Number(m[1].replace(/\./g, '').replace(',', '.')) || 0;
  }

  function pushCustomToken(token, removed, addons, notes) {
    const t = String(token == null ? '' : token).trim();
    if (!t) return;
    const sem = t.match(/^Sem\s+(.+)$/i);
    if (sem) {
      removed.push(sem[1].trim());
      return;
    }
    const adic = t.match(/^Adic\.\s*(.+)$/i);
    if (adic) {
      const raw = adic[1].trim();
      const priceMatch = raw.match(/\s*\+?\s*R?\$?\s*(\d+(?:[.,]\d{1,2})?)\s*$/);
      const priceDelta = priceMatch ? parseCustomPrice(priceMatch[1]) : 0;
      const nameOnly = (priceMatch ? raw.slice(0, priceMatch.index) : raw).replace(/[+-]\s*$/, '').trim();
      addons.push({ name: nameOnly || raw, priceDelta });
      return;
    }
    notes.push(t);
  }

  /**
   * Separa nome-base, removidos, adicionais e obs. Reconoce a obs. `(Obs.: ...)` e a
   * customização embutida no nome (`(Sem X; Adic. Nome +x,xx)`), preservando variações
   * como `(Pão francês)` no nome-base.
   */
  function parseItemCustomization(name) {
    const raw = String(name || '');
    const obsMatch = raw.match(/^(.*?)\s*\(\s*Obs\.\s*:\s*(.+?)\s*\)\s*$/i);
    const nameRaw = obsMatch ? obsMatch[1].trim() || raw : raw;
    const removed = [];
    const addons = [];
    const notes = [];
    if (obsMatch) {
      String(obsMatch[2] || '').split(';').forEach((p) => pushCustomToken(p, removed, addons, notes));
    }
    const base = nameRaw
      .replace(/\(([^()]*)\)/g, (whole, inner) => {
        const tokens = String(inner || '').split(';').map((s) => s.trim()).filter(Boolean);
        const isCustom = tokens.some((t) => /^Sem\s/i.test(t) || /^Adic\./i.test(t));
        if (!isCustom) return whole;
        tokens.forEach((t) => pushCustomToken(t, removed, addons, notes));
        return '';
      })
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+\)/g, ')')
      .trim();

    const seenRemoved = new Set();
    const dedupRemoved = [];
    removed.forEach((r) => {
      const key = String(r || '').toLowerCase();
      if (!key || seenRemoved.has(key)) return;
      seenRemoved.add(key);
      dedupRemoved.push(r);
    });
    const seenAddons = new Set();
    const dedupAddons = [];
    addons.forEach((a) => {
      const key = `${String(a.name || '').toLowerCase()}|${a.priceDelta}`;
      if (!a.name || seenAddons.has(key)) return;
      seenAddons.add(key);
      dedupAddons.push(a);
    });
    return {
      name: base || nameRaw,
      removed: dedupRemoved,
      addons: dedupAddons,
      note: notes.join('; ')
    };
  }

  /** Adicionais do item: `item.modifiers` (API) + os embutidos no nome, sem duplicar. */
  function orderItemModifiers(item) {
    const structured = Array.isArray(item && item.modifiers) ? item.modifiers : [];
    const inline = parseItemCustomization(item && item.name).addons;
    const out = [];
    const seen = new Set();
    structured.concat(inline).forEach((m) => {
      const name = String((m && m.name) || '').trim();
      if (!name) return;
      const priceDelta = Number(m && m.priceDelta) || 0;
      const key = `${name.toLowerCase()}|${priceDelta}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name, priceDelta });
    });
    return out;
  }

  /**
   * Quebra de valores de um item do pedido (valores totais da linha, já × quantidade).
   * `base` = preço unitário menos os adicionais; `total` = preço gravado × quantidade.
   */
  function itemPriceBreakdown(item) {
    const qty = Math.max(1, Number(item && item.quantity) || 1);
    const unit = Number(item && item.price) || 0;
    const info = parseItemCustomization(item && item.name);
    const addons = orderItemModifiers(item);
    const addonsUnit = addons.reduce((s, m) => s + (Number(m.priceDelta) || 0), 0);
    const baseUnit = unit - addonsUnit;
    return {
      qty,
      name: info.name,
      removed: info.removed,
      addons,
      note: info.note,
      base: (baseUnit > 0 ? baseUnit : 0) * qty,
      total: unit * qty
    };
  }

  function quantityOfProduct(name) {
    return cart
      .filter((i) => i.name === name)
      .reduce((sum, i) => sum + (i.quantity || 0), 0);
  }

  function findCartLine(name, option, sig) {
    const opt = option || '';
    if (sig) {
      return cart.find((i) => i.name === name && (i.option || '') === opt && lineSignature(i) === sig);
    }
    return cart.find((i) => i.name === name && (i.option || '') === opt);
  }

  /** Produto com composição (ingredientes) ou adicionais (grupos de modificadores). */
  function needsCustomization(item) {
    return !!item
      && ((Array.isArray(item.ingredients) ? item.ingredients.length : 0)
        + (Array.isArray(item.modifierGroups) ? item.modifierGroups.length : 0)
        > 0);
  }

  function openProductOptionModal(name, price, rule, productId) {
    pendingOptionAdd = {
      name,
      price,
      ruleId: rule.id,
      id: productId || null,
      optionPrices: rule.optionPrices || null
    };
    const title = document.getElementById('optionModalTitle');
    const question = document.getElementById('optionModalQuestion');
    const productEl = document.getElementById('optionModalProduct');
    const choices = document.getElementById('optionChoices');
    if (productEl) productEl.textContent = name;
    if (title) title.textContent = 'Escolha uma opção';
    if (question) question.textContent = rule.question;
    if (choices) {
      choices.innerHTML = '';
      rule.options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'option-choice-btn';
        const hasOwnPrice = rule.optionPrices
          && Object.prototype.hasOwnProperty.call(rule.optionPrices, opt)
          && rule.optionPrices[opt] != null
          && rule.optionPrices[opt] !== '';
        btn.textContent = hasOwnPrice
          ? `${opt} — ${formatMoney(rule.optionPrices[opt])}`
          : opt;
        btn.addEventListener('click', () => confirmProductOption(opt));
        choices.appendChild(btn);
      });
    }
    showOptionModal();
  }

  function showOptionModal() {
    const modal = document.getElementById('optionModal');
    if (!modal) return;
    modal.style.display = 'flex';
    attachModalCloseHandlers(modal);
  }

  function confirmProductOption(option) {
    if (!pendingOptionAdd) return;
    const { name, price, id, optionPrices } = pendingOptionAdd;
    pendingOptionAdd = null;
    closeModal('optionModal');
    const unit = resolveOptionUnitPrice(price, optionPrices, option);
    const found = findMenuItem(name);
    const sig = found && needsCustomization(found.item) ? '#' : undefined;
    addCartQuantity(name, unit, 1, option, id, undefined, undefined, sig);
  }

  // ─────────────────────── Personalização inline (no carrinho) ───────────────────────

  let expandedCustomKeys = new Set();

  function lineKey(item) {
    return `${item.name}\u0001${item.option || ''}\u0001${lineSignature(item)}`;
  }

  function baseUnitPrice(item) {
    const found = findMenuItem(item.name);
    if (!found) return Number(item.price) || 0;
    const optionPrices = { 'Média': found.item.priceMedia, Inteira: found.item.priceInteira };
    return resolveOptionUnitPrice(found.item.price, optionPrices, item.option || null);
  }

  function recomputeItemPrice(item) {
    return baseUnitPrice(item) + (item.mods || []).reduce((s, m) => s + (Number(m.priceDelta) || 0), 0);
  }

  function ingredientNamesFor(item) {
    const found = findMenuItem(item.name);
    const ings = found && Array.isArray(found.item.ingredients) ? found.item.ingredients : [];
    return ings
      .map((ing) => String((ing && (ing.name || ing)) || '').trim())
      .filter(Boolean);
  }

  /** Nomes dos ingredientes "principal" — não podem ser removidos pelo cliente. */
  function lockIngredientNames(item) {
    const found = findMenuItem(item.name);
    const names = found && Array.isArray(found.item.principalIngredients)
      ? found.item.principalIngredients
      : [];
    const locked = new Set();
    names.forEach((n) => {
      const name = String(n || '').trim();
      if (name) locked.add(name);
    });
    return locked;
  }

  function cartLineCustomPieces(item) {
    return []
      .concat((item.removed || []).map((r) => `Sem ${r}`))
      .concat((item.mods || []).map((m) => {
        const extra = Number(m.priceDelta) > 0
          ? ` +${Number(m.priceDelta).toFixed(2).replace('.', ',')}`
          : '';
        return extra ? `Adic. ${m.name}${extra}` : m.name;
      }));
  }

  function cartLineInfoHtml(item) {
    const pieces = cartLineCustomPieces(item);
    return `<strong>${escapeHtml(item.name)}</strong>` +
      (item.option ? `<span class="cart-line-option">${escapeHtml(item.option)}</span>` : '') +
      (pieces.length ? `<span class="cart-line-custom">${escapeHtml(pieces.join('; '))}</span>` : '') +
      `<span class="cart-line-total">${escapeHtml(String(item.quantity))}× ${formatMoney(item.price)} = ${formatMoney(lineTotal(item))}</span>`;
  }

  function cartLineTotalLabel(item) {
    return `${String(item.quantity)}× ${formatMoney(item.price)} = ${formatMoney(lineTotal(item))}`;
  }

  /** Reaplica o preço da linha após edição da personalização e atualiza a UI. */
  function commitCustomizationChange(item, li) {
    const oldKey = li ? li.dataset.cartKey : null;
    item.price = recomputeItemPrice(item);
    const newKey = lineKey(item);
    if (li) {
      if (oldKey && oldKey !== newKey && expandedCustomKeys.has(oldKey)) {
        expandedCustomKeys.delete(oldKey);
        expandedCustomKeys.add(newKey);
      }
      li.dataset.cartKey = newKey;
    }
    saveCart();
    updateTotals();
    if (li) {
      const info = li.querySelector('.cart-line-info');
      if (info) info.innerHTML = cartLineInfoHtml(item);
    }
  }

  /** Editor inline da personalização (remover ingredientes + adicionais). */
  function buildInlineCustomization(item, li) {
    const found = findMenuItem(item.name);
    if (!found || !needsCustomization(found.item)) return null;

    const key = lineKey(item);
    const open = expandedCustomKeys.has(key);
    const wrap = document.createElement('div');
    wrap.className = 'cart-custom-wrap';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'custom-toggle-btn';
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    toggle.textContent = open ? 'Ocultar personalização' : 'Personalizar';
    toggle.addEventListener('click', () => {
      const activeKey = (li && li.dataset.cartKey) || key;
      const willOpen = body.hidden;
      body.hidden = !willOpen;
      toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      toggle.textContent = willOpen ? 'Ocultar personalização' : 'Personalizar';
      if (willOpen) expandedCustomKeys.add(activeKey);
      else expandedCustomKeys.delete(activeKey);
    });

    const body = document.createElement('div');
    body.className = 'cart-custom-inline';
    body.hidden = !open;

    const lockedNames = lockIngredientNames(item);
    if (lockedNames.size) {
      // Defensivo: um ingrediente principal nunca pode constar como removido.
      const cleaned = (item.removed || []).filter((r) => !lockedNames.has(r));
      if (cleaned.length !== (item.removed || []).length) {
        item.removed = cleaned;
        saveCart();
      }
    }

    // Remover ingredientes (grátis) — todos marcados por padrão
    const ingNames = ingredientNamesFor(item);
    if (ingNames.length) {
      const section = document.createElement('div');
      section.className = 'custom-section';
      const title = document.createElement('h3');
      title.className = 'custom-section-title';
      title.textContent = 'Remover ingredientes (grátis)';
      const list = document.createElement('div');
      list.className = 'custom-removed-list';
      ingNames.forEach((ing) => {
        const label = document.createElement('label');
        label.className = 'custom-remove-option';
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.dataset.ing = ing;
        const locked = lockedNames.has(ing);
        check.checked = locked || !(item.removed || []).includes(ing);
        check.disabled = locked;
        check.addEventListener('change', () => {
          const removed = ingNames.filter((n) => {
            if (lockedNames.has(n)) return false;
            const cb = body.querySelector(`.custom-remove-option input[data-ing="${cssEscape(n)}"]`);
            return cb ? !cb.checked : true;
          });
          item.removed = removed.length ? removed : [];
          commitCustomizationChange(item, li);
        });
        const span = document.createElement('span');
        span.textContent = ing + (locked ? ' (principal)' : '');
        label.append(check, span);
        list.appendChild(label);
      });
      section.append(title, list);
      body.appendChild(section);
      if (lockedNames.size) {
        const hint = document.createElement('span');
        hint.className = 'custom-locked-hint';
        hint.textContent = 'Itens marcados como principal não podem ser removidos.';
        body.appendChild(hint);
      }
    }

    // Grupos de modificadores (adicionais pagos)
    const groups = Array.isArray(found.item.modifierGroups) ? found.item.modifierGroups : [];
    if (groups.length) {
      const section = document.createElement('div');
      section.className = 'custom-section';
      const title = document.createElement('h3');
      title.className = 'custom-section-title';
      title.textContent = 'Adicionais';
      section.appendChild(title);

      groups.forEach((group) => {
        const fieldset = document.createElement('fieldset');
        fieldset.className = 'custom-group';
        const legend = document.createElement('legend');
        const gmin = Number(group.min) || 0;
        const gmax = Number(group.max) || 0;
        let ruleLabel = '';
        if (gmax > 0) ruleLabel = gmin > 0 ? ` (escolha ${gmin} a ${gmax})` : ` (até ${gmax})`;
        else if (gmin > 0) ruleLabel = ` (mínimo ${gmin})`;
        legend.textContent = (group.name || '') + ruleLabel;
        fieldset.appendChild(legend);

        const syncMods = () => {
          const mods = (item.mods || []).filter((m) => m.groupId !== group.id);
          if (gmax === 1) {
            const checked = fieldset.querySelector('input[type=radio]:checked');
            if (checked && checked.dataset.optionId) {
              const optId = String(checked.dataset.optionId).trim();
              if (optId) {
                mods.push({
                  groupId: group.id,
                  optionId: optId,
                  name: String(checked.dataset.optionName || optId).trim(),
                  priceDelta: Math.max(0, Number(checked.dataset.delta) || 0)
                });
              }
            }
          } else {
            fieldset.querySelectorAll('input[type=checkbox]:checked').forEach((cb) => {
              const optId = String(cb.dataset.optionId).trim();
              if (!optId) return;
              mods.push({
                groupId: group.id,
                optionId: optId,
                name: String(cb.dataset.optionName || optId).trim(),
                priceDelta: Math.max(0, Number(cb.dataset.delta) || 0)
              });
            });
          }
          item.mods = mods.length ? mods : [];
          commitCustomizationChange(item, li);
        };

        (Array.isArray(group.options) ? group.options : []).forEach((option) => {
          const optName = option.name || option.id || '';
          if (!optName) return;
          const delta = Number(option.priceDelta) || 0;
          // Sem id de opção não há como validar/re-precificar no servidor: ignora.
          const optId = String(option.id || '').trim();
          if (!optId) return;
          const selected = (item.mods || []).some((m) => m.groupId === group.id && m.optionId === optId);
          const label = document.createElement('label');
          label.className = 'custom-option';
          if (gmax === 1) {
            const radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = `cart-custom-radio-${key}-${group.id || group.name || 'g'}`;
            radio.dataset.optionId = optId;
            radio.dataset.optionName = optName;
            radio.dataset.delta = String(delta);
            radio.checked = selected;
            radio.addEventListener('change', syncMods);
            label.append(radio);
          } else {
            const check = document.createElement('input');
            check.type = 'checkbox';
            check.dataset.optionId = optId;
            check.dataset.optionName = optName;
            check.dataset.delta = String(delta);
            check.checked = selected;
            check.addEventListener('change', syncMods);
            label.append(check);
          }
          const span = document.createElement('span');
          span.textContent = delta > 0 ? `${optName} — +${formatMoney(delta)}` : optName;
          label.appendChild(span);
          fieldset.appendChild(label);
        });

        section.appendChild(fieldset);
      });

      body.appendChild(section);
    }

    wrap.append(toggle, body);
    return wrap;
  }

  function changeQuantity(name, price, change, option, productId) {
    if (change > 0) {
      const found = findMenuItem(name);
      const rule = found ? getOptionRule(found.category, found.item) : null;
      const id = productId || found?.item?.id || null;
      // No cardápio (+): se precisa de opção e não veio opção explícita, pergunta
      if (rule && !option) {
        if (rule.options.length === 1) {
          const opt = rule.options[0];
          const unit = resolveOptionUnitPrice(price, rule.optionPrices, opt);
          const sig = found && needsCustomization(found.item) ? '#' : undefined;
          addCartQuantity(name, unit, 1, opt, id, undefined, undefined, sig);
          return;
        }
        openProductOptionModal(name, price, rule, id);
        return;
      }
      // Produto com composição/opcionais: entra direto no carrinho (personalização
      // é feita depois, inline no modal de pedidos).
      const sig = found && needsCustomization(found.item) ? '#' : undefined;
      addCartQuantity(name, price, change, option || null, id, undefined, undefined, sig);
      return;
    }

    // Diminuir: se opção explícita, só aquela linha; senão, última linha do produto
    if (option) {
      addCartQuantity(name, price, change, option, productId);
      return;
    }
    const lines = cart.filter((i) => i.name === name);
    if (!lines.length) return;
    const target = lines[lines.length - 1];
    addCartQuantity(name, target.price, change, target.option || null, target.id || productId,
      undefined, undefined, lineSignature(target));
  }

  function addCartQuantity(name, price, change, option, productId, removed, mods, sig) {
    const opt = option || '';
    const unitPrice = Number(price);
    const safePrice = Number.isFinite(unitPrice) ? unitPrice : 0;
    const rem = Array.isArray(removed) ? removed.filter((r) => String(r || '').trim()).map((r) => String(r).trim()) : [];
    const modList = Array.isArray(mods)
      ? mods.filter((m) => m && m.groupId && m.optionId).map((m) => ({
          groupId: String(m.groupId).trim(),
          optionId: String(m.optionId).trim(),
          name: String(m.name || m.optionId).trim(),
          priceDelta: Math.max(0, Number(m.priceDelta) || 0)
        }))
      : [];
    let line = sig
      ? findCartLine(name, opt, sig)
      : findCartLine(name, opt);
    let quantity = line ? Number(line.quantity) || 0 : 0;
    quantity += Number(change) || 0;
    if (quantity < 0) quantity = 0;
    const id = productId || line?.id || findMenuItem(name)?.item?.id || null;

    if (quantity > 0) {
      if (line) {
        line.quantity = quantity;
        if (change > 0) line.price = safePrice;
        if (id) line.id = id;
        if (rem.length) line.removed = rem;
        if (modList.length) line.mods = modList;
      } else {
        cart.push({
          id,
          name,
          price: safePrice,
          quantity,
          option: opt || null,
          note: '',
          removed: rem,
          mods: modList
        });
      }
    } else {
      cart = cart.filter((i) => !(i.name === name && (i.option || '') === opt
        && (!sig || lineSignature(i) === sig)));
    }

    syncProductQuantityUi(name);
    saveCart();
    updateUI();
  }

  function setQuantity(name, price, quantity, option, productId, sig) {
    const opt = option || '';
    const unitPrice = Number(price);
    const safePrice = Number.isFinite(unitPrice) ? unitPrice : 0;
    const q = Math.max(0, Math.floor(Number(quantity) || 0));
    const line = sig
      ? findCartLine(name, opt, sig)
      : findCartLine(name, opt);
    const id = productId || line?.id || findMenuItem(name)?.item?.id || null;
    if (q > 0) {
      if (line) {
        line.quantity = q;
        line.price = safePrice;
        if (id) line.id = id;
      } else {
        cart.push({ id, name, price: safePrice, quantity: q, option: opt || null, note: '' });
      }
    } else {
      cart = cart.filter((i) => !(i.name === name && (i.option || '') === opt
        && (!sig || lineSignature(i) === sig)));
    }
    syncProductQuantityUi(name);
    saveCart();
    updateUI();
  }

  function removeFromCart(name, option, sig) {
    if (sig) {
      const optKey = option || '';
      cart = cart.filter((i) => !(i.name === name && (i.option || '') === optKey
        && lineSignature(i) === sig));
      syncProductQuantityUi(name);
      saveCart();
      updateUI();
      return;
    }
    const item = findCartLine(name, option || '');
    if (!item) {
      // remove todas as linhas do produto se não houver opção
      if (!option) {
        cart = cart.filter((i) => i.name !== name);
        syncProductQuantityUi(name);
        saveCart();
        updateUI();
      }
      return;
    }
    setQuantity(name, item.price, 0, option || null, item.id, lineSignature(item));
  }

  function syncProductQuantityUi(name) {
    const quantity = quantityOfProduct(name);
    const span = document.getElementById(`quantity-${name}`);
    if (span) {
      span.textContent = quantity > 0 ? String(quantity) : '';
      span.classList.toggle('zero', quantity === 0);
      const parent = span.parentElement;
      if (parent) {
        const minusButton = parent.querySelector('button.minus');
        if (minusButton) minusButton.classList.toggle('minus-hidden', quantity === 0);
      }
    }
    updateMenuItemState(name, quantity);
  }

  function updateMenuItemState(name, quantity) {
    const span = document.getElementById(`quantity-${name}`);
    if (!span) return;
    const menuItem = span.closest('.menu-item');
    if (!menuItem) return;

    const existingBadge = menuItem.querySelector('.added-badge');
    if (existingBadge) existingBadge.remove();

    if (quantity >= 1) {
      menuItem.classList.add('added');
      const badge = document.createElement('div');
      badge.className = 'added-badge';
      badge.setAttribute('aria-hidden', 'true');
      badge.textContent = '✓';
      menuItem.appendChild(badge);
    } else {
      menuItem.classList.remove('added');
    }
  }

  function updateUI() {
    updateCartItems();
    updateFulfillmentUi();
    updateTotals();
    toggleCartButton();
    updatePaymentExtras();
    updateCheckoutVisibility();
  }

  function isPickupFulfillment() {
    return fulfillmentMode === 'pickup';
  }

  function isDineInFulfillment() {
    return fulfillmentMode === 'dine_in';
  }

  function storePickupAddress() {
    const parts = [
      cfg?.address,
      cfg?.city && cfg?.state ? `${cfg.city} - ${cfg.state}` : (cfg?.city || cfg?.state || '')
    ].map((p) => String(p || '').trim()).filter(Boolean);
    return parts.length ? parts.join(', ') : 'Retirada no local';
  }

  function updateFulfillmentUi() {
    const section = document.getElementById('fulfillmentSection');
    const addressSection = document.getElementById('customerAddressSection');
    const pickupHint = document.getElementById('fulfillmentPickupHint');
    const deliveryBtn = document.getElementById('fulfillmentDeliveryBtn');
    const pickupBtn = document.getElementById('fulfillmentPickupBtn');
    const hasItems = cart.length > 0;
    const dineIn = isDineInFulfillment();
    const atendimento = !!staffSource;
    // No Telefone o atendente escolhe entre Entrega e Retirada no local.
    const telefonePickMode = atendimento && staffSource === 'telefone';

    if (section) {
      // Mesa (dine-in) e Balcão/Delivery têm fulfillment fixo — esconde o seletor
      // para o funcionário não trocar o canal. No Telefone o seletor aparece.
      section.hidden = !hasItems || dineIn || (atendimento && !telefonePickMode);
    }
    if (deliveryBtn) deliveryBtn.classList.toggle('is-selected', fulfillmentMode === 'delivery');
    if (pickupBtn) pickupBtn.classList.toggle('is-selected', fulfillmentMode === 'pickup');

    if (addressSection) {
      addressSection.hidden = !hasItems || fulfillmentMode !== 'delivery';
    }

    if (pickupHint) {
      if (fulfillmentMode === 'pickup') {
        pickupHint.hidden = false;
        pickupHint.textContent = atendimento && staffSource !== 'telefone'
          ? `Retirada no Balcão · ${waiterName || 'Atendente'}.`
          : `Retirada em: ${storePickupAddress()}. Sem taxa de entrega.`;
      } else if (dineIn) {
        pickupHint.hidden = false;
        pickupHint.textContent = waiterToken
          ? `Consumo no local · Mesa ${tableNumberText()} · ${waiterName || 'Garçom'}.`
          : `Consumo no local · Mesa ${tableNumberText()}.`;
      } else if (atendimento) {
        pickupHint.hidden = false;
        pickupHint.textContent = `${atendimentoLabel(staffSource)} · ${waiterName || 'Atendente'}`;
      } else {
        pickupHint.hidden = true;
        pickupHint.textContent = '';
      }
    }

    const entregaLabel = document.getElementById('entregaLabel');
    if (entregaLabel) {
      entregaLabel.textContent = dineIn ? 'Mesa' : (isPickupFulfillment() ? 'Retirada' : 'Entrega');
    }

    const pixOnDeliveryLabel = document.getElementById('pixPayOnDeliveryLabel');
    if (pixOnDeliveryLabel) {
      if (dineIn) pixOnDeliveryLabel.textContent = 'Pagar no local';
      else pixOnDeliveryLabel.textContent = isPickupFulfillment() ? 'Pagar na retirada' : 'Pagar na entrega';
    }

    const dineInBanner = document.getElementById('dineInBanner');
    if (dineInBanner) {
      dineInBanner.hidden = !dineIn && !atendimento;
      if (dineIn) {
        dineInBanner.textContent = waiterToken
          ? `Consumo no local — Mesa ${tableNumberText()} · ${waiterName || 'Garçom'}`
          : `Consumo no local — Mesa ${tableNumberText()}`;
      } else if (atendimento) {
        dineInBanner.textContent = `Atendimento — ${atendimentoLabel(staffSource)} · ${waiterName || 'Atendente'}`;
      }
    }
  }

  function setFulfillmentMode(mode) {
    if (mode !== 'delivery' && mode !== 'pickup') return;
    fulfillmentMode = mode;

    if (mode === 'pickup') {
      closeAddressForm();
      bairroValor = 0;
      bairroNome = 'Retirada';
      deliveryOk = true;
      deliveryDistanceKm = null;
      enderecoBase = storePickupAddress();
    } else {
      // Volta ao fluxo de endereço; checkout só após CEP/área ok
      deliveryOk = false;
      bairroValor = 0;
      bairroNome = '';
      enderecoBase = '';
      deliveryDistanceKm = null;
      if (selectedCustomerAddressId) {
        selectCustomerAddress(selectedCustomerAddressId, { silent: true });
      } else if (!loadCustomerAddressBook().items.length) {
        openAddressForm(null);
      }
    }

    updateFulfillmentUi();
    updateUI();
  }

  function updateCheckoutVisibility() {
    const box = document.getElementById('checkoutAfterCep');
    if (!box) return;
    if (!cart.length || !fulfillmentMode) {
      box.hidden = true;
      return;
    }
    if (isDineInFulfillment()) {
      // Consumo no local (QR ou garçom): checkout visível sem endereço de entrega
      box.hidden = false;
      updateWaiterCheckoutUi();
      return;
    }
    if (isPickupFulfillment()) {
      box.hidden = false;
      if (staffSource || waiterToken) updateWaiterCheckoutUi();
      return;
    }
    // Entrega: pagamento só após endereço válido e dentro da área.
    // Atendimento (Balcão/Delivery/Telefone em modo delivery): libera assim que o
    // endereço é resolvido (CEP ok + dentro da área), sem exigir endereço salvo no
    // book — o cliente comum continua exigindo endereço salvo/selecionado.
    const isStaffDelivery = (staffSource || waiterToken) && fulfillmentMode === 'delivery';
    const hasSelected = isStaffDelivery
      ? !addressFormOpen
      : !!getSelectedCustomerAddress() && !addressFormOpen;
    box.hidden = !(deliveryOk && hasSelected);
    if (!box.hidden && (staffSource || waiterToken)) updateWaiterCheckoutUi();
  }

  // Número/label da mesa sem o prefixo duplicado "Mesa " (evita "Mesa Mesa 3").
  function tableNumberText() {
    const raw = String(dineInTable?.tableNumber || dineInTable?.label || '');
    return raw.replace(/^mesa\s+/i, '').trim();
  }

  // Título do carrinho: para mesa/garçom → "Pedido Mesa N" (+ nome do cliente entre parênteses).
  function updateCartTitle() {
    const el = document.getElementById('cartModalTitle');
    if (!el) return;
    if (isDineInFulfillment() && dineInTable) {
      const num = tableNumberText();
      const name = (document.getElementById('clienteNome')?.value || '').trim();
      el.textContent = num ? `Pedido Mesa ${num}${name ? ` (${name})` : ''}` : 'Pedido para a mesa';
    } else if (staffSource) {
      el.textContent = `Pedido de ${atendimentoLabel(staffSource)}`;
    } else {
      el.textContent = 'Seu Carrinho';
    }
  }

  function updateWaiterCheckoutUi() {
    const isWaiter = isDineInFulfillment() && !!waiterToken;
    const isStaff = !!waiterToken || !!staffSource;
    const telLabel = document.querySelector('label[for="clienteTelefone"]');
    const telInput = document.getElementById('clienteTelefone');
    const payLabel = document.querySelector('label[for="formaPagamento"]');
    const paySelect = document.getElementById('formaPagamento');
    const pixWrap = document.getElementById('pixWrap');
    const trocoWrap = document.getElementById('trocoWrap');
    const detailsBtn = document.getElementById('toggleCartTotalDetails');
    // Atendimento (garçom, Balcão, Delivery, Telefone): check-out enxuto — o
    // pagamento fica "Em Aberto" (baixa depois no painel), então formulá de
    // pagamento/Pix/troco/observações ficam ocultos. Em mesa o telefone também é
    // oculto; em Balcão/Telefone/Delivery o telefone do cliente é obrigatório.
    [payLabel, paySelect, pixWrap, trocoWrap].forEach((el) => {
      if (el) el.hidden = isStaff;
    });
    if (detailsBtn) detailsBtn.hidden = isStaff;
    if (telLabel) telLabel.hidden = isWaiter;
    if (telInput) telInput.hidden = isWaiter;
    const continueBtn = document.getElementById('continueShoppingBtn');
    if (continueBtn) continueBtn.textContent = isStaff ? 'Adicionar mais itens' : 'Continuar Comprando';
    updateCartTitle();
  }

  function setItemNote(name, option, note, sig) {
    const line = sig
      ? findCartLine(name, option || '', sig)
      : findCartLine(name, option || '');
    if (!line) return;
    line.note = sanitizeInput(note).slice(0, 120);
    saveCart();
  }

  function updateCartItems() {
    const cartItems = document.getElementById('cartItems');
    if (!cartItems) return;
    cartItems.innerHTML = '';

    if (cart.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'cart-empty';
      empty.textContent = 'Seu carrinho está vazio.';
      cartItems.appendChild(empty);
      return;
    }

    cart.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'cart-line';
      li.dataset.cartKey = lineKey(item);
      const label = displayItemName(item);
      const optKey = item.option || '';

      const info = document.createElement('div');
      info.className = 'cart-line-info';
      info.innerHTML = cartLineInfoHtml(item);

      const controls = document.createElement('div');
      controls.className = 'cart-line-controls';

      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'cart-qty-btn';
      minus.setAttribute('aria-label', `Diminuir ${label}`);
      minus.textContent = '−';
      minus.addEventListener('click', () => addCartQuantity(item.name, item.price, -1, item.option || null, item.id, undefined, undefined, lineSignature(item)));

      const qty = document.createElement('span');
      qty.className = 'cart-qty';
      qty.textContent = String(item.quantity);

      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'cart-qty-btn';
      plus.setAttribute('aria-label', `Aumentar ${label}`);
      plus.textContent = '+';
      plus.addEventListener('click', () => addCartQuantity(item.name, item.price, 1, item.option || null, item.id, undefined, undefined, lineSignature(item)));

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'cart-remove-btn';
      remove.setAttribute('aria-label', `Remover ${label}`);
      remove.textContent = 'Remover';
      remove.addEventListener('click', () => removeFromCart(item.name, item.option || null, lineSignature(item)));

      controls.append(minus, qty, plus, remove);

      li.append(info, controls);

      if (!isBeverageItemName(item.name)) {
        const noteWrap = document.createElement('label');
        noteWrap.className = 'cart-line-note';
        noteWrap.htmlFor = `cart-note-${index}`;
        const noteLabel = document.createElement('span');
        noteLabel.textContent = 'Observação (opcional)';
        const noteInput = document.createElement('input');
        noteInput.type = 'text';
        noteInput.id = `cart-note-${index}`;
        noteInput.className = 'input-field cart-note-input';
        noteInput.placeholder = 'Ex.: sem cebola, bem passado…';
        noteInput.maxLength = 120;
        noteInput.value = item.note || '';
        noteInput.addEventListener('input', () => {
          setItemNote(item.name, optKey, noteInput.value, lineSignature(item));
        });
        noteWrap.append(noteLabel, noteInput);
        li.append(noteWrap);
      } else if (item.note) {
        item.note = '';
        saveCart();
      }

      const editor = buildInlineCustomization(item, li);
      if (editor) li.append(editor);

      cartItems.appendChild(li);
    });
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function cssEscape(value) {
    return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /** Selos de produto (chaves validadas em CatalogInputValidation.ProductBadges). */
  const PRODUCT_BADGES = {
    'rei-da-casa': { label: '👑 Rei da Casa', style: 'gold' },
    'mais-pedido': { label: '🔥 Mais Pedido', style: 'fire' },
    'novidade': { label: '✨ Novidade', style: 'gold' },
    'promocao': { label: '💸 Promoção', style: 'fire' },
    'para-dividir': { label: '🍟 Para Dividir', style: 'gold' },
    'vegetariano': { label: '🌱 Vegetariano', style: 'green' }
  };

  const TROCO_PRESETS = [50, 100, 200];
  let trocoChipsOtherSelected = false;

  /**
   * Estado dos botões de troco a partir dos campos reais: marca o botão escolhido e
   * desativa valores menores que o total (o troco precisa cobrir o pedido).
   */
  function syncTrocoChips() {
    const chips = document.getElementById('trocoChips');
    const check = document.getElementById('precisaTroco');
    const input = document.getElementById('trocoInput');
    const valueWrap = document.getElementById('trocoValueWrap');
    if (!chips || !check || !input) return;
    const orderTotal = calcItemsTotal() + (Number(bairroValor) || 0);
    const value = parseFloat(String(input.value || '').replace(',', '.'));
    const preset = check.checked && !trocoChipsOtherSelected && TROCO_PRESETS.includes(value) ? value : null;
    chips.querySelectorAll('[data-troco]').forEach((btn) => {
      const choice = btn.dataset.troco;
      const amount = Number(choice);
      if (Number.isFinite(amount)) btn.disabled = amount < orderTotal;
      const active = choice === 'none'
        ? !check.checked
        : choice === 'outro'
          ? check.checked && preset === null
          : preset === amount;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
    if (valueWrap) valueWrap.hidden = !check.checked || preset !== null;
  }

  function updateTotals() {
    total = calcItemsTotal();
    const finalTotal = total + (Number(bairroValor) || 0);
    const totalItems = calcItemsCount();

    const setText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    setText('totalValue', formatMoney(total));
    setText('entregaValue', formatMoney(Number(bairroValor) || 0));
    setText('finalTotal', formatMoney(finalTotal));
    setText('bottomTotalValue', `Subtotal: ${formatMoney(total)}`);
    setText('cartCount', `${totalItems} ${totalItems === 1 ? 'item' : 'itens'}`);

    const entregaRow = document.getElementById('entregaLabel')?.parentElement;
    if (entregaRow) entregaRow.hidden = isDineInFulfillment();
    syncTrocoChips();
  }

  function toggleCartTotalDetails() {
    const details = document.getElementById('cartTotalDetails');
    const btn = document.getElementById('toggleCartTotalDetails');
    if (!details || !btn) return;
    const open = details.hidden;
    details.hidden = !open;
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    btn.textContent = open ? 'Ocultar' : 'Detalhes';
  }

  function toggleCartButton() {
    const cartButton = document.getElementById('cartButton');
    const bottomMenu = document.getElementById('bottomMenu');
    const hasItems = cart.length > 0;
    if (cartButton) cartButton.classList.toggle('show', hasItems);
    if (bottomMenu) bottomMenu.classList.toggle('show', hasItems);
    document.body.classList.toggle('cart-bar-visible', hasItems);
  }

  function getPixTiming() {
    const selected = document.querySelector('input[name="pixTiming"]:checked');
    return selected ? selected.value : '';
  }

  /**
   * Sem chave Pix cadastrada a loja não consegue receber Pix: a opção some do checkout
   * (hidden + disabled, pois alguns navegadores ignoram hidden em <option>).
   */
  function syncPixPaymentOption() {
    const select = document.getElementById('formaPagamento');
    const option = select?.querySelector('option[value="Pix"]');
    if (!select || !option) return;
    const available = !!String(cfg?.pixKey || '').trim();
    option.hidden = !available;
    option.disabled = !available;
    if (!available && select.value === 'Pix') {
      select.value = '';
      updatePaymentExtras();
    }
  }

  function updatePaymentExtras() {
    const forma = document.getElementById('formaPagamento');
    const trocoWrap = document.getElementById('trocoWrap');
    const pixWrap = document.getElementById('pixWrap');
    const pixPayNowBox = document.getElementById('pixPayNowBox');
    if (!forma) return;
    const value = forma.value;
    if (trocoWrap) trocoWrap.hidden = value !== 'Dinheiro';
    if (pixWrap) pixWrap.hidden = value !== 'Pix';
    if (value === 'Dinheiro') syncTrocoChips();

    if (value === 'Pix' && cfg) {
      const keyEl = document.getElementById('pixKeyValue');
      const labelEl = document.getElementById('pixKeyLabelText');
      if (keyEl) keyEl.textContent = cfg.pixKey || '';
      if (labelEl) labelEl.textContent = (cfg.pixKeyLabel || 'telefone').toLowerCase();
    }

    const timing = getPixTiming();
    if (pixPayNowBox) {
      pixPayNowBox.hidden = value !== 'Pix' || timing !== 'now';
    }

    // Atendimento: check-out enxuto reafirma os campos ocultos (não deixa salvar pagamento exibir extras)
    if (waiterToken || staffSource) updateWaiterCheckoutUi();
  }

  function updateStoreStatusBanner() {
    const banner = document.getElementById('storeClosedBanner');
    const finalizeBtn = document.getElementById('finalizeOrderBtn');
    if (!cfg) return;
    const open = canAcceptOrders();
    const closedMsg = ordersUnavailableMessage();
    const status = storeHoursStatus();

    // Selo do cabeçalho: sempre visível (aberto, fecha em breve, pausa, fechado).
    const pill = document.getElementById('storeHoursPill');
    if (pill) {
      pill.hidden = false;
      pill.dataset.state = status.state;
      const label = pill.querySelector('.store-hours-label');
      if (label) label.textContent = status.label;
      pill.title = [status.detail, scheduleSummaryText()].filter(Boolean).join(' ');
    }

    // Aviso: fechado/pausa/pedidos pausados e também "fecha em breve" (ainda aceita pedidos).
    if (banner) {
      const showBanner = !open || status.state === 'closing';
      banner.hidden = !showBanner;
      banner.classList.toggle('is-closing', open && status.state === 'closing');
      if (showBanner) {
        const summary = status.state === 'paused' ? '' : scheduleSummaryText();
        const browseHint = open ? '' : 'Você pode explorar o cardápio e montar seu pedido.';
        banner.innerHTML =
          `<strong>${escapeHtml(status.detail || closedMsg)}</strong>` +
          (summary || browseHint
            ? `<span class="store-closed-sub">${escapeHtml([summary, browseHint].filter(Boolean).join(' '))}</span>`
            : '');
      }
    }
    if (finalizeBtn) {
      finalizeBtn.disabled = !open;
      finalizeBtn.title = open ? '' : closedMsg;
    }
  }

  function setCepLoading(loading) {
    const el = document.getElementById('cepStatus');
    if (!el) return;
    el.hidden = !loading;
    el.textContent = loading ? 'Buscando endereço…' : '';
  }

  function usesKmDelivery() {
    // Por km (taxa/km > 0) ou taxa fixa (taxa/km 0 + taxa mínima > 0): ambos cotam por distância.
    return !!(cfg && cfg.latitude != null && cfg.longitude != null
      && (Number(cfg.deliveryFeePerKm) > 0 || Number(cfg.minDeliveryFee) > 0));
  }

  function resetAddressInfo() {
    bairroNome = '';
    bairroValor = 0;
    enderecoBase = '';
    lastCep = null;
    deliveryOk = false;
    deliveryDistanceKm = null;
    if (addressFormOpen) resolvedViaCep = null;
    const info = document.getElementById('enderecoInfo');
    if (info) {
      info.style.display = 'none';
      info.textContent = '';
      info.classList.remove('endereco-info-error');
    }
    updateCheckoutVisibility();
  }

  function getCustomerStreetNumber() {
    const fromSearch = onlyDigits(document.getElementById('streetSearchNumber')?.value);
    if (fromSearch) return fromSearch;
    const type = getResidenceType();
    if (type === 'condominio') {
      const n = onlyDigits(document.getElementById('condoNumber')?.value);
      if (n) return n;
    } else if (type === 'apartamento') {
      const n = onlyDigits(document.getElementById('aptBuilding')?.value);
      if (n) return n;
    } else {
      const n = onlyDigits(document.getElementById('numeroInput')?.value);
      if (n) return n;
    }
    // Endereço salvo selecionado (form fechado): usa o número persistido
    const selected = getSelectedCustomerAddress();
    return onlyDigits(selected?.number);
  }

  function syncStreetNumberFields(number) {
    const digits = onlyDigits(number);
    if (!digits) return;
    const searchNum = document.getElementById('streetSearchNumber');
    if (searchNum) searchNum.value = digits;
    ['numeroInput', 'condoNumber', 'aptBuilding'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.value = digits;
    });
  }

  async function quoteDeliveryByKm(viaCepData, number) {
    const streetNumber = onlyDigits(number || getCustomerStreetNumber());
    const street = String(viaCepData.logradouro || '').trim();
    const res = await fetch(`${API_BASE}/api/v1/delivery/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        address: street,
        number: streetNumber || null,
        neighborhood: viaCepData.bairro,
        city: viaCepData.localidade,
        state: viaCepData.uf,
        cep: viaCepData.cep || onlyDigits(document.getElementById('cepInput')?.value)
      })
    });
    if (!res.ok) throw new Error('Falha ao calcular entrega');
    return res.json();
  }

  /** Taxa de entrega sempre arredondada para cima em múltiplos de R$ 0,50. */
  function roundUpDeliveryFee(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.ceil(n * 2) / 2;
  }

  function applyNeighborhoodDelivery(bairro) {
    const fees = cfg.deliveryFees || {};
    const wanted = String(bairro || '').trim().toLowerCase();
    const key = Object.keys(fees).find((k) => String(k).trim().toLowerCase() === wanted);
    if (!key) return false;
    const fee = Number(fees[key] || 0);
    const minFee = Number(cfg.minDeliveryFee || 0);
    bairroValor = roundUpDeliveryFee(minFee > 0 ? Math.max(fee, minFee) : fee);
    bairroNome = key;
    deliveryOk = true;
    deliveryDistanceKm = null;
    return true;
  }

  function showResolvedAddress(text, { error } = {}) {
    const enderecoInfo = document.getElementById('enderecoInfo');
    if (!enderecoInfo) return;
    enderecoInfo.textContent = text || '';
    enderecoInfo.style.display = text ? 'block' : 'none';
    enderecoInfo.classList.toggle('endereco-info-error', !!error);
  }

  function markDeliveryUnavailable(message) {
    deliveryOk = false;
    bairroValor = 0;
    deliveryDistanceKm = null;
    const base = enderecoBase || 'Endereço localizado';
    showResolvedAddress(`${base} · ${message}`, { error: true });
  }

  async function processViaCepAddress(data) {
    if (!data || data.erro) {
      alert('CEP não encontrado.');
      resetAddressInfo();
      return false;
    }

    const cepDigits = onlyDigits(data.cep);
    const cepInput = document.getElementById('cepInput');
    if (cepInput && cepDigits.length === 8) {
      cepInput.value = maskCep(cepDigits);
      lastCep = cepDigits;
    }

    const streetNumber = getCustomerStreetNumber();
    bairroNome = data.bairro || '';
    enderecoBase = streetNumber
      ? `${data.logradouro}, ${streetNumber}, ${data.bairro}, ${data.localidade} - ${data.uf}`
      : `${data.logradouro}, ${data.bairro}, ${data.localidade} - ${data.uf}`;
    resolvedViaCep = data;

    // Com entrega por km: número é obrigatório para geocode preciso da taxa.
    if (usesKmDelivery()) {
      if (!streetNumber) {
        deliveryOk = false;
        bairroValor = 0;
        deliveryDistanceKm = null;
        showResolvedAddress(
          `${data.logradouro}, ${data.bairro}, ${data.localidade} - ${data.uf} · Informe o número para calcular a taxa`,
          { error: true }
        );
        return false;
      }
      try {
        const quote = await quoteDeliveryByKm(data, streetNumber);
        if (!quote.withinRange || !quote.ok) {
          markDeliveryUnavailable(quote.error || 'Fora da área de entrega.');
          alert(quote.error || 'Não entregamos neste endereço.');
          return false;
        }
        bairroValor = roundUpDeliveryFee(quote.fee || 0);
        deliveryDistanceKm = Number(quote.distanceKm || 0);
        deliveryOk = true;
        const perKm = Number(quote.feePerKm ?? cfg.deliveryFeePerKm ?? 0);
        showResolvedAddress(
          perKm > 0
            ? `${enderecoBase} · ${deliveryDistanceKm} km × ${formatMoney(perKm)}/km · Entrega: ${formatMoney(bairroValor)}`
            : `${enderecoBase} · ${deliveryDistanceKm} km · Entrega (taxa fixa): ${formatMoney(bairroValor)}`
        );
        enrichSelectedAddressFromViaCep(data);
        return true;
      } catch (err) {
        console.error(err);
        markDeliveryUnavailable('Não foi possível calcular a taxa de entrega.');
        alert('Erro ao calcular a entrega para este CEP.');
        return false;
      }
    }

    // Sem lat/lng + taxa/km na loja: legado por bairro (só se o admin ainda não configurou km).
    if (applyNeighborhoodDelivery(bairroNome)) {
      showResolvedAddress(
        streetNumber
          ? `${enderecoBase} · Entrega: ${formatMoney(bairroValor)}`
          : `${enderecoBase} · Entrega: ${formatMoney(bairroValor)} · Confirme o número abaixo`
      );
      enrichSelectedAddressFromViaCep(data);
      return true;
    }

    markDeliveryUnavailable('Este bairro ainda não está na área de entrega.');
    alert(
      'Este endereço foi encontrado, mas o bairro não está na área de entrega. ' +
        'Se a loja usa entrega por km, configure latitude/longitude e taxa/km no painel.'
    );
    return false;
  }

  function buscarEndereco() {
    const cepInput = document.getElementById('cepInput');
    const cep = onlyDigits(cepInput && cepInput.value);
    if (cep.length > 0 && cep.length < 8) {
      setFieldError('cepFieldError', 'cepInput', 'Digite o CEP completo (8 dígitos).');
      return;
    }
    if (cep.length !== 8 || cep === lastCep) return;
    clearAddressLookupErrors();
    lastCep = cep;
    setCepLoading(true);

    fetch(`https://viacep.com.br/ws/${cep}/json/`)
      .then((response) => {
        if (!response.ok) throw new Error('Erro na requisição');
        return response.json();
      })
      .then((data) => {
        if (data?.erro) {
          setFieldError('cepFieldError', 'cepInput', 'CEP não encontrado. Confira os dígitos ou busque pela rua.');
          resetAddressInfo();
          return null;
        }
        return processViaCepAddress(data);
      })
      .catch((error) => {
        console.error('Erro ao buscar o endereço:', error);
        setFieldError('cepFieldError', 'cepInput', 'Erro ao buscar o endereço. Verifique o CEP e a conexão.');
        resetAddressInfo();
      })
      .finally(() => {
        setCepLoading(false);
        updateUI();
        saveCheckoutForm();
      });
  }

  function enrichSelectedAddressFromViaCep(data) {
    if (!selectedCustomerAddressId || addressFormOpen) return;
    const book = loadCustomerAddressBook();
    const idx = book.items.findIndex((a) => a.id === selectedCustomerAddressId);
    if (idx < 0) return;
    const cur = book.items[idx];
    if (cur.street && cur.city) return;
    book.items[idx] = {
      ...cur,
      street: data.logradouro || cur.street,
      neighborhood: data.bairro || cur.neighborhood,
      city: data.localidade || cur.city,
      state: data.uf || cur.state,
      cep: onlyDigits(data.cep || cur.cep)
    };
    saveCustomerAddressBook(book);
    renderCustomerAddresses();
  }

  /** Extrai nome da rua (remove número colado no texto, se houver). */
  function parseStreetSearchInput(raw) {
    let text = String(raw || '').trim().replace(/\s+/g, ' ');
    let number = '';
    const numMatch = text.match(/^(.*?)[,\s]+(?:n[ºo°.]?\s*)?(\d+[A-Za-z]?)\s*$/i);
    if (numMatch) {
      text = numMatch[1].trim();
      number = onlyDigits(numMatch[2]);
    }
    text = text
      .replace(/[.,;]+$/g, '')
      .replace(/^(rua|r\.|av\.?|avenida|travessa|trav\.?|alameda|al\.|estrada|rodovia)\s+/i, '')
      .trim();
    return { street: text, number };
  }

  async function fetchViaCepByStreet(uf, city, street) {
    const clean = String(street || '').trim();
    if (clean.length < 3) return [];
    const url =
      `https://viacep.com.br/ws/${encodeURIComponent(uf)}/` +
      `${encodeURIComponent(city)}/${encodeURIComponent(clean)}/json/`;
    const res = await fetch(url);
    // ViaCEP responde 400 para vírgula/número na rua — trata como sem resultado.
    if (!res.ok) return [];
    const contentType = String(res.headers.get('content-type') || '');
    if (!contentType.includes('json')) return [];
    const data = await res.json();
    if (data?.erro) return [];
    return Array.isArray(data) ? data : [];
  }

  async function searchCustomerAddressByStreet() {
    applyStoreServiceAreaToStreetSearch({ force: true });
    const uf = String(document.getElementById('streetSearchUf')?.value || '').trim().toUpperCase();
    const city = String(document.getElementById('streetSearchCity')?.value || '').trim();
    const rawQuery = String(document.getElementById('streetSearchQuery')?.value || '').trim();
    const parsed = parseStreetSearchInput(rawQuery);
    let streetNumber = onlyDigits(document.getElementById('streetSearchNumber')?.value);
    if (!streetNumber && parsed.number) {
      streetNumber = parsed.number;
      syncStreetNumberFields(streetNumber);
    }
    const results = document.getElementById('streetSearchResults');
    if (!results) return;

    clearAddressLookupErrors();
    if (!streetNumber) {
      setFieldError('streetSearchError', 'streetSearchNumber', 'Informe o número do endereço antes de buscar o CEP.');
      document.getElementById('streetSearchNumber')?.focus();
      return;
    }
    if (uf.length !== 2 || city.length < 2 || parsed.street.length < 3) {
      setFieldError('streetSearchError', 'streetSearchQuery', 'Informe o número e pelo menos 3 letras da rua. Ex.: Nº 30 · Campos Salles');
      document.getElementById('streetSearchQuery')?.classList.add('is-invalid');
      document.getElementById('streetSearchQuery')?.focus();
      return;
    }
    syncStreetNumberFields(streetNumber);

    const candidates = [];
    const pushUnique = (s) => {
      const v = String(s || '').trim();
      if (v.length >= 3 && !candidates.some((c) => c.toLowerCase() === v.toLowerCase())) {
        candidates.push(v);
      }
    };
    pushUnique(parsed.street);
    pushUnique(`Rua ${parsed.street}`);
    pushUnique(`Avenida ${parsed.street}`);

    const pickWarn = document.getElementById('streetSearchPickWarn');
    if (pickWarn) pickWarn.hidden = true;
    results.hidden = false;
    results.classList.remove('is-awaiting-pick');
    results.innerHTML = '<li class="muted">Buscando…</li>';
    try {
      let list = [];
      for (const candidate of candidates) {
        list = await fetchViaCepByStreet(uf, city, candidate);
        if (list.length) break;
      }
      if (!list.length) {
        results.classList.remove('is-awaiting-pick');
        results.innerHTML =
          '<li class="muted">Nenhum CEP encontrado. Confira o nome da rua (sem número no campo da rua).</li>';
        return;
      }
      const shown = list.slice(0, 12);
      showStreetCepPickWarning(shown.length);
      results.classList.add('is-awaiting-pick');
      results.innerHTML =
        `<li class="street-result-meta" aria-hidden="true">Toque para escolher o CEP</li>` +
        shown.map((item, idx) => {
          const line = `Nº ${streetNumber} · ${item.logradouro} — ${item.bairro}, ${item.localidade}/${item.uf}`;
          const cepLabel = maskCep(item.cep || '');
          return (
            `<li>` +
            `<button type="button" class="street-result-btn" data-idx="${idx}" aria-label="Selecionar CEP ${escapeHtml(cepLabel)}">` +
            `<span>${escapeHtml(line)}</span>` +
            `<span class="street-result-cep">CEP ${escapeHtml(cepLabel)}</span>` +
            `</button></li>`
          );
        }).join('');
      results.querySelectorAll('.street-result-btn').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = shown[Number(btn.dataset.idx)];
          if (!item) return;
          const numberNow = onlyDigits(document.getElementById('streetSearchNumber')?.value) || streetNumber;
          if (!numberNow) {
            setFieldError('streetSearchError', 'streetSearchNumber', 'Informe o número do endereço para calcular a taxa corretamente.');
            return;
          }
          clearAddressLookupErrors();
          clearStreetCepPickUi();
          syncStreetNumberFields(numberNow);
          setCepLookupMode('cep');
          setCepLoading(true);
          processViaCepAddress(item)
            .catch((e) => console.warn(e))
            .finally(() => {
              setCepLoading(false);
              updateUI();
              saveCheckoutForm();
            });
        });
      });
    } catch (err) {
      console.error(err);
      results.classList.remove('is-awaiting-pick');
      if (pickWarn) pickWarn.hidden = true;
      results.innerHTML = '<li class="muted">Erro ao buscar. Verifique a conexão e tente novamente.</li>';
    }
  }

  function validateOrder() {
    if (!canAcceptOrders()) {
      alert(ordersUnavailableMessage());
      return false;
    }
    if (cart.length === 0) {
      alert('Seu carrinho está vazio!');
      return false;
    }
    if (!fulfillmentMode) {
      alert('Escolha como prefere receber o pedido: entrega ou retirada no local.');
      return false;
    }
    if (cfg.minOrder > 0 && calcItemsTotal() < cfg.minOrder) {
      alert(`Pedido mínimo: ${formatMoney(cfg.minOrder)}.`);
      return false;
    }

    const pickup = isPickupFulfillment();
    const dineIn = isDineInFulfillment();
    const staffContext = !!waiterToken || !!staffSource;
    const skipAddress = pickup || dineIn;
    const customerAddr = skipAddress ? null : getSelectedCustomerAddress();
    if (!skipAddress) {
      if (addressFormOpen || !customerAddr) {
        alert('Selecione ou salve um endereço de entrega para continuar.');
        return false;
      }
      if (!deliveryOk || !enderecoBase) {
        alert('Por favor, informe um CEP válido da área de entrega.');
        return false;
      }
    }

    const clienteNome = document.getElementById('clienteNome').value.trim();
    const clienteTelefone = document.getElementById('clienteTelefone').value;
    const formaPagamento = document.getElementById('formaPagamento').value;
    const deliveryLines = skipAddress
      ? { address: storePickupAddress(), neighborhood: 'Retirada', reference: '', number: '', cep: '', city: cfg?.city || '', state: cfg?.state || '' }
      : buildCustomerDeliveryLines(customerAddr);

    // Consumo no local: nome conforme configuração; telefone não é exigido
    // (não há WhatsApp para a loja). Delivery/pickup continuam exigindo ambos.
    // Para o garçom o nome do cliente é sempre obrigatório.
    if (dineIn) {
      if (waiterToken && !clienteNome) {
        alert('Por favor, informe o nome do cliente para o pedido na mesa.');
        return false;
      }
      if (!waiterToken && cfg.requireCustomerNameForQrOrder && !clienteNome) {
        alert('Por favor, informe seu nome para o pedido na mesa.');
        return false;
      }
    } else if (!clienteNome || !clienteTelefone || (!staffContext && !formaPagamento) || !deliveryLines.address) {
      alert('Por favor, preencha todos os campos obrigatórios.');
      return false;
    }
    if (!dineIn && !validatePhone(clienteTelefone)) {
      alert('Por favor, insira um telefone válido com DDD (ex: (11) 98247-0496).');
      return false;
    }
    if (dineIn && clienteTelefone && !validatePhone(clienteTelefone)) {
      alert('Por favor, insira um telefone válido com DDD (ex: (11) 98247-0496).');
      return false;
    }

    if (!staffContext && formaPagamento === 'Pix' && !getPixTiming()) {
      alert(dineIn
        ? 'Selecione se deseja pagar o Pix agora ou no local.'
        : (pickup
          ? 'Selecione se deseja pagar o Pix agora ou na retirada.'
          : 'Selecione se deseja pagar o Pix agora ou na entrega.'));
      return false;
    }

    if (formaPagamento === 'Dinheiro' && !staffContext) {
      const trocoRaw = document.getElementById('trocoInput').value;
      const precisaTroco = document.getElementById('precisaTroco').checked;
      if (precisaTroco) {
        const troco = parseFloat(String(trocoRaw).replace(',', '.'));
        const finalTotal = calcItemsTotal() + (Number(bairroValor) || 0);
        if (!troco || troco < finalTotal) {
          alert(`Informe um valor para troco maior ou igual ao total (${formatMoney(finalTotal)}).`);
          return false;
        }
      }
    }

    return true;
  }

  function buildWhatsAppMessage(orderId) {
    const clienteNome = sanitizeInput(document.getElementById('clienteNome').value);
    const clienteTelefone = sanitizeInput(document.getElementById('clienteTelefone').value);
    const formaPagamento = sanitizeInput(document.getElementById('formaPagamento').value);
    const observacoes = sanitizeInput(document.getElementById('observacoesInput').value);
    const pickup = isPickupFulfillment();
    const dineIn = isDineInFulfillment();
    const noDelivery = pickup || dineIn;
    const customerAddr = noDelivery ? null : getSelectedCustomerAddress();
    const deliveryLines = noDelivery
      ? { address: dineIn ? 'Consumo no local' : storePickupAddress(), neighborhood: 'Retirada', reference: '' }
      : buildCustomerDeliveryLines(customerAddr);
    const addrLabel = customerAddr?.label
      ? ` (${sanitizeInput(customerAddr.label)})`
      : '';

    const itemsMessage = cart
      .map((item) => {
        const qty = Math.max(1, Number(item.quantity) || 1);
        const mods = Array.isArray(item.mods) ? item.mods : [];
        const removed = Array.isArray(item.removed) ? item.removed : [];
        const note = isBeverageItemName(item.name) ? '' : (item.note || '').trim();
        const hasDetail = mods.length > 0 || removed.length > 0;
        if (!hasDetail) {
          const line = `${item.quantity}x ${displayItemName(item)} — ${formatMoney(lineTotal(item))}`;
          return note ? `${line}\n   Obs.: ${note}` : line;
        }
        const addonsUnit = mods.reduce((s, m) => s + (Number(m.priceDelta) || 0), 0);
        const baseUnit = Math.max(0, (Number(item.price) || 0) - addonsUnit);
        const cleanName = item.option ? `${item.name} (${item.option})` : item.name;
        const lines = [`${qty}x ${cleanName} — ${formatMoney(baseUnit * qty)}`];
        mods.forEach((m) => {
          const delta = Number(m.priceDelta) || 0;
          lines.push(`   Adic. ${m.name}: ${delta > 0 ? formatMoney(delta * qty) : 'grátis'}`);
        });
        removed.forEach((r) => lines.push(`   Sem ${r}: grátis`));
        if (note) lines.push(`   Obs.: ${note}`);
        return lines.join('\n');
      })
      .join('\n');

    const itemsTotal = calcItemsTotal();
    const deliveryFee = noDelivery ? 0 : (Number(bairroValor) || 0);

    let pagamentoExtra = '';
    if (formaPagamento === 'Dinheiro') {
      const precisaTroco = document.getElementById('precisaTroco').checked;
      if (precisaTroco) {
        const troco = parseFloat(String(document.getElementById('trocoInput').value).replace(',', '.'));
        pagamentoExtra = `\nTroco para: ${formatMoney(troco)}`;
      } else {
        pagamentoExtra = '\nTroco: não precisa';
      }
    } else if (formaPagamento === 'Pix') {
      const timing = getPixTiming();
      if (timing === 'now') {
        pagamentoExtra =
          `\nMomento: Pagar agora` +
          `\nChave Pix (${cfg.pixKeyLabel}): ${cfg.pixKey}` +
          `\n*Envie o comprovante neste WhatsApp após o pagamento.*`;
      } else {
        pagamentoExtra = dineIn
          ? '\nMomento: Pagar no local'
          : (pickup ? '\nMomento: Pagar na retirada' : '\nMomento: Pagar na entrega');
      }
    }

    const typeLabel = pickup ? 'Retirada no local' : residenceTypeLabel(customerAddr?.residenceType);
    const feeValue = dineIn
      ? 'R$ 0,00 (consumo no local)'
      : (pickup
        ? 'R$ 0,00 (retirada)'
        : `${formatMoney(deliveryFee)}${deliveryDistanceKm != null ? ` (${deliveryDistanceKm} km)` : ''}`);
    const placeBlock = dineIn
      ? `🪑 Consumo no local · Mesa ${dineInTable?.label || ''}`
      : (pickup
        ? `🏪 Retirada no local:\n${deliveryLines.address}`
        : `🛵 Entrega${addrLabel}:\n${deliveryLines.address}\n🏷 Tipo: ${typeLabel}\n📍 Complemento/instruções: ${deliveryLines.reference || '—'}`);

    // Variáveis do modelo de mensagem (painel da loja → Loja → Mensagem WhatsApp).
    const vars = {
      loja: cfg.storeName || '',
      pedido: orderId || '',
      recebimento: dineIn ? 'Consumo no local' : (pickup ? 'Retirar no local' : 'Entrega'),
      itens: itemsMessage,
      subtotal: formatMoney(itemsTotal),
      taxa_entrega: feeValue,
      total: formatMoney(itemsTotal + deliveryFee),
      pagamento: `${formaPagamento}${pagamentoExtra}`,
      observacoes: observacoes || '',
      endereco_entrega: placeBlock,
      cliente: clienteNome || '',
      telefone: clienteTelefone || ''
    };
    const template = typeof cfg.whatsAppOrderTemplate === 'string' && cfg.whatsAppOrderTemplate.trim()
      ? cfg.whatsAppOrderTemplate
      : DEFAULT_WHATSAPP_ORDER_TEMPLATE;
    return renderWhatsAppTemplate(template, vars);
  }

  /**
   * Fallback quando a API não envia o modelo (versões antigas). Mesmo texto do
   * WhatsAppOrderTemplate.Default do catalog-api.
   */
  const DEFAULT_WHATSAPP_ORDER_TEMPLATE = [
    'Olá, {loja}!', '',
    '🛒 Pedido *{pedido}*', '📦 Recebimento: {recebimento}', '',
    '✅ Itens:', '{itens}', '',
    'Sub-total: {subtotal}', 'Taxa de Entrega: {taxa_entrega}', '🤑 Total: {total}',
    '💳 Pagamento: {pagamento}', '📝 Observações: {observacoes}', '',
    '{endereco_entrega}', '👤 Nome: {cliente}', '📞 Telefone: {telefone}', '',
    '*Aguardo confirmação!*'
  ].join('\n');

  /**
   * Substitui {variavel} pelos valores. Linhas cujas variáveis ficaram todas vazias são
   * removidas (ex.: "Observações: {observacoes}" sem observação). Variáveis desconhecidas
   * ficam como estão.
   */
  function renderWhatsAppTemplate(template, vars) {
    const pattern = /\{([a-z_]+)\}/g;
    return String(template)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .filter((line) => {
        const names = [...line.matchAll(pattern)].map((m) => m[1]).filter((n) => n in vars);
        return names.length === 0 || names.some((n) => String(vars[n] ?? '').trim() !== '');
      })
      .map((line) => line.replace(pattern, (whole, name) => (name in vars ? String(vars[name] ?? '') : whole)))
      .join('\n')
      .trim();
  }

  function openWhatsApp(message) {
    const link = `https://api.whatsapp.com/send?phone=${cfg.whatsapp}&text=${encodeURIComponent(message)}`;
    window.open(link, '_blank', 'noopener,noreferrer');
  }

  // Endereço de entrega do atendimento (Balcão/Delivery/Telefone) quando o
  // funcionário resolveu o CEP no formulário sem salvar no address book.
  function staffDeliveryAddressFromResolved() {
    const street = String(resolvedViaCep?.logradouro || '').trim() || String(enderecoBase || '').split(',')[0].trim();
    const neighborhood = String(bairroNome || resolvedViaCep?.bairro || '').trim();
    const city = String(cfg?.city || resolvedViaCep?.localidade || '').trim();
    const state = String(cfg?.state || resolvedViaCep?.uf || '').trim();
    const cep = onlyDigits(document.getElementById('cepInput')?.value || resolvedViaCep?.cep);
    return {
      street,
      number: getCustomerStreetNumber(),
      neighborhood,
      city,
      state,
      cep,
      reference: String(document.getElementById('pontoReferenciaInput')?.value || '').trim(),
      residenceType: 'casa'
    };
  }

  async function persistOrderToApi() {
    const pickup = isPickupFulfillment();
    const dineIn = isDineInFulfillment();
    const staffDelivery = (waiterToken || staffSource) && !pickup && !dineIn;
    const customerAddr = (pickup || dineIn)
      ? null
      : (getSelectedCustomerAddress() || (staffDelivery ? staffDeliveryAddressFromResolved() : null));
    const deliveryLines = (pickup || dineIn)
      ? {
          address: storePickupAddress(),
          neighborhood: 'Retirada',
          reference: 'Retirada no local',
          number: '',
          cep: '',
          city: cfg?.city || '',
          state: cfg?.state || ''
        }
      : buildCustomerDeliveryLines(customerAddr);
    const cepDigits = onlyDigits(deliveryLines.cep || customerAddr?.cep);
    const isWaiter = isDineInFulfillment() && !!waiterToken;
    const isStaff = !!waiterToken || !!staffSource;
    const forma = document.getElementById('formaPagamento').value;
    // Atendimento (garçom, Balcão, Delivery, Telefone): pagamento "Em Aberto" —
    // o método real é definido depois no painel (fechamento da mesa ou baixa).
    const paymentMethod = isStaff ? 'Em Aberto' : sanitizeInput(forma);
    const payload = {
      customerName: sanitizeInput(document.getElementById('clienteNome').value),
      customerPhone: onlyDigits(isWaiter ? '' : document.getElementById('clienteTelefone').value),
      address: dineIn ? 'Consumo no local' : (deliveryLines.address || enderecoBase || storePickupAddress()),
      neighborhood: dineIn ? 'Mesa' : (deliveryLines.neighborhood || bairroNome || (pickup ? 'Retirada' : '')),
      reference: dineIn ? (dineInTable?.label || '') : (deliveryLines.reference || ''),
      paymentMethod,
      paymentTiming: isStaff
        ? 'on_delivery'
        : (forma === 'Pix' ? (getPixTiming() || 'on_delivery') : 'on_delivery'),
      needsChange: isStaff
        ? false
        : forma === 'Dinheiro' ? !!document.getElementById('precisaTroco')?.checked : false,
      changeFor: isStaff
        ? null
        : (forma === 'Dinheiro' && document.getElementById('precisaTroco')?.checked
          ? (parseFloat(String(document.getElementById('trocoInput')?.value || '').replace(',', '.')) || null)
          : null),
      notes: sanitizeInput(document.getElementById('observacoesInput').value),
      deliveryFee: (pickup || dineIn) ? 0 : (Number(bairroValor) || 0),
      fulfillmentType: dineIn ? 'dine_in' : (pickup ? 'pickup' : 'delivery'),
      orderSource: isStaff
        ? (isWaiter ? 'waiter_panel' : (staffSource || 'admin_panel'))
        : (dineIn ? 'customer_qr' : null),
      tableId: isWaiter ? (dineInTable?.tableId || null) : null,
      tableAccessCode: (!isWaiter && dineIn) ? (dineInTable?.accessCode || null) : null,
      clientRequestId: checkoutKey || undefined,
      cep: (!pickup && !dineIn) && cepDigits.length === 8 ? cepDigits : null,
      number: (pickup || dineIn) ? null : (deliveryLines.number || customerAddr?.number || null),
      city: (pickup || dineIn) ? null : (deliveryLines.city || customerAddr?.city || null),
      state: (pickup || dineIn) ? null : (deliveryLines.state || customerAddr?.state || null),
      items: cart.map((i) => {
        const freeNote = isBeverageItemName(i.name) ? '' : (i.note || '').trim();
        const removedNote = (i.removed || []).map((r) => `Sem ${r}`).join('; ');
        const note = [removedNote, freeNote].filter(Boolean).join('; ');
        return {
          productId: i.id || null,
          name: note
            ? `${displayItemName(i)} (Obs.: ${note})`
            : displayItemName(i),
          price: Number(i.price) || 0,
          quantity: Number(i.quantity) || 0,
          modifiers: (i.mods || []).length
            ? (i.mods || []).map((m) => ({
                groupId: m.groupId,
                optionId: m.optionId,
                name: m.name,
                priceDelta: Number(m.priceDelta) || 0
              }))
            : null
        };
      })
    };

    try {
      const headers = { 'Content-Type': 'application/json' };
      if (waiterToken) headers.Authorization = `Bearer ${waiterToken}`;
      const res = await fetch(`${API_BASE}/api/v1/orders`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      if (!res.ok) {
        let detail = '';
        try {
          const errBody = await res.json();
          detail = errBody.error || errBody.title || '';
        } catch (_) { /* ignore */ }
        const err = new Error(detail || `Falha ao gravar pedido (${res.status})`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (err) {
      if (err && err.status) throw err;
      console.warn('API de pedidos indisponível; pedido segue via WhatsApp.', err);
      return null;
    }
  }

  async function fetchOrderStatus(orderId, accessToken) {
    if (!orderId || !accessToken) return null;
    try {
      const res = await fetch(
        `${API_BASE}/api/v1/orders/${encodeURIComponent(orderId)}?accessToken=${encodeURIComponent(accessToken)}`,
        {
          cache: 'no-store',
          headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' }
        }
      );
      if (!res.ok) {
        // Pedido não existe (404) ou token inválido (401/403): não há o que acompanhar —
        // o chamador encerra o tracking em vez de manter o botão preso.
        if (res.status === 404 || res.status === 401 || res.status === 403) {
          return { __trackingInvalid: true, status: res.status };
        }
        return null; // erro transitório (5xx etc.): mantém o poll
      }
      return await res.json();
    } catch (_) {
      return null; // erro de rede: mantém o poll
    }
  }

  async function finalizeOrder() {
    if (!validateOrder()) return;

    // Equipe (garçom/Balcão/Delivery/Telefone): segue direto para o checkout —
    // sem upsell de bebida. A modal fecha no fim do caminho de sucesso.
    if (!(waiterToken || staffSource) && !cartHasBeverage()) {
      showDrinkUpsellModal();
      return;
    }

    await completeOrderCheckout();
  }

  function getBeverageCategory() {
    if (!cfg || !cfg.menu) return null;
    return cfg.menu.find((c) => c.id === 'bebidas') || null;
  }

  function isBeverageItemName(name) {
    const bebidas = getBeverageCategory();
    if (!bebidas || !(bebidas.items || []).length) return false;
    return (bebidas.items || []).some((i) => i.name === name);
  }

  function cartHasBeverage() {
    const bebidas = getBeverageCategory();
    if (!bebidas || !(bebidas.items || []).length) return true;
    return cart.some((item) => isBeverageItemName(item.name));
  }

  function showDrinkUpsellModal() {
    const modal = document.getElementById('drinkUpsellModal');
    if (!modal) {
      completeOrderCheckout();
      return;
    }
    modal.style.display = 'flex';
    attachModalCloseHandlers(modal);
  }

  function goToBeveragesCategory() {
    const bebidas = getBeverageCategory();
    closeModal('drinkUpsellModal');
    closeModal('cartModal');
    if (!bebidas) return;

    activeCategory = bebidas.id;
    renderCategories();
    renderMenu();
    goToCategory(bebidas.id, false);

    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setFinalizeBusy(busy) {
    const btn = document.getElementById('finalizeOrderBtn');
    if (!btn) return;
    if (busy) {
      btn.disabled = true;
      btn.dataset.originalLabel = btn.textContent;
      btn.textContent = 'Enviando…';
    } else {
      btn.disabled = false;
      btn.textContent = btn.dataset.originalLabel || 'Finalizar Pedido';
    }
  }

  async function completeOrderCheckout() {
    if (checkoutInFlight) return;
    checkoutInFlight = true;
    if (!checkoutKey) checkoutKey = generateCheckoutKey();
    setFinalizeBusy(true);
    try {
    syncCartWithCatalog();
    if (!cart.length) {
      alert('Alguns itens do carrinho não estão mais disponíveis. Atualize o cardápio e tente de novo.');
      renderMenu();
      updateUI();
      return;
    }

    const itemsSnapshot = snapshotCartItems();
    let orderId = null;
    let accessToken = '';

    try {
      const created = await persistOrderToApi();
      if (created && created.orderId) {
        orderId = created.orderId;
        accessToken = created.accessToken || '';
        // Defensivo: o servidor é a fonte de verdade dos preços. Se o total de itens
        // divergir do carrinho local (adição não considerada, preço alterado etc.),
        // avisa sem bloquear — o pedido já foi criado.
        const serverItemsTotal = Number(created.itemsTotal);
        const localItemsTotal = Number(calcItemsTotal());
        if (Number.isFinite(serverItemsTotal) && Math.abs(serverItemsTotal - localItemsTotal) > 0.009) {
          console.warn('Total de itens divergente do servidor', {
            orderId, serverItemsTotal, localItemsTotal
          });
          showStorefrontToast('Atenção: o valor do pedido foi ajustado pela loja. Confira o total.');
        }
      }
    } catch (err) {
      if (err && err.status) {
        alert(err.message || 'Não foi possível registrar o pedido. Verifique os dados e tente novamente.');
        return;
      }
      console.warn('Falha ao gravar pedido na API', err);
    }

    // Pedido de mesa (dine-in) NÃO pode cair no fallback silencioso: o pedido
    // precisa ser persistido para entrar na fila do painel e ser acompanhado.
    // Sem confirmação da API, exibimos erro e permitimos nova tentativa.
    if (isDineInFulfillment() && !orderId) {
      alert('Não foi possível registrar o pedido da mesa. Verifique sua conexão e tente novamente.');
      return;
    }

    // Pedido de atendimento (Balcão/Delivery/Telefone) também não cai em fallback
    // WhatsApp: a origem só é registrada via API (que identifica o atendente).
    if ((waiterToken || staffSource) && !orderId) {
      alert('Não foi possível registrar o pedido. Verifique sua conexão e tente novamente.');
      return;
    }

    // Fallback só se a API estiver offline — o servidor é a fonte de verdade do ID
    if (!orderId) orderId = generateOrderId();

    // Pedido confirmado (API ou fallback): fecha o checkout NA HORA — antes do
    // pós-processamento. Um erro de renderização a seguir NÃO pode deixar a
    // modal aberta com o pedido já feito (fecha antes do pós-processamento).
    closeModal('cartModal');
    closeModal('drinkUpsellModal');

    let message = buildWhatsAppMessage(orderId);
    if (accessToken) {
      const trackLink = buildOrderTrackShareUrl(orderId, accessToken);
      message += `\n\n📱 Acompanhe seu pedido:\n${trackLink}`;
    }
    const wasPickup = isPickupFulfillment();
    const wasDineIn = isDineInFulfillment();
    const deliveryFeeSnapshot = (wasPickup || wasDineIn) ? 0 : (Number(bairroValor) || 0);
    const itemsTotalSnapshot = itemsSnapshot.reduce(
      (sum, i) => sum + (Number(i.price) || 0) * (Number(i.quantity) || 0),
      0
    );

    const isStaffOrder = !!waiterToken || !!staffSource;

    saveLastOrder({
      orderId,
      // Pedido feito pelo Telefone não deixa token de acompanhamento no
      // dispositivo do atendente: sem credenciais, a modal e o botão
      // orderTrackFab não re-exibem (o status é acompanhado no painel).
      accessToken: staffSource === 'telefone' ? '' : accessToken,
      message,
      at: Date.now(),
      // Equipe (garçom/atendimento) não acompanha pelo cardápio: o status fica no painel.
      tracking: !isStaffOrder,
      items: itemsSnapshot
    });
    if (accessToken && !isStaffOrder) saveTrackCredentials(orderId, accessToken);
    // Botão do menu aparece na hora — não depende do poll (só para acompanhamento)
    if (!isStaffOrder) showOrderTrackFab(ORDER_STATUS_FALLBACK.Created);
    try {
      sessionStorage.removeItem(REPEAT_ASKED_KEY);
    } catch (_) { /* ignore */ }

    cart = [];
    // Equipe: a barra/contagem zera AGORA, no mesmo tick do esvaziamento —
    // antes de QUALQUER pós-processamento que possa lançar e interromper o
    // caminho de sucesso. `updateTotals` é idempotente (gira por `cart`), logo
    // chamar de novo dentro de `updateUI` é inofensivo.
    try {
      updateTotals();
      toggleCartButton();
    } catch (err) {
      console.warn('[staff-cart] zero-bar no sucesso falhou', err);
    }
    // Se o storage (bloqueado/cheio no tablet PWA) recusar persistir o
    // esvaziamento, um reload NÃO pode "restaurar" o carrinho velho: o
    // `loadCart` verá a flag de sessão e forçará vazio de qualquer jeito.
    let staffStorageBlocked = false;
    try {
      localStorage.setItem(STAFF_CART_CLEARED_KEY, '1');
      localStorage.removeItem(STAFF_CART_CLEARED_KEY);
    } catch (_) {
      staffStorageBlocked = true;
    }
    if (staffStorageBlocked) {
      try { sessionStorage.setItem(STAFF_CART_CLEARED_KEY, '1'); } catch (_) { /* storage de sessão indisponível */ }
    }
    saveCart();
    // Pedido confirmado: a chave de idempotência não vale mais (se um NOVO pedido
    // for feito, recebe chave nova — assim o servidor cria outro e não devolve este).
    checkoutKey = null;
    // Mesa/atendimento em andamento continua aceitando novos pedidos: mantém o
    // contexto (fulfillmentMode, dineInTable/staffSource, waiterToken) e só limpa o carrinho.
    if (waiterToken || staffSource || wasDineIn) {
      if (wasDineIn) fulfillmentMode = 'dine_in';
      updateFulfillmentUi();
    } else {
      fulfillmentMode = null;
    }
    renderMenu();
    updateUI();

    if (isStaffOrder) {
      // Equipe segue fazendo pedidos de atendimento: SEM modal/bolha de acompanhamento.
      // O status do pedido é acompanhado no painel admin.
      const ctx = wasDineIn
        ? (tableNumberText() ? ` · Mesa ${tableNumberText()}` : '')
        : (staffSource ? ` · ${atendimentoLabel(staffSource)}` : '');
      showStorefrontToast(
        `Pedido enviado${ctx} — acompanhe o status no painel`
      );
      // Pedido de atendimento SEM mesa (Balcão/Delivery/Telefone): depois de
      // confirmar, volta ao seletor de canais (a tela exibida após o garçom
      // logar) para escolher o tipo do próximo pedido. A sessão continua viva,
      // então tocar no canal reentra sem novo login. Garçom de mesa (dine-in)
      // não é afetado: `wasDineIn` só é true no fluxo garçom de mesa — aqui a
      // chave é `staffSource` (setado por `enterStaffChannel` para Balcão/
      // Delivery/Telefone; nullable no mapa/garçom), nunca `waiterToken`, que o
      // `enterStaffChannel` também preenche para esses canais.
      if (staffSource && !wasDineIn) showMesasGate('channels');
    } else {
      const ensureTrackFab = () => {
        showOrderTrackFab(
          orderTrackCurrent
            ? orderStatusLabel(orderTrackCurrent)
            : ORDER_STATUS_FALLBACK.Created
        );
      };

      // Status na hora; WhatsApp só 3s depois
      orderTrackCurrent = {
        orderId,
        status: 'Created',
        statusLabel: ORDER_STATUS_FALLBACK.Created,
        items: itemsSnapshot.map((i) => ({
          name: displayItemName(i),
          price: Number(i.price) || 0,
          quantity: Number(i.quantity) || 0
        })),
        deliveryFee: deliveryFeeSnapshot,
        total: itemsTotalSnapshot + deliveryFeeSnapshot,
        fulfillmentType: wasDineIn ? 'dine_in' : (wasPickup ? 'pickup' : 'delivery'),
        needsChange: document.getElementById('formaPagamento')?.value === 'Dinheiro'
          ? !!document.getElementById('precisaTroco')?.checked
          : false,
        changeFor: document.getElementById('formaPagamento')?.value === 'Dinheiro'
            && document.getElementById('precisaTroco')?.checked
          ? (parseFloat(String(document.getElementById('trocoInput')?.value || '').replace(',', '.')) || null)
          : null
      };
      openOrderTrackModal({ skipRefresh: true });
      ensureTrackFab();
      // Pedido de atendimento segue direto para o painel — não dispara WhatsApp para a loja.
      if (!wasDineIn && !isStaffOrder) scheduleOrderWhatsApp(message, 3000);

      if (accessToken) {
        startOrderTracking()
          .then(() => ensureTrackFab())
          .catch(() => ensureTrackFab());
      }
    }
    } catch (err) {
      // Safeguard de robustez: um erro no pós-processamento (ex.: renderização,
      // storage) não pode deixar o pedido já feito sem feedback nem segurar a modal.
      console.error('[checkout] erro após finalizar pedido', err);
      closeModal('cartModal');
      closeModal('drinkUpsellModal');
      showStorefrontToast('Pedido enviado — acompanhe o status no painel.');
    } finally {
      checkoutInFlight = false;
      setFinalizeBusy(false);
    }
  }

  function syncVisualViewportHeight() {
    const h = (window.visualViewport && window.visualViewport.height) || window.innerHeight || 0;
    if (h > 0) {
      document.documentElement.style.setProperty('--vvh', `${h * 0.01}px`);
    }
  }

  function lockBodyScroll() {
    scrollTopWhenModalOpened = window.scrollY || document.documentElement.scrollTop;
    document.body.classList.add('modal-open');
    document.body.style.top = `-${scrollTopWhenModalOpened}px`;
    syncVisualViewportHeight();
  }

  function unlockBodyScroll() {
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, scrollTopWhenModalOpened);
  }

  function attachModalCloseHandlers(modal) {
    if (!modal || modal.__closeHandlersAttached) return;

    modal.__overlayClickHandler = function (e) {
      if (e.target === modal) closeModal(modal.id);
    };
    modal.addEventListener('click', modal.__overlayClickHandler);

    modal.__escapeHandler = function (e) {
      if (e.key === 'Escape') closeModal(modal.id);
    };
    document.addEventListener('keydown', modal.__escapeHandler);
    modal.__closeHandlersAttached = true;

    openModalCount += 1;
    if (openModalCount === 1) lockBodyScroll();
  }

  function detachModalCloseHandlers(modal) {
    if (!modal || !modal.__closeHandlersAttached) return;
    modal.removeEventListener('click', modal.__overlayClickHandler);
    document.removeEventListener('keydown', modal.__escapeHandler);
    delete modal.__overlayClickHandler;
    delete modal.__escapeHandler;
    modal.__closeHandlersAttached = false;

    openModalCount = Math.max(0, openModalCount - 1);
    if (openModalCount === 0) unlockBodyScroll();
  }

  function showCartModal() {
    updateCartTitle();
    renderCustomerAddresses();
    // Endereço só depois de escolher "Entregar no meu endereço"
    if (fulfillmentMode === 'delivery'
      && !loadCustomerAddressBook().items.length
      && !addressFormOpen) {
      openAddressForm(null);
    }
    const modal = document.getElementById('cartModal');
    if (!modal) return;
    updateUI();
    updateStoreStatusBanner();
    updatePaymentExtras();
    modal.style.display = 'flex';
    attachModalCloseHandlers(modal);
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) return;
    const wasRepeat = modalId === 'repeatOrderModal' && modal.style.display !== 'none';
    modal.style.display = 'none';
    detachModalCloseHandlers(modal);
    if (modalId === 'optionModal') pendingOptionAdd = null;
    if (modalId === 'orderTrackModal') {
      cancelScheduledOrderWhatsApp();
      // Fechar acompanhamento (ex.: após ver itens alterados) não remove o botão do cardápio
      ensureTrackFabVisible();
    }
    if (wasRepeat) {
      const last = loadLastOrder();
      markRepeatAsked(last?.orderId || '1');
    }
  }

  function openImageLightbox(url, name) {
    const modal = document.getElementById('imageLightbox');
    const imgEl = document.getElementById('imageLightboxImg');
    if (!modal || !imgEl || !url) return;
    imgEl.src = url;
    imgEl.alt = name ? `Imagem ampliada de ${name}` : '';
    modal.style.display = 'flex';
    attachModalCloseHandlers(modal);
  }

  function updateActiveCategoryButton(catId) {
    document.querySelectorAll('.category-btn').forEach((b) => {
      b.classList.toggle('active', b.dataset.cat === catId);
    });
  }

  function getMenuCategories() {
    if (!cfg || !Array.isArray(cfg.menu)) return [];
    return cfg.menu;
  }

  function getMatchingMenuItems(category) {
    const query = normalizeMenuLabel(productSearchQuery);
    return category.items.filter((item) =>
      !query || normalizeMenuLabel(`${item.name || ''} ${item.description || ''}`).includes(query)
    );
  }

  function updateProductSearch(query) {
    productSearchQuery = String(query || '').trim();
    const categories = getMenuCategories();
    if (productSearchQuery) {
      const activeCategoryHasMatches = categories.some((category) =>
        category.id === activeCategory && getMatchingMenuItems(category).length > 0
      );
      if (!activeCategoryHasMatches) {
        const firstMatchingCategory = categories.find((category) => getMatchingMenuItems(category).length > 0);
        if (firstMatchingCategory) {
          activeCategory = firstMatchingCategory.id;
          updateActiveCategoryButton(activeCategory);
        }
      }
    }
    renderMenu();
  }

  function bindProductSearch() {
    const toggle = document.getElementById('productSearchToggle');
    const panel = document.getElementById('productSearchPanel');
    const input = document.getElementById('productSearchInput');
    if (!toggle || !panel || !input) return;

    const closeSearch = () => {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      input.value = '';
      updateProductSearch('');
    };

    toggle.addEventListener('click', () => {
      if (!panel.hidden) {
        closeSearch();
        return;
      }
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      input.focus();
    });
    document.addEventListener('click', (event) => {
      if (!panel.hidden && !panel.contains(event.target) && !toggle.contains(event.target)) {
        closeSearch();
      }
    });
    input.addEventListener('input', () => updateProductSearch(input.value));
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      closeSearch();
      toggle.focus();
    });
  }

  function renderCategories() {
    const bar = document.getElementById('categoriesBar');
    if (!bar) return;
    bar.innerHTML = '';
    getMenuCategories().forEach((cat, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'category-btn';
      btn.textContent = cat.title;
      btn.dataset.cat = cat.id;
      btn.style.setProperty('--i', String(Math.min(idx, 12)));
      btn.addEventListener('click', () => goToCategory(cat.id, true));
      if (cat.id === activeCategory) btn.classList.add('active');
      bar.appendChild(btn);
    });
    setTimeout(setupCategoryNav, 30);
  }

  function isVerticalMenu() {
    return document.body.classList.contains('menu-vertical');
  }

  function buildCategoryPage(category) {
    const page = document.createElement('section');
    page.className = 'category-page';
    page.dataset.cat = category.id;
    page.id = `categoria-${category.id}`;
    page.setAttribute('aria-label', category.title);

    // Título da seção (visível só na rolagem vertical; o carrossel usa as abas).
    const heading = document.createElement('h2');
    heading.className = 'category-section-title';
    heading.textContent = category.title;
    page.appendChild(heading);

    const items = getMatchingMenuItems(category);
    items.forEach((item, idx) => {
      const card = document.createElement('div');
      card.className = 'menu-item';
      card.style.setProperty('--i', String(Math.min(idx, 10)));

      const imageUrl = resolveAssetUrl(item.imageUrl);
      if (imageUrl && !document.body.classList.contains('tenant-no-photo')) {
        const img = document.createElement('img');
        img.className = 'item-image';
        img.src = imageUrl;
        img.alt = item.name;
        img.loading = 'lazy';
        img.addEventListener('error', () => {
          const placeholder = document.createElement('div');
          placeholder.className = 'item-image item-image-placeholder';
          placeholder.dataset.text = item.name ? item.name.trim().charAt(0).toUpperCase() : '';
          img.replaceWith(placeholder);
        });
        img.addEventListener('click', () => openImageLightbox(imageUrl, item.name));
        img.setAttribute('role', 'button');
        img.tabIndex = 0;
        img.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openImageLightbox(imageUrl, item.name);
          }
        });
        card.appendChild(img);
      }

      // Selo de destaque escolhido no painel (Produtos → Selo de destaque).
      const badgeInfo = PRODUCT_BADGES[item.badge];
      if (badgeInfo) {
        const badgeEl = document.createElement('span');
        badgeEl.className = `item-badge item-badge--${badgeInfo.style}`;
        badgeEl.textContent = badgeInfo.label;
        card.appendChild(badgeEl);
        card.classList.add('has-badge');
        // Sem foto o selo não tem onde ficar por cima: o card reserva espaço no topo.
        if (!card.querySelector('.item-image')) card.classList.add('no-image');
      }

      const controls = document.createElement('div');
      controls.className = 'quantity-controls';

      const minus = document.createElement('button');
      minus.type = 'button';
      minus.className = 'minus';
      minus.setAttribute('aria-label', `Diminuir ${item.name}`);
      minus.textContent = '−';
      minus.addEventListener('click', () => changeQuantity(item.name, item.price, -1, null, item.id));

      const span = document.createElement('span');
      span.id = `quantity-${item.name}`;

      const plus = document.createElement('button');
      plus.type = 'button';
      plus.className = 'plus';
      plus.setAttribute('aria-label', `Aumentar ${item.name}`);
      plus.textContent = '+';
      plus.addEventListener('click', () => changeQuantity(item.name, item.price, 1, null, item.id));

      const cartQty = quantityOfProduct(item.name);
      span.textContent = cartQty > 0 ? String(cartQty) : '';
      span.classList.toggle('zero', cartQty === 0);
      minus.classList.toggle('minus-hidden', cartQty === 0);

      if (cartQty > 0) {
        card.classList.add('added');
        const badge = document.createElement('div');
        badge.className = 'added-badge';
        badge.setAttribute('aria-hidden', 'true');
        badge.textContent = '✓';
        card.appendChild(badge);
      }

      controls.append(minus, span, plus);

      const body = document.createElement('div');
      body.className = 'item-body';

      const title = document.createElement('strong');
      title.className = 'item-name';
      title.textContent = item.name;
      body.appendChild(title);

      const desc = String(item.description || '').trim();
      if (desc) {
        const descEl = document.createElement('p');
        descEl.className = 'item-description';
        descEl.textContent = desc;
        body.appendChild(descEl);
      }

      const price = document.createElement('span');
      price.className = 'item-price';
      if (hasPortionSizes(item)) {
        price.textContent = `Média ${formatMoney(item.priceMedia)} · Inteira ${formatMoney(item.priceInteira)}`;
      } else {
        price.textContent = formatMoney(item.price);
      }

      card.append(controls, body, price);
      page.appendChild(card);
    });

    if (productSearchQuery && items.length === 0 && isVerticalMenu()) {
      page.hidden = true; // na rolagem vertical, categorias sem resultado somem
      return page;
    }

    if (productSearchQuery && items.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'product-search-empty';
      empty.setAttribute('role', 'status');
      empty.textContent = 'Nenhum produto encontrado nesta categoria.';
      page.appendChild(empty);
    }

    return page;
  }

  function renderMenu() {
    const menu = document.getElementById('menu');
    if (!menu) return;
    const categories = getMenuCategories();
    menu.innerHTML = '';
    categories.forEach((cat) => menu.appendChild(buildCategoryPage(cat)));
    if (isVerticalMenu()) {
      if (productSearchQuery && !menu.querySelector('.category-page:not([hidden])')) {
        const empty = document.createElement('p');
        empty.className = 'product-search-empty menu-search-empty';
        empty.setAttribute('role', 'status');
        empty.textContent = 'Nenhum produto encontrado.';
        menu.appendChild(empty);
      }
    } else if (categories.length) {
      scrollToCategory(activeCategory || categories[0].id, 'auto');
    }
    updateMenuNavArrows();
    setTimeout(setupCategoryNav, 50);
  }

  function categoryPageWidth() {
    const menu = document.getElementById('menu');
    return menu ? menu.clientWidth : window.innerWidth;
  }

  function categoryIndexFor(catId) {
    const categories = getMenuCategories();
    if (!categories.length) return 0;
    const idx = categories.findIndex((c) => c.id === catId);
    return idx >= 0 ? idx : 0;
  }

  let categoryScrollSuppress = false;

  /** Altura ocupada no topo pelo cabeçalho fixo + abas de categoria grudadas. */
  function stickyTopOffset() {
    const header = document.querySelector('.barra__topo__md');
    const bar = document.querySelector('.categories-wrapper');
    return (header?.getBoundingClientRect().height || 54) + (bar?.getBoundingClientRect().height || 44) + 8;
  }

  function scrollToCategory(catId, behavior) {
    const menu = document.getElementById('menu');
    if (!menu || !getMenuCategories().length) return;
    if (isVerticalMenu()) {
      const section = menu.querySelector(`.category-page[data-cat="${cssEscape(catId)}"]`);
      if (!section) return;
      const top = section.getBoundingClientRect().top + window.scrollY - stickyTopOffset();
      categoryScrollSuppress = true;
      window.scrollTo({ top: Math.max(0, top), behavior: behavior === 'smooth' ? 'smooth' : 'auto' });
      setTimeout(() => { categoryScrollSuppress = false; }, behavior === 'smooth' ? 700 : 50);
      return;
    }
    const x = categoryIndexFor(catId) * categoryPageWidth();
    if (Math.abs(menu.scrollLeft - x) < 2) return;
    categoryScrollSuppress = true;
    menu.scrollTo({ left: x, behavior: behavior === 'smooth' ? 'smooth' : 'auto' });
    if (behavior === 'smooth') {
      setTimeout(() => {
        categoryScrollSuppress = false;
      }, 600);
    } else {
      categoryScrollSuppress = false;
    }
  }

  function goToCategory(catId, animate) {
    const categories = getMenuCategories();
    if (!categories.length) return;
    const id = categories.some((c) => c.id === catId) ? catId : categories[0].id;
    activeCategory = id;
    updateActiveCategoryButton(id);
    updateMenuNavArrows();
    scrollToCategory(id, animate ? 'smooth' : 'auto');
    const btn = document.querySelector(`.category-btn[data-cat="${id}"]`);
    if (btn) centerElementInScroll(btn);
  }

  function centerElementInScroll(el) {
    if (!el) return;
    const container = document.getElementById('categoriesBar');
    if (!container) return;
    const containerRect = container.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const offset = (elRect.left + elRect.right) / 2 - (containerRect.left + containerRect.right) / 2;
    container.scrollBy({ left: offset, behavior: 'smooth' });
  }

  function setupCategoryNav() {
    const wrapper = document.querySelector('.categories-wrapper');
    const container = document.getElementById('categoriesBar');
    if (!container || !wrapper) return;

    const isOverflowing = container.scrollWidth > container.clientWidth + 2;
    container.classList.toggle('centered', !isOverflowing);

    if (!categoryNavResizeBound) {
      categoryNavResizeBound = true;
      window.addEventListener('resize', debounce(() => setTimeout(setupCategoryNav, 80), 80));
    }
  }

  function setupMenuSwipe() {
    const menu = document.getElementById('menu');
    if (!menu) return;

    const dragHint = document.getElementById('menuDragHint');
    const navPrev = document.getElementById('menuNavPrev');
    const navNext = document.getElementById('menuNavNext');

    let drag = null;
    let suppressClick = false;

    menu.addEventListener('pointerdown', (e) => {
      if (isVerticalMenu()) return;
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      drag = { startX: e.clientX, startY: e.clientY, startScroll: menu.scrollLeft, moved: false };
    });

    window.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (!drag.moved) {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          drag = null;
          return;
        }
        drag.moved = true;
        try {
          menu.setPointerCapture(e.pointerId);
        } catch (_) { /* ignore */ }
        menu.classList.add('dragging');
      }
      menu.scrollLeft = drag.startScroll - dx;
      if (dragHint) {
        dragHint.classList.toggle('drag-left', dx < 0);
        dragHint.classList.toggle('drag-right', dx > 0);
        dragHint.classList.add('show');
        dragHint.style.left = `${e.clientX}px`;
        dragHint.style.top = `${e.clientY}px`;
      }
    });

    const endDrag = () => {
      if (!drag) return;
      if (drag.moved) {
        suppressClick = true;
        setTimeout(() => {
          suppressClick = false;
        }, 0);
        menu.classList.remove('dragging');
        if (dragHint) {
          dragHint.classList.remove('show', 'drag-left', 'drag-right');
        }
      }
      drag = null;
    };

    window.addEventListener('pointerup', endDrag);
    window.addEventListener('pointercancel', endDrag);

    menu.addEventListener(
      'click',
      (e) => {
        if (suppressClick) {
          e.preventDefault();
          e.stopPropagation();
        }
      },
      true
    );

    let recenterTimer = null;
    const syncActiveCategoryFromScroll = () => {
      const categories = getMenuCategories();
      if (categoryScrollSuppress || !categories.length) return;
      const w = categoryPageWidth();
      if (w <= 0) return;
      const pos = menu.scrollLeft;
      const idx = Math.round(pos / w);
      if (Math.abs(pos - idx * w) > 12) return;
      const cat = categories[idx];
      if (cat && cat.id !== activeCategory) {
        activeCategory = cat.id;
        updateActiveCategoryButton(cat.id);
        updateMenuNavArrows();
      }
      if (recenterTimer) clearTimeout(recenterTimer);
      recenterTimer = setTimeout(() => {
        const btn = document.querySelector(`.category-btn[data-cat="${activeCategory}"]`);
        if (btn) centerElementInScroll(btn);
      }, 120);
    };

    menu.addEventListener('scroll', syncActiveCategoryFromScroll, { passive: true });
    menu.addEventListener('scrollend', () => {
      categoryScrollSuppress = false;
      syncActiveCategoryFromScroll();
    });

    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      if (!getMenuCategories().length) return;
      e.preventDefault();
      stepCategory(e.key === 'ArrowRight' ? 1 : -1);
    });

    if (navPrev) {
      navPrev.addEventListener('click', () => stepCategory(-1));
    }
    if (navNext) {
      navNext.addEventListener('click', () => stepCategory(1));
    }

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const onResize = debounce(() => {
      if (isVerticalMenu()) return;
      scrollToCategory(activeCategory, reducedMotion ? 'auto' : 'smooth');
      updateMenuNavArrows();
    }, 120);

    // Rolagem vertical: a aba ativa segue a seção visível no topo.
    let verticalRecenter = null;
    const syncActiveCategoryFromPageScroll = () => {
      if (!isVerticalMenu() || categoryScrollSuppress) return;
      // Seção "ativa": a que cruza a linha logo abaixo das abas fixas (scroll spy).
      const line = stickyTopOffset() + 40;
      const sections = [...menu.querySelectorAll('.category-page:not([hidden])')];
      let current = null;
      for (const section of sections) {
        const rect = section.getBoundingClientRect();
        if (rect.top <= line && rect.bottom > line) { current = section.dataset.cat; break; }
        if (rect.top <= line) current = section.dataset.cat; // passou da linha (entre seções)
      }
      // No fim da página, a última seção é a ativa mesmo que não alcance o topo.
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom && sections.length) current = sections[sections.length - 1].dataset.cat;
      if (!current) current = sections[0]?.dataset.cat || null;
      if (current && current !== activeCategory) {
        activeCategory = current;
        updateActiveCategoryButton(current);
        if (verticalRecenter) clearTimeout(verticalRecenter);
        verticalRecenter = setTimeout(() => {
          const btn = document.querySelector(`.category-btn[data-cat="${activeCategory}"]`);
          if (btn) centerElementInScroll(btn);
        }, 120);
      }
    };
    window.addEventListener('scroll', syncActiveCategoryFromPageScroll, { passive: true });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
  }

  function stepCategory(direction) {
    const categories = getMenuCategories();
    if (!categories.length) return;
    const idx = categoryIndexFor(activeCategory);
    const next = direction > 0 ? Math.min(idx + 1, categories.length - 1) : Math.max(idx - 1, 0);
    if (next === idx) return;
    goToCategory(categories[next].id, true);
  }

  function updateMenuNavArrows() {
    const prev = document.getElementById('menuNavPrev');
    const next = document.getElementById('menuNavNext');
    if (!prev || !next) return;
    const categories = getMenuCategories();
    const idx = categoryIndexFor(activeCategory);
    const hasPrev = categories.length > 1 && idx > 0;
    const hasNext = categories.length > 1 && idx < categories.length - 1;
    prev.setAttribute('aria-hidden', hasPrev ? 'false' : 'true');
    next.setAttribute('aria-hidden', hasNext ? 'false' : 'true');
  }

  function setupStickyCategories() {
    const wrapper = document.querySelector('.categories-wrapper');
    if (!wrapper) return;
    const headerHeight =
      parseInt(getComputedStyle(document.documentElement).getPropertyValue('--header-height'), 10) || 54;
    let threshold = wrapper.getBoundingClientRect().top + window.scrollY - headerHeight;

    function checkSticky() {
      wrapper.classList.toggle('is-stuck', window.scrollY >= threshold);
    }

    window.addEventListener('scroll', debounce(checkSticky, 50), { passive: true });
    window.addEventListener(
      'resize',
      debounce(() => {
        threshold = wrapper.getBoundingClientRect().top + window.scrollY - headerHeight;
        checkSticky();
      }, 80)
    );
    checkSticky();
  }

  function copyTextToClipboard(text) {
    const value = String(text || '');
    if (!value) return Promise.reject(new Error('Chave Pix vazia'));

    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      return navigator.clipboard.writeText(value);
    }

    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = value;
      ta.setAttribute('readonly', '');
      ta.setAttribute('aria-hidden', 'true');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.width = '1px';
      ta.style.height = '1px';
      ta.style.padding = '0';
      ta.style.border = 'none';
      ta.style.outline = 'none';
      ta.style.boxShadow = 'none';
      ta.style.background = 'transparent';
      ta.style.opacity = '0';
      document.body.appendChild(ta);

      const range = document.createRange();
      range.selectNodeContents(ta);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      ta.focus();
      ta.select();
      ta.setSelectionRange(0, value.length);

      let ok = false;
      try {
        ok = document.execCommand('copy');
      } catch (_) {
        ok = false;
      }

      if (selection) selection.removeAllRanges();
      document.body.removeChild(ta);

      if (ok) resolve();
      else reject(new Error('Falha ao copiar'));
    });
  }

  function flashCopyPixButton(btn, ok) {
    if (!btn) return;
    const original = btn.dataset.label || btn.textContent || 'Copiar chave';
    btn.dataset.label = original;
    btn.textContent = ok ? 'Copiado!' : 'Não foi possível copiar';
    clearTimeout(btn._copyTimer);
    btn._copyTimer = setTimeout(() => {
      btn.textContent = original;
    }, ok ? 1800 : 2200);
  }

  function bindEvents() {
    document.getElementById('colorSchemeToggle')?.addEventListener('click', toggleColorScheme);
    // Botão "Copiar chave Pix" do acompanhamento (o card é re-renderizado a cada atualização).
    document.getElementById('orderTrackDetails')?.addEventListener('click', async (event) => {
      const btn = event.target.closest('[data-ot-copy-pix]');
      if (!btn) return;
      event.preventDefault();
      const pixKey = String(cfg?.pixKey || '').trim();
      try {
        await copyTextToClipboard(pixKey);
        const feedbackMs = 1800;
        orderTrackPixCopiedUntil = Date.now() + feedbackMs;
        const current = document.querySelector('#orderTrackDetails [data-ot-copy-pix]') || btn;
        current.textContent = 'Copiado!';
        setTimeout(() => {
          const latest = document.querySelector('#orderTrackDetails [data-ot-copy-pix]');
          if (latest && Date.now() >= orderTrackPixCopiedUntil) latest.textContent = 'Copiar chave Pix';
        }, feedbackMs + 50);
      } catch (_) {
        // Sem acesso à área de transferência: seleciona a chave para cópia manual.
        const keyEl = btn.closest('.ot-pix')?.querySelector('.ot-pix-key');
        if (keyEl && window.getSelection) {
          const range = document.createRange();
          range.selectNodeContents(keyEl);
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        }
        flashCopyPixButton(btn, false);
      }
    });
    setupMenuSwipe();
    bindProductSearch();
    document.getElementById('addAddressBtn')?.addEventListener('click', () => openAddressForm(null));
    document.getElementById('saveAddressBtn')?.addEventListener('click', saveAddressFromForm);
    document.getElementById('cancelAddressBtn')?.addEventListener('click', () => {
      if (!loadCustomerAddressBook().items.length) {
        alert('Salve pelo menos um endereço para continuar o pedido.');
        return;
      }
      closeAddressForm();
      if (selectedCustomerAddressId) selectCustomerAddress(selectedCustomerAddressId, { silent: true });
      updateUI();
    });
    document.querySelectorAll('input[name="residenceType"]').forEach((radio) => {
      radio.addEventListener('change', syncResidenceFields);
    });
    document.querySelectorAll('.cep-mode-tab').forEach((btn) => {
      btn.addEventListener('click', () => setCepLookupMode(btn.dataset.cepMode || 'cep'));
    });
    document.getElementById('streetSearchBtn')?.addEventListener('click', () => {
      searchCustomerAddressByStreet().catch((e) => console.warn(e));
    });
    document.getElementById('streetSearchQuery')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        searchCustomerAddressByStreet().catch((err) => console.warn(err));
      }
    });
    const streetUf = document.getElementById('streetSearchUf');
    if (streetUf) {
      streetUf.addEventListener('input', () => {
        streetUf.value = streetUf.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
      });
    }

    const cepInput = document.getElementById('cepInput');
    if (cepInput) {
      cepInput.addEventListener('input', () => {
        cepInput.value = maskCep(cepInput.value);
        const digits = onlyDigits(cepInput.value);
        if (digits.length < 8) {
          if (digits.length === 0) clearAddressLookupErrors();
          if (addressFormOpen && (deliveryOk || enderecoBase)) {
            resetAddressInfo();
            updateTotals();
          }
          return;
        }
        clearAddressLookupErrors();
        if (addressFormOpen) buscarEndereco();
      });
      cepInput.addEventListener('blur', () => {
        if (addressFormOpen) buscarEndereco();
      });
    }
    document.getElementById('streetSearchNumber')?.addEventListener('input', () => {
      setFieldError('streetSearchError', 'streetSearchNumber', '');
    });
    document.getElementById('streetSearchQuery')?.addEventListener('input', () => {
      document.getElementById('streetSearchQuery')?.classList.remove('is-invalid');
      const err = document.getElementById('streetSearchError');
      if (err && !document.getElementById('streetSearchNumber')?.classList.contains('is-invalid')) {
        err.hidden = true;
      }
    });

    const phoneInput = document.getElementById('clienteTelefone');
    if (phoneInput) {
      phoneInput.addEventListener('input', () => {
        phoneInput.value = maskPhone(phoneInput.value);
        saveCheckoutFormDebounced();
      });
    }

    const recalculateDeliveryForNumber = debounce(() => {
      if (!addressFormOpen || !resolvedViaCep) return;
      const n = getCustomerStreetNumber();
      if (!n) {
        if (usesKmDelivery()) {
          deliveryOk = false;
          bairroValor = 0;
          deliveryDistanceKm = null;
          const base = `${resolvedViaCep.logradouro}, ${resolvedViaCep.bairro}, ${resolvedViaCep.localidade} - ${resolvedViaCep.uf}`;
          showResolvedAddress(`${base} · Informe o número para calcular a taxa`, { error: true });
          updateUI();
        }
        return;
      }
      setCepLoading(true);
      processViaCepAddress(resolvedViaCep)
        .catch((e) => console.warn(e))
        .finally(() => {
          setCepLoading(false);
          updateUI();
          saveCheckoutForm();
        });
    }, 400);

    ['streetSearchNumber', 'numeroInput', 'condoNumber', 'aptBuilding'].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener('input', () => {
        el.value = onlyDigits(el.value);
        if (id === 'streetSearchNumber') syncStreetNumberFields(el.value);
        else {
          const searchNum = document.getElementById('streetSearchNumber');
          if (searchNum && el.value) searchNum.value = el.value;
        }
        recalculateDeliveryForNumber();
      });
    });

    ['clienteNome', 'observacoesInput', 'trocoInput'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', saveCheckoutFormDebounced);
        el.addEventListener('change', saveCheckoutForm);
        if (id === 'clienteNome') {
          el.addEventListener('input', updateCartTitle);
        }
      }
    });

    const forma = document.getElementById('formaPagamento');
    if (forma) {
      forma.addEventListener('change', () => {
        updatePaymentExtras();
        saveCheckoutForm();
      });
    }

    document.querySelectorAll('input[name="pixTiming"]').forEach((radio) => {
      radio.addEventListener('change', () => {
        updatePaymentExtras();
        saveCheckoutForm();
      });
    });

    const precisaTroco = document.getElementById('precisaTroco');
    const trocoInput = document.getElementById('trocoInput');
    if (precisaTroco && trocoInput) {
      precisaTroco.addEventListener('change', () => {
        trocoInput.disabled = !precisaTroco.checked;
        if (!precisaTroco.checked) trocoInput.value = '';
        saveCheckoutForm();
        syncTrocoChips();
      });
      trocoInput.addEventListener('input', syncTrocoChips);
    }

    // Troco rápido: os botões preenchem a caixa "Preciso de troco" e o valor.
    document.getElementById('trocoChips')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-troco]');
      if (!btn || btn.disabled || !precisaTroco || !trocoInput) return;
      const choice = btn.dataset.troco;
      if (choice === 'none') {
        precisaTroco.checked = false;
        trocoInput.value = '';
        trocoInput.disabled = true;
      } else {
        precisaTroco.checked = true;
        trocoInput.disabled = false;
        trocoChipsOtherSelected = choice === 'outro';
        trocoInput.value = choice === 'outro' ? '' : choice;
      }
      if (choice !== 'outro') trocoChipsOtherSelected = false;
      saveCheckoutForm();
      syncTrocoChips();
      if (choice === 'outro') trocoInput.focus();
    });

    const copyPixBtn = document.getElementById('copyPixBtn');
    if (copyPixBtn) {
      copyPixBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        const key = (cfg && cfg.pixKey)
          || document.getElementById('pixKeyValue')?.textContent
          || '';
        const pixKey = String(key).trim();
        if (!pixKey) {
          alert('Chave Pix não configurada.');
          return;
        }
        try {
          await copyTextToClipboard(pixKey);
          flashCopyPixButton(copyPixBtn, true);
        } catch (_) {
          try {
            // Último recurso: selecionar o texto exibido para o cliente copiar manualmente
            const keyEl = document.getElementById('pixKeyValue');
            if (keyEl && window.getSelection) {
              const range = document.createRange();
              range.selectNodeContents(keyEl);
              const selection = window.getSelection();
              selection.removeAllRanges();
              selection.addRange(range);
            }
          } catch (__) { /* ignore */ }
          flashCopyPixButton(copyPixBtn, false);
          alert(`Copie a chave Pix manualmente:\n${pixKey}`);
        }
      });
    }

    document.getElementById('fulfillmentDeliveryBtn')?.addEventListener('click', () => {
      setFulfillmentMode('delivery');
    });
    document.getElementById('fulfillmentPickupBtn')?.addEventListener('click', () => {
      setFulfillmentMode('pickup');
    });

    document.getElementById('cartButton')?.addEventListener('click', showCartModal);
    document.getElementById('toggleCartTotalDetails')?.addEventListener('click', toggleCartTotalDetails);
    document.getElementById('continueShoppingBtn')?.addEventListener('click', () => {
      saveCheckoutForm();
      closeModal('cartModal');
    });
    document.getElementById('finalizeOrderBtn')?.addEventListener('click', () => {
      finalizeOrder();
    });
    document.getElementById('drinkUpsellYesBtn')?.addEventListener('click', goToBeveragesCategory);
    document.getElementById('drinkUpsellNoBtn')?.addEventListener('click', () => {
      closeModal('drinkUpsellModal');
      completeOrderCheckout();
    });
    document.getElementById('repeatOrderYesBtn')?.addEventListener('click', acceptRepeatLastOrder);
    document.getElementById('repeatOrderNoBtn')?.addEventListener('click', declineRepeatLastOrder);
    document.getElementById('installAppYesBtn')?.addEventListener('click', () => {
      acceptInstallApp().catch(() => {});
    });
    document.getElementById('installAppBarClose')?.addEventListener('click', hideInstallAppBar);

    document.getElementById('orderTrackShareWhatsApp')?.addEventListener('click', () => {
      shareOrderTrackWhatsApp().catch(() => {});
    });
    document.getElementById('orderTrackCopyLink')?.addEventListener('click', () => {
      shareOrderTrackLink().catch(() => {});
    });
    document.getElementById('orderTrackFab')?.addEventListener('click', () => {
      if (waiterToken || staffSource) {
        // Equipe não acompanha no cardápio — status fica no painel.
        document.getElementById('orderTrackFab')?.setAttribute('hidden', '');
        return;
      }
      openOrderTrackModal();
    });
    document.getElementById('orderTrackConfirmBtn')?.addEventListener('click', () => {
      confirmOrderReceived().catch(() => {});
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') onOrderTrackVisibilityResume();
    });
    window.addEventListener('pageshow', onOrderTrackVisibilityResume);
    window.addEventListener('focus', onOrderTrackVisibilityResume);

    document.querySelectorAll('[data-close-modal]').forEach((btn) => {
      btn.addEventListener('click', () => closeModal(btn.getAttribute('data-close-modal')));
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('SW não registrado:', err);
    });
  }

  function trackPageview() {
    if (IS_THEME_PREVIEW) return; // prévia do painel não conta como acesso ao cardápio
    try {
      const path = `${location.pathname || '/'}${location.search || ''}` || '/';
      fetch(`${API_BASE}/api/v1/analytics/pageview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
        keepalive: true,
        mode: 'cors'
      }).catch(() => {});
    } catch (_) { /* analytics nunca bloqueia a UI */ }
  }

  syncVisualViewportHeight();
  window.addEventListener('resize', syncVisualViewportHeight, { passive: true });
  window.addEventListener('orientationchange', () => {
    setTimeout(syncVisualViewportHeight, 120);
  }, { passive: true });
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', syncVisualViewportHeight, { passive: true });
    window.visualViewport.addEventListener('scroll', syncVisualViewportHeight, { passive: true });
  }

  document.addEventListener('DOMContentLoaded', async () => {
    syncVisualViewportHeight();
    loadCart();
    bindEvents();
    setupStickyCategories();
    registerServiceWorker();
    trackPageview();

    try {
      await loadFromApi();
      if (document.body.classList.contains('store-is-inactive')) return;
      loadCheckoutForm();
      renderCategories();
      renderMenu();
      renderStoreHero();
      updateUI();
      updateStoreStatusBanner();
      // Horário muda com o relógio (abre, fecha, pausa): reavalia sem esperar a API.
      setInterval(updateStoreStatusBanner, 30_000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) updateStoreStatusBanner();
      });
      showInstallAppBar();
      await resolveTableFromQuery();
      // /login é tela de atendimento explícita. Com sessão válida (exp do JWT =
      // WaiterSessionHours da loja, definido no Painel) o refresh volta direto à
      // tela de canais; só pede credenciais de novo se não houver sessão ou se
      // o JWT tiver expirado.
      if (isLoginRequested()) {
        await restoreLoginGateSession();
      } else if (!isDineInFulfillment()) {
        if (!resolveAtendimentoFromQuery()) tryRestoreStaffSession();
        if (!staffSource) await tryRestoreWaiterSession();
      }
      bindMesasEvents();
      if (isLoginRequested() && !isDineInFulfillment()) {
        showMesasGate((mesasAuthToken || waiterToken) ? 'channels' : 'login');
      }
      const fromLink = await resumeOrderTrackingFromQuery();
      // Sessão de equipe (garçom/atendimento) não acompanha pedidos no cardápio
      // digital (o status fica no painel) — pula auto-open de tracking.
      const hasActiveOrder = !(waiterToken || staffSource) && (fromLink || (await startOrderTracking()));
      setInterval(async () => {
        try {
          const res = await fetch(`${API_BASE}/api/v1/store`, { cache: 'no-store' });
          if (res.ok && cfg) {
            const prevName = cfg.storeName;
            const store = await res.json();
            if (store.active === false) {
              showStoreInactive(store.storeName);
              return;
            }
            applyStoreConfigFields(store);
            if (store.storeName && store.storeName !== prevName) {
              updatePwaManifestFromStore().catch(() => {});
              const title = document.getElementById('storeTitle');
              if (title) title.textContent = (cfg.storeName || 'Fabin Lanches').toUpperCase();
              document.title = `${cfg.storeName} — Cardápio Delivery`;
            }
            const pixKeyEl = document.getElementById('pixKeyValue');
            if (pixKeyEl) pixKeyEl.textContent = cfg.pixKey || '';
            const pixLabelEl = document.getElementById('pixKeyLabelText');
            if (pixLabelEl) pixLabelEl.textContent = (cfg.pixKeyLabel || 'telefone').toLowerCase();
          }
        } catch (_) { /* ignore */ }
        updateStoreStatusBanner();
      }, 60_000);
      if (!hasActiveOrder) {
        const gate = document.getElementById('mesasGate');
        if (!gate || gate.hidden) {
          setTimeout(() => {
            maybePromptRepeatLastOrder();
          }, 350);
        }
      }
    } catch (err) {
      console.error(err);
      setStatus(
        `Não foi possível carregar o cardápio da API (${API_BASE}). Suba o gateway/catalog-api e recarregue.`,
        true
      );
      showInstallAppBar();
    }
  });

  window.FabinLanches = {
    changeQuantity,
    isStoreOpen,
    formatMoney,
    reload: loadFromApi
  };
})();
