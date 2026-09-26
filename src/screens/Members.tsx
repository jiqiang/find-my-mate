import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { MemberRow } from '../groupView';
import Button from './Button';

type Props = {
  /** One row per Member, from the Group view: this phone, an updated Member, or one with no Position yet. */
  members: MemberRow[];
  /** Tapping a row hands back the spot to centre on, or null for a Member who has never published. */
  onPick: (position: { lat: number; lng: number } | null) => void;
  onClose: () => void;
};

/**
 * ⋯ → Members (spec §7.4): one row per Member, each labelled by the Group view. Tapping a row closes the
 * list and centres the map on that Member. The trailing Rename and Remove-from-group affordances are
 * ticket 11; this screen only reads and centres.
 */
export default function Members({ members, onPick, onClose }: Props) {
  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Members</Text>
      {members.map((member) => (
        <Pressable
          key={member.uid}
          style={styles.row}
          accessibilityRole="button"
          onPress={() => onPick(member.position)}
        >
          <Text style={styles.label}>{member.label}</Text>
        </Pressable>
      ))}
      <Button label="Close" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  row: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#ddd' },
  label: { fontSize: 17, fontWeight: '600' },
});
