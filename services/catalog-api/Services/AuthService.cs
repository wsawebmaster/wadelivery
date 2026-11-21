using System.IdentityModel.Tokens.Jwt;
using System.Security.Claims;
using System.Text;
using Catalog.Api.Data;
using Catalog.Api.Models;
using Catalog.Api.Repositories;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;

namespace Catalog.Api.Services;

public static class StaffRoles
{
    public const string Atendimento = "Atendimento";
    public const string Dev = "Dev";
    public const string Garçom = "Garçom";
    public const string Admin = "Admin"; // legado = acesso total
    public const string AdminLoja = "AdminLoja";

    public static bool IsFullAccess(string? role) =>
        string.Equals(role, Dev, StringComparison.OrdinalIgnoreCase)
        || string.Equals(role, Admin, StringComparison.OrdinalIgnoreCase)
        || string.Equals(role, AdminLoja, StringComparison.OrdinalIgnoreCase);

    public static bool CanManageOrders(string? role) =>
        IsFullAccess(role)
        || string.Equals(role, Atendimento, StringComparison.OrdinalIgnoreCase)
        || string.Equals(role, Garçom, StringComparison.OrdinalIgnoreCase);
}

public class AuthService(IConfiguration config, IServiceProvider services)
{
    public async Task<LoginResponse?> LoginAsync(LoginRequest request, CancellationToken ct = default)
    {
        var match = await ResolveUserAsync(request.Username, request.Password, ct);
        if (match is null) return null;

        var (username, role, storeId) = match.Value;
        await TouchLastAccessAsync(storeId, role, ct);

        var displayName = await GetDisplayNameAsync(username, ct);

        var key = config["Jwt:Key"];
        var allowInsecure = config.GetValue("Security:AllowInsecureDefaults", false);
        if (string.IsNullOrWhiteSpace(key)
            || (!allowInsecure && key.Contains("ChangeMe", StringComparison.OrdinalIgnoreCase)))
        {
            throw new InvalidOperationException("Jwt:Key não configurada de forma segura.");
        }

        var issuer = config["Jwt:Issuer"] ?? "delivery-catalog";
        var audience = config["Jwt:Audience"] ?? "delivery-clients";
        var defaultMinutes = int.TryParse(config["Jwt:ExpiresMinutes"], out var m) ? m : 480;
        var expiresMinutes = defaultMinutes;

        if (storeId.HasValue)
        {
            try
            {
                var db = services.GetService(typeof(CatalogDbContext)) as CatalogDbContext;
                if (db is not null)
                {
                    var store = await db.Stores.AsNoTracking()
                        .FirstOrDefaultAsync(s => s.Id == storeId.Value, ct);
                    if (store is not null && store.WaiterSessionHours > 0)
                        expiresMinutes = store.WaiterSessionHours * 60;
                }
            }
            catch { /* fallback para defaultMinutes */ }
        }

        var expires = DateTime.UtcNow.AddMinutes(expiresMinutes);

        var claims = new List<Claim>
        {
            new Claim(ClaimTypes.Name, username),
            new Claim(ClaimTypes.Role, role),
            new Claim("role", role)
        };
        if (storeId.HasValue)
            claims.Add(new Claim("store_id", storeId.Value.ToString()));
        if (!string.IsNullOrWhiteSpace(displayName))
            claims.Add(new Claim("name", displayName));

        var credentials = new SigningCredentials(
            new SymmetricSecurityKey(Encoding.UTF8.GetBytes(key)),
            SecurityAlgorithms.HmacSha256);

        var token = new JwtSecurityToken(
            issuer,
            audience,
            claims,
            expires: expires,
            signingCredentials: credentials);

        return new LoginResponse(
            new JwtSecurityTokenHandler().WriteToken(token),
            expires,
            username,
            role,
            storeId);
    }

