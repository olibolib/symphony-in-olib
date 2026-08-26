/**
 * The bar length the motion keyframes are written against.
 *
 * The animations run at this duration and are scaled by `playbackRate`, rather than having
 * their duration rewritten — see {@link Stage.retimeMotion}. Keep in step with `stage.css`.
 */
const NOMINAL_BAR_SECONDS = 2;

/** Only the motion animations are rate-driven. Flicker stays on `--bar`. */
const MOTION_ANIMATIONS = /^olib-(loop|sweep|block)-/;

/**
 * The stage is the fixed-size rectangle OBS captures. It renders at 1:1 with no scaling,
 * so type stays pixel-crisp and the crop rectangle is trivial to report.
 * DESIGN.md §13.1–13.2.
 */
export class Stage {
  readonly el: HTMLElement;
  readonly container: HTMLElement;

  /**
   * Current background mode. Effects that paint the background check this: in transparent
   * mode there is nothing to paint, and doing it anyway would quietly undo the setting.
   */
  backgroundMode: 'white' | 'black' | 'transparent' = 'white';

  /**
   * Vertical drift, in stage heights per second. Acid scrolled the page; here the stage is
   * a fixed box, so the container is translated inside it instead — same effect, and it
   * cannot fight the window or the OBS crop.
   */
  scrollSpeed = 0;
  private scrollOffset = 0;

  /**
   * Extra scale applied to the whole stage, 0 for none.
   *
   * Lives here rather than in the effect because scroll also writes `transform`. Two
   * separate writers would silently overwrite each other — the second one to run each frame
   * would win, and which that was would depend on effect ordering.
   */
  pulse = 0;

  constructor(el: HTMLElement, container: HTMLElement) {
    this.el = el;
    this.container = container;
  }

  get width(): number {
    return this.el.clientWidth;
  }

  get height(): number {
    return this.el.clientHeight;
  }

  /**
   * The crop rectangle to type into OBS, relative to the window's client area.
   * Reported rather than assumed, so it stays correct if the layout ever changes.
   */
  cropRect(): { x: number; y: number; width: number; height: number } {
    const r = this.el.getBoundingClientRect();
    return {
      x: Math.round(r.left),
      y: Math.round(r.top),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  /**
   * Advance the scroll. Called once per frame with the elapsed seconds.
   *
   * The offset wraps rather than stopping at the end: text that scrolls off the top comes
   * back from the bottom, so a slow drift can run for an entire set without needing to be
   * reset or hitting a boundary mid-phrase.
   */
  updateScroll(dt: number): void {
    if (this.scrollSpeed !== 0) {
      // The offset wraps rather than stopping at the end: text that scrolls off the top
      // comes back from the bottom, so a slow drift can run for an entire set.
      const span = Math.max(this.container.scrollHeight, this.height);
      this.scrollOffset = (this.scrollOffset + this.scrollSpeed * this.height * dt) % span;
    } else if (this.scrollOffset !== 0) {
      this.scrollOffset = 0;
    }

    this.applyTransform();
  }

  /** Single writer for `transform`, composing scroll and pulse. */
  private applyTransform(): void {
    if (this.scrollOffset === 0 && this.pulse === 0) {
      this.container.style.removeProperty('transform');
      return;
    }

    const scale = 1 + this.pulse;
    this.container.style.transform = `translateY(${-this.scrollOffset}px) scale(${scale})`;
  }

  /**
   * Publish the length of four beats, so CSS animations can be timed in bars.
   *
   * A CSS variable rather than a duration written per element: an animation whose duration
   * is `calc(var(--bar) * 0.25)` **re-times itself** the moment the tempo changes, for every
   * element at once and with no JavaScript touching them. Writing seconds at the point a
   * treatment fires would freeze each element at whatever the tempo was when it was lit, and
   * a flickering word from before a track change would beat against the one next to it.
   */
  setBarSeconds(seconds: number): void {
    if (seconds <= 0) return;

    // Only when it has moved enough to matter. `clock.bpm` is a live estimate and drifts by
    // fractions of a beat continuously, so an exact comparison rewrites this most frames.
    if (Math.abs(seconds - this.barSeconds) / this.barSeconds < 0.002) return;
    this.barSeconds = seconds;

    // Flicker still reads its period from here. A strobe changing phase is imperceptible, and
    // there can be hundreds of them at once — far too many to drive individually.
    this.el.style.setProperty('--bar', `${seconds.toFixed(4)}s`);

    this.retimeMotion();
  }

  /**
   * Re-time the motion animations without moving them.
   *
   * **Changing `animation-duration` does not preserve position.** The browser keeps the
   * elapsed time and recomputes progress against the new duration, so every rewrite jumps —
   * and since the tempo estimate drifts continuously, that was a jump most frames. It read as
   * a stutter that got worse the harder the tracker was working.
   *
   * `playbackRate` is the primitive that exists for this: it changes how fast the animation
   * advances while leaving `currentTime` alone, so a tempo change becomes a change of speed
   * rather than a jump to a new position. `updatePlaybackRate` is the seamless form.
   *
   * The durations in CSS are therefore written against a **nominal** bar, and this scales
   * them. There are at most a handful of these animations — one per block, at most three
   * blocks, times the two kinds — so walking them is cheap enough to do on every change.
   */
  private retimeMotion(): void {
    const rate = NOMINAL_BAR_SECONDS / this.barSeconds;

    for (const animation of this.el.getAnimations({ subtree: true })) {
      const name = (animation as CSSAnimation).animationName;
      if (typeof name !== 'string' || !MOTION_ANIMATIONS.test(name)) continue;
      animation.updatePlaybackRate(rate);
    }
  }

  /**
   * Bring newly created motion animations up to the current tempo.
   *
   * A re-typeset builds new blocks, and their animations start at rate 1 — which is the
   * nominal bar, not the live one. Called after every typeset.
   */
  syncMotion(): void {
    this.retimeMotion();
  }

  private barSeconds = NOMINAL_BAR_SECONDS;

  /** Sets the base font size all preset sizing is relative to. Mirrors Acid's `--fs`. */
  setFontScale(px: number): void {
    this.el.style.setProperty('--fs', `${px}px`);
  }
}
