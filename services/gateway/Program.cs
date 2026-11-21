using Gateway;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;
using Serilog;

var builder = WebApplication.CreateBuilder(args);

Log.Logger = new LoggerConfiguration()
    .Enrich.FromLogContext()
    .Enrich.WithProperty("service", "gateway")
    .WriteTo.Console()
    .CreateLogger();
builder.Host.UseSerilog();

var corsOrigins = builder.Configuration.GetSection("Cors:Origins").Get<string[]>()
    ?? [
        "http://localhost:8080",
        "http://127.0.0.1:8080",
        "http://localhost:8081",
        "http://127.0.0.1:8081"
    ];

builder.Services.AddCors(o => o.AddPolicy("Frontend", p =>
    p.SetIsOriginAllowed(origin => Delivery.Shared.CorsLan.IsOriginAllowed(origin, corsOrigins))
        .AllowAnyHeader()
        .AllowAnyMethod()));

builder.Services.AddReverseProxy()
    .LoadFromConfig(builder.Configuration.GetSection("ReverseProxy"));

var catalogBase = builder.Configuration["CatalogApi:BaseUrl"]
    ?? Environment.GetEnvironmentVariable("CatalogApi__BaseUrl")
    ?? "http://localhost:5101";
builder.Services.AddHttpClient("catalog-analytics", client =>
{
    client.BaseAddress = new Uri(catalogBase.TrimEnd('/') + "/");
    client.Timeout = TimeSpan.FromSeconds(3);
});
builder.Services.AddSingleton<TrafficHitForwarder>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<TrafficHitForwarder>());

if (!string.IsNullOrWhiteSpace(builder.Configuration["OTEL_EXPORTER_OTLP_ENDPOINT"])
    || !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT")))
{
    builder.Services.AddOpenTelemetry()
        .ConfigureResource(r => r.AddService("gateway"))
        .WithTracing(t => t
            .AddAspNetCoreInstrumentation()
            .AddHttpClientInstrumentation()
            .AddOtlpExporter());
}

var app = builder.Build();

app.UseSerilogRequestLogging();
app.Use(async (ctx, next) =>
{
    const string header = "X-Correlation-Id";
    if (!ctx.Request.Headers.TryGetValue(header, out var cid) || string.IsNullOrWhiteSpace(cid))
    {
        cid = Guid.NewGuid().ToString("N");
        ctx.Request.Headers[header] = cid;
    }
    ctx.Response.Headers[header] = cid!;
    await next();
});

app.UseCors("Frontend");

app.Use(async (ctx, next) =>
{
    await next();
    try
    {
        var path = ctx.Request.Path.Value;
        if (path is not null && path.StartsWith("/api/v1", StringComparison.OrdinalIgnoreCase))
        {
            var forwarder = ctx.RequestServices.GetService<TrafficHitForwarder>();
            forwarder?.Enqueue(path);
        }
    }
    catch
    {
        /* never break the response */
    }
});

app.MapGet("/api/v1/health", () => Results.Ok(new
{
    status = "healthy",
    service = "gateway",
    utc = DateTime.UtcNow
}));

app.MapReverseProxy();

app.Run();
