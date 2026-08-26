import type { Stage } from '../render/Stage';
import { anchors, normalise, nudge, placeBlocks, type BlockShape, type Mask } from '../show/mask';
import { pick, randomInt, randomRange } from '../util/random';
import { sentenceLength, type Sentence, type TextPreset } from './TextSource';

/**
 * Turns a text preset into DOM on the stage, and keeps a registry of what it produced.
 *
 * The element structure follows Acid: paragraphs contain words contain characters. Short
 * custom tag names (`w`, `c`) rather than spans — at several thousand nodes the DOM size is
 * worth caring about, and they give clean CSS selectors. Unknown tags are perfectly legal;
 * the browser treats them as generic inline elements and CSS styles them normally.
 */

/**
 * Selection modes, all of which work in whole sentences.
 *
 * `count` means a number of sentences, never words or lines. Cutting by word count
 * produced fragments ending mid-thought, which reads as a bug rather than an effect.
 */
export type TextMode =
  | 'whole'
  | 'sentence'
  | 'sentences'
  | 'shortSentences'
  | 'longSentences'
  | 'word';

export interface TypesetOptions {
  readonly mode: TextMode;
  /** One element per glyph. Required for character effects; costly at scale. */
  readonly splitChars: boolean;
  /** How many sentences. Never a word or line count. */
  readonly count?: number;

  /**
   * Read the text in order rather than sampling it.
   *
   * A **modifier on every mode**, not a mode of its own. Each mode decides *what* the pool
   * is — every sentence, the short ones, the long ones, single words — and this decides
   * whether the next selection is taken at random from that pool or continues from wherever
   * the last one stopped.
   *
   * That is worth more than a seventh mode was: `sentence` + continuous reads a line at a
   * time, `longSentences` + continuous walks the long ones in order, `word` + continuous
   * reads word by word. None of those were reachable before.
   */
  readonly continuous?: boolean;
  /** Put each line in its own paragraph, rather than running them together. */
  readonly separateLines?: boolean;
  /** Hard ceiling on elements produced. DESIGN.md §14 — presets declare a budget. */
  readonly maxElements?: number;
  /**
   * How many independent text blocks to place, 1–3.
   *
   * Each block gets its own selection, so they show different text rather than repeating.
   *
   * They *can* overlap — anchors plus a VJ-chosen size gives up the guarantee the 3x3 grid
   * had by construction — but `avoidOverlap` asks placement to find an arrangement that does
   * not, which with authored shapes it almost always can (§11.6).
   */
  readonly blocks?: number;

  /**
   * Prefer placements where blocks do not overlap. Defaults to on.
   *
   * Changes *which* allowed placement is chosen, never whether a placement happens: if no
   * arrangement avoids overlap, the block is placed anyway. An overlapping block is a
   * visible compromise; a missing one looks like text that failed to render (§14).
   */
  readonly avoidOverlap?: boolean;

  /** Which cells a block may anchor at (§11.6). Already intersected with the global mask. */
  readonly mask?: Mask;

  /** Candidate shapes in cells; one is chosen per block, then rolled within its ranges. */
  readonly shapes?: readonly BlockShape[];


  readonly align?: Align;
  readonly flow?: Flow;

  /** Fine placement in pixels, on top of the anchor cell. */
  readonly offset?: { readonly x: number; readonly y: number };

  /** Hide lines that do not fit entirely inside their block. */
  readonly wholeLines?: boolean;

  /**
   * Text sliding **through** a block that stays put — the conveyor.
   *
   * Looping or single-pass, per `ContentMotion.continuous`.
   */
  readonly contentMotion?: ContentMotion;

  /** The block itself travelling across the canvas. */
  readonly blockMotion?: BlockMotion;

  /**
   * Base size in px, rolled once per typeset and then left alone.
   *
   * `min === max` is a fixed size, which is what `fontScale` used to be. A range makes it a
   * look rather than a setting — and because it is rolled at typeset rather than driven by
   * audio, it costs nothing per frame and nothing has to decay it.
   */
  readonly size?: { readonly min: number; readonly max: number };

  /**
   * What gets its own roll of the size dice. Omit and the whole block matches.
   *
   * Uses `font-size`, and therefore reflows — which is correct here: uneven word sizes need
   * the line to re-wrap around them or the text overlaps itself, and it happens once. The
   * reactive `swell` treatment uses a transform for the opposite reason (§11.5).
   */
  readonly varyBy?: 'word' | 'char';
}

