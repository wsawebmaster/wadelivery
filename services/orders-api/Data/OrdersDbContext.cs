using Microsoft.EntityFrameworkCore;
using Orders.Api.Models;

namespace Orders.Api.Data;

public class OrderEntity
{
    public int Id { get; set; }
    public string OrderId { get; set; } = string.Empty;
    /// <summary>Tenant/loja dona deste pedido. Multi-tenancy row-level.</summary>
    public int StoreId { get; set; }
    public string CustomerName { get; set; } = string.Empty;
    public string CustomerPhone { get; set; } = string.Empty;
    public string Address { get; set; } = string.Empty;
    public string? Neighborhood { get; set; }
    public string? Cep { get; set; }
    public string? Reference { get; set; }
    public string PaymentMethod { get; set; } = string.Empty;
    /// <summary>now | on_delivery</summary>
    public string PaymentTiming { get; set; } = "on_delivery";
    /// <summary>pending | confirmed | on_delivery</summary>
    public string PaymentStatus { get; set; } = "on_delivery";
    public string? Notes { get; set; }
    public decimal DeliveryFee { get; set; }
    public decimal ItemsTotal { get; set; }
    public string ItemsJson { get; set; } = "[]";
    public string Status { get; set; } = "Created";
    public DateTime CreatedAtUtc { get; set; }
    public DateTime? StatusUpdatedAtUtc { get; set; }
    /// <summary>Momento em que o pedido saiu de Created (confirmação). Usado no prazo de entrega.</summary>
    public DateTime? AcceptedAtUtc { get; set; }
    /// <summary>Token opaco para consulta pública do pedido (anti-IDOR).</summary>
    public string? AccessToken { get; set; }
    /// <summary>Cliente confirmou o recebimento/retirada; delivery/pickup finaliza após a baixa do pagamento.</summary>
    public DateTime? CustomerReceivedAtUtc { get; set; }
    /// <summary>Código do motivo de cancelamento (preset).</summary>
    public string? CancellationReasonCode { get; set; }
    /// <summary>Texto do motivo exibido ao cliente.</summary>
    public string? CancellationReason { get; set; }
    /// <summary>True quando o cancelamento foi a pedido do cliente.</summary>
    public bool CancellationCustomerRequested { get; set; }
    /// <summary>delivery | pickup | dine_in</summary>
    public string FulfillmentType { get; set; } = "delivery";
    public DateTime? ItemsUpdatedAtUtc { get; set; }
    /// <summary>Resumo legível do que mudou na última alteração de itens.</summary>
    public string? ItemsChangeSummary { get; set; }
    /// <summary>Subtotal dos itens antes da última alteração pelo atendimento.</summary>
    public decimal? PreviousItemsTotal { get; set; }
    /// <summary>Cliente pediu troco (pagamento em dinheiro).</summary>
    public bool NeedsChange { get; set; }
    /// <summary>Valor informado pelo cliente: "troco para quanto?" (dinheiro).</summary>
    public decimal? ChangeFor { get; set; }
    // ── Dine-in fields ──
    /// <summary>Referência à mesa (store_tables.Id). Null para delivery/pickup.</summary>
    public int? TableId { get; set; }
    /// <summary>Snapshot do label da mesa no momento do pedido.</summary>
    public string? TableLabel { get; set; }
    /// <summary>Código de acesso da mesa usado para criar o pedido (customer_qr).</summary>
    public string? TableAccessCode { get; set; }
    /// <summary>Origem do pedido: customer_qr | waiter_panel | admin_panel.</summary>
    public string? OrderSource { get; set; }
    /// <summary>ID do usuário que criou o pedido (admin_users.Id).</summary>
    public int? CreatedByUserId { get; set; }
    /// <summary>Snapshot do username do criador.</summary>
    public string? CreatedByUsername { get; set; }
    /// <summary>Snapshot do papel (role) do criador no JWT: Admin | Atendimento | Garçom.</summary>
    public string? CreatedByRole { get; set; }
    /// <summary>ID do garçom responsável (admin_users.Id). Pode diferir de CreatedByUserId.</summary>
    public int? WaiterId { get; set; }
    /// <summary>Snapshot do nome do garçom.</summary>
    public string? WaiterName { get; set; }
    /// <summary>Sessão de atendimento (futuro). Mantido para extensão.</summary>
    public string? DiningSessionId { get; set; }
    /// <summary>Chave de idempotência do cliente (evita duplicidade em reenvios).</summary>
    public string? ClientRequestId { get; set; }
}

