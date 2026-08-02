import { ipcMain } from 'electron'

export const VERSION = '0.2.0'

export interface IpcHandlers {
  'picoaide:version': () => string
}

export function buildHandlers(): IpcHandlers {
  return {
    'picoaide:version': () => VERSION,
  }
}

// registerIpcHandlers wires all handlers onto ipcMain.
export function registerIpcHandlers(handlers: IpcHandlers = buildHandlers()): void {
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, fn)
  }
}
