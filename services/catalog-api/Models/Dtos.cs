namespace Catalog.Api.Models;

/// <summary>
/// Configuração de um dia da semana (0=domingo … 6=sábado). Se <see cref="Enabled"/> for false,
/// a loja não funciona nesse dia. <see cref="DeliveryMinutes"/> nulo cai no prazo médio da loja
/// (AverageDeliveryMinutes).
/// </summary>
public record ScheduleDayDto(
    int Day,
    bool Enabled,
    string Open,
    string Close,
    bool BreakEnabled = false,
    string BreakStart = "",
    string BreakEnd = "",
    int? DeliveryMinutes = null);

/// <summary>
/// Horário de funcionamento. <c>Days/Open/Close</c> são espelhos legados (usados por versões
/// antigas do cardápio); <see cref="PerDay"/> é a forma canônica com 7 entradas (uma por dia),
/// incluindo intervalo de pausa e prazo de entrega por dia.
/// </summary>
public record ScheduleDto(
    int[] Days,
    string Open,
    string Close,
    string ClosedMessage,
    ScheduleDayDto[]? PerDay = null);

public class BreadOptionDto
{
    public string Id { get; set; } = string.Empty;
    public string Label { get; set; } = string.Empty;
    public bool Available { get; set; } = true;
}

public record StoreDto(
    string StoreName,
    string? LogoUrl,
    string Whatsapp,
    string PixKey,
    string PixKeyLabel,
    decimal MinOrder,
    string CurrencyLocale,
    ScheduleDto Schedule,
    Dictionary<string, decimal> DeliveryFees,
    string? Address = null,
    string? Cep = null,
    double? Latitude = null,
    double? Longitude = null,
    decimal DeliveryFeePerKm = 0,
    decimal MaxDeliveryKm = 0,
    decimal MinDeliveryFee = 0,
    int AverageDeliveryMinutes = 40,
    List<BreadOptionDto>? BreadOptions = null,
    bool AcceptingOrders = true,
    string? AddressNumber = null,
    string? IconUrl = null,
    /// <summary>Quando definido e no futuro, a loja permanece aberta até este instante (UTC), além do horário fixo.</summary>
    DateTime? ExtendedCloseUntilUtc = null,
    /// <summary>Cidade do estabelecimento (área de atendimento / padrão no checkout do cliente).</summary>
    string? City = null,
    /// <summary>UF do estabelecimento (2 letras).</summary>
    string? State = null,
    bool Active = true,
    /// <summary>Quando ativa, o orders-api promove pedidos confirmados para "Em preparação" após AutoAdvancePreparingMinutes.</summary>
    bool AutoAdvancePreparing = false,
    /// <summary>Minutos após a confirmação até o pedido avançar automaticamente para "Em preparação".</summary>
    int AutoAdvancePreparingMinutes = 5,
    // ── Dine-in feature flags ──
    /// <summary>Ativa o modo de consumo no local (mesas).</summary>
    bool DineInEnabled = false,
    /// <summary>Permite que clientes façam pedidos via QR Code na mesa.</summary>
    bool CustomerQrOrdersEnabled = false,
    /// <summary>Permite que garçons criem pedidos de mesa pelo painel.</summary>
    bool WaiterOrdersEnabled = false,
    /// <summary>Permite entrada manual de mesa (sem QR Code).</summary>
    bool AllowManualTableEntry = false,
    /// <summary>Exige nome do cliente para pedidos via QR Code.</summary>
    bool RequireCustomerNameForQrOrder = false,
    /// <summary>Permite que o cliente escolha o garçom no checkout.</summary>
    bool AllowCustomerChooseWaiter = false,
    /// <summary>Quantidade de mesas disponíveis (provisão automática das mesas no orders-api).</summary>
    int? TableCount = null,
    /// <summary>Duração da sessão do garçom em horas (padrão 8).</summary>
    int WaiterSessionHours = 8,
    /// <summary>Slug público único da loja (resolução de subdomínio via middleware).</summary>
    string? Slug = null,
    string? CorPrimaria = null,
    string? CorSecundaria = null,
    string? CorFundo = null,
    string? CorTexto = null,
    string? TipoCard = null,
    string? LayoutCardapio = null,
    string? EstiloBotao = null,
    string? BannerUrl = null,
    string? CoverUrl = null,
    /// <summary>Modelo da mensagem de WhatsApp do pedido. Na leitura vem sempre preenchido (personalizado ou padrão).</summary>
    string? WhatsAppOrderTemplate = null,
    /// <summary>true quando a loja usa um modelo personalizado; false quando usa o padrão.</summary>
    bool WhatsAppOrderTemplateCustomized = false,
    /// <summary>Destaque no topo do cardápio: faixa com título, subtítulo e produto carro-chefe.</summary>
    bool HeroEnabled = false,
    string? HeroProductId = null,
    string? HeroTitle = null,
    string? HeroSubtitle = null);

