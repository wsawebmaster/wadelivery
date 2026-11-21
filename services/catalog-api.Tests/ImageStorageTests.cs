using Catalog.Api;
using Microsoft.AspNetCore.Http;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Processing;

namespace Catalog.Api.Tests;

public class ImageStorageTests
{
    private static void AgeFiles(string dir)
    {
        var cutoff = DateTime.UtcNow.AddHours(-(ImageStorage.MinOrphanAgeHours + 1));
        foreach (var file in Directory.EnumerateFiles(dir))
            File.SetLastWriteTimeUtc(file, cutoff);
    }

    [Fact]
    public async Task SaveProductImageAsync_converts_to_standard_square()
    {
        using var image = new Image<Rgba32>(2400, 1200);
        image.Mutate(x => x.BackgroundColor(Color.CornflowerBlue));
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None);

            Assert.NotNull(url);
            Assert.StartsWith("/uploads/products/", url);
            Assert.EndsWith(".webp", url);

            var fileName = Path.Combine(tempRoot, "products", Path.GetFileName(url));
            Assert.True(File.Exists(fileName));

            using var saved = Image.Load(fileName);
            Assert.Equal(ImageStorage.ProductImageSize, saved.Width);
            Assert.Equal(ImageStorage.ProductImageSize, saved.Height);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task SaveProductImageAsync_resizes_small_images_to_standard_square()
    {
        using var image = new Image<Rgba32>(300, 150);
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None);

