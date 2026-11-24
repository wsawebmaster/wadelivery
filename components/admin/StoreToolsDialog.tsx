'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  compareStoreTools,
  createStoreToolsBackup,
  fetchStoreToolsStatus,
  previewStoreOrdersFromRemote,
  syncStoreFromRemote,
  syncStoreOrdersFromRemote,
  type StoreToolsBackupResult,
  type StoreToolsCompareReport,
  type StoreToolsOrdersPreview,
  type StoreToolsOrdersSyncReport,
  type StoreToolsStatus,
  type StoreToolsSyncReport,
} from '@/lib/admin-api'

interface StoreToolsDialogProps {
  storeId: number
  storeName: string
  onClose: () => void
}

type ToolsAction = 'compare' | 'backup' | 'preview' | 'apply' | 'orders-preview' | 'orders-apply'
type ToolsResult =
  | { kind: 'compare'; value: StoreToolsCompareReport }
  | { kind: 'backup'; value: StoreToolsBackupResult }
  | { kind: 'sync'; value: StoreToolsSyncReport }
  | { kind: 'orders-preview'; value: StoreToolsOrdersPreview }
  | { kind: 'orders-sync'; value: StoreToolsOrdersSyncReport }

function formatDateTime(value?: string | null) {
  if (!value) return 'nenhum'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR')
}

function DifferenceList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  const shown = items.slice(0, 20)
  return (
    <section className="rounded-xl border border-[var(--border)] p-3">
      <h4 className="mb-2 text-sm font-semibold">
        {title} ({items.length})
      </h4>
      <ul className="max-h-40 list-disc space-y-1 overflow-y-auto pl-5 text-xs text-[var(--text-muted)]">
        {shown.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}
        {items.length > shown.length && <li>… e mais {items.length - shown.length}.</li>}
      </ul>
    </section>
  )
}

function StatusSummary({
  status,
  loading,
  error,
  onRefresh,
}: {
  status: StoreToolsStatus | null
  loading: boolean
  error: string | null
  onRefresh: () => void
}) {
  return (
    <section className="mb-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h4 className="font-semibold">Verificação da loja</h4>
        <button
          type="button"
          className="wa-btn wa-btn-ghost"
          disabled={loading}
          onClick={onRefresh}
        >
          {loading ? 'Verificando…' : 'Verificar novamente'}
        </button>
      </div>
      {error ? (
        <p className="text-[var(--error)]" role="alert">{error}</p>
      ) : loading && !status ? (
        <p className="text-[var(--text-muted)]">Consultando o vínculo local e o ambiente remoto…</p>
      ) : status ? (
        <div className="space-y-1 text-[var(--text-muted)]">
          <p>
            <strong>Local:</strong>{' '}
            {status.localCategories} categorias · {status.localProducts} produtos ·{' '}
            {status.localIngredients} ingredientes
            {status.localStoreName ? ` · ${status.localStoreName}` : ''}
          </p>
          <p>
            <strong>Remoto:</strong> {status.remoteBaseUrl || 'sem Back (URL) configurado'} ·{' '}
            {status.remoteReachable ? 'acessível' : 'inacessível'} · credenciais{' '}
            {status.hasRemoteCreds ? 'configuradas' : 'não configuradas (modo público)'}
          </p>
          <p><strong>Último backup local:</strong> {formatDateTime(status.lastBackupAt)}</p>
          {status.remoteError && <p className="text-[var(--error)]">{status.remoteError}</p>}
        </div>
      ) : null}
    </section>
  )
}

