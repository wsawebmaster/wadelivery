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
  // Loja: injetada pelo servidor em /{slug} (window.WA_TENANT_SLUG) ou ?tenant= no
  // /storefront/index.html (prévia do painel, QR de mesa); sem nenhum dos dois, Fabin.
  var tenantSlug = window.WA_TENANT_SLUG
    || new URLSearchParams(window.location.search).get('tenant')
    || 'fabin';
  if (tenantSlug) {
    window.WA_TENANT_SLUG = tenantSlug;
    var nativeFetch = window.fetch.bind(window);
    window.fetch = function (resource, options) {
      options = options || {};
      var url = typeof resource === 'string' ? resource : resource.url;
      if (url.indexOf('/api/v1/') === -1 && url.indexOf('/api/lojas/') === -1) {
        return nativeFetch(resource, options);
      }

      var headers = new Headers(resource instanceof Request ? resource.headers : undefined);
      if (options.headers) {
        new Headers(options.headers).forEach(function (value, key) {
          headers.set(key, value);
        });
      }
      headers.set('X-Tenant-Slug', tenantSlug);
      return nativeFetch(resource, Object.assign({}, options, { headers: headers }));
    };
  }

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
    // Nome do PC na rede (DESKTOP-ABC) ou mDNS (foo.local)
    if (host.indexOf('.') === -1) return true;
    if (/\.local$/i.test(host)) return true;
    return false;
  }

  if (window.API_BASE_URL) {
    window.API_BASE_URL = String(window.API_BASE_URL).replace(/\/$/, '');
    return;
  }

  // Marcador substituído por scripts/inject-api-config.js no deploy
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

  // Celular / outro dispositivo na mesma rede — NUNCA usar localhost aqui
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
