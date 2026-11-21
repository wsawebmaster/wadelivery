using System.Text;
using System.Text.Json;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.IdentityModel.Tokens;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Orders.Api;
using Orders.Api.Data;
using Orders.Api.Messaging;
using Orders.Api.Models;
using Orders.Api.Services;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .Enrich.WithProperty("service", "orders-api")
    .WriteTo.Console()
    .CreateLogger();
builder.Host.UseSerilog();

var corsOrigins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>()
    ?? ["http://localhost:8080", "http://127.0.0.1:8080", "http://localhost:8081", "http://127.0.0.1:8081"];

var conn = builder.Configuration.GetConnectionString("Postgres")
    ?? builder.Configuration.GetConnectionString("Default")
    ?? "Host=localhost;Port=5432;Database=delivery_catalog;Username=delivery;Password=delivery";

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

builder.Services.AddScoped<Orders.Api.Data.TenantRlsInterceptor>();
builder.Services.AddDbContext<OrdersDbContext>((sp, opt) =>
    opt.UseNpgsql(conn)
       .AddInterceptors(sp.GetRequiredService<Orders.Api.Data.TenantRlsInterceptor>()));

builder.Services.AddHttpContextAccessor();
builder.Services.AddScoped<Orders.Api.MultiTenancy.TenantContext>();
builder.Services.AddMemoryCache();

builder.Services.AddSingleton<IOrderEventPublisher, RabbitMqOrderEventPublisher>();
builder.Services.AddHostedService<OrderCreatedConsumer>();
builder.Services.AddSingleton<AutoAdvanceScheduler>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<AutoAdvanceScheduler>());

var catalogBase = builder.Configuration["CatalogApi:BaseUrl"] ?? "http://localhost:5101";
builder.Services.AddHttpClient<CatalogPricingClient>(c =>
{
    c.BaseAddress = new Uri(catalogBase.TrimEnd('/') + "/");
    c.Timeout = TimeSpan.FromSeconds(12);
});

builder.Services.AddCors(o => o.AddPolicy("Frontend", p =>
    p.SetIsOriginAllowed(origin => Orders.Api.CorsLan.IsOriginAllowed(origin, corsOrigins))
        .AllowAnyHeader()
        .AllowAnyMethod()));

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
            RoleClaimType = System.Security.Claims.ClaimTypes.Role
        };
    });
builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("OrdersStaff", p =>
        p.RequireRole("Admin", "AdminLoja", "Atendimento", "Garçom"));
    // Admin da loja (compat) + Dev da plataforma (KPI agregado no dashboard Dev)
    options.AddPolicy("DevOnly", p =>
        p.RequireRole("Admin", "AdminLoja", "Dev"));
});

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.AddPolicy("create-order", httpContext =>
        RateLimitPartition.GetFixedWindowLimiter(
            httpContext.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 10,
                Window = TimeSpan.FromMinutes(1),
                QueueLimit = 0
            }));
});

builder.Services.AddOpenApi();
if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"])
    || !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT")))
{
    builder.Services.AddOpenTelemetry()
        .ConfigureResource(r => r.AddService("orders-api"))
        .WithTracing(t => t
            .AddAspNetCoreInstrumentation()
            .AddHttpClientInstrumentation()
            .AddOtlpExporter());
}

var app = builder.Build();

for (var attempt = 1; attempt <= 20; attempt++)
{
    try
    {
        using var scope = app.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<OrdersDbContext>();
        await db.Database.EnsureCreatedAsync();
        await EnsureSchemaAsync(db);
        break;
    }
    catch (Exception ex) when (attempt < 20)
    {
            Log.Warning(ex, "PostgreSQL ainda não pronto (tentativa {Attempt}/20). Aguardando…", attempt);
        await Task.Delay(TimeSpan.FromSeconds(3));
    }
}

app.UseSerilogRequestLogging();
app.UseCors("Frontend");
app.UseRateLimiter();
app.UseAuthentication();
app.UseMiddleware<Orders.Api.MultiTenancy.TenantSlugResolutionMiddleware>();
app.UseAuthorization();
if (app.Environment.IsDevelopment())
    app.MapOpenApi();

var api = app.MapGroup("/api/v1");

api.MapGet("/health", () => Results.Ok(new
{
    status = "healthy",
    service = "orders-api",
    utc = DateTime.UtcNow
}));

