# Publicação segura do WaDelivery (backend e banco compartilhados com a Fabin)

A Fabin, cliente ativo, roda pelo projeto `D:\delivery` (repositório `wsawebmaster/delivery`):

| Parte | Onde roda |
|---|---|
| Cardápio | Vercel, `delivery-fabin.vercel.app` |
| Painel | Vercel, `delivery-admin-fabin.vercel.app` |
| Backend | Railway (catalog, orders, gateway) |
| Banco | PostgreSQL na Railway |

O front publicado do WaDelivery (`wsawebmaster/wadelivery`, deploy automático na Vercel) usa **o mesmo backend e o mesmo banco**. Qualquer publicação precisa manter a Fabin funcionando exatamente como hoje.

## Travas já incluídas no código

| Trava | Onde | Efeito |
|---|---|---|
| Deploy da Vercel só sob comando | `vercel.json`, `apps/admin/vercel.json`, `apps/storefront/vercel.json` (`ignoreCommand`) | Push em `main` ou em qualquer outra branch **não publica nada**. Builda somente na branch `release` ou com `WADELIVERY_DEPLOY_ENABLED=1` no projeto da Vercel. |
| `/fabin` vai para o site real | `middleware.ts`, `lib/external-stores.ts` | Com `FABIN_PUBLIC_URL` (e `FABIN_ADMIN_URL`) na Vercel, `/fabin`, `/fabin/admin`, `fabin.*` e `?tenant=fabin` redirecionam (307) para a produção atual. Nenhum pedido cai no sistema errado. |
| Loja padrão sem tenant | `Tenancy:DefaultStoreId = 1` nos dois `appsettings.json` | Os fronts atuais da Fabin não enviam `X-Tenant-Slug`. Sem a loja no pedido, o backend novo usa a loja 1, como a versão em produção. |
| Bloqueio automático desligado | `Billing:AutoBlockEnabled = false` | A rotina só marca "vencida", não tira loja do ar. |
| Expiração de lojas abandonadas desligada | `Signup:CleanupEnabled = false` | Nenhuma loja é desativada ou tem arquivos apagados automaticamente. |
| Fabin protegida | `Platform:ProtectedStoreIds = [1]` | Mesmo com as rotinas ligadas, a loja 1 nunca sofre ação automática. |
| Envio para o remoto bloqueado | `RemoteTools:AllowUpload = false` | `upload-to-remote` responde 403. As ferramentas só de leitura continuam. |

## O que o ensaio provou

Ensaio de 24/11/2026: código de produção (`D:\delivery`, `origin/main` de 17/09/2026) contra este projeto, em contêineres e banco isolados.

1. **Upgrade de esquema** (banco criado pelo backend de produção → backend novo):
   - 2 tabelas novas (`platform_audit`, `__EFMigrationsHistory`) e 27 colunas novas;
   - **nada removido ou alterado**.
2. **Fronts atuais da Fabin × backend novo**, todos OK, com zero requisições com erro e zero erros de JavaScript:
   - cardápio: loja, 86 produtos, 87 cards na tela;
   - login do painel;
   - pedido de retirada (201), lista, mudança de status e acompanhamento;
   - edição de produto e da loja;
   - frete;
   - painel com pedidos ao vivo.
3. **Rollback:** o backend de produção volta a rodar no banco já atualizado.
   - Todos os fluxos continuam OK, inclusive lendo os pedidos criados pela versão nova.
   - Voltar a versão é só redeploy do código, **sem restaurar banco**.
4. **Front novo × backend de produção:** cadastro de loja, `/{slug}` e o painel novo **não funcionam** (14 rotas inexistentes). Por isso a ordem é obrigatória: **backend primeiro, front depois**.
5. **Nenhuma ação automática** sobre a Fabin: continua ativa, sem bloqueio e sem registros de auditoria.

### Problemas encontrados e corrigidos antes de qualquer publicação

- **O backend novo não subia no banco da produção.** A migration criava o índice `IX_stores_Slug` antes de existir a coluna `Slug`, e a versão em produção não tem essa coluna. Corrigido na própria migration.
- **O cardápio da Fabin quebraria.** O backend novo exigia o cabeçalho de loja e respondia 400 nas chamadas públicas sem ele. Corrigido com `Tenancy:DefaultStoreId`.
- **O build em Release falhava.** O ImageSharp 3.2.0 exige licença comercial. Voltou para a 3.1.12, a mesma da produção.
  - A 3.1.12 tem alertas de segurança moderados conhecidos, os mesmos da versão em produção hoje.
  - Atualizar (versão corrigida ou licença) é uma decisão à parte.

## Etapa 0 — Conferir nos painéis (antes do primeiro push)

- **Vercel**, projeto(s) ligado(s) a `wsawebmaster/wadelivery`:
  - branch de produção, domínios e se previews de outras branches estão ativos;
  - variáveis `NEXT_PUBLIC_API_BASE_URL` e `API_BASE_URL` em Production e Preview;
  - **Root Directory**: a trava cobre a raiz, `apps/admin` e `apps/storefront`.
- **Railway**, cada serviço (catalog, orders, gateway): **de qual repositório e branch** faz deploy. O esperado é `wsawebmaster/delivery`. Se algum observar o `wadelivery`, desligue o deploy automático dele antes do push.
- O push em si é seguro com a trava da Vercel: o código vai para o GitHub e nada é publicado.

## Roteiro de publicação (quando decidir)

1. **Backup:** `pg_dump` do PostgreSQL da Railway, guardado fora do servidor.
2. **Backend:** trocar a origem dos serviços na Railway para este código, com as variáveis atuais mantidas (Cors, Jwt, conexões).
   - **Antes de trocar**, conferir que o serviço tem health check, para que uma versão que não sobe não substitua a atual.
   - Não definir `Billing__AutoBlockEnabled`, `Signup__CleanupEnabled` nem `RemoteTools__AllowUpload`: os padrões seguros valem.
3. **Conferência com os fronts atuais da Fabin:**
   - abrir o cardápio e o painel;
   - fazer um pedido de teste de retirada, confirmar e cancelar;
   - conferir frete e edição de produto.
4. **Front do WaDelivery:**
   - na Vercel, definir `FABIN_PUBLIC_URL` e `FABIN_ADMIN_URL`, mais as chaves reais do Turnstile;
   - publicar pela branch `release`, ou com `WADELIVERY_DEPLOY_ENABLED=1`;
   - conferir que `/fabin` redireciona.
5. **Ligar as rotinas aos poucos,** se e quando quiser: `Billing__AutoBlockEnabled=true` e depois `Signup__CleanupEnabled=true`. A Fabin continua protegida.

## Rollback

| Parte | Como voltar |
|---|---|
| Backend | Redeploy do deployment anterior na Railway. O esquema novo é aditivo e a versão anterior roda nele (ensaiado). |
| Front | Remover `WADELIVERY_DEPLOY_ENABLED` e promover o deployment anterior na Vercel. |
| Banco | Só em último caso, restaurar o `pg_dump` do passo 1. Os pedidos feitos depois dele se perdem. |

## Como repetir o ensaio

1. Exportar o código de produção sem alterar o `D:\delivery`: `git -C D:\delivery archive origin/main | tar -x -C <pasta>`.
2. Subir em projeto Docker isolado: nomes `ensaio-*`, portas 55100, 55432, 58080 e 58081, volume `ensaio_pgdata`.
3. Rodar o teste de fluxos da Fabin, sem `X-Tenant-Slug`, em três momentos: backend antigo, depois backend novo, depois backend antigo de novo.
