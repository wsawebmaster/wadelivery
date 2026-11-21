namespace Catalog.Api.Repositories;

/// <summary>
/// Chaves de cache compartilhadas entre os repositórios (IMemoryCache é singleton).
/// As lojas da plataforma são globais (não-RLS), por isso a chave não recebe prefixo de tenant.
/// </summary>
public static class CatalogCacheKeys
{
    public const string PlatformStores = "platform-stores";
}
