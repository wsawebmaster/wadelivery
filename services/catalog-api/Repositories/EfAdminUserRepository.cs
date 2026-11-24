using Catalog.Api.Data;
using Catalog.Api.Models;
using Catalog.Api.Services;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Repositories;

public class EfAdminUserRepository(CatalogDbContext db) : IAdminUserRepository
{
    public async Task<List<StoreUserDto>> ListStoreUsersAsync(int? storeId, CancellationToken ct = default)
    {
        var users = await db.AdminUsers.AsNoTracking()
            .Where(u => u.StoreId == storeId && u.Role != StaffRoles.Dev)
            .OrderBy(u => u.Username)
            .ToListAsync(ct);
        return users.Select(Map).ToList();
    }

    public async Task<StoreUserDto?> FindByUsernameAsync(string username, CancellationToken ct = default)
    {
        var user = await FindTrackedAsync(username, tracked: false, ct);
        return user is null ? null : Map(user);
    }

    public async Task<StoreUserDto?> FindByIdAsync(int userId, CancellationToken ct = default)
    {
        var user = await db.AdminUsers.AsNoTracking().FirstOrDefaultAsync(u => u.Id == userId, ct);
        return user is null ? null : Map(user);
    }

    private static StoreUserDto Map(AdminUserEntity u) =>
        new(u.Id, u.Username, u.Role, u.StoreId, u.DisplayName, !string.IsNullOrWhiteSpace(u.PinHash));

    public async Task<bool> ResetPasswordByUsernameAsync(string username, string newPassword, CancellationToken ct = default)
    {
        var user = await FindTrackedAsync(username, tracked: true, ct);
        if (user is null) return false;
        user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(newPassword);
        user.MustChangePassword = false; // o próprio usuário escolheu a senha
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<StoreUserDto?> UpdateProfileAsync(string username, string? displayName, CancellationToken ct = default)
    {
        var user = await FindTrackedAsync(username, tracked: true, ct);
        if (user is null) return null;
        user.DisplayName = string.IsNullOrWhiteSpace(displayName) ? null : displayName.Trim();
        await db.SaveChangesAsync(ct);
        return Map(user);
    }

    private async Task<AdminUserEntity?> FindTrackedAsync(string username, bool tracked, CancellationToken ct)
    {
        var normalized = (username ?? "").Trim();
        var query = tracked ? db.AdminUsers : db.AdminUsers.AsNoTracking();
        var user = await query.FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (user is not null) return user;
        // fallback case-insensitive (mesma regra do login)
        var all = await (tracked ? db.AdminUsers.ToListAsync(ct) : db.AdminUsers.AsNoTracking().ToListAsync(ct));
        return all.FirstOrDefault(u =>
            string.Equals(u.Username, normalized, StringComparison.OrdinalIgnoreCase));
    }

    public async Task<AdminLoginInfo?> LoginAsync(string username, string password, CancellationToken ct = default)
    {
        var normalized = username.Trim();
        var user = await db.AdminUsers.AsNoTracking()
            .FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (user is null)
        {
            var all = await db.AdminUsers.AsNoTracking().ToListAsync(ct);
            user = all.FirstOrDefault(u =>
                string.Equals(u.Username, normalized, StringComparison.OrdinalIgnoreCase));
        }
        if (user is null || !BCrypt.Net.BCrypt.Verify(password, user.PasswordHash)) return null;
        return new AdminLoginInfo(user.Id, user.Username, user.Role, user.StoreId);
    }

    public async Task<StoreUserDto> CreateAsync(CreateStoreUserRequest request, CancellationToken ct = default)
    {
        if (await UsernameExistsAsync(request.Username, ct))
            throw new InvalidOperationException($"Usuário '{request.Username}' já existe.");
        var entity = new AdminUserEntity
        {
            StoreId = request.StoreId,
            Username = request.Username.Trim(),
            PasswordHash = BCrypt.Net.BCrypt.HashPassword(request.Password),
            Role = request.Role,
            DisplayName = string.IsNullOrWhiteSpace(request.DisplayName) ? null : request.DisplayName.Trim(),
            PinHash = string.IsNullOrWhiteSpace(request.Pin) ? null : BCrypt.Net.BCrypt.HashPassword(request.Pin.Trim())
        };
        db.AdminUsers.Add(entity);
        await db.SaveChangesAsync(ct);
        return Map(entity);
    }

    public async Task<StoreUserDto?> UpdateAsync(int userId, UpdateStoreUserRequest request, CancellationToken ct = default)
    {
        var user = await db.AdminUsers.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return null;
        var newUsername = request.Username.Trim();
        if (!string.Equals(user.Username, newUsername, StringComparison.OrdinalIgnoreCase)
            && await UsernameExistsAsync(newUsername, ct))
            throw new InvalidOperationException($"Usuário '{newUsername}' já existe.");
        user.Username = newUsername;
        user.Role = request.Role;
        user.DisplayName = string.IsNullOrWhiteSpace(request.DisplayName) ? null : request.DisplayName.Trim();
        if (!string.IsNullOrWhiteSpace(request.Password))
            user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(request.Password);
        if (!string.IsNullOrWhiteSpace(request.Pin))
            user.PinHash = BCrypt.Net.BCrypt.HashPassword(request.Pin.Trim());
        await db.SaveChangesAsync(ct);
        return Map(user);
    }

    public async Task<bool> ResetPasswordAsync(int userId, string newPassword, CancellationToken ct = default)
    {
        var user = await db.AdminUsers.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return false;
        user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(newPassword);
        // Redefinida pela plataforma ou pelo administrador da loja: troca obrigatória no próximo acesso.
        user.MustChangePassword = true;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> DeleteAsync(int userId, CancellationToken ct = default)
    {
        var user = await db.AdminUsers.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return false;
        db.AdminUsers.Remove(user);
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> UsernameExistsAsync(string username, CancellationToken ct = default)
    {
        var u = (username ?? "").Trim();
        return await db.AdminUsers.AnyAsync(x => x.Username.ToLower() == u.ToLower(), ct);
    }

    public async Task<bool> SetPinHashAsync(string username, string pinHash, CancellationToken ct = default)
    {
        var user = await FindTrackedAsync(username, tracked: true, ct);
        if (user is null) return false;
        user.PinHash = pinHash;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> VerifyPinHashAsync(string username, string pin, CancellationToken ct = default)
    {
        var user = await FindTrackedAsync(username, tracked: false, ct);
        return user is not null
            && !string.IsNullOrWhiteSpace(user.PinHash)
            && BCrypt.Net.BCrypt.Verify(pin, user.PinHash);
    }

    public async Task<bool> HasPinHashAsync(string username, CancellationToken ct = default)
    {
        var user = await FindTrackedAsync(username, tracked: false, ct);
        return user is not null && !string.IsNullOrWhiteSpace(user.PinHash);
    }

    public async Task<bool> SetPinHashByUserIdAsync(int userId, string pinHash, CancellationToken ct = default)
    {
        var user = await db.AdminUsers.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return false;
        user.PinHash = pinHash;
        await db.SaveChangesAsync(ct);
        return true;
    }

    public async Task<bool> DeletePinHashByUserIdAsync(int userId, CancellationToken ct = default)
    {
        var user = await db.AdminUsers.FirstOrDefaultAsync(u => u.Id == userId, ct);
        if (user is null) return false;
        user.PinHash = null;
        await db.SaveChangesAsync(ct);
        return true;
    }
}
