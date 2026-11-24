namespace Catalog.Api.Data;

public class CategoryEntity
{
    public string Id { get; set; } = string.Empty;
    public int StoreId { get; set; } = 1;
    public string Title { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    /// <summary>Quando false, a categoria não aparece no cardápio público.</summary>
    public bool ShowInMenu { get; set; } = true;
    public List<ProductEntity> Products { get; set; } = [];
}

public class ProductEntity
{
    public string Id { get; set; } = string.Empty;
    /// <summary>Tenant/loja dona deste produto. Multi-tenancy row-level.</summary>
    public int StoreId { get; set; } = 1;
    public string CategoryId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public decimal Price { get; set; }
    /// <summary>Preço da porção média (categoria Porções).</summary>
    public decimal? PriceMedia { get; set; }
    /// <summary>Preço da porção inteira (categoria Porções).</summary>
    public decimal? PriceInteira { get; set; }
    public bool Available { get; set; } = true;
    /// <summary>Quando false, o produto fica só no admin e não aparece no cardápio público.</summary>
    public bool ShowInMenu { get; set; } = true;
    public string? ImageUrl { get; set; }
    /// <summary>Texto livre opcional (legado / observação).</summary>
    public string? Description { get; set; }
    public int SortOrder { get; set; }
    /// <summary>JSON com os grupos de modificadores do produto (adicionais cobrados etc.).</summary>
    public string? ModifierGroupsJson { get; set; }
    /// <summary>Selo de destaque no card (ver CatalogInputValidation.ProductBadges); null = sem selo.</summary>
    public string? Badge { get; set; }
    public CategoryEntity? Category { get; set; }
    public List<ProductIngredientEntity> ProductIngredients { get; set; } = [];
}

public class IngredientEntity
{
    public string Id { get; set; } = string.Empty;
    /// <summary>Tenant/loja dona deste ingrediente. Multi-tenancy row-level.</summary>
    public int StoreId { get; set; } = 1;
    public string Name { get; set; } = string.Empty;
    public int SortOrder { get; set; }
    /// <summary>Categoria opcional para organizar o acervo de ingredientes no painel.</summary>
    public string? CategoryId { get; set; }
    public bool Available { get; set; } = true;
    public List<ProductIngredientEntity> ProductIngredients { get; set; } = [];
}

public class ProductIngredientEntity
{
    public string ProductId { get; set; } = string.Empty;
    public string IngredientId { get; set; } = string.Empty;
    /// <summary>Ordem do ingrediente neste produto.</summary>
    public int SortOrder { get; set; }
    /// <summary>Ingrediente principal deste produto — o cliente não pode remover ao personalizar.</summary>
    public bool IsPrincipal { get; set; }
    public ProductEntity? Product { get; set; }
    public IngredientEntity? Ingredient { get; set; }
}

public class AdminUserEntity
{
    public int Id { get; set; }
    /// <summary>Tenant/loja vinculada ao usuário. Null = Dev global (acesso todas as lojas).</summary>
    public int? StoreId { get; set; }
    public string Username { get; set; } = string.Empty;
    public string PasswordHash { get; set; } = string.Empty;
    public string Role { get; set; } = "Admin";
    /// <summary>Nome de exibição opcional definido pelo próprio usuário no painel admin.</summary>
    public string? DisplayName { get; set; }
    /// <summary>Hash do PIN de 4 dígitos (camada adicional sobre o JWT) para autorizar ações dine-in sensíveis.</summary>
    public string? PinHash { get; set; }
    /// <summary>
    /// Senha definida por outra pessoa (temporária do cadastro ou redefinida pela plataforma/
    /// administrador): o painel exige trocar antes de continuar.
    /// </summary>
    public bool MustChangePassword { get; set; }
}

/// <summary>
/// Sessão de PIN validado (camada adicional ao JWT). Cria um "desbloqueio" curto
/// que autoriza o mesmo usuário autenticado a executar ações dine-in sensíveis
/// (financeiras/finalização) sem redigitar o PIN a cada ação. Em modo Json o
/// armazenamento é em memória (IPinSessionStore); em PostgreSQL é a tabela pin_sessions.
/// </summary>
public class PinSessionEntity
{
    public Guid Id { get; set; } = Guid.NewGuid();
    /// <summary>Usuário de staff (admin_users.Id) que validou o PIN.</summary>
    public int AdminUserId { get; set; }
    /// <summary>Tenant/loja da sessão.</summary>
    public int StoreId { get; set; } = 1;
    /// <summary>Token opaco retornado ao cliente — nunca expõe dados do usuário.</summary>
    public string SessionId { get; set; } = string.Empty;
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
    public DateTime ExpiresAtUtc { get; set; }
    public DateTime? RevokedAtUtc { get; set; }
}

/// <summary>Lojas clientes da plataforma (painel Dev) — não é a config operacional da loja.</summary>
public class PlatformStoreEntity
{
    public Guid Id { get; set; } = Guid.NewGuid();
    public string Name { get; set; } = string.Empty;
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
    public string PaymentStatus { get; set; } = "pending"; // pending | paid | overdue | courtesy
    public DateTime? LastPaymentAt { get; set; }
    public DateTime? NextDueAt { get; set; }
    public string? PaymentNotes { get; set; }
    public string PaymentsJson { get; set; } = "[]";
    public bool Active { get; set; } = true;
    /// <summary>Bloqueada automaticamente por mensalidade em atraso (desbloqueia ao pagar).</summary>
    public bool BillingBlocked { get; set; }
    /// <summary>Desbloqueio manual de loja em atraso: o bloqueio automático aguarda até esta data.</summary>
    public DateTime? BillingBlockSuspendedUntil { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>Tenant/loja vinculada (stores.Id). Nulo em instalação JSON de tenant único.</summary>
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
    /// <summary>Status operacional: active | setup | inactive (fonte de verdade do badge).</summary>
    public string Status { get; set; } = "active";
    /// <summary>Plano: basic | premium | trial.</summary>
    public string? Plan { get; set; }
    /// <summary>Segmento de mercado: Açougue, Gás, Hamburgueria, Lanchonete, Pizzaria ou personalizado.</summary>
    public string? Segment { get; set; }
    public string? Domain { get; set; }
    public string? ApiKey { get; set; }
    public string? WebhookUrl { get; set; }
    /// <summary>Credenciais admin da API remota (usadas por Comparar/Sincronizar).</summary>
    public string? BackUsername { get; set; }
    public string? BackPassword { get; set; }
    public string GalleryJson { get; set; } = "[]";
    public DateTime? LastAccessAt { get; set; }
    /// <summary>Snapshot de estatísticas da loja (acessos ao cardápio + pedidos), serializado em camelCase.</summary>
    public string? StatsJson { get; set; }
}