api.MapPost("/orders", async (
    CreateOrderRequest body,
    OrdersDbContext db,
    CatalogPricingClient pricing,
    IOrderEventPublisher publisher,
    Orders.Api.MultiTenancy.TenantContext tenant,
    HttpContext http,
    CancellationToken ct) =>
{
    if (!tenant.TryGetStoreId(out var storeId) || storeId <= 0)
        return Results.BadRequest(new { error = "Nenhum tenant foi informado. Forneça o cabeçalho X-Tenant-Slug." });

    var validationError = OrderValidation.ValidateCreate(body);
    if (validationError is not null)
        return Results.BadRequest(new { error = validationError });

    // ── Idempotência: mesmo ClientRequestId + loja → devolve o pedido já criado ──
    // Processamento lento (precificação/RabbitMQ) pode fazer o cliente reenviar o
    // pedido; sem isso teríamos duplicidade. A checagem vem ANTES das chamadas
    // lentas para que o retry responda rápido e nunca crie dois pedidos.
    var clientRequestId = string.IsNullOrWhiteSpace(body.ClientRequestId) ? null : body.ClientRequestId.Trim();
    if (clientRequestId is not null && clientRequestId.Length > 72)
        return Results.BadRequest(new { error = "ClientRequestId é inválido (máx. 72 caracteres)." });

    if (clientRequestId is not null)
    {
        var existing = await db.Orders.AsNoTracking()
            .FirstOrDefaultAsync(o => o.StoreId == tenant.StoreId && o.ClientRequestId == clientRequestId, ct);
        if (existing is not null)
        {
            OrderChangeNotifier.Publish("created");
            OrderChangeNotifier.PublishForOrder(existing.OrderId, "created");
            return Results.Ok(OrderMapping.ToResponse(existing, includeAccessToken: true));
        }
    }

    var isPickup = CatalogPricingClient.IsPickup(body);
    var isDineIn = CatalogPricingClient.IsDineIn(body);

    var (pricedItems, itemsTotal, priceError) = await pricing.PriceItemsAsync(body.Items, ct);
    if (priceError is not null)
        return Results.BadRequest(new { error = priceError });

    var (deliveryFee, deliveryError) = await pricing.QuoteDeliveryAsync(body, ct);
    if (deliveryError is not null)
        return Results.BadRequest(new { error = deliveryError });

    var storeStatus = await pricing.GetStoreStatusAsync(ct);
    if (storeStatus is { Accepting: false })
    {
        return Results.Conflict(new
        {
            error = storeStatus.Value.Message ?? "Loja indisponível no momento. Tente novamente mais tarde.",
            code = "store_unavailable"
        });
    }

    var orderId = $"FL-{Guid.NewGuid():N}"[..15].ToUpperInvariant();
    var accessToken = Guid.NewGuid().ToString("N");

    var paymentMethod = body.PaymentMethod.Trim();
    var paymentTiming = OrderPayment.NormalizeTiming(body.PaymentTiming, paymentMethod);
    var paymentStatus = OrderPayment.InitialStatus(paymentTiming);

    // ── Dine-in: resolver mesa e origem ──
    int? tableId = null;
    string? tableLabel = null;
    string? tableAccessCode = null;
    string? orderSource = null;
    int? createdByUserId = null;
    string? createdByUsername = null;
    string? createdByRole = null;
    int? waiterId = null;
    string? waiterName = null;

    if (isDineIn)
    {
        var dineIn = await pricing.GetDineInConfigAsync(ct);
        if (!dineIn.DineInEnabled)
            return Results.Conflict(new { error = "Consumo no local está desabilitado.", code = "dine_in_disabled" });

        orderSource = (body.OrderSource ?? "").Trim().ToLowerInvariant();

        if (orderSource == "customer_qr")
        {
            if (!dineIn.CustomerQrOrdersEnabled)
                return Results.Conflict(new { error = "Pedidos do cliente via QR Code estão desabilitados.", code = "customer_qr_disabled" });

            // Pedido do cliente via QR Code — validar tableAccessCode
            var accessCode = (body.TableAccessCode ?? "").Trim();
            if (string.IsNullOrWhiteSpace(accessCode))
                return Results.BadRequest(new { error = "Código da mesa é obrigatório." });

            var table = await db.StoreTables.AsNoTracking()
                .FirstOrDefaultAsync(t => t.AccessCode == accessCode && t.StoreId == tenant.StoreId, ct);
            if (table is null || !table.Active)
                return Results.BadRequest(new { error = "Mesa inválida ou inativa." });
            if (!table.AllowCustomerOrder)
                return Results.BadRequest(new { error = "Esta mesa não aceita pedidos pelo cliente." });

            tableId = table.Id;
            tableLabel = table.Label;
            tableAccessCode = accessCode;
        }
        else if (orderSource == "waiter_panel" || orderSource == "admin_panel")
        {
            // Pedidos do garçom/atendente exigem JWT de equipe (validado abaixo),
            // portanto NÃO são gated pelo flag WaiterOrdersEnabled (que se aplica
            // a fluxos de cliente). Mesmo critério do admin_panel, que nunca foi
            // bloqueado por esse flag.

            // Pedido do garçom — exige JWT
            var isStaff = http.User.Identity?.IsAuthenticated == true
                && (http.User.IsInRole("Admin") || http.User.IsInRole("Atendimento") || http.User.IsInRole("Garçom"));
            if (!isStaff)
                return Results.Unauthorized();

            if (body.TableId is null or <= 0)
                return Results.BadRequest(new { error = "Mesa é obrigatória para pedido do garçom." });

            var table = await db.StoreTables.AsNoTracking()
                .FirstOrDefaultAsync(t => t.Id == body.TableId && t.StoreId == tenant.StoreId, ct);
            if (table is null || !table.Active)
                return Results.BadRequest(new { error = "Mesa inválida ou inativa." });

            tableId = table.Id;
            tableLabel = table.Label;

            // Usar dados do JWT como fonte de verdade (nunca confiar no body)
            var userIdClaim = http.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
            createdByUserId = int.TryParse(userIdClaim, out var uid) ? uid : null;
            createdByUsername = http.User.Identity?.Name;
            createdByRole = http.User.FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value;
            waiterId = createdByUserId;
            waiterName = http.User.FindFirst("name")?.Value ?? createdByUsername;
        }
        else
        {
            return Results.BadRequest(new { error = "Origem do pedido inválida." });
        }
    }
    else
    {
        // Pedidos de atendimento fora do dine-in (Balcão, Delivery, Telefone):
        // criados via cardápio autenticado com o JWT da equipe → registra a origem
        // informada e identifica quem atendeu (fonte de verdade é o token).
        var atendimento = (body.OrderSource ?? "").Trim().ToLowerInvariant();
        if (!string.IsNullOrEmpty(atendimento))
        {
            var isStaff = http.User.Identity?.IsAuthenticated == true
                && (http.User.IsInRole("Admin") || http.User.IsInRole("Atendimento") || http.User.IsInRole("Garçom"));
            if (!isStaff)
                return Results.Unauthorized();

            orderSource = atendimento;
            var userIdClaim = http.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
            createdByUserId = int.TryParse(userIdClaim, out var uid) ? uid : null;
            createdByUsername = http.User.Identity?.Name;
            createdByRole = http.User.FindFirst(System.Security.Claims.ClaimTypes.Role)?.Value;
            waiterId = createdByUserId;
            waiterName = http.User.FindFirst("name")?.Value ?? createdByUsername;
        }
    }

    var neighborhood = isDineIn
        ? "Mesa"
        : isPickup
            ? "Retirada"
            : (string.IsNullOrWhiteSpace(body.Neighborhood)
                ? OrderMapping.InferNeighborhood(body.Address)
                : body.Neighborhood.Trim());

    var address = isDineIn
        ? (string.IsNullOrWhiteSpace(body.Address) ? "Consumo no local" : body.Address.Trim())
        : isPickup
            ? (string.IsNullOrWhiteSpace(body.Address) ? "Retirada no local" : body.Address.Trim())
            : body.Address.Trim();

    var entity = new OrderEntity
    {
        OrderId = orderId,
        StoreId = tenant.StoreId,
        AccessToken = accessToken,
        CustomerName = isDineIn && string.IsNullOrWhiteSpace(body.CustomerName) ? "Cliente" : body.CustomerName.Trim(),
        CustomerPhone = isDineIn ? (OrderValidation.DigitsOnly(body.CustomerPhone) ?? "") : OrderValidation.DigitsOnly(body.CustomerPhone),
        Address = address,
        Neighborhood = neighborhood,
        Cep = (isPickup || isDineIn) ? null : OrderValidation.DigitsOnly(body.Cep),
        Reference = string.IsNullOrWhiteSpace(body.Reference) ? null : body.Reference.Trim(),
        PaymentMethod = paymentMethod,
        PaymentTiming = paymentTiming,
        PaymentStatus = paymentStatus,
        Notes = string.IsNullOrWhiteSpace(body.Notes) ? null : body.Notes.Trim(),
        NeedsChange = body.NeedsChange == true,
        ChangeFor = body.ChangeFor,
        DeliveryFee = (isPickup || isDineIn) ? 0 : deliveryFee,
        ItemsTotal = itemsTotal,
        ItemsJson = JsonSerializer.Serialize(pricedItems),
        CreatedAtUtc = DateTime.UtcNow,
        // Pedido de equipe (garçom/atendente/balcão/delivery/telefone) já foi validado
        // com o cliente → já nasce confirmado.
        Status = OrderValidation.IsStaffSource(orderSource) ? OrderStatus.Accepted : OrderStatus.Created,
        StatusUpdatedAtUtc = OrderValidation.IsStaffSource(orderSource) ? DateTime.UtcNow : null,
        AcceptedAtUtc = OrderValidation.IsStaffSource(orderSource) ? DateTime.UtcNow : null,
        FulfillmentType = isDineIn ? "dine_in" : isPickup ? "pickup" : "delivery",
        // Dine-in fields
        TableId = tableId,
        TableLabel = tableLabel,
        TableAccessCode = tableAccessCode,
        OrderSource = orderSource,
        CreatedByUserId = createdByUserId,
        CreatedByUsername = createdByUsername,
        CreatedByRole = createdByRole,
        WaiterId = waiterId,
        WaiterName = waiterName,
        DiningSessionId = body.DiningSessionId,
        ClientRequestId = clientRequestId
    };

    db.Orders.Add(entity);
    try
    {
        await db.SaveChangesAsync(ct);
    }
    catch (DbUpdateException ex) when (clientRequestId is not null && IsUniqueViolation(ex))
    {
        // Corrida: outra requisição idêntica criou o pedido primeiro. Devolve o existente.
        var existing = await db.Orders.AsNoTracking()
            .FirstOrDefaultAsync(o => o.StoreId == tenant.StoreId && o.ClientRequestId == clientRequestId, ct);
        if (existing is not null)
        {
            OrderChangeNotifier.Publish("created");
            OrderChangeNotifier.PublishForOrder(existing.OrderId, "created");
            return Results.Ok(OrderMapping.ToResponse(existing, includeAccessToken: true));
        }
        throw;
    }

    // Atualiza o nome do responsável na mesa automaticamente ao criar pedido do garçom.
    if (tableId is > 0 && !string.IsNullOrWhiteSpace(entity.CustomerName))
    {
        var tbl = await db.StoreTables.FirstOrDefaultAsync(t => t.Id == tableId && t.StoreId == tenant.StoreId, ct);
        if (tbl is not null)
        {
            var newName = entity.CustomerName.Trim();
            if (!string.Equals(tbl.ResponsibleName, newName, StringComparison.Ordinal))
            {
                tbl.ResponsibleName = newName;
                await db.SaveChangesAsync(ct);
            }
        }
    }

    var evt = new OrderCreatedEvent(
        entity.OrderId,
        entity.CustomerName,
        entity.CustomerPhone,
        entity.ItemsTotal + entity.DeliveryFee,
        entity.CreatedAtUtc);

    await publisher.PublishOrderCreatedAsync(evt, ct);
    OrderChangeNotifier.Publish("created");
    OrderChangeNotifier.PublishForOrder(orderId, "created");

    return Results.Created(
        $"/api/v1/orders/{entity.OrderId}",
        OrderMapping.ToResponse(entity, includeAccessToken: true));
}).RequireRateLimiting("create-order");

