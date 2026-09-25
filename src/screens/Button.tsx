import { Pressable, StyleSheet, Text } from 'react-native';

/** The app's one button: Create, Open Settings, Try again, and the rest of the §7 screens. */
export default function Button({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, disabled && styles.buttonDisabled]}
    >
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { backgroundColor: '#1a73e8', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.4 },
  label: { color: 'white', fontSize: 17, fontWeight: '600' },
});
