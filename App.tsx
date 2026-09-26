import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';

import { db, signIn } from './src/firebase';
import { appStateForeground } from './src/foreground';
import BlockedPermission from './src/screens/BlockedPermission';
import FirstRun from './src/screens/FirstRun';
import Map from './src/screens/Map';
import Waiting from './src/screens/Waiting';
import type { Group } from './src/session';
import { usePhase } from './src/usePhase';
import { useSharing } from './src/useSharing';

/**
 * The app shell: one screen per phase, and no decision of its own. The launch decision lives in
 * `src/phases.ts` (spec §7.1), including Create moving First run to sharing and Join moving it to Waiting.
 */
export default function App() {
  const { phase, createGroup, join } = usePhase({ db, signIn });

  switch (phase.name) {
    case 'loading':
      return <Loading />;
    case 'error':
      return <Loading error={phase.message} />;
    case 'firstRun':
      return <FirstRun onCreate={createGroup} onJoin={join} />;
    case 'waiting':
      return <Waiting ownerName={phase.ownerName} />;
    case 'sharing':
      return <SharingScreen uid={phase.uid} group={phase.group} justJoined={phase.justJoined} />;
  }
}

/**
 * Once there is a Group and a Member, the app shell has one job: show the map or the blocked screen from
 * Sharing's gate answer (ADR 0001). Sharing itself listens to the foreground signal and re-checks the gate.
 */
function SharingScreen({ uid, group, justJoined }: { uid: string; group: Group; justJoined?: boolean }) {
  const { gate, recheck } = useSharing({ db, groupId: group.id, uid, foreground: appStateForeground });

  if (gate === 'checking') return <Loading />;
  if (gate === 'granted') {
    return (
      <Map
        db={db}
        groupId={group.id}
        uid={uid}
        groupName={group.name}
        yourName={group.displayName ?? ''}
        role={group.role}
        justJoined={justJoined}
      />
    );
  }
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
