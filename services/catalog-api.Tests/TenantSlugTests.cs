using Catalog.Api;

namespace Catalog.Api.Tests;

public class TenantSlugTests
{
    [Theory]
    [InlineData("fabin", "fabin")]
    [InlineData("Gota Açaí", "gota-acai")]
    [InlineData("Frango Frito", "frango-frito")]
    [InlineData("  PIZZA HUT  ", "pizza-hut")]
    [InlineData("x---y", "x-y")]
    public void NormalizeTenantSlug_lowercases_and_normalizes(string input, string expected)
    {
        Assert.Equal(expected, CatalogInputValidation.NormalizeTenantSlug(input));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("---")]
    [InlineData("!@#$%")]
    public void NormalizeTenantSlug_returns_null_for_invalid(string input)
    {
        Assert.Null(CatalogInputValidation.NormalizeTenantSlug(input));
    }

    [Theory]
    [InlineData("fabin", true)]
    [InlineData("gota-acai", true)]
    [InlineData("GOTA-ACAI", false)]
    [InlineData("com espaço", false)]
    [InlineData("slá", false)]
    [InlineData("-comeca-com-hiphen", false)]
    public void IsValidTenantSlug_enforces_lowercase_slug_format(string input, bool expected)
    {
        Assert.Equal(expected, CatalogInputValidation.IsValidTenantSlug(input));
    }

    [Theory]
    [InlineData("Gota Açaí", "gota-acai")]
    [InlineData("", "loja")]
    [InlineData(null, "loja")]
    public void SlugifyStoreName_generates_candidate(string? input, string expected)
    {
        Assert.Equal(expected, CatalogInputValidation.SlugifyStoreName(input));
    }
}