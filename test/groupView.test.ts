import { readFileSync } from 'node:fs';
import {
  deleteDoc,
  disableNetwork,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  writeBatch,
  type DocumentData,
  type Firestore,
} from 'firebase/firestore';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { as, env, modular, sleep, useRulesEnvironment, waitForSnapshot } from './fakes/rules';
import { addCreateGroup, memberRef, positionRef } from '../src/groupDocs';
import { subscribeToGroupView, type GroupView } from '../src/groupView';
import { publishLocation } from '../src/location';

// Ways the Group view (ticket 13, widened by ticket 10) could fail, written before src/groupView.ts:
//  1. Only this phone's own Position is watched, so nobody else ever reaches the map.
//  2. A Member with no Position gets a Pin anyway, at a spot that was never theirs.
//  3. A Position whose Member document is missing gets a Pin, naming a Member who is gone.
//  4. The name comes from anywhere but the live Member document, so a rename needs a relaunch.
//  5. No Pin says it is this phone's own, or more than one does.
//  6. The age is worked out once and then frozen, so every pin reads "now" while it is open.
//  7. The 15-second age ticker is missing, so an age never moves without new data from the server.
//  8. Age wording is wrong at the boundaries (59/60 s, 59/60 min, 23/24 h).
//  9. A Pin turns Stale before three minutes, or never turns grey at all.
// 10. A write whose server timestamp has not landed yet produces no Pin, so the pin blinks out.
// 11. A read error is thrown at the map instead of being logged and swallowed.
// 12. Unsubscribing leaves the listeners or the ticker running, so Pins keep arriving.
// 13. A Pin arrives without the coordinates, the age or the grey-out the map draws with.
// 14. The map screen keeps building Firestore paths and keeps its own age and Stale logic.
// 15. The internals the map no longer needs (positionFrom, ageLabel, isStale) stay exported.
//
// Ways the member list and the "No one is sharing yet" line (ticket 10) could fail:
// 16. A Member who has never published is missing from the member list.
// 17. A Member whose Position is gone is dropped from the member list instead of reading "No position yet".
// 18. This phone's own row reads anything but "You · sharing on".
// 19. A Member with a Position reads "No position yet", or one without reads an age.
// 20. A row carries no spot, so tapping it cannot centre on that Member.
// 21. The row order is unstable, so the list reshuffles on every read.
// 22. A Stale Member's row age freezes, or the Member drops out of the list.
// 23. The line shows while another Member has a Position.
// 24. The line never shows although this phone is the only Member with a Position.
// 25. The line shows before this phone has a Position of its own.

const GID = 'group-one';
/** This phone: the Owner, so the rules let it rename the Group's other Members. */
const MEMBER = 'member-uid';
const PRIYA = 'priya-uid';
const ALEX = 'alex-uid';
/** A Member who has never published: a Member with no Position, so no Pin. */
const JORDAN = 'jordan-uid';
/** A Position left behind by a Member whose document is already gone. */
const GHOST = 'ghost-uid';
const STRANGER = 'stranger-uid';

/** The moment the seeded Positions were stamped, and the clock the age tests start from (spec §6). */
const BASE = Date.UTC(2026, 8, 25, 6, 0, 0);
/** The age ticker's beat (spec §6), and the three minutes after which a pin turns grey. */
const AGE_TICK_MS = 15_000;
const STALE_AFTER_MS = 3 * 60_000;

const SEEDED_POSITIONS: Record<string, { lat: number; lng: number; accuracy: number }> = {
  [MEMBER]: { lat: -33.8688, lng: 151.2093, accuracy: 12 },
  [PRIYA]: { lat: -33.8711, lng: 151.2111, accuracy: 8 },
  [ALEX]: { lat: -33.8765, lng: 151.2001, accuracy: 20 },
};

/** A Group of one: this phone, sharing. The line's "nobody else" case. */
const SOLO = 'group-solo';

/**
 * A map-shaped subscriber: it keeps every Group view the module hands out, in the order they arrived,
 * so a test can wait for the one that proves what it is asking about.
 */
class GroupViewWatch {
  readonly views: GroupView[] = [];
  private readonly stop: () => void;

  constructor(db: Firestore, uid: string = MEMBER, clock: () => number = Date.now, groupId: string = GID) {
    this.stop = subscribeToGroupView(db, groupId, uid, (view) => this.views.push(view), clock);
  }

  /** The latest view the module handed out: the one the map is drawing right now. */
  get view(): GroupView {
    return (
      this.views[this.views.length - 1] ?? {
        loaded: false,
        pins: [],
        members: [],
        nobodyElseSharing: false,
      }
    );
  }

