using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Catalog.Api.Models;

namespace Catalog.Api;

public static partial class CatalogInputValidation
{
    private static readonly HashSet<string> ReservedTenantSlugs = new(StringComparer.Ordinal)
    {
        "admin", "api", "assets", "public", "login", "suporte", "faq",
        "criar-loja", "storefront", "legacy-admin", "www"
    };

    private static readonly HashSet<string> AllowedImageExt = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".webp", ".ico"
    };

    public const long MaxUploadBytes = 2 * 1024 * 1024;

    public static string? ValidateLogin(LoginRequest? body)
    {
        if (body is null) return "Credenciais inválidas.";
        var user = (body.Username ?? "").Trim();
        var pass = body.Password ?? "";
        if (user.Length is < 1 or > 64) return "Usuário inválido.";
        if (pass.Length is < 1 or > 128) return "Senha inválida.";
        return null;
    }

    public static string? ValidateUpdateProfile(UpdateProfileRequest? body)
    {
        if (body is null) return "Dados inválidos.";
        var name = (body.DisplayName ?? "").Trim();
        if (name.Length > 120) return "Nome de exibição muito longo (máx. 120 caracteres).";
        return null;
    }

    public static string? ValidateChangePassword(ChangePasswordRequest? body)
    {
        if (body is null) return "Dados inválidos.";
        var current = body.CurrentPassword ?? "";
        if (current.Length is < 1 or > 128) return "Senha atual inválida.";
        var newPass = body.NewPassword ?? "";
        if (newPass.Length < 6) return "Senha muito curta (mín. 6 caracteres).";
        if (newPass.Length > 128) return "Senha muito longa (máx. 128 caracteres).";
        if (newPass == current) return "A nova senha deve ser diferente da atual.";
        return null;
    }

    /// <summary>
    /// Modelos de card de produto do cardápio (painel → Loja → Aparência e cadastro completo).
    /// O cardápio aplica cada um como classe CSS em apps/storefront.
    /// </summary>
    public static readonly IReadOnlySet<string> CardTypes = new HashSet<string>(StringComparer.Ordinal)
    {
        "foto-grande", "lista-horizontal", "compacto", "vitrine", "minimalista", "destaque", "moderno"
    };

    private static readonly Regex HexColorRegex = new("^#[0-9a-fA-F]{6}$", RegexOptions.Compiled);

    public static bool IsHexColor(string? value) => value is not null && HexColorRegex.IsMatch(value);

    public static string? ValidatePatchStore(PatchStoreRequest body)
    {
        if (body.StoreName is not null && (body.StoreName.Trim().Length is < 2 or > 200))
            return "Nome da loja inválido.";
        if (body.TipoCard is not null && !CardTypes.Contains(body.TipoCard))
            return "Modelo de card inválido.";
        if (!string.IsNullOrWhiteSpace(body.HeroProductId) && !IsSafeId(body.HeroProductId))
            return "Produto do destaque inválido.";
        if (body.HeroTitle is not null && body.HeroTitle.Trim().Length > 90)
            return "Título do destaque muito longo (máx. 90 caracteres).";
        if (body.HeroSubtitle is not null && body.HeroSubtitle.Trim().Length > 220)
            return "Subtítulo do destaque muito longo (máx. 220 caracteres).";
        foreach (var color in new[] { body.CorPrimaria, body.CorSecundaria, body.CorFundo, body.CorTexto })
        {
            if (color is not null && !IsHexColor(color))
                return "Cor inválida. Use o formato hexadecimal, por exemplo #1f6feb.";
        }
        if (body.WhatsAppOrderTemplate is not null
            && body.WhatsAppOrderTemplate.Length > Services.WhatsAppOrderTemplate.MaxLength)
            return $"A mensagem do WhatsApp deve ter até {Services.WhatsAppOrderTemplate.MaxLength} caracteres.";
        if (body.Whatsapp is not null)
        {
            var d = DigitsOnly(body.Whatsapp);
            if (d.Length is < 10 or > 15) return "WhatsApp inválido.";
        }
        if (body.DeliveryFeePerKm is < 0) return "Taxa por km inválida.";
        if (body.MinDeliveryFee is < 0) return "Taxa mínima inválida.";
        if (body.MaxDeliveryKm is < 0) return "Raio máximo inválido.";
        if (body.AverageDeliveryMinutes is < 0 or > 24 * 60) return "Prazo médio inválido.";
        if (body.AutoAdvancePreparingMinutes is < 1 or > 24 * 60) return "Tempo da preparação automática inválido (use entre 1 e 1440 minutos).";
        if (body.Latitude is < -90 or > 90) return "Latitude inválida.";
        if (body.Longitude is < -180 or > 180) return "Longitude inválida.";
        if (body.LogoUrl is not null && !IsSafeAssetUrl(body.LogoUrl))
            return "Logo URL inválida (use https:// ou /uploads/...).";
        if (body.IconUrl is not null && !IsSafeAssetUrl(body.IconUrl))
            return "Ícone URL inválido (use https:// ou /uploads/...).";
        if (body.AddressNumber is not null && body.AddressNumber.Length > 32)
            return "Número do endereço inválido.";
        if (body.TableCount is < 1 or > 200)
            return "Quantidade de mesas inválida (use entre 1 e 200).";
        if (body.Slug is not null && !IsValidTenantSlug(body.Slug))
            return "Slug inválido (minúsculas, números e hífen; sem espaços ou acentos).";

        var scheduleErr = NormalizeSchedule(body);
        if (scheduleErr is not null) return scheduleErr;

        return null;
    }

    /// <summary>
    /// Normaliza o horário de funcionamento para a forma canônica: PerDay com 7 entradas
    /// (uma por dia 0..6), incluindo intervalo de pausa e prazo por dia. Aceita tanto a forma
    /// nova (PerDay) quanto a legada (Days/Open/Close). Exige ao menos um dia ativo.
    /// </summary>
    public static string? NormalizeSchedule(PatchStoreRequest body)
    {
        if (body.Schedule is null) return null;

        var s = body.Schedule;
        if (s.PerDay is { Length: > 0 })
        {
            foreach (var day in s.PerDay)
            {
                if (day.Day is < 0 or > 6)
                    return "Dia de funcionamento inválido (0=domingo … 6=sábado).";
                if (!day.Enabled) continue;

                if (!TryParseScheduleClock(day.Open, out _))
                    return $"Horário de abertura inválido no dia {day.Day} (use HH:mm).";
                if (!TryParseScheduleClock(day.Close, out _))
                    return $"Horário de fechamento inválido no dia {day.Day} (use HH:mm).";

                if (day.BreakEnabled)
                {
                    if (!TryParseScheduleClock(day.BreakStart, out _) || !TryParseScheduleClock(day.BreakEnd, out _))
                        return $"Intervalo inválido no dia {day.Day} (use HH:mm).";
                    if (TryParseScheduleClock(day.BreakStart, out var bs)
                        && TryParseScheduleClock(day.BreakEnd, out var be)
                        && bs > be)
                        return $"Intervalo no dia {day.Day} não pode cruzar a meia-noite.";
                }

                if (day.DeliveryMinutes is < 0 or > 24 * 60)
                    return $"Prazo de entrega inválido no dia {day.Day} (0 a 1440 minutos).";
            }

            if (!s.PerDay.Any(d => d.Enabled))
                return "Informe ao menos um dia de funcionamento (0=domingo … 6=sábado).";
        }
        else
        {
            var days = (s.Days ?? Array.Empty<int>())
                .Where(d => d is >= 0 and <= 6)
                .Distinct()
                .OrderBy(d => d)
                .ToArray();

            if (days.Length == 0)
                return "Informe ao menos um dia de funcionamento (0=domingo … 6=sábado).";

            if (!TryParseScheduleClock(s.Open, out _))
                return "Horário de abertura inválido (use HH:mm).";
            if (!TryParseScheduleClock(s.Close, out _))
                return "Horário de fechamento inválido (use HH:mm).";
        }

        body.Schedule = ScheduleNormalizer.EnsurePerDay(s);
        return null;
    }

    private static bool TryParseScheduleClock(string? value, out int minutes)
    {
        minutes = 0;
        var m = (value ?? "").Trim();
        var parts = m.Split(':');
        if (parts.Length != 2) return false;
        if (!int.TryParse(parts[0], out var h) || !int.TryParse(parts[1], out var min)) return false;
        if (h is < 0 or > 23 || min is < 0 or > 59) return false;
        minutes = h * 60 + min;
        return true;
    }

    private static string NormalizeCategoryLabel(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return "";
        var form = value.Trim().ToLowerInvariant().Normalize(NormalizationForm.FormD);
        var sb = new StringBuilder(form.Length);
        foreach (var ch in form)
        {
            if (CharUnicodeInfo.GetUnicodeCategory(ch) != UnicodeCategory.NonSpacingMark)
                sb.Append(ch);
        }
        return sb.ToString().Normalize(NormalizationForm.FormC);
    }

    /// <summary>Categorias com este nome não entram no cardápio (ingredientes têm cadastro próprio).</summary>
    public static bool IsIngredientsCategory(string? id, string? title)
    {
        var t = NormalizeCategoryLabel(title);
        var i = NormalizeCategoryLabel(id);
        return t is "ingredientes" or "ingrediente" or "ingredients" or "ingredient"
            || i is "ingredientes" or "ingrediente" or "ingredients" or "ingredient";
    }

    /// <summary>Adicionais ficam só no admin (extras de montagem), nunca como categoria do cardápio público.</summary>
    public static bool IsAddonsCategory(string? id, string? title)
    {
        var t = NormalizeCategoryLabel(title);
        var i = NormalizeCategoryLabel(id);
        return t is "adicionais" or "adicional" or "addons" or "addon"
            || i is "adicionais" or "adicional" or "addons" or "addon";
    }

    public static bool IsHiddenMenuCategory(string? id, string? title) =>
        IsIngredientsCategory(id, title) || IsAddonsCategory(id, title);

    /// <summary>Bebidas não recebem o grupo "Adicionais" legado no backfill de grupos.</summary>
    public static bool IsBeverageCategory(string? id, string? title)
    {
        var t = NormalizeCategoryLabel(id) + " " + NormalizeCategoryLabel(title);
        return t.Contains("bebida") || t.Contains("drink");
    }

    public static bool ResolveCategoryShowInMenu(string id, string title, bool requested) =>
        !IsHiddenMenuCategory(id, title) && requested;

    public static string? ValidateCategory(UpsertCategoryRequest body)
    {
        // Id vazio = auto-increment no create; se informado, valida formato
        if (!string.IsNullOrWhiteSpace(body.Id) && !IsSafeId(body.Id))
            return "Id de categoria inválido.";
        if (string.IsNullOrWhiteSpace(body.Title) || body.Title.Trim().Length > 120)
            return "Título de categoria inválido.";
        if (IsIngredientsCategory(body.Id, body.Title))
            return "Ingredientes não são categoria do cardápio. Use a aba Ingredientes.";
        if (body.SortOrder is < 0 or > 10_000) return "Ordem inválida.";
        return null;
    }

    public static string? ValidateIngredient(UpsertIngredientRequest body)
    {
        // Id vazio = auto-increment no create; se informado, valida formato
        if (!string.IsNullOrWhiteSpace(body.Id) && !IsSafeId(body.Id))
            return "Id de ingrediente inválido.";
        if (string.IsNullOrWhiteSpace(body.Name) || body.Name.Trim().Length > 120)
            return "Nome do ingrediente inválido.";
        if (body.SortOrder is < 0 or > 10_000) return "Ordem inválida.";
        return null;
    }

    public static string? ValidateMove(MoveItemRequest? body)
    {
        if (body is null || string.IsNullOrWhiteSpace(body.Direction))
            return "Informe a direção (up ou down).";
        var dir = body.Direction.Trim().ToLowerInvariant();
        if (dir is not ("up" or "down"))
            return "Direção inválida (use up ou down).";
        return null;
    }

    public static string? ValidateReorder(ReorderItemsRequest? body, bool requireCategory = false)
    {
        if (body?.Ids is null || body.Ids.Count == 0)
            return "Informe a lista de ids na nova ordem.";
        if (body.Ids.Count > 500)
            return "Lista de ordenação muito grande.";
        if (body.Ids.Distinct(StringComparer.OrdinalIgnoreCase).Count() != body.Ids.Count)
            return "Ids duplicados na ordenação.";
        foreach (var id in body.Ids)
        {
            if (!IsSafeId(id))
                return "Id inválido na ordenação.";
        }
        if (requireCategory && !IsSafeId(body.CategoryId))
            return "Categoria inválida para ordenação de produtos.";
        return null;
    }

    /// <summary>Selos de destaque dos produtos (texto e estilo de cada um ficam no cardápio e no painel).</summary>
    public static readonly IReadOnlySet<string> ProductBadges = new HashSet<string>(StringComparer.Ordinal)
    {
        "rei-da-casa", "mais-pedido", "novidade", "promocao", "para-dividir", "vegetariano"
    };

    /// <summary>Normaliza o selo recebido: vazio → null (sem selo).</summary>
    public static string? NormalizeProductBadge(string? badge)
    {
        var value = (badge ?? "").Trim();
        return value.Length == 0 ? null : value;
    }

    public static string? ValidateProduct(UpsertProductRequest body)
    {
        var badge = NormalizeProductBadge(body.Badge);
        if (badge is not null && !ProductBadges.Contains(badge))
            return "Selo do produto inválido.";
        // Id vazio = auto-increment no create; se informado, valida formato
        if (!string.IsNullOrWhiteSpace(body.Id) && !IsSafeId(body.Id))
            return "Id de produto inválido.";
        if (!IsSafeId(body.CategoryId)) return "Categoria inválida.";
        if (string.IsNullOrWhiteSpace(body.Name) || body.Name.Trim().Length > 160)
            return "Nome do produto inválido.";
        if (body.Price < 0 || body.Price > 1_000_000) return "Preço inválido.";
        if (body.PriceMedia is not null && (body.PriceMedia < 0 || body.PriceMedia > 1_000_000))
            return "Preço da média inválido.";
        if (body.PriceInteira is not null && (body.PriceInteira < 0 || body.PriceInteira > 1_000_000))
            return "Preço da inteira inválido.";
        if ((body.PriceMedia is null) != (body.PriceInteira is null))
            return "Informe os preços da Média e da Inteira.";
        if (body.ImageUrl is not null && !IsSafeAssetUrl(body.ImageUrl))
            return "ImageUrl inválida (use https:// ou /uploads/...).";
        if (body.Description is not null && body.Description.Trim().Length > 800)
            return "Descrição muito longa (máx. 800 caracteres).";
        if (body.SortOrder is < 0 or > 10_000) return "Ordem inválida.";
        if (body.IngredientIds is not null)
        {
            if (body.IngredientIds.Count > 80)
                return "Muitos ingredientes selecionados (máx. 80).";
            foreach (var id in body.IngredientIds)
            {
                if (!IsSafeId(id))
                    return "Id de ingrediente inválido na seleção.";
            }
        }
        if (body.PrincipalIngredientIds is not null)
        {
            var selected = new HashSet<string>(body.IngredientIds ?? [], StringComparer.OrdinalIgnoreCase);
            foreach (var id in body.PrincipalIngredientIds)
            {
                if (!IsSafeId(id))
                    return "Id de ingrediente principal inválido.";
                if (!selected.Contains(id))
                    return "Ingrediente principal fora da seleção do produto.";
            }
        }
        if (body.ModifierGroups is not null)
        {
            if (body.ModifierGroups.Count > 20)
                return "Muitos grupos de modificadores (máx. 20).";
            foreach (var group in body.ModifierGroups)
            {
                var groupError = ValidateModifierGroup(group);
                if (groupError is not null) return groupError;
            }
        }
        return null;
    }

    public static string? ValidateModifierGroup(ModifierGroupDto group)
    {
        if (!string.IsNullOrWhiteSpace(group.Id) && !IsSafeId(group.Id))
            return "Id de grupo de modificador inválido.";
        if (string.IsNullOrWhiteSpace(group.Name) || group.Name.Trim().Length > 60)
            return "Nome de grupo de modificador inválido.";
        if (group.Min < 0 || group.Min > 10) return "Mínimo de seleção inválido.";
        if (group.Max is < 0 or > 10) return "Máximo de seleção inválido.";
        if (group.Max > 0 && group.Max < group.Min)
            return "Máximo de seleção menor que o mínimo.";
        if (group.Options is null || group.Options.Count > 30)
            return "Grupo sem opções ou com muitas opções (máx. 30).";
        foreach (var option in group.Options)
        {
            if (!string.IsNullOrWhiteSpace(option.Id) && !IsSafeId(option.Id))
                return "Id de opção de modificador inválido.";
            if (string.IsNullOrWhiteSpace(option.Name) || option.Name.Trim().Length > 60)
                return "Nome de opção de modificador inválido.";
            if (option.PriceDelta < 0 || option.PriceDelta > 999)
                return "Preço de opção inválido.";
        }
        return null;
    }

    public static string? ValidateUpload(IFormFile file, out string extension)
    {
        extension = Path.GetExtension(file.FileName ?? "").ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(extension)) extension = ".png";
        if (file.Length <= 0) return "Arquivo vazio.";
        if (file.Length > MaxUploadBytes) return "Arquivo maior que 2 MB.";
        if (!AllowedImageExt.Contains(extension))
            return "Use PNG, JPG, WEBP ou ICO (SVG não permitido).";
        if (string.Equals(extension, ".svg", StringComparison.OrdinalIgnoreCase))
            return "SVG não permitido por segurança.";
        return null;
    }

    public static string? ValidateCnpj(string? cnpj)
    {
        if (string.IsNullOrWhiteSpace(cnpj)) return null;
        return IsValidCnpj(cnpj) ? null : "CNPJ inválido.";
    }

    public static string? ValidateCpf(string? cpf)
    {
        if (string.IsNullOrWhiteSpace(cpf)) return null;
        return IsValidCpf(cpf) ? null : "CPF inválido.";
    }

    public static string? ValidateCep(string? cep)
    {
        if (string.IsNullOrWhiteSpace(cep)) return null;
        return DigitsOnly(cep).Length == 8 ? null : "CEP inválido (use 8 dígitos).";
    }

    public static string? ValidatePhone(string? phone)
    {
        if (string.IsNullOrWhiteSpace(phone)) return null;
        var d = DigitsOnly(phone);
        return d.Length is >= 10 and <= 15 ? null : "Telefone inválido.";
    }

    public static string? ValidateEmail(string? email)
    {
        if (string.IsNullOrWhiteSpace(email)) return null;
        var e = email.Trim();
        if (e.Length > 200) return "E-mail inválido.";
        if (!e.Contains('@') || e.StartsWith('@') || e.EndsWith('@') || e.Contains(' ')) return "E-mail inválido.";
        return null;
    }

    public static string? ValidateStoreUser(CreateStoreUserRequest? body)
    {
        if (body is null) return "Dados de usuário inválidos.";
        var u = (body.Username ?? "").Trim();
        if (u.Length is < 2 or > 64) return "Usuário inválido (mín. 2 caracteres).";
        if (!SafeIdRegex().IsMatch(u)) return "Usuário: use letras, números, _ ou -.";
        if ((body.Password ?? "").Length < 6) return "Senha muito curta (mín. 6 caracteres).";
        if (body.Role is not ("Admin" or "Atendimento" or "Garçom")) return "Papel inválido para usuário da loja.";
        if (string.Equals(body.Role, "Garçom", StringComparison.OrdinalIgnoreCase))
        {
            var name = (body.DisplayName ?? "").Trim();
            if (name.Length < 2) return "Nome é obrigatório para o papel Garçom (mín. 2 caracteres).";
            if (string.IsNullOrWhiteSpace(body.Pin)) return "PIN é obrigatório para o papel Garçom.";
        }
        var pin = (body.Pin ?? "").Trim();
        if (pin.Length > 0 && (pin.Length != 4 || !pin.All(char.IsDigit)))
            return "O PIN deve ter exatamente 4 dígitos.";
        return null;
    }

    public static string? ValidateUpdateStoreUser(UpdateStoreUserRequest? body, StoreUserDto current)
    {
        if (body is null) return "Dados de usuário inválidos.";
        var u = (body.Username ?? "").Trim();
        if (u.Length is < 2 or > 64) return "Usuário inválido (mín. 2 caracteres).";
        if (!SafeIdRegex().IsMatch(u)) return "Usuário: use letras, números, _ ou -.";
        if (body.Role is not ("Admin" or "Atendimento" or "Garçom")) return "Papel inválido para usuário da loja.";
        if (!string.IsNullOrWhiteSpace(body.Password) && (body.Password ?? "").Length < 6)
            return "Senha muito curta (mín. 6 caracteres).";
        var pin = (body.Pin ?? "").Trim();
        var isGarcom = string.Equals(body.Role, "Garçom", StringComparison.OrdinalIgnoreCase);
        if (isGarcom)
        {
            var name = (body.DisplayName ?? "").Trim();
            if (name.Length < 2) return "Nome é obrigatório para o papel Garçom (mín. 2 caracteres).";
            if (pin.Length > 0 && (pin.Length != 4 || !pin.All(char.IsDigit)))
                return "O PIN deve ter exatamente 4 dígitos.";
            if (pin.Length == 0 && !current.HasPin)
                return "PIN é obrigatório para o papel Garçom.";
        }
        else if (pin.Length > 0 && (pin.Length != 4 || !pin.All(char.IsDigit)))
        {
            return "O PIN deve ter exatamente 4 dígitos.";
        }
        return null;
    }

    public static string? ValidatePlatformStore(UpsertPlatformStoreRequest body)
    {
        if (string.IsNullOrWhiteSpace(body.Name) || body.Name.Trim().Length > 200)
            return "Nome da loja é obrigatório (máx. 200 caracteres).";
        var cnpjErr = ValidateCnpj(body.Cnpj);
        if (cnpjErr is not null) return cnpjErr;
        var cepErr = ValidateCep(body.Cep);
        if (cepErr is not null) return cepErr;
        var phoneErr = ValidatePhone(body.Phone);
        if (phoneErr is not null) return phoneErr;
        var emailErr = ValidateEmail(body.Email);
        if (emailErr is not null) return emailErr;
        if (!string.IsNullOrWhiteSpace(body.State) && DigitsOnly(body.State).Length != 2)
        {
            var s = (body.State ?? "").Trim().ToUpperInvariant();
            if (s.Length != 2 || !s.All(char.IsAsciiLetter)) return "UF inválida (use 2 letras).";
        }
        if (!string.IsNullOrWhiteSpace(body.Plan))
        {
            var plan = body.Plan.Trim().ToLowerInvariant();
            // "teste" = loja criada pelo cadastro automático (StoreProvisioningService).
            if (plan is not ("basic" or "premium" or "trial" or "starter" or "teste")) return "Plano inválido (basic, premium, trial, starter ou teste).";
        }
        if (body.Segment is not null && body.Segment.Trim().Length > 50)
            return "Segmento deve ter no máximo 50 caracteres.";
        if (body.MonthlyFee < 0) return "Mensalidade não pode ser negativa.";
        if (body.LogoUrl is not null && !IsSafeAssetUrl(body.LogoUrl))
            return "Logo URL inválida (use https:// ou /uploads/...).";
        return null;
    }

    public static string NormalizeStoreStatus(string? status, bool active)
    {
        var s = (status ?? "").Trim().ToLowerInvariant();
        if (s is "active" or "setup" or "inactive") return s;
        return active ? "active" : "inactive";
    }

    private static readonly HashSet<string> AllowedProductImageExt = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".webp"
    };

    public static string? ValidateProductImage(IFormFile file)
    {
        if (file.Length <= 0) return "Arquivo vazio.";
        if (file.Length > MaxUploadBytes) return "Arquivo maior que 2 MB.";
        var ext = Path.GetExtension(file.FileName ?? "").ToLowerInvariant();
        if (!AllowedProductImageExt.Contains(ext) && !SniffsAsAllowedProductImage(file))
            return "Use PNG, JPG ou WEBP (SVG não permitido).";
        return null;
    }

    /// <summary>
    /// Detecta o tipo real pelo magic bytes (PNG/JPEG/WebP). Usado como fallback quando
    /// o nome do arquivo não tem extensão reconhecida (ex.: Blob "blob" vindo do navegador).
    /// </summary>
    private static bool SniffsAsAllowedProductImage(IFormFile file)
    {
        try
        {
            var stream = file.OpenReadStream();
            if (!stream.CanSeek) return false;

            Span<byte> header = stackalloc byte[12];
            var total = 0;
            while (total < header.Length)
            {
                var n = stream.Read(header[total..]);
                if (n <= 0) break;
                total += n;
            }
            stream.Position = 0;

            if (total >= 3 && header[0] == 0xFF && header[1] == 0xD8 && header[2] == 0xFF)
                return true; // JPEG

            if (total >= 8
                && header[0] == 0x89 && header[1] == (byte)'P' && header[2] == (byte)'N' && header[3] == (byte)'G'
                && header[4] == 0x0D && header[5] == 0x0A && header[6] == 0x1A && header[7] == 0x0A)
                return true; // PNG

            if (total >= 12
                && header[0] == (byte)'R' && header[1] == (byte)'I' && header[2] == (byte)'F' && header[3] == (byte)'F'
                && header[8] == (byte)'W' && header[9] == (byte)'E' && header[10] == (byte)'B' && header[11] == (byte)'P')
                return true; // WebP

            return false;
        }
        catch
        {
            return false;
        }
    }

    public static bool IsSafeId(string? id) =>
        !string.IsNullOrWhiteSpace(id)
        && id.Length <= 64
        && SafeIdRegex().IsMatch(id);

    public static bool IsSafeAssetUrl(string? url)
    {
        if (string.IsNullOrWhiteSpace(url)) return true;
        var u = url.Trim();
        if (u.Length > 400) return false;
        if (u.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase)) return true;
        if (u.StartsWith("assets/", StringComparison.OrdinalIgnoreCase)) return true;
        if (Uri.TryCreate(u, UriKind.Absolute, out var uri))
            return uri.Scheme is "https" or "http"
                && !u.StartsWith("javascript:", StringComparison.OrdinalIgnoreCase);
        return false;
    }

    public static string DigitsOnly(string? value) =>
        string.IsNullOrEmpty(value) ? "" : DigitsRegex().Replace(value, "");

    /// <summary>
    /// Normaliza um slug de tenant: minúsculas, espaços viram hífen, remove acentos e
    /// caracteres fora de [a-z0-9-]. Retorna null quando o resultado é vazio.
    /// </summary>
    public static string? NormalizeTenantSlug(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var lower = value.Trim().ToLowerInvariant();
        var sb = new StringBuilder(lower.Length);
        foreach (var ch in lower.Normalize(NormalizationForm.FormD))
        {
            var uc = CharUnicodeInfo.GetUnicodeCategory(ch);
            if (uc == UnicodeCategory.NonSpacingMark)
                continue; // remove acentos
            if (char.IsAsciiLetterOrDigit(ch))
                sb.Append(char.ToLowerInvariant(ch));
            else if (ch is ' ' or '-' or '_')
                sb.Append('-');
        }
        var slug = SlugRegex().Replace(sb.ToString().Trim('-'), "-");
        while (slug.Contains("--", StringComparison.Ordinal))
            slug = slug.Replace("--", "-", StringComparison.Ordinal);
        slug = slug.Trim('-');
        if (slug.Length > 100)
            slug = slug[..100].TrimEnd('-');
        return string.IsNullOrEmpty(slug) ? null : slug;
    }

    public static bool IsValidTenantSlug(string? slug)
    {
        var normalized = NormalizeTenantSlug(slug);
        return normalized is not null
            && normalized.Length is >= 3 and <= 80
            && !ReservedTenantSlugs.Contains(normalized)
            && string.Equals(normalized, slug?.Trim(), StringComparison.Ordinal);
    }

    public static bool IsValidCnpj(string? value)
    {
        var normalized = NormalizeCnpj(value);
        if (normalized is null || normalized.Length != 14) return false;
        if (normalized.All(c => c == normalized[0])) return false;
        if (!CnpjRegex().IsMatch(normalized)) return false;

        static int CharValue(char c) => c - '0';
        static int CheckDigit(string source, int[] weights)
        {
            var sum = 0;
            for (var i = 0; i < weights.Length; i++)
                sum += CharValue(source[i]) * weights[i];
            var remainder = sum % 11;
            return remainder < 2 ? 0 : 11 - remainder;
        }

        var first = CheckDigit(normalized[..12], [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
        var second = CheckDigit(normalized[..12] + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
        return CharValue(normalized[12]) == first && CharValue(normalized[13]) == second;
    }

    public static bool IsValidCpf(string? value)
    {
        var digits = DigitsOnly(value);
        if (digits.Length != 11 || digits.All(c => c == digits[0])) return false;

        static int CheckDigit(string source, int[] weights)
        {
            var sum = weights.Select((weight, index) => (source[index] - '0') * weight).Sum();
            var remainder = sum % 11;
            return remainder < 2 ? 0 : 11 - remainder;
        }

        var first = CheckDigit(digits[..9], [10, 9, 8, 7, 6, 5, 4, 3, 2]);
        var second = CheckDigit(digits[..9] + first, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
        return digits[9] - '0' == first && digits[10] - '0' == second;
    }

    /// <summary>Normaliza CNPJ numérico ou alfanumérico: maiúsculas, remove máscara, mantém A-Z0-9.</summary>
    public static string? NormalizeCnpj(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var chars = value.Trim().ToUpperInvariant()
            .Where(c => (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z'))
            .ToArray();
        return chars.Length == 0 ? null : new string(chars);
    }

    public static string? NormalizeCpf(string? value)
    {
        var digits = DigitsOnly(value);
        return digits.Length == 0 ? null : digits;
    }

    /// <summary>
    /// Gera um slug candidato a partir do nome da loja (ex.: "Gota Açaí" → "gota-acai").
    /// Não garante exclusividade — use junto com uma checagem de unicidade no repositório.
    /// </summary>
    public static string SlugifyStoreName(string? name)
    {
        var slug = NormalizeTenantSlug(name);
        if (!string.IsNullOrEmpty(slug))
            return slug;
        return "loja";
    }

    [GeneratedRegex(@"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")]
    private static partial Regex SafeIdRegex();

    [GeneratedRegex(@"\D")]
    private static partial Regex DigitsRegex();

    [GeneratedRegex(@"-{2,}")]
    private static partial Regex SlugRegex();

    [GeneratedRegex(@"^[A-Z0-9]{12}[0-9]{2}$")]
    private static partial Regex CnpjRegex();
}