function CompareResult({ report }: { report: StoreToolsCompareReport }) {
  const differences = [
    ['Categorias somente locais', report.categoriesOnlyLocal],
    ['Categorias somente remotas', report.categoriesOnlyRemote],
    ['Produtos somente locais', report.productsOnlyLocal],
    ['Produtos somente remotos', report.productsOnlyRemote],
    ['Ingredientes somente locais', report.ingredientsOnlyLocal],
    ['Ingredientes somente remotos', report.ingredientsOnlyRemote],
    ['Imagens remotas sem arquivo local', report.imagesMissingLocal],
  ] as const

  return (
    <div className="space-y-3">
      <p className="text-xs text-[var(--text-muted)]">
        {report.mode === 'admin'
          ? 'Comparação completa com credenciais remotas.'
          : 'Modo público: itens ocultos e ingredientes podem não ser comparados.'}
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <p className="rounded-lg border border-[var(--border)] p-2 text-xs">
          Categorias: {report.categoriesLocal} local × {report.categoriesRemote} remoto
        </p>
        <p className="rounded-lg border border-[var(--border)] p-2 text-xs">
          Produtos: {report.productsLocal} local × {report.productsRemote} remoto
        </p>
        <p className="rounded-lg border border-[var(--border)] p-2 text-xs">
          Ingredientes: {report.ingredientsLocal} local × {report.ingredientsRemote} remoto
        </p>
        <p className="rounded-lg border border-[var(--border)] p-2 text-xs">
          Produtos iguais: {report.equalProducts}
        </p>
      </div>
      {report.warnings.map((warning, index) => (
        <p key={`${warning}-${index}`} className="text-xs text-[var(--text-muted)]">{warning}</p>
      ))}
      <div className="grid gap-2 md:grid-cols-2">
        {differences.map(([title, items]) => <DifferenceList key={title} title={title} items={items} />)}
      </div>
      {report.changedProducts.length > 0 && (
        <DifferenceList
          title="Produtos diferentes"
          items={report.changedProducts.map((product) => `${product.name} (${product.changedFields.join(', ')})`)}
        />
      )}
      {report.storeDiffs.length > 0 && (
        <DifferenceList
          title="Configurações diferentes"
          items={report.storeDiffs.map((diff) => `${diff.field}: local ${diff.local || '—'} · remoto ${diff.remote || '—'}`)}
        />
      )}
      {differences.every(([, items]) => items.length === 0)
        && report.changedProducts.length === 0
        && report.storeDiffs.length === 0 && (
          <p className="text-sm text-green-400">Catálogo e configuração idênticos entre local e remoto.</p>
        )}
    </div>
  )
}

function BackupResult({ result }: { result: StoreToolsBackupResult }) {
  return (
    <div className="space-y-1 text-sm">
      <h4 className="font-semibold text-green-400">Backup concluído</h4>
      <p className="break-all text-xs text-[var(--text-muted)]">Local: {result.directory}</p>
      <p className="text-xs text-[var(--text-muted)]">
        {result.categories} categorias · {result.products} produtos · {result.ingredients} ingredientes
      </p>
      <p className="text-xs text-[var(--text-muted)]">
        Imagens: {result.imagesDownloaded} baixadas, {result.imagesExisting} já existentes, {result.imagesFailed} falhas
      </p>
      <p className="text-xs text-[var(--text-muted)]">Criado em {formatDateTime(result.createdAt)}</p>
      {result.warnings.map((warning, index) => (
        <p key={`${warning}-${index}`} className="text-xs text-[var(--text-muted)]">{warning}</p>
      ))}
    </div>
  )
}

function SyncResult({ result }: { result: StoreToolsSyncReport }) {
  return (
    <div className="space-y-2">
      <h4 className={`font-semibold ${result.dryRun ? '' : 'text-green-400'}`}>
        {result.dryRun ? 'Simulação concluída — nada foi alterado' : 'Download do remoto concluído'}
      </h4>
      {result.error && <p className="text-sm text-[var(--error)]">{result.error}</p>}
      <ul className="space-y-1 text-xs text-[var(--text-muted)]">
        <li>Categorias: {result.categoriesSynced} sincronizadas, {result.categoriesDeleted} excluídas</li>
        <li>Ingredientes: {result.ingredientsSynced} sincronizados, {result.ingredientsDeleted} excluídos</li>
        <li>Produtos: {result.productsSynced} sincronizados, {result.productsDeleted} excluídos</li>
        <li>Imagens: {result.imagesDownloaded} baixadas, {result.imagesExisting} já existentes, {result.imagesFailed} falhas</li>
        <li>{result.storeUpdated ? 'Configuração da loja atualizada' : 'Configuração da loja não alterada'}</li>
      </ul>
      {result.warnings.map((warning, index) => (
        <p key={`${warning}-${index}`} className="text-xs text-[var(--text-muted)]">{warning}</p>
      ))}
    </div>
  )
}

