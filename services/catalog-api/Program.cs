using System.Security.Claims;
using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using Catalog.Api;
using Catalog.Api.Data;
using Catalog.Api.MultiTenancy;
using Catalog.Api.Models;
using Catalog.Api.Repositories;
using Catalog.Api.Services;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.IdentityModel.Tokens;
using Npgsql;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Serilog;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddControllers();

Log.Logger = new LoggerConfiguration()
    .ReadFrom.Configuration(builder.Configuration)
    .Enrich.FromLogContext()
    .Enrich.WithProperty("service", "catalog-api")
    .WriteTo.Console()
    .CreateLogger();

builder.Host.UseSerilog();

var persistence = builder.Configuration["Persistence"] ?? "Json";
var corsOrigins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>()
    ?? [
        "http://localhost:8080",
        "http://localhost:5500",
        "http://127.0.0.1:8080",
        "http://localhost:8081",
        "http://127.0.0.1:8081"
    ];

builder.Services.AddMemoryCache(options => options.TrackStatistics = true);
builder.Services.AddSingleton<Catalog.Api.Repositories.CatalogCacheInvalidator>();
builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<Catalog.Api.MultiTenancy.TenantContext>();
builder.Services.AddSingleton<AuthService>();
builder.Services.AddSingleton<TrafficStatsService>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<TrafficStatsService>());
builder.Services.AddHttpClient("geo", client =>
{
    // Nominatim exige UA identificável; Open-Meteo/ViaCEP/AwesomeAPI também aceitam.
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "FabinLanchesDelivery/1.0 (+https://delivery-fabin.vercel.app; contato via painel admin)");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
    client.Timeout = TimeSpan.FromSeconds(12);
});
builder.Services.AddSingleton<GeoService>();

// Cliente para a API remota (ferramentas de loja: comparar/sync/backup entre ambientes).
builder.Services.AddHttpClient("remote", client =>
{
    client.DefaultRequestHeaders.UserAgent.ParseAdd(
        "FabinLanchesDelivery-Tools/1.0 (ferramentas de loja do painel Dev)");
    client.DefaultRequestHeaders.Accept.ParseAdd("application/json");
    client.Timeout = TimeSpan.FromSeconds(30);
});

var usePostgres = string.Equals(persistence, "PostgreSQL", StringComparison.OrdinalIgnoreCase)
    || string.Equals(persistence, "Postgres", StringComparison.OrdinalIgnoreCase);

string? dbConn = null;
if (usePostgres)
{
    var conn = builder.Configuration.GetConnectionString("Postgres")
        ?? builder.Configuration.GetConnectionString("Default")
        ?? "Host=localhost;Port=5432;Database=delivery_catalog;Username=delivery;Password=delivery";
    dbConn = conn;
    builder.Services.AddScoped<StoreProvisioningService>();
    builder.Services.AddScoped<Catalog.Api.Data.TenantRlsInterceptor>();
    builder.Services.AddDbContext<CatalogDbContext>((sp, opt) =>
        opt.UseNpgsql(conn)
           .AddInterceptors(sp.GetRequiredService<Catalog.Api.Data.TenantRlsInterceptor>()));
    builder.Services.AddScoped<ICatalogRepository, EfCatalogRepository>();
    builder.Services.AddScoped<IPlatformStoreRepository, EfPlatformStoreRepository>();
    builder.Services.AddScoped<IAdminUserRepository, EfAdminUserRepository>();
    builder.Services.AddScoped<IPinSessionStore, EfPinSessionStore>();

    // Barramento de invalidação de cache (LISTEN/NOTIFY no PostgreSQL) — somente com
    // Persistence=PostgreSQL; o modo Json (usado pelos testes) não registra o serviço.
    builder.Services.AddHostedService(sp => new Catalog.Api.Services.CatalogInvalidationListener(
        dbConn,
        sp.GetRequiredService<Catalog.Api.Repositories.CatalogCacheInvalidator>(),
        sp.GetRequiredService<ILogger<Catalog.Api.Services.CatalogInvalidationListener>>()));
}
else
{
    builder.Services.AddSingleton<ICatalogRepository, JsonCatalogRepository>();
    builder.Services.AddSingleton<IPlatformStoreRepository, JsonPlatformStoreRepository>();
    builder.Services.AddSingleton<IAdminUserRepository, JsonAdminUserRepository>();
    builder.Services.AddSingleton<IPinSessionStore>(sp =>
        new InMemoryPinSessionStore());
}

builder.Services.AddSingleton(new DbExplorerService(dbConn));

// Resolução de subdomínio → loja (x-tenant-slug). Funciona em Json (slug padrão) e PostgreSQL com cache em memória.
builder.Services.AddScoped<TenantResolverService>(sp => new TenantResolverService(
    dbConn,
    sp.GetRequiredService<IConfiguration>(),
    sp.GetRequiredService<ICatalogRepository>(),
    sp.GetRequiredService<IMemoryCache>(),
    sp.GetRequiredService<ILogger<TenantResolverService>>()));

builder.Services.AddScoped<StoreStatsService>(sp => new StoreStatsService(
    dbConn,
    sp.GetRequiredService<IPlatformStoreRepository>(),
    sp.GetRequiredService<TrafficStatsService>(),
    sp.GetRequiredService<ILogger<StoreStatsService>>()));
builder.Services.AddScoped<RemoteStoreToolsService>(sp => new RemoteStoreToolsService(
    dbConn,
    sp.GetRequiredService<IPlatformStoreRepository>(),
    sp.GetRequiredService<ICatalogRepository>(),
    sp.GetRequiredService<StoreStatsService>(),
    sp.GetRequiredService<IHttpClientFactory>(),
    sp.GetRequiredService<IWebHostEnvironment>(),
    sp.GetRequiredService<IConfiguration>(),
    sp.GetRequiredService<ILogger<RemoteStoreToolsService>>()));

var jwtKey = builder.Configuration["Jwt:Key"];
if (string.IsNullOrWhiteSpace(jwtKey))
{
    throw new InvalidOperationException(
        "Jwt:Key não configurada. Defina a variável de ambiente Jwt__Key ou a configuração segura equivalente.");
}

var allowInsecure = builder.Configuration.GetValue("Security:AllowInsecureDefaults", false);
if (builder.Environment.IsProduction()
    && !allowInsecure
    && jwtKey.Contains("ChangeMe", StringComparison.OrdinalIgnoreCase))
{
    throw new InvalidOperationException(
        "Jwt:Key inseguro em Production. Defina uma chave forte ou Security:AllowInsecureDefaults=true apenas em demos.");
}

builder.Services.AddAuthentication(JwtBearerDefaults.AuthenticationScheme)
    .AddJwtBearer(options =>
    {
        options.TokenValidationParameters = new TokenValidationParameters
        {
            ValidateIssuer = true,
            ValidateAudience = true,
            ValidateLifetime = true,
            ValidateIssuerSigningKey = true,
            ValidIssuer = builder.Configuration["Jwt:Issuer"] ?? "delivery-catalog",
            ValidAudience = builder.Configuration["Jwt:Audience"] ?? "delivery-clients",
            IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
            RoleClaimType = ClaimTypes.Role
        };
    });
builder.Services.AddAuthorization(options =>
{
    // Operação da loja (cardápio, config, dashboard de vendas)
    options.AddPolicy("StoreAdmin", p => p.RequireRole(StaffRoles.Admin, StaffRoles.AdminLoja));
    // Plataforma SaaS (lista de lojas clientes)
    options.AddPolicy("PlatformDev", p => p.RequireRole(StaffRoles.Dev));
    // Compat: endpoints antigos DevOnly = Admin da loja
    options.AddPolicy("DevOnly", p => p.RequireRole(StaffRoles.Admin, StaffRoles.AdminLoja));
    options.AddPolicy("OrdersStaff", p => p.RequireRole(StaffRoles.Admin, StaffRoles.AdminLoja, StaffRoles.Atendimento, StaffRoles.Garçom));
});

builder.Services.AddCors(options =>
{
    options.AddPolicy("Frontend", policy =>
        policy.SetIsOriginAllowed(origin => Catalog.Api.CorsLan.IsOriginAllowed(origin, corsOrigins))
            .AllowAnyHeader()
            .AllowAnyMethod());
});

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("login", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: $"{httpContext.Connection.RemoteIpAddress}:login",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 8,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0
            }));
    options.AddPolicy("store-signup", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: $"{httpContext.Connection.RemoteIpAddress}:signup",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 3,
                Window = TimeSpan.FromMinutes(15),
                QueueLimit = 0
            }));
    options.AddPolicy("geo", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: $"{httpContext.Connection.RemoteIpAddress}:geo",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 30,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0
            }));
    options.AddPolicy("analytics-pageview", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: $"{httpContext.Connection.RemoteIpAddress}:pv",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 40,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0
            }));
    options.AddPolicy("analytics-hit", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            partitionKey: $"{httpContext.Connection.RemoteIpAddress}:hit",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 600,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0
            }));
});

