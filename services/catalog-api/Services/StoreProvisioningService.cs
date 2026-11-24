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
        new(["lanchonete", "hamburgueria", "pizzaria", "marmitaria", "assai"], StringComparer.Ordinal);
    private static readonly HashSet<string> AllowedStates =
        new(["AC","AL","AP","AM","BA","CE","DF","ES","GO","MA","MT","MS","MG","PA","PB","PR","PE","PI","RJ","RN","RS","RO","RR","SC","SP","SE","TO"], StringComparer.OrdinalIgnoreCase);
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

        var email = request.Email?.Trim() ?? "";
        if (email.Length is < 5 or > 64 || !MailAddress.TryCreate(email, out _))
            return "Informe um e-mail válido com até 64 caracteres para o primeiro acesso.";
        var phone = CatalogInputValidation.DigitsOnly(request.Telefone);
        if (phone.Length is < 10 or > 15)
            return "Telefone/WhatsApp inválido.";
        if (!AllowedSegments.Contains((request.Segmento ?? "").Trim().ToLowerInvariant()))
            return "Segmento inválido.";
        var state = (request.Estado ?? "").Trim().ToUpperInvariant();
        if (!AllowedStates.Contains(state))
            return "Informe uma UF válida.";
        if (string.IsNullOrWhiteSpace(request.Cidade) || request.Cidade.Trim().Length > 120)
            return "Informe uma cidade válida.";

        // Endereço e entrega valem para os dois modos: a distância da entrega é medida
        // a partir da localização da loja.
        if (string.IsNullOrWhiteSpace(request.Endereco) || request.Endereco.Trim().Length > 200)
            return "Informe o endereço da loja (máx. 200 caracteres).";
        if (string.IsNullOrWhiteSpace(request.Numero) || request.Numero.Trim().Length > 32)
            return "Informe o número do endereço (máx. 32 caracteres).";
        if ((request.Bairro?.Trim().Length ?? 0) > 120)
            return "Bairro muito longo (máx. 120 caracteres).";
        if (CatalogInputValidation.DigitsOnly(request.Cep).Length != 8)
            return "CEP inválido.";
        if (ParseDelivery(request, out var deliveryError) is null)
            return deliveryError;
        ParsePix(request, out var pixError);
        if (pixError is not null)
            return pixError;

        if (request.ModoRapido)
        {
            return null;
        }

        var personType = NormalizePersonType(request.TipoPessoa);
        if (personType is null)
            return "Tipo de pessoa inválido. Use PF ou PJ.";
        var document = ResolveDocument(request);
        if (personType == "PF")
        {
            if (!CatalogInputValidation.IsValidCpf(document))
                return "CPF inválido.";
        }
        else if (!CatalogInputValidation.IsValidCnpj(document))
        {
            return "CNPJ inválido.";
        }
        if (!IsColor(request.CorPrimaria) || !IsColor(request.CorSecundaria)
            || !IsColor(request.CorFundo) || !IsColor(request.CorTexto))
            return "Uma ou mais cores estão em formato inválido.";
        if (request.TipoCard is null || !CatalogInputValidation.CardTypes.Contains(request.TipoCard))
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
        var billing = BillingOptions.FromConfig(configuration);
        DateTime? trialUntil = billing.TrialDays > 0 ? now.Date.AddDays(billing.TrialDays) : null;
        var uploadedFiles = new List<string>();
        var uploadsRoot = ResolveUploadsRoot();

        try
        {
            var isQuick = request.ModoRapido;
            var logoUrl = isQuick ? null : await SaveImageAsync(request.Logo, "logo");
            var bannerUrl = isQuick ? null : await SaveImageAsync(request.Banner, "banner");
            var coverUrl = isQuick ? null : await SaveImageAsync(request.Capa, "capa");
            var temporaryPassword = GenerateTemporaryPassword();
            var username = request.Email.Trim().ToLowerInvariant();
            var publicBaseUrl = (configuration["PublicApp:BaseUrl"] ?? "https://wadelivery.com.br").TrimEnd('/');
            var publicUrl = $"{publicBaseUrl}/{slug}";
            var delivery = ParseDelivery(request, out var deliveryError)
                ?? throw new InvalidDataException(deliveryError ?? "Configuração de entrega inválida.");
            var pix = ParsePix(request, out var pixError);
            if (pixError is not null) throw new InvalidDataException(pixError);
            // Fora da transação: geocodificação é chamada externa e pode levar alguns segundos.
            var location = await GeocodeStoreAsync(request, ct);
            var deliveryWarning = location is null
                ? "Não localizamos o endereço da loja no mapa, então a entrega ficou desativada. " +
                  "No painel da loja, use \"Buscar no mapa\" nos dados da loja e ative os pedidos."
                : null;

            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await db.Database.ExecuteSqlRawAsync("SET LOCAL row_security = off", ct);

            if (await db.Stores.AsNoTracking().AnyAsync(store => store.Slug == slug, ct))
                throw new StoreProvisioningConflictException("Este slug já está em uso. Escolha outro.");
            if (await db.AdminUsers.AsNoTracking()
                    .AnyAsync(user => user.Username.ToLower() == username, ct))
                throw new StoreProvisioningConflictException("Já existe uma conta com este e-mail.");

            var normalizedDocument = isQuick ? null : NormalizeDocument(request);
            var state = request.Estado.Trim().ToUpperInvariant();
            var city = request.Cidade.Trim();
            var segment = (request.Segmento ?? "").Trim().ToLowerInvariant();
            // Teste rápido não escolhe cores: usa a paleta padrão do segmento (personalizável no painel).
            var palette = SegmentPalettes.For(segment);
            var primaryColor = isQuick ? palette.CorPrimaria : request.CorPrimaria;
            // Sem logo enviado: monograma moderno nas cores da loja (o lojista troca no painel).
            if (logoUrl is null)
            {
                logoUrl = await DefaultLogo.SaveAsync(uploadsRoot, slug, request.Nome.Trim(), primaryColor, ct);
                uploadedFiles.Add(logoUrl);
            }
            var store = new Loja
            {
                Nome = request.Nome.Trim(),
                Slug = slug,
                Cnpj = normalizedDocument,
                Telefone = CatalogInputValidation.DigitsOnly(request.Telefone),
                Email = username,
                Endereco = BuildAddress(request),
                AddressNumber = request.Numero.Trim(),
                Cep = CatalogInputValidation.DigitsOnly(request.Cep),
                Latitude = location?.Latitude,
                Longitude = location?.Longitude,
                DeliveryFeePerKm = delivery.FeePerKm,
                MinDeliveryFee = delivery.MinFee,
                MaxDeliveryKm = delivery.MaxKm,
                City = city,
                State = state,
                LogoUrl = logoUrl,
                BannerUrl = bannerUrl,
                CoverUrl = coverUrl,
                CorPrimaria = isQuick ? palette.CorPrimaria : request.CorPrimaria,
                CorSecundaria = isQuick ? palette.CorSecundaria : request.CorSecundaria,
                CorFundo = isQuick ? palette.CorFundo : request.CorFundo,
                CorTexto = isQuick ? palette.CorTexto : request.CorTexto,
                TipoCard = isQuick ? "foto-grande" : request.TipoCard,
                LayoutCardapio = isQuick ? "grade" : request.LayoutCardapio,
                EstiloBotao = isQuick ? "arredondado" : request.EstiloBotao,
                IsTeste = true,
                DataCriacao = now,
                DataAtualizacao = now,
                PixKey = pix?.Key ?? string.Empty,
                PixKeyLabel = pix?.Label ?? PixNotConfiguredLabel,
                CurrencyLocale = "pt-BR",
                ScheduleJson = """{"days":[0,1,2,3,4,5,6],"open":"10:00","close":"22:00","closedMessage":"Fechado."}""",
                DeliveryFeesJson = "{}",
                // Nasce aceitando pedidos de entrega para teste, desde que a loja tenha sido localizada.
                AcceptingOrders = location is not null,
                DineInEnabled = false,
                CustomerQrOrdersEnabled = false,
                WaiterOrdersEnabled = false,
                AllowManualTableEntry = false,
                TableCount = 0,
                WaiterSessionHours = 8
            };
            db.Stores.Add(store);
            await db.SaveChangesAsync(ct);
            tenant.SetStoreId(store.Id);

            // Cardápio inicial do segmento: categorias + dois produtos com foto real.
            var sample = SampleCatalog.For(segment);
            var categories = sample.Categories
                .Select((title, i) => new CategoryEntity { Id = Guid.NewGuid().ToString("N"), StoreId = store.Id, Title = title, SortOrder = i + 1 })
                .ToArray();
            db.Categories.AddRange(categories);
            var sortOrder = 0;
            foreach (var item in sample.Products)
            {
                db.Products.Add(new ProductEntity
                {
                    Id = Guid.NewGuid().ToString("N"),
                    StoreId = store.Id,
                    CategoryId = categories[Math.Clamp(item.CategoryIndex, 0, categories.Length - 1)].Id,
                    Name = item.Name,
                    Description = item.Description,
                    Price = item.Price,
                    ImageUrl = await SaveSamplePhotoAsync(item),
                    Available = true,
                    ShowInMenu = true,
                    SortOrder = ++sortOrder
                });
            }
            db.AdminUsers.Add(new AdminUserEntity
            {
                StoreId = store.Id,
                Username = username,
                PasswordHash = BCrypt.Net.BCrypt.HashPassword(temporaryPassword),
                Role = "AdminLoja",
                DisplayName = request.Nome.Trim(),
                // Senha temporária exibida uma única vez: o lojista define a dele no primeiro acesso.
                MustChangePassword = true
            });
            db.PlatformStores.Add(new PlatformStoreEntity
            {
                Id = Guid.NewGuid(),
                Name = request.Nome.Trim(),
                StoreId = store.Id,
                FrontUrl = publicUrl,
                AdminUrl = $"{publicBaseUrl}/{slug}/admin",
                LocalFrontUrl = $"http://localhost:3000/{slug}",
                LocalAdminUrl = $"http://localhost:3000/{slug}/admin",
                // Teste grátis: ao fim do prazo vira cobrança pendente (BillingPolicy).
                MonthlyFee = billing.DefaultMonthlyFee,
                Courtesy = true,
                CourtesyUntil = trialUntil,
                NextDueAt = trialUntil,
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
                Segment = segment,
                GalleryJson = "[]"
            });

            await db.SaveChangesAsync(ct);
            await transaction.CommitAsync(ct);
            cache.InvalidateStore(store.Id);
            cache.InvalidateSlug(slug);
            cache.InvalidateGlobal();

            return new CreateCompleteStoreResult(
                store.Id,
                slug,
                publicUrl,
                $"{publicBaseUrl}/{slug}/admin",
                username,
                temporaryPassword,
                now,
                store.AcceptingOrders,
                deliveryWarning);
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

        // Foto do produto de exemplo: falha (arquivo ausente/corrompido) não impede o cadastro.
        async Task<string?> SaveSamplePhotoAsync(SampleProduct item)
        {
            var path = Path.Combine(SampleCatalog.AssetsDirectory, item.PhotoFile);
            if (!File.Exists(path)) return null;
            try
            {
                await using var stream = File.OpenRead(path);
                var url = await ImageStorage.SaveProductPhotoAsync(
                    stream, uploadsRoot, $"{SampleCatalog.PhotoPrefix}{slug}-{item.Name}", ct);
                uploadedFiles.Add(url);
                return url;
            }
            catch (Exception)
            {
                return null;
            }
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

    /// <summary>
    /// Mesma preferência do painel: CEP primeiro (rápido), endereço completo como fallback.
    /// Falha de rede/serviço não bloqueia o cadastro; a loja fica sem coordenadas.
    /// </summary>
    private async Task<GeocodeResponse?> GeocodeStoreAsync(CriarLojaRequest request, CancellationToken ct)
    {
        var geo = services.GetService<GeoService>();
        if (geo is null) return null;
        try
        {
            var cep = CatalogInputValidation.DigitsOnly(request.Cep);
            var byCep = await geo.GeocodeByCepAsync(cep, ct);
            if (byCep is not null) return byCep;
            var parts = new[]
            {
                $"{request.Endereco?.Trim()}, {request.Numero?.Trim()}",
                request.Bairro, request.Cidade, request.Estado, "Brasil"
            }.Where(p => !string.IsNullOrWhiteSpace(p));
            return await geo.GeocodeAsync(string.Join(", ", parts), ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            return null;
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

    private static string? NormalizePersonType(string? value)
    {
        var normalized = (value ?? "").Trim().ToUpperInvariant();
        return normalized switch
        {
            "" or "PJ" or "JURIDICA" or "PESSOA_JURIDICA" => "PJ",
            "PF" or "FISICA" or "PESSOA_FISICA" => "PF",
            _ => null
        };
    }

    private static string ResolveDocument(CriarLojaRequest request)
    {
        var primary = (request.Documento ?? "").Trim();
        if (!string.IsNullOrWhiteSpace(primary)) return primary;
        return request.Cnpj ?? "";
    }

    private static string NormalizeDocument(CriarLojaRequest request)
    {
        var personType = NormalizePersonType(request.TipoPessoa) ?? "PJ";
        var document = ResolveDocument(request);
        return personType == "PF"
            ? CatalogInputValidation.NormalizeCpf(document) ?? ""
            : CatalogInputValidation.NormalizeCnpj(document) ?? "";
    }

    private static bool IsColor(string? color) => color is not null && HexColor.IsMatch(color);

    /// <summary>
    /// Converte a escolha de cobrança para os três campos que o painel e o cardápio usam:
    /// taxa fixa = taxa/km 0 + taxa mínima igual ao valor fixo; por km = taxa/km + mínima opcional.
    /// </summary>
    public static DeliveryConfig? ParseDelivery(CriarLojaRequest request, out string? error)
    {
        error = null;
        var mode = (request.TipoEntrega ?? "").Trim().ToLowerInvariant();
        if (!TryParseAmount(request.DistanciaMaximaKm, out var maxKm) || maxKm <= 0 || maxKm > 100)
        {
            error = "Informe a distância máxima de entrega entre 0,1 e 100 km.";
            return null;
        }

        switch (mode)
        {
            case "fixa":
                if (!TryParseAmount(request.TaxaEntregaFixa, out var fixedFee) || fixedFee <= 0 || fixedFee > 500)
                {
                    error = "Informe a taxa fixa de entrega entre R$ 0,01 e R$ 500,00.";
                    return null;
                }
                return new DeliveryConfig(0, fixedFee, maxKm);
            case "km":
                if (!TryParseAmount(request.TaxaPorKm, out var perKm) || perKm <= 0 || perKm > 100)
                {
                    error = "Informe o valor por km entre R$ 0,01 e R$ 100,00.";
                    return null;
                }
                var minFee = 0m;
                if (!string.IsNullOrWhiteSpace(request.TaxaMinima)
                    && (!TryParseAmount(request.TaxaMinima, out minFee) || minFee < 0 || minFee > 500))
                {
                    error = "Informe a taxa mínima entre R$ 0,00 e R$ 500,00.";
                    return null;
                }
                return new DeliveryConfig(perKm, minFee, maxKm);
            default:
                error = "Escolha como cobrar a entrega: taxa fixa ou valor por km.";
                return null;
        }
    }

    public const string PixNotConfiguredLabel = "Chave PIX não configurada";
    // Nomes oficiais dos tipos de chave Pix (gravados como rótulo); aceita também os nomes antigos.
    private static readonly Dictionary<string, string> PixKeyTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        ["CPF"] = "CPF",
        ["CNPJ"] = "CNPJ",
        ["E-mail"] = "E-mail",
        ["Email"] = "E-mail",
        ["Celular"] = "Celular",
        ["Telefone"] = "Celular",
        ["Chave aleatória"] = "Chave aleatória",
        ["Aleatória"] = "Chave aleatória",
    };
    private static readonly Regex RandomPixKey =
        new("^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>
    /// Chave Pix opcional do cadastro, normalizada para o formato gravado em stores.PixKey
    /// (só dígitos para telefone/CPF, CNPJ sem pontuação, e-mail e aleatória em minúsculas).
    /// Sem chave → null (a loja nasce sem Pix e o cardápio não oferece Pix).
    /// </summary>
    public static (string Key, string Label)? ParsePix(CriarLojaRequest request, out string? error)
    {
        error = null;
        var raw = (request.ChavePix ?? "").Trim();
        if (raw.Length == 0) return null;
        if (raw.Length > 120)
        {
            error = "Chave Pix muito longa.";
            return null;
        }
        var type = PixKeyTypes.GetValueOrDefault((request.TipoChavePix ?? "").Trim());
        switch (type)
        {
            case "Celular":
            {
                var digits = CatalogInputValidation.DigitsOnly(raw);
                if (digits.Length is < 10 or > 13) { error = "Chave Pix de celular inválida. Informe DDD e número."; return null; }
                return (digits, type);
            }
            case "CPF":
                if (!CatalogInputValidation.IsValidCpf(raw)) { error = "Chave Pix: CPF inválido."; return null; }
                return (CatalogInputValidation.NormalizeCpf(raw) ?? raw, type);
            case "CNPJ":
                if (!CatalogInputValidation.IsValidCnpj(raw)) { error = "Chave Pix: CNPJ inválido."; return null; }
                return (CatalogInputValidation.NormalizeCnpj(raw) ?? raw, type);
            case "E-mail":
                if (raw.Length > 77 || !MailAddress.TryCreate(raw, out _)) { error = "Chave Pix: e-mail inválido."; return null; }
                return (raw.ToLowerInvariant(), type);
            case "Chave aleatória":
                if (!RandomPixKey.IsMatch(raw)) { error = "Chave Pix aleatória inválida."; return null; }
                return (raw.ToLowerInvariant(), type);
            default:
                error = "Escolha o tipo da chave Pix.";
                return null;
        }
    }

    private static bool TryParseAmount(string? value, out decimal amount)
    {
        amount = 0;
        var text = (value ?? "").Trim().Replace(',', '.');
        if (text.Length is 0 or > 12) return false;
        if (!decimal.TryParse(text, System.Globalization.NumberStyles.AllowDecimalPoint,
                System.Globalization.CultureInfo.InvariantCulture, out amount))
            return false;
        amount = Math.Round(amount, 2);
        return true;
    }

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
    DateTime CreatedAt,
    bool AcceptingOrders,
    string? DeliveryWarning);

/// <summary>Configuração de entrega no formato usado por stores (taxa/km, taxa mínima, raio).</summary>
public sealed record DeliveryConfig(decimal FeePerKm, decimal MinFee, decimal MaxKm);

public sealed class StoreProvisioningConflictException(string message, Exception? inner = null)
    : Exception(message, inner);
