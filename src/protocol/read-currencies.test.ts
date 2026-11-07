import { describe, expect, it } from 'vitest';
import { bccMatches, sumFromStxToEnq } from './preflight';
import {
  CONVERTER_READ_FRAMES,
  FOREIGN_READ_FRAMES,
  parseReadResponse,
  READ_LOCAL_FRAMES,
} from './read-currencies';

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

  it('decodes Polish full names from Windows-1250', () => {
    const fullName = parseReadResponse(
      response(
        '1601303034372b30303f3f3009646f6c617220616d6572796b61f1736b69090480808280869a808005303d393503',
      ),
    );
    expect(fullName?.fields).toEqual(['dolar amerykański']);
  });

  it('rejects a corrupted checksum', () => {
    const raw = response('01303033392330303f3f3009504c4e090480808280869a8080053037323403');
    raw[raw.length - 2] = 0x30;
    expect(parseReadResponse(raw)).toBeNull();
  });
});

describe('foreign read probe', () => {
  it('builds four Type2 read queries without 0xFF', () => {
    expect(FOREIGN_READ_FRAMES).toHaveLength(8);
    expect(FOREIGN_READ_FRAMES.map((frame) => frame.label)).toEqual([
      'slot0Name',
      'slot0Rate',
      'slot1Name',
      'slot1Rate',
      'slot0FullName',
      'slot0ChangeAfterZ',
      'slot1FullName',
      'slot1ChangeAfterZ',
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
    expect(new TextDecoder().decode(FOREIGN_READ_FRAMES[4]?.bytes)).toContain(
      'CurrFullNameForeign',
    );
    expect(new TextDecoder().decode(FOREIGN_READ_FRAMES[5]?.bytes)).toContain(
      'ForeignCurrChangeAfterZ',
    );
  });
});

describe('converter read', () => {
  it('builds three fixed Type2 queries without 0xFF', () => {
    expect(CONVERTER_READ_FRAMES).toHaveLength(3);
    expect(CONVERTER_READ_FRAMES.map((frame) => frame.label)).toEqual([
      'converterName',
      'converterRate',
      'converterPrint',
    ]);
    for (const { bytes: frame } of CONVERTER_READ_FRAMES) {
      expect(frame.includes(0xff)).toBe(false);
      const enq = frame.length - 6;
      expect(bccMatches(frame, enq + 1, sumFromStxToEnq(frame, enq))).toBe(true);
    }
    expect(new TextDecoder().decode(CONVERTER_READ_FRAMES[0]?.bytes)).toContain('NameConvertCurr');
    expect(new TextDecoder().decode(CONVERTER_READ_FRAMES[1]?.bytes)).toContain(
      'ExchangeRateConvetCurr',
    );
  });
});

describe('single-field full-name write test', () => {
  it('writes the same CP1250 full name with no 0xFF and a valid BCC', async () => {
    const { buildFullNameWrite, buildFullNameReadback } = await import('./read-currencies');
    const write = buildFullNameWrite('dolar amerykański');
    expect(write).not.toBeNull();
    const frame = write as Uint8Array;
    expect(frame.includes(0xff)).toBe(false);
    expect(frame.includes(0xf1)).toBe(true);
    const enq = frame.length - 6;
    expect(bccMatches(frame, enq + 1, sumFromStxToEnq(frame, enq))).toBe(true);
    const readback = buildFullNameReadback();
    expect(readback.includes(0xff)).toBe(false);
  });

  it('rejects unsupported characters', async () => {
    const { buildFullNameWrite } = await import('./read-currencies');
    expect(buildFullNameWrite('dolar €')).toBeNull();
  });
});
