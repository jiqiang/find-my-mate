import { StyleSheet } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

// Somewhere to open before the app has a Position of its own to centre on.
const PLACEHOLDER_COORDINATE = { latitude: -33.8688, longitude: 151.2093 };
const PLACEHOLDER_REGION = {
  ...PLACEHOLDER_COORDINATE,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

export default function App() {
  return (
    <MapView style={StyleSheet.absoluteFill} initialRegion={PLACEHOLDER_REGION} mapType="standard">
      <Marker coordinate={PLACEHOLDER_COORDINATE} title="Find My Mate" />
    </MapView>
  );
}
