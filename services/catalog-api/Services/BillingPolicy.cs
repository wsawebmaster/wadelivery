using Catalog.Api.Data;

namespace Catalog.Api.Services;

/// <summary>Parâmetros da cobrança de mensalidades (seção "Billing" da configuração).</summary>
public sealed record BillingOptions(
    int BlockAfterDays,
    int TrialDays,
    decimal DefaultMonthlyFee,
    int ManualUnblockGraceDays,
    bool AutoBlockEnabled = true,
    IReadOnlySet<int>? ProtectedStoreIds = null)
{
    /// <summary>Lojas que nunca sofrem bloqueio automático (padrão: loja 1, Fabin).</summary>
    public IReadOnlySet<int> Protected => ProtectedStoreIds ?? DefaultProtected;

    private static readonly IReadOnlySet<int> DefaultProtected = new HashSet<int> { 1 };

    /// <summary>
    /// Bloqueio automático só com Billing:AutoBlockEnabled=true (padrão false: em produção
    /// é ligado de propósito). Platform:ProtectedStoreIds lista as lojas que nunca são
    /// bloqueadas pela rotina (padrão [1], a Fabin).
    /// </summary>
    public static BillingOptions FromConfig(IConfiguration config) => new(
        Math.Max(0, config.GetValue("Billing:BlockAfterDays", 5)),
        Math.Max(0, config.GetValue("Billing:TrialDays", 30)),
        Math.Max(0m, config.GetValue("Billing:DefaultMonthlyFee", 0m)),
        Math.Max(1, config.GetValue("Billing:ManualUnblockGraceDays", 3)),
        config.GetValue("Billing:AutoBlockEnabled", false),
        ProtectedStores(config));

    public static IReadOnlySet<int> ProtectedStores(IConfiguration config)
    {
        var section = config.GetSection("Platform:ProtectedStoreIds");
        if (!section.Exists()) return DefaultProtected;
        return section.GetChildren().Select(c => int.TryParse(c.Value, out var id) ? id : 0).Where(id => id > 0).ToHashSet();
    }
}

/// <summary>
/// Regras da mensalidade das lojas da plataforma (usa o bloqueio existente: Active=false
/// tira o cardápio do ar e o orders-api recusa pedidos).
///
/// - Teste grátis/cortesia com data: ao terminar, vira cobrança pendente vencendo nessa data.
/// - Mensalidade zero ou cortesia sem data: sem cobrança.
/// - Venceu: status "overdue". Passados BlockAfterDays dias, bloqueia (BillingBlocked=true).
/// - Pagamento registrado ou vencimento regularizado: desbloqueia o que a cobrança bloqueou.
///   Bloqueio manual (BillingBlocked=false) nunca é desfeito automaticamente.
/// </summary>
public static class BillingPolicy
{
    public static int DaysOverdue(DateTime? nextDueAt, DateTime nowUtc) =>
        nextDueAt is null ? 0 : Math.Max(0, (nowUtc.Date - nextDueAt.Value.Date).Days);

    /// <summary>Data em que a loja será bloqueada se continuar sem pagamento (null = não bloqueia).</summary>
    public static DateTime? BlockDate(DateTime? nextDueAt, int blockAfterDays) =>
        nextDueAt is null || blockAfterDays <= 0 ? null : nextDueAt.Value.Date.AddDays(blockAfterDays + 1);

    /// <summary>Aplica as regras na loja. Retorna true quando algo mudou.</summary>
    public static bool Apply(PlatformStoreEntity store, DateTime nowUtc, BillingOptions options)
    {
        var before = (store.PaymentStatus, store.Active, store.Status, store.BillingBlocked, store.Courtesy, store.NextDueAt);

        // Fim do teste grátis / cortesia com prazo.
        if (store.Courtesy && store.CourtesyUntil is not null && store.CourtesyUntil <= nowUtc)
        {
            store.Courtesy = false;
            store.NextDueAt ??= store.CourtesyUntil;
            store.PaymentStatus = "pending";
        }

        if (store.Courtesy || store.MonthlyFee <= 0)
        {
            if (store.Courtesy) store.PaymentStatus = "courtesy";
            if (store.BillingBlocked) Unblock(store);
            return Changed(store, before);
        }

        var daysOverdue = DaysOverdue(store.NextDueAt, nowUtc);
        if (store.NextDueAt is not null && daysOverdue > 0)
        {
            store.PaymentStatus = "overdue";
            var suspended = store.BillingBlockSuspendedUntil is not null && store.BillingBlockSuspendedUntil > nowUtc;
            var isProtected = store.StoreId is int sid && options.Protected.Contains(sid);
            if (options.AutoBlockEnabled && !isProtected
                && options.BlockAfterDays > 0 && daysOverdue > options.BlockAfterDays && !suspended
                && store.Active && !store.BillingBlocked)
            {
                store.Active = false;
                store.Status = "inactive";
                store.BillingBlocked = true;
            }
        }
        else
        {
            if (store.PaymentStatus == "overdue") store.PaymentStatus = "pending";
            if (store.BillingBlocked) Unblock(store);
        }
        return Changed(store, before);
    }

    public static void Unblock(PlatformStoreEntity store)
    {
        store.Active = true;
        store.Status = "active";
        store.BillingBlocked = false;
        store.BillingBlockSuspendedUntil = null;
    }

    private static bool Changed(
        PlatformStoreEntity s,
        (string PaymentStatus, bool Active, string Status, bool BillingBlocked, bool Courtesy, DateTime? NextDueAt) b) =>
        s.PaymentStatus != b.PaymentStatus || s.Active != b.Active || s.Status != b.Status
        || s.BillingBlocked != b.BillingBlocked || s.Courtesy != b.Courtesy || s.NextDueAt != b.NextDueAt;
}
