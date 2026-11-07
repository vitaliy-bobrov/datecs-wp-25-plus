interface WebUsbDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
}

interface WebUsbEndpoint {
  endpointNumber: number;
  direction: 'in' | 'out';
  type: 'bulk' | 'interrupt' | 'isochronous';
}

interface WebUsbAlternate {
  alternateSetting: number;
  endpoints: WebUsbEndpoint[];
}

interface WebUsbInterface {
  interfaceNumber: number;
  alternates: WebUsbAlternate[];
  claimed?: boolean;
}

interface WebUsbConfiguration {
  configurationValue: number;
  interfaces: WebUsbInterface[];
}

interface WebUsbDevice {
  vendorId: number;
  productId: number;
  productName?: string;
  manufacturerName?: string;
  serialNumber?: string;
  configuration: WebUsbConfiguration | null;
  configurations: WebUsbConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  selectConfiguration(value: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void>;
}

interface WebUsbManager {
  requestDevice(options: { filters: WebUsbDeviceFilter[] }): Promise<WebUsbDevice>;
}

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
  readonly usb?: WebUsbManager;
  readonly serial?: WebSerialManager;
  readonly locks?: WebLocksManager;
}
