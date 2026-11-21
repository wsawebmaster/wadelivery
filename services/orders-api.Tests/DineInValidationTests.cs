using Orders.Api;
using Orders.Api.Models;

namespace Orders.Api.Tests;

public class DineInValidationTests
{
    private static CreateOrderRequest Delivery() => new(
        OrderId: null,
        CustomerName: "Maria Silva",
        CustomerPhone: "(11) 99999-0000",
        Address: "Rua A, 123",
        Neighborhood: "Centro",
        Reference: null,
        PaymentMethod: "Pix",
        PaymentTiming: "on_delivery",
        Notes: null,
        DeliveryFee: 8,
        Items: [new("1", "X Frango", 20, 1)],
        FulfillmentType: "delivery");

    private static CreateOrderRequest Pickup() => new(
        OrderId: null,
        CustomerName: "Maria Silva",
        CustomerPhone: "(11) 99999-0000",
        Address: "Retirada no local",
        Neighborhood: "Retirada",
        Reference: null,
        PaymentMethod: "Pix",
        PaymentTiming: "on_pickup",
        Notes: null,
        DeliveryFee: 0,
        Items: [new("1", "X Frango", 20, 1)],
        FulfillmentType: "pickup");

    private static CreateOrderRequest DineInQr() => new(
        OrderId: null,
        CustomerName: "Maria Silva",
        CustomerPhone: "",
        Address: "Consumo no local",
        Neighborhood: "Mesa",
        Reference: null,
        PaymentMethod: "Pix",
        PaymentTiming: "on_delivery",
        Notes: null,
        DeliveryFee: 0,
        Items: [new("1", "X Frango", 20, 1)],
        FulfillmentType: "dine_in",
        TableAccessCode: "CODIGO-OPACO",
        OrderSource: "customer_qr");

    // §14: pedido delivery antigo continua criando (sem validação de dine-in)
    [Fact]
    public void ValidateCreate_Delivery_ContinuesToPass()
    {
        Assert.Null(OrderValidation.ValidateCreate(Delivery()));
    }

    // §14: pedido pickup antigo continua criando
    [Fact]
    public void ValidateCreate_Pickup_ContinuesToPass()
    {
        Assert.Null(OrderValidation.ValidateCreate(Pickup()));
    }

    // §14: pedido dine-in válido via QR Code passa
    [Fact]
    public void ValidateCreate_DineInQr_Passes()
    {
        Assert.Null(OrderValidation.ValidateCreate(DineInQr()));
    }

    // §14: dine-in não exige nome nem telefone (campos novos opcionais)
    [Fact]
    public void ValidateCreate_DineIn_AllowsMissingNameAndPhone()
    {
        var req = DineInQr() with { CustomerName = "", CustomerPhone = "" };
        Assert.Null(OrderValidation.ValidateCreate(req));
    }

    // §14: dine-in sem origem é inválido
    [Fact]
    public void ValidateCreate_DineIn_RequiresOrderSource()
    {
        var req = DineInQr() with { OrderSource = null };
        var err = OrderValidation.ValidateCreate(req);
        Assert.NotNull(err);
        Assert.Contains("Origem", err);
    }

    // §14: QR Code inválido retorna erro sem permitir pedido (sem tableAccessCode)
    [Fact]
    public void ValidateCreate_CustomerQr_RequiresTableAccessCode()
    {
        var req = DineInQr() with { OrderSource = "customer_qr", TableAccessCode = null };
        var err = OrderValidation.ValidateCreate(req);
        Assert.NotNull(err);
        Assert.Contains("mesa", err);
    }

    // §14: pedido de garçom exige mesa; cliente não pode usar somente tableId
    [Fact]
    public void ValidateCreate_WaiterPanel_RequiresTableId()
    {
        var req = DineInQr() with { OrderSource = "waiter_panel", TableId = null };
        var err = OrderValidation.ValidateCreate(req);
        Assert.NotNull(err);
        Assert.Contains("mesa", err, StringComparison.OrdinalIgnoreCase);
    }

    // Garçom registra pagamento "Em Aberto" — definido apenas no fechamento da mesa
    [Fact]
    public void ValidateCreate_WaiterPanel_AllowsEmAbertoPayment()
    {
        var req = DineInQr() with { OrderSource = "waiter_panel", TableId = 1, PaymentMethod = "Em Aberto" };
        Assert.Null(OrderValidation.ValidateCreate(req));
    }