builder.Services.AddOpenApi();
builder.Services.Configure<Microsoft.AspNetCore.Http.Features.FormOptions>(o =>
{
    o.MultipartBodyLengthLimit = 17 * 1024 * 1024;
});

if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"])
    || !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT")))
{
    builder.Services.AddOpenTelemetry()
        .ConfigureResource(r => r.AddService("catalog-api"))
        .WithTracing(t => t
            .AddAspNetCoreInstrumentation()
            .AddHttpClientInstrumentation()
            .AddOtlpExporter());
}

var app = builder.Build();

if (usePostgres)
{
    for (var attempt = 1; attempt <= 20; attempt++)
    {
        try
        {
            await DbSeeder.EnsureStoreSchemaAsync(app.Services);
            await DbSeeder.SeedAsync(app.Services, app.Configuration);
            await DbSeeder.EnsureStaffUsersAsync(app.Services, app.Configuration);
            break;
        }
        catch (Exception ex) when (attempt < 20)
        {
            Log.Warning(ex, "PostgreSQL ainda não pronto (tentativa {Attempt}/20). Aguardando…", attempt);
            await Task.Delay(TimeSpan.FromSeconds(3));
        }
    }
}

app.UseSerilogRequestLogging();
app.UseCors("Frontend");
app.UseRateLimiter();
app.UseAuthentication();
app.UseMiddleware<TenantSlugMiddleware>();
app.UseAuthorization();
app.MapControllers();

if (app.Environment.IsDevelopment())
    app.MapOpenApi();

var configuredUploads = app.Configuration["Data:UploadsRoot"];
var uploadsRoot = string.IsNullOrWhiteSpace(configuredUploads)
    ? Path.Combine(app.Environment.ContentRootPath, "wwwroot", "uploads")
    : Path.GetFullPath(Path.IsPathRooted(configuredUploads)
        ? configuredUploads
        : Path.Combine(app.Environment.ContentRootPath, configuredUploads));
Directory.CreateDirectory(uploadsRoot);

void ApplyUploadsCacheHeaders(Microsoft.AspNetCore.StaticFiles.StaticFileResponseContext ctx)
{
    ctx.Context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    ctx.Context.Response.Headers["X-Frame-Options"] = "DENY";
    if (ctx.Context.Request.Path.StartsWithSegments("/uploads"))
        ctx.Context.Response.Headers["Cache-Control"] = "no-cache";
}

app.UseStaticFiles(new StaticFileOptions { OnPrepareResponse = ApplyUploadsCacheHeaders });

var defaultUploadsRoot = Path.Combine(app.Environment.ContentRootPath, "wwwroot", "uploads");
if (!string.Equals(Path.GetFullPath(uploadsRoot), Path.GetFullPath(defaultUploadsRoot), StringComparison.OrdinalIgnoreCase))
{
    app.UseStaticFiles(new StaticFileOptions
    {
        RequestPath = "/uploads",
        FileProvider = new Microsoft.Extensions.FileProviders.PhysicalFileProvider(uploadsRoot),
        OnPrepareResponse = ApplyUploadsCacheHeaders
    });
}

try
{
    using var scope = app.Services.CreateScope();
    var repo = scope.ServiceProvider.GetRequiredService<ICatalogRepository>();
    var catalog = await repo.GetCatalogAsync(CancellationToken.None);
    var referenced = catalog.Categories.SelectMany(c => c.Items).Select(i => i.ImageUrl);
    if (catalog.Categories.All(c => c.Items.Count == 0))
    {
        Log.Information("GC de imagens: catálogo sem produtos no boot, varredura de órfãos ignorada");
    }
    else
    {
        var removed = ImageStorage.CleanupOrphanedProductImages(referenced, uploadsRoot);
        if (removed > 0) Log.Information("GC de imagens: {Count} órfã(s) removida(s) em uploads/products", removed);
    }

    var missingImages = ImageStorage.FindMissingProductImages(
        catalog.Categories.SelectMany(c => c.Items)
            .Select(i => (i.Id, i.Name, i.ImageUrl)),
        uploadsRoot);
    if (missingImages.Count > 0)
    {
        Log.Warning("Imagens ausentes no boot: {Count} produto(s) referenciam /uploads/ sem arquivo em disco: {Items}",
            missingImages.Count,
            string.Join(", ", missingImages.Select(m => $"{m.Name} ({m.ImageUrl})")));
    }
}
catch (Exception ex)
{
    Log.Warning(ex, "GC de imagens órfãs não executado no startup");
}

var api = app.MapGroup("/api/v1");

api.MapGet("/health", () => Results.Ok(new
{
    status = "healthy",
    service = "catalog-api",
    persistence,
    utc = DateTime.UtcNow
}));

api.MapGet("/store", async (HttpRequest request, ICatalogRepository repo, IPlatformStoreRepository platform, TenantContext tenant, CancellationToken ct) =>
{
    if (!tenant.TryGetStoreId(out var storeId) || storeId <= 0)
        return Results.BadRequest(new { error = "Nenhum tenant foi informado. Forneça o cabeçalho X-Tenant-Slug." });

    var store = await repo.GetStoreAsync(ct);
    List<PlatformStoreDto> platformStores;
    try
    {
        platformStores = await platform.ListAsync(ct);
    }
    catch
    {
        platformStores = [];
    }

    var origin = request.Headers.Origin.FirstOrDefault()
        ?? request.Headers.Referer.FirstOrDefault();
    var active = Catalog.Api.StoreAvailability.Resolve(store.StoreName, origin, platformStores, storeId);
    return Results.Ok(store with { Active = active });
});

api.MapGet("/store/status", async (ICatalogRepository repo, TenantContext tenant, CancellationToken ct) =>
{
    if (!tenant.TryGetStoreId(out var storeId) || storeId <= 0)
        return Results.BadRequest(new { error = "Nenhum tenant foi informado. Forneça o cabeçalho X-Tenant-Slug." });

    var store = await repo.GetStoreAsync(ct);
    var utcNow = DateTime.UtcNow;
    var open = Catalog.Api.StoreSchedule.IsOpenNow(store, utcNow);
    var onBreak = Catalog.Api.StoreSchedule.IsOnBreakNow(store, utcNow);
    var accepting = store.AcceptingOrders && open && !onBreak;

    string? message = null;
    if (!accepting)
    {
        if (!store.AcceptingOrders)
            message = "Pedimos desculpas, no momento não estamos recebendo pedidos.";
        else if (onBreak)
            message = "Estamos em intervalo e voltaremos em breve.";
        else
            message = "Estamos fechados no momento.";
    }

    return Results.Ok(new
    {
        storeName = store.StoreName,
        acceptingOrders = store.AcceptingOrders,
        open,
        onBreak,
        accepting,
        extendedCloseUntilUtc = store.ExtendedCloseUntilUtc,
        message
    });
});

api.MapGet("/tenant/resolve", async (HttpRequest request, TenantResolverService resolver, CancellationToken ct) =>
{
    var slug = request.Headers["x-tenant-slug"].FirstOrDefault();
    var tenant = await resolver.ResolveAsync(slug, ct);
    return tenant is null
        ? Results.NotFound(new { error = "Loja não encontrada para este subdomínio." })
        : Results.Ok(tenant);
});

api.MapGet("/tenant/{slug}", async (string slug, TenantResolverService resolver, CancellationToken ct) =>
{
    var tenant = await resolver.ResolveAsync(slug, ct);
    return tenant is null
        ? Results.NotFound(new { error = "Loja não encontrada para este slug." })
        : Results.Ok(tenant);
});

api.MapGet("/catalog", async (HttpRequest request, ICatalogRepository repo, IPlatformStoreRepository platform, TenantContext tenant, CancellationToken ct) =>
{
    if (!tenant.TryGetStoreId(out var storeId) || storeId <= 0)
        return Results.BadRequest(new { error = "Nenhum tenant foi informado. Forneça o cabeçalho X-Tenant-Slug." });

    var store = await repo.GetStoreAsync(ct);
    List<PlatformStoreDto> platformStores;
    try { platformStores = await platform.ListAsync(ct); }
    catch { platformStores = []; }
    var origin = request.Headers.Origin.FirstOrDefault()
        ?? request.Headers.Referer.FirstOrDefault();
    if (!Catalog.Api.StoreAvailability.Resolve(store.StoreName, origin, platformStores, storeId))
        return Results.Json(new { error = "Loja inativa. Entre em contato com o Administrador." }, statusCode: 403);

    var catalog = await repo.GetCatalogAsync(ct);
    return Results.Ok(new CatalogDto(catalog.Categories
        .Where(c => c.ShowInMenu && !CatalogInputValidation.IsHiddenMenuCategory(c.Id, c.Title))
        .Select(c => c with
        {
            Items = c.Items
                .Where(i => i.Available && i.ShowInMenu)
                .Select(i => i with
                {
                    Ingredients = i.Ingredients?.Where(ing => ing.Available).ToList() ?? []
                })
                .ToList()
        })
        .Where(c => c.Items.Count > 0)
        .ToList()));
});

