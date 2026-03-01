import { describe, expect, it } from "vitest";

import {
  getSearchRemainingChars,
  resolveSearchFeedbackState,
} from "@/lib/search-feedback-state";

describe("search feedback state", () => {
  it("returns idle when query is empty", () => {
    expect(
      resolveSearchFeedbackState({
        query: "   ",
        debouncedQuery: "",
        loading: false,
        hasResults: false,
        hasError: false,
      })
    ).toBe("idle");
  });

  it("returns minChars when query is shorter than threshold", () => {
    expect(
      resolveSearchFeedbackState({
        query: "a",
        debouncedQuery: "a",
        loading: false,
        hasResults: false,
        hasError: false,
        minChars: 2,
      })
    ).toBe("minChars");
  });

  it("returns error before loading/debouncing when query length is valid", () => {
    expect(
      resolveSearchFeedbackState({
        query: "apple",
        debouncedQuery: "app",
        loading: true,
        hasResults: false,
        hasError: true,
      })
    ).toBe("error");
  });

  it("returns loading when request is in flight", () => {
    expect(
      resolveSearchFeedbackState({
        query: "apple",
        debouncedQuery: "apple",
        loading: true,
        hasResults: false,
        hasError: false,
      })
    ).toBe("loading");
  });

  it("returns debouncing when input is ahead of debounced query", () => {
    expect(
      resolveSearchFeedbackState({
        query: "apple",
        debouncedQuery: "app",
        loading: false,
        hasResults: false,
        hasError: false,
      })
    ).toBe("debouncing");
  });

  it("returns ready when search has results", () => {
    expect(
      resolveSearchFeedbackState({
        query: "apple",
        debouncedQuery: "apple",
        loading: false,
        hasResults: true,
        hasError: false,
      })
    ).toBe("ready");
  });

  it("returns empty when search settles without results", () => {
    expect(
      resolveSearchFeedbackState({
        query: "apple",
        debouncedQuery: "apple",
        loading: false,
        hasResults: false,
        hasError: false,
      })
    ).toBe("empty");
  });
});

describe("search feedback remaining chars", () => {
  it("returns remaining characters needed to search", () => {
    expect(getSearchRemainingChars("a", 3)).toBe(2);
    expect(getSearchRemainingChars("abc", 3)).toBe(0);
  });
});
