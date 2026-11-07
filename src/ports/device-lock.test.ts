import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserDeviceLock } from './device-lock';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BrowserDeviceLock', () => {
  it('asks for an exclusive, if-available lock and reports contention', async () => {
    let options: { mode?: string; ifAvailable?: boolean } | undefined;
    vi.stubGlobal('navigator', {
      locks: {
        request: vi.fn(async (_name, requestOptions, callback) => {
          options = requestOptions;
          await callback(null);
        }),
      },
    });

    const lock = new BrowserDeviceLock();
    await expect(lock.acquire()).resolves.toBe(false);
    expect(lock.supported).toBe(true);
    expect(options).toEqual({ mode: 'exclusive', ifAvailable: true });
  });

  it('reports an unavailable lock environment without hanging', async () => {
    vi.stubGlobal('navigator', {});
    const lock = new BrowserDeviceLock();
    await expect(lock.acquire()).resolves.toBe(false);
    expect(lock.supported).toBe(false);
  });
});
