import { describe, expect, it } from "vitest";

import {
  DEFAULT_POST_LOGIN_REDIRECT,
  resolveSafeRedirect,
} from "@/lib/safe-redirect";

describe("resolveSafeRedirect", () => {
  it("allows same-origin relative paths", () => {
    expect(resolveSafeRedirect("/dashboard")).toBe("/dashboard");
    expect(resolveSafeRedirect("/items/123?tab=meta#top")).toBe(
      "/items/123?tab=meta#top",
    );
  });

  it("rejects protocol-relative URLs", () => {
    expect(resolveSafeRedirect("//evil.com")).toBe(DEFAULT_POST_LOGIN_REDIRECT);
  });

  it("rejects absolute URLs", () => {
    expect(resolveSafeRedirect("https://evil.com")).toBe(
      DEFAULT_POST_LOGIN_REDIRECT,
    );
  });

  it("rejects scheme / javascript URLs", () => {
    expect(resolveSafeRedirect("javascript:alert(1)")).toBe(
      DEFAULT_POST_LOGIN_REDIRECT,
    );
  });

  it("rejects backslash-normalized cross-origin escapes", () => {
    expect(resolveSafeRedirect("/\\evil.com")).toBe(
      DEFAULT_POST_LOGIN_REDIRECT,
    );
  });

  it("falls back for empty / missing input", () => {
    expect(resolveSafeRedirect(null)).toBe(DEFAULT_POST_LOGIN_REDIRECT);
    expect(resolveSafeRedirect(undefined)).toBe(DEFAULT_POST_LOGIN_REDIRECT);
    expect(resolveSafeRedirect("")).toBe(DEFAULT_POST_LOGIN_REDIRECT);
  });
});
