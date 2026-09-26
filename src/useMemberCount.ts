import { useEffect, useState } from 'react';
import type { Firestore } from 'firebase/firestore';

import { watchMemberCount } from './session';

/**
 * The Group's live Member count, for the Owner's cap check (spec §5, §7.5): the map needs it to know
 * whether Approve may be offered. The rules admit the listing to a Member, so only the Owner's map asks
 * for it. It owns no logic of its own — the unsubscribe the module returns is React's cleanup — and
 * reports nothing (0) while `enabled` is false.
 */
export function useMemberCount(db: Firestore, groupId: string, enabled: boolean): number {
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    return watchMemberCount(db, groupId, setCount);
  }, [db, groupId, enabled]);

  return count;
}
