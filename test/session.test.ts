import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  collection,
  deleteDoc,
  disableNetwork,
  getDoc,
  getDocs,
  Timestamp,
  updateDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { beforeEach, describe, expect, it } from 'vitest';

import { as, env, modular, sleep, useRulesEnvironment } from './fakes/rules';
import { addJoinMember, addMintInvite, groupRef, groupsRef, inviteRef, joinRequestRef, memberRef } from '../src/groupDocs';
import {
  approveJoinRequest,
  becomeMember,
  createGroup,
  ensureInvite,
  FULL_GROUP_MESSAGE,
  joinGroup,
  loadStart,
  newInviteCode,
  rotateInvite,
  watchMemberCount,
  watchPendingJoinRequests,
  type InviteCode,
  type PendingJoinRequest,
} from '../src/session';

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
//
// Ways Invite rotation (ticket 07) could fail, written before the code:
// 12. A code is not 8 characters, or carries one of the ambiguous 0/O/1/I/L.
// 13. The code is not written as invites/{code} plus the Group's activeInviteCode, or names the wrong Group.
// 14. The Invite's groupName/ownerName/createdBy are wrong, or expiresAt is a phone clock sentinel / not 24 h.
// 15. Opening Invite someone mints a second code although a live one exists.
// 16. An expired activeInviteCode is handed back instead of being replaced.
// 17. Rotating deletes the replacement or leaves the old document, so there are two live codes or none.
// 18. A non-owner can mint, when only the Owner may.
//
// Ways Join (ticket 07) could fail, written before the code:
// 19. A blank Your name is accepted.
// 20. A wrong, expired or already-used code writes a Join request anyway.
// 21. A valid code writes the request under the wrong path, or with a client requestedAt / no inviteCode /
//     a non-pending status.
// 22. The Invite's permission-denied (the expired case) surfaces as an error instead of "That code isn't
//     right."
// 23. groupId/groupName/ownerName are stored before the request commits, or not stored at all.
// 24. A bad code stores anything or writes anything.
//
// Ways the §7.1 start read (ticket 07) could fail, written before the code:
// 25. A stored groupId whose own Join request is pending is treated as First run or as membership.
// 26. A pending joiner's stored ownerName is lost on relaunch, so Waiting cannot name the Owner.
// 27. A stored groupId whose own request is approved but whose Member document is absent never writes the
//     Member document.
// 28. A stored groupId with no Member and no request is treated as membership.
// 29. A member relaunch loses the Group name or its own displayName.
// 30. Offline, a member or a pending joiner is stranded instead of trusting the stored names.
//
// Ways the Owner's approval (ticket 08) could fail, written before the code:
// 31. Approving leaves the Join request pending, so the joiner never lands on the map.
// 32. Approving does not rotate the Invite code, so the code the joiner used stays live.
// 33. Rotation leaves the old Invite document behind, deletes the replacement, or fails to move the pointer.
// 34. The replacement Invite names the wrong Group, Owner or creator.
// 35. A non-owner can approve, when only the Owner may.
// 36. The Owner's pending-request watcher reports approved requests as pending, or misses a later one.
// 37. The watcher reports another Group's requests, or survives its unsubscribe.
//
// Ways the four-Member cap (ticket 09) could fail, written before the code:
// 38. The Owner approves a fifth Member when the Group already has four; the cap is not checked at all.
// 39. The cap counts pending Join requests as Members, so a Group with room refuses an approval.
// 40. A refused approval still marks the request approved or rotates the code.
// 41. watchMemberCount reports a wrong or stale count, so the Owner's map offers Approve into a full Group.
// 42. watchMemberCount reports a count to a non-member, whom the rules should deny.

const OWNER = 'owner-uid';
const OTHER = 'joiner-uid';
const STRANGER = 'stranger-uid';

const live = () => Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000));

useRulesEnvironment();

beforeEach(async () => {
  await env.clearFirestore();
  await AsyncStorage.clear();
});

/**
 * The Owner's Group with one live Invite minted the way the app mints it. Storage is cleared afterwards:
 * the caller is usually standing in for a different phone, which must not inherit the Owner's stored
 * groupId/displayName.
 */
