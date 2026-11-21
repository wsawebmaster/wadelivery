using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Orders.Api.Models;

namespace Orders.Api;

public static partial class OrderValidation
{
    private static readonly HashSet<string> AllowedPayments = new(StringComparer.OrdinalIgnoreCase)
    {
        "Pix", "Dinheiro", "Cartão", "Cartao", "Crédito", "Credito", "Débito", "Debito"
    };

    private static readonly HashSet<string> AllowedOrderSources = new(StringComparer.OrdinalIgnoreCase)
    {
        "customer_qr", "waiter_panel", "admin_panel", "balcao", "delivery", "telefone"
    };

    /// <summary>
    /// Origens criadas por equipe no painel/cardápio autenticado (já validadas com o cliente,
    /// nascem confirmadas e com pagamento "Em Aberto" — a baixa é feita depois no painel).
    /// </summary>
    private static readonly HashSet<string> StaffOrderSources = new(StringComparer.OrdinalIgnoreCase)
    {
        "waiter_panel", "admin_panel", "balcao", "delivery", "telefone"
    };

    public static bool IsStaffSource(string? source) =>
        StaffOrderSources.Contains((source ?? "").Trim());

    public static string? ValidateCreate(CreateOrderRequest body)
    {
        if (body.Items is null || body.Items.Count == 0)
            return "Pedido sem itens.";
        if (body.Items.Count > 50)
            return "Pedido com itens demais.";

        var isDineIn = OrderStatus.IsDineIn(body.FulfillmentType);

        var name = (body.CustomerName ?? "").Trim();
        if (!isDineIn)
        {
            if (name.Length is < 2 or > 120)
                return "Informe um nome válido (2 a 120 caracteres).";
        }
        else
        {
            // dine_in: nome pode ser curto ("Cliente") ou vazio (será preenchido pelo server)
            if (name.Length > 120)
                return "Nome muito longo (máx. 120 caracteres).";
        }

        var phoneDigits = DigitsOnly(body.CustomerPhone);
        if (!isDineIn)
        {
            if (phoneDigits.Length is < 10 or > 13)
                return "Informe um telefone válido com DDD.";
        }
        else
        {
            // dine_in: telefone opcional
            if (phoneDigits.Length > 0 && phoneDigits.Length is < 10 or > 13)
                return "Informe um telefone válido com DDD.";
        }

        var address = (body.Address ?? "").Trim();
        if (!isDineIn)
        {
            if (address.Length is < 5 or > 400)
                return "Informe um endereço válido.";
        }
        else
        {
            // dine_in: endereço não obrigatório (será preenchido pelo server)
            if (address.Length > 400)
                return "Endereço muito longo (máx. 400 caracteres).";
        }

        var payment = (body.PaymentMethod ?? "").Trim();
        if (string.IsNullOrWhiteSpace(payment) || payment.Length > 64)
            return "Informe a forma de pagamento.";
        // Garçom/Admin/Atendimento registram "Em Aberto" — o método real é definido depois
        // (no fechamento da mesa ou na baixa de pagamento pelo painel).
        var isStaffOrder = OrderValidation.IsStaffSource(body.OrderSource);
        if (!isStaffOrder
            && !AllowedPayments.Contains(payment)
            && !payment.Contains("cart", StringComparison.OrdinalIgnoreCase)
            && !payment.Contains("pix", StringComparison.OrdinalIgnoreCase)
            && !payment.Contains("dinheiro", StringComparison.OrdinalIgnoreCase))
            return "Forma de pagamento inválida.";

        if ((body.Notes?.Length ?? 0) > 500)
            return "Observações muito longas (máx. 500).";
        if ((body.Reference?.Length ?? 0) > 200)
            return "Referência muito longa (máx. 200).";

        if (body.NeedsChange == true && body.ChangeFor is null or <= 0)
            return "Informe o valor para o troco.";
        if (body.ChangeFor is < 0)
            return "Valor do troco inválido.";
        if (body.ChangeFor is > 1_000_000)
            return "Valor do troco muito alto.";

        // Dine-in specific validations
        if (isDineIn)
        {
            var source = (body.OrderSource ?? "").Trim();
            if (string.IsNullOrWhiteSpace(source))
                return "Origem do pedido é obrigatória para consumo no local.";
            if (!AllowedOrderSources.Contains(source))
                return "Origem do pedido inválida.";

            if (source == "customer_qr" && string.IsNullOrWhiteSpace(body.TableAccessCode))
                return "Código da mesa é obrigatório para pedido do cliente.";

            if (source == "waiter_panel" && body.TableId is null or <= 0)
                return "Mesa é obrigatória para pedido do garçom.";
        }
        else
        {
            // Não-dine-in: origem opcional, mas se informada precisa ser conhecida
            // (web/normal envia vazio; staff envia balcao|delivery|telefone).
            var source = (body.OrderSource ?? "").Trim();
            if (!string.IsNullOrEmpty(source) && !AllowedOrderSources.Contains(source))
                return "Origem do pedido inválida.";
        }

        foreach (var item in body.Items)
        {
            if (string.IsNullOrWhiteSpace(item.Name) || item.Name.Length > 200)
                return "Item inválido no pedido.";
            if (item.Quantity is < 1 or > 99)
                return "Quantidade inválida em um dos itens.";
            if (item.Modifiers is not null)
            {
                if (item.Modifiers.Count > 30)
                    return "Muitas adições em um item (máx. 30).";
                foreach (var mod in item.Modifiers)
                {
                    if (mod is null || mod.Name.Length > 120)
                        return "Adição inválida no pedido.";
                    if (mod.PriceDelta < 0 || mod.PriceDelta > 1000)
                        return "Preço de adição inválido.";
                }
            }
        }

        return null;
    }

