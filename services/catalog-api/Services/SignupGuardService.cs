using System.Security.Cryptography;
using System.Text;
using Catalog.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace Catalog.Api.Services;

public sealed class SignupGuardService(IServiceProvider services, IConfiguration configuration)
{
    /// <summary>
    /// Hash do IP de quem criou a loja (LGPD: o IP não é gravado em texto). Sal em
    /// Security:SignupIpSalt; sem ele usa a chave JWT, que já é segredo obrigatório.
    /// </summary>
    public static string? HashIp(string? ip, IConfiguration configuration)
    {
        if (string.IsNullOrWhiteSpace(ip)) return null;
        var salt = configuration["Security:SignupIpSalt"];
        if (string.IsNullOrWhiteSpace(salt)) salt = configuration["Jwt:Key"] ?? "";
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes($"{salt}|{ip.Trim()}"));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    public async Task<string?> CheckAsync(string normalizedEmail, string? signupIpHash, CancellationToken ct)
    {
        var db = services.GetService<CatalogDbContext>();
        if (db is null)
            return null;

        var perIpPerDay = configuration.GetValue("SignupQuota:PerIpPerDay", 2);
        var perHour = configuration.GetValue("SignupQuota:PerHour", 20);
        var perDay = configuration.GetValue("SignupQuota:PerDay", 100);
        var maxActiveTestStores = configuration.GetValue("SignupQuota:MaxActiveTestStores", 500);
        var now = DateTime.UtcNow;

        var emailExists = await db.AdminUsers.AsNoTracking()
            .AnyAsync(u => u.Username.ToLower() == normalizedEmail, ct);
        if (emailExists)
            return "Já existe uma conta com este e-mail. Faça login ou use outro e-mail.";

        // Contagens em platform_stores (sem RLS): a tabela stores tem RLS forçado e, sem loja no
        // contexto (cadastro anônimo), contaria zero com um usuário de banco que não seja superusuário.
        // Lojas do cadastro automático têm Plan = "teste".
        var signups = db.PlatformStores.AsNoTracking().Where(p => p.Plan == "teste");

        // Limite por visitante antes das cotas globais: um único IP não esgota o cadastro de todos.
        if (signupIpHash is not null && perIpPerDay > 0)
        {
            var sameIp = await signups
                .CountAsync(p => p.SignupIpHash == signupIpHash && p.CreatedAt >= now.AddHours(-24), ct);
            if (sameIp >= perIpPerDay)
                return "Limite de lojas criadas a partir desta conexão atingido. Tente novamente amanhã ou fale com a plataforma.";
        }

        // Lojas de teste ainda ativas: desativar em /admin/lojas (ou a expiração por abandono) libera vaga.
        var activeTestStores = await signups.CountAsync(p => p.Active && p.Status != "inactive", ct);
        if (activeTestStores >= maxActiveTestStores)
            return "Limite temporário de cadastros de teste atingido. Tente novamente mais tarde.";

        var lastHour = await signups.CountAsync(p => p.CreatedAt >= now.AddHours(-1), ct);
        if (lastHour >= perHour)
            return "Muitas lojas foram criadas recentemente. Tente novamente em alguns minutos.";

        var lastDay = await signups.CountAsync(p => p.CreatedAt >= now.AddHours(-24), ct);
        if (lastDay >= perDay)
            return "Limite diário de cadastros atingido. Tente novamente mais tarde.";

        return null;
    }
}
