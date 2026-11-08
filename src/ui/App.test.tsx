import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeviceSession, SessionSnapshot } from '../session/device-session';
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

describe('App read lifecycle', () => {
  it('gates Connect and Read behind the idle acknowledgement', () => {
    const html = renderToStaticMarkup(<App session={sessionFor(base)} />);

    expect(html).toContain('Cashier is idle and no sale is open');
    expect(html).toContain('Connect and Read stay disabled');
    expect(html).not.toMatch(/checked=""/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Connect cashier<\/button>/);
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Read cashier<\/button>/);
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
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Read again<\/button>/);
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
    expect(html).toContain('confirmation was cleared after the failed read');
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
    expect(html).toContain('Tick the idle acknowledgement before writing.');
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
});
