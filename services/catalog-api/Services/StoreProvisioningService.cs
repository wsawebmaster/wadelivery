using System.Net.Mail;
using System.Security.Cryptography;
using System.Text.RegularExpressions;
using Catalog.Api.Data;
using Catalog.Api.Models;
using Catalog.Api.MultiTenancy;
using Catalog.Api.Repositories;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Npgsql;

namespace Catalog.Api.Services;

public sealed class StoreProvisioningService(
    IServiceProvider services,
    IConfiguration configuration,
    TenantContext tenant,
    CatalogCacheInvalidator cache,
    IWebHostEnvironment environment)
{
    private const long MaxImageBytes = 5 * 1024 * 1024;
    private static readonly HashSet<string> AllowedSegments =
        new(["lanchonete", "hamburgueria", "pizzaria", "marmitaria"], StringComparer.Ordinal);
    private static readonly HashSet<string> AllowedCardTypes =
        new(["foto-grande", "lista-horizontal", "compacto"], StringComparer.Ordinal);
    private static readonly HashSet<string> AllowedLayouts =
        new(["grade", "lista", "com-foto", "sem-foto"], StringComparer.Ordinal);
    private static readonly HashSet<string> AllowedButtonStyles =
        new(["arredondado", "quadrado", "pilula"], StringComparer.Ordinal);
    private static readonly Regex HexColor = new("^#[0-9a-fA-F]{6}$", RegexOptions.Compiled);

    public static string? Validate(CriarLojaRequest? request)
    {
        if (request is null)
            return "Dados da loja não informados.";
        if (string.IsNullOrWhiteSpace(request.Nome) || request.Nome.Trim().Length is < 2 or > 120)
            return "Informe um nome de loja entre 2 e 120 caracteres.";
        if (!CatalogInputValidation.IsValidTenantSlug(request.Slug))
            return "Slug inválido ou reservado. Use 3 a 80 caracteres minúsculos, números e hífen.";
        if (!CatalogInputValidation.IsValidCnpj(request.Cnpj))
            return "CNPJ inválido.";
        var phone = CatalogInputValidation.DigitsOnly(request.Telefone);
        if (phone.Length is < 10 or > 15)
            return "Telefone/WhatsApp inválido.";
        var email = request.Email?.Trim() ?? "";
        if (email.Length is < 5 or > 64 || !MailAddress.TryCreate(email, out _))
            return "Informe um e-mail válido com até 64 caracteres para o primeiro acesso.";
        if (string.IsNullOrWhiteSpace(request.Endereco) || request.Endereco.Trim().Length > 200)
            return "Informe o endereço da loja (máx. 200 caracteres).";
        if (string.IsNullOrWhiteSpace(request.Numero) || request.Numero.Trim().Length > 32)
            return "Informe o número do endereço (máx. 32 caracteres).";
        if ((request.Bairro?.Trim().Length ?? 0) > 120)
            return "Bairro muito longo (máx. 120 caracteres).";
        if (string.IsNullOrWhiteSpace(request.Cidade) || request.Cidade.Trim().Length > 120)
            return "Informe uma cidade válida.";
        var state = request.Estado?.Trim() ?? "";
        if (state.Length != 2 || !state.All(char.IsAsciiLetter))
            return "Informe a UF com duas letras.";
        if (CatalogInputValidation.DigitsOnly(request.Cep).Length != 8)
            return "CEP inválido.";
        if (!AllowedSegments.Contains(request.Segmento))
            return "Segmento inválido.";
        if (!IsColor(request.CorPrimaria) || !IsColor(request.CorSecundaria)
            || !IsColor(request.CorFundo) || !IsColor(request.CorTexto))
            return "Uma ou mais cores estão em formato inválido.";
        if (!AllowedCardTypes.Contains(request.TipoCard))
            return "Tipo de card inválido.";
        if (!AllowedLayouts.Contains(request.LayoutCardapio))
            return "Layout de cardápio inválido.";
        if (!AllowedButtonStyles.Contains(request.EstiloBotao))
            return "Estilo de botão inválido.";

        return ValidateImage(request.Logo, "logo")
            ?? ValidateImage(request.Banner, "banner")
            ?? ValidateImage(request.Capa, "capa");
    }

    public async Task<CreateCompleteStoreResult> CreateAsync(
        CriarLojaRequest request,
        CancellationToken ct)
    {
        var db = services.GetService<CatalogDbContext>()
            ?? throw new InvalidOperationException("Persistência PostgreSQL não está configurada.");
        var slug = request.Slug.Trim();
        var now = DateTime.UtcNow;
        var uploadedFiles = new List<string>();
        var uploadsRoot = ResolveUploadsRoot();

        try
        {
            var logoUrl = await SaveImageAsync(request.Logo, "logo");
            var bannerUrl = await SaveImageAsync(request.Banner, "banner");
            var coverUrl = await SaveImageAsync(request.Capa, "capa");
            var temporaryPassword = GenerateTemporaryPassword();
            var username = request.Email.Trim().ToLowerInvariant();
            var publicBaseUrl = (configuration["PublicApp:BaseUrl"] ?? "https://wadelivery.com.br").TrimEnd('/');
            var publicUrl = $"{publicBaseUrl}/{slug}";

            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await db.Database.ExecuteSqlRawAsync("SET LOCAL row_security = off", ct);

            if (await db.Stores.AsNoTracking().AnyAsync(store => store.Slug == slug, ct))
                throw new StoreProvisioningConflictException("Este slug já está em uso. Escolha outro.");
            if (await db.AdminUsers.AsNoTracking()
                    .AnyAsync(user => user.Username.ToLower() == username, ct))
                throw new StoreProvisioningConflictException("Já existe uma conta com este e-mail.");

            var store = new Loja
            {
                Nome = request.Nome.Trim(),
                Slug = slug,
                Cnpj = CatalogInputValidation.DigitsOnly(request.Cnpj),
                Telefone = CatalogInputValidation.DigitsOnly(request.Telefone),
                Email = username,
                Endereco = BuildAddress(request),
                AddressNumber = request.Numero.Trim(),
                Cep = CatalogInputValidation.DigitsOnly(request.Cep),
                City = request.Cidade.Trim(),
                State = request.Estado.Trim().ToUpperInvariant(),
                LogoUrl = logoUrl,
                BannerUrl = bannerUrl,
                CoverUrl = coverUrl,
                CorPrimaria = request.CorPrimaria,
                CorSecundaria = request.CorSecundaria,
                CorFundo = request.CorFundo,
                CorTexto = request.CorTexto,
                TipoCard = request.TipoCard,
                LayoutCardapio = request.LayoutCardapio,
                EstiloBotao = request.EstiloBotao,
                IsTeste = true,
                DataCriacao = now,
                DataAtualizacao = now,
                PixKey = string.Empty,
                PixKeyLabel = "Chave PIX não configurada",
                CurrencyLocale = "pt-BR",
                ScheduleJson = """{"days":[0,1,2,3,4,5,6],"open":"10:00","close":"22:00","closedMessage":"Fechado."}""",
                DeliveryFeesJson = "{}",
                AcceptingOrders = true,
                DineInEnabled = true,
                CustomerQrOrdersEnabled = true,
                WaiterOrdersEnabled = true,
                AllowManualTableEntry = true,
                TableCount = 5,
                WaiterSessionHours = 8
            };
            db.Stores.Add(store);
            await db.SaveChangesAsync(ct);
            tenant.SetStoreId(store.Id);

            var categories = new[]
            {
                new CategoryEntity { Id = Guid.NewGuid().ToString("N"), StoreId = store.Id, Title = "Lanches", SortOrder = 1 },
                new CategoryEntity { Id = Guid.NewGuid().ToString("N"), StoreId = store.Id, Title = "Bebidas", SortOrder = 2 },
                new CategoryEntity { Id = Guid.NewGuid().ToString("N"), StoreId = store.Id, Title = "Porções", SortOrder = 3 }
            };
            db.Categories.AddRange(categories);
            db.Products.Add(new ProductEntity
            {
                Id = Guid.NewGuid().ToString("N"),
                StoreId = store.Id,
                CategoryId = categories[0].Id,
                Name = "Produto de exemplo",
                Description = "Edite este produto no painel para cadastrar seu cardápio.",
                Price = 19.90m,
                Available = true,
                ShowInMenu = true,
                SortOrder = 1
            });
            db.AdminUsers.Add(new AdminUserEntity
            {
                StoreId = store.Id,
                Username = username,
                PasswordHash = BCrypt.Net.BCrypt.HashPassword(temporaryPassword),
                Role = "AdminLoja",
                DisplayName = request.Nome.Trim()
            });
            db.PlatformStores.Add(new PlatformStoreEntity
            {
                Id = Guid.NewGuid(),
                Name = request.Nome.Trim(),
                StoreId = store.Id,
                FrontUrl = publicUrl,
                AdminUrl = $"{publicBaseUrl}/admin/legado",
                LocalFrontUrl = $"http://localhost:3000/{slug}",
                LocalAdminUrl = "http://localhost:3000/admin/legado",
                MonthlyFee = 0,
                Courtesy = true,
                PaymentStatus = "courtesy",
                PaymentsJson = "[]",
                Active = true,
                CreatedAt = now,
                UpdatedAt = now,
                Cnpj = store.Cnpj,
                ContactName = request.Nome.Trim(),
                Phone = store.Telefone,
                Email = username,
                Address = store.Endereco,
                AddressNumber = store.AddressNumber,
                Cep = store.Cep,
                City = store.City,
                State = store.State,
                LogoUrl = logoUrl,
                Status = "active",
                Plan = "teste",
                Segment = request.Segmento,
                GalleryJson = "[]"
            });

            await EnsureTablesSchemaAsync(db, ct);
            for (var tableNumber = 1; tableNumber <= 5; tableNumber++)
            {
                var label = $"Mesa {tableNumber}";
                var accessCode = $"{slug}-mesa-{tableNumber}";
                await db.Database.ExecuteSqlInterpolatedAsync($"""
                    INSERT INTO store_tables
                        ("StoreId", "Label", "AccessCode", "Active", "AllowCustomerOrder", "Capacity", "CreatedAtUtc")
                    VALUES
                        ({store.Id}, {label}, {accessCode}, TRUE, TRUE, 4, {now})
                    """, ct);
            }

            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            cache.InvalidateStore(store.Id);
            cache.InvalidateSlug(slug);
            cache.InvalidateGlobal();

            return new CreateCompleteStoreResult(
                store.Id,
                slug,
                publicUrl,
                $"{publicBaseUrl}/admin/legado",
                username,
                temporaryPassword,
                now);
        }
        catch (DbUpdateException ex)
        {
            DeleteUploadedFiles();
            if (TryGetUniqueConstraint(ex, out var constraint))
            {
                if (constraint.Contains("stores_Slug", StringComparison.OrdinalIgnoreCase))
                    throw new StoreProvisioningConflictException("Este slug já está em uso. Escolha outro.", ex);
                if (constraint.Contains("admin_users", StringComparison.OrdinalIgnoreCase))
                    throw new StoreProvisioningConflictException("Já existe uma conta com este e-mail.", ex);
            }
            throw;
        }
        catch
        {
            DeleteUploadedFiles();
            throw;
        }

        void DeleteUploadedFiles()
        {
            foreach (var file in uploadedFiles)
                ImageStorage.TryDeleteUpload(file, uploadsRoot);
        }

        async Task<string?> SaveImageAsync(IFormFile? file, string kind)
        {
            if (file is null) return null;
            await using var stream = file.OpenReadStream();
            var url = await ImageStorage.SaveTenantImageAsync(stream, uploadsRoot, slug, kind, ct);
            uploadedFiles.Add(url);
            return url;
        }
    }

    private static string? ValidateImage(IFormFile? file, string label)
    {
        if (file is null) return null;
        if (file.Length is <= 0 or > MaxImageBytes)
            return $"O arquivo de {label} deve ter até 5 MB.";
        var extension = Path.GetExtension(file.FileName);
        if (!new[] { ".png", ".jpg", ".jpeg", ".webp" }.Contains(extension, StringComparer.OrdinalIgnoreCase)
            || !new[] { "image/png", "image/jpeg", "image/webp" }.Contains(file.ContentType, StringComparer.OrdinalIgnoreCase))
            return $"Formato de {label} inválido. Use PNG, JPG ou WebP.";
        return null;
    }

    private static bool IsColor(string? color) => color is not null && HexColor.IsMatch(color);

    private static string BuildAddress(CriarLojaRequest request)
    {
        var neighborhood = string.IsNullOrWhiteSpace(request.Bairro) ? "" : $" - {request.Bairro.Trim()}";
        return $"{request.Endereco.Trim()}, {request.Numero.Trim()}{neighborhood}, {request.Cidade.Trim()}/{request.Estado.Trim().ToUpperInvariant()}";
    }

    private string ResolveUploadsRoot()
    {
        var configured = configuration["Data:UploadsRoot"];
        return string.IsNullOrWhiteSpace(configured)
            ? Path.Combine(environment.ContentRootPath, "wwwroot", "uploads")
            : Path.GetFullPath(Path.IsPathRooted(configured)
                ? configured
                : Path.Combine(environment.ContentRootPath, configured));
    }

    private static string GenerateTemporaryPassword()
    {
        return Convert.ToBase64String(RandomNumberGenerator.GetBytes(18))
            .TrimEnd('=')
            .Replace('+', '-')
            .Replace('/', '_');
    }

    private static async Task EnsureTablesSchemaAsync(CatalogDbContext db, CancellationToken ct)
    {
        await db.Database.ExecuteSqlRawAsync("""
            CREATE TABLE IF NOT EXISTS store_tables (
                "Id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
                "StoreId" integer NOT NULL DEFAULT 1,
                "Label" character varying(100) NOT NULL,
                "AccessCode" character varying(64) NOT NULL,
                "Active" boolean NOT NULL DEFAULT TRUE,
                "AllowCustomerOrder" boolean NOT NULL DEFAULT TRUE,
                "Capacity" integer NULL,
                "CreatedAtUtc" timestamp with time zone NOT NULL DEFAULT (now() at time zone 'utc'),
                "ClosedAtUtc" timestamp with time zone NULL,
                "ResponsibleName" character varying(120) NULL,
                "GuestCount" integer NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS "IX_store_tables_StoreId_AccessCode"
                ON store_tables ("StoreId", "AccessCode");
            ALTER TABLE store_tables ENABLE ROW LEVEL SECURITY;
            ALTER TABLE store_tables FORCE ROW LEVEL SECURITY;
            DROP POLICY IF EXISTS p_store_tables_tenant ON store_tables;
            CREATE POLICY p_store_tables_tenant ON store_tables
                FOR ALL
                USING ("StoreId" = current_setting('app.current_store_id', true)::int)
                WITH CHECK ("StoreId" = current_setting('app.current_store_id', true)::int);
            """, ct);
    }

    private static bool TryGetUniqueConstraint(Exception exception, out string constraint)
    {
        for (Exception? current = exception; current is not null; current = current.InnerException)
        {
            if (current is PostgresException { SqlState: "23505" } postgres)
            {
                constraint = postgres.ConstraintName ?? "";
                return true;
            }
        }

        constraint = "";
        return false;
    }
}

public sealed record CreateCompleteStoreResult(
    int StoreId,
    string Slug,
    string PublicUrl,
    string AdminUrl,
    string AdminUsername,
    string TemporaryPassword,
    DateTime CreatedAt);

public sealed class StoreProvisioningConflictException(string message, Exception? inner = null)
    : Exception(message, inner);
