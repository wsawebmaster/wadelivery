namespace Orders.Api.Models;

public static class OrderStatus
{
    public const string Created = "Created";
    public const string Accepted = "Accepted";
    public const string Preparing = "Preparing";
    public const string OutForDelivery = "OutForDelivery";
    public const string ReadyForPickup = "ReadyForPickup";
    public const string ReadyForTable = "ReadyForTable";
    public const string Delivered = "Delivered";
    public const string Cancelled = "Cancelled";

    /// <summary>Fluxo de entrega (delivery).</summary>
    public static readonly string[] DeliverySequence =
    [
        Created,
        Accepted,
        Preparing,
        OutForDelivery,
        Delivered
    ];

    /// <summary>Fluxo de retirada no local (pickup).</summary>
    public static readonly string[] PickupSequence =
    [
        Created,
        Accepted,
        Preparing,
        ReadyForPickup,
        Delivered
    ];

    /// <summary>Fluxo de consumo no local (dine_in).</summary>
    public static readonly string[] DineInSequence =
    [
        Created,
        Accepted,
        Preparing,
        ReadyForTable,
        Delivered
    ];

    /// <summary>Compat: sequência de entrega (uso legado / dashboard linear).</summary>
    public static readonly string[] Sequence = DeliverySequence;

    /// <summary>Todos os status conhecidos.</summary>
    public static readonly string[] All =
    [
        Created,
        Accepted,
        Preparing,
        OutForDelivery,
        ReadyForPickup,
        ReadyForTable,
        Delivered,
        Cancelled
    ];

    public static bool IsPickup(string? fulfillmentType) =>
        string.Equals((fulfillmentType ?? "").Trim(), "pickup", StringComparison.OrdinalIgnoreCase);

    public static bool IsDineIn(string? fulfillmentType) =>
        string.Equals((fulfillmentType ?? "").Trim(), "dine_in", StringComparison.OrdinalIgnoreCase);

    public static string[] SequenceFor(string? fulfillmentType) => (fulfillmentType ?? "").Trim() switch
    {
        "dine_in" => DineInSequence,
        "pickup" => PickupSequence,
        _ => DeliverySequence
    };

    public static string Label(string status) => status switch
    {
        Created => "Aguardando Confirmação",
        Accepted => "Confirmado",
        Preparing => "Em preparação",
        OutForDelivery => "Saiu para entrega",
        ReadyForPickup => "Disponível para retirada",
        ReadyForTable => "Pronto para a mesa",
        Delivered => "Finalizado",
        Cancelled => "Cancelado",
        _ => status
    };

    public static string? Next(string current, string? fulfillmentType = null)
    {
        var seq = SequenceFor(fulfillmentType);
        var idx = Array.IndexOf(seq, current);
        if (idx < 0 || idx >= seq.Length - 1) return null;
        return seq[idx + 1];
    }

    public static bool IsTerminal(string status) =>
        status is Delivered or Cancelled;

    public static bool CanCancel(string from) =>
        from is Created or Accepted or Preparing or OutForDelivery or ReadyForPickup or ReadyForTable;

    public static bool CanTransition(string from, string to, string? fulfillmentType = null)
    {
        if (string.Equals(to, Cancelled, StringComparison.Ordinal))
            return CanCancel(from);

        // Transição sequencial sempre. O garçom só entrega na mesa quando a
        // comanda está "Pronto para a mesa" (dine-in), nunca pulando etapas.
        var next = Next(from, fulfillmentType);
        return next is not null && string.Equals(next, to, StringComparison.Ordinal);
    }

    public static bool IsKnown(string status) => All.Contains(status);
}
