import { describe, expect, it } from 'vitest';
import { parseResponse } from '../protocol/preflight';
import { SIMULATOR_PREFLIGHT_RESPONSE, SimulatorTransport } from './simulator-transport';

describe('SimulatorTransport', () => {
  it('answers the preflight with the exact captured Type2 response', async () => {
    const transport = new SimulatorTransport();
    const info = await transport.open();
    await transport.write(
      Uint8Array.from([
        0x01, 0x30, 0x30, 0x32, 0x3a, 0x20, 0x30, 0x30, 0x34, 0x3a, 0x05, 0x30, 0x31, 0x3b, 0x3f,
        0x03,
      ]),
    );
    const response = await transport.readChunk(500);

    expect(info.kind).toBe('simulator');
    expect(Array.from(response)).toEqual(Array.from(SIMULATOR_PREFLIGHT_RESPONSE));
    expect(parseResponse(response).kind).toBe('valid');
  });

  it('does not answer before a write', async () => {
    const transport = new SimulatorTransport();
    await transport.open();
    await expect(transport.readChunk(500)).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects a programming command', async () => {
    const transport = new SimulatorTransport();
    await transport.open();
    await expect(transport.write(Uint8Array.from([0x01, 0x02, 0x03, 0xff]))).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
