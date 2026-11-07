import { describe, expect, it } from 'vitest';
import { WebSerialTransport } from './webserial-transport';

class FakePort implements WebSerialPort {
  opened: WebSerialOptions | null = null;
  closed = false;
  forgot = false;
  openFailure: unknown = null;

  getInfo(): WebSerialPortInfo {
    return { usbVendorId: 0x1234, usbProductId: 0x5678 };
  }

  async open(options: WebSerialOptions): Promise<void> {
    if (this.openFailure) throw this.openFailure;
    this.opened = options;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async forget(): Promise<void> {
    this.forgot = true;
  }
}

describe('WebSerialTransport diagnostics', () => {
  it('records the open settings and USB IDs on success', async () => {
    const port = new FakePort();
    const transport = new WebSerialTransport(port);
    const info = await transport.open();

    expect(info.kind).toBe('webserial');
    expect(info.vendorId).toBe(0x1234);
    expect(info.productId).toBe(0x5678);
    expect(info.baudRate).toBe(9600);
    expect(info.dataBits).toBe(8);
    expect(info.stopBits).toBe(1);
    expect(info.parity).toBe('none');
    expect(port.opened?.baudRate).toBe(9600);
  });

  it('keeps the open stage, error name and device on failure', async () => {
    const port = new FakePort();
    port.openFailure = new DOMException('Failed to open /dev/ttyUSB0', 'NetworkError');
    const transport = new WebSerialTransport(port);

    await expect(transport.open()).rejects.toMatchObject({
      code: 'device-unavailable',
      detail: {
        operation: 'webserial.open',
        stage: 'port.open',
        errorName: 'NetworkError',
        baudRate: 9600,
        device: { vendorId: 0x1234, productId: 0x5678 },
      },
    });
  });
});
