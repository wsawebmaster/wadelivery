using Catalog.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Data;

public class CatalogDbContext(DbContextOptions<CatalogDbContext> options) : DbContext(options)
{
    public DbSet<Loja> Stores => Set<Loja>();
    public DbSet<CategoryEntity> Categories => Set<CategoryEntity>();
    public DbSet<ProductEntity> Products => Set<ProductEntity>();
    public DbSet<IngredientEntity> Ingredients => Set<IngredientEntity>();
    public DbSet<ProductIngredientEntity> ProductIngredients => Set<ProductIngredientEntity>();
    public DbSet<AdminUserEntity> AdminUsers => Set<AdminUserEntity>();
    public DbSet<PinSessionEntity> PinSessions => Set<PinSessionEntity>();
    public DbSet<PlatformAuditEntity> PlatformAudit => Set<PlatformAuditEntity>();
    public DbSet<PlatformStoreEntity> PlatformStores => Set<PlatformStoreEntity>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<Loja>(e =>
        {
            e.ToTable("stores");
            e.HasKey(x => x.Id);
            e.Property(x => x.Nome).HasColumnName("StoreName").HasMaxLength(200).IsRequired();
            e.Ignore(x => x.StoreName);
            e.Property(x => x.Telefone).HasColumnName("Whatsapp").HasMaxLength(32).IsRequired();
            e.Ignore(x => x.Whatsapp);
            e.Property(x => x.Endereco).HasColumnName("Address").HasMaxLength(400);
            e.Ignore(x => x.Address);
            e.Ignore(x => x.CNPJ);
            e.Ignore(x => x.TenantId);
            e.Property(x => x.Cnpj).HasMaxLength(18);
            e.Property(x => x.Email).HasMaxLength(200);
            e.Property(x => x.LogoUrl).HasMaxLength(500);
            e.Property(x => x.BannerUrl).HasMaxLength(500);
            e.Property(x => x.CoverUrl).HasMaxLength(500);
            e.Property(x => x.CorPrimaria).HasMaxLength(7).IsRequired();
            e.Property(x => x.CorSecundaria).HasMaxLength(7).IsRequired();
            e.Property(x => x.CorFundo).HasMaxLength(7).IsRequired();
            e.Property(x => x.CorTexto).HasMaxLength(7).IsRequired();
            e.Property(x => x.TipoCard).HasMaxLength(32).IsRequired();
            e.Property(x => x.LayoutCardapio).HasMaxLength(32).IsRequired();
            e.Property(x => x.EstiloBotao).HasMaxLength(24).IsRequired();
            e.Property(x => x.PixKeyLabel).HasMaxLength(64).IsRequired();
            e.Property(x => x.PixKey).HasMaxLength(128).IsRequired();
            e.Property(x => x.CurrencyLocale).HasMaxLength(16);
            e.Property(x => x.ScheduleJson).HasColumnType("text");
            e.Property(x => x.DeliveryFeesJson).HasColumnType("text");
            e.Property(x => x.Cep).HasMaxLength(16);
            e.Property(x => x.DeliveryFeePerKm).HasPrecision(10, 2);
            e.Property(x => x.MaxDeliveryKm).HasPrecision(10, 2);
            e.Property(x => x.MinDeliveryFee).HasPrecision(10, 2);
            e.Property(x => x.BreadOptionsJson).HasColumnType("text");
            e.Property(x => x.AddressNumber).HasMaxLength(32);
            e.Property(x => x.IconUrl).HasMaxLength(400);
            e.Property(x => x.DataCriacao).HasDefaultValueSql("now()");
            e.Property(x => x.DataAtualizacao).HasDefaultValueSql("now()");
            e.HasIndex(x => x.Slug).IsUnique().HasFilter("\"Slug\" IS NOT NULL");
        });

