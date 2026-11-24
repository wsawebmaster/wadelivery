using Catalog.Api.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.FileProviders;
using Microsoft.Extensions.Logging.Abstractions;

namespace Catalog.Api.Tests;

public class StorePageviewTests
{
    private sealed class Env : IWebHostEnvironment
    {
        public string WebRootPath { get; set; } = Path.GetTempPath();
        public IFileProvider WebRootFileProvider { get; set; } = new NullFileProvider();
        public string ApplicationName { get; set; } = "tests";
        public IFileProvider ContentRootFileProvider { get; set; } = new NullFileProvider();
        public string ContentRootPath { get; set; } = Path.Combine(Path.GetTempPath(), "wa-traffic-tests-" + Guid.NewGuid().ToString("N"));
        public string EnvironmentName { get; set; } = "Development";
    }

    private static TrafficStatsService Create() =>
        new(new ConfigurationBuilder().Build(), new Env(), NullLogger<TrafficStatsService>.Instance);

    [Fact]
    public void Pageviews_are_counted_per_store_without_changing_platform_total()
    {
        var traffic = Create();
        traffic.Record("pageview", "/loja-a");
        traffic.Record("store", TrafficStatsService.StoreRoute(5));
        traffic.Record("pageview", "/loja-a");
        traffic.Record("store", TrafficStatsService.StoreRoute(5));
        traffic.Record("pageview", "/loja-b");
        traffic.Record("store", TrafficStatsService.StoreRoute(7));

        Assert.Equal(2, traffic.GetStorePageviews(5, 30).Last30d);
        Assert.Equal(1, traffic.GetStorePageviews(7, 30).Last30d);
        Assert.Equal(0, traffic.GetStorePageviews(9, 30).Last30d);
        // O total da plataforma continua contando só os pageviews (sem dobrar pelos registros por loja).
        Assert.Equal(3, traffic.GetPageviewCounts(30).Last30d);
        Assert.Equal(3, traffic.GetSummary(7).PageviewsPeriod);
    }
}
