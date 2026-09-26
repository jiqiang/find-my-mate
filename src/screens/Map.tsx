import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import type { Firestore } from 'firebase/firestore';

import { centreOnFirstPin, type FirstCentre } from '../camera';
import { joinQueue } from '../joinQueue';
import type { Pin } from '../pins';
import { FULL_GROUP_MESSAGE, type MemberRole } from '../session';
import { useApproveJoin } from '../useApproveJoin';
import { useMemberCount } from '../useMemberCount';
import { usePendingJoinRequests } from '../usePendingJoinRequests';
import { usePins } from '../usePins';
import Button from './Button';
import InviteSomeone from './InviteSomeone';
import JoinRequests from './JoinRequests';

// Somewhere to open before the app has a Pin of its own to centre on.
const PLACEHOLDER_COORDINATE = { latitude: -33.8688, longitude: 151.2093 };
const PLACEHOLDER_REGION = {
  ...PLACEHOLDER_COORDINATE,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

// How long the approved joiner's one-off welcome banner stays before it disappears (spec §7.3).
const GREETING_MS = 5000;

// The geometry every top banner shares.
const TOP_BANNER = { position: 'absolute', top: 104, left: 16, right: 16, borderRadius: 12, padding: 16 } as const;

type Props = {
  db: Firestore;
  groupId: string;
  uid: string;
  groupName: string;
  yourName: string;
  role: MemberRole;
  justJoined?: boolean;
};

export default function Map({ db, groupId, uid, groupName, yourName, role, justJoined }: Props) {
  const map = useRef<MapView>(null);
  const firstCentre = useRef<FirstCentre | undefined>(undefined);
  firstCentre.current ??= centreOnFirstPin((region) => map.current?.animateToRegion(region, 300));
  const pins = usePins(db, groupId, uid);
  const isOwner = role === 'owner';
  // The rules deny the Join-request listing to everyone but the Owner, so nobody else asks for it.
  const requests = usePendingJoinRequests(db, groupId, isOwner);
  // The Group's Member count decides whether Approve may be offered at the four-Member cap (spec §5).
  const memberCount = useMemberCount(db, groupId, isOwner);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const queue = joinQueue(requests, memberCount, dismissed);
  const banner = queue.banner;
  const { approve, approving, error: approveError } = useApproveJoin({
    db,
    ownerUid: uid,
    groupId,
    groupName,
    ownerName: yourName,
  });
  // The refusal is authoritative: if the cap fired, show the full banner even before the live count lands.
  const full = queue.full || approveError === FULL_GROUP_MESSAGE;
  const [greetingVisible, setGreetingVisible] = useState(justJoined === true);
  // The ⋯ menu, Invite someone and Join requests; the items built later (Members, Leave) land here.
  const [panel, setPanel] = useState<'none' | 'menu' | 'invite' | 'joinRequests'>('none');

  useEffect(() => {
    firstCentre.current?.pins(pins);
  }, [pins]);

  // The welcome is one-off: it appears on the approval landing and disappears on its own (spec §7.3).
  useEffect(() => {
    if (justJoined !== true) return;
    setGreetingVisible(true);
    const timer = setTimeout(() => setGreetingVisible(false), GREETING_MS);
    return () => clearTimeout(timer);
  }, [justJoined]);

  /** "Not now" writes nothing: it hides this request's banner for the rest of the session (spec §7.5). */
  function notNow() {
    if (!banner) return;
    setDismissed((current) => new Set(current).add(banner.uid));
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        initialRegion={PLACEHOLDER_REGION}
        mapType="standard"
        onMapReady={() => firstCentre.current?.mapReady()}
      >
        {pins.map((pin) => (
          <Marker
            key={pin.uid}
            coordinate={{ latitude: pin.lat, longitude: pin.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            accessibilityLabel={label(pin)}
          >
            <View style={[styles.pin, pin.stale && styles.stalePin]}>
              <Text style={styles.pinLabel}>{label(pin)}</Text>
            </View>
          </Marker>
        ))}
      </MapView>

      <View style={styles.header} pointerEvents="none">
        <Text style={styles.groupName}>{groupName}</Text>
      </View>
      {/* The ⋯ menu holds the Owner's Join requests (when any are pending) and Invite someone, until the
          Members and Leave items land; a non-Owner has nothing to open. */}
      {isOwner && (
        <Pressable
          style={styles.menuButton}
          accessibilityRole="button"
          accessibilityLabel="Menu"
          onPress={() => setPanel(panel === 'menu' ? 'none' : 'menu')}
        >
          <Text style={styles.menuButtonLabel}>⋯</Text>
        </Pressable>
      )}

      {isOwner && panel === 'menu' && (
        <>
          {/* Tapping anywhere off the menu dismisses it. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPanel('none')} />
          <View style={styles.menu}>
            {queue.count > 0 && (
              <Pressable
                style={styles.menuItem}
                accessibilityRole="button"
                onPress={() => setPanel('joinRequests')}
              >
                <Text style={styles.menuItemLabel}>Join requests ({queue.count})</Text>
              </Pressable>
            )}
            <Pressable style={styles.menuItem} accessibilityRole="button" onPress={() => setPanel('invite')}>
              <Text style={styles.menuItemLabel}>Invite someone</Text>
            </Pressable>
          </View>
        </>
      )}

      {panel === 'invite' && (
        <View style={StyleSheet.absoluteFill}>
          <InviteSomeone
            db={db}
            uid={uid}
            groupId={groupId}
            groupName={groupName}
            ownerName={yourName}
            onClose={() => setPanel('none')}
          />
        </View>
      )}

      {panel === 'joinRequests' && (
        <View style={StyleSheet.absoluteFill}>
          <JoinRequests
            db={db}
            uid={uid}
            groupId={groupId}
            groupName={groupName}
            ownerName={yourName}
            requests={queue.requests}
            full={full}
            onClose={() => setPanel('none')}
          />
        </View>
      )}

      {isOwner && banner && (
        <View style={styles.joinBanner}>
          <Text style={styles.joinBannerText}>{banner.displayName} wants to join this group.</Text>
          {full && <Text style={styles.joinBannerFull}>{FULL_GROUP_MESSAGE}</Text>}
          {!full && approveError && <Text style={styles.joinBannerError}>{approveError}</Text>}
          <View style={styles.joinBannerActions}>
            {!full &&
              (approving === banner.uid ? (
                <ActivityIndicator />
              ) : (
                <Button label="Approve" onPress={() => approve(banner.uid)} />
              ))}
            <Button label="Not now" onPress={notNow} />
          </View>
        </View>
      )}

      {greetingVisible && (
        <View style={styles.welcome} pointerEvents="none">
          <Text style={styles.welcomeText}>
            Welcome, {yourName}. You are sharing your location with the family.
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * `{name} · {age}` — the pin's whole label (spec §7.4). A name can be missing only if a Member document
 * somehow holds none: the age still shows, and the name arrives with the next read of that document.
 */
function label(pin: Pin): string {
  return pin.displayName ? `${pin.displayName} · ${pin.age}` : pin.age;
}

const styles = StyleSheet.create({
  header: {
    position: 'absolute',
    top: 56,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  groupName: { fontSize: 17, fontWeight: '600' },
  menuButton: {
    position: 'absolute',
    top: 56,
    right: 16,
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.9)',
  },
  menuButtonLabel: { fontSize: 22, fontWeight: '700' },
  menu: {
    position: 'absolute',
    top: 104,
    right: 16,
    minWidth: 180,
    backgroundColor: 'white',
    borderRadius: 12,
    paddingVertical: 4,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  menuItem: { paddingHorizontal: 16, paddingVertical: 12 },
  menuItemLabel: { fontSize: 16 },
  joinBanner: {
    ...TOP_BANNER,
    backgroundColor: 'white',
    gap: 12,
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  joinBannerText: { fontSize: 16, fontWeight: '600' },
  joinBannerFull: { fontSize: 15, color: '#555' },
  joinBannerError: { fontSize: 15, color: '#b00020' },
  joinBannerActions: { flexDirection: 'row', gap: 12 },
  welcome: { ...TOP_BANNER, backgroundColor: 'rgba(26,115,232,0.95)' },
  welcomeText: { color: 'white', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  pin: {
    backgroundColor: '#1a73e8',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderWidth: 2,
    borderColor: 'white',
  },
  stalePin: { backgroundColor: '#9e9e9e' },
  pinLabel: { color: 'white', fontSize: 13, fontWeight: '600' },
});
