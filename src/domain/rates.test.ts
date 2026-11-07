import { describe, expect, it } from 'vitest';
import { compareRawRate, formatDifference, formatPercent, parseRawRate } from './rates';

describe('rate normalization', () => {
  it('scales the four-decimal cashier rate', () => {
    expect(parseRawRate('39251')).toBe(3.9251);
    expect(parseRawRate('43955')).toBe(4.3955);
    expect(parseRawRate('')).toBeNull();
    expect(parseRawRate('3.9251')).toBeNull();
  });

  it('compares against the NBP mid', () => {
    const usd = compareRawRate('39251', '3.9321');
    const eur = compareRawRate('43955', '4.3925');
    expect(usd?.difference).toBeCloseTo(-0.007);
    expect(usd?.percent).toBeCloseTo(-0.178);
    expect(eur?.difference).toBeCloseTo(0.003);
    expect(eur?.percent).toBeCloseTo(0.068);
    expect(formatDifference(usd?.difference ?? 0)).toBe('-0.0070');
    expect(formatPercent(usd?.percent ?? 0)).toBe('-0.18%');
  });
});
