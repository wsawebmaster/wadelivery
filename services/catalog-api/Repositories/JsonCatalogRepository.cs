using System.Text.Json;
using Catalog.Api;
using Catalog.Api.Models;
using Microsoft.Extensions.Caching.Memory;

namespace Catalog.Api.Repositories;

public class JsonCatalogRepository : ICatalogRepository
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    private readonly string _productsPath;
    private readonly string _storePath;
    private readonly string _ingredientsPath;
    private readonly IMemoryCache _cache;
    private readonly ILogger<JsonCatalogRepository> _logger;
    private readonly SemaphoreSlim _gate = new(1, 1);

    private const string StoreCacheKey = "store";
    private const string CatalogCacheKey = "catalog";
    private const string IngredientsCacheKey = "ingredients";

    public JsonCatalogRepository(
        IConfiguration config,
        IHostEnvironment env,
        IMemoryCache cache,
        ILogger<JsonCatalogRepository> logger)
    {
        var configuredRoot = config["Data:Root"];
        string dataRoot;
        if (!string.IsNullOrWhiteSpace(configuredRoot))
        {
            dataRoot = Path.IsPathRooted(configuredRoot)
                ? configuredRoot
                : Path.GetFullPath(Path.Combine(env.ContentRootPath, configuredRoot));
        }
        else
        {
            var candidates = new[]
            {
                Path.GetFullPath(Path.Combine(env.ContentRootPath, "..", "..", "data")),
                Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "data")),
                Path.GetFullPath(Path.Combine(env.ContentRootPath, "data"))
            };
            dataRoot = candidates.FirstOrDefault(Directory.Exists) ?? candidates[0];
        }

        _productsPath = ResolvePath(config["Data:ProductsPath"], dataRoot, "products.json", env.ContentRootPath);
        _storePath = ResolvePath(config["Data:StorePath"], dataRoot, "store-config.json", env.ContentRootPath);
        _ingredientsPath = ResolvePath(config["Data:IngredientsPath"], dataRoot, "ingredients.json", env.ContentRootPath);
        _cache = cache;
        _logger = logger;
        _logger.LogInformation("JSON data root={Root} store={Store} products={Products}", dataRoot, _storePath, _productsPath);
    }

    private static string ResolvePath(string? configured, string dataRoot, string fileName, string contentRoot)
    {
        if (string.IsNullOrWhiteSpace(configured))
            return Path.Combine(dataRoot, fileName);
        return Path.IsPathRooted(configured)
            ? configured
            : Path.GetFullPath(Path.Combine(contentRoot, configured));
    }

    public void InvalidateCache()
    {
        _cache.Remove(StoreCacheKey);
        _cache.Remove(CatalogCacheKey);
        _cache.Remove(IngredientsCacheKey);
        // A lista de lojas da plataforma embute o store config da loja em execução (PlatformStoreSync).
        _cache.Remove(CatalogCacheKeys.PlatformStores);
    }

    public async Task<StoreDto> GetStoreAsync(CancellationToken ct = default)
    {
        if (_cache.TryGetValue(StoreCacheKey, out StoreDto? cached) && cached is not null)
            return cached;

        await _gate.WaitAsync(ct);
        try
        {
            if (_cache.TryGetValue(StoreCacheKey, out cached) && cached is not null)
                return cached;

            await using var stream = File.OpenRead(_storePath);
            var store = await JsonSerializer.DeserializeAsync<StoreDto>(stream, JsonOptions, ct)
                ?? throw new InvalidOperationException("store-config.json inválido.");
            store = store with
            {
                BreadOptions = StoreBreadOptions.Normalize(store.BreadOptions),
                Schedule = ScheduleNormalizer.EnsurePerDay(store.Schedule)
            };
            _cache.Set(StoreCacheKey, store, TimeSpan.FromMinutes(5));
            return store;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<CatalogDto> GetCatalogAsync(CancellationToken ct = default)
    {
        if (_cache.TryGetValue(CatalogCacheKey, out CatalogDto? cached) && cached is not null)
            return cached;

        await _gate.WaitAsync(ct);
        try
        {
            if (_cache.TryGetValue(CatalogCacheKey, out cached) && cached is not null)
                return cached;

            var catalog = await ReadCatalogUnlockedAsync(ct);
            var ingredients = await ReadIngredientsUnlockedAsync(ct);
            catalog = HydrateCatalogIngredients(catalog, ingredients);
            catalog = catalog with
            {
                Categories = catalog.Categories
                    .OrderBy(c => c.SortOrder)
                    .ThenBy(c => c.Title)
                    .Select(c => c with
                    {
                        Items = c.Items
                            .OrderBy(p => p.SortOrder)
                            .ThenBy(p => p.Name)
                            .ToList()
                    })
                    .ToList()
            };
            _cache.Set(CatalogCacheKey, catalog, TimeSpan.FromMinutes(5));
            return catalog;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<IReadOnlyList<IngredientDto>> GetIngredientsAsync(CancellationToken ct = default)
    {
        if (_cache.TryGetValue(IngredientsCacheKey, out IReadOnlyList<IngredientDto>? cached) && cached is not null)
            return cached;

        await _gate.WaitAsync(ct);
        try
        {
            if (_cache.TryGetValue(IngredientsCacheKey, out cached) && cached is not null)
                return cached;

            var list = await ReadIngredientsUnlockedAsync(ct);
            _cache.Set(IngredientsCacheKey, (IReadOnlyList<IngredientDto>)list, TimeSpan.FromMinutes(5));
            return list;
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task UpdateStoreAsync(PatchStoreRequest request, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var current = await ReadStoreUnlockedAsync(ct);
            var updated = current with
            {
                StoreName = request.StoreName ?? current.StoreName,
                LogoUrl = request.LogoUrl ?? current.LogoUrl,
                Whatsapp = request.Whatsapp ?? current.Whatsapp,
                PixKey = request.PixKey ?? current.PixKey,
                PixKeyLabel = request.PixKeyLabel ?? current.PixKeyLabel,
                MinOrder = request.MinOrder ?? current.MinOrder,
                Schedule = request.Schedule ?? current.Schedule,
                DeliveryFees = request.DeliveryFees ?? current.DeliveryFees,
                Address = request.Address ?? current.Address,
                Cep = request.Cep ?? current.Cep,
                City = request.City ?? current.City,
                State = request.State is null
                    ? current.State
                    : (string.IsNullOrWhiteSpace(request.State) ? null : request.State.Trim().ToUpperInvariant()),
                Latitude = request.Latitude ?? current.Latitude,
                Longitude = request.Longitude ?? current.Longitude,
                DeliveryFeePerKm = request.DeliveryFeePerKm ?? current.DeliveryFeePerKm,
                MaxDeliveryKm = request.MaxDeliveryKm ?? current.MaxDeliveryKm,
                MinDeliveryFee = request.MinDeliveryFee ?? current.MinDeliveryFee,
                AverageDeliveryMinutes = request.AverageDeliveryMinutes ?? current.AverageDeliveryMinutes,
                BreadOptions = request.BreadOptions is not null
                    ? StoreBreadOptions.Normalize(request.BreadOptions)
                    : current.BreadOptions,
                AcceptingOrders = request.AcceptingOrders ?? current.AcceptingOrders,
                AddressNumber = request.AddressNumber ?? current.AddressNumber,
                IconUrl = request.IconUrl ?? current.IconUrl,
                ExtendedCloseUntilUtc = request.ClearExtendedCloseUntil == true
                    ? null
                    : (request.ExtendedCloseUntilUtc ?? current.ExtendedCloseUntilUtc),
                AutoAdvancePreparing = request.AutoAdvancePreparing ?? current.AutoAdvancePreparing,
                AutoAdvancePreparingMinutes = request.AutoAdvancePreparingMinutes ?? current.AutoAdvancePreparingMinutes,
                DineInEnabled = request.DineInEnabled ?? current.DineInEnabled,
                CustomerQrOrdersEnabled = request.CustomerQrOrdersEnabled ?? current.CustomerQrOrdersEnabled,
                WaiterOrdersEnabled = request.WaiterOrdersEnabled ?? current.WaiterOrdersEnabled,
                AllowManualTableEntry = request.AllowManualTableEntry ?? current.AllowManualTableEntry,
                RequireCustomerNameForQrOrder = request.RequireCustomerNameForQrOrder ?? current.RequireCustomerNameForQrOrder,
                AllowCustomerChooseWaiter = request.AllowCustomerChooseWaiter ?? current.AllowCustomerChooseWaiter,
                TableCount = request.TableCount ?? current.TableCount,
                WaiterSessionHours = request.WaiterSessionHours is not null
                    ? Math.Clamp(request.WaiterSessionHours.Value, 1, 24)
                    : current.WaiterSessionHours,
                Slug = request.Slug is null
                    ? current.Slug
                    : CatalogInputValidation.NormalizeTenantSlug(request.Slug)
            };
            await WriteJsonAsync(_storePath, updated, ct);
            InvalidateCache();
            _logger.LogInformation("Store config atualizado via JSON");
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task UpsertCategoryAsync(UpsertCategoryRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Id))
            throw new ArgumentException("Id da categoria é obrigatório no upsert.");

        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var list = catalog.Categories.ToList();
            var title = request.Title.Trim();
            if (list.Any(c =>
                    !string.Equals(c.Id, request.Id, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(c.Title.Trim(), title, StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException($"Já existe uma categoria com o nome '{title}'.");
            }

            var showInMenu = CatalogInputValidation.ResolveCategoryShowInMenu(request.Id!, title, request.ShowInMenu);
            var idx = list.FindIndex(c => c.Id == request.Id);
            if (idx >= 0)
            {
                var sort = request.SortOrder ?? list[idx].SortOrder;
                list[idx] = list[idx] with { Title = title, SortOrder = sort, ShowInMenu = showInMenu };
            }
            else
            {
                var sort = request.SortOrder ?? (list.Count == 0 ? 1 : list.Max(c => c.SortOrder) + 1);
                list.Add(new CategoryDto(request.Id!, title, sort, [], showInMenu));
            }

            await WriteJsonAsync(_productsPath, new CatalogDto(list), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task DeleteCategoryAsync(string id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var category = catalog.Categories.FirstOrDefault(c => c.Id == id);
            if (category is null) return;
            if (category.Items.Count > 0)
            {
                throw new InvalidOperationException(
                    $"Não é possível excluir a categoria '{category.Title}': existem {category.Items.Count} produto(s) vinculados. Remova ou mova os produtos antes.");
            }

            var list = catalog.Categories.Where(c => c.Id != id).ToList();
            await WriteJsonAsync(_productsPath, new CatalogDto(list), ct);

            // Desvincula ingredientes que apontam para esta categoria (ficam "Sem categoria").
            var ings = (await ReadIngredientsUnlockedAsync(ct)).ToList();
            var changed = false;
            for (var i = 0; i < ings.Count; i++)
            {
                if (string.Equals(ings[i].CategoryId, id, StringComparison.OrdinalIgnoreCase))
                {
                    ings[i] = ings[i] with { CategoryId = null };
                    changed = true;
                }
            }
            if (changed)
                await WriteJsonAsync(_ingredientsPath, ings, ct);

            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task UpsertIngredientAsync(UpsertIngredientRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Id))
            throw new ArgumentException("Id do ingrediente é obrigatório no upsert.");

        await _gate.WaitAsync(ct);
        try
        {
            var list = (await ReadIngredientsUnlockedAsync(ct)).ToList();
            var name = request.Name.Trim();
            if (list.Any(i =>
                    !string.Equals(i.Id, request.Id, StringComparison.OrdinalIgnoreCase)
                    && string.Equals(i.Name.Trim(), name, StringComparison.OrdinalIgnoreCase)))
            {
                throw new InvalidOperationException($"Já existe um ingrediente com o nome '{name}'.");
            }

            var idx = list.FindIndex(i => i.Id == request.Id);
            int sort;
            if (idx >= 0)
                sort = request.SortOrder ?? list[idx].SortOrder;
            else
                sort = request.SortOrder ?? (list.Count == 0 ? 1 : list.Max(i => i.SortOrder) + 1);
            var ingredient = new IngredientDto(
                request.Id!,
                name,
                sort,
                string.IsNullOrWhiteSpace(request.CategoryId) ? null : request.CategoryId.Trim(),
                request.Available);
            if (idx >= 0) list[idx] = ingredient;
            else list.Add(ingredient);

            await WriteJsonAsync(_ingredientsPath, list, ct);

            // Mantém nomes sincronizados nos produtos
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var categories = catalog.Categories.Select(c => c with
            {
                Items = c.Items.Select(p =>
                {
                    if (p.Ingredients is null || p.Ingredients.Count == 0) return p;
                    var updated = p.Ingredients
                        .Select(i => i.Id == request.Id ? ingredient : i)
                        .ToList();
                    return p with { Ingredients = updated };
                }).ToList()
            }).ToList();
            await WriteJsonAsync(_productsPath, new CatalogDto(categories), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task DeleteIngredientAsync(string id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var linkedCount = catalog.Categories
                .SelectMany(c => c.Items)
                .Count(p => (p.Ingredients ?? []).Any(i =>
                    string.Equals(i.Id, id, StringComparison.OrdinalIgnoreCase)));
            if (linkedCount > 0)
            {
                var name = (await ReadIngredientsUnlockedAsync(ct))
                    .FirstOrDefault(i => i.Id == id)?.Name ?? id;
                throw new InvalidOperationException(
                    $"Não é possível excluir o ingrediente '{name}': existem {linkedCount} produto(s) vinculados. Remova o vínculo nos produtos antes.");
            }

            var list = (await ReadIngredientsUnlockedAsync(ct)).Where(i => i.Id != id).ToList();
            await WriteJsonAsync(_ingredientsPath, list, ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task UpsertProductAsync(UpsertProductRequest request, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(request.Id))
            throw new ArgumentException("Id do produto é obrigatório no upsert.");

        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var categories = catalog.Categories.ToList();
            var catIdx = categories.FindIndex(c => c.Id == request.CategoryId);
            if (catIdx < 0)
                throw new KeyNotFoundException($"Categoria '{request.CategoryId}' não encontrada.");

            var master = await ReadIngredientsUnlockedAsync(ct);
            var byId = master.ToDictionary(i => i.Id, StringComparer.OrdinalIgnoreCase);
            var ingredientIds = new List<string>();
            var seenIng = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var raw in request.IngredientIds ?? [])
            {
                if (string.IsNullOrWhiteSpace(raw)) continue;
                var id = raw.Trim();
                if (seenIng.Add(id))
                    ingredientIds.Add(id);
            }
            if (ingredientIds.Any(id => !byId.ContainsKey(id)))
                throw new KeyNotFoundException("Um ou mais ingredientes selecionados não existem.");

            // Ordem do array = ordem no produto
            var ingredients = ingredientIds
                .Select((id, index) => byId[id] with { SortOrder = index + 1 })
                .ToList();

            ProductDto? existing = null;
            string? previousCategoryId = null;
            foreach (var c in categories)
            {
                var found = c.Items.FirstOrDefault(p => p.Id == request.Id);
                if (found is null) continue;
                existing = found;
                previousCategoryId = c.Id;
                break;
            }

            // Ingredientes principais: lista explícita quando enviada; senão preserva os atuais
            var principalIds = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (request.PrincipalIngredientIds is not null)
            {
                foreach (var id in request.PrincipalIngredientIds)
                    if (ingredientIds.Contains(id, StringComparer.OrdinalIgnoreCase))
                        principalIds.Add(id);
            }
            else if (existing is not null)
            {
                foreach (var ing in existing.Ingredients ?? [])
                    if (ing.IsPrincipal)
                        principalIds.Add(ing.Id);
            }

            ingredients = ingredients
                .Select((ing, index) => ing with { SortOrder = index + 1, IsPrincipal = principalIds.Contains(ing.Id) })
                .ToList();

            for (var i = 0; i < categories.Count; i++)
            {
                categories[i] = categories[i] with
                {
                    Items = categories[i].Items.Where(p => p.Id != request.Id).ToList()
                };
            }

            catIdx = categories.FindIndex(c => c.Id == request.CategoryId);
            var items = categories[catIdx].Items.ToList();
            var name = request.Name.Trim();
            if (items.Any(p => string.Equals(p.Name.Trim(), name, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException($"Já existe um produto com o nome '{name}' nesta categoria.");

            int sort;
            if (request.SortOrder is not null)
                sort = request.SortOrder.Value;
            else if (existing is not null && previousCategoryId == request.CategoryId)
                sort = existing.SortOrder;
            else
                sort = items.Count == 0 ? 1 : items.Max(p => p.SortOrder) + 1;

            var description = string.IsNullOrWhiteSpace(request.Description) ? null : request.Description.Trim();
            var listPrice = request.PriceMedia is not null && request.PriceInteira is not null
                ? Math.Min(request.PriceMedia.Value, request.PriceInteira.Value)
                : request.Price;
            var product = new ProductDto(
                request.Id!,
                name,
                listPrice,
                request.Available,
                request.ImageUrl,
                description,
                ingredients,
                sort,
                request.PriceMedia,
                request.PriceInteira,
                request.ShowInMenu,
                ModifierGroups.Normalize(request.ModifierGroups ?? existing?.ModifierGroups));

            items.Add(product);
            categories[catIdx] = categories[catIdx] with { Items = items };

            await WriteJsonAsync(_productsPath, new CatalogDto(categories), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task DeleteProductAsync(string id, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var categories = catalog.Categories
                .Select(c => c with { Items = c.Items.Where(p => p.Id != id).ToList() })
                .ToList();
            await WriteJsonAsync(_productsPath, new CatalogDto(categories), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task MoveCategoryAsync(string id, string direction, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var list = catalog.Categories
                .OrderBy(c => c.SortOrder)
                .ThenBy(c => c.Title)
                .ToList();
            var index = list.FindIndex(c => string.Equals(c.Id, id, StringComparison.OrdinalIgnoreCase));
            if (index < 0)
                return;
            var dir = direction.Trim().ToLowerInvariant();
            var swapWith = dir == "up" ? index - 1 : dir == "down" ? index + 1 : -1;
            if (swapWith < 0 || swapWith >= list.Count)
                return;
            (list[index], list[swapWith]) = (list[swapWith], list[index]);
            for (var i = 0; i < list.Count; i++)
                list[i] = list[i] with { SortOrder = i + 1 };

            await WriteJsonAsync(_productsPath, new CatalogDto(list), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task MoveProductAsync(string id, string direction, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var categories = catalog.Categories.ToList();
            var catIdx = categories.FindIndex(c => c.Items.Any(p => p.Id == id));
            if (catIdx < 0) return;

            var items = categories[catIdx].Items
                .OrderBy(p => p.SortOrder)
                .ThenBy(p => p.Name)
                .ToList();
            var index = items.FindIndex(p => string.Equals(p.Id, id, StringComparison.OrdinalIgnoreCase));
            if (index < 0) return;
            var dir = direction.Trim().ToLowerInvariant();
            var swapWith = dir == "up" ? index - 1 : dir == "down" ? index + 1 : -1;
            if (swapWith < 0 || swapWith >= items.Count) return;
            (items[index], items[swapWith]) = (items[swapWith], items[index]);
            for (var i = 0; i < items.Count; i++)
                items[i] = items[i] with { SortOrder = i + 1 };

            categories[catIdx] = categories[catIdx] with { Items = items };
            await WriteJsonAsync(_productsPath, new CatalogDto(categories), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task MoveIngredientAsync(string id, string direction, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = (await ReadIngredientsUnlockedAsync(ct))
                .OrderBy(i => i.SortOrder)
                .ThenBy(i => i.Name)
                .ToList();
            var index = list.FindIndex(i => string.Equals(i.Id, id, StringComparison.OrdinalIgnoreCase));
            if (index < 0) return;
            var dir = direction.Trim().ToLowerInvariant();
            var swapWith = dir == "up" ? index - 1 : dir == "down" ? index + 1 : -1;
            if (swapWith < 0 || swapWith >= list.Count) return;
            (list[index], list[swapWith]) = (list[swapWith], list[index]);
            for (var i = 0; i < list.Count; i++)
                list[i] = list[i] with { SortOrder = i + 1 };

            await WriteJsonAsync(_ingredientsPath, list, ct);

            var byId = list.ToDictionary(i => i.Id, StringComparer.OrdinalIgnoreCase);
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var categories = catalog.Categories.Select(c => c with
            {
                Items = c.Items.Select(p =>
                {
                    if (p.Ingredients is null || p.Ingredients.Count == 0) return p;
                    var updated = p.Ingredients
                        .Select(i => byId.TryGetValue(i.Id, out var m) ? m : i)
                        .OrderBy(i => i.SortOrder)
                        .ThenBy(i => i.Name)
                        .ToList();
                    return p with { Ingredients = updated };
                }).ToList()
            }).ToList();
            await WriteJsonAsync(_productsPath, new CatalogDto(categories), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task ReorderCategoriesAsync(IReadOnlyList<string> ids, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var byId = catalog.Categories.ToDictionary(c => c.Id, StringComparer.OrdinalIgnoreCase);
            if (ids.Count != byId.Count || ids.Any(id => !byId.ContainsKey(id)))
                throw new InvalidOperationException("A lista de ordenação não corresponde às categorias atuais.");

            var reordered = ids.Select((id, i) => byId[id] with { SortOrder = i + 1 }).ToList();
            await WriteJsonAsync(_productsPath, new CatalogDto(reordered), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task ReorderProductsAsync(string categoryId, IReadOnlyList<string> ids, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var categories = catalog.Categories.ToList();
            var catIdx = categories.FindIndex(c => c.Id == categoryId);
            if (catIdx < 0)
                throw new KeyNotFoundException($"Categoria '{categoryId}' não encontrada.");

            var byId = categories[catIdx].Items.ToDictionary(p => p.Id, StringComparer.OrdinalIgnoreCase);
            if (ids.Count != byId.Count || ids.Any(id => !byId.ContainsKey(id)))
                throw new InvalidOperationException("A lista de ordenação não corresponde aos produtos da categoria.");

            var reordered = ids.Select((id, i) => byId[id] with { SortOrder = i + 1 }).ToList();
            categories[catIdx] = categories[catIdx] with { Items = reordered };
            await WriteJsonAsync(_productsPath, new CatalogDto(categories), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task ReorderIngredientsAsync(IReadOnlyList<string> ids, CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadIngredientsUnlockedAsync(ct);
            var byId = list.ToDictionary(i => i.Id, StringComparer.OrdinalIgnoreCase);
            if (ids.Count != byId.Count || ids.Any(id => !byId.ContainsKey(id)))
                throw new InvalidOperationException("A lista de ordenação não corresponde aos ingredientes atuais.");

            var reordered = ids.Select((id, i) => byId[id] with { SortOrder = i + 1 }).ToList();
            await WriteJsonAsync(_ingredientsPath, reordered, ct);

            byId = reordered.ToDictionary(i => i.Id, StringComparer.OrdinalIgnoreCase);
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var categories = catalog.Categories.Select(c => c with
            {
                Items = c.Items.Select(p =>
                {
                    if (p.Ingredients is null || p.Ingredients.Count == 0) return p;
                    return p with
                    {
                        Ingredients = p.Ingredients
                            .Where(i => byId.ContainsKey(i.Id))
                            .Select(i => byId[i.Id])
                            .OrderBy(i => i.SortOrder)
                            .ThenBy(i => i.Name)
                            .ToList()
                    };
                }).ToList()
            }).ToList();
            await WriteJsonAsync(_productsPath, new CatalogDto(categories), ct);
            InvalidateCache();
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<string> AllocateNextProductIdAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            var ids = catalog.Categories.SelectMany(c => c.Items.Select(p => p.Id));
            return EfCatalogRepository.NextNumericId(ids);
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<string> AllocateNextCategoryIdAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var catalog = await ReadCatalogUnlockedAsync(ct);
            return EfCatalogRepository.NextNumericId(catalog.Categories.Select(c => c.Id));
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task<string> AllocateNextIngredientIdAsync(CancellationToken ct = default)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var list = await ReadIngredientsUnlockedAsync(ct);
            return EfCatalogRepository.NextNumericId(list.Select(i => i.Id));
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<StoreDto> ReadStoreUnlockedAsync(CancellationToken ct)
    {
        await using var stream = File.OpenRead(_storePath);
        var store = await JsonSerializer.DeserializeAsync<StoreDto>(stream, JsonOptions, ct)
            ?? throw new InvalidOperationException("store-config.json inválido.");
        return store with
        {
            BreadOptions = StoreBreadOptions.Normalize(store.BreadOptions),
            Schedule = ScheduleNormalizer.EnsurePerDay(store.Schedule)
        };
    }

    private async Task<CatalogDto> ReadCatalogUnlockedAsync(CancellationToken ct)
    {
        await using var stream = File.OpenRead(_productsPath);
        return await JsonSerializer.DeserializeAsync<CatalogDto>(stream, JsonOptions, ct)
            ?? throw new InvalidOperationException("products.json inválido.");
    }

    private async Task<List<IngredientDto>> ReadIngredientsUnlockedAsync(CancellationToken ct)
    {
        if (!File.Exists(_ingredientsPath))
            return [];

        await using var stream = File.OpenRead(_ingredientsPath);
        var list = await JsonSerializer.DeserializeAsync<List<IngredientDto>>(stream, JsonOptions, ct)
            ?? [];
        return list
            .OrderBy(i => i.SortOrder)
            .ThenBy(i => i.Name)
            .ToList();
    }

    private static CatalogDto HydrateCatalogIngredients(CatalogDto catalog, List<IngredientDto> master)
    {
        var byId = master.ToDictionary(i => i.Id, StringComparer.OrdinalIgnoreCase);
        return catalog with
        {
            Categories = catalog.Categories.Select(c => c with
            {
                Items = c.Items.Select(p =>
                {
                    if (p.Ingredients is null || p.Ingredients.Count == 0)
                        return p with { Ingredients = [] };
                    var resolved = p.Ingredients
                        .Where(i => byId.ContainsKey(i.Id))
                        .Select(i => byId[i.Id] with { IsPrincipal = i.IsPrincipal })
                        .OrderBy(i => i.SortOrder)
                        .ThenBy(i => i.Name)
                        .ToList();
                    return p with { Ingredients = resolved };
                }).ToList()
            }).ToList()
        };
    }

    private static async Task WriteJsonAsync<T>(string path, T value, CancellationToken ct)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
            Directory.CreateDirectory(dir);

        await using var stream = File.Create(path);
        await JsonSerializer.SerializeAsync(stream, value, JsonOptions, ct);
    }
}
