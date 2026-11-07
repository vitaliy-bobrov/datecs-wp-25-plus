import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchesLastDevice, readLastDevice, rememberPort } from './last-device';

class MemoryStorage {
  private readonly entries = new Map<string, string>();
  get length(): number {
    return this.entries.size;
  }
  clear(): void {
    this.entries.clear();
  }
  getItem(key: string): string | null {
    return this.entries.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.entries.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.entries.delete(key);
  }
  setItem(key: string, value: string): void {
    this.entries.set(key, value);
  }
}

const device = {
  getInfo: () => ({ usbVendorId: 0xfff0, usbProductId: 0x0100 }),
} as WebSerialPort;

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('last device', () => {
  it('remembers and matches the granted port by VID/PID', () => {
    expect(readLastDevice()).toBeNull();
    const saved = rememberPort(device);
    expect(saved).toMatchObject({ vendorId: 0xfff0, productId: 0x0100 });
    expect(readLastDevice()).toMatchObject({ vendorId: 0xfff0, productId: 0x0100 });
    expect(matchesLastDevice(device, saved)).toBe(true);
  });

  it('does not match a different device or malformed storage', () => {
    expect(readLastDevice()).toBeNull();
    expect(
      matchesLastDevice({ getInfo: () => ({ usbVendorId: 1, usbProductId: 2 }) } as WebSerialPort, {
        vendorId: 0xfff0,
        productId: 0x0100,
        label: 'x',
        savedAt: 0,
      }),
    ).toBe(false);
    localStorage.setItem('datecs-wp25:last-device:v1', '{not json');
    expect(readLastDevice()).toBeNull();
  });
});
