import { contextBridge, ipcRenderer } from 'electron';
import { COMMAND_CHANNEL, EVENT_CHANNEL, PCM_CHANNEL } from '../src/ipc/protocol';
import type { ControlCommand, EngineEvent } from '../src/ipc/protocol';

// A preload script runs in the renderer, but with access to Node. It exists so the web page
// itself can stay sandboxed: anything the page needs from the system gets handed over
// through an explicit, narrow API rather than the page having Node access directly.
//
// Both windows share this preload. Each uses the half it needs — the engine sends events and
// receives commands, the control window does the reverse.
const api = {
  stage: { width: 1280, height: 720 },

  /** Control window to engine. */
  sendCommand(command: ControlCommand): void {
    ipcRenderer.send(COMMAND_CHANNEL, command);
  },

  onCommand(handler: (command: ControlCommand) => void): void {
    ipcRenderer.on(COMMAND_CHANNEL, (_event, command: ControlCommand) => handler(command));
  },

  /** Engine to control window. */
  sendEvent(message: EngineEvent): void {
    ipcRenderer.send(EVENT_CHANNEL, message);
  },

  onEvent(handler: (message: EngineEvent) => void): void {
    ipcRenderer.on(EVENT_CHANNEL, (_event, message: EngineEvent) => handler(message));
  },

  /** Quits the app — the canvas window closing takes everything with it. */
  close(): void {
    ipcRenderer.send('olib:close');
  },

  showControl(): void {
    ipcRenderer.send('olib:show-control');
  },

  setAlwaysOnTop(value: boolean): void {
    ipcRenderer.send('olib:always-on-top', value);
  },

  /**
   * Per-application audio capture. Windows process loopback via a helper executable — works
   * whatever output device the application is using, and cannot pick up anything else.
   */
  apps: {
    list: (): Promise<{ processId: string; title: string }[]> =>
      ipcRenderer.invoke('olib:apps-list'),
    start: (processId: string): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('olib:app-capture-start', processId),
    stop: (): void => ipcRenderer.send('olib:app-capture-stop'),
    onPcm: (handler: (chunk: ArrayBuffer) => void): void => {
      ipcRenderer.on(PCM_CHANNEL, (_event, chunk: ArrayBuffer) => handler(chunk));
    },
  },

  /** The canvas window is frameless, so its placement is set rather than dragged. */
  output: {
    bounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
      ipcRenderer.invoke('olib:output-bounds'),
    setBounds: (b: { x: number; y: number; width: number; height: number }): void =>
      ipcRenderer.send('olib:set-output-bounds', b),
    centre: (): void => ipcRenderer.send('olib:centre-output'),
  },

  /**
   * Text files, stored in a writable app-data folder so they can be edited without
   * rebuilding. Used by the control window, which owns editing.
   */
  texts: {
    list: (): Promise<string[]> => ipcRenderer.invoke('olib:texts-list'),
    read: (name: string): Promise<string> => ipcRenderer.invoke('olib:text-read', name),
    write: (name: string, content: string): Promise<void> =>
      ipcRenderer.invoke('olib:text-write', name, content),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('olib:text-delete', name),
    import: (): Promise<string | null> => ipcRenderer.invoke('olib:text-import'),
  },

  /** Preset documents, one JSON file each, beside the texts (§11.4). */
  presets: {
    list: (): Promise<string[]> => ipcRenderer.invoke('olib:presets-list'),
    read: (name: string): Promise<string> => ipcRenderer.invoke('olib:preset-read', name),
    write: (name: string, content: string): Promise<void> =>
      ipcRenderer.invoke('olib:preset-write', name, content),
    remove: (name: string): Promise<void> => ipcRenderer.invoke('olib:preset-delete', name),
  },
} as const;

export type OlibApi = typeof api;

contextBridge.exposeInMainWorld('olib', api);
