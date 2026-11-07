import { describe, expect, it } from 'vitest';
import { bccMatches, sumFromStxToEnq } from './preflight';
import { FOREIGN_READ_FRAMES, parseReadResponse, READ_LOCAL_FRAMES } from './read-currencies';

const response = (hex: string) =>
  Uint8Array.from((hex.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));

describe('local currency read protocol', () => {
  it('uses the exact six captured read queries and no programming command', () => {
    expect(READ_LOCAL_FRAMES).toHaveLength(6);
    expect(READ_LOCAL_FRAMES.map((frame) => frame.label)).toEqual([
      'init',
      'barcode',
      'localName',
      'currencyDate',
      'pgmLocalName',
      'pgmCurrencyDate',
    ]);
    expect(READ_LOCAL_FRAMES.every((frame) => !frame.bytes.includes(0xff))).toBe(true);
  });

  it('parses local name and date responses', () => {
    const name = parseReadResponse(
      response('01303033392330303f3f3009504c4e090480808280869a8080053037323403'),
    );
    const date = parseReadResponse(
      response(
        '01303034372430303f3f300930382d30332d32342030393a30383a3035090480808280869a8080053039383f03',
      ),
    );

    expect(name?.fields).toEqual(['PLN']);
    expect(name?.header).toContain('0039#');
    expect(date?.fields).toEqual(['08-03-24 09:08:05']);
  });

  it('rejects a corrupted checksum', () => {
    const raw = response('01303033392330303f3f3009504c4e090480808280869a8080053037323403');
    raw[raw.length - 2] = 0x30;
    expect(parseReadResponse(raw)).toBeNull();
  });
});

describe('foreign read probe', () => {
  it('builds four Type2 read queries without 0xFF', () => {
    expect(FOREIGN_READ_FRAMES).toHaveLength(4);
    expect(FOREIGN_READ_FRAMES.map((frame) => frame.label)).toEqual([
      'slot0Name',
      'slot0Rate',
      'slot1Name',
      'slot1Rate',
    ]);
    for (const { bytes: frame } of FOREIGN_READ_FRAMES) {
      expect(frame[0]).toBe(0x01);
      expect(frame[frame.length - 1]).toBe(0x03);
      expect(frame.includes(0xff)).toBe(false);
      const enq = frame.length - 6;
      expect(bccMatches(frame, enq + 1, sumFromStxToEnq(frame, enq))).toBe(true);
    }
    expect(new TextDecoder().decode(FOREIGN_READ_FRAMES[0]?.bytes)).toContain('CurrNameForeign');
    expect(new TextDecoder().decode(FOREIGN_READ_FRAMES[1]?.bytes)).toContain('ExchangeRate');
  });
});
