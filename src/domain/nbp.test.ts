import { describe, expect, it } from 'vitest';
import {
  NbpError,
  ageInCalendarDays,
  parseNbpTables,
  selectPreviousTable,
  toSnapshot,
  warsawDate,
  type NbpTable,
} from './nbp';

const tables: NbpTable[] = [
  {
    effectiveDate: '2026-11-06',
    rates: [
      { code: 'USD', currency: 'dolar amerykański', mid: '3.6542' },
      { code: 'EUR', currency: 'euro', mid: '4.2310' },
    ],
  },
  {
    effectiveDate: '2026-11-05',
    rates: [
      { code: 'USD', currency: 'dolar amerykański', mid: '3.6400' },
      { code: 'EUR', currency: 'euro', mid: '4.2200' },
    ],
  },
];

const raw = JSON.stringify([
  {
    table: 'A',
    no: '216/A/NBP/2026',
    effectiveDate: '2026-11-06',
    rates: [
      { currency: 'dolar amerykański', code: 'USD', mid: 3.6542 },
      { currency: 'euro', code: 'EUR', mid: 4.231 },
    ],
  },
]);

describe('NBP reference', () => {
  it('uses the Europe/Warsaw date, not UTC', () => {
    expect(warsawDate(new Date('2026-11-06T23:30:00Z'))).toBe('2026-11-07');
    expect(warsawDate(new Date('2026-11-07T00:30:00Z'))).toBe('2026-11-07');
  });

  it('selects the newest effective date strictly before today', () => {
    expect(selectPreviousTable(tables, '2026-11-07')?.effectiveDate).toBe('2026-11-06');
    expect(selectPreviousTable(tables, '2026-11-06')?.effectiveDate).toBe('2026-11-05');
    expect(selectPreviousTable(tables, '2026-11-05')).toBeNull();
  });

  it('keeps mid values as exact strings', () => {
    const parsed = parseNbpTables(raw);
    expect(parsed[0]?.rates.find((rate) => rate.code === 'USD')?.mid).toBe('3.6542');
    expect(parsed[0]?.rates.find((rate) => rate.code === 'EUR')?.mid).toBe('4.231');
  });

  it('marks a table older than seven calendar days as stale', () => {
    expect(ageInCalendarDays('2026-11-20', '2026-11-06')).toBe(14);
    expect(toSnapshot(tables[0]!, '2026-11-20', '2026-11-20T12:00:00.000Z').stale).toBe(true);
    expect(toSnapshot(tables[0]!, '2026-11-07', '2026-11-07T12:00:00.000Z').stale).toBe(false);
  });

  it('rejects malformed JSON and missing currencies', () => {
    expect(() => parseNbpTables('{')).toThrow(NbpError);
    expect(() => parseNbpTables(JSON.stringify([{ effectiveDate: '2026-11-06', rates: [] }]))).toThrow(NbpError);
  });
});
