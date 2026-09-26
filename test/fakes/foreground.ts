import type { Foreground } from '../../src/location';

/** An in-memory foreground signal for Node: the tests decide when the phone is put away and brought back. */
export type FakeForeground = Foreground & { set(active: boolean): void };

export function fakeForeground(initiallyActive = true): FakeForeground {
  let active = initiallyActive;
  const listeners = new Set<(active: boolean) => void>();

  return {
    isActive: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set(next) {
      if (next === active) return;
      active = next;
      for (const listener of listeners) listener(next);
    },
  };
}
