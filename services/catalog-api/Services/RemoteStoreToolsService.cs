using System.Globalization;
using System.Text.Json;
using Catalog.Api.Models;
using Catalog.Api.Repositories;
using Npgsql;

namespace Catalog.Api.Services;

/// <summary>
/// Ferramentas de loja para o papel Dev (plataforma): comparar dados locais × remotos,
/// gerar backup versionado e sincronizar (baixar) o conteúdo remoto — cadastros e imagens —
/// para o ambiente local. Usa Npgsql direto (RLS desligado na transação) e HTTP para a
/// API remota (credenciais admin da loja em platform_stores; fallback para endpoints públicos).
/// Somente disponível com Persistence=PostgreSQL.
/// </summary>
public class RemoteStoreToolsService
{
    private const int BackupRetention = 5;
    private readonly string? _conn;
    private readonly IPlatformStoreRepository _platform;
    private readonly ICatalogRepository _catalog;
    private readonly StoreStatsService _storeStats;
    private readonly IHttpClientFactory _httpFactory;
    private readonly IConfiguration _config;
    private readonly IWebHostEnvironment _env;
    private readonly ILogger<RemoteStoreToolsService> _logger;
    private readonly string _uploadsRoot;
    private readonly string _dataRoot;

    public bool IsAvailable => !string.IsNullOrWhiteSpace(_conn);

    public RemoteStoreToolsService(
        string? conn,
        IPlatformStoreRepository platform,
        ICatalogRepository catalog,
        StoreStatsService storeStats,
        IHttpClientFactory httpFactory,
        IWebHostEnvironment env,
        IConfiguration config,
        ILogger<RemoteStoreToolsService> logger)
    {
        _conn = conn;
        _platform = platform;
        _catalog = catalog;
        _storeStats = storeStats;
        _httpFactory = httpFactory;
        _env = env;
        _config = config;
        _logger = logger;

        var configuredUploads = _config["Data:UploadsRoot"];
        _uploadsRoot = string.IsNullOrWhiteSpace(configuredUploads)
            ? Path.Combine(_env.ContentRootPath, "wwwroot", "uploads")
            : Path.GetFullPath(Path.IsPathRooted(configuredUploads)
                ? configuredUploads
                : Path.Combine(_env.ContentRootPath, configuredUploads));

        var configuredRoot = _config["Data:Root"];
        _dataRoot = string.IsNullOrWhiteSpace(configuredRoot)
            ? Path.GetFullPath(Path.Combine(_env.ContentRootPath, "..", "..", "data"))
            : Path.GetFullPath(Path.IsPathRooted(configuredRoot)
                ? configuredRoot
                : Path.Combine(_env.ContentRootPath, configuredRoot));
    }

    // ───────────────────────────── Internals ─────────────────────────────

    private static string Quote(string identifier) => "\"" + identifier + "\"";

