import { toHex } from '../domain/capture-log';

export const PREFLIGHT_FRAME = Uint8Array.from([
  0x01, 0x30, 0x30, 0x32, 0x3a, 0x20, 0x30, 0x30, 0x34, 0x3a, 0x05, 0x30, 0x31, 0x3b, 0x3f, 0x03,
]);

type FrameMode = 'short' | 'long' | 'type2';

export interface ParsedFrame {
  mode: FrameMode;
  sequence: number;
  command: number;
  data: Uint8Array;
  status: Uint8Array;
  secondaryStatus?: Uint8Array;
  header?: string;
  preamble?: Uint8Array;
  rawHex: string;
}

interface ParseAttempt {
  mode: FrameMode;
  accepted: boolean;
  reason?: string;
}

export type ParseOutcome =
  | { kind: 'valid'; frame: ParsedFrame; attempts: ParseAttempt[] }
  | { kind: 'ambiguous'; frames: ParsedFrame[]; attempts: ParseAttempt[]; reason: string }
  | { kind: 'invalid'; attempts: ParseAttempt[]; reason: string };

export function toAsciiNibble(value: number): number {
  return 0x30 + (value & 0x0f);
}

function decodeNibbles(bytes: Uint8Array, start: number, count: number): number | null {
  let value = 0;
  for (let index = 0; index < count; index += 1) {
    const byte = bytes[start + index];
    if (byte === undefined || byte < 0x30 || byte > 0x3f) return null;
    value = (value << 4) | (byte - 0x30);
  }
  return value;
}

export function sumFromStxToEnq(bytes: Uint8Array, enqIndex: number): number {
  let sum = 0;
  for (let index = 1; index <= enqIndex; index += 1) sum += bytes[index] ?? 0;
  return sum & 0xffff;
}

export function bccMatches(bytes: Uint8Array, start: number, expected: number): boolean {
  if (start + 4 > bytes.length) return false;
  const decoded = decodeNibbles(bytes, start, 4);
  return decoded !== null && decoded === expected;
}

function frameEnvelope(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x01 && bytes[bytes.length - 1] === 0x03;
}

function validateStatusFrame(
  bytes: Uint8Array,
  statusStart: number,
  statusLength: number,
  dataStart: number,
  dataEnd: number,
): { status: Uint8Array; data: Uint8Array } | null {
  const marker = statusStart - 1;
  const enq = statusStart + statusLength;
  const bccStart = enq + 1;
  const etx = bccStart + 4;

  if (etx !== bytes.length - 1) return null;
  if (marker < dataStart || bytes[marker] !== 0x04) return null;
  if (bytes[enq] !== 0x05) return null;
  if (bytes[etx] !== 0x03) return null;

  const status = bytes.slice(statusStart, enq);
  const data = bytes.slice(dataStart, dataEnd);
  if (!bccMatches(bytes, bccStart, sumFromStxToEnq(bytes, enq))) return null;
  return { status, data };
}

export function parseLong(bytes: Uint8Array): ParsedFrame | null {
  if (!frameEnvelope(bytes) || bytes.length < 18) return null;
  if (bytes[1] === undefined) return null;

  const lengthValue = decodeNibbles(bytes, 1, 4);
  if (lengthValue === null || lengthValue < 0x2a) return null;

  const dataLength = lengthValue - 0x2a;
  const sequence = bytes[5];
  const command = decodeNibbles(bytes, 6, 4);
  if (sequence === undefined || command === null) return null;

  const dataStart = 10;
  const dataEnd = dataStart + dataLength;
  if (dataEnd + 1 > bytes.length) return null;

  for (const statusLength of [6, 8] as const) {
    const statusStart = dataEnd + 1;
    const validated = validateStatusFrame(bytes, statusStart, statusLength, dataStart, dataEnd);
    if (!validated) continue;
    return {
      mode: 'long',
      sequence,
      command,
      data: validated.data,
      status: validated.status,
      rawHex: toHex(bytes),
    };
  }
  return null;
}

