import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { supportsTransport } from '../app/capabilities';
import type { CaptureEntry } from '../domain/capture-log';
import type { DeviceSession, SessionSnapshot } from '../session/device-session';
import type { TransportKind } from '../ports/transport';
import { downloadText } from './download';

interface AppProps {
  session: DeviceSession;
}

const TRANSPORT_LABEL: Record<TransportKind, string> = {
  webusb: 'WebUSB (experimental)',
  webserial: 'Web Serial',
};

const TRANSPORTS: TransportKind[] = ['webserial', 'webusb'];

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString([], { hour12: false });
}

function entrySummary(entry: CaptureEntry): string {
  let summary: string;
  if (entry.kind === 'error') summary = entry.message ?? entry.code ?? 'Error';
  else if (entry.kind === 'connect') summary = `Connected${entry.device ? `: ${entry.device}` : ''}`;
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
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  useEffect(() => {
    void session.acquireLock();
  }, [session]);

  const canConnect =
    snapshot.lockState === 'held' &&
    snapshot.phase !== 'connecting' &&
    snapshot.phase !== 'connected';

  const entries = useMemo(() => [...snapshot.capture].reverse().slice(0, 250), [snapshot.capture]);

  const connect = (kind: TransportKind) => {
    void session.connect(kind);
  };

  const download = (format: 'jsonl' | 'text') => {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'jsonl') {
      downloadText(`datecs-wp25-capture-${stamp}.jsonl`, session.captureJsonl(), 'application/x-ndjson');
    } else {
      downloadText(`datecs-wp25-capture-${stamp}.txt`, session.captureText(), 'text/plain');
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(session.captureText());
      setCopyState('copied');
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
            Read-only connection smoke test and local logger. Web Serial is the working transport; WebUSB is experimental. This build sends no device command.
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
          <span className={`state state-${snapshot.phase}`}>{snapshot.phase}</span>
        </div>

        <div className="connection-grid">
          <div>
            <p className="label">Select a transport</p>
            <div className="button-row">
              {TRANSPORTS.map((kind) => {
                const supported = supportsTransport(kind);
                return (
                  <button
                    key={kind}
                    type="button"
                    className={`button${kind === 'webserial' ? ' primary' : ''}`}
                    onClick={() => connect(kind)}
                    disabled={!canConnect || !supported}
                    title={supported ? `Select a device using ${TRANSPORT_LABEL[kind]}` : `${TRANSPORT_LABEL[kind]} is unavailable`}
                  >
                    Connect with {TRANSPORT_LABEL[kind]}
                  </button>
                );
              })}
              <button
                type="button"
                className="button"
                onClick={() => void session.disconnect()}
                disabled={snapshot.phase !== 'connected' && snapshot.phase !== 'error'}
              >
                Disconnect
              </button>
            </div>
            <p className="hint">
              Web Serial is the working transport. WebUSB is experimental; neither is auto-selected.
            </p>
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
              <dd>
                {snapshot.info?.vendorId !== undefined
                  ? `${snapshot.info.vendorId.toString(16)}:${(snapshot.info.productId ?? 0).toString(16)}`
                  : '—'}
              </dd>
            </div>
          </dl>
        </div>

        <div className="status" role="status" aria-live="polite">
          {snapshot.phase === 'connected'
            ? `Connected via ${snapshot.transportKind ? TRANSPORT_LABEL[snapshot.transportKind] : 'device'}.`
            : snapshot.error
              ? `${snapshot.error.message}${snapshot.error.detail?.stage ? ` (${snapshot.error.detail.stage}${snapshot.error.detail.errorName ? `, ${snapshot.error.detail.errorName}` : ''})` : ''}`
              : lockMessage(snapshot.lockState)}
        </div>
      </section>

      <section className="card logger" aria-labelledby="logger-heading">
        <div className="card-heading">
          <div>
            <h2 id="logger-heading">Logger</h2>
            <p className="muted">
              {snapshot.capture.length} entries · in memory only · no network
            </p>
          </div>
          <div className="button-row compact">
            <button type="button" className="button" onClick={() => session.clearCapture()} disabled={snapshot.capture.length === 0}>
              Clear
            </button>
            <button type="button" className="button" onClick={() => void copy()} disabled={snapshot.capture.length === 0}>
              {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy text'}
            </button>
            <button type="button" className="button" onClick={() => download('jsonl')} disabled={snapshot.capture.length === 0}>
              Download JSONL
            </button>
            <button type="button" className="button" onClick={() => download('text')} disabled={snapshot.capture.length === 0}>
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
                    <td className="mono nowrap">{formatTime(entry.ts)}</td>
                    <td>{entry.kind}</td>
                    <td>{entry.transport ? TRANSPORT_LABEL[entry.transport] : '—'}</td>
                    <td>{entry.device ?? '—'}</td>
                    <td className="mono bytes">{entry.bytesHex ?? '—'}</td>
                    <td>
                      {entrySummary(entry)}
                      {entry.code ? <span className="code"> {entry.code}</span> : null}
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
          Read-only capture foundation. No preflight, currency read, NBP request or write is part of this story.
        </p>
      </footer>
    </main>
  );
}