export type Align = 'left' | 'centre' | 'right' | 'justify';

/**
 * Motion, in two kinds. DESIGN.md §11.5.
 *
 * **They are the same movement and a completely different look.** Content motion slides text
 * through a block that stays bolted to the frame; block motion carries the block itself
 * across the canvas. The two only look alike when the block already spans the frame, because
 * only then is the clipping window the whole picture.
 *
 * So they share a speed unit — **fractions of the canvas per four beats** — and set to the
 * same number they move at the same pixels-per-second. What differs is what is bounded: a
 * conveyor is text passing a fixed window, block motion is the window itself travelling.
 */

/** Up or down only. Text scrolling sideways through its own box reads as a fault. */
export interface ContentMotion {
  readonly direction: 'up' | 'down';
  /** Fractions of the canvas per four beats — the same unit block motion uses. */
  readonly speed: number;

  /**
   * Loop for ever, or pass through once.
   *
   * On, it is a belt: the text is duplicated so the wrap is invisible and it never stops.
   * Off, it sweeps through once per typeset and is gone — a different effect worth having,
   * and the cheaper one, since a single pass needs no second copy.
   */
  readonly continuous: boolean;
}

export interface BlockMotion {
  readonly direction: 'up' | 'down' | 'left' | 'right';
  /** Fractions of the canvas per four beats. */
  readonly speed: number;

  /**
   * Wrap round the frame, or cross it once.
   *
   * On, the block re-enters from the opposite edge the instant it leaves — off the right, back
   * on at the left — so there is never a moment with nothing there. Off, it crosses and is
   * gone until the next typeset.
   *
   * It overlaps with `scroll` in the up and down directions, and deliberately: scrolling moves
   * text through a stationary window while this carries the window itself, and the two read
   * completely differently as soon as the block is smaller than the frame.
   */
  readonly continuous: boolean;
}

/**
 * How paragraphs arrange inside a block.
 *
 * What is left of the old layout table once placement and typography are taken out of it:
 * `run-on` was layout 7, `grid` was 6, `wrapped` was 5, and `columns` was 12's two rails.
 * As a setting they combine with any anchor and any size, which none of them could before.
 */
export type Flow = 'stack' | 'run-on' | 'grid' | 'wrapped' | 'columns';

/**
 * Write a motion setting as attributes CSS can act on.
 *
 * Removed rather than set to a direction when off, so the stylesheet needs no "none" case
 * and a stopped block carries no animation at all.
 */
function setMotion(
  container: HTMLElement,
  kind: 'content' | 'block',
  motion: ContentMotion | BlockMotion | undefined,
): void {
  const key = `${kind}Motion`;
  if (!motion || motion.speed <= 0) {
    delete container.dataset[key];
    container.style.removeProperty(`--${kind}-speed`);
    return;
  }

  container.dataset[key] = motion.direction;
  container.style.setProperty(`--${kind}-speed`, String(motion.speed));

  // A wrapping block runs a different pair of keyframes — one canvas rather than two, offset
  // by `--wrap` — so the stylesheet needs to know which it is.
  if (kind === 'block') {
    if ((motion as BlockMotion).continuous) container.dataset['blockLoop'] = '';
    else delete container.dataset['blockLoop'];
  }
}

/** Animations that run for ever, and therefore need their position carried across a typeset. */
const ENDLESS = /^olib-(loop|block)-/;

/** A shape that fills most of the frame. Used when a preset declares none. */
const DEFAULT_SHAPES: readonly BlockShape[] = [
  { cols: { min: 5, max: 5 }, rows: { min: 3, max: 3 } },
];

const DEFAULT_MAX_ELEMENTS = 6000;

export class Typesetter {
  private readonly stage: Stage;

  /**
   * How far `continuous` has read into each text, in sentences.
   *
   * Keyed by text, not global, because a preset can now draw from several (§11.7) and two
   * blocks can be showing different ones at once. A position belongs to a *reading* of a
   * particular passage — sharing one cursor across texts would make each one jump to
   * wherever the last one happened to stop.
   *
   * Not on the preset, though: two presets both set to `continuous` share the thread through
   * the same text, so switching preset mid-poem changes how it looks rather than restarting
   * it.
   */
  private readonly cursors = new Map<string, number>();

  /**
   * Which cursor the selection just made should advance, once the build says how much fitted.
   *
   * Selection has to happen before the build and the advance has to happen after it, so the
   * pool identity is parked here in between rather than being recomputed from the options.
   */
  private pending: { key: string; size: number } | null = null;

