import {
  collection,
  doc,
  serverTimestamp,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
  type Timestamp,
  type WriteBatch,
} from 'firebase/firestore';

/**
 * The Group's Firestore layout, and the only place that builds a `groups/{id}/…` or `invites/{code}` path
 * (spec §3, §4). Callers speak Group, Member, Position, Join request and Invite, so a layout change lands
 * here and nowhere else.
 *
 * The batches live here for the same reason. The rules read a Group and a Member together in one batch
 * through `getAfter()` (`isOwnerAfter` in firestore.rules), so Create cannot split its two writes across
 * two commits. Every builder adds its writes to a caller's `WriteBatch` and never commits: the caller owns
 * the commit, and with it the order that keeps a failed write from leaving the phone pointing at nothing.
 */

/** The whole `groups` collection. Only for a rules-disabled listing, since the rules allow no list. */
export function groupsRef(db: Firestore): CollectionReference {
  return collection(db, 'groups');
}

/** The Group document. */
export function groupRef(db: Firestore, gid: string): DocumentReference {
  return doc(db, 'groups', gid);
}

/** One Member of a Group. */
export function memberRef(db: Firestore, gid: string, uid: string): DocumentReference {
  return doc(db, 'groups', gid, 'members', uid);
}

/** Every Member of a Group. */
export function membersRef(db: Firestore, gid: string): CollectionReference {
  return collection(db, 'groups', gid, 'members');
}

/** One Member's latest Position. */
export function positionRef(db: Firestore, gid: string, uid: string): DocumentReference {
  return doc(db, 'groups', gid, 'locations', uid);
}

/** Every Position in a Group. */
export function positionsRef(db: Firestore, gid: string): CollectionReference {
  return collection(db, 'groups', gid, 'locations');
}

/** One phone's pending Join request. Unused until ticket 07 asks and ticket 08 approves. */
export function joinRequestRef(db: Firestore, gid: string, uid: string): DocumentReference {
  return doc(db, 'groups', gid, 'joinRequests', uid);
}

/** One Invite code's document. Unused until ticket 07 mints and rotates codes. */
export function inviteRef(db: Firestore, code: string): DocumentReference {
  return doc(db, 'invites', code);
}

/** A random, not-yet-written Group id for Create to write the Group's whole batch under. */
export function newGroupId(db: Firestore): string {
  return doc(groupsRef(db)).id;
}

/**
 * Adds Create's two writes to `batch`: the Group and the Owner's own Member document. `displayName` and
 * `groupName` arrive already trimmed and checked; this writes exactly the fields the rules allow, both
 * timestamps from the server, and the Member keyed by the owner's uid.
 */
export function addCreateGroup(
  batch: WriteBatch,
  db: Firestore,
  gid: string,
  { ownerUid, displayName, groupName }: { ownerUid: string; displayName: string; groupName: string },
): void {
  batch.set(groupRef(db, gid), {
    name: groupName,
    ownerUid,
    maxMembers: 4,
    createdAt: serverTimestamp(),
    activeInviteCode: null,
  });
  batch.set(memberRef(db, gid, ownerUid), {
    displayName,
    role: 'owner',
    joinedAt: serverTimestamp(),
  });
}

/**
 * Adds one phone's pending Join request to `batch`: the typed name, `status: 'pending'`, a server
 * `requestedAt` and the Invite code that opened the door (spec §3). The rules require the code to still be
 * live and pointed at this Group, which is why joining reads the Invite before this write.
 */
export function addJoinRequest(
  batch: WriteBatch,
  db: Firestore,
  gid: string,
  uid: string,
  { displayName, inviteCode }: { displayName: string; inviteCode: string },
): void {
  batch.set(joinRequestRef(db, gid, uid), {
    displayName,
    status: 'pending',
    requestedAt: serverTimestamp(),
    inviteCode,
  });
}

/**
 * Adds the approved joiner's own Member document to `batch`: `role: 'member'` and a server `joinedAt`. The
 * rules admit this write only once the same uid's Join request says `approved` (`approved(gid)`), so it
 * never runs before the Owner has approved.
 */
export function addJoinMember(
  batch: WriteBatch,
  db: Firestore,
  gid: string,
  uid: string,
  { displayName }: { displayName: string },
): void {
  batch.set(memberRef(db, gid, uid), {
    displayName,
    role: 'member',
    joinedAt: serverTimestamp(),
  });
}

/**
 * Adds a minted Invite code to `batch` (spec §3, §5): the `invites/{code}` document, the Group's
 * `activeInviteCode` pointer, and — when there was a previous code — the deletion of the old document.
 * Order matters as the spec states it: the replacement is written first, the pointer moves next, and the
 * old document goes last, all in one atomic batch, so no phone can ever read a Group that points at a code
 * that does not exist and no `revoked` state has to exist.
 */
export function addMintInvite(
  batch: WriteBatch,
  db: Firestore,
  gid: string,
  code: string,
  {
    groupName,
    ownerName,
    createdBy,
    expiresAt,
    previousCode,
  }: {
    groupName: string;
    ownerName: string;
    createdBy: string;
    expiresAt: Timestamp;
    previousCode?: string | null;
  },
): void {
  batch.set(inviteRef(db, code), {
    groupId: gid,
    groupName,
    ownerName,
    createdBy,
    expiresAt,
  });
  batch.set(groupRef(db, gid), { activeInviteCode: code }, { merge: true });
  if (previousCode && previousCode !== code) batch.delete(inviteRef(db, previousCode));
}
