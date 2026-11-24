using Catalog.Api;
using Catalog.Api.Models;

namespace Catalog.Api.Tests;

public class StoreAppearanceValidationTests
{
    [Theory]
    [InlineData("foto-grande")]
    [InlineData("lista-horizontal")]
    [InlineData("compacto")]
    [InlineData("vitrine")]
    [InlineData("minimalista")]
    [InlineData("destaque")]
    [InlineData("moderno")]
    public void ValidatePatchStore_accepts_every_card_model(string tipoCard)
    {
        Assert.Null(CatalogInputValidation.ValidatePatchStore(new PatchStoreRequest { TipoCard = tipoCard }));
    }

    [Theory]
    [InlineData("")]
    [InlineData("Vitrine")]
    [InlineData("carrossel")]
    public void ValidatePatchStore_rejects_unknown_card_model(string tipoCard)
    {
        Assert.Equal("Modelo de card inválido.",
            CatalogInputValidation.ValidatePatchStore(new PatchStoreRequest { TipoCard = tipoCard }));
    }

    [Theory]
    [InlineData("lanchonete", "#ea580c")]
    [InlineData("HAMBURGUERIA", "#dc2626")]
    [InlineData(" pizzaria ", "#b91c1c")]
    [InlineData("marmitaria", "#15803d")]
    [InlineData("assai", "#7e22ce")]
    [InlineData("acougue", "#1f6feb")]
    [InlineData(null, "#1f6feb")]
    public void SegmentPalettes_returns_palette_by_segment_or_default(string? segment, string expectedPrimary)
    {
        Assert.Equal(expectedPrimary, Catalog.Api.Services.SegmentPalettes.For(segment).CorPrimaria);
    }

    [Fact]
    public void SegmentPalettes_use_valid_hex_colors()
    {
        foreach (var p in Catalog.Api.Services.SegmentPalettes.All.Append(Catalog.Api.Services.SegmentPalettes.Default))
        {
            Assert.True(CatalogInputValidation.IsHexColor(p.CorPrimaria), p.Segment);
            Assert.True(CatalogInputValidation.IsHexColor(p.CorSecundaria), p.Segment);
            Assert.True(CatalogInputValidation.IsHexColor(p.CorFundo), p.Segment);
            Assert.True(CatalogInputValidation.IsHexColor(p.CorTexto), p.Segment);
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("rei-da-casa")]
    [InlineData("mais-pedido")]
    [InlineData("novidade")]
    [InlineData("promocao")]
    [InlineData("para-dividir")]
    [InlineData("vegetariano")]
    public void ValidateProduct_accepts_known_badges(string? badge)
    {
        var body = new UpsertProductRequest(null, "lanches", "X-Tudo", 30m, true, null, Badge: badge);

        Assert.Null(CatalogInputValidation.ValidateProduct(body));
    }

    [Theory]
    [InlineData("👑 Rei da Casa")]
    [InlineData("Mais-Pedido")]
    [InlineData("<script>")]
    public void ValidateProduct_rejects_unknown_badges(string badge)
    {
        var body = new UpsertProductRequest(null, "lanches", "X-Tudo", 30m, true, null, Badge: badge);

        Assert.Equal("Selo do produto inválido.", CatalogInputValidation.ValidateProduct(body));
    }

    [Fact]
    public void ValidatePatchStore_accepts_hero_settings()
    {
        var body = new PatchStoreRequest
        {
            HeroEnabled = true,
            HeroProductId = "a1b2c3d4e5",
            HeroTitle = "O verdadeiro sabor do Rei do Carne e Queijo",
            HeroSubtitle = "Lanches artesanais preparados na hora."
        };

        Assert.Null(CatalogInputValidation.ValidatePatchStore(body));
        Assert.Null(CatalogInputValidation.ValidatePatchStore(new PatchStoreRequest { HeroProductId = "" }));
    }

    [Fact]
    public void ValidatePatchStore_rejects_invalid_hero_settings()
    {
        Assert.NotNull(CatalogInputValidation.ValidatePatchStore(new PatchStoreRequest { HeroProductId = "../etc" }));
        Assert.NotNull(CatalogInputValidation.ValidatePatchStore(new PatchStoreRequest { HeroTitle = new string('a', 91) }));
        Assert.NotNull(CatalogInputValidation.ValidatePatchStore(new PatchStoreRequest { HeroSubtitle = new string('a', 221) }));
    }

    [Fact]
    public void ValidatePatchStore_accepts_hex_colors()
    {
        var body = new PatchStoreRequest { CorPrimaria = "#1F6FEB", CorSecundaria = "#ffffff", CorFundo = "#f3f4f6", CorTexto = "#2c3e50" };

        Assert.Null(CatalogInputValidation.ValidatePatchStore(body));
    }

    [Theory]
    [InlineData("red")]
    [InlineData("#fff")]
    [InlineData("1f6feb")]
    [InlineData("#1f6feg")]
    public void ValidatePatchStore_rejects_invalid_colors(string color)
    {
        Assert.NotNull(CatalogInputValidation.ValidatePatchStore(new PatchStoreRequest { CorFundo = color }));
    }
}
