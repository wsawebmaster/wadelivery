using Catalog.Api;
using Catalog.Api.Models;

namespace Catalog.Api.Tests;

public class ChangePasswordValidationTests
{
    [Fact]
    public void Rejects_new_password_equal_to_current()
    {
        Assert.Equal("A nova senha deve ser diferente da atual.",
            CatalogInputValidation.ValidateChangePassword(new ChangePasswordRequest("senha-temporaria", "senha-temporaria")));
    }

    [Fact]
    public void Accepts_a_different_new_password()
    {
        Assert.Null(CatalogInputValidation.ValidateChangePassword(new ChangePasswordRequest("senha-temporaria", "minha-senha-nova")));
    }
}
