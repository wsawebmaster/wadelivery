using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Verifica o GC de imagens que roda no boot: com catálogo sem produtos ele não deve
/// varrer órfãos (evita apagar uploads num boot com dados vazios) e, com produtos
/// referenciando imagens, deve remover apenas órfãos antigos preservando os referenciados.
/// </summary>
public class ProductImageStartupGcTests
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";

    private const string EmptyCatalogJson = """
    {
        "categories": [
            { "id": "1", "title": "Bebidas", "sortOrder": 1, "items": [] }
        ]
    }
    """;

    private const string ReferencedCatalogJson = """
    {
        "categories": [
            {
                "id": "1",
                "title": "Bebidas",
                "sortOrder": 1,
                "items": [
                    {
                        "id": "1",
                        "name": "Monster",
                        "price": 10,
                        "available": true,
                        "imageUrl": "/uploads/products/monster.webp"
                    }
                ]
            }
        ]
    }
    """;

    [Fact]
    public async Task CleanupOnBoot_empty_catalog_preserves_uploads()
    {
        var tempDir = Setup(EmptyCatalogJson, out var prodDir);
        var oldOrphan = Path.Combine(prodDir, "fanta-uva.webp");
        File.WriteAllBytes(oldOrphan, new byte[] { 1 });
        File.SetLastWriteTimeUtc(oldOrphan, DateTime.UtcNow.AddDays(-30));

        try
        {
            using var factory = new WebApplicationFactory<Program>()
                .WithWebHostBuilder(b => Configure(b, tempDir));
            using var client = factory.CreateClient();

            Assert.True(File.Exists(oldOrphan),
                "GC no boot não deve apagar uploads quando o catálogo está vazio.");
        }
        finally
        {
            Cleanup(tempDir);
        }
    }

    [Fact]
    public async Task CleanupOnBoot_removes_old_orphans_keeps_referenced()
    {
        var tempDir = Setup(ReferencedCatalogJson, out var prodDir);
        var referenced = Path.Combine(prodDir, "monster.webp");
        var orphan = Path.Combine(prodDir, "lixo.webp");
        File.WriteAllBytes(referenced, new byte[] { 1 });
        File.WriteAllBytes(orphan, new byte[] { 2 });
        File.SetLastWriteTimeUtc(referenced, DateTime.UtcNow.AddDays(-30));
        File.SetLastWriteTimeUtc(orphan, DateTime.UtcNow.AddDays(-30));

        try
        {
            using var factory = new WebApplicationFactory<Program>()
                .WithWebHostBuilder(b => Configure(b, tempDir));
            using var client = factory.CreateClient();

            Assert.True(File.Exists(referenced), "Imagem referenciada deve ser preservada no GC do boot.");
            Assert.False(File.Exists(orphan), "Órfã antiga sem referência deve ser removida no boot.");
        }
        finally
        {
            Cleanup(tempDir);
        }
    }

    private static string Setup(string catalogJson, out string prodDir)
    {
        var tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-gc", Guid.NewGuid().ToString("N"));
        var dataDir = Path.Combine(tempDir, "data");
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(Path.Combine(dataDir, "products.json"), catalogJson);
        File.WriteAllText(Path.Combine(dataDir, "ingredients.json"), "[]");
        File.WriteAllText(Path.Combine(dataDir, "store-config.json"), StoreJson);

        prodDir = Path.Combine(tempDir, "uploads", "products");
        Directory.CreateDirectory(prodDir);
        return tempDir;
    }

    private static void Configure(IWebHostBuilder builder, string tempDir)
    {
        builder.UseSetting("Persistence", "Json");
        builder.UseSetting("Data:Root", Path.Combine(tempDir, "data"));
        builder.UseSetting("Data:PlatformStoresPath", Path.Combine(tempDir, "data", "platform-stores.json"));
        builder.UseSetting("Data:UploadsRoot", Path.Combine(tempDir, "uploads"));
        builder.UseSetting("Jwt:Key", TestKey);
        builder.UseSetting("Security:AllowInsecureDefaults", "true");
    }

    private static void Cleanup(string tempDir)
    {
        try
        {
            if (Directory.Exists(tempDir)) Directory.Delete(tempDir, recursive: true);
        }
        catch
        {
            // melhor esforço
        }
    }

    private const string StoreJson = """
    {
        "storeName": "Fabin Lanches",
        "logoUrl": "",
        "whatsapp": "5516992496886",
        "pixKey": "16992496886",
        "pixKeyLabel": "Telefone",
        "minOrder": 0,
        "currencyLocale": "pt-BR",
        "schedule": { "days": [1, 2, 3, 4, 5, 6], "open": "11:00", "close": "23:00", "closedMessage": "Fechado" },
        "deliveryFees": {}
    }
    """;
}
