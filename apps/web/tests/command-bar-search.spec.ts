import { describe, expect, it } from "vitest";

import {
  buildCommandBarSearchHref,
  normalizeCommandBarQuery,
} from "@/app/(app)/components/command-bar-search";

describe("command bar search query helpers", () => {
  it("normalizes leading and trailing whitespace", () => {
    expect(normalizeCommandBarQuery("   market pulse  ")).toBe("market pulse");
  });

  it("builds a search href with encoded query", () => {
    expect(buildCommandBarSearchHref("Fed & CPI")).toBe("/search?q=Fed%20%26%20CPI");
  });

  it("returns null for blank query", () => {
    expect(buildCommandBarSearchHref("   ")).toBeNull();
  });
});
