using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Catalog.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) para as lojas da plataforma (aba Lojas / role Dev):
/// CRUD com validação, loja protegida (StoreId=1), duplicação, usuários por loja e reset de senha.
/// </summary>
public class PlatformStoresTests : IAsyncLifetime
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";
    private const string AdminUser = "admin-teste";
    private const string AdminPass = "senha-teste";
    private const string DevUser = "dev-teste";
    private const string DevPass = "dev-senha-teste";

    private const string ProtectedStoreId = "11111111-1111-1111-1111-111111111111";

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public async Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-stores", Guid.NewGuid().ToString("N"));
        WriteSeed(_tempDir);

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => Configure(b, _tempDir));
        _client = _factory.CreateClient();

        // Login como Dev (acesso à plataforma / Lojas)
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

    private static UpsertPlatformStoreRequest ValidStore(string name) => new()
    {
        Name = name,
        Cnpj = "04.252.011/0001-10",
        RazaoSocial = $"{name} LTDA",
        ContactName = "Contato",
        Phone = "(11) 99999-0000",
        Email = "contato@exemplo.com",
        Address = "Rua Exemplo",
        AddressNumber = "100",
        Cep = "14000-000",
        City = "Ribeirão Preto",
        State = "SP",
        Plan = "basic",
        Segment = "Lanchonete",
        MonthlyFee = 149.90m,
        PaymentStatus = "pending",
        Active = true
    };

    [Fact]
    public async Task Create_store_scaffolds_admin_user_and_login_works()
    {
        var body = ValidStore("Burger do João");
        body.AdminUsername = "joao_admin";
        body.AdminPassword = "joao1234";

        var created = await _client!.PostAsJsonAsync("/api/v1/admin/platform-stores", body);
        created.EnsureSuccessStatusCode();
        var resp = await created.Content.ReadFromJsonAsync<CreatePlatformStoreResponse>();
        Assert.NotNull(resp?.Store);
        Assert.Equal("joao_admin", resp.AdminUsername);
        Assert.Equal("active", resp.Store.Status);

        // usuário admin vinculado aparece na lista de usuários da loja
        var usersResp = await _client!.GetAsync($"/api/v1/admin/platform-stores/{resp.Store.Id}/users");
        usersResp.EnsureSuccessStatusCode();
        var users = await usersResp.Content.ReadFromJsonAsync<List<StoreUserDto>>();
        Assert.NotNull(users);
        Assert.Single(users);
        Assert.Equal("joao_admin", users[0].Username);
        Assert.Equal(StaffRoles.Admin, users[0].Role);

        // o novo admin consegue fazer login (senha bcrypt gravada)
        var login = await _client!.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest("joao_admin", "joao1234"));
        login.EnsureSuccessStatusCode();
        var loginBody = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.Equal(StaffRoles.Admin, loginBody!.Role);
    }

    [Fact]
    public async Task Create_store_rejects_invalid_cnpj_and_plan()
    {
        var bad = ValidStore("Inválida");
        bad.Cnpj = "123";
        bad.Plan = "enterprise";
        var resp = await _client!.PostAsJsonAsync("/api/v1/admin/platform-stores", bad);
        Assert.Equal(System.Net.HttpStatusCode.BadRequest, resp.StatusCode);
    }

    [Fact]
    public async Task Create_store_rejects_duplicate_admin_username()
    {
        var first = ValidStore("Loja A");
        first.AdminUsername = "usu_soma";
        first.AdminPassword = "senha123";
        (await _client!.PostAsJsonAsync("/api/v1/admin/platform-stores", first)).EnsureSuccessStatusCode();

        var second = ValidStore("Loja B");
        second.AdminUsername = "USU_SOMA";
        second.AdminPassword = "outra456";
        var resp = await _client!.PostAsJsonAsync("/api/v1/admin/platform-stores", second);
        Assert.Equal(System.Net.HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Duplicate_store_creates_setup_copy_with_admin_user()
    {
        var (created, _) = await CreateStoreAsync("Massa da Nonna");
        var dup = await _client!.PostAsJsonAsync(
            $"/api/v1/admin/platform-stores/{created.Id}/duplicate",
            new UpsertPlatformStoreRequest
            {
                AdminUsername = "nonna_admin",
                AdminPassword = "nonna123"
            });
        dup.EnsureSuccessStatusCode();
        var resp = await dup.Content.ReadFromJsonAsync<CreatePlatformStoreResponse>();
        Assert.NotNull(resp?.Store);
        Assert.StartsWith("Massa da Nonna (cópia)", resp.Store.Name);
        Assert.Equal("setup", resp.Store.Status);
        Assert.Equal("pending", resp.Store.PaymentStatus);

        var usersResp = await _client!.GetAsync($"/api/v1/admin/platform-stores/{resp.Store.Id}/users");
        usersResp.EnsureSuccessStatusCode();
        var users = await usersResp.Content.ReadFromJsonAsync<List<StoreUserDto>>();
        Assert.Contains(users!, u => u.Username == "nonna_admin");
    }

    [Fact]
    public async Task Delete_protected_store_returns_conflict()
    {
        var resp = await _client!.DeleteAsync($"/api/v1/admin/platform-stores/{ProtectedStoreId}");
        Assert.Equal(System.Net.HttpStatusCode.Conflict, resp.StatusCode);
    }

    [Fact]
    public async Task Running_store_is_active_and_mirrors_admin_store_config()
    {
        var store = await _client!.GetFromJsonAsync<PlatformStoreDto>(
            $"/api/v1/admin/platform-stores/{ProtectedStoreId}");
        Assert.NotNull(store);
        Assert.Equal(1, store.StoreId);
        Assert.Equal("Fabin Lanches", store.Name);
        Assert.Equal("active", store.Status);
        Assert.True(store.Active);
        Assert.Equal("5516992496886", store.Phone);
    }

    [Fact]
    public async Task Store_config_change_invalidates_platform_stores_cache()
    {
        // primeiro GET popula o cache de lojas (ApplyStoreConfig embute o store config na resposta)
        var before = await _client!.GetFromJsonAsync<PlatformStoreDto>(
            $"/api/v1/admin/platform-stores/{ProtectedStoreId}");
        Assert.NotNull(before);
        Assert.Equal("Fabin Lanches", before.Name);

        // o PATCH /admin/store exige o papel Admin da loja (não o Dev da plataforma)
        var adminLogin = await _client!.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(AdminUser, AdminPass));
        adminLogin.EnsureSuccessStatusCode();
        var adminBody = await adminLogin.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(adminBody?.Token);
        using var adminClient = _factory!.CreateClient();
        adminClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", adminBody.Token);

        var resp = await adminClient.PatchAsJsonAsync("/api/v1/admin/store",
            new PatchStoreRequest { StoreName = "Fabin Renomeado", Whatsapp = "5516987654321" });
        resp.EnsureSuccessStatusCode();

        // a lista de lojas (cacheada) deve refletir imediatamente, sem esperar o TTL
        var after = await _client!.GetFromJsonAsync<PlatformStoreDto>(
            $"/api/v1/admin/platform-stores/{ProtectedStoreId}");
        Assert.NotNull(after);
        Assert.Equal("Fabin Renomeado", after.Name);
        Assert.Equal("5516987654321", after.Phone);
    }

    [Fact]
    public async Task Delete_unprotected_store_succeeds()
    {
        var (created, _) = await CreateStoreAsync("Descartável");
        var resp = await _client!.DeleteAsync($"/api/v1/admin/platform-stores/{created.Id}");
        Assert.Equal(System.Net.HttpStatusCode.NoContent, resp.StatusCode);

        // exclusão é lógica: a loja continua existindo como inativa
        var after = await _client!.GetAsync($"/api/v1/admin/platform-stores/{created.Id}");
        after.EnsureSuccessStatusCode();
        var store = await after.Content.ReadFromJsonAsync<PlatformStoreDto>();
        Assert.NotNull(store);
        Assert.Equal("inactive", store.Status);
        Assert.False(store.Active);
    }

    [Fact]
    public async Task Search_and_filters_work()
    {
        await CreateStoreAsync("Hamburgueria X");
        await CreateStoreAsync("Pizzaria Y");

        var all = await _client!.GetFromJsonAsync<List<PlatformStoreDto>>("/api/v1/admin/platform-stores/");
        Assert.NotNull(all);
        Assert.True(all.Count >= 3, "Deve incluir a loja protegida semeada + as criadas.");

        var filtered = await _client!.GetFromJsonAsync<List<PlatformStoreDto>>(
            "/api/v1/admin/platform-stores/?search=pizzaria");
        Assert.NotNull(filtered);
        Assert.Single(filtered);
        Assert.StartsWith("Pizzaria", filtered[0].Name);

        var byStatus = await _client!.GetFromJsonAsync<List<PlatformStoreDto>>(
            "/api/v1/admin/platform-stores/?status=setup");
        Assert.NotNull(byStatus);
        Assert.All(byStatus, s => Assert.Equal("setup", s.Status));
    }

    [Fact]
    public async Task Segment_is_persisted_and_filterable()
    {
        var (created, _) = await CreateStoreAsync("Açougue Central");
        Assert.Equal("Lanchonete", created.Segment);

        var custom = ValidStore("Empório do Gás");
        custom.Segment = "Gás";
        var resp = await _client!.PostAsJsonAsync("/api/v1/admin/platform-stores", custom);
        resp.EnsureSuccessStatusCode();
        var createdCustom = (await resp.Content.ReadFromJsonAsync<CreatePlatformStoreResponse>())!.Store;
        Assert.Equal("Gás", createdCustom.Segment);

        var bySegment = await _client!.GetFromJsonAsync<List<PlatformStoreDto>>(
            "/api/v1/admin/platform-stores/?segment=Lanchonete");
        Assert.NotNull(bySegment);
        Assert.All(bySegment, s => Assert.Equal("Lanchonete", s.Segment));
        Assert.Contains(bySegment, s => s.Id == created.Id);
    }

    [Fact]
    public async Task Update_store_persists_new_fields()
    {
        var (created, _) = await CreateStoreAsync("Antiga");
        var patch = ValidStore("Antiga (renomeada)");
        patch.Cnpj = "33.000.167/0001-01";
        patch.City = "Franca";
        patch.Status = "inactive";
        patch.Active = false;
        patch.Segment = "Hamburgueria";

        var resp = await _client!.PutAsJsonAsync($"/api/v1/admin/platform-stores/{created.Id}", patch);
        resp.EnsureSuccessStatusCode();
        var updated = await resp.Content.ReadFromJsonAsync<PlatformStoreDto>();
        Assert.NotNull(updated);
        Assert.Equal("33000167000101", updated.Cnpj);
        Assert.Equal("Franca", updated.City);
        Assert.Equal("inactive", updated.Status);
        Assert.False(updated.Active);
        Assert.Equal("Hamburgueria", updated.Segment);
    }

    [Fact]
    public async Task Reset_password_then_new_password_logs_in()
    {
        var (store, username) = await CreateStoreAsync("Senha Fácil");
        var users = await GetStoreUsersAsync(store.Id);
        var target = users.First(u => u.Username == username);

        var reset = await _client!.PostAsJsonAsync(
            $"/api/v1/admin/platform-stores/{store.Id}/users/{target.Id}/reset-password",
            new ResetStoreUserPasswordRequest("nova-senha-99"));
        reset.EnsureSuccessStatusCode();

        var old = await _client!.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(username, "senha123"));
        Assert.Equal(System.Net.HttpStatusCode.Unauthorized, old.StatusCode);

        var fresh = await _client!.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(username, "nova-senha-99"));
        fresh.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Delete_user_removes_it_from_store()
    {
        var (store, _) = await CreateStoreAsync("Com Usuários");

        var added = await _client!.PostAsJsonAsync(
            $"/api/v1/admin/platform-stores/{store.Id}/users",
            new CreateStoreUserRequest("atend_teste", "atend123", StaffRoles.Atendimento, store.StoreId));
        added.EnsureSuccessStatusCode();
        var user = await added.Content.ReadFromJsonAsync<StoreUserDto>();
        Assert.NotNull(user);

        var del = await _client!.DeleteAsync($"/api/v1/admin/platform-stores/{store.Id}/users/{user.Id}");
        Assert.Equal(System.Net.HttpStatusCode.NoContent, del.StatusCode);

        var users = await GetStoreUsersAsync(store.Id);
        Assert.DoesNotContain(users, u => u.Id == user.Id);
    }

    private static string NewUsername() =>
        $"senha_{Guid.NewGuid():N}"[..16];

    private async Task<(PlatformStoreDto Store, string AdminUsername)> CreateStoreAsync(string name)
    {
        var username = NewUsername();
        var body = ValidStore(name);
        body.AdminUsername = username;
        body.AdminPassword = "senha123";
        var resp = await _client!.PostAsJsonAsync("/api/v1/admin/platform-stores", body);
        resp.EnsureSuccessStatusCode();
        var parsed = await resp.Content.ReadFromJsonAsync<CreatePlatformStoreResponse>();
        return (parsed!.Store, username);
    }

    private async Task<List<StoreUserDto>> GetStoreUsersAsync(Guid id)
    {
        var resp = await _client!.GetAsync($"/api/v1/admin/platform-stores/{id}/users");
        resp.EnsureSuccessStatusCode();
        return await resp.Content.ReadFromJsonAsync<List<StoreUserDto>>() ?? [];
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