function OrdersPreviewResult({ result }: { result: StoreToolsOrdersPreview }) {
  return (
    <div className="space-y-2">
      <h4 className="font-semibold">Simulação de pedidos remotos</h4>
      {result.error && <p className="text-sm text-[var(--error)]">{result.error}</p>}
      <p className="text-xs text-[var(--text-muted)]">
        Modo {result.mode === 'admin' ? 'admin' : 'público'} · {result.totalRemote} pedidos remotos
      </p>
      <ul className="space-y-1 text-xs text-[var(--text-muted)]">
        <li>Novos: {result.ordersToCreate}</li>
        <li>Já existentes (serão substituídos ao aplicar): {result.ordersToReplace}</li>
        <li>Iguais: {result.ordersEqual}</li>
      </ul>
      {result.sampleNewOrderIds.length > 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          Exemplos novos: {result.sampleNewOrderIds.join(', ')}
        </p>
      )}
      {result.warnings.map((warning, index) => (
        <p key={`${warning}-${index}`} className="text-xs text-[var(--text-muted)]">{warning}</p>
      ))}
    </div>
  )
}

function OrdersSyncResult({ result }: { result: StoreToolsOrdersSyncReport }) {
  return (
    <div className="space-y-2">
      <h4 className={`font-semibold ${result.dryRun ? '' : 'text-green-400'}`}>
        {result.dryRun ? 'Simulação de pedidos concluída' : 'Download de pedidos concluído'}
      </h4>
      {result.error && <p className="text-sm text-[var(--error)]">{result.error}</p>}
      <ul className="space-y-1 text-xs text-[var(--text-muted)]">
        <li>Criados: {result.ordersCreated}</li>
        <li>Substituídos: {result.ordersReplaced}</li>
        <li>Iguais: {result.ordersEqual}</li>
        <li>Falhas: {result.ordersFailed}</li>
      </ul>
      {result.warnings.map((warning, index) => (
        <p key={`${warning}-${index}`} className="text-xs text-[var(--text-muted)]">{warning}</p>
      ))}
    </div>
  )
}

