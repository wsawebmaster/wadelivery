// ===========================================================================
// delivery-qr-modal.js — componente ÚNICO do modal "Delivery · Cardápio
// digital" (QR Code + copiar/abrir).
//
// Fonte única de verdade usada por AMBOS os apps:
//   - admin      (painel; showDeliveryQrModal)
//   - storefront (tela garçom; enterDeliveryQrGate)
// NÃO duplique o corpo do modal nesses apps — cada um só chama
// DeliveryQrModal.show({ url, ... }) com a URL já resolvida (o app resolve,
// o componente injeta — conforme decisão recomendada aprovada).
//
// Autossuficiente por design: estilos 100% inline, escape próprio e QR gerado
// pela API pública api.qrserver.com (a mesma usada hoje em ambos os apps).
//
// API:
//   DeliveryQrModal.show({
//     url,          // link final do cardápio digital (cada app resolve e injeta)
//     title?,       // 'Delivery · Cardápio digital'
//     subtitle?,    // instrução de escaneio
//     imgSize?,     // lado do QR (px), padrão 240
//     copyLabel?,   // 'Copiar link'
//     openLabel?,   // 'Abrir cardápio'
//     toast?,       // (msg) => void — avisos (copiado/erro). Opcional.
//   }) // → { close }
// Fecha por: ✕, Escape, Enter (abre), clique no backdrop ou handle.close().
// ===========================================================================
(function () {
  'use strict';

  // Data URL da imagem QR Code (mesma API pública do admin: api.qrserver.com).
  function qrServerDataUrl(text, size = 240) {
    return `https://api.qrserver.com/v1/create-qr-code/?size=${size}x${size}&data=${encodeURIComponent(text)}&margin=8`;
  }

  function show(options) {
    const opts = options || {};
    const prior = document.getElementById('deliveryQrSharedModal');
    if (prior) prior.remove();
    const url = String(opts.url || '').trim();
    if (!url) {
      if (typeof opts.toast === 'function') opts.toast('Link do cardápio digital indisponível.');
      return null;
    }
    const title = opts.title || 'Delivery · Cardápio digital';
    const subtitle =
      opts.subtitle ||
      'Escaneie o QR Code para abrir o cardápio digital da loja no celular:';
    const imgSize = Number(opts.imgSize) || 240;
    const copyLabel = opts.copyLabel || 'Copiar link';
    const openLabel = opts.openLabel || 'Abrir cardápio';
    const toast = typeof opts.toast === 'function' ? opts.toast : function () {};
    const img = qrServerDataUrl(url, imgSize);

    const overlay = document.createElement('div');
    overlay.id = 'deliveryQrSharedModal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'deliveryQrSharedTitle');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:10050;display:flex;align-items:center;' +
      'justify-content:center;padding:1rem;background:rgba(15,15,15,.55);';

    const card = document.createElement('div');
    card.style.cssText =
      'position:relative;display:flex;flex-direction:column;' +
      'max-width:min(430px,94vw);width:100%;box-sizing:border-box;' +
      'background:#fff;color:#1c1c1c;border-radius:12px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.28);padding:1.1rem 1.2rem 1.2rem;';

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Fechar');
    closeBtn.style.cssText =
      'position:absolute;top:.25rem;right:.6rem;border:none;background:transparent;' +
      'font-size:1.2rem;line-height:1;width:30px;height:30px;' +
      'display:flex;align-items:center;justify-content:center;' +
      'color:#8a8a8a;cursor:pointer;padding:0;';

    const titleEl = document.createElement('h2');
    titleEl.id = 'deliveryQrSharedTitle';
    titleEl.textContent = title;
    titleEl.style.cssText =
      'margin:0 0 .2rem;font-size:1.1rem;color:#1c1c1c;padding-right:2rem;';

    const subEl = document.createElement('p');
    subEl.textContent = subtitle;
    subEl.style.cssText = 'margin:0 0 .65rem;color:#666;font-size:.9rem;';

    const imgWrap = document.createElement('div');
    imgWrap.style.cssText = 'text-align:center;margin:0 0 .6rem;';
    const imgEl = document.createElement('img');
    imgEl.alt = 'QR Code do cardápio digital da loja';
    imgEl.src = img;
    imgEl.width = imgSize;
    imgEl.height = imgSize;
    imgEl.style.cssText =
      'width:min(220px,60vw);height:auto;border:1px solid var(--border,#e2e2e2);' +
      'border-radius:8px;padding:8px;background:#fff;';
    imgWrap.appendChild(imgEl);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:.5rem;justify-content:flex-end;';
    const btnCopy = document.createElement('button');
    btnCopy.type = 'button';
    btnCopy.textContent = copyLabel;
    btnCopy.style.cssText =
      'padding:.55rem .9rem;border:1px solid #d9d9d9;border-radius:6px;' +
      'background:#f6f6f6;color:#333;cursor:pointer;font-size:.9rem;';
    const btnOpen = document.createElement('button');
    btnOpen.type = 'button';
    btnOpen.textContent = openLabel;
    btnOpen.style.cssText =
      'padding:.55rem .9rem;border:none;border-radius:6px;background:#0a66c2;' +
      'color:#fff;cursor:pointer;font-size:.9rem;';
    actions.appendChild(btnCopy);
    actions.appendChild(btnOpen);

    card.appendChild(closeBtn);
    card.appendChild(titleEl);
    card.appendChild(subEl);
    card.appendChild(imgWrap);
    card.appendChild(actions);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    document.body.classList.add('modal-open');

    const finish = () => {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      document.body.classList.remove('modal-open');
    };
    const openLink = () => {
      finish();
      window.open(url, '_blank', 'noopener');
    };
    const copyLink = () => {
      try {
        navigator.clipboard.writeText(url).then(
          () => toast('Link do cardápio digital copiado.'),
          () => toast('Não foi possível copiar o link.')
        );
      } catch (_) {
        toast('Não foi possível copiar o link.');
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') finish();
      if (e.key === 'Enter') {
        e.preventDefault();
        openLink();
      }
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish();
    });
    closeBtn.addEventListener('click', finish);
    btnCopy.addEventListener('click', copyLink);
    btnOpen.addEventListener('click', openLink);
    window.addEventListener('keydown', onKey);

    return { close: finish };
  }

  window.DeliveryQrModal = { show };
})();