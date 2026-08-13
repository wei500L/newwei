import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import type { EnvService } from "../config/config.service";

const ENCRYPTION_ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const SETTINGS_ENC_TAG = "system-settings:v1";

export interface EncryptedStringValueV1 {
  __enc: typeof SETTINGS_ENC_TAG;
  alg: typeof ENCRYPTION_ALGORITHM;
  iv: string;
  tag: string;
  data: string;
}

export class SystemSettingsEncryptionRequiredError extends Error {
  override name = "SystemSettingsEncryptionRequiredError";

  constructor(message?: string) {
    super(message);
  }
}

export class SystemSettingsDecryptionError extends Error {
  override name = "SystemSettingsDecryptionError";
}

export function decodeSystemSettingsKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("SYSTEM_SETTINGS_ENCRYPTION_KEY is empty");
  }

  const hexCandidate = trimmed.replace(/^0x/i, "");
  if (/^[0-9a-fA-F]+$/.test(hexCandidate) && hexCandidate.length === KEY_BYTES * 2) {
    return Buffer.from(hexCandidate, "hex");
  }

  const base64 = Buffer.from(trimmed, "base64");
  if (base64.length === KEY_BYTES) {
    return base64;
  }

  throw new Error("SYSTEM_SETTINGS_ENCRYPTION_KEY must be 32 bytes (base64) or 64 hex chars");
}

export function isEncryptedStringValueV1(value: unknown): value is EncryptedStringValueV1 {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.__enc === SETTINGS_ENC_TAG &&
    record.alg === ENCRYPTION_ALGORITHM &&
    typeof record.iv === "string" &&
    typeof record.tag === "string" &&
    typeof record.data === "string"
  );
}

export function encryptStringValueV1(plain: string, key: Buffer): EncryptedStringValueV1 {
  if (key.length !== KEY_BYTES) {
    throw new Error("Invalid SYSTEM_SETTINGS_ENCRYPTION_KEY length");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encoded = Buffer.from(plain, "utf8");
  const ciphertext = Buffer.concat([cipher.update(encoded), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    __enc: SETTINGS_ENC_TAG,
    alg: ENCRYPTION_ALGORITHM,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64")
  };
}

export function decryptStringValueV1(payload: EncryptedStringValueV1, key: Buffer): string {
  if (key.length !== KEY_BYTES) {
    throw new Error("Invalid SYSTEM_SETTINGS_ENCRYPTION_KEY length");
  }
  try {
    const iv = Buffer.from(payload.iv, "base64");
    const tag = Buffer.from(payload.tag, "base64");
    const data = Buffer.from(payload.data, "base64");
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
    return plaintext;
  } catch (error) {
    throw new SystemSettingsDecryptionError("Failed to decrypt system setting secret", {
      cause: error
    });
  }
}

export function resolveSettingsKey(env: EnvService): Buffer | undefined {
  const raw = env.systemSettingsEncryptionKey;
  if (!raw) {
    return undefined;
  }
  try {
    return decodeSystemSettingsKey(raw);
  } catch {
    return undefined;
  }
}

export interface SecretEncodingContext {
  configured: boolean | null;
  key: Buffer | undefined;
  isProduction: boolean;
  onPlaintextFallback?: () => void;
}

/**
 * Shared fail-closed secret encoding policy used by every credential write path.
 *
 * - A valid key present -> encrypt by default (unless explicitly disabled).
 * - Explicitly disabled (`configured === false`) -> plaintext escape hatch.
 * - Enabled but key missing (`configured === true`) -> always throw.
 * - Production without a key -> throw instead of silently storing plaintext.
 * - Non-production without a key -> plaintext with a warning callback.
 */
export function encodeSecretValue(
  plain: string,
  context: SecretEncodingContext
): string | EncryptedStringValueV1 {
  const { configured, key, isProduction, onPlaintextFallback } = context;

  if (key) {
    if (configured === false) {
      return plain;
    }
    return encryptStringValueV1(plain, key);
  }

  if (configured === true) {
    throw new SystemSettingsEncryptionRequiredError(
      "Secret encryption is enabled but SYSTEM_SETTINGS_ENCRYPTION_KEY is not configured"
    );
  }

  if (isProduction) {
    throw new SystemSettingsEncryptionRequiredError(
      "SYSTEM_SETTINGS_ENCRYPTION_KEY is required to store secrets in production"
    );
  }

  onPlaintextFallback?.();
  return plain;
}
