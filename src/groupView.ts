import {
  onSnapshot,
  type DocumentData,
  type Firestore,
  type Timestamp,
} from 'firebase/firestore';

import { membersRef, positionsRef } from './groupDocs';

/** A stored Position, as `publishLocation` writes it: this module is its only reader. */
type Position = {
  lat: number;
  lng: number;
  accuracy: number;
  updatedAt: number;
  mode: 'foreground';
};

/** A Member is Stale after three minutes without an update; their pin turns grey (§6). */
const STALE_AFTER_MS = 3 * 60_000;

/** The map's age ticker: ages re-render on this beat, with no new data needed (§6). */
const AGE_TICK_MS = 15_000;

/**
 * One Member's latest Position as the map draws it: a name, a spot, how old the Position is, and whether
 * that age has passed the Stale line (CONTEXT.md, spec §7.4). `mine` is this phone's own Member.
 */
export type Pin = {
  uid: string;
  displayName: string | null;
  lat: number;
  lng: number;
  age: string;
  stale: boolean;
  mine: boolean;
};

/**
 * One row of the ⋯ → Members list (spec §7.4): a Member, whether it is this phone, the spot a tap centres
 * on (null for a Member who has never published), and the row's whole label, ready to render.
 */
export type MemberRow = {
  uid: string;
  displayName: string | null;
  mine: boolean;
  position: { lat: number; lng: number } | null;
  label: string;
};

/**
 * The whole Group as the map draws it (spec §7.4): a Pin per Member with a Position, one row per Member,
 * and whether this phone is sharing while nobody else is — the "No one is sharing yet" line. `loaded` is
 * false until the Group's first Member and Position reads have both landed, so the map can hold the line
 * back and the camera can wait rather than frame a half-read Group.
 */
export type GroupView = {
  loaded: boolean;
  pins: Pin[];
  members: MemberRow[];
  nobodyElseSharing: boolean;
};

/**
 * Watches the whole Group — every Member document and every Position — and hands `onView` the map's view
 * whenever either changes, and again on every 15-second age tick, with no new data needed. Returns the
 * unsubscribe.
 *
 * `clock` is the only thing the module cannot read for itself: ages compare the phone's clock against the
 * server's receipt time (§6), so it is injected rather than assumed.
 */
export function subscribeToGroupView(
  db: Firestore,
  groupId: string,
  uid: string,
  onView: (view: GroupView) => void,
  clock: () => number = Date.now,
): () => void {
  let members: Map<string, string | null> | undefined;
  let positions: Map<string, Position> | undefined;
  // A snapshot already in flight when the map closes must not reach it: unsubscribing ends the view.
  let stopped = false;

  const emit = () => {
    if (stopped || !members || !positions) return;
    const now = clock();
    const pins: Pin[] = [];
    const rows: MemberRow[] = [];
    // The view is a Member list, so iterate the Members: a Position whose Member is gone is dropped
    // rather than inventing one, and a Member with no Position still gets a row.
    for (const [memberUid, displayName] of members) {
      const mine = memberUid === uid;
      const position = positions.get(memberUid);
      if (position) {
        pins.push({
          uid: memberUid,
          displayName,
          lat: position.lat,
          lng: position.lng,
          age: ageLabel(position.updatedAt, now),
          stale: isStale(position.updatedAt, now),
          mine,
        });
      }
      rows.push({
        uid: memberUid,
        displayName,
        mine,
        position: position ? { lat: position.lat, lng: position.lng } : null,
        label: memberLabel(displayName, mine, position ? ageLabel(position.updatedAt, now) : null),
      });
    }
    // Own row first, then by name: a stable order that does not reshuffle on every read.
    rows.sort(
      (a, b) => Number(b.mine) - Number(a.mine) || (a.displayName ?? '').localeCompare(b.displayName ?? ''),
    );
    onView({
      loaded: true,
      pins,
      members: rows,
      // The line shows once this phone is sharing and nobody else is: a Group with no Positions yet is
      // waiting for this phone's first fix (spec §7.4), not "nobody else sharing".
      nobodyElseSharing: pins.length > 0 && pins.every((pin) => pin.mine),
    });
  };

  const stopMembers = onSnapshot(
    membersRef(db, groupId),
    (snapshot) => {
      members = new Map(snapshot.docs.map((each) => [each.id, each.data().displayName ?? null]));
      emit();
    },
    // Silence is normal in v1: a failed read is not something the phone can act on (§6).
    (error) => console.warn('[groupView] could not read the Members', error),
  );

  const stopPositions = onSnapshot(
    positionsRef(db, groupId),
    (snapshot) => {
      positions = new Map(snapshot.docs.map((each) => [each.id, positionFrom(each.data(), clock())]));
      emit();
    },
    (error) => console.warn('[groupView] could not read the Positions', error),
  );

  const ticker = setInterval(emit, AGE_TICK_MS);

  return () => {
    stopped = true;
    stopMembers();
    stopPositions();
    clearInterval(ticker);
  };
}

/**
 * A member-list row's whole label (spec §7.4): "You · sharing on" for this phone, "{name} · updated {age}
 * ago" for a Member with a Position, and "{name} · No position yet" for one who has never published.
 * `age` is null exactly when the Member has no Position.
 */
function memberLabel(displayName: string | null, mine: boolean, age: string | null): string {
  if (mine) return 'You · sharing on';
  const name = displayName ?? '';
  if (age === null) return name ? `${name} · No position yet` : 'No position yet';
  return name ? `${name} · updated ${age} ago` : `updated ${age} ago`;
}

/**
 * The stored Position. A write the server has not acknowledged reads back with a null `updatedAt`; the
 * phone's clock stands in, which §6 accepts, so the pin keeps its place instead of blinking out on every
 * heartbeat.
 */
function positionFrom(data: DocumentData, now: number): Position {
  const updatedAt = data.updatedAt as Timestamp | null | undefined;
  return {
    lat: data.lat,
    lng: data.lng,
    accuracy: data.accuracy,
    updatedAt: updatedAt ? updatedAt.toMillis() : now,
    mode: data.mode,
  };
}

/** `{age}` on the pin: "now" under 60 s, "N min" under 60 min, "N h" under 24 h, "N d" beyond (§6). */
function ageLabel(updatedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - updatedAt) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

/** More than three minutes without an update, and only then: the pin turns grey and stays on the map. */
function isStale(updatedAt: number, now: number): boolean {
  return now - updatedAt > STALE_AFTER_MS;
}
