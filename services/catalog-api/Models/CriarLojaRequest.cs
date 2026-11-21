namespace Catalog.Api.Models;

public sealed class CriarLojaRequest
{
    public string Nome { get; set; } = string.Empty;
    public string Slug { get; set; } = string.Empty;
    public string Cnpj { get; set; } = string.Empty;
    public string Telefone { get; set; } = string.Empty;
    public string Email { get; set; } = string.Empty;
    public string Endereco { get; set; } = string.Empty;
    public string Numero { get; set; } = string.Empty;
    public string Bairro { get; set; } = string.Empty;
    public string Cidade { get; set; } = string.Empty;
    public string Estado { get; set; } = string.Empty;
    public string Cep { get; set; } = string.Empty;
    public string Segmento { get; set; } = string.Empty;
    public string CorPrimaria { get; set; } = string.Empty;
    public string CorSecundaria { get; set; } = string.Empty;
    public string CorFundo { get; set; } = string.Empty;
    public string CorTexto { get; set; } = string.Empty;
    public string TipoCard { get; set; } = string.Empty;
    public string LayoutCardapio { get; set; } = string.Empty;
    public string EstiloBotao { get; set; } = string.Empty;
    public IFormFile? Logo { get; set; }
    public IFormFile? Banner { get; set; }
    public IFormFile? Capa { get; set; }
}
