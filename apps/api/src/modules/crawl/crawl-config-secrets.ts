import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export const CRAWL_TASK_CONFIG_ENCRYPTION_ENV = 'CRAWL_TASK_CONFIG_ENCRYPTION_KEY';
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;

export interface EncryptedJsonValueV1 {
  __enc: 'crawl-task-config:v1';
  alg: typeof ENCRYPTION_ALGORITHM;
  iv: string;
  tag: string;
  data: string;
}

export class CrawlTaskConfigEncryptionRequiredError extends Error {
  override name = 'CrawlTaskConfigEncryptionRequiredError';
}

export class CrawlTaskConfigDecryptionError extends Error {
  override name = 'CrawlTaskConfigDecryptionError';
}

export type CrawlTaskConfigRecord = Record<string, unknown>;

export function decodeCrawlTaskConfigKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error(`${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} is empty`);
  }

  const hexCandidate = trimmed.replace(/^0x/i, '');
  if (/^[0-9a-fA-F]+$/.test(hexCandidate) && hexCandidate.length === KEY_BYTES * 2) {
    return Buffer.from(hexCandidate, 'hex');
  }

  const base64 = Buffer.from(trimmed, 'base64');
  if (base64.length === KEY_BYTES) {
    return base64;
  }

  throw new Error(
    `${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} must be 32 bytes (base64) or 64 hex chars`,
  );
}

export function isEncryptedJsonValueV1(value: unknown): value is EncryptedJsonValueV1 {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.__enc === 'crawl-task-config:v1' &&
    record.alg === ENCRYPTION_ALGORITHM &&
    typeof record.iv === 'string' &&
    typeof record.tag === 'string' &&
    typeof record.data === 'string'
  );
}

export function encryptJsonValueV1(plain: unknown, key: Buffer): EncryptedJsonValueV1 {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Invalid ${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} length`);
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv(ENCRYPTION_ALGORITHM, key, iv);
  const encoded = Buffer.from(JSON.stringify(plain), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(encoded), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    __enc: 'crawl-task-config:v1',
    alg: ENCRYPTION_ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: ciphertext.toString('base64'),
  };
}

export function decryptJsonValueV1(payload: EncryptedJsonValueV1, key: Buffer): unknown {
  if (key.length !== KEY_BYTES) {
    throw new Error(`Invalid ${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} length`);
  }
  try {
    const iv = Buffer.from(payload.iv, 'base64');
    const tag = Buffer.from(payload.tag, 'base64');
    const data = Buffer.from(payload.data, 'base64');
    const decipher = createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return JSON.parse(plaintext) as unknown;
  } catch (error) {
    throw new CrawlTaskConfigDecryptionError('Failed to decrypt crawl task config secret', {
      cause: error,
    });
  }
}

function hasProxyUrlCredentials(proxyUrl: string): boolean {
  return /:\/\/[^/]*:[^/]*@/.test(proxyUrl);
}

export function protectCrawlTaskConfigForStorage(
  config: CrawlTaskConfigRecord | null | undefined,
  key: Buffer | undefined,
): { config: CrawlTaskConfigRecord | null; didEncrypt: boolean } {
  if (!config) {
    return { config: null, didEncrypt: false };
  }

  let didEncrypt = false;
  const next: CrawlTaskConfigRecord = { ...config };

  if ('browserCookies' in next && next.browserCookies != null) {
    if (!isEncryptedJsonValueV1(next.browserCookies)) {
      if (!key) {
        throw new CrawlTaskConfigEncryptionRequiredError(
          `${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} is required when browserCookies is set`,
        );
      }
      next.browserCookies = encryptJsonValueV1(next.browserCookies, key);
      didEncrypt = true;
    }
  }

  if ('proxyUrl' in next && typeof next.proxyUrl === 'string' && hasProxyUrlCredentials(next.proxyUrl)) {
    if (!isEncryptedJsonValueV1(next.proxyUrl)) {
      if (!key) {
        throw new CrawlTaskConfigEncryptionRequiredError(
          `${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} is required when proxyUrl embeds credentials`,
        );
      }
      next.proxyUrl = encryptJsonValueV1(next.proxyUrl, key);
      didEncrypt = true;
    }
  }

  if ('proxyConfig' in next && next.proxyConfig && typeof next.proxyConfig === 'object') {
    const proxyConfig = next.proxyConfig as Record<string, unknown>;
    if ('password' in proxyConfig && typeof proxyConfig.password === 'string' && proxyConfig.password.trim()) {
      if (!isEncryptedJsonValueV1(proxyConfig.password)) {
        if (!key) {
          throw new CrawlTaskConfigEncryptionRequiredError(
            `${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} is required when proxyConfig.password is set`,
          );
        }
        next.proxyConfig = {
          ...proxyConfig,
          password: encryptJsonValueV1(proxyConfig.password, key),
        };
        didEncrypt = true;
      }
    }
  }

  return { config: next, didEncrypt };
}

export function revealCrawlTaskConfigForExecution(
  config: CrawlTaskConfigRecord | null | undefined,
  key: Buffer | undefined,
): CrawlTaskConfigRecord | null {
  if (!config) {
    return null;
  }

  const next: CrawlTaskConfigRecord = { ...config };

  if (isEncryptedJsonValueV1(next.browserCookies)) {
    if (!key) {
      throw new CrawlTaskConfigEncryptionRequiredError(
        `${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} is required to decrypt browserCookies`,
      );
    }
    next.browserCookies = decryptJsonValueV1(next.browserCookies, key);
  }

  if (isEncryptedJsonValueV1(next.proxyUrl)) {
    if (!key) {
      throw new CrawlTaskConfigEncryptionRequiredError(
        `${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} is required to decrypt proxyUrl`,
      );
    }
    next.proxyUrl = decryptJsonValueV1(next.proxyUrl, key);
  }

  if ('proxyConfig' in next && next.proxyConfig && typeof next.proxyConfig === 'object') {
    const proxyConfig = next.proxyConfig as Record<string, unknown>;
    if (isEncryptedJsonValueV1(proxyConfig.password)) {
      if (!key) {
        throw new CrawlTaskConfigEncryptionRequiredError(
          `${CRAWL_TASK_CONFIG_ENCRYPTION_ENV} is required to decrypt proxyConfig.password`,
        );
      }
      next.proxyConfig = {
        ...proxyConfig,
        password: decryptJsonValueV1(proxyConfig.password, key),
      };
    }
  }

  return next;
}

function redactProxyUrl(proxyUrl: string): string {
  return proxyUrl.replace(/:\/\/([^/]*?):([^/]*?)@/, '://$1:***@');
}

export function redactCrawlTaskConfigForView(
  config: CrawlTaskConfigRecord | null | undefined,
): CrawlTaskConfigRecord | null {
  if (!config) {
    return null;
  }

  const next: CrawlTaskConfigRecord = { ...config };

  if ('browserCookies' in next) {
    delete next.browserCookies;
  }

  if (typeof next.proxyUrl === 'string' && hasProxyUrlCredentials(next.proxyUrl)) {
    next.proxyUrl = redactProxyUrl(next.proxyUrl);
  } else if (isEncryptedJsonValueV1(next.proxyUrl)) {
    next.proxyUrl = '[REDACTED]';
  }

  if (next.proxyConfig && typeof next.proxyConfig === 'object') {
    const proxyConfig = next.proxyConfig as Record<string, unknown>;
    if ('password' in proxyConfig) {
      next.proxyConfig = { ...proxyConfig, password: '[REDACTED]' };
    }
  }

  return next;
}

