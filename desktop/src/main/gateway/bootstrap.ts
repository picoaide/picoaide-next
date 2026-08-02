import { fetchJSON } from './auth'
import type { BootstrapConfig, Session } from './config'

export function validateBootstrap(cfg: BootstrapConfig): { config: BootstrapConfig; fellBack: boolean } {
  if (!cfg || !Array.isArray(cfg.models) || cfg.models.length === 0) {
    return { config: cfg, fellBack: true }
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
