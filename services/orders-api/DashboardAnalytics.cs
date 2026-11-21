using Orders.Api.Data;
using Orders.Api.Models;

namespace Orders.Api;

public static class DashboardAnalytics
{
    private static readonly TimeZoneInfo AppTimeZone = ResolveAppTimeZone();

    public readonly record struct Range(
        DateTime FromUtc,
        DateTime ToUtc,
        int Days,
        string Period,
        string PeriodLabel);

    public static Range ResolveRange(string? period, int? days)
    {
        var nowUtc = DateTime.UtcNow;
        var todayLocal = DateInAppZone(nowUtc);
        var key = (period ?? string.Empty).Trim().ToLowerInvariant();

        if (string.IsNullOrWhiteSpace(key) && days is int d)
            key = d <= 1 ? "today" : d.ToString();
        if (string.IsNullOrWhiteSpace(key))
            key = "today";

        if (key is "today" or "hoje" or "1")
        {
            return new Range(
                LocalDateToUtc(todayLocal),
                nowUtc,
                1,
                "today",
                "Hoje");
        }

        if (key is "yesterday" or "ontem")
        {
            var yesterday = todayLocal.AddDays(-1);
            var fromUtc = LocalDateToUtc(yesterday);
            var toUtc = LocalDateToUtc(todayLocal).AddTicks(-1);
            return new Range(fromUtc, toUtc, 1, "yesterday", "Ontem");
        }

        if (!int.TryParse(key, out var window))
            window = 30;
        window = Math.Clamp(window, 1, 180);
        var fromLocal = todayLocal.AddDays(-(window - 1));
        return new Range(
            LocalDateToUtc(fromLocal),
            nowUtc,
            window,
            window.ToString(),
            $"{window} dias");
    }

    /// <summary>
    /// Agrega os produtos mais vendidos pelo nome exato (cru, com opção/pão/tamanho),
    /// ordenado decrescente por quantidade e receita. Limita ao topo solicitado.
    /// </summary>
    public static List<NamedCountDto> BuildTopProducts(
        IEnumerable<OrderEntity> orders,
        int limit)
    {
        var map = new Dictionary<string, (long Qty, decimal Revenue)>(StringComparer.OrdinalIgnoreCase);

        foreach (var order in orders)
        {
            foreach (var item in OrderMapping.DeserializeItems(order.ItemsJson))
            {
                var name = string.IsNullOrWhiteSpace(item.Name)
                    ? "Item"
                    : item.Name.Trim();

                if (string.IsNullOrWhiteSpace(name)) name = "Item";

                if (map.TryGetValue(name, out var cur))
                    map[name] = (cur.Qty + item.Quantity, cur.Revenue + item.Price * item.Quantity);
                else
                    map[name] = (item.Quantity, item.Price * item.Quantity);
            }
        }

        return map
            .Select(kv => new NamedCountDto(kv.Key, (int)kv.Value.Qty, kv.Value.Revenue))
            .OrderByDescending(x => x.Count)
            .ThenByDescending(x => x.Revenue)
            .Take(Math.Max(1, limit))
            .ToList();
    }

