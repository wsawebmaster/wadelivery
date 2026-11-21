using Catalog.Api.Models;
using System.Text.Json;

namespace Catalog.Api;

/// <summary>
/// Normalização/serialização dos grupos de modificadores de um produto.
/// Garante ids/ordens estáveis, limita Min/Max, teto de opções e valores de delta.
/// </summary>
public static class ModifierGroups
{
    public const int MaxOptionsPerGroup = 30;
    public const int MaxGroupsPerProduct = 20;
    public const int MaxSelection = 10;

    public static List<ModifierGroupDto> Normalize(IEnumerable<ModifierGroupDto>? groups)
    {
        var result = new List<ModifierGroupDto>();
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var order = 0;
        foreach (var g in groups ?? [])
        {
            if (g is null) continue;
            var gid = string.IsNullOrWhiteSpace(g.Id) ? $"g-{order + 1}" : g.Id.Trim();
            if (!ids.Add(gid)) continue;
            if (gid.Length > 64) gid = gid[..64];

            var name = string.IsNullOrWhiteSpace(g.Name) ? $"Grupo {order + 1}" : g.Name.Trim();
            var min = Math.Clamp(g.Min, 0, MaxSelection);
            var max = g.Max <= 0 ? MaxSelection : Math.Clamp(g.Max, 0, MaxSelection);
            if (max < min) max = min;

            result.Add(new ModifierGroupDto(gid, name, order + 1, g.Required, min, max, NormalizeOptions(g.Options)));
            order++;
            if (order >= MaxGroupsPerProduct) break;
        }
        return result;
    }

    private static List<ModifierOptionDto> NormalizeOptions(IEnumerable<ModifierOptionDto>? options)
    {
        var result = new List<ModifierOptionDto>();
        var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var order = 0;
        foreach (var o in options ?? [])
        {
            if (o is null) continue;
            var oid = string.IsNullOrWhiteSpace(o.Id) ? $"opt-{order + 1}" : o.Id.Trim();
            if (!ids.Add(oid)) continue;
            if (oid.Length > 64) oid = oid[..64];

            var name = string.IsNullOrWhiteSpace(o.Name) ? oid : o.Name.Trim();
            var delta = o.PriceDelta < 0 ? 0 : Math.Clamp(o.PriceDelta, 0, 999);

            result.Add(new ModifierOptionDto(oid, name, delta, order + 1, o.Available));
            order++;
            if (order >= MaxOptionsPerGroup) break;
        }
        return result;
    }

    /// <summary>Serializa para JSON (null quando não há grupos).</summary>
    public static string? Serialize(IEnumerable<ModifierGroupDto>? groups)
    {
        var normalized = Normalize(groups);
        return normalized.Count == 0 ? null : JsonSerializer.Serialize(normalized);
    }

    /// <summary>Desserializa do JSON da coluna, tolerante a dados inválidos.</summary>
    public static List<ModifierGroupDto>? Deserialize(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try
        {
            return JsonSerializer.Deserialize<List<ModifierGroupDto>>(json)
                ?? Normalize(null);
        }
        catch
        {
            return Normalize(null);
        }
    }
}