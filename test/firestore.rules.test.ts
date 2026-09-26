import { assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { beforeEach, describe, it } from 'vitest';

import { as, env, modular, useRulesEnvironment } from './fakes/rules';

const GID = 'group-one';
const OTHER_GID = 'group-two';
const CODE = 'LIVE01';
const OWNER = 'owner-uid';
const MEMBER = 'member-uid';
const JOINER = 'joiner-uid';
const STRANGER = 'stranger-uid';

const DAY_MS = 24 * 60 * 60 * 1000;

const anon = () => modular(env.unauthenticatedContext());

const groupRef = (db: Firestore, gid = GID) => doc(db, 'groups', gid);
const memberRef = (db: Firestore, uid: string, gid = GID) => doc(db, 'groups', gid, 'members', uid);
const requestRef = (db: Firestore, uid: string, gid = GID) => doc(db, 'groups', gid, 'joinRequests', uid);
const positionRef = (db: Firestore, uid: string, gid = GID) => doc(db, 'groups', gid, 'locations', uid);
const positionsRef = (db: Firestore, gid = GID) => collection(db, 'groups', gid, 'locations');
const inviteRef = (db: Firestore, code: string) => doc(db, 'invites', code);

const invite = (gid: string, createdBy: string, expiresAt: Timestamp) => ({
  groupId: gid,
  groupName: 'The Smiths',
  ownerName: 'Sam',
  createdBy,
  expiresAt,
});

const memberDoc = (role: string) => ({ displayName: 'Priya', role, joinedAt: serverTimestamp() });

const position = (overrides: Record<string, unknown> = {}) => ({
  lat: -33.8688,
  lng: 151.2093,
  accuracy: 12,
  updatedAt: serverTimestamp(),
  mode: 'foreground',
  ...overrides,
});

// The flows below go through the rules on purpose: each step is the client write the app will make.

function createGroupBatch(db: Firestore, ownerUid: string, gid = GID) {
  const batch = writeBatch(db);
  batch.set(groupRef(db, gid), {
    name: 'The Smiths',
    ownerUid,
    maxMembers: 4,
    createdAt: serverTimestamp(),
    activeInviteCode: null,
  });
  batch.set(memberRef(db, ownerUid, gid), memberDoc('owner'));
  return batch.commit();
}

async function createInvite(code: string, gid = GID, ownerUid = OWNER) {
  const db = as(ownerUid);
  await setDoc(inviteRef(db, code), invite(gid, ownerUid, Timestamp.fromMillis(Date.now() + DAY_MS)));
  await updateDoc(groupRef(db, gid), { activeInviteCode: code });
}

function requestJoin(uid: string, code: string, gid = GID) {
  return setDoc(requestRef(as(uid), uid, gid), {
    displayName: 'Priya',
    status: 'pending',
    requestedAt: serverTimestamp(),
    inviteCode: code,
  });
}

function approve(uid: string, gid = GID) {
  return updateDoc(requestRef(as(OWNER), uid, gid), { status: 'approved' });
}

function createOwnMember(uid: string, gid = GID, role = 'member') {
  return setDoc(memberRef(as(uid), uid, gid), memberDoc(role));
}

// Leave and remove are the same batch; only who sends it differs.
function removalBatch(db: Firestore, uid: string) {
  const batch = writeBatch(db);
  batch.delete(memberRef(db, uid));
  batch.delete(positionRef(db, uid));
  batch.delete(requestRef(db, uid));
  return batch.commit();
}

// OWNER's group, with MEMBER fully admitted and a live CODE.
async function seedGroupWithMember() {
  await createGroupBatch(as(OWNER), OWNER);
  await createInvite(CODE);
  await requestJoin(MEMBER, CODE);
  await approve(MEMBER);
  await createOwnMember(MEMBER);
}

// Denials are the point of most tests; the SDK would log each one as an error.
useRulesEnvironment('silent');

beforeEach(async () => {
  await env.clearFirestore();
});

describe('creating a Group', () => {
  it('lets the Owner write the Group and their Owner Member document in one batch', async () => {
    await assertSucceeds(createGroupBatch(as(OWNER), OWNER));
    await assertSucceeds(getDoc(groupRef(as(OWNER))));
  });

  it('denies the Owner Member document on its own, without the Group in the same batch', async () => {
    await assertFails(createOwnMember(OWNER, GID, 'owner'));
  });

  it('denies a non-member reading the Group', async () => {
    await createGroupBatch(as(OWNER), OWNER);
    await assertFails(getDoc(groupRef(as(STRANGER))));
    await assertFails(getDoc(groupRef(anon())));
  });
});

describe('Invite codes', () => {
  beforeEach(async () => {
    await createGroupBatch(as(OWNER), OWNER);
    await createInvite(CODE);
  });

  it('lets a signed-in stranger get an Invite by its code', async () => {
    await assertSucceeds(getDoc(inviteRef(as(STRANGER), CODE)));
  });

  it('denies a signed-in stranger listing Invites', async () => {
    await assertFails(getDocs(collection(as(STRANGER), 'invites')));
  });

  it('denies the Owner listing Invites too: no enumeration, ever', async () => {
    await assertFails(getDocs(collection(as(OWNER), 'invites')));
  });

  it('denies a signed-out phone getting an Invite', async () => {
    await assertFails(getDoc(inviteRef(anon(), CODE)));
  });
});

describe('Join requests', () => {
  beforeEach(async () => {
    await createGroupBatch(as(OWNER), OWNER);
    await createGroupBatch(as(STRANGER), STRANGER, OTHER_GID);
  });

  it('denies a Join request with a code that does not exist', async () => {
    await assertFails(requestJoin(JOINER, 'NOPE00'));
  });

  it('denies a Join request with an expired code', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(inviteRef(modular(ctx), 'OLD001'), invite(GID, OWNER, Timestamp.fromMillis(Date.now() - 60 * 1000)));
    });
    await assertFails(requestJoin(JOINER, 'OLD001'));
  });

  it('denies a Join request with a live code for a different Group', async () => {
    await createInvite('OTHER1', OTHER_GID, STRANGER);
    await assertFails(requestJoin(JOINER, 'OTHER1'));
  });

  it('allows a Join request with a live code for the right Group', async () => {
    await createInvite(CODE);
    await assertSucceeds(requestJoin(JOINER, CODE));
  });
});

