using Catalog.Api.Repositories;
using Npgsql;

namespace Catalog.Api.Services;

/// <summary>
/// Barramento de invalidação de cache via PostgreSQL LISTEN/NOTIFY.
/// Escuta o canal 'catalog_changed' (disparado por triggers nas tabelas críticas:
/// products, categories, ingredients, product_ingredients, stores, platform_stores) e
/// invalida as chaves IMemoryCache da loja afetada. Cobre escritas fora do repositório
/// (DbExplorer/SQL cru, sync via ferramentas Dev) e múltiplas instâncias do catalog-api.
///
/// Usa uma conexão dedicada e contínua com Pooling=false: a conexão em LISTEN nunca passa
/// pelo pool do ADO.NET, evitando que seja reciclada/desconectada sem o serviço perceber.
/// </summary>
public sealed class CatalogInvalidationListener : BackgroundService
{
    private const string Channel = "catalog_changed";

    private readonly string _connectionString;
    private readonly CatalogCacheInvalidator _invalidator;
    private readonly ILogger<CatalogInvalidationListener> _logger;

    public CatalogInvalidationListener(
        string? connectionString,
        CatalogCacheInvalidator invalidator,
        ILogger<CatalogInvalidationListener> logger)
    {
        _invalidator = invalidator;
        _logger = logger;

        if (string.IsNullOrWhiteSpace(connectionString))
        {
            _connectionString = "";
            return;
        }

        var builder = new NpgsqlConnectionStringBuilder(connectionString)
        {
            Pooling = false
        };
        _connectionString = builder.ConnectionString;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (string.IsNullOrWhiteSpace(_connectionString))
        {
            _logger.LogWarning(
                "CatalogInvalidationListener: sem connection string, barramento desativado.");
            return;
        }

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await using var conn = new NpgsqlConnection(_connectionString);
                await conn.OpenAsync(stoppingToken);
                conn.Notification += OnNotification;
                await using var listen = new NpgsqlCommand($"LISTEN {Channel}", conn);
                await listen.ExecuteNonQueryAsync(stoppingToken);
                _logger.LogInformation(
                    "CatalogInvalidationListener: escutando o canal '{Channel}' do PostgreSQL.", Channel);

                while (!stoppingToken.IsCancellationRequested)
                {
                    _ = await conn.WaitAsync(
                        (int)TimeSpan.FromSeconds(30).TotalMilliseconds, stoppingToken);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(
                    ex,
                    "CatalogInvalidationListener: conexão com o canal '{Channel}' caiu. Reconectando em 5s…",
                    Channel);
                try
                {
                    await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }

        _logger.LogInformation("CatalogInvalidationListener: encerrado.");
    }

    private void OnNotification(object? sender, NpgsqlNotificationEventArgs e)
    {
        if (!string.Equals(e.Channel, Channel, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(e.Payload))
            return;

        var parts = e.Payload!.Split(':', 2);
        var table = parts[0];
        var storeId = 0;
        if (parts.Length == 2 && int.TryParse(parts[1], out var parsed) && parsed > 0)
            storeId = parsed;

        if (storeId > 0)
            _invalidator.InvalidateStore(storeId);

        // A lista da plataforma embute o store config da loja em execução (PlatformStoreSync).
        if (string.Equals(table, "stores", StringComparison.OrdinalIgnoreCase)
            || string.Equals(table, "platform_stores", StringComparison.OrdinalIgnoreCase))
        {
            _invalidator.InvalidateGlobal();
        }

        _logger.LogDebug(
            "Invalidação de cache via barramento: {Table}:{StoreId}",
            table,
            storeId > 0 ? storeId : "global");
    }
}