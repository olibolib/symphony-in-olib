import { defineConfig } from 'vitest/config';

/**
 * Node only, no DOM.
 *
 * Everything worth testing here is already DOM-free — the clock, the tempo evidence, the
 * placement grid, the preset validator, the cycle policy. Reaching for jsdom would mean the
 * suite could grow to cover the parts that are not, and those are the parts a browser has to
 * answer for anyway. DESIGN.md §15.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
