import {
  TransportError,
  toTransportError,
  type DeviceTransport,
  type TransportInfo,
} from '../ports/transport';

function cleanLabel(value: string | undefined, fallback: string): string {
  const text = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, 80) : fallback;
}

export class WebUsbTransport implements DeviceTransport {
  private claimedInterface: number | null = null;

  constructor(private readonly device: WebUsbDevice) {}

  private info(): TransportInfo {
    return {
      kind: 'webusb',
      label: cleanLabel(this.device.productName, 'WebUSB device'),
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      product: cleanLabel(this.device.productName, 'WebUSB device'),
    };
  }

  async open(): Promise<TransportInfo> {
    try {
      await this.device.open();
    } catch (error) {
      throw toTransportError(error);
    }

    try {
      if (!this.device.configuration) {
        const configuration = this.device.configurations[0];
        if (!configuration) {
          throw new TransportError('unsupported', 'The USB device exposes no configuration.');
        }
        await this.device.selectConfiguration(configuration.configurationValue);
      }

      const configuration = this.device.configuration;
      if (configuration) {
        for (const iface of configuration.interfaces) {
          const alternate = iface.alternates.find((item) => item.endpoints.length > 0);
          if (!alternate) continue;
          await this.device.selectAlternateInterface(iface.interfaceNumber, alternate.alternateSetting);
          await this.device.claimInterface(iface.interfaceNumber);
          this.claimedInterface = iface.interfaceNumber;
          break;
        }
      }
    } catch (error) {
      await this.close();
      throw toTransportError(error);
    }

    return this.info();
  }

  async close(): Promise<void> {
    try {
      if (this.claimedInterface !== null) {
        await this.device.releaseInterface(this.claimedInterface);
        this.claimedInterface = null;
      }
      await this.device.close();
    } catch (error) {
      throw toTransportError(error);
    }
  }

  async write(_bytes: Uint8Array): Promise<void> {
    throw new TransportError('unsupported', 'Device commands are not enabled in this story.');
  }

  async readChunk(_timeoutMs: number): Promise<Uint8Array> {
    throw new TransportError('unsupported', 'Device reads are not enabled in this story.');
  }

  async flushInput(): Promise<void> {
    // No device commands are sent in this story.
  }
}
