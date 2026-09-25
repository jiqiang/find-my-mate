import AsyncStorage from '@react-native-async-storage/async-storage';
import { initializeApp } from 'firebase/app';
import { initializeAuth, signInAnonymously, type User } from 'firebase/auth';
// The React Native auth build; tsconfig "paths" points its types at index.rn.d.ts, which firebase/auth's omit.
import { getReactNativePersistence } from '@firebase/auth';
import { getFirestore } from 'firebase/firestore';

// Public by design (spec §8.7): Firestore rules, not this key, protect the data.
const firebaseConfig = {
  apiKey: 'AIzaSyAyM5VJSmqUzqxvvPRO4YzeP11N9Y0aCyw',
  authDomain: 'find-my-mate-c56bf.firebaseapp.com',
  projectId: 'find-my-mate-c56bf',
  storageBucket: 'find-my-mate-c56bf.firebasestorage.app',
  messagingSenderId: '123555020189',
  appId: '1:123555020189:web:96d9b5787f1b7d28bc8374',
};

const app = initializeApp(firebaseConfig);

// AsyncStorage persistence keeps the anonymous uid across relaunches: a Member is an app install.
export const auth = initializeAuth(app, {
  persistence: getReactNativePersistence(AsyncStorage),
});

export const db = getFirestore(app);

/**
 * Resolves with the signed-in user, signing in anonymously only when no persisted user exists.
 * Waits for auth to restore from storage first, so a relaunch never mints a new uid.
 */
export async function signIn(): Promise<User> {
  await auth.authStateReady();
  return auth.currentUser ?? (await signInAnonymously(auth)).user;
}
