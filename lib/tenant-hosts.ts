/**
 * Hosts/domínios dos tenants na plataforma WaDelivery.
 * Fonte de verdade no MVP: mapeamento estático, espelhado do campo
 * `platform_stores.Domain` do backend (.NET) no futuro. O middleware só consome
 * `resolveTenantSlug` (lib/tenant-resolver) — nada aqui depende de runtime Node.
 */
export const PRIMARY_DOMAIN = 'wadelivery.com.br'

/**
 * Casamentos exatos host → slug. Tem prioridade sobre o fallback de 1º rótulo,
 * permitindo subdomínios multi-label (ex.: gota.acai.wadelivery.com.br → gota-acai).
 * Os demais clientes usam o padrão <slug>.wadelivery.com.br (1 label).
 */
export const KNOWN_TENANT_HOSTS: Record<string, string> = {
  'gota.acai.wadelivery.com.br': 'gota-acai',
}

/**
 * Slugs reservados que nenhum lojista pode adotar, evitando que o cardápio de um
 * cliente sobrescreva ou conflite com rotas internas do SaaS (admin, api, assets...).
 * Vale tanto para rota de caminho /{slug} quanto para subdomínios.
 */
export const RESERVED_SLUGS = ['admin', 'api', 'assets', 'public', 'login', 'suporte', 'faq', 'criar-loja', 'storefront']