import { StyleSheet, Text, View } from 'react-native';

/**
 * This phone with a pending Join request (spec §7.3): it names the Owner to ask, and follows its own Join
 * request behind the scenes, so an approval lands on the map without anything typed again. There is no
 * cancel in v1 (§12). The screen holds no logic; Phases decides when to leave it.
 */
export default function Waiting({ ownerName }: { ownerName: string }) {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Ask {ownerName} to approve</Text>
      <Text style={styles.body}>We'll let you in as soon as {ownerName} approves.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  body: { fontSize: 17, textAlign: 'center', color: '#555' },
});
