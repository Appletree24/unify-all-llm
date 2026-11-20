import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Bridge, Method, Push } from './shared/api.js';

// The renderer is sandboxed and gets exactly two capabilities: call a named
// main-process method and listen for pushed workflow updates.
const bridge: Bridge = {
  invoke: (method: Method, ...args: unknown[]) => ipcRenderer.invoke('unify', method, ...args),
  onPush(listener) {
    const handler = (_event: IpcRendererEvent, push: Push) => listener(push);
    ipcRenderer.on('unify:push', handler);
    return () => { ipcRenderer.removeListener('unify:push', handler); };
  },
};

contextBridge.exposeInMainWorld('unifyBridge', bridge);
