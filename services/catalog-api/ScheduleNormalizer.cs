using Catalog.Api.Models;

namespace Catalog.Api;

/// <summary>
/// Constrói a forma canônica do horário de funcionamento: 7 entradas em <c>PerDay</c>
/// (uma por dia da semana), preenchendo intervalos, prazos por dia e os espelhos legados
/// (Days/Open/Close). Aceita dados antigos (sem PerDay) e converte na leitura/gravação.
/// </summary>
public static class ScheduleNormalizer
{
    public const string DefaultOpen = "18:00";
    public const string DefaultClose = "23:55";

    public static ScheduleDto EnsurePerDay(ScheduleDto? schedule)
    {
        schedule ??= new ScheduleDto([], DefaultOpen, DefaultClose, "Fechado.");

        if (schedule.PerDay is { Length: > 0 })
            return WithLegacyMirrors(schedule, BuildCanonical(schedule.PerDay, schedule.Open, schedule.Close));

        var days = (schedule.Days ?? []).Where(d => d is >= 0 and <= 6).ToHashSet();
        return WithLegacyMirrors(schedule, BuildFromLegacy(days, schedule.Open, schedule.Close));
    }

    public static ScheduleDayDto? GetDay(ScheduleDto? schedule, int day)
    {
        if (schedule?.PerDay is { Length: > 0 })
            return schedule.PerDay.FirstOrDefault(p => p.Day == day);
        if (schedule is null) return null;
        var enabled = (schedule.Days ?? []).Contains(day);
        return new ScheduleDayDto(
            day,
            enabled,
            ValidClock(schedule.Open) ? schedule.Open : DefaultOpen,
            ValidClock(schedule.Close) ? schedule.Close : DefaultClose);
    }

    public static int? DeliveryMinutesFor(ScheduleDto? schedule, int day) =>
        GetDay(schedule, day)?.DeliveryMinutes;

    public static bool ValidClock(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        var parts = value.Trim().Split(':');
        if (parts.Length != 2) return false;
        if (parts[0].Length != 2 || parts[1].Length != 2) return false;
        if (!int.TryParse(parts[0], out var h) || !int.TryParse(parts[1], out var m)) return false;
        return h is >= 0 and <= 23 && m is >= 0 and <= 59;
    }

    private static ScheduleDayDto[] BuildFromLegacy(HashSet<int> days, string open, string close)
    {
        var o = ValidClock(open) ? open : DefaultOpen;
        var c = ValidClock(close) ? close : DefaultClose;
        var result = new ScheduleDayDto[7];
        for (var day = 0; day < 7; day++)
        {
            result[day] = days.Contains(day)
                ? new ScheduleDayDto(day, true, o, c)
                : new ScheduleDayDto(day, false, DefaultOpen, DefaultClose);
        }
        return result;
    }

    private static ScheduleDayDto[] BuildCanonical(ScheduleDayDto[] perDay, string fallbackOpen, string fallbackClose)
    {
        var o = ValidClock(fallbackOpen) ? fallbackOpen : DefaultOpen;
        var c = ValidClock(fallbackClose) ? fallbackClose : DefaultClose;
        var byDay = perDay
            .Where(p => p is not null && p.Day is >= 0 and <= 6)
            .ToDictionary(p => p.Day);

        var result = new ScheduleDayDto[7];
        for (var day = 0; day < 7; day++)
        {
            if (byDay.TryGetValue(day, out var p))
            {
                result[day] = p with
                {
                    Open = ValidClock(p.Open) ? p.Open : o,
                    Close = ValidClock(p.Close) ? p.Close : c,
                    BreakEnabled = p.BreakEnabled && ValidClock(p.BreakStart) && ValidClock(p.BreakEnd),
                    BreakStart = ValidClock(p.BreakStart) ? p.BreakStart : "",
                    BreakEnd = ValidClock(p.BreakEnd) ? p.BreakEnd : "",
                    DeliveryMinutes = p.DeliveryMinutes is >= 0 and <= 24 * 60 ? p.DeliveryMinutes : null
                };
            }
            else
            {
                result[day] = new ScheduleDayDto(day, false, o, c);
            }
        }
        return result;
    }

    private static ScheduleDto WithLegacyMirrors(ScheduleDto source, ScheduleDayDto[] canonical)
    {
        var enabled = canonical.Where(d => d.Enabled).OrderBy(d => d.Day).ToArray();
        var first = enabled.FirstOrDefault();
        return source with
        {
            Days = enabled.Select(d => d.Day).ToArray(),
            Open = first is null ? (ValidClock(source.Open) ? source.Open : DefaultOpen) : first.Open,
            Close = first is null ? (ValidClock(source.Close) ? source.Close : DefaultClose) : first.Close,
            ClosedMessage = (source.ClosedMessage ?? "").Trim(),
            PerDay = canonical
        };
    }
}
