import { GRID, isAllowed, normalise, toggle, type Mask } from '../show/mask';

/**
 * A clickable picture of the frame. DESIGN.md §11.6.
 *
 * Used twice: for the VJ's global mask in the Canvas tab, and for a preset's own mask in the
 * Presets tab. Extracted rather than duplicated because the two must agree about what a lit
 * cell means — and they mean subtly different things (a hard rule for tonight versus one
 * preset's composition), which is exactly the case where two copies drift apart.
 */
export class MaskGrid {
  private readonly root: HTMLElement;
  private mask: Mask;

  onChange: ((mask: Mask) => void) | null = null;

  constructor(root: HTMLElement, initial: Mask) {
    this.root = root;
    this.mask = normalise(initial);
    this.build();
    this.paint();
  }

  get value(): Mask {
    return this.mask;
  }

  /**
   * Show a mask.
   *
   * Cells are built once and only their state is written afterwards. State arrives with
   * every snapshot — twenty times a second — and rebuilding forty-nine elements at that rate
   * would fight the user for their own click.
   */
  set(mask: Mask): void {
    const next = normalise(mask);
    if (same(next, this.mask)) return;
    this.mask = next;
    this.paint();
  }

  private build(): void {
    this.root.style.setProperty('--mask-cols', String(GRID));

    for (let row = 0; row < GRID; row++) {
      for (let col = 0; col < GRID; col++) {
        const cell = document.createElement('button');
        cell.type = 'button';
        cell.className = 'mask-cell';
        cell.dataset['row'] = String(row);
        cell.dataset['col'] = String(col);
        cell.setAttribute('aria-label', `Row ${row + 1}, column ${col + 1}`);
        cell.addEventListener('click', () => this.apply(toggle(this.mask, row, col)));
        this.root.append(cell);
      }
    }
  }

  private paint(): void {
    for (const child of this.root.children) {
      const el = child as HTMLElement;
      const on = isAllowed(this.mask, Number(el.dataset['row']), Number(el.dataset['col']));
      el.classList.toggle('on', on);
      el.setAttribute('aria-pressed', String(on));
    }
  }

  /**
   * Paint first, then report.
   *
   * The snapshot that confirms a change is up to 50ms away, and a toggle that visibly lags
   * its own click feels broken even while it is working correctly.
   */
  apply(mask: Mask): void {
    const next = normalise(mask);
    if (same(next, this.mask)) return;
    this.mask = next;
    this.paint();
    this.onChange?.(this.mask);
  }

  /**
   * Flip every cell.
   *
   * Refused when it would leave nothing allowed — the one state worth blocking, since every
   * preset would then be skipped and the stage would empty with no indication why.
   */
  invert(): void {
    const flipped = this.mask.map((line) =>
      Array.from(line, (char) => (char === '#' ? '.' : '#')).join(''),
    );
    if (flipped.some((line) => line.includes('#'))) this.apply(flipped);
  }
}

/** Cheap equality, so a snapshot arriving 20 times a second does not redraw 49 elements. */
function same(a: Mask, b: Mask): boolean {
  return a.length === b.length && a.every((row, i) => row === b[i]);
}
