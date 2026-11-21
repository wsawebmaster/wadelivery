-- ============================================================================
-- Fix: CategoryId dos ingredientes da loja 1 (Fabin Lanches)
-- ----------------------------------------------------------------------------
-- Regra aplicada (definida pelo usuário):
--   * Ingrediente usado em 1 categoria            -> CategoryId = categoria de uso
--   * Ingrediente usado em várias categorias      -> CategoryId = NULL (fica
--     disponível na edição de produto de qualquer categoria)
--   * Ingrediente sem nenhum produto vinculado    -> mantido (inativo, apenas
--     oculto na tela de edição pelo front)
-- ----------------------------------------------------------------------------
-- Como executar (loja atual em produção):
--   psql "$DATABASE_URL" -f fix-ingredient-categories.sql
-- OBS: dentro de transação, com RLS desativado (mesmo padrão do platform sync).
-- ============================================================================

BEGIN;

SET LOCAL row_security = off;

-- Compartilhados (várias categorias) -> sem categoria
UPDATE ingredients
SET "CategoryId" = NULL
WHERE "StoreId" = 1 AND "Id" IN ('2','queijo','alface','3','4','5','6','7','8','10','15','16');

-- Usados apenas em Especiais
UPDATE ingredients
SET "CategoryId" = 'especiais'
WHERE "StoreId" = 1 AND "Id" IN ('11','12','13','14');

-- Usados apenas em Hot dog
UPDATE ingredients
SET "CategoryId" = 'hot-dog'
WHERE "StoreId" = 1 AND "Id" IN ('17','18','19','20');

-- Usados apenas em Tradicionais (1)
UPDATE ingredients
SET "CategoryId" = '1'
WHERE "StoreId" = 1 AND "Id" = '23';

-- Usados apenas em Porções (2)
UPDATE ingredients
SET "CategoryId" = '2'
WHERE "StoreId" = 1 AND "Id" IN ('25','26','27');

-- Usados apenas em Frango (5)
UPDATE ingredients
SET "CategoryId" = '5'
WHERE "StoreId" = 1 AND "Id" = '30';

-- Verificação (resultado esperado)
SELECT "Id", "Name", "SortOrder", "CategoryId"
FROM ingredients
WHERE "StoreId" = 1
ORDER BY "SortOrder", "Id";

COMMIT;
