using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Catalog.Api.Models;
using Npgsql;
using NpgsqlTypes;

namespace Catalog.Api.Services;

/// <summary>
/// Explorador genérico de tabelas para o papel Dev (plataforma).
/// Usa Npgsql direto, com RLS desligado na transação (SET LOCAL row_security = off),
/// para permitir ler/editar qualquer loja do banco compartilhado.
/// Somente disponível com Persistence=PostgreSQL.
/// </summary>
public class DbExplorerService
{
    private readonly string? _conn;
    private static readonly Regex IdentRe = new("^[A-Za-z0-9_]+$", RegexOptions.Compiled);

    public bool IsAvailable => !string.IsNullOrWhiteSpace(_conn);

    public DbExplorerService(string? conn)
    {
        _conn = conn;
    }

    private static string Quote(string identifier)
    {
        if (!IdentRe.IsMatch(identifier))
            throw new InvalidOperationException($"Identificador inválido: {identifier}");
        return "\"" + identifier + "\"";
    }

    private async Task<T> WithBypassAsync<T>(
        Func<NpgsqlConnection, NpgsqlTransaction, CancellationToken, Task<T>> work,
        CancellationToken ct)
    {
        await using var conn = new NpgsqlConnection(_conn);
        await conn.OpenAsync(ct);
        await using var tx = await conn.BeginTransactionAsync(ct);
        await using (var setup = new NpgsqlCommand("SET LOCAL row_security = off", conn, tx))
        {
            await setup.ExecuteNonQueryAsync(ct);
        }
        var result = await work(conn, tx, ct);
        await tx.CommitAsync(ct);
        return result;
    }

    public async Task<List<DbTableInfo>> GetTablesAsync(CancellationToken ct)
    {
        return await WithBypassAsync(async (conn, tx, token) =>
        {
            var pkByTable = new Dictionary<string, HashSet<string>>(StringComparer.Ordinal);
            await using (var cmd = new NpgsqlCommand(
                """
                SELECT tc.table_name, kcu.column_name
                FROM information_schema.table_constraints tc
                JOIN information_schema.key_column_usage kcu
                  ON tc.constraint_name = kcu.constraint_name
                 AND tc.table_schema = kcu.table_schema
                WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
                """, conn, tx))
            await using (var reader = await cmd.ExecuteReaderAsync(token))
            {
                while (await reader.ReadAsync(token))
                {
                    var table = reader.GetString(0);
                    var col = reader.GetString(1);
                    if (!pkByTable.TryGetValue(table, out var set))
                        pkByTable[table] = set = new HashSet<string>(StringComparer.Ordinal);
                    set.Add(col);
                }
            }

            var byTable = new Dictionary<string, DbTableInfo>(StringComparer.Ordinal);
            await using (var cmd = new NpgsqlCommand(
                """
                SELECT table_name, column_name, data_type, is_nullable, is_identity,
                       column_default, character_maximum_length
                FROM information_schema.columns
                WHERE table_schema = 'public'
                ORDER BY table_name, ordinal_position
                """, conn, tx))
            await using (var reader = await cmd.ExecuteReaderAsync(token))
            {
                while (await reader.ReadAsync(token))
                {
                    var tableName = reader.GetString(0);
                    if (!byTable.TryGetValue(tableName, out var info))
                    {
                        info = new DbTableInfo { Table = tableName };
                        byTable[tableName] = info;
                    }

                    var name = reader.GetString(1);
                    var dataType = reader.GetString(2);
                    var nullable = reader.GetString(3) == "YES";
                    var identity = reader.GetString(4) != "NO";
                    var hasDefault = !reader.IsDBNull(5);
                    int? maxLength = reader.IsDBNull(6) ? null : reader.GetInt32(6);

                    info.Columns.Add(new DbColumnInfo
                    {
                        Name = name,
                        DataType = dataType,
                        IsPrimaryKey = pkByTable.TryGetValue(tableName, out var pk) && pk.Contains(name),
                        IsIdentity = identity,
                        IsNullable = nullable,
                        HasDefault = hasDefault,
                        MaxLength = maxLength,
                        IsJson = IsJsonColumn(name, dataType)
                    });
                }
            }

            foreach (var info in byTable.Values)
            {
                info.Tenant = info.Columns.Any(c => c.Name == "StoreId");
                info.HasPk = info.Columns.Any(c => c.IsPrimaryKey);
            }

            return byTable.Values.OrderBy(t => t.Table, StringComparer.OrdinalIgnoreCase).ToList();
        }, ct);
    }

