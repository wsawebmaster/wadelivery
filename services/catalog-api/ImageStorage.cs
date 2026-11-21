using System.Globalization;
using System.Text;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.Formats.Webp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;
using Serilog;

namespace Catalog.Api;

public static class ImageStorage
{
    public const int ProductImageSize = 800;
    public const long MaxTenantImagePixels = 25_000_000;
    private const int MaxSlugLength = 80;

    /// <summary>
    /// Arquivos órfãos mais recentes que isso (em horas) não são apagados pelo GC.
    /// Protege uploads pendentes ou recém-criados que ainda não foram referenciados
    /// por um produto salvo (ex.: imagem escolhida no painel antes do "Salvar").
    /// </summary>
    public const int MinOrphanAgeHours = 24;

    /// <summary>
    /// Limiar de "fundo claro": pixels opacos com R, G e B acima deste valor e alcançáveis
    /// a partir da borda viram transparentes. Cobre fundos brancos, creme e cinza claro
    /// (fotos típicas de produto) de forma determinística, sem depender da IA do navegador.
    /// </summary>
    public const int LightBackgroundThreshold = 225;

    /// <summary>
    /// Decodifica a imagem, remove fundo claro/neutro (flood fill a partir das bordas),
    /// converte para um quadrado fixo <see cref="ProductImageSize"/>x<see cref="ProductImageSize"/>
    /// (ResizeMode.Pad com margens transparentes), converte para WebP lossy e grava em <c>uploads/products/</c>.
    /// O nome do arquivo é derivado do nome do produto (slug), com sufixo numérico em caso de colisão.
    /// Retorna a URL relativa (<c>/uploads/products/…</c>) ou <c>null</c> em caso de falha.
    /// </summary>
    public static async Task<string?> SaveProductImageAsync(
        Stream source,
        string uploadsRoot,
        CancellationToken ct,
        string? name = null,
        string? currentImageUrl = null,
        int size = ProductImageSize,
        int quality = 80)
    {
        try
        {
            using var image = await Image.LoadAsync(source, ct);
            using var canvas = image.CloneAs<Rgba32>();
            RemoveLightBackground(canvas);
            canvas.Mutate(x => x.Resize(new ResizeOptions
            {
                Size = new Size(size, size),
                Mode = ResizeMode.Pad,
                PadColor = Color.Transparent
            }));

            var dir = Path.Combine(uploadsRoot, "products");
            Directory.CreateDirectory(dir);

            var fileName = ResolveFileName(dir, SlugifyProductName(name), currentImageUrl);
            var path = Path.Combine(dir, fileName);

            await using var fs = File.Create(path);
            await canvas.SaveAsync(fs, new WebpEncoder
            {
                FileFormat = WebpFileFormatType.Lossy,
                Quality = quality,
                Method = WebpEncodingMethod.Default,
                UseAlphaCompression = true
            }, ct);

            return $"/uploads/products/{fileName}";
        }
        catch (Exception ex)
        {
            Log.Warning(ex, "Falha ao converter imagem de produto para WebP");
            return null;
        }
    }

    public static async Task<string> SaveTenantImageAsync(
        Stream source,
        string uploadsRoot,
        string slug,
        string kind,
        CancellationToken ct)
    {
        using var image = await Image.LoadAsync<Rgba32>(source, ct);
        if ((long)image.Width * image.Height > MaxTenantImagePixels)
            throw new InvalidDataException("A imagem excede a resolução máxima permitida.");

        var maxSize = string.Equals(kind, "logo", StringComparison.Ordinal) ? 1000 : 2000;
        image.Mutate(x => x.Resize(new ResizeOptions
        {
            Size = new Size(maxSize, maxSize),
            Mode = ResizeMode.Max
        }));

        var directory = Path.Combine(uploadsRoot, "stores", slug);
        Directory.CreateDirectory(directory);
        var fileName = $"{kind}-{Guid.NewGuid():N}.webp";
        var filePath = Path.Combine(directory, fileName);

        await using var file = new FileStream(filePath, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        await image.SaveAsync(file, new WebpEncoder { Quality = 82 }, ct);
        return $"/uploads/stores/{slug}/{fileName}";
    }

    /// <summary>
    /// Normaliza o nome do produto para uso em nome de arquivo: minúsculas, sem acentos,
    /// caracteres não alfanuméricos viram um único hífen. Ex.: "Coca-Cola 2l" → "coca-cola-2l".
    /// Retorna string vazia quando nada é aproveitável.
    /// </summary>
    public static string SlugifyProductName(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return string.Empty;

        var normalized = name.Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(normalized.Length);
        var pendingHyphen = false;

        foreach (var ch in normalized)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark) continue;

            if (char.IsLetterOrDigit(ch))
            {
                if (pendingHyphen && sb.Length > 0) sb.Append('-');
                pendingHyphen = false;
                sb.Append(char.ToLowerInvariant(ch));
            }
            else
            {
                pendingHyphen = true;
            }
        }

