import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  getDoc,
  onSnapshot,
  Timestamp,
  writeBatch,
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase/firestore';

import {
  addCreateGroup,
  addJoinMember,
  addJoinRequest,
  addMintInvite,
  groupRef,
  inviteRef,
  joinRequestRef,
  memberRef,
  newGroupId,
} from './groupDocs';

/** The Group this phone is in, with this phone's own Member name for its pin (spec §7.4). */
export type Group = { id: string; name: string; displayName: string | null };

const GROUP_ID_KEY = 'groupId';
const GROUP_NAME_KEY = 'groupName';
const DISPLAY_NAME_KEY = 'displayName';
const OWNER_NAME_KEY = 'ownerName';

/**
 * What the stored groupId means at launch (spec §7.1): a Member (Map), a phone whose own Join request is
 * still `pending` (Waiting), a phone whose request is `approved` but whose Member document has not been
 * written yet (the approved-while-closed case), or no Group at all (First run). The names a Waiting phone
 * needs come from storage, because the invite it joined through may already be gone (spec §7.2).
 */
export type Start =
  | { kind: 'member'; group: Group }
  | { kind: 'waiting'; groupId: string; groupName: string; ownerName: string }
  | { kind: 'approved'; groupId: string; groupName: string }
  | { kind: 'firstRun' };

/** The answer to a join attempt: the Group to wait in, or the one failure the Join screen names. */
export type JoinResult =
  | { ok: true; groupId: string; groupName: string; ownerName: string }
  | { ok: false; reason: 'bad-code' };

/** The live Invite code the Owner reads out, and when it stops working (spec §7.5). */
export type InviteCode = { code: string; expiresAt: Date };

/** How the phone's own Join request reads: `gone` is a request that was deleted under it. */
export type JoinRequestStatus = 'pending' | 'approved' | 'gone';

/**
 * Creates a Group with this phone as its Owner: the Group and the Owner's Member document in one batch
 * (the rules' getAfter() depends on it), then stores groupId. No Invite code is minted.
 */
export async function createGroup(db: Firestore, uid: string, yourName: string, groupName: string): Promise<Group> {
  const displayName = yourName.trim();
  const name = groupName.trim();
  if (!displayName || !name) throw new Error('Your name and Group name are both required.');

  const gid = newGroupId(db);
  const batch = writeBatch(db);
  addCreateGroup(batch, db, gid, { ownerUid: uid, displayName, groupName: name });
  await batch.commit();

  // Only after the commit: a failed Create must not leave the phone pointing at a Group that doesn't exist.
  await AsyncStorage.multiSet([
    [GROUP_ID_KEY, gid],
    [GROUP_NAME_KEY, name],
    [DISPLAY_NAME_KEY, displayName],
  ]);
  return { id: gid, name, displayName };
}

/**
 * The §7.1 start read: what the stored groupId means. Reading the Member document requires membership
 * under the rules, so a denied read means "not a Member" and the phone then reads its own Join request,
 * which the rules let it see. Offline, membership cannot be checked, so the phone trusts the names it
 * stored rather than stalling: a member's stored name means Map, a joiner's stored `ownerName` means
 * Waiting, and with neither there is nothing to trust.
 */
export async function loadStart(db: Firestore, uid: string): Promise<Start> {
  const [[, groupId], [, storedName], [, storedDisplayName], [, storedOwnerName]] = await AsyncStorage.multiGet([
    GROUP_ID_KEY,
    GROUP_NAME_KEY,
    DISPLAY_NAME_KEY,
    OWNER_NAME_KEY,
  ]);
  if (!groupId) return { kind: 'firstRun' };

  try {
    const member = await readOrNull(memberRef(db, groupId, uid));
    if (member?.exists()) {
      const group = await getDoc(groupRef(db, groupId));
      if (!group.exists()) return { kind: 'firstRun' };
      return {
        kind: 'member',
        group: { id: groupId, name: group.data().name, displayName: member.data()?.displayName ?? null },
      };
    }

    const request = await readOrNull(joinRequestRef(db, groupId, uid));
    const status = request?.data()?.status;
    if (status === 'pending') {
      return { kind: 'waiting', groupId, groupName: storedName ?? '', ownerName: storedOwnerName ?? '' };
    }
    if (status === 'approved') {
      return { kind: 'approved', groupId, groupName: storedName ?? '' };
    }
    return { kind: 'firstRun' };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'unavailable') {
      if (storedDisplayName) {
        return { kind: 'member', group: { id: groupId, name: storedName ?? '', displayName: storedDisplayName } };
      }
      if (storedOwnerName) {
        return { kind: 'waiting', groupId, groupName: storedName ?? '', ownerName: storedOwnerName };
      }
    }
    throw error;
  }
}

