import type { CaptureEntry } from '../domain/capture-log';

export function displayEntries(entries: readonly CaptureEntry[], limit = 250): CaptureEntry[] {
  return [...entries].reverse().slice(0, limit);
}

export function formatUsbIds(vendorId?: number, productId?: number): string {
  if (vendorId === undefined || productId === undefined) return '—';
  return `0x${vendorId.toString(16).padStart(4, '0')}:0x${productId.toString(16).padStart(4, '0')}`;
}

export function stateLabel(value: string): string {
  const labels: Record<string, string> = {
    idle: 'Idle',
    connecting: 'Connecting',
    connected: 'Connected',
    error: 'Error',
    capturing: 'Capturing',
    captured: 'Captured',
    captureOnly: 'Capture only',
    failed: 'Failed',
    reading: 'Reading',
    read: 'Read',
    writing: 'Writing',
    updating: 'Updating',
    verified: 'Verified',
  };
  return labels[value] ?? value;
}

export function stateClass(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString([], {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  });
}
