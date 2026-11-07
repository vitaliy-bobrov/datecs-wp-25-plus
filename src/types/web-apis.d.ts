interface WebSerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

interface WebSerialOptions {
  baudRate: number;
  dataBits?: 7 | 8;
  stopBits?: 1 | 2;
  parity?: 'none' | 'even' | 'odd';
  bufferSize?: number;
  flowControl?: 'none' | 'hardware';
}

interface WebSerialPort {
  open(options: WebSerialOptions): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  getInfo(): WebSerialPortInfo;
  readable?: ReadableStream<Uint8Array>;
  writable?: WritableStream<Uint8Array>;
}

interface WebSerialManager {
  requestPort(options?: { filters?: WebSerialPortInfo[] }): Promise<WebSerialPort>;
  getPorts(): Promise<WebSerialPort[]>;
}

interface WebLock {
  name: string;
  mode: 'exclusive' | 'shared';
}

interface WebLocksManager {
  request(
    name: string,
    options: { mode?: 'exclusive' | 'shared'; ifAvailable?: boolean },
    callback: (lock: WebLock | null) => Promise<void>,
  ): Promise<void>;
}

interface Navigator {
  readonly serial?: WebSerialManager;
  readonly locks?: WebLocksManager;
}
