import { describe, expect, it } from 'vitest';
import {
  PREFLIGHT_FRAME,
  parseLong,
  parseResponse,
  parseShort,
  sumFromStxToEnq,
  toAsciiNibble,
} from './preflight';

function nibbles(value: number, count: number): number[] {
  return Array.from({ length: count }, (_, index) => {
    const shift = (count - 1 - index) * 4;
    return toAsciiNibble((value >> shift) & 0x0f);
  });
}

function bcc(bytes: number[], enqIndex: number): number[] {
  return nibbles(sumFromStxToEnq(Uint8Array.from(bytes), enqIndex), 4);
}

function longFrame(data: number[], status: number[], sequence = 0x30, command = 0x0002): number[] {
  const length = data.length + 0x2a;
  const bytes = [
    0x01,
    ...nibbles(length, 4),
    sequence,
    ...nibbles(command, 4),
    ...data,
    0x04,
    ...status,
    0x05,
  ];
  return [...bytes, ...bcc(bytes, bytes.length - 1), 0x03];
}

function shortFrame(data: number[], status: number[], sequence = 0x30, command = 0x32): number[] {
  const length = (2 * data.length + 0x24) & 0xff;
  const bytes = [0x01, length, sequence, command, ...data, 0x04, ...status, 0x05];
  return [...bytes, ...bcc(bytes, bytes.length - 1), 0x03];
}

describe('preflight protocol', () => {
  it('uses the captured preflight frame exactly', () => {
    expect(Array.from(PREFLIGHT_FRAME)).toEqual([
      0x01, 0x30, 0x30, 0x32, 0x3a, 0x20, 0x30, 0x30, 0x34, 0x3a, 0x05, 0x30, 0x31, 0x3b, 0x3f,
      0x03,
    ]);
  });

  it('parses a long frame with eight status bytes', () => {
    const raw = Uint8Array.from(longFrame([0x41, 0x42], [0, 1, 2, 3, 4, 5, 6, 7]));
    const frame = parseLong(raw);

    expect(frame?.mode).toBe('long');
    expect(frame?.command).toBe(2);
    expect(Array.from(frame?.data ?? [])).toEqual([0x41, 0x42]);
    expect(Array.from(frame?.status ?? [])).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(parseResponse(raw).kind).toBe('valid');
  });

  it('parses a short frame with six status bytes', () => {
    const raw = Uint8Array.from(shortFrame([0x41], [0, 1, 2, 3, 4, 5]));
    const frame = parseShort(raw);

    expect(frame?.mode).toBe('short');
    expect(frame?.command).toBe(0x32);
    expect(Array.from(frame?.status ?? [])).toEqual([0, 1, 2, 3, 4, 5]);
    expect(parseResponse(raw).kind).toBe('valid');
  });

  it('parses the real 2026-11-07 Type2 preflight response', () => {
    const raw = Uint8Array.from(
      (
        '16013030333e203030343a300980808280869a8080090480808280869a808005303a343e03'.match(/../g) ??
        []
      ).map((byte) => Number.parseInt(byte, 16)),
    );
    const outcome = parseResponse(raw);

    expect(outcome.kind).toBe('valid');
    if (outcome.kind !== 'valid') return;
    expect(outcome.frame.mode).toBe('type2');
    expect(outcome.frame.header).toBe('003> 004:0');
    expect(outcome.frame.sequence).toBe(3);
    expect(outcome.frame.command).toBe(4);
    expect(outcome.frame.status).toHaveLength(8);
    expect(outcome.frame.secondaryStatus).toHaveLength(8);
    expect(Array.from(outcome.frame.status)).toEqual([
      0x80, 0x80, 0x82, 0x80, 0x86, 0x9a, 0x80, 0x80,
    ]);
  });

  it('reports ambiguity rather than guessing when two candidates validate', () => {
    const raw = Uint8Array.from(longFrame([], [0, 1, 2, 3, 4, 5]));
    expect(parseResponse(raw).kind).toBe('ambiguous');
  });

  it('rejects a corrupted BCC', () => {
    const raw = longFrame([], [0, 1, 2, 3, 4, 5]);
    raw[raw.length - 2] = 0x3f;
    expect(parseLong(Uint8Array.from(raw))).toBeNull();
    expect(parseResponse(Uint8Array.from(raw)).kind).toBe('invalid');
  });
});
