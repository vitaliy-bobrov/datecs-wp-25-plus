export interface NbpRate {
  code: 'USD' | 'EUR';
  currency: string;
  mid: string;
}

export interface NbpTable {
  effectiveDate: string;
  no?: string;
  table?: string;
  rates: NbpRate[];
}

export interface NbpSnapshot {
  table: NbpTable;
  today: string;
  ageDays: number;
  stale: boolean;
  fetchedAt: string;
}

export type NbpErrorCode = 'fetch-failed' | 'timeout' | 'malformed' | 'unavailable';

export class NbpError extends Error {
  readonly code: NbpErrorCode;

  constructor(code: NbpErrorCode, message: string) {
    super(message);
    this.name = 'NbpError';
    this.code = code;
  }
}

export function warsawDate(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Warsaw',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const value = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = value('year');
  const month = value('month');
  const day = value('day');
  if (!year || !month || !day) throw new Error('Unable to resolve the Europe/Warsaw date.');
  return `${year}-${month}-${day}`;
}

function dayNumber(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) throw new Error(`Invalid date: ${date}`);
  return Math.floor(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000,
  );
}

export function ageInCalendarDays(today: string, effectiveDate: string): number {
  return dayNumber(today) - dayNumber(effectiveDate);
}

export function selectPreviousTable(tables: NbpTable[], today: string): NbpTable | null {
  const eligible = tables
    .filter(
      (table) => /^\d{4}-\d{2}-\d{2}$/.test(table.effectiveDate) && table.effectiveDate < today,
    )
    .sort((left, right) => right.effectiveDate.localeCompare(left.effectiveDate));
  return eligible[0] ?? null;
}

export function parseNbpTables(raw: string): NbpTable[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new NbpError('malformed', 'The NBP response is not valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new NbpError('malformed', 'The NBP response is not a table array.');
  }

  const rawMids = Array.from(
    raw.matchAll(/"mid"\s*:\s*(\d+(?:\.\d+)?)/g),
    (match) => match[1] ?? '',
  );
  let midIndex = 0;
  const tables: NbpTable[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (typeof record.effectiveDate !== 'string') continue;
    if (!Array.isArray(record.rates)) continue;

    const rates: NbpRate[] = [];
    for (const rateEntry of record.rates) {
      const rawMid = rawMids[midIndex];
      midIndex += 1;
      if (!rateEntry || typeof rateEntry !== 'object') continue;
      const rate = rateEntry as Record<string, unknown>;
      if (rate.code !== 'USD' && rate.code !== 'EUR') continue;
      if (typeof rate.currency !== 'string') continue;
      const mid = typeof rate.mid === 'string' ? rate.mid : (rawMid ?? '');
      if (!/^\d+(?:\.\d+)?$/.test(mid)) continue;
      rates.push({ code: rate.code, currency: rate.currency, mid });
    }

    if (rates.length === 2) {
      tables.push({
        effectiveDate: record.effectiveDate,
        no: typeof record.no === 'string' ? record.no : undefined,
        table: typeof record.table === 'string' ? record.table : undefined,
        rates,
      });
    }
  }

  if (tables.length === 0) {
    throw new NbpError('unavailable', 'No USD/EUR table was found in the NBP response.');
  }
  return tables;
}

export function toSnapshot(table: NbpTable, today: string, fetchedAt: string): NbpSnapshot {
  const ageDays = ageInCalendarDays(today, table.effectiveDate);
  return {
    table,
    today,
    ageDays,
    stale: ageDays > 7,
    fetchedAt,
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof NbpError) {
    switch (error.code) {
      case 'timeout':
        return 'NBP did not respond in time. Try again.';
      case 'fetch-failed':
        return 'NBP could not be reached. Check the connection and retry.';
      case 'malformed':
        return 'The NBP response was malformed. Retry later.';
      case 'unavailable':
        return 'NBP did not return a USD/EUR table. Retry later.';
    }
  }
  return 'NBP rates are unavailable. Retry later.';
}
