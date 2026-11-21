using Catalog.Api.Models;

namespace Catalog.Api;

public static class StoreBreadOptions
{
    public static List<BreadOptionDto> Defaults() =>
    [
        new() { Id = "pao-frances", Label = "Pão francês", Available = true },
        new() { Id = "pao-hamburguer", Label = "Pão hambúrguer", Available = true }
    ];

    public static List<BreadOptionDto> Normalize(IEnumerable<BreadOptionDto>? options)
    {
        var incoming = (options ?? [])
            .Where(o => o is not null && !string.IsNullOrWhiteSpace(o.Id))
            .Select(o => new BreadOptionDto
            {
                Id = o.Id.Trim(),
                Label = string.IsNullOrWhiteSpace(o.Label) ? o.Id.Trim() : o.Label.Trim(),
                Available = o.Available
            })
            .ToList();

        var map = new Dictionary<string, BreadOptionDto>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in incoming)
            map[item.Id] = item;

        var result = new List<BreadOptionDto>();
        foreach (var def in Defaults())
        {
            if (map.TryGetValue(def.Id, out var found))
            {
                result.Add(new BreadOptionDto
                {
                    Id = def.Id,
                    Label = string.IsNullOrWhiteSpace(found.Label) ? def.Label : found.Label,
                    Available = found.Available
                });
                map.Remove(def.Id);
            }
            else
            {
                result.Add(new BreadOptionDto
                {
                    Id = def.Id,
                    Label = def.Label,
                    Available = def.Available
                });
            }
        }

        foreach (var extra in map.Values)
            result.Add(extra);

        return result;
    }
}
