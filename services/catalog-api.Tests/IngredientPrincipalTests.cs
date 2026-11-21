using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) do ingrediente principal do produto
/// (não-removível pelo cliente na personalização): persistência no upsert,
/// exposição no catálogo público, preservação quando o request omite a lista
/// e rejeição de principal fora da seleção de ingredientes.
/// </summary>
public class IngredientPrincipalTests : IAsyncLifetime
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";
    private const string AdminUser = "admin-teste";
    private const string AdminPass = "senha-teste";

    private const string ProductsJson = """
    {
        "categories": [
            {
                "id": "burgers",
                "title": "Hambúrgueres",
                "sortOrder": 1,
                "showInMenu": true,
                "items": [
                    {
                        "id": "x-bacon",
                        "name": "X-Bacon",
                        "price": 25,
                        "available": true,
                        "showInMenu": true,
                        "ingredients": [
                            { "id": "pao", "name": "Pão", "sortOrder": 1 },
                            { "id": "bacon", "name": "Bacon", "sortOrder": 2 }
                        ]
                    }
                ]
            }
        ]
    }
    """;

    private const string IngredientsJson = """
    [
        { "id": "pao", "name": "Pão", "sortOrder": 1, "available": true },
        { "id": "bacon", "name": "Bacon", "sortOrder": 2, "available": true }
    ]
    """;

    private const string StoreJson = """
    {
        "storeName": "Fabin Lanches",
        "whatsapp": "5516992496886",
        "pixKey": "16992496886",
        "minOrder": 0,
        "currencyLocale": "pt-BR",
        "schedule": { "days": [1, 2, 3, 4, 5, 6], "open": "11:00", "close": "23:00", "closedMessage": "Fechado" },
        "deliveryFees": {}
    }
    """;

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public async Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-principal", Guid.NewGuid().ToString("N"));
        var dataDir = Path.Combine(_tempDir, "data");
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(Path.Combine(dataDir, "products.json"), ProductsJson);
        File.WriteAllText(Path.Combine(dataDir, "ingredients.json"), IngredientsJson);
        File.WriteAllText(Path.Combine(dataDir, "store-config.json"), StoreJson);

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
    public async Task Upsert_persists_and_catalog_exposes_isPrincipal()
    {
        await PutProduct("x-bacon", "burgers", new List<string> { "pao" });

        var product = await GetPublicProduct("x-bacon");
        var pao = Assert.Single(product.Ingredients!, i => i.Id == "pao");
        Assert.True(pao.IsPrincipal);
        var bacon = Assert.Single(product.Ingredients!, i => i.Id == "bacon");
        Assert.False(bacon.IsPrincipal);
    }

    [Fact]
    public async Task Principal_is_preserved_when_request_omits_the_list()
    {
        await PutProduct("x-bacon", "burgers", new List<string> { "pao" });

        // Sem enviar principalIngredientIds (ex.: toggle de disponibilidade) o principal é preservado
        await PutProduct("x-bacon", "burgers", principalIngredientIds: null);

        var product = await GetPublicProduct("x-bacon");
        Assert.True(Assert.Single(product.Ingredients!, i => i.Id == "pao").IsPrincipal);
    }

    [Fact]
    public async Task Principal_outside_selection_is_rejected()
    {
        var response = await _client!.PutAsJsonAsync("/api/v1/admin/products",
            new UpsertProductRequest(
                "x-bacon", "burgers", "X-Bacon", 25, true, null,
                IngredientIds: new List<string> { "pao" },
                PrincipalIngredientIds: new List<string> { "bacon" }));
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }

    [Fact]
    public async Task Principal_list_is_cleared_when_request_changes_it()
    {
        await PutProduct("x-bacon", "burgers", new List<string> { "pao" });

        // Envia lista explícita diferente: o antigo principal deixa de ser principal
        await PutProduct("x-bacon", "burgers", new List<string> { "bacon" });

        var product = await GetPublicProduct("x-bacon");
        Assert.False(Assert.Single(product.Ingredients!, i => i.Id == "pao").IsPrincipal);
        Assert.True(Assert.Single(product.Ingredients!, i => i.Id == "bacon").IsPrincipal);
    }

    private async Task PutProduct(string id, string categoryId, List<string>? principalIngredientIds)
    {
        var response = await _client!.PutAsJsonAsync("/api/v1/admin/products",
            new UpsertProductRequest(
                id, categoryId, "X-Bacon", 25, true, null,
                IngredientIds: new List<string> { "pao", "bacon" },
                PrincipalIngredientIds: principalIngredientIds));
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    private async Task<ProductDto> GetPublicProduct(string productId)
    {
        var catalog = await _client!.GetFromJsonAsync<CatalogDto>("/api/v1/catalog");
        Assert.NotNull(catalog);
        var product = Assert.Single(
            catalog.Categories.SelectMany(c => c.Items),
            p => p.Id == productId);
        return product;
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
}