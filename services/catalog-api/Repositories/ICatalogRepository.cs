using Catalog.Api.Models;

namespace Catalog.Api.Repositories;

public interface ICatalogRepository
{
    Task<StoreDto> GetStoreAsync(CancellationToken ct = default);
    Task<CatalogDto> GetCatalogAsync(CancellationToken ct = default);
    Task<IReadOnlyList<IngredientDto>> GetIngredientsAsync(CancellationToken ct = default);
    Task UpdateStoreAsync(PatchStoreRequest request, CancellationToken ct = default);
    Task UpsertCategoryAsync(UpsertCategoryRequest request, CancellationToken ct = default);
    Task DeleteCategoryAsync(string id, CancellationToken ct = default);
    Task UpsertIngredientAsync(UpsertIngredientRequest request, CancellationToken ct = default);
    Task DeleteIngredientAsync(string id, CancellationToken ct = default);
    Task UpsertProductAsync(UpsertProductRequest request, CancellationToken ct = default);
    Task DeleteProductAsync(string id, CancellationToken ct = default);
    Task MoveCategoryAsync(string id, string direction, CancellationToken ct = default);
    Task MoveProductAsync(string id, string direction, CancellationToken ct = default);
    Task MoveIngredientAsync(string id, string direction, CancellationToken ct = default);
    Task ReorderCategoriesAsync(IReadOnlyList<string> ids, CancellationToken ct = default);
    Task ReorderProductsAsync(string categoryId, IReadOnlyList<string> ids, CancellationToken ct = default);
    Task ReorderIngredientsAsync(IReadOnlyList<string> ids, CancellationToken ct = default);
    /// <summary>Próximo id numérico (1, 2, 3…), ignorando ids não numéricos legados.</summary>
    Task<string> AllocateNextProductIdAsync(CancellationToken ct = default);
    Task<string> AllocateNextCategoryIdAsync(CancellationToken ct = default);
    Task<string> AllocateNextIngredientIdAsync(CancellationToken ct = default);
    void InvalidateCache();
}
