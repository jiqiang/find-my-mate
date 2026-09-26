import { useRef, useState } from 'react';
import type { Firestore } from 'firebase/firestore';

import { approveJoinRequest, FULL_GROUP_MESSAGE } from './session';

/**
 * The Owner's Approve, shared by the banner and the ⋯ → Join requests list (spec §7.5). It owns the
 * in-flight action and the failure message its surface shows; the request leaves the queue on its own,
 * because the Owner's pending-request watcher drops it once it is approved.
 */
export function useApproveJoin(options: {
  db: Firestore;
  ownerUid: string;
  groupId: string;
  groupName: string;
  ownerName: string;
}): {
  approve: (requesterUid: string) => Promise<void>;
  approving: string | null;
  error: string | null;
} {
  const { db, ownerUid, groupId, groupName, ownerName } = options;
  const [approving, setApproving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // State lags a render behind, so a fast double-tap would pass a state check twice and approve twice.
  const inFlight = useRef(false);

  async function approve(requesterUid: string): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setApproving(requesterUid);
    setError(null);
    try {
      await approveJoinRequest(db, ownerUid, groupId, requesterUid, { groupName, ownerName });
    } catch (e) {
      console.warn('[session] could not approve the Join request', e);
      // The cap refusal is the Owner's own message, not a failure to retry: keep it verbatim. It is what
      // shows when the cap is hit before the live Member count has told the banner the Group is full.
      setError(e instanceof Error && e.message === FULL_GROUP_MESSAGE ? FULL_GROUP_MESSAGE : "Couldn't approve. Try again.");
    } finally {
      inFlight.current = false;
      setApproving(null);
    }
  }

  return { approve, approving, error };
}
