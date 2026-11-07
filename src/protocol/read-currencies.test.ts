import { describe, expect, it } from 'vitest';
import { toHex } from '../domain/capture-log';
import { bccMatches, sumFromStxToEnq } from './preflight';
import {
  buildRateReadback,
  buildRateWrite,
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

  it('matches the captured local frame bytes exactly', () => {
    expect(READ_LOCAL_FRAMES.map((frame) => toHex(frame.bytes))).toEqual([
      '01303033302130303636333009333009053032383d03',
      '013030333d2230303f3f4563724e756d626572426172636f6465090909053038323303',
      '013030333a2330303f3f437572724e616d654c6f63616c0909090530363f3603',
      '013030333a2430303f3f63757272656e63795f64617465090909053037353703',
      '013030333d2530303f3f50676d437572724e616d654c6f63616c090909053038313f03',
      '013030333d2630303f3f50676d43757272656e63795f64617465090909053038363003',
    ]);
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
  it('builds the eight foreign Type2 read queries without 0xFF', () => {
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
  it('matches the captured foreign and converter frame bytes', () => {
    expect(toHex(FOREIGN_READ_FRAMES[0]?.bytes as Uint8Array)).toBe(
      '013030333d2730303f3f437572724e616d65466f726569676e09300909053038303c03',
    );
    expect(toHex(CONVERTER_READ_FRAMES[0]?.bytes as Uint8Array)).toBe(
      '013030333c2f30303f3f4e616d65436f6e76657274437572720909090530373f3a03',
    );
  });

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

  it('matches the expected full-name write frame', async () => {
    const { buildFullNameWrite } = await import('./read-currencies');
    expect(toHex(buildFullNameWrite('dolar amerykański') as Uint8Array)).toBe(
      '01303035323230303f3f4375727246756c6c4e616d65466f726569676e093009646f6c617220616d6572796b61f1736b69090531303f3503',
    );
  });

  it('rejects unsupported characters', async () => {
    const { buildFullNameWrite } = await import('./read-currencies');
    expect(buildFullNameWrite('dolar €')).toBeNull();
  });
});

describe('single-rate write test', () => {
  it('builds a rate write and readback without 0xFF', () => {
    const write = buildRateWrite('39252');
    const readback = buildRateReadback();
    expect(write.includes(0xff)).toBe(false);
    expect(readback.includes(0xff)).toBe(false);
    const enq = write.length - 6;
    expect(bccMatches(write, enq + 1, sumFromStxToEnq(write, enq))).toBe(true);
    expect(toHex(write)).toBe(
      '013030333f3230303f3f45786368616e6765526174650930093339323532090530373e3603',
    );
    expect(new TextDecoder().decode(write)).toContain('ExchangeRate');
  });
});
