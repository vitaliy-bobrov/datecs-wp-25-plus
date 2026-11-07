import { useMemo, useState } from 'react';
import type { CurrencyCode } from '../domain/rates';
import { differenceTone, formatFlag, formatPercent, formatRateValue } from '../domain/rates';
import {
  buildUpdatePlan,
  type ConverterSnapshot,
  type ForeignRecordSnapshot,
} from '../domain/update-plan';
import type { NbpState } from './NbpPanel';

function targetTone(current: number | null, target: number): string {
  if (current === null) return '';
  return `delta-${differenceTone(target - current) ?? 'flat'}`;
}

interface UpdatePreviewProps {
  foreign?: ForeignRecordSnapshot;
  converter?: ConverterSnapshot;
  nbp: NbpState;
}

export function UpdatePreview({ foreign, converter, nbp }: UpdatePreviewProps) {
  const [printConverter, setPrintConverter] = useState(true);
  const nbpRates = useMemo(() => {
    if (nbp.status !== 'ready') return {};
    const rates: Partial<Record<CurrencyCode, string>> = {};
    for (const rate of nbp.data.table.rates) {
      if (rate.code === 'USD' || rate.code === 'EUR') rates[rate.code] = rate.mid;
    }
    return rates;
  }, [nbp]);

  const plan = useMemo(
    () =>
      buildUpdatePlan({
        foreign,
        converter,
        nbp: nbpRates,
        printConverter,
      }),
    [foreign, converter, nbpRates, printConverter],
  );

  return (
    <section className="card update-preview" aria-labelledby="update-preview-heading">
      <div className="card-heading">
        <div>
          <h2 id="update-preview-heading">Update preview</h2>
          <p className="muted">
            Target values from the NBP reference. Preview only; the write command has not been
            captured and no device write is possible here.
          </p>
        </div>
      </div>

      {nbp.status !== 'ready' ? (
        <p className="empty">NBP reference is not ready.</p>
      ) : !plan ? (
        <p className="empty">Complete the foreign reads and NBP reference to build a preview.</p>
      ) : (
        <>
          <table className="comparison-table plan-table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Current</th>
                <th scope="col">Target</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">USD rate</th>
                <td>{plan.usd.current === null ? '—' : formatRateValue(plan.usd.current)}</td>
                <td className={targetTone(plan.usd.current, plan.usd.target)}>
                  {formatRateValue(plan.usd.target)}
                </td>
              </tr>
              <tr>
                <th scope="row">EUR rate</th>
                <td>{plan.eur.current === null ? '—' : formatRateValue(plan.eur.current)}</td>
                <td className={targetTone(plan.eur.current, plan.eur.target)}>
                  {formatRateValue(plan.eur.target)}
                </td>
              </tr>
              {plan.converter ? (
                <tr>
                  <th scope="row">Converter rate</th>
                  <td>
                    {plan.converter.current === null
                      ? '—'
                      : formatRateValue(plan.converter.current)}
                  </td>
                  <td className={targetTone(plan.converter.current, plan.converter.target)}>
                    {formatRateValue(plan.converter.target)}
                  </td>
                </tr>
              ) : null}
              <tr>
                <th scope="row">Print converter</th>
                <td>
                  {converter?.printFlag === undefined
                    ? '—'
                    : converter.printFlag === '1'
                      ? 'Enabled'
                      : 'Disabled'}
                </td>
                <td>{printConverter ? 'Enabled' : 'Disabled'}</td>
              </tr>
            </tbody>
          </table>

          <dl className="read-values plan-backup">
            <div>
              <dt>USD full name</dt>
              <dd>{plan.usd.fullName ?? '—'}</dd>
            </div>
            <div>
              <dt>EUR full name</dt>
              <dd>{plan.eur.fullName ?? '—'}</dd>
            </div>
            <div>
              <dt>USD change after Z</dt>
              <dd>{formatFlag(plan.usd.changeAfterZ)}</dd>
            </div>
            <div>
              <dt>EUR change after Z</dt>
              <dd>{formatFlag(plan.eur.changeAfterZ)}</dd>
            </div>
          </dl>

          <label className="checkline">
            <input
              type="checkbox"
              checked={printConverter}
              onChange={(event) => setPrintConverter(event.target.checked)}
            />
            <span>Print currency converter after update</span>
          </label>

          {plan.warnings.length > 0 ? (
            <ul className="plan-warnings">
              {plan.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}

          <p className="hint">
            {plan.usd.percent === null || plan.eur.percent === null
              ? 'Difference unavailable for a missing current rate.'
              : `USD ${formatPercent(plan.usd.percent)} · EUR ${formatPercent(plan.eur.percent)} vs NBP.`}{' '}
            This preview does not send or queue any write.
          </p>
        </>
      )}
    </section>
  );
}
