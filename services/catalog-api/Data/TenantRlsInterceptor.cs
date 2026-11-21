using System.Data.Common;
using Catalog.Api.MultiTenancy;
using Microsoft.EntityFrameworkCore.Diagnostics;

namespace Catalog.Api.Data;

/// <summary>
/// Sets the PostgreSQL session variable 'app.current_store_id' (session-scoped)
/// immediately before every command, enabling Row-Level Security (RLS) policies.
/// Setting on every execution keeps the value correct even with connection pooling.
/// </summary>
public class TenantRlsInterceptor(TenantContext tenant) : DbCommandInterceptor
{
    public override InterceptionResult<DbDataReader> ReaderExecuting(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result)
    {
        SetTenant(command);
        return result;
    }

    public override async ValueTask<InterceptionResult<DbDataReader>> ReaderExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<DbDataReader> result,
        CancellationToken cancellationToken = default)
    {
        await SetTenantAsync(command, cancellationToken);
        return result;
    }

    public override InterceptionResult<int> NonQueryExecuting(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result)
    {
        SetTenant(command);
        return result;
    }

    public override async ValueTask<InterceptionResult<int>> NonQueryExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<int> result,
        CancellationToken cancellationToken = default)
    {
        await SetTenantAsync(command, cancellationToken);
        return result;
    }

    public override InterceptionResult<object> ScalarExecuting(
        DbCommand command, CommandEventData eventData, InterceptionResult<object> result)
    {
        SetTenant(command);
        return result;
    }

    public override async ValueTask<InterceptionResult<object>> ScalarExecutingAsync(
        DbCommand command, CommandEventData eventData, InterceptionResult<object> result,
        CancellationToken cancellationToken = default)
    {
        await SetTenantAsync(command, cancellationToken);
        return result;
    }

    private void SetTenant(DbCommand command)
    {
        if (command.Connection is null) return;
        var storeId = tenant.TryGetStoreId(out var id) ? id : 0;
        using var setCmd = command.Connection.CreateCommand();
        setCmd.CommandText = $"SELECT set_config('app.current_store_id', '{storeId}', false)";
        setCmd.ExecuteNonQuery();
    }

    private async Task SetTenantAsync(DbCommand command, CancellationToken ct)
    {
        if (command.Connection is null) return;
        var storeId = tenant.TryGetStoreId(out var id) ? id : 0;
        await using var setCmd = command.Connection.CreateCommand();
        setCmd.CommandText = $"SELECT set_config('app.current_store_id', '{storeId}', false)";
        await setCmd.ExecuteNonQueryAsync(ct);
    }
}
