'use client'

import { useEffect, useRef, useState } from 'react'
import {
  fetchSegmentPalettes,
  setPlatformSegment,
  type PlatformStore,
  type SegmentPalette,
} from '@/lib/admin-api'
import { STORE_SEGMENTS, segmentLabel } from '@/lib/segments'

interface PanelProps {
  store: PlatformStore
  onChanged: (store: PlatformStore) => void
  /** Chamado ao clicar em "Concluir" depois de aplicar (o diálogo fecha; a página reinicia o formulário). */
  onDone?: () => void
  onCancel?: () => void
}

/** Troca do segmento: cores, logo padrão e produtos de exemplo (diálogo e página da loja). */
export function SegmentPanel({ store, onChanged, onDone, onCancel }: PanelProps) {
  const current = String(store.segment || '').toLowerCase()
  const [segment, setSegment] = useState(current || STORE_SEGMENTS[0].value)
  // Por padrão a loja passa a ter o visual do novo segmento (cores, logo padrão e exemplos).
  // Fabin (loja 1) mantém o visual original: as opções começam desmarcadas.
  const isFabin = store.storeId === 1
  const [applyPalette, setApplyPalette] = useState(!isFabin)
  const [applySamples, setApplySamples] = useState(!isFabin)
  const [palettes, setPalettes] = useState<SegmentPalette[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<string[] | null>(null)

  useEffect(() => {
    fetchSegmentPalettes().then((r) => setPalettes(r.segments)).catch(() => setPalettes([]))
  }, [])

  async function save() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await setPlatformSegment(store.id, segment, { applyPalette, applySamples })
      onChanged(result.store)
      const { applied } = result
      const lines = [`Segmento alterado para ${segmentLabel(segment)}.`]
      if (applied.colors) lines.push('Cores do segmento aplicadas ao cardápio.')
      if (applied.logo) lines.push('Logo padrão refeito nas novas cores.')
      else if (applyPalette || applySamples) lines.push('Logo próprio da loja mantido.')
      if (applied.samplesAdded > 0) lines.push(`Produtos de exemplo trocados: ${applied.samplesRemoved} removido(s), ${applied.samplesAdded} criado(s) com fotos do segmento.`)
      else if (applySamples) lines.push('A loja não tem mais produtos de exemplo; os produtos dela foram mantidos.')
      setSummary(lines)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível alterar o segmento.')
    } finally {
      setBusy(false)
    }
  }

  const unchanged = segment === current && !applyPalette && !applySamples

  if (summary) {
    return (
      <div className="wa-form-section">
        <ul className="wa-alert is-ok wa-summary">
          {summary.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="wa-hint text-xs text-[var(--text-muted)]">
          O cardápio público pode levar até 1 minuto para refletir a mudança (cache).
        </p>
        <div className="wa-actions">
          <button
            type="button"
            className="wa-btn wa-btn-primary"
            onClick={() => {
              setSummary(null)
              onDone?.()
            }}
          >
            Concluir
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="wa-form-section">
      {error && <p className="wa-alert is-error">{error}</p>}
      {isFabin && (
        <p className="wa-alert is-warn">
          Fabin mantém o visual original do cardápio: cores e logo da plataforma não são usados nela. Deixe as opções
          abaixo desmarcadas para trocar só o segmento.
        </p>
      )}

      <fieldset className="wa-segment-list">
        <legend className="wa-label">Novo segmento</legend>
        {STORE_SEGMENTS.map((s) => {
          const palette = palettes.find((p) => p.segment === s.value)
          return (
            <label key={s.value} className={`wa-segment-option ${segment === s.value ? 'is-selected' : ''}`}>
              <input type="radio" name={`segment-${store.id}`} value={s.value} checked={segment === s.value} onChange={() => setSegment(s.value)} />
              <span className="wa-segment-name">
                {s.label}
                {s.value === current && <span className="ml-2 text-xs text-[var(--text-muted)]">(atual)</span>}
              </span>
              {palette && (
                <span className="wa-segment-swatches" aria-label={`Cores padrão: ${palette.name}`} title={palette.name}>
                  <i style={{ background: palette.corPrimaria }} />
                  <i style={{ background: palette.corFundo }} />
                  <i style={{ background: palette.corTexto }} />
                </span>
              )}
            </label>
          )
        })}
      </fieldset>

      <label className="wa-field flex items-start gap-2">
        <input type="checkbox" checked={applyPalette} onChange={(e) => setApplyPalette(e.target.checked)} className="mt-1" />
        <span className="text-sm">
          Aplicar as cores do segmento
          <span className="block text-xs text-[var(--text-muted)]">
            Substitui as cores do cardápio e refaz o logo padrão nelas. Logo enviado pelo lojista é mantido.
          </span>
        </span>
      </label>

      <label className="wa-field flex items-start gap-2">
        <input type="checkbox" checked={applySamples} onChange={(e) => setApplySamples(e.target.checked)} className="mt-1" />
        <span className="text-sm">
          Trocar os produtos de exemplo pelos do segmento
          <span className="block text-xs text-[var(--text-muted)]">
            Os produtos de exemplo do cadastro viram os do novo segmento, com fotos e categorias. Produtos cadastrados
            pelo lojista não são alterados.
          </span>
        </span>
      </label>

      <p className="wa-hint text-xs text-[var(--text-muted)]">
        O segmento também define as cores sugeridas no painel do lojista, o tipo de cozinha informado ao Google e os
        filtros da plataforma.
      </p>

      <div className="wa-actions">
        <button type="button" className="wa-btn wa-btn-primary" disabled={busy || unchanged} onClick={() => void save()}>
          {busy ? 'Aplicando…' : 'Salvar segmento'}
        </button>
        {onCancel && (
          <button type="button" className="wa-btn wa-btn-ghost" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
    </div>
  )
}

interface Props {
  store: PlatformStore
  onClose: () => void
  onChanged: (store: PlatformStore) => void
}

/** Troca do segmento da loja pela plataforma (perfil Dev). */
export default function SegmentDialog({ store, onClose, onChanged }: Props) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    closeRef.current?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="segment-title"
        className="wa-card wa-dialog max-h-[92vh] w-full max-w-lg overflow-y-auto shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h2 id="segment-title" className="text-lg font-semibold">
              Segmento · {store.name}
            </h2>
            <p className="text-xs text-[var(--text-muted)]">Atual: {segmentLabel(store.segment)}</p>
          </div>
          <button ref={closeRef} type="button" className="wa-btn wa-btn-ghost" onClick={onClose}>
            Fechar
          </button>
        </header>
        <SegmentPanel store={store} onChanged={onChanged} onDone={onClose} onCancel={onClose} />
      </section>
    </div>
  )
}
