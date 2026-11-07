import {
  TransportError,
  toTransportError,
  type DeviceTransport,
  type TransportInfo,
} from '../ports/transport';

export class WebSerialTransport implements DeviceTransport {
  constructor(private readonly port: WebSerialPort) {}

  private info(): TransportInfo {
    const info = this.port.getInfo();
    return {
      kind: 'webserial',
      label: 'Web Serial device',
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
    };
  }

  async open(): Promise<TransportInfo> {
    try {
      await this.port.open({
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      });
    } catch (error) {
      throw toTransportError(error);
    }
    return this.info();
  }

  async close(): Promise<void> {
    try {
      await this.port.close();
      await this.port.forget?.();
    } catch (error) {
      throw toTransportError(error);
    }
  }

  async write(_bytes: Uint8Array): Promise<void> {
    throw new TransportError('unsupported', 'Device commands are not enabled in this story.');
  }

  async readChunk(_timeoutMs: number): Promise<Uint8Array> {
    throw new TransportError('unsupported', 'Device reads are not enabled in this story.');
  }

  async flushInput(): Promise<void> {
    // No device commands are sent in this story.
  }
}
