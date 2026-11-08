import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { supportsWebSerial } from '../app/capabilities';
import { nbpClient } from '../app/nbp-service';
import type { CaptureEntry } from '../domain/capture-log';
import { errorMessage } from '../domain/nbp';
import { type CurrencyCode, formatFlag, formatRateValue, parseRawRate } from '../domain/rates';
import type { UpdateTargets } from '../domain/update-plan';
import type { TransportKind } from '../ports/transport';
import type { DeviceSession, SessionSnapshot } from '../session/device-session';
import { ConfirmDialog } from './ConfirmDialog';
import { captureDownload, downloadText } from './download';
import { displayEntries, formatTimestamp, formatUsbIds, stateClass, stateLabel } from './log-view';
import { NbpPanel, type NbpState } from './NbpPanel';
import { RateComparison } from './RateComparison';
import { UpdatePreview } from './UpdatePreview';

type WriteTarget = 'usd' | 'eur' | 'converter' | 'print';

function nextRate(value: string): string {
  const last = value.at(-1) ?? '0';
  const next = last === '9' ? '8' : String(Number(last) + 1);
  return `${value.slice(0, -1)}${next}`;
}

function formatTargetValue(target: WriteTarget | null, value: string | undefined): string {
  return target === 'print' ? formatFlag(value) : formatTestRate(value);
}

function formatFieldValue(field: string, value: string | undefined): string {
  return field === 'converterPrint' ? formatFlag(value) : formatTestRate(value);
}

function writeTargetLabel(target: WriteTarget | null): string {
  if (target === 'usd') return 'USD slot 0 rate';
  if (target === 'eur') return 'EUR slot 1 rate';
  if (target === 'converter') return 'converter rate';
  if (target === 'print') return 'print converter flag';
  return 'rate';
}

function writeFieldLabel(field: string): string {
  if (field === 'slot0Rate') return 'USD slot 0 rate';
  if (field === 'slot1Rate') return 'EUR slot 1 rate';
  if (field === 'converterRate') return 'converter rate';
  if (field === 'converterPrint') return 'print converter flag';
  return field;
}

interface AppProps {
  session: DeviceSession;
}

const TRANSPORT_LABEL: Record<TransportKind, string> = {
  webserial: 'Web Serial',
  simulator: 'Simulator',
};

function entrySummary(entry: CaptureEntry): string {
  let summary: string;
  if (entry.kind === 'error') summary = entry.message ?? entry.code ?? 'Error';
  else if (entry.kind === 'connect')
    summary = `Connected${entry.device ? `: ${entry.device}` : ''}`;
  else if (entry.kind === 'disconnect') summary = 'Disconnected';
  else if (entry.kind === 'session') summary = entry.message ?? 'Session';
  else summary = entry.message ?? entry.kind;

  const diagnostics = [entry.stage, entry.errorName, entry.errorMessage].filter(Boolean);
  return diagnostics.length > 0 ? `${summary} · ${diagnostics.join(' · ')}` : summary;
}

function lockMessage(state: SessionSnapshot['lockState']): string {
  switch (state) {
    case 'acquiring':
      return 'Checking the single-tab device lock…';
    case 'held':
      return 'Device lock held by this tab.';
    case 'in-use':
      return 'Another tab owns the device lock. Close it before connecting.';
    case 'unavailable':
      return 'This browser cannot guarantee a single device session, so connecting is disabled.';
    default:
      return 'Device lock not acquired.';
  }
}

function readErrorMessage(snapshot: SessionSnapshot): string | null {
  if (snapshot.captureState === 'failed' || snapshot.captureState === 'captureOnly') {
    return 'Connection check failed. Check the cable and retry.';
  }
  if (snapshot.readState === 'failed') {
    return 'The local records did not arrive. Retry the read.';
  }
  if (snapshot.foreignReadState === 'failed') {
    return 'The USD/EUR records did not arrive. Retry the read.';
  }
  if (snapshot.foreignReadState === 'read' && snapshot.converterReadState === 'failed') {
    return 'The converter record did not arrive. Update is unavailable; read again.';
  }
  if (snapshot.converterReadState === 'failed') {
    return 'The converter record did not arrive. Retry the read.';
  }
  return null;
}

