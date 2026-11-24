using Catalog.Api.Services;

namespace Catalog.Api.Tests;

public class SampleCatalogTests
{
    [Theory]
    [InlineData("lanchonete")]
    [InlineData("hamburgueria")]
    [InlineData("pizzaria")]
    [InlineData("marmitaria")]
    [InlineData("assai")]
    public void Every_segment_has_two_products_with_existing_photo(string segment)
    {
        var menu = SampleCatalog.For(segment);
        Assert.Equal(2, menu.Products.Count);
        foreach (var p in menu.Products)
        {
            Assert.InRange(p.CategoryIndex, 0, menu.Categories.Count - 1);
            Assert.True(p.Price > 0);
            Assert.True(File.Exists(Path.Combine(SampleCatalog.AssetsDirectory, p.PhotoFile)), p.PhotoFile);
        }
    }

    [Fact]
    public void Unknown_segment_falls_back_to_lanchonete()
    {
        Assert.Same(SampleCatalog.For("lanchonete"), SampleCatalog.For("xpto"));
    }

    [Theory]
    [InlineData("Pizzaria Bella Napoli", "PB")]
    [InlineData("Casa do Açaí", "CA")]
    [InlineData("Fabin", "F")]
    [InlineData("  ", "W")]
    public void Initials_skip_connectors(string name, string expected)
    {
        Assert.Equal(expected, DefaultLogo.Initials(name));
    }

    [Fact]
    public void Svg_escapes_store_name_and_uses_palette()
    {
        var svg = DefaultLogo.BuildSvg("<script>alert(1)</script> & Cia", "#ea580c");
        Assert.DoesNotContain("<script>", svg);
        Assert.StartsWith("<svg", svg);
        Assert.Contains("stop-color=\"#", svg);
        // cor inválida cai no padrão em vez de quebrar o SVG
        Assert.Contains("stop-color", DefaultLogo.BuildSvg("Loja", "javascript:x"));
    }
}
