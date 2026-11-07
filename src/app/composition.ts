import { BrowserTransportSelector } from '../adapters/browser-transport-selector';
import { CaptureLog } from '../domain/capture-log';
import { SystemClock } from '../ports/clock';
import { BrowserDeviceLock } from '../ports/device-lock';
import { DeviceSession } from '../session/device-session';

export function createSession(): DeviceSession {
  return new DeviceSession(
    new BrowserTransportSelector(),
    new CaptureLog(new SystemClock()),
    new BrowserDeviceLock(),
  );
}
