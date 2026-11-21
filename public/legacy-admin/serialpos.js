/* Impressão ESC/POS via Web Serial (Chrome/Edge, HTTPS ou localhost).
 * Usado quando o Windows expõe a impressora como porta serial (ex.: Titannet em COM5),
 * em vez de uma impressora "de sistema". Envia os bytes ESC/POS pela porta (COM/USB-Serial
 * ou eventualmente Bluetooth RFCOMM) sem depender de driver de impressora. */
(function (global) {
  'use strict';

  function isSupported() {
    return typeof navigator !== 'undefined'
      && !!navigator.serial
      && typeof navigator.serial.getPorts === 'function'
      && typeof navigator.serial.requestPort === 'function'
      && window.isSecureContext !== false;
  }

  function portInfo(port) {
    try {
      const info = port.getInfo();
      return {
        usbVendorId: Number(info.usbVendorId),
        usbProductId: Number(info.usbProductId)
      };
    } catch (_) {
      return { usbVendorId: 0, usbProductId: 0 };
    }
  }

  function normalizeSaved(saved) {
    if (!saved || typeof saved !== 'object') return null;
    const vendorId = Number(saved.usbVendorId);
    const productId = Number(saved.usbProductId);
    if (!Number.isFinite(vendorId) || !Number.isFinite(productId)) return null;
    return { usbVendorId: vendorId, usbProductId: productId };
  }

  function matches(port, saved) {
    if (!port || !saved) return false;
    if (!saved.usbVendorId || !saved.usbProductId) return false;
    const info = portInfo(port);
    return info.usbVendorId === saved.usbVendorId && info.usbProductId === saved.usbProductId;
  }

  async function getSavedPort(saved) {
    if (!isSupported()) return null;
    let ports;
    try {
      ports = await navigator.serial.getPorts();
    } catch (_) {
      return null;
    }
    if (!ports || !ports.length) return null;
    const normalized = normalizeSaved(saved);
    if (normalized) {
      const match = ports.find((p) => matches(p, normalized));
      if (match) return match;
    }
    // Sem VID/PID salvos (ex.: Bluetooth) ou sem correspondência exata:
    // se houver só UMA porta concedida, usa ela — evita pedir de novo a cada impressão.
    if (ports.length === 1) return ports[0];
    return null;
  }

  async function pickPort(saved) {
    if (!isSupported()) {
      return { error: 'Porta serial indisponível: use Chrome/Edge com HTTPS ou localhost.' };
    }
    let port;
    try {
      port = await navigator.serial.requestPort();
    } catch (err) {
      if (err && err.name === 'NotFoundError') {
        return { error: 'Nenhuma porta selecionada.' };
      }
      return { error: (err && err.message) || 'Não foi possível selecionar a porta.' };
    }
    if (!port) return { error: 'Nenhuma porta selecionada.' };
    return { port: port, saved: portInfo(port) };
  }

  async function openPort(port, baud, attempts) {
    const tries = (attempts && attempts > 0) ? attempts : 2;
    for (let i = 1; i <= tries; i++) {
      try {
        await port.open({ baudRate: baud || 9600 });
        break;
      } catch (err) {
        if (i === tries) throw err;
        await new Promise((resolve) => setTimeout(resolve, 180));
      }
    }
    // Sinaliza DTR/RTS — muitas impressoras térmicas aguardam antes de aceitar dados.
    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (_) { /* nem toda porta suporta */ }
    let writer = null;
    try {
      writer = port.writable ? port.writable.getWriter() : null;
    } catch (_) {
      writer = null;
    }
    return { port: port, writer: writer };
  }

  async function writeBytes(handle, bytes) {
    if (!handle || !handle.writer) {
      throw new Error('Porta serial sem canal de escrita.');
    }
    // Aquecimento após sinalizar DTR/RTS: impressora térmica em standby pode
    // descartar os primeiros bytes se a escrita acontecer logo após o enable.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await handle.writer.write(bytes);
    try { await handle.writer.ready; } catch (_) { /* ignore */ }
    // Dá tempo do dispositivo processar antes do fechamento da porta.
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  async function closePort(handle) {
    if (!handle || !handle.port) return;
    if (handle.writer) {
      try { await handle.writer.releaseLock(); } catch (_) { /* ignore */ }
    }
    try { await handle.port.close(); } catch (_) { /* ignore */ }
  }

  global.SerialPosPrinter = {
    isSupported: isSupported,
    normalizeSaved: normalizeSaved,
    getSavedPort: getSavedPort,
    pickPort: pickPort,
    openPort: openPort,
    writeBytes: writeBytes,
    closePort: closePort
  };
})(window);