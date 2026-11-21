using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) para o relatório de imagens ausentes:
/// produtos cuja URL relativa /uploads/... aponta para arquivo inexistente em disco
/// aparecem em GET /api/v1/admin/images/missing; arquivos presentes e URLs externas não.
/// </summary>
public class ProductImageMissingTests : IAsyncLifetime
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";
    private const string AdminUser = "admin-teste";
    private const string AdminPass = "senha-teste";
    private const string CatalogJson = """
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
                    },
                    {
                        "id": "2",
                        "name": "Fanta",
                        "price": 8,
                        "available": true,
                        "imageUrl": "/uploads/products/fanta.webp"
                    },
                    {
                        "id": "3",
                        "name": "Coca (externo)",
                        "price": 9,
                        "available": true,
                        "imageUrl": "https://exemplo.com/coca.png"
                    }
                ]
            }
        ]
    }
    """;

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public async Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-imgmissing", Guid.NewGuid().ToString("N"));
        WriteSeedCatalog(_tempDir);

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => Configure(b, _tempDir));
        _client = _factory.CreateClient();

        var login = await _client.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(AdminUser, AdminPass));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(body?.Token);
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body!.Token);
    }

    public async Task DisposeAsync()
    {
        _client?.Dispose();
        _factory?.Dispose();
        try
        {
            if (Directory.Exists(_tempDir)) Directory.Delete(_tempDir, recursive: true);
        }
        catch
        {
            // melhor esforço
        }
        await Task.CompletedTask;
    }

    [Fact]
    public async Task ImagesMissing_lists_only_products_without_file_on_disk()
    {
        // Nenhum arquivo em disco: monster.webp e fanta.webp devem aparecer como ausentes;
        // URL externa (Coca) é ignorada.
        var body = await GetMissing();
        Assert.Equal(2, body!.Products!.Count);
        Assert.Contains(body.Products, p => p.Id == "1" && p.ImageUrl == "/uploads/products/monster.webp");
        Assert.Contains(body.Products, p => p.Id == "2" && p.ImageUrl == "/uploads/products/fanta.webp");
        Assert.DoesNotContain(body.Products, p => p.Id == "3");
    }

    [Fact]
    public async Task ImagesMissing_empty_when_all_files_exist()
    {
        var prodDir = ProductsDir();
        File.WriteAllBytes(Path.Combine(prodDir, "monster.webp"), new byte[] { 1 });
        File.WriteAllBytes(Path.Combine(prodDir, "fanta.webp"), new byte[] { 2 });

        var body = await GetMissing();
        Assert.NotNull(body?.Products);
        Assert.Empty(body!.Products!);
    }

    [Fact]
    public async Task ImagesMissing_requires_auth()
    {
        using var noAuth = _factory!.CreateClient();
        var response = await noAuth.GetAsync("/api/v1/admin/images/missing");
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, response.StatusCode);
    }

    private async Task<MissingImagesResponse?> GetMissing()
    {
        var response = await _client!.GetAsync("/api/v1/admin/images/missing");
        response.EnsureSuccessStatusCode();
        return await response.Content.ReadFromJsonAsync<MissingImagesResponse>();
    }

    private string ProductsDir()
    {
        var dir = Path.Combine(_tempDir, "uploads", "products");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private static void WriteSeedCatalog(string tempDir)
    {
        var dataDir = Path.Combine(tempDir, "data");
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(Path.Combine(dataDir, "products.json"), CatalogJson);
        File.WriteAllText(Path.Combine(dataDir, "ingredients.json"), "[]");
        File.WriteAllText(Path.Combine(dataDir, "store-config.json"), StoreJson);
    }

    private static void Configure(IWebHostBuilder builder, string tempDir)
    {
        builder.UseSetting("Persistence", "Json");
        builder.UseSetting("Data:Root", Path.Combine(tempDir, "data"));
        builder.UseSetting("Data:PlatformStoresPath", Path.Combine(tempDir, "data", "platform-stores.json"));
        builder.UseSetting("Data:UploadsRoot", Path.Combine(tempDir, "uploads"));
        builder.UseSetting("Admin:Username", AdminUser);
        builder.UseSetting("Admin:Password", AdminPass);
        builder.UseSetting("Jwt:Key", TestKey);
        builder.UseSetting("Jwt:ExpiresMinutes", "60");
    }

    private sealed class MissingImagesResponse
    {
        public List<MissingProduct>? Products { get; set; }
    }

    private sealed class MissingProduct
    {
        public string? Id { get; set; }
        public string? Name { get; set; }
        public string? ImageUrl { get; set; }
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
