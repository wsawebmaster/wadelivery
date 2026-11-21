using Catalog.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Services;

/// <summary>
/// Armazenamento de sessões de PIN (camada adicional ao JWT). Em PostgreSQL persiste
/// na tabela pin_sessions; em modo Json usa memória (sessões efêmeras, sem banco).
/// </summary>
public interface IPinSessionStore
{
    /// <summary>Cria uma nova sessão de PIN válida até expiresAtUtc.</summary>
    Task<string> CreateAsync(int adminUserId, int storeId, DateTime expiresAtUtc, CancellationToken ct = default);
    /// <summary>Verifica se a sessão é válida (existe, não expirada e não revogada).</summary>
    Task<bool> IsValidAsync(string sessionId, int adminUserId, CancellationToken ct = default);
    /// <summary>Revoga (invalida imediatamente) a sessão informada.</summary>
    Task RevokeAsync(string sessionId, CancellationToken ct = default);
}

/// <summary>Armazenamento em PostgreSQL (tabela pin_sessions).</summary>
public sealed class EfPinSessionStore(CatalogDbContext db) : IPinSessionStore
{
    public async Task<string> CreateAsync(int adminUserId, int storeId, DateTime expiresAtUtc, CancellationToken ct = default)
    {
        var sessionId = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        db.PinSessions.Add(new PinSessionEntity
        {
            AdminUserId = adminUserId,
            StoreId = storeId,
            SessionId = sessionId,
            CreatedAtUtc = DateTime.UtcNow,
            ExpiresAtUtc = expiresAtUtc
        });
        await db.SaveChangesAsync(ct);
        return sessionId;
    }

    public async Task<bool> IsValidAsync(string sessionId, int adminUserId, CancellationToken ct = default)
    {
        var now = DateTime.UtcNow;
        return await db.PinSessions.AsNoTracking()
            .AnyAsync(s =>
                s.SessionId == sessionId
                && s.AdminUserId == adminUserId
                && s.RevokedAtUtc == null
                && s.ExpiresAtUtc > now, ct);
    }

    public async Task RevokeAsync(string sessionId, CancellationToken ct = default)
    {
        var session = await db.PinSessions.FirstOrDefaultAsync(s => s.SessionId == sessionId, ct);
        if (session is null) return;
        session.RevokedAtUtc = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }
}

/// <summary>Armazenamento em memória (modo Json / desenvolvimento).</summary>
public sealed class InMemoryPinSessionStore : IPinSessionStore
{
    private sealed record Entry(int AdminUserId, string SessionId, DateTime ExpiresAtUtc, bool Revoked);

    private readonly List<Entry> _sessions = [];
    private readonly SemaphoreSlim _gate = new(1, 1);

    public async Task<string> CreateAsync(int adminUserId, int storeId, DateTime expiresAtUtc, CancellationToken ct = default)
    {
        var sessionId = Guid.NewGuid().ToString("N") + Guid.NewGuid().ToString("N");
        await _gate.WaitAsync(ct);
        try
        {
            Prune();
            _sessions.Add(new Entry(adminUserId, sessionId, expiresAtUtc, false));
            return sessionId;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> IsValidAsync(string sessionId, int adminUserId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            Prune();
            var now = DateTime.UtcNow;
            return _sessions.Any(s =>
                s.SessionId == sessionId
                && s.AdminUserId == adminUserId
                && !s.Revoked
                && s.ExpiresAtUtc > now);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task RevokeAsync(string sessionId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var idx = _sessions.FindIndex(s => s.SessionId == sessionId);
            if (idx < 0) return;
            _sessions[idx] = _sessions[idx] with { Revoked = true };
        }
        finally
        {
            _gate.Release();
        }
    }

    private void Prune()
    {
        var now = DateTime.UtcNow;
        _sessions.RemoveAll(s => s.Revoked || s.ExpiresAtUtc <= now);
    }
}
