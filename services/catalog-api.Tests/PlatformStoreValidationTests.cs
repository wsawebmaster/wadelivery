using Catalog.Api.Models;

namespace Catalog.Api.Tests;

public class PlatformStoreValidationTests
{
    [Theory]
    [InlineData("teste")] // plano das lojas criadas pelo cadastro automático
    [InlineData("starter")]
    [InlineData("Premium")]
    public void Known_plans_are_accepted(string plan)
    {
        Assert.Null(CatalogInputValidation.ValidatePlatformStore(new UpsertPlatformStoreRequest { Name = "Loja", Plan = plan }));
    }

    [Fact]
    public void Unknown_plan_is_rejected()
    {
        Assert.NotNull(CatalogInputValidation.ValidatePlatformStore(new UpsertPlatformStoreRequest { Name = "Loja", Plan = "ouro" }));
    }
}
