import {
  disableNetwork,
  getDocs,
  setDoc,
  Timestamp,
  writeBatch,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as osLocation from './fakes/expo-location';
import { fakeForeground } from './fakes/foreground';
import { as, env, modular, sleep, useRulesEnvironment, waitForSnapshot } from './fakes/rules';
import {
  addCreateGroup,
  positionRef as groupPositionRef,
  positionsRef as groupPositionsRef,
} from '../src/groupDocs';
import {
  checkLocationGate,
  publishLocation,
  startSharing,
  type Foreground,
  type LocationGate,
  type Sharing,
} from '../src/location';

// Ways the location gate and the Position publisher (ticket 06) could fail, written before src/location.ts:
//  1. A permission that has never been asked is never asked, so the phone can never show the map.
//  2. The OS prompt is shown again on a later check although it has already been answered.
//  3. A denied permission still shows the map.
//  4. iOS Approximate — granted, but coarse — is treated as blocked.
//  5. Location services off shows the map, or is reported as permission-denied instead of the services screen.
//  6. Granting permission in Settings does not move the phone to the map on the next check.
//  7. A Position lands anywhere but locations/{uid}, or a new document per write instead of one per Member.
//  8. A write carries the phone's clock instead of the server timestamp, or drops mode / accuracy.
//  9. A write carries lat/lng the rules reject (out of range, swapped, non-numeric).
// 10. A denied or queued write throws into the UI; there is no error UI for Positions.
// 11. Backgrounding publishes a Position on the way out.
// 12. Coming back to the foreground publishes nothing until the following 30-second tick.
// 13. The heartbeat is not a 30-second JS timer, or it never fires.
// 14. Stopping the watch leaves it live, so the app keeps publishing after the map is gone.
//
// The pin's age, its Stale line and the reading of a pending write are no longer this module's: ticket 13
// moved them behind src/groupView.ts, and their failing ways are listed at the top of test/groupView.test.ts.
//
// Ways sharing could fail while the OS is still setting the first watch up (ticket 18), written before the
// fix. Putting the phone away and bringing it back inside that window:
// 15. leaves the first watch live, so it goes on reporting after it was superseded.
// 16. leaves a second 30-second heartbeat running, so the phone publishes twice per beat.
// 17. lets the superseded watch publish a Position on the way out, which §6 forbids.
// 18. leaves a watch live after the map closes, so the phone keeps publishing with no map on screen.
// 19. has the sharing in flight twice over, so the caller has nothing to pause while it is still starting.
//
// Ways the Sharing could fail to own putting away and coming back (ticket 14), written before the code:
// 20. Putting the phone away writes a Position on the way out.
// 21. Coming back watches or publishes before the Location gate has answered.
// 22. Coming back with the permission revoked, or services off, still watches or republishes the held reading.
// 23. A return to the foreground shows the OS permission prompt again although it was answered long ago.
// 24. recheck() after granting in Settings does not move the gate to granted, or asks the OS a second time.
// 25. A gate check that throws falls through to sharing instead of reporting denied.
// 26. Put away and brought back before the first watch resolves, it ends with more than one watch or heartbeat.
// 27. stop() leaves a watch or a heartbeat live, or publishes after it.
// 28. A Sharing with no granted gate watches at all, so sharing runs on an unanswered gate.

const GID = 'group-one';
const MEMBER = 'member-uid';
const STRANGER = 'stranger-uid';

const READING = { lat: -33.8688, lng: 151.2093, accuracy: 12 };
const OTHER_READING = { lat: -33.8711, lng: 151.2111, accuracy: 8 };

const positionRef = (db: Firestore, uid: string) => groupPositionRef(db, GID, uid);
const positions = (db: Firestore) => groupPositionsRef(db, GID);

/**
 * Resolves with the stored Position the next time the server's view of it matches. Snapshots with the
 * write still pending are ignored: they have no server `updatedAt` yet, which is the point of asserting.
 */
const nextPosition = (db: Firestore, matches: (data: DocumentData) => boolean): Promise<DocumentData> =>
  waitForSnapshot(positionRef(db, MEMBER), matches, 'settled');

useRulesEnvironment();

beforeEach(async () => {
  await env.clearFirestore();
  osLocation.reset();
  // A Group with this phone already a Member: the rules require membership to write a Position.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = modular(ctx);
    const batch = writeBatch(db);
    addCreateGroup(batch, db, GID, { ownerUid: MEMBER, displayName: 'Sam', groupName: 'The Smiths' });
    await batch.commit();
  });
});

