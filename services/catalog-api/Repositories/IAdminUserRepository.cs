using Catalog.Api.Models;

namespace Catalog.Api.Repositories;

/// <summary>
/// Usuários de staff (admin_users) por loja. Em PostgreSQL são linhas do banco;
/// em modo Json (desenvolvimento) são gravados em data/admin-users.json.
/// </summary>
public interface IAdminUserRepository
{
    Task<List<StoreUserDto>> ListStoreUsersAsync(int? storeId, CancellationToken ct = default);
    Task<AdminLoginInfo?> LoginAsync(string username, string password, CancellationToken ct = default);
    Task<StoreUserDto> CreateAsync(CreateStoreUserRequest request, CancellationToken ct = default);
    Task<StoreUserDto?> UpdateAsync(int userId, UpdateStoreUserRequest request, CancellationToken ct = default);
    Task<bool> ResetPasswordAsync(int userId, string newPassword, CancellationToken ct = default);
    Task<bool> DeleteAsync(int userId, CancellationToken ct = default);
    Task<bool> UsernameExistsAsync(string username, CancellationToken ct = default);
    Task<StoreUserDto?> FindByUsernameAsync(string username, CancellationToken ct = default);
    /// <summary>Busca um usuário de staff pelo id (sem PIN em claro).</summary>
    Task<StoreUserDto?> FindByIdAsync(int userId, CancellationToken ct = default);
    Task<bool> ResetPasswordByUsernameAsync(string username, string newPassword, CancellationToken ct = default);
    Task<StoreUserDto?> UpdateProfileAsync(string username, string? displayName, CancellationToken ct = default);

    /// <summary>Define/atualiza o hash do PIN de 4 dígitos do usuário.</summary>
    Task<bool> SetPinHashAsync(string username, string pinHash, CancellationToken ct = default);
    /// <summary>Define/atualiza o hash do PIN de um usuário pelo id.</summary>
    Task<bool> SetPinHashByUserIdAsync(int userId, string pinHash, CancellationToken ct = default);
    /// <summary>Remove o PIN de um usuário pelo id.</summary>
    Task<bool> DeletePinHashByUserIdAsync(int userId, CancellationToken ct = default);
    /// <summary>Verifica se o PIN informado corresponde ao hash salvo do usuário.</summary>
    Task<bool> VerifyPinHashAsync(string username, string pin, CancellationToken ct = default);
    /// <summary>Indica se o usuário já definiu um PIN.</summary>
    Task<bool> HasPinHashAsync(string username, CancellationToken ct = default);
}
