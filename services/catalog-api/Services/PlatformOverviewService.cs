using Catalog.Api.Data;
using Catalog.Api.MultiTenancy;
using Catalog.Api.Repositories;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Catalog.Api.Services;

/// <summary>Atividade de uma loja para o painel da plataforma.</summary>
public sealed record PlatformStoreActivityDto(
    Guid PlatformStoreId,
    int? StoreId,
    long Orders30d,
    long OrdersTotal,
    DateTime? LastOrderAt,
    long MenuViews30d,
    int OwnProducts,
    int SampleProducts,
    bool OwnerLoggedIn);

/// <summary>
/// Visão consolidada das lojas (pedidos, acessos ao cardápio, produtos próprios, acesso do dono).
/// Pedidos: uma consulta agrupada no banco de pedidos. Produtos: contados por loja num escopo
/// com o tenant definido (products tem RLS). Cache de 2 minutos.
/// </summary>
public sealed class PlatformOverviewService(
    IServiceScopeFactory scopes,
    TrafficStatsService traffic,
    IMemoryCache cache)
{
    private const string CacheKey = "platform-overview";

    public void Invalidate() => cache.Remove(CacheKey);

    public async Task<List<PlatformStoreActivityDto>> GetAsync(CancellationToken ct = default)
    {
        if (cache.TryGetValue(CacheKey, out List<PlatformStoreActivityDto>? cached) && cached is not null)
            return cached;

        using var scope = scopes.CreateScope();
        var platform = await scope.ServiceProvider.GetRequiredService<IPlatformStoreRepository>().ListAsync(ct);
        var stats = scope.ServiceProvider.GetService<StoreStatsService>();
        var orders = stats is null ? new() : await stats.CountOrdersByStoreAsync(ct);

        var result = new List<PlatformStoreActivityDto>(platform.Count);
        foreach (var p in platform)
        {
            var (own, samples) = p.StoreId is int sid && sid > 0 ? await CountProductsAsync(sid, ct) : (0, 0);
            var (o30, oTotal, last) = p.StoreId is int id && orders.TryGetValue(id, out var o) ? o : (0L, 0L, (DateTime?)null);
            var views = p.StoreId is int vid && vid > 0 ? traffic.GetStorePageviews(vid, 30).Last30d : 0;
            result.Add(new PlatformStoreActivityDto(p.Id, p.StoreId, o30, oTotal, last, views, own, samples, p.LastAccessAt is not null));
        }

        cache.Set(CacheKey, result, TimeSpan.FromMinutes(2));
        return result;
    }

    private async Task<(int Own, int Samples)> CountProductsAsync(int storeId, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetService<CatalogDbContext>();
        if (db is null) return (0, 0);
        scope.ServiceProvider.GetRequiredService<TenantContext>().SetStoreId(storeId);
        var products = await db.Products.AsNoTracking()
            .Where(p => p.StoreId == storeId)
            .Select(p => new { p.Name, p.ImageUrl })
            .ToListAsync(ct);
        var samples = products.Count(p => SampleCatalog.IsSampleProduct(p.Name, p.ImageUrl));
        return (products.Count - samples, samples);
    }
}
