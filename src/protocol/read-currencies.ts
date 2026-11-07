import { toHex } from '../domain/capture-log';
import { bccMatches, sumFromStxToEnq, toAsciiNibble } from './preflight';

const DEVICE_TEXT = new TextDecoder('windows-1250');

type ReadFrameLabel =
  | 'init'
  | 'barcode'
  | 'localName'
  | 'currencyDate'
  | 'pgmLocalName'
  | 'pgmCurrencyDate';

export interface ReadFrame {
  label: ReadFrameLabel;
  bytes: Uint8Array;
}

export interface ReadResponse {
  header: string;
  fields: string[];
  status: Uint8Array;
  rawHex: string;
}

function fromHex(value: string): Uint8Array {
  return Uint8Array.from((value.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));
}

export const READ_LOCAL_FRAMES: ReadFrame[] = [
  { label: 'init', bytes: fromHex('01303033302130303636333009333009053032383d03') },
  {
    label: 'barcode',
    bytes: fromHex('013030333d2230303f3f4563724e756d626572426172636f6465090909053038323303'),
  },
  {
    label: 'localName',
    bytes: fromHex('013030333a2330303f3f437572724e616d654c6f63616c0909090530363f3603'),
  },
  {
    label: 'currencyDate',
    bytes: fromHex('013030333a2430303f3f63757272656e63795f64617465090909053037353703'),
  },
  {
    label: 'pgmLocalName',
    bytes: fromHex('013030333d2530303f3f50676d437572724e616d654c6f63616c090909053038313f03'),
  },
  {
    label: 'pgmCurrencyDate',
    bytes: fromHex('013030333d2630303f3f50676d43757272656e63795f64617465090909053038363003'),
  },
];

function nibbles(value: number): number[] {
  return Array.from({ length: 4 }, (_, index) => {
    const shift = (3 - index) * 4;
    return toAsciiNibble((value >> shift) & 0x0f);
  });
}

type ForeignReadFrameLabel =
  | 'slot0Name'
  | 'slot0Rate'
  | 'slot1Name'
  | 'slot1Rate'
  | 'slot0FullName'
  | 'slot0ChangeAfterZ'
  | 'slot1FullName'
  | 'slot1ChangeAfterZ';

export interface ForeignReadFrame {
  label: ForeignReadFrameLabel;
  bytes: Uint8Array;
}

function buildReadQuery(parameter: string, delimiter: number): Uint8Array {
  const data = new TextEncoder().encode(parameter);
  const prefix = [
    0x01,
    ...nibbles(data.length + 0x2a),
    delimiter,
    ...new TextEncoder().encode('00??'),
    ...data,
    0x05,
  ];
  const checksum = sumFromStxToEnq(Uint8Array.from(prefix), prefix.length - 1);
  return Uint8Array.from([...prefix, ...nibbles(checksum), 0x03]);
}

export const FOREIGN_READ_FRAMES: ForeignReadFrame[] = [
  { label: 'slot0Name', bytes: buildReadQuery('CurrNameForeign\t0\t\t', 0x27) },
  { label: 'slot0Rate', bytes: buildReadQuery('ExchangeRate\t0\t\t', 0x28) },
  { label: 'slot1Name', bytes: buildReadQuery('CurrNameForeign\t1\t\t', 0x29) },
  { label: 'slot1Rate', bytes: buildReadQuery('ExchangeRate\t1\t\t', 0x2a) },
  { label: 'slot0FullName', bytes: buildReadQuery('CurrFullNameForeign\t0\t\t', 0x2b) },
  { label: 'slot0ChangeAfterZ', bytes: buildReadQuery('ForeignCurrChangeAfterZ\t0\t\t', 0x2c) },
  { label: 'slot1FullName', bytes: buildReadQuery('CurrFullNameForeign\t1\t\t', 0x2d) },
  { label: 'slot1ChangeAfterZ', bytes: buildReadQuery('ForeignCurrChangeAfterZ\t1\t\t', 0x2e) },
];

export function parseReadResponse(input: Uint8Array): ReadResponse | null {
  let offset = 0;
  while (input[offset] === 0x16) offset += 1;
  const frame = offset > 0 ? input.slice(offset) : input;

  if (frame.length < 18 || frame[0] !== 0x01 || frame[frame.length - 1] !== 0x03) return null;

  const firstTab = frame.indexOf(0x09, 1);
  if (firstTab < 2) return null;

  const enq = frame.length - 6;
  const statusStart = enq - 8;
  const marker = statusStart - 1;
  if (marker <= firstTab || frame[marker] !== 0x04 || frame[enq] !== 0x05) return null;

  if (!bccMatches(frame, enq + 1, sumFromStxToEnq(frame, enq))) return null;

  const data = DEVICE_TEXT.decode(frame.slice(firstTab + 1, marker)).replace(/\t+$/, '');
  return {
    header: DEVICE_TEXT.decode(frame.slice(1, firstTab)),
    fields: data ? data.split('\t') : [],
    status: frame.slice(statusStart, enq),
    rawHex: toHex(input),
  };
}
