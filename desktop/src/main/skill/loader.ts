export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillLoadError'
  }
}

// 与服务端 util.SafePathSegment 同语义:非空、非 . / .. 、不含路径分隔符
export function isSafeSegment(name: string): boolean {
  if (!name || name === '.' || name === '..') return false
  if (name.includes('/') || name.includes('\\')) return false
  return true
}

export interface SkillMeta {
  name: string
  version: string
  author: string
  description: string
  dependencies: string[]
  entrypoint: string
}

// 极简 YAML 子集解析:扁平 key: value + 缩进数组(- item);metadata.yaml 只用这些,
// 不值得引入 yaml 依赖(ponytail: 需嵌套/多行字符串时再换正经解析器)
export function parseMetadataYaml(raw: string): Partial<SkillMeta> {
  const out: Record<string, unknown> = {}
  let currentKey: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    if (trimmed.startsWith('- ')) {
      if (currentKey) {
        const list = Array.isArray(out[currentKey]) ? (out[currentKey] as string[]) : []
        list.push(trimmed.slice(2).trim())
        out[currentKey] = list
      }
      continue
    }
    const idx = trimmed.indexOf(':')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    const value = trimmed.slice(idx + 1).trim()
    currentKey = key
    out[key] = value
  }
  return out as Partial<SkillMeta>
}

