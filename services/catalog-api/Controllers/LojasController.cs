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
    TenantResolverService tenantResolver) : ControllerBase
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

        try
        {
            var result = await provisioning.CreateAsync(request, cancellationToken);
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