export function parseShort(bytes: Uint8Array): ParsedFrame | null {
  if (!frameEnvelope(bytes) || bytes.length < 14) return null;

  const shortLength = bytes[1];
  const sequence = bytes[2];
  const command = bytes[3];
  if (shortLength === undefined || sequence === undefined || command === undefined) return null;

  const dataStart = 4;

  for (const statusLength of [6, 8] as const) {
    for (let marker = dataStart; marker < bytes.length - statusLength - 6; marker += 1) {
      if (bytes[marker] !== 0x04) continue;
      const statusStart = marker + 1;
      const validated = validateStatusFrame(bytes, statusStart, statusLength, dataStart, marker);
      if (!validated) continue;

      const dataLength = marker - dataStart;
      const expectedLength = (2 * dataLength + 0x24) & 0xff;
      if (shortLength !== expectedLength) continue;

      return {
        mode: 'short',
        sequence,
        command,
        data: validated.data,
        status: validated.status,
        rawHex: toHex(bytes),
      };
    }
  }
  return null;
}

function parseType2(input: Uint8Array): ParsedFrame | null {
  let frame = input;
  let preamble = new Uint8Array();
  let offset = 0;
  while (frame[offset] === 0x16) offset += 1;
  if (offset > 0) {
    preamble = frame.slice(0, offset);
    frame = frame.slice(offset);
  }

  if (frame.length < 20 || frame[0] !== 0x01 || frame[frame.length - 1] !== 0x03) return null;

  const firstTab = frame.indexOf(0x09, 1);
  const secondTab = firstTab >= 0 ? frame.indexOf(0x09, firstTab + 1) : -1;
  if (firstTab < 2 || secondTab < 0) return null;

  const enq = frame.length - 6;
  const bccStart = enq + 1;
  if (frame[enq] !== 0x05 || frame[secondTab + 1] !== 0x04) return null;
  if (bccStart + 4 !== frame.length - 1) return null;

  const status = frame.slice(firstTab + 1, secondTab);
  const secondaryStatus = frame.slice(secondTab + 2, enq);
  if (status.length !== 8 || secondaryStatus.length !== 8) return null;

  const headerBytes = frame.slice(1, firstTab);
  const header = new TextDecoder().decode(headerBytes);
  const tokens = header.split(' ');
  if (tokens.length !== 2) return null;

  const sequenceMatch = /^(\d{3})>$/.exec(tokens[0] ?? '');
  const commandMatch = /^(\d{3}):(.*)$/.exec(tokens[1] ?? '');
  if (!sequenceMatch || !commandMatch) return null;

  const sequence = Number(sequenceMatch[1]);
  const command = Number(commandMatch[1]);
  if (!Number.isInteger(sequence) || !Number.isInteger(command)) return null;

  if (!bccMatches(frame, bccStart, sumFromStxToEnq(frame, enq))) return null;

  return {
    mode: 'type2',
    sequence,
    command,
    data: new TextEncoder().encode(commandMatch[2] ?? ''),
    status,
    secondaryStatus,
    header,
    preamble,
    rawHex: toHex(input),
  };
}

export function parseResponse(bytes: Uint8Array): ParseOutcome {
  const attempts: ParseAttempt[] = [];
  const frames: ParsedFrame[] = [];

  const long = parseLong(bytes);
  attempts.push({
    mode: 'long',
    accepted: long !== null,
    reason: long ? undefined : 'long frame envelope/length/BCC/status did not validate',
  });
  if (long) frames.push(long);

  const short = parseShort(bytes);
  attempts.push({
    mode: 'short',
    accepted: short !== null,
    reason: short ? undefined : 'short frame envelope/length/BCC/status did not validate',
  });
  if (short) frames.push(short);

  const type2 = parseType2(bytes);
  attempts.push({
    mode: 'type2',
    accepted: type2 !== null,
    reason: type2 ? undefined : 'type2 ASCII/BCC/status shape did not validate',
  });
  if (type2) frames.push(type2);

  if (frames.length === 1) {
    const frame = frames[0];
    if (!frame) {
      return { kind: 'invalid', attempts, reason: 'no candidate validated' };
    }
    return { kind: 'valid', frame, attempts };
  }
  if (frames.length > 1) {
    return {
      kind: 'ambiguous',
      frames,
      attempts,
      reason: 'both short and long candidates validated',
    };
  }
  return {
    kind: 'invalid',
    attempts,
    reason: bytes.length === 0 ? 'no response bytes' : 'no candidate validated',
  };
}
