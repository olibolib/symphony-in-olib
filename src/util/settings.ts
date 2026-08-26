/**
 * Where a setting is kept, as a port rather than a global.
 *
 * `localStorage` is a browser global, so any class that touches it directly can only run in a
 * browser. `PresetBank` is the one that costs something: its job is deciding when a preset may
 * change and which one is next, which is pure policy — and it could not be exercised without a
 * DOM purely because its constructor reads a key. DESIGN.md §7.3.
 *
 * Two lines of interface, because that is the whole of what is needed. §7.3 schedules a config
 * file to replace the scattered keys, and when it lands it implements this rather than being
 * threaded through every caller again.
 */
export interface Settings {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

/**
 * The real one. Guarded, because storage can be unavailable or full.
 *
 * A show that cannot remember which preset was live is still a show — losing a setting must
 * never take the stage down with it (§14).
 */
export const browserSettings: Settings = {
  get(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Full, or blocked. Nothing to do about it mid-set.
    }
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // As above.
    }
  },
};

/** An in-memory one, for tests and for anywhere storage is not wanted. */
export function memorySettings(initial: Readonly<Record<string, string>> = {}): Settings {
  const store = new Map(Object.entries(initial));
  return {
    get: (key) => store.get(key) ?? null,
    set: (key, value) => void store.set(key, value),
    remove: (key) => void store.delete(key),
  };
}
