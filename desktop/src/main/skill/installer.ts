import { gunzipSync } from 'node:zlib'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, normalize } from 'node:path'
import { parseMetadataYaml, isSafeSegment, type SkillMeta } from './loader'
import type { Session } from '../gateway/config'

export class SkillInstallError extends Error {
  constructor(
    public kind: 'network' | 'auth_expired' | 'not_found' | 'rate_limited' | 'server_error' | 'safety' | 'invalid_archive' | 'version_mismatch' | 'canceled',
    message: string,
  ) {
    super(message)
    this.name = 'SkillInstallError'
  }
}

export interface InstalledSkillRecord {
  version: string
  installedAt: string
}

export interface SkillStoreDeps {
  getSetting(key: string): string | null
  setSetting(key: string, value: string): void
  downloadArchive(session: Session, name: string): Promise<{ buffer: Buffer; version: string }>
}

export const SKILLS_SETTING_KEY = 'skills.installed'
const MAX_TAR_BYTES = 100 * 1024 * 1024

// 已安装列表存 settings(JSON: name → {version, installedAt})
export function listInstalledSkills(getSetting: (k: string) => string | null): Record<string, InstalledSkillRecord> {
  const raw = getSetting(SKILLS_SETTING_KEY)
  if (!raw) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    return parsed as Record<string, InstalledSkillRecord>
  } catch {
    return {}
  }
}

function saveInstalled(setSetting: (k: string, v: string) => void, list: Record<string, InstalledSkillRecord>): void {
  setSetting(SKILLS_SETTING_KEY, JSON.stringify(list))
}

function wrapMarketplaceError(e: unknown): SkillInstallError {
  const kind = (e as { kind?: string }).kind
  if (kind === 'network') return new SkillInstallError('network', '无法连接服务器')
  if (kind === 'auth_expired') return new SkillInstallError('auth_expired', '登录已过期')
  if (kind === 'not_found') return new SkillInstallError('not_found', '技能不存在或已下架')
  if (kind === 'rate_limited') return new SkillInstallError('rate_limited', '下载过于频繁,请稍后再试')
  if (kind === 'checksum_mismatch') return new SkillInstallError('server_error', '技能包校验失败(checksum 不匹配),已拒绝安装')
  return new SkillInstallError('server_error', e instanceof Error ? e.message : '下载失败')
}

// 仅下载并解析元数据(供安装前风险弹窗;不确认、不落盘)
export async function previewSkillMeta(session: Session, name: string, deps: SkillStoreDeps): Promise<SkillMeta> {
  if (!isSafeSegment(name)) throw new SkillInstallError('safety', `技能名称不合法: ${name}`)
  let archive: { buffer: Buffer; version: string }
  try {
    archive = await deps.downloadArchive(session, name)
  } catch (e) {
    throw wrapMarketplaceError(e)
  }
  const files = parseTarGz(archive.buffer)
  const metaRaw = files['metadata.yaml']
  if (!metaRaw) throw new SkillInstallError('invalid_archive', '技能包缺少 metadata.yaml')
  return validateMeta(metaRaw, name, archive.version)
}

function validateMeta(metaRaw: string | Buffer, name: string, version: string): SkillMeta {
  const meta = parseMetadataYaml(Buffer.isBuffer(metaRaw) ? metaRaw.toString('utf8') : metaRaw)
  if (meta.name !== name) throw new SkillInstallError('invalid_archive', `技能包元数据名称不匹配: ${meta.name}`)
  if (!meta.version) throw new SkillInstallError('invalid_archive', '技能包缺少版本号')
  if (meta.version !== version) {
    throw new SkillInstallError('version_mismatch', `技能版本不匹配(头 ${version} / 元数据 ${meta.version})`)
  }
  const entrypoint = meta.entrypoint?.trim() || 'scripts/run.sh'
  if (!entrypoint.split('/').every(isSafeSegment)) {
    throw new SkillInstallError('safety', `技能 entrypoint 不合法: ${entrypoint}`)
  }
  return {
    name: meta.name,
    version: meta.version,
    author: meta.author ?? '',
    description: meta.description ?? '',
    dependencies: Array.isArray(meta.dependencies) ? meta.dependencies : [],
    entrypoint,
  }
}

export interface InstallSkillInput {
  session: Session
  skillsDir: string
  name: string
  deps: SkillStoreDeps
  // 第三方技能首次安装的风险确认(展示作者/来源),resolve false → 中止
  onConfirm: (meta: SkillMeta) => Promise<boolean>
}

