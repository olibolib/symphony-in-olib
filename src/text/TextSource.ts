/**
 * Text loading and tokenisation. DESIGN.md §12.3.
 *
 * Four levels: sentences contain lines contain words contain characters.
 *
 * The sentence level exists because selection has to happen there. Cutting by word count
 * or line count produces fragments that end mid-thought — "and at her heels, leashed in
 * like" — which reads as a bug rather than as an effect. Acid could get away with it
 * because Wittgenstein's propositions are short and self-contained; verse is not.
 */

export type Word = string;
export type Line = readonly Word[];
export type Sentence = readonly Line[];

export interface TextPreset {
  readonly name: string;
  readonly lines: readonly Line[];
  readonly sentences: readonly Sentence[];
}

/**
 * Normalisation. Acid stripped everything outside `[A-Za-z0-9 !.?]`, which is worth
 * keeping: punctuation that survives ends up as its own glyph in a grid layout and reads as
 * debris. Terminators are kept precisely because sentence boundaries depend on them.
 */
function normalise(line: string): string {
  return line
    .replace(/[^A-Za-z0-9 !.?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A line ends a sentence if its final word carries a terminator. */
function terminates(line: Line): boolean {
  const last = line[line.length - 1];
  return last !== undefined && /[.!?]$/.test(last);
}

function groupSentences(lines: readonly Line[]): Sentence[] {
  const sentences: Line[][] = [];
  let current: Line[] = [];

  for (const line of lines) {
    current.push(line);
    if (terminates(line)) {
      sentences.push(current);
      current = [];
    }
  }

  // Trailing text with no terminator is still a sentence — dropping it would silently lose
  // the last line of any file that does not end in punctuation.
  if (current.length > 0) sentences.push(current);

  return sentences;
}

export function parseText(name: string, raw: string): TextPreset {
  const lines = raw
    .split(/\r?\n/)
    .map(normalise)
    .filter((line) => line.length > 0)
    .map((line) => line.split(' '));

  return { name, lines, sentences: groupSentences(lines) };
}

/** Words in a sentence. Used to tell short ones from long ones, and for budgeting. */
export function sentenceLength(sentence: Sentence): number {
  return sentence.reduce((total, line) => total + line.length, 0);
}

/** Total words, used for element budgeting (§14). */
export function wordCount(preset: TextPreset): number {
  return preset.lines.reduce((total, line) => total + line.length, 0);
}
