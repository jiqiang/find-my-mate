import { readFileSync } from 'node:fs';
import {
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  disableNetwork,
  doc,
  getDocs,
  onSnapshot,
  serverTimestamp,
  setDoc,
  setLogLevel,
  Timestamp,
  writeBatch,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as osLocation from './fakes/expo-location';
import { checkLocationGate, publishLocation, startSharing, type Sharing } from '../src/location';

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
// moved them behind src/pins.ts, and their failing ways are listed at the top of test/pins.test.ts.

const GID = 'group-one';
const MEMBER = 'member-uid';
const STRANGER = 'stranger-uid';

const READING = { lat: -33.8688, lng: 151.2093, accuracy: 12 };
const OTHER_READING = { lat: -33.8711, lng: 151.2111, accuracy: 8 };

let env: RulesTestEnvironment;

const modular = (ctx: RulesTestContext) => ctx.firestore() as unknown as Firestore;
const as = (uid: string) => modular(env.authenticatedContext(uid));
const positionRef = (db: Firestore, uid: string) => doc(db, 'groups', GID, 'locations', uid);
const positions = (db: Firestore) => collection(db, 'groups', GID, 'locations');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Resolves with the stored Position the next time the server's view of it matches. Snapshots with the
 * write still pending are ignored: they have no server `updatedAt` yet, which is the point of asserting.
 */
function nextPosition(db: Firestore, matches: (data: DocumentData) => boolean): Promise<DocumentData> {
  return new Promise((resolve, reject) => {
    let stop: (() => void) | undefined;
    const timer = setTimeout(() => {
      stop?.();
      reject(new Error('the Position never matched within 5 s'));
    }, 5000);
    stop = onSnapshot(positionRef(db, MEMBER), (snapshot) => {
      const data = snapshot.data();
      if (data && !snapshot.metadata.hasPendingWrites && matches(data)) {
        clearTimeout(timer);
        stop?.();
        resolve(data);
      }
    });
  });
}

beforeAll(async () => {
  setLogLevel('error');
  env = await initializeTestEnvironment({
    projectId: 'demo-find-my-mate',
    firestore: { rules: readFileSync('firestore.rules', 'utf8') },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  osLocation.reset();
  // A Group with this phone already a Member: the rules require membership to write a Position.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = modular(ctx);
    const batch = writeBatch(db);
    batch.set(doc(db, 'groups', GID), {
      name: 'The Smiths',
      ownerUid: MEMBER,
      maxMembers: 4,
      createdAt: serverTimestamp(),
      activeInviteCode: null,
    });
    batch.set(doc(db, 'groups', GID, 'members', MEMBER), {
      displayName: 'Sam',
      role: 'owner',
      joinedAt: serverTimestamp(),
    });
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

describe('startSharing', () => {
  let sharing: Sharing | undefined;

  afterEach(() => {
    sharing?.pause();
    sharing = undefined;
    vi.restoreAllMocks();
  });

  it('watches once at Accuracy.High, and publishes the first reading the OS reports at once', async () => {
    const db = as(MEMBER);
    sharing = await startSharing({ db, groupId: GID, uid: MEMBER });

    expect(osLocation.liveWatches()).toHaveLength(1);
    expect(osLocation.liveWatches()[0].options).toEqual({ accuracy: 4 });

    const published = nextPosition(db, (data) => data.lat === READING.lat);
    osLocation.emit(READING);

    expect(await published).toMatchObject({ lat: READING.lat, lng: READING.lng, accuracy: READING.accuracy });
  });

  it('heartbeats on a 30-second JS timer, publishing the reading it holds', async () => {
    const db = as(MEMBER);
    const intervals = vi.spyOn(globalThis, 'setInterval');
    sharing = await startSharing({ db, groupId: GID, uid: MEMBER });

    const first = nextPosition(db, (data) => data.lat === READING.lat);
    osLocation.emit(READING);
    await first;

    const beat = intervals.mock.calls.find(([, delay]) => delay === 30_000);
    expect(beat, 'no 30-second JS timer was scheduled').toBeDefined();

    osLocation.emit(OTHER_READING);
    await sleep(150);
    expect((await getDocs(positions(db))).docs[0].data().lat).toBe(READING.lat);

    const beatPublished = nextPosition(db, (data) => data.lat === OTHER_READING.lat);
    (beat![0] as () => void)();
    expect(await beatPublished).toMatchObject({ lat: OTHER_READING.lat, lng: OTHER_READING.lng });
  });

  it('writes nothing while backgrounded, and publishes the held reading at once on resume', async () => {
    const db = as(MEMBER);
    sharing = await startSharing({ db, groupId: GID, uid: MEMBER });
    const first = nextPosition(db, (data) => data.lat === READING.lat);
    osLocation.emit(READING);
    const stored = await first;

    sharing.pause();
    expect(osLocation.liveWatches()).toHaveLength(0);
    osLocation.emit(OTHER_READING);
    await sleep(150);
    expect((await getDocs(positions(db))).docs.map((each) => each.data().lat)).toEqual([READING.lat]);

    const backInTheForeground = nextPosition(db, (data) => !data.updatedAt.isEqual(stored.updatedAt));
    await sharing.resume();

    expect((await backInTheForeground).lat).toBe(READING.lat);
    expect(osLocation.liveWatches()).toHaveLength(1);
  });

  it('holds one watch at a time, however often it resumes', async () => {
    const db = as(MEMBER);
    sharing = await startSharing({ db, groupId: GID, uid: MEMBER });

    await sharing.resume();
    await sharing.resume();

    expect(osLocation.liveWatches()).toHaveLength(1);
  });

  it('leaves no watch behind when the map closes while a watch is still being created', async () => {
    const db = as(MEMBER);
    sharing = await startSharing({ db, groupId: GID, uid: MEMBER });

    const resuming = sharing.resume();
    sharing.pause();
    await resuming;
    osLocation.emit(READING);
    await sleep(150);

    expect(osLocation.liveWatches()).toHaveLength(0);
    expect((await getDocs(positions(db))).size).toBe(0);
  });
});

