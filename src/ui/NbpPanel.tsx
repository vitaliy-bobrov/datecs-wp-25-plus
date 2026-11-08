import { errorMessage, type NbpSnapshot } from '../domain/nbp';
import { formatTimestamp } from './log-view';

export type NbpState =
  | { status: 'loading'; data?: NbpSnapshot }
  | { status: 'ready'; data: NbpSnapshot }
  | { status: 'error'; message: string; data?: NbpSnapshot };

interface NbpPanelProps {
  state: NbpState;
  onRefresh: () => void;
}

export function NbpPanel({ state, onRefresh }: NbpPanelProps) {
  const data = state.data;
  return (
    <section className="card panel nbp" aria-labelledby="nbp-heading">
      <div className="card-heading panel-head">
        <div>
          <h2 id="nbp-heading">NBP reference</h2>
          <p className="muted">Table A · USD/EUR · previous business day · in-memory only</p>
        </div>
        <div className="button-row compact">
          {data?.stale ? (
            <span className="state state-stale" title="Older than seven calendar days">
              Stale
            </span>
          ) : null}
          <button
            type="button"
            className="button"
            onClick={() => {
              if (state.status === 'loading') return;
              onRefresh();
            }}
            aria-disabled={state.status === 'loading'}
          >
            {state.status === 'loading' ? (state.data ? 'Refreshing…' : 'Loading…') : 'Refresh'}
          </button>
        </div>
      </div>

      {state.status === 'loading' && !data ? (
        <p className="empty" aria-live="polite">
          Loading NBP table A…
        </p>
      ) : state.status === 'error' && !data ? (
        <div className="panel-body">
          <div className="nbp-error" role="alert">
            <p>{state.message || errorMessage(null)}</p>
            <button type="button" className="button" onClick={onRefresh}>
              Retry
            </button>
          </div>
        </div>
      ) : data ? (
        <div
          className="panel-body nbp-body"
          aria-live="polite"
          aria-busy={state.status === 'loading'}
        >
          {state.status === 'error' ? (
            <p className="plan-warnings failure">
              NBP refresh failed: {state.message || errorMessage(null)} Showing the previous table.
            </p>
          ) : null}
          <p className="nbp-meta">
            Effective <strong>{data.table.effectiveDate}</strong>
            {' · '}
            {data.ageDays} calendar day{data.ageDays === 1 ? '' : 's'} old
            {' · '}
            stale after 7 days
            {data.table.no ? ` · NBP ${data.table.no}` : ''}
            {' · '}
            fetched {formatTimestamp(data.fetchedAt)}
          </p>
          <dl className="rates">
            {(['USD', 'EUR'] as const).map((code) => {
              const rate = data.table.rates.find((item) => item.code === code);
              return (
                <div key={code}>
                  <dt>{code}</dt>
                  <dd>{rate ? rate.mid : 'unavailable'}</dd>
                  <dd className="rate-unit">
                    PLN per 1 {code}
                    {rate?.currency ? ` · ${rate.currency}` : ''}
                  </dd>
                </div>
              );
            })}
          </dl>
          <p className="hint">
            Source:{' '}
            <a
              href="https://nbp.pl/statystyka-i-sprawozdawczosc/kursy/"
              target="_blank"
              rel="noreferrer"
            >
              Narodowy Bank Polski — exchange rates, table A
            </a>
            . Reference only; the cashier comparison uses read slot values when available.
          </p>
        </div>
      ) : null}
    </section>
  );
}
