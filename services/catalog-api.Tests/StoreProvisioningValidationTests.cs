using Catalog.Api.Models;
using Catalog.Api.Services;

namespace Catalog.Api.Tests;

public class StoreProvisioningValidationTests
{
    [Fact]
    public void Validate_accepts_a_complete_store_with_valid_cnpj()
    {
        var error = StoreProvisioningService.Validate(ValidRequest());

        Assert.Null(error);
    }

    [Fact]
    public void Validate_rejects_an_invalid_cnpj()
    {
        var request = ValidRequest();
        request.Cnpj = "12.345.678/0001-90";

        var error = StoreProvisioningService.Validate(request);

        Assert.Equal("CNPJ inválido.", error);
    }

    [Fact]
    public void Validate_handles_missing_optional_neighborhood()
    {
        var request = ValidRequest();
        request.Bairro = null!;

        var error = StoreProvisioningService.Validate(request);

        Assert.Null(error);
    }

    private static CriarLojaRequest ValidRequest() => new()
    {
        Nome = "Pizzaria do João",
        Slug = "pizzaria-do-joao",
        Cnpj = "04.252.011/0001-10",
        Telefone = "(11) 99999-9999",
        Email = "joao@example.com",
        Endereco = "Rua das Flores",
        Numero = "123",
        Bairro = "Centro",
        Cidade = "São Paulo",
        Estado = "SP",
        Cep = "01001-000",
        Segmento = "pizzaria",
        CorPrimaria = "#1f6feb",
        CorSecundaria = "#ffffff",
        CorFundo = "#f3f4f6",
        CorTexto = "#2c3e50",
        TipoCard = "foto-grande",
        LayoutCardapio = "grade",
        EstiloBotao = "arredondado"
    };
}
