import { getApiBaseUrl } from './admin-api'

export interface CreatedStoreResponse {
  storeId: number
  slug: string
  publicUrl: string
  adminUrl: string
  adminUsername: string
  temporaryPassword: string
  createdAt: string
  /** false quando a loja não foi localizada no mapa (entrega desativada). */
  acceptingOrders?: boolean
  /** Aviso a exibir na confirmação (ex.: endereço não localizado). */
  deliveryWarning?: string | null
}

function isCreatedStoreResponse(value: unknown): value is CreatedStoreResponse {
  if (typeof value !== 'object' || value === null) return false
  const result = value as Record<string, unknown>
  return typeof result.storeId === 'number'
    && typeof result.slug === 'string'
    && typeof result.publicUrl === 'string'
    && typeof result.adminUrl === 'string'
    && typeof result.adminUsername === 'string'
    && typeof result.temporaryPassword === 'string'
    && typeof result.createdAt === 'string'
}

export async function createStore(formData: FormData): Promise<CreatedStoreResponse> {
  let response: Response
  try {
    response = await fetch(`${getApiBaseUrl()}/api/lojas/criar-completa`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: formData,
      cache: 'no-store',
    })
  } catch {
    throw new Error('Não foi possível conectar à API. Verifique se a aplicação está iniciada.')
  }

  if (!response.ok) {
    let message = `Não foi possível criar a loja (${response.status}).`
    try {
      const body: unknown = await response.json()
      if (typeof body === 'object' && body !== null) {
        const errorBody = body as Record<string, unknown>
        if (typeof errorBody.error === 'string') {
          message = errorBody.error
        } else if (typeof errorBody.errors === 'object' && errorBody.errors !== null) {
          const details = Object.values(errorBody.errors as Record<string, unknown>)
            .flatMap((v) => Array.isArray(v) ? v : [v])
            .filter((v): v is string => typeof v === 'string')
          message = details.length > 0 ? details.join(' ') : (typeof errorBody.title === 'string' ? errorBody.title : message)
        } else if (typeof errorBody.title === 'string') {
          message = errorBody.title
        }
      }
    } catch {
      // Algumas respostas de proxy podem não ter corpo JSON.
    }
    throw new Error(message)
  }

  const body: unknown = await response.json()
  if (!isCreatedStoreResponse(body)) {
    throw new Error('A API retornou uma resposta de criação inválida.')
  }
  return body
}
