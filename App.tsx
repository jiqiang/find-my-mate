import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { db, signIn } from './src/firebase';
import FirstRun from './src/screens/FirstRun';
import Map from './src/screens/Map';
import { createGroup, loadGroup, type Group } from './src/session';

type Phase =
  | { name: 'loading'; error?: string }
  | { name: 'firstRun'; uid: string }
  | { name: 'map'; group: Group };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    (async () => {
      const user = await signIn();
      console.log(`[auth] signed in as ${user.uid}`);
      const group = await loadGroup(db, user.uid);
      setPhase(group ? { name: 'map', group } : { name: 'firstRun', uid: user.uid });
    })().catch((error: unknown) => {
      console.warn('[app] start-up failed', error);
      setPhase({ name: 'loading', error: String(error) });
    });
  }, []);

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
            setPhase({ name: 'map', group });
          }}
        />
      );
    case 'map':
      return <Map groupName={phase.group.name} />;
  }
}

const styles = StyleSheet.create({
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { marginTop: 16, color: '#b00020', textAlign: 'center' },
});
