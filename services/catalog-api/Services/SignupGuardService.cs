using Catalog.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Services;

public sealed class SignupGuardService(IServiceProvider services, IConfiguration configuration)
{
    public async Task<string?> CheckAsync(string normalizedEmail, CancellationToken ct)
    {
        var db = services.GetService<CatalogDbContext>();
        if (db is null)
            return null;

        var perHour = configuration.GetValue("SignupQuota:PerHour", 20);
        var perDay = configuration.GetValue("SignupQuota:PerDay", 100);
        var maxActiveTestStores = configuration.GetValue("SignupQuota:MaxActiveTestStores", 500);
        var now = DateTime.UtcNow;

        var emailExists = await db.AdminUsers.AsNoTracking()
            .AnyAsync(u => u.Username.ToLower() == normalizedEmail, ct);
        if (emailExists)
            return "Já existe uma conta com este e-mail. Faça login ou use outro e-mail.";

        // Conta só lojas de teste ainda ativas na plataforma: desativar uma loja de teste
        // em /admin/lojas libera vaga (não há expiração automática de lojas de teste).
        var activeTestStores = await db.Stores.AsNoTracking()
            .Where(s => s.IsTeste)
            .CountAsync(s => !db.PlatformStores.Any(p =>
                p.StoreId == s.Id && (!p.Active || p.Status == "inactive")), ct);
        if (activeTestStores >= maxActiveTestStores)
            return "Limite temporário de cadastros de teste atingido. Tente novamente mais tarde.";

        var lastHour = await db.Stores.AsNoTracking()
            .CountAsync(s => s.IsTeste && s.DataCriacao >= now.AddHours(-1), ct);
        if (lastHour >= perHour)
            return "Muitas lojas foram criadas recentemente. Tente novamente em alguns minutos.";

        var lastDay = await db.Stores.AsNoTracking()
            .CountAsync(s => s.IsTeste && s.DataCriacao >= now.AddHours(-24), ct);
        if (lastDay >= perDay)
            return "Limite diário de cadastros atingido. Tente novamente mais tarde.";

        return null;
    }
}
