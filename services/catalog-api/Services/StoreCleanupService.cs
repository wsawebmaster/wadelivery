using Catalog.Api.Data;
using Catalog.Api.MultiTenancy;
using Catalog.Api.Repositories;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Catalog.Api.Services;

/// <summary>
/// Expira lojas de teste abandonadas (cadastro automático, Plan = "teste"):
/// - dono nunca entrou no painel (LastAccessAt nulo) após Signup:AbandonAfterDays (7) → loja
///   desativada (o mesmo bloqueio de sempre: cardápio 403, pedidos recusados) e AbandonedAt;
/// - após Signup:PurgeFilesAfterDays (30) desativada → apaga os arquivos enviados da loja
///   (logo/banner/capa e fotos dos produtos) e limpa as referências. Os registros ficam.
/// Reativar = "Desbloquear loja" em /admin/lojas → Cobrança.
/// </summary>
public sealed class StoreCleanupService(
    IServiceScopeFactory scopes,
    IConfiguration configuration,
    IWebHostEnvironment environment,
    IMemoryCache cache,
    ILogger<StoreCleanupService> logger,
    PlatformAuditService? audit = null)
{
    public sealed record Result(int Abandoned, int Purged);

    public async Task<Result> RunAsync(DateTime nowUtc, CancellationToken ct = default)
    {
        var abandonAfterDays = configuration.GetValue("Signup:AbandonAfterDays", 7);
        var purgeAfterDays = configuration.GetValue("Signup:PurgeFilesAfterDays", 30);

        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetService<CatalogDbContext>();
        if (db is null) return new Result(0, 0); // modo JSON: sem cadastro automático

        var abandoned = 0;
        if (abandonAfterDays > 0)
        {
            var limit = nowUtc.AddDays(-abandonAfterDays);
            var stale = await db.PlatformStores
                .Where(p => p.Plan == "teste" && p.Active && p.AbandonedAt == null
                    && p.LastAccessAt == null && p.CreatedAt <= limit)
                .ToListAsync(ct);
            foreach (var p in stale)
            {
                p.Active = false;
                p.Status = "inactive";
                p.AbandonedAt = nowUtc;
                p.UpdatedAt = nowUtc;
                logger.LogInformation("Loja de teste {Name} (StoreId {StoreId}) desativada por abandono.", p.Name, p.StoreId);
            }
            abandoned = stale.Count;
            if (abandoned > 0) await db.SaveChangesAsync(ct);
            if (audit is not null)
                foreach (var p in stale)
                    await audit.LogAsync(PlatformAuditService.SystemActor, "store.abandoned", p.Id, p.StoreId, new { abandonAfterDays }, ct);
        }

        var purged = 0;
        if (purgeAfterDays > 0)
        {
            var limit = nowUtc.AddDays(-purgeAfterDays);
            var toPurge = await db.PlatformStores
                .Where(p => p.Plan == "teste" && !p.Active && p.AbandonedAt != null
                    && p.AbandonedAt <= limit && p.FilesPurgedAt == null && p.StoreId != null)
                .ToListAsync(ct);
            var uploadsRoot = StoreProvisioningService.ResolveUploadsRoot(configuration, environment.ContentRootPath);
            foreach (var p in toPurge)
            {
                try
                {
                    await PurgeStoreFilesAsync(p.StoreId!.Value, uploadsRoot, ct);
                    p.LogoUrl = null;
                    p.FilesPurgedAt = nowUtc;
                    p.UpdatedAt = nowUtc;
                    purged++;
                    if (audit is not null)
                        await audit.LogAsync(PlatformAuditService.SystemActor, "store.files-purged", p.Id, p.StoreId, null, ct);
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "Falha ao apagar arquivos da loja abandonada {StoreId}.", p.StoreId);
                }
            }
            if (purged > 0) await db.SaveChangesAsync(ct);
        }

        if (abandoned > 0 || purged > 0) cache.Remove(CatalogCacheKeys.PlatformStores);
        return new Result(abandoned, purged);
    }

    /// <summary>Apaga os arquivos da loja num escopo com o tenant definido (stores/products têm RLS).</summary>
    private async Task PurgeStoreFilesAsync(int storeId, string uploadsRoot, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        scope.ServiceProvider.GetRequiredService<TenantContext>().SetStoreId(storeId);
        var db = scope.ServiceProvider.GetRequiredService<CatalogDbContext>();

        var store = await db.Stores.FirstOrDefaultAsync(s => s.Id == storeId, ct);
        if (store is null) return;

        foreach (var url in new[] { store.LogoUrl, store.BannerUrl, store.CoverUrl })
            ImageStorage.TryDeleteUpload(url, uploadsRoot);
        store.LogoUrl = null;
        store.BannerUrl = null;
        store.CoverUrl = null;

        // Pasta própria da loja (uploads/stores/{slug}) — só se o slug for seguro.
        if (!string.IsNullOrWhiteSpace(store.Slug) && CatalogInputValidation.IsValidTenantSlug(store.Slug))
        {
            var dir = Path.GetFullPath(Path.Combine(uploadsRoot, "stores", store.Slug));
            var root = Path.GetFullPath(Path.Combine(uploadsRoot, "stores")) + Path.DirectorySeparatorChar;
            if (dir.StartsWith(root, StringComparison.Ordinal) && Directory.Exists(dir))
                Directory.Delete(dir, recursive: true);
        }

        // Fotos dos produtos (arquivos individuais por produto em uploads/products).
        var products = await db.Products.Where(x => x.StoreId == storeId && x.ImageUrl != null).ToListAsync(ct);
        foreach (var product in products)
        {
            ImageStorage.TryDeleteUpload(product.ImageUrl, uploadsRoot);
            product.ImageUrl = null;
        }
        await db.SaveChangesAsync(ct);
    }
}
