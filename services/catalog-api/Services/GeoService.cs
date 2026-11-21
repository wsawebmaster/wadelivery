using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Catalog.Api.Models;

namespace Catalog.Api.Services;

public class GeoService(IHttpClientFactory httpClientFactory, ILogger<GeoService> logger)
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNameCaseInsensitive = true
    };

    public async Task<GeocodeResponse?> GeocodeAsync(string query, CancellationToken ct = default)
    {
        if (string.IsNullOrWhiteSpace(query)) return null;

        var cep = OnlyDigits(query);
        if (cep.Length == 8)
        {
            var byCep = await GeocodeByCepAsync(cep, ct);
            if (byCep is not null) return byCep;
        }

        // Tenta extrair CEP embutido no endereço completo
        var embedded = Regex.Match(query, @"\b(\d{5})-?(\d{3})\b");
        if (embedded.Success)
        {
            var byEmbedded = await GeocodeByCepAsync(embedded.Groups[1].Value + embedded.Groups[2].Value, ct);
            if (byEmbedded is not null) return byEmbedded;
        }

        return await GeocodeByTextAsync(query, ct);
    }

    public async Task<GeocodeResponse?> GeocodeByCepAsync(string cep, CancellationToken ct = default)
    {
        cep = OnlyDigits(cep);
        if (cep.Length != 8) return null;

        // 1) AwesomeAPI (lat/lng diretos)
        var awesome = await TryAwesomeApiAsync(cep, ct);
        if (awesome is not null) return awesome;

        // 2) ViaCEP → endereço textual → geocoders (quando AwesomeAPI falha no host)
        var via = await TryViaCepAsync(cep, ct);
        if (via is null) return null;

        foreach (var candidate in via.GeocodeQueries)
        {
            var byText = await GeocodeByTextAsync(candidate, ct);
            if (byText is not null)
            {
                return byText with
                {
                    DisplayName = string.IsNullOrWhiteSpace(byText.DisplayName) ? via.Display : byText.DisplayName
                };
            }
        }

        return null;
    }

    private async Task<GeocodeResponse?> GeocodeByTextAsync(string query, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(query)) return null;

        // Photon (Komoot) costuma funcionar melhor em hosts cloud que Nominatim
        var photon = await TryPhotonAsync(query, ct);
        if (photon is not null) return photon;

        var nominatim = await TryNominatimAsync(query, ct);
        if (nominatim is not null) return nominatim;

        return await TryOpenMeteoAsync(query, ct);
    }

    private async Task<GeocodeResponse?> TryPhotonAsync(string query, CancellationToken ct)
    {
        try
        {
            var client = httpClientFactory.CreateClient("geo");
            var url =
                "https://photon.komoot.io/api/?limit=1&lang=en&q=" +
                Uri.EscapeDataString(query.Trim());

            using var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Photon falhou: {Status}", response.StatusCode);
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var data = await JsonSerializer.DeserializeAsync<PhotonResponse>(stream, JsonOptions, ct);
            var feature = data?.Features?.FirstOrDefault();
            var coords = feature?.Geometry?.Coordinates;
            if (coords is null || coords.Count < 2) return null;

            var lon = coords[0];
            var lat = coords[1];
            if (lat == 0 && lon == 0) return null;

            var p = feature!.Properties;
            var display = string.Join(", ", new[]
            {
                p?.Name,
                p?.District,
                p?.City,
                p?.State,
                p?.Country
            }.Where(x => !string.IsNullOrWhiteSpace(x)));

            return new GeocodeResponse(
                string.IsNullOrWhiteSpace(display) ? query.Trim() : display,
                lat,
                lon);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha Photon");
            return null;
        }
    }

    private async Task<GeocodeResponse?> TryAwesomeApiAsync(string cep, CancellationToken ct)
    {
        try
        {
            var client = httpClientFactory.CreateClient("geo");
            using var response = await client.GetAsync($"https://cep.awesomeapi.com.br/json/{cep}", ct);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("AwesomeAPI CEP falhou: {Status}", response.StatusCode);
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var data = await JsonSerializer.DeserializeAsync<AwesomeApiCepResponse>(stream, JsonOptions, ct);
            if (data is null) return null;
            if (!TryParseCoord(data.Lat, out var lat) || !TryParseCoord(data.Lng, out var lon)) return null;
            if (lat == 0 && lon == 0) return null;

            var street = data.Address ?? data.AddressName;
            var display = string.Join(", ", new[]
            {
                street,
                data.District,
                string.IsNullOrWhiteSpace(data.City) ? null : $"{data.City} - {data.State}",
                FormatCep(cep)
            }.Where(x => !string.IsNullOrWhiteSpace(x)));

            return new GeocodeResponse(display, lat, lon);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha AwesomeAPI CEP {Cep}", cep);
            return null;
        }
    }

    private async Task<ViaCepResolved?> TryViaCepAsync(string cep, CancellationToken ct)
    {
        try
        {
            var client = httpClientFactory.CreateClient("geo");
            using var response = await client.GetAsync($"https://viacep.com.br/ws/{cep}/json/", ct);
            if (!response.IsSuccessStatusCode) return null;

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var data = await JsonSerializer.DeserializeAsync<ViaCepResponse>(stream, JsonOptions, ct);
            if (data is null || data.Erro == true) return null;
            if (string.IsNullOrWhiteSpace(data.Localidade) || string.IsNullOrWhiteSpace(data.Uf)) return null;

            var display = string.Join(", ", new[]
            {
                data.Logradouro,
                data.Bairro,
                $"{data.Localidade} - {data.Uf}",
                FormatCep(cep)
            }.Where(x => !string.IsNullOrWhiteSpace(x)));

            // Queries do mais específico ao mais amplo (Open-Meteo prefere nomes de lugar)
            var queries = new List<string>();
            void AddQuery(params string?[] parts)
            {
                var q = string.Join(", ", parts.Where(p => !string.IsNullOrWhiteSpace(p)));
                if (!string.IsNullOrWhiteSpace(q) && !queries.Contains(q, StringComparer.OrdinalIgnoreCase))
                    queries.Add(q);
            }

            AddQuery(data.Logradouro, data.Bairro, data.Localidade, data.Uf, "Brasil");
            AddQuery(data.Logradouro, data.Localidade, data.Uf, "Brasil");
            AddQuery(data.Bairro, data.Localidade, data.Uf, "Brasil");
            AddQuery(data.Localidade, data.Uf, "Brasil");

            return new ViaCepResolved(display, queries);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha ViaCEP {Cep}", cep);
            return null;
        }
    }

    private async Task<GeocodeResponse?> TryOpenMeteoAsync(string query, CancellationToken ct)
    {
        try
        {
            var client = httpClientFactory.CreateClient("geo");
            var url =
                "https://geocoding-api.open-meteo.com/v1/search?count=1&language=pt&format=json&countryCode=BR&name=" +
                Uri.EscapeDataString(query.Trim());

            using var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Open-Meteo falhou: {Status}", response.StatusCode);
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var data = await JsonSerializer.DeserializeAsync<OpenMeteoResponse>(stream, JsonOptions, ct);
            var first = data?.Results?.FirstOrDefault();
            if (first is null) return null;

            var display = string.Join(", ", new[]
            {
                first.Name,
                first.Admin2 ?? first.Admin1,
                first.CountryCode
            }.Where(x => !string.IsNullOrWhiteSpace(x)));

            return new GeocodeResponse(
                string.IsNullOrWhiteSpace(display) ? query.Trim() : display,
                first.Latitude,
                first.Longitude);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha Open-Meteo");
            return null;
        }
    }

    private async Task<GeocodeResponse?> TryNominatimAsync(string query, CancellationToken ct)
    {
        try
        {
            var client = httpClientFactory.CreateClient("geo");
            var url =
                "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=br&q=" +
                Uri.EscapeDataString(query.Trim());

            using var response = await client.GetAsync(url, ct);
            if (!response.IsSuccessStatusCode)
            {
                logger.LogWarning("Nominatim falhou: {Status}", response.StatusCode);
                return null;
            }

            await using var stream = await response.Content.ReadAsStreamAsync(ct);
            var results = await JsonSerializer.DeserializeAsync<List<NominatimResult>>(stream, JsonOptions, ct);
            var first = results?.FirstOrDefault();
            if (first is null) return null;
            if (!TryParseCoord(first.Lat, out var lat) || !TryParseCoord(first.Lon, out var lon)) return null;

            return new GeocodeResponse(
                string.IsNullOrWhiteSpace(first.DisplayName) ? query.Trim() : first.DisplayName!,
                lat,
                lon);
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Falha Nominatim");
            return null;
        }
    }

    public static double HaversineKm(double lat1, double lon1, double lat2, double lon2)
    {
        const double R = 6371;
        static double ToRad(double deg) => deg * Math.PI / 180;
        var dLat = ToRad(lat2 - lat1);
        var dLon = ToRad(lon2 - lon1);
        var a = Math.Sin(dLat / 2) * Math.Sin(dLat / 2) +
                Math.Cos(ToRad(lat1)) * Math.Cos(ToRad(lat2)) *
                Math.Sin(dLon / 2) * Math.Sin(dLon / 2);
        var c = 2 * Math.Atan2(Math.Sqrt(a), Math.Sqrt(1 - a));
        return Math.Round(R * c, 2);
    }

    private static bool TryParseCoord(string? value, out double coord) =>
        double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out coord);

    private static string OnlyDigits(string value) =>
        Regex.Replace(value ?? "", @"\D", "");

    private static string FormatCep(string cep) =>
        cep.Length == 8 ? $"{cep[..5]}-{cep[5..]}" : cep;

    private sealed record ViaCepResolved(string Display, IReadOnlyList<string> GeocodeQueries);

    private sealed class NominatimResult
    {
        public string? Lat { get; set; }
        public string? Lon { get; set; }
        public string? DisplayName { get; set; }
    }

    private sealed class AwesomeApiCepResponse
    {
        public string? Cep { get; set; }
        public string? State { get; set; }
        public string? City { get; set; }
        public string? District { get; set; }
        public string? Address { get; set; }

        [JsonPropertyName("address_name")]
        public string? AddressName { get; set; }

        public string? Lat { get; set; }
        public string? Lng { get; set; }
    }

    private sealed class ViaCepResponse
    {
        public bool? Erro { get; set; }
        public string? Cep { get; set; }
        public string? Logradouro { get; set; }
        public string? Bairro { get; set; }
        public string? Localidade { get; set; }
        public string? Uf { get; set; }
    }

    private sealed class OpenMeteoResponse
    {
        public List<OpenMeteoResult>? Results { get; set; }
    }

    private sealed class OpenMeteoResult
    {
        public string? Name { get; set; }
        public double Latitude { get; set; }
        public double Longitude { get; set; }
        public string? CountryCode { get; set; }
        public string? Admin1 { get; set; }
        public string? Admin2 { get; set; }
    }

    private sealed class PhotonResponse
    {
        public List<PhotonFeature>? Features { get; set; }
    }

    private sealed class PhotonFeature
    {
        public PhotonProperties? Properties { get; set; }
        public PhotonGeometry? Geometry { get; set; }
    }

    private sealed class PhotonProperties
    {
        public string? Name { get; set; }
        public string? District { get; set; }
        public string? City { get; set; }
        public string? State { get; set; }
        public string? Country { get; set; }
    }

    private sealed class PhotonGeometry
    {
        public List<double>? Coordinates { get; set; }
    }
}
