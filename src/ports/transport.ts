export type TransportKind = 'webusb' | 'webserial';

export type TransportErrorCode =
  | 'unsupported'
  | 'permission-denied'
  | 'cancelled'
  | 'device-unavailable'
  | 'open-failed'
  | 'close-failed'
  | 'device-in-use'
  | 'locks-unavailable'
  | 'unknown';

export class TransportError extends Error {
  readonly code: TransportErrorCode;

  constructor(code: TransportErrorCode, message: string) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
  }
}

export interface TransportInfo {
  kind: TransportKind;
  label: string;
  vendorId?: number;
  productId?: number;
  product?: string;
}

export interface DeviceTransport {
  open(): Promise<TransportInfo>;
  close(): Promise<void>;
  write(bytes: Uint8Array): Promise<void>;
  readChunk(timeoutMs: number): Promise<Uint8Array>;
  flushInput(): Promise<void>;
}

export interface TransportSelector {
  select(kind: TransportKind): Promise<DeviceTransport>;
}

export function toTransportError(error: unknown): TransportError {
  if (error instanceof TransportError) return error;

  if (error instanceof DOMException) {
    if (error.name === 'NotFoundError') {
      return new TransportError('permission-denied', 'No device was selected.');
    }
    if (error.name === 'SecurityError') {
      return new TransportError('permission-denied', 'The browser denied device access.');
    }
    if (error.name === 'InvalidStateError') {
      return new TransportError('device-unavailable', 'The device is already in use or disconnected.');
    }
    if (error.name === 'NetworkError') {
      return new TransportError('device-unavailable', 'The device stopped responding.');
    }
  }

  return new TransportError('open-failed', 'The device could not be opened.');
}
