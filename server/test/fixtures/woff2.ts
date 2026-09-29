export function woff2Fixture(length = 64): Buffer {
  const bytes = Buffer.alloc(length, 0x5a);
  bytes.write("wOF2");
  bytes.writeUInt32BE(0x00010000, 4);
  bytes.writeUInt32BE(length, 8);
  bytes.writeUInt16BE(1, 12);
  bytes.writeUInt16BE(0, 14);
  bytes.writeUInt32BE(32, 16);
  bytes.writeUInt32BE(4, 20);
  bytes.fill(0, 24, 48);
  return bytes;
}