api.MapPost("/geo/geocode", async (GeocodeRequest body, GeoService geo, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Query) || body.Query.Trim().Length > 300)
        return Results.BadRequest(new { error = "Informe o endereço para geocodificar." });

    var result = await geo.GeocodeAsync(body.Query.Trim(), ct);
    return result is null
        ? Results.NotFound(new { error = "Endereço não encontrado." })
        : Results.Ok(result);
}).RequireRateLimiting("geo");

api.MapPost("/delivery/quote", async (DeliveryQuoteRequest body, ICatalogRepository repo, GeoService geo, TenantContext tenant, CancellationToken ct) =>
{
    if (!tenant.TryGetStoreId(out var storeId) || storeId <= 0)
        return Results.BadRequest(new { error = "Nenhum tenant foi informado. Forneça o cabeçalho X-Tenant-Slug." });

    var store = await repo.GetStoreAsync(ct);
    if (store.Latitude is null || store.Longitude is null || store.DeliveryFeePerKm <= 0)
    {
        return Results.Ok(new DeliveryQuoteResponse(
            false,
            "Entrega por km não configurada. Defina endereço da loja, taxa por km e limite no painel.",
            0, 0, store.MaxDeliveryKm, false, "unconfigured",
            store.DeliveryFeePerKm, store.MinDeliveryFee));
    }

    double customerLat;
    double customerLon;
    if (body.Latitude is not null && body.Longitude is not null)
    {
        customerLat = body.Latitude.Value;
        customerLon = body.Longitude.Value;
    }
    else
    {
        GeocodeResponse? geoResult = null;
        var cepDigits = string.IsNullOrWhiteSpace(body.Cep)
            ? ""
            : new string(body.Cep.Where(char.IsDigit).ToArray());
        var number = string.IsNullOrWhiteSpace(body.Number)
            ? ""
            : body.Number.Trim();
        var street = string.IsNullOrWhiteSpace(body.Address) ? "" : body.Address.Trim();
        var streetWithNumber = string.IsNullOrWhiteSpace(number) || string.IsNullOrWhiteSpace(street)
            ? street
            : $"{street}, {number}";

        // Com número, prioriza geocode do endereço completo (CEP sozinho costuma cair no centro do logradouro).
        if (!string.IsNullOrWhiteSpace(streetWithNumber) && !string.IsNullOrWhiteSpace(number))
        {
            var preciseParts = new[] { streetWithNumber, body.Neighborhood, body.City, body.State, "Brasil" }
                .Where(p => !string.IsNullOrWhiteSpace(p));
            var preciseQuery = string.Join(", ", preciseParts);
            if (cepDigits.Length == 8)
                preciseQuery = $"{preciseQuery}, {cepDigits}";
            geoResult = await geo.GeocodeAsync(preciseQuery, ct);
        }

        if (geoResult is null && cepDigits.Length == 8)
            geoResult = await geo.GeocodeByCepAsync(cepDigits, ct);

        if (geoResult is null)
        {
            var parts = new[] { streetWithNumber, body.Neighborhood, body.City, body.State, "Brasil" }
                .Where(p => !string.IsNullOrWhiteSpace(p));
            var query = string.Join(", ", parts);
            if (!string.IsNullOrWhiteSpace(body.Cep))
                query = $"{query}, {body.Cep}";
            geoResult = await geo.GeocodeAsync(query, ct);
        }

        if (geoResult is null)
        {
            return Results.Ok(new DeliveryQuoteResponse(
                false,
                "Não foi possível localizar o endereço do cliente no mapa.",
                0, 0, store.MaxDeliveryKm, false, "geocode-failed",
                store.DeliveryFeePerKm, store.MinDeliveryFee));
        }

        customerLat = geoResult.Latitude;
        customerLon = geoResult.Longitude;
    }

    var distance = GeoService.HaversineKm(
        store.Latitude.Value, store.Longitude.Value, customerLat, customerLon);
    var within = store.MaxDeliveryKm <= 0 || (decimal)distance <= store.MaxDeliveryKm;
    var fee = 0m;
    if (within)
    {
        // Distância × taxa/km, piso na mínima, sempre arredondado para cima em R$ 0,50.
        fee = (decimal)distance * store.DeliveryFeePerKm;
        if (store.MinDeliveryFee > 0 && fee < store.MinDeliveryFee)
            fee = store.MinDeliveryFee;
        fee = DeliveryFeeRounding.RoundUpToHalfReal(fee);
    }

    return Results.Ok(new DeliveryQuoteResponse(
        within,
        within ? null : $"Fora da área de entrega (máx. {store.MaxDeliveryKm} km). Distância: {distance} km.",
        distance,
        fee,
        store.MaxDeliveryKm,
        within,
        "km",
        store.DeliveryFeePerKm,
        store.MinDeliveryFee));
}).RequireRateLimiting("geo");

api.MapPost("/auth/login", async (LoginRequest body, AuthService auth, CancellationToken ct) =>
{
    var err = CatalogInputValidation.ValidateLogin(body);
    if (err is not null)
        return Results.BadRequest(new { error = err });

    var result = await auth.LoginAsync(body, ct);
    return result is null ? Results.Unauthorized() : Results.Ok(result);
}).RequireRateLimiting("login");

api.MapGet("/auth/me", async (ClaimsPrincipal user, AuthService auth, CancellationToken ct) =>
{
    if (user.Identity?.IsAuthenticated != true)
        return Results.Unauthorized();

    var role = user.FindFirstValue(ClaimTypes.Role)
        ?? user.FindFirstValue("role")
        ?? StaffRoles.Atendimento;

    var username = user.Identity?.Name ?? "";
    var displayName = await auth.GetDisplayNameAsync(username, ct);

    return Results.Ok(new
    {
        username,
        role,
        storeId = int.TryParse(user.FindFirstValue("store_id"), out var sid) ? (int?)sid : null,
        displayName
    });
}).RequireAuthorization();

api.MapPatch("/auth/profile", async (UpdateProfileRequest body, ClaimsPrincipal user, AuthService auth, CancellationToken ct) =>
{
    if (user.Identity?.IsAuthenticated != true)
        return Results.Unauthorized();

    var err = CatalogInputValidation.ValidateUpdateProfile(body);
    if (err is not null)
        return Results.BadRequest(new { error = err });

    var (result, updated) = await auth.UpdateOwnProfileAsync(user.Identity?.Name ?? "", body.DisplayName, ct);
    return result switch
    {
        AccountUpdateResult.Ok => Results.Ok(updated),
        AccountUpdateResult.ConfigManaged => Results.BadRequest(new
        {
            error = "Este usuário é gerenciado pela configuração do servidor. Defina o nome de exibição no ambiente de implantação."
        }),
        _ => Results.BadRequest(new { error = "Usuário não encontrado na base local." })
    };
}).RequireAuthorization();

api.MapPost("/auth/change-password", async (ChangePasswordRequest body, ClaimsPrincipal user, AuthService auth, CancellationToken ct) =>
{
    if (user.Identity?.IsAuthenticated != true)
        return Results.Unauthorized();

    var err = CatalogInputValidation.ValidateChangePassword(body);
    if (err is not null)
        return Results.BadRequest(new { error = err });

    var result = await auth.ChangeOwnPasswordAsync(
        user.Identity?.Name ?? "", body.CurrentPassword, body.NewPassword, ct);
    return result switch
    {
        AccountUpdateResult.Ok => Results.Ok(new { ok = true }),
        AccountUpdateResult.WrongPassword => Results.BadRequest(new { error = "Senha atual incorreta." }),
        AccountUpdateResult.ConfigManaged => Results.BadRequest(new
        {
            error = "Este usuário é gerenciado pela configuração do servidor. Altere a senha no ambiente de implantação."
        }),
        _ => Results.BadRequest(new { error = "Usuário não encontrado na base local." })
    };
}).RequireRateLimiting("login").RequireAuthorization();

var admin = api.MapGroup("/admin").RequireAuthorization("DevOnly");

admin.MapPatch("/store", async (PatchStoreRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    var err = CatalogInputValidation.ValidatePatchStore(body);
    if (err is not null) return Results.BadRequest(new { error = err });
    await repo.UpdateStoreAsync(body, ct);
    return Results.Ok(await repo.GetStoreAsync(ct));
});

