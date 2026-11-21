using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Catalog.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) para a gestão de garçons/equipe da loja (aba Equipe / role Admin):
/// CRUD de staff, validação, PIN por garçom e regras de tenant/permissão.
/// </summary>
public class StaffEndpointsTests : IAsyncLifetime
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";
    private const string AdminUser = "admin-teste";
    private const string AdminPass = "senha-teste";
    private const string AtendUser = "atend-teste";
    private const string AtendPass = "atend-senha";

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public async Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-staff", Guid.NewGuid().ToString("N"));
        WriteSeed(_tempDir);

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => Configure(b, _tempDir));
        _client = _factory.CreateClient();
        await Task.CompletedTask;
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

    private async Task<HttpClient> LoginAsAdmin()
    {
        var client = _factory!.CreateClient();
        var login = await client.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(AdminUser, AdminPass));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(body?.Token);
        Assert.Equal(StaffRoles.Admin, body!.Role);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body.Token);
        return client;
    }

    private async Task<HttpClient> LoginAsAtendimento()
    {
        var client = _factory!.CreateClient();
        var login = await client.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(AtendUser, AtendPass));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.Equal(StaffRoles.Atendimento, body!.Role);
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body.Token);
        return client;
    }

    [Fact]
    public async Task Staff_CRUD_and_pin_lifecycle_works()
    {
        var client = await LoginAsAdmin();

        // criar garçom
        var create = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("garcom01", "garcom123", StaffRoles.Garçom, DisplayName: "Garçom Um", Pin: "1234"));
        create.EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        var created = await create.Content.ReadFromJsonAsync<StoreUserDto>();
        Assert.NotNull(created);
        Assert.Equal("garcom01", created!.Username);
        Assert.Equal(StaffRoles.Garçom, created.Role);
        Assert.True(created.HasPin);

        // aparece na lista (apenas garçons/atendimento, não Dev)
        var list = await client.GetAsync("/api/v1/admin/staff");
        list.EnsureSuccessStatusCode();
        var items = await list.Content.ReadFromJsonAsync<List<StoreUserDto>>();
        Assert.NotNull(items);
        Assert.Contains(items!, u => u.Username == "garcom01");

        // garçom consegue logar com a senha criada
        var loginAtend = await _factory!.CreateClient().PostAsJsonAsync("/api/v1/auth/login",
            new LoginRequest("garcom01", "garcom123"));
        loginAtend.EnsureSuccessStatusCode();

        // definir PIN do garçom
        var setPin = await client.PostAsJsonAsync($"/api/v1/admin/staff/{created.Id}/pin", new PinSetRequest("1234"));
        setPin.EnsureSuccessStatusCode();
        var pinList = await client.GetAsync("/api/v1/admin/staff");
        var pinItems = await pinList.Content.ReadFromJsonAsync<List<StoreUserDto>>();
        Assert.True(pinItems!.First(u => u.Username == "garcom01").HasPin);

        // garçom valida o próprio PIN
        var atendClient = await LoginAsAtendimento(); // reutiliza credencial seed; garcom01 precisa validar via /pin/validate com token do garcom01
        var garcomClient = _factory!.CreateClient();
        var loginGarcom = await garcomClient.PostAsJsonAsync("/api/v1/auth/login",
            new LoginRequest("garcom01", "garcom123"));
        var garcomBody = await loginGarcom.Content.ReadFromJsonAsync<LoginResponse>();
        garcomClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", garcomBody!.Token);
        var validate = await garcomClient.PostAsJsonAsync("/api/v1/admin/pin/validate", new PinValidateRequest("1234"));
        validate.EnsureSuccessStatusCode();
        _ = atendClient; // evita aviso de variável não usada

        // resetar senha do garçom
        var reset = await client.PostAsJsonAsync($"/api/v1/admin/staff/{created.Id}/reset-password",
            new { password = "novaSenha1" });
        reset.EnsureSuccessStatusCode();

        // nova senha funciona no login
        var relogin = await _factory!.CreateClient().PostAsJsonAsync("/api/v1/auth/login",
            new LoginRequest("garcom01", "novaSenha1"));
        relogin.EnsureSuccessStatusCode();

        // limpar PIN
        var clearPin = await client.DeleteAsync($"/api/v1/admin/staff/{created.Id}/pin");
        clearPin.EnsureSuccessStatusCode();
        var afterClear = await client.GetAsync("/api/v1/admin/staff");
        var afterItems = await afterClear.Content.ReadFromJsonAsync<List<StoreUserDto>>();
        Assert.False(afterItems!.First(u => u.Username == "garcom01").HasPin);

        // excluir garçom
        var del = await client.DeleteAsync($"/api/v1/admin/staff/{created.Id}");
        del.EnsureSuccessStatusCode();
        var finalList = await client.GetAsync("/api/v1/admin/staff");
        var finalItems = await finalList.Content.ReadFromJsonAsync<List<StoreUserDto>>();
        Assert.DoesNotContain(finalItems!, u => u.Username == "garcom01");

        // usuário excluído não loga mais
        var badLogin = await _factory!.CreateClient().PostAsJsonAsync("/api/v1/auth/login",
            new LoginRequest("garcom01", "novaSenha1"));
        Assert.Equal(HttpStatusCode.Unauthorized, badLogin.StatusCode);
    }

    [Fact]
    public async Task Staff_create_rejects_duplicate_username()
    {
        var client = await LoginAsAdmin();
        var first = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("dup01", "senha123", StaffRoles.Garçom, DisplayName: "Duplicado", Pin: "1234"));
        first.EnsureSuccessStatusCode();

        var dup = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("dup01", "outra123", StaffRoles.Garçom, DisplayName: "Duplicado", Pin: "1234"));
        Assert.Equal(HttpStatusCode.Conflict, dup.StatusCode);
    }

    [Fact]
    public async Task Staff_create_rejects_invalid_username_and_short_password()
    {
        var client = await LoginAsAdmin();
        var badUser = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("com espaço!!", "senha123", StaffRoles.Atendimento));
        Assert.Equal(HttpStatusCode.BadRequest, badUser.StatusCode);

        var shortPass = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("valido01", "123", StaffRoles.Atendimento));
        Assert.Equal(HttpStatusCode.BadRequest, shortPass.StatusCode);
    }

    [Fact]
    public async Task Staff_pin_rejects_non_numeric_short_pin()
    {
        var client = await LoginAsAdmin();
        var create = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("pinuser", "senha123", StaffRoles.Garçom, DisplayName: "Pin User", Pin: "1234"));
        var created = await create.Content.ReadFromJsonAsync<StoreUserDto>();

        var badPin = await client.PostAsJsonAsync($"/api/v1/admin/staff/{created!.Id}/pin", new PinSetRequest("12a4"));
        Assert.Equal(HttpStatusCode.BadRequest, badPin.StatusCode);

        var err = await client.PostAsJsonAsync($"/api/v1/admin/staff/{created.Id}/pin", new PinSetRequest("12"));
        Assert.Equal(HttpStatusCode.BadRequest, err.StatusCode);
    }

    [Fact]
    public async Task Staff_endpoints_forbidden_for_atendimento_role()
    {
        var atendClient = await LoginAsAtendimento();

        var list = await atendClient.GetAsync("/api/v1/admin/staff");
        Assert.Equal(HttpStatusCode.Forbidden, list.StatusCode);

        var create = await atendClient.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("nao_pode", "senha123", StaffRoles.Atendimento));
        Assert.Equal(HttpStatusCode.Forbidden, create.StatusCode);
    }

    [Fact]
    public async Task Staff_actions_require_authentication()
    {
        var anon = _factory!.CreateClient();
        var list = await anon.GetAsync("/api/v1/admin/staff");
        Assert.Equal(HttpStatusCode.Unauthorized, list.StatusCode);
    }

    [Fact]
    public async Task Garcom_create_with_name_and_pin_works_and_logs_in()
    {
        var client = await LoginAsAdmin();

        var create = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("garcomPc", "garcom123", StaffRoles.Garçom, DisplayName: "Pedro Costa", Pin: "7777"));
        create.EnsureSuccessStatusCode();
        Assert.Equal(HttpStatusCode.Created, create.StatusCode);
        var created = await create.Content.ReadFromJsonAsync<StoreUserDto>();
        Assert.NotNull(created);
        Assert.Equal(StaffRoles.Garçom, created!.Role);
        Assert.Equal("Pedro Costa", created.DisplayName);
        Assert.True(created.HasPin);

        var list = await client.GetAsync("/api/v1/admin/staff");
        var items = await list.Content.ReadFromJsonAsync<List<StoreUserDto>>();
        var item = items!.First(u => u.Username == "garcomPc");
        Assert.Equal("Pedro Costa", item.DisplayName);
        Assert.True(item.HasPin);

        // garçom consegue logar com o papel normalizado "Garçom"
        var garcomClient = _factory!.CreateClient();
        var login = await garcomClient.PostAsJsonAsync("/api/v1/auth/login",
            new LoginRequest("garcomPc", "garcom123"));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.Equal(StaffRoles.Garçom, body!.Role);
    }

    [Fact]
    public async Task Garcom_create_requires_name_and_pin()
    {
        var client = await LoginAsAdmin();

        var semNome = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("gSemNome", "senha123", StaffRoles.Garçom, Pin: "1234"));
        Assert.Equal(HttpStatusCode.BadRequest, semNome.StatusCode);

        var semPin = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("gSemPin", "senha123", StaffRoles.Garçom, DisplayName: "João"));
        Assert.Equal(HttpStatusCode.BadRequest, semPin.StatusCode);

        var pinInvalido = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("gPinBad", "senha123", StaffRoles.Garçom, DisplayName: "João", Pin: "12ab"));
        Assert.Equal(HttpStatusCode.BadRequest, pinInvalido.StatusCode);

        // Garçom válido precisa de Nome + PIN (papel único aceito no cadastro)
        var ok = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("gOk", "senha123", StaffRoles.Garçom, DisplayName: "João", Pin: "4321"));
        ok.EnsureSuccessStatusCode();
    }

    [Fact]
    public async Task Staff_update_edits_data_and_rejects_duplicate_and_bad_garcom()
    {
        var client = await LoginAsAdmin();

        var create = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("garcomA", "garcom123", StaffRoles.Garçom, DisplayName: "Ana Souza", Pin: "1111"));
        create.EnsureSuccessStatusCode();
        var created = await create.Content.ReadFromJsonAsync<StoreUserDto>();

        // edita Usuário, Nome e Papel (e troca o PIN)
        var upd = await client.PutAsJsonAsync($"/api/v1/admin/staff/{created!.Id}",
            new UpdateStoreUserRequest("ana1", StaffRoles.Garçom, DisplayName: "Ana Pereira", Pin: "2222"));
        upd.EnsureSuccessStatusCode();
        var updated = await upd.Content.ReadFromJsonAsync<StoreUserDto>();
        Assert.Equal("ana1", updated!.Username);
        Assert.Equal(StaffRoles.Garçom, updated.Role);
        Assert.Equal("Ana Pereira", updated.DisplayName);
        Assert.True(updated.HasPin);

        // no login com o novo usuário/sem alterar senha
        var login = await _factory!.CreateClient().PostAsJsonAsync("/api/v1/auth/login",
            new LoginRequest("ana1", "garcom123"));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.Equal(StaffRoles.Garçom, body!.Role);

        // novo PIN substitui o antigo
        var validateOld = await _factory!.CreateClient().PostAsJsonAsync("/api/v1/auth/login",
            new LoginRequest("ana1", "garcom123"));
        var anaClient = _factory!.CreateClient();
        var anaBody = await validateOld.Content.ReadFromJsonAsync<LoginResponse>();
        anaClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", anaBody!.Token);
        var pinOld = await anaClient.PostAsJsonAsync("/api/v1/admin/pin/validate", new PinValidateRequest("1111"));
        var pinNew = await anaClient.PostAsJsonAsync("/api/v1/admin/pin/validate", new PinValidateRequest("2222"));
        Assert.Equal(HttpStatusCode.BadRequest, pinOld.StatusCode);
        pinNew.EnsureSuccessStatusCode();

        // usuário duplicado -> Conflict
        var other = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("outro1", "senha123", StaffRoles.Garçom, DisplayName: "Outro Um", Pin: "5555"));
        var otherDto = await other.Content.ReadFromJsonAsync<StoreUserDto>();
        var dup = await client.PutAsJsonAsync($"/api/v1/admin/staff/{created.Id}",
            new UpdateStoreUserRequest("outro1", StaffRoles.Garçom, DisplayName: "Outro Um"));
        Assert.Equal(HttpStatusCode.Conflict, dup.StatusCode);

        // o próprio usuário pode manter o mesmo nome (sem conflito)
        var same = await client.PutAsJsonAsync($"/api/v1/admin/staff/{created.Id}",
            new UpdateStoreUserRequest("ana1", StaffRoles.Garçom, DisplayName: "Ana"));
        same.EnsureSuccessStatusCode();

        // manter Garçom exige Nome (e PIN apenas quando ainda não houver)
        var garcomSemDados = await client.PutAsJsonAsync($"/api/v1/admin/staff/{created.Id}",
            new UpdateStoreUserRequest("ana1", StaffRoles.Garçom));
        Assert.Equal(HttpStatusCode.BadRequest, garcomSemDados.StatusCode);

        var garcomOk = await client.PutAsJsonAsync($"/api/v1/admin/staff/{created.Id}",
            new UpdateStoreUserRequest("ana1", StaffRoles.Garçom, DisplayName: "Ana G", Pin: "3333"));
        garcomOk.EnsureSuccessStatusCode();
        Assert.Equal(StaffRoles.Garçom, (await garcomOk.Content.ReadFromJsonAsync<StoreUserDto>())!.Role);

        _ = otherDto; // evita aviso de não usado
    }

    [Fact]
    public async Task Staff_update_requires_admin_and_existing_user()
    {
        var client = await LoginAsAdmin();
        var create = await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("upduser", "senha123", StaffRoles.Atendimento));
        var created = await create.Content.ReadFromJsonAsync<StoreUserDto>();

        // Atendimento não pode editar staff
        var atendClient = await LoginAsAtendimento();
        var forbidden = await atendClient.PutAsJsonAsync($"/api/v1/admin/staff/{created!.Id}",
            new UpdateStoreUserRequest("x", StaffRoles.Atendimento));
        Assert.Equal(HttpStatusCode.Forbidden, forbidden.StatusCode);

        // usuário inexistente -> NotFound
        var missing = await client.PutAsJsonAsync("/api/v1/admin/staff/99999",
            new UpdateStoreUserRequest("nope", StaffRoles.Atendimento));
        Assert.Equal(HttpStatusCode.NotFound, missing.StatusCode);

        // anônimo -> Unauthorized
        var anon = await _factory!.CreateClient().PutAsJsonAsync($"/api/v1/admin/staff/{created.Id}",
            new UpdateStoreUserRequest("y", StaffRoles.Atendimento));
        Assert.Equal(HttpStatusCode.Unauthorized, anon.StatusCode);
    }

    [Fact]
    public async Task Garcom_cannot_manage_staff()
    {
        var client = await LoginAsAdmin();
        await client.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("gRestrito", "senha123", StaffRoles.Garçom, DisplayName: "Maria", Pin: "9999"));

        var garcomClient = _factory!.CreateClient();
        var login = await garcomClient.PostAsJsonAsync("/api/v1/auth/login",
            new LoginRequest("gRestrito", "senha123"));
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        garcomClient.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", body!.Token);

        // Gestão de staff é exclusiva do Admin (StoreAdmin)
        var list = await garcomClient.GetAsync("/api/v1/admin/staff");
        Assert.Equal(HttpStatusCode.Forbidden, list.StatusCode);

        var create = await garcomClient.PostAsJsonAsync("/api/v1/admin/staff",
            new CreateStoreUserRequest("outro", "senha123", StaffRoles.Garçom, DisplayName: "X", Pin: "1234"));
        Assert.Equal(HttpStatusCode.Forbidden, create.StatusCode);
    }

    private static void WriteSeed(string tempDir)
    {
        var dataDir = Path.Combine(tempDir, "data");
        Directory.CreateDirectory(dataDir);
        File.WriteAllText(Path.Combine(dataDir, "products.json"), """{ "categories": [] }""");
        File.WriteAllText(Path.Combine(dataDir, "ingredients.json"), "[]");
        File.WriteAllText(Path.Combine(dataDir, "store-config.json"), StoreJson);
        File.WriteAllText(Path.Combine(dataDir, "platform-stores.json"), "[]");
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
        builder.UseSetting("Atendimento:Username", AtendUser);
        builder.UseSetting("Atendimento:Password", AtendPass);
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
