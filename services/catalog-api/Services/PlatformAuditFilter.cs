using Catalog.Api.Models;
using Catalog.Api.Repositories;
using Microsoft.AspNetCore.Http.HttpResults;

namespace Catalog.Api.Services;

/// <summary>
/// Filtro do grupo /admin/platform-stores: depois de cada alteração bem-sucedida grava a ação
/// na auditoria (quem, o quê, em qual loja). Leituras e rotinas manuais (billing/run, cleanup/run,
/// que auditam cada loja afetada) ficam de fora. Senhas nunca entram nos detalhes.
/// </summary>
public static class PlatformAuditFilter
{
    public static async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext ctx, EndpointFilterDelegate next)
    {
        var http = ctx.HttpContext;
        var method = http.Request.Method;
        if (HttpMethods.IsGet(method) || HttpMethods.IsHead(method) || HttpMethods.IsOptions(method))
            return await next(ctx);

        var pattern = (http.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "";
        var route = pattern[(pattern.IndexOf("/platform-stores", StringComparison.Ordinal) + "/platform-stores".Length)..];
        Guid? id = http.Request.RouteValues.TryGetValue("id", out var raw) && Guid.TryParse(raw?.ToString(), out var g) ? g : null;

        // Exclusão: guarda o nome antes (depois o registro não existe mais).
        PlatformStoreDto? before = null;
        if (HttpMethods.IsDelete(method) && route == "/{id:guid}" && id is not null)
            before = await http.RequestServices.GetRequiredService<IPlatformStoreRepository>().GetAsync(id.Value, http.RequestAborted);

        var startedAt = DateTime.UtcNow;
        var result = await next(ctx);

        var status = result is IStatusCodeHttpResult sc ? sc.StatusCode ?? 200 : http.Response.StatusCode;
        if (status is < 200 or >= 300) return result;

        // Alteração bem-sucedida: a visão consolidada (dashboard/lista) é recalculada.
        http.RequestServices.GetService<PlatformOverviewService>()?.Invalidate();

        var value = (result as IValueHttpResult)?.Value;
        var store = value as PlatformStoreDto ?? value?.GetType().GetProperty("store")?.GetValue(value) as PlatformStoreDto;
        id ??= store?.Id;

        var (action, details) = Describe(method, route, ctx.Arguments, http, value, before);
        if (action is null) return result;

        var audit = http.RequestServices.GetRequiredService<PlatformAuditService>();
        await audit.LogAsync(PlatformAuditService.ActorOf(http.User), action, id, store?.StoreId ?? before?.StoreId, details, http.RequestAborted, startedAt);
        return result;
    }

    private static T? Arg<T>(IList<object?> args) where T : class => args.OfType<T>().FirstOrDefault();

    private static (string? Action, object? Details) Describe(
        string method, string route, IList<object?> args, HttpContext http, object? value, PlatformStoreDto? before)
    {
        var userId = http.Request.RouteValues.TryGetValue("userId", out var u) ? u?.ToString() : null;
        return (method.ToUpperInvariant(), route) switch
        {
            ("POST", "" or "/") => ("store.create", new { name = Arg<UpsertPlatformStoreRequest>(args)?.Name }),
            ("PUT", "/{id:guid}") => ("store.update", new { name = Arg<UpsertPlatformStoreRequest>(args)?.Name }),
            ("DELETE", "/{id:guid}") => ("store.delete", new { name = before?.Name }),
            ("POST", "/{id:guid}/duplicate") => ("store.duplicate", new { copyId = (value as PlatformStoreDto)?.Id }),
            ("POST", "/{id:guid}/payments") => ("payment.register", Arg<RegisterPlatformPaymentRequest>(args) is { } p
                ? new { amount = p.Amount, paidAt = p.PaidAt, note = p.Note, nextDueAt = p.NextDueAt } : null),
            ("PATCH", "/{id:guid}/billing") => ("billing.update", Arg<UpdatePlatformBillingRequest>(args) is { } b
                ? new { monthlyFee = b.MonthlyFee, courtesy = b.Courtesy, courtesyUntil = b.CourtesyUntil, nextDueAt = b.NextDueAt } : null),
            ("POST", "/{id:guid}/block") => (Arg<SetPlatformStoreBlockedRequest>(args)?.Blocked == true ? "store.block" : "store.unblock", null),
            ("PATCH", "/{id:guid}/segment") => ("segment.change", new
            {
                segment = Arg<SetPlatformSegmentRequest>(args)?.Segment,
                applied = value?.GetType().GetProperty("applied")?.GetValue(value),
            }),
            ("POST", "/{id:guid}/logo") => ("logo.update", null),
            ("POST", "/{id:guid}/gallery") => ("gallery.add", null),
            ("DELETE", "/{id:guid}/gallery/{imageId}") => ("gallery.remove", null),
            ("POST", "/{id:guid}/users") => ("user.create", Arg<CreateStoreUserRequest>(args) is { } c
                ? new { username = c.Username, role = c.Role } : null), // sem senha
            ("POST", "/{id:guid}/users/{userId:int}/reset-password") => ("user.reset-password", new { userId }), // sem senha
            ("DELETE", "/{id:guid}/users/{userId:int}") => ("user.delete", new { userId }),
            _ => (null, null), // leituras, /audit (grava sozinho), billing/run e cleanup/run
        };
    }
}