async function groupWithInvite(ownerName = 'Sam', groupName = 'The Smiths'): Promise<{ groupId: string; invite: InviteCode }> {
  const db = as(OWNER);
  const group = await createGroup(db, OWNER, ownerName, groupName);
  const invite = await ensureInvite(db, OWNER, group.id, { groupName, ownerName });
  await AsyncStorage.clear();
  return { groupId: group.id, invite };
}

/**
 * Whether an Invite document is still there, read outside the rules: `getDoc` as a signed-in phone on a
 * deleted Invite trips the §4 `allow get` rule (`resource.data` on a null resource), which is not the
 * question here.
 */
async function inviteExists(code: string): Promise<boolean> {
  let exists = false;
  await env.withSecurityRulesDisabled(async (ctx) => {
    exists = (await getDoc(inviteRef(modular(ctx), code))).exists();
  });
  return exists;
}

/** Seeds an expired Invite and the Group pointer to it, outside the rules (the rules forbid minting one). */
async function seedExpiredInvite(groupId: string, code: string): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = modular(ctx);
    const batch = writeBatch(db);
    addMintInvite(batch, db, groupId, code, {
      groupName: 'The Smiths',
      ownerName: 'Sam',
      createdBy: OWNER,
      expiresAt: Timestamp.fromDate(new Date(Date.now() - 1000)),
    });
    await batch.commit();
  });
}

describe('createGroup', () => {
  it('writes the Group and the Owner in one batch the rules accept, and stores groupId', async () => {
    const db = as(OWNER);
    const group = await createGroup(db, OWNER, '  Sam ', ' The Smiths ');

    expect(group.name).toBe('The Smiths');
    expect(group.id).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(await AsyncStorage.getItem('groupId')).toBe(group.id);

    const groupSnap = await getDoc(groupRef(db, group.id));
    const g = groupSnap.data()!;
    expect(Object.keys(g).sort()).toEqual(['activeInviteCode', 'createdAt', 'maxMembers', 'name', 'ownerUid']);
    expect(g.name).toBe('The Smiths');
    expect(g.ownerUid).toBe(OWNER);
    expect(g.maxMembers).toBe(4);
    expect(g.createdAt).toBeInstanceOf(Timestamp);
    expect(g.activeInviteCode).toBeNull();

    const memberSnap = await getDoc(memberRef(db, group.id, OWNER));
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
      expect((await getDocs(groupsRef(modular(ctx)))).size).toBe(0);
    });
  });

  it('does not store groupId when the batch is denied', async () => {
    // Signed in as someone else, so ownerUid != uid and the rules deny the batch.
    await expect(createGroup(as(STRANGER), OWNER, 'Sam', 'The Smiths')).rejects.toThrow();
    expect(await AsyncStorage.getItem('groupId')).toBeNull();
  });
});

describe('newInviteCode', () => {
  // §7.5 says both "the unambiguous 32-character alphabet `…GHJKLMNP…`" and "(no 0/O, no 1/I/L)". The two
  // disagree: dropping L leaves 31 symbols, and only the 32-symbol string yields the ~40 bits also claimed.
  // The string — and the 32-character claim — is what is implemented, so L is kept; see the type's comment.
  it('is 8 characters from the spec’s 32-character alphabet, with no 0/O/1/I', () => {
    const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    expect(new Set(alphabet).size).toBe(32);
    for (let i = 0; i < 250; i += 1) {
      const code = newInviteCode();
      expect(code).toHaveLength(8);
      for (const character of code) expect(alphabet).toContain(character);
      expect(code).not.toMatch(/[0O1I]/);
    }
  });

  it('does not repeat itself', () => {
    const codes = new Set(Array.from({ length: 100 }, () => newInviteCode()));
    expect(codes.size).toBe(100);
  });
});

