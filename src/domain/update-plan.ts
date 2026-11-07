import { type CurrencyCode, compareRawRate, parseRawRate } from './rates';

export interface ForeignRecordSnapshot {
  slot0Name?: string;
  slot0Rate?: string;
  slot1Name?: string;
  slot1Rate?: string;
  slot0FullName?: string;
  slot0ChangeAfterZ?: string;
  slot1FullName?: string;
  slot1ChangeAfterZ?: string;
}

export interface ConverterSnapshot {
  name?: string;
  rate?: string;
  printFlag?: string;
}

export interface UpdatePlanInput {
  foreign?: ForeignRecordSnapshot;
  converter?: ConverterSnapshot;
  nbp: Partial<Record<CurrencyCode, string>>;
  printConverter: boolean;
}

interface PlannedRate {
  code: CurrencyCode;
  currentRaw?: string;
  current: number | null;
  targetRaw: number;
  target: number;
  difference: number | null;
  percent: number | null;
  fullName?: string;
  changeAfterZ?: string;
}

export interface UpdatePlan {
  hasChanges: boolean;
  usd: PlannedRate;
  eur: PlannedRate;
  converter?: {
    name?: string;
    currentRaw?: string;
    current: number | null;
    targetRaw: number;
    target: number;
    printFlag: '0' | '1';
    printChanged: boolean;
  };
  warnings: string[];
}

export function midToRaw(mid: string): number | null {
  const match = /^(\d+)\.(\d{4})$/.exec(mid);
  if (!match) return null;
  return Number(`${match[1]}${match[2]}`);
}

function planRate(
  code: CurrencyCode,
  currentRaw: string | undefined,
  mid: string | undefined,
  fullName?: string,
  changeAfterZ?: string,
): PlannedRate | null {
  const targetRaw = mid ? midToRaw(mid) : null;
  if (targetRaw === null) return null;
  const comparison = mid ? compareRawRate(currentRaw, mid) : null;
  return {
    code,
    currentRaw,
    current: parseRawRate(currentRaw),
    targetRaw,
    target: targetRaw / 10000,
    difference: comparison?.difference ?? null,
    percent: comparison?.percent ?? null,
    fullName,
    changeAfterZ,
  };
}

export function buildUpdatePlan(input: UpdatePlanInput): UpdatePlan | null {
  const { foreign, converter, nbp } = input;
  if (!foreign) return null;

  const slot0 = { name: foreign.slot0Name, rate: foreign.slot0Rate };
  const slot1 = { name: foreign.slot1Name, rate: foreign.slot1Rate };
  const usdSource = slot0.name === 'USD' ? slot0 : slot1.name === 'USD' ? slot1 : null;
  const eurSource = slot0.name === 'EUR' ? slot0 : slot1.name === 'EUR' ? slot1 : null;
  if (!usdSource || !eurSource) return null;

  const usd = planRate(
    'USD',
    usdSource.rate,
    nbp.USD,
    usdSource === slot0 ? foreign.slot0FullName : foreign.slot1FullName,
    usdSource === slot0 ? foreign.slot0ChangeAfterZ : foreign.slot1ChangeAfterZ,
  );
  const eur = planRate(
    'EUR',
    eurSource.rate,
    nbp.EUR,
    eurSource === slot0 ? foreign.slot0FullName : foreign.slot1FullName,
    eurSource === slot0 ? foreign.slot0ChangeAfterZ : foreign.slot1ChangeAfterZ,
  );
  if (!usd || !eur) return null;

  const printFlag = input.printConverter ? '1' : '0';
  const converterTargetRaw = midToRaw(nbp.USD ?? '');
  const converterPlan =
    converter && converterTargetRaw !== null
      ? {
          name: converter.name,
          currentRaw: converter.rate,
          current: parseRawRate(converter.rate),
          targetRaw: converterTargetRaw,
          target: converterTargetRaw / 10000,
          printFlag: printFlag as '0' | '1',
          printChanged: converter.printFlag !== printFlag,
        }
      : undefined;

  const warnings: string[] = [];
  if (converter?.name && converter.name !== 'USD') {
    warnings.push(`Converter is named ${converter.name}, not USD.`);
  }
  if (
    converter &&
    converter.rate !== undefined &&
    converter.rate !== converterTargetRaw?.toString()
  ) {
    warnings.push('Converter rate differs from the USD slot target.');
  }
  if (converter && converter.printFlag !== printFlag) {
    warnings.push('Print-converter flag will change.');
  }

  const converterChanged =
    converterPlan !== undefined &&
    (converter?.rate !== String(converterPlan.targetRaw) ||
      converter?.printFlag !== converterPlan.printFlag);
  const hasChanges =
    (usd.currentRaw !== undefined && usd.currentRaw !== String(usd.targetRaw)) ||
    (eur.currentRaw !== undefined && eur.currentRaw !== String(eur.targetRaw)) ||
    converterChanged;

  return { hasChanges, usd, eur, converter: converterPlan, warnings };
}
