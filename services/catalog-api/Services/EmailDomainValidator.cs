using System.Net.Mail;
using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;

namespace Catalog.Api.Services;

/// <summary>
/// Exige e-mail com domínio real no cadastro de lojas: recusa domínios reservados e
/// descartáveis e consulta o MX do domínio por DNS-over-HTTPS (sem pacote extra).
/// Garante que o domínio recebe e-mail — não que a pessoa é dona do endereço (isso exige
/// confirmação por link, que depende de um provedor de e-mail ainda inexistente).
/// Falha de rede no DNS não bloqueia o cadastro (fail-open, registrado no log).
/// </summary>
public sealed class EmailDomainValidator(
    IHttpClientFactory httpClientFactory,
    IMemoryCache cache,
    IConfiguration configuration,
    ILogger<EmailDomainValidator> logger)
{
    public const string HttpClientName = "dns";
    public const string InvalidDomainMessage = "Informe um e-mail válido: o domínio não recebe mensagens.";
    public const string DisposableMessage = "Use um e-mail permanente (e-mails temporários não são aceitos).";

    private static readonly string[] ReservedSuffixes =
        [".test", ".invalid", ".localhost", ".example", ".local", ".internal"];

    private static readonly HashSet<string> ReservedDomains = new(StringComparer.OrdinalIgnoreCase)
    {
        "example.com", "example.org", "example.net", "localhost",
    };

    // Provedores de e-mail temporário/descartável mais comuns.
    private static readonly HashSet<string> DisposableDomains = new(StringComparer.OrdinalIgnoreCase)
    {
        "mailinator.com", "mailinator.net", "mailinator2.com", "guerrillamail.com", "guerrillamail.net",
        "guerrillamail.org", "guerrillamail.biz", "guerrillamail.de", "sharklasers.com", "grr.la",
        "guerrillamailblock.com", "pokemail.net", "spam4.me", "10minutemail.com", "10minutemail.net",
        "10minutemail.co.uk", "20minutemail.com", "yopmail.com", "yopmail.net", "yopmail.fr",
        "cool.fr.nf", "jetable.fr.nf", "temp-mail.org", "temp-mail.io", "tempmail.com", "tempmail.net",
        "tempmailo.com", "tempmail.dev", "tempmailaddress.com", "tempr.email", "throwawaymail.com",
        "trashmail.com", "trashmail.net", "trashmail.de", "trashmail.io", "getnada.com", "nada.email",
        "dispostable.com", "maildrop.cc", "mailnesia.com", "mintemail.com", "mohmal.com",
        "fakeinbox.com", "fakemail.net", "emailondeck.com", "mailcatch.com", "mytemp.email",
        "moakt.com", "burnermail.io", "getairmail.com", "mailpoof.com", "spamgourmet.com",
        "33mail.com", "inboxkitten.com", "emailfake.com", "1secmail.com", "1secmail.net",
        "1secmail.org", "dropmail.me", "linshiyouxiang.net", "tmail.ws", "tmpmail.org",
        "tmpmail.net", "minuteinbox.com", "mail.tm", "mailsac.com", "harakirimail.com",
        "spambox.us", "discard.email", "anonbox.net", "mailforspam.com", "byom.de",
        "crazymailing.com", "emltmp.com", "luxusmail.org", "tempinbox.com",
    };

    /// <summary>Validação local (sem rede): formato, domínio reservado ou descartável.</summary>
    public static string? ValidateOffline(string? email, out string domain)
    {
        domain = "";
        var value = (email ?? "").Trim().ToLowerInvariant();
        if (!MailAddress.TryCreate(value, out var address) || !string.Equals(address.Address, value, StringComparison.Ordinal))
            return "Informe um e-mail válido.";
        var host = address.Host.TrimEnd('.');
        domain = host;
        if (!host.Contains('.') || ReservedDomains.Contains(host) || ReservedSuffixes.Any(s => host.EndsWith(s, StringComparison.Ordinal)))
            return InvalidDomainMessage;
        if (IsDisposable(host)) return DisposableMessage;
        return null;
    }

    public static bool IsDisposable(string domain)
    {
        // Inclui subdomínios (ex.: abc.mailinator.com).
        var d = domain.ToLowerInvariant();
        while (true)
        {
            if (DisposableDomains.Contains(d)) return true;
            var dot = d.IndexOf('.');
            if (dot < 0 || d.IndexOf('.', dot + 1) < 0) return false;
            d = d[(dot + 1)..];
        }
    }

    /// <summary>Null = e-mail aceito; senão a mensagem para o usuário.</summary>
    public async Task<string?> ValidateAsync(string? email, CancellationToken ct)
    {
        var offline = ValidateOffline(email, out var domain);
        if (offline is not null) return offline;
        if (!configuration.GetValue("Signup:EmailDnsCheck", true)) return null;

        var cacheKey = $"email-domain:{domain}";
        if (cache.TryGetValue(cacheKey, out bool cachedOk))
            return cachedOk ? null : InvalidDomainMessage;

        var receives = await DomainReceivesMailAsync(domain, ct);
        if (receives is null) return null; // DNS indisponível: não bloqueia o cadastro

        cache.Set(cacheKey, receives.Value, TimeSpan.FromHours(24));
        return receives.Value ? null : InvalidDomainMessage;
    }

    /// <summary>true = tem MX (ou A, fallback do SMTP); false = não existe; null = consulta falhou.</summary>
    private async Task<bool?> DomainReceivesMailAsync(string domain, CancellationToken ct)
    {
        var mx = await QueryAsync(domain, "MX", 15, ct);
        if (mx is null) return null;
        if (mx.Value.Exists) return true;
        if (mx.Value.NxDomain) return false;
        var a = await QueryAsync(domain, "A", 1, ct);
        return a is null ? null : a.Value.Exists;
    }

    private async Task<(bool Exists, bool NxDomain)?> QueryAsync(string domain, string type, int typeCode, CancellationToken ct)
    {
        var baseUrl = configuration["Signup:DnsOverHttpsUrl"] ?? "https://cloudflare-dns.com/dns-query";
        try
        {
            var client = httpClientFactory.CreateClient(HttpClientName);
            using var request = new HttpRequestMessage(HttpMethod.Get,
                $"{baseUrl}?name={Uri.EscapeDataString(domain)}&type={type}");
            request.Headers.Accept.ParseAdd("application/dns-json");
            using var response = await client.SendAsync(request, ct);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("DNS-over-HTTPS respondeu {Status} para {Domain}", (int)response.StatusCode, domain);
                return null;
            }
            using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync(ct));
            var status = doc.RootElement.TryGetProperty("Status", out var st) ? st.GetInt32() : -1;
            if (status == 3) return (false, true); // NXDOMAIN
            if (status != 0) return null;           // SERVFAIL etc.: inconclusivo
            var exists = doc.RootElement.TryGetProperty("Answer", out var answers)
                && answers.ValueKind == JsonValueKind.Array
                && answers.EnumerateArray().Any(x => x.TryGetProperty("type", out var t) && t.GetInt32() == typeCode);
            return (exists, false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Falha ao consultar DNS do domínio {Domain}; e-mail aceito sem verificação de MX.", domain);
            return null;
        }
    }
}
