export function supportsWebSerial(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.serial);
}

export function supportsWebLocks(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.locks);
}
