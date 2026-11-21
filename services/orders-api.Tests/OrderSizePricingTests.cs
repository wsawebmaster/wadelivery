using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;
using Orders.Api;
using Orders.Api.Models;

namespace Orders.Api.Tests;

public class OrderSizePricingTests
{
    private const string CatalogJson = """
    {
      "categories": [
        {
          "items": [
            { "id": "8", "name": "Batata Frita com Queijo e Bacon", "price": 55, "priceMedia": 55, "priceInteira": 75 },
            { "id": "5", "name": "Batata Frita", "price": 36, "priceMedia": 36, "priceInteira": 51 },
            { "id": "32", "name": "X Frango", "price": 24 }
          ]
        }
      ]
    }
    """;

    [Theory]
    [InlineData("Batata Frita com Queijo e Bacon (Inteira)", "Inteira")]
    [InlineData("Batata Frita (Média)", "Média")]
    [InlineData("Batata Frita (Media)", "Média")]
    [InlineData("Batata Frita (INTEIRA)", "Inteira")]
    [InlineData("Batata Frita (Inteira) (Obs.: sem sal)", "Inteira")]
    [InlineData("Batata Frita", null)]
    [InlineData("X Frango (Pão francês)", null)]
    [InlineData("X Frango (Normal)", null)]
    public void ExtractSizeOption_RecognizesPortionSizesOnly(string name, string? expected)
    {
        Assert.Equal(expected, OrderValidation.ExtractSizeOption(name));
    }

    [Theory]
    [InlineData("8", "Batata Frita com Queijo e Bacon (Inteira)", 75)]
    [InlineData("8", "Batata Frita com Queijo e Bacon (Média)", 55)]
    [InlineData("8", "Batata Frita com Queijo e Bacon", 55)]
    [InlineData("5", "Batata Frita (Inteira)", 51)]
    [InlineData("32", "X Frango (Pão francês)", 24)]
    public void ResolveUnitPrice_UsesSizePriceWhenAvailable(string id, string name, decimal expected)
    {
        var product = new CatalogPricingClient.ProductPayload
        {
            Id = id,
            Name = "Batata Frita com Queijo e Bacon",
            Price = 55,
            PriceMedia = 55,
            PriceInteira = 75
        };
        if (id == "5")
        {
            product.Name = "Batata Frita";
            product.Price = 36;
            product.PriceMedia = 36;
            product.PriceInteira = 51;
        }
        else if (id == "32")
        {
            product.Name = "X Frango";
            product.Price = 24;
            product.PriceMedia = null;
            product.PriceInteira = null;
        }

        Assert.Equal(expected, CatalogPricingClient.ResolveUnitPrice(product, name));
    }

    [Fact]
    public async Task PriceItemsAsync_PricesInteiraFromCatalog()
    {
        var client = new CatalogPricingClient(StubHttp(CatalogJson), NullLogger<CatalogPricingClient>.Instance);

        var items = new List<OrderItemDto>
        {
            new("8", "Batata Frita com Queijo e Bacon (Inteira)", 55, 1)
        };

        var (priced, total, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(75m, priced[0].Price);
        Assert.Equal(75m, total);
    }

    [Fact]
    public async Task PriceItemsAsync_PricesMediaFromCatalog()
    {
        var client = new CatalogPricingClient(StubHttp(CatalogJson), NullLogger<CatalogPricingClient>.Instance);

        var items = new List<OrderItemDto>
        {
            new("8", "Batata Frita com Queijo e Bacon (Média)", 55, 2)
        };

        var (priced, total, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(55m, priced[0].Price);
        Assert.Equal(110m, total);
    }

    [Fact]
    public async Task PriceItemsAsync_PricesByBaseNameWithoutProductId()
    {
        var client = new CatalogPricingClient(StubHttp(CatalogJson), NullLogger<CatalogPricingClient>.Instance);

        var items = new List<OrderItemDto>
        {
            new(null, "Batata Frita (Inteira)", 36, 1)
        };

        var (priced, total, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(51m, priced[0].Price);
        Assert.Equal(51m, total);
    }

    [Fact]
    public async Task PriceItemsAsync_UnknownProductReturnsError()
    {
        var client = new CatalogPricingClient(StubHttp(CatalogJson), NullLogger<CatalogPricingClient>.Instance);

        var items = new List<OrderItemDto>
        {
            new("999", "Inexistente", 10, 1)
        };

        var (_, _, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.NotNull(error);
        Assert.Contains("não encontrado", error);
    }

    private static HttpClient StubHttp(string catalogJson)
    {
        var handler = new StubHttpMessageHandler(catalogJson);
        return new HttpClient(handler) { BaseAddress = new Uri("http://localhost/") };
    }

    private sealed class StubHttpMessageHandler(string catalogJson) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var response = new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(catalogJson, Encoding.UTF8, "application/json")
            };
            return Task.FromResult(response);
        }
    }
}
