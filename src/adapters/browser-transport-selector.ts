import { WebSerialTransport } from './webserial-transport';
import { WebUsbTransport } from './webusb-transport';
import {
  TransportError,
  toTransportError,
  type DeviceTransport,
  type TransportKind,
  type TransportSelector,
} from '../ports/transport';

export class BrowserTransportSelector implements TransportSelector {
  async select(kind: TransportKind): Promise<DeviceTransport> {
    if (kind === 'webusb') {
      if (typeof navigator === 'undefined' || !navigator.usb) {
        throw new TransportError('unsupported', 'WebUSB is not available in this browser.', {
          operation: 'webusb.request-device',
          stage: 'capability',
        });
      }
      try {
        const device = await navigator.usb.requestDevice({ filters: [] });
        return new WebUsbTransport(device);
      } catch (error) {
        throw toTransportError(error, 'webusb.request-device', {
          operation: 'webusb.request-device',
          stage: 'request-device',
        });
      }
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
