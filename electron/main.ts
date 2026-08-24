import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Stage size — DESIGN.md §13.1. The window is sized to fit this at 1:1. */
const STAGE = { width: 1280, height: 720 } as const;

/**
 * Transparent band between the stage and the HUD, and the HUD itself.
 *
 * Keep in sync with --gap-h and --hud-h in style/base.css.
 *
 * The window height is the sum of all three and never changes. Hiding the HUD used to
 * resize the window, which moved the capture geometry under OBS — the gap plus a fixed
 * height means the crop is set once and never revisited, and the HUD can stay open through
 * a whole set without appearing in it.
 */
const GAP_HEIGHT = 30;
const HUD_HEIGHT = 260;

// DESIGN.md §5: the app has to keep rendering while the DJ software covers it. Chromium
// normally throttles or stops painting windows it thinks nobody can see — which in this
// app's whole use case is always. These three switches turn that off; `backgroundThrottling`
// below covers the same ground per-window, and we set both because the failure mode (a
// frozen visual on stream) is bad enough to be worth the belt and braces.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// Browsers refuse to start an AudioContext until the user has clicked something, to stop
// pages making noise unbidden. We are not a page and there is nobody to click: the app must
// come up capturing. DESIGN.md §1 — autonomous.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// If we ever do end up needing a video source, Windows Graphics Capture is the component
// that fails with E_ACCESSDENIED on some setups. Turning it off falls back to the older
// capturer, which is slower but permitted.
app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer');

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  const win = new BrowserWindow({
    // useContentSize means these numbers describe the web page area, excluding the window
    // frame — so the stage really is 1280x720 of actual pixels.
    useContentSize: true,
    width: STAGE.width,
    height: STAGE.height + GAP_HEIGHT + HUD_HEIGHT,
    resizable: false,

    // Transparency for OBS compositing (DESIGN.md §13.3). Two constraints come with it on
    // Windows: the window must be frameless, and the background colour must be fully
    // transparent here — a transparent window with an opaque backgroundColor is just an
    // opaque window. Frameless means no title bar, so the HUD doubles as the drag handle
    // and carries its own close button.
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',

    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      backgroundThrottling: false,
      sandbox: false,
    },
  });

  // Avoid a white flash on launch: build the page first, reveal when it's painted.
  win.once('ready-to-show', () => win.show());
  mainWindow = win;

  // DESIGN.md §14 — unbreakable. A renderer can die outright (Chromium will terminate one
  // that sends a malformed IPC, for instance), and the result is a black window that never
  // comes back. Mid-set that is the worst possible failure, so we reload rather than sit
  // there. The renderer's own crash-loop guard stops this from becoming a cycle.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[olib] renderer gone: ${details.reason} (exit ${details.exitCode}) — reloading`);
    if (!win.isDestroyed()) win.reload();
  });

  win.webContents.on('preload-error', (_event, path, error) => {
    console.error(`[olib] preload failed: ${path}`, error);
  });

  /**
   * Forward the renderer console to the terminal.
   *
   * Errors in the renderer were previously only visible by opening devtools, which nobody
   * does mid-problem. This puts them in the same place as everything else — the terminal
   * running `npm run dev`.
   *
   * The event signature changed across Electron versions (positional arguments became a
   * details object), so this reads whichever shape arrives rather than assuming one.
   */
  (win.webContents as unknown as NodeJS.EventEmitter).on(
    'console-message',
    (...args: unknown[]) => {
      const first = args[0] as
        | { message?: string; level?: string | number; lineNumber?: number; sourceId?: string }
        | undefined;

      const modern = typeof first === 'object' && first !== null && 'message' in first;
      const message = modern ? first.message : (args[2] as string | undefined);
      const level = modern ? first.level : (args[1] as string | number | undefined);
      if (message === undefined) return;

      // Chromium levels: 0/verbose, 1/info, 2/warning, 3/error.
      const isError = level === 3 || level === 'error';
      const tag = isError ? '[renderer:error]' : '[renderer]';
      if (isError) console.error(tag, message);
      else console.log(tag, message);
    },
  );

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * Text files live in a writable folder, not next to the executable.
 *
 * An installed app sits in Program Files, which is read-only — writing there fails for the
 * user and succeeds for a developer running from source, which is the worst kind of bug.
 * userData is writable in both cases.
 */
function textsDir(): string {
  return join(app.getPath('userData'), 'texts');
}

/**
 * Names arrive from the renderer, so they are treated as untrusted: stripped to a bare
 * filename and restricted to safe characters. Without this, a name like `../../config`
 * would write outside the folder.
 */
function textPath(name: string): string {
  const safe = basename(name).replace(/[^A-Za-z0-9 _-]/g, '').trim();
  if (safe.length === 0) throw new Error('invalid text name');
  return join(textsDir(), `${safe}.txt`);
}

ipcMain.handle('olib:texts-list', async (): Promise<string[]> => {
  await mkdir(textsDir(), { recursive: true });
  const files = await readdir(textsDir());
  return files.filter((f) => f.endsWith('.txt')).map((f) => f.slice(0, -4)).sort();
});

ipcMain.handle('olib:text-read', async (_event, name: string): Promise<string> => {
  return readFile(textPath(name), 'utf8');
});

ipcMain.handle('olib:text-write', async (_event, name: string, content: string) => {
  await mkdir(textsDir(), { recursive: true });
  await writeFile(textPath(name), content, 'utf8');
});

ipcMain.handle('olib:text-delete', async (_event, name: string) => {
  // `force` so deleting something already gone is not an error — the renderer's list can
  // legitimately be a moment behind the folder.
  await rm(textPath(name), { force: true });
});

/** Import a .txt from anywhere on disk. Returns the name it was saved under, or null. */
ipcMain.handle('olib:text-import', async (): Promise<string | null> => {
  if (!mainWindow || mainWindow.isDestroyed()) return null;

  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import text',
    filters: [{ name: 'Text', extensions: ['txt'] }],
    properties: ['openFile'],
  });

  const source = result.filePaths[0];
  if (result.canceled || source === undefined) return null;

  const name = basename(source, '.txt');
  const content = await readFile(source, 'utf8');
  await mkdir(textsDir(), { recursive: true });
  await writeFile(textPath(name), content, 'utf8');
  return name;
});

ipcMain.on('olib:close', () => {
  mainWindow?.close();
});

void app.whenReady().then(() => {
  // DESIGN.md §5: no permission dialogs mid-set. In a browser the user would get a prompt
  // for microphone access; here we are the browser, so we grant it ourselves.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media');
  });

  // DESIGN.md §8 — capturing "what you hear" without a virtual audio cable.
  //
  // We answer the renderer's display-media request ourselves, so no "choose what to share"
  // picker appears. `audio: 'loopback'` taps the system's audio output directly.
  //
  // Note there is no video source here, deliberately. Asking for one made Windows Graphics
  // Capture try to open the monitor, which fails with E_ACCESSDENIED on some machines — and
  // took the audio down with it. We never wanted the video; a screen capture we don't look
  // at is pure cost.
  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      callback({ audio: 'loopback' });
    },
    { useSystemPicker: false },
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
