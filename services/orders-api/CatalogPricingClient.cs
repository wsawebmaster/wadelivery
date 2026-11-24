using System.Net.Http.Json;
using System.Text.Json;
using System.Text.RegularExpressions;
using Orders.Api.Models;

namespace Orders.Api;

public class CatalogPricingClient
{
    private readonly HttpClient http;
    private readonly ILogger<CatalogPricingClient> logger;

    public CatalogPricingClient(
        HttpClient http,
        ILogger<CatalogPricingClient> logger,
        IHttpContextAccessor? httpContextAccessor = null)
    {
        this.http = http;
        this.logger = logger;

        var request = httpContextAccessor?.HttpContext?.Request;
        var slug = request?.Headers["X-Tenant-Slug"].FirstOrDefault()
            ?? request?.Query["tenant"].FirstOrDefault()
            ?? request?.Query["slug"].FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(slug))
            http.DefaultRequestHeaders.TryAddWithoutValidation("X-Tenant-Slug", slug);

        var authorization = request?.Headers.Authorization.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(authorization))
            http.DefaultRequestHeaders.TryAddWithoutValidation("Authorization", authorization);
    }

    public const string StoreUnavailableMessage = "Loja indisponível no momento. Não é possível fazer pedidos.";

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public async Task<(List<OrderItemDto> PricedItems, decimal ItemsTotal, string? Error)> PriceItemsAsync(
        IEnumerable<OrderItemDto> requested,
        CancellationToken ct)
    {
        CatalogPayload? catalog;
        try
        {
            catalog = await http.GetFromJsonAsync<CatalogPayload>("api/v1/catalog", JsonOptions, ct);
        }
        catch (HttpRequestException ex) when (ex.StatusCode == System.Net.HttpStatusCode.Forbidden)
        {
            // Loja bloqueada (inadimplência ou bloqueio manual): o catálogo responde 403.
            logger.LogInformation("Pedido recusado: loja inativa");
            return ([], 0, StoreUnavailableMessage);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ao obter catálogo para precificar pedido");
            return ([], 0, "Não foi possível validar os preços do cardápio. Tente novamente.");
        }

        var byId = new Dictionary<string, ProductPayload>(StringComparer.OrdinalIgnoreCase);
        var byName = new Dictionary<string, ProductPayload>(StringComparer.OrdinalIgnoreCase);
        foreach (var cat in catalog?.Categories ?? [])
        {
            foreach (var item in cat.Items ?? [])
            {
                if (!string.IsNullOrWhiteSpace(item.Id))
                    byId[item.Id] = item;
                if (!string.IsNullOrWhiteSpace(item.Name))
                    byName[item.Name.Trim()] = item;
            }
        }

        var priced = new List<OrderItemDto>();
        decimal total = 0;
        foreach (var line in requested)
        {
            ProductPayload? product = null;
            if (!string.IsNullOrWhiteSpace(line.ProductId) && byId.TryGetValue(line.ProductId, out var byIdProduct))
                product = byIdProduct;
            else
            {
                var baseName = OrderValidation.BaseProductName(line.Name);
                if (byName.TryGetValue(baseName, out var byNameProduct))
                    product = byNameProduct;
            }

            if (product is null)
                return ([], 0, $"Produto não encontrado no cardápio: {OrderValidation.BaseProductName(line.Name)}");

            var unit = ResolveUnitPrice(product, line.Name);
            if (unit < 0) return ([], 0, "Preço inválido no cardápio.");

            // Adicionais: parte do que o cliente enviou. Pedidos antigos (ou clientes em
            // cache anterior ao suporte a modifiers) podem ter o adicional gravado apenas
            // no texto do nome ("(Adic. Bacon +8,00)") — recupera pelo nome para não perder
            // o valor na re-precificação.
            var requestedModifiers = line.Modifiers;
            if (requestedModifiers is null || requestedModifiers.Count == 0)
            {
                requestedModifiers = RecoverModifiersFromName(product, line.Name);
                if (requestedModifiers.Count > 0)
                    logger.LogInformation(
                        "Adicionais recuperados do nome em '{Product}': {Count}",
                        OrderValidation.BaseProductName(line.Name), requestedModifiers.Count);
            }

            // Valida/calcula adições (grupos de modificadores) a partir do catálogo —
            // nunca confia no valor/preço enviado pelo cliente.
            var modifiers = new List<OrderItemModifierDto>();
            foreach (var mod in requestedModifiers)
            {
                if (string.IsNullOrWhiteSpace(mod.GroupId) || string.IsNullOrWhiteSpace(mod.OptionId))
                    return ([], 0, $"Adição inválida em '{OrderValidation.BaseProductName(line.Name)}'.");
                var group = product.ModifierGroups?.FirstOrDefault(g =>
                    string.Equals(g.Id, mod.GroupId, StringComparison.OrdinalIgnoreCase));
                if (group is null)
                    return ([], 0, $"Opção de adição não disponível para '{OrderValidation.BaseProductName(line.Name)}'.");
                var option = group.Options?.FirstOrDefault(o =>
                    string.Equals(o.Id, mod.OptionId, StringComparison.OrdinalIgnoreCase));
                if (option is null || option.Available == false)
                    return ([], 0, $"Opção '{mod.Name}' indisponível para '{OrderValidation.BaseProductName(line.Name)}'.");
                modifiers.Add(new OrderItemModifierDto(
                    group.Id, option.Id, option.Name ?? "", option.PriceDelta));
            }

            // Regra de escolha dos grupos (mín/máx de opções selecionadas).
            foreach (var group in product.ModifierGroups ?? [])
            {
                var selected = modifiers.Count(m => string.Equals(m.GroupId, group.Id, StringComparison.OrdinalIgnoreCase));
                var min = Math.Max(0, group.Min);
                var max = group.Max <= 0 ? 10 : group.Max;
                if (selected < min)
                    return ([], 0, $"Selecione ao menos {min} opção(ões) em '{group.Name}'.");
                if (selected > max)
                    return ([], 0, $"Máximo de {max} opção(ões) em '{group.Name}'.");
            }

            var delta = modifiers.Sum(m => m.PriceDelta);
            unit += delta;
            var qty = line.Quantity;
            total += unit * qty;
            priced.Add(new OrderItemDto(line.ProductId, line.Name.Trim(), unit, qty,
                modifiers.Count == 0 ? null : modifiers));
        }

        return (priced, Math.Round(total, 2, MidpointRounding.AwayFromZero), null);
    }

    /// <summary>
    /// Preço unitário considerando o tamanho escolhido (Média/Inteira) nas porções.
    /// </summary>
    public static decimal ResolveUnitPrice(ProductPayload product, string lineName)
    {
        return OrderValidation.ExtractSizeOption(lineName) switch
        {
            "Média" when product.PriceMedia is > 0 => product.PriceMedia.Value,
            "Inteira" when product.PriceInteira is > 0 => product.PriceInteira.Value,
            _ => product.Price
        };
    }

    /// <summary>
    /// Reconstrói adicionais a partir do texto do nome da linha ("Adic. Bacon +8,00"),
    /// casando o nome da opção no catálogo (sem acentos/caixa). Melhor esforço: opções sem
    /// correspondência (removidas/renomeadas/indisponíveis) são ignoradas — o valor cobrado
    /// vem sempre do catálogo, nunca do texto.
    /// </summary>
    internal static List<OrderItemModifierDto> RecoverModifiersFromName(ProductPayload product, string? lineName)
    {
        var recovered = new List<OrderItemModifierDto>();
        if (product.ModifierGroups is null) return recovered;

        foreach (var addonName in OrderValidation.ExtractAddonNames(lineName))
        {
            var target = OrderValidation.NormalizeLabel(addonName);
            if (target.Length == 0) continue;

            ModifierGroupPayload? group = null;
            ModifierOptionPayload? option = null;
            foreach (var g in product.ModifierGroups)
            {
                var found = g.Options?.FirstOrDefault(o =>
                    !string.IsNullOrWhiteSpace(o.Name)
                    && string.Equals(OrderValidation.NormalizeLabel(o.Name), target, StringComparison.Ordinal));
                if (found is not null)
                {
                    group = g;
                    option = found;
                    break;
                }
            }

            if (group is null || option is null || option.Available == false) continue;
            if (string.IsNullOrWhiteSpace(group.Id) || string.IsNullOrWhiteSpace(option.Id)) continue;
            if (recovered.Any(m => string.Equals(m.OptionId, option.Id, StringComparison.OrdinalIgnoreCase))) continue;

            recovered.Add(new OrderItemModifierDto(group.Id, option.Id, option.Name ?? addonName, option.PriceDelta));
        }

        return recovered;
    }

    public static bool IsPickup(CreateOrderRequest body) =>
        string.Equals((body.FulfillmentType ?? "").Trim(), "pickup", StringComparison.OrdinalIgnoreCase);

    public static bool IsDineIn(CreateOrderRequest body) =>
        string.Equals((body.FulfillmentType ?? "").Trim(), "dine_in", StringComparison.OrdinalIgnoreCase);

    public async Task<(decimal Fee, string? Error)> QuoteDeliveryAsync(
        CreateOrderRequest body,
        CancellationToken ct)
    {
        if (IsPickup(body) || IsDineIn(body))
            return (0, null);

        try
        {
            var store = await http.GetFromJsonAsync<StorePayload>("api/v1/store", JsonOptions, ct);
            if (store is null)
                return (0, "Loja indisponível para calcular entrega.");

            // Por km (taxa/km > 0) ou taxa fixa (taxa/km 0 + taxa mínima > 0): ambos usam a
            // cotação por distância, que aplica o raio máximo.
            var usesKm = store.Latitude is not null
                && store.Longitude is not null
                && (store.DeliveryFeePerKm > 0 || store.MinDeliveryFee > 0);

            if (usesKm)
            {
                var (street, numberFromAddress) = SplitStreetAndNumber(body.Address);
                var number = FirstNonEmpty(body.Number, numberFromAddress);
                var quoteReq = new
                {
                    latitude = body.CustomerLatitude,
                    longitude = body.CustomerLongitude,
                    cep = body.Cep,
                    address = street,
                    number,
                    neighborhood = body.Neighborhood,
                    city = body.City,
                    state = body.State
                };

                using var res = await http.PostAsJsonAsync("api/v1/delivery/quote", quoteReq, ct);
                if (res.IsSuccessStatusCode)
                {
                    var quote = await res.Content.ReadFromJsonAsync<QuotePayload>(JsonOptions, ct);
                    if (quote is not null)
                    {
                        if (quote.Ok && quote.WithinRange)
                            return (DeliveryFeeRounding.RoundUpToHalfReal(Math.Max(0, quote.Fee)), null);

                        // Cotação falhou (geocode etc.): usa taxa já calculada no cardápio, se houver.
                        if (body.DeliveryFee > 0)
                        {
                            logger.LogWarning(
                                "Quote km falhou ({Error}); usando deliveryFee do cliente {Fee}",
                                quote.Error, body.DeliveryFee);
                            return (ApplyMinFee(body.DeliveryFee, store.MinDeliveryFee), null);
                        }

                        return (0, quote.Error ?? "Não foi possível calcular a taxa de entrega.");
                    }
                }
                else
                {
                    logger.LogWarning("delivery/quote HTTP {Status}", (int)res.StatusCode);
                }

                if (body.DeliveryFee > 0)
                {
                    logger.LogWarning("Usando deliveryFee do cliente após falha HTTP no quote: {Fee}", body.DeliveryFee);
                    return (ApplyMinFee(body.DeliveryFee, store.MinDeliveryFee), null);
                }

                return (0, "Não foi possível calcular a taxa de entrega.");
            }

            // Fallback: taxa por bairro (quando km não está configurado)
            var neighborhood = string.IsNullOrWhiteSpace(body.Neighborhood)
                ? OrderMapping.InferNeighborhood(body.Address)
                : body.Neighborhood.Trim();

            if (!string.IsNullOrWhiteSpace(neighborhood)
                && store.DeliveryFees is not null
                && TryGetNeighborhoodFee(store.DeliveryFees, neighborhood, out var fee))
            {
                return (ApplyMinFee(Math.Max(0, fee), store.MinDeliveryFee), null);
            }

            if (body.DeliveryFee > 0)
            {
                logger.LogWarning(
                    "Bairro sem taxa cadastrada ({Neighborhood}); usando deliveryFee do cliente {Fee}",
                    neighborhood, body.DeliveryFee);
                return (ApplyMinFee(body.DeliveryFee, store.MinDeliveryFee), null);
            }

            return (0, "Este bairro não está na área de entrega configurada.");
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ao cotar entrega");
            if (body.DeliveryFee > 0)
                return (DeliveryFeeRounding.RoundUpToHalfReal(body.DeliveryFee), null);
            return (0, "Não foi possível calcular a taxa de entrega.");
        }
    }

    /// <summary>
    /// Consulta o status de aceite da loja (expediente/intervalo) para bloquear pedidos fora do
    /// horário. Retorna null quando o catálogo está inacessível — nesse caso o chamador faz
    /// fail-open (aceita o pedido) para não derrubar pedidos por falha de infra.
    /// </summary>
    public async Task<(bool Accepting, string? Message)?> GetStoreStatusAsync(CancellationToken ct)
    {
        try
        {
            var status = await http.GetFromJsonAsync<StoreStatusPayload>("api/v1/store/status", JsonOptions, ct);
            return status is null
                ? (true, null)
                : (status.Accepting, status.Message);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ao consultar status da loja; prosseguindo (fail-open)");
            return null;
        }
    }

    /// <summary>
    /// Consulta a configuração de avanço automático ("Confirmado → Em preparação") da loja.
    /// Em falha de infra retorna Desabilitado (fail-closed) para nunca avançar pedidos indevidamente.
    /// </summary>
    public async Task<(bool Enabled, int Minutes)> GetAutoAdvanceConfigAsync(CancellationToken ct)
    {
        try
        {
            var store = await http.GetFromJsonAsync<AutoAdvancePayload>("api/v1/store", JsonOptions, ct);
            if (store is null || !store.AutoAdvancePreparing)
                return (false, 0);

            var minutes = store.AutoAdvancePreparingMinutes > 0 ? store.AutoAdvancePreparingMinutes : 5;
            return (true, minutes);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ao consultar config de avanço automático; desabilitando (fail-closed)");
            return (false, 0);
        }
    }

    private static decimal ApplyMinFee(decimal fee, decimal minFee)
    {
        var value = minFee > 0 && fee < minFee ? minFee : fee;
        return DeliveryFeeRounding.RoundUpToHalfReal(value);
    }

    private static bool TryGetNeighborhoodFee(
        Dictionary<string, decimal> fees,
        string neighborhood,
        out decimal fee)
    {
        if (fees.TryGetValue(neighborhood, out fee))
            return true;

        var match = fees.FirstOrDefault(kv =>
            string.Equals(kv.Key.Trim(), neighborhood.Trim(), StringComparison.OrdinalIgnoreCase));
        if (!string.IsNullOrEmpty(match.Key))
        {
            fee = match.Value;
            return true;
        }

        fee = 0;
        return false;
    }

    /// <summary>
    /// Endereço do storefront: "Rua X, 123, Bairro, Cidade - UF"
    /// </summary>
    private static (string Street, string? Number) SplitStreetAndNumber(string? address)
    {
        if (string.IsNullOrWhiteSpace(address))
            return ("", null);

        var parts = address.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0)
            return ("", null);

        var street = parts[0];
        string? number = null;
        if (parts.Length >= 2 && Regex.IsMatch(parts[1], @"^\d+[A-Za-z]?$"))
            number = parts[1];

        return (street, number);
    }

    private static string? FirstNonEmpty(params string?[] values)
    {
        foreach (var v in values)
        {
            if (!string.IsNullOrWhiteSpace(v))
                return v.Trim();
        }
        return null;
    }

    private sealed class CatalogPayload
    {
        public List<CategoryPayload>? Categories { get; set; }
    }

    private sealed class CategoryPayload
    {
        public List<ProductPayload>? Items { get; set; }
    }

    public sealed class ProductPayload
    {
        public string? Id { get; set; }
        public string? Name { get; set; }
        public decimal Price { get; set; }
        public decimal? PriceMedia { get; set; }
        public decimal? PriceInteira { get; set; }
        public List<ModifierGroupPayload>? ModifierGroups { get; set; }
    }

    /// <summary>
    /// Payload de grupo de modificadores vindo do catálogo público. Apenas o que a
    /// precificação precisa: ids, nomes, regras de escolha e preço das opções.
    /// </summary>
    public sealed class ModifierGroupPayload
    {
        public string? Id { get; set; }
        public string? Name { get; set; }
        public int Min { get; set; }
        public int Max { get; set; }
        public List<ModifierOptionPayload>? Options { get; set; }
    }

    public sealed class ModifierOptionPayload
    {
        public string? Id { get; set; }
        public string? Name { get; set; }
        public decimal PriceDelta { get; set; }
        public bool Available { get; set; } = true;
    }

    private sealed class StorePayload
    {
        public double? Latitude { get; set; }
        public double? Longitude { get; set; }
        public decimal DeliveryFeePerKm { get; set; }
        public decimal MinDeliveryFee { get; set; }
        public Dictionary<string, decimal>? DeliveryFees { get; set; }
    }

    private sealed class StoreStatusPayload
    {
        public bool AcceptingOrders { get; set; }
        public bool Open { get; set; }
        public bool OnBreak { get; set; }
        public bool Accepting { get; set; }
        public string? Message { get; set; }
    }

    private sealed class AutoAdvancePayload
    {
        public bool AutoAdvancePreparing { get; set; }
        public int AutoAdvancePreparingMinutes { get; set; }
    }

    /// <summary>
    /// Consulta as feature flags de consumo no local da loja.
    /// Em falha de infra retorna tudo desabilitado (fail-closed) — nunca ativa
    /// um recurso novo por erro de infraestrutura.
    /// </summary>
    public async Task<(bool DineInEnabled, bool CustomerQrOrdersEnabled, bool WaiterOrdersEnabled, bool AllowManualTableEntry, bool RequireCustomerNameForQrOrder, bool AllowCustomerChooseWaiter)> GetDineInConfigAsync(CancellationToken ct)
    {
        try
        {
            var store = await http.GetFromJsonAsync<DineInPayload>("api/v1/store", JsonOptions, ct);
            if (store is null)
                return (false, false, false, false, false, false);
            return (
                store.DineInEnabled,
                store.CustomerQrOrdersEnabled,
                store.WaiterOrdersEnabled,
                store.AllowManualTableEntry,
                store.RequireCustomerNameForQrOrder,
                store.AllowCustomerChooseWaiter);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ao consultar config de dine-in; desabilitando (fail-closed)");
            return (false, false, false, false, false, false);
        }
    }

    private sealed class DineInPayload
    {
        public bool DineInEnabled { get; set; }
        public bool CustomerQrOrdersEnabled { get; set; }
        public bool WaiterOrdersEnabled { get; set; }
        public bool AllowManualTableEntry { get; set; }
        public bool RequireCustomerNameForQrOrder { get; set; }
        public bool AllowCustomerChooseWaiter { get; set; }
    }

    private sealed class QuotePayload
    {
        public bool Ok { get; set; }
        public bool WithinRange { get; set; }
        public decimal Fee { get; set; }
        public string? Error { get; set; }
    }
}
