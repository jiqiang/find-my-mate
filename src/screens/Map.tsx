import { useEffect, useRef } from 'react';
import { AppState, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import type { Firestore } from 'firebase/firestore';

import { startSharing } from '../location';
import type { Pin } from '../pins';
import { usePins } from '../usePins';

// Somewhere to open before the app has a Pin of its own to centre on.
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
  groupName: string;
};

export default function Map({ db, groupId, uid, groupName }: Props) {
  const map = useRef<MapView>(null);
  const centred = useRef(false);
  const pins = usePins(db, groupId, uid);
  const mine = pins.find((pin) => pin.mine);
  usePublishing(db, groupId, uid);

  useEffect(() => {
    // Centre on the first Pin this phone has, so its own pin is on screen as soon as there is one.
    if (centred.current || !mine) return;
    centred.current = true;
    map.current?.animateToRegion({ latitude: mine.lat, longitude: mine.lng, ...NEIGHBOURHOOD }, 300);
  }, [mine]);

  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView
        ref={map}
        style={StyleSheet.absoluteFill}
        initialRegion={PLACEHOLDER_REGION}
        mapType="standard"
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

/** Shares this phone while the map is open, and writes nothing whenever the phone is put away (§6). */
function usePublishing(db: Firestore, groupId: string, uid: string): void {
  useEffect(() => {
    // The Sharing is in hand before its first watch exists, so pausing it is never too early and this
    // hook needs no guard of its own (ticket 18).
    const sharing = startSharing({ db, groupId, uid });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') sharing.resume();
      else sharing.pause();
    });
    return () => {
      subscription.remove();
      sharing.pause();
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
