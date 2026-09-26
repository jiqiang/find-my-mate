import type { Firestore } from 'firebase/firestore';

import { createGroup as sessionCreateGroup, loadGroup, type Group } from './session';

/**
 * Which screen the phone shows (spec §7.1): loading until the start-up answer, the start-up error, First
 * run, or sharing. The five rows of §7.1 grow here — #7 adds Waiting, #11 adds a First run notice — so
 * the app shell never holds a decision of its own.
 */
export type Phase =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'firstRun'; uid: string }
  | { name: 'sharing'; uid: string; group: Group };

/** The signed-in phone, as the phase module needs it: the real Firebase signIn also returns a User. */
export type SignIn = () => Promise<{ uid: string }>;

export type PhasesOptions = { db: Firestore; signIn: SignIn };

/**
 * The launch decision behind one interface, shaped like Sharing. It returns synchronously in `loading`,
 * then signs in and reads the stored Group to reach First run or sharing. `createGroup` is First run's
 * Create: on success the phase is sharing with the new Group. `stop()` ends it for good.
 */
export type Phases = {
  readonly phase: Phase;
  subscribe(listener: (phase: Phase) => void): () => void;
  createGroup(yourName: string, groupName: string): Promise<void>;
  stop(): void;
};

/**
 * Starts the launch. Returns before sign-in and the group load answer — the phase is `loading` — so the
 * caller always has something to render and can always `stop()` what it started. A late answer after
 * `stop()` changes nothing and reaches no listener.
 */
export function startPhases({ db, signIn }: PhasesOptions): Phases {
  let phase: Phase = { name: 'loading' };
  let stopped = false;

  const listeners = new Set<(phase: Phase) => void>();

  // Each transition is made once, so this is the only guard needed: a stopped module is silent.
  const setPhase = (next: Phase) => {
    if (stopped) return;
    phase = next;
    for (const listener of listeners) listener(phase);
  };

  void (async () => {
    try {
      const { uid } = await signIn();
      const group = await loadGroup(db, uid);
      setPhase(group ? { name: 'sharing', uid, group } : { name: 'firstRun', uid });
    } catch (error) {
      console.warn('[phases] start-up failed', error);
      setPhase({ name: 'error', message: String(error) });
    }
  })();

  return {
    get phase() {
      return phase;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async createGroup(yourName, groupName) {
      // Create only makes sense once sign-in has named this phone (First run carries its uid).
      if (phase.name !== 'firstRun') throw new Error('Cannot create a Group before First run.');
      const { uid } = phase;
      const group = await sessionCreateGroup(db, uid, yourName, groupName);
      setPhase({ name: 'sharing', uid, group });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      listeners.clear();
    },
  };
}
