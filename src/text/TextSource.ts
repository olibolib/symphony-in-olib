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

  /**
   * Where "short" stops and "long" starts, for this text, in words.
   *
   * Measured from the text itself rather than fixed. It was 12 — Acid's number, chosen against
   * Wittgenstein's propositions, which are short and self-contained. Against a text whose
   * sentences all run to thirty words it called every one of them long, and the `length` filter
   * had nothing to choose between; against a terse one it called none of them long and did the
   * same in reverse. Either way the setting quietly stopped meaning anything.
   *
   * The **median**, so the filter always has a real division to make: half the text is short and
   * half is long, whatever the text is. Computed once when the text is parsed rather than per
   * selection, which is a few times a minute at most.
   */
  readonly longWords: number;
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

  const sentences = groupSentences(lines);
  return { name, lines, sentences, longWords: medianLength(sentences) };
}

/**
 * The middle sentence length, in words. Zero for a text with no sentences in it.
 *
 * A median rather than a mean because sentence lengths are not evenly spread — one
 * twenty-seven-word sentence among thirty short ones would drag a mean up far enough to call
 * the whole text short.
 */
function medianLength(sentences: readonly Sentence[]): number {
  if (sentences.length === 0) return 0;

  const lengths = sentences.map(sentenceLength).sort((a, b) => a - b);
  return lengths[lengths.length >> 1] ?? 0;
}

/** Words in a sentence. Used to tell short ones from long ones, and for budgeting. */
export function sentenceLength(sentence: Sentence): number {
  return sentence.reduce((total, line) => total + line.length, 0);
}

/** Total words, used for element budgeting (§14). */
export function wordCount(preset: TextPreset): number {
  return preset.lines.reduce((total, line) => total + line.length, 0);
}