    // Admin registra pagamento "Em Aberto" assim como o garçom
    [Fact]
    public void ValidateCreate_AdminPanel_AllowsEmAbertoPayment()
    {
        var req = DineInQr() with { OrderSource = "admin_panel", TableId = 1, PaymentMethod = "Em Aberto" };
        Assert.Null(OrderValidation.ValidateCreate(req));
    }

    // Cliente (QR) NÃO pode usar "Em Aberto" — continua exigindo método real
    [Fact]
    public void ValidateCreate_CustomerQr_RejectsEmAbertoPayment()
    {
        var req = DineInQr() with { PaymentMethod = "Em Aberto" };
        var err = OrderValidation.ValidateCreate(req);
        Assert.NotNull(err);
        Assert.Contains("pagamento", err, StringComparison.OrdinalIgnoreCase);
    }

    // delivery continua exigindo método real (não aceita "Em Aberto")
    [Fact]
    public void ValidateCreate_Delivery_RejectsEmAbertoPayment()
    {
        var req = Delivery() with { PaymentMethod = "Em Aberto" };
        var err = OrderValidation.ValidateCreate(req);
        Assert.NotNull(err);
        Assert.Contains("pagamento", err, StringComparison.OrdinalIgnoreCase);
    }

    // Cliente usando waiter_panel sem tableId também falha (mesa obrigatória)
    [Fact]
    public void ValidateCreate_CustomerCannotForgeTableById_WhenSourceMissing()
    {
        // Sem tableAccessCode e sem tableId no customer_qr → erro (não forja mesa)
        var req = DineInQr() with { OrderSource = "customer_qr", TableAccessCode = null };
        Assert.NotNull(OrderValidation.ValidateCreate(req));
    }

    // Origem inválida é rejeitada
    [Fact]
    public void ValidateCreate_DineIn_RejectsUnknownSource()
    {
        var req = DineInQr() with { OrderSource = "hacker" };
        var err = OrderValidation.ValidateCreate(req);
        Assert.NotNull(err);
        Assert.Contains("inválida", err);
    }

    // delivery continua exigindo endereço/nome/telefone
    [Fact]
    public void ValidateCreate_Delivery_StillRequiresAddress()
    {
        var req = Delivery() with { Address = "" };
        Assert.NotNull(OrderValidation.ValidateCreate(req));
    }

    [Fact]
    public void ValidateCreate_Delivery_StillRequiresPhone()
    {
        var req = Delivery() with { CustomerPhone = "" };
        Assert.NotNull(OrderValidation.ValidateCreate(req));
    }

    // ── Atendimento (Balcão / Delivery / Telefone) ──
    // Equipe registra "Em Aberto" também fora do dine-in (baixa feita depois no painel)
    [Fact]
    public void ValidateCreate_Balcao_AllowsEmAbertoPayment()
    {
        var req = Pickup() with { OrderSource = "balcao", PaymentMethod = "Em Aberto" };
        Assert.Null(OrderValidation.ValidateCreate(req));
    }

    [Fact]
    public void ValidateCreate_Telefone_AllowsEmAbertoPayment()
    {
        var req = Delivery() with { OrderSource = "telefone", PaymentMethod = "Em Aberto" };
        Assert.Null(OrderValidation.ValidateCreate(req));
    }

    [Fact]
    public void ValidateCreate_DeliveryStaff_AllowsEmAbertoPayment()
    {
        var req = Delivery() with { OrderSource = "delivery", PaymentMethod = "Em Aberto" };
        Assert.Null(OrderValidation.ValidateCreate(req));
    }

    // Origem desconhecida fora do dine-in continua sendo rejeitada
    [Fact]
    public void ValidateCreate_NonDineIn_RejectsUnknownSource()
    {
        var req = Delivery() with { OrderSource = "hacker" };
        var err = OrderValidation.ValidateCreate(req);
        Assert.NotNull(err);
        Assert.Contains("inválida", err);
    }

    // Atendimento por telefone ainda exige endereço/telefone do cliente
    [Fact]
    public void ValidateCreate_Telefone_StillRequiresAddressAndPhone()
    {
        var noAddr = Delivery() with { OrderSource = "telefone", Address = "" };
        Assert.NotNull(OrderValidation.ValidateCreate(noAddr));

        var noPhone = Delivery() with { OrderSource = "telefone", CustomerPhone = "" };
        Assert.NotNull(OrderValidation.ValidateCreate(noPhone));
    }

