import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { supportsWebSerial } from '../app/capabilities';
import { nbpClient } from '../app/nbp-service';
import type { CaptureEntry } from '../domain/capture-log';
import { errorMessage } from '../domain/nbp';
import { type CurrencyCode, formatFlag, formatRateValue, parseRawRate } from '../domain/rates';
import type { TransportKind } from '../ports/transport';
import type { DeviceSession, SessionSnapshot } from '../session/device-session';
import { ConfirmDialog } from './ConfirmDialog';
import { captureDownload, downloadText } from './download';
import { displayEntries, formatTimestamp, formatUsbIds, stateClass, stateLabel } from './log-view';
import { NbpPanel, type NbpState } from './NbpPanel';
import { RateComparison } from './RateComparison';
import { UpdatePreview } from './UpdatePreview';

interface AppProps {
  session: DeviceSession;
}

function formatRate(value: string | undefined): string {
  if (!value) return '—';
  const rate = parseRawRate(value);
  return rate === null ? value : `${formatRateValue(rate)} (raw ${value})`;
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

export function App({ session }: AppProps) {
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [clearOpen, setClearOpen] = useState(false);
  const [writeOpen, setWriteOpen] = useState(false);
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

  const canPreflight = snapshot.phase === 'connected' && !deviceBusy;

  const clearCapture = () => {
    if (!deviceBusy) setClearOpen(true);
  };

  const confirmClear = () => {
    session.clearCapture();
    setCopyState('idle');
    setClearOpen(false);
  };

  const connect = async (kind: TransportKind) => {
    await session.connect(kind);
    if (session.getSnapshot().phase === 'connected') {
      await session.runPreflight();
    }
  };

  const writeOriginal = snapshot.foreignRead?.slot0FullName;
  const writeTemporary = writeOriginal
    ? `${writeOriginal[0] === 'X' ? 'Y' : 'X'}${writeOriginal.slice(1)}`
    : '';

  const runWriteTest = () => {
    if (!writeOriginal) return;
    setWriteOpen(true);
  };

  const confirmWriteTest = () => {
    setWriteOpen(false);
    void session.runFullNameWriteTest();
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
            Web Serial connection with preflight, local and foreign reads, NBP comparison and a
            one-field full-name write test. No <code>0xFF</code>; no rate or multi-field write.
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
                onClick={() => void connect('simulator')}
                disabled={!canConnect}
                title="Open the built-in Type2 preflight simulator"
              >
                Open simulator
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
            <p className="hint">
              Web Serial is the only hardware transport. The simulator is an explicit test path;
              nothing is auto-selected.
            </p>
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
            ? `Connected via ${snapshot.transportKind ? TRANSPORT_LABEL[snapshot.transportKind] : 'transport'}.`
            : snapshot.error
              ? `${snapshot.error.message}${snapshot.error.detail?.stage ? ` (${snapshot.error.detail.stage}${snapshot.error.detail.errorName ? `, ${snapshot.error.detail.errorName}` : ''})` : ''}${snapshot.error.detail?.errorMessage ? ` — ${snapshot.error.detail.errorMessage}` : ''}`
              : lockMessage(snapshot.lockState)}
        </div>
      </section>

      <section className="card preflight" aria-labelledby="preflight-heading">
        <div className="card-heading">
          <div>
            <h2 id="preflight-heading">Preflight</h2>
            <p className="muted">
              Connect runs this captured short preflight automatically; use the button to retry.
              Currency reads are separate; no <code>0xFF</code> or write.
            </p>
          </div>
          <span className={`state state-${stateClass(snapshot.captureState)}`}>
            {stateLabel(snapshot.captureState)}
          </span>
        </div>

        <div className="button-row">
          <button
            type="button"
            className="button primary"
            onClick={() => void session.runPreflight()}
            disabled={!canPreflight}
          >
            {snapshot.captureState === 'capturing' ? 'Capturing…' : 'Run preflight'}
          </button>
        </div>

        {snapshot.preflight ? (
          <div className="preflight-result" aria-live="polite">
            <p>
              <strong>{snapshot.preflight.status}</strong>
              {snapshot.preflight.mode ? ` · ${snapshot.preflight.mode} frame` : ''}
              {snapshot.preflight.statusHex ? ` · status ${snapshot.preflight.statusHex}` : ''}
              {snapshot.preflight.secondaryStatusHex
                ? ` · status2 ${snapshot.preflight.secondaryStatusHex}`
                : ''}
              {snapshot.preflight.reason ? ` · ${snapshot.preflight.reason}` : ''}
              {snapshot.preflight.attempts ? ` · ${snapshot.preflight.attempts} attempt(s)` : ''}
              {snapshot.preflight.elapsedMs !== undefined
                ? ` · ${snapshot.preflight.elapsedMs} ms`
                : ''}
            </p>
            {snapshot.preflight.txHex ? (
              <p className="raw">
                <span>Sent</span>
                <code>{snapshot.preflight.txHex}</code>
              </p>
            ) : null}
            {snapshot.preflight.rawHex ? (
              <p className="raw">
                <span>Raw response</span>
                <code>{snapshot.preflight.rawHex}</code>
              </p>
            ) : null}
          </div>
        ) : (
          <p className="empty">No preflight yet. Connect first, then run it.</p>
        )}

        <div className="read-local">
          <div className="card-heading">
            <div>
              <h3>Local currency read</h3>
              <p className="muted">
                Replays the exact ECR Tool read sequence. Local PLN is confirmed; the foreign read
                below is experimental.
              </p>
            </div>
            <span className={`state state-${stateClass(snapshot.readState)}`}>
              {stateLabel(snapshot.readState)}
            </span>
          </div>
          <button
            type="button"
            className="button primary"
            onClick={() => void session.runReadLocal()}
            disabled={
              snapshot.transportKind !== 'webserial' ||
              snapshot.captureState !== 'captured' ||
              snapshot.readState === 'reading'
            }
          >
            {snapshot.readState === 'reading' ? 'Reading…' : 'Read local currencies'}
          </button>

          {snapshot.localRead ? (
            <>
              <dl className="read-values">
                <div>
                  <dt>Barcode</dt>
                  <dd>{snapshot.localRead.barcode ?? '—'}</dd>
                </div>
                <div>
                  <dt>Local name</dt>
                  <dd>{snapshot.localRead.localName ?? '—'}</dd>
                </div>
                <div>
                  <dt>Currency date</dt>
                  <dd>{snapshot.localRead.currencyDate ?? '—'}</dd>
                </div>
                <div>
                  <dt>Programmed local</dt>
                  <dd>{snapshot.localRead.pgmLocalName ?? '—'}</dd>
                </div>
                <div>
                  <dt>Programmed date</dt>
                  <dd>{snapshot.localRead.pgmCurrencyDate ?? '—'}</dd>
                </div>
              </dl>
              {snapshot.localRead.rawFrames?.length ? (
                <details className="raw-frames">
                  <summary>Raw frames</summary>
                  <pre>{snapshot.localRead.rawFrames.join('\n')}</pre>
                </details>
              ) : null}
            </>
          ) : null}

          <div className="foreign-probe">
            <div className="card-heading">
              <div>
                <h4>Foreign slots</h4>
                <p className="muted">
                  Reads names, full names, raw rates and Change after Z flags for slots 0 and 1. No
                  <code>0xFF</code>, no write. Experimental until confirmed on hardware.
                </p>
              </div>
              <span className={`state state-${stateClass(snapshot.foreignReadState)}`}>
                {stateLabel(snapshot.foreignReadState)}
              </span>
            </div>
            <button
              type="button"
              className="button"
              onClick={() => void session.runReadForeign()}
              disabled={!snapshot.localRead || deviceBusy}
            >
              {snapshot.foreignReadState === 'reading' ? 'Reading…' : 'Read foreign slots'}
            </button>
            {snapshot.foreignRead ? (
              <>
                <dl className="read-values">
                  <div>
                    <dt>Slot 0 name</dt>
                    <dd>{snapshot.foreignRead.slot0Name ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Slot 0 rate</dt>
                    <dd>{formatRate(snapshot.foreignRead.slot0Rate)}</dd>
                  </div>
                  <div>
                    <dt>Slot 1 name</dt>
                    <dd>{snapshot.foreignRead.slot1Name ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Slot 1 rate</dt>
                    <dd>{formatRate(snapshot.foreignRead.slot1Rate)}</dd>
                  </div>
                  <div>
                    <dt>Slot 0 full name</dt>
                    <dd>{snapshot.foreignRead.slot0FullName ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Slot 0 change after Z</dt>
                    <dd>{formatFlag(snapshot.foreignRead.slot0ChangeAfterZ)}</dd>
                  </div>
                  <div>
                    <dt>Slot 1 full name</dt>
                    <dd>{snapshot.foreignRead.slot1FullName ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Slot 1 change after Z</dt>
                    <dd>{formatFlag(snapshot.foreignRead.slot1ChangeAfterZ)}</dd>
                  </div>
                </dl>
                {snapshot.foreignRead.rawFrames?.length ? (
                  <details className="raw-frames">
                    <summary>Raw frames</summary>
                    <pre>{snapshot.foreignRead.rawFrames.join('\n')}</pre>
                  </details>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="foreign-probe">
            <div className="card-heading">
              <div>
                <h4>Converter record</h4>
                <p className="muted">
                  Reads converter name, four-decimal rate and Print-converter flag. No{' '}
                  <code>0xFF</code>, no write. Experimental until confirmed on hardware.
                </p>
              </div>
              <span className={`state state-${stateClass(snapshot.converterReadState)}`}>
                {stateLabel(snapshot.converterReadState)}
              </span>
            </div>
            <button
              type="button"
              className="button"
              onClick={() => void session.runReadConverter()}
              disabled={!snapshot.foreignRead || deviceBusy}
            >
              {snapshot.converterReadState === 'reading' ? 'Reading…' : 'Read converter'}
            </button>
            {snapshot.converterRead ? (
              <>
                <dl className="read-values">
                  <div>
                    <dt>Name</dt>
                    <dd>{snapshot.converterRead.name ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Rate</dt>
                    <dd>{formatRate(snapshot.converterRead.rate)}</dd>
                  </div>
                  <div>
                    <dt>Print converter</dt>
                    <dd>{formatFlag(snapshot.converterRead.printFlag)}</dd>
                  </div>
                </dl>
                {snapshot.converterRead.rawFrames?.length ? (
                  <details className="raw-frames">
                    <summary>Raw frames</summary>
                    <pre>{snapshot.converterRead.rawFrames.join('\n')}</pre>
                  </details>
                ) : null}
              </>
            ) : null}
          </div>

          <div className="foreign-probe write-test">
            <div className="card-heading">
              <div>
                <h4>One-field write test</h4>
                <p className="muted">
                  Writes only slot 0 full name: temporary marker, readback, restore, readback. One
                  field, two writes, no rates or flags. Production-first experiment.
                </p>
              </div>
              <span className={`state state-${stateClass(snapshot.writeTestState)}`}>
                {stateLabel(snapshot.writeTestState)}
              </span>
            </div>
            <button
              type="button"
              className="button"
              onClick={runWriteTest}
              disabled={
                !snapshot.converterRead ||
                snapshot.readState !== 'read' ||
                deviceBusy ||
                !snapshot.foreignRead?.slot0FullName
              }
            >
              {snapshot.writeTestState === 'writing' ? 'Writing…' : 'Run one-field write test'}
            </button>
            {snapshot.foreignRead?.slot0FullName ? (
              <p className="muted test-value">
                Current full name: <code>{snapshot.foreignRead.slot0FullName}</code>
              </p>
            ) : null}
            {snapshot.writeTest && !snapshot.writeTest.restored ? (
              <p className="plan-warnings" role="alert">
                Restore did not verify. The cashier may still hold{` `}
                <code>{snapshot.writeTest.temporary}</code>. Do not run the test again; stop and
                report the log.
              </p>
            ) : null}
            {snapshot.writeTest ? (
              <dl className="read-values">
                <div>
                  <dt>Temporary readback</dt>
                  <dd>{snapshot.writeTest.temporaryReadback ?? '—'}</dd>
                </div>
                <div>
                  <dt>Restored readback</dt>
                  <dd>{snapshot.writeTest.restoredReadback ?? '—'}</dd>
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
        </div>
      </section>

      <NbpPanel state={nbp} onRefresh={() => void loadNbp()} />

      <RateComparison nbp={nbp} cashier={cashierRates} />

      <UpdatePreview foreign={snapshot.foreignRead} converter={snapshot.converterRead} nbp={nbp} />

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
          Read-only records plus one explicit slot-0 full-name write test. No rate or multi-field
          write, and no <code>0xFF</code>.
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
        title="Run one-field write test?"
        confirmLabel="Run test"
        onConfirm={confirmWriteTest}
        onCancel={() => setWriteOpen(false)}
      >
        <p>
          This sends two writes to the connected cashier and reads back after each. Use only when
          the cashier is idle.
        </p>
        <dl className="read-values">
          <div>
            <dt>Field</dt>
            <dd>slot 0 full name</dd>
          </div>
          <div>
            <dt>Current</dt>
            <dd>{writeOriginal}</dd>
          </div>
          <div>
            <dt>Temporary</dt>
            <dd>{writeTemporary}</dd>
          </div>
          <div>
            <dt>Restore</dt>
            <dd>{writeOriginal}</dd>
          </div>
        </dl>
        <p>
          No rate, short name, flag or converter value is touched. If restore fails, the cashier may
          keep the temporary name; stop and report the log.
        </p>
      </ConfirmDialog>
    </main>
  );
}
