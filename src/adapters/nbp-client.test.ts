import { describe, expect, it } from 'vitest';
import { NbpClient } from './nbp-client';

const raw = `[
  {"table":"A","effectiveDate":"2026-11-07","rates":[
    {"currency":"dolar amerykański","code":"USD","mid":3.9321},
    {"currency":"euro","code":"EUR","mid":4.5100}
  ]},
  {"table":"A","effectiveDate":"2026-11-06","rates":[
    {"currency":"dolar amerykański","code":"USD","mid":3.6542},
    {"currency":"euro","code":"EUR","mid":4.2310}
  ]}
]`;

describe('NbpClient', () => {
  it('requests the last two tables and selects the previous one', async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const client = new NbpClient(
      (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ input, init });
        return new Response(raw, { status: 200 });
      }) as typeof fetch,
      () => new Date('2026-11-07T12:00:00Z'),
    );
    const snapshot = await client.fetchPreviousRates();

    expect(String(calls[0]?.input)).toContain('/tables/A/last/2/');
    expect(snapshot.table.effectiveDate).toBe('2026-11-06');
    expect(snapshot.table.rates.find((rate) => rate.code === 'EUR')?.mid).toBe('4.2310');
    expect(snapshot.stale).toBe(false);
  });

  it('maps a failed request to an NbpError', async () => {
    const client = new NbpClient(
      (async () => new Response('nope', { status: 503 })) as typeof fetch,
      () => new Date('2026-11-07T12:00:00Z'),
    );

    await expect(client.fetchPreviousRates()).rejects.toMatchObject({ code: 'fetch-failed' });
  });
});