    // Balcão/Telefone/Delivery são reconhecidos como origens de equipe
    [Fact]
    public void IsStaffSource_IncludesAtendimentoSources()
    {
        Assert.True(OrderValidation.IsStaffSource("balcao"));
        Assert.True(OrderValidation.IsStaffSource("telefone"));
        Assert.True(OrderValidation.IsStaffSource("delivery"));
        Assert.True(OrderValidation.IsStaffSource("waiter_panel"));
        Assert.True(OrderValidation.IsStaffSource("admin_panel"));
        Assert.False(OrderValidation.IsStaffSource("customer_qr"));
        Assert.False(OrderValidation.IsStaffSource(null));
        Assert.False(OrderValidation.IsStaffSource(""));
    }
}

public class DineInStatusTests
{
    [Fact]
    public void IsDineIn_RecognizesDineIn()
    {
        Assert.True(OrderStatus.IsDineIn("dine_in"));
        Assert.True(OrderStatus.IsDineIn("DINE_IN"));
        Assert.False(OrderStatus.IsDineIn("delivery"));
        Assert.False(OrderStatus.IsDineIn("pickup"));
        Assert.False(OrderStatus.IsDineIn(null));
    }

    // §14: status ReadyForTable segue transição correta
    [Fact]
    public void DineInSequence_HasReadyForTable()
    {
        Assert.Equal(OrderStatus.ReadyForTable, OrderStatus.Next(OrderStatus.Preparing, "dine_in"));
        Assert.Equal(OrderStatus.Delivered, OrderStatus.Next(OrderStatus.ReadyForTable, "dine_in"));
        Assert.Null(OrderStatus.Next(OrderStatus.Delivered, "dine_in"));
    }

    [Fact]
    public void DeliverySequence_Unchanged()
    {
        Assert.Equal(OrderStatus.OutForDelivery, OrderStatus.Next(OrderStatus.Preparing, "delivery"));
        // dine_in NÃO usa OutForDelivery → ReadyForPickup não entra na sequência
        Assert.NotEqual(OrderStatus.OutForDelivery, OrderStatus.Next(OrderStatus.Preparing, "dine_in"));
    }

    // §14/§8: ReadyForTable pode ser cancelado e confirmado no fluxo
    [Fact]
    public void ReadyForTable_CanCancel()
    {
        Assert.True(OrderStatus.CanCancel(OrderStatus.ReadyForTable));
        Assert.True(OrderStatus.CanTransition(OrderStatus.ReadyForTable, OrderStatus.Cancelled, "dine_in"));
    }

    [Fact]
    public void ReadyForTable_Label_IsFriendly()
    {
        Assert.Equal("Pronto para a mesa", OrderStatus.Label(OrderStatus.ReadyForTable));
    }

    [Fact]
    public void CanTransition_DineIn_DoesNotUseDeliveryStatuses()
    {
        Assert.True(OrderStatus.CanTransition(OrderStatus.Preparing, OrderStatus.ReadyForTable, "dine_in"));
        Assert.False(OrderStatus.CanTransition(OrderStatus.Preparing, OrderStatus.OutForDelivery, "dine_in"));
    }

    // Garçom só marca "Entregue na mesa" quando a comanda já está "Pronto para a mesa"
    [Fact]
    public void DineIn_DeliveredOnlyAfterReadyForTable()
    {
        Assert.True(OrderStatus.CanTransition(OrderStatus.ReadyForTable, OrderStatus.Delivered, "dine_in"));
        Assert.False(OrderStatus.CanTransition(OrderStatus.Created, OrderStatus.Delivered, "dine_in"));
        Assert.False(OrderStatus.CanTransition(OrderStatus.Accepted, OrderStatus.Delivered, "dine_in"));
        Assert.False(OrderStatus.CanTransition(OrderStatus.Preparing, OrderStatus.Delivered, "dine_in"));
        Assert.False(OrderStatus.CanTransition(OrderStatus.Delivered, OrderStatus.ReadyForTable, "dine_in"));
    }

    [Fact]
    public void Delivery_CannotJumpToDelivered()
    {
        Assert.False(OrderStatus.CanTransition(OrderStatus.Created, OrderStatus.Delivered, "delivery"));
        Assert.False(OrderStatus.CanTransition(OrderStatus.Preparing, OrderStatus.Delivered, "delivery"));
    }

    // compat: delivery continua usando a sequência de entrega
    [Fact]
    public void CanTransition_Delivery_Unchanged()
    {
        Assert.True(OrderStatus.CanTransition(OrderStatus.Preparing, OrderStatus.OutForDelivery, "delivery"));
        Assert.False(OrderStatus.CanTransition(OrderStatus.Preparing, OrderStatus.ReadyForTable, "delivery"));
    }
}
