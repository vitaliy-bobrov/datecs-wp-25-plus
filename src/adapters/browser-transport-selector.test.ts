import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserTransportSelector } from './browser-transport-selector';
import { SimulatorTransport } from './simulator-transport';

const port = {} as WebSerialPort;

afterEach(() => {
  vi.unstubAllGlobals();
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
