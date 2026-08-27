import type { LayerSpec } from './Layer';
import type { PresetDoc } from '../ipc/protocol';
import type { BlockMotion, ContentMotion } from '../text/Typesetter';
import { anchors, intersect, normalise, type Mask } from './mask';
import type { TextPreset } from '../text/TextSource';

/**
 * The decisions the engine makes between a preset and the typesetter.
 *
 * All four were functions inside `main.ts`, reading module state and calling into the HUD. They
 * are pure and they decide things worth being sure about — whether a slider drag re-lays out
 * the stage, which mask an error should blame — so they live where they can be exercised
 * without a DOM. The engine calls them and acts on the answers.
 */

/**
 * Pull the motion settings out of the layer list.
 *
 * Motion is authored as a layer so a preset is described in one place, but it is applied by the
 * typesetter rather than by writing to elements — so it has to be found again here.
 *
 * **The last one wins**, which is the same rule channels follow: layers are ordered and later
 * ones sit on top. Two scroll layers is not a sensible preset, but it is an easy one to end up
 * with while experimenting, and silently using the first would be the surprising answer.
 */
export function motionOptions(layers: readonly LayerSpec[]): {
  contentMotion?: ContentMotion;
  blockMotion?: BlockMotion;
} {
  let content: ContentMotion | undefined;
  let block: BlockMotion | undefined;

  for (const layer of layers) {
    const motion = layer.motion;
    if (!motion || motion.speed <= 0) continue;

    if (layer.treatment === 'scroll' && (motion.direction === 'up' || motion.direction === 'down')) {
      content = {
        direction: motion.direction,
        speed: motion.speed,
        continuous: motion.continuous !== false,
      };
    } else if (layer.treatment === 'travel') {
      // Only the axis being travelled along can wrap, so the other toggle is simply not
      // consulted — it is there for when the direction changes.
      const sideways = motion.direction === 'left' || motion.direction === 'right';
      block = {
        direction: motion.direction,
        speed: motion.speed,
        continuous: (sideways ? motion.wrapSide : motion.wrapTop) !== false,
      };
    }
  }

  return {
    ...(content ? { contentMotion: content } : {}),
    ...(block ? { blockMotion: block } : {}),
  };
}

/** How the stage breathes, if a preset asks for it. */
export interface PulseSpec {
  readonly amount: number;
  readonly shape: 'decay' | 'sine';

  /**
   * How long one breath is, in bars. 0.25 is a beat, 1 a bar, 4 a phrase.
   *
   * The same unit as `flicker`'s rate and as decay, because it is the same kind of decision.
   * Pulse arrived from Acid welded to the beat and stayed that way while everything around it
   * learned to be expressed in bars.
   */
  readonly rateBars: number;
}

/**
 * Pull the pulse out of the layer list.
 *
 * The same shape as {@link motionOptions}, and for the same reason: `pulse` is authored as a
 * layer so a preset is described in one place, but it is applied to the stage every frame
 * rather than written to elements — so it has to be found again here.
 *
 * **The last one wins**, like channels and like motion. Two pulse layers is not a sensible
 * preset but it is an easy one to end up with while experimenting.
 */
export function pulseOptions(layers: readonly LayerSpec[]): PulseSpec | null {
  let found: PulseSpec | null = null;

  for (const layer of layers) {
    if (layer.treatment !== 'pulse') continue;
    const spec = layer.pulse;
    if (!spec || spec.amount <= 0) continue;
    // A beat, unless the layer says otherwise — which is what it always did.
    found = { amount: spec.amount, shape: spec.shape, rateBars: layer.rateBars ?? 0.25 };
  }

  return found;
}

/**
 * The stage scale for a pulse at this point in its cycle.
 *
 * Driven by the predicted grid rather than by detected onsets, so it stays smooth and in time
 * through a passage with no transients — and lands *on* the beat rather than just after it.
 */
export function pulseAt(spec: PulseSpec, phase: number): number {
  const curve =
    spec.shape === 'sine'
      ? (1 - Math.cos(phase * Math.PI * 2)) / 2
      : (1 - phase) * (1 - phase);

  return curve * spec.amount;
}

/**
 * Whether an edit changes where text goes, rather than what happens to it.
 *
 * This is what keeps the editor usable. A layer change is pushed into the running stack in
 * place; anything here forces a re-typeset, and a re-typeset while you are dragging a slider
 * strobes the stage. So the two have to be told apart exactly — being over-eager here is not a
 * cosmetic problem.
 */
export function needsRetypeset(before: PresetDoc, after: PresetDoc): boolean {
  return (
    JSON.stringify(before.text) !== JSON.stringify(after.text) ||
    JSON.stringify(before.spawn) !== JSON.stringify(after.spawn) ||
    JSON.stringify(before.blockShapes) !== JSON.stringify(after.blockShapes) ||
    before.align !== after.align ||
    before.flow !== after.flow ||
    before.avoidOverlap !== after.avoidOverlap
  );
}

/**
 * Which mask left a preset nowhere to go, in the words the HUD should say. Null if none did.
 *
 * The two grids look identical and sit one tab apart, so a message that only says "no space"
 * sends you to widen whichever one you happen to be looking at — which half the time is the one
 * that was never the problem. Three ways to have no cells, three messages, three tabs.
 */
export function blockedMessage(preset: string, spawn: Mask, global: Mask): string | null {
  if (anchors(intersect(global, spawn)).length > 0) return null;

  if (anchors(normalise(global)).length === 0) {
    return 'The global mask has no cells, so nothing can be placed — allow some in the Canvas tab';
  }

  if (anchors(normalise(spawn)).length === 0) {
    return `"${preset}" has no cells of its own — allow it some in the Presets tab`;
  }

  return `The global mask is blocking "${preset}" — allow it some cells in the Canvas tab`;
}

/**
 * One text per block, drawn from the ones this preset is pinned to.
 *
 * `'default'` is not a filename — it is a reference to whatever the text menu has selected, so
 * it keeps following the menu as it changes mid-set (§11.7). A pinned name that no longer
 * exists resolves the same way rather than leaving a block empty: a text can be deleted between
 * sessions, and a blank block is indistinguishable from a render failure.
 */
export function textsForBlocks(
  pinned: readonly string[],
  blocks: number,
  active: TextPreset,
  byName: ReadonlyMap<string, TextPreset>,
  choose: (count: number) => number = (count) => Math.floor(Math.random() * count),
): readonly TextPreset[] {
  const options = pinned.length > 0 ? pinned : ['default'];

  const out: TextPreset[] = [];
  for (let i = 0; i < blocks; i++) {
    const name = options[choose(options.length)] ?? 'default';
    out.push(name === 'default' ? active : (byName.get(name) ?? active));
  }
  return out;
}