  /** Resolves with the latest view once it matches, waiting for a later one otherwise. */
  async until(matches: (view: GroupView) => boolean): Promise<GroupView> {
    await vi.waitFor(
      () => {
        if (!matches(this.view)) throw new Error(`waiting for the Group view, latest: ${JSON.stringify(this.view)}`);
      },
      { timeout: 4000, interval: 25 },
    );
    return this.view;
  }

  unsubscribe(): void {
    this.stop();
  }
}

/**
 * Resolves with the Position as this phone's own cache holds it while the write is still pending, which is
 * the only state in which the server's `updatedAt` has not landed. Rejects if the write settles first.
 */
const pendingPosition = (db: Firestore, uid: string): Promise<DocumentData> =>
  waitForSnapshot(positionRef(db, GID, uid), () => true, 'pending');

/**
 * Captures the module's own 15-second beat so a test can fire it without waiting, which is how the age
 * and Stale assertions move time with no new Firestore data. The real timer keeps running and never
 * fires inside a test; `vi.restoreAllMocks` puts the spy back.
 */
function capturedBeat(): () => void {
  const intervals = vi.spyOn(globalThis, 'setInterval');
  return () => {
    const beats = intervals.mock.calls.filter(([, delay]) => delay === AGE_TICK_MS);
    expect(beats.length, 'no 15-second JS timer was scheduled').toBeGreaterThan(0);
    (beats[beats.length - 1][0] as () => void)();
  };
}

/** Seeds a Group of one: this phone, with a Position stamped at `BASE` unless `withPosition` is false. */
async function seedSolo({ withPosition = true }: { withPosition?: boolean } = {}): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = modular(ctx);
    const batch = writeBatch(db);
    addCreateGroup(batch, db, SOLO, { ownerUid: MEMBER, displayName: 'Sam', groupName: 'Just Sam' });
    if (withPosition) {
      batch.set(positionRef(db, SOLO, MEMBER), {
        ...SEEDED_POSITIONS[MEMBER],
        updatedAt: Timestamp.fromMillis(BASE),
        mode: 'foreground',
      });
    }
    await batch.commit();
  });
}

let watch: GroupViewWatch | undefined;

useRulesEnvironment();

beforeEach(async () => {
  await env.clearFirestore();
  // Four Members, three of them with a Position stamped at a known moment: the Group the map watches.
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = modular(ctx);
    const batch = writeBatch(db);
    addCreateGroup(batch, db, GID, { ownerUid: MEMBER, displayName: 'Sam', groupName: 'The Smiths' });
    const otherMembers: [string, string][] = [
      [PRIYA, 'Priya'],
      [ALEX, 'Alex'],
      [JORDAN, 'Jordan'],
    ];
    for (const [uid, displayName] of otherMembers) {
      batch.set(memberRef(db, GID, uid), { displayName, role: 'member', joinedAt: serverTimestamp() });
    }
    for (const [uid, reading] of Object.entries(SEEDED_POSITIONS)) {
      batch.set(positionRef(db, GID, uid), {
        ...reading,
        updatedAt: Timestamp.fromMillis(BASE),
        mode: 'foreground',
      });
    }
    await batch.commit();
  });
});

afterEach(() => {
  watch?.unsubscribe();
  watch = undefined;
  vi.restoreAllMocks();
});

