import { describe, expect, it } from 'vitest';
import { parseReadResponse, READ_LOCAL_FRAMES } from './read-currencies';

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