api.MapGet("/orders/stream", async (HttpContext http, CancellationToken ct) =>
{
    await OrderChangeNotifier.StreamAsync(http.Response, ct);
}).RequireAuthorization("OrdersStaff");

api.MapGet("/orders", async (OrdersDbContext db, string? status, int? limit, int? tableId, string? orderSource, string? waiterName, Orders.Api.MultiTenancy.TenantContext tenant, CancellationToken ct) =>
{
    var take = Math.Clamp(limit ?? 100, 1, 300);
    var query = db.Orders.AsNoTracking().Where(o => o.StoreId == tenant.StoreId).AsQueryable();
    if (!string.IsNullOrWhiteSpace(status) && OrderStatus.IsKnown(status))
        query = query.Where(o => o.Status == status);
    if (tableId.HasValue)
        query = query.Where(o => o.TableId == tableId.Value);
    if (!string.IsNullOrWhiteSpace(orderSource))
        query = query.Where(o => o.OrderSource == orderSource);
    if (!string.IsNullOrWhiteSpace(waiterName))
        query = query.Where(o => o.WaiterName != null && o.WaiterName.Contains(waiterName));

    var rows = await query
        .OrderByDescending(o => o.CreatedAtUtc)
        .Take(take)
        .ToListAsync(ct);

    return Results.Ok(rows.Select(o => OrderMapping.ToResponse(o)).ToList());
}).RequireAuthorization("OrdersStaff");

api.MapGet("/orders/dashboard", async (OrdersDbContext db, string? period, int? days, Orders.Api.MultiTenancy.TenantContext tenant, CancellationToken ct) =>
{
    var range = DashboardAnalytics.ResolveRange(period, days);

    var rows = await db.Orders.AsNoTracking()
        .Where(o => o.StoreId == tenant.StoreId && o.CreatedAtUtc >= range.FromUtc && o.CreatedAtUtc <= range.ToUtc)
        .OrderBy(o => o.CreatedAtUtc)
        .ToListAsync(ct);

    return Results.Ok(DashboardAnalytics.Build(rows, range));
}).RequireAuthorization("DevOnly");

// Público: cardápio (storefront) usa para montar a categoria "Mais Vendidos".
// Sem autenticação (anyone), escopado por StoreId (RLS/tenant), com cache curto.
api.MapGet("/orders/top-products", async (
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    IMemoryCache cache,
    int? days,
    CancellationToken ct) =>
{
    var window = Math.Clamp(days ?? 30, 1, 180);
    var storeId = tenant.StoreId;
    var cacheKey = $"top-products:{storeId}:{window}";

    if (cache.TryGetValue(cacheKey, out List<NamedCountDto>? cached) && cached is not null)
        return Results.Ok(new { items = cached });

    var range = DashboardAnalytics.ResolveRange(window.ToString(), null);
    var rows = await db.Orders.AsNoTracking()
        .Where(o => o.StoreId == storeId
            && o.CreatedAtUtc >= range.FromUtc
            && o.CreatedAtUtc <= range.ToUtc)
        .ToListAsync(ct);

    var items = DashboardAnalytics.BuildTopProducts(rows, 10);
    cache.Set(cacheKey, items, TimeSpan.FromSeconds(60));

    return Results.Ok(new { items });
});

