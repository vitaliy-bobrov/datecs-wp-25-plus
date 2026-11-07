import { describe, expect, it, vi } from 'vitest';
import { SIMULATOR_PREFLIGHT_RESPONSE, SimulatorTransport } from '../adapters/simulator-transport';
import { CaptureLog } from '../domain/capture-log';
import type { DeviceLock } from '../ports/device-lock';
import type {
  DeviceTransport,
  TransportInfo,
  TransportKind,
  TransportSelector,
} from '../ports/transport';
import { TransportError } from '../ports/transport';
import { READ_LOCAL_FRAMES } from '../protocol/read-currencies';
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
  writeError: Error | null = null;

  async open(): Promise<TransportInfo> {
    this.opened = true;
    return { kind: 'webserial', label: 'Fake WP-25 Plus', vendorId: 0x1234, productId: 0x5678 };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.writeError) throw this.writeError;
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

class FailingOpenTransport extends FakeTransport {
  override async open(): Promise<TransportInfo> {
    throw new TransportError('device-unavailable', 'saved port is gone');
  }
}

class RetrySelector implements TransportSelector {
  readonly select = vi.fn(async (_kind: TransportKind, _options?: { preferSaved?: boolean }) => {
    this.calls += 1;
    return this.calls === 1 ? new FailingOpenTransport() : new FakeTransport();
  });
  calls = 0;
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

  it('retries with the picker when a saved port cannot be opened', async () => {
    const selector = new RetrySelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), new FakeLock());

    await session.acquireLock();
    await session.connect();

    expect(selector.select).toHaveBeenNthCalledWith(1, 'webserial');
    expect(selector.select).toHaveBeenNthCalledWith(2, 'webserial', { preferSaved: false });
    expect(session.getSnapshot().phase).toBe('connected');
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
        throw new TransportError(
          'device-unavailable',
          'The device is unavailable or disconnected.',
          {
            operation: 'webserial.open',
            stage: 'claim-interface',
            errorName: 'NetworkError',
            errorMessage: 'claim failed',
            device: { label: 'WP-25 Plus', vendorId: 0x1234, productId: 0x5678 },
            interfaceNumber: 1,
            alternateSetting: 0,
            endpointCount: 2,
          },
        );
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
    const transport = selector.last;
    if (!transport) throw new Error('Fake transport was not created.');
    transport.rx.push(Uint8Array.from([0x00]));
    await session.runPreflight();

