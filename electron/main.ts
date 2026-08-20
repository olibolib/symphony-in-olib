import { app, BrowserWindow, ipcMain, session } from 'electron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Stage size — DESIGN.md §13.1. The window is sized to fit this at 1:1. */
const STAGE = { width: 1280, height: 720 } as const;

/** Height of the HUD strip below the stage. Outside the OBS crop.
 *  Keep in sync with --hud-h in style/base.css. */
const HUD_HEIGHT = 268;

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
    height: STAGE.height + HUD_HEIGHT,
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

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

/**
 * The HUD lives below the stage, so hiding it has to shrink the window too — otherwise you
 * are left with 200px of transparent nothing that still catches mouse clicks.
 */
ipcMain.on('olib:hud-visible', (_event, visible: boolean) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setContentSize(STAGE.width, STAGE.height + (visible ? HUD_HEIGHT : 0));
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
