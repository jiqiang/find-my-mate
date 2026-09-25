import { useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { signIn } from './src/firebase';
import Map from './src/screens/Map';

type Phase = { name: 'loading'; error?: string } | { name: 'map' };

export default function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  useEffect(() => {
    signIn().then(
      (user) => {
        console.log(`[auth] signed in as ${user.uid}`);
        setPhase({ name: 'map' });
      },
      (error: unknown) => {
        console.warn('[auth] sign-in failed', error);
        setPhase({ name: 'loading', error: String(error) });
      },
    );
  }, []);

  switch (phase.name) {
    case 'loading':
      return (
        <View style={styles.centred}>
          <ActivityIndicator size="large" />
          {phase.error && <Text style={styles.error}>Couldn't sign in: {phase.error}</Text>}
        </View>
      );
    case 'map':
      return <Map />;
  }
}

const styles = StyleSheet.create({
  centred: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  error: { marginTop: 16, color: '#b00020', textAlign: 'center' },
});