    private async Task<DbTableInfo?> GetTableAsync(string table, CancellationToken ct)
    {
        var tables = await GetTablesAsync(ct);
        return tables.FirstOrDefault(t => string.Equals(t.Table, table, StringComparison.OrdinalIgnoreCase));
    }

    public async Task<List<DbStoreInfo>> ListStoresAsync(CancellationToken ct)
    {
        return await WithBypassAsync(async (conn, tx, token) =>
        {
            var result = new List<DbStoreInfo>();
            await using var cmd = new NpgsqlCommand(
                "SELECT \"Id\", \"StoreName\" FROM stores ORDER BY \"Id\"", conn, tx);
            await using var reader = await cmd.ExecuteReaderAsync(token);
            while (await reader.ReadAsync(token))
                result.Add(new DbStoreInfo(reader.GetInt32(0), reader.IsDBNull(1) ? "" : reader.GetString(1)));
            return result;
        }, ct);
    }

    public async Task<DbTableRowsResult?> QueryRowsAsync(
        string table,
        int storeId,
        string? q,
        string? orderBy,
        string? orderDir,
        int page,
        int pageSize,
        CancellationToken ct)
    {
        var info = await GetTableAsync(table, ct);
        if (info is null) return null;

        page = Math.Max(1, page);
        pageSize = Math.Clamp(pageSize, 1, 200);

        var where = new List<string>();
        var parData = new List<(string Name, NpgsqlDbType Type, object? Value)>();

        if (info.Tenant)
        {
            where.Add("\"StoreId\" = @p_store");
            parData.Add(("p_store", NpgsqlDbType.Integer, storeId));
        }

        var search = String.IsNullOrWhiteSpace(q) ? null : q.Trim();
        if (!string.IsNullOrWhiteSpace(search))
        {
            var searchCols = info.Columns
                .Where(c => !c.IsJson && c.DataType is "character varying" or "text" or "char")
                .ToList();
            if (searchCols.Count > 0)
            {
                var likes = new List<string>();
                for (var i = 0; i < searchCols.Count; i++)
                {
                    likes.Add($"{Quote(searchCols[i].Name)}::text ILIKE @p_q{i}");
                    parData.Add(($"p_q{i}", NpgsqlDbType.Text, $"%{search}%"));
                }
                where.Add("(" + string.Join(" OR ", likes) + ")");
            }
        }

        var whereSql = where.Count > 0 ? " WHERE " + string.Join(" AND ", where) : "";

        var orderCol = info.Columns.FirstOrDefault(c =>
            c.Name.Equals(orderBy ?? "", StringComparison.OrdinalIgnoreCase))?.Name
            ?? info.Columns.FirstOrDefault(c => c.IsPrimaryKey)?.Name
            ?? info.Columns[0].Name;
        var orderSql = $" ORDER BY {Quote(orderCol)} " + (string.Equals(orderDir, "desc", StringComparison.OrdinalIgnoreCase) ? "DESC" : "ASC");
        var limit = $" LIMIT {pageSize} OFFSET {(page - 1) * pageSize}";

        return await WithBypassAsync(async (conn, tx, token) =>
        {
            long total;
            await using (var countCmd = new NpgsqlCommand("SELECT COUNT(*) FROM " + Quote(table) + whereSql, conn, tx))
            {
                AddParameterData(countCmd, parData);
                total = Convert.ToInt64(await countCmd.ExecuteScalarAsync(token), CultureInfo.InvariantCulture);
            }

            var rows = new List<Dictionary<string, object?>>();
            await using var dataCmd = new NpgsqlCommand(
                "SELECT * FROM " + Quote(table) + whereSql + orderSql + limit, conn, tx);
            AddParameterData(dataCmd, parData);
            await using (var reader = await dataCmd.ExecuteReaderAsync(token))
            {
                while (await reader.ReadAsync(token))
                    rows.Add(ReadRow(reader));
            }

            return new DbTableRowsResult
            {
                Table = table,
                Page = page,
                PageSize = pageSize,
                Total = total,
                Columns = info.Columns,
                Rows = rows
            };
        }, ct);
    }

