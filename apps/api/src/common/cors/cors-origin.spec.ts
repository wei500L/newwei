import {
  isOriginAllowed,
  parseCorsOriginAllowlist,
  resolveCorsOriginOption,
} from "./cors-origin";

describe("parseCorsOriginAllowlist", () => {
  it("returns an empty list when unset", () => {
    expect(parseCorsOriginAllowlist(undefined)).toEqual([]);
    expect(parseCorsOriginAllowlist("")).toEqual([]);
  });

  it("splits, trims, and drops empty entries", () => {
    expect(
      parseCorsOriginAllowlist(" https://a.example.com , ,https://b.example.com,"),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("normalizes entries to their origin, dropping paths", () => {
    expect(
      parseCorsOriginAllowlist("https://console.example.com/api,http://localhost:3000"),
    ).toEqual(["https://console.example.com", "http://localhost:3000"]);
  });

  it("keeps unparseable entries verbatim (e.g. wildcard)", () => {
    expect(parseCorsOriginAllowlist("*")).toEqual(["*"]);
  });
});

describe("isOriginAllowed", () => {
  it("allows connections without an Origin header", () => {
    expect(isOriginAllowed(undefined, [])).toBe(true);
    expect(isOriginAllowed(null, ["https://a.example.com"])).toBe(true);
  });

  it("denies any Origin when the allowlist is empty", () => {
    expect(isOriginAllowed("https://evil.example.com", [])).toBe(false);
    expect(isOriginAllowed("https://console.example.com", [])).toBe(false);
  });

  it("allows origins present in the allowlist", () => {
    const allowlist = ["https://console.example.com", "http://localhost:3000"];
    expect(isOriginAllowed("https://console.example.com", allowlist)).toBe(
      true,
    );
    expect(isOriginAllowed("http://localhost:3000", allowlist)).toBe(true);
  });

  it("denies origins absent from the allowlist", () => {
    const allowlist = ["https://console.example.com"];
    expect(isOriginAllowed("https://evil.example.com", allowlist)).toBe(false);
    expect(
      isOriginAllowed("https://console.example.com.evil.com", allowlist),
    ).toBe(false);
  });
});

describe("resolveCorsOriginOption", () => {
  it("returns the parsed allowlist when configured", () => {
    expect(
      resolveCorsOriginOption("https://a.example.com, https://b.example.com"),
    ).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  it("disables CORS (same-origin only) when unset instead of reflecting", () => {
    expect(resolveCorsOriginOption(undefined)).toBe(false);
    expect(resolveCorsOriginOption("")).toBe(false);
  });
});
