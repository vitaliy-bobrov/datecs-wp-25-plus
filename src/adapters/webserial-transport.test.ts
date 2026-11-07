import { describe, expect, it } from 'vitest';
import { WebSerialTransport } from './webserial-transport';

class FakePort implements WebSerialPort {
  opened: WebSerialOptions | null = null;
  closed = false;
  forgot = false;
  openFailure: unknown = null;
  readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  written: Uint8Array[] = [];
  writable = new WritableStream<Uint8Array>({
    write: (chunk) => {
      this.written.push(chunk);
    },
  });

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

class SilentPort implements WebSerialPort {
  readable = new ReadableStream<Uint8Array>({ start() {} });
  writable = new WritableStream<Uint8Array>();

  getInfo(): WebSerialPortInfo {
    return {};
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {}

  async forget(): Promise<void> {}
}

class MissingStreamsPort implements WebSerialPort {
  readable = undefined;
  writable = new WritableStream<Uint8Array>();

  getInfo(): WebSerialPortInfo {
    return {};
  }

  async open(): Promise<void> {}

  async close(): Promise<void> {}
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

  it('writes bytes and closes the port with forget on disconnect', async () => {
    const port = new FakePort();
    const transport = new WebSerialTransport(port);
    await transport.open();
    await transport.write(Uint8Array.from([0x01, 0x02]));
    await transport.close();

    expect(port.written).toHaveLength(1);
    expect(Array.from(port.written[0] ?? [])).toEqual([0x01, 0x02]);
    expect(port.closed).toBe(true);
    expect(port.forgot).toBe(true);
  });

  it('reports a read timeout with the timeout code', async () => {
    const transport = new WebSerialTransport(new SilentPort());
    await transport.open();
    await expect(transport.readChunk(10)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('preserves the streams stage when a stream is missing', async () => {
    const transport = new WebSerialTransport(new MissingStreamsPort());
    await expect(transport.open()).rejects.toMatchObject({
      code: 'unsupported',
      detail: { stage: 'streams' },
    });
  });

  it('keeps the open stage, error name and device on failure', async () => {
    const port = new FakePort();
    port.openFailure = new DOMException('Failed to open the serial port', 'NetworkError');
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
