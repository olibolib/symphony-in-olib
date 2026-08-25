import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, screen, session, Tray } from 'electron';
import { basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { COMMAND_CHANNEL, EVENT_CHANNEL, PCM_CHANNEL } from '../src/ipc/protocol';
import {
  getActiveWindowProcessIds,
  setExecutablesRoot,
  startAudioCapture,
  stopAudioCapture,
} from 'application-loopback';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Stage size — DESIGN.md §13.1. The window is sized to fit this at 1:1. */
const STAGE = { width: 1280, height: 720 } as const;

/**
 * The tray icon.
 *
 * Packaged, `build/` is only build resources and is not inside the app — so the file is
 * copied to the resources directory (see extraResources) and read from there. In development
 * it is read straight from the source tree.
 */
function trayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'tray.png')
    : join(__dirname, '..', '..', 'build', 'tray.png');
}

let tray: Tray | null = null;

/**
 * Closing the control window hides it rather than quitting — the show carries on. The tray
 * is how it comes back, and the only place a menu can live: the canvas window is on the
 * stream, and even an auto-hidden menu bar appears on Alt. DESIGN.md §7.1.
 */
function createTray(): void {
  const image = nativeImage.createFromPath(trayIconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
  tray.setToolTip('Symphony in Olib');

  const showControl = (): void => {
    if (!controlWindow || controlWindow.isDestroyed()) return;
    controlWindow.show();
    controlWindow.focus();
  };

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show control window', click: showControl },
      {
        label: 'Control window always on top',
        type: 'checkbox',
        checked: false,
        click: (item) => controlWindow?.setAlwaysOnTop(item.checked),
      },
      { type: 'separator' },
      { label: 'Centre canvas on screen', click: () => centreOutput() },
      { type: 'separator' },
      { label: 'Quit', click: () => outputWindow?.close() },
    ]),
  );

  // Double-click is the habit everyone already has for a tray icon.
  tray.on('double-click', showControl);
}

/** Default size of the control window. Resizable, and its bounds are remembered. */
const CONTROL_DEFAULT = { width: 980, height: 560 } as const;
const CONTROL_MIN = { width: 560, height: 320 } as const;

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

/** The canvas. What OBS captures — no chrome, no crop needed. */
let outputWindow: BrowserWindow | null = null;

/** The HUD. An ordinary window; hiding it minimises to the tray. */
let controlWindow: BrowserWindow | null = null;

/**
 * Keep restored bounds on a display that currently exists.
 *
 * Saving a position on a second monitor, unplugging it and finding the window unreachable is
 * a bug worth never shipping. DESIGN.md §7.1.
 */
function onVisibleDisplay(bounds: Electron.Rectangle): Electron.Rectangle {
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const a = d.workArea;
    return (
      bounds.x < a.x + a.width &&
      bounds.x + bounds.width > a.x &&
      bounds.y < a.y + a.height &&
      bounds.y + bounds.height > a.y
    );
  });

  if (visible) return bounds;

  const primary = screen.getPrimaryDisplay().workArea;
  return {
    width: bounds.width,
    height: bounds.height,
    x: primary.x + Math.round((primary.width - bounds.width) / 2),
    y: primary.y + Math.round((primary.height - bounds.height) / 2),
  };
}

