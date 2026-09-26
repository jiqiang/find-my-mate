import { useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import type { Firestore } from 'firebase/firestore';

import type { MemberRow } from '../groupView';
import { useMemberActions } from '../useMemberActions';
import Button from './Button';

type Props = {
  db: Firestore;
  groupId: string;
  uid: string;
  /** The Owner's view offers Rename and Remove on every other row (spec §7.4). */
  isOwner: boolean;
  /** One row per Member, from the Group view: this phone, an updated Member, or one with no Position yet. */
  members: MemberRow[];
  /** Tapping a row hands back the spot to centre on, or null for a Member who has never published. */
  onPick: (position: { lat: number; lng: number } | null) => void;
  onClose: () => void;
};

/**
 * ⋯ → Members (spec §7.4): one row per Member, each labelled by the Group view. Tapping a row closes the
 * list and centres the map on that Member. A trailing Rename sits on your own row and, on the Owner's view
 * of every other row, Rename and Remove from group sit beside it. Rename is separate from the tap.
 */
export default function Members({ db, groupId, uid, isOwner, members, onPick, onClose }: Props) {
  const { rename, remove, busyUid, error } = useMemberActions({ db, groupId, ownUid: uid });
  // The row whose name is being edited, and the draft typed so far.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  function startRename(member: MemberRow) {
    setEditing(member.uid);
    setDraft(member.displayName ?? '');
  }

  async function saveRename(member: MemberRow) {
    if (draft.trim() === '') return;
    if (await rename(member.uid, draft)) setEditing(null);
  }

  function confirmRemove(member: MemberRow) {
    const name = member.displayName ?? 'this member';
    Alert.alert(`Remove ${name} from the group?`, 'Their pin disappears and their phone leaves the group.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void remove(member.uid) },
    ]);
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Members</Text>
      {members.map((member) => (
        <View key={member.uid} style={styles.row}>
          {editing === member.uid ? (
            <>
              <TextInput
                style={styles.input}
                value={draft}
                onChangeText={setDraft}
                accessibilityLabel={`Rename ${member.displayName ?? 'member'}`}
                autoCapitalize="words"
                autoFocus
                editable={busyUid !== member.uid}
                onSubmitEditing={() => void saveRename(member)}
              />
              {busyUid === member.uid ? (
                <ActivityIndicator />
              ) : (
                <>
                  <Button label="Save" onPress={() => void saveRename(member)} disabled={draft.trim() === ''} />
                  <Button label="Cancel" onPress={() => setEditing(null)} />
                </>
              )}
            </>
          ) : (
            <>
              <Pressable
                style={styles.labelArea}
                accessibilityRole="button"
                onPress={() => onPick(member.position)}
              >
                <Text style={styles.label}>{member.label}</Text>
              </Pressable>
              {busyUid === member.uid ? (
                <ActivityIndicator />
              ) : (
                <>
                  {(member.mine || isOwner) && (
                    <Button label="Rename" onPress={() => startRename(member)} />
                  )}
                  {isOwner && !member.mine && (
                    <Button label="Remove from group" onPress={() => confirmRemove(member)} />
                  )}
                </>
              )}
            </>
          )}
        </View>
      ))}
      {error && <Text style={styles.error}>{error}</Text>}
      <Button label="Close" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  labelArea: { flex: 1, paddingVertical: 12 },
  label: { fontSize: 17, fontWeight: '600' },
  input: { flex: 1, borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 10, fontSize: 17 },
  error: { color: '#b00020', textAlign: 'center' },
});
