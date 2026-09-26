import { useRef, useState } from 'react';
import type { Firestore } from 'firebase/firestore';

import { approveJoinRequest } from './session';

/**
 * The Owner's Approve, shared by the banner and the ⋯ → Join requests list (spec §7.5). It owns the one
 * in-flight action at a time and the failure message both surfaces show; the request leaves the queue on
 * its own, because the Owner's pending-request watcher drops it once it is approved.
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
      setError("Couldn't approve. Try again.");
    } finally {
      inFlight.current = false;
      setApproving(null);
    }
  }

  return { approve, approving, error };
}
