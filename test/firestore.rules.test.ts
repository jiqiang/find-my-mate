import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setLogLevel,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

const GID = 'group-one';
const OTHER_GID = 'group-two';
const CODE = 'LIVE01';
const OWNER = 'owner-uid';
const MEMBER = 'member-uid';
const JOINER = 'joiner-uid';
const STRANGER = 'stranger-uid';

const DAY_MS = 24 * 60 * 60 * 1000;

let env: RulesTestEnvironment;

// The test contexts hand back the compat Firestore type; the modular API accepts the instance at runtime.
const modular = (ctx: RulesTestContext) => ctx.firestore() as unknown as Firestore;
const as = (uid: string) => modular(env.authenticatedContext(uid));
const anon = () => modular(env.unauthenticatedContext());

const groupRef = (db: Firestore, gid = GID) => doc(db, 'groups', gid);
const memberRef = (db: Firestore, uid: string, gid = GID) => doc(db, 'groups', gid, 'members', uid);
const requestRef = (db: Firestore, uid: string, gid = GID) => doc(db, 'groups', gid, 'joinRequests', uid);
const positionRef = (db: Firestore, uid: string, gid = GID) => doc(db, 'groups', gid, 'locations', uid);
const inviteRef = (db: Firestore, code: string) => doc(db, 'invites', code);

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
  batch.set(memberRef(db, ownerUid, gid), {
    displayName: 'Sam',
    role: 'owner',
    joinedAt: serverTimestamp(),
  });
  return batch.commit();
}

async function createInvite(code: string, gid = GID, ownerUid = OWNER) {
  const db = as(ownerUid);
  await setDoc(inviteRef(db, code), {
    groupId: gid,
    groupName: 'The Smiths',
    ownerName: 'Sam',
    createdBy: ownerUid,
    expiresAt: Timestamp.fromMillis(Date.now() + DAY_MS),
  });
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

function admitSelf(uid: string, gid = GID, role = 'member') {
  return setDoc(memberRef(as(uid), uid, gid), {
    displayName: 'Priya',
    role,
    joinedAt: serverTimestamp(),
  });
}

// OWNER's group, with MEMBER fully admitted and a live CODE.
async function seedGroupWithMember() {
  await createGroupBatch(as(OWNER), OWNER);
  await createInvite(CODE);
  await requestJoin(MEMBER, CODE);
  await approve(MEMBER);
  await admitSelf(MEMBER);
}

beforeAll(async () => {
  // Denials are the point of most tests; the SDK would log each one as an error.
  setLogLevel('silent');
  env = await initializeTestEnvironment({
    projectId: 'demo-find-my-mate',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
});

describe('creating a Group', () => {
  it('lets the Owner write the Group and their Owner Member document in one batch', async () => {
    await assertSucceeds(createGroupBatch(as(OWNER), OWNER));
    await assertSucceeds(getDoc(groupRef(as(OWNER))));
  });

  it('denies the Owner Member document on its own, without the Group in the same batch', async () => {
    await assertFails(
      setDoc(memberRef(as(OWNER), OWNER), { displayName: 'Sam', role: 'owner', joinedAt: serverTimestamp() }),
    );
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
      await setDoc(inviteRef(modular(ctx), 'OLD001'), {
        groupId: GID,
        groupName: 'The Smiths',
        ownerName: 'Sam',
        createdBy: OWNER,
        expiresAt: Timestamp.fromMillis(Date.now() - 60 * 1000),
      });
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
    await assertFails(admitSelf(JOINER));
  });

  it('denies a uid whose Join request is still pending creating its Member document', async () => {
    await requestJoin(JOINER, CODE);
    await assertFails(admitSelf(JOINER));
  });

  it('allows an approved uid to create its Member document', async () => {
    await requestJoin(JOINER, CODE);
    await approve(JOINER);
    await assertSucceeds(admitSelf(JOINER));
  });

  it('denies an approved uid admitting itself as an Owner', async () => {
    await requestJoin(JOINER, CODE);
    await approve(JOINER);
    await assertFails(admitSelf(JOINER, GID, 'owner'));
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
    await assertSucceeds(getDocs(collection(as(OWNER), 'groups', GID, 'locations')));
  });

  it('denies a non-member reading Positions', async () => {
    await setDoc(positionRef(as(MEMBER), MEMBER), position());
    await assertFails(getDoc(positionRef(as(STRANGER), MEMBER)));
    await assertFails(getDocs(collection(as(STRANGER), 'groups', GID, 'locations')));
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

    // The Owner's remove batch: Member document, Position and Join request together.
    const db = as(OWNER);
    const batch = writeBatch(db);
    batch.delete(memberRef(db, MEMBER));
    batch.delete(positionRef(db, MEMBER));
    batch.delete(requestRef(db, MEMBER));
    await assertSucceeds(batch.commit());
  });

  it('cannot recreate its Member document', async () => {
    await assertFails(admitSelf(MEMBER));
  });

  it('cannot recreate its Member document as an Owner either', async () => {
    await assertFails(admitSelf(MEMBER, GID, 'owner'));
  });

  it('can no longer read the Group or its Positions', async () => {
    await assertFails(getDoc(groupRef(as(MEMBER))));
    await assertFails(getDocs(collection(as(MEMBER), 'groups', GID, 'locations')));
  });

  it('cannot write a Position any more', async () => {
    await assertFails(setDoc(positionRef(as(MEMBER), MEMBER), position()));
  });
});

describe('the Owner', () => {
  beforeEach(seedGroupWithMember);

  it('cannot delete their own Member document', async () => {
    await assertFails(deleteDoc(memberRef(as(OWNER), OWNER)));
  });
});
