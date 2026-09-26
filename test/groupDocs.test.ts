import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { collection, getDoc, getDocs, serverTimestamp, setDoc, Timestamp, writeBatch } from 'firebase/firestore';
import { beforeEach, describe, expect, it } from 'vitest';

import { as, env, modular, useRulesEnvironment } from './fakes/rules';
import {
  addApproveJoin,
  addCreateGroup,
  addJoinMember,
  addJoinRequest,
  addMintInvite,
  addRemoval,
  groupRef,
  groupsRef,
  inviteRef,
  joinRequestRef,
  joinRequestsRef,
  memberRef,
  membersRef,
  newGroupId,
  positionRef,
  positionsRef,
} from '../src/groupDocs';

// Ways one module owning the Group's Firestore layout (ticket 16) could fail, written before src/groupDocs.ts:
//  1. A src/ module outside this one still builds a groups/{id}/… or invites/{code} path, so a layout change
//     reaches further than this file.
//  2. A reference points at the wrong collection or document: the wrong segment, or a uid in the wrong slot.
//  3. newGroupId returns a fixed id, so two Groups collide, or one the paths cannot carry.
//  4. The Group and the Owner's Member document are written as two commits rather than one batch, so the
//     rules' getAfter() sees no Group and the Create is denied half way.
//  5. addCreateGroup carries a stray field, the wrong maxMembers or the wrong role, which the rules deny.
//  6. createdAt / joinedAt come from the phone's clock instead of the server, which the rules deny.
//  7. The Owner's Member document is keyed by anything but the owner's uid.
//  8. The module's own surface stops being the one place a Group or Invite path can be named.

const OWNER = 'owner-uid';
const OTHER = 'other-uid';
const GID = 'group-one';
const CODE = 'LIVE01';
const OTHER_CODE = 'CODE02';

useRulesEnvironment();

beforeEach(async () => {
  await env.clearFirestore();
});

describe('the references', () => {
  it('point at the Group, Member, Position, Join request and Invite documents and collections', () => {
    const db = as(OWNER);

    expect(groupsRef(db).path).toBe('groups');
    expect(groupRef(db, GID).path).toBe('groups/group-one');
    expect(memberRef(db, GID, OTHER).path).toBe('groups/group-one/members/other-uid');
    expect(membersRef(db, GID).path).toBe('groups/group-one/members');
    expect(positionRef(db, GID, OTHER).path).toBe('groups/group-one/locations/other-uid');
    expect(positionsRef(db, GID).path).toBe('groups/group-one/locations');
    expect(joinRequestRef(db, GID, OTHER).path).toBe('groups/group-one/joinRequests/other-uid');
    expect(joinRequestsRef(db, GID).path).toBe('groups/group-one/joinRequests');
    expect(inviteRef(db, CODE).path).toBe('invites/LIVE01');
  });
});

describe('newGroupId', () => {
  it('mints a fresh Group id', () => {
    const db = as(OWNER);
    const first = newGroupId(db);

    expect(first).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(newGroupId(db)).not.toBe(first);
  });
});

describe('addCreateGroup', () => {
  it('writes the Group and the Owner’s Member document in the one batch the rules accept', async () => {
    const db = as(OWNER);
    const gid = newGroupId(db);
    const batch = writeBatch(db);
    addCreateGroup(batch, db, gid, { ownerUid: OWNER, displayName: 'Sam', groupName: 'The Smiths' });
    await batch.commit();

    const group = (await getDoc(groupRef(db, gid))).data()!;
    expect(Object.keys(group).sort()).toEqual(['activeInviteCode', 'createdAt', 'maxMembers', 'name', 'ownerUid']);
    expect(group.name).toBe('The Smiths');
    expect(group.ownerUid).toBe(OWNER);
    expect(group.maxMembers).toBe(4);
    expect(group.createdAt).toBeInstanceOf(Timestamp);
    expect(group.activeInviteCode).toBeNull();

    const member = (await getDoc(memberRef(db, gid, OWNER))).data()!;
    expect(Object.keys(member).sort()).toEqual(['displayName', 'joinedAt', 'role']);
    expect(member.displayName).toBe('Sam');
    expect(member.role).toBe('owner');
    expect(member.joinedAt).toBeInstanceOf(Timestamp);
  });

  it('must be one batch: the Owner’s Member document on its own has no getAfter() Group, so the rules deny it', async () => {
    const db = as(OWNER);
    const gid = newGroupId(db);
    const batch = writeBatch(db);
    batch.set(memberRef(db, gid, OWNER), { displayName: 'Sam', role: 'owner', joinedAt: serverTimestamp() });

    await expect(batch.commit()).rejects.toThrow();
  });
});

