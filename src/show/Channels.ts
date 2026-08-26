import { isScalar, type Channel } from './treatments';

/**
 * Who wrote what, so layers can decay independently. DESIGN.md §11.5.
 *
 * Replaces `GlitchState`, and for two reasons rather than one.
 *
 * **Stacking.** There used to be a single `data-glitch` attribute, so whichever effect ran
 * last won and the earlier one silently vanished. Channels are named after CSS properties,
 * so treatments touching different properties coexist and only a genuine same-property
 * contest resolves.
 *
 * **Independent decay.** One ambient `removeGlitches` cleared everything at one rate, so an
 * inversion could not fade slower than a flicker. Each layer now clears its own elements at
 * its own rate, which needs to know whose value is whose.
 *
 * Ownership lives on the element as `data-<channel>-by`, not in a central map. The DOM is
 * replaced wholesale on every re-typeset, and a registry would need invalidating each time;
 * attributes simply vanish with the elements that carried them.
 */
export class Channels {
  /**
   * Elements each layer currently has something lit on.
   *
   * Kept so decay is proportional to what is actually lit — a few dozen elements — rather
   * than a `querySelectorAll` across thousands, sixty times a second (§14).
   */
  private readonly owned = new Map<number, Set<HTMLElement>>();

  /**
   * Where a seamless conveyor's duplicate elements are, so both halves get written.
   *
   * Set after every typeset. Without it the copy would scroll into view carrying none of the
   * treatments the original had, and the belt would visibly be two different pieces of text.
   */
  private mirror: ((el: HTMLElement) => readonly HTMLElement[]) | null = null;

  setMirror(lookup: ((el: HTMLElement) => readonly HTMLElement[]) | null): void {
    this.mirror = lookup;
  }

  /**
   * Every copy of an element, following copies of copies.
   *
   * A block can be duplicated after its contents already were — a wrapping `travel` clones a
   * block that a seamless conveyor has already doubled — so the copy of a copy is a real
   * thing and has to be reached. Depth is two in practice; the guard is there so a pairing
   * bug cannot turn into a hang.
   */
  private copiesOf(el: HTMLElement): readonly HTMLElement[] {
    const lookup = this.mirror;
    if (!lookup) return [];

    const out: HTMLElement[] = [];
    let frontier = lookup(el);

    for (let depth = 0; depth < 4 && frontier.length > 0; depth++) {
      const next: HTMLElement[] = [];
      for (const twin of frontier) {
        if (out.includes(twin)) continue;
        out.push(twin);
        next.push(...lookup(twin));
      }
      frontier = next;
    }
    return out;
  }

  /** Write one channel, recording the owner. */
  set(el: HTMLElement, channel: Channel, value: string, owner: number): void {
    this.write(el, channel, value, owner);

    // Every copy takes the same value, so a duplicated belt or a wrapped block reads as one
    // continuous thing rather than several that happen to say the same words.
    for (const twin of this.copiesOf(el)) this.write(twin, channel, value, owner);

    let set = this.owned.get(owner);
    if (!set) {
      set = new Set();
      this.owned.set(owner, set);
    }
    // Only the original is tracked. Decay walks what it owns and clears the twin alongside,
    // so the copy never needs to be a member in its own right.
    set.add(el);
  }

  private write(el: HTMLElement, channel: Channel, value: string, owner: number): void {
    if (isScalar(channel)) {
      el.style.setProperty(`--${channel}`, value);
      el.dataset[channel] = '1';
    } else {
      el.dataset[channel] = value;
    }
    el.dataset[`${channel}By`] = String(owner);
  }

  /**
   * Clear one channel, but only if this layer still owns it.
   *
   * A later layer may have taken the channel since. Clearing it anyway would delete
   * somebody else's value and produce a flicker nobody asked for — the bug this whole
   * ownership scheme exists to prevent.
   */
  private clearIfOwned(el: HTMLElement, channel: Channel, owner: number): boolean {
    if (el.dataset[`${channel}By`] !== String(owner)) return false;

    this.wipe(el, channel);

    for (const twin of this.copiesOf(el)) this.wipe(twin, channel);
    return true;
  }

  private wipe(el: HTMLElement, channel: Channel): void {
    delete el.dataset[channel];
    delete el.dataset[`${channel}By`];
    if (isScalar(channel)) el.style.removeProperty(`--${channel}`);
  }

  /**
   * Fade a layer's elements.
   *
   * `perFrame` is the probability of clearing each one this frame, derived from elapsed
   * time by the caller — see {@link decayProbability}. Doing it probabilistically rather
   * than by age gives the scattered dissolve the look depends on; doing it from elapsed
   * time rather than per frame is what stops it running twice as fast at 60fps as at 30.
   */
  decay(owner: number, channels: readonly Channel[], perFrame: number): void {
    const set = this.owned.get(owner);
    if (!set || set.size === 0) return;

    for (const el of Array.from(set)) {
      // An element the DOM no longer contains cannot be cleared and must not be retained;
      // this is the safety net for a re-typeset that did not call `forget`.
      if (!el.isConnected) {
        set.delete(el);
        continue;
      }

      if (Math.random() >= perFrame) continue;

      let stillOwns = false;
      for (const channel of channels) {
        if (this.clearIfOwned(el, channel, owner)) stillOwns = true;
      }

      // Either it faded, or another layer took every channel it held. Both mean this layer
      // has no further business with the element.
      set.delete(el);
      void stillOwns;
    }
  }

  /** Everything this layer lit, gone at once. Used when a preset is swapped out. */
  clearOwner(owner: number, channels: readonly Channel[]): void {
    const set = this.owned.get(owner);
    if (!set) return;

    for (const el of set) {
      if (!el.isConnected) continue;
      for (const channel of channels) this.clearIfOwned(el, channel, owner);
    }
    set.clear();
  }

  /** Wipe every channel from every element any layer has touched. */
  clearAll(): void {
    for (const [owner, set] of this.owned) {
      for (const el of set) {
        if (!el.isConnected) continue;
        for (const channel of ALL_CHANNELS) this.clearIfOwned(el, channel, owner);
      }
    }
    this.owned.clear();
  }

  /**
   * Called after a re-typeset: the tracked elements no longer exist.
   *
   * No DOM work — the elements are already gone, and touching detached nodes would be
   * wasted effort at exactly the moment the frame budget is tightest.
   */
  forget(): void {
    this.owned.clear();
  }

  /** How many elements are lit in total. For the layer-cost warning (§11.5). */
  get size(): number {
    let total = 0;
    for (const set of this.owned.values()) total += set.size;
    return total;
  }
}

const ALL_CHANNELS: readonly Channel[] = [
  'bg',
  'fg',
  'font',
  'deco',
  'outline',
  'size',
  'anim',
  'vis',
];

/**
 * Per-frame clear probability for a fade lasting `bars`.
 *
 * Defined so that after `bars` bars about 5% remains — "fades over two bars" means what it
 * sounds like. Deriving it from elapsed seconds rather than assuming a frame rate is what
 * makes the look identical at 30fps and 60.
 *
 * Returns 0 for `bars <= 0`, meaning the layer holds until the text is replaced.
 */
export function decayProbability(bars: number, dt: number, barSeconds: number): number {
  if (bars <= 0 || dt <= 0 || barSeconds <= 0) return 0;

  const survivalPerBar = Math.pow(0.05, 1 / bars);
  return 1 - Math.pow(survivalPerBar, dt / barSeconds);
}
