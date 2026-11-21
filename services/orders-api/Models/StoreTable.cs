namespace Orders.Api.Models;

public class StoreTable
{
    public int Id { get; set; }
    public int StoreId { get; set; }
    public string Label { get; set; } = string.Empty;
    public string AccessCode { get; set; } = string.Empty;
    public bool Active { get; set; } = true;
    public bool AllowCustomerOrder { get; set; } = true;
    public int? Capacity { get; set; }
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    /// <summary>Marca o fim da última sessão (fechamento da mesa). Comandas criadas
    /// após esse instante pertencem a uma nova sessão. NULL = mesa em atendimento.</summary>
    public DateTime? ClosedAtUtc { get; set; }

    /// <summary>Nome do responsável pela mesa na sessão atual (definido pelo garçom).</summary>
    public string? ResponsibleName { get; set; }

    /// <summary>Quantidade de pessoas na mesa (definido pelo garçom).</summary>
    public int? GuestCount { get; set; }
}

public record StoreTableDto(
    int Id,
    string Label,
    string? AccessCode,
    bool Active,
    bool AllowCustomerOrder,
    int? Capacity,
    DateTime CreatedAtUtc,
    int OpenOrders = 0,
    decimal OpenOrdersTotal = 0,
    /// <summary>Status da comanda aberta mais recente (ex.: Created, Preparing, ReadyForTable).</summary>
    string? OpenOrderStatus = null,
    /// <summary>Rótulo amigável do status acima (ex.: "Pronto para a mesa").</summary>
    string? OpenOrderStatusLabel = null,
    /// <summary>Nº de comandas da sessão atual (abertas + pagas, sem canceladas).</summary>
    int SessionOrders = 0,
    /// <summary>Total da sessão atual, incluindo comandas pagas.</summary>
    decimal SessionTotal = 0,
    /// <summary>Nome do responsável pela mesa (definido pelo garçom).</summary>
    string? ResponsibleName = null,
    /// <summary>Quantidade de pessoas na mesa (definido pelo garçom).</summary>
    int? GuestCount = null);

public record CreateStoreTableRequest(
    string Label,
    bool? AllowCustomerOrder = null,
    int? Capacity = null);

public record UpdateStoreTableRequest(
    string? Label = null,
    bool? AllowCustomerOrder = null,
    int? Capacity = null,
    string? ResponsibleName = null,
    int? GuestCount = null);

public record ResolveTableResponse(
    int TableId,
    string Label,
    int StoreId,
    bool Active,
    bool AllowCustomerOrder);

public record CloseTableRequest(string? PaymentMethod = null);

public record CloseTableResponse(
    int TableId,
    int ClosedOrders,
    decimal Total,
    List<string> OrderIds);

/// <summary>Request para atualização de informações da mesa pelo garçom.</summary>
public record UpdateTableInfoRequest(
    string? ResponsibleName = null,
    int? GuestCount = null);
