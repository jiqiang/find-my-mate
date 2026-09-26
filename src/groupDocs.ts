import {
  collection,
  doc,
  serverTimestamp,
  type CollectionReference,
  type DocumentReference,
  type Firestore,
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
