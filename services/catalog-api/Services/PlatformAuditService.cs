using System.Security.Claims;
using System.Text.Json;
using Catalog.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Services;

public sealed record PlatformAuditDto(
    long Id,
    DateTime At,
    string Actor,
    string Action,
    Guid? PlatformStoreId,
    int? StoreId,
    string? StoreName,
    JsonElement? Details);

/// <summary>
/// Histórico de ações da plataforma sobre as lojas (cobrança, bloqueio, segmento, usuários...).
/// Grava num escopo próprio para nunca interferir na transação da ação auditada; falha ao
/// registrar não quebra a ação (só vai para o log). Sem PostgreSQL (modo JSON) não grava.
/// </summary>
public sealed class PlatformAuditService(IServiceScopeFactory scopes, ILogger<PlatformAuditService> logger)
{
    public const string SystemActor = "sistema";

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);

    public static string ActorOf(ClaimsPrincipal? user) =>
        string.IsNullOrWhiteSpace(user?.Identity?.Name) ? SystemActor : user!.Identity!.Name!;

    public async Task LogAsync(string actor, string action, Guid? platformStoreId, int? storeId, object? details = null, CancellationToken ct = default, DateTime? at = null)
    {
        try
        {
            using var scope = scopes.CreateScope();
            var db = scope.ServiceProvider.GetService<CatalogDbContext>();
            if (db is null) return;
            db.PlatformAudit.Add(new PlatformAuditEntity
            {
                // Momento em que a ação começou (o filtro grava no fim da requisição).
                At = at ?? DateTime.UtcNow,
                Actor = Truncate(actor, 120),
                Action = Truncate(action, 60),
                PlatformStoreId = platformStoreId,
                StoreId = storeId,
                Details = details is null ? null : JsonSerializer.Serialize(details, JsonOptions),
            });
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ao registrar auditoria {Action} da loja {PlatformStoreId}.", action, platformStoreId);
        }
    }

    public async Task<List<PlatformAuditDto>> ListAsync(Guid? platformStoreId, int limit, CancellationToken ct = default)
    {
        using var scope = scopes.CreateScope();
        var db = scope.ServiceProvider.GetService<CatalogDbContext>();
        if (db is null) return [];
        limit = Math.Clamp(limit, 1, 500);

        var query = db.PlatformAudit.AsNoTracking();
        if (platformStoreId is not null) query = query.Where(a => a.PlatformStoreId == platformStoreId);
        var rows = await query
            .OrderByDescending(a => a.At).ThenByDescending(a => a.Id)
            .Take(limit)
            .GroupJoin(db.PlatformStores.AsNoTracking(), a => a.PlatformStoreId, p => (Guid?)p.Id, (a, ps) => new { a, ps })
            .SelectMany(x => x.ps.DefaultIfEmpty(), (x, p) => new { x.a, Name = p != null ? p.Name : null })
            .ToListAsync(ct);

        return rows
            .OrderByDescending(r => r.a.At).ThenByDescending(r => r.a.Id)
            .Select(r => new PlatformAuditDto(r.a.Id, r.a.At, r.a.Actor, r.a.Action, r.a.PlatformStoreId, r.a.StoreId, r.Name, ParseDetails(r.a.Details)))
            .ToList();
    }

    private static JsonElement? ParseDetails(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonDocument.Parse(json).RootElement.Clone(); }
        catch (JsonException) { return null; }
    }

    private static string Truncate(string value, int max) =>
        string.IsNullOrEmpty(value) ? value : value.Length <= max ? value : value[..max];
}
