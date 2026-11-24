using Catalog.Api.Models;

namespace Catalog.Api.Repositories;

public interface IPlatformStoreRepository
{
    Task<List<PlatformStoreDto>> ListAsync(CancellationToken ct = default);
    Task<PlatformStoreDto?> GetAsync(Guid id, CancellationToken ct = default);
    Task<PlatformStoreDto> CreateAsync(UpsertPlatformStoreRequest request, CancellationToken ct = default);
    Task<PlatformStoreDto?> UpdateAsync(Guid id, UpsertPlatformStoreRequest request, CancellationToken ct = default);
    Task<PlatformStoreDto> DuplicateAsync(Guid id, CancellationToken ct = default);
    /// <summary>Exclusão lógica: marca a loja como inativa (mantém histórico e vínculos).</summary>
    Task<bool> DeleteAsync(Guid id, CancellationToken ct = default);
    Task<PlatformStoreDto?> RegisterPaymentAsync(Guid id, RegisterPlatformPaymentRequest request, CancellationToken ct = default);
    Task<PlatformStoreDto?> SetLogoAsync(Guid id, string? logoUrl, CancellationToken ct = default);
    Task<PlatformStoreDto?> AddGalleryImageAsync(Guid id, GalleryImageDto image, CancellationToken ct = default);
    Task<PlatformStoreDto?> RemoveGalleryImageAsync(Guid id, string imageId, CancellationToken ct = default);
    /// <summary>Atualiza o último acesso da loja (login de usuário vinculado). No-op quando storeId é nulo.</summary>
    Task TouchLastAccessAsync(int? storeId, DateTime when, CancellationToken ct = default);
    /// <summary>Persiste o snapshot de estatísticas da loja (acessos ao cardápio + pedidos). No-op quando storeId é nulo.</summary>
    Task SaveStatsAsync(int? storeId, StoreStatsDto stats, CancellationToken ct = default);
    /// <summary>Aplica as regras de cobrança em todas as lojas (vencimento, bloqueio/desbloqueio). Retorna quantas mudaram.</summary>
    Task<int> EvaluateBillingAsync(DateTime nowUtc, Services.BillingOptions options, CancellationToken ct = default);
    Task<PlatformStoreDto?> SetSegmentAsync(Guid id, string segment, CancellationToken ct = default);
    Task<PlatformStoreDto?> UpdateBillingAsync(Guid id, UpdatePlatformBillingRequest request, CancellationToken ct = default);
    /// <summary>Bloqueio/desbloqueio manual pelo painel da plataforma.</summary>
    Task<PlatformStoreDto?> SetBlockedAsync(Guid id, bool blocked, Services.BillingOptions options, CancellationToken ct = default);
}