    public static string DigitsOnly(string? value) =>
        string.IsNullOrEmpty(value) ? "" : DigitsRegex().Replace(value, "");

    public static string BaseProductName(string lineName)
    {
        var name = (lineName ?? "").Trim();
        var obsIdx = name.IndexOf(" (Obs.:", StringComparison.OrdinalIgnoreCase);
        if (obsIdx > 0) name = name[..obsIdx].Trim();
        // Remove sufixos encadeados "(Pão francês)", "(Sem Cebola)", "(Média)" → "Produto"
        while (true)
        {
            var open = name.LastIndexOf(" (", StringComparison.Ordinal);
            if (open <= 0 || !name.EndsWith(')')) break;
            name = name[..open].Trim();
        }
        return name;
    }

    /// <summary>
    /// Extrai o tamanho escolhido ("Média"/"Inteira") do nome da linha, ignorando acentos e
    /// caixa, procurando em qualquer sufixo entre parênteses. Retorna null quando não acha.
    /// </summary>
    public static string? ExtractSizeOption(string lineName)
    {
        var name = (lineName ?? "").Trim();
        var obsIdx = name.IndexOf(" (Obs.:", StringComparison.OrdinalIgnoreCase);
        if (obsIdx > 0) name = name[..obsIdx].Trim();

        foreach (var chunk in ParentheticalChunksRegex().Matches(name).Select(m => m.Groups[1].Value))
        {
            var normalized = RemoveDiacritics(chunk).Trim().ToLowerInvariant();
            if (normalized is "media" or "inteira")
                return normalized == "media" ? "Média" : "Inteira";
        }
        return null;
    }

    /// <summary>
    /// Extrai os nomes de adicionais pagos gravados apenas no texto da linha
    /// ("(Adic. Bacon +8,00)"), tokens separados por ";". Serve para recuperar o adicional
    /// quando o cliente não enviou <c>Modifiers</c> estruturados (pedidos antigos/cache).
    /// </summary>
    public static List<string> ExtractAddonNames(string? lineName)
    {
        var names = new List<string>();
        var name = (lineName ?? "").Trim();
        var obsIdx = name.IndexOf(" (Obs.:", StringComparison.OrdinalIgnoreCase);
        if (obsIdx > 0) name = name[..obsIdx];

        foreach (var chunk in ParentheticalChunksRegex().Matches(name).Select(m => m.Groups[1].Value))
        {
            foreach (var raw in chunk.Split(';', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            {
                var token = AddonTokenRegex().Match(raw.Trim());
                if (!token.Success) continue;
                var optionName = TrailingPriceRegex().Replace(token.Groups[1].Value, "").Trim();
                if (optionName.Length > 0) names.Add(optionName);
            }
        }
        return names;
    }

    /// <summary>
    /// Normaliza rótulos para comparação: sem acentos, sem espaços nas pontas, caixa baixa
    /// e espaços internos colapsados.
    /// </summary>
    public static string NormalizeLabel(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var normalized = RemoveDiacritics(value).Trim().ToLowerInvariant();
        return WhitespaceRegex().Replace(normalized, " ");
    }

    private static string RemoveDiacritics(string value) =>
        string.Concat(value.Normalize(NormalizationForm.FormD).Where(c => CharUnicodeInfo.GetUnicodeCategory(c) != UnicodeCategory.NonSpacingMark))
            .Normalize(NormalizationForm.FormC);

    [GeneratedRegex(@"\D")]
    private static partial Regex DigitsRegex();

    [GeneratedRegex(@"\(([^()]*)\)")]
    private static partial Regex ParentheticalChunksRegex();

    [GeneratedRegex(@"^\s*Adic\.\s*(.+)$", RegexOptions.IgnoreCase)]
    private static partial Regex AddonTokenRegex();

    [GeneratedRegex(@"\s*\+\s*R?\$?\s*\d[\d.,]*\s*$")]
    private static partial Regex TrailingPriceRegex();

    [GeneratedRegex(@"\s+")]
    private static partial Regex WhitespaceRegex();
}
