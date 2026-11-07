const TYPE2_STATUS = Uint8Array.from([0x80, 0x80, 0x82, 0x80, 0x86, 0x9a, 0x80, 0x80]);

export function type2Response(value: string, delimiter: string): Uint8Array {
  const body = Uint8Array.from([
    0x01,
    ...new TextEncoder().encode(`0039${delimiter}00??0\t${value}`),
    0x04,
    ...TYPE2_STATUS,
    0x05,
  ]);
  const sum = body.slice(1).reduce((total, byte) => total + byte, 0) & 0xffff;
  const bcc = Array.from({ length: 4 }, (_, index) => 0x30 + ((sum >> ((3 - index) * 4)) & 0x0f));
  return Uint8Array.from([...body, ...bcc, 0x03]);
}
