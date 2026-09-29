export function pngFixture(length = 68): Buffer {
  const original = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jz4kAAAAASUVORK5CYII=",
    "base64",
  );
  const bytes = Buffer.alloc(length);
  original.copy(bytes, 0, 0, original.length - 12);
  original.copy(bytes, length - 12, original.length - 12);
  return bytes;
}
