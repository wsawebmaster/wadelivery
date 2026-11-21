using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) para a guarda de arquivos de imagem:
/// um arquivo de upload compartilhado por mais de um produto só é apagado quando
/// nenhum produto o referencia mais, tanto no PUT quanto no DELETE de produtos.
/// </summary>
public class ProductImageCleanupTests : IAsyncLifetime
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";
    private const string AdminUser = "admin-teste";
    private const string AdminPass = "senha-teste";
    private const string CategoryJson = """
    {
        "id": "1",
        "title": "Bebidas",
        "sortOrder": 1,
        "items": []
    }
    """;

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public async Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-it", Guid.NewGuid().ToString("N"));
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
    public async Task PutProduct_changing_shared_image_keeps_file_until_no_references()
    {
        var prodDir = ProductsDir();
        var sharedFile = Path.Combine(prodDir, "fanta-uva.webp");
        File.WriteAllBytes(sharedFile, new byte[] { 1, 2, 3 });

        await PutProduct("10", "Fanta Uva", "/uploads/products/fanta-uva.webp");
        await PutProduct("11", "Fanta Uva (cópia)", "/uploads/products/fanta-uva.webp");

        await PutProduct("10", "Fanta Uva", "/uploads/products/fanta-nova.webp");
        Assert.True(File.Exists(sharedFile),
            "Arquivo compartilhado deve sobreviver enquanto outro produto o referencia.");

        await PutProduct("11", "Fanta Uva (cópia)", "/uploads/products/fanta-nova.webp");
        Assert.False(File.Exists(sharedFile),
            "Arquivo deve ser removido quando o último produto que o referencia muda de imagem.");
    }

    [Fact]
    public async Task DeleteProduct_shared_image_keeps_file_until_last_reference_removed()
    {
        var prodDir = ProductsDir();
        var sharedFile = Path.Combine(prodDir, "monster.webp");
        File.WriteAllBytes(sharedFile, new byte[] { 1 });

        await PutProduct("20", "Monster", "/uploads/products/monster.webp");
        await PutProduct("21", "Monster (cópia)", "/uploads/products/monster.webp");

        await DeleteProduct("20");
        Assert.True(File.Exists(sharedFile),
            "Após excluir um dos produtos, o arquivo ainda é referenciado pelo outro.");

        await DeleteProduct("21");
        Assert.False(File.Exists(sharedFile),
            "Após excluir o último produto, o arquivo deve ser removido.");
    }

    [Fact]
    public async Task DeleteProduct_non_shared_image_removes_file()
    {
        var prodDir = ProductsDir();
        var file = Path.Combine(prodDir, "coca.webp");
        File.WriteAllBytes(file, new byte[] { 1 });

        await PutProduct("30", "Coca", "/uploads/products/coca.webp");
        await DeleteProduct("30");

        Assert.False(File.Exists(file), "Imagem de produto excluído sem compartilhamento deve ser removida.");
    }

    private string ProductsDir()
    {
        var dir = Path.Combine(_tempDir, "uploads", "products");
        Directory.CreateDirectory(dir);
        return dir;
    }

    private async Task PutProduct(string id, string name, string imageUrl)
    {
        var response = await _client!.PutAsJsonAsync("/api/v1/admin/products", new UpsertProductRequest(
            Id: id, CategoryId: "1", Name: name, Price: 10m, Available: true, ImageUrl: imageUrl));
        response.EnsureSuccessStatusCode();
    }

    private async Task DeleteProduct(string id)
    {
        var response = await _client!.DeleteAsync($"/api/v1/admin/products/{id}");
        response.EnsureSuccessStatusCode();
    }

    private static void WriteSeedCatalog(string tempDir)
    {
        var dataDir = Path.Combine(tempDir, "data");
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(Path.Combine(dataDir, "products.json"),
            $$"""{ "categories": [ {{CategoryJson}} ] }""");
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
