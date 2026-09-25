import { Linking, StyleSheet, Text, View } from 'react-native';

import type { LocationGate } from '../location';
import Button from './Button';

export type BlockedReason = Exclude<LocationGate, 'granted'>;

// The spec §6 wording, verbatim.
const COPY: Record<BlockedReason, string> = {
  denied: "Find My Mate needs your location — the map only works while you're sharing where you are.",
  'services-off': "Turn on location — your phone's location services are off, so the map can't show anyone.",
};

/**
 * No location means no app: there is no read-without-sharing mode, so these two screens stand in for the
 * map entirely (spec §6). Both offer the same way out and the same way back.
 */
export default function BlockedPermission({
  reason,
  onTryAgain,
}: {
  reason: BlockedReason;
  onTryAgain: () => void;
}) {
  return (
    <View style={styles.screen}>
      <Text style={styles.message}>{COPY[reason]}</Text>
      <Button label="Open Settings" onPress={() => void Linking.openSettings()} />
      <Button label="Try again" onPress={onTryAgain} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  message: { fontSize: 17, textAlign: 'center', marginBottom: 24 },
});