var ops = api.MapGroup("/ops").RequireAuthorization("OrdersStaff");
ops.MapGet("/accepting-orders", async (ICatalogRepository repo, CancellationToken ct) =>
{
    var store = await repo.GetStoreAsync(ct);
    return Results.Ok(new
    {
        acceptingOrders = store.AcceptingOrders,
        extendedCloseUntilUtc = store.ExtendedCloseUntilUtc,
        withinSchedule = Catalog.Api.StoreSchedule.IsOpenNow(store, DateTime.UtcNow)
            && !Catalog.Api.StoreSchedule.IsOnBreakNow(store, DateTime.UtcNow)
    });
});
ops.MapPatch("/accepting-orders", async (SetAcceptingOrdersRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    var patch = new PatchStoreRequest { AcceptingOrders = body.AcceptingOrders };
    if (!body.AcceptingOrders)
        patch.ClearExtendedCloseUntil = true;
    await repo.UpdateStoreAsync(patch, ct);
    var store = await repo.GetStoreAsync(ct);
    return Results.Ok(new
    {
        acceptingOrders = store.AcceptingOrders,
        extendedCloseUntilUtc = store.ExtendedCloseUntilUtc,
        storeName = store.StoreName
    });
});
ops.MapPost("/extend-hours", async (ExtendHoursRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    if (body.Minutes is not (30 or 60))
        return Results.BadRequest(new { error = "Informe 30 ou 60 minutos." });

    var store = await repo.GetStoreAsync(ct);
    var until = Catalog.Api.StoreSchedule.ComputeExtendedCloseUntilUtc(store, DateTime.UtcNow, body.Minutes);
    await repo.UpdateStoreAsync(new PatchStoreRequest
    {
        AcceptingOrders = true,
        ExtendedCloseUntilUtc = until
    }, ct);
    store = await repo.GetStoreAsync(ct);
    return Results.Ok(new
    {
        acceptingOrders = store.AcceptingOrders,
        extendedCloseUntilUtc = store.ExtendedCloseUntilUtc,
        storeName = store.StoreName
    });
});

// ── PIN (camada adicional ao JWT p/ ações dine-in sensíveis) ──
var pin = api.MapGroup("/admin/pin").RequireAuthorization("OrdersStaff");

pin.MapGet("/status", async (ClaimsPrincipal user, IAdminUserRepository users, IPinSessionStore sessions, TenantContext tenant, CancellationToken ct) =>
{
    var username = user.Identity?.Name ?? "";
    if (user.Identity?.IsAuthenticated != true || string.IsNullOrWhiteSpace(username))
        return Results.Unauthorized();

    var me = await users.FindByUsernameAsync(username, ct);
    if (me is null)
        return Results.Ok(new PinStatusResponse(HasPin: false, HasValidSession: false));

    var hasPin = await users.HasPinHashAsync(username, ct);
    return Results.Ok(new PinStatusResponse(HasPin: hasPin, HasValidSession: false));
});

pin.MapPost("/set", async (PinSetRequest body, ClaimsPrincipal user, IAdminUserRepository users, CancellationToken ct) =>
{
    var username = user.Identity?.Name ?? "";
    if (user.Identity?.IsAuthenticated != true || string.IsNullOrWhiteSpace(username))
        return Results.Unauthorized();

    var pin = (body.Pin ?? "").Trim();
    if (pin.Length != 4 || !pin.All(char.IsDigit))
        return Results.BadRequest(new { error = "O PIN deve ter exatamente 4 dígitos." });

    var me = await users.FindByUsernameAsync(username, ct);
    if (me is null)
        return Results.BadRequest(new { error = "Usuário não encontrado na base local." });

    var ok = await users.SetPinHashAsync(username, BCrypt.Net.BCrypt.HashPassword(pin), ct);
    return ok
        ? Results.Ok(new { ok = true })
        : Results.BadRequest(new { error = "Não foi possível salvar o PIN." });
}).RequireRateLimiting("login");

pin.MapPost("/validate", async (PinValidateRequest body, ClaimsPrincipal user, IAdminUserRepository users, IPinSessionStore sessions, TenantContext tenant, IConfiguration config, CancellationToken ct) =>
{
    var username = user.Identity?.Name ?? "";
    if (user.Identity?.IsAuthenticated != true || string.IsNullOrWhiteSpace(username))
        return Results.Unauthorized();

    var pin = (body.Pin ?? "").Trim();
    var me = await users.FindByUsernameAsync(username, ct);
    if (me is null)
        return Results.BadRequest(new { error = "Usuário não encontrado na base local." });

    if (!await users.HasPinHashAsync(username, ct))
        return Results.BadRequest(new { error = "PIN não configurado. Defina um PIN de 4 dígitos primeiro.", code = "pin_not_set" });

    if (!await users.VerifyPinHashAsync(username, pin, ct))
        return Results.BadRequest(new { error = "PIN incorreto.", code = "pin_invalid" });

    var minutes = int.TryParse(config["Pin:SessionMinutes"], out var m) && m > 0 ? m : 20;
    var expiresAt = DateTime.UtcNow.AddMinutes(minutes);
    var sessionId = await sessions.CreateAsync(me.Id, tenant.StoreId, expiresAt, ct);
    return Results.Ok(new PinValidateResponse(sessionId, expiresAt));
}).RequireRateLimiting("login");

pin.MapPost("/verify", async (PinSessionVerifyRequest body, ClaimsPrincipal user, IAdminUserRepository users, IPinSessionStore sessions, CancellationToken ct) =>
{
    var username = user.Identity?.Name ?? "";
    if (user.Identity?.IsAuthenticated != true || string.IsNullOrWhiteSpace(username))
        return Results.Unauthorized();

    var sessionId = (body.SessionId ?? "").Trim();
    var me = await users.FindByUsernameAsync(username, ct);
    if (me is null)
        return Results.Ok(new PinSessionVerifyResponse(false, null, false));

    var hasPin = await users.HasPinHashAsync(username, ct);
    if (string.IsNullOrWhiteSpace(sessionId))
        return Results.Ok(new PinSessionVerifyResponse(false, null, hasPin));

    var valid = await sessions.IsValidAsync(sessionId, me.Id, ct);
    return Results.Ok(new PinSessionVerifyResponse(valid, null, hasPin));
});

pin.MapPost("/logout", async (PinSessionVerifyRequest body, ClaimsPrincipal user, IAdminUserRepository users, IPinSessionStore sessions, CancellationToken ct) =>
{
    var username = user.Identity?.Name ?? "";
    if (user.Identity?.IsAuthenticated != true || string.IsNullOrWhiteSpace(username))
        return Results.Unauthorized();

    var sessionId = (body.SessionId ?? "").Trim();
    if (!string.IsNullOrWhiteSpace(sessionId))
        await sessions.RevokeAsync(sessionId, ct);
    return Results.Ok(new { ok = true });
});

// ── Gestão de garçons/equipe da loja (Admin) + PIN por garçom ──
// O cadastro pela aba Equipe é restrito ao papel Garçom (outros papéis são
// criados pela plataforma via /admin/platform-stores/{id}/users).
static bool IsGarcomStaffRole(string? role) =>
    string.Equals(role, "Garçom", StringComparison.OrdinalIgnoreCase)
    || string.Equals(role, "Garcom", StringComparison.OrdinalIgnoreCase);

var staff = api.MapGroup("/admin/staff").RequireAuthorization("StoreAdmin");

staff.MapGet("/", async (IAdminUserRepository users, TenantContext tenant, CancellationToken ct) =>
    Results.Ok(await users.ListStoreUsersAsync(tenant.StoreId, ct)));

staff.MapPost("/", async (CreateStoreUserRequest body, IAdminUserRepository users, TenantContext tenant, CancellationToken ct) =>
{
    if (!IsGarcomStaffRole(body.Role))
        return Results.BadRequest(new { error = "Este cadastro é restrito ao papel Garçom." });
    var err = CatalogInputValidation.ValidateStoreUser(body);
    if (err is not null) return Results.BadRequest(new { error = err });
    if (await users.UsernameExistsAsync(body.Username.Trim(), ct))
        return Results.Conflict(new { error = "Este usuário já existe." });
    var created = await users.CreateAsync(body with { StoreId = tenant.StoreId }, ct);
    return Results.Created($"/api/v1/admin/staff/{created.Id}", created);
});

