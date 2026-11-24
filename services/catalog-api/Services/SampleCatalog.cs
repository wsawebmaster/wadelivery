using Catalog.Api.Data;

namespace Catalog.Api.Services;

/// <summary>Produto de exemplo criado com a loja (foto em Assets/sample-products).</summary>
public sealed record SampleProduct(string Name, string Description, decimal Price, int CategoryIndex, string PhotoFile);

/// <summary>Cardápio inicial por segmento: categorias + dois produtos com foto real.</summary>
public sealed record SampleMenu(IReadOnlyList<string> Categories, IReadOnlyList<SampleProduct> Products);

/// <summary>
/// Cardápio de exemplo do cadastro de lojas. As fotos são do Unsplash (licença Unsplash,
/// uso comercial gratuito; créditos em Assets/sample-products/CREDITOS.md) e são copiadas
/// para os uploads da loja — o lojista edita ou remove como qualquer outro produto.
/// </summary>
public static class SampleCatalog
{
    /// <summary>Prefixo do arquivo das fotos de exemplo (o checklist do painel o reconhece).</summary>
    public const string PhotoPrefix = "exemplo-";

    public static string AssetsDirectory =>
        Path.Combine(AppContext.BaseDirectory, "Assets", "sample-products");

    private static readonly Dictionary<string, SampleMenu> Menus = new(StringComparer.Ordinal)
    {
        ["lanchonete"] = new(
            ["Lanches", "Porções", "Bebidas"],
            [
                new("X-Bacon Salada", "Pão com gergelim, hambúrguer, queijo, bacon, alface, tomate e cebola.", 24.90m, 0, "lanchonete-1.jpg"),
                new("Batata Frita", "Porção de batata frita crocante. Acompanha ketchup.", 18.90m, 1, "lanchonete-2.jpg"),
            ]),
        ["hamburgueria"] = new(
            ["Hambúrgueres", "Acompanhamentos", "Bebidas"],
            [
                new("Smash Duplo Cheddar", "Dois smash burgers, cheddar cremoso, picles e molho da casa no pão brioche.", 32.90m, 0, "hamburgueria-1.jpg"),
                new("Burger da Casa", "Blend artesanal duplo, queijo, alface, tomate, cebola, picles e molho especial.", 29.90m, 0, "hamburgueria-2.jpg"),
            ]),
        ["pizzaria"] = new(
            ["Pizzas", "Bebidas"],
            [
                new("Pizza Margherita", "Molho de tomate, muçarela e manjericão fresco.", 54.90m, 0, "pizzaria-1.jpg"),
                new("Pizza de Rúcula", "Muçarela, rúcula, tomate, azeitonas pretas e presunto cru.", 59.90m, 0, "pizzaria-2.jpg"),
            ]),
        ["marmitaria"] = new(
            ["Marmitas", "Bebidas"],
            [
                new("Marmita de Frango Grelhado", "Arroz, feijão, frango grelhado, milho e salada.", 22.90m, 0, "marmitaria-1.jpg"),
                new("Marmita de Bife Grelhado", "Arroz, bife grelhado ao molho e legumes salteados.", 26.90m, 0, "marmitaria-2.jpg"),
            ]),
        ["assai"] = new(
            ["Açaí", "Bebidas"],
            [
                new("Açaí Tradicional 500 ml", "Açaí com banana, morango, framboesa, mirtilo, granola e chia.", 22.90m, 0, "assai-1.jpg"),
                new("Açaí Frutas Vermelhas 700 ml", "Açaí com morango, framboesa, amora, mirtilo, banana, granola e pasta de amendoim.", 29.90m, 0, "assai-2.jpg"),
            ]),
    };

    private static readonly SampleMenu Fallback = Menus["lanchonete"];

    /// <summary>Títulos de categoria criados pelos cardápios de exemplo (inclui o modelo antigo).</summary>
    public static readonly HashSet<string> SampleCategoryTitles = new(
        Menus.Values.SelectMany(m => m.Categories).Concat(["Lanches", "Bebidas", "Porções"]),
        StringComparer.OrdinalIgnoreCase);

    /// <summary>Produto criado pelo cadastro: foto com prefixo exemplo- ou o antigo "Produto de exemplo".</summary>
    public static bool IsSampleProduct(string? name, string? imageUrl) =>
        (imageUrl ?? "").Contains("/products/" + PhotoPrefix, StringComparison.OrdinalIgnoreCase)
        || string.Equals((name ?? "").Trim(), "Produto de exemplo", StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Cria os produtos de exemplo do cardápio nas categorias indicadas (mesma ordem de menu.Categories),
    /// copiando as fotos para uploads/products. Arquivos gravados entram em createdFiles (rollback).
    /// Foto ausente/corrompida não impede: o produto fica sem foto.
    /// </summary>
    public static async Task<List<ProductEntity>> CreateProductsAsync(
        SampleMenu menu,
        IReadOnlyList<CategoryEntity> categories,
        int storeId,
        string slug,
        string uploadsRoot,
        List<string> createdFiles,
        int firstSortOrder,
        CancellationToken ct)
    {
        var products = new List<ProductEntity>();
        var sortOrder = firstSortOrder;
        foreach (var item in menu.Products)
        {
            products.Add(new ProductEntity
            {
                Id = Guid.NewGuid().ToString("N"),
                StoreId = storeId,
                CategoryId = categories[Math.Clamp(item.CategoryIndex, 0, categories.Count - 1)].Id,
                Name = item.Name,
                Description = item.Description,
                Price = item.Price,
                ImageUrl = await SavePhotoAsync(item, slug, uploadsRoot, createdFiles, ct),
                Available = true,
                ShowInMenu = true,
                SortOrder = sortOrder++
            });
        }
        return products;
    }

    private static async Task<string?> SavePhotoAsync(SampleProduct item, string slug, string uploadsRoot, List<string> createdFiles, CancellationToken ct)
    {
        var path = Path.Combine(AssetsDirectory, item.PhotoFile);
        if (!File.Exists(path)) return null;
        try
        {
            await using var stream = File.OpenRead(path);
            var url = await ImageStorage.SaveProductPhotoAsync(stream, uploadsRoot, $"{PhotoPrefix}{slug}-{item.Name}", ct);
            createdFiles.Add(url);
            return url;
        }
        catch (Exception)
        {
            return null;
        }
    }

    public static SampleMenu For(string? segment) =>
        Menus.TryGetValue((segment ?? "").Trim().ToLowerInvariant(), out var menu) ? menu : Fallback;
}