export async function installFromMarketplace(input: InstallSkillInput): Promise<InstalledSkillRecord> {
  const { session, skillsDir, name, deps } = input
  if (!isSafeSegment(name)) throw new SkillInstallError('safety', `技能名称不合法: ${name}`)
  let archive: { buffer: Buffer; version: string }
  try {
    archive = await deps.downloadArchive(session, name)
  } catch (e) {
    throw wrapMarketplaceError(e)
  }
  const files = parseTarGz(archive.buffer)
  const meta = validateMeta(files['metadata.yaml'] ?? '', name, archive.version)
  if (files['SKILL.md'] === undefined) throw new SkillInstallError('invalid_archive', '技能包缺少 SKILL.md')

  if (!(await input.onConfirm(meta))) {
    throw new SkillInstallError('canceled', '已取消安装')
  }

  const dest = join(skillsDir, name)
  const root = normalize(dest) + join('/')
  const targets: { abs: string; content: Buffer }[] = []
  for (const [rel, content] of Object.entries(files)) {
    const abs = normalize(join(dest, rel))
    if (!abs.startsWith(root)) throw new SkillInstallError('safety', `技能包条目超出技能根目录: ${rel}`)
    targets.push({ abs, content })
  }
  mkdirSync(dest, { recursive: true })
  for (const { abs, content } of targets) {
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, content)
  }

  const installed = listInstalledSkills(deps.getSetting)
  installed[name] = { version: meta.version, installedAt: new Date().toISOString() }
  saveInstalled(deps.setSetting, installed)
  return installed[name]
}

export function removeSkill(skillsDir: string, name: string, deps: { getSetting: (k: string) => string | null; setSetting: (k: string, v: string) => void }): void {
  if (!isSafeSegment(name)) throw new SkillInstallError('safety', `技能名称不合法: ${name}`)
  rmSync(join(skillsDir, name), { recursive: true, force: true })
  const installed = listInstalledSkills(deps.getSetting)
  delete installed[name]
  saveInstalled(deps.setSetting, installed)
}

// ---- 极简 tar 解析(512B 头 + 数据块;拒绝绝对路径/../ /符号链接/超限)----

interface TarEntry {
  name: string
  content: Buffer
}

function parseTarGz(buf: Buffer): Record<string, Buffer> {
  // ponytail: 先完整解压再校验;压缩炸弹(极稀疏大文件)在内存中膨胀一次才被拦截,
  // 真实防线在服务端 maxPackageSize;客户端另设解压后总长上限兜底
  const tar = gunzipSync(buf)
  if (tar.length > MAX_TAR_BYTES + 64 * 1024) throw new SkillInstallError('safety', '技能包解压后超过大小限制')
  const out: Record<string, Buffer> = {}
  let offset = 0
  let total = 0
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    offset += 512
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/, '')
    if (name === '') break // 零块结尾
    if (offset + 512 <= tar.length && header.subarray(257, 262).toString('utf8') !== 'ustar') {
      throw new SkillInstallError('invalid_archive', '技能包格式不合法')
    }
    const typeflag = String.fromCharCode(header[156] ?? 0)
    const size = parseOctal(header.subarray(124, 136))
    if (typeflag === '2' || typeflag === '3') {
      throw new SkillInstallError('safety', `技能包含链接条目,已拒绝: ${name}`)
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5' && typeflag !== '7') {
      throw new SkillInstallError('invalid_archive', `技能包含不支持的类型(flag ${typeflag.charCodeAt(0)})`)
    }
    checkEntryPath(name)
    total += size
    if (total > MAX_TAR_BYTES) throw new SkillInstallError('safety', '技能包超过 100MB 大小限制')
    const dataLen = Math.ceil(size / 512) * 512
    if (offset + dataLen > tar.length) throw new SkillInstallError('invalid_archive', `技能包数据不完整: ${name}`)
    if (typeflag === '0' || typeflag === '\0' || typeflag === '7') {
      out[name] = Buffer.from(tar.subarray(offset, offset + size))
    }
    offset += dataLen
  }
  return out
}

function parseOctal(b: Buffer): number {
  const s = b.toString('utf8').trim().replace(/\0.*$/, '')
  return parseInt(s, 8) || 0
}

function checkEntryPath(name: string): void {
  if (name === '') throw new SkillInstallError('safety', '技能包含空路径条目')
  if (name.startsWith('/')) throw new SkillInstallError('safety', `技能包含绝对路径: ${name}`)
  for (const part of name.split('/')) {
    if (part === '..' || part === '.') throw new SkillInstallError('safety', `技能包含越界路径: ${name}`)
  }
}