api.MapGet("/orders/{orderId}", async (
    string orderId,
    string? accessToken,
    HttpContext http,
    OrdersDbContext db,
    CancellationToken ct) =>
{
    var order = await db.Orders.AsNoTracking().FirstOrDefaultAsync(o => o.OrderId == orderId, ct);
    if (order is null) return Results.NotFound();

    var isStaff = http.User.Identity?.IsAuthenticated == true
        && (http.User.IsInRole("Admin") || http.User.IsInRole("Atendimento") || http.User.IsInRole("Garçom"));

    // Acompanhamento do cliente faz poll frequente — evita resposta stale em proxies/browser.
    http.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
    http.Response.Headers.Pragma = "no-cache";

    if (isStaff)
        return Results.Ok(OrderMapping.ToResponse(order));

    if (string.IsNullOrWhiteSpace(accessToken)
        || string.IsNullOrWhiteSpace(order.AccessToken)
        || !string.Equals(order.AccessToken, accessToken.Trim(), StringComparison.Ordinal))
    {
        return Results.Unauthorized();
    }

    return Results.Ok(OrderMapping.ToResponse(order, includeAccessToken: false));
});

// Rastreio em tempo real do cliente (SSE). Valida pelo accessToken; eventos são
// publicados por OrderChangeNotifier.PublishForOrder quando o pedido muda.
api.MapGet("/orders/{orderId}/stream", async (
    string orderId,
    string? accessToken,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    HttpContext http,
    CancellationToken ct) =>
{
    var order = await db.Orders.AsNoTracking()
        .FirstOrDefaultAsync(o => o.OrderId == orderId && o.StoreId == tenant.StoreId, ct);
    if (order is null)
    {
        http.Response.StatusCode = StatusCodes.Status404NotFound;
        return;
    }

    if (string.IsNullOrWhiteSpace(accessToken)
        || string.IsNullOrWhiteSpace(order.AccessToken)
        || !string.Equals(order.AccessToken, accessToken.Trim(), StringComparison.Ordinal))
    {
        http.Response.StatusCode = StatusCodes.Status401Unauthorized;
        return;
    }

    http.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
    http.Response.Headers.Pragma = "no-cache";

    // Pedido já finalizado/cancelado: informa e fecha (evita conexão pendurada).
    if (OrderStatus.IsTerminal(order.Status))
    {
        http.Response.Headers.ContentType = "text/event-stream";
        await http.Response.WriteAsync($"event: orders\ndata: terminal\n\n", ct);
        await http.Response.Body.FlushAsync(ct);
        return;
    }

    await OrderChangeNotifier.StreamForOrderAsync(http.Response, order.OrderId, ct);
});

api.MapPatch("/orders/{orderId}/status", async (string orderId, UpdateOrderStatusRequest body, OrdersDbContext db, Orders.Api.MultiTenancy.TenantContext tenant, CatalogPricingClient pricing, AutoAdvanceScheduler scheduler, CancellationToken ct) =>
{
    if (string.IsNullOrWhiteSpace(body.Status) || !OrderStatus.IsKnown(body.Status))
        return Results.BadRequest(new { error = "Status inválido." });

    var order = await db.Orders.FirstOrDefaultAsync(o => o.OrderId == orderId && o.StoreId == tenant.StoreId, ct);
    if (order is null) return Results.NotFound();

    var fulfillment = string.IsNullOrWhiteSpace(order.FulfillmentType) ? "delivery" : order.FulfillmentType;
    if (!OrderStatus.CanTransition(order.Status, body.Status, fulfillment))
    {
        var next = OrderStatus.Next(order.Status, fulfillment);
        return Results.Conflict(new
        {
            error = next is null
                ? $"Pedido já está em '{OrderStatus.Label(order.Status)}' e não pode avançar."
                : $"Transição inválida. Próximo status permitido: {OrderStatus.Label(next)} ({next}).",
            current = order.Status,
            next
        });
    }

    if (body.Status == OrderStatus.Delivered
        && !OrderStatus.IsDineIn(fulfillment)
        && !OrderPayment.CanMarkDelivered(order.PaymentStatus, order.PaymentTiming))
    {
        return Results.Conflict(new
        {
            error = OrderPayment.DeliverBlockedReason(order.PaymentStatus)
        });
    }

    if (body.Status == OrderStatus.Cancelled)
    {
        var code = (body.CancellationReasonCode ?? "").Trim();
        if (!OrderCancellation.IsKnownCode(code))
        {
            return Results.BadRequest(new
            {
                error = "Informe um motivo de cancelamento válido.",
                reasons = OrderCancellation.Presets.Select(p => new { p.Code, p.Label, p.CustomerRequested })
            });
        }

        var custom = (body.CancellationReason ?? "").Trim();
        if (string.Equals(code, "other", StringComparison.OrdinalIgnoreCase) && custom.Length < 3)
        {
            return Results.BadRequest(new { error = "Descreva o motivo do cancelamento (mínimo 3 caracteres)." });
        }

        var preset = OrderCancellation.Find(code)!;
        order.CancellationReasonCode = preset.Code;
        order.CancellationReason = OrderCancellation.BuildDisplayReason(code, custom);
        order.CancellationCustomerRequested = body.CustomerRequested ?? preset.CustomerRequested;
    }

    order.Status = body.Status;
    order.StatusUpdatedAtUtc = DateTime.UtcNow;
    if (body.Status == OrderStatus.Accepted && order.AcceptedAtUtc is null)
        order.AcceptedAtUtc = order.StatusUpdatedAtUtc;
    await db.SaveChangesAsync(ct);
    OrderChangeNotifier.Publish(body.Status == OrderStatus.Cancelled ? "cancelled" : "status");
    OrderChangeNotifier.PublishForOrder(order.OrderId, body.Status == OrderStatus.Cancelled ? "cancelled" : "status");

    // Avanço automático "Confirmado → Em preparação": agenda reativamente na confirmação.
    if (body.Status == OrderStatus.Accepted)
    {
        var autoAdvance = await pricing.GetAutoAdvanceConfigAsync(ct);
        if (autoAdvance.Enabled)
            scheduler.ScheduleAfterConfirm(order.OrderId, autoAdvance.Minutes);
    }

    return Results.Ok(OrderMapping.ToResponse(order));
}).RequireAuthorization("OrdersStaff");

// Aplica/agenda o avanço automático aos pedidos já "Confirmado" após ativar/configurar a feature.
api.MapPost("/orders/admin/auto-advance/refresh", async (
    AutoAdvanceScheduler scheduler,
    CancellationToken ct) =>
{
    var result = await scheduler.RefreshAndScheduleAsync(ct);
    return Results.Ok(result);
}).RequireAuthorization("OrdersStaff");

