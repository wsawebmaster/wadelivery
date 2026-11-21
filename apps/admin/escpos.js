/* Impressão direta ESC/POS via WebUSB (Chrome/Edge, HTTPS ou localhost).
 * Envia os bytes ESC/POS direto para a impressora USB, sem depender do driver. */
(function (global) {
  'use strict';

  const CHUNK = 64;

  function isSupported() {
    return typeof navigator !== 'undefined'
      && !!navigator.usb
      && typeof navigator.usb.getDevices === 'function'
      && typeof navigator.usb.requestDevice === 'function'
      && window.isSecureContext !== false;
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normalizeSaved(saved) {
    if (!saved || typeof saved !== 'object') return null;
    const vendorId = Number(saved.vendorId);
    const productId = Number(saved.productId);
    if (!Number.isFinite(vendorId) || !Number.isFinite(productId)) return null;
    return {
      vendorId: vendorId,
      productId: productId,
      serialNumber: saved.serialNumber != null ? String(saved.serialNumber) : ''
    };
  }

  function matches(device, saved) {
    if (!device || !saved) return false;
    if (device.vendorId !== saved.vendorId || device.productId !== saved.productId) return false;
    if (saved.serialNumber && device.serialNumber !== saved.serialNumber) return false;
    return true;
  }

  async function getSavedDevice(saved) {
    if (!isSupported() || !saved) return null;
    try {
      const devices = await navigator.usb.getDevices();
      return devices.find((d) => matches(d, saved)) || null;
    } catch (_) {
      return null;
    }
  }

  async function pickDevice(saved) {
    if (!isSupported()) {
      return { error: 'Impressão direta indisponível: use Chrome/Edge com HTTPS ou localhost.' };
    }
    let device;
    try {
      device = await navigator.usb.requestDevice({ filters: [] });
    } catch (err) {
      if (err && err.name === 'NotFoundError') {
        return { error: 'Nenhuma impressora selecionada.' };
      }
      return { error: (err && err.message) || 'Não foi possível selecionar a impressora.' };
    }
    if (!device) return { error: 'Nenhuma impressora selecionada.' };
    return {
      device: device,
      saved: {
        vendorId: device.vendorId,
        productId: device.productId,
        serialNumber: device.serialNumber || ''
      }
    };
  }

  function findBulkOutEndpoint(configuration) {
    if (!configuration || !configuration.interfaces) return null;
    for (const iface of configuration.interfaces) {
      for (const alt of iface.alternates || []) {
        for (const ep of alt.endpoints || []) {
          if (ep.direction === 'out' && (ep.type === 'bulk' || ep.type === 'interrupt')) {
            return { iface: iface, endpoint: ep };
          }
        }
      }
    }
    return null;
  }

  function interfaceClass(iface) {
    if (iface && iface.alternates && iface.alternates.length) {
      return iface.alternates[0].interfaceClass;
    }
    return 0;
  }

  async function tryOpen(device, attempts) {
    for (let i = 1; i <= attempts; i++) {
      try {
        await device.open();
        return;
      } catch (err) {
        if (i === attempts) throw err;
        try { await device.close(); } catch (_) { /* ignore */ }
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
    }
  }

  async function openDevice(device) {
    // No Windows, se um driver/janela já estiver usando a interface USB, o primeiro
    // open() pode falhar com "Access denied". Tenta de novo antes de desistir.
    await tryOpen(device, 2);
    let config = device.configuration;
    if (!config || !config.interfaces || !config.interfaces.length) {
      await device.selectConfiguration(1);
      config = device.configuration;
    }
    const target = findBulkOutEndpoint(config);
    if (!target) {
      await device.close();
      throw new Error('Impressora sem endpoint de saída compatível.');
    }
    const ifaceNum = target.iface.interfaceNumber;
    await device.claimInterface(ifaceNum);
    // CDC/ACM (porta serial virtual) exige line coding + DTR antes de enviar dados.
    if (interfaceClass(target.iface) === 0x02) {
      try {
        const lineCoding = new Uint8Array([0x80, 0x25, 0x00, 0x00, 0x00, 0x00, 0x08]);
        await device.controlTransferOut(
          { requestType: 'class', recipient: 'interface', request: 0x20, value: 0, index: ifaceNum },
          lineCoding
        );
        await device.controlTransferOut(
          { requestType: 'class', recipient: 'interface', request: 0x22, value: 0x0003, index: ifaceNum }
        );
      } catch (_) { /* algumas impressoras CDC funcionam sem isso */ }
    }
    return { device: device, ifaceNum: ifaceNum, endpoint: target.endpoint };
  }

  async function closeDevice(handle) {
    if (!handle || !handle.device) return;
    try { await handle.device.releaseInterface(handle.ifaceNum); } catch (_) { /* ignore */ }
    try { await handle.device.close(); } catch (_) { /* ignore */ }
  }

  function utf8Bytes(text) {
    if (typeof TextEncoder !== 'undefined') {
      const enc = new TextEncoder();
      return Array.from(enc.encode(text));
    }
    return Array.from(unescape(encodeURIComponent(text)), (c) => c.charCodeAt(0));
  }

  /** Converte as linhas do cupom em comandos ESC/POS. */
  function buildBytes(lines, opts) {
    const o = opts || {};
    const bold = o.bold !== false;
    const feedLines = clampInt(o.feedLines, 0, 20, 3);
    const parts = [];
    const push = (arr) => { for (let i = 0; i < arr.length; i++) parts.push(arr[i]); };
    push([0x1B, 0x40]); // ESC @ — inicializa
    (lines || []).forEach((line) => {
      const text = String(line).replace(/\r/g, '');
      push([0x1B, 0x61, 0x00]); // ESC a 0 — alinhamento à esquerda (layout usa espaços)
      if (bold) push([0x1B, 0x45, 0x01]); // ESC E 1 — negrito
      push(utf8Bytes(text));
      push([0x0A]); // LF
      if (bold) push([0x1B, 0x45, 0x00]); // ESC E 0 — negrito off
    });
    push([0x1B, 0x64, feedLines]); // ESC d n — avança n linhas
    if (o.cut) {
      push([0x1D, 0x56, 0x00]); // GS V 0 — corte (opcional)
    } else {
      push([0x1B, 0x69]); // ESC i — imprime e alimenta o papel
    }
    return new Uint8Array(parts);
  }

  async function writeAll(handle, bytes) {
    const packet = handle.endpoint.packetSize || CHUNK;
    for (let i = 0; i < bytes.length; i += packet) {
      const chunk = bytes.subarray(i, i + packet);
      await handle.device.transferOut(handle.endpoint.endpointNumber, chunk);
    }
  }

  global.EscPosPrinter = {
    isSupported: isSupported,
    normalizeSaved: normalizeSaved,
    getSavedDevice: getSavedDevice,
    pickDevice: pickDevice,
    openDevice: openDevice,
    closeDevice: closeDevice,
    buildBytes: buildBytes,
    writeAll: writeAll
  };
})(window);
