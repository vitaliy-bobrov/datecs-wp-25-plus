import type { CurrencyCode } from '../domain/rates';
import {
  compareRawRate,
  differenceTone,
  formatDifference,
  formatPercent,
  formatRateValue,
} from '../domain/rates';
import type { NbpState } from './NbpPanel';

interface RateComparisonProps {
  nbp: NbpState;
  cashier: Partial<Record<CurrencyCode, string>>;
}

const CODES: CurrencyCode[] = ['USD', 'EUR'];

export function RateComparison({ nbp, cashier }: RateComparisonProps) {
  const hasCashier = CODES.some((code) => cashier[code]);
  return (
    <section className="card comparison" aria-labelledby="comparison-heading">
      <div className="card-heading">
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
        <table className="comparison-table">
          <thead>
            <tr>
              <th scope="col">Currency</th>
              <th scope="col">Cashier rate</th>
              <th scope="col">NBP reference</th>
              <th scope="col">Difference vs NBP</th>
            </tr>
          </thead>
          <tbody>
            {CODES.map((code) => {
              const raw = cashier[code];
              const mid = nbp.data.table.rates.find((rate) => rate.code === code)?.mid;
              const result = raw && mid ? compareRawRate(raw, mid) : null;
              return (
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
                    {result
                      ? `${formatDifference(result.difference)} · ${formatPercent(result.percent)}`
                      : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
