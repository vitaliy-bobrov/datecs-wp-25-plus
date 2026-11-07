import { describe, expect, it } from 'vitest';
import { displayEntries, formatTimestamp, formatUsbIds, stateClass, stateLabel } from './log-view';

const entries = Array.from({ length: 5 }, (_, index) => ({
  id: index + 1,
  ts: '2026-11-07T10:00:00.000Z',
  kind: 'info' as const,
}));

describe('log view helpers', () => {
  it('shows newest first and caps the viewport', () => {
    expect(displayEntries(entries, 3).map((entry) => entry.id)).toEqual([5, 4, 3]);
  });

  it('formats USB IDs with four-digit padding', () => {
    expect(formatUsbIds(0xfff0, 0x0100)).toBe('0xfff0:0x0100');
    expect(formatUsbIds(0x483, 0x5740)).toBe('0x0483:0x5740');
    expect(formatUsbIds()).toBe('—');
  });

  it('formats an unambiguous timestamp without throwing', () => {
    const value = formatTimestamp('2026-11-07T10:00:00.000Z');
    expect(value).toContain('2026');
    expect(value).not.toBe('Invalid Date');
  });

  it('humanizes state names and makes stable classes', () => {
    expect(stateLabel('captureOnly')).toBe('Capture only');
    expect(stateClass('captureOnly')).toBe('capture-only');
    expect(stateClass('connected')).toBe('connected');
  });
});
