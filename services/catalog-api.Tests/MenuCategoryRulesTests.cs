using Catalog.Api;
using Catalog.Api.Models;

namespace Catalog.Api.Tests;

public class MenuCategoryRulesTests
{
    [Theory]
    [InlineData("ingredientes", "Ingredientes")]
    [InlineData("7", "Ingrediente")]
    [InlineData("ingredients", "Extras")]
    [InlineData("x", "INGREDIENTS")]
    public void IsIngredientsCategory_detects_reserved_names(string id, string title)
    {
        Assert.True(CatalogInputValidation.IsIngredientsCategory(id, title));
    }

    [Theory]
    [InlineData("adicionais", "Adicionais")]
    [InlineData("adicional", "Adicional")]
    [InlineData("addons", "Addons")]
    public void IsAddonsCategory_detects_reserved_names(string id, string title)
    {
        Assert.True(CatalogInputValidation.IsAddonsCategory(id, title));
    }

    [Theory]
    [InlineData("hamburguer", "Hambúrguer")]
    [InlineData("2", "Porções")]
    public void IsHiddenMenuCategory_allows_normal_menu_categories(string id, string title)
    {
        Assert.False(CatalogInputValidation.IsIngredientsCategory(id, title));
        Assert.False(CatalogInputValidation.IsAddonsCategory(id, title));
        Assert.False(CatalogInputValidation.IsHiddenMenuCategory(id, title));
    }

    [Fact]
    public void ValidateCategory_rejects_ingredients_as_category()
    {
        var err = CatalogInputValidation.ValidateCategory(
            new UpsertCategoryRequest("ingredientes", "Ingredientes"));
        Assert.NotNull(err);
        Assert.Contains("Ingredientes", err, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ResolveCategoryShowInMenu_forces_false_for_ingredients_and_addons()
    {
        Assert.False(CatalogInputValidation.ResolveCategoryShowInMenu("x", "Ingredientes", requested: true));
        Assert.False(CatalogInputValidation.ResolveCategoryShowInMenu("adicionais", "Adicionais", requested: true));
        Assert.False(CatalogInputValidation.ResolveCategoryShowInMenu("adicionais", "Adicionais", requested: false));
        Assert.True(CatalogInputValidation.ResolveCategoryShowInMenu("hamburguer", "Hambúrguer", requested: true));
    }
}
