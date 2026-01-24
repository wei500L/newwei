import { describe, expect, it } from "vitest";

import { safeHttpUrl } from "../lib/url";

describe("safeHttpUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(safeHttpUrl("http://localhost:4010")).toBe("http://localhost:4010/");
    expect(safeHttpUrl(" https://example.com/api ")).toBe("https://example.com/api");
  });

  it("rejects URLs without protocol", () => {
    expect(safeHttpUrl("localhost:4010")).toBeNull();
  });

  it("rejects non-http protocols", () => {
    expect(safeHttpUrl("ftp://example.com")).toBeNull();
  });
});

