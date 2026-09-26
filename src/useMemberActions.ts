import { useRef, useState } from 'react';
import type { Firestore } from 'firebase/firestore';

import { removeMember, renameMember, renameSelf } from './session';

/**
 * The Member list's Rename and Remove from group (spec §7.4), shared by every row. It owns the in-flight
 * row and the failure message; the list itself updates on its own, because the Group view follows the
 * Member documents. Renaming your own row remembers the name so an offline relaunch keeps it; the Owner
 * renaming another Member changes only that phone's name.
 */
export function useMemberActions(options: { db: Firestore; groupId: string; ownUid: string }): {
  rename: (uid: string, displayName: string) => Promise<boolean>;
  remove: (uid: string) => Promise<boolean>;
  busyUid: string | null;
  error: string | null;
} {
  const { db, groupId, ownUid } = options;
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // State lags a render behind, so a fast double-tap would pass a state check twice and write twice.
  const inFlight = useRef(false);

  async function run(uid: string, action: () => Promise<unknown>): Promise<boolean> {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusyUid(uid);
    setError(null);
    try {
      await action();
      return true;
    } catch (e) {
      console.warn('[session] the Member action failed', e);
      setError("Couldn't do that. Try again.");
      return false;
    } finally {
      inFlight.current = false;
      setBusyUid(null);
    }
  }

  return {
    rename: (uid, displayName) =>
      run(uid, () =>
        uid === ownUid
          ? renameSelf(db, groupId, uid, displayName)
          : renameMember(db, groupId, uid, displayName),
      ),
    remove: (uid) => run(uid, () => removeMember(db, groupId, uid)),
    busyUid,
    error,
  };
}
