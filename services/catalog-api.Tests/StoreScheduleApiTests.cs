using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using Catalog.Api.Models;
using Catalog.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de integração (Persistence=Json) do horário por dia: PATCH /api/v1/admin/store
/// com PerDay (incluindo intervalo e prazo por dia) e rejeição de intervalo cruzando meia-noite.
/// </summary>
public class StoreScheduleApiTests : IAsyncLifetime
{
    private const string TestKey = "IntegrationTestKey_0123456789abcdefghijklmnopqrstuv";
    private const string AdminUser = "admin-teste";
    private const string AdminPass = "senha-teste";

    private WebApplicationFactory<Program>? _factory;
    private HttpClient? _client;
    private string _tempDir = "";

    public async Task InitializeAsync()
    {
        _tempDir = Path.Combine(Path.GetTempPath(), "catalog-api-schedule", Guid.NewGuid().ToString("N"));
        WriteSeed(_tempDir);

        _factory = new WebApplicationFactory<Program>().WithWebHostBuilder(b => Configure(b, _tempDir));
        _client = _factory.CreateClient();

        var login = await _client.PostAsJsonAsync("/api/v1/auth/login", new LoginRequest(AdminUser, AdminPass));
        login.EnsureSuccessStatusCode();
        var body = await login.Content.ReadFromJsonAsync<LoginResponse>();
        Assert.NotNull(body?.Token);
        Assert.Equal(StaffRoles.Admin, body!.Role);
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
    public async Task Patch_store_round_trips_perDay_break_and_delivery()
    {
        var patch = new PatchStoreRequest
        {
            Schedule = new ScheduleDto(
                [1, 2, 3, 4, 5, 6], "11:00", "23:55", "Fechado.",
                new[]
                {
                    new ScheduleDayDto(0, false, "11:00", "23:55"),
                    new ScheduleDayDto(1, true, "11:00", "23:55",
                        BreakEnabled: true, BreakStart: "14:00", BreakEnd: "15:00", DeliveryMinutes: 50),
                    new ScheduleDayDto(2, true, "11:00", "23:55"),
                    new ScheduleDayDto(3, true, "11:00", "23:55"),
                    new ScheduleDayDto(4, true, "11:00", "23:55"),
                    new ScheduleDayDto(5, true, "11:00", "23:55", DeliveryMinutes: 70),
                    new ScheduleDayDto(6, true, "11:00", "23:55"),
                })
        };

        var resp = await _client!.PatchAsJsonAsync("/api/v1/admin/store", patch);
        resp.EnsureSuccessStatusCode();

        var store = await resp.Content.ReadFromJsonAsync<StoreDto>();
        Assert.NotNull(store);
        Assert.Equal(7, store!.Schedule.PerDay!.Length);
        Assert.True(store.Schedule.PerDay[1].BreakEnabled);
        Assert.Equal("14:00", store.Schedule.PerDay[1].BreakStart);
        Assert.Equal(50, store.Schedule.PerDay[1].DeliveryMinutes);
        Assert.Equal(70, store.Schedule.PerDay[5].DeliveryMinutes);
        Assert.False(store.Schedule.PerDay[0].Enabled);
        Assert.Equal([1, 2, 3, 4, 5, 6], store.Schedule.Days);
    }

    [Fact]
    public async Task Patch_store_rejects_break_across_midnight()
    {
        var patch = new PatchStoreRequest
        {
            Schedule = new ScheduleDto(
                [1], "18:00", "23:55", "Fechado.",
                new[]
                {
                    new ScheduleDayDto(0, false, "18:00", "23:55"),
                    new ScheduleDayDto(1, true, "18:00", "23:55",
                        BreakEnabled: true, BreakStart: "22:00", BreakEnd: "02:00"),
                    new ScheduleDayDto(2, false, "18:00", "23:55"),
                    new ScheduleDayDto(3, false, "18:00", "23:55"),
                    new ScheduleDayDto(4, false, "18:00", "23:55"),
                    new ScheduleDayDto(5, false, "18:00", "23:55"),
                    new ScheduleDayDto(6, false, "18:00", "23:55"),
                })
        };

        var resp = await _client!.PatchAsJsonAsync("/api/v1/admin/store", patch);
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
        var body = await resp.Content.ReadFromJsonAsync<ErrorBody>();
        Assert.Contains("meia-noite", body?.Error ?? "");
    }

    [Fact]
    public async Task Patch_store_rejects_all_disabled_days()
    {
        var patch = new PatchStoreRequest
        {
            Schedule = new ScheduleDto(
                [], "11:00", "23:55", "Fechado.",
                Enumerable.Range(0, 7).Select(d => new ScheduleDayDto(d, false, "11:00", "23:55")).ToArray())
        };

        var resp = await _client!.PatchAsJsonAsync("/api/v1/admin/store", patch);
        Assert.Equal(HttpStatusCode.BadRequest, resp.StatusCode);
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
