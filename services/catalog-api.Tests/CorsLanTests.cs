using Catalog.Api;

namespace Catalog.Api.Tests;

public class CorsLanTests
{
    private static readonly string[] Configured =
    [
        "http://localhost:8081",
        "https://wadelivery.com.br",
        "https://www.wadelivery.com.br",
        "https://*.wadelivery.com.br"
    ];

    [Theory]
    [InlineData("http://localhost:8081")]
    [InlineData("https://wadelivery.com.br")]
    [InlineData("https://www.wadelivery.com.br")]
    public void Exact_configured_origins_are_allowed(string origin)
    {
        Assert.True(CorsLan.IsOriginAllowed(origin, Configured));
    }

    [Theory]
    [InlineData("https://fabin.wadelivery.com.br")]
    [InlineData("https://gota.acai.wadelivery.com.br")]
    public void Wildcard_matches_subdomains(string origin)
    {
        Assert.True(CorsLan.IsOriginAllowed(origin, Configured));
    }

    [Theory]
    [InlineData("https://outrodominio.com")]
    [InlineData("http://wadelivery.com.br")]
    [InlineData("https://wadelivery.com.br.evil.com")]
    public void Unconfigured_public_origins_are_rejected(string origin)
    {
        Assert.False(CorsLan.IsOriginAllowed(origin, Configured));
    }

    [Fact]
    public void Wildcard_does_not_match_bare_domain()
    {
        Assert.False(CorsLan.IsOriginAllowed("https://wadelivery.com.br", ["https://*.wadelivery.com.br"]));
    }

    [Fact]
    public void Wildcard_respects_scheme()
    {
        Assert.False(CorsLan.IsOriginAllowed("http://fabin.wadelivery.com.br", ["https://*.wadelivery.com.br"]));
    }

    [Fact]
    public void Wildcard_matches_when_port_matches()
    {
        Assert.True(CorsLan.IsOriginAllowed("https://fabin.wadelivery.com.br:8443", ["https://*.wadelivery.com.br:8443"]));
    }

    [Fact]
    public void Wildcard_rejects_when_port_differs()
    {
        Assert.False(CorsLan.IsOriginAllowed("https://fabin.wadelivery.com.br", ["https://*.wadelivery.com.br:8443"]));
    }

    [Theory]
    [InlineData("http://localhost:8080")]
    [InlineData("http://192.168.0.10:8080")]
    public void Lan_hosts_on_allowed_ports_are_still_allowed(string origin)
    {
        Assert.True(CorsLan.IsOriginAllowed(origin, []));
    }
}