describe('ensureInvite', () => {
  it('mints a live code on first open and points the Group at it', async () => {
    const db = as(OWNER);
    const group = await createGroup(db, OWNER, 'Sam', 'The Smiths');

    const invite = await ensureInvite(db, OWNER, group.id, { groupName: 'The Smiths', ownerName: 'Sam' });

    expect(invite.code).toHaveLength(8);
    expect(invite.expiresAt.getTime()).toBeGreaterThan(Date.now());
    const stored = (await getDoc(inviteRef(db, invite.code))).data()!;
    expect(Object.keys(stored).sort()).toEqual(['createdBy', 'expiresAt', 'groupId', 'groupName', 'ownerName']);
    expect(stored.groupId).toBe(group.id);
    expect(stored.groupName).toBe('The Smiths');
    expect(stored.ownerName).toBe('Sam');
    expect(stored.createdBy).toBe(OWNER);
    expect((await getDoc(groupRef(db, group.id))).data()!.activeInviteCode).toBe(invite.code);
  });

  it('hands back the live code instead of minting a second one', async () => {
    const { groupId, invite } = await groupWithInvite();
    const again = await ensureInvite(as(OWNER), OWNER, groupId, { groupName: 'The Smiths', ownerName: 'Sam' });

    expect(again.code).toBe(invite.code);
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDocs(collection(modular(ctx), 'invites'))).size).toBe(1);
    });
  });

  it('replaces an expired activeInviteCode rather than handing it back', async () => {
    const db = as(OWNER);
    const group = await createGroup(db, OWNER, 'Sam', 'The Smiths');
    await seedExpiredInvite(group.id, 'EXPIRED2');

    const fresh = await ensureInvite(db, OWNER, group.id, { groupName: 'The Smiths', ownerName: 'Sam' });

    expect(fresh.code).not.toBe('EXPIRED2');
    expect(fresh.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await inviteExists('EXPIRED2')).toBe(false);
    expect((await getDoc(groupRef(db, group.id))).data()!.activeInviteCode).toBe(fresh.code);
  });

  it('cannot mint as a non-owner: the rules deny it', async () => {
    const { groupId } = await groupWithInvite();

    await expect(
      ensureInvite(as(STRANGER), STRANGER, groupId, { groupName: 'The Smiths', ownerName: 'Stranger' }),
    ).rejects.toThrow();
  });
});

describe('rotateInvite', () => {
  it('mints a replacement and deletes the old document, leaving one live code', async () => {
    const { groupId, invite } = await groupWithInvite();
    const db = as(OWNER);

    const replacement = await rotateInvite(db, OWNER, groupId, { groupName: 'The Smiths', ownerName: 'Sam' });

    expect(replacement.code).not.toBe(invite.code);
    expect(await inviteExists(invite.code)).toBe(false);
    expect((await getDoc(groupRef(db, groupId))).data()!.activeInviteCode).toBe(replacement.code);
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDocs(collection(modular(ctx), 'invites'))).size).toBe(1);
    });
  });
});

describe('joinGroup', () => {
  it('reads the code once, writes the pending Join request, and stores the three names', async () => {
    const { groupId, invite } = await groupWithInvite();
    const joiner = as(OTHER);

    const result = await joinGroup(joiner, OTHER, ` ${invite.code.toLowerCase()} `, '  Priya ');

    expect(result).toEqual({ ok: true, groupId, groupName: 'The Smiths', ownerName: 'Sam' });
    const request = (await getDoc(joinRequestRef(joiner, groupId, OTHER))).data()!;
    expect(Object.keys(request).sort()).toEqual(['displayName', 'inviteCode', 'requestedAt', 'status']);
    expect(request.displayName).toBe('Priya');
    expect(request.status).toBe('pending');
    expect(request.inviteCode).toBe(invite.code);
    expect(request.requestedAt).toBeInstanceOf(Timestamp);
    expect(await AsyncStorage.getItem('groupId')).toBe(groupId);
    expect(await AsyncStorage.getItem('groupName')).toBe('The Smiths');
    expect(await AsyncStorage.getItem('ownerName')).toBe('Sam');
  });

  it.each(['ZZZZZZZZ', ''])('refuses a wrong code (%j): nothing written, nothing stored', async (code) => {
    const { groupId } = await groupWithInvite();

    expect(await joinGroup(as(OTHER), OTHER, code, 'Priya')).toEqual({ ok: false, reason: 'bad-code' });
    expect(await AsyncStorage.getItem('groupId')).toBeNull();
    expect(await AsyncStorage.getItem('ownerName')).toBeNull();
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDocs(collection(modular(ctx), 'groups', groupId, 'joinRequests'))).size).toBe(0);
    });
  });

  it('refuses an expired code: nothing written', async () => {
    const db = as(OWNER);
    const group = await createGroup(db, OWNER, 'Sam', 'The Smiths');
    await seedExpiredInvite(group.id, 'EXPIRED2');

    expect(await joinGroup(as(OTHER), OTHER, 'EXPIRED2', 'Priya')).toEqual({ ok: false, reason: 'bad-code' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDocs(collection(modular(ctx), 'groups', group.id, 'joinRequests'))).size).toBe(0);
    });
  });

  it('refuses a code whose document is already gone (already used): nothing written', async () => {
    const { groupId, invite } = await groupWithInvite();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(inviteRef(modular(ctx), invite.code));
    });

    expect(await joinGroup(as(OTHER), OTHER, invite.code, 'Priya')).toEqual({ ok: false, reason: 'bad-code' });
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDocs(collection(modular(ctx), 'groups', groupId, 'joinRequests'))).size).toBe(0);
    });
  });

  it('rejects a blank name before reading anything', async () => {
    const { invite } = await groupWithInvite();

    await expect(joinGroup(as(OTHER), OTHER, invite.code, '   ')).rejects.toThrow();
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDocs(collection(modular(ctx), 'invites'))).size).toBe(1);
    });
  });
});

