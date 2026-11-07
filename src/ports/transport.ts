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

export interface TransportDeviceDetail {
  label?: string;
  vendorId?: number;
  productId?: number;
  product?: string;
}

export interface TransportErrorDetail {
  operation?: string;
  stage?: string;
  errorName?: string;
  errorMessage?: string;
  device?: TransportDeviceDetail;
  configurationValue?: number;
  interfaceNumber?: number;
  alternateSetting?: number;
  endpointCount?: number;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  flowControl?: string;
  userAgent?: string;
  platform?: string;
}

export class TransportError extends Error {
  readonly code: TransportErrorCode;
  readonly detail?: TransportErrorDetail;

  constructor(code: TransportErrorCode, message: string, detail?: TransportErrorDetail) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.detail = detail;
  }
}

export interface TransportInfo {
  kind: TransportKind;
  label: string;
  vendorId?: number;
  productId?: number;
  product?: string;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: string;
  flowControl?: string;
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

function diagnosticText(value: string): string {
  return value
    .replace(/(?:[A-Za-z]:\\|\/)[^\s"'<>]+/g, '<path>')
    .replace(/\b[0-9A-Fa-f]{16,}\b/g, '<id>')
    .slice(0, 500);
}

export function toTransportError(
  error: unknown,
  operation?: string,
  detail?: TransportErrorDetail,
): TransportError {
  if (error instanceof TransportError) {
    if (!detail && !operation) return error;
    return new TransportError(error.code, error.message, {
      ...error.detail,
      ...detail,
      operation: detail?.operation ?? error.detail?.operation ?? operation,
    });
  }

  let code: TransportErrorCode = 'open-failed';
  let errorName: string | undefined;
  let errorMessage: string | undefined;

  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    errorName = error.name;
    errorMessage = diagnosticText(error.message);
    if (error.name === 'NotFoundError') {
      code = 'permission-denied';
    } else if (error.name === 'SecurityError') {
      code = 'permission-denied';
    } else if (error.name === 'InvalidStateError') {
      code = 'device-unavailable';
    } else if (error.name === 'NetworkError') {
      code = 'device-unavailable';
    }
  } else if (error instanceof Error) {
    errorName = error.name;
    errorMessage = diagnosticText(error.message);
  }

  const messages: Record<TransportErrorCode, string> = {
    unsupported: 'This browser or device does not support the selected transport.',
    'permission-denied': 'Device permission was not granted.',
    cancelled: 'No device was selected.',
    'device-unavailable': 'The device is unavailable or disconnected.',
    'open-failed': 'The device could not be opened.',
    'close-failed': 'The device did not close cleanly.',
    'device-in-use': 'Another tab already owns the device session.',
    'locks-unavailable': 'This browser cannot guarantee a single device session.',
    unknown: 'An unexpected device error occurred.',
  };

  return new TransportError(code, messages[code], {
    ...detail,
    operation: detail?.operation ?? operation,
    errorName,
    errorMessage,
  });
}
