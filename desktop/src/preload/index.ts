import { contextBridge, ipcRenderer } from 'electron'

const api = {
  version: () => ipcRenderer.invoke('picoaide:version'),
}

contextBridge.exposeInMainWorld('picoaide', api)

export type PicoaideAPI = typeof api
