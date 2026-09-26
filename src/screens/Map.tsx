import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import type { Firestore } from 'firebase/firestore';

import { frameFirstPins, neighbourhoodRegion, type FirstFrame } from '../camera';
import type { Pin } from '../groupView';
import { joinQueue } from '../joinQueue';
import { FULL_GROUP_MESSAGE, type MemberRole } from '../session';
import { useApproveJoin } from '../useApproveJoin';
import { useGroupView } from '../useGroupView';
import { useMemberCount } from '../useMemberCount';
import { usePendingJoinRequests } from '../usePendingJoinRequests';
import Button from './Button';
import InviteSomeone from './InviteSomeone';
import JoinRequests from './JoinRequests';
import Members from './Members';

// Somewhere to open before the app has a Pin of its own to frame or centre on.
const PLACEHOLDER_COORDINATE = { latitude: -33.8688, longitude: 151.2093 };
const PLACEHOLDER_REGION = {
  ...PLACEHOLDER_COORDINATE,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

// How long the approved joiner's one-off welcome banner stays before it disappears (spec §7.3).
const GREETING_MS = 5000;

// The look every top banner shares; the stack they sit in owns where they are pinned.
const TOP_BANNER = { borderRadius: 12, padding: 16 } as const;

type Props = {
  db: Firestore;
  groupId: string;
  uid: string;
  groupName: string;
  yourName: string;
  role: MemberRole;
  justJoined?: boolean;
  /** The Member's own Leave (spec §7.5): the batch, clearing the stored Group, then First run. */
  onLeave: () => Promise<void>;
};

export default function Map({ db, groupId, uid, groupName, yourName, role, justJoined, onLeave }: Props) {
  const map = useRef<MapView>(null);
  const firstFrame = useRef<FirstFrame | undefined>(undefined);
  firstFrame.current ??= frameFirstPins({
    fit: (coordinates, padding) =>
      map.current?.fitToCoordinates([...coordinates], {
        edgePadding: { top: padding, right: padding, bottom: padding, left: padding },
        animated: true,
      }),
    moveTo: (region) => map.current?.animateToRegion(region, 300),
  });
  const view = useGroupView(db, groupId, uid);
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
  // The ⋯ menu: Members for everyone, the Owner's Join requests and Invite someone, and the panels they open.
  const [panel, setPanel] = useState<'none' | 'menu' | 'members' | 'invite' | 'joinRequests'>('none');
  // Leave in flight, and its failure, shown in the menu it was tapped from (spec §7.5).
  const [leaving, setLeaving] = useState(false);
  const [leaveError, setLeaveError] = useState<string | null>(null);

  useEffect(() => {
    firstFrame.current?.view(view);
  }, [view]);

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

  /** Leave confirms first (spec §7.5): the run only starts once the Member taps Leave on the dialog. */
  function confirmLeave() {
    Alert.alert('Leave this group?', "You'll need a new invite code to come back.", [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => void doLeave() },
    ]);
  }

  async function doLeave() {
    setLeaving(true);
    setLeaveError(null);
    try {
      await onLeave();
    } catch (e) {
      console.warn('[phases] could not leave the Group', e);
      setLeaveError("Couldn't leave. Try again.");
    } finally {
      setLeaving(false);
    }
  }

  // The recentre button and a tapped member row both move at the recentre zoom (spec §7.4).
  const mine = view.pins.find((pin) => pin.mine);
  function centreOn(position: { lat: number; lng: number }) {
    map.current?.animateToRegion(neighbourhoodRegion(position.lat, position.lng), 300);
  }

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        initialRegion={PLACEHOLDER_REGION}
        mapType="standard"
        onMapReady={() => firstFrame.current?.mapReady()}
      >
        {view.pins.map((pin) => (
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

      {/* The ⋯ menu: Members for everyone, the Owner's Join requests (when any are pending) and Invite
          someone, and Leave group for everyone but the Owner. */}
      <Pressable
        style={styles.menuButton}
        accessibilityRole="button"
        accessibilityLabel="Menu"
        onPress={() => setPanel(panel === 'menu' ? 'none' : 'menu')}
      >
        <Text style={styles.menuButtonLabel}>⋯</Text>
      </Pressable>

      {/* The top stack: the "No one is sharing yet" line, the Owner's join-request banner, and the joiner's
          welcome. They flow instead of overlapping when more than one applies. */}
      <View style={styles.topStack} pointerEvents="box-none">
        {view.nobodyElseSharing && (
          <View style={styles.notice} pointerEvents="none">
            <Text style={styles.noticeText}>No one is sharing yet. Ask them to open the app.</Text>
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

      {/* ⦿ Recentre: back to this phone at the recentre zoom. Disabled until this phone has a Position. */}
      <Pressable
        style={[styles.recentreButton, !mine && styles.recentreDisabled]}
        accessibilityRole="button"
        accessibilityLabel="Centre on me"
        disabled={!mine}
        onPress={() => {
          if (mine) centreOn(mine);
        }}
      >
        <Text style={styles.recentreLabel}>⦿</Text>
      </Pressable>

      {panel === 'menu' && (
        <>
          {/* Tapping anywhere off the menu dismisses it. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setPanel('none')} />
          <View style={styles.menu}>
            <Pressable style={styles.menuItem} accessibilityRole="button" onPress={() => setPanel('members')}>
              <Text style={styles.menuItemLabel}>Members</Text>
            </Pressable>
            {isOwner && queue.count > 0 && (
              <Pressable
                style={styles.menuItem}
                accessibilityRole="button"
                onPress={() => setPanel('joinRequests')}
              >
                <Text style={styles.menuItemLabel}>Join requests ({queue.count})</Text>
              </Pressable>
            )}
            {isOwner && (
              <Pressable style={styles.menuItem} accessibilityRole="button" onPress={() => setPanel('invite')}>
                <Text style={styles.menuItemLabel}>Invite someone</Text>
              </Pressable>
            )}
            {!isOwner && (
              <Pressable
                style={styles.menuItem}
                accessibilityRole="button"
                accessibilityLabel="Leave group"
                disabled={leaving}
                onPress={confirmLeave}
              >
                <Text style={styles.menuItemLabel}>{leaving ? 'Leaving…' : 'Leave group'}</Text>
              </Pressable>
            )}
            {leaveError && <Text style={styles.menuError}>{leaveError}</Text>}
          </View>
        </>
      )}

      {/* The panels are full-screen and come last, so they cover the map chrome while they are open. */}
      {panel === 'members' && (
        <View style={StyleSheet.absoluteFill}>
          <Members
            db={db}
            groupId={groupId}
            uid={uid}
            isOwner={isOwner}
            members={view.members}
            onPick={(position) => {
              if (position) centreOn(position);
              setPanel('none');
            }}
            onClose={() => setPanel('none')}
          />
        </View>
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
  menuError: { paddingHorizontal: 16, paddingBottom: 12, color: '#b00020' },
  topStack: { position: 'absolute', top: 104, left: 16, right: 16, gap: 12 },
  notice: {
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  noticeText: { fontSize: 15, textAlign: 'center' },
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
  recentreButton: {
    position: 'absolute',
    bottom: 32,
    right: 16,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.95)',
    shadowColor: '#000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  recentreDisabled: { opacity: 0.4 },
  recentreLabel: { fontSize: 24, fontWeight: '700' },
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
