import { fetchJSON } from './auth'
import type { Session } from './config'

export class KbError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'KbError'
  }
}

const KB_PATH = '/api/mcp/knowledge/message'

let nextId = 1

function textOf(result: any): string {
  const content = result?.content
  const first = Array.isArray(content) ? content[0] : undefined
  if (first?.text !== undefined) return String(first.text)
  return JSON.stringify(result)
}

async function rpc(session: Session, method: string, params: Record<string, unknown>): Promise<any> {
  const data = await fetchJSON(session.serverURL, KB_PATH, {
    token: session.token,
    method: 'POST',
    body: { jsonrpc: '2.0', id: nextId++, method, params },
  })
  if (data?.error) throw new KbError(data.error.message ?? 'json-rpc error')
  const result = data?.result
  if (result === undefined) throw new KbError('网关响应缺少 result')
  if (result?.isError) throw new KbError(textOf(result))
  return result
}

async function callTool(session: Session, name: string, args: Record<string, unknown>): Promise<string> {
  const result = await rpc(session, 'tools/call', { name, arguments: args })
  return textOf(result)
}

export function kbSearch(session: Session, query: string, page = 1, pageSize = 10): Promise<string> {
  return callTool(session, 'kb_search', { query, page, page_size: pageSize })
}

export function kbRead(session: Session, docId: number | string): Promise<string> {
  return callTool(session, 'kb_read', { doc_id: docId })
}

export function kbList(session: Session, folderId: number | string | null = null): Promise<string> {
  return callTool(session, 'kb_list', { folder_id: folderId })
}

export function kbUpload(session: Session, title: string, content: string, folderId: number | string | null = null): Promise<string> {
  return callTool(session, 'kb_upload', { title, content, folder_id: folderId })
}
