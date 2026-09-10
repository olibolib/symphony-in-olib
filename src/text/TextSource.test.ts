import { describe, expect, it } from 'vitest';
import { parseText, sentenceLength, wordCount } from './TextSource';

/**
 * Parsing a text, and measuring it. DESIGN.md §12.3.
 *
 * The measurement is the interesting part: where "short" stops and "long" starts is taken from
 * the text rather than fixed, so the `length` filter always has a real division to make.
 */

const lines = (...ls: string[]): string => ls.join('\n');

/** A sentence of `n` words, terminated. */
const sentence = (n: number): string => `${Array(n).fill('word').join(' ')}.`;

describe('parseText', () => {
  it('splits lines into words', () => {
    const text = parseText('t', 'one two three');
    expect(text.lines).toEqual([['one', 'two', 'three']]);
  });

  it('drops blank lines', () => {
    expect(parseText('t', lines('one', '', '  ', 'two')).lines).toHaveLength(2);
  });

  it('runs a sentence across several lines', () => {
    // A `<p>` is a line; a sentence is however many it takes to reach a terminator.
    const text = parseText('t', lines('the first part', 'and the rest.'));
    expect(text.sentences).toHaveLength(1);
    expect(sentenceLength(text.sentences[0]!)).toBe(6);
  });

  it('counts every word in the text', () => {
    expect(wordCount(parseText('t', lines('one two', 'three')))).toBe(3);
  });

  it('survives an empty text', () => {
    const text = parseText('t', '');
    expect(text.lines).toEqual([]);
    expect(text.sentences).toEqual([]);
    expect(text.longWords).toBe(0);
  });
});

describe('longWords', () => {
  it('sits in the middle of the text it came from', () => {
    // Five sentences of 2, 4, 6, 8 and 10 words: the middle one is 6.
    const text = parseText('t', lines(sentence(2), sentence(4), sentence(6), sentence(8), sentence(10)));
    expect(text.longWords).toBe(6);
  });

  it('moves with the text', () => {
    // The whole point. Acid's fixed 12 called every sentence in a long-winded text "long" and
    // every sentence in a terse one "short", and the filter stopped meaning anything either way.
    const terse = parseText('t', lines(sentence(2), sentence(3), sentence(4)));
    const wordy = parseText('t', lines(sentence(30), sentence(40), sentence(50)));

    expect(terse.longWords).toBeLessThan(wordy.longWords);
    expect(terse.longWords).toBe(3);
    expect(wordy.longWords).toBe(40);
  });

  it('is not dragged about by one outlier', () => {
    // A median, not a mean: one very long sentence among short ones would pull a mean up far
    // enough to call the whole text short.
    const withOutlier = parseText('t', lines(sentence(2), sentence(3), sentence(4), sentence(200)));
    expect(withOutlier.longWords).toBeLessThan(20);
  });

  it('always leaves something on each side, given any variety', () => {
    const text = parseText('t', lines(sentence(2), sentence(6), sentence(10), sentence(20)));
    const short = text.sentences.filter((s) => sentenceLength(s) <= text.longWords);
    const long = text.sentences.filter((s) => sentenceLength(s) > text.longWords);

    expect(short.length).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(0);
  });
});
