using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Catalog.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) para a conta do usuário autenticado:
/// /auth/me com displayName, PATCH /auth/profile e POST /auth/change-password.
/// Usuários persistidos (admin-users.json) alteram senha/perfil; usuários vindos
/// de configuração (Dev/Admin/Atendimento no appsettings) recebem 400 ConfigManaged.
/// </summary>
public class AuthAccountTests : IAsyncLifetime
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";
    private const string DevUser = "dev-teste";
    private const string DevPass = "dev-senha-teste";
    private const string StoreUser = "loja_admin";
    private const string StorePass = "senha123";

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-account", Guid.NewGuid().ToString("N"));
        WriteSeed(_tempDir);

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => Configure(b, _tempDir));
        _client = _factory.CreateClient();
        return Task.CompletedTask;
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

    private async Task<string> LoginAsync(string username, string password)
    {
        var resp = await _client!.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(username, password));
        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(body?.Token);
        return body!.Token;
    }

    private void UseToken(string token) =>
        _client!.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token);

    [Fact]
    public async Task Change_password_rejects_wrong_current_then_updates_credentials()
    {
        UseToken(await LoginAsync(StoreUser, StorePass));

        // senha atual errada → 400
        var wrong = await _client!.PostAsJsonAsync("/api/v1/auth/change-password",
            new ChangePasswordRequest("errada123", "novaSenha1"));
        Assert.Equal(HttpStatusCode.BadRequest, wrong.StatusCode);
        var wrongBody = await wrong.Content.ReadFromJsonAsync<Dictionary<string, string>>();
        Assert.Contains("incorreta", wrongBody?["error"] ?? "");

        // fluxo completo: troca ok, antiga falha, nova funciona
        var ok = await _client.PostAsJsonAsync("/api/v1/auth/change-password",
            new ChangePasswordRequest(StorePass, "novaSenha1"));
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);

        var oldLogin = await _client.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(StoreUser, StorePass));
        Assert.Equal(HttpStatusCode.Unauthorized, oldLogin.StatusCode);

        UseToken(await LoginAsync(StoreUser, "novaSenha1"));
        var me = await _client.GetAsync("/api/v1/auth/me");
        me.EnsureSuccessStatusCode();
        var meBody = await me.Content.ReadFromJsonAsync<MeResponse>();
        Assert.Equal(StoreUser, meBody?.Username);
    }

    [Fact]
    public async Task Change_password_validates_minimum_length()
    {
        UseToken(await LoginAsync(StoreUser, StorePass));

        var resp = await _client!.PostAsJsonAsync("/api/v1/auth/change-password",
            new ChangePasswordRequest(StorePass, "curta"));
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<Dictionary<string, string>>();
        Assert.Contains("curta", body?["error"] ?? "");
    }

    [Fact]
    public async Task Profile_patch_updates_display_name_visible_on_me()
    {
        UseToken(await LoginAsync(StoreUser, StorePass));

        // antes do patch: sem nome de exibição, tenant resolvido pelo claim
        var before = await _client!.GetAsync("/api/v1/auth/me");
        before.EnsureSuccessStatusCode();
        var beforeBody = await before.Content.ReadFromJsonAsync<MeResponse>();
        Assert.Null(beforeBody?.DisplayName);
        Assert.Equal(1, beforeBody?.StoreId);
        Assert.Equal(StaffRoles.Admin, beforeBody?.Role);

        // patch aplica trim e passa a aparecer em /auth/me
        var patched = await _client.PatchAsJsonAsync("/api/v1/auth/profile",
            new UpdateProfileRequest("  Gerente da Loja  "));
        patched.EnsureSuccessStatusCode();
        var patchedBody = await patched.Content.ReadFromJsonAsync<StoreUserDto>();
        Assert.Equal("Gerente da Loja", patchedBody?.DisplayName);

        var after = await _client!.GetAsync("/api/v1/auth/me");
        after.EnsureSuccessStatusCode();
        var afterBody = await after.Content.ReadFromJsonAsync<MeResponse>();
        Assert.Equal("Gerente da Loja", afterBody?.DisplayName);

        // valor nulo/espaço limpa o nome de exibição
        var cleared = await _client.PatchAsJsonAsync("/api/v1/auth/profile", new UpdateProfileRequest("   "));
        cleared.EnsureSuccessStatusCode();
        var clearedBody = await cleared.Content.ReadFromJsonAsync<StoreUserDto>();
        Assert.Null(clearedBody?.DisplayName);
    }

    [Fact]
    public async Task Config_user_cannot_change_password_or_profile()
    {
        UseToken(await LoginAsync(DevUser, DevPass));

        var pwd = await _client!.PostAsJsonAsync("/api/v1/auth/change-password",
            new ChangePasswordRequest(DevPass, "outraSenha1"));
        Assert.Equal(HttpStatusCode.BadRequest, pwd.StatusCode);
        var pwdBody = await pwd.Content.ReadFromJsonAsync<Dictionary<string, string>>();
        Assert.Contains("gerenciado pela configura", pwdBody?["error"] ?? "");

        var profile = await _client.PatchAsJsonAsync("/api/v1/auth/profile",
            new UpdateProfileRequest("Nome Qualquer"));
        Assert.Equal(HttpStatusCode.BadRequest, profile.StatusCode);
        var profileBody = await profile.Content.ReadFromJsonAsync<Dictionary<string, string>>();
        Assert.Contains("gerenciado pela configura", profileBody?["error"] ?? "");
    }

    [Fact]
    public async Task Unauthenticated_requests_are_rejected()
    {
        var pwd = await _client!.PostAsJsonAsync("/api/v1/auth/change-password",
            new ChangePasswordRequest("qualquer1", "qualquer2"));
        Assert.Equal(HttpStatusCode.Unauthorized, pwd.StatusCode);

        var profile = await _client.PatchAsJsonAsync("/api/v1/auth/profile", new UpdateProfileRequest("X"));
        Assert.Equal(HttpStatusCode.Unauthorized, profile.StatusCode);
    }

    private static void WriteSeed(string tempDir)
    {
        var dataDir = Path.Combine(tempDir, "data");
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(Path.Combine(dataDir, "products.json"), """{ "categories": [] }""");
        File.WriteAllText(Path.Combine(dataDir, "ingredients.json"), "[]");
        File.WriteAllText(Path.Combine(dataDir, "store-config.json"), StoreConfigJson);
        var hash = BCrypt.Net.BCrypt.HashPassword(StorePass);
        File.WriteAllText(Path.Combine(dataDir, "admin-users.json"), $$"""
        [
            {
                "id": 1,
                "storeId": 1,
                "username": "{{StoreUser}}",
                "passwordHash": "{{hash}}",
                "role": "Admin",
                "displayName": null
            }
        ]
        """);
    }

    private static void Configure(IWebHostBuilder builder, string tempDir)
    {
        builder.UseSetting("Persistence", "Json");
        builder.UseSetting("Data:Root", Path.Combine(tempDir, "data"));
        builder.UseSetting("Data:AdminUsersPath", Path.Combine(tempDir, "data", "admin-users.json"));
        builder.UseSetting("Data:UploadsRoot", Path.Combine(tempDir, "uploads"));
        builder.UseSetting("Dev:Username", DevUser);
        builder.UseSetting("Dev:Password", DevPass);
        builder.UseSetting("Jwt:Key", TestKey);
        builder.UseSetting("Jwt:ExpiresMinutes", "60");
    }

    private sealed record MeResponse(string Username, string Role, int? StoreId, string? DisplayName);

    private const string StoreConfigJson = """
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
