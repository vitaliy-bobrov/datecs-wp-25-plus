import type { Clock } from '../ports/clock';
import type { TransportKind } from '../ports/transport';

type CaptureKind = 'session' | 'connect' | 'disconnect' | 'info' | 'error' | 'tx' | 'rx';

export interface CaptureEntry {
  id: number;
  ts: string;
  kind: CaptureKind;
  direction?: 'tx' | 'rx';
  transport?: TransportKind;
  device?: string;
  bytesHex?: string;
  code?: string;
  message?: string;
  stage?: string;
  errorName?: string;
  errorMessage?: string;
  detail?: Record<string, unknown>;
}

export interface CaptureInput {
  kind: CaptureKind;
  direction?: 'tx' | 'rx';
  transport?: TransportKind;
  device?: string;
  bytes?: Uint8Array;
  code?: string;
  message?: string;
  stage?: string;
  errorName?: string;
  errorMessage?: string;
  detail?: Record<string, unknown>;
}

const DEFAULT_LIMIT = 2000;

export class CaptureLog {
  private readonly entries: CaptureEntry[] = [];
  private nextId = 1;

  constructor(
    private readonly clock: Clock,
    private readonly limit = DEFAULT_LIMIT,
  ) {}

  append(input: CaptureInput): CaptureEntry {
    const entry: CaptureEntry = {
      id: this.nextId,
      ts: this.clock.nowIso(),
      kind: input.kind,
      direction: input.direction,
      transport: input.transport,
      device: input.device,
      bytesHex: input.bytes && input.bytes.length > 0 ? toHex(input.bytes) : undefined,
      code: input.code,
      message: input.message,
      stage: input.stage,
      errorName: input.errorName,
      errorMessage: input.errorMessage,
      detail: input.detail,
    };
    this.nextId += 1;
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    return entry;
  }

  clear(): void {
    this.entries.splice(0, this.entries.length);
  }

  snapshot(): readonly CaptureEntry[] {
    return this.entries.slice();
  }

  toJsonl(): string {
    return this.entries.map((entry) => JSON.stringify(entry)).join('\n');
  }

  toText(): string {
    return this.entries
      .map((entry) => {
        const parts = [
          entry.ts,
          entry.kind,
          entry.transport ?? '-',
          entry.device ?? '-',
          entry.direction ?? '-',
          entry.bytesHex ?? '-',
          entry.code ?? '-',
          cell(entry.message),
          entry.stage ?? '-',
          entry.errorName ?? '-',
          cell(entry.errorMessage),
          entry.detail ? JSON.stringify(entry.detail) : '-',
        ];
        return parts.join('\t');
      })
      .join('\n');
  }
}

function cell(value: string | undefined): string {
  return (value ?? '-').replace(/[\t\r\n]/g, ' ');
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
}
