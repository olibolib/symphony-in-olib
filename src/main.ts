import './types';
import { Stage } from './render/Stage';
import { EngineBridge } from './ipc/EngineBridge';
import { Engine } from './Engine';

/**
 * The output window's composition root. DESIGN.md §7.1.
 *
 * Build the DOM handles, construct the engine, wire the window's events to it, and run the
 * loop. Everything else lives in an object that can be constructed, which this file exists to
 * do exactly once.
 */

/**
 * Last-resort startup failure display.
 *
 * Everything downstream depends on the HUD existing, including the error reporting — so a throw
 * while building it leaves an app that looks alive and does nothing. This is the only reporting
 * path that depends on nothing but the DOM.
 */
function fatal(error: unknown): never {
  const message =
    error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error);

  const box = document.createElement('pre');
  box.style.cssText =
    'position:fixed;inset:0;z-index:9999;margin:0;padding:24px;background:#140909;' +
    'color:#ff8b73;font:12px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;' +
    'overflow:auto';
  box.textContent = `Symphony in Olib failed to start.\n\n${message}`;
  document.body.append(box);
  throw error;
}

/**
 * Surface anything that escapes, rather than leaving a dead-looking window with no clue why.
 * DESIGN.md §14 — never fail silently.
 *
 * Registered before anything else can throw, and guarded because the HUD does not exist yet at
 * this point. There used to be a second pair of these further down the old file doing the same
 * job with the HUD attached, so every error was reported twice.
 */
function surface(message: string, detail: unknown): void {
  console.error('[olib]', detail ?? message);
  try {
    hud?.setStatus(`Error: ${message}`, true);
  } catch {
    // Thrown before the HUD was built. The console line above is the whole report.
  }
}

window.addEventListener('error', (event) => surface(event.message, event.error));
window.addEventListener('unhandledrejection', (event) =>
  surface(String(event.reason), event.reason),
);

function el(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`Missing element: ${selector}`);
  return found;
}

let stage: Stage;
let hud: EngineBridge;
try {
  stage = new Stage(el('#stage'), el('#container'));
  hud = new EngineBridge();
} catch (error) {
  fatal(error);
}

const engine = new Engine(stage, hud);

hud.onCommand = (command) => engine.handle(command);
window.olib.apps.onPcm((chunk) => engine.acceptPcm(chunk));

window.addEventListener('resize', () => engine.syncStageSize());

// Anything still unsaved when the window goes away would be lost — the save debounce is longer
// than closing the app takes.
window.addEventListener('beforeunload', () => engine.flush());

window.addEventListener('keydown', (event) => {
  if (engine.keydown(event)) event.preventDefault();
});

engine.start();

function frame(now: number): void {
  engine.frame(now);
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