/**
 * Joins a Group with an Invite code: one read of `invites/{code}`, then one pending Join request
 * (spec §7.2, §7.3). A missing, expired or already-deleted code is the same failure the Join screen shows
 * as "That code isn't right.", and writes nothing. The three names the Waiting screen needs are stored
 * only after the request commits, so a failed join never leaves the phone waiting for nothing.
 */
export async function joinGroup(
  db: Firestore,
  uid: string,
  code: string,
  yourName: string,
): Promise<JoinResult> {
  const displayName = yourName.trim();
  if (!displayName) throw new Error('Your name is required.');

  const normalized = code.trim().toUpperCase();
  if (!normalized) return { ok: false, reason: 'bad-code' };

  let invite: DocumentSnapshot;
  try {
    invite = await getDoc(inviteRef(db, normalized));
  } catch (error) {
    // An expired code is denied to a joiner (the Owner may still read it), which is the same answer.
    if ((error as { code?: unknown }).code === 'permission-denied') return { ok: false, reason: 'bad-code' };
    throw error;
  }
  if (!invite.exists()) return { ok: false, reason: 'bad-code' };

  const data = invite.data()!;
  if (!isLive(data.expiresAt)) return { ok: false, reason: 'bad-code' };

  const batch = writeBatch(db);
  addJoinRequest(batch, db, data.groupId, uid, { displayName, inviteCode: normalized });
  await batch.commit();

  await AsyncStorage.multiSet([
    [GROUP_ID_KEY, data.groupId],
    [GROUP_NAME_KEY, data.groupName],
    [OWNER_NAME_KEY, data.ownerName],
  ]);
  return { ok: true, groupId: data.groupId, groupName: data.groupName, ownerName: data.ownerName };
}

/**
 * Materialises an approved joiner's own Member document: the typed name comes from the Join request, the
 * role is `member`, and `joinedAt` is the server's stamp (spec §7.3). The rules admit it only while that
 * request says `approved`. The typed name is also stored, so a relaunch offline still reaches the map.
 */
export async function becomeMember(
  db: Firestore,
  uid: string,
  groupId: string,
  groupName: string,
): Promise<Group> {
  const request = await getDoc(joinRequestRef(db, groupId, uid));
  const displayName = (request.data()?.displayName as string | undefined) ?? '';

  const batch = writeBatch(db);
  addJoinMember(batch, db, groupId, uid, { displayName });
  await batch.commit();

  await AsyncStorage.multiSet([[DISPLAY_NAME_KEY, displayName]]);
  return { id: groupId, name: groupName, displayName };
}

/**
 * 8 characters from §7.5's alphabet `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`: 32 symbols, so ~40 bits. It drops
 * the look-alike 0/O and 1/I. (§7.5's prose also names L, but its 32-character string keeps L, and 32
 * symbols is what yields the ~40 bits; the string is what is implemented.)
 */
const INVITE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const INVITE_CODE_LENGTH = 8;

/** An Invite lives 24 h from the Owner's clock's now (spec §3); the clock caveat is accepted there. */
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

/** A fresh Invite code: 8 characters, each from the unambiguous 32-character alphabet (spec §7.5). */
export function newInviteCode(): string {
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) {
    code += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  }
  return code;
}

/**
 * The code Invite someone should show: the Group's live `activeInviteCode`, or a freshly minted one when
 * there is none or it has expired. Opening the screen calls this; it never mints a second live code.
 */
