import AsyncStorage from '@react-native-async-storage/async-storage';
import { deleteDoc, disableNetwork, getDoc, Timestamp, updateDoc, writeBatch } from 'firebase/firestore';
import { beforeEach, describe, expect, it } from 'vitest';

import { as, env, modular, sleep, useRulesEnvironment } from './fakes/rules';
import { addCreateGroup, addMintInvite, joinRequestRef, memberRef } from '../src/groupDocs';
import { joinGroup } from '../src/session';
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
const JOINER = 'joiner-uid';
const CODE = 'PHASE234';

// Ways the Waiting phase (ticket 07) could fail, written before src/phases.ts grew it:
// 31. A stored groupId whose own Join request is pending lands on First run or on the map instead of Waiting.
// 32. A pending joiner who kills and reopens the app does not return to Waiting, or loses the Owner's name.
// 33. The Waiting phase reaches First run without the Owner's name to ask.
// 34. Joining with a wrong code moves off First run, or stores a groupId.
// 35. Joining with a valid code leaves the phase on First run instead of Waiting.
// 36. join() before First run is reached acts on no uid instead of refusing.
// 37. The phone's own Join-request listener does not land the approved joiner on the map, or writes no
//     Member document.
// 38. A request approved while the app was closed never materialises the Member document.
// 39. A Join request deleted under a waiting phone leaves it stuck on Waiting.
// 40. stop() while Waiting leaves the Join-request listener live, so a later approval still moves the phase.

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
    // A stored groupId with no stored name cannot fall back offline, so loadStart throws (session.ts).
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

/** A Group with one live Invite, seeded through the same builders the app uses (ownerUid is not the joiner). */
async function seedGroupWithInvite(ownerUid = UID, groupName = 'The Smiths', code = CODE): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = modular(ctx);
    const batch = writeBatch(db);
    addCreateGroup(batch, db, GID, { ownerUid, displayName: 'Sam', groupName });
    addMintInvite(batch, db, GID, code, {
      groupName,
      ownerName: 'Sam',
      createdBy: ownerUid,
      expiresAt: Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000)),
    });
    await batch.commit();
  });
}

/** Resolves once `phases` reaches a phase the matcher accepts; returns at once if it already has. */
function waitFor(phases: Phases, match: (phase: Phase) => boolean): Promise<Phase> {
  if (match(phases.phase)) return Promise.resolve(phases.phase);
  return new Promise((resolve) => {
    const stop = phases.subscribe((phase) => {
      if (!match(phase)) return;
      stop();
      resolve(phase);
    });
  });
}

/** Flips the joiner's own Join request to approved, outside the rules (the Owner's action lands in ticket 08). */
async function approve(uid = JOINER): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await updateDoc(joinRequestRef(modular(ctx), GID, uid), { status: 'approved' });
  });
}

