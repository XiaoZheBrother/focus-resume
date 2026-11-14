import { contextBridge, ipcRenderer } from 'electron'
import type { Bridge } from './shared/bridge'

const bridge: Bridge = {
  state: () => ipcRenderer.invoke('focus:state'),
  command: command => ipcRenderer.invoke('focus:command', command),
  stageImport: () => ipcRenderer.invoke('focus:stageImport'),
  finishImport: ticket => ipcRenderer.invoke('focus:finishImport', ticket),
  cancelImport: () => ipcRenderer.invoke('focus:cancelImport'),
  document: id => ipcRenderer.invoke('focus:document', id),
  backup: () => ipcRenderer.invoke('focus:backup'),
  restore: () => ipcRenderer.invoke('focus:restore'),
  clear: () => ipcRenderer.invoke('focus:clear'),
  secret: value => ipcRenderer.invoke('focus:secret', value),
  ai: draft => ipcRenderer.invoke('focus:ai', draft),
  copy: value => ipcRenderer.invoke('focus:copy', value),
  checkUpdate: () => ipcRenderer.invoke('focus:checkUpdate'),
  cancelAi: () => ipcRenderer.invoke('focus:cancelAi'),
  adoptAi: (id, index, edit) => ipcRenderer.invoke('focus:adoptAi', id, index, edit),
  desktop: action => ipcRenderer.invoke('focus:desktop', action),
  version: () => ipcRenderer.invoke('focus:version'),
  onState: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: Parameters<typeof listener>[0]) => listener(value)
    ipcRenderer.on('focus:changed', handler)
    return () => ipcRenderer.removeListener('focus:changed', handler)
  },
  onNotice: listener => {
    const handler = (_event: Electron.IpcRendererEvent, value: string) => listener(value)
    ipcRenderer.on('focus:notice', handler)
    return () => ipcRenderer.removeListener('focus:notice', handler)
  }
}
contextBridge.exposeInMainWorld('focusResume', bridge)