describe('admitting a Member', () => {
  beforeEach(async () => {
    await createGroupBatch(as(OWNER), OWNER);
    await createInvite(CODE);
  });

  it('denies a uid with no Join request creating its Member document', async () => {
    await assertFails(createOwnMember(JOINER));
  });

  it('denies a uid whose Join request is still pending creating its Member document', async () => {
    await requestJoin(JOINER, CODE);
    await assertFails(createOwnMember(JOINER));
  });

  it('allows an approved uid to create its Member document', async () => {
    await requestJoin(JOINER, CODE);
    await approve(JOINER);
    await assertSucceeds(createOwnMember(JOINER));
  });

  it('denies an approved uid admitting itself as an Owner', async () => {
    await requestJoin(JOINER, CODE);
    await approve(JOINER);
    await assertFails(createOwnMember(JOINER, GID, 'owner'));
  });

  it('denies a joiner approving its own Join request', async () => {
    await requestJoin(JOINER, CODE);
    await assertFails(updateDoc(requestRef(as(JOINER), JOINER), { status: 'approved' }));
  });
});

describe('Positions', () => {
  beforeEach(seedGroupWithMember);

  it('lets a Member write their own Position with the server clock', async () => {
    await assertSucceeds(setDoc(positionRef(as(MEMBER), MEMBER), position()));
    await assertSucceeds(getDocs(positionsRef(as(OWNER))));
  });

  it('denies a non-member reading Positions', async () => {
    await setDoc(positionRef(as(MEMBER), MEMBER), position());
    await assertFails(getDoc(positionRef(as(STRANGER), MEMBER)));
    await assertFails(getDocs(positionsRef(as(STRANGER))));
  });

  it('denies a non-member writing a Position, even under their own uid', async () => {
    await assertFails(setDoc(positionRef(as(STRANGER), STRANGER), position()));
  });

  it("denies a Member writing another Member's Position", async () => {
    await assertFails(setDoc(positionRef(as(MEMBER), OWNER), position()));
    await assertFails(setDoc(positionRef(as(OWNER), MEMBER), position()));
  });

  it("denies a Position stamped with the phone's clock", async () => {
    await assertFails(setDoc(positionRef(as(MEMBER), MEMBER), position({ updatedAt: Timestamp.now() })));
    await assertFails(setDoc(positionRef(as(MEMBER), MEMBER), position({ updatedAt: new Date() })));
  });
});

describe('a removed Member', () => {
  beforeEach(async () => {
    await seedGroupWithMember();
    await setDoc(positionRef(as(MEMBER), MEMBER), position());

    await assertSucceeds(removalBatch(as(OWNER), MEMBER));
  });

  it('cannot recreate its Member document', async () => {
    await assertFails(createOwnMember(MEMBER));
  });

  it('cannot recreate its Member document as an Owner either', async () => {
    await assertFails(createOwnMember(MEMBER, GID, 'owner'));
  });

  it('can no longer read the Group or its Positions', async () => {
    await assertFails(getDoc(groupRef(as(MEMBER))));
    await assertFails(getDocs(positionsRef(as(MEMBER))));
  });

  it('cannot write a Position any more', async () => {
    await assertFails(setDoc(positionRef(as(MEMBER), MEMBER), position()));
  });
});

describe('leaving', () => {
  beforeEach(async () => {
    await seedGroupWithMember();
    await setDoc(positionRef(as(MEMBER), MEMBER), position());
    await setDoc(positionRef(as(OWNER), OWNER), position());
  });

  it('lets a Member leave: their Member document, Position and Join request go in one batch', async () => {
    await assertSucceeds(removalBatch(as(MEMBER), MEMBER));
    await assertFails(createOwnMember(MEMBER));
  });

  it('denies the Owner leaving: they cannot delete their own Member document', async () => {
    await assertFails(deleteDoc(memberRef(as(OWNER), OWNER)));
    await assertFails(removalBatch(as(OWNER), OWNER));
  });

  it("denies a Member deleting another Member's documents", async () => {
    await assertFails(deleteDoc(memberRef(as(MEMBER), OWNER)));
    await assertFails(deleteDoc(positionRef(as(MEMBER), OWNER)));
  });
});
