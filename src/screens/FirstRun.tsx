import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

type Props = {
  onCreate: (yourName: string, groupName: string) => Promise<void>;
};

export default function FirstRun({ onCreate }: Props) {
  const [mode, setMode] = useState<'choose' | 'create'>('choose');

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Find My Mate</Text>
      {mode === 'choose' ? (
        <>
          <Button label="Create a family group" onPress={() => setMode('create')} />
          {/* Join with a code arrives in ticket 07. */}
        </>
      ) : (
        <CreateForm onCreate={onCreate} />
      )}
    </View>
  );
}

function CreateForm({ onCreate }: Props) {
  const [yourName, setYourName] = useState('');
  const [groupName, setGroupName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  // State lags a render behind, so a fast double-tap would pass a state check twice and create two Groups.
  const inFlight = useRef(false);

  const ready = yourName.trim() !== '' && groupName.trim() !== '' && !submitting;

  async function submit() {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      await onCreate(yourName, groupName);
    } catch (e) {
      console.warn('[session] create failed', e);
      setError("Couldn't create the group. Try again.");
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <TextInput
        style={styles.input}
        placeholder="Your name"
        value={yourName}
        onChangeText={setYourName}
        autoCapitalize="words"
        editable={!submitting}
      />
      <TextInput
        style={styles.input}
        placeholder="Group name"
        value={groupName}
        onChangeText={setGroupName}
        autoCapitalize="words"
        editable={!submitting}
        onSubmitEditing={submit}
      />
      {submitting ? <ActivityIndicator style={styles.spinner} /> : <Button label="Create" onPress={submit} disabled={!ready} />}
      {error && <Text style={styles.error}>{error}</Text>}
    </>
  );
}

function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, disabled && styles.buttonDisabled]}
    >
      <Text style={styles.buttonLabel}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: '600', textAlign: 'center', marginBottom: 24 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 17 },
  button: { backgroundColor: '#1a73e8', borderRadius: 8, padding: 14, alignItems: 'center' },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { color: 'white', fontSize: 17, fontWeight: '600' },
  spinner: { padding: 14 },
  error: { color: '#b00020', textAlign: 'center' },
});
