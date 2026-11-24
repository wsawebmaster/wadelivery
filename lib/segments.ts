/** Segmentos aceitos pela plataforma (mesma lista e cor principal de SegmentPalettes no catalog-api). */
export const STORE_SEGMENTS = [
  { value: 'lanchonete', label: 'Lanchonete', color: '#ea580c' },
  { value: 'hamburgueria', label: 'Hamburgueria', color: '#dc2626' },
  { value: 'pizzaria', label: 'Pizzaria', color: '#b91c1c' },
  { value: 'marmitaria', label: 'Marmitaria', color: '#15803d' },
  { value: 'assai', label: 'Açaí', color: '#7e22ce' },
] as const

export type StoreSegment = (typeof STORE_SEGMENTS)[number]['value']

const DEFAULT_COLOR = '#1f6feb'

export function segmentLabel(value?: string | null): string {
  const key = String(value || '').trim().toLowerCase()
  return STORE_SEGMENTS.find((s) => s.value === key)?.label ?? (value ? String(value) : 'Sem segmento')
}

export function segmentColor(value?: string | null): string {
  const key = String(value || '').trim().toLowerCase()
  return STORE_SEGMENTS.find((s) => s.value === key)?.color ?? DEFAULT_COLOR
}
