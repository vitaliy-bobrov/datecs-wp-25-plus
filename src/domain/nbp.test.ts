import { describe, expect, it } from 'vitest';
import {
  ageInCalendarDays,
  NbpError,
  type NbpTable,
  parseNbpTables,
  selectPreviousTable,
  toSnapshot,
  warsawDate,
} from './nbp';

const tables: NbpTable[] = [
  {
    effectiveDate: '2026-11-05',
    rates: [
      { code: 'USD', currency: 'dolar amerykański', mid: '3.6400' },
      { code: 'EUR', currency: 'euro', mid: '4.2200' },
    ],
  },
  {
    effectiveDate: '2026-11-06',
    rates: [
      { code: 'USD', currency: 'dolar amerykański', mid: '3.6542' },
      { code: 'EUR', currency: 'euro', mid: '4.2310' },
    ],
  },
];

const raw = `[
  {"table":"A","no":"216/A/NBP/2026","effectiveDate":"2026-11-06","rates":[
    {"currency":"dolar amerykański","code":"USD","mid":3.6542},
    {"currency":"euro","code":"EUR","mid":4.2310}
  ]}
]`;

describe('NBP reference', () => {
  it('uses the Europe/Warsaw date, not UTC', () => {
    expect(warsawDate(new Date('2026-11-06T23:30:00Z'))).toBe('2026-11-07');
    expect(warsawDate(new Date('2026-11-07T00:30:00Z'))).toBe('2026-11-07');
  });

  it('selects the newest effective date strictly before today, regardless of API order', () => {
    expect(selectPreviousTable(tables, '2026-11-07')?.effectiveDate).toBe('2026-11-06');
    expect(selectPreviousTable(tables, '2026-11-06')?.effectiveDate).toBe('2026-11-05');
    expect(selectPreviousTable(tables, '2026-11-05')).toBeNull();
  });

  it('keeps mid values as exact strings, including trailing zeros', () => {
    const parsed = parseNbpTables(raw);
    expect(parsed[0]?.rates.find((rate) => rate.code === 'USD')?.mid).toBe('3.6542');
    expect(parsed[0]?.rates.find((rate) => rate.code === 'EUR')?.mid).toBe('4.2310');
  });

  it('marks only a table older than seven calendar days as stale', () => {
    const table = tables[1];
    if (!table) throw new Error('Test table is missing.');
    expect(ageInCalendarDays('2026-11-20', '2026-11-06')).toBe(14);
    expect(toSnapshot(table, '2026-11-13', '2026-11-13T12:00:00.000Z').stale).toBe(false);
    expect(toSnapshot(table, '2026-11-14', '2026-11-14T12:00:00.000Z').stale).toBe(true);
  });

  it('rejects malformed JSON and missing currencies', () => {
    expect(() => parseNbpTables('{')).toThrow(NbpError);
    expect(() =>
      parseNbpTables(JSON.stringify([{ effectiveDate: '2026-11-06', rates: [] }])),
    ).toThrow(NbpError);
  });
});
