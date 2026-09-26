import type { Pin } from './pins';

/** A camera target in react-native-maps' shape: a centre and how much of the map it spans. */
export type Region = { latitude: number; longitude: number; latitudeDelta: number; longitudeDelta: number };

/** Roughly a neighbourhood: the zoom the first centring and the recentre button use (spec §7.4). */
export const NEIGHBOURHOOD = { latitudeDelta: 0.01, longitudeDelta: 0.01 };

/** The map's first centring: fed the map's readiness and every Pin list, it moves the camera at most once. */
export type FirstCentre = {
  mapReady(): void;
  pins(pins: readonly Pin[]): void;
};

/**
 * Centres on this phone's own Pin once, as soon as the map is ready *and* there is one. iOS drops a camera
 * move made before the map is ready, and Sharing's Pin can already be there on the map's first render, so a
 * Pin that arrives early is held rather than acted on. After that the camera is the user's.
 */
export function centreOnFirstPin(moveTo: (region: Region) => void): FirstCentre {
  let ready = false;
  let centred = false;
  let mine: Pin | undefined;

  const centre = () => {
    if (!ready || centred || !mine) return;
    centred = true;
    moveTo({ latitude: mine.lat, longitude: mine.lng, ...NEIGHBOURHOOD });
  };

  return {
    mapReady() {
      ready = true;
      centre();
    },
    pins(pins) {
      mine = pins.find((each) => each.mine);
      centre();
    },
  };
}
