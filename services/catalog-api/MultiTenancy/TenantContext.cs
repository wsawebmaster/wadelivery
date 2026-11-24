using System.Security.Claims;

namespace Catalog.Api.MultiTenancy;

/// <summary>
/// Resolves the current tenant from a signed JWT or a server-resolved public slug.
/// </summary>
public class TenantContext(IHttpContextAccessor httpAccessor, IConfiguration config)
{
    public const string ResolvedTenantItemKey = "ResolvedTenantStoreId";
    private int? _resolved;

    public bool HasTenant => TryGetStoreId(out _);

    public int StoreId
    {
        get
        {
            if (_resolved.HasValue) return _resolved.Value;
            if (TryResolve(out var id))
            {
                _resolved = id;
                return id;
            }

            throw new InvalidOperationException(
                "Nenhum tenant foi resolvido para a requisição atual. " +
                "Forneça o cabeçalho 'X-Tenant-Slug', parâmetro 'tenant', ou autentique-se com um token de loja válido.");
        }
    }

    public bool TryGetStoreId(out int storeId)
    {
        if (_resolved.HasValue)
        {
            storeId = _resolved.Value;
            return storeId > 0;
        }

        if (TryResolve(out var id))
        {
            _resolved = id;
            storeId = id;
            return storeId > 0;
        }

        storeId = 0;
        return false;
    }

    public void SetStoreId(int storeId)
    {
        if (storeId <= 0) throw new ArgumentOutOfRangeException(nameof(storeId));
        _resolved = storeId;
    }

    private bool TryResolve(out int storeId)
    {
        var http = httpAccessor.HttpContext;

        // 1. JWT claim "store_id"
        var claim = http?.User?.FindFirst("store_id");
        if (claim is not null && int.TryParse(claim.Value, out var fromJwt) && fromJwt > 0)
        {
            storeId = fromJwt;
            return true;
        }

        // 2. Slug resolvido pelo TenantSlugMiddleware
        if (http?.Items.TryGetValue(ResolvedTenantItemKey, out var resolved) == true
            && resolved is int fromItems && fromItems > 0)
        {
            storeId = fromItems;
            return true;
        }

        // 3. Operador Dev com X-Tenant-Id header
        var role = http?.User?.FindFirst(ClaimTypes.Role)?.Value;
        if (string.Equals(role, "Dev", StringComparison.OrdinalIgnoreCase)
            && http?.Request.Headers.TryGetValue("X-Tenant-Id", out var headerVal) == true
            && int.TryParse(headerVal.ToString(), out var fromHeader)
            && fromHeader > 0)
        {
            storeId = fromHeader;
            return true;
        }

        // 4. Configuração explícita STORE_ID (ex.: contêiner dedicado ou teste)
        var env = config["STORE_ID"];
        if (int.TryParse(env, out var fromEnv) && fromEnv > 0)
        {
            storeId = fromEnv;
            return true;
        }

        // 4b. Loja padrão do deployment (Tenancy:DefaultStoreId). O backend é compartilhado com a
        //     produção da Fabin, cujos fronts atuais não enviam X-Tenant-Slug: sem tenant na
        //     requisição, vale a loja 1 — o mesmo comportamento da versão em produção.
        var defaultStore = config.GetValue("Tenancy:DefaultStoreId", 0);
        if (defaultStore > 0)
        {
            storeId = defaultStore;
            return true;
        }
        // 5. Modo leve single-tenant (JSON local / dev sem PostgreSQL)
        var persistence = config["Persistence"] ?? "Json";
        if (string.Equals(persistence, "Json", StringComparison.OrdinalIgnoreCase))
        {
            storeId = 1;
            return true;
        }

        storeId = 0;
        return false;
    }
}
