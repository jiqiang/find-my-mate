import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  collection,
  deleteDoc,
  disableNetwork,
  doc,
  getDoc,
  getDocs,
  Timestamp,
  updateDoc,
} from 'firebase/firestore';
import { beforeEach, describe, expect, it } from 'vitest';

import { as, env, modular, useRulesEnvironment } from './fakes/rules';
import { createGroup, loadGroup } from '../src/session';

// Ways Create (ticket 05) could fail, written before src/session.ts:
//  1. A blank or whitespace-only Your name or Group name is accepted.
//  2. The Group and the Owner's Member document are written separately, so a half-created Group can exist.
//  3. The rules deny the batch (a stray field, the wrong maxMembers, the wrong role).
//  4. ownerUid is not the phone's uid, or the Owner's Member document is keyed by something else.
//  5. createdAt / joinedAt are phone-clock values rather than server timestamps.
//  6. An Invite code is minted at creation (an invites doc, or a non-null activeInviteCode).
//  7. groupId is stored before the batch commits, so a failed Create leaves a phone pointing at nothing.
//  8. groupId is not stored, so relaunching shows First run again.
//  9. Relaunching finds the stored groupId but not the Group name for the map.
// 10. A stored groupId whose Member document is gone (or unreadable) is treated as still in the Group.
// 11. Relaunching with no network strands the phone on a spinner instead of reaching the map.

const OWNER = 'owner-uid';
const STRANGER = 'stranger-uid';

useRulesEnvironment();

beforeEach(async () => {
  await env.clearFirestore();
  await AsyncStorage.clear();
});

describe('createGroup', () => {
  it('writes the Group and the Owner in one batch the rules accept, and stores groupId', async () => {
    const db = as(OWNER);
    const group = await createGroup(db, OWNER, '  Sam ', ' The Smiths ');

    expect(group.name).toBe('The Smiths');
    expect(group.id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(await AsyncStorage.getItem('groupId')).toBe(group.id);

    const groupSnap = await getDoc(doc(db, 'groups', group.id));
    const g = groupSnap.data()!;
    expect(Object.keys(g).sort()).toEqual(['activeInviteCode', 'createdAt', 'maxMembers', 'name', 'ownerUid']);
    expect(g.name).toBe('The Smiths');
    expect(g.ownerUid).toBe(OWNER);
    expect(g.maxMembers).toBe(4);
    expect(g.createdAt).toBeInstanceOf(Timestamp);
    expect(g.activeInviteCode).toBeNull();

    const memberSnap = await getDoc(doc(db, 'groups', group.id, 'members', OWNER));
    const m = memberSnap.data()!;
    expect(Object.keys(m).sort()).toEqual(['displayName', 'joinedAt', 'role']);
    expect(m.displayName).toBe('Sam');
    expect(m.role).toBe('owner');
    expect(m.joinedAt).toBeInstanceOf(Timestamp);
  });

  it('mints no Invite code', async () => {
    await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    await env.withSecurityRulesDisabled(async (ctx) => {
      const invites = await getDocs(collection(modular(ctx), 'invites'));
      expect(invites.size).toBe(0);
    });
  });

  it.each([
    ['', 'The Smiths'],
    ['   ', 'The Smiths'],
    ['Sam', ''],
    ['Sam', ' \t '],
  ])('rejects a blank name (%j, %j) and writes and stores nothing', async (yourName, groupName) => {
    await expect(createGroup(as(OWNER), OWNER, yourName, groupName)).rejects.toThrow();
    expect(await AsyncStorage.getItem('groupId')).toBeNull();
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDocs(collection(modular(ctx), 'groups'))).size).toBe(0);
    });
  });

  it('does not store groupId when the batch is denied', async () => {
    // Signed in as someone else, so ownerUid != uid and the rules deny the batch.
    await expect(createGroup(as(STRANGER), OWNER, 'Sam', 'The Smiths')).rejects.toThrow();
    expect(await AsyncStorage.getItem('groupId')).toBeNull();
  });
});

describe('loadGroup (relaunch)', () => {
  it('returns null when no groupId is stored', async () => {
    expect(await loadGroup(as(OWNER), OWNER)).toBeNull();
  });

  it('returns the stored Group with its name and this phone’s name after Create', async () => {
    const created = await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    // A fresh Firestore instance stands in for the relaunched app: nothing is carried over in memory.
    expect(await loadGroup(as(OWNER), OWNER)).toEqual({ id: created.id, name: 'The Smiths', displayName: 'Sam' });
  });

  it('takes the name off the Member document, so a rename reaches the map', async () => {
    const created = await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    await updateDoc(doc(as(OWNER), 'groups', created.id, 'members', OWNER), { displayName: 'Samantha' });

    expect(await loadGroup(as(OWNER), OWNER)).toEqual({
      id: created.id,
      name: 'The Smiths',
      displayName: 'Samantha',
    });
  });

  it('returns null when this phone is not a Member of the stored Group', async () => {
    await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    expect(await loadGroup(as(STRANGER), STRANGER)).toBeNull();
  });

  it('returns null when the Member document has been deleted', async () => {
    const created = await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(doc(modular(ctx), 'groups', created.id, 'members', OWNER));
    });
    expect(await loadGroup(as(OWNER), OWNER)).toBeNull();
  });

  it('falls back to the stored names when offline', async () => {
    const created = await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    const offline = as(OWNER);
    await disableNetwork(offline);
    expect(await loadGroup(offline, OWNER)).toEqual({ id: created.id, name: 'The Smiths', displayName: 'Sam' });
  });
});