describe('the Waiting phase (spec §7.1 row 2)', () => {
  it('lands on Waiting when the stored Group’s own Join request is pending, naming the Owner', async () => {
    await seedGroupWithInvite();
    await joinGroup(as(JOINER), JOINER, CODE, 'Priya');

    const phases = startPhases({ db: as(JOINER), signIn: signInAs(JOINER) });

    expect(await decided(phases)).toEqual({
      name: 'waiting',
      uid: JOINER,
      groupId: GID,
      groupName: 'The Smiths',
      ownerName: 'Sam',
    });
    phases.stop();
  });

  it('joins from First run into Waiting, and stores the Group against a relaunch', async () => {
    await seedGroupWithInvite();
    const db = as(JOINER);
    const phases = startPhases({ db, signIn: signInAs(JOINER) });
    expect(await decided(phases)).toEqual({ name: 'firstRun', uid: JOINER });

    expect(await phases.join(CODE, 'Priya')).toEqual({
      ok: true,
      groupId: GID,
      groupName: 'The Smiths',
      ownerName: 'Sam',
    });
    expect(phases.phase).toEqual({ name: 'waiting', uid: JOINER, groupId: GID, groupName: 'The Smiths', ownerName: 'Sam' });

    phases.stop();

    const relaunched = startPhases({ db, signIn: signInAs(JOINER) });
    expect(await decided(relaunched)).toEqual({
      name: 'waiting',
      uid: JOINER,
      groupId: GID,
      groupName: 'The Smiths',
      ownerName: 'Sam',
    });
    relaunched.stop();
  });

  it.each(['ZZZZZZZZ', ''])('a wrong code (%j) keeps First run, its answer, and writes nothing', async (code) => {
    await seedGroupWithInvite();
    const phases = startPhases({ db: as(JOINER), signIn: signInAs(JOINER) });
    expect(await decided(phases)).toEqual({ name: 'firstRun', uid: JOINER });

    expect(await phases.join(code, 'Priya')).toEqual({ ok: false, reason: 'bad-code' });
    expect(phases.phase).toEqual({ name: 'firstRun', uid: JOINER });
    expect(await AsyncStorage.getItem('groupId')).toBeNull();
    phases.stop();
  });

  it('refuses join() before First run is reached, and changes nothing', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const phases = startPhases({
      db: as(JOINER),
      signIn: async () => {
        await held;
        return { uid: JOINER };
      },
    });

    await expect(phases.join(CODE, 'Priya')).rejects.toThrow();
    expect(phases.phase).toEqual({ name: 'loading' });

    release();
  });

  it('lands on the map when the Owner approves while the phone waits, writing the Member document', async () => {
    await seedGroupWithInvite();
    await joinGroup(as(JOINER), JOINER, CODE, 'Priya');
    const phases = startPhases({ db: as(JOINER), signIn: signInAs(JOINER) });
    expect(await decided(phases)).toEqual({
      name: 'waiting',
      uid: JOINER,
      groupId: GID,
      groupName: 'The Smiths',
      ownerName: 'Sam',
    });

    const landed = waitFor(phases, (phase) => phase.name === 'sharing');
    await approve();

    expect(await landed).toEqual({
      name: 'sharing',
      uid: JOINER,
      group: { id: GID, name: 'The Smiths', displayName: 'Priya' },
    });
    const member = (await getDoc(memberRef(as(JOINER), GID, JOINER))).data()!;
    expect(member.role).toBe('member');
    expect(member.displayName).toBe('Priya');
    phases.stop();
  });

  it('lands on the map when the phone was closed at approval, materialising the Member document on launch', async () => {
    await seedGroupWithInvite();
    await joinGroup(as(JOINER), JOINER, CODE, 'Priya');
    await approve();

    const phases = startPhases({ db: as(JOINER), signIn: signInAs(JOINER) });

    expect(await decided(phases)).toEqual({
      name: 'sharing',
      uid: JOINER,
      group: { id: GID, name: 'The Smiths', displayName: 'Priya' },
    });
    expect((await getDoc(memberRef(as(JOINER), GID, JOINER))).exists()).toBe(true);
    phases.stop();
  });

  it('returns to First run when the waiting request is deleted under the phone', async () => {
    await seedGroupWithInvite();
    await joinGroup(as(JOINER), JOINER, CODE, 'Priya');
    const phases = startPhases({ db: as(JOINER), signIn: signInAs(JOINER) });
    expect(await decided(phases)).toEqual({
      name: 'waiting',
      uid: JOINER,
      groupId: GID,
      groupName: 'The Smiths',
      ownerName: 'Sam',
    });

    const back = waitFor(phases, (phase) => phase.name === 'firstRun');
    await deleteDoc(joinRequestRef(as(JOINER), GID, JOINER));

    expect(await back).toEqual({ name: 'firstRun', uid: JOINER });
    phases.stop();
  });

  it('stops following the Join request on stop(), so a later approval moves nothing', async () => {
    await seedGroupWithInvite();
    await joinGroup(as(JOINER), JOINER, CODE, 'Priya');
    const phases = startPhases({ db: as(JOINER), signIn: signInAs(JOINER) });
    expect(await decided(phases)).toEqual({
      name: 'waiting',
      uid: JOINER,
      groupId: GID,
      groupName: 'The Smiths',
      ownerName: 'Sam',
    });

    phases.stop();
    await approve();
    await sleep(200);

    expect(phases.phase).toEqual({
      name: 'waiting',
      uid: JOINER,
      groupId: GID,
      groupName: 'The Smiths',
      ownerName: 'Sam',
    });
  });
});
