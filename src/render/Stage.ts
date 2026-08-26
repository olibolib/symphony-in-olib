/**
 * The bar length the motion keyframes are written against.
 *
 * The animations run at this duration and are scaled by `playbackRate`, rather than having
 * their duration rewritten — see {@link Stage.retimeMotion}. Keep in step with `stage.css`.
 */
const NOMINAL_BAR_SECONDS = 2;

/**
 * Only the motion animations are rate-driven. Flicker stays on `--bar`.
 *
 * Matched on the shared `olib-move-` prefix rather than by listing them. The list version
 * silently stopped covering the wrapping keyframes the moment they were added, so they ran at
 * the nominal tempo for as long as nobody looked.
 */
const MOTION_ANIMATIONS = /^olib-move-/;

/**
 * Time constant for chasing a new tempo, in seconds.
 *
 * Closes about 92% of a 128-to-174 change within a second — quick enough that a track change
 * feels like the visual noticing, slow enough to read as a glide rather than a jump. The
 * largest single-frame speed change on that jump is 1.3%, which is below what the eye picks
 * out as a step.
 */
const CHASE_SECONDS = 0.35;

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
  /**
   * The tempo the visual should be moving at.
   *
   * Stored, not applied. Both a tap and a detected estimate arrive here, and both can move by
   * a lot in one step — a track change from 128 to 174 is a 36% speed change. Snapping to it
   * is a lurch, so {@link tick} chases it instead.
   */
  setTargetBar(seconds: number): void {
    if (seconds > 0) this.targetBar = seconds;
  }

  /** The bar length the visual is actually running at, after smoothing. */
  get barSeconds(): number {
    return this.currentBar;
  }

  /**
   * Ease the running tempo toward the target. Call once per frame.
   *
   * Feeds flicker's period and the decay clock. Motion takes its speed once, at typeset, and
   * keeps it — see {@link syncMotion}.
   *
   * An exponential approach — each frame closes a fixed *proportion* of what is left, so the
   * move is fast while the gap is large and settles gently as it closes. Deriving the step
   * from elapsed time rather than counting frames keeps it identical at 30fps and 144.
   *
   * The alternative, a fixed rate of change, is wrong in both directions at once: slow enough
   * to be smooth on a small correction is far too slow on a track change, and fast enough for
   * a track change is a visible step on a correction of half a beat.
   */
  tick(dt: number): void {
    const gap = this.targetBar - this.currentBar;

    // Close enough that no further easing is visible. Snapping here rather than approaching
    // for ever keeps the readouts and the motion agreeing on a settled tempo.
    if (Math.abs(gap) / this.targetBar < 0.0005) {
      this.currentBar = this.targetBar;
    } else {
      this.currentBar += gap * (1 - Math.exp(-dt / CHASE_SECONDS));
    }

    // Motion is deliberately *not* re-timed here. See `syncMotion`.

    // Flicker reads its period from here. Thresholded because a duration rewrite restarts a
    // strobe's phase — imperceptible, but there is no reason to do it every frame.
    if (Math.abs(this.currentBar - this.publishedBar) / this.currentBar > 0.01) {
      this.publishedBar = this.currentBar;
      this.el.style.setProperty('--bar', `${this.currentBar.toFixed(4)}s`);
    }
  }

  /**
   * Fix each block's speed at the tempo it was typeset at, and leave it there.
   *
   * **A block's motion does not follow the tempo once it is running.** A text lasts a phrase
   * or two — a handful of bars — and is then rebuilt at whatever the tempo has become, so it
   * is never far out of step; and the alternative is worse than the error it corrects. Every
   * adjustment to a *running* animation is a chance to disturb it, and a conveyor is the one
   * thing on stage where a disturbance is unmistakable, because the eye is tracking a
   * constant velocity and notices any departure from it.
   *
   * Which also removes the whole class of problem: nothing touches a moving block between
   * typesets, so nothing can make it stutter.
   *
   * Cached rather than queried per frame anyway: `getAnimations({ subtree: true })` walks
   * every descendant, and on a stage carrying hundreds of flickering characters that is far
   * too much to do sixty times a second.
   */
  syncMotion(): void {
    this.motions = this.el
      .getAnimations({ subtree: true })
      .filter((animation) => {
        const name = (animation as CSSAnimation).animationName;
        return typeof name === 'string' && MOTION_ANIMATIONS.test(name);
      });

    const rate = NOMINAL_BAR_SECONDS / this.currentBar;
    for (const animation of this.motions) animation.updatePlaybackRate(rate);
  }

  private targetBar = NOMINAL_BAR_SECONDS;
  private currentBar = NOMINAL_BAR_SECONDS;
  private publishedBar = NOMINAL_BAR_SECONDS;
  private motions: Animation[] = [];

  /**
   * Publish the chosen palette as the eight colour slots.
   *
   * Written to the stage, and that is now correct rather than a bug: the palette only changes
   * when the VJ picks a different one, which is a deliberate act like switching the
   * background, and should take effect at once. Nothing else moves it — colour reaches a word
   * only through an `accent` layer, which has a target and a trigger like everything else.
   *
   * Short palettes repeat rather than leaving slots empty, so `accent` can pick any slot and
   * always get a colour. An empty palette leaves every slot on the stage foreground, which is
   * what `none` is for.
   */
  setPalette(colours: readonly string[]): void {
    for (let slot = 0; slot < 8; slot++) {
      const colour = colours.length === 0 ? 'var(--stage-fg)' : colours[slot % colours.length];
      this.el.style.setProperty(`--c${slot}`, colour ?? 'var(--stage-fg)');
    }
  }

  /** Sets the base font size all preset sizing is relative to. Mirrors Acid's `--fs`. */
  setFontScale(px: number): void {
    this.el.style.setProperty('--fs', `${px}px`);
  }
}
