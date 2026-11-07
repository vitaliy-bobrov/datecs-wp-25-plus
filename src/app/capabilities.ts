import type { TransportKind } from '../ports/transport';

export function supportsTransport(kind: TransportKind): boolean {
  if (typeof navigator === 'undefined') return false;
  return kind === 'webusb' ? Boolean(navigator.usb) : Boolean(navigator.serial);
}

export function supportsWebLocks(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.locks);
}
