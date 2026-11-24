using Catalog.Api.Data;
using Catalog.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;

namespace Catalog.Api.Tests;

/// <summary>
/// Travas que impedem o WaDelivery de agir sozinho sobre a produção compartilhada com a Fabin:
/// rotinas automáticas desligadas por padrão e loja protegida (StoreId 1).
/// </summary>
public class ProductionSafetyTests
{
    private static readonly DateTime Now = new(2026, 11, 24, 12, 0, 0, DateTimeKind.Utc);

    private static IConfiguration Config(params (string Key, string? Value)[] values) =>
        new ConfigurationBuilder().AddInMemoryCollection(values.Select(v => new KeyValuePair<string, string?>(v.Key, v.Value))).Build();

    private static PlatformStoreEntity Overdue(int? storeId) => new()
    {
        Id = Guid.NewGuid(),
        Name = "Loja",
        StoreId = storeId,
        MonthlyFee = 150m,
        NextDueAt = Now.Date.AddDays(-10),
        PaymentStatus = "pending",
        PaymentsJson = "[]",
        Active = true,
        Status = "active",
    };

    [Fact]
    public void Defaults_from_config_are_safe()
    {
        var options = BillingOptions.FromConfig(Config());
        Assert.False(options.AutoBlockEnabled);
        Assert.Contains(1, options.Protected);
    }

    [Fact]
    public void Auto_block_disabled_marks_overdue_but_keeps_store_online()
    {
        var store = Overdue(9);
        BillingPolicy.Apply(store, Now, BillingOptions.FromConfig(Config()));
        Assert.Equal("overdue", store.PaymentStatus);
        Assert.True(store.Active);
        Assert.False(store.BillingBlocked);
    }

    [Fact]
    public void Protected_store_is_never_blocked_even_with_auto_block_enabled()
    {
        var options = BillingOptions.FromConfig(Config(("Billing:AutoBlockEnabled", "true")));
        var fabin = Overdue(1);
        BillingPolicy.Apply(fabin, Now, options);
        Assert.True(fabin.Active);
        Assert.False(fabin.BillingBlocked);

        var other = Overdue(9);
        BillingPolicy.Apply(other, Now, options);
        Assert.False(other.Active);
        Assert.True(other.BillingBlocked);
    }

    [Fact]
    public void Protected_store_list_can_be_configured()
    {
        var options = BillingOptions.FromConfig(Config(
            ("Billing:AutoBlockEnabled", "true"),
            ("Platform:ProtectedStoreIds:0", "1"),
            ("Platform:ProtectedStoreIds:1", "9")));
        var store = Overdue(9);
        BillingPolicy.Apply(store, Now, options);
        Assert.True(store.Active);
    }

    private sealed class Env : IWebHostEnvironment
    {
        public string WebRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ApplicationName { get; set; } = "tests";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = Path.GetTempPath();
        public string EnvironmentName { get; set; } = "Production";
    }

    [Fact]
    public async Task Cleanup_is_disabled_by_default_and_touches_nothing()
    {
        // Desligada, retorna antes de abrir qualquer escopo/banco (por isso scopes pode ser nulo).
        var cleanup = new StoreCleanupService(null!, Config(), new Env(), new MemoryCache(new MemoryCacheOptions()),
            NullLogger<StoreCleanupService>.Instance);
        var result = await cleanup.RunAsync(Now);
        Assert.Equal(0, result.Abandoned);
        Assert.Equal(0, result.Purged);
    }
}