    /// <summary>
    /// Registra o último acesso da loja no login de qualquer usuário com tenant.
    /// Usuários de loja sem StoreId (papel Admin/Atendimento, usuários legados do seed)
    /// usam o fallback de tenant do deployment (STORE_ID env → 1), igual ao TenantContext.
    /// Dev (operador de plataforma) não toca nenhuma loja.
    /// </summary>
    private async Task TouchLastAccessAsync(int? storeId, string role, CancellationToken ct)
    {
        var target = storeId ?? ResolveTouchStoreId(role);
        if (target is null) return;
        try
        {
            using var scope = services.CreateScope();
            var repo = scope.ServiceProvider.GetService<IPlatformStoreRepository>();
            if (repo is null) return;
            await repo.TouchLastAccessAsync(target, DateTime.UtcNow, ct);
        }
        catch
        {
            // falha ao registrar o acesso não deve bloquear o login
        }
    }

    private int? ResolveTouchStoreId(string role)
    {
        if (string.Equals(role, StaffRoles.Dev, StringComparison.OrdinalIgnoreCase)) return null;
        if (int.TryParse(config["STORE_ID"], out var fromEnv)) return fromEnv;
        return 1;
    }

    private async Task<(string Username, string Role, int? StoreId)?> ResolveUserAsync(
        string username,
        string password,
        CancellationToken ct)
    {
        var persistence = config["Persistence"] ?? "Json";

        if (string.Equals(persistence, "PostgreSQL", StringComparison.OrdinalIgnoreCase)
            || string.Equals(persistence, "Postgres", StringComparison.OrdinalIgnoreCase))
        {
            using var scope = services.CreateScope();
            var db = scope.ServiceProvider.GetRequiredService<CatalogDbContext>();
            var normalized = username.Trim();
            AdminUserEntity? user;
            await using (var transaction = await db.Database.BeginTransactionAsync(ct))
            {
                await db.Database.ExecuteSqlRawAsync("SET LOCAL row_security = off", ct);
                user = await db.AdminUsers.AsNoTracking()
                    .FirstOrDefaultAsync(u => u.Username == normalized, ct);
                if (user is null)
                {
                    var all = await db.AdminUsers.AsNoTracking().ToListAsync(ct);
                    user = all.FirstOrDefault(u =>
                        string.Equals(u.Username, normalized, StringComparison.OrdinalIgnoreCase));
                }
                await transaction.CommitAsync(ct);
            }
            if (user is not null)
            {
                if (!BCrypt.Net.BCrypt.Verify(password, user.PasswordHash)) return null;
                var role = NormalizeRole(user.Role);
                if (role is null) return null;
                return (user.Username, role, user.StoreId);
            }
            // continua para Users do appsettings se não achar no banco
        }
        else
        {
            // Modo Json: usuários criados pelo painel (lojas + staff) vivem em data/admin-users.json.
            try
            {
                using var scope = services.CreateScope();
                var adminUsers = scope.ServiceProvider.GetService<IAdminUserRepository>();
                if (adminUsers is not null)
                {
                    var found = await adminUsers.LoginAsync(username, password, ct);
                    if (found is not null)
                    {
                        var role = NormalizeRole(found.Role);
                        if (role is not null)
                            return (found.Username, role, found.StoreId);
                    }
                }
            }
            catch
            {
                // arquivo ausente/corrompido não deve bloquear o login
            }
        }

        var users = config.GetSection("Users").Get<List<StaffUserConfig>>() ?? [];
        if (users.Count > 0)
        {
            var found = users.FirstOrDefault(u =>
                string.Equals(u.Username, username.Trim(), StringComparison.OrdinalIgnoreCase)
                && u.Password == password);
            if (found is not null)
            {
                var role = NormalizeRole(found.Role);
                if (role is null) return null;
                return (found.Username, role, null);
            }
        }

        // Fallback legado: Admin único (apenas com senha configurada)
        var adminUser = config["Admin:Username"];
        var adminPass = config["Admin:Password"];
        if (!string.IsNullOrWhiteSpace(adminUser)
            && !string.IsNullOrWhiteSpace(adminPass)
            && string.Equals(username.Trim(), adminUser, StringComparison.OrdinalIgnoreCase)
            && password == adminPass)
            return (adminUser, StaffRoles.Admin, null);

        // Administração geral (plataforma) via env Dev:*
        var devUser = config["Dev:Username"];
        var devPass = config["Dev:Password"];
        if (!string.IsNullOrWhiteSpace(devUser)
            && !string.IsNullOrWhiteSpace(devPass)
            && string.Equals(username.Trim(), devUser, StringComparison.OrdinalIgnoreCase)
            && password == devPass)
            return (devUser, StaffRoles.Dev, null);

        // Atendimento via env Atendimento:*
        var atendimentoUser = config["Atendimento:Username"];
        var atendimentoPass = config["Atendimento:Password"];
        if (!string.IsNullOrWhiteSpace(atendimentoUser)
            && !string.IsNullOrWhiteSpace(atendimentoPass)
            && string.Equals(username.Trim(), atendimentoUser, StringComparison.OrdinalIgnoreCase)
            && password == atendimentoPass)
            return (atendimentoUser, StaffRoles.Atendimento, null);

        return null;
    }

