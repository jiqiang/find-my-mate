import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@react-native-async-storage/async-storage': new URL('./test/fakes/async-storage.ts', import.meta.url).pathname,
      'expo-location': new URL('./test/fakes/expo-location.ts', import.meta.url).pathname,
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // One shared emulator, cleared before every test: files must not interleave.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