public class OrdersDbContext(DbContextOptions<OrdersDbContext> options) : DbContext(options)
{
    public DbSet<OrderEntity> Orders => Set<OrderEntity>();
    public DbSet<StoreTable> StoreTables => Set<StoreTable>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<OrderEntity>(e =>
        {
            e.ToTable("orders");
            e.HasKey(x => x.Id);
            e.HasIndex(x => x.OrderId).IsUnique();
            e.HasIndex(x => x.AccessToken);
            e.HasIndex(x => x.StoreId);
            e.HasIndex(x => x.TableId);
            e.HasIndex(x => x.OrderSource);
            e.Property(x => x.OrderId).HasMaxLength(64).IsRequired();
            e.Property(x => x.StoreId).IsRequired();
            e.Property(x => x.CustomerName).HasMaxLength(120).IsRequired();
            e.Property(x => x.CustomerPhone).HasMaxLength(32).IsRequired();
            e.Property(x => x.Address).HasMaxLength(400).IsRequired();
            e.Property(x => x.Neighborhood).HasMaxLength(120);
            e.Property(x => x.Cep).HasMaxLength(16);
            e.Property(x => x.PaymentMethod).HasMaxLength(64).IsRequired();
            e.Property(x => x.PaymentTiming).HasMaxLength(24);
            e.Property(x => x.PaymentStatus).HasMaxLength(24);
            e.Property(x => x.DeliveryFee).HasPrecision(10, 2);
            e.Property(x => x.ItemsTotal).HasPrecision(10, 2);
            e.Property(x => x.ItemsJson).HasColumnType("text");
            e.Property(x => x.Status).HasMaxLength(32);
            e.Property(x => x.AccessToken).HasMaxLength(64);
            e.Property(x => x.CancellationReasonCode).HasMaxLength(64);
            e.Property(x => x.CancellationReason).HasMaxLength(400);
            e.Property(x => x.FulfillmentType).HasMaxLength(16);
            e.Property(x => x.ItemsChangeSummary).HasMaxLength(1000);
            e.Property(x => x.PreviousItemsTotal).HasPrecision(10, 2);
            e.Property(x => x.ChangeFor).HasPrecision(10, 2);
            // Dine-in
            e.Property(x => x.TableLabel).HasMaxLength(100);
            e.Property(x => x.TableAccessCode).HasMaxLength(64);
            e.Property(x => x.OrderSource).HasMaxLength(32);
            e.Property(x => x.CreatedByUsername).HasMaxLength(64);
            e.Property(x => x.CreatedByRole).HasMaxLength(32);
            e.Property(x => x.WaiterName).HasMaxLength(120);
            e.Property(x => x.DiningSessionId).HasMaxLength(64);
            e.Property(x => x.ClientRequestId).HasMaxLength(72);
            // Índice único parcial: NULL não colide (pedidos sem chave continuam existindo)
            e.HasIndex(x => new { x.StoreId, x.ClientRequestId })
                .IsUnique()
                .HasFilter("\"ClientRequestId\" IS NOT NULL");
        });

        modelBuilder.Entity<StoreTable>(e =>
        {
            e.ToTable("store_tables");
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.StoreId, x.AccessCode }).IsUnique();
            e.HasIndex(x => x.StoreId);
            e.Property(x => x.Label).HasMaxLength(100).IsRequired();
            e.Property(x => x.AccessCode).HasMaxLength(64).IsRequired();
            e.Property(x => x.ResponsibleName).HasMaxLength(120);
        });
    }
}
