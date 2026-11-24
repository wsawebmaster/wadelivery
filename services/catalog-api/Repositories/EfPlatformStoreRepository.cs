using System.Text.Json;
using Catalog.Api.Data;
using Catalog.Api.Models;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Catalog.Api.Repositories;

public class EfPlatformStoreRepository(
    CatalogDbContext db,
    ICatalogRepository catalog,
    IMemoryCache cache) : IPlatformStoreRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true
    };

    private static readonly TimeSpan CacheTtl = TimeSpan.FromMinutes(5);

    private void InvalidateCache() => cache.Remove(CatalogCacheKeys.PlatformStores);

    public async Task<List<PlatformStoreDto>> ListAsync(CancellationToken ct = default)
    {
        return await cache.GetOrCreateAsync(CatalogCacheKeys.PlatformStores, async entry =>
        {
            entry.AbsoluteExpirationRelativeToNow = CacheTtl;
            var rows = await db.PlatformStores.AsNoTracking()
                .OrderBy(x => x.Name)
                .ToListAsync(ct);
            var config = await catalog.GetStoreAsync(ct);
            return rows.Select(r => PlatformStoreSync.ApplyStoreConfig(Map(r), config)).ToList();
        }) ?? [];
    }

    public async Task<PlatformStoreDto?> GetAsync(Guid id, CancellationToken ct = default)
    {
        var all = await ListAsync(ct);
        return all.FirstOrDefault(x => x.Id == id);
    }

    public async Task<PlatformStoreDto> CreateAsync(UpsertPlatformStoreRequest request, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        var entity = new PlatformStoreEntity { Id = Guid.NewGuid(), CreatedAt = now };
        Apply(entity, request);
        if (entity.StoreId is null)
            entity.StoreId = await CreateTenantAsync(entity.Name, entity.City, entity.State, ct);
        entity.UpdatedAt = now;
        db.PlatformStores.Add(entity);
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return Map(entity);
    }

    public async Task<PlatformStoreDto?> UpdateAsync(Guid id, UpsertPlatformStoreRequest request, CancellationToken ct = default)
    {
        var entity = await db.PlatformStores.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (entity is null) return null;
        var storeId = entity.StoreId;
        Apply(entity, request);
        entity.StoreId = storeId; // vínculo de tenant é imutável no update
        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return Map(entity);
    }

    public async Task<PlatformStoreDto> DuplicateAsync(Guid id, CancellationToken ct = default)
    {
        var source = await db.PlatformStores.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id, ct)
            ?? throw new KeyNotFoundException("Loja não encontrada.");

        var now = DateTime.UtcNow;
        var copy = new PlatformStoreEntity
        {
            Id = Guid.NewGuid(),
            Name = $"{source.Name} (cópia)",
            FrontUrl = source.FrontUrl,
            FrontNotes = source.FrontNotes,
            BackUrl = source.BackUrl,
            BackNotes = source.BackNotes,
            DatabaseInfo = source.DatabaseInfo,
            DatabaseUrl = source.DatabaseUrl,
            AdminUrl = source.AdminUrl,
            LocalFrontUrl = source.LocalFrontUrl,
            LocalBackUrl = source.LocalBackUrl,
            LocalAdminUrl = source.LocalAdminUrl,
            LocalDatabaseUrl = source.LocalDatabaseUrl,
            MonthlyFee = source.MonthlyFee,
            Courtesy = false,
            CourtesyUntil = null,
            PaymentStatus = "pending",
            LastPaymentAt = null,
            NextDueAt = null,
            PaymentNotes = null,
            PaymentsJson = "[]",
            Active = true,
            Cnpj = source.Cnpj,
            RazaoSocial = source.RazaoSocial,
            ContactName = source.ContactName,
            Phone = source.Phone,
            Email = source.Email,
            Address = source.Address,
            AddressNumber = source.AddressNumber,
            Cep = source.Cep,
            City = source.City,
            State = source.State,
            LogoUrl = source.LogoUrl,
            Status = "setup",
            Plan = source.Plan,
            Segment = source.Segment,
            Domain = source.Domain,
            ApiKey = null,
            WebhookUrl = null,
            BackUsername = null,
            BackPassword = null,
            GalleryJson = source.GalleryJson,
            LastAccessAt = null,
            StatsJson = null,
            CreatedAt = now,
            UpdatedAt = now
        };

        copy.StoreId = await CreateTenantAsync(copy.Name, copy.City, copy.State, ct);

        db.PlatformStores.Add(copy);
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return Map(copy);
    }

    public async Task<bool> DeleteAsync(Guid id, CancellationToken ct = default)
    {
        var entity = await db.PlatformStores.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (entity is null) return false;
        entity.Status = "inactive";
        entity.Active = false;
        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return true;
    }

    public async Task<PlatformStoreDto?> RegisterPaymentAsync(Guid id, RegisterPlatformPaymentRequest request, CancellationToken ct = default)
    {
        var entity = await db.PlatformStores.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (entity is null) return null;

        var paidAt = request.PaidAt ?? DateTime.UtcNow;
        var amount = request.Amount ?? entity.MonthlyFee;
        var payments = DeserializePayments(entity.PaymentsJson);
        payments.Add(new PlatformPaymentDto(paidAt, amount, request.Note));
        // Lançamentos retroativos ficam na ordem certa; o último pagamento é o mais recente.
        payments = payments.OrderByDescending(p => p.PaidAt).ToList();
        entity.PaymentsJson = JsonSerializer.Serialize(payments, JsonOptions);
        entity.LastPaymentAt = payments[0].PaidAt;
        entity.PaymentStatus = "paid";
        entity.Courtesy = false;
        entity.NextDueAt = request.NextDueAt ?? (entity.NextDueAt is { } due && due > paidAt.AddDays(-15)
            ? due.AddMonths(1)              // paga o vencimento atual: próximo mês a partir dele
            : paidAt.AddMonths(1));
        // Bloqueio por inadimplência é desfeito no pagamento (bloqueio manual não).
        if (entity.BillingBlocked) Services.BillingPolicy.Unblock(entity);
        entity.BillingBlockSuspendedUntil = null;
        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return Map(entity);
    }

    public async Task<PlatformStoreDto?> SetLogoAsync(Guid id, string? logoUrl, CancellationToken ct = default)
    {
        var entity = await db.PlatformStores.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (entity is null) return null;
        entity.LogoUrl = NullIfEmpty(logoUrl);
        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return Map(entity);
    }

    public async Task<PlatformStoreDto?> AddGalleryImageAsync(Guid id, GalleryImageDto image, CancellationToken ct = default)
    {
        var entity = await db.PlatformStores.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (entity is null) return null;
        var gallery = DeserializeGallery(entity.GalleryJson);
        gallery.Insert(0, image);
        entity.GalleryJson = JsonSerializer.Serialize(gallery, JsonOptions);
        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return Map(entity);
    }

    public async Task<PlatformStoreDto?> RemoveGalleryImageAsync(Guid id, string imageId, CancellationToken ct = default)
    {
        var entity = await db.PlatformStores.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (entity is null) return null;
        var gallery = DeserializeGallery(entity.GalleryJson).Where(x => x.Id != imageId).ToList();
        entity.GalleryJson = JsonSerializer.Serialize(gallery, JsonOptions);
        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return Map(entity);
    }

    public async Task TouchLastAccessAsync(int? storeId, DateTime when, CancellationToken ct = default)
    {
        if (storeId is null) return;
        await db.PlatformStores
            .Where(x => x.StoreId == storeId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(x => x.LastAccessAt, when)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
        InvalidateCache();
    }

    public async Task SaveStatsAsync(int? storeId, StoreStatsDto stats, CancellationToken ct = default)
    {
        if (storeId is null) return;
        var json = JsonSerializer.Serialize(stats, JsonOptions);
        await db.PlatformStores
            .Where(x => x.StoreId == storeId)
            .ExecuteUpdateAsync(s => s
                .SetProperty(x => x.StatsJson, json)
                .SetProperty(x => x.UpdatedAt, DateTime.UtcNow), ct);
        InvalidateCache();
    }

    /// <summary>
    /// Cria a linha de tenant em stores com RLS temporariamente desligado na transação
    /// (SET LOCAL row_security = off — válido para tabelas do próprio owner mesmo com FORCE RLS).
    /// </summary>
    private async Task<int> CreateTenantAsync(string storeName, string? city, string? state, CancellationToken ct)
    {
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        await db.Database.ExecuteSqlRawAsync("SET LOCAL row_security = off", ct);

        var slug = await AssignUniqueSlugAsync(storeName, ct);
        var id = await db.Database.SqlQuery<int>(
            $"""
            INSERT INTO stores ("StoreName", "City", "State", "Slug")
            VALUES ({storeName}, {city}, {state}, {slug})
            RETURNING "Id"
            """).SingleAsync(ct);
        await tx.CommitAsync(ct);
        return id;
    }

    /// <summary>
    /// Gera um slug único (ex.: "gota-acai") a partir do nome da loja, acrescentando
    /// sufixo numérico (gota-acai-2, gota-acai-3…) se houver colisão. Roda dentro da
    /// transação com row_security desligado (nota: a loja ainda não existe).
    /// </summary>
    private async Task<string> AssignUniqueSlugAsync(string storeName, CancellationToken ct)
    {
        var baseSlug = CatalogInputValidation.SlugifyStoreName(storeName);
        var existing = new HashSet<string>(
            await db.Database.SqlQueryRaw<string>(
                """SELECT "Slug" FROM stores WHERE "Slug" IS NOT NULL""").ToListAsync(ct),
            StringComparer.OrdinalIgnoreCase);
        if (!existing.Contains(baseSlug))
            return baseSlug;

        for (var i = 2; i <= 999; i++)
        {
            var candidate = $"{baseSlug}-{i}";
            if (!existing.Contains(candidate))
                return candidate;
        }
        return $"{baseSlug}-{Guid.NewGuid():N[..4]}";
    }

    private static PlatformStoreEntity Apply(PlatformStoreEntity entity, UpsertPlatformStoreRequest request)
    {
        entity.Name = request.Name.Trim();
        entity.FrontUrl = NullIfEmpty(request.FrontUrl);
        entity.FrontNotes = NullIfEmpty(request.FrontNotes);
        entity.BackUrl = NullIfEmpty(request.BackUrl);
        entity.BackNotes = NullIfEmpty(request.BackNotes);
        entity.DatabaseInfo = NullIfEmpty(request.DatabaseInfo);
        entity.DatabaseUrl = NullIfEmpty(request.DatabaseUrl);
        entity.AdminUrl = NullIfEmpty(request.AdminUrl);
        entity.LocalFrontUrl = NullIfEmpty(request.LocalFrontUrl);
        entity.LocalBackUrl = NullIfEmpty(request.LocalBackUrl);
        entity.LocalAdminUrl = NullIfEmpty(request.LocalAdminUrl);
        entity.LocalDatabaseUrl = NullIfEmpty(request.LocalDatabaseUrl);
        entity.MonthlyFee = request.MonthlyFee;
        entity.Courtesy = request.Courtesy;
        entity.CourtesyUntil = request.CourtesyUntil;
        entity.PaymentStatus = NormalizeStatus(request.PaymentStatus, request.Courtesy);
        entity.LastPaymentAt = request.LastPaymentAt;
        entity.NextDueAt = request.NextDueAt;
        entity.PaymentNotes = NullIfEmpty(request.PaymentNotes);
        var storeStatus = CatalogInputValidation.NormalizeStoreStatus(request.Status, request.Active);
        entity.Status = storeStatus;
        entity.Active = storeStatus != "inactive";
        entity.StoreId = request.StoreId;
        entity.Cnpj = NormalizeCnpj(request.Cnpj);
        entity.RazaoSocial = NullIfEmpty(request.RazaoSocial);
        entity.ContactName = NullIfEmpty(request.ContactName);
        entity.Phone = NullIfEmpty(request.Phone);
        entity.Email = NullIfEmpty(request.Email);
        entity.Address = NullIfEmpty(request.Address);
        entity.AddressNumber = NullIfEmpty(request.AddressNumber);
        entity.Cep = NormalizeCep(request.Cep);
        entity.City = NullIfEmpty(request.City);
        entity.State = string.IsNullOrWhiteSpace(request.State) ? null : request.State.Trim().ToUpperInvariant();
        entity.LogoUrl = NullIfEmpty(request.LogoUrl);
        entity.Plan = string.IsNullOrWhiteSpace(request.Plan) ? null : request.Plan.Trim().ToLowerInvariant();
        entity.Segment = NullIfEmpty(request.Segment);
        entity.Domain = NullIfEmpty(request.Domain);
        entity.ApiKey = NullIfEmpty(request.ApiKey);
        entity.WebhookUrl = NullIfEmpty(request.WebhookUrl);
        entity.BackUsername = NullIfEmpty(request.BackUsername);
        if (!string.IsNullOrWhiteSpace(request.BackPassword))
            entity.BackPassword = request.BackPassword.Trim();
        if (request.Courtesy)
            entity.PaymentStatus = "courtesy";
        return entity;
    }

    private static PlatformStoreDto Map(PlatformStoreEntity entity) => new(
        entity.Id,
        entity.Name,
        entity.FrontUrl,
        entity.FrontNotes,
        entity.BackUrl,
        entity.BackNotes,
        entity.DatabaseInfo,
        entity.DatabaseUrl,
        entity.AdminUrl,
        entity.LocalFrontUrl,
        entity.LocalBackUrl,
        entity.LocalAdminUrl,
        entity.LocalDatabaseUrl,
        entity.MonthlyFee,
        entity.Courtesy,
        entity.CourtesyUntil,
        entity.PaymentStatus,
        entity.LastPaymentAt,
        entity.NextDueAt,
        entity.PaymentNotes,
        DeserializePayments(entity.PaymentsJson),
        entity.Active,
        entity.CreatedAt,
        entity.UpdatedAt,
        entity.StoreId,
        entity.Cnpj,
        entity.RazaoSocial,
        entity.ContactName,
        entity.Phone,
        entity.Email,
        entity.Address,
        entity.AddressNumber,
        entity.Cep,
        entity.City,
        entity.State,
        entity.LogoUrl,
        entity.Status,
        entity.Plan,
        entity.Segment,
        entity.Domain,
        entity.ApiKey,
        entity.WebhookUrl,
        DeserializeGallery(entity.GalleryJson),
        entity.LastAccessAt,
        entity.BackUsername,
        entity.BackPassword,
        DeserializeStats(entity.StatsJson),
        entity.BillingBlocked,
        entity.BillingBlockSuspendedUntil);

    public async Task<int> EvaluateBillingAsync(DateTime nowUtc, Services.BillingOptions options, CancellationToken ct = default)
    {
        var stores = await db.PlatformStores.ToListAsync(ct);
        var changed = 0;
        foreach (var store in stores)
        {
            if (!Services.BillingPolicy.Apply(store, nowUtc, options)) continue;
            store.UpdatedAt = DateTime.UtcNow;
            changed++;
        }
        if (changed > 0)
        {
            await db.SaveChangesAsync(ct);
            InvalidateCache();
        }
        return changed;
    }

    public async Task<PlatformStoreDto?> UpdateBillingAsync(Guid id, UpdatePlatformBillingRequest request, CancellationToken ct = default)
    {
        var entity = await db.PlatformStores.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (entity is null) return null;
        if (request.MonthlyFee is not null) entity.MonthlyFee = Math.Max(0, request.MonthlyFee.Value);
        if (request.Courtesy is not null)
        {
            entity.Courtesy = request.Courtesy.Value;
            entity.PaymentStatus = entity.Courtesy ? "courtesy" : (entity.PaymentStatus == "courtesy" ? "pending" : entity.PaymentStatus);
        }
        if (request.ClearCourtesyUntil == true) entity.CourtesyUntil = null;
        else if (request.CourtesyUntil is not null) entity.CourtesyUntil = request.CourtesyUntil;
        if (request.NextDueAt is not null) entity.NextDueAt = request.NextDueAt;
        if (request.PaymentNotes is not null) entity.PaymentNotes = NullIfEmpty(request.PaymentNotes);
        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return Map(entity);
    }

    public async Task<PlatformStoreDto?> SetBlockedAsync(Guid id, bool blocked, Services.BillingOptions options, CancellationToken ct = default)
    {
        var entity = await db.PlatformStores.FirstOrDefaultAsync(x => x.Id == id, ct);
        if (entity is null) return null;
        if (blocked)
        {
            // Bloqueio manual: não é desfeito automaticamente pelo pagamento.
            entity.Active = false;
            entity.Status = "inactive";
            entity.BillingBlocked = false;
        }
        else
        {
            Services.BillingPolicy.Unblock(entity);
            // Desbloqueio manual de loja ainda em atraso: dá alguns dias antes de bloquear de novo.
            if (Services.BillingPolicy.DaysOverdue(entity.NextDueAt, DateTime.UtcNow) > 0 && !entity.Courtesy && entity.MonthlyFee > 0)
                entity.BillingBlockSuspendedUntil = DateTime.UtcNow.AddDays(options.ManualUnblockGraceDays);
        }
        entity.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        return Map(entity);
    }

    private static StoreStatsDto? DeserializeStats(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<StoreStatsDto>(json, JsonOptions);
        }
        catch
        {
            return null;
        }
    }

    private static List<PlatformPaymentDto> DeserializePayments(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<PlatformPaymentDto>>(json, JsonOptions) ?? [];
        }
        catch
        {
            return [];
        }
    }

    private static List<GalleryImageDto> DeserializeGallery(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<GalleryImageDto>>(json, JsonOptions) ?? [];
        }
        catch
        {
            return [];
        }
    }

    private static string? NullIfEmpty(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string? NormalizeCnpj(string? value) =>
        CatalogInputValidation.NormalizeCnpj(value);

    private static string? NormalizeCep(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : CatalogInputValidation.DigitsOnly(value);

    private static string NormalizeStatus(string? status, bool courtesy)
    {
        if (courtesy) return "courtesy";
        var s = (status ?? "pending").Trim().ToLowerInvariant();
        return s is "paid" or "pending" or "overdue" or "courtesy" ? s : "pending";
    }
}
