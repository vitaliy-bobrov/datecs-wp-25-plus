import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { CurrencyCode } from '../domain/rates';
import { differenceTone, formatFlag, formatRateValue } from '../domain/rates';
import {
  buildUpdatePlan,
  type ConverterSnapshot,
  type ForeignRecordSnapshot,
  type FullUpdateResult,
  type UpdateTargets,
} from '../domain/update-plan';
import { formatSignedPercent, formatSignedRate } from './format';
import type { NbpState } from './NbpPanel';

function changeTone(current: number | null, target: number): string {
  if (current === null) return '';
  return `delta-${differenceTone(target - current) ?? 'flat'}`;
}

interface UpdatePreviewProps {
  foreign?: ForeignRecordSnapshot;
  converter?: ConverterSnapshot;
  nbp: NbpState;
  readFresh: boolean;
  updateState: 'idle' | 'updating' | 'verified' | 'failed';
  updateResult?: FullUpdateResult;
  onRequestUpdate: (targets: UpdateTargets) => void;
}

export function UpdatePreview({
  foreign,
  converter,
  nbp,
  readFresh,
  updateState,
  updateResult,
  onRequestUpdate,
}: UpdatePreviewProps) {
  const currentFlag = converter?.printFlag;
  const [printConverter, setPrintConverter] = useState(currentFlag === '1');
  const [seededFlag, setSeededFlag] = useState<string | null>(
    currentFlag === '0' || currentFlag === '1' ? currentFlag : null,
  );
  const printTouched = useRef(false);
  const reviewGateId = useId();
  const readGateReasonId = useId();
  const noDiffReasonId = useId();

  useEffect(() => {
    if (currentFlag !== '0' && currentFlag !== '1') return;
    if (printTouched.current || seededFlag === currentFlag) return;
    setPrintConverter(currentFlag === '1');
    setSeededFlag(currentFlag);
  }, [currentFlag, seededFlag]);

  const printReady =
    currentFlag !== undefined && (printTouched.current || seededFlag === currentFlag);

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

  const planRows = plan
    ? [
        { key: 'usd', label: 'USD rate', current: plan.usd.current, target: plan.usd.target },
        { key: 'eur', label: 'EUR rate', current: plan.eur.current, target: plan.eur.target },
        ...(plan.converter
          ? [
              {
                key: 'converter',
                label: 'Converter rate',
                current: plan.converter.current,
                target: plan.converter.target,
              },
            ]
          : []),
      ]
    : [];
  const printCurrent =
    converter?.printFlag === undefined
      ? null
      : converter.printFlag === '1'
        ? 'Enabled'
        : 'Disabled';
  const printTarget = printConverter ? 'Enabled' : 'Disabled';
  const printChange =
    printCurrent === null
      ? null
      : printCurrent === printTarget
        ? 'No change'
        : `${printCurrent} → ${printTarget}`;
  const currentLabel = readFresh ? 'Cashier now' : 'Last read';
  const staleNbp = nbp.status === 'ready' && nbp.data.stale;
  const reviewGate: { tone: 'stale' | 'failed' | 'unavailable'; message: string } | null =
    !readFresh || !plan
      ? null
      : staleNbp
        ? {
            tone: 'stale',
            message:
              'NBP table is stale (older than seven calendar days). Refresh the reference before updating.',
          }
        : updateState === 'failed'
          ? {
              tone: 'failed',
              message: 'The last update failed. Read the cashier again before retrying.',
            }
          : plan.converter === undefined
            ? {
                tone: 'unavailable',
                message:
                  'The converter record is unavailable. Read the cashier again before updating.',
              }
            : null;
  const canReview =
    readFresh &&
    plan?.hasChanges === true &&
    plan.converter !== undefined &&
    printReady &&
    reviewGate === null &&
    updateState !== 'updating' &&
    onRequestUpdate !== undefined;
  const readGate = !readFresh ? (
    <div className="panel-body update-empty-gate">
      <p className="hint update-read-gate" id={readGateReasonId}>
        Cashier records are not current. Read again before updating; the values above are the last
        complete read.
      </p>
      <div className="button-row update-actions">
        <button
          type="button"
          className="button primary"
          aria-disabled="true"
          aria-describedby={readGateReasonId}
        >
          Review update
        </button>
      </div>
    </div>
  ) : null;

  return (
    <section className="card panel update-preview" aria-labelledby="update-preview-heading">
      <div className="card-heading panel-head">
        <div>
          <h2 id="update-preview-heading">Update preview</h2>
          <p className="muted">
            Target values from the NBP reference. Update writes USD, EUR, converter and print flag,
            verifies all four readbacks, and restores the backup if anything fails.
          </p>
        </div>
      </div>

      {nbp.status !== 'ready' ? (
        <>
          <p className="empty">NBP reference is not ready.</p>
          {readGate}
        </>
      ) : !plan ? (
        <>
          <p className="empty">Complete the foreign reads and NBP reference to build a preview.</p>
          {readGate}
        </>
      ) : (
        <div className="panel-body">
          <table className="comparison-table plan-table desktop-table">
            <thead>
              <tr>
                <th scope="col">Record</th>
                <th scope="col">{currentLabel}</th>
                <th scope="col">Update to</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {planRows.map((row) => {
                const change = row.current === null ? null : row.target - row.current;
                return (
                  <tr key={row.key}>
                    <th scope="row">{row.label}</th>
                    <td>
                      <span className="settle" key={row.current === null ? 'none' : row.current}>
                        {row.current === null ? '—' : formatRateValue(row.current)}
                      </span>
                    </td>
                    <td>
                      <span className="settle" key={row.target}>
                        {formatRateValue(row.target)}
                      </span>
                    </td>
                    <td className={changeTone(row.current, row.target)}>
                      <span className="settle" key={change ?? 'none'}>
                        {change === null ? '—' : formatSignedRate(change)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <div className="records">
            {planRows.map((row) => {
              const change = row.current === null ? null : row.target - row.current;
              return (
                <article className="record" key={row.key}>
                  <h3 className="record-title">{row.label}</h3>
                  <dl className="record-list">
                    <dt>{currentLabel}</dt>
                    <dd>
                      <span className="settle" key={row.current === null ? 'none' : row.current}>
                        {row.current === null ? '—' : formatRateValue(row.current)}
                      </span>
                    </dd>
                    <dt>Update to</dt>
                    <dd>
                      <span className="settle" key={row.target}>
                        {formatRateValue(row.target)}
                      </span>
                    </dd>
                    <dt>Change</dt>
                    <dd className={changeTone(row.current, row.target)}>
                      <span className="settle" key={change ?? 'none'}>
                        {change === null ? '—' : formatSignedRate(change)}
                      </span>
                    </dd>
                  </dl>
                </article>
              );
            })}
          </div>

          <dl className="read-values device-setting">
            <div>
              <dt>Print currency converter after update</dt>
              <dd>
                <span className="settle" key={`${printCurrent ?? 'none'}-${printTarget}`}>
                  {printCurrent ?? '—'} → {printTarget}
                  {printChange ? ` · ${printChange}` : ''}
                </span>
              </dd>
            </div>
          </dl>

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
              onChange={(event) => {
                printTouched.current = true;
                setPrintConverter(event.target.checked);
                setSeededFlag(currentFlag ?? null);
              }}
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

          {reviewGate ? null : (
            <p
              className={readFresh && plan.hasChanges ? 'hint' : 'empty'}
              id={!plan.hasChanges ? noDiffReasonId : undefined}
            >
              {!readFresh
                ? 'Last complete read loaded. Read again before updating.'
                : plan.hasChanges
                  ? 'Changes are ready for the update gate.'
                  : 'No changes: USD/EUR, converter rate and print flag already match the target.'}
            </p>
          )}

          <p className="hint">
            {plan.usd.percent === null || plan.eur.percent === null
              ? 'Difference unavailable for a missing current rate.'
              : `USD ${formatSignedPercent(plan.usd.percent)} · EUR ${formatSignedPercent(plan.eur.percent)} vs NBP.`}{' '}
            No write occurs until you confirm Update cashier.
          </p>

          {!readFresh ? (
            <p className="hint update-read-gate" id={readGateReasonId}>
              Cashier records are not current. Read again before updating; the values above are the
              last complete read.
            </p>
          ) : null}

          {reviewGate ? (
            <p
              className={
                reviewGate.tone === 'stale'
                  ? 'plan-warnings update-gate'
                  : 'plan-warnings failure update-gate'
              }
              id={reviewGateId}
            >
              {reviewGate.message}
            </p>
          ) : null}

          <div className="button-row update-actions">
            <button
              type="button"
              className="button primary"
              aria-disabled={!canReview}
              aria-describedby={
                reviewGate
                  ? reviewGateId
                  : !readFresh
                    ? readGateReasonId
                    : !plan.hasChanges
                      ? noDiffReasonId
                      : undefined
              }
              disabled={updateState === 'updating'}
              onClick={() => {
                if (!canReview || !plan.converter) return;
                onRequestUpdate({
                  usdRaw: plan.usd.targetRaw,
                  eurRaw: plan.eur.targetRaw,
                  converterRaw: plan.converter.targetRaw,
                  printFlag: printConverter ? '1' : '0',
                });
              }}
            >
              {updateState === 'updating' ? 'Updating…' : 'Review update'}
            </button>
          </div>

          {updateResult ? (
            <p
              className={updateResult.restored ? 'hint' : 'plan-warnings failure'}
              role={updateResult.restored ? undefined : 'alert'}
            >
              {updateState === 'verified'
                ? 'Update verified; all four readbacks matched.'
                : updateResult.restored
                  ? 'Update failed; original records were restored.'
                  : 'Update failed and restore did not verify.'}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
