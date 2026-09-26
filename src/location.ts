import * as Location from 'expo-location';
import { serverTimestamp, setDoc, type Firestore } from 'firebase/firestore';

import { positionRef } from './groupDocs';

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
  void setDoc(positionRef(db, groupId, uid), {
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
 * The foreground signal: whether the app is in front, and a way to hear when that changes. Two adapters
 * implement it — one over React Native's AppState, one a fake in tests — which is the seam that lets
 * Sharing's lifecycle run in Node (ADR 0001).
 */
export type Foreground = {
  isActive(): boolean;
  subscribe(listener: (active: boolean) => void): () => void;
};

/** The gate's answer, plus the not-yet-answered state only the very first check passes through. */
export type SharingGate = LocationGate | 'checking';

/**
 * Sharing is the one owner of "put away" and "came back" (ADR 0001). It listens to the foreground signal
 * itself: on a return it checks the Location gate first, and only if the gate says granted does it watch
 * again and publish the held reading at once. Put away — anything that is not `active` — stops the watch
 * and heartbeat and writes nothing. `gate` and `subscribe` are the answer for the UI, `recheck()` is Try
 * again, and `stop()` ends it for good.
 */
export type Sharing = {
  readonly gate: SharingGate;
  subscribe(listener: (gate: SharingGate) => void): () => void;
  recheck(): Promise<void>;
  stop(): void;
};

export type SharingOptions = { db: Firestore; groupId: string; uid: string; foreground: Foreground };

/**
 * Starts sharing this phone's Position with the Group. Returns synchronously — before the first gate check
 * and the first watch exist — so the caller can always `stop()` what it started.
 *
 * One epoch guards the whole lifecycle: every check and every watch captures it, and applies its effect
 * only while it is still the newest. `stop()` and every put-away bump it, so a late gate answer or a late
 * watch removes itself instead of publishing after the phone was put away or Sharing was stopped.
 */
export function startSharing({ db, groupId, uid, foreground }: SharingOptions): Sharing {
  let latest: PositionReading | undefined;
  let watcher: Location.LocationSubscription | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let active = foreground.isActive();
  let epoch = 0;
  let gate: SharingGate = 'checking';

  const listeners = new Set<(gate: SharingGate) => void>();

  const setGate = (next: SharingGate) => {
    if (gate === next) return;
    gate = next;
    for (const listener of listeners) listener(gate);
  };

  const publish = () => {
    if (latest) publishLocation(db, groupId, uid, latest);
  };

  const stopWatch = () => {
    watcher?.remove();
    watcher = undefined;
    if (timer) clearInterval(timer);
    timer = undefined;
  };

  /** Watches under `myEpoch`, and publishes the held reading at once — the map opened, or the phone came back. */
  const watch = async (myEpoch: number) => {
    publish();
    let delivered = false;
    let started: Location.LocationSubscription;
    try {
      started = await Location.watchPositionAsync({ accuracy: Location.Accuracy.High }, ({ coords }) => {
        // A superseded watch reports nothing, so a phone put away mid-start writes nothing on the way out.
        if (myEpoch !== epoch) return;
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
    } catch (error) {
      console.warn('[location] could not watch this phone', error);
      return;
    }

    if (myEpoch !== epoch || stopped) {
      started.remove();
      return;
    }
    watcher = started;
    timer = setInterval(publish, PUBLISH_INTERVAL_MS);
  };

  /** Checks the gate, and watches only if it says granted and the phone is still in front (spec §6, §7.6). */
  const checkGateAndWatch = async () => {
    const myEpoch = ++epoch; // Supersede any earlier check or watch: this is the newest decision.
    stopWatch(); // Hold no watch while the gate is unanswered.
    let answer: LocationGate;
    try {
      answer = await checkLocationGate();
    } catch (error) {
      // Never fall through to sharing: an unanswered gate is not a granted one. Try again re-runs it.
      console.warn('[location] could not check the location permission', error);
      answer = 'denied';
    }
    if (stopped || myEpoch !== epoch) return;
    setGate(answer);
    if (answer === 'granted' && active) await watch(myEpoch);
  };

  const unsubscribe = foreground.subscribe((isActive) => {
    if (stopped) return;
    active = isActive;
    if (isActive) {
      void checkGateAndWatch();
    } else {
      epoch += 1; // Everything in flight is now superseded.
      stopWatch(); // Nothing is written on the way out.
    }
  });

  void checkGateAndWatch();

  return {
    get gate() {
      return gate;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    recheck() {
      return stopped ? Promise.resolve() : checkGateAndWatch();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      epoch += 1;
      stopWatch();
      unsubscribe();
      listeners.clear();
    },
  };
}