    public static DashboardResponse Build(
        IEnumerable<OrderEntity> orders,
        Range range)
    {
        var list = orders.ToList();
        var todaySp = DateInAppZone(DateTime.UtcNow);

        var productMap = new Dictionary<string, (int Qty, decimal Revenue)>(StringComparer.OrdinalIgnoreCase);
        var neighborhoodMap = new Dictionary<string, (int Count, decimal Revenue)>(StringComparer.OrdinalIgnoreCase);
        var paymentMap = new Dictionary<string, (int Count, decimal Revenue)>(StringComparer.OrdinalIgnoreCase);
        var cancelReasonMap = new Dictionary<string, (int Count, decimal Revenue)>(StringComparer.OrdinalIgnoreCase);
        var fulfillmentMap = new Dictionary<string, (int Count, decimal Revenue)>(StringComparer.OrdinalIgnoreCase);
        var statusMap = OrderStatus.All.ToDictionary(s => s, _ => 0);

        foreach (var order in list)
        {
            if (statusMap.ContainsKey(order.Status))
                statusMap[order.Status]++;
            else
                statusMap[order.Status] = statusMap.GetValueOrDefault(order.Status) + 1;

            var total = order.ItemsTotal + order.DeliveryFee;

            var neighborhood = string.IsNullOrWhiteSpace(order.Neighborhood)
                ? OrderMapping.InferNeighborhood(order.Address) ?? "Não informado"
                : order.Neighborhood!;
            Upsert(neighborhoodMap, neighborhood, 1, total);

            var payment = string.IsNullOrWhiteSpace(order.PaymentMethod) ? "Não informado" : order.PaymentMethod.Trim();
            Upsert(paymentMap, payment, 1, total);

            var fulfillment = OrderStatus.IsPickup(order.FulfillmentType) ? "Retirada" : "Entrega";
            Upsert(fulfillmentMap, fulfillment, 1, total);

            if (order.Status == OrderStatus.Cancelled)
            {
                var reasonLabel = CancellationReasonLabel(order);
                Upsert(cancelReasonMap, reasonLabel, 1, total);
            }

            foreach (var item in OrderMapping.DeserializeItems(order.ItemsJson))
            {
                var name = string.IsNullOrWhiteSpace(item.Name) ? "Item" : item.Name.Trim();
                Upsert(productMap, name, item.Quantity, item.Price * item.Quantity);
            }
        }

        var fromSp = DateInAppZone(range.FromUtc);
        var toSp = DateInAppZone(range.ToUtc);
        var daily = new List<DailySalesDto>();
        for (var d = fromSp; d <= toSp; d = d.AddDays(1))
        {
            var dayOrders = list.Where(o => DateInAppZone(o.CreatedAtUtc) == d).ToList();
            daily.Add(new DailySalesDto(
                d.ToString("yyyy-MM-dd"),
                dayOrders.Count,
                dayOrders.Sum(o => o.ItemsTotal + o.DeliveryFee)));
        }

        var gross = list.Sum(o => o.ItemsTotal + o.DeliveryFee);
        var itemsRevenue = list.Sum(o => o.ItemsTotal);
        var deliveryRevenue = list.Sum(o => o.DeliveryFee);
        var cancelledOrders = list.Count(o => o.Status == OrderStatus.Cancelled);

        return new DashboardResponse(
            Days: range.Days,
            FromUtc: range.FromUtc,
            ToUtc: range.ToUtc,
            TotalOrders: list.Count,
            OrdersToday: list.Count(o => DateInAppZone(o.CreatedAtUtc) == todaySp),
            OpenOrders: list.Count(o => !OrderStatus.IsTerminal(o.Status)),
            DeliveredOrders: list.Count(o => o.Status == OrderStatus.Delivered),
            CancelledOrders: cancelledOrders,
            GrossRevenue: gross,
            ItemsRevenue: itemsRevenue,
            DeliveryRevenue: deliveryRevenue,
            AverageTicket: list.Count == 0 ? 0 : Math.Round(gross / list.Count, 2),
            ByStatus: OrderStatus.All
                .Select(s => new StatusCountDto(s, OrderStatus.Label(s), statusMap.GetValueOrDefault(s)))
                .ToList(),
            TopProducts: productMap
                .Select(kv => new NamedCountDto(kv.Key, kv.Value.Qty, kv.Value.Revenue))
                .OrderByDescending(x => x.Count)
                .ThenByDescending(x => x.Revenue)
                .Take(10)
                .ToList(),
            TopNeighborhoods: neighborhoodMap
                .Select(kv => new NamedCountDto(kv.Key, kv.Value.Count, kv.Value.Revenue))
                .OrderByDescending(x => x.Count)
                .ThenByDescending(x => x.Revenue)
                .Take(8)
                .ToList(),
            ByPayment: paymentMap
                .Select(kv => new NamedCountDto(kv.Key, kv.Value.Count, kv.Value.Revenue))
                .OrderByDescending(x => x.Count)
                .ToList(),
            ByCancellationReason: cancelReasonMap
                .Select(kv => new NamedCountDto(kv.Key, kv.Value.Count, kv.Value.Revenue))
                .OrderByDescending(x => x.Count)
                .ThenByDescending(x => x.Revenue)
                .Take(8)
                .ToList(),
            ByFulfillment: fulfillmentMap
                .Select(kv => new NamedCountDto(kv.Key, kv.Value.Count, kv.Value.Revenue))
                .OrderByDescending(x => x.Count)
                .ThenByDescending(x => x.Revenue)
                .ToList(),
            DailySales: daily,
            Period: range.Period,
            PeriodLabel: range.PeriodLabel);
    }

    private static string CancellationReasonLabel(OrderEntity order)
    {
        var preset = OrderCancellation.Find(order.CancellationReasonCode);
        if (preset is not null) return preset.Label;

        var text = (order.CancellationReason ?? "").Trim();
        if (!string.IsNullOrWhiteSpace(text))
        {
            return text.Length > 48 ? text[..45] + "…" : text;
        }

        return "Motivo não informado";
    }

    private static DateTime LocalDateToUtc(DateTime localDate)
    {
        var local = DateTime.SpecifyKind(localDate.Date, DateTimeKind.Unspecified);
        return TimeZoneInfo.ConvertTimeToUtc(local, AppTimeZone);
    }

    private static DateTime DateInAppZone(DateTime value)
    {
        var utc = value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Local => value.ToUniversalTime(),
            _ => DateTime.SpecifyKind(value, DateTimeKind.Utc)
        };
        return TimeZoneInfo.ConvertTimeFromUtc(utc, AppTimeZone).Date;
    }

    private static TimeZoneInfo ResolveAppTimeZone()
    {
        try
        {
            return TimeZoneInfo.FindSystemTimeZoneById(
                OperatingSystem.IsWindows() ? "E. South America Standard Time" : "America/Sao_Paulo");
        }
        catch (TimeZoneNotFoundException)
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById("America/Sao_Paulo");
            }
            catch
            {
                return TimeZoneInfo.Utc;
            }
        }
    }

    private static void Upsert(
        Dictionary<string, (int Count, decimal Revenue)> map,
        string key,
        int count,
        decimal revenue)
    {
        if (map.TryGetValue(key, out var cur))
            map[key] = (cur.Count + count, cur.Revenue + revenue);
        else
            map[key] = (count, revenue);
    }
}
