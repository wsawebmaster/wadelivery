using System.Net;
using System.Text;
using Microsoft.Extensions.Logging.Abstractions;
using Orders.Api;
using Orders.Api.Models;

namespace Orders.Api.Tests;

public class ModifierPricingTests
{
    private const string CatalogJson = """
    {
      "categories": [
        {
          "items": [
            {
              "id": "10",
              "name": "X Bacon",
              "price": 20,
              "modifierGroups": [
                {
                  "id": "g-adicionais",
                  "name": "Adicionais",
                  "min": 0,
                  "max": 10,
                  "options": [
                    { "id": "o-bacon", "name": "Bacon extra", "priceDelta": 8 },
                    { "id": "o-cheddar", "name": "Cheddar", "priceDelta": 5 },
                    { "id": "o-ovo", "name": "Ovo", "priceDelta": 3, "available": false }
                  ]
                },
                {
                  "id": "g-molho",
                  "name": "Molho",
                  "min": 1,
                  "max": 1,
                  "options": [
                    { "id": "o-maionese", "name": "Maionese", "priceDelta": 0 },
                    { "id": "o-ketchup", "name": "Ketchup", "priceDelta": 0 }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
    """;

    [Fact]
    public async Task PriceItemsAsync_SumsCatalogDeltasIgnoringClientPrice()
    {
        var client = new CatalogPricingClient(StubHttp(), NullLogger<CatalogPricingClient>.Instance);

        var items = new List<OrderItemDto>
        {
            new("10", "X Bacon", 999, 2, new List<OrderItemModifierDto>
            {
                new("g-adicionais", "o-bacon", "Bacon extra", 0),
                new("g-molho", "o-maionese", "Maionese", 0)
            })
        };

        var (priced, total, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(28m, priced[0].Price);
        Assert.Equal(56m, total);
        Assert.NotNull(priced[0].Modifiers);
        Assert.Equal(2, priced[0].Modifiers!.Count);
        Assert.Equal(8m, priced[0].Modifiers!.Single(m => m.OptionId == "o-bacon").PriceDelta);
        Assert.Equal("Maionese", priced[0].Modifiers!.Single(m => m.OptionId == "o-maionese").Name);
    }

    [Fact]
    public async Task PriceItemsAsync_RejectsUnknownGroup()
    {
        var client = new CatalogPricingClient(StubHttp(), NullLogger<CatalogPricingClient>.Instance);

        var items = new List<OrderItemDto>
        {
            new("10", "X Bacon", 20, 1, new List<OrderItemModifierDto>
            {
                new("g-inexistente", "o-bacon", "Bacon extra", 8),
                new("g-molho", "o-maionese", "Maionese", 0)
            })
        };

        var (_, _, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.NotNull(error);
        Assert.Contains("não disponível", error);
    }

    [Fact]
    public async Task PriceItemsAsync_RejectsUnavailableOption()
    {
        var client = new CatalogPricingClient(StubHttp(), NullLogger<CatalogPricingClient>.Instance);

        var items = new List<OrderItemDto>
        {
            new("10", "X Bacon", 20, 1, new List<OrderItemModifierDto>
            {
                new("g-adicionais", "o-ovo", "Ovo", 3),
                new("g-molho", "o-maionese", "Maionese", 0)
            })
        };

        var (_, _, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.NotNull(error);
        Assert.Contains("indisponível", error);
    }

    [Fact]
    public async Task PriceItemsAsync_RejectsMissingOptionId()
    {
        var client = new CatalogPricingClient(StubHttp(), NullLogger<CatalogPricingClient>.Instance);

        var items = new List<OrderItemDto>
        {
            new("10", "X Bacon", 20, 1, new List<OrderItemModifierDto>
            {
                new("g-adicionais", "", "Bacon extra", 8),
                new("g-molho", "o-maionese", "Maionese", 0)
            })
        };

        var (_, _, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.NotNull(error);
        Assert.Contains("Adição inválida", error);
    }

    [Fact]
    public async Task PriceItemsAsync_EnforcesMinSelection()
    {
        var client = new CatalogPricingClient(StubHttp(), NullLogger<CatalogPricingClient>.Instance);

        var items = new List<OrderItemDto>
        {
            new("10", "X Bacon", 20, 1, new List<OrderItemModifierDto>
            {
                new("g-adicionais", "o-bacon", "Bacon extra", 8)
            })
        };

        var (_, _, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.NotNull(error);
        Assert.Contains("ao menos 1", error);
    }

    [Fact]
    public async Task PriceItemsAsync_MaxZeroMeansUpToTen()
    {
        const string json = """
        {
          "categories": [
            {
              "items": [
                {
                  "id": "10",
                  "name": "X Bacon",
                  "price": 20,
                  "modifierGroups": [
                    {
                      "id": "g-livre",
                      "name": "Livre",
                      "min": 0,
                      "max": 0,
                      "options": [
                        { "id": "o-1", "name": "Um", "priceDelta": 1 },
                        { "id": "o-2", "name": "Dois", "priceDelta": 2 },
                        { "id": "o-3", "name": "Três", "priceDelta": 3 },
                        { "id": "o-4", "name": "Quatro", "priceDelta": 4 },
                        { "id": "o-5", "name": "Cinco", "priceDelta": 5 },
                        { "id": "o-6", "name": "Seis", "priceDelta": 6 },
                        { "id": "o-7", "name": "Sete", "priceDelta": 7 },
                        { "id": "o-8", "name": "Oito", "priceDelta": 8 },
                        { "id": "o-9", "name": "Nove", "priceDelta": 9 },
                        { "id": "o-10", "name": "Dez", "priceDelta": 10 },
                        { "id": "o-11", "name": "Onze", "priceDelta": 11 }
                      ]
                    }
                  ]
                }
              ]
            }
          ]
        }
        """;
        var client = new CatalogPricingClient(StubHttp(json), NullLogger<CatalogPricingClient>.Instance);

        var all = Enumerable.Range(1, 11)
            .Select(i => new OrderItemModifierDto("g-livre", $"o-{i}", $"Opção {i}", i))
            .ToList();
        var items = new List<OrderItemDto> { new("10", "X Bacon", 20, 1, all) };

        var (_, _, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.NotNull(error);
        Assert.Contains("Máximo de 10", error);
    }

    private const string RecoverCatalogJson = """
    {
      "categories": [
        {
          "items": [
            {
              "id": "10",
              "name": "X Bacon",
              "price": 20,
              "modifierGroups": [
                {
                  "id": "g-adicionais",
                  "name": "Adicionais",
                  "min": 0,
                  "max": 10,
                  "options": [
                    { "id": "o-bacon", "name": "Bacon extra", "priceDelta": 8 },
                    { "id": "o-cheddar", "name": "Cheddar", "priceDelta": 5 },
                    { "id": "o-ovo", "name": "Ovo", "priceDelta": 3, "available": false }
                  ]
                }
              ]
            }
          ]
        }
      ]
    }
    """;

    [Fact]
    public async Task PriceItemsAsync_RecoversInlineAddonFromName()
    {
        var client = new CatalogPricingClient(StubHttp(RecoverCatalogJson), NullLogger<CatalogPricingClient>.Instance);
        var items = new List<OrderItemDto> { new("10", "X Bacon (Adic. Bacon extra +8,00)", 20, 1, null) };

        var (priced, total, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(28m, priced[0].Price);
        Assert.Equal(28m, total);
        Assert.NotNull(priced[0].Modifiers);
        Assert.Equal("o-bacon", priced[0].Modifiers!.Single().OptionId);
    }

    [Fact]
    public async Task PriceItemsAsync_RecoversMultipleInlineAddons()
    {
        var client = new CatalogPricingClient(StubHttp(RecoverCatalogJson), NullLogger<CatalogPricingClient>.Instance);
        var items = new List<OrderItemDto>
        {
            new("10", "X Bacon (Sem Cebola; Adic. Bacon extra +8,00; Adic. Cheddar +5,00)", 20, 2, null)
        };

        var (priced, total, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(33m, priced[0].Price);
        Assert.Equal(66m, total);
        Assert.Equal(2, priced[0].Modifiers!.Count);
    }

    [Fact]
    public async Task PriceItemsAsync_IgnoresInlineAddonPrice()
    {
        var client = new CatalogPricingClient(StubHttp(RecoverCatalogJson), NullLogger<CatalogPricingClient>.Instance);
        var items = new List<OrderItemDto> { new("10", "X Bacon (Adic. Bacon extra +99,00)", 20, 1, null) };

        var (priced, _, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(28m, priced[0].Price);
    }

    [Fact]
    public async Task PriceItemsAsync_SkipsUnknownAndUnavailableInlineAddons()
    {
        var client = new CatalogPricingClient(StubHttp(RecoverCatalogJson), NullLogger<CatalogPricingClient>.Instance);
        var items = new List<OrderItemDto>
        {
            new("10", "X Bacon (Adic. Catupiry +4,00; Adic. Ovo +3,00)", 20, 1, null)
        };

        var (priced, _, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(20m, priced[0].Price);
        Assert.Null(priced[0].Modifiers);
    }

    [Fact]
    public async Task PriceItemsAsync_StructuredModifiersWinOverInlineName()
    {
        var client = new CatalogPricingClient(StubHttp(RecoverCatalogJson), NullLogger<CatalogPricingClient>.Instance);
        var items = new List<OrderItemDto>
        {
            new("10", "X Bacon (Adic. Cheddar +5,00)", 20, 1, new List<OrderItemModifierDto>
            {
                new("g-adicionais", "o-bacon", "Bacon extra", 8)
            })
        };

        var (priced, _, error) = await client.PriceItemsAsync(items, CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(28m, priced[0].Price);
        Assert.Single(priced[0].Modifiers!);
        Assert.Equal("o-bacon", priced[0].Modifiers!.Single().OptionId);
    }

    private static HttpClient StubHttp(string? catalogJson = null, HttpStatusCode status = HttpStatusCode.OK)
    {
        var handler = new StubHttpMessageHandler(catalogJson ?? CatalogJson, status);
        return new HttpClient(handler) { BaseAddress = new Uri("http://localhost/") };
    }

    private sealed class StubHttpMessageHandler(string catalogJson, HttpStatusCode status) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            var response = new HttpResponseMessage(status)
            {
                Content = new StringContent(catalogJson, Encoding.UTF8, "application/json")
            };
            return Task.FromResult(response);
        }
    }
}
