/**
 * Which preset the editor should be showing.
 *
 * Its own function because the decision has a trap in it, and the same trap has been fallen
 * into twice elsewhere: the documents arrive **in two waves**. The engine publishes the
 * compiled presets immediately so the window has something to draw, then publishes again once
 * the folder has been read. A preset the user made themselves does not exist in the first
 * wave, so a remembered name has to survive not being found and be looked for again.
 */
export interface Choice {
  /** The preset to show, or null when there are none. */
  readonly name: string | null;
  /** Whether the remembered name was found, so it need not be looked for again. */
  readonly restored: boolean;
}

export function chooseSelected(
  names: readonly string[],
  current: string | null,
  remembered: string | null,
  restored: boolean,
): Choice {
  if (names.length === 0) return { name: null, restored };

  // Look for the remembered preset until it turns up. Giving up after the first wave is
  // what would leave the editor on the head of the list every launch.
  if (!restored && remembered !== null && names.includes(remembered)) {
    return { name: remembered, restored: true };
  }

  // An explicit choice always stands, including one made before the folder finished loading.
  if (current !== null && names.includes(current)) return { name: current, restored };

  // Either nothing is chosen yet, or what was chosen has been deleted or renamed.
  return { name: names[0] ?? null, restored };
}
