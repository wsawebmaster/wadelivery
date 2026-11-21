(function () {
  const API = (window.API_BASE_URL || 'http://localhost:5100').replace(/\/$/, '');
  const TOKEN_KEY = 'delivery-admin-token';
  const ROLE_KEY = 'delivery-admin-role';
  const USER_KEY = 'delivery-admin-user';
  const DEV_SESSION_KEY = 'delivery-admin-dev-session';
  const DEV_PROFILES = {
    admin: { username: 'admin', password: 'admin123', label: 'Admin' },
    atendimento: { username: 'atendimento', password: 'atendimento123', label: 'Atendimento' }
  };

  let token = '';
  let userRole = '';
  let username = '';
  let switchedProfile = null;
  let devSnapshot = null;
  let catalog = { categories: [] };
  let publicCatalogPromise = null;
  let ingredients = [];
  let productCategoryFilter = null;
  let productSearch = '';
  let categorySearch = '';
  let ingredientSearch = '';
  let opcionalSearch = '';
  let editingCategoryId = null;
  let editingIngredientId = null;
  let editingOpcionalId = null;
  let editingProductId = null;
  let productFormBaseline = null;
  let productOpcionais = [];
  let productPrincipalIds = [];
  let modifierIdSeq = 0;
  let pendingProductImageBlob = null;
  let pendingProductImageUrl = null;
  let bgRemovalModulePromise = null;
  let productImageProcessSeq = 0;
  let productImageProcessing = false;
  let creatingIngredientFromProduct = false;
  let orders = [];
  let orderFilter = 'Created';
  let fulfillmentFilter = 'all'; // all | delivery | pickup | dine_in
  let ordersPollTimer = null;
  let ordersRefreshSeq = 0;
  let activeTab = 'orders';
  let knownOrderIds = new Set();
  let mesaAutoPrintedOrders = new Set();
  let ordersHydrated = false;
  let titleFlashTimer = null;
  let newOrderAlertTimer = null;
  let pinSession = null; // { sessionId, expiresAt } — sessão de PIN validada
  let pinHasPin = null;  // null = desconhecido, true = PIN definido, false = sem PIN
  let slaAlertTimer = null;
  let knownSlaAlertIds = new Set();
  let slaSirenNodes = [];
  let alertsMutedUntil = 0;
  let alertsMuteTimer = null;
  let storeConfig = { averageDeliveryMinutes: 40 };
  let originalDocumentTitle = document.title;
  const ORDERS_POLL_MS = 4000;
  const ORDERS_POLL_SSE_MS = 20000;
  const DASHBOARD_POLL_MS = 30000;
  const NEW_ORDER_ALERT_MS = 3500;
  const ALERTS_SNOOZE_MS = 2 * 60 * 1000;
  let ordersSseAbort = null;
  let ordersSseConnected = false;
  let dashboardPollTimer = null;
  const ADMIN_PREFS_KEY = 'delivery-admin-prefs';
  const DEFAULT_ADMIN_PREFS = {
    receiptWidthMm: '80',
    receiptBold: true,
    receiptLineHeight: 1.35,
    receiptZoom: 100,
    receiptEscpos: false,
    receiptEscposChars: 0,
    receiptUsbDevice: null,
    receiptPrinterMode: 'windows',
    receiptSerialBaud: 9600,
    receiptSerialPort: null,
    receiptFooter: '',
    receiptShowAddress: true,
    receiptShowItemNotes: true,
    receiptShowPayment: true,
    receiptShowSeparators: true,
    newOrderVolume: 70,
    slaVolume: 90,
    // true: tenta tocar mesmo com a aba em segundo plano (quando o browser permitir)
    playSoundWhenHidden: true,
    desktopNotify: true,
    autoPrintOnConfirm: false,
    autoPrintMesaOnConfirm: false,
    slaWarnPercent: 70,
    slaDangerPercent: 90
  };
  let adminPrefs = { ...DEFAULT_ADMIN_PREFS };
  const STATUS_ACTION = {
    Created: 'Confirmar pedido',
    Accepted: 'Iniciar preparação',
    Preparing: 'Saiu para entrega',
    OutForDelivery: 'Marcar como finalizado',
    ReadyForPickup: 'Marcar como finalizado',
    ReadyForTable: 'Entregue na mesa'
  };
  const ORDER_FILTER_LABELS = {
    Created: { one: 'Aguardando Confirmação', many: 'Aguardando Confirmações' },
    Accepted: { one: 'Confirmado', many: 'Confirmados' },
    Preparing: { one: 'Em preparação', many: 'Em preparação' },
    OutForDelivery: { one: 'Saiu para entrega', many: 'Saíram para entrega' },
    ReadyForPickup: { one: 'Disponível para retirada', many: 'Disponíveis para retirada' },
    ReadyForTable: { one: 'Disponível para mesa', many: 'Disponíveis para mesa' },
    deliveredDineIn: { one: 'Entregue na mesa', many: 'Entregues na mesa' },
    overdue: { one: 'Em atraso', many: 'Em atraso' },
    Delivered: { one: 'Finalizado', many: 'Finalizados' },
    Cancelled: { one: 'Cancelado', many: 'Cancelados' },
    all: { one: 'Total', many: 'Total' }
  };
  /** Abas da grade de pedidos sempre visíveis, mesmo com contagem zero. */
  const ORDER_FILTER_DEFAULTS = new Set(['Created', 'all']);
  /** Sequência operacional do board (sem "Todos"). */
  const ORDER_FILTER_SEQUENCE = [
    'Created',
    'Accepted',
    'Preparing',
    'OutForDelivery',
    'ReadyForPickup',
    'ReadyForTable',
    'Delivered',
    'Cancelled'
  ];

  function isPickupOrder(order) {
    return String(order?.fulfillmentType || '').toLowerCase() === 'pickup';
  }

  function isDineInOrder(order) {
    return String(order?.fulfillmentType || '').toLowerCase() === 'dine_in';
  }

  // Pedido registrado no Balcão (retirada na loja): não depende de endereço/CEP,
  // então não exibe Bairro/Endereço no card de acompanhamento.
  function isBalcaoOrder(order) {
    return String(order?.orderSource || '').toLowerCase() === 'balcao';
  }

  function orderSourceLabel(order) {
    const src = String(order?.orderSource || '').toLowerCase();
    // Papel do criador snapshotado no pedido (JWT) — diferencia garçom que pediu
    // pelo cardápio (/login) do atendente que pediu pela topbar do painel.
    const roleKey = String(order?.createdByRole || '').trim().toLowerCase().replace('ç', 'c');
    const isGarcomRole = roleKey === 'garcom';
    if (src === 'customer_qr') return 'Cliente (QR)';
    if (src === 'waiter_panel') return isGarcomRole ? 'Mesa (garçom)' : 'Garçom (painel)';
    if (src === 'admin_panel') return 'Admin (painel)';
    if (src === 'balcao') return isGarcomRole ? 'Balcão (garçom)' : 'Balcão (painel)';
    if (src === 'telefone') return isGarcomRole ? 'Telefone (garçom)' : 'Telefone (painel)';
    if (src === 'delivery') return 'Delivery (painel)';
    // Pedidos do storefront (cliente comum) não enviam orderSource: deriva do fulfillment.
    const ful = String(order?.fulfillmentType || '').toLowerCase();
    if (ful === 'delivery') return 'Delivery (site)';
    if (ful === 'pickup') return 'Retirada (site)';
    return order?.orderSource || '—';
  }

  // Origem de pedido registrado pela equipe (garçom/atendimento).
  function orderSourceIsStaff(order) {
    const src = order?.orderSource;
    return src === 'waiter_panel' || src === 'admin_panel' || src === 'balcao' || src === 'delivery' || src === 'telefone';
  }

  // Rótulo no recibo/impressão: mesa → "GARCOM"; Balcão/Delivery/Telefone → "ATENDENTE".
  function attendantReceiptLabel(order) {
    const src = order?.orderSource;
    return (src === 'waiter_panel' || src === 'admin_panel') ? 'GARCOM:' : 'ATENDENTE:';
  }

  function statusActionLabel(order) {
    if (order?.status === 'Accepted' && isQuickMesaDeliver(order)) {
      return 'Entregues na mesa';
    }
    if (isDineInOrder(order) && order?.status === 'Accepted') {
      console.info('[Mesa fast-deliver] avaliado', {
        orderId: order.orderId,
        role: userRole,
        catalogCategories: Array.isArray(catalog.categories) ? catalog.categories.length : 0,
        bebidas: beverageCatalogNames().length,
        isQuickMesaDeliver: isQuickMesaDeliver(order)
      });
    }
    if (order?.status === 'Preparing') {
      if (isDineInOrder(order)) return 'Disponível para mesa';
      if (isPickupOrder(order)) return 'Disponível para retirada';
      return 'Saiu para entrega';
    }
    return STATUS_ACTION[order?.status] || (order?.nextStatusLabel
      ? `Avançar para ${order.nextStatusLabel}`
      : 'Avançar');
  }
  const CANCEL_REASON_PRESETS = [
    { code: 'customer_request', label: 'A pedido do cliente', customerRequested: true },
    { code: 'item_unavailable', label: 'Item indisponível / sem estoque', customerRequested: false },
    { code: 'store_unable', label: 'Loja sem condições de preparar no momento', customerRequested: false },
    { code: 'delivery_issue', label: 'Problema com entrega ou endereço fora da área', customerRequested: false },
    { code: 'payment_issue', label: 'Problema com o pagamento', customerRequested: false },
    { code: 'duplicate', label: 'Pedido duplicado', customerRequested: false },
    { code: 'other', label: 'Outro motivo', customerRequested: false }
  ];
  const ORDER_STATUS_RANK = Object.fromEntries(ORDER_FILTER_SEQUENCE.map((s, i) => [s, i]));
  const chartInstances = {};
  let dashboardPeriod = 'today';
  let lastDashboardData = null;
  let platformStores = [];
  let editingPlatformStoreId = null;
  let platformDuplicateSourceId = null;

  const WEEK_DAYS = [
    { value: 0, label: 'Dom' },
    { value: 1, label: 'Seg' },
    { value: 2, label: 'Ter' },
    { value: 3, label: 'Qua' },
    { value: 4, label: 'Qui' },
    { value: 5, label: 'Sex' },
    { value: 6, label: 'Sáb' }
  ];

  function ensureScheduleDayRows() {
    const box = $('scheduleDays');
    if (!box) return;
    if (box.dataset.ready !== '1') {
      box.innerHTML = WEEK_DAYS.map((d) =>
        `<div class="schedule-day-row" data-day="${d.value}">
           <label class="sdr-day"><input type="checkbox" class="sdr-enabled" data-day="${d.value}" /> ${d.label}</label>
           <span class="sdr-hours">
             <input type="time" class="sdr-open" value="11:00" />
             <span class="sdr-sep">–</span>
             <input type="time" class="sdr-close" value="23:55" />
           </span>
           <label class="sdr-break-toggle"><input type="checkbox" class="sdr-break" /> Intervalo</label>
           <span class="sdr-break-window">
             <input type="time" class="sdr-break-start" />
             <span class="sdr-sep">–</span>
             <input type="time" class="sdr-break-end" />
           </span>
         </div>`
      ).join('');
      box.dataset.ready = '1';
    }
    if (box.dataset.listeners !== '1') {
      box.addEventListener('change', syncScheduleRowState);
      box.addEventListener('change', syncAutoClosedMessagePreview);
      box.addEventListener('input', syncAutoClosedMessagePreview);
      box.dataset.listeners = '1';
    }
    syncScheduleRowState();
  }

  function syncScheduleRowState() {
    document.querySelectorAll('#scheduleDays .schedule-day-row').forEach((row) => {
      const enabled = row.querySelector('.sdr-enabled').checked;
      row.classList.toggle('disabled', !enabled);
      const breakCb = row.querySelector('.sdr-break');
      breakCb.disabled = !enabled;
      const breakOn = enabled && breakCb.checked;
      row.querySelectorAll('.sdr-hours input, .sdr-break-window input').forEach((el) => {
        el.disabled = !enabled;
      });
      row.querySelectorAll('.sdr-break-window input').forEach((el) => {
        el.disabled = !breakOn;
      });
    });
  }

  function readPerDayFromForm() {
    const perDay = [];
    document.querySelectorAll('#scheduleDays .schedule-day-row').forEach((row) => {
      const day = Number(row.dataset.day);
      const enabled = row.querySelector('.sdr-enabled').checked;
      const breakEnabled = enabled && row.querySelector('.sdr-break').checked;
      perDay.push({
        day,
        enabled,
        open: row.querySelector('.sdr-open').value || '11:00',
        close: row.querySelector('.sdr-close').value || '23:55',
        breakEnabled,
        breakStart: breakEnabled ? (row.querySelector('.sdr-break-start').value || '') : '',
        breakEnd: breakEnabled ? (row.querySelector('.sdr-break-end').value || '') : '',
        deliveryMinutes: null
      });
    });
    return perDay;
  }

  function isAutoClosedMessage(text) {
    const t = String(text || '').trim();
    if (!t) return true;
    return /funcionamos/i.test(t) || /\d{1,2}:\d{2}/.test(t);
  }

  function formatScheduleDaysText(days) {
    const names = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
    const sorted = [...new Set((days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (!sorted.length) return 'em dias não definidos';
    if (sorted.length === 7) return 'todos os dias';
    if (sorted.length === 1) return names[sorted[0]];
    let contiguous = true;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] !== sorted[i - 1] + 1) { contiguous = false; break; }
    }
    if (contiguous) return `de ${names[sorted[0]]} a ${names[sorted[sorted.length - 1]]}`;
    const labels = sorted.map((d) => names[d]);
    const last = labels.pop();
    return `${labels.join(', ')} e ${last}`;
  }

  function formatScheduleDaysShort(days) {
    const labels = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const sorted = [...new Set((days || []).map(Number).filter((d) => d >= 0 && d <= 6))].sort((a, b) => a - b);
    if (!sorted.length) return 'sem dias';
    if (sorted.length === 7) return 'todos os dias';
    let contiguous = true;
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] !== sorted[i - 1] + 1) { contiguous = false; break; }
    }
    if (contiguous && sorted.length > 1) {
      return `${labels[sorted[0]]}–${labels[sorted[sorted.length - 1]]}`;
    }
    return sorted.map((d) => labels[d]).join(', ');
  }

  function groupScheduleDaysByHours(enabledDays) {
    const groups = [];
    for (const d of enabledDays) {
      const g = groups.find((x) => x.open === d.open && x.close === d.close);
      if (g) g.days.push(d.day);
      else groups.push({ open: d.open, close: d.close, days: [d.day] });
    }
    return groups;
  }

  function buildAutoClosedMessageFromPerDay(perDay) {
    const enabled = (perDay || []).filter((d) => d.enabled).sort((a, b) => a.day - b.day);
    if (!enabled.length) return 'Estamos fechados no momento.';
    const daysText = formatScheduleDaysText(enabled.map((d) => d.day));
    const groups = groupScheduleDaysByHours(enabled);
    const hoursText = groups.length === 1
      ? `das ${groups[0].open} às ${groups[0].close}`
      : groups.map((g) => `${formatScheduleDaysText(g.days)} das ${g.open} às ${g.close}`).join('; ');
    return `Estamos fechados no momento. Funcionamos ${daysText}, ${hoursText}.`;
  }

  function syncAutoClosedMessagePreview() {
    const input = $('scheduleClosedMessage');
    if (!input || !isAutoClosedMessage(input.value)) return;
    input.value = buildAutoClosedMessageFromPerDay(readPerDayFromForm());
  }

  function fillStoreForm(store) {
    ensureScheduleDayRows();
    $('storeName').value = store.storeName || '';
    $('whatsapp').value = store.whatsapp || '';
    $('pixKey').value = store.pixKey || '';
    $('pixKeyLabel').value = store.pixKeyLabel || '';
    $('logoUrl').value = store.logoUrl || '';
    if ($('iconUrl')) $('iconUrl').value = store.iconUrl || '';
    updateStoreIconUi(store.iconUrl || '');
    $('storeCep').value = maskCep(store.cep || '');
    const apiNumber = String(store.addressNumber || '').trim();
    const currentNumber = String($('storeNumber').value || '').trim();
    if (apiNumber || !currentNumber) {
      $('storeNumber').value = apiNumber;
    }
    $('storeAddress').value = store.address || '';
    if ($('storeCity')) {
      $('storeCity').value = store.city
        || parseCityStateFromAddress(store.address).city
        || 'Ribeirão Preto';
    }
    if ($('storeState')) {
      $('storeState').value = (store.state
        || parseCityStateFromAddress(store.address).state
        || 'SP').toUpperCase();
    }
    $('storeLat').value = store.latitude != null ? store.latitude : '';
    $('storeLng').value = store.longitude != null ? store.longitude : '';
    storeConfig = store || storeConfig;
    updateDineInUi();
    $('deliveryFeePerKm').value = store.deliveryFeePerKm != null ? store.deliveryFeePerKm : 0;
    $('minDeliveryFee').value = store.minDeliveryFee != null ? store.minDeliveryFee : 0;
    $('maxDeliveryKm').value = store.maxDeliveryKm != null ? store.maxDeliveryKm : 0;
    if ($('autoAdvancePreparing')) $('autoAdvancePreparing').checked = !!store.autoAdvancePreparing;
    if ($('autoAdvancePreparingMinutes')) {
      const minutes = Number(store.autoAdvancePreparingMinutes);
      $('autoAdvancePreparingMinutes').value = minutes >= 1 ? minutes : 5;
    }
    if ($('dineInEnabled')) $('dineInEnabled').checked = !!store.dineInEnabled;
    if ($('useTablesEnabled')) {
      $('useTablesEnabled').checked = !!store.dineInEnabled;
    }
    if ($('tableCount')) {
      const n = Number(store.tableCount);
      $('tableCount').value = n >= 1 ? n : 4;
      updateTablesUsageUi();
    }
    if ($('waiterSessionHours')) {
      const h = Number(store.waiterSessionHours);
      $('waiterSessionHours').value = h >= 1 ? h : 8;
    }
    if ($('sessionExpireInfo')) {
      const payload = decodeJwtPayload(token);
      if (payload && payload.exp) {
        const diffMs = payload.exp * 1000 - Date.now();
        if (diffMs > 0) {
          const hrs = Math.floor(diffMs / 3600000);
          const min = Math.floor((diffMs % 3600000) / 60000);
          const expTime = new Date(payload.exp * 1000).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
          $('sessionExpireInfo').textContent = `Sessão garçom expira às ${expTime} (${hrs}h ${min}min restantes)`;
        } else {
          $('sessionExpireInfo').textContent = 'Sessão expirada';
        }
      } else {
        $('sessionExpireInfo').textContent = '';
      }
    }
    if ($('customerQrOrdersEnabled')) $('customerQrOrdersEnabled').checked = !!store.customerQrOrdersEnabled;
    if ($('waiterOrdersEnabled')) $('waiterOrdersEnabled').checked = !!store.waiterOrdersEnabled;
    if ($('allowManualTableEntry')) $('allowManualTableEntry').checked = !!store.allowManualTableEntry;
    if ($('requireCustomerNameForQrOrder')) $('requireCustomerNameForQrOrder').checked = !!store.requireCustomerNameForQrOrder;
    if ($('allowCustomerChooseWaiter')) $('allowCustomerChooseWaiter').checked = !!store.allowCustomerChooseWaiter;
    applyAdminPrefsToForm();
    fillBreadOptions(store.breadOptions);
    const cepStatus = $('storeCepStatus');
    if (cepStatus) cepStatus.textContent = '';

    const schedule = store.schedule || {};
    const perDay = Array.isArray(schedule.perDay) && schedule.perDay.length ? schedule.perDay : [];
    document.querySelectorAll('#scheduleDays .schedule-day-row').forEach((row) => {
      const day = Number(row.dataset.day);
      const pd = perDay.find((p) => Number(p.day) === day);
      row.querySelector('.sdr-enabled').checked = pd ? !!pd.enabled : false;
      row.querySelector('.sdr-open').value = (pd && pd.open) || schedule.open || '11:00';
      row.querySelector('.sdr-close').value = (pd && pd.close) || schedule.close || '23:55';
      row.querySelector('.sdr-break').checked = !!pd?.breakEnabled;
      row.querySelector('.sdr-break-start').value = pd?.breakStart || '';
      row.querySelector('.sdr-break-end').value = pd?.breakEnd || '';
    });
    const weekVal = perDay.filter((p) => p.day >= 0 && p.day <= 4)
      .map((p) => p.deliveryMinutes).find((v) => v != null);
    const weekendVal = perDay.filter((p) => p.day >= 5)
      .map((p) => p.deliveryMinutes).find((v) => v != null);
    if ($('deliveryMinutesWeek')) $('deliveryMinutesWeek').value = weekVal != null ? weekVal : '';
    if ($('deliveryMinutesWeekend')) $('deliveryMinutesWeekend').value = weekendVal != null ? weekendVal : '';
    syncScheduleRowState();
    $('scheduleClosedMessage').value = schedule.closedMessage || '';
  }

  function resolveAssetUrl(path) {
    const raw = String(path || '').trim();
    if (!raw) return '';
    if (/^https?:\/\//i.test(raw) || raw.startsWith('data:')) return raw;
    return `${API}${raw.startsWith('/') ? raw : `/${raw}`}`;
  }

  const DEFAULT_STORE_ICON_DATA_URI =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8D%94%3C/text%3E%3C/svg%3E";

  function defaultStoreIconUrl() {
    return DEFAULT_STORE_ICON_DATA_URI;
  }

  function updateStoreIconUi(iconUrl) {
    const resolved = resolveAssetUrl(iconUrl) || defaultStoreIconUrl();
    const preview = $('storeIconPreview');
    if (preview) {
      preview.src = resolved;
      preview.hidden = false;
      preview.onerror = () => {
        preview.src = defaultStoreIconUrl();
      };
      wireImageZoom(preview, 'Logo da loja');
    }
    applyDocumentIcon(resolved);
  }

  function applyDocumentIcon(href) {
    const url = href || defaultStoreIconUrl();
    const isSvgData = url.startsWith('data:image/svg+xml');
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.type = isSvgData ? 'image/svg+xml' : 'image/png';
    link.href = url;
    let apple = document.querySelector('link[rel="apple-touch-icon"]');
    if (!apple) {
      apple = document.createElement('link');
      apple.rel = 'apple-touch-icon';
      document.head.appendChild(apple);
    }
    apple.href = url.startsWith('data:')
      ? new URL('assets/icons/icon.svg', window.location.href).href
      : url;
  }

  function fillBreadOptions(options) {
    const defaults = [
      { id: 'pao-frances', label: 'Pão francês', available: true },
      { id: 'pao-hamburguer', label: 'Pão hambúrguer', available: true }
    ];
    const list = Array.isArray(options) && options.length ? options : defaults;
    const byId = new Map(
      list.map((o) => {
        const id = String(o.id || o.Id || '').toLowerCase();
        return [id, o];
      }).filter(([id]) => id)
    );

    document.querySelectorAll('#breadOptionsBox input[data-bread-id]').forEach((input) => {
      const id = String(input.dataset.breadId || '').toLowerCase();
      const found = byId.get(id);
      const available = found
        ? (found.available ?? found.Available) !== false
        : true;
      input.checked = available;
      if (available) input.setAttribute('checked', 'checked');
      else input.removeAttribute('checked');
      const label = found && (found.label || found.Label);
      if (label) input.dataset.breadLabel = label;
    });
  }

  function readBreadOptionsFromForm() {
    return Array.from(document.querySelectorAll('#breadOptionsBox input[data-bread-id]')).map((input) => {
      const labelEl = input.closest('label');
      const labelText = (input.dataset.breadLabel
        || (labelEl ? labelEl.textContent : '')
        || input.dataset.breadId
        || '').replace(/\s+/g, ' ').trim();
      return {
        id: input.dataset.breadId,
        label: labelText,
        available: !!input.checked
      };
    });
  }

  function onlyDigits(value) {
    return String(value || '').replace(/\D/g, '');
  }

  function maskCep(value) {
    const d = onlyDigits(value).slice(0, 8);
    if (d.length <= 5) return d;
    return `${d.slice(0, 5)}-${d.slice(5)}`;
  }

  function parseCityStateFromAddress(address) {
    const raw = String(address || '');
    const m = raw.match(/,\s*([^,]+)\s*-\s*([A-Za-z]{2})\s*$/);
    if (!m) return { city: '', state: '' };
    return { city: m[1].trim(), state: m[2].trim().toUpperCase() };
  }

  function composeStoreAddress(data, numero) {
    const num = String(numero || '').trim();
    const street = data.street || data.logradouro || '';
    const neighborhood = data.neighborhood || data.bairro || '';
    const city = data.city || data.localidade || '';
    const state = data.state || data.uf || '';
    const baseStreet = num && street ? `${street}, ${num}` : street;
    return [baseStreet, neighborhood, city && state ? `${city} - ${state}` : (city || state)]
      .filter(Boolean)
      .join(', ');
  }

  let lastStoreCep = null;
  let lastCepData = null;

  function applyCoords(lat, lng) {
    if (lat == null || lng == null || lat === '' || lng === '') return false;
    const latN = Number(lat);
    const lngN = Number(lng);
    if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return false;
    if (latN === 0 && lngN === 0) return false;
    $('storeLat').value = latN;
    $('storeLng').value = lngN;
    return true;
  }

  function normalizeCepPayload(data) {
    return {
      street: data.street || data.address || data.logradouro || '',
      neighborhood: data.neighborhood || data.district || data.bairro || '',
      city: data.city || data.localidade || '',
      state: data.state || data.uf || '',
      lat: data.lat ?? data.latitude ?? data.location?.coordinates?.latitude,
      lng: data.lng ?? data.longitude ?? data.location?.coordinates?.longitude
    };
  }

  async function buscarCepLoja() {
    const cepInput = $('storeCep');
    const status = $('storeCepStatus');
    const geoStatus = $('geocodeStoreStatus');
    const cep = onlyDigits(cepInput && cepInput.value);
    if (cep.length !== 8) return;
    if (cep === lastStoreCep && lastCepData) {
      applyCepDataToStore(lastCepData);
      if (applyCoords(lastCepData.lat, lastCepData.lng)) {
        if (status) status.textContent = 'Endereço e coordenadas obtidos pelo CEP.';
        if (geoStatus) geoStatus.textContent = `Coordenadas: ${lastCepData.lat}, ${lastCepData.lng}`;
      }
      return;
    }

    if (status) status.textContent = 'Buscando CEP e coordenadas…';
    try {
      // AwesomeAPI: endereço + lat/lng juntos (BrasilAPI v2 costuma vir sem coordenadas)
      const res = await fetch(`https://cep.awesomeapi.com.br/json/${cep}`);
      if (!res.ok) throw new Error('CEP não encontrado.');
      const raw = await res.json();
      if (raw.status === 400 || raw.code === 'invalid') throw new Error('CEP não encontrado.');
      const data = normalizeCepPayload(raw);
      lastStoreCep = cep;
      lastCepData = data;
      applyCepDataToStore(data);

      if (applyCoords(data.lat, data.lng)) {
        if (status) status.textContent = 'Endereço e coordenadas obtidos pelo CEP.';
        if (geoStatus) geoStatus.textContent = `Coordenadas: ${data.lat}, ${data.lng}`;
      } else {
        if (status) status.textContent = 'Endereço ok. Buscando coordenadas…';
        await geocodeStoreAddress();
      }
    } catch (err) {
      try {
        const res = await fetch(`https://viacep.com.br/ws/${cep}/json/`);
        if (!res.ok) throw new Error('Erro na requisição do CEP');
        const raw = await res.json();
        if (raw.erro) throw new Error('CEP não encontrado.');
        const data = normalizeCepPayload(raw);
        lastStoreCep = cep;
        lastCepData = data;
        applyCepDataToStore(data);
        if (status) status.textContent = 'Endereço via ViaCEP. Buscando coordenadas…';
        await geocodeStoreAddress();
      } catch (fallbackErr) {
        lastStoreCep = null;
        lastCepData = null;
        if (status) status.textContent = fallbackErr.message || err.message || 'Falha ao buscar CEP';
        throw fallbackErr;
      }
    }
  }

  function applyCepDataToStore(data) {
    const numero = $('storeNumber').value.trim();
    $('storeAddress').value = composeStoreAddress(data, numero);
    const city = data.city || data.localidade || '';
    const state = (data.state || data.uf || '').toUpperCase();
    if ($('storeCity') && city) $('storeCity').value = city;
    if ($('storeState') && state) $('storeState').value = state;
  }

  function rebuildStoreAddressFromCepCache() {
    if (!lastCepData) return;
    applyCepDataToStore(lastCepData);
  }

  function readScheduleFromForm() {
    const perDay = readPerDayFromForm();
    const enabled = perDay.filter((d) => d.enabled).sort((a, b) => a.day - b.day);
    const uniqueDays = enabled.map((d) => d.day);
    const first = enabled[0];
    const open = first ? first.open : '11:00';
    const close = first ? first.close : '23:55';

    const weekRaw = parseInt($('deliveryMinutesWeek')?.value || '', 10);
    const weekendRaw = parseInt($('deliveryMinutesWeekend')?.value || '', 10);
    const week = Number.isFinite(weekRaw) && weekRaw >= 0 ? weekRaw : null;
    const weekend = Number.isFinite(weekendRaw) && weekendRaw >= 0 ? weekendRaw : null;
    const perDayFinal = perDay.map((d) => ({
      ...d,
      deliveryMinutes: d.day >= 0 && d.day <= 4 ? week : weekend
    }));

    const autoMessage = buildAutoClosedMessageFromPerDay(perDayFinal);
    const custom = ($('scheduleClosedMessage')?.value || '').trim();
    const closedMessage = isAutoClosedMessage(custom) ? autoMessage : custom;
    if ($('scheduleClosedMessage') && isAutoClosedMessage(custom)) {
      $('scheduleClosedMessage').value = autoMessage;
    }
    return {
      days: uniqueDays,
      open,
      close,
      closedMessage,
      perDay: perDayFinal
    };
  }

  const $ = (id) => document.getElementById(id);

  function isPlatformDev() {
    return /^dev$/i.test(String(userRole || '').trim());
  }

  function isStoreAdmin() {
    return /^(admin|adminloja)$/i.test(String(userRole || '').trim());
  }

  function canSeeOrders() {
    return isStoreAdmin() || /^(atendimento|garçom)$/i.test(String(userRole || '').trim());
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampFloat(value, min, max, fallback) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function loadAdminPrefs() {
    try {
      const raw = localStorage.getItem(ADMIN_PREFS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      adminPrefs = {
        ...DEFAULT_ADMIN_PREFS,
        ...(parsed && typeof parsed === 'object' ? parsed : {})
      };
    } catch (_) {
      adminPrefs = { ...DEFAULT_ADMIN_PREFS };
    }
    adminPrefs.receiptWidthMm = adminPrefs.receiptWidthMm === '58' ? '58' : '80';
    adminPrefs.receiptBold = adminPrefs.receiptBold !== false;
    adminPrefs.receiptLineHeight = clampFloat(adminPrefs.receiptLineHeight, 1.0, 2.0, 1.35);
    adminPrefs.receiptZoom = clampInt(adminPrefs.receiptZoom, 70, 150, 100);
    adminPrefs.receiptEscpos = !!adminPrefs.receiptEscpos;
    adminPrefs.receiptEscposChars = clampInt(adminPrefs.receiptEscposChars, 0, 42, 0);
    adminPrefs.receiptUsbDevice = (typeof EscPosPrinter !== 'undefined'
      ? EscPosPrinter.normalizeSaved(adminPrefs.receiptUsbDevice)
      : null);
    // v173: melhorou para "modo de impressão direto" (serial / usb / windows).
    // Migra receiptEscpos (antigo booleano) para receiptPrinterMode.
    {
      const mode = adminPrefs.receiptPrinterMode;
      if (mode !== 'serial' && mode !== 'usb' && mode !== 'windows') {
        adminPrefs.receiptPrinterMode = adminPrefs.receiptEscpos ? 'usb' : 'windows';
      }
      adminPrefs.receiptPrinterMode = (['serial', 'usb', 'windows'].includes(adminPrefs.receiptPrinterMode))
        ? adminPrefs.receiptPrinterMode
        : 'windows';
      adminPrefs.receiptEscpos = adminPrefs.receiptPrinterMode !== 'windows';
      adminPrefs.receiptSerialBaud = [9600, 19200, 38400].includes(Number(adminPrefs.receiptSerialBaud))
        ? Number(adminPrefs.receiptSerialBaud)
        : 9600;
      adminPrefs.receiptSerialPort = (typeof SerialPosPrinter !== 'undefined'
        ? SerialPosPrinter.normalizeSaved(adminPrefs.receiptSerialPort)
        : null);
    }
    adminPrefs.receiptFooter = String(adminPrefs.receiptFooter || '').trim();
    adminPrefs.receiptShowAddress = adminPrefs.receiptShowAddress !== false;
    adminPrefs.receiptShowItemNotes = adminPrefs.receiptShowItemNotes !== false;
    adminPrefs.receiptShowPayment = adminPrefs.receiptShowPayment !== false;
    adminPrefs.receiptShowSeparators = adminPrefs.receiptShowSeparators !== false;
    adminPrefs.newOrderVolume = clampInt(adminPrefs.newOrderVolume, 0, 100, 70);
    adminPrefs.slaVolume = clampInt(adminPrefs.slaVolume, 0, 100, 90);
    adminPrefs.slaWarnPercent = clampInt(adminPrefs.slaWarnPercent, 1, 100, 70);
    adminPrefs.slaDangerPercent = clampInt(adminPrefs.slaDangerPercent, 1, 100, 90);
    if (adminPrefs.slaWarnPercent > adminPrefs.slaDangerPercent) {
      adminPrefs.slaWarnPercent = Math.max(1, adminPrefs.slaDangerPercent - 1);
    }
    // v80: padrão passou a ser tocar com aba oculta (antes salvava false sem o usuário escolher)
    if (!adminPrefs.soundPrefsVersion || adminPrefs.soundPrefsVersion < 2) {
      adminPrefs.playSoundWhenHidden = true;
      adminPrefs.soundPrefsVersion = 2;
      try { localStorage.setItem(ADMIN_PREFS_KEY, JSON.stringify(adminPrefs)); } catch (_) { /* ignore */ }
    } else {
      adminPrefs.playSoundWhenHidden = !!adminPrefs.playSoundWhenHidden;
    }
    adminPrefs.desktopNotify = adminPrefs.desktopNotify !== false;
    adminPrefs.autoPrintOnConfirm = !!adminPrefs.autoPrintOnConfirm;
    adminPrefs.autoPrintMesaOnConfirm = !!adminPrefs.autoPrintMesaOnConfirm;
    return adminPrefs;
  }

  function saveAdminPrefs(next) {
    const merged = { ...adminPrefs, ...(next || {}) };
    try {
      localStorage.setItem(ADMIN_PREFS_KEY, JSON.stringify(merged));
    } catch (_) { /* ignore */ }
    loadAdminPrefs();
    applyAdminPrefsToForm();
    const widthSelect = $('receiptWidthSelect');
    if (widthSelect) widthSelect.value = adminPrefs.receiptWidthMm;
    if (typeof applyReceiptWidth === 'function') applyReceiptWidth(adminPrefs.receiptWidthMm);
    return adminPrefs;
  }

  function applyAdminPrefsToForm() {
    if ($('slaWarnPercent')) $('slaWarnPercent').value = String(adminPrefs.slaWarnPercent);
    if ($('slaDangerPercent')) $('slaDangerPercent').value = String(adminPrefs.slaDangerPercent);
    if ($('newOrderVolume')) $('newOrderVolume').value = String(adminPrefs.newOrderVolume);
    if ($('slaVolume')) $('slaVolume').value = String(adminPrefs.slaVolume);
    if ($('playSoundWhenHidden')) $('playSoundWhenHidden').checked = !!adminPrefs.playSoundWhenHidden;
    if ($('desktopNotifyPref')) $('desktopNotifyPref').checked = !!adminPrefs.desktopNotify;
    if ($('autoPrintOnConfirm')) $('autoPrintOnConfirm').checked = !!adminPrefs.autoPrintOnConfirm;
    if ($('autoPrintMesaOnConfirm')) $('autoPrintMesaOnConfirm').checked = !!adminPrefs.autoPrintMesaOnConfirm;
    if ($('receiptBold')) $('receiptBold').checked = !!adminPrefs.receiptBold;
    if ($('receiptFooter')) $('receiptFooter').value = adminPrefs.receiptFooter;
    if ($('receiptLineHeight')) $('receiptLineHeight').value = String(adminPrefs.receiptLineHeight);
    if ($('receiptZoom')) $('receiptZoom').value = String(adminPrefs.receiptZoom);
    if ($('receiptEscpos')) $('receiptEscpos').checked = !!adminPrefs.receiptEscpos;
    if ($('receiptEscposChars')) $('receiptEscposChars').value = String(adminPrefs.receiptEscposChars);
    if ($('receiptSerialBaud')) $('receiptSerialBaud').value = String(adminPrefs.receiptSerialBaud);
    if ($('receiptShowAddress')) $('receiptShowAddress').checked = !!adminPrefs.receiptShowAddress;
    if ($('receiptShowItemNotes')) $('receiptShowItemNotes').checked = !!adminPrefs.receiptShowItemNotes;
    if ($('receiptShowPayment')) $('receiptShowPayment').checked = !!adminPrefs.receiptShowPayment;
    if ($('receiptShowSeparators')) $('receiptShowSeparators').checked = !!adminPrefs.receiptShowSeparators;
    if ($('receiptWidthSettings')) $('receiptWidthSettings').value = adminPrefs.receiptWidthMm || '80';
    updateReceiptDeviceInfo();
    refreshReceiptTestState();
    refreshReceiptPrinterSelect();
    if ($('rceBold')) $('rceBold').checked = !!adminPrefs.receiptBold;
    if ($('rceFooter')) $('rceFooter').value = adminPrefs.receiptFooter;
    if ($('rceLineHeight')) $('rceLineHeight').value = String(adminPrefs.receiptLineHeight);
    if ($('rceZoom')) $('rceZoom').value = String(adminPrefs.receiptZoom);
    if ($('rceEscpos')) $('rceEscpos').checked = !!adminPrefs.receiptEscpos;
    if ($('rceShowSep')) $('rceShowSep').checked = !!adminPrefs.receiptShowSeparators;
    if ($('rceShowAddr')) $('rceShowAddr').checked = !!adminPrefs.receiptShowAddress;
    if ($('rceShowNotes')) $('rceShowNotes').checked = !!adminPrefs.receiptShowItemNotes;
    if ($('rceShowPay')) $('rceShowPay').checked = !!adminPrefs.receiptShowPayment;
  }

  function readAdminPrefsFromForm() {
    return {
      slaWarnPercent: clampInt($('slaWarnPercent')?.value, 1, 100, adminPrefs.slaWarnPercent),
      slaDangerPercent: clampInt($('slaDangerPercent')?.value, 1, 100, adminPrefs.slaDangerPercent),
      newOrderVolume: clampInt($('newOrderVolume')?.value, 0, 100, adminPrefs.newOrderVolume),
      slaVolume: clampInt($('slaVolume')?.value, 0, 100, adminPrefs.slaVolume),
      playSoundWhenHidden: !!$('playSoundWhenHidden')?.checked,
      desktopNotify: !!$('desktopNotifyPref')?.checked,
      autoPrintOnConfirm: !!$('autoPrintOnConfirm')?.checked,
      autoPrintMesaOnConfirm: !!$('autoPrintMesaOnConfirm')?.checked,
      receiptBold: !!$('receiptBold')?.checked,
      receiptFooter: String($('receiptFooter')?.value || '').trim(),
      receiptLineHeight: clampFloat($('receiptLineHeight')?.value, 1.0, 2.0, adminPrefs.receiptLineHeight),
      receiptZoom: clampInt($('receiptZoom')?.value, 70, 150, adminPrefs.receiptZoom),
      receiptEscpos: !!$('receiptEscpos')?.checked,
      receiptEscposChars: clampInt($('receiptEscposChars')?.value, 0, 42, adminPrefs.receiptEscposChars),
      receiptShowAddress: !!$('receiptShowAddress')?.checked,
      receiptShowItemNotes: !!$('receiptShowItemNotes')?.checked,
      receiptShowPayment: !!$('receiptShowPayment')?.checked,
      receiptShowSeparators: !!$('receiptShowSeparators')?.checked,
      receiptWidthMm: adminPrefs.receiptWidthMm,
      soundPrefsVersion: 2
    };
  }

  function updateReceiptDeviceInfo() {
    const el = $('receiptDeviceInfo');
    if (!el) return;
    const serial = (typeof SerialPosPrinter !== 'undefined' && adminPrefs.receiptSerialPort)
      ? SerialPosPrinter.normalizeSaved(adminPrefs.receiptSerialPort)
      : null;
    if (serial) {
      el.textContent = `Porta serial pareada (VID ${serial.usbVendorId} · PID ${serial.usbProductId}). Para trocar, clique em "Selecionar porta" nas Configurações de Impressão ou "Imprimir" no cupom.`;
      return;
    }
    const dev = (typeof EscPosPrinter !== 'undefined' && adminPrefs.receiptUsbDevice)
      ? EscPosPrinter.normalizeSaved(adminPrefs.receiptUsbDevice)
      : null;
    el.textContent = dev
      ? `Impressora USB pareada (VID ${dev.vendorId} · PID ${dev.productId}${dev.serialNumber ? ' · S/N ' + dev.serialNumber : ''}). Para trocar, clique em "Imprimir" no cupom e escolha outra impressora.`
      : '';
  }

  function readReceiptPrefsFromModalPanel() {
    // O checkbox "direto" do modal também decide o modo: marcar ativa o modo não-Windows
    // atual (ou USB se ainda estava em Windows); desmarcar volta ao diálogo do Windows.
    const escposChecked = !!$('rceEscpos')?.checked;
    const modeNow = validReceiptMode();
    const nextMode = escposChecked
      ? (modeNow === 'windows' ? 'usb' : modeNow)
      : 'windows';
    return {
      receiptPrinterMode: nextMode,
      receiptBold: !!$('rceBold')?.checked,
      receiptFooter: String($('rceFooter')?.value || '').trim(),
      receiptLineHeight: clampFloat($('rceLineHeight')?.value, 1.0, 2.0, adminPrefs.receiptLineHeight),
      receiptZoom: clampInt($('rceZoom')?.value, 70, 150, adminPrefs.receiptZoom),
      receiptEscpos: !!$('rceEscpos')?.checked,
      receiptShowSeparators: !!$('rceShowSep')?.checked,
      receiptShowAddress: !!$('rceShowAddr')?.checked,
      receiptShowItemNotes: !!$('rceShowNotes')?.checked,
      receiptShowPayment: !!$('rceShowPay')?.checked
    };
  }

  function areAlertsMuted() {
    return Date.now() < alertsMutedUntil;
  }

  function shouldPlayAlertSound() {
    if (areAlertsMuted()) return false;
    if (document.hidden && !adminPrefs.playSoundWhenHidden) return false;
    return true;
  }

  function isAudioUnlocked() {
    return !!(sharedAudioCtx && sharedAudioCtx.state === 'running');
  }

  function setAlertControlState(btn, active, { activeTitle, inactiveTitle } = {}) {
    if (!btn) return;
    btn.classList.toggle('alert-ctrl-on', !!active);
    btn.classList.toggle('alert-ctrl-off', !active);
    if (activeTitle || inactiveTitle) {
      btn.title = active ? (activeTitle || btn.title) : (inactiveTitle || btn.title);
    }
  }

  function isDesktopNotifyAllowed() {
    if (!('Notification' in window)) return false;
    return Notification.permission === 'granted' && adminPrefs.desktopNotify !== false;
  }

  function updateNotifyControlUi() {
    const btn = $('enableNotifyBtn');
    if (!btn) return;
    const allowed = isDesktopNotifyAllowed();
    btn.textContent = allowed ? 'Notificações on' : 'Notificações';
    setAlertControlState(btn, allowed, {
      activeTitle: 'Notificações do sistema permitidas',
      inactiveTitle: 'Notificações não permitidas — clique para liberar'
    });
  }

  function updateAlertsMuteUi() {
    const muted = areAlertsMuted();
    document.body.classList.toggle('alerts-muted', muted);
    const status = $('alertsMuteStatus');
    const btn = $('snoozeAlertsBtn');
    if (btn) {
      btn.textContent = muted ? 'Reativar sons' : 'Silenciar 2 min';
      // Verde = sons permitidos; vermelho = silenciado
      setAlertControlState(btn, !muted, {
        activeTitle: 'Sons ativos — clique para silenciar por 2 min',
        inactiveTitle: 'Sons silenciados — clique para reativar'
      });
    }
    updateNotifyControlUi();
    if (!status) return;
    if (!muted) {
      status.hidden = true;
      status.textContent = '';
      return;
    }
    const secs = Math.max(1, Math.ceil((alertsMutedUntil - Date.now()) / 1000));
    status.hidden = false;
    status.textContent = `Sons silenciados por mais ${secs}s. O painel continua atualizando.`;
  }

  function clearSnoozeAlerts() {
    alertsMutedUntil = 0;
    if (alertsMuteTimer) {
      clearInterval(alertsMuteTimer);
      alertsMuteTimer = null;
    }
    updateAlertsMuteUi();
    syncNewOrderAlerts();
    syncSlaAlerts();
    showAppToast('Sons reativados.');
  }

  function snoozeAlerts(ms = ALERTS_SNOOZE_MS) {
    if (areAlertsMuted()) {
      clearSnoozeAlerts();
      return;
    }
    alertsMutedUntil = Date.now() + ms;
    stopSirenSound();
    if (alertsMuteTimer) clearInterval(alertsMuteTimer);
    updateAlertsMuteUi();
    showAppToast('Sons silenciados por 2 minutos.');
    alertsMuteTimer = setInterval(() => {
      if (!areAlertsMuted()) {
        clearInterval(alertsMuteTimer);
        alertsMuteTimer = null;
        updateAlertsMuteUi();
        syncNewOrderAlerts();
        syncSlaAlerts();
        return;
      }
      updateAlertsMuteUi();
    }, 1000);
  }

  function askConfirm(message, { title = 'Confirmar', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar' } = {}) {
    return new Promise((resolve) => {
      const existing = $('appConfirmModal');
      if (existing) existing.remove();
      const modal = document.createElement('div');
      modal.id = 'appConfirmModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="appConfirmTitle">` +
        `<h3 id="appConfirmTitle">${escapeHtml(title)}</h3>` +
        `<p>${escapeHtml(message)}</p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-confirm-ok>${escapeHtml(confirmLabel)}</button>` +
        `<button type="button" class="ghost compact" data-confirm-cancel>${escapeHtml(cancelLabel)}</button>` +
        `</div></div>`;
      const finish = (value) => {
        document.removeEventListener('keydown', onKey);
        modal.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(false);
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        }
      };
      modal.addEventListener('click', (e) => {
        if (e.target === modal) finish(false);
      });
      modal.querySelector('[data-confirm-ok]')?.addEventListener('click', () => finish(true));
      modal.querySelector('[data-confirm-cancel]')?.addEventListener('click', () => finish(false));
      document.addEventListener('keydown', onKey);
      document.body.appendChild(modal);
      modal.querySelector('[data-confirm-ok]')?.focus();
    });
  }

  function openImageLightbox(url, name) {
    if (!url) return;
    const existing = $('imageLightboxModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'imageLightboxModal';
    modal.className = 'confirm-modal image-lightbox-modal';
    modal.innerHTML =
      `<button type="button" class="image-lightbox-close" data-lightbox-close aria-label="Fechar imagem">×</button>` +
      `<img id="imageLightboxImg" src="${escapeHtml(url)}" alt="${escapeHtml(name ? `Imagem ampliada de ${name}` : 'Imagem ampliada')}" />`;
    const close = () => {
      document.removeEventListener('keydown', onKey);
      modal.remove();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
    };
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });
    modal.querySelector('[data-lightbox-close]')?.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);
    modal.querySelector('[data-lightbox-close]')?.focus();
  }

  function wireImageZoom(imgEl, name) {
    if (!imgEl) return;
    imgEl.style.cursor = 'zoom-in';
    imgEl.title = name ? `Ampliar ${name}` : 'Ampliar imagem';
    imgEl.setAttribute('role', 'button');
    imgEl.tabIndex = 0;
    const open = () => openImageLightbox(imgEl.src, name);
    imgEl.addEventListener('click', open);
    imgEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  }

  function canEditOrderItems(order) {
    return order?.status === 'Created' || order?.status === 'Accepted';
  }

  function flattenCatalogProducts() {
    const list = [];
    (catalog?.categories || []).forEach((cat) => {
      (cat.items || cat.products || []).forEach((p) => {
        if (!p || !p.name) return;
        if (p.available === false) return; // indisponível: some também dos seletores do painel
        list.push({
          id: p.id || '',
          name: p.name,
          price: Number(p.price) || 0,
          priceMedia: p.priceMedia != null ? Number(p.priceMedia) : null,
          priceInteira: p.priceInteira != null ? Number(p.priceInteira) : null,
          modifierGroups: Array.isArray(p.modifierGroups) ? p.modifierGroups : [],
          category: cat.title || cat.name || ''
        });
      });
    });
    list.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
    return list;
  }

  async function ensureCatalogForOrderEdit() {
    if (flattenCatalogProducts().length) return true;
    try {
      const data = await api('/api/v1/catalog');
      if (data && Array.isArray(data.categories)) {
        catalog = data;
        return flattenCatalogProducts().length > 0;
      }
    } catch (err) {
      console.warn('Catálogo para edição de itens', err);
    }
    return false;
  }

  /** Modal: tem todos os itens? Sim → confirma; Não → alterar itens. */
  function askItemsAvailability(order) {
    return new Promise((resolve) => {
      const existing = $('itemsCheckModal');
      if (existing) existing.remove();

      const modal = document.createElement('div');
      modal.id = 'itemsCheckModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card items-check-card" role="dialog" aria-modal="true" aria-labelledby="itemsCheckTitle">` +
        `<h3 id="itemsCheckTitle">Confirmar pedido</h3>` +
        `<p class="muted">Pedido <strong>${escapeHtml(order.orderId)}</strong> — ${escapeHtml(order.customerName || '')}</p>` +
        `<p class="items-check-highlight">Você tem todos os itens do pedido?</p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-items-yes>Sim</button>` +
        `<button type="button" class="ghost" data-items-no>Não</button>` +
        `<button type="button" class="ghost compact" data-items-abort>Voltar</button>` +
        `</div></div>`;
      document.body.appendChild(modal);

      const finish = (value) => {
        document.removeEventListener('keydown', onKey);
        modal.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(null);
      };
      modal.addEventListener('click', (e) => {
        if (e.target === modal) finish(null);
      });
      modal.querySelector('[data-items-abort]')?.addEventListener('click', () => finish(null));
      modal.querySelector('[data-items-yes]')?.addEventListener('click', () => finish({ allItems: true }));
      modal.querySelector('[data-items-no]')?.addEventListener('click', () => finish({ allItems: false }));
      document.addEventListener('keydown', onKey);
      modal.querySelector('[data-items-yes]')?.focus();
    });
  }

  function askEditOrderItems(order, products) {
    return new Promise((resolve) => {
      const existing = $('editOrderItemsModal');
      if (existing) existing.remove();

      const initial = (order.items || []).map((it) => {
        const modifiers = resolveItemModifiers(it);
        const product = findCatalogProduct(it);
        return {
          productId: it.productId || '',
          name: it.name || '',
          price: priceWithResolvedModifiers(it.name, product, modifiers, it.price),
          quantity: Math.max(1, Number(it.quantity) || 1),
          modifiers
        };
      });

      const productOptions = products.map((p) =>
        `<option value="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" data-price="${escapeHtml(String(p.price))}">${escapeHtml(p.name)} — ${money(p.price)}</option>`
      ).join('');

      const modal = document.createElement('div');
      modal.id = 'editOrderItemsModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card edit-order-items-card" role="dialog" aria-modal="true" aria-labelledby="editOrderItemsTitle">` +
        `<h3 id="editOrderItemsTitle">Alterar itens do pedido</h3>` +
        `<p class="muted">Pedido <strong>${escapeHtml(order.orderId)}</strong> — ${escapeHtml(order.customerName || '')}</p>` +
        `<div id="editOrderItemsList" class="edit-order-items-list"></div>` +
        `<div class="edit-order-items-add">` +
        `<select id="editOrderAddProduct"><option value="">Adicionar produto…</option>${productOptions}</select>` +
        `<button type="button" class="ghost compact" data-edit-add>Adicionar</button>` +
        `</div>` +
        `<p class="edit-order-items-total">Itens: <strong id="editOrderItemsTotal">—</strong>` +
        `<span class="muted"> · entrega ${money(orderDeliveryFee(order))}</span></p>` +
        `<p id="editOrderItemsError" class="error" hidden></p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-edit-save>Salvar itens</button>` +
        `<button type="button" class="ghost compact" data-edit-abort>Cancelar</button>` +
        `</div></div>`;
      document.body.appendChild(modal);

      let lines = initial.map((x) => ({ ...x }));
      const listEl = modal.querySelector('#editOrderItemsList');
      const totalEl = modal.querySelector('#editOrderItemsTotal');
      const errEl = modal.querySelector('#editOrderItemsError');
      const addSelect = modal.querySelector('#editOrderAddProduct');

      const finish = (value) => {
        document.removeEventListener('keydown', onKey);
        modal.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(null);
      };

      const renderLines = () => {
        if (!listEl) return;
        if (!lines.length) {
          listEl.innerHTML = '<p class="muted">Nenhum item. Adicione ao menos um produto.</p>';
        } else {
          listEl.innerHTML = lines.map((line, idx) => {
            const detail = itemCustomizationHtml(line);
            const unresolved = (line.modifiers || [])
              .filter((m) => m && m.resolved === false)
              .map((m) => m.name);
            const warn = unresolved.length
              ? `<div class="edit-order-item-warn">Adicional não encontrado no cardápio (será descartado ao salvar): ${escapeHtml(unresolved.join(', '))}</div>`
              : '';
            return (
              `<div class="edit-order-item-row" data-idx="${idx}">` +
              `<input type="number" class="edit-qty" min="1" max="99" value="${escapeHtml(String(line.quantity))}" aria-label="Quantidade" />` +
              `<input type="text" class="edit-name" maxlength="200" value="${escapeHtml(line.name)}" aria-label="Nome do item" />` +
              `<span class="edit-price">${money(line.price)}</span>` +
              `<button type="button" class="ghost compact danger" data-edit-remove title="Remover">×</button>` +
              `</div>` +
              (detail ? `<div class="edit-order-item-detail">${detail}</div>` : '') +
              warn
            );
          }).join('');
        }
        const itemsSum = lines.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.quantity) || 0), 0);
        if (totalEl) totalEl.textContent = money(itemsSum);
      };

      const syncFromDom = () => {
        listEl?.querySelectorAll('.edit-order-item-row').forEach((row) => {
          const idx = Number(row.getAttribute('data-idx'));
          if (!Number.isFinite(idx) || !lines[idx]) return;
          const qty = Number(row.querySelector('.edit-qty')?.value) || 1;
          const name = (row.querySelector('.edit-name')?.value || '').trim();
          lines[idx].quantity = Math.min(99, Math.max(1, Math.round(qty)));
          lines[idx].name = name;
        });
      };

      listEl?.addEventListener('input', (e) => {
        const row = e.target.closest('.edit-order-item-row');
        if (!row) return;
        const idx = Number(row.getAttribute('data-idx'));
        if (!Number.isFinite(idx) || !lines[idx]) return;
        if (e.target.classList.contains('edit-qty')) {
          lines[idx].quantity = Math.min(99, Math.max(1, Math.round(Number(e.target.value) || 1)));
          if (totalEl) {
            totalEl.textContent = money(
              lines.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.quantity) || 0), 0)
            );
          }
        } else if (e.target.classList.contains('edit-name')) {
          lines[idx].name = e.target.value;
        }
      });

      // Ao sair do nome, re-resolve os adicionais do texto (ex.: "Adic. Bacon +8,00")
      // contra o catálogo e recalcula o preço da linha antes de salvar.
      listEl?.addEventListener('change', (e) => {
        const row = e.target.closest('.edit-order-item-row');
        if (!row || !e.target.classList.contains('edit-name')) return;
        const idx = Number(row.getAttribute('data-idx'));
        if (!Number.isFinite(idx) || !lines[idx]) return;
        syncFromDom();
        const line = lines[idx];
        line.modifiers = resolveItemModifiers(line);
        line.price = priceWithResolvedModifiers(line.name, findCatalogProduct(line), line.modifiers, line.price);
        renderLines();
      });

      listEl?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-edit-remove]');
        if (!btn) return;
        syncFromDom();
        const idx = Number(btn.closest('.edit-order-item-row')?.getAttribute('data-idx'));
        if (!Number.isFinite(idx)) return;
        lines.splice(idx, 1);
        renderLines();
      });

      modal.querySelector('[data-edit-add]')?.addEventListener('click', () => {
        const opt = addSelect?.selectedOptions?.[0];
        if (!opt?.value) {
          if (errEl) {
            errEl.textContent = 'Selecione um produto para adicionar.';
            errEl.hidden = false;
          }
          return;
        }
        syncFromDom();
        const name = opt.getAttribute('data-name') || opt.textContent || '';
        const price = Number(opt.getAttribute('data-price')) || 0;
        const existingIdx = lines.findIndex((l) =>
          (l.productId && l.productId === opt.value) || l.name === name);
        if (existingIdx >= 0) {
          lines[existingIdx].quantity = Math.min(99, (lines[existingIdx].quantity || 1) + 1);
        } else {
          lines.push({ productId: opt.value, name, price, quantity: 1, modifiers: [] });
        }
        if (addSelect) addSelect.value = '';
        if (errEl) errEl.hidden = true;
        renderLines();
      });

      modal.querySelector('[data-edit-abort]')?.addEventListener('click', () => finish(null));
      modal.addEventListener('click', (e) => {
        if (e.target === modal) finish(null);
      });
      modal.querySelector('[data-edit-save]')?.addEventListener('click', () => {
        syncFromDom();
        const unresolvedNames = [];
        const payload = lines
          .filter((l) => (l.name || '').trim())
          .map((l) => {
            const resolved = resolveItemModifiers(l);
            resolved
              .filter((m) => m && m.resolved === false)
              .forEach((m) => unresolvedNames.push(m.name));
            const mods = resolved
              .filter((m) => m && m.groupId && m.optionId)
              .map((m) => ({
                groupId: m.groupId,
                optionId: m.optionId,
                name: m.name,
                priceDelta: Number(m.priceDelta) || 0
              }));
            return {
              productId: l.productId || null,
              name: l.name.trim(),
              price: priceWithResolvedModifiers(l.name, findCatalogProduct(l), resolved, l.price),
              quantity: Math.min(99, Math.max(1, Number(l.quantity) || 1)),
              ...(mods.length ? { modifiers: mods } : {})
            };
          });
        if (!payload.length) {
          if (errEl) {
            errEl.textContent = 'Inclua ao menos um item.';
            errEl.hidden = false;
          }
          return;
        }
        if (unresolvedNames.length) {
          showAppToast(
            `Adicional não encontrado no cardápio (descartado): ${unresolvedNames.join(', ')}`,
            { ms: 4000 }
          );
        }
        finish(payload);
      });

      document.addEventListener('keydown', onKey);
      renderLines();
      modal.querySelector('[data-edit-save]')?.focus();
    });
  }

  async function editOrderItems(order) {
    if (!canEditOrderItems(order)) {
      throw new Error('Só é possível alterar itens enquanto o pedido aguarda confirmação ou está confirmado.');
    }
    const okCatalog = await ensureCatalogForOrderEdit();
    if (!okCatalog) throw new Error('Catálogo indisponível para editar itens.');
    const items = await askEditOrderItems(order, flattenCatalogProducts());
    if (!items) return null;

    const updated = await api(`/api/v1/orders/${encodeURIComponent(order.orderId)}/items`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ items })
    });
    applyOrderToLocalList(updated);
    syncAlertsAfterLocalOrderChange();
    showAppToast('Itens atualizados.', { ms: 2500 });
    try {
      await refreshOrders({ silent: true });
    } catch (err) {
      console.warn('Refresh após editar itens', err);
      syncAlertsAfterLocalOrderChange();
    }
    renderOrdersBoard();
    return updated;
  }

  // ── Novo pedido de mesa (consumo no local) ──
  function askNewTableOrder(tables, products, preselectTableId = null) {
    return new Promise((resolve) => {
      const existing = $('newTableOrderModal');
      if (existing) existing.remove();

      const activeTables = (tables || []).filter((t) => t.active);
      const tableOptions = activeTables.map((t) =>
        `<option value="${escapeHtml(String(t.id))}"${t.openOrders ? ` data-open="${escapeHtml(String(t.openOrders))}"` : ''}>${escapeHtml(t.label)}${t.openOrders ? ` (${t.openOrders} aberto)` : ''}</option>`
      ).join('') || '<option value="">Nenhuma mesa ativa</option>';

      const productOptions = products.map((p) =>
        `<option value="${escapeHtml(p.id)}" data-name="${escapeHtml(p.name)}" data-price="${escapeHtml(String(p.price))}">${escapeHtml(p.name)} — ${money(p.price)}</option>`
      ).join('');

      const modal = document.createElement('div');
      modal.id = 'newTableOrderModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card edit-order-items-card" role="dialog" aria-modal="true" aria-labelledby="newTableOrderTitle">` +
        `<h3 id="newTableOrderTitle">Novo pedido de mesa</h3>` +
        `<label class="field-label">Mesa</label>` +
        `<select id="newTableOrderTable"><option value="">Selecione a mesa…</option>${tableOptions}</select>` +
        `<label class="field-label">Cliente (opcional)</label>` +
        `<input id="newTableOrderCustomer" class="type-confirm-input" type="text" maxlength="120" placeholder="Nome do cliente" />` +
        `<div id="newTableOrderItemsList" class="edit-order-items-list"></div>` +
        `<div class="edit-order-items-add">` +
        `<select id="newTableOrderAddProduct"><option value="">Adicionar produto…</option>${productOptions}</select>` +
        `<button type="button" class="ghost compact" data-nto-add>Adicionar</button>` +
        `</div>` +
        `<label class="field-label">Forma de pagamento</label>` +
        `<select id="newTableOrderPay"><option value="Pix">Pix</option><option value="Dinheiro">Dinheiro</option><option value="Cartão de Crédito">Cartão de Crédito</option><option value="Cartão de Débito">Cartão de Débito</option></select>` +
        `<label class="field-label">Observações (opcional)</label>` +
        `<input id="newTableOrderNotes" class="type-confirm-input" type="text" maxlength="500" placeholder="Ex.: sem cebola" />` +
        `<p class="edit-order-items-total">Total: <strong id="newTableOrderTotal">—</strong></p>` +
        `<p id="newTableOrderError" class="error" hidden></p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-nto-save>Criar pedido</button>` +
        `<button type="button" class="ghost compact" data-nto-abort>Cancelar</button>` +
        `</div></div>`;
      document.body.appendChild(modal);

      let lines = [];
      const listEl = modal.querySelector('#newTableOrderItemsList');
      const totalEl = modal.querySelector('#newTableOrderTotal');
      const errEl = modal.querySelector('#newTableOrderError');
      const addSelect = modal.querySelector('#newTableOrderAddProduct');
      const tableSelect = modal.querySelector('#newTableOrderTable');

      const finish = (value) => {
        document.removeEventListener('keydown', onKey);
        modal.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(null);
      };

      const showError = (msg) => {
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      };

      const renderLines = () => {
        if (!listEl) return;
        if (!lines.length) {
          listEl.innerHTML = '<p class="muted">Nenhum item. Adicione ao menos um produto.</p>';
        } else {
          listEl.innerHTML = lines.map((line, idx) => {
            const detail = itemCustomizationHtml(line);
            return (
              `<div class="edit-order-item-row" data-idx="${idx}">` +
              `<input type="number" class="edit-qty" min="1" max="99" value="${escapeHtml(String(line.quantity))}" aria-label="Quantidade" />` +
              `<input type="text" class="edit-name" maxlength="200" value="${escapeHtml(line.name)}" aria-label="Nome do item" />` +
              `<span class="edit-price">${money(line.price)}</span>` +
              `<button type="button" class="ghost compact danger" data-nto-remove title="Remover">×</button>` +
              `</div>` +
              (detail ? `<div class="edit-order-item-detail">${detail}</div>` : '')
            );
          }).join('');
        }
        const itemsSum = lines.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.quantity) || 0), 0);
        if (totalEl) totalEl.textContent = money(itemsSum);
      };

      const syncFromDom = () => {
        listEl?.querySelectorAll('.edit-order-item-row').forEach((row) => {
          const idx = Number(row.getAttribute('data-idx'));
          if (!Number.isFinite(idx) || !lines[idx]) return;
          const qty = Number(row.querySelector('.edit-qty')?.value) || 1;
          lines[idx].quantity = Math.min(99, Math.max(1, Math.round(qty)));
          lines[idx].name = (row.querySelector('.edit-name')?.value || '').trim();
        });
      };

      listEl?.addEventListener('input', (e) => {
        const row = e.target.closest('.edit-order-item-row');
        if (!row) return;
        const idx = Number(row.getAttribute('data-idx'));
        if (!Number.isFinite(idx) || !lines[idx]) return;
        if (e.target.classList.contains('edit-qty')) {
          lines[idx].quantity = Math.min(99, Math.max(1, Math.round(Number(e.target.value) || 1)));
        } else if (e.target.classList.contains('edit-name')) {
          lines[idx].name = e.target.value;
        }
        if (totalEl) {
          totalEl.textContent = money(
            lines.reduce((s, l) => s + (Number(l.price) || 0) * (Number(l.quantity) || 0), 0)
          );
        }
      });

      listEl?.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-nto-remove]');
        if (!btn) return;
        syncFromDom();
        const idx = Number(btn.closest('.edit-order-item-row')?.getAttribute('data-idx'));
        if (!Number.isFinite(idx)) return;
        lines.splice(idx, 1);
        renderLines();
      });

      modal.querySelector('[data-nto-add]')?.addEventListener('click', () => {
        const opt = addSelect?.selectedOptions?.[0];
        if (!opt?.value) { showError('Selecione um produto para adicionar.'); return; }
        syncFromDom();
        const name = opt.getAttribute('data-name') || opt.textContent || '';
        const price = Number(opt.getAttribute('data-price')) || 0;
        const existingIdx = lines.findIndex((l) =>
          (l.productId && l.productId === opt.value) || l.name === name);
        if (existingIdx >= 0) {
          lines[existingIdx].quantity = Math.min(99, (lines[existingIdx].quantity || 1) + 1);
        } else {
          lines.push({ productId: opt.value, name, price, quantity: 1 });
        }
        if (addSelect) addSelect.value = '';
        if (errEl) errEl.hidden = true;
        renderLines();
      });

      modal.querySelector('[data-nto-abort]')?.addEventListener('click', () => finish(null));
      modal.addEventListener('click', (e) => {
        if (e.target === modal) finish(null);
      });
      modal.querySelector('[data-nto-save]')?.addEventListener('click', () => {
        syncFromDom();
        const tableId = Number((tableSelect?.value || '').trim());
        const table = activeTables.find((t) => Number(t.id) === tableId);
        if (!table) { showError('Selecione uma mesa ativa.'); return; }
        const items = lines
          .filter((l) => (l.name || '').trim())
          .map((l) => ({
            productId: l.productId || null,
            name: l.name.trim(),
            price: Number(l.price) || 0,
            quantity: Math.min(99, Math.max(1, Number(l.quantity) || 1))
          }));
        if (!items.length) { showError('Inclua ao menos um item.'); return; }
        const payload = {
          tableId,
          orderSource: 'waiter_panel',
          fulfillmentType: 'dine_in',
          customerName: ($('newTableOrderCustomer')?.value || '').trim() || 'Cliente',
          customerPhone: '',
          paymentMethod: ($('newTableOrderPay')?.value || 'Pix').trim(),
          paymentTiming: 'on_delivery',
          needsChange: false,
          changeFor: null,
          notes: ($('newTableOrderNotes')?.value || '').trim(),
          deliveryFee: 0,
          items
        };
        finish(payload);
      });

      document.addEventListener('keydown', onKey);
      renderLines();
      if (preselectTableId != null) {
        tableSelect.value = String(preselectTableId);
      }
      modal.querySelector('[data-nto-save]')?.focus();
    });
  }

  // Mostra/esconde o botão "Novo pedido de mesa" conforme dine-in habilitado
  function updateDineInUi() {
    const btn = $('newTableOrderBtn');
    if (!btn) return;
    const enabled = !!(storeConfig && storeConfig.dineInEnabled) && canSeeOrders();
    btn.hidden = !enabled;
    if (enabled) btn.removeAttribute('hidden');
    updateChannelsVisibility();
  }

  // ── Consumo no local: "Usar mesas" (toggle) + quantidade de mesas ──
  function updateTablesUsageUi() {
    const toggle = $('useTablesEnabled');
    const count = $('tableCount');
    const sessionH = $('waiterSessionHours');
    if (!toggle || !count) return;
    const enabled = !!toggle.checked;
    count.disabled = !enabled;
    if (sessionH) sessionH.disabled = !enabled;
  }

  // Abre o cardápio autenticado do storefront para o garçom montar o pedido da mesa.
  function openWaiterMenuForTable(table) {
    const url = storeFrontMenuUrl(Number(table.id || table.tableId || table.Id), token);
    const win = window.open(url, '_blank', 'noopener');
    if (win) {
      try { win.opener = null; } catch (_) { /* ignore */ }
    }
    showAppToast(`Cardápio aberto para a mesa ${table.label}. Monte o pedido na nova aba.`, { ms: 3500 });
  }

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

  // Base do storefront: local/LAN → :8080; público → raiz (override via STORE_FRONT_URL).
  function storeFrontBaseUrl() {
    const override = window.STORE_FRONT_URL;
    if (override) return String(override).replace(/\/$/, '');
    if (isLocalOrLanHost()) return 'http://192.168.15.7:8080';
    return 'https://delivery-fabin.vercel.app';
  }

  function storeFrontMenuUrl(tableId, jwtToken) {
    const q = `table=${encodeURIComponent(String(tableId))}&token=${encodeURIComponent(jwtToken)}`;
    return `${storeFrontBaseUrl()}/?${q}`;
  }

  // Abre o cardápio autenticado do storefront para registrar um pedido de
  // atendimento (Balcão/Delivery/Telefone). "Mesas" reusa a grade existente.
  function openChannelMenu(channel) {
    if (channel === 'mesas') {
      openTab('mesas');
      return;
    }
    if (channel === 'delivery') {
      showDeliveryQrModal();
      return;
    }
    if (!token) {
      showAppToast('Faça login para registrar pedidos de atendimento.');
      return;
    }
    const q = `modo=${encodeURIComponent(channel)}&token=${encodeURIComponent(token)}`;
    const url = `${storeFrontBaseUrl()}/?${q}`;
    const win = window.open(url, '_blank', 'noopener');
    if (win) {
      try { win.opener = null; } catch (_) { /* ignore */ }
    }
    const label = channel === 'balcao' ? 'Balcão' : channel === 'telefone' ? 'Telefone' : 'Delivery';
    showAppToast(`Cardápio aberto para pedido de ${label}. Monte o pedido na nova aba.`, { ms: 3500 });
  }

  // QR Code com o link do cardápio digital da loja (Delivery → cliente faz o
  // próprio pedido pelo celular). Botões Copiar link/Abrir cardápio + ✕ para fechar.
  function showDeliveryQrModal() {
    const existing = document.getElementById('deliveryQrModal');
    if (existing) existing.remove();
    const url = `${storeFrontBaseUrl()}/`;
    const modal = document.createElement('div');
    modal.id = 'deliveryQrModal';
    modal.className = 'confirm-modal';
    modal.innerHTML =
      `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="deliveryQrTitle" style="position:relative;display:flex;flex-direction:column;">` +
      `<button type="button" data-delivery-qr-esc aria-label="Fechar" style="position:absolute;top:.25rem;right:.6rem;border:none;background:transparent;font-size:1.2rem;line-height:1;width:30px;height:30px;display:flex;align-items:center;justify-content:center;color:#94a3b8;cursor:pointer;padding:0;">×</button>` +
      `<h3 id="deliveryQrTitle">Delivery · Cardápio digital</h3>` +
      `<p>Escaneie o QR Code para abrir o cardápio digital da loja no celular:</p>` +
      `<div style="text-align:center;margin:0.5rem 0">` +
      `<img src="${qrCodeDataUrl(url, 240)}" alt="QR Code do cardápio digital" style="width:min(220px,60vw);height:auto;border:1px solid var(--border,#e2e2e2);border-radius:8px;padding:6px;background:#fff;" />` +
      `</div>` +
      `<div class="confirm-modal-actions">` +
      `<button type="button" class="ghost compact" data-delivery-qr-copy>Copiar link</button>` +
      `<button type="button" class="confirm" data-delivery-qr-open>Abrir cardápio</button>` +
      `</div>` +
      `</div>`;
    const finish = () => {
      document.removeEventListener('keydown', onKey);
      modal.remove();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'Enter') {
        e.preventDefault();
        openDeliveryQrLink();
      }
    };
    const openDeliveryQrLink = () => {
      finish();
      window.open(url, '_blank', 'noopener');
    };
    modal.addEventListener('click', (e) => {
      if (e.target === modal) finish();
    });
    modal.querySelector('[data-delivery-qr-esc]')?.addEventListener('click', finish);
    modal.querySelector('[data-delivery-qr-open]')?.addEventListener('click', openDeliveryQrLink);
    modal.querySelector('[data-delivery-qr-copy]')?.addEventListener('click', () => {
      try {
        navigator.clipboard.writeText(url);
        showAppToast('Link do cardápio digital copiado.', { ms: 2400 });
      } catch (_) {
        showAppToast('Não foi possível copiar o link.', { ms: 2400 });
      }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);
  }

  // Mostra os atalhos de atendimento na topbar para quem pode ver pedidos.
  function updateChannelsVisibility() {
    const wrap = $('topbarChannels');
    if (!wrap) return;
    const visible = canSeeOrders();
    wrap.hidden = !visible;
    if (!visible) return;
    const mesasBtn = wrap.querySelector('[data-channel="mesas"]');
    if (mesasBtn) mesasBtn.hidden = !(!!(storeConfig && storeConfig.dineInEnabled));
  }

  // ── Comanda de mesa (mapa visual): abrir, agrupar comandas, novo pedido, avançar status ──
  function askTableComanda(table, comandas) {
    return new Promise((resolve) => {
      const existing = $('tableComandaModal');
      if (existing) existing.remove();
      const list = comandas || [];
      const occupied = list.length > 0;
      const total = list.reduce((s, c) => s + (Number(c.total) || 0), 0);
      const rows = list.map((c) => {
        const items = (c.items || []).map((it) => `${it.quantity}× ${escapeHtml(splitItemCustomization(it.name).name)}${escapeHtml(itemCustomizationInline(it))}`).join(', ') || 'Sem itens';
        const paid = comandaIsPaid(c);
        const advBtn = c.nextStatus
          ? `<button type="button" class="ghost compact" data-comanda-advance="${escapeHtml(String(c.orderId))}">Avançar (${escapeHtml(c.nextStatusLabel || c.nextStatus)})</button>`
          : '';
        return (
          `<div class="comanda-row${paid ? ' is-paid' : ''}">` +
          `<div class="comanda-row-head">` +
          `<strong>${escapeHtml(c.orderId)}</strong>` +
          (paid
            ? `<span class="status-badge status-Pago">Pago</span>`
            : `<span class="status-badge status-${escapeHtml(c.status)}">${escapeHtml(c.statusLabel || c.status)}</span>`) +
          `</div>` +
          `<div class="comanda-row-items">${items}</div>` +
          `<div class="comanda-row-foot">` +
          `<span>Total: ${money(c.total)}</span>${paid ? `<span class="muted">Pago</span>` : ''}${advBtn}` +
          `</div>` +
          `</div>`
        );
      }).join('') || '<p class="muted">Nenhuma comanda aberta nesta mesa.</p>';
      const modal = document.createElement('div');
      modal.id = 'tableComandaModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card comanda-card" role="dialog" aria-modal="true" aria-labelledby="tableComandaTitle">` +
        `<button type="button" class="comanda-x" data-comanda-x aria-label="Fechar" title="Fechar">✕</button>` +
        `<h3 id="tableComandaTitle">Comanda — ${escapeHtml(table.label)}</h3>` +
        `<p class="muted">${occupied ? 'Ocupada' : 'Livre'} · total acumulado: <strong>${money(total)}</strong></p>` +
        `<div class="comanda-list">${rows}</div>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-comanda-new>+ Novo pedido</button>` +
        `<button type="button" class="ghost compact" data-comanda-conta>Conta</button>` +
        `</div></div>`;
      document.body.appendChild(modal);
      const done = (v) => {
        modal.remove();
        document.removeEventListener('keydown', onKey);
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      modal.querySelector('[data-comanda-new]')?.addEventListener('click', () => done({ type: 'newOrder' }));
      modal.querySelector('[data-comanda-x]')?.addEventListener('click', (e) => { e.stopPropagation(); done(null); });
      modal.querySelector('[data-comanda-conta]')?.addEventListener('click', () => done({ type: 'conta' }));
      modal.querySelectorAll('[data-comanda-advance]').forEach((btn) => {
        btn.addEventListener('click', () => done({ type: 'advance', orderId: btn.getAttribute('data-comanda-advance') }));
      });
      modal.addEventListener('click', (e) => { if (e.target === modal) done(null); });
      document.addEventListener('keydown', onKey);
    });
  }

  async function openTableComanda(table) {
    if (!canSeeOrders()) throw new Error('Sem permissão para abrir comanda.');
    if (!(await requirePinSession())) throw new Error('PIN não autorizado. Ação cancelada.');
    const okCatalog = await ensureCatalogForOrderEdit();
    if (!okCatalog) throw new Error('Catálogo indisponível.');
    const loadComandas = async () => {
      try {
        const res = await api(`/api/v1/orders/table/${table.id}`, { headers: authHeaders() });
        return Array.isArray(res) ? res : [];
      } catch (_) { return []; }
    };
    let comandas = await loadComandas();
    let open = true;
    while (open) {
      const action = await askTableComanda(table, comandas);
      if (!action) { open = false; break; }
      if (action.type === 'newOrder') {
        // Abre o cardápio autenticado do storefront para montar o pedido da mesa
        openWaiterMenuForTable(table);
        comandas = await loadComandas();
      } else if (action.type === 'advance') {
        const order = comandas.find((c) => c.orderId === action.orderId);
        if (order) {
          try {
            await advanceOrderStatus(order, { skipConfirm: true });
          } catch (e) {
            showAppToast(e.message || 'Erro ao avançar a comanda.');
          }
        }
        comandas = await loadComandas();
        if (!comandas.length) open = false;
      } else if (action.type === 'conta') {
        open = false;
        // "Conta" = fechar mesa (divisão da conta) direto da comanda.
        try {
          await fecharTable(table);
        } catch (e) {
          showAppToast(e.message || 'Erro ao fechar mesa.');
        }
      }
    }
    await loadTablesTab().catch(() => {});
    return null;
  }

  // ── PIN gate (camada adicional ao JWT p/ ações dine-in sensíveis) ──
  const PIN_SESSION_KEY = 'admin_pin_session';
  const PIN_SESSION_MS = 20 * 60 * 1000; // fallback client-side

  function loadPinSessionFromStorage() {
    try {
      const raw = localStorage.getItem(PIN_SESSION_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s && s.sessionId && s.expiresAt && new Date(s.expiresAt).getTime() > Date.now()) {
        pinSession = s;
      } else {
        localStorage.removeItem(PIN_SESSION_KEY);
      }
    } catch (_) { localStorage.removeItem(PIN_SESSION_KEY); }
  }

  function savePinSession(s) {
    pinSession = s;
    try { localStorage.setItem(PIN_SESSION_KEY, JSON.stringify(s)); } catch (_) { /* ignore */ }
  }

  function clearPinSession() {
    pinSession = null;
    try { localStorage.removeItem(PIN_SESSION_KEY); } catch (_) { /* ignore */ }
  }

  async function checkPinStatus() {
    try {
      const res = await api('/api/v1/admin/pin/status', { headers: authHeaders() });
      pinHasPin = !!(res && res.hasPin);
    } catch (_) { pinHasPin = null; }
  }

  async function ensurePinSession() {
    // Sessão válida em memória
    if (pinSession && new Date(pinSession.expiresAt).getTime() > Date.now()) return true;
    clearPinSession();
    if (pinHasPin === null) await checkPinStatus();
    // Usuário não definiu PIN ainda — oferecer para definir
    if (pinHasPin === false) {
      const set = await askPinSet();
      if (!set) return false;
      pinHasPin = true;
    }
    // Pedir validação do PIN
    const validated = await askPinValidate();
    return !!validated;
  }

  function askPinSet() {
    return new Promise((resolve) => {
      const existing = $('pinSetModal');
      if (existing) existing.remove();
      const modal = document.createElement('div');
      modal.id = 'pinSetModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="pinSetTitle">` +
        `<h3 id="pinSetTitle">Definir PIN de garçom</h3>` +
        `<p class="muted">Defina um PIN de 4 dígitos para autorizar ações de consumo no local (pagamento, finalização, cancelamento).</p>` +
        `<label class="field-label">PIN (4 dígitos)</label>` +
        `<input id="pinSetInput" class="type-confirm-input" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="••••" autocomplete="off" />` +
        `<label class="field-label">Confirmar PIN</label>` +
        `<input id="pinSetConfirm" class="type-confirm-input" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="••••" autocomplete="off" />` +
        `<p id="pinSetError" class="error" hidden></p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-pin-set-save>Definir</button>` +
        `<button type="button" class="ghost compact" data-pin-set-cancel>Cancelar</button>` +
        `</div></div>`;
      document.body.appendChild(modal);
      const finish = (v) => { document.removeEventListener('keydown', onKey); modal.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      const errEl = modal.querySelector('#pinSetError');
      const showError = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
      modal.querySelector('[data-pin-set-cancel]').addEventListener('click', () => finish(false));
      modal.addEventListener('click', (e) => { if (e.target === modal) finish(false); });
      const savePin = async () => {
        const pin = (modal.querySelector('#pinSetInput') || {}).value || '';
        const confirm = (modal.querySelector('#pinSetConfirm') || {}).value || '';
        if (pin.length !== 4 || !/^\d{4}$/.test(pin)) { showError('O PIN deve ter 4 dígitos.'); return; }
        if (pin !== confirm) { showError('Os PINs não coincidem.'); return; }
        try {
          await api('/api/v1/admin/pin/set', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ pin })
          });
          finish(true);
        } catch (e) { showError(e.message || 'Erro ao salvar PIN.'); }
      };
      modal.querySelector('[data-pin-set-save]').addEventListener('click', savePin);
      const confirmInput = modal.querySelector('#pinSetConfirm');
      if (confirmInput) {
        confirmInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); savePin(); }
        });
      }
      document.addEventListener('keydown', onKey);
      (modal.querySelector('#pinSetInput') || {}).focus();
    });
  }

  function askPinValidate() {
    return new Promise((resolve) => {
      const existing = $('pinValidateModal');
      if (existing) existing.remove();
      const modal = document.createElement('div');
      modal.id = 'pinValidateModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="pinValTitle">` +
        `<h3 id="pinValTitle">Autorizar ação</h3>` +
        `<p class="muted">Digite seu PIN de 4 dígitos para continuar.</p>` +
        `<label class="field-label">PIN</label>` +
        `<input id="pinValInput" class="type-confirm-input" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="••••" autocomplete="off" />` +
        `<p id="pinValError" class="error" hidden></p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-pin-val-ok>Confirmar</button>` +
        `<button type="button" class="ghost compact" data-pin-val-cancel>Cancelar</button>` +
        `</div></div>`;
      document.body.appendChild(modal);
      const finish = (v) => { document.removeEventListener('keydown', onKey); modal.remove(); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') finish(null); };
      const errEl = modal.querySelector('#pinValError');
      const showError = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
      modal.querySelector('[data-pin-val-cancel]').addEventListener('click', () => finish(null));
      modal.addEventListener('click', (e) => { if (e.target === modal) finish(null); });
      const input = modal.querySelector('#pinValInput');
      const confirmPin = async () => {
        const pin = input.value || '';
        if (pin.length !== 4 || !/^\d{4}$/.test(pin)) { showError('Digite 4 dígitos.'); return; }
        try {
          const res = await api('/api/v1/admin/pin/validate', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ pin })
          });
          if (res && res.sessionId) {
            savePinSession({ sessionId: res.sessionId, expiresAt: res.expiresAt });
            finish(res);
          } else {
            showError('Resposta inválida do servidor.');
          }
        } catch (e) {
          showError(e.message && e.message.includes('401') ? 'PIN incorreto.' : (e.message || 'Erro ao validar PIN.'));
        }
      };
      modal.querySelector('[data-pin-val-ok]').addEventListener('click', confirmPin);
      if (input) {
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); confirmPin(); }
        });
      }
      document.addEventListener('keydown', onKey);
      if (input) input.focus();
    });
  }

  /** Exige sessão de PIN válida. Retorna true se autorizado, false se cancelado. */
  async function requirePinSession() {
    // O Painel Administrativo exige sessão JWT autenticada; PIN não é necessário.
    // O PIN continua valendo apenas no fluxo do garçom pelo cardápio (storefront).
    return true;
  }

  function showAppToast(message, { ms = 2200 } = {}) {
    let el = $('appToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'appToast';
      el.className = 'new-order-toast';
      el.hidden = true;
      document.body.appendChild(el);
    }
    el.innerHTML = `<span>${escapeHtml(message)}</span>`;
    el.hidden = false;
    el.classList.add('show');
    clearTimeout(el._hideTimer);
    el._hideTimer = setTimeout(() => {
      el.classList.remove('show');
      el.hidden = true;
    }, ms);
  }

  async function ensureDesktopNotificationPermission() {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;
    try {
      const result = await Notification.requestPermission();
      return result === 'granted';
    } catch (_) {
      return false;
    }
  }

  function pushDesktopNotification(title, body, { force = false } = {}) {
    if (!adminPrefs.desktopNotify || !('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;
    // Com a aba em foco e áudio ok, o som da página basta — senão usa o som do SO.
    const pageCanAlert = !document.hidden && document.hasFocus() && isAudioUnlocked();
    if (!force && pageCanAlert) return;
    try {
      const n = new Notification(title, {
        body,
        tag: 'delivery-admin-orders',
        renotify: true,
        silent: false
      });
      n.onclick = () => {
        try { window.focus(); } catch (_) { /* ignore */ }
        n.close();
      };
    } catch (_) { /* ignore */ }
  }

  /** @deprecated use isStoreAdmin / isPlatformDev */
  function isDev() {
    return isStoreAdmin() || isPlatformDev();
  }

  function decodeJwtPayload(jwt) {
    try {
      const part = String(jwt || '').split('.')[1];
      if (!part) return null;
      const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'));
      return JSON.parse(json);
    } catch (_) {
      return null;
    }
  }

  function roleFromToken(jwt) {
    const payload = decodeJwtPayload(jwt);
    if (!payload) return '';
    return payload.role
      || payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role']
      || '';
  }

  function authHeaders() {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`
    };
  }

  async function api(path, options = {}) {
    const res = await fetch(`${API}${path}`, options);
    if (res.status === 401) {
      logout();
      throw new Error('Não autorizado');
    }
    if (res.status === 403) {
      throw new Error('Sem permissão para esta ação.');
    }
    if (!res.ok) {
      const text = await res.text();
      let message = (text || '').trim() || res.statusText || `Erro HTTP ${res.status}`;
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) message = parsed.error;
      } catch (_) { /* texto puro */ }
      if (!message) message = `Erro HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function authUploadHeaders() {
    return { Authorization: `Bearer ${token}` };
  }

  function applyRoleUi() {
    const app = $('appView');
    const role = String(userRole || '').trim();
    if (app) {
      if (isPlatformDev()) app.dataset.role = 'Dev';
      else if (isStoreAdmin()) app.dataset.role = 'Admin';
      else app.dataset.role = 'Atendimento';
    }

    const badge = $('userBadge');
    if (badge) {
      if (username) {
        const display = accountDisplayName();
        const roleTxt = String(userRole || '').trim();
        badge.hidden = false;
        badge.textContent = roleTxt && roleTxt.toLowerCase() === display.toLowerCase()
          ? display
          : (roleTxt ? `${display} · ${roleTxt}` : display);
        badge.classList.toggle('role-dev', isPlatformDev());
        badge.classList.toggle('role-admin', isStoreAdmin());
        badge.classList.toggle('role-atendimento', !isPlatformDev() && !isStoreAdmin());
      } else {
        badge.hidden = true;
      }
    }

    document.querySelectorAll('[data-admin-only]').forEach((el) => {
      if (isStoreAdmin()) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    });
    document.querySelectorAll('[data-platform-only]').forEach((el) => {
      if (isPlatformDev()) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    });
    document.querySelectorAll('[data-orders-only]').forEach((el) => {
      if (canSeeOrders()) el.removeAttribute('hidden');
      else el.setAttribute('hidden', '');
    });
    updateTablesNavVisibility();

    document.querySelectorAll('[data-user-action]').forEach((el) => {
      const action = el.dataset.userAction;
      if (action === 'store') {
        if (isStoreAdmin()) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
      }
    });

    updateProfileSwitcherUi();

    if (isPlatformDev()) renderSystemsLinks();

    if (isPlatformDev() && !platformAllowedTabs().includes(activeTab)) {
      openTab('platform');
    } else if (isStoreAdmin() && platformAllowedTabs().includes(activeTab)) {
      openTab('orders');
    } else if (!canSeeOrders() && activeTab === 'orders') {
      openTab(isPlatformDev() ? 'platform' : 'dashboard');
    } else if (!isStoreAdmin() && !isPlatformDev() && activeTab !== 'orders' && activeTab !== 'mesas') {
      openTab('orders');
    }
  }

  function renderSystemsLinks() {
    const box = $('systemsLinks');
    if (!box) return;
    box.innerHTML = '';
    if (!isPlatformDev()) return;

    let host = 'localhost';
    try { host = new URL(API).hostname || 'localhost'; } catch (_) { /* keep */ }
    const local = host === 'localhost' || host === '127.0.0.1';

    const links = local
      ? [
          { title: 'Cardápio (storefront)', url: 'http://localhost:8080/', desc: 'App do cliente / PWA' },
          { title: 'Painel Admin', url: 'http://localhost:8081/', desc: 'Este painel' },
          { title: 'Gateway API · Health', url: 'http://localhost:5100/api/v1/health', desc: 'Entrada pública das APIs' },
          { title: 'Gateway · Store', url: 'http://localhost:5100/api/v1/store', desc: 'Configuração pública da loja' },
          { title: 'Catalog API · Health', url: 'http://localhost:5101/api/v1/health', desc: 'Direto no serviço (se exposto)' },
          { title: 'Orders API · Health', url: 'http://localhost:5102/api/v1/health', desc: 'Direto no serviço (se exposto)' },
          { title: 'Jaeger (tracing)', url: 'http://localhost:16686/', desc: 'Observabilidade OpenTelemetry' },
          { title: 'RabbitMQ Management', url: 'http://localhost:15672/', desc: 'guest / guest' },
          { title: 'OpenAPI Gateway', url: `${API}/openapi/v1.json`, desc: 'Contrato via gateway (se disponível)' }
        ]
      : [
          { title: 'Cardápio (Front)', url: 'https://delivery-fabin.vercel.app/', desc: 'Storefront remoto' },
          { title: 'Painel Admin', url: 'https://delivery-admin-fabin.vercel.app/', desc: 'Este painel (produção)' },
          { title: 'API Base (Back)', url: API, desc: 'Gateway Railway' },
          { title: 'Health', url: `${API}/api/v1/health`, desc: 'Saúde do gateway' },
          { title: 'Store', url: `${API}/api/v1/store`, desc: 'Dados públicos da loja' },
          { title: 'Banco (Railway)', url: 'https://railway.app/dashboard', desc: 'Painel do Postgres remoto' }
        ];

    links.forEach((item) => {
      const a = document.createElement('a');
      a.className = 'system-link';
      a.href = item.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.innerHTML =
        `<strong>${escapeHtml(item.title)}</strong>` +
        `<span class="muted">${escapeHtml(item.desc)}</span>` +
        `<code>${escapeHtml(item.url)}</code>`;
      box.appendChild(a);
    });
  }

  function platformAllowedTabs() {
    return ['platform', 'lojas', 'systems', 'bank'];
  }

  function getEnvironmentLinks() {
    let host = 'localhost';
    try { host = new URL(API).hostname || 'localhost'; } catch (_) { /* keep */ }
    const local = host === 'localhost' || host === '127.0.0.1';
    if (local) {
      return [
        { title: 'Cardápio', url: 'http://localhost:8080/' },
        { title: 'Admin', url: 'http://localhost:8081/' },
        { title: 'Gateway', url: 'http://localhost:5100/api/v1/health' },
        { title: 'Jaeger', url: 'http://localhost:16686/' },
        { title: 'RabbitMQ', url: 'http://localhost:15672/' }
      ];
    }
    return [
      { title: 'Cardápio', url: 'https://delivery-fabin.vercel.app/' },
      { title: 'Admin', url: 'https://delivery-admin-fabin.vercel.app/' },
      { title: 'API', url: API },
      { title: 'Health', url: `${API}/api/v1/health` },
      { title: 'Railway', url: 'https://railway.app/dashboard' }
    ];
  }

  async function probeHealth(path, label) {
    const started = performance.now();
    try {
      const res = await fetch(`${API}${path}`, { cache: 'no-store' });
      const ms = Math.round(performance.now() - started);
      let body = null;
      try { body = await res.json(); } catch (_) { /* ignore */ }
      return {
        label,
        path,
        ok: res.ok && String(body?.status || '').toLowerCase() !== 'unhealthy',
        ms,
        status: res.status,
        service: body?.service || label
      };
    } catch (err) {
      return {
        label,
        path,
        ok: false,
        ms: Math.round(performance.now() - started),
        status: 0,
        service: label,
        error: err.message || 'Falha de rede'
      };
    }
  }

  function productHasValidPrice(item) {
    const media = item?.priceMedia;
    const inteira = item?.priceInteira;
    const hasPortion = (media != null && Number(media) > 0) || (inteira != null && Number(inteira) > 0);
    if (hasPortion) return true;
    return item?.price != null && Number(item.price) > 0;
  }

  function summarizePlatformFinance(stores) {
    const list = Array.isArray(stores) ? stores : [];
    const active = list.filter((s) => s.active !== false);
    const inactive = list.filter((s) => s.active === false);
    const courtesy = list.filter((s) => s.courtesy || String(s.paymentStatus || '').toLowerCase() === 'courtesy');
    const overdue = list.filter((s) => String(s.paymentStatus || '').toLowerCase() === 'overdue');
    const pending = list.filter((s) => String(s.paymentStatus || '').toLowerCase() === 'pending');
    const paid = list.filter((s) => String(s.paymentStatus || '').toLowerCase() === 'paid');
    const billable = active.filter((s) =>
      !s.courtesy && String(s.paymentStatus || '').toLowerCase() !== 'courtesy'
    );
    const expectedMonthly = billable.reduce((sum, s) => sum + Number(s.monthlyFee || 0), 0);

    const since = Date.now() - 30 * 24 * 60 * 60 * 1000;
    let revenue30d = 0;
    list.forEach((s) => {
      (Array.isArray(s.payments) ? s.payments : []).forEach((p) => {
        const d = parseApiDate(p.paidAt);
        if (d && d.getTime() >= since) revenue30d += Number(p.amount || 0);
      });
    });

    const upcoming = active
      .filter((s) => s.nextDueAt && String(s.paymentStatus || '').toLowerCase() !== 'courtesy')
      .map((s) => ({ name: s.name, due: toDateInput(s.nextDueAt), fee: Number(s.monthlyFee || 0) }))
      .sort((a, b) => String(a.due).localeCompare(String(b.due)))
      .slice(0, 5);

    return {
      total: list.length,
      active: active.length,
      inactive: inactive.length,
      courtesy: courtesy.length,
      overdue: overdue.length,
      pending: pending.length,
      paid: paid.length,
      expectedMonthly,
      revenue30d,
      upcoming,
      overdueStores: overdue,
      inactiveStores: inactive
    };
  }

  function renderPlatformEnvLinks() {
    const box = $('platformEnvLinks');
    if (!box) return;
    box.innerHTML = getEnvironmentLinks().map((item) => {
      const href = safeExternalHref(item.url);
      if (!href) return '';
      return `<a class="platform-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>`;
    }).join('');
  }

  function renderPlatformDashKpis({ finance, healthOk, healthTotal, ordersToday, ordersRevenue, traffic }) {
    const box = $('platformDashKpis');
    if (!box) return;
    const apis = healthTotal
      ? (healthOk === healthTotal ? `${healthOk}/${healthTotal} OK` : `${healthOk}/${healthTotal}`)
      : '—';
    const cards = [
      { label: 'Lojas ativas', value: String(finance.active) },
      { label: 'Inadimplentes', value: String(finance.overdue) },
      { label: 'APIs', value: apis },
      { label: 'Visitas hoje', value: traffic ? String(traffic.pageviewsToday ?? 0) : '—' },
      { label: 'Hits API hoje', value: traffic ? String(traffic.apiHitsToday ?? 0) : '—' },
      { label: 'Pico (24h)', value: traffic?.peakHourLabel || '—' },
      { label: 'Pedidos hoje', value: ordersToday == null ? '—' : String(ordersToday) },
      { label: 'Mensalidades', value: money(finance.expectedMonthly) }
    ];
    box.innerHTML = cards.map((c) =>
      `<div class="dash-kpi"><span class="label">${escapeHtml(c.label)}</span>` +
      `<span class="value">${escapeHtml(c.value)}</span></div>`
    ).join('');
  }

  function renderPlatformTraffic(traffic) {
    const meta = $('platformTrafficMeta');
    const railway = $('platformRailwayHint');
    if (!traffic) {
      if (meta) meta.textContent = 'Tráfego indisponível.';
      if (railway) railway.innerHTML = '';
      destroyChartKey('platformHourly');
      destroyChartKey('platformDaily');
      return;
    }

    if (meta) {
      const top = Array.isArray(traffic.topRoutes) && traffic.topRoutes.length
        ? `Rotas: ${traffic.topRoutes.slice(0, 4).map((r) => `${r.route} (${r.count})`).join(' · ')}`
        : 'Sem rotas agregadas ainda.';
      meta.textContent =
        `Pico ${traffic.peakHourLabel || '—'} · ${traffic.peakHourCount || 0} eventos · ` +
        `7d: ${traffic.pageviewsPeriod || 0} visitas / ${traffic.apiHitsPeriod || 0} hits API · ${top}`;
    }

    if (railway && traffic.railway) {
      const r = traffic.railway;
      const href = safeExternalHref(r.dashboardUrl || 'https://railway.app/dashboard');
      railway.innerHTML =
        `<div class="platform-status-row"><strong>Railway / consumo</strong>` +
          (href ? `<a class="platform-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Usage</a>` : '') +
        `</div>` +
        `<p>${escapeHtml(r.estimatedNote || '')}</p>` +
        `<p class="muted">${escapeHtml(r.note || '')}</p>`;
    }

    const hourly = Array.isArray(traffic.last24Hours) ? traffic.last24Hours : [];
    const daily = Array.isArray(traffic.daily) ? traffic.daily : [];
    const hourCanvas = $('chartPlatformHourly');
    const dayCanvas = $('chartPlatformDaily');
    const defaults = chartDefaults();

    if (hourCanvas && typeof Chart !== 'undefined') {
      upsertChart('platformHourly', hourCanvas, {
        type: 'bar',
        data: {
          labels: hourly.map((h) => h.label),
          datasets: [
            {
              label: 'Visitas',
              data: hourly.map((h) => Number(h.pageviews || 0)),
              backgroundColor: 'rgba(56, 189, 248, 0.65)',
              borderRadius: 4
            },
            {
              label: 'API',
              data: hourly.map((h) => Number(h.apiHits || 0)),
              backgroundColor: 'rgba(167, 139, 250, 0.55)',
              borderRadius: 4
            }
          ]
        },
        options: {
          ...defaults,
          plugins: {
            ...defaults.plugins,
            legend: { labels: { color: '#cbd5e1', boxWidth: 12 } }
          }
        }
      });
    }

    if (dayCanvas && typeof Chart !== 'undefined') {
      upsertChart('platformDaily', dayCanvas, {
        type: 'line',
        data: {
          labels: daily.map((d) => {
            const raw = String(d.date || '');
            return raw.length >= 10 ? raw.slice(5) : raw;
          }),
          datasets: [
            {
              label: 'Visitas',
              data: daily.map((d) => Number(d.pageviews || 0)),
              borderColor: '#38bdf8',
              backgroundColor: 'rgba(56, 189, 248, 0.15)',
              tension: 0.3,
              fill: true
            },
            {
              label: 'API',
              data: daily.map((d) => Number(d.apiHits || 0)),
              borderColor: '#a78bfa',
              backgroundColor: 'rgba(167, 139, 250, 0.12)',
              tension: 0.3,
              fill: true
            }
          ]
        },
        options: {
          ...defaults,
          plugins: {
            ...defaults.plugins,
            legend: { labels: { color: '#cbd5e1', boxWidth: 12 } }
          }
        }
      });
    }
  }

  function destroyChartKey(key) {
    if (!chartInstances[key]) return;
    try { chartInstances[key].destroy(); } catch (_) { /* ignore */ }
    delete chartInstances[key];
  }

  function releaseCanvas(canvas) {
    if (!canvas || typeof Chart === 'undefined') return canvas;
    try {
      const existing = typeof Chart.getChart === 'function' ? Chart.getChart(canvas) : null;
      if (existing) existing.destroy();
    } catch (_) { /* ignore */ }
    return canvas;
  }

  function renderPlatformAlerts(alerts) {
    const box = $('platformDashAlerts');
    if (!box) return;
    if (!alerts.length) {
      box.hidden = false;
      box.innerHTML = '<div class="platform-alert ok">Nenhum alerta crítico no momento.</div>';
      return;
    }
    box.hidden = false;
    box.innerHTML = alerts.map((a) =>
      `<div class="platform-alert ${escapeHtml(a.level)}">${escapeHtml(a.text)}</div>`
    ).join('');
  }

  function renderPlatformHealth(results) {
    const box = $('platformHealthList');
    if (!box) return;
    box.innerHTML = results.map((r) => {
      const detail = r.ok
        ? `${r.ms} ms · HTTP ${r.status}`
        : (r.error || `HTTP ${r.status || '—'}`);
      return `<div class="platform-health-row">` +
        `<span><span class="health-dot ${r.ok ? 'ok' : 'fail'}"></span>${escapeHtml(r.label)}</span>` +
        `<span class="muted">${escapeHtml(detail)}</span>` +
        `</div>`;
    }).join('');
  }

  function renderPlatformStoreStatus(store, catalogError) {
    const box = $('platformStoreStatus');
    if (!box) return;
    if (!store) {
      box.innerHTML = `<p class="muted">${escapeHtml(catalogError || 'Não foi possível carregar a loja.')}</p>`;
      return;
    }
    const active = store.active !== false;
    const accepting = store.acceptingOrders !== false;
    const withinHours = isStoreOpenNow(store);
    let receivingLabel = 'Online';
    let receivingClass = 'pay-paid';
    if (!accepting) {
      receivingLabel = 'Encerrado';
      receivingClass = 'pay-overdue';
    } else if (!withinHours) {
      receivingLabel = 'Fora do horário';
      receivingClass = 'pay-pending';
    }
    box.innerHTML =
      `<div class="platform-status-row"><strong>Loja</strong><span>${escapeHtml(store.storeName || '—')}</span></div>` +
      `<div class="platform-status-row"><strong>Cardápio público</strong>` +
        `<span class="pay-badge ${active ? 'pay-paid' : 'pay-inactive'}">${active ? 'Ativo' : 'Inativo'}</span></div>` +
      `<div class="platform-status-row"><strong>Recebendo pedidos</strong>` +
        `<span class="pay-badge ${receivingClass}">${receivingLabel}</span></div>` +
      (catalogError ? `<p class="muted">${escapeHtml(catalogError)}</p>` : '');
  }

  function renderPlatformFinance(finance) {
    const box = $('platformFinance');
    if (!box) return;
    const upcoming = finance.upcoming.length
      ? finance.upcoming.map((u) =>
          `<li>${escapeHtml(u.name)} · ${escapeHtml(u.due || '—')} · ${escapeHtml(money(u.fee))}</li>`
        ).join('')
      : '<li class="muted">Sem vencimentos cadastrados.</li>';
    box.innerHTML =
      `<div class="platform-status-row"><span>Pagas</span><strong>${finance.paid}</strong></div>` +
      `<div class="platform-status-row"><span>A vencer / pendentes</span><strong>${finance.pending}</strong></div>` +
      `<div class="platform-status-row"><span>Em atraso</span><strong>${finance.overdue}</strong></div>` +
      `<div class="platform-status-row"><span>Cortesia</span><strong>${finance.courtesy}</strong></div>` +
      `<div class="platform-status-row"><span>Receita (30 dias)</span><strong>${escapeHtml(money(finance.revenue30d))}</strong></div>` +
      `<div><strong>Próximas cobranças</strong><ul class="platform-payments">${upcoming}</ul></div>`;
  }

  function renderPlatformCatalogSanity(sanity) {
    const box = $('platformCatalogSanity');
    if (!box) return;
    if (sanity.error) {
      box.innerHTML = `<p class="muted">${escapeHtml(sanity.error)}</p>`;
      return;
    }
    box.innerHTML =
      `<div class="platform-status-row"><span>Categorias (menu)</span><strong>${sanity.categories}</strong></div>` +
      `<div class="platform-status-row"><span>Produtos (menu)</span><strong>${sanity.products}</strong></div>` +
      `<div class="platform-status-row"><span>Sem preço válido</span><strong>${sanity.noPrice}</strong></div>` +
      (sanity.notes.length
        ? `<ul class="platform-payments">${sanity.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>`
        : '<p class="muted">Cardápio público sem inconsistências óbvias.</p>');
  }

  function renderPlatformDashStores(stores) {
    const box = $('platformDashStores');
    if (!box) return;
    if (!stores.length) {
      box.innerHTML = '<p class="muted">Nenhuma loja cadastrada.</p>';
      return;
    }
    box.innerHTML = stores.map((store) => {
      const chips =
        platformChipHtml(store.frontUrl || store.localFrontUrl, 'Front') +
        platformChipHtml(store.adminUrl || store.localAdminUrl, 'Admin');
      return `<div class="platform-dash-store${store.active === false ? ' inactive' : ''}">` +
        `<div class="platform-dash-store-meta">` +
          `<strong>${escapeHtml(store.name)}</strong>` +
          `<span class="pay-badge pay-${escapeHtml(store.paymentStatus || 'pending')}">${escapeHtml(paymentStatusLabel(store.paymentStatus))}</span>` +
          `${store.active === false ? '<span class="pay-badge pay-inactive">Inativa</span>' : ''}` +
          `${store.courtesy ? '<span class="pay-badge pay-courtesy">Cortesia</span>' : ''}` +
        `</div>` +
        `<div class="platform-quick-links">${chips || '<span class="muted">Sem links</span>'}</div>` +
      `</div>`;
    }).join('');
  }

  async function loadPlatformDashboard({ silent } = {}) {
    if (!token || !isPlatformDev()) return;
    const meta = $('platformDashMeta');
    if (meta) meta.textContent = 'Carregando…';
    renderPlatformEnvLinks();

    const healthPromises = [
      probeHealth('/api/v1/health', 'Gateway'),
      probeHealth('/api/v1/health/catalog', 'Catalog API'),
      probeHealth('/api/v1/health/orders', 'Orders API')
    ];

    const storesPromise = api('/api/v1/admin/platform-stores', { headers: authHeaders() })
      .catch((err) => {
        console.warn('Lojas plataforma', err);
        return null;
      });

    const storePromise = fetch(`${API}/api/v1/store`, { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Store HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => ({ __error: err.message || 'Falha ao carregar store' }));

    const catalogPromise = fetch(`${API}/api/v1/catalog`, { cache: 'no-store' })
      .then(async (res) => {
        if (res.status === 403) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error || 'Cardápio bloqueado (loja inativa).');
        }
        if (!res.ok) throw new Error(`Catálogo HTTP ${res.status}`);
        return res.json();
      })
      .catch((err) => ({ __error: err.message || 'Falha ao carregar catálogo' }));

    const ordersPromise = api('/api/v1/orders/dashboard?period=today', { headers: authHeaders() })
      .catch((err) => {
        console.warn('Pedidos dashboard (Dev)', err);
        return null;
      });

    const trafficPromise = api('/api/v1/admin/platform-traffic?days=7', { headers: authHeaders() })
      .catch((err) => {
        console.warn('Tráfego plataforma', err);
        return null;
      });

    const [healthResults, storesRaw, storeRaw, catalogRaw, ordersDash, traffic] = await Promise.all([
      Promise.all(healthPromises),
      storesPromise,
      storePromise,
      catalogPromise,
      ordersPromise,
      trafficPromise
    ]);

    if (Array.isArray(storesRaw)) platformStores = storesRaw;
    const finance = summarizePlatformFinance(platformStores);
    const healthOk = healthResults.filter((h) => h.ok).length;

    const store = storeRaw && !storeRaw.__error ? storeRaw : null;
    const storeError = storeRaw && storeRaw.__error ? storeRaw.__error : '';

    let catalogSanity = { categories: 0, products: 0, noPrice: 0, notes: [], error: '' };
    if (catalogRaw && catalogRaw.__error) {
      catalogSanity.error = catalogRaw.__error;
    } else {
      const categories = Array.isArray(catalogRaw?.categories) ? catalogRaw.categories : [];
      let products = 0;
      let noPrice = 0;
      const notes = [];
      categories.forEach((cat) => {
        if (/ingrediente/i.test(String(cat.title || '')) || String(cat.id || '').toLowerCase() === 'ingredientes') {
          notes.push(`Categoria “${cat.title || cat.id}” ainda visível no menu público.`);
        }
        (Array.isArray(cat.items) ? cat.items : []).forEach((item) => {
          products += 1;
          if (!productHasValidPrice(item)) {
            noPrice += 1;
            if (notes.length < 6) notes.push(`Produto sem preço: ${item.name || item.id}`);
          }
        });
      });
      catalogSanity = { categories: categories.length, products, noPrice, notes, error: '' };
    }

    const alerts = [];
    healthResults.forEach((h) => {
      if (!h.ok) alerts.push({ level: 'danger', text: `${h.label} indisponível (${h.error || `HTTP ${h.status}`}).` });
    });
    if (store && store.active === false) {
      alerts.push({ level: 'danger', text: 'Cardápio público está inativo (loja da plataforma marcada como inativa).' });
    }
    if (store && store.acceptingOrders === false) {
      alerts.push({ level: 'warn', text: 'Loja não está aceitando pedidos (expediente encerrado).' });
    }
    finance.overdueStores.forEach((s) => {
      alerts.push({ level: 'danger', text: `Mensalidade em atraso: ${s.name}.` });
    });
    finance.inactiveStores.forEach((s) => {
      alerts.push({ level: 'warn', text: `Loja da plataforma inativa: ${s.name}.` });
    });
    if (catalogSanity.noPrice > 0) {
      alerts.push({ level: 'warn', text: `${catalogSanity.noPrice} produto(s) no menu sem preço válido.` });
    }
    if (catalogSanity.error) {
      alerts.push({ level: 'warn', text: `Catálogo: ${catalogSanity.error}` });
    }

    const ordersToday = ordersDash ? (ordersDash.ordersToday ?? ordersDash.totalOrders) : null;
    const ordersRevenue = ordersDash ? ordersDash.grossRevenue : null;

    renderPlatformDashKpis({
      finance,
      healthOk,
      healthTotal: healthResults.length,
      ordersToday,
      ordersRevenue,
      traffic
    });
    renderPlatformAlerts(alerts);
    renderPlatformHealth(healthResults);
    renderPlatformStoreStatus(store, storeError);
    renderPlatformFinance(finance);
    renderPlatformCatalogSanity(catalogSanity);
    renderPlatformDashStores(platformStores);
    renderPlatformTraffic(traffic);

    if (meta) {
      meta.textContent = `Atualizado ${formatDateTime(new Date().toISOString())}` +
        (ordersDash ? '' : ' · pedidos agregados indisponíveis') +
        (traffic ? '' : ' · tráfego indisponível');
    }
    if (!silent && !storesRaw) {
      throw new Error('Não foi possível carregar as lojas da plataforma.');
    }
  }

  // ── Mesas (consumo no local) ──
  let tables = [];
  let tablesDineInEnabled = false;

  function updateTablesNavVisibility() {
    const nav = document.querySelector('[data-mesas-nav]');
    if (!nav) return;
    const visible = canSeeOrders() && tablesDineInEnabled;
    if (visible) nav.removeAttribute('hidden');
    else nav.setAttribute('hidden', '');
    if (!visible && activeTab === 'mesas' && canSeeOrders()) {
      openTab('orders');
    }
  }

  function updateTablesNavCount() {
    const nav = document.querySelector('[data-mesas-nav]');
    if (!nav) return;
    const label = nav.querySelector('.nav-label');
    if (!label) return;
    const occupied = tables.filter((t) => tableHasSession(t)).length;
    label.textContent = occupied > 0 ? `Mesas (${occupied})` : 'Mesas';
  }

  async function loadStoreConfigTablesFlags() {
    try {
      const cfg = await api('/api/v1/store');
      tablesDineInEnabled = !!(cfg && cfg.dineInEnabled);
      const badge = $('mesasDineInBadge');
      if (badge) {
        if (tablesDineInEnabled) {
          badge.hidden = true;
        } else {
          badge.hidden = false;
          badge.textContent = 'Dine-in desativado';
        }
      }
      updateTablesNavVisibility();
    } catch (_) {
      tablesDineInEnabled = false;
    }
  }

  // Cria (idempotente) as mesas "Mesa 1"…"Mesa N" a partir da quantidade configurada.
  async function ensureTablesForCount(count) {
    const n = Math.min(200, Math.max(1, Math.round(count)));
    const res = await api('/api/v1/admin/tables', { headers: authHeaders() });
    const existing = Array.isArray(res) ? res : [];
    const existingLabels = new Set((existing || []).map((t) => (t.label || '').trim().toLowerCase()));
    let created = 0;
    for (let i = 1; i <= n; i++) {
      const label = `Mesa ${i}`;
      if (existingLabels.has(label.toLowerCase())) continue;
      try {
        await api('/api/v1/admin/tables', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ label, capacity: 4 })
        });
        created++;
      } catch (e) {
        console.warn(`Erro ao criar ${label}`, e);
      }
    }
    return created;
  }

  async function loadTablesTab({ silent = false } = {}) {
    loadStoreConfigTablesFlags().catch(() => {});
    const meta = $('tablesMeta');
    const grid = $('tablesGrid');
    if (!silent) {
      if (meta) meta.textContent = 'Carregando mesas…';
      if (grid) grid.innerHTML = '';
    }
    try {
      const res = await api('/api/v1/admin/tables', { headers: authHeaders() });
      tables = sortTablesList(res);
      await enrichTablesAccessCodes();
      renderTablesGrid();
      if (meta) {
        const occupied = tables.filter((t) => tableHasSession(t)).length;
        meta.textContent = `${tables.length} mesa(s) · ${occupied} ocupada(s)`;
      }
      if (!tablesDineInEnabled) {
        await loadStoreConfigTablesFlags();
      }
      updateTablesNavCount();
    } catch (err) {
      if (meta) meta.textContent = err.message || 'Não foi possível carregar as mesas.';
      tables = [];
      renderTablesGrid();
      updateTablesNavCount();
    }
  }

  function sortTablesList(list) {
    return (Array.isArray(list) ? list : []).sort((a, b) => {
      const labelA = String(a?.label || '').trim();
      const labelB = String(b?.label || '').trim();
      const numberA = Number(labelA.match(/\d+/)?.[0]);
      const numberB = Number(labelB.match(/\d+/)?.[0]);
      const hasNumberA = Number.isFinite(numberA);
      const hasNumberB = Number.isFinite(numberB);
      if (hasNumberA && hasNumberB && numberA !== numberB) return numberA - numberB;
      if (hasNumberA !== hasNumberB) return hasNumberA ? -1 : 1;
      return labelA.localeCompare(labelB, 'pt-BR', { numeric: true, sensitivity: 'base' });
    });
  }

  // Snapshot leve das mesas (sem render/acessar códigos) mantém a aba
  // "Entregue na mesa" precisa enquanto o usuário está no acompanhamento de pedidos.
  async function refreshTablesSnapshot() {
    try {
      const res = await api('/api/v1/admin/tables', { headers: authHeaders() });
      tables = sortTablesList(res);
      updateTablesNavCount();
    } catch (_) { /* best-effort: mantém o snapshot anterior */ }
  }

  function tableStorefrontUrl(accessCode) {
    return `${storeFrontBaseUrl()}/?table=${encodeURIComponent(accessCode)}`;
  }

  // Gera QR Code via API pública de QR (sem biblioteca adicional) — fallback para texto simples
  function qrCodeDataUrl(text, size = 220) {
    const apiUrl = `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}`;
    return apiUrl;
  }

  // Mesa "em atendimento" = tem comanda(s) na sessão atual (abertas ou pagas).
  // Comanda paga fica visível (verde "Pago") até o fechamento oficial da mesa.
  function tableHasSession(t) {
    if (Number(t?.sessionOrders) > 0) return true;
    return Number(t?.openOrders) > 0;
  }

  // Mesa ainda ocupada = tem sessão ativa na lista de mesas carregada.
  // Usada pela aba "Entregue na mesa" (pedido entregue, mesa ainda em atendimento).
  function tableIsOccupied(tableId) {
    if (tableId == null) return false;
    const t = tables.find((x) => Number(x.id) === Number(tableId));
    return !!t && tableHasSession(t);
  }

  // Comanda paga = pagamento confirmado (independente de já entregue).
  function comandaIsPaid(c) {
    return String(c?.paymentStatus).toLowerCase() === 'confirmed';
  }

  async function renderTablesGrid() {
    const grid = $('tablesGrid');
    if (!grid) return;
    if (!tables.length) {
      grid.innerHTML = '<p class="muted">Nenhuma mesa cadastrada. Clique em “+ Nova mesa” para começar.</p>';
      return;
    }
    const comandasByTable = new Map();
    const comandasByOrder = new Map();
    const sessionTables = tables.filter((t) => tableHasSession(t));
    await Promise.all(sessionTables.map(async (t) => {
      try {
        const res = await api(`/api/v1/orders/table/${t.id}`, { headers: authHeaders() });
        if (!Array.isArray(res)) return;
        // Comandas em ordem de criação (mais antiga primeiro).
        const list = [...res]
          .sort((a, b) => new Date(a.createdAtUtc || 0) - new Date(b.createdAtUtc || 0));
        comandasByTable.set(t.id, list);
        list.forEach((c) => comandasByOrder.set(String(c.orderId), c));
      } catch (_) { /* mantém sem comandas */ }
    }));
    const cards = tables.map((t) => {
      const occupied = tableHasSession(t);
      const paidOnly = occupied && Number(t.openOrders) === 0;
      const comandas = comandasByTable.get(t.id) || [];
      const hasReady = comandas.some((c) => c.status === 'ReadyForTable');
      let cls = 'is-free';
      if (!t.active) cls = 'is-inactive';
      else if (occupied) cls = 'is-occupied';
      if (hasReady) cls += ' has-ready-order';
      const label = t.label || ('Mesa ' + t.tableNumber);
      const meta = !t.active
        ? 'Inativa'
        : (occupied
            ? (paidOnly
                ? `${t.sessionOrders} comanda(s) paga(s) · ${money(t.sessionTotal)}`
                : `${t.openOrders} pedido(s) aberto(s) · ${money(t.openOrdersTotal)}`)
            : 'Toque para fazer o pedido');
      const comandasBlock = comandas.length
        ? `<div class="mesas-comandas">` +
          comandas.map((c) => {
            const paid = comandaIsPaid(c);
            const eyeCls = c.status === 'ReadyForTable'
              ? ' mesas-comanda-eye is-ready'
              : (c.status === 'Delivered'
                  ? ' mesas-comanda-eye is-delivered'
                  : ' mesas-comanda-eye');
            return `<div class="mesas-comanda-row${paid ? ' is-paid' : ''}">` +
              (paid ? `<span class="mesas-comanda-paid">Pago</span>` : '') +
              `<span class="mesas-comanda-total">${money(c.total)}</span>` +
              `<button type="button" class="${eyeCls}" data-comanda-eye="${escapeHtml(String(c.orderId))}" title="Ver itens do pedido">${EYE_ICON_SVG}</button>` +
              `</div>`;
          }).join('') +
          `</div>`
        : '';
      const topBadge = !t.active
        ? `<span class="status-badge status-Inactive">Inativa</span>`
        : (occupied
            ? `<span class="status-badge status-Ocupada">Ocupada</span>`
            : `<span class="status-badge status-Livre">Livre</span>`);
      return (
        `<div class="mesas-table-card ${cls}" data-table-menu="${escapeHtml(String(t.id))}" title="Abrir cardápio da ${escapeHtml(label)}">` +
        (occupied
          ? `<button type="button" class="table-card-x" data-table-close-x="${escapeHtml(String(t.id))}" aria-label="Fechar mesa" title="Fechar mesa">✕</button>`
          : '') +
        `<div class="mesas-card-top">` +
        `<span class="mesas-table-num">${escapeHtml(label)}</span>` +
        (t.responsibleName ? `<span class="mesas-responsible">${escapeHtml(t.responsibleName)}</span>` : '') +
        topBadge +
        `</div>` +
        `<div class="mesas-table-meta">${escapeHtml(meta)}</div>` +
        comandasBlock +
        (occupied
          ? `<div class="mesas-card-foot">` +
            `<button type="button" class="ghost compact mesas-foot-btn" data-table-comanda="${escapeHtml(String(t.id))}">Comanda</button>` +
            `<button type="button" class="primary compact mesas-foot-btn" data-table-new-order="${escapeHtml(String(t.id))}">Novo pedido</button>` +
            `</div>`
          : '') +
        `<div class="table-card-actions">` +
          `<button type="button" class="ghost compact" data-table-print="${escapeHtml(String(t.id))}">QR</button>` +
          (isStoreAdmin() ? `<button type="button" class="ghost compact" data-table-toggle="${escapeHtml(String(t.id))}" ${occupied ? 'disabled title="Não é possível desativar mesa ocupada."' : ''}>${t.active ? 'Desativar' : 'Ativar'}</button>` : '') +
          `<button type="button" class="ghost compact" data-table-edit="${escapeHtml(String(t.id))}">Editar</button>` +
          (isStoreAdmin() ? `<button type="button" class="ghost compact" data-table-delete="${escapeHtml(String(t.id))}" ${occupied ? 'disabled title="Não é possível excluir mesa ocupada."' : ''}>Excluir</button>` : '') +
          `</div>` +
        `</div>`
      );
    }).join('');
    grid.innerHTML = `<div class="tables-grid-inner">${cards}</div>`;
    grid.querySelectorAll('[data-table-close-x]').forEach((btn) => {
      const id = Number(btn.getAttribute('data-table-close-x'));
      const table = tables.find((x) => x.id === id);
      if (!table) return;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        fecharTable(table).catch((e) => showAppToast(e.message || 'Erro ao fechar a mesa'));
      });
    });
    grid.querySelectorAll('[data-comanda-eye]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        askComandaItems(comandasByOrder.get(btn.getAttribute('data-comanda-eye')));
      });
    });
    grid.querySelectorAll('[data-table-comanda]').forEach((btn) => {
      const id = Number(btn.getAttribute('data-table-comanda'));
      const table = tables.find((x) => x.id === id);
      if (!table) return;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openTableComanda(table).catch((e) => showAppToast(e.message || 'Erro ao abrir a comanda'));
      });
    });
    grid.querySelectorAll('[data-table-new-order]').forEach((btn) => {
      const id = Number(btn.getAttribute('data-table-new-order'));
      const table = tables.find((x) => x.id === id);
      if (!table) return;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        openWaiterMenuForTable(table);
      });
    });
    grid.querySelectorAll('[data-table-print]').forEach((btn) => {
      const id = Number(btn.getAttribute('data-table-print'));
      const table = tables.find((x) => x.id === id);
      if (!table) return;
      btn.addEventListener('click', () => printTableLabel(table));
    });
    grid.querySelectorAll('[data-table-toggle]').forEach((btn) => {
      const id = Number(btn.getAttribute('data-table-toggle'));
      const table = tables.find((x) => x.id === id);
      if (!table) return;
      btn.addEventListener('click', () => toggleTable(id, table.active));
    });
    grid.querySelectorAll('[data-table-edit]').forEach((btn) => {
      const id = Number(btn.getAttribute('data-table-edit'));
      const table = tables.find((x) => x.id === id);
      if (!table) return;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (isStoreAdmin()) {
          openTableModal(table);
        } else {
          openWaiterEditTableModal(table);
        }
      });
    });
    grid.querySelectorAll('[data-table-delete]').forEach((btn) => {
      const id = Number(btn.getAttribute('data-table-delete'));
      const table = tables.find((x) => x.id === id);
      if (!table) return;
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        deleteTable(table).catch((e) => showAppToast(e.message || 'Erro ao excluir a mesa'));
      });
    });
    grid.querySelectorAll('[data-table-menu]').forEach((el) => {
      const id = Number(el.getAttribute('data-table-menu'));
      const table = tables.find((x) => x.id === id);
      if (!table) return;
      el.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;
        openWaiterMenuForTable(table);
      });
    });
  }

  const EYE_ICON_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';

  function askComandaItems(comanda) {
    if (!comanda) return;
    const existing = $('comandaItemsModal');
    if (existing) existing.remove();
    const items = (comanda.items || []).map((it) => {
      const info = splitItemCustomization(it.name);
      const detail = itemCustomizationHtml(it);
      return (
        `<li class="${detail ? 'has-detail' : ''}">` +
        `<div class="comanda-item-line"><span><strong>${it.quantity}×</strong> ${escapeHtml(info.name)}</span>` +
        `<span class="muted"> · ${money(it.price)}</span></div>` +
        detail +
        `</li>`
      );
    }).join('') || '<li class="muted">Sem itens.</li>';
    const modal = document.createElement('div');
    modal.id = 'comandaItemsModal';
    modal.className = 'confirm-modal';
    modal.innerHTML =
      `<div class="confirm-modal-card comanda-items-card" role="dialog" aria-modal="true" aria-labelledby="comandaItemsTitle">` +
      `<div class="confirm-modal-head">` +
      `<h3 id="comandaItemsTitle">Pedido ${escapeHtml(comanda.orderId)}</h3>` +
      `<span class="status-badge status-${escapeHtml(comanda.status)}">${escapeHtml(comanda.statusLabel || comanda.status)}</span>` +
      `</div>` +
      `<ul class="comanda-items-list">${items}</ul>` +
      `<p class="comanda-items-total muted">Total: <strong>${money(comanda.total)}</strong></p>` +
      `</div>`;
    document.body.appendChild(modal);
    const done = () => {
      modal.remove();
      document.removeEventListener('keydown', onKey);
    };
    const onKey = (e) => { if (e.key === 'Escape') done(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) done(); });
    document.addEventListener('keydown', onKey);
  }

  async function toggleTable(id, active) {
    try {
      const t = tables.find((x) => x.id === id);
      if (t && tableHasSession(t)) {
        showAppToast('Não é possível desativar mesa com comandas em aberto.');
        return;
      }
      await api(`/api/v1/admin/tables/${id}/active`, {
        method: 'PATCH',
        headers: authHeaders()
      });
      showAppToast(active ? 'Mesa desativada.' : 'Mesa ativada.');
      await loadTablesTab();
    } catch (e) {
      showAppToast(e.message || 'Erro ao alternar a mesa.');
    }
  }

  function printTableLabel(table) {
    const content = `Mesa: ${table.label}`;
    const url = tableStorefrontUrl(table.accessCode || '');
    const win = window.open('', '_blank', 'width=420,height=600');
    if (!win) { showAppToast('Pop-up bloqueado. Habilite para imprimir o QR.'); return; }
    win.document.write(
      `<html><head><title>QR Code - ${escapeHtml(table.label)}</title></head>` +
      `<body style="font-family:sans-serif;text-align:center;padding:20px;">` +
      `<h2>Mesa ${escapeHtml(table.label)}</h2>` +
      `<p>Escaneie para fazer o pedido</p>` +
      `<img src="${qrCodeDataUrl(url, 400)}" style="width:min(360px,80vw);height:auto;" alt="QR Code da mesa" />` +
      `<p style="font-size:12px;color:#888;word-break:break-all;">${escapeHtml(url)}</p>` +
      `<button onclick="window.print()" style="margin-top:20px;padding:10px 20px;">Imprimir</button>` +
      `</body></html>`
    );
    win.document.close();
  }

  function openTableModal(table) {
    const existing = $('tableModal');
    if (existing) existing.remove();
    const isEdit = !!table;
    const lastTableNumber = (tables || []).reduce((max, current) => {
      const match = String(current?.label || '').match(/\d+/);
      const number = match ? Number(match[0]) : 0;
      return Number.isFinite(number) ? Math.max(max, number) : max;
    }, 0);
    const defaultTableLabel = isEdit ? table.label : `Mesa ${lastTableNumber + 1}`;
    const modal = document.createElement('div');
    modal.id = 'tableModal';
    modal.className = 'confirm-modal';
    modal.innerHTML =
      `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="tableModalTitle">` +
      `<h3 id="tableModalTitle">${isEdit ? 'Editar mesa' : 'Nova mesa'}</h3>` +
      `<label class="field-label">Nome/etiqueta da mesa (ex.: Mesa 1)</label>` +
      `<input id="tableLabelInput" class="type-confirm-input" type="text" value="${escapeHtml(defaultTableLabel)}" placeholder="Mesa 1" />` +
      `<label class="field-label">Capacidade (pessoas, opcional)</label>` +
      `<input id="tableCapacityInput" class="type-confirm-input" type="number" min="1" value="${table && table.capacity ? table.capacity : ''}" placeholder="Ex.: 4" />` +
      `<label class="check-label"><input id="tableAllowCustomerInput" type="checkbox" ${(!isEdit || table.allowCustomerOrder) ? 'checked' : ''}/> Permitir pedido do cliente (QR Code)</label>` +
      `<div class="confirm-modal-actions">` +
      `<button type="button" class="confirm" data-table-save>${isEdit ? 'Salvar' : 'Criar mesa'}</button>` +
      `<button type="button" class="ghost compact" data-table-cancel>Cancelar</button>` +
      `</div></div>`;
    const finish = () => modal.remove();
    const onKey = (e) => { if (e.key === 'Escape') finish(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) finish(); });
    modal.querySelector('[data-table-cancel]').addEventListener('click', finish);
    modal.querySelector('[data-table-save]').addEventListener('click', async () => {
      const label = ($('tableLabelInput') || {}).value?.trim?.() || '';
      const capacityVal = ($('tableCapacityInput') || {}).value?.trim?.() || '';
      const capacity = capacityVal ? Number(capacityVal) : null;
      const allowCustomerOrder = !!($('tableAllowCustomerInput') || {}).checked;
      if (!label) { showAppToast('Informe o nome da mesa.'); return; }
      saveTableModalButtonLoading(modal, true);
      try {
        let created;
        if (isEdit) {
          await api(`/api/v1/admin/tables/${table.id}`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({ label, capacity, allowCustomerOrder })
          });
          created = null;
        } else {
          created = await api('/api/v1/admin/tables', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ label, capacity, allowCustomerOrder })
          });
        }
        finish();
        showAppToast(isEdit ? 'Mesa atualizada.' : 'Mesa criada.');
        await loadTablesTab();
        if (!isEdit && created && created.accessCode) {
          // Mostra o QR logo após criar
          const print = await askConfirm(
            `Mesa criada com sucesso! Deseja imprimir o QR Code para colocar na mesa agora?`,
            { title: 'QR Code pronto', confirmLabel: 'Imprimir QR', cancelLabel: 'Fechar' }
          );
          if (print) printTableLabel({ label: created.label, accessCode: created.accessCode });
        }
      } catch (e) {
        showAppToast(e.message || 'Erro ao salvar a mesa.');
      } finally {
        saveTableModalButtonLoading(modal, false);
      }
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);
  }

  function saveTableModalButtonLoading(modal, loading) {
    const btn = modal && modal.querySelector('[data-table-save]');
    if (!btn) return;
    btn.disabled = loading;
    btn.textContent = loading ? 'Salvando…' : btn.dataset.originalText || btn.textContent;
    if (!btn.dataset.originalText) btn.dataset.originalText = btn.textContent;
  }

  function openWaiterEditTableModal(table) {
    if (!table) return;
    const existing = $('waiterTableInfoModal');
    if (existing) existing.remove();
    const modal = document.createElement('div');
    modal.id = 'waiterTableInfoModal';
    modal.className = 'confirm-modal';
    modal.innerHTML =
      `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="waiterTableInfoTitle">` +
      `<h3 id="waiterTableInfoTitle">Editar mesa</h3>` +
      `<p class="muted" style="margin:0 0 0.75rem">${escapeHtml(table.label)}</p>` +
      `<label class="field-label">Nome do responsável</label>` +
      `<input id="waiterResponsibleInput" class="type-confirm-input" type="text" value="${escapeHtml(table.responsibleName || '')}" placeholder="Ex.: João" maxlength="120" />` +
      `<label class="field-label">Quantidade de pessoas</label>` +
      `<input id="waiterGuestCountInput" class="type-confirm-input" type="number" min="1" max="200" value="${table.guestCount || ''}" placeholder="Ex.: 4" />` +
      `<div class="confirm-modal-actions">` +
      `<button type="button" class="confirm" data-waiter-table-save>Salvar</button>` +
      `<button type="button" class="ghost compact" data-waiter-table-cancel>Cancelar</button>` +
      `</div></div>`;
    const finish = () => modal.remove();
    const onKey = (e) => { if (e.key === 'Escape') finish(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) finish(); });
    document.addEventListener('keydown', onKey);
    modal.querySelector('[data-waiter-table-cancel]').addEventListener('click', finish);
    modal.querySelector('[data-waiter-table-save]').addEventListener('click', async () => {
      const responsibleName = ($('waiterResponsibleInput') || {}).value?.trim?.() || '';
      const guestCountVal = ($('waiterGuestCountInput') || {}).value?.trim?.() || '';
      const guestCount = guestCountVal ? Number(guestCountVal) : null;
      const btn = modal.querySelector('[data-waiter-table-save]');
      if (btn) { btn.disabled = true; btn.textContent = 'Salvando…'; }
      try {
        await api(`/api/v1/admin/tables/${table.id}/info`, {
          method: 'PATCH',
          headers: authHeaders(),
          body: JSON.stringify({ responsibleName: responsibleName || null, guestCount })
        });
        finish();
        showAppToast('Mesa atualizada.');
        await loadTablesTab();
      } catch (e) {
        showAppToast(e.message || 'Erro ao salvar as informações da mesa.');
        if (btn) { btn.disabled = false; btn.textContent = 'Salvar'; }
      }
    });
    document.body.appendChild(modal);
    ($('waiterResponsibleInput') || {}).focus?.();
  }

  // ── Fechar mesa + divisão de conta ──
  const CLOSE_PAY_METHODS = ['Pix', 'Dinheiro', 'Cartão de Crédito', 'Cartão de Débito'];

  function roundMoney(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
  }

  // Regras de divisão: quem estiver marcado como "valor fixo" paga o valor
  // digitado; o restante divide a sobra igualmente. Assim, se uma pessoa paga
  // a mais (ex.: cobre parte da conta), o restante é distribuído entre as demais.
  function computeBillSplit(total, tip, people) {
    const amountToCollect = roundMoney(roundMoney(total) + roundMoney(tip));
    const fixedIndices = [];
    const dynamicIndices = [];
    people.forEach((p, i) => (p.fixed ? fixedIndices : dynamicIndices).push(i));
    let fixedSum = 0;
    fixedIndices.forEach((i) => { fixedSum = roundMoney(fixedSum + roundMoney(people[i].amount)); });
    const fixedClamped = Math.min(fixedSum, amountToCollect);
    const perDynamic = dynamicIndices.length > 0 ? roundMoney((amountToCollect - fixedClamped) / dynamicIndices.length) : 0;
    let assigned = 0;
    const result = people.map((p) => ({ name: p.name, amount: 0, fixed: p.fixed }));
    fixedIndices.forEach((i) => {
      result[i].amount = roundMoney(people[i].amount);
      assigned = roundMoney(assigned + result[i].amount);
    });
    dynamicIndices.forEach((i, k) => {
      const isLast = k === dynamicIndices.length - 1;
      let val = isLast ? roundMoney(amountToCollect - assigned) : perDynamic;
      if (val < 0) val = 0;
      result[i].amount = roundMoney(val);
      assigned = roundMoney(assigned + val);
    });
    return {
      amountToCollect,
      total: roundMoney(total),
      tip: roundMoney(tip),
      result,
      sum: assigned,
      diff: roundMoney(assigned - amountToCollect),
      overpay: roundMoney(fixedSum - amountToCollect)
    };
  }

  function printBillSplit(table, comandas, split) {
    const rows = split.result.map((p, idx) =>
      `${idx + 1}. ${(p.name || `Pessoa ${idx + 1}`).toUpperCase()} .......... ${money(p.amount)}`
    ).join('\n');
    const win = window.open('', '_blank', 'width=420,height=620');
    if (!win) { showAppToast('Pop-up bloqueado. Habilite para imprimir a cobrança.'); return; }
    const comandaRows = comandas.map((c) => {
      const items = (c.items || []).map((it) => {
        const info = splitItemCustomization(it.name);
        const details = itemCustomizationText(it)
          .map((txt) => `<div style="padding-left:20px;font-size:12px;color:#555;">${escapeHtml(txt)}</div>`)
          .join('');
        return `<div style="padding-left:10px;font-size:13px;">${it.quantity}× ${escapeHtml(info.name)} — ${money(it.price || 0)}</div>${details}`;
      }).join('');
      return `<tr><td><strong>${escapeHtml(c.orderId)}</strong>${items}</td><td style="text-align:right;vertical-align:top;white-space:nowrap;"><strong>${money(c.total || 0)}</strong></td></tr>`;
    }).join('');
    win.document.write(
      `<html><head><title>Cobrança - ${escapeHtml(table.label)}</title></head>` +
      `<body style="font-family:monospace;max-width:360px;margin:20px auto;font-size:14px;">` +
      `<h2 style="text-align:center;margin:0 0 4px;">${escapeHtml(table.label)}</h2>` +
      `<p style="text-align:center;margin:0 0 12px;">${new Date().toLocaleString('pt-BR')}</p>` +
      `<table style="width:100%;border-collapse:collapse;">${comandaRows}</table>` +
      `<hr/>` +
      `<p>Total: ${money(split.total)}</p>` +
      (split.tip > 0 ? `<p>Gorjeta: ${money(split.tip)}</p>` : '') +
      `<p><strong>Total a cobrar: ${money(split.amountToCollect)}</strong></p>` +
      `<hr/><h3>Dividir entre ${split.result.length} pessoa(s)</h3>` +
      `<pre style="white-space:pre-wrap;">${escapeHtml(rows)}</pre>` +
      (split.diff !== 0 ? `<p style="color:#b45309;">Diferença de centavos: ${money(split.diff)}</p>` : '') +
      `<button onclick="window.print()" style="margin-top:20px;padding:10px 20px;">Imprimir</button>` +
      `</body></html>`
    );
    win.document.close();
  }

  function showCloseReceipt(table, comandas, split) {
    return new Promise((resolve) => {
      const existing = $('closeReceiptModal');
      if (existing) existing.remove();
      const rows = split.result.map((p, idx) =>
        `<div class="comanda-row-foot" style="justify-content:space-between;margin-top:6px;">` +
        `<span>${escapeHtml(p.name || `Pessoa ${idx + 1}`)}</span>` +
        `<strong>${money(p.amount)}</strong>` +
        `</div>`
      ).join('');
      const modal = document.createElement('div');
      modal.id = 'closeReceiptModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card comanda-card" role="dialog" aria-modal="true" aria-labelledby="closeReceiptTitle">` +
        `<h3 id="closeReceiptTitle">Mesa fechada — ${escapeHtml(table.label)}</h3>` +
        `<p class="muted">Total cobrado: <strong>${money(split.amountToCollect)}</strong> · ${split.result.length} pagante(s)</p>` +
        `<div class="comanda-list">${rows}</div>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-receipt-print>Visualizar comprovante</button>` +
        `<button type="button" class="ghost" data-receipt-close>Concluir</button>` +
        `</div></div>`;
      document.body.appendChild(modal);
      const done = (v) => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      modal.querySelector('[data-receipt-close]')?.addEventListener('click', () => done(null));
      modal.querySelector('[data-receipt-print]')?.addEventListener('click', () => printBillSplit(table, comandas, split));
      modal.addEventListener('click', (e) => { if (e.target === modal) done(null); });
      document.addEventListener('keydown', onKey);
    });
  }

  function askFecharMesa(table, comandas) {
    return new Promise((resolve) => {
      const existing = $('closeTableModal');
      if (existing) existing.remove();
      const paidComandas = comandas.filter((c) => comandaIsPaid(c));
      // A divisão da conta cobre apenas o que ainda NÃO foi pago; pagas ficam como registro.
      const outstanding = comandas.filter((c) => !comandaIsPaid(c));
      const total = outstanding.reduce((s, c) => s + (Number(c.total) || 0), 0);
      const rows = comandas.map((c) => {
        const items = (c.items || []).map((it) => `${it.quantity}× ${escapeHtml(splitItemCustomization(it.name).name)}${escapeHtml(itemCustomizationInline(it))}`).join(', ') || 'Sem itens';
        const paid = comandaIsPaid(c);
        return (
          `<div class="comanda-row${paid ? ' is-paid' : ''}">` +
          `<div class="comanda-row-head">` +
          `<strong>${escapeHtml(c.orderId)}</strong>` +
          (paid
            ? `<span class="status-badge status-Pago">Pago</span>`
            : `<span class="status-badge status-${escapeHtml(c.status)}">${escapeHtml(c.statusLabel || c.status)}</span>`) +
          `</div>` +
          `<div class="comanda-row-items">${items}</div>` +
          `<div class="comanda-row-foot"><span>Total: ${money(c.total)}</span>${paid ? `<span class="muted">Pago</span>` : ''}</div>` +
          `</div>`
        );
      }).join('');

      const cashSectionHtml =
        `<div id="closeCashSection" class="close-cash-section" hidden>` +
        `<label class="field-label">Valor recebido (R$)</label>` +
        `<input id="closeCashReceived" class="type-confirm-input" type="number" min="0" step="0.01" value="${total.toFixed(2)}" />` +
        `<p id="closeCashChange" class="close-cash-change"></p>` +
        `</div>`;

      const splitSectionHtml =
        `<div id="closeSplitSection" class="close-split-section" hidden>` +
        `<label class="field-label">Quantas pessoas pagam?</label>` +
        `<input id="closePeopleCount" class="type-confirm-input" type="number" min="1" max="50" value="1" />` +
        `<label class="field-label">Gorjeta (R$, opcional)</label>` +
        `<input id="closeTip" class="type-confirm-input" type="number" min="0" step="0.01" value="0.00" />` +
        `<div id="closePeopleRows" class="close-people-rows"></div>` +
        `<p id="closeSplitBalance" class="muted"></p>` +
        `</div>`;

      const modal = document.createElement('div');
      modal.id = 'closeTableModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card comanda-card" role="dialog" aria-modal="true" aria-labelledby="closeTableTitle">` +
        `<h3 id="closeTableTitle">Fechar ${escapeHtml(table.label)}</h3>` +
        `<div class="comanda-list">${rows}</div>` +
        `<p class="muted">Total a receber: <strong>${money(total)}</strong> · ${comandas.length} comanda(s)` +
        (paidComandas.length ? ` (<strong>${money(paidComandas.reduce((s, c) => s + (Number(c.total) || 0), 0))}</strong> já pago(s))` : '') +
        `</p>` +
        `<label class="field-label">Forma de pagamento recebida</label>` +
        `<select id="closePayMethod" class="type-confirm-input">` +
        CLOSE_PAY_METHODS.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('') +
        `</select>` +
        `${cashSectionHtml}` +
        `<label class="check-label"><input id="closePayReceived" type="checkbox"/> Confirmo que o pagamento foi recebido</label>` +
        `<hr/>` +
        `<label class="check-label close-split-toggle">` +
        `<input id="closeSplitCheck" type="checkbox"/> Dividir a conta` +
        `</label>` +
        `${splitSectionHtml}` +
        `<p id="closeMsg" class="confirm-msg" hidden></p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm close-print" data-close-print>Imprimir cobrança</button>` +
        `<button type="button" class="confirm" data-close-ok>Confirmar fechamento</button>` +
        `</div></div>`;
      document.body.appendChild(modal);

      const done = (v) => { modal.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') done(null); };
      const peopleRowsEl = modal.querySelector('#closePeopleRows');
      const balanceEl = modal.querySelector('#closeSplitBalance');
      const msgEl = modal.querySelector('#closeMsg');
      const peopleCountInput = modal.querySelector('#closePeopleCount');
      const tipInput = modal.querySelector('#closeTip');
      const splitCheck = modal.querySelector('#closeSplitCheck');
      const splitSection = modal.querySelector('#closeSplitSection');
      const payMethodSelect = modal.querySelector('#closePayMethod');
      const cashSection = modal.querySelector('#closeCashSection');
      const cashReceivedInput = modal.querySelector('#closeCashReceived');
      const cashChangeEl = modal.querySelector('#closeCashChange');

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
        const received = roundMoney(cashReceivedInput?.value);
        const change = received - total;
        cashChangeEl.textContent = change >= 0
          ? `Troco: ${money(change)}`
          : `Falta: ${money(Math.abs(change))}`;
        cashChangeEl.style.color = change >= 0 ? '#16a34a' : '#dc2626';
      }

      function setCloseMsg(text, error) {
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
        const count = clampInt(Number(peopleCountInput?.value), 1, 50, 1);
        const tip = roundMoney(tipInput?.value);
        const people = [];
        for (let i = 0; i < count; i++) {
          const rowEl = peopleRowsEl?.children[i];
          const name = rowEl?.querySelector('.close-person-name')?.value?.trim?.() || '';
          const fixed = !!rowEl?.querySelector('.close-person-fixed')?.checked;
          const amount = roundMoney(rowEl?.querySelector('.close-person-amount')?.value);
          people.push({ name, fixed, amount });
        }
        return computeBillSplit(total, tip, people);
      }

      function renderPeopleRows() {
        const count = clampInt(Number(peopleCountInput?.value), 1, 50, 1);
        while (peopleRowsEl && peopleRowsEl.children.length > count) {
          peopleRowsEl.removeChild(peopleRowsEl.lastChild);
        }
        for (let i = peopleRowsEl ? peopleRowsEl.children.length : 0; i < count; i++) {
          if (!peopleRowsEl) break;
          const row = document.createElement('div');
          row.className = 'close-person-row';
          row.innerHTML =
            `<span class="close-person-index">${i + 1}.</span>` +
            `<input class="close-person-name" type="text" placeholder="Nome (opcional)" value="" />` +
            `<label class="check-label"><input class="close-person-fixed" type="checkbox"/> valor fixo</label>` +
            `<input class="close-person-amount" type="number" min="0" step="0.01" value="" placeholder="R$" disabled />`;
          peopleRowsEl.appendChild(row);
          const fixedChk = row.querySelector('.close-person-fixed');
          const amountInput = row.querySelector('.close-person-amount');
          fixedChk.addEventListener('change', () => {
            amountInput.disabled = !fixedChk.checked;
            updateSplitBalance();
            prefillAmounts();
          });
          amountInput.addEventListener('input', () => { updateSplitBalance(); prefillAmounts(); });
        }
        if (peopleRowsEl && peopleRowsEl.children.length === 0 && count > 0) renderPeopleRows();
      }

      function updateSplitBalance() {
        const split = currentSplit();
        const lines = split.result.map((p, idx) => {
          const label = escapeHtml(p.name || `Pessoa ${idx + 1}`);
          return `${idx + 1}. ${label} → <strong>${money(p.amount)}</strong>`;
        }).join('<br/>');
        const tipLine = split.tip > 0 ? `<br/>Gorjeta: <strong>${money(split.tip)}</strong> · ` : '';
        const diffLine = split.diff === 0
          ? '<br/><span style="color:#166534;">✓ Total cobrado confere com a conta.</span>'
          : `<br/><span style="color:#b45309;">⚠ Diferença de ${money(split.diff)} — ajuste os valores.</span>`;
        if (balanceEl) {
          balanceEl.innerHTML = `<strong>A cobrar no total: ${money(split.amountToCollect)}</strong>${tipLine}` +
            (lines ? `<br/>${lines}` : '') + diffLine;
        }
        return split;
      }

      // Preenche automaticamente o valor de cada pessoa não-fixa com a parte
      // calculada (a última pessoa absorve os centavos).
      function prefillAmounts() {
        const split = currentSplit();
        for (let i = 0; i < split.result.length; i++) {
          const rowEl = peopleRowsEl?.children[i];
          if (!rowEl) continue;
          const fixed = !!rowEl.querySelector('.close-person-fixed')?.checked;
          const amountInput = rowEl.querySelector('.close-person-amount');
          if (!fixed && amountInput) amountInput.value = split.result[i].amount.toFixed(2);
        }
      }

      splitCheck?.addEventListener('change', toggleSplitSection);
      payMethodSelect?.addEventListener('change', toggleCashSection);
      cashReceivedInput?.addEventListener('input', updateCashChange);
      modal.addEventListener('click', (e) => { if (e.target === modal) done(null); });
      modal.querySelector('[data-close-print]')?.addEventListener('click', () => {
        const split = splitCheck?.checked ? currentSplit() : { amountToCollect: total, tip: 0, diff: 0, result: [] };
        printBillSplit(table, comandas, split);
      });
      peopleCountInput?.addEventListener('input', () => { renderPeopleRows(); updateSplitBalance(); prefillAmounts(); });
      tipInput?.addEventListener('input', () => { updateSplitBalance(); prefillAmounts(); });
      modal.querySelector('[data-close-ok]')?.addEventListener('click', async () => {
        const btn = modal.querySelector('[data-close-ok]');
        setCloseMsg('', false);
        const payReceived = !!(modal.querySelector('#closePayReceived') || {}).checked;
        if (!payReceived) {
          setCloseMsg('Confirme que o pagamento foi recebido antes de fechar a mesa.', true);
          return;
        }
        const isDinheiro = (payMethodSelect?.value || '') === 'Dinheiro';
        if (isDinheiro) {
          const received = roundMoney(cashReceivedInput?.value);
          if (received < total) {
            setCloseMsg(`Valor recebido (${money(received)}) é menor que o total (${money(total)}).`, true);
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
            setCloseMsg(err?.message || 'Não foi possível calcular a divisão.', true);
            return;
          }
          if (split.diff !== 0) {
            setCloseMsg('Os valores das pessoas não batem com o total. Ajuste a divisão.', true);
            return;
          }
        } else {
          split = { amountToCollect: total, tip: 0, diff: 0, result: [] };
        }
        const payMethod = (modal.querySelector('#closePayMethod') || {}).value || 'Dinheiro';
        btn.disabled = true;
        btn.textContent = 'Fechando…';
        setCloseMsg('Fechando mesa...', false);
        try {
          await api(`/api/v1/admin/tables/${table.id}/close`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ paymentMethod: payMethod })
          });
          setCloseMsg('Fechamento confirmado.', false);
          done({ closed: true, split });
        } catch (e) {
          console.error('[closeTable] close request', e);
          btn.disabled = false;
          btn.textContent = 'Confirmar fechamento';
          setCloseMsg(e.message || 'Erro ao fechar a mesa.', true);
          showAppToast(e.message || 'Erro ao fechar a mesa.');
        }
      });

      toggleCashSection();
      document.addEventListener('keydown', onKey);
      payMethodSelect?.focus();
    });
  }

  async function fecharTable(table) {
    if (!canSeeOrders()) throw new Error('Sem permissão para fechar mesa.');
    if (!(await requirePinSession())) throw new Error('PIN não autorizado. Ação cancelada.');
    const res = await api(`/api/v1/orders/table/${table.id}`, { headers: authHeaders() });
    const comandas = Array.isArray(res) ? res : [];
    if (!comandas.length) { showAppToast('Não há comandas abertas nesta mesa.'); return; }
    const result = await askFecharMesa(table, comandas);
    await loadTablesTab().catch(() => {});
    if (result && result.closed) {
      showAppToast(`Mesa ${table.label} fechada. ${comandas.length} comanda(s) finalizada(s).`);
      await showCloseReceipt(table, comandas, result.split);
    }
  }

  // Busca o AccessCode de cada mesa (Admin) para exibir/reimprimir o QR após
  // recarregar a página. A listagem não expõe o código por segurança.
  async function enrichTablesAccessCodes() {
    if (!isStoreAdmin()) return;
    const pending = tables.filter((t) => t.active && !t.accessCode);
    await Promise.all(pending.map(async (t) => {
      try {
        const res = await api(`/api/v1/admin/tables/${t.id}`, { headers: authHeaders() });
        if (res && res.accessCode) t.accessCode = res.accessCode;
      } catch (_) { /* best-effort: mantém sem QR */ }
    }));
  }

  async function deleteTable(table) {
    if (!isStoreAdmin()) return;
    if (tableHasSession(table)) {
      showAppToast('Não é possível excluir mesa com comandas em aberto.');
      return;
    }
    const ok = await askConfirm(`Excluir a mesa "${table.label}"? Esta ação não pode ser desfeita.`, {
      title: 'Excluir mesa',
      confirmLabel: 'Excluir'
    });
    if (!ok) return;
    try {
      await api(`/api/v1/admin/tables/${table.id}`, { method: 'DELETE', headers: authHeaders() });
      showAppToast('Mesa excluída.');
      await loadTablesTab();
    } catch (e) {
      showAppToast(e.message || 'Erro ao excluir a mesa.');
    }
  }

  // ── Fim Mesas ──

  function openTab(tabName) {
    if (isPlatformDev() && !platformAllowedTabs().includes(tabName)) {
      tabName = 'platform';
    } else if (isStoreAdmin() && platformAllowedTabs().includes(tabName)) {
      tabName = 'orders';
    } else if (!isStoreAdmin() && !isPlatformDev() && tabName !== 'orders' && tabName !== 'mesas') {
      tabName = 'orders';
    }
    activeTab = tabName;
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab').forEach((t) => { t.hidden = true; });
    const panel = $(`tab-${tabName}`);
    if (panel) panel.hidden = false;
    if (tabName === 'store') restoreStoreTab();
    if (tabName === 'systems') renderSystemsLinks();
    stopDashboardPolling();
    if (tabName === 'dashboard') {
      // Ao abrir a aba, sempre inicia no dia atual (o usuário pode mudar o período depois).
      const daysEl = $('dashboardDays');
      if (daysEl) daysEl.value = 'today';
      dashboardPeriod = 'today';
      loadDashboard()
        .then(() => {
          Object.values(chartInstances).forEach((c) => {
            try { c.resize(); } catch (_) { /* ignore */ }
          });
          updateDashboardPolling();
        })
        .catch((e) => console.warn('Dashboard', e));
    }
    if (tabName === 'platform') {
      loadPlatformDashboard().catch((e) => console.warn('Dashboard plataforma', e));
    }
    if (tabName === 'lojas') {
      loadPlatformStores().catch((e) => console.warn('Lojas', e));
    }
    if (tabName === 'mesas') {
      loadTablesTab().catch((e) => console.warn('Mesas', e));
    }
    if (tabName === 'team') {
      loadTeam().catch((e) => console.warn('Equipe', e));
    }
    if (tabName === 'opcionais') {
      renderOpcionais();
    }
    updateDineInUi();
    if (tabName === 'orders') {
      updateDineInUi();
    }
    if (tabName === 'bank') {
      loadBankTab().catch((e) => console.warn('Banco', e));
    }
    updateOrdersPolling();
  }

  function openProductsForCategory(categoryId, categoryTitle) {
    productCategoryFilter = categoryId;
    openTab('products');
    const select = $('prodCategory');
    if (select) select.value = categoryId;
    syncProductCategoryFilterSelect();
    updateProductFilterBar(categoryTitle);
    renderProducts();
  }

  function clearProductFilter() {
    productCategoryFilter = null;
    syncProductCategoryFilterSelect();
    updateProductFilterBar(null);
    renderProducts();
  }

  function syncProductCategoryFilterSelect() {
    const sel = $('productCategoryFilter');
    if (!sel) return;
    sel.value = productCategoryFilter || '';
  }

  function updateProductFilterBar(categoryTitle) {
    const bar = $('productFilterBar');
    const label = $('productFilterLabel');
    if (!bar || !label) return;
    if (productCategoryFilter) {
      bar.hidden = false;
      label.textContent = `Filtrando: ${categoryTitle || productCategoryFilter}`;
    } else {
      bar.hidden = true;
      label.textContent = '';
    }
  }

  function showApp(show) {
    const login = $('loginView');
    const app = $('appView');
    if (show) {
      login.setAttribute('hidden', '');
      app.removeAttribute('hidden');
      applyRoleUi();
      updateAccountUi();
      openTab(isPlatformDev() ? 'platform' : 'orders');
      updateOrdersPolling();
      if (canSeeOrders()) {
        refreshAcceptingOrdersBadge().catch(() => {});
      }
    } else {
      stopOrdersPolling();
      destroyCharts();
      app.setAttribute('hidden', '');
      login.removeAttribute('hidden');
      clearStoreForm();
    }
  }

  function openCategoryModal() {
    const modal = $('categoryModal');
    if (modal) modal.hidden = false;
  }

  function closeCategoryModal() {
    const modal = $('categoryModal');
    if (modal) modal.hidden = true;
  }

  function openProductModal() {
    const modal = $('productModal');
    if (modal) modal.hidden = false;
  }

  function closeProductModal() {
    const modal = $('productModal');
    if (modal) modal.hidden = true;
  }

  function resetCategoryForm({ closeModal = true } = {}) {
    editingCategoryId = null;
    if ($('catTitle')) $('catTitle').value = '';
    if ($('catShowInMenu')) {
      $('catShowInMenu').checked = true;
      $('catShowInMenu').disabled = false;
    }
    if ($('saveCatBtn')) $('saveCatBtn').textContent = 'Salvar categoria';
    if ($('catFormMode')) $('catFormMode').textContent = 'Nova categoria';
    if (closeModal) closeCategoryModal();
  }

  function isPortionsCategory(category) {
    if (!category) return false;
    const id = String(category.id || '').toLowerCase();
    const title = String(category.title || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return id.includes('porc') || title.includes('porcoes') || title.includes('porcao');
  }

  function isBeveragesCategory(category) {
    if (!category) return false;
    const id = String(category.id || '').toLowerCase();
    const title = String(category.title || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
    return id.includes('bebid') || id.includes('refri') || title.includes('bebida') || title.includes('refrigerante');
  }

  function normalizeReceiptName(value) {
    return String(value || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();
  }

  /** Busca o catálogo público (1x, com cache) quando o admin não tem categorias carregadas. */
  function ensurePublicCatalog() {
    if (Array.isArray(catalog.categories) && catalog.categories.length) return Promise.resolve(catalog);
    if (!publicCatalogPromise) {
      publicCatalogPromise = api('/api/v1/catalog')
        .then((data) => {
          if (data && Array.isArray(data.categories) && data.categories.length) catalog = data;
          return catalog;
        })
        .catch((err) => {
          console.warn('Catálogo público indisponível:', err);
          publicCatalogPromise = null;
          return catalog;
        });
    }
    return publicCatalogPromise;
  }

  function beverageCatalogNames() {
    const names = [];
    (Array.isArray(catalog && catalog.categories) ? catalog.categories : []).forEach((cat) => {
      if (!isBeveragesCategory(cat)) return;
      (Array.isArray(cat.items) ? cat.items : []).forEach((item) => {
        const n = normalizeReceiptName(item && item.name);
        if (n.length >= 3) names.push(n);
      });
    });
    return names;
  }

  /** Pedido cujos itens são TODOS bebidas (usado para dispensar impressão automática de cupom). */
  function orderHasOnlyBeverages(order) {
    const items = Array.isArray(order && order.items) ? order.items : [];
    if (!items.length) return false;
    const beverageNames = beverageCatalogNames();
    // Catálogo indisponível/incompleto → não bloqueia a impressão.
    if (!beverageNames.length) return false;
    return items.every((it) => {
      const parsed = splitItemObservation(it && it.name);
      const name = normalizeReceiptName(parsed && parsed.name);
      if (!name) return false;
      return beverageNames.some((b) => name.includes(b) || b.includes(name));
    });
  }

  function syncProductPriceFields() {
    const categoryId = $('prodCategory')?.value || '';
    const category = (catalog.categories || []).find((c) => c.id === categoryId);
    const portions = isPortionsCategory(category);
    const beverages = isBeveragesCategory(category);
    const single = $('prodPriceLabel');
    const sizes = $('prodSizePrices');
    if (single) single.hidden = portions;
    if (sizes) sizes.hidden = !portions;
    const ingFieldset = $('prodIngredientsFieldset');
    if (ingFieldset) ingFieldset.hidden = beverages;
    const modFieldset = $('prodModifiersFieldset');
    if (modFieldset) modFieldset.hidden = beverages;
    const modal = $('productModal');
    if (modal && !modal.hidden && !beverages) {
      renderProductIngredients(readSelectedIngredientIds());
    }
  }

  function formatProductPriceLabel(p) {
    const media = p.priceMedia != null ? Number(p.priceMedia) : NaN;
    const inteira = p.priceInteira != null ? Number(p.priceInteira) : NaN;
    if (Number.isFinite(media) && Number.isFinite(inteira)) {
      return `Média R$ ${media.toFixed(2)} / Inteira R$ ${inteira.toFixed(2)}`;
    }
    return `R$ ${Number(p.price || 0).toFixed(2)}`;
  }

  function captureProductFormBaseline() {
    productFormBaseline = {
      name: $('prodName')?.value || '',
      price: $('prodPrice')?.value || '',
      priceMedia: $('prodPriceMedia')?.value || '',
      priceInteira: $('prodPriceInteira')?.value || '',
      imageUrl: $('prodImageUrl')?.value.trim() || '',
      category: $('prodCategory')?.value || '',
      available: $('prodAvailable')?.checked,
      showInMenu: $('prodShowInMenu') ? $('prodShowInMenu').checked : true,
      ingredients: readSelectedIngredientIds().join(',')
    };
  }

  function isProductFormDirty() {
    if (pendingProductImageBlob) return true;
    if ($('prodImageFile')?.files?.length) return true;
    if (!productFormBaseline) return false;
    return (
      ($('prodName')?.value || '') !== productFormBaseline.name ||
      ($('prodPrice')?.value || '') !== productFormBaseline.price ||
      ($('prodPriceMedia')?.value || '') !== productFormBaseline.priceMedia ||
      ($('prodPriceInteira')?.value || '') !== productFormBaseline.priceInteira ||
      ($('prodImageUrl')?.value.trim() || '') !== productFormBaseline.imageUrl ||
      ($('prodCategory')?.value || '') !== productFormBaseline.category ||
      ($('prodAvailable')?.checked) !== productFormBaseline.available ||
      ($('prodShowInMenu') ? $('prodShowInMenu').checked : true) !== productFormBaseline.showInMenu ||
      readSelectedIngredientIds().join(',') !== productFormBaseline.ingredients
    );
  }

  async function guardedCloseProductForm() {
    if (isProductFormDirty() && !(await askConfirm('Há alterações não salvas neste produto. Descartá-las?'))) return false;
    resetProductForm();
    return true;
  }

  function resetProductForm({ closeModal = true } = {}) {
    productFormBaseline = null;
    editingProductId = null;
    if ($('prodName')) $('prodName').value = '';
    if ($('prodPrice')) $('prodPrice').value = '';
    if ($('prodPriceMedia')) $('prodPriceMedia').value = '';
    if ($('prodPriceInteira')) $('prodPriceInteira').value = '';
    if ($('prodImageUrl')) $('prodImageUrl').value = '';
    if ($('prodImageFile')) $('prodImageFile').value = '';
    updateProductImageUi('');
    clearPendingProductImage();
    if ($('prodAvailable')) $('prodAvailable').checked = true;
    if ($('prodShowInMenu')) $('prodShowInMenu').checked = true;
    if ($('saveProdBtn')) $('saveProdBtn').textContent = 'Salvar produto';
    if ($('prodFormMode')) $('prodFormMode').textContent = 'Novo produto';
    productOpcionais = [];
    productPrincipalIds = [];
    renderProductIngredients([]);
    renderProductOpcionais();
    const select = $('prodCategory');
    if (select) {
      if (productCategoryFilter && [...select.options].some((o) => o.value === productCategoryFilter)) {
        select.value = productCategoryFilter;
      } else {
        select.value = '';
      }
    }
    syncProductPriceFields();
    if (closeModal) closeProductModal();
  }

  function openIngredientModal() {
    const modal = $('ingredientModal');
    if (modal) modal.hidden = false;
  }

  function closeIngredientModal() {
    const modal = $('ingredientModal');
    if (modal) modal.hidden = true;
  }

  function resetIngredientForm({ closeModal = true } = {}) {
    editingIngredientId = null;
    creatingIngredientFromProduct = false;
    if ($('ingName')) $('ingName').value = '';
    if ($('ingAvailable')) $('ingAvailable').checked = true;
    if ($('saveIngBtn')) $('saveIngBtn').textContent = 'Salvar ingrediente';
    if ($('ingFormMode')) $('ingFormMode').textContent = 'Novo ingrediente';
    if (closeModal) closeIngredientModal();
  }

  function createDragHandle() {
    const handle = document.createElement('span');
    handle.className = 'drag-handle';
    handle.title = 'Arrastar para reordenar';
    handle.setAttribute('aria-hidden', 'true');
    handle.textContent = '⋮⋮';
    return handle;
  }

  function enableSortableList(listEl, { onReorder }) {
    if (!listEl) return;
    let dragEl = null;
    let startIds = [];

    const itemSelector = ':scope > [data-sort-id]';
    const idsForGroup = (group) =>
      [...listEl.querySelectorAll(itemSelector)]
        .filter((item) => (item.dataset.sortGroup || '') === group)
        .map((item) => item.dataset.sortId)
        .filter(Boolean);

    listEl.querySelectorAll(itemSelector).forEach((row) => {
      row.classList.add('sortable-item');
      row.draggable = true;

      row.addEventListener('dragstart', (e) => {
        if (e.target.closest('button, a, input, select, textarea, img')) {
          e.preventDefault();
          return;
        }
        // Permite arrastar pelo handle ou pela linha; checkbox continua clicável
        if (e.target.closest('label') && !e.target.closest('.drag-handle')) {
          // arrastar pelo texto do label também ok
        }
        dragEl = row;
        startIds = idsForGroup(row.dataset.sortGroup || '');
        row.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', row.dataset.sortId || '');
      });

      row.addEventListener('dragend', async () => {
        row.classList.remove('dragging');
        listEl.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
        if (!dragEl) return;
        const group = dragEl.dataset.sortGroup || '';
        const ids = idsForGroup(group);
        dragEl = null;
        if (!ids.length || ids.join('\0') === startIds.join('\0')) return;
        if (typeof onReorder !== 'function') return;
        try {
          await onReorder(ids, group);
        } catch (err) {
          showAppToast(err.message || 'Falha ao reordenar');
          await refresh();
        }
      });

      row.addEventListener('dragover', (e) => {
        if (!dragEl || dragEl === row) return;
        if ((dragEl.dataset.sortGroup || '') !== (row.dataset.sortGroup || '')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        row.classList.add('drag-over');
        const rect = row.getBoundingClientRect();
        const before = e.clientY < rect.top + rect.height / 2;
        if (before) listEl.insertBefore(dragEl, row);
        else listEl.insertBefore(dragEl, row.nextSibling);
      });

      row.addEventListener('dragleave', () => {
        row.classList.remove('drag-over');
      });

      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
      });
    });
  }

  async function reorderCatalogItems(kind, ids, categoryId) {
    const path =
      kind === 'category'
        ? '/api/v1/admin/categories/reorder'
        : kind === 'ingredient'
          ? '/api/v1/admin/ingredients/reorder'
          : '/api/v1/admin/products/reorder';
    const body = kind === 'product'
      ? { ids, categoryId }
      : { ids };
    await api(path, {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    await refresh();
  }

  function renderProductIngredients(selectedIds) {
    const box = $('prodIngredientRows');
    if (!box) return;
    const ordered = (selectedIds || []).map((id) => String(id)).filter(Boolean);
    box.innerHTML = '';
    if (!ordered.length) {
      const empty = document.createElement('p');
      empty.className = 'muted modifier-empty';
      empty.textContent = 'Nenhum ingrediente. Use "Adicionar ingrediente".';
      box.appendChild(empty);
      return;
    }
    const byId = new Map((ingredients || []).map((ing) => [ing.id, ing]));
    const principalId = productPrincipalIds[0] || readProductPrincipalIds()[0] || '';
    ordered.forEach((id) => {
      const ing = byId.get(id);
      const row = document.createElement('div');
      row.className = 'ingredient-pick-row is-selected';
      row.dataset.sortId = id;
      row.dataset.ingredientId = id;
      row.appendChild(createDragHandle());

      const nameSpan = document.createElement('span');
      nameSpan.className = 'prod-ing-name';
      nameSpan.textContent = ing ? (ing.name || id) : id;
      row.appendChild(nameSpan);

      // Ingrediente principal (radio, um só) — não-removível pelo cliente na personalização.
      const principalLabel = document.createElement('label');
      principalLabel.className = 'ingredient-principal-toggle';
      const principalInput = document.createElement('input');
      principalInput.type = 'radio';
      principalInput.name = 'prodPrincipal';
      principalInput.dataset.principalId = id;
      principalInput.checked = principalId === id;
      principalInput.title = 'Principal: não pode ser removido pelo cliente';
      principalInput.addEventListener('change', () => {
        if (principalInput.checked) productPrincipalIds = [id];
      });
      principalLabel.append(principalInput, document.createTextNode(' Principal'));
      row.appendChild(principalLabel);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'ghost compact prod-ing-remove';
      removeBtn.textContent = '✕';
      removeBtn.title = `Remover ${ing ? (ing.name || id) : id}`;
      removeBtn.addEventListener('click', () => {
        productPrincipalIds = productPrincipalIds.filter((pid) => pid !== id);
        renderProductIngredients(readSelectedIngredientIds().filter((i) => i !== id));
      });
      row.appendChild(removeBtn);

      box.appendChild(row);
    });

    enableSortableList(box, {
      // A ordem final já é lida do DOM em readSelectedIngredientIds.
      onReorder: () => {}
    });
  }

  function readSelectedIngredientIds() {
    return Array.from(document.querySelectorAll('#prodIngredientRows [data-ingredient-id]'))
      .map((el) => el.dataset.ingredientId)
      .filter(Boolean);
  }

  function readProductPrincipalIds() {
    const checked = document.querySelector('#prodIngredientRows input[name="prodPrincipal"]:checked');
    return checked && checked.dataset.principalId ? [checked.dataset.principalId] : [];
  }

  // ---- Opcionais (itens pagos adicionados pelo cliente) ----
  function nextModifierId(prefix) {
    modifierIdSeq += 1;
    return `${prefix}-${Date.now().toString(36)}-${modifierIdSeq}`;
  }

  function modifierClampPrice(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(999, Math.round(n * 100) / 100);
  }

  function flattenModifierGroups(groups) {
    const options = [];
    if (!Array.isArray(groups)) return options;
    const seen = new Set();
    groups.forEach((g) => {
      (Array.isArray(g && g.options) ? g.options : []).forEach((o) => {
        const id = String((o && o.id) || '').trim();
        if (seen.has(id)) return;
        seen.add(id);
        options.push({
          id: id || nextModifierId('opt'),
          name: String((o && o.name) || '').trim(),
          priceDelta: modifierClampPrice(o && o.priceDelta),
          available: !(o && o.available === false)
        });
      });
    });
    return options;
  }

  function renderProductOpcionais() {
    const box = $('prodOpcionalRows');
    if (!box) return;
    box.innerHTML = '';
    if (!productOpcionais.length) {
      const empty = document.createElement('p');
      empty.className = 'muted modifier-empty';
      empty.textContent = 'Nenhum opcional. Use "Adicionar opcional" ou "Novo opcional".';
      box.appendChild(empty);
      return;
    }
    productOpcionais.forEach((opt, oi) => box.appendChild(buildOpcionalRow(opt, oi)));
  }

  function buildOpcionalRow(opt, oi) {
    const row = document.createElement('div');
    row.className = 'modifier-option';

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'modifier-option-name';
    nameInput.placeholder = 'Nome (ex.: Bacon)';
    nameInput.value = opt.name || '';
    nameInput.addEventListener('input', () => { opt.name = nameInput.value; });
    row.appendChild(nameInput);

    const priceWrap = document.createElement('label');
    priceWrap.className = 'inline modifier-option-price';
    priceWrap.appendChild(document.createTextNode('+R$'));
    const priceInput = document.createElement('input');
    priceInput.type = 'number';
    priceInput.step = '0.01';
    priceInput.min = '0';
    priceInput.className = 'modifier-option-delta';
    priceInput.value = String(opt.priceDelta ?? 0);
    priceInput.addEventListener('input', () => { opt.priceDelta = modifierClampPrice(priceInput.value); });
    priceWrap.appendChild(priceInput);
    row.appendChild(priceWrap);

    const availLabel = document.createElement('label');
    availLabel.className = 'inline modifier-option-avail';
    const availCheck = document.createElement('input');
    availCheck.type = 'checkbox';
    availCheck.checked = opt.available !== false;
    availCheck.addEventListener('change', () => { opt.available = availCheck.checked; });
    availLabel.appendChild(availCheck);
    availLabel.appendChild(document.createTextNode(' Disponível'));
    row.appendChild(availLabel);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'ghost compact';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remover opcional';
    removeBtn.addEventListener('click', () => {
      productOpcionais.splice(oi, 1);
      renderProductOpcionais();
    });
    row.appendChild(removeBtn);

    return row;
  }

// ---- Picker de opcionais (modal) e novo opcional ----
  function buildOpcionalPool() {
    const byName = new Map();
    const addOption = (o) => {
      const name = String((o && o.name) || '').trim();
      if (!name || (o && o.available === false)) return;
      const key = name.toLowerCase();
      if (byName.has(key)) return;
      byName.set(key, {
        id: String((o && o.id) || ''),
        name,
        priceDelta: modifierClampPrice(o && o.priceDelta),
        available: !(o && o.available === false)
      });
    };
    (catalog.categories || []).forEach((c) => {
      if (!c || String(c.id || '') !== 'adicionais') return;
      (c.items || []).forEach((p) => {
        addOption({ id: p.id, name: p.name, priceDelta: modifierClampPrice(p.price), available: p.available !== false });
      });
    });
    productOpcionais.forEach(addOption);
    return Array.from(byName.values())
      .sort((a, b) => String(a.name).localeCompare(String(b.name), 'pt-BR'));
  }

  function openOpcionalPicker() {
    const modal = $('prodOpcionalPickerModal');
    if (!modal) return;
    const search = $('prodOpcionalPickerSearch');
    const selected = new Set(
      productOpcionais.map((o) => String((o && o.name) || '').trim().toLowerCase()).filter(Boolean)
    );
    const pool = buildOpcionalPool();
    const render = () => {
      const q = String(search ? search.value || '' : '').trim().toLowerCase();
      const list = $('prodOpcionalPickerList');
      if (!list) return;
      list.innerHTML = '';
      const shown = pool.filter((o) => !q || String(o.name || '').toLowerCase().includes(q));
      if (!shown.length) {
        list.innerHTML = '<p class="muted">Nenhum opcional encontrado. Use "Novo opcional" para criar um.</p>';
        return;
      }
      shown.forEach((o) => {
        const row = document.createElement('label');
        row.className = 'ingredient-picker-row opcional-picker-row';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.pickerOpcionalId = o.id;
        input.checked = selected.has(String(o.name || '').toLowerCase());
        row.append(input, document.createTextNode(` ${o.name}`));
        if (o.priceDelta > 0) {
          const price = document.createElement('span');
          price.className = 'ingredient-pick-price';
          price.textContent = `+${money(o.priceDelta)}`;
          row.appendChild(price);
        }
        list.appendChild(row);
      });
    };
    if (search) search.oninput = render;
    render();
    modal.hidden = false;
    if (search) search.focus();
  }

  function closeOpcionalPicker() {
    const modal = $('prodOpcionalPickerModal');
    if (modal) modal.hidden = true;
  }

  function applyOpcionalPicker() {
    const inProduct = new Set(
      productOpcionais.map((o) => String((o && o.name) || '').trim().toLowerCase()).filter(Boolean)
    );
    const byId = new Map(buildOpcionalPool().map((o) => [o.id, o]));
    document.querySelectorAll('#prodOpcionalPickerList [data-picker-opcional-id]').forEach((el) => {
      if (!el.checked || !el.dataset.pickerOpcionalId) return;
      const o = byId.get(el.dataset.pickerOpcionalId);
      if (!o) return;
      const key = String(o.name || '').toLowerCase();
      if (inProduct.has(key)) return;
      inProduct.add(key);
      productOpcionais.push({
        id: o.id || nextModifierId('opt'),
        name: o.name,
        priceDelta: o.priceDelta,
        available: o.available !== false
      });
    });
    renderProductOpcionais();
    closeOpcionalPicker();
  }

  function openNewOpcionalModal() {
    const modal = $('prodNewOpcionalModal');
    if (!modal) return;
    if ($('prodNewOpcionalName')) $('prodNewOpcionalName').value = '';
    if ($('prodNewOpcionalPrice')) $('prodNewOpcionalPrice').value = '';
    if ($('prodNewOpcionalAvailable')) $('prodNewOpcionalAvailable').checked = true;
    if ($('prodNewOpcionalError')) $('prodNewOpcionalError').hidden = true;
    modal.hidden = false;
    $('prodNewOpcionalName')?.focus();
  }

  function closeNewOpcionalModal() {
    const modal = $('prodNewOpcionalModal');
    if (modal) modal.hidden = true;
  }

  function applyNewOpcional() {
    const nameInput = $('prodNewOpcionalName');
    const priceInput = $('prodNewOpcionalPrice');
    const availInput = $('prodNewOpcionalAvailable');
    const errEl = $('prodNewOpcionalError');
    const showError = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };

    const name = String(nameInput ? nameInput.value : '').trim();
    if (!name) { showError('Informe o nome do opcional.'); nameInput?.focus(); return; }
    if (name.length > 60) { showError('Nome muito longo (máx. 60 caracteres).'); nameInput?.focus(); return; }
    const price = modifierClampPrice(priceInput ? priceInput.value : 0);
    productOpcionais.push({
      id: nextModifierId('opt'),
      name,
      priceDelta: price,
      available: availInput ? availInput.checked : true
    });
    renderProductOpcionais();
    closeNewOpcionalModal();
  }

  function readProductModifierGroups() {
    const options = productOpcionais
      .filter((o) => String(o.name || '').trim())
      .map((o) => ({
        id: String(o.id || '').trim(),
        name: String(o.name || '').trim(),
        priceDelta: modifierClampPrice(o.priceDelta),
        available: o.available !== false
      }));
    if (!options.length) return [];
    return [
      {
        id: 'g-adicionais',
        name: 'Adicionais',
        required: false,
        min: 0,
        max: 10,
        options
      }
    ];
  }

  // ---- Picker de ingredientes (modal) ----
  function openIngredientPicker() {
    const modal = $('prodIngredientPickerModal');
    if (!modal) return;
    const search = $('prodIngredientPickerSearch');
    const selected = new Set(readSelectedIngredientIds());
    const pool = (ingredients || [])
      .filter((ing) => ing && ing.available !== false)
      .slice()
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'pt-BR'));
    const render = () => {
      const q = String(search ? search.value || '' : '').trim().toLowerCase();
      const list = $('prodIngredientPickerList');
      if (!list) return;
      list.innerHTML = '';
      const shown = pool.filter((ing) => !q || String(ing.name || '').toLowerCase().includes(q));
      if (!shown.length) {
        list.innerHTML = '<p class="muted">Nenhum ingrediente encontrado.</p>';
        return;
      }
      shown.forEach((ing) => {
        const row = document.createElement('label');
        row.className = 'ingredient-picker-row';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.dataset.pickerIngredientId = ing.id;
        input.checked = selected.has(ing.id);
        row.append(input, document.createTextNode(` ${ing.name || ing.id}`));
        list.appendChild(row);
      });
    };
    if (search) search.oninput = render;
    render();
    modal.hidden = false;
    if (search) search.focus();
  }

  function applyIngredientPicker() {
    const selected = new Set(readSelectedIngredientIds());
    document.querySelectorAll('#prodIngredientPickerList [data-picker-ingredient-id]').forEach((el) => {
      if (el.checked) selected.add(el.dataset.pickerIngredientId);
    });
    renderProductIngredients([...selected]);
    closeIngredientPicker();
  }

  function closeIngredientPicker() {
    const modal = $('prodIngredientPickerModal');
    if (modal) modal.hidden = true;
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

  function formatProductIngredients(p) {
    const list = Array.isArray(p?.ingredients) ? p.ingredients : [];
    if (!list.length) return '';
    return formatIngredientsPhrase(
      list.map((i) => (i && i.isPrincipal ? `★${i.name || i.id}` : (i.name || i.id)))
    );
  }

  function formatProductModifiersSummary(p) {
    const groups = Array.isArray(p?.modifierGroups) ? p.modifierGroups : [];
    if (!groups.length) return '';
    const optionCount = groups.reduce((n, g) => n + ((g && g.options) || []).length, 0);
    if (!optionCount) return '';
    const optionWord = optionCount === 1 ? 'opção' : 'opções';
    return `Adicionais: ${optionCount} ${optionWord}`;
  }

  function clearStoreForm() {
    catalog = { categories: [] };
    ingredients = [];
    orders = [];
    knownOrderIds = new Set();
    mesaAutoPrintedOrders = new Set();
    ordersHydrated = false;
    stopNewOrderAlertLoop();
    stopSlaAlertLoop();
    productCategoryFilter = null;
    updateProductFilterBar(null);
    resetCategoryForm();
    resetProductForm();
    const board = $('ordersBoard');
    if (board) board.innerHTML = '';
    const meta = $('ordersMeta');
    if (meta) meta.textContent = '';
    ['storeName', 'whatsapp', 'pixKey', 'pixKeyLabel', 'logoUrl', 'iconUrl'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.value = '';
    });
    const topTitle = $('topbarStoreTitle');
    if (topTitle) topTitle.textContent = 'Loja';
    updateStoreIconUi('');
    if ($('iconFile')) $('iconFile').value = '';
    if ($('logoFile')) $('logoFile').value = '';
    const catList = $('catList');
    const prodList = $('prodList');
    const prodCategory = $('prodCategory');
    if (catList) catList.innerHTML = '';
    if (prodList) prodList.innerHTML = '';
    if (prodCategory) prodCategory.innerHTML = '';
  }

  function logout() {
    stopOrdersPolling();
    stopDashboardPolling();
    token = '';
    userRole = '';
    username = '';
    switchedProfile = null;
    devSnapshot = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(ROLE_KEY);
    localStorage.removeItem(USER_KEY);
    localStorage.removeItem(DEV_SESSION_KEY);
    showApp(false);
  }

  function isSwitchedProfile() {
    return switchedProfile !== null;
  }

  function updateProfileSwitcherUi() {
    const switcher = $('profileSwitcher');
    const backBtn = $('profileSwitcherBack');
    const adminBtn = document.querySelector('[data-switch-to="admin"]');
    const atendiBtn = document.querySelector('[data-switch-to="atendimento"]');
    const isDev = isPlatformDev();
    if (switcher) switcher.hidden = !isDev;
    if (backBtn) backBtn.hidden = !isDev || !isSwitchedProfile();
    if (adminBtn) adminBtn.hidden = !isDev || switchedProfile === 'admin';
    if (atendiBtn) atendiBtn.hidden = !isDev || switchedProfile === 'atendimento';
  }

  function accountDisplayName() {
    let display = '';
    try {
      const payload = decodeJwtPayload(token);
      if (payload && typeof payload.name === 'string' && payload.name.trim()) display = payload.name.trim();
    } catch (_) { /* token ausente/indecodificável */ }
    if (!display && username) {
      display = username.charAt(0).toUpperCase() + username.slice(1);
    }
    return display || 'Conta';
  }

  function updateAccountUi() {
    const name = accountDisplayName();
    const role = String(userRole || '').trim();
    const roleLabel = role || '—';
    const roleSameAsName = !!role && role.toLowerCase() === name.toLowerCase();
    const initials = (name.trim().charAt(0) || '?').toUpperCase();
    const avatar = $('userAvatar');
    const nameEl = $('userMenuName');
    const badge = $('topbarRoleBadge');
    const disp = $('dropdownDisplayName');
    const usr = $('dropdownUsername');
    if (avatar) {
      avatar.hidden = !name;
      avatar.textContent = initials;
    }
    if (nameEl) nameEl.textContent = name;
    if (badge) {
      badge.hidden = !role || roleSameAsName;
      badge.textContent = roleLabel;
      badge.classList.toggle('role-dev', /^dev$/i.test(role));
      badge.classList.toggle('role-admin', /^admin$/i.test(role));
      badge.classList.toggle('role-atendimento', /^atendimento$/i.test(role));
    }
    if (disp) disp.textContent = name;
    if (usr) usr.textContent = roleSameAsName ? '' : roleLabel;
    updateProfileSwitcherUi();
  }

  function openUserDropdown() {
    const dd = $('userDropdown');
    const btn = $('userMenuBtn');
    if (dd) dd.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
  }

  function closeUserDropdown() {
    const dd = $('userDropdown');
    const btn = $('userMenuBtn');
    if (dd) dd.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function closeDrawer() {
    const app = $('appView');
    const bd = $('drawerBackdrop');
    if (app) app.classList.remove('sidebar-open');
    if (bd) bd.hidden = true;
  }

  function openDrawer() {
    const app = $('appView');
    const bd = $('drawerBackdrop');
    if (app) app.classList.add('sidebar-open');
    if (bd) bd.hidden = false;
  }

  async function switchProfile(target) {
    const profile = DEV_PROFILES[target];
    if (!profile) return;
    closeUserDropdown();
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('profile', target);
      window.open(url.toString(), '_blank');
    } catch (err) {
      showAppToast(`Não foi possível abrir o perfil ${profile.label}.`, 'error');
    }
  }

  async function restoreDevProfile() {
    let snap = devSnapshot;
    if (!snap) {
      try {
        const raw = localStorage.getItem(DEV_SESSION_KEY);
        if (raw) snap = JSON.parse(raw);
      } catch (_) {}
    }
    if (!snap || !snap.token) {
      showAppToast('Sessão de desenvolvedor não encontrada.', 'error');
      return;
    }
    token = snap.token;
    userRole = snap.role || 'Dev';
    username = snap.username || 'dev';
    switchedProfile = null;
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, userRole);
    localStorage.setItem(USER_KEY, username);
    closeUserDropdown();
    showApp(true);
    try { await refresh(); } catch (e) { console.warn('refresh apos voltar para dev', e); }
  }

  async function loginAsProfile(target) {
    const profile = DEV_PROFILES[target];
    if (!profile) return;
    try {
      const res = await fetch(`${API}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: profile.username, password: profile.password })
      });
      if (!res.ok) {
        const err = new Error(res.status === 401 ? 'Credenciais inválidas.' : `Falha no login (${res.status}).`);
        throw err;
      }
      const data = await res.json();
      if (!data || !data.token) throw new Error('Token ausente');
      persistSession(data);
      showApp(true);
      try { await refresh(); } catch (e) { console.warn('loginAsProfile: refresh', e); }
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete('profile');
        window.history.replaceState(null, '', url.toString());
      } catch (_) {}
    } catch (err) {
      const hint = err && err.message ? String(err.message) : '';
      $('loginError') && (($('loginError').hidden = false), ($('loginError').textContent = hint));
      showApp(false);
    }
  }

  function exportCatalogBackup() {
    if (!isStoreAdmin()) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      storeName: storeConfig?.storeName || '',
      catalog: catalog || { categories: [] },
      ingredients: Array.isArray(ingredients) ? ingredients : []
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = `cardapio-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showAppToast('Backup do cardápio baixado.');
  }

  function exportDashboardData(kind) {
    if (!isStoreAdmin()) return;
    if (!lastDashboardData) {
      loadDashboard()
        .then(() => exportDashboardData(kind))
        .catch((e) => showAppToast(e.message || 'Erro'));
      return;
    }
    if (kind === 'csv') downloadDashboardCsv(lastDashboardData);
    else printDashboardPdf(lastDashboardData);
  }

  function csvMoney(v) {
    return Number(v || 0).toFixed(2).replace('.', ',');
  }

  function downloadDashboardCsv(data) {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const storeName = storeConfig?.storeName || '';
    const lines = [
      `Dashboard;${storeName}`,
      `Período;${data.periodLabel || '—'}`,
      `Intervalo;${formatDateTime(data.fromUtc)} → ${formatDateTime(data.toUtc)}`,
      `Gerado em;${new Date().toLocaleString('pt-BR', { timeZone: APP_TIMEZONE })}`
    ];

    lines.push('', 'INDICADORES', 'Indicador;Valor');
    [
      ['Pedidos', data.totalOrders],
      ['Pedidos hoje', data.ordersToday],
      ['Em aberto', data.openOrders],
      ['Finalizados', data.deliveredOrders],
      ['Cancelados', data.cancelledOrders],
      ['Faturamento', csvMoney(data.grossRevenue)],
      ['Ticket médio', csvMoney(data.averageTicket)],
      ['Itens', csvMoney(data.itemsRevenue)],
      ['Entregas', csvMoney(data.deliveryRevenue)]
    ].forEach((r) => lines.push(r.join(';')));

    const daily = Array.isArray(data.dailySales) ? data.dailySales : [];
    lines.push('', 'VENDAS POR DIA', 'Data;Pedidos;Receita');
    if (!daily.length) lines.push('Sem dados;;');
    daily.forEach((d) => lines.push([d.date, d.orders, csvMoney(d.revenue)].join(';')));

    const byStatus = Array.isArray(data.byStatus) ? data.byStatus : [];
    lines.push('', 'PEDIDOS POR STATUS', 'Status;Pedidos');
    byStatus.forEach((s) => lines.push([s.label || s.status, s.count].join(';')));

    const products = Array.isArray(data.topProducts) ? data.topProducts : [];
    lines.push('', 'PRODUTOS MAIS VENDIDOS', 'Produto;Qtd;Receita');
    products.forEach((p) => lines.push([p.name, p.count, csvMoney(p.revenue)].join(';')));

    const payments = Array.isArray(data.byPayment) ? data.byPayment : [];
    lines.push('', 'FORMAS DE PAGAMENTO', 'Forma;Pedidos;Receita');
    payments.forEach((p) => lines.push([p.name, p.count, csvMoney(p.revenue)].join(';')));

    const neighborhoods = Array.isArray(data.topNeighborhoods) ? data.topNeighborhoods : [];
    lines.push('', 'BAIRROS', 'Bairro;Pedidos;Receita');
    neighborhoods.forEach((n) => lines.push([n.name, n.count, csvMoney(n.revenue)].join(';')));

    const fulfillment = Array.isArray(data.byFulfillment) ? data.byFulfillment : [];
    lines.push('', 'ENTREGA × RETIRADA', 'Tipo;Pedidos;Receita');
    fulfillment.forEach((f) => lines.push([f.name, f.count, csvMoney(f.revenue)].join(';')));

    const reasons = Array.isArray(data.byCancellationReason) ? data.byCancellationReason : [];
    lines.push('', 'MOTIVOS DE CANCELAMENTO', 'Motivo;Pedidos;Receita');
    reasons.forEach((r) => lines.push([r.name, r.count, csvMoney(r.revenue)].join(';')));

    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dashboard-${stamp}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showAppToast('Dashboard exportado em CSV.');
  }

  function printDashboardPdf(data) {
    const storeName = storeConfig?.storeName || 'Fabin Lanches';
    const title = `Dashboard — ${storeName} — ${data.periodLabel || ''}`;
    const tdHtml = (c) => {
      const s = String(c);
      const isNum = /^[R$ .\d,]+$|^\d+%?$/.test(s);
      return `<td${isNum ? ' class="num"' : ''}>${escapeHtml(s)}</td>`;
    };
    const section = (heading, head, rows) => {
      const headRow = `<tr>${head.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr>`;
      const body = rows && rows.length
        ? rows.map((r) => `<tr>${r.map(tdHtml).join('')}</tr>`).join('')
        : '<tr><td class="empty" colspan="10">Sem dados no período.</td></tr>';
      return `<h2>${escapeHtml(heading)}</h2><table><thead>${headRow}</thead><tbody>${body}</tbody></table>`;
    };
    const daily = Array.isArray(data.dailySales) ? data.dailySales : [];
    const byStatus = Array.isArray(data.byStatus) ? data.byStatus : [];
    const products = Array.isArray(data.topProducts) ? data.topProducts : [];
    const payments = Array.isArray(data.byPayment) ? data.byPayment : [];
    const neighborhoods = Array.isArray(data.topNeighborhoods) ? data.topNeighborhoods : [];
    const fulfillment = Array.isArray(data.byFulfillment) ? data.byFulfillment : [];
    const reasons = Array.isArray(data.byCancellationReason) ? data.byCancellationReason : [];

    const html =
      `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8" />` +
      `<title>${escapeHtml(title)}</title>` +
      `<style>` +
      `@page { size: A4; margin: 14mm; }` +
      `html, body { font-family: "Segoe UI", Arial, sans-serif; color: #111; background: #fff; }` +
      `h1 { font-size: 20px; margin: 0 0 2px; }` +
      `.sub { color: #444; margin-bottom: 16px; font-size: 12px; }` +
      `h2 { font-size: 14px; margin: 18px 0 6px; border-bottom: 1px solid #999; padding-bottom: 3px; }` +
      `table { width: 100%; border-collapse: collapse; margin-bottom: 6px; }` +
      `th, td { text-align: left; padding: 4px 6px; border: 1px solid #ccc; font-size: 11px; }` +
      `th { background: #eee; }` +
      `td.num { text-align: right; font-variant-numeric: tabular-nums; }` +
      `td.empty { color: #888; text-align: center; font-style: italic; }` +
      `</style></head><body>` +
      `<h1>Dashboard — ${escapeHtml(storeName)}</h1>` +
      `<div class="sub">Período: ${escapeHtml(data.periodLabel || '—')} · ` +
      `${escapeHtml(formatDateTime(data.fromUtc))} → ${escapeHtml(formatDateTime(data.toUtc))} · ` +
      `Gerado em ${escapeHtml(new Date().toLocaleString('pt-BR', { timeZone: APP_TIMEZONE }))}</div>` +
      section('Indicadores', ['Indicador', 'Valor'], [
        ['Pedidos', String(data.totalOrders ?? 0)],
        ['Pedidos hoje', String(data.ordersToday ?? 0)],
        ['Em aberto', String(data.openOrders ?? 0)],
        ['Finalizados', String(data.deliveredOrders ?? 0)],
        ['Cancelados', String(data.cancelledOrders ?? 0)],
        ['Faturamento', money(data.grossRevenue)],
        ['Ticket médio', money(data.averageTicket)],
        ['Itens', money(data.itemsRevenue)],
        ['Entregas', money(data.deliveryRevenue)]
      ]) +
      section('Vendas por dia', ['Data', 'Pedidos', 'Receita'],
        daily.map((d) => [d.date, String(d.orders), money(d.revenue)])) +
      section('Pedidos por status', ['Status', 'Pedidos'],
        byStatus.map((s) => [s.label || s.status, String(s.count)])) +
      section('Produtos mais vendidos', ['Produto', 'Qtd', 'Receita'],
        products.map((p) => [p.name, String(p.count), money(p.revenue)])) +
      section('Formas de pagamento', ['Forma', 'Pedidos', 'Receita'],
        payments.map((p) => [p.name, String(p.count), money(p.revenue)])) +
      section('Bairros', ['Bairro', 'Pedidos', 'Receita'],
        neighborhoods.map((n) => [n.name, String(n.count), money(n.revenue)])) +
      section('Entrega × Retirada', ['Tipo', 'Pedidos', 'Receita'],
        fulfillment.map((f) => [f.name, String(f.count), money(f.revenue)])) +
      section('Motivos de cancelamento', ['Motivo', 'Pedidos', 'Receita'],
        reasons.map((r) => [r.name, String(r.count), money(r.revenue)])) +
      `</body></html>`;

    let frame = document.getElementById('dashPrintFrame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'dashPrintFrame';
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('tabindex', '-1');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:900px;height:1100px;border:0;';
      document.body.appendChild(frame);
    }
    try {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (!doc) throw new Error('iframe indisponível');
      doc.open();
      doc.write(html);
      doc.close();
      const win = frame.contentWindow;
      if (!win) throw new Error('janela indisponível');
      let printed = false;
      const doPrint = () => {
        if (printed) return;
        printed = true;
        try {
          win.focus();
          win.print();
        } catch (_) {
          showAppToast('Não foi possível abrir a impressão.');
        }
      };
      const isReady = () => {
        try {
          const d = frame.contentDocument;
          return !!d && d.readyState === 'complete' && !!d.body && !!d.body.firstChild;
        } catch (_) {
          return false;
        }
      };
      let tries = 0;
      const waitAndPrint = () => {
        if (isReady() || tries >= 20) {
          doPrint();
          return;
        }
        tries += 1;
        setTimeout(waitAndPrint, 50);
      };
      setTimeout(waitAndPrint, 60);
    } catch (err) {
      console.error('printDashboardPdf', err);
      showAppToast('Não foi possível abrir a impressão.');
    }
  }

  function persistSession(data) {
    token = data.token;
    username = data.username || '';
    userRole = data.role || roleFromToken(data.token) || 'Atendimento';
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(ROLE_KEY, userRole);
    localStorage.setItem(USER_KEY, username);
    updateAccountUi();
  }

  async function login() {
    $('loginError').hidden = true;
    const user = $('username').value.trim();
    const pass = $('password').value;
    if (!user || !pass) {
      $('loginError').hidden = false;
      $('loginError').textContent = 'Informe usuário e senha.';
      return;
    }

    try {
      // Login separado: 401 aqui é credencial inválida, não sessão expirada
      const res = await fetch(`${API}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass })
      });
      if (!res.ok) {
        $('loginError').hidden = false;
        $('loginError').textContent = res.status === 401
          ? 'Usuário ou senha inválidos.'
          : `Falha no login (${res.status}).`;
        return;
      }
      const data = await res.json();
      if (!data || !data.token) throw new Error('Token ausente');
      persistSession(data);
      showApp(true);
      try {
        await refresh();
      } catch (refreshErr) {
        console.warn('Login ok, mas falha ao carregar dados:', refreshErr);
        $('loginError').hidden = false;
        $('loginError').textContent =
          `Entrou como ${username} (${userRole}), mas houve erro ao carregar: ${refreshErr.message || refreshErr}`;
      }
    } catch (err) {
      const hint = err && err.message ? String(err.message) : '';
      const corsLike = /Failed to fetch|NetworkError|CORS|Load failed/i.test(hint);
      $('loginError').hidden = false;
      $('loginError').textContent = corsLike
        ? `Não foi possível falar com a API (${API}). Confira se o gateway está no ar e o CORS libera esta origem.`
        : (hint || 'Falha no login.');
      console.error('Login error', API, err);
      if (!token) logout();
    }
  }

  async function refresh() {
    if (!token) {
      logout();
      return;
    }

    applyRoleUi();

    loadStoreConfigTablesFlags().catch(() => {});

    const store = await api('/api/v1/store');
    storeConfig = store || storeConfig;
    const topTitle = $('topbarStoreTitle');
    if (topTitle) topTitle.textContent = isPlatformDev()
      ? 'Plataforma'
      : (store.storeName || 'Loja');
    updateStoreIconUi(store?.iconUrl || '');
    if (isStoreAdmin()) {
      fillStoreForm(store);
      try {
        const [adminCatalog, adminIngredients] = await Promise.all([
          api('/api/v1/admin/catalog', { headers: authHeaders() }),
          api('/api/v1/admin/ingredients', { headers: authHeaders() })
        ]);
        catalog = adminCatalog;
        ingredients = Array.isArray(adminIngredients) ? adminIngredients : [];
        renderCategories();
        renderIngredients();
        renderOpcionais();
        renderProducts();
      } catch (err) {
        console.warn('Catálogo admin indisponível para este perfil:', err);
      }
    } else {
      // Garçom/Atendimento também usam o catálogo público para detectar bebidas
      // (fast-deliver de mesa e skip de impressão automática).
      try {
        const publicCatalog = await api('/api/v1/catalog');
        catalog = (publicCatalog && Array.isArray(publicCatalog.categories)) ? publicCatalog : { categories: [] };
      } catch (err) {
        console.warn('Catálogo público indisponível para este perfil:', err);
        catalog = { categories: [] };
      }
      ingredients = [];
    }
    if (canSeeOrders()) {
      await refreshOrders({ silent: true });
    }
    if (isStoreAdmin() && activeTab === 'dashboard') {
      loadDashboard({ silent: true }).catch(() => {});
    }
    if (isStoreAdmin() && activeTab === 'team') {
      loadTeam().catch(() => {});
    }
    if (isPlatformDev() && activeTab === 'platform') {
      await loadPlatformDashboard({ silent: true }).catch(() => {});
    }
    if (isPlatformDev() && activeTab === 'lojas') {
      await loadPlatformStores().catch(() => {});
    }
  }

  // ── Equipe / Garçons (Admin de loja) ──
  async function loadTeam() {
    if (!token || !isStoreAdmin()) return;
    const list = $('teamList');
    if (!list) return;
    list.innerHTML = '<p class="muted">Carregando…</p>';
    const users = await api('/api/v1/admin/staff', { headers: authHeaders() });
    if (!Array.isArray(users)) { list.innerHTML = ''; return; }
    const isGarcom = (u) => /^gar(c|ç)om$/i.test(String((u.role || '')).trim());
    const garcons = users.filter(isGarcom);
    const meta = $('teamMeta');
    if (meta) meta.textContent = garcons.length
      ? `${garcons.length} garçom(ens) cadastrado(s).`
      : 'Nenhum garçom cadastrado ainda.';
    if (!garcons.length) {
      list.innerHTML = '<p class="muted">Nenhum garçom cadastrado ainda. Use "Adicionar garçom".</p>';
      return;
    }
    list.innerHTML = garcons.map((u) =>
      `<div class="platform-user-row">` +
        `<span class="user-main"><span class="user-badge role-${escapeHtml((u.role || '').toLowerCase())}">${escapeHtml(u.role || '—')}</span>` +
        `<strong>${escapeHtml(u.displayName || u.username)}</strong>` +
        `</span>` +
        `<span class="user-actions">` +
          `<button type="button" class="ghost compact" data-team-edit="${escapeHtml(u.id)}">Editar</button>` +
          `<button type="button" class="ghost compact" data-team-pin="${escapeHtml(u.id)}">${u.hasPin ? 'Alterar PIN' : 'Definir PIN'}</button>` +
          (u.hasPin ? `<button type="button" class="ghost compact" data-team-pin-clear="${escapeHtml(u.id)}">Limpar PIN</button>` : '') +
          `<button type="button" class="ghost compact" data-team-reset="${escapeHtml(u.id)}">Resetar senha</button>` +
          `<button type="button" class="ghost compact danger" data-team-del="${escapeHtml(u.id)}">Excluir</button>` +
        `</span></div>`
    ).join('');
    list.querySelectorAll('[data-team-edit]').forEach((b) => {
      b.addEventListener('click', () => {
        const u = users.find((x) => String(x.id) === b.dataset.teamEdit);
        if (u) editStaffUser(u).catch((e) => showAppToast(e.message || 'Erro'));
      });
    });
    list.querySelectorAll('[data-team-pin]').forEach((b) => {
      b.addEventListener('click', () => setStaffPin(Number(b.dataset.teamPin), { hasPin: b.textContent.trim().startsWith('Alterar') })
        .catch((e) => showAppToast(e.message || 'Erro')));
    });
    list.querySelectorAll('[data-team-pin-clear]').forEach((b) => {
      b.addEventListener('click', () => clearStaffPin(Number(b.dataset.teamPinClear)).catch((e) => showAppToast(e.message || 'Erro')));
    });
    list.querySelectorAll('[data-team-reset]').forEach((b) => {
      b.addEventListener('click', () => resetStaffPassword(Number(b.dataset.teamReset)).catch((e) => showAppToast(e.message || 'Erro')));
    });
    list.querySelectorAll('[data-team-del]').forEach((b) => {
      b.addEventListener('click', () => deleteStaffUser(Number(b.dataset.teamDel)).catch((e) => showAppToast(e.message || 'Erro')));
    });
  }

  // Abre modal para editar os dados de um garçom (Nome, Usuário, e opcionalmente Senha/PIN).
  function editStaffUser(user) {
    return new Promise((resolve, reject) => {
      const modal = document.createElement('div');
      modal.id = 'staffEditModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="staffEditTitle">` +
        `<h3 id="staffEditTitle">Editar garçom</h3>` +
        `<p class="muted">Atualize os dados do garçom. Deixe Senha/PIN vazios para mantê-los como estão.</p>` +
        `<label class="field-label">Nome</label>` +
        `<input id="staffEditName" class="type-confirm-input" type="text" autocomplete="off" placeholder="Nome do garçom" />` +
        `<label class="field-label">Usuário</label>` +
        `<input id="staffEditUsername" class="type-confirm-input" type="text" autocomplete="off" placeholder="Ex.: garcom1" />` +
        `<label class="field-label">Nova senha (opcional)</label>` +
        `<input id="staffEditPassword" class="type-confirm-input" type="password" autocomplete="off" placeholder="Mín. 6 caracteres (deixe vazio para manter)" />` +
        `<label class="field-label">Novo PIN (opcional)</label>` +
        `<input id="staffEditPin" class="type-confirm-input" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" placeholder="4 dígitos (deixe vazio para manter)" />` +
        `<p id="staffEditError" class="error" hidden></p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-staff-edit-save>Salvar</button>` +
        `<button type="button" class="ghost compact" data-staff-edit-cancel>Cancelar</button>` +
        `</div></div>`;
      document.body.appendChild(modal);
      const nameInput = modal.querySelector('#staffEditName');
      const userInput = modal.querySelector('#staffEditUsername');
      const passInput = modal.querySelector('#staffEditPassword');
      const pinInput = modal.querySelector('#staffEditPin');
      nameInput.value = user.displayName || '';
      userInput.value = user.username || '';
      const finish = (v) => { document.removeEventListener('keydown', onKey); modal.remove(); v instanceof Error ? reject(v) : resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      const errEl = modal.querySelector('#staffEditError');
      const showError = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
      modal.querySelector('[data-staff-edit-cancel]').addEventListener('click', () => finish(false));
      modal.addEventListener('click', (e) => { if (e.target === modal) finish(false); });
      const save = async () => {
        const payload = {
          username: (userInput.value || '').trim(),
          role: user.role || 'Garçom',
          displayName: (nameInput.value || '').trim() || null,
          password: (passInput.value || '').trim() || null,
          pin: (pinInput.value || '').trim() || null
        };
        try {
          const updated = await api(`/api/v1/admin/staff/${user.id}`, {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify(payload)
          });
          showAppToast('Garçom atualizado.');
          finish(updated);
        } catch (e) { showError(e.message || 'Erro ao salvar.'); }
      };
      modal.querySelector('[data-staff-edit-save]').addEventListener('click', save);
      userInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
      document.addEventListener('keydown', onKey);
      (nameInput || userInput)?.focus();
    }).then(async () => { await loadTeam(); });
  }

  function addTeamUser() {
    return new Promise((resolve, reject) => {
      const existing = $('staffAddModal');
      if (existing) existing.remove();
      const modal = document.createElement('div');
      modal.id = 'staffAddModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="staffAddTitle">` +
        `<h3 id="staffAddTitle">Adicionar garçom</h3>` +
        `<p class="muted">Cadastre um novo garçom da loja.</p>` +
        `<label class="field-label">Nome</label>` +
        `<input id="staffAddName" class="type-confirm-input" type="text" autocomplete="off" placeholder="Nome do garçom" />` +
        `<label class="field-label">Usuário</label>` +
        `<input id="staffAddUsername" class="type-confirm-input" type="text" autocomplete="off" placeholder="Ex.: garcom1" />` +
        `<label class="field-label">Senha</label>` +
        `<input id="staffAddPassword" class="type-confirm-input" type="password" autocomplete="new-password" placeholder="Mín. 6 caracteres" />` +
        `<label class="field-label">PIN</label>` +
        `<input id="staffAddPin" class="type-confirm-input" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off" placeholder="4 dígitos (obrigatório para Garçom)" />` +
        `<p id="staffAddError" class="error" hidden></p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-staff-add-save>Salvar</button>` +
        `<button type="button" class="ghost compact" data-staff-add-cancel>Cancelar</button>` +
        `</div></div>`;
      document.body.appendChild(modal);
      const finish = (v) => { document.removeEventListener('keydown', onKey); modal.remove(); v instanceof Error ? reject(v) : resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      const errEl = modal.querySelector('#staffAddError');
      const showError = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
      const pinInput = modal.querySelector('#staffAddPin');
      modal.querySelector('[data-staff-add-cancel]').addEventListener('click', () => finish(false));
      modal.addEventListener('click', (e) => { if (e.target === modal) finish(false); });
      const save = async () => {
        const name = (modal.querySelector('#staffAddName') || {}).value?.trim() || '';
        const username = (modal.querySelector('#staffAddUsername') || {}).value?.trim() || '';
        const password = (modal.querySelector('#staffAddPassword') || {}).value || '';
        const pin = (pinInput?.value || '').trim() || '';
        try {
          if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(username)) throw new Error('Usuário: use letras, números, _ ou -.');
          if (password.length < 6) throw new Error('Senha muito curta (mín. 6 caracteres).');
          if (name.length < 2) throw new Error('Nome é obrigatório para o papel Garçom.');
          if (!/^\d{4}$/.test(pin)) throw new Error('PIN é obrigatório para o papel Garçom (4 dígitos).');
          await api('/api/v1/admin/staff', {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ username, password, role: 'Garçom', displayName: name || null, pin: pin || null })
          });
          showAppToast('Garçom adicionado.');
          finish(true);
        } catch (e) { showError(e.message || 'Erro ao salvar.'); }
      };
      modal.querySelector('[data-staff-add-save]').addEventListener('click', save);
      (modal.querySelector('#staffAddName') || {}).focus();
      document.addEventListener('keydown', onKey);
    });
  }

  async function resetStaffPassword(userId) {
    const newPass = prompt('Nova senha (mín. 6 caracteres):');
    if (newPass === null) return;
    if (newPass.length < 6) throw new Error('Senha muito curta (mín. 6 caracteres).');
    await api(`/api/v1/admin/staff/${userId}/reset-password`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ password: newPass })
    });
    showAppToast('Senha atualizada.');
  }

  async function deleteStaffUser(userId) {
    const ok = await askConfirm('Excluir este usuário da loja?', { confirmLabel: 'Excluir' });
    if (!ok) return;
    const target = String(userId);
    await api(`/api/v1/admin/staff/${target}`, { method: 'DELETE', headers: authHeaders() });
    showAppToast('Usuário excluído.');
    await loadTeam();
  }

  function setStaffPin(userId) {
    return new Promise((resolve, reject) => {
      const modal = document.createElement('div');
      modal.id = 'staffPinModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="staffPinTitle">` +
        `<h3 id="staffPinTitle">${'Definir PIN do garçom'}</h3>` +
        `<p class="muted">Defina o PIN de 4 dígitos com o qual este garçom autoriza ações de consumo no local.</p>` +
        `<label class="field-label">PIN (4 dígitos)</label>` +
        `<input id="staffPinInput" class="type-confirm-input" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="••••" autocomplete="off" />` +
        `<label class="field-label">Confirmar PIN</label>` +
        `<input id="staffPinConfirm" class="type-confirm-input" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="••••" autocomplete="off" />` +
        `<p id="staffPinError" class="error" hidden></p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-staff-pin-save>Definir</button>` +
        `<button type="button" class="ghost compact" data-staff-pin-cancel>Cancelar</button>` +
        `</div></div>`;
      document.body.appendChild(modal);
      const finish = (v) => { document.removeEventListener('keydown', onKey); modal.remove(); v instanceof Error ? reject(v) : resolve(v); };
      const onKey = (e) => { if (e.key === 'Escape') finish(false); };
      const errEl = modal.querySelector('#staffPinError');
      const showError = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
      modal.querySelector('[data-staff-pin-cancel]').addEventListener('click', () => finish(false));
      modal.addEventListener('click', (e) => { if (e.target === modal) finish(false); });
      const savePin = async () => {
        const pin = (modal.querySelector('#staffPinInput') || {}).value || '';
        const confirm = (modal.querySelector('#staffPinConfirm') || {}).value || '';
        if (pin.length !== 4 || !/^\d{4}$/.test(pin)) { showError('O PIN deve ter 4 dígitos.'); return; }
        if (pin !== confirm) { showError('Os PINs não coincidem.'); return; }
        try {
          await api(`/api/v1/admin/staff/${userId}/pin`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ pin })
          });
          showAppToast('PIN definido.');
          finish(true);
        } catch (e) { showError(e.message || 'Erro ao salvar PIN.'); }
      };
      modal.querySelector('[data-staff-pin-save]').addEventListener('click', savePin);
      const confirmInput = modal.querySelector('#staffPinConfirm');
      if (confirmInput) {
        confirmInput.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); savePin(); }
        });
      }
      document.addEventListener('keydown', onKey);
      (modal.querySelector('#staffPinInput') || {}).focus();
    }).then(async () => { await loadTeam(); });
  }

  async function clearStaffPin(userId) {
    const ok = await askConfirm('Remover o PIN deste garçom?', { confirmLabel: 'Limpar PIN' });
    if (!ok) return;
    await api(`/api/v1/admin/staff/${userId}/pin`, { method: 'DELETE', headers: authHeaders() });
    showAppToast('PIN removido.');
    await loadTeam();
  }

  function destroyCharts() {
    Object.keys(chartInstances).forEach((key) => {
      destroyChartKey(key);
    });
  }

  function upsertChart(key, canvas, config) {
    if (!canvas || typeof Chart === 'undefined') return null;
    destroyChartKey(key);
    releaseCanvas(canvas);
    try {
      const chart = new Chart(canvas, config);
      chartInstances[key] = chart;
      // Tab recém-exibida pode ter largura 0 no 1º paint — redimensiona no próximo frame
      requestAnimationFrame(() => {
        try { chart.resize(); } catch (_) { /* ignore */ }
      });
      return chart;
    } catch (err) {
      console.warn(`Falha ao montar gráfico ${key}`, err);
      delete chartInstances[key];
      return null;
    }
  }

  function chartDefaults() {
    return {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          labels: { color: '#cbd5e1', boxWidth: 12 }
        }
      },
      scales: {
        x: {
          ticks: { color: '#94a3b8', maxRotation: 45, minRotation: 0 },
          grid: { color: 'rgba(51,65,85,0.5)' }
        },
        y: {
          ticks: { color: '#94a3b8' },
          grid: { color: 'rgba(51,65,85,0.5)' },
          beginAtZero: true
        }
      }
    };
  }

  function generateLegendWithRevenue(chart, source) {
    const ds = chart.data.datasets[0];
    const labels = chart.data.labels || [];
    return labels.map((label, i) => ({
      text: `${label} — ${money(Number(source?.[i]?.revenue) || 0)}`,
      fillStyle: Array.isArray(ds.backgroundColor) ? ds.backgroundColor[i] : ds.backgroundColor,
      strokeStyle: Array.isArray(ds.backgroundColor) ? ds.backgroundColor[i] : ds.backgroundColor,
      lineWidth: 0,
      hidden: Number(ds.data[i] || 0) === 0,
      index: i
    }));
  }

  async function loadDashboard({ silent } = {}) {
    if (!token || !isStoreAdmin()) return;
    const daysEl = $('dashboardDays');
    dashboardPeriod = (daysEl && daysEl.value) || dashboardPeriod || 'today';
    try {
      const data = await api(`/api/v1/orders/dashboard?period=${encodeURIComponent(dashboardPeriod)}`, {
        headers: authHeaders()
      });
      renderDashboard(data);
    } catch (err) {
      if (!silent) throw err;
      console.warn('Dashboard', err);
      const meta = $('dashMeta');
      if (meta) meta.textContent = `Falha ao carregar dashboard: ${err.message || err}`;
    }
  }

  function renderDashboard(data) {
    lastDashboardData = data;
    const kpis = $('dashKpis');
    if (!kpis) return;

    const period = String(data.period || dashboardPeriod || 'today').toLowerCase();
    const singleDay = period === 'today' || period === 'yesterday' || period === 'hoje' || period === 'ontem';
    const cancelledCount = Number(data.cancelledOrders ?? 0);
    const cards = singleDay
      ? [
          { label: 'Pedidos', value: String(data.totalOrders ?? 0) },
          { label: 'Em aberto', value: String(data.openOrders ?? 0) },
          { label: 'Finalizados', value: String(data.deliveredOrders ?? 0) },
          ...(cancelledCount > 0 ? [
            { label: 'Cancelados', value: String(cancelledCount) },
            { label: 'Taxa de cancelamento', value: `${((cancelledCount / Math.max(Number(data.totalOrders ?? 0), 1)) * 100).toFixed(1)}%` }
          ] : []),
          { label: 'Faturamento', value: money(data.grossRevenue) },
          { label: 'Ticket médio', value: money(data.averageTicket) },
          { label: 'Itens', value: money(data.itemsRevenue) },
          { label: 'Entregas', value: money(data.deliveryRevenue) }
        ]
      : [
          { label: 'Pedidos (período)', value: String(data.totalOrders ?? 0) },
          { label: 'Pedidos hoje', value: String(data.ordersToday ?? 0) },
          { label: 'Em aberto', value: String(data.openOrders ?? 0) },
          { label: 'Finalizados (período)', value: String(data.deliveredOrders ?? 0) },
          ...(cancelledCount > 0 ? [
            { label: 'Cancelados', value: String(cancelledCount) },
            { label: 'Taxa de cancelamento', value: `${((cancelledCount / Math.max(Number(data.totalOrders ?? 0), 1)) * 100).toFixed(1)}%` }
          ] : []),
          { label: 'Faturamento', value: money(data.grossRevenue) },
          { label: 'Ticket médio', value: money(data.averageTicket) },
          { label: 'Itens', value: money(data.itemsRevenue) },
          { label: 'Entregas', value: money(data.deliveryRevenue) }
        ];
    kpis.innerHTML = cards.map((c) =>
      `<div class="dash-kpi"><span class="label">${escapeHtml(c.label)}</span>` +
      `<span class="value">${escapeHtml(c.value)}</span></div>`
    ).join('');

    const meta = $('dashMeta');
    if (meta) {
      const label = data.periodLabel || (singleDay ? (period === 'yesterday' || period === 'ontem' ? 'Ontem' : 'Hoje') : `${data.days || ''} dias`);
      meta.textContent =
        `${label}: ${formatDateTime(data.fromUtc)} → ${formatDateTime(data.toUtc)}`;
    }

    const daily = Array.isArray(data.dailySales) ? data.dailySales : [];
    const dailyLabels = daily.map((d) => {
      const parts = String(d.date || '').split('-');
      return parts.length === 3 ? `${parts[2]}/${parts[1]}` : String(d.date || '');
    });
    const dailyRevenue = daily.map((d) => Number(d.revenue || 0));
    const dailyOrders = daily.map((d) => Number(d.orders || 0));
    // Barra + linha: mais estável que linha dupla com fill (Chart.js / canvas reutilizado)
    upsertChart('daily', $('chartDaily'), {
      data: {
        labels: dailyLabels.length ? dailyLabels : ['—'],
        datasets: [
          {
            type: 'bar',
            label: 'Receita (R$)',
            data: dailyRevenue.length ? dailyRevenue : [0],
            backgroundColor: 'rgba(56,189,248,0.55)',
            borderColor: '#38bdf8',
            borderWidth: 1,
            borderRadius: 4,
            yAxisID: 'y',
            order: 2
          },
          {
            type: 'line',
            label: 'Pedidos',
            data: dailyOrders.length ? dailyOrders : [0],
            borderColor: '#fbbf24',
            backgroundColor: '#fbbf24',
            pointRadius: dailyOrders.length <= 2 ? 5 : 3,
            pointHoverRadius: 6,
            tension: 0.3,
            fill: false,
            yAxisID: 'y1',
            order: 1
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            labels: { color: '#cbd5e1', boxWidth: 12 }
          }
        },
        scales: {
          x: {
            ticks: { color: '#94a3b8', maxRotation: 45, minRotation: 0 },
            grid: { color: 'rgba(51,65,85,0.5)' }
          },
          y: {
            type: 'linear',
            position: 'left',
            beginAtZero: true,
            ticks: {
              color: '#94a3b8',
              callback: (v) => Number(v).toLocaleString('pt-BR', { maximumFractionDigits: 0 })
            },
            grid: { color: 'rgba(51,65,85,0.5)' },
            title: { display: true, text: 'R$', color: '#64748b', font: { size: 11 } }
          },
          y1: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            ticks: { color: '#94a3b8', precision: 0 },
            grid: { drawOnChartArea: false },
            title: { display: true, text: 'Pedidos', color: '#64748b', font: { size: 11 } }
          }
        }
      }
    });

    const byStatus = data.byStatus || [];
    upsertChart('status', $('chartStatus'), {
      type: 'doughnut',
      data: {
        labels: byStatus.map((s) => s.label || s.status),
        datasets: [{
          data: byStatus.map((s) => Number(s.count || 0)),
          backgroundColor: ['#f59e0b', '#3b82f6', '#eab308', '#06b6d4', '#a78bfa', '#22c55e', '#f87171']
        }]
      },
      options: {
        plugins: { legend: { position: 'bottom', labels: { color: '#cbd5e1', boxWidth: 12 } } }
      }
    });

    const products = data.topProducts || [];
    upsertChart('products', $('chartProducts'), {
      type: 'bar',
      data: {
        labels: products.map((p) => p.name),
        datasets: [{
          label: 'Qtd vendida',
          data: products.map((p) => Number(p.count || 0)),
          backgroundColor: '#38bdf8'
        }]
      },
      options: {
        ...chartDefaults(),
        indexAxis: 'y',
        plugins: { legend: { display: false } }
      }
    });

    const payments = data.byPayment || [];
    upsertChart('payment', $('chartPayment'), {
      type: 'pie',
      data: {
        labels: payments.map((p) => p.name),
        datasets: [{
          data: payments.map((p) => Number(p.count || 0)),
          backgroundColor: ['#22c55e', '#38bdf8', '#f59e0b', '#a78bfa', '#f472b6']
        }]
      },
      options: {
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#cbd5e1',
              boxWidth: 12,
              generateLabels: (chart) => generateLegendWithRevenue(chart, payments)
            }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const p = payments[ctx.dataIndex];
                const count = Number(p?.count || 0);
                const rev = Number(p?.revenue || 0);
                return `${count} pedido${count === 1 ? '' : 's'} · ${money(rev)}`;
              }
            }
          }
        }
      }
    });

    const neighborhoods = data.topNeighborhoods || [];
    upsertChart('neighborhood', $('chartNeighborhood'), {
      type: 'bar',
      data: {
        labels: neighborhoods.map((n) => n.name),
        datasets: [{
          label: 'Pedidos',
          data: neighborhoods.map((n) => Number(n.count || 0)),
          backgroundColor: '#34d399'
        }]
      },
      options: {
        ...chartDefaults(),
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel: (ctx) => {
                const n = neighborhoods[ctx.dataIndex];
                return n && Number(n.revenue) ? `Receita: ${money(n.revenue)}` : '';
              }
            }
          }
        }
      }
    });

    const fulfillment = Array.isArray(data.byFulfillment) ? data.byFulfillment : [];
    const fulfillmentCard = $('dashFulfillmentCard');
    if (fulfillmentCard) {
      const showFulfillment = Number(data.totalOrders || 0) > 0;
      fulfillmentCard.hidden = !showFulfillment;
      if (showFulfillment) {
        upsertChart('fulfillment', $('chartFulfillment'), {
          type: 'doughnut',
          data: {
            labels: fulfillment.map((f) => f.name || '—'),
            datasets: [{
              data: fulfillment.map((f) => Number(f.count || 0)),
              backgroundColor: ['#38bdf8', '#fbbf24']
            }]
          },
          options: {
            plugins: {
              legend: {
                position: 'bottom',
                labels: {
                  color: '#cbd5e1',
                  boxWidth: 12,
                  generateLabels: (chart) => generateLegendWithRevenue(chart, fulfillment)
                }
              },
              tooltip: {
                callbacks: {
                  label: (ctx) => {
                    const f = fulfillment[ctx.dataIndex];
                    const count = Number(f?.count || 0);
                    const rev = Number(f?.revenue || 0);
                    return `${count} pedido${count === 1 ? '' : 's'} · ${money(rev)}`;
                  }
                }
              }
            }
          }
        });
      } else {
        destroyChartKey('fulfillment');
      }
    }

    const cancelReasons = Array.isArray(data.byCancellationReason) ? data.byCancellationReason : [];
    const cancelCard = $('dashCancelReasonsCard');
    if (cancelCard) {
      const showCancelChart = cancelledCount > 0 && cancelReasons.length > 0;
      cancelCard.hidden = !showCancelChart;
      if (showCancelChart) {
        upsertChart('cancelReasons', $('chartCancelReasons'), {
          type: 'bar',
          data: {
            labels: cancelReasons.map((r) => r.name || '—'),
            datasets: [{
              label: 'Cancelamentos',
              data: cancelReasons.map((r) => Number(r.count || 0)),
              backgroundColor: '#f87171'
            }]
          },
          options: {
            ...chartDefaults(),
            indexAxis: 'y',
            plugins: { legend: { display: false } }
          }
        });
      } else {
        destroyChartKey('cancelReasons');
      }
    }

    const table = $('dashTopProducts');
    if (table) {
      if (!products.length) {
        table.innerHTML = '<div class="dash-empty">Sem vendas no período.</div>';
      } else {
        table.innerHTML =
          `<table class="dash-table"><thead><tr>` +
          `<th>#</th><th>Produto</th><th class="num">Qtd</th><th class="num">Receita</th>` +
          `</tr></thead><tbody>` +
          products.map((p, i) =>
            `<tr><td>${i + 1}</td><td>${escapeHtml(p.name)}</td>` +
            `<td class="num">${Number(p.count || 0)}</td>` +
            `<td class="num">${money(p.revenue)}</td></tr>`
          ).join('') +
          `</tbody></table>`;
      }
    }
  }

  async function tryRestoreSession() {
    const saved = localStorage.getItem(TOKEN_KEY) || '';
    if (!saved) {
      showApp(false);
      return;
    }
    token = saved;
    userRole = localStorage.getItem(ROLE_KEY) || roleFromToken(saved) || '';
    username = localStorage.getItem(USER_KEY) || '';
    try {
      const me = await api('/api/v1/auth/me', { headers: authHeaders() });
      username = me.username || username;
      userRole = me.role || userRole || roleFromToken(token) || 'Atendimento';
      localStorage.setItem(ROLE_KEY, userRole);
      localStorage.setItem(USER_KEY, username);
      showApp(true);
      updateAccountUi();
      await refresh();
    } catch (_) {
      logout();
    }
  }

  function money(value) {
    return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  /** Prefere deliveryFee; se vier 0, tenta derivar de total − itens. */
  function orderDeliveryFee(order) {
    const fee = Number(order?.deliveryFee);
    if (Number.isFinite(fee) && fee > 0) return fee;
    const items = Number(order?.itemsTotal) || 0;
    const total = Number(order?.total) || 0;
    const derived = Math.round((total - items) * 100) / 100;
    return derived > 0 ? derived : (Number.isFinite(fee) ? fee : 0);
  }

  function toDateInput(value) {
    if (!value) return '';
    const key = dateKeyInSaoPaulo(value);
    return key || '';
  }

  function fromDateInput(value) {
    if (!value) return null;
    return `${value}T00:00:00.000Z`;
  }

  function paymentStatusLabel(status) {
    const map = {
      pending: 'Pendente',
      paid: 'Pago',
      overdue: 'Em atraso',
      courtesy: 'Cortesia'
    };
    return map[String(status || '').toLowerCase()] || status || '—';
  }

  function resetPlatformStoreForm() {
    editingPlatformStoreId = null;
    platformDuplicateSourceId = null;
    $('platformStoreId').value = '';
    $('platformName').value = '';
    $('platformCnpj').value = '';
    $('platformRazaoSocial').value = '';
    $('platformPlan').value = '';
    $('platformSegmento').value = '';
    $('platformSegmentoCustom').value = '';
    $('platformSegmentoCustomWrap').hidden = true;
    $('platformStatus').value = 'active';
    $('platformContactName').value = '';
    $('platformPhone').value = '';
    $('platformEmail').value = '';
    $('platformAddress').value = '';
    $('platformAddressNumber').value = '';
    $('platformCep').value = '';
    $('platformCity').value = '';
    $('platformState').value = '';
    $('platformLogoFile').value = '';
    setPlatformLogoPreview(null);
    $('platformLogoStatus').hidden = true;
    $('platformAdminUsername').value = '';
    $('platformAdminPassword').value = '';
    $('platformFrontUrl').value = '';
    $('platformFrontNotes').value = '';
    $('platformBackUrl').value = '';
    $('platformBackNotes').value = '';
    $('platformBackUsername').value = '';
    $('platformBackPassword').value = '';
    $('platformAdminUrl').value = '';
    $('platformDatabaseUrl').value = '';
    $('platformDatabaseInfo').value = '';
    $('platformLocalFrontUrl').value = '';
    $('platformLocalBackUrl').value = '';
    $('platformLocalAdminUrl').value = '';
    $('platformLocalDatabaseUrl').value = '';
    $('platformMonthlyFee').value = '0';
    $('platformCourtesy').checked = false;
    $('platformCourtesyUntil').value = '';
    $('platformPaymentStatus').value = 'pending';
    $('platformLastPaymentAt').value = '';
    $('platformNextDueAt').value = '';
    $('platformPaymentNotes').value = '';
    $('platformActive').checked = true;
    $('platformDomain').value = '';
    $('platformApiKey').value = '';
    $('platformWebhookUrl').value = '';
    $('platformGalleryFile').value = '';
    $('platformGalleryTitle').value = '';
    $('platformUserUsername').value = '';
    $('platformUserPassword').value = '';
    $('platformUsersList').innerHTML = '';
    $('platformPaymentsList').innerHTML = '';
    $('platformGalleryList').innerHTML = '';
    $('platformNewStoreAdmin').hidden = false;
    $('platformFormTitle').textContent = 'Nova loja';
    switchPlatformModalTab('dados');
    $('platformStoreModal').hidden = true;
  }

  function populatePlatformStoreForm(store) {
    $('platformName').value = store.name || '';
    $('platformCnpj').value = maskCnpj(store.cnpj);
    $('platformRazaoSocial').value = store.razaoSocial || '';
    $('platformPlan').value = store.plan || '';
    const seg = store.segment || '';
    if (!seg || ['Açougue', 'Gás', 'Hamburgueria', 'Lanchonete', 'Pizzaria'].includes(seg)) {
      $('platformSegmento').value = seg;
      $('platformSegmentoCustomWrap').hidden = true;
    } else {
      $('platformSegmento').value = '__custom__';
      $('platformSegmentoCustom').value = seg;
      $('platformSegmentoCustomWrap').hidden = false;
    }
    $('platformStatus').value = store.status || 'active';
    $('platformContactName').value = store.contactName || '';
    $('platformPhone').value = store.phone || '';
    $('platformEmail').value = store.email || '';
    $('platformAddress').value = store.address || '';
    $('platformAddressNumber').value = store.addressNumber || '';
    $('platformCep').value = maskCep(store.cep);
    $('platformCity').value = store.city || '';
    $('platformState').value = store.state || '';
    setPlatformLogoPreview(store.logoUrl);
    $('platformFrontUrl').value = store.frontUrl || '';
    $('platformFrontNotes').value = store.frontNotes || '';
    $('platformBackUrl').value = store.backUrl || '';
    $('platformBackNotes').value = store.backNotes || '';
    $('platformBackUsername').value = store.backUsername || '';
    $('platformBackPassword').value = store.backPassword || '';
    $('platformAdminUrl').value = store.adminUrl || '';
    $('platformDatabaseUrl').value = store.databaseUrl || '';
    $('platformDatabaseInfo').value = store.databaseInfo || '';
    $('platformLocalFrontUrl').value = store.localFrontUrl || '';
    $('platformLocalBackUrl').value = store.localBackUrl || '';
    $('platformLocalAdminUrl').value = store.localAdminUrl || '';
    $('platformLocalDatabaseUrl').value = store.localDatabaseUrl || '';
    $('platformMonthlyFee').value = store.monthlyFee != null ? store.monthlyFee : 0;
    $('platformCourtesy').checked = !!store.courtesy;
    $('platformCourtesyUntil').value = toDateInput(store.courtesyUntil);
    $('platformPaymentStatus').value = store.paymentStatus || 'pending';
    $('platformLastPaymentAt').value = toDateInput(store.lastPaymentAt);
    $('platformNextDueAt').value = toDateInput(store.nextDueAt);
    $('platformPaymentNotes').value = store.paymentNotes || '';
    $('platformActive').checked = store.active !== false;
    $('platformDomain').value = store.domain || '';
    $('platformApiKey').value = store.apiKey || '';
    $('platformWebhookUrl').value = store.webhookUrl || '';
  }

  function setPlatformLogoPreview(url) {
    const img = $('platformLogoPreview');
    if (!img) return;
    if (url) {
      img.src = url.startsWith('http') ? url : `${API}${url}`;
      img.hidden = false;
      wireImageZoom(img, 'Logo da loja');
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }

  function showPlatformStoreForm(store, { duplicateSource = null } = {}) {
    resetPlatformStoreForm();
    $('platformStoreModal').hidden = false;
    if (store) {
      editingPlatformStoreId = store.id;
      $('platformStoreId').value = store.id;
      populatePlatformStoreForm(store);
      $('platformNewStoreAdmin').hidden = true;
      $('platformFormTitle').textContent = `Editar · ${store.name}`;
      renderPlatformPayments(store.payments || []);
      renderPlatformGallery(store.gallery || []);
      loadPlatformUsers(store.id).catch(() => {});
    } else if (duplicateSource) {
      platformDuplicateSourceId = duplicateSource.id;
      const copy = { ...duplicateSource, name: `${duplicateSource.name} (cópia)` };
      populatePlatformStoreForm(copy);
      $('platformNewStoreAdmin').hidden = false;
      $('platformFormTitle').textContent = `Duplicar · ${duplicateSource.name}`;
      renderPlatformPayments(store && store.payments ? store.payments : copy.payments || []);
      renderPlatformGallery(copy.gallery || []);
    }
    switchPlatformModalTab('dados');
  }

  function renderPlatformPayments(payments) {
    const box = $('platformPaymentsList');
    if (!box) return;
    const list = Array.isArray(payments) ? payments : [];
    box.innerHTML = list.length
      ? list.slice(0, 10).map((p) =>
          `<li>${escapeHtml(formatDateTime(p.paidAt))} · ${escapeHtml(money(p.amount))}${p.note ? ` · ${escapeHtml(p.note)}` : ''}</li>`
        ).join('')
      : '<li class="muted">Sem pagamentos registrados.</li>';
  }

  function renderPlatformGallery(gallery) {
    const box = $('platformGalleryList');
    if (!box) return;
    const list = Array.isArray(gallery) ? gallery : [];
    if (!list.length) {
      box.innerHTML = '<p class="muted">Nenhuma imagem na galeria.</p>';
      return;
    }
    box.innerHTML = list.map((g) =>
      `<div class="platform-gallery-item">` +
        `<img src="${escapeHtml(g.url.startsWith('http') ? g.url : `${API}${g.url}`)}" alt="${escapeHtml(g.title || g.type || 'Imagem')}" loading="lazy" />` +
        `<div class="gallery-meta">${escapeHtml(g.title || g.type || '—')}</div>` +
        `<button type="button" class="gallery-del" data-del-gallery="${escapeHtml(g.id)}" title="Remover">✕</button>` +
      `</div>`
    ).join('');
    box.querySelectorAll('[data-del-gallery]').forEach((btn) => {
      btn.addEventListener('click', () => removePlatformGalleryImage(btn.dataset.delGallery).catch((e) => showAppToast(e.message || 'Erro')));
    });
    box.querySelectorAll('.platform-gallery-item img').forEach((img) => {
      wireImageZoom(img, img.getAttribute('alt') || 'Imagem');
    });
  }

  function readPlatformStoreForm() {
    return {
      name: $('platformName').value.trim(),
      cnpj: onlyDigits($('platformCnpj').value),
      razaoSocial: $('platformRazaoSocial').value.trim(),
      plan: $('platformPlan').value,
      segment: readPlatformSegmento(),
      status: $('platformStatus').value,
      contactName: $('platformContactName').value.trim(),
      phone: onlyDigits($('platformPhone').value),
      email: $('platformEmail').value.trim(),
      address: $('platformAddress').value.trim(),
      addressNumber: $('platformAddressNumber').value.trim(),
      cep: onlyDigits($('platformCep').value),
      city: $('platformCity').value.trim(),
      state: $('platformState').value.trim().toUpperCase(),
      frontUrl: $('platformFrontUrl').value.trim(),
      frontNotes: $('platformFrontNotes').value.trim(),
      backUrl: $('platformBackUrl').value.trim(),
      backNotes: $('platformBackNotes').value.trim(),
      backUsername: $('platformBackUsername').value.trim() || undefined,
      backPassword: $('platformBackPassword').value || undefined,
      adminUrl: $('platformAdminUrl').value.trim(),
      databaseUrl: $('platformDatabaseUrl').value.trim(),
      databaseInfo: $('platformDatabaseInfo').value.trim(),
      localFrontUrl: $('platformLocalFrontUrl').value.trim(),
      localBackUrl: $('platformLocalBackUrl').value.trim(),
      localAdminUrl: $('platformLocalAdminUrl').value.trim(),
      localDatabaseUrl: $('platformLocalDatabaseUrl').value.trim(),
      monthlyFee: Number($('platformMonthlyFee').value || 0),
      courtesy: $('platformCourtesy').checked,
      courtesyUntil: fromDateInput($('platformCourtesyUntil').value),
      paymentStatus: $('platformPaymentStatus').value,
      lastPaymentAt: fromDateInput($('platformLastPaymentAt').value),
      nextDueAt: fromDateInput($('platformNextDueAt').value),
      paymentNotes: $('platformPaymentNotes').value.trim(),
      active: $('platformActive').checked,
      domain: $('platformDomain').value.trim(),
      apiKey: $('platformApiKey').value.trim(),
      webhookUrl: $('platformWebhookUrl').value.trim(),
      adminUsername: $('platformAdminUsername').value.trim() || undefined,
      adminPassword: $('platformAdminPassword').value || undefined
    };
  }

  function readPlatformSegmento() {
    if ($('platformSegmento').value === '__custom__') {
      const custom = $('platformSegmentoCustom').value.trim();
      return custom || undefined;
    }
    return $('platformSegmento').value || undefined;
  }

  async function loadPlatformStores() {
    if (!isPlatformDev()) return;
    platformStores = await api('/api/v1/admin/platform-stores', { headers: authHeaders() });
    if (!Array.isArray(platformStores)) platformStores = [];
    renderPlatformStores();
    refreshStaleStoreStats();
  }

  // ── Stats de loja (último acesso / cardápio / pedidos) ──

  const statsRefreshing = new Set();
  const statsQueue = [];
  let statsInflight = 0;
  const statsMaxConcurrency = 3;

  function platformStatsFields(store) {
    const st = store.stats || null;
    let lastAccess = store.lastAccessAt ? formatDateTime(store.lastAccessAt) : null;
    if (st && st.error) {
      return {
        lastAccess,
        menuHtml: `<span class="stats-error" title="${escapeHtml(st.error)}">erro</span>`,
        ordersHtml: `<span class="stats-error" title="${escapeHtml(st.error)}">erro</span>`
      };
    }
    if (st) {
      if (st.lastAccessAt) lastAccess = formatDateTime(st.lastAccessAt);
      const menuTotal = st.menuViewsTotal != null ? ` · ${Number(st.menuViewsTotal).toLocaleString('pt-BR')}` : '';
      const ordersTotal = st.ordersTotal != null ? ` · ${Number(st.ordersTotal).toLocaleString('pt-BR')}` : '';
      const menuHtml = st.menuViews30d != null
        ? `<span class="stats-value" title="Acessos total: ${escapeHtml(menuTotal.slice(3))}">${escapeHtml(Number(st.menuViews30d).toLocaleString('pt-BR'))}</span>`
        : '<span class="muted">—</span>';
      const ordersHtml = st.ordersAvailable && st.orders30d != null
        ? `<span class="stats-value" title="Pedidos total: ${escapeHtml(ordersTotal.slice(3))}">${escapeHtml(Number(st.orders30d).toLocaleString('pt-BR'))}</span>`
        : '<span class="muted" title="Tabela de pedidos indisponível neste ambiente">—</span>';
      return { lastAccess, menuHtml, ordersHtml };
    }
    return { lastAccess, menuHtml: '<span class="muted">—</span>', ordersHtml: '<span class="muted">—</span>' };
  }

  function refreshStoreStatsQueued(storeId, opts) {
    const key = String(storeId);
    if (statsRefreshing.has(key)) return;
    const run = () => refreshStoreStats(storeId, opts).catch(() => { /* best-effort */ });
    if (statsInflight >= statsMaxConcurrency) statsQueue.push(run);
    else run();
  }

  function drainStatsQueue() {
    while (statsInflight < statsMaxConcurrency && statsQueue.length) {
      statsQueue.shift()();
    }
  }

  async function refreshStoreStats(storeId, { silent = false } = {}) {
    const key = String(storeId);
    if (statsRefreshing.has(key)) return;
    statsRefreshing.add(key);
    statsInflight++;
    try {
      const store = platformStores.find((s) => s.storeId === Number(storeId));
      if (!store) return;
      const stats = await api(`/api/v1/admin/tools/${storeId}/stats`, {
        method: 'POST',
        headers: authHeaders()
      });
      store.stats = stats;
      renderPlatformStores();
      if (!silent) showAppToast('Estatísticas atualizadas.');
    } finally {
      statsRefreshing.delete(key);
      statsInflight--;
      drainStatsQueue();
    }
  }

  function refreshStaleStoreStats() {
    const now = Date.now();
    const stale = platformStores
      .filter((s) => s.storeId)
      .filter((s) => {
        const st = s.stats;
        if (!st || st.error) return true;
        if (!st.fetchedAt) return true;
        return now - new Date(st.fetchedAt).getTime() > 60 * 1000;
      })
      .map((s) => s.storeId);
    stale.forEach((id) => refreshStoreStatsQueued(id, { silent: true }));
  }

  function platformLinkHtml(url, label) {
    const href = safeExternalHref(url);
    if (!href) return `<span class="muted">${escapeHtml(label || '—')}</span>`;
    return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`;
  }

  function platformChipHtml(url, label) {
    const href = safeExternalHref(url);
    if (!href) return '';
    return `<a class="platform-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
  }

  function storeStatusLabel(status) {
    const map = { active: 'Ativa', setup: 'Em implantação', inactive: 'Inativa' };
    return map[String(status || '').toLowerCase()] || status || '—';
  }

  function formatCnpj(value) {
    const d = onlyDigits(value).slice(0, 14);
    if (d.length <= 2) return d;
    if (d.length <= 5) return `${d.slice(0, 2)}.${d.slice(2)}`;
    if (d.length <= 8) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5)}`;
    if (d.length <= 12) return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8)}`;
    return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
  }

  function maskCnpj(value) {
    return formatCnpj(value);
  }

  function maskPhone(value) {
    const d = onlyDigits(value).slice(0, 11);
    if (d.length <= 2) return d.length ? `(${d}` : '';
    if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
    if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  }

  function renderPlatformStoreKpis() {
    const box = $('platformStoreKpis');
    if (!box) return;
    const total = platformStores.length;
    const active = platformStores.filter((s) => String(s.status || 'active').toLowerCase() === 'active').length;
    const overdue = platformStores.filter((s) => String(s.paymentStatus || '').toLowerCase() === 'overdue').length;
    const mrr = platformStores
      .filter((s) => String(s.status || 'active').toLowerCase() !== 'inactive')
      .reduce((acc, s) => acc + (Number(s.monthlyFee) || 0), 0);
    box.innerHTML = [
      { label: 'Lojas', value: String(total) },
      { label: 'Ativas', value: String(active) },
      { label: 'Em atraso', value: String(overdue) },
      { label: 'MRR', value: money(mrr) }
    ].map((k) =>
      `<div class="dash-kpi"><span class="label">${escapeHtml(k.label)}</span><span class="value">${escapeHtml(k.value)}</span></div>`
    ).join('');
  }

  function renderPlatformStores() {
    const box = $('platformStoresList');
    if (!box) return;
    renderPlatformStoreKpis();

    const search = ($('platformSearch')?.value || '').trim().toLowerCase();
    const status = $('platformFilterStatus')?.value || '';
    const plan = $('platformFilterPlan')?.value || '';
    const segment = $('platformFilterSegment')?.value || '';
    const filtered = platformStores.filter((s) => {
      if (status && String(s.status || '').toLowerCase() !== status) return false;
      if (plan && String(s.plan || '').toLowerCase() !== plan) return false;
      if (segment && String(s.segment || '') !== segment) return false;
      if (search) {
        const hay = [s.name, s.cnpj, s.razaoSocial, s.contactName, s.city, s.domain, s.segment].join(' ').toLowerCase();
        if (!hay.includes(search)) return false;
      }
      return true;
    });

    box.innerHTML = '';
    if (!filtered.length) {
      box.innerHTML = `<tr><td colspan="12" class="platform-empty muted">Nenhuma loja encontrada.</td></tr>`;
      return;
    }

    filtered.forEach((store) => {
      const tr = document.createElement('tr');
      const sub = [store.razaoSocial, store.city && store.state ? `${store.city}/${store.state}` : store.city, store.domain]
        .filter(Boolean).join(' · ');
      const payBadge = `<span class="pay-badge pay-${escapeHtml(store.paymentStatus || 'pending')}">${escapeHtml(paymentStatusLabel(store.paymentStatus))}</span>` +
        (store.nextDueAt ? `<span class="pay-due">Venc. ${escapeHtml(toDateInput(store.nextDueAt))}</span>` : '');
      const stf = platformStatsFields(store);
      const lastAccess = stf.lastAccess ? escapeHtml(stf.lastAccess) : '<span class="muted">—</span>';
      tr.innerHTML =
        `<td><span class="platform-store-name">${escapeHtml(store.name)}</span>` +
          `<span class="platform-store-sub">${escapeHtml(sub)}</span></td>` +
        `<td>${store.cnpj ? escapeHtml(formatCnpj(store.cnpj)) : '<span class="muted">—</span>'}</td>` +
        `<td>${store.segment ? `<span class="segment-badge">${escapeHtml(store.segment)}</span>` : '<span class="muted">—</span>'}</td>` +
        `<td>${store.plan ? `<span class="plan-badge">${escapeHtml(store.plan)}</span>` : '<span class="muted">—</span>'}</td>` +
        `<td><span class="store-status-badge st-${escapeHtml(store.status || 'active')}">${escapeHtml(storeStatusLabel(store.status))}</span></td>` +
        `<td>${lastAccess}</td>` +
        `<td class="align-center">${stf.menuHtml}</td>` +
        `<td class="align-center">${stf.ordersHtml}</td>` +
        `<td class="align-right">${escapeHtml(money(store.monthlyFee))}</td>` +
        `<td>${payBadge}</td>` +
        `<td class="align-center">` + (store.storeId
          ? `<button type="button" class="ghost compact" data-bank-platform="${escapeHtml(store.id)}" data-bank-store-id="${escapeHtml(store.storeId)}" data-bank-store-name="${escapeHtml(store.name)}">Banco</button>`
          : `<button type="button" class="ghost compact" disabled title="Loja sem tenant vinculado (StoreId).">Banco</button>`) +
        `</td>` +
        `<td><div class="platform-table-actions">` +
          `<button type="button" class="ghost compact" data-tools-platform="${escapeHtml(store.id)}" data-tools-store-id="${escapeHtml(store.storeId)}" data-tools-store-name="${escapeHtml(store.name)}" ${store.storeId ? '' : 'disabled title="Loja sem tenant vinculado (StoreId)."'}>Administrar</button>` +
          `<button type="button" class="ghost compact" data-stats-platform="${escapeHtml(store.id)}" data-stats-store-id="${escapeHtml(store.storeId)}" data-stats-store-name="${escapeHtml(store.name)}" ${store.storeId ? '' : 'disabled title="Loja sem tenant vinculado (StoreId)."'}>Stats</button>` +
          `<button type="button" class="ghost compact" data-edit-platform="${escapeHtml(store.id)}">Editar</button>` +
          `<button type="button" class="ghost compact" data-dup-platform="${escapeHtml(store.id)}">Duplicar</button>` +
          `<button type="button" class="compact platform-pay-btn" data-pay-platform="${escapeHtml(store.id)}">Pagamento</button>` +
          `<button type="button" class="ghost compact danger" data-del-platform="${escapeHtml(store.id)}">Excluir</button>` +
        `</div></td>`;
      box.appendChild(tr);
    });

    box.querySelectorAll('[data-edit-platform]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const store = platformStores.find((s) => s.id === btn.dataset.editPlatform);
        if (store) showPlatformStoreForm(store);
      });
    });
    box.querySelectorAll('[data-dup-platform]').forEach((btn) => {
      btn.addEventListener('click', () => duplicatePlatformStore(btn.dataset.dupPlatform));
    });
    box.querySelectorAll('[data-del-platform]').forEach((btn) => {
      btn.addEventListener('click', () => {
        deletePlatformStore(btn.dataset.delPlatform).catch((e) => showAppToast(e.message || 'Erro'));
      });
    });
    box.querySelectorAll('[data-pay-platform]').forEach((btn) => {
      btn.addEventListener('click', () => {
        registerPlatformPayment(btn.dataset.payPlatform).catch((e) => showAppToast(e.message || 'Erro'));
      });
    });
    box.querySelectorAll('[data-bank-platform]').forEach((btn) => {
      btn.addEventListener('click', () => {
        openBankForStore(btn.dataset.bankStoreId, btn.dataset.bankStoreName).catch((e) => {
          showAppToast(e.message || 'Falha ao abrir o banco.', 'error');
        });
      });
    });
    box.querySelectorAll('[data-tools-platform]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!btn.dataset.toolsStoreId) {
          showAppToast('Esta loja não tem tenant vinculado (StoreId).', 'error');
          return;
        }
        openStoreTools(btn.dataset.toolsStoreId, btn.dataset.toolsStoreName).catch((e) => {
          showAppToast(e.message || 'Falha ao abrir as ferramentas.', 'error');
        });
      });
    });
    box.querySelectorAll('[data-stats-platform]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!btn.dataset.statsStoreId) {
          showAppToast('Esta loja não tem tenant vinculado (StoreId).', 'error');
          return;
        }
        refreshStoreStatsQueued(btn.dataset.statsStoreId, { silent: false });
      });
    });
  }

  function openBankForStore(storeId, storeName) {
    if (!storeId) throw new Error('Esta loja não tem tenant vinculado (StoreId).');
    bankStoreId = String(storeId);
    bankStoreLabel = storeName || '';
    openTab('bank');
  }

  // ── Ferramentas de loja (Administrar: comparar / backup / sync remoto→local) ──

  const toolsState = { storeId: '', storeName: '' };

  function toolsApi(path, options) {
    return api(`/api/v1/admin/tools${path}`, options);
  }

  function openStoreTools(storeId, storeName) {
    toolsState.storeId = String(storeId);
    toolsState.storeName = storeName || '';
    const existing = $('storeToolsModal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'storeToolsModal';
    modal.className = 'confirm-modal';
    modal.innerHTML =
      `<div class="confirm-modal-card platform-modal-card tools-modal-card" role="dialog" aria-modal="true" aria-labelledby="toolsTitle">` +
        `<div class="platform-modal-head">` +
          `<h3 id="toolsTitle">Administrar · ${escapeHtml(toolsState.storeName)}</h3>` +
          `<button type="button" class="ghost compact" data-tools-close aria-label="Fechar">✕</button>` +
        `</div>` +
        `<div class="platform-modal-body">` +
          `<div id="toolsStatusBox" class="tools-status">Carregando status…</div>` +
          `<div class="tools-actions">` +
            `<button type="button" class="ghost" data-tools-action="compare">Comparar local × remoto</button>` +
            `<button type="button" class="ghost" data-tools-action="backup">Fazer backup</button>` +
            `<button type="button" class="ghost" data-tools-action="sync-preview">Baixar do remoto (simular)</button>` +
            `<button type="button" class="confirm" data-tools-action="sync">Baixar do remoto (aplicar)</button>` +
          `</div>` +
          `<label class="inline tools-option">` +
            `<input type="checkbox" id="toolsSkipDelete" checked /> Manter itens locais que não existem no remoto (recomendado)` +
          `</label>` +
          `<div id="toolsResultBox" class="tools-result" hidden></div>` +
        `</div>` +
      `</div>`;

    const finish = () => { document.removeEventListener('keydown', onKey); modal.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') finish(); };
    modal.addEventListener('click', (e) => { if (e.target === modal) finish(); });
    modal.querySelector('[data-tools-close]').addEventListener('click', finish);
    modal.querySelectorAll('[data-tools-action]').forEach((btn) => {
      btn.addEventListener('click', () => runToolsAction(btn.dataset.toolsAction));
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(modal);

    return refreshToolsStatus();
  }

  function refreshToolsStatus() {
    return toolsApi(`/${toolsState.storeId}/status`, { headers: authHeaders() })
      .then((status) => {
        const box = $('toolsStatusBox');
        if (box) box.innerHTML = renderToolsStatus(status);
      })
      .catch((e) => {
        const box = $('toolsStatusBox');
        if (box) box.innerHTML = `<p class="tools-error">Status indisponível: ${escapeHtml(e.message || e)}</p>`;
      });
  }

  function renderToolsStatus(s) {
    const reachable = s.remoteReachable ? 'acessível' : 'inacessível';
    const creds = s.hasRemoteCreds ? 'configuradas' : 'não configuradas (usa cardápio público)';
    const last = s.lastBackupAt ? formatDateTime(s.lastBackupAt) : 'nenhum';
    return `<p class="muted">Local · ${s.localCategories} categorias, ${s.localProducts} produtos, ${s.localIngredients} ingredientes${s.localStoreName ? ` · ${escapeHtml(s.localStoreName)}` : ''}</p>` +
      `<p class="muted">Remoto · ${s.remoteBaseUrl ? escapeHtml(s.remoteBaseUrl) : 'sem Back (URL) configurado'} · ${reachable} · credenciais ${creds}</p>` +
      `<p class="muted">Último backup local · ${escapeHtml(last)}</p>` +
      (s.remoteError ? `<p class="tools-error">${escapeHtml(s.remoteError)}</p>` : '');
  }

  function setToolsResult(html) {
    const box = $('toolsResultBox');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = html;
  }

  async function runToolsAction(action) {
    const box = $('toolsResultBox');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<p class="muted">Executando…</p>';
    const skipDelete = !!$('toolsSkipDelete')?.checked;
    try {
      if (action === 'compare') {
        const report = await toolsApi(`/${toolsState.storeId}/compare`, { headers: authHeaders() });
        setToolsResult(renderCompareReport(report));
      } else if (action === 'backup') {
        const result = await toolsApi(`/${toolsState.storeId}/backup`, { method: 'POST', headers: authHeaders() });
        setToolsResult(renderBackupResult(result));
        refreshToolsStatus();
      } else if (action === 'sync-preview') {
        const report = await toolsApi(`/${toolsState.storeId}/sync-from-remote?dryRun=true&skipDelete=${skipDelete}`, { method: 'POST', headers: authHeaders() });
        setToolsResult(renderSyncReport(report, true));
      } else if (action === 'sync') {
        const ok = await askConfirm(
          `Baixar o conteúdo do ambiente remoto para o local? ${skipDelete ? 'Itens locais sem equivalente no remoto serão mantidos.' : 'Itens locais sem equivalente no remoto serão EXCLUÍDOS.'}`,
          { title: 'Sincronizar remoto → local', confirmLabel: 'Baixar', cancelLabel: 'Cancelar' }
        );
        if (!ok) return;
        const report = await toolsApi(`/${toolsState.storeId}/sync-from-remote?dryRun=false&skipDelete=${skipDelete}`, { method: 'POST', headers: authHeaders() });
        setToolsResult(renderSyncReport(report, false));
        refreshToolsStatus();
      }
    } catch (e) {
      setToolsResult(`<p class="tools-error">${escapeHtml(e.message || e)}</p>`);
    }
  }

  function toolsListRow(title, items, kind) {
    const shown = items.slice(0, 30).map((i) => `<li>${escapeHtml(i)}</li>`).join('');
    return `<div class="tools-block"><h4>${escapeHtml(title)} (${items.length})</h4><ul class="tools-list">${shown}` +
      (items.length > 30 ? `<li class="muted">… e mais ${items.length - 30}.</li>` : '') +
      `</ul></div>`;
  }

  function renderCompareReport(r) {
    const parts = [];
    parts.push(`<p class="tools-note">${escapeHtml(r.mode === 'admin' ? 'Comparação completa (credenciais remotas).' : 'Modo público (sem credenciais): itens ocultos e ingredientes não são comparados.')}</p>`);
    const chips = [
      `Categorias: ${r.categoriesLocal} local × ${r.categoriesRemote} remoto`,
      `Produtos: ${r.productsLocal} × ${r.productsRemote}`,
      `Ingredientes: ${r.ingredientsLocal} × ${r.ingredientsRemote}`,
      `Produtos iguais: ${r.equalProducts}`
    ].map((c) => `<span class="tools-chip">${escapeHtml(c)}</span>`).join('');
    parts.push(`<div class="tools-chips">${chips}</div>`);

    const rows = [];
    if (r.categoriesOnlyLocal.length) rows.push(toolsListRow('Categorias só no local', r.categoriesOnlyLocal));
    if (r.categoriesOnlyRemote.length) rows.push(toolsListRow('Categorias só no remoto', r.categoriesOnlyRemote));
    if (r.ingredientsOnlyLocal.length) rows.push(toolsListRow('Ingredientes só no local', r.ingredientsOnlyLocal));
    if (r.ingredientsOnlyRemote.length) rows.push(toolsListRow('Ingredientes só no remoto', r.ingredientsOnlyRemote));
    if (r.productsOnlyLocal.length) rows.push(toolsListRow('Produtos só no local', r.productsOnlyLocal));
    if (r.productsOnlyRemote.length) rows.push(toolsListRow('Produtos só no remoto', r.productsOnlyRemote));

    if (r.changedProducts && r.changedProducts.length) {
      const items = r.changedProducts.slice(0, 50).map((p) =>
        `<li><strong>${escapeHtml(p.name)}</strong> <span class="muted">(${escapeHtml(p.changedFields.join(', '))})</span></li>`
      ).join('');
      rows.push(`<div class="tools-block"><h4>Produtos diferentes (${r.changedProducts.length})</h4><ul class="tools-list">${items}` +
        (r.changedProducts.length > 50 ? `<li class="muted">… e mais ${r.changedProducts.length - 50}.</li>` : '') +
        `</ul></div>`);
    }

    if (r.imagesMissingLocal && r.imagesMissingLocal.length) rows.push(toolsListRow('Imagens no remoto sem arquivo local', r.imagesMissingLocal));

    if (r.storeDiffs && r.storeDiffs.length) {
      const items = r.storeDiffs.map((d) =>
        `<li><strong>${escapeHtml(d.field)}</strong> · local <code>${escapeHtml(d.local || '—')}</code> · remoto <code>${escapeHtml(d.remote || '—')}</code></li>`
      ).join('');
      rows.push(`<div class="tools-block"><h4>Configuração da loja diferente</h4><ul class="tools-list">${items}</ul></div>`);
    }

    if (!rows.length) {
      parts.push('<p class="tools-ok">Catálogo e configuração idênticos entre local e remoto. Nada a sincronizar.</p>');
    } else {
      parts.push(rows.join(''));
      parts.push('<p class="tools-hint">Use <em>Baixar do remoto (simular)</em> para ver o que seria alterado antes de aplicar.</p>');
    }
    return parts.join('');
  }

  function renderBackupResult(r) {
    const imgs = `${r.imagesDownloaded} baixadas, ${r.imagesExisting} já existentes, ${r.imagesFailed} falhas`;
    const warnings = (r.warnings || []).map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    return `<div class="tools-block tools-ok"><h4>Backup concluído</h4>` +
      `<p class="muted">Local: ${escapeHtml(r.directory)}</p>` +
      `<p class="muted">${r.categories} categorias · ${r.products} produtos · ${r.ingredients} ingredientes · ${escapeHtml(imgs)}</p>` +
      `<p class="muted">Criado em ${escapeHtml(formatDateTime(r.createdAt))}</p>` +
      (warnings ? `<ul class="tools-list">${warnings}</ul>` : '') +
      `</div>`;
  }

  function renderSyncReport(r, dryRun) {
    const title = dryRun ? 'Simulação — nada foi alterado' : 'Sincronização concluída';
    const rows = [
      `Categorias: ${r.categoriesSynced} sincronizadas, ${r.categoriesDeleted} excluídas`,
      `Ingredientes: ${r.ingredientsSynced} sincronizados, ${r.ingredientsDeleted} excluídos`,
      `Produtos: ${r.productsSynced} sincronizados, ${r.productsDeleted} excluídos`,
      `Imagens: ${r.imagesDownloaded} baixadas, ${r.imagesExisting} já existentes, ${r.imagesFailed} falhas`,
      r.storeUpdated ? 'Configuração da loja atualizada' : 'Configuração da loja não alterada'
    ];
    const warnings = (r.warnings || []).map((w) => `<li>${escapeHtml(w)}</li>`).join('');
    return `<div class="tools-block"><h4>${escapeHtml(title)}</h4>` +
      `<ul class="tools-list">${rows.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` +
      (warnings ? `<ul class="tools-list">${warnings}</ul>` : '') +
      `</div>`;
  }

  function duplicatePlatformStore(id) {
    const store = platformStores.find((s) => s.id === id);
    if (store) showPlatformStoreForm(null, { duplicateSource: store });
  }

  async function savePlatformStore() {
    const payload = readPlatformStoreForm();
    if (!payload.name) throw new Error('Informe o nome da loja.');
    if (payload.monthlyFee < 0) throw new Error('Mensalidade não pode ser negativa.');
    if (payload.cnpj && onlyDigits(payload.cnpj).length !== 14) throw new Error('CNPJ inválido (use 14 dígitos).');
    if (payload.cep && onlyDigits(payload.cep).length !== 8) throw new Error('CEP inválido (use 8 dígitos).');
    if (payload.state && !/^[a-zA-Z]{2}$/.test(payload.state)) throw new Error('UF inválida (use 2 letras).');
    if (payload.frontUrl && !isHttpUrl(payload.frontUrl)) throw new Error('URL do front deve começar com http:// ou https://');
    if (payload.backUrl && !isHttpUrl(payload.backUrl)) throw new Error('URL do back deve começar com http:// ou https://');
    if (payload.adminUsername || payload.adminPassword) {
      if (!payload.adminUsername || !payload.adminPassword) throw new Error('Informe usuário e senha do admin da loja.');
      if (payload.adminPassword.length < 6) throw new Error('Senha do admin muito curta (mín. 6 caracteres).');
    }

    const editingId = editingPlatformStoreId || $('platformStoreId').value;
    if (platformDuplicateSourceId) {
      await api(`/api/v1/admin/platform-stores/${platformDuplicateSourceId}/duplicate`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });
      showAppToast('Loja duplicada.');
    } else if (editingId) {
      await api(`/api/v1/admin/platform-stores/${editingId}`, {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });
      showAppToast('Loja salva.');
    } else {
      await api('/api/v1/admin/platform-stores', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });
      showAppToast('Loja criada.');
    }
    resetPlatformStoreForm();
    $('platformStoreModal').hidden = true;
    await loadPlatformStores();
  }

  function askTypeConfirm(message, expectedText, { title = 'Confirmar', confirmLabel = 'Confirmar', cancelLabel = 'Cancelar' } = {}) {
    return new Promise((resolve) => {
      const existing = $('appConfirmModal');
      if (existing) existing.remove();
      const modal = document.createElement('div');
      modal.id = 'appConfirmModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="appConfirmTitle">` +
        `<h3 id="appConfirmTitle">${escapeHtml(title)}</h3>` +
        `<p>${message}</p>` +
        `<input id="typeConfirmInput" class="type-confirm-input" type="text" autocomplete="off" placeholder="Digite o nome da loja" />` +
        `<p class="type-confirm-hint">Confirmação por digitação não pode ser desfeita.</p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="confirm" data-confirm-ok disabled>${escapeHtml(confirmLabel)}</button>` +
        `<button type="button" class="ghost compact" data-confirm-cancel>${escapeHtml(cancelLabel)}</button>` +
        `</div></div>`;
      const okBtn = modal.querySelector('[data-confirm-ok]');
      const input = modal.querySelector('#typeConfirmInput');
      const expected = String(expectedText || '').trim().toLowerCase();
      const sync = () => { okBtn.disabled = input.value.trim().toLowerCase() !== expected; };
      input.addEventListener('input', sync);
      const finish = (value) => {
        document.removeEventListener('keydown', onKey);
        modal.remove();
        resolve(value);
      };
      const onKey = (e) => {
        if (e.key === 'Escape') finish(false);
        if (e.key === 'Enter') {
          e.preventDefault();
          if (!okBtn.disabled) finish(true);
        }
      };
      modal.addEventListener('click', (e) => { if (e.target === modal) finish(false); });
      okBtn.addEventListener('click', () => finish(true));
      modal.querySelector('[data-confirm-cancel]').addEventListener('click', () => finish(false));
      document.addEventListener('keydown', onKey);
      document.body.appendChild(modal);
      input.focus();
    });
  }

  async function deletePlatformStore(id) {
    const store = platformStores.find((s) => s.id === id);
    if (!store) return;
    const ok = await askTypeConfirm(
      `Digite <strong>${escapeHtml(store.name)}</strong> para desativar esta loja da plataforma.`,
      store.name,
      { title: 'Desativar loja', confirmLabel: 'Desativar' }
    );
    if (!ok) return;
    try {
      await api(`/api/v1/admin/platform-stores/${id}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
    } catch (e) {
      if (e && e.status === 409) {
        await askConfirm(String(e.message || 'Esta loja não pode ser excluída.'), {
          title: 'Loja protegida',
          confirmLabel: 'OK',
          cancelLabel: 'Fechar'
        });
        return;
      }
      throw e;
    }
    if (editingPlatformStoreId === id) resetPlatformStoreForm();
    showAppToast('Loja desativada.');
    await loadPlatformStores();
  }

  async function registerPlatformPayment(id) {
    const store = platformStores.find((s) => s.id === id);
    if (!store) return;
    const note = prompt(`Registrar pagamento de ${store.name} (${money(store.monthlyFee)}). Observação (opcional):`, '') ?? null;
    if (note === null) return;
    await api(`/api/v1/admin/platform-stores/${id}/payments`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        amount: store.monthlyFee,
        note: note || undefined
      })
    });
    showAppToast('Pagamento registrado.');
    await loadPlatformStores();
  }

  function switchPlatformModalTab(name) {
    document.querySelectorAll('.platform-modal-tabs button').forEach((b) => {
      b.classList.toggle('active', b.dataset.ptab === name);
    });
    document.querySelectorAll('.platform-modal-body .platform-modal-pane').forEach((p) => {
      p.hidden = p.dataset.pane !== name;
    });
  }

  async function loadPlatformUsers(storeId) {
    const list = $('platformUsersList');
    if (!list) return;
    if (!storeId) {
      list.innerHTML = '<p class="muted">Salve a loja para gerenciar usuários.</p>';
      return;
    }
    const users = await api(`/api/v1/admin/platform-stores/${storeId}/users`, { headers: authHeaders() });
    if (!Array.isArray(users)) {
      list.innerHTML = '';
      return;
    }
    if (!users.length) {
      list.innerHTML = '<p class="muted">Nenhum usuário vinculado a esta loja.</p>';
      return;
    }
    list.innerHTML = users.map((u) =>
      `<div class="platform-user-row">` +
        `<span class="user-main"><span class="user-badge role-${escapeHtml((u.role || '').toLowerCase())}">${escapeHtml(u.role || '—')}</span>` +
        `<strong>${escapeHtml(u.username)}</strong></span>` +
        `<span class="user-actions">` +
          `<button type="button" class="ghost compact" data-reset-user="${escapeHtml(u.id)}">Resetar senha</button>` +
          `<button type="button" class="ghost compact danger" data-del-user="${escapeHtml(u.id)}">Excluir</button>` +
        `</span></div>`
    ).join('');
    list.querySelectorAll('[data-reset-user]').forEach((btn) => {
      btn.addEventListener('click', () => resetPlatformUserPassword(Number(btn.dataset.resetUser)).catch((e) => showAppToast(e.message || 'Erro')));
    });
    list.querySelectorAll('[data-del-user]').forEach((btn) => {
      btn.addEventListener('click', () => deletePlatformUser(Number(btn.dataset.delUser)).catch((e) => showAppToast(e.message || 'Erro')));
    });
  }

  async function addPlatformUser() {
    const storeId = editingPlatformStoreId || $('platformStoreId').value;
    if (!storeId) throw new Error('Salve a loja antes de adicionar usuários.');
    const username = $('platformUserUsername').value.trim();
    const password = $('platformUserPassword').value;
    const role = $('platformUserRole').value;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(username)) throw new Error('Usuário: use letras, números, _ ou -.');
    if (password.length < 6) throw new Error('Senha muito curta (mín. 6 caracteres).');
    await api(`/api/v1/admin/platform-stores/${storeId}/users`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ username, password, role })
    });
    $('platformUserUsername').value = '';
    $('platformUserPassword').value = '';
    showAppToast('Usuário adicionado.');
    await loadPlatformUsers(storeId);
  }

  async function resetPlatformUserPassword(userId) {
    const storeId = editingPlatformStoreId || $('platformStoreId').value;
    if (!storeId) return;
    const newPass = prompt('Nova senha (mín. 6 caracteres):');
    if (newPass === null) return;
    if (newPass.length < 6) throw new Error('Senha muito curta (mín. 6 caracteres).');
    await api(`/api/v1/admin/platform-stores/${storeId}/users/${userId}/reset-password`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ password: newPass })
    });
    showAppToast('Senha atualizada.');
  }

  async function deletePlatformUser(userId) {
    const storeId = editingPlatformStoreId || $('platformStoreId').value;
    if (!storeId) return;
    const ok = await askConfirm('Excluir este usuário da loja?', { confirmLabel: 'Excluir' });
    if (!ok) return;
    await api(`/api/v1/admin/platform-stores/${storeId}/users/${userId}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    showAppToast('Usuário excluído.');
    await loadPlatformUsers(storeId);
  }

  async function uploadPlatformLogo(file) {
    const storeId = editingPlatformStoreId || $('platformStoreId').value;
    if (!storeId) throw new Error('Salve a loja antes de enviar a logo.');
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) throw new Error('Arquivo maior que 2 MB.');
    const status = $('platformLogoStatus');
    if (status) { status.hidden = false; status.textContent = 'Enviando logo...'; }
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await api(`/api/v1/admin/platform-stores/${storeId}/logo`, {
        method: 'POST',
        headers: authUploadHeaders(),
        body: form
      });
      setPlatformLogoPreview(res && res.logoUrl);
      if (status) status.textContent = 'Logo enviada.';
      showAppToast('Logo atualizada.');
    } catch (e) {
      if (status) status.textContent = e.message || 'Falha ao enviar logo.';
      throw e;
    }
  }

  async function addPlatformGalleryImage() {
    const storeId = editingPlatformStoreId || $('platformStoreId').value;
    if (!storeId) throw new Error('Salve a loja antes de adicionar imagens.');
    const file = $('platformGalleryFile').files[0];
    if (!file) throw new Error('Selecione um arquivo de imagem.');
    if (file.size > 2 * 1024 * 1024) throw new Error('Arquivo maior que 2 MB.');
    const title = $('platformGalleryTitle').value.trim();
    const form = new FormData();
    form.append('file', file);
    if (title) form.append('title', title);
    form.append('type', 'photo');
    await api(`/api/v1/admin/platform-stores/${storeId}/gallery`, {
      method: 'POST',
      headers: authUploadHeaders(),
      body: form
    });
    $('platformGalleryFile').value = '';
    $('platformGalleryTitle').value = '';
    showAppToast('Imagem adicionada à galeria.');
    const store = platformStores.find((s) => s.id === storeId);
    if (store) renderPlatformGallery(store.gallery || []);
    if (storeId) {
      const fresh = await api(`/api/v1/admin/platform-stores/${storeId}`, { headers: authHeaders() });
      if (fresh && Array.isArray(fresh.gallery)) renderPlatformGallery(fresh.gallery);
    }
  }

  async function removePlatformGalleryImage(imageId) {
    const storeId = editingPlatformStoreId || $('platformStoreId').value;
    if (!storeId) return;
    const ok = await askConfirm('Remover esta imagem da galeria?', { confirmLabel: 'Remover' });
    if (!ok) return;
    await api(`/api/v1/admin/platform-stores/${storeId}/gallery/${imageId}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    showAppToast('Imagem removida.');
    const fresh = await api(`/api/v1/admin/platform-stores/${storeId}`, { headers: authHeaders() });
    if (fresh && Array.isArray(fresh.gallery)) renderPlatformGallery(fresh.gallery);
  }

  // ===== Banco de dados (Dev) =====
  let bankTables = [];
  let bankTable = '';
  let bankColumns = [];
  let bankStoreId = '';
  let bankStoreLabel = '';
  let bankRows = [];
  let bankTotal = 0;
  let bankPage = 1;
  let bankEditingRow = null;
  let bankFieldEls = {};
  const BANK_PAGE_SIZE = 25;

  function bankUnavailableMessage(err) {
    if (err && err.status === 404 && !/PostgreSQL/i.test(err.message || '')) {
      return 'Explorador indisponível: a API não responde com as rotas de banco. Rode "npm run dev:up" (reconstrói o catalog-api) e tente novamente.';
    }
    return err ? err.message : 'Falha ao carregar o banco de dados.';
  }

  function bankUnavailable(message) {
    const box = $('bankUnavailable');
    if (box) {
      box.hidden = false;
      box.textContent = message || 'Explorador de banco indisponível (requer Persistence=PostgreSQL).';
    }
    ['bankStoreSelect', 'bankTableSelect', 'bankSearchInput', 'bankRefreshBtn', 'bankNewRowBtn'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = true;
    });
  }

  async function loadBankTab() {
    bankTables = [];
    bankTable = '';
    bankColumns = [];
    bankRows = [];
    bankTotal = 0;
    renderBankRowsTable();
    const box = $('bankUnavailable');
    if (box) box.hidden = true;
    try {
      const tables = await api('/api/v1/admin/db/tables', { headers: authHeaders() });
      if (!Array.isArray(tables) || !tables.length) { bankUnavailable('Nenhuma tabela encontrada no banco.'); return; }
      bankTables = tables;
      await loadBankStores();
      populateBankTableSelect();
      const first = tables.find((t) => t.hasPk) || tables[0];
      if (first) $('bankTableSelect').value = first.table;
      selectBankTable($('bankTableSelect').value);
    } catch (err) {
      bankUnavailable(bankUnavailableMessage(err));
    }
  }

  async function loadBankStores() {
    const select = $('bankStoreSelect');
    if (!select) return;
    try {
      const stores = await api('/api/v1/admin/db/stores', { headers: authHeaders() });
      if (!Array.isArray(stores) || !stores.length) {
        bankStoreId = '';
        bankStoreLabel = '';
        select.innerHTML = '<option value="">Sem lojas</option>';
        select.disabled = true;
        return;
      }
      const previous = bankStoreId || select.value;
      select.innerHTML = '';
      stores.forEach((s) => {
        const o = document.createElement('option');
        o.value = s.id;
        o.textContent = `${s.name} (ID ${s.id})`;
        select.appendChild(o);
      });
      const current = previous && stores.some((s) => String(s.id) === String(previous))
        ? previous
        : String(stores[0].id);
      select.value = current;
      bankStoreId = current;
      bankStoreLabel = (stores.find((s) => String(s.id) === String(current)) || {}).name || '';
      select.disabled = false;
    } catch (err) {
      bankUnavailable(bankUnavailableMessage(err));
    }
  }

  function populateBankTableSelect() {
    const select = $('bankTableSelect');
    if (!select) return;
    select.innerHTML = '';
    bankTables.forEach((t) => {
      const o = document.createElement('option');
      o.value = t.table;
      o.textContent = t.table + (t.tenant ? ' (loja)' : '');
      select.appendChild(o);
    });
  }

  function selectBankTable(table) {
    bankTable = table || '';
    bankPage = 1;
    const info = bankTables.find((t) => t.table === bankTable) || null;
    bankColumns = info ? info.columns : [];
    const meta = $('bankTableInfo');
    if (meta) {
      if (info) {
        meta.hidden = false;
        const pk = info.columns.filter((c) => c.isPrimaryKey).map((c) => c.name).join(', ') || '—';
        meta.textContent = `Colunas: ${info.columns.length} · Chave primária: ${pk} · ${info.tenant ? 'Dados por loja (StoreId)' : 'Dados globais'}`;
      } else {
        meta.hidden = true;
      }
    }
    const btn = $('bankNewRowBtn');
    if (btn) btn.disabled = !info;
    if ($('bankRowsHead')) $('bankRowsHead').innerHTML = '';
    if ($('bankRowsBody')) $('bankRowsBody').innerHTML = '';
    if ($('bankEmpty')) $('bankEmpty').hidden = true;
    if ($('bankPagination')) $('bankPagination').hidden = true;
    if (bankTable) loadBankRows().catch((e) => console.warn('Banco rows', e));
  }

  async function loadBankRows() {
    if (!bankTable) return;
    const q = (($('bankSearchInput') || {}).value || '').trim();
    const params = new URLSearchParams();
    if (bankStoreId) params.set('storeId', bankStoreId);
    if (q) params.set('q', q);
    params.set('page', String(bankPage));
    params.set('pageSize', String(BANK_PAGE_SIZE));
    const res = await api(`/api/v1/admin/db/tables/${encodeURIComponent(bankTable)}/rows?${params.toString()}`, { headers: authHeaders() });
    if (!res || !Array.isArray(res.rows)) return;
    bankRows = res.rows || [];
    bankTotal = Number(res.total) || 0;
    if (Array.isArray(res.columns) && res.columns.length) bankColumns = res.columns;
    renderBankRowsTable();
    renderBankPagination();
  }

  function bankCellText(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (value instanceof Object) {
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    }
    return String(value);
  }

  function bankCellHtml(value, col) {
    if (value === null || value === undefined) return '<span class="muted">NULL</span>';
    if (typeof value === 'boolean') {
      return value
        ? '<span class="bank-bool bank-bool-true" title="true">✓</span>'
        : '<span class="bank-bool" title="false">—</span>';
    }
    let txt = bankCellText(value);
    const shown = txt.length > 120 ? txt.slice(0, 117) + '…' : txt;
    if (col && col.isJson) return `<code class="bank-json">${escapeHtml(shown)}</code>`;
    return `<span class="bank-cell">${escapeHtml(shown)}</span>`;
  }

  function renderBankRowsTable() {
    const head = $('bankRowsHead');
    const body = $('bankRowsBody');
    if (!head || !body) return;
    if (!bankTable || !bankColumns.length) {
      head.innerHTML = '';
      body.innerHTML = '';
      if ($('bankEmpty')) $('bankEmpty').hidden = true;
      return;
    }
    head.innerHTML = '<tr>' + bankColumns.map((c) =>
      `<th title="${escapeHtml(c.dataType)}">${escapeHtml(c.name)}${c.isPrimaryKey ? ' 🔑' : ''}</th>`
    ).join('') + '<th class="align-right">Ações</th></tr>';
    if (!bankRows.length) {
      body.innerHTML = '';
      if ($('bankEmpty')) $('bankEmpty').hidden = false;
      return;
    }
    if ($('bankEmpty')) $('bankEmpty').hidden = true;
    const info = bankTables.find((t) => t.table === bankTable);
    const hasPk = !!(info && info.hasPk);
    body.innerHTML = bankRows.map((row, idx) => {
      const tds = bankColumns.map((c) =>
        `<td title="${escapeHtml(bankCellText(row[c.name]))}">${bankCellHtml(row[c.name], c)}</td>`
      ).join('');
      const actions = hasPk
        ? `<button type="button" class="bank-action" data-bank-edit="${idx}">Editar</button>
           <button type="button" class="bank-action danger" data-bank-delete="${idx}">Excluir</button>`
        : '<span class="muted">somente leitura</span>';
      return `<tr>${tds}<td class="align-right bank-row-actions">${actions}</td></tr>`;
    }).join('');
  }

  function renderBankPagination() {
    const wrap = $('bankPagination');
    if (!wrap) return;
    if (!bankTable) { wrap.hidden = true; return; }
    const pages = Math.max(1, Math.ceil(bankTotal / BANK_PAGE_SIZE));
    wrap.hidden = bankTotal === 0;
    const info = $('bankPageInfo');
    if (info) {
      const from = bankTotal === 0 ? 0 : (bankPage - 1) * BANK_PAGE_SIZE + 1;
      const to = Math.min(bankTotal, bankPage * BANK_PAGE_SIZE);
      info.textContent = `${from}–${to} de ${bankTotal} · página ${bankPage}/${pages}`;
    }
    if ($('bankPrevBtn')) $('bankPrevBtn').disabled = bankPage <= 1;
    if ($('bankNextBtn')) $('bankNextBtn').disabled = bankPage >= pages;
  }

  function bankFieldId(name) {
    return 'bankf_' + String(name).replace(/[^A-Za-z0-9_]/g, '_');
  }

  function buildBankRowForm(row) {
    const wrap = $('bankRowFields');
    const info = bankTables.find((t) => t.table === bankTable);
    const tenant = !!(info && info.tenant);
    wrap.innerHTML = '';
    bankFieldEls = {};
    bankColumns.forEach((col) => {
      if (col.isIdentity) return;
      if (tenant && col.name === 'StoreId') return;
      const value = row ? row[col.name] : null;
      const isBool = col.dataType === 'boolean';
      const isDate = col.dataType.includes('timestamp') || col.dataType === 'date';
      const isNumber = ['integer', 'bigint', 'smallint', 'numeric', 'real', 'double precision', 'money'].includes(col.dataType);
      const required = col.isPrimaryKey || (!col.isNullable && !col.hasDefault);
      const label = document.createElement('label');
      label.className = 'bank-field' + (isBool ? ' inline' : '');
      const nameSpan = document.createElement('span');
      nameSpan.className = 'bank-field-name';
      nameSpan.textContent = col.name + (col.isPrimaryKey ? ' (PK)' : '');
      label.appendChild(nameSpan);
      const id = bankFieldId(col.name);
      let input;
      if (isBool) {
        input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        input.checked = value === true || value === 1 || value === '1' || value === 't' || value === 'true';
      } else if (isDate) {
        input = document.createElement('input');
        input.type = col.dataType === 'date' ? 'date' : 'datetime-local';
        input.id = id;
        const d = bankParseDate(value);
        if (d) input.value = col.dataType === 'date' ? d.slice(0, 10) : d.slice(0, 16);
      } else if (isNumber) {
        input = document.createElement('input');
        input.type = 'number';
        input.id = id;
        input.step = (col.dataType === 'integer' || col.dataType === 'bigint' || col.dataType === 'smallint') ? '1' : 'any';
        if (value !== null && value !== undefined && value !== '') input.value = String(value);
      } else if (col.isJson) {
        input = document.createElement('textarea');
        input.id = id;
        input.rows = 3;
        if (value !== null && value !== undefined && value !== '') {
          input.value = typeof value === 'string' ? value : JSON.stringify(value);
        }
      } else {
        input = document.createElement('input');
        input.type = 'text';
        input.id = id;
        if (col.dataType === 'uuid') input.placeholder = '00000000-0000-0000-0000-000000000000';
        if (col.maxLength) input.maxLength = col.maxLength;
        if (value !== null && value !== undefined && value !== '') input.value = String(value);
      }
      if (required && input.type !== 'checkbox' && !input.value) input.setAttribute('data-required', '1');
      if (isBool) {
        label.appendChild(input);
        const yes = document.createElement('em');
        yes.textContent = ' sim';
        label.appendChild(yes);
      } else {
        label.appendChild(input);
      }
      bankFieldEls[col.name] = input;
      wrap.appendChild(label);
    });
  }

  function bankParseDate(value) {
    if (value == null || value === '') return '';
    const d = new Date(String(value));
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  }

  function readBankRowForm() {
    const info = bankTables.find((t) => t.table === bankTable);
    const tenant = !!(info && info.tenant);
    const data = {};
    bankColumns.forEach((col) => {
      if (col.isIdentity) return;
      if (tenant && col.name === 'StoreId') return;
      const el = bankFieldEls[col.name];
      if (!el) return;
      if (col.dataType === 'boolean') { data[col.name] = el.checked; return; }
      const val = (el.value || '').trim();
      if (val === '') { data[col.name] = null; return; }
      data[col.name] = val;
    });
    return data;
  }

  function openBankNewRow() {
    if (!bankTable) return;
    bankEditingRow = null;
    $('bankRowTitle').textContent = `Novo registro em ${bankTable}`;
    const info = bankTables.find((t) => t.table === bankTable);
    $('bankRowTableLabel').textContent = (info && info.tenant)
      ? `StoreId será preenchido automaticamente (loja ${bankStoreId}).`
      : '';
    buildBankRowForm(null);
    $('bankRowError').hidden = true;
    $('bankRowModal').hidden = false;
    const first = $('bankRowFields').querySelector('input, select, textarea');
    if (first) first.focus();
  }

  function openBankEditRow(row) {
    if (!bankTable) return;
    bankEditingRow = row;
    $('bankRowTitle').textContent = `Editar registro em ${bankTable}`;
    $('bankRowTableLabel').textContent = '';
    buildBankRowForm(row);
    $('bankRowError').hidden = true;
    $('bankRowModal').hidden = false;
  }

  async function saveBankRow() {
    const errEl = $('bankRowError');
    errEl.hidden = true;
    const missing = [...$('bankRowFields').querySelectorAll('[data-required]')].filter((el) => !el.value.trim());
    if (missing.length) {
      errEl.textContent = 'Preencha os campos obrigatórios (destacados).';
      errEl.hidden = false;
      missing[0].focus();
      return;
    }
    const data = readBankRowForm();
    const isEdit = !!bankEditingRow;
    const url = `/api/v1/admin/db/tables/${encodeURIComponent(bankTable)}/rows`;
    try {
      await api(url, {
        method: isEdit ? 'PUT' : 'POST',
        headers: authHeaders(),
        body: JSON.stringify(data)
      });
      $('bankRowModal').hidden = true;
      showAppToast(isEdit ? 'Registro atualizado.' : 'Registro criado.');
      await loadBankRows();
    } catch (err) {
      errEl.textContent = err.message || 'Falha ao salvar o registro.';
      errEl.hidden = false;
    }
  }

  function bankPkValues(row) {
    const info = bankTables.find((t) => t.table === bankTable);
    const pks = (info && info.columns ? info.columns : bankColumns).filter((c) => c.isPrimaryKey);
    const values = pks.map((c) => row[c.name]);
    return pks.length ? pks.map((c, i) => `${c.name} = ${JSON.stringify(values[i])}`).join(', ') : 'linha';
  }

  async function deleteBankRow(row) {
    const info = bankTables.find((t) => t.table === bankTable);
    const pks = (info && info.columns ? info.columns : bankColumns).filter((c) => c.isPrimaryKey);
    const label = pks.length ? pks.map((c) => String(row[c.name])).join(' · ') : 'este registro';
    const confirmed = await askTypeConfirm(
      `Excluir <strong>${escapeHtml(bankTable)}</strong> (${escapeHtml(label)})?`,
      label,
      { title: 'Excluir registro', confirmLabel: 'Excluir' }
    );
    if (!confirmed) return;
    try {
      await api(`/api/v1/admin/db/tables/${encodeURIComponent(bankTable)}/rows`, {
        method: 'DELETE',
        headers: authHeaders(),
        body: JSON.stringify(row)
      });
      showAppToast('Registro excluído.');
      await loadBankRows();
    } catch (err) {
      showAppToast(err.message || 'Falha ao excluir.', 'error');
    }
  }

  const APP_TIMEZONE = 'America/Sao_Paulo';

  function parseApiDate(value) {
    if (value instanceof Date) return value;
    if (value == null || value === '') return null;
    const raw = String(value).trim();
    // Sem timezone: API grava UTC, mas o banco/JSON às vezes omite o "Z"
    let normalized = raw;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(raw)) {
      normalized = `${raw}Z`;
    }
    const d = new Date(normalized);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  function formatDateTime(iso) {
    if (!iso) return '—';
    try {
      const d = parseApiDate(iso);
      if (!d) return String(iso);
      return d.toLocaleString('pt-BR', {
        timeZone: APP_TIMEZONE,
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
    } catch (_) {
      return iso;
    }
  }

  function dateKeyInSaoPaulo(value) {
    const d = value instanceof Date ? value : parseApiDate(value);
    if (!d || Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: APP_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
  }

  function stopOrdersSse() {
    if (ordersSseAbort) {
      try { ordersSseAbort.abort(); } catch (_) { /* ignore */ }
      ordersSseAbort = null;
    }
    ordersSseConnected = false;
  }

  function stopOrdersPolling() {
    if (ordersPollTimer) {
      clearInterval(ordersPollTimer);
      ordersPollTimer = null;
    }
    stopOrdersSse();
    if (window.__closingAlertTimer) {
      clearInterval(window.__closingAlertTimer);
      window.__closingAlertTimer = null;
    }
    const badge = $('ordersLiveBadge');
    if (badge) badge.classList.remove('alert');
  }

  // Ao receber eventos de pedidos (criação/status via SSE/poll), atualiza também
  // o mapa de mesas — o status da comanda aparece no card da mesa em tempo real.
  function maybeRefreshTablesLive() {
    if (activeTab !== 'mesas') return;
    loadTablesTab({ silent: true }).catch(() => {});
  }

  async function connectOrdersSse() {
    stopOrdersSse();
    if (!token || !canSeeOrders()) return;
    const ctrl = new AbortController();
    ordersSseAbort = ctrl;
    try {
      const res = await fetch(`${API}/api/v1/orders/stream`, {
        headers: authHeaders(),
        signal: ctrl.signal
      });
      if (!res.ok || !res.body) {
        throw new Error(`SSE ${res.status}`);
      }
      ordersSseConnected = true;
      // Com SSE ativo, o poll fica só como rede de segurança
      if (ordersPollTimer) {
        clearInterval(ordersPollTimer);
        ordersPollTimer = setInterval(() => {
          applyOrdersLiveBadge();
          refreshOrders({ silent: true }).catch((err) => console.warn('Polling pedidos', err));
          maybeRefreshTablesLive();
        }, ORDERS_POLL_SSE_MS);
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
          refreshOrders({ silent: true }).catch((err) => console.warn('SSE refresh', err));
          maybeRefreshTablesLive();
        }
      }
    } catch (err) {
      if (ctrl.signal.aborted) return;
      console.warn('SSE pedidos indisponível — mantendo poll', err);
    } finally {
      if (ordersSseAbort === ctrl) {
        ordersSseConnected = false;
        ordersSseAbort = null;
        // Sem SSE, volta o poll rápido
        if (token && canSeeOrders()) {
          if (ordersPollTimer) clearInterval(ordersPollTimer);
          ordersPollTimer = setInterval(() => {
            applyOrdersLiveBadge();
            refreshOrders({ silent: true }).catch((e) => console.warn('Polling pedidos', e));
            maybeRefreshTablesLive();
          }, ORDERS_POLL_MS);
        }
      }
    }
  }

  function updateOrdersPolling() {
    stopOrdersPolling();
    if (!token || !canSeeOrders()) return;
    refreshAcceptingOrdersBadge();
    ordersPollTimer = setInterval(() => {
      applyOrdersLiveBadge();
      refreshOrders({ silent: true }).catch((err) => console.warn('Polling pedidos', err));
      maybeRefreshTablesLive();
    }, ORDERS_POLL_MS);
    connectOrdersSse().catch(() => {});
    // Reavalia alerta de encerramento mesmo entre polls de pedidos
    if (!window.__closingAlertTimer) {
      window.__closingAlertTimer = setInterval(() => {
        if (token && canSeeOrders() && activeTab === 'orders') {
          maybePromptClosingExtension().catch(() => {});
        }
      }, 60_000);
    }
  }

  function stopDashboardPolling() {
    if (dashboardPollTimer) {
      clearInterval(dashboardPollTimer);
      dashboardPollTimer = null;
    }
  }

  function updateDashboardPolling() {
    stopDashboardPolling();
    if (!token || !isStoreAdmin() || activeTab !== 'dashboard') return;
    dashboardPollTimer = setInterval(() => {
      loadDashboard({ silent: true }).catch(() => {});
    }, DASHBOARD_POLL_MS);
  }

  function parseTimeToMinutes(value) {
    const m = String(value || '').trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  function getExtendedCloseUntil(store = storeConfig) {
    const d = parseApiDate(store?.extendedCloseUntilUtc);
    return d && !Number.isNaN(d.getTime()) ? d : null;
  }

  function isWithinExtendedClose(store = storeConfig, now = new Date()) {
    const until = getExtendedCloseUntil(store);
    return !!(until && until.getTime() > now.getTime());
  }

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

  /** Forma canônica por dia (0..6) do schedule. Cobre perDay novo e espelhos legados. */
  function perDayFromConfig(store = storeConfig) {
    const s = store?.schedule;
    if (!s) return [];
    if (Array.isArray(s.perDay) && s.perDay.length) return s.perDay;
    const days = Array.isArray(s.days) ? s.days.map(Number) : [];
    return WEEK_DAYS.map((d) => ({
      day: d.value,
      enabled: days.includes(d.value),
      open: s.open || '18:00',
      close: s.close || '23:55',
      breakEnabled: false,
      breakStart: '',
      breakEnd: '',
      deliveryMinutes: null
    }));
  }

  function perDayEntryFor(day, perDay = []) {
    return perDay.find((p) => Number(p.day) === day);
  }

  /**
   * Resolve a entrada per-day que governa o momento atual (dia corrente ou dia anterior na
   * madrugada), junto com o minuto local. Retorna null quando fora do horário.
   */
  function resolveActiveDayEntry(store = storeConfig, now = new Date()) {
    const sp = saoPauloParts(now);
    const current = sp.hour * 60 + sp.minute;
    const perDay = perDayFromConfig(store);
    const today = perDayEntryFor(sp.day, perDay);
    const yesterday = perDayEntryFor((sp.day + 6) % 7, perDay);

    if (today?.enabled) {
      const tOpen = parseTimeToMinutes(today.open);
      const tClose = parseTimeToMinutes(today.close);
      if (tOpen != null && tClose != null) {
        if (tClose >= tOpen) {
          if (current >= tOpen && current <= tClose) return { entry: today, current, sp };
        } else if (current >= tOpen) {
          return { entry: today, current, sp };
        }
      }
    }
    if (yesterday?.enabled) {
      const yOpen = parseTimeToMinutes(yesterday.open);
      const yClose = parseTimeToMinutes(yesterday.close);
      if (yOpen != null && yClose != null && yClose < yOpen && current <= yClose) {
        return { entry: yesterday, current, sp };
      }
    }
    return null;
  }

  function isStoreOnBreakNow(store = storeConfig, now = new Date()) {
    if (isWithinExtendedClose(store, now)) return false;
    const active = resolveActiveDayEntry(store, now);
    if (!active || !active.entry.breakEnabled) return false;
    const start = parseTimeToMinutes(active.entry.breakStart);
    const end = parseTimeToMinutes(active.entry.breakEnd);
    if (start == null || end == null) return false;
    return active.current >= start && active.current <= end;
  }

  /** Encerramento efetivo (horário fixo do dia vigente ou extensão). */
  function getEffectiveCloseAt(store = storeConfig, now = new Date()) {
    const extended = getExtendedCloseUntil(store);
    if (extended && extended.getTime() > now.getTime()) return extended;

    const active = resolveActiveDayEntry(store, now);
    if (!active) return null;
    const { entry, sp } = active;
    const close = parseTimeToMinutes(entry.close);
    const open = parseTimeToMinutes(entry.open);
    if (close == null) return null;
    const overnight = open != null && close < open;

    let y = sp.year;
    let m = sp.month;
    let d = sp.date;
    if (entry.day === sp.day && overnight) {
      const next = new Date(Date.UTC(y, m - 1, d + 1));
      y = next.getUTCFullYear();
      m = next.getUTCMonth() + 1;
      d = next.getUTCDate();
    }

    const pad = (n) => String(n).padStart(2, '0');
    const hh = Math.floor(close / 60);
    const mm = close % 60;
    const parsed = new Date(`${y}-${pad(m)}-${pad(d)}T${pad(hh)}:${pad(mm)}:00-03:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function minutesUntilClose(store = storeConfig, now = new Date()) {
    const closeAt = getEffectiveCloseAt(store, now);
    if (!closeAt) return null;
    return Math.round((closeAt.getTime() - now.getTime()) / 60000);
  }

  /** Horário de expediente no fuso America/Sao_Paulo (mesmo critério do cardápio). */
  function isStoreOpenNow(store = storeConfig, now = new Date()) {
    if (isWithinExtendedClose(store, now)) return true;
    return resolveActiveDayEntry(store, now) !== null;
  }

  function resolveOrdersLiveStatus(store = storeConfig) {
    const accepting = store?.acceptingOrders !== false;
    if (!accepting) {
      return {
        key: 'paused',
        label: 'Encerrado',
        title: 'Expediente encerrado manualmente. Clique para retomar o recebimento de pedidos.'
      };
    }
    if (!isStoreOpenNow(store)) {
      return {
        key: 'offline',
        label: 'Fora do horário',
        title: 'Fora do horário de expediente configurado. Clique para gerenciar o recebimento de pedidos.'
      };
    }
    if (isStoreOnBreakNow(store)) {
      return {
        key: 'interval',
        label: 'Em intervalo',
        title: 'Dentro do horário, mas em intervalo de pausa (novos pedidos suspensos). Clique para gerenciar.'
      };
    }
    const mins = minutesUntilClose(store);
    const extended = isWithinExtendedClose(store);
    return {
      key: 'online',
      label: 'Online',
      title: extended
        ? `Recebendo pedidos (extensão até ${formatDateTime(store.extendedCloseUntilUtc)}). Clique para gerenciar.`
        : (mins != null && mins <= 30
          ? `Recebendo pedidos · encerra em ~${mins} min. Clique para gerenciar.`
          : 'Recebendo pedidos. Clique para encerrar o expediente.')
    };
  }

  function applyOrdersLiveBadge() {
    const badge = $('ordersLiveBadge');
    if (!badge) return;
    const status = resolveOrdersLiveStatus();
    const hadAlert = badge.classList.contains('alert');
    badge.classList.remove('paused', 'offline', 'interval');
    if (status.key === 'paused') badge.classList.add('paused');
    if (status.key === 'offline' || status.key === 'interval') badge.classList.add('offline');
    badge.textContent = status.label;
    badge.title = status.title;
    if (hadAlert) badge.classList.add('alert');
  }

  const CLOSING_ALERT_MINUTES = 30;
  let closingAlertOpen = false;

  function closingAlertStorageKey(closeAt) {
    return `delivery-closing-alert:${closeAt ? closeAt.toISOString() : 'none'}`;
  }

  async function maybePromptClosingExtension() {
    if (!token || !canSeeOrders() || activeTab !== 'orders') return;
    if (closingAlertOpen) return;
    if (storeConfig?.acceptingOrders === false) return;
    if (!isStoreOpenNow()) return;

    const mins = minutesUntilClose();
    if (mins == null || mins <= 0 || mins > CLOSING_ALERT_MINUTES) return;

    const closeAt = getEffectiveCloseAt();
    const key = closingAlertStorageKey(closeAt);
    try {
      if (sessionStorage.getItem(key) === '1') return;
    } catch (_) { /* ignore */ }

    closingAlertOpen = true;
    try {
      const choice = await askClosingExtensionAction(mins, closeAt);
      if (choice === '30' || choice === '60') {
        const minutes = Number(choice);
        const data = await api('/api/v1/ops/extend-hours', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ minutes })
        });
        storeConfig = {
          ...storeConfig,
          acceptingOrders: data?.acceptingOrders !== false,
          extendedCloseUntilUtc: data?.extendedCloseUntilUtc || null
        };
        try { sessionStorage.removeItem(key); } catch (_) { /* ignore */ }
        applyOrdersLiveBadge();
        showAppToast(`Expediente estendido por mais ${minutes} minutos (até ${formatDateTime(storeConfig.extendedCloseUntilUtc)}).`);
        return;
      }
      try { sessionStorage.setItem(key, '1'); } catch (_) { /* ignore */ }
    } finally {
      closingAlertOpen = false;
    }
  }

  function askClosingExtensionAction(minsLeft, closeAt) {
    return new Promise((resolve) => {
      const existing = $('closingExtendModal');
      if (existing) existing.remove();

      const closeLabel = closeAt ? formatDateTime(closeAt.toISOString()) : 'horário configurado';
      const modal = document.createElement('div');
      modal.id = 'closingExtendModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true">` +
        `<h3>Encerramento próximo</h3>` +
        `<p>O expediente encerra em <strong>~${escapeHtml(String(minsLeft))} min</strong> (${escapeHtml(closeLabel)}).</p>` +
        `<p class="muted">Deseja continuar recebendo pedidos por mais tempo?</p>` +
        `<div class="confirm-modal-actions">` +
          `<button type="button" class="confirm" data-close-ext="30">+ 30 minutos</button>` +
          `<button type="button" class="confirm" data-close-ext="60">+ 1 hora</button>` +
          `<button type="button" class="ghost compact" data-close-ext="dismiss">Encerrar no horário</button>` +
        `</div></div>`;

      const finish = (value) => {
        modal.remove();
        resolve(value);
      };
      modal.addEventListener('click', (e) => {
        if (e.target === modal) finish('dismiss');
      });
      modal.querySelectorAll('[data-close-ext]').forEach((btn) => {
        btn.addEventListener('click', () => finish(btn.getAttribute('data-close-ext')));
      });
      document.body.appendChild(modal);
    });
  }

  async function refreshAcceptingOrdersBadge() {
    const badge = $('ordersLiveBadge');
    if (!badge) return;
    try {
      const data = await api('/api/v1/ops/accepting-orders', { headers: authHeaders() });
      const accepting = data?.acceptingOrders !== false;
      storeConfig = {
        ...storeConfig,
        acceptingOrders: accepting,
        extendedCloseUntilUtc: data?.extendedCloseUntilUtc ?? storeConfig.extendedCloseUntilUtc ?? null
      };
      applyOrdersLiveBadge();
      maybePromptClosingExtension().catch((err) => console.warn('Alerta de encerramento', err));
    } catch (err) {
      console.warn('Status de expediente', err);
      applyOrdersLiveBadge();
      if (!storeConfig?.schedule) {
        badge.textContent = 'Offline';
        badge.classList.add('offline');
        badge.title = 'Não foi possível confirmar o status do expediente.';
      }
    }
  }

  function askExpedienteAction() {
    return new Promise((resolve) => {
      const existing = $('expedienteModal');
      if (existing) existing.remove();

      const accepting = storeConfig?.acceptingOrders !== false;
      const withinHours = isStoreOpenNow();
      const live = resolveOrdersLiveStatus();
      const modal = document.createElement('div');
      modal.id = 'expedienteModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true">` +
        `<h3>Expediente</h3>` +
        `<p>Status atual: <strong>${escapeHtml(live.label)}</strong>` +
          `${accepting && !withinHours ? ' (fora do horário configurado)' : ''}` +
          `${!accepting ? ' (pausado manualmente)' : ''}</p>` +
        `<p class="muted">O horário da loja também fecha automaticamente conforme a configuração. Use esta opção para encerrar antes do horário.</p>` +
        `<div class="confirm-modal-actions">` +
        (accepting
          ? `<button type="button" class="confirm" data-exp-choice="close">Encerrar expediente</button>`
          : `<button type="button" class="confirm" data-exp-choice="open">Retomar pedidos</button>`) +
        `<button type="button" class="ghost compact" data-exp-choice="cancel">Cancelar</button>` +
        `</div></div>`;

      const finish = (value) => {
        modal.remove();
        resolve(value);
      };
      modal.addEventListener('click', (e) => {
        if (e.target === modal) finish(null);
      });
      modal.querySelectorAll('[data-exp-choice]').forEach((btn) => {
        btn.addEventListener('click', () => finish(btn.getAttribute('data-exp-choice')));
      });
      document.body.appendChild(modal);
    });
  }

  async function toggleExpedienteFromBadge() {
    if (!token || !canSeeOrders()) return;
    const choice = await askExpedienteAction();
    if (!choice || choice === 'cancel') return;
    const acceptingOrders = choice === 'open';
    if (choice === 'close' && !(await askConfirm(
      'Encerrar expediente? O cardápio deixará de aceitar novos pedidos e exibirá pedido de desculpas.'
    ))) return;

    await api('/api/v1/ops/accepting-orders', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ acceptingOrders })
    });
    storeConfig = {
      ...storeConfig,
      acceptingOrders,
      extendedCloseUntilUtc: acceptingOrders ? storeConfig.extendedCloseUntilUtc : null
    };
    await refreshAcceptingOrdersBadge();
    showAppToast(acceptingOrders
      ? 'Expediente reaberto: a loja voltou a receber pedidos (dentro do horário configurado).'
      : 'Expediente encerrado: novos pedidos não serão aceitos no momento.');
  }

  function isOrderFromToday(order) {
    const raw = order?.createdAtUtc;
    if (!raw) return false;
    const createdKey = dateKeyInSaoPaulo(raw);
    if (!createdKey) return false;
    return createdKey === dateKeyInSaoPaulo(new Date());
  }

  function ordersForFilter(filter) {
    let result;
    if (filter === 'all') result = orders.filter(isOrderFromToday);
    else if (filter === 'Delivered') {
      result = orders.filter((o) => o.status === 'Delivered' && isOrderFromToday(o));
    }
    else if (filter === 'Cancelled') {
      result = orders.filter((o) => o.status === 'Cancelled' && isOrderFromToday(o));
    }
    else if (filter === 'overdue') {
      result = orders.filter((o) => isOrderSlaOverdue(o) || isOrderNearDeliveryLimit(o));
    }
    else if (filter === 'deliveredDineIn') {
      result = orders.filter((o) =>
        o.status === 'Delivered'
        && String(o.fulfillmentType || '').toLowerCase() === 'dine_in'
        && o.tableId != null
        && tableIsOccupied(o.tableId)
      );
    }
    else result = orders.filter((o) => o.status === filter);

    const ff = fulfillmentFilter;
    if (ff && ff !== 'all') {
      result = result.filter((o) => String(o.fulfillmentType || 'delivery').toLowerCase() === ff);
    }
    return result;
  }

  function setFulfillmentFilter(ff, { render = true } = {}) {
    fulfillmentFilter = ff || 'all';
    document.querySelectorAll('[data-fulfillment-filter]').forEach((b) => {
      b.classList.toggle('active', b.dataset.fulfillmentFilter === fulfillmentFilter);
    });
    updateOrderFilterCounts();
    if (render) renderOrdersBoard();
  }

  function canCancelOrder(order) {
    const s = order?.status;
    return s === 'Created'
      || s === 'Accepted'
      || s === 'Preparing'
      || s === 'OutForDelivery'
      || s === 'ReadyForPickup'
      || s === 'ReadyForTable';
  }

  function filteredOrders() {
    return ordersForFilter(orderFilter);
  }

  function setOrderFilter(filter, { render = true } = {}) {
    // Evita fixar uma aba oculta (contagem 0 e não-default).
    const count = ordersForFilter(filter).length;
    if (!isDefaultOrderFilter(filter) && count === 0 && filter !== 'Created') {
      filter = 'Created';
    }
    orderFilter = filter;
    document.querySelectorAll('[data-order-filter]').forEach((b) => {
      b.classList.toggle('active', b.dataset.orderFilter === filter);
    });
    updateOrderFilterCounts();
    if (render) renderOrdersBoard();
  }

  function countActiveKitchenOrders() {
    return ordersForFilter('Created').length
      + ordersForFilter('Accepted').length
      + ordersForFilter('Preparing').length
      + ordersForFilter('OutForDelivery').length
      + ordersForFilter('ReadyForPickup').length
      + ordersForFilter('ReadyForTable').length;
  }

  function updateOrdersTabCount() {
    const tabBtn = document.querySelector('[data-tab="orders"]');
    if (!tabBtn) return;
    const label = tabBtn.querySelector('.nav-label');
    if (!label) return;
    const count = countActiveKitchenOrders();
    label.textContent = count > 0 ? `Pedidos (${count})` : 'Pedidos';
  }

  function orderFilterLabel(filter, count) {
    const entry = ORDER_FILTER_LABELS[filter];
    if (!entry) return filter;
    if (typeof entry === 'string') return entry;
    return count > 1 ? entry.many : entry.one;
  }

  function updateOrderFilterCounts() {
    document.querySelectorAll('[data-order-filter]').forEach((btn) => {
      const filter = btn.dataset.orderFilter;
      const count = ordersForFilter(filter).length;
      const label = orderFilterLabel(filter, count);
      btn.textContent = count > 0 ? `${label} (${count})` : label;
      // Abas dinâmicas: só aparecem quando há itens, exceto sempre-visíveis (Created/Total).
      btn.hidden = !(count > 0 || isDefaultOrderFilter(filter));
      btn.classList.toggle('filter-alert-created', filter === 'Created' && count > 0);
      btn.classList.toggle('filter-alert-accepted', filter === 'Accepted' && count > 0);
      btn.classList.toggle('filter-alert-preparing', filter === 'Preparing' && count > 0);
      btn.classList.toggle('filter-alert-ready', filter === 'ReadyForTable' && count > 0);
      btn.classList.toggle('filter-alert-overdue', filter === 'overdue' && count > 0);
    });
    updateOrdersTabCount();
  }

  function isDefaultOrderFilter(filter) {
    return ORDER_FILTER_DEFAULTS.has(filter);
  }

  function ensureActiveFilterVisible() {
    if (isDefaultOrderFilter(orderFilter)) return;
    const count = ordersForFilter(orderFilter).length;
    if (count > 0) return;
    setOrderFilter('Created', { render: false });
  }

  function isPaymentBlockingDelivery(order) {
    return !canMarkOrderDelivered(order);
  }

  function canMarkOrderDelivered(order) {
    return String(order.paymentStatus || '').toLowerCase() === 'confirmed';
  }

  function deliverBlockedReason(order) {
    const status = String(order.paymentStatus || '').toLowerCase();
    if (status === 'pending') return 'Confirme o pagamento Pix antes de marcar como entregue.';
    if (status === 'on_delivery') return 'Confirme o recebimento do pagamento antes de marcar como entregue.';
    return 'Confirme o pagamento antes de marcar como entregue.';
  }

  async function refreshOrders({ silent } = {}) {
    if (!token || !canSeeOrders()) return;
    const seq = ++ordersRefreshSeq;
    try {
      if (!(Array.isArray(catalog.categories) && catalog.categories.length)) {
        await ensurePublicCatalog();
      }
      const data = await api('/api/v1/orders?limit=100', { headers: authHeaders() });
      // Ignora resposta atrasada (ex.: polling antigo após aceitar pedido)
      if (seq !== ordersRefreshSeq) return;

      const list = Array.isArray(data) ? data : [];
      // Evita poll atrasado reverter status já avançado localmente (e religar sirene de prazo).
      const merged = mergeOrdersPreferringNewerStatus(list);
      const fresh = ordersHydrated
        ? merged.filter((o) => o.orderId && !knownOrderIds.has(o.orderId))
        : [];

      orders = merged;
      knownOrderIds = new Set(merged.map((o) => o.orderId).filter(Boolean));
      ordersHydrated = true;

      merged.forEach((o) => autoPrintMesaOnConfirmCheck(o));

      if (fresh.length) {
        notifyNewOrders(fresh);
      } else {
        syncNewOrderAlerts();
      }
      syncSlaAlerts();

      await refreshTablesSnapshot().catch(() => {});
      renderOrdersBoard(new Set(fresh.map((o) => o.orderId)));
      const meta = $('ordersMeta');
      if (meta) {
        const novos = ordersForFilter('Created').length;
        const prep = ordersForFilter('Preparing').length;
        const entrega = ordersForFilter('OutForDelivery').length;
        const entreguesHoje = ordersForFilter('Delivered').length;
        meta.textContent =
          `${novos} aguardando confirmação · ${prep} em preparação · ${entrega} ${entrega === 1 ? 'saiu' : 'saíram'} para entrega · ${entreguesHoje} ${entreguesHoje === 1 ? 'finalizado' : 'finalizados'} hoje · atualizado ${formatDateTime(new Date().toISOString())}`;
      }
    } catch (err) {
      if (seq !== ordersRefreshSeq) return;
      if (!silent) throw err;
      console.warn('Falha ao atualizar pedidos', err);
      const meta = $('ordersMeta');
      if (meta) meta.textContent = `Falha ao atualizar: ${err.message || 'erro'}`;
    }
  }

  function countUnacceptedOrders() {
    return orders.filter((o) => o.status === 'Created').length;
  }

  function hasUnacceptedOrders() {
    return countUnacceptedOrders() > 0;
  }

  function notifyNewOrders(fresh) {
    showNewOrderToast(fresh);
    // Sempre tenta o som na chegada (não só se o loop já existir)
    playNewOrderSound();
    startNewOrderAlertLoop();
    try {
      if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
    } catch (_) { /* ignore */ }

    const count = fresh.length;
    const first = fresh[0];
    const detail = count === 1
      ? `${first.orderId} · ${first.customerName || 'Cliente'}`
      : fresh.map((o) => o.orderId).filter(Boolean).slice(0, 4).join(', ');
    // force: em segundo plano o browser costuma bloquear Web Audio — notificação traz o som do SO
    pushDesktopNotification(
      count > 1 ? `${count} novos pedidos` : 'Novo pedido',
      detail,
      { force: document.hidden || !isAudioUnlocked() }
    );

    // Ativa Pedidos + Aguardando Confirmação para o novo pedido aparecer
    if (canSeeOrders()) {
      if (activeTab !== 'orders') openTab('orders');
      setOrderFilter('Created');
    }
  }

  function syncNewOrderAlerts() {
    if (hasUnacceptedOrders()) {
      startNewOrderAlertLoop();
    } else {
      stopNewOrderAlertLoop();
    }
  }

  /** Após confirmar/avançar: alinha alerta com a lista local (mesmo se o refresh for descartado). */
  function syncAlertsAfterLocalOrderChange() {
    syncNewOrderAlerts();
    syncSlaAlerts();
    updateOrderFilterCounts();
  }

  /** Prazo de entrega (min) do dia do pedido, com fallback no prazo médio legado. */
  function getAverageDeliveryMinutes(order) {
    const day = order?.createdAtUtc
      ? saoPauloParts(new Date(order.createdAtUtc)).day
      : saoPauloParts(new Date()).day;
    const pd = perDayFromConfig().find((p) => Number(p.day) === day);
    const v = pd && pd.deliveryMinutes;
    if (Number.isFinite(Number(v)) && Number(v) > 0) return Number(v);
    const n = Number(storeConfig?.averageDeliveryMinutes);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function getSlaWarnRatio() {
    return clampInt(adminPrefs.slaWarnPercent, 1, 100, 70) / 100;
  }

  function getSlaDangerRatio() {
    return clampInt(adminPrefs.slaDangerPercent, 1, 100, 90) / 100;
  }

  /** Prazo de entrega conta a partir da confirmação (AcceptedAt). Created não entra no SLA. */
  function orderSlaStartDate(order) {
    if (!order || order.status === 'Created') return null;
    const accepted = parseApiDate(order.acceptedAtUtc);
    if (accepted) return accepted;
    if (order.status === 'Accepted') {
      const updated = parseApiDate(order.statusUpdatedAtUtc);
      if (updated) return updated;
    }
    return parseApiDate(order.createdAtUtc);
  }

  function orderElapsedMinutes(order) {
    const start = orderSlaStartDate(order);
    if (!start) return 0;
    return Math.max(0, (Date.now() - start.getTime()) / 60000);
  }

  function isKitchenOrderStatus(status) {
    return status === 'Accepted'
      || status === 'Preparing'
      || status === 'OutForDelivery'
      || status === 'ReadyForPickup';
  }

  function isActiveOrderStatus(status) {
    return status === 'Created' || isKitchenOrderStatus(status);
  }

  function isOrderSlaWarn(order) {
    const limit = getAverageDeliveryMinutes(order);
    if (!limit || !isKitchenOrderStatus(order?.status)) return false;
    const elapsed = orderElapsedMinutes(order);
    return elapsed >= limit * getSlaWarnRatio() && elapsed < limit * getSlaDangerRatio();
  }

  function isOrderNearDeliveryLimit(order) {
    const limit = getAverageDeliveryMinutes(order);
    if (!limit || !isKitchenOrderStatus(order?.status)) return false;
    return orderElapsedMinutes(order) >= limit * getSlaDangerRatio();
  }

  function isOrderSlaOverdue(order) {
    const limit = getAverageDeliveryMinutes(order);
    if (!limit || !isKitchenOrderStatus(order?.status)) return false;
    return orderElapsedMinutes(order) >= limit;
  }

  function ordersNearDeliveryLimit() {
    return orders.filter(isOrderNearDeliveryLimit);
  }

  function formatSlaLabel(order) {
    const limit = getAverageDeliveryMinutes(order);
    if (!limit || !isKitchenOrderStatus(order?.status)) return '';
    const elapsed = Math.floor(orderElapsedMinutes(order));
    const tag = isOrderSlaOverdue(order) ? ' estourado' : (isOrderNearDeliveryLimit(order) ? ' crítico' : (isOrderSlaWarn(order) ? ' atenção' : ''));
    return `${elapsed}/${limit} min${tag}`;
  }

  function stopSirenSound() {
    const nodes = slaSirenNodes.splice(0, slaSirenNodes.length);
    nodes.forEach((node) => {
      try { node.stop(); } catch (_) { /* ignore */ }
      try { node.disconnect(); } catch (_) { /* ignore */ }
    });
  }

  function playSirenSound() {
    if (!shouldPlayAlertSound()) return;
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const vol = (clampInt(adminPrefs.slaVolume, 0, 100, 90) / 100) * 0.2;
    const run = () => {
      try {
        const now = ctx.currentTime;
        for (let i = 0; i < 6; i += 1) {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(i % 2 === 0 ? 780 : 980, now + i * 0.12);
          gain.gain.setValueAtTime(0.0001, now + i * 0.12);
          gain.gain.exponentialRampToValueAtTime(Math.max(0.0001, vol), now + i * 0.12 + 0.02);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + i * 0.12 + 0.11);
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.start(now + i * 0.12);
          osc.stop(now + i * 0.12 + 0.12);
          slaSirenNodes.push(osc, gain);
          const cleanup = () => {
            const oi = slaSirenNodes.indexOf(osc);
            if (oi >= 0) slaSirenNodes.splice(oi, 1);
            const gi = slaSirenNodes.indexOf(gain);
            if (gi >= 0) slaSirenNodes.splice(gi, 1);
          };
          osc.onended = cleanup;
        }
      } catch (err) {
        console.warn('Sirene SLA indisponível', err);
      }
    };
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (ctx.state === 'running') run();
      }).catch(() => {});
      return;
    }
    run();
  }

  function startSlaAlertLoop() {
    const near = ordersNearDeliveryLimit();
    if (!near.length) {
      stopSlaAlertLoop();
      return;
    }
    document.body.classList.add('orders-sla-alert');
    if (slaAlertTimer) return;

    const tick = () => {
      const current = ordersNearDeliveryLimit();
      if (!current.length) {
        stopSlaAlertLoop();
        return;
      }
      playSirenSound();
      if (!areAlertsMuted()) {
        try {
          if (navigator.vibrate) navigator.vibrate([200, 80, 200, 80, 200]);
        } catch (_) { /* ignore */ }
      }
    };

    tick();
    slaAlertTimer = setInterval(tick, 4500);
  }

  function stopSlaAlertLoop() {
    if (slaAlertTimer) {
      clearInterval(slaAlertTimer);
      slaAlertTimer = null;
    }
    stopSirenSound();
    knownSlaAlertIds = new Set();
    document.body.classList.remove('orders-sla-alert');
  }

  function syncSlaAlerts() {
    if (!getAverageDeliveryMinutes()) {
      stopSlaAlertLoop();
      return;
    }
    const near = ordersNearDeliveryLimit();
    if (!near.length) {
      stopSlaAlertLoop();
      return;
    }
    const ids = new Set(near.map((o) => o.orderId).filter(Boolean));
    const entered = [...ids].filter((id) => !knownSlaAlertIds.has(id));
    knownSlaAlertIds = ids;
    startSlaAlertLoop();
    if (entered.length) {
      playSirenSound();
      const sample = near.find((o) => entered.includes(o.orderId)) || near[0];
      pushDesktopNotification(
        entered.length > 1 ? `${entered.length} pedidos no prazo crítico` : 'Pedido no prazo crítico',
        sample ? `${sample.orderId} · ${formatSlaLabel(sample)}` : 'Verifique o painel de pedidos'
      );
    }
  }

  function startNewOrderAlertLoop() {
    if (!hasUnacceptedOrders()) {
      stopNewOrderAlertLoop();
      return;
    }
    setOrdersChromeAlert(true);
    startTitleFlash();
    if (newOrderAlertTimer) return;

    const tick = () => {
      // Reconta na hora — lista pode ter sido atualizada ao aceitar o pedido
      if (!hasUnacceptedOrders()) {
        stopNewOrderAlertLoop();
        return;
      }
      playNewOrderSound();
      setOrdersChromeAlert(true);
      try {
        if (navigator.vibrate) navigator.vibrate([80, 40, 80]);
      } catch (_) { /* ignore */ }
    };

    tick();
    newOrderAlertTimer = setInterval(tick, NEW_ORDER_ALERT_MS);
  }

  function stopNewOrderAlertLoop() {
    if (newOrderAlertTimer) {
      clearInterval(newOrderAlertTimer);
      newOrderAlertTimer = null;
    }
    stopTitleFlash();
    setOrdersChromeAlert(false);
    hideNewOrderToast();
  }

  let sharedAudioCtx = null;

  function ensureAudioContext() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
        sharedAudioCtx = new Ctx();
      }
      if (sharedAudioCtx.state === 'suspended') {
        sharedAudioCtx.resume().catch(() => {});
      }
      return sharedAudioCtx;
    } catch (_) {
      return null;
    }
  }

  /** Desbloqueia áudio no gesto do usuário (obrigatório no Chrome). */
  async function unlockAudioFromGesture() {
    const ctx = ensureAudioContext();
    if (!ctx) return false;
    try {
      if (ctx.state === 'suspended') await ctx.resume();
    } catch (_) { /* ignore */ }
    return ctx.state === 'running';
  }

  function scheduleTones(ctx, notes, { type = 'triangle', step = 0.14, peak = 0.2, dur = 0.12 } = {}) {
    const now = ctx.currentTime;
    const vol = Math.max(0.0001, peak);
    notes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      const t0 = now + i * step;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    });
  }

  function playNewOrderSound() {
    if (!shouldPlayAlertSound()) return;
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const vol = (clampInt(adminPrefs.newOrderVolume, 0, 100, 70) / 100) * 0.28;
    const run = () => {
      try {
        scheduleTones(ctx, [988, 1319, 1568], { type: 'triangle', step: 0.14, peak: vol, dur: 0.12 });
      } catch (err) {
        console.warn('Som de novo pedido indisponível', err);
      }
    };
    if (ctx.state === 'suspended') {
      ctx.resume().then(() => {
        if (ctx.state === 'running') run();
      }).catch(() => {});
      return;
    }
    run();
  }

  function ensureNewOrderToast() {
    let el = $('newOrderToast');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'newOrderToast';
    el.className = 'new-order-toast';
    el.hidden = true;
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
    return el;
  }

  function showNewOrderToast(fresh) {
    const el = ensureNewOrderToast();
    const count = fresh.length;
    const first = fresh[0];
    const detail = count === 1
      ? `${first.orderId} · ${first.customerName || 'Cliente'}`
      : `${count} novos pedidos chegaram`;
    el.innerHTML =
      `<strong>Novo pedido!</strong>` +
      `<span>${escapeHtml(detail)}</span>` +
      `<button type="button" class="ghost compact" data-toast-dismiss>Ok</button>`;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    el.querySelector('[data-toast-dismiss]')?.addEventListener('click', hideNewOrderToast);
    clearTimeout(el._hideTimer);
  }

  function hideNewOrderToast() {
    const el = $('newOrderToast');
    if (!el) return;
    el.classList.remove('show');
    el.hidden = true;
    clearTimeout(el._hideTimer);
  }

  function setOrdersChromeAlert(active) {
    document.body.classList.toggle('orders-alert', !!active);
    const badge = $('ordersLiveBadge');
    if (badge) badge.classList.toggle('alert', !!active);
    const tabBtn = document.querySelector('[data-tab="orders"]');
    if (tabBtn) tabBtn.classList.toggle('tab-alert', !!active);
  }

  function startTitleFlash() {
    if (titleFlashTimer) return;
    if (!originalDocumentTitle) originalDocumentTitle = document.title;
    let on = true;
    titleFlashTimer = setInterval(() => {
      const count = countUnacceptedOrders();
      if (!count) {
        stopNewOrderAlertLoop();
        return;
      }
      document.title = on
        ? (count > 1 ? `(${count}) Novo pedido!` : 'Novo pedido!')
        : originalDocumentTitle;
      on = !on;
    }, 900);
  }

  function stopTitleFlash() {
    if (titleFlashTimer) {
      clearInterval(titleFlashTimer);
      titleFlashTimer = null;
    }
    if (originalDocumentTitle) document.title = originalDocumentTitle;
  }

  let receiptPreviewOrder = null;

  function moneyPlain(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }

  /** Igual a moneyPlain, mas com a parte inteira alinhada à direita (mín. 3 colunas)
    * para a vírgula cair sempre na mesma coluna: "R$  35,00" (≤ 99,99 tem 2 espaços),
    * "R$ 100,00" (≥ 100,00 tem 1 espaço); valores < 10,00 ganham 3 espaços p/ alinhar. */
  function moneyPlainCol(value) {
    const amount = moneyPlain(value);
    const comma = amount.indexOf(',');
    if (comma === -1) return '   ' + amount;
    return `${amount.slice(0, comma).padStart(3)}${amount.slice(comma)}`;
  }

  function parseOrderAddressParts(order) {
    const raw = String(order?.address || '').trim();
    const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
    let street = parts[0] || raw || '—';
    let number = '';
    let neighborhood = String(order?.neighborhood || '').trim();
    let city = '';
    let state = '';
    let cep = '';

    if (parts.length >= 2 && /^\d+[A-Za-z]?$/.test(parts[1])) {
      number = parts[1];
      if (!neighborhood && parts[2]) neighborhood = parts[2];
      const cityPart = parts.length >= 4 ? parts[parts.length - 1] : (parts[3] || '');
      const m = String(cityPart).match(/^(.*?)\s*-\s*([A-Za-z]{2})$/);
      if (m) {
        city = m[1].trim();
        state = m[2].trim().toUpperCase();
      } else if (cityPart) {
        city = cityPart;
      }
    } else if (parts.length >= 2) {
      if (!neighborhood) neighborhood = parts[1];
      const cityPart = parts[parts.length - 1] || '';
      const m = String(cityPart).match(/^(.*?)\s*-\s*([A-Za-z]{2})$/);
      if (m) {
        city = m[1].trim();
        state = m[2].trim().toUpperCase();
      }
    }

    const ref = String(order?.reference || '');
    const cepDigits = String(order?.cep || '').replace(/\D/g, '');
    if (cepDigits.length === 8) {
      cep = `${cepDigits.slice(0, 5)}-${cepDigits.slice(5)}`;
    } else {
      const cepMatch = `${raw} ${ref}`.match(/\b(\d{5})-?(\d{3})\b/);
      if (cepMatch) cep = `${cepMatch[1]}-${cepMatch[2]}`;
    }

    return {
      street,
      number,
      neighborhood: neighborhood || '—',
      city: city || '—',
      state,
      cep: cep || '—',
      reference: ref.trim()
    };
  }

  function detectResidenceLabel(order) {
    const ref = String(order?.reference || '').toLowerCase();
    if (/apto|apartamento|bloco|torre/.test(ref)) return 'Apartamento';
    if (/cond\.|condom[ií]nio|portaria/.test(ref)) return 'Condomínio';
    return 'Casa';
  }

  function getReceiptWidthMm() {
    const fromSelect = $('receiptWidthSelect')?.value;
    if (fromSelect === '58' || fromSelect === '80') return fromSelect;
    return adminPrefs.receiptWidthMm === '58' ? '58' : '80';
  }

  /** Largura em caracteres para bobina térmica (texto puro / ECF). */
  function getReceiptCharWidth(mm = getReceiptWidthMm()) {
    return mm === '58' ? 32 : 42;
  }

  function receiptCenter(text, width) {
    const t = String(text || '');
    if (t.length >= width) return t.slice(0, width);
    const pad = width - t.length;
    const left = Math.floor(pad / 2);
    return `${' '.repeat(left)}${t}${' '.repeat(pad - left)}`;
  }

  function receiptWrap(text, width) {
    const raw = String(text || '').replace(/\s+/g, ' ').trim();
    if (!raw) return [''];
    if (raw.length <= width) return [raw];
    const lines = [];
    let rest = raw;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(' ', width);
      if (cut < Math.floor(width * 0.45)) cut = width;
      lines.push(rest.slice(0, cut).trimEnd());
      rest = rest.slice(cut).trimStart();
    }
    if (rest) lines.push(rest);
    return lines;
  }

  function receiptLabeled(label, value, width) {
    const head = `${label} `;
    const val = String(value ?? '—');
    if (head.length >= width) {
      return [head.slice(0, width), ...receiptWrap(val, width)];
    }
    const firstRoom = width - head.length;
    if (val.length <= firstRoom) return [`${head}${val}`];
    const lines = [`${head}${val.slice(0, firstRoom)}`];
    return lines.concat(receiptWrap(val.slice(firstRoom).trimStart(), width));
  }

  /** Largura da coluna em bytes UTF-8 (acentos ocupam 2 bytes; impressora mede por coluna real). */
  function escposCols(s) {
    return new TextEncoder().encode(String(s || '')).length;
  }

  /** Converte acentos/símbolos para ASCII puro — cada caractere vira 1 byte, compatível com CP437 e evita quebra de linha por multibyte. */
  function asciiReceiptText(text) {
    return String(text || '')
      .split('\n')
      .map((line) => line
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\x20-\x7e]/g, (ch) => ({
          'ç': 'c', 'Ç': 'C', 'ñ': 'n', 'Ñ': 'N', 'ß': 'ss',
          'æ': 'ae', 'Æ': 'AE', 'œ': 'oe', 'Œ': 'OE',
          '—': '-', '–': '-', '…': '...',
          '“': '"', '”': '"', '‘': "'", '’': "'"
        })[ch] ?? '?'))
.join('\n');
  }

  /** Converte recursivamente todas as strings de um objeto (ex.: pedido) para ASCII puro ANTES de montar
    * o cupom — assim byte = coluna na impressora e o valor no fim da linha nunca encolhe após o asciize. */
  function deepAscii(value) {
    if (typeof value === 'string') return asciiReceiptText(value);
    if (Array.isArray(value)) return value.map(deepAscii);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = deepAscii(value[key]);
      return out;
    }
    return value;
  }

  /** Estica cada linha até a largura final (em colunas) após o asciize — o padding é calculado com acentos
    * (largura em bytes) e o asciize encolhe a linha; isso devolve os valores à coluna final exata do papel. */
  function padReceiptLinesToWidth(text, chars) {
    const width = Number(chars) || 32;
    return String(text || '').split('\n').map((line) => {
      const cols = escposCols(line);
      if (cols >= width) return line.slice(0, width);
      return line + ' '.repeat(width - cols);
    }).join('\n');
  }

  /** Linha esquerda/direita com espaços (sem pontinhos CSS — melhor para ECF). */
  function receiptRow(left, right, width) {
    const l = String(left || '');
    const r = String(right || '');
    const rCols = escposCols(r);
    if (rCols >= width) return [r.slice(0, width)];
    const lCols = escposCols(l);
    const maxLeft = width - rCols - 1;
    if (lCols <= maxLeft) {
      return [`${l}${' '.repeat(Math.max(0, width - lCols - rCols))}${r}`];
    }
    const wrapped = receiptWrap(l, maxLeft);
    const out = [];
    wrapped.forEach((line, idx) => {
      if (idx === wrapped.length - 1) {
        out.push(`${line}${' '.repeat(Math.max(0, width - escposCols(line) - rCols))}${r}`);
      } else {
        out.push(line);
      }
    });
    return out;
  }

  /** Corta o texto no maior prefixo que cabe em `maxCols` (bytes UTF-8), preferindo limite de palavra. */
  function cutByCols(text, maxCols) {
    const s = String(text || '');
    let acc = 0;
    let cut = 0;
    for (let i = 0; i < s.length; i += 1) {
      const c = escposCols(s[i]);
      if (acc + c > maxCols) break;
      acc += c;
      cut = i + 1;
    }
    let piece = s.slice(0, cut);
    const sp = piece.lastIndexOf(' ');
    if (sp > Math.floor(cut * 0.4)) piece = piece.slice(0, sp);
    return piece.trimEnd();
  }

  /**
   * Linha esquerda/direita com o valor SEMPRE na 1ª linha (nunca desce junto com a
   * quebra do rótulo): se o rótulo não couber, ele continua indentado abaixo.
   */
  function receiptRowFirstLine(left, right, width, indent = '  ') {
    const l = String(left || '');
    const r = String(right || '');
    const rCols = escposCols(r);
    if (rCols + 2 >= width) return receiptRow(l, r, width);
    const maxLeft = width - rCols - 1;
    const pad = (line) => `${line}${' '.repeat(Math.max(0, width - escposCols(line) - rCols))}${r}`;
    if (escposCols(l) <= maxLeft) return [pad(l)];
    const first = cutByCols(l, maxLeft);
    const rest = l.slice(first.length).trimStart();
    const contWidth = Math.max(1, width - indent.length);
    const cont = receiptWrap(rest, contWidth).map((line) => `${indent}${line}`);
    return [pad(first), ...cont];
  }

  function buildOrderReceiptPlainText(order, mm = getReceiptWidthMm(), chars = getReceiptCharWidth(mm)) {
    const width = chars;
    const sep = '-'.repeat(width);
    const addr = parseOrderAddressParts(order);
    const created = parseApiDate(order.createdAtUtc);
    const when = created
      ? created.toLocaleString('pt-BR', {
          timeZone: APP_TIMEZONE,
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        }).replace(',', ' às') + 'hs'
      : '—';
    const storeName = storeConfig?.storeName || 'Fabin Lanches';
    const items = Array.isArray(order.items) ? order.items : [];
    const itemsTotal = Number(order.itemsTotal || 0);
    const deliveryFee = orderDeliveryFee(order);
    const total = Number(order.total != null ? order.total : itemsTotal + deliveryFee);
    const payMethod = String(order.paymentMethod || '—');
    const payTiming = String(order.paymentTimingLabel || order.paymentTiming || '');
    const payStatus = String(order.paymentStatus || '').toLowerCase();
    const paidOnline = payStatus === 'confirmed' && /now|agora/i.test(String(order.paymentTiming || payTiming));
    const cityLine = addr.state && addr.city !== '—'
      ? `${addr.city} - ${addr.state}`
      : addr.city;
    const dineIn = String(order.fulfillmentType || '').toLowerCase() === 'dine_in';
    const fulfillment = dineIn
      ? 'MESA'
      : (String(order.fulfillmentType || '').toLowerCase() === 'pickup'
        ? 'RETIRADA'
        : 'ENTREGA');

    const lines = [];
    lines.push(receiptCenter(storeName, width));
    lines.push(receiptCenter(`#${order.orderId || '—'} ${fulfillment}`, width));
    lines.push(...receiptWrap(`Realizado em ${when}.`, width).map((l) => receiptCenter(l, width)));
    if (adminPrefs.receiptShowSeparators) {
      lines.push(sep);
    } else {
      lines.push('');
    }
    lines.push(...receiptLabeled('NOME:', order.customerName || '—', width));
    lines.push(...receiptLabeled('TEL.:', order.customerPhone || '—', width));
    if (dineIn) {
      lines.push(...receiptLabeled('MESA:', order.tableLabel || '—', width));
      lines.push(...receiptLabeled(attendantReceiptLabel(order), order.waiterName || '—', width));
      lines.push(...receiptLabeled('ORIGEM:', orderSourceLabel(order), width));
    } else if (orderSourceIsStaff(order)) {
      lines.push(...receiptLabeled(attendantReceiptLabel(order), order.waiterName || '—', width));
      lines.push(...receiptLabeled('ORIGEM:', orderSourceLabel(order), width));
    }
    if (fulfillment === 'ENTREGA' && adminPrefs.receiptShowAddress) {
      lines.push(...receiptLabeled('LOCAL:', detectResidenceLabel(order), width));
      lines.push(...receiptLabeled(
        'RUA:',
        `${addr.street}${addr.number ? `, ${addr.number}` : ''}`,
        width
      ));
      if (addr.reference) {
        lines.push(...receiptLabeled('COMP./REF.:', addr.reference, width));
      }
      lines.push(...receiptLabeled('BAIRRO:', addr.neighborhood, width));
      lines.push(...receiptLabeled('CIDADE:', cityLine, width));
      lines.push(...receiptLabeled('CEP:', addr.cep, width));
    }
    if (adminPrefs.receiptShowSeparators) {
      lines.push(sep);
    } else {
      lines.push('');
    }

    if (!items.length) {
      lines.push('Sem itens');
    } else {
      items.forEach((item) => {
        const parts = itemPriceParts(item);
        lines.push(...receiptRowFirstLine(`${parts.qty}x ${parts.name || 'Item'}`, `R$ ${moneyPlainCol(parts.base)}`, width));
        parts.addons.forEach((m) => {
          const delta = Number(m.priceDelta) || 0;
          const value = delta > 0 ? `R$ ${moneyPlainCol(delta * parts.qty)}` : 'grátis';
          lines.push(...receiptRowFirstLine(`  Adic. ${m.name}`, value, width, '    '));
        });
        if (adminPrefs.receiptShowItemNotes) {
          parts.removed.forEach((r) => lines.push(...receiptRow(`  Sem ${r}`, 'grátis', width)));
          if (parts.note) {
            lines.push(...receiptWrap(`Obs.: ${parts.note}`, width - 2).map((l) => `  ${l}`.slice(0, width)));
          }
        }
      });
    }

    const generalNote = String(order.notes || '').trim();
    if (generalNote) {
      lines.push(...receiptWrap(`OBS.: ${generalNote}`, width));
    }

    if (adminPrefs.receiptShowSeparators) {
      lines.push(sep);
    } else {
      lines.push('');
    }
    lines.push(...receiptRow('SUB-TOTAL', `R$ ${moneyPlainCol(itemsTotal)}`, width));
    if (fulfillment === 'ENTREGA') {
      lines.push(...receiptRow('TAXA ENTREGA', `R$ ${moneyPlainCol(deliveryFee)}`, width));
    }
    lines.push(...receiptRow('TOTAL', `R$ ${moneyPlainCol(total)}`, width));
    if (adminPrefs.receiptShowPayment) {
      lines.push(...receiptLabeled('PAGAMENTO:', payMethod, width));
      const openPay = /^em aberto$/i.test(payMethod);
      if (!openPay) {
        const statusText = order.paymentStatusLabel || payStatus || '—';
        if (payTiming && String(payTiming).trim().toLowerCase() !== String(statusText).trim().toLowerCase()) {
          lines.push(...receiptWrap(payTiming, width));
        }
        if (order.needsChange && order.changeFor != null) {
          const change = Number(order.changeFor);
          const changeBack = change - total;
          lines.push(...receiptRow('TROCO PARA:', `R$ ${moneyPlainCol(change)}`, width));
          if (changeBack > 0) {
            lines.push(...receiptRow('TROCO DE:', `R$ ${moneyPlainCol(changeBack)}`, width));
          }
        }
        if (paidOnline) {
          lines.push('PAGO ONLINE');
          lines.push(...receiptWrap(payMethod.toLowerCase().includes('pix') ? 'PIX' : payMethod, width));
        } else {
          lines.push(...receiptLabeled(
            'STATUS PAG.:',
            statusText,
            width
          ));
        }
      }
    }
    lines.push('');
    const footer = String(adminPrefs.receiptFooter || '').trim();
    if (footer) {
      if (adminPrefs.receiptShowSeparators) lines.push(sep);
      lines.push(...receiptWrap(footer, width).map((l) => receiptCenter(l, width)));
      lines.push('');
    }
    return lines.join('\n');
  }

  function buildOrderReceiptHtml(order) {
    const line = (text, cls) => `<div class="rc-line${cls ? ` ${cls}` : ''}">${escapeHtml(text)}</div>`;
    const center = (text) => line(text, 'rc-center');
    const dots = (left, right, cls) =>
      `<div class="rc-dots ${cls}"><span class="rc-left">${escapeHtml(left)}</span><span class="rc-right">${escapeHtml(right)}</span></div>`;
    const separator = () => (adminPrefs.receiptShowSeparators ? '<div class="rc-sep"></div>' : '');

    const addr = parseOrderAddressParts(order);
    const created = parseApiDate(order.createdAtUtc);
    const when = created
      ? created.toLocaleString('pt-BR', {
          timeZone: APP_TIMEZONE,
          day: '2-digit',
          month: '2-digit',
          hour: '2-digit',
          minute: '2-digit'
        }).replace(',', ' às') + 'hs'
      : '—';
    const storeName = storeConfig?.storeName || 'Fabin Lanches';
    const items = Array.isArray(order.items) ? order.items : [];
    const itemsTotal = Number(order.itemsTotal || 0);
    const deliveryFee = orderDeliveryFee(order);
    const total = Number(order.total != null ? order.total : itemsTotal + deliveryFee);
    const payMethod = String(order.paymentMethod || '—');
    const payTiming = String(order.paymentTimingLabel || order.paymentTiming || '');
    const payStatus = String(order.paymentStatus || '').toLowerCase();
    const paidOnline = payStatus === 'confirmed' && /now|agora/i.test(String(order.paymentTiming || payTiming));
    const cityLine = addr.state && addr.city !== '—'
      ? `${addr.city} - ${addr.state}`
      : addr.city;
    const dineIn = String(order.fulfillmentType || '').toLowerCase() === 'dine_in';
    const fulfillment = dineIn
      ? 'MESA'
      : (String(order.fulfillmentType || '').toLowerCase() === 'pickup'
        ? 'RETIRADA'
        : 'ENTREGA');

    const out = [];
    out.push(center(storeName));
    out.push(center(`#${order.orderId || '—'} ${fulfillment}`));
    out.push(center(`Realizado em ${when}.`));
    out.push(separator());
    out.push(line(`NOME: ${order.customerName || '—'}`));
    out.push(line(`TEL.: ${order.customerPhone || '—'}`));
    if (dineIn) {
      out.push(line(`MESA: ${order.tableLabel || '—'}`));
      out.push(line(`${attendantReceiptLabel(order)} ${order.waiterName || '—'}`));
      out.push(line(`ORIGEM: ${orderSourceLabel(order)}`));
    } else if (orderSourceIsStaff(order)) {
      out.push(line(`${attendantReceiptLabel(order)} ${order.waiterName || '—'}`));
      out.push(line(`ORIGEM: ${orderSourceLabel(order)}`));
    }
    if (fulfillment === 'ENTREGA' && adminPrefs.receiptShowAddress) {
      out.push(line(`LOCAL: ${detectResidenceLabel(order)}`));
      out.push(line(`RUA: ${addr.street}${addr.number ? `, ${addr.number}` : ''}`));
      if (addr.reference) out.push(line(`COMP./REF.: ${addr.reference}`));
      out.push(line(`BAIRRO: ${addr.neighborhood}`));
      out.push(line(`CIDADE: ${cityLine}`));
      out.push(line(`CEP: ${addr.cep}`));
    }
    out.push(separator());

    if (!items.length) {
      out.push(line('Sem itens'));
    } else {
      items.forEach((item) => {
        const parts = itemPriceParts(item);
        out.push(dots(`${parts.qty}x ${parts.name || 'Item'}`, `R$ ${moneyPlainCol(parts.base)}`, 'rc-item'));
        parts.addons.forEach((m) => {
          const delta = Number(m.priceDelta) || 0;
          const value = delta > 0 ? `R$ ${moneyPlainCol(delta * parts.qty)}` : 'grátis';
          out.push(dots(`Adic. ${m.name}`, value, 'rc-sub'));
        });
        if (adminPrefs.receiptShowItemNotes) {
          parts.removed.forEach((r) => out.push(dots(`Sem ${r}`, 'grátis', 'rc-sub')));
          if (parts.note) out.push(line(`Obs.: ${parts.note}`, 'rc-sub'));
        }
      });
    }

    const generalNote = String(order.notes || '').trim();
    if (generalNote) {
      out.push(line(`OBS.: ${escapeHtml(generalNote)}`, 'rc-line'));
    }

    out.push(separator());
    out.push(dots('SUB-TOTAL', `R$ ${moneyPlainCol(itemsTotal)}`, 'rc-line'));
    if (fulfillment === 'ENTREGA') {
      out.push(dots('TAXA ENTREGA', `R$ ${moneyPlainCol(deliveryFee)}`, 'rc-line'));
    }
    out.push(dots('TOTAL', `R$ ${moneyPlainCol(total)}`, 'rc-line'));

    if (adminPrefs.receiptShowPayment) {
      out.push(dots('PAGAMENTO:', payMethod, 'rc-pay'));
      const openPay = /^em aberto$/i.test(payMethod);
      if (!openPay) {
        const statusText = order.paymentStatusLabel || payStatus || '—';
        if (payTiming && String(payTiming).trim().toLowerCase() !== String(statusText).trim().toLowerCase()) {
          out.push(line(payTiming, 'rc-pay'));
        }
        if (order.needsChange && order.changeFor != null) {
          const change = Number(order.changeFor);
          const changeBack = change - total;
          out.push(dots('TROCO PARA:', `R$ ${moneyPlainCol(change)}`, 'rc-pay'));
          if (changeBack > 0) out.push(dots('TROCO DE:', `R$ ${moneyPlainCol(changeBack)}`, 'rc-pay'));
        }
        if (paidOnline) {
          out.push(line('PAGO ONLINE', 'rc-pay'));
          out.push(line(payMethod.toLowerCase().includes('pix') ? 'PIX' : payMethod, 'rc-pay'));
        } else {
          out.push(line(`STATUS PAG.: ${statusText}`, 'rc-pay'));
        }
      }
    }

    const footer = String(adminPrefs.receiptFooter || '').trim();
    if (footer) {
      out.push(separator());
      out.push(center(footer));
    }
    return `<div class="rc-plain">${out.join('')}</div>`;
  }

  /** Fonte da impressão/preview: automática para caber "chars" na área imprimível (margem fixa de 2mm). */
  function getReceiptPrintFontSize(mm) {
    const paper = Number(mm) || 80;
    const chars = getReceiptCharWidth(String(mm));
    // Área útil (mm) = papel − 2×margem (2mm); em px (96dpi = 3.7795px/mm).
    // Largura média de caractere monoespaçada ≈ 0.60em (Consolas ~0.55em, Courier New ~0.60em).
    // Arredonda para 1 decimal.
    const usablePx = (paper - 4) * 3.7795;
    const px = Math.floor((usablePx / (0.60 * chars)) * 10) / 10;
    return Math.min(18, Math.max(8, px));
  }

  function getReceiptZoomFactor() {
    const z = Number(adminPrefs.receiptZoom);
    return Number.isFinite(z) && z > 0 ? z / 100 : 1;
  }

  /** Fonte da impressão/preview considerando o zoom configurado. */
  function getReceiptFontSizePx(mm) {
    return Math.round(getReceiptPrintFontSize(mm) * getReceiptZoomFactor() * 10) / 10;
  }

  function applyReceiptWidth(mm) {
    const preview = $('receiptPreview');
    if (!preview) return;
    const width = mm === '58' ? '58' : '80';
    preview.classList.toggle('receipt-w-80', width === '80');
    preview.classList.toggle('receipt-w-58', width === '58');
    preview.style.fontSize = `${getReceiptFontSizePx(width)}px`;
    preview.style.fontWeight = adminPrefs.receiptBold ? '700' : '400';
    preview.style.lineHeight = String(adminPrefs.receiptLineHeight || 1.35);
  }

  function closeReceiptModal() {
    const modal = $('receiptModal');
    if (modal) modal.hidden = true;
    receiptPreviewOrder = null;
  }

  function openOrderReceiptPreview(order) {
    if (!order || !canSeeOrders()) return;
    receiptPreviewOrder = order;
    const modal = $('receiptModal');
    const preview = $('receiptPreview');
    const widthSelect = $('receiptWidthSelect');
    if (!modal || !preview) return;
    const mm = getReceiptWidthMm();
    if (widthSelect) widthSelect.value = mm;
    applyReceiptWidth(mm);
    preview.innerHTML = buildOrderReceiptHtml(order);
    modal.hidden = false;
  }

  async function copyOrderReceiptText(order) {
    const target = order || receiptPreviewOrder;
    if (!target) return;
    const text = buildOrderReceiptPlainText(target);
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      showAppToast('Texto do cupom copiado.');
    } catch (err) {
      showAppToast(err.message || 'Não foi possível copiar.');
    }
  }

  function isEscposSupported() {
    return typeof EscPosPrinter !== 'undefined' && EscPosPrinter.isSupported();
  }

  function isSerialSupported() {
    return typeof SerialPosPrinter !== 'undefined' && SerialPosPrinter.isSupported();
  }

  function validReceiptMode() {
    const mode = adminPrefs.receiptPrinterMode;
    return (mode === 'serial' || mode === 'usb' || mode === 'windows') ? mode : 'windows';
  }

  function directModeSupported(mode) {
    return mode === 'serial' ? isSerialSupported() : isEscposSupported();
  }

  function directModeUnsupportedMessage(mode) {
    return mode === 'serial'
      ? 'Porta serial indisponível: use Chrome/Edge com HTTPS ou localhost.'
      : 'Impressão direta indisponível: use Chrome/Edge com HTTPS ou localhost.';
  }

  function updateReceiptEscposUi() {
    const btn = $('receiptEscposBtn');
    if (btn) btn.hidden = !directModeSupported(validReceiptMode());
    const hint = $('receiptEscposHint');
    if (hint) hint.hidden = (validReceiptMode() === 'serial') ? isSerialSupported() : isEscposSupported();
  }

  function escposReceiptOptions() {
    const mm = getReceiptWidthMm();
    // Largura máxima segura por papel: 58mm ≈ 32 colunas, 80mm ≈ 42 colunas.
    // Valores acima disso fazem a impressora cortar a coluna da direita (o valor).
    const maxForWidth = mm === '58' ? 32 : 42;
    const chars = adminPrefs.receiptEscposChars > 0
      ? Math.min(maxForWidth, adminPrefs.receiptEscposChars)
      : getReceiptCharWidth(mm);
    return { mm, chars };
  }

  async function escposPrintOrder(order, { successToast } = {}) {
    const target = order || receiptPreviewOrder;
    if (!target) return;
    if (order) receiptPreviewOrder = order;
    const res = (validReceiptMode() === 'serial')
      ? await directPrintSerial(target)
      : await directPrintUsb(target);
    if (res && res.error) {
      showAppToast(res.error);
      return;
    }
    showAppToast(successToast || 'Cupom enviado para a impressora.');
  }

  function receiptHasUsableLines(lines) {
    return Array.isArray(lines) && lines.some((l) => String(l || '').replace(/\s/g, '').length > 0);
  }

  async function directPrintUsb(target) {
    if (!isEscposSupported()) {
      return { error: directModeUnsupportedMessage('usb') };
    }
    const { mm, chars } = escposReceiptOptions();
    const text = padReceiptLinesToWidth(asciiReceiptText(buildOrderReceiptPlainText(deepAscii(target), mm, chars)), chars);
    const lines = text.split('\n').map((l) => l.slice(0, chars));
    if (!receiptHasUsableLines(lines)) return { error: 'Cupom vazio — impressão cancelada.' };
    const saved = (typeof EscPosPrinter !== 'undefined')
      ? EscPosPrinter.normalizeSaved(adminPrefs.receiptUsbDevice)
      : null;
    let device = null;
    let picked = null;
    try {
      device = await EscPosPrinter.getSavedDevice(saved);
    } catch (_) { /* ignore */ }
    if (!device) {
      const res = await EscPosPrinter.pickDevice(saved);
      if (res.error) return { error: res.error };
      device = res.device;
      picked = res.saved;
    }
    try {
      const handle = await EscPosPrinter.openDevice(device);
      const bytes = EscPosPrinter.buildBytes(lines, {
        bold: !!adminPrefs.receiptBold,
        feedLines: 3,
        cut: false
      });
      await EscPosPrinter.writeAll(handle, bytes);
      await EscPosPrinter.closeDevice(handle);
    } catch (err) {
      try { await device.close(); } catch (_) { /* ignore */ }
      return { error: escposAccessErrorHint(err) };
    }
    if (picked) {
      saveAdminPrefs({ receiptUsbDevice: picked });
    }
    return {};
  }

  async function directPrintSerial(target) {
    if (!isSerialSupported()) {
      return { error: directModeUnsupportedMessage('serial') };
    }
    const { mm, chars } = escposReceiptOptions();
    const text = padReceiptLinesToWidth(asciiReceiptText(buildOrderReceiptPlainText(deepAscii(target), mm, chars)), chars);
    const lines = text.split('\n').map((l) => l.slice(0, chars));
    if (!receiptHasUsableLines(lines)) return { error: 'Cupom vazio — impressão cancelada.' };
    const saved = SerialPosPrinter.normalizeSaved(adminPrefs.receiptSerialPort);
    let port = null;
    let picked = null;
    try {
      port = await SerialPosPrinter.getSavedPort(saved);
    } catch (_) { /* ignore */ }
    if (!port) {
      const res = await SerialPosPrinter.pickPort(saved);
      if (res.error) return { error: res.error };
      port = res.port;
      picked = res.saved;
    }
    let handle;
    try {
      handle = await SerialPosPrinter.openPort(port, adminPrefs.receiptSerialBaud);
      const bytes = EscPosPrinter.buildBytes(lines, {
        bold: !!adminPrefs.receiptBold,
        feedLines: 3,
        cut: false
      });
      await SerialPosPrinter.writeBytes(handle, bytes);
    } catch (err) {
      if (handle) await SerialPosPrinter.closePort(handle);
      return { error: escposAccessErrorHint(err) };
    }
    await SerialPosPrinter.closePort(handle);
    if (picked) {
      saveAdminPrefs({ receiptSerialPort: picked });
    }
    return {};
  }

  function setReceiptTestStatus(msg, ok) {
    const el = $('receiptTestStatus');
    if (!el) return;
    el.textContent = msg ? `${ok === false ? '✕ ' : ok === true ? '✔ ' : ''}${msg}` : '';
    el.className = 'muted' + (ok === false ? ' receipt-test-err' : ok === true ? ' receipt-test-ok' : '');
  }

  function refreshReceiptTestState() {
    const mode = validReceiptMode();
    const supported = mode === 'windows' || directModeSupported(mode);
    const savedUsb = (typeof EscPosPrinter !== 'undefined')
      ? EscPosPrinter.normalizeSaved(adminPrefs.receiptUsbDevice)
      : null;
    const savedSerial = (typeof SerialPosPrinter !== 'undefined')
      ? SerialPosPrinter.normalizeSaved(adminPrefs.receiptSerialPort)
      : null;
    const saved = mode === 'serial' ? savedSerial : savedUsb;
    const testBtn = $('receiptTestBtn');
    const pickBtn = $('receiptTestPickBtn');
    const printBtn = $('receiptTestPrintBtn');
    if (!testBtn || !pickBtn || !printBtn) return;
    if (mode === 'windows') {
      pickBtn.hidden = true;
      printBtn.hidden = true;
      testBtn.disabled = false;
      refreshReceiptPrinterSelect();
      setReceiptTestStatus('Impressão via Windows (diálogo padrão). Use "Imprimir teste" ou "Imprimir via Windows" para confirmar.', true);
      return;
    }
    if (!supported) {
      pickBtn.hidden = true;
      printBtn.hidden = true;
      testBtn.disabled = true;
      setReceiptTestStatus(directModeUnsupportedMessage(mode), false);
      return;
    }
    testBtn.disabled = false;
    pickBtn.hidden = saved ? true : false;
    printBtn.hidden = !saved;
    refreshReceiptPrinterSelect();
    if (saved) {
      setReceiptTestStatus(mode === 'serial'
        ? `Porta serial pareada (VID ${saved.usbVendorId} · PID ${saved.usbProductId}).`
        : `Impressora pareada (VID ${saved.vendorId} · PID ${saved.productId}${saved.serialNumber ? ' · S/N ' + saved.serialNumber : ''}).`, true);
    } else {
      setReceiptTestStatus(mode === 'serial'
        ? 'Nenhuma porta pareada. Clique em "Selecionar porta" para conectar.'
        : 'Nenhuma impressora pareada. Clique em "Selecionar impressora" para conectar.', false);
    }
  }

  function refreshReceiptPrinterSelect() {
    const sel = $('receiptPrinterSelect');
    const info = $('receiptPrinterInfo');
    if (!sel) return;
    const mode = validReceiptMode();
    sel.value = mode;
    const serialOptions = $('receiptSerialOptions');
    if (serialOptions) serialOptions.hidden = mode !== 'serial';
    const serialPickBtn = $('receiptSerialPickBtn');
    const serialInfo = $('receiptSerialDeviceInfo');
    const serialSaved = (typeof SerialPosPrinter !== 'undefined')
      ? SerialPosPrinter.normalizeSaved(adminPrefs.receiptSerialPort)
      : null;
    if (serialPickBtn) serialPickBtn.hidden = !!serialSaved;
    if (serialInfo) {
      serialInfo.textContent = mode === 'serial'
        ? (serialSaved
          ? `Porta pareada (VID ${serialSaved.usbVendorId} · PID ${serialSaved.usbProductId}).`
          : '')
        : '';
    }
    if (!info) return;
    if (mode === 'serial') {
      info.textContent = serialSaved
        ? `ESC/POS via porta serial — porta pareada (VID ${serialSaved.usbVendorId} · PID ${serialSaved.usbProductId}).`
        : 'ESC/POS via porta serial (USB/COM ou Bluetooth) — nenhuma porta pareada. Clique em "Selecionar porta" para conectar.';
      return;
    }
    if (mode === 'windows') {
      info.textContent = 'A impressora instalada/configurada no Windows aparece no diálogo do navegador ao imprimir.';
      return;
    }
    const saved = (typeof EscPosPrinter !== 'undefined')
      ? EscPosPrinter.normalizeSaved(adminPrefs.receiptUsbDevice)
      : null;
    info.textContent = saved
      ? `ESC/POS direto — impressora pareada (VID ${saved.vendorId} · PID ${saved.productId}${saved.serialNumber ? ' · S/N ' + saved.serialNumber : ''}).`
      : 'ESC/POS direto — nenhuma impressora USB pareada. Use "Selecionar impressora" abaixo para conectar.';
  }

  async function pickSerialPrinter() {
    if (!isSerialSupported()) {
      setReceiptTestStatus('Porta serial indisponível — use Chrome/Edge com localhost ou HTTPS.', false);
      return false;
    }
    setReceiptTestStatus('Selecione a porta na janela do navegador…');
    const saved = SerialPosPrinter.normalizeSaved(adminPrefs.receiptSerialPort);
    const res = await SerialPosPrinter.pickPort(saved);
    if (res.error) {
      setReceiptTestStatus(res.error, false);
      return false;
    }
    // Parear já ativa o modo serial: as próximas impressões usam a porta sem perguntar de novo.
    saveAdminPrefs({ receiptSerialPort: res.saved, receiptPrinterMode: 'serial', receiptEscpos: true });
    if ($('receiptPrinterSelect')) $('receiptPrinterSelect').value = 'serial';
    if ($('receiptSerialBaud')) applyAdminPrefsToForm();
    if ($('receiptEscpos')) $('receiptEscpos').checked = true;
    setReceiptTestStatus('Porta serial selecionada e ativada. Clique em "Testar comunicação" para verificar.', true);
    refreshReceiptTestState();
    return true;
  }

  async function pickReceiptPrinter() {
    if (validReceiptMode() === 'serial') return pickSerialPrinter();
    if (!isEscposSupported()) {
      setReceiptTestStatus('WebUSB indisponível — use Chrome/Edge com localhost ou HTTPS.', false);
      return false;
    }
    setReceiptTestStatus('Selecione a impressora na janela do navegador…');
    const saved = (typeof EscPosPrinter !== 'undefined')
      ? EscPosPrinter.normalizeSaved(adminPrefs.receiptUsbDevice)
      : null;
    const res = await EscPosPrinter.pickDevice(saved);
    if (res.error) {
      setReceiptTestStatus(res.error, false);
      return false;
    }
    // Parear já ativa o modo USB direto: as próximas impressões não abrem diálogo do Windows.
    saveAdminPrefs({ receiptUsbDevice: res.saved, receiptPrinterMode: 'usb', receiptEscpos: true });
    if ($('receiptPrinterSelect')) $('receiptPrinterSelect').value = 'usb';
    if ($('receiptEscpos')) $('receiptEscpos').checked = true;
    setReceiptTestStatus('Impressora selecionada e ativada. Clique em "Testar comunicação" para verificar.', true);
    refreshReceiptTestState();
    return true;
  }

  async function acquireReceiptTestDevice() {
    const saved = (typeof EscPosPrinter !== 'undefined')
      ? EscPosPrinter.normalizeSaved(adminPrefs.receiptUsbDevice)
      : null;
    let device = null;
    try {
      device = await EscPosPrinter.getSavedDevice(saved);
    } catch (_) { /* ignore */ }
    if (!device) {
      const res = await EscPosPrinter.pickDevice(saved);
      if (res.error) return { error: res.error };
      device = res.device;
      if (res.saved) saveAdminPrefs({ receiptUsbDevice: res.saved });
    }
    return { device: device };
  }

  async function acquireReceiptTestSerialPort() {
    const saved = (typeof SerialPosPrinter !== 'undefined')
      ? SerialPosPrinter.normalizeSaved(adminPrefs.receiptSerialPort)
      : null;
    let port = null;
    try {
      port = await SerialPosPrinter.getSavedPort(saved);
    } catch (_) { /* ignore */ }
    if (!port) {
      const res = await SerialPosPrinter.pickPort(saved);
      if (res.error) return { error: res.error };
      port = res.port;
      if (res.saved) saveAdminPrefs({ receiptSerialPort: res.saved });
    }
    return { port: port };
  }

  async function testReceiptCommunication() {
    const mode = validReceiptMode();
    if (mode === 'windows') {
      setReceiptTestStatus('Impressão via Windows (diálogo padrão). Use "Imprimir teste" para testar com o navegador.', true);
      return;
    }
    if (!directModeSupported(mode)) {
      setReceiptTestStatus(directModeUnsupportedMessage(mode), false);
      return;
    }
    const btn = $('receiptTestBtn');
    if (btn) btn.disabled = true;
    setReceiptTestStatus('Testando comunicação…');
    try {
      if (mode === 'serial') {
        const res = await acquireReceiptTestSerialPort();
        if (!res.port || res.error) {
          setReceiptTestStatus(res.error || 'Nenhuma porta disponível.', false);
          return;
        }
        let handle;
        try {
          handle = await SerialPosPrinter.openPort(res.port, adminPrefs.receiptSerialBaud);
        } finally {
          if (handle) await SerialPosPrinter.closePort(handle);
        }
      } else {
        const res = await acquireReceiptTestDevice();
        if (!res.device || res.error) {
          setReceiptTestStatus(res.error || 'Nenhuma impressora disponível.', false);
          return;
        }
        let handle;
        try {
          handle = await EscPosPrinter.openDevice(res.device);
        } finally {
          if (handle) await EscPosPrinter.closeDevice(handle);
        }
      }
      setReceiptTestStatus('Comunicação OK. A impressora respondeu ao teste.', true);
      refreshReceiptTestState();
    } catch (err) {
      setReceiptTestStatus(escposAccessErrorHint(err), false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  async function printReceiptTest() {
    const mode = validReceiptMode();
    if (mode === 'windows') {
      printReceiptViaWindowsTest();
      return;
    }
    if (!directModeSupported(mode)) {
      setReceiptTestStatus(directModeUnsupportedMessage(mode), false);
      return;
    }
    const btn = $('receiptTestPrintBtn');
    if (btn) btn.disabled = true;
    setReceiptTestStatus('Enviando teste de impressão…');
    const testLines = ['FABIN - Teste de comunicacao', 'Se imprimiu, esta funcionando.'];
    try {
      if (mode === 'serial') {
        const res = await acquireReceiptTestSerialPort();
        if (!res.port || res.error) {
          setReceiptTestStatus(res.error || 'Nenhuma porta disponível.', false);
          return;
        }
        const handle = await SerialPosPrinter.openPort(res.port, adminPrefs.receiptSerialBaud);
        try {
          const bytes = EscPosPrinter.buildBytes(testLines, { bold: true, feedLines: 3, cut: false });
          await SerialPosPrinter.writeBytes(handle, bytes);
        } finally {
          await SerialPosPrinter.closePort(handle);
        }
      } else {
        const res = await acquireReceiptTestDevice();
        if (!res.device || res.error) {
          setReceiptTestStatus(res.error || 'Nenhuma impressora disponível.', false);
          return;
        }
        const handle = await EscPosPrinter.openDevice(res.device);
        try {
          const bytes = EscPosPrinter.buildBytes(testLines, { bold: true, feedLines: 3, cut: false });
          await EscPosPrinter.writeAll(handle, bytes);
        } finally {
          await EscPosPrinter.closeDevice(handle);
        }
      }
      setReceiptTestStatus('Teste de impressão enviado. Verifique o papel.', true);
      adminPrefs.receiptEscpos = true;
      saveAdminPrefs({ receiptEscpos: true });
    } catch (err) {
      setReceiptTestStatus(escposAccessErrorHint(err), false);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function escposAccessErrorHint(err) {
    const msg = err && err.message ? String(err.message) : '';
    if (/access denied|securityerror/i.test(msg)) {
      return 'Falha ao acessar a impressora (' + msg + '). O Windows ou outro programa está usando a interface USB dela. ' +
        'Se ela aparecer como porta serial no Windows (ex.: COM5), troque para "Porta serial (USB/COM ou Bluetooth)" nas Configurações de Impressão e clique em "Selecionar porta". ' +
        'Se estiver instalada como impressora do Windows, desmarque "Imprimir direto na térmica (ESC/POS)" e use o botão "Imprimir" do cupom (ou "Imprimir via Windows"). ' +
        'Senão: feche apps que usem a impressora (cupom/NF, programa do fabricante), troque a porta USB ou reconecte o cabo, e tente de novo. Se for um driver COM antigo, desinstale o dispositivo no Gerenciador de Dispositivos e reconecte o cabo.';
    }
    return msg || 'Falha na comunicação com a impressora.';
  }

  function printReceiptViaWindowsTest() {
    const mm = getReceiptWidthMm();
    const content = [
      'FABIN - IMPRESSAO VIA WINDOWS',
      '',
      'Se esta impressora apareceu no',
      'dialogo e imprimiu, a configuracao',
      'do Windows esta OK.',
      '',
      'Largura selecionada: ' + mm + ' mm'
    ].map((l) => `<div class="rc-line">${escapeHtml(l)}</div>`).join('');
    const html =
      `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8" />` +
      `<title>Teste de impressão — selecione a impressora</title>` +
      `<style>` +
      `@page { size: ${mm}mm auto; margin: 0; }` +
      `html, body { margin: 0; padding: 0; background: #fff; }` +
      `.receipt-preview { width: ${mm}mm; max-width: 100%; margin: 0 auto; box-sizing: border-box; padding: 2mm; font-family: Consolas, "Lucida Console", "Courier New", monospace; font-size: ${getReceiptFontSizePx(mm)}px; line-height: 1.35; color: #000; white-space: pre-wrap; }` +
      `@media print { button, header, footer, nav { display: none !important; } }` +
      `</style></head><body><div class="receipt-preview">${content}</div></body></html>`;
    const iframe = document.createElement('iframe');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(iframe);
    iframe.srcdoc = html;
    iframe.onload = () => {
      setTimeout(() => {
        try { iframe.contentWindow.focus(); iframe.contentWindow.print(); } catch (_) { /* ignore */ }
      }, 0);
    };
    setTimeout(() => { try { iframe.remove(); } catch (_) { /* ignore */ } }, 60000);
    showAppToast('Diálogo de impressão aberto — selecione a impressora configurada no Windows.');
  }

  function printOrderReceipt({ pdfHint, order, mesaAuto } = {}) {
    const target = order || receiptPreviewOrder;
    if (!target) return;
    if (order) receiptPreviewOrder = order;
    if (!pdfHint && adminPrefs.receiptEscpos) {
      escposPrintOrder(target, { successToast: mesaAuto ? `Cupom da mesa ${target.orderId || ''} — enviado.` : undefined })
        .catch((e) => showAppToast(e && e.message ? e.message : 'Falha na impressão direta.'));
      return;
    }
    const mm = getReceiptWidthMm();
    saveAdminPrefs({ receiptWidthMm: mm });
    const bodyHtml = buildOrderReceiptHtml(target);
    const title = pdfHint
      ? `Cupom ${target.orderId || ''} — Salvar como PDF`.trim()
      : `Cupom ${target.orderId || ''}`.trim();
    const html =
      `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="utf-8" />` +
      `<title>${escapeHtml(title)}</title>` +
      `<style>` +
      `@page { size: ${mm}mm auto; margin: 0; }` +
      `html, body { margin: 0; padding: 0; background: #fff; }` +
      `@media print { button, .no-print, [data-receipt-print], header, footer, nav { display: none !important; } }` +
      `.receipt-preview {` +
      `  width: ${mm}mm; max-width: 100%; margin: 0 auto; box-sizing: border-box; padding: 2mm;` +
      `  font-family: Consolas, "Lucida Console", "Courier New", monospace;` +
      `  font-size: ${getReceiptFontSizePx(mm)}px; font-weight: ${adminPrefs.receiptBold ? '700' : '400'}; line-height: ${adminPrefs.receiptLineHeight || 1.35}; color: #000;` +
      `  word-break: break-word; white-space: pre-wrap;` +
      `  -webkit-print-color-adjust: exact; print-color-adjust: exact;` +
      `}` +
      `.rc-center { text-align: center; } .rc-strong { font-weight: 700; }` +
      `.rc-line { display: block; white-space: pre-wrap; }` +
      `.rc-plain { margin: 0; white-space: normal; word-break: break-word; overflow-wrap: anywhere; }` +
      `.rc-item, .rc-pay { display: block; font-size: 1.15em; }` +
      `.rc-sep { display: block; margin: 0.45rem 0; border: none; white-space: pre; overflow: hidden; line-height: 1; }` +
      `.rc-sep::after { content: "${'-'.repeat(getReceiptCharWidth(mm))}"; }` +
      `.rc-dots { display: flex; justify-content: space-between; gap: 0.35rem; align-items: baseline; }` +
      `.rc-dots.rc-item { margin-bottom: 0.3rem; }` +
      `.rc-dots .rc-left { flex: 1; min-width: 0; white-space: normal; word-break: break-word; }` +
      `.rc-dots .rc-fill { flex: 1; min-width: 0.5rem; overflow: hidden; white-space: pre; }` +
      `.rc-dots .rc-fill::after { content: "................................................................"; }` +
      `.rc-right { white-space: nowrap; flex-shrink: 0; font-variant-numeric: tabular-nums; }` +
      `.rc-box { border: 1px solid #000; padding: 0.3rem 0.35rem; margin-top: 0.4rem; }` +
      `.rc-sub { padding-left: 0.5rem; font-size: 0.92em; }` +
      `</style></head><body>` +
      `<div class="receipt-preview">${bodyHtml}</div>` +
      `</body></html>`;

    // Imprime via iframe oculto (sem window.open — evita falso positivo de bloqueio de pop-up).
    // O iframe precisa ter tamanho real (0×0 falha em alguns navegadores) e o print só roda
    // depois que o conteúdo termina de renderizar — impressão prematura gera "falhas" no cupom.
    let frame = document.getElementById('receiptPrintFrame');
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'receiptPrintFrame';
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('tabindex', '-1');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:320px;height:640px;border:0;';
      document.body.appendChild(frame);
    }

    try {
      const doc = frame.contentDocument || frame.contentWindow?.document;
      if (!doc) throw new Error('iframe indisponível');
      doc.open();
      doc.write(html);
      doc.close();
      const win = frame.contentWindow;
      if (!win) throw new Error('janela indisponível');

      let printed = false;
      const doPrint = () => {
        if (printed) return;
        printed = true;
        try {
          win.focus();
          win.print();
        } catch (_) {
          showAppToast('Não foi possível abrir a impressão. Tente copiar o texto.');
        }
      };
      const isReady = () => {
        try {
          const d = frame.contentDocument;
          return !!d && d.readyState === 'complete' && !!d.body && !!d.body.firstChild;
        } catch (_) {
          return false;
        }
      };
      let tries = 0;
      const waitAndPrint = () => {
        if (isReady() || tries >= 20) {
          doPrint();
          return;
        }
        tries += 1;
        setTimeout(waitAndPrint, 50);
      };
      setTimeout(waitAndPrint, 60);
    } catch (err) {
      console.error(err);
      showAppToast('Não foi possível abrir a impressão. Tente copiar o texto.');
    }
  }

  function renderOrdersBoard(justArrivedIds) {
    const board = $('ordersBoard');
    if (!board) return;
    // Se a aba ativa ficou sem itens (contagem 0) e não é sempre-visível, volta para "Created".
    ensureActiveFilterVisible();
    board.innerHTML = '';
    updateOrderFilterCounts();
    const arrived = justArrivedIds instanceof Set ? justArrivedIds : new Set();
    const list = filteredOrders();
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'orders-empty';
      if (orderFilter === 'Created') {
        empty.textContent = 'Nenhum pedido no momento.';
      } else if (orderFilter === 'Delivered') {
        empty.textContent = 'Nenhum pedido finalizado hoje.';
      } else if (orderFilter === 'Cancelled') {
        empty.textContent = 'Nenhum pedido cancelado hoje.';
      } else if (orderFilter === 'overdue') {
        empty.textContent = 'Nenhum pedido em atraso ou prazo crítico.';
      } else if (orderFilter === 'deliveredDineIn') {
        empty.textContent = 'Nenhum pedido entregue em mesa ocupada.';
      } else if (orderFilter === 'all') {
        empty.textContent = 'Nenhum pedido hoje.';
      } else {
        empty.textContent = 'Nenhum pedido neste filtro.';
      }
      board.appendChild(empty);
      return;
    }

    list.forEach((order) => {
      const card = document.createElement('article');
      const isNew = order.status === 'Created';
      const isAcceptedAlert = order.status === 'Accepted';
      const isPreparingAlert = order.status === 'Preparing';
      const isSlaDanger = isOrderNearDeliveryLimit(order);
      const isSlaWarn = !isSlaDanger && isOrderSlaWarn(order);
      const justArrived = arrived.has(order.orderId);
      card.className = [
        'order-card',
        isNew ? 'is-new' : '',
        isAcceptedAlert ? 'is-accepted-alert' : '',
        isPreparingAlert ? 'is-preparing-alert' : '',
        order.customerReceived ? 'has-customer-received' : '',
        isSlaDanger ? 'is-sla-danger' : '',
        isSlaWarn ? 'is-sla-warn' : '',
        justArrived ? 'just-arrived' : ''
      ].filter(Boolean).join(' ');
      card.dataset.orderId = order.orderId;

      const slaLabel = isKitchenOrderStatus(order.status) && getAverageDeliveryMinutes()
        ? `<div class="order-sla${isSlaDanger ? ' danger' : (isSlaWarn ? ' warn' : '')}">Prazo: ${escapeHtml(formatSlaLabel(order))}</div>`
        : '';

      const itemsHtml = (order.items || []).map((item) => {
        const parsed = splitItemCustomization(item.name);
        const detailHtml = itemCustomizationHtml(item);
        return (
          `<li class="${detailHtml ? 'has-note' : ''}">` +
          `<div class="item-main"><span>${escapeHtml(item.quantity)}× ${escapeHtml(parsed.name)}</span>` +
          `<span>${money(item.price * item.quantity)}</span></div>` +
          detailHtml +
          `</li>`
        );
      }).join('') || '<li><span class="muted">Sem itens</span></li>';

      const notes = order.notes
        ? `<div class="order-alert order-notes" role="alert">` +
          `<strong>Observação do pedido</strong>` +
          `<span>${escapeHtml(order.notes)}</span>` +
          `</div>`
        : '';
      const cancelledInfo = order.status === 'Cancelled'
        ? `<div class="order-alert order-cancelled" role="status">` +
          `<strong>Pedido cancelado</strong>` +
          `<span>${escapeHtml(order.cancellationReason || 'Sem motivo informado')}` +
          (order.cancellationCustomerRequested ? ' · A pedido do cliente' : ' · Iniciativa da loja') +
          `</span></div>`
        : '';
      const pickupInfo = isPickupOrder(order)
        ? `<div class="order-alert order-pickup" role="status">` +
          `<strong>Retirada no local</strong>` +
          (isBalcaoOrder(order)
            ? `<span>Origem: ${escapeHtml(orderSourceLabel(order))}</span>`
            : `<span>${escapeHtml(order.address || 'Cliente retira na loja')}</span>`) +
          `</div>`
        : '';
      const dineInInfo = isDineInOrder(order)
        ? `<div class="order-alert order-dine-in" role="status">` +
          `<strong>Consumo no local · ${escapeHtml(order.tableLabel || '—')}</strong>` +
          `<span>` +
          (order.waiterName
            ? `Garçom: ${escapeHtml(order.waiterName)}`
            : (order.orderSource === 'customer_qr' ? 'Pedido pelo QR Code' : 'Pedido de mesa')) +
          `</span>` +
          `</div>`
        : '';
      const customerReceived = order.customerReceived
        ? `<div class="order-alert order-customer-received" role="status">` +
          `<strong>Cliente confirmou o recebimento</strong>` +
          `<span>Confirme o pagamento e finalize o pedido quando estiver tudo certo.</span>` +
          `</div>`
        : '';
      const itemsUpdatedInfo = order.itemsUpdatedAtUtc
        ? `<div class="order-alert order-items-updated" role="status">` +
          `<strong>Itens alterados pelo atendimento</strong>` +
          `<span>${escapeHtml(order.itemsChangeSummary || 'Lista de itens atualizada.')}` +
          `<br><small class="muted">${escapeHtml(formatDateTime(order.itemsUpdatedAtUtc))}</small>` +
          `</span></div>`
        : '';
      const rawReference = String(order.reference || '').trim();
      const referenceDisplay = rawReference && isDineInOrder(order)
        ? rawReference.replace(/^(mesa\s+)+mesa\s+/i, 'Mesa ')
        : rawReference;
      const reference = referenceDisplay
        ? `<div><dt>Referência</dt><dd>${escapeHtml(referenceDisplay)}</dd></div>`
        : '';
      const payStatusText = order.paymentStatusLabel || '—';
      const showPayTiming = order.paymentTimingLabel &&
        String(order.paymentTimingLabel).trim().toLowerCase() !== String(payStatusText).trim().toLowerCase();
      // "Em Aberto" (pedido de garçom/mesa): pagamento só se resolve no fechamento da mesa,
      // então não exibe timing/status de pagamento (que viriam como "Pagar na entrega").
      const payExtra = /^em aberto$/i.test(String(order.paymentMethod || ''))
        ? ''
        : `<br><small>${showPayTiming ? escapeHtml(order.paymentTimingLabel || '') : ''}</small>` +
          (order.needsChange && order.changeFor != null
            ? `<br><small>Troco para: ${money(Number(order.changeFor))}` +
              (Number(order.changeFor) - Number(order.total) > 0
                ? ` · troco de: ${money(Number(order.changeFor) - Number(order.total))}`
                : '') +
              `</small>`
            : '') +
          `<br><span class="pay-status pay-${escapeHtml(order.paymentStatus || '')}">${escapeHtml(payStatusText)}</span>`;

      card.innerHTML =
        `<div class="order-card-top">` +
        `<div><div class="order-id">${escapeHtml(order.orderId)}</div>` +
        `<div class="order-time">${formatDateTime(order.createdAtUtc)}</div>` +
        slaLabel +
        `</div>` +
        `<div class="order-card-top-right">` +
        `<span class="status-badge status-${escapeHtml(order.status)}">${escapeHtml(order.statusLabel || order.status)}</span>` +
        `<span class="order-origin">${escapeHtml(orderSourceLabel(order))}</span>` +
        `</div>` +
        `</div>` +
        cancelledInfo +
        pickupInfo +
        dineInInfo +
        customerReceived +
        itemsUpdatedInfo +
        notes +
        `<dl class="order-grid">` +
        `<div><dt>Cliente</dt><dd>${escapeHtml(order.customerName)}<br><small>${escapeHtml(order.customerPhone)}</small></dd></div>` +
        (!isBalcaoOrder(order)
          ? `<div><dt>${isDineInOrder(order) ? 'Mesa' : 'Bairro'}</dt><dd>${isDineInOrder(order) ? escapeHtml(order.tableLabel || '—') : escapeHtml(order.neighborhood || '—')}</dd></div>`
          : '') +
        `<div><dt>Pagamento</dt><dd>${escapeHtml(order.paymentMethod || '—')}${payExtra}</dd></div>` +
        (!isBalcaoOrder(order)
          ? `<div>${isDineInOrder(order)
            ? `<dt>Observação</dt><dd>${escapeHtml(order.notes || '—')}</dd>`
            : `<dt>Endereço</dt><dd>${escapeHtml(order.address || '—')}</dd>`}</div>`
          : '') +
        reference +
        `</dl>` +
        `<ul class="order-items">${itemsHtml}</ul>` +
        `<div class="order-footer">` +
        `<div class="order-total">${money(order.total)}` +
        `<small class="muted"> · itens ${money(order.itemsTotal)}` +
        (isDineInOrder(order) ? '' : ` + entrega ${money(orderDeliveryFee(order))}`) +
        `</small></div>` +
        `<div class="item-actions" data-actions></div>` +
        `</div>`;

      const actions = card.querySelector('[data-actions]');
      if (canSeeOrders()) {
        const printBtn = document.createElement('button');
        printBtn.type = 'button';
        printBtn.className = 'ghost compact receipt-print-btn';
        printBtn.title = 'Imprimir cupom ECF direto';
        printBtn.setAttribute('aria-label', `Imprimir cupom do pedido ${order.orderId}`);
        printBtn.textContent = 'Imprimir';
        printBtn.addEventListener('click', () => printOrderReceipt({ order }));
        actions.appendChild(printBtn);

        const previewBtn = document.createElement('button');
        previewBtn.type = 'button';
        previewBtn.className = 'ghost compact';
        previewBtn.title = 'Prévia do cupom';
        previewBtn.textContent = 'Prévia';
        previewBtn.addEventListener('click', () => openOrderReceiptPreview(order));
        actions.appendChild(previewBtn);
      }

      if (canEditOrderItems(order)) {
        const editItemsBtn = document.createElement('button');
        editItemsBtn.type = 'button';
        editItemsBtn.className = 'confirm compact';
        editItemsBtn.textContent = 'Alterar itens';
        editItemsBtn.title = 'Atualizar itens do pedido';
        editItemsBtn.addEventListener('click', () =>
          editOrderItems(order).catch((e) => showAppToast(e.message || 'Erro')));
        actions.appendChild(editItemsBtn);
      }

      // Pagamento só após confirmar o pedido (não em Aguardando Confirmação).
      // "Em Aberto" de mesa se resolve no fechamento da mesa; Balcão/Delivery/Telefone
      // (fora do dine-in) confirmam o recebimento do pagamento no card.
      if (
        order.status !== 'Created'
        && canCancelOrder(order)
        && !canMarkOrderDelivered(order)
        && !(isDineInOrder(order) && /^em aberto$/i.test(String(order.paymentMethod || '')))
      ) {
        const confirmPay = document.createElement('button');
        confirmPay.type = 'button';
        confirmPay.className = 'confirm compact';
        confirmPay.textContent = order.paymentStatus === 'on_delivery'
          ? 'Pagamento recebido'
          : 'Confirmar pagamento';
        confirmPay.addEventListener('click', () =>
          confirmOrderPaymentReceived(order).catch((e) => showAppToast(e.message || 'Erro')));
        actions.appendChild(confirmPay);
      }

      if (order.nextStatus) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const isConfirm = order.status === 'Created';
        const isDeliver = order.nextStatus === 'Delivered';
        // Pedido de mesa não bloqueia por pagamento: o pagamento se resolve no fechamento da mesa.
        const paymentBlocks = isDeliver && isPaymentBlockingDelivery(order) && !isDineInOrder(order);
        btn.className = isConfirm ? 'confirm' : '';
        btn.textContent = statusActionLabel(order);
        if (paymentBlocks) {
          btn.disabled = true;
          btn.title = deliverBlockedReason(order);
          btn.textContent = 'Aguardando pagamento';
        } else {
          const quickDeliver = order.status === 'Accepted' && isQuickMesaDeliver(order);
          btn.addEventListener('click', () =>
            (quickDeliver ? deliverTableOrder(order) : advanceOrderStatus(order)).catch((e) => showAppToast(e.message || 'Erro')));
        }
        actions.appendChild(btn);
      }

      if (canSeeOrders() && canCancelOrder(order)) {
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'danger compact';
        cancelBtn.textContent = 'Cancelar';
        cancelBtn.title = 'Cancelar pedido';
        cancelBtn.addEventListener('click', () =>
          cancelOrderWithReason(order).catch((e) => showAppToast(e.message || 'Erro')));
        actions.appendChild(cancelBtn);
      }

      board.appendChild(card);
    });
  }

  function askCancelOrderReason(order) {
    return new Promise((resolve) => {
      const existing = $('cancelOrderModal');
      if (existing) existing.remove();

      const optionsHtml = CANCEL_REASON_PRESETS.map((p, idx) => (
        `<label class="cancel-reason-option">` +
        `<input type="radio" name="cancelReasonCode" value="${escapeHtml(p.code)}" ${idx === 0 ? 'checked' : ''} />` +
        `<span>${escapeHtml(p.label)}</span>` +
        `</label>`
      )).join('');

      const modal = document.createElement('div');
      modal.id = 'cancelOrderModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card cancel-order-card" role="dialog" aria-modal="true" aria-labelledby="cancelOrderTitle">` +
        `<h3 id="cancelOrderTitle">Cancelar pedido</h3>` +
        `<p>Pedido <strong>${escapeHtml(order.orderId)}</strong> — ${escapeHtml(order.customerName || '')}</p>` +
        `<p class="muted">Escolha o motivo. O cliente verá essa informação no acompanhamento.</p>` +
        `<div class="cancel-reason-list" role="radiogroup" aria-label="Motivo do cancelamento">${optionsHtml}</div>` +
        `<label class="cancel-detail-label" for="cancelReasonDetail">Detalhe (obrigatório em “Outro motivo”)</label>` +
        `<textarea id="cancelReasonDetail" class="cancel-reason-detail" rows="2" maxlength="280" placeholder="Ex.: sem batata no momento"></textarea>` +
        `<p id="cancelReasonError" class="error" hidden></p>` +
        `<div class="confirm-modal-actions">` +
        `<button type="button" class="danger" data-cancel-ok>Confirmar cancelamento</button>` +
        `<button type="button" class="ghost compact" data-cancel-abort>Voltar</button>` +
        `</div></div>`;
      document.body.appendChild(modal);

      const finish = (value) => {
        modal.remove();
        resolve(value);
      };

      modal.querySelector('[data-cancel-abort]')?.addEventListener('click', () => finish(null));
      modal.addEventListener('click', (e) => {
        if (e.target === modal) finish(null);
      });
      modal.querySelector('[data-cancel-ok]')?.addEventListener('click', () => {
        const selected = modal.querySelector('input[name="cancelReasonCode"]:checked');
        const code = selected?.value || '';
        const detail = String(modal.querySelector('#cancelReasonDetail')?.value || '').trim();
        const err = modal.querySelector('#cancelReasonError');
        if (!code) {
          if (err) { err.hidden = false; err.textContent = 'Selecione um motivo.'; }
          return;
        }
        if (code === 'other' && detail.length < 3) {
          if (err) { err.hidden = false; err.textContent = 'Descreva o motivo (mínimo 3 caracteres).'; }
          modal.querySelector('#cancelReasonDetail')?.focus();
          return;
        }
        if (err) err.hidden = true;
        const preset = CANCEL_REASON_PRESETS.find((p) => p.code === code);
        finish({
          code,
          detail,
          customerRequested: !!preset?.customerRequested
        });
      });
      modal.querySelector('input[name="cancelReasonCode"]:checked')?.focus();
    });
  }

  async function cancelOrderWithReason(order) {
    if (!canCancelOrder(order)) return;
    if (isDineInOrder(order) && !(await requirePinSession())) return;
    const choice = await askCancelOrderReason(order);
    if (!choice) return;

    const updated = await api(`/api/v1/orders/${encodeURIComponent(order.orderId)}/status`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({
        status: 'Cancelled',
        cancellationReasonCode: choice.code,
        cancellationReason: choice.detail || null,
        customerRequested: choice.customerRequested
      })
    });
    applyOrderToLocalList(updated);
    syncAlertsAfterLocalOrderChange();
    try {
      await refreshOrders({ silent: true });
    } catch (err) {
      console.warn('Refresh após cancelamento', err);
      syncAlertsAfterLocalOrderChange();
    }
    setOrderFilter('Cancelled');
    showAppToast(`Pedido ${order.orderId} cancelado.`);
  }

  function isPixPaymentMethod(method) {
    return /^pix$/i.test(String(method || '').trim());
  }

  const PAYMENT_METHODS = ['Pix', 'Dinheiro', 'Cartão de Crédito', 'Cartão de Débito'];

  function askPaymentReceivedMethod(order) {
    return new Promise((resolve) => {
      const existing = $('paymentMethodModal');
      if (existing) existing.remove();

      const original = String(order.paymentMethod || '').trim() || 'Não informado';
      const methods = PAYMENT_METHODS.slice();

      // Atendimento staff sem mesa (Balcão/Delivery/Telefone): o pedido nasce
      // com `paymentMethod="Em Aberto"` de placeholder — a forma REAL é
      // definida agora na baixa (`PATCH /orders/{id}/payment`). Por isso o
      // modal NÃO oferece "Recebi em Em Aberto" (nem destaca o placeholder) e
      // passa o destaque (class confirm) para **Pix**, o método real mais
      // comum nesses canais. Dine-in (garçom/mesa) e QR/delivery de cliente
      // seguem a regra atual: mantêm "Em Aberto" quando essa foi a forma
      // informada no pedido.
      const sourceNoTable = String(order.orderSource || '').trim().toLowerCase();
      const isStaffAtendimentoNoTable = ['balcao', 'delivery', 'telefone'].includes(sourceNoTable);
      const originalLc = original.toLowerCase();
      const isNoTablePlaceholder = isStaffAtendimentoNoTable && (originalLc === 'em aberto' || originalLc === 'não informado');
      const highlight = isNoTablePlaceholder ? 'Pix' : original;
      if (original !== 'Não informado' && !isNoTablePlaceholder && !methods.some((m) => m.toLowerCase() === originalLc)) {
        methods.unshift(original);
      }

      const modal = document.createElement('div');
      modal.id = 'paymentMethodModal';
      modal.className = 'confirm-modal';
      modal.innerHTML =
        `<div class="confirm-modal-card" role="dialog" aria-modal="true" aria-labelledby="payMethodTitle">` +
        `<h3 id="payMethodTitle">Pagamento recebido</h3>` +
        `<p>Pedido <strong>${escapeHtml(order.orderId)}</strong></p>` +
        `<p>Forma informada no pedido: <strong>${escapeHtml(original)}</strong></p>` +
        `<p class="muted">Como o pagamento foi recebido?</p>` +
        `<div class="confirm-modal-actions">` +
        methods.map((m) => {
          const isHighlight = m.toLowerCase() === highlight.toLowerCase();
          const isReported = m.toLowerCase() === original.toLowerCase() && !isNoTablePlaceholder;
          return `<button type="button" class="${isHighlight ? 'confirm' : 'ghost compact'}" data-pay-choice="${escapeHtml(m)}">` +
            `Recebi em ${escapeHtml(m)}` +
            (isReported ? ` <small>(informado no pedido)</small>` : '') +
            `</button>`;
        }).join('') +
        `<button type="button" class="ghost compact" data-pay-choice="cancel">Cancelar</button>` +
        `</div></div>`;

      const finish = (value) => {
        modal.remove();
        resolve(value);
      };

      modal.addEventListener('click', (e) => {
        if (e.target === modal) finish(null);
      });
      modal.querySelectorAll('[data-pay-choice]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const choice = btn.getAttribute('data-pay-choice');
          if (choice === 'cancel') finish(null);
          else finish(choice);
        });
      });

      document.body.appendChild(modal);
    });
  }

  async function confirmOrderPaymentReceived(order) {
    if (isDineInOrder(order) && !(await requirePinSession())) return;
    const method = String(order.paymentMethod || '').trim();
    if (isPixPaymentMethod(method)) {
      await updateOrderPayment(order.orderId, 'confirmed');
      return;
    }

    const chosenMethod = await askPaymentReceivedMethod(order);
    if (!chosenMethod) return;
    await updateOrderPayment(order.orderId, 'confirmed', chosenMethod);
  }

  async function updateOrderPayment(orderId, paymentStatus, paymentMethod) {
    const body = { paymentStatus };
    if (paymentMethod) body.paymentMethod = paymentMethod;

    await api(`/api/v1/orders/${encodeURIComponent(orderId)}/payment`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(body)
    });
    await refreshOrders();
  }

  function orderStatusRank(status) {
    const rank = ORDER_STATUS_RANK[status];
    return Number.isFinite(rank) ? rank : -1;
  }

  function mergeOrdersPreferringNewerStatus(serverList) {
    const localById = new Map(orders.map((o) => [o.orderId, o]));
    return (Array.isArray(serverList) ? serverList : []).map((server) => {
      const local = localById.get(server?.orderId);
      if (!local) return server;
      if (orderStatusRank(local.status) > orderStatusRank(server.status)) {
        return { ...server, ...local };
      }
      return server;
    });
  }

  function autoPrintMesaOnConfirmCheck(updated) {
    // Auto-print "ao chegar em Confirmado": pedidos de mesa (dine-in) e de
    // atendimento de Balcão/Telefone (origem equipe, já nascem Confirmados).
    // Delivery fica de fora (acompanhamento/entrega no endereço do cliente).
    const src = String(updated?.orderSource || '').toLowerCase();
    const isEligibleSource = isDineInOrder(updated) || src === 'balcao' || src === 'telefone';
    if (!isEligibleSource) return;
    const rank = orderStatusRank(updated.status);
    if (rank < ORDER_STATUS_RANK.Accepted) return;
    const id = updated.orderId;
    if (mesaAutoPrintedOrders.has(id)) return;
    mesaAutoPrintedOrders.add(id);
    if (
      updated.status === 'Accepted' &&
      adminPrefs.autoPrintMesaOnConfirm &&
      !shouldSkipMesaAutoPrint(updated)
    ) {
      console.info('[Mesa auto-print] disparando', {
        orderId: id,
        status: updated.status,
        pref: adminPrefs.autoPrintMesaOnConfirm,
        itens: Array.isArray(updated.items) ? updated.items.length : 0,
        fonte: updated.orderSource
      });
      printOrderReceipt({ order: updated, mesaAuto: true });
    } else {
      console.info('[Mesa auto-print] ignorado', {
        orderId: id,
        status: updated.status,
        pref: adminPrefs.autoPrintMesaOnConfirm,
        dineIn: isDineInOrder(updated),
        skip: shouldSkipMesaAutoPrint(updated)
      });
    }
  }

  function shouldSkipMesaAutoPrint(order) {
    if (!orderHasOnlyBeverages(order)) return false;
    const src = String(order?.orderSource || '').toLowerCase();
    return src === 'waiter_panel' || src === 'admin_panel';
  }

  function isQuickMesaDeliver(order) {
    if (!isDineInOrder(order) || order?.status !== 'Accepted') return false;
    const src = String(order?.orderSource || '').toLowerCase();
    if (src !== 'waiter_panel' && src !== 'admin_panel') return false;
    return orderHasOnlyBeverages(order);
  }

  function applyOrderToLocalList(updated) {
    if (!updated?.orderId) return;
    const idx = orders.findIndex((o) => o.orderId === updated.orderId);
    if (idx >= 0) {
      const prev = orders[idx];
      // Não regride status se a resposta vier incompleta/atrasada
      if (orderStatusRank(prev.status) > orderStatusRank(updated.status)) {
        orders[idx] = {
          ...updated,
          status: prev.status,
          statusLabel: prev.statusLabel,
          nextStatus: prev.nextStatus,
          nextStatusLabel: prev.nextStatusLabel
        };
      } else {
        orders[idx] = { ...prev, ...updated };
      }
    } else {
      orders = [updated, ...orders];
    }
    knownOrderIds.add(updated.orderId);
    autoPrintMesaOnConfirmCheck(updated);
  }

  async function advanceOrderStatus(order, { skipConfirm } = {}) {
    if (!order.nextStatus) return;
    // Pedido de mesa não bloqueia por pagamento: o pagamento se resolve no fechamento da mesa.
    if (order.nextStatus === 'Delivered' && isPaymentBlockingDelivery(order) && !isDineInOrder(order)) {
      throw new Error(deliverBlockedReason(order));
    }
    // PIN gate: finalização (Delivered) de pedido de mesa
    if (isDineInOrder(order) && order.nextStatus === 'Delivered' && !(await requirePinSession())) return;
    const fromStatus = order.status;

    if (fromStatus === 'Created') {
      if (!skipConfirm) {
        const itemsCheck = await askItemsAvailability(order);
        if (!itemsCheck) return;
        if (!itemsCheck.allItems) {
          await editOrderItems(order);
          return;
        }
      }
    }

    const toStatus = order.nextStatus;

    const updated = await api(`/api/v1/orders/${encodeURIComponent(order.orderId)}/status`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify({ status: toStatus })
    });
    // Aplica na hora: o polling pode descartar o refresh e a aba ficava sem acompanhar o pedido
    applyOrderToLocalList(updated);
    // Para sons (novo pedido + prazo) na hora — não espera o próximo tick/poll
    syncAlertsAfterLocalOrderChange();

    if (fromStatus === 'Created' && adminPrefs.autoPrintOnConfirm && !(isDineInOrder(order) && adminPrefs.autoPrintMesaOnConfirm)) {
      const confirmedOrder = { ...order, ...updated };
      // Pedido só de bebidas: não gasta papel/tinta com cupom automático.
      if (orderHasOnlyBeverages(confirmedOrder)) {
        showAppToast('Pedido de bebidas — impressão automática dispensada.');
      } else {
        printOrderReceipt({ order: confirmedOrder });
      }
    }

    try {
      await refreshOrders({ silent: true });
    } catch (err) {
      console.warn('Refresh após avanço de status', err);
      syncAlertsAfterLocalOrderChange();
    }

    // Sempre ativa a etapa de destino (ex.: Confirmar → Confirmado)
    if (ORDER_FILTER_SEQUENCE.includes(toStatus)) {
      setOrderFilter(toStatus);
      return;
    }
    updateOrderFilterCounts();
    renderOrdersBoard();
  }

  async function deliverTableOrder(order) {
    if (!canSeeOrders() || !order || order.status !== 'Accepted') return;
    if (!isQuickMesaDeliver(order)) return;
    if (!(await requirePinSession())) return;
    const steps = ['Preparing', 'ReadyForTable', 'Delivered'].filter(
      (s) => orderStatusRank(order.status) < orderStatusRank(s)
    );
    let current = order;
    for (const step of steps) {
      const updated = await api(`/api/v1/orders/${encodeURIComponent(current.orderId)}/status`, {
        method: 'PATCH',
        headers: authHeaders(),
        body: JSON.stringify({ status: step })
      });
      applyOrderToLocalList(updated);
      current = { ...current, ...updated };
    }
    syncAlertsAfterLocalOrderChange();
    try {
      await refreshOrders({ silent: true });
    } catch (err) {
      console.warn('Refresh após entregar na mesa', err);
      syncAlertsAfterLocalOrderChange();
    }
    setOrderFilter('Delivered');
    renderOrdersBoard();
  }

  async function confirmFirstWaitingOrder() {
    if (!canSeeOrders() || activeTab !== 'orders') return;
    if ($('appConfirmModal') || $('itemsCheckModal') || $('editOrderItemsModal') || ($('receiptModal') && !$('receiptModal').hidden)) return;
    if ($('paymentMethodModal') || ($('categoryModal') && !$('categoryModal').hidden)) return;
    if (($('productModal') && !$('productModal').hidden) || ($('ingredientModal') && !$('ingredientModal').hidden)) return;
    const waiting = ordersForFilter('Created');
    if (!waiting.length) return;
    const first = waiting[0];
    if (!first?.nextStatus) return;
    await advanceOrderStatus(first);
  }

  function isAddonsCategory(c) {
    const norm = (v) => String(v || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
    const names = new Set(['adicionais', 'adicional', 'addons', 'addon']);
    return names.has(norm(c?.title)) || names.has(norm(c?.id));
  }

  function startEditCategory(c) {
    editingCategoryId = c.id;
    $('catTitle').value = c.title || '';
    if ($('catShowInMenu')) {
      const forcedHidden = isAddonsCategory(c);
      $('catShowInMenu').checked = forcedHidden ? false : c.showInMenu !== false;
      $('catShowInMenu').disabled = forcedHidden;
    }
    $('saveCatBtn').textContent = 'Atualizar categoria';
    $('catFormMode').textContent = `Editar categoria`;
    openTab('categories');
    openCategoryModal();
    $('catTitle')?.focus();
  }

  function updateProductImageUi(url) {
    const preview = $('prodImagePreview');
    if (preview) {
      if (url) {
        preview.src = resolveAssetUrl(url);
        preview.hidden = false;
        wireImageZoom(preview, 'Imagem do produto');
      } else {
        preview.removeAttribute('src');
        preview.hidden = true;
      }
    }
    const removeBtn = $('prodImageRemoveBtn');
    if (removeBtn) removeBtn.hidden = !url;
  }

  function setProductImageStatus(message) {
    const status = $('prodImageStatus');
    if (!status) return;
    if (message) {
      status.hidden = false;
      status.textContent = message;
    } else {
      status.hidden = true;
      status.textContent = '';
    }
  }

  function setProductImageProcessing(active) {
    productImageProcessing = !!active;
    const btn = $('saveProdBtn');
    if (btn) btn.disabled = productImageProcessing;
  }

  function clearPendingProductImage() {
    productImageProcessSeq++;
    if (pendingProductImageUrl) {
      URL.revokeObjectURL(pendingProductImageUrl);
      pendingProductImageUrl = null;
    }
    pendingProductImageBlob = null;
    setProductImageProcessing(false);
    setProductImageStatus('');
  }

  const BG_REMOVAL_CDN = 'https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm';

  function loadBackgroundRemoval() {
    if (!bgRemovalModulePromise) {
      bgRemovalModulePromise = import(BG_REMOVAL_CDN).catch((err) => {
        bgRemovalModulePromise = null;
        throw err;
      });
    }
    return bgRemovalModulePromise;
  }

  async function processProductImageWithAi(file) {
    if (!file) return;
    const seq = ++productImageProcessSeq;
    setProductImageProcessing(true);
    try {
      const { removeBackground } = await loadBackgroundRemoval();
      setProductImageStatus('Removendo fundo...');
      const blob = await removeBackground(file, {
        output: { format: 'image/png' },
        progress: (key, current, total) => {
          if (seq !== productImageProcessSeq) return;
          if (total > 0 && typeof current === 'number') {
            setProductImageStatus(`Removendo fundo... ${Math.round((current / total) * 100)}%`);
          }
        }
      });
      if (seq !== productImageProcessSeq) return;
      pendingProductImageBlob = blob;
      if (pendingProductImageUrl) {
        URL.revokeObjectURL(pendingProductImageUrl);
        pendingProductImageUrl = null;
      }
      const preview = $('prodImagePreview');
      if (preview) {
        pendingProductImageUrl = URL.createObjectURL(blob);
        preview.src = pendingProductImageUrl;
        preview.hidden = false;
      }
      setProductImageStatus('Fundo removido.');
    } catch (err) {
      if (seq !== productImageProcessSeq) return;
      pendingProductImageBlob = file;
      setProductImageStatus('Não foi possível remover o fundo automaticamente. A imagem original será enviada.');
    } finally {
      if (seq === productImageProcessSeq) {
        setProductImageProcessing(false);
      }
    }
  }

  function startEditProduct(p, categoryId) {
    editingProductId = p.id;
    clearPendingProductImage();
    $('prodCategory').value = categoryId;
    $('prodName').value = p.name || '';
    $('prodPrice').value = p.price != null ? String(p.price) : '';
    $('prodPriceMedia').value = p.priceMedia != null ? String(p.priceMedia) : '';
    $('prodPriceInteira').value = p.priceInteira != null ? String(p.priceInteira) : '';
    $('prodImageUrl').value = p.imageUrl || '';
    updateProductImageUi(p.imageUrl || '');
    $('prodAvailable').checked = p.available !== false;
    if ($('prodShowInMenu')) $('prodShowInMenu').checked = p.showInMenu !== false;
    const selectedIds = (p.ingredients || []).map((i) => i.id).filter(Boolean);
    productOpcionais = flattenModifierGroups(p.modifierGroups || []);
    productPrincipalIds = (p.ingredients || [])
      .filter((i) => i && i.isPrincipal)
      .map((i) => i.id)
      .slice(0, 1);
    renderProductIngredients(selectedIds);
    renderProductOpcionais();
    captureProductFormBaseline();
    $('saveProdBtn').textContent = 'Atualizar produto';
    $('prodFormMode').textContent = `Editar produto`;
    openTab('products');
    syncProductPriceFields();
    openProductModal();
    $('prodName')?.focus();
  }

  function startNewIngredientFromProduct() {
    creatingIngredientFromProduct = true;
    editingIngredientId = null;
    if ($('ingName')) $('ingName').value = '';
    if ($('ingAvailable')) $('ingAvailable').checked = true;
    if ($('saveIngBtn')) $('saveIngBtn').textContent = 'Salvar ingrediente';
    if ($('ingFormMode')) $('ingFormMode').textContent = 'Novo ingrediente';
    openIngredientModal();
    $('ingName')?.focus();
  }

  function startEditIngredient(ing) {
    editingIngredientId = ing.id;
    $('ingName').value = ing.name || '';
    if ($('ingAvailable')) $('ingAvailable').checked = ing.available !== false;
    $('saveIngBtn').textContent = 'Atualizar ingrediente';
    $('ingFormMode').textContent = 'Editar ingrediente';
    openTab('ingredients');
    openIngredientModal();
    $('ingName')?.focus();
  }

  function startNewCategory() {
    resetCategoryForm({ closeModal: false });
    openCategoryModal();
    $('catTitle')?.focus();
  }

  function startNewIngredient() {
    resetIngredientForm({ closeModal: false });
    openIngredientModal();
    $('ingName')?.focus();
  }

  function startNewProduct() {
    if (!(catalog.categories || []).length) {
      showAppToast('Cadastre uma categoria antes de criar produtos.');
      openTab('categories');
      return;
    }
    resetProductForm({ closeModal: false });
    renderProductIngredients([]);
    captureProductFormBaseline();
    openProductModal();
    if (productCategoryFilter && $('prodCategory')) {
      $('prodCategory').value = productCategoryFilter;
    }
    syncProductPriceFields();
    if (!$('prodCategory')?.value) {
      $('prodCategory')?.focus();
    } else {
      $('prodName')?.focus();
    }
  }

  function renderCategories() {
    const list = $('catList');
    const select = $('prodCategory');
    const previousCategory = select.value;
    list.innerHTML = '';
    select.innerHTML = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Selecione a categoria';
    select.appendChild(placeholder);

    const prodFilter = $('productCategoryFilter');
    const previousProdFilter = prodFilter ? prodFilter.value : '';
    if (prodFilter) {
      prodFilter.innerHTML = '';
      const all = document.createElement('option');
      all.value = '';
      all.textContent = 'Todas as categorias';
      prodFilter.appendChild(all);
    }

    const categories = catalog.categories || [];
    let shown = 0;
    categories.forEach((c) => {
      const count = (c.items || []).length;

      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.title;
      select.appendChild(opt);
      if (prodFilter) prodFilter.appendChild(opt.cloneNode(true));

      if (categorySearch && !String(c.title || '').toLowerCase().includes(categorySearch)) return;
      shown += 1;

      const li = document.createElement('li');
      li.dataset.sortId = c.id;

      li.appendChild(createDragHandle());

      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'cat-link';
      const hiddenMenu = c.showInMenu === false ? ' · oculto no cardápio' : '';
      link.innerHTML =
        `<strong>${escapeHtml(c.title)}</strong>` +
        `<span class="cat-meta">` +
        `<span class="cat-count">${count} produto${count === 1 ? '' : 's'}${hiddenMenu}</span>` +
        `</span>`;
      link.title = count
        ? `Ver produtos de ${c.title}`
        : `Categoria ${c.title} sem produtos`;
      link.addEventListener('click', () => openProductsForCategory(c.id, c.title));

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Editar';
      edit.title = `Editar categoria ${c.title}`;
      edit.addEventListener('click', () => startEditCategory(c));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Excluir';
      if (count > 0) {
        del.disabled = true;
        del.title = `Não é possível excluir: há ${count} produto(s) nesta categoria`;
      } else {
        del.title = 'Excluir categoria vazia';
        del.addEventListener('click', async () => {
          const ok = await askConfirm(`Excluir categoria ${c.title}?`, {
            title: 'Excluir categoria',
            confirmLabel: 'Excluir'
          });
          if (!ok) return;
          try {
            await api(`/api/v1/admin/categories/${encodeURIComponent(c.id)}`, {
              method: 'DELETE',
              headers: authHeaders()
            });
            if (editingCategoryId === c.id) resetCategoryForm();
            await refresh();
          } catch (err) {
            showAppToast(err.message || 'Falha ao excluir categoria');
          }
        });
      }

      actions.appendChild(edit);
      actions.appendChild(del);
      li.appendChild(link);
      li.appendChild(actions);
      list.appendChild(li);
    });

    if (shown === 0 && categories.length > 0) {
      const empty = document.createElement('li');
      empty.innerHTML = '<span class="muted">Nenhuma categoria encontrada para a busca.</span>';
      list.appendChild(empty);
    }

    if (!categorySearch) {
      enableSortableList(list, {
        onReorder: (ids) => reorderCatalogItems('category', ids)
      });
    }

    if (prodFilter && [...prodFilter.options].some((o) => o.value === previousProdFilter)) {
      prodFilter.value = previousProdFilter;
    }
    syncProductCategoryFilterSelect();

    const keepProductCategory = editingProductId
      ? (catalog.categories || []).find((c) =>
          (c.items || []).some((p) => p.id === editingProductId)
        )?.id
      : null;

    if (keepProductCategory) {
      select.value = keepProductCategory;
    } else if (productCategoryFilter) {
      const stillExists = (catalog.categories || []).some((c) => c.id === productCategoryFilter);
      if (!stillExists) clearProductFilter();
      else {
        const match = (catalog.categories || []).find((c) => c.id === productCategoryFilter);
        updateProductFilterBar(match ? match.title : productCategoryFilter);
        select.value = productCategoryFilter;
      }
    } else if (previousCategory && [...select.options].some((o) => o.value === previousCategory)) {
      select.value = previousCategory;
    } else {
      select.value = '';
    }

    if (editingCategoryId) {
      const still = (catalog.categories || []).find((c) => c.id === editingCategoryId);
      if (!still) resetCategoryForm();
    }
  }

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function isHttpUrl(value) {
    if (!value) return true;
    try {
      const u = new URL(value);
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch (_) {
      return false;
    }
  }

  function isAllowedAssetUrl(value) {
    if (!value) return true;
    const v = String(value).trim();
    if (v.startsWith('/uploads/') || v.startsWith('assets/')) return true;
    return isHttpUrl(v);
  }

  function safeExternalHref(url) {
    if (!isHttpUrl(url)) return null;
    return url;
  }

  function splitItemObservation(name) {
    const raw = String(name || '');
    const match = raw.match(/^(.*?)\s*\(\s*Obs\.\s*:\s*(.+?)\s*\)\s*$/i);
    if (!match) return { name: raw, note: '' };
    return {
      name: match[1].trim() || raw,
      note: match[2].trim()
    };
  }

  /** Converte "+8,00" / "R$ 8,00" / "+8" em número. */
  function parseModifierPrice(text) {
    const m = String(text == null ? '' : text).match(/(\d+(?:[.,]\d{1,2})?)/);
    if (!m) return 0;
    return Number(m[1].replace(/\./g, '').replace(',', '.')) || 0;
  }

  /**
   * Classifica um token de customização: "Sem X" vira removido, "Adic. Nome +x,xx"
   * vira adicional, o restante vira observação livre.
   */
  function classifyCustomToken(token, removed, addons, notes) {
    const t = String(token == null ? '' : token).trim();
    if (!t) return;
    const sem = t.match(/^Sem\s+(.+)$/);
    if (sem) {
      removed.push(sem[1].trim());
      return;
    }
    const adic = t.match(/^Adic\.\s*(.+)$/i);
    if (adic) {
      const raw = adic[1].trim();
      const priceMatch = raw.match(/\s*\+?\s*R?\$?\s*(\d+(?:[.,]\d{1,2})?)\s*$/);
      const priceDelta = priceMatch ? parseModifierPrice(priceMatch[1]) : 0;
      const name = (priceMatch ? raw.slice(0, priceMatch.index) : raw).replace(/[+-]\s*$/, '').trim();
      addons.push({ name: name || raw, priceDelta });
      return;
    }
    notes.push(t);
  }

  /**
   * Separa o nome do item em nome-base, ingredientes removidos, adicionais e obs. livre.
   * Formatos suportados: obs. embutida "(Obs.: Sem X; texto)", customização inline no
   * nome "(Sem X; Adic. Bacon +8,00)" (storefront embute removidos e adicionais no nome)
   * e legado "(Sem X)" colado ao nome. Só tokens reconhecidos ("Sem ..."/"Adic. ...")
   * são extraídos; variações como "(Pão francês)" permanecem no nome.
   */
  function splitItemCustomization(name) {
    const parsed = splitItemObservation(name);
    const removed = [];
    const addons = [];
    const notes = [];
    String(parsed.note || '')
      .split(';')
      .forEach((part) => classifyCustomToken(part, removed, addons, notes));
    const base = String(parsed.name || '')
      .replace(/\(([^()]*)\)/g, (whole, inner) => {
        const tokens = String(inner || '').split(';').map((s) => s.trim()).filter(Boolean);
        const isCustom = tokens.some((t) => /^Sem\s/.test(t) || /^Adic\./i.test(t));
        if (!isCustom) return whole;
        tokens.forEach((t) => classifyCustomToken(t, removed, addons, notes));
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

    return { name: base || parsed.name, removed: dedupRemoved, addons: dedupAddons, note: notes.join('; ') };
  }

  /** Adicionais estruturados (`item.modifiers`) + os embutidos no nome, sem duplicar. */
  function itemModifiers(item) {
    const structured = Array.isArray(item && item.modifiers) ? item.modifiers : [];
    const inline = splitItemCustomization(item && item.name).addons;
    const out = [];
    const seen = new Set();
    structured.concat(inline).forEach((m) => {
      const name = String((m && m.name) || '').trim();
      if (!name) return;
      const priceDelta = Number(m && m.priceDelta) || 0;
      const key = `${name.toLowerCase()}|${priceDelta}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        groupId: (m && m.groupId) || null,
        optionId: (m && m.optionId) || null,
        name,
        priceDelta
      });
    });
    return out;
  }

  /** Normaliza rótulos para casar adicional do nome com a opção do catálogo. */
  function normalizeModifierLabel(value) {
    return String(value == null ? '' : value)
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Produto do catálogo do item (por id e, se preciso, pelo nome-base). */
  function findCatalogProduct(item) {
    const list = flattenCatalogProducts();
    if (!list.length) return null;
    const pid = String((item && item.productId) || '').trim();
    if (pid) {
      const byId = list.find((p) => String(p.id) === pid);
      if (byId) return byId;
    }
    const base = normalizeModifierLabel(splitItemCustomization(item && item.name).name);
    if (!base) return null;
    return list.find((p) => normalizeModifierLabel(p.name) === base)
      || list.find((p) => {
        const pname = normalizeModifierLabel(p.name);
        return pname.length >= 3 && base.startsWith(`${pname} `);
      })
      || null;
  }

  /** Preço-base do produto considerando o tamanho ("Média"/"Inteira") no nome. */
  function catalogBasePrice(product, lineName) {
    if (!product) return null;
    const size = String(lineName || '').match(/\(\s*(m[ée]dia|inteira)\s*\)/i);
    const kind = size ? normalizeModifierLabel(size[1]) : '';
    if (kind === 'media' && Number(product.priceMedia) > 0) return Number(product.priceMedia);
    if (kind === 'inteira' && Number(product.priceInteira) > 0) return Number(product.priceInteira);
    return Number(product.price) || 0;
  }

  /**
   * Resolve os adicionais (ids do catálogo) a partir do estruturado/inline. Entradas sem
   * `groupId`/`optionId` (pedidos antigos, adicional só no nome) casam por nome com as
   * opções do produto; quando não casam, ficam com `resolved:false` (serão descartadas).
   */
  function resolveItemModifiers(item) {
    const mods = itemModifiers(item);
    const product = findCatalogProduct(item);
    const groups = (product && Array.isArray(product.modifierGroups)) ? product.modifierGroups : [];
    return mods.map((m) => {
      if (m.groupId && m.optionId) return { ...m, resolved: true };
      const target = normalizeModifierLabel(m.name);
      let group = null;
      let option = null;
      groups.forEach((g) => {
        if (group) return;
        (g.options || []).forEach((o) => {
          if (group) return;
          if (normalizeModifierLabel(o.name) === target) { group = g; option = o; }
        });
      });
      if (!group || !option || option.available === false) return { ...m, resolved: false };
      return {
        groupId: group.id || null,
        optionId: option.id || null,
        name: option.name || m.name,
        priceDelta: Number(option.priceDelta) || 0,
        resolved: true
      };
    });
  }

  /**
   * Preço do item = base do catálogo + adicionais resolvidos (fallback: preço do pedido).
   * Adicionais não resolvidos (que o servidor descarta) não entram no preço previsto.
   */
  function priceWithResolvedModifiers(name, product, mods, fallback) {
    const base = catalogBasePrice(product, name);
    if (!product || base == null) return Number(fallback) || 0;
    return base + (mods || [])
      .filter((m) => m && m.resolved !== false)
      .reduce((s, m) => s + (Number(m.priceDelta) || 0), 0);
  }

  /**
   * Quebra de valores do item (totais da linha, já × quantidade): nome-base com o valor
   * do produto, adicionais e total do item. `base` = preço gravado menos os adicionais.
   */
  function itemPriceParts(item) {
    const qty = Math.max(1, Number(item && item.quantity) || 1);
    const unit = Number(item && item.price) || 0;
    const info = splitItemCustomization(item && item.name);
    const mods = itemModifiers(item);
    const addonsUnit = mods.reduce((s, m) => s + (Number(m.priceDelta) || 0), 0);
    const baseUnit = Math.max(0, unit - addonsUnit);
    return {
      qty,
      name: info.name,
      removed: info.removed,
      addons: mods,
      note: info.note,
      base: baseUnit * qty,
      total: unit * qty
    };
  }

  function modifierLabel(m, plain) {
    const delta = Number(m && m.priceDelta) || 0;
    const name = String((m && m.name) || '').trim() || 'Adicional';
    if (delta <= 0) return name;
    return `${name} (+${plain ? `R$ ${moneyPlain(delta)}` : money(delta)})`;
  }

  /** Caixas no estilo de observações (card de pedido / comanda). */
  function itemCustomizationHtml(item) {
    const info = splitItemCustomization(item && item.name);
    const mods = itemModifiers(item);
    const parts = [];
    if (info.removed.length) {
      parts.push(
        `<p class="order-item-note item-removed"><strong>Sem ingredientes:</strong> ${escapeHtml(info.removed.join(', '))}</p>`
      );
    }
    if (mods.length) {
      parts.push(
        `<p class="order-item-note item-addons"><strong>Adicionais:</strong> ${escapeHtml(mods.map((m) => modifierLabel(m)).join(', '))}</p>`
      );
    }
    if (info.note) {
      parts.push(
        `<p class="order-item-note" role="alert"><strong>Obs. item:</strong> ${escapeHtml(info.note)}</p>`
      );
    }
    return parts.join('');
  }

  /** Linhas em texto puro para cupons (ECF/térmico). */
  function itemCustomizationText(item) {
    const info = splitItemCustomization(item && item.name);
    const mods = itemModifiers(item);
    const lines = [];
    if (info.removed.length) lines.push(`* Sem: ${info.removed.join(', ')}`);
    if (mods.length) lines.push(`* Adic.: ${mods.map((m) => modifierLabel(m, true)).join(', ')}`);
    if (info.note) lines.push(`* Obs.: ${info.note}`);
    return lines;
  }

  /** Sufixo compacto para resumos (card de mesa, fechamento de conta). */
  function itemCustomizationInline(item) {
    const info = splitItemCustomization(item && item.name);
    const mods = itemModifiers(item);
    const bits = [];
    if (info.removed.length) bits.push(`Sem: ${info.removed.join(', ')}`);
    if (mods.length) bits.push(`Adic.: ${mods.map((m) => modifierLabel(m)).join(', ')}`);
    return bits.length ? ` [${bits.join('; ')}]` : '';
  }

  function countProductsUsingIngredient(ingredientId) {
    let count = 0;
    (catalog.categories || []).forEach((c) => {
      (c.items || []).forEach((p) => {
        if ((p.ingredients || []).some((i) => i.id === ingredientId)) count += 1;
      });
    });
    return count;
  }

  function renderIngredients() {
    const list = $('ingList');
    if (!list) return;
    list.innerHTML = '';
    if (!ingredients.length) {
      const empty = document.createElement('li');
      empty.innerHTML = '<span class="muted">Nenhum ingrediente cadastrado.</span>';
      list.appendChild(empty);
      return;
    }

    let shown = 0;
    ingredients.forEach((ing) => {
      if (ingredientSearch && !String(ing.name || '').toLowerCase().includes(ingredientSearch)) return;
      shown += 1;
      const linked = countProductsUsingIngredient(ing.id);
      const li = document.createElement('li');
      li.dataset.sortId = ing.id;
      li.appendChild(createDragHandle());

      const info = document.createElement('span');
      info.className = 'entry-info';
      info.innerHTML =
        `<strong>${escapeHtml(ing.name)}</strong>` +
        ` <span class="cat-meta"><span class="cat-count">${linked} produto${linked === 1 ? '' : 's'}</span></span>`;

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Editar';
      edit.title = `Editar ${ing.name}`;
      edit.addEventListener('click', () => startEditIngredient(ing));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Excluir';
      if (linked > 0) {
        del.disabled = true;
        del.title = `Não é possível excluir: há ${linked} produto(s) com este ingrediente`;
      } else {
        del.title = 'Excluir ingrediente sem vínculo';
        del.addEventListener('click', async () => {
          const ok = await askConfirm(`Excluir ingrediente ${ing.name}?`, {
            title: 'Excluir ingrediente',
            confirmLabel: 'Excluir'
          });
          if (!ok) return;
          try {
            await api(`/api/v1/admin/ingredients/${encodeURIComponent(ing.id)}`, {
              method: 'DELETE',
              headers: authHeaders()
            });
            if (editingIngredientId === ing.id) resetIngredientForm();
            await refresh();
          } catch (err) {
            showAppToast(err.message || 'Falha ao excluir ingrediente');
          }
        });
      }

      actions.appendChild(edit);
      actions.appendChild(del);

      const availWrap = document.createElement('label');
      availWrap.className = 'available-toggle';
      availWrap.title = 'Aparecer no cardápio digital e nos seletores do painel';
      const availCheck = document.createElement('input');
      availCheck.type = 'checkbox';
      availCheck.checked = ing.available !== false;
      availCheck.addEventListener('change', async () => {
        if (availCheck.disabled) return;
        availCheck.disabled = true;
        const checked = availCheck.checked;
        try {
          const data = await api('/api/v1/admin/ingredients', {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({
              id: ing.id,
              name: ing.name,
              available: checked
            })
          });
          if (Array.isArray(data)) ingredients = data;
          renderIngredients();
          showAppToast(
            checked
              ? `${ing.name} disponível no cardápio.`
              : `${ing.name} indisponível (fora do cardápio).`,
            { ms: 2500 }
          );
        } catch (err) {
          availCheck.checked = !checked;
          renderIngredients();
          showAppToast(err.message || 'Falha ao atualizar disponibilidade');
        }
      });
      availWrap.appendChild(availCheck);

      li.appendChild(info);
      li.appendChild(availWrap);
      li.appendChild(actions);
      list.appendChild(li);
    });

    if (shown === 0) {
      const empty = document.createElement('li');
      empty.innerHTML = '<span class="muted">Nenhum ingrediente encontrado para a busca.</span>';
      list.appendChild(empty);
    }

    if (!ingredientSearch) {
      enableSortableList(list, {
        onReorder: (ids) => reorderCatalogItems('ingredient', ids)
      });
    }

    if (editingIngredientId) {
      const still = ingredients.some((i) => i.id === editingIngredientId);
      if (!still) resetIngredientForm();
    }

    // Atualiza checklist do modal de produto se estiver aberto
    const modal = $('productModal');
    if (modal && !modal.hidden) {
      renderProductIngredients(readSelectedIngredientIds());
    }
  }

  // ---- Aba Opcionais (categoria oculta "Adicionais") ----

  function getAddonsCategory() {
    return (catalog.categories || []).find((c) => c && String(c.id || '') === 'adicionais') || null;
  }

  function readOpcionais() {
    const cat = getAddonsCategory();
    return ((cat && cat.items) || []).map((p) => ({
      id: String(p.id || ''),
      name: String(p.name || ''),
      price: modifierClampPrice(p.price),
      available: p.available !== false
    }));
  }

  function countProductsUsingOpcional(op) {
    let count = 0;
    (catalog.categories || []).forEach((c) => {
      if (!c || String(c.id || '') === 'adicionais') return;
      (c.items || []).forEach((p) => {
        const used = (p.modifierGroups || []).some((g) =>
          (g.options || []).some((o) =>
            (op.id && o.id && String(o.id) === op.id) || namesMatch(o.name, op.name)
          )
        );
        if (used) count += 1;
      });
    });
    return count;
  }

  function openOpcionalModal() {
    const modal = $('opcionalModal');
    if (modal) modal.hidden = false;
  }

  function closeOpcionalModal() {
    const modal = $('opcionalModal');
    if (modal) modal.hidden = true;
  }

  function resetOpcionalForm({ closeModal = true } = {}) {
    editingOpcionalId = null;
    if ($('opcionalName')) $('opcionalName').value = '';
    if ($('opcionalPrice')) $('opcionalPrice').value = '';
    if ($('opcionalAvailable')) $('opcionalAvailable').checked = true;
    if ($('saveOpcionalBtn')) $('saveOpcionalBtn').textContent = 'Salvar opcional';
    if ($('opcionalFormMode')) $('opcionalFormMode').textContent = 'Novo opcional';
    if (closeModal) closeOpcionalModal();
  }

  function startNewOpcional() {
    if (!getAddonsCategory()) {
      showAppToast('Categoria "Adicionais" não encontrada.');
      return;
    }
    resetOpcionalForm({ closeModal: false });
    openOpcionalModal();
    $('opcionalName')?.focus();
  }

  function startEditOpcional(op) {
    editingOpcionalId = op.id;
    if ($('opcionalName')) $('opcionalName').value = op.name || '';
    if ($('opcionalPrice')) $('opcionalPrice').value = String(op.price ?? 0);
    if ($('opcionalAvailable')) $('opcionalAvailable').checked = op.available !== false;
    if ($('saveOpcionalBtn')) $('saveOpcionalBtn').textContent = 'Atualizar opcional';
    if ($('opcionalFormMode')) $('opcionalFormMode').textContent = 'Editar opcional';
    openTab('opcionais');
    openOpcionalModal();
    $('opcionalName')?.focus();
  }

  function renderOpcionais() {
    const list = $('opcionalList');
    if (!list) return;
    const opcionais = readOpcionais();
    list.innerHTML = '';
    if (!opcionais.length) {
      const empty = document.createElement('li');
      empty.innerHTML = '<span class="muted">Nenhum opcional cadastrado.</span>';
      list.appendChild(empty);
      return;
    }

    let shown = 0;
    opcionais.forEach((op) => {
      if (opcionalSearch && !String(op.name || '').toLowerCase().includes(opcionalSearch)) return;
      shown += 1;
      const linked = countProductsUsingOpcional(op);
      const li = document.createElement('li');
      li.dataset.sortId = op.id;
      li.appendChild(createDragHandle());

      const info = document.createElement('span');
      info.className = 'entry-info';
      info.innerHTML =
        `<strong>${escapeHtml(op.name)}</strong>` +
        ` <span class="cat-meta"><span class="cat-count">${escapeHtml(money(op.price))}</span></span>` +
        ` <span class="cat-meta"><span class="cat-count">${linked} produto${linked === 1 ? '' : 's'}</span></span>`;

      const actions = document.createElement('div');
      actions.className = 'item-actions';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Editar';
      edit.title = `Editar ${op.name}`;
      edit.addEventListener('click', () => startEditOpcional(op));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'danger';
      del.textContent = 'Excluir';
      if (linked > 0) {
        del.disabled = true;
        del.title = `Não é possível excluir: há ${linked} produto(s) com este opcional`;
      } else {
        del.title = 'Excluir opcional sem vínculo';
        del.addEventListener('click', async () => {
          const ok = await askConfirm(`Excluir opcional ${op.name}?`, {
            title: 'Excluir opcional',
            confirmLabel: 'Excluir'
          });
          if (!ok) return;
          try {
            await api(`/api/v1/admin/products/${encodeURIComponent(op.id)}`, {
              method: 'DELETE',
              headers: authHeaders()
            });
            if (editingOpcionalId === op.id) resetOpcionalForm();
            await refresh();
          } catch (err) {
            showAppToast(err.message || 'Falha ao excluir opcional');
          }
        });
      }

      actions.appendChild(edit);
      actions.appendChild(del);

      const availWrap = document.createElement('label');
      availWrap.className = 'available-toggle';
      availWrap.title = 'Aparecer no seletor de opcionais dos produtos';
      const availCheck = document.createElement('input');
      availCheck.type = 'checkbox';
      availCheck.checked = op.available !== false;
      availCheck.addEventListener('change', async () => {
        if (availCheck.disabled) return;
        availCheck.disabled = true;
        const checked = availCheck.checked;
        try {
          const data = await api('/api/v1/admin/products', {
            method: 'PUT',
            headers: authHeaders(),
            body: JSON.stringify({
              id: op.id,
              categoryId: 'adicionais',
              name: op.name,
              price: op.price,
              available: checked
            })
          });
          if (data && Array.isArray(data.categories)) catalog = data;
          renderOpcionais();
          showAppToast(
            checked
              ? `${op.name} disponível nos produtos.`
              : `${op.name} indisponível (fora do seletor).`,
            { ms: 2500 }
          );
        } catch (err) {
          availCheck.checked = !checked;
          renderOpcionais();
          showAppToast(err.message || 'Falha ao atualizar disponibilidade');
        }
      });
      availWrap.appendChild(availCheck);

      li.appendChild(info);
      li.appendChild(availWrap);
      li.appendChild(actions);
      list.appendChild(li);
    });

    if (shown === 0) {
      const empty = document.createElement('li');
      empty.innerHTML = '<span class="muted">Nenhum opcional encontrado para a busca.</span>';
      list.appendChild(empty);
    }

    if (!opcionalSearch) {
      enableSortableList(list, {
        onReorder: (ids) => reorderCatalogItems('product', ids, 'adicionais')
      });
    }

    if (editingOpcionalId) {
      const still = readOpcionais().some((o) => o.id === editingOpcionalId);
      if (!still) resetOpcionalForm();
    }
  }

  async function saveOpcional() {
    const name = String($('opcionalName') ? $('opcionalName').value : '').trim();
    if (!name) throw new Error('Informe o nome do opcional.');
    if (name.length > 60) throw new Error('Nome do opcional muito longo (máx. 60).');

    const price = modifierClampPrice($('opcionalPrice') ? $('opcionalPrice').value : 0);
    const id = editingOpcionalId || '';

    const duplicate = readOpcionais().some((o) => o.id !== id && namesMatch(o.name, name));
    if (duplicate) throw new Error(`Já existe um opcional com o nome '${name}'.`);

    const data = await api('/api/v1/admin/products', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        id,
        categoryId: 'adicionais',
        name,
        price,
        available: $('opcionalAvailable') ? $('opcionalAvailable').checked : true
      })
    });
    resetOpcionalForm();
    if (data && Array.isArray(data.categories)) catalog = data;
    renderOpcionais();
  }

  function renderProducts() {
    const list = $('prodList');
    list.innerHTML = '';
    let shown = 0;
    (catalog.categories || []).forEach((c) => {
      if (productCategoryFilter && c.id !== productCategoryFilter) return;
      const items = c.items || [];
      items.forEach((p) => {
        if (productSearch) {
          const haystack = [
            p.name,
            formatProductPriceLabel(p),
            c.title
          ].join(' ').toLowerCase();
          if (!haystack.includes(productSearch)) return;
        }
        shown += 1;
        const li = document.createElement('li');
        li.dataset.sortId = p.id;
        li.dataset.sortGroup = c.id;
        li.appendChild(createDragHandle());

        const info = document.createElement('span');
        info.className = 'product-info';
        const avail = p.available === false ? ' · indisponível' : '';
        const hiddenMenu = p.showInMenu === false ? ' · oculto no cardápio' : '';
        const ings = formatProductIngredients(p);
        const mods = formatProductModifiersSummary(p);
        const thumbSrc = p.imageUrl ? resolveAssetUrl(p.imageUrl) : '';
        let thumbEl;
        if (thumbSrc) {
          const img = document.createElement('img');
          img.className = 'product-thumb';
          img.src = thumbSrc;
          img.alt = p.name ? `Imagem de ${p.name}` : '';
          img.loading = 'lazy';
          img.addEventListener('error', () => {
            img.style.visibility = 'hidden';
          });
          wireImageZoom(img, p.name);
          thumbEl = img;
        } else {
          thumbEl = document.createElement('span');
          thumbEl.className = 'product-thumb product-thumb-empty';
          thumbEl.title = 'Sem imagem';
          thumbEl.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
        }
        const textEl = document.createElement('span');
        textEl.className = 'product-info-text';
        textEl.innerHTML =
          `<strong>${escapeHtml(p.name)}</strong> — ${escapeHtml(formatProductPriceLabel(p))}` +
          ` <small>[${escapeHtml(c.title)}]${avail}${hiddenMenu}</small>` +
          (ings ? `<br><small class="muted">${escapeHtml(ings)}</small>` : '') +
          (mods ? `<br><small class="muted">${escapeHtml(mods)}</small>` : '');
        info.appendChild(thumbEl);
        info.appendChild(textEl);

        const availWrap = document.createElement('label');
        availWrap.className = 'available-toggle';
        availWrap.title = 'Aparecer no cardápio digital e nos seletores do painel';
        const availCheck = document.createElement('input');
        availCheck.type = 'checkbox';
        availCheck.checked = p.available !== false;
        availCheck.addEventListener('change', async () => {
          if (availCheck.disabled) return;
          availCheck.disabled = true;
          const checked = availCheck.checked;
          try {
            const payload = {
              id: p.id,
              categoryId: c.id,
              name: p.name,
              price: Number(p.price) || 0,
              priceMedia: p.priceMedia != null ? Number(p.priceMedia) : null,
              priceInteira: p.priceInteira != null ? Number(p.priceInteira) : null,
              available: checked,
              showInMenu: p.showInMenu !== false,
              imageUrl: p.imageUrl || null,
              ingredientIds: (p.ingredients || []).map((i) => i.id)
            };
            const data = await api('/api/v1/admin/products', {
              method: 'PUT',
              headers: authHeaders(),
              body: JSON.stringify(payload)
            });
            if (data && Array.isArray(data.categories)) catalog = data;
            renderProducts();
            showAppToast(checked ? `${p.name} disponível no cardápio.` : `${p.name} indisponível (fora do cardápio).`, { ms: 2500 });
          } catch (err) {
            availCheck.checked = !checked;
            renderProducts();
            showAppToast(err.message || 'Falha ao atualizar disponibilidade');
          }
        });
        availWrap.appendChild(availCheck);
        availWrap.appendChild(document.createTextNode(' Disponível'));

        const actions = document.createElement('div');
        actions.className = 'item-actions';

        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Editar';
        edit.title = `Editar ${p.name}`;
        edit.addEventListener('click', () => startEditProduct(p, c.id));

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'danger';
        del.textContent = 'Excluir';
        del.addEventListener('click', async () => {
          const ok = await askConfirm(`Excluir ${p.name}?`, {
            title: 'Excluir produto',
            confirmLabel: 'Excluir'
          });
          if (!ok) return;
          try {
            await api(`/api/v1/admin/products/${encodeURIComponent(p.id)}`, {
              method: 'DELETE',
              headers: authHeaders()
            });
            if (editingProductId === p.id) resetProductForm();
            await refresh();
          } catch (err) {
            showAppToast(err.message || 'Falha ao excluir produto');
          }
        });

        actions.appendChild(edit);
        actions.appendChild(del);
        li.appendChild(info);
        li.appendChild(availWrap);
        li.appendChild(actions);
        list.appendChild(li);
      });
    });

    if (shown > 0 && !productSearch) {
      enableSortableList(list, {
        onReorder: (ids, categoryId) => reorderCatalogItems('product', ids, categoryId)
      });
    }

    if (shown === 0) {
      const empty = document.createElement('li');
      empty.innerHTML = productSearch
        ? '<span class="muted">Nenhum produto encontrado para a busca.</span>'
        : productCategoryFilter
          ? '<span class="muted">Nenhum produto nesta categoria.</span>'
          : '<span class="muted">Nenhum produto cadastrado.</span>';
      list.appendChild(empty);
    }

    if (editingProductId) {
      const still = (catalog.categories || []).some((c) =>
        (c.items || []).some((p) => p.id === editingProductId)
      );
      if (!still) resetProductForm();
    }
  }

    async function saveStore() {
    const latRaw = $('storeLat').value.trim();
    const lngRaw = $('storeLng').value.trim();
    const breadOptions = readBreadOptionsFromForm();
    if (!breadOptions.length) {
      throw new Error('Não foi possível ler as opções de pão do formulário. Atualize a página (Ctrl+F5) e tente novamente.');
    }
    const storeName = $('storeName').value.trim();
    if (!storeName) throw new Error('Informe o nome da loja.');
    const logoUrl = $('logoUrl').value.trim();
    const iconUrl = ($('iconUrl')?.value || '').trim();
    if (!isAllowedAssetUrl(logoUrl)) {
      throw new Error('Logo URL inválida (use https:// ou /uploads/...).');
    }
    if (!isAllowedAssetUrl(iconUrl)) {
      throw new Error('Ícone URL inválido (use https:// ou /uploads/...).');
    }
    const latitude = latRaw === '' ? null : Number(latRaw);
    const longitude = lngRaw === '' ? null : Number(lngRaw);
    if (latitude != null && (Number.isNaN(latitude) || latitude < -90 || latitude > 90)) {
      throw new Error('Latitude inválida.');
    }
    if (longitude != null && (Number.isNaN(longitude) || longitude < -180 || longitude > 180)) {
      throw new Error('Longitude inválida.');
    }
    const deliveryFeePerKm = Number($('deliveryFeePerKm').value || 0);
    const minDeliveryFee = Number($('minDeliveryFee').value || 0);
    const maxDeliveryKm = Number($('maxDeliveryKm').value || 0);
    if (deliveryFeePerKm < 0 || minDeliveryFee < 0 || maxDeliveryKm < 0) {
      throw new Error('Taxas e distância não podem ser negativas.');
    }
    const payload = {
      storeName,
      whatsapp: $('whatsapp').value.trim(),
      pixKey: $('pixKey').value.trim(),
      pixKeyLabel: $('pixKeyLabel').value.trim(),
      logoUrl,
      iconUrl,
      address: $('storeAddress').value.trim(),
      cep: maskCep($('storeCep').value.trim()),
      city: ($('storeCity')?.value || '').trim() || 'Ribeirão Preto',
      state: (($('storeState')?.value || 'SP').trim().toUpperCase() || 'SP').slice(0, 2),
      latitude,
      longitude,
      deliveryFeePerKm,
      minDeliveryFee,
      maxDeliveryKm,
      breadOptions,
      addressNumber: $('storeNumber').value.trim(),
      autoAdvancePreparing: $('autoAdvancePreparing')?.checked ?? false,
      autoAdvancePreparingMinutes: Math.max(1, Number($('autoAdvancePreparingMinutes')?.value) || 5),
      dineInEnabled: $('dineInEnabled')?.checked ?? false,
      customerQrOrdersEnabled: $('customerQrOrdersEnabled')?.checked ?? false,
      waiterOrdersEnabled: $('waiterOrdersEnabled')?.checked ?? false,
      allowManualTableEntry: $('allowManualTableEntry')?.checked ?? false,
      requireCustomerNameForQrOrder: $('requireCustomerNameForQrOrder')?.checked ?? false,
      allowCustomerChooseWaiter: $('allowCustomerChooseWaiter')?.checked ?? false,
      tableCount: $('tableCount') && $('tableCount').value !== '' ? Number($('tableCount').value) : null,
      waiterSessionHours: $('waiterSessionHours') && $('waiterSessionHours').value !== '' ? Math.max(1, Math.min(24, Number($('waiterSessionHours').value) || 8)) : null,
      schedule: readScheduleFromForm()
    };

    const saved = await api('/api/v1/admin/store', {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(payload)
    });
    const file = $('logoFile').files[0];
    if (file) {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`${API}/api/v1/admin/logo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      if (!res.ok) throw new Error('Falha no upload da logo');
      const data = await res.json();
      $('logoUrl').value = data.logoUrl;
    }
    const iconFile = $('iconFile')?.files?.[0];
    if (iconFile) {
      const form = new FormData();
      form.append('file', iconFile);
      const res = await fetch(`${API}/api/v1/admin/icon`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      if (!res.ok) throw new Error('Falha no upload do ícone');
      const data = await res.json();
      if ($('iconUrl')) $('iconUrl').value = data.iconUrl;
      updateStoreIconUi(data.iconUrl);
      $('iconFile').value = '';
    }
    // Ao ativar (ou alterar o tempo de) avanço automático, aplica/agenda aos pedidos já "Confirmado"
    if (payload.autoAdvancePreparing) {
      try {
        const rr = await api('/api/v1/orders/admin/auto-advance/refresh', {
          method: 'POST',
          headers: authHeaders()
        });
        $('autoAdvanceStatus').textContent = (rr && rr.promoted > 0)
          ? `${rr.promoted} pedido(s) avançado(s) automaticamente.`
          : 'Avanço automático aplicado aos pedidos confirmados.';
      } catch (_) { /* best-effort: não quebra o save */ }
    }
    if (saved) {
      storeConfig = saved;
      // Se houve upload de ícone, PATCH anterior pode estar sem iconUrl — recarrega
      if (iconFile) {
        try {
          const fresh = await api('/api/v1/store');
          storeConfig = fresh || storeConfig;
        } catch (_) { /* ignore */ }
      }
      fillStoreForm(storeConfig);
    } else {
      storeConfig = { ...storeConfig, ...payload };
      fillBreadOptions(payload.breadOptions);
      updateStoreIconUi(storeConfig.iconUrl || '');
    }
    const savedSchedule = storeConfig?.schedule || payload.schedule || {};
    const daysShort = formatScheduleDaysShort(savedSchedule.days || []);
    const openLabel = savedSchedule.open || payload.schedule?.open || '--:--';
    const closeLabel = savedSchedule.close || payload.schedule?.close || '--:--';
    const openNow = isStoreOpenNow(storeConfig);
    const onBreak = isStoreOnBreakNow(storeConfig);
    const statusEl = $('storeSaveStatus');
    const stateLabel = !openNow ? 'fechada' : (onBreak ? 'em intervalo' : 'aberta');
    const summary =
      `Salvo: ${daysShort}, ${openLabel}–${closeLabel}. ` +
      `Agora (SP): ${stateLabel}.`;
    if (statusEl) statusEl.textContent = summary;
    else showAppToast(summary);
    // Provê automaticamente as mesas informadas em "Usar mesas" (idempotente, apenas quando ativo)
    if (payload.dineInEnabled && payload.tableCount > 0) {
      try {
        const created = await ensureTablesForCount(payload.tableCount);
        if (created > 0) {
          if (loadTablesTab) loadTablesTab().catch(() => {});
        }
      } catch (e) {
        console.warn('Falha ao criar mesas automaticamente', e);
      }
    }
    // Reavalia a visibilidade da aba Mesas conforme o estado salvo de dine-in
    loadStoreConfigTablesFlags().catch(() => {});
    await refresh();
  }

  async function geocodeStoreAddress() {
    rebuildStoreAddressFromCepCache();
    const cep = onlyDigits($('storeCep').value);
    const query = cep.length === 8 ? cep : $('storeAddress').value.trim();
    const status = $('geocodeStoreStatus');
    if (!query) throw new Error('Informe o CEP/endereço físico da loja.');
    if (status) status.textContent = 'Buscando coordenadas…';

    // Preferência: CEP via API (rápido). Endereço longo só como fallback.
    const data = await api('/api/v1/geo/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ query })
    });
    $('storeLat').value = data.latitude;
    $('storeLng').value = data.longitude;
    if (status) status.textContent = `Coordenadas: ${data.latitude}, ${data.longitude}`;
  }

  function namesMatch(a, b) {
    return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  }

  function normalizeLabel(value) {
    return String(value || '')
      .trim()
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');
  }

  function isIngredientsCategoryName(id, title) {
    const names = new Set(['ingredientes', 'ingrediente', 'ingredients', 'ingredient']);
    return names.has(normalizeLabel(title)) || names.has(normalizeLabel(id));
  }

  async function saveCategory() {
    const title = $('catTitle').value.trim();
    if (!title) throw new Error('Informe o título da categoria.');
    if (isIngredientsCategoryName(editingCategoryId || '', title)) {
      throw new Error('Ingredientes não são categoria do cardápio. Use a aba Ingredientes.');
    }

    // Novo: id vazio → API gera auto-increment; edição mantém o id atual
    const id = editingCategoryId || '';
    const duplicateCat = (catalog.categories || []).some(
      (c) => c.id !== id && namesMatch(c.title, title)
    );
    if (duplicateCat) throw new Error(`Já existe uma categoria com o nome '${title}'.`);

    await api('/api/v1/admin/categories', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        id,
        title,
        showInMenu: $('catShowInMenu') ? $('catShowInMenu').checked : true
      })
    });
    resetCategoryForm();
    await refresh();
  }

  async function saveIngredient() {
    const name = $('ingName').value.trim();
    if (!name) throw new Error('Informe o nome do ingrediente.');

    // Novo: id vazio → API gera auto-increment; edição mantém o id atual
    const id = editingIngredientId || '';
    const duplicateIng = (ingredients || []).some(
      (i) => i.id !== id && namesMatch(i.name, name)
    );
    if (duplicateIng) throw new Error(`Já existe um ingrediente com o nome '${name}'.`);

    const fromProduct = creatingIngredientFromProduct;
    const selectedBefore = fromProduct ? readSelectedIngredientIds() : [];

    await api('/api/v1/admin/ingredients', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        id,
        name,
        available: $('ingAvailable') ? $('ingAvailable').checked : true
      })
    });
    resetIngredientForm();
    await refresh();

    if (fromProduct) {
      const created = (ingredients || []).find((i) => namesMatch(i.name, name));
      const selected = [...selectedBefore];
      if (created && !selected.includes(created.id)) selected.push(created.id);
      renderProductIngredients(selected);
      openProductModal();
    }
  }

  async function saveProduct() {
    if (productImageProcessing) {
      throw new Error('Aguarde a remoção de fundo da imagem terminar antes de salvar.');
    }
    const name = $('prodName').value.trim();
    const categoryId = $('prodCategory').value;
    if (!categoryId) {
      throw new Error('Selecione a categoria do produto.');
    }
    if (!name) {
      throw new Error('Informe o nome do produto.');
    }
    if (name.length > 120) throw new Error('Nome do produto muito longo (máx. 120).');

    const category = (catalog.categories || []).find((c) => c.id === categoryId);
    const duplicateProd = ((category && category.items) || []).some(
      (p) => p.id !== (editingProductId || '') && namesMatch(p.name, name)
    );
    if (duplicateProd) throw new Error(`Já existe um produto com o nome '${name}' nesta categoria.`);

    const portions = isPortionsCategory(category);
    let price = 0;
    let priceMedia = null;
    let priceInteira = null;

    if (portions) {
      priceMedia = Number($('prodPriceMedia').value);
      priceInteira = Number($('prodPriceInteira').value);
      if (!Number.isFinite(priceMedia) || priceMedia < 0) {
        throw new Error('Informe o preço da média.');
      }
      if (!Number.isFinite(priceInteira) || priceInteira < 0) {
        throw new Error('Informe o preço da inteira.');
      }
      price = Math.min(priceMedia, priceInteira);
    } else {
      price = Number($('prodPrice').value || 0);
      if (!Number.isFinite(price) || price < 0) {
        throw new Error('Preço do produto inválido.');
      }
    }

    let imageUrl = $('prodImageUrl').value.trim() || null;
    const imageFile = $('prodImageFile')?.files?.[0];
    const uploadFile = pendingProductImageBlob || imageFile;
    if (uploadFile) {
      const form = new FormData();
      form.append('file', uploadFile, uploadFile.name || 'product.png');
      form.append('name', name);
      form.append('currentImageUrl', $('prodImageUrl').value.trim() || '');
      const res = await fetch(`${API}/api/v1/admin/product-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form
      });
      if (!res.ok) {
        let message = 'Falha no upload da imagem';
        try {
          const parsed = await res.json();
          if (parsed && parsed.error) message = parsed.error;
        } catch (_) { /* ignora corpo não-JSON */ }
        throw new Error(message);
      }
      const data = await res.json();
      imageUrl = data.imageUrl || imageUrl;
    }
    if (imageUrl && !isAllowedAssetUrl(imageUrl)) {
      throw new Error('ImageUrl inválida (use https:// ou /uploads/...).');
    }

    const ingredientIds = readSelectedIngredientIds();

    // Novo produto: id vazio → API gera auto-increment; edição mantém o id atual
    const id = editingProductId || '';

    await api('/api/v1/admin/products', {
      method: 'PUT',
      headers: authHeaders(),
      body: JSON.stringify({
        id,
        categoryId,
        name,
        price,
        priceMedia,
        priceInteira,
        available: $('prodAvailable').checked,
        showInMenu: $('prodShowInMenu') ? $('prodShowInMenu').checked : true,
        imageUrl,
        ingredientIds,
        principalIngredientIds: readProductPrincipalIds(),
        modifierGroups: readProductModifierGroups()
      })
    });
    resetProductForm();
    await refresh();
  }

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab !== 'products') clearProductFilter();
      openTab(btn.dataset.tab);
      if (btn.dataset.tab === 'orders') {
        refreshOrders().catch((e) => showAppToast(e.message || 'Erro'));
      }
    });
  });

  const STORE_TAB_KEY = 'adminStoreTab';
  const STORE_TAB_ORDER = ['geral', 'funcionamento', 'endereco', 'impressao', 'painel'];
  function applyStoreTab(tabName) {
    const valid = STORE_TAB_ORDER.includes(tabName) ? tabName : 'geral';
    document.querySelectorAll('.store-tabbtn').forEach((btn) => {
      const active = btn.dataset.storeTab === valid;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    document.querySelectorAll('#tab-store .store-tabpanel').forEach((el) => {
      el.hidden = el.dataset.storePanel !== valid;
    });
    localStorage.setItem(STORE_TAB_KEY, valid);
  }
  function restoreStoreTab() {
    const saved = localStorage.getItem(STORE_TAB_KEY);
    applyStoreTab(STORE_TAB_ORDER.includes(saved) ? saved : 'geral');
  }
  document.querySelectorAll('#tab-store .store-tabbtn').forEach((btn) => {
    btn.addEventListener('click', () => applyStoreTab(btn.dataset.storeTab));
  });
  applyStoreTab('geral');

  document.querySelectorAll('[data-order-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setOrderFilter(btn.dataset.orderFilter);
    });
  });

  document.querySelectorAll('[data-fulfillment-filter]').forEach((btn) => {
    btn.addEventListener('click', () => {
      setFulfillmentFilter(btn.dataset.fulfillmentFilter);
    });
  });

  $('receiptCloseBtn')?.addEventListener('click', closeReceiptModal);
  $('receiptPrintBtn')?.addEventListener('click', () => printOrderReceipt());
  $('receiptPdfBtn')?.addEventListener('click', () => printOrderReceipt({ pdfHint: true }));
  $('receiptEscposBtn')?.addEventListener('click', () => {
    escposPrintOrder().catch((e) => showAppToast(e && e.message ? e.message : 'Falha na impressão direta.'));
  });
  $('receiptCopyBtn')?.addEventListener('click', () => {
    copyOrderReceiptText().catch((e) => showAppToast(e.message || 'Erro ao copiar'));
  });
  $('receiptWidthSelect')?.addEventListener('change', () => {
    const mm = $('receiptWidthSelect').value || '80';
    saveAdminPrefs({ receiptWidthMm: mm });
    applyReceiptWidth(mm);
    if (receiptPreviewOrder) {
      const preview = $('receiptPreview');
      if (preview) preview.innerHTML = buildOrderReceiptHtml(receiptPreviewOrder);
    }
  });
  $('receiptWidthSettings')?.addEventListener('change', () => {
    const mm = $('receiptWidthSettings').value || '80';
    saveAdminPrefs({ receiptWidthMm: mm });
    applyReceiptWidth(mm);
  });
  $('receiptTestBtn')?.addEventListener('click', () => {
    testReceiptCommunication();
  });
  $('receiptTestPickBtn')?.addEventListener('click', () => {
    pickReceiptPrinter();
  });
  $('receiptTestPrintBtn')?.addEventListener('click', () => {
    printReceiptTest();
  });
  $('receiptTestWindowsBtn')?.addEventListener('click', () => {
    printReceiptViaWindowsTest();
  });
  $('receiptPrinterSelect')?.addEventListener('change', async () => {
    const val = $('receiptPrinterSelect').value || 'windows';
    const prevMode = validReceiptMode();
    setReceiptTestStatus('');
    if (val === 'windows') {
      saveAdminPrefs({ receiptPrinterMode: 'windows', receiptEscpos: false });
      if ($('receiptEscpos')) $('receiptEscpos').checked = false;
      setReceiptTestStatus('Impressão via Windows (diálogo padrão).', true);
    } else {
      const supported = val === 'serial' ? isSerialSupported() : isEscposSupported();
      if (!supported) {
        setReceiptTestStatus(directModeUnsupportedMessage(val), false);
        refreshReceiptPrinterSelect();
        return;
      }
      const already = val === 'serial'
        ? SerialPosPrinter.normalizeSaved(adminPrefs.receiptSerialPort)
        : EscPosPrinter.normalizeSaved(adminPrefs.receiptUsbDevice);
      if (!already) {
        // Seleciona primeiro; se cancelar, volta ao modo anterior.
        const ok = val === 'serial' ? await pickSerialPrinter() : await pickReceiptPrinter();
        if (!ok) {
          saveAdminPrefs({ receiptPrinterMode: prevMode, receiptEscpos: prevMode !== 'windows' });
          if ($('receiptEscpos')) $('receiptEscpos').checked = prevMode !== 'windows';
          refreshReceiptPrinterSelect();
          return;
        }
      }
      saveAdminPrefs({ receiptPrinterMode: val, receiptEscpos: true });
      if ($('receiptEscpos')) $('receiptEscpos').checked = true;
      setReceiptTestStatus(val === 'serial' ? 'Porta serial ativada.' : 'USB direto (WebUSB) ativado.', true);
    }
    refreshReceiptPrinterSelect();
  });
  $('receiptEscpos')?.addEventListener('change', () => {
    const checked = !!$('receiptEscpos').checked;
    if (checked) {
      const cur = validReceiptMode();
      const mode = (cur === 'usb' || cur === 'serial') ? cur : 'usb';
      saveAdminPrefs({ receiptPrinterMode: mode, receiptEscpos: true });
      if (mode === 'serial' && !SerialPosPrinter.normalizeSaved(adminPrefs.receiptSerialPort)) {
        pickSerialPrinter();
      } else if (mode === 'usb' && !EscPosPrinter.normalizeSaved(adminPrefs.receiptUsbDevice)) {
        pickReceiptPrinter();
      }
    } else {
      saveAdminPrefs({ receiptPrinterMode: 'windows', receiptEscpos: false });
    }
    refreshReceiptPrinterSelect();
  });
  $('receiptSerialPickBtn')?.addEventListener('click', () => {
    pickSerialPrinter();
  });
  $('receiptSerialBaud')?.addEventListener('change', () => {
    const baud = Number($('receiptSerialBaud')?.value);
    if ([9600, 19200, 38400].includes(baud)) {
      saveAdminPrefs({ receiptSerialBaud: baud });
      setReceiptTestStatus(`Velocidade da porta serial: ${baud} baud.`, true);
    }
  });
  $('receiptCustomBtn')?.addEventListener('click', () => {
    const panel = $('receiptCustomPanel');
    if (!panel) return;
    panel.hidden = !panel.hidden;
    if (!panel.hidden) applyAdminPrefsToForm();
  });
  $('receiptCustomPanel')?.addEventListener('input', () => {
    saveAdminPrefs(readReceiptPrefsFromModalPanel());
    if (receiptPreviewOrder) {
      const preview = $('receiptPreview');
      if (preview) preview.innerHTML = buildOrderReceiptHtml(receiptPreviewOrder);
    }
  });
  $('receiptModal')?.addEventListener('click', (e) => {
    if (e.target === $('receiptModal')) closeReceiptModal();
  });

  $('snoozeAlertsBtn')?.addEventListener('click', () => snoozeAlerts());
  $('enableNotifyBtn')?.addEventListener('click', async () => {
    const audioOk = await unlockAudioFromGesture();
    const ok = await ensureDesktopNotificationPermission();
    saveAdminPrefs({
      desktopNotify: ok,
      playSoundWhenHidden: true
    });
    applyAdminPrefsToForm();
    updateNotifyControlUi();
    if (audioOk) playNewOrderSound();
    showAppToast(ok
      ? (audioOk
        ? 'Notificações e som liberados. Você deve ter ouvido um bip de teste.'
        : 'Notificações ok. Clique em qualquer lugar do painel para liberar o som.')
      : 'Notificações bloqueadas ou indisponíveis. Libere nas configurações do navegador.');
  });

  const clearFilterBtn = $('clearProductFilterBtn');
  if (clearFilterBtn) {
    clearFilterBtn.addEventListener('click', clearProductFilter);
  }

  const productFilterSel = $('productCategoryFilter');
  if (productFilterSel) {
    productFilterSel.addEventListener('change', () => {
      const value = productFilterSel.value;
      if (!value) {
        clearProductFilter();
        return;
      }
      productCategoryFilter = value;
      const match = (catalog.categories || []).find((c) => c.id === value);
      updateProductFilterBar(match ? match.title : value);
      renderProducts();
    });
  }

  const productSearchInput = $('productSearch');
  if (productSearchInput) {
    productSearchInput.addEventListener('input', () => {
      productSearch = productSearchInput.value.trim().toLowerCase();
      renderProducts();
    });
  }

  const categorySearchInput = $('categorySearch');
  if (categorySearchInput) {
    categorySearchInput.addEventListener('input', () => {
      categorySearch = categorySearchInput.value.trim().toLowerCase();
      renderCategories();
    });
  }

  const ingredientSearchInput = $('ingredientSearch');
  if (ingredientSearchInput) {
    ingredientSearchInput.addEventListener('input', () => {
      ingredientSearch = ingredientSearchInput.value.trim().toLowerCase();
      renderIngredients();
    });
  }

  const opcionalSearchInput = $('opcionalSearch');
  if (opcionalSearchInput) {
    opcionalSearchInput.addEventListener('input', () => {
      opcionalSearch = opcionalSearchInput.value.trim().toLowerCase();
      renderOpcionais();
    });
  }

  const refreshOrdersBtn = $('refreshOrdersBtn');
  if (refreshOrdersBtn) {
    refreshOrdersBtn.addEventListener('click', () => {
      refreshOrders().catch((e) => showAppToast(e.message || 'Erro ao atualizar'));
    });
  }

  const newTableBtn = $('newTableBtn');
  if (newTableBtn) {
    newTableBtn.addEventListener('click', () => openTableModal(null));
  }

  const refreshTablesBtn = $('refreshTablesBtn');
  if (refreshTablesBtn) {
    refreshTablesBtn.addEventListener('click', () => {
      loadTablesTab().catch((e) => showAppToast(e.message || 'Erro ao atualizar mesas'));
    });
  }

  const refreshTeamBtn = $('refreshTeamBtn');
  if (refreshTeamBtn) {
    refreshTeamBtn.addEventListener('click', () => {
      loadTeam().catch((e) => showAppToast(e.message || 'Erro ao atualizar equipe'));
    });
  }
  const teamAddBtn = $('teamAddBtn');
  if (teamAddBtn) {
    teamAddBtn.addEventListener('click', () => {
      addTeamUser().then((created) => { if (created) loadTeam(); }).catch((e) => showAppToast(e.message || 'Erro'));
    });
  }

  const useTablesToggle = $('useTablesEnabled');
  if (useTablesToggle) {
    useTablesToggle.addEventListener('change', () => {
      updateTablesUsageUi();
      const dineIn = $('dineInEnabled');
      if (dineIn) dineIn.checked = useTablesToggle.checked;
    });
  }
  const dineInToggle = $('dineInEnabled');
  if (dineInToggle) {
    dineInToggle.addEventListener('change', () => {
      if (useTablesToggle) useTablesToggle.checked = dineInToggle.checked;
      updateTablesUsageUi();
    });
  }
  updateTablesUsageUi();

  const newTableOrderBtn = $('newTableOrderBtn');
  if (newTableOrderBtn) {
    newTableOrderBtn.addEventListener('click', () => {
      openTab('mesas');
    });
  }

  document.querySelectorAll('[data-channel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      openChannelMenu(btn.dataset.channel);
    });
  });

  const ordersLiveBadge = $('ordersLiveBadge');
  if (ordersLiveBadge) {
    ordersLiveBadge.style.cursor = 'pointer';
    ordersLiveBadge.addEventListener('click', () => {
      toggleExpedienteFromBadge().catch((e) => showAppToast(e.message || 'Erro'));
    });
  }

  const refreshDashboardBtn = $('refreshDashboardBtn');
  if (refreshDashboardBtn) {
    refreshDashboardBtn.addEventListener('click', () => {
      loadDashboard().catch((e) => showAppToast(e.message || 'Erro'));
    });
  }
  const dashboardDaysEl = $('dashboardDays');
  if (dashboardDaysEl) {
    dashboardDaysEl.addEventListener('change', () => {
      loadDashboard().catch((e) => showAppToast(e.message || 'Erro'));
    });
  }
  const exportMenu = $('dashboardExportMenu');
  const exportBtn = $('exportDashboardBtn');
  const exportOptions = $('dashboardExportOptions');
  if (exportMenu && exportBtn && exportOptions) {
    const closeMenu = () => {
      exportOptions.hidden = true;
      exportBtn.setAttribute('aria-expanded', 'false');
    };
    exportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const show = exportOptions.hidden;
      exportOptions.hidden = !show;
      exportBtn.setAttribute('aria-expanded', String(show));
    });
    exportOptions.addEventListener('click', (e) => {
      const opt = e.target.closest('[data-export]');
      if (!opt) return;
      exportDashboardData(opt.getAttribute('data-export'));
      closeMenu();
    });
    document.addEventListener('click', closeMenu);
  }
  const refreshPlatformDashBtn = $('refreshPlatformDashBtn');
  if (refreshPlatformDashBtn) {
    refreshPlatformDashBtn.addEventListener('click', () => {
      loadPlatformDashboard().catch((e) => showAppToast(e.message || 'Erro'));
    });
  }
  const platformDashGoLojas = $('platformDashGoLojas');
  if (platformDashGoLojas) {
    platformDashGoLojas.addEventListener('click', () => openTab('lojas'));
  }

  $('exportCatalogBtn')?.addEventListener('click', () => {
    try { exportCatalogBackup(); }
    catch (e) { showAppToast(e.message || 'Falha ao exportar'); }
  });
  $('newCategoryBtn')?.addEventListener('click', startNewCategory);
  $('newProductBtn')?.addEventListener('click', startNewProduct);
  $('newIngredientBtn')?.addEventListener('click', startNewIngredient);
  $('newOpcionalBtn')?.addEventListener('click', startNewOpcional);
  $('prodNewIngredientBtn')?.addEventListener('click', startNewIngredientFromProduct);
  $('prodAddIngredientBtn')?.addEventListener('click', openIngredientPicker);
  $('prodIngredientPickerConfirmBtn')?.addEventListener('click', applyIngredientPicker);
  $('prodIngredientPickerCancelBtn')?.addEventListener('click', closeIngredientPicker);
  $('prodAddOptionBtn')?.addEventListener('click', openOpcionalPicker);
  $('prodNewOptionBtn')?.addEventListener('click', openNewOpcionalModal);
  $('prodOpcionalPickerConfirmBtn')?.addEventListener('click', applyOpcionalPicker);
  $('prodOpcionalPickerCancelBtn')?.addEventListener('click', closeOpcionalPicker);
  $('prodNewOpcionalConfirmBtn')?.addEventListener('click', applyNewOpcional);
  $('prodNewOpcionalCancelBtn')?.addEventListener('click', closeNewOpcionalModal);
  $('cancelCatBtn')?.addEventListener('click', () => resetCategoryForm());
  $('cancelProdBtn')?.addEventListener('click', () => guardedCloseProductForm());
  $('prodImageFile')?.addEventListener('change', () => {
    const file = $('prodImageFile').files[0];
    const preview = $('prodImagePreview');
    if (!file || !preview) return;
    clearPendingProductImage();
    pendingProductImageBlob = file;
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.src = e.target.result;
      preview.hidden = false;
    };
    reader.readAsDataURL(file);
    processProductImageWithAi(file);
  });
  $('prodImageRemoveBtn')?.addEventListener('click', () => {
    if ($('prodImageFile')) $('prodImageFile').value = '';
    if ($('prodImageUrl')) $('prodImageUrl').value = '';
    clearPendingProductImage();
    updateProductImageUi('');
  });
  $('prodCategory')?.addEventListener('change', syncProductPriceFields);
  $('cancelIngBtn')?.addEventListener('click', () => resetIngredientForm());
  $('cancelOpcionalBtn')?.addEventListener('click', () => resetOpcionalForm());
  $('opcionalModal')?.addEventListener('click', (e) => {
    if (e.target === $('opcionalModal')) resetOpcionalForm();
  });
  $('categoryModal')?.addEventListener('click', (e) => {
    if (e.target === $('categoryModal')) resetCategoryForm();
  });
  $('productModal')?.addEventListener('click', (e) => {
    if (e.target === $('productModal')) guardedCloseProductForm();
  });
  $('ingredientModal')?.addEventListener('click', (e) => {
    if (e.target === $('ingredientModal')) resetIngredientForm();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('appConfirmModal')) return;
      if ($('receiptModal') && !$('receiptModal').hidden) {
        closeReceiptModal();
        return;
      }
      if ($('ingredientModal') && !$('ingredientModal').hidden) {
        resetIngredientForm();
        return;
      }
      if ($('opcionalModal') && !$('opcionalModal').hidden) {
        resetOpcionalForm();
        return;
      }
      if ($('categoryModal') && !$('categoryModal').hidden) resetCategoryForm();
      if ($('productModal') && !$('productModal').hidden) guardedCloseProductForm();
      return;
    }
    if (e.key === 'Enter') {
      const tag = String(e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) return;
      if ($('appConfirmModal') || $('paymentMethodModal')) return;
      if ($('loginView') && !$('loginView').hidden) return;
      confirmFirstWaitingOrder().catch((err) => showAppToast(err.message || 'Erro'));
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      unlockAudioFromGesture().finally(() => {
        if (hasUnacceptedOrders()) playNewOrderSound();
        if (ordersNearDeliveryLimit().length) playSirenSound();
        syncNewOrderAlerts();
        syncSlaAlerts();
      });
    } else if (!adminPrefs.playSoundWhenHidden) {
      stopSirenSound();
    }
  });
  $('loginBtn').addEventListener('click', login);
  $('password').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') login();
  });
  $('logoutBtn').addEventListener('click', logout);
  $('saveStoreBtn').addEventListener('click', () => {
    saveAdminPrefs(readAdminPrefsFromForm());
    syncSlaAlerts();
    renderOrdersBoard();
    updateNotifyControlUi();
    saveStore().catch((e) => showAppToast(e.message || 'Erro'));
  });
  const iconUrlInput = $('iconUrl');
  if (iconUrlInput) {
    iconUrlInput.addEventListener('input', () => updateStoreIconUi(iconUrlInput.value.trim()));
    iconUrlInput.addEventListener('change', () => updateStoreIconUi(iconUrlInput.value.trim()));
  }
  const iconFileInput = $('iconFile');
  if (iconFileInput) {
    iconFileInput.addEventListener('change', () => {
      const file = iconFileInput.files && iconFileInput.files[0];
      if (!file) return;
      const previewUrl = URL.createObjectURL(file);
      const preview = $('storeIconPreview');
      if (preview) {
        preview.src = previewUrl;
        preview.hidden = false;
      }
      applyDocumentIcon(previewUrl);
    });
  }
  const geocodeBtn = $('geocodeStoreBtn');
  if (geocodeBtn) {
    geocodeBtn.addEventListener('click', () => geocodeStoreAddress().catch((e) => {
      const status = $('geocodeStoreStatus');
      if (status) status.textContent = e.message || 'Falha na geocodificação';
      showAppToast(e.message || 'Erro');
    }));
  }
  const storeCep = $('storeCep');
  if (storeCep) {
    storeCep.addEventListener('input', () => {
      storeCep.value = maskCep(storeCep.value);
      if (onlyDigits(storeCep.value).length === 8) {
        buscarCepLoja().catch((e) => {
          const status = $('storeCepStatus');
          if (status) status.textContent = e.message || 'Falha ao buscar CEP';
        });
      }
    });
    storeCep.addEventListener('blur', () => {
      buscarCepLoja().catch((e) => {
        const status = $('storeCepStatus');
        if (status) status.textContent = e.message || 'Falha ao buscar CEP';
      });
    });
  }
  const storeNumber = $('storeNumber');
  if (storeNumber) {
    storeNumber.addEventListener('blur', () => {
      if (lastCepData) {
        rebuildStoreAddressFromCepCache();
      }
    });
  }
  ensureScheduleDayRows();
  $('saveCatBtn').addEventListener('click', () => saveCategory().catch((e) => showAppToast(e.message || 'Erro')));
  $('saveProdBtn').addEventListener('click', () => saveProduct().catch((e) => showAppToast(e.message || 'Erro')));
  $('saveIngBtn')?.addEventListener('click', () => saveIngredient().catch((e) => showAppToast(e.message || 'Erro')));
  $('saveOpcionalBtn')?.addEventListener('click', () => saveOpcional().catch((e) => showAppToast(e.message || 'Erro')));

  const newPlatformBtn = $('newPlatformStoreBtn');
  if (newPlatformBtn) {
    newPlatformBtn.addEventListener('click', () => showPlatformStoreForm(null));
  }
  const refreshPlatformBtn = $('refreshPlatformStoresBtn');
  if (refreshPlatformBtn) {
    refreshPlatformBtn.addEventListener('click', () => loadPlatformStores().catch((e) => showAppToast(e.message || 'Erro')));
  }
  $('platformSearch')?.addEventListener('input', () => renderPlatformStores());
  $('platformFilterStatus')?.addEventListener('change', () => renderPlatformStores());
  $('platformFilterPlan')?.addEventListener('change', () => renderPlatformStores());
  $('platformFilterSegment')?.addEventListener('change', () => renderPlatformStores());
  $('platformSegmento')?.addEventListener('change', () => {
    const custom = $('platformSegmento').value === '__custom__';
    $('platformSegmentoCustomWrap').hidden = !custom;
    if (custom) $('platformSegmentoCustom').focus();
  });
  const savePlatformBtn = $('savePlatformStoreBtn');
  if (savePlatformBtn) {
    savePlatformBtn.addEventListener('click', () => savePlatformStore().catch((e) => showAppToast(e.message || 'Erro')));
  }
  const cancelPlatformBtn = $('cancelPlatformStoreBtn');
  if (cancelPlatformBtn) {
    cancelPlatformBtn.addEventListener('click', resetPlatformStoreForm);
  }
  $('platformModalCloseBtn')?.addEventListener('click', resetPlatformStoreForm);
  document.querySelectorAll('.platform-modal-tabs button').forEach((btn) => {
    btn.addEventListener('click', () => switchPlatformModalTab(btn.dataset.ptab));
  });
  $('platformCnpj')?.addEventListener('input', () => { $('platformCnpj').value = maskCnpj($('platformCnpj').value); });
  $('platformPhone')?.addEventListener('input', () => { $('platformPhone').value = maskPhone($('platformPhone').value); });
  $('platformCep')?.addEventListener('input', () => { $('platformCep').value = maskCep($('platformCep').value); });
  $('platformLogoFile')?.addEventListener('change', () => {
    uploadPlatformLogo($('platformLogoFile').files[0]).catch((e) => showAppToast(e.message || 'Erro'));
  });
  $('platformGalleryAddBtn')?.addEventListener('click', () => addPlatformGalleryImage().catch((e) => showAppToast(e.message || 'Erro')));
  $('platformUserAddBtn')?.addEventListener('click', () => addPlatformUser().catch((e) => showAppToast(e.message || 'Erro')));
  const courtesyEl = $('platformCourtesy');
  if (courtesyEl) {
    courtesyEl.addEventListener('change', () => {
      if (courtesyEl.checked) $('platformPaymentStatus').value = 'courtesy';
    });
  }

  // ==== Banco de dados (Dev) ====
  $('bankStoreSelect')?.addEventListener('change', () => {
    bankStoreId = $('bankStoreSelect').value;
    const opt = $('bankStoreSelect').selectedOptions[0];
    bankStoreLabel = opt ? opt.textContent : '';
    bankPage = 1;
    loadBankRows().catch((e) => console.warn('Banco rows', e));
  });
  $('bankTableSelect')?.addEventListener('change', () => selectBankTable($('bankTableSelect').value));
  $('bankRefreshBtn')?.addEventListener('click', () => loadBankRows().catch((e) => console.warn('Banco rows', e)));
  $('bankNewRowBtn')?.addEventListener('click', openBankNewRow);
  let bankSearchTimer = null;
  $('bankSearchInput')?.addEventListener('input', () => {
    clearTimeout(bankSearchTimer);
    bankSearchTimer = setTimeout(() => {
      bankPage = 1;
      loadBankRows().catch((e) => console.warn('Banco rows', e));
    }, 400);
  });
  $('bankPrevBtn')?.addEventListener('click', () => {
    if (bankPage > 1) { bankPage -= 1; loadBankRows().catch((e) => console.warn('Banco rows', e)); }
  });
  $('bankNextBtn')?.addEventListener('click', () => {
    bankPage += 1;
    loadBankRows().catch((e) => console.warn('Banco rows', e));
  });
  $('bankRowsBody')?.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-bank-edit]');
    const delBtn = e.target.closest('[data-bank-delete]');
    if (editBtn) {
      const row = bankRows[Number(editBtn.dataset.bankEdit)];
      if (row) openBankEditRow(row);
    } else if (delBtn) {
      const row = bankRows[Number(delBtn.dataset.bankDelete)];
      if (row) deleteBankRow(row).catch((err) => showAppToast(err.message || 'Falha ao excluir.', 'error'));
    }
  });
  $('bankRowCloseBtn')?.addEventListener('click', () => { $('bankRowModal').hidden = true; });
  $('bankRowCancelBtn')?.addEventListener('click', () => { $('bankRowModal').hidden = true; });
  $('bankRowSaveBtn')?.addEventListener('click', () => saveBankRow().catch((e) => console.warn('Banco save', e)));
  $('bankRowModal')?.addEventListener('click', (e) => {
    if (e.target === $('bankRowModal')) $('bankRowModal').hidden = true;
  });

  // Liberar áudio após interação (política dos browsers) — sem once, reforça se ainda estiver suspenso
  ['pointerdown', 'keydown'].forEach((evt) => {
    document.addEventListener(evt, () => { unlockAudioFromGesture(); }, { passive: true });
  });

  // ==== Topbar / menu do usuário / drawer ====
  const userMenuBtn = $('userMenuBtn');
  if (userMenuBtn) {
    userMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = $('userDropdown');
      if (dd && dd.hidden) openUserDropdown();
      else closeUserDropdown();
    });
  }
  const drawerBackdropEl = $('drawerBackdrop');
  if (drawerBackdropEl) drawerBackdropEl.addEventListener('click', closeDrawer);
  $('sidebarToggleBtn')?.addEventListener('click', openDrawer);
  $('drawerCloseBtn')?.addEventListener('click', closeDrawer);
  const appViewEl = $('appView');
  const sidebarCollapseBtn = $('sidebarCollapseBtn');
  function applySidebarCollapsed(collapsed) {
    if (!appViewEl) return;
    appViewEl.classList.toggle('sidebar-collapsed', collapsed);
    if (sidebarCollapseBtn) {
      sidebarCollapseBtn.textContent = collapsed ? '»' : '«';
      sidebarCollapseBtn.setAttribute('aria-label', collapsed ? 'Expandir menu lateral' : 'Reduzir menu lateral');
      sidebarCollapseBtn.title = collapsed ? 'Expandir menu lateral' : 'Reduzir menu lateral';
    }
    try { localStorage.setItem('adminSidebarCollapsed', collapsed ? '1' : '0'); } catch (_) {}
  }
  sidebarCollapseBtn?.addEventListener('click', () => {
    if (appViewEl) applySidebarCollapsed(!appViewEl.classList.contains('sidebar-collapsed'));
  });
  try {
    if (localStorage.getItem('adminSidebarCollapsed') === '1') applySidebarCollapsed(true);
  } catch (_) {}
  document.querySelectorAll('nav [data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => closeDrawer());
  });
  document.querySelectorAll('#userDropdown [data-user-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.userAction;
      if (action === 'logout') logout();
      else if (action === 'store') { closeUserDropdown(); openTab('store'); }
      else closeUserDropdown();
    });
  });
  document.querySelectorAll('#userDropdown [data-switch-to]').forEach((btn) => {
    btn.addEventListener('click', () => switchProfile(btn.dataset.switchTo));
  });
  $('profileSwitcherBack')?.addEventListener('click', restoreDevProfile);
  document.addEventListener('click', (e) => {
    const btn = $('userMenuBtn');
    if (btn && !btn.contains(e.target)) closeUserDropdown();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeUserDropdown();
      closeDrawer();
    }
  });

  loadAdminPrefs();
  loadPinSessionFromStorage();
  applyAdminPrefsToForm();
  if ($('receiptWidthSelect')) $('receiptWidthSelect').value = adminPrefs.receiptWidthMm;
  applyReceiptWidth(adminPrefs.receiptWidthMm);
  updateReceiptEscposUi();
  updateAlertsMuteUi();

  showApp(false);
  const _bootProfile = new URLSearchParams(window.location.search).get('profile');
  if (_bootProfile && DEV_PROFILES[_bootProfile]) {
    loginAsProfile(_bootProfile);
  } else {
    tryRestoreSession();
  }
})();
