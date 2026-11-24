using Catalog.Api.Data;
using Catalog.Api.Services;

namespace Catalog.Api.Tests;

public class BillingPolicyTests
{
    private static readonly BillingOptions Options = new(BlockAfterDays: 5, TrialDays: 30, DefaultMonthlyFee: 150m, ManualUnblockGraceDays: 3);
    private static readonly DateTime Now = new(2026, 11, 22, 12, 0, 0, DateTimeKind.Utc);

    private static PlatformStoreEntity Store(decimal fee = 150m, DateTime? due = null, bool courtesy = false, DateTime? courtesyUntil = null) => new()
    {
        Id = Guid.NewGuid(),
        Name = "Teste",
        MonthlyFee = fee,
        Courtesy = courtesy,
        CourtesyUntil = courtesyUntil,
        NextDueAt = due,
        PaymentStatus = courtesy ? "courtesy" : "pending",
        PaymentsJson = "[]",
        Active = true,
        Status = "active",
    };

    [Fact]
    public void Trial_in_progress_keeps_courtesy()
    {
        var s = Store(courtesy: true, courtesyUntil: Now.AddDays(10), due: Now.AddDays(10));
        Assert.False(BillingPolicy.Apply(s, Now, Options));
        Assert.Equal("courtesy", s.PaymentStatus);
        Assert.True(s.Active);
    }

    [Fact]
    public void Trial_end_turns_into_pending_charge_due_on_trial_end()
    {
        var end = Now.AddDays(-0.5);
        var s = Store(courtesy: true, courtesyUntil: end);
        Assert.True(BillingPolicy.Apply(s, Now, Options));
        Assert.False(s.Courtesy);
        Assert.Equal(end, s.NextDueAt);
        Assert.Equal("pending", s.PaymentStatus);
        Assert.True(s.Active);
    }

    [Fact]
    public void Overdue_within_tolerance_is_flagged_but_not_blocked()
    {
        var s = Store(due: Now.Date.AddDays(-5));
        BillingPolicy.Apply(s, Now, Options);
        Assert.Equal("overdue", s.PaymentStatus);
        Assert.True(s.Active);
        Assert.False(s.BillingBlocked);
    }

    [Fact]
    public void Overdue_beyond_tolerance_blocks_store()
    {
        var s = Store(due: Now.Date.AddDays(-6));
        Assert.True(BillingPolicy.Apply(s, Now, Options));
        Assert.False(s.Active);
        Assert.Equal("inactive", s.Status);
        Assert.True(s.BillingBlocked);
        Assert.Equal(Now.Date, BillingPolicy.BlockDate(s.NextDueAt, Options.BlockAfterDays));
    }

    [Fact]
    public void Suspension_after_manual_unblock_prevents_reblock()
    {
        var s = Store(due: Now.Date.AddDays(-20));
        s.BillingBlockSuspendedUntil = Now.AddDays(2);
        BillingPolicy.Apply(s, Now, Options);
        Assert.True(s.Active);
        Assert.Equal("overdue", s.PaymentStatus);
    }

    [Fact]
    public void Manual_block_is_never_undone_automatically()
    {
        var s = Store(due: Now.AddDays(10));
        s.Active = false;
        s.Status = "inactive";
        BillingPolicy.Apply(s, Now, Options);
        Assert.False(s.Active);
    }

    [Fact]
    public void Due_date_moved_forward_unblocks_billing_block()
    {
        var s = Store(due: Now.AddDays(25));
        s.Active = false;
        s.Status = "inactive";
        s.BillingBlocked = true;
        s.PaymentStatus = "overdue";
        BillingPolicy.Apply(s, Now, Options);
        Assert.True(s.Active);
        Assert.False(s.BillingBlocked);
        Assert.Equal("pending", s.PaymentStatus);
    }

    [Fact]
    public void Zero_fee_never_charges()
    {
        var s = Store(fee: 0, due: Now.Date.AddDays(-30));
        BillingPolicy.Apply(s, Now, Options);
        Assert.True(s.Active);
        Assert.NotEqual("overdue", s.PaymentStatus);
    }
}