describe('becomeMember', () => {
  it('writes members/{uid} with role member, a server joinedAt and the typed name, then stores the name', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');
    await approveRequest(groupId);

    const group = await becomeMember(as(OTHER), OTHER, groupId, 'The Smiths');

    expect(group).toEqual({ id: groupId, name: 'The Smiths', displayName: 'Priya', role: 'member' });
    const member = (await getDoc(memberRef(as(OTHER), groupId, OTHER))).data()!;
    expect(Object.keys(member).sort()).toEqual(['displayName', 'joinedAt', 'role']);
    expect(member.displayName).toBe('Priya');
    expect(member.role).toBe('member');
    expect(member.joinedAt).toBeInstanceOf(Timestamp);
    expect(await AsyncStorage.getItem('displayName')).toBe('Priya');
  });
});

/** Approves OTHER's pending request through the Owner's own action (ticket 08). */
async function approveRequest(groupId: string): Promise<void> {
  await approveJoinRequest(as(OWNER), OWNER, groupId, OTHER, { groupName: 'The Smiths', ownerName: 'Sam' });
}

describe('approveJoinRequest', () => {
  it('approves the request and rotates the code in one batch, leaving the replacement live', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');
    const db = as(OWNER);

    await approveJoinRequest(db, OWNER, groupId, OTHER, { groupName: 'The Smiths', ownerName: 'Sam' });

    expect((await getDoc(joinRequestRef(db, groupId, OTHER))).data()!.status).toBe('approved');
    expect(await inviteExists(invite.code)).toBe(false);
    const replacement = (await getDoc(groupRef(db, groupId))).data()!.activeInviteCode as string;
    expect(replacement).not.toBe(invite.code);
    const minted = (await getDoc(inviteRef(db, replacement))).data()!;
    expect(minted.groupId).toBe(groupId);
    expect(minted.groupName).toBe('The Smiths');
    expect(minted.ownerName).toBe('Sam');
    expect(minted.createdBy).toBe(OWNER);
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDocs(collection(modular(ctx), 'invites'))).size).toBe(1);
    });
  });

  it('admits the joiner: the approved request lets them write their Member document', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');

    await approveJoinRequest(as(OWNER), OWNER, groupId, OTHER, { groupName: 'The Smiths', ownerName: 'Sam' });
    const landed = await becomeMember(as(OTHER), OTHER, groupId, 'The Smiths');

    expect(landed).toEqual({ id: groupId, name: 'The Smiths', displayName: 'Priya', role: 'member' });
  });

  it('is denied for a non-owner: the request stays pending', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');

    await expect(
      approveJoinRequest(as(STRANGER), STRANGER, groupId, OTHER, { groupName: 'The Smiths', ownerName: 'Stranger' }),
    ).rejects.toThrow();

    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(joinRequestRef(modular(ctx), groupId, OTHER))).data()!.status).toBe('pending');
    });
  });
});