// Ways the Join, Member-admission and Invite batch builders (ticket 07) could fail, written before the
// builders:
//  1. A Join request carries the wrong fields (a client requestedAt, a missing inviteCode, a non-pending
//     status) or lands under the wrong path.
//  2. An expired or absent Invite still opens a Join request, so a dead code is a door.
//  3. A joiner admits itself as a Member while its request is still pending.
//  4. The admitted Member carries the wrong role, a phone-clock joinedAt, or a stray field.
//  5. An Invite carries the wrong fields, points at the wrong Group, or names the wrong creator.
//  6. Rotation leaves the old document behind, so two codes are live; or deletes the replacement, so none
//     is; or fails to move the Group's `activeInviteCode` pointer.
//  7. The builder is not accepted by the §4 rules (a stray field, a wrong role, a phone clock).

const live = () => Timestamp.fromDate(new Date(Date.now() + 24 * 60 * 60 * 1000));
const expired = () => Timestamp.fromDate(new Date(Date.now() - 1000));

/** A Group with one Invite, seeded through the same builders the app uses. */
async function seedGroupWithInvite(code = CODE, expiresAt = live()): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = modular(ctx);
    const batch = writeBatch(db);
    addCreateGroup(batch, db, GID, { ownerUid: OWNER, displayName: 'Sam', groupName: 'The Smiths' });
    addMintInvite(batch, db, GID, code, {
      groupName: 'The Smiths',
      ownerName: 'Sam',
      createdBy: OWNER,
      expiresAt,
    });
    await batch.commit();
  });
}

describe('addMintInvite', () => {
  it('writes invites/{code} and the Group’s pointer, in the one batch the rules accept', async () => {
    const db = as(OWNER);
    const batch = writeBatch(db);
    addCreateGroup(batch, db, GID, { ownerUid: OWNER, displayName: 'Sam', groupName: 'The Smiths' });
    await batch.commit();

    const expiresAt = live();
    const mint = writeBatch(db);
    addMintInvite(mint, db, GID, CODE, {
      groupName: 'The Smiths',
      ownerName: 'Sam',
      createdBy: OWNER,
      expiresAt,
    });
    await mint.commit();

    const invite = (await getDoc(inviteRef(db, CODE))).data()!;
    expect(Object.keys(invite).sort()).toEqual(['createdBy', 'expiresAt', 'groupId', 'groupName', 'ownerName']);
    expect(invite.groupId).toBe(GID);
    expect(invite.groupName).toBe('The Smiths');
    expect(invite.ownerName).toBe('Sam');
    expect(invite.createdBy).toBe(OWNER);
    expect(invite.expiresAt).toEqual(expiresAt);

    expect((await getDoc(groupRef(db, GID))).data()!.activeInviteCode).toBe(CODE);
  });

  it('rotates: the replacement is live, the old document is gone, and one code remains', async () => {
    const db = as(OWNER);
    const create = writeBatch(db);
    addCreateGroup(create, db, GID, { ownerUid: OWNER, displayName: 'Sam', groupName: 'The Smiths' });
    await create.commit();

    const first = writeBatch(db);
    addMintInvite(first, db, GID, CODE, {
      groupName: 'The Smiths',
      ownerName: 'Sam',
      createdBy: OWNER,
      expiresAt: live(),
    });
    await first.commit();

    const rotate = writeBatch(db);
    addMintInvite(rotate, db, GID, OTHER_CODE, {
      groupName: 'The Smiths',
      ownerName: 'Sam',
      createdBy: OWNER,
      expiresAt: live(),
      previousCode: CODE,
    });
    await rotate.commit();

    expect((await getDoc(groupRef(db, GID))).data()!.activeInviteCode).toBe(OTHER_CODE);
    // The listing is read outside the rules: `getDoc` on the deleted code trips §4's `allow get`
    // (`resource.data` on a null resource), and the question here is which codes remain.
    await env.withSecurityRulesDisabled(async (ctx) => {
      const invites = await getDocs(collection(modular(ctx), 'invites'));
      expect(invites.docs.map((each) => each.id)).toEqual([OTHER_CODE]);
    });
  });
});

