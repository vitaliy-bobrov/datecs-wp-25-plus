export const INTERRUPTION_MARKER_KEY = 'datecs-wp25:write-in-progress:v1';
const INTERRUPTION_MARKER_VERSION = 1;
const MARKER_FIELDS = new Set(['slot0Rate', 'slot1Rate', 'converterRate', 'converterPrint']);

export type InterruptionKind = 'update' | 'write-test';

export interface InterruptionMarker {
  version: typeof INTERRUPTION_MARKER_VERSION;
  kind: InterruptionKind;
  startedAt: string;
  field?: string;
}

export interface InterruptionStore {
  read(): InterruptionMarker | null;
  write(entry: Omit<InterruptionMarker, 'version'>): void;
  clear(): void;
}

function browserStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function isValidMarker(value: unknown): value is InterruptionMarker {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<InterruptionMarker>;
  if (candidate.version !== INTERRUPTION_MARKER_VERSION) return false;
  if (candidate.kind !== 'update' && candidate.kind !== 'write-test') return false;
  if (typeof candidate.startedAt !== 'string' || candidate.startedAt.length === 0) return false;
  if (Number.isNaN(Date.parse(candidate.startedAt))) return false;
  if (
    candidate.field !== undefined &&
    (typeof candidate.field !== 'string' || !MARKER_FIELDS.has(candidate.field))
  ) {
    return false;
  }
  return true;
}

function removeQuietly(storage: Storage | null): void {
  try {
    storage?.removeItem(INTERRUPTION_MARKER_KEY);
  } catch {
    return;
  }
}

export function readInterruptionMarker(
  storage: Storage | null = browserStorage(),
): InterruptionMarker | null {
  if (!storage) return null;

  let raw: string | null;
  try {
    raw = storage.getItem(INTERRUPTION_MARKER_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    removeQuietly(storage);
    return null;
  }

  if (!isValidMarker(value)) {
    removeQuietly(storage);
    return null;
  }
  return value;
}

export function clearInterruptionMarker(storage: Storage | null = browserStorage()): void {
  removeQuietly(storage);
}

export function createInterruptionStore(getStorage: () => Storage | null): InterruptionStore {
  return {
    read: () => readInterruptionMarker(getStorage()),
    write: (entry) => {
      const storage = getStorage();
      if (!storage) return;
      try {
        const marker: InterruptionMarker = { version: INTERRUPTION_MARKER_VERSION, ...entry };
        storage.setItem(INTERRUPTION_MARKER_KEY, JSON.stringify(marker));
      } catch {
        return;
      }
    },
    clear: () => clearInterruptionMarker(getStorage()),
  };
}

export function createBrowserInterruptionStore(): InterruptionStore {
  return createInterruptionStore(browserStorage);
}