    public async Task<Dictionary<string, object?>?> InsertRowAsync(
        string table,
        int storeId,
        JsonElement body,
        CancellationToken ct)
    {
        var info = await GetTableAsync(table, ct);
        if (info is null) return null;

        var data = ReadBody(body);
        var names = new List<string>();
        var values = new List<NpgsqlParameter>();

        foreach (var col in info.Columns)
        {
            if (col.IsIdentity) continue;
            if (info.Tenant && col.Name == "StoreId") continue;
            if (!data.ContainsKey(col.Name)) continue;

            var value = ConvertValue(MapType(col), data[col.Name]);
            // NOT NULL sem default e sem valor → deixa o default/erro do banco decidir.
            if (value is null && !col.IsNullable) continue;

            names.Add(Quote(col.Name));
            values.Add(MakeParameter($"p{values.Count}", MapType(col), value));
        }

        if (info.Tenant)
        {
            names.Add("\"StoreId\"");
            values.Add(MakeParameter($"p{values.Count}", NpgsqlDbType.Integer, storeId));
        }

        if (names.Count == 0)
            throw new InvalidOperationException("Nenhuma coluna válida para inserir.");

        var sql = "INSERT INTO " + Quote(table) + " (" + string.Join(", ", names) +
                  ") VALUES (" + string.Join(", ", values.Select(v => "@" + v.ParameterName)) +
                  ") RETURNING *";

        return await WithBypassAsync(async (conn, tx, token) =>
        {
            await using var cmd = new NpgsqlCommand(sql, conn, tx);
            AddParameters(cmd, values);
            await using var reader = await cmd.ExecuteReaderAsync(token);
            return await reader.ReadAsync(token) ? ReadRow(reader) : null;
        }, ct);
    }

    public async Task<Dictionary<string, object?>?> UpdateRowAsync(
        string table,
        int storeId,
        JsonElement body,
        CancellationToken ct)
    {
        var info = await GetTableAsync(table, ct);
        if (info is null) return null;

        var pks = info.Columns.Where(c => c.IsPrimaryKey).ToList();
        if (pks.Count == 0)
            throw new InvalidOperationException("Tabela sem chave primária não suporta edição.");

        var data = ReadBody(body);
        var sets = new List<string>();
        var values = new List<NpgsqlParameter>();
        var where = new List<string>();

        foreach (var pk in pks)
        {
            if (!data.ContainsKey(pk.Name))
                throw new InvalidOperationException($"Valor da chave primária '{pk.Name}' é obrigatório.");
            where.Add($"{Quote(pk.Name)} = @p{values.Count}");
            values.Add(MakeParameter($"p{values.Count}", MapType(pk), data[pk.Name]));
        }

        foreach (var col in info.Columns)
        {
            if (col.IsPrimaryKey || col.IsIdentity) continue;
            if (info.Tenant && col.Name == "StoreId") continue;
            if (!data.ContainsKey(col.Name)) continue;
            sets.Add($"{Quote(col.Name)} = @p{values.Count}");
            values.Add(MakeParameter($"p{values.Count}", MapType(col), ConvertValue(MapType(col), data[col.Name])));
        }

        if (info.Tenant)
        {
            where.Add("\"StoreId\" = @p_store");
            values.Add(MakeParameter("p_store", NpgsqlDbType.Integer, storeId));
        }

        if (sets.Count == 0)
            throw new InvalidOperationException("Nenhuma coluna para atualizar.");

        var sql = "UPDATE " + Quote(table) + " SET " + string.Join(", ", sets) +
                  " WHERE " + string.Join(" AND ", where) + " RETURNING *";

        return await WithBypassAsync(async (conn, tx, token) =>
        {
            await using var cmd = new NpgsqlCommand(sql, conn, tx);
            AddParameters(cmd, values);
            await using var reader = await cmd.ExecuteReaderAsync(token);
            return await reader.ReadAsync(token) ? ReadRow(reader) : null;
        }, ct);
    }

