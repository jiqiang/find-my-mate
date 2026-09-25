import * as Location from 'expo-location';
import { doc, serverTimestamp, setDoc, type Firestore } from 'firebase/firestore';

/** Where the OS says the phone is, at one moment: the coordinates and accuracy a Position is made of. */
export type PositionReading = { lat: number; lng: number; accuracy: number };

/** The heartbeat: a JS timer, because watchPositionAsync's `timeInterval` is Android-only (spec §6). */
export const PUBLISH_INTERVAL_MS = 30_000;

/**
 * Why the map is blocked: the two screens in spec §6. `granted` is the only state that shows the map,
 * and iOS "Approximate" counts as granted — the pin is simply coarse.
 */
export type LocationGate = 'granted' | 'denied' | 'services-off';

/**
 * The one decision before the map is shown (spec §7.6), re-run on every return to the foreground and on
 * Try again. The OS prompt is only ever triggered while the permission is undetermined, so it is asked once.
 */
export async function checkLocationGate(): Promise<LocationGate> {
  let permission = await Location.getForegroundPermissionsAsync();
  if (permission.status === 'undetermined') {
    permission = await Location.requestForegroundPermissionsAsync();
  }
  if (permission.granted) {
    return (await Location.hasServicesEnabledAsync()) ? 'granted' : 'services-off';
  }
  // Denied *and* services off is the services screen: that is the switch the phone can still act on.
  return (await Location.hasServicesEnabledAsync()) ? 'denied' : 'services-off';
}

/**
 * The one and only writer of a Position (spec §2): locations/{uid} inside the Group, overwritten each
 * time, so only the latest Position per Member can exist. `updatedAt` is the server's stamp, never the
 * phone's clock — the rules deny a phone-clock write — and `mode` is the field background tracking will
 * extend (§11).
 *
 * Fire-and-forget by design: Firestore queues writes made offline and the next publish corrects the
 * Position anyway, so there is no error UI for a failed or queued write (§6).
 */
export function publishLocation(db: Firestore, groupId: string, uid: string, reading: PositionReading): void {
  void setDoc(doc(db, 'groups', groupId, 'locations', uid), {
    lat: reading.lat,
    lng: reading.lng,
    accuracy: reading.accuracy,
    updatedAt: serverTimestamp(),
    mode: 'foreground',
  }).catch((error: unknown) => {
    console.warn('[location] could not publish this Position', error);
  });
}

/**
 * Location sharing while the map is open. The watch and the timer are started together, and both stop on
 * `pause()` without writing anything, which is what "backgrounding or locking the phone writes nothing"
 * means. `resume()` watches again and publishes the held reading at once.
 *
 * Every start is stamped with a generation, and a watch that arrives after a later pause or start removes
 * itself without publishing, so at most one watch and one heartbeat are live however the phone is put away
 * and brought back (spec §6).
 */
export type Sharing = {
  pause(): void;
  resume(): void;
};

export type SharingOptions = { db: Firestore; groupId: string; uid: string };

/**
 * Starts watching while the map is open, publishing the first reading as soon as the OS reports one. The
 * Sharing comes back before the first watch does: the OS takes a moment, and the phone may be put away and
 * brought back inside that window, so the caller has to be able to pause what it started.
 */
export function startSharing({ db, groupId, uid }: SharingOptions): Sharing {
  let latest: PositionReading | undefined;
  let watcher: Location.LocationSubscription | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  // Bumped by every pause, so a watch that arrives after a pause removes itself instead of leaking.
  let generation = 0;

  const publish = () => {
    if (latest) publishLocation(db, groupId, uid, latest);
  };

  const watch = async () => {
    pause();
    const mine = generation;
    publish(); // The map opened, or the phone came back: the held reading goes out before any new one.

    let delivered = false;
    const started = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High }, ({ coords }) => {
      // A superseded watch reports nothing, so a phone put away mid-start writes nothing on the way out.
      if (mine !== generation) return;
      latest = {
        lat: coords.latitude,
        lng: coords.longitude,
        // A null accuracy is only possible on platforms this app never runs on; §3 stores a number.
        accuracy: coords.accuracy ?? 0,
      };
      if (!delivered) {
        delivered = true; // ...so the pin lands at once rather than at the first heartbeat.
        publish();
      }
    });

    if (mine !== generation) {
      started.remove();
      return;
    }
    watcher = started;
    timer = setInterval(publish, PUBLISH_INTERVAL_MS);
  };

  function pause(): void {
    generation += 1;
    watcher?.remove();
    watcher = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  const resume = () => {
    void watch().catch((error: unknown) => {
      console.warn('[location] could not watch this phone', error);
    });
  };

  resume();
  return { pause, resume };
}
