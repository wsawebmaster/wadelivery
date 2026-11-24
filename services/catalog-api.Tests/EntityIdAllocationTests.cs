using Catalog.Api;
using Catalog.Api.Repositories;

namespace Catalog.Api.Tests;

public class EntityIdAllocationTests
{
    [Fact]
    public void NewEntityId_is_unique_and_accepted_as_safe_id()
    {
        // Ids de products/categories/ingredients são chave global entre lojas: precisam ser únicos
        // na tabela inteira (antes, "maior número da loja + 1" colidia com outra loja).
        var ids = Enumerable.Range(0, 2000).Select(_ => EfCatalogRepository.NewEntityId()).ToList();

        Assert.Equal(ids.Count, ids.Distinct().Count());
        Assert.All(ids, id =>
        {
            Assert.Equal(32, id.Length);
            Assert.Null(CatalogInputValidation.ValidateProduct(
                new Catalog.Api.Models.UpsertProductRequest(id, id, "Produto", 10m, true, null)));
        });
    }
}
