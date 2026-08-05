import { fetchJSON } from './auth'
import type { BootstrapConfig, Session } from './config'

export const EMPTY: BootstrapConfig = { default_model: '', models: [], skills: [], mcp: [], web: { allow_private: false, search_endpoint: '' } }

export function validateBootstrap(cfg: BootstrapConfig | null | undefined): { config: BootstrapConfig; fellBack: boolean } {
  // 垃圾兜底:null / {} / models 缺失或空 → 统一回退空结构。此前 {} 这类 truthy 垃圾会
  // 原样进入缓存,createModel 的 models.find 直接 TypeError,聊天入口报错
  if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.models) || cfg.models.length === 0) {
    return { config: EMPTY, fellBack: true }
  }
  if (cfg.models.some((m) => m.id === cfg.default_model)) {
    return { config: cfg, fellBack: false }
  }
  return { config: { ...cfg, default_model: cfg.models[0].id }, fellBack: true }
}

export async function getBootstrap(session: Session): Promise<{ config: BootstrapConfig; fellBack: boolean }> {
  const data = (await fetchJSON(session.serverURL, '/api/config/bootstrap', { token: session.token })) as BootstrapConfig
  return validateBootstrap(data)
}
