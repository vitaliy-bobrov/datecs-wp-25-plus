import type { CaptureEntry } from '../domain/capture-log';
import type { CaptureLog } from '../domain/capture-log';
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

export type SessionPhase = 'idle' | 'connecting' | 'connected' | 'error';
export type LockState = 'idle' | 'acquiring' | 'held' | 'in-use' | 'unavailable';

export interface SessionError {
  code: TransportErrorCode | 'unknown';
  message: string;
  detail?: TransportErrorDetail;
}

export interface SessionSnapshot {
  phase: SessionPhase;
  lockState: LockState;
  transportKind?: TransportKind;
  info?: TransportInfo;
  error?: SessionError;
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
  unknown: 'An unexpected device error occurred.',
};

function environmentDetail(): TransportErrorDetail {
  if (typeof navigator === 'undefined') return {};
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
  };
}

export class DeviceSession {
  private snapshot: SessionSnapshot = {
    phase: 'idle',
    lockState: 'idle',
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

  async connect(kind: TransportKind): Promise<void> {
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
    this.set({ phase: 'connecting', transportKind: kind, error: undefined });
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
    this.set({ phase: 'idle', info: undefined, transportKind: undefined, error: undefined });
  }

  clearCapture(): void {
    this.capture.clear();
    this.snapshot = {
      ...this.snapshot,
      capture: this.capture.snapshot(),
    };
    this.emit();
  }

  captureJsonl(): string {
    return this.capture.toJsonl();
  }

  captureText(): string {
    return this.capture.toText();
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
