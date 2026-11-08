import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DeviceSession, SessionSnapshot } from '../session/device-session';
import { INTERRUPTION_MARKER_KEY } from '../session/interruption-marker';
import { MemoryStorage } from '../test/storage';
import { App } from './App';

const base: SessionSnapshot = {
  phase: 'idle',
  lockState: 'held',
  captureState: 'idle',
  readState: 'idle',
  foreignReadState: 'idle',
  converterReadState: 'idle',
  writeTestState: 'idle',
  updateState: 'idle',
  capture: [],
};

const cachedPair = {
  foreignRead: {
    slot0Name: 'USD',
    slot0Rate: '39251',
    slot1Name: 'EUR',
    slot1Rate: '43955',
  },
  converterRead: { name: 'Konwerter', rate: '39251', printFlag: '1' },
  at: '2026-11-07T10:15:00.000Z',
};

const completeRead: SessionSnapshot = {
  ...base,
  phase: 'connected',
  transportKind: 'webserial',
  captureState: 'captured',
  readState: 'read',
  foreignReadState: 'read',
  converterReadState: 'read',
  foreignRead: cachedPair.foreignRead,
  converterRead: cachedPair.converterRead,
  lastRead: cachedPair,
};

function sessionFor(snapshot: SessionSnapshot): DeviceSession {
  return {
    subscribe: () => () => undefined,
    getSnapshot: () => snapshot,
    acquireLock: async () => undefined,
  } as unknown as DeviceSession;
}

const serialDescriptor = Object.getOwnPropertyDescriptor(globalThis.navigator, 'serial');

beforeAll(() => {
  Object.defineProperty(globalThis.navigator, 'serial', { value: {}, configurable: true });
});