    /// <summary>Role vazia nunca vira Dev (evita privilege escalation).</summary>
    private static string? NormalizeRole(string? role)
    {
        if (string.IsNullOrWhiteSpace(role)) return null;
        if (string.Equals(role, StaffRoles.Admin, StringComparison.OrdinalIgnoreCase)) return StaffRoles.Admin;
        if (string.Equals(role, StaffRoles.Dev, StringComparison.OrdinalIgnoreCase)) return StaffRoles.Dev;
        if (string.Equals(role, StaffRoles.Atendimento, StringComparison.OrdinalIgnoreCase)) return StaffRoles.Atendimento;
        if (string.Equals(role, StaffRoles.Garçom, StringComparison.OrdinalIgnoreCase)) return StaffRoles.Garçom;
        if (string.Equals(role, StaffRoles.AdminLoja, StringComparison.OrdinalIgnoreCase)) return StaffRoles.AdminLoja;
        return null;
    }

    /// <summary>
    /// Retorna o nome de exibição salvo para o usuário (null quando não persistido ou
    /// quando o usuário vem de configuração de ambiente, que não tem perfil editável).
    /// </summary>
    public async Task<string?> GetDisplayNameAsync(string username, CancellationToken ct = default)
    {
        using var scope = services.CreateScope();
        var repo = scope.ServiceProvider.GetService<IAdminUserRepository>();
        if (repo is not null)
        {
            var found = await repo.FindByUsernameAsync(username, ct);
            if (found is not null) return found.DisplayName;
        }
        return null;
    }

    /// <summary>
    /// Atualiza o perfil do próprio usuário autenticado (nome de exibição).
    /// Usuários vindos de configuração (env/appsettings) não têm perfil persistido.
    /// </summary>
    public async Task<(AccountUpdateResult Result, StoreUserDto? User)> UpdateOwnProfileAsync(
        string username, string? displayName, CancellationToken ct = default)
    {
        displayName = string.IsNullOrWhiteSpace(displayName) ? null : displayName.Trim();
        if (displayName is not null && displayName.Length > 120)
            displayName = displayName[..120];

        using var scope = services.CreateScope();

        var persistence = config["Persistence"] ?? "Json";
        var usePostgres = string.Equals(persistence, "PostgreSQL", StringComparison.OrdinalIgnoreCase)
            || string.Equals(persistence, "Postgres", StringComparison.OrdinalIgnoreCase);

        StoreUserDto? updated = null;
        if (usePostgres)
        {
            var db = scope.ServiceProvider.GetRequiredService<CatalogDbContext>();
            var user = await FindAdminUserTrackedAsync(db, username, ct);
            if (user is null) return (await ResolveNonPersistedResultAsync(username), null);
            user.DisplayName = displayName;
            await db.SaveChangesAsync(ct);
            updated = new StoreUserDto(user.Id, user.Username, user.Role, user.StoreId, user.DisplayName);
        }
        else
        {
            var repo = scope.ServiceProvider.GetRequiredService<IAdminUserRepository>();
            updated = await repo.UpdateProfileAsync(username, displayName, ct);
            if (updated is null) return (await ResolveNonPersistedResultAsync(username), null);
        }

        return (AccountUpdateResult.Ok, updated);
    }

