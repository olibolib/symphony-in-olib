import { PALETTES, type PaletteName } from '../render/palette';
import type { Stage } from '../render/Stage';
import { FULL, normalise, type Mask } from './mask';
import { browserSettings, type Settings } from '../util/settings';

/**
 * The three settings that describe the frame rather than a preset. DESIGN.md §13.3.1.
 *
 * Background, palette and the global spawn mask. All three exist for the same reason —
 * compositing over other visuals — and all three are the VJ's statement about tonight rather
 * than anything a preset can ask for or override.
 *
 * Kept together because they behave the same way: remembered, applied at once rather than at
 * the next phrase, and published to the HUD whenever they change. Choosing a palette is a
 * deliberate act, and waiting sixteen bars for it would be the app arguing.
 */

/**
 * Also read by an inline script in `index.html`, which applies the mode before the first
 * paint. Change one and change the other, or launching flashes white.
 */
const BG_KEY = 'olib.background';
const PALETTE_KEY = 'olib.palette';
const MASK_KEY = 'olib.mask';

export type BackgroundMode = 'white' | 'black' | 'transparent';

/** How this reports back. The engine supplies the HUD, and a re-typeset for the mask. */
export interface LookReporter {
  background(mode: BackgroundMode): void;
  palette(name: PaletteName): void;
  mask(mask: Mask): void;
  /** The mask changed, so where text may go has changed. */
  retypeset(): void;
}

export class Look {
  private backgroundMode: BackgroundMode;
  private paletteName: PaletteName;
  private spawnMask: Mask;

  constructor(
    private readonly stage: Stage,
    private readonly report: LookReporter,
    private readonly settings: Settings = browserSettings,
  ) {
    this.backgroundMode = (settings.get(BG_KEY) as BackgroundMode | null) ?? 'white';
    this.paletteName = (settings.get(PALETTE_KEY) as PaletteName | null) ?? 'acid';
    this.spawnMask = readMask(settings);
  }

  /** Push everything to the stage and the HUD. Called once, after construction. */
  apply(): void {
    this.setBackground(this.backgroundMode);
    this.setPalette(this.paletteName);
    this.report.mask(this.spawnMask);
  }

  /**
   * Where text may anchor, whatever a preset asks for (§11.6).
   *
   * Defaults to everything allowed: a mask is a constraint the VJ adds for tonight's video, and
   * starting with one already applied would be the app inventing a restriction nobody asked
   * for. The presets carry their own, and the two are intersected.
   */
  get mask(): Mask {
    return this.spawnMask;
  }

  get palette(): PaletteName {
    return this.paletteName;
  }

  setBackground(mode: BackgroundMode): void {
    this.backgroundMode = mode;
    document.documentElement.dataset['bg'] = mode;
    this.stage.backgroundMode = mode;
    this.settings.set(BG_KEY, mode);
    this.report.background(mode);
  }

  setPalette(name: PaletteName): void {
    this.paletteName = name;
    this.settings.set(PALETTE_KEY, name);
    this.report.palette(name);

    // Applied at once, like the background — unlike the old periodic shifting, which changed
    // colours nobody had asked to change.
    this.stage.setPalette(PALETTES[name]);
  }

  /**
   * Re-typesets immediately rather than waiting for the next phrase. If you have just excluded
   * a corner because text is sitting on the club's logo, sixteen bars is much too long to wait.
   */
  setMask(mask: Mask): void {
    this.spawnMask = normalise(mask);
    this.settings.set(MASK_KEY, JSON.stringify(this.spawnMask));
    this.report.mask(this.spawnMask);
    this.report.retypeset();
  }
}

function readMask(settings: Settings): Mask {
  const saved = settings.get(MASK_KEY);
  if (saved === null) return FULL;
  try {
    return normalise(JSON.parse(saved) as Mask);
  } catch {
    // A corrupt setting must not stop the app starting. Falling back to "everywhere" is visible
    // and recoverable; failing to launch is not (§14).
    return FULL;
  }
}
