namespace Catalog.Api.Services;

/// <summary>Paleta do cardápio (cores aplicadas pelo storefront como variáveis --tenant-*).</summary>
public sealed record SegmentPalette(string Segment, string Name, string CorPrimaria, string CorSecundaria, string CorFundo, string CorTexto);

/// <summary>
/// Cores padrão da loja conforme o segmento. Usadas ao criar a loja e pelo botão
/// "Usar cores do segmento" do painel; o proprietário pode personalizar depois
/// (cores, logo e marca) em Loja → Aparência / Geral.
/// Fonte única: o cadastro e o painel leem daqui via GET /api/v1/segment-palettes.
/// </summary>
public static class SegmentPalettes
{
    public static readonly SegmentPalette Default =
        new("padrao", "Azul clássico", "#1f6feb", "#ffffff", "#f3f4f6", "#2c3e50");

    public static readonly IReadOnlyList<SegmentPalette> All =
    [
        new("lanchonete", "Laranja lanchonete", "#ea580c", "#ffffff", "#fff7ed", "#431407"),
        new("hamburgueria", "Brasa e queijo", "#dc2626", "#ffffff", "#fef3c7", "#1c1917"),
        new("pizzaria", "Forno italiano", "#b91c1c", "#fffdf7", "#fdf6e3", "#3f1d0b"),
        new("marmitaria", "Comida caseira", "#15803d", "#ffffff", "#f0fdf4", "#14532d"),
        new("assai", "Roxo açaí", "#7e22ce", "#ffffff", "#faf5ff", "#3b0764"),
    ];

    public static SegmentPalette For(string? segment)
    {
        var key = (segment ?? "").Trim().ToLowerInvariant();
        return All.FirstOrDefault(p => p.Segment == key) ?? Default;
    }
}