/// <summary>
/// Resposta pública de resolução de subdomínio → loja (endpoint <c>/api/v1/tenant/{slug}</c>).
/// Contém apenas dados básicos necessários para o cardápio multi-tenant do WaDelivery.
/// </summary>
public record TenantResolveDto(
    int StoreId,
    string Slug,
    string Name,
    /// <summary>Status operacional: active | setup | inactive (fonte: platform_stores, default "active").</summary>
    string Status,
    bool Active,
    /// <summary>Horário/disponibilidade atual da loja (AcceptingOrders).</summary>
    bool AcceptingOrders,
    /// <summary>Logo da loja (identidade visual).</summary>
    string? LogoUrl,
    /// <summary>Ícone/favicon da loja (identidade visual).</summary>
    string? IconUrl,
    /// <summary>Segmento de mercado (Lançhonete, Pizzaria, Açougue, ...).</summary>
    string? Segment,
    string CurrencyLocale,
    string? CorPrimaria = null,
    string? CorSecundaria = null,
    string? CorFundo = null,
    string? CorTexto = null,
    string? TipoCard = null,
    string? LayoutCardapio = null,
    string? EstiloBotao = null,
    string? BannerUrl = null,
    string? CoverUrl = null);

public record IngredientDto(string Id, string Name, int SortOrder = 0, string? CategoryId = null, bool Available = true, bool IsPrincipal = false);

/// <summary>Opção de um grupo de modificadores (adicional cobrado ou opção de escolha).</summary>
public record ModifierOptionDto(
    string Id,
    string Name,
    decimal PriceDelta = 0,
    int SortOrder = 0,
    bool Available = true);

/// <summary>
/// Grupo de modificadores anexado a um produto. Representa adicionais cobrados
/// (upsell) ou opções com regra de escolha (Min/Max, Required).
/// </summary>
public record ModifierGroupDto(
    string Id,
    string Name,
    int SortOrder = 0,
    bool Required = false,
    int Min = 0,
    int Max = 0,
    List<ModifierOptionDto>? Options = null);

public record ProductDto(
    string Id,
    string Name,
    decimal Price,
    bool Available,
    string? ImageUrl,
    string? Description = null,
    List<IngredientDto>? Ingredients = null,
    int SortOrder = 0,
    decimal? PriceMedia = null,
    decimal? PriceInteira = null,
    bool ShowInMenu = true,
    List<ModifierGroupDto>? ModifierGroups = null,
    /// <summary>Selo de destaque no card (ex.: "rei-da-casa", "mais-pedido"); null = sem selo.</summary>
    string? Badge = null);

public record CategoryDto(
    string Id,
    string Title,
    int SortOrder,
    List<ProductDto> Items,
    bool ShowInMenu = true);

public record CatalogDto(List<CategoryDto> Categories);

public record LoginRequest(string Username, string Password);

public record LoginResponse(string Token, DateTime ExpiresAt, string Username, string Role, int? StoreId = null, bool MustChangePassword = false);

public record UpsertCategoryRequest(string? Id, string Title, int? SortOrder = null, bool ShowInMenu = true);

public record UpsertIngredientRequest(string? Id, string Name, int? SortOrder = null, string? CategoryId = null, bool Available = true);

public record UpsertProductRequest(
    string? Id,
    string CategoryId,
    string Name,
    decimal Price,
    bool Available,
    string? ImageUrl,
    string? Description = null,
    List<string>? IngredientIds = null,
    int? SortOrder = null,
    decimal? PriceMedia = null,
    decimal? PriceInteira = null,
    bool ShowInMenu = true,
    List<ModifierGroupDto>? ModifierGroups = null,
    List<string>? PrincipalIngredientIds = null,
    /// <summary>Selo do card. null = mantém o atual; "" = remove o selo.</summary>
    string? Badge = null);

