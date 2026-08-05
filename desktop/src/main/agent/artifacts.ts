import fs from 'node:fs'
import path from 'node:path'

// 大文本工具结果落盘阈值(字符):超过则写文件,上下文只放短引用+摘要,防上下文爆炸/DB 膨胀
export const TOOL_OUTPUT_SPILL_THRESHOLD = 6000
// 落盘引用的摘要长度(取 value 前 N 字符)
export const TOOL_OUTPUT_SUMMARY_LENGTH = 400

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

// 大文本工具结果落盘:<workspace>/tool-outputs/<toolCallId>.txt(目录 mkdir -p,同
// toolCallId 重试覆盖;toolCallId 含路径分隔符替换为 _ 防目录穿越)。返回落盘路径与摘要。
export function spillToolOutput(workspace: string, toolCallId: string, value: string): { path: string; summary: string } {
  const dir = path.join(workspace, 'tool-outputs')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${toolCallId.replace(/[/\\]/g, '_')}.txt`)
  fs.writeFileSync(file, value)
  return { path: file, summary: value.slice(0, TOOL_OUTPUT_SUMMARY_LENGTH) }
}