  /** Live registries, refreshed on every render so effects never walk a stale DOM. */
  blocks: readonly HTMLElement[] = [];

  /**
   * How many blocks have content that does not fit and is being clipped.
   *
   * Blocks must clip, or they would spill into the protected centre — but §14 says nothing
   * should be lost *silently*. This is reported to the HUD so overfull presets are visible
   * while tuning instead of looking like text that mysteriously failed to appear.
   */
  clipped = 0;

  /** Sentence wrappers. A `<p>` is a *line*; a sentence can be several. */
  sentences: readonly HTMLElement[] = [];

  /**
   * True when the effective mask had no allowed cell, so nothing could be placed.
   *
   * Reported rather than silently rendering an empty stage — a preset that never appears is
   * exactly the kind of thing §14 says must not fail quietly.
   */
  unplaceable = false;
  paragraphs: readonly HTMLElement[] = [];
  words: readonly HTMLElement[] = [];
  chars: readonly HTMLElement[] = [];

  constructor(stage: Stage) {
    this.stage = stage;
  }

  /** Every element that can carry a glitch slot — words when whole, characters when split. */
  get targets(): readonly HTMLElement[] {
    return this.chars.length > 0 ? this.chars : this.words;
  }

  /**
   * @param texts One per block. A preset drawing from several texts (§11.7) rolls one for
   * each block independently, so a short list still tends to put different passages side by
   * side. Fewer entries than blocks is fine — the first is reused.
   */
  render(texts: readonly TextPreset[], options: TypesetOptions): void {
    const blocks = Math.min(3, Math.max(1, options.blocks ?? 1));
    const budget = options.maxElements ?? DEFAULT_MAX_ELEMENTS;

    // Share the element budget across blocks rather than per block, so two blocks cost the
    // same as one rather than twice as much.
    const budgetPerBlock = Math.max(1, Math.floor(budget / blocks));

    const mask = normalise(options.mask);
    const cells = anchors(mask);
    const shapes = options.shapes?.length ? options.shapes : DEFAULT_SHAPES;
    const parts: string[] = [];

    // No allowed cell means nowhere to anchor. Rendering nothing and saying nothing would
    // look exactly like a broken preset, so the caller is told (§14).
    if (cells.length === 0) {
      this.stage.container.innerHTML = '';
      this.refresh();
      this.unplaceable = true;
      return;
    }
    this.unplaceable = false;

    // `count` is a total across blocks, not per block. Passing the full count to each was a
    // bug: two blocks asking for four sentences produced eight, crammed into cells a third
    // of the stage wide, where the surplus was silently clipped.
    const perBlock = Math.max(1, Math.round((options.count ?? 1) / blocks));

    // All blocks are positioned together rather than one at a time, because avoiding
    // overlap needs to see the boxes already placed.
    const boxes = placeBlocks(cells, shapes, blocks, options.avoidOverlap !== false);

    for (let index = 0; index < blocks; index++) {
      const text = texts[index] ?? texts[0];
      if (!text) break;

      // Each block selects independently, so two blocks show different text — except in
      // `continuous` on the same text, where they deliberately show *consecutive* passages
      // and read as one thread split across the frame.
      const lines = this.select(text, { ...options, count: perBlock });

      // Rolled per block, so a tall column can sit beside a wide band — a composition the
      // 3x3 grid could not produce, since every cell there was the same size (§11.6).
      const rolled = boxes[index] ?? boxes[0]!;

      // Pixels in, percentages out: the offset is authored in pixels because that is the unit
      // you think in when nudging something off a grid line, but placement is proportional so
      // the block keeps its position if the stage is ever resized.
      const offset = options.offset ?? { x: 0, y: 0 };
      const box = nudge(
        rolled,
        (offset.x / this.stage.width) * 100,
        (offset.y / this.stage.height) * 100,
      );

      // The box's height, twice: as a length and as a fraction of the canvas.
      //
      // Content motion travels **one box** — the text has to sweep through its own window,
      // and using the canvas there would leave a short strip empty most of the time. But it
      // travels at a **canvas-relative speed**, so text scrolling inside a one-cell strip
      // moves at the same pixels-per-second as a block crossing the whole frame. Same
      // velocity, different look.
      //
      // Two variables because CSS `calc` cannot divide a length by a length: the duration
      // needs the ratio as a plain number, and the translate needs the length.
      //
      // Not `translateY(100%)`, which resolves against the *content's* height — a block
      // holding three screens of text would scroll three times as far for the same setting.
      const boxH = (box.height / 100) * this.stage.height;

      const style =
        `left:${box.left.toFixed(3)}%;top:${box.top.toFixed(3)}%;` +
        `width:${box.width.toFixed(3)}%;height:${box.height.toFixed(3)}%;` +
        `--box-h:${boxH.toFixed(2)}px;--box-hr:${(box.height / 100).toFixed(5)};`;

      const built = this.build(lines, options, budgetPerBlock);

      // The cursor advances by what was *rendered*, not by what was selected. The budget
      // drops whole sentences that will not fit, and advancing past those would skip lines
      // of the text outright — the reading would have holes in it, which is the one thing a
      // continuous reading must not do.
      const pending = this.pending;
      if (pending && pending.size > 0) {
        const at = this.cursors.get(pending.key) ?? 0;
        this.cursors.set(pending.key, (at + built.used) % pending.size);
      }
      this.pending = null;

      parts.push(`<div class="block" data-block="${index}" style="${style}">`);
      // Two nested wrappers: `.block-content` is what moves, `.loop` is one copy of the
      // text. A stationary block has exactly one copy and the extra element costs nothing;
      // a conveyor gets a second, which is what makes the loop seamless (see `makeSeamless`).
      parts.push('<div class="block-content"><div class="loop">');
      parts.push(built.html);
      parts.push('</div></div></div>');
    }

    // One assignment, not an append per word. Parsing a single string is dramatically
    // faster than thousands of DOM insertions, and it is the difference between a preset
    // change being invisible and being a visible hitch.
    // Base size is rolled once here, not per frame and not per trigger. Nothing decays it
    // and nothing follows the audio with it — it is simply how big the text is (§11.5).
    const size = options.size ?? { min: 28, max: 28 };
    this.stage.setFontScale(randomRange(size.min, size.max));

    const container = this.stage.container;
    container.dataset['align'] = options.align ?? 'centre';
    container.dataset['flow'] = options.flow ?? 'stack';

    // Motion is CSS, timed against `--bar`, so it re-times itself on a tempo change and
    // costs nothing per frame — the same reasoning as flicker (§11.5).
    setMotion(container, 'content', options.contentMotion);
    setMotion(container, 'block', options.blockMotion);

    // Where the belt had got to, before the DOM carrying it is destroyed.
    const phases = this.capturePhases();

    container.innerHTML = parts.join('');

    this.refresh();
    if (options.varyBy) this.varySizes(options.varyBy, size);

    // After `refresh`, so the registries hold only originals and a layer targeting "5% of
    // words" cannot pick a copy. After `varySizes`, so the copy inherits the sizes that were
    // rolled rather than a second, different roll.
    // Only a looping conveyor needs a second copy. A single pass has nothing to wrap, so it
    // costs no extra elements at all.
    // One pairing for both kinds of copy, reset here so neither cloner inherits the last
    // typeset's elements.
    this.twins = new WeakMap();

    const conveyor = options.contentMotion;
    if (conveyor && conveyor.speed > 0) this.measureConveyor(conveyor.continuous);

    const travel = options.blockMotion;
    if (travel && travel.speed > 0 && travel.continuous) this.wrapBlocks(travel.direction);

    // After the travel is known, since that is what sets the duration.
    this.applyPhases(phases);

    this.measureLines(options.wholeLines === true);
    this.trimLines();

    this.measureClipping();
  }

