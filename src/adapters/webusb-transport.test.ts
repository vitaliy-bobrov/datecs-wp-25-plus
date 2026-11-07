import { describe, expect, it } from 'vitest';
import { WebUsbTransport } from './webusb-transport';

class FakeUsbDevice implements WebUsbDevice {
  vendorId = 0xfff0;
  productId = 0x0100;
  productName = 'Datecs Serial';
  configuration: WebUsbConfiguration;
  configurations: WebUsbConfiguration[];
  calls: string[] = [];
  claimed = false;

  constructor() {
    this.configuration = {
      configurationValue: 1,
      interfaces: [
        {
          interfaceNumber: 0,
          alternates: [
            {
              alternateSetting: 0,
              endpoints: [{ endpointNumber: 1, direction: 'in', type: 'bulk' }],
            },
          ],
        },
      ],
    };
    this.configurations = [this.configuration];
  }

  async open(): Promise<void> {
    this.calls.push('open');
  }

  async close(): Promise<void> {
    this.calls.push('close');
  }

  async selectConfiguration(value: number): Promise<void> {
    this.calls.push(`select-configuration:${value}`);
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    this.claimed = true;
    this.calls.push(`claim:${interfaceNumber}`);
  }

  async releaseInterface(interfaceNumber: number): Promise<void> {
    this.claimed = false;
    this.calls.push(`release:${interfaceNumber}`);
  }

  async selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void> {
    if (!this.claimed) {
      throw new DOMException(
        "Failed to execute 'selectAlternateInterface' on 'USBDevice': The specified interface has not been claimed.",
        'InvalidStateError',
      );
    }
    this.calls.push(`select-alternate:${interfaceNumber}/${alternateSetting}`);
  }
}

describe('WebUsbTransport', () => {
  it('claims the interface before selecting its alternate', async () => {
    const device = new FakeUsbDevice();
    const transport = new WebUsbTransport(device);
    const info = await transport.open();

    expect(info.kind).toBe('webusb');
    expect(device.calls.indexOf('claim:0')).toBeGreaterThan(-1);
    expect(device.calls.indexOf('select-alternate:0/0')).toBeGreaterThan(device.calls.indexOf('claim:0'));
  });
});