describe('the Pins a Group hands out', () => {
  it('draws every Member with a Position, named by their Member document, and nobody else', async () => {
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => BASE);

    const view = await watch.until((each) => each.pins.length === 3);

    expect(view.pins.map((pin) => pin.displayName).sort()).toEqual(['Alex', 'Priya', 'Sam']);
    expect(view.pins.find((pin) => pin.uid === PRIYA)).toEqual({
      uid: PRIYA,
      displayName: 'Priya',
      lat: SEEDED_POSITIONS[PRIYA].lat,
      lng: SEEDED_POSITIONS[PRIYA].lng,
      age: 'now',
      stale: false,
      mine: false,
    });
  });

  it('marks this phone’s own Pin, and only that one', async () => {
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => BASE);
    const view = await watch.until((each) => each.pins.length === 3);

    expect(view.pins.filter((pin) => pin.mine).map((pin) => pin.uid)).toEqual([MEMBER]);
  });

  it('takes a rename off the Member document at once, with no relaunch', async () => {
    const db = as(MEMBER);
    watch = new GroupViewWatch(db, MEMBER, () => BASE);
    await watch.until((each) => each.pins.length === 3);

    await updateDoc(memberRef(db, GID, PRIYA), { displayName: 'Priya P' });

    const view = await watch.until((each) =>
      each.pins.some((pin) => pin.uid === PRIYA && pin.displayName === 'Priya P'),
    );
    expect(view.pins.find((pin) => pin.uid === PRIYA)?.displayName).toBe('Priya P');
  });

  it.each([
    [59_000, 'now'],
    [60_000, '1 min'],
    [59 * 60_000, '59 min'],
    [60 * 60_000, '1 h'],
    [23 * 60 * 60_000, '23 h'],
    [24 * 60 * 60_000, '1 d'],
  ])('reads %i ms of age as "%s" on the next 15-second tick, with no new Firestore data', async (ageMs, expected) => {
    let now = BASE;
    const beat = capturedBeat();
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => now);
    await watch.until((each) => each.pins.length === 3);

    now = BASE + ageMs;
    beat();

    const view = await watch.until((each) => each.pins.find((pin) => pin.uid === PRIYA)?.age === expected);
    expect(view.pins.find((pin) => pin.uid === PRIYA)).toMatchObject({ age: expected });
  });

  it('keeps a Pin fresh at exactly three minutes old, and greys it just after, while its age ticks on', async () => {
    let now = BASE;
    const beat = capturedBeat();
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => now);
    await watch.until((each) => each.pins.length === 3);

    now = BASE + STALE_AFTER_MS;
    beat();
    const fresh = await watch.until((each) => each.pins.find((pin) => pin.uid === PRIYA)?.age === '3 min');
    expect(fresh.pins.find((pin) => pin.uid === PRIYA)).toMatchObject({ stale: false, age: '3 min' });

    now = BASE + STALE_AFTER_MS + 1;
    beat();
    const grey = await watch.until((each) => each.pins.some((pin) => pin.uid === PRIYA && pin.stale));
    expect(grey.pins.find((pin) => pin.uid === PRIYA)).toMatchObject({ stale: true, age: '3 min' });
  });

  it('draws a Pin for a write whose server timestamp has not landed yet, instead of blinking out', async () => {
    const db = as(MEMBER);
    watch = new GroupViewWatch(db, MEMBER, () => BASE);
    await watch.until((each) => each.pins.length === 3);

    // Offline the write stays pending, so the Position reads back with no server `updatedAt` at all.
    await disableNetwork(db);
    const pending = pendingPosition(db, ALEX);
    publishLocation(db, GID, ALEX, { lat: -33.9, lng: 151.3, accuracy: 5 });
    expect((await pending).updatedAt, 'the write landed instead of staying pending').toBeNull();

    const view = await watch.until((each) => each.pins.find((pin) => pin.uid === ALEX)?.lat === -33.9);
    expect(view.pins.find((pin) => pin.uid === ALEX)).toMatchObject({ age: 'now', stale: false });
  });

  it('hands out no more Pins once the map unsubscribes, and leaves no age ticker behind', async () => {
    const db = as(MEMBER);
    const intervals = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    watch = new GroupViewWatch(db, MEMBER, () => BASE);
    await watch.until((each) => each.pins.length === 3);
    const beatAt = intervals.mock.calls.findIndex(([, delay]) => delay === AGE_TICK_MS);
    expect(beatAt, 'no 15-second JS timer was scheduled').toBeGreaterThan(-1);
    const beat = () => (intervals.mock.calls[beatAt][0] as () => void)();

    watch.unsubscribe();
    const handed = watch.views.length;

    // Everything that would hand the map another view: a rename, another Position, and a callback that
    // was already in flight when the map closed — the beat, called by hand now that its timer is gone.
    await updateDoc(memberRef(db, GID, PRIYA), { displayName: 'Priya P' });
    publishLocation(db, GID, MEMBER, { lat: -33.9, lng: 151.3, accuracy: 5 });
    beat();
    await sleep(500);

    expect(watch.views.length).toBe(handed);
    expect(cleared).toHaveBeenCalledWith(intervals.mock.results[beatAt].value);
  });

  it('logs a read the rules deny, and hands the map nothing instead of throwing at it', async () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // A phone with no Member document in this Group: the rules deny both reads (§4). Subscribing throws
    // nothing — the denial only ever arrives on the module's error callbacks, which log and swallow it.
    watch = new GroupViewWatch(as(STRANGER), STRANGER, () => BASE);

    await vi.waitFor(() => expect(warned).toHaveBeenCalled(), { timeout: 4000 });
    expect(warned.mock.calls.some(([first, error]) => String(first).startsWith('[groupView]') && error)).toBe(true);
    expect(watch.view.pins).toEqual([]);
  });

  it('drops a Position whose Member document is missing, rather than inventing a Member', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(positionRef(modular(ctx), GID, GHOST), {
        lat: 51.5,
        lng: -0.12,
        accuracy: 5,
        updatedAt: Timestamp.fromMillis(BASE),
        mode: 'foreground',
      });
    });
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => BASE);

    const view = await watch.until((each) => each.pins.length === 3);

    expect(view.pins.map((pin) => pin.uid)).not.toContain(GHOST);
  });
});

