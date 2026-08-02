import type { PicoaideAPI } from '../../preload'
import type { PluginIpcAPI } from '../../main/plugin_ipc'

// preload 尚未暴露插件通道(3.11/3.12 的接线方在 ipc.ts/preload 中补);
// 此处按 buildPluginHandlers 的通道契约定义期望形状,接线完成后可移除 cast。
export type FullApi = PicoaideAPI & PluginIpcAPI & { cdpStatus: () => Promise<{ running: boolean; port: number }> }

export function pluginApi(): FullApi {
  return window.picoaide as unknown as FullApi
}
