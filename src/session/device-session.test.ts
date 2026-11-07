import { describe, expect, it, vi } from 'vitest';
import { CaptureLog } from '../domain/capture-log';
import type { DeviceLock } from '../ports/device-lock';
import type {
  DeviceTransport,
  TransportInfo,
  TransportKind,
  TransportSelector,
} from '../ports/transport';
import { TransportError } from '../ports/transport';
import { DeviceSession } from './device-session';

class FixedClock {
  nowIso(): string {
    return '2026-11-06T08:00:00.000Z';
  }
}

class FakeLock implements DeviceLock {
  supported = true;
  private held = false;

  constructor(private readonly result = true) {}

  isHeld(): boolean {
    return this.held;
  }

  async acquire(): Promise<boolean> {
    this.held = this.result;
    return this.result;
  }
}

class FakeTransport implements DeviceTransport {
  opened = false;
  closed = false;
  written: Uint8Array[] = [];
  rx: Uint8Array[] = [];

  async open(): Promise<TransportInfo> {
    this.opened = true;
    return { kind: 'webserial', label: 'Fake WP-25 Plus', vendorId: 0x1234, productId: 0x5678 };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async write(bytes: Uint8Array): Promise<void> {
    this.written.push(bytes);
  }

  async readChunk(_timeoutMs: number): Promise<Uint8Array> {
    const next = this.rx.shift();
    if (next) return next;
    throw new TransportError('timeout', 'no response');
  }

  async flushInput(): Promise<void> {}
}

class FakeSelector implements TransportSelector {
  last?: FakeTransport;
  readonly select = vi.fn(async (_kind: TransportKind) => {
    this.last = new FakeTransport();
    return this.last;
  });
}

describe('DeviceSession', () => {
  it('connects and disconnects, logging the lifecycle', async () => {
    const lock = new FakeLock();
    const selector = new FakeSelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect();

    expect(selector.select).toHaveBeenCalledWith('webserial');
    expect(session.getSnapshot().phase).toBe('connected');
    expect(session.getSnapshot().info?.label).toBe('Fake WP-25 Plus');
    expect(session.getSnapshot().capture.some((entry) => entry.kind === 'connect')).toBe(true);

    await session.disconnect();
    expect(session.getSnapshot().phase).toBe('idle');
    expect(session.getSnapshot().capture.some((entry) => entry.kind === 'disconnect')).toBe(true);
  });

  it('refuses to connect when the device lock is not held', async () => {
    const selector = new FakeSelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), new FakeLock());

    await session.connect();

    expect(selector.select).not.toHaveBeenCalled();
    expect(session.getSnapshot().phase).toBe('error');
    expect(session.getSnapshot().error?.code).toBe('device-in-use');
  });

  it('retains staged transport diagnostics in the session and logger', async () => {
    const lock = new FakeLock();
    const selector: TransportSelector = {
      select: async () => {
        throw new TransportError('device-unavailable', 'The device is unavailable or disconnected.', {
          operation: 'webserial.open',
          stage: 'claim-interface',
          errorName: 'NetworkError',
          errorMessage: 'claim failed',
          device: { label: 'WP-25 Plus', vendorId: 0x1234, productId: 0x5678 },
          interfaceNumber: 1,
          alternateSetting: 0,
          endpointCount: 2,
        });
      },
    };
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect();

    expect(session.getSnapshot().error?.detail?.stage).toBe('claim-interface');
    expect(session.getSnapshot().error?.detail?.errorName).toBe('NetworkError');
    const last = session.getSnapshot().capture.at(-1);
    expect(last?.stage).toBe('claim-interface');
    expect(last?.errorName).toBe('NetworkError');
    expect(last?.detail?.interfaceNumber).toBe(1);
  });

  it('reports a cancelled selection without opening a transport', async () => {
    const lock = new FakeLock();
    const selector: TransportSelector = {
      select: async () => {
        throw new TransportError('cancelled', 'cancelled');
      },
    };
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect();

    expect(session.getSnapshot().phase).toBe('error');
    expect(session.getSnapshot().error?.code).toBe('cancelled');
    expect(session.getSnapshot().capture.at(-1)?.kind).toBe('error');
  });

  it('sends the exact preflight and preserves a capture-only response', async () => {
    const lock = new FakeLock();
    const selector = new FakeSelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect();
    const transport = selector.last!;
    transport.rx.push(Uint8Array.from([0x15]));
    await session.runPreflight();

    expect(transport.written).toHaveLength(1);
    expect(Array.from(transport.written[0] ?? [])).toEqual([
      0x01, 0x30, 0x30, 0x32, 0x3a, 0x20, 0x30, 0x30, 0x34, 0x3a, 0x05, 0x30, 0x31, 0x3b, 0x3f, 0x03,
    ]);
    expect(session.getSnapshot().captureState).toBe('captureOnly');
    expect(session.getSnapshot().preflight?.rawHex).toBe('15');
    expect(session.getSnapshot().capture.some((entry) => entry.kind === 'tx')).toBe(true);
    expect(session.getSnapshot().capture.some((entry) => entry.kind === 'rx')).toBe(true);
  });

  it('reports an unavailable lock', async () => {
    const lock = new FakeLock(false);
    lock.supported = false;
    const selector = new FakeSelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect();

    expect(session.getSnapshot().lockState).toBe('unavailable');
    expect(session.getSnapshot().error?.code).toBe('locks-unavailable');
  });
});
