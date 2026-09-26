import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteDoc, disableNetwork, writeBatch } from 'firebase/firestore';
import { beforeEach, describe, expect, it } from 'vitest';

import { as, env, modular, sleep, useRulesEnvironment } from './fakes/rules';
import { addCreateGroup, memberRef } from '../src/groupDocs';
import { startPhases, type Phase, type Phases } from '../src/phases';

// Ways the phase decision (ticket 15) could fail, written before src/phases.ts:
//  1. startPhases does not return straight away in loading, so the app shows a blank or stale screen.
//  2. It decides before sign-in and the stored-Group load answer, so an empty screen reads as a verdict.
//  3. No stored Group strands the phone in loading instead of reaching First run.
//  4. First run carries a uid that is not the signed-in one, so Create would write someone else's Member.
//  5. A stored Group this phone is a Member of lands on First run, or loses the Group's name.
//  6. A stored groupId whose Member document is gone, or whose read is denied, is treated as membership.
//  7. A sign-in or group-load failure reaches First run or sharing instead of the error phase.
//  8. The error phase drops the message, so the UI cannot say what went wrong.
//  9. createGroup success leaves the phase at First run, so the map never opens.
// 10. createGroup success does not store groupId, so a relaunch is First run again.
// 11. createGroup failure moves the phase off First run, or stores a groupId.
// 12. createGroup rejects with something other than the session error, so First run cannot show it.
// 13. createGroup called before First run is reached acts on no uid instead of refusing.
// 14. stop() while sign-in or the group load is under way still moves the phase, or calls a listener.
// 15. A subscriber hears the loading it started on, or a transition that is not the current phase.

const UID = 'phase-uid';
const STRANGER = 'stranger-uid';
const GID = 'group-one';

useRulesEnvironment();

beforeEach(async () => {
  await env.clearFirestore();
  await AsyncStorage.clear();
});

const signInAs = (uid: string) => async () => ({ uid });

/** Resolves with the first phase that is not loading; `startPhases` returns in loading by contract. */
async function decided(phases: Phases): Promise<Phase> {
  if (phases.phase.name !== 'loading') return phases.phase;
  return new Promise((resolve) => {
    const stop = phases.subscribe((phase) => {
      if (phase.name === 'loading') return;
      stop();
      resolve(phase);
    });
  });
}

/** Writes a Group and its Owner's Member document outside the rules, as the fixture. */
async function seedGroup(ownerUid = UID, groupName = 'The Smiths'): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = modular(ctx);
    const batch = writeBatch(db);
    addCreateGroup(batch, db, GID, { ownerUid, displayName: 'Sam', groupName });
    await batch.commit();
  });
}

describe('startPhases', () => {
  it('returns straight away in loading, before sign-in or the group load answer', () => {
    const phases = startPhases({ db: as(UID), signIn: signInAs(UID) });
    expect(phases.phase).toEqual({ name: 'loading' });
  });

  it('reaches First run with the signed-in uid when no Group is stored', async () => {
    const phases = startPhases({ db: as(UID), signIn: signInAs(UID) });
    expect(await decided(phases)).toEqual({ name: 'firstRun', uid: UID });
  });

  it('reaches sharing with the stored Group when this phone is a Member', async () => {
    await seedGroup();
    await AsyncStorage.setItem('groupId', GID);

    const phases = startPhases({ db: as(UID), signIn: signInAs(UID) });
    expect(await decided(phases)).toEqual({
      name: 'sharing',
      uid: UID,
      group: { id: GID, name: 'The Smiths', displayName: 'Sam' },
    });
  });

  it('reaches First run when the stored groupId has no Member document', async () => {
    await seedGroup();
    await AsyncStorage.setItem('groupId', GID);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(memberRef(modular(ctx), GID, UID));
    });

    const phases = startPhases({ db: as(UID), signIn: signInAs(UID) });
    expect(await decided(phases)).toEqual({ name: 'firstRun', uid: UID });
  });

  it('reaches First run when the stored Group belongs to someone else, so the read is denied', async () => {
    await seedGroup();
    await AsyncStorage.setItem('groupId', GID);

    const phases = startPhases({ db: as(STRANGER), signIn: signInAs(STRANGER) });
    expect(await decided(phases)).toEqual({ name: 'firstRun', uid: STRANGER });
  });

  it('reaches the error phase carrying the message when sign-in fails', async () => {
    const phases = startPhases({
      db: as(UID),
      signIn: async () => {
        throw new Error('auth is down');
      },
    });

    const phase = await decided(phases);
    expect(phase.name).toBe('error');
    expect((phase as { message?: string }).message).toContain('auth is down');
  });

  it('reaches the error phase, not First run, when the group load fails', async () => {
    // A stored groupId with no stored name cannot fall back offline, so loadGroup throws (session.ts).
    await AsyncStorage.setItem('groupId', GID);
    const db = as(UID);
    await disableNetwork(db);

    const phases = startPhases({ db, signIn: signInAs(UID) });
    const phase = await decided(phases);

    expect(phase.name).toBe('error');
    expect((phase as { message?: string }).message).toBeTruthy();
  });

  it('tells a subscriber when it reaches sharing, and not about the loading it started in', async () => {
    await seedGroup();
    await AsyncStorage.setItem('groupId', GID);
    const phases = startPhases({ db: as(UID), signIn: signInAs(UID) });
    const seen: Phase[] = [];
    phases.subscribe((phase) => seen.push(phase));

    await decided(phases);
    await sleep(50);

    expect(seen).toEqual([
      { name: 'sharing', uid: UID, group: { id: GID, name: 'The Smiths', displayName: 'Sam' } },
    ]);
  });
});

