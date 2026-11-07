import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserTransportSelector } from './browser-transport-selector';
import { rememberPort } from './last-device';
import { SimulatorTransport } from './simulator-transport';

const port = {} as WebSerialPort;

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

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

describe('BrowserTransportSelector', () => {
  it('returns the simulator without touching navigator.serial', async () => {
    vi.stubGlobal('navigator', {});
    const transport = await new BrowserTransportSelector().select('simulator');
    expect(transport).toBeInstanceOf(SimulatorTransport);
  });

  it('requests a Web Serial port with the known VID/PID filter', async () => {
    const requestPort = vi.fn(async () => port);
    vi.stubGlobal('navigator', { serial: { requestPort } });

    const transport = await new BrowserTransportSelector().select('webserial');

    expect(transport).toBeDefined();
    expect(requestPort).toHaveBeenCalledWith({
      filters: [{ usbVendorId: 0xfff0, usbProductId: 0x0100 }],
    });
  });

  it('reuses a previously granted matching port without opening the picker', async () => {
    const savedPort = {
      getInfo: () => ({ usbVendorId: 0xfff0, usbProductId: 0x0100 }),
    } as WebSerialPort;
    rememberPort(savedPort);
    const requestPort = vi.fn(async () => port);
    const getPorts = vi.fn(async () => [savedPort]);
    vi.stubGlobal('navigator', { serial: { requestPort, getPorts } });

    const transport = await new BrowserTransportSelector().select('webserial');

    expect(transport).toBeDefined();
    expect(getPorts).toHaveBeenCalled();
    expect(requestPort).not.toHaveBeenCalled();
  });

  it('uses the picker when the saved port is not granted', async () => {
    const savedPort = {
      getInfo: () => ({ usbVendorId: 0xfff0, usbProductId: 0x0100 }),
    } as WebSerialPort;
    rememberPort(savedPort);
    const requestPort = vi.fn(async () => port);
    const getPorts = vi.fn(async () => []);
    vi.stubGlobal('navigator', { serial: { requestPort, getPorts } });

    await new BrowserTransportSelector().select('webserial');

    expect(requestPort).toHaveBeenCalled();
  });

  it('can force the picker even with a saved port', async () => {
    const savedPort = {
      getInfo: () => ({ usbVendorId: 0xfff0, usbProductId: 0x0100 }),
    } as WebSerialPort;
    rememberPort(savedPort);
    const requestPort = vi.fn(async () => port);
    const getPorts = vi.fn(async () => [savedPort]);
    vi.stubGlobal('navigator', { serial: { requestPort, getPorts } });

    await new BrowserTransportSelector().select('webserial', { preferSaved: false });

    expect(getPorts).not.toHaveBeenCalled();
    expect(requestPort).toHaveBeenCalled();
  });

  it('reports a missing Web Serial capability as unsupported', async () => {
    vi.stubGlobal('navigator', {});
    await expect(new BrowserTransportSelector().select('webserial')).rejects.toMatchObject({
      code: 'unsupported',
      detail: { stage: 'capability' },
    });
  });

  it('maps a dismissed picker to cancelled', async () => {
    const requestPort = vi.fn(async () => {
      throw new DOMException('No port selected', 'NotFoundError');
    });
    vi.stubGlobal('navigator', { serial: { requestPort } });

    await expect(new BrowserTransportSelector().select('webserial')).rejects.toMatchObject({
      code: 'cancelled',
      detail: { stage: 'request-port' },
    });
  });
});
