import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { db, signIn } from './src/firebase';
import { appStateForeground } from './src/foreground';
import BlockedPermission from './src/screens/BlockedPermission';
import FirstRun from './src/screens/FirstRun';
import Map from './src/screens/Map';
import { createGroup, loadGroup, type Group } from './src/session';
import { useSharing } from './src/useSharing';

type Phase =
  | { name: 'loading'; error?: string }
  | { name: 'firstRun'; uid: string }
  | { name: 'sharing'; uid: string; group: Group };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    (async () => {
      const user = await signIn();
      console.log(`[auth] signed in as ${user.uid}`);
      const group = await loadGroup(db, user.uid);
      setPhase(group ? { name: 'sharing', uid: user.uid, group } : { name: 'firstRun', uid: user.uid });
    })().catch((error: unknown) => {
      console.warn('[app] start-up failed', error);
      setPhase({ name: 'loading', error: String(error) });
    });
  }, []);

  switch (phase.name) {
    case 'loading':
      return <Loading error={phase.error} />;
    case 'firstRun':
      return (
        <FirstRun
          onCreate={async (yourName, groupName) => {
            // Create asks for location permission, then shows the map (spec §7.2), which Sharing does.
            const group = await createGroup(db, phase.uid, yourName, groupName);
            setPhase({ name: 'sharing', uid: phase.uid, group });
          }}
        />
      );
    case 'sharing':
      return <SharingScreen uid={phase.uid} group={phase.group} />;
  }
}

/**
 * Once there is a Group and a Member, the app shell has one job: show the map or the blocked screen from
 * Sharing's gate answer (ADR 0001). Sharing itself listens to the foreground signal and re-checks the gate.
 */
function SharingScreen({ uid, group }: { uid: string; group: Group }) {
  const { gate, recheck } = useSharing({ db, groupId: group.id, uid, foreground: appStateForeground });

  if (gate === 'checking') return <Loading />;
  if (gate === 'granted') return <Map db={db} groupId={group.id} uid={uid} groupName={group.name} />;
  return <BlockedPermission reason={gate} onTryAgain={recheck} />;
}

function Loading({ error }: { error?: string }) {
  return (
    <View style={styles.centred}>
      <ActivityIndicator size="large" />
      {error && <Text style={styles.error}>Couldn't start: {error}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { marginTop: 16, color: '#b00020', textAlign: 'center' },
});
