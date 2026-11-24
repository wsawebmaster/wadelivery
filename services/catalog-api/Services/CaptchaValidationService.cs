using System.Net.Http.Json;
using System.Text.Json.Serialization;

namespace Catalog.Api.Services;

public interface ICaptchaValidationService
{
    Task<bool> ValidateAsync(string? token, string? remoteIp, CancellationToken ct);
}

public sealed class CaptchaValidationService(
    IConfiguration configuration,
    IHttpClientFactory httpClientFactory,
    ILogger<CaptchaValidationService> logger) : ICaptchaValidationService
{
    public async Task<bool> ValidateAsync(string? token, string? remoteIp, CancellationToken ct)
    {
        var enabled = configuration.GetValue("Captcha:Enabled", false);
        if (!enabled) return true;

        if (string.IsNullOrWhiteSpace(token))
            return false;

        var provider = (configuration["Captcha:Provider"] ?? "turnstile").Trim().ToLowerInvariant();
        var secret = configuration["Captcha:SecretKey"] ?? configuration["Captcha:Secret"];
        if (string.IsNullOrWhiteSpace(secret))
        {
            logger.LogWarning("CAPTCHA habilitado mas sem secret configurado; rejeitando signup.");
            return false;
        }

        var verifyUrl = provider switch
        {
            "turnstile" => "https://challenges.cloudflare.com/turnstile/v0/siteverify",
            "hcaptcha" => "https://hcaptcha.com/siteverify",
            "recaptcha" => "https://www.google.com/recaptcha/api/siteverify",
            _ => "https://challenges.cloudflare.com/turnstile/v0/siteverify"
        };

        try
        {
            var client = httpClientFactory.CreateClient("captcha");
            using var content = new FormUrlEncodedContent(new Dictionary<string, string?>
            {
                ["secret"] = secret,
                ["response"] = token,
                ["remoteip"] = remoteIp
            });
            using var response = await client.PostAsync(verifyUrl, content, ct);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("CAPTCHA provider returned {StatusCode}", response.StatusCode);
                return false;
            }
            var payload = await response.Content.ReadFromJsonAsync<CaptchaVerifyResponse>(cancellationToken: ct);
            if (payload?.Success == true) return true;
            logger.LogInformation("CAPTCHA rejeitado: {Errors}", string.Join(",", payload?.ErrorCodes ?? []));
            return false;
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ao validar CAPTCHA");
            return false;
        }
    }

    private sealed class CaptchaVerifyResponse
    {
        [JsonPropertyName("success")] public bool Success { get; set; }
        [JsonPropertyName("error-codes")] public string[]? ErrorCodes { get; set; }
    }
}
