using Catalog.Api.Data;
using Catalog.Api.MultiTenancy;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Services;

/// <summary>
/// Aplica o visual de um segmento a uma loja existente (troca de segmento pela plataforma).
/// Só substitui o que a plataforma gerou — nada do que o lojista criou é tocado:
/// - cores: paleta do segmento (opcional);
/// - logo: só o logo padrão ("logo-padrao-*") é refeito nas novas cores; logo enviado fica;
/// - produtos de exemplo ("exemplo-*" / "Produto de exemplo") viram os do novo segmento, com as
///   categorias; categorias de exemplo que ficarem vazias saem. Se a loja já apagou os exemplos,
///   nenhum produto é criado.
/// </summary>
public sealed class SegmentApplier(
    IServiceScopeFactory scopes,
    IConfiguration configuration,
    IWebHostEnvironment environment,
    ILogger<SegmentApplier> logger)
{
    public sealed record Result(bool ColorsApplied, string? NewLogoUrl, int SamplesRemoved, int SamplesAdded, string? Slug);

    public async Task<Result> ApplyAsync(int storeId, string segment, bool applyColors, bool applySamples, CancellationToken ct)
    {
        using var scope = scopes.CreateScope();
        // stores/products/categories têm RLS: tudo no escopo da própria loja.
        scope.ServiceProvider.GetRequiredService<TenantContext>().SetStoreId(storeId);
        var db = scope.ServiceProvider.GetService<CatalogDbContext>();
        if (db is null) return new Result(false, null, 0, 0, null); // modo JSON: sem lojas da plataforma

        var store = await db.Stores.FirstOrDefaultAsync(s => s.Id == storeId, ct);
        if (store is null) return new Result(false, null, 0, 0, null);

        var palette = SegmentPalettes.For(segment);
        var uploadsRoot = StoreProvisioningService.ResolveUploadsRoot(configuration, environment.ContentRootPath);
        var createdFiles = new List<string>();
        var obsoleteFiles = new List<string>();
        string? newLogo = null;
        int removed = 0, added = 0;

        try
        {
            if (applyColors)
            {
                store.CorPrimaria = palette.CorPrimaria;
                store.CorSecundaria = palette.CorSecundaria;
                store.CorFundo = palette.CorFundo;
                store.CorTexto = palette.CorTexto;
            }

            // Logo padrão acompanha as cores da loja (lojas sem logo também ganham um);
            // logo enviado pelo lojista nunca é trocado.
            var hasOwnLogo = !string.IsNullOrWhiteSpace(store.LogoUrl) && !DefaultLogo.IsDefault(store.LogoUrl);
            if ((applyColors || applySamples) && !hasOwnLogo)
            {
                newLogo = await DefaultLogo.SaveAsync(uploadsRoot, store.Slug, store.Nome, store.CorPrimaria, ct);
                createdFiles.Add(newLogo);
                if (!string.IsNullOrWhiteSpace(store.LogoUrl)) obsoleteFiles.Add(store.LogoUrl);
                store.LogoUrl = newLogo;
            }

            if (applySamples)
                (removed, added) = await ReplaceSamplesAsync(db, store, segment, uploadsRoot, createdFiles, obsoleteFiles, ct);

            store.DataAtualizacao = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
        }
        catch
        {
            foreach (var file in createdFiles) ImageStorage.TryDeleteUpload(file, uploadsRoot);
            throw;
        }

        // Só depois do commit: arquivos antigos (logo e fotos de exemplo substituídos).
        foreach (var file in obsoleteFiles) ImageStorage.TryDeleteUpload(file, uploadsRoot);
        logger.LogInformation("Segmento {Segment} aplicado à loja {StoreId}: cores={Colors}, logo={Logo}, exemplos -{Removed}/+{Added}.",
            segment, storeId, applyColors, newLogo is not null, removed, added);
        return new Result(applyColors, newLogo, removed, added, store.Slug);
    }

    private static async Task<(int Removed, int Added)> ReplaceSamplesAsync(
        CatalogDbContext db, Loja store, string segment, string uploadsRoot,
        List<string> createdFiles, List<string> obsoleteFiles, CancellationToken ct)
    {
        var products = await db.Products.Where(p => p.StoreId == store.Id).ToListAsync(ct);
        var samples = products.Where(p => SampleCatalog.IsSampleProduct(p.Name, p.ImageUrl)).ToList();
        if (samples.Count == 0) return (0, 0); // lojista já tirou os exemplos: não recria

        foreach (var product in samples)
        {
            if (!string.IsNullOrWhiteSpace(product.ImageUrl)) obsoleteFiles.Add(product.ImageUrl);
            if (store.HeroProductId == product.Id) store.HeroProductId = null;
            db.Products.Remove(product);
        }

        var menu = SampleCatalog.For(segment);
        var remaining = products.Except(samples).ToList();
        var categories = await db.Categories.Where(c => c.StoreId == store.Id).ToListAsync(ct);

        // Categorias de exemplo que ficaram vazias e não servem ao novo segmento saem.
        foreach (var category in categories.ToList())
        {
            var isSampleTitle = SampleCatalog.SampleCategoryTitles.Contains(category.Title);
            var inNewMenu = menu.Categories.Contains(category.Title, StringComparer.OrdinalIgnoreCase);
            if (isSampleTitle && !inNewMenu && remaining.All(p => p.CategoryId != category.Id))
            {
                db.Categories.Remove(category);
                categories.Remove(category);
            }
        }

        // Categorias do novo segmento: reaproveita pelo título, cria as que faltam (no fim).
        var nextOrder = categories.Count == 0 ? 1 : categories.Max(c => c.SortOrder) + 1;
        var target = new List<CategoryEntity>();
        foreach (var title in menu.Categories)
        {
            var existing = categories.FirstOrDefault(c => string.Equals(c.Title, title, StringComparison.OrdinalIgnoreCase));
            if (existing is null)
            {
                existing = new CategoryEntity { Id = Guid.NewGuid().ToString("N"), StoreId = store.Id, Title = title, SortOrder = nextOrder++ };
                db.Categories.Add(existing);
            }
            target.Add(existing);
        }

        var firstSort = remaining.Count == 0 ? 1 : remaining.Max(p => p.SortOrder) + 1;
        var newProducts = await SampleCatalog.CreateProductsAsync(
            menu, target, store.Id, store.Slug, uploadsRoot, createdFiles, firstSort, ct);
        db.Products.AddRange(newProducts);
        return (samples.Count, newProducts.Count);
    }
}