public record MoveItemRequest(string Direction);

public record ReorderItemsRequest(List<string> Ids, string? CategoryId = null);

public class PatchStoreRequest
{
    public string? StoreName { get; set; }
    public string? LogoUrl { get; set; }
    public string? Whatsapp { get; set; }
    public string? PixKey { get; set; }
    public string? PixKeyLabel { get; set; }
    public decimal? MinOrder { get; set; }
    public ScheduleDto? Schedule { get; set; }
    public Dictionary<string, decimal>? DeliveryFees { get; set; }
    public string? Address { get; set; }
    public string? Cep { get; set; }
    public string? City { get; set; }
    public string? State { get; set; }
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    public decimal? DeliveryFeePerKm { get; set; }
    public decimal? MaxDeliveryKm { get; set; }
    public decimal? MinDeliveryFee { get; set; }
    public int? AverageDeliveryMinutes { get; set; }
    public List<BreadOptionDto>? BreadOptions { get; set; }
    public bool? AcceptingOrders { get; set; }
    public string? AddressNumber { get; set; }
    public string? IconUrl { get; set; }
    public DateTime? ExtendedCloseUntilUtc { get; set; }
    /// <summary>Quando true, limpa a extensão de horário (útil ao encerrar expediente).</summary>
    public bool? ClearExtendedCloseUntil { get; set; }
    /// <summary>Modelo personalizado da mensagem de WhatsApp do pedido (texto com variáveis {nome}).</summary>
    public string? WhatsAppOrderTemplate { get; set; }
    // ── Aparência do cardápio (painel → Loja → Aparência) ──
    /// <summary>Modelo do card de produto (ver CatalogInputValidation.CardTypes).</summary>
    public string? TipoCard { get; set; }
    public string? CorPrimaria { get; set; }
    public string? CorSecundaria { get; set; }
    public string? CorFundo { get; set; }
    public string? CorTexto { get; set; }
    // ── Destaque no topo (painel → Loja → Aparência) ──
    public bool? HeroEnabled { get; set; }
    /// <summary>Produto carro-chefe. "" remove o produto do destaque.</summary>
    public string? HeroProductId { get; set; }
    public string? HeroTitle { get; set; }
    public string? HeroSubtitle { get; set; }
    /// <summary>Quando true, volta a usar o modelo padrão da mensagem de WhatsApp.</summary>
    public bool? ResetWhatsAppOrderTemplate { get; set; }
    /// <summary>Quando true, o orders-api avança pedidos confirmados para "Em preparação" automaticamente.</summary>
    public bool? AutoAdvancePreparing { get; set; }
    /// <summary>Minutos após a confirmação até avançar para "Em preparação" (padrão 5).</summary>
    public int? AutoAdvancePreparingMinutes { get; set; }
    // ── Dine-in feature flags ──
    /// <summary>Ativa o modo de consumo no local (mesas).</summary>
    public bool? DineInEnabled { get; set; }
    /// <summary>Permite que clientes façam pedidos via QR Code na mesa.</summary>
    public bool? CustomerQrOrdersEnabled { get; set; }
    /// <summary>Permite que garçons criem pedidos de mesa pelo painel.</summary>
    public bool? WaiterOrdersEnabled { get; set; }
    /// <summary>Permite entrada manual de mesa (sem QR Code).</summary>
    public bool? AllowManualTableEntry { get; set; }
    /// <summary>Exige nome do cliente para pedidos via QR Code.</summary>
    public bool? RequireCustomerNameForQrOrder { get; set; }
    /// <summary>Permite que o cliente escolha o garçom no checkout.</summary>
    public bool? AllowCustomerChooseWaiter { get; set; }
    /// <summary>Quantidade de mesas disponíveis (provisão automática das mesas no orders-api).</summary>
    public int? TableCount { get; set; }
    /// <summary>Duração da sessão do garçom em horas (padrão 8).</summary>
    public int? WaiterSessionHours { get; set; }
    /// <summary>Slug público único da loja (letras minúsculas, números e hífen). Definido para habilitar a resolução por subdomínio.</summary>
    public string? Slug { get; set; }
}

