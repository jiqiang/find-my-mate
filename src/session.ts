import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  collection,
  doc,
  getDoc,
  serverTimestamp,
  writeBatch,
  type Firestore,
} from 'firebase/firestore';

export type Group = { id: string; name: string };

const GROUP_ID_KEY = 'groupId';
const GROUP_NAME_KEY = 'groupName';

/**
 * Creates a Group with this phone as its Owner: the Group and the Owner's Member document in one batch
 * (the rules' getAfter() depends on it), then stores groupId. No Invite code is minted.
 */
export async function createGroup(db: Firestore, uid: string, yourName: string, groupName: string): Promise<Group> {
  const displayName = yourName.trim();
  const name = groupName.trim();
  if (!displayName || !name) throw new Error('Your name and Group name are both required.');

  const groupRef = doc(collection(db, 'groups'));
  const batch = writeBatch(db);
  batch.set(groupRef, {
    name,
    ownerUid: uid,
    maxMembers: 4,
    createdAt: serverTimestamp(),
    activeInviteCode: null,
  });
  batch.set(doc(groupRef, 'members', uid), {
    displayName,
    role: 'owner',
    joinedAt: serverTimestamp(),
  });
  await batch.commit();

  // Only after the commit: a failed Create must not leave the phone pointing at a Group that doesn't exist.
  await AsyncStorage.multiSet([
    [GROUP_ID_KEY, groupRef.id],
    [GROUP_NAME_KEY, name],
  ]);
  return { id: groupRef.id, name };
}

/**
 * The stored Group, if this phone is still a Member of it; null means First run.
 * Reading the Group document requires membership under the rules, so a denied read means "not a Member".
 * Offline, the membership can't be checked, so the phone trusts its stored Group rather than stalling.
 */
export async function loadGroup(db: Firestore, uid: string): Promise<Group | null> {
  const [[, groupId], [, storedName]] = await AsyncStorage.multiGet([GROUP_ID_KEY, GROUP_NAME_KEY]);
  if (!groupId) return null;
  try {
    const [group, member] = await Promise.all([
      getDoc(doc(db, 'groups', groupId)),
      getDoc(doc(db, 'groups', groupId, 'members', uid)),
    ]);
    if (!group.exists() || !member.exists()) return null;
    return { id: groupId, name: group.data().name };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'permission-denied') return null;
    if (code === 'unavailable' && storedName) return { id: groupId, name: storedName };
    throw error;
  }
}
