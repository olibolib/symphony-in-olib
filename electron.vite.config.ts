import { defineConfig } from 'electron-vite';
import { resolve } from 'node:path';

// electron-vite builds three separate bundles, because an Electron app is really three
// programs: the main process (Node), the preload script (a bridge), and the renderer
// (the web page). The default template puts these under src/main, src/preload and
// src/renderer; we point them at the layout agreed in DESIGN.md §15 instead.
export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/main.ts') },
      outDir: 'out/main',
    },
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, 'electron/preload.ts') },
      outDir: 'out/preload',
    },
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: { input: resolve(__dirname, 'index.html') },
    },
  },
});
