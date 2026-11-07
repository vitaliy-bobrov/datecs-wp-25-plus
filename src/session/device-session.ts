import type { CaptureEntry } from '../domain/capture-log';
import type { CaptureLog } from '../domain/capture-log';
import type { DeviceLock } from '../ports/device-lock';
import {
  toTransportError,
  type DeviceTransport,
  type TransportErrorCode,
  type TransportInfo,
  type TransportKind,
  type TransportSelector,
} from '../ports/transport';

export type SessionPhase = 'idle' | 'connecting' | 'connected' | 'error';
export type LockState = 'idle' | 'acquiring' | 'held' | 'in-use' | 'unavailable';

export interface SessionError {
  code: TransportErrorCode | 'unknown';
  message: string;
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
        this.snapshot.lockState === 'unavailable' ? 'locks-unavailable' : 'device-in-use',
      );
      return;
    }

    this.set({ phase: 'connecting', transportKind: kind, error: undefined });
    this.append({
      kind: 'session',
      transport: kind,
      message: 'Connecting',
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
      });
    } catch (error) {
      const transportError = toTransportError(error);
      this.fail(transportError.code);
    }
  }

  async disconnect(): Promise<void> {
    const transport = this.transport;
    this.transport = null;

    if (transport) {
      try {
        await transport.close();
      } catch (error) {
        const transportError = toTransportError(error);
        this.append({
          kind: 'error',
          code: transportError.code,
          message: PUBLIC_ERROR[transportError.code],
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

  private fail(code: TransportErrorCode): void {
    this.append({ kind: 'error', code, message: PUBLIC_ERROR[code] });
    this.set({
      phase: 'error',
      error: { code, message: PUBLIC_ERROR[code] },
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
