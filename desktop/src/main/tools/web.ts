import { isIPv6 } from 'node:net'
import { lookup } from 'node:dns/promises'
import { z } from 'zod'
import type { Tool } from 'ai'

const DEFAULT_MAX_BYTES = 5 * 1024 * 1024
const DEFAULT_TIMEOUT_SEC = 15

// SSRF 防护:默认拒绝 loopback/私有/链路本地/ULA 网段(架构设计 §3.4)。
// pragmatism: 不用 node:net BlockList——其 check() 对 IPv6 一律返回 false(实测
// Node 24),这里手写网段判定;主机名另做 DNS 查询后逐个地址判定(assertPublicHost)。

function parseIPv4(h: string): number[] | null {
  const parts = h.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map(Number)
  if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return null
  return octets
}

function isPrivateIPv4([a, b]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return true // 0.0.0.0/8, 10/8, 127/8
  if (a === 169 && b === 254) return true // 169.254/16 link-local
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  return false
}

function parseIPv6(h: string): bigint | null {
  // 带点分四段的 IPv6(如 ::ffff:a.b.c.d)由 isPrivateHost 前置处理,这里不支持
  if (h.includes('.')) return null
  let groups: string[]
  const double = h.indexOf('::')
  if (double !== -1) {
    const left = h.slice(0, double).split(':').filter(Boolean)
    const right = h.slice(double + 2).split(':').filter(Boolean)
    const fill = 8 - left.length - right.length
    if (fill < 1) return null
    groups = [...left, ...Array(fill).fill('0'), ...right]
  } else {
    groups = h.split(':')
  }
  if (groups.length !== 8) return null
  let n = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null
    n = (n << 16n) | BigInt(parseInt(g, 16))
  }
  return n
}

function isPrivateIPv6(n: bigint): boolean {
  if (n === 0n || n === 1n) return true // :: 与 ::1
  if (n >> 120n === 0xfdn) return true // fd00::/8 ULA
  if (n >> 118n === 0x3fan) return true // fe80::/10 link-local
  // ::ffff:a.b.c.d IPv4-mapped:前 80 位全零 + 第 5-6 组 0xffff,按 IPv4 判定。
  // 注意高位检查是 >> 80n(前 80 位为零),不是 >> 48n:
  // 0xffff7f000001(::ffff:127.0.0.1)>> 48n 非零会漏判,直连回环。
  if (n >> 80n === 0n && ((n >> 64n) & 0xffffn) === 0xffffn) {
    const v4 = Number(n & 0xffffffffn)
    return isPrivateIPv4([(v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff])
  }
  return false
}

export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost') return true
  // IPv4-mapped / IPv4-compatible 带点形式(::ffff:a.b.c.d、::127.0.0.1):
  // 尾段按 IPv4 判定,parseIPv6 无法解析含点串
  if (h.includes('.')) {
    const tail = h.split(':').pop() ?? ''
    const v4 = parseIPv4(tail)
    if (v4) return isPrivateIPv4(v4)
  }
  const v4 = parseIPv4(h)
  if (v4) return isPrivateIPv4(v4)
  if (!isIPv6(h)) return false
  const n = parseIPv6(h)
  return n !== null && isPrivateIPv6(n)
}

export interface WebFetchOptions {
  maxBytes?: number
  timeoutSec?: number
  allowPrivate?: boolean
}

export async function webFetch(url: string, opts: WebFetchOptions = {}): Promise<string> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutSec = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error('URL 无效')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议')
  }
  if (!opts.allowPrivate) await assertPublicHost(u.hostname)

  // 重定向逐跳 SSRF 校验:fetch 自动跟随会把公网站点 302 到 127.0.0.1/内网,
  // 初始 URL 校验形同虚设 → manual 模式每跳重新校验(最多 5 跳)
  let current = u
  for (let hop = 0; hop < 5; hop++) {
    if (!opts.allowPrivate) await assertPublicHost(current.hostname)
    const res = await fetch(current.toString(), {
      signal: AbortSignal.timeout(timeoutSec * 1000),
      redirect: 'manual',
    })
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error(`重定向缺少 Location: HTTP ${res.status}`)
      current = new URL(loc, current)
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!res.body) return ''
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('页面超过大小限制')
      chunks.push(value)
    }
    return htmlToText(Buffer.concat(chunks).toString('utf8'))
  }
  throw new Error('重定向次数过多')
}