    /// <summary>
    /// Altera a senha do próprio usuário autenticado (exige senha atual válida).
    /// Usuários vindos de configuração (Users/Admin/Dev/Atendimento no env/appsettings)
    /// retornam ConfigManaged — a senha deles só pode mudar no ambiente.
    /// </summary>
    public async Task<AccountUpdateResult> ChangeOwnPasswordAsync(
        string username, string currentPassword, string newPassword, CancellationToken ct = default)
    {
        using var scope = services.CreateScope();

        var persistence = config["Persistence"] ?? "Json";
        var usePostgres = string.Equals(persistence, "PostgreSQL", StringComparison.OrdinalIgnoreCase)
            || string.Equals(persistence, "Postgres", StringComparison.OrdinalIgnoreCase);

        if (usePostgres)
        {
            var db = scope.ServiceProvider.GetRequiredService<CatalogDbContext>();
            var user = await FindAdminUserTrackedAsync(db, username, ct);
            if (user is not null)
            {
                if (!BCrypt.Net.BCrypt.Verify(currentPassword, user.PasswordHash))
                    return AccountUpdateResult.WrongPassword;
                user.PasswordHash = BCrypt.Net.BCrypt.HashPassword(newPassword);
                await db.SaveChangesAsync(ct);
                return AccountUpdateResult.Ok;
            }
        }
        else
        {
            var repo = scope.ServiceProvider.GetRequiredService<IAdminUserRepository>();
            if (await repo.LoginAsync(username, currentPassword, ct) is not null)
                return await repo.ResetPasswordByUsernameAsync(username, newPassword, ct)
                    ? AccountUpdateResult.Ok
                    : AccountUpdateResult.UserNotFound;
            if (await repo.FindByUsernameAsync(username, ct) is not null)
                return AccountUpdateResult.WrongPassword;
        }

        return await ResolveNonPersistedResultAsync(username, currentPassword);
    }

    /// <summary>
    /// Classifica usuário não encontrado na fonte persistida: ou é gerenciado por
    /// configuração do servidor (ConfigManaged/WrongPassword) ou não existe (UserNotFound).
    /// </summary>
    private Task<AccountUpdateResult> ResolveNonPersistedResultAsync(string username, string? currentPassword = null)
    {
        var trimmed = (username ?? "").Trim();

        var users = config.GetSection("Users").Get<List<StaffUserConfig>>() ?? [];
        foreach (var u in users.Where(u => string.Equals(u.Username, trimmed, StringComparison.OrdinalIgnoreCase)))
        {
            if (currentPassword is null || u.Password == currentPassword)
                return Task.FromResult(AccountUpdateResult.ConfigManaged);
            return Task.FromResult(AccountUpdateResult.WrongPassword);
        }

        foreach (var pair in new[]
                 {
                     (config["Admin:Username"], config["Admin:Password"]),
                     (config["Dev:Username"], config["Dev:Password"]),
                     (config["Atendimento:Username"], config["Atendimento:Password"])
                 })
        {
            if (string.IsNullOrWhiteSpace(pair.Item1)) continue;
            if (!string.Equals(pair.Item1.Trim(), trimmed, StringComparison.OrdinalIgnoreCase)) continue;
            if (currentPassword is null || pair.Item2 == currentPassword)
                return Task.FromResult(AccountUpdateResult.ConfigManaged);
            return Task.FromResult(AccountUpdateResult.WrongPassword);
        }

        return Task.FromResult(AccountUpdateResult.UserNotFound);
    }

    private static async Task<AdminUserEntity?> FindAdminUserTrackedAsync(
        CatalogDbContext db, string username, CancellationToken ct)
    {
        var normalized = (username ?? "").Trim();
        var user = await db.AdminUsers.FirstOrDefaultAsync(u => u.Username == normalized, ct);
        if (user is not null) return user;
        // fallback case-insensitive (mesma regra do login)
        var all = await db.AdminUsers.ToListAsync(ct);
        return all.FirstOrDefault(u =>
            string.Equals(u.Username, normalized, StringComparison.OrdinalIgnoreCase));
    }
}

/// <summary>Resultado das operações de conta executadas pelo próprio usuário autenticado.</summary>
public enum AccountUpdateResult
{
    Ok,
    /// <summary>Usuário existe mas a senha atual informada não confere.</summary>
    WrongPassword,
    /// <summary>Usuário vem de configuração do servidor (env/appsettings) — sem perfil/senha via API.</summary>
    ConfigManaged,
    /// <summary>Usuário não encontrado em nenhuma fonte.</summary>
    UserNotFound
}

public class StaffUserConfig
{
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    public string Role { get; set; } = StaffRoles.Dev;
}
