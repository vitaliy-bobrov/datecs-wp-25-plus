import type { CurrencyCode } from '../domain/rates';
import { compareRawRate, differenceTone, formatRateValue } from '../domain/rates';
import { formatSignedPercent, formatSignedRate } from './format';
import type { NbpState } from './NbpPanel';

interface RateComparisonProps {
  nbp: NbpState;
  cashier: Partial<Record<CurrencyCode, string>>;
}

const CODES: CurrencyCode[] = ['USD', 'EUR'];

function differenceDescription(difference: number, percent: number): string {
  const sign = difference < 0 ? 'minus ' : difference > 0 ? 'plus ' : 'zero ';
  const percentSign = percent < 0 ? 'minus ' : percent > 0 ? 'plus ' : '';
  return `Difference: ${sign}${Math.abs(difference).toFixed(4)} PLN, ${percentSign}${Math.abs(percent).toFixed(2)} percent.`;
}

export function RateComparison({ nbp, cashier }: RateComparisonProps) {
  const hasCashier = CODES.some((code) => cashier[code]);
  const table = nbp.status === 'ready' ? nbp.data.table : null;
  const rows = CODES.map((code) => {
    const raw = cashier[code];
    const mid = table?.rates.find((rate) => rate.code === code)?.mid;
    const result = raw && mid ? compareRawRate(raw, mid) : null;
    return { code, mid, result };
  });

  return (
    <section className="card panel comparison" aria-labelledby="comparison-heading">
      <div className="card-heading panel-head">
        <div>
          <h2 id="comparison-heading">Cashier vs NBP</h2>
          <p className="muted">
            Cashier rates use four implied decimals; NBP uses PLN per unit. Read-only comparison.
          </p>
        </div>
      </div>

      {!hasCashier ? (
        <p className="empty">Read foreign slots to compare the cashier rates.</p>
      ) : nbp.status !== 'ready' ? (
        <p className="empty">NBP reference is not ready.</p>
      ) : (
        <>
          <table className="comparison-table desktop-table">
            <thead>
              <tr>
                <th scope="col">Currency</th>
                <th scope="col">Cashier rate</th>
                <th scope="col">NBP reference</th>
                <th scope="col">Difference vs NBP</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(({ code, mid, result }) => (
                <tr key={code}>
                  <th scope="row">{code}</th>
                  <td>{result ? formatRateValue(result.cashier) : 'not read'}</td>
                  <td>{mid ?? 'n/a'}</td>
                  <td
                    className={[
                      'delta',
                      result ? `delta-${differenceTone(result.difference) ?? 'flat'}` : undefined,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    {result ? (
                      <>
                        <span className="sr-only">
                          {differenceDescription(result.difference, result.percent)}
                        </span>
                        <span aria-hidden="true">
                          {formatSignedRate(result.difference)} ·{' '}
                          {formatSignedPercent(result.percent)}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="records">
            {rows.map(({ code, mid, result }) => (
              <article className="record" key={code}>
                <h3 className="record-title">{code}</h3>
                <dl className="record-list">
                  <dt>Cashier rate</dt>
                  <dd>{result ? formatRateValue(result.cashier) : 'not read'}</dd>
                  <dt>NBP reference</dt>
                  <dd>{mid ?? 'n/a'}</dd>
                  <dt>Difference vs NBP</dt>
                  <dd
                    className={
                      result ? `delta-${differenceTone(result.difference) ?? 'flat'}` : undefined
                    }
                  >
                    {result ? (
                      <>
                        <span className="sr-only">
                          {differenceDescription(result.difference, result.percent)}
                        </span>
                        <span aria-hidden="true">
                          {formatSignedRate(result.difference)} ·{' '}
                          {formatSignedPercent(result.percent)}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </dd>
                </dl>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
