namespace Catalog.Api.Models;

public sealed class CriarLojaRequest
{
    public string? Nome { get; set; } = string.Empty;
    public string? Slug { get; set; } = string.Empty;
    /// <summary>PF ou PJ. Default PJ para compatibilidade.</summary>
    public string? TipoPessoa { get; set; } = "PJ";
    /// <summary>Documento principal (CPF ou CNPJ). Aceita `Cnpj` como alias legado.</summary>
    public string? Documento { get; set; } = string.Empty;
    public string? Cnpj { get; set; } = string.Empty;
    public string? Telefone { get; set; } = string.Empty;
    public string? Email { get; set; } = string.Empty;
    public string? Endereco { get; set; } = string.Empty;
    public string? Numero { get; set; } = string.Empty;
    public string? Bairro { get; set; } = string.Empty;
    public string? Cidade { get; set; } = string.Empty;
    public string? Estado { get; set; } = string.Empty;
    public string? Cep { get; set; } = string.Empty;
    public string? Segmento { get; set; } = string.Empty;
    public string? CorPrimaria { get; set; } = string.Empty;
    public string? CorSecundaria { get; set; } = string.Empty;
    public string? CorFundo { get; set; } = string.Empty;
    public string? CorTexto { get; set; } = string.Empty;
    public string? TipoCard { get; set; } = string.Empty;
    public string? LayoutCardapio { get; set; } = string.Empty;
    public string? EstiloBotao { get; set; } = string.Empty;
    /// <summary>Chave Pix para receber pagamentos (opcional; pode ser cadastrada depois no painel).</summary>
    public string? ChavePix { get; set; }
    /// <summary>Tipo da chave Pix (nomes oficiais): CPF, CNPJ, E-mail, Celular ou Chave aleatória. Aceita também Telefone/Aleatória.</summary>
    public string? TipoChavePix { get; set; }
    /// <summary>Cobrança da entrega: "fixa" (valor único dentro do raio) ou "km" (distância × taxa/km).</summary>
    public string? TipoEntrega { get; set; } = string.Empty;
    // Valores monetários/distâncias chegam como texto do multipart e são lidos com
    // cultura invariante (aceita "5.50" ou "5,50"), independente da cultura do servidor.
    public string? TaxaEntregaFixa { get; set; }
    public string? TaxaPorKm { get; set; }
    public string? TaxaMinima { get; set; }
    public string? DistanciaMaximaKm { get; set; }
    /// <summary>Cadastro rápido: dados mínimos para testar a loja. Campos fiscais/endereço completo/visual podem ser preenchidos depois.</summary>
    public bool ModoRapido { get; set; }
    /// <summary>Token de verificação anti-bot (Turnstile/hCaptcha/reCAPTCHA), validado no backend quando Captcha:Enabled=true.</summary>
    public string? CaptchaToken { get; set; } = string.Empty;
    public IFormFile? Logo { get; set; }
    public IFormFile? Banner { get; set; }
    public IFormFile? Capa { get; set; }
}
