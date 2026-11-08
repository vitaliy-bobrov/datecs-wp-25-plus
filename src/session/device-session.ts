import type { CaptureEntry, CaptureLog } from '../domain/capture-log';
import { toHex } from '../domain/capture-log';
import type { FullUpdateResult, UpdateTargets, UpdateValues } from '../domain/update-plan';
import type { DeviceLock } from '../ports/device-lock';
import {
  type DeviceTransport,
  TransportError,
  type TransportErrorCode,
  type TransportErrorDetail,
  type TransportInfo,
  type TransportKind,
  type TransportSelector,
  toTransportError,
} from '../ports/transport';
import { PREFLIGHT_FRAME, parseResponse } from '../protocol/preflight';
import type { ReadResponse } from '../protocol/read-currencies';
import {
  buildConverterRateReadback,
  buildConverterRateWrite,
  buildPrintFlagReadback,
  buildPrintFlagWrite,
  buildRateReadback,
  buildRateWrite,
  CONVERTER_READ_FRAMES,
  FOREIGN_READ_FRAMES,
  parseReadResponse,
  READ_LOCAL_FRAMES,
} from '../protocol/read-currencies';

type SessionPhase = 'idle' | 'connecting' | 'connected' | 'error';
type LockState = 'idle' | 'acquiring' | 'held' | 'in-use' | 'unavailable';
type CaptureState = 'idle' | 'capturing' | 'captured' | 'captureOnly' | 'failed';

interface SessionError {
  code: TransportErrorCode | 'unknown';
  message: string;
  detail?: TransportErrorDetail;
}

interface PreflightResult {
  status: 'captured' | 'captureOnly' | 'failed';
  mode?: 'short' | 'long' | 'type2';
  statusHex?: string;
  secondaryStatusHex?: string;
  rawHex?: string;
  txHex?: string;
  attempts?: number;
  elapsedMs?: number;
  reason?: string;
}

type ReadState = 'idle' | 'reading' | 'read' | 'failed';

type ForeignReadState = 'idle' | 'reading' | 'read' | 'failed';

type ConverterReadState = 'idle' | 'reading' | 'read' | 'failed';
type WriteTestState = 'idle' | 'writing' | 'verified' | 'failed';
type UpdateState = 'idle' | 'updating' | 'verified' | 'failed';

interface WriteTestResult {
  field: string;
  original: string;
  temporary: string;
  temporaryReadback?: string;
  restoredReadback?: string;
  restored: boolean;
  message?: string;
}

interface ConverterReadResult {
  name?: string;
  rate?: string;
  printFlag?: string;
  rawFrames?: string[];
}

interface ForeignReadResult {
  slot0Name?: string;
  slot0Rate?: string;
  slot1Name?: string;
  slot1Rate?: string;
  slot0FullName?: string;
  slot0ChangeAfterZ?: string;
  slot1FullName?: string;
  slot1ChangeAfterZ?: string;
  rawFrames?: string[];
}

interface LastRead {
  foreignRead: ForeignReadResult;
  converterRead: ConverterReadResult;
  at: string;
}

export interface SessionSnapshot {
  phase: SessionPhase;
  lockState: LockState;
  transportKind?: TransportKind;
  info?: TransportInfo;
  error?: SessionError;
  captureState: CaptureState;
  readState: ReadState;
  foreignReadState: ForeignReadState;
  converterReadState: ConverterReadState;
  writeTestState: WriteTestState;
  updateState: UpdateState;
  updateResult?: FullUpdateResult;
  preflight?: PreflightResult;
  foreignRead?: ForeignReadResult;
  converterRead?: ConverterReadResult;
  lastRead?: LastRead;
  writeTest?: WriteTestResult;
  capture: readonly CaptureEntry[];
}

const READ_TIMEOUT_MS = 500;

const PUBLIC_ERROR: Record<TransportErrorCode, string> = {
  unsupported: 'This browser or device does not support the selected transport.',
  'permission-denied': 'Device permission was not granted.',
  cancelled: 'No device was selected.',
  'device-unavailable': 'The device is unavailable or disconnected.',
  'protocol-error': 'The device response was not a valid protocol frame.',
  'open-failed': 'The device could not be opened.',
  'close-failed': 'The device did not close cleanly.',
  'device-in-use': 'Another tab already owns the device session.',
  'locks-unavailable': 'This browser cannot guarantee a single device session.',
  timeout: 'The device did not respond in time.',
  unknown: 'An unexpected device error occurred.',
};

function environmentDetail(): TransportErrorDetail {
  if (typeof navigator === 'undefined') return {};
  return {
    appVersion: __APP_VERSION__,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
  };
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.length + right.length);
  merged.set(left);
  merged.set(right, left.length);
  return merged;
}

function responseMatchesRequest(header: string, request: Uint8Array): boolean {
  return header.length >= 5 && header[4] === String.fromCharCode(request[5] ?? 0);
}

export class DeviceSession {
  private snapshot: SessionSnapshot = {
    phase: 'idle',
    lockState: 'idle',
    captureState: 'idle',
    readState: 'idle',
    foreignReadState: 'idle',
    converterReadState: 'idle',
    writeTestState: 'idle',
    updateState: 'idle',
    capture: [],
  };

  private readonly listeners = new Set<() => void>();
  private transport: DeviceTransport | null = null;

  private preflightGeneration = 0;
  private writeDelimiter = 0x32;

