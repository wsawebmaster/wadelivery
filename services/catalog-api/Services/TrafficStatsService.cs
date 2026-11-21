using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using Catalog.Api.Models;

namespace Catalog.Api.Services;

public sealed class TrafficStatsService : IHostedService, IDisposable
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private static readonly TimeZoneInfo SaoPaulo = ResolveSaoPaulo();

    private readonly ConcurrentDictionary<string, long> _buckets = new(StringComparer.Ordinal);
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<TrafficStatsService> _logger;
    private readonly string _path;
    private readonly int _retentionDays;
    private Timer? _flushTimer;
    private int _dirty;

    public TrafficStatsService(IConfiguration config, IWebHostEnvironment env, ILogger<TrafficStatsService> logger)
    {
        _logger = logger;
        _retentionDays = Math.Clamp(config.GetValue("Traffic:RetentionDays", 45), 7, 180);
        _path = ResolvePath(config, env);
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        LoadFromDisk();
        _flushTimer = new Timer(_ => FlushSafe(), null, TimeSpan.FromSeconds(8), TimeSpan.FromSeconds(15));
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _flushTimer?.Change(Timeout.Infinite, 0);
        FlushSafe();
        return Task.CompletedTask;
    }

    public void Dispose()
    {
        _flushTimer?.Dispose();
        _gate.Dispose();
    }

    public void Record(string source, string? route = null, int count = 1)
    {
        if (count <= 0) return;
        var src = NormalizeSource(source);
        var rte = NormalizeRoute(route);
        var now = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, SaoPaulo);
        var key = $"{now:yyyy-MM-dd}|{now.Hour}|{src}|{rte}";
        _buckets.AddOrUpdate(key, count, (_, cur) => cur + count);
        Interlocked.Exchange(ref _dirty, 1);
    }

    public TrafficSummaryDto GetSummary(int days)
    {
        days = Math.Clamp(days, 1, _retentionDays);
        var now = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, SaoPaulo);
        var today = DateOnly.FromDateTime(now);
        var from = today.AddDays(-(days - 1));
        var windowStart = new DateTime(now.Year, now.Month, now.Day, now.Hour, 0, 0).AddHours(-23);

        var pageToday = 0L;
        var apiToday = 0L;
        var pagePeriod = 0L;
        var apiPeriod = 0L;
        var daily = new Dictionary<string, (long Page, long Api)>(StringComparer.Ordinal);
        var routes = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        var hourMap = new Dictionary<string, (long Page, long Api)>(StringComparer.Ordinal);

        foreach (var (key, count) in _buckets)
        {
            if (!TryParseKey(key, out var date, out var hour, out var source, out var route))
                continue;
            if (date < from || date > today) continue;

            var isPage = source == "pageview";
            var isApi = source == "api";
            if (!isPage && !isApi) continue;

            if (isPage) pagePeriod += count;
            if (isApi) apiPeriod += count;

            if (date == today)
            {
                if (isPage) pageToday += count;
                if (isApi) apiToday += count;
            }

            var dateKey = date.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            daily.TryGetValue(dateKey, out var dayAcc);
            daily[dateKey] = (
                dayAcc.Page + (isPage ? count : 0),
                dayAcc.Api + (isApi ? count : 0));

            if (isApi && route is not ("other" or "health" or "analytics"))
                routes[route] = routes.GetValueOrDefault(route) + count;

            var stamp = date.ToDateTime(new TimeOnly(hour, 0));
            if (stamp >= windowStart && stamp <= now)
            {
                var slot = $"{date:yyyy-MM-dd}|{hour}";
                hourMap.TryGetValue(slot, out var acc);
                hourMap[slot] = (
                    acc.Page + (isPage ? count : 0),
                    acc.Api + (isApi ? count : 0));
            }
        }

        var hourDtos = new List<TrafficHourBucketDto>(24);
        long peakHourTotal = 0;
        var peakHour = now.Hour;
        for (var i = 23; i >= 0; i--)
        {
            var ts = new DateTime(now.Year, now.Month, now.Day, now.Hour, 0, 0).AddHours(-i);
            var slot = $"{ts:yyyy-MM-dd}|{ts.Hour}";
            hourMap.TryGetValue(slot, out var acc);
            var total = acc.Page + acc.Api;
            if (total >= peakHourTotal)
            {
                peakHourTotal = total;
                peakHour = ts.Hour;
            }
            hourDtos.Add(new TrafficHourBucketDto(
                $"{ts.Hour:00}h",
                ts.Hour,
                ts.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                acc.Page,
                acc.Api));
        }

        var dailyDtos = new List<TrafficDayBucketDto>();
        for (var d = 0; d < days; d++)
        {
            var day = from.AddDays(d);
            var key = day.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            daily.TryGetValue(key, out var acc);
            dailyDtos.Add(new TrafficDayBucketDto(key, acc.Page, acc.Api));
        }

        var topRoutes = routes
            .OrderByDescending(x => x.Value)
            .Take(8)
            .Select(x => new TrafficRouteCountDto(x.Key, x.Value))
            .ToList();

        return new TrafficSummaryDto(
            Days: days,
            TimeZone: "America/Sao_Paulo",
            PageviewsToday: pageToday,
            PageviewsPeriod: pagePeriod,
            ApiHitsToday: apiToday,
            ApiHitsPeriod: apiPeriod,
            PeakHourLabel: peakHourTotal > 0 ? $"{peakHour:00}h (últimas 24h)" : null,
            PeakHourCount: peakHourTotal,
            Last24Hours: hourDtos,
            Daily: dailyDtos,
            TopRoutes: topRoutes,
            Railway: new RailwayUsageHintDto(
                DashboardUrl: "https://railway.app/dashboard",
                ApiHitsPeriod: apiPeriod,
                Note: "Volume de requests na API é um proxy de consumo. O custo real (CPU/RAM/rede) aparece em Railway → Usage/Billing.",
                EstimatedNote: apiPeriod > 0
                    ? $"≈ {apiPeriod:N0} requests de API nos últimos {days} dia(s)."
                    : "Sem hits de API no período ainda."));
    }

    /// <summary>
    /// Contagem de pageviews (acessos ao cardápio) na janela de N dias e no total retido.
    /// Total considera todos os buckets pageview presentes (dentro da janela de retenção).
    /// </summary>
    public (long Last30d, long Total) GetPageviewCounts(int days)
    {
        days = Math.Clamp(days, 1, _retentionDays);
        var now = TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, SaoPaulo);
        var today = DateOnly.FromDateTime(now);
        var from = today.AddDays(-(days - 1));

        long period = 0;
        long total = 0;
        foreach (var (key, count) in _buckets)
        {
            if (!TryParseKey(key, out var date, out _, out var source, out _)) continue;
            if (source != "pageview") continue;
            total += count;
            if (date >= from && date <= today) period += count;
        }
        return (period, total);
    }

    public static string NormalizeSource(string? source)
    {
        var s = (source ?? "").Trim().ToLowerInvariant();
        return s is "pageview" or "page" or "site" ? "pageview" : "api";
    }

    public static string NormalizeRoute(string? pathOrRoute)
    {
        var raw = (pathOrRoute ?? "").Trim();
        if (string.IsNullOrEmpty(raw)) return "other";

        var p = raw.ToLowerInvariant();
        if (!p.StartsWith('/'))
        {
            return p switch
            {
                "page" or "home" or "index" => "home",
                _ when p.Length <= 32 => p,
                _ => "other"
            };
        }

        if (p.StartsWith("/api/v1/catalog")) return "catalog";
        if (p.StartsWith("/api/v1/store")) return "store";
        if (p.StartsWith("/api/v1/orders")) return "orders";
        if (p.StartsWith("/api/v1/auth")) return "auth";
        if (p.StartsWith("/api/v1/delivery")) return "delivery";
        if (p.StartsWith("/api/v1/geo")) return "geo";
        if (p.StartsWith("/api/v1/ops")) return "ops";
        if (p.StartsWith("/api/v1/admin")) return "admin";
        if (p.StartsWith("/api/v1/analytics")) return "analytics";
        if (p.StartsWith("/api/v1/health")) return "health";
        if (p is "/" or "/index.html") return "home";
        return "other";
    }

    public static bool ShouldIgnoreApiPath(string? path)
    {
        var p = (path ?? "").ToLowerInvariant();
        if (string.IsNullOrEmpty(p)) return true;
        if (p.StartsWith("/api/v1/health")) return true;
        if (p.StartsWith("/api/v1/analytics")) return true;
        if (p.StartsWith("/api/v1/admin/platform-traffic")) return true;
        return false;
    }

    private static bool TryParseKey(string key, out DateOnly date, out int hour, out string source, out string route)
    {
        date = default;
        hour = 0;
        source = "";
        route = "";
        var parts = key.Split('|');
        if (parts.Length != 4) return false;
        if (!DateOnly.TryParseExact(parts[0], "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out date))
            return false;
        if (!int.TryParse(parts[1], out hour) || hour is < 0 or > 23) return false;
        source = parts[2];
        route = parts[3];
        return true;
    }

    private void LoadFromDisk()
    {
        try
        {
            if (!File.Exists(_path)) return;
            var json = File.ReadAllText(_path);
            var state = JsonSerializer.Deserialize<TrafficFileState>(json, JsonOptions);
            if (state?.Buckets is null) return;
            foreach (var (k, v) in state.Buckets)
            {
                if (v > 0) _buckets[k] = v;
            }
            PruneLocked();
            _logger.LogInformation("Traffic stats carregados ({Count} buckets) de {Path}", _buckets.Count, _path);
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Falha ao carregar traffic-stats.json");
        }
    }

    private void FlushSafe()
    {
        if (Interlocked.Exchange(ref _dirty, 0) == 0 && File.Exists(_path)) return;
        _ = FlushAsync();
    }

    private async Task FlushAsync()
    {
        if (!await _gate.WaitAsync(0)) return;
        try
        {
            PruneLocked();
            var dir = Path.GetDirectoryName(_path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            var state = new TrafficFileState
            {
                Buckets = _buckets.ToDictionary(x => x.Key, x => x.Value)
            };
            var tmp = _path + ".tmp";
            await File.WriteAllTextAsync(tmp, JsonSerializer.Serialize(state, JsonOptions));
            File.Move(tmp, _path, overwrite: true);
        }
        catch (Exception ex)
        {
            Interlocked.Exchange(ref _dirty, 1);
            _logger.LogWarning(ex, "Falha ao gravar traffic-stats.json");
        }
        finally
        {
            _gate.Release();
        }
    }

    private void PruneLocked()
    {
        var cutoff = DateOnly.FromDateTime(TimeZoneInfo.ConvertTimeFromUtc(DateTime.UtcNow, SaoPaulo))
            .AddDays(-_retentionDays);
        foreach (var key in _buckets.Keys)
        {
            if (!TryParseKey(key, out var date, out _, out _, out _)) continue;
            if (date < cutoff) _buckets.TryRemove(key, out _);
        }
    }

    private static string ResolvePath(IConfiguration config, IWebHostEnvironment env)
    {
        var configured = config["Data:TrafficStatsPath"];
        if (!string.IsNullOrWhiteSpace(configured))
            return Path.GetFullPath(configured);

        var root = config["Data:Root"];
        if (!string.IsNullOrWhiteSpace(root))
        {
            var abs = Path.IsPathRooted(root)
                ? root
                : Path.GetFullPath(Path.Combine(env.ContentRootPath, root));
            return Path.Combine(abs, "traffic-stats.json");
        }

        var candidates = new[]
        {
            Path.GetFullPath(Path.Combine(env.ContentRootPath, "..", "..", "data")),
            Path.GetFullPath(Path.Combine(env.ContentRootPath, "data")),
            "/app/data"
        };
        foreach (var c in candidates)
        {
            if (Directory.Exists(c)) return Path.Combine(c, "traffic-stats.json");
        }
        return Path.Combine(candidates[0], "traffic-stats.json");
    }

    private static TimeZoneInfo ResolveSaoPaulo()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("America/Sao_Paulo"); }
        catch
        {
            try { return TimeZoneInfo.FindSystemTimeZoneById("E. South America Standard Time"); }
            catch { return TimeZoneInfo.Utc; }
        }
    }

    private sealed class TrafficFileState
    {
        public Dictionary<string, long> Buckets { get; set; } = new();
    }
}
