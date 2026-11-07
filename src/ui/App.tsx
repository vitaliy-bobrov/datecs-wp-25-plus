import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { supportsWebSerial } from '../app/capabilities';
import { nbpClient } from '../app/nbp-service';
import type { CaptureEntry } from '../domain/capture-log';
import { errorMessage } from '../domain/nbp';
import { type CurrencyCode, formatRateValue, parseRawRate } from '../domain/rates';
import type { TransportKind } from '../ports/transport';
import type { DeviceSession, SessionSnapshot } from '../session/device-session';
import { ConfirmDialog } from './ConfirmDialog';
import { captureDownload, downloadText } from './download';
import { displayEntries, formatTimestamp, formatUsbIds, stateClass, stateLabel } from './log-view';
import { NbpPanel, type NbpState } from './NbpPanel';
import { RateComparison } from './RateComparison';
import { UpdatePreview } from './UpdatePreview';

type WriteTarget = 'usd' | 'eur' | 'converter';

function nextRate(value: string): string {
  const last = value.at(-1) ?? '0';
  const next = last === '9' ? '8' : String(Number(last) + 1);
  return `${value.slice(0, -1)}${next}`;
}

function writeTargetLabel(target: WriteTarget | null): string {
  if (target === 'usd') return 'USD slot 0 rate';
  if (target === 'eur') return 'EUR slot 1 rate';
  if (target === 'converter') return 'converter rate';
  return 'rate';
}

function writeFieldLabel(field: string): string {
  if (field === 'slot0Rate') return 'USD slot 0 rate';
  if (field === 'slot1Rate') return 'EUR slot 1 rate';
  if (field === 'converterRate') return 'converter rate';
  if (field === 'slot0FullName') return 'slot 0 full name';
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
  if (snapshot.phase === 'error') {
    return snapshot.error?.message ?? 'The cashier could not be reached.';
  }
  if (snapshot.captureState === 'failed' || snapshot.captureState === 'captureOnly') {
    return 'The cashier did not confirm the connection check. Check the cable and port, then retry.';
  }
  if (snapshot.readState === 'failed') {
    return 'The cashier did not return the local bootstrap records. Retry the read.';
  }
  if (snapshot.foreignReadState === 'failed') {
    return 'The cashier did not return the USD/EUR records. Retry the read.';
  }
  if (snapshot.converterReadState === 'failed') {
    return 'The cashier did not return the converter record. Retry the read.';
  }
  return null;
}

