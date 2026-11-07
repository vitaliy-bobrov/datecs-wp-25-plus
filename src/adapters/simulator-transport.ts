import {
  TransportError,
  type DeviceTransport,
  type TransportInfo,
} from '../ports/transport';

export const SIMULATOR_PREFLIGHT_RESPONSE = Uint8Array.from(
  '16013030333e203030343a300980808280869a8080090480808280869a808005303a343e03'
    .match(/../g)!
    .map((byte) => Number.parseInt(byte, 16)),
);

export class SimulatorTransport implements DeviceTransport {
  private sent = false;
  private emitted = false;
  private closed = false;

  async open(): Promise<TransportInfo> {
    return {
      kind: 'simulator',
      label: 'Built-in preflight simulator',
    };
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) {
      throw new TransportError('device-unavailable', 'The simulator is closed.', {
        operation: 'simulator.write',
        stage: 'write',
      });
    }
    if (bytes[3] === 0xff) {
      throw new TransportError('unsupported', 'The simulator does not accept programming commands.', {
        operation: 'simulator.write',
        stage: 'write',
      });
    }
    this.sent = true;
  }

  async readChunk(_timeoutMs: number): Promise<Uint8Array> {
    if (!this.sent || this.emitted) {
      throw new TransportError('timeout', 'The simulator has no response.', {
        operation: 'simulator.read',
        stage: 'read',
      });
    }
    this.emitted = true;
    return SIMULATOR_PREFLIGHT_RESPONSE;
  }

  async flushInput(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}
