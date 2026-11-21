using System.Collections.Concurrent;
using System.Net.Http.Json;
using System.Threading.Channels;

namespace Gateway;

public sealed class TrafficHitForwarder : BackgroundService
{
    private readonly Channel<string> _channel = Channel.CreateBounded<string>(new BoundedChannelOptions(4_000)
    {
        FullMode = BoundedChannelFullMode.DropOldest,
        SingleReader = true,
        SingleWriter = false
    });

    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<TrafficHitForwarder> _logger;

    public TrafficHitForwarder(IHttpClientFactory httpClientFactory, ILogger<TrafficHitForwarder> logger)
    {
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public void Enqueue(string path)
    {
        if (ShouldIgnore(path)) return;
        _channel.Writer.TryWrite(NormalizeRoute(path));
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var pending = new ConcurrentDictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                pending.Clear();
                var first = await _channel.Reader.ReadAsync(stoppingToken);
                pending.AddOrUpdate(first, 1, static (_, n) => n + 1);

                var deadline = DateTime.UtcNow.AddMilliseconds(800);
                while (DateTime.UtcNow < deadline && pending.Count < 40)
                {
                    if (!_channel.Reader.TryRead(out var route))
                    {
                        await Task.Delay(50, stoppingToken);
                        continue;
                    }
                    pending.AddOrUpdate(route, 1, static (_, n) => n + 1);
                }

                var client = _httpClientFactory.CreateClient("catalog-analytics");
                foreach (var (route, count) in pending)
                {
                    try
                    {
                        using var res = await client.PostAsJsonAsync(
                            "/api/v1/analytics/hit",
                            new { source = "api", route, count },
                            stoppingToken);
                        if (!res.IsSuccessStatusCode && (int)res.StatusCode != 202)
                        {
                            _logger.LogDebug("Analytics hit HTTP {Status} para {Route}", (int)res.StatusCode, route);
                        }
                    }
                    catch (Exception ex) when (ex is not OperationCanceledException)
                    {
                        _logger.LogDebug(ex, "Falha ao encaminhar hit de tráfego ({Route})", route);
                    }
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Loop de analytics reiniciando");
                try { await Task.Delay(1000, stoppingToken); } catch { /* ignore */ }
            }
        }
    }

    public static bool ShouldIgnore(string? path)
    {
        var p = (path ?? "").ToLowerInvariant();
        if (string.IsNullOrEmpty(p)) return true;
        if (p.StartsWith("/api/v1/health")) return true;
        if (p.StartsWith("/api/v1/analytics")) return true;
        if (p.StartsWith("/api/v1/admin/platform-traffic")) return true;
        return false;
    }

    public static string NormalizeRoute(string? path)
    {
        var p = (path ?? "").ToLowerInvariant();
        if (p.StartsWith("/api/v1/catalog")) return "catalog";
        if (p.StartsWith("/api/v1/store")) return "store";
        if (p.StartsWith("/api/v1/orders")) return "orders";
        if (p.StartsWith("/api/v1/auth")) return "auth";
        if (p.StartsWith("/api/v1/delivery")) return "delivery";
        if (p.StartsWith("/api/v1/geo")) return "geo";
        if (p.StartsWith("/api/v1/ops")) return "ops";
        if (p.StartsWith("/api/v1/admin")) return "admin";
        return "other";
    }
}