describe('addJoinRequest', () => {
  it('writes joinRequests/{uid}: the typed name, pending, a server requestedAt and the code that opened it', async () => {
    await seedGroupWithInvite();
    const db = as(OTHER);
    const batch = writeBatch(db);
    addJoinRequest(batch, db, GID, OTHER, { displayName: 'Priya', inviteCode: CODE });
    await batch.commit();

    const request = (await getDoc(joinRequestRef(db, GID, OTHER))).data()!;
    expect(Object.keys(request).sort()).toEqual(['displayName', 'inviteCode', 'requestedAt', 'status']);
    expect(request.displayName).toBe('Priya');
    expect(request.status).toBe('pending');
    expect(request.inviteCode).toBe(CODE);
    expect(request.requestedAt).toBeInstanceOf(Timestamp);
  });

  it('is denied with an expired Invite, so a dead code cannot open a request', async () => {
    await seedGroupWithInvite(CODE, expired());
    const db = as(OTHER);
    const batch = writeBatch(db);
    addJoinRequest(batch, db, GID, OTHER, { displayName: 'Priya', inviteCode: CODE });

    await expect(batch.commit()).rejects.toThrow();
  });
});

describe('addJoinMember', () => {
  it('admits the joiner as a member with a server joinedAt once the request is approved', async () => {
    await seedGroupWithInvite();
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(joinRequestRef(modular(ctx), GID, OTHER), {
        displayName: 'Priya',
        status: 'approved',
        requestedAt: Timestamp.now(),
        inviteCode: CODE,
      });
    });

    const db = as(OTHER);
    const batch = writeBatch(db);
    addJoinMember(batch, db, GID, OTHER, { displayName: 'Priya' });
    await batch.commit();

    const member = (await getDoc(memberRef(db, GID, OTHER))).data()!;
    expect(Object.keys(member).sort()).toEqual(['displayName', 'joinedAt', 'role']);
    expect(member.displayName).toBe('Priya');
    expect(member.role).toBe('member');
    expect(member.joinedAt).toBeInstanceOf(Timestamp);
  });

  it('is denied while the Join request is still pending', async () => {
    await seedGroupWithInvite();
    const db = as(OTHER);
    const batch = writeBatch(db);
    addJoinMember(batch, db, GID, OTHER, { displayName: 'Priya' });

    await expect(batch.commit()).rejects.toThrow();
  });
});

// Ways Remove-from-group / Leave's batch (ticket 11) could fail, written before addRemoval:
//  1. Only the Member document is deleted, so a dead Position keeps a pin on every map.
//  2. The Join request is left behind, so a removed phone's approved request still admits it back in.
//  3. The three deletions are split across commits, so a half-done removal leaves a pin or a re-entry path.
//  4. A non-owner removes another Member's documents, which the rules must deny.
describe('addRemoval', () => {
  /** OWNER's Group with OTHER admitted, holding a Position and an approved Join request, through the builders. */
  async function seedMemberWithPosition(): Promise<void> {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = modular(ctx);
      const batch = writeBatch(db);
      addCreateGroup(batch, db, GID, { ownerUid: OWNER, displayName: 'Sam', groupName: 'The Smiths' });
      addMintInvite(batch, db, GID, CODE, {
        groupName: 'The Smiths',
        ownerName: 'Sam',
        createdBy: OWNER,
        expiresAt: live(),
      });
      addJoinRequest(batch, db, GID, OTHER, { displayName: 'Priya', inviteCode: CODE });
      addJoinMember(batch, db, GID, OTHER, { displayName: 'Priya' });
      await batch.commit();
      await setDoc(positionRef(db, GID, OTHER), {
        lat: -33.8688,
        lng: 151.2093,
        accuracy: 12,
        updatedAt: Timestamp.now(),
        mode: 'foreground',
      });
    });
  }

  /** Which of OTHER's three documents remain, read outside the rules so a deleted one is an absence, not a denial. */
  async function remaining(other = OTHER): Promise<{ member: boolean; position: boolean; request: boolean }> {
    let result = { member: true, position: true, request: true };
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = modular(ctx);
      result = {
        member: (await getDoc(memberRef(db, GID, other))).exists(),
        position: (await getDoc(positionRef(db, GID, other))).exists(),
        request: (await getDoc(joinRequestRef(db, GID, other))).exists(),
      };
    });
    return result;
  }

  it('deletes the Member, their Position and their Join request in the one batch the rules accept', async () => {
    await seedMemberWithPosition();
    const db = as(OWNER);
    const batch = writeBatch(db);
    addRemoval(batch, db, GID, OTHER);
    await batch.commit();

    expect(await remaining()).toEqual({ member: false, position: false, request: false });
  });

  it('lets a Member remove only themselves', async () => {
    await seedMemberWithPosition();
    const db = as(OTHER);
    const batch = writeBatch(db);
    addRemoval(batch, db, GID, OTHER);
    await batch.commit();

    expect(await remaining()).toEqual({ member: false, position: false, request: false });
  });

  it('is denied for a Member removing someone else', async () => {
    await seedMemberWithPosition();
    const db = as(OTHER);
    const batch = writeBatch(db);
    addRemoval(batch, db, GID, OWNER);

    await expect(batch.commit()).rejects.toThrow();
    expect(await remaining(OWNER)).toEqual({ member: true, position: false, request: false });
  });
});

