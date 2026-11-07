export function supportsWebSerial(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.serial);
}
