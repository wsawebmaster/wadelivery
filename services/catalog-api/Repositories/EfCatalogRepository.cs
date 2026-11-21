using System.Text.Json;
using Catalog.Api;
using Catalog.Api.Data;
using Catalog.Api.Models;
using Catalog.Api.MultiTenancy;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Caching.Memory;

namespace Catalog.Api.Repositories;

public class EfCatalogRepository(
    CatalogDbContext db,
    IMemoryCache cache,
    TenantContext tenant,
    CatalogCacheInvalidator invalidator,
    ILogger<EfCatalogRepository> logger) : ICatalogRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    private string CacheKey(string baseKey) => $"t{tenant.StoreId}:{baseKey}";
    private const string StoreCacheKey = "store";
    private const string CatalogCacheKey = "catalog";
    private const string IngredientsCacheKey = "ingredients";

    public void InvalidateCache()
    {
        invalidator.InvalidateStore(tenant.StoreId);
        // A lista de lojas da plataforma embute o store config da loja em execução (PlatformStoreSync).
        invalidator.InvalidateGlobal();
    }

    public async Task<StoreDto> GetStoreAsync(CancellationToken ct = default)
    {
        var key = CacheKey(StoreCacheKey);
        var result = await cache.GetOrCreateAsync(key, async entry =>
        {
            entry.Priority = CacheItemPriority.NeverRemove;
            var entity = await db.Stores.AsNoTracking()
                .FirstOrDefaultAsync(s => s.Id == tenant.StoreId, ct)
                ?? throw new KeyNotFoundException($"Loja não encontrada para StoreId={tenant.StoreId}");
            return MapStore(entity);
        });
        return result!;
    }

    public async Task<CatalogDto> GetCatalogAsync(CancellationToken ct = default)
    {
        var key = CacheKey(CatalogCacheKey);
        var result = await cache.GetOrCreateAsync(key, async entry =>
        {
            entry.Priority = CacheItemPriority.NeverRemove;
            var storeId = tenant.StoreId;
            var categories = await db.Categories
                .AsNoTracking()
                .Where(c => c.StoreId == storeId)
                .Include(c => c.Products)
                    .ThenInclude(p => p.ProductIngredients)
                        .ThenInclude(pi => pi.Ingredient)
                .OrderBy(c => c.SortOrder)
                .ThenBy(c => c.Title)
                .ToListAsync(ct);

            return new CatalogDto(categories.Select(c => new CategoryDto(
                c.Id,
                c.Title,
                c.SortOrder,
                c.Products
                    .OrderBy(p => p.SortOrder)
                    .ThenBy(p => p.Name)
                    .Select(MapProduct)
                    .ToList(),
                c.ShowInMenu
            )).ToList());
        });
        return result!;
    }

    public async Task<IReadOnlyList<IngredientDto>> GetIngredientsAsync(CancellationToken ct = default)
    {
        var key = CacheKey(IngredientsCacheKey);
        var result = await cache.GetOrCreateAsync(key, async entry =>
        {
            entry.Priority = CacheItemPriority.NeverRemove;
            var storeId = tenant.StoreId;
            return (IReadOnlyList<IngredientDto>)await db.Ingredients
                .AsNoTracking()
                .Where(i => i.StoreId == storeId)
                .OrderBy(i => i.SortOrder)
                .ThenBy(i => i.Name)
                .Select(i => new IngredientDto(i.Id, i.Name, i.SortOrder, i.CategoryId, i.Available))
                .ToListAsync(ct);
        });
        return result!;
    }

    public async Task UpdateStoreAsync(PatchStoreRequest request, CancellationToken ct = default)
    {
        var entity = await db.Stores.FirstOrDefaultAsync(s => s.Id == tenant.StoreId, ct)
            ?? throw new KeyNotFoundException($"Loja não encontrada para StoreId={tenant.StoreId}");
        if (request.StoreName is not null) entity.StoreName = request.StoreName;
        if (request.Slug is not null)
        {
            var oldSlug = entity.Slug;
            entity.Slug = CatalogInputValidation.NormalizeTenantSlug(request.Slug);
            invalidator.InvalidateSlug(oldSlug);
            invalidator.InvalidateSlug(entity.Slug);
        }
        if (request.LogoUrl is not null) entity.LogoUrl = request.LogoUrl;
        if (request.Whatsapp is not null) entity.Whatsapp = request.Whatsapp;
        if (request.PixKey is not null) entity.PixKey = request.PixKey;
        if (request.PixKeyLabel is not null) entity.PixKeyLabel = request.PixKeyLabel;
        if (request.MinOrder is not null) entity.MinOrder = request.MinOrder.Value;
        if (request.Schedule is not null)
            entity.ScheduleJson = JsonSerializer.Serialize(request.Schedule, JsonOptions);
        if (request.DeliveryFees is not null)
            entity.DeliveryFeesJson = JsonSerializer.Serialize(request.DeliveryFees, JsonOptions);
        if (request.Address is not null) entity.Address = request.Address;
        if (request.Cep is not null) entity.Cep = request.Cep;
        if (request.City is not null) entity.City = request.City;
        if (request.State is not null) entity.State = string.IsNullOrWhiteSpace(request.State)
            ? null
            : request.State.Trim().ToUpperInvariant();
        if (request.Latitude is not null) entity.Latitude = request.Latitude;
        if (request.Longitude is not null) entity.Longitude = request.Longitude;
        if (request.DeliveryFeePerKm is not null) entity.DeliveryFeePerKm = request.DeliveryFeePerKm.Value;
        if (request.MaxDeliveryKm is not null) entity.MaxDeliveryKm = request.MaxDeliveryKm.Value;
        if (request.MinDeliveryFee is not null) entity.MinDeliveryFee = request.MinDeliveryFee.Value;
        if (request.AverageDeliveryMinutes is not null)
            entity.AverageDeliveryMinutes = Math.Max(0, request.AverageDeliveryMinutes.Value);
        if (request.BreadOptions is not null)
        {
            entity.BreadOptionsJson = JsonSerializer.Serialize(
                StoreBreadOptions.Normalize(request.BreadOptions), JsonOptions);
            logger.LogInformation(
                "BreadOptions atualizado: {Json}",
                entity.BreadOptionsJson);
        }
        if (request.AcceptingOrders is not null) entity.AcceptingOrders = request.AcceptingOrders.Value;
        if (request.AddressNumber is not null) entity.AddressNumber = request.AddressNumber;
        if (request.IconUrl is not null) entity.IconUrl = request.IconUrl;
        if (request.ClearExtendedCloseUntil == true) entity.ExtendedCloseUntilUtc = null;
        else if (request.ExtendedCloseUntilUtc is not null) entity.ExtendedCloseUntilUtc = request.ExtendedCloseUntilUtc;
        if (request.AutoAdvancePreparing is not null) entity.AutoAdvancePreparing = request.AutoAdvancePreparing.Value;
        if (request.AutoAdvancePreparingMinutes is not null)
            entity.AutoAdvancePreparingMinutes = Math.Max(0, request.AutoAdvancePreparingMinutes.Value);
        if (request.DineInEnabled is not null) entity.DineInEnabled = request.DineInEnabled.Value;
        if (request.CustomerQrOrdersEnabled is not null) entity.CustomerQrOrdersEnabled = request.CustomerQrOrdersEnabled.Value;
        if (request.WaiterOrdersEnabled is not null) entity.WaiterOrdersEnabled = request.WaiterOrdersEnabled.Value;
        if (request.AllowManualTableEntry is not null) entity.AllowManualTableEntry = request.AllowManualTableEntry.Value;
        if (request.RequireCustomerNameForQrOrder is not null) entity.RequireCustomerNameForQrOrder = request.RequireCustomerNameForQrOrder.Value;
        if (request.AllowCustomerChooseWaiter is not null) entity.AllowCustomerChooseWaiter = request.AllowCustomerChooseWaiter.Value;
        if (request.TableCount is not null) entity.TableCount = request.TableCount.Value;
        if (request.WaiterSessionHours is not null) entity.WaiterSessionHours = Math.Clamp(request.WaiterSessionHours.Value, 1, 24);

        entity.DataAtualizacao = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
        logger.LogInformation("Store config atualizado via PostgreSQL/EF");
    }

    public async Task UpsertCategoryAsync(UpsertCategoryRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Id))
            throw new ArgumentException("Id da categoria é obrigatório no upsert.");

        var title = request.Title.Trim();
        var storeId = tenant.StoreId;
        var duplicate = await db.Categories.AsNoTracking().AnyAsync(
            c => c.StoreId == storeId && c.Id != request.Id && c.Title.ToLower() == title.ToLower(), ct);
        if (duplicate)
            throw new InvalidOperationException($"Já existe uma categoria com o nome '{title}'.");

        var entity = await db.Categories.FirstOrDefaultAsync(c => c.Id == request.Id && c.StoreId == tenant.StoreId, ct);
        if (entity is null)
        {
            var sort = request.SortOrder
                ?? (await db.Categories.Where(c => c.StoreId == tenant.StoreId).Select(c => (int?)c.SortOrder).MaxAsync(ct) ?? 0) + 1;
            db.Categories.Add(new CategoryEntity
            {
                Id = request.Id!,
                Title = title,
                SortOrder = sort,
                ShowInMenu = CatalogInputValidation.ResolveCategoryShowInMenu(request.Id!, title, request.ShowInMenu),
                StoreId = tenant.StoreId
            });
        }
        else
        {
            entity.Title = title;
            entity.ShowInMenu = CatalogInputValidation.ResolveCategoryShowInMenu(entity.Id, title, request.ShowInMenu);
            if (request.SortOrder is not null)
                entity.SortOrder = request.SortOrder.Value;
        }

        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task DeleteCategoryAsync(string id, CancellationToken ct = default)
    {
        var entity = await db.Categories.Include(c => c.Products).FirstOrDefaultAsync(c => c.Id == id && c.StoreId == tenant.StoreId, ct);
        if (entity is null) return;
        if (entity.Products.Count > 0)
        {
            throw new InvalidOperationException(
                $"Não é possível excluir a categoria '{entity.Title}': existem {entity.Products.Count} produto(s) vinculados. Remova ou mova os produtos antes.");
        }

        // Desvincula ingredientes que apontam para esta categoria (ficam "Sem categoria").
        var linked = await db.Ingredients
            .Where(i => i.StoreId == tenant.StoreId && i.CategoryId == id)
            .ToListAsync(ct);
        if (linked.Count > 0)
        {
            foreach (var ing in linked)
                ing.CategoryId = null;
        }

        db.Categories.Remove(entity);
        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task UpsertIngredientAsync(UpsertIngredientRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Id))
            throw new ArgumentException("Id do ingrediente é obrigatório no upsert.");

        var name = request.Name.Trim();
        var storeId = tenant.StoreId;
        var duplicate = await db.Ingredients.AsNoTracking().AnyAsync(
            i => i.StoreId == storeId && i.Id != request.Id && i.Name.ToLower() == name.ToLower(), ct);
        if (duplicate)
            throw new InvalidOperationException($"Já existe um ingrediente com o nome '{name}'.");

        var entity = await db.Ingredients.FirstOrDefaultAsync(i => i.Id == request.Id && i.StoreId == tenant.StoreId, ct);
        if (entity is null)
        {
            var sort = request.SortOrder
                ?? (await db.Ingredients.Where(i => i.StoreId == tenant.StoreId).Select(i => (int?)i.SortOrder).MaxAsync(ct) ?? 0) + 1;
            db.Ingredients.Add(new IngredientEntity
            {
                Id = request.Id!,
                StoreId = tenant.StoreId,
                Name = name,
                SortOrder = sort,
                CategoryId = NormalizeCategoryId(request.CategoryId),
                Available = request.Available
            });
        }
        else
        {
            entity.Name = name;
            entity.CategoryId = NormalizeCategoryId(request.CategoryId);
            entity.Available = request.Available;
            if (request.SortOrder is not null)
                entity.SortOrder = request.SortOrder.Value;
        }

        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task DeleteIngredientAsync(string id, CancellationToken ct = default)
    {
        var entity = await db.Ingredients
            .Include(i => i.ProductIngredients)
            .FirstOrDefaultAsync(i => i.Id == id && i.StoreId == tenant.StoreId, ct);
        if (entity is null) return;
        if (entity.ProductIngredients.Count > 0)
        {
            throw new InvalidOperationException(
                $"Não é possível excluir o ingrediente '{entity.Name}': existem {entity.ProductIngredients.Count} produto(s) vinculados. Remova o vínculo nos produtos antes.");
        }

        db.Ingredients.Remove(entity);
        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task UpsertProductAsync(UpsertProductRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Id))
            throw new ArgumentException("Id do produto é obrigatório no upsert.");

        var categoryExists = await db.Categories.AnyAsync(c => c.Id == request.CategoryId && c.StoreId == tenant.StoreId, ct);
        if (!categoryExists)
            throw new KeyNotFoundException($"Categoria '{request.CategoryId}' não encontrada.");

        var name = request.Name.Trim();
        var storeId = tenant.StoreId;
        var duplicateProduct = await db.Products.AsNoTracking().AnyAsync(
            p => p.StoreId == storeId
                 && p.Id != request.Id
                 && p.CategoryId == request.CategoryId
                 && p.Name.ToLower() == name.ToLower(),
            ct);
        if (duplicateProduct)
            throw new InvalidOperationException($"Já existe um produto com o nome '{name}' nesta categoria.");

        var ingredientIds = NormalizeIngredientIds(request.IngredientIds);
        if (ingredientIds.Count > 0)
        {
            var existingCount = await db.Ingredients.CountAsync(i => i.StoreId == tenant.StoreId && ingredientIds.Contains(i.Id), ct);
            if (existingCount != ingredientIds.Count)
                throw new KeyNotFoundException("Um ou mais ingredientes selecionados não existem.");
        }

        var entity = await db.Products
            .Include(p => p.ProductIngredients)
            .FirstOrDefaultAsync(p => p.Id == request.Id && p.StoreId == tenant.StoreId, ct);

        // Ingredientes principais: lista explícita quando enviada; senão preserva os atuais
        // (ex.: toggle de disponibilidade não deve apagar as marcações de principal).
        var principalIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (request.PrincipalIngredientIds is not null)
        {
            foreach (var id in request.PrincipalIngredientIds)
                if (ingredientIds.Contains(id, StringComparer.OrdinalIgnoreCase))
                    principalIds.Add(id);
        }
        else if (entity is not null)
        {
            foreach (var pi in entity.ProductIngredients)
                if (pi.IsPrincipal)
                    principalIds.Add(pi.IngredientId);
        }

        if (entity is null)
        {
            var sort = request.SortOrder
                ?? (await db.Products
                    .Where(p => p.CategoryId == request.CategoryId && p.StoreId == tenant.StoreId)
                    .Select(p => (int?)p.SortOrder)
                    .MaxAsync(ct) ?? 0) + 1;
            entity = new ProductEntity
            {
                Id = request.Id,
                StoreId = tenant.StoreId,
                CategoryId = request.CategoryId,
                Name = name,
                Price = ResolveListPrice(request),
                PriceMedia = request.PriceMedia,
                PriceInteira = request.PriceInteira,
                Available = request.Available,
                ShowInMenu = request.ShowInMenu,
                ImageUrl = request.ImageUrl,
                Description = NullIfEmpty(request.Description),
                SortOrder = sort,
                ModifierGroupsJson = ModifierGroups.Serialize(request.ModifierGroups)
            };
            db.Products.Add(entity);
        }
        else
        {
            var categoryChanged = entity.CategoryId != request.CategoryId;
            entity.CategoryId = request.CategoryId;
            entity.Name = name;
            entity.Price = ResolveListPrice(request);
            entity.PriceMedia = request.PriceMedia;
            entity.PriceInteira = request.PriceInteira;
            entity.Available = request.Available;
            entity.ShowInMenu = request.ShowInMenu;
            entity.ImageUrl = request.ImageUrl;
            entity.Description = NullIfEmpty(request.Description);
            if (request.ModifierGroups is not null)
                entity.ModifierGroupsJson = ModifierGroups.Serialize(request.ModifierGroups);
            if (request.SortOrder is not null)
                entity.SortOrder = request.SortOrder.Value;
            else if (categoryChanged)
            {
                entity.SortOrder = (await db.Products
                    .Where(p => p.CategoryId == request.CategoryId && p.Id != entity.Id && p.StoreId == tenant.StoreId)
                    .Select(p => (int?)p.SortOrder)
                    .MaxAsync(ct) ?? 0) + 1;
            }
            entity.ProductIngredients.Clear();
        }

        for (var i = 0; i < ingredientIds.Count; i++)
        {
            entity.ProductIngredients.Add(new ProductIngredientEntity
            {
                ProductId = entity.Id,
                IngredientId = ingredientIds[i],
                SortOrder = i + 1,
                IsPrincipal = principalIds.Contains(ingredientIds[i])
            });
        }

        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task<string> AllocateNextProductIdAsync(CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var ids = await db.Products.AsNoTracking().Where(p => p.StoreId == storeId).Select(p => p.Id).ToListAsync(ct);
        return NextNumericId(ids);
    }

    public async Task<string> AllocateNextCategoryIdAsync(CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var ids = await db.Categories.AsNoTracking().Where(c => c.StoreId == storeId).Select(c => c.Id).ToListAsync(ct);
        return NextNumericId(ids);
    }

    public async Task<string> AllocateNextIngredientIdAsync(CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var ids = await db.Ingredients.AsNoTracking().Where(i => i.StoreId == storeId).Select(i => i.Id).ToListAsync(ct);
        return NextNumericId(ids);
    }

    internal static string NextNumericId(IEnumerable<string> ids)
    {
        var max = 0;
        foreach (var id in ids)
        {
            if (int.TryParse(id, out var n) && n > max)
                max = n;
        }
        return (max + 1).ToString();
    }

    /// <summary>Compatibilidade com chamadas existentes.</summary>
    internal static string NextNumericProductId(IEnumerable<string> ids) => NextNumericId(ids);

    public async Task DeleteProductAsync(string id, CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var entity = await db.Products.FirstOrDefaultAsync(p => p.Id == id && p.StoreId == storeId, ct);
        if (entity is null) return;
        db.Products.Remove(entity);
        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task MoveCategoryAsync(string id, string direction, CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var items = await db.Categories
            .Where(c => c.StoreId == storeId)
            .OrderBy(c => c.SortOrder)
            .ThenBy(c => c.Title)
            .ToListAsync(ct);
        if (!TrySwapAndRenumber(items, id, direction, c => c.Id, (c, order) => c.SortOrder = order))
            return;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task MoveProductAsync(string id, string direction, CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var product = await db.Products.AsNoTracking().FirstOrDefaultAsync(p => p.Id == id && p.StoreId == storeId, ct);
        if (product is null) return;

        var items = await db.Products
            .Where(p => p.CategoryId == product.CategoryId && p.StoreId == storeId)
            .OrderBy(p => p.SortOrder)
            .ThenBy(p => p.Name)
            .ToListAsync(ct);
        if (!TrySwapAndRenumber(items, id, direction, p => p.Id, (p, order) => p.SortOrder = order))
            return;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task MoveIngredientAsync(string id, string direction, CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var items = await db.Ingredients
            .Where(i => i.StoreId == storeId)
            .OrderBy(i => i.SortOrder)
            .ThenBy(i => i.Name)
            .ToListAsync(ct);
        if (!TrySwapAndRenumber(items, id, direction, i => i.Id, (i, order) => i.SortOrder = order))
            return;
        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task ReorderCategoriesAsync(IReadOnlyList<string> ids, CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var items = await db.Categories.Where(c => c.StoreId == storeId).ToListAsync(ct);
        ApplyReorder(items, ids, c => c.Id, (c, order) => c.SortOrder = order);
        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task ReorderProductsAsync(string categoryId, IReadOnlyList<string> ids, CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var items = await db.Products.Where(p => p.CategoryId == categoryId && p.StoreId == storeId).ToListAsync(ct);
        ApplyReorder(items, ids, p => p.Id, (p, order) => p.SortOrder = order);
        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    public async Task ReorderIngredientsAsync(IReadOnlyList<string> ids, CancellationToken ct = default)
    {
        var storeId = tenant.StoreId;
        var items = await db.Ingredients.Where(i => i.StoreId == storeId).ToListAsync(ct);
        ApplyReorder(items, ids, i => i.Id, (i, order) => i.SortOrder = order);
        await db.SaveChangesAsync(ct);
        InvalidateCache();
    }

    internal static void ApplyReorder<T>(
        List<T> items,
        IReadOnlyList<string> ids,
        Func<T, string> getId,
        Action<T, int> setSortOrder)
    {
        var byId = items.ToDictionary(getId, StringComparer.OrdinalIgnoreCase);
        if (ids.Count != items.Count || ids.Any(id => !byId.ContainsKey(id)))
            throw new InvalidOperationException("A lista de ordenação não corresponde aos itens atuais.");

        for (var i = 0; i < ids.Count; i++)
            setSortOrder(byId[ids[i]], i + 1);
    }

    internal static bool TrySwapAndRenumber<T>(
        List<T> ordered,
        string id,
        string direction,
        Func<T, string> getId,
        Action<T, int> setSortOrder)
    {
        var index = ordered.FindIndex(x => string.Equals(getId(x), id, StringComparison.OrdinalIgnoreCase));
        if (index < 0) return false;

        var dir = direction.Trim().ToLowerInvariant();
        var swapWith = dir switch
        {
            "up" => index - 1,
            "down" => index + 1,
            _ => -1
        };
        if (swapWith < 0 || swapWith >= ordered.Count) return false;

        (ordered[index], ordered[swapWith]) = (ordered[swapWith], ordered[index]);
        for (var i = 0; i < ordered.Count; i++)
            setSortOrder(ordered[i], i + 1);
        return true;
    }

    private static ProductDto MapProduct(ProductEntity p)
    {
        var ingredients = p.ProductIngredients
            .Where(pi => pi.Ingredient is not null)
            .OrderBy(pi => pi.SortOrder)
            .ThenBy(pi => pi.Ingredient!.SortOrder)
            .ThenBy(pi => pi.Ingredient!.Name)
            .Select(pi => new IngredientDto(pi.Ingredient!.Id, pi.Ingredient.Name, pi.SortOrder, pi.Ingredient.CategoryId, pi.Ingredient.Available, pi.IsPrincipal))
            .ToList();

return new ProductDto(
            p.Id,
            p.Name,
            p.Price,
            p.Available,
            p.ImageUrl,
            NullIfEmpty(p.Description),
            ingredients,
            p.SortOrder,
            p.PriceMedia,
            p.PriceInteira,
            p.ShowInMenu,
            ModifierGroups.Deserialize(p.ModifierGroupsJson));
    }

    private static decimal ResolveListPrice(UpsertProductRequest request)
    {
        if (request.PriceMedia is not null && request.PriceInteira is not null)
            return Math.Min(request.PriceMedia.Value, request.PriceInteira.Value);
        return request.Price;
    }

    private static List<string> NormalizeIngredientIds(List<string>? ids)
    {
        if (ids is null || ids.Count == 0) return [];
        var result = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in ids)
        {
            if (string.IsNullOrWhiteSpace(raw)) continue;
            var id = raw.Trim();
            if (seen.Add(id))
                result.Add(id);
        }
        return result;
    }

    private static StoreDto MapStore(Loja entity)
    {
        var schedule = ScheduleNormalizer.EnsurePerDay(
            JsonSerializer.Deserialize<ScheduleDto>(entity.ScheduleJson, JsonOptions)
            ?? new ScheduleDto([1, 2, 3, 4, 5, 6], "18:00", "23:55", "Fechado."));
        var fees = JsonSerializer.Deserialize<Dictionary<string, decimal>>(entity.DeliveryFeesJson, JsonOptions)
            ?? new Dictionary<string, decimal>();

        var breadOptions = string.IsNullOrWhiteSpace(entity.BreadOptionsJson)
            ? null
            : JsonSerializer.Deserialize<List<BreadOptionDto>>(entity.BreadOptionsJson, JsonOptions);

        return new StoreDto(
            entity.StoreName,
            entity.LogoUrl,
            entity.Whatsapp,
            entity.PixKey,
            entity.PixKeyLabel,
            entity.MinOrder,
            entity.CurrencyLocale,
            schedule,
            fees,
            entity.Address,
            entity.Cep,
            entity.Latitude,
            entity.Longitude,
            entity.DeliveryFeePerKm,
            entity.MaxDeliveryKm,
            entity.MinDeliveryFee,
            entity.AverageDeliveryMinutes,
            StoreBreadOptions.Normalize(breadOptions),
            entity.AcceptingOrders,
            entity.AddressNumber,
            entity.IconUrl,
            entity.ExtendedCloseUntilUtc,
            entity.City,
            entity.State,
            true,
            entity.AutoAdvancePreparing,
            entity.AutoAdvancePreparingMinutes,
            entity.DineInEnabled,
            entity.CustomerQrOrdersEnabled,
            entity.WaiterOrdersEnabled,
            entity.AllowManualTableEntry,
            entity.RequireCustomerNameForQrOrder,
            entity.AllowCustomerChooseWaiter,
            entity.TableCount,
            entity.WaiterSessionHours,
            entity.Slug,
            entity.CorPrimaria,
            entity.CorSecundaria,
            entity.CorFundo,
            entity.CorTexto,
            entity.TipoCard,
            entity.LayoutCardapio,
            entity.EstiloBotao,
            entity.BannerUrl,
            entity.CoverUrl);
    }

    private static string? NormalizeCategoryId(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static string? NullIfEmpty(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim();
}
