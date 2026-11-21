using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) dos grupos de modificadores:
/// os produtos do cardápio não são auto-preenchidos com o grupo "Adicionais"
/// (sem backfill no startup), persistência no upsert de produto, preservação
/// quando o request omite os grupos (ex.: toggle de disponibilidade)
/// e rejeição de grupos inválidos.
/// </summary>
public class ModifierGroupTests : IAsyncLifetime
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
            },
            {
                "id": "bebidas",
                "title": "Bebidas",
                "sortOrder": 2,
                "showInMenu": true,
                "items": [
                    { "id": "coca", "name": "Coca-Cola", "price": 6, "available": true, "showInMenu": true }
                ]
            },
            {
                "id": "adicionais",
                "title": "Adicionais",
                "sortOrder": 3,
                "showInMenu": false,
                "items": [
                    { "id": "bacon-extra", "name": "Bacon extra", "price": 3, "available": true, "showInMenu": false },
                    { "id": "cheddar", "name": "Cheddar", "price": 4, "available": true, "showInMenu": false }
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
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-mods", Guid.NewGuid().ToString("N"));
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
    public async Task Startup_does_not_scaffold_addons_onto_products()
    {
        // Sem scaffold automático: os produtos só ganham "Adicionais" quando o admin adiciona.
        var xBacon = await GetPublicProduct("burgers", "x-bacon");
        Assert.True(xBacon.ModifierGroups is null or { Count: 0 });

        var coca = await GetPublicProduct("bebidas", "coca");
        Assert.True(coca.ModifierGroups is null or { Count: 0 });

        // A categoria legada "Adicionais" continua oculta do cardápio público.
        var catalog = await _client!.GetFromJsonAsync<CatalogDto>("/api/v1/catalog");
        Assert.NotNull(catalog);
        Assert.DoesNotContain(catalog.Categories, c => c.Id == "adicionais");
    }

    [Fact]
    public async Task Upsert_persists_groups_and_preserves_when_request_omits_them()
    {
        var custom = new List<ModifierGroupDto>
        {
            new("g-extras", "Extras", 1, false, 0, 3,
                [new ModifierOptionDto("o-ovo", "Ovo", 2.5m, 1, true)])
        };
        await PutProduct("x-bacon", "burgers", custom);
        var saved = Assert.Single((await GetPublicProduct("burgers", "x-bacon")).ModifierGroups ?? []);
        Assert.Equal("g-extras", saved.Id);
        Assert.Equal("Ovo", Assert.Single(saved.Options!).Name);

        // Sem enviar grupos (ex.: toggle de disponibilidade) os grupos são preservados
        await PutProduct("x-bacon", "burgers", modifierGroups: null);
        var preserved = Assert.Single((await GetPublicProduct("burgers", "x-bacon")).ModifierGroups ?? []);
        Assert.Equal("g-extras", preserved.Id);

        // Enviar lista vazia limpa os grupos
        await PutProduct("x-bacon", "burgers", modifierGroups: []);
        var cleared = (await GetPublicProduct("burgers", "x-bacon")).ModifierGroups;
        Assert.True(cleared is null or { Count: 0 });
    }

    [Fact]
    public async Task Invalid_modifier_group_is_rejected()
    {
        var unnamed = new List<ModifierGroupDto>
        {
            new("g-x", "   ", 1, false, 0, 1, [new ModifierOptionDto("o1", "Ovo", 1m, 1, true)])
        };
        var res = await PutProductRaw("x-bacon", "burgers", unnamed);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);

        var tooExpensive = new List<ModifierGroupDto>
        {
            new("g-x", "Extras", 1, false, 0, 1, [new ModifierOptionDto("o1", "Ovo", 1000m, 1, true)])
        };
        res = await PutProductRaw("x-bacon", "burgers", tooExpensive);
        Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
    }

    private Task<HttpResponseMessage> PutProductRaw(string id, string categoryId, List<ModifierGroupDto>? modifierGroups) =>
        _client!.PutAsJsonAsync("/api/v1/admin/products",
            new UpsertProductRequest(id, categoryId, "X-Bacon", 25, true, null, null, null, null, null, null, true, modifierGroups));

    private async Task PutProduct(string id, string categoryId, List<ModifierGroupDto>? modifierGroups)
    {
        var response = await PutProductRaw(id, categoryId, modifierGroups);
        Assert.True(response.IsSuccessStatusCode, await response.Content.ReadAsStringAsync());
    }

    private async Task<ProductDto> GetPublicProduct(string categoryId, string productId)
    {
        var catalog = await _client!.GetFromJsonAsync<CatalogDto>("/api/v1/catalog");
        Assert.NotNull(catalog);
        var product = Assert.Single(Assert.Single(catalog.Categories, c => c.Id == categoryId).Items, p => p.Id == productId);
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
