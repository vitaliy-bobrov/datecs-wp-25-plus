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
          lastRead: {
            foreignRead: {
              slot0Name: 'USD',
              slot0Rate: '39251',
              slot1Name: 'EUR',
              slot1Rate: '43955',
            },
            converterRead: { name: 'Konwerter', rate: '39251', printFlag: '1' },
            at: '2026-11-07T10:15:00.000Z',
          },
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
          foreignRead: {
            slot0Name: 'USD',
            slot0Rate: '39251',
            slot1Name: 'EUR',
            slot1Rate: '43955',
          },
        })}
      />,
    );

    expect(html).toContain('Read incomplete');
    expect(html).toContain('Read incomplete; no update possible.');
    expect(html).toContain('3.9251');
    expect(html).toContain('4.3955');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Review update/);
  });

  it('requires the physical-cashier identity confirmation before the update commit', () => {
    const html = renderToStaticMarkup(<App session={sessionFor(base)} />);

    expect(html).toContain('I confirm this is the cashier at the till');
    expect(html).toContain('The device exposes no distinguishing serial');
    expect(html).toMatch(/<button[^>]*aria-disabled="true"[^>]*>Update cashier<\/button>/);
    expect(html).toContain('Confirm this is the cashier at the till to enable Update cashier.');
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