function formatTestRate(value: string | undefined): string {
  if (!value) return '—';
  const rate = parseRawRate(value);
  return rate === null ? value : `${formatRateValue(rate)} (raw ${value})`;
}

function formatCashierRate(raw: string | undefined): string {
  const rate = parseRawRate(raw);
  return rate === null ? '—' : formatRateValue(rate);
}

function consoleState(snapshot: SessionSnapshot): string {
  if (snapshot.phase === 'error') return 'error';
  if (snapshot.updateState !== 'idle') return snapshot.updateState;
  if (snapshot.writeTestState !== 'idle') return snapshot.writeTestState;
  if (
    snapshot.captureState === 'failed' ||
    snapshot.captureState === 'captureOnly' ||
    snapshot.readState === 'failed' ||
    snapshot.foreignReadState === 'failed' ||
    snapshot.converterReadState === 'failed'
  ) {
    return 'failed';
  }
  if (
    snapshot.captureState === 'capturing' ||
    snapshot.readState === 'reading' ||
    snapshot.foreignReadState === 'reading' ||
    snapshot.converterReadState === 'reading'
  ) {
    return 'reading';
  }
  if (snapshot.phase === 'connected' && snapshot.readState === 'read') return 'read';
  return snapshot.phase;
}

export function App({ session }: AppProps) {
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [clearOpen, setClearOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
  const [writeTarget, setWriteTarget] = useState<WriteTarget | null>(null);
  const [updateOpen, setUpdateOpen] = useState(false);
  const [pendingUpdate, setPendingUpdate] = useState<UpdateTargets | null>(null);
  const [identityConfirmed, setIdentityConfirmed] = useState(false);
  const [nbp, setNbp] = useState<NbpState>({ status: 'loading' });
  const [idleAcknowledged, setIdleAcknowledged] = useState(false);

  useEffect(() => {
    void session.acquireLock();
  }, [session]);

  useEffect(() => {
    if (!updateOpen) setIdentityConfirmed(false);
  }, [updateOpen]);

  const loadNbp = useCallback(async () => {
    setNbp({ status: 'loading' });
    try {
      setNbp({ status: 'ready', data: await nbpClient.fetchPreviousRates() });
    } catch (error) {
      setNbp({ status: 'error', message: errorMessage(error) });
    }
  }, []);

  useEffect(() => {
    void loadNbp();
  }, [loadNbp]);

  const canConnect =
    snapshot.lockState === 'held' &&
    snapshot.phase !== 'connecting' &&
    snapshot.phase !== 'connected';

  const readComplete =
    snapshot.phase === 'connected' &&
    snapshot.readState === 'read' &&
    snapshot.foreignReadState === 'read' &&
    snapshot.converterReadState === 'read' &&
    snapshot.foreignRead !== undefined &&
    snapshot.converterRead !== undefined;
  const readFresh = readComplete && snapshot.updateState !== 'failed';
  const refreshing =
    snapshot.captureState === 'capturing' ||
    snapshot.readState === 'reading' ||
    snapshot.foreignReadState === 'reading' ||
    snapshot.converterReadState === 'reading';
  const partialForeign =
    snapshot.foreignReadState === 'read' && snapshot.converterReadState === 'failed'
      ? snapshot.foreignRead
      : undefined;
  const displayedForeign = readFresh
    ? snapshot.foreignRead
    : (snapshot.lastRead?.foreignRead ?? partialForeign);
  const displayedConverter = readFresh ? snapshot.converterRead : snapshot.lastRead?.converterRead;
  const readIncomplete =
    snapshot.foreignReadState === 'read' && snapshot.converterReadState === 'failed';

  const entries = useMemo(() => displayEntries(snapshot.capture, 250), [snapshot.capture]);
  const cashierRates = useMemo(() => {
    const rates: Partial<Record<CurrencyCode, string>> = {};
    const read = displayedForeign;
    if (read?.slot0Name === 'USD' || read?.slot0Name === 'EUR') {
      if (read.slot0Rate) rates[read.slot0Name] = read.slot0Rate;
    }
    if (read?.slot1Name === 'USD' || read?.slot1Name === 'EUR') {
      if (read.slot1Rate) rates[read.slot1Name] = read.slot1Rate;
    }
    return rates;
  }, [displayedForeign]);
  const deviceBusy =
    snapshot.captureState === 'capturing' ||
    snapshot.readState === 'reading' ||
    snapshot.foreignReadState === 'reading' ||
    snapshot.converterReadState === 'reading' ||
    snapshot.writeTestState === 'writing';
  const readBusy = deviceBusy || snapshot.updateState === 'updating';

  const readError = snapshot.phase === 'connected' ? readErrorMessage(snapshot) : null;
  const readFailed = readError !== null;
  const statusError = snapshot.error?.message ?? readError;
  const statusIsReadFailure = snapshot.error === undefined && readFailed;
  const displayState = consoleState(snapshot);
  const displayStateLabel = stateLabel(displayState);

  const clearCapture = () => {
    if (!deviceBusy) setClearOpen(true);
  };

  const confirmClear = () => {
    session.clearCapture();
    setCopyState('idle');
    setClearOpen(false);
  };

  const runReads = async (): Promise<void> => {
    if (session.getSnapshot().phase !== 'connected') {
      setIdleAcknowledged(false);
      return;
    }
    await session.runPreflight();
    if (session.getSnapshot().captureState !== 'captured') {
      setIdleAcknowledged(false);
      return;
    }
    await session.runReadForeign();
    if (session.getSnapshot().foreignReadState !== 'read') {
      setIdleAcknowledged(false);
      return;
    }
    await session.runReadConverter();
    if (session.getSnapshot().converterReadState !== 'read') {
      setIdleAcknowledged(false);
    }
  };

  const connect = async (kind: TransportKind) => {
    if (!idleAcknowledged || !canConnect || !supportsWebSerial()) return;
    await session.connect(kind);
    if (session.getSnapshot().phase !== 'connected') {
      setIdleAcknowledged(false);
      return;
    }
    await runReads();
  };

  const readCashier = async () => {
    if (!idleAcknowledged) return;
    if (session.getSnapshot().phase !== 'connected' || readBusy) return;
    await runReads();
  };

  const disconnect = async () => {
    setIdleAcknowledged(false);
    await session.disconnect();
  };

  const writeRates = {
    usd: snapshot.foreignRead?.slot0Rate,
    eur: snapshot.foreignRead?.slot1Rate,
    converter: snapshot.converterRead?.rate,
    print: snapshot.converterRead?.printFlag,
  } satisfies Record<WriteTarget, string | undefined>;

  const nbpStale = nbp.status === 'ready' && nbp.data.stale;
  const updateBlocked =
    !readFresh ||
    nbpStale ||
    snapshot.updateState === 'failed' ||
    snapshot.updateState === 'updating';

  const requestUpdate = (targets: UpdateTargets) => {
    if (updateBlocked) return;
    setIdentityConfirmed(false);
    setPendingUpdate(targets);
    setUpdateOpen(true);
  };

  const confirmUpdate = () => {
    const targets = pendingUpdate;
    if (!targets || updateBlocked || !identityConfirmed || !idleAcknowledged) return;
    setUpdateOpen(false);
    setPendingUpdate(null);
    void session.runFullUpdate(targets);
  };

  const writeOriginal = writeTarget ? writeRates[writeTarget] : undefined;
  const writeTemporary = writeOriginal
    ? writeTarget === 'print'
      ? writeOriginal === '1'
        ? '0'
        : '1'
      : nextRate(writeOriginal)
    : '';

  const runWriteTest = (target: WriteTarget) => {
    if (!writeRates[target]) return;
    setWriteTarget(target);
    setWriteOpen(true);
  };

  const confirmWriteTest = () => {
    if (!idleAcknowledged) return;
    const target = writeTarget;
    setWriteOpen(false);
    setWriteTarget(null);
    if (target === 'usd') void session.runRateWriteTest(0);
    if (target === 'eur') void session.runRateWriteTest(1);
    if (target === 'converter') void session.runConverterRateWriteTest();
    if (target === 'print') void session.runPrintFlagWriteTest();
  };

  const download = (format: 'jsonl' | 'text') => {
    const file = captureDownload(format, session);
    downloadText(file.filename, file.text, file.mime);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(session.captureText());
      setCopyState('copied');
      setTimeout(() => setCopyState('idle'), 2000);
    } catch {
      setCopyState('failed');
    }
  };

  return (
    <main className="page">
      <h1 className="sr-only">Datecs WP-25 Plus currency console</h1>
      <div className="shell">
        <header className="rail">
          <div className="brand">
            <strong>DATECS</strong>
            <span>WP-25 PLUS · Currency console</span>
          </div>
          <div className="rail-right">
            <span className={`lamp lamp-${stateClass(displayState)}`} aria-hidden="true" />
            <span>{displayStateLabel}</span>
            <span className="rail-version">v{__APP_VERSION__}</span>
          </div>
        </header>

        <div className="console">
          <section className="lcd" aria-label="Cashier status display">
            <div className="lcd-main">
              <p className="lcd-kicker">Cashier status</p>
              <p
                className={`lcd-state${displayState === 'error' || displayState === 'failed' ? ' lcd-state-failure' : ''}`}
              >
                <span className="settle" key={displayState}>
                  {displayStateLabel}
                </span>
              </p>
              <p className="lcd-rates">
                <span className="lcd-label">Cashier</span>
                <span>
                  USD{' '}
                  <strong className="settle" key={cashierRates.USD ?? 'none'}>
                    {formatCashierRate(cashierRates.USD)}
                  </strong>
                </span>
                <span>
                  EUR{' '}
                  <strong className="settle" key={cashierRates.EUR ?? 'none'}>
                    {formatCashierRate(cashierRates.EUR)}
                  </strong>
                </span>
              </p>
            </div>
          </section>

          <section className="card panel connection-panel" aria-labelledby="connection-heading">
            <div className="card-heading panel-head">
              <div>
                <h2 id="connection-heading">Connection</h2>
                <p className="muted">{lockMessage(snapshot.lockState)}</p>
              </div>
              <span className={`state state-${stateClass(displayState)}`}>
                <span className="settle" key={displayState}>
                  {displayStateLabel}
                </span>
              </span>
            </div>

            <div className="panel-body connection-body">
              <div>
                <label className="checkline idle-gate">
                  <input
                    type="checkbox"
                    checked={idleAcknowledged}
                    onChange={(event) => setIdleAcknowledged(event.target.checked)}
                  />
                  <span>Cashier is idle and no sale is open</span>
                </label>
                <p className="hint" id="idle-gate-hint">
                  Connect and Read stay disabled until you confirm the cashier is idle.
                  {!idleAcknowledged && snapshot.phase === 'connected' && readFailed
                    ? ' The confirmation was cleared after the failed read; tick it again to retry.'
                    : ''}
                </p>
              </div>

              <div className="connection-grid">
                <div>
                  <p className="label">Transport</p>
                  <div className="button-row">
                    <button
                      type="button"
                      className="button primary"
                      onClick={() => void connect('webserial')}
                      aria-disabled={!canConnect || !idleAcknowledged || !supportsWebSerial()}
                      aria-describedby="idle-gate-hint"
                      title={
                        supportsWebSerial()
                          ? 'Select the cashier with Web Serial'
                          : 'Web Serial is unavailable'
                      }
                    >
                      Connect cashier
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => void readCashier()}
                      aria-disabled={
                        !idleAcknowledged || snapshot.phase !== 'connected' || readBusy
                      }
                      aria-describedby="idle-gate-hint"
                    >
                      {readFailed ? 'Read again' : 'Read cashier'}
                    </button>
                    <button
                      type="button"
                      className="button"
                      onClick={() => void disconnect()}
                      disabled={snapshot.phase === 'idle' || deviceBusy}
                    >
                      Disconnect
                    </button>
                  </div>
                  <p className="hint">
                    Web Serial is the only transport. Nothing is auto-selected.
                  </p>
                  {snapshot.lockState === 'in-use' || snapshot.lockState === 'unavailable' ? (
                    <button
                      type="button"
                      className="button"
                      onClick={() => void session.acquireLock()}
                    >
                      Retry device lock
                    </button>
                  ) : null}
                </div>

                <dl className="facts">
                  <div>
                    <dt>Transport</dt>
                    <dd>
                      {snapshot.transportKind ? TRANSPORT_LABEL[snapshot.transportKind] : '—'}
                    </dd>
                  </div>
                  <div>
                    <dt>Device</dt>
                    <dd>{snapshot.info?.label ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>USB IDs</dt>
                    <dd>{formatUsbIds(snapshot.info?.vendorId, snapshot.info?.productId)}</dd>
                  </div>
                </dl>
              </div>

              <div
                className={`status${statusError ? ' status-error' : ''}`}
                role={statusError ? 'alert' : 'status'}
                aria-live={statusError ? 'assertive' : 'polite'}
              >
                {statusError ? (
                  <>
                    {statusIsReadFailure ? (
                      <strong className="status-title">
                        {readIncomplete ? 'Read incomplete' : 'Could not read the cashier.'}
                      </strong>
                    ) : null}
                    <span>{statusError}</span>
                  </>
                ) : snapshot.phase === 'connected' ? (
                  deviceBusy ? (
                    'Connected · reading cashier…'
                  ) : readFresh ? (
                    'Connected. Cashier records are current.'
                  ) : (
                    'Connected.'
                  )
                ) : (
                  lockMessage(snapshot.lockState)
                )}
              </div>
            </div>
          </section>

          <div className="workspace">
            <RateComparison
              nbp={nbp}
              cashier={cashierRates}
              readFresh={readFresh}
              refreshing={refreshing}
              readAt={snapshot.lastRead?.at}
            />
            <NbpPanel state={nbp} onRefresh={() => void loadNbp()} />
          </div>

          <UpdatePreview
            foreign={displayedForeign}
            converter={displayedConverter}
            nbp={nbp}
            readFresh={readFresh}
            readAt={snapshot.lastRead?.at}
            updateState={snapshot.updateState}
            updateResult={snapshot.updateResult}
            onRequestUpdate={requestUpdate}
          />
        </div>

        <details className="diag">
          <summary>Diagnostics · field tests & logger</summary>
          <div className="diag-body">
            {snapshot.converterRead ? (
              <section className="card panel write-test-card" aria-labelledby="write-test-heading">
                <div className="card-heading panel-head">
                  <div>
                    <h2 id="write-test-heading">Rate write tests</h2>
                    <p className="muted">
                      One field at a time: temporary +1 raw unit or a flag toggle, readback,
                      restore, readback. USD, EUR, converter and print-flag tests are separate.
                    </p>
                  </div>
                  <span className={`state state-${stateClass(snapshot.writeTestState)}`}>
                    <span className="settle" key={snapshot.writeTestState}>
                      {stateLabel(snapshot.writeTestState)}
                    </span>
                  </span>
                </div>
                <div className="panel-body foreign-probe write-test">
                  <div className="button-row testgrid">
                    {(['usd', 'eur', 'converter', 'print'] as const).map((target) => (
                      <button
                        key={target}
                        type="button"
                        className="button"
                        onClick={() => runWriteTest(target)}
                        disabled={
                          !snapshot.converterRead ||
                          snapshot.readState !== 'read' ||
                          deviceBusy ||
                          !writeRates[target]
                        }
                      >
                        {snapshot.writeTestState === 'writing'
                          ? 'Writing…'
                          : target === 'print'
                            ? 'Test print flag'
                            : `Test ${target === 'usd' ? 'USD' : target === 'eur' ? 'EUR' : 'converter'} rate`}
                      </button>
                    ))}
                  </div>
                  <dl className="read-values test-values">
                    <div>
                      <dt>USD slot 0</dt>
                      <dd>{formatTestRate(writeRates.usd)}</dd>
                    </div>
                    <div>
                      <dt>EUR slot 1</dt>
                      <dd>{formatTestRate(writeRates.eur)}</dd>
                    </div>
                    <div>
                      <dt>Converter</dt>
                      <dd>{formatTestRate(writeRates.converter)}</dd>
                    </div>
                    <div>
                      <dt>Print converter</dt>
                      <dd>{formatFlag(writeRates.print)}</dd>
                    </div>
                  </dl>
                  {snapshot.writeTest && !snapshot.writeTest.restored ? (
                    <p className="plan-warnings failure" role="alert">
                      Restore did not verify. The cashier may still hold{` `}
                      <code>
                        {formatFieldValue(snapshot.writeTest.field, snapshot.writeTest.temporary)}
                      </code>
                      . Do not run the test again; stop and report the log.
                    </p>
                  ) : null}
                  {snapshot.writeTest ? (
                    <dl className="read-values">
                      <div>
                        <dt>Tested field</dt>
                        <dd>{writeFieldLabel(snapshot.writeTest.field)}</dd>
                      </div>
                      <div>
                        <dt>Temporary readback</dt>
                        <dd>
                          {formatFieldValue(
                            snapshot.writeTest.field,
                            snapshot.writeTest.temporaryReadback,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Restored readback</dt>
                        <dd>
                          {formatFieldValue(
                            snapshot.writeTest.field,
                            snapshot.writeTest.restoredReadback,
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Restored</dt>
                        <dd>{snapshot.writeTest.restored ? 'Yes' : 'No'}</dd>
                      </div>
                      {snapshot.writeTest.message ? (
                        <div>
                          <dt>Result</dt>
                          <dd>{snapshot.writeTest.message}</dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : null}
                </div>
              </section>
            ) : null}

            <section className="card panel logger" aria-labelledby="logger-heading">
              <div className="card-heading panel-head">
                <div>
                  <h2 id="logger-heading">Logger</h2>
                  <p className="muted">
                    Device log in memory · showing {entries.length} of {snapshot.capture.length}{' '}
                    entries · NBP is fetched separately
                  </p>
                </div>
                <div className="button-row compact logger-actions">
                  <button
                    type="button"
                    className="button"
                    onClick={() => void copy()}
                    disabled={deviceBusy || snapshot.capture.length === 0}
                  >
                    {copyState === 'copied'
                      ? 'Copied'
                      : copyState === 'failed'
                        ? 'Copy failed'
                        : 'Copy text'}
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => download('jsonl')}
                    disabled={deviceBusy || snapshot.capture.length === 0}
                  >
                    Download JSONL
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => download('text')}
                    disabled={deviceBusy || snapshot.capture.length === 0}
                  >
                    Download text
                  </button>
                  <button
                    type="button"
                    className="button danger logger-clear"
                    onClick={clearCapture}
                    disabled={deviceBusy || snapshot.capture.length === 0}
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="panel-body">
                {entries.length === 0 ? (
                  <p className="empty">
                    No entries yet. Connect or disconnect to create a session entry.
                  </p>
                ) : (
                  <div className="log-wrap">
                    <table className="log">
                      <caption className="sr-only">Device session log, newest first</caption>
                      <thead>
                        <tr>
                          <th scope="col">Time</th>
                          <th scope="col">Kind</th>
                          <th scope="col">Transport</th>
                          <th scope="col">Device</th>
                          <th scope="col">Bytes</th>
                          <th scope="col">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries.map((entry) => (
                          <tr key={entry.id}>
                            <td className="mono nowrap">{formatTimestamp(entry.ts)}</td>
                            <td>{entry.kind}</td>
                            <td>{entry.transport ? TRANSPORT_LABEL[entry.transport] : '—'}</td>
                            <td>{entry.device ?? '—'}</td>
                            <td className="mono bytes">{entry.bytesHex ?? '—'}</td>
                            <td>
                              {entrySummary(entry)}
                              {entry.code ? <span className="code"> {entry.code}</span> : null}
                              {entry.detail ? (
                                <details className="log-detail">
                                  <summary>details</summary>
                                  <pre>{JSON.stringify(entry.detail, null, 2)}</pre>
                                </details>
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>
          </div>
        </details>

        <footer className="footer">
          <p>
            Read-only records plus a confirmed full update with backup, readback and restore. No
            <code>0xFF</code>.
          </p>
        </footer>
      </div>

      <ConfirmDialog
        open={updateOpen}
        title="Apply NBP update?"
        confirmLabel="Update cashier"
        confirmTone="primary"
        confirmDisabled={!identityConfirmed || !idleAcknowledged}
        confirmReason={
          !idleAcknowledged
            ? 'Tick the idle acknowledgement before writing.'
            : 'Confirm this is the cashier at the till to enable Update cashier.'
        }
        onConfirm={confirmUpdate}
        onCancel={() => {
          setUpdateOpen(false);
          setPendingUpdate(null);
        }}
      >
        <p>
          This writes USD, EUR, converter rate and the print flag. The current values are backed up
          in memory; the app reads all four back and restores them if verification fails.
        </p>
        <dl className="read-values">
          <div>
            <dt>USD rate</dt>
            <dd>
              {formatTestRate(snapshot.foreignRead?.slot0Rate)} →{' '}
              {pendingUpdate ? formatTestRate(String(pendingUpdate.usdRaw)) : '—'}
            </dd>
          </div>
          <div>
            <dt>EUR rate</dt>
            <dd>
              {formatTestRate(snapshot.foreignRead?.slot1Rate)} →{' '}
              {pendingUpdate ? formatTestRate(String(pendingUpdate.eurRaw)) : '—'}
            </dd>
          </div>
          <div>
            <dt>Converter rate</dt>
            <dd>
              {formatTestRate(snapshot.converterRead?.rate)} →{' '}
              {pendingUpdate ? formatTestRate(String(pendingUpdate.converterRaw)) : '—'}
            </dd>
          </div>
          <div>
            <dt>Print converter</dt>
            <dd>
              {formatFlag(snapshot.converterRead?.printFlag)} →{' '}
              {pendingUpdate ? formatFlag(pendingUpdate.printFlag) : '—'}
            </dd>
          </div>
        </dl>
        <dl className="read-values">
          <div>
            <dt>Transport</dt>
            <dd>{snapshot.transportKind ?? '—'}</dd>
          </div>
          <div>
            <dt>Device</dt>
            <dd>{snapshot.info?.label ?? '—'}</dd>
          </div>
          <div>
            <dt>USB IDs</dt>
            <dd>{formatUsbIds(snapshot.info?.vendorId, snapshot.info?.productId)}</dd>
          </div>
        </dl>
        <label className="checkline">
          <input
            type="checkbox"
            checked={identityConfirmed}
            onChange={(event) => setIdentityConfirmed(event.target.checked)}
          />
          <span>I confirm this is the cashier at the till</span>
        </label>
        <p className="hint">
          The device exposes no distinguishing serial; confirm the physical cashier before updating.
        </p>
        <p>Do not run this during a sale. The device is checked again before the first write.</p>
      </ConfirmDialog>

      <ConfirmDialog
        open={clearOpen}
        title="Clear the device log?"
        confirmLabel="Clear"
        confirmTone="danger"
        onConfirm={confirmClear}
        onCancel={() => setClearOpen(false)}
      >
        <p>
          This removes the in-memory log, preflight result and last-read cache. The update gate is
          reset; nothing is sent to the cashier.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={writeOpen}
        title={`Run ${writeTargetLabel(writeTarget)} test?`}
        confirmLabel="Run test"
        confirmTone="primary"
        confirmDisabled={!idleAcknowledged}
        confirmReason="Tick the idle acknowledgement before writing."
        onConfirm={confirmWriteTest}
        onCancel={() => {
          setWriteOpen(false);
          setWriteTarget(null);
        }}
      >
        <p>
          This temporarily changes one rate by one raw unit, reads it back, restores it, and reads
          it back again. Use only when the cashier is idle.
        </p>
        <dl className="read-values">
          <div>
            <dt>Field</dt>
            <dd>{writeTargetLabel(writeTarget)}</dd>
          </div>
          <div>
            <dt>Current</dt>
            <dd>{formatTargetValue(writeTarget, writeOriginal)}</dd>
          </div>
          <div>
            <dt>Temporary</dt>
            <dd>{formatTargetValue(writeTarget, writeTemporary)}</dd>
          </div>
          <div>
            <dt>Restore</dt>
            <dd>{formatTargetValue(writeTarget, writeOriginal)}</dd>
          </div>
        </dl>
        <p>
          No name, short-name, Change-after-Z or converter value is touched. If restore fails, the
          cashier may keep the temporary rate; stop and report the log.
        </p>
      </ConfirmDialog>
    </main>
  );
}
