using Catalog.Api.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Catalog.Api.Data.Migrations;

[DbContext(typeof(CatalogDbContext))]
[Migration("20261121221814_AlphanumericCnpj")]
public sealed class AlphanumericCnpj : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            ALTER TABLE stores ALTER COLUMN "Cnpj" TYPE character varying(18);
            ALTER TABLE platform_stores ALTER COLUMN "Cnpj" TYPE character varying(18);
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            ALTER TABLE stores ALTER COLUMN "Cnpj" TYPE character varying(14);
            ALTER TABLE platform_stores ALTER COLUMN "Cnpj" TYPE character varying(14);
            """);
    }
}
