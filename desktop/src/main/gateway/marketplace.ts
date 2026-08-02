import { ApiError, AuthError, fetchJSON, gatewayFetch } from './auth'
import type { Session } from './config'

export class MarketplaceError extends Error {
  constructor(
    public kind: 'not_found' | 'rate_limited' | 'auth_expired' | 'network' | 'server_error',
    message?: string,
  ) {
    super(message ?? kind)
    this.name = 'MarketplaceError'
  }
}

export interface Skill {
  name: string
  version: string
  description: string
}

export interface MaskedMcp {
  id: number
  name: string
  description: string
  recommended: boolean
}

export interface McpConfig {
  id: number
  name: string
  description: string
  transport: string
  command: string
  args: string[]
  url: string
  env: Record<string, string>
  headers: Record<string, string>
}

function wrapError(e: unknown): MarketplaceError {
  if (e instanceof AuthError) return new MarketplaceError(e.kind === 'network' ? 'network' : 'auth_expired', e.message)
  if (e instanceof ApiError) {
    if (e.code === 'NOT_FOUND') return new MarketplaceError('not_found', e.message)
    if (e.code === 'RATE_LIMITED') return new MarketplaceError('rate_limited', e.message)
    return new MarketplaceError('server_error', e.message)
  }
  return new MarketplaceError('server_error', e instanceof Error ? e.message : 'marketplace error')
}

export async function listSkills(session: Session): Promise<Skill[]> {
  try {
    const data = await fetchJSON(session.serverURL, '/api/marketplace/skills', { token: session.token })
    return (data.skills ?? []) as Skill[]
  } catch (e) {
    throw wrapError(e)
  }
}

export async function downloadArchive(session: Session, name: string): Promise<{ buffer: Buffer; version: string }> {
  let res: Response
  try {
    res = await gatewayFetch(`${session.serverURL}/api/marketplace/skills/${encodeURIComponent(name)}/archive`, {
      headers: { Authorization: `Bearer ${session.token}` },
    })
  } catch {
    throw new MarketplaceError('network')
  }
  if (res.status === 401) throw new MarketplaceError('auth_expired')
  if (res.status === 404) throw new MarketplaceError('not_found')
  if (res.status === 429) throw new MarketplaceError('rate_limited')
  if (!res.ok) throw new MarketplaceError('server_error', `HTTP ${res.status}`)
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('gzip')) {
    throw new MarketplaceError('server_error', `unexpected content-type ${contentType}`)
  }
  const version = res.headers.get('x-skill-version')
  if (!version) throw new MarketplaceError('server_error', 'missing X-Skill-Version header')
  return { buffer: Buffer.from(await res.arrayBuffer()), version }
}

export async function listMcp(session: Session): Promise<MaskedMcp[]> {
  try {
    const data = await fetchJSON(session.serverURL, '/api/marketplace/mcp', { token: session.token })
    return (data.mcp ?? []) as MaskedMcp[]
  } catch (e) {
    throw wrapError(e)
  }
}

export async function getMcpConfig(session: Session, id: number): Promise<McpConfig> {
  try {
    const data = await fetchJSON(session.serverURL, `/api/marketplace/mcp/${id}/config`, { token: session.token })
    return data.config as McpConfig
  } catch (e) {
    throw wrapError(e)
  }
}
