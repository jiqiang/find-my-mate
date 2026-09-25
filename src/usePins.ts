import { useEffect, useState } from 'react';
import type { Firestore } from 'firebase/firestore';

import { subscribeToPins, type Pin } from './pins';

/**
 * The map's whole reading layer: the Pins the module hands out, and nothing else. No state of its own
 * survives a subscription, and the unsubscribe the module returns is React's cleanup.
 */
export function usePins(db: Firestore, groupId: string, uid: string): Pin[] {
  const [pins, setPins] = useState<Pin[]>([]);

  useEffect(() => subscribeToPins(db, groupId, uid, setPins), [db, groupId, uid]);

  return pins;
}
