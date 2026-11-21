using System.ComponentModel.DataAnnotations.Schema;

namespace Catalog.Api.Data;

public class Loja
{
    public int Id { get; set; } = 1;
    public int TenantId => Id;
    public string Nome { get; set; } = string.Empty;
    [NotMapped]
    public string StoreName { get => Nome; set => Nome = value; }
    public string? Slug { get; set; }
    public string? Cnpj { get; set; }
    [NotMapped]
    public string? CNPJ { get => Cnpj; set => Cnpj = value; }
    public string Telefone { get; set; } = string.Empty;
    [NotMapped]
    public string Whatsapp { get => Telefone; set => Telefone = value; }
    public string? Email { get; set; }
    public string? Endereco { get; set; }
    [NotMapped]
    public string? Address { get => Endereco; set => Endereco = value; }
    public string? Cep { get; set; }
    public string? City { get; set; }
    public string? State { get; set; }
    public string? LogoUrl { get; set; }
    public string? BannerUrl { get; set; }
    public string? CoverUrl { get; set; }
    public string CorPrimaria { get; set; } = "#1f6feb";
    public string CorSecundaria { get; set; } = "#ffffff";
    public string CorFundo { get; set; } = "#f3f4f6";
    public string CorTexto { get; set; } = "#2c3e50";
    public string TipoCard { get; set; } = "foto-grande";
    public string LayoutCardapio { get; set; } = "grade";
    public string EstiloBotao { get; set; } = "arredondado";
    public bool IsTeste { get; set; }
    public DateTime DataCriacao { get; set; } = DateTime.UtcNow;
    public DateTime DataAtualizacao { get; set; } = DateTime.UtcNow;
    public string PixKey { get; set; } = string.Empty;
    public string PixKeyLabel { get; set; } = "Telefone";
    public decimal MinOrder { get; set; }
    public string CurrencyLocale { get; set; } = "pt-BR";
    public string ScheduleJson { get; set; } = "{}";
    public string DeliveryFeesJson { get; set; } = "{}";
    public double? Latitude { get; set; }
    public double? Longitude { get; set; }
    public decimal DeliveryFeePerKm { get; set; }
    public decimal MaxDeliveryKm { get; set; }
    public decimal MinDeliveryFee { get; set; }
    public int AverageDeliveryMinutes { get; set; } = 40;
    public string? BreadOptionsJson { get; set; }
    public bool AcceptingOrders { get; set; } = true;
    public string? AddressNumber { get; set; }
    public string? IconUrl { get; set; }
    public DateTime? ExtendedCloseUntilUtc { get; set; }
    public bool AutoAdvancePreparing { get; set; }
    public int AutoAdvancePreparingMinutes { get; set; } = 5;
    public bool DineInEnabled { get; set; }
    public bool CustomerQrOrdersEnabled { get; set; }
    public bool WaiterOrdersEnabled { get; set; }
    public bool AllowManualTableEntry { get; set; }
    public bool RequireCustomerNameForQrOrder { get; set; }
    public bool AllowCustomerChooseWaiter { get; set; }
    public int? TableCount { get; set; }
    public int WaiterSessionHours { get; set; } = 8;
}
