import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { supportsWebSerial } from '../app/capabilities';
import { nbpClient } from '../app/nbp-service';
import type { CaptureEntry } from '../domain/capture-log';
import { errorMessage } from '../domain/nbp';
import type { TransportKind } from '../ports/transport';
import type { DeviceSession, SessionSnapshot } from '../session/device-session';
import { captureDownload, downloadText } from './download';
import { displayEntries, formatTimestamp, formatUsbIds, stateClass, stateLabel } from './log-view';
import { NbpPanel, type NbpState } from './NbpPanel';

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

export function App({ session }: AppProps) {
  const snapshot = useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
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
  const busy = snapshot.captureState === 'capturing';

  const canPreflight = snapshot.phase === 'connected' && snapshot.captureState !== 'capturing';

  const clearCapture = () => {
    if (busy) return;
    if (window.confirm('Clear the device log and preflight result?')) {
      session.clearCapture();
      setCopyState('idle');
    }
  };

  const connect = (kind: TransportKind) => {
    void session.connect(kind);
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
          <h1>Capture shell</h1>
          <p className="lede">
            Read-only Web Serial or simulator connection, preflight capture, Type2 logger and NBP
            reference. This build sends only the known preflight — no currency read or write.
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
                onClick={() => connect('webserial')}
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
                onClick={() => connect('simulator')}
                disabled={!canConnect}
                title="Open the built-in Type2 preflight simulator"
              >
                Open simulator
              </button>
              <button
                type="button"
                className="button"
                onClick={() => void session.disconnect()}
                disabled={snapshot.phase === 'idle'}
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
              Sends the captured short preflight; raw response capture only. No <code>0xFF</code>,
              currency read or write.
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
      </section>

      <NbpPanel state={nbp} onRefresh={() => void loadNbp()} />

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
              disabled={busy || snapshot.capture.length === 0}
            >
              Clear
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void copy()}
              disabled={busy || snapshot.capture.length === 0}
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
              disabled={busy || snapshot.capture.length === 0}
            >
              Download JSONL
            </button>
            <button
              type="button"
              className="button"
              onClick={() => download('text')}
              disabled={busy || snapshot.capture.length === 0}
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
          Web Serial or simulator preflight capture only. No currency read, 0xFF or write is
          implemented.
        </p>
      </footer>
    </main>
  );
}