// pragmatism: 字面 IP/localhost 直接判定;主机名做一次 DNS 查询,任一解析地址落在
// 私有网段即拒绝(有内网地址即存在 SSRF 面,不赌取巧)。DNS 失败视为不可验证,直接抛错。
async function assertPublicHost(hostname: string): Promise<void> {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (isPrivateHost(h)) throw new Error('SSRF 防护:拒绝访问内网地址')
  if (isIPv6(h) || parseIPv4(h)) return
  const addrs = await lookup(h, { all: true })
  if (addrs.some((a) => isPrivateHost(a.address))) {
    throw new Error('SSRF 防护:拒绝访问内网地址')
  }
}

function htmlToText(html: string): string {
  const noBlocks = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
  return noBlocks
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function webSearch(
  query: string,
  searchEndpoint: string,
): Promise<{ title: string; url: string; snippet: string }[]> {
  if (!searchEndpoint) throw new Error('web_search 未配置')
  const res = await fetch(searchURL(searchEndpoint, query), {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_SEC * 1000),
  })
  if (!res.ok) throw new Error(`搜索失败: HTTP ${res.status}`)
  let data: unknown
  try {
    data = await res.json()
  } catch {
    return []
  }
  return parseResults(data)
}

// pragmatism: 端点若自带 ?q= 模板(如 ?q= 直接拼),直接续拼编码后的 query;
// 否则按有无已有 query 决定 ?q= 或 &q=。
function searchURL(endpoint: string, query: string): string {
  const q = encodeURIComponent(query)
  if (endpoint.includes('?q=')) return `${endpoint}${q}`
  return `${endpoint}${endpoint.includes('?') ? '&' : '?'}q=${q}`
}

function parseResults(data: unknown): { title: string; url: string; snippet: string }[] {
  let list: unknown[]
  if (Array.isArray(data)) {
    list = data
  } else if (data !== null && typeof data === 'object') {
    const rec = data as Record<string, unknown>
    if (Array.isArray(rec.results)) list = rec.results
    else if (Array.isArray(rec.items)) list = rec.items
    else return []
  } else {
    return []
  }
  const out: { title: string; url: string; snippet: string }[] = []
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue
    const rec = item as Record<string, unknown>
    const title = typeof rec.title === 'string' ? rec.title : ''
    const url = typeof rec.url === 'string' ? rec.url : typeof rec.link === 'string' ? rec.link : ''
    const snippet = typeof rec.snippet === 'string' ? rec.snippet : ''
    if (title || url) out.push({ title, url, snippet })
  }
  return out
}

// 非高危工具:外发目标为显式 URL(用户可见 tool_start 输入),无需审批门控
export function createWebTools(cfg: { allowPrivate: boolean; searchEndpoint: string }): Record<string, Tool> {
  return {
    web_fetch: {
      description: '抓取网页内容并转为纯文本(仅 http/https,拒绝内网地址)',
      inputSchema: z.object({ url: z.string().url(), max_bytes: z.number().optional() }),
      execute: async (input: { url: string; max_bytes?: number }) =>
        webFetch(input.url, { maxBytes: input.max_bytes, allowPrivate: cfg.allowPrivate }),
    },
    web_search: {
      description: '搜索网页,返回标题/链接/摘要列表(使用管理员配置的搜索端点)',
      inputSchema: z.object({ query: z.string() }),
      execute: async (input: { query: string }) => webSearch(input.query, cfg.searchEndpoint),
    },
  }
}
