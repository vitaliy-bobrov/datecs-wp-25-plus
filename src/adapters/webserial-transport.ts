import {
  type DeviceTransport,
  type TransportDeviceDetail,
  TransportError,
  type TransportInfo,
  toTransportError,
} from '../ports/transport';

export class WebSerialTransport implements DeviceTransport {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;

  constructor(private readonly port: WebSerialPort) {}

  private deviceDetail(): TransportDeviceDetail {
    const info = this.port.getInfo();
    return {
      label: 'Web Serial device',
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
    };
  }

  private info(): TransportInfo {
    const info = this.port.getInfo();
    return {
      kind: 'webserial',
      label: 'Web Serial device',
      vendorId: info.usbVendorId,
      productId: info.usbProductId,
      baudRate: 9600,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
    };
  }

  private async settle(promise: Promise<unknown> | undefined, timeoutMs = 1000): Promise<void> {
    if (!promise) return;
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private async resetReader(): Promise<void> {
    const reader = this.reader;
    this.reader = null;
    this.pendingRead = null;
    await this.settle(reader?.cancel());
    try {
      reader?.releaseLock();
    } catch {
      // Ignore lock release errors while replacing the reader.
    }
    if (this.port.readable) {
      this.reader = this.port.readable.getReader();
    }
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

      if (!this.port.readable || !this.port.writable) {
        throw new TransportError(
          'unsupported',
          'The serial port has no readable or writable stream.',
          {
            operation: 'webserial.open',
            stage: 'streams',
            device: this.deviceDetail(),
          },
        );
      }

      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
    } catch (error) {
      try {
        await this.reader?.cancel();
        this.reader?.releaseLock();
      } catch {
        // Ignore reader cleanup errors.
      }
      this.reader = null;
      try {
        await this.port.close();
      } catch {
        // Keep the original diagnostic.
      }
      const stage =
        error instanceof TransportError && error.detail?.stage ? error.detail.stage : 'port.open';
      throw toTransportError(error, 'webserial.open', {
        operation: 'webserial.open',
        stage,
        device: this.deviceDetail(),
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      });
    }
    return this.info();
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (!this.writer) {
      throw new TransportError('device-unavailable', 'The serial port is not open.', {
        operation: 'webserial.write',
        stage: 'write',
        device: this.deviceDetail(),
      });
    }
    try {
      await this.writer.write(bytes);
    } catch (error) {
      throw toTransportError(error, 'webserial.write', {
        operation: 'webserial.write',
        stage: 'write',
        device: this.deviceDetail(),
      });
    }
  }

  async readChunk(timeoutMs: number): Promise<Uint8Array> {
    if (!this.reader) {
      throw new TransportError('device-unavailable', 'The serial port is not open.', {
        operation: 'webserial.read',
        stage: 'read',
        device: this.deviceDetail(),
      });
    }

    if (!this.pendingRead) {
      this.pendingRead = this.reader.read();
    }
    const pending = this.pendingRead;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new TransportError('timeout', 'The device did not respond in time.', {
            operation: 'webserial.read',
            stage: 'read',
            device: this.deviceDetail(),
          }),
        );
      }, timeoutMs);
    });

    try {
      const result = await Promise.race([pending, timeout]);
      this.pendingRead = null;
      if (result.done) {
        throw new TransportError('device-unavailable', 'The serial stream ended.', {
          operation: 'webserial.read',
          stage: 'read',
          device: this.deviceDetail(),
        });
      }
      return result.value ?? new Uint8Array();
    } catch (error) {
      if (error instanceof TransportError && error.code === 'timeout') {
        try {
          await this.resetReader();
        } catch {
          // The timeout remains the primary diagnostic.
        }
        throw error;
      }
      this.pendingRead = null;
      throw toTransportError(error, 'webserial.read', {
        operation: 'webserial.read',
        stage: 'read',
        device: this.deviceDetail(),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async flushInput(): Promise<void> {
    await this.resetReader();
  }

  async close(): Promise<void> {
    await this.settle(this.reader?.cancel());
    try {
      this.reader?.releaseLock();
    } catch {
      // Ignore lock release errors during teardown.
    }
    this.reader = null;
    this.pendingRead = null;

    try {
      this.writer?.releaseLock();
    } catch {
      // Ignore lock release errors during teardown.
    }
    this.writer = null;

    try {
      await this.settle(this.port.close());
      await this.settle(this.port.forget?.());
    } catch (error) {
      throw toTransportError(error, 'webserial.close', {
        operation: 'webserial.close',
        stage: 'port.close',
        device: this.deviceDetail(),
      });
    }
  }
}