describe('the member list a Group hands out', () => {
  it('has one row per Member, including one who has never published', async () => {
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => BASE);

    const view = await watch.until((each) => each.members.length === 4);

    expect(view.members.map((member) => member.uid).sort()).toEqual([ALEX, JORDAN, MEMBER, PRIYA].sort());
    expect(view.members.find((member) => member.uid === JORDAN)?.label).toBe('Jordan · No position yet');
  });

  it('puts this phone’s own row first, then the rest by name', async () => {
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => BASE);

    const view = await watch.until((each) => each.members.length === 4);

    expect(view.members.map((member) => member.label)).toEqual([
      'You · sharing on',
      'Alex · updated now ago',
      'Jordan · No position yet',
      'Priya · updated now ago',
    ]);
  });

  it('carries the spot to centre on for a Member with a Position, and none for one without', async () => {
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => BASE);

    const view = await watch.until((each) => each.members.length === 4);

    expect(view.members.find((member) => member.uid === PRIYA)?.position).toEqual({
      lat: SEEDED_POSITIONS[PRIYA].lat,
      lng: SEEDED_POSITIONS[PRIYA].lng,
    });
    expect(view.members.find((member) => member.uid === JORDAN)?.position).toBeNull();
  });

  it('keeps a Stale Member in the list and keeps their age ticking', async () => {
    let now = BASE;
    const beat = capturedBeat();
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => now);
    await watch.until((each) => each.members.length === 4);

    now = BASE + STALE_AFTER_MS + 1;
    beat();

    const view = await watch.until(
      (each) => each.members.find((member) => member.uid === PRIYA)?.label === 'Priya · updated 3 min ago',
    );
    expect(view.members.map((member) => member.uid)).toContain(PRIYA);
  });

  it('reads a Member whose Position is gone as "No position yet", rather than dropping the row', async () => {
    const db = as(MEMBER);
    watch = new GroupViewWatch(db, MEMBER, () => BASE);
    await watch.until((each) => each.members.length === 4);

    await deleteDoc(positionRef(db, GID, ALEX));

    const view = await watch.until(
      (each) => each.members.find((member) => member.uid === ALEX)?.label === 'Alex · No position yet',
    );
    expect(view.members.find((member) => member.uid === ALEX)?.position).toBeNull();
  });
});

describe('"No one is sharing yet"', () => {
  it('holds while this phone is the only Member with a Position', async () => {
    await seedSolo();
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => BASE, SOLO);

    const view = await watch.until((each) => each.loaded);

    expect(view.nobodyElseSharing).toBe(true);
  });

  it('lifts once another Member has a Position', async () => {
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => BASE);

    const view = await watch.until((each) => each.pins.length === 3);

    expect(view.nobodyElseSharing).toBe(false);
  });

  it('holds off before this phone has a Position of its own', async () => {
    await seedSolo({ withPosition: false });
    watch = new GroupViewWatch(as(MEMBER), MEMBER, () => BASE, SOLO);

    const view = await watch.until((each) => each.loaded);

    expect(view.pins).toEqual([]);
    expect(view.nobodyElseSharing).toBe(false);
  });
});

describe('the module’s surface', () => {
  it('hands out the one subscribe function, and keeps the reading internals to itself', async () => {
    expect(Object.keys(await import('../src/groupView'))).toEqual(['subscribeToGroupView']);

    const sharing = await import('../src/location');
    for (const gone of ['positionFrom', 'ageLabel', 'isStale', 'STALE_AFTER_MS', 'AGE_TICK_MS']) {
      expect(Object.keys(sharing), `${gone} is still exported`).not.toContain(gone);
    }
  });
});

describe('the map screen', () => {
  /**
   * Read as source rather than rendered: this suite runs in Node, with no native map to mount, so what it
   * can hold the screen to is that drawing the view is all it does — the module owns the paths and the ages.
   */
  const source = () => readFileSync('src/screens/Map.tsx', 'utf8');

  it('builds no Firestore paths and keeps no age or Stale logic of its own', () => {
    expect(source()).not.toMatch(/\b(doc|collection|onSnapshot)\s*\(/);
    expect(source()).not.toMatch(/ageLabel|isStale|STALE_AFTER_MS|AGE_TICK_MS|useNow/);
  });

  it('draws every Pin and every member row the module hands it, through the thin hook', () => {
    expect(source()).toMatch(/useGroupView\(/);
    expect(source()).toMatch(/view\.pins\.map\(/);
    expect(source()).toMatch(/view\.members/);
  });

  it('carries the recentre control, the Members menu item and the line the spec names', () => {
    expect(source()).toMatch(/⦿/);
    expect(source()).toMatch(/Members/);
    expect(source()).toMatch(/No one is sharing yet\. Ask them to open the app\./);
  });
});