staff.MapPut("/{userId:int}", async (
    int userId, UpdateStoreUserRequest body, IAdminUserRepository users, TenantContext tenant, CancellationToken ct) =>
{
    var target = await users.FindByIdAsync(userId, ct);
    if (target is null || target.StoreId != tenant.StoreId)
        return Results.NotFound(new { error = "Usuário não encontrado." });
    if (!IsGarcomStaffRole(body.Role))
        return Results.BadRequest(new { error = "Este cadastro é restrito ao papel Garçom." });
    var err = CatalogInputValidation.ValidateUpdateStoreUser(body, target);
    if (err is not null) return Results.BadRequest(new { error = err });
    StoreUserDto? updated;
    try
    {
        updated = await users.UpdateAsync(userId, body, ct);
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
    return updated is null
        ? Results.NotFound(new { error = "Usuário não encontrado." })
        : Results.Ok(updated);
});

staff.MapPost("/{userId:int}/reset-password", async (
    int userId, ResetStoreUserPasswordRequest body, IAdminUserRepository users, TenantContext tenant, CancellationToken ct) =>
{
    var target = await users.FindByIdAsync(userId, ct);
    if (target is null || target.StoreId != tenant.StoreId)
        return Results.NotFound(new { error = "Usuário não encontrado." });
    if (string.IsNullOrWhiteSpace(body.Password) || body.Password.Length < 6)
        return Results.BadRequest(new { error = "Senha muito curta (mín. 6 caracteres)." });
    await users.ResetPasswordAsync(userId, body.Password, ct);
    return Results.Ok(new { ok = true });
});

staff.MapDelete("/{userId:int}", async (int userId, IAdminUserRepository users, TenantContext tenant, CancellationToken ct) =>
{
    var target = await users.FindByIdAsync(userId, ct);
    if (target is null || target.StoreId != tenant.StoreId)
        return Results.NotFound(new { error = "Usuário não encontrado." });
    await users.DeleteAsync(userId, ct);
    return Results.Ok(new { ok = true });
});

staff.MapPost("/{userId:int}/pin", async (int userId, PinSetRequest body, IAdminUserRepository users, TenantContext tenant, CancellationToken ct) =>
{
    var target = await users.FindByIdAsync(userId, ct);
    if (target is null || target.StoreId != tenant.StoreId)
        return Results.NotFound(new { error = "Usuário não encontrado." });
    var pin = (body.Pin ?? "").Trim();
    if (pin.Length != 4 || !pin.All(char.IsDigit))
        return Results.BadRequest(new { error = "O PIN deve ter exatamente 4 dígitos." });
    await users.SetPinHashByUserIdAsync(userId, BCrypt.Net.BCrypt.HashPassword(pin), ct);
    return Results.Ok(new { ok = true });
}).RequireRateLimiting("login");

staff.MapDelete("/{userId:int}/pin", async (int userId, IAdminUserRepository users, TenantContext tenant, CancellationToken ct) =>
{
    var target = await users.FindByIdAsync(userId, ct);
    if (target is null || target.StoreId != tenant.StoreId)
        return Results.NotFound(new { error = "Usuário não encontrado." });
    await users.DeletePinHashByUserIdAsync(userId, ct);
    return Results.Ok(new { ok = true });
});

admin.MapGet("/catalog", async (ICatalogRepository repo, CancellationToken ct) =>
    Results.Ok(await repo.GetCatalogAsync(ct)));

admin.MapPut("/categories", async (UpsertCategoryRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    var request = body;
    if (string.IsNullOrWhiteSpace(body.Id))
    {
        var nextId = await repo.AllocateNextCategoryIdAsync(ct);
        request = body with { Id = nextId };
    }

    var err = CatalogInputValidation.ValidateCategory(request);
    if (err is not null) return Results.BadRequest(new { error = err });
    try
    {
        await repo.UpsertCategoryAsync(request, ct);
        return Results.Ok(await repo.GetCatalogAsync(ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
});

admin.MapDelete("/categories/{id}", async (string id, ICatalogRepository repo, CancellationToken ct) =>
{
    try
    {
        await repo.DeleteCategoryAsync(id, ct);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
});

admin.MapPost("/categories/{id}/move", async (string id, MoveItemRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    if (!CatalogInputValidation.IsSafeId(id))
        return Results.BadRequest(new { error = "Id inválido." });
    var err = CatalogInputValidation.ValidateMove(body);
    if (err is not null) return Results.BadRequest(new { error = err });
    await repo.MoveCategoryAsync(id, body.Direction, ct);
    return Results.Ok(await repo.GetCatalogAsync(ct));
});

admin.MapPut("/categories/reorder", async (ReorderItemsRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    var err = CatalogInputValidation.ValidateReorder(body);
    if (err is not null) return Results.BadRequest(new { error = err });
    try
    {
        await repo.ReorderCategoriesAsync(body.Ids, ct);
        return Results.Ok(await repo.GetCatalogAsync(ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
});

admin.MapGet("/ingredients", async (ICatalogRepository repo, CancellationToken ct) =>
    Results.Ok(await repo.GetIngredientsAsync(ct)));

admin.MapPut("/ingredients", async (UpsertIngredientRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    var request = body;
    if (string.IsNullOrWhiteSpace(body.Id))
    {
        var nextId = await repo.AllocateNextIngredientIdAsync(ct);
        request = body with { Id = nextId };
    }

    var err = CatalogInputValidation.ValidateIngredient(request);
    if (err is not null) return Results.BadRequest(new { error = err });
    if (!string.IsNullOrWhiteSpace(request.CategoryId))
    {
        var catalog = await repo.GetCatalogAsync(ct);
        var exists = catalog.Categories.Any(c => string.Equals(c.Id, request.CategoryId, StringComparison.OrdinalIgnoreCase));
        if (!exists)
            return Results.BadRequest(new { error = $"Categoria '{request.CategoryId}' não encontrada." });
    }
    try
    {
        await repo.UpsertIngredientAsync(request, ct);
        return Results.Ok(await repo.GetIngredientsAsync(ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
});

admin.MapDelete("/ingredients/{id}", async (string id, ICatalogRepository repo, CancellationToken ct) =>
{
    if (!CatalogInputValidation.IsSafeId(id))
        return Results.BadRequest(new { error = "Id inválido." });
    try
    {
        await repo.DeleteIngredientAsync(id, ct);
        return Results.NoContent();
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
});

admin.MapPost("/ingredients/{id}/move", async (string id, MoveItemRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    if (!CatalogInputValidation.IsSafeId(id))
        return Results.BadRequest(new { error = "Id inválido." });
    var err = CatalogInputValidation.ValidateMove(body);
    if (err is not null) return Results.BadRequest(new { error = err });
    await repo.MoveIngredientAsync(id, body.Direction, ct);
    return Results.Ok(await repo.GetIngredientsAsync(ct));
});

admin.MapPut("/ingredients/reorder", async (ReorderItemsRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    var err = CatalogInputValidation.ValidateReorder(body);
    if (err is not null) return Results.BadRequest(new { error = err });
    try
    {
        await repo.ReorderIngredientsAsync(body.Ids, ct);
        return Results.Ok(await repo.GetIngredientsAsync(ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
});

    static async Task<ProductDto?> FindProductForImageCleanupAsync(ICatalogRepository repo, string id, CancellationToken ct)
    {
        var catalog = await repo.GetCatalogAsync(ct);
        foreach (var c in catalog.Categories)
        {
            var p = c.Items.FirstOrDefault(i => string.Equals(i.Id, id, StringComparison.OrdinalIgnoreCase));
            if (p is not null) return p;
        }
        return null;
    }

    /// <summary>
    /// Verdadeiro se algum produto do catálogo ainda referencia a URL de imagem.
    /// Usado para nunca apagar um arquivo que é compartilhado por mais de um produto.
    /// </summary>
    static async Task<bool> IsImageUrlReferencedAsync(ICatalogRepository repo, string imageUrl, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(imageUrl)) return false;
        var catalog = await repo.GetCatalogAsync(ct);
        return catalog.Categories
            .SelectMany(c => c.Items)
            .Any(i => !string.IsNullOrWhiteSpace(i.ImageUrl)
                && string.Equals(i.ImageUrl, imageUrl, StringComparison.OrdinalIgnoreCase));
    }

admin.MapPut("/products", async (UpsertProductRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    var request = body;
    string? previousImageUrl = null;
    if (string.IsNullOrWhiteSpace(body.Id))
    {
        var nextId = await repo.AllocateNextProductIdAsync(ct);
        request = body with { Id = nextId };
    }
    else
    {
        var existing = await FindProductForImageCleanupAsync(repo, body.Id, ct);
        previousImageUrl = existing?.ImageUrl;
    }

    var err = CatalogInputValidation.ValidateProduct(request);
    if (err is not null) return Results.BadRequest(new { error = err });
    try
    {
        await repo.UpsertProductAsync(request, ct);
        if (!string.IsNullOrWhiteSpace(previousImageUrl)
            && !string.Equals(previousImageUrl, request.ImageUrl, StringComparison.OrdinalIgnoreCase)
            && !await IsImageUrlReferencedAsync(repo, previousImageUrl, ct))
        {
            ImageStorage.TryDeleteUpload(previousImageUrl, uploadsRoot);
        }
        return Results.Ok(await repo.GetCatalogAsync(ct));
    }
    catch (KeyNotFoundException ex)
    {
        return Results.NotFound(new { error = ex.Message });
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
});

admin.MapDelete("/products/{id}", async (string id, ICatalogRepository repo, CancellationToken ct) =>
{
    if (!CatalogInputValidation.IsSafeId(id))
        return Results.BadRequest(new { error = "Id inválido." });

    var existing = await FindProductForImageCleanupAsync(repo, id, ct);
    await repo.DeleteProductAsync(id, ct);
    if (!string.IsNullOrWhiteSpace(existing?.ImageUrl)
        && !await IsImageUrlReferencedAsync(repo, existing.ImageUrl, ct))
        ImageStorage.TryDeleteUpload(existing.ImageUrl, uploadsRoot);
    return Results.NoContent();
});

admin.MapPost("/products/{id}/move", async (string id, MoveItemRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    if (!CatalogInputValidation.IsSafeId(id))
        return Results.BadRequest(new { error = "Id inválido." });
    var err = CatalogInputValidation.ValidateMove(body);
    if (err is not null) return Results.BadRequest(new { error = err });
    await repo.MoveProductAsync(id, body.Direction, ct);
    return Results.Ok(await repo.GetCatalogAsync(ct));
});

admin.MapPut("/products/reorder", async (ReorderItemsRequest body, ICatalogRepository repo, CancellationToken ct) =>
{
    var err = CatalogInputValidation.ValidateReorder(body, requireCategory: true);
    if (err is not null) return Results.BadRequest(new { error = err });
    try
    {
        await repo.ReorderProductsAsync(body.CategoryId!, body.Ids, ct);
        return Results.Ok(await repo.GetCatalogAsync(ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.Conflict(new { error = ex.Message });
    }
    catch (KeyNotFoundException ex)
    {
        return Results.NotFound(new { error = ex.Message });
    }
});

admin.MapPost("/logo", async (HttpRequest request, ICatalogRepository repo, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "multipart/form-data esperado." });

    var form = await request.ReadFormAsync(ct);
    var file = form.Files.GetFile("file");
    if (file is null)
        return Results.BadRequest(new { error = "Arquivo 'file' obrigatório." });

    var err = CatalogInputValidation.ValidateUpload(file, out var ext);
    if (err is not null) return Results.BadRequest(new { error = err });

    var fileName = $"logo-{Guid.NewGuid():N}{ext}";
    var path = Path.Combine(uploadsRoot, fileName);
    await using (var fs = File.Create(path))
    {
        await file.CopyToAsync(fs, ct);
    }

    var logoUrl = $"/uploads/{fileName}";
    await repo.UpdateStoreAsync(new PatchStoreRequest { LogoUrl = logoUrl }, ct);
    return Results.Ok(new { logoUrl });
});

admin.MapPost("/icon", async (HttpRequest request, ICatalogRepository repo, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "multipart/form-data esperado." });

    var form = await request.ReadFormAsync(ct);
    var file = form.Files.GetFile("file");
    if (file is null)
        return Results.BadRequest(new { error = "Arquivo 'file' obrigatório." });

    var err = CatalogInputValidation.ValidateUpload(file, out var ext);
    if (err is not null) return Results.BadRequest(new { error = err });

    var fileName = $"icon-{Guid.NewGuid():N}{ext}";
    var path = Path.Combine(uploadsRoot, fileName);
    await using (var fs = File.Create(path))
    {
        await file.CopyToAsync(fs, ct);
    }

    var iconUrl = $"/uploads/{fileName}";
    await repo.UpdateStoreAsync(new PatchStoreRequest { IconUrl = iconUrl }, ct);
    return Results.Ok(new { iconUrl });
});

admin.MapPost("/product-image", async (HttpRequest request, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "multipart/form-data esperado." });

    var form = await request.ReadFormAsync(ct);
    var file = form.Files.GetFile("file");
    if (file is null)
        return Results.BadRequest(new { error = "Arquivo 'file' obrigatório." });

    var err = CatalogInputValidation.ValidateProductImage(file);
    if (err is not null) return Results.BadRequest(new { error = err });

    var name = form["name"].ToString().Trim();
    if (name.Length > 120)
        return Results.BadRequest(new { error = "Nome do produto muito longo." });

    var currentImageUrl = form["currentImageUrl"].ToString().Trim();

    var imageUrl = await ImageStorage.SaveProductImageAsync(file.OpenReadStream(), uploadsRoot, ct, name, currentImageUrl);
    if (imageUrl is null)
        return Results.BadRequest(new { error = "Imagem inválida. Envie um arquivo PNG, JPG ou WEBP." });

    return Results.Ok(new { imageUrl });
});

admin.MapGet("/images/missing", async (ICatalogRepository repo, CancellationToken ct) =>
{
    var catalog = await repo.GetCatalogAsync(ct);
    var missing = ImageStorage.FindMissingProductImages(
        catalog.Categories.SelectMany(c => c.Items)
            .Select(i => (i.Id, i.Name, i.ImageUrl)),
        uploadsRoot);
    return Results.Ok(new { products = missing });
});

var analytics = api.MapGroup("/analytics");
analytics.MapPost("/pageview", (TrafficPageviewRequest? body, TrafficStatsService traffic) =>
{
    var path = body?.Path;
    traffic.Record("pageview", string.IsNullOrWhiteSpace(path) ? "home" : path);
    return Results.StatusCode(StatusCodes.Status202Accepted);
}).RequireRateLimiting("analytics-pageview");

analytics.MapPost("/hit", (TrafficHitRequest? body, TrafficStatsService traffic) =>
{
    var route = !string.IsNullOrWhiteSpace(body?.Route)
        ? body!.Route
        : body?.Path;
    var count = body?.Count is > 0 and <= 500 ? body.Count.Value : 1;
    traffic.Record(body?.Source ?? "api", route, count);
    return Results.StatusCode(StatusCodes.Status202Accepted);
}).RequireRateLimiting("analytics-hit");

api.MapGet("/admin/platform-traffic", (TrafficStatsService traffic, int? days) =>
    Results.Ok(traffic.GetSummary(days ?? 7))
).RequireAuthorization("PlatformDev");

// Métricas do cache em memória (IMemoryCache, TrackStatistics) — hit/miss ratio para
// acompanhar a redução de leituras no PostgreSQL. Requer o painel (papel Dev/plataforma).
api.MapGet("/admin/cache/stats", (IMemoryCache cache) =>
{
    var stats = cache.GetCurrentStatistics();
    if (stats is null)
    {
        return Results.Ok(new
        {
            tracked = false,
            message = "TrackStatistics desabilitado. Configure AddMemoryCache(options => options.TrackStatistics = true)."
        });
    }

    var total = stats.TotalHits + stats.TotalMisses;
    return Results.Ok(new
    {
        tracked = true,
        hits = stats.TotalHits,
        misses = stats.TotalMisses,
        totalRequests = total,
        hitRatio = total == 0 ? 0 : Math.Round((double)stats.TotalHits / total, 4),
        count = stats.CurrentEntryCount,
        estimatedSize = stats.CurrentEstimatedSize
    });
}).RequireAuthorization("PlatformDev");

// Estatísticas operacionais da loja atual (por tenant). Usado pelo painel Dev para
// buscar o snapshot remoto de uma loja e pelo próprio painel de loja quando hospedado.
var storeStats = api.MapGroup("/admin/platform").RequireAuthorization("StoreAdmin");
storeStats.MapGet("/store-stats", async (TenantContext tenant, StoreStatsService svc, CancellationToken ct) =>
    Results.Ok(await svc.ComputeAsync(tenant.StoreId, ct)));

var platform = api.MapGroup("/admin/platform-stores").RequireAuthorization("PlatformDev");

platform.MapGet("/", async (
    IPlatformStoreRepository repo,
    string? search,
    string? status,
    string? city,
    string? plan,
    string? segment,
    CancellationToken ct) =>
{
    IEnumerable<PlatformStoreDto> result = await repo.ListAsync(ct);
    if (!string.IsNullOrWhiteSpace(search))
    {
        var q = search.Trim();
        result = result.Where(x =>
            (x.Name?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false)
            || (x.Cnpj?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false)
            || (x.RazaoSocial?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false)
            || (x.ContactName?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false)
            || (x.City?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false)
            || (x.Domain?.Contains(q, StringComparison.OrdinalIgnoreCase) ?? false));
    }
    if (!string.IsNullOrWhiteSpace(status))
        result = result.Where(x => string.Equals(x.Status, status.Trim(), StringComparison.OrdinalIgnoreCase));
    if (!string.IsNullOrWhiteSpace(city))
        result = result.Where(x => string.Equals(x.City, city.Trim(), StringComparison.OrdinalIgnoreCase));
    if (!string.IsNullOrWhiteSpace(plan))
        result = result.Where(x => string.Equals(x.Plan, plan.Trim(), StringComparison.OrdinalIgnoreCase));
    if (!string.IsNullOrWhiteSpace(segment))
        result = result.Where(x => string.Equals(x.Segment, segment.Trim(), StringComparison.OrdinalIgnoreCase));
    return Results.Ok(result.ToList());
});

platform.MapGet("/{id:guid}", async (Guid id, IPlatformStoreRepository repo, CancellationToken ct) =>
{
    var item = await repo.GetAsync(id, ct);
    return item is null ? Results.NotFound(new { error = "Loja não encontrada." }) : Results.Ok(item);
});

platform.MapPost("/", async (UpsertPlatformStoreRequest body, IPlatformStoreRepository repo, IAdminUserRepository users, CancellationToken ct) =>
{
    var err = CatalogInputValidation.ValidatePlatformStore(body);
    if (err is not null) return Results.BadRequest(new { error = err });

    string? adminUsername = null;
    string? adminPassword = null;
    if (!string.IsNullOrWhiteSpace(body.AdminUsername) || !string.IsNullOrWhiteSpace(body.AdminPassword))
    {
        var userErr = CatalogInputValidation.ValidateStoreUser(
            new CreateStoreUserRequest(body.AdminUsername ?? "", body.AdminPassword ?? "", "Admin"));
        if (userErr is not null) return Results.BadRequest(new { error = userErr });
        if (await users.UsernameExistsAsync(body.AdminUsername!.Trim(), ct))
            return Results.Conflict(new { error = "Este usuário já existe. Escolha outro nome de usuário." });
        adminUsername = body.AdminUsername.Trim();
        adminPassword = body.AdminPassword;
    }

    var created = await repo.CreateAsync(body, ct);
    if (adminUsername is not null)
    {
        await users.CreateAsync(new CreateStoreUserRequest(adminUsername, adminPassword!, "Admin", created.StoreId), ct);
    }
    return Results.Created(
        $"/api/v1/admin/platform-stores/{created.Id}",
        new CreatePlatformStoreResponse(created, adminUsername ?? "", adminPassword, created.StoreId is not null));
});

platform.MapPut("/{id:guid}", async (Guid id, UpsertPlatformStoreRequest body, IPlatformStoreRepository repo, CancellationToken ct) =>
{
    var err = CatalogInputValidation.ValidatePlatformStore(body);
    if (err is not null) return Results.BadRequest(new { error = err });
    var updated = await repo.UpdateAsync(id, body, ct);
    return updated is null
        ? Results.NotFound(new { error = "Loja não encontrada." })
        : Results.Ok(updated);
});

platform.MapDelete("/{id:guid}", async (Guid id, IPlatformStoreRepository repo, CancellationToken ct) =>
{
    var existing = await repo.GetAsync(id, ct);
    if (existing is null) return Results.NotFound(new { error = "Loja não encontrada." });
    if (existing.StoreId == 1)
        return Results.Conflict(new { error = "Esta é a loja em execução (Fabin Lanches) e não pode ser excluída." });
    var ok = await repo.DeleteAsync(id, ct);
    return ok ? Results.NoContent() : Results.NotFound(new { error = "Loja não encontrada." });
});

platform.MapPost("/{id:guid}/duplicate", async (Guid id, UpsertPlatformStoreRequest? body, IPlatformStoreRepository repo, IAdminUserRepository users, CancellationToken ct) =>
{
    string? adminUsername = null;
    string? adminPassword = null;
    if (body is not null && (!string.IsNullOrWhiteSpace(body.AdminUsername) || !string.IsNullOrWhiteSpace(body.AdminPassword)))
    {
        var userErr = CatalogInputValidation.ValidateStoreUser(
            new CreateStoreUserRequest(body.AdminUsername ?? "", body.AdminPassword ?? "", "Admin"));
        if (userErr is not null) return Results.BadRequest(new { error = userErr });
        if (await users.UsernameExistsAsync(body.AdminUsername!.Trim(), ct))
            return Results.Conflict(new { error = "Este usuário já existe. Escolha outro nome de usuário." });
        adminUsername = body.AdminUsername.Trim();
        adminPassword = body.AdminPassword;
    }

    PlatformStoreDto copy;
    try
    {
        copy = await repo.DuplicateAsync(id, ct);
    }
    catch (KeyNotFoundException)
    {
        return Results.NotFound(new { error = "Loja não encontrada." });
    }

    if (adminUsername is not null)
    {
        await users.CreateAsync(new CreateStoreUserRequest(adminUsername, adminPassword!, "Admin", copy.StoreId), ct);
    }
    return Results.Created(
        $"/api/v1/admin/platform-stores/{copy.Id}",
        new CreatePlatformStoreResponse(copy, adminUsername ?? "", adminPassword, copy.StoreId is not null));
});

platform.MapPost("/{id:guid}/payments", async (Guid id, RegisterPlatformPaymentRequest body, IPlatformStoreRepository repo, CancellationToken ct) =>
{
    var updated = await repo.RegisterPaymentAsync(id, body, ct);
    return updated is null
        ? Results.NotFound(new { error = "Loja não encontrada." })
        : Results.Ok(updated);
});

platform.MapPost("/{id:guid}/logo", async (Guid id, HttpRequest request, IPlatformStoreRepository repo, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "multipart/form-data esperado." });
    var form = await request.ReadFormAsync(ct);
    var file = form.Files.GetFile("file");
    if (file is null)
        return Results.BadRequest(new { error = "Arquivo 'file' obrigatório." });

    var err = CatalogInputValidation.ValidateUpload(file, out var ext);
    if (err is not null) return Results.BadRequest(new { error = err });

    var existing = await repo.GetAsync(id, ct);
    if (existing is null) return Results.NotFound(new { error = "Loja não encontrada." });
    if (!string.IsNullOrWhiteSpace(existing.LogoUrl))
        ImageStorage.TryDeleteUpload(existing.LogoUrl, uploadsRoot);

    var storeDir = Path.Combine(uploadsRoot, "stores", id.ToString("N"));
    Directory.CreateDirectory(storeDir);
    var fileName = $"logo-{Guid.NewGuid():N}{ext}";
    var path = Path.Combine(storeDir, fileName);
    await using (var fs = File.Create(path))
    {
        await file.CopyToAsync(fs, ct);
    }

    var logoUrl = $"/uploads/stores/{id:N}/{fileName}";
    var updated = await repo.SetLogoAsync(id, logoUrl, ct);
    return updated is null
        ? Results.NotFound(new { error = "Loja não encontrada." })
        : Results.Ok(new { logoUrl, store = updated });
});

platform.MapPost("/{id:guid}/gallery", async (Guid id, HttpRequest request, IPlatformStoreRepository repo, CancellationToken ct) =>
{
    if (!request.HasFormContentType)
        return Results.BadRequest(new { error = "multipart/form-data esperado." });
    var form = await request.ReadFormAsync(ct);
    var file = form.Files.GetFile("file");
    if (file is null)
        return Results.BadRequest(new { error = "Arquivo 'file' obrigatório." });

    var err = CatalogInputValidation.ValidateUpload(file, out var ext);
    if (err is not null) return Results.BadRequest(new { error = err });

    if (await repo.GetAsync(id, ct) is null)
        return Results.NotFound(new { error = "Loja não encontrada." });

    var title = form["title"].ToString().Trim();
    if (title.Length > 120)
        return Results.BadRequest(new { error = "Título muito longo." });
    var type = form["type"].ToString().Trim();
    if (type is not ("photo" or "logo" or "banner"))
        type = "photo";

    var storeDir = Path.Combine(uploadsRoot, "stores", id.ToString("N"));
    Directory.CreateDirectory(storeDir);
    var fileName = $"gallery-{Guid.NewGuid():N}{ext}";
    var path = Path.Combine(storeDir, fileName);
    await using (var fs = File.Create(path))
    {
        await file.CopyToAsync(fs, ct);
    }

    var image = new GalleryImageDto(Guid.NewGuid().ToString("N"), title, type, $"/uploads/stores/{id:N}/{fileName}", DateTime.UtcNow);
    var updated = await repo.AddGalleryImageAsync(id, image, ct);
    return updated is null
        ? Results.NotFound(new { error = "Loja não encontrada." })
        : Results.Ok(new { image, store = updated });
});

platform.MapDelete("/{id:guid}/gallery/{imageId}", async (Guid id, string imageId, IPlatformStoreRepository repo, CancellationToken ct) =>
{
    var existing = await repo.GetAsync(id, ct);
    if (existing is null) return Results.NotFound(new { error = "Loja não encontrada." });
    var target = (existing.Gallery ?? []).FirstOrDefault(g => g.Id == imageId);
    var updated = await repo.RemoveGalleryImageAsync(id, imageId, ct);
    if (target is not null)
        ImageStorage.TryDeleteUpload(target.Url, uploadsRoot);
    return updated is null
        ? Results.NotFound(new { error = "Loja não encontrada." })
        : Results.Ok(updated);
});

platform.MapGet("/{id:guid}/users", async (Guid id, IPlatformStoreRepository repo, IAdminUserRepository users, CancellationToken ct) =>
{
    var store = await repo.GetAsync(id, ct);
    if (store is null) return Results.NotFound(new { error = "Loja não encontrada." });
    return Results.Ok(await users.ListStoreUsersAsync(store.StoreId, ct));
});

platform.MapPost("/{id:guid}/users", async (Guid id, CreateStoreUserRequest body, IPlatformStoreRepository repo, IAdminUserRepository users, CancellationToken ct) =>
{
    var store = await repo.GetAsync(id, ct);
    if (store is null) return Results.NotFound(new { error = "Loja não encontrada." });

    var err = CatalogInputValidation.ValidateStoreUser(body);
    if (err is not null) return Results.BadRequest(new { error = err });
    if (await users.UsernameExistsAsync(body.Username.Trim(), ct))
        return Results.Conflict(new { error = "Este usuário já existe." });

    var created = await users.CreateAsync(body with { StoreId = store.StoreId }, ct);
    return Results.Created($"/api/v1/admin/platform-stores/{id}/users/{created.Id}", created);
});

platform.MapPost("/{id:guid}/users/{userId:int}/reset-password", async (Guid id, int userId, ResetStoreUserPasswordRequest body, IPlatformStoreRepository repo, IAdminUserRepository users, CancellationToken ct) =>
{
    if (await repo.GetAsync(id, ct) is null)
        return Results.NotFound(new { error = "Loja não encontrada." });
    if (string.IsNullOrWhiteSpace(body.Password) || body.Password.Length < 6)
        return Results.BadRequest(new { error = "Senha muito curta (mín. 6 caracteres)." });
    var ok = await users.ResetPasswordAsync(userId, body.Password, ct);
    return ok ? Results.Ok(new { ok = true }) : Results.NotFound(new { error = "Usuário não encontrado." });
});

platform.MapDelete("/{id:guid}/users/{userId:int}", async (Guid id, int userId, IPlatformStoreRepository repo, IAdminUserRepository users, CancellationToken ct) =>
{
    if (await repo.GetAsync(id, ct) is null)
        return Results.NotFound(new { error = "Loja não encontrada." });
    var ok = await users.DeleteAsync(userId, ct);
    return ok ? Results.NoContent() : Results.NotFound(new { error = "Usuário não encontrado." });
});

var dbx = api.MapGroup("/admin/db").RequireAuthorization("PlatformDev");

dbx.MapGet("/tables", async (DbExplorerService svc, CancellationToken ct) =>
    svc.IsAvailable
        ? Results.Ok(await svc.GetTablesAsync(ct))
        : Results.NotFound(new { error = "Explorador de banco disponível apenas com Persistence=PostgreSQL." }));

dbx.MapGet("/stores", async (DbExplorerService svc, CancellationToken ct) =>
    svc.IsAvailable
        ? Results.Ok(await svc.ListStoresAsync(ct))
        : Results.NotFound(new { error = "Explorador de banco disponível apenas com Persistence=PostgreSQL." }));

dbx.MapGet("/tables/{table}/rows", async (
    string table,
    int storeId,
    string? q,
    string? orderBy,
    string? orderDir,
    int page,
    int pageSize,
    DbExplorerService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable)
        return Results.NotFound(new { error = "Explorador de banco disponível apenas com Persistence=PostgreSQL." });
    try
    {
        var result = await svc.QueryRowsAsync(table, storeId, q, orderBy, orderDir, page, pageSize, ct);
        return result is null
            ? Results.NotFound(new { error = $"Tabela '{table}' não encontrada." })
            : Results.Ok(result);
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

dbx.MapPost("/tables/{table}/rows", async (
    string table,
    int storeId,
    JsonElement body,
    DbExplorerService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable)
        return Results.NotFound(new { error = "Explorador de banco disponível apenas com Persistence=PostgreSQL." });
    try
    {
        var row = await svc.InsertRowAsync(table, storeId, body, ct);
        return row is null
            ? Results.NotFound(new { error = $"Tabela '{table}' não encontrada." })
            : Results.Created($"/api/v1/admin/db/tables/{table}/rows", row);
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

dbx.MapPut("/tables/{table}/rows", async (
    string table,
    int storeId,
    JsonElement body,
    DbExplorerService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable)
        return Results.NotFound(new { error = "Explorador de banco disponível apenas com Persistence=PostgreSQL." });
    try
    {
        var row = await svc.UpdateRowAsync(table, storeId, body, ct);
        return row is null
            ? Results.NotFound(new { error = "Registro não encontrado (ou tabela inexistente)." })
            : Results.Ok(row);
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

dbx.MapDelete("/tables/{table}/rows", async (
    string table,
    int storeId,
    [FromBody] JsonElement body,
    DbExplorerService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable)
        return Results.NotFound(new { error = "Explorador de banco disponível apenas com Persistence=PostgreSQL." });
    try
    {
        var deleted = await svc.DeleteRowAsync(table, storeId, body, ct);
        return deleted ? Results.NoContent() : Results.NotFound(new { error = "Registro não encontrado (ou tabela inexistente)." });
    }
    catch (Exception ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

var tools = api.MapGroup("/admin/tools").RequireAuthorization("PlatformDev");

static IResult ToolsUnavailable() =>
    Results.NotFound(new { error = "Ferramentas de loja disponíveis apenas com Persistence=PostgreSQL." });

tools.MapGet("/{storeId:int}/status", async (int storeId, RemoteStoreToolsService svc, CancellationToken ct) =>
    svc.IsAvailable
        ? storeId <= 0
            ? Results.BadRequest(new { error = "StoreId inválido." })
            : Results.Ok(await svc.GetStatusAsync(storeId, ct))
        : ToolsUnavailable());

tools.MapGet("/{storeId:int}/compare", async (int storeId, RemoteStoreToolsService svc, CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    try
    {
        return Results.Ok(await svc.CompareAsync(storeId, ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

tools.MapPost("/{storeId:int}/backup", async (int storeId, RemoteStoreToolsService svc, CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    try
    {
        return Results.Ok(await svc.BackupAsync(storeId, ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

tools.MapPost("/{storeId:int}/sync-from-remote", async (
    int storeId,
    bool dryRun,
    bool skipDelete,
    SyncSelectionDto? selection,
    RemoteStoreToolsService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    try
    {
        return Results.Ok(await svc.SyncFromRemoteAsync(storeId, dryRun, skipDelete, selection, ct));
    }
    catch (NpgsqlException ex) when (ex.SqlState is PostgresErrorCodes.ForeignKeyViolation)
    {
        return Results.BadRequest(new
        {
            error = "Não foi possível aplicar o download porque existe uma referência inválida no catálogo remoto. Execute a simulação, confira os ingredientes vinculados e tente novamente."
        });
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

tools.MapPost("/{storeId:int}/sync-preview", async (
    int storeId,
    bool skipDelete,
    SyncSelectionDto? selection,
    RemoteStoreToolsService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    try
    {
        return Results.Ok(await svc.SyncPreviewAsync(storeId, selection, skipDelete, ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

tools.MapPost("/{storeId:int}/orders-preview", async (
    int storeId,
    RemoteStoreToolsService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    try
    {
        return Results.Ok(await svc.OrdersPreviewAsync(storeId, ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

tools.MapPost("/{storeId:int}/orders-sync", async (
    int storeId,
    bool dryRun,
    RemoteStoreToolsService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    try
    {
        return Results.Ok(await svc.SyncOrdersAsync(storeId, dryRun, ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

tools.MapPost("/{storeId:int}/upload-to-remote", async (
    int storeId,
    bool dryRun,
    bool skipDelete,
    SyncSelectionDto? selection,
    RemoteStoreToolsService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    try
    {
        return Results.Ok(await svc.UploadToRemoteAsync(storeId, dryRun, skipDelete, selection, ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

tools.MapPost("/{storeId:int}/upload-preview", async (
    int storeId,
    bool skipDelete,
    SyncSelectionDto? selection,
    RemoteStoreToolsService svc,
    CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    try
    {
        return Results.Ok(await svc.UploadPreviewAsync(storeId, skipDelete, selection, ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

tools.MapGet("/{storeId:int}/backups", async (int storeId, RemoteStoreToolsService svc, CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    return Results.Ok(await svc.ListBackupsAsync(storeId, ct));
});

tools.MapGet("/{storeId:int}/backups/{name}/zip", async (int storeId, string name, RemoteStoreToolsService svc, CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    var bytes = await svc.BuildBackupZipAsync(storeId, name, ct);
    if (bytes is null) return Results.NotFound(new { error = "Backup não encontrado." });
    return Results.File(bytes, "application/zip", $"backup-{name}.zip");
});

tools.MapPost("/{storeId:int}/stats", async (int storeId, RemoteStoreToolsService svc, CancellationToken ct) =>
{
    if (!svc.IsAvailable) return ToolsUnavailable();
    if (storeId <= 0) return Results.BadRequest(new { error = "StoreId inválido." });
    try
    {
        return Results.Ok(await svc.FetchRemoteStatsAsync(storeId, ct));
    }
    catch (InvalidOperationException ex)
    {
        return Results.BadRequest(new { error = ex.Message });
    }
});

app.Run();

public partial class Program;
