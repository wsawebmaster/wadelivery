'use client'

import { type ChangeEvent, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { RESERVED_SLUGS } from '@/lib/tenant-hosts'
import { createStore, type CreatedStoreResponse } from '@/lib/store-provisioning'
import { getApiBaseUrl } from '@/lib/admin-api'
import styles from './StoreSignupForm.module.css'
import { TURNSTILE_SITE_KEY, TurnstileWidget } from './TurnstileWidget'

type PersonType = 'PF' | 'PJ'
type SignupMode = 'quick' | 'complete'
type DeliveryMode = 'fixa' | 'km'
type PixKeyType = 'CPF' | 'CNPJ' | 'E-mail' | 'Celular' | 'Chave aleatória'

const PIX_KEY_TYPES: Array<{ value: PixKeyType, placeholder: string }> = [
  { value: 'Celular', placeholder: '(11) 99999-9999' },
  { value: 'CPF', placeholder: '000.000.000-00' },
  { value: 'CNPJ', placeholder: '00.000.000/0000-00' },
  { value: 'E-mail', placeholder: 'pix@sualoja.com.br' },
  { value: 'Chave aleatória', placeholder: '123e4567-e89b-12d3-a456-426614174000' },
]

const STATES = [
  'AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO',
] as const

type StoreFields = {
  Nome: string
  Slug: string
  TipoPessoa: PersonType
  Documento: string
  Telefone: string
  Email: string
  Endereco: string
  Numero: string
  Bairro: string
  Cidade: string
  Estado: string
  Cep: string
  Segmento: string
  TipoEntrega: DeliveryMode
  TaxaEntregaFixa: string
  TaxaPorKm: string
  TaxaMinima: string
  DistanciaMaximaKm: string
  TipoChavePix: PixKeyType
  ChavePix: string
  CorPrimaria: string
  CorSecundaria: string
  CorFundo: string
  CorTexto: string
  TipoCard: string
  LayoutCardapio: string
  EstiloBotao: string
}

type ImageField = 'Logo' | 'Banner' | 'Capa'

const palettes = [
  { name: 'Azul clássico', primary: '#1f6feb', secondary: '#ffffff', background: '#f3f4f6', text: '#2c3e50' },
  { name: 'Laranja', primary: '#f97316', secondary: '#fff7ed', background: '#ffedd5', text: '#431407' },
  { name: 'Verde', primary: '#15803d', secondary: '#f0fdf4', background: '#dcfce7', text: '#14532d' },
  { name: 'Roxo', primary: '#7c3aed', secondary: '#faf5ff', background: '#f3e8ff', text: '#3b0764' },
  { name: 'Vermelho', primary: '#dc2626', secondary: '#fef2f2', background: '#fee2e2', text: '#450a0a' },
  { name: 'Noturno', primary: '#38bdf8', secondary: '#1e293b', background: '#0f172a', text: '#f8fafc' },
  { name: 'Carne e Queijo', primary: '#f59e0b', secondary: '#1c1916', background: '#12100e', text: '#fafaf9' },
]

/** Paleta padrão por segmento, vinda da API (services/catalog-api/Services/SegmentPalettes.cs). */
type SegmentPalette = { segment: string, corPrimaria: string, corSecundaria: string, corFundo: string, corTexto: string }

const defaultFields: StoreFields = {
  Nome: '',
  Slug: '',
  TipoPessoa: 'PJ',
  Documento: '',
  Telefone: '',
  Email: '',
  Endereco: '',
  Numero: '',
  Bairro: '',
  Cidade: '',
  Estado: '',
  Cep: '',
  Segmento: 'lanchonete',
  TipoEntrega: 'fixa',
  TaxaEntregaFixa: '',
  TaxaPorKm: '',
  TaxaMinima: '',
  DistanciaMaximaKm: '5',
  TipoChavePix: 'Celular',
  ChavePix: '',
  CorPrimaria: palettes[0].primary,
  CorSecundaria: palettes[0].secondary,
  CorFundo: palettes[0].background,
  CorTexto: palettes[0].text,
  TipoCard: 'foto-grande',
  LayoutCardapio: 'grade',
  EstiloBotao: 'arredondado',
}

const colorFields = [
  ['CorPrimaria', 'Cor primária'],
  ['CorSecundaria', 'Cor secundária'],
  ['CorFundo', 'Cor de fundo'],
  ['CorTexto', 'Cor do texto'],
] as const

const imageLabels: Record<ImageField, string> = {
  Logo: 'Logo',
  Banner: 'Banner do topo',
  Capa: 'Foto de capa',
}

function slugify(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '')
}

function normalizeCnpj(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 14)
}

