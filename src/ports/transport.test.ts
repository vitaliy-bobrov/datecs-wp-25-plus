import { describe, expect, it } from 'vitest';
import { toTransportError, TransportError } from './transport';

describe('toTransportError', () => {
  it('preserves the browser error name, stage, device and sanitized message', () => {
    const raw = new DOMException('claim failed at /dev/bus/usb/001/002', 'NetworkError');
    const error = toTransportError(raw, 'webusb.open', {
      stage: 'claim-interface',
      device: { label: 'WP-25 Plus', vendorId: 0x1234, productId: 0x5678 },
      interfaceNumber: 1,
      alternateSetting: 0,
      endpointCount: 2,
    });

    expect(error.code).toBe('device-unavailable');
    expect(error.detail?.operation).toBe('webusb.open');
    expect(error.detail?.stage).toBe('claim-interface');
    expect(error.detail?.errorName).toBe('NetworkError');
    expect(error.detail?.errorMessage).toContain('<path>');
    expect(error.detail?.device?.vendorId).toBe(0x1234);
    expect(error.detail?.interfaceNumber).toBe(1);
    expect(error.detail?.endpointCount).toBe(2);
  });

  it('merges detail when a typed transport error already exists', () => {
    const original = new TransportError('device-unavailable', 'public message', {
      stage: 'open',
      device: { label: 'WP-25 Plus' },
    });
    const merged = toTransportError(original, 'session.connect');

    expect(merged.code).toBe('device-unavailable');
    expect(merged.message).toBe('public message');
    expect(merged.detail?.stage).toBe('open');
    expect(merged.detail?.operation).toBe('session.connect');
  });
});