  /**
   * One layout read per block, once per re-typeset — a few times a minute, not per frame.
   * That is well inside the §14 rule against reading layout in a loop.
   */
  private measureClipping(): void {
    let clipped = 0;
    for (const block of this.blocks) {
      // A conveyor overflows by design — that is what it is for — so counting it as clipped
      // would report a fault on every phrase and train you to ignore the number.
      if (block.dataset['conveyor'] !== undefined) continue;

      if (
        block.scrollHeight > block.clientHeight + 1 ||
        block.scrollWidth > block.clientWidth + 1
      ) {
        clipped++;
      }
    }
    this.clipped = clipped;
  }

  /**
   * Give every conveyor block a second copy of its text, so the loop never restarts.
   *
   * A single copy can only sweep through and jump back. Duplicating is the only way to get a
   * continuous belt, and the objection to it was never the elements — it was that a layer
   * lighting "5% of words" would pick words in each copy independently, so the same word
   * would flicker differently in its two halves and give the trick away.
   *
   * So the copy is **not** in the registries, and is never targeted. Instead {@link twinOf}
   * pairs each original with its counterpart and `Channels` writes to both, which keeps the
   * two halves identical by construction rather than by luck.
   *
   * The travel distance is `max(content, box)`: the second copy sits exactly that far below
   * the first, and one cycle moves exactly that far, so at the wrap the copy lands where the
   * original began. Using the content height alone would leave a gap whenever the text is
   * shorter than its box.
   */
  private measureConveyor(seamless: boolean): void {
    this.twins = new WeakMap();

    for (const block of this.blocks) {
      const content = block.querySelector<HTMLElement>('.block-content');
      const original = content?.querySelector<HTMLElement>('.loop');
      if (!content || !original) continue;

      // Switch to conveyor layout *before* measuring. It changes the copies from in-flow to
      // absolutely positioned, and a measurement taken under the old layout is a measurement
      // of a different box — which is the difference between a seamless loop and one that
      // jumps every wrap.
      block.dataset['conveyor'] = seamless ? 'loop' : 'once';

      const textH = original.scrollHeight;
      const boxH = block.clientHeight;
      if (textH <= 0 || boxH <= 0) {
        delete block.dataset['conveyor'];
        continue;
      }

      if (!seamless) {
        // One pass: in from below the box, out past the top. Travel is the box plus the text,
        // because both have to clear the window.
        const sweep = boxH + textH;
        block.style.setProperty('--travel', `${sweep.toFixed(2)}px`);
        block.style.setProperty('--travelr', (sweep / this.stage.height).toFixed(5));
        block.style.setProperty('--text-h', `${textH.toFixed(2)}px`);
        continue;
      }

      // A belt. The copy sits exactly one travel below the original and one cycle moves
      // exactly that far, so at the wrap the copy lands where the original began and the
      // seam is never visible.
      //
      // `max(text, box)` rather than the text alone: a passage shorter than its box would
      // otherwise leave a gap between the copies, which is the seam by another name.
      const loop = Math.max(textH, boxH);

      const copy = original.cloneNode(true) as HTMLElement;
      copy.dataset['copy'] = '1';
      // The same words twice — one of them is decoration as far as a reader is concerned.
      copy.setAttribute('aria-hidden', 'true');
      content.append(copy);

      pairUp(original, copy, this.twins);

      block.style.setProperty('--travel', `${loop.toFixed(2)}px`);
      block.style.setProperty('--travelr', (loop / this.stage.height).toFixed(5));
    }
  }

