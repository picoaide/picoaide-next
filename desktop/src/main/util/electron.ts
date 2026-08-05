// Electron 惰性加载(main 进程专用):先动态 import(打包后 CJS 下等价 require,且 vitest
// 可经 vi.mock('electron') 拦截),失败再回退 require。仅当顶层模块不持有所需 API 时
// 才尝试 ESM 互操作命名空间的 default。探测一律用 Object.keys 成员判定(vitest 的
// electron mock 对未定义导出直接访问会抛错)。调用方各自做特性检查(safeStorage/
// session/app 等);不可用返回 {}。
export async function loadElectronModule(): Promise<Record<string, any>> {
  let mod: any = null
  try {
    mod = await import('electron')
  } catch {
    mod = null
  }
  if (!mod && typeof require === 'function') {
    try {
      mod = require('electron')
    } catch {
      mod = null
    }
  }
  if (!mod) return {}
  const hasApis = (m: any): boolean => {
    if (!m || typeof m !== 'object') return false
    const keys = Object.keys(m)
    const names = ['safeStorage', 'session', 'app', 'desktopCapturer', 'clipboard']
    return names.some((k) => keys.includes(k) && Boolean(m[k]))
  }
  if (hasApis(mod)) return mod
  try {
    const d = mod?.default
    return d && hasApis(d) ? d : mod
  } catch {
    return mod
  }
}
