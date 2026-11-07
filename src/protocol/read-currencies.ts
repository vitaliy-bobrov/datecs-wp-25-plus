import { toHex } from '../domain/capture-log';
import { bccMatches, sumFromStxToEnq, toAsciiNibble } from './preflight';

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

export function buildForeignNameProbe(): Uint8Array {
  const data = new TextEncoder().encode('CurrNameForeign\t0\t\t');
  const prefix = [
    0x01,
    ...nibbles(data.length + 0x2a),
    0x27,
    ...new TextEncoder().encode('00??'),
    ...data,
    0x05,
  ];
  const checksum = sumFromStxToEnq(Uint8Array.from(prefix), prefix.length - 1);
  return Uint8Array.from([...prefix, ...nibbles(checksum), 0x03]);
}

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

  const data = new TextDecoder().decode(frame.slice(firstTab + 1, marker)).replace(/\t+$/, '');
  return {
    header: new TextDecoder().decode(frame.slice(1, firstTab)),
    fields: data ? data.split('\t') : [],
    status: frame.slice(statusStart, enq),
    rawHex: toHex(input),
  };
}
