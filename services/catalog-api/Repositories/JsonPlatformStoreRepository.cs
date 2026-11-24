using System.Text.Json;
using Catalog.Api.Models;
using Microsoft.Extensions.Caching.Memory;

namespace Catalog.Api.Repositories;

public class JsonPlatformStoreRepository : IPlatformStoreRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<JsonPlatformStoreRepository> _logger;
    private readonly ICatalogRepository _catalog;
    private readonly IMemoryCache _cache;

    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    public JsonPlatformStoreRepository(
        IConfiguration config,
        IWebHostEnvironment env,
        ILogger<JsonPlatformStoreRepository> logger,
        ICatalogRepository catalog,
        IMemoryCache cache)
    {
        _logger = logger;
        _catalog = catalog;
        _cache = cache;
        var configured = config["Data:PlatformStoresPath"];
        _path = !string.IsNullOrWhiteSpace(configured)
            ? configured
            : Path.GetFullPath(Path.Combine(env.ContentRootPath, "..", "..", "data", "platform-stores.json"));
    }

    private void InvalidateCache() => _cache.Remove(CatalogCacheKeys.PlatformStores);

    public async Task<List<PlatformStoreDto>> ListAsync(CancellationToken ct = default)
    {
        return await _cache.GetOrCreateAsync(CatalogCacheKeys.PlatformStores, async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = CacheTtl;
            await _gate.WaitAsync(ct);
            try
            {
                var list = (await ReadAllAsync(ct)).OrderBy(x => x.Name).ToList();
                var config = await _catalog.GetStoreAsync(ct);
                return list.Select(x => PlatformStoreSync.ApplyStoreConfig(x, config)).ToList();
            }
            finally
            {
                _gate.Release();
            }
        }) ?? [];
    }

    public async Task<PlatformStoreDto?> GetAsync(Guid id, CancellationToken ct = default)
    {
        var all = await ListAsync(ct);
        return all.FirstOrDefault(x => x.Id == id);
    }

    public async Task<PlatformStoreDto> CreateAsync(UpsertPlatformStoreRequest request, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var now = DateTime.UtcNow;
            var dto = FromRequest(Guid.NewGuid(), request, [], now, now);
            list.Add(dto);
            await WriteAllAsync(list, ct);
            InvalidateCache();
            return dto;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<PlatformStoreDto?> UpdateAsync(Guid id, UpsertPlatformStoreRequest request, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(x => x.Id == id);
            if (idx < 0) return null;
            var current = list[idx];
            var updated = FromRequest(id, request, current.Payments, current.CreatedAt, DateTime.UtcNow);
            list[idx] = updated;
            await WriteAllAsync(list, ct);
            InvalidateCache();
            return updated;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<PlatformStoreDto> DuplicateAsync(Guid id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var source = list.FirstOrDefault(x => x.Id == id)
                ?? throw new KeyNotFoundException("Loja não encontrada.");
            var now = DateTime.UtcNow;
            var copy = source with
            {
                Id = Guid.NewGuid(),
                Name = $"{source.Name} (cópia)",
                Status = "setup",
                Active = true,
                Payments = [],
                PaymentStatus = "pending",
                Courtesy = false,
                CourtesyUntil = null,
                LastPaymentAt = null,
                NextDueAt = null,
                PaymentNotes = null,
                LastAccessAt = null,
                BackUsername = null,
                BackPassword = null,
                Stats = null,
                CreatedAt = now,
                UpdatedAt = now
            };
            list.Add(copy);
            await WriteAllAsync(list, ct);
            InvalidateCache();
            return copy;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(x => x.Id == id);
            if (idx < 0) return false;
            list[idx] = list[idx] with { Status = "inactive", Active = false, UpdatedAt = DateTime.UtcNow };
            await WriteAllAsync(list, ct);
            InvalidateCache();
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    /// <summary>Modo JSON (instalação leve, loja única): a cobrança automática não se aplica.</summary>
    public Task<int> EvaluateBillingAsync(DateTime nowUtc, Services.BillingOptions options, CancellationToken ct = default) =>
        Task.FromResult(0);

    public Task<PlatformStoreDto?> UpdateBillingAsync(Guid id, UpdatePlatformBillingRequest request, CancellationToken ct = default) =>
        MutateAsync(id, current => current with
        {
            MonthlyFee = request.MonthlyFee is null ? current.MonthlyFee : Math.Max(0, request.MonthlyFee.Value),
            Courtesy = request.Courtesy ?? current.Courtesy,
            CourtesyUntil = request.ClearCourtesyUntil == true ? null : request.CourtesyUntil ?? current.CourtesyUntil,
            NextDueAt = request.NextDueAt ?? current.NextDueAt,
            PaymentNotes = request.PaymentNotes ?? current.PaymentNotes,
            UpdatedAt = DateTime.UtcNow
        }, ct);

    public Task<PlatformStoreDto?> SetBlockedAsync(Guid id, bool blocked, Services.BillingOptions options, CancellationToken ct = default) =>
        MutateAsync(id, current => current with
        {
            Active = !blocked,
            Status = blocked ? "inactive" : "active",
            BillingBlocked = false,
            UpdatedAt = DateTime.UtcNow
        }, ct);

    private async Task<PlatformStoreDto?> MutateAsync(Guid id, Func<PlatformStoreDto, PlatformStoreDto> change, CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(x => x.Id == id);
            if (idx < 0) return null;
            list[idx] = change(list[idx]);
            await WriteAllAsync(list, ct);
            InvalidateCache();
            return list[idx];
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<PlatformStoreDto?> RegisterPaymentAsync(Guid id, RegisterPlatformPaymentRequest request, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(x => x.Id == id);
            if (idx < 0) return null;
            var current = list[idx];
            var paidAt = request.PaidAt ?? DateTime.UtcNow;
            var amount = request.Amount ?? current.MonthlyFee;
            var payments = current.Payments.Append(new PlatformPaymentDto(paidAt, amount, request.Note))
                .OrderByDescending(p => p.PaidAt).ToList();
            var updated = current with
            {
                Payments = payments,
                LastPaymentAt = payments[0].PaidAt,
                PaymentStatus = "paid",
                Courtesy = false,
                NextDueAt = request.NextDueAt ?? paidAt.AddMonths(1),
                UpdatedAt = DateTime.UtcNow
            };
            list[idx] = updated;
            await WriteAllAsync(list, ct);
            InvalidateCache();
            return updated;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<PlatformStoreDto?> SetLogoAsync(Guid id, string? logoUrl, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(x => x.Id == id);
            if (idx < 0) return null;
            var updated = list[idx] with { LogoUrl = NullIfEmpty(logoUrl), UpdatedAt = DateTime.UtcNow };
            list[idx] = updated;
            await WriteAllAsync(list, ct);
            InvalidateCache();
            return updated;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<PlatformStoreDto?> AddGalleryImageAsync(Guid id, GalleryImageDto image, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(x => x.Id == id);
            if (idx < 0) return null;
            var gallery = (list[idx].Gallery ?? []).ToList();
            gallery.Insert(0, image);
            var updated = list[idx] with { Gallery = gallery, UpdatedAt = DateTime.UtcNow };
            list[idx] = updated;
            await WriteAllAsync(list, ct);
            InvalidateCache();
            return updated;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<PlatformStoreDto?> RemoveGalleryImageAsync(Guid id, string imageId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(x => x.Id == id);
            if (idx < 0) return null;
            var current = list[idx];
            var removed = (current.Gallery ?? []).Where(x => x.Id != imageId).ToList();
            var updated = current with { Gallery = removed, UpdatedAt = DateTime.UtcNow };
            list[idx] = updated;
            await WriteAllAsync(list, ct);
            InvalidateCache();
            return updated;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task TouchLastAccessAsync(int? storeId, DateTime when, CancellationToken ct = default)
    {
        if (storeId is null) return;
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(x => x.StoreId == storeId);
            if (idx < 0) return;
            list[idx] = list[idx] with { LastAccessAt = when, UpdatedAt = DateTime.UtcNow };
            await WriteAllAsync(list, ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveStatsAsync(int? storeId, StoreStatsDto stats, CancellationToken ct = default)
    {
        if (storeId is null) return;
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(x => x.StoreId == storeId);
            if (idx < 0) return;
            list[idx] = list[idx] with { Stats = stats, UpdatedAt = DateTime.UtcNow };
            await WriteAllAsync(list, ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<List<PlatformStoreDto>> ReadAllAsync(CancellationToken ct)
    {
        if (!File.Exists(_path))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            await File.WriteAllTextAsync(_path, "[]", ct);
            return [];
        }

        await using var fs = File.OpenRead(_path);
        var list = await JsonSerializer.DeserializeAsync<List<PlatformStoreDto>>(fs, JsonOptions, ct);
        return list ?? [];
    }

    private async Task WriteAllAsync(List<PlatformStoreDto> list, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        await using var fs = File.Create(_path);
        await JsonSerializer.SerializeAsync(fs, list, JsonOptions, ct);
        _logger.LogInformation("platform-stores.json atualizado ({Count} lojas)", list.Count);
    }

    private static PlatformStoreDto FromRequest(
        Guid id,
        UpsertPlatformStoreRequest request,
        List<PlatformPaymentDto> payments,
        DateTime createdAt,
        DateTime updatedAt)
    {
        var courtesy = request.Courtesy;
        var status = courtesy
            ? "courtesy"
            : NormalizeStatus(request.PaymentStatus);
        var storeStatus = Catalog.Api.CatalogInputValidation.NormalizeStoreStatus(request.Status, request.Active);
        return new PlatformStoreDto(
            id,
            request.Name.Trim(),
            NullIfEmpty(request.FrontUrl),
            NullIfEmpty(request.FrontNotes),
            NullIfEmpty(request.BackUrl),
            NullIfEmpty(request.BackNotes),
            NullIfEmpty(request.DatabaseInfo),
            NullIfEmpty(request.DatabaseUrl),
            NullIfEmpty(request.AdminUrl),
            NullIfEmpty(request.LocalFrontUrl),
            NullIfEmpty(request.LocalBackUrl),
            NullIfEmpty(request.LocalAdminUrl),
            NullIfEmpty(request.LocalDatabaseUrl),
            request.MonthlyFee,
            courtesy,
            request.CourtesyUntil,
            status,
            request.LastPaymentAt,
            request.NextDueAt,
            NullIfEmpty(request.PaymentNotes),
            payments,
            storeStatus != "inactive",
            createdAt,
            updatedAt,
            request.StoreId,
            NormalizeCnpj(request.Cnpj),
            NullIfEmpty(request.RazaoSocial),
            NullIfEmpty(request.ContactName),
            NullIfEmpty(request.Phone),
            NullIfEmpty(request.Email),
            NullIfEmpty(request.Address),
            NullIfEmpty(request.AddressNumber),
            NormalizeCep(request.Cep),
            NullIfEmpty(request.City),
            string.IsNullOrWhiteSpace(request.State) ? null : request.State.Trim().ToUpperInvariant(),
            NullIfEmpty(request.LogoUrl),
            storeStatus,
            string.IsNullOrWhiteSpace(request.Plan) ? null : request.Plan.Trim().ToLowerInvariant(),
            NullIfEmpty(request.Segment),
            NullIfEmpty(request.Domain),
            NullIfEmpty(request.ApiKey),
            NullIfEmpty(request.WebhookUrl),
            [],
            null,
            NullIfEmpty(request.BackUsername),
            NullIfEmpty(request.BackPassword),
            null);
    }

    private static string? NullIfEmpty(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string? NormalizeCnpj(string? value) =>
        Catalog.Api.CatalogInputValidation.NormalizeCnpj(value);

    private static string? NormalizeCep(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : Catalog.Api.CatalogInputValidation.DigitsOnly(value);

    private static string NormalizeStatus(string? status)
    {
        var s = (status ?? "pending").Trim().ToLowerInvariant();
        return s is "paid" or "pending" or "overdue" or "courtesy" ? s : "pending";
    }
}
