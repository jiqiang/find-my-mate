/**
 * The machinery every Firestore-emulator suite shares: standing the emulator up against
 * `firestore.rules`, signing in as a uid, and waiting for the snapshot a test means.
 *
 * The per-suite fixtures (which Group, which Members, which Positions) stay in the suite; only the
 * plumbing lives here. This is imported normally, unlike the React Native stand-ins that
 * `vitest.config.ts` aliases.
 */
import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  onSnapshot,
  setLogLevel,
  type DocumentData,
  type DocumentReference,
  type Firestore,
  type LogLevel,
} from 'firebase/firestore';
import { afterAll, beforeAll } from 'vitest';

const PROJECT_ID = 'demo-find-my-mate';
const SNAPSHOT_TIMEOUT_MS = 5000;

/**
 * This file's emulator. `useRulesEnvironment` assigns it when `beforeAll` runs; the live binding is
 * how the suites read it.
 */
export let env: RulesTestEnvironment;

/**
 * Registers the `beforeAll`/`afterAll` that start the Firestore emulator with `firestore.rules` and
 * tear it down again. Call once at module scope in every emulator-backed suite.
 */
export function useRulesEnvironment(logLevel: LogLevel = 'error'): void {
  beforeAll(async () => {
    setLogLevel(logLevel);
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { rules: readFileSync('firestore.rules', 'utf8') },
    });
  });

  afterAll(async () => {
    await env?.cleanup();
  });
}

// The test contexts hand back the compat Firestore type; the modular API accepts the instance at runtime.
export const modular = (ctx: RulesTestContext) => ctx.firestore() as unknown as Firestore;

/** A Firestore instance signed in as `uid`. */
export const as = (uid: string) => modular(env.authenticatedContext(uid));

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Whether a snapshot may still have the write pending, or must have settled on the server. */
type SnapshotSettlement = 'pending' | 'settled';

/**
 * Resolves with a document's data the next time a snapshot both settles the way `settlement` asks and
 * matches `matches`. Rejects with a readable message if no such snapshot arrives within 5 s.
 *
 * A pending snapshot is this phone's own cache before the server's write has landed; a settled one is
 * the server's view. Which one a test wants is usually the point of the assertion.
 */
export function waitForSnapshot(
  ref: DocumentReference,
  matches: (data: DocumentData) => boolean,
  settlement: SnapshotSettlement = 'settled',
): Promise<DocumentData> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined;
    let settled = false;

    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stop?.();
      action();
    };

    const timer = setTimeout(() => {
      const state = settlement === 'pending' ? 'showed as pending' : 'matched';
      finish(() => reject(new Error(`${ref.path} never ${state} within ${SNAPSHOT_TIMEOUT_MS / 1000} s`)));
    }, SNAPSHOT_TIMEOUT_MS);

    stop = onSnapshot(ref, (snapshot) => {
      const data = snapshot.data();
      if (!data) return;
      const isPending = snapshot.metadata.hasPendingWrites;
      if (settlement === 'pending' ? !isPending : isPending) return;
      if (!matches(data)) return;
      finish(() => resolve(data));
    });

    // A cached snapshot can arrive before `onSnapshot` returns; stop it now that we can.
    if (settled) stop();
  });
}
