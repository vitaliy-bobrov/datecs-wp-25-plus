import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { NbpSnapshot } from '../domain/nbp';
import type { NbpState } from './NbpPanel';
import { RateComparison } from './RateComparison';

const table: NbpSnapshot = {
  today: '2026-11-07',
  ageDays: 1,
  stale: false,
  fetchedAt: '2026-11-07T10:00:00.000Z',
  table: {
    effectiveDate: '2026-11-06',
    no: '215/A/NBP/2026',
    table: 'A',
    rates: [
      { code: 'USD', currency: 'dolar amerykański', mid: '3.9321' },
      { code: 'EUR', currency: 'euro', mid: '4.3925' },
    ],
  },
};

const ready: NbpState = { status: 'ready', data: table };

describe('RateComparison', () => {
  it('keeps the empty cashier state', () => {
    const html = renderToStaticMarkup(<RateComparison nbp={ready} cashier={{}} readFresh />);
    expect(html).toContain('Read foreign slots to compare the cashier rates.');
  });

  it('renders a desktop table and semantic records with signed differences', () => {
    const html = renderToStaticMarkup(
      <RateComparison nbp={ready} cashier={{ USD: '39251', EUR: '43955' }} readFresh />,
    );
    expect(html).toContain('class="comparison-table desktop-table"');
    expect(html).toContain('class="records"');
    expect(html).toContain('Cashier rate');
    expect(html).toContain('Difference vs NBP');
    expect(html).toContain('−0.0070');
    expect(html).toContain('Difference: minus 0.0070 PLN, minus 0.18 percent.');
    expect(html).toContain('+0.0030');
  });

  it('keeps the comparison table with retained NBP data during refresh', () => {
    const html = renderToStaticMarkup(
      <RateComparison
        nbp={{ status: 'loading', data: table }}
        cashier={{ USD: '39251', EUR: '43955' }}
        readFresh
      />,
    );
    expect(html).toContain('3.9321');
    expect(html).toContain('−0.0070');
  });
  it('labels partial values without pretending they are a complete read', () => {
    const html = renderToStaticMarkup(
      <RateComparison nbp={ready} cashier={{ USD: '39251', EUR: '43955' }} readFresh={false} />,
    );
    expect(html).toContain('Partial read');
    expect(html).not.toContain('Last read');
  });

  it('shows refreshing instead of a stale cache while a read is running', () => {
    const html = renderToStaticMarkup(
      <RateComparison
        nbp={ready}
        cashier={{ USD: '39251', EUR: '43955' }}
        readFresh={false}
        refreshing
        readAt="2026-11-07T10:15:00.000Z"
      />,
    );
    expect(html).toContain('Refreshing');
    expect(html).not.toContain('Last read');
  });
  it('labels the last complete read and withholds differences when the read is not fresh', () => {
    const html = renderToStaticMarkup(
      <RateComparison
        nbp={ready}
        cashier={{ USD: '39251', EUR: '43955' }}
        readFresh={false}
        readAt="2026-11-07T10:15:00.000Z"
      />,
    );
    expect(html).toMatch(/Last read\s+<span/);
    expect(html).toContain('differences are unavailable');
    expect(html).toContain('3.9251');
    expect(html).toContain('4.3955');
    expect(html).not.toContain('−0.0070');
    expect(html).not.toContain('+0.0030');
  });

  it('shows refreshing while a read is in flight', () => {
    const html = renderToStaticMarkup(
      <RateComparison nbp={ready} cashier={{}} readFresh={false} refreshing />,
    );
    expect(html).toContain('Refreshing');
    expect(html).toContain('Read foreign slots to compare the cashier rates.');
  });
});
