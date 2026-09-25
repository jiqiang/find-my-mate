import { useEffect, useRef, useState } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { doc, onSnapshot, type Firestore } from 'firebase/firestore';

import { AGE_TICK_MS, ageLabel, isStale, positionFrom, startSharing, type Position, type Sharing } from '../location';

// Somewhere to open before the app has a Position of its own to centre on.
const PLACEHOLDER_COORDINATE = { latitude: -33.8688, longitude: 151.2093 };
const PLACEHOLDER_REGION = {
  ...PLACEHOLDER_COORDINATE,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};
// Roughly a neighbourhood: the zoom the recentre button will use (spec §7.4).
const NEIGHBOURHOOD = { latitudeDelta: 0.01, longitudeDelta: 0.01 };

type Props = {
  db: Firestore;
  groupId: string;
  uid: string;
  displayName: string | null;
  groupName: string;
};

export default function Map({ db, groupId, uid, displayName, groupName }: Props) {
  const map = useRef<MapView>(null);
  const centred = useRef(false);
  const position = useMyPosition(db, groupId, uid);
  const now = useNow();
  usePublishing(db, groupId, uid);

  useEffect(() => {
    // Centre on the first Position this phone has, so its own pin is on screen as soon as there is one.
    if (centred.current || !position) return;
    centred.current = true;
    map.current?.animateToRegion({ latitude: position.lat, longitude: position.lng, ...NEIGHBOURHOOD }, 300);
  }, [position]);

  // `{name} · {age}` — the pin's whole label. A name can be missing only for an install that first ran
  // before this ticket, offline: the age still shows, and the name arrives with the next launch.
  const age = position ? ageLabel(position.updatedAt, now) : null;
  const label = age && (displayName ? `${displayName} · ${age}` : age);
  const stale = position ? isStale(position.updatedAt, now) : false;

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        initialRegion={PLACEHOLDER_REGION}
        mapType="standard"
      >
        {position && (
          <Marker
            coordinate={{ latitude: position.lat, longitude: position.lng }}
            anchor={{ x: 0.5, y: 0.5 }}
            accessibilityLabel={label ?? undefined}
          >
            <View style={[styles.pin, stale && styles.stalePin]}>
              <Text style={styles.pinLabel}>{label}</Text>
            </View>
          </Marker>
        )}
      </MapView>
      <View style={styles.header} pointerEvents="none">
        <Text style={styles.groupName}>{groupName}</Text>
      </View>
    </View>
  );
}

/** This phone's own Position as stored, so its age is the server's receipt time, not the OS's. */
function useMyPosition(db: Firestore, groupId: string, uid: string): Position | null {
  const [position, setPosition] = useState<Position | null>(null);

  useEffect(() => {
    return onSnapshot(
      doc(db, 'groups', groupId, 'locations', uid),
      (snapshot) => setPosition(positionFrom(snapshot.data(), Date.now())),
      // Silence is normal in v1: a failed read is not something the phone can act on (§6).
      (error) => console.warn('[map] could not read this Position', error),
    );
  }, [db, groupId, uid]);

  return position;
}

/** Ages re-render on a 15-second beat with no new data, so a pin ages and greys out on its own (§6). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const ticker = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(ticker);
  }, []);

  return now;
}

/** Shares this phone while the map is open, and writes nothing whenever the phone is put away (§6). */
function usePublishing(db: Firestore, groupId: string, uid: string): void {
  useEffect(() => {
    let sharing: Sharing | undefined;
    let open = true;

    const resume = () => {
      open = true;
      if (!sharing) {
        void startSharing({ db, groupId, uid }).then((started) => {
          sharing = started;
          if (!open) started.pause(); // Put away while the watch was still starting.
        });
        return;
      }
      void sharing.resume();
    };
    const pause = () => {
      open = false;
      sharing?.pause();
    };

    resume();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') resume();
      else pause();
    });
    return () => {
      subscription.remove();
      pause();
    };
  }, [db, groupId, uid]);
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