function createOutputWindow(): void {
  const win = new BrowserWindow({
    // useContentSize means these numbers describe the web page area, excluding the window
    // frame — so the stage really is 1280x720 of actual pixels.
    useContentSize: true,
    width: STAGE.width,
    height: STAGE.height,
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

  /**
   * Click-through.
   *
   * A frameless transparent window still swallows every pointer event over its rectangle,
   * so the canvas sat invisibly on top of whatever was behind it and ate the clicks. It has
   * no interactive content at all now that the HUD is a separate window, so nothing is lost
   * by making it ignore the mouse entirely — and it stops being a hole in the desktop.
   */
  win.setIgnoreMouseEvents(true);

  outputWindow = win;

  // Closing the canvas quits. Closing the control window only hides it (see the tray).
  win.on('closed', () => {
    outputWindow = null;
    app.quit();
  });

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

  loadRenderer(win, 'index.html');
}

/** Both windows load the same way; only the entry file differs. */
function loadRenderer(win: BrowserWindow, file: string): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  if (devUrl) void win.loadURL(`${devUrl}/${file}`);
  else void win.loadFile(join(__dirname, `../renderer/${file}`));
}

function createControlWindow(): void {
  const win = new BrowserWindow({
    ...onVisibleDisplay({ x: 60, y: 60, ...CONTROL_DEFAULT }),
    minWidth: CONTROL_MIN.width,
    minHeight: CONTROL_MIN.height,
    title: 'Symphony in Olib — Control',
    backgroundColor: '#0b0b0b',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/preload.mjs'),
      backgroundThrottling: false,
      sandbox: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  controlWindow = win;

  // Hide rather than close: the show carries on, and the tray brings it back.
  win.on('close', (event) => {
    if (outputWindow !== null && !outputWindow.isDestroyed()) {
      event.preventDefault();
      win.hide();
    }
  });

  loadRenderer(win, 'control.html');
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
  const parent = controlWindow ?? outputWindow;
  if (!parent || parent.isDestroyed()) return null;

  const result = await dialog.showOpenDialog(parent, {
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
  outputWindow?.close();
});

/**
 * Message relay between the two renderers. DESIGN.md §7.1.
 *
 * Main is only a broker here — it does not read or act on the payloads, it forwards them.
 * Keeping the routing dumb means the protocol can change without touching this file.
 */
ipcMain.on(COMMAND_CHANNEL, (_event, command: unknown) => {
  if (outputWindow && !outputWindow.isDestroyed()) {
    outputWindow.webContents.send(COMMAND_CHANNEL, command);
  }
});

ipcMain.on(EVENT_CHANNEL, (_event, message: unknown) => {
  if (controlWindow && !controlWindow.isDestroyed() && controlWindow.isVisible()) {
    controlWindow.webContents.send(EVENT_CHANNEL, message);
  }
});

ipcMain.on('olib:show-control', () => {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.show();
    controlWindow.focus();
  }
});

ipcMain.on('olib:always-on-top', (_event, value: boolean) => {
  controlWindow?.setAlwaysOnTop(value);
});

/**
 * Output window placement, driven from the control window.
 *
 * The canvas is frameless — transparency requires it on Windows, and transparency is worth
 * having (verified: alpha does survive OBS window capture). Frameless means no title bar to
 * drag, so position and size are typed rather than dragged. Which is arguably better when
 * OBS is pointed at the window: exact numbers, reproduced on every launch.
 */
ipcMain.handle('olib:output-bounds', () => {
  if (!outputWindow || outputWindow.isDestroyed()) return null;
  const [x, y] = outputWindow.getPosition();
  const [width, height] = outputWindow.getContentSize();
  return { x: x ?? 0, y: y ?? 0, width: width ?? 0, height: height ?? 0 };
});

ipcMain.on(
  'olib:set-output-bounds',
  (_event, bounds: { x: number; y: number; width: number; height: number }) => {
    if (!outputWindow || outputWindow.isDestroyed()) return;
    const safe = onVisibleDisplay({
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(160, Math.round(bounds.width)),
      height: Math.max(90, Math.round(bounds.height)),
    });
    outputWindow.setContentSize(safe.width, safe.height);
    outputWindow.setPosition(safe.x, safe.y);
  },
);

/**
 * Per-application audio capture. DESIGN.md §8.2.
 *
 * Windows process loopback, via a helper executable the package ships — no native module and
 * no toolchain. Captures one application's output regardless of which device it is using,
 * which is the only way to get a DJ mix without also getting notification pings.
 *
 * The helper streams 16-bit stereo 48kHz PCM. It is forwarded straight to the output window,
 * where the engine lives; main does not look at it.
 */
let capturingPid: string | null = null;

ipcMain.handle('olib:apps-list', async () => {
  const windows = await getActiveWindowProcessIds();

  // One entry per process. Applications routinely have several windows, and a list with
  // "Traktor Pro 4" three times is worse than useless.
  const seen = new Map<string, { processId: string; title: string }>();
  for (const w of windows) {
    const id = String(w.processId);
    if (!seen.has(id) && w.title.trim().length > 0) {
      seen.set(id, { processId: id, title: w.title });
    }
  }
  return [...seen.values()];
});

ipcMain.handle('olib:app-capture-start', (_event, processId: string) => {
  stopAppCapture();

  try {
    startAudioCapture(processId, {
      onData: (data) => {
        if (!outputWindow || outputWindow.isDestroyed()) return;
        // Copy: the helper reuses its buffer, and the structured clone happens later.
        outputWindow.webContents.send(PCM_CHANNEL, new Uint8Array(data).buffer);
      },
    });
    capturingPid = processId;
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message };
  }
});

ipcMain.on('olib:app-capture-stop', () => stopAppCapture());

function stopAppCapture(): void {
  if (capturingPid === null) return;
  try {
    stopAudioCapture(capturingPid);
  } catch {
    // Already gone. Nothing to do, and nothing worth reporting.
  }
  capturingPid = null;
}

app.on('before-quit', stopAppCapture);

function centreOutput(): void {
  if (!outputWindow || outputWindow.isDestroyed()) return;
  const [width, height] = outputWindow.getContentSize();
  const area = screen.getDisplayNearestPoint(outputWindow.getBounds()).workArea;
  outputWindow.setPosition(
    area.x + Math.round((area.width - (width ?? 0)) / 2),
    area.y + Math.round((area.height - (height ?? 0)) / 2),
  );
}

ipcMain.on('olib:centre-output', centreOutput);

/**
 * The capture helpers resolve relative to their own module, which in a packaged build is
 * inside app.asar — and an executable cannot be spawned from an archive. electron-builder
 * unpacks them (see asarUnpack); this points the package at where they actually landed.
 *
 * Without it, per-application capture works perfectly in development and fails only in the
 * installed build, which is the worst place to discover it.
 */
if (app.isPackaged) {
  setExecutablesRoot(
    join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'application-loopback', 'bin'),
  );
}

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

  createOutputWindow();
  createControlWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOutputWindow();
      createControlWindow();
    }
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
