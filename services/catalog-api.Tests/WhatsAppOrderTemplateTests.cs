using Catalog.Api;
using Catalog.Api.Models;
using Catalog.Api.Services;

namespace Catalog.Api.Tests;

public class WhatsAppOrderTemplateTests
{
    [Fact]
    public void Default_contains_all_order_variables()
    {
        foreach (var variable in new[]
                 {
                     "{loja}", "{pedido}", "{recebimento}", "{itens}", "{subtotal}", "{taxa_entrega}",
                     "{total}", "{pagamento}", "{observacoes}", "{endereco_entrega}", "{cliente}", "{telefone}"
                 })
        {
            Assert.Contains(variable, WhatsAppOrderTemplate.Default);
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   \r\n  ")]
    public void Normalize_treats_empty_as_default(string? value)
    {
        Assert.Null(WhatsAppOrderTemplate.Normalize(value));
    }

    [Fact]
    public void Normalize_treats_default_text_as_default_even_with_windows_line_breaks()
    {
        var withCrLf = WhatsAppOrderTemplate.Default.Replace("\n", "\r\n") + "\r\n";

        Assert.Null(WhatsAppOrderTemplate.Normalize(withCrLf));
    }

    [Fact]
    public void Normalize_keeps_custom_text_with_unix_line_breaks()
    {
        var result = WhatsAppOrderTemplate.Normalize("  Oi {loja}!\r\nPedido {pedido}  ");

        Assert.Equal("Oi {loja}!\nPedido {pedido}", result);
    }

    [Fact]
    public void ValidatePatchStore_rejects_template_over_limit()
    {
        var body = new PatchStoreRequest { WhatsAppOrderTemplate = new string('a', WhatsAppOrderTemplate.MaxLength + 1) };

        Assert.NotNull(CatalogInputValidation.ValidatePatchStore(body));
    }

    [Fact]
    public void ValidatePatchStore_accepts_template_within_limit()
    {
        var body = new PatchStoreRequest { WhatsAppOrderTemplate = "Pedido {pedido} — {total}" };

        Assert.Null(CatalogInputValidation.ValidatePatchStore(body));
    }
}
