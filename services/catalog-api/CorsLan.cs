using System.Net;
using System.Net.Sockets;

namespace Catalog.Api;

public static class CorsLan
{
    public static bool IsOriginAllowed(string? origin, IReadOnlyCollection<string> configured)
    {
        if (string.IsNullOrWhiteSpace(origin)) return false;

        foreach (var allowed in configured)
        {
            if (string.Equals(allowed, origin, StringComparison.OrdinalIgnoreCase))
                return true;

            if (MatchesWildcard(allowed, origin))
                return true;
        }

        if (!Uri.TryCreate(origin, UriKind.Absolute, out var uri))
            return false;

        if (!string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase)
            && !string.Equals(uri.Scheme, "https", StringComparison.OrdinalIgnoreCase))
            return false;

        if (uri.Port is not (80 or 443 or 5500 or 8080 or 8081))
            return false;

        return IsLanHost(uri.Host);
    }

    /// <summary>
    /// Suporta entradas wildcard no formato "https://*.dominio.com" (com porta opcional),
    /// casando apenas subdomínios do sufixo informado — o domínio raiz não é coberto.
    /// Ex.: "https://*.wadelivery.com.br" casa "https://fabin.wadelivery.com.br".
    /// </summary>
    public static bool MatchesWildcard(string pattern, string origin)
    {
        if (string.IsNullOrWhiteSpace(pattern) || pattern.IndexOf('*') < 0) return false;
        if (!Uri.TryCreate(origin, UriKind.Absolute, out var originUri)) return false;

        var schemeSep = pattern.IndexOf("://", StringComparison.Ordinal);
        if (schemeSep <= 0) return false;

        var patternScheme = pattern.Substring(0, schemeSep);
        if (!string.Equals(patternScheme, originUri.Scheme, StringComparison.OrdinalIgnoreCase))
            return false;

        var patternHost = pattern.Substring(schemeSep + 3);
        var colon = patternHost.LastIndexOf(':');
        if (colon > 0)
        {
            var patternPort = patternHost.Substring(colon + 1);
            if (int.TryParse(patternPort, out var port)
                && port != originUri.Port)
                return false;
            patternHost = patternHost.Substring(0, colon);
        }

        if (!patternHost.StartsWith("*.", StringComparison.Ordinal))
            return false;

        var suffix = patternHost.Substring(1);
        var originHost = originUri.Host;
        return originHost.Length > suffix.Length
            && originHost.EndsWith(suffix, StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsLanHost(string host)
    {
        if (string.IsNullOrWhiteSpace(host)) return false;
        if (IsPrivateOrLoopback(host)) return true;
        if (!host.Contains('.')) return true;
        if (host.EndsWith(".local", StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }

    public static bool IsPrivateOrLoopback(string host)
    {
        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
            return true;

        if (!IPAddress.TryParse(host, out var ip))
            return false;

        if (IPAddress.IsLoopback(ip))
            return true;

        if (ip.AddressFamily != AddressFamily.InterNetwork)
            return false;

        var b = ip.GetAddressBytes();
        if (b[0] == 10) return true;
        if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return true;
        if (b[0] == 192 && b[1] == 168) return true;
        return false;
    }
}
