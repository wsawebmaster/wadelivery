using Catalog.Api.Models;

namespace Catalog.Api;

public static class StoreAvailability
{
    /// <summary>
    /// Define se o cardápio deve abrir com base nas lojas da plataforma (painel Dev).
    /// </summary>
    public static bool Resolve(
        string storeName,
        string? originOrReferer,
        IReadOnlyList<PlatformStoreDto> platform,
        int? storeId = null)
    {
        if (platform.Count == 0) return true;

        PlatformStoreDto? match = storeId is null
            ? null
            : platform.FirstOrDefault(p => p.StoreId == storeId);

        if (!string.IsNullOrWhiteSpace(originOrReferer)
            && Uri.TryCreate(originOrReferer, UriKind.Absolute, out var originUri))
        {
            match = platform.FirstOrDefault(p =>
                !string.IsNullOrWhiteSpace(p.FrontUrl)
                && Uri.TryCreate(p.FrontUrl, UriKind.Absolute, out var front)
                && string.Equals(front.Host, originUri.Host, StringComparison.OrdinalIgnoreCase));
        }

        match ??= platform.FirstOrDefault(p =>
            string.Equals(p.Name, storeName, StringComparison.OrdinalIgnoreCase));

        // instalação única: usa o registro da plataforma
        match ??= platform.Count == 1 ? platform[0] : null;

        return match?.Active ?? true;
    }
}