    public async Task<bool> DeleteRowAsync(string table, int storeId, JsonElement body, CancellationToken ct)
    {
        var info = await GetTableAsync(table, ct);
        if (info is null) return false;

        var pks = info.Columns.Where(c => c.IsPrimaryKey).ToList();
        if (pks.Count == 0)
            throw new InvalidOperationException("Tabela sem chave primária não suporta exclusão.");

        var data = ReadBody(body);
        var where = new List<string>();
        var values = new List<NpgsqlParameter>();

        foreach (var pk in pks)
        {
            if (!data.ContainsKey(pk.Name))
                throw new InvalidOperationException($"Valor da chave primária '{pk.Name}' é obrigatório.");
            where.Add($"{Quote(pk.Name)} = @p{values.Count}");
            values.Add(MakeParameter($"p{values.Count}", MapType(pk), data[pk.Name]));
        }

        if (info.Tenant)
        {
            where.Add("\"StoreId\" = @p_store");
            values.Add(MakeParameter("p_store", NpgsqlDbType.Integer, storeId));
        }

        var sql = "DELETE FROM " + Quote(table) + " WHERE " + string.Join(" AND ", where);

        return await WithBypassAsync(async (conn, tx, token) =>
        {
            await using var cmd = new NpgsqlCommand(sql, conn, tx);
            AddParameters(cmd, values);
            return await cmd.ExecuteNonQueryAsync(token) > 0;
        }, ct);
    }