afterAll(() => {
  if (serialDescriptor) {
    Object.defineProperty(globalThis.navigator, 'serial', serialDescriptor);
  } else {
    Reflect.deleteProperty(globalThis.navigator, 'serial');
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('App read lifecycle', () => {
  it('does not gate Connect and Read behind an idle checkbox', () => {
    const html = renderToStaticMarkup(<App session={sessionFor(base)} />);

    expect(html).not.toContain('Cashier is idle and no sale is open');
    expect(html).not.toContain('idle-gate-hint');
    expect(html).toContain('Connecting starts the preflight');
    expect(html).toMatch(/<button[^>]*aria-disabled="false"[^>]*>Connect cashier<\/button>/);
  });

  it('fills the existing status slot with a failed read and keeps the cached pair', () => {
    const html = renderToStaticMarkup(
      <App
        session={sessionFor({
          ...base,
          phase: 'connected',
          transportKind: 'webserial',
          captureState: 'failed',
          lastRead: cachedPair,
        })}
      />,
    );

    expect(html).toContain('Could not read the cashier.');
    expect(html).toContain('Connection check failed. Check the cable and retry.');
    expect(html).toContain('Last read');
    expect(html).toContain('3.9251');
    expect(html).toContain('4.3955');
    expect(html).toMatch(/<button[^>]*aria-disabled="false"[^>]*>Read again<\/button>/);
    expect(html).not.toContain('class="card panel read-error"');
  });

  it('shows partial foreign values with a Read incomplete message', () => {
    const html = renderToStaticMarkup(
      <App
        session={sessionFor({
          ...base,
          phase: 'connected',
          transportKind: 'webserial',
          captureState: 'captured',
          readState: 'read',
          foreignReadState: 'read',
          converterReadState: 'failed',
          foreignRead: cachedPair.foreignRead,
        })}
      />,
    );

    expect(html).toContain('Read incomplete');
    expect(html).toContain('Update is unavailable; read again.');
    expect(html).toContain('3.9251');
    expect(html).toContain('4.3955');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Review update/);
  });

  it('marks a complete read fresh and shows current records', () => {
    const html = renderToStaticMarkup(<App session={sessionFor(completeRead)} />);

    expect(html).toContain('Cashier records are current.');
    expect(html).not.toContain('Last read');
    expect(html).toContain('3.9251');
    expect(html).toContain('4.3955');
  });

  it('prefers the cached complete pair over partial foreign values', () => {
    const html = renderToStaticMarkup(
      <App
        session={sessionFor({
          ...completeRead,
          converterReadState: 'failed',
          converterRead: undefined,
          foreignRead: {
            slot0Name: 'USD',
            slot0Rate: '40000',
            slot1Name: 'EUR',
            slot1Rate: '45000',
          },
        })}
      />,
    );

    expect(html).toContain('Read incomplete');
    expect(html).toContain('3.9251');
    expect(html).toContain('last complete read');
  });

  it('does not call a failed update current even when records were restored', () => {
    const html = renderToStaticMarkup(
      <App
        session={sessionFor({
          ...completeRead,
          updateState: 'failed',
          updateResult: {
            backups: { usd: '39251', eur: '43955', converter: '39251', printFlag: '1' },
            targets: { usdRaw: 39321, eurRaw: 43925, converterRaw: 39321, printFlag: '1' },
            outcome: 'restored',
            restored: true,
          },
        })}
      />,
    );

    expect(html).not.toContain('Cashier records are current.');
    expect(html).toContain('Update failed; original records were restored.');
    expect(html).toMatch(/Review update/);
  });

  it('requires the physical-cashier identity confirmation before the update commit', () => {
    const html = renderToStaticMarkup(<App session={sessionFor(base)} />);

    expect(html).toContain('I confirm this is the cashier at the till');
    expect(html).toContain('The device exposes no distinguishing serial');
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Update cashier<\/button>/);
    expect(html).toContain('The update gate is not ready; retry the read or NBP reference.');
    expect(html).toContain('last-read cache');
  });

  it('keeps the register empty when the first read fails', () => {
    const html = renderToStaticMarkup(
      <App
        session={sessionFor({
          ...base,
          phase: 'connected',
          transportKind: 'webserial',
          captureState: 'failed',
        })}
      />,
    );

    expect(html).toContain('Could not read the cashier.');
    expect(html).toContain('Read foreign slots to compare the cashier rates.');
    expect(html).not.toContain('Last read');
  });

  it('shows UPDATE INTERRUPTED from a persisted marker and blocks every write', () => {
    const storage = new MemoryStorage();
    storage.setItem(
      INTERRUPTION_MARKER_KEY,
      JSON.stringify({
        version: 1,
        kind: 'update',
        startedAt: '2026-11-07T10:00:00.000Z',
      }),
    );
    vi.stubGlobal('localStorage', storage);

    const html = renderToStaticMarkup(<App session={sessionFor(completeRead)} />);

    expect(html).toContain('UPDATE INTERRUPTED');
    expect(html).toContain(
      'An update was interrupted; the cashier state is unknown. Read the cashier completely before writing again.',
    );
    expect(html).toContain('Writes and write tests stay blocked');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Test USD rate<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Update cashier<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Run test<\/button>/);
  });

  it('disables the competing keys while a full update is writing', () => {
    const html = renderToStaticMarkup(
      <App session={sessionFor({ ...completeRead, updateState: 'updating' })} />,
    );

    expect(html).toMatch(/<button[^>]*disabled[^>]*>Disconnect<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Clear<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Copy text<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Test USD rate<\/button>/);
    expect(html).toContain('class="state state-updating"');
  });

  it('disables the competing keys while a write test is writing', () => {
    const html = renderToStaticMarkup(
      <App session={sessionFor({ ...completeRead, writeTestState: 'writing' })} />,
    );

    expect(html).toMatch(/<button[^>]*disabled[^>]*>Disconnect<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Clear<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Writing…<\/button>/);
    expect(html).toContain('class="state state-writing"');
  });

  it('blocks write tests after a write test restore failure until a complete read', () => {
    const html = renderToStaticMarkup(
      <App
        session={sessionFor({
          ...completeRead,
          writeTestState: 'failed',
          writeTest: {
            field: 'slot0Rate',
            original: '39251',
            temporary: '39252',
            temporaryReadback: '39252',
            restored: false,
          },
        })}
      />,
    );

    expect(html).toContain('UPDATE INTERRUPTED');
    expect(html).toContain(
      'Writes and write tests stay blocked until a complete read clears the interrupted write.',
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Test USD rate<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Run test<\/button>/);
    expect(html).toContain('A previous write was interrupted; read the cashier completely');
  });

  it('blocks write tests after a restore-failed update until a complete read', () => {
    const html = renderToStaticMarkup(
      <App
        session={sessionFor({
          ...completeRead,
          updateState: 'failed',
          updateResult: {
            backups: { usd: '39251', eur: '43955', converter: '39251', printFlag: '1' },
            targets: { usdRaw: 39321, eurRaw: 43925, converterRaw: 39321, printFlag: '1' },
            outcome: 'restore-failed',
            restored: false,
          },
        })}
      />,
    );

    expect(html).toContain('UPDATE INTERRUPTED');
    expect(html).toContain(
      'Writes and write tests stay blocked until a complete read clears the interrupted write.',
    );
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Test USD rate<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Run test<\/button>/);
  });
});