// Ways the Owner's approval batch (ticket 08) could fail, written before addApproveJoin:
//  1. The request's status is written as anything but 'approved', or with a stray field, which the rules deny.
//  2. Approval and rotation are separate commits, so a half-done approval leaves an approved request with the
//     old code still live, or an admitted joiner no new code can gate.
//  3. The replacement Invite is written after the old document is deleted, so a moment has no live code.
//  4. The old document is left behind, so two codes are live; or the pointer does not move to the replacement.
//  5. The wrong request document is approved, or the wrong Group's pointer moves.
describe('addApproveJoin', () => {
  /** A Group with a live CODE and OTHER's pending request, seeded through the same builders the app uses. */
  async function seedPendingRequest(): Promise<void> {
    await env.withSecurityRulesDisabled(async (ctx) => {
      const db = modular(ctx);
      const create = writeBatch(db);
      addCreateGroup(create, db, GID, { ownerUid: OWNER, displayName: 'Sam', groupName: 'The Smiths' });
      addMintInvite(create, db, GID, CODE, {
        groupName: 'The Smiths',
        ownerName: 'Sam',
        createdBy: OWNER,
        expiresAt: live(),
      });
      addJoinRequest(create, db, GID, OTHER, { displayName: 'Priya', inviteCode: CODE });
      await create.commit();
    });
  }

  it('marks the request approved and rotates the Invite in the one batch the rules accept', async () => {
    await seedPendingRequest();
    const db = as(OWNER);
    const batch = writeBatch(db);
    addApproveJoin(batch, db, GID, OTHER, {
      code: OTHER_CODE,
      groupName: 'The Smiths',
      ownerName: 'Sam',
      createdBy: OWNER,
      expiresAt: live(),
      previousCode: CODE,
    });
    await batch.commit();

    expect((await getDoc(joinRequestRef(db, GID, OTHER))).data()!.status).toBe('approved');
    expect((await getDoc(groupRef(db, GID))).data()!.activeInviteCode).toBe(OTHER_CODE);
    await env.withSecurityRulesDisabled(async (ctx) => {
      const invites = await getDocs(collection(modular(ctx), 'invites'));
      expect(invites.docs.map((each) => each.id)).toEqual([OTHER_CODE]);
    });
  });

  it('is denied for a non-owner', async () => {
    await seedPendingRequest();
    // A pending joiner, not the Owner: the rules deny both the request update and the Invite mint.
    const db = as(OTHER);
    const batch = writeBatch(db);
    addApproveJoin(batch, db, GID, OTHER, {
      code: OTHER_CODE,
      groupName: 'The Smiths',
      ownerName: 'Sam',
      createdBy: OTHER,
      expiresAt: live(),
      previousCode: CODE,
    });

    await expect(batch.commit()).rejects.toThrow();
    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDoc(joinRequestRef(modular(ctx), GID, OTHER))).data()!.status).toBe('pending');
    });
  });
});

describe('the module’s surface', () => {
  it('is the only src/ module that builds a Group or Invite path', () => {
    // Exactly the spec's criterion: a doc()/collection() call carrying a 'groups' or 'invites' segment.
    const pathCall = /\b(?:doc|collection)\s*\([^;]*['"](?:groups|invites)['"]/;
    for (const file of sourceFiles()) {
      if (file === join('src', 'groupDocs.ts')) continue;
      const source = readFileSync(file, 'utf8');
      expect(source, `${file} builds a Group or Invite path by hand`).not.toMatch(pathCall);
    }
  });
});

/** Every TypeScript source under `src/`, at any depth. */
function sourceFiles(dir = 'src'): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}
