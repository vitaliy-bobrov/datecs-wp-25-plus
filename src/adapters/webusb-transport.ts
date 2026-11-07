import {
  TransportError,
  toTransportError,
  type DeviceTransport,
  type TransportDeviceDetail,
  type TransportErrorDetail,
  type TransportInfo,
} from '../ports/transport';

function cleanLabel(value: string | undefined, fallback: string): string {
  const text = value?.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, 80) : fallback;
}

export class WebUsbTransport implements DeviceTransport {
  private claimedInterface: number | null = null;

  constructor(private readonly device: WebUsbDevice) {}

  private deviceDetail(): TransportDeviceDetail {
    return {
      label: cleanLabel(this.device.productName, 'WebUSB device'),
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      product: cleanLabel(this.device.productName, 'WebUSB device'),
    };
  }

  private info(): TransportInfo {
    return {
      kind: 'webusb',
      label: cleanLabel(this.device.productName, 'WebUSB device'),
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      product: cleanLabel(this.device.productName, 'WebUSB device'),
    };
  }

  private detail(stage: string, extra: TransportErrorDetail = {}): TransportErrorDetail {
    return {
      operation: 'webusb.open',
      stage,
      device: this.deviceDetail(),
      ...extra,
    };
  }

  async open(): Promise<TransportInfo> {
    const device = this.deviceDetail();

    try {
      await this.device.open();
    } catch (error) {
      throw toTransportError(error, 'webusb.open', this.detail('device.open'));
    }

    let stage = 'configuration';
    let configurationValue: number | undefined;
    let interfaceNumber: number | undefined;
    let alternateSetting: number | undefined;
    let endpointCount: number | undefined;

    try {
      let configuration = this.device.configuration;
      if (!configuration) {
        const candidate = this.device.configurations[0];
        if (!candidate) {
          throw new TransportError('unsupported', 'The USB device exposes no configuration.', {
            ...this.detail('configuration'),
            device,
          });
        }
        configurationValue = candidate.configurationValue;
        await this.device.selectConfiguration(candidate.configurationValue);
        configuration = this.device.configuration;
      }

      if (!configuration) {
        throw new TransportError('unsupported', 'The USB device configuration is unavailable.', {
          ...this.detail('configuration'),
          device,
        });
      }
      configurationValue = configuration.configurationValue;

      stage = 'interface-scan';
      for (const iface of configuration.interfaces) {
        const alternate = iface.alternates.find((item) => item.endpoints.length > 0);
        if (!alternate) continue;

        interfaceNumber = iface.interfaceNumber;
        alternateSetting = alternate.alternateSetting;
        endpointCount = alternate.endpoints.length;

        stage = 'select-alternate';
        await this.device.selectAlternateInterface(iface.interfaceNumber, alternate.alternateSetting);

        stage = 'claim-interface';
        await this.device.claimInterface(iface.interfaceNumber);
        this.claimedInterface = iface.interfaceNumber;
        break;
      }

      if (this.claimedInterface === null) {
        stage = 'no-data-interface';
      }
    } catch (error) {
      try {
        await this.close();
      } catch {
        // Keep the original diagnostic.
      }
      throw toTransportError(error, 'webusb.open', {
        ...this.detail(stage),
        device,
        configurationValue,
        interfaceNumber,
        alternateSetting,
        endpointCount,
      });
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
      throw toTransportError(error, 'webusb.close', { ...this.detail('close'), operation: 'webusb.close' });
    }
  }

  async write(_bytes: Uint8Array): Promise<void> {
    throw new TransportError('unsupported', 'Device commands are not enabled in this story.', {
      operation: 'webusb.write',
      stage: 'write',
      device: this.deviceDetail(),
    });
  }

  async readChunk(_timeoutMs: number): Promise<Uint8Array> {
    throw new TransportError('unsupported', 'Device reads are not enabled in this story.', {
      operation: 'webusb.read',
      stage: 'read',
      device: this.deviceDetail(),
    });
  }

  async flushInput(): Promise<void> {
    // No device commands are sent in this story.
  }
}
