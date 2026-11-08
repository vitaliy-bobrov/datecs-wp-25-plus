import type { CurrencyCode } from '../domain/rates';
import { compareRawRate, differenceTone, formatRateValue, parseRawRate } from '../domain/rates';
import { formatSignedPercent, formatSignedRate } from './format';
import { formatTimestamp } from './log-view';
import type { NbpState } from './NbpPanel';

interface RateComparisonProps {
  nbp: NbpState;
  cashier: Partial<Record<CurrencyCode, string>>;
  readFresh: boolean;
  refreshing?: boolean;
  readAt?: string;
}

const CODES: CurrencyCode[] = ['USD', 'EUR'];

function differenceDescription(difference: number, percent: number): string {
  const sign = difference < 0 ? 'minus ' : difference > 0 ? 'plus ' : 'zero ';
  const percentSign = percent < 0 ? 'minus ' : percent > 0 ? 'plus ' : '';
  return `Difference: ${sign}${Math.abs(difference).toFixed(4)} PLN, ${percentSign}${Math.abs(percent).toFixed(2)} percent.`;
}

function formatReadTime(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return formatTimestamp(iso);
}

export function RateComparison({
  nbp,
  cashier,
  readFresh,
  refreshing = false,
  readAt,
}: RateComparisonProps) {
  const hasCashier = CODES.some((code) => cashier[code]);
  const table = nbp.data?.table ?? null;
  const rows = CODES.map((code) => {
    const raw = cashier[code];
    const mid = table?.rates.find((rate) => rate.code === code)?.mid;
    const cashierValue = parseRawRate(raw);
    const result = readFresh && raw && mid ? compareRawRate(raw, mid) : null;
    return { code, mid, cashierValue, result };
  });
  const readTime = formatReadTime(readAt);
  const badge = refreshing ? (
    <span className="state state-refreshing">
      <span className="settle" key="refreshing">
        Refreshing
      </span>
    </span>
  ) : !readFresh && hasCashier ? (
    <span className="state">
      <span className="settle" key={`last-read-${readTime}`}>
        {readTime ? 'Last read ' : 'Partial read'}
        {readTime ? <span className="state-note">{readTime}</span> : null}
      </span>
    </span>
  ) : null;

  return (
    <section className="card panel comparison" aria-labelledby="comparison-heading">
      <div className="card-heading panel-head">
        <div>
          <h2 id="comparison-heading">Cashier vs NBP</h2>
          <p className="muted">
            Cashier rates use four implied decimals; NBP uses PLN per unit. Read-only comparison.
            {nbp.status === 'loading' && nbp.data
              ? ' Refreshing the NBP reference; showing the previous table.'
              : nbp.status === 'error'
                ? ' NBP refresh failed; showing the previous table.'
                : ''}
            {!readFresh && hasCashier
              ? readTime
                ? ' Showing the last complete read; differences are unavailable until the cashier is read again.'
                : ' Showing partial values; differences are unavailable until the cashier is read again.'
              : ''}
          </p>
        </div>
        {badge ? <div className="panel-badges">{badge}</div> : null}
      </div>

      {!hasCashier ? (
        <p className="empty">Read foreign slots to compare the cashier rates.</p>
      ) : !nbp.data ? (
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
              {rows.map(({ code, mid, cashierValue, result }) => (
                <tr key={code}>
                  <th scope="row">{code}</th>
                  <td>
                    <span className="settle" key={cashierValue === null ? 'none' : cashierValue}>
                      {cashierValue === null ? 'not read' : formatRateValue(cashierValue)}
                    </span>
                  </td>
                  <td>
                    <span className="settle" key={mid ?? 'n/a'}>
                      {mid ?? 'n/a'}
                    </span>
                  </td>
                  <td
                    className={[
                      'delta',
                      result ? `delta-${differenceTone(result.difference) ?? 'flat'}` : undefined,
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span
                      className="settle"
                      key={result ? `${result.difference}-${result.percent}` : 'no-difference'}
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
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="records">
            {rows.map(({ code, mid, cashierValue, result }) => (
              <article className="record" key={code}>
                <h3 className="record-title">{code}</h3>
                <dl className="record-list">
                  <dt>Cashier rate</dt>
                  <dd>
                    <span className="settle" key={cashierValue === null ? 'none' : cashierValue}>
                      {cashierValue === null ? 'not read' : formatRateValue(cashierValue)}
                    </span>
                  </dd>
                  <dt>NBP reference</dt>
                  <dd>
                    <span className="settle" key={mid ?? 'n/a'}>
                      {mid ?? 'n/a'}
                    </span>
                  </dd>
                  <dt>Difference vs NBP</dt>
                  <dd
                    className={
                      result ? `delta-${differenceTone(result.difference) ?? 'flat'}` : undefined
                    }
                  >
                    <span
                      className="settle"
                      key={result ? `${result.difference}-${result.percent}` : 'no-difference'}
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
                    </span>
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