  /**
   * Where each line sits inside its block, so partial ones can be hidden.
   *
   * A conveyor cuts a line in half at the edge it is leaving through, and half a line of type
   * reads as damage rather than as motion — worst at the top, which is the edge text scrolls
   * out of.
   *
   * Measured once here rather than read per frame. `getBoundingClientRect` on every line every
   * frame would be a layout flush sixty times a second, which §14 rules out; the positions
   * only change because the block is being translated, and that translation is known.
   */
  private lines: {
    readonly el: HTMLElement;
    readonly content: HTMLElement | null;
    readonly top: number;
    readonly height: number;
    readonly boxHeight: number;
  }[] = [];

  private measureLines(enabled: boolean): void {
    this.lines = [];
    if (!enabled) return;

    for (const block of this.blocks) {
      const boxHeight = block.clientHeight;
      const content = block.querySelector<HTMLElement>('.block-content');
      const blockTop = block.getBoundingClientRect().top;
      const padding = parseFloat(getComputedStyle(block).paddingTop) || 0;

      // The block may already be part-way through its cycle — the phase is carried across a
      // typeset — so what is measured now includes however far it has been translated.
      // Recording that and taking it back out leaves the line's position *at rest*, which is
      // the only value that stays true for the whole cycle.
      const shift = translateY(content);

      for (const line of block.querySelectorAll<HTMLElement>('p')) {
        const rect = line.getBoundingClientRect();
        this.lines.push({
          el: line,
          // Only a moving block needs re-checking; a still one is decided here and never again.
          content: block.dataset['conveyor'] !== undefined ? content : null,
          top: rect.top - blockTop - padding - shift,
          height: rect.height,
          boxHeight: boxHeight - padding * 2,
        });
      }
    }
  }

