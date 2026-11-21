using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Catalog.Api.Repositories;
using Catalog.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) para as estatísticas de loja (aba Lojas):
/// endpoint por tenant (StoreAdmin), ferramenta de snapshot (Dev) e persistência do snapshot.
/// </summary>
public class StoreStatsTests : IAsyncLifetime
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";
    private const string AdminUser = "admin-stats";
    private const string AdminPass = "senha-stats";
    private const string DevUser = "dev-stats";
    private const string DevPass = "dev-senha-stats";

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public async Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-stats", Guid.NewGuid().ToString("N"));
        WriteSeed(_tempDir);

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => Configure(b, _tempDir));
        _client = _factory.CreateClient();

        var login = await _client.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(DevUser, DevPass));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(body?.Token);
        Assert.Equal(StaffRoles.Dev, body!.Role);
        _client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body.Token);
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

    private async Task<HttpClient> CreateAdminClientAsync()
    {
        var login = await _client!.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(AdminUser, AdminPass));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.Equal(StaffRoles.Admin, body!.Role);
        var adminClient = _factory!.CreateClient();
        adminClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body.Token);
        return adminClient;
    }

    [Fact]
    public async Task Store_stats_requires_authentication()
    {
        var anon = _factory!.CreateClient();
        var resp = await anon.GetAsync("/api/v1/admin/platform/store-stats");
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, resp.StatusCode);
    }

    [Fact]
    public async Task Store_stats_requires_store_admin_role()
    {
        var dev = _client!;
        var resp = await dev.GetAsync("/api/v1/admin/platform/store-stats");
        Assert.Equal(System.Net.HttpStatusCode.Forbidden, resp.StatusCode);
    }

    [Fact]
    public async Task Store_stats_returns_shape_for_tenant()
    {
        using var admin = await CreateAdminClientAsync();
        var resp = await admin.GetAsync("/api/v1/admin/platform/store-stats");
        resp.EnsureSuccessStatusCode();

        var stats = await resp.Content.ReadFromJsonAsync<StoreStatsDto>();
        Assert.NotNull(stats);
        Assert.NotEqual(default, stats!.FetchedAt);
        Assert.True(stats.MenuViews30d >= 0);
        Assert.True(stats.MenuViewsTotal >= stats.MenuViews30d);
        // Sem banco (Persistence=Json) as contagens de pedidos não ficam disponíveis.
        Assert.False(stats.OrdersAvailable);
        Assert.Null(stats.Orders30d);
        Assert.Null(stats.OrdersTotal);
    }

    [Fact]
    public async Task Tools_stats_endpoint_is_unavailable_in_json_mode()
    {
        var resp = await _client!.PostAsync("/api/v1/admin/tools/1/stats", null);
        Assert.Equal(System.Net.HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task Admin_login_touches_store_last_access()
    {
        // O usuário Admin do seed não tem StoreId (NULL). O login deve registrar o acesso
        // da loja do deployment via fallback de tenant (STORE_ID → 1 = Fabin).
        var devBefore = await _client!.GetAsync("/api/v1/admin/platform-stores");
        devBefore.EnsureSuccessStatusCode();
        var listBefore = await devBefore.Content.ReadFromJsonAsync<List<PlatformStoreDto>>();
        Assert.Null(listBefore!.Single().LastAccessAt);

        using var admin = await CreateAdminClientAsync();

        var devAfter = await _client!.GetAsync("/api/v1/admin/platform-stores");
        devAfter.EnsureSuccessStatusCode();
        var listAfter = await devAfter.Content.ReadFromJsonAsync<List<PlatformStoreDto>>();
        var fabin = listAfter!.Single();
        Assert.NotNull(fabin.LastAccessAt);
        Assert.True((DateTime.UtcNow - fabin.LastAccessAt!.Value) < TimeSpan.FromMinutes(2));
    }

    [Fact]
    public async Task SaveStats_round_trips_through_repository()
    {
        var repo = _factory!.Services.GetRequiredService<IPlatformStoreRepository>();
        var dto = new StoreStatsDto(
            FetchedAt: DateTime.UtcNow,
            Error: null,
            LastAccessAt: new DateTime(2026, 1, 15, 10, 30, 0, DateTimeKind.Utc),
            MenuViews30d: 1234,
            MenuViewsTotal: 9999,
            Orders30d: 12,
            OrdersTotal: 88,
            OrdersAvailable: true);

        await repo.SaveStatsAsync(1, dto, default);

        var list = await repo.ListAsync(default);
        var store = Assert.Single(list);
        Assert.NotNull(store.Stats);
        Assert.Equal(1234, store.Stats!.MenuViews30d);
        Assert.Equal(9999, store.Stats.MenuViewsTotal);
        Assert.Equal(88, store.Stats.OrdersTotal);
        Assert.Equal(new DateTime(2026, 1, 15, 10, 30, 0, DateTimeKind.Utc), store.Stats.LastAccessAt);
    }

    private static void WriteSeed(string tempDir)
    {
        var dataDir = Path.Combine(tempDir, "data");
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(Path.Combine(dataDir, "products.json"), """{ "categories": [] }""");
        File.WriteAllText(Path.Combine(dataDir, "ingredients.json"), "[]");
        File.WriteAllText(Path.Combine(dataDir, "store-config.json"), StoreJson);
        File.WriteAllText(Path.Combine(dataDir, "platform-stores.json"), PlatformStoresJson);
    }

    private static void Configure(IWebHostBuilder builder, string tempDir)
    {
        builder.UseSetting("Persistence", "Json");
        builder.UseSetting("Data:Root", Path.Combine(tempDir, "data"));
        builder.UseSetting("Data:PlatformStoresPath", Path.Combine(tempDir, "data", "platform-stores.json"));
        builder.UseSetting("Data:AdminUsersPath", Path.Combine(tempDir, "data", "admin-users.json"));
        builder.UseSetting("Data:UploadsRoot", Path.Combine(tempDir, "uploads"));
        builder.UseSetting("Admin:Username", AdminUser);
        builder.UseSetting("Admin:Password", AdminPass);
        builder.UseSetting("Dev:Username", DevUser);
        builder.UseSetting("Dev:Password", DevPass);
        builder.UseSetting("Jwt:Key", TestKey);
        builder.UseSetting("Jwt:ExpiresMinutes", "60");
    }

    private const string PlatformStoresJson = """
    [
        {
            "id": "11111111-1111-1111-1111-111111111111",
            "name": "Fabin Lanches",
            "frontUrl": "https://delivery-fabin.vercel.app/",
            "frontNotes": null,
            "backUrl": null,
            "backNotes": null,
            "databaseInfo": null,
            "databaseUrl": null,
            "adminUrl": null,
            "localFrontUrl": null,
            "localBackUrl": null,
            "localAdminUrl": null,
            "localDatabaseUrl": null,
            "monthlyFee": 0,
            "courtesy": true,
            "courtesyUntil": null,
            "paymentStatus": "courtesy",
            "lastPaymentAt": null,
            "nextDueAt": null,
            "paymentNotes": null,
            "payments": [],
            "active": true,
            "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-01T00:00:00Z",
            "storeId": 1,
            "cnpj": "00000000000000",
            "razaoSocial": "Fabin Lanches LTDA",
            "city": "São Paulo",
            "state": "SP",
            "status": "active",
            "plan": "starter"
        }
    ]
    """;

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