            Assert.NotNull(url);
            var fileName = Path.Combine(tempRoot, "products", Path.GetFileName(url));
            using var saved = Image.Load(fileName);
            Assert.Equal(ImageStorage.ProductImageSize, saved.Width);
            Assert.Equal(ImageStorage.ProductImageSize, saved.Height);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void TryDeleteUpload_removes_file_for_uploads_url()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var dir = Path.Combine(tempRoot, "products");
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, "old.webp");
            File.WriteAllBytes(file, new byte[] { 1, 2, 3 });

            ImageStorage.TryDeleteUpload("/uploads/products/old.webp", tempRoot);

            Assert.False(File.Exists(file));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void TryDeleteUpload_ignores_external_urls_and_traversal()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            Directory.CreateDirectory(tempRoot);
            var outside = Path.Combine(tempRoot, "secret.txt");
            File.WriteAllBytes(outside, new byte[] { 9 });

            ImageStorage.TryDeleteUpload("https://example.com/avatar.png", tempRoot);
            ImageStorage.TryDeleteUpload("", tempRoot);
            ImageStorage.TryDeleteUpload("../secret.txt", tempRoot);
            ImageStorage.TryDeleteUpload("/uploads/../secret.txt", tempRoot);

            Assert.True(File.Exists(outside));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task SaveProductImageAsync_preserves_alpha_channel()
    {
        using var image = new Image<Rgba32>(120, 120);
        for (var y = 0; y < image.Height; y++)
        {
            for (var x = 0; x < image.Width; x++)
            {
                image[x, y] = new Rgba32(255, 0, 0, 128);
            }
        }
        for (var y = 30; y < 90; y++)
        {
            for (var x = 30; x < 90; x++)
            {
                image[x, y] = Color.White;
            }
        }
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None);

            Assert.NotNull(url);
            var fileName = Path.Combine(tempRoot, "products", Path.GetFileName(url));
            using var saved = Image.Load(fileName);
            using var rgba = saved.CloneAs<Rgba32>();
            Assert.True(rgba[ImageStorage.ProductImageSize / 2, ImageStorage.ProductImageSize / 2].A >= 250, "Centro deve ficar opaco (a=255).");
            Assert.True(rgba[5, 5].A < 200, "Borda deve manter transparência parcial.");
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task SaveProductImageAsync_removes_light_background()
    {
        using var image = new Image<Rgba32>(200, 200);
        image.Mutate(x => x.BackgroundColor(Color.White));
        for (var y = 50; y < 150; y++)
        {
            for (var x = 50; x < 150; x++)
            {
                image[x, y] = new Rgba32(220, 30, 40);
            }
        }
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None);

            Assert.NotNull(url);
            var fileName = Path.Combine(tempRoot, "products", Path.GetFileName(url));
            using var saved = Image.Load(fileName);
            using var rgba = saved.CloneAs<Rgba32>();
            Assert.True(rgba[5, 5].A < 40, "Fundo branco na borda deve virar transparente.");
            var center = rgba[ImageStorage.ProductImageSize / 2, ImageStorage.ProductImageSize / 2];
            Assert.True(center.A >= 250, "Centro (produto) deve permanecer opaco.");
            Assert.True(center.R > center.B, "Centro deve manter a cor do produto.");
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task SaveProductImageAsync_keeps_dark_background()
    {
        using var image = new Image<Rgba32>(200, 200);
        image.Mutate(x => x.BackgroundColor(new Rgba32(20, 20, 120)));
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None);

            Assert.NotNull(url);
            var fileName = Path.Combine(tempRoot, "products", Path.GetFileName(url));
            using var saved = Image.Load(fileName);
            using var rgba = saved.CloneAs<Rgba32>();
            Assert.True(rgba[5, 5].A >= 250, "Fundo escuro não deve ser removido.");
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task SaveProductImageAsync_keeps_existing_transparent_border()
    {
        using var image = new Image<Rgba32>(200, 200);
        image.Mutate(x => x.BackgroundColor(Color.White));
        for (var y = 0; y < 30; y++)
        {
            for (var x = 0; x < 200; x++)
            {
                image[x, y] = new Rgba32(255, 255, 255, 0);
                image[x, y + 170] = new Rgba32(255, 255, 255, 0);
            }
        }
        for (var y = 30; y < 170; y++)
        {
            image[0, y] = new Rgba32(255, 255, 255, 0);
            image[199, y] = new Rgba32(255, 255, 255, 0);
        }
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None);

            Assert.NotNull(url);
            var fileName = Path.Combine(tempRoot, "products", Path.GetFileName(url));
            using var saved = Image.Load(fileName);
            using var rgba = saved.CloneAs<Rgba32>();
            Assert.True(rgba[5, 5].A < 40, "Borda já transparente deve continuar transparente.");
            Assert.True(rgba[ImageStorage.ProductImageSize / 2, ImageStorage.ProductImageSize / 2].A >= 250, "Centro branco opaco isolado por borda transparente não deve ser removido.");
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void SlugifyProductName_normalizes_and_collapses_separators()
    {
        Assert.Equal("coca-cola-2l", ImageStorage.SlugifyProductName("Coca-Cola 2l"));
        Assert.Equal("cafe-x-burger-2l", ImageStorage.SlugifyProductName("Café X-Burger 2l"));
        Assert.Equal("x-burger", ImageStorage.SlugifyProductName("  X   Burger  "));
        Assert.Equal("", ImageStorage.SlugifyProductName("!!!"));
        Assert.Equal("", ImageStorage.SlugifyProductName("  "));
        Assert.Equal("", ImageStorage.SlugifyProductName(null));
    }

    [Fact]
    public async Task SaveProductImageAsync_names_file_from_product_slug()
    {
        using var image = new Image<Rgba32>(400, 400);
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None, "Coca-Cola 2l");

            Assert.NotNull(url);
            Assert.EndsWith("/coca-cola-2l.webp", url);
            Assert.True(File.Exists(Path.Combine(tempRoot, "products", "coca-cola-2l.webp")));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task SaveProductImageAsync_falls_back_to_product_when_name_is_empty()
    {
        using var image = new Image<Rgba32>(400, 400);
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None, "   ");

            Assert.NotNull(url);
            Assert.EndsWith("/product.webp", url);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task SaveProductImageAsync_uses_suffix_when_file_exists_for_other_product()
    {
        using var image = new Image<Rgba32>(400, 400);
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var dir = Path.Combine(tempRoot, "products");
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(Path.Combine(dir, "x-burger.webp"), new byte[] { 1, 2, 3 });

            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None, "X Burger");

            Assert.NotNull(url);
            Assert.EndsWith("/x-burger-2.webp", url);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public async Task SaveProductImageAsync_overwrites_file_for_same_product()
    {
        using var image = new Image<Rgba32>(400, 400);
        using var ms = new MemoryStream();
        await image.SaveAsPngAsync(ms);

        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var dir = Path.Combine(tempRoot, "products");
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(Path.Combine(dir, "x-burger.webp"), new byte[] { 1, 2, 3 });

            ms.Position = 0;
            var url = await ImageStorage.SaveProductImageAsync(ms, tempRoot, CancellationToken.None, "X Burger", "/uploads/products/x-burger.webp");

            Assert.NotNull(url);
            Assert.EndsWith("/x-burger.webp", url);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void CleanupOrphanedProductImages_removes_only_orphans()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var dir = Path.Combine(tempRoot, "products");
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(Path.Combine(dir, "a.webp"), new byte[] { 1 });
            File.WriteAllBytes(Path.Combine(dir, "b.webp"), new byte[] { 2 });
            File.WriteAllBytes(Path.Combine(dir, "c.webp"), new byte[] { 3 });
            AgeFiles(dir);

            var referenced = new[] { "/uploads/products/a.webp", "/uploads/products/c.webp" };
            var removed = ImageStorage.CleanupOrphanedProductImages(referenced, tempRoot);

            Assert.Equal(1, removed);
            Assert.True(File.Exists(Path.Combine(dir, "a.webp")));
            Assert.False(File.Exists(Path.Combine(dir, "b.webp")));
            Assert.True(File.Exists(Path.Combine(dir, "c.webp")));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void CleanupOrphanedProductImages_keeps_recent_orphans()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var dir = Path.Combine(tempRoot, "products");
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(Path.Combine(dir, "recente.webp"), new byte[] { 1 });

            var removed = ImageStorage.CleanupOrphanedProductImages(Array.Empty<string?>(), tempRoot);

            Assert.Equal(0, removed);
            Assert.True(File.Exists(Path.Combine(dir, "recente.webp")));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void CleanupOrphanedProductImages_ignores_urls_outside_product_uploads()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var dir = Path.Combine(tempRoot, "products");
            Directory.CreateDirectory(dir);
            File.WriteAllBytes(Path.Combine(dir, "a.webp"), new byte[] { 1 });
            AgeFiles(dir);

            var referenced = new[] { "a.webp", "https://example.com/a.webp", "/uploads/icon.png", "" };
            var removed = ImageStorage.CleanupOrphanedProductImages(referenced, tempRoot);

            Assert.Equal(1, removed);
            Assert.False(File.Exists(Path.Combine(dir, "a.webp")));
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Fact]
    public void CleanupOrphanedProductImages_missing_directory_returns_zero()
    {
        var tempRoot = Path.Combine(Path.GetTempPath(), "catalog-tests", Guid.NewGuid().ToString("N"));
        try
        {
            var removed = ImageStorage.CleanupOrphanedProductImages(Array.Empty<string?>(), tempRoot);
            Assert.Equal(0, removed);
        }
        finally
        {
            if (Directory.Exists(tempRoot)) Directory.Delete(tempRoot, recursive: true);
        }
    }

    [Theory]
    [InlineData("file.png")]
    [InlineData("file.jpg")]
    [InlineData("file.jpeg")]
    [InlineData("file.webp")]
    public void ValidateProductImage_accepts_common_formats(string name)
    {
        var file = MakeFormFile(name);
        Assert.Null(CatalogInputValidation.ValidateProductImage(file));
    }

    [Fact]
    public void ValidateProductImage_accepts_files_without_extension_when_content_is_valid_image()
    {
        Assert.Null(CatalogInputValidation.ValidateProductImage(MakeContentFile("blob", PngBytes())));
        Assert.Null(CatalogInputValidation.ValidateProductImage(MakeContentFile("blob", JpegBytes())));
        Assert.Null(CatalogInputValidation.ValidateProductImage(MakeContentFile("blob", WebpBytes())));
    }

    [Theory]
    [InlineData("file.ico")]
    [InlineData("file.svg")]
    [InlineData("file.gif")]
    [InlineData("file.txt")]
    public void ValidateProductImage_rejects_non_product_formats(string name)
    {
        var file = MakeContentFile(name, NonImageBytes(name));
        Assert.NotNull(CatalogInputValidation.ValidateProductImage(file));
    }

    [Fact]
    public void ValidateProductImage_rejects_file_without_extension_when_content_is_not_image()
    {
        var file = MakeContentFile("blob", System.Text.Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"));
        Assert.NotNull(CatalogInputValidation.ValidateProductImage(file));
    }

    private static FormFile MakeFormFile(string name)
    {
        return MakeContentFile(name, PngBytes());
    }

    private static FormFile MakeContentFile(string name, byte[] content)
    {
        var ms = new MemoryStream(content);
        return new FormFile(ms, 0, ms.Length, "file", name);
    }

    private static byte[] PngBytes()
    {
        using var image = new Image<Rgba32>(100, 100);
        using var ms = new MemoryStream();
        image.SaveAsPng(ms);
        return ms.ToArray();
    }

    private static byte[] JpegBytes()
    {
        using var image = new Image<Rgba32>(100, 100);
        using var ms = new MemoryStream();
        image.SaveAsJpeg(ms);
        return ms.ToArray();
    }

    private static byte[] WebpBytes()
    {
        using var image = new Image<Rgba32>(100, 100);
        using var ms = new MemoryStream();
        image.SaveAsWebp(ms);
        return ms.ToArray();
    }

    private static byte[] NonImageBytes(string name)
    {
        if (name.EndsWith(".svg", StringComparison.OrdinalIgnoreCase))
            return System.Text.Encoding.UTF8.GetBytes("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>");
        if (name.EndsWith(".gif", StringComparison.OrdinalIgnoreCase))
            return System.Text.Encoding.UTF8.GetBytes("GIF89a");
        if (name.EndsWith(".ico", StringComparison.OrdinalIgnoreCase))
            return new byte[] { 0x00, 0x00, 0x01, 0x00, 0x01, 0x00 };
        return System.Text.Encoding.UTF8.GetBytes("not an image");
    }
}