function formatTestRate(value: string | undefined): string {
  if (!value) return '—';
  const rate = parseRawRate(value);
  return rate === null ? value : `${formatRateValue(rate)} (raw ${value})`;
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
  const [nbp, setNbp] = useState<NbpState>({ status: 'loading' });

  useEffect(() => {
    void session.acquireLock();
  }, [session]);

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

  const entries = useMemo(() => displayEntries(snapshot.capture, 250), [snapshot.capture]);
  const cashierRates = useMemo(() => {
    const rates: Partial<Record<CurrencyCode, string>> = {};
    const read = snapshot.foreignRead;
    if (read?.slot0Name === 'USD' || read?.slot0Name === 'EUR') {
      if (read.slot0Rate) rates[read.slot0Name] = read.slot0Rate;
    }
    if (read?.slot1Name === 'USD' || read?.slot1Name === 'EUR') {
      if (read.slot1Rate) rates[read.slot1Name] = read.slot1Rate;
    }
    return rates;
  }, [snapshot.foreignRead]);
  const deviceBusy =
    snapshot.captureState === 'capturing' ||
    snapshot.readState === 'reading' ||
    snapshot.foreignReadState === 'reading' ||
    snapshot.converterReadState === 'reading' ||
    snapshot.writeTestState === 'writing';

  const readError = readErrorMessage(snapshot);

  const clearCapture = () => {
    if (!deviceBusy) setClearOpen(true);
  };

  const confirmClear = () => {
    session.clearCapture();
    setCopyState('idle');
    setClearOpen(false);
  };

  const runAutoReads = async () => {
    await session.runPreflight();
    if (session.getSnapshot().captureState !== 'captured') return;
    await session.runReadForeign();
    if (session.getSnapshot().foreignReadState !== 'read') return;
    await session.runReadConverter();
  };

  const connect = async (kind: TransportKind) => {
    await session.connect(kind);
    if (session.getSnapshot().phase === 'connected') await runAutoReads();
  };

  const retryReads = () => {
    if (session.getSnapshot().phase === 'connected') {
      void runAutoReads();
    } else {
      void connect('webserial');
    }
  };

  const writeRates = {
    usd: snapshot.foreignRead?.slot0Rate,
    eur: snapshot.foreignRead?.slot1Rate,
    converter: snapshot.converterRead?.rate,
  } satisfies Record<WriteTarget, string | undefined>;

  const writeOriginal = writeTarget ? writeRates[writeTarget] : undefined;
  const writeTemporary = writeOriginal ? nextRate(writeOriginal) : '';

  const runWriteTest = (target: WriteTarget) => {
    if (!writeRates[target]) return;
    setWriteTarget(target);
    setWriteOpen(true);
  };

  const confirmWriteTest = () => {
    const target = writeTarget;
    setWriteOpen(false);
    setWriteTarget(null);
    if (target === 'usd') void session.runRateWriteTest(0);
    if (target === 'eur') void session.runRateWriteTest(1);
    if (target === 'converter') void session.runConverterRateWriteTest();
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
      <header className="header">
        <div>
          <p className="eyebrow">Datecs WP-25 Plus</p>
          <h1>Currency reader</h1>
          <p className="lede">
            Web Serial connection with automatic preflight, foreign-slot and converter reads, NBP
            comparison and single-rate write tests. No <code>0xFF</code>; no full update or
            multi-field write.
          </p>
        </div>
        <span className="version">v{__APP_VERSION__}</span>
      </header>

      <section className="card" aria-labelledby="connection-heading">
        <div className="card-heading">
          <div>
            <h2 id="connection-heading">Connection</h2>
            <p className="muted">{lockMessage(snapshot.lockState)}</p>
          </div>
          <span className={`state state-${stateClass(snapshot.phase)}`}>
            {stateLabel(snapshot.phase)}
          </span>
        </div>

        <div className="connection-grid">
          <div>
            <p className="label">Transport</p>
            <div className="button-row">
              <button
                type="button"
                className="button primary"
                onClick={() => void connect('webserial')}
                disabled={!canConnect || !supportsWebSerial()}
                title={
                  supportsWebSerial()
                    ? 'Select the cashier with Web Serial'
                    : 'Web Serial is unavailable'
                }
              >
                Connect Web Serial
              </button>
              <button
                type="button"
                className="button"
                onClick={() => void session.disconnect()}
                disabled={snapshot.phase === 'idle' || deviceBusy}
              >
                Disconnect
              </button>
            </div>
            <p className="hint">Web Serial is the only transport. Nothing is auto-selected.</p>
            {snapshot.lockState === 'in-use' || snapshot.lockState === 'unavailable' ? (
              <button type="button" className="button" onClick={() => void session.acquireLock()}>
                Retry device lock
              </button>
            ) : null}
          </div>

          <dl className="facts">
            <div>
              <dt>Transport</dt>
              <dd>{snapshot.transportKind ? TRANSPORT_LABEL[snapshot.transportKind] : '—'}</dd>
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
          className={`status${snapshot.error ? ' status-error' : ''}`}
          role={snapshot.error ? 'alert' : 'status'}
          aria-live={snapshot.error ? 'assertive' : 'polite'}
        >
          {snapshot.phase === 'connected'
            ? deviceBusy
              ? 'Connected · reading cashier…'
              : 'Connected.'
            : snapshot.error
              ? snapshot.error.message
              : lockMessage(snapshot.lockState)}
        </div>
      </section>

      {readError ? (
        <section className="card read-error" role="alert" aria-labelledby="read-error-heading">
          <div className="card-heading">
            <div>
              <h2 id="read-error-heading">Could not read the cashier</h2>
              <p className="muted">{readError}</p>
            </div>
          </div>
          <button
            type="button"
            className="button primary"
            onClick={retryReads}
            disabled={deviceBusy}
          >
            Retry reading
          </button>
        </section>
      ) : null}

      <NbpPanel state={nbp} onRefresh={() => void loadNbp()} />

      <RateComparison nbp={nbp} cashier={cashierRates} />

      <UpdatePreview foreign={snapshot.foreignRead} converter={snapshot.converterRead} nbp={nbp} />

      {snapshot.converterRead ? (
        <section className="card write-test-card" aria-labelledby="write-test-heading">
          <div className="foreign-probe write-test">
            <div className="card-heading">
              <div>
                <h2 id="write-test-heading">Rate write tests</h2>
                <p className="muted">
                  One field at a time: temporary +1 raw unit, readback, restore, readback. USD, EUR
                  and converter tests are separate; no names or flags.
                </p>
              </div>
              <span className={`state state-${stateClass(snapshot.writeTestState)}`}>
                {stateLabel(snapshot.writeTestState)}
              </span>
            </div>
            <div className="button-row">
              {(['usd', 'eur', 'converter'] as const).map((target) => (
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
            </dl>
            {snapshot.writeTest && !snapshot.writeTest.restored ? (
              <p className="plan-warnings" role="alert">
                Restore did not verify. The cashier may still hold{` `}
                <code>{formatTestRate(snapshot.writeTest.temporary)}</code>. Do not run the test
                again; stop and report the log.
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
                  <dd>{formatTestRate(snapshot.writeTest.temporaryReadback)}</dd>
                </div>
                <div>
                  <dt>Restored readback</dt>
                  <dd>{formatTestRate(snapshot.writeTest.restoredReadback)}</dd>
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

      <section className="card logger" aria-labelledby="logger-heading">
        <div className="card-heading">
          <div>
            <h2 id="logger-heading">Logger</h2>
            <p className="muted">
              Device log in memory · showing {entries.length} of {snapshot.capture.length} entries ·
              NBP is fetched separately
            </p>
          </div>
          <div className="button-row compact">
            <button
              type="button"
              className="button"
              onClick={clearCapture}
              disabled={deviceBusy || snapshot.capture.length === 0}
            >
              Clear
            </button>
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
          </div>
        </div>

        {entries.length === 0 ? (
          <p className="empty">No entries yet. Connect or disconnect to create a session entry.</p>
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
      </section>

      <footer className="footer">
        <p>
          Read-only records plus explicit USD, EUR and converter single-rate write tests. No full or
          multi-field update, and no <code>0xFF</code>.
        </p>
      </footer>

      <ConfirmDialog
        open={clearOpen}
        title="Clear the device log?"
        confirmLabel="Clear"
        onConfirm={confirmClear}
        onCancel={() => setClearOpen(false)}
      >
        <p>
          This removes the in-memory log and the preflight result. It does not send anything to the
          cashier.
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={writeOpen}
        title={`Run ${writeTargetLabel(writeTarget)} test?`}
        confirmLabel="Run test"
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
            <dd>{formatTestRate(writeOriginal)}</dd>
          </div>
          <div>
            <dt>Temporary</dt>
            <dd>{formatTestRate(writeTemporary)}</dd>
          </div>
          <div>
            <dt>Restore</dt>
            <dd>{formatTestRate(writeOriginal)}</dd>
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
