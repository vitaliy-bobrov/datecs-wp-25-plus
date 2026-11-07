import type { CaptureEntry, CaptureInput } from '../domain/capture-log';

export interface CapturePort {
  append(input: CaptureInput): CaptureEntry;
  clear(): void;
  snapshot(): readonly CaptureEntry[];
  toJsonl(): string;
  toText(): string;
}
