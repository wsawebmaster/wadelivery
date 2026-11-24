using Catalog.Api.Repositories;

namespace Catalog.Api.Services;

/// <summary>
/// Reavalia a cobrança das lojas periodicamente (fim do teste grátis, vencimento, bloqueio
/// após a tolerância) e expira lojas de teste abandonadas (StoreCleanupService). Intervalo em Billing:IntervalMinutes (padrão 60, mínimo 5).
/// </summary>
public sealed class BillingWorker(
    IServiceScopeFactory scopes,
    IConfiguration config,
    ILogger<BillingWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken); }
        catch (OperationCanceledException) { return; }

        var interval = TimeSpan.FromMinutes(Math.Max(5, config.GetValue("Billing:IntervalMinutes", 60)));
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var scope = scopes.CreateScope();
                var repo = scope.ServiceProvider.GetRequiredService<IPlatformStoreRepository>();
                var changed = await repo.EvaluateBillingAsync(DateTime.UtcNow, BillingOptions.FromConfig(config), stoppingToken);
                if (changed > 0) logger.LogInformation("Cobrança: {Count} loja(s) atualizada(s).", changed);

                // Lojas de teste abandonadas (dono nunca entrou): desativa e, depois, apaga os arquivos.
                var cleanup = await scope.ServiceProvider.GetRequiredService<StoreCleanupService>().RunAsync(DateTime.UtcNow, stoppingToken);
                if (cleanup.Abandoned > 0 || cleanup.Purged > 0)
                    logger.LogInformation("Limpeza: {Abandoned} loja(s) desativada(s) por abandono, {Purged} com arquivos apagados.", cleanup.Abandoned, cleanup.Purged);
            }
            catch (Exception ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogWarning(ex, "Falha ao avaliar a cobrança das lojas.");
            }

            try { await Task.Delay(interval, stoppingToken); }
            catch (OperationCanceledException) { return; }
        }
    }
}