// Atendente altera itens enquanto o pedido aguarda confirmação ou está confirmado
api.MapPatch("/orders/{orderId}/items", async (
    string orderId,
    UpdateOrderItemsRequest body,
    OrdersDbContext db,
    CatalogPricingClient pricing,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var order = await db.Orders.FirstOrDefaultAsync(o => o.OrderId == orderId && o.StoreId == tenant.StoreId, ct);
    if (order is null) return Results.NotFound();

    if (order.Status != OrderStatus.Created && order.Status != OrderStatus.Accepted)
    {
        return Results.Conflict(new
        {
            error = "Só é possível alterar itens enquanto o pedido aguarda confirmação ou está confirmado."
        });
    }

    var items = body.Items ?? [];
    if (items.Count == 0)
        return Results.BadRequest(new { error = "Pedido sem itens." });
    if (items.Count > 50)
        return Results.BadRequest(new { error = "Pedido com itens demais." });

    foreach (var item in items)
    {
        if (string.IsNullOrWhiteSpace(item.Name) || item.Name.Length > 200)
            return Results.BadRequest(new { error = "Item inválido no pedido." });
        if (item.Quantity is < 1 or > 99)
            return Results.BadRequest(new { error = "Quantidade inválida em um dos itens." });
    }

    var (pricedItems, itemsTotal, priceError) = await pricing.PriceItemsAsync(items, ct);
    if (priceError is not null)
        return Results.BadRequest(new { error = priceError });

    var previousItems = OrderMapping.DeserializeItems(order.ItemsJson);
    var previousItemsTotal = order.ItemsTotal;
    order.PreviousItemsTotal = previousItemsTotal;
    order.ItemsJson = JsonSerializer.Serialize(pricedItems);
    order.ItemsTotal = itemsTotal;
    order.ItemsUpdatedAtUtc = DateTime.UtcNow;
    order.ItemsChangeSummary = OrderMapping.BuildItemsChangeSummary(previousItems, pricedItems);
    await db.SaveChangesAsync(ct);
    OrderChangeNotifier.Publish("items");
    OrderChangeNotifier.PublishForOrder(order.OrderId, "items");
    return Results.Ok(OrderMapping.ToResponse(order));
}).RequireAuthorization("OrdersStaff");

api.MapGet("/orders/cancellation-reasons", () =>
    Results.Ok(OrderCancellation.Presets.Select(p => new
    {
        code = p.Code,
        label = p.Label,
        customerRequested = p.CustomerRequested
    }))
).RequireAuthorization("OrdersStaff");

api.MapPatch("/orders/{orderId}/payment", async (string orderId, UpdateOrderPaymentRequest body, OrdersDbContext db, Orders.Api.MultiTenancy.TenantContext tenant, CancellationToken ct) =>
{
    if (!OrderPayment.IsKnownStatus(body.PaymentStatus))
        return Results.BadRequest(new { error = "Status de pagamento inválido. Use pending, confirmed ou on_delivery." });

    var order = await db.Orders.FirstOrDefaultAsync(o => o.OrderId == orderId && o.StoreId == tenant.StoreId, ct);
    if (order is null) return Results.NotFound();

    var status = body.PaymentStatus.Trim().ToLowerInvariant();
    order.PaymentStatus = status;
    if (!string.IsNullOrWhiteSpace(body.PaymentMethod))
        order.PaymentMethod = body.PaymentMethod.Trim();
    if (status == OrderPayment.StatusOnDelivery)
        order.PaymentTiming = OrderPayment.TimingOnDelivery;
    if (status == OrderPayment.StatusConfirmed || status == OrderPayment.StatusPending)
        order.PaymentTiming = OrderPayment.TimingNow;

    if (status == OrderPayment.StatusConfirmed
        && !OrderStatus.IsDineIn(order.FulfillmentType)
        && order.CustomerReceivedAtUtc is not null
        && (order.Status == OrderStatus.ReadyForPickup || order.Status == OrderStatus.OutForDelivery))
    {
        // Cliente já confirmou recebimento/retirada e agora a baixa do pagamento
        // veio → finaliza automaticamente.
        order.Status = OrderStatus.Delivered;
        order.StatusUpdatedAtUtc = DateTime.UtcNow;
    }

    await db.SaveChangesAsync(ct);
    OrderChangeNotifier.Publish("payment");
    OrderChangeNotifier.Publish("status");
    OrderChangeNotifier.PublishForOrder(order.OrderId, "payment");
    OrderChangeNotifier.PublishForOrder(order.OrderId, "status");
    return Results.Ok(OrderMapping.ToResponse(order));
}).RequireAuthorization("OrdersStaff");

// Cliente confirma recebimento (accessToken) — finaliza (Delivered) quando o
// pagamento já tem baixa (delivery/pickup) ou direto no dine-in; se o pagamento
// ainda não foi confirmado, registra o recebimento e a baixa finaliza depois
api.MapPost("/orders/{orderId}/confirm-received", async (
    string orderId,
    string? accessToken,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var order = await db.Orders.FirstOrDefaultAsync(o => o.OrderId == orderId && o.StoreId == tenant.StoreId, ct);
    if (order is null) return Results.NotFound();

    if (string.IsNullOrWhiteSpace(accessToken)
        || string.IsNullOrWhiteSpace(order.AccessToken)
        || !string.Equals(order.AccessToken, accessToken.Trim(), StringComparison.Ordinal))
    {
        return Results.Unauthorized();
    }

    if (order.CustomerReceivedAtUtc is not null || order.Status == OrderStatus.Delivered)
        return Results.Ok(OrderMapping.ToResponse(order));

    var isPickup = OrderStatus.IsPickup(order.FulfillmentType);
    var isDineInConfirm = OrderStatus.IsDineIn(order.FulfillmentType);
    var canConfirm = isDineInConfirm
        ? order.Status == OrderStatus.ReadyForTable
        : isPickup
            ? order.Status == OrderStatus.ReadyForPickup
            : order.Status == OrderStatus.OutForDelivery;
    if (!canConfirm)
    {
        return Results.Conflict(new
        {
            error = isDineInConfirm
                ? "Aguarde o pedido ficar pronto para a mesa antes de confirmar."
                : isPickup
                    ? "Aguarde o pedido ficar disponível para retirada antes de confirmar."
                    : "Aguarde o pedido sair para entrega antes de confirmar o recebimento.",
            current = order.Status
        });
    }

    order.CustomerReceivedAtUtc = DateTime.UtcNow;
    // Dine-in finaliza direto (pagamento se resolve no fechamento da mesa).
    // Delivery/pickup só finalizam se o pagamento já recebeu baixa; senão a
    // confirmação do pagamento (PATCH /orders/{id}/payment) finaliza depois.
    if (isDineInConfirm || OrderPayment.CanMarkDelivered(order.PaymentStatus, order.PaymentTiming))
    {
        order.Status = OrderStatus.Delivered;
        order.StatusUpdatedAtUtc = order.CustomerReceivedAtUtc.Value;
    }
    await db.SaveChangesAsync(ct);
    OrderChangeNotifier.Publish("status");
    OrderChangeNotifier.PublishForOrder(order.OrderId, "status");
    OrderChangeNotifier.Publish("customer-received");
    OrderChangeNotifier.PublishForOrder(order.OrderId, "customer-received");
    return Results.Ok(OrderMapping.ToResponse(order));
});

// ── Store Tables (Dine-in) ──

