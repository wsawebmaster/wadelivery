using Catalog.Api.Models;
using Catalog.Api.Repositories;
using Microsoft.Extensions.Caching.Memory;
using Npgsql;

namespace Catalog.Api.Services;

/// <summary>
/// Resolve um slug público (ex.: "fabin", "gota-acai") para os dados básicos da loja.
/// Usado pelos endpoints públicos /api/v1/tenant/{slug} e /api/lojas/slug/{slug} (e /tenant/resolve via header
/// x-tenant-slug) para alimentar o cardápio multi-tenant do WaDelivery.
///
/// Em Persistence=PostgreSQL a consulta roda com row_security desligado (a loja ainda é
/// desconhecida — o slug <em>é</em> a chave de entrada) e busca também o status/segmento
/// no platform_stores. Em modo Json (single-tenant dev/light) apenas o slug padrão
/// (Tenant:Slug, default "fabin") resolve para a loja em execução.
/// </summary>
public class TenantResolverService
{
    private readonly string? _conn;
    private readonly string _defaultSlug;
    private readonly ICatalogRepository _repo;
    private readonly IMemoryCache _cache;
    private readonly ILogger<TenantResolverService> _logger;

    public bool IsPostgres => !string.IsNullOrWhiteSpace(_conn);

    public TenantResolverService(
        string? conn,
        IConfiguration config,
        ICatalogRepository repo,
        IMemoryCache cache,
        ILogger<TenantResolverService> logger)
    {
        _conn = conn;
        _defaultSlug = CatalogInputValidation.NormalizeTenantSlug(config["Tenant:Slug"])
            ?? "fabin";
        _repo = repo;
        _cache = cache;
        _logger = logger;
    }

    /// <summary>
    /// Resolve o slug para a loja com cache em memória (5 min para acertos, 30s para erros).
    /// Retorna null quando o slug é inválido ou não existe.
    /// O slug é normalizado (minúsculas, sem espaços) antes da consulta.
    /// </summary>
    public async Task<TenantResolveDto?> ResolveAsync(string? slug, CancellationToken ct = default)
    {
        var normalized = CatalogInputValidation.NormalizeTenantSlug(slug);
        if (string.IsNullOrWhiteSpace(normalized))
            return null;

        var cacheKey = $"tenant:slug:{normalized}";
        if (_cache.TryGetValue(cacheKey, out TenantResolveDto? cached))
            return cached;

        var result = IsPostgres
            ? await ResolveFromPostgresAsync(normalized, ct)
            : await ResolveFromJsonAsync(normalized, ct);

        var expiration = result is not null
            ? TimeSpan.FromMinutes(5)
            : TimeSpan.FromSeconds(30);

        _cache.Set(cacheKey, result, expiration);
        return result;
    }

    private async Task<TenantResolveDto?> ResolveFromPostgresAsync(string slug, CancellationToken ct)
    {
        try
        {
            await using var conn = new NpgsqlConnection(_conn);
            await conn.OpenAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            await using (var setup = new NpgsqlCommand("SET LOCAL row_security = off", conn, tx))
            {
                await setup.ExecuteNonQueryAsync(ct);
            }

            await using var cmd = new NpgsqlCommand(
                """
                SELECT s."Id", s."StoreName", s."Slug", s."LogoUrl", s."IconUrl", s."CurrencyLocale",
                       s."AcceptingOrders",
                       COALESCE(NULLIF(p."Status", ''), 'active'), NULLIF(p."Segment", ''),
                       s."CorPrimaria", s."CorSecundaria", s."CorFundo", s."CorTexto",
                       s."TipoCard", s."LayoutCardapio", s."EstiloBotao", s."BannerUrl", s."CoverUrl"
                FROM stores s
                LEFT JOIN platform_stores p ON p."StoreId" = s."Id"
                WHERE lower(s."Slug") = lower(@slug)
                LIMIT 1
                """, conn, tx);
            cmd.Parameters.AddWithValue("slug", slug);

            await using var r = await cmd.ExecuteReaderAsync(ct);
            if (!await r.ReadAsync(ct))
                return null;

            var status = r.GetString(7);
            return new TenantResolveDto(
                StoreId: r.GetInt32(0),
                Slug: r.IsDBNull(2) ? slug : r.GetString(2),
                Name: r.GetString(1),
                Status: status,
                Active: !string.Equals(status, "inactive", StringComparison.OrdinalIgnoreCase),
                AcceptingOrders: r.GetBoolean(6),
                LogoUrl: r.IsDBNull(3) ? null : r.GetString(3),
                IconUrl: r.IsDBNull(4) ? null : r.GetString(4),
                Segment: r.IsDBNull(8) ? null : r.GetString(8),
                CurrencyLocale: r.IsDBNull(5) ? "pt-BR" : r.GetString(5),
                CorPrimaria: r.IsDBNull(9) ? null : r.GetString(9),
                CorSecundaria: r.IsDBNull(10) ? null : r.GetString(10),
                CorFundo: r.IsDBNull(11) ? null : r.GetString(11),
                CorTexto: r.IsDBNull(12) ? null : r.GetString(12),
                TipoCard: r.IsDBNull(13) ? null : r.GetString(13),
                LayoutCardapio: r.IsDBNull(14) ? null : r.GetString(14),
                EstiloBotao: r.IsDBNull(15) ? null : r.GetString(15),
                BannerUrl: r.IsDBNull(16) ? null : r.GetString(16),
                CoverUrl: r.IsDBNull(17) ? null : r.GetString(17));
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Falha ao resolver o tenant pelo slug {Slug}", slug);
            throw;
        }
    }

    private async Task<TenantResolveDto?> ResolveFromJsonAsync(string slug, CancellationToken ct)
    {
        if (!string.Equals(slug, _defaultSlug, StringComparison.OrdinalIgnoreCase))
            return null;

        StoreDto? store;
        try
        {
            store = await _repo.GetStoreAsync(ct);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Falha ao resolver o tenant pelo slug {Slug} no modo JSON", slug);
            throw;
        }

        return new TenantResolveDto(
            StoreId: 1,
            Slug: _defaultSlug,
            Name: store.StoreName,
            Status: "active",
            Active: true,
            AcceptingOrders: store.AcceptingOrders,
            LogoUrl: store.LogoUrl,
            IconUrl: store.IconUrl,
            Segment: null,
            CurrencyLocale: store.CurrencyLocale,
            CorPrimaria: store.CorPrimaria,
            CorSecundaria: store.CorSecundaria,
            CorFundo: store.CorFundo,
            CorTexto: store.CorTexto,
            TipoCard: store.TipoCard,
            LayoutCardapio: store.LayoutCardapio,
            EstiloBotao: store.EstiloBotao,
            BannerUrl: store.BannerUrl,
            CoverUrl: store.CoverUrl);
    }
}