  /**
   * Hide any line that does not fit entirely inside its block.
   *
   * Called every frame, but it does no layout work: a line's position is where it was measured
   * plus however far its block has been translated since, and that comes from the animation
   * rather than from the DOM. Writing only on a change keeps it off the compositor's back.
   */
  trimLines(): void {
    if (this.lines.length === 0) return;

    for (const line of this.lines) {
      const top = line.top + translateY(line.content);
      const whole = top >= -0.5 && top + line.height <= line.boxHeight + 0.5;

      // `hidden` rather than removal: the element stays in the registries, so a layer that
      // targeted it keeps its ownership and the line comes back intact when it fits again.
      if (line.el.hidden === whole) {
        line.el.hidden = !whole;
        const twin = this.twins.get(line.el);
        if (twin) twin.hidden = !whole;
      }
    }
  }

  /**
   * How far through their cycles the continuous animations are.
   *
   * A re-typeset replaces the whole stage, so the elements carrying the animations are
   * destroyed and their replacements start from zero — which snaps a conveyor back to the top
   * every phrase or two. Measured at 202px on a half-height block: not a subtle stutter, a
   * visible reset, and the one the frame timings could never explain because nothing was
   * dropping frames.
   *
   * Recorded as a **fraction** rather than a time, because the new text is a different height
   * and therefore a different cycle length. Two thirds of the way through stays two thirds of
   * the way through.
   *
   * Only the endless ones. A single pass should start again for new text — that is the effect.
   */
  private capturePhases(): Map<string, number> {
    const phases = new Map<string, number>();

    for (const animation of this.stage.container.getAnimations({ subtree: true })) {
      const name = (animation as CSSAnimation).animationName;
      if (typeof name !== 'string' || !ENDLESS.test(name)) continue;
      if (phases.has(name)) continue;

      const duration = Number(animation.effect?.getComputedTiming().duration ?? 0);
      const time = Number(animation.currentTime ?? 0);
      if (duration > 0) phases.set(name, (time % duration) / duration);
    }
    return phases;
  }

  /** Put the new animations where the old ones had got to. */
  private applyPhases(phases: Map<string, number>): void {
    if (phases.size === 0) return;

    for (const animation of this.stage.container.getAnimations({ subtree: true })) {
      const name = (animation as CSSAnimation).animationName;
      if (typeof name !== 'string') continue;

      const phase = phases.get(name);
      if (phase === undefined) continue;

      const duration = Number(animation.effect?.getComputedTiming().duration ?? 0);
      if (duration > 0) animation.currentTime = phase * duration;
    }
  }

  /**
   * Give every block a twin one canvas away, so a travelling block wraps rather than leaves.
   *
   * The same construction as the seamless conveyor, one level up: the copy sits exactly one
   * travel behind, and one cycle moves exactly that far, so as the original goes off the right
   * the copy arrives at the left and at the wrap it lands where the original began.
   *
   * The offset is a variable rather than a different position, because the animation owns the
   * transform — the keyframes add `--wrap` at both ends, so the copy runs the same animation
   * shifted by a canvas.
   */
  private wrapBlocks(direction: 'up' | 'down' | 'left' | 'right'): void {
    const container = this.stage.container;
    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
    const size = axis === 'x' ? this.stage.width : this.stage.height;

    // Behind the direction of travel: a block heading right is chased by a copy on its left.
    const back = direction === 'right' || direction === 'down' ? -size : size;

    for (const block of this.blocks) {
      const copy = block.cloneNode(true) as HTMLElement;
      copy.dataset['copy'] = '1';
      copy.setAttribute('aria-hidden', 'true');
      copy.style.setProperty('--wrap', `${back.toFixed(2)}px`);
      container.append(copy);

      pairUp(block, copy, this.twins);
    }
  }

  /**
   * The duplicate of an element in a seamless conveyor, if there is one.
   *
   * Consulted on every channel write, so it is a `WeakMap` lookup rather than a query — and
   * a `WeakMap` in particular because the whole DOM is replaced on every re-typeset and the
   * entries should go with it.
   */
  twinOf(el: HTMLElement): HTMLElement | undefined {
    return this.twins.get(el);
  }

  private twins = new WeakMap<HTMLElement, HTMLElement>();

  /**
   * Give each word or character its own size within the range.
   *
   * Written as a multiplier of the base rather than an absolute, so the two settings stay
   * independent — changing the base range moves everything, and `varyBy` decides how evenly.
   *
   * Applied after the DOM exists rather than baked into the markup string: it is one style
   * write per element on a re-typeset, which happens a few times a minute, and keeping it
   * out of `build` leaves that function about text and nothing else.
   */
  private varySizes(slice: 'word' | 'char', size: { min: number; max: number }): void {
    if (size.max <= size.min) return;

    const elements = slice === 'char' ? this.chars : this.words;
    const base = (size.min + size.max) / 2;

    for (const el of elements) {
      const px = size.min + Math.random() * (size.max - size.min);
      el.style.fontSize = `${(px / base).toFixed(3)}em`;
    }
  }

