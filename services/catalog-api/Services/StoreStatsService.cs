using Catalog.Api.Models;
using Catalog.Api.Repositories;
using Npgsql;

namespace Catalog.Api.Services;

/// <summary>
/// Estatísticas operacionais de uma loja: último acesso (login de usuário vinculado),
/// acessos ao cardápio digital (pageviews) e quantidade de pedidos criados (incl. cancelados).
/// Usado pelo endpoint /admin/platform/store-stats (por tenant) e pelo snapshot remoto do Dev.
/// </summary>
public class StoreStatsService
{
    private readonly string? _conn;
    private readonly IPlatformStoreRepository _platform;
    private readonly TrafficStatsService _traffic;
    private readonly ILogger<StoreStatsService> _logger;

    public bool IsAvailable => !string.IsNullOrWhiteSpace(_conn);

    public StoreStatsService(
        string? conn,
        IPlatformStoreRepository platform,
        TrafficStatsService traffic,
        ILogger<StoreStatsService> logger)
    {
        _conn = conn;
        _platform = platform;
        _traffic = traffic;
        _logger = logger;
    }

    public async Task<StoreStatsDto> ComputeAsync(int storeId, CancellationToken ct = default)
    {
        DateTime? lastAccessAt = null;
        try
        {
            var list = await _platform.ListAsync(ct);
            lastAccessAt = list.FirstOrDefault(x => x.StoreId == storeId)?.LastAccessAt;
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Falha ao ler último acesso da loja {StoreId}", storeId);
        }

        // Acessos ao cardápio desta loja (antes era o total da plataforma em todas as lojas).
        var (menuViews30d, menuViewsTotal) = _traffic.GetStorePageviews(storeId, 30);

        long? orders30d = null;
        long? ordersTotal = null;
        var ordersAvailable = false;
        if (IsAvailable)
        {
            try
            {
                (orders30d, ordersTotal) = await CountOrdersAsync(storeId, ct);
                ordersAvailable = true;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Falha ao contar pedidos da loja {StoreId} (tabela orders ausente?)", storeId);
            }
        }

        return new StoreStatsDto(
            FetchedAt: DateTime.UtcNow,
            Error: null,
            LastAccessAt: lastAccessAt,
            MenuViews30d: menuViews30d,
            MenuViewsTotal: menuViewsTotal,
            Orders30d: orders30d,
            OrdersTotal: ordersTotal,
            OrdersAvailable: ordersAvailable);
    }

    /// <summary>Pedidos de todas as lojas numa consulta: StoreId → (30 dias, total, último pedido).</summary>
    public async Task<Dictionary<int, (long Last30d, long Total, DateTime? LastOrderAt)>> CountOrdersByStoreAsync(CancellationToken ct)
    {
        var result = new Dictionary<int, (long, long, DateTime?)>();
        if (!IsAvailable) return result;
        try
        {
            await using var conn = new NpgsqlConnection(_conn);
            await conn.OpenAsync(ct);
            await using var tx = await conn.BeginTransactionAsync(ct);
            await using (var setup = new NpgsqlCommand("SET LOCAL row_security = off", conn, tx))
                await setup.ExecuteNonQueryAsync(ct);
            await using var cmd = new NpgsqlCommand(
                """SELECT "StoreId", COUNT(*) FILTER (WHERE "CreatedAtUtc" >= @from30), COUNT(*), MAX("CreatedAtUtc") FROM orders GROUP BY "StoreId" """,
                conn, tx);
            cmd.Parameters.AddWithValue("from30", DateTime.UtcNow.AddDays(-30));
            await using var r = await cmd.ExecuteReaderAsync(ct);
            while (await r.ReadAsync(ct))
                result[r.GetInt32(0)] = (r.GetInt64(1), r.GetInt64(2), r.IsDBNull(3) ? null : DateTime.SpecifyKind(r.GetDateTime(3), DateTimeKind.Utc));
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Falha ao contar pedidos por loja (tabela orders ausente?)");
        }
        return result;
    }

    private async Task<(long? Last30d, long? Total)> CountOrdersAsync(int storeId, CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(_conn);
        await conn.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var setup = new NpgsqlCommand("SET LOCAL row_security = off", conn, tx))
        {
            await setup.ExecuteNonQueryAsync(ct);
        }
        await using var cmd = new NpgsqlCommand(
            """SELECT COUNT(*), COUNT(*) FILTER (WHERE "CreatedAtUtc" >= @from30) FROM orders WHERE "StoreId" = @store""",
            conn, tx);
        cmd.Parameters.AddWithValue("store", storeId);
        cmd.Parameters.AddWithValue("from30", DateTime.UtcNow.AddDays(-30));
        await using var r = await cmd.ExecuteReaderAsync(ct);
        if (!await r.ReadAsync(ct))
            return (null, null);
        var total = r.IsDBNull(0) ? (long?)null : r.GetInt64(0);
        var last30d = r.IsDBNull(1) ? (long?)null : r.GetInt64(1);
        return (last30d, total);
    }
}
