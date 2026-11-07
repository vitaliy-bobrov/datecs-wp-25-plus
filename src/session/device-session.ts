import type { CaptureEntry, CaptureLog } from '../domain/capture-log';
import { toHex } from '../domain/capture-log';
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
  buildFullNameReadback,
  buildFullNameWrite,
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
  preflight?: PreflightResult;
  foreignRead?: ForeignReadResult;
  converterRead?: ConverterReadResult;
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
    capture: [],
  };

  private readonly listeners = new Set<() => void>();
  private transport: DeviceTransport | null = null;

  private preflightGeneration = 0;

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
    this.set({
      phase: 'connecting',
      transportKind: kind,
      captureState: 'idle',
      readState: 'idle',
      foreignReadState: 'idle',
      converterReadState: 'idle',
      writeTestState: 'idle',
      preflight: undefined,
      foreignRead: undefined,
      converterRead: undefined,
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
      preflight: undefined,
      foreignRead: undefined,
      converterRead: undefined,
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
      snapshot.writeTestState === 'writing'
    );
  }

  async runPreflight(): Promise<void> {
    const transport = this.transport;
    if (this.snapshot.phase !== 'connected' || !transport || this.isDeviceBusy()) {
      return;
    }

    const generation = ++this.preflightGeneration;
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

    this.append({
      kind: 'info',
      transport: transportKind,
      message: 'Converter values read',
      detail: { ...converter, ...environment } as Record<string, unknown>,
    });
    this.set({ converterReadState: 'read', converterRead: converter });
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

  async runFullNameWriteTest(): Promise<void> {
    const original = this.snapshot.foreignRead?.slot0FullName;
    if (!original) return;
    const first = original[0] === 'X' ? 'Y' : 'X';
    await this.executeWriteTest(
      'slot0FullName',
      original,
      `${first}${original.slice(1)}`,
      buildFullNameWrite,
      buildFullNameReadback,
    );
  }

  async runRateWriteTest(): Promise<void> {
    const original = this.snapshot.foreignRead?.slot0Rate;
    if (!original || !/^\d+$/.test(original)) return;
    const last = original.at(-1) ?? '0';
    const nextLast = last === '9' ? '8' : String(Number(last) + 1);
    await this.executeWriteTest(
      'slot0Rate',
      original,
      `${original.slice(0, -1)}${nextLast}`,
      buildRateWrite,
      buildRateReadback,
    );
  }

  private async executeWriteTest(
    field: 'slot0FullName' | 'slot0Rate',
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

    const readPrecheck = buildRead(0x32);
    const writeTemporary = buildWrite(temporary, 0x33);
    const readTemporary = buildRead(0x34);
    const writeRestore = buildWrite(original, 0x35);
    const readRestore = buildRead(0x36);
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
      preflight: undefined,
      foreignRead: undefined,
      converterRead: undefined,
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