    private async Task<T> WithBypassAsync<T>(
        Func<NpgsqlConnection, NpgsqlTransaction, CancellationToken, Task<T>> work,
        CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(_conn);
        await conn.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var setup = new NpgsqlCommand("SET LOCAL row_security = off", conn, tx))
        {
            await setup.ExecuteNonQueryAsync(ct);
        }
        var result = await work(conn, tx, ct);
        await tx.CommitAsync(ct);
        return result;
    }

    private async Task<PlatformStoreDto?> ResolveStoreAsync(int storeId, CancellationToken ct)
    {
        var list = await _platform.ListAsync(ct);
        return list.FirstOrDefault(x => x.StoreId == storeId);
    }

    private string RemoteBaseUrl(PlatformStoreDto? store)
    {
        var fromStore = store?.BackUrl;
        if (!string.IsNullOrWhiteSpace(fromStore))
            return fromStore.TrimEnd('/');
        var fallback = _config["Tools:RemoteBaseUrl"];
        return string.IsNullOrWhiteSpace(fallback) ? "" : fallback.TrimEnd('/');
    }

    // O campo Back da loja pode vir com ou sem "/api/v1"; normaliza para a raiz da API.
    private static string NormalizeApiBase(string baseUrl)
    {
        var b = (baseUrl ?? "").Trim().TrimEnd('/');
        if (b.EndsWith("/api/v1", StringComparison.OrdinalIgnoreCase))
            b = b[..^"/api/v1".Length].TrimEnd('/');
        return b;
    }

    private async Task<string?> LoginRemoteAsync(string baseUrl, string user, string pass, CancellationToken ct)
    {
        var root = NormalizeApiBase(baseUrl);
        using var client = _httpFactory.CreateClient("remote");
        var payload = JsonSerializer.Serialize(new { username = user, password = pass });
        using var content = new StringContent(payload, System.Text.Encoding.UTF8, "application/json");
        using var resp = await client.PostAsync($"{root}/api/v1/auth/login", content, ct);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"Login remoto falhou (HTTP {(int)resp.StatusCode}). Confira as credenciais do Back.");
        using var json = JsonDocument.Parse(await resp.Content.ReadAsStringAsync(ct));
        return json.RootElement.TryGetProperty("token", out var t) ? t.GetString() : null;
    }

    private async Task<JsonElement?> GetJsonAsync(
        string baseUrl,
        string? token,
        string path,
        bool admin,
        CancellationToken ct)
    {
        using var client = _httpFactory.CreateClient("remote");
        using var req = new HttpRequestMessage(HttpMethod.Get, $"{NormalizeApiBase(baseUrl)}{path}");
        if (admin && !string.IsNullOrWhiteSpace(token))
            req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"GET {path} remoto falhou (HTTP {(int)resp.StatusCode}).");
        var text = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(text);
        return doc.RootElement.Clone();
    }

    private async Task<JsonElement?> GetRemoteJsonAsync(
        string baseUrl,
        string? token,
        string adminPath,
        string publicPath,
        bool admin,
        CancellationToken ct)
    {
        var path = admin ? adminPath : publicPath;
        try
        {
            return await GetJsonAsync(baseUrl, token, path, admin, ct);
        }
        catch (InvalidOperationException) when (!admin)
        {
            throw;
        }
    }

    // ───────────────────────────── Snapshots ─────────────────────────────

    private sealed class SnapCategory
    {
        public string Id = ""; public string Title = ""; public int SortOrder; public bool ShowInMenu = true;
    }

    private sealed class SnapProduct
    {
        public string Id = ""; public string CategoryId = ""; public string Name = "";
        public decimal Price; public decimal? PriceMedia; public decimal? PriceInteira;
        public bool Available = true; public bool ShowInMenu = true;
        public string? ImageUrl; public string? Description; public int SortOrder;
        public List<string> IngredientIds = new();
        public List<string> PrincipalIngredientIds = new();
        public List<ModifierGroupDto> ModifierGroups = new();
    }

    private sealed class SnapIngredient
    {
        public string Id = ""; public string Name = ""; public int SortOrder; public string? CategoryId;
    }

    private sealed class SnapStore
    {
        public string? StoreName; public string? Whatsapp; public string? PixKey; public string? PixKeyLabel;
        public decimal MinOrder; public string? Address; public string? Cep; public string? City; public string? State;
        public bool AcceptingOrders = true; public decimal DeliveryFeePerKm; public decimal MaxDeliveryKm;
        public decimal MinDeliveryFee; public int AverageDeliveryMinutes = 40;
        public string? AddressNumber; public string? IconUrl;
    }

    private sealed class Snapshot
    {
        public string Source = "";
        public List<SnapCategory> Categories = new();
        public List<SnapProduct> Products = new();
        public List<SnapIngredient> Ingredients = new();
        public SnapStore? Store;
    }

    private async Task<Snapshot> BuildLocalSnapshotAsync(int storeId, CancellationToken ct)
    {
        return await WithBypassAsync(async (conn, tx, token) =>
        {
            var snap = new Snapshot { Source = "local" };

            await using (var cmd = new NpgsqlCommand(
                """SELECT "Id", "Title", "SortOrder", "ShowInMenu" FROM categories WHERE "StoreId" = @store ORDER BY "SortOrder", "Id" """, conn, tx))
            {
                cmd.Parameters.AddWithValue("store", storeId);
                await using var r = await cmd.ExecuteReaderAsync(token);
                while (await r.ReadAsync(token))
                    snap.Categories.Add(new SnapCategory
                    {
                        Id = r.GetString(0),
                        Title = r.GetString(1),
                        SortOrder = r.GetInt32(2),
                        ShowInMenu = r.GetBoolean(3)
                    });
            }

            await using (var cmd = new NpgsqlCommand(
                """SELECT "Id", "Name", "SortOrder", "CategoryId" FROM ingredients WHERE "StoreId" = @store ORDER BY "SortOrder", "Id" """, conn, tx))
            {
                cmd.Parameters.AddWithValue("store", storeId);
                await using var r = await cmd.ExecuteReaderAsync(token);
                while (await r.ReadAsync(token))
                    snap.Ingredients.Add(new SnapIngredient
                    {
                        Id = r.GetString(0),
                        Name = r.GetString(1),
                        SortOrder = r.GetInt32(2),
                        CategoryId = r.IsDBNull(3) ? null : r.GetString(3)
                    });
            }

            var ingredientIds = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            var principalIds = new Dictionary<string, List<string>>(StringComparer.Ordinal);
            await using (var cmd = new NpgsqlCommand(
                """
                SELECT pi."ProductId", pi."IngredientId", pi."IsPrincipal"
                FROM product_ingredients pi
                JOIN products p ON p."Id" = pi."ProductId"
                WHERE p."StoreId" = @store ORDER BY pi."SortOrder", pi."IngredientId"
                """, conn, tx))
            {
                cmd.Parameters.AddWithValue("store", storeId);
                await using var r = await cmd.ExecuteReaderAsync(token);
                while (await r.ReadAsync(token))
                {
                    var pid = r.GetString(0);
                    var iid = r.GetString(1);
                    var isPrincipal = r.GetBoolean(2);
                    if (!ingredientIds.TryGetValue(pid, out var list))
                        ingredientIds[pid] = list = new List<string>();
                    list.Add(iid);
                    if (isPrincipal)
                    {
                        if (!principalIds.TryGetValue(pid, out var plist))
                            principalIds[pid] = plist = new List<string>();
                        plist.Add(iid);
                    }
                }
            }

            await using (var cmd = new NpgsqlCommand(
                """
                SELECT "Id", "CategoryId", "Name", "Price", "PriceMedia", "PriceInteira",
                       "Available", "ShowInMenu", "ImageUrl", "Description", "SortOrder",
                       "ModifierGroupsJson"
                FROM products WHERE "StoreId" = @store ORDER BY "SortOrder", "Id"
                """, conn, tx))
            {
                cmd.Parameters.AddWithValue("store", storeId);
                await using var r = await cmd.ExecuteReaderAsync(token);
                while (await r.ReadAsync(token))
                {
                    var p = new SnapProduct
                    {
                        Id = r.GetString(0),
                        CategoryId = r.GetString(1),
                        Name = r.GetString(2),
                        Price = r.GetDecimal(3),
                        PriceMedia = r.IsDBNull(4) ? null : r.GetDecimal(4),
                        PriceInteira = r.IsDBNull(5) ? null : r.GetDecimal(5),
                        Available = r.GetBoolean(6),
                        ShowInMenu = r.GetBoolean(7),
                        ImageUrl = r.IsDBNull(8) ? null : r.GetString(8),
                        Description = r.IsDBNull(9) ? null : r.GetString(9),
                        SortOrder = r.GetInt32(10)
                    };
                    if (!r.IsDBNull(11) && ModifierGroups.Deserialize(r.GetString(11)) is { } mods)
                        p.ModifierGroups = mods;
                    if (ingredientIds.TryGetValue(p.Id, out var ids))
                        p.IngredientIds = ids;
                    if (principalIds.TryGetValue(p.Id, out var pids))
                        p.PrincipalIngredientIds = pids;
                    snap.Products.Add(p);
                }
            }

            await using (var cmd = new NpgsqlCommand(
                """
                SELECT "StoreName", "Whatsapp", "PixKey", "PixKeyLabel", "MinOrder",
                       "Address", "Cep", "City", "State", "AcceptingOrders",
                       "DeliveryFeePerKm", "MaxDeliveryKm", "MinDeliveryFee",
                       "AverageDeliveryMinutes", "AddressNumber", "IconUrl"
                FROM stores WHERE "Id" = @store
                """, conn, tx))
            {
                cmd.Parameters.AddWithValue("store", storeId);
                await using var r = await cmd.ExecuteReaderAsync(token);
                if (await r.ReadAsync(token))
                {
                    snap.Store = new SnapStore
                    {
                        StoreName = r.GetString(0),
                        Whatsapp = r.GetString(1),
                        PixKey = r.GetString(2),
                        PixKeyLabel = r.GetString(3),
                        MinOrder = r.GetDecimal(4),
                        Address = r.IsDBNull(5) ? null : r.GetString(5),
                        Cep = r.IsDBNull(6) ? null : r.GetString(6),
                        City = r.IsDBNull(7) ? null : r.GetString(7),
                        State = r.IsDBNull(8) ? null : r.GetString(8),
                        AcceptingOrders = r.GetBoolean(9),
                        DeliveryFeePerKm = r.GetDecimal(10),
                        MaxDeliveryKm = r.GetDecimal(11),
                        MinDeliveryFee = r.GetDecimal(12),
                        AverageDeliveryMinutes = r.GetInt32(13),
                        AddressNumber = r.IsDBNull(14) ? null : r.GetString(14),
                        IconUrl = r.IsDBNull(15) ? null : r.GetString(15)
                    };
                }
            }

            return snap;
        }, ct);
    }

    private static string Str(JsonElement e, string prop)
        => e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";
    private static string? NullStr(JsonElement e, string prop)
        => e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(v.GetString())
            ? v.GetString()
            : null;
    private static bool Bool(JsonElement e, string prop, bool dflt = true)
        => e.TryGetProperty(prop, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False
            ? v.GetBoolean()
            : dflt;
    private static decimal Dec(JsonElement e, string prop)
        => e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDecimal() : 0m;
    private static int Int(JsonElement e, string prop)
        => e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;

    private static List<ModifierGroupDto> ParseModifierGroups(JsonElement product)
    {
        if (!product.TryGetProperty("modifierGroups", out var groups) || groups.ValueKind != JsonValueKind.Array)
            return new List<ModifierGroupDto>();
        var result = new List<ModifierGroupDto>();
        foreach (var g in groups.EnumerateArray())
        {
            var options = new List<ModifierOptionDto>();
            if (g.TryGetProperty("options", out var opts) && opts.ValueKind == JsonValueKind.Array)
            {
                foreach (var o in opts.EnumerateArray())
                {
                    options.Add(new ModifierOptionDto(
                        Str(o, "id"),
                        Str(o, "name"),
                        Dec(o, "priceDelta"),
                        Int(o, "sortOrder"),
                        Bool(o, "available")));
                }
            }
            result.Add(new ModifierGroupDto(
                Str(g, "id"),
                Str(g, "name"),
                Int(g, "sortOrder"),
                Bool(g, "required"),
                Int(g, "min"),
                Int(g, "max"),
                options));
        }
        return result;
    }

    private async Task<Snapshot> BuildRemoteSnapshotAsync(
        string baseUrl,
        string? token,
        bool admin,
        CancellationToken ct)
    {
        var snap = new Snapshot { Source = admin ? "remote-admin" : "remote-public" };
        var ingredientsById = new Dictionary<string, SnapIngredient>(StringComparer.Ordinal);

        var catalog = admin
            ? await GetRemoteJsonAsync(baseUrl, token, "/api/v1/admin/catalog", "/api/v1/catalog", admin, ct)
            : await GetJsonAsync(baseUrl, null, "/api/v1/catalog", false, ct);

        if (catalog is not null && catalog.Value.TryGetProperty("categories", out var cats) && cats.ValueKind == JsonValueKind.Array)
        {
            foreach (var c in cats.EnumerateArray())
            {
                var cat = new SnapCategory
                {
                    Id = Str(c, "id"),
                    Title = Str(c, "title"),
                    SortOrder = Int(c, "sortOrder"),
                    ShowInMenu = Bool(c, "showInMenu")
                };
                snap.Categories.Add(cat);
                if (c.TryGetProperty("items", out var items) && items.ValueKind == JsonValueKind.Array)
                {
                    foreach (var p in items.EnumerateArray())
                    {
                        var product = new SnapProduct
                        {
                            Id = Str(p, "id"),
                            CategoryId = cat.Id,
                            Name = Str(p, "name"),
                            Price = Dec(p, "price"),
                            PriceMedia = p.TryGetProperty("priceMedia", out var pm) && pm.ValueKind == JsonValueKind.Number ? pm.GetDecimal() : null,
                            PriceInteira = p.TryGetProperty("priceInteira", out var pi) && pi.ValueKind == JsonValueKind.Number ? pi.GetDecimal() : null,
                            Available = Bool(p, "available"),
                            ShowInMenu = Bool(p, "showInMenu"),
                            ImageUrl = NullStr(p, "imageUrl"),
                            Description = NullStr(p, "description"),
                            SortOrder = Int(p, "sortOrder")
                        };
                        if (p.TryGetProperty("ingredients", out var ings) && ings.ValueKind == JsonValueKind.Array)
                        {
                            foreach (var ing in ings.EnumerateArray())
                            {
                                var id = Str(ing, "id");
                                if (string.IsNullOrWhiteSpace(id))
                                    continue;
                                product.IngredientIds.Add(id);
                                var ingredientName = Str(ing, "name");
                                if (!string.IsNullOrWhiteSpace(ingredientName) && !ingredientsById.ContainsKey(id))
                                {
                                    ingredientsById[id] = new SnapIngredient
                                    {
                                        Id = id,
                                        Name = ingredientName,
                                        CategoryId = NullStr(ing, "categoryId")
                                    };
                                }
                                if (Bool(ing, "isPrincipal"))
                                    product.PrincipalIngredientIds.Add(id);
                            }
                        }
                        product.ModifierGroups = ParseModifierGroups(p);
                        snap.Products.Add(product);
                    }
                }
            }
        }

        if (admin)
        {
            try
            {
                var ings = await GetJsonAsync(baseUrl, token, "/api/v1/admin/ingredients", true, ct);
                if (ings is not null && ings.Value.ValueKind == JsonValueKind.Array)
                {
                    foreach (var ing in ings.Value.EnumerateArray())
                    {
                        var id = Str(ing, "id");
                        var name = Str(ing, "name");
                        if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(name))
                            continue;
                        ingredientsById[id] = new SnapIngredient
                        {
                            Id = id,
                            Name = name,
                            SortOrder = Int(ing, "sortOrder"),
                            CategoryId = NullStr(ing, "categoryId")
                        };
                    }
                }
            }
            catch (InvalidOperationException ex)
            {
                _logger.LogWarning(ex, "Ingredientes remotos indisponíveis");
            }
        }

        snap.Ingredients.AddRange(ingredientsById.Values);

        try
        {
            var store = await GetJsonAsync(baseUrl, null, "/api/v1/store", false, ct);
            if (store is not null)
            {
                var s = store.Value;
                snap.Store = new SnapStore
                {
                    StoreName = NullStr(s, "storeName"),
                    Whatsapp = NullStr(s, "whatsapp"),
                    PixKey = NullStr(s, "pixKey"),
                    PixKeyLabel = NullStr(s, "pixKeyLabel"),
                    MinOrder = Dec(s, "minOrder"),
                    Address = NullStr(s, "address"),
                    Cep = NullStr(s, "cep"),
                    City = NullStr(s, "city"),
                    State = NullStr(s, "state"),
                    AcceptingOrders = Bool(s, "acceptingOrders"),
                    DeliveryFeePerKm = Dec(s, "deliveryFeePerKm"),
                    MaxDeliveryKm = Dec(s, "maxDeliveryKm"),
                    MinDeliveryFee = Dec(s, "minDeliveryFee"),
                    AverageDeliveryMinutes = Int(s, "averageDeliveryMinutes"),
                    AddressNumber = NullStr(s, "addressNumber"),
                    IconUrl = NullStr(s, "iconUrl")
                };
            }
        }
        catch (InvalidOperationException)
        {
            // config remota não é crítica
        }

        return snap;
    }

    // ───────────────────────────── Comparação ─────────────────────────────

    private static string ProductHash(SnapProduct p)
    {
        var ingredients = string.Join(",", p.IngredientIds.OrderBy(x => x, StringComparer.Ordinal));
        var principals = string.Join(",", p.PrincipalIngredientIds.OrderBy(x => x, StringComparer.Ordinal));
        return string.Join("|", new[]
        {
            p.CategoryId, p.Name, p.Price.ToString("R", CultureInfo.InvariantCulture),
            p.PriceMedia?.ToString("R", CultureInfo.InvariantCulture) ?? "",
            p.PriceInteira?.ToString("R", CultureInfo.InvariantCulture) ?? "",
            p.Available ? "1" : "0", p.ShowInMenu ? "1" : "0",
            p.ImageUrl ?? "", p.Description ?? "", p.SortOrder.ToString(CultureInfo.InvariantCulture),
            ingredients, principals, ModifierGroups.Serialize(p.ModifierGroups) ?? ""
        });
    }

    private static List<string> ProductChangedFields(SnapProduct a, SnapProduct b)
    {
        var fields = new List<string>();
        if (a.CategoryId != b.CategoryId) fields.Add("categoria");
        if (a.Name != b.Name) fields.Add("nome");
        if (a.Price != b.Price) fields.Add("preço");
        if (a.PriceMedia != b.PriceMedia) fields.Add("preço média");
        if (a.PriceInteira != b.PriceInteira) fields.Add("preço inteira");
        if (a.Available != b.Available) fields.Add("disponibilidade");
        if (a.ShowInMenu != b.ShowInMenu) fields.Add("exibir no cardápio");
        if ((a.ImageUrl ?? "") != (b.ImageUrl ?? "")) fields.Add("imagem");
        if ((a.Description ?? "") != (b.Description ?? "")) fields.Add("descrição");
        if (a.SortOrder != b.SortOrder) fields.Add("ordem");
        if (!a.IngredientIds.OrderBy(x => x, StringComparer.Ordinal)
                 .SequenceEqual(b.IngredientIds.OrderBy(x => x, StringComparer.Ordinal)))
            fields.Add("ingredientes");
        if (!a.PrincipalIngredientIds.OrderBy(x => x, StringComparer.Ordinal)
                 .SequenceEqual(b.PrincipalIngredientIds.OrderBy(x => x, StringComparer.Ordinal)))
            fields.Add("ingrediente principal");
        if ((ModifierGroups.Serialize(a.ModifierGroups) ?? "") != (ModifierGroups.Serialize(b.ModifierGroups) ?? ""))
            fields.Add("modificadores");
        return fields;
    }

    private static List<ToolsFieldDiffDto> StoreDiffs(SnapStore? a, SnapStore? b)
    {
        if (a is null && b is null) return [];
        if (a is null) return [new ToolsFieldDiffDto("config", null, "<remoto>")];
        if (b is null) return [new ToolsFieldDiffDto("config", "<local>", null)];

        string? F(string? v) => string.IsNullOrWhiteSpace(v) ? null : v.Trim();
        var diffs = new List<ToolsFieldDiffDto>();
        void Cmp(string field, string? l, string? r)
        {
            if (F(l) != F(r)) diffs.Add(new ToolsFieldDiffDto(field, F(l) ?? "(vazio)", F(r) ?? "(vazio)"));
        }

        Cmp("nome", a.StoreName, b.StoreName);
        Cmp("whatsapp", a.Whatsapp, b.Whatsapp);
        Cmp("chave Pix", a.PixKey, b.PixKey);
        Cmp("rótulo Pix", a.PixKeyLabel, b.PixKeyLabel);
        if (a.MinOrder != b.MinOrder) diffs.Add(new ToolsFieldDiffDto("pedido mínimo", a.MinOrder.ToString("C2", CultureInfo.InvariantCulture), b.MinOrder.ToString("C2", CultureInfo.InvariantCulture)));
        Cmp("endereço", a.Address, b.Address);
        Cmp("CEP", a.Cep, b.Cep);
        Cmp("cidade", a.City, b.City);
        Cmp("UF", a.State, b.State);
        if (a.AcceptingOrders != b.AcceptingOrders) diffs.Add(new ToolsFieldDiffDto("aceitando pedidos", a.AcceptingOrders ? "sim" : "não", b.AcceptingOrders ? "sim" : "não"));
        if (a.DeliveryFeePerKm != b.DeliveryFeePerKm) diffs.Add(new ToolsFieldDiffDto("taxa por km", a.DeliveryFeePerKm.ToString("C2", CultureInfo.InvariantCulture), b.DeliveryFeePerKm.ToString("C2", CultureInfo.InvariantCulture)));
        if (a.MaxDeliveryKm != b.MaxDeliveryKm) diffs.Add(new ToolsFieldDiffDto("km máximo", a.MaxDeliveryKm.ToString("C2", CultureInfo.InvariantCulture), b.MaxDeliveryKm.ToString("C2", CultureInfo.InvariantCulture)));
        if (a.MinDeliveryFee != b.MinDeliveryFee) diffs.Add(new ToolsFieldDiffDto("taxa mínima", a.MinDeliveryFee.ToString("C2", CultureInfo.InvariantCulture), b.MinDeliveryFee.ToString("C2", CultureInfo.InvariantCulture)));
        if (a.AverageDeliveryMinutes != b.AverageDeliveryMinutes) diffs.Add(new ToolsFieldDiffDto("prazo médio", a.AverageDeliveryMinutes.ToString(), b.AverageDeliveryMinutes.ToString()));
        Cmp("endereço nº", a.AddressNumber, b.AddressNumber);
        Cmp("ícone", a.IconUrl, b.IconUrl);
        return diffs;
    }

    private async Task<ToolsCompareReportDto> CompareAsyncCore(int storeId, Snapshot local, string baseUrl, string? token, bool admin, CancellationToken ct)
    {
        var warnings = new List<string>();
        if (!admin)
            warnings.Add("Sem credenciais remotas: comparando apenas o cardápio público (itens ocultos/indisponíveis e ingredientes não são considerados).");

        var remote = await BuildRemoteSnapshotAsync(baseUrl, token, admin, ct);

        var localCat = local.Categories.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var localProd = local.Products.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var localIng = local.Ingredients.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var remoteCat = remote.Categories.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var remoteProd = remote.Products.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var remoteIng = remote.Ingredients.ToDictionary(x => x.Id, StringComparer.Ordinal);

        var categoriesOnlyLocal = remoteCat.Count == 0
            ? localCat.Keys.ToList()
            : localCat.Keys.Where(k => !remoteCat.ContainsKey(k)).ToList();
        var categoriesOnlyRemote = remoteCat.Keys.Where(k => !localCat.ContainsKey(k)).ToList();
        var ingredientsOnlyLocal = localIng.Keys.Where(k => !remoteIng.ContainsKey(k)).ToList();
        var ingredientsOnlyRemote = remoteIng.Keys.Where(k => !localIng.ContainsKey(k)).ToList();

        var productsOnlyLocal = localProd.Keys.Where(k => !remoteProd.ContainsKey(k)).ToList();
        var productsOnlyRemote = remoteProd.Keys.Where(k => !localProd.ContainsKey(k)).ToList();

        var changed = new List<ToolsProductDiffDto>();
        var equal = 0;
        foreach (var (id, lp) in localProd)
        {
            if (!remoteProd.TryGetValue(id, out var rp)) continue;
            var fields = ProductChangedFields(lp, rp);
            if (fields.Count > 0)
                changed.Add(new ToolsProductDiffDto(id, lp.Name, fields));
            else
                equal++;
        }

        var imagesMissing = new List<string>();
        foreach (var p in remote.Products)
        {
            if (string.IsNullOrWhiteSpace(p.ImageUrl)) continue;
            if (!p.ImageUrl.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase)) continue;
            var relative = p.ImageUrl.TrimStart('/').Substring("uploads/".Length);
            var localFile = Path.GetFullPath(Path.Combine(_uploadsRoot, relative));
            if (!File.Exists(localFile))
                imagesMissing.Add($"{p.ImageUrl} ({p.Name})");
        }

        var storeDiffs = StoreDiffs(local.Store, remote.Store);

        return new ToolsCompareReportDto(
            admin ? "admin" : "public",
            baseUrl,
            warnings,
            localCat.Count, remoteCat.Count,
            localProd.Count, remoteProd.Count,
            localIng.Count, remoteIng.Count,
            equal,
            categoriesOnlyLocal, categoriesOnlyRemote,
            productsOnlyLocal, productsOnlyRemote,
            ingredientsOnlyLocal, ingredientsOnlyRemote,
            changed,
            imagesMissing,
            storeDiffs,
            storeDiffs.Count == 0,
            local.Store?.StoreName, remote.Store?.StoreName);
    }

    // ───────────────────────────── Filtro de seleção ─────────────────────────────

    private static Snapshot FilteredSnapshot(Snapshot source, SyncSelectionDto? selection)
    {
        if (selection is null)
            return source;

        var selCats = new HashSet<string>(selection.SyncCategories ?? [], StringComparer.Ordinal);
        var selProds = new HashSet<string>(selection.SyncProducts ?? [], StringComparer.Ordinal);
        var selIngs = new HashSet<string>(selection.SyncIngredients ?? [], StringComparer.Ordinal);
        var allCats = selCats.Count == 0;
        var allProds = selProds.Count == 0;
        var allIngs = selIngs.Count == 0;

        var result = new Snapshot { Source = source.Source };
        foreach (var c in source.Categories)
            if (allCats || selCats.Contains(c.Id))
                result.Categories.Add(c);
        foreach (var i in source.Ingredients)
            if (allIngs || selIngs.Contains(i.Id))
                result.Ingredients.Add(i);
        foreach (var p in source.Products)
            if ((allProds || selProds.Contains(p.Id)) && (allCats || selCats.Contains(p.CategoryId)))
                result.Products.Add(p);
        result.Store = source.Store;

        return result;
    }

    // ───────────────────────────── Preview de sincronização (download) ─────────────────────────────

    public async Task<ToolsSyncPreviewDto> SyncPreviewAsync(int storeId, SyncSelectionDto? selection, bool skipDelete, CancellationToken ct)
        => await WithStoreLockAsync(storeId, (token) => SyncPreviewCoreAsync(storeId, selection, skipDelete, token), ct);

    private async Task<ToolsSyncPreviewDto> SyncPreviewCoreAsync(int storeId, SyncSelectionDto? selection, bool skipDelete, CancellationToken ct)
    {
        var store = await ResolveStoreAsync(storeId, ct);
        var baseUrl = RemoteBaseUrl(store);
        if (string.IsNullOrWhiteSpace(baseUrl))
            throw new InvalidOperationException("Defina o Back (URL) da loja para baixar o conteúdo remoto.");

        var warnings = new List<string>();
        var admin = !string.IsNullOrWhiteSpace(store?.BackUsername) && !string.IsNullOrWhiteSpace(store?.BackPassword);
        string? token = null;
        if (admin)
        {
            try { token = await LoginRemoteAsync(baseUrl, store!.BackUsername!, store.BackPassword!, ct); }
            catch (Exception ex) { warnings.Add($"Login remoto falhou: {ex.Message}"); admin = false; }
        }
        if (!admin)
            warnings.Add("Sem credenciais remotas: comparando apenas o cardápio público (itens ocultos/indisponíveis e ingredientes não são considerados).");

        var remote = await BuildRemoteSnapshotAsync(baseUrl, token, admin, ct);
        var local = await BuildLocalSnapshotAsync(storeId, ct);
        return BuildSyncPlan(storeId, local, FilteredSnapshot(remote, selection), admin, baseUrl, warnings, skipDelete, selection, ct);
    }

    private sealed class SyncPlanBuilder
    {
        public int CatsCreate, CatsUpdate, CatsEqual, CatsDelete;
        public int IngsCreate, IngsUpdate, IngsEqual, IngsDelete;
        public int ProdsCreate, ProdsUpdate, ProdsEqual, ProdsDelete;
        public List<ToolsProductDiffDto> NewProducts = new();
        public List<ToolsProductDiffDto> UpdatedProducts = new();
        public List<string> ProdsOnlyLocal = new();
        public List<string> CatsOnlyLocal = new();
        public List<string> IngsOnlyLocal = new();
        public List<string> CatsOnlyRemote = new();
        public List<string> IngsOnlyRemote = new();
    }

    private ToolsSyncPreviewDto BuildSyncPlan(
        int storeId,
        Snapshot local,
        Snapshot remote,
        bool admin,
        string baseUrl,
        List<string> warnings,
        bool skipDelete,
        SyncSelectionDto? selection,
        CancellationToken ct)
    {
        var localCat = local.Categories.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var localProd = local.Products.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var localIng = local.Ingredients.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var remoteCat = remote.Categories.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var remoteProd = remote.Products.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var remoteIng = remote.Ingredients.ToDictionary(x => x.Id, StringComparer.Ordinal);

        var plan = new SyncPlanBuilder();

        foreach (var (id, rc) in remoteCat)
        {
            if (!localCat.TryGetValue(id, out var lc))
            {
                plan.CatsCreate++;
            }
            else if (lc.Title != rc.Title || lc.SortOrder != rc.SortOrder || lc.ShowInMenu != rc.ShowInMenu)
            {
                plan.CatsUpdate++;
            }
            else
            {
                plan.CatsEqual++;
            }
        }
        foreach (var (id, ri) in remoteIng)
        {
            if (!localIng.TryGetValue(id, out var li))
            {
                plan.IngsCreate++;
            }
            else if (li.Name != ri.Name || li.SortOrder != ri.SortOrder || li.CategoryId != ri.CategoryId)
            {
                plan.IngsUpdate++;
            }
            else
            {
                plan.IngsEqual++;
            }
        }
        foreach (var (id, rp) in remoteProd)
        {
            if (!localProd.TryGetValue(id, out var lp))
            {
                plan.ProdsCreate++;
                plan.NewProducts.Add(new ToolsProductDiffDto(id, rp.Name, new List<string> { "novo" }));
            }
            else
            {
                var fields = ProductChangedFields(lp, rp);
                if (fields.Count > 0)
                {
                    plan.ProdsUpdate++;
                    plan.UpdatedProducts.Add(new ToolsProductDiffDto(id, rp.Name, fields));
                }
                else
                {
                    plan.ProdsEqual++;
                }
            }
        }

        if (!skipDelete)
        {
            plan.CatsOnlyLocal = localCat.Keys.Where(k => !remoteCat.ContainsKey(k)).ToList();
            plan.IngsOnlyLocal = localIng.Keys.Where(k => !remoteIng.ContainsKey(k)).ToList();
            plan.ProdsOnlyLocal = localProd.Keys.Where(k => !remoteProd.ContainsKey(k)).ToList();
            plan.CatsDelete = plan.CatsOnlyLocal.Count;
            plan.IngsDelete = plan.IngsOnlyLocal.Count;
            plan.ProdsDelete = plan.ProdsOnlyLocal.Count;
        }
        plan.CatsOnlyRemote = remoteCat.Keys.Where(k => !localCat.ContainsKey(k)).ToList();
        plan.IngsOnlyRemote = remoteIng.Keys.Where(k => !localIng.ContainsKey(k)).ToList();

        var storeDiffs = StoreDiffs(local.Store, remote.Store);
        var includeStore = selection is null || selection.IncludeStore;
        var storeWillUpdate = includeStore && (storeDiffs.Count > 0);

        var (imagesToDownload, imagesUpToDate, toDelete) = selection is { IncludeImages: false }
            ? (new List<string>(), 0, new List<string>())
            : PlanImages(local, remote);

        return new ToolsSyncPreviewDto(
            admin ? "admin" : "public",
            baseUrl,
            warnings,
            plan.CatsCreate, plan.CatsUpdate, plan.CatsEqual, plan.CatsDelete,
            plan.IngsCreate, plan.IngsUpdate, plan.IngsEqual, plan.IngsDelete,
            plan.ProdsCreate, plan.ProdsUpdate, plan.ProdsEqual, plan.ProdsDelete,
            imagesToDownload.Count, imagesUpToDate, toDelete.Count,
            plan.NewProducts,
            plan.UpdatedProducts,
            plan.ProdsOnlyLocal, plan.CatsOnlyLocal, plan.IngsOnlyLocal,
            plan.CatsOnlyRemote, plan.IngsOnlyRemote,
            imagesToDownload, toDelete,
            storeDiffs,
            storeDiffs.Count == 0,
            storeWillUpdate,
            !skipDelete,
            local.Store?.StoreName,
            null);
    }

    /// <summary>Calcula imagens que deveriam ser baixadas (faltam localmente), as em dia e as que seriam removidas (produto excluído).</summary>
    private (List<string> ToDownload, int UpToDate, List<string> ToDelete) PlanImages(Snapshot local, Snapshot remote)
    {
        var toDownload = new List<string>();
        var toDelete = new List<string>();
        var upToDate = 0;

        foreach (var p in local.Products)
        {
            if (p.ImageUrl is null || !p.ImageUrl.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase))
                continue;
            if (remote.Products.All(r => (r.ImageUrl ?? "") != p.ImageUrl))
                toDelete.Add($"{p.ImageUrl} ({p.Name})");
        }

        var remoteFiles = new HashSet<string>(StringComparer.Ordinal);
        foreach (var p in remote.Products)
        {
            if (string.IsNullOrWhiteSpace(p.ImageUrl) || !p.ImageUrl.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase))
                continue;
            var relative = p.ImageUrl.TrimStart('/').Substring("uploads/".Length);
            var localFile = FullUploadPath(relative);
            if (File.Exists(localFile))
                upToDate++;
            else
                toDownload.Add($"{p.ImageUrl} ({p.Name})");
        }

        return (toDownload, upToDate, toDelete);
    }

    private string FullUploadPath(string relative)
    {
        var dest = Path.GetFullPath(Path.Combine(_uploadsRoot, relative));
        return dest.StartsWith(Path.GetFullPath(_uploadsRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
            ? dest
            : "";
    }

    // ───────────────────────────── API pública ─────────────────────────────

    public async Task<ToolsStoreStatusDto> GetStatusAsync(int storeId, CancellationToken ct)
    {
        var local = await BuildLocalSnapshotAsync(storeId, ct);
        var store = await ResolveStoreAsync(storeId, ct);
        var baseUrl = RemoteBaseUrl(store);
        var hasCreds = !string.IsNullOrWhiteSpace(store?.BackUsername) && !string.IsNullOrWhiteSpace(store?.BackPassword);
        var reachable = false;
        string? remoteError = null;
        try
        {
            using var client = _httpFactory.CreateClient("remote");
            using var resp = await client.GetAsync($"{NormalizeApiBase(baseUrl)}/api/v1/health", ct);
            reachable = resp.IsSuccessStatusCode;
        }
        catch (Exception ex)
        {
            remoteError = ex.Message;
        }

        var lastBackup = Directory.Exists(BackupDir(storeId))
            ? Directory.GetDirectories(BackupDir(storeId))
                .Select(Path.GetFileName)
                .Where(n => n != null)
                .OrderDescending()
                .FirstOrDefault() is { } last
                ? TryParseBackupTimestamp(last)
                : null
            : null;

        return new ToolsStoreStatusDto(
            true,
            string.IsNullOrWhiteSpace(baseUrl) ? null : baseUrl,
            hasCreds,
            reachable,
            remoteError,
            lastBackup,
            local.Categories.Count, local.Products.Count, local.Ingredients.Count,
            local.Store?.StoreName);
    }

    public async Task<ToolsCompareReportDto> CompareAsync(int storeId, CancellationToken ct)
    {
        var local = await BuildLocalSnapshotAsync(storeId, ct);
        var store = await ResolveStoreAsync(storeId, ct);
        var baseUrl = RemoteBaseUrl(store);
        if (string.IsNullOrWhiteSpace(baseUrl))
            throw new InvalidOperationException("Defina o Back (URL) da loja para comparar com o remoto.");

        var admin = !string.IsNullOrWhiteSpace(store?.BackUsername) && !string.IsNullOrWhiteSpace(store?.BackPassword);
        var token = admin ? await LoginRemoteAsync(baseUrl, store!.BackUsername!, store.BackPassword!, ct) : null;
        return await CompareAsyncCore(storeId, local, baseUrl, token, admin, ct);
    }

    public async Task<ToolsBackupResultDto> BackupAsync(int storeId, CancellationToken ct)
    {
        var store = await ResolveStoreAsync(storeId, ct);
        var baseUrl = RemoteBaseUrl(store);
        var warnings = new List<string>();
        if (string.IsNullOrWhiteSpace(baseUrl))
            warnings.Add("Sem Back (URL) na loja: backup apenas dos dados locais.");

        var admin = !string.IsNullOrWhiteSpace(store?.BackUsername) && !string.IsNullOrWhiteSpace(store?.BackPassword);
        string? token = null;
        if (!string.IsNullOrWhiteSpace(baseUrl) && admin)
        {
            try { token = await LoginRemoteAsync(baseUrl, store!.BackUsername!, store.BackPassword!, ct); }
            catch (Exception ex) { warnings.Add($"Login remoto falhou: {ex.Message}"); admin = false; }
        }

        var remote = string.IsNullOrWhiteSpace(baseUrl)
            ? new Snapshot { Source = "local" }
            : await BuildRemoteSnapshotAsync(baseUrl, token, admin, ct);

        var local = await BuildLocalSnapshotAsync(storeId, ct);
        var source = string.IsNullOrWhiteSpace(baseUrl) ? local : remote;
        if (string.IsNullOrWhiteSpace(baseUrl))
            warnings.Add("Backup com dados locais (remoto indisponível).");

        var stamp = DateTime.UtcNow.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
        var dir = Path.Combine(BackupDir(storeId), stamp);
        Directory.CreateDirectory(dir);

        await File.WriteAllTextAsync(Path.Combine(dir, "catalog.json"), JsonSerializer.Serialize(new
        {
            source = source.Source,
            createdAt = DateTime.UtcNow,
            categories = source.Categories.Select(c => new { c.Id, c.Title, c.SortOrder, c.ShowInMenu }),
            ingredients = source.Ingredients.Select(i => new { i.Id, i.Name, i.SortOrder, i.CategoryId }),
            products = source.Products.Select(p => new
            {
                p.Id, p.CategoryId, p.Name, p.Price, p.PriceMedia, p.PriceInteira,
                p.Available, p.ShowInMenu, p.ImageUrl, p.Description, p.SortOrder,
                IngredientIds = p.IngredientIds,
                PrincipalIngredientIds = p.PrincipalIngredientIds,
                ModifierGroups = p.ModifierGroups
            })
        }, new JsonSerializerOptions { WriteIndented = true }), ct);

        if (source.Store is not null)
            await File.WriteAllTextAsync(Path.Combine(dir, "store.json"), JsonSerializer.Serialize(source.Store, new JsonSerializerOptions { WriteIndented = true }), ct);

        var imagesDir = Path.Combine(dir, "images");
        var (downloaded, existing, updated, failed) = await DownloadImagesAsync(baseUrl, source, imagesDir, ct);
        await File.WriteAllTextAsync(Path.Combine(dir, "manifest.json"), JsonSerializer.Serialize(new
        {
            storeId,
            createdAt = DateTime.UtcNow,
            source = source.Source,
            remoteBaseUrl = string.IsNullOrWhiteSpace(baseUrl) ? null : baseUrl,
            categories = source.Categories.Count,
            products = source.Products.Count,
            ingredients = source.Ingredients.Count,
            images = new { downloaded, existing, updated, failed }
        }, new JsonSerializerOptions { WriteIndented = true }), ct);

        PruneBackups(storeId);

        return new ToolsBackupResultDto(
            storeId,
            dir,
            source.Categories.Count, source.Products.Count, source.Ingredients.Count,
            downloaded, existing, failed,
            warnings,
            DateTime.UtcNow);
    }

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<int, SemaphoreSlim> _syncLocks = new();

    private async Task<T> WithStoreLockAsync<T>(int storeId, Func<CancellationToken, Task<T>> work, CancellationToken ct)
    {
        var sem = _syncLocks.GetOrAdd(storeId, _ => new SemaphoreSlim(1, 1));
        await sem.WaitAsync(ct);
        try
        {
            return await work(ct);
        }
        finally
        {
            sem.Release();
        }
    }

    public async Task<ToolsSyncReportDto> SyncFromRemoteAsync(int storeId, bool dryRun, bool skipDelete, SyncSelectionDto? selection, CancellationToken ct)
        => await WithStoreLockAsync(storeId, (token) => SyncFromRemoteCoreAsync(storeId, dryRun, skipDelete, selection, token), ct);

    private async Task<ToolsSyncReportDto> SyncFromRemoteCoreAsync(int storeId, bool dryRun, bool skipDelete, SyncSelectionDto? selection, CancellationToken ct)
    {
        var store = await ResolveStoreAsync(storeId, ct);
        var baseUrl = RemoteBaseUrl(store);
        if (string.IsNullOrWhiteSpace(baseUrl))
            throw new InvalidOperationException("Defina o Back (URL) da loja para baixar o conteúdo remoto.");

        var warnings = new List<string>();
        var admin = !string.IsNullOrWhiteSpace(store?.BackUsername) && !string.IsNullOrWhiteSpace(store?.BackPassword);
        string? token = null;
        if (admin)
        {
            try { token = await LoginRemoteAsync(baseUrl, store!.BackUsername!, store.BackPassword!, ct); }
            catch (Exception ex) { warnings.Add($"Login remoto falhou: {ex.Message}"); admin = false; }
        }

        var remote = await BuildRemoteSnapshotAsync(baseUrl, token, admin, ct);
        var local = await BuildLocalSnapshotAsync(storeId, ct);
        var filtered = FilteredSnapshot(remote, selection);

        if (dryRun)
        {
            var plan = BuildSyncPlan(storeId, local, filtered, admin, baseUrl, warnings, skipDelete, selection, ct);
            return new ToolsSyncReportDto(
                storeId, true, skipDelete, admin ? "admin" : "public",
                0, 0, 0, 0, 0, 0,
                0, 0, 0, 0,
                false,
                plan.ProductsOnlyLocal.Count, plan.CategoriesOnlyLocal.Count, plan.IngredientsOnlyLocal.Count,
                warnings, null);
        }

        var counts = await ApplySyncAsync(storeId, filtered, remote, skipDelete, selection, ct);
        var (downloaded, existing, updated, failed) =
            selection is { IncludeImages: false }
                ? (0, 0, 0, 0)
                : await DownloadImagesAsync(baseUrl, filtered, _uploadsRoot, ct);

        _catalog.InvalidateCache();

        return new ToolsSyncReportDto(
            storeId, false, skipDelete, admin ? "admin" : "public",
            counts.CategoriesSynced, counts.CategoriesDeleted,
            counts.IngredientsSynced, counts.IngredientsDeleted,
            counts.ProductsSynced, counts.ProductsDeleted,
            downloaded, existing, updated, failed,
            counts.StoreUpdated,
            0, 0, 0,
            warnings, null);
    }

    // ───────────────────────────── Upload (local → remoto) ─────────────────────────────

    public async Task<ToolsUploadResultDto> UploadToRemoteAsync(int storeId, bool dryRun, bool skipDelete, SyncSelectionDto? selection, CancellationToken ct)
        => await WithStoreLockAsync(storeId, (token) => UploadToRemoteCoreAsync(storeId, dryRun, skipDelete, selection, token), ct);

    public async Task<ToolsUploadPreviewDto> UploadPreviewAsync(int storeId, bool skipDelete, SyncSelectionDto? selection, CancellationToken ct)
        => await WithStoreLockAsync(storeId, (token) => UploadPreviewCoreAsync(storeId, skipDelete, selection, token), ct);

    private sealed class UploadPrep
    {
        public string BaseUrl = "";
        public string Token = "";
        public Snapshot Local = new();
        public Snapshot Remote = new();
        public Snapshot Filtered = new();
        public UploadPlan Plan = new();
        public List<string> Warnings = new();
    }

    private async Task<UploadPrep> PrepareUploadAsync(int storeId, bool skipDelete, SyncSelectionDto? selection, CancellationToken ct)
    {
        var store = await ResolveStoreAsync(storeId, ct)
            ?? throw new InvalidOperationException("Loja não encontrada.");
        var baseUrl = RemoteBaseUrl(store);
        if (string.IsNullOrWhiteSpace(baseUrl))
            throw new InvalidOperationException("Defina o Back (URL) da loja para enviar o conteúdo remoto.");

        var warnings = new List<string>();
        if (string.IsNullOrWhiteSpace(store?.BackUsername) || string.IsNullOrWhiteSpace(store?.BackPassword))
            throw new InvalidOperationException("Upload requer credenciais admin do Back (BackUsername/BackPassword) para escrever no remoto.");

        string? token;
        try { token = await LoginRemoteAsync(baseUrl, store!.BackUsername!, store.BackPassword!, ct); }
        catch (Exception ex) { throw new InvalidOperationException($"Login remoto falhou: {ex.Message}"); }
        if (string.IsNullOrWhiteSpace(token))
            throw new InvalidOperationException("Login remoto não retornou token.");

        var local = await BuildLocalSnapshotAsync(storeId, ct);
        var remote = await BuildRemoteSnapshotAsync(baseUrl, token, true, ct);
        var filtered = FilteredSnapshot(local, selection);
        var plan = BuildUploadPlan(remote, filtered, skipDelete);
        return new UploadPrep { BaseUrl = baseUrl, Token = token, Local = local, Remote = remote, Filtered = filtered, Plan = plan, Warnings = warnings };
    }

    private async Task<ToolsUploadResultDto> UploadToRemoteCoreAsync(int storeId, bool dryRun, bool skipDelete, SyncSelectionDto? selection, CancellationToken ct)
    {
        var opt = await PrepareUploadAsync(storeId, skipDelete, selection, ct);

        if (dryRun)
        {
            return new ToolsUploadResultDto(
                storeId, true, skipDelete, "admin",
                0, 0, 0, 0, 0, 0,
                0, 0,
                false, opt.Warnings, null);
        }

        var uploadCounts = await ApplyUploadAsync(opt.BaseUrl, opt.Token, opt.Remote, opt.Filtered, skipDelete, selection, ct);
        return new ToolsUploadResultDto(
            storeId, false, skipDelete, "admin",
            uploadCounts.CategoriesSynced, uploadCounts.CategoriesDeleted,
            uploadCounts.IngredientsSynced, uploadCounts.IngredientsDeleted,
            uploadCounts.ProductsSynced, uploadCounts.ProductsDeleted,
            uploadCounts.ImagesUploaded, uploadCounts.ImagesFailed,
            uploadCounts.StoreUpdated, opt.Warnings, null);
    }

    private async Task<ToolsUploadPreviewDto> UploadPreviewCoreAsync(int storeId, bool skipDelete, SyncSelectionDto? selection, CancellationToken ct)
    {
        var opt = await PrepareUploadAsync(storeId, skipDelete, selection, ct);
        var p = opt.Plan;
        return new ToolsUploadPreviewDto(
            "admin",
            opt.BaseUrl,
            opt.Warnings,
            p.CatsCreate, p.CatsUpdate, p.CatsEqual, p.CatsDelete,
            p.IngsCreate, p.IngsUpdate, p.IngsEqual, p.IngsDelete,
            p.ProdsCreate, p.ProdsUpdate, p.ProdsEqual, p.ProdsDelete,
            p.ImagesToUpload.Count, 0,
            p.StoreWillUpdate,
            !skipDelete,
            p.NewProducts,
            p.UpdatedProducts,
            p.ProdsOnlyRemote, p.CatsOnlyRemote, p.IngsOnlyRemote,
            p.ImagesToUpload,
            p.StoreDiffs,
            null);
    }

    private sealed class UploadCounts
    {
        public int CategoriesSynced, CategoriesDeleted;
        public int IngredientsSynced, IngredientsDeleted;
        public int ProductsSynced, ProductsDeleted;
        public int ImagesUploaded, ImagesFailed;
        public bool StoreUpdated;
    }

    private sealed class UploadPlan
    {
        public int CatsCreate, CatsUpdate, CatsEqual, CatsDelete;
        public int IngsCreate, IngsUpdate, IngsEqual, IngsDelete;
        public int ProdsCreate, ProdsUpdate, ProdsEqual, ProdsDelete;
        public List<ToolsProductDiffDto> NewProducts = new();
        public List<ToolsProductDiffDto> UpdatedProducts = new();
        public List<string> ProdsOnlyRemote = new();
        public List<string> CatsOnlyRemote = new();
        public List<string> IngsOnlyRemote = new();
        public List<string> ImagesToUpload = new();
        public List<ToolsFieldDiffDto> StoreDiffs = new();
        public bool StoreWillUpdate;
    }

    private UploadPlan BuildUploadPlan(Snapshot remote, Snapshot local, bool skipDelete)
    {
        var remoteCat = remote.Categories.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var remoteProd = remote.Products.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var remoteIng = remote.Ingredients.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var localCat = local.Categories.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var localProd = local.Products.ToDictionary(x => x.Id, StringComparer.Ordinal);
        var localIng = local.Ingredients.ToDictionary(x => x.Id, StringComparer.Ordinal);

        var plan = new UploadPlan();

        foreach (var (id, lc) in localCat)
        {
            if (!remoteCat.TryGetValue(id, out var rc)) plan.CatsCreate++;
            else if (rc.Title != lc.Title || rc.SortOrder != lc.SortOrder || rc.ShowInMenu != lc.ShowInMenu) plan.CatsUpdate++;
            else plan.CatsEqual++;
        }
        foreach (var (id, li) in localIng)
        {
            if (!remoteIng.TryGetValue(id, out var ri)) plan.IngsCreate++;
            else if (ri.Name != li.Name || ri.SortOrder != li.SortOrder || ri.CategoryId != li.CategoryId) plan.IngsUpdate++;
            else plan.IngsEqual++;
        }
        foreach (var (id, lp) in localProd)
        {
            if (!remoteProd.TryGetValue(id, out var rp))
            {
                plan.ProdsCreate++;
                plan.NewProducts.Add(new ToolsProductDiffDto(id, lp.Name, new List<string> { "novo" }));
            }
            else
            {
                var fields = ProductChangedFields(rp, lp);
                if (fields.Count > 0)
                {
                    plan.ProdsUpdate++;
                    plan.UpdatedProducts.Add(new ToolsProductDiffDto(id, lp.Name, fields));
                }
                else plan.ProdsEqual++;
            }
            if (!string.IsNullOrWhiteSpace(lp.ImageUrl) && lp.ImageUrl.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase))
            {
                var localFile = FullUploadPath(lp.ImageUrl.TrimStart('/').Substring("uploads/".Length));
                if (File.Exists(localFile))
                    plan.ImagesToUpload.Add($"{lp.ImageUrl} ({lp.Name})");
            }
        }

        if (!skipDelete)
        {
            plan.CatsOnlyRemote = remoteCat.Keys.Where(k => !localCat.ContainsKey(k)).ToList();
            plan.IngsOnlyRemote = remoteIng.Keys.Where(k => !localIng.ContainsKey(k)).ToList();
            plan.ProdsOnlyRemote = remoteProd.Keys.Where(k => !localProd.ContainsKey(k)).ToList();
            plan.CatsDelete = plan.CatsOnlyRemote.Count;
            plan.IngsDelete = plan.IngsOnlyRemote.Count;
            plan.ProdsDelete = plan.ProdsOnlyRemote.Count;
        }

        plan.StoreDiffs = StoreDiffs(local.Store, remote.Store);
        plan.StoreWillUpdate = plan.StoreDiffs.Count > 0;
        return plan;
    }

    private async Task<UploadCounts> ApplyUploadAsync(
        string baseUrl, string token, Snapshot remote, Snapshot local, bool skipDelete, SyncSelectionDto? selection, CancellationToken ct)
    {
        var counts = new UploadCounts();
        var root = NormalizeApiBase(baseUrl);

        // Upsert categorias / ingredientes / produtos no remoto via API admin.
        foreach (var c in local.Categories)
        {
            await PutJsonAsync(root, token, "/api/v1/admin/categories", new
            {
                id = c.Id, title = c.Title, sortOrder = c.SortOrder, showInMenu = c.ShowInMenu
            }, ct);
            counts.CategoriesSynced++;
        }

        foreach (var i in local.Ingredients)
        {
            await PutJsonAsync(root, token, "/api/v1/admin/ingredients", new
            {
                id = i.Id, name = i.Name, sortOrder = i.SortOrder, categoryId = i.CategoryId
            }, ct);
            counts.IngredientsSynced++;
        }

        foreach (var p in local.Products)
        {
            // Envia a imagem (se houver e não existir no remoto) antes de atualizar o produto.
            if (!string.IsNullOrWhiteSpace(p.ImageUrl) && p.ImageUrl.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase))
            {
                var relative = p.ImageUrl.TrimStart('/').Substring("uploads/".Length);
                var localFile = FullUploadPath(relative);
                if (File.Exists(localFile))
                {
                    try { await UploadImageAsync(root, token, p.Name, p.ImageUrl, localFile, ct); counts.ImagesUploaded++; }
                    catch (Exception ex)
                    {
                        counts.ImagesFailed++;
                        _logger.LogWarning(ex, "Falha ao enviar imagem {Url} para {Root}", p.ImageUrl, root);
                    }
                }
            }

            await PutJsonAsync(root, token, "/api/v1/admin/products", new
            {
                id = p.Id, categoryId = p.CategoryId, name = p.Name, price = p.Price,
                priceMedia = p.PriceMedia, priceInteira = p.PriceInteira,
                available = p.Available, showInMenu = p.ShowInMenu, imageUrl = p.ImageUrl,
                description = p.Description, sortOrder = p.SortOrder,
                ingredientIds = p.IngredientIds,
                principalIngredientIds = p.PrincipalIngredientIds,
                modifierGroups = p.ModifierGroups
            }, ct);
            counts.ProductsSynced++;
        }

        // Exclusões (apenas se permitido explicitamente).
        if (!skipDelete)
        {
            var selCats = selection is null ? null : new HashSet<string>(selection.SyncCategories ?? [], StringComparer.Ordinal);
            var selProds = selection is null ? null : new HashSet<string>(selection.SyncProducts ?? [], StringComparer.Ordinal);
            var selIngs = selection is null ? null : new HashSet<string>(selection.SyncIngredients ?? [], StringComparer.Ordinal);
            var localCatIds = local.Categories.Select(x => x.Id).ToHashSet(StringComparer.Ordinal);
            var localProdIds = local.Products.Select(x => x.Id).ToHashSet(StringComparer.Ordinal);
            var localIngIds = local.Ingredients.Select(x => x.Id).ToHashSet(StringComparer.Ordinal);

            foreach (var c in remote.Categories.Where(c => selCats is null || selCats.Count == 0 || selCats.Contains(c.Id)))
                if (!localCatIds.Contains(c.Id))
                {
                    await DeleteAsync(root, token, $"/api/v1/admin/categories/{Uri.EscapeDataString(c.Id)}", c.Id, ct);
                    counts.CategoriesDeleted++;
                }
            foreach (var i in remote.Ingredients.Where(i => selIngs is null || selIngs.Count == 0 || selIngs.Contains(i.Id)))
                if (!localIngIds.Contains(i.Id))
                {
                    await DeleteAsync(root, token, $"/api/v1/admin/ingredients/{Uri.EscapeDataString(i.Id)}", i.Id, ct);
                    counts.IngredientsDeleted++;
                }
            foreach (var p in remote.Products.Where(p => selProds is null || selProds.Count == 0 || selProds.Contains(p.Id)))
                if (!localProdIds.Contains(p.Id))
                {
                    await DeleteAsync(root, token, $"/api/v1/admin/products/{Uri.EscapeDataString(p.Id)}", p.Id, ct);
                    counts.ProductsDeleted++;
                }
        }

        // Atualiza a configuração da loja no remoto, se houver e permitido.
        if (selection is not { IncludeStore: false } && local.Store is not null)
        {
            var s = local.Store;
            try
            {
                await PatchRemoteStoreAsync(root, token, s, ct);
                counts.StoreUpdated = true;
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Falha ao atualizar config da loja no remoto {Root}", root);
            }
        }

        return counts;
    }

    private async Task PutJsonAsync(string root, string token, string path, object body, CancellationToken ct)
    {
        using var client = _httpFactory.CreateClient("remote");
        using var req = new HttpRequestMessage(HttpMethod.Put, $"{root}{path}")
        {
            Content = new StringContent(JsonSerializer.Serialize(body), System.Text.Encoding.UTF8, "application/json")
        };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"PUT {path} remoto falhou (HTTP {(int)resp.StatusCode}).");
    }

    private async Task DeleteAsync(string root, string token, string path, string id, CancellationToken ct)
    {
        using var client = _httpFactory.CreateClient("remote");
        using var req = new HttpRequestMessage(HttpMethod.Delete, $"{root}{path}");
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"DELETE {id} remoto falhou (HTTP {(int)resp.StatusCode}).");
    }

    private async Task UploadImageAsync(string root, string token, string name, string currentImageUrl, string localFile, CancellationToken ct)
    {
        using var client = _httpFactory.CreateClient("remote");
        using var form = new MultipartFormDataContent();
        await using var fs = System.IO.File.OpenRead(localFile);
        var fileContent = new StreamContent(fs);
        fileContent.Headers.ContentType = new System.Net.Http.Headers.MediaTypeHeaderValue(
            ContentTypeFromPath(localFile));
        form.Add(fileContent, "file", System.IO.Path.GetFileName(localFile));
        form.Add(new StringContent(name ?? ""), "name");
        form.Add(new StringContent(currentImageUrl ?? ""), "currentImageUrl");
        using var req = new HttpRequestMessage(HttpMethod.Post, $"{root}/api/v1/admin/product-image")
        { Content = form };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"Upload de imagem falhou (HTTP {(int)resp.StatusCode}).");
        var body = await resp.Content.ReadAsStringAsync(ct);
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("imageUrl", out var url) || url.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("Upload de imagem não retornou imageUrl.");
    }

    private async Task PatchRemoteStoreAsync(string root, string token, SnapStore s, CancellationToken ct)
    {
        using var client = _httpFactory.CreateClient("remote");
        using var req = new HttpRequestMessage(HttpMethod.Patch, $"{root}/api/v1/admin/store")
        {
            Content = new StringContent(JsonSerializer.Serialize(new
            {
                storeName = s.StoreName,
                whatsapp = s.Whatsapp,
                pixKey = s.PixKey,
                pixKeyLabel = s.PixKeyLabel,
                minOrder = s.MinOrder,
                address = s.Address,
                cep = s.Cep,
                city = s.City,
                state = s.State,
                acceptingOrders = s.AcceptingOrders,
                deliveryFeePerKm = s.DeliveryFeePerKm,
                maxDeliveryKm = s.MaxDeliveryKm,
                minDeliveryFee = s.MinDeliveryFee,
                averageDeliveryMinutes = s.AverageDeliveryMinutes,
                addressNumber = s.AddressNumber,
                iconUrl = s.IconUrl
            }), System.Text.Encoding.UTF8, "application/json")
        };
        req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var resp = await client.SendAsync(req, ct);
        if (!resp.IsSuccessStatusCode)
            throw new InvalidOperationException($"PATCH /store remoto falhou (HTTP {(int)resp.StatusCode}).");
    }

    private static string ContentTypeFromPath(string path)
    {
        var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
        return ext switch
        {
            ".png" => "image/png",
            ".jpg" or ".jpeg" => "image/jpeg",
            ".webp" => "image/webp",
            ".gif" => "image/gif",
            _ => "application/octet-stream"
        };
    }

    public async Task<StoreStatsDto> FetchRemoteStatsAsync(int storeId, CancellationToken ct)
    {
        if (!IsAvailable)
            throw new InvalidOperationException("Ferramentas indisponíveis: Persistence deve ser PostgreSQL.");

        var store = await ResolveStoreAsync(storeId, ct)
            ?? throw new InvalidOperationException("Loja não encontrada.");
        var baseUrl = RemoteBaseUrl(store);

        // Lojas sem Back URL são o próprio deployment: usam as estatísticas deste ambiente.
        if (string.IsNullOrWhiteSpace(baseUrl))
        {
            var local = await _storeStats.ComputeAsync(storeId, ct);
            await _platform.SaveStatsAsync(storeId, local, ct);
            return local;
        }

        var admin = !string.IsNullOrWhiteSpace(store?.BackUsername) && !string.IsNullOrWhiteSpace(store?.BackPassword);
        if (!admin)
            throw new InvalidOperationException("Defina credenciais do Back para buscar estatísticas do remoto.");

        string? token;
        try { token = await LoginRemoteAsync(baseUrl, store!.BackUsername!, store.BackPassword!, ct); }
        catch (Exception ex) { throw new InvalidOperationException($"Login remoto falhou: {ex.Message}"); }

        var stats = await GetJsonAsync(baseUrl, token, "/api/v1/admin/platform/store-stats", true, ct);
        if (stats is null)
            throw new InvalidOperationException("A API remota não retornou estatísticas.");
        var dto = DeserializeRemoteStats(stats.Value);
        await _platform.SaveStatsAsync(storeId, dto, ct);
        return dto;
    }

    private static StoreStatsDto DeserializeRemoteStats(JsonElement el)
    {
        return new StoreStatsDto(
            FetchedAt: el.TryGetProperty("fetchedAt", out var f) && f.ValueKind == JsonValueKind.String
                ? f.GetDateTime()
                : DateTime.UtcNow,
            Error: NullStr(el, "error"),
            LastAccessAt: el.TryGetProperty("lastAccessAt", out var la) && la.ValueKind == JsonValueKind.String
                ? la.GetDateTime()
                : (DateTime?)null,
            MenuViews30d: el.TryGetProperty("menuViews30d", out var m30) && m30.ValueKind == JsonValueKind.Number
                ? m30.GetInt64()
                : 0,
            MenuViewsTotal: el.TryGetProperty("menuViewsTotal", out var mt) && mt.ValueKind == JsonValueKind.Number
                ? mt.GetInt64()
                : 0,
            Orders30d: el.TryGetProperty("orders30d", out var o30) && o30.ValueKind == JsonValueKind.Number
                ? o30.GetInt64()
                : (long?)null,
            OrdersTotal: el.TryGetProperty("ordersTotal", out var ot) && ot.ValueKind == JsonValueKind.Number
                ? ot.GetInt64()
                : (long?)null,
            OrdersAvailable: el.TryGetProperty("ordersAvailable", out var oa) && oa.ValueKind == JsonValueKind.True);
    }

    // ───────────────────────────── Aplicar sync ─────────────────────────────

    private sealed class SyncCounts
    {
        public int CategoriesSynced; public int CategoriesDeleted;
        public int IngredientsSynced; public int IngredientsDeleted;
        public int ProductsSynced; public int ProductsDeleted;
        public bool StoreUpdated;
    }

    private async Task<SyncCounts> ApplySyncAsync(int storeId, Snapshot remote, Snapshot fullRemote, bool skipDelete, SyncSelectionDto? selection, CancellationToken ct)
    {
        var syncTags = selection is null ? null : new HashSet<string>(selection.SyncCategories ?? [], StringComparer.Ordinal);
        var syncProds = selection is null ? null : new HashSet<string>(selection.SyncProducts ?? [], StringComparer.Ordinal);
        var syncIngs = selection is null ? null : new HashSet<string>(selection.SyncIngredients ?? [], StringComparer.Ordinal);
        var allCats = syncTags is null || syncTags.Count == 0;
        var allProds = syncProds is null || syncProds.Count == 0;
        var allIngs = syncIngs is null || syncIngs.Count == 0;

        return await WithBypassAsync(async (conn, tx, token) =>
        {
            var counts = new SyncCounts();

            foreach (var c in remote.Categories.Where(c => allCats || syncTags!.Contains(c.Id)))
            {
                await using var cmd = new NpgsqlCommand(
                    """
                    INSERT INTO categories ("Id", "StoreId", "Title", "SortOrder", "ShowInMenu")
                    VALUES (@id, @store, @title, @sort, @show)
                    ON CONFLICT ("Id") DO UPDATE SET
                        "Title" = EXCLUDED."Title",
                        "SortOrder" = EXCLUDED."SortOrder",
                        "ShowInMenu" = EXCLUDED."ShowInMenu"
                    """, conn, tx);
                cmd.Parameters.AddWithValue("id", c.Id);
                cmd.Parameters.AddWithValue("store", storeId);
                cmd.Parameters.AddWithValue("title", c.Title);
                cmd.Parameters.AddWithValue("sort", c.SortOrder);
                cmd.Parameters.AddWithValue("show", c.ShowInMenu);
                await cmd.ExecuteNonQueryAsync(token);
                counts.CategoriesSynced++;
            }

            foreach (var i in remote.Ingredients.Where(i => allIngs || syncIngs!.Contains(i.Id)))
            {
                await using var cmd = new NpgsqlCommand(
                    """
                    INSERT INTO ingredients ("Id", "StoreId", "Name", "SortOrder", "CategoryId")
                    VALUES (@id, @store, @name, @sort, @cat)
                    ON CONFLICT ("Id") DO UPDATE SET
                        "Name" = EXCLUDED."Name",
                        "SortOrder" = EXCLUDED."SortOrder",
                        "CategoryId" = EXCLUDED."CategoryId"
                    """, conn, tx);
                cmd.Parameters.AddWithValue("id", i.Id);
                cmd.Parameters.AddWithValue("store", storeId);
                cmd.Parameters.AddWithValue("name", i.Name);
                cmd.Parameters.AddWithValue("sort", i.SortOrder);
                cmd.Parameters.AddWithValue("cat", (object?)i.CategoryId ?? DBNull.Value);
                await cmd.ExecuteNonQueryAsync(token);
                counts.IngredientsSynced++;
            }

            var referencedIngredientIds = remote.Products
                .SelectMany(product => product.IngredientIds)
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (referencedIngredientIds.Length > 0)
            {
                var existingIngredientIds = new HashSet<string>(StringComparer.Ordinal);
                await using (var check = new NpgsqlCommand(
                    """SELECT "Id" FROM ingredients WHERE "StoreId" = @store AND "Id" = ANY(@ids)""",
                    conn, tx))
                {
                    check.Parameters.AddWithValue("store", storeId);
                    check.Parameters.AddWithValue("ids", referencedIngredientIds);
                    await using var reader = await check.ExecuteReaderAsync(token);
                    while (await reader.ReadAsync(token))
                        existingIngredientIds.Add(reader.GetString(0));
                }

                var missingIngredientIds = referencedIngredientIds
                    .Where(id => !existingIngredientIds.Contains(id))
                    .Take(5)
                    .ToArray();
                if (missingIngredientIds.Length > 0)
                {
                    throw new InvalidOperationException(
                        $"Não foi possível aplicar o download: ingredientes referenciados pelos produtos não foram encontrados na loja local ({string.Join(", ", missingIngredientIds)}). Verifique os dados remotos e tente novamente.");
                }
            }

            foreach (var p in remote.Products.Where(p => allProds || syncProds!.Contains(p.Id)))
            {
                await using (var cmd = new NpgsqlCommand(
                    """
                    INSERT INTO products ("Id", "StoreId", "CategoryId", "Name", "Price", "PriceMedia", "PriceInteira",
                                      "Available", "ShowInMenu", "ImageUrl", "Description", "SortOrder",
                                      "ModifierGroupsJson")
                    VALUES (@id, @store, @cat, @name, @price, @priceMedia, @priceInteira,
                            @available, @show, @image, @description, @sort, @mods)
                    ON CONFLICT ("Id") DO UPDATE SET
                        "CategoryId" = EXCLUDED."CategoryId",
                        "Name" = EXCLUDED."Name",
                        "Price" = EXCLUDED."Price",
                        "PriceMedia" = EXCLUDED."PriceMedia",
                        "PriceInteira" = EXCLUDED."PriceInteira",
                        "Available" = EXCLUDED."Available",
                        "ShowInMenu" = EXCLUDED."ShowInMenu",
                        "ImageUrl" = EXCLUDED."ImageUrl",
                        "Description" = EXCLUDED."Description",
                        "SortOrder" = EXCLUDED."SortOrder",
                        "ModifierGroupsJson" = EXCLUDED."ModifierGroupsJson"
                    """, conn, tx))
                {
                    cmd.Parameters.AddWithValue("id", p.Id);
                    cmd.Parameters.AddWithValue("store", storeId);
                    cmd.Parameters.AddWithValue("cat", p.CategoryId);
                    cmd.Parameters.AddWithValue("name", p.Name);
                    cmd.Parameters.AddWithValue("price", p.Price);
                    cmd.Parameters.AddWithValue("priceMedia", (object?)p.PriceMedia ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("priceInteira", (object?)p.PriceInteira ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("available", p.Available);
                    cmd.Parameters.AddWithValue("show", p.ShowInMenu);
                    cmd.Parameters.AddWithValue("image", (object?)p.ImageUrl ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("description", (object?)p.Description ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("sort", p.SortOrder);
                    cmd.Parameters.AddWithValue("mods", (object?)ModifierGroups.Serialize(p.ModifierGroups) ?? DBNull.Value);
                    await cmd.ExecuteNonQueryAsync(token);
                }

                await using (var del = new NpgsqlCommand(
                    """DELETE FROM product_ingredients WHERE "ProductId" = @id""", conn, tx))
                {
                    del.Parameters.AddWithValue("id", p.Id);
                    await del.ExecuteNonQueryAsync(token);
                }

                for (var k = 0; k < p.IngredientIds.Count; k++)
                {
                    var isPrincipal = p.PrincipalIngredientIds.Contains(p.IngredientIds[k], StringComparer.Ordinal);
                    await using var cmd = new NpgsqlCommand(
                        """
                        INSERT INTO product_ingredients ("ProductId", "IngredientId", "SortOrder", "IsPrincipal")
                        VALUES (@pid, @iid, @sort, @principal)
                        ON CONFLICT ("ProductId", "IngredientId") DO UPDATE SET "SortOrder" = EXCLUDED."SortOrder", "IsPrincipal" = EXCLUDED."IsPrincipal"
                        """, conn, tx);
                    cmd.Parameters.AddWithValue("pid", p.Id);
                    cmd.Parameters.AddWithValue("iid", p.IngredientIds[k]);
                    cmd.Parameters.AddWithValue("sort", k);
                    cmd.Parameters.AddWithValue("principal", isPrincipal);
                    await cmd.ExecuteNonQueryAsync(token);
                }

                counts.ProductsSynced++;
            }

            if (!skipDelete)
            {
                if (allProds && fullRemote.Products.Count > 0)
                {
                    var ids = fullRemote.Products.Select(x => x.Id).ToArray();
                    await using (var delRefs = new NpgsqlCommand(
                        """
                        DELETE FROM product_ingredients
                        WHERE "ProductId" IN (SELECT "Id" FROM products WHERE "StoreId" = @store AND NOT ("Id" = ANY(@ids)))
                        """, conn, tx))
                    {
                        delRefs.Parameters.AddWithValue("store", storeId);
                        delRefs.Parameters.AddWithValue("ids", ids);
                        await delRefs.ExecuteNonQueryAsync(token);
                    }
                    await using (var del = new NpgsqlCommand(
                        """DELETE FROM products WHERE "StoreId" = @store AND NOT ("Id" = ANY(@ids))""", conn, tx))
                    {
                        del.Parameters.AddWithValue("store", storeId);
                        del.Parameters.AddWithValue("ids", ids);
                        counts.ProductsDeleted += await del.ExecuteNonQueryAsync(token);
                    }
                }

                if (allIngs && fullRemote.Ingredients.Count > 0)
                {
                    var ids = fullRemote.Ingredients.Select(x => x.Id).ToArray();
                    await using (var delRefs = new NpgsqlCommand(
                        """
                        DELETE FROM product_ingredients
                        WHERE "IngredientId" IN (SELECT "Id" FROM ingredients WHERE "StoreId" = @store AND NOT ("Id" = ANY(@ids)))
                        """, conn, tx))
                    {
                        delRefs.Parameters.AddWithValue("store", storeId);
                        delRefs.Parameters.AddWithValue("ids", ids);
                        await delRefs.ExecuteNonQueryAsync(token);
                    }
                    await using (var del = new NpgsqlCommand(
                        """DELETE FROM ingredients WHERE "StoreId" = @store AND NOT ("Id" = ANY(@ids))""", conn, tx))
                    {
                        del.Parameters.AddWithValue("store", storeId);
                        del.Parameters.AddWithValue("ids", ids);
                        counts.IngredientsDeleted += await del.ExecuteNonQueryAsync(token);
                    }
                }

                if (allCats && fullRemote.Categories.Count > 0)
                {
                    var ids = fullRemote.Categories.Select(x => x.Id).ToArray();
                    await using var del = new NpgsqlCommand(
                        """DELETE FROM categories WHERE "StoreId" = @store AND NOT ("Id" = ANY(@ids))""", conn, tx);
                    del.Parameters.AddWithValue("store", storeId);
                    del.Parameters.AddWithValue("ids", ids);
                    counts.CategoriesDeleted += await del.ExecuteNonQueryAsync(token);
                }
            }

            if (selection is not { IncludeStore: false } && remote.Store is not null)
            {
                var s = remote.Store;
                await using var cmd = new NpgsqlCommand(
                    """
                    UPDATE stores SET
                        "StoreName" = @storeName,
                        "Whatsapp" = @whatsapp,
                        "PixKey" = @pixKey,
                        "PixKeyLabel" = @pixKeyLabel,
                        "MinOrder" = @minOrder,
                        "Address" = @address,
                        "Cep" = @cep,
                        "City" = @city,
                        "State" = @state,
                        "AcceptingOrders" = @accepting,
                        "DeliveryFeePerKm" = @feePerKm,
                        "MaxDeliveryKm" = @maxKm,
                        "MinDeliveryFee" = @minFee,
                        "AverageDeliveryMinutes" = @avgMinutes,
                        "AddressNumber" = @addressNumber,
                        "IconUrl" = @iconUrl
                    WHERE "Id" = @store
                    """, conn, tx);
                cmd.Parameters.AddWithValue("store", storeId);
                cmd.Parameters.AddWithValue("storeName", (object?)s.StoreName ?? "");
                cmd.Parameters.AddWithValue("whatsapp", (object?)s.Whatsapp ?? "");
                cmd.Parameters.AddWithValue("pixKey", (object?)s.PixKey ?? "");
                cmd.Parameters.AddWithValue("pixKeyLabel", (object?)s.PixKeyLabel ?? "Telefone");
                cmd.Parameters.AddWithValue("minOrder", s.MinOrder);
                cmd.Parameters.AddWithValue("address", (object?)s.Address ?? DBNull.Value);
                cmd.Parameters.AddWithValue("cep", (object?)s.Cep ?? DBNull.Value);
                cmd.Parameters.AddWithValue("city", (object?)s.City ?? DBNull.Value);
                cmd.Parameters.AddWithValue("state", (object?)s.State ?? DBNull.Value);
                cmd.Parameters.AddWithValue("accepting", s.AcceptingOrders);
                cmd.Parameters.AddWithValue("feePerKm", s.DeliveryFeePerKm);
                cmd.Parameters.AddWithValue("maxKm", s.MaxDeliveryKm);
                cmd.Parameters.AddWithValue("minFee", s.MinDeliveryFee);
                cmd.Parameters.AddWithValue("avgMinutes", s.AverageDeliveryMinutes);
                cmd.Parameters.AddWithValue("addressNumber", (object?)s.AddressNumber ?? DBNull.Value);
                cmd.Parameters.AddWithValue("iconUrl", (object?)s.IconUrl ?? DBNull.Value);
                await cmd.ExecuteNonQueryAsync(token);
                counts.StoreUpdated = true;
            }

            return counts;
        }, ct);
    }

    // ───────────────────────────── Imagens ─────────────────────────────

    private async Task<(int Downloaded, int Existing, int Updated, int Failed)> DownloadImagesAsync(
        string baseUrl,
        Snapshot source,
        string destinationRoot,
        CancellationToken ct)
    {
        var downloaded = 0;
        var existing = 0;
        var updated = 0;
        var failed = 0;

        foreach (var p in source.Products)
        {
            if (string.IsNullOrWhiteSpace(p.ImageUrl) || !p.ImageUrl.StartsWith("/uploads/", StringComparison.OrdinalIgnoreCase))
                continue;

            var relative = p.ImageUrl.TrimStart('/').Substring("uploads/".Length);
            var dest = Path.GetFullPath(Path.Combine(destinationRoot, relative));
            if (!dest.StartsWith(Path.GetFullPath(destinationRoot) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            {
                failed++;
                continue;
            }

            var url = $"{NormalizeApiBase(baseUrl)}{p.ImageUrl}";
            if (File.Exists(dest) && await ImageMatchesRemoteAsync(url, dest, ct))
            {
                existing++;
                continue;
            }

            Directory.CreateDirectory(Path.GetDirectoryName(dest)!);
            try
            {
                using var client = _httpFactory.CreateClient("remote");
                var bytes = await client.GetByteArrayAsync(url, ct);
                await File.WriteAllBytesAsync(dest, bytes, ct);
                if (File.Exists(dest) && !await ImageMatchesRemoteAsync(url, dest, ct))
                    downloaded++;
                else
                    updated++;
            }
            catch (Exception ex)
            {
                failed++;
                _logger.LogWarning(ex, "Falha ao baixar imagem {Url}", p.ImageUrl);
            }
        }

        return (downloaded, existing, updated, failed);
    }

    /// <summary>Tenta confirmar se o arquivo local está em dia com o remoto comparando tamanho (e ETag quando disponível).</summary>
    private async Task<bool> ImageMatchesRemoteAsync(string url, string localPath, CancellationToken ct)
    {
        try
        {
            long localLen;
            try { localLen = new FileInfo(localPath).Length; }
            catch { return false; }

            using var client = _httpFactory.CreateClient("remote");
            using var req = new HttpRequestMessage(HttpMethod.Head, url);
            using var resp = await client.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
            if (resp.IsSuccessStatusCode)
            {
                var remoteLen = resp.Content.Headers.ContentLength;
                if (remoteLen.HasValue && remoteLen.Value == localLen)
                    return true;
                return false;
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    private string BackupDir(int storeId) => Path.Combine(_dataRoot, "backups", storeId.ToString(CultureInfo.InvariantCulture));

    private void PruneBackups(int storeId)
    {
        var dir = BackupDir(storeId);
        if (!Directory.Exists(dir)) return;
        var backups = Directory.GetDirectories(dir)
            .Where(d => Path.GetFileName(d) != "downloads")
            .OrderDescending()
            .ToList();
        foreach (var old in backups.Skip(BackupRetention))
        {
            try { Directory.Delete(old, true); }
            catch (Exception ex) { _logger.LogWarning(ex, "Não removeu backup antigo {Path}", old); }
        }
    }

    private static DateTime? TryParseBackupTimestamp(string name)
    {
        return DateTime.TryParseExact(
            name,
            "yyyyMMddHHmmss",
            CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal,
            out var dt)
            ? dt
            : null;
    }

    public async Task<ToolsBackupListDto> ListBackupsAsync(int storeId, CancellationToken ct)
    {
        var dir = BackupDir(storeId);
        var entries = new List<ToolsBackupEntryDto>();
        if (Directory.Exists(dir))
        {
            foreach (var sub in Directory.GetDirectories(dir))
            {
                var name = Path.GetFileName(sub);
                if (name == "downloads" || TryParseBackupTimestamp(name) is null) continue;
                var createdAt = TryParseBackupTimestamp(name)!.Value;
                var (cats, prods, ings, images) = await ReadBackupManifestAsync(sub, ct);
                var size = DirectorySize(sub);
                entries.Add(new ToolsBackupEntryDto(name, createdAt, cats, prods, ings, images, size));
            }
        }
        return new ToolsBackupListDto(storeId, entries.OrderByDescending(e => e.CreatedAt).ToList());
    }

    public async Task<byte[]?> BuildBackupZipAsync(int storeId, string name, CancellationToken ct)
    {
        var dir = Path.Combine(BackupDir(storeId), name);
        if (!Directory.Exists(dir) || TryParseBackupTimestamp(name) is null)
            return null;
        using var ms = new MemoryStream();
        using (var zip = new System.IO.Compression.ZipArchive(ms, System.IO.Compression.ZipArchiveMode.Create, true))
        {
            foreach (var file in Directory.GetFiles(dir, "*", System.IO.SearchOption.AllDirectories))
            {
                var relative = Path.GetRelativePath(dir, file);
                var entry = zip.CreateEntry(relative, System.IO.Compression.CompressionLevel.Optimal);
                using var es = entry.Open();
                await using var fs = System.IO.File.OpenRead(file);
                await fs.CopyToAsync(es, ct);
            }
        }
        return ms.ToArray();
    }

    private static async Task<(int Cats, int Prods, int Ings, int Images)> ReadBackupManifestAsync(string dir, CancellationToken ct)
    {
        var images = Directory.Exists(Path.Combine(dir, "images"))
            ? Directory.GetFiles(Path.Combine(dir, "images"), "*.*", System.IO.SearchOption.AllDirectories).Length
            : 0;
        var manifestPath = Path.Combine(dir, "manifest.json");
        if (!File.Exists(manifestPath))
            return (0, 0, 0, images);
        try
        {
            await using var fs = System.IO.File.OpenRead(manifestPath);
            using var doc = await JsonDocument.ParseAsync(fs, cancellationToken: ct);
            var r = doc.RootElement;
            return (
                Num(r, "categories"),
                Num(r, "products"),
                Num(r, "ingredients"),
                images);
        }
        catch
        {
            return (0, 0, 0, images);
        }

        static int Num(JsonElement e, string prop)
            => e.TryGetProperty(prop, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;
    }

    private static long DirectorySize(string dir)
    {
        try
        {
            return Directory.EnumerateFiles(dir, "*", System.IO.SearchOption.AllDirectories)
                .Sum(f => new FileInfo(f).Length);
        }
        catch
        {
            return 0;
        }
    }

    // ───────────────────────────── Sincronização de pedidos (remoto→local) ─────────────────────────────
    // Puxa os pedidos do orders-api remoto e grava na tabela `orders` local (mesmo PostgreSQL do
    // orders-api, RLS desligado na transação). Novos pedidos são inseridos; os que já existem
    // localmente (mesmo OrderId) são substituídos pelo estado remoto. Nada é excluído.
    // O dashboard (orders) reflete os dados assim que o orders-api relê a tabela.

    private static readonly string[] _knownOrderStatuses =
        { "Created", "Accepted", "Preparing", "OutForDelivery", "ReadyForPickup", "Delivered", "Cancelled" };

    private sealed record RemoteOrderItemDto(string? ProductId, string Name, decimal Price, int Quantity);

    private sealed record RemoteOrderDto(
        string OrderId,
        string CustomerName,
        string CustomerPhone,
        string Address,
        string? Neighborhood,
        string? Reference,
        string PaymentMethod,
        string PaymentTiming,
        string PaymentStatus,
        string? Notes,
        decimal DeliveryFee,
        decimal ItemsTotal,
        string Status,
        DateTime CreatedAtUtc,
        DateTime? StatusUpdatedAtUtc,
        DateTime? AcceptedAtUtc,
        DateTime? CustomerReceivedAtUtc,
        string? CancellationReasonCode,
        string? CancellationReason,
        bool CancellationCustomerRequested,
        string FulfillmentType,
        DateTime? ItemsUpdatedAtUtc,
        string? ItemsChangeSummary,
        decimal? PreviousItemsTotal,
        string? Cep,
        bool NeedsChange,
        decimal? ChangeFor,
        List<RemoteOrderItemDto> Items);

    public async Task<ToolsOrdersPreviewDto> OrdersPreviewAsync(int storeId, CancellationToken ct)
        => await WithStoreLockAsync(storeId, (token) => OrdersPreviewCoreAsync(storeId, token), ct);

    private async Task<ToolsOrdersPreviewDto> OrdersPreviewCoreAsync(int storeId, CancellationToken ct)
    {
        var store = await ResolveStoreAsync(storeId, ct);
        var baseUrl = RemoteBaseUrl(store);
        if (string.IsNullOrWhiteSpace(baseUrl))
            throw new InvalidOperationException("Defina o Back (URL) da loja para baixar os pedidos.");

        var warnings = new List<string>();
        var (orders, admin) = await FetchRemoteOrdersAsync(store!, baseUrl, warnings, ct);

        var existing = await LoadExistingOrderIdsAsync(ct);
        int toCreate = 0, toReplace = 0;
        var sampleNew = new List<string>();
        foreach (var o in orders)
        {
            if (!existing.Contains(o.OrderId))
            {
                toCreate++;
                if (sampleNew.Count < 8) sampleNew.Add(o.OrderId);
            }
            else
            {
                toReplace++;
            }
        }

        return new ToolsOrdersPreviewDto(
            admin ? "admin" : "public",
            baseUrl,
            warnings,
            toCreate, toReplace, 0,
            orders.Count,
            sampleNew,
            null);
    }

    public async Task<ToolsOrdersSyncReportDto> SyncOrdersAsync(int storeId, bool dryRun, CancellationToken ct)
        => await WithStoreLockAsync(storeId, (token) => SyncOrdersCoreAsync(storeId, dryRun, token), ct);

    private async Task<ToolsOrdersSyncReportDto> SyncOrdersCoreAsync(int storeId, bool dryRun, CancellationToken ct)
    {
        var store = await ResolveStoreAsync(storeId, ct);
        var baseUrl = RemoteBaseUrl(store);
        if (string.IsNullOrWhiteSpace(baseUrl))
            throw new InvalidOperationException("Defina o Back (URL) da loja para baixar os pedidos.");

        var warnings = new List<string>();
        var (orders, admin) = await FetchRemoteOrdersAsync(store!, baseUrl, warnings, ct);

        if (dryRun)
        {
            var existing = await LoadExistingOrderIdsAsync(ct);
            int dryCreated = 0, dryReplaced = 0;
            foreach (var o in orders)
            {
                if (existing.Contains(o.OrderId)) dryReplaced++; else dryCreated++;
            }
            return new ToolsOrdersSyncReportDto(storeId, true, admin ? "admin" : "public",
                dryCreated, dryReplaced, 0, 0, warnings, null);
        }

        var (created, replaced, equal, failed) = await ApplyOrdersAsync(storeId, orders, ct);
        return new ToolsOrdersSyncReportDto(storeId, false, admin ? "admin" : "public",
            created, replaced, equal, failed, warnings, null);
    }

    /// <summary>Baixa os pedidos do remoto (loop por status, deduplica por OrderId).</summary>
    private async Task<(List<RemoteOrderDto> Orders, bool Admin)> FetchRemoteOrdersAsync(
        PlatformStoreDto store, string baseUrl, List<string> warnings, CancellationToken ct)
    {
        var admin = !string.IsNullOrWhiteSpace(store.BackUsername) && !string.IsNullOrWhiteSpace(store.BackPassword);
        string? token = null;
        if (admin)
        {
            try { token = await LoginRemoteAsync(baseUrl, store.BackUsername!, store.BackPassword!, ct); }
            catch (Exception ex) { warnings.Add($"Login remoto falhou: {ex.Message}"); admin = false; }
        }

        var byId = new Dictionary<string, RemoteOrderDto>(StringComparer.Ordinal);
        var statuses = new List<string?> { null };
        statuses.AddRange(_knownOrderStatuses);

        JsonSerializerOptions opts = new() { PropertyNameCaseInsensitive = true };

        foreach (var status in statuses)
        {
            if (byId.Count >= 5000) break;
            var statusQ = string.IsNullOrWhiteSpace(status) ? "" : $"&status={Uri.EscapeDataString(status)}";
            try
            {
                using var client = _httpFactory.CreateClient("remote");
                using var req = new HttpRequestMessage(HttpMethod.Get,
                    $"{NormalizeApiBase(baseUrl)}/api/v1/orders?limit=300{statusQ}");
                if (admin && !string.IsNullOrWhiteSpace(token))
                    req.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
                using var resp = await client.SendAsync(req, ct);
                if (resp.StatusCode == System.Net.HttpStatusCode.Forbidden || resp.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                    throw new InvalidOperationException(
                        "A API remota recusou o acesso aos pedidos. Use credenciais de um usuário Admin ou Atendimento no campo Back da loja.");
                if (!resp.IsSuccessStatusCode)
                    throw new InvalidOperationException($"GET /orders remoto falhou (HTTP {(int)resp.StatusCode}).");
                var text = await resp.Content.ReadAsStringAsync(ct);
                using var doc = JsonDocument.Parse(text);
                foreach (var el in doc.RootElement.EnumerateArray())
                {
                    var o = el.Deserialize<RemoteOrderDto>(opts);
                    if (o is null || string.IsNullOrWhiteSpace(o.OrderId)) continue;
                    byId[o.OrderId] = o;
                }
            }
            catch (InvalidOperationException)
            {
                throw;
            }
            catch (Exception ex)
            {
                warnings.Add($"Falha ao baixar pedidos (status '{status ?? "todos"}'): {ex.Message}");
            }
        }

        return (byId.Values.ToList(), admin);
    }

    /// <summary>Carrega os OrderIds locais existentes.</summary>
    private async Task<HashSet<string>> LoadExistingOrderIdsAsync(CancellationToken ct)
    {
        var set = new HashSet<string>(StringComparer.Ordinal);
        await WithBypassAsync(async (conn, tx, token) =>
        {
            await using var cmd = new NpgsqlCommand(
                """SELECT "OrderId" FROM orders""", conn, tx);
            await using var reader = await cmd.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
            {
                var id = reader.GetString(0);
                if (!string.IsNullOrWhiteSpace(id)) set.Add(id);
            }
            return set;
        }, ct);
        return set;
    }

    /// <summary>
    /// Aplica o upsert dos pedidos remotos na tabela `orders` local (RLS off), contando criados/substituídos.
    /// Retorna (created, replaced, equal, failed).
    /// </summary>
    private async Task<(int Created, int Replaced, int Equal, int Failed)> ApplyOrdersAsync(
        int storeId, List<RemoteOrderDto> orders, CancellationToken ct)
    {
        return await WithBypassAsync(async (conn, tx, token) =>
        {
            var existing = new HashSet<string>(StringComparer.Ordinal);
            await using (var sel = new NpgsqlCommand("""SELECT "OrderId" FROM orders""", conn, tx))
            await using (var reader = await sel.ExecuteReaderAsync(token))
            {
                while (await reader.ReadAsync(token))
                {
                    var id = reader.IsDBNull(0) ? null : reader.GetString(0);
                    if (!string.IsNullOrWhiteSpace(id)) existing.Add(id);
                }
            }

            int created = 0, replaced = 0, equal = 0, failed = 0;
            foreach (var o in orders)
            {
                try
                {
                    await using var cmd = new NpgsqlCommand(
                        """
                        INSERT INTO orders (
                            "OrderId", "StoreId", "CustomerName", "CustomerPhone", "Address",
                            "Neighborhood", "Reference", "Cep", "PaymentMethod", "PaymentTiming",
                            "PaymentStatus", "Notes", "DeliveryFee", "ItemsTotal", "ItemsJson",
                            "Status", "CreatedAtUtc", "StatusUpdatedAtUtc", "AcceptedAtUtc",
                            "CustomerReceivedAtUtc", "CancellationReasonCode", "CancellationReason",
                            "CancellationCustomerRequested", "FulfillmentType", "ItemsUpdatedAtUtc",
                            "ItemsChangeSummary", "PreviousItemsTotal", "NeedsChange", "ChangeFor"
                        )
                        VALUES (
                            @oid, @store, @cname, @cphone, @addr,
                            @neighbor, @ref, @cep, @pay, @timing,
                            @paystatus, @notes, @fee, @itotal, @itemsjson,
                            @status, @created, @statusUpdated, @accepted,
                            @received, @cancelCode, @cancelReason,
                            @cancelRequested, @fulfillment, @itemsUpdated,
                            @itemsSummary, @prevTotal, @needsChange, @changeFor
                        )
                        ON CONFLICT ("OrderId") DO UPDATE SET
                            "StoreId" = EXCLUDED."StoreId",
                            "CustomerName" = EXCLUDED."CustomerName",
                            "CustomerPhone" = EXCLUDED."CustomerPhone",
                            "Address" = EXCLUDED."Address",
                            "Neighborhood" = EXCLUDED."Neighborhood",
                            "Reference" = EXCLUDED."Reference",
                            "Cep" = EXCLUDED."Cep",
                            "PaymentMethod" = EXCLUDED."PaymentMethod",
                            "PaymentTiming" = EXCLUDED."PaymentTiming",
                            "PaymentStatus" = EXCLUDED."PaymentStatus",
                            "Notes" = EXCLUDED."Notes",
                            "DeliveryFee" = EXCLUDED."DeliveryFee",
                            "ItemsTotal" = EXCLUDED."ItemsTotal",
                            "ItemsJson" = EXCLUDED."ItemsJson",
                            "Status" = EXCLUDED."Status",
                            "CreatedAtUtc" = EXCLUDED."CreatedAtUtc",
                            "StatusUpdatedAtUtc" = EXCLUDED."StatusUpdatedAtUtc",
                            "AcceptedAtUtc" = EXCLUDED."AcceptedAtUtc",
                            "CustomerReceivedAtUtc" = EXCLUDED."CustomerReceivedAtUtc",
                            "CancellationReasonCode" = EXCLUDED."CancellationReasonCode",
                            "CancellationReason" = EXCLUDED."CancellationReason",
                            "CancellationCustomerRequested" = EXCLUDED."CancellationCustomerRequested",
                            "FulfillmentType" = EXCLUDED."FulfillmentType",
                            "ItemsUpdatedAtUtc" = EXCLUDED."ItemsUpdatedAtUtc",
                            "ItemsChangeSummary" = EXCLUDED."ItemsChangeSummary",
                            "PreviousItemsTotal" = EXCLUDED."PreviousItemsTotal",
                            "NeedsChange" = EXCLUDED."NeedsChange",
                            "ChangeFor" = EXCLUDED."ChangeFor"
                        """, conn, tx);
                    cmd.Parameters.AddWithValue("oid", o.OrderId);
                    cmd.Parameters.AddWithValue("store", storeId);
                    cmd.Parameters.AddWithValue("cname", o.CustomerName ?? "");
                    cmd.Parameters.AddWithValue("cphone", o.CustomerPhone ?? "");
                    cmd.Parameters.AddWithValue("addr", o.Address ?? "");
                    cmd.Parameters.AddWithValue("neighbor", (object?)o.Neighborhood ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("ref", (object?)o.Reference ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("cep", (object?)o.Cep ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("pay", o.PaymentMethod ?? "");
                    cmd.Parameters.AddWithValue("timing", string.IsNullOrEmpty(o.PaymentTiming) ? "on_delivery" : o.PaymentTiming);
                    cmd.Parameters.AddWithValue("paystatus", string.IsNullOrEmpty(o.PaymentStatus) ? "on_delivery" : o.PaymentStatus);
                    cmd.Parameters.AddWithValue("notes", (object?)o.Notes ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("fee", o.DeliveryFee);
                    cmd.Parameters.AddWithValue("itotal", o.ItemsTotal);
                    cmd.Parameters.AddWithValue("itemsjson", SerializeItemsJson(o.Items));
                    cmd.Parameters.AddWithValue("status", string.IsNullOrEmpty(o.Status) ? "Created" : o.Status);
                    cmd.Parameters.AddWithValue("created", o.CreatedAtUtc);
                    cmd.Parameters.AddWithValue("statusUpdated", (object?)o.StatusUpdatedAtUtc ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("accepted", (object?)o.AcceptedAtUtc ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("received", (object?)o.CustomerReceivedAtUtc ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("cancelCode", (object?)o.CancellationReasonCode ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("cancelReason", (object?)o.CancellationReason ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("cancelRequested", o.CancellationCustomerRequested);
                    cmd.Parameters.AddWithValue("fulfillment", string.IsNullOrEmpty(o.FulfillmentType) ? "delivery" : o.FulfillmentType);
                    cmd.Parameters.AddWithValue("itemsUpdated", (object?)o.ItemsUpdatedAtUtc ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("itemsSummary", (object?)o.ItemsChangeSummary ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("prevTotal", (object?)o.PreviousItemsTotal ?? DBNull.Value);
                    cmd.Parameters.AddWithValue("needsChange", o.NeedsChange);
                    cmd.Parameters.AddWithValue("changeFor", (object?)o.ChangeFor ?? DBNull.Value);
                    await cmd.ExecuteNonQueryAsync(token);

                    if (existing.Contains(o.OrderId)) replaced++; else created++;
                    existing.Add(o.OrderId);
                }
                catch (Exception ex)
                {
                    failed++;
                    _logger.LogWarning(ex, "Falha ao sincronizar pedido {OrderId}", o.OrderId);
                }
            }
            return (created, replaced, equal, failed);
        }, ct);
    }

    /// <summary>Serializa a lista de itens no formato ItemsJson esperado pela tabela orders.</summary>
    private static string SerializeItemsJson(List<RemoteOrderItemDto>? items)
    {
        var normalized = (items ?? new List<RemoteOrderItemDto>())
            .Select(i => new RemoteOrderItemDto(i.ProductId, i.Name ?? "", i.Price, i.Quantity))
            .ToList();
        return JsonSerializer.Serialize(normalized);
    }
}