    private static Dictionary<string, object?> ReadBody(JsonElement body)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (body.ValueKind != JsonValueKind.Object) return result;
        foreach (var prop in body.EnumerateObject())
        {
            var v = prop.Value;
            result[prop.Name] = v.ValueKind switch
            {
                JsonValueKind.Null => null,
                JsonValueKind.String => v.GetString(),
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.Number => v.TryGetInt64(out var l) ? l : v.GetDecimal(),
                _ => v.GetRawText()
            };
        }
        return result;
    }

    private static bool IsJsonColumn(string name, string dataType)
    {
        return dataType is "json" or "jsonb"
            || name.EndsWith("Json", StringComparison.OrdinalIgnoreCase);
    }

    private static NpgsqlDbType MapType(DbColumnInfo col)
    {
        if (col.IsJson) return NpgsqlDbType.Jsonb;
        return col.DataType switch
        {
            "integer" => NpgsqlDbType.Integer,
            "bigint" => NpgsqlDbType.Bigint,
            "smallint" => NpgsqlDbType.Smallint,
            "numeric" or "money" => NpgsqlDbType.Numeric,
            "real" => NpgsqlDbType.Real,
            "double precision" => NpgsqlDbType.Double,
            "boolean" => NpgsqlDbType.Boolean,
            "timestamp with time zone" => NpgsqlDbType.TimestampTz,
            "timestamp without time zone" => NpgsqlDbType.Timestamp,
            "date" => NpgsqlDbType.Date,
            "time without time zone" => NpgsqlDbType.Time,
            "uuid" => NpgsqlDbType.Uuid,
            _ => NpgsqlDbType.Text
        };
    }

    private static object? ConvertValue(NpgsqlDbType type, object? value)
    {
        if (value is null) return null;
        try
        {
            switch (type)
            {
                case NpgsqlDbType.Integer: return Convert.ToInt32(value, CultureInfo.InvariantCulture);
                case NpgsqlDbType.Bigint: return Convert.ToInt64(value, CultureInfo.InvariantCulture);
                case NpgsqlDbType.Smallint: return Convert.ToInt16(value, CultureInfo.InvariantCulture);
                case NpgsqlDbType.Numeric: return Convert.ToDecimal(value, CultureInfo.InvariantCulture);
                case NpgsqlDbType.Real: return Convert.ToSingle(value, CultureInfo.InvariantCulture);
                case NpgsqlDbType.Double: return Convert.ToDouble(value, CultureInfo.InvariantCulture);
                case NpgsqlDbType.Boolean: return ToBool(value);
                case NpgsqlDbType.Uuid:
                    return value is Guid g ? g : Guid.Parse(value.ToString()!);
                case NpgsqlDbType.TimestampTz:
                case NpgsqlDbType.Timestamp:
                    return value is DateTime dt ? dt
                        : value is DateTimeOffset dto ? dto.UtcDateTime
                        : DateTime.Parse(value.ToString()!, CultureInfo.InvariantCulture,
                            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
                case NpgsqlDbType.Date:
                    return value is DateTime dd ? dd
                        : DateTime.Parse(value.ToString()!, CultureInfo.InvariantCulture,
                            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal);
                case NpgsqlDbType.Time:
                    return value is TimeSpan ts ? ts : TimeSpan.Parse(value.ToString()!, CultureInfo.InvariantCulture);
                case NpgsqlDbType.Jsonb:
                case NpgsqlDbType.Json:
                    return value is string j ? j : JsonSerializer.Serialize(value);
                default:
                    return value is string s ? s : Convert.ToString(value, CultureInfo.InvariantCulture);
            }
        }
        catch (Exception ex) when (ex is FormatException or InvalidCastException or OverflowException or JsonException)
        {
            throw new InvalidOperationException($"Valor inválido para o tipo '{type}': {value}", ex);
        }
    }

    private static object ToBool(object value)
    {
        if (value is bool b) return b;
        var s = Convert.ToString(value, CultureInfo.InvariantCulture)?.Trim().ToLowerInvariant();
        return s switch
        {
            "1" or "true" or "yes" or "on" or "t" => true,
            "0" or "false" or "no" or "off" or "f" => false,
            _ => bool.Parse(s!)
        };
    }

    private static NpgsqlParameter MakeParameter(string name, NpgsqlDbType type, object? value)
    {
        return new NpgsqlParameter(name, type) { Value = value ?? DBNull.Value };
    }

    private static void AddParameterData(
        NpgsqlCommand cmd,
        IEnumerable<(string Name, NpgsqlDbType Type, object? Value)> data)
    {
        foreach (var (name, type, value) in data)
        {
            if (!cmd.Parameters.Contains(name))
                cmd.Parameters.Add(MakeParameter(name, type, value));
        }
    }

    private static void AddParameters(NpgsqlCommand cmd, IEnumerable<NpgsqlParameter> parameters)
    {
        foreach (var p in parameters)
        {
            if (!cmd.Parameters.Contains(p.ParameterName))
                cmd.Parameters.Add(p);
        }
    }

    private static Dictionary<string, object?> ReadRow(NpgsqlDataReader reader)
    {
        var row = new Dictionary<string, object?>(StringComparer.Ordinal);
        for (var i = 0; i < reader.FieldCount; i++)
        {
            var value = reader.IsDBNull(i) ? null : reader.GetValue(i);
            row[reader.GetName(i)] = value;
        }
        return row;
    }
}
