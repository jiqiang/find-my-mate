import type { Firestore } from 'firebase/firestore';

import {
  becomeMember,
  createGroup as sessionCreateGroup,
  joinGroup as sessionJoinGroup,
  leaveGroup as sessionLeaveGroup,
  loadStart,
  watchJoinRequest,
  watchMembership,
  type Group,
  type JoinRequestStatus,
  type JoinResult,
} from './session';

/**
 * The line a removed phone reads on First run (spec §5, §7.1 row 4). It is the same whether the Owner
 * removed the phone or the phone left on another install: either way it is no longer in the Group.
 */
export const REMOVED_NOTICE = "You're no longer in this group.";

/**
 * Which screen the phone shows (spec §7.1): loading until the start-up answer, the start-up error, First
 * run, Waiting, or sharing. The rows of §7.1 grow here — #7 adds Waiting, #11 the First run notice — so the
 * app shell never holds a decision of its own.
 */
export type Phase =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'firstRun'; uid: string; notice?: string }
  | { name: 'waiting'; uid: string; groupId: string; groupName: string; ownerName: string }
  | { name: 'sharing'; uid: string; group: Group; justJoined?: true };

/** The signed-in phone, as the phase module needs it: the real Firebase signIn also returns a User. */
export type SignIn = () => Promise<{ uid: string }>;

export type PhasesOptions = { db: Firestore; signIn: SignIn };

/**
 * The launch decision behind one interface, shaped like Sharing. It returns synchronously in `loading`,
 * then signs in and reads the stored Group to reach First run, Waiting or sharing. `createGroup` is First
 * run's Create and `join` is its Join (a wrong code comes back, and the phase does not move). While
 * Waiting, it follows this phone's own Join request, so an approval lands on the map and a request deleted
 * under it returns to First run. While sharing, it follows its own membership, so a removed phone lands on
 * First run with the notice, and `leave` is the Member's own Leave. `stop()` ends it for good.
 */
export type Phases = {
  readonly phase: Phase;
  subscribe(listener: (phase: Phase) => void): () => void;
  createGroup(yourName: string, groupName: string): Promise<void>;
  join(code: string, yourName: string): Promise<JoinResult>;
  leave(): Promise<void>;
  stop(): void;
};

/**
 * Starts the launch. Returns before sign-in and the start read answer — the phase is `loading` — so the
 * caller always has something to render and can always `stop()` what it started. A late answer after
 * `stop()` changes nothing and reaches no listener.
 */
export function startPhases({ db, signIn }: PhasesOptions): Phases {
  let phase: Phase = { name: 'loading' };
  let stopped = false;
  let stopWatching: (() => void) | undefined;
  // True for the moment a Leave is in flight: the removal it causes must not read back as being removed.
  let leaving = false;

  const listeners = new Set<(phase: Phase) => void>();

  // Each transition is made once, so this is the only guard needed: a stopped module is silent.
  const setPhase = (next: Phase) => {
    if (stopped) return;
    phase = next;
    for (const listener of listeners) listener(phase);
  };

  const clearWatch = () => {
    stopWatching?.();
    stopWatching = undefined;
  };

  /**
   * Materialises the approved joiner's own Member document, then lands on the map (§7.1 row 3, §7.3). The
   * `justJoined` marks the one arrival the map greets: this phone only becomes a Member by being approved,
   * so its first map gets the one-off banner; a later launch reads the Member document and lands without it.
   */
  async function land(uid: string, groupId: string, groupName: string): Promise<void> {
    try {
      const group = await becomeMember(db, uid, groupId, groupName);
      if (stopped) return;
      enterSharing(uid, group, true);
    } catch (error) {
      console.warn('[phases] could not write this phone in as a Member', error);
      if (!stopped) setPhase({ name: 'error', message: String(error) });
    }
  }

  /**
   * Enters sharing and follows this phone's own membership, so a Member the Owner removes while the map is
   * open lands on First run with the notice (spec §5). Only a non-Owner is followed: an Owner has no Join
   * request and cannot be removed, and following one would look like an immediate removal.
   */
  function enterSharing(uid: string, group: Group, justJoined?: true): void {
    if (stopped) return;
    clearWatch();
    leaving = false;
    setPhase({ name: 'sharing', uid, group, justJoined });
    if (group.role === 'owner') return;
    stopWatching = watchMembership(db, group.id, uid, (present) => {
      if (!present) onMembershipGone(uid);
    });
  }

  /** The membership watch said the Group is gone: this phone was removed while it was on the map. */
  function onMembershipGone(uid: string): void {
    if (stopped || leaving) return;
    clearWatch();
    setPhase({ name: 'firstRun', uid, notice: REMOVED_NOTICE });
  }

  /** Enters Waiting and follows this phone's own Join request until it is approved, deleted or stopped. */
  function enterWaiting(uid: string, groupId: string, groupName: string, ownerName: string): void {
    clearWatch();
    setPhase({ name: 'waiting', uid, groupId, groupName, ownerName });
    stopWatching = watchJoinRequest(db, groupId, uid, (status) =>
      onRequestChange(uid, groupId, groupName, status),
    );
  }

  function onRequestChange(
    uid: string,
    groupId: string,
    groupName: string,
    status: JoinRequestStatus,
  ): void {
    if (stopped) return;
    if (status === 'approved') void land(uid, groupId, groupName);
    else if (status === 'gone') void readStart(uid);
  }

  /** The §7.1 rows for a signed-in phone: member, Waiting, approved-while-closed, removed, or First run. */
  async function readStart(uid: string): Promise<void> {
    const start = await loadStart(db, uid);
    if (stopped) return;
    switch (start.kind) {
      case 'member':
        enterSharing(uid, start.group);
        break;
      case 'waiting':
        enterWaiting(uid, start.groupId, start.groupName, start.ownerName);
        break;
      case 'approved':
        await land(uid, start.groupId, start.groupName);
        break;
      case 'removed':
        setPhase({ name: 'firstRun', uid, notice: REMOVED_NOTICE });
        break;
      case 'firstRun':
        setPhase({ name: 'firstRun', uid });
        break;
    }
  }

  void (async () => {
    try {
      const { uid } = await signIn();
      await readStart(uid);
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
      enterSharing(uid, group);
    },
    async join(code, yourName) {
      // Join only makes sense from First run, where the signed-in uid is known.
      if (phase.name !== 'firstRun') throw new Error('Cannot join a Group before First run.');
      const { uid } = phase;
      const result = await sessionJoinGroup(db, uid, code, yourName);
      if (result.ok && !stopped) {
        enterWaiting(uid, result.groupId, result.groupName, result.ownerName);
      }
      return result;
    },
    async leave() {
      // Leave only makes sense from the map, and never for the Owner (spec §7.5): the rules deny it too.
      if (phase.name !== 'sharing') throw new Error('Cannot leave a Group before the map.');
      if (phase.group.role === 'owner') throw new Error('The Owner cannot leave the Group.');
      const { uid, group } = phase;
      // The removal deletes this phone's own Join request, which its membership watch would read as being
      // removed; `leaving` keeps that from overwriting the plain First run Leave lands on.
      leaving = true;
      try {
        await sessionLeaveGroup(db, uid, group.id);
      } catch (error) {
        leaving = false;
        throw error;
      }
      clearWatch();
      setPhase({ name: 'firstRun', uid });
    },
    stop() {
      if (stopped) return;
      stopped = true;
      clearWatch();
      listeners.clear();
    },
  };
}
