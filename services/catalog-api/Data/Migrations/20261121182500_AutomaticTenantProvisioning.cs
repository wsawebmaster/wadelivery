using Catalog.Api.Data;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;

namespace Catalog.Api.Data.Migrations;

[DbContext(typeof(CatalogDbContext))]
[Migration("20261121182500_AutomaticTenantProvisioning")]
public sealed class AutomaticTenantProvisioning : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Cnpj" character varying(14) NULL;
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Email" character varying(200) NULL;
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "BannerUrl" character varying(500) NULL;
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CoverUrl" character varying(500) NULL;
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CorPrimaria" character varying(7) NOT NULL DEFAULT '#1f6feb';
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CorSecundaria" character varying(7) NOT NULL DEFAULT '#ffffff';
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CorFundo" character varying(7) NOT NULL DEFAULT '#f3f4f6';
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "CorTexto" character varying(7) NOT NULL DEFAULT '#2c3e50';
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "TipoCard" character varying(32) NOT NULL DEFAULT 'foto-grande';
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "LayoutCardapio" character varying(32) NOT NULL DEFAULT 'grade';
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "EstiloBotao" character varying(24) NOT NULL DEFAULT 'arredondado';
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "IsTeste" boolean NOT NULL DEFAULT FALSE;
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "DataCriacao" timestamp with time zone NOT NULL DEFAULT now();
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "DataAtualizacao" timestamp with time zone NOT NULL DEFAULT now();
            -- Bancos criados por versões anteriores (produção da Fabin) não têm a coluna Slug:
            -- sem ela o índice abaixo falha e o catalog-api não sobe.
            ALTER TABLE stores ADD COLUMN IF NOT EXISTS "Slug" character varying(100) NULL;
            CREATE UNIQUE INDEX IF NOT EXISTS "IX_stores_Slug"
                ON stores ("Slug") WHERE "Slug" IS NOT NULL;
            """);
    }

    protected override void Down(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.Sql("""
            ALTER TABLE stores DROP COLUMN IF EXISTS "Cnpj";
            ALTER TABLE stores DROP COLUMN IF EXISTS "Email";
            ALTER TABLE stores DROP COLUMN IF EXISTS "BannerUrl";
            ALTER TABLE stores DROP COLUMN IF EXISTS "CoverUrl";
            ALTER TABLE stores DROP COLUMN IF EXISTS "CorPrimaria";
            ALTER TABLE stores DROP COLUMN IF EXISTS "CorSecundaria";
            ALTER TABLE stores DROP COLUMN IF EXISTS "CorFundo";
            ALTER TABLE stores DROP COLUMN IF EXISTS "CorTexto";
            ALTER TABLE stores DROP COLUMN IF EXISTS "TipoCard";
            ALTER TABLE stores DROP COLUMN IF EXISTS "LayoutCardapio";
            ALTER TABLE stores DROP COLUMN IF EXISTS "EstiloBotao";
            ALTER TABLE stores DROP COLUMN IF EXISTS "IsTeste";
            ALTER TABLE stores DROP COLUMN IF EXISTS "DataCriacao";
            ALTER TABLE stores DROP COLUMN IF EXISTS "DataAtualizacao";
            """);
    }
}
