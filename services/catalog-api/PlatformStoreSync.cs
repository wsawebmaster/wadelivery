using Catalog.Api.Models;

namespace Catalog.Api;

/// <summary>
/// Mantém a loja em execução (Fabin Lanches, StoreId = 1) espelhando os dados
/// cadastrados no painel administrativo (store config): nome, contato, endereço,
/// logo e status. Assim a aba Lojas mostra os mesmos dados configurados pelo
/// usuário admin, sempre com status "active" quando a loja real está ativa.
/// </summary>
public static class PlatformStoreSync
{
    public const int RunningStoreId = 1;

    public static PlatformStoreDto ApplyStoreConfig(PlatformStoreDto store, StoreDto config)
    {
        if (config is null || store.StoreId != RunningStoreId)
            return store;

        return store with
        {
            Name = string.IsNullOrWhiteSpace(config.StoreName) ? store.Name : config.StoreName.Trim(),
            Phone = Coalesce(CatalogInputValidation.DigitsOnly(config.Whatsapp), store.Phone),
            Address = Coalesce(config.Address, store.Address),
            AddressNumber = Coalesce(config.AddressNumber, store.AddressNumber),
            Cep = Coalesce(CatalogInputValidation.DigitsOnly(config.Cep), store.Cep),
            City = Coalesce(config.City, store.City),
            State = Coalesce(NormalizeState(config.State), store.State),
            LogoUrl = Coalesce(config.LogoUrl, store.LogoUrl),
            Active = config.Active,
            Status = config.Active ? "active" : "inactive"
        };
    }

    private static string? Coalesce(string? preferred, string? fallback) =>
        string.IsNullOrWhiteSpace(preferred) ? fallback : preferred.Trim();

    private static string? NormalizeState(string? value) =>
        string.IsNullOrWhiteSpace(value) ? null : value.Trim().ToUpperInvariant();
}