export async function ensureInvite(
  db: Firestore,
  uid: string,
  groupId: string,
  { groupName, ownerName }: { groupName: string; ownerName: string },
): Promise<InviteCode> {
  const current = await activeInviteCode(db, groupId);
  if (current) {
    const live = await readLiveInvite(db, current);
    if (live) return live;
  }
  return mintInvite(db, uid, groupId, { groupName, ownerName }, current);
}

/**
 * New code: mints a replacement for the Group's current code and deletes the old document in the same
 * batch, so there is no revoked state and no window with two live codes (spec §5, §7.5).
 */
export async function rotateInvite(
  db: Firestore,
  uid: string,
  groupId: string,
  { groupName, ownerName }: { groupName: string; ownerName: string },
): Promise<InviteCode> {
  return mintInvite(db, uid, groupId, { groupName, ownerName }, await activeInviteCode(db, groupId));
}

/**
 * Follows this phone's own Join request while it waits (spec §7.3): every snapshot reports `pending`,
 * `approved`, or `gone`. Returns the unsubscribe; a failed read is logged and never thrown into the UI.
 */
export function watchJoinRequest(
  db: Firestore,
  groupId: string,
  uid: string,
  onChange: (status: JoinRequestStatus) => void,
): () => void {
  return onSnapshot(
    joinRequestRef(db, groupId, uid),
    (snapshot) => {
      if (!snapshot.exists()) {
        onChange('gone');
        return;
      }
      onChange(snapshot.data().status === 'approved' ? 'approved' : 'pending');
    },
    (error) => console.warn('[session] could not follow the Join request', error),
  );
}

/** Writes the replacement Invite, moves the Group's pointer, and deletes the old document, in one batch. */
async function mintInvite(
  db: Firestore,
  uid: string,
  groupId: string,
  { groupName, ownerName }: { groupName: string; ownerName: string },
  previousCode: string | null,
): Promise<InviteCode> {
  const code = newInviteCode();
  const expiresAt = Timestamp.fromDate(new Date(Date.now() + INVITE_TTL_MS));
  const batch = writeBatch(db);
  addMintInvite(batch, db, groupId, code, {
    groupName,
    ownerName,
    createdBy: uid,
    expiresAt,
    previousCode,
  });
  await batch.commit();
  return { code, expiresAt: expiresAt.toDate() };
}

/** The Group's `activeInviteCode`, or null when it has none: the pointer the Owner's screens follow. */
async function activeInviteCode(db: Firestore, groupId: string): Promise<string | null> {
  const group = await getDoc(groupRef(db, groupId));
  return (group.data()?.activeInviteCode as string | null | undefined) ?? null;
}

/** The live invite behind `code`, or null when it is missing, expired or unreadable by this phone. */
async function readLiveInvite(db: Firestore, code: string): Promise<InviteCode | null> {
  try {
    const snapshot = await getDoc(inviteRef(db, code));
    if (!snapshot.exists()) return null;
    const expiresAt = snapshot.data().expiresAt as Timestamp;
    if (!isLive(expiresAt)) return null;
    return { code, expiresAt: expiresAt.toDate() };
  } catch (error) {
    const failure = (error as { code?: unknown }).code;
    if (failure === 'permission-denied' || failure === 'not-found') return null;
    throw error;
  }
}

/**
 * A document read that answers null instead of throwing when the rules deny it: "not a Member" and "no
 * readable Join request" are both answers here, not errors. Any other failure — offline, above all —
 * still throws, so the caller can fall back to what it stored.
 */
async function readOrNull(ref: DocumentReference): Promise<DocumentSnapshot | null> {
  try {
    return await getDoc(ref);
  } catch (error) {
    if ((error as { code?: unknown }).code === 'permission-denied') return null;
    throw error;
  }
}

/** Whether an Invite's expiry is still in the future, judged on this phone's clock as spec §3 accepts. */
function isLive(expiresAt: unknown): boolean {
  return expiresAt instanceof Timestamp && expiresAt.toMillis() > Date.now();
}
