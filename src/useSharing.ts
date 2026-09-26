import { useCallback, useEffect, useRef, useState } from 'react';

import { startSharing, type Sharing, type SharingGate, type SharingOptions } from './location';

/**
 * The UI's whole view of Sharing (ADR 0001): the gate's latest answer and Try again. It owns no logic of
 * its own — Sharing listens to the foreground signal itself — and starts on mount and stops on unmount,
 * inside an effect, so a render that is thrown away never leaves a watch or a subscription behind.
 */
export function useSharing(options: SharingOptions): {
  gate: SharingGate;
  recheck: () => Promise<void>;
} {
  const { db, groupId, uid, foreground } = options;
  const sharing = useRef<Sharing | undefined>(undefined);
  const [gate, setGate] = useState<SharingGate>('checking');

  useEffect(() => {
    const started = startSharing({ db, groupId, uid, foreground });
    sharing.current = started;
    setGate(started.gate);
    const unsubscribe = started.subscribe(setGate);
    return () => {
      unsubscribe();
      started.stop();
      sharing.current = undefined;
    };
  }, [db, groupId, uid, foreground]);

  const recheck = useCallback(() => sharing.current?.recheck() ?? Promise.resolve(), []);

  return { gate, recheck };
}
