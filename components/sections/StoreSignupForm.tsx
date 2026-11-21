'use client'

import { type ChangeEvent, useEffect, useState } from 'react'
import Link from 'next/link'
import { RESERVED_SLUGS } from '@/lib/tenant-hosts'
import { createStore, type CreatedStoreResponse } from '@/lib/store-provisioning'
import styles from './StoreSignupForm.module.css'

type StoreFields = {
  Nome: string
  Slug: string
  Cnpj: string
  Telefone: string
  Email: string
  Endereco: string
  Numero: string
  Bairro: string
  Cidade: string
  Estado: string
  Cep: string
  Segmento: string
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
]

const defaultFields: StoreFields = {
  Nome: '',
  Slug: '',
  Cnpj: '',
  Telefone: '',
  Email: '',
  Endereco: '',
  Numero: '',
  Bairro: '',
  Cidade: '',
  Estado: '',
  Cep: '',
  Segmento: 'lanchonete',
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

function isValidCnpj(value: string) {
  const digits = value.replace(/\D/g, '')
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false

  const calculateDigit = (source: string, weights: number[]) => {
    const sum = weights.reduce((total, weight, index) => total + Number(source[index]) * weight, 0)
    const remainder = sum % 11
    return remainder < 2 ? 0 : 11 - remainder
  }

  const first = calculateDigit(digits.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  const second = calculateDigit(digits.slice(0, 12) + first, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2])
  return Number(digits[12]) === first && Number(digits[13]) === second
}

export function StoreSignupForm() {
  const [step, setStep] = useState(1)
  const [fields, setFields] = useState(defaultFields)
  const [slugEdited, setSlugEdited] = useState(false)
  const [files, setFiles] = useState<Partial<Record<ImageField, File>>>({})
  const [previews, setPreviews] = useState<Partial<Record<ImageField, string>>>({})
  const [error, setError] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [created, setCreated] = useState<CreatedStoreResponse | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => () => {
    Object.values(previews).forEach((preview) => {
      if (preview) URL.revokeObjectURL(preview)
    })
  }, [previews])

  function updateField<K extends keyof StoreFields>(key: K, value: StoreFields[K]) {
    setFields((current) => ({ ...current, [key]: value }))
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
    const required: Array<keyof StoreFields> = [
      'Nome', 'Slug', 'Cnpj', 'Telefone', 'Email', 'Endereco', 'Numero', 'Cidade', 'Estado', 'Cep', 'Segmento',
    ]
    if (required.some((key) => !fields[key].trim())) return 'Preencha todos os campos obrigatórios.'
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fields.Slug) || fields.Slug.length < 3 || fields.Slug.length > 80) {
      return 'Revise o slug da loja. Use letras minúsculas, números e hífen.'
    }
    if (RESERVED_SLUGS.includes(fields.Slug)) return 'Este slug é reservado pelo sistema. Escolha outro.'
    if (!/^[A-Za-z]{2}$/.test(fields.Estado.trim())) return 'Informe a UF com duas letras.'
    if (!isValidCnpj(fields.Cnpj)) return 'Informe um CNPJ válido.'
    const phoneDigits = fields.Telefone.replace(/\D/g, '')
    if (phoneDigits.length < 10 || phoneDigits.length > 15) return 'Informe um WhatsApp válido.'
    if (fields.Cep.replace(/\D/g, '').length !== 8) return 'Informe um CEP válido.'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.Email)) return 'Informe um e-mail válido.'
    return ''
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
    setError('')
    setIsCreating(true)
    const formData = new FormData()
    Object.entries(fields).forEach(([key, value]) => formData.append(key, value))
    Object.entries(files).forEach(([key, file]) => {
      if (file) formData.append(key, file)
    })

    try {
      setCreated(await createStore(formData))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Não foi possível criar a loja.')
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
          <p className={styles.eyebrow}>Loja publicada</p>
          <h1>{fields.Nome} está pronta!</h1>
          <p className={styles.muted}>O cardápio e o acesso administrativo já foram provisionados.</p>
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
        <p className={styles.muted}>Configure o visual e publique seu cardápio em poucos passos.</p>
      </header>

      <div className={styles.panel}>
        <ol className={styles.stepper} aria-label="Etapas de criação da loja">
          {['Dados', 'Visual', 'Imagens', 'Revisão'].map((label, index) => (
            <li key={label} className={step === index + 1 ? styles.currentStep : step > index + 1 ? styles.completedStep : ''}>
              <span>{index + 1}</span>{label}
            </li>
          ))}
        </ol>

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
              <label>CNPJ *
                <input value={fields.Cnpj} onChange={(event) => updateField('Cnpj', event.target.value)} inputMode="numeric" maxLength={18} />
              </label>
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
                </select>
              </label>
              <label>Endereço *
                <input value={fields.Endereco} onChange={(event) => updateField('Endereco', event.target.value)} autoComplete="address-line1" />
              </label>
              <label>Número *
                <input value={fields.Numero} onChange={(event) => updateField('Numero', event.target.value)} />
              </label>
              <label>Bairro
                <input value={fields.Bairro} onChange={(event) => updateField('Bairro', event.target.value)} />
              </label>
              <label>CEP *
                <input value={fields.Cep} onChange={(event) => updateField('Cep', event.target.value)} inputMode="numeric" maxLength={9} autoComplete="postal-code" />
              </label>
              <label>Cidade *
                <input value={fields.Cidade} onChange={(event) => updateField('Cidade', event.target.value)} autoComplete="address-level2" />
              </label>
              <label>UF *
                <input value={fields.Estado} onChange={(event) => updateField('Estado', event.target.value.toUpperCase())} maxLength={2} autoComplete="address-level1" />
              </label>
            </div>
          </section>
        )}

        {step === 2 && (
          <section aria-labelledby="signupStepTitle">
            <h2 id="signupStepTitle">Personalização visual</h2>
            <p className={styles.muted}>Escolha uma paleta pronta ou ajuste cada cor. O preview muda na hora.</p>
            <div className={styles.paletteGrid}>
              {palettes.map((palette) => (
                <button
                  type="button"
                  key={palette.name}
                  className={styles.palette}
                  onClick={() => setFields((current) => ({
                    ...current,
                    CorPrimaria: palette.primary,
                    CorSecundaria: palette.secondary,
                    CorFundo: palette.background,
                    CorTexto: palette.text,
                  }))}
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
                    <input type="color" value={fields[key]} onChange={(event) => updateField(key, event.target.value)} />
                    <input value={fields[key]} onChange={(event) => updateField(key, event.target.value)} maxLength={7} />
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
                  <option value="foto-grande">Foto grande</option>
                  <option value="lista-horizontal">Lista horizontal</option>
                  <option value="compacto">Compacto sem foto</option>
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
              <div><span>CNPJ</span><strong>{fields.Cnpj}</strong></div>
              <div><span>Contato</span><strong>{fields.Email} · {fields.Telefone}</strong></div>
              <div><span>Localização</span><strong>{fields.Endereco}, {fields.Numero} — {fields.Cidade}/{fields.Estado}</strong></div>
              <div><span>Segmento</span><strong>{fields.Segmento}</strong></div>
              <div><span>Visual</span><strong>{fields.TipoCard} · {fields.LayoutCardapio} · botão {fields.EstiloBotao}</strong></div>
              <div><span>Imagens</span><strong>{Object.keys(files).length ? Object.keys(files).map((name) => imageLabels[name as ImageField]).join(', ') : 'Nenhuma enviada'}</strong></div>
            </div>
            <p className={styles.disclaimer}>
              Ao criar, a API registra a loja e o administrador inicial, publica o cardápio e cria as categorias e mesas padrão.
            </p>
          </section>
        )}

        {error && <p className={styles.error} role="alert">{error}</p>}

        <footer className={styles.actions}>
          {step > 1 && (
            <button type="button" className={styles.secondaryButton} onClick={() => { setError(''); setStep((current) => current - 1) }}>
              Voltar
            </button>
          )}
          {step < 4 ? (
            <button type="button" className={styles.primaryButton} onClick={nextStep}>Continuar</button>
          ) : (
            <button type="button" className={styles.primaryButton} onClick={submit} disabled={isCreating}>
              {isCreating ? 'Criando loja…' : 'Criar loja e publicar'}
            </button>
          )}
        </footer>
      </div>
    </main>
  )
}