/** Adds an admitted Member to a Group outside the rules, so a test can reach the four-Member cap. */
async function addMember(groupId: string, uid: string, displayName: string): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = modular(ctx);
    const batch = writeBatch(db);
    addJoinMember(batch, db, groupId, uid, { displayName });
    await batch.commit();
  });
}

/** Waits until `check` holds, or gives up after ~2 s; an unmet check then fails on the next assertion. */
async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !check(); i += 1) await sleep(20);
}

describe('the four-Member cap (spec §5)', () => {
  it('refuses to approve into a full Group, leaving the request pending and the old code live', async () => {
    const { groupId, invite } = await groupWithInvite();
    await addMember(groupId, 'member-2', 'Alex');
    await addMember(groupId, 'member-3', 'Ravi');
    await addMember(groupId, 'member-4', 'Nina');
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');

    await expect(
      approveJoinRequest(as(OWNER), OWNER, groupId, OTHER, { groupName: 'The Smiths', ownerName: 'Sam' }),
    ).rejects.toThrow(FULL_GROUP_MESSAGE);

    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(joinRequestRef(modular(ctx), groupId, OTHER))).data()!.status).toBe('pending');
    });
    expect(await inviteExists(invite.code)).toBe(true);
    expect((await getDoc(groupRef(as(OWNER), groupId))).data()!.activeInviteCode).toBe(invite.code);
  });

  it('approves when the Group is one short of the cap', async () => {
    const { groupId, invite } = await groupWithInvite();
    await addMember(groupId, 'member-2', 'Alex');
    await addMember(groupId, 'member-3', 'Ravi');
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');

    await approveJoinRequest(as(OWNER), OWNER, groupId, OTHER, { groupName: 'The Smiths', ownerName: 'Sam' });

    expect((await getDoc(joinRequestRef(as(OWNER), groupId, OTHER))).data()!.status).toBe('approved');
  });

  it('counts Members, not pending Join requests: a lone request does not fill the Group', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');

    await approveJoinRequest(as(OWNER), OWNER, groupId, OTHER, { groupName: 'The Smiths', ownerName: 'Sam' });

    expect((await getDoc(joinRequestRef(as(OWNER), groupId, OTHER))).data()!.status).toBe('approved');
  });
});

describe('watchMemberCount', () => {
  it('reports the Group’s Member count as Members are admitted', async () => {
    const { groupId } = await groupWithInvite();
    const seen: number[] = [];
    const stop = watchMemberCount(as(OWNER), groupId, (count) => seen.push(count));

    await until(() => seen.includes(1));
    expect(seen.at(-1)).toBe(1);

    await addMember(groupId, 'member-2', 'Alex');
    await until(() => seen.includes(2));
    expect(seen.at(-1)).toBe(2);

    stop();
  });

  it('reports nothing to a non-member: the rules deny the listing', async () => {
    const { groupId } = await groupWithInvite();
    const seen: number[] = [];
    const stop = watchMemberCount(as(STRANGER), groupId, (count) => seen.push(count));

    await sleep(300);

    expect(seen).toEqual([]);
    stop();
  });
});

