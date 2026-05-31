import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const webRoot = path.resolve(__dirname, "..");

const read = (relativePath: string) =>
  fs.readFileSync(path.resolve(webRoot, relativePath), "utf8");

const readLocale = (name: "en" | "zh") =>
  JSON.parse(
    fs.readFileSync(path.resolve(webRoot, `lib/locales/${name}.json`), "utf8"),
  ) as {
    auth?: {
      login?: {
        error?: Record<string, string>;
      };
    };
  };

describe("MFA rate limit handling", () => {
  it("surfaces locked MFA challenges distinctly on the login page", () => {
    const source = read("app/(auth)/login/page.tsx");

    expect(source).toContain("classifyRequestError(error).kind === \"rateLimit\"");
    expect(source).toContain("setMfaLocked(true)");
    expect(source).toContain("setEnrollmentLocked(true)");
    expect(source).toContain("auth.login.error.tooManyMfaAttempts");
    expect(source).toContain("disabled={mfaLocked}");
    expect(source).toContain("disabled={enrollmentLocked}");
  });

  it("surfaces locked MFA challenges distinctly on the SSO callback page", () => {
    const source = read("app/(auth)/auth/sso/callback/page.tsx");

    expect(source).toContain("classifyRequestError(error).kind === \"rateLimit\"");
    expect(source).toContain("setMfaLocked(true)");
    expect(source).toContain("setEnrollmentLocked(true)");
    expect(source).toContain("Too many MFA verification attempts. Please sign in again.");
  });

  it("defines localized MFA attempt lockout copy", () => {
    expect(readLocale("en").auth?.login?.error?.tooManyMfaAttempts).toBe(
      "Too many MFA verification attempts. Please sign in again.",
    );
    expect(readLocale("zh").auth?.login?.error?.tooManyMfaAttempts).toBe(
      "MFA 验证尝试次数过多，请重新登录。",
    );
  });
});