describe('createGroup', () => {
  it('reaches sharing with the new Group, stores groupId, and relaunches into sharing', async () => {
    const db = as(UID);
    const phases = startPhases({ db, signIn: signInAs(UID) });
    expect(await decided(phases)).toEqual({ name: 'firstRun', uid: UID });

    await phases.createGroup('Sam', 'The Smiths');

    const sharing = phases.phase;
    expect(sharing.name).toBe('sharing');
    if (sharing.name !== 'sharing') throw new Error('expected sharing');
    expect(sharing.uid).toBe(UID);
    expect(sharing.group.name).toBe('The Smiths');
    expect(await AsyncStorage.getItem('groupId')).toBe(sharing.group.id);

    const relaunched = startPhases({ db, signIn: signInAs(UID) });
    expect(await decided(relaunched)).toEqual(sharing);
  });

  it.each([
    ['', 'The Smiths'],
    ['   ', 'The Smiths'],
    ['Sam', ''],
    ['Sam', ' \t '],
  ])('rejects a blank name (%j, %j), stays on First run and stores nothing', async (yourName, groupName) => {
    const phases = startPhases({ db: as(UID), signIn: signInAs(UID) });
    expect(await decided(phases)).toEqual({ name: 'firstRun', uid: UID });

    await expect(phases.createGroup(yourName, groupName)).rejects.toThrow();

    expect(phases.phase).toEqual({ name: 'firstRun', uid: UID });
    expect(await AsyncStorage.getItem('groupId')).toBeNull();
  });

  it('refuses before First run is reached, and changes nothing', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const phases = startPhases({
      db: as(UID),
      signIn: async () => {
        await held;
        return { uid: UID };
      },
    });

    await expect(phases.createGroup('Sam', 'The Smiths')).rejects.toThrow();
    expect(phases.phase).toEqual({ name: 'loading' });

    release();
  });
});

describe('stop', () => {
  it('leaves the phase in loading and never tells a listener when stopped before sign-in answers', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const phases = startPhases({
      db: as(UID),
      signIn: async () => {
        await held;
        return { uid: UID };
      },
    });
    const seen: Phase[] = [];
    phases.subscribe((phase) => seen.push(phase));

    phases.stop();
    release();
    await sleep(150);

    expect(phases.phase).toEqual({ name: 'loading' });
    expect(seen).toEqual([]);
  });

  it('leaves the phase in loading when stopped while the group load is under way', async () => {
    await seedGroup();
    await AsyncStorage.setItem('groupId', GID);
    const phases = startPhases({ db: as(UID), signIn: signInAs(UID) });
    const seen: Phase[] = [];
    phases.subscribe((phase) => seen.push(phase));

    // stop() runs before any await in the start-up chain can settle.
    phases.stop();
    await sleep(300);

    expect(phases.phase).toEqual({ name: 'loading' });
    expect(seen).toEqual([]);
  });
});