    expect(transport.written).toHaveLength(1);
    expect(Array.from(transport.written[0] ?? [])).toEqual([
      0x01, 0x30, 0x30, 0x32, 0x3a, 0x20, 0x30, 0x30, 0x34, 0x3a, 0x05, 0x30, 0x31, 0x3b, 0x3f,
      0x03,
    ]);
    expect(session.getSnapshot().captureState).toBe('captureOnly');
    expect(session.getSnapshot().preflight?.rawHex).toBe('00');
    expect(session.getSnapshot().capture.some((entry) => entry.kind === 'tx')).toBe(true);
    expect(session.getSnapshot().capture.some((entry) => entry.kind === 'rx')).toBe(true);
  });

  it('captures the simulator Type2 preflight end to end', async () => {
    const lock = new FakeLock();
    const selector: TransportSelector = {
      select: async (kind) => {
        expect(kind).toBe('simulator');
        return new SimulatorTransport();
      },
    };
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect('simulator');
    await session.runPreflight();

    expect(session.getSnapshot().transportKind).toBe('simulator');
    expect(session.getSnapshot().captureState).toBe('captured');
    expect(session.getSnapshot().preflight?.mode).toBe('type2');
    expect(session.getSnapshot().preflight?.statusHex).toBe('80808280869a8080');
    expect(session.getSnapshot().capture.some((entry) => entry.kind === 'tx')).toBe(true);
    expect(session.getSnapshot().capture.some((entry) => entry.kind === 'rx')).toBe(true);
  });

  it('notifies subscribers on state changes', async () => {
    const session = new DeviceSession(
      new FakeSelector(),
      new CaptureLog(new FixedClock()),
      new FakeLock(),
    );
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);

    await session.acquireLock();
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('reports an in-use lock without connecting', async () => {
    const selector = new FakeSelector();
    const session = new DeviceSession(
      selector,
      new CaptureLog(new FixedClock()),
      new FakeLock(false),
    );

    await session.acquireLock();
    await session.connect();

    expect(session.getSnapshot().lockState).toBe('in-use');
    expect(session.getSnapshot().error?.code).toBe('device-in-use');
    expect(selector.select).not.toHaveBeenCalled();
  });

  it('does not write during connect', async () => {
    const lock = new FakeLock();
    const selector = new FakeSelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect();

    expect(selector.last?.written).toHaveLength(0);
  });

  it('reports a silent device as failed, not capture-only', async () => {
    const lock = new FakeLock();
    const selector = new FakeSelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect();
    await session.runPreflight();

    expect(session.getSnapshot().captureState).toBe('failed');
    expect(session.getSnapshot().preflight?.status).toBe('failed');
    expect(session.getSnapshot().capture.some((entry) => entry.code === 'timeout')).toBe(true);
  });

  it('does not log tx when write fails', async () => {
    const lock = new FakeLock();
    const selector = new FakeSelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect();
    const transport = selector.last;
    if (!transport) throw new Error('Fake transport was not created.');
    transport.writeError = new TransportError('device-unavailable', 'write failed');

    await session.runPreflight();

    expect(session.getSnapshot().captureState).toBe('failed');
    expect(session.getSnapshot().capture.some((entry) => entry.kind === 'tx')).toBe(false);
  });

  it('resends once after NAK and captures the retry response', async () => {
    const lock = new FakeLock();
    const selector = new FakeSelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock, 0);

    await session.acquireLock();
    await session.connect();
    const transport = selector.last;
    if (!transport) throw new Error('Fake transport was not created.');
    transport.rx.push(Uint8Array.from([0x15]), SIMULATOR_PREFLIGHT_RESPONSE);

    await session.runPreflight();

    expect(transport.written).toHaveLength(2);
    expect(session.getSnapshot().captureState).toBe('captured');
    expect(session.getSnapshot().preflight?.mode).toBe('type2');
  });

  it('supports a second simulator preflight', async () => {
    const lock = new FakeLock();
    const selector: TransportSelector = {
      select: async () => new SimulatorTransport(),
    };
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock, 0);

    await session.acquireLock();
    await session.connect('simulator');
    await session.runPreflight();
    await session.runPreflight();

    expect(session.getSnapshot().captureState).toBe('captured');
    expect(session.getSnapshot().preflight?.mode).toBe('type2');
  });

  it('replays the exact local read sequence after the preflight', async () => {
    const lock = new FakeLock();
    const selector = new FakeSelector();
    const session = new DeviceSession(selector, new CaptureLog(new FixedClock()), lock);

    await session.acquireLock();
    await session.connect();
    const transport = selector.last;
    if (!transport) throw new Error('Fake transport was not created.');

    const hex = (value: string) =>
      Uint8Array.from((value.match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)));
    transport.rx.push(
      SIMULATOR_PREFLIGHT_RESPONSE,
      hex('160130303335213030363630090480808280869a8080053036313903'),
      hex('1601303033372230303f3f300931090480808280869a8080053036363803'),
      hex('1601303033392330303f3f3009504c4e090480808280869a8080053037323403'),
      hex(
        '1601303034372430303f3f300930382d30332d32342030393a30383a3035090480808280869a8080053039383f03',
      ),
      hex('1601303033392530303f3f3009504c4e090480808280869a8080053037323603'),
      hex(
        '1601303034372630303f3f300932362d31332d33362033303a33313a3539090480808280869a8080053039393403',
      ),
    );

    await session.runPreflight();
    await session.runReadLocal();

    expect(session.getSnapshot().readState).toBe('read');
    expect(session.getSnapshot().localRead).toMatchObject({
      barcode: '1',
      localName: 'PLN',
      currencyDate: '08-03-24 09:08:05',
      pgmLocalName: 'PLN',
      pgmCurrencyDate: '26-13-36 30:31:59',
    });
    expect(transport.written).toHaveLength(1 + READ_LOCAL_FRAMES.length);
    expect(transport.written.every((frame) => !frame.includes(0xff))).toBe(true);

    const status = Uint8Array.from([0x80, 0x80, 0x82, 0x80, 0x86, 0x9a, 0x80, 0x80]);
    for (const value of ['USD', '392100', 'EUR', '439250', 'US Dollar', '1', 'Euro', '0']) {
      const body = Uint8Array.from([
        0x01,
        ...new TextEncoder().encode(`0039'00??0\t${value}\t`),
        0x04,
        ...status,
        0x05,
      ]);
      const sum = body.slice(1).reduce((total, byte) => total + byte, 0) & 0xffff;
      const bcc = Array.from(
        { length: 4 },
        (_, index) => 0x30 + ((sum >> ((3 - index) * 4)) & 0x0f),
      );
      transport.rx.push(Uint8Array.from([...body, ...bcc, 0x03]));
    }

    await session.runReadForeign();
    expect(session.getSnapshot().foreignReadState).toBe('read');
    expect(session.getSnapshot().foreignRead).toMatchObject({
      slot0Name: 'USD',
      slot0Rate: '392100',
      slot1Name: 'EUR',
      slot1Rate: '439250',
      slot0FullName: 'US Dollar',
      slot0ChangeAfterZ: '1',
      slot1FullName: 'Euro',
      slot1ChangeAfterZ: '0',
    });
    expect(transport.written).toHaveLength(1 + READ_LOCAL_FRAMES.length + 8);
    expect(transport.written.every((frame) => !frame.includes(0xff))).toBe(true);

    for (const value of ['Konwerter', '39251', '1']) {
      const body = Uint8Array.from([
        0x01,
        ...new TextEncoder().encode(`0039'00??0\t${value}\t`),
        0x04,
        ...status,
        0x05,
      ]);
      const sum = body.slice(1).reduce((total, byte) => total + byte, 0) & 0xffff;
      const bcc = Array.from(
        { length: 4 },
        (_, index) => 0x30 + ((sum >> ((3 - index) * 4)) & 0x0f),
      );
      transport.rx.push(Uint8Array.from([...body, ...bcc, 0x03]));
    }

    await session.runReadConverter();
    expect(session.getSnapshot().converterReadState).toBe('read');
    expect(session.getSnapshot().converterRead).toMatchObject({
      name: 'Konwerter',
      rate: '39251',
      printFlag: '1',
    });
    expect(transport.written).toHaveLength(1 + READ_LOCAL_FRAMES.length + 11);
    expect(transport.written.every((frame) => !frame.includes(0xff))).toBe(true);
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
