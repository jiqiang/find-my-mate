import { useCallback, useEffect, useRef, useState } from 'react';

import { startPhases, type Phase, type Phases, type PhasesOptions } from './phases';

/**
 * The UI's whole view of the launch decision: the current phase and First run's Create. It owns no
 * logic of its own — Phases decides every transition — and starts in an effect and stops on unmount, so
 * a render that is thrown away never leaves a sign-in or group load behind.
 */
export function usePhase(options: PhasesOptions): {
  phase: Phase;
  createGroup: (yourName: string, groupName: string) => Promise<void>;
} {
  const { db, signIn } = options;
  const phases = useRef<Phases | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    const started = startPhases({ db, signIn });
    phases.current = started;
    setPhase(started.phase);
    const unsubscribe = started.subscribe(setPhase);
    return () => {
      unsubscribe();
      started.stop();
      phases.current = undefined;
    };
  }, [db, signIn]);

  const createGroup = useCallback(
    (yourName: string, groupName: string) => phases.current?.createGroup(yourName, groupName) ?? Promise.resolve(),
    [],
  );

  return { phase, createGroup };
}
