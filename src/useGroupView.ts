import { useEffect, useState } from 'react';
import type { Firestore } from 'firebase/firestore';

import { subscribeToGroupView, type GroupView } from './groupView';

/** The map's state before the Group's first two reads have answered: nothing drawn, the line held back. */
const EMPTY: GroupView = { loaded: false, pins: [], members: [], nobodyElseSharing: false };

/**
 * The map's whole reading layer: the Group view the module hands out, and nothing else. No state of its own
 * survives a subscription, and the unsubscribe the module returns is React's cleanup.
 */
export function useGroupView(db: Firestore, groupId: string, uid: string): GroupView {
  const [view, setView] = useState<GroupView>(EMPTY);

  useEffect(() => subscribeToGroupView(db, groupId, uid, setView), [db, groupId, uid]);

  return view;
}
