using System.Text.Json;
using Catalog.Api;
using Catalog.Api.Data;
using Catalog.Api.Models;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Data;

public static class DbSeeder
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public static async Task SeedAsync(IServiceProvider services, IConfiguration config, CancellationToken ct = default)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CatalogDbContext>();
        var env = scope.ServiceProvider.GetRequiredService<IHostEnvironment>();
        await db.Database.EnsureCreatedAsync(ct);

        if (await db.Stores.AnyAsync(ct))
        {
            await SyncStoreIdSequenceAsync(db, ct);
            await MigrateStoreAdminUrlsAsync(db, ct);
            return;
        }

        var configuredRoot = config["Data:Root"];
        string dataRoot;
        if (!string.IsNullOrWhiteSpace(configuredRoot))
        {
            dataRoot = Path.IsPathRooted(configuredRoot)
                ? configuredRoot
                : Path.GetFullPath(Path.Combine(env.ContentRootPath, configuredRoot));
        }
        else
        {
            dataRoot = Path.GetFullPath(Path.Combine(env.ContentRootPath, "..", "..", "data"));
        }

        var storePath = string.IsNullOrWhiteSpace(config["Data:StorePath"])
            ? Path.Combine(dataRoot, "store-config.json")
            : config["Data:StorePath"]!;
        var productsPath = string.IsNullOrWhiteSpace(config["Data:ProductsPath"])
            ? Path.Combine(dataRoot, "products.json")
            : config["Data:ProductsPath"]!;

        StoreDto? storeDto = null;
        CatalogDto? catalogDto = null;

        if (File.Exists(storePath))
        {
            await using var s = File.OpenRead(storePath);
            storeDto = await JsonSerializer.DeserializeAsync<StoreDto>(s, JsonOptions, ct);
        }

        if (File.Exists(productsPath))
        {
            await using var s = File.OpenRead(productsPath);
            catalogDto = await JsonSerializer.DeserializeAsync<CatalogDto>(s, JsonOptions, ct);
        }

        storeDto ??= new StoreDto(
            "Fabin Lanches", null, "5511982470496", "16992496886", "Telefone", 0, "pt-BR",
            new ScheduleDto([1, 2, 3, 4, 5, 6], "18:00", "23:55", "Fechado."),
            new Dictionary<string, decimal>());

        storeDto = storeDto with { Schedule = ScheduleNormalizer.EnsurePerDay(storeDto.Schedule) };

        db.Stores.Add(new Loja
        {
            Id = 1,
            StoreName = storeDto.StoreName,
            LogoUrl = storeDto.LogoUrl,
            Whatsapp = storeDto.Whatsapp,
            PixKey = storeDto.PixKey,
            PixKeyLabel = storeDto.PixKeyLabel,
            MinOrder = storeDto.MinOrder,
            CurrencyLocale = storeDto.CurrencyLocale,
            ScheduleJson = JsonSerializer.Serialize(storeDto.Schedule, JsonOptions),
            DeliveryFeesJson = JsonSerializer.Serialize(storeDto.DeliveryFees, JsonOptions),
            Address = storeDto.Address,
            Cep = storeDto.Cep,
            City = string.IsNullOrWhiteSpace(storeDto.City) ? "Ribeirão Preto" : storeDto.City,
            State = string.IsNullOrWhiteSpace(storeDto.State) ? "SP" : storeDto.State,
            Latitude = storeDto.Latitude,
            Longitude = storeDto.Longitude,
            DeliveryFeePerKm = storeDto.DeliveryFeePerKm,
            MaxDeliveryKm = storeDto.MaxDeliveryKm,
            MinDeliveryFee = storeDto.MinDeliveryFee,
            AverageDeliveryMinutes = storeDto.AverageDeliveryMinutes > 0 ? storeDto.AverageDeliveryMinutes : 40,
            BreadOptionsJson = JsonSerializer.Serialize(
                StoreBreadOptions.Normalize(storeDto.BreadOptions), JsonOptions),
            AcceptingOrders = storeDto.AcceptingOrders,
            AddressNumber = storeDto.AddressNumber,
            IconUrl = storeDto.IconUrl,
            ExtendedCloseUntilUtc = storeDto.ExtendedCloseUntilUtc,
            AutoAdvancePreparing = storeDto.AutoAdvancePreparing,
            AutoAdvancePreparingMinutes = storeDto.AutoAdvancePreparingMinutes > 0 ? storeDto.AutoAdvancePreparingMinutes : 5,
            DineInEnabled = storeDto.DineInEnabled,
            CustomerQrOrdersEnabled = storeDto.CustomerQrOrdersEnabled,
            WaiterOrdersEnabled = storeDto.WaiterOrdersEnabled,
            AllowManualTableEntry = storeDto.AllowManualTableEntry,
            RequireCustomerNameForQrOrder = storeDto.RequireCustomerNameForQrOrder,
            AllowCustomerChooseWaiter = storeDto.AllowCustomerChooseWaiter,
            TableCount = storeDto.TableCount,
            WaiterSessionHours = storeDto.WaiterSessionHours > 0 ? storeDto.WaiterSessionHours : 8,
            Slug = "fabin"
        });

        if (catalogDto is not null)
        {
            foreach (var cat in catalogDto.Categories)
            {
                db.Categories.Add(new CategoryEntity
                {
                    Id = cat.Id,
                    Title = cat.Title,
                    SortOrder = cat.SortOrder,
                    ShowInMenu = CatalogInputValidation.ResolveCategoryShowInMenu(cat.Id, cat.Title, cat.ShowInMenu),
                    StoreId = 1
                });
                var productOrder = 0;
                foreach (var item in cat.Items)
                {
                    productOrder += 1;
                    db.Products.Add(new ProductEntity
                    {
                        Id = item.Id,
                        CategoryId = cat.Id,
                        StoreId = 1,
                        Name = item.Name,
                        Price = item.Price,
                        PriceMedia = item.PriceMedia,
                        PriceInteira = item.PriceInteira,
                        Available = item.Available,
                        ShowInMenu = item.ShowInMenu,
                        ImageUrl = item.ImageUrl,
                        Description = item.Description,
                        SortOrder = item.SortOrder > 0 ? item.SortOrder : productOrder
                    });
                }
            }
        }

        var allowInsecure = config.GetValue("Security:AllowInsecureDefaults", false);
        var adminUser = config["Admin:Username"];
        var adminPass = config["Admin:Password"];
        if (string.IsNullOrWhiteSpace(adminUser) || string.IsNullOrWhiteSpace(adminPass))
        {
            if (!allowInsecure)
                throw new InvalidOperationException(
                    "Admin:Username e Admin:Password são obrigatórios em Production (ou ative Security:AllowInsecureDefaults só em demos).");
            adminUser = "admin";
            adminPass = "admin123";
        }

        db.AdminUsers.Add(new AdminUserEntity
        {
            StoreId = 1,
            Username = adminUser,
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(adminPass),
            Role = "Admin"
        });

        await db.SaveChangesAsync(ct);
        await SyncStoreIdSequenceAsync(db, ct);
    }

    /// <summary>
    /// O seed insere a loja inicial com Id explícito (1), o que não avança a sequência
    /// identity de "stores". Sem este ajuste, a primeira loja provisionada recebe Id 1
    /// e falha com violação de PK_stores. Idempotente: roda a cada inicialização.
    /// </summary>
    /// <summary>
    /// Lojas provisionadas antes do painel por loja apontavam para /admin/legado (painel
    /// compartilhado). Troca para /{slug}/admin. Só altera URLs que terminam em
    /// /admin/legado; endereços externos (ex.: painel em produção) ficam intactos.
    /// </summary>
    private static async Task MigrateStoreAdminUrlsAsync(CatalogDbContext db, CancellationToken ct)
    {
        if (!db.Database.IsNpgsql()) return;
        await TryAlterAsync(db, """
            UPDATE platform_stores AS p
            SET "AdminUrl" = regexp_replace(p."AdminUrl", '/admin/legado/?$', '/' || s."Slug" || '/admin'),
                "LocalAdminUrl" = regexp_replace(p."LocalAdminUrl", '/admin/legado/?$', '/' || s."Slug" || '/admin')
            FROM stores AS s
            WHERE s."Id" = p."StoreId"
              AND s."Slug" IS NOT NULL
              AND (p."AdminUrl" ~ '/admin/legado/?$' OR p."LocalAdminUrl" ~ '/admin/legado/?$')
            """, ct);
    }

    private static async Task SyncStoreIdSequenceAsync(CatalogDbContext db, CancellationToken ct)
    {
        if (!db.Database.IsNpgsql()) return;
        await db.Database.ExecuteSqlRawAsync(
            """
            SELECT setval(
                pg_get_serial_sequence('stores', 'Id'),
                GREATEST((SELECT COALESCE(MAX("Id"), 0) FROM stores), 1),
                (SELECT COUNT(*) > 0 FROM stores))
            """, ct);
    }

    /// <summary>
    /// Garante usuários de staff. Senhas de demo só com AllowInsecureDefaults.
    /// </summary>
    public static async Task EnsureStaffUsersAsync(IServiceProvider services, IConfiguration config, CancellationToken ct = default)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CatalogDbContext>();
        await db.Database.EnsureCreatedAsync(ct);

        var allowInsecure = config.GetValue("Security:AllowInsecureDefaults", false);
        if (allowInsecure)
        {
            await UpsertStaffUserAsync(db, "atendimento", "atendimento123", "Atendimento", ct);
            await UpsertStaffUserAsync(db, "dev", "dev123", "Dev", ct);
        }

        var legacyUser = config["Admin:Username"];
        var legacyPass = config["Admin:Password"];
        if (!string.IsNullOrWhiteSpace(legacyUser) && !string.IsNullOrWhiteSpace(legacyPass))
        {
            await UpsertStaffUserAsync(db, legacyUser, legacyPass, "Admin", ct);
        }
        else if (allowInsecure)
        {
            await UpsertStaffUserAsync(db, "admin", "admin123", "Admin", ct);
        }

        // Administração geral da plataforma (abas Lojas / Sistemas) — role Dev
        var devUser = config["Dev:Username"];
        var devPass = config["Dev:Password"];
        if (!string.IsNullOrWhiteSpace(devUser) && !string.IsNullOrWhiteSpace(devPass))
        {
            await UpsertStaffUserAsync(db, devUser, devPass, "Dev", ct);
        }

        // Atendimento — pedidos (sem CRUD de cardápio / plataforma)
        var atendimentoUser = config["Atendimento:Username"];
        var atendimentoPass = config["Atendimento:Password"];
        if (!string.IsNullOrWhiteSpace(atendimentoUser) && !string.IsNullOrWhiteSpace(atendimentoPass))
        {
            await UpsertStaffUserAsync(db, atendimentoUser, atendimentoPass, "Atendimento", ct);
        }

        await db.SaveChangesAsync(ct);
    }

    private static async Task UpsertStaffUserAsync(
        CatalogDbContext db,
        string username,
        string password,
        string role,
        CancellationToken ct)
    {
        var existing = await db.AdminUsers.FirstOrDefaultAsync(u => u.Username == username, ct);
        if (existing is null)
        {
            db.AdminUsers.Add(new AdminUserEntity
            {
                StoreId = 1,
                Username = username,
                PasswordHash = BCrypt.Net.BCrypt.HashPassword(password),
                Role = role
            });
            return;
        }

        existing.Role = role;
        existing.PasswordHash = BCrypt.Net.BCrypt.HashPassword(password);
    }

    public static async Task EnsureStoreSchemaAsync(IServiceProvider services, CancellationToken ct = default)
    {
        using var scope = services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<CatalogDbContext>();
        await db.Database.EnsureCreatedAsync(ct);
        await db.Database.MigrateAsync(ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Cnpj" character varying(18) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ALTER COLUMN "Cnpj" TYPE character varying(18)""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Email" character varying(200) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "BannerUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CoverUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CorPrimaria" character varying(7) NOT NULL DEFAULT '#1f6feb'""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CorSecundaria" character varying(7) NOT NULL DEFAULT '#ffffff'""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CorFundo" character varying(7) NOT NULL DEFAULT '#f3f4f6'""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CorTexto" character varying(7) NOT NULL DEFAULT '#2c3e50'""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "TipoCard" character varying(32) NOT NULL DEFAULT 'foto-grande'""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "LayoutCardapio" character varying(32) NOT NULL DEFAULT 'grade'""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "EstiloBotao" character varying(24) NOT NULL DEFAULT 'arredondado'""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "IsTeste" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "DataCriacao" timestamp with time zone NOT NULL DEFAULT now()""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "DataAtualizacao" timestamp with time zone NOT NULL DEFAULT now()""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Address" character varying(400) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Cep" character varying(16) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Latitude" double precision NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Longitude" double precision NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "DeliveryFeePerKm" numeric(10,2) NOT NULL DEFAULT 0""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "MaxDeliveryKm" numeric(10,2) NOT NULL DEFAULT 0""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "MinDeliveryFee" numeric(10,2) NOT NULL DEFAULT 0""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "AverageDeliveryMinutes" integer NOT NULL DEFAULT 40""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "BreadOptionsJson" text NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "AcceptingOrders" boolean NOT NULL DEFAULT TRUE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "AddressNumber" character varying(32) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "IconUrl" character varying(400) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "ExtendedCloseUntilUtc" timestamp with time zone NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "City" character varying(120) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "State" character varying(2) NULL""", 
ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "AutoAdvancePreparing" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "AutoAdvancePreparingMinutes" integer NOT NULL DEFAULT 5""", ct);
        // ── Dine-in feature flags ──
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "DineInEnabled" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CustomerQrOrdersEnabled" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "WaiterOrdersEnabled" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "AllowManualTableEntry" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "RequireCustomerNameForQrOrder" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "AllowCustomerChooseWaiter" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "TableCount" integer NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "WaiterSessionHours" integer NOT NULL DEFAULT 8""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "WhatsAppOrderTemplate" text NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "HeroEnabled" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "HeroProductId" character varying(96) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "HeroTitle" character varying(90) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "HeroSubtitle" character varying(220) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Slug" character varying(100) NULL""", ct);
        // Slug único por loja para a resolução de subdomínio (x-tenant-slug → loja).
        await TryAlterAsync(db, """CREATE UNIQUE INDEX IF NOT EXISTS "IX_stores_Slug" ON stores ("Slug") WHERE "Slug" IS NOT NULL""", ct);
        await TryAlterAsync(db, """
            UPDATE stores
            SET "Slug" = 'fabin'
            WHERE "Id" = 1 AND (NULLIF(TRIM("Slug"), '') IS NULL)
            """, ct);
        await TryAlterAsync(db, """
            UPDATE stores
            SET "City" = COALESCE(NULLIF(TRIM("City"), ''), 'Ribeirão Preto'),
                "State" = COALESCE(NULLIF(TRIM("State"), ''), 'SP')
            WHERE "Id" = 1
              AND (NULLIF(TRIM("City"), '') IS NULL OR NULLIF(TRIM("State"), '') IS NULL)
            """, ct);
        await TryAlterAsync(db, """ALTER TABLE products ADD COLUMN IF NOT EXISTS "Description" character varying(800) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE products ADD COLUMN IF NOT EXISTS "SortOrder" integer NOT NULL DEFAULT 0""", ct);
        await TryAlterAsync(db, """ALTER TABLE products ADD COLUMN IF NOT EXISTS "Badge" character varying(32) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS "MustChangePassword" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "BillingBlocked" boolean NOT NULL DEFAULT FALSE""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "BillingBlockSuspendedUntil" timestamp with time zone NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "AbandonedAt" timestamp with time zone NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "FilesPurgedAt" timestamp with time zone NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "SignupIpHash" character varying(64) NULL""", ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_platform_stores_SignupIpHash" ON platform_stores ("SignupIpHash")""", ct);
        await TryAlterAsync(db, """ALTER TABLE products ADD COLUMN IF NOT EXISTS "PriceMedia" numeric(10,2) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE products ADD COLUMN IF NOT EXISTS "PriceInteira" numeric(10,2) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE products ADD COLUMN IF NOT EXISTS "ShowInMenu" boolean NOT NULL DEFAULT TRUE""", ct);
        await TryAlterAsync(db, """ALTER TABLE products ADD COLUMN IF NOT EXISTS "ModifierGroupsJson" text NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE categories ADD COLUMN IF NOT EXISTS "ShowInMenu" boolean NOT NULL DEFAULT TRUE""", ct);
        await TryAlterAsync(db, """
            UPDATE categories
            SET "ShowInMenu" = FALSE
            WHERE LOWER("Title") IN ('ingredientes', 'ingrediente', 'ingredients', 'ingredient', 'adicionais', 'adicional', 'addons', 'addon')
               OR LOWER("Id") IN ('ingredientes', 'ingrediente', 'ingredients', 'ingredient', 'adicionais', 'adicional', 'addons', 'addon')
            """, ct);
        await BackfillProductSortOrdersAsync(db, ct);
        await TryAlterAsync(db, """
            CREATE TABLE IF NOT EXISTS ingredients (
              "Id" character varying(64) NOT NULL,
              "Name" character varying(120) NOT NULL,
              "SortOrder" integer NOT NULL DEFAULT 0,
              CONSTRAINT "PK_ingredients" PRIMARY KEY ("Id")
            )
            """, ct);
        await TryAlterAsync(db, """
            CREATE TABLE IF NOT EXISTS product_ingredients (
              "ProductId" character varying(96) NOT NULL,
              "IngredientId" character varying(64) NOT NULL,
              CONSTRAINT "PK_product_ingredients" PRIMARY KEY ("ProductId", "IngredientId"),
              CONSTRAINT "FK_product_ingredients_products_ProductId" FOREIGN KEY ("ProductId") REFERENCES products ("Id") ON DELETE CASCADE,
              CONSTRAINT "FK_product_ingredients_ingredients_IngredientId" FOREIGN KEY ("IngredientId") REFERENCES ingredients ("Id") ON DELETE CASCADE
            )
            """, ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_product_ingredients_IngredientId" ON product_ingredients ("IngredientId")""", ct);
        await TryAlterAsync(db, """ALTER TABLE product_ingredients ADD COLUMN IF NOT EXISTS "SortOrder" integer NOT NULL DEFAULT 0""", ct);
        await TryAlterAsync(db, """ALTER TABLE product_ingredients ADD COLUMN IF NOT EXISTS "IsPrincipal" boolean NOT NULL DEFAULT FALSE""", ct);
        await BackfillProductIngredientSortOrdersAsync(db, ct);
        await TryAlterAsync(db, """
            UPDATE stores
            SET "BreadOptionsJson" = '[{"id":"pao-frances","label":"Pão francês","available":true},{"id":"pao-hamburguer","label":"Pão hambúrguer","available":true}]'
            WHERE "BreadOptionsJson" IS NULL OR "BreadOptionsJson" = '' OR "BreadOptionsJson" = '[]'
            """, ct);

        await EnsurePlatformStoresTableAsync(db, ct);

        // ── Multi-tenancy: coluna StoreId em tabelas existentes ──
        await TryAlterAsync(db, """ALTER TABLE products ADD COLUMN IF NOT EXISTS "StoreId" integer NOT NULL DEFAULT 1""", ct);
        await TryAlterAsync(db, """ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS "StoreId" integer NOT NULL DEFAULT 1""", ct);
        await TryAlterAsync(db, """ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS "CategoryId" character varying(64) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS "Available" boolean NOT NULL DEFAULT TRUE""", ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_ingredients_CategoryId" ON ingredients ("CategoryId")""", ct);
        await TryAlterAsync(db, """ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS "StoreId" integer NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS "DisplayName" character varying(120) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS "PinHash" character varying(200) NULL""", ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_products_StoreId" ON products ("StoreId")""", ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_ingredients_StoreId" ON ingredients ("StoreId")""", ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_admin_users_StoreId" ON admin_users ("StoreId")""", ct);

        // ── PIN sessions (camada adicional ao JWT p/ ações dine-in sensíveis) ──
        await TryAlterAsync(db, """
            CREATE TABLE IF NOT EXISTS pin_sessions (
              "Id" uuid NOT NULL,
              "AdminUserId" integer NOT NULL,
              "StoreId" integer NOT NULL DEFAULT 1,
              "SessionId" character varying(64) NOT NULL,
              "CreatedAtUtc" timestamp with time zone NOT NULL,
              "ExpiresAtUtc" timestamp with time zone NOT NULL,
              "RevokedAtUtc" timestamp with time zone NULL,
              CONSTRAINT "PK_pin_sessions" PRIMARY KEY ("Id")
            )
            """, ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_pin_sessions_SessionId" ON pin_sessions ("SessionId")""", ct);
        // Histórico de ações da plataforma (sem RLS: só o perfil Dev lê, pela API).
        await TryAlterAsync(db, """
            CREATE TABLE IF NOT EXISTS platform_audit (
              "Id" bigint GENERATED BY DEFAULT AS IDENTITY,
              "At" timestamp with time zone NOT NULL,
              "Actor" character varying(120) NOT NULL,
              "Action" character varying(60) NOT NULL,
              "PlatformStoreId" uuid NULL,
              "StoreId" integer NULL,
              "Details" text NULL,
              CONSTRAINT "PK_platform_audit" PRIMARY KEY ("Id")
            )
            """, ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_platform_audit_PlatformStoreId_At" ON platform_audit ("PlatformStoreId", "At")""", ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_platform_audit_At" ON platform_audit ("At")""", ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_pin_sessions_AdminUserId_StoreId" ON pin_sessions ("AdminUserId", "StoreId")""", ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_pin_sessions_ExpiresAtUtc" ON pin_sessions ("ExpiresAtUtc")""", ct);

        // ── Multi-tenancy: Row-Level Security (segunda camada) ──
        // FORCE faz o RLS valer até para o dono das tabelas. A variável de sessão
        // app.current_store_id é definida pelo TenantRlsInterceptor antes de cada comando.
        await EnsureRlsAsync(db,
            table: "stores",
            idColumn: "\"Id\"",
            ct);
        await EnsureRlsAsync(db,
            table: "products",
            idColumn: "\"StoreId\"",
            ct);
        await EnsureRlsAsync(db,
            table: "categories",
            idColumn: "\"StoreId\"",
            ct);
        await EnsureRlsAsync(db,
            table: "ingredients",
            idColumn: "\"StoreId\"",
            ct);

        // Barramento de invalidação de cache (LISTEN/NOTIFY): dispara pg_notify em toda
        // escrita nas tabelas críticas, cobrindo também SQL cru (DbExplorer, sync) e
        // múltiplas instâncias do catalog-api. NOTIFY só é entregue após o COMMIT.
        await EnsureCatalogInvalidationTriggersAsync(db, ct);
    }

    private static async Task EnsureCatalogInvalidationTriggersAsync(CatalogDbContext db, CancellationToken ct)
    {
        const string channel = "catalog_changed";
        await TryAlterAsync(db, $"""
            CREATE OR REPLACE FUNCTION notify_catalog_changed() RETURNS trigger
            LANGUAGE plpgsql AS $$
            DECLARE col text := COALESCE(TG_ARGV[0], 'StoreId');
            BEGIN
              PERFORM pg_notify('{channel}',
                TG_TABLE_NAME || ':' ||
                COALESCE(NULLIF(to_jsonb(COALESCE(NEW, OLD))->>col, ''), '0'));
              RETURN NULL;
            END $$;
            """, ct);

        // stores usa a coluna "Id" como store id; as demais usam "StoreId".
        // product_ingredients e platform_stores não têm "StoreId" no trigger resolvível
        // (product_ingredients não guarda a loja) → payload '0' = invalidação global.
        await EnsureCatalogInvalidationTriggerAsync(db, "stores", "id", ct);
        await EnsureCatalogInvalidationTriggerAsync(db, "products", "StoreId", ct);
        await EnsureCatalogInvalidationTriggerAsync(db, "categories", "StoreId", ct);
        await EnsureCatalogInvalidationTriggerAsync(db, "ingredients", "StoreId", ct);
        await EnsureCatalogInvalidationTriggerAsync(db, "product_ingredients", null, ct);
        await EnsureCatalogInvalidationTriggerAsync(db, "platform_stores", null, ct);
    }

    private static async Task EnsureCatalogInvalidationTriggerAsync(
        CatalogDbContext db,
        string table,
        string? column,
        CancellationToken ct)
    {
        await TryAlterAsync(db, $"""DROP TRIGGER IF EXISTS trg_catalog_changed ON {QuoteIdent(table)}""", ct);
        var args = string.IsNullOrWhiteSpace(column) ? "" : $"'{column}'";
        await TryAlterAsync(db, $"""
            CREATE TRIGGER trg_catalog_changed
            AFTER INSERT OR UPDATE OR DELETE ON {QuoteIdent(table)}
            FOR EACH ROW EXECUTE FUNCTION notify_catalog_changed({args})
            """, ct);
    }

    private static string QuoteIdent(string name) => "\"" + name + "\"";

    private static async Task EnsureRlsAsync(CatalogDbContext db, string table, string idColumn, CancellationToken ct)
    {
        var policy = $"p_{table}_tenant";
        var usingClause = $"{idColumn} = current_setting('app.current_store_id', true)::int";
        await TryAlterAsync(db, $"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY", ct);
        await TryAlterAsync(db, $"ALTER TABLE {table} FORCE ROW LEVEL SECURITY", ct);
        await TryAlterAsync(db, $"DROP POLICY IF EXISTS {policy} ON {table}", ct);
        await TryAlterAsync(db, $"""
            CREATE POLICY {policy} ON {table}
            FOR ALL
            USING ({usingClause})
            WITH CHECK ({usingClause})
            """, ct);
    }

    private static async Task EnsurePlatformStoresTableAsync(CatalogDbContext db, CancellationToken ct)
    {
        // EnsureCreated já cria a tabela pelo modelo; este SQL cobre upgrades antigos.
        await TryAlterAsync(db, """
            CREATE TABLE IF NOT EXISTS platform_stores (
              "Id" uuid NOT NULL,
              "Name" character varying(200) NOT NULL,
              "FrontUrl" character varying(500) NULL,
              "FrontNotes" character varying(500) NULL,
              "BackUrl" character varying(500) NULL,
              "BackNotes" character varying(500) NULL,
              "DatabaseInfo" character varying(800) NULL,
              "DatabaseUrl" character varying(500) NULL,
              "AdminUrl" character varying(500) NULL,
              "LocalFrontUrl" character varying(500) NULL,
              "LocalBackUrl" character varying(500) NULL,
              "LocalAdminUrl" character varying(500) NULL,
              "LocalDatabaseUrl" character varying(500) NULL,
              "MonthlyFee" numeric(10,2) NOT NULL DEFAULT 0,
              "Courtesy" boolean NOT NULL DEFAULT FALSE,
              "CourtesyUntil" timestamp with time zone NULL,
              "PaymentStatus" character varying(32) NOT NULL,
              "LastPaymentAt" timestamp with time zone NULL,
              "NextDueAt" timestamp with time zone NULL,
              "PaymentNotes" character varying(500) NULL,
              "PaymentsJson" text NOT NULL,
              "Active" boolean NOT NULL DEFAULT TRUE,
              "CreatedAt" timestamp with time zone NOT NULL,
              "UpdatedAt" timestamp with time zone NOT NULL,
              PRIMARY KEY ("Id")
            )
            """, ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "DatabaseUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "AdminUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "LocalFrontUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "LocalBackUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "LocalAdminUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "LocalDatabaseUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "StoreId" integer NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "Cnpj" character varying(18) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ALTER COLUMN "Cnpj" TYPE character varying(18)""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "RazaoSocial" character varying(200) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "ContactName" character varying(120) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "Phone" character varying(30) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "Email" character varying(200) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "Address" character varying(200) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "AddressNumber" character varying(20) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "Cep" character varying(8) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "City" character varying(120) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "State" character varying(2) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "LogoUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "Status" character varying(20) NOT NULL DEFAULT 'active'""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "Plan" character varying(50) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "Segment" character varying(50) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "Domain" character varying(200) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "ApiKey" character varying(200) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "WebhookUrl" character varying(500) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "BackUsername" character varying(120) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "BackPassword" character varying(300) NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "GalleryJson" text NOT NULL DEFAULT '[]'""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "LastAccessAt" timestamp with time zone NULL""", ct);
        await TryAlterAsync(db, """ALTER TABLE platform_stores ADD COLUMN IF NOT EXISTS "StatsJson" text NULL""", ct);
        await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_platform_stores_StoreId" ON platform_stores ("StoreId")""", ct);

        var count = await db.PlatformStores.CountAsync(ct);
        if (count > 0)
        {
            // Preenche links remotos/locais vazios na loja demo conhecida
            var fabinId = Guid.Parse("11111111-1111-1111-1111-111111111111");
            var fabin = await db.PlatformStores.FirstOrDefaultAsync(x => x.Id == fabinId, ct);
            if (fabin is not null)
            {
                var storeRow = await db.Stores.AsNoTracking().FirstOrDefaultAsync(s => s.Id == 1, ct);
                var changed = false;
                if (fabin.StoreId is null || fabin.StoreId == 0)
                {
                    fabin.StoreId = 1;
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.Status))
                {
                    fabin.Status = "active";
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.Cnpj))
                {
                    fabin.Cnpj = "00000000000000";
                    fabin.RazaoSocial = "Fabin Lanches LTDA";
                    changed = true;
                }
                if (storeRow is not null)
                {
                    // Espelha os dados cadastrados no painel admin (loja real)
                    if (string.IsNullOrWhiteSpace(fabin.Name) || !string.Equals(fabin.Name, storeRow.StoreName, StringComparison.OrdinalIgnoreCase))
                    {
                        fabin.Name = storeRow.StoreName;
                        changed = true;
                    }
                    if (string.IsNullOrWhiteSpace(fabin.Phone))
                    {
                        fabin.Phone = CatalogInputValidation.DigitsOnly(storeRow.Whatsapp);
                        changed = true;
                    }
                    if (string.IsNullOrWhiteSpace(fabin.Address))
                    {
                        fabin.Address = storeRow.Address;
                        changed = true;
                    }
                    if (string.IsNullOrWhiteSpace(fabin.AddressNumber))
                    {
                        fabin.AddressNumber = storeRow.AddressNumber;
                        changed = true;
                    }
                    if (string.IsNullOrWhiteSpace(fabin.Cep))
                    {
                        fabin.Cep = CatalogInputValidation.DigitsOnly(storeRow.Cep);
                        changed = true;
                    }
                    if (string.IsNullOrWhiteSpace(fabin.City))
                    {
                        fabin.City = string.IsNullOrWhiteSpace(storeRow.City) ? "Ribeirão Preto" : storeRow.City;
                        changed = true;
                    }
                    if (string.IsNullOrWhiteSpace(fabin.State))
                    {
                        fabin.State = string.IsNullOrWhiteSpace(storeRow.State) ? "SP" : storeRow.State;
                        changed = true;
                    }
                    if (string.IsNullOrWhiteSpace(fabin.LogoUrl))
                    {
                        fabin.LogoUrl = storeRow.LogoUrl;
                        changed = true;
                    }
                }
                else if (string.IsNullOrWhiteSpace(fabin.City))
                {
                    fabin.City = "São Paulo";
                    fabin.State = "SP";
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.AdminUrl))
                {
                    fabin.AdminUrl = "https://delivery-admin-fabin.vercel.app/";
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.DatabaseUrl))
                {
                    fabin.DatabaseUrl = "https://railway.app/dashboard";
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.FrontUrl) || fabin.FrontUrl.Contains("localhost", StringComparison.OrdinalIgnoreCase))
                {
                    fabin.FrontUrl = "https://delivery-fabin.vercel.app/";
                    fabin.FrontNotes ??= "Storefront PWA (Vercel)";
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.BackUrl) || fabin.BackUrl.Contains("localhost", StringComparison.OrdinalIgnoreCase))
                {
                    fabin.BackUrl = "https://adequate-upliftment-production-af86.up.railway.app/api/v1/";
                    fabin.BackNotes ??= "Gateway Railway";
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.LocalFrontUrl))
                {
                    fabin.LocalFrontUrl = "http://localhost:8080/";
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.LocalBackUrl))
                {
                    fabin.LocalBackUrl = "http://localhost:5100/api/v1/";
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.LocalAdminUrl))
                {
                    fabin.LocalAdminUrl = "http://localhost:8081/";
                    changed = true;
                }
                if (string.IsNullOrWhiteSpace(fabin.LocalDatabaseUrl))
                {
                    fabin.LocalDatabaseUrl = "http://localhost:5432/";
                    changed = true;
                }
                if (changed)
                {
                    fabin.UpdatedAt = DateTime.UtcNow;
                    await db.SaveChangesAsync(ct);
                }
            }
            return;
        }

        db.PlatformStores.Add(new PlatformStoreEntity
        {
            Id = Guid.Parse("11111111-1111-1111-1111-111111111111"),
            Name = "Fabin Lanches",
            FrontUrl = "https://delivery-fabin.vercel.app/",
            FrontNotes = "Storefront PWA (Vercel)",
            BackUrl = "https://adequate-upliftment-production-af86.up.railway.app/api/v1/",
            BackNotes = "Gateway Railway",
            DatabaseInfo = "PostgreSQL (Railway) · delivery shared",
            DatabaseUrl = "https://railway.app/dashboard",
            AdminUrl = "https://delivery-admin-fabin.vercel.app/",
            LocalFrontUrl = "http://localhost:8080/",
            LocalBackUrl = "http://localhost:5100/api/v1/",
            LocalAdminUrl = "http://localhost:8081/",
            LocalDatabaseUrl = "http://localhost:5432/",
            MonthlyFee = 0,
            Courtesy = true,
            CourtesyUntil = DateTime.UtcNow.AddMonths(3),
            PaymentStatus = "courtesy",
            NextDueAt = DateTime.UtcNow.AddMonths(3),
            PaymentNotes = "Ambiente de produção / demonstração",
            PaymentsJson = "[]",
            Active = true,
            StoreId = 1,
            Cnpj = "00000000000000",
            RazaoSocial = "Fabin Lanches LTDA",
            ContactName = "Fabin Lanches",
            Phone = "5516992496886",
            Email = "contato@fabinlanches.com.br",
            Address = "Rua Guilherme Schmidt, 987, Jardim Antártica, Ribeirão Preto - SP",
            AddressNumber = "987",
            Cep = "14051170",
            City = "Ribeirão Preto",
            State = "SP",
            Status = "active",
            Plan = "starter",
            Domain = "delivery-fabin.vercel.app",
            GalleryJson = "[]",
            CreatedAt = DateTime.UtcNow,
            UpdatedAt = DateTime.UtcNow
        });
        await db.SaveChangesAsync(ct);
    }

    private static async Task BackfillProductIngredientSortOrdersAsync(CatalogDbContext db, CancellationToken ct)
    {
        try
        {
            var needs = await db.ProductIngredients.AnyAsync(pi => pi.SortOrder == 0, ct);
            if (!needs) return;

            var groups = await db.ProductIngredients
                .Include(pi => pi.Ingredient)
                .GroupBy(pi => pi.ProductId)
                .ToListAsync(ct);

            foreach (var group in groups)
            {
                var ordered = group
                    .OrderBy(pi => pi.SortOrder == 0 ? int.MaxValue : pi.SortOrder)
                    .ThenBy(pi => pi.Ingredient?.SortOrder ?? 0)
                    .ThenBy(pi => pi.Ingredient?.Name ?? pi.IngredientId)
                    .ToList();
                for (var i = 0; i < ordered.Count; i++)
                    ordered[i].SortOrder = i + 1;
            }

            await db.SaveChangesAsync(ct);
        }
        catch
        {
            // ignora se a coluna ainda não existir
        }
    }

    private static async Task BackfillProductSortOrdersAsync(CatalogDbContext db, CancellationToken ct)
    {
        try
        {
            var groups = await db.Products
                .GroupBy(p => p.CategoryId)
                .Select(g => new { CategoryId = g.Key, MaxSort = g.Max(p => p.SortOrder), Count = g.Count() })
                .ToListAsync(ct);

            var needsBackfill = groups.Any(g => g.Count > 1 && g.MaxSort == 0);
            if (!needsBackfill) return;

            foreach (var group in groups.Where(g => g.Count > 0 && g.MaxSort == 0))
            {
                var products = await db.Products
                    .Where(p => p.CategoryId == group.CategoryId)
                    .OrderBy(p => p.Name)
                    .ToListAsync(ct);
                for (var i = 0; i < products.Count; i++)
                    products[i].SortOrder = i + 1;
            }

            await db.SaveChangesAsync(ct);
        }
        catch
        {
            // ignora se a coluna ainda não existir neste momento
        }
    }

    private static async Task TryAlterAsync(CatalogDbContext db, string sql, CancellationToken ct)
    {
        try
        {
            await db.Database.ExecuteSqlRawAsync(sql, ct);
        }
        catch
        {
            // coluna/tabela já existe
        }
    }
}
