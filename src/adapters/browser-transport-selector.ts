import {
  type DeviceTransport,
  type SelectOptions,
  TransportError,
  type TransportKind,
  type TransportSelector,
  toTransportError,
} from '../ports/transport';
import { matchesLastDevice, readLastDevice, rememberPort } from './last-device';
import { SimulatorTransport } from './simulator-transport';
import { WebSerialTransport } from './webserial-transport';

const KNOWN_FILTER = { usbVendorId: 0xfff0, usbProductId: 0x0100 };

export class BrowserTransportSelector implements TransportSelector {
  async select(kind: TransportKind, options: SelectOptions = {}): Promise<DeviceTransport> {
    if (kind === 'simulator') {
      return new SimulatorTransport();
    }

    if (typeof navigator === 'undefined' || !navigator.serial) {
      throw new TransportError('unsupported', 'Web Serial is not available in this browser.', {
        operation: 'webserial.request-port',
        stage: 'capability',
      });
    }

    if (options.preferSaved !== false && typeof navigator.serial.getPorts === 'function') {
      try {
        const saved = readLastDevice();
        if (saved) {
          const ports = await navigator.serial.getPorts();
          const match = ports.find((candidate) => matchesLastDevice(candidate, saved));
          if (match) {
            rememberPort(match);
            return new WebSerialTransport(match);
          }
        }
      } catch {
        // A failed saved-port lookup falls through to the picker.
      }
    }

    try {
      const port = await navigator.serial.requestPort({ filters: [KNOWN_FILTER] });
      rememberPort(port);
      return new WebSerialTransport(port);
    } catch (error) {
      throw toTransportError(error, 'webserial.request-port', {
        operation: 'webserial.request-port',
        stage: 'request-port',
      });
    }
  }
}
