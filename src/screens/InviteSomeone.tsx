import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import type { Firestore } from 'firebase/firestore';

import { ensureInvite, rotateInvite, type InviteCode } from '../session';
import Button from './Button';

type Props = {
  db: Firestore;
  uid: string;
  groupId: string;
  groupName: string;
  ownerName: string;
  onClose: () => void;
};

/**
 * The Owner's Invite someone screen (spec §7.5). Opening it shows the Group's live code — minting one
 * only when there is none — large enough to read aloud, with the expiry and New code. The code is not the
 * gate: it only points at the Group, and the Owner's approval is what admits anyone.
 */
export default function InviteSomeone({ db, uid, groupId, groupName, ownerName, onClose }: Props) {
  const [invite, setInvite] = useState<InviteCode>();
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const live = await ensureInvite(db, uid, groupId, { groupName, ownerName });
        if (!cancelled) setInvite(live);
      } catch (e) {
        console.warn('[session] could not open an Invite', e);
        if (!cancelled) setError("Couldn't get a code. Try again.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [db, uid, groupId, groupName, ownerName]);

  async function newCode() {
    if (inFlight.current) return;
    inFlight.current = true;
    setWorking(true);
    setError(undefined);
    try {
      setInvite(await rotateInvite(db, uid, groupId, { groupName, ownerName }));
    } catch (e) {
      console.warn('[session] could not rotate the Invite', e);
      setError("Couldn't get a new code. Try again.");
    } finally {
      inFlight.current = false;
      setWorking(false);
    }
  }

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Invite someone</Text>
      {invite ? (
        <>
          <Text style={styles.code}>{invite.code}</Text>
          <Text style={styles.hint}>
            Read this out to whoever is joining. It works until {formatExpiry(invite.expiresAt)}.
          </Text>
          {working ? <ActivityIndicator style={styles.spinner} /> : <Button label="New code" onPress={newCode} />}
        </>
      ) : error ? null : (
        <ActivityIndicator style={styles.spinner} />
      )}
      {error && <Text style={styles.error}>{error}</Text>}
      <Button label="Close" onPress={onClose} />
    </View>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The expiry, without Intl: "Wed 14:05". A 24 h code is unambiguous enough to read out. */
function formatExpiry(when: Date): string {
  const hours = String(when.getHours()).padStart(2, '0');
  const minutes = String(when.getMinutes()).padStart(2, '0');
  return `${DAYS[when.getDay()]} ${hours}:${minutes}`;
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 12, backgroundColor: '#fff' },
  title: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  code: { fontSize: 44, fontWeight: '700', letterSpacing: 6, textAlign: 'center', fontVariant: ['tabular-nums'] },
  hint: { fontSize: 15, textAlign: 'center', color: '#555' },
  spinner: { padding: 14 },
  error: { color: '#b00020', textAlign: 'center' },
});
