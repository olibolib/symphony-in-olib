/**
 * Whether a keystroke belongs to something the user is typing into.
 *
 * Shortcuts here are bare keys — space taps the tempo — because a VJ reaching for a modifier
 * mid-set is a VJ looking at the keyboard. The cost is that any shortcut using an ordinary
 * character will swallow that character unless it stands aside, and space was being taken
 * before a text field ever saw it: a space in the middle of a sentence tapped the tempo
 * instead of appearing.
 *
 * A `<select>` counts as typing. Space opens it, and a dropdown that will not open reads as
 * broken.
 *
 * Buttons and checkboxes deliberately do **not**. They are clicked in this app, and after
 * clicking one the next space is far more likely to be a tap than an attempt to press the
 * same control again — so tapping keeps working when focus happens to be resting on a button.
 */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return true;

  return (
    target instanceof HTMLInputElement &&
    !['checkbox', 'radio', 'button', 'submit', 'range', 'color'].includes(target.type)
  );
}
