using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Catalog.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) da resolução de subdomínio → loja:
/// GET /api/v1/tenant/resolve (header x-tenant-slug) e GET /api/v1/tenant/{slug},
/// além da validação do Slug no PATCH /api/v1/admin/store.
/// </summary>
public class TenantSlugApiTests : IAsyncLifetime
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";
    private const string AdminUser = "admin-teste";
    private const string AdminPass = "senha-teste";

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public async Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-tenant-slug", Guid.NewGuid().ToString("N"));
        WriteSeed(_tempDir);

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => Configure(b, _tempDir));
        _client = _factory.CreateClient();

        var login = await _client.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(AdminUser, AdminPass));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(body?.Token);
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

    [Fact]
    public async Task Resolve_via_header_returns_store()
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/tenant/resolve");
        req.Headers.Add("x-tenant-slug", "fabin");

        var resp = await _client!.SendAsync(req);
        resp.EnsureSuccessStatusCode();
        var tenant = await resp.Content.ReadFromJsonAsync<TenantResolveDto>();

        Assert.NotNull(tenant);
        Assert.Equal(1, tenant!.StoreId);
        Assert.Equal("fabin", tenant.Slug);
        Assert.Equal("Fabin Lanches", tenant.Name);
        Assert.Equal("active", tenant.Status);
        Assert.True(tenant.Active);
        Assert.True(tenant.AcceptingOrders);
        Assert.Equal("pt-BR", tenant.CurrencyLocale);
    }

    [Theory]
    [InlineData("FABIN")]
    [InlineData("  fabin  ")]
    public async Task Resolve_via_header_normalizes_slug(string slug)
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/tenant/resolve");
        req.Headers.Add("x-tenant-slug", slug);

        var resp = await _client!.SendAsync(req);
        resp.EnsureSuccessStatusCode();
        var tenant = await resp.Content.ReadFromJsonAsync<TenantResolveDto>();
        Assert.NotNull(tenant);
        Assert.Equal("fabin", tenant!.Slug);
    }

    [Fact]
    public async Task Resolve_without_header_returns_404()
    {
        var resp = await _client!.GetAsync("/api/v1/tenant/resolve");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task Resolve_unknown_slug_returns_404()
    {
        var req = new HttpRequestMessage(HttpMethod.Get, "/api/v1/tenant/resolve");
        req.Headers.Add("x-tenant-slug", "loja-que-nao-existe");

        var resp = await _client!.SendAsync(req);
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task Slug_route_returns_store()
    {
        var resp = await _client!.GetAsync("/api/v1/tenant/fabin");
        resp.EnsureSuccessStatusCode();
        var tenant = await resp.Content.ReadFromJsonAsync<TenantResolveDto>();

        Assert.NotNull(tenant);
        Assert.Equal(1, tenant!.StoreId);
        Assert.Equal("fabin", tenant.Slug);
        Assert.Equal("Fabin Lanches", tenant.Name);
    }

    [Fact]
    public async Task Public_store_slug_route_returns_store()
    {
        var resp = await _client!.GetAsync("/api/lojas/slug/fabin");
        resp.EnsureSuccessStatusCode();
        var tenant = await resp.Content.ReadFromJsonAsync<TenantResolveDto>();

        Assert.NotNull(tenant);
        Assert.Equal("fabin", tenant!.Slug);
        Assert.Equal("Fabin Lanches", tenant.Name);
    }

    [Fact]
    public async Task Public_store_slug_route_returns_404_for_unknown_store()
    {
        var resp = await _client!.GetAsync("/api/lojas/slug/loja-inexistente");

        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task Store_signup_requires_postgresql_persistence()
    {
        using var content = new MultipartFormDataContent();
        var fields = new Dictionary<string, string>
        {
            ["Nome"] = "Pizzaria do João",
            ["Slug"] = "pizzaria-do-joao",
            ["Cnpj"] = "04.252.011/0001-10",
            ["Telefone"] = "(11) 99999-9999",
            ["Email"] = "joao@example.com",
            ["Endereco"] = "Rua das Flores",
            ["Numero"] = "123",
            ["Bairro"] = "Centro",
            ["Cidade"] = "São Paulo",
            ["Estado"] = "SP",
            ["Cep"] = "01001-000",
            ["Segmento"] = "pizzaria",
            ["CorPrimaria"] = "#1f6feb",
            ["CorSecundaria"] = "#ffffff",
            ["CorFundo"] = "#f3f4f6",
            ["CorTexto"] = "#2c3e50",
            ["TipoCard"] = "foto-grande",
            ["LayoutCardapio"] = "grade",
            ["EstiloBotao"] = "arredondado"
        };
        foreach (var (name, value) in fields)
            content.Add(new StringContent(value), name);

        var response = await _client!.PostAsync("/api/lojas/criar-completa", content);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
    }

    [Fact]
    public async Task Slug_route_case_insensitive()
    {
        var resp = await _client!.GetAsync("/api/v1/tenant/FaBiN");
        resp.EnsureSuccessStatusCode();
        var tenant = await resp.Content.ReadFromJsonAsync<TenantResolveDto>();
        Assert.NotNull(tenant);
        Assert.Equal("fabin", tenant!.Slug);
    }

    [Fact]
    public async Task Slug_route_unknown_returns_404()
    {
        var resp = await _client!.GetAsync("/api/v1/tenant/outra-loja");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task Slug_route_invalid_returns_404()
    {
        var resp = await _client!.GetAsync("/api/v1/tenant/com%20espaco");
        Assert.Equal(HttpStatusCode.NotFound, resp.StatusCode);
    }

    [Fact]
    public async Task Patch_store_round_trips_slug()
    {
        var patch = new PatchStoreRequest { Slug = "nova-loja-de-teste" };

        var resp = await _client!.PatchAsJsonAsync("/api/v1/admin/store", patch);
        resp.EnsureSuccessStatusCode();
        var store = await resp.Content.ReadFromJsonAsync<StoreDto>();

        Assert.NotNull(store);
        Assert.Equal("nova-loja-de-teste", store!.Slug);
    }

    [Fact]
    public async Task Patch_store_trims_surrounding_whitespace_of_slug()
    {
        var patch = new PatchStoreRequest { Slug = "  fabin  " };

        var resp = await _client!.PatchAsJsonAsync("/api/v1/admin/store", patch);
        resp.EnsureSuccessStatusCode();
        var store = await resp.Content.ReadFromJsonAsync<StoreDto>();

        Assert.NotNull(store);
        Assert.Equal("fabin", store!.Slug);
    }

    [Theory]
    [InlineData("URL INVALIDA")]
    [InlineData("com espaço")]
    [InlineData("--hiphens--")]
    [InlineData("acentu-ação")]
    [InlineData("")]
    public async Task Patch_store_rejects_invalid_slug(string slug)
    {
        var resp = await _client!.PatchAsJsonAsync("/api/v1/admin/store", new PatchStoreRequest { Slug = slug });
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<ErrorBody>();
        Assert.Contains("Slug", body?.Error ?? "");
    }

    private sealed class ErrorBody
    {
        public string? Error { get; set; }
    }

    private static void WriteSeed(string tempDir)
    {
        var dataDir = Path.Combine(tempDir, "data");
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(Path.Combine(dataDir, "products.json"), """{ "categories": [] }""");
        File.WriteAllText(Path.Combine(dataDir, "ingredients.json"), "[]");
        File.WriteAllText(Path.Combine(dataDir, "store-config.json"), StoreJson);
        File.WriteAllText(Path.Combine(dataDir, "admin-users.json"), "[]");
    }

    private static void Configure(IWebHostBuilder builder, string tempDir)
    {
        builder.UseSetting("Persistence", "Json");
        builder.UseSetting("Data:Root", Path.Combine(tempDir, "data"));
        builder.UseSetting("Data:AdminUsersPath", Path.Combine(tempDir, "data", "admin-users.json"));
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
        "schedule": {
            "days": [1, 2, 3, 4, 5, 6],
            "open": "11:00",
            "close": "23:55",
            "closedMessage": "Fechado."
        },
        "deliveryFees": {},
        "averageDeliveryMinutes": 45,
        "acceptingOrders": true
    }
    """;
}