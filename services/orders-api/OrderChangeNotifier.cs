using System.Collections.Concurrent;
using System.Threading.Channels;

namespace Orders.Api;

/// <summary>
/// Fan-out leve para SSE. Falhas nos clientes não afetam o fluxo de pedidos.
/// Suporta broadcast (painel admin) e streams por pedido (rastreio do cliente).
/// </summary>
public static class OrderChangeNotifier
{
    private static readonly ConcurrentDictionary<Guid, Channel<string>> Subscribers = new();
    private static readonly ConcurrentDictionary<string, ConcurrentDictionary<Guid, Channel<string>>> OrderSubscribers = new();

    public static void Publish(string reason = "changed")
    {
        var payload = string.IsNullOrWhiteSpace(reason) ? "changed" : reason.Trim();
        foreach (var (_, channel) in Subscribers)
        {
            channel.Writer.TryWrite(payload);
        }
    }

    /// <summary>
    /// Notifica apenas os assinantes de um pedido específico (rastreio do cliente).
    /// </summary>
    public static void PublishForOrder(string orderId, string reason = "changed")
    {
        if (string.IsNullOrWhiteSpace(orderId)) return;
        var payload = string.IsNullOrWhiteSpace(reason) ? "changed" : reason.Trim();
        if (!OrderSubscribers.TryGetValue(orderId, out var channels)) return;
        foreach (var (_, channel) in channels)
        {
            channel.Writer.TryWrite(payload);
        }
    }

    public static async Task StreamAsync(HttpResponse response, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(16)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });
        Subscribers[id] = channel;

        try
        {
            await StreamLoopAsync(response, channel, ct);
        }
        finally
        {
            Subscribers.TryRemove(id, out _);
            channel.Writer.TryComplete();
        }
    }

    /// <summary>
    /// Stream SSE exclusivo de um pedido. Encerra quando o cliente desconecta
    /// ou quando o pedido chega ao status terminal (tratado pelo endpoint).
    /// </summary>
    public static async Task StreamForOrderAsync(HttpResponse response, string orderId, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateBounded<string>(new BoundedChannelOptions(16)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false
        });

        var subscribers = OrderSubscribers.GetOrAdd(orderId, _ => new ConcurrentDictionary<Guid, Channel<string>>());
        subscribers[id] = channel;

        try
        {
            await StreamLoopAsync(response, channel, ct);
        }
        finally
        {
            subscribers.TryRemove(id, out _);
            if (subscribers.IsEmpty)
                OrderSubscribers.TryRemove(orderId, out _);
            channel.Writer.TryComplete();
        }
    }

    private static async Task StreamLoopAsync(HttpResponse response, Channel<string> channel, CancellationToken ct)
    {
        response.Headers.ContentType = "text/event-stream";
        response.Headers.CacheControl = "no-cache";
        response.Headers.Append("X-Accel-Buffering", "no");

        await response.WriteAsync($": connected\n\n", ct);
        await response.Body.FlushAsync(ct);

        // Keepalive periódico (alguns proxies fecham idle)
        using var keepalive = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var pump = Task.Run(async () =>
        {
            while (!keepalive.Token.IsCancellationRequested)
            {
                try
                {
                    await Task.Delay(15000, keepalive.Token);
                    channel.Writer.TryWrite("ping");
                }
                catch (OperationCanceledException)
                {
                    break;
                }
            }
        }, CancellationToken.None);

        await foreach (var msg in channel.Reader.ReadAllAsync(ct))
        {
            await response.WriteAsync($"event: orders\ndata: {msg}\n\n", ct);
            await response.Body.FlushAsync(ct);
        }

        keepalive.Cancel();
        try { await pump; } catch { /* ignore */ }
    }
}