  clear(): void {
    this.stage.container.innerHTML = '';
    this.refresh();
  }

  private refresh(): void {
    const root = this.stage.container;
    this.blocks = Array.from(root.querySelectorAll<HTMLElement>('.block'));
    this.sentences = Array.from(root.querySelectorAll<HTMLElement>('sn'));
    this.paragraphs = Array.from(root.querySelectorAll<HTMLElement>('p'));
    this.words = Array.from(root.querySelectorAll<HTMLElement>('w'));
    this.chars = Array.from(root.querySelectorAll<HTMLElement>('c'));
  }

  /**
   * Pick which sentences to show. DESIGN.md §12.3.
   *
   * Two decisions, deliberately separated: the **mode** says what the pool is, and
   * `continuous` says whether to sample it or read it in order. Every mode gets both
   * behaviours for free, where a `continuous` *mode* could only ever have had one pool.
   */
  private select(preset: TextPreset, options: TypesetOptions): readonly Sentence[] {
    const { sentences } = preset;
    if (sentences.length === 0) return [];

    const count = Math.max(1, options.count ?? 1);
    const continuous = options.continuous === true;

    switch (options.mode) {
      // The whole text every time. There is nothing to sample and nothing to advance, so
      // the modifier has no meaning here — which is itself the "repeat the whole" case.
      case 'whole':
        return sentences;

      case 'word':
        return this.selectWord(preset, continuous);

      case 'sentence':
        return this.take(preset, sentences, 1, continuous, 'sentence');

      case 'sentences':
        return this.take(preset, sentences, count, continuous, 'sentences');

      case 'shortSentences':
        return this.take(
          preset,
          pool(sentences, (x) => sentenceLength(x) <= 12),
          count,
          continuous,
          'short',
        );

      case 'longSentences':
        return this.take(
          preset,
          pool(sentences, (x) => sentenceLength(x) > 12),
          count,
          continuous,
          'long',
        );

      default:
        return sentences;
    }
  }

  /**
   * Take `count` from a pool, in order or at random.
   *
   * Both paths wrap rather than stopping short, so the end of a text is followed by its
   * beginning instead of by a gap.
   *
   * The cursor is keyed by text **and** by pool: a position among the long sentences means
   * nothing to a reading of the short ones, so sharing one cursor would make a preset change
   * jump to an unrelated point. Within the same pool two presets do share the thread, which
   * is what makes switching preset mid-poem change how it looks rather than where it is.
   */
  private take(
    preset: TextPreset,
    from: readonly Sentence[],
    count: number,
    continuous: boolean,
    pool: string,
  ): readonly Sentence[] {
    if (from.length === 0) return [];
    const span = Math.min(count, from.length);

    const start = continuous
      ? (this.cursors.get(`${preset.name}|${pool}`) ?? 0) % from.length
      : randomInt(from.length);

    const out: Sentence[] = [];
    for (let i = 0; i < span; i++) {
      const sentence = from[(start + i) % from.length];
      if (sentence) out.push(sentence);
    }

    // Where the reading resumes is decided after the build, by how much actually fitted —
    // see `render`. Recording the pool here is what lets it find the right cursor.
    this.pending = continuous ? { key: `${preset.name}|${pool}`, size: from.length } : null;
    return out;
  }

  /**
   * A single word, isolated.
   *
   * The one deliberate fragment: it reads as emphasis rather than as truncation, because
   * there is obviously nothing missing. Continuous walks the text word by word, which is a
   * different thing again — the passage arrives one word per phrase.
   */
  private selectWord(preset: TextPreset, continuous: boolean): readonly Sentence[] {
    const words: string[] = [];
    for (const sentence of preset.sentences) {
      for (const line of sentence) words.push(...line);
    }
    if (words.length === 0) return [];

    if (!continuous) {
      const word = pick(words);
      this.pending = null;
      return word ? [[[word]]] : [];
    }

    const key = `${preset.name}|word`;
    const at = (this.cursors.get(key) ?? 0) % words.length;
    this.cursors.set(key, (at + 1) % words.length);
    this.pending = null;

    const word = words[at];
    return word ? [[[word]]] : [];
  }

