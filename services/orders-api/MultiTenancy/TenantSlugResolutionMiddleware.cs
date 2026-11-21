using System.Security.Claims;
using Microsoft.Extensions.Caching.Memory;
using Npgsql;

namespace Orders.Api.MultiTenancy;

public sealed class TenantSlugResolutionMiddleware(RequestDelegate next, IConfiguration configuration)
{
    public async Task InvokeAsync(HttpContext context, IMemoryCache cache)
    {
        var slug = context.Request.Headers["X-Tenant-Slug"].FirstOrDefault()
            ?? context.Request.Query["tenant"].FirstOrDefault()
            ?? context.Request.Query["slug"].FirstOrDefault();

        if (string.IsNullOrWhiteSpace(slug))
        {
            await next(context);
            return;
        }

        var normalized = slug.Trim().ToLowerInvariant();
        var cacheKey = $"tenant:slug-id:{normalized}";

        if (!cache.TryGetValue(cacheKey, out int storeId))
        {
            var connectionString = configuration.GetConnectionString("Postgres")
                ?? configuration.GetConnectionString("Default")
                ?? throw new InvalidOperationException("ConnectionStrings:Postgres não está configurada.");

            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync(context.RequestAborted);
            await using var transaction = await connection.BeginTransactionAsync(context.RequestAborted);
            await using (var setup = new NpgsqlCommand("SET LOCAL row_security = off", connection, transaction))
                await setup.ExecuteNonQueryAsync(context.RequestAborted);

            await using var command = new NpgsqlCommand(
                """SELECT "Id" FROM stores WHERE lower("Slug") = lower(@slug) LIMIT 1""",
                connection,
                transaction);
            command.Parameters.AddWithValue("slug", normalized);
            var result = await command.ExecuteScalarAsync(context.RequestAborted);
            await transaction.CommitAsync(context.RequestAborted);

            if (result is null)
            {
                // Cache negative lookup for 30s to mitigate DoS
                cache.Set(cacheKey, -1, TimeSpan.FromSeconds(30));
                context.Response.StatusCode = StatusCodes.Status404NotFound;
                await context.Response.WriteAsJsonAsync(new { error = "Loja não encontrada para este slug." });
                return;
            }

            storeId = Convert.ToInt32(result);
            cache.Set(cacheKey, storeId, TimeSpan.FromMinutes(5));
        }

        if (storeId <= 0)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await context.Response.WriteAsJsonAsync(new { error = "Loja não encontrada para este slug." });
            return;
        }

        var claim = context.User.FindFirst("store_id")?.Value;
        if (int.TryParse(claim, out var authenticatedStoreId) && authenticatedStoreId != storeId)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new { error = "O slug não corresponde à loja autenticada." });
            return;
        }

        context.Items[TenantContext.ResolvedTenantItemKey] = storeId;
        await next(context);
    }
}
