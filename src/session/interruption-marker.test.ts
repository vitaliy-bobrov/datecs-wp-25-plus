import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../test/storage';
import {
  clearInterruptionMarker,
  createInterruptionStore,
  INTERRUPTION_MARKER_KEY,
  readInterruptionMarker,
} from './interruption-marker';

const startedAt = '2026-11-08T09:00:00.000Z';

function storeWithStorage(): {
  storage: MemoryStorage;
  store: ReturnType<typeof createInterruptionStore>;
} {
  const storage = new MemoryStorage();
  return { storage, store: createInterruptionStore(() => storage) };
}

describe('interruption marker', () => {
  it('stores only the version, kind, startedAt and optional field', () => {
    const { storage, store } = storeWithStorage();

    store.write({ kind: 'update', startedAt });

    expect(readInterruptionMarker(storage)).toEqual({
      version: 1,
      kind: 'update',
      startedAt,
    });
    expect(Object.keys(JSON.parse(storage.getItem(INTERRUPTION_MARKER_KEY) ?? '{}'))).toEqual([
      'version',
      'kind',
      'startedAt',
    ]);

    store.write({ kind: 'write-test', startedAt, field: 'slot0Rate' });
    expect(readInterruptionMarker(storage)).toEqual({
      version: 1,
      kind: 'write-test',
      startedAt,
      field: 'slot0Rate',
    });
  });

  it('clears the marker', () => {
    const { storage, store } = storeWithStorage();
    store.write({ kind: 'update', startedAt });

    store.clear();

    expect(readInterruptionMarker(storage)).toBeNull();
    expect(storage.getItem(INTERRUPTION_MARKER_KEY)).toBeNull();
  });

  it('ignores and removes bad JSON, a wrong version or a bad shape', () => {
    const { storage } = storeWithStorage();

    for (const raw of [
      '{not json',
      JSON.stringify({ version: 2, kind: 'update', startedAt }),
      JSON.stringify({ version: 1, kind: 'restore', startedAt }),
      JSON.stringify({ version: 1, kind: 'update', startedAt: '' }),
      JSON.stringify({ version: 1, kind: 'update', startedAt: 'not-a-date' }),
      JSON.stringify({ version: 1, kind: 'update', startedAt, field: 42 }),
      JSON.stringify({ version: 1, kind: 'update', startedAt, field: 'arbitrary' }),
      JSON.stringify([{ version: 1, kind: 'update', startedAt }]),
    ]) {
      storage.setItem(INTERRUPTION_MARKER_KEY, raw);
      expect(readInterruptionMarker(storage)).toBeNull();
      expect(storage.getItem(INTERRUPTION_MARKER_KEY)).toBeNull();
    }
  });

  it('ignores an absent marker and an unavailable storage', () => {
    expect(readInterruptionMarker(new MemoryStorage())).toBeNull();
    expect(readInterruptionMarker(null)).toBeNull();
  });

  it('does not throw when storage access fails', () => {
    const failing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    const store = createInterruptionStore(() => failing);

    expect(store.read()).toBeNull();
    expect(() => store.write({ kind: 'update', startedAt })).not.toThrow();
    expect(() => store.clear()).not.toThrow();
  });

  it('clears through the exported helper', () => {
    const storage = new MemoryStorage();
    createInterruptionStore(() => storage).write({ kind: 'update', startedAt });

    clearInterruptionMarker(storage);

    expect(readInterruptionMarker(storage)).toBeNull();
  });
});
