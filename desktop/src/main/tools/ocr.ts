import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Worker } from 'tesseract.js'
import { loadElectronModule } from '../util/electron'

export const OCR_LANG_MISSING_MSG = 'OCR 语言包未安装(resources/tessdata 缺失,打包时添加)'

// 识别超时兜底:大图/异常引擎可能挂起 recognize,不能无限等
export const OCR_TIMEOUT_MS = 60_000

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

// 挂起兜底:识别超时/worker 失败不得永久拒绝后续调用
function raceWithTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => reject(new Error(msg)), ms)
      t.unref?.()
    }),
  ])
}

export async function ocrImage(pngBase64: string, timeoutMs: number = OCR_TIMEOUT_MS): Promise<string> {
  const dir = await resolveTessdataDir()
  if (!dir) throw new Error(OCR_LANG_MISSING_MSG)
  try {
    const worker = await raceWithTimeout(getWorker(dir), timeoutMs, '加载语言包超时')
    const { data } = await raceWithTimeout(worker.recognize(Buffer.from(pngBase64, 'base64')), timeoutMs, '识别超时')
    return data.text.trim()
  } catch (err) {
    // 失败重置:worker 创建/识别偶发失败时丢弃单例,下次调用重新创建(首败不再永久拒绝)
    workerPromise = null
    throw new Error(`OCR 不可用: ${err instanceof Error ? err.message : String(err)}`)
  }
}
