import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Worker } from 'tesseract.js'
import { loadElectronModule } from '../util/electron'

export const OCR_LANG_MISSING_MSG = 'OCR 语言包未安装(resources/tessdata 缺失,打包时添加)'

let workerPromise: Promise<Worker> | null = null

// 语言包目录:desktop/resources/tessdata(4.1 打包,asarUnpack);不存在则返回 null → ocrImage 报清晰错误,截图工具不受影响
export async function resolveTessdataDir(): Promise<string | null> {
  const electron = await loadElectronModule()
  const app = electron.app as { getAppPath(): string } | undefined
  if (!app) return null
  const dir = join(app.getAppPath(), 'resources', 'tessdata')
  return existsSync(dir) ? dir : null
}

function getWorker(dir: string): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then(({ createWorker }) => createWorker(['chi_sim', 'eng'], 1, { langPath: dir }))
  }
  return workerPromise
}

export async function ocrImage(pngBase64: string): Promise<string> {
  const dir = await resolveTessdataDir()
  if (!dir) throw new Error(OCR_LANG_MISSING_MSG)
  try {
    const worker = await getWorker(dir)
    const { data } = await worker.recognize(Buffer.from(pngBase64, 'base64'))
    return data.text.trim()
  } catch (err) {
    throw new Error(`OCR 不可用: ${err instanceof Error ? err.message : String(err)}`)
  }
}
