import { contextBridge, ipcRenderer } from 'electron';

// A preload script runs in the renderer, but with access to Node. It exists so the web page
// itself can stay sandboxed: anything the page needs from the system gets handed over
// through an explicit, narrow API rather than the page having Node access directly.
const api = {
  stage: { width: 1280, height: 720 },

  /** Hiding the HUD shrinks the window to just the stage. */
  setHudVisible(visible: boolean): void {
    ipcRenderer.send('olib:hud-visible', visible);
  },

  /** The window is frameless, so there is no system close button. */
  close(): void {
    ipcRenderer.send('olib:close');
  },

} as const;

export type OlibApi = typeof api;

contextBridge.exposeInMainWorld('olib', api);