// Resolução pública de QR Code: cliente escaneia e descobre a mesa
api.MapGet("/tables/resolve/{accessCode}", async (
    string accessCode,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var table = await db.StoreTables.AsNoTracking()
        .FirstOrDefaultAsync(t => t.AccessCode == accessCode && t.StoreId == tenant.StoreId, ct);
    if (table is null)
        return Results.NotFound(new { error = "Mesa não encontrada." });

    return Results.Ok(new ResolveTableResponse(
        table.Id,
        table.Label,
        table.StoreId,
        table.Active,
        table.AllowCustomerOrder));
});

// Lista de mesas para o admin/garçom (com contagem de pedidos abertos)
api.MapGet("/admin/tables", async (
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var tables = await db.StoreTables.AsNoTracking()
        .Where(t => t.StoreId == tenant.StoreId)
        .OrderBy(t => t.Label)
        .ToListAsync(ct);

    var tableIds = tables.Select(t => t.Id).ToList();
    var sessionOrders = await db.Orders.AsNoTracking()
        .Where(o => o.StoreId == tenant.StoreId
            && o.TableId.HasValue
            && tableIds.Contains(o.TableId.Value)
            && o.Status != OrderStatus.Cancelled)
        .Select(o => new { o.TableId, o.CreatedAtUtc, o.Status, o.ItemsTotal, o.DeliveryFee })
        .ToListAsync(ct);

    var byTable = sessionOrders.ToLookup(o => o.TableId!.Value);

    var result = tables.Select(t =>
    {
        var session = byTable[t.Id].ToList();
        var start = t.ClosedAtUtc;
        // Sessão atual: tudo desde o último fechamento (ou toda a vida da mesa).
        var current = start is null ? session : session.Where(o => o.CreatedAtUtc >= start.Value).ToList();
        var open = current.Where(o => o.Status != OrderStatus.Delivered).ToList();
        var latestStatus = open.OrderByDescending(x => x.CreatedAtUtc).Select(x => x.Status).FirstOrDefault();
        return new StoreTableDto(
            t.Id,
            t.Label,
            null, // AccessCode não exposto na listagem
            t.Active,
            t.AllowCustomerOrder,
            t.Capacity,
            t.CreatedAtUtc,
            current.Where(o => o.Status != OrderStatus.Delivered).Count(),
            open.Sum(o => o.ItemsTotal + o.DeliveryFee),
            latestStatus is null ? null : latestStatus,
            latestStatus is null ? null : OrderStatus.Label(latestStatus),
            current.Count,
            current.Sum(o => o.ItemsTotal + o.DeliveryFee),
            t.ResponsibleName,
            t.GuestCount);
    }).ToList();

    return Results.Ok(result);
}).RequireAuthorization("OrdersStaff");

// Criar mesa (Admin apenas)
api.MapPost("/admin/tables", async (
    CreateStoreTableRequest body,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var label = (body.Label ?? "").Trim();
    if (string.IsNullOrWhiteSpace(label) || label.Length > 100)
        return Results.BadRequest(new { error = "Label da mesa é obrigatório (máx. 100 caracteres)." });

    var accessCode = Guid.NewGuid().ToString("N")[..16];

    var table = new StoreTable
    {
        StoreId = tenant.StoreId,
        Label = label,
        AccessCode = accessCode,
        Active = true,
        AllowCustomerOrder = body.AllowCustomerOrder ?? true,
        Capacity = body.Capacity,
        CreatedAtUtc = DateTime.UtcNow
    };

    db.StoreTables.Add(table);
    await db.SaveChangesAsync(ct);

    return Results.Created($"/api/v1/admin/tables/{table.Id}", new StoreTableDto(
        table.Id, table.Label, table.AccessCode, table.Active,
        table.AllowCustomerOrder, table.Capacity, table.CreatedAtUtc));
}).RequireAuthorization("DevOnly");

// Atualizar mesa (Admin apenas)
api.MapPut("/admin/tables/{id:int}", async (
    int id,
    UpdateStoreTableRequest body,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var table = await db.StoreTables.FirstOrDefaultAsync(t => t.Id == id && t.StoreId == tenant.StoreId, ct);
    if (table is null) return Results.NotFound();

    if (!string.IsNullOrWhiteSpace(body.Label))
        table.Label = body.Label.Trim();
    if (body.AllowCustomerOrder.HasValue)
        table.AllowCustomerOrder = body.AllowCustomerOrder.Value;
    if (body.Capacity.HasValue)
        table.Capacity = body.Capacity;
    if (body.ResponsibleName is not null)
        table.ResponsibleName = string.IsNullOrWhiteSpace(body.ResponsibleName)
            ? null : body.ResponsibleName.Trim();
    if (body.GuestCount is not null)
        table.GuestCount = body.GuestCount is > 0 ? body.GuestCount : null;

    await db.SaveChangesAsync(ct);

    return Results.Ok(new StoreTableDto(
        table.Id, table.Label, null, table.Active,
        table.AllowCustomerOrder, table.Capacity, table.CreatedAtUtc,
        ResponsibleName: table.ResponsibleName,
        GuestCount: table.GuestCount));
}).RequireAuthorization("DevOnly");

// Autenticando acesso do painel, inclui o AccessCode da mesa (para reimpressão
// de QR após recarregar a página). Listagem não expõe o código por segurança.
api.MapGet("/admin/tables/{id:int}", async (
    int id,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var table = await db.StoreTables.AsNoTracking()
        .FirstOrDefaultAsync(t => t.Id == id && t.StoreId == tenant.StoreId, ct);
    if (table is null) return Results.NotFound();
    return Results.Ok(new StoreTableDto(
        table.Id, table.Label, table.AccessCode, table.Active,
        table.AllowCustomerOrder, table.Capacity, table.CreatedAtUtc,
        ResponsibleName: table.ResponsibleName,
        GuestCount: table.GuestCount));
}).RequireAuthorization("DevOnly");

// Alternar ativo/inativo da mesa (Admin apenas)
api.MapPatch("/admin/tables/{id:int}/active", async (
    int id,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var table = await db.StoreTables.FirstOrDefaultAsync(t => t.Id == id && t.StoreId == tenant.StoreId, ct);
    if (table is null) return Results.NotFound();

    var hasOpenOrders = await db.Orders.AnyAsync(o =>
        o.StoreId == tenant.StoreId
        && o.TableId == id
        && o.Status != OrderStatus.Delivered
        && o.Status != OrderStatus.Cancelled, ct);
    if (hasOpenOrders)
        return Results.Conflict(new { error = "Não é possível alterar status de mesa com pedidos abertos." });

    table.Active = !table.Active;
    await db.SaveChangesAsync(ct);

    return Results.Ok(new { table.Id, table.Active });
}).RequireAuthorization("DevOnly");

