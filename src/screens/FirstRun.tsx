import { useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, View } from 'react-native';

import type { JoinResult } from '../session';
import Button from './Button';

type Props = {
  onCreate: (yourName: string, groupName: string) => Promise<void>;
  onJoin: (code: string, yourName: string) => Promise<JoinResult>;
};

export default function FirstRun({ onCreate, onJoin }: Props) {
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose');

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>Find My Mate</Text>
      {mode === 'choose' ? (
        <>
          <Button label="Create a family group" onPress={() => setMode('create')} />
          <Button label="Join with a code" onPress={() => setMode('join')} />
        </>
      ) : mode === 'create' ? (
        <CreateForm onCreate={onCreate} />
      ) : (
        <JoinForm onJoin={onJoin} />
      )}
    </View>
  );
}

function CreateForm({ onCreate }: Pick<Props, 'onCreate'>) {
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

function JoinForm({ onJoin }: Pick<Props, 'onJoin'>) {
  const [code, setCode] = useState('');
  const [yourName, setYourName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string>();
  const inFlight = useRef(false);

  const ready = code.trim() !== '' && yourName.trim() !== '' && !submitting;

  async function submit() {
    if (!ready || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await onJoin(code, yourName);
      // A wrong, expired or already-used code is indistinguishable here: the fields keep their values.
      if (!result.ok) {
        setError("That code isn't right.");
        inFlight.current = false;
        setSubmitting(false);
      }
    } catch (e) {
      console.warn('[session] join failed', e);
      setError("Couldn't join. Try again.");
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <>
      <TextInput
        style={styles.input}
        placeholder="Code"
        value={code}
        onChangeText={setCode}
        autoCapitalize="characters"
        autoCorrect={false}
        editable={!submitting}
      />
      <TextInput
        style={styles.input}
        placeholder="Your name"
        value={yourName}
        onChangeText={setYourName}
        autoCapitalize="words"
        editable={!submitting}
        onSubmitEditing={submit}
      />
      {submitting ? <ActivityIndicator style={styles.spinner} /> : <Button label="Join" onPress={submit} disabled={!ready} />}
      {error && <Text style={styles.error}>{error}</Text>}
    </>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: '600', textAlign: 'center', marginBottom: 24 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, fontSize: 17 },
  spinner: { padding: 14 },
  error: { color: '#b00020', textAlign: 'center' },
});
