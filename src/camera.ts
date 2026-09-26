import type { GroupView } from './groupView';

/** A camera target in react-native-maps' shape: a centre and how much of the map it spans. */
export type Region = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };

/** A point on the map, in react-native-maps' coordinate shape. */
export type Coordinate = { latitude: number; longitude: number };

/** Roughly a neighbourhood: the zoom the lone-pin centring and the recentre button use (spec §7.4). */
export const NEIGHBOURHOOD = { latitudeDelta: 0.01, longitudeDelta: 0.01 };

/** How far each edge of a framed Pin stays clear of the screen edge, so the group is not pinned to it. */
export const FIT_PADDING = 64;

/** A centre at the recentre button's zoom, for the recentre button and a tapped member row (spec §7.4). */
export function neighbourhoodRegion(lat: number, lng: number): Region {
  return { latitude: lat, longitude: lng, ...NEIGHBOURHOOD };
}

/** The two map operations the first framing needs: frame every Pin, or jump to a region. */
export type MapCamera = {
  fit(coordinates: readonly Coordinate[], padding: number): void;
  moveTo(region: Region): void;
};

/** The map's first framing: fed the map's readiness and every Group view, it moves the camera at most once. */
export type FirstFrame = {
  mapReady(): void;
  view(view: GroupView): void;
};

/**
 * Frames the Group once, as soon as the map is ready *and* the Group view has loaded *and* this phone's own
 * Pin is in it. iOS drops a camera move made before the map is ready, and the Members and Positions reads
 * can land before Sharing's first fix, so an early view is held rather than acted on: framing without this
 * phone would leave it off its own map. Every Pin is framed with padding; a lone Pin — nobody else has a
 * Position yet — is centred at the neighbourhood zoom instead, since fitting one point zooms to the maximum.
 * After that the camera is the user's: later views never move it.
 */
export function frameFirstPins(camera: MapCamera): FirstFrame {
  let ready = false;
  let framed = false;
  let latest: GroupView | undefined;

  const frame = () => {
    if (framed || !ready || !latest || !latest.loaded) return;
    const mine = latest.pins.find((pin) => pin.mine);
    if (!mine) return;
    framed = true;
    if (latest.pins.length > 1) {
      camera.fit(
        latest.pins.map((pin) => ({ latitude: pin.lat, longitude: pin.lng })),
        FIT_PADDING,
      );
    } else {
      camera.moveTo(neighbourhoodRegion(mine.lat, mine.lng));
    }
  };

  return {
    mapReady() {
      ready = true;
      frame();
    },
    view(next) {
      latest = next;
      frame();
    },
  };
}
