export function isEmailValid(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim())
}

export function isPhoneValid(value: string): boolean {
  const digits = value.replace(/\D/g, '')
  return digits.length >= 10 && digits.length <= 11
}

export function isNameValid(value: string): boolean {
  return value.trim().length >= 2
}

export type FieldErrors = {
  nome?: string
  telefone?: string
  email?: string
}

export function validateLeadForm(data: {
  nome: string
  telefone: string
  email: string
}): FieldErrors {
  const errors: FieldErrors = {}

  if (!isNameValid(data.nome)) {
    errors.nome = 'Nome deve ter pelo menos 2 caracteres'
  }

  if (!isPhoneValid(data.telefone)) {
    errors.telefone = 'Informe um telefone válido (10 ou 11 dígitos)'
  }

  if (!isEmailValid(data.email)) {
    errors.email = 'Informe um e-mail válido'
  }

  return errors
}