public record SetAcceptingOrdersRequest(bool AcceptingOrders);

public record ExtendHoursRequest(int Minutes);

public record GeocodeRequest(string Query);

public record GeocodeResponse(string DisplayName, double Latitude, double Longitude);

public record DeliveryQuoteRequest(
    string? Address,
    string? Neighborhood,
    string? City,
    string? State,
    string? Cep,
    double? Latitude,
    double? Longitude,
    string? Number = null);

public record DeliveryQuoteResponse(
    bool Ok,
    string? Error,
    double DistanceKm,
    decimal Fee,
    decimal MaxDeliveryKm,
    bool WithinRange,
    string Mode,
    decimal FeePerKm = 0,
    decimal MinDeliveryFee = 0);

public record PlatformPaymentDto(DateTime PaidAt, decimal Amount, string? Note);

public record GalleryImageDto(string Id, string Title, string Type, string Url, DateTime CreatedAt);

public record PlatformStoreDto(
    Guid Id,
    string Name,
    string? FrontUrl,
    string? FrontNotes,
    string? BackUrl,
    string? BackNotes,
    string? DatabaseInfo,
    string? DatabaseUrl,
    string? AdminUrl,
    string? LocalFrontUrl,
    string? LocalBackUrl,
    string? LocalAdminUrl,
    string? LocalDatabaseUrl,
    decimal MonthlyFee,
    bool Courtesy,
    DateTime? CourtesyUntil,
    string PaymentStatus,
    DateTime? LastPaymentAt,
    DateTime? NextDueAt,
    string? PaymentNotes,
    List<PlatformPaymentDto> Payments,
    bool Active,
    DateTime CreatedAt,
    DateTime UpdatedAt,
    int? StoreId = null,
    string? Cnpj = null,
    string? RazaoSocial = null,
    string? ContactName = null,
    string? Phone = null,
    string? Email = null,
    string? Address = null,
    string? AddressNumber = null,
    string? Cep = null,
    string? City = null,
    string? State = null,
    string? LogoUrl = null,
    string Status = "active",
    string? Plan = null,
    string? Segment = null,
    string? Domain = null,
    string? ApiKey = null,
    string? WebhookUrl = null,
    List<GalleryImageDto>? Gallery = null,
    DateTime? LastAccessAt = null,
    string? BackUsername = null,
    string? BackPassword = null,
    StoreStatsDto? Stats = null,
    /// <summary>Bloqueada automaticamente por mensalidade em atraso.</summary>
    bool BillingBlocked = false,
    DateTime? BillingBlockSuspendedUntil = null);

/// <summary>Ajuste da cobrança da loja (painel da plataforma → Cobrança). Campos nulos não mudam.</summary>
public class UpdatePlatformBillingRequest
{
    public decimal? MonthlyFee { get; set; }
    public bool? Courtesy { get; set; }
    /// <summary>Fim da cortesia/teste grátis. Use ClearCourtesyUntil para cortesia sem prazo.</summary>
    public DateTime? CourtesyUntil { get; set; }
    public bool? ClearCourtesyUntil { get; set; }
    public DateTime? NextDueAt { get; set; }
    public string? PaymentNotes { get; set; }
}

public record SetPlatformStoreBlockedRequest(bool Blocked);

/// <summary>
/// Snapshot de estatísticas da loja (acessos ao cardápio digital e pedidos), obtido
/// da API da loja — local (Fabin/StoreId=1) ou remota via BackUrl. Acessos ao cardápio
/// contam todos os buckets pageview; pedidos contam todos os pedidos criados (incl. cancelados).
/// </summary>
public record StoreStatsDto(
    DateTime FetchedAt,
    string? Error,
    DateTime? LastAccessAt,
    long MenuViews30d,
    long MenuViewsTotal,
    long? Orders30d,
    long? OrdersTotal,
    bool OrdersAvailable);

