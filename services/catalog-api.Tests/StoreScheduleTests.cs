using Catalog.Api;
using Catalog.Api.Models;

namespace Catalog.Api.Tests;

/// <summary>
/// Testes de lógica do horário por dia (America/Sao_Paulo = UTC-3, sem DST).
/// Datas fixas: 2026-01-04 (dom), 2026-01-05 (seg), 2026-01-06 (ter), 2026-01-07 (qua).
/// </summary>
public class StoreScheduleTests
{
    private static StoreDto Store(ScheduleDayDto[] perDay, bool accepting = true, DateTime? extendedCloseUntilUtc = null) => new(
        "Fabin Lanches",
        null,
        "5516992496886",
        "16992496886",
        "Telefone",
        0,
        "pt-BR",
        new ScheduleDto([], "", "", "Fechado.", perDay),
        new Dictionary<string, decimal>(),
        AcceptingOrders: accepting,
        ExtendedCloseUntilUtc: extendedCloseUntilUtc);

    private static ScheduleDayDto[] Days(params (int Day, string Open, string Close)[] days)
    {
        return Enumerable.Range(0, 7).Select(day =>
        {
            var match = days.FirstOrDefault(x => x.Day == day && x.Open is not null);
            return match.Open is null
                ? new ScheduleDayDto(day, false, "18:00", "23:55")
                : new ScheduleDayDto(day, true, match.Open, match.Close);
        }).ToArray();
    }

    [Fact]
    public void IsOpenNow_returns_true_during_same_day_window()
    {
        var store = Store(Days((1, "11:00", "23:55")));
        var utc = new DateTime(2026, 1, 5, 21, 0, 0, DateTimeKind.Utc); // seg 18:00 local

        Assert.True(StoreSchedule.IsOpenNow(store, utc));
    }

    [Fact]
    public void IsOpenNow_returns_false_outside_window()
    {
        var store = Store(Days((1, "11:00", "23:55")));
        var utc = new DateTime(2026, 1, 5, 8, 0, 0, DateTimeKind.Utc); // seg 05:00 local

        Assert.False(StoreSchedule.IsOpenNow(store, utc));
    }

    [Fact]
    public void IsOpenNow_returns_false_on_disabled_day()
    {
        var store = Store(Days((1, "11:00", "23:55")));
        var utc = new DateTime(2026, 1, 4, 21, 0, 0, DateTimeKind.Utc); // dom 18:00 local

        Assert.False(StoreSchedule.IsOpenNow(store, utc));
    }

    [Fact]
    public void IsOpenNow_handles_overnight_continuation_from_previous_day()
    {
        // Segunda 18:00 → 02:00; na madrugada de terça 01:00 ainda é a "segunda" que vale.
        var store = Store(Days((1, "18:00", "02:00")));
        var utc = new DateTime(2026, 1, 6, 4, 0, 0, DateTimeKind.Utc); // ter 01:00 local

        Assert.True(StoreSchedule.IsOpenNow(store, utc));
    }

    [Fact]
    public void IsOpenNow_handles_overnight_night_of_opening()
    {
        var store = Store(Days((2, "18:00", "02:00")));
        var utc = new DateTime(2026, 1, 6, 23, 0, 0, DateTimeKind.Utc); // ter 20:00 local

        Assert.True(StoreSchedule.IsOpenNow(store, utc));
    }

    [Fact]
    public void IsOpenNow_returns_false_between_overnight_close_and_open()
    {
        var store = Store(Days((1, "18:00", "02:00")));
        var utc = new DateTime(2026, 1, 6, 8, 0, 0, DateTimeKind.Utc); // ter 05:00 local

        Assert.False(StoreSchedule.IsOpenNow(store, utc));
    }

    [Fact]
    public void IsOnBreakNow_returns_true_only_inside_break_window()
    {
        var perDay = Days((1, "11:00", "23:55"));
        perDay[1] = perDay[1] with { BreakEnabled = true, BreakStart = "14:00", BreakEnd = "15:00" };
        var store = Store(perDay);

        var inside = new DateTime(2026, 1, 5, 17, 30, 0, DateTimeKind.Utc); // seg 14:30 local
        var outside = new DateTime(2026, 1, 5, 19, 0, 0, DateTimeKind.Utc); // seg 16:00 local

        Assert.True(StoreSchedule.IsOnBreakNow(store, inside));
        Assert.False(StoreSchedule.IsOnBreakNow(store, outside));
    }

