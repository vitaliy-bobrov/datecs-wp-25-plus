import { describe, expect, it } from 'vitest';
import { CaptureLog } from './capture-log';
import type { Clock } from '../ports/clock';

class FixedClock implements Clock {
  nowIso(): string {
    return '2026-11-06T08:00:00.000Z';
  }
}

describe('CaptureLog', () => {
  it('keeps the newest entries within the limit', () => {
    const log = new CaptureLog(new FixedClock(), 3);
    log.append({ kind: 'session', message: 'one' });
    log.append({ kind: 'session', message: 'two' });
    log.append({ kind: 'session', message: 'three' });
    const newest = log.append({ kind: 'session', message: 'four' });

    expect(log.snapshot()).toHaveLength(3);
    expect(log.snapshot()[0]?.message).toBe('two');
    expect(newest.id).toBe(4);
  });

  it('serializes exact bytes and a readable text view', () => {
    const log = new CaptureLog(new FixedClock());
    log.append({
      kind: 'connect',
      direction: 'rx',
      transport: 'webusb',
      device: 'WP-25 Plus',
      bytes: new Uint8Array([0x01, 0x30, 0xff]),
      message: 'Connected',
    });

    const entry = log.snapshot()[0];
    expect(entry?.bytesHex).toBe('0130ff');
    expect(entry?.ts).toBe('2026-11-06T08:00:00.000Z');
    expect(log.toJsonl()).toContain('"bytesHex":"0130ff"');
    expect(log.toText()).toContain('webusb\tWP-25 Plus\trx');
  });

  it('clears all entries', () => {
    const log = new CaptureLog(new FixedClock());
    log.append({ kind: 'session', message: 'one' });
    log.clear();
    expect(log.snapshot()).toHaveLength(0);
    expect(log.toJsonl()).toBe('');
  });
});
