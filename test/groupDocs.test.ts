import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getDoc, serverTimestamp, Timestamp, writeBatch } from 'firebase/firestore';
import { beforeEach, describe, expect, it } from 'vitest';

import { as, env, useRulesEnvironment } from './fakes/rules';
import {
  addCreateGroup,
  groupRef,
  groupsRef,
  inviteRef,
  joinRequestRef,
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
