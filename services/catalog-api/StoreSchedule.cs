using Catalog.Api.Models;

namespace Catalog.Api;

public static class StoreSchedule
{
    private static readonly TimeZoneInfo SaoPaulo = ResolveSaoPaulo();

    /// <summary>
    /// Dentro do horário fixo de expediente (ignora intervalo de pausa), ou em extensão de horário.
    /// </summary>
    public static bool IsOpenNow(StoreDto store, DateTime utcNow)
    {
        if (store.ExtendedCloseUntilUtc is DateTime ext && ext > utcNow)
            return true;

        var local = ToLocal(utcNow);
        return ResolveActiveEntry(store.Schedule, (int)local.DayOfWeek, local.Hour * 60 + local.Minute) is not null;
    }

    /// <summary>
    /// A loja está aberta e dentro do intervalo de pausa configurado para o dia corrente.
    /// Extensão de horário (extendedCloseUntilUtc) ignora intervalo.
    /// </summary>
    public static bool IsOnBreakNow(StoreDto store, DateTime utcNow)
    {
        if (store.ExtendedCloseUntilUtc is DateTime ext && ext > utcNow)
            return false;

        var local = ToLocal(utcNow);
        var current = local.Hour * 60 + local.Minute;
        var entry = ResolveActiveEntry(store.Schedule, (int)local.DayOfWeek, current);
        if (entry is null || !entry.BreakEnabled) return false;
        if (!TryParseMinutes(entry.BreakStart, out var start) || !TryParseMinutes(entry.BreakEnd, out var end))
            return false;
        return current >= start && current <= end;
    }

    /// <summary>
    /// Aceita pedidos agora: dentro do expediente, fora do intervalo e com expediente não encerrado
    /// manualmente. Equivale à regra usada pelo cardápio (canAcceptOrders).
    /// </summary>
    public static bool IsAcceptingOrdersNow(StoreDto store, DateTime utcNow) =>
        store.AcceptingOrders && IsOpenNow(store, utcNow) && !IsOnBreakNow(store, utcNow);

    /// <summary>
    /// Próximo instante UTC de encerramento do expediente atual (horário fixo), ou null se fechado.
    /// </summary>
    public static DateTime? GetScheduledCloseUtc(StoreDto store, DateTime utcNow)
    {
        var local = ToLocal(utcNow);
        var day = (int)local.DayOfWeek;
        var current = local.Hour * 60 + local.Minute;
        var entry = ResolveActiveEntry(store.Schedule, day, current);
        if (entry is null) return null;
        if (!TryParseMinutes(entry.Open, out var open) || !TryParseMinutes(entry.Close, out var close))
            return null;

        var overnight = close < open;
        DateTime closeLocal;
        if (entry.Day == day)
            closeLocal = local.Date.AddDays(overnight ? 1 : 0).AddMinutes(close);
        else
            closeLocal = local.Date.AddMinutes(close);

        return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(closeLocal, DateTimeKind.Unspecified), SaoPaulo);
    }

    public static DateTime ComputeExtendedCloseUntilUtc(StoreDto store, DateTime utcNow, int minutes)
    {
        var candidates = new List<DateTime> { utcNow };
        if (store.ExtendedCloseUntilUtc is DateTime ext && ext > utcNow)
            candidates.Add(ext);
        var scheduled = GetScheduledCloseUtc(store, utcNow);
        if (scheduled is DateTime sched && sched > utcNow)
            candidates.Add(sched);

        var bas = candidates.Max();
        return bas.AddMinutes(minutes);
    }

    /// <summary>
    /// Resolve a entrada per-day que governa o momento atual: o dia corrente (horário no mesmo dia
    /// ou início de madrugada) ou o dia anterior (continuação da madrugada). Retorna null quando
    /// a loja está fora do horário.
    /// </summary>
    private static ScheduleDayDto? ResolveActiveEntry(ScheduleDto schedule, int day, int current)
    {
        var today = ScheduleNormalizer.GetDay(schedule, day);
        var yesterday = ScheduleNormalizer.GetDay(schedule, (day + 6) % 7);

        if (today is { Enabled: true }
            && TryParseMinutes(today.Open, out var tOpen)
            && TryParseMinutes(today.Close, out var tClose))
        {
            if (tClose >= tOpen)
            {
                if (current >= tOpen && current <= tClose) return today;
            }
            else if (current >= tOpen)
            {
                return today; // noite da madrugada (abre hoje)
            }
        }

        if (yesterday is { Enabled: true }
            && TryParseMinutes(yesterday.Open, out var yOpen)
            && TryParseMinutes(yesterday.Close, out var yClose)
            && yClose < yOpen
            && current <= yClose)
        {
            return yesterday; // madrugada (continuação do dia anterior)
        }

        return null;
    }

    private static bool TryParseMinutes(string? value, out int minutes)
    {
        minutes = 0;
        var m = (value ?? "").Trim();
        if (m.Length < 4) return false;
        var parts = m.Split(':');
        if (parts.Length != 2) return false;
        if (!int.TryParse(parts[0], out var h) || !int.TryParse(parts[1], out var min)) return false;
        if (h is < 0 or > 23 || min is < 0 or > 59) return false;
        minutes = h * 60 + min;
        return true;
    }

    private static DateTime ToLocal(DateTime utcNow) =>
        TimeZoneInfo.ConvertTimeFromUtc(DateTime.SpecifyKind(utcNow, DateTimeKind.Utc), SaoPaulo);

    private static TimeZoneInfo ResolveSaoPaulo()
    {
        try { return TimeZoneInfo.FindSystemTimeZoneById("America/Sao_Paulo"); }
        catch
        {
            try { return TimeZoneInfo.FindSystemTimeZoneById("E. South America Standard Time"); }
            catch { return TimeZoneInfo.Utc; }
        }
    }
}