public class UpsertPlatformStoreRequest
{
    public string Name { get; set; } = "";
    public string? FrontUrl { get; set; }
    public string? FrontNotes { get; set; }
    public string? BackUrl { get; set; }
    public string? BackNotes { get; set; }
    public string? DatabaseInfo { get; set; }
    public string? DatabaseUrl { get; set; }
    public string? AdminUrl { get; set; }
    public string? LocalFrontUrl { get; set; }
    public string? LocalBackUrl { get; set; }
    public string? LocalAdminUrl { get; set; }
    public string? LocalDatabaseUrl { get; set; }
    public decimal MonthlyFee { get; set; }
    public bool Courtesy { get; set; }
    public DateTime? CourtesyUntil { get; set; }
    public string? PaymentStatus { get; set; }
    public DateTime? LastPaymentAt { get; set; }
    public DateTime? NextDueAt { get; set; }
    public string? PaymentNotes { get; set; }
    public bool Active { get; set; } = true;
    public int? StoreId { get; set; }
    public string? Cnpj { get; set; }
    public string? RazaoSocial { get; set; }
    public string? ContactName { get; set; }
    public string? Phone { get; set; }
    public string? Email { get; set; }
    public string? Address { get; set; }
    public string? AddressNumber { get; set; }
    public string? Cep { get; set; }
    public string? City { get; set; }
    public string? State { get; set; }
    public string? LogoUrl { get; set; }
    public string? Status { get; set; }
    public string? Plan { get; set; }
    public string? Segment { get; set; }
    public string? Domain { get; set; }
    public string? ApiKey { get; set; }
    public string? WebhookUrl { get; set; }
    /// <summary>Credenciais admin da API remota (usadas por Comparar/Sincronizar).</summary>
    public string? BackUsername { get; set; }
    public string? BackPassword { get; set; }
    /// <summary>Usuário admin inicial da loja (somente no create/duplicate).</summary>
    public string? AdminUsername { get; set; }
    /// <summary>Senha inicial do usuário admin (somente no create/duplicate).</summary>
    public string? AdminPassword { get; set; }
}

public record CreatePlatformStoreResponse(
    PlatformStoreDto Store,
    string AdminUsername,
    string? AdminPassword,
    bool TenantCreated);

public record StoreUserDto(int Id, string Username, string Role, int? StoreId, string? DisplayName = null, bool HasPin = false);

public record AdminLoginInfo(int Id, string Username, string Role, int? StoreId);

public record CreateStoreUserRequest(
    string Username,
    string Password,
    string Role,
    int? StoreId = null,
    string? DisplayName = null,
    string? Pin = null);

public record UpdateStoreUserRequest(
    string Username,
    string Role,
    string? DisplayName = null,
    string? Password = null,
    string? Pin = null);

public record ResetStoreUserPasswordRequest(string Password);

public record UpdateProfileRequest(string? DisplayName);

public record ChangePasswordRequest(string CurrentPassword, string NewPassword);

public record ProfileResponse(string Username, string Role, int? StoreId, string? DisplayName);

// ── PIN (camada adicional ao JWT para ações dine-in sensíveis) ──
public record PinSetRequest(string Pin);
public record PinValidateRequest(string Pin);
public record PinSessionVerifyRequest(string SessionId);
public record PinStatusResponse(bool HasPin, bool HasValidSession);
public record PinValidateResponse(string SessionId, DateTime ExpiresAtUtc);
public record PinSessionVerifyResponse(bool Valid, DateTime? ExpiresAtUtc, bool HasPin);

public record RegisterGalleryImageRequest(string Title, string Type);

public class RegisterPlatformPaymentRequest
{
    public DateTime? PaidAt { get; set; }
    public decimal? Amount { get; set; }
    public string? Note { get; set; }
    /// <summary>Próximo vencimento após este pagamento (opcional).</summary>
    public DateTime? NextDueAt { get; set; }
}

public record TrafficHitRequest(string? Source, string? Route, string? Path, int? Count);

public record TrafficPageviewRequest(string? Path);

public class DbColumnInfo
{
    public string Name { get; set; } = string.Empty;
    public string DataType { get; set; } = string.Empty;
    public bool IsPrimaryKey { get; set; }
    public bool IsIdentity { get; set; }
    public bool IsNullable { get; set; }
    public bool HasDefault { get; set; }
    public int? MaxLength { get; set; }
    public bool IsJson { get; set; }
}

public class DbTableInfo
{
    public string Table { get; set; } = string.Empty;
    /// <summary>Verdadeiro quando a tabela tem coluna StoreId (multi-tenant).</summary>
    public bool Tenant { get; set; }
    public bool HasPk { get; set; }
    public List<DbColumnInfo> Columns { get; set; } = new();
}

