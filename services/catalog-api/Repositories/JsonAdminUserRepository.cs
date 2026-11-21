using System.Text.Json;
using Catalog.Api.Models;
using Catalog.Api.Services;

namespace Catalog.Api.Repositories;

/// <summary>
/// Persistência de usuários de staff em arquivo JSON (modo de desenvolvimento sem banco).
/// Armazenado em data/admin-users.json (configurável via Data:AdminUsersPath).
/// </summary>
public class JsonAdminUserRepository : IAdminUserRepository
{
    private sealed record JsonAdminUserEntry(
        int Id,
        int? StoreId,
        string Username,
        string PasswordHash,
        string Role,
        string? DisplayName = null,
        string? PinHash = null);

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true
    };

    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly ILogger<JsonAdminUserRepository> _logger;

    public JsonAdminUserRepository(IConfiguration config, IWebHostEnvironment env, ILogger<JsonAdminUserRepository> logger)
    {
        _logger = logger;
        var configured = config["Data:AdminUsersPath"];
        _path = !string.IsNullOrWhiteSpace(configured)
            ? configured
            : Path.GetFullPath(Path.Combine(env.ContentRootPath, "..", "..", "data", "admin-users.json"));
    }

    public async Task<List<StoreUserDto>> ListStoreUsersAsync(int? storeId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var all = await ReadAllAsync(ct);
            return all.Where(u => u.StoreId == storeId && u.Role != StaffRoles.Dev)
                .OrderBy(u => u.Username)
                .Select(ToDto)
                .ToList();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<AdminLoginInfo?> LoginAsync(string username, string password, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var normalized = (username ?? "").Trim();
            var all = await ReadAllAsync(ct);
            var user = all.FirstOrDefault(u => u.Username == normalized)
                ?? all.FirstOrDefault(u => string.Equals(u.Username, normalized, StringComparison.OrdinalIgnoreCase));
            if (user is null || !BCrypt.Net.BCrypt.Verify(password, user.PasswordHash)) return null;
            return new AdminLoginInfo(user.Id, user.Username, user.Role, user.StoreId);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<StoreUserDto> CreateAsync(CreateStoreUserRequest request, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var name = request.Username.Trim();
            if (list.Any(u => string.Equals(u.Username, name, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException($"Usuário '{name}' já existe.");
            var entry = new JsonAdminUserEntry(
                NextId(list),
                request.StoreId,
                name,
                BCrypt.Net.BCrypt.HashPassword(request.Password),
                request.Role,
                string.IsNullOrWhiteSpace(request.DisplayName) ? null : request.DisplayName.Trim(),
                string.IsNullOrWhiteSpace(request.Pin) ? null : BCrypt.Net.BCrypt.HashPassword(request.Pin.Trim()));
            list.Add(entry);
            await WriteAllAsync(list, ct);
            return ToDto(entry);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<StoreUserDto?> UpdateAsync(int userId, UpdateStoreUserRequest request, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(u => u.Id == userId);
            if (idx < 0) return null;
            var current = list[idx];
            var newUsername = request.Username.Trim();
            if (list.Any(u => u.Id != userId && string.Equals(u.Username, newUsername, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException($"Usuário '{newUsername}' já existe.");
            list[idx] = current with
            {
                Username = newUsername,
                Role = request.Role,
                DisplayName = string.IsNullOrWhiteSpace(request.DisplayName) ? null : request.DisplayName.Trim(),
                PasswordHash = string.IsNullOrWhiteSpace(request.Password)
                    ? current.PasswordHash
                    : BCrypt.Net.BCrypt.HashPassword(request.Password),
                PinHash = string.IsNullOrWhiteSpace(request.Pin)
                    ? current.PinHash
                    : BCrypt.Net.BCrypt.HashPassword(request.Pin.Trim())
            };
            await WriteAllAsync(list, ct);
            return ToDto(list[idx]);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> ResetPasswordAsync(int userId, string newPassword, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(u => u.Id == userId);
            if (idx < 0) return false;
            list[idx] = list[idx] with { PasswordHash = BCrypt.Net.BCrypt.HashPassword(newPassword) };
            await WriteAllAsync(list, ct);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> DeleteAsync(int userId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var removed = list.RemoveAll(u => u.Id == userId) > 0;
            if (removed) await WriteAllAsync(list, ct);
            return removed;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> UsernameExistsAsync(string username, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var name = (username ?? "").Trim();
            var all = await ReadAllAsync(ct);
            return all.Any(u => string.Equals(u.Username, name, StringComparison.OrdinalIgnoreCase));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> SetPinHashAsync(string username, string pinHash, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(u => MatchesUsername(u.Username, username));
            if (idx < 0) return false;
            list[idx] = list[idx] with { PinHash = pinHash };
            await WriteAllAsync(list, ct);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> VerifyPinHashAsync(string username, string pin, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var user = list.FirstOrDefault(u => MatchesUsername(u.Username, username));
            return user is not null
                && !string.IsNullOrWhiteSpace(user.PinHash)
                && BCrypt.Net.BCrypt.Verify(pin, user.PinHash);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> HasPinHashAsync(string username, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var user = list.FirstOrDefault(u => MatchesUsername(u.Username, username));
            return user is not null && !string.IsNullOrWhiteSpace(user.PinHash);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<StoreUserDto?> FindByIdAsync(int userId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var all = await ReadAllAsync(ct);
            var user = all.FirstOrDefault(u => u.Id == userId);
            return user is null ? null : ToDto(user);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> SetPinHashByUserIdAsync(int userId, string pinHash, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(u => u.Id == userId);
            if (idx < 0) return false;
            list[idx] = list[idx] with { PinHash = pinHash };
            await WriteAllAsync(list, ct);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> DeletePinHashByUserIdAsync(int userId, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(u => u.Id == userId);
            if (idx < 0) return false;
            list[idx] = list[idx] with { PinHash = null };
            await WriteAllAsync(list, ct);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    private static StoreUserDto ToDto(JsonAdminUserEntry e) =>
        new(e.Id, e.Username, e.Role, e.StoreId, e.DisplayName, !string.IsNullOrWhiteSpace(e.PinHash));

    private static bool MatchesUsername(string candidate, string username) =>
        string.Equals(candidate, (username ?? "").Trim(), StringComparison.OrdinalIgnoreCase);

    public async Task<StoreUserDto?> FindByUsernameAsync(string username, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var all = await ReadAllAsync(ct);
            var user = all.FirstOrDefault(u => MatchesUsername(u.Username, username));
            return user is null ? null : ToDto(user);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<bool> ResetPasswordByUsernameAsync(string username, string newPassword, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(u => MatchesUsername(u.Username, username));
            if (idx < 0) return false;
            list[idx] = list[idx] with { PasswordHash = BCrypt.Net.BCrypt.HashPassword(newPassword) };
            await WriteAllAsync(list, ct);
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<StoreUserDto?> UpdateProfileAsync(string username, string? displayName, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadAllAsync(ct);
            var idx = list.FindIndex(u => MatchesUsername(u.Username, username));
            if (idx < 0) return null;
            list[idx] = list[idx] with { DisplayName = string.IsNullOrWhiteSpace(displayName) ? null : displayName.Trim() };
            await WriteAllAsync(list, ct);
            return ToDto(list[idx]);
        }
        finally
        {
            _gate.Release();
        }
    }

    private static int NextId(List<JsonAdminUserEntry> list) =>
        list.Count == 0 ? 1 : list.Max(u => u.Id) + 1;

    private async Task<List<JsonAdminUserEntry>> ReadAllAsync(CancellationToken ct)
    {
        if (!File.Exists(_path))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            await File.WriteAllTextAsync(_path, "[]", ct);
            return [];
        }
        await using var fs = File.OpenRead(_path);
        var list = await JsonSerializer.DeserializeAsync<List<JsonAdminUserEntry>>(fs, JsonOptions, ct);
        return list ?? [];
    }

    private async Task WriteAllAsync(List<JsonAdminUserEntry> list, CancellationToken ct)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        await using var fs = File.Create(_path);
        await JsonSerializer.SerializeAsync(fs, list, JsonOptions, ct);
        _logger.LogInformation("admin-users.json atualizado ({Count} usuários)", list.Count);
    }
}
