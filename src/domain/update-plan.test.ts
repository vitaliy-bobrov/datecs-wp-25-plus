import { describe, expect, it } from 'vitest';
import { buildUpdatePlan, midToRaw } from './update-plan';

const foreign = {
  slot0Name: 'USD',
  slot0Rate: '39251',
  slot1Name: 'EUR',
  slot1Rate: '43955',
  slot0FullName: 'dolar amerykański',
  slot0ChangeAfterZ: '0',
  slot1FullName: 'euro',
  slot1ChangeAfterZ: '0',
};
const converter = { name: 'USD', rate: '39251', printFlag: '1' };

describe('update preview plan', () => {
  it('converts the exact NBP four-decimal mid to a wire integer', () => {
    expect(midToRaw('3.9321')).toBe(39321);
    expect(midToRaw('4.3925')).toBe(43925);
    expect(midToRaw('3.9')).toBeNull();
  });

  it('matches by code and builds an exact, read-only plan', () => {
    const plan = buildUpdatePlan({
      foreign,
      converter,
      nbp: { USD: '3.9321', EUR: '4.3925' },
      printConverter: true,
    });
    expect(plan?.usd).toMatchObject({ code: 'USD', currentRaw: '39251', targetRaw: 39321 });
    expect(plan?.eur).toMatchObject({ code: 'EUR', currentRaw: '43955', targetRaw: 43925 });
    expect(plan?.converter).toMatchObject({
      name: 'USD',
      targetRaw: 39321,
      printFlag: '1',
      printChanged: false,
    });
  });

  it('returns null when a code or NBP mid is missing', () => {
    expect(
      buildUpdatePlan({
        foreign: { ...foreign, slot1Name: 'GBP' },
        converter,
        nbp: { USD: '3.9321', EUR: '4.3925' },
        printConverter: true,
      }),
    ).toBeNull();
    expect(
      buildUpdatePlan({
        foreign,
        converter,
        nbp: { USD: '3.9321' },
        printConverter: true,
      }),
    ).toBeNull();
  });
});