  /**
   * Build the markup.
   *
   * The budget is checked *between* sentences, never inside one. Stopping mid-sentence to
   * stay under an element count produces exactly the fragment this whole redesign exists to
   * avoid — so a sentence is either rendered whole or not at all.
   *
   * The first sentence always renders even if it alone exceeds the budget: a blank stage is
   * a worse failure than a busy one.
   */
  private build(
    sentences: readonly Sentence[],
    options: TypesetOptions,
    budget: number,
  ): { html: string; used: number } {
    const parts: string[] = [];
    let produced = 0;
    let slot = 0;
    let used = 0;

    for (const sentence of sentences) {
      const cost = sentenceCost(sentence, options.splitChars);
      if (produced > 0 && produced + cost > budget) break;

      // A sentence is several lines, so it needs an element of its own to be addressable —
      // `<p>` is a line here, not a sentence. `<sn>` rather than `<s>`, which is
      // strikethrough. It is `display: contents`, so it adds no box and the flow layouts
      // treat the paragraphs exactly as they did before.
      parts.push('<sn>');

      for (const line of sentence) {
        parts.push('<p>');

        for (const word of line) {
          // `data-len` lets CSS treat long and short words differently, as Acid does.
          //
          // No colour slot any more. Acid gave every word one and coloured it whether anything
          // had targeted it or not; colour now reaches a word only through an `accent` layer,
          // so an untouched word is the stage foreground and nothing else. The scattered
          // colour that slot gave for free is still available — as a layer, on `enter`, with
          // no decay — and having to ask for it is the point.
          const long = word.length >= 4 ? '1' : '0';
          parts.push(`<w data-len="${long}">`);

          if (options.splitChars) {
            for (const char of word) {
              // The character code is what lets an effect find every instance of one letter
              // at once — `c[data-ch="101"]` is every "e" on the stage (§12.2).
              parts.push(`<c data-ch="${char.charCodeAt(0)}">${escapeHtml(char)}</c>`);
            }
          } else {
            parts.push(escapeHtml(word));
          }

          parts.push('</w>');
          slot++;
        }

        parts.push('</p>');
      }

      parts.push('</sn>');
      produced += cost;
      used++;
    }

    return { html: parts.join(''), used };
  }
}

/**
 * Sentences matching a filter, falling back to all of them.
 *
 * A text with no long sentences in it should still show something. Returning an empty pool
 * would leave the stage blank with nothing to explain it.
 */
function pool(
  sentences: readonly Sentence[],
  matches: (sentence: Sentence) => boolean,
): readonly Sentence[] {
  const filtered = sentences.filter(matches);
  return filtered.length > 0 ? filtered : sentences;
}

/**
 * Walk two identical trees together, pairing element to element.
 *
 * The copy is a `cloneNode(true)` of the original, so the two are structurally identical and
 * a parallel walk pairs them exactly. Cheaper and steadier than matching on an index
 * attribute, which would need writing during the build and querying afterwards.
 */
function pairUp(
  original: HTMLElement,
  copy: HTMLElement,
  twins: WeakMap<HTMLElement, HTMLElement>,
): void {
  // Paragraphs as well as words and characters: line trimming hides `<p>` elements, and a
  // copy that kept showing a line its twin had hidden would give itself away at once.
  const from = original.querySelectorAll<HTMLElement>('w, c, p');
  const to = copy.querySelectorAll<HTMLElement>('w, c, p');
  const count = Math.min(from.length, to.length);

  for (let i = 0; i < count; i++) {
    const a = from[i];
    const b = to[i];
    if (a && b) twins.set(a, b);
  }
}

/**
 * How far an element has been moved down by its transform, in pixels.
 *
 * Read from the computed style rather than the animation, because that is the value actually
 * on screen this frame — the animation's own `currentTime` is a description of where it should
 * be, and the two can disagree by a frame.
 */
function translateY(el: HTMLElement | null): number {
  if (!el) return 0;
  const transform = getComputedStyle(el).transform;
  if (transform === 'none') return 0;
  return parseFloat(transform.split(',')[5] ?? '0') || 0;
}

/** Elements a sentence will produce, so the budget can be checked before committing to it. */
function sentenceCost(sentence: Sentence, splitChars: boolean): number {
  let total = 0;
  for (const line of sentence) {
    for (const word of line) total += splitChars ? word.length : 1;
  }
  return total;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;',
  );
}
