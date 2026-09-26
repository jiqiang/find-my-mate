import { describe, expect, it } from 'vitest';

import { centreOnFirstPin, type Region } from '../src/camera';
import type { Pin } from '../src/pins';

// Ways the map's first centring could fail, written before src/camera.ts:
//  1. This phone's Pin arrives before the map is ready and the camera move is made anyway, which iOS drops,
//     so the map stays on the placeholder for good (the bug fixed in ea85c19).
//  2. The map is ready before this phone has a Pin, and the Pin's arrival never moves the camera.
//  3. It centres again on a later Pin list (a heartbeat, the 15-second age tick), fighting the user's pan.
//  4. A second onMapReady centres again.
//  5. It centres on another Member's Pin while this phone has none.
//  6. It centres with no Pin of this phone's at all, e.g. on the placeholder or on undefined coordinates.
//  7. It centres at the wrong spot or zoom: not this phone's latest lat/lng, or not the neighbourhood zoom.

const NEIGHBOURHOOD = { latitudeDelta: 0.01, longitudeDelta: 0.01 };

function pin(overrides: Partial<Pin>): Pin {
  return {
    uid: 'someone',
    displayName: 'Someone',
    lat: 0,
    lng: 0,
    age: 'now',
    stale: false,
    mine: false,
    ...overrides,
  };
}

const MINE = pin({ uid: 'me', displayName: 'Me', lat: -37.9159, lng: 145.2556, mine: true });
const THEIRS = pin({ uid: 'them', displayName: 'Them', lat: -33.9, lng: 151.2 });

function recorder() {
  const moves: Region[] = [];
  return { moves, moveTo: (region: Region) => moves.push(region) };
}

describe('centreOnFirstPin', () => {
  it('holds a Pin that arrives before the map is ready, and centres on it once the map is ready', () => {
    const { moves, moveTo } = recorder();
    const camera = centreOnFirstPin(moveTo);

    camera.pins([MINE]);
    expect(moves).toEqual([]);

    camera.mapReady();
    expect(moves).toEqual([{ latitude: MINE.lat, longitude: MINE.lng, ...NEIGHBOURHOOD }]);
  });

  it('centres when this phone first has a Pin, if the map was already ready', () => {
    const { moves, moveTo } = recorder();
    const camera = centreOnFirstPin(moveTo);

    camera.mapReady();
    camera.pins([]);
    expect(moves).toEqual([]);

    camera.pins([THEIRS, MINE]);
    expect(moves).toEqual([{ latitude: MINE.lat, longitude: MINE.lng, ...NEIGHBOURHOOD }]);
  });

  it('centres only once, however many Pin lists and map-ready calls follow', () => {
    const { moves, moveTo } = recorder();
    const camera = centreOnFirstPin(moveTo);

    camera.mapReady();
    camera.pins([MINE]);
    camera.pins([{ ...MINE, lat: -37.8, lng: 145.1 }]);
    camera.pins([MINE, THEIRS]);
    camera.mapReady();

    expect(moves).toHaveLength(1);
  });

  it('never centres on another Member while this phone has no Pin', () => {
    const { moves, moveTo } = recorder();
    const camera = centreOnFirstPin(moveTo);

    camera.pins([THEIRS]);
    camera.mapReady();
    camera.pins([THEIRS]);

    expect(moves).toEqual([]);
  });

  it('centres on the latest Pin held when the map becomes ready, not the first one seen', () => {
    const { moves, moveTo } = recorder();
    const camera = centreOnFirstPin(moveTo);

    camera.pins([MINE]);
    camera.pins([{ ...MINE, lat: -37.8, lng: 145.1 }]);
    camera.mapReady();

    expect(moves).toEqual([{ latitude: -37.8, longitude: 145.1, ...NEIGHBOURHOOD }]);
  });
});