describe('the location gate', () => {
  it('asks the OS once when the permission has never been asked, and shows the map', async () => {
    osLocation.promptGrants();

    expect(await checkLocationGate()).toBe('granted');
    expect(await checkLocationGate()).toBe('granted');
    expect(osLocation.os.prompts).toBe(1);
  });

  it('treats iOS Approximate as granted', async () => {
    osLocation.promptGrants('approximate');

    expect(await checkLocationGate()).toBe('granted');
  });

  it('asks nothing when an earlier session already answered, and blocks a denial', async () => {
    osLocation.deniedInSettings();

    expect(await checkLocationGate()).toBe('denied');
    expect(osLocation.os.prompts).toBe(0);
  });

  it('does not ask twice once the prompt has been denied', async () => {
    osLocation.promptDenies();

    expect(await checkLocationGate()).toBe('denied');
    expect(await checkLocationGate()).toBe('denied');
    expect(osLocation.os.prompts).toBe(1);
  });

  it('reports the services screen, not permission-denied, when services are off', async () => {
    osLocation.promptDenies();
    osLocation.setServices(false);

    expect(await checkLocationGate()).toBe('services-off');
  });

  it('blocks a granted permission while location services are off', async () => {
    osLocation.grantedInSettings();
    osLocation.setServices(false);

    expect(await checkLocationGate()).toBe('services-off');
  });

  it('moves to the map when permission is granted in Settings (Try again), without a second prompt', async () => {
    osLocation.promptDenies();
    expect(await checkLocationGate()).toBe('denied');

    osLocation.grantedInSettings();

    expect(await checkLocationGate()).toBe('granted');
    expect(osLocation.os.prompts).toBe(1);
  });
});

describe('publishLocation', () => {
  it('writes the Position, and only the Position fields, to locations/{uid}', async () => {
    const db = as(MEMBER);
    const published = nextPosition(db, (data) => data.lat === READING.lat);

    publishLocation(db, GID, MEMBER, READING);

    const stored = await published;
    expect(Object.keys(stored).sort()).toEqual(['accuracy', 'lat', 'lng', 'mode', 'updatedAt']);
    expect(stored.accuracy).toBe(READING.accuracy);
    expect(stored.mode).toBe('foreground');
    expect(stored.updatedAt).toBeInstanceOf(Timestamp);

    const all = await getDocs(positions(db));
    expect(all.size).toBe(1);
    expect(all.docs[0].id).toBe(MEMBER);
  });

  it('overwrites that one document, so Positions never pile up into a trail', async () => {
    const db = as(MEMBER);
    const published = nextPosition(db, (data) => data.lat === READING.lat);
    publishLocation(db, GID, MEMBER, READING);
    await published;

    const overwritten = nextPosition(db, (data) => data.lat === OTHER_READING.lat);
    publishLocation(db, GID, MEMBER, OTHER_READING);
    const stored = await overwritten;

    expect(stored.lng).toBe(OTHER_READING.lng);
    const all = await getDocs(positions(db));
    expect(all.size).toBe(1);
    expect(all.docs[0].id).toBe(MEMBER);
  });

  it('takes updatedAt from the server: a Position carrying the phone clock is denied', async () => {
    const db = as(MEMBER);

    await expect(
      setDoc(positionRef(db, MEMBER), { ...READING, updatedAt: Timestamp.now(), mode: 'foreground' }),
    ).rejects.toThrow();

    expect((await getDocs(positions(db))).size).toBe(0);
  });

  it('surfaces nothing when the write is denied; a stranger publishes no Position', async () => {
    const reader = as(MEMBER);

    expect(() => publishLocation(as(STRANGER), GID, MEMBER, READING)).not.toThrow();
    await sleep(250);

    expect((await getDocs(positions(reader))).size).toBe(0);
  });

  it('queues an offline write quietly: nothing reaches the Group until the network is back', async () => {
    const db = as(MEMBER);
    await disableNetwork(db);

    expect(() => publishLocation(db, GID, MEMBER, READING)).not.toThrow();
    await sleep(250);

    await env.withSecurityRulesDisabled(async (ctx) => {
      expect((await getDocs(positions(modular(ctx)))).size).toBe(0);
    });
  });
});

