// An in-memory AsyncStorage for Node: the real module needs React Native's native bridge.
const store = new Map<string, string>();

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return store.get(key) ?? null;
  },
  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value);
  },
  async multiGet(keys: readonly string[]): Promise<[string, string | null][]> {
    return keys.map((key) => [key, store.get(key) ?? null]);
  },
  async multiSet(pairs: readonly [string, string][]): Promise<void> {
    for (const [key, value] of pairs) store.set(key, value);
  },
  async removeItem(key: string): Promise<void> {
    store.delete(key);
  },
  async clear(): Promise<void> {
    store.clear();
  },
};

export default AsyncStorage;