        modelBuilder.Entity<CategoryEntity>(e =>
        {
            e.ToTable("categories");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.StoreId).IsRequired();
            e.Property(x => x.Title).HasMaxLength(120).IsRequired();
            e.HasIndex(x => x.StoreId);
            e.HasMany(x => x.Products).WithOne(x => x.Category).HasForeignKey(x => x.CategoryId);
        });

        modelBuilder.Entity<ProductEntity>(e =>
        {
            e.ToTable("products");
            e.HasKey(x => x.Id);
            e.Property(x => x.Badge).HasMaxLength(32);
            e.Property(x => x.Id).HasMaxLength(96);
            e.Property(x => x.StoreId).IsRequired();
            e.Property(x => x.CategoryId).HasMaxLength(64).IsRequired();
            e.Property(x => x.Name).HasMaxLength(200).IsRequired();
            e.Property(x => x.Price).HasPrecision(10, 2);
            e.Property(x => x.PriceMedia).HasPrecision(10, 2);
            e.Property(x => x.PriceInteira).HasPrecision(10, 2);
            e.Property(x => x.ImageUrl).HasMaxLength(400);
            e.Property(x => x.Description).HasMaxLength(800);
            e.Property(x => x.ModifierGroupsJson).HasColumnType("text");
            e.HasIndex(x => x.CategoryId);
            e.HasIndex(x => x.StoreId);
            e.HasIndex(x => new { x.CategoryId, x.SortOrder });
            e.HasMany(x => x.ProductIngredients)
                .WithOne(x => x.Product)
                .HasForeignKey(x => x.ProductId)
                .OnDelete(DeleteBehavior.Cascade);
        });

        modelBuilder.Entity<IngredientEntity>(e =>
        {
            e.ToTable("ingredients");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).HasMaxLength(64);
            e.Property(x => x.StoreId).IsRequired();
            e.Property(x => x.Name).HasMaxLength(120).IsRequired();
            e.Property(x => x.CategoryId).HasMaxLength(64);
            e.HasMany(x => x.ProductIngredients)
                .WithOne(x => x.Ingredient)
                .HasForeignKey(x => x.IngredientId)
                .OnDelete(DeleteBehavior.Cascade);
            e.HasIndex(x => x.StoreId);
            e.HasIndex(x => x.CategoryId);
        });

        modelBuilder.Entity<ProductIngredientEntity>(e =>
        {
            e.ToTable("product_ingredients");
            e.HasKey(x => new { x.ProductId, x.IngredientId });
            e.Property(x => x.ProductId).HasMaxLength(96);
            e.Property(x => x.IngredientId).HasMaxLength(64);
            e.Property(x => x.IsPrincipal).IsRequired();
            e.HasIndex(x => x.IngredientId);
            e.HasIndex(x => new { x.ProductId, x.SortOrder });
        });

        modelBuilder.Entity<AdminUserEntity>(e =>
        {
            e.ToTable("admin_users");
            e.HasKey(x => x.Id);
            e.Property(x => x.Username).HasMaxLength(64).IsRequired();
            e.HasIndex(x => x.Username).IsUnique();
            e.Property(x => x.PasswordHash).HasMaxLength(200).IsRequired();
            e.Property(x => x.Role).HasMaxLength(32).IsRequired();
            e.Property(x => x.DisplayName).HasMaxLength(120);
            e.Property(x => x.PinHash).HasMaxLength(200);
            e.HasIndex(x => x.StoreId);
        });

        modelBuilder.Entity<PlatformAuditEntity>(e =>
        {
            e.ToTable("platform_audit");
            e.HasKey(x => x.Id);
            e.Property(x => x.Id).UseIdentityByDefaultColumn();
            e.Property(x => x.Actor).HasMaxLength(120).IsRequired();
            e.Property(x => x.Action).HasMaxLength(60).IsRequired();
            e.HasIndex(x => new { x.PlatformStoreId, x.At });
            e.HasIndex(x => x.At);
        });

        modelBuilder.Entity<PinSessionEntity>(e =>
        {
            e.ToTable("pin_sessions");
            e.HasKey(x => x.Id);
            e.Property(x => x.SessionId).HasMaxLength(64).IsRequired();
            e.HasIndex(x => x.SessionId).IsUnique();
            e.HasIndex(x => new { x.AdminUserId, x.StoreId });
            e.HasIndex(x => x.ExpiresAtUtc);
        });

        modelBuilder.Entity<PlatformStoreEntity>(e =>
        {
            e.ToTable("platform_stores");
            e.HasKey(x => x.Id);
            e.Property(x => x.Name).HasMaxLength(200).IsRequired();
            e.Property(x => x.FrontUrl).HasMaxLength(500);
            e.Property(x => x.FrontNotes).HasMaxLength(500);
            e.Property(x => x.BackUrl).HasMaxLength(500);
            e.Property(x => x.BackNotes).HasMaxLength(500);
            e.Property(x => x.DatabaseInfo).HasMaxLength(800);
            e.Property(x => x.DatabaseUrl).HasMaxLength(500);
            e.Property(x => x.AdminUrl).HasMaxLength(500);
            e.Property(x => x.LocalFrontUrl).HasMaxLength(500);
            e.Property(x => x.LocalBackUrl).HasMaxLength(500);
            e.Property(x => x.LocalAdminUrl).HasMaxLength(500);
            e.Property(x => x.LocalDatabaseUrl).HasMaxLength(500);
            e.Property(x => x.MonthlyFee).HasPrecision(10, 2);
            e.Property(x => x.PaymentStatus).HasMaxLength(32);
            e.Property(x => x.PaymentNotes).HasMaxLength(500);
            e.Property(x => x.PaymentsJson).HasColumnType("text");
            e.Property(x => x.Cnpj).HasMaxLength(18);
            e.Property(x => x.RazaoSocial).HasMaxLength(200);
            e.Property(x => x.ContactName).HasMaxLength(200);
            e.Property(x => x.Phone).HasMaxLength(40);
            e.Property(x => x.Email).HasMaxLength(200);
            e.Property(x => x.Address).HasMaxLength(300);
            e.Property(x => x.AddressNumber).HasMaxLength(32);
            e.Property(x => x.Cep).HasMaxLength(16);
            e.Property(x => x.City).HasMaxLength(120);
            e.Property(x => x.State).HasMaxLength(2);
            e.Property(x => x.LogoUrl).HasMaxLength(500);
            e.Property(x => x.Status).HasMaxLength(20);
            e.Property(x => x.Plan).HasMaxLength(30);
            e.Property(x => x.Segment).HasMaxLength(50);
            e.Property(x => x.Domain).HasMaxLength(200);
            e.Property(x => x.ApiKey).HasMaxLength(200);
            e.Property(x => x.WebhookUrl).HasMaxLength(500);
            e.Property(x => x.GalleryJson).HasColumnType("text");
            e.Property(x => x.StatsJson).HasColumnType("text");
            e.HasIndex(x => x.StoreId);
        });
    }
}
