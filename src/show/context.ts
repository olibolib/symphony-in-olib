import type { Channels } from './Channels';
import type { Typesetter } from '../text/Typesetter';

/**
 * What a layer is handed when it fires. DESIGN.md §11.5.
 *
 * Four fields, which is all a layer has ever needed: the elements to choose from, the ledger to
 * write through, and the two numbers decay is derived from.
 *
 * It carried ten. The other six — the stage, the palette, the energy and bass levels, the beat
 * phase, the text age and a `retext` callback reaching back into the engine — existed for the
 * stage effects, and were the reason a closure was the path of least resistance for anything
 * new: when the context is a god object, nothing is ever forced into data. The effects are
 * gone, so this is what is left.
 *
 * Built fresh each frame, so a layer always sees current values.
 */
export interface EffectContext {
  /** The elements a target chooses from. */
  readonly typesetter: Typesetter;

  /** Who owns which property on which element, and how it fades. */
  readonly channels: Channels;

  /** Seconds since the previous frame. Decay is elapsed-time based, not per-frame (§11.5). */
  readonly dt: number;

  /** The bar length the visual is actually running at, so a fade in bars means bars. */
  readonly barSeconds: number;
}
