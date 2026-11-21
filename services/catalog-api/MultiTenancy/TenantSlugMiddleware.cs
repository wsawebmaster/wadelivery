using System.Security.Claims;
using Catalog.Api.Services;

namespace Catalog.Api.MultiTenancy;

public sealed class TenantSlugMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, TenantResolverService resolver)
    {
        var slug = context.Request.Headers["X-Tenant-Slug"].FirstOrDefault()
            ?? context.Request.Query["tenant"].FirstOrDefault()
            ?? context.Request.Query["slug"].FirstOrDefault();

        if (string.IsNullOrWhiteSpace(slug))
        {
            await next(context);
            return;
        }

        var tenant = await resolver.ResolveAsync(slug, context.RequestAborted);
        if (tenant is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            await context.Response.WriteAsJsonAsync(new { error = "Loja não encontrada para este slug." });
            return;
        }

        var claim = context.User.FindFirst("store_id")?.Value;
        if (int.TryParse(claim, out var authenticatedStoreId) && authenticatedStoreId != tenant.StoreId)
        {
            context.Response.StatusCode = StatusCodes.Status403Forbidden;
            await context.Response.WriteAsJsonAsync(new { error = "O slug não corresponde à loja autenticada." });
            return;
        }

        context.Items[TenantContext.ResolvedTenantItemKey] = tenant.StoreId;
        await next(context);
    }
}
