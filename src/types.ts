import type { OlibApi } from '../electron/preload';

// Tell TypeScript about the API the preload script attaches to `window`. Without this,
// `window.olib` is an error — the page has no way to know the bridge exists.
declare global {
  interface Window {
    olib: OlibApi;
  }
}

/** Musical position. Produced by the Clock in step 3; faked for now. */
export interface Beat {
  /** Beats since the tracker locked. Fractional between beats. */
  readonly count: number;
  /** Position within the bar, 0–3 in 4/4. */
  readonly inBar: number;
  /** True on the first beat of a bar. */
  readonly isDownbeat: boolean;
}

/** Where the current tempo came from. DESIGN.md §9.4. */
export type ClockSource = 'none' | 'placeholder' | 'detected' | 'tapped';
