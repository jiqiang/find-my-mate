import { useEffect, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, Text, View } from 'react-native';

import { db, signIn } from './src/firebase';
import { checkLocationGate, type LocationGate } from './src/location';
import BlockedPermission, { type BlockedReason } from './src/screens/BlockedPermission';
import FirstRun from './src/screens/FirstRun';
import Map from './src/screens/Map';
import { createGroup, loadGroup, type Group } from './src/session';

type Phase =
  | { name: 'loading'; error?: string }
  | { name: 'firstRun'; uid: string }
  | { name: 'blocked'; uid: string; group: Group; reason: BlockedReason }
  | { name: 'map'; uid: string; group: Group };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  /** The gate in §7.6: nothing shows the map but a granted permission, and services must be on too. */
  const showMapOrBlocked = async (uid: string, group: Group) => {
    let gate: LocationGate;
    try {
      gate = await checkLocationGate();
    } catch (error) {
      // Never fall through to the map: an unanswered gate is not a granted one. Try again re-runs it.
      console.warn('[app] could not check the location permission', error);
      gate = 'denied';
    }
    setPhase(gate === 'granted' ? { name: 'map', uid, group } : { name: 'blocked', uid, group, reason: gate });
  };

  useEffect(() => {
    (async () => {
      const user = await signIn();
      console.log(`[auth] signed in as ${user.uid}`);
      const group = await loadGroup(db, user.uid);
      if (group) await showMapOrBlocked(user.uid, group);
      else setPhase({ name: 'firstRun', uid: user.uid });
    })().catch((error: unknown) => {
      console.warn('[app] start-up failed', error);
      setPhase({ name: 'loading', error: String(error) });
    });
  }, []);

  // Every return to the foreground re-checks permission and services, which also covers iOS "Allow Once".
  useEffect(() => {
    if (phase.name !== 'map' && phase.name !== 'blocked') return;
    const { uid, group } = phase;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void showMapOrBlocked(uid, group);
    });
    return () => subscription.remove();
  }, [phase]);

  switch (phase.name) {
    case 'loading':
      return (
        <View style={styles.centred}>
          <ActivityIndicator size="large" />
          {phase.error && <Text style={styles.error}>Couldn't start: {phase.error}</Text>}
        </View>
      );
    case 'firstRun':
      return (
        <FirstRun
          onCreate={async (yourName, groupName) => {
            const group = await createGroup(db, phase.uid, yourName, groupName);
            // Create asks for location permission, then shows the map (spec §7.2).
            await showMapOrBlocked(phase.uid, group);
          }}
        />
      );
    case 'blocked':
      return (
        <BlockedPermission
          reason={phase.reason}
          onTryAgain={() => void showMapOrBlocked(phase.uid, phase.group)}
        />
      );
    case 'map':
      return (
        <Map
          db={db}
          groupId={phase.group.id}
          uid={phase.uid}
          displayName={phase.group.displayName}
          groupName={phase.group.name}
        />
      );
  }
}

const styles = StyleSheet.create({
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { marginTop: 16, color: '#b00020', textAlign: 'center' },
});