function normalizeCpf(value: string) {
  return value.replace(/\D/g, '').slice(0, 11)
}

function formatCnpj(value: string) {
  const clean = normalizeCnpj(value)
  const p1 = clean.slice(0, 2)
  const p2 = clean.slice(2, 5)
  const p3 = clean.slice(5, 8)
  const p4 = clean.slice(8, 12)
  const p5 = clean.slice(12, 14)
  let out = p1
  if (p2) out += `.${p2}`
  if (p3) out += `.${p3}`
  if (p4) out += `/${p4}`
  if (p5) out += `-${p5}`
  return out
}

function formatCpf(value: string) {
  const clean = normalizeCpf(value)
  const p1 = clean.slice(0, 3)
  const p2 = clean.slice(3, 6)
  const p3 = clean.slice(6, 9)
  const p4 = clean.slice(9, 11)
  let out = p1
  if (p2) out += `.${p2}`
  if (p3) out += `.${p3}`
  if (p4) out += `-${p4}`
  return out
}

/** Lê valores digitados como "7,50" ou "7.50". Retorna NaN se inválido. */
function parseAmount(value: string) {
  const text = value.trim().replace(',', '.')
  return /^\d+(\.\d{1,2})?$/.test(text) ? Number(text) : Number.NaN
}

function formatMoney(value: number) {
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

function validateDelivery(fields: StoreFields) {
  const maxKm = parseAmount(fields.DistanciaMaximaKm)
  if (!(maxKm > 0 && maxKm <= 100)) return 'Informe a distância máxima de entrega entre 0,1 e 100 km.'
  if (fields.TipoEntrega === 'fixa') {
    const fee = parseAmount(fields.TaxaEntregaFixa)
    if (!(fee > 0 && fee <= 500)) return 'Informe a taxa fixa de entrega entre R$ 0,01 e R$ 500,00.'
    return ''
  }
  const perKm = parseAmount(fields.TaxaPorKm)
  if (!(perKm > 0 && perKm <= 100)) return 'Informe o valor por km entre R$ 0,01 e R$ 100,00.'
  if (fields.TaxaMinima.trim()) {
    const minFee = parseAmount(fields.TaxaMinima)
    if (!(minFee >= 0 && minFee <= 500)) return 'Informe a taxa mínima entre R$ 0,00 e R$ 500,00.'
  }
  return ''
}

/** Validação básica no navegador; a API valida CPF/CNPJ com dígitos verificadores. */
function validatePix(fields: StoreFields) {
  const key = fields.ChavePix.trim()
  if (!key) return ''
  const digits = key.replace(/\D/g, '')
  switch (fields.TipoChavePix) {
    case 'Celular':
      return digits.length >= 10 && digits.length <= 13 ? '' : 'Chave Pix de celular inválida. Informe DDD e número.'
    case 'CPF':
      return isValidCpf(key) ? '' : 'Chave Pix: CPF inválido.'
    case 'CNPJ':
      return isValidCnpj(key) ? '' : 'Chave Pix: CNPJ inválido.'
    case 'E-mail':
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key) ? '' : 'Chave Pix: e-mail inválido.'
    default:
      return /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(key) ? '' : 'Chave Pix aleatória inválida.'
  }
}

function describeDelivery(fields: StoreFields) {
  const maxKm = fields.DistanciaMaximaKm.replace('.', ',')
  if (fields.TipoEntrega === 'fixa') {
    const fee = parseAmount(fields.TaxaEntregaFixa)
    return `Taxa fixa de ${Number.isNaN(fee) ? '—' : formatMoney(fee)} até ${maxKm} km`
  }
  const perKm = parseAmount(fields.TaxaPorKm)
  const minFee = parseAmount(fields.TaxaMinima || '0')
  const min = minFee > 0 ? `, mínimo ${formatMoney(minFee)}` : ''
  return `${Number.isNaN(perKm) ? '—' : formatMoney(perKm)} por km${min}, até ${maxKm} km`
}

function formatDocument(tipo: PersonType, value: string) {
  return tipo === 'PF' ? formatCpf(value) : formatCnpj(value)
}

function isValidCpf(value: string) {
  const digits = normalizeCpf(value)
  if (digits.length !== 11 || /^(\d)\1{10}$/.test(digits)) return false
  const calc = (source: string, weights: number[]) => {
    const sum = weights.reduce((total, weight, index) => total + Number(source[index]) * weight, 0)
    const rem = sum % 11
    return rem < 2 ? 0 : 11 - rem
  }
  const d1 = calc(digits.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = calc(digits.slice(0, 9) + d1, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2])
  return Number(digits[9]) === d1 && Number(digits[10]) === d2
}

