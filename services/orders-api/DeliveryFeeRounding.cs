namespace Orders.Api;

/// <summary>Arredonda taxa de entrega sempre para cima em múltiplos de R$ 0,50.</summary>
public static class DeliveryFeeRounding
{
    public static decimal RoundUpToHalfReal(decimal fee)
    {
        if (fee <= 0) return 0;
        return Math.Ceiling(fee * 2m) / 2m;
    }
}
