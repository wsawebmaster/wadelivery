namespace Orders.Api.Models;

public static class OrderCancellation
{
    public record ReasonPreset(string Code, string Label, bool CustomerRequested);

    public static readonly ReasonPreset[] Presets =
    [
        new("customer_request", "A pedido do cliente", true),
        new("item_unavailable", "Item indisponível / sem estoque", false),
        new("store_unable", "Loja sem condições de preparar no momento", false),
        new("delivery_issue", "Problema com entrega ou endereço fora da área", false),
        new("payment_issue", "Problema com o pagamento", false),
        new("duplicate", "Pedido duplicado", false),
        new("other", "Outro motivo", false)
    ];

    public static ReasonPreset? Find(string? code) =>
        Presets.FirstOrDefault(p => string.Equals(p.Code, code?.Trim(), StringComparison.OrdinalIgnoreCase));

    public static bool IsKnownCode(string? code) => Find(code) is not null;

    /// <summary>Texto exibido ao cliente (motivo escolhido + detalhe opcional).</summary>
    public static string BuildDisplayReason(string code, string? customDetail)
    {
        var preset = Find(code);
        var label = preset?.Label ?? "Pedido cancelado";
        var detail = (customDetail ?? "").Trim();
        if (string.IsNullOrWhiteSpace(detail)) return label;
        if (string.Equals(code, "other", StringComparison.OrdinalIgnoreCase))
            return detail;
        return $"{label}: {detail}";
    }
}
