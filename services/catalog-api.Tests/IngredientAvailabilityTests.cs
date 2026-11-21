using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) da disponibilidade de ingredientes:
/// ingredientes com Available=false não aparecem na lista de ingredientes dos
/// produtos em GET /api/v1/catalog (cardápio público) e voltam quando religados
/// via PUT /api/v1/admin/ingredients.
/// </summary>
public class IngredientAvailabilityTests : IAsyncLifetime
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
                            { "id": "bacon", "name": "Bacon", "sortOrder": 2 },
                            { "id": "queijo", "name": "Queijo", "sortOrder": 3 }
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
        { "id": "bacon", "name": "Bacon", "sortOrder": 2, "available": false },
        { "id": "queijo", "name": "Queijo", "sortOrder": 3, "available": true }
    ]
    """;

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public async Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-ingavail", Guid.NewGuid().ToString("N"));
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
    public async Task Catalog_hides_unavailable_ingredients_from_products()
    {
        var ingredients = await GetPublicProductIngredients("x-bacon");

        Assert.Contains(ingredients, i => i.Id == "pao");
        Assert.Contains(ingredients, i => i.Id == "queijo");
        Assert.DoesNotContain(ingredients, i => i.Id == "bacon");
    }

    [Fact]
    public async Task Ingredient_toggle_reverts_hidden_state()
    {
        Assert.DoesNotContain(await GetPublicProductIngredients("x-bacon"), i => i.Id == "bacon");

        // Religado via admin: volta no cardápio público
        var response = await _client!.PutAsJsonAsync("/api/v1/admin/ingredients",
            new UpsertIngredientRequest("bacon", "Bacon", null, null, true));
        response.EnsureSuccessStatusCode();
        Assert.Contains(await GetPublicProductIngredients("x-bacon"), i => i.Id == "bacon");

        // E desligado de novo: some (idempotente)
        response = await _client.PutAsJsonAsync("/api/v1/admin/ingredients",
            new UpsertIngredientRequest("bacon", "Bacon", null, null, false));
        response.EnsureSuccessStatusCode();
        Assert.DoesNotContain(await GetPublicProductIngredients("x-bacon"), i => i.Id == "bacon");
    }

    [Fact]
    public async Task Admin_ingredients_list_exposes_available()
    {
        var data = await _client!.GetFromJsonAsync<List<IngredientDto>>("/api/v1/admin/ingredients");
        Assert.NotNull(data);
        var bacon = Assert.Single(data, i => i.Id == "bacon");
        Assert.False(bacon.Available);
        var pao = Assert.Single(data, i => i.Id == "pao");
        Assert.True(pao.Available);
    }

    private async Task<List<IngredientDto>> GetPublicProductIngredients(string productId)
    {
        var catalog = await _client!.GetFromJsonAsync<CatalogDto>("/api/v1/catalog");
        Assert.NotNull(catalog);
        var product = Assert.Single(Assert.Single(catalog.Categories, c => c.Id == "burgers").Items,
            p => p.Id == productId);
        return product.Ingredients ?? [];
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