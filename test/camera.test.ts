import { describe, expect, it } from 'vitest';

import { frameFirstPins, neighbourhoodRegion, NEIGHBOURHOOD, type MapCamera, type Region } from '../src/camera';
import type { GroupView, Pin } from '../src/groupView';

// Ways the map's first framing (ticket 10) could fail, written before src/camera.ts grew it:
//  1. It moves the camera before the map is ready, which iOS drops, so the map stays on the placeholder.
//  2. The map is ready before the Pins are, and the arrival never frames them.
//  3. It frames only this phone's own Pin, leaving every other Member off-screen.
//  4. It acts before the Group's first reads land, framing other Members' Pins while this phone has none.
//  5. With a single Pin — nobody else yet — it fits one point and zooms to the maximum.
//  6. It frames again on a later view (a heartbeat, the 15-second age tick, a new publish), fighting the pan.
//  7. A second onMapReady frames again.
//  8. It frames with no padding, so a Pin sits under the screen edge.
//  9. It frames the wrong coordinates, or the lone Pin at the wrong spot or zoom.
// 10. The recentre zoom is not the neighbourhood one.

const MINE = pin({ uid: 'me', displayName: 'Me', mine: true, lat: -37.9159, lng: 145.2556 });
const THEIRS = pin({ uid: 'them', displayName: 'Them', lat: -33.9, lng: 151.2 });

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

function view(overrides: Partial<GroupView>): GroupView {
  return { loaded: true, pins: [], members: [], nobodyElseSharing: false, ...overrides };
}

function recorder(): {
  fits: { coordinates: { latitude: number; longitude: number }[]; padding: number }[];
  moves: Region[];
  camera: MapCamera;
} {
  const fits: { coordinates: { latitude: number; longitude: number }[]; padding: number }[] = [];
  const moves: Region[] = [];
  return {
    fits,
    moves,
    camera: {
      fit: (coordinates, padding) => fits.push({ coordinates: [...coordinates], padding }),
      moveTo: (region) => moves.push(region),
    },
  };
}

describe('frameFirstPins', () => {
  it('holds the Pins that arrive before the map is ready, and frames them once it is', () => {
    const { fits, moves, camera } = recorder();
    const frame = frameFirstPins(camera);

    frame.view(view({ pins: [MINE, THEIRS] }));
    expect(fits).toEqual([]);
    expect(moves).toEqual([]);

    frame.mapReady();
    expect(fits).toEqual([
      {
        coordinates: [
          { latitude: MINE.lat, longitude: MINE.lng },
          { latitude: THEIRS.lat, longitude: THEIRS.lng },
        ],
        padding: expect.any(Number),
      },
    ]);
    expect(moves).toEqual([]);
  });

  it('frames every Pin, this phone’s own included', () => {
    const { fits, camera } = recorder();
    const frame = frameFirstPins(camera);

    frame.mapReady();
    frame.view(view({ pins: [THEIRS, MINE] }));

    expect(fits).toHaveLength(1);
    expect(fits[0].coordinates).toEqual([
      { latitude: THEIRS.lat, longitude: THEIRS.lng },
      { latitude: MINE.lat, longitude: MINE.lng },
    ]);
  });

  it('centres on this phone at the neighbourhood zoom when it is the only Pin, instead of fitting one point', () => {
    const { fits, moves, camera } = recorder();
    const frame = frameFirstPins(camera);

    frame.mapReady();
    frame.view(view({ pins: [MINE] }));

    expect(fits).toEqual([]);
    expect(moves).toEqual([neighbourhoodRegion(MINE.lat, MINE.lng)]);
  });

  it('waits for the Group’s first reads before acting', () => {
    const { fits, moves, camera } = recorder();
    const frame = frameFirstPins(camera);

    frame.mapReady();
    frame.view(view({ loaded: false, pins: [MINE, THEIRS] }));
    expect(fits).toEqual([]);
    expect(moves).toEqual([]);

    frame.view(view({ loaded: true, pins: [MINE, THEIRS] }));
    expect(fits).toHaveLength(1);
  });

  it('waits for this phone’s own Pin, and never frames another Member’s while it is missing', () => {
    const { fits, moves, camera } = recorder();
    const frame = frameFirstPins(camera);

    frame.mapReady();
    frame.view(view({ pins: [THEIRS] }));
    frame.view(view({ pins: [THEIRS] }));
    expect(fits).toEqual([]);
    expect(moves).toEqual([]);

    frame.view(view({ pins: [THEIRS, MINE] }));
    expect(fits).toHaveLength(1);
    expect(fits[0].coordinates).toContainEqual({ latitude: MINE.lat, longitude: MINE.lng });
  });

  it('frames only once, however many views and map-ready calls follow', () => {
    const { fits, moves, camera } = recorder();
    const frame = frameFirstPins(camera);

    frame.mapReady();
    frame.view(view({ pins: [MINE] }));
    frame.view(view({ pins: [MINE, THEIRS] }));
    frame.view(view({ pins: [{ ...MINE, lat: -37.8, lng: 145.1 }, THEIRS] }));
    frame.mapReady();

    expect(fits).toHaveLength(0);
    expect(moves).toHaveLength(1);
  });
});

describe('neighbourhoodRegion', () => {
  it('is a centre at the recentre button’s zoom', () => {
    expect(neighbourhoodRegion(-37.9159, 145.2556)).toEqual({
      latitude: -37.9159,
      longitude: 145.2556,
      ...NEIGHBOURHOOD,
    });
    expect(NEIGHBOURHOOD).toEqual({ latitudeDelta: 0.01, longitudeDelta: 0.01 });
  });
});