// Atualizar informações da mesa pelo garçom (responsável + pessoas)
api.MapPatch("/admin/tables/{id:int}/info", async (
    int id,
    UpdateTableInfoRequest body,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var table = await db.StoreTables.FirstOrDefaultAsync(t => t.Id == id && t.StoreId == tenant.StoreId, ct);
    if (table is null) return Results.NotFound();

    table.ResponsibleName = string.IsNullOrWhiteSpace(body.ResponsibleName)
        ? null
        : body.ResponsibleName.Trim();
    table.GuestCount = body.GuestCount is > 0 ? body.GuestCount : null;

    await db.SaveChangesAsync(ct);

    return Results.Ok(new StoreTableDto(
        table.Id, table.Label, null, table.Active,
        table.AllowCustomerOrder, table.Capacity, table.CreatedAtUtc,
        ResponsibleName: table.ResponsibleName,
        GuestCount: table.GuestCount));
}).RequireAuthorization("OrdersStaff");

// Listar pedidos abertos de uma mesa específica
api.MapGet("/orders/table/{tableId:int}", async (
    int tableId,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var table = await db.StoreTables.AsNoTracking()
        .FirstOrDefaultAsync(t => t.Id == tableId && t.StoreId == tenant.StoreId, ct);
    if (table is null) return Results.NotFound();

    // Comandas da sessão atual: desde o último fechamento (ou toda a vida da mesa),
    // excluindo canceladas. Comandas pagas ficam visíveis até o fechamento oficial.
    var sessionStart = table.ClosedAtUtc;
    var orders = await db.Orders.AsNoTracking()
        .Where(o => o.StoreId == tenant.StoreId
            && o.TableId == tableId
            && o.Status != OrderStatus.Cancelled
            && (sessionStart == null || o.CreatedAtUtc >= sessionStart.Value))
        .OrderBy(o => o.CreatedAtUtc)
        .ToListAsync(ct);

    return Results.Ok(orders.Select(o => OrderMapping.ToResponse(o)).ToList());
}).RequireAuthorization("OrdersStaff");

// Fechar mesa: confirma o pagamento e finaliza todas as comandas abertas da mesa.
// Ação de caixa/garçom — o PIN é exigido na interface (catalog-api), o servidor
// confia no JWT OrdersStaff. Libera a mesa (torna "Livre") ao finalizar tudo.
api.MapPost("/admin/tables/{id:int}/close", async (
    int id,
    CloseTableRequest body,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var table = await db.StoreTables.FirstOrDefaultAsync(t => t.Id == id && t.StoreId == tenant.StoreId, ct);
    if (table is null) return Results.NotFound();

    var sessionStart = table.ClosedAtUtc;
    var openOrders = await db.Orders
        .Where(o => o.StoreId == tenant.StoreId
            && o.TableId == id
            && o.Status != OrderStatus.Cancelled
            && (sessionStart == null || o.CreatedAtUtc >= sessionStart.Value))
        .ToListAsync(ct);

    if (openOrders.Count == 0)
        return Results.Conflict(new { error = "Não há comandas abertas nesta mesa." });

    var now = DateTime.UtcNow;
    var method = (body.PaymentMethod ?? "").Trim();
    foreach (var order in openOrders)
    {
        // Comanda já encerrada (entregue + paga) preserva método/datas do pagamento.
        var alreadySettled = order.Status == OrderStatus.Delivered
            && string.Equals(order.PaymentStatus, OrderPayment.StatusConfirmed, StringComparison.OrdinalIgnoreCase);
        if (alreadySettled) continue;
        if (!string.IsNullOrWhiteSpace(method))
            order.PaymentMethod = method;
        if (!string.Equals(order.PaymentStatus, OrderPayment.StatusConfirmed, StringComparison.OrdinalIgnoreCase))
        {
            order.PaymentStatus = OrderPayment.StatusConfirmed;
            order.PaymentTiming = OrderPayment.TimingNow;
        }
        order.Status = OrderStatus.Delivered;
        order.StatusUpdatedAtUtc = now;
        order.AcceptedAtUtc ??= now;
    }

    // Encerra a sessão da mesa (Livre no grid; nova sessão começa no próximo pedido).
    table.ClosedAtUtc = now;
    table.ResponsibleName = null;
    table.GuestCount = null;

    await db.SaveChangesAsync(ct);

    OrderChangeNotifier.Publish("status");
    OrderChangeNotifier.Publish("payment");
    foreach (var order in openOrders)
    {
        OrderChangeNotifier.PublishForOrder(order.OrderId, "status");
        OrderChangeNotifier.PublishForOrder(order.OrderId, "payment");
    }

    var total = openOrders.Sum(o => o.ItemsTotal + o.DeliveryFee);
    return Results.Ok(new CloseTableResponse(
        table.Id,
        openOrders.Count,
        total,
        openOrders.Select(o => o.OrderId).ToList()));
}).RequireAuthorization("OrdersStaff");

// Deletar mesa (Admin apenas)
api.MapDelete("/admin/tables/{id:int}", async (
    int id,
    OrdersDbContext db,
    Orders.Api.MultiTenancy.TenantContext tenant,
    CancellationToken ct) =>
{
    var table = await db.StoreTables.FirstOrDefaultAsync(t => t.Id == id && t.StoreId == tenant.StoreId, ct);
    if (table is null) return Results.NotFound();

    // Verificar se há pedidos abertos nesta mesa
    var hasOpenOrders = await db.Orders.AnyAsync(o =>
        o.StoreId == tenant.StoreId
        && o.TableId == id
        && o.Status != OrderStatus.Delivered
        && o.Status != OrderStatus.Cancelled, ct);
    if (hasOpenOrders)
        return Results.Conflict(new { error = "Não é possível excluir mesa com pedidos abertos." });

    db.StoreTables.Remove(table);
    await db.SaveChangesAsync(ct);

    return Results.NoContent();
}).RequireAuthorization("DevOnly");

app.Run();

