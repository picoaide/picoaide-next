import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 产物类型按扩展名推断(架构设计 §3.5 artifacts.type)
export function artifactType(path: string): string {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  switch (ext) {
    case 'md':
      return 'report'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'gif':
    case 'webp':
      return 'image'
    case 'html':
    case 'htm':
      return 'html'
    case 'pptx':
      return 'ppt'
    case 'docx':
      return 'docx'
    case 'xlsx':
      return 'xlsx'
    default:
      return 'file'
  }
}

// 每会话独立工作目录 workspaces/<conv-id>/(架构设计 §3.4 可访问目录模型),幂等创建
export function createWorkspaceDir(workspacesRoot: string, conversationId: number): string {
  const dir = join(workspacesRoot, String(conversationId))
  mkdirSync(dir, { recursive: true })
  return dir
}