    [Fact]
    public void IsOnBreakNow_returns_false_when_store_closed()
    {
        var perDay = Days((1, "11:00", "23:55"));
        perDay[1] = perDay[1] with { BreakEnabled = true, BreakStart = "14:00", BreakEnd = "15:00" };
        var store = Store(perDay);
        var utc = new DateTime(2026, 1, 4, 17, 30, 0, DateTimeKind.Utc); // dom 14:30 local (fechada)

        Assert.False(StoreSchedule.IsOnBreakNow(store, utc));
    }

    [Fact]
    public void IsAcceptingOrdersNow_combines_accepting_open_and_break()
    {
        var perDay = Days((1, "11:00", "23:55"));
        perDay[1] = perDay[1] with { BreakEnabled = true, BreakStart = "14:00", BreakEnd = "15:00" };
        var store = Store(perDay);

        var open = new DateTime(2026, 1, 5, 19, 0, 0, DateTimeKind.Utc); // seg 16:00 local
        var onBreak = new DateTime(2026, 1, 5, 17, 30, 0, DateTimeKind.Utc); // seg 14:30 local
        var closed = new DateTime(2026, 1, 5, 8, 0, 0, DateTimeKind.Utc); // seg 05:00 local

        Assert.True(StoreSchedule.IsAcceptingOrdersNow(store, open));
        Assert.False(StoreSchedule.IsAcceptingOrdersNow(store, onBreak));
        Assert.False(StoreSchedule.IsAcceptingOrdersNow(store, closed));

        var paused = Store(perDay, accepting: false);
        Assert.False(StoreSchedule.IsAcceptingOrdersNow(paused, open));
    }

    [Fact]
    public void ExtendedClose_ignores_break_and_schedule()
    {
        var perDay = Days((1, "11:00", "23:55"));
        perDay[1] = perDay[1] with { BreakEnabled = true, BreakStart = "14:00", BreakEnd = "15:00" };
        var store = Store(perDay, extendedCloseUntilUtc: new DateTime(2026, 1, 5, 19, 0, 0, DateTimeKind.Utc));
        var utc = new DateTime(2026, 1, 5, 17, 30, 0, DateTimeKind.Utc); // dentro do intervalo

        Assert.True(StoreSchedule.IsOpenNow(store, utc));
        Assert.False(StoreSchedule.IsOnBreakNow(store, utc));
        Assert.True(StoreSchedule.IsAcceptingOrdersNow(store, utc));
    }

    [Fact]
    public void GetScheduledCloseUtc_same_day_window()
    {
        var store = Store(Days((1, "11:00", "23:55")));
        var utc = new DateTime(2026, 1, 5, 21, 0, 0, DateTimeKind.Utc); // seg 18:00 local

        var close = StoreSchedule.GetScheduledCloseUtc(store, utc);

        Assert.Equal(new DateTime(2026, 1, 6, 2, 55, 0, DateTimeKind.Utc), close);
    }

    [Fact]
    public void GetScheduledCloseUtc_overnight_returns_next_day_close()
    {
        var store = Store(Days((1, "18:00", "02:00")));
        var utc = new DateTime(2026, 1, 6, 0, 0, 0, DateTimeKind.Utc); // seg 21:00 local

        var close = StoreSchedule.GetScheduledCloseUtc(store, utc);

        Assert.Equal(new DateTime(2026, 1, 6, 5, 0, 0, DateTimeKind.Utc), close);
    }

    [Fact]
    public void GetScheduledCloseUtc_returns_null_when_closed()
    {
        var store = Store(Days((1, "11:00", "23:55")));
        var utc = new DateTime(2026, 1, 5, 8, 0, 0, DateTimeKind.Utc); // seg 05:00 local

        Assert.Null(StoreSchedule.GetScheduledCloseUtc(store, utc));
    }
}
