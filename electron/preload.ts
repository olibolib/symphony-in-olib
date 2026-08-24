import { contextBridge, ipcRenderer } from 'electron';

// A preload script runs in the renderer, but with access to Node. It exists so the web page
// itself can stay sandboxed: anything the page needs from the system gets handed over
// through an explicit, narrow API rather than the page having Node access directly.
const api = {
  stage: { width: 1280, height: 720 },


  /** The window is frameless, so there is no system close button. */
  close(): void {
    ipcRenderer.send('olib:close');
  },

  /**
   * Text files, stored in a writable app-data folder so they can be edited without
   * rebuilding. See DESIGN.md Q4.
   */
  texts: {
    list: (): Promise<string[]> => ipcRenderer.invoke('olib:texts-list'),
    read: (name: string): Promise<string> => ipcRenderer.invoke('olib:text-read', name),
    write: (name: string, content: string): Promise<void> =>
      ipcRenderer.invoke('olib:text-write', name, content),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('olib:text-delete', name),
    import: (): Promise<string | null> => ipcRenderer.invoke('olib:text-import'),
  },
} as const;

export type OlibApi = typeof api;

contextBridge.exposeInMainWorld('olib', api);