public class DbTableRowsResult
{
    public string Table { get; set; } = string.Empty;
    public int Page { get; set; }
    public int PageSize { get; set; }
    public long Total { get; set; }
    public List<DbColumnInfo> Columns { get; set; } = new();
    public List<Dictionary<string, object?>> Rows { get; set; } = new();
}

public record DbStoreInfo(int Id, string Name);

// ── Ferramentas de loja (Comparar / Backup / Sincronizar remoto→local) ──

public record ToolsStoreStatusDto(
    bool ServiceAvailable,
    string? RemoteBaseUrl,
    bool HasRemoteCreds,
    bool RemoteReachable,
    string? RemoteError,
    DateTime? LastBackupAt,
    int LocalCategories,
    int LocalProducts,
    int LocalIngredients,
    string? LocalStoreName);

public record ToolsFieldDiffDto(string Field, string? Local, string? Remote);

public record ToolsProductDiffDto(string Id, string Name, List<string> ChangedFields);

public record ToolsCompareReportDto(
    string Mode,                      // "admin" | "public" | "error"
    string? RemoteBaseUrl,
    List<string> Warnings,
    int CategoriesLocal,
    int CategoriesRemote,
    int ProductsLocal,
    int ProductsRemote,
    int IngredientsLocal,
    int IngredientsRemote,
    int EqualProducts,
    List<string> CategoriesOnlyLocal,
    List<string> CategoriesOnlyRemote,
    List<string> ProductsOnlyLocal,
    List<string> ProductsOnlyRemote,
    List<string> IngredientsOnlyLocal,
    List<string> IngredientsOnlyRemote,
    List<ToolsProductDiffDto> ChangedProducts,
    List<string> ImagesMissingLocal,
    List<ToolsFieldDiffDto> StoreDiffs,
    bool StoreConfigEqual,
    string? StoreNameLocal,
    string? StoreNameRemote);

public record ToolsBackupResultDto(
    int StoreId,
    string Directory,
    int Categories,
    int Products,
    int Ingredients,
    int ImagesDownloaded,
    int ImagesExisting,
    int ImagesFailed,
    List<string> Warnings,
    DateTime CreatedAt);

public record ToolsSyncReportDto(
    int StoreId,
    bool DryRun,
    bool SkipDelete,
    string Mode,
    int CategoriesSynced,
    int CategoriesDeleted,
    int IngredientsSynced,
    int IngredientsDeleted,
    int ProductsSynced,
    int ProductsDeleted,
    int ImagesDownloaded,
    int ImagesExisting,
    int ImagesUpdated,
    int ImagesFailed,
    bool StoreUpdated,
    int ProductsOnlyLocal,
    int CategoriesOnlyLocal,
    int IngredientsOnlyLocal,
    List<string> Warnings,
    string? Error);

/// <summary>
/// Seletor de escopo de sincronização (download remoto→local e upload local→remoto).
/// Listas nulas/vazias significam "todos". Permite restringir a operação a um subconjunto.
/// </summary>
public record SyncSelectionDto(
    List<string>? SyncCategories = null,
    List<string>? SyncProducts = null,
    List<string>? SyncIngredients = null,
    bool IncludeStore = true,
    bool IncludeImages = true);

/// <summary>
/// Plano de ação detalhado calculado pelo preview de sincronização (download remoto→local),
/// antes de aplicar qualquer mudança.
/// </summary>
public record ToolsSyncPreviewDto(
    string Mode,
    string? RemoteBaseUrl,
    List<string> Warnings,
    int CategoriesToCreate,
    int CategoriesToUpdate,
    int CategoriesEqual,
    int CategoriesToDelete,
    int IngredientsToCreate,
    int IngredientsToUpdate,
    int IngredientsEqual,
    int IngredientsToDelete,
    int ProductsToCreate,
    int ProductsToUpdate,
    int ProductsEqual,
    int ProductsToDelete,
    int ImagesToDownload,
    int ImagesUpToDate,
    int ImagesToDelete,
    List<ToolsProductDiffDto> NewProducts,
    List<ToolsProductDiffDto> UpdatedProducts,
    List<string> ProductsOnlyLocal,
    List<string> CategoriesOnlyLocal,
    List<string> IngredientsOnlyLocal,
    List<string> CategoriesOnlyRemote,
    List<string> IngredientsOnlyRemote,
    List<string> ImagesToDownloadPaths,
    List<string> ImagesToDeletePaths,
    List<ToolsFieldDiffDto> StoreDiffs,
    bool StoreConfigEqual,
    bool StoreWillUpdate,
    bool IncludeDelete,
    string? StoreName,
    string? Error);

