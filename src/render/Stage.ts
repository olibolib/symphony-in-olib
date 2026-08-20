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
    if (this.scrollSpeed === 0) {
      if (this.scrollOffset !== 0) {
        this.scrollOffset = 0;
        this.container.style.removeProperty('transform');
      }
      return;
    }

    const span = Math.max(this.container.scrollHeight, this.height);
    this.scrollOffset = (this.scrollOffset + this.scrollSpeed * this.height * dt) % span;
    this.container.style.transform = `translateY(${-this.scrollOffset}px)`;
  }

  /** Sets the base font size all preset sizing is relative to. Mirrors Acid's `--fs`. */
  setFontScale(px: number): void {
    this.el.style.setProperty('--fs', `${px}px`);
  }
}
