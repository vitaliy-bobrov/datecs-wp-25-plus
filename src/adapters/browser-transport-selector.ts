import {
  type DeviceTransport,
  TransportError,
  type TransportKind,
  type TransportSelector,
  toTransportError,
} from '../ports/transport';
import { SimulatorTransport } from './simulator-transport';
import { WebSerialTransport } from './webserial-transport';

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
      const port = await navigator.serial.requestPort({
        filters: [{ usbVendorId: 0xfff0, usbProductId: 0x0100 }],
      });
      return new WebSerialTransport(port);
    } catch (error) {
      throw toTransportError(error, 'webserial.request-port', {
        operation: 'webserial.request-port',
        stage: 'request-port',
      });
    }
  }
}
