import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NbpPanel } from './NbpPanel';

const snapshot = {
  today: '2026-11-07',
  ageDays: 8,
  stale: true,
  fetchedAt: '2026-11-07T10:00:00.000Z',
  table: {
    effectiveDate: '2026-10-30',
    no: '215/A/NBP/2026',
    table: 'A',
    rates: [
      { code: 'USD' as const, currency: 'dolar amerykański', mid: '3.9321' },
      { code: 'EUR' as const, currency: 'euro', mid: '4.3925' },
    ],
  },
};

describe('NbpPanel', () => {
  it('renders ready, stale and PLN provenance', () => {
    const html = renderToStaticMarkup(
      <NbpPanel state={{ status: 'ready', data: snapshot }} onRefresh={() => undefined} />,
    );
    expect(html).toContain('Stale');
    expect(html).toContain('3.9321');
    expect(html).toContain('PLN per 1 USD');
    expect(html).toContain('215/A/NBP/2026');
    expect(html).toContain('https://nbp.pl/statystyka-i-sprawozdawczosc/kursy/');
    expect(html).not.toContain('https://api.nbp.pl/');
  });

  it('keeps the previous table visible while refreshing', () => {
    const html = renderToStaticMarkup(
      <NbpPanel state={{ status: 'loading', data: snapshot }} onRefresh={() => undefined} />,
    );
    expect(html).toContain('Refreshing…');
    expect(html).toContain('3.9321');
    expect(html).toContain('aria-busy="true"');
  });

  it('keeps the previous table with an explicit refresh failure', () => {
    const html = renderToStaticMarkup(
      <NbpPanel
        state={{ status: 'error', message: 'NBP is unavailable.', data: snapshot }}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain('NBP refresh failed: NBP is unavailable.');
    expect(html).toContain('Showing the previous table.');
    expect(html).toContain('3.9321');
  });
  it('renders the error and retry state', () => {
    const html = renderToStaticMarkup(
      <NbpPanel
        state={{ status: 'error', message: 'NBP is unavailable' }}
        onRefresh={() => undefined}
      />,
    );
    expect(html).toContain('NBP is unavailable');
    expect(html).toContain('Retry');
  });
});
