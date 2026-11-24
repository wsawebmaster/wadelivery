using Catalog.Api.Models;
using Catalog.Api.Services;

namespace Catalog.Api.Tests;

public class StoreProvisioningValidationTests
{
    [Fact]
    public void New_store_entity_has_no_explicit_id_so_the_database_generates_it()
    {
        // Um Id padrão diferente de 0 faz o EF inserir o valor explicitamente e
        // colidir com a loja existente (PK_stores) ao provisionar uma nova loja.
        Assert.Equal(0, new Catalog.Api.Data.Loja().Id);
    }

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
    public void Validate_accepts_alphanumeric_cnpj_for_pj()
    {
        var request = ValidRequest();
        request.TipoPessoa = "PJ";
        request.Documento = "12.ABC.345/01DE-35";
        request.Cnpj = "";

        var error = StoreProvisioningService.Validate(request);

        Assert.Null(error);
    }

    [Fact]
    public void Validate_accepts_cpf_for_pf()
    {
        var request = ValidRequest();
        request.TipoPessoa = "PF";
        request.Documento = "529.982.247-25";
        request.Cnpj = "";

        var error = StoreProvisioningService.Validate(request);

        Assert.Null(error);
    }

    [Fact]
    public void Validate_handles_missing_optional_neighborhood()
    {
        var request = ValidRequest();
        request.Bairro = null!;

        var error = StoreProvisioningService.Validate(request);

        Assert.Null(error);
    }

    [Fact]
    public void Validate_accepts_quick_mode_with_minimal_fields()
    {
        var request = new CriarLojaRequest
        {
            ModoRapido = true,
            Nome = "Loja Teste",
            Slug = "loja-teste",
            Email = "teste@example.com",
            Telefone = "(16) 99999-9999",
            Segmento = "assai",
            Estado = "SP",
            Cidade = "Ribeirão Preto",
            Endereco = "Rua São Sebastião",
            Numero = "100",
            Cep = "14015-040",
            TipoEntrega = "fixa",
            TaxaEntregaFixa = "7,50",
            DistanciaMaximaKm = "5"
        };

        var error = StoreProvisioningService.Validate(request);

        Assert.Null(error);
    }

    [Fact]
    public void Validate_rejects_quick_mode_without_state_or_city()
    {
        var request = new CriarLojaRequest
        {
            ModoRapido = true,
            Nome = "Loja Teste",
            Slug = "loja-teste",
            Email = "teste@example.com",
            Telefone = "(16) 99999-9999",
            Segmento = "lanchonete",
            Estado = "",
            Cidade = "",
            Endereco = "Rua São Sebastião",
            Numero = "100",
            Cep = "14015-040",
            TipoEntrega = "fixa",
            TaxaEntregaFixa = "7,50",
            DistanciaMaximaKm = "5"
        };

        var error = StoreProvisioningService.Validate(request);

        Assert.Equal("Informe uma UF válida.", error);
    }

    [Theory]
    [InlineData("fixa", "7,50", null, null, "5", 0, 7.50, 5)]
    [InlineData("fixa", "7.5", null, null, "3,5", 0, 7.50, 3.5)]
    [InlineData("km", null, "2,50", "5", "10", 2.50, 5, 10)]
    [InlineData("km", null, "1.99", "", "8", 1.99, 0, 8)]
    public void ParseDelivery_maps_choice_to_store_fields(string tipo, string? fixa, string? porKm, string? minima, string maxKm,
        double expectedPerKm, double expectedMin, double expectedMax)
    {
        var request = ValidRequest();
        request.TipoEntrega = tipo;
        request.TaxaEntregaFixa = fixa;
        request.TaxaPorKm = porKm;
        request.TaxaMinima = minima;
        request.DistanciaMaximaKm = maxKm;

        var config = StoreProvisioningService.ParseDelivery(request, out var error);

        Assert.Null(error);
        Assert.Equal(new DeliveryConfig((decimal)expectedPerKm, (decimal)expectedMin, (decimal)expectedMax), config);
    }

    [Theory]
    [InlineData("", "7", null, "5", "Escolha como cobrar")]
    [InlineData("fixa", "0", null, "5", "taxa fixa")]
    [InlineData("fixa", "abc", null, "5", "taxa fixa")]
    [InlineData("km", null, "0", "5", "valor por km")]
    [InlineData("fixa", "7", null, "0", "distância máxima")]
    [InlineData("fixa", "7", null, "", "distância máxima")]
    [InlineData("km", null, "2", "150", "distância máxima")]
    public void Validate_rejects_invalid_delivery_settings(string tipo, string? fixa, string? porKm, string maxKm, string expectedFragment)
    {
        var request = ValidRequest();
        request.TipoEntrega = tipo;
        request.TaxaEntregaFixa = fixa;
        request.TaxaPorKm = porKm;
        request.TaxaMinima = null;
        request.DistanciaMaximaKm = maxKm;

        var error = StoreProvisioningService.Validate(request);

        Assert.NotNull(error);
        Assert.Contains(expectedFragment, error);
    }

    [Theory]
    [InlineData("Celular", "(16) 99249-6886", "16992496886", "Celular")]
    [InlineData("Telefone", "(16) 99249-6886", "16992496886", "Celular")]
    [InlineData("cpf", "529.982.247-25", "52998224725", "CPF")]
    [InlineData("CNPJ", "04.252.011/0001-10", "04252011000110", "CNPJ")]
    [InlineData("E-mail", "Loja@Example.com", "loja@example.com", "E-mail")]
    [InlineData("Email", "loja@example.com", "loja@example.com", "E-mail")]
    [InlineData("Chave aleatória", "123E4567-E89B-12D3-A456-426614174000", "123e4567-e89b-12d3-a456-426614174000", "Chave aleatória")]
    [InlineData("Aleatória", "123e4567e89b12d3a456426614174000", "123e4567e89b12d3a456426614174000", "Chave aleatória")]
    public void ParsePix_normalizes_key_and_uses_official_label(string type, string key, string expectedKey, string expectedLabel)
    {
        var request = ValidRequest();
        request.TipoChavePix = type;
        request.ChavePix = key;

        var pix = StoreProvisioningService.ParsePix(request, out var error);

        Assert.Null(error);
        Assert.Equal(expectedKey, pix?.Key);
        Assert.Equal(expectedLabel, pix?.Label);
    }

    [Fact]
    public void ParsePix_is_optional()
    {
        var request = ValidRequest();
        request.ChavePix = "  ";

        Assert.Null(StoreProvisioningService.ParsePix(request, out var error));
        Assert.Null(error);
        Assert.Null(StoreProvisioningService.Validate(request));
    }

    [Theory]
    [InlineData("Telefone", "123")]
    [InlineData("CPF", "111.111.111-11")]
    [InlineData("E-mail", "sem-arroba")]
    [InlineData("Aleatória", "nao-e-uuid")]
    [InlineData("", "16992496886")]
    public void Validate_rejects_invalid_pix_key(string type, string key)
    {
        var request = ValidRequest();
        request.TipoChavePix = type;
        request.ChavePix = key;

        Assert.NotNull(StoreProvisioningService.Validate(request));
    }

    [Fact]
    public void Validate_requires_store_address_in_quick_mode()
    {
        var request = ValidRequest();
        request.ModoRapido = true;
        request.Cep = "";

        Assert.Equal("CEP inválido.", StoreProvisioningService.Validate(request));
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
        EstiloBotao = "arredondado",
        TipoEntrega = "km",
        TaxaPorKm = "2.50",
        TaxaMinima = "5",
        DistanciaMaximaKm = "10"
    };
}
