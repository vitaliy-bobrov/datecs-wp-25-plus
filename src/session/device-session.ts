import type { CaptureEntry } from '../domain/capture-log';
import type { CaptureLog } from '../domain/capture-log';
import { toHex } from '../domain/capture-log';
import type { DeviceLock } from '../ports/device-lock';
import {
  toTransportError,
  TransportError,
  type DeviceTransport,
  type TransportErrorCode,
  type TransportErrorDetail,
  type TransportInfo,
  type TransportKind,
  type TransportSelector,
} from '../ports/transport';
import { PREFLIGHT_FRAME, parseResponse } from '../protocol/preflight';

export type SessionPhase = 'idle' | 'connecting' | 'connected' | 'error';
export type LockState = 'idle' | 'acquiring' | 'held' | 'in-use' | 'unavailable';
export type CaptureState = 'idle' | 'capturing' | 'captured' | 'captureOnly' | 'failed';

export interface SessionError {
  code: TransportErrorCode | 'unknown';
  message: string;
  detail?: TransportErrorDetail;
}

export interface PreflightResult {
  status: 'captured' | 'captureOnly' | 'failed';
  mode?: 'short' | 'long' | 'type2';
  statusHex?: string;
  secondaryStatusHex?: string;
  rawHex?: string;
  reason?: string;
}

export interface SessionSnapshot {
  phase: SessionPhase;
  lockState: LockState;
  transportKind?: TransportKind;
  info?: TransportInfo;
  error?: SessionError;
  captureState: CaptureState;
  preflight?: PreflightResult;
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
    capture: [],
  };

  private readonly listeners = new Set<() => void>();
  private transport: DeviceTransport | null = null;

  constructor(
    private readonly selector: TransportSelector,
    private readonly capture: CaptureLog,
    private readonly lock: DeviceLock,
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
    this.set({
      phase: 'connecting',
      transportKind: kind,
      captureState: 'idle',
      preflight: undefined,
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
      const transportError = toTransportError(error, 'session.connect', environment);
      this.fail(transportError);
    }
  }

  async disconnect(): Promise<void> {
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
      preflight: undefined,
    });
  }

  async runPreflight(): Promise<void> {
    const transport = this.transport;
    if (this.snapshot.phase !== 'connected' || !transport || this.snapshot.captureState === 'capturing') {
      return;
    }

    const environment = environmentDetail();
    const transportKind = this.snapshot.transportKind ?? 'webserial';
    this.set({ captureState: 'capturing', preflight: undefined });
    this.append({
      kind: 'tx',
      direction: 'tx',
      transport: transportKind,
      bytes: PREFLIGHT_FRAME,
      message: 'Preflight tx',
      detail: environment as Record<string, unknown>,
    });

    try {
      await transport.write(PREFLIGHT_FRAME);
    } catch (error) {
      this.failPreflight(toTransportError(error, 'preflight.write'), environment);
      return;
    }

    let raw: Uint8Array = new Uint8Array();
    const deadline = Date.now() + 500;

    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      try {
        const chunk = await transport.readChunk(remaining);
        if (chunk.length === 0) continue;
        raw = concatBytes(raw, chunk);
        this.append({
          kind: 'rx',
          direction: 'rx',
          transport: transportKind,
          bytes: chunk,
          message: 'Preflight rx',
          detail: environment as Record<string, unknown>,
        });
        if (parseResponse(raw).kind === 'valid') break;
        if (raw.length > 512) break;
      } catch (error) {
        const transportError = toTransportError(error, 'preflight.read');
        if (transportError.code === 'timeout') break;
        this.failPreflight(transportError, environment);
        return;
      }
    }

    if (raw.length === 0) {
      const detail = {
        operation: 'preflight.read',
        stage: 'timeout',
        ...environment,
      };
      this.append({
        kind: 'error',
        code: 'timeout',
        message: 'No preflight response within 500 ms.',
        stage: 'timeout',
        detail: detail as Record<string, unknown>,
      });
      this.set({
        captureState: 'failed',
        preflight: { status: 'failed', reason: 'No response within 500 ms' },
      });
      return;
    }

    const outcome = parseResponse(raw);
    if (outcome.kind === 'valid') {
      const result: PreflightResult = {
        status: 'captured',
        mode: outcome.frame.mode,
        statusHex: toHex(outcome.frame.status),
        secondaryStatusHex: outcome.frame.secondaryStatus
          ? toHex(outcome.frame.secondaryStatus)
          : undefined,
        rawHex: toHex(raw),
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

    const reason = outcome.kind === 'ambiguous' ? outcome.reason : outcome.reason;
    this.append({
      kind: 'info',
      transport: transportKind,
      message: 'Preflight capture-only',
      detail: {
        reason,
        rawHex: toHex(raw),
        attempts: outcome.attempts,
        ...environment,
      },
    });
    this.set({
      captureState: 'captureOnly',
      preflight: {
        status: 'captureOnly',
        rawHex: toHex(raw),
        reason,
      },
    });
  }

  clearCapture(): void {
    this.capture.clear();
    this.snapshot = {
      ...this.snapshot,
      capture: this.capture.snapshot(),
      captureState: 'idle',
      preflight: undefined,
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
