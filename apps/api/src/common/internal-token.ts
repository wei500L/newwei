import { timingSafeEqual } from "node:crypto";

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const trimmed = header.trim();
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^bearer\s+(.+)$/i);
  if (!match?.[1]) {
    return null;
  }
  const token = match[1].trim();
  return token ? token : null;
}

export function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