function isValidCnpj(value: string) {
  const clean = normalizeCnpj(value)
  if (clean.length !== 14 || /^(.)(\1){13}$/.test(clean)) return false
  if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(clean)) return false
  const charValue = (c: string) => c.charCodeAt(0) - 48
  const calc = (source: string, weights: number[]) => {
    const sum = weights.reduce((total, weight, index) => total + charValue(source[index]) * weight, 0)
    const rem = sum % 11
    return rem < 2 ? 0 : 11 - rem
  }
  const d1 = calc(clean.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const d2 = calc(clean.slice(0, 12) + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  return charValue(clean[12]) === d1 && charValue(clean[13]) === d2
}

export function StoreSignupForm() {
  const [mode, setMode] = useState<SignupMode>('quick')
  const [step, setStep] = useState(1)
  const [fields, setFields] = useState(defaultFields)
  const [slugEdited, setSlugEdited] = useState(false)
  const [files, setFiles] = useState<Partial<Record<ImageField, File>>>({})
  const [previews, setPreviews] = useState<Partial<Record<ImageField, string>>>({})
  const [error, setError] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [created, setCreated] = useState<CreatedStoreResponse | null>(null)
  const [copied, setCopied] = useState(false)
  const [cities, setCities] = useState<string[]>([])
  const [citiesLoading, setCitiesLoading] = useState(false)
  const [citiesError, setCitiesError] = useState('')
  const [captchaToken, setCaptchaToken] = useState('')
  const [captchaKey, setCaptchaKey] = useState(0)
  const [cepStatus, setCepStatus] = useState('')
  const [segmentPalettes, setSegmentPalettes] = useState<SegmentPalette[]>([])
  // Enquanto o lojista não escolher cores, elas acompanham o segmento selecionado.
  const [colorsEdited, setColorsEdited] = useState(false)

  const steps = useMemo(() => mode === 'quick' ? ['Dados'] : ['Dados', 'Visual', 'Imagens', 'Revisão'], [mode])

  useEffect(() => () => {
    Object.values(previews).forEach((preview) => {
      if (preview) URL.revokeObjectURL(preview)
    })
  }, [previews])

  useEffect(() => {
    const uf = fields.Estado.trim().toUpperCase()
    if (!uf || !STATES.includes(uf as (typeof STATES)[number])) {
      setCities([])
      setCitiesError('')
      return
    }
    const controller = new AbortController()
    setCitiesLoading(true)
    setCitiesError('')
    fetch(`https://servicodados.ibge.gov.br/api/v1/localidades/estados/${uf}/municipios?orderBy=nome`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error('Falha ao carregar cidades')
        return r.json() as Promise<Array<{ nome: string }>>
      })
      .then((list) => {
        setCities(list.map((c) => c.nome))
      })
      .catch((e) => {
        if ((e as Error).name === 'AbortError') return
        setCities([])
        setCitiesError('Não foi possível carregar as cidades. Você pode digitar manualmente.')
      })
      .finally(() => setCitiesLoading(false))
    return () => controller.abort()
  }, [fields.Estado])

  useEffect(() => {
    const controller = new AbortController()
    fetch(`${getApiBaseUrl()}/api/v1/segment-palettes`, { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { segments?: SegmentPalette[] } | null) => setSegmentPalettes(Array.isArray(data?.segments) ? data.segments : []))
      .catch(() => { /* sem API: mantém a paleta padrão do formulário */ })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (colorsEdited) return
    const palette = segmentPalettes.find((p) => p.segment === fields.Segmento)
    if (!palette) return
    setFields((current) => ({
      ...current,
      CorPrimaria: palette.corPrimaria,
      CorSecundaria: palette.corSecundaria,
      CorFundo: palette.corFundo,
      CorTexto: palette.corTexto,
    }))
  }, [segmentPalettes, fields.Segmento, colorsEdited])

  function updateField<K extends keyof StoreFields>(key: K, value: StoreFields[K]) {
    setFields((current) => ({ ...current, [key]: value }))
  }

  async function handleCepChange(value: string) {
    const digits = value.replace(/\D/g, '').slice(0, 8)
    updateField('Cep', digits.length > 5 ? `${digits.slice(0, 5)}-${digits.slice(5)}` : digits)
    if (digits.length !== 8) {
      setCepStatus('')
      return
    }
    setCepStatus('Buscando endereço…')
    try {
      const response = await fetch(`https://viacep.com.br/ws/${digits}/json/`)
      if (!response.ok) throw new Error('cep')
      const data = await response.json() as { erro?: boolean, logradouro?: string, bairro?: string, localidade?: string, uf?: string }
      if (data.erro) {
        setCepStatus('CEP não encontrado. Preencha o endereço manualmente.')
        return
      }
      setFields((current) => ({
        ...current,
        Endereco: data.logradouro || current.Endereco,
        Bairro: data.bairro || current.Bairro,
        Cidade: data.localidade || current.Cidade,
        Estado: (data.uf || current.Estado).toUpperCase(),
      }))
      setCepStatus('')
    } catch {
      setCepStatus('Não foi possível buscar o CEP. Preencha o endereço manualmente.')
    }
  }

  function handleNameChange(value: string) {
    setFields((current) => ({
      ...current,
      Nome: value,
      Slug: slugEdited ? current.Slug : slugify(value),
    }))
  }

  function handleSlugChange(value: string) {
    setSlugEdited(true)
    updateField('Slug', slugify(value))
  }

  function handleImageChange(field: ImageField, event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('Use uma imagem PNG, JPG ou WebP de até 5 MB.')
      event.target.value = ''
      return
    }

    setError('')
    setFiles((current) => ({ ...current, [field]: file }))
    setPreviews((current) => ({ ...current, [field]: URL.createObjectURL(file) }))
  }

  function validateStepOne() {
    const required: Array<keyof StoreFields> = mode === 'quick'
      ? ['Nome', 'Slug', 'Telefone', 'Email', 'Endereco', 'Numero', 'Cidade', 'Estado', 'Cep', 'Segmento']
      : ['Nome', 'Slug', 'Documento', 'Telefone', 'Email', 'Endereco', 'Numero', 'Cidade', 'Estado', 'Cep', 'Segmento']
    if (required.some((key) => !String(fields[key]).trim())) return 'Preencha todos os campos obrigatórios.'
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.Slug) || fields.Slug.length < 3 || fields.Slug.length > 80) {
      return 'Revise o slug da loja. Use letras minúsculas, números e hífen.'
    }
    if (RESERVED_SLUGS.includes(fields.Slug)) return 'Este slug é reservado pelo sistema. Escolha outro.'
    if (!STATES.includes(fields.Estado.trim().toUpperCase() as (typeof STATES)[number])) return 'Informe uma UF válida.'
    if (mode === 'complete') {
      if (fields.TipoPessoa === 'PF') {
        if (!isValidCpf(fields.Documento)) return 'Informe um CPF válido.'
      } else if (!isValidCnpj(fields.Documento)) {
        return 'Informe um CNPJ válido.'
      }
    }
    if (fields.Cep.replace(/\D/g, '').length !== 8) return 'Informe um CEP válido.'
    const phoneDigits = fields.Telefone.replace(/\D/g, '')
    if (phoneDigits.length < 10 || phoneDigits.length > 15) return 'Informe um WhatsApp válido.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.Email)) return 'Informe um e-mail válido.'
    return validateDelivery(fields) || validatePix(fields)
  }

  function nextStep() {
    setError('')
    if (step === 1) {
      const validation = validateStepOne()
      if (validation) {
        setError(validation)
        return
      }
    }
    if (step === 2 && colorFields.some(([key]) => !/^#[0-9a-fA-F]{6}$/.test(fields[key]))) {
      setError('Informe as quatro cores no formato hexadecimal, por exemplo #1f6feb.')
      return
    }
    setStep((current) => Math.min(4, current + 1))
  }

  async function submit() {
    const validation = validateStepOne()
    if (validation) {
      setError(validation)
      return
    }
    if (TURNSTILE_SITE_KEY && !captchaToken) {
      setError('Conclua a verificação de segurança antes de criar a loja.')
      return
    }
    setError('')
    setIsCreating(true)
    const formData = new FormData()
    formData.append('ModoRapido', mode === 'quick' ? 'true' : 'false')
    formData.append('CaptchaToken', captchaToken)
    Object.entries(fields).forEach(([key, value]) => formData.append(key, String(value)))
    if (mode === 'complete') {
      Object.entries(files).forEach(([key, file]) => {
        if (file) formData.append(key, file)
      })
    }

    try {
      setCreated(await createStore(formData))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível criar a loja.')
      // O token do CAPTCHA é de uso único: gera outro para a próxima tentativa.
      setCaptchaToken('')
      setCaptchaKey((current) => current + 1)
    } finally {
      setIsCreating(false)
    }
  }

  async function copyCredentials() {
    if (!created) return
    await navigator.clipboard.writeText(
      `Login: ${created.adminUsername}\nSenha temporária: ${created.temporaryPassword}`,
    )
    setCopied(true)
  }

  if (created) {
    return (
      <main className={styles.page}>
        <section className={`${styles.panel} ${styles.successPanel}`} aria-live="polite">
          <span className={styles.successIcon} aria-hidden="true">✓</span>
          <p className={styles.eyebrow}>{mode === 'quick' ? 'Loja de teste criada' : 'Loja publicada'}</p>
          <h1>{fields.Nome} está pronta!</h1>
          <p className={styles.muted}>
            {created.acceptingOrders
              ? `O cardápio já recebe pedidos de entrega: ${describeDelivery(fields)}.`
              : 'O cardápio e o acesso administrativo já foram provisionados.'}
          </p>
          {created.deliveryWarning && (
            <p className={styles.warning} role="status">{created.deliveryWarning}</p>
          )}
          <a className={styles.publicLink} href={created.publicUrl} target="_blank" rel="noreferrer">
            {created.publicUrl}
          </a>
          <div className={styles.credentials}>
            <h2>Acesso inicial do painel</h2>
            <p><strong>Usuário:</strong> {created.adminUsername}</p>
            <p><strong>Senha temporária:</strong> <code>{created.temporaryPassword}</code></p>
            <p className={styles.warning}>
              Guarde a senha agora. Ela é exibida somente nesta tela e não é enviada por e-mail.
            </p>
            <button type="button" className={styles.secondaryButton} onClick={copyCredentials}>
              {copied ? 'Credenciais copiadas' : 'Copiar credenciais'}
            </button>
          </div>
          <a className={styles.primaryButton} href={created.adminUrl}>
            Acessar painel da loja
          </a>
        </section>
      </main>
    )
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/" className={styles.backLink}>← Voltar para WaDelivery</Link>
        <p className={styles.eyebrow}>Experimente gratuitamente</p>
        <h1>Crie sua loja digital</h1>
        <p className={styles.muted}>
          {mode === 'quick'
            ? 'Comece com o mínimo para testar. Você completa os dados depois no painel.'
            : 'Configure o visual e publique seu cardápio em poucos passos.'}
        </p>
      </header>

      <div className={styles.panel}>
        <div className={styles.modeSwitch} role="radiogroup" aria-label="Modo de cadastro">
          <button type="button" className={mode === 'quick' ? styles.modeActive : styles.modeButton} onClick={() => { setMode('quick'); setStep(1); setError('') }}>
            Teste rápido
          </button>
          <button type="button" className={mode === 'complete' ? styles.modeActive : styles.modeButton} onClick={() => { setMode('complete'); setStep(1); setError('') }}>
            Configuração completa
          </button>
        </div>

        {mode === 'complete' && (
          <ol className={styles.stepper} aria-label="Etapas de criação da loja">
            {steps.map((label, index) => (
              <li key={label} className={step === index + 1 ? styles.currentStep : step > index + 1 ? styles.completedStep : ''}>
                <span>{index + 1}</span>{label}
              </li>
            ))}
          </ol>
        )}

        {step === 1 && (
          <section aria-labelledby="signupStepTitle">
            <h2 id="signupStepTitle">Dados da loja</h2>
            <div className={styles.formGrid}>
              <label className={styles.fullWidth}>Nome da loja *
                <input value={fields.Nome} onChange={(event) => handleNameChange(event.target.value)} autoComplete="organization" maxLength={120} />
              </label>
              <label>Slug público *
                <input value={fields.Slug} onChange={(event) => handleSlugChange(event.target.value)} maxLength={80} autoCapitalize="none" spellCheck={false} />
                <small>Será publicado em wadelivery.com.br/{fields.Slug || 'sua-loja'}</small>
              </label>
              {mode === 'complete' && (
                <>
                  <label>Tipo de pessoa *
                    <select
                      value={fields.TipoPessoa}
                      onChange={(event) => setFields((current) => ({
                        ...current,
                        TipoPessoa: event.target.value as PersonType,
                        Documento: formatDocument(event.target.value as PersonType, current.Documento),
                      }))}
                    >
                      <option value="PJ">Pessoa Jurídica</option>
                      <option value="PF">Pessoa Física</option>
                    </select>
                  </label>
                  <label>{fields.TipoPessoa === 'PF' ? 'CPF *' : 'CNPJ *'}
                    <input
                      value={fields.Documento}
                      onChange={(event) => updateField('Documento', formatDocument(fields.TipoPessoa, event.target.value))}
                      inputMode={fields.TipoPessoa === 'PF' ? 'numeric' : 'text'}
                      maxLength={fields.TipoPessoa === 'PF' ? 14 : 18}
                      autoCapitalize={fields.TipoPessoa === 'PF' ? 'off' : 'characters'}
                      spellCheck={false}
                      placeholder={fields.TipoPessoa === 'PF' ? '000.000.000-00' : '00.000.000/0000-00 ou 12.ABC.345/01DE-35'}
                    />
                  </label>
                </>
              )}
              <label>WhatsApp *
                <input value={fields.Telefone} onChange={(event) => updateField('Telefone', event.target.value)} type="tel" autoComplete="tel" />
              </label>
              <label>E-mail de acesso *
                <input value={fields.Email} onChange={(event) => updateField('Email', event.target.value)} type="email" autoComplete="email" maxLength={64} />
              </label>
              <label>Segmento *
                <select value={fields.Segmento} onChange={(event) => updateField('Segmento', event.target.value)}>
                  <option value="lanchonete">Lanchonete</option>
                  <option value="hamburgueria">Hamburgueria</option>
                  <option value="pizzaria">Pizzaria</option>
                  <option value="marmitaria">Marmitaria</option>
                  <option value="assai">Açaí</option>
                </select>
              </label>
              <label>UF *
                <select value={fields.Estado} onChange={(event) => { updateField('Estado', event.target.value.toUpperCase()); updateField('Cidade', '') }}>
                  <option value="">Selecione</option>
                  {STATES.map((uf) => <option key={uf} value={uf}>{uf}</option>)}
                </select>
              </label>
              <label>Cidade *
                {cities.length > 0 ? (
                  <select value={fields.Cidade} onChange={(event) => updateField('Cidade', event.target.value)} disabled={citiesLoading}>
                    <option value="">{citiesLoading ? 'Carregando cidades...' : 'Selecione a cidade'}</option>
                    {cities.map((city) => <option key={city} value={city}>{city}</option>)}
                  </select>
                ) : (
                  <input value={fields.Cidade} onChange={(event) => updateField('Cidade', event.target.value)} placeholder={citiesLoading ? 'Carregando cidades...' : 'Digite a cidade'} autoComplete="address-level2" />
                )}
                {citiesError && <small>{citiesError}</small>}
              </label>
              <label>CEP da loja *
                <input value={fields.Cep} onChange={(event) => handleCepChange(event.target.value)} inputMode="numeric" maxLength={9} autoComplete="postal-code" placeholder="00000-000" />
                <small>{cepStatus || 'Preenche rua, bairro e cidade automaticamente.'}</small>
              </label>
              <label>Endereço *
                <input value={fields.Endereco} onChange={(event) => updateField('Endereco', event.target.value)} autoComplete="address-line1" maxLength={200} />
              </label>
              <label>Número *
                <input value={fields.Numero} onChange={(event) => updateField('Numero', event.target.value)} maxLength={32} />
              </label>
              <label>Bairro
                <input value={fields.Bairro} onChange={(event) => updateField('Bairro', event.target.value)} maxLength={120} />
              </label>
            </div>

            <h3 className={styles.sectionTitle}>Entrega</h3>
            <p className={styles.muted}>A distância é medida a partir do endereço da loja. Você pode alterar estes valores depois no painel.</p>
            <div className={styles.modeSwitch} role="radiogroup" aria-label="Cobrança da entrega">
              <button type="button" role="radio" aria-checked={fields.TipoEntrega === 'fixa'} className={fields.TipoEntrega === 'fixa' ? styles.modeActive : styles.modeButton} onClick={() => updateField('TipoEntrega', 'fixa')}>
                Taxa fixa
              </button>
              <button type="button" role="radio" aria-checked={fields.TipoEntrega === 'km'} className={fields.TipoEntrega === 'km' ? styles.modeActive : styles.modeButton} onClick={() => updateField('TipoEntrega', 'km')}>
                Valor por km
              </button>
            </div>
            <div className={styles.formGrid}>
              {fields.TipoEntrega === 'fixa' ? (
                <label>Taxa de entrega (R$) *
                  <input value={fields.TaxaEntregaFixa} onChange={(event) => updateField('TaxaEntregaFixa', event.target.value)} inputMode="decimal" placeholder="Ex.: 7,00" />
                  <small>Mesmo valor para qualquer endereço dentro da distância máxima.</small>
                </label>
              ) : (
                <>
                  <label>Valor por km (R$) *
                    <input value={fields.TaxaPorKm} onChange={(event) => updateField('TaxaPorKm', event.target.value)} inputMode="decimal" placeholder="Ex.: 2,50" />
                    <small>Distância em linha reta × valor por km, arredondado para cima em R$ 0,50.</small>
                  </label>
                  <label>Taxa mínima (R$)
                    <input value={fields.TaxaMinima} onChange={(event) => updateField('TaxaMinima', event.target.value)} inputMode="decimal" placeholder="Opcional, ex.: 5,00" />
                    <small>Valor cobrado quando o cálculo por km der menos que isso.</small>
                  </label>
                </>
              )}
              <label>Distância máxima (km) *
                <input value={fields.DistanciaMaximaKm} onChange={(event) => updateField('DistanciaMaximaKm', event.target.value)} inputMode="decimal" placeholder="Ex.: 5" />
                <small>Endereços mais distantes não conseguem pedir entrega.</small>
              </label>
            </div>

            <h3 className={styles.sectionTitle}>Pagamento via Pix</h3>
            <p className={styles.muted}>
              Opcional, mas recomendado: sem chave Pix o cardápio não oferece Pix ao cliente. Você pode cadastrar depois no painel.
            </p>
            <div className={styles.formGrid}>
              <label>Tipo da chave
                <select value={fields.TipoChavePix} onChange={(event) => updateField('TipoChavePix', event.target.value as PixKeyType)}>
                  {PIX_KEY_TYPES.map((type) => <option key={type.value} value={type.value}>{type.value}</option>)}
                </select>
              </label>
              <label>Chave Pix
                <input
                  value={fields.ChavePix}
                  onChange={(event) => updateField('ChavePix', event.target.value)}
                  placeholder={PIX_KEY_TYPES.find((type) => type.value === fields.TipoChavePix)?.placeholder}
                  autoCapitalize="none"
                  spellCheck={false}
                  maxLength={120}
                />
                <small>O cliente vê esta chave ao escolher Pix e pode copiá-la no acompanhamento do pedido.</small>
              </label>
            </div>

            {mode === 'quick' && (
              <p className={styles.disclaimer}>
                No teste rápido, a loja é criada com visual padrão e já recebe pedidos de entrega para você testar. Documento, visual e demais configurações podem ser completados no painel. Mesas e recursos avançados ficam desativados até liberação por módulo.
              </p>
            )}
          </section>
        )}

        {step === 2 && (
          <section aria-labelledby="signupStepTitle">
            <h2 id="signupStepTitle">Personalização visual</h2>
            <p className={styles.muted}>As cores começam pela paleta do segmento escolhido. Escolha outra paleta ou ajuste cada cor; o preview muda na hora.</p>
            <div className={styles.paletteGrid}>
              {palettes.map((palette) => (
                <button
                  type="button"
                  key={palette.name}
                  className={styles.palette}
                  onClick={() => {
                    setColorsEdited(true)
                    setFields((current) => ({
                      ...current,
                      CorPrimaria: palette.primary,
                      CorSecundaria: palette.secondary,
                      CorFundo: palette.background,
                      CorTexto: palette.text,
                    }))
                  }}
                >
                  <span style={{ background: `linear-gradient(90deg, ${palette.primary} 50%, ${palette.secondary} 50%)` }} />
                  {palette.name}
                </button>
              ))}
            </div>
            <div className={styles.customColors}>
              {colorFields.map(([key, label]) => (
                <label key={key}>{label}
                  <span className={styles.colorControl}>
                    <input type="color" value={fields[key]} onChange={(event) => { setColorsEdited(true); updateField(key, event.target.value) }} />
                    <input value={fields[key]} onChange={(event) => { setColorsEdited(true); updateField(key, event.target.value) }} maxLength={7} />
                  </span>
                </label>
              ))}
            </div>

            <div className={styles.previewWrap}>
              <div className={styles.previewHeading}>Preview ao vivo</div>
              <article
                className={styles.productPreview}
                style={{
                  backgroundColor: fields.CorSecundaria,
                  color: fields.CorTexto,
                  borderColor: fields.CorPrimaria,
                  borderRadius: fields.EstiloBotao === 'quadrado' ? 4 : fields.EstiloBotao === 'pilula' ? 28 : 14,
                }}
              >
                {(fields.LayoutCardapio === 'com-foto'
                  || (fields.LayoutCardapio !== 'sem-foto' && fields.TipoCard !== 'compacto'))
                  && <div className={styles.previewImage} aria-hidden="true">🍔</div>}
                <div>
                  <strong>Hambúrguer da casa</strong>
                  <p>Carne artesanal, queijo e molho especial</p>
                  <b style={{ color: fields.CorPrimaria }}>R$ 24,90</b>
                </div>
                <button type="button" style={{ backgroundColor: fields.CorPrimaria }}>Adicionar</button>
              </article>
              <div className={styles.previewBackground} style={{ backgroundColor: fields.CorFundo, color: fields.CorTexto }}>
                Fundo do cardápio
              </div>
            </div>

            <div className={styles.optionGrid}>
              <label>Tipo de card
                <select value={fields.TipoCard} onChange={(event) => updateField('TipoCard', event.target.value)}>
                  <option value="moderno">Moderno (foto 16:10, preço e botão no rodapé)</option>
                  <option value="foto-grande">Foto grande</option>
                  <option value="lista-horizontal">Lista horizontal</option>
                  <option value="compacto">Compacto sem foto</option>
                  <option value="vitrine">Vitrine (foto de ponta a ponta)</option>
                  <option value="minimalista">Minimalista (lista com miniatura)</option>
                  <option value="destaque">Destaque (faixa na cor da loja)</option>
                </select>
              </label>
              <label>Layout do cardápio
                <select value={fields.LayoutCardapio} onChange={(event) => updateField('LayoutCardapio', event.target.value)}>
                  <option value="grade">Grade 2 colunas</option>
                  <option value="lista">Lista</option>
                  <option value="com-foto">Com foto</option>
                  <option value="sem-foto">Sem foto</option>
                </select>
              </label>
              <label>Estilo do botão
                <select value={fields.EstiloBotao} onChange={(event) => updateField('EstiloBotao', event.target.value)}>
                  <option value="arredondado">Arredondado</option>
                  <option value="quadrado">Quadrado</option>
                  <option value="pilula">Pílula</option>
                </select>
              </label>
            </div>
          </section>
        )}

        {step === 3 && (
          <section aria-labelledby="signupStepTitle">
            <h2 id="signupStepTitle">Imagens da loja</h2>
            <p className={styles.muted}>Imagens opcionais. PNG, JPG ou WebP de até 5 MB.</p>
            <div className={styles.uploadGrid}>
              {(['Logo', 'Banner', 'Capa'] as const).map((field) => (
                <label className={styles.uploadCard} key={field}>
                  <span>{imageLabels[field]}</span>
                  {previews[field] ? (
                    <img src={previews[field]} alt={`Prévia de ${imageLabels[field]}`} />
                  ) : (
                    <span className={styles.uploadPlaceholder}>Selecionar imagem</span>
                  )}
                  <input type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => handleImageChange(field, event)} />
                </label>
              ))}
            </div>
          </section>
        )}

        {step === 4 && (
          <section aria-labelledby="signupStepTitle">
            <h2 id="signupStepTitle">Revise sua loja</h2>
            <div className={styles.reviewGrid}>
              <div><span>Nome</span><strong>{fields.Nome}</strong></div>
              <div><span>Endereço do cardápio</span><strong>wadelivery.com.br/{fields.Slug}</strong></div>
              <div><span>{fields.TipoPessoa === 'PF' ? 'CPF' : 'CNPJ'}</span><strong>{fields.Documento}</strong></div>
              <div><span>Contato</span><strong>{fields.Email} · {fields.Telefone}</strong></div>
              <div><span>Localização</span><strong>{fields.Endereco}, {fields.Numero} — {fields.Cidade}/{fields.Estado}</strong></div>
              <div><span>Segmento</span><strong>{fields.Segmento}</strong></div>
              <div><span>Entrega</span><strong>{describeDelivery(fields)}</strong></div>
              <div><span>Pix</span><strong>{fields.ChavePix.trim() ? `${fields.TipoChavePix}: ${fields.ChavePix.trim()}` : 'Não informado (cadastre no painel)'}</strong></div>
              <div><span>Visual</span><strong>{fields.TipoCard} · {fields.LayoutCardapio} · botão {fields.EstiloBotao}</strong></div>
              <div><span>Imagens</span><strong>{Object.keys(files).length ? Object.keys(files).map((name) => imageLabels[name as ImageField]).join(', ') : 'Nenhuma enviada'}</strong></div>
            </div>
            <p className={styles.disclaimer}>
              Ao criar, a API registra a loja e o administrador inicial, publica o cardápio e cria as categorias e mesas padrão.
            </p>
          </section>
        )}

        {(mode === 'quick' || step === 4) && (
          <TurnstileWidget key={captchaKey} onToken={setCaptchaToken} onError={setError} />
        )}

        {error && <p className={styles.error} role="alert">{error}</p>}

        <footer className={styles.actions}>
          {mode === 'complete' && step > 1 && (
            <button type="button" className={styles.secondaryButton} onClick={() => { setError(''); setStep((current) => current - 1) }}>
              Voltar
            </button>
          )}
          {mode === 'complete' && step < 4 ? (
            <button type="button" className={styles.primaryButton} onClick={nextStep}>Continuar</button>
          ) : (
            <button type="button" className={styles.primaryButton} onClick={submit} disabled={isCreating}>
              {isCreating ? 'Criando loja…' : mode === 'quick' ? 'Criar loja de teste' : 'Criar loja e publicar'}
            </button>
          )}
        </footer>
      </div>
    </main>
  )
}