/// <summary>
/// Plano de ação detalhado do upload local→remoto (antes de aplicar qualquer mudança no remoto).
/// </summary>
public record ToolsUploadPreviewDto(
    string Mode,
    string? RemoteBaseUrl,
    List<string> Warnings,
    int CategoriesToCreate,
    int CategoriesToUpdate,
    int CategoriesEqual,
    int CategoriesToDelete,
    int IngredientsToCreate,
    int IngredientsToUpdate,
    int IngredientsEqual,
    int IngredientsToDelete,
    int ProductsToCreate,
    int ProductsToUpdate,
    int ProductsEqual,
    int ProductsToDelete,
    int ImagesToUpload,
    int ImagesUpdate,
    bool StoreWillUpdate,
    bool IncludeDelete,
    List<ToolsProductDiffDto> NewProducts,
    List<ToolsProductDiffDto> UpdatedProducts,
    List<string> ProductsOnlyRemote,
    List<string> CategoriesOnlyRemote,
    List<string> IngredientsOnlyRemote,
    List<string> ImagesToUploadPaths,
    List<ToolsFieldDiffDto> StoreDiffs,
    string? Error);

/// <summary>
/// Resultado do upload local→remoto.
/// </summary>
public record ToolsUploadResultDto(
    int StoreId,
    bool DryRun,
    bool SkipDelete,
    string Mode,
    int CategoriesSynced,
    int CategoriesDeleted,
    int IngredientsSynced,
    int IngredientsDeleted,
    int ProductsSynced,
    int ProductsDeleted,
    int ImagesUploaded,
    int ImagesFailed,
    bool StoreUpdated,
    List<string> Warnings,
    string? Error);

public record ToolsBackupEntryDto(string Name, DateTime CreatedAt, int Categories, int Products, int Ingredients, int Images, long SizeBytes);

public record ToolsBackupListDto(int StoreId, List<ToolsBackupEntryDto> Backups);

/// <summary>
/// Plano de ação da sincronização de pedidos (remoto→local) antes de aplicar.
/// Pedidos remotos novos serão inseridos; os já existentes localmente (mesmo OrderId)
/// serão substituídos pelo estado remoto. Nada é excluído.
/// </summary>
public record ToolsOrdersPreviewDto(
    string Mode,
    string? RemoteBaseUrl,
    List<string> Warnings,
    int OrdersToCreate,
    int OrdersToReplace,
    int OrdersEqual,
    int TotalRemote,
    List<string> SampleNewOrderIds,
    string? Error);

/// <summary>
/// Resultado da sincronização de pedidos remoto→local após aplicar.
/// </summary>
public record ToolsOrdersSyncReportDto(
    int StoreId,
    bool DryRun,
    string Mode,
    int OrdersCreated,
    int OrdersReplaced,
    int OrdersEqual,
    int OrdersFailed,
    List<string> Warnings,
    string? Error);

public record TrafficHourBucketDto(string Label, int Hour, string Date, long Pageviews, long ApiHits);

public record TrafficDayBucketDto(string Date, long Pageviews, long ApiHits);

public record TrafficRouteCountDto(string Route, long Count);

public record RailwayUsageHintDto(
    string DashboardUrl,
    long ApiHitsPeriod,
    string Note,
    string EstimatedNote);

public record TrafficSummaryDto(
    int Days,
    string TimeZone,
    long PageviewsToday,
    long PageviewsPeriod,
    long ApiHitsToday,
    long ApiHitsPeriod,
    string? PeakHourLabel,
    long PeakHourCount,
    List<TrafficHourBucketDto> Last24Hours,
    List<TrafficDayBucketDto> Daily,
    List<TrafficRouteCountDto> TopRoutes,
    RailwayUsageHintDto Railway);