  constructor(
    private readonly selector: TransportSelector,
    private readonly capture: CaptureLog,
    private readonly lock: DeviceLock,
    private readonly retryDelayMs = 3000,
  ) {}

  getSnapshot = (): SessionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async acquireLock(): Promise<void> {
    if (this.snapshot.lockState === 'acquiring' || this.snapshot.lockState === 'held') return;
    this.set({ lockState: 'acquiring' });

    const acquired = await this.lock.acquire();
    if (acquired) {
      this.set({ lockState: 'held' });
      return;
    }

    this.set({ lockState: this.lock.supported ? 'in-use' : 'unavailable' });
  }

  async connect(kind: TransportKind = 'webserial'): Promise<void> {
    if (this.snapshot.phase === 'connecting' || this.snapshot.phase === 'connected') return;

    if (this.snapshot.lockState !== 'held') {
      this.fail(
        new TransportError(
          this.snapshot.lockState === 'unavailable' ? 'locks-unavailable' : 'device-in-use',
          this.snapshot.lockState === 'unavailable'
            ? PUBLIC_ERROR['locks-unavailable']
            : PUBLIC_ERROR['device-in-use'],
          { operation: 'session.lock', stage: 'acquire-lock', ...environmentDetail() },
        ),
      );
      return;
    }

    const environment = environmentDetail();
    const generation = ++this.preflightGeneration;
    this.writeDelimiter = 0x32;
    this.set({
      phase: 'connecting',
      transportKind: kind,
      captureState: 'idle',
      readState: 'idle',
      foreignReadState: 'idle',
      converterReadState: 'idle',
      writeTestState: 'idle',
      updateState: 'idle',
      updateResult: undefined,
      preflight: undefined,
      foreignRead: undefined,
      converterRead: undefined,
      lastRead: undefined,
      writeTest: undefined,
      error: undefined,
    });
    this.append({
      kind: 'session',
      transport: kind,
      message: 'Connecting',
      detail: environment as Record<string, unknown>,
    });

    let transport: DeviceTransport | null = null;
    try {
      transport = await this.selector.select(kind);
      let info: TransportInfo;
      try {
        info = await transport.open();
      } catch (error) {
        const firstError = toTransportError(error, 'session.connect', environment);
        const canRetryPicker =
          kind === 'webserial' &&
          (firstError.code === 'device-unavailable' || firstError.code === 'open-failed');
        if (!canRetryPicker) throw error;

        this.append({
          kind: 'info',
          transport: kind,
          message: 'Saved device could not open; opening the device picker.',
          detail: {
            code: firstError.code,
            stage: firstError.detail?.stage,
            errorName: firstError.detail?.errorName,
            errorMessage: firstError.detail?.errorMessage,
            ...environment,
          },
        });
        await transport.close().catch(() => undefined);
        transport = await this.selector.select(kind, { preferSaved: false });
        info = await transport.open();
      }

      if (generation !== this.preflightGeneration) {
        await transport.close().catch(() => undefined);
        return;
      }
      this.transport = transport;
      this.set({
        phase: 'connected',
        transportKind: kind,
        info,
      });
      this.append({
        kind: 'connect',
        transport: kind,
        device: info.label,
        message: 'Connected',
        detail: { ...info, ...environment },
      });
    } catch (error) {
      if (transport) await transport.close().catch(() => undefined);
      if (generation !== this.preflightGeneration) return;
      const transportError = toTransportError(error, 'session.connect', environment);
      this.fail(transportError);
    }
  }

