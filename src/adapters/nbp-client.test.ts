import { describe, expect, it } from 'vitest';
import { NbpClient } from './nbp-client';

const raw = JSON.stringify([
  {
    table: 'A',
    effectiveDate: '2026-11-06',
    rates: [
      { currency: 'dolar amerykański', code: 'USD', mid: 3.6542 },
      { currency: 'euro', code: 'EUR', mid: 4.231 },
    ],
  },
]);

describe('NbpClient', () => {
  it('fetches and selects the previous table', async () => {
    const client = new NbpClient(
      (async () => new Response(raw, { status: 200 })) as typeof fetch,
      () => new Date('2026-11-07T12:00:00Z'),
    );
    const snapshot = await client.fetchPreviousRates();

    expect(snapshot.table.effectiveDate).toBe('2026-11-06');
    expect(snapshot.stale).toBe(false);
    expect(snapshot.table.rates).toHaveLength(2);
  });

  it('maps a failed request to an NbpError', async () => {
    const client = new NbpClient(
      (async () => new Response('nope', { status: 503 })) as typeof fetch,
      () => new Date('2026-11-07T12:00:00Z'),
    );

    await expect(client.fetchPreviousRates()).rejects.toMatchObject({ code: 'fetch-failed' });
  });
});
