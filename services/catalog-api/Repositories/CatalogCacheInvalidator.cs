using Microsoft.Extensions.Caching.Memory;

namespace Catalog.Api.Repositories;

/// <summary>
/// Invalidação centralizada do cache de catálogo por loja (IMemoryCache é singleton).
/// Usado tanto pelos repositórios (invalidação local pós-escrita) quanto pelo
/// CatalogInvalidationListener (barramento PostgreSQL LISTEN/NOTIFY, cross-instance).
/// </summary>
public sealed class CatalogCacheInvalidator(IMemoryCache cache)
{
    private static string StoreKey(int storeId) => $"t{storeId}:store";
    private static string CatalogKey(int storeId) => $"t{storeId}:catalog";
    private static string IngredientsKey(int storeId) => $"t{storeId}:ingredients";
    private static string SlugKey(string slug) => $"tenant:slug:{slug.ToLowerInvariant()}";

    /// <summary>Remove as chaves de catálogo de uma loja específica.</summary>
    public void InvalidateStore(int storeId)
    {
        cache.Remove(StoreKey(storeId));
        cache.Remove(CatalogKey(storeId));
        cache.Remove(IngredientsKey(storeId));
    }

    /// <summary>Remove a chave de cache de resolução de um slug.</summary>
    public void InvalidateSlug(string? slug)
    {
        if (!string.IsNullOrWhiteSpace(slug))
            cache.Remove(SlugKey(slug));
    }

    /// <summary>Remove a lista global de lojas da plataforma (embute store config).</summary>
    public void InvalidateGlobal()
    {
        cache.Remove(CatalogCacheKeys.PlatformStores);
    }
}