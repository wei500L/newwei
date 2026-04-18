import crypto from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function hashOpaqueToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function generateOpaqueToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

export function normalizeEmailAddress(email: string) {
  return email.trim().toLowerCase();
}

export function encodeBase32(input: Buffer) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;

    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

export function decodeBase32(input: string) {
  const normalized = input.trim().toUpperCase().replace(/=+$/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) {
      throw new Error("Invalid base32 input");
    }

    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpSecret() {
  return encodeBase32(crypto.randomBytes(20));
}

export function buildOtpAuthUri(params: {
  issuer: string;
  accountName: string;
  secret: string;
}) {
  const issuer = encodeURIComponent(params.issuer);
  const account = encodeURIComponent(params.accountName);
  const secret = encodeURIComponent(params.secret);
  return `otpauth://totp/${issuer}:${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function generateTotpAt(secret: string, counter: number) {
  const decoded = decodeBase32(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);
  const digest = crypto
    .createHmac("sha1", decoded)
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotpCode(secret: string, code: string, window = 1) {
  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) {
    return false;
  }

  const counter = Math.floor(Date.now() / 30_000);
  for (let offset = -window; offset <= window; offset += 1) {
    if (generateTotpAt(secret, counter + offset) === normalized) {
      return true;
    }
  }

  return false;
}

export function generateRecoveryCodes(count = 8) {
  return Array.from({ length: count }, () =>
    crypto.randomBytes(5).toString("hex").slice(0, 10).toUpperCase(),
  );
}
