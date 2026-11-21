using Catalog.Api;
using Catalog.Api.Models;

namespace Catalog.Api.Tests;

public class ScheduleNormalizerTests
{
    [Fact]
    public void EnsurePerDay_builds_7_entries_from_legacy_days()
    {
        var schedule = new ScheduleDto([1, 2, 3, 4, 5, 6], "11:00", "23:55", "Fechado.");

        var result = ScheduleNormalizer.EnsurePerDay(schedule);

        Assert.Equal(7, result.PerDay!.Length);
        Assert.False(result.PerDay[0].Enabled);
        Assert.All(Enumerable.Range(1, 6), day => Assert.True(result.PerDay[day].Enabled));
        Assert.Equal("11:00", result.PerDay[1].Open);
        Assert.Equal("23:55", result.PerDay[1].Close);
        Assert.False(result.PerDay[1].BreakEnabled);
        Assert.Null(result.PerDay[1].DeliveryMinutes);
    }

    [Fact]
    public void EnsurePerDay_synthesizes_missing_days_as_disabled_with_defaults()
    {
        var schedule = new ScheduleDto([], "", "", "Fechado.");

        var result = ScheduleNormalizer.EnsurePerDay(schedule);

        Assert.Equal(7, result.PerDay!.Length);
        Assert.All(result.PerDay, d => Assert.False(d.Enabled));
        Assert.Equal(ScheduleNormalizer.DefaultOpen, result.PerDay[0].Open);
        Assert.Equal(ScheduleNormalizer.DefaultClose, result.PerDay[0].Close);
    }

    [Fact]
    public void EnsurePerDay_repairs_invalid_break_and_out_of_range_delivery()
    {
        var input = new ScheduleDto(
            [1], "18:00", "23:55", "Fechado.",
            new[]
            {
                new ScheduleDayDto(0, false, "18:00", "23:55"),
                new ScheduleDayDto(1, true, "18:00", "23:55",
                    BreakEnabled: true, BreakStart: "9:00", BreakEnd: "9999", DeliveryMinutes: 9999),
                new ScheduleDayDto(2, false, "18:00", "23:55"),
                new ScheduleDayDto(3, false, "18:00", "23:55"),
                new ScheduleDayDto(4, false, "18:00", "23:55"),
                new ScheduleDayDto(5, false, "18:00", "23:55"),
                new ScheduleDayDto(6, false, "18:00", "23:55"),
            });

        var result = ScheduleNormalizer.EnsurePerDay(input);

        Assert.False(result.PerDay![1].BreakEnabled);
        Assert.Equal("", result.PerDay[1].BreakEnd);
        Assert.Null(result.PerDay[1].DeliveryMinutes);
        Assert.Equal("18:00", result.PerDay[1].Open);
    }

    [Fact]
    public void EnsurePerDay_rewrites_legacy_mirrors_from_first_enabled_day()
    {
        var schedule = new ScheduleDto([4, 5], "18:00", "23:55", "Fechado.");

        var result = ScheduleNormalizer.EnsurePerDay(schedule);

        Assert.Equal([4, 5], result.Days);
        Assert.Equal("18:00", result.Open);
        Assert.Equal("23:55", result.Close);
    }

    [Theory]
    [InlineData("09:30", true)]
    [InlineData("00:00", true)]
    [InlineData("23:59", true)]
    [InlineData("25:00", false)]
    [InlineData("9:5", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void ValidClock_accepts_HHmm_only(string? value, bool expected)
    {
        Assert.Equal(expected, ScheduleNormalizer.ValidClock(value));
    }

    [Fact]
    public void GetDay_and_DeliveryMinutesFor_use_perDay_first()
    {
        var schedule = new ScheduleDto(
            [1], "18:00", "23:55", "Fechado.",
            new[]
            {
                new ScheduleDayDto(0, false, "18:00", "23:55"),
                new ScheduleDayDto(1, true, "11:00", "23:55", DeliveryMinutes: 50),
                new ScheduleDayDto(2, false, "18:00", "23:55"),
                new ScheduleDayDto(3, false, "18:00", "23:55"),
                new ScheduleDayDto(4, false, "18:00", "23:55"),
                new ScheduleDayDto(5, false, "18:00", "23:55"),
                new ScheduleDayDto(6, false, "18:00", "23:55"),
            });

        var day = ScheduleNormalizer.GetDay(schedule, 1);

        Assert.NotNull(day);
        Assert.True(day!.Enabled);
        Assert.Equal("11:00", day.Open);
        Assert.Equal(50, ScheduleNormalizer.DeliveryMinutesFor(schedule, 1));
        Assert.Null(ScheduleNormalizer.DeliveryMinutesFor(schedule, 2));
    }
}