export default function StoreToolsDialog({
  storeId,
  storeName,
  onClose,
}: StoreToolsDialogProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [status, setStatus] = useState<StoreToolsStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [action, setAction] = useState<ToolsAction | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [result, setResult] = useState<ToolsResult | null>(null)
  const [skipDelete, setSkipDelete] = useState(true)
  const [confirmSync, setConfirmSync] = useState(false)
  const [confirmOrdersSync, setConfirmOrdersSync] = useState(false)

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      setStatus(await fetchStoreToolsStatus(storeId))
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'Falha ao verificar a loja.')
    } finally {
      setStatusLoading(false)
    }
  }, [storeId])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    closeButtonRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [onClose])

  async function runAction(nextAction: ToolsAction) {
    if (action) return
    setAction(nextAction)
    setActionError(null)
    setResult(null)
    try {
      if (nextAction === 'compare') {
        setResult({ kind: 'compare', value: await compareStoreTools(storeId) })
      } else if (nextAction === 'backup') {
        setResult({ kind: 'backup', value: await createStoreToolsBackup(storeId) })
        void refreshStatus()
      } else if (nextAction === 'orders-preview') {
        setResult({ kind: 'orders-preview', value: await previewStoreOrdersFromRemote(storeId) })
      } else if (nextAction === 'orders-apply') {
        setResult({ kind: 'orders-sync', value: await syncStoreOrdersFromRemote(storeId, false) })
        void refreshStatus()
      } else {
        setResult({
          kind: 'sync',
          value: await syncStoreFromRemote(storeId, nextAction === 'preview', skipDelete),
        })
        if (nextAction === 'apply') void refreshStatus()
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'A operação não foi concluída.')
    } finally {
      setAction(null)
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="store-tools-title"
        className="wa-card wa-dialog max-h-[92vh] w-full max-w-3xl overflow-y-auto shadow-2xl"
      >
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 id="store-tools-title" className="text-lg font-semibold">
              Administrar · {storeName}
            </h2>
            <p className="text-xs text-[var(--text-muted)]">StoreId {storeId}</p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="wa-btn wa-btn-ghost"
            onClick={onClose}
            aria-label="Fechar administração da loja"
          >
            Fechar
          </button>
        </header>

        <StatusSummary
          status={status}
          loading={statusLoading}
          error={statusError}
          onRefresh={() => void refreshStatus()}
        />

        <div className="mb-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="wa-btn wa-btn-ghost"
            disabled={action !== null || statusLoading}
            onClick={() => void runAction('compare')}
          >
            {action === 'compare' ? 'Comparando…' : 'Comparar local × remoto'}
          </button>
          <button
            type="button"
            className="wa-btn wa-btn-ghost"
            disabled={action !== null || statusLoading}
            onClick={() => void runAction('backup')}
          >
            {action === 'backup' ? 'Fazendo backup…' : 'Fazer backup'}
          </button>
          <button
            type="button"
            className="wa-btn wa-btn-ghost"
            disabled={action !== null || statusLoading}
            onClick={() => void runAction('preview')}
          >
            {action === 'preview' ? 'Simulando…' : 'Baixar do remoto (simular)'}
          </button>
          <button
            type="button"
            className="wa-btn wa-btn-primary"
            disabled={action !== null || statusLoading}
            onClick={() => {
              setActionError(null)
              setConfirmSync(true)
            }}
          >
            Baixar do remoto (aplicar)
          </button>
          <button
            type="button"
            className="wa-btn wa-btn-ghost"
            disabled={action !== null || statusLoading}
            onClick={() => void runAction('orders-preview')}
          >
            {action === 'orders-preview' ? 'Simulando pedidos…' : 'Baixar pedidos (simular)'}
          </button>
          <button
            type="button"
            className="wa-btn wa-btn-primary"
            disabled={action !== null || statusLoading}
            onClick={() => {
              setActionError(null)
              setConfirmOrdersSync(true)
            }}
          >
            Baixar pedidos (aplicar)
          </button>
        </div>

        <label className="mb-4 flex items-center gap-2 text-xs text-[var(--text-muted)]">
          <input
            type="checkbox"
            checked={skipDelete}
            onChange={(event) => setSkipDelete(event.target.checked)}
            disabled={action !== null}
          />
          Manter itens locais que não existem no remoto (recomendado)
        </label>

        {confirmSync && (
          <div className="mb-4 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3" role="alert">
            <p className="mb-3 text-sm">
              Baixar o conteúdo remoto para o local?
              {skipDelete
                ? ' Itens locais sem equivalente no remoto serão mantidos.'
                : ' Itens locais sem equivalente no remoto serão excluídos.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="wa-btn wa-btn-primary"
                onClick={() => {
                  setConfirmSync(false)
                  void runAction('apply')
                }}
              >
                Confirmar download
              </button>
              <button
                type="button"
                className="wa-btn wa-btn-ghost"
                onClick={() => setConfirmSync(false)}
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {confirmOrdersSync && (
          <div className="mb-4 rounded-xl border border-amber-500/50 bg-amber-500/10 p-3" role="alert">
            <p className="mb-3 text-sm">
              Baixar pedidos do remoto para o local? Pedidos novos serão criados; pedidos existentes com mesmo ID serão substituídos pelo estado remoto. Nada será excluído.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="wa-btn wa-btn-primary"
                onClick={() => {
                  setConfirmOrdersSync(false)
                  void runAction('orders-apply')
                }}
              >
                Confirmar download de pedidos
              </button>
              <button
                type="button"
                className="wa-btn wa-btn-ghost"
                onClick={() => setConfirmOrdersSync(false)}
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {actionError && <p className="wa-alert is-error mb-3" role="alert">{actionError}</p>}
        {result && (
          <section className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3" aria-live="polite">
            {result.kind === 'compare' && <CompareResult report={result.value} />}
            {result.kind === 'backup' && <BackupResult result={result.value} />}
            {result.kind === 'sync' && <SyncResult result={result.value} />}
            {result.kind === 'orders-preview' && <OrdersPreviewResult result={result.value} />}
            {result.kind === 'orders-sync' && <OrdersSyncResult result={result.value} />}
          </section>
        )}
      </section>
    </div>
  )
}
