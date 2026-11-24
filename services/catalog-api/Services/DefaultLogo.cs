using System.Globalization;
using System.Security;
using System.Text;

namespace Catalog.Api.Services;

/// <summary>
/// Logo padrão da loja recém-criada: monograma (iniciais) sobre gradiente da paleta do
/// segmento, em SVG. O arquivo leva o prefixo "logo-padrao-" para o painel saber que o
/// lojista ainda não enviou o logo próprio.
/// </summary>
public static class DefaultLogo
{
    public const string FilePrefix = "logo-padrao-";

    private static readonly HashSet<string> StopWords =
        new(["de", "da", "do", "das", "dos", "e", "a", "o", "the", "&"], StringComparer.OrdinalIgnoreCase);

    public static string Initials(string? name)
    {
        var words = (name ?? "")
            .Split([' ', '-', '_', '.', '/'], StringSplitOptions.RemoveEmptyEntries)
            .Where(w => !StopWords.Contains(w))
            .Select(w => w.FirstOrDefault(char.IsLetterOrDigit))
            .Where(c => c != default)
            .Take(2)
            .ToArray();
        return words.Length == 0 ? "W" : new string(words).ToUpper(CultureInfo.GetCultureInfo("pt-BR"));
    }

    public static string BuildSvg(string? storeName, string primaryHex)
    {
        var primary = NormalizeHex(primaryHex) ?? "#1f6feb";
        var dark = Shade(primary, 0.45);
        var light = Shade(primary, -0.18);
        var initials = SecurityElement.Escape(Initials(storeName));
        var fontSize = initials.Length > 1 ? 196 : 240;

        var sb = new StringBuilder();
        sb.Append("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"512\" height=\"512\" viewBox=\"0 0 512 512\" role=\"img\"");
        sb.Append(" aria-label=\"").Append(SecurityElement.Escape(storeName ?? "Loja")).Append("\">");
        sb.Append("<defs>");
        sb.Append("<linearGradient id=\"g\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\">");
        sb.Append("<stop offset=\"0\" stop-color=\"").Append(light).Append("\"/>");
        sb.Append("<stop offset=\"1\" stop-color=\"").Append(dark).Append("\"/>");
        sb.Append("</linearGradient>");
        sb.Append("<radialGradient id=\"s\" cx=\"0.3\" cy=\"0.2\" r=\"0.8\">");
        sb.Append("<stop offset=\"0\" stop-color=\"#fff\" stop-opacity=\"0.35\"/>");
        sb.Append("<stop offset=\"1\" stop-color=\"#fff\" stop-opacity=\"0\"/>");
        sb.Append("</radialGradient>");
        sb.Append("</defs>");
        sb.Append("<rect width=\"512\" height=\"512\" rx=\"128\" fill=\"url(#g)\"/>");
        sb.Append("<rect width=\"512\" height=\"512\" rx=\"128\" fill=\"url(#s)\"/>");
        sb.Append("<circle cx=\"256\" cy=\"256\" r=\"178\" fill=\"none\" stroke=\"#fff\" stroke-opacity=\"0.28\" stroke-width=\"10\"/>");
        sb.Append("<circle cx=\"256\" cy=\"256\" r=\"206\" fill=\"none\" stroke=\"#fff\" stroke-opacity=\"0.12\" stroke-width=\"4\" stroke-dasharray=\"6 14\"/>");
        sb.Append("<text x=\"256\" y=\"256\" dy=\"0.35em\" text-anchor=\"middle\" fill=\"#fff\"");
        sb.Append(" font-family=\"'Poppins','Montserrat','Segoe UI',Roboto,Arial,sans-serif\" font-weight=\"800\"");
        sb.Append(" font-size=\"").Append(fontSize).Append("\" letter-spacing=\"-6\">").Append(initials).Append("</text>");
        sb.Append("</svg>");
        return sb.ToString();
    }

    /// <summary>Grava o SVG em uploads/stores/{slug}/ e devolve a URL relativa.</summary>
    public static async Task<string> SaveAsync(string uploadsRoot, string slug, string? storeName, string primaryHex, CancellationToken ct)
    {
        var directory = Path.Combine(uploadsRoot, "stores", slug);
        Directory.CreateDirectory(directory);
        var fileName = $"{FilePrefix}{Guid.NewGuid():N}.svg";
        await File.WriteAllTextAsync(Path.Combine(directory, fileName), BuildSvg(storeName, primaryHex), new UTF8Encoding(false), ct);
        return $"/uploads/stores/{slug}/{fileName}";
    }

    private static string? NormalizeHex(string? hex)
    {
        var h = (hex ?? "").Trim().TrimStart('#');
        if (h.Length == 3) h = string.Concat(h.Select(c => $"{c}{c}"));
        return h.Length == 6 && h.All(Uri.IsHexDigit) ? "#" + h.ToLowerInvariant() : null;
    }

    /// <summary>amount &gt; 0 escurece (mistura com preto); &lt; 0 clareia (mistura com branco).</summary>
    private static string Shade(string hex, double amount)
    {
        var r = Convert.ToInt32(hex.Substring(1, 2), 16);
        var g = Convert.ToInt32(hex.Substring(3, 2), 16);
        var b = Convert.ToInt32(hex.Substring(5, 2), 16);
        int Mix(int c) => amount >= 0
            ? (int)Math.Round(c * (1 - amount))
            : (int)Math.Round(c + (255 - c) * -amount);
        return $"#{Mix(r):x2}{Mix(g):x2}{Mix(b):x2}";
    }
}
