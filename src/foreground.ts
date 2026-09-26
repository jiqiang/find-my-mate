import { AppState, type AppStateStatus } from 'react-native';

import type { Foreground } from './location';

/**
 * The app's foreground signal: the phone is in front only while AppState says `active`, so iOS `inactive`
 * (a pulled-down shade, an incoming call) counts as away and Sharing holds no watch (ADR 0001).
 */
export const appStateForeground: Foreground = {
  isActive: () => AppState.currentState === 'active',
  subscribe(listener) {
    const subscription = AppState.addEventListener('change', (state: AppStateStatus) => {
      listener(state === 'active');
    });
    return () => subscription.remove();
  },
};
