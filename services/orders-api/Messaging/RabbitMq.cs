using System.Text;
using System.Text.Json;
using Orders.Api.Models;
using RabbitMQ.Client;
using RabbitMQ.Client.Events;

namespace Orders.Api.Messaging;

public interface IOrderEventPublisher
{
    Task PublishOrderCreatedAsync(OrderCreatedEvent evt, CancellationToken ct = default);
}

public class RabbitMqOrderEventPublisher : IOrderEventPublisher, IDisposable
{
    public const string ExchangeName = "delivery.orders";
    public const string RoutingKey = "order.created";
    public const string QueueName = "delivery.orders.created";

    private readonly IConnection? _connection;
    private readonly IChannel? _channel;
    private readonly ILogger<RabbitMqOrderEventPublisher> _logger;
    private readonly bool _enabled;

    public RabbitMqOrderEventPublisher(IConfiguration config, ILogger<RabbitMqOrderEventPublisher> logger)
    {
        _logger = logger;
        _enabled = config.GetValue("RabbitMq:Enabled", true);
        if (!_enabled)
        {
            logger.LogWarning("RabbitMQ desabilitado — eventos serão apenas logados.");
            return;
        }

        try
        {
            var factory = new ConnectionFactory
            {
                HostName = config["RabbitMq:Host"] ?? "localhost",
                Port = int.TryParse(config["RabbitMq:Port"], out var p) ? p : 5672,
                UserName = config["RabbitMq:Username"] ?? "guest",
                Password = config["RabbitMq:Password"] ?? "guest"
            };
            _connection = factory.CreateConnectionAsync().GetAwaiter().GetResult();
            _channel = _connection.CreateChannelAsync().GetAwaiter().GetResult();
            _channel.ExchangeDeclareAsync(ExchangeName, ExchangeType.Topic, durable: true).GetAwaiter().GetResult();
            _channel.QueueDeclareAsync(QueueName, durable: true, exclusive: false, autoDelete: false)
                .GetAwaiter().GetResult();
            _channel.QueueBindAsync(QueueName, ExchangeName, RoutingKey).GetAwaiter().GetResult();
            logger.LogInformation("RabbitMQ conectado em {Host}", factory.HostName);
        }
        catch (Exception ex)
        {
            _enabled = false;
            logger.LogWarning(ex, "Falha ao conectar RabbitMQ — modo fallback (log only).");
        }
    }

    public async Task PublishOrderCreatedAsync(OrderCreatedEvent evt, CancellationToken ct = default)
    {
        var payload = JsonSerializer.Serialize(evt);
        if (!_enabled || _channel is null)
        {
            _logger.LogInformation(
                "OrderCreated (fallback): {OrderId} total={Total} phone={Phone}",
                evt.OrderId, evt.Total, MaskPhone(evt.CustomerPhone));
            return;
        }

        var body = Encoding.UTF8.GetBytes(payload);
        await _channel.BasicPublishAsync(
            ExchangeName,
            RoutingKey,
            mandatory: false,
            body: body,
            cancellationToken: ct);
        _logger.LogInformation("OrderCreated publicado: {OrderId}", evt.OrderId);
    }

    private static string MaskPhone(string? phone)
    {
        var d = string.IsNullOrEmpty(phone) ? "" : new string(phone.Where(char.IsDigit).ToArray());
        if (d.Length < 4) return "***";
        return new string('*', d.Length - 4) + d[^4..];
    }

    public void Dispose()
    {
        _channel?.Dispose();
        _connection?.Dispose();
    }
}

/// <summary>
/// Consumer de exemplo: audita pedidos criados (demonstra mensageria no portfólio).
/// </summary>
public class OrderCreatedConsumer(
    IConfiguration config,
    ILogger<OrderCreatedConsumer> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!config.GetValue("RabbitMq:Enabled", true))
            return;

        try
        {
            var factory = new ConnectionFactory
            {
                HostName = config["RabbitMq:Host"] ?? "localhost",
                Port = int.TryParse(config["RabbitMq:Port"], out var p) ? p : 5672,
                UserName = config["RabbitMq:Username"] ?? "guest",
                Password = config["RabbitMq:Password"] ?? "guest"
            };

            await using var connection = await factory.CreateConnectionAsync(stoppingToken);
            await using var channel = await connection.CreateChannelAsync(cancellationToken: stoppingToken);
            await channel.ExchangeDeclareAsync(RabbitMqOrderEventPublisher.ExchangeName, ExchangeType.Topic, durable: true, cancellationToken: stoppingToken);
            await channel.QueueDeclareAsync(RabbitMqOrderEventPublisher.QueueName, durable: true, exclusive: false, autoDelete: false, cancellationToken: stoppingToken);
            await channel.QueueBindAsync(RabbitMqOrderEventPublisher.QueueName, RabbitMqOrderEventPublisher.ExchangeName, RabbitMqOrderEventPublisher.RoutingKey, cancellationToken: stoppingToken);

            var consumer = new AsyncEventingBasicConsumer(channel);
            consumer.ReceivedAsync += async (_, ea) =>
            {
                var json = Encoding.UTF8.GetString(ea.Body.ToArray());
                try
                {
                    var evt = JsonSerializer.Deserialize<OrderCreatedEvent>(json);
                    logger.LogInformation(
                        "Pedido recebido da fila (auditoria): {OrderId} total={Total} phone={Phone}",
                        evt?.OrderId, evt?.Total, MaskPhone(evt?.CustomerPhone));
                }
                catch
                {
                    logger.LogInformation("Pedido recebido da fila (auditoria): payload inválido");
                }
                await channel.BasicAckAsync(ea.DeliveryTag, false, stoppingToken);
            };

            await channel.BasicConsumeAsync(RabbitMqOrderEventPublisher.QueueName, autoAck: false, consumer, stoppingToken);
            logger.LogInformation("Consumer OrderCreated ativo.");

            await Task.Delay(Timeout.Infinite, stoppingToken);
        }
        catch (OperationCanceledException)
        {
            // shutdown
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Consumer RabbitMQ não iniciado.");
        }
    }

    private static string MaskPhone(string? phone)
    {
        var d = string.IsNullOrEmpty(phone) ? "" : new string(phone.Where(char.IsDigit).ToArray());
        if (d.Length < 4) return "***";
        return new string('*', d.Length - 4) + d[^4..];
    }
}
