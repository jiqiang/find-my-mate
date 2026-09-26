/**
 * An in-memory expo-location for Node: the real module needs Expo's native bridge, so the location gate
 * and the Position publisher are driven through this fake by the tests (vitest.config.ts aliases the
 * package here). `Accuracy` mirrors expo-location's LocationAccuracy enum (High = 4).
 */

export const Accuracy = {
  Lowest: 1,
  Low: 2,
  Balanced: 3,
  High: 4,
  Highest: 5,
  BestForNavigation: 6,
} as const;

export type FakePermission = {
  status: 'undetermined' | 'granted' | 'denied';
  granted: boolean;
  canAskAgain: boolean;
  expires: 'never';
  /** iOS reports Approximate as granted with a coarse accuracy. */
  ios?: { accuracy: 'full' | 'approximate'; scope: 'whenInUse' | 'always' };
};

type Reading = { lat: number; lng: number; accuracy?: number | null };
type Watch = {
  options: { accuracy?: number; timeInterval?: number; distanceInterval?: number };
  callback: (location: LocationObject) => void;
  live: boolean;
};
type Subscription = { remove: () => void };
/** A watch the OS is still setting up, and the resolver that hands its subscription back later. */
type Held = { watch: Watch; release: (subscription: Subscription) => void };

export type LocationObject = {
  coords: {
    latitude: number;
    longitude: number;
    altitude: number | null;
    accuracy: number | null;
    altitudeAccuracy: number | null;
    heading: number | null;
    speed: number | null;
  };
  timestamp: number;
};

function permission(granted: boolean, accuracy: 'full' | 'approximate'): FakePermission {
  return {
    status: granted ? 'granted' : 'denied',
    granted,
    canAskAgain: !granted,
    expires: 'never',
    ios: { accuracy, scope: 'whenInUse' },
  };
}

/** The phone's location plumbing, as the app sees it. Tests read it directly through the helpers below. */
export const os = {
  permission: { status: 'undetermined', granted: false, canAskAgain: true, expires: 'never' } as FakePermission,
  /** What tapping the OS prompt will do; null leaves the permission undetermined. */
  prompt: null as { granted: boolean; accuracy: 'full' | 'approximate' } | null,
  services: true,
  /** How many times the OS prompt was shown. */
  prompts: 0,
  /** Every watch the OS holds, including ones whose subscription has not been handed back yet. */
  watches: [] as Watch[],
  /** Watches still being set up: the OS is reporting from them but the app cannot remove them yet. */
  held: [] as Held[],
  holding: false,
  /** When true, the permission check throws, as a broken OS would. */
  broken: false,
  /** Permission checks the OS is still answering: the app is suspended on the promise they hold. */
  heldChecks: [] as ((permission: FakePermission) => void)[],
  holdingChecks: false,
};

export function reset(): void {
  os.permission = { status: 'undetermined', granted: false, canAskAgain: true, expires: 'never' };
  os.prompt = null;
  os.services = true;
  os.prompts = 0;
  os.watches = [];
  os.held = [];
  os.holding = false;
  os.broken = false;
  os.heldChecks = [];
  os.holdingChecks = false;
}

/** The next time the OS prompt appears, the user grants it. */
export function promptGrants(accuracy: 'full' | 'approximate' = 'full'): void {
  os.prompt = { granted: true, accuracy };
}

/** The next time the OS prompt appears, the user denies it. */
export function promptDenies(): void {
  os.prompt = { granted: false, accuracy: 'full' };
}

/** The user changed the permission in Settings while the app was away. */
export function grantedInSettings(accuracy: 'full' | 'approximate' = 'full'): void {
  os.permission = permission(true, accuracy);
}

export function deniedInSettings(): void {
  os.permission = permission(false, 'full');
}

export function setServices(enabled: boolean): void {
  os.services = enabled;
}

/** The OS location service is unavailable: every gate check throws. */
export function breakPermissionCheck(): void {
  os.broken = true;
}

/** The OS starts answering a permission check and does not return until `releasePermissionChecks()`. */
export function holdPermissionChecks(): void {
  os.holdingChecks = true;
}

/** Answer every permission check the OS has been holding, with whatever the permission is now. */
export function releasePermissionChecks(): void {
  os.holdingChecks = false;
  for (const release of os.heldChecks.splice(0)) release(os.permission);
}

/** One reading the OS reports, to every live watch — a watch still being set up reports like any other. */
export function emit(reading: Reading): void {
  for (const watch of os.watches.filter((w) => w.live)) {
    watch.callback({
      coords: {
        latitude: reading.lat,
        longitude: reading.lng,
        altitude: null,
        accuracy: reading.accuracy === undefined ? 15 : reading.accuracy,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: Date.now(),
    });
  }
}

export function liveWatches(): Watch[] {
  return os.watches.filter((watch) => watch.live);
}

function subscription(watch: Watch): Subscription {
  return {
    remove() {
      watch.live = false;
    },
  };
}

/** The OS starts setting the watch up and does not hand the app a subscription until `releaseWatches()`. */
export function holdWatches(): void {
  os.holding = true;
}

/** Hand back every subscription the OS has been holding, in the order the watches were created. */
export function releaseWatches(): void {
  os.holding = false;
  for (const { watch, release } of os.held.splice(0)) release(subscription(watch));
}

export async function getForegroundPermissionsAsync(): Promise<FakePermission> {
  if (os.broken) throw new Error('the OS location service is unavailable');
  if (os.holdingChecks) return new Promise((release) => os.heldChecks.push(release));
  return os.permission;
}

export async function requestForegroundPermissionsAsync(): Promise<FakePermission> {
  os.prompts += 1;
  if (os.prompt) os.permission = permission(os.prompt.granted, os.prompt.accuracy);
  return os.permission;
}

export async function hasServicesEnabledAsync(): Promise<boolean> {
  return os.services;
}

export function watchPositionAsync(
  options: Watch['options'],
  callback: Watch['callback'],
): Promise<Subscription> {
  const watch: Watch = { options, callback, live: true };
  os.watches.push(watch);
  if (!os.holding) return Promise.resolve(subscription(watch));
  return new Promise((release) => os.held.push({ watch, release }));
}
