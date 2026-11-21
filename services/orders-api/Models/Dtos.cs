namespace Orders.Api.Models;

/// <summary>Adição estruturada de um item (grupo de modificadores + opção escolhida).</summary>
public record OrderItemModifierDto(
    string? GroupId = null,
    string? OptionId = null,
    string Name = "",
    decimal PriceDelta = 0);

public record OrderItemDto(string? ProductId, string Name, decimal Price, int Quantity, List<OrderItemModifierDto>? Modifiers = null);

public record CreateOrderRequest(
    string? OrderId,
    string CustomerName,
    string CustomerPhone,
    string Address,
    string? Neighborhood,
    string? Reference,
    string PaymentMethod,
    string? PaymentTiming,
    string? Notes,
    decimal DeliveryFee,
    List<OrderItemDto> Items,
    double? CustomerLatitude = null,
    double? CustomerLongitude = null,
    string? Cep = null,
    string? Number = null,
    string? City = null,
    string? State = null,
    /// <summary>delivery (padrão) | pickup | dine_in</summary>
    string? FulfillmentType = null,
    /// <summary>Cliente pediu troco (pagamento em dinheiro).</summary>
    bool? NeedsChange = null,
    /// <summary>Valor informado pelo cliente: "troco para quanto?" (dinheiro).</summary>
    decimal? ChangeFor = null,
    // ── Dine-in fields ──
    /// <summary>Código de acesso da mesa (usado pelo cliente via QR Code).</summary>
    string? TableAccessCode = null,
    /// <summary>ID da mesa (usado pelo garçom via painel autenticado).</summary>
    int? TableId = null,
    /// <summary>Origem: customer_qr | waiter_panel | admin_panel.</summary>
    string? OrderSource = null,
    /// <summary>Nome do garçom (snapshotted, não confiável — fonte é o JWT).</summary>
    string? WaiterName = null,
    string? DiningSessionId = null,
    /// <summary>
    /// Chave de idempotência do cliente (UUID gerado no checkout e reutilizado em
    /// retries). Se o mesmo ClientRequestId + StoreId já existir, o pedido NÃO é
    /// criado de novo — o servidor devolve o pedido existente. Evita duplicidade
    /// quando o processamento demora e o cliente reenvia o pedido.
    /// </summary>
    string? ClientRequestId = null);

public record UpdateOrderStatusRequest(
    string Status,
    string? CancellationReasonCode = null,
    string? CancellationReason = null,
    bool? CustomerRequested = null);

public record UpdateOrderPaymentRequest(string PaymentStatus, string? PaymentMethod = null);

public record OrderResponse(
    string OrderId,
    string CustomerName,
    string CustomerPhone,
    string Address,
    string? Neighborhood,
    string? Reference,
    string PaymentMethod,
    string PaymentTiming,
    string PaymentTimingLabel,
    string PaymentStatus,
    string PaymentStatusLabel,
    string? Notes,
    decimal DeliveryFee,
    decimal ItemsTotal,
    decimal Total,
    string Status,
    string StatusLabel,
    string? NextStatus,
    string? NextStatusLabel,
    DateTime CreatedAtUtc,
    DateTime? StatusUpdatedAtUtc,
    DateTime? AcceptedAtUtc,
    List<OrderItemDto> Items,
    string? AccessToken = null,
    bool CustomerReceived = false,
    DateTime? CustomerReceivedAtUtc = null,
    string? CancellationReasonCode = null,
    string? CancellationReason = null,
    bool CancellationCustomerRequested = false,
    string FulfillmentType = "delivery",
    DateTime? ItemsUpdatedAtUtc = null,
    string? ItemsChangeSummary = null,
    decimal? PreviousItemsTotal = null,
    string? Cep = null,
    /// <summary>Cliente pediu troco (pagamento em dinheiro).</summary>
    bool NeedsChange = false,
    /// <summary>Valor informado pelo cliente: "troco para quanto?" (dinheiro).</summary>
    decimal? ChangeFor = null,
    // ── Dine-in fields ──
    int? TableId = null,
    string? TableLabel = null,
    string? OrderSource = null,
    string? CreatedByUsername = null,
    string? WaiterName = null,
    string? CreatedByRole = null);

public record UpdateOrderItemsRequest(List<OrderItemDto> Items);

public record OrderCreatedEvent(
    string OrderId,
    string CustomerName,
    string CustomerPhone,
    decimal Total,
    DateTime CreatedAtUtc);

public record NamedCountDto(string Name, int Count, decimal Revenue);

public record DailySalesDto(string Date, int Orders, decimal Revenue);

public record StatusCountDto(string Status, string Label, int Count);

public record DashboardResponse(
    int Days,
    DateTime FromUtc,
    DateTime ToUtc,
    int TotalOrders,
    int OrdersToday,
    int OpenOrders,
    int DeliveredOrders,
    int CancelledOrders,
    decimal GrossRevenue,
    decimal ItemsRevenue,
    decimal DeliveryRevenue,
    decimal AverageTicket,
    List<StatusCountDto> ByStatus,
    List<NamedCountDto> TopProducts,
    List<NamedCountDto> TopNeighborhoods,
    List<NamedCountDto> ByPayment,
    List<NamedCountDto> ByCancellationReason,
    List<NamedCountDto> ByFulfillment,
    List<DailySalesDto> DailySales,
    string Period = "today",
    string PeriodLabel = "Hoje");