  async disconnect(): Promise<void> {
    this.preflightGeneration += 1;
    const transport = this.transport;
    this.transport = null;

    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        const transportError = toTransportError(error, 'session.disconnect');
        this.append({
          kind: 'error',
          code: transportError.code,
          message: PUBLIC_ERROR[transportError.code],
          stage: transportError.detail?.stage,
          errorName: transportError.detail?.errorName,
          errorMessage: transportError.detail?.errorMessage,
          detail: transportError.detail as Record<string, unknown> | undefined,
        });
      }
    }

    this.append({ kind: 'disconnect', message: 'Disconnected' });
    this.set({
      phase: 'idle',
      info: undefined,
      transportKind: undefined,
      error: undefined,
      captureState: 'idle',
      readState: 'idle',
      foreignReadState: 'idle',
      converterReadState: 'idle',
      writeTestState: 'idle',
      updateState: 'idle',
      updateResult: undefined,
      preflight: undefined,
      foreignRead: undefined,
      converterRead: undefined,
      lastRead: undefined,
      writeTest: undefined,
    });
  }

  private readIsReady(): boolean {
    return this.snapshot.readState === 'read';
  }

  private isDeviceBusy(): boolean {
    const snapshot = this.snapshot;
    return (
      snapshot.captureState === 'capturing' ||
      snapshot.readState === 'reading' ||
      snapshot.foreignReadState === 'reading' ||
      snapshot.converterReadState === 'reading' ||
      snapshot.writeTestState === 'writing' ||
      snapshot.updateState === 'updating'
    );
  }

  async runPreflight(): Promise<void> {
    const transport = this.transport;
    if (this.snapshot.phase !== 'connected' || !transport || this.isDeviceBusy()) {
      return;
    }

    const generation = ++this.preflightGeneration;
    this.writeDelimiter = 0x32;
    const startedAt = Date.now();
    let attempts = 0;
    const environment = environmentDetail();
    const transportKind = this.snapshot.transportKind ?? 'webserial';
    this.set({
      captureState: 'capturing',
      readState: 'idle',
      foreignReadState: 'idle',
      converterReadState: 'idle',
      writeTestState: 'idle',
      updateState: 'idle',
      updateResult: undefined,
      preflight: undefined,
      foreignRead: undefined,
      converterRead: undefined,
      writeTest: undefined,
    });

    try {
      await transport.flushInput();
    } catch (error) {
      this.failPreflight(toTransportError(error, 'preflight.flush'), environment);
      return;
    }

    let lastRaw: Uint8Array = new Uint8Array();

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      attempts = attempt;
      if (attempt > 1) {
        await new Promise<void>((resolve) => setTimeout(resolve, this.retryDelayMs));
        if (!this.isCurrentPreflight(transport, generation)) return;
      }

      try {
        await transport.write(PREFLIGHT_FRAME);
      } catch (error) {
        this.failPreflight(toTransportError(error, 'preflight.write'), environment);
        return;
      }

      this.append({
        kind: 'tx',
        direction: 'tx',
        transport: transportKind,
        bytes: PREFLIGHT_FRAME,
        message: attempt === 1 ? 'Preflight tx' : 'Preflight tx (NAK retry)',
      });

      let attemptRaw: Uint8Array;
      try {
        attemptRaw = await this.readPreflight(transport, transportKind, generation);
      } catch (error) {
        const transportError = toTransportError(error, 'preflight.read');
        if (!this.isCurrentPreflight(transport, generation)) return;
        this.failPreflight(transportError, environment);
        return;
      }

      if (!this.isCurrentPreflight(transport, generation)) return;
      lastRaw = attemptRaw;

      if (attemptRaw.includes(0x15) && attempt === 1) {
        this.append({
          kind: 'info',
          transport: transportKind,
          message: 'NAK received; retrying preflight once',
          detail: { bytesHex: toHex(attemptRaw) },
        });
        continue;
      }
      break;
    }

    if (lastRaw.length === 0) {
      this.append({
        kind: 'error',
        code: 'timeout',
        message: 'No preflight response within 500 ms.',
        stage: 'timeout',
        detail: { operation: 'preflight.read', stage: 'timeout' },
      });
      this.set({
        captureState: 'failed',
        preflight: { status: 'failed', reason: 'No response within 500 ms' },
      });
      return;
    }

    const outcome = parseResponse(lastRaw);
    if (outcome.kind === 'valid') {
      const result: PreflightResult = {
        status: 'captured',
        mode: outcome.frame.mode,
        statusHex: toHex(outcome.frame.status),
        secondaryStatusHex: outcome.frame.secondaryStatus
          ? toHex(outcome.frame.secondaryStatus)
          : undefined,
        rawHex: toHex(lastRaw),
        txHex: toHex(PREFLIGHT_FRAME),
        attempts,
        elapsedMs: Date.now() - startedAt,
      };
      this.append({
        kind: 'info',
        transport: transportKind,
        message: `Preflight captured (${outcome.frame.mode})`,
        detail: {
          mode: outcome.frame.mode,
          statusHex: result.statusHex,
          secondaryStatusHex: result.secondaryStatusHex,
          header: outcome.frame.header,
          rawHex: result.rawHex,
          attempts: outcome.attempts,
          ...environment,
        },
      });
      this.set({ captureState: 'captured', preflight: result });
      return;
    }

    this.append({
      kind: 'info',
      transport: transportKind,
      message: 'Preflight capture-only',
      detail: {
        reason: outcome.reason,
        rawHex: toHex(lastRaw),
        attempts: outcome.attempts,
        ...environment,
      },
    });
    this.set({
      captureState: 'captureOnly',
      preflight: {
        status: 'captureOnly',
        rawHex: toHex(lastRaw),
        txHex: toHex(PREFLIGHT_FRAME),
        attempts,
        elapsedMs: Date.now() - startedAt,
        reason: outcome.reason,
      },
    });
  }

  private isCurrentPreflight(transport: DeviceTransport, generation: number): boolean {
    return (
      generation === this.preflightGeneration &&
      this.transport === transport &&
      this.snapshot.phase === 'connected'
    );
  }

  private async readPreflight(
    transport: DeviceTransport,
    transportKind: TransportKind,
    generation: number,
  ): Promise<Uint8Array> {
    let raw: Uint8Array = new Uint8Array();
    const deadline = Date.now() + READ_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (!this.isCurrentPreflight(transport, generation)) return raw;
      const remaining = Math.max(1, deadline - Date.now());
      let chunk: Uint8Array;
      try {
        chunk = await transport.readChunk(remaining);
      } catch (error) {
        const transportError = toTransportError(error, 'preflight.read');
        if (transportError.code === 'timeout') break;
        throw transportError;
      }
      if (!this.isCurrentPreflight(transport, generation)) return raw;
      if (chunk.length === 0) continue;
      raw = concatBytes(raw, chunk);
      this.append({
        kind: 'rx',
        direction: 'rx',
        transport: transportKind,
        bytes: chunk,
        message: 'Preflight rx',
      });
      if (chunk.includes(0x15)) break;
      if (parseResponse(raw).kind === 'valid') break;
      if (raw.length > 512) break;
    }
    return raw;
  }

  async runReadLocal(): Promise<void> {
    const transport = this.transport;
    if (
      this.snapshot.phase !== 'connected' ||
      !transport ||
      this.snapshot.transportKind !== 'webserial' ||
      this.snapshot.captureState !== 'captured' ||
      this.isDeviceBusy()
    ) {
      return;
    }

    const generation = this.preflightGeneration;
    const transportKind = this.snapshot.transportKind;
    const environment = environmentDetail();
    this.set({
      readState: 'reading',
      foreignReadState: 'idle',
      converterReadState: 'idle',
      writeTestState: 'idle',
      updateState: 'idle',
      updateResult: undefined,
      foreignRead: undefined,
      converterRead: undefined,
      writeTest: undefined,
    });

    const results = await this.readFrameSequence(
      READ_LOCAL_FRAMES,
      transport,
      transportKind,
      generation,
      'Read local',
      'local-read',
    );
    if (!this.isCurrentPreflight(transport, generation)) return;
    if (!results) {
      this.set({ readState: 'failed' });
      return;
    }

    this.append({
      kind: 'info',
      transport: transportKind,
      message: 'Local read bootstrap complete',
      detail: {
        rawFrames: results.map((result) => result.parsed.rawHex),
        ...environment,
      },
    });
    this.set({ readState: 'read' });
  }

  async runReadForeign(): Promise<void> {
    const transport = this.transport;
    if (
      this.snapshot.phase !== 'connected' ||
      !transport ||
      this.snapshot.transportKind !== 'webserial' ||
      this.snapshot.captureState !== 'captured' ||
      this.isDeviceBusy()
    ) {
      return;
    }

    if (!this.readIsReady()) {
      await this.runReadLocal();
      if (this.snapshot.phase !== 'connected' || !this.readIsReady()) return;
    }

    const generation = this.preflightGeneration;
    const transportKind = this.snapshot.transportKind;
    const environment = environmentDetail();
    this.set({
      foreignReadState: 'reading',
      converterReadState: 'idle',
      writeTestState: 'idle',
      updateState: 'idle',
      updateResult: undefined,
      foreignRead: undefined,
      converterRead: undefined,
      writeTest: undefined,
    });

    const results = await this.readFrameSequence(
      FOREIGN_READ_FRAMES,
      transport,
      transportKind,
      generation,
      'Read foreign',
      'foreign-read',
    );
    if (!this.isCurrentPreflight(transport, generation)) return;
    if (!results) {
      this.set({ foreignReadState: 'failed' });
      return;
    }

    const foreign: ForeignReadResult = { rawFrames: [] };
    for (const { label, parsed } of results) {
      foreign.rawFrames?.push(parsed.rawHex);
      const value = parsed.fields[0];
      if (value === undefined) continue;
      switch (label) {
        case 'slot0Name':
          foreign.slot0Name = value;
          break;
        case 'slot0Rate':
          foreign.slot0Rate = value;
          break;
        case 'slot1Name':
          foreign.slot1Name = value;
          break;
        case 'slot1Rate':
          foreign.slot1Rate = value;
          break;
        case 'slot0FullName':
          foreign.slot0FullName = value;
          break;
        case 'slot0ChangeAfterZ':
          foreign.slot0ChangeAfterZ = value;
          break;
        case 'slot1FullName':
          foreign.slot1FullName = value;
          break;
        case 'slot1ChangeAfterZ':
          foreign.slot1ChangeAfterZ = value;
          break;
        default:
          break;
      }
    }

    this.append({
      kind: 'info',
      transport: transportKind,
      message: 'Foreign slot values read',
      detail: { ...foreign, ...environment } as Record<string, unknown>,
    });
    this.set({ foreignReadState: 'read', foreignRead: foreign });
  }

  async runReadConverter(): Promise<void> {
    const transport = this.transport;
    if (
      this.snapshot.phase !== 'connected' ||
      !transport ||
      this.snapshot.transportKind !== 'webserial' ||
      this.snapshot.foreignReadState !== 'read' ||
      this.snapshot.converterReadState === 'reading' ||
      this.snapshot.writeTestState === 'writing'
    ) {
      return;
    }

    const generation = this.preflightGeneration;
    const transportKind = this.snapshot.transportKind;
    const environment = environmentDetail();
    this.set({
      converterReadState: 'reading',
      writeTestState: 'idle',
      updateState: 'idle',
      updateResult: undefined,
      converterRead: undefined,
      writeTest: undefined,
    });

    const results = await this.readFrameSequence(
      CONVERTER_READ_FRAMES,
      transport,
      transportKind,
      generation,
      'Read converter',
      'converter-read',
    );
    if (!this.isCurrentPreflight(transport, generation)) return;
    if (!results) {
      this.set({ converterReadState: 'failed' });
      return;
    }

    const converter: ConverterReadResult = { rawFrames: [] };
    for (const { label, parsed } of results) {
      converter.rawFrames?.push(parsed.rawHex);
      const value = parsed.fields[0];
      if (value === undefined) continue;
      switch (label) {
        case 'converterName':
          converter.name = value;
          break;
        case 'converterRate':
          converter.rate = value;
          break;
        case 'converterPrint':
          converter.printFlag = value;
          break;
        default:
          break;
      }
    }

    const foreignRead = this.snapshot.foreignRead;
    if (!foreignRead) {
      this.set({ converterReadState: 'failed' });
      return;
    }

    this.append({
      kind: 'info',
      transport: transportKind,
      message: 'Converter values read',
      detail: { ...converter, ...environment } as Record<string, unknown>,
    });
    this.writeDelimiter = 0x32;
    this.set({
      converterReadState: 'read',
      converterRead: converter,
      lastRead: {
        foreignRead,
        converterRead: converter,
        at: this.captureTimestamp(),
      },
    });
  }

  private captureTimestamp(): string {
    return this.snapshot.capture.at(-1)?.ts ?? '';
  }

  private async readFrameSequence(
    frames: readonly { label: string; bytes: Uint8Array }[],
    transport: DeviceTransport,
    transportKind: TransportKind,
    generation: number,
    messagePrefix: string,
    operation: string,
  ): Promise<Array<{ label: string; parsed: ReadResponse }> | null> {
    const results: Array<{ label: string; parsed: ReadResponse }> = [];
    for (const frame of frames) {
      if (!this.isCurrentPreflight(transport, generation)) return null;

      try {
        await transport.write(frame.bytes);
      } catch (error) {
        const transportError = toTransportError(error, `${operation}.write`);
        this.append({
          kind: 'error',
          code: transportError.code,
          message: PUBLIC_ERROR[transportError.code],
          stage: transportError.detail?.stage,
          detail: {
            ...environmentDetail(),
            ...transportError.detail,
          } as Record<string, unknown>,
        });
        return null;
      }

      this.append({
        kind: 'tx',
        direction: 'tx',
        transport: transportKind,
        bytes: frame.bytes,
        message: `${messagePrefix}: ${frame.label}`,
      });

      let raw: Uint8Array;
      try {
        raw = await this.readResponseBytes(
          transport,
          transportKind,
          generation,
          `${operation}.read`,
          `${messagePrefix} rx`,
        );
      } catch (error) {
        if (!this.isCurrentPreflight(transport, generation)) return null;
        const transportError = toTransportError(error, `${operation}.read`);
        this.append({
          kind: 'error',
          code: transportError.code,
          message: PUBLIC_ERROR[transportError.code],
          stage: transportError.detail?.stage,
          detail: {
            ...environmentDetail(),
            ...transportError.detail,
          } as Record<string, unknown>,
        });
        return null;
      }

      if (!this.isCurrentPreflight(transport, generation)) return null;
      if (raw.length === 0) {
        this.append({
          kind: 'error',
          code: 'timeout',
          message: `No response for ${frame.label} within ${READ_TIMEOUT_MS} ms.`,
          stage: 'timeout',
          detail: { operation: `${operation}.read`, stage: 'timeout' },
        });
        return null;
      }

      const parsed = parseReadResponse(raw);
      if (!parsed) {
        this.append({
          kind: 'error',
          code: 'protocol-error',
          message: `The ${frame.label} response was not a valid Type2 frame.`,
          stage: 'parse',
          errorMessage: toHex(raw),
        });
        return null;
      }
      if (!responseMatchesRequest(parsed.header, frame.bytes)) {
        this.append({
          kind: 'error',
          code: 'protocol-error',
          message: `The ${frame.label} response delimiter did not match the request.`,
          stage: 'sequence',
          errorMessage: `${parsed.header} vs ${toHex(frame.bytes.slice(5, 6))}`,
        });
        return null;
      }

      results.push({ label: frame.label, parsed });
    }
    return results;
  }

  private async readResponseBytes(
    transport: DeviceTransport,
    transportKind: TransportKind,
    generation: number,
    operation = 'local-read.read',
    message = 'Read response rx',
  ): Promise<Uint8Array> {
    let raw: Uint8Array = new Uint8Array();
    const deadline = Date.now() + READ_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (!this.isCurrentPreflight(transport, generation)) return raw;
      const remaining = Math.max(1, deadline - Date.now());
      let chunk: Uint8Array;
      try {
        chunk = await transport.readChunk(remaining);
      } catch (error) {
        const transportError = toTransportError(error, operation);
        if (transportError.code === 'timeout') break;
        throw transportError;
      }
      if (!this.isCurrentPreflight(transport, generation)) return raw;
      if (chunk.length === 0) continue;
      raw = concatBytes(raw, chunk);
      this.append({
        kind: 'rx',
        direction: 'rx',
        transport: transportKind,
        bytes: chunk,
        message,
      });
      if (parseReadResponse(raw)) return raw;
      if (raw.length > 512) break;
    }

    return raw;
  }

  async runRateWriteTest(slot: 0 | 1 = 0): Promise<void> {
    const original =
      slot === 0 ? this.snapshot.foreignRead?.slot0Rate : this.snapshot.foreignRead?.slot1Rate;
    if (!original || !/^\d+$/.test(original)) return;
    const last = original.at(-1) ?? '0';
    const nextLast = last === '9' ? '8' : String(Number(last) + 1);
    await this.executeWriteTest(
      slot === 0 ? 'slot0Rate' : 'slot1Rate',
      original,
      `${original.slice(0, -1)}${nextLast}`,
      (value, delimiter) => buildRateWrite(value, delimiter, slot),
      (delimiter) => buildRateReadback(delimiter, slot),
    );
  }

  async runConverterRateWriteTest(): Promise<void> {
    const original = this.snapshot.converterRead?.rate;
    if (!original || !/^\d+$/.test(original)) return;
    const last = original.at(-1) ?? '0';
    const nextLast = last === '9' ? '8' : String(Number(last) + 1);
    await this.executeWriteTest(
      'converterRate',
      original,
      `${original.slice(0, -1)}${nextLast}`,
      buildConverterRateWrite,
      buildConverterRateReadback,
    );
  }

  async runPrintFlagWriteTest(): Promise<void> {
    const original = this.snapshot.converterRead?.printFlag;
    if (original !== '0' && original !== '1') return;
    await this.executeWriteTest(
      'converterPrint',
      original,
      original === '1' ? '0' : '1',
      (value, delimiter) => buildPrintFlagWrite(value as '0' | '1', delimiter),
      buildPrintFlagReadback,
    );
  }

  private async executeWriteTest(
    field: 'slot0Rate' | 'slot1Rate' | 'converterRate' | 'converterPrint',
    original: string,
    temporary: string,
    buildWrite: (value: string, delimiter: number) => Uint8Array | null,
    buildRead: (delimiter: number) => Uint8Array,
  ): Promise<void> {
    const transport = this.transport;
    if (
      this.snapshot.phase !== 'connected' ||
      !transport ||
      this.snapshot.transportKind !== 'webserial' ||
      this.snapshot.readState !== 'read' ||
      this.snapshot.foreignReadState !== 'read' ||
      this.snapshot.converterReadState !== 'read' ||
      this.snapshot.writeTestState === 'writing'
    ) {
      return;
    }

    let base = this.writeDelimiter;
    if (base + 4 > 0x7e) base = 0x32;
    this.writeDelimiter = base + 5;
    const readPrecheck = buildRead(base);
    const writeTemporary = buildWrite(temporary, base + 1);
    const readTemporary = buildRead(base + 2);
    const writeRestore = buildWrite(original, base + 3);
    const readRestore = buildRead(base + 4);
    if (!writeTemporary || !writeRestore) {
      this.set({
        writeTestState: 'failed',
        writeTest: {
          field,
          original,
          temporary,
          restored: true,
          message: 'The value contains characters unsupported by the encoder.',
        },
      });
      return;
    }

    const generation = this.preflightGeneration;
    const transportKind = this.snapshot.transportKind;
    const environment = environmentDetail();
    let temporaryAttempted = false;
    let temporaryReadback: string | undefined;
    let restoredReadback: string | undefined;
    let restored = true;
    this.set({ writeTestState: 'writing', writeTest: undefined });

    const sendWrite = async (bytes: Uint8Array, label: string): Promise<void> => {
      await transport.write(bytes);
      this.append({
        kind: 'tx',
        direction: 'tx',
        transport: transportKind,
        bytes,
        message: `Write test (${field}): ${label}`,
      });
      const raw = await this.readResponseBytes(
        transport,
        transportKind,
        generation,
        'write-test.write',
        'Write test response',
      );
      if (!this.isCurrentPreflight(transport, generation)) throw new Error('Session changed.');
      if (raw.length === 0) throw new Error(`No write response within ${READ_TIMEOUT_MS} ms.`);
      const parsed = parseReadResponse(raw);
      if (!parsed) throw new Error('Write response was not a valid Type2 frame.');
      if (!responseMatchesRequest(parsed.header, bytes)) {
        throw new Error('Write response delimiter did not match the request.');
      }
    };

    const readValue = async (bytes: Uint8Array, label: string): Promise<string> => {
      await transport.write(bytes);
      this.append({
        kind: 'tx',
        direction: 'tx',
        transport: transportKind,
        bytes,
        message: `Write test readback (${field}): ${label}`,
      });
      const raw = await this.readResponseBytes(
        transport,
        transportKind,
        generation,
        'write-test.readback',
        'Write test readback',
      );
      if (!this.isCurrentPreflight(transport, generation)) throw new Error('Session changed.');
      if (raw.length === 0) throw new Error(`No readback within ${READ_TIMEOUT_MS} ms.`);
      const parsed = parseReadResponse(raw);
      if (!parsed || !responseMatchesRequest(parsed.header, bytes)) {
        throw new Error('Readback was not a valid Type2 frame.');
      }
      const value = parsed.fields[0];
      if (value === undefined) throw new Error('Readback did not contain a value.');
      return value;
    };

    try {
      this.append({
        kind: 'info',
        transport: transportKind,
        message: `One-field write test starting (${field})`,
        detail: { field, original, temporary, writeHex: toHex(writeTemporary), ...environment },
      });

      const fresh = await readValue(readPrecheck, 'fresh current value');
      if (fresh !== original) throw new Error(`Value changed since the read: ${fresh}`);

      temporaryAttempted = true;
      restored = false;
      await sendWrite(writeTemporary, 'temporary value');
      temporaryReadback = await readValue(readTemporary, 'temporary value');
      if (temporaryReadback !== temporary) {
        throw new Error(`Temporary readback mismatch: ${temporaryReadback}`);
      }

      await sendWrite(writeRestore, 'restore original value');
      restoredReadback = await readValue(readRestore, 'restored value');
      if (restoredReadback !== original) {
        throw new Error(`Restore readback mismatch: ${restoredReadback}`);
      }
      restored = true;

      this.append({
        kind: 'info',
        transport: transportKind,
        message: `One-field write test verified (${field})`,
        detail: { field, original, temporary, temporaryReadback, restoredReadback, ...environment },
      });
      this.set({
        writeTestState: 'verified',
        writeTest: {
          field,
          original,
          temporary,
          temporaryReadback,
          restoredReadback,
          restored: true,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (temporaryAttempted && !restored) {
        this.append({
          kind: 'info',
          transport: transportKind,
          message: `Attempting to restore the original value (${field})`,
        });
        try {
          await sendWrite(writeRestore, 'restore after failure');
          restoredReadback = await readValue(readRestore, 'restore after failure');
          restored = restoredReadback === original;
        } catch {
          restored = false;
        }
      }
      this.append({
        kind: 'error',
        code: 'unknown',
        message: `One-field write test failed (${field}).`,
        errorMessage: message,
        detail: {
          field,
          original,
          temporary,
          temporaryReadback,
          restoredReadback,
          restored,
          ...environment,
        },
      });
      this.set({
        writeTestState: 'failed',
        writeTest: {
          field,
          original,
          temporary,
          temporaryReadback,
          restoredReadback,
          restored,
          message,
        },
      });
    }
  }

  private takeWriteDelimiter(): number {
    let delimiter = this.writeDelimiter;
    if (delimiter > 0x7e) delimiter = 0x32;
    this.writeDelimiter = delimiter + 1;
    return delimiter;
  }

  async runFullUpdate(targets: UpdateTargets): Promise<void> {
    const transport = this.transport;
    const foreign = this.snapshot.foreignRead;
    const converter = this.snapshot.converterRead;
    if (
      this.snapshot.phase !== 'connected' ||
      !transport ||
      this.snapshot.transportKind !== 'webserial' ||
      this.snapshot.readState !== 'read' ||
      this.snapshot.foreignReadState !== 'read' ||
      this.snapshot.converterReadState !== 'read' ||
      this.snapshot.writeTestState === 'writing' ||
      this.snapshot.updateState === 'updating' ||
      !foreign ||
      !converter?.rate ||
      (converter.printFlag !== '0' && converter.printFlag !== '1')
    ) {
      return;
    }

    const usdSlot = foreign.slot0Name === 'USD' ? 0 : foreign.slot1Name === 'USD' ? 1 : null;
    const eurSlot = foreign.slot0Name === 'EUR' ? 0 : foreign.slot1Name === 'EUR' ? 1 : null;
    const usd = usdSlot === 0 ? foreign.slot0Rate : foreign.slot1Rate;
    const eur = eurSlot === 0 ? foreign.slot0Rate : foreign.slot1Rate;
    if (usdSlot === null || eurSlot === null || !usd || !eur) return;

    const backups: UpdateValues = {
      usd,
      eur,
      converter: converter.rate,
      printFlag: converter.printFlag,
    };
    const values: UpdateValues = {
      usd: String(targets.usdRaw),
      eur: String(targets.eurRaw),
      converter: String(targets.converterRaw),
      printFlag: targets.printFlag,
    };
    if (
      values.usd === backups.usd &&
      values.eur === backups.eur &&
      values.converter === backups.converter &&
      values.printFlag === backups.printFlag
    ) {
      return;
    }

    const generation = this.preflightGeneration;
    const transportKind = this.snapshot.transportKind;
    const environment = environmentDetail();
    let readbacks: UpdateValues | undefined;
    let wrote = false;
    let restored = true;
    this.set({ updateState: 'updating', updateResult: undefined });

    const readValue = async (frame: Uint8Array, label: string): Promise<string> => {
      await transport.write(frame);
      this.append({
        kind: 'tx',
        direction: 'tx',
        transport: transportKind,
        bytes: frame,
        message: `Update readback: ${label}`,
      });
      const raw = await this.readResponseBytes(
        transport,
        transportKind,
        generation,
        'update.readback',
        'Update readback',
      );
      if (!this.isCurrentPreflight(transport, generation)) throw new Error('Session changed.');
      if (raw.length === 0) throw new Error(`No readback for ${label}.`);
      const parsed = parseReadResponse(raw);
      if (!parsed || !responseMatchesRequest(parsed.header, frame)) {
        throw new Error(`Invalid readback for ${label}.`);
      }
      const value = parsed.fields[0];
      if (value === undefined) throw new Error(`Missing value for ${label}.`);
      return value;
    };

    const writeValue = async (frame: Uint8Array, label: string): Promise<void> => {
      await transport.write(frame);
      this.append({
        kind: 'tx',
        direction: 'tx',
        transport: transportKind,
        bytes: frame,
        message: `Update write: ${label}`,
      });
      const raw = await this.readResponseBytes(
        transport,
        transportKind,
        generation,
        'update.write',
        'Update write response',
      );
      if (!this.isCurrentPreflight(transport, generation)) throw new Error('Session changed.');
      if (raw.length === 0) throw new Error(`No write response for ${label}.`);
      const parsed = parseReadResponse(raw);
      if (!parsed || !responseMatchesRequest(parsed.header, frame)) {
        throw new Error(`Invalid write response for ${label}.`);
      }
    };

    const readAll = async (): Promise<UpdateValues> => ({
      usd: await readValue(buildRateReadback(this.takeWriteDelimiter(), usdSlot), 'USD rate'),
      eur: await readValue(buildRateReadback(this.takeWriteDelimiter(), eurSlot), 'EUR rate'),
      converter: await readValue(
        buildConverterRateReadback(this.takeWriteDelimiter()),
        'converter rate',
      ),
      printFlag: await readValue(
        buildPrintFlagReadback(this.takeWriteDelimiter()),
        'Print converter flag',
      ),
    });

    const writeAll = async (next: UpdateValues): Promise<void> => {
      await writeValue(buildRateWrite(next.usd, this.takeWriteDelimiter(), usdSlot), 'USD rate');
      await writeValue(buildRateWrite(next.eur, this.takeWriteDelimiter(), eurSlot), 'EUR rate');
      await writeValue(
        buildConverterRateWrite(next.converter, this.takeWriteDelimiter()),
        'converter rate',
      );
      await writeValue(
        buildPrintFlagWrite(next.printFlag as '0' | '1', this.takeWriteDelimiter()),
        'Print converter flag',
      );
    };

    try {
      const fresh = await readAll();
      if (
        fresh.usd !== backups.usd ||
        fresh.eur !== backups.eur ||
        fresh.converter !== backups.converter ||
        fresh.printFlag !== backups.printFlag
      ) {
        throw new Error('Cashier records changed since the read; update aborted before writing.');
      }

      this.append({
        kind: 'info',
        transport: transportKind,
        message: 'Full update starting',
        detail: { backups, targets: values, ...environment },
      });

      wrote = true;
      await writeAll(values);
      readbacks = await readAll();
      if (
        readbacks.usd !== values.usd ||
        readbacks.eur !== values.eur ||
        readbacks.converter !== values.converter ||
        readbacks.printFlag !== values.printFlag
      ) {
        throw new Error('Readback did not match the requested update.');
      }

      const updatedForeign = { ...foreign };
      if (usdSlot === 0) updatedForeign.slot0Rate = values.usd;
      else updatedForeign.slot1Rate = values.usd;
      if (eurSlot === 0) updatedForeign.slot0Rate = values.eur;
      else updatedForeign.slot1Rate = values.eur;
      const updatedConverter = {
        ...converter,
        rate: values.converter,
        printFlag: values.printFlag,
      };
      this.set({
        updateState: 'verified',
        foreignRead: updatedForeign,
        converterRead: updatedConverter,
        updateResult: { backups, targets, readbacks, outcome: 'verified', restored: true },
      });
      this.append({
        kind: 'info',
        transport: transportKind,
        message: 'Full update verified',
        detail: { backups, targets: values, readbacks, ...environment },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (wrote) {
        this.append({
          kind: 'info',
          transport: transportKind,
          message: 'Restoring all currency records after update failure',
        });
        try {
          await writeAll(backups);
          const restoredReadbacks = await readAll();
          restored =
            restoredReadbacks.usd === backups.usd &&
            restoredReadbacks.eur === backups.eur &&
            restoredReadbacks.converter === backups.converter &&
            restoredReadbacks.printFlag === backups.printFlag;
          readbacks = restoredReadbacks;
        } catch {
          restored = false;
        }
      }
      if (restored) {
        const restoredForeign = { ...foreign };
        if (usdSlot === 0) restoredForeign.slot0Rate = backups.usd;
        else restoredForeign.slot1Rate = backups.usd;
        if (eurSlot === 0) restoredForeign.slot0Rate = backups.eur;
        else restoredForeign.slot1Rate = backups.eur;
        this.set({
          foreignRead: restoredForeign,
          converterRead: {
            ...converter,
            rate: backups.converter,
            printFlag: backups.printFlag,
          },
        });
      }
      this.append({
        kind: 'error',
        code: 'unknown',
        message: restored
          ? 'Full update failed; original records restored.'
          : 'Full update failed; restore did not verify.',
        errorMessage: message,
        detail: { backups, targets: values, readbacks, restored, ...environment },
      });
      this.set({
        updateState: 'failed',
        updateResult: {
          backups,
          targets,
          readbacks,
          outcome: wrote ? (restored ? 'restored' : 'restore-failed') : 'not-written',
          restored,
          message,
        },
      });
    }
  }

  clearCapture(): void {
    if (this.isDeviceBusy()) return;
    this.capture.clear();
    this.snapshot = {
      ...this.snapshot,
      capture: this.capture.snapshot(),
      captureState: 'idle',
      readState: 'idle',
      foreignReadState: 'idle',
      converterReadState: 'idle',
      writeTestState: 'idle',
      updateState: 'idle',
      updateResult: undefined,
      preflight: undefined,
      foreignRead: undefined,
      converterRead: undefined,
      lastRead: undefined,
      writeTest: undefined,
    };
    this.emit();
  }

  captureJsonl(): string {
    return this.capture.toJsonl();
  }

  captureText(): string {
    return this.capture.toText();
  }

  private failPreflight(error: TransportError, environment: TransportErrorDetail): void {
    this.append({
      kind: 'error',
      code: error.code,
      message: PUBLIC_ERROR[error.code],
      stage: error.detail?.stage,
      errorName: error.detail?.errorName,
      errorMessage: error.detail?.errorMessage,
      detail: { ...environment, ...error.detail } as Record<string, unknown>,
    });
    this.set({
      captureState: 'failed',
      preflight: { status: 'failed', reason: PUBLIC_ERROR[error.code] },
    });
  }

  private fail(error: TransportError): void {
    const detail = { ...environmentDetail(), ...error.detail };
    this.append({
      kind: 'error',
      code: error.code,
      message: PUBLIC_ERROR[error.code],
      stage: detail?.stage,
      errorName: detail?.errorName,
      errorMessage: detail?.errorMessage,
      detail: detail as Record<string, unknown> | undefined,
    });
    this.set({
      phase: 'error',
      error: { code: error.code, message: PUBLIC_ERROR[error.code], detail },
    });
  }

  private append(input: Parameters<CaptureLog['append']>[0]): void {
    this.capture.append(input);
    this.snapshot = {
      ...this.snapshot,
      capture: this.capture.snapshot(),
    };
    this.emit();
  }

  private set(patch: Partial<SessionSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      capture: this.capture.snapshot(),
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
