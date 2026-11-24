namespace Catalog.Api.Services;

/// <summary>
/// Modelo da mensagem que o cliente envia pelo WhatsApp ao concluir o pedido no cardápio.
/// O cardápio substitui as variáveis {nome}; linhas cujas variáveis ficam todas vazias
/// (ex.: observações não informadas) são omitidas.
/// </summary>
public static class WhatsAppOrderTemplate
{
    public const int MaxLength = 4000;

    /// <summary>Reproduz exatamente a mensagem fixa usada antes da personalização.</summary>
    public const string Default =
        "Olá, {loja}!\n" +
        "\n" +
        "🛒 Pedido *{pedido}*\n" +
        "📦 Recebimento: {recebimento}\n" +
        "\n" +
        "✅ Itens:\n" +
        "{itens}\n" +
        "\n" +
        "Sub-total: {subtotal}\n" +
        "Taxa de Entrega: {taxa_entrega}\n" +
        "🤑 Total: {total}\n" +
        "💳 Pagamento: {pagamento}\n" +
        "📝 Observações: {observacoes}\n" +
        "\n" +
        "{endereco_entrega}\n" +
        "👤 Nome: {cliente}\n" +
        "📞 Telefone: {telefone}\n" +
        "\n" +
        "*Aguardo confirmação!*";

    /// <summary>
    /// Normaliza o texto salvo pelo painel: quebras de linha em \n e espaços nas pontas.
    /// Vazio ou igual ao padrão vira null (= usar o padrão, que acompanha melhorias futuras).
    /// </summary>
    public static string? Normalize(string? value)
    {
        if (value is null) return null;
        var text = value.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
        return text.Length == 0 || text == Default ? null : text;
    }
}
