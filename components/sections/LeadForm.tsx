'use client'

import { type FormEvent, useState, useCallback } from 'react'
import { Modal } from '@/components/ui/Modal'
import { Button } from '@/components/ui/Button'
import { validateLeadForm, type FieldErrors } from '@/lib/validation'
import { formatPhone } from '@/lib/phone-mask'

interface LeadFormProps {
  open: boolean
  onClose: () => void
}

type FormState = 'idle' | 'loading' | 'success' | 'error'

interface LeadData {
  nome: string
  telefone: string
  email: string
}

const LEAD_STORAGE_KEY = 'landing_leads_v1'

export function LeadForm({ open, onClose }: LeadFormProps) {
  const [formState, setFormState] = useState<FormState>('idle')
  const [errors, setErrors] = useState<FieldErrors>({})
  const [submittedName, setSubmittedName] = useState('')
  const [submittedContact, setSubmittedContact] = useState('')
  const [apiError, setApiError] = useState('')
  const [nome, setNome] = useState('')
  const [telefone, setTelefone] = useState('')
  const [email, setEmail] = useState('')

  function handlePhoneChange(value: string) {
    setTelefone(formatPhone(value))
  }

  function handleBlur(field: keyof LeadData, value: string) {
    if (!value.trim()) return

    const data = { nome, telefone, email, [field]: value.trim() }
    const validation = validateLeadForm(data)

    setErrors((prev) => ({
      ...prev,
      [field]: validation[field],
    }))
  }

  function handleInput(field: keyof LeadData, value: string) {
    if (errors[field]) {
      const data = { nome, telefone, email, [field]: value.trim() }
      const validation = validateLeadForm(data)

      setErrors((prev) => ({
        ...prev,
        [field]: validation[field],
      }))
    }
  }

  function saveToLocalStorage(data: LeadData) {
    try {
      const raw = localStorage.getItem(LEAD_STORAGE_KEY)
      let leads: LeadData[] = []
      if (raw) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) leads = parsed
      }

      const isDuplicate = leads.some(
        (lead) =>
          lead.email.toLowerCase() === data.email.toLowerCase() ||
          lead.telefone.replace(/\D/g, '') === data.telefone.replace(/\D/g, '')
      )

      if (!isDuplicate) {
        leads.push({
          ...data,
          criadoEm: new Date().toISOString(),
          origem: 'landing_page',
        } as LeadData & { criadoEm: string; origem: string })
        localStorage.setItem(LEAD_STORAGE_KEY, JSON.stringify(leads))
      }
    } catch {
      // localStorage not available or corrupted
    }
  }

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault()

      const data: LeadData = {
        nome: nome.trim(),
        telefone: telefone.trim(),
        email: email.trim(),
      }

      const validation = validateLeadForm(data)
      setErrors(validation)

      if (Object.keys(validation).length > 0) {
        const firstInvalidField = document.querySelector('.field.invalid input')
        ;(firstInvalidField as HTMLInputElement)?.focus()
        return
      }

      setFormState('loading')
      setApiError('')

      try {
        const apiUrl = process.env.NEXT_PUBLIC_API_URL
        const response = await fetch(`${apiUrl}/leads`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(data),
        })

        if (!response.ok) {
          throw new Error('Erro ao enviar dados')
        }

        setSubmittedName(data.nome.split(' ')[0])
        setSubmittedContact(data.email || data.telefone)
        setFormState('success')
        setNome('')
        setTelefone('')
        setEmail('')
      } catch {
        // API not available — save to localStorage as MVP fallback
        saveToLocalStorage(data)
        setSubmittedName(data.nome.split(' ')[0])
        setSubmittedContact(data.email || data.telefone)
        setFormState('success')
        setNome('')
        setTelefone('')
        setEmail('')
      }
    },
    [nome, telefone, email]
  )

  function handleClose() {
    setFormState('idle')
    setErrors({})
    setApiError('')
    onClose()
  }

  return (
    <Modal open={open} onClose={handleClose} labelledBy="leadTitle">
      <button
        type="button"
        className="modal-close"
        onClick={handleClose}
        aria-label="Fechar"
      >
        &times;
      </button>

      {formState === 'success' ? (
        <div>
          <span className="modal-emoji modal-emoji-success" aria-hidden="true">&#9989;</span>
          <h2>Recebemos seu interesse!</h2>
          <p className="modal-sub">
            Obrigado, <strong>{submittedName}</strong>. Em breve nossa equipe vai entrar em contato
            pelo <strong>{submittedContact}</strong> para ativar sua loja gratuita.
          </p>
          <Button size="lg" block onClick={handleClose}>
            Fechar
          </Button>
        </div>
      ) : (
        <div>
          <span className="modal-emoji" aria-hidden="true">&#127881;</span>
          <h2 id="leadTitle">Comece grátis agora</h2>
          <p className="modal-sub">
            Preencha seus dados e nossa equipe entra em contato para ativar sua loja digital.
          </p>

          <form onSubmit={handleSubmit} noValidate>
            <div className={`field ${errors.nome ? 'invalid' : ''}`}>
              <label htmlFor="leadNome">Nome</label>
              <input
                type="text"
                id="leadNome"
                name="nome"
                autoComplete="name"
                placeholder="Seu nome completo"
                required
                value={nome}
                onChange={(e) => setNome(e.target.value)}
                onBlur={() => handleBlur('nome', nome)}
                onInput={() => handleInput('nome', nome)}
              />
              <span className="field-error">{errors.nome}</span>
            </div>

            <div className={`field ${errors.telefone ? 'invalid' : ''}`}>
              <label htmlFor="leadTelefone">Telefone / WhatsApp</label>
              <input
                type="tel"
                id="leadTelefone"
                name="telefone"
                autoComplete="tel"
                inputMode="tel"
                placeholder="(11) 99999-9999"
                required
                value={telefone}
                onChange={(e) => handlePhoneChange(e.target.value)}
                onBlur={() => handleBlur('telefone', telefone)}
                onInput={() => handleInput('telefone', telefone)}
              />
              <span className="field-error">{errors.telefone}</span>
            </div>

            <div className={`field ${errors.email ? 'invalid' : ''}`}>
              <label htmlFor="leadEmail">E-mail</label>
              <input
                type="email"
                id="leadEmail"
                name="email"
                autoComplete="email"
                placeholder="Seu e-mail"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onBlur={() => handleBlur('email', email)}
                onInput={() => handleInput('email', email)}
              />
              <span className="field-error">{errors.email}</span>
            </div>

            {apiError && (
              <p style={{ color: 'var(--error)', fontSize: '14px', marginBottom: '12px' }}>
                {apiError}
              </p>
            )}

            <Button
              type="submit"
              size="lg"
              block
              disabled={formState === 'loading'}
            >
              {formState === 'loading' ? 'Enviando...' : 'Quero experimentar grátis'}
              {formState !== 'loading' && (
                <span className="btn-arrow" aria-hidden="true">&#8594;</span>
              )}
            </Button>

            <p className="modal-note">
              Sem cartão de crédito &#183; Sem compromisso &#183; Seus dados estão seguros com a gente.
            </p>
          </form>
        </div>
      )}
    </Modal>
  )
}