        var slug = sb.ToString();
        if (slug.Length > MaxSlugLength) slug = slug[..MaxSlugLength].TrimEnd('-');
        return slug;
    }

    /// <summary>
    /// Tenta apagar o arquivo de imagem referenciado por uma URL relativa de /uploads/ (best-effort).
    /// </summary>
    public static void TryDeleteUpload(string? relativeUrl, string uploadsRoot)
    {
        if (string.IsNullOrWhiteSpace(relativeUrl)) return;

        var parts = relativeUrl.Trim().Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length < 3 || !parts[0].Equals("uploads", StringComparison.OrdinalIgnoreCase)) return;
        if (parts.Any(p => p.Contains("..", StringComparison.OrdinalIgnoreCase))) return;

        var path = Path.Combine(uploadsRoot, string.Join(Path.DirectorySeparatorChar, parts.Skip(1)));
        if (File.Exists(path))
        {
            try { File.Delete(path); }
            catch (Exception ex) { Log.Warning(ex, "Falha ao remover arquivo de imagem {Path}", path); }
        }
    }

    /// <summary>
    /// Apaga arquivos em <c>uploads/products/</c> que não são referenciados pelo catálogo
    /// (imagens órfãs de uploads cancelados ou produtos excluídos). Best-effort por arquivo.
    /// Arquivos modificados recentemente (menos de <see cref="MinOrphanAgeHours"/> horas)
    /// são preservados para não destruir uploads pendentes de salvar.
    /// Retorna a quantidade de arquivos removidos.
    /// </summary>
    public static int CleanupOrphanedProductImages(IEnumerable<string?> referencedUrls, string uploadsRoot)
    {
        var referenced = (referencedUrls ?? Enumerable.Empty<string?>())
            .Where(u => !string.IsNullOrWhiteSpace(u) && u.StartsWith("/uploads/products/", StringComparison.OrdinalIgnoreCase))
            .Select(u => Path.GetFileName(u!.Trim()))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

        var dir = Path.Combine(uploadsRoot, "products");
        if (!Directory.Exists(dir)) return 0;

        var minAge = DateTime.UtcNow.AddHours(-MinOrphanAgeHours);
        var removed = 0;
        foreach (var file in Directory.EnumerateFiles(dir))
        {
            if (referenced.Contains(Path.GetFileName(file))) continue;

            try
            {
                var lastWrite = File.GetLastWriteTimeUtc(file);
                if (lastWrite > minAge) continue;
            }
            catch (Exception ex)
            {
                Log.Warning(ex, "GC: falha ao ler idade da imagem {Path}", file);
                continue;
            }

            try
            {
                File.Delete(file);
                removed++;
                Log.Information("GC de imagens: órfã removida {Path}", file);
            }
            catch (Exception ex)
            {
                Log.Warning(ex, "GC: falha ao remover imagem órfã {Path}", file);
            }
        }
        return removed;
    }

    /// <summary>
    /// Remove fundo claro/neutro opaco alcançável a partir das bordas (flood fill).
    /// Pixels já transparentes ou com cor escura não são tocados, preservando o produto
    /// e imagens que já passaram por remoção de fundo (IA/transparente).
    /// </summary>
    private static void RemoveLightBackground(Image<Rgba32> canvas, byte threshold = LightBackgroundThreshold)
    {
        var width = canvas.Width;
        var height = canvas.Height;
        var visited = new bool[width * height];
        var queue = new Queue<int>();

        bool IsBackground(int x, int y)
        {
            var p = canvas[x, y];
            return p.A >= 240 && p.R >= threshold && p.G >= threshold && p.B >= threshold;
        }

        void Seed(int x, int y)
        {
            if (x < 0 || y < 0 || x >= width || y >= height) return;
            var i = y * width + x;
            if (visited[i] || !IsBackground(x, y)) return;
            visited[i] = true;
            queue.Enqueue(i);
        }

        for (var x = 0; x < width; x++)
        {
            Seed(x, 0);
            Seed(x, height - 1);
        }
        for (var y = 1; y < height - 1; y++)
        {
            Seed(0, y);
            Seed(width - 1, y);
        }

        while (queue.Count > 0)
        {
            var i = queue.Dequeue();
            var x = i % width;
            var y = i / width;
            Seed(x - 1, y);
            Seed(x + 1, y);
            Seed(x, y - 1);
            Seed(x, y + 1);
        }

        for (var y = 0; y < height; y++)
        {
            for (var x = 0; x < width; x++)
            {
                if (visited[y * width + x])
                {
                    var p = canvas[x, y];
                    canvas[x, y] = new Rgba32(p.R, p.G, p.B, 0);
                }
            }
        }
    }

    /// <summary>
    /// Produto com imagem relativa <c>/uploads/…</c> que aponta para um arquivo inexistente em disco.
    /// Usado para sinalizar uploads perdidos (ex.: volume não persistente no deploy) em vez de
    /// deixar a imagem "sumir" em silêncio no cardápio.
    /// </summary>
    public readonly record struct ProductImageMissing(string Id, string Name, string ImageUrl);

    /// <summary>
    /// Retorna os produtos cuja URL de imagem relativa (<c>/uploads/…</c>) não tem arquivo em disco.
    /// URLs externas (https://…) são ignoradas. Best-effort por produto.
    /// </summary>
    public static IReadOnlyList<ProductImageMissing> FindMissingProductImages(
        IEnumerable<(string Id, string Name, string? ImageUrl)> references,
        string uploadsRoot)
    {
        var missing = new List<ProductImageMissing>();
        foreach (var (id, name, imageUrl) in references)
        {
            if (string.IsNullOrWhiteSpace(imageUrl)) continue;
            if (!imageUrl.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase)) continue;

            var parts = imageUrl.Trim().Split('/', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 3 || parts.Any(p => p.Contains("..", StringComparison.OrdinalIgnoreCase))) continue;

            var path = Path.Combine(uploadsRoot, string.Join(Path.DirectorySeparatorChar, parts.Skip(1)));
            if (!File.Exists(path))
                missing.Add(new ProductImageMissing(id, name, imageUrl));
        }

        return missing;
    }

    private static string ResolveFileName(string dir, string slug, string? currentImageUrl)    {
        var baseSlug = string.IsNullOrEmpty(slug) ? "product" : slug;
        var desired = $"{baseSlug}.webp";
        var currentFile = BasenameOfUpload(currentImageUrl);

        if (!File.Exists(Path.Combine(dir, desired)) || string.Equals(desired, currentFile, StringComparison.OrdinalIgnoreCase))
            return desired;

        for (var n = 2; n <= 1000; n++)
        {
            var candidate = $"{baseSlug}-{n}.webp";
            if (!File.Exists(Path.Combine(dir, candidate)) || string.Equals(candidate, currentFile, StringComparison.OrdinalIgnoreCase))
                return candidate;
        }

        return $"{baseSlug}-{Guid.NewGuid():N[..8]}.webp";
    }

    private static string? BasenameOfUpload(string? relativeUrl)
    {
        if (string.IsNullOrWhiteSpace(relativeUrl)) return null;
        return Path.GetFileName(relativeUrl.Trim());
    }
}
