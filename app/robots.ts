import type { MetadataRoute } from 'next'

/** Buscadores indexam a landing e as páginas das lojas (/{slug}); painéis e login ficam de fora. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/login', '/legacy-admin/', '/*/admin'],
    },
  }
}
