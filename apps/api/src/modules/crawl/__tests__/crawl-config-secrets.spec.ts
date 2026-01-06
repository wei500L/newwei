import { randomBytes } from "crypto";

import {
  CrawlTaskConfigEncryptionRequiredError,
  collectCrawlTaskConfigSensitiveFields,
  CRAWL_TASK_CONFIG_REDACTED_VALUE,
  decodeCrawlTaskConfigKey,
  isEncryptedJsonValueV1,
  protectCrawlTaskConfigForStorage,
  redactCrawlTaskConfigForView,
  revealCrawlTaskConfigForExecution
} from "../crawl-config-secrets";

describe("crawl-config-secrets", () => {
  const key = randomBytes(32);

  it("requires an encryption key when browserCookies is set", () => {
    expect(() =>
      protectCrawlTaskConfigForStorage({ browserCookies: [{ name: "a", value: "b", domain: "x" }] }, undefined)
    ).toThrow(CrawlTaskConfigEncryptionRequiredError);
  });

  it("encrypts and decrypts browserCookies", () => {
    const input = {
      browserCookies: [{ name: "session", value: "token", domain: "example.com" }]
    };
    const protectedResult = protectCrawlTaskConfigForStorage(input, key);
    expect(protectedResult.didEncrypt).toBe(true);
    expect(isEncryptedJsonValueV1((protectedResult.config as any)?.browserCookies)).toBe(true);

    const revealed = revealCrawlTaskConfigForExecution(protectedResult.config ?? null, key);
    expect(revealed).toEqual(input);
  });

  it("encrypts and decrypts proxyConfig.password", () => {
    const input = {
      proxyConfig: { server: "http://proxy.local:8080", username: "u", password: "p" }
    };
    const protectedResult = protectCrawlTaskConfigForStorage(input, key);
    expect(protectedResult.didEncrypt).toBe(true);
    expect(isEncryptedJsonValueV1(((protectedResult.config as any)?.proxyConfig as any)?.password)).toBe(true);

    const revealed = revealCrawlTaskConfigForExecution(protectedResult.config ?? null, key);
    expect(revealed).toEqual(input);
  });

  it("encrypts and decrypts proxyUrl when it embeds credentials", () => {
    const input = {
      proxyUrl: "http://user:pass@proxy.local:8080"
    };
    const protectedResult = protectCrawlTaskConfigForStorage(input, key);
    expect(protectedResult.didEncrypt).toBe(true);
    expect(isEncryptedJsonValueV1((protectedResult.config as any)?.proxyUrl)).toBe(true);

    const revealed = revealCrawlTaskConfigForExecution(protectedResult.config ?? null, key);
    expect(revealed).toEqual(input);
  });

  it("redacts secrets for views", () => {
    const input = {
      browserCookies: [{ name: "session", value: "token", domain: "example.com" }],
      proxyUrl: "http://user:pass@proxy.local:8080",
      proxyConfig: { server: "http://proxy.local:8080", username: "u", password: "p" },
      storageState: "{\"cookies\":[]}",
      browserHeaders: [
        { name: "Authorization", value: "Bearer abc" },
        { name: "X-Trace-Id", value: "trace-1" }
      ]
    };
    const redacted = redactCrawlTaskConfigForView(input);
    expect(redacted).toEqual({
      browserCookies: CRAWL_TASK_CONFIG_REDACTED_VALUE,
      proxyUrl: "http://user:***@proxy.local:8080",
      proxyConfig: { server: "http://proxy.local:8080", username: "u", password: CRAWL_TASK_CONFIG_REDACTED_VALUE },
      storageState: CRAWL_TASK_CONFIG_REDACTED_VALUE,
      browserHeaders: [
        { name: "Authorization", value: CRAWL_TASK_CONFIG_REDACTED_VALUE },
        { name: "X-Trace-Id", value: "trace-1" }
      ]
    });
  });

  it("collects sensitive fields for audit", () => {
    const input = {
      browserCookies: [{ name: "session", value: "token", domain: "example.com" }],
      proxyUrl: "http://user:pass@proxy.local:8080",
      proxyConfig: { server: "http://proxy.local:8080", username: "u", password: "p" },
      storageState: "{\"cookies\":[]}",
      browserHeaders: [
        { name: "Authorization", value: "Bearer abc" },
        { name: "X-Trace-Id", value: "trace-1" }
      ]
    };
    const fields = collectCrawlTaskConfigSensitiveFields(input);
    expect(fields).toEqual(
      expect.arrayContaining([
        "browserCookies",
        "proxyUrl",
        "proxyConfig.password",
        "storageState",
        "browserHeaders"
      ])
    );
  });

  it("decodes base64 and hex encryption keys", () => {
    const raw = Buffer.alloc(32, 7);
    expect(decodeCrawlTaskConfigKey(raw.toString("base64"))).toEqual(raw);
    expect(decodeCrawlTaskConfigKey(raw.toString("hex"))).toEqual(raw);
  });
});
