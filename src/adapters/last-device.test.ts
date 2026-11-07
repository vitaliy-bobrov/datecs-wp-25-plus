import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryStorage } from '../test/storage';
import { matchesLastDevice, readLastDevice, rememberPort } from './last-device';

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
      }),
    ).toBe(false);
    localStorage.setItem('datecs-wp25:last-device:v1', '{not json');
    expect(readLastDevice()).toBeNull();
  });
});
