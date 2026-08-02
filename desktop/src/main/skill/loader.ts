import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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

export interface LoadedSkill {
  instruction: string
  meta: SkillMeta
  entrypoint: string
}

const DEFAULT_ENTRYPOINT = 'scripts/run.sh'

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

const SEMVER_RE = /^\d+\.\d+\.\d+/

// 读取已安装技能:SKILL.md 为指令正文(注入系统提示用),metadata.yaml 校验元信息。
// 技能包自带 tools/ 目录本期忽略(二期再注册)。
export function load(skillsDir: string, name: string): LoadedSkill {
  if (!isSafeSegment(name)) throw new SkillLoadError(`技能名称不合法: ${name}`)
  const dir = join(skillsDir, name)
  let instruction: string
  try {
    instruction = readFileSync(join(dir, 'SKILL.md'), 'utf8')
  } catch {
    throw new SkillLoadError(`技能 ${name} 缺少 SKILL.md`)
  }
  let metaRaw: string
  try {
    metaRaw = readFileSync(join(dir, 'metadata.yaml'), 'utf8')
  } catch {
    throw new SkillLoadError(`技能 ${name} 缺少 metadata.yaml`)
  }
  const meta = parseMetadataYaml(metaRaw)
  if (!meta.name || !isSafeSegment(meta.name)) throw new SkillLoadError(`技能 ${name} 元数据 name 不合法`)
  if (!meta.version || !SEMVER_RE.test(meta.version)) throw new SkillLoadError(`技能 ${name} 元数据版本不合法: ${meta.version ?? '空'}`)
  const entrypoint = meta.entrypoint?.trim() || DEFAULT_ENTRYPOINT
  if (!entrypoint.split('/').every(isSafeSegment)) {
    throw new SkillLoadError(`技能 ${name} entrypoint 不合法: ${entrypoint}`)
  }
  return {
    instruction,
    entrypoint,
    meta: {
      name: meta.name,
      version: meta.version,
      author: meta.author ?? '',
      description: meta.description ?? '',
      dependencies: Array.isArray(meta.dependencies) ? meta.dependencies : [],
      entrypoint,
    },
  }
}
