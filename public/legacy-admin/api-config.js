/* legacy-admin: API base definida por /admin via ?api= */
(function () {
  try {
    var q = new URLSearchParams(window.location.search).get('api');
    if (q) window.API_BASE_URL = String(q).replace(/\/$/, '');
  } catch (_) { /* ignore */ }
})();
/**
 * Endpoint da API.
 * Prioridade:
 * 1) window.API_BASE_URL já definido
 * 2) valor injetado no build (Vercel: env API_BASE_URL)
 * 3) localhost → gateway :5100
 * 4) IP/hostname da LAN → mesmo host :5100 (celular na rede)
 * 5) hosts públicos (Vercel etc.) sem inject → erro explícito
 */
(function () {
  function isPrivateIp(host) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host || '');
    if (!m) return false;
    var a = Number(m[1]);
    var b = Number(m[2]);
    if (a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  function isLanHost(host) {
    if (!host) return false;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (isPrivateIp(host)) return true;
    if (host.indexOf('.') === -1) return true;
    if (/\.local$/i.test(host)) return true;
    return false;
  }

  if (window.API_BASE_URL) {
    window.API_BASE_URL = String(window.API_BASE_URL).replace(/\/$/, '');
    return;
  }

  var injected = '__API_BASE_URL__';
  if (injected && injected.indexOf('__API_') !== 0) {
    window.API_BASE_URL = String(injected).replace(/\/$/, '');
    return;
  }

  var host = window.location.hostname || 'localhost';

  if (host === 'localhost' || host === '127.0.0.1') {
    window.API_BASE_URL = 'http://localhost:5100';
    return;
  }

  if (isLanHost(host)) {
    window.API_BASE_URL = 'http://' + host + ':5100';
    return;
  }

  var publicHost =
    /\.vercel\.app$/i.test(host) ||
    /\.netlify\.app$/i.test(host) ||
    /\.pages\.dev$/i.test(host);

  if (publicHost) {
    console.error(
      '[api-config] API_BASE_URL ausente. Na Vercel, defina a env API_BASE_URL (HTTPS da API) e use o Build Command npm run build.'
    );
    window.API_BASE_URL = '';
    return;
  }

  window.API_BASE_URL = 'http://' + host + ':5100';
})();
