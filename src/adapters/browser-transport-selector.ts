import { SimulatorTransport } from './simulator-transport';
import { WebSerialTransport } from './webserial-transport';
import {
  TransportError,
  toTransportError,
  type DeviceTransport,
  type TransportKind,
  type TransportSelector,
} from '../ports/transport';

export class BrowserTransportSelector implements TransportSelector {
  async select(kind: TransportKind): Promise<DeviceTransport> {
    if (kind === 'simulator') {
      return new SimulatorTransport();
    }

    if (typeof navigator === 'undefined' || !navigator.serial) {
      throw new TransportError('unsupported', 'Web Serial is not available in this browser.', {
        operation: 'webserial.request-port',
        stage: 'capability',
      });
    }
    try {
      const port = await navigator.serial.requestPort();
      return new WebSerialTransport(port);
    } catch (error) {
      throw toTransportError(error, 'webserial.request-port', {
        operation: 'webserial.request-port',
        stage: 'request-port',
      });
    }
  }
}