describe('watchPendingJoinRequests', () => {
  /** Starts the watcher and lets a test await the next list `match` accepts, or the current one. */
  function watch(db: Firestore, groupId: string) {
    const emissions: PendingJoinRequest[][] = [];
    const waiters: Array<{
      match: (requests: PendingJoinRequest[]) => boolean;
      resolve: (requests: PendingJoinRequest[]) => void;
    }> = [];
    const stop = watchPendingJoinRequests(db, groupId, (requests) => {
      emissions.push(requests);
      for (let i = waiters.length - 1; i >= 0; i -= 1) {
        if (!waiters[i].match(requests)) continue;
        const [waiter] = waiters.splice(i, 1);
        waiter.resolve(requests);
      }
    });
    return {
      waitFor(match: (requests: PendingJoinRequest[]) => boolean): Promise<PendingJoinRequest[]> {
        const latest = emissions.at(-1);
        if (latest && match(latest)) return Promise.resolve(latest);
        return new Promise((resolve) => waiters.push({ match, resolve }));
      },
      get emissions() {
        return emissions;
      },
      stop,
    };
  }

  it('reports each pending request, drops it on approval, and follows the rest', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');
    await joinGroup(as(STRANGER), STRANGER, invite.code, 'Alex');

    const watcher = watch(as(OWNER), groupId);
    await expect(watcher.waitFor((requests) => requests.length === 2)).resolves.toEqual(
      expect.arrayContaining([
        { uid: OTHER, displayName: 'Priya' },
        { uid: STRANGER, displayName: 'Alex' },
      ]),
    );

    const dropped = watcher.waitFor((requests) => requests.length === 1);
    await approveJoinRequest(as(OWNER), OWNER, groupId, OTHER, { groupName: 'The Smiths', ownerName: 'Sam' });
    expect(await dropped).toEqual([{ uid: STRANGER, displayName: 'Alex' }]);

    const emptied = watcher.waitFor((requests) => requests.length === 0);
    await env.withSecurityRulesDisabled(async (ctx) => {
      await deleteDoc(joinRequestRef(modular(ctx), groupId, STRANGER));
    });
    expect(await emptied).toEqual([]);

    watcher.stop();
  });

  it('reports nothing to a non-owner: the rules deny the listing', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');

    const seen: PendingJoinRequest[][] = [];
    const stop = watchPendingJoinRequests(as(STRANGER), groupId, (requests) => seen.push(requests));
    await sleep(300);

    expect(seen).toEqual([]);
    stop();
  });

  it('stops reporting once its unsubscribe runs', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');

    const watcher = watch(as(OWNER), groupId);
    await watcher.waitFor((requests) => requests.length === 1);
    const reported = watcher.emissions.length;

    watcher.stop();
    await joinGroup(as(STRANGER), STRANGER, invite.code, 'Alex');
    await sleep(200);

    expect(watcher.emissions.length).toBe(reported);
  });
});

describe('loadStart (spec §7.1)', () => {
  it('is First run when no groupId is stored', async () => {
    expect(await loadStart(as(OWNER), OWNER)).toEqual({ kind: 'firstRun' });
  });

  it('is the member Group after Create', async () => {
    const created = await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    expect(await loadStart(as(OWNER), OWNER)).toEqual({
      kind: 'member',
      group: { id: created.id, name: 'The Smiths', displayName: 'Sam', role: 'owner' },
    });
  });

  it('is the member Group with a renamed displayName', async () => {
    const created = await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    await updateDoc(memberRef(as(OWNER), created.id, OWNER), { displayName: 'Samantha' });

    expect(await loadStart(as(OWNER), OWNER)).toEqual({
      kind: 'member',
      group: { id: created.id, name: 'The Smiths', displayName: 'Samantha', role: 'owner' },
    });
  });

  it('is First run when this phone is not a Member and has no request', async () => {
    const created = await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    expect(await loadStart(as(STRANGER), STRANGER)).toEqual({ kind: 'firstRun' });
    expect(created.id).toBeTruthy();
  });

  it('is Waiting when the stored Group’s own Join request is pending, naming the Owner from storage', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');

    expect(await loadStart(as(OTHER), OTHER)).toEqual({
      kind: 'waiting',
      groupId,
      groupName: 'The Smiths',
      ownerName: 'Sam',
    });
  });

  it('is approved when the request is approved but this phone has no Member document yet', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');
    await approveRequest(groupId);

    expect(await loadStart(as(OTHER), OTHER)).toEqual({ kind: 'approved', groupId, groupName: 'The Smiths' });
  });

  it('falls back to the stored member names when offline', async () => {
    const created = await createGroup(as(OWNER), OWNER, 'Sam', 'The Smiths');
    const offline = as(OWNER);
    await disableNetwork(offline);

    expect(await loadStart(offline, OWNER)).toEqual({
      kind: 'member',
      group: { id: created.id, name: 'The Smiths', displayName: 'Sam', role: 'owner' },
    });
  });

  it('stays Waiting offline after a join, naming the Owner from storage', async () => {
    const { groupId, invite } = await groupWithInvite();
    await joinGroup(as(OTHER), OTHER, invite.code, 'Priya');
    const offline = as(OTHER);
    await disableNetwork(offline);

    expect(await loadStart(offline, OTHER)).toEqual({
      kind: 'waiting',
      groupId,
      groupName: 'The Smiths',
      ownerName: 'Sam',
    });
  });
});
