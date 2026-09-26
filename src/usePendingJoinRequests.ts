import { useEffect, useState } from 'react';
import type { Firestore } from 'firebase/firestore';

import { watchPendingJoinRequests, type PendingJoinRequest } from './session';

/**
 * The Owner's view of the Group's pending Join requests (spec §7.4, §7.5): the banner subscribes only when
 * this phone is the Owner, since the rules deny the listing to everyone else. It owns no logic of its own —
 * the unsubscribe the module returns is React's cleanup — and reports nothing while `enabled` is false.
 */
export function usePendingJoinRequests(db: Firestore, groupId: string, enabled: boolean): PendingJoinRequest[] {
  const [requests, setRequests] = useState<PendingJoinRequest[]>([]);

  useEffect(() => {
    if (!enabled) return;
    return watchPendingJoinRequests(db, groupId, setRequests);
  }, [db, groupId, enabled]);

  return requests;
}
