export type CurrencyCode = 'USD' | 'EUR';

export interface RateComparison {
  cashier: number;
  nbp: number;
  difference: number;
  percent: number;
}

export function parseRawRate(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  return Number(value) / 10000;
}

export function compareRawRate(raw: string | undefined, mid: string): RateComparison | null {
  const cashier = parseRawRate(raw);
  const nbp = Number(mid);
  if (cashier === null || !Number.isFinite(nbp) || nbp <= 0) return null;
  const difference = cashier - nbp;
  return { cashier, nbp, difference, percent: (difference / nbp) * 100 };
}

export function formatRateValue(value: number): string {
  return value.toFixed(4);
}

export function formatDifference(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(4)}`;
}

export function formatPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatFlag(value: string | undefined): string {
  if (value === '1') return 'Yes';
  if (value === '0') return 'No';
  return '—';
}

export function differenceTone(
  value: number | null | undefined,
): 'up' | 'down' | 'flat' | undefined {
  if (value === null || value === undefined) return undefined;
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}
