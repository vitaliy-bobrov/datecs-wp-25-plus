import { errorMessage, type NbpSnapshot } from '../domain/nbp';
import { formatTimestamp } from './log-view';

export type NbpState =
  | { status: 'loading' }
  | { status: 'ready'; data: NbpSnapshot }
  | { status: 'error'; message: string };

interface NbpPanelProps {
  state: NbpState;
  onRefresh: () => void;
}

export function NbpPanel({ state, onRefresh }: NbpPanelProps) {
  return (
    <section className="card nbp" aria-labelledby="nbp-heading">
      <div className="card-heading">
        <div>
          <h2 id="nbp-heading">NBP reference</h2>
          <p className="muted">Table A · USD/EUR · previous business day · in-memory only</p>
        </div>
        <div className="button-row compact">
          {state.status === 'ready' && state.data.stale ? (
            <span className="state state-stale" title="Older than seven calendar days">
              Stale
            </span>
          ) : null}
          <button
            type="button"
            className="button"
            onClick={onRefresh}
            disabled={state.status === 'loading'}
          >
            {state.status === 'loading' ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {state.status === 'loading' ? (
        <p className="empty" aria-live="polite">
          Loading NBP table A…
        </p>
      ) : state.status === 'error' ? (
        <div className="nbp-error" role="alert">
          <p>{state.message || errorMessage(null)}</p>
          <button type="button" className="button" onClick={onRefresh}>
            Retry
          </button>
        </div>
      ) : (
        <div aria-live="polite">
          <p className="nbp-meta">
            Effective <strong>{state.data.table.effectiveDate}</strong>
            {' · '}
            {state.data.ageDays} calendar day{state.data.ageDays === 1 ? '' : 's'} old
            {' · '}
            stale after 7 days
            {state.data.table.no ? ` · NBP ${state.data.table.no}` : ''}
            {' · '}
            fetched {formatTimestamp(state.data.fetchedAt)}
          </p>
          <dl className="rates">
            {(['USD', 'EUR'] as const).map((code) => {
              const rate = state.data.table.rates.find((item) => item.code === code);
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
            Source: <a href="https://api.nbp.pl/">Narodowy Bank Polski, table A</a>. Reference only;
            the cashier comparison uses read slot values when available.
          </p>
        </div>
      )}
    </section>
  );
}
