import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { Firestore } from 'firebase/firestore';

import { FULL_GROUP_MESSAGE, type PendingJoinRequest } from '../session';
import { useApproveJoin } from '../useApproveJoin';
import Button from './Button';

type Props = {
  db: Firestore;
  uid: string;
  groupId: string;
  groupName: string;
  ownerName: string;
  requests: PendingJoinRequest[];
  full: boolean;
  onClose: () => void;
};

/**
 * The Owner's ⋯ → Join requests list (spec §7.5): every pending request, each with Approve, so a request
 * stays findable after "Not now" hid the banner. When the Group already has four Members it says so and
 * offers no Approve. There is no deny, withdraw or delete in v1: the list only approves.
 */
export default function JoinRequests({
  db,
  uid,
  groupId,
  groupName,
  ownerName,
  requests,
  full,
  onClose,
}: Props) {
  const { approve, approving, error } = useApproveJoin({ db, ownerUid: uid, groupId, groupName, ownerName });

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Join requests</Text>
      {requests.length === 0 ? (
        <Text style={styles.body}>No one is waiting to join.</Text>
      ) : (
        requests.map((request) => (
          <View key={request.uid} style={styles.row}>
            <Text style={styles.name}>{request.displayName}</Text>
            {!full &&
              (approving === request.uid ? (
                <ActivityIndicator />
              ) : (
                <Button label="Approve" onPress={() => approve(request.uid)} />
              ))}
          </View>
        ))
      )}
      {full && requests.length > 0 && <Text style={styles.full}>{FULL_GROUP_MESSAGE}</Text>}
      {error && <Text style={styles.error}>{error}</Text>}
      <Button label="Close" onPress={onClose} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  body: { fontSize: 17, textAlign: 'center', color: '#555' },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  name: { fontSize: 17, fontWeight: '600' },
  full: { color: '#555', textAlign: 'center' },
  error: { color: '#b00020', textAlign: 'center' },
});
