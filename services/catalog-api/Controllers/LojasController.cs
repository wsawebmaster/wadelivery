using Catalog.Api.Services;
using Catalog.Api.Models;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using SixLabors.ImageSharp;

namespace Catalog.Api.Controllers;

[ApiController]
[Route("api/lojas")]
public sealed class LojasController(
    IServiceProvider services,
    TenantResolverService tenantResolver,
    ICaptchaValidationService captcha,
    SignupGuardService signupGuard,
    EmailDomainValidator emailValidator,
    IConfiguration configuration) : ControllerBase
{
    [HttpGet("slug/{slug}")]
    public async Task<IActionResult> ObterPorSlug(string slug, CancellationToken cancellationToken)
    {
        var tenant = await tenantResolver.ResolveAsync(slug, cancellationToken);
        return tenant is null
            ? NotFound(new { error = "Loja não encontrada para este slug." })
            : Ok(tenant);
    }

    [HttpPost("criar-completa")]
    [Consumes("multipart/form-data")]
    [RequestSizeLimit(17 * 1024 * 1024)]
    [EnableRateLimiting("store-signup")]
    public async Task<IActionResult> CriarCompleta(
        [FromForm] CriarLojaRequest request,
        CancellationToken cancellationToken)
    {
        var provisioning = services.GetService<StoreProvisioningService>();
        if (provisioning is null)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new
            {
                error = "A criação automática de lojas requer persistência PostgreSQL."
            });

        var validationError = StoreProvisioningService.Validate(request);
        if (validationError is not null)
            return BadRequest(new { error = validationError });

        if (!captcha.IsAvailable)
            return StatusCode(StatusCodes.Status503ServiceUnavailable, new
            {
                error = "Cadastro temporariamente indisponível. Tente novamente mais tarde."
            });

        var remoteIp = HttpContext.Connection.RemoteIpAddress?.ToString();
        if (!await captcha.ValidateAsync(request.CaptchaToken, remoteIp, cancellationToken))
            return BadRequest(new { error = "Não foi possível validar a verificação de segurança. Atualize a página e tente novamente." });

        var normalizedEmail = (request.Email ?? "").Trim().ToLowerInvariant();
        // E-mail com domínio real (reservados/descartáveis/sem MX são recusados).
        var emailError = await emailValidator.ValidateAsync(normalizedEmail, cancellationToken);
        if (emailError is not null)
            return BadRequest(new { error = emailError, field = "Email" });

        // IP real do visitante (o gateway envia X-Forwarded-For; ver ForwardedHeaders:KnownNetworks).
        var signupIpHash = SignupGuardService.HashIp(remoteIp, configuration);
        var guardError = await signupGuard.CheckAsync(normalizedEmail, signupIpHash, cancellationToken);
        if (guardError is not null)
            return StatusCode(StatusCodes.Status429TooManyRequests, new { error = guardError });

        try
        {
            var result = await provisioning.CreateAsync(request, cancellationToken, signupIpHash);
            return Created(result.PublicUrl, result);
        }
        catch (StoreProvisioningConflictException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (InvalidDataException ex)
        {
            return BadRequest(new { error = ex.Message });
        }
        catch (UnknownImageFormatException)
        {
            return BadRequest(new { error = "Uma das imagens está em formato inválido ou corrompido." });
        }
    }
}

