namespace Orders.Api.Models;

public static class OrderPayment
{
    public const string TimingNow = "now";
    public const string TimingOnDelivery = "on_delivery";

    public const string StatusPending = "pending";
    public const string StatusConfirmed = "confirmed";
    public const string StatusOnDelivery = "on_delivery";

    public static string NormalizeTiming(string? timing, string paymentMethod)
    {
        var isPix = string.Equals(paymentMethod?.Trim(), "Pix", StringComparison.OrdinalIgnoreCase);
        var t = (timing ?? "").Trim().ToLowerInvariant();
        if (t is TimingNow or TimingOnDelivery) return t;
        return isPix ? TimingOnDelivery : TimingOnDelivery;
    }

    public static string InitialStatus(string timing) =>
        string.Equals(timing, TimingNow, StringComparison.OrdinalIgnoreCase)
            ? StatusPending
            : StatusOnDelivery;

    public static bool IsKnownStatus(string? status)
    {
        var s = (status ?? "").Trim().ToLowerInvariant();
        return s is StatusPending or StatusConfirmed or StatusOnDelivery;
    }

    public static string TimingLabel(string? timing) => (timing ?? "").ToLowerInvariant() switch
    {
        TimingNow => "Pagar agora",
        TimingOnDelivery => "Pagar na entrega",
        _ => timing ?? "—"
    };

    public static string StatusLabel(string? status) => (status ?? "").ToLowerInvariant() switch
    {
        StatusPending => "Aguardando confirmação",
        StatusConfirmed => "Pagamento confirmado",
        StatusOnDelivery => "Pagar na entrega",
        _ => status ?? "—"
    };

    /// <summary>
    /// Entrega só após pagamento confirmado.
    /// "Pagar na entrega" exige confirmar o recebimento antes de marcar entregue.
    /// </summary>
    public static bool CanMarkDelivered(string? paymentStatus, string? paymentTiming = null)
    {
        var status = (paymentStatus ?? "").Trim().ToLowerInvariant();
        return status == StatusConfirmed;
    }

    public static string DeliverBlockedReason(string? paymentStatus)
    {
        var status = (paymentStatus ?? "").Trim().ToLowerInvariant();
        return status switch
        {
            StatusPending => "Confirme o pagamento Pix antes de marcar como entregue.",
            StatusOnDelivery => "Confirme o recebimento do pagamento (na entrega) antes de marcar como entregue.",
            _ => "Confirme o pagamento antes de marcar como entregue."
        };
    }
}
