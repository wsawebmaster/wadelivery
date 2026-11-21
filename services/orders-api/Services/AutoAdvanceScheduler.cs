using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Orders.Api.Data;
using Orders.Api.MultiTenancy;
using Orders.Api.Models;

namespace Orders.Api.Services;

/// <summary>
/// Avança automaticamente pedidos "Confirmado" (Accepted) para "Em preparação" (Preparing)
/// após um número de minutos configurável. O disparo é reativo: agendado no momento da
/// confirmação (sem polling periódico). No boot faz um recovery único dos já vencidos.
/// O banco é a fonte da verdade — a promoção só ocorre se o pedido ainda estiver Accepted
/// e a janela já tiver vencido (idempotente e seguro contra re-execução).
/// </summary>
public class AutoAdvanceScheduler(
    IServiceScopeFactory scopeFactory,
    ILogger<AutoAdvanceScheduler> logger) : BackgroundService
{
    private readonly ConcurrentDictionary<string, byte> _pending = new();

    /// <summary>Agenda a promoção para "Em preparação" minutos após o aceite.</summary>
    public void ScheduleAfterConfirm(string orderId, int minutes)
    {
        if (minutes <= 0) return;
        ScheduleAfter(orderId, TimeSpan.FromMinutes(minutes));
    }

    /// <summary>Agenda para vencer daqui a um intervalo (usado no refresh de pedidos já confirmados).</summary>
    public void ScheduleAfter(string orderId, TimeSpan delay)
    {
        if (string.IsNullOrWhiteSpace(orderId) || delay <= TimeSpan.Zero) return;
        if (!_pending.TryAdd(orderId, 0)) return;

        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(delay);
                await FireAsync(orderId);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Falha no avanço automático do pedido {OrderId}", orderId);
            }
            finally
            {
                _pending.TryRemove(orderId, out _);
            }
        });
    }

    private async Task FireAsync(string orderId)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var pricing = scope.ServiceProvider.GetRequiredService<CatalogPricingClient>();

        var config = await pricing.GetAutoAdvanceConfigAsync(CancellationToken.None);
        if (!config.Enabled) return;

        var order = await db.Orders
            .FirstOrDefaultAsync(o => o.OrderId == orderId && o.StoreId == tenant.StoreId);
        if (order is null) return;

        await TryAdvanceAsync(order, db, config.Minutes);
    }

    private static async Task<bool> TryAdvanceAsync(OrderEntity order, OrdersDbContext db, int minutes)
    {
        if (order.Status != OrderStatus.Accepted) return false;
        if (order.StatusUpdatedAtUtc is null) return false;

        var due = order.StatusUpdatedAtUtc.Value.AddMinutes(minutes);
        if (DateTime.UtcNow < due) return false;

        order.Status = OrderStatus.Preparing;
        order.StatusUpdatedAtUtc = DateTime.UtcNow;
        await db.SaveChangesAsync();

        OrderChangeNotifier.Publish("status");
        OrderChangeNotifier.PublishForOrder(order.OrderId, "status");
        return true;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Recovery único no boot: promove pedidos confirmados cuja janela já venceu
        // (ex.: o serviço reiniciou durante a contagem). Não é polling periódico.
        try
        {
            await RunRecoveryAsync(stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // shutdown
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Recovery de avanço automático falhou");
        }

        // Agendamento é reativo por pedido — sem loop. Aguarda indefinidamente.
        try
        {
            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // shutdown
        }
    }

    private async Task RunRecoveryAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();
        var pricing = scope.ServiceProvider.GetRequiredService<CatalogPricingClient>();

        var config = await pricing.GetAutoAdvanceConfigAsync(ct);
        if (!config.Enabled) return;

        var cutoff = DateTime.UtcNow.AddMinutes(-config.Minutes);
        var ids = await db.Orders
            .Where(o => o.StoreId == tenant.StoreId
                && o.Status == OrderStatus.Accepted
                && o.StatusUpdatedAtUtc != null
                && o.StatusUpdatedAtUtc <= cutoff)
            .Select(o => o.OrderId)
            .ToListAsync(ct);

        foreach (var id in ids)
        {
            ct.ThrowIfCancellationRequested();
            using var s = scopeFactory.CreateScope();
            var innerDb = s.ServiceProvider.GetRequiredService<OrdersDbContext>();
            var innerTenant = s.ServiceProvider.GetRequiredService<TenantContext>();
            var order = await innerDb.Orders
                .FirstOrDefaultAsync(o => o.OrderId == id && o.StoreId == innerTenant.StoreId, ct);
            if (order is null) continue;
            await TryAdvanceAsync(order, innerDb, config.Minutes);
        }
    }

    /// <summary>
    /// Aplica o avanço automático a todos os pedidos já "Confirmado" (Accepted) da loja.
    /// Promove imediatamente os já vencidos e agenda os demais para vencer ao completar
    /// os minutos desde o aceite. Usado quando a config é ativada/altera o tempo.
    /// </summary>
    public async Task<AutoAdvanceRefreshResult> RefreshAndScheduleAsync(CancellationToken ct)
    {
        var config = await GetConfigSafeAsync(ct);
        if (!config.Enabled)
            return new AutoAdvanceRefreshResult(false, 0, 0);

        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        var tenant = scope.ServiceProvider.GetRequiredService<TenantContext>();

        var now = DateTime.UtcNow;
        var ids = await db.Orders
            .Where(o => o.StoreId == tenant.StoreId
                && o.Status == OrderStatus.Accepted
                && o.StatusUpdatedAtUtc != null)
            .Select(o => o.OrderId)
            .ToListAsync(ct);

        var promoted = 0;
        var scheduled = 0;

        foreach (var id in ids)
        {
            ct.ThrowIfCancellationRequested();
            using var s = scopeFactory.CreateScope();
            var innerDb = s.ServiceProvider.GetRequiredService<OrdersDbContext>();
            var innerTenant = s.ServiceProvider.GetRequiredService<TenantContext>();
            var order = await innerDb.Orders
                .FirstOrDefaultAsync(o => o.OrderId == id && o.StoreId == innerTenant.StoreId, ct);
            if (order is null || order.Status != OrderStatus.Accepted || order.StatusUpdatedAtUtc is null)
                continue;

            var due = order.StatusUpdatedAtUtc.Value.AddMinutes(config.Minutes);
            var remaining = due - now;

            if (remaining <= TimeSpan.Zero)
            {
                if (await TryAdvanceAsync(order, innerDb, config.Minutes))
                    promoted++;
            }
            else
            {
                ScheduleAfter(order.OrderId, remaining);
                scheduled++;
            }
        }

        return new AutoAdvanceRefreshResult(true, promoted, scheduled);
    }

    private async Task<(bool Enabled, int Minutes)> GetConfigSafeAsync(CancellationToken ct)
    {
        try
        {
            using var scope = scopeFactory.CreateScope();
            var pricing = scope.ServiceProvider.GetRequiredService<CatalogPricingClient>();
            return await pricing.GetAutoAdvanceConfigAsync(ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ao consultar config de avanço automático (fail-closed)");
            return (false, 0);
        }
    }
}

/// <summary>Resultado da aplicação do avanço automático aos pedidos já confirmados.</summary>
public sealed record AutoAdvanceRefreshResult(bool Enabled, int Promoted, int Scheduled);
