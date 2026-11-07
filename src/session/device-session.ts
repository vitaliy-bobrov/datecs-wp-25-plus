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
import { parseReadResponse, READ_LOCAL_FRAMES } from '../protocol/read-currencies';

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

interface LocalReadResult {
  barcode?: string;
  localName?: string;
  currencyDate?: string;
  pgmLocalName?: string;
  pgmCurrencyDate?: string;
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
  preflight?: PreflightResult;
  localRead?: LocalReadResult;
  capture: readonly CaptureEntry[];
}

const PUBLIC_ERROR: Record<TransportErrorCode, string> = {
  unsupported: 'This browser or device does not support the selected transport.',
  'permission-denied': 'Device permission was not granted.',
  cancelled: 'No device was selected.',
  'device-unavailable': 'The device is unavailable or disconnected.',
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

export class DeviceSession {
  private snapshot: SessionSnapshot = {
    phase: 'idle',
    lockState: 'idle',
    captureState: 'idle',
    readState: 'idle',
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
      preflight: undefined,
      localRead: undefined,
      error: undefined,
    });
    this.append({
      kind: 'session',
      transport: kind,
      message: 'Connecting',
      detail: environment as Record<string, unknown>,
    });

    try {
      const transport = await this.selector.select(kind);
      const info = await transport.open();
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
      preflight: undefined,
      localRead: undefined,
    });
  }

  async runPreflight(): Promise<void> {
    const transport = this.transport;
    if (
      this.snapshot.phase !== 'connected' ||
      !transport ||
      this.snapshot.captureState === 'capturing'
    ) {
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
      preflight: undefined,
      localRead: undefined,
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
    const deadline = Date.now() + 500;

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
      this.snapshot.readState === 'reading'
    ) {
      return;
    }

    const generation = this.preflightGeneration;
    const transportKind = this.snapshot.transportKind;
    const environment = environmentDetail();
    this.set({ readState: 'reading', localRead: undefined });

    const local: LocalReadResult = { rawFrames: [] };

    for (const frame of READ_LOCAL_FRAMES) {
      if (!this.isCurrentPreflight(transport, generation)) return;

      try {
        await transport.write(frame.bytes);
      } catch (error) {
        this.failRead(
          'preflight.read.write',
          toTransportError(error, 'local-read.write'),
          environment,
        );
        return;
      }

      this.append({
        kind: 'tx',
        direction: 'tx',
        transport: transportKind,
        bytes: frame.bytes,
        message: `Read local: ${frame.label}`,
      });

      let raw: Uint8Array;
      try {
        raw = await this.readLocalResponse(transport, transportKind, generation);
      } catch (error) {
        if (!this.isCurrentPreflight(transport, generation)) return;
        this.failRead(
          'preflight.read.read',
          toTransportError(error, 'local-read.read'),
          environment,
        );
        return;
      }
      if (!this.isCurrentPreflight(transport, generation)) return;

      if (raw.length === 0) {
        this.failRead(
          'preflight.read.timeout',
          new TransportError('timeout', 'No local currency response within 500 ms.', {
            operation: 'local-read.read',
            stage: 'timeout',
          }),
          environment,
        );
        return;
      }

      const parsed = parseReadResponse(raw);
      if (!parsed) {
        this.failRead(
          'preflight.read.parse',
          new TransportError(
            'device-unavailable',
            'The local currency response was not a valid Type2 frame.',
            {
              operation: 'local-read.read',
              stage: 'parse',
              errorMessage: toHex(raw),
            },
          ),
          environment,
        );
        return;
      }
      local.rawFrames?.push(parsed.rawHex);

      const value = parsed.fields[0];
      if (value !== undefined) {
        switch (frame.label) {
          case 'barcode':
            local.barcode = value;
            break;
          case 'localName':
            local.localName = value;
            break;
          case 'currencyDate':
            local.currencyDate = value;
            break;
          case 'pgmLocalName':
            local.pgmLocalName = value;
            break;
          case 'pgmCurrencyDate':
            local.pgmCurrencyDate = value;
            break;
          default:
            break;
        }
      }
    }

    if (!this.isCurrentPreflight(transport, generation)) return;
    this.append({
      kind: 'info',
      transport: transportKind,
      message: 'Local currency values read',
      detail: { ...local, ...environment } as Record<string, unknown>,
    });
    this.set({ readState: 'read', localRead: local });
  }

  private async readLocalResponse(
    transport: DeviceTransport,
    transportKind: TransportKind,
    generation: number,
  ): Promise<Uint8Array> {
    let raw: Uint8Array = new Uint8Array();
    const deadline = Date.now() + 500;

    while (Date.now() < deadline) {
      if (!this.isCurrentPreflight(transport, generation)) return raw;
      const remaining = Math.max(1, deadline - Date.now());
      let chunk: Uint8Array;
      try {
        chunk = await transport.readChunk(remaining);
      } catch (error) {
        const transportError = toTransportError(error, 'local-read.read');
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
        message: 'Read local rx',
      });
      if (parseReadResponse(raw)) return raw;
      if (raw.length > 512) break;
    }

    return raw;
  }

  private failRead(
    _operation: string,
    error: TransportError,
    environment: TransportErrorDetail,
  ): void {
    this.append({
      kind: 'error',
      code: error.code,
      message: PUBLIC_ERROR[error.code],
      stage: error.detail?.stage,
      errorName: error.detail?.errorName,
      errorMessage: error.detail?.errorMessage,
      detail: { ...environment, ...error.detail } as Record<string, unknown>,
    });
    this.set({ readState: 'failed' });
  }

  clearCapture(): void {
    this.capture.clear();
    this.snapshot = {
      ...this.snapshot,
      capture: this.capture.snapshot(),
      captureState: 'idle',
      readState: 'idle',
      preflight: undefined,
      localRead: undefined,
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
