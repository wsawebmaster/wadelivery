using System.Text.Json;
using Orders.Api.Data;
using Orders.Api.Models;

namespace Orders.Api;

public static class OrderMapping
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public static OrderResponse ToResponse(OrderEntity entity, bool includeAccessToken = false)
    {
        var items = DeserializeItems(entity.ItemsJson);
        var neighborhood = string.IsNullOrWhiteSpace(entity.Neighborhood)
            ? InferNeighborhood(entity.Address)
            : entity.Neighborhood;
        var fulfillment = string.IsNullOrWhiteSpace(entity.FulfillmentType) ? "delivery" : entity.FulfillmentType;
        var next = OrderStatus.Next(entity.Status, fulfillment);

        return new OrderResponse(
            entity.OrderId,
            entity.CustomerName,
            entity.CustomerPhone,
            entity.Address,
            neighborhood,
            entity.Reference,
            entity.PaymentMethod,
            entity.PaymentTiming,
            OrderPayment.TimingLabel(entity.PaymentTiming),
            entity.PaymentStatus,
            OrderPayment.StatusLabel(entity.PaymentStatus),
            entity.Notes,
            entity.DeliveryFee,
            entity.ItemsTotal,
            entity.ItemsTotal + entity.DeliveryFee,
            entity.Status,
            OrderStatus.Label(entity.Status),
            next,
            next is null ? null : OrderStatus.Label(next),
            AsUtc(entity.CreatedAtUtc),
            entity.StatusUpdatedAtUtc is null ? null : AsUtc(entity.StatusUpdatedAtUtc.Value),
            entity.AcceptedAtUtc is null ? null : AsUtc(entity.AcceptedAtUtc.Value),
            items,
            includeAccessToken ? entity.AccessToken : null,
            entity.CustomerReceivedAtUtc is not null,
            entity.CustomerReceivedAtUtc is null ? null : AsUtc(entity.CustomerReceivedAtUtc.Value),
            entity.CancellationReasonCode,
            entity.CancellationReason,
            entity.CancellationCustomerRequested,
            string.IsNullOrWhiteSpace(entity.FulfillmentType) ? "delivery" : entity.FulfillmentType,
            entity.ItemsUpdatedAtUtc is null ? null : AsUtc(entity.ItemsUpdatedAtUtc.Value),
            entity.ItemsChangeSummary,
            entity.PreviousItemsTotal,
            entity.Cep,
            entity.NeedsChange,
            entity.ChangeFor,
            entity.TableId,
            entity.TableLabel,
            entity.OrderSource,
            entity.CreatedByUsername,
            entity.WaiterName,
            entity.CreatedByRole);
    }

    /// <summary>Compara listas de itens e gera linhas tipo "Removido: 1× Coca".</summary>
    public static string BuildItemsChangeSummary(List<OrderItemDto> before, List<OrderItemDto> after)
    {
        static string Key(OrderItemDto i) =>
            !string.IsNullOrWhiteSpace(i.ProductId)
                ? $"id:{i.ProductId.Trim()}"
                : $"name:{(i.Name ?? "").Trim().ToLowerInvariant()}";

        static (string Name, int Qty) Aggregate(IEnumerable<OrderItemDto> group)
        {
            var list = group.ToList();
            return (list[0].Name ?? "Item", list.Sum(x => x.Quantity));
        }

        var beforeMap = before.GroupBy(Key).ToDictionary(g => g.Key, g => Aggregate(g));
        var afterMap = after.GroupBy(Key).ToDictionary(g => g.Key, g => Aggregate(g));
        var lines = new List<string>();

        foreach (var (key, prev) in beforeMap)
        {
            if (!afterMap.TryGetValue(key, out var next))
            {
                lines.Add($"Removido: {prev.Qty}× {prev.Name}");
                continue;
            }
            if (next.Qty != prev.Qty)
                lines.Add($"{prev.Name}: {prev.Qty}× → {next.Qty}×");
        }

        foreach (var (key, next) in afterMap)
        {
            if (!beforeMap.ContainsKey(key))
                lines.Add($"Adicionado: {next.Qty}× {next.Name}");
        }

        if (lines.Count == 0)
            return "Itens ajustados pela loja.";

        var text = string.Join("\n", lines);
        return text.Length <= 1000 ? text : text[..997] + "...";
    }

    /// <summary>
    /// Postgres/EF pode devolver DateTime com Kind=Unspecified; força UTC para serializar com "Z".
    /// </summary>
    public static DateTime AsUtc(DateTime value) =>
        value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };

    public static List<OrderItemDto> DeserializeItems(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<List<OrderItemDto>>(json, JsonOptions) ?? [];
        }
        catch
        {
            return [];
        }
    }

    /// <summary>
    /// Endereço típico do storefront: "Rua, número, Bairro, Cidade - UF"
    /// </summary>
    public static string? InferNeighborhood(string? address)
    {
        if (string.IsNullOrWhiteSpace(address)) return null;
        var parts = address.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length >= 3) return parts[2];
        if (parts.Length == 2) return parts[1];
        return null;
    }
}