/** The gate settles after at least one await; wait until it is no longer 'checking'. */
async function settledGate(sharing: Sharing): Promise<LocationGate> {
  if (sharing.gate !== 'checking') return sharing.gate;
  return new Promise((resolve) => {
    const stop = sharing.subscribe((gate) => {
      if (gate === 'checking') return;
      stop();
      resolve(gate);
    });
  });
}

/** The OS and Firestore both answer on later ticks; poll until the condition holds. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error('the condition never became true within 2 s');
}

describe('startSharing', () => {
  let sharing: Sharing | undefined;

  afterEach(() => {
    sharing?.stop();
    sharing = undefined;
    osLocation.releaseWatches();
    osLocation.releasePermissionChecks();
    vi.restoreAllMocks();
  });

  const start = (db: Firestore, foreground: Foreground) =>
    startSharing({ db, groupId: GID, uid: MEMBER, foreground });

  it('checks the Location gate at start, then watches once it is granted and publishes the first reading', async () => {
    osLocation.grantedInSettings();
    const db = as(MEMBER);
    sharing = start(db, fakeForeground());

    expect(await settledGate(sharing)).toBe('granted');
    await waitFor(() => osLocation.liveWatches().length === 1);
    expect(osLocation.liveWatches()[0].options).toEqual({ accuracy: 4 });

    const published = nextPosition(db, (data) => data.lat === READING.lat);
    osLocation.emit(READING);

    expect(await published).toMatchObject({ lat: READING.lat, lng: READING.lng, accuracy: READING.accuracy });
  });

  it('writes nothing on the way out, and holds no watch', async () => {
    osLocation.grantedInSettings();
    const db = as(MEMBER);
    const foreground = fakeForeground();
    sharing = start(db, foreground);
    await waitFor(() => osLocation.liveWatches().length === 1);
    const first = nextPosition(db, (data) => data.lat === READING.lat);
    osLocation.emit(READING);
    await first;

    foreground.set(false);

    expect(osLocation.liveWatches()).toHaveLength(0);
    osLocation.emit(OTHER_READING);
    await sleep(150);
    expect((await getDocs(positions(db))).docs.map((each) => each.data().lat)).toEqual([READING.lat]);
  });

  it('publishes the held reading at once when it comes back with the gate granted', async () => {
    osLocation.grantedInSettings();
    const db = as(MEMBER);
    const foreground = fakeForeground();
    sharing = start(db, foreground);
    await waitFor(() => osLocation.liveWatches().length === 1);
    const first = nextPosition(db, (data) => data.lat === READING.lat);
    osLocation.emit(READING);
    const stored = await first;

    foreground.set(false);
    const republished = nextPosition(db, (data) => !data.updatedAt.isEqual(stored.updatedAt));
    foreground.set(true);

    expect((await republished).lat).toBe(READING.lat);
    expect(osLocation.liveWatches()).toHaveLength(1);
  });

  it('reports a permission revoked on coming back, and publishes nothing', async () => {
    osLocation.grantedInSettings();
    const db = as(MEMBER);
    const foreground = fakeForeground();
    sharing = start(db, foreground);
    await waitFor(() => osLocation.liveWatches().length === 1);
    const first = nextPosition(db, (data) => data.lat === READING.lat);
    osLocation.emit(READING);
    const stored = await first;

    foreground.set(false);
    osLocation.deniedInSettings();
    foreground.set(true);

    await waitFor(() => sharing?.gate === 'denied');
    await sleep(200);
    expect(osLocation.liveWatches()).toHaveLength(0);
    const storedAfter = await getDocs(positions(db));
    expect(storedAfter.docs.map((each) => each.data().lat)).toEqual([READING.lat]);
    expect(storedAfter.docs[0].data().updatedAt).toEqual(stored.updatedAt);
  });

  it('reports services off on coming back, and publishes nothing', async () => {
    osLocation.grantedInSettings();
    const db = as(MEMBER);
    const foreground = fakeForeground();
    sharing = start(db, foreground);
    await waitFor(() => osLocation.liveWatches().length === 1);
    const first = nextPosition(db, (data) => data.lat === READING.lat);
    osLocation.emit(READING);
    const stored = await first;

    foreground.set(false);
    osLocation.setServices(false);
    foreground.set(true);

    await waitFor(() => sharing?.gate === 'services-off');
    await sleep(200);
    expect(osLocation.liveWatches()).toHaveLength(0);
    expect((await getDocs(positions(db))).docs[0].data().updatedAt).toEqual(stored.updatedAt);
  });

  it('recheck() after granting in Settings moves to granted without asking twice, and starts watching', async () => {
    osLocation.promptDenies();
    const db = as(MEMBER);
    sharing = start(db, fakeForeground());

    expect(await settledGate(sharing)).toBe('denied');
    expect(osLocation.os.prompts).toBe(1);
    expect(osLocation.liveWatches()).toHaveLength(0);

    osLocation.grantedInSettings();
    await sharing.recheck();

    expect(sharing.gate).toBe('granted');
    expect(osLocation.os.prompts).toBe(1);
    await waitFor(() => osLocation.liveWatches().length === 1);
  });

  it('reports denied when the gate check throws, and holds no watch', async () => {
    osLocation.breakPermissionCheck();
    sharing = start(as(MEMBER), fakeForeground());

    expect(await settledGate(sharing)).toBe('denied');
    expect(osLocation.liveWatches()).toHaveLength(0);
  });

  it('holds at most one watch and one heartbeat however often it is put away and brought back', async () => {
    osLocation.grantedInSettings();
    osLocation.holdWatches();
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const foreground = fakeForeground();
    sharing = start(as(MEMBER), foreground);
    await waitFor(() => osLocation.liveWatches().length === 1); // The first watch is on its way.

    for (let i = 0; i < 3; i += 1) {
      foreground.set(false);
      foreground.set(true);
    }
    await waitFor(() => osLocation.liveWatches().length > 1); // Superseding watches are on their way too.

    osLocation.releaseWatches(); // The OS hands every subscription back at once.
    await waitFor(() => osLocation.liveWatches().length === 1);
    await sleep(50);

    expect(osLocation.liveWatches()).toHaveLength(1);
    expect(intervals.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(1);
  });

  it('holds no watch and writes nothing when put away before the first gate check answers', async () => {
    osLocation.grantedInSettings();
    osLocation.holdPermissionChecks();
    const db = as(MEMBER);
    const foreground = fakeForeground();
    sharing = start(db, foreground);

    foreground.set(false); // Put away while the gate is still being checked.
    osLocation.releasePermissionChecks();
    await sleep(150);

    expect(osLocation.liveWatches()).toHaveLength(0);
    expect((await getDocs(positions(db))).size).toBe(0);
  });

  it('watches once when put away and brought back before the first gate check answers', async () => {
    osLocation.grantedInSettings();
    osLocation.holdPermissionChecks();
    const foreground = fakeForeground();
    sharing = start(as(MEMBER), foreground);

    foreground.set(false);
    foreground.set(true); // The first check is now superseded by the return's.
    osLocation.releasePermissionChecks(); // Both answers arrive at once.
    await waitFor(() => osLocation.liveWatches().length === 1);
    await sleep(50);

    expect(osLocation.liveWatches()).toHaveLength(1);
  });

  it('stops watching on stop(), and writes nothing after it', async () => {
    osLocation.grantedInSettings();
    const db = as(MEMBER);
    const foreground = fakeForeground();
    sharing = start(db, foreground);
    await waitFor(() => osLocation.liveWatches().length === 1);
    const first = nextPosition(db, (data) => data.lat === READING.lat);
    osLocation.emit(READING);
    const stored = await first;

    sharing.stop();

    expect(osLocation.liveWatches()).toHaveLength(0);
    // Even a return to the foreground and a fresh reading after stop() change nothing.
    foreground.set(false);
    foreground.set(true);
    osLocation.emit(OTHER_READING);
    await sleep(200);
    const storedAfter = await getDocs(positions(db));
    expect(storedAfter.docs.map((each) => each.data().lat)).toEqual([READING.lat]);
    expect(storedAfter.docs[0].data().updatedAt).toEqual(stored.updatedAt);
  });

  it('leaves nothing live when stop() lands while the first watch is still on its way', async () => {
    osLocation.grantedInSettings();
    osLocation.holdWatches();
    const db = as(MEMBER);
    const foreground = fakeForeground();
    sharing = start(db, foreground);
    await waitFor(() => osLocation.liveWatches().length === 1);

    foreground.set(false);
    foreground.set(true);
    sharing.stop();
    osLocation.releaseWatches();
    await sleep(150);

    osLocation.emit(READING);
    await sleep(150);
    expect(osLocation.liveWatches()).toHaveLength(0);
    expect((await getDocs(positions(db))).size).toBe(0);
  });
});