static async Task EnsureSchemaAsync(OrdersDbContext db)
{
    // EnsureCreated não cria tabelas se o banco já tiver outras (ex.: mesmo Postgres do catalog).
    await TryAlterAsync(db, """
        CREATE TABLE IF NOT EXISTS orders (
            "Id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            "OrderId" character varying(64) NOT NULL,
            "CustomerName" character varying(120) NOT NULL,
            "CustomerPhone" character varying(32) NOT NULL,
            "Address" character varying(400) NOT NULL,
            "Neighborhood" character varying(120) NULL,
            "Cep" character varying(16) NULL,
            "Reference" text NULL,
            "PaymentMethod" character varying(64) NOT NULL,
            "PaymentTiming" character varying(24) NOT NULL DEFAULT 'on_delivery',
            "PaymentStatus" character varying(24) NOT NULL DEFAULT 'on_delivery',
            "Notes" text NULL,
            "DeliveryFee" numeric(10,2) NOT NULL,
            "ItemsTotal" numeric(10,2) NOT NULL,
            "ItemsJson" text NOT NULL,
            "Status" character varying(32) NOT NULL,
            "CreatedAtUtc" timestamp with time zone NOT NULL,
            "StatusUpdatedAtUtc" timestamp with time zone NULL,
            "AcceptedAtUtc" timestamp with time zone NULL,
            "AccessToken" character varying(64) NULL,
            "NeedsChange" boolean NOT NULL DEFAULT FALSE,
            "ChangeFor" numeric(10,2) NULL
        )
        """);
    await TryAlterAsync(db, """CREATE UNIQUE INDEX IF NOT EXISTS "IX_orders_OrderId" ON orders ("OrderId")""");
    await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_orders_AccessToken" ON orders ("AccessToken")""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "Neighborhood" character varying(120) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "Cep" character varying(16) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "StatusUpdatedAtUtc" timestamp with time zone NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "PaymentTiming" character varying(24) NOT NULL DEFAULT 'on_delivery'""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "PaymentStatus" character varying(24) NOT NULL DEFAULT 'on_delivery'""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "AccessToken" character varying(64) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "CustomerReceivedAtUtc" timestamp with time zone NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "AcceptedAtUtc" timestamp with time zone NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "CancellationReasonCode" character varying(64) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "CancellationReason" character varying(400) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "CancellationCustomerRequested" boolean NOT NULL DEFAULT FALSE""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "FulfillmentType" character varying(16) NOT NULL DEFAULT 'delivery'""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "ItemsUpdatedAtUtc" timestamp with time zone NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "ItemsChangeSummary" character varying(1000) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "PreviousItemsTotal" numeric(10,2) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "NeedsChange" boolean NOT NULL DEFAULT FALSE""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "ChangeFor" numeric(10,2) NULL""");
    // ── Multi-tenancy: StoreId ──
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "StoreId" integer NOT NULL DEFAULT 1""");
    await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_orders_StoreId" ON orders ("StoreId")""");

    // ── Multi-tenancy: Row-Level Security (segunda camada) ──
    await TryAlterAsync(db, """ALTER TABLE orders ENABLE ROW LEVEL SECURITY""");
    await TryAlterAsync(db, """ALTER TABLE orders FORCE ROW LEVEL SECURITY""");
    await TryAlterAsync(db, """DROP POLICY IF EXISTS p_orders_tenant ON orders""");
    await TryAlterAsync(db, """
        CREATE POLICY p_orders_tenant ON orders
        FOR ALL
        USING ("StoreId" = current_setting('app.current_store_id', true)::int)
        WITH CHECK ("StoreId" = current_setting('app.current_store_id', true)::int)
        """);

    // ── Dine-in: colunas novas na tabela orders (todas nullable, compat retroativa) ──
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "TableId" integer NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "TableLabel" character varying(100) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "TableAccessCode" character varying(64) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "OrderSource" character varying(32) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "CreatedByUserId" integer NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "CreatedByUsername" character varying(64) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "CreatedByRole" character varying(32) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "WaiterId" integer NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "WaiterName" character varying(120) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "DiningSessionId" character varying(64) NULL""");
    await TryAlterAsync(db, """ALTER TABLE orders ADD COLUMN IF NOT EXISTS "ClientRequestId" character varying(72) NULL""");
    await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_orders_TableId" ON orders ("TableId")""");
    await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_orders_OrderSource" ON orders ("OrderSource")""");
    // Idempotência: um (StoreId, ClientRequestId) cria no máximo um pedido.
    // Índice parcial — NULL (pedidos sem chave) não interfere.
    await TryAlterAsync(db, """CREATE UNIQUE INDEX IF NOT EXISTS "IX_orders_StoreId_ClientRequestId" ON orders ("StoreId", "ClientRequestId") WHERE "ClientRequestId" IS NOT NULL""");

    // ── Dine-in: tabela store_tables ──
    await TryAlterAsync(db, """
        CREATE TABLE IF NOT EXISTS store_tables (
            "Id" integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            "StoreId" integer NOT NULL DEFAULT 1,
            "Label" character varying(100) NOT NULL,
            "AccessCode" character varying(64) NOT NULL,
            "Active" boolean NOT NULL DEFAULT TRUE,
            "AllowCustomerOrder" boolean NOT NULL DEFAULT TRUE,
            "Capacity" integer NULL,
            "CreatedAtUtc" timestamp with time zone NOT NULL DEFAULT (now() at time zone 'utc'),
            "ClosedAtUtc" timestamp with time zone NULL
        )
        """);
    await TryAlterAsync(db, """CREATE UNIQUE INDEX IF NOT EXISTS "IX_store_tables_StoreId_AccessCode" ON store_tables ("StoreId", "AccessCode")""");
    await TryAlterAsync(db, """CREATE INDEX IF NOT EXISTS "IX_store_tables_StoreId" ON store_tables ("StoreId")""");
    await TryAlterAsync(db, """ALTER TABLE store_tables ADD COLUMN IF NOT EXISTS "ClosedAtUtc" timestamp with time zone NULL""");
    await TryAlterAsync(db, """ALTER TABLE store_tables ADD COLUMN IF NOT EXISTS "ResponsibleName" character varying(120) NULL""");
    await TryAlterAsync(db, """ALTER TABLE store_tables ADD COLUMN IF NOT EXISTS "GuestCount" integer NULL""");
    await TryAlterAsync(db, """ALTER TABLE store_tables ENABLE ROW LEVEL SECURITY""");
    await TryAlterAsync(db, """ALTER TABLE store_tables FORCE ROW LEVEL SECURITY""");
    await TryAlterAsync(db, """DROP POLICY IF EXISTS p_store_tables_tenant ON store_tables""");
    await TryAlterAsync(db, """
        CREATE POLICY p_store_tables_tenant ON store_tables
        FOR ALL
        USING ("StoreId" = current_setting('app.current_store_id', true)::int)
        WITH CHECK ("StoreId" = current_setting('app.current_store_id', true)::int)
        """);
}

static async Task TryAlterAsync(OrdersDbContext db, string sql)
{
    try
    {
        await db.Database.ExecuteSqlRawAsync(sql);
    }
    catch (Exception ex)
    {
        Log.Debug(ex, "Schema alter skipped: {Sql}", sql);
    }
}

// True quando o EF falhou por violação de índice único no Postgres (código 23505).
// Usado pela idempotência de criação de pedido (corrida entre POST /orders iguais).
static bool IsUniqueViolation(DbUpdateException ex)
{
    for (Exception? inner = ex.InnerException; inner is not null; inner = inner.InnerException)
    {
        if (inner is Npgsql.PostgresException { SqlState: "23505" }) return true;
        if (inner.GetType().FullName?.Contains("SqlException") == true) return true;
    }
    return false;
}

public partial class Program;
