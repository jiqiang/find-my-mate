import { StyleSheet, Text, View } from 'react-native';
import MapView, { Marker } from 'react-native-maps';

// Somewhere to open before the app has a Position of its own to centre on.
const PLACEHOLDER_COORDINATE = { latitude: -33.8688, longitude: 151.2093 };
const PLACEHOLDER_REGION = {
  ...PLACEHOLDER_COORDINATE,
  latitudeDelta: 0.05,
  longitudeDelta: 0.05,
};

export default function Map({ groupName }: { groupName: string }) {
  return (
    <View style={StyleSheet.absoluteFill}>
      <MapView style={StyleSheet.absoluteFill} initialRegion={PLACEHOLDER_REGION} mapType="standard">
        <Marker coordinate={PLACEHOLDER_COORDINATE} title="Find My Mate" />
      </MapView>
      <View style={styles.header} pointerEvents="none">
        <Text style={styles.groupName}>{groupName}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    position: 'absolute',
    top: 56,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.9)',
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  groupName: { fontSize: 17, fontWeight: '600' },
});
