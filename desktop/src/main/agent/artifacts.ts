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
