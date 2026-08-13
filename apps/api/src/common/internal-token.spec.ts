import { extractBearerToken, tokensEqual } from "./internal-token";

describe("extractBearerToken", () => {
  it("returns null for missing or empty header", () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken("")).toBeNull();
    expect(extractBearerToken("   ")).toBeNull();
  });

  it("returns null for non-bearer header", () => {
    expect(extractBearerToken("Basic abc")).toBeNull();
    expect(extractBearerToken("beareronly")).toBeNull();
  });

  it("extracts a bearer token case-insensitively", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("  Bearer   abc  ")).toBe("abc");
  });
});

describe("tokensEqual", () => {
  it("returns true for equal tokens", () => {
    expect(tokensEqual("secret", "secret")).toBe(true);
  });

  it("returns false for different tokens of equal length", () => {
    expect(tokensEqual("aaaaaa", "bbbbbb")).toBe(false);
  });

  it("returns false for different length tokens", () => {
    expect(tokensEqual("short", "longer-token")).toBe(false);
  });

  it("returns false for empty vs non-empty", () => {
    expect(tokensEqual("", "x")).toBe(false);
  });
});